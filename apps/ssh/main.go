//go:build js && wasm

// Command ssh is the webxterm browser SSH core.
//
// It compiles to WASM and runs entirely inside the tab. It speaks real SSH to
// an unmodified sshd, over a WebSocket that the relay forwards to TCP as
// opaque bytes. Private keys never enter this program: authentication is
// delegated to a non-extractable WebCrypto key via webCryptoSigner.
package main

import (
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net"
	"sync"
	"syscall/js"
	"time"

	"golang.org/x/crypto/ssh"
)

func main() {
	js.Global().Set("webxtermSSH", js.ValueOf(map[string]any{
		"connect":        js.FuncOf(connect),
		"importKey":      js.FuncOf(importKeyJS),
		"parseSSHConfig": js.FuncOf(parseSSHConfigJS),
		"version":        "1",
	}))
	select {} // keep the runtime alive for callbacks
}

// connect returns a Promise resolving to a session handle.
//
//	config: {
//	  relay:     string       ws:// URL of the relay, already carrying host/port
//	  host, port                 for the SSH host key check + logging
//	  user:      string
//	  auth:      { kind: "publickey", keyType, publicKey: Uint8Array, sign: fn }
//	           | { kind: "password",  password: string }
//	  cols, rows: number
//	  onData:    (Uint8Array) => void
//	  onStatus:  ({phase, detail, ms}) => void
//	  onHostKey: ({fingerprint, type}) => void
//	  onClose:   (reason: string) => void
//	}
func connect(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeObject {
		return rejected("connect(config) requires a config object")
	}
	cfg := args[0]

	return newPromise(func(resolve, reject func(any)) {
		// Everything below runs off the JS event loop, which is what makes it
		// legal to block on promises inside the signer.
		go func() {
			handle, err := doConnect(cfg)
			if err != nil {
				reject(err.Error())
				return
			}
			resolve(handle)
		}()
	})
}

