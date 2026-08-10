//! Reaching a machine that cannot be dialled.
//!
//! A server behind a home router has no address the relay can connect to. So it
//! connects to us instead: a small daemon on that machine holds one outbound
//! WebSocket — the *control* connection — and waits. When a browser asks for
//! that host, the relay sends an open request down the control connection, the
//! daemon dials back with a second WebSocket carrying a one-time ticket, and the
//! relay splices the two sockets together.
//!
//! ## One socket per session, not a multiplexer
//!
//! The obvious design is to carry every session over the single control
//! connection with a stream id on each frame. It is also the wrong one. A
//! multiplexer over one WebSocket has a single send queue, so an SFTP transfer
//! saturating its half stalls the interactive terminal beside it — the fix for
//! which is a per-stream credit window, which is to say reimplementing the
//! flow control SSH already has, one layer down, in the component least able to
//! be debugged from a user's living room. Separate sockets get backpressure from
//! TCP for free and cost one extra handshake per session, which is invisible
//! next to the SSH handshake that follows it.
//!
//! ## What this does to the relay's statelessness
//!
//! It ends it, for agents specifically. The registry below is in-memory, so an
//! agent is reachable only through the instance it happens to be connected to.
//! A single relay is unaffected; a fleet behind a load balancer needs the
//! browser's /ws and the agent's control connection to land on the same
//! instance, or agents will appear offline at random. Nothing here pretends
//! otherwise, and the token path is deliberately untouched: /ws still authorises
//! from a signed token alone and still reads no database.
//!
//! ## What the relay does and does not decide
//!
//! It does not decide who owns an agent. The token minted by the control plane
//! names `agent:<id>` the same way it otherwise names `host:port`, and the
//! control plane has already checked ownership before signing it. The relay
//! verifies the signature and forwards bytes, exactly as it does for a direct
//! connection. What it *does* decide is that a daemon claiming to be an agent
//! really holds that agent's key, which is the `verify` round trip below.

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::extract::ws::{Message, WebSocket};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use dashmap::DashMap;
use futures_util::{
    stream::{SplitStream, StreamExt},
    SinkExt,
};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info, warn};

use crate::http::{check_secret, post_json, ConfigError, Endpoint};

const URL_VAR: &str = "RELAY_AGENT_VERIFY_URL";
const SECRET_VAR: &str = "RELAY_AGENT_SECRET";

/// Random bytes in a challenge and in a rendezvous ticket. 32 bytes of CSPRNG
/// output is far past any birthday concern for values that live ten seconds.
const NONCE_BYTES: usize = 32;
const TICKET_BYTES: usize = 32;

/// How long an agent has to complete hello → challenge → proof. Generous for a
/// daemon on a home connection, short enough that a socket which opened and
/// then went quiet does not sit in the accept path.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the browser side waits for the agent to dial back with its ticket.
/// This covers one round trip to the agent plus one TLS+WebSocket handshake
/// from a residential connection.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// Keepalive on the control connection. Home routers drop idle NAT mappings,
/// commonly at 5 minutes and sometimes far sooner, and an agent that discovers
/// this only when a user tries to connect is an agent that is offline exactly
/// when it is wanted.
const PING_INTERVAL: Duration = Duration::from_secs(30);

/// How long to wait for an agent to answer a command.
///
/// Generous: the agent may be checking for an update before it replies, and the
/// caller is a person who pressed a button and is watching. Shorter than any
/// sensible HTTP timeout in front of it, so the answer is this one rather than a
/// proxy's.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// Queue depth for control messages to one agent. These are tiny JSON objects
/// sent at human speed; a backlog means the agent's socket has stopped draining,
/// and failing the open is better than growing a queue nobody will read.
const CONTROL_DEPTH: usize = 8;

/// One connected agent.
struct Registration {
    /// Which control connection this is.
    ///
    /// An agent that reconnects before the relay has noticed the old socket die
    /// briefly has two registrations, and the old one's cleanup would otherwise
    /// evict the new one — leaving an agent that is connected and unreachable
    /// until it next reconnects. Cleanup removes the entry only if this matches.
    conn: u64,
    /// The owning account, for logs. Authorisation comes from the token.
    account: String,
    tx: mpsc::Sender<String>,
}

