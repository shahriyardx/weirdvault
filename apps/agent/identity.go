package main

/*
Several accounts, one machine.

A machine is often shared. Two people with shells on the same box both want it
in their own dashboard, and the product has no teams by design — so the answer
is one identity per person: each enrols from their own account, gets their own
agent id and key, and revoking one says nothing about the other.

That makes this process a supervisor. One config file is one identity, each
holds its own control connection, and the set of them is whatever is in the
config directory right now.

# Why the directory is re-read rather than read once

Enrolling a second person writes a file. If picking it up needed a restart, then
one person joining would drop everyone else's sessions — and this same daemon
refuses a restart while a session is live, so it would be refusing on behalf of
people it was about to disconnect anyway. Re-reading means enrolment is a file
write that nobody else notices.

Polling rather than inotify: it is a handful of small files, the latency that
matters is measured in seconds, and the binary has exactly one dependency today.

# Why a rejection stops one loop and not the process

A revoked identity is told so by the relay, and before this file existed that
meant `exit 3` and a supervisor holding the unit down — correct when the machine
served one account, and a fleet-wide outage when it serves four. So a rejected
identity stops on its own and the rest carry on. The process exits only when
nothing is left to run, which keeps the systemd contract intact for the ordinary
single-identity install.
*/

import (
	"context"
	"crypto/ed25519"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

/*
How often the config directory is re-read.

Long enough to be free, short enough that `weirdvault-agent stop <id>` feels
like it did something. The CLI waits on the runtime state file rather than
guessing, so this interval is what it waits out.
*/
const reloadInterval = 3 * time.Second

// What an identity is doing, in the words the CLI and the dashboard use.
type identityState string

const (
	stateStarting identityState = "starting"
	stateOnline   identityState = "online"
	stateRetrying identityState = "retrying"
	stateRejected identityState = "rejected"
)

// identity is one config file, and the connection it is responsible for.
type identity struct {
	// Base name of the config file without its extension — the short agent id
	// the installer writes, or "agent" for a single-identity install.
	name string
	path string
	cfg  *Config
	priv ed25519.PrivateKey

	// What this identity has already carried out, so the relay cannot have a
	// command run twice by sending it twice.
	nonces *seenNonces

	// Guards everything below. Read by the state writer on another goroutine.
	mu        sync.Mutex
	state     identityState
	since     time.Time
	lastError string
	sessions  int
}

func (id *identity) setState(state identityState, err string) {
	id.mu.Lock()
	changed := id.state != state || id.lastError != err
	id.state, id.lastError = state, err
	if changed {
		id.since = time.Now()
	}
	id.mu.Unlock()
}

// sessionOpened and sessionClosed track what a restart would interrupt.
//
// The count is the whole reason a remote restart can be refused rather than
// silently cutting somebody's shell, and it is why the number is per identity:
// on a shared machine "somebody is using it" has to name who.
func (id *identity) sessionOpened() {
	id.mu.Lock()
	id.sessions++
	id.mu.Unlock()
}

func (id *identity) sessionClosed() {
	id.mu.Lock()
	if id.sessions > 0 {
		id.sessions--
	}
	id.mu.Unlock()
}

func (id *identity) snapshot() identitySnapshot {
	id.mu.Lock()
	defer id.mu.Unlock()
	return identitySnapshot{
		Name:      id.name,
		Config:    id.path,
		AgentID:   id.cfg.AgentID,
		State:     string(id.state),
		Since:     id.since.UTC().Format(time.RFC3339),
		Sessions:  id.sessions,
		LastError: id.lastError,
		Ports:     id.cfg.AllowedPorts,
	}
}

// supervisor owns the set of running identities.
type supervisor struct {
	// Where identities live. Empty when --config named a single file, which is
	// what every install written before this existed passes.
	dir string
	// Set instead of dir for that single-file case.
	single string

	mu       sync.Mutex
	running  map[string]context.CancelFunc
	live     map[string]*identity
	rejected map[string]bool

	// Signalled whenever something worth writing to the state file changed.
	dirty chan struct{}
	wg    sync.WaitGroup
}

func newSupervisor(dir, single string) *supervisor {
	return &supervisor{
		dir:      dir,
		single:   single,
		running:  map[string]context.CancelFunc{},
		live:     map[string]*identity{},
		rejected: map[string]bool{},
		dirty:    make(chan struct{}, 1),
	}
}

// touch asks for a state file rewrite without blocking the caller.
func (s *supervisor) touch() {
	select {
	case s.dirty <- struct{}{}:
	default: // one pending write already covers this change
	}
}

// snapshot is what the CLI reads.
func (s *supervisor) snapshot() []identitySnapshot {
	s.mu.Lock()
	ids := make([]*identity, 0, len(s.live))
	for _, id := range s.live {
		ids = append(ids, id)
	}
	s.mu.Unlock()

	out := make([]identitySnapshot, 0, len(ids))
	for _, id := range ids {
		out = append(out, id.snapshot())
	}
	return out
}

/*
desired reads the config directory and reports what should be running.

A `.stopped` marker beside a config is how `weirdvault-agent stop <id>` takes
one identity out without touching the file that holds its private key — and,
because it is a file rather than a message, it survives a reboot and a restart
of this process with no state to keep anywhere else.
*/
func (s *supervisor) desired() (map[string]string, error) {
	if s.single != "" {
		if stoppedMarkerExists(s.single) {
			return map[string]string{}, nil
		}
		return map[string]string{identityNameFor(s.single): s.single}, nil
	}

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}

	found := map[string]string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(s.dir, entry.Name())
		if stoppedMarkerExists(path) {
			continue
		}
		found[identityNameFor(path)] = path
	}
	return found, nil
}

