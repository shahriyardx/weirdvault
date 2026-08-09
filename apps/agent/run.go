package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"unicode/utf8"
	"time"

	"github.com/coder/websocket"
)

const (
	// Frames carry SSH ciphertext, and the relay reads its TCP side in 64 KiB
	// chunks. The library's 32 KiB default would tear down the connection the
	// first time somebody moved a file.
	readLimit = 1 << 20

	dialTimeout    = 15 * time.Second
	localTimeout   = 10 * time.Second
	handshakeLimit = 20 * time.Second

	backoffMin = 1 * time.Second
	backoffMax = 60 * time.Second

	// The relay's "you are not an agent this deployment will accept" — revoked,
	// deleted, or never enrolled. In the application range RFC 6455 reserves, so
	// it cannot collide with a protocol code the library sends on its own.
	//
	// Must match AGENT_REJECTED in apps/relay/src/agent.rs.
	statusAgentRejected = 4001

	// Exit code for that case, distinct so a supervisor can tell "this will
	// never work" from "the network was down". The systemd unit written by
	// install.sh carries RestartPreventExitStatus for exactly this.
	exitRejected = 3
)

// errRejected ends the run loop instead of retrying.
//
// A revoked agent that reconnects every few seconds forever is a machine
// burning power to be told "no" until somebody happens to read a log — and it
// fills that log with an error that looks like an outage but is a decision.
// Only the relay knows which it is, so it says so in the close code and this
// acts on it.
var errRejected = errors.New("rejected")

type controlMessage struct {
	Type      string `json:"type"`
	Nonce     string `json:"nonce"`
	Ticket    string `json:"ticket"`
	Port      int    `json:"port"`
	Reason    string `json:"reason"`
	AgentID   string `json:"agentId,omitempty"`
	Signature string `json:"signature,omitempty"`
}

func runAgent(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	configPath := fs.String("config", DefaultConfigPath, "path to the agent identity")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	priv, err := cfg.privateKey()
	if err != nil {
		return err
	}

	// SIGTERM is what systemd sends; without it the service is killed outright
	// and every session it is carrying dies mid-byte instead of closing.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.SetFlags(0) // journald stamps its own timestamps
	log.Printf("webxterm-agent %s starting: agent=%s relay=%s", version, cfg.AgentID, cfg.RelayURL)

	backoff := backoffMin
	for ctx.Err() == nil {
		start := time.Now()
		err := serve(ctx, cfg, priv)

		if ctx.Err() != nil {
			break
		}
		if err != nil {
			if websocket.CloseStatus(err) == statusAgentRejected {
				log.Printf("")
				log.Printf("This machine is no longer accepted: %s", closeText(err))
				log.Printf("")
				log.Printf("It was most likely revoked from the dashboard. Reconnecting cannot")
				log.Printf("undo that, so the agent is stopping rather than retrying forever.")
				log.Printf("")
				log.Printf("To use this machine again, enrol it afresh:")
				log.Printf("  1. Dashboard -> Machines -> Add a machine")
				log.Printf("  2. rm %s", *configPath)
				log.Printf("  3. run the install command it gives you")
				return errRejected
			}
			log.Printf("connection ended: %v", err)
		}

		// A connection that lasted a while was working, so the next failure
		// should retry promptly rather than inheriting the backoff from
		// whatever went wrong hours ago.
		if time.Since(start) > 2*time.Minute {
			backoff = backoffMin
		}

		wait := jitter(backoff)
		log.Printf("reconnecting in %s", wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}

		backoff *= 2
		if backoff > backoffMax {
			backoff = backoffMax
		}
	}

	log.Printf("shutting down")
	return nil
}

// serve holds one control connection until it dies.
func serve(ctx context.Context, cfg *Config, priv ed25519.PrivateKey) error {
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	conn, _, err := websocket.Dial(dialCtx, cfg.controlURL(), nil)
	if err != nil {
		return fmt.Errorf("could not reach the relay: %w", err)
	}
	conn.SetReadLimit(readLimit)
	defer conn.CloseNow()

	handshakeCtx, cancelHandshake := context.WithTimeout(ctx, handshakeLimit)
	defer cancelHandshake()
	if err := authenticate(handshakeCtx, conn, cfg, priv); err != nil {
		return err
	}
	log.Printf("online")

	for {
		var msg controlMessage
		if err := readJSON(ctx, conn, &msg); err != nil {
			return err
		}

		switch msg.Type {
		case "open":
			// Deliberately not awaited. A machine can carry several sessions at
			// once, and a dial to a wedged local port must not stop the control
			// connection from answering the next request.
			go func(ticket string, port int) {
				if err := openStream(ctx, cfg, ticket, port); err != nil {
					log.Printf("stream for 127.0.0.1:%d failed: %v", port, err)
				}
			}(msg.Ticket, msg.Port)
		default:
			log.Printf("ignoring unknown control message %q", msg.Type)
		}
	}
}

