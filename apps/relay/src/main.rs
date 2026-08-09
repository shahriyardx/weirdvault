//! webxterm relay.
//!
//! Bridges a browser WebSocket to a TCP endpoint and forwards bytes it cannot
//! read. The SSH handshake and every subsequent byte are encrypted inside the
//! user's tab, so this process handles ciphertext only — that is what makes
//! webxterm end-to-end encrypted rather than end-to-relay.
//!
//! What it does hold is metadata: who connected, to which host, when, and how
//! much. That is stated plainly in docs/THREAT-MODEL.md rather than glossed
//! over, and it is the reason self-hosting is a first-class option.

mod agent;
mod http;
mod quota;
mod reporter;
mod ssrf;
mod token;

use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tracing::{debug, info, warn};

use agent::Agents;
use quota::{Limits, Quotas};

#[derive(Clone)]
struct AppState {
    secret: Arc<Vec<u8>>,
    quotas: Arc<Quotas>,
    allowed_ports: Arc<Vec<u16>>,
    allow_private: bool,
    dial_timeout: Duration,
    agents: Arc<Agents>,
}

/// A connection request names one destination, in one of two ways.
///
/// `host`+`port` is an address to dial. `agent` is a machine that dialled us
/// first and is waiting on a control connection. They are mutually exclusive,
/// checked below, and their tokens are not interchangeable — see token.rs.
#[derive(Debug, Deserialize)]
struct ConnectParams {
    host: Option<String>,
    port: Option<u16>,
    agent: Option<String>,
    token: String,
}

/// What an agent presents when it dials back to carry one session.
#[derive(Debug, Deserialize)]
struct StreamParams {
    ticket: String,
}

/// The port an agent forwards to when the caller does not say.
const DEFAULT_SSH_PORT: u16 = 22;

#[tokio::main]
async fn main() {
    // The runtime image is distroless: no shell, no curl. A container
    // healthcheck therefore has to be the binary itself.
    if std::env::args().any(|a| a == "--healthcheck") {
        std::process::exit(healthcheck().await);
    }

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "webxterm_relay=info,tower_http=warn".into()),
        )
        .init();

    let secret = std::env::var("RELAY_SECRET").unwrap_or_else(|_| {
        // Refusing to start is better than running with a guessable secret and
        // presenting as authenticated.
        eprintln!("RELAY_SECRET is required (shared with the control plane)");
        std::process::exit(1);
    });

    let allow_private = std::env::var("RELAY_ALLOW_PRIVATE").as_deref() == Ok("1");
    if allow_private {
        warn!("RELAY_ALLOW_PRIVATE is set: private and loopback destinations are reachable. Development only.");
    }

    let allowed_ports: Vec<u16> = std::env::var("RELAY_PORTS")
        .unwrap_or_else(|_| "22".into())
        .split(',')
        .filter_map(|p| p.trim().parse().ok())
        .collect();

    // Resolved before the listener, for the same reason the reporter is: a
    // relay that starts and cannot ever authenticate an agent should say so at
    // boot, not when somebody's home server fails to appear.
    let agents = match Agents::from_env() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    agent::log_startup_state(&agents);

    let state = AppState {
        secret: Arc::new(secret.into_bytes()),
        quotas: Quotas::new(Limits::default()),
        allowed_ports: Arc::new(allowed_ports.clone()),
        allow_private,
        dial_timeout: Duration::from_secs(10),
        agents,
    };

    // Started before the listener so a broken RELAY_USAGE_URL stops the process
    // rather than producing a relay that serves traffic and reports nothing.
    let (usage_reporter, reporting_disabled) = match reporter::Reporter::from_env(state.quotas.clone())
    {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    reporter::log_startup_state(&usage_reporter, reporting_disabled);
    // Detached: it owns its own shutdown signal, and nothing on the connection
    // path ever waits on it.
    tokio::spawn(usage_reporter.run());

    let app = Router::new()
        .route("/ws", get(ws_handler))
        // The agent's two sockets. `control` is long-lived and carries JSON;
        // `stream` is one per session and carries the same SSH ciphertext /ws
        // does. They are separate paths rather than one path with a mode flag
        // because they authenticate completely differently — a signed challenge
        // versus a one-time ticket — and a single handler branching on a query
        // parameter is how those two get accidentally swapped.
        .route("/agent/control", get(agent_control))
        .route("/agent/stream", get(agent_stream))
        .route("/healthz", get(health))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state.clone());

    let addr: SocketAddr = std::env::var("RELAY_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()
        .expect("RELAY_ADDR must be host:port");

    info!(%addr, ports = ?allowed_ports, allow_private, "relay listening");

    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("serve");
}

