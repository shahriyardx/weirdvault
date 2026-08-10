package main

/*
What is on this machine, and what each of it is doing.

One daemon can serve several identities, so the process table no longer answers
this: it can say a daemon is running and nothing about what is inside it. The
daemon publishes that in a runtime state file, and this reads it — falling back
to the older process-table view when there is no daemon to ask, which is exactly
the case where the older view was still right.

The two sources answer different questions and both are needed:

  the config directory   what is enrolled here, running or not
  the state file         what is connected, since when, carrying how much
*/

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"
)

// listing is one row: an identity on disk, and whatever the daemon says about it.
type listing struct {
	name    string
	path    string
	agentID string
	stopped bool
	live    *identitySnapshot
}

/*
gatherIdentities reads the directory, then annotates it with what is running.

Order matters. Disk is the authority on what exists — an identity the daemon has
not started yet is still enrolled — and the state file is the authority on what
is happening to it.
*/
func gatherIdentities(dir string, extra string) []listing {
	found := map[string]*listing{}

	add := func(path string) {
		if path == "" {
			return
		}
		name := identityNameFor(path)
		if _, ok := found[name]; ok {
			return
		}
		found[name] = &listing{
			name:    name,
			path:    path,
			agentID: agentIDAt(path),
			stopped: stoppedMarkerExists(path),
		}
	}

	entries, err := os.ReadDir(dir)
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			add(filepath.Join(dir, entry.Name()))
		}
	}
	add(extra)
	// Where somebody testing without root would have put one.
	if home, err := os.UserHomeDir(); err == nil {
		personal := filepath.Join(home, ".config", "weirdvault-agent", "agent.json")
		if fileExists(personal) {
			add(personal)
		}
	}

	if state := readRuntimeState(); state != nil {
		for i := range state.Identities {
			snap := state.Identities[i]
			// An identity the daemon is serving from outside the directory this
			// listing walked — a --config install, or a file removed while it was
			// running. It is running, so it belongs in the output.
			if _, ok := found[snap.Name]; !ok {
				add(snap.Config)
			}
			if row, ok := found[snap.Name]; ok {
				row.live = &state.Identities[i]
			}
		}
	}

	out := make([]listing, 0, len(found))
	for _, row := range found {
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func runList(args []string) error {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	dir := fs.String("config-dir", DefaultConfigDir, "where identities live")
	extra := fs.String("config", "", "also look at this config path")
	if err := fs.Parse(args); err != nil {
		return err
	}

	rows := gatherIdentities(*dir, *extra)
	state := readRuntimeState()
	st := currentState()

	if len(rows) == 0 {
		fmt.Println("No agent is enrolled on this machine.")
		fmt.Println("Enrol one from Dashboard → Machines → Add a machine.")
		return nil
	}

	out := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(out, "ID\tAGENT\tSTATE")
	for _, row := range rows {
		fmt.Fprintf(out, "%s\t%s\t%s\n", row.name, row.agentID, describeListing(row))
	}
	out.Flush()

	fmt.Println()
	if state == nil {
		// No daemon. Said plainly rather than leaving every row reading
		// "stopped" as though each had been stopped on purpose.
		fmt.Println("No agent process is running here.")
	} else {
		fmt.Printf("Daemon: pid %d, %s, %d identit%s\n",
			state.PID, state.Version, len(state.Identities), plural(len(state.Identities)))
	}

	switch {
	case st.Kind == supervisorNone:
		fmt.Println("Nothing here supervises the agent, so nothing restarts it or starts it at boot.")
	case !st.Installed:
		fmt.Printf("There is no %s service registered on this machine.\n", st.Kind)
	case st.Enabled:
		fmt.Println("The service starts at boot.")
	default:
		fmt.Println("The service will not start at boot (weirdvault-agent start changes that).")
	}

	// Only worth saying when it is true, and it is the thing that explains a
	// dashboard flickering between online and offline.
	if strays := strayProcesses(st); len(strays) > 0 && st.Installed {
		fmt.Printf("\n⚠ %d agent process(es) are running outside the service (pid %s).\n",
			len(strays), pidList(strays))
	}
	return nil
}

// describeListing is the one-line answer for a single identity.
func describeListing(row listing) string {
	if row.live == nil {
		if row.stopped {
			// Distinct from "not running": somebody decided this, and it will
			// stay decided across a reboot.
			return "stopped · will not start until `weirdvault-agent start " + row.name + "`"
		}
		return "not running"
	}

	parts := []string{row.live.State}
	if since, err := time.Parse(time.RFC3339, row.live.Since); err == nil {
		parts[0] = fmt.Sprintf("%s for %s", row.live.State, humanUptime(since))
	}
	if row.live.Sessions > 0 {
		parts = append(parts, describeSessions(row.live.Sessions))
	}
	if row.live.LastError != "" && row.live.State != string(stateOnline) {
		parts = append(parts, row.live.LastError)
	}
	return strings.Join(parts, " · ")
}

func plural(n int) string {
	if n == 1 {
		return "y"
	}
	return "ies"
}

/*
agentIDAt reads just the id out of a config, tolerating everything else.

Deliberately not loadConfig: this is a listing, and a config that is half-written
or from a future version should show up as a row with a caveat rather than
aborting the whole command. The common failure is not corruption at all — it is
a plain user running this without root against a file that is 0600 and owned by
the service account.
*/
func agentIDAt(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsPermission(err) {
			return "(need root to read)"
		}
		return "(no config)"
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.AgentID == "" {
		return "(unreadable)"
	}
	return cfg.AgentID
}

/*
resolveIdentity turns what somebody typed into exactly one identity.

A prefix is accepted because the names are short agent ids and nobody should
have to type sixteen hex characters to stop something. An ambiguous prefix is
refused rather than resolved to the first match: acting on the wrong person's
identity is not a mistake worth being convenient about.
*/
func resolveIdentity(dir, want string) (listing, error) {
	rows := gatherIdentities(dir, "")

	var matches []listing
	for _, row := range rows {
		if row.name == want {
			return row, nil // exact beats prefix, always
		}
		if strings.HasPrefix(row.name, want) || strings.HasPrefix(row.agentID, want) {
			matches = append(matches, row)
		}
	}

	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return listing{}, fmt.Errorf("no identity here matches %q. `weirdvault-agent list` shows them", want)
	default:
		names := make([]string, 0, len(matches))
		for _, row := range matches {
			names = append(names, row.name)
		}
		return listing{}, fmt.Errorf("%q matches %s — say which", want, strings.Join(names, ", "))
	}
}

