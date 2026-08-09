//! Relay access tokens.
//!
//! The relay must not be an open proxy, but it also must not need a database:
//! it is meant to be stateless and deployable at the edge. So the control
//! plane mints a short-lived HMAC-signed token naming the exact destination,
//! and the relay verifies it with a shared secret.
//!
//! Binding the token to `host:port` matters. A bearer token that merely proved
//! "this is a real user" would let any authenticated account use the relay as a
//! general-purpose TCP proxy to anywhere the SSRF rules permit.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// Account id, for quota accounting and logs.
    pub sub: String,
    /// The dialled destination. Empty on an agent token, which has no address.
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    /// Set when the destination is an agent rather than an address.
    ///
    /// A token carries one kind of destination or the other, never both, and
    /// the two verify paths each refuse the other's tokens. Without that, a
    /// token minted for a host the SSRF rules allow would also authorise
    /// reaching any agent whose id the holder could guess, and vice versa.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Unix seconds.
    pub exp: u64,
}

#[derive(Debug, Error)]
pub enum TokenError {
    #[error("malformed token")]
    Malformed,
    #[error("bad signature")]
    BadSignature,
    #[error("token expired")]
    Expired,
    #[error("token is for {want_host}:{want_port}, not {got_host}:{got_port}")]
    WrongDestination {
        want_host: String,
        want_port: u16,
        got_host: String,
        got_port: u16,
    },
    #[error("token is for a different agent")]
    WrongAgent,
    #[error("this token authorises an agent, not an address")]
    AgentToken,
    #[error("this token authorises an address, not an agent")]
    AddressToken,
}

/// Mints a token. The relay only ever verifies — the control plane issues them
/// (see apps/web/src/app/api/relay-token). Kept here as the executable
/// definition of the format, and used by the tests.
#[cfg_attr(not(test), allow(dead_code))]
pub fn sign(secret: &[u8], claims: &Claims) -> String {
    let payload = B64.encode(serde_json::to_vec(claims).expect("claims serialize"));
    let sig = mac(secret, payload.as_bytes());
    format!("{payload}.{}", B64.encode(sig))
}

/// Checks the signature and the expiry. Says nothing about the destination.
fn decode(secret: &[u8], token: &str, now_unix: u64) -> Result<Claims, TokenError> {
    let (payload, signature) = token.split_once('.').ok_or(TokenError::Malformed)?;

    let expected = mac(secret, payload.as_bytes());
    let provided = B64.decode(signature).map_err(|_| TokenError::Malformed)?;

    // Constant time: a fast-fail comparison here leaks the signature byte by byte.
    if expected.ct_eq(&provided).unwrap_u8() != 1 {
        return Err(TokenError::BadSignature);
    }

    let claims: Claims = serde_json::from_slice(
        &B64.decode(payload).map_err(|_| TokenError::Malformed)?,
    )
    .map_err(|_| TokenError::Malformed)?;

    if claims.exp <= now_unix {
        return Err(TokenError::Expired);
    }

    Ok(claims)
}

/// Verifies a token and checks it authorises this exact dialled destination.
pub fn verify(
    secret: &[u8],
    token: &str,
    host: &str,
    port: u16,
    now_unix: u64,
) -> Result<Claims, TokenError> {
    let claims = decode(secret, token, now_unix)?;

    // An agent token must not open an address, however well its host and port
    // happen to match. The two destinations are authorised by different checks
    // on the control plane and must not be interchangeable here.
    if claims.agent.is_some() {
        return Err(TokenError::AgentToken);
    }
    if claims.host != host || claims.port != port {
        return Err(TokenError::WrongDestination {
            want_host: claims.host,
            want_port: claims.port,
            got_host: host.to_string(),
            got_port: port,
        });
    }

    Ok(claims)
}