pub struct Agents {
    control: DashMap<String, Registration>,
    /// Tickets waiting to be claimed by an agent dialling back.
    pending: DashMap<String, oneshot::Sender<WebSocket>>,
    /// Commands sent to an agent and not yet answered, by command id.
    ///
    /// The relay carries the answer and does not read it: what it forwards is an
    /// envelope the control plane signed and the agent verified, and the reply
    /// is the agent's own words about what it did. Holding the caller open until
    /// the agent speaks is what lets the dashboard say "three sessions are open"
    /// instead of "sent".
    awaiting: DashMap<String, oneshot::Sender<String>>,
    next_conn: AtomicU64,
    verifier: Option<Verifier>,
    /// Why agents are off, when they are. Named at startup so a half-configured
    /// deployment says which half rather than looking deliberately disabled.
    disabled: Option<&'static str>,
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("that machine's agent is not connected")]
    Offline,
    #[error("the agent did not answer in time")]
    Timeout,
}

#[derive(Debug, Deserialize)]
struct Hello {
    #[serde(rename = "agentId")]
    agent_id: String,
    /// What build the agent says it is running, forwarded to the control plane
    /// so the dashboard can stop showing the version a machine was installed
    /// with months after it replaced itself.
    ///
    /// Optional because an agent older than this relay does not send it, and a
    /// fleet must not need upgrading in lockstep with the thing it connects to.
    /// Absent means "said nothing", which the control plane treats as leaving
    /// the stored value alone rather than as an erasure.
    #[serde(default)]
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Proof {
    signature: String,
}

/// What an agent says after carrying out — or refusing — a command.
///
/// The relay reads only enough of this to route it: which command it answers,
/// and that it is an answer at all. What it says happened is the agent's word
/// to the control plane, passed through unread.
#[derive(Debug, Deserialize)]
struct CommandResult {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: String,
}

#[derive(Debug, Deserialize)]
struct VerifyResponse {
    ok: bool,
    #[serde(rename = "userId")]
    user_id: Option<String>,
    error: Option<String>,
}

/// Why an agent was turned away, and — more usefully — whether trying again
/// could ever work.
///
/// The distinction is the whole reason this type exists. A revoked agent that
/// reconnects every few seconds forever is a machine burning battery to be told
/// "no" until someone notices, and it looks identical in a log to a control
/// plane that is briefly down. The agent needs to stop in the first case and
/// keep trying in the second, and only this side knows which is which.
enum Refusal {
    /// Settled. Re-enrolment is the only way back, so the agent should stop.
    Final(String),
    /// Might work later — the control plane was unreachable, or answered in a
    /// way we could not read. Keep retrying.
    Transient(String),
}

impl Refusal {
    fn message(&self) -> &str {
        match self {
            Refusal::Final(m) | Refusal::Transient(m) => m,
        }
    }

    /// The close code the agent reads to decide whether to give up.
    ///
    /// 4001 is in the 4000-4999 range RFC 6455 reserves for applications, so it
    /// cannot collide with a protocol code the library might send on its own.
    fn close_code(&self) -> u16 {
        match self {
            Refusal::Final(_) => AGENT_REJECTED,
            Refusal::Transient(_) => 1011,
        }
    }
}

/// "You are not an agent this deployment will accept. Stop asking."
///
/// Must match statusAgentRejected in apps/agent/run.go.
pub const AGENT_REJECTED: u16 = 4001;

impl Agents {
    /// Reads the environment. Agent support is off unless both variables are
    /// set, and off means /agent answers 503 rather than accepting sockets it
    /// can never authenticate.
    pub fn from_env() -> Result<Arc<Self>, ConfigError> {
        let url = std::env::var(URL_VAR).ok().filter(|s| !s.is_empty());
        let secret = std::env::var(SECRET_VAR).ok().filter(|s| !s.is_empty());

        let (verifier, disabled) = match (url, secret) {
            (Some(url), Some(secret)) => {
                check_secret(SECRET_VAR, &secret)?;
                (
                    Some(Verifier {
                        endpoint: Endpoint::parse(URL_VAR, &url)?,
                        secret,
                    }),
                    None,
                )
            }
            // Distinguished rather than collapsed into "not configured". An
            // operator who set one and forgot the other has a typo, not a
            // decision, and the log line is the only place anyone will find out.
            (None, Some(_)) => (None, Some("RELAY_AGENT_VERIFY_URL is not set")),
            (Some(_), None) => (None, Some("RELAY_AGENT_SECRET is not set")),
            (None, None) => (None, None),
        };

        Ok(Arc::new(Self {
            control: DashMap::new(),
            pending: DashMap::new(),
            awaiting: DashMap::new(),
            next_conn: AtomicU64::new(0),
            verifier,
            disabled,
        }))
    }

