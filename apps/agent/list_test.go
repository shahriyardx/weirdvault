package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

/*
Not being allowed to look is not the same as there being nothing there.

/etc/weirdvault is 0700 and owned by the service account, so every one of these
commands run without sudo hits EACCES on the directory. Swallowing that produced
"No agent is enrolled on this machine" on a machine that plainly had one — a
confident wrong answer, and the kind somebody acts on by enrolling a second
identity they did not need.
*/
func TestUnreadableDirectoryIsNotAnEmptyOne(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read anything, which is the case this is about not being")
	}
	if runtime.GOOS == "windows" {
		t.Skip("no POSIX modes")
	}

	// Isolated from the machine running the test: it may well have a live daemon
	// and a personal identity, both of which gatherIdentities is supposed to
	// find, and neither of which this is about.
	t.Setenv(stateDirVar, t.TempDir())
	t.Setenv("HOME", t.TempDir())

	dir := filepath.Join(t.TempDir(), "identities")
	if err := os.Mkdir(dir, 0o000); err != nil {
		t.Fatal(err)
	}

	rows, denied := gatherIdentities(dir, "")
	if !denied {
		t.Error("a directory that could not be read was reported as readable")
	}
	if len(rows) != 0 {
		t.Errorf("got %d rows from a directory nothing could be read from", len(rows))
	}
}

// The two states that must not be confused with it: a directory that is really
// empty, and one that was never created.
func TestEmptyAndMissingDirectoriesAreNotDenied(t *testing.T) {
	t.Setenv(stateDirVar, t.TempDir())
	t.Setenv("HOME", t.TempDir())

	empty := t.TempDir()
	if rows, denied := gatherIdentities(empty, ""); denied || len(rows) != 0 {
		t.Errorf("empty directory: rows=%d denied=%v, want 0 and false", len(rows), denied)
	}

	missing := filepath.Join(t.TempDir(), "never-created")
	if rows, denied := gatherIdentities(missing, ""); denied || len(rows) != 0 {
		t.Errorf("missing directory: rows=%d denied=%v, want 0 and false", len(rows), denied)
	}
}

// The runtime state file is world-readable on purpose, so an unprivileged caller
// still learns what is running even when the identities are unreadable. That is
// most of what `list` is for.
func TestRuntimeStateIsReadableWithoutTheIdentities(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read anything")
	}

	t.Setenv(stateDirVar, t.TempDir())
	t.Setenv("HOME", t.TempDir())

	sup := newSupervisor(t.TempDir(), "")
	sup.live["aaaa1111"] = &identity{
		name:  "aaaa1111",
		path:  "/etc/weirdvault/aaaa1111.json",
		cfg:   &Config{AgentID: "agent-a", AllowedPorts: []int{22}},
		state: stateOnline,
	}
	sup.writeState()

	unreadable := filepath.Join(t.TempDir(), "identities")
	if err := os.Mkdir(unreadable, 0o000); err != nil {
		t.Fatal(err)
	}

	rows, denied := gatherIdentities(unreadable, "")
	if !denied {
		t.Fatal("expected the directory to be reported unreadable")
	}
	if len(rows) != 1 || rows[0].name != "aaaa1111" {
		t.Fatalf("the running identity should still be listed from the state file, got %+v", rows)
	}
	if rows[0].live == nil || rows[0].live.State != string(stateOnline) {
		t.Error("the state file's answer about what is running was lost")
	}
}