// reconcile starts what should be running and stops what should not.
func (s *supervisor) reconcile(ctx context.Context) {
	want, err := s.desired()
	if err != nil {
		// A directory that cannot be read is not a reason to tear down the
		// identities already running: the likeliest cause is somebody editing it,
		// and dropping every connection over a transient readdir would be a much
		// worse failure than acting a few seconds late.
		log.Printf("could not read %s, keeping what is running: %v", s.dir, err)
		return
	}

	s.mu.Lock()
	// Stop anything whose file is gone, or which has just been marked stopped.
	for name, cancel := range s.running {
		if _, ok := want[name]; !ok {
			log.Printf("[%s] stopping: its config is gone or stopped", name)
			cancel()
			delete(s.running, name)
			delete(s.live, name)
		}
	}
	// A file that reappears — or is replaced after being rejected — gets another
	// chance. Anything else would mean a re-enrolment needs a daemon restart.
	for name := range s.rejected {
		if _, ok := want[name]; !ok {
			delete(s.rejected, name)
		}
	}
	starts := make(map[string]string)
	for name, path := range want {
		if _, ok := s.running[name]; ok {
			continue
		}
		if s.rejected[name] {
			continue
		}
		starts[name] = path
	}
	s.mu.Unlock()

	for name, path := range starts {
		s.start(ctx, name, path)
	}
	s.touch()
}

// start brings one identity up, if its config can be read at all.
func (s *supervisor) start(ctx context.Context, name, path string) {
	cfg, err := loadConfig(path)
	if err != nil {
		// Logged once per reload rather than retried in a tight loop, and not
		// fatal: one unreadable file must not stop the identities beside it.
		log.Printf("[%s] ignoring %s: %v", name, path, err)
		return
	}
	priv, err := cfg.privateKey()
	if err != nil {
		log.Printf("[%s] ignoring %s: %v", name, path, err)
		return
	}

	id := &identity{
		name:   name,
		path:   path,
		cfg:    cfg,
		priv:   priv,
		nonces: newSeenNonces(),
		state:  stateStarting,
		since:  time.Now(),
	}
	idCtx, cancel := context.WithCancel(ctx)

	s.mu.Lock()
	s.running[name] = cancel
	s.live[name] = id
	s.mu.Unlock()

	log.Printf("[%s] starting: agent=%s relay=%s", name, cfg.AgentID, cfg.RelayURL)

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer cancel()

		rejected := s.serveIdentity(idCtx, id)

		s.mu.Lock()
		// Only forget the cancel if it is still ours: a reconcile that stopped
		// and restarted this name between here and there owns the new one.
		if s.running[name] != nil && rejected {
			s.rejected[name] = true
		}
		delete(s.running, name)
		if !rejected {
			delete(s.live, name)
		}
		s.mu.Unlock()
		s.touch()
	}()
}