/// Probes our own /healthz. Exit 0 healthy, 1 not.
async fn healthcheck() -> i32 {
    let addr = std::env::var("RELAY_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    // Connect to loopback regardless of the bind address: 0.0.0.0 is not a
    // destination, and the check runs inside the same container.
    let port = addr.rsplit(':').next().unwrap_or("8080");
    match tokio::time::timeout(
        Duration::from_secs(3),
        TcpStream::connect(format!("127.0.0.1:{port}")),
    )
    .await
    {
        Ok(Ok(_)) => 0,
        _ => 1,
    }
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "status": "ok",
        "active_connections": state.quotas.active_total(),
        "agents_connected": state.agents.connected(),
    }))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<ConnectParams>,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> Response {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    match (&params.agent, &params.host) {
        (Some(agent_id), None) => {
            connect_via_agent(ws, &state, &params, agent_id, now, peer).await
        }
        (None, Some(host)) => {
            let Some(port) = params.port else {
                return (StatusCode::BAD_REQUEST, "port is required with host").into_response();
            };
            connect_to_address(ws, state.clone(), &params, host, port, now, peer).await
        }
        (Some(_), Some(_)) => (
            StatusCode::BAD_REQUEST,
            "name a host or an agent, not both",
        )
            .into_response(),
        (None, None) => (StatusCode::BAD_REQUEST, "host or agent is required").into_response(),
    }
}

/// The original path: dial an address the relay can reach.
#[allow(clippy::too_many_arguments)]
async fn connect_to_address(
    ws: WebSocketUpgrade,
    state: AppState,
    params: &ConnectParams,
    host: &str,
    port: u16,
    now: u64,
    peer: SocketAddr,
) -> Response {
    if !state.allowed_ports.contains(&port) {
        return (StatusCode::FORBIDDEN, "destination port not allowed").into_response();
    }

    let claims = match token::verify(&state.secret, &params.token, host, port, now) {
        Ok(c) => c,
        Err(e) => {
            warn!(%peer, error = %e, "rejected relay token");
            return (StatusCode::UNAUTHORIZED, e.to_string()).into_response();
        }
    };

    // Vet before the upgrade so a refusal is an HTTP error the client can read,
    // not a WebSocket that opens and immediately closes.
    let ip = match ssrf::resolve_and_vet(host, port, state.allow_private).await {
        Ok(ip) => ip,
        Err(e) => {
            warn!(%peer, account = %claims.sub, %host, error = %e, "rejected destination");
            return (StatusCode::FORBIDDEN, e.to_string()).into_response();
        }
    };

    let guard = match state.quotas.acquire(&claims.sub) {
        Ok(g) => g,
        Err(e) => {
            warn!(account = %claims.sub, error = %e, "quota exceeded");
            return (StatusCode::TOO_MANY_REQUESTS, e.to_string()).into_response();
        }
    };

    let target = SocketAddr::new(ip, port);
    let host = host.to_string();

    ws.on_upgrade(move |socket| async move {
        if let Err(e) = bridge(socket, target, state.dial_timeout, &guard).await {
            warn!(account = %guard.account(), %host, %target, error = %e, "connection ended with error");
        }
    })
}

/// The NAT path: ask a machine that dialled us to dial back.
///
/// There is no SSRF check here and that is not an omission. The guard exists
/// because the relay chooses an address to connect to, and a user who can pick
/// that address can point it at anything on the relay's network. Here the relay
/// picks nothing: the destination is a machine that authenticated to us with its
/// own key, and the only address involved is loopback on that machine, chosen by
/// software the owner installed there. The port allowlist still applies, because
/// that one is about which services this product forwards at all.
async fn connect_via_agent(
    ws: WebSocketUpgrade,
    state: &AppState,
    params: &ConnectParams,
    agent_id: &str,
    now: u64,
    peer: SocketAddr,
) -> Response {
    if !state.agents.enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "this relay is not configured for agents",
        )
            .into_response();
    }

    let port = params.port.unwrap_or(DEFAULT_SSH_PORT);
    if !state.allowed_ports.contains(&port) {
        return (StatusCode::FORBIDDEN, "destination port not allowed").into_response();
    }

    let claims = match token::verify_agent(&state.secret, &params.token, agent_id, now) {
        Ok(c) => c,
        Err(e) => {
            warn!(%peer, error = %e, "rejected agent relay token");
            return (StatusCode::UNAUTHORIZED, e.to_string()).into_response();
        }
    };

    // Checked before the upgrade so "that machine is not online" is an HTTP
    // status the browser can read. It races — the agent can drop in the gap —
    // which is why the post-upgrade path reports its own failure too.
    let Some(owner) = state.agents.owner(agent_id) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "that machine's agent is not connected",
        )
            .into_response();
    };

    // Two independent statements of who owns this machine, required to agree.
    // See Agents::owner for why this is worth a comparison even though the
    // control plane already checked it.
    if owner != claims.sub {
        warn!(
            %peer,
            agent = %agent_id,
            token_account = %claims.sub,
            agent_account = %owner,
            "refused: the token's account does not own this agent"
        );
        return (StatusCode::FORBIDDEN, "that agent belongs to another account").into_response();
    }

    let guard = match state.quotas.acquire(&claims.sub) {
        Ok(g) => g,
        Err(e) => {
            warn!(account = %claims.sub, error = %e, "quota exceeded");
            return (StatusCode::TOO_MANY_REQUESTS, e.to_string()).into_response();
        }
    };

    let agents = state.agents.clone();
    let agent_id = agent_id.to_string();

    ws.on_upgrade(move |browser| async move {
        let started = Instant::now();
        let stream = match agents.open(&agent_id, port).await {
            Ok(s) => s,
            Err(e) => {
                warn!(agent = %agent_id, error = %e, "could not open a stream to the agent");
                close_with_reason(browser, e.to_string()).await;
                return;
            }
        };

        info!(account = %guard.account(), agent = %agent_id, port, "agent connection open");
        let (up, down) = splice(browser, stream, &guard).await;
        info!(
            account = %guard.account(),
            agent = %agent_id,
            up_bytes = up,
            down_bytes = down,
            duration_ms = started.elapsed().as_millis() as u64,
            "agent connection closed"
        );
    })
}

