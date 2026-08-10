package main

/*
What the running daemon is doing, in a file the CLI can read.

Before this, every question the CLI answered was inferred from the process
table: is a `weirdvault-agent run` running, since when, with which --config.
That worked while a process meant an identity. It stopped working the moment one
process serves four of them — `list` could see the daemon and nothing inside it.

So the daemon writes what it knows. Not a socket: a file survives the reader
arriving at any moment, needs no protocol, and cannot fail in a way that hangs
`weirdvault-agent status`. It is regenerated from live state on every change, so
a stale file is impossible while the daemon runs, and it is removed on a clean
shutdown. A file left behind by a killed process is detected by its pid no
longer existing rather than by trusting its contents.

It lives under /run, which is a tmpfs on every system that has it: it does not
survive a reboot, which is exactly right for a description of what is running.
*/

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

/*
Where the state file goes.

`RuntimeDirectory=weirdvault-agent` in the unit creates /run/weirdvault-agent
owned by the service account, so the daemon can write it without being able to
write anywhere else in /run. An agent run by hand as an ordinary user cannot,
which is not an error — the CLI falls back to the process table, exactly as it
did before this file existed.
*/
const (
	defaultStateDir = "/run/weirdvault-agent"

	// Overrides it, for an agent running as somebody who cannot write to /run.
	// Read by the daemon and the CLI alike, so a hand-run pair sees one view —
	// set it for one and not the other and `list` simply falls back to what it
	// could see before this file existed.
	stateDirVar = "WEIRDVAULT_AGENT_RUNTIME_DIR"

	// How long after a change the file is rewritten. Coalesces the burst of
	// transitions that a relay restart produces across every identity into one
	// write, while staying far below the interval anybody polls at.
	stateWriteDelay = 200 * time.Millisecond
)

func stateDirPath() string {
	if dir := os.Getenv(stateDirVar); dir != "" {
		return dir
	}
	return defaultStateDir
}

func stateFilePath() string { return filepath.Join(stateDirPath(), "state.json") }

// identitySnapshot is one identity as the CLI sees it.
type identitySnapshot struct {
	Name      string `json:"name"`
	Config    string `json:"config"`
	AgentID   string `json:"agentId"`
	State     string `json:"state"`
	Since     string `json:"since"`
	Sessions  int    `json:"sessions"`
	LastError string `json:"lastError,omitempty"`
	Ports     []int  `json:"allowedPorts"`
}

// runtimeState is the whole file.
type runtimeState struct {
	PID        int                `json:"pid"`
	Version    string             `json:"version"`
	StartedAt  string             `json:"startedAt"`
	Identities []identitySnapshot `json:"identities"`
}

var processStarted = time.Now()

/*
writeStateUntil rewrites the file whenever something changes, until the context
ends.

Debounced rather than written per change: an identity going online moves state
twice in as many milliseconds, and a reader polling this file wants the settled
answer rather than every intermediate one.
*/
func (s *supervisor) writeStateUntil(ctx context.Context) {
	// Written once up front so the file exists before anything connects — a CLI
	// run in the same second as the daemon should not fall back to the process
	// table and report less than the daemon already knows.
	s.writeState()

	for {
		select {
		case <-ctx.Done():
			return
		case <-s.dirty:
			// Let the rest of a burst arrive before writing.
			select {
			case <-ctx.Done():
				return
			case <-time.After(stateWriteDelay):
			}
			s.writeState()
		}
	}
}

func (s *supervisor) writeState() {
	state := runtimeState{
		PID:        os.Getpid(),
		Version:    version,
		StartedAt:  processStarted.UTC().Format(time.RFC3339),
		Identities: s.snapshot(),
	}

	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	raw = append(raw, '\n')

	dir := stateDirPath()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return // not ours to create; the CLI falls back to the process table
	}

	// Temp file and rename, so a reader never sees half a document. Written
	// beside the target because rename is only atomic within one filesystem.
	tmp, err := os.CreateTemp(dir, ".state-*")
	if err != nil {
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeds

	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	// World readable on purpose: `weirdvault-agent list` is useful to whoever
	// administers the machine, and nothing here is a secret — ids and states,
	// no keys. The config files remain 0600.
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmpName, stateFilePath())
}

func removeStateFile() {
	_ = os.Remove(stateFilePath())
}

/*
readRuntimeState is the CLI's side.

Returns nil when there is no daemon to describe — no file, an unreadable one, or
one left behind by a process that is gone. The last of those is why the pid is
in the file: a killed daemon cannot clean up after itself, and a state file
describing four online identities that stopped existing an hour ago is worse
than no file at all.
*/
func readRuntimeState() *runtimeState {
	raw, err := os.ReadFile(stateFilePath())
	if err != nil {
		return nil
	}

	var state runtimeState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil
	}
	if state.PID <= 0 || !processAlive(state.PID) {
		return nil
	}
	return &state
}

// processAlive reports whether a pid still exists.
//
// Signal 0 performs the permission and existence checks and delivers nothing,
// which is the portable way to ask. EPERM means it exists and belongs to
// somebody else — still alive, which is the question.
func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// stoppedMarkerFor is the path whose existence means "do not run this identity".
//
// A sibling file rather than a field inside the config, because the config holds
// a private key and expressing "off" should never involve rewriting it.
func stoppedMarkerFor(configPath string) string {
	return strings.TrimSuffix(configPath, ".json") + ".stopped"
}

func stoppedMarkerExists(configPath string) bool {
	_, err := os.Stat(stoppedMarkerFor(configPath))
	return err == nil
}

// identityNameFor is how a config path is referred to on the command line.
func identityNameFor(configPath string) string {
	return strings.TrimSuffix(filepath.Base(configPath), ".json")
}

// configPathFor turns an identity name back into a path in the config directory.
func configPathFor(dir, name string) string {
	return filepath.Join(dir, name+".json")
}

// describeSessions renders the count the way a refusal will read it.
func describeSessions(n int) string {
	if n == 1 {
		return "1 session"
	}
	return fmt.Sprintf("%d sessions", n)
}
