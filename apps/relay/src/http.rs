//! A very small HTTP client for talking to the control plane.
//!
//! Two callers need it — the usage reporter and agent authentication — and both
//! make the same shaped request: one POST of JSON to a neighbour on a private
//! network, authenticated with a bearer secret, no keep-alive, no redirects, no
//! chunked encoding. Pulling in a real HTTP client for that would add more code
//! to audit than the thing it replaces, on the process that faces the internet.
//!
//! ## Plain HTTP only
//!
//! The relay has no TLS stack, and `Endpoint::parse` refuses `https://` loudly
//! rather than appearing to encrypt. In every deployment shape we ship the
//! control plane is a neighbour on the compose network. If yours is across the
//! public internet, put a terminator beside the relay and point the URL at it —
//! the bearer secret in these requests is worth protecting.

use std::time::Duration;

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// A response body larger than this is a control plane misbehaving. Both
/// endpoints answer with a few hundred bytes of JSON.
const MAX_BODY: usize = 64 * 1024;

/// Where a request goes, already split into the pieces a request line needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub path: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("{0} must start with http:// (the relay has no TLS stack; see http.rs)")]
    NotHttp(&'static str),
    #[error("{0} has no host")]
    NoHost(&'static str),
    #[error("{0} has an unparseable port")]
    BadPort(&'static str),
    #[error("{0} must not contain control characters")]
    UnsafeSecret(&'static str),
}

impl Endpoint {
    /// A deliberately small URL parser: one scheme, one shape.
    ///
    /// `var` names the environment variable being parsed so a failure at boot
    /// says which one to go and fix, rather than describing a URL the operator
    /// then has to locate.
    pub fn parse(var: &'static str, url: &str) -> Result<Self, ConfigError> {
        let rest = url
            .strip_prefix("http://")
            .ok_or(ConfigError::NotHttp(var))?;
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        if authority.is_empty() {
            return Err(ConfigError::NoHost(var));
        }

        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (h, p.parse::<u16>().map_err(|_| ConfigError::BadPort(var))?),
            None => (authority, 80),
        };
        if host.is_empty() {
            return Err(ConfigError::NoHost(var));
        }

        Ok(Self {
            host: host.to_string(),
            port,
            path: path.to_string(),
        })
    }

    fn authority(&self) -> String {
        if self.port == 80 {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// Rejects a secret that could inject headers into the requests below.
///
/// It comes from the operator rather than from a user, so this is a typo guard
/// rather than a defence — but a header-splitting bug is not something to leave
/// to a typo.
pub fn check_secret(var: &'static str, secret: &str) -> Result<(), ConfigError> {
    if secret.chars().any(|c| c.is_control()) {
        return Err(ConfigError::UnsafeSecret(var));
    }
    Ok(())
}

/// One request, one connection, no pool.
///
/// Returns the status and the body. The reporter ignores the body; agent
/// authentication reads a decision out of it.
pub async fn post_json(
    endpoint: &Endpoint,
    secret: &str,
    body: &str,
) -> std::io::Result<(u16, String)> {
    let mut stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timed out"))??;

    let request = build_request(endpoint, secret, body);
    tokio::time::timeout(IO_TIMEOUT, stream.write_all(request.as_bytes()))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "write timed out"))??;

    // Read to EOF rather than honouring Content-Length. The request says
    // `Connection: close`, so the server closes when it is done, and a parser
    // that trusted a length header would hang on a response that lacked one.
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = tokio::time::timeout(IO_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "read timed out"))??;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_BODY {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "response too large",
            ));
        }
    }

    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = parse_status(&buf)?;
    Ok((status, extract_body(&text)))
}

/// Pulls the body out of a response, decoding chunked framing if it is there.
///
/// This is not theoretical tidiness. Next.js answers with
/// `Transfer-Encoding: chunked` for anything it has not buffered, so the raw
/// bytes on the socket are `25\r\n{"ok":false,…}\r\n0\r\n\r\n` — and handing
/// that to a JSON parser produces "invalid type: integer 37", which is 0x25,
/// the chunk length, read as the start of a number. The usage reporter never
/// noticed because it only ever read the status line; agent verification reads
/// a decision out of the body, so it did, immediately.
///
/// Only the framing is handled — no trailers, no compression, no keep-alive.
/// The request says `Connection: close` and advertises nothing, so a server that
/// sent either of the other two would be answering a request nobody made.
fn extract_body(response: &str) -> String {
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return String::new();
    };

    let chunked = head
        .lines()
        .any(|line| {
            let mut parts = line.splitn(2, ':');
            matches!(parts.next(), Some(name) if name.eq_ignore_ascii_case("transfer-encoding"))
                && parts.next().is_some_and(|v| v.to_ascii_lowercase().contains("chunked"))
        });

    if !chunked {
        return body.to_string();
    }

    let mut out = String::new();
    let mut rest = body;
    while let Some((size_line, after)) = rest.split_once("\r\n") {
        // A chunk size may carry extensions after a semicolon; nobody sends them
        // here, but ignoring them is one `split` and misparsing one is a hang.
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_hex, 16) else {
            break;
        };
        // Zero ends the body. A chunk longer than what arrived means the
        // response was cut off, and stopping is the only safe move — the caller
        // gets a short body and fails to parse it, which for agent verification
        // means refusing the agent.
        if size == 0 || after.len() < size {
            break;
        }
        out.push_str(&after[..size]);
        // Skip the chunk and its trailing CRLF.
        rest = after.get(size + 2..).unwrap_or("");
    }
    out
}

