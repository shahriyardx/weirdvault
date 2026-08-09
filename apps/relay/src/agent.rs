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
}

#[derive(Debug, Deserialize)]
struct Proof {
    signature: String,
}

#[derive(Debug, Deserialize)]
struct VerifyResponse {
    ok: bool,
    #[serde(rename = "userId")]
    user_id: Option<String>,
    error: Option<String>,
}

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
            let hello: Hello = recv_json(&mut ws_rx).await?;
            let nonce = random_b64(NONCE_BYTES);

            let challenge = serde_json::json!({ "type": "challenge", "nonce": nonce }).to_string();
            ws_tx
                .send(Message::Text(challenge.into()))
                .await
                .map_err(|e| e.to_string())?;

            let proof: Proof = recv_json(&mut ws_rx).await?;
            let account = verifier
                .verify(&hello.agent_id, &nonce, &proof.signature)
                .await?;
            Ok::<_, String>((hello.agent_id, account))
        };

        let (agent_id, account) = match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(reason)) => {
                warn!(%reason, "agent control handshake refused");
                let _ = ws_tx
                    .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                        code: 1008, // policy violation
                        reason: crate::truncate_utf8(reason, 123).into(),
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

        // Nothing is expected from the agent after the handshake; this exists to
        // notice the socket dying. Pongs arrive here and are discarded, which is
        // enough — a dead peer surfaces as a failed send from the writer or an
        // end of stream here.
        let reader = async move {
            while let Some(Ok(msg)) = ws_rx.next().await {
                if matches!(msg, Message::Close(_)) {
                    break;
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

impl Verifier {
    /// Returns the owning account id, or a reason to refuse.
    async fn verify(&self, agent_id: &str, nonce: &str, signature: &str) -> Result<String, String> {
        let body = serde_json::json!({
            "agentId": agent_id,
            "nonce": nonce,
            "signature": signature,
        })
        .to_string();

        let (status, body) = post_json(&self.endpoint, &self.secret, &body)
            .await
            .map_err(|e| format!("could not reach the control plane: {e}"))?;

        // Fails closed, unlike the usage reporter next door, and the difference
        // is deliberate: under-counting bytes during an outage costs money,
        // whereas admitting an unverified agent would let anyone who knows an
        // agent id impersonate the machine behind it.
        if !(200..300).contains(&status) {
            return Err(format!("the control plane refused this agent ({status})"));
        }

        let parsed: VerifyResponse =
            serde_json::from_str(&body).map_err(|e| format!("unreadable verify response: {e}"))?;

        match (parsed.ok, parsed.user_id) {
            (true, Some(user)) => Ok(user),
            _ => Err(parsed
                .error
                .unwrap_or_else(|| "the control plane refused this agent".into())),
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
    fn agents_are_disabled_without_configuration() {
        // Both variables are absent in the test environment, and the failure
        // direction matters: disabled means /agent refuses connections, not that
        // it accepts them unauthenticated.
        let agents = Agents::from_env().unwrap();
        assert!(!agents.enabled());
    }
}
