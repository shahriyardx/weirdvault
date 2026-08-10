//! Ships byte counts to the control plane.
//!
//! The relay must not touch a database on the data path — that is the constraint
//! the token design exists to satisfy, and giving the internet-facing component
//! Postgres credentials to record a usage row would give it back for nothing.
//! So this module is the whole of the relay's involvement in the transfer
//! allowance: it drains the in-memory counters on a timer and POSTs a batch to
//! an authenticated endpoint on the control plane, which does the accumulating
//! and the enforcing.
//!
//! **A control plane that is down must cost accounting, never connections.**
//! Every failure here is logged and the batch is discarded. It is not retried
//! and not added back to the counters, because a POST that timed out may well
//! have been applied, and replaying it would bill an account twice for bytes it
//! moved once. Under-counting on an outage is the correct failure direction for
//! an abuse control: the worst case is that somebody gets a free gigabyte
//! during an incident, whereas over-counting locks a paying user out of their
//! own servers over a number nobody can reproduce.
//!
//! The request itself is built and sent by `crate::http`, which also owns the
//! reasons it is plain HTTP only.

use std::{sync::Arc, time::Duration};

use tracing::{debug, info, warn};

use crate::http::{check_secret, post_json, ConfigError, Endpoint};
use crate::quota::{AccountBytes, Quotas};

/// Named in any configuration error, so a failure at boot says which line of
/// the .env to go and fix.
const URL_VAR: &str = "RELAY_USAGE_URL";
const SECRET_VAR: &str = "RELAY_USAGE_SECRET";

/// How many accounts go in one request.
///
/// A relay with thousands of distinct subjects in a flush window should send
/// several modest requests rather than one enormous one; the ingest endpoint
/// applies the same limit and rejects anything larger.
const MAX_ENTRIES_PER_BATCH: usize = 500;

/// Everything the reporter needs, resolved once at startup so a misconfiguration
/// is a log line at boot rather than a surprise an hour later.
pub struct Reporter {
    quotas: Arc<Quotas>,
    /// `None` means no endpoint is configured. The drain still runs — it is what
    /// keeps the account map from growing without bound — and the batch is
    /// dropped.
    target: Option<(Endpoint, String)>,
    interval: Duration,
}