/// Verifies a token and checks it authorises this exact agent.
pub fn verify_agent(
    secret: &[u8],
    token: &str,
    agent_id: &str,
    now_unix: u64,
) -> Result<Claims, TokenError> {
    let claims = decode(secret, token, now_unix)?;

    match claims.agent.as_deref() {
        None => Err(TokenError::AddressToken),
        Some(want) if want != agent_id => Err(TokenError::WrongAgent),
        Some(_) => Ok(claims),
    }
}

fn mac(secret: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret";

    fn claims() -> Claims {
        Claims {
            sub: "user-1".into(),
            host: "example.com".into(),
            port: 22,
            agent: None,
            exp: 2_000_000_000,
        }
    }

    fn agent_claims() -> Claims {
        Claims {
            sub: "user-1".into(),
            host: String::new(),
            port: 0,
            agent: Some("agent-7".into()),
            exp: 2_000_000_000,
        }
    }

    #[test]
    fn round_trips() {
        let t = sign(SECRET, &claims());
        let c = verify(SECRET, &t, "example.com", 22, 1_000).unwrap();
        assert_eq!(c.sub, "user-1");
    }

    #[test]
    fn rejects_a_different_secret() {
        let t = sign(SECRET, &claims());
        assert!(matches!(
            verify(b"other", &t, "example.com", 22, 1_000),
            Err(TokenError::BadSignature)
        ));
    }

    #[test]
    fn rejects_expired() {
        let t = sign(SECRET, &claims());
        assert!(matches!(
            verify(SECRET, &t, "example.com", 22, 2_000_000_001),
            Err(TokenError::Expired)
        ));
    }

    #[test]
    fn refuses_to_authorise_a_different_destination() {
        // The property that stops a valid token being reused as a general proxy.
        let t = sign(SECRET, &claims());
        assert!(matches!(
            verify(SECRET, &t, "evil.example", 22, 1_000),
            Err(TokenError::WrongDestination { .. })
        ));
        assert!(matches!(
            verify(SECRET, &t, "example.com", 3306, 1_000),
            Err(TokenError::WrongDestination { .. })
        ));
    }

    #[test]
    fn an_agent_token_round_trips() {
        let t = sign(SECRET, &agent_claims());
        let c = verify_agent(SECRET, &t, "agent-7", 1_000).unwrap();
        assert_eq!(c.sub, "user-1");
        assert_eq!(c.agent.as_deref(), Some("agent-7"));
    }

    #[test]
    fn refuses_to_authorise_a_different_agent() {
        let t = sign(SECRET, &agent_claims());
        assert!(matches!(
            verify_agent(SECRET, &t, "agent-8", 1_000),
            Err(TokenError::WrongAgent)
        ));
    }

    #[test]
    fn the_two_destination_kinds_do_not_authorise_each_other() {
        // The property that keeps agents out of the SSRF-vetted address space
        // and addresses out of the agent registry. An address token that
        // happened to name the right host must still not reach an agent, and an
        // agent token must not be replayed as a dial to anywhere at all.
        let address = sign(SECRET, &claims());
        assert!(matches!(
            verify_agent(SECRET, &address, "agent-7", 1_000),
            Err(TokenError::AddressToken)
        ));

        let agent = sign(SECRET, &agent_claims());
        assert!(matches!(
            verify(SECRET, &agent, "", 0, 1_000),
            Err(TokenError::AgentToken)
        ));
    }

    #[test]
    fn an_expired_agent_token_is_refused_before_its_destination_is_read() {
        let t = sign(SECRET, &agent_claims());
        assert!(matches!(
            verify_agent(SECRET, &t, "agent-7", 2_000_000_001),
            Err(TokenError::Expired)
        ));
    }

    #[test]
    fn rejects_tampered_payload() {
        let t = sign(SECRET, &claims());
        let (_, sig) = t.split_once('.').unwrap();
        let forged = Claims { port: 3306, ..claims() };
        let payload = B64.encode(serde_json::to_vec(&forged).unwrap());
        assert!(matches!(
            verify(SECRET, &format!("{payload}.{sig}"), "example.com", 3306, 1_000),
            Err(TokenError::BadSignature)
        ));
    }
}
