package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

/*
The supervisor, against a relay that behaves.

These are the behaviours a shared machine depends on and that no unit test of a
pure function can reach: that a second person enrolling does not disturb the
first, that stopping one identity leaves the others connected, and — the one
that would be a fleet-wide outage if it regressed — that a revoked identity
takes only itself down.
*/

// acceptingRelay completes the handshake for any agent and then stays quiet,
// answering pings so the connection is treated as healthy.
func acceptingRelay(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()

	var mu sync.Mutex
	var seen []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/control") {
			http.NotFound(w, r)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx := r.Context()

		var hello controlMessage
		if err := readJSON(ctx, conn, &hello); err != nil {
			return
		}
		mu.Lock()
		seen = append(seen, hello.AgentID)
		mu.Unlock()

		challenge, _ := json.Marshal(controlMessage{Type: "challenge", Nonce: "bm9uY2U="})
		if err := conn.Write(ctx, websocket.MessageText, challenge); err != nil {
			return
		}
		var proof controlMessage
		if err := readJSON(ctx, conn, &proof); err != nil {
			return
		}
		ready, _ := json.Marshal(controlMessage{Type: "ready"})
		if err := conn.Write(ctx, websocket.MessageText, ready); err != nil {
			return
		}

		// Held open, reading, so the library answers pings.
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)

	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), seen...)
	}
}

// rejectingRelay refuses one named agent the way a revoke does, and accepts
// every other.
func rejectingRelay(t *testing.T, refuse string) *httptest.Server {
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
		defer conn.CloseNow()
		ctx := r.Context()

		var hello controlMessage
		if err := readJSON(ctx, conn, &hello); err != nil {
			return
		}
		if hello.AgentID == refuse {
			conn.Close(statusAgentRejected, "this agent has been revoked")
			return
		}

		challenge, _ := json.Marshal(controlMessage{Type: "challenge", Nonce: "bm9uY2U="})
		if err := conn.Write(ctx, websocket.MessageText, challenge); err != nil {
			return
		}
		var proof controlMessage
		if err := readJSON(ctx, conn, &proof); err != nil {
			return
		}
		ready, _ := json.Marshal(controlMessage{Type: "ready"})
		if err := conn.Write(ctx, websocket.MessageText, ready); err != nil {
			return
		}
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// writeIdentity puts one config in the directory, the way enrolment does.
func writeIdentity(t *testing.T, dir, name, agentID, relayURL string) string {
	t.Helper()

	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &Config{
		AgentID:      agentID,
		PrivateKey:   base64.StdEncoding.EncodeToString(priv.Seed()),
		RelayURL:     relayURL,
		AllowedPorts: []int{22},
	}
	path := filepath.Join(dir, name+".json")
	if err := saveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	return path
}

func relayURLFor(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/agent"
}

// waitFor polls until the condition holds, or fails the test.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (s *supervisor) stateOf(name string) identityState {
	s.mu.Lock()
	id := s.live[name]
	s.mu.Unlock()
	if id == nil {
		return ""
	}
	id.mu.Lock()
	defer id.mu.Unlock()
	return id.state
}

func (s *supervisor) isRunning(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.running[name]
	return ok
}

// A second person enrolling must not disturb the first.
//
// This is why the directory is polled rather than read once: if picking up a new
// identity needed a restart, then one person joining would drop everybody else's
// sessions — and the daemon refuses a restart while a session is live, so it
// would be refusing on behalf of the very people it was about to disconnect.
func TestASecondIdentityStartsWithoutDisturbingTheFirst(t *testing.T) {
	srv, seen := acceptingRelay(t)
	dir := t.TempDir()
	writeIdentity(t, dir, "aaaa1111", "agent-a", relayURLFor(srv))

	sup := newSupervisor(dir, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = sup.run(ctx) }()

	waitFor(t, "the first identity to come online", func() bool {
		return sup.stateOf("aaaa1111") == stateOnline
	})

	writeIdentity(t, dir, "bbbb2222", "agent-b", relayURLFor(srv))

	waitFor(t, "the second identity to come online", func() bool {
		return sup.stateOf("bbbb2222") == stateOnline
	})

	// The first one never went anywhere.
	if got := sup.stateOf("aaaa1111"); got != stateOnline {
		t.Fatalf("the first identity is %q after a second was enrolled; it should not have been touched", got)
	}
	if ids := seen(); len(ids) != 2 {
		t.Fatalf("relay saw %v; expected one connection per identity", ids)
	}
}