    pub fn enabled(&self) -> bool {
        self.verifier.is_some()
    }

    pub fn connected(&self) -> usize {
        self.control.len()
    }

    /// Sends a signed command to an agent and waits for its answer.
    ///
    /// The envelope is opaque here: the control plane signed it, the agent
    /// verifies it, and this process is a courier that cannot forge one. What
    /// it *can* do is fail to deliver, which is why every failure below is
    /// reported rather than swallowed — a command that silently went nowhere
    /// looks exactly like a machine that ignored it.
    ///
    /// The account is checked as well as the id, for the same reason the
    /// presence query is scoped: an agent somebody else owns must be
    /// indistinguishable from one that is offline.
    pub async fn command(
        &self,
        account: &str,
        agent_id: &str,
        id: &str,
        envelope: String,
    ) -> Result<String, OpenError> {
        let Some(reg) = self.control.get(agent_id) else {
            return Err(OpenError::Offline);
        };
        if reg.account != account {
            // Deliberately the same answer as "not connected".
            return Err(OpenError::Offline);
        }
        let tx = reg.tx.clone();
        drop(reg); // the map guard must not be held across an await

        let (result_tx, result_rx) = oneshot::channel();
        self.awaiting.insert(id.to_string(), result_tx);

        if tx.send(envelope).await.is_err() {
            self.awaiting.remove(id);
            return Err(OpenError::Offline);
        }

        match tokio::time::timeout(COMMAND_TIMEOUT, result_rx).await {
            Ok(Ok(reply)) => Ok(reply),
            // The agent went away between the send and the answer, or never
            // answered. Both are "we do not know what happened", which is worth
            // saying plainly: a command may well have been carried out.
            _ => {
                self.awaiting.remove(id);
                Err(OpenError::Timeout)
            }
        }
    }

    /// Which of these agent ids are connected and belong to this account.
    ///
    /// Answers only about ids the caller already named, and only about the
    /// account the token authorised, so it enumerates nothing: an id belonging
    /// to somebody else is indistinguishable from one that is offline. That is
    /// deliberate — the dashboard already knows which machines are its own, and
    /// anything more here would be an oracle for guessed ids.
    ///
    /// A hint with a lifetime measured in seconds, like `account_for`: an agent
    /// can drop immediately after this returns. The honest answer to "can I
    /// reach it right now" is still to try.
    pub fn online_for(&self, account: &str, ids: &[String]) -> Vec<String> {
        ids.iter()
            .filter(|id| {
                self.control
                    .get(id.as_str())
                    .is_some_and(|reg| reg.account == account)
            })
            .cloned()
            .collect()
    }

    /// Which account enrolled the connected agent, or None when it is offline.
    ///
    /// Doubles as the online check, which is why it is the one the browser path
    /// calls before upgrading: an offline machine becomes an HTTP status the
    /// client can read rather than a socket that opens and closes for reasons
    /// the browser is not allowed to see. It is a hint, not a guarantee — the
    /// agent can drop between this and `open`, which is why that path reports
    /// its own failure too.
    ///
    /// The account itself is what the control plane told us when it verified
    /// the agent's signature.
    ///
    /// The caller compares this with the account named in the relay token. That
    /// is a second opinion rather than the authorisation — ownership is checked
    /// on the control plane before a token is signed — but the two facts reach
    /// this process by completely different routes, one down the agent's
    /// authenticated control connection and one inside a token from the
    /// browser. Requiring them to agree means a bug that mints a token for
    /// somebody else's agent is refused here instead of connecting.
    ///
    /// It also means agent sharing, if it is ever built, fails loudly at this
    /// line rather than silently working and quietly bypassing this check.
    pub fn owner(&self, agent_id: &str) -> Option<String> {
        self.control.get(agent_id).map(|r| r.account.clone())
    }

