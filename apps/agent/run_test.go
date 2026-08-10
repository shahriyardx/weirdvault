package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A control connection that stops answering must end, not hang.
//
// This is the failure the agent could not see. The relay pings and has a writer,
// so it notices a dead path and drops the agent; this process only reads, so a
// connection that stopped existing without a FIN — an expired NAT mapping, a
// suspended laptop, a relay whose machine lost power — left it parked in a read
// forever. The dashboard said the machine was offline, the agent believed it was
// online, and only a restart fixed it.
//
// The fake relay below completes the handshake and then stops reading its
// socket, which is what a silently-dead peer looks like from here: the TCP
// connection is fine, nothing answers. coder/websocket only replies to pings
// while a read is in flight, so no pong ever comes back.

func testConfig(t *testing.T, url string) *identity {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = pub
	return &identity{
		name: "under-test",
		path: "/nonexistent/under-test.json",
		cfg: &Config{
			AgentID:      "agent-under-test",
			RelayURL:     url,
			AllowedPorts: []int{22},
		},
		priv: priv,
	}
}

/** Completes hello → challenge → proof → ready, then goes quiet. */
func silentRelay(t *testing.T, answerPings bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/control") {
			http.NotFound(w, r)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()

		// hello
		if _, _, err := conn.Read(ctx); err != nil {
			return
		}
		challenge, _ := json.Marshal(controlMessage{Type: "challenge", Nonce: "nonce"})
		if err := conn.Write(ctx, websocket.MessageText, challenge); err != nil {
			return
		}
		// proof
		if _, _, err := conn.Read(ctx); err != nil {
			return
		}
		ready, _ := json.Marshal(controlMessage{Type: "ready"})
		if err := conn.Write(ctx, websocket.MessageText, ready); err != nil {
			return
		}

		if answerPings {
			// Still reading, so the library answers pings. This is a healthy
			// relay with nothing to say.
			for {
				if _, _, err := conn.Read(ctx); err != nil {
					return
				}
			}
		}

		// Otherwise: alive at the TCP level, answering nothing.
		<-ctx.Done()
	}))
	t.Cleanup(srv.Close)
	return srv
}

func withFastPings(t *testing.T) {
	t.Helper()
	interval, timeout := controlPingInterval, controlPingTimeout
	controlPingInterval, controlPingTimeout = 100*time.Millisecond, 300*time.Millisecond
	t.Cleanup(func() { controlPingInterval, controlPingTimeout = interval, timeout })
}

func TestServeGivesUpOnARelayThatStopsAnswering(t *testing.T) {
	withFastPings(t)

	srv := silentRelay(t, false)
	id := testConfig(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/agent")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- serve(ctx, id) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("serve returned nil; it should report the connection as failed so the run loop reconnects")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve is still parked in its read: an unanswered ping did not end the connection")
	}
}

func TestServeStaysUpWhileTheRelayAnswers(t *testing.T) {
	// The other half. A ping loop that ends a healthy idle connection would be
	// worse than the hang it replaces — every agent would reconnect on a timer.
	withFastPings(t)

	srv := silentRelay(t, true)
	id := testConfig(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/agent")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- serve(ctx, id) }()

	// Ten ping intervals with nothing else happening on the connection.
	select {
	case err := <-done:
		t.Fatalf("serve ended an idle but healthy connection: %v", err)
	case <-time.After(time.Second):
	}
}

func TestCloseReasonFitsInAFrame(t *testing.T) {
	// RFC 6455 caps a close reason at 123 bytes, and an over-long or invalid
	// one is discarded by the peer — which puts the user back at a bare EOF,
	// the exact outcome these messages exist to avoid.
	long := strings.Repeat("this agent only forwards to some ports ", 20)
	got := closeReason(long)
	if len(got) > 123 {
		t.Fatalf("close reason is %d bytes, over the 123 the frame allows", len(got))
	}

	// A multi-byte rune straddling the cut must not leave invalid UTF-8.
	multibyte := strings.Repeat("é", 200)
	trimmed := closeReason(multibyte)
	if len(trimmed) > 123 {
		t.Fatalf("close reason is %d bytes, over the 123 the frame allows", len(trimmed))
	}
	if !utf8Valid(trimmed) {
		t.Fatalf("close reason is not valid UTF-8: %q", trimmed)
	}
}

func utf8Valid(s string) bool {
	for _, r := range s {
		if r == '�' {
			return false
		}
	}
	return true
}

func TestAllowedPortsAreTheOnlyOnesForwarded(t *testing.T) {
	// The boundary between "somebody can reach your SSH server" and "somebody
	// can reach anything bound to loopback on your machine".
	cfg := &Config{AllowedPorts: []int{22, 2200}}
	for _, port := range []int{22, 2200} {
		if !cfg.allows(port) {
			t.Errorf("port %d should be allowed", port)
		}
	}
	for _, port := range []int{0, 21, 23, 5432, 6379, 8080} {
		if cfg.allows(port) {
			t.Errorf("port %d must not be forwarded", port)
		}
	}
}
