.PHONY: sshd sshd-stop authorize wasm relay dev clean size verify

SSHD_NAME  := webxterm-sshd
SSHD_PORT  := 2222
WASM_OUT   := spike/web/ssh.wasm

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

## wasm: build the Go SSH core for the browser (spike harness + Next.js app)
wasm:
	GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o $(WASM_OUT) ./wasm/ssh
	@cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" spike/web/wasm_exec.js
	@mkdir -p apps/web/public
	@cp $(WASM_OUT) apps/web/public/ssh.wasm
	@cp spike/web/wasm_exec.js apps/web/public/wasm_exec.js
	@$(MAKE) --no-print-directory size

## size: report the WASM bundle size against the Phase 0 gate (<4 MB Brotli)
size:
	@node scripts/size.mjs $(WASM_OUT)

## relay: serve the harness and relay on :8080 (dev mode allows loopback)
relay:
	go run ./spike/relay -allow-private -ports 22,2222

## dev: sshd + wasm + relay
dev: sshd wasm relay

## verify: run the Phase 0 gates end to end (needs sshd + relay running)
verify:
	node scripts/phase0-verify.mjs

clean:
	rm -f $(WASM_OUT) spike/web/wasm_exec.js
