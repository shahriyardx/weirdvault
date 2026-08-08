//go:build js && wasm

// Command ssh is the webxterm browser SSH core.
//
// It compiles to WASM and runs entirely inside the tab. It speaks real SSH to
// an unmodified sshd, over a WebSocket that the relay forwards to TCP as
// opaque bytes. Private keys never enter this program: authentication is
// delegated to a non-extractable WebCrypto key via webCryptoSigner.
package main

import (
	"fmt"
	"net"
	"syscall/js"
	"time"

	"golang.org/x/crypto/ssh"
)

func main() {
	js.Global().Set("webxtermSSH", js.ValueOf(map[string]any{
		"connect": js.FuncOf(connect),
		"version": "phase0",
	}))
	select {} // keep the runtime alive for callbacks
}

// connect returns a Promise resolving to a session handle.
//
// config: {
//   relay:     string       ws:// URL of the relay, already carrying host/port
//   host, port                 for the SSH host key check + logging
//   user:      string
//   auth:      { kind: "publickey", keyType, publicKey: Uint8Array, sign: fn }
//            | { kind: "password",  password: string }
//   cols, rows: number
//   onData:    (Uint8Array) => void
//   onStatus:  ({phase, detail, ms}) => void
//   onHostKey: ({fingerprint, type}) => void
//   onClose:   (reason: string) => void
// }
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

	clientCfg := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{auth},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			// Phase 0: trust on first use, but surface the fingerprint so the
			// harness can show it. Production must persist and pin this, and
			// refuse loudly on change.
			if onHost.Type() == js.TypeFunction {
				onHost.Invoke(js.ValueOf(map[string]any{
					"fingerprint": ssh.FingerprintSHA256(key),
					"type":        key.Type(),
				}))
			}
			return nil
		},
	}

	tHS := time.Now()
	addr := net.JoinHostPort(host, fmt.Sprint(port))
	sshConn, chans, reqs, err := ssh.NewClientConn(conn, addr, clientCfg)
	if err != nil {
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

	var handleFuncs []js.Func
	cleanup := func(reason string) {
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
	handleFuncs = []js.Func{write, resize, closeFn}

	return js.ValueOf(map[string]any{
		"write":  write,
		"resize": resize,
		"close":  closeFn,
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