pub fn build_request(endpoint: &Endpoint, secret: &str, body: &str) -> String {
    format!(
        "POST {path} HTTP/1.1\r\n\
         Host: {authority}\r\n\
         Authorization: Bearer {secret}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        path = endpoint.path,
        authority = endpoint.authority(),
        len = body.len(),
    )
}

pub fn parse_status(head: &[u8]) -> std::io::Result<u16> {
    let text = String::from_utf8_lossy(head);
    let line = text.lines().next().unwrap_or_default();
    line.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "no HTTP status line in the response",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VAR: &str = "RELAY_USAGE_URL";

    #[test]
    fn parses_a_url_with_an_explicit_port_and_path() {
        assert_eq!(
            Endpoint::parse(VAR, "http://web:3000/api/relay/usage").unwrap(),
            Endpoint {
                host: "web".into(),
                port: 3000,
                path: "/api/relay/usage".into(),
            }
        );
    }

    #[test]
    fn defaults_the_port_and_the_path() {
        assert_eq!(
            Endpoint::parse(VAR, "http://control.internal").unwrap(),
            Endpoint {
                host: "control.internal".into(),
                port: 80,
                path: "/".into(),
            }
        );
    }

    #[test]
    fn refuses_https_rather_than_pretending_to_encrypt() {
        assert_eq!(
            Endpoint::parse(VAR, "https://web/api").unwrap_err(),
            ConfigError::NotHttp(VAR)
        );
    }

    #[test]
    fn refuses_urls_it_cannot_honour() {
        assert_eq!(
            Endpoint::parse(VAR, "http://").unwrap_err(),
            ConfigError::NoHost(VAR)
        );
        assert_eq!(
            Endpoint::parse(VAR, "web:3000").unwrap_err(),
            ConfigError::NotHttp(VAR)
        );
        assert_eq!(
            Endpoint::parse(VAR, "http://web:notaport/x").unwrap_err(),
            ConfigError::BadPort(VAR)
        );
    }

    #[test]
    fn names_the_variable_it_could_not_parse() {
        // Two callers now parse two different variables through this. An error
        // that said only "must start with http://" would send an operator to
        // the wrong line of their .env.
        let err = Endpoint::parse("RELAY_AGENT_VERIFY_URL", "https://x/y").unwrap_err();
        assert!(err.to_string().contains("RELAY_AGENT_VERIFY_URL"));
    }

    #[test]
    fn omits_the_default_port_from_the_host_header() {
        let ep = Endpoint::parse(VAR, "http://control.internal/ingest").unwrap();
        assert!(build_request(&ep, "s3cret", "{}").contains("Host: control.internal\r\n"));

        let ep = Endpoint::parse(VAR, "http://web:3000/ingest").unwrap();
        assert!(build_request(&ep, "s3cret", "{}").contains("Host: web:3000\r\n"));
    }

    #[test]
    fn refuses_a_secret_that_could_split_the_request() {
        assert!(check_secret("X", "fine").is_ok());
        assert_eq!(
            check_secret("X", "bad\r\nX-Injected: 1").unwrap_err(),
            ConfigError::UnsafeSecret("X")
        );
    }

    #[test]
    fn reads_the_status_code_off_the_response() {
        assert_eq!(parse_status(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap(), 204);
        assert_eq!(parse_status(b"HTTP/1.1 401 Unauthorized\r\n").unwrap(), 401);
        assert!(parse_status(b"").is_err());
        assert!(parse_status(b"garbage\r\n").is_err());
    }

    #[test]
    fn reads_a_plain_body() {
        assert_eq!(
            extract_body("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{\"ok\":1}"),
            "{\"ok\":1}"
        );
    }

    #[test]
    fn decodes_a_chunked_body() {
        // The real failure this was written for: Next.js answers chunked, and
        // the chunk length read as JSON is "invalid type: integer 37" — 0x25.
        let payload = "{\"ok\":false,\"error\":\"signature bad\"}";
        // Built from the payload's real length rather than a pasted constant.
        // The first version of this test hard-coded a wrong one and failed for a
        // reason that had nothing to do with the decoder.
        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/json\r\n\
             Transfer-Encoding: chunked\r\n\
             \r\n\
             {:x}\r\n{payload}\r\n0\r\n\r\n",
            payload.len()
        );
        assert_eq!(extract_body(&response), payload);
    }

    #[test]
    fn reassembles_a_body_split_across_chunks() {
        let response =
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"ok\"\r\n6\r\n:true}\r\n0\r\n\r\n";
        assert_eq!(extract_body(response), "{\"ok\":true}");
    }

    #[test]
    fn a_truncated_chunked_body_stops_rather_than_looping() {
        // A response cut off mid-chunk must end the loop, not spin on a slice it
        // cannot take. The caller sees a short body and fails to parse it, which
        // for agent verification means refusing the agent.
        let response = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nff\r\nshort";
        assert_eq!(extract_body(response), "");

        let garbage = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nnope\r\n";
        assert_eq!(extract_body(garbage), "");
    }

    #[test]
    fn the_header_match_is_case_insensitive() {
        // Header names are case-insensitive on the wire and servers differ.
        // Missing this would mean silently returning chunk framing as the body.
        let response = "HTTP/1.1 200 OK\r\ntransfer-encoding: Chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n";
        assert_eq!(extract_body(response), "hi");
    }

    #[tokio::test]
    async fn returns_the_body_as_well_as_the_status() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut scratch = [0u8; 1024];
            let _ = sock.read(&mut scratch).await;
            sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}",
            )
            .await
            .unwrap();
        });

        let ep = Endpoint {
            host: "127.0.0.1".into(),
            port: addr.port(),
            path: "/verify".into(),
        };
        let (status, body) = post_json(&ep, "s3cret", "{}").await.unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, "{\"ok\":true}");
    }
}
