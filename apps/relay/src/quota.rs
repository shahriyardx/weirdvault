//! Per-account limits, and the byte counters behind the transfer allowance.
//!
//! Kept in process memory rather than a shared store: the relay is stateless by
//! design, and a user who spreads connections across several relay instances
//! still hits the limit on each. Approximate enforcement of an abuse control is
//! the right trade for keeping the data path free of a network round trip.
//!
//! The byte counters are the same trade taken one step further. Bytes are added
//! here with relaxed atomics as they are copied, and `drain_usage` hands the
//! accumulated totals to the reporter (see `reporter.rs`), which posts them to
//! the control plane. The relay never learns what an account's allowance is and
//! never refuses a connection because of one — that decision belongs to the
//! token mint, which has a database and is not on the data path.
//!
//! Counting incrementally rather than at connection close is deliberate. A
//! single SSH session can stay open for days and move a great deal through an
//! SFTP channel; if bytes only landed here when the socket closed, a long-lived
//! connection would be invisible to the allowance for as long as it lasted,
//! which is precisely the shape abuse takes.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

use dashmap::DashMap;

#[derive(Debug)]
pub struct Limits {
    pub max_connections_per_account: u32,
    pub max_total_connections: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections_per_account: 16,
            max_total_connections: 2048,
        }
    }
}

#[derive(Default)]
struct AccountUsage {
    active: AtomicU64,
    bytes_up: AtomicU64,
    bytes_down: AtomicU64,
}

pub struct Quotas {
    limits: Limits,
    accounts: DashMap<String, Arc<AccountUsage>>,
    total_active: AtomicU64,
}

/// Decrements the counters when dropped, so an early return or a panic in the
/// connection handler cannot leak a slot and slowly starve the account.
pub struct ConnectionGuard {
    quotas: Arc<Quotas>,
    account: String,
    usage: Arc<AccountUsage>,
}

/// A cloneable handle to one account's byte counters.
///
/// The two halves of a copy loop live in separate tasks and neither owns the
/// guard, so they get one of these each. It deliberately exposes nothing but
/// addition: a forwarding task has no business reading a total, and certainly
/// no business deciding anything from one.
#[derive(Clone)]
pub struct UsageCounter {
    usage: Arc<AccountUsage>,
}

/// One account's bytes since the previous drain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountBytes {
    /// The token subject: a user id, or `anon:<uuid>` for a signed-out visitor.
    pub account: String,
    pub bytes_up: u64,
    pub bytes_down: u64,
}

impl Quotas {
    pub fn new(limits: Limits) -> Arc<Self> {
        Arc::new(Self {
            limits,
            accounts: DashMap::new(),
            total_active: AtomicU64::new(0),
        })
    }

    pub fn acquire(self: &Arc<Self>, account: &str) -> Result<ConnectionGuard, QuotaError> {
        let total = self.total_active.fetch_add(1, Ordering::SeqCst) + 1;
        if total > self.limits.max_total_connections as u64 {
            self.total_active.fetch_sub(1, Ordering::SeqCst);
            return Err(QuotaError::RelayFull);
        }

        // Two details here, both about races.
        //
        // The count is incremented while the map entry is still locked, not
        // after the clone escapes. `drain_usage` evicts idle accounts under the
        // same lock, and the gap between "cloned the Arc" and "claimed a slot"
        // would otherwise be a window in which an account looks idle and is
        // dropped from the map — sending this connection's bytes to a counter
        // nothing will ever read.
        //
        // And the slot number is the one `fetch_add` returned, not a later
        // load. Two callers racing would otherwise both read the higher count
        // and both refuse, turning a limit of one into a limit of none.
        let (usage, active) = {
            let entry = self
                .accounts
                .entry(account.to_string())
                .or_insert_with(|| Arc::new(AccountUsage::default()));
            let active = entry.active.fetch_add(1, Ordering::SeqCst) + 1;
            (entry.clone(), active)
        };

        if active > self.limits.max_connections_per_account as u64 {
            usage.active.fetch_sub(1, Ordering::SeqCst);
            self.total_active.fetch_sub(1, Ordering::SeqCst);
            return Err(QuotaError::TooManyConnections {
                limit: self.limits.max_connections_per_account,
            });
        }

        Ok(ConnectionGuard {
            quotas: self.clone(),
            account: account.to_string(),
            usage,
        })
    }

