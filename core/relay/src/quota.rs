//! Per-account limits.
//!
//! Kept in process memory rather than a shared store: the relay is stateless by
//! design, and a user who spreads connections across several relay instances
//! still hits the limit on each. Approximate enforcement of an abuse control is
//! the right trade for keeping the data path free of a network round trip.

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

        let usage = self
            .accounts
            .entry(account.to_string())
            .or_insert_with(|| Arc::new(AccountUsage::default()))
            .clone();

        let active = usage.active.fetch_add(1, Ordering::SeqCst) + 1;
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
}

impl ConnectionGuard {
    pub fn record(&self, up: u64, down: u64) {
        self.usage.bytes_up.fetch_add(up, Ordering::Relaxed);
        self.usage.bytes_down.fetch_add(down, Ordering::Relaxed);
    }

    pub fn account(&self) -> &str {
        &self.account
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
}