    /// Asks an agent to dial back, and waits for the socket it dials with.
    pub async fn open(&self, agent_id: &str, port: u16) -> Result<WebSocket, OpenError> {
        let tx = {
            let reg = self.control.get(agent_id).ok_or(OpenError::Offline)?;
            reg.tx.clone()
        };

        let ticket = random_b64(TICKET_BYTES);
        let (sock_tx, sock_rx) = oneshot::channel();
        self.pending.insert(ticket.clone(), sock_tx);

        let request = serde_json::json!({
            "type": "open",
            "ticket": ticket,
            "port": port,
        })
        .to_string();

        // `try_send`, not `send`: a full queue means the agent's socket has
        // stopped draining, and blocking here would hold the browser's request
        // open behind a connection that is already gone.
        if tx.try_send(request).is_err() {
            self.pending.remove(&ticket);
            return Err(OpenError::Offline);
        }

        match tokio::time::timeout(OPEN_TIMEOUT, sock_rx).await {
            Ok(Ok(socket)) => Ok(socket),
            // Sender dropped: the pending entry was claimed and then the stream
            // handler failed, or the entry was swept. Either way, no socket.
            Ok(Err(_)) => Err(OpenError::Timeout),
            Err(_) => {
                // Remove it so an agent dialling back late is refused rather
                // than handing a socket to a receiver nobody is holding.
                self.pending.remove(&ticket);
                Err(OpenError::Timeout)
            }
        }
    }

    /// Hands a dialled-back socket to whoever is waiting on its ticket.
    ///
    /// Returns false when the ticket is unknown — spent, expired, or invented —
    /// and the caller closes the socket. Single use is enforced by the removal
    /// itself: two agents presenting the same ticket race, and exactly one wins.
    pub fn accept_stream(&self, ticket: &str, socket: WebSocket) -> bool {
        match self.pending.remove(ticket) {
            Some((_, tx)) => tx.send(socket).is_ok(),
            None => false,
        }
    }