/*
serveIdentity holds one identity's control connection for as long as it can.

This is the loop that used to be the whole program. Reports whether it stopped
because the relay refused this identity, which is the one ending that must not
be retried.
*/
func (s *supervisor) serveIdentity(ctx context.Context, id *identity) (rejected bool) {
	backoff := backoffMin

	for ctx.Err() == nil {
		start := time.Now()
		err := serve(ctx, s, id)

		if ctx.Err() != nil {
			break
		}
		if err != nil {
			if websocket.CloseStatus(err) == statusAgentRejected {
				id.setState(stateRejected, closeText(err))
				s.touch()
				logRejection(id, closeText(err))
				return true
			}
			id.setState(stateRetrying, err.Error())
			s.touch()
			log.Printf("[%s] connection ended: %v", id.name, err)
		}

		// A connection that lasted a while was working, so the next failure
		// should retry promptly rather than inheriting the backoff from whatever
		// went wrong hours ago.
		if time.Since(start) > 2*time.Minute {
			backoff = backoffMin
		}

		wait := jitter(backoff)
		log.Printf("[%s] reconnecting in %s", id.name, wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}

		backoff *= 2
		if backoff > backoffMax {
			backoff = backoffMax
		}
	}
	return false
}

// logRejection says what happened and what to do, once, in full.
func logRejection(id *identity, reason string) {
	log.Printf("")
	log.Printf("[%s] this machine is no longer accepted: %s", id.name, reason)
	log.Printf("")
	log.Printf("[%s] It was most likely revoked from the dashboard. Reconnecting cannot", id.name)
	log.Printf("[%s] undo that, so this identity is stopping rather than retrying forever.", id.name)
	log.Printf("")
	log.Printf("[%s] To use this machine again from that account, enrol it afresh:", id.name)
	log.Printf("[%s]   1. Dashboard -> Machines -> Add a machine", id.name)
	log.Printf("[%s]   2. rm %s", id.name, id.path)
	log.Printf("[%s]   3. run the install command it gives you", id.name)
	log.Printf("")
	log.Printf("[%s] Any other identity on this machine is unaffected.", id.name)
}

/*
run is the supervisor's whole life: reconcile, wait, reconcile.

It returns when the context is cancelled — or when there is nothing left to
supervise and never will be, which is the single-identity case that has to keep
behaving exactly as it did: a revoked agent exits 3, and systemd's
RestartPreventExitStatus holds it down.
*/
func (s *supervisor) run(ctx context.Context) error {
	// The state writer gets its own cancel rather than only the caller's. Both
	// ways out of this function have to stop it — and one of them, the lone
	// rejected identity, happens while the caller's context is still very much
	// alive. Waiting on a writer that only stops when that context ends is a
	// hang, which is what this looked like the first time it was written.
	writerCtx, stopWriter := context.WithCancel(ctx)
	stateDone := make(chan struct{})
	go func() {
		defer close(stateDone)
		s.writeStateUntil(writerCtx)
	}()

	// Every exit runs through here, so nothing can leave a goroutine or a state
	// file describing a process that is gone.
	finish := func(err error) error {
		stopWriter()
		s.wg.Wait()
		<-stateDone
		removeStateFile()
		return err
	}

	s.reconcile(ctx)

	ticker := time.NewTicker(reloadInterval)
	defer ticker.Stop()

	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
		case <-ticker.C:
			s.reconcile(ctx)

			s.mu.Lock()
			running, rejected := len(s.running), len(s.rejected)
			s.mu.Unlock()

			// Nothing running and something was refused: there is no work left
			// and no reason to think there will be. Exiting with the rejection
			// code is what keeps a single-identity machine from reconnecting
			// every five seconds forever to be told no — and what lets systemd's
			// RestartPreventExitStatus do its job.
			if running == 0 && rejected > 0 {
				// launchd has no equivalent of systemd's
				// RestartPreventExitStatus, so exiting there means being started
				// again ten seconds later to be refused again, forever. Staying
				// alive and idle is the only way to stop without a supervisor
				// undoing it — and it is strictly better than the alternative
				// that was considered and rejected: disabling the service on the
				// strength of a close code the agent cannot verify, which would
				// let a compromised relay strand a whole fleet.
				//
				// It is not a silent park. The rejection was logged in full, and
				// `weirdvault-agent status` says what happened.
				if runtime.GOOS == "darwin" {
					log.Printf("nothing left to run. Staying resident so launchd does not restart this")
					log.Printf("every ten seconds; `weirdvault-agent stop` ends it.")
					<-ctx.Done()
					log.Printf("shutting down")
					return finish(nil)
				}
				return finish(errRejected)
			}
		}
	}

	log.Printf("shutting down")
	return finish(nil)
}