    pub fn active_total(&self) -> u64 {
        self.total_active.load(Ordering::Relaxed)
    }

    /// How many accounts the map is holding. Only the eviction tests care, and
    /// they care a lot: the assertion that this does not grow forever is the
    /// only thing standing between a long-lived relay and a slow leak.
    #[cfg(test)]
    pub(crate) fn tracked_accounts(&self) -> usize {
        self.accounts.len()
    }

    /// Takes everything counted since the last call and resets the counters.
    ///
    /// Destructive on purpose: the reporter that calls this owns the batch from
    /// here on, and a batch that fails to post is dropped rather than added
    /// back. Re-queueing would risk double counting on a timeout that actually
    /// landed, and over-counting an abuse control is worse than under-counting
    /// it — see the comment in `reporter.rs`.
    ///
    /// Holds a shard lock only for the length of a swap and never across an
    /// await, so a connection being accepted on another task waits nanoseconds
    /// at worst.
    pub fn drain_usage(&self) -> Vec<AccountBytes> {
        let mut batch = Vec::new();
        for entry in self.accounts.iter() {
            let usage = entry.value();
            let bytes_up = usage.bytes_up.swap(0, Ordering::Relaxed);
            let bytes_down = usage.bytes_down.swap(0, Ordering::Relaxed);
            if bytes_up != 0 || bytes_down != 0 {
                batch.push(AccountBytes {
                    account: entry.key().clone(),
                    bytes_up,
                    bytes_down,
                });
            }
        }

        // Evict accounts with nothing running and nothing owed. Without this the
        // map is a slow leak on a long-lived process: anonymous subjects are a
        // cookie that rotates daily, so every visitor would leave a permanent
        // entry behind. Anything with a live connection, or with bytes that
        // arrived since the swap above, is kept.
        self.accounts.retain(|_, usage| {
            usage.active.load(Ordering::SeqCst) != 0
                || usage.bytes_up.load(Ordering::Relaxed) != 0
                || usage.bytes_down.load(Ordering::Relaxed) != 0
        });

        batch
    }
}

impl ConnectionGuard {
    /// A handle the copy loops can hold without owning the slot.
    pub fn counter(&self) -> UsageCounter {
        UsageCounter {
            usage: self.usage.clone(),
        }
    }

    pub fn account(&self) -> &str {
        &self.account
    }
}

