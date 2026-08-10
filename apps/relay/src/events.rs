//! Connection events, on their way to the audit log.
//!
//! `audit_event` has carried `connection.opened` and `connection.closed` in its
//! catalogue, with validators, since the log was written — and nothing emitted
//! them. The Activity page showed devices, recovery codes, host keys and
//! installed keys, and not the one thing anybody looks for first: who connected
//! to which host, when. The README promised it in the meantime.
//!
//! The reason it stayed unbuilt is the same constraint the whole relay is shaped
//! by: this process has no database, deliberately, and giving the
//! internet-facing component Postgres credentials to write an audit row would
//! hand back exactly the blast radius the token design exists to avoid. So these
//! go the way byte counts already go — buffered in memory, drained on a timer,
//! POSTed to the control plane on an authenticated endpoint, which does the
//! writing.
//!
//! # What the relay knows, and what it must not keep
//!
//! It knows the destination in plaintext; it has to, to dial it. It must not
//! record it. A hostname in a table indexed by user and time rebuilds precisely
//! the map of somebody's infrastructure that the vault exists to hide, and does
//! it durably instead of transiently.
//!
//! So the browser blinds the host — HMAC under a key derived from the vault
//! password, which no server ever sees — and sends that ref when it mints its
//! relay token. The control plane copies it into the token, this process echoes
//! it back on the events below, and the ref reaches the audit row without the
//! relay ever having learned anything it did not already know for a moment.
//! Sessions whose token carries no ref are recorded without one, which is worth
//! more than not recording them.
//!
//! # Dropped rather than retried
//!
//! Same discipline as `reporter.rs`, for a weaker reason: a POST that timed out
//! may have been applied, and replaying it would double an entry in a timeline
//! that people read as a sequence of real events. A gap during an outage is
//! honest; a duplicate is a fact that never happened.

use std::sync::Mutex;

use serde::Serialize;

/// How many events are held between flushes.
///
/// A relay carrying a thousand sessions a minute is doing very well; ten
/// thousand queued events is far past that and past the point where the control
/// plane is keeping up. Bounded because the alternative — an unbounded queue on
/// the internet-facing process — is a memory exhaustion path that an attacker
/// opening and closing sockets could drive.
const MAX_QUEUED: usize = 10_000;

/// One thing that happened to one connection.
///
/// `kind` is the audit event type verbatim, so the ingest route does not
/// translate anything and a new kind is a new string on both sides rather than
/// a mapping table in the middle.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionEvent {
    /// The audit event type: "connection.opened" or "connection.closed".
    pub kind: &'static str,
    /// Account id, or `anon:<uuid>` — the ingest side drops those, since an
    /// anonymous visitor has no account for a timeline to belong to.
    pub subject: String,
    /// The blinded host reference from the token, when the browser sent one.
    #[serde(rename = "targetRef", skip_serializing_if = "Option::is_none")]
    pub target_ref: Option<String>,
    pub port: u16,
    #[serde(rename = "bytesUp", skip_serializing_if = "Option::is_none")]
    pub bytes_up: Option<u64>,
    #[serde(rename = "bytesDown", skip_serializing_if = "Option::is_none")]
    pub bytes_down: Option<u64>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// The queue itself.
#[derive(Default)]
pub struct ConnectionEvents {
    queued: Mutex<Vec<ConnectionEvent>>,
    /// Counted so a dropped event is visible in the log rather than silent.
    dropped: Mutex<u64>,
}

impl ConnectionEvents {
    pub fn new() -> Self {
        Self::default()
    }

    /// A session started.
    pub fn opened(&self, subject: &str, target_ref: Option<&str>, port: u16) {
        self.push(ConnectionEvent {
            kind: "connection.opened",
            subject: subject.to_string(),
            target_ref: target_ref.map(str::to_string),
            port,
            bytes_up: None,
            bytes_down: None,
            duration_ms: None,
        });
    }

    /// A session ended, with what it moved and how long it lasted.
    pub fn closed(
        &self,
        subject: &str,
        target_ref: Option<&str>,
        port: u16,
        bytes_up: u64,
        bytes_down: u64,
        duration_ms: u64,
    ) {
        self.push(ConnectionEvent {
            kind: "connection.closed",
            subject: subject.to_string(),
            target_ref: target_ref.map(str::to_string),
            port,
            bytes_up: Some(bytes_up),
            bytes_down: Some(bytes_down),
            duration_ms: Some(duration_ms),
        });
    }

    fn push(&self, event: ConnectionEvent) {
        let mut queued = self.queued.lock().expect("events lock");
        if queued.len() >= MAX_QUEUED {
            // The oldest are dropped rather than the newest: a timeline missing
            // its beginning is more useful than one that stops.
            queued.remove(0);
            *self.dropped.lock().expect("dropped lock") += 1;
        }
        queued.push(event);
    }

    /// Takes everything queued, leaving the queue empty.
    pub fn drain(&self) -> Vec<ConnectionEvent> {
        std::mem::take(&mut *self.queued.lock().expect("events lock"))
    }

    /// How many were dropped for want of room, and resets the count.
    pub fn take_dropped(&self) -> u64 {
        std::mem::take(&mut *self.dropped.lock().expect("dropped lock"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_opened_event_carries_no_totals() {
        // Bytes and duration are not knowable yet, and a zero would read as a
        // connection that moved nothing rather than one still open.
        let events = ConnectionEvents::new();
        events.opened("user-1", Some("ref-1"), 22);

        let drained = events.drain();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].kind, "connection.opened");
        assert!(drained[0].bytes_up.is_none());
        assert!(drained[0].duration_ms.is_none());
    }

    #[test]
    fn a_closed_event_carries_what_the_row_needs() {
        let events = ConnectionEvents::new();
        events.closed("user-1", Some("ref-1"), 2222, 100, 900, 4200);

        let drained = events.drain();
        assert_eq!(drained[0].kind, "connection.closed");
        assert_eq!(drained[0].bytes_up, Some(100));
        assert_eq!(drained[0].bytes_down, Some(900));
        assert_eq!(drained[0].duration_ms, Some(4200));
        assert_eq!(drained[0].port, 2222);
    }

    #[test]
    fn a_session_with_no_ref_is_still_recorded() {
        // A token minted before the browser sent refs, or by a client that does
        // not. "Something connected on port 22" beats no row at all.
        let events = ConnectionEvents::new();
        events.opened("user-1", None, 22);

        assert!(events.drain()[0].target_ref.is_none());
    }

    #[test]
    fn draining_empties_the_queue() {
        let events = ConnectionEvents::new();
        events.opened("user-1", None, 22);

        assert_eq!(events.drain().len(), 1);
        assert!(events.drain().is_empty());
    }

    #[test]
    fn the_queue_is_bounded_and_says_how_much_it_lost() {
        // An unbounded queue on the internet-facing process is a memory
        // exhaustion path somebody can drive by opening sockets.
        let events = ConnectionEvents::new();
        for _ in 0..MAX_QUEUED + 5 {
            events.opened("user-1", None, 22);
        }

        assert_eq!(events.drain().len(), MAX_QUEUED);
        assert_eq!(events.take_dropped(), 5);
        // And the count resets, so one warning does not repeat forever.
        assert_eq!(events.take_dropped(), 0);
    }
}
