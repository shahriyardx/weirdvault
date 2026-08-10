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
    /// Set when the token authorises asking this relay a question rather than
    /// dialling anything.
    ///
    /// A third kind, kept apart from the two above by the same rule: a token
    /// carries one purpose, and each verify path refuses the others'. Presence
    /// answers "which of these agent ids are connected", which is a much
    /// smaller capability than opening a socket — but a token that could do
    /// both would mean the short-lived thing a browser holds to connect could
    /// also enumerate an account's machines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Unix seconds.
    pub exp: u64,
}

/// The only scope there is. Named rather than inlined so the two ends of the
/// comparison cannot drift apart in a rename.
pub const SCOPE_PRESENCE: &str = "presence";

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
    #[error("this token authorises a query, not a destination")]
    ScopedToken,
    #[error("this token authorises a destination, not a query")]
    DestinationToken,
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
    if claims.scope.is_some() {
        return Err(TokenError::ScopedToken);
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

    if claims.scope.is_some() {
        return Err(TokenError::ScopedToken);
    }
    match claims.agent.as_deref() {
        None => Err(TokenError::AddressToken),
        Some(want) if want != agent_id => Err(TokenError::WrongAgent),
        Some(_) => Ok(claims),
    }
}

/// Verifies a token that authorises asking about an account's agents.
///
/// Returns the account, which is the only thing the answer may be scoped to: a
/// presence query says which of *your* agents are connected, so an id you do
/// not own reads exactly like one that is offline. Without that, the endpoint
/// would confirm the existence of any agent id somebody could guess.
pub fn verify_presence(secret: &[u8], token: &str, now_unix: u64) -> Result<Claims, TokenError> {
    let claims = decode(secret, token, now_unix)?;

    match claims.scope.as_deref() {
        Some(SCOPE_PRESENCE) => Ok(claims),
        // A destination token must not become a query token. Both are minted by
        // the control plane, but the browser holds one of them.
        _ => Err(TokenError::DestinationToken),
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
            scope: None,
            exp: 2_000_000_000,
        }
    }

    fn presence_claims() -> Claims {
        Claims {
            sub: "user-1".into(),
            host: String::new(),
            port: 0,
            agent: None,
            scope: Some(SCOPE_PRESENCE.into()),
            exp: 2_000_000_000,
        }
    }

    fn agent_claims() -> Claims {
        Claims {
            sub: "user-1".into(),
            host: String::new(),
            port: 0,
            agent: Some("agent-7".into()),
            scope: None,
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

    #[test]
    fn a_presence_token_round_trips_and_carries_the_account() {
        let t = sign(SECRET, &presence_claims());
        let c = verify_presence(SECRET, &t, 1_000).unwrap();
        assert_eq!(c.sub, "user-1");
    }

    #[test]
    fn none_of_the_three_kinds_authorise_each_other() {
        // The rule the whole module rests on: a token carries one purpose. The
        // browser holds a destination token, and if that also answered presence
        // queries then anyone who could open one session could enumerate an
        // account's machines.
        let destination = sign(SECRET, &claims());
        let agent = sign(SECRET, &agent_claims());
        let presence = sign(SECRET, &presence_claims());

        assert!(matches!(
            verify_presence(SECRET, &destination, 1_000),
            Err(TokenError::DestinationToken)
        ));
        assert!(matches!(
            verify_presence(SECRET, &agent, 1_000),
            Err(TokenError::DestinationToken)
        ));
        assert!(matches!(
            verify(SECRET, &presence, "example.com", 22, 1_000),
            Err(TokenError::ScopedToken)
        ));
        assert!(matches!(
            verify_agent(SECRET, &presence, "agent-7", 1_000),
            Err(TokenError::ScopedToken)
        ));
    }

    #[test]
    fn a_presence_token_expires_like_any_other() {
        let t = sign(SECRET, &presence_claims());
        assert!(matches!(
            verify_presence(SECRET, &t, 2_000_000_001),
            Err(TokenError::Expired)
        ));
    }

    #[test]
    fn an_unknown_scope_is_not_presence() {
        // Refused rather than read as a destination token, so a scope added on
        // the control plane later cannot be silently accepted here as something
        // it is not.
        let mut c = presence_claims();
        c.scope = Some("something-else".into());
        let t = sign(SECRET, &c);
        assert!(matches!(
            verify_presence(SECRET, &t, 1_000),
            Err(TokenError::DestinationToken)
        ));
    }

    /// A token minted by the control plane's TypeScript, verified here.
    ///
    /// Nothing compiles both ends of this format. A round trip written in one
    /// language passes just as happily with both halves wrong in the same way,
    /// so this fixture was produced by `mintPresenceToken` in
    /// apps/web/src/lib/agents/presence.ts with the secret below, and is checked
    /// byte for byte by the implementation that has to read it in production.
    ///
    /// Regenerate it by running that function if the format is ever versioned.
    /// Do not hand-edit the signature, or the test proves nothing.
    #[test]
    fn verifies_a_token_the_control_plane_minted() {
        const FIXTURE: &str = "eyJzdWIiOiJ1c2VyLWZpeHR1cmUiLCJzY29wZSI6InByZXNlbmNlIiwiZXhwIjoxNzAwMDAwMTMwfQ.5YSIe08nn_uSq3AUskfN1FBPxEmcxIqtKvca8UonozQ";

        let claims = verify_presence(b"fixture-secret", FIXTURE, 1_700_000_000).unwrap();
        assert_eq!(claims.sub, "user-fixture");
        assert_eq!(claims.scope.as_deref(), Some(SCOPE_PRESENCE));
    }
}