impl Reporter {
    /// Reads the environment. Returns the reporter and, when reporting is off,
    /// the reason, so the caller can say so at the only moment anyone is
    /// reading the log.
    pub fn from_env(quotas: Arc<Quotas>) -> Result<(Self, Option<&'static str>), ConfigError> {
        let interval = std::env::var("RELAY_USAGE_INTERVAL_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| *s > 0)
            .unwrap_or(60);
        let interval = Duration::from_secs(interval);

        let url = std::env::var("RELAY_USAGE_URL").ok().filter(|s| !s.is_empty());
        let secret = std::env::var("RELAY_USAGE_SECRET")
            .ok()
            .filter(|s| !s.is_empty());

        let (target, disabled) = match (url, secret) {
            (Some(url), Some(secret)) => {
                check_secret(SECRET_VAR, &secret)?;
                (Some((Endpoint::parse(URL_VAR, &url)?, secret)), None)
            }
            (None, _) => (None, Some("RELAY_USAGE_URL is not set")),
            (_, None) => (None, Some("RELAY_USAGE_SECRET is not set")),
        };

        Ok((
            Self {
                quotas,
                target,
                interval,
            },
            disabled,
        ))
    }

    /// Flushes on a timer until shutdown, then flushes once more.
    ///
    /// The final flush is the reason this listens for the signal itself instead
    /// of being cancelled after `axum::serve` returns: graceful shutdown waits
    /// for open sockets, and SSH sessions are open for hours. Waiting for them
    /// would mean a redeploy discarded up to a full interval of accounting on
    /// every instance.
    pub async fn run(self) {
        let mut ticker = tokio::time::interval(self.interval);
        // The first tick of a tokio interval completes immediately; skip it so a
        // restart does not fire a pointless empty request.
        ticker.tick().await;

        // Registered once and polled repeatedly, rather than rebuilt on every
        // pass round the loop: each construction installs a signal handler.
        let shutdown = crate::wait_for_shutdown();
        tokio::pin!(shutdown);

        loop {
            tokio::select! {
                _ = ticker.tick() => self.flush().await,
                _ = &mut shutdown => {
                    self.flush().await;
                    return;
                }
            }
        }
    }

    async fn flush(&self) {
        let batch = self.quotas.drain_usage();
        if batch.is_empty() {
            return;
        }

        let Some((endpoint, secret)) = &self.target else {
            debug!(
                accounts = batch.len(),
                "usage reporting is not configured; batch dropped"
            );
            return;
        };

        for chunk in batch.chunks(MAX_ENTRIES_PER_BATCH) {
            let body = encode_batch(chunk);
            match post_json(endpoint, secret, &body).await.map(|(s, _)| s) {
                Ok(status) if (200..300).contains(&status) => {
                    debug!(accounts = chunk.len(), status, "usage reported");
                }
                Ok(status) => {
                    // Most likely a rejected secret or a schema the two sides
                    // disagree on. Loud, because the allowance silently stops
                    // being enforced until somebody notices.
                    warn!(
                        accounts = chunk.len(),
                        status, "control plane refused a usage batch; bytes discarded"
                    );
                }
                Err(e) => {
                    warn!(
                        accounts = chunk.len(),
                        error = %e,
                        "could not report usage; bytes discarded rather than retried"
                    );
                }
            }
        }
    }
}

/// The batch as JSON. Hand-built from `serde_json` values rather than a derive,
/// because this is the only place the wire shape exists on this side and
/// keeping it visible next to the endpoint that parses it is worth more than
/// the type.
fn encode_batch(entries: &[AccountBytes]) -> String {
    let entries: Vec<serde_json::Value> = entries
        .iter()
        .map(|e| {
            serde_json::json!({
                "subject": e.account,
                "bytesUp": e.bytes_up,
                "bytesDown": e.bytes_down,
            })
        })
        .collect();
    serde_json::json!({ "entries": entries }).to_string()
}

/// Says out loud what is and is not running. A cap nobody is counting towards
/// is worse than no cap, because everything downstream reads as if it were.
pub fn log_startup_state(reporter: &Reporter, disabled: Option<&'static str>) {
    match (&reporter.target, disabled) {
        (Some((endpoint, _)), _) => info!(
            host = %endpoint.host,
            port = endpoint.port,
            path = %endpoint.path,
            interval_secs = reporter.interval.as_secs(),
            "reporting transfer usage to the control plane"
        ),
        (None, reason) => warn!(
            reason = reason.unwrap_or("unconfigured"),
            "transfer usage is NOT being reported: bytes are counted in memory and discarded, and the per-account transfer allowance will never be enforced"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::build_request;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn the_request_declares_the_body_it_actually_sends() {
        // A Content-Length that disagrees with the body is a request the server
        // either truncates or waits forever for.
        let ep = Endpoint::parse(URL_VAR, "http://web:3000/api/relay/usage").unwrap();
        let body = encode_batch(&[AccountBytes {
            account: "u1".into(),
            bytes_up: 12,
            bytes_down: 34,
        }]);
        let request = build_request(&ep, "s3cret", &body);

        let (head, sent) = request.split_once("\r\n\r\n").unwrap();
        assert_eq!(sent, body);
        assert!(head.contains(&format!("Content-Length: {}", body.len())));
        assert!(head.starts_with("POST /api/relay/usage HTTP/1.1\r\n"));
        assert!(head.contains("Authorization: Bearer s3cret\r\n"));
    }

    #[test]
    fn encodes_the_field_names_the_ingest_endpoint_reads() {
        // The names matter more than the shape: the endpoint on the other side
        // ignores what it does not recognise, so a rename here would post
        // batches that are accepted and count nothing.
        //
        // The other half of this pair is `the relay actually sends` in
        // apps/web/src/lib/usage.test.ts, which feeds this exact object through
        // the validator that receives it and greps this file for these names.
        // Neither test alone proves the two agree; together they mean a rename
        // on either side fails a build.
        let body = encode_batch(&[AccountBytes {
            account: "anon:11111111-4a4a-3333-4444-555555555555".into(),
            bytes_up: 1,
            bytes_down: 2,
        }]);
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let entry = &parsed["entries"][0];
        assert_eq!(entry["subject"], "anon:11111111-4a4a-3333-4444-555555555555");
        assert_eq!(entry["bytesUp"], 1);
        assert_eq!(entry["bytesDown"], 2);
    }

    /// Reads a whole HTTP request off a socket.
    ///
    /// The client sends `Connection: close` but does not half-close after
    /// writing, so a server cannot read to EOF; it has to honour the
    /// Content-Length it was given. Doing that here is what makes this a test
    /// of the request rather than of loopback packet boundaries.
    async fn read_request(sock: &mut tokio::net::TcpStream) -> String {
        let mut received = Vec::new();
        let mut chunk = [0u8; 512];
        loop {
            let n = sock.read(&mut chunk).await.unwrap();
            assert_ne!(n, 0, "the client closed before sending a full request");
            received.extend_from_slice(&chunk[..n]);

            let text = String::from_utf8_lossy(&received).into_owned();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let declared: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("Content-Length: "))
                    .and_then(|v| v.parse().ok())
                    .expect("a Content-Length header");
                if body.len() >= declared {
                    return text;
                }
            }
        }
    }

    #[tokio::test]
    async fn a_flush_sends_the_batch_and_leaves_the_counters_empty() {
        use crate::quota::{Limits, Quotas};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let request = read_request(&mut sock).await;
            sock.write_all(b"HTTP/1.1 204 No Content\r\n\r\n").await.unwrap();
            request
        });