// Stopping one identity leaves the others alone, which is the whole point of
// `stop <id>` existing beside `stop`.
func TestStoppingOneIdentityLeavesTheOthers(t *testing.T) {
	srv, _ := acceptingRelay(t)
	dir := t.TempDir()
	pathA := writeIdentity(t, dir, "aaaa1111", "agent-a", relayURLFor(srv))
	writeIdentity(t, dir, "bbbb2222", "agent-b", relayURLFor(srv))

	sup := newSupervisor(dir, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = sup.run(ctx) }()

	waitFor(t, "both identities online", func() bool {
		return sup.stateOf("aaaa1111") == stateOnline && sup.stateOf("bbbb2222") == stateOnline
	})

	if err := os.WriteFile(stoppedMarkerFor(pathA), []byte("stopped\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	waitFor(t, "the marked identity to stop", func() bool { return !sup.isRunning("aaaa1111") })

	if !sup.isRunning("bbbb2222") {
		t.Fatal("stopping one identity stopped another; they are supposed to be independent")
	}

	// And it comes back when the marker goes.
	if err := os.Remove(stoppedMarkerFor(pathA)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the identity to start again", func() bool {
		return sup.stateOf("aaaa1111") == stateOnline
	})
}

// A revoked identity takes only itself down.
//
// Before the supervisor this was `exit 3` for the whole process, which is
// correct on a machine serving one account and a fleet-wide outage on a machine
// serving four.
func TestARevokedIdentityDoesNotTakeTheOthersWithIt(t *testing.T) {
	srv := rejectingRelay(t, "agent-a")
	dir := t.TempDir()
	writeIdentity(t, dir, "aaaa1111", "agent-a", relayURLFor(srv))
	writeIdentity(t, dir, "bbbb2222", "agent-b", relayURLFor(srv))

	sup := newSupervisor(dir, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- sup.run(ctx) }()

	waitFor(t, "the refused identity to give up", func() bool {
		return sup.stateOf("aaaa1111") == stateRejected
	})
	waitFor(t, "the accepted identity to be online", func() bool {
		return sup.stateOf("bbbb2222") == stateOnline
	})

	select {
	case err := <-done:
		t.Fatalf("the whole daemon exited (%v) because one identity was revoked", err)
	case <-time.After(500 * time.Millisecond):
	}

	if sup.isRunning("aaaa1111") {
		t.Fatal("the refused identity is still retrying; a rejection is settled and must not be retried")
	}
}

// The single-identity contract, unchanged: a revoked agent that is the only one
// on the machine exits with the code systemd's RestartPreventExitStatus reads.
func TestALoneRevokedIdentityStillExitsRejected(t *testing.T) {
	srv := rejectingRelay(t, "agent-a")
	dir := t.TempDir()
	writeIdentity(t, dir, "aaaa1111", "agent-a", relayURLFor(srv))

	sup := newSupervisor(dir, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- sup.run(ctx) }()

	select {
	case err := <-done:
		if err != errRejected {
			t.Fatalf("got %v, want errRejected so the supervisor stops restarting it", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("a lone revoked identity did not end the process")
	}
}

// A file that cannot be read must not stop the identities beside it.
func TestAnUnreadableConfigDoesNotStopTheOthers(t *testing.T) {
	srv, _ := acceptingRelay(t)
	dir := t.TempDir()
	writeIdentity(t, dir, "aaaa1111", "agent-a", relayURLFor(srv))
	if err := os.WriteFile(filepath.Join(dir, "broken.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	sup := newSupervisor(dir, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = sup.run(ctx) }()

	waitFor(t, "the readable identity to come online", func() bool {
		return sup.stateOf("aaaa1111") == stateOnline
	})
	if sup.isRunning("broken") {
		t.Fatal("an unparseable config was started")
	}
}