/// An agent's long-lived control connection.
async fn agent_control(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    if !state.agents.enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "this relay is not configured for agents",
        )
            .into_response();
    }
    let agents = state.agents.clone();
    ws.on_upgrade(move |socket| agents.serve_control(socket))
}

/// An agent dialling back to carry one session.
async fn agent_stream(
    ws: WebSocketUpgrade,
    Query(params): Query<StreamParams>,
    State(state): State<AppState>,
) -> Response {
    if !state.agents.enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "this relay is not configured for agents",
        )
            .into_response();
    }

    let agents = state.agents.clone();
    ws.on_upgrade(move |socket| async move {
        // The claim is the authorisation, and it is atomic: the ticket is
        // removed by whoever claims it, so a replay finds nothing. A refusal
        // drops the socket, which the agent sees as a close.
        if !agents.accept_stream(&params.ticket, socket) {
            debug!("agent presented an unknown or already-claimed ticket");
        }
    })
}

/// Turns a dial failure into something a person can act on.
///
/// The browser cannot see the HTTP status of a failed WebSocket upgrade, and a
/// dropped socket surfaces in the SSH client as "handshake failed: EOF" — which
/// tells the user nothing. The relay knows precisely why the dial failed, so it
/// says so in the close frame, which the client can read.
///
/// RFC 6455 caps a close reason at 123 bytes. Exceed it and the frame is
/// invalid, the browser discards the reason, and the user is back to a bare
/// EOF — so these stay short, and the full detail goes to the log.
const MAX_CLOSE_REASON: usize = 123;

fn dial_failure_reason(err: &std::io::Error, target: SocketAddr) -> String {
    use std::io::ErrorKind;
    let msg = match err.kind() {
        ErrorKind::ConnectionRefused => {
            format!("{target} refused the connection — is sshd listening there?")
        }
        ErrorKind::TimedOut => {
            format!("{target} did not respond — firewalled, or wrong address?")
        }
        ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable => {
            if is_private(target.ip()) {
                // On macOS 15+ an unapproved process has its LAN packets
                // dropped silently, which looks exactly like this.
                format!("no route to {target} — relay not on that network, or missing macOS Local Network permission")
            } else {
                format!("no route to {target} — the relay cannot reach that address")
            }
        }
        _ => format!("could not connect to {target}: {err}"),
    };
    truncate_utf8(msg, MAX_CLOSE_REASON)
}

/// Truncates on a character boundary, never mid-codepoint — an invalid UTF-8
/// close reason is discarded by the browser just like an over-long one.
pub(crate) fn truncate_utf8(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max.saturating_sub(1);
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push('…');
    s
}

