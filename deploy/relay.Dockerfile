# The relay: a stateless WebSocket-to-TCP bridge.
#
# It forwards SSH ciphertext it cannot read, so it holds no secrets beyond the
# token-signing key and needs no persistence. That makes it cheap to run several
# of, close to users — relay latency is felt directly in typing.
#
# Build from the repo root:
#   docker build -f deploy/relay.Dockerfile -t webxterm-relay .

FROM rust:1-slim AS build
WORKDIR /src

# Cache dependency compilation separately from the source, so an edit to
# main.rs does not rebuild the whole dependency tree.
COPY Cargo.toml Cargo.lock ./
COPY crates/relay/Cargo.toml crates/relay/
RUN mkdir -p crates/relay/src \
 && echo 'fn main() {}' > crates/relay/src/main.rs \
 && cargo build --release -p webxterm-relay \
 && rm -rf crates/relay/src

COPY crates ./crates
# Touch so cargo rebuilds the real source rather than trusting the stub's mtime.
RUN touch crates/relay/src/main.rs && cargo build --release -p webxterm-relay

# Distroless: the relay opens sockets and nothing else. No shell means a
# compromised process has no shell to use.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/webxterm-relay /usr/local/bin/webxterm-relay

# Runs as nonroot (uid 65532) with no cloud IAM role attached — see
# docs/THREAT-MODEL.md §7.
USER nonroot
EXPOSE 8080
ENV RELAY_ADDR=0.0.0.0:8080

ENTRYPOINT ["/usr/local/bin/webxterm-relay"]
