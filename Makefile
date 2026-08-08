.PHONY: sshd sshd-stop authorize wasm relay test-relay dev clean size verify

SSHD_NAME  := webxterm-sshd
SSHD_PORT  := 2222
WASM_OUT   := apps/web/public/ssh.wasm

## sshd: build and run the stock OpenSSH test target on :2222
sshd:
	docker build -q -t webxterm-sshd deploy/sshd
	-docker rm -f $(SSHD_NAME) 2>/dev/null
	docker run -d --name $(SSHD_NAME) -p $(SSHD_PORT):22 webxterm-sshd
	@echo "sshd up on localhost:$(SSHD_PORT) (user webxterm / password webxterm)"

sshd-stop:
	-docker rm -f $(SSHD_NAME)

## authorize KEY='ssh-ed25519 AAAA...': append a public key to the target's authorized_keys
authorize:
	@test -n "$(KEY)" || (echo "usage: make authorize KEY='ssh-ed25519 AAAA...'" && exit 1)
	docker exec $(SSHD_NAME) sh -c "echo '$(KEY)' >> /home/webxterm/.ssh/authorized_keys"
	@echo "authorized."

## wasm: build the Go SSH core into the app's public directory
## wasm_exec.js ships inside the Go toolchain and has to match the compiler that
## produced the module, so it is copied from GOROOT rather than vendored.
wasm:
	@mkdir -p apps/web/public
	GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o $(WASM_OUT) ./wasm/ssh
	@cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" apps/web/public/wasm_exec.js
	@$(MAKE) --no-print-directory size

## size: report the WASM bundle size against the Phase 0 gate (<4 MB Brotli)
size:
	@node scripts/size.mjs $(WASM_OUT)

## relay: run the production Rust relay on :8080 (dev mode allows loopback)
relay:
	RELAY_SECRET=$${RELAY_SECRET:-dev-relay-secret-change-me} \
	RELAY_ALLOW_PRIVATE=1 RELAY_PORTS=22,2222 RELAY_ADDR=127.0.0.1:8080 \
	cargo run --release -p webxterm-relay

## test-relay: unit tests for the SSRF guards, token format, and quotas
test-relay:
	cargo test -p webxterm-relay

## dev: sshd + wasm + relay
dev: sshd wasm relay

## verify: drive the app end to end (needs sshd, relay and `bun run dev` up)
verify:
	node scripts/phase2-verify.mjs
	node scripts/signedout-verify.mjs

clean:
	rm -f $(WASM_OUT) apps/web/public/wasm_exec.js