func doConnect(cfg js.Value) (js.Value, error) {
	var (
		relay    = cfg.Get("relay").String()
		user     = cfg.Get("user").String()
		host     = cfg.Get("host").String()
		port     = cfg.Get("port").Int()
		onData   = cfg.Get("onData")
		onStatus = cfg.Get("onStatus")
		onHost   = cfg.Get("onHostKey")
		onClose  = cfg.Get("onClose")
	)
	cols, rows := 80, 24
	if v := cfg.Get("cols"); v.Type() == js.TypeNumber {
		cols = v.Int()
	}
	if v := cfg.Get("rows"); v.Type() == js.TypeNumber {
		rows = v.Int()
	}

	status := func(phase, detail string, since time.Time) {
		if onStatus.Type() == js.TypeFunction {
			onStatus.Invoke(js.ValueOf(map[string]any{
				"phase":  phase,
				"detail": detail,
				"ms":     float64(time.Since(since).Microseconds()) / 1000,
			}))
		}
	}

	t0 := time.Now()

	auth, err := buildAuth(cfg.Get("auth"))
	if err != nil {
		return js.Undefined(), err
	}

	status("relay", relay, t0)
	tWS := time.Now()
	conn, err := dialWS(relay)
	if err != nil {
		return js.Undefined(), fmt.Errorf("relay: %w", err)
	}
	status("relay-open", "websocket established", tWS)

	// Host key pinning is what keeps the relay honest. The relay controls every
	// byte between us and the server, so without verifying the host key it
	// could present its own and MITM the session — the end-to-end encryption
	// would be end-to-*relay*. See docs/THREAT-MODEL.md §6.
	knownHostKey := ""
	if v := cfg.Get("knownHostKey"); v.Type() == js.TypeString {
		knownHostKey = v.String()
	}

	clientCfg := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{auth},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			presented := base64.StdEncoding.EncodeToString(key.Marshal())
			report := func(status string) {
				if onHost.Type() == js.TypeFunction {
					onHost.Invoke(js.ValueOf(map[string]any{
						"fingerprint": ssh.FingerprintSHA256(key),
						"type":        key.Type(),
						"key":         presented,
						"status":      status,
					}))
				}
			}

			if knownHostKey == "" {
				// First contact: report it so the caller can pin it. The caller
				// decides whether to trust; we cannot verify what we've never seen.
				report("unknown")
				return nil
			}
			if subtle.ConstantTimeCompare([]byte(presented), []byte(knownHostKey)) != 1 {
				report("mismatch")
				return fmt.Errorf(
					"HOST KEY MISMATCH for %s:%d — the server presented %s %s, "+
						"which is not the key pinned for this host. Someone may be "+
						"intercepting the connection, or the server was rebuilt. "+
						"Refusing to connect",
					host, port, key.Type(), ssh.FingerprintSHA256(key))
			}
			report("match")
			return nil
		},
	}

	tHS := time.Now()
	addr := net.JoinHostPort(host, fmt.Sprint(port))
	sshConn, chans, reqs, err := ssh.NewClientConn(conn, addr, clientCfg)
	if err != nil {
		// A relay that refused or could not reach the destination knows exactly
		// why; prefer its explanation over "handshake failed: EOF", which is
		// what the SSH layer reports when the stream simply ends.
		if reason := conn.CloseReason(); reason != nil {
			conn.Close()
			return js.Undefined(), reason
		}
		conn.Close()
		return js.Undefined(), fmt.Errorf("ssh handshake: %w", err)
	}
	client := ssh.NewClient(sshConn, chans, reqs)
	status("authenticated", user+"@"+addr, tHS)

	session, err := client.NewSession()
	if err != nil {
		client.Close()
		return js.Undefined(), fmt.Errorf("open session: %w", err)
	}

	session.Stdout = jsWriter{onData}
	session.Stderr = jsWriter{onData}
	stdin, err := session.StdinPipe()
	if err != nil {
		session.Close()
		client.Close()
		return js.Undefined(), fmt.Errorf("stdin pipe: %w", err)
	}

	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := session.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		session.Close()
		client.Close()
		return js.Undefined(), fmt.Errorf("request pty: %w", err)
	}
	if err := session.Shell(); err != nil {
		session.Close()
		client.Close()
		return js.Undefined(), fmt.Errorf("start shell: %w", err)
	}
	status("ready", "shell running", t0)

	// SFTP shares this SSH connection and opens lazily, so a shell-only session
	// never pays for the subsystem.
	var (
		sftpOnce   sync.Once
		sftpSess   *sftpSession
		sftpHandle js.Value
		sftpErr    error
	)

	var handleFuncs []js.Func
	cleanup := func(reason string) {
		if sftpSess != nil {
			sftpSess.close()
		}
		session.Close()
		client.Close()
		conn.Close()
		if onClose.Type() == js.TypeFunction {
			onClose.Invoke(reason)
		}
		for _, f := range handleFuncs {
			f.Release()
		}
	}

	go func() {
		err := session.Wait()
		reason := "session closed"
		if err != nil {
			reason = err.Error()
		}
		cleanup(reason)
	}()

	write := js.FuncOf(func(_ js.Value, a []js.Value) any {
		if len(a) == 0 {
			return nil
		}
		var b []byte
		if a[0].Type() == js.TypeString {
			b = []byte(a[0].String())
		} else {
			b = toGoBytes(a[0])
		}
		// Blocking write would stall the event loop; hand off to a goroutine.
		go stdin.Write(b)
		return nil
	})
	resize := js.FuncOf(func(_ js.Value, a []js.Value) any {
		if len(a) < 2 {
			return nil
		}
		c, r := a[0].Int(), a[1].Int()
		go session.WindowChange(r, c)
		return nil
	})
	closeFn := js.FuncOf(func(js.Value, []js.Value) any {
		go cleanup("closed by user")
		return nil
	})
	openSFTP := js.FuncOf(func(js.Value, []js.Value) any {
		return newPromise(func(resolve, reject func(any)) {
			go func() {
				sftpOnce.Do(func() {
					if sftpSess, sftpErr = newSFTP(client); sftpErr == nil {
						sftpHandle = sftpSess.handle()
					}
				})
				if sftpErr != nil {
					reject(sftpErr.Error())
					return
				}
				resolve(sftpHandle)
			}()
		})
	})
	// Promise-returning helper for the exec-backed features.
	promised := func(fn func(args []js.Value) (any, error)) js.Func {
		return js.FuncOf(func(_ js.Value, args []js.Value) any {
			return newPromise(func(resolve, reject func(any)) {
				go func() {
					v, err := fn(args)
					if err != nil {
						reject(err.Error())
						return
					}
					resolve(v)
				}()
			})
		})
	}

	installKeyFn := promised(func(args []js.Value) (any, error) {
		if len(args) < 1 || args[0].Type() != js.TypeString {
			return nil, fmt.Errorf("installKey(authorizedKeysLine) requires a string")
		}
		return installKey(client, args[0].String())
	})
	runFn := promised(func(args []js.Value) (any, error) {
		if len(args) < 1 || args[0].Type() != js.TypeString {
			return nil, fmt.Errorf("run(command) requires a string")
		}
		return runCommand(client, args[0].String())
	})
	uploadTarFn := promised(func(args []js.Value) (any, error) {
		if len(args) < 2 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeFunction {
			return nil, fmt.Errorf("uploadTar(remoteDir, next) requires a path and a callback")
		}
		return uploadTar(client, args[0].String(), args[1])
	})
	downloadTarFn := promised(func(args []js.Value) (any, error) {
		if len(args) < 2 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeFunction {
			return nil, fmt.Errorf("downloadTar(remotePath, onChunk) requires a path and a callback")
		}
		return downloadTar(client, args[0].String(), args[1])
	})

	handleFuncs = []js.Func{
		write, resize, closeFn, openSFTP,
		installKeyFn, runFn, uploadTarFn, downloadTarFn,
	}

	return js.ValueOf(map[string]any{
		"write":       write,
		"resize":      resize,
		"close":       closeFn,
		"sftp":        openSFTP,
		"installKey":  installKeyFn,
		"run":         runFn,
		"uploadTar":   uploadTarFn,
		"downloadTar": downloadTarFn,
	}), nil
}