/// Copies bytes between the WebSocket and the TCP socket until either closes.
async fn bridge(
    mut socket: WebSocket,
    target: SocketAddr,
    dial_timeout: Duration,
    guard: &quota::ConnectionGuard,
) -> std::io::Result<()> {
    let dialled = match tokio::time::timeout(dial_timeout, TcpStream::connect(target)).await {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "timed out",
        )),
    };

    let tcp = match dialled {
        Ok(s) => s,
        Err(e) => {
            // Close with the reason rather than dropping the socket, so the
            // client reports why instead of "handshake failed: EOF".
            warn!(%target, error = %e, "dial failed");
            let reason = dial_failure_reason(&e, target);
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    // 1011: the server encountered an unexpected condition.
                    code: 1011,
                    reason: reason.clone().into(),
                })))
                .await;
            return Err(std::io::Error::new(e.kind(), reason));
        }
    };
    tcp.set_nodelay(true)?; // interactive typing must not wait on Nagle

    let started = Instant::now();
    info!(account = %guard.account(), %target, "connection open");

    let (mut ws_tx, mut ws_rx) = socket.split();
    let (mut tcp_rx, mut tcp_tx) = tcp.into_split();

    // Counted as the bytes move, not when the socket closes. A session that
    // stays open for a week and pushes a backup through SFTP has to be visible
    // to the transfer allowance while it is happening; see quota.rs.
    let up_counter = guard.counter();
    let down_counter = guard.counter();

    let up = tokio::spawn(async move {
        let mut total: u64 = 0;
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(data) => {
                    total += data.len() as u64;
                    up_counter.add_up(data.len() as u64);
                    if tcp_tx.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                // Text frames are meaningless here: the payload is SSH
                // ciphertext, which is binary by definition.
                _ => {}
            }
        }
        let _ = tcp_tx.shutdown().await;
        total
    });

    let down = tokio::spawn(async move {
        let mut total: u64 = 0;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match tcp_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    total += n as u64;
                    down_counter.add_down(n as u64);
                    if ws_tx
                        .send(Message::Binary(buf[..n].to_vec().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = ws_tx.close().await;
        total
    });

    let (up_bytes, down_bytes) = tokio::join!(up, down);
    let (up_bytes, down_bytes) = (up_bytes.unwrap_or(0), down_bytes.unwrap_or(0));

    info!(
        account = %guard.account(),
        %target,
        up_bytes,
        down_bytes,
        duration_ms = started.elapsed().as_millis() as u64,
        "connection closed"
    );
    Ok(())
}

/// Closes a browser socket with a reason it can actually read.
///
/// Same discipline as a failed dial: the browser cannot see the HTTP status of
/// an upgrade that already succeeded, so a bare drop surfaces to the user as
/// "handshake failed: EOF" and sends them to debug their server.
async fn close_with_reason(mut socket: WebSocket, reason: String) {
    let _ = socket
        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code: 1011,
            reason: truncate_utf8(reason, MAX_CLOSE_REASON).into(),
        })))
        .await;
}

/// Copies binary frames between two WebSockets until either closes.
///
/// The agent half is already a WebSocket, so unlike `bridge` there is no TCP
/// socket here and nothing to dial — this is a splice, not a proxy. Frame
/// boundaries are preserved rather than re-chunked, which costs nothing and
/// means the agent's reads and the browser's writes stay one-to-one.
///
/// Returns (up, down) in bytes, counted from the browser's point of view so the
/// numbers mean the same thing they do on the direct path.
async fn splice(
    browser: WebSocket,
    agent: WebSocket,
    guard: &quota::ConnectionGuard,
) -> (u64, u64) {
    let (mut browser_tx, mut browser_rx) = browser.split();
    let (mut agent_tx, mut agent_rx) = agent.split();

    let up_counter = guard.counter();
    let down_counter = guard.counter();

    let up = tokio::spawn(async move {
        let mut total = 0u64;
        while let Some(Ok(msg)) = browser_rx.next().await {
            match msg {
                Message::Binary(data) => {
                    total += data.len() as u64;
                    up_counter.add_up(data.len() as u64);
                    if agent_tx.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = agent_tx.close().await;
        total
    });

    let down = tokio::spawn(async move {
        let mut total = 0u64;
        while let Some(Ok(msg)) = agent_rx.next().await {
            match msg {
                Message::Binary(data) => {
                    total += data.len() as u64;
                    down_counter.add_down(data.len() as u64);
                    if browser_tx.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = browser_tx.close().await;
        total
    });

    let (up, down) = tokio::join!(up, down);
    (up.unwrap_or(0), down.unwrap_or(0))
}

fn is_private(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

async fn shutdown_signal() {
    wait_for_shutdown().await;
    info!("shutting down");
}

/// Resolves on SIGINT or SIGTERM.
///
/// SIGTERM matters more than SIGINT here: `docker stop` and every orchestrator
/// send it, and a process that only listens for Ctrl-C is killed outright ten
/// seconds later. That was survivable when shutdown did nothing; it is not now
/// that the usage reporter has a final batch to flush.
///
/// Called from two places — the server's graceful shutdown and the reporter —
/// which is fine: each awaits its own registration and both are notified.
pub async fn wait_for_shutdown() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(e) => {
                // Never resolve rather than resolve immediately: returning here
                // would look exactly like a shutdown request and take the
                // process down at boot.
                warn!(error = %e, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };

    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
}