    /// Runs one control connection for its whole life: authenticate, register,
    /// pump, deregister.
    pub async fn serve_control(self: Arc<Self>, socket: WebSocket) {
        let Some(verifier) = &self.verifier else {
            return;
        };

        let (mut ws_tx, mut ws_rx) = socket.split();

        let handshake = async {
            // A malformed hello or proof is a protocol mismatch, not a verdict
            // on this agent: a build too old or too new for this relay. Retrying
            // will not fix it either, but calling it Final would tell a user
            // their machine was revoked when it was not.
            let hello: Hello = recv_json(&mut ws_rx).await.map_err(Refusal::Transient)?;
            let nonce = random_b64(NONCE_BYTES);

            let challenge = serde_json::json!({ "type": "challenge", "nonce": nonce }).to_string();
            ws_tx
                .send(Message::Text(challenge.into()))
                .await
                .map_err(|e| Refusal::Transient(e.to_string()))?;

            let proof: Proof = recv_json(&mut ws_rx).await.map_err(Refusal::Transient)?;
            let account = verifier
                .verify(
                    &hello.agent_id,
                    &nonce,
                    &proof.signature,
                    hello.version.as_deref(),
                )
                .await?;
            Ok::<_, Refusal>((hello.agent_id, account))
        };

        let (agent_id, account) = match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(refusal)) => {
                warn!(reason = %refusal.message(), "agent control handshake refused");
                let _ = ws_tx
                    .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: refusal.close_code(),
                        reason: crate::truncate_utf8(refusal.message().to_string(), 123).into(),
                    })))
                    .await;
                return;
            }
            Err(_) => {
                debug!("agent control handshake timed out");
                return;
            }
        };

        if ws_tx
            .send(Message::Text(
                serde_json::json!({ "type": "ready" }).to_string().into(),
            ))
            .await
            .is_err()
        {
            return;
        }

        let conn = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let (msg_tx, mut msg_rx) = mpsc::channel::<String>(CONTROL_DEPTH);
        // Replaces any previous registration for this agent. The old socket's
        // sender is dropped here, which ends its writer loop and closes it —
        // the agent is the authority on which of its own connections is live.
        self.control.insert(
            agent_id.clone(),
            Registration {
                conn,
                account: account.clone(),
                tx: msg_tx,
            },
        );
        info!(agent = %agent_id, account = %account, "agent online");

        let writer = async move {
            let mut ping = tokio::time::interval(PING_INTERVAL);
            ping.tick().await; // the first tick of an interval is immediate
            loop {
                tokio::select! {
                    outgoing = msg_rx.recv() => match outgoing {
                        Some(text) => {
                            if ws_tx.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    },
                    _ = ping.tick() => {
                        if ws_tx.send(Message::Ping(Vec::new().into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        };

        // Two jobs. It notices the socket dying — pongs arrive here and are
        // discarded, and a dead peer surfaces as an end of stream — and it
        // carries command results back to whoever is waiting on one.
        let results = Arc::clone(&self);
        let reader = async move {
            while let Some(Ok(msg)) = ws_rx.next().await {
                match msg {
                    Message::Close(_) => break,
                    Message::Text(text) => {
                        // Anything unparseable is ignored rather than fatal: an
                        // agent newer than this relay may say things it does not
                        // know, and dropping a working connection over an
                        // unexpected frame would be the worse failure.
                        if let Ok(result) = serde_json::from_str::<CommandResult>(text.as_str()) {
                            if result.kind == "result" {
                                if let Some((_, waiting)) = results.awaiting.remove(&result.id) {
                                    let _ = waiting.send(text.to_string());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        };

        tokio::select! {
            _ = writer => {}
            _ = reader => {}
        }

        // Only if it is still ours; see Registration::conn.
        self.control.remove_if(&agent_id, |_, reg| reg.conn == conn);
        info!(agent = %agent_id, account = %account, "agent offline");
    }
}

/// Reads one JSON control message, ignoring the frame types that carry none.
async fn recv_json<T: for<'de> Deserialize<'de>>(
    rx: &mut SplitStream<WebSocket>,
) -> Result<T, String> {
    loop {
        match rx.next().await {
            Some(Ok(Message::Text(text))) => {
                return serde_json::from_str(text.as_str())
                    .map_err(|e| format!("unreadable control message: {e}"));
            }
            // Binary on the control connection is a client that has confused it
            // with a stream connection. Saying so beats a JSON parse error.
            Some(Ok(Message::Binary(_))) => {
                return Err("binary frame on the control connection".into())
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_))) | None => return Err("closed before authenticating".into()),
            Some(Err(e)) => return Err(e.to_string()),
        }
    }
}

fn random_b64(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    OsRng.fill_bytes(&mut bytes);
    B64.encode(bytes)
}

/// Asks the control plane whether a signature really came from this agent.
///
/// The relay holds no public keys and no database, so it cannot check an Ed25519
/// signature itself — and giving it the key material to do so would put an
/// agent-impersonation credential on the internet-facing process for the sake of
/// saving a round trip that happens once per agent per reconnect.
struct Verifier {
    endpoint: Endpoint,
    secret: String,
}

/// The body of a verify call.
///
/// A free function so a test can pin the field names the control plane reads —
/// nothing compiles both ends of this wire, and a rename on either side would
/// otherwise surface as agents that authenticate and a dashboard that quietly
/// never learns what they are running. `apps/web/src/lib/agents/verify.test.ts`
/// feeds this exact shape through the validator that receives it.
///
/// The version is truncated here rather than trusted: it arrives on an
/// unauthenticated hello, and this process is the one on the internet. The
/// control plane clamps it again on its own side, which is the point — neither
/// end relies on the other having done it.
fn verify_request(agent_id: &str, nonce: &str, signature: &str, version: Option<&str>) -> String {
    let mut body = serde_json::json!({
        "agentId": agent_id,
        "nonce": nonce,
        "signature": signature,
    });

    // Omitted when absent, so an older agent that says nothing is distinct from
    // one reporting an empty string — the first leaves the stored value alone.
    if let Some(version) = version.filter(|v| !v.is_empty()) {
        // Cut rather than marked: truncate_utf8 next door appends an ellipsis,
        // which is right for a close reason a human reads and wrong for an
        // identifier a machine compares — "v1.2…" would differ from every
        // published version forever, and the dashboard would show an update
        // that is already installed.
        body["version"] = serde_json::Value::String(version.chars().take(64).collect::<String>());
    }
    body.to_string()
}

impl Verifier {
    /// Returns the owning account id, or a refusal that says whether retrying
    /// could ever help.
    async fn verify(
        &self,
        agent_id: &str,
        nonce: &str,
        signature: &str,
        version: Option<&str>,
    ) -> Result<String, Refusal> {
        let body = verify_request(agent_id, nonce, signature, version);

        // Unreachable is transient by definition: the control plane restarting
        // must not knock every agent in the fleet offline permanently.
        let (status, body) = post_json(&self.endpoint, &self.secret, &body)
            .await
            .map_err(|e| Refusal::Transient(format!("could not reach the control plane: {e}")))?;

        // Fails closed, unlike the usage reporter next door, and the difference
        // is deliberate: under-counting bytes during an outage costs money,
        // whereas admitting an unverified agent would let anyone who knows an
        // agent id impersonate the machine behind it.
        // A non-2xx is the control plane failing to answer, not answering "no" —
        // a verdict arrives as 200 with ok:false. 401 here means the relay's own
        // credential is wrong, which is an operator problem that will be fixed
        // without re-enrolling anybody.
        if !(200..300).contains(&status) {
            return Err(Refusal::Transient(format!(
                "the control plane could not answer ({status})"
            )));
        }

        let parsed: VerifyResponse = serde_json::from_str(&body)
            .map_err(|e| Refusal::Transient(format!("unreadable verify response: {e}")))?;

        match (parsed.ok, parsed.user_id) {
            (true, Some(user)) => Ok(user),
            // A considered "no". The agent was revoked, deleted, or never
            // existed, and nothing it can do on its own will change that.
            _ => Err(Refusal::Final(
                parsed
                    .error
                    .unwrap_or_else(|| "this agent is not accepted here".into()),
            )),
        }
    }
}

/// Says out loud whether agents can connect at all.
pub fn log_startup_state(agents: &Agents) {
    match (&agents.verifier, agents.disabled) {
        (Some(v), _) => info!(
            host = %v.endpoint.host,
            port = v.endpoint.port,
            path = %v.endpoint.path,
            "agent connections enabled"
        ),
        // Half-configured is a warning, not information. It looks identical to
        // "deliberately off" from the outside, and the difference is a typo
        // nobody will find without this line.
        (None, Some(reason)) => warn!(
            reason,
            "agent connections are DISABLED by a half-finished configuration: machines with no \
             public address cannot connect"
        ),
        (None, None) => info!(
            "agent connections are disabled ({URL_VAR} and {SECRET_VAR} are unset); machines \
             with no public address cannot be reached through this relay"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_values_are_unguessable_and_distinct() {
        let a = random_b64(TICKET_BYTES);
        let b = random_b64(TICKET_BYTES);
        assert_ne!(a, b);
        // 32 bytes, base64url unpadded.
        assert_eq!(a.len(), 43);
    }

    #[tokio::test]
    async fn opening_a_stream_for_an_unknown_agent_says_offline() {
        let agents = Agents::from_env().unwrap();
        assert!(matches!(
            agents.open("nobody", 22).await,
            Err(OpenError::Offline)
        ));
    }

    #[tokio::test]
    async fn a_ticket_can_only_be_claimed_once() {
        // The socket type cannot be constructed in a unit test, so this exercises
        // the map discipline that makes single use true: the entry is removed by
        // the claim itself, so a second claim finds nothing regardless of what it
        // presents.
        let agents = Agents::from_env().unwrap();
        let (tx, _rx) = oneshot::channel();
        agents.pending.insert("t".into(), tx);

        assert!(agents.pending.remove("t").is_some());
        assert!(agents.pending.remove("t").is_none());
    }

    #[test]
    fn encodes_the_field_names_the_verify_endpoint_reads() {
        let body = verify_request("agent-1", "nonce-1", "sig-1", Some("v1.2.3"));
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(parsed["agentId"], "agent-1");
        assert_eq!(parsed["nonce"], "nonce-1");
        assert_eq!(parsed["signature"], "sig-1");
        assert_eq!(parsed["version"], "v1.2.3");
    }

    #[test]
    fn an_agent_that_reports_no_version_sends_no_field() {
        // Absent, not empty. The control plane leaves the stored version alone
        // when the field is missing, so an agent too old to report one must not
        // erase what the dashboard knows about it.
        for silent in [None, Some("")] {
            let parsed: serde_json::Value =
                serde_json::from_str(&verify_request("a", "n", "s", silent)).unwrap();
            assert!(parsed.get("version").is_none(), "sent a version for {silent:?}");
        }
    }

    #[test]
    fn a_version_from_the_wire_cannot_be_unbounded() {
        let parsed: serde_json::Value =
            serde_json::from_str(&verify_request("a", "n", "s", Some(&"x".repeat(500)))).unwrap();
        let sent = parsed["version"].as_str().unwrap();
        assert!(sent.chars().count() <= 64);
        // Cut, not ellipsised: an identifier that gained a "…" would differ from
        // every published version forever.
        assert!(!sent.contains('…'));
    }

    #[test]
    fn a_hello_without_a_version_still_parses() {
        // An agent older than this relay. Requiring the field would refuse the
        // whole fleet at the handshake, which is the opposite of a rollout.
        let hello: Hello = serde_json::from_str(r#"{"type":"hello","agentId":"a"}"#).unwrap();
        assert_eq!(hello.agent_id, "a");
        assert!(hello.version.is_none());
    }

    #[test]
    fn agents_are_disabled_without_configuration() {
        // Both variables are absent in the test environment, and the failure
        // direction matters: disabled means /agent refuses connections, not that
        // it accepts them unauthenticated.
        let agents = Agents::from_env().unwrap();
        assert!(!agents.enabled());
    }
}