        let quotas = Quotas::new(Limits::default());
        let guard = quotas.acquire("u1").unwrap();
        guard.counter().add_up(120);
        guard.counter().add_down(340);

        let reporter = Reporter {
            quotas: quotas.clone(),
            target: Some((
                Endpoint {
                    host: "127.0.0.1".into(),
                    port: addr.port(),
                    path: "/api/relay/usage".into(),
                },
                "shared-secret".into(),
            )),
            interval: Duration::from_secs(60),
        };
        reporter.flush().await;

        let request = server.await.unwrap();
        assert!(request.starts_with("POST /api/relay/usage HTTP/1.1\r\n"));
        assert!(request.contains("Authorization: Bearer shared-secret\r\n"));

        let body = request.split_once("\r\n\r\n").unwrap().1;
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(parsed["entries"][0]["subject"], "u1");
        assert_eq!(parsed["entries"][0]["bytesUp"], 120);
        assert_eq!(parsed["entries"][0]["bytesDown"], 340);

        // Sent means gone. Leaving the bytes behind would report them again on
        // the next tick and bill the account twice for one transfer.
        assert!(quotas.drain_usage().is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_control_plane_costs_accounting_and_nothing_else() {
        use crate::quota::{Limits, Quotas};

        // Port 1 on loopback with nothing on it: the connection is refused
        // immediately, which is the failure a control plane that is down
        // presents as.
        let quotas = Quotas::new(Limits::default());
        let guard = quotas.acquire("u1").unwrap();
        guard.counter().add_up(99);

        let reporter = Reporter {
            quotas: quotas.clone(),
            target: Some((
                Endpoint {
                    host: "127.0.0.1".into(),
                    port: 1,
                    path: "/api/relay/usage".into(),
                },
                "shared-secret".into(),
            )),
            interval: Duration::from_secs(60),
        };

        // Returns rather than propagating: nothing on the connection path is
        // waiting on this, and a failed flush must not become a failed relay.
        reporter.flush().await;

        // The batch is gone, not requeued. Under-counting is the direction we
        // chose; see the module header.
        assert!(quotas.drain_usage().is_empty());
        // And the connection that produced those bytes is still live.
        assert_eq!(quotas.active_total(), 1);
        drop(guard);
    }

    #[tokio::test]
    async fn an_unconfigured_reporter_still_drains() {
        use crate::quota::{Limits, Quotas};

        // Otherwise the account map is a slow leak on a self-hosted relay that
        // has deliberately not configured reporting at all.
        let quotas = Quotas::new(Limits::default());
        {
            let guard = quotas.acquire("u1").unwrap();
            guard.counter().add_up(7);
        }

        let reporter = Reporter {
            quotas: quotas.clone(),
            target: None,
            interval: Duration::from_secs(60),
        };
        reporter.flush().await;

        assert!(quotas.drain_usage().is_empty());
        assert_eq!(quotas.tracked_accounts(), 0, "the idle account should be evicted");
    }

}