// ---------------------------------------------------------------- one identity

/*
Stopping and starting one account's identity, without touching anybody else's.

A marker file beside the config, rather than a message to the daemon. Three
reasons, in order of how much they matter:

  - It survives. A reboot, a daemon restart, a kill -9 — the identity stays
    stopped, because "stopped" is a fact on disk rather than state in a process.
    That is what `stop` means everywhere else in this CLI and it should not mean
    something weaker here.
  - It needs no channel into the running process, and therefore no socket to
    secure, no protocol to version, and no way for the CLI to hang.
  - It never rewrites the config. That file holds a private key, and expressing
    "off" is not a good enough reason to touch it.

The cost is that it takes effect on the daemon's next directory read rather than
instantly, which is why both commands wait for the runtime state to agree rather
than printing success at a moment when it is not yet true.
*/

// How long to wait for the daemon to notice a marker, and how often to look.
const (
	identityWait = 15 * time.Second
	identityPoll = 250 * time.Millisecond
)

func stopIdentity(dir, want string) error {
	row, err := resolveIdentity(dir, want)
	if err != nil {
		return err
	}

	marker := stoppedMarkerFor(row.path)
	if err := os.WriteFile(marker, []byte("stopped by weirdvault-agent stop\n"), 0o644); err != nil {
		return sudoHint(fmt.Errorf("could not write %s: %w", marker, err), "stop "+row.name)
	}

	fmt.Printf("Stopping %s (%s)…\n", row.name, row.agentID)
	if !waitForIdentity(row.name, false) {
		// Not an error. The marker is written, so the daemon will act on it when
		// it next reads the directory — including if it is not running yet.
		fmt.Println("The daemon has not picked that up yet. It will within a few seconds.")
		return nil
	}

	fmt.Printf("Stopped. It stays stopped across reboots until: weirdvault-agent start %s\n", row.name)
	fmt.Println("Every other identity on this machine is untouched.")
	return nil
}

func startIdentity(dir, want string) error {
	row, err := resolveIdentity(dir, want)
	if err != nil {
		return err
	}

	marker := stoppedMarkerFor(row.path)
	if err := os.Remove(marker); err != nil && !os.IsNotExist(err) {
		return sudoHint(fmt.Errorf("could not remove %s: %w", marker, err), "start "+row.name)
	}

	// The daemon has to be running for this to mean anything. Saying so beats
	// reporting success for an identity that nothing will serve.
	if readRuntimeState() == nil {
		fmt.Printf("%s will run when the agent starts: weirdvault-agent start\n", row.name)
		return nil
	}

	fmt.Printf("Starting %s (%s)…\n", row.name, row.agentID)
	if !waitForIdentity(row.name, true) {
		fmt.Println("The daemon has not picked that up yet. It will within a few seconds.")
		return nil
	}

	fmt.Println("Started.")
	return nil
}

// waitForIdentity blocks until the daemon reports what was asked for, or gives
// up. Reports whether the state agreed in time.
func waitForIdentity(name string, wantRunning bool) bool {
	deadline := time.Now().Add(identityWait)
	for time.Now().Before(deadline) {
		state := readRuntimeState()
		if state == nil {
			// No daemon at all: nothing will contradict the marker.
			return !wantRunning
		}

		running := false
		for _, snap := range state.Identities {
			if snap.Name == name && snap.State != string(stateRejected) {
				running = true
				break
			}
		}
		if running == wantRunning {
			return true
		}
		time.Sleep(identityPoll)
	}
	return false
}

// otherIdentities names what a bare `stop` would take down.
func otherIdentities(dir string) []string {
	var names []string
	for _, row := range gatherIdentities(dir, "") {
		if row.stopped {
			continue // already stopped; stopping it again is not a loss
		}
		names = append(names, row.name)
	}
	return names
}
