//! Destination vetting.
//!
//! An authenticated WebSocket-to-TCP bridge will dial whatever it is told to.
//! Without these checks it is an SSRF engine pointed at our own infrastructure,
//! and the single most valuable target is the cloud metadata endpoint — one
//! request away from IAM credentials.
//!
//! The rule is: resolve first, reject if *any* answer is disallowed, then dial
//! the exact address that was vetted. Re-resolving before the connect would
//! reopen a DNS-rebinding window between check and use.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use thiserror::Error;
use tokio::net::lookup_host;

#[derive(Debug, Error)]
pub enum VetError {
    #[error("could not resolve {host}: {source}")]
    Resolve {
        host: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{host} resolved to no addresses")]
    NoAddresses { host: String },
    #[error("destination {ip} is not permitted ({reason})")]
    Forbidden { ip: IpAddr, reason: &'static str },
}

/// Resolves `host` and returns the first address, provided every answer passes.
///
/// Rejecting the whole hostname when any answer is disallowed stops a record
/// that mixes a public and a private address from sneaking the private one
/// through on a later lookup.
pub async fn resolve_and_vet(
    host: &str,
    port: u16,
    allow_private: bool,
) -> Result<IpAddr, VetError> {
    let addrs: Vec<_> = lookup_host((host, port))
        .await
        .map_err(|source| VetError::Resolve {
            host: host.to_string(),
            source,
        })?
        .collect();

    if addrs.is_empty() {
        return Err(VetError::NoAddresses {
            host: host.to_string(),
        });
    }

    for addr in &addrs {
        if let Some(reason) = disallowed(addr.ip(), allow_private) {
            return Err(VetError::Forbidden {
                ip: addr.ip(),
                reason,
            });
        }
    }

    Ok(addrs[0].ip())
}

/// Returns why an address is refused, or `None` if it is acceptable.
pub fn disallowed(ip: IpAddr, allow_private: bool) -> Option<&'static str> {
    // Metadata endpoints are checked before the escape hatch: even in local
    // development there is no legitimate reason to relay to one.
    if is_cloud_metadata(ip) {
        return Some("cloud metadata endpoint");
    }
    if allow_private {
        return None;
    }

    match ip {
        IpAddr::V4(v4) => disallowed_v4(v4),
        IpAddr::V6(v6) => disallowed_v6(v6),
    }
}

fn disallowed_v4(ip: Ipv4Addr) -> Option<&'static str> {
    let o = ip.octets();
    if ip.is_loopback() {
        Some("loopback")
    } else if ip.is_private() {
        Some("RFC1918 private")
    } else if ip.is_link_local() {
        Some("link-local")
    } else if ip.is_broadcast() {
        Some("broadcast")
    } else if ip.is_multicast() {
        Some("multicast")
    } else if ip.is_unspecified() {
        Some("unspecified")
    } else if o[0] == 100 && (o[1] & 0xc0) == 64 {
        Some("CGNAT 100.64.0.0/10")
    } else if o[0] == 0 {
        Some("this-network 0.0.0.0/8")
    } else if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        Some("IETF protocol assignments")
    } else if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        Some("benchmarking 198.18.0.0/15")
    } else if o[0] >= 240 {
        Some("reserved 240.0.0.0/4")
    } else {
        None
    }
}

fn disallowed_v6(ip: Ipv6Addr) -> Option<&'static str> {
    let s = ip.segments();

    // An IPv4-mapped address must be judged by its IPv4 rules, or ::ffff:127.0.0.1
    // walks straight past every check above.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return disallowed_v4(v4);
    }

    if ip.is_loopback() {
        Some("loopback")
    } else if ip.is_unspecified() {
        Some("unspecified")
    } else if ip.is_multicast() {
        Some("multicast")
    } else if (s[0] & 0xfe00) == 0xfc00 {
        Some("unique local fc00::/7")
    } else if (s[0] & 0xffc0) == 0xfe80 {
        Some("link-local fe80::/10")
    } else {
        None
    }
}

fn is_cloud_metadata(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4 == Ipv4Addr::new(169, 254, 169, 254),
        IpAddr::V6(v6) => {
            // AWS IMDSv6, and the IPv4-mapped form of the v4 endpoint.
            v6 == Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254)
                || v6.to_ipv4_mapped() == Some(Ipv4Addr::new(169, 254, 169, 254))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn rejects_metadata_even_when_private_is_allowed() {
        assert!(disallowed(ip("169.254.169.254"), true).is_some());
        assert!(disallowed(ip("fd00:ec2::254"), true).is_some());
        assert!(disallowed(ip("::ffff:169.254.169.254"), true).is_some());
    }

    #[test]
    fn rejects_internal_ranges() {
        for a in [
            "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1",
            "169.254.1.1", "100.64.0.1", "0.0.0.0", "240.0.0.1",
            "::1", "fc00::1", "fe80::1",
        ] {
            assert!(disallowed(ip(a), false).is_some(), "{a} should be refused");
        }
    }

    #[test]
    fn ipv4_mapped_addresses_use_ipv4_rules() {
        // The check that a naive implementation misses.
        assert!(disallowed(ip("::ffff:127.0.0.1"), false).is_some());
        assert!(disallowed(ip("::ffff:10.0.0.1"), false).is_some());
    }

    #[test]
    fn allows_public_addresses() {
        for a in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(disallowed(ip(a), false).is_none(), "{a} should be allowed");
        }
    }

    #[test]
    fn private_is_permitted_under_the_dev_override() {
        assert!(disallowed(ip("127.0.0.1"), true).is_none());
        assert!(disallowed(ip("10.0.0.1"), true).is_none());
    }
}