impl UsageCounter {
    /// Relaxed, and on the hot path by design.
    ///
    /// This is one uncontended atomic add per forwarded frame — a few
    /// nanoseconds against a syscall and a network hop. Relaxed ordering is
    /// correct here because nothing is synchronised through these counters:
    /// the only reader is `drain_usage`, which wants a recent total, not a
    /// consistent snapshot of anything else.
    pub fn add_up(&self, bytes: u64) {
        self.usage.bytes_up.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn add_down(&self, bytes: u64) {
        self.usage.bytes_down.fetch_add(bytes, Ordering::Relaxed);
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.usage.active.fetch_sub(1, Ordering::SeqCst);
        self.quotas.total_active.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug, thiserror::Error)]
pub enum QuotaError {
    #[error("relay at capacity")]
    RelayFull,
    #[error("too many concurrent connections (limit {limit})")]
    TooManyConnections { limit: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_the_per_account_limit() {
        let q = Quotas::new(Limits {
            max_connections_per_account: 2,
            max_total_connections: 100,
        });
        let _a = q.acquire("u1").unwrap();
        let _b = q.acquire("u1").unwrap();
        assert!(q.acquire("u1").is_err());
        // A different account is unaffected.
        assert!(q.acquire("u2").is_ok());
    }

    #[test]
    fn releases_slots_on_drop() {
        let q = Quotas::new(Limits {
            max_connections_per_account: 1,
            max_total_connections: 100,
        });
        {
            let _a = q.acquire("u1").unwrap();
            assert!(q.acquire("u1").is_err());
        }
        // Bind the guard: `q.acquire(..).is_ok()` would drop it immediately and
        // the count would read zero for the wrong reason.
        let reacquired = q.acquire("u1");
        assert!(reacquired.is_ok(), "the slot should be freed on drop");
        assert_eq!(q.active_total(), 1);
    }

    #[test]
    fn a_rejected_acquire_does_not_consume_a_global_slot() {
        let q = Quotas::new(Limits {
            max_connections_per_account: 1,
            max_total_connections: 10,
        });
        let _a = q.acquire("u1").unwrap();
        assert!(q.acquire("u1").is_err());
        assert_eq!(q.active_total(), 1, "the failed attempt must not leak");
    }

    fn quotas() -> Arc<Quotas> {
        Quotas::new(Limits::default())
    }

    /// Sorted, because a DashMap iterates in shard order and the test is about
    /// the numbers, not the layout.
    fn drained(q: &Quotas) -> Vec<AccountBytes> {
        let mut batch = q.drain_usage();
        batch.sort_by(|a, b| a.account.cmp(&b.account));
        batch
    }

    #[test]
    fn accumulates_bytes_per_account_in_both_directions() {
        let q = quotas();
        let a = q.acquire("u1").unwrap();
        let b = q.acquire("u2").unwrap();

        a.counter().add_up(100);
        a.counter().add_down(900);
        // A second connection on the same account adds to the same total: the
        // allowance is per account, not per session.
        let a2 = q.acquire("u1").unwrap();
        a2.counter().add_up(1);
        b.counter().add_down(7);

        assert_eq!(
            drained(&q),
            vec![
                AccountBytes {
                    account: "u1".into(),
                    bytes_up: 101,
                    bytes_down: 900,
                },
                AccountBytes {
                    account: "u2".into(),
                    bytes_up: 0,
                    bytes_down: 7,
                },
            ],
        );
    }

    #[test]
    fn a_drain_resets_the_counters() {
        let q = quotas();
        let guard = q.acquire("u1").unwrap();
        guard.counter().add_up(500);

        assert_eq!(drained(&q).len(), 1);
        // The reporter owns that batch now. Draining again must not hand the
        // same bytes over a second time.
        assert!(drained(&q).is_empty(), "bytes must not be reported twice");

        guard.counter().add_down(3);
        assert_eq!(drained(&q).first().map(|e| e.bytes_down), Some(3));
    }

    #[test]
    fn a_drain_evicts_idle_accounts_but_keeps_live_ones() {
        let q = quotas();
        {
            let gone = q.acquire("finished").unwrap();
            gone.counter().add_up(10);
        }
        let live = q.acquire("running").unwrap();
        live.counter().add_up(10);

        assert_eq!(drained(&q).len(), 2, "both owe bytes on the first drain");

        // "finished" has no connection and nothing owed, so its entry goes; a
        // long-lived session must survive the eviction that keeps the map from
        // growing with every visitor.
        live.counter().add_up(5);
        assert_eq!(
            drained(&q),
            vec![AccountBytes {
                account: "running".into(),
                bytes_up: 5,
                bytes_down: 0,
            }],
        );
        assert_eq!(q.tracked_accounts(), 1, "the idle account should be evicted");
    }

    #[test]
    fn bytes_counted_after_the_connection_ends_are_still_reported() {
        // The guard holds the slot, the counter holds the numbers, and they are
        // dropped at different moments: the copy tasks can still be finishing
        // when the guard goes. Bytes written in that window belong to the next
        // drain, not to nobody.
        let q = quotas();
        let counter = {
            let guard = q.acquire("u1").unwrap();
            guard.counter()
        };
        counter.add_down(42);
        assert_eq!(drained(&q).first().map(|e| e.bytes_down), Some(42));
    }
}
