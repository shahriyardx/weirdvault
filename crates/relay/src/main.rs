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

mod quota;
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
use tracing::{info, warn};

use quota::{Limits, Quotas};

#[derive(Clone)]
struct AppState {
    secret: Arc<Vec<u8>>,
    quotas: Arc<Quotas>,
    allowed_ports: Arc<Vec<u16>>,
    allow_private: bool,
    dial_timeout: Duration,
}

#[derive(Debug, Deserialize)]
struct ConnectParams {
    host: String,
    port: u16,
    token: String,
}

#[tokio::main]
async fn main() {
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

    let state = AppState {
        secret: Arc::new(secret.into_bytes()),
        quotas: Quotas::new(Limits::default()),
        allowed_ports: Arc::new(allowed_ports.clone()),
        allow_private,
        dial_timeout: Duration::from_secs(10),
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
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

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "status": "ok",
        "active_connections": state.quotas.active_total(),
    }))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<ConnectParams>,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> Response {
    if !state.allowed_ports.contains(&params.port) {
        return (StatusCode::FORBIDDEN, "destination port not allowed").into_response();
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let claims = match token::verify(&state.secret, &params.token, &params.host, params.port, now) {
        Ok(c) => c,
        Err(e) => {
            warn!(%peer, error = %e, "rejected relay token");
            return (StatusCode::UNAUTHORIZED, e.to_string()).into_response();
        }
    };

    // Vet before the upgrade so a refusal is an HTTP error the client can read,
    // not a WebSocket that opens and immediately closes.
    let ip = match ssrf::resolve_and_vet(&params.host, params.port, state.allow_private).await {
        Ok(ip) => ip,
        Err(e) => {
            warn!(%peer, account = %claims.sub, host = %params.host, error = %e, "rejected destination");
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

    let target = SocketAddr::new(ip, params.port);
    let host = params.host.clone();

    ws.on_upgrade(move |socket| async move {
        if let Err(e) = bridge(socket, target, state.dial_timeout, &guard).await {
            warn!(account = %guard.account(), %host, %target, error = %e, "connection ended with error");
        }
    })
}

/// Turns a dial failure into something a person can act on.
///
/// The browser cannot see the HTTP status of a failed WebSocket upgrade, and a
/// dropped socket surfaces in the SSH client as "handshake failed: EOF" — which
/// tells the user nothing. The relay knows precisely why the dial failed, so it
/// says so in the close frame, which the client can read.
fn dial_failure_reason(err: &std::io::Error, target: SocketAddr) -> String {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::ConnectionRefused => format!(
            "{target} refused the connection — is sshd running and listening on that port?"
        ),
        ErrorKind::TimedOut => format!(
            "{target} did not respond — it may be firewalled, or the address may be wrong"
        ),
        ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable => format!(
            "no route to {target} — the relay cannot reach that address. \
             Private addresses are only reachable from a relay on the same network"
        ),
        _ => format!("could not connect to {target}: {err}"),
    }
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

    let up = tokio::spawn(async move {
        let mut total: u64 = 0;
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(data) => {
                    total += data.len() as u64;
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
    guard.record(up_bytes, down_bytes);

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

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutting down");
}