func buildAuth(auth js.Value) (ssh.AuthMethod, error) {
	if auth.Type() != js.TypeObject {
		return nil, fmt.Errorf("auth config required")
	}
	switch kind := auth.Get("kind").String(); kind {
	case "publickey":
		signer, err := newWebCryptoSigner(
			auth.Get("keyType").String(),
			toGoBytes(auth.Get("publicKey")),
			auth.Get("sign"),
		)
		if err != nil {
			return nil, fmt.Errorf("signer: %w", err)
		}
		return ssh.PublicKeys(signer), nil

	case "password":
		pw := auth.Get("password").String()
		return ssh.Password(pw), nil

	default:
		return nil, fmt.Errorf("unsupported auth kind %q", kind)
	}
}

// jsWriter forwards terminal output to JS as Uint8Array, not string, so that
// multi-byte UTF-8 sequences split across reads stay intact — xterm.js
// reassembles them.
type jsWriter struct{ fn js.Value }

func (w jsWriter) Write(p []byte) (int, error) {
	if w.fn.Type() == js.TypeFunction && len(p) > 0 {
		w.fn.Invoke(toUint8Array(p))
	}
	return len(p), nil
}

func newPromise(fn func(resolve, reject func(any))) js.Value {
	executor := js.FuncOf(func(_ js.Value, a []js.Value) any {
		res, rej := a[0], a[1]
		fn(
			func(v any) { res.Invoke(v) },
			func(v any) { rej.Invoke(js.Global().Get("Error").New(v)) },
		)
		return nil
	})
	// The executor runs synchronously inside the Promise constructor, so it is
	// safe to release it as soon as New returns.
	defer executor.Release()
	return js.Global().Get("Promise").New(executor)
}

func rejected(msg string) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(msg))
}
