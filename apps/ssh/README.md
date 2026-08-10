# apps/ssh — the SSH client, compiled to WebAssembly

Go SSH and SFTP client that runs **inside the browser tab**. It is the reason
weirdvault can claim end-to-end encryption: the handshake, cipher negotiation and
every byte of session traffic are handled here, in page memory, so the relay
only ever forwards ciphertext.

The load-bearing file is `signer.go`. `webCryptoSigner` implements
`ssh.AlgorithmSigner` while holding **no key material at all** — it owns a
JavaScript callback, hands the auth challenge out to WebCrypto, and gets a
signature back. That is what lets a non-extractable key authenticate to a stock
OpenSSH server.

This is a library, not a program you run. It compiles to `ssh.wasm`, which
`apps/web` serves from `/public`.

## Build

Only builds for `js/wasm` — every file is behind `//go:build js && wasm`, so a
plain `go build` on your machine finds no `main` and says so.

```bash
bun run wasm          # from the repo root: builds here, writes into apps/web/public
```

That wrapper exists for two reasons: it copies `wasm_exec.js` out of `GOROOT`
(it ships with the toolchain and must match the compiler that produced the
module), and it fails the build if the compressed binary exceeds 4 MB.

The equivalent by hand:

```bash
cd apps/ssh
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o ../web/public/ssh.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" ../web/public/wasm_exec.js
```

## Test

The parsing code is deliberately free of build tags so it can be tested on the
host — key formats and `ssh_config` are where the fiddly bugs live.

```bash
cd apps/ssh && go test ./...      # 23 tests, no browser needed
GOOS=js GOARCH=wasm go vet ./...  # vet the parts that only exist in the browser
```

Everything else — the handshake, PTY, SFTP — needs a browser and a real server.
There is no automated coverage of it; check those by hand against a server you
control, over the network, on port 22.

## Dependencies

`go mod tidy` **must** be run with the build tags set, or it will not see the
imports and will strip them:

```bash
GOOS=js GOARCH=wasm go mod tidy
```