// authenticate proves this process holds the key the account enrolled.
func authenticate(ctx context.Context, conn *websocket.Conn, cfg *Config, priv ed25519.PrivateKey) error {
	hello, err := json.Marshal(controlMessage{Type: "hello", AgentID: cfg.AgentID})
	if err != nil {
		return err
	}
	if err := conn.Write(ctx, websocket.MessageText, hello); err != nil {
		return fmt.Errorf("could not send hello: %w", err)
	}

	var challenge controlMessage
	if err := readJSON(ctx, conn, &challenge); err != nil {
		return fmt.Errorf("no challenge from the relay: %w", err)
	}
	if challenge.Type != "challenge" || challenge.Nonce == "" {
		return fmt.Errorf("expected a challenge, got %q", challenge.Type)
	}

	sig := ed25519.Sign(priv, signingMessage(cfg.AgentID, challenge.Nonce))
	proof, err := json.Marshal(controlMessage{
		Type:      "proof",
		Signature: base64.StdEncoding.EncodeToString(sig),
	})
	if err != nil {
		return err
	}
	if err := conn.Write(ctx, websocket.MessageText, proof); err != nil {
		return fmt.Errorf("could not send proof: %w", err)
	}

	var ready controlMessage
	if err := readJSON(ctx, conn, &ready); err != nil {
		// The relay closes with a reason when it refuses, and that reason is the
		// only thing that distinguishes "revoked in the dashboard" from "the
		// control plane is down" — both of which otherwise look like a socket
		// that closed.
		return fmt.Errorf("the relay refused this agent: %w", err)
	}
	if ready.Type != "ready" {
		return fmt.Errorf("expected ready, got %q %s", ready.Type, ready.Reason)
	}
	return nil
}

// openStream answers one open request: dial sshd, dial back, splice.
func openStream(ctx context.Context, cfg *Config, ticket string, port int) error {
	if ticket == "" {
		return fmt.Errorf("open request carried no ticket")
	}

	streamURL, err := url.Parse(cfg.streamURL())
	if err != nil {
		return err
	}
	q := streamURL.Query()
	q.Set("ticket", ticket)
	streamURL.RawQuery = q.Encode()

	// The ticket is claimed *before* the local dial, and the order is the whole
	// point. Failing locally without dialling back leaves the browser waiting on
	// a rendezvous nobody will keep, so the user learns that sshd is not running
	// as "the agent did not answer in time" — fifteen seconds later, blaming the
	// wrong component. Claiming first means a refusal is a close frame carrying
	// the real reason, which the relay forwards and the browser prints.
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, streamURL.String(), nil)
	if err != nil {
		return fmt.Errorf("could not dial back: %w", err)
	}
	conn.SetReadLimit(readLimit)
	defer conn.CloseNow()

	// The relay asks for a port and the relay got that port from the browser.
	// This is the boundary that keeps an agent from being a way into everything
	// else listening on loopback; see Config.allows.
	if !cfg.allows(port) {
		reason := fmt.Sprintf("this agent only forwards to %v, not %d", cfg.AllowedPorts, port)
		conn.Close(websocket.StatusPolicyViolation, closeReason(reason))
		return fmt.Errorf("refused: %s", reason)
	}

	local, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), localTimeout)
	if err != nil {
		// The overwhelmingly common cause is that there is no SSH server
		// listening on that machine at all — Remote Login switched off on macOS,
		// sshd not installed, or bound to a different port. Saying which port was
		// tried is what turns this from a mystery into a one-line fix.
		reason := fmt.Sprintf("nothing is listening on 127.0.0.1:%d — is sshd running?", port)
		conn.Close(websocket.StatusInternalError, closeReason(reason))
		return fmt.Errorf("could not reach sshd: %w", err)
	}
	defer local.Close()

	if tcp, ok := local.(*net.TCPConn); ok {
		tcp.SetNoDelay(true) // interactive typing must not wait on Nagle
	}

	splice(ctx, conn, local)
	return nil
}

// RFC 6455 caps a close reason at 123 bytes. Over that and the frame is
// invalid, the peer discards the reason, and the user is back to a bare EOF.
func closeReason(s string) string {
	const max = 123
	if len(s) <= max {
		return s
	}
	// Trimmed on a rune boundary: invalid UTF-8 is discarded just like an
	// over-long reason.
	trimmed := s[:max-3]
	for len(trimmed) > 0 && !utf8.ValidString(trimmed) {
		trimmed = trimmed[:len(trimmed)-1]
	}
	return trimmed + "..."
}

// splice copies between the relay socket and sshd until either end stops.
func splice(ctx context.Context, conn *websocket.Conn, local net.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	done := make(chan struct{}, 2)

	// Relay to sshd.
	go func() {
		defer func() { done <- struct{}{} }()
		for {
			typ, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			// Text on a stream socket is not something this protocol produces.
			// Writing it to sshd would corrupt the session in a way that
			// surfaces as a decryption failure much later.
			if typ != websocket.MessageBinary {
				continue
			}
			if _, err := local.Write(data); err != nil {
				return
			}
		}
	}()

	// sshd to relay.
	go func() {
		defer func() { done <- struct{}{} }()
		buf := make([]byte, 32<<10)
		for {
			n, err := local.Read(buf)
			if n > 0 {
				if err := conn.Write(ctx, websocket.MessageBinary, buf[:n]); err != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// One half ending means the session is over; cancelling unblocks the other,
	// which would otherwise sit in a read that nothing will ever satisfy.
	select {
	case <-done:
	case <-ctx.Done():
	}
	cancel()
	local.Close()
	conn.Close(websocket.StatusNormalClosure, "")
}

func readJSON(ctx context.Context, conn *websocket.Conn, out *controlMessage) error {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		return json.Unmarshal(data, out)
	}
}

// closeText pulls the relay's own words out of a close error.
//
// The wrapped error stringifies as a sentence about readers and status codes,
// which is true and useless to somebody whose machine stopped working. The
// reason field is the part written for them.
func closeText(err error) string {
	var ce websocket.CloseError
	if errors.As(err, &ce) && ce.Reason != "" {
		return ce.Reason
	}
	return "no reason given"
}

// jitter spreads reconnects out.
//
// Without it, a relay restart brings every agent back simultaneously and each
// wave lands on the same second as the last — the fleet synchronises itself into
// a thundering herd that the backoff was supposed to prevent.
func jitter(d time.Duration) time.Duration {
	return d/2 + time.Duration(rand.Int63n(int64(d/2)+1))
}
