package main

/*
Instructions from the dashboard, and why the agent can believe them.

The agent proves who it is with its Ed25519 key. Until this file, nothing proved
anything to the agent: `open` requests and close codes both arrive as
unauthenticated data on a socket the relay owns, so the relay was trusted with
whatever it said.

That was survivable while the worst it could do was deny service — a refused
agent exits, systemd holds it down, and a reboot recovers it. It stops being
survivable now that a command can stop a daemon persistently or delete an
identity: the same forgery would become "strand every machine this deployment
has, permanently, requiring physical access to recover".

So commands are signed by the control plane with a key whose public half arrives
in this identity's config at enrolment, over the same TLS the installer already
trusts. The relay carries the envelope and cannot read the authority in it. It
can drop a command, delay it, or deliver it twice; it cannot invent one.

# What is checked, and why each

  signature   by a key this identity was enrolled with. Everything else is
              worthless without it.
  agentId     equal to this identity's own. On a shared machine that is what
              makes "stop" mean one account's identity rather than the machine,
              and it stops a command captured from one machine being replayed
              at another.
  expiry      a command is an instruction about now. A minute old is a captured
              envelope, not a decision.
  nonce       not seen before. Bounded replay: the relay sees every command and
              could send one twice — and "restart" twice is a nuisance while
              "revoke" twice is nothing, but the property should not depend on
              which command it happens to be.

An agent enrolled before this existed has no keys and refuses everything, which
is the same shape of gap as an agent enrolled before self-update: reported, not
worked around.
*/

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// Commands an agent will act on. Must match AGENT_COMMANDS in
// apps/web/src/lib/agents/commands.ts.
const (
	commandRestart = "restart"
	commandUpgrade = "upgrade"
	commandStop    = "stop"
	commandRevoke  = "revoke"

	/*
	   Adding a key this deployment will sign with in future.

	   The new public key travels *inside* the command string — "rotate-key:<key>"
	   — rather than beside it in a field of its own. The signature covers the
	   command and nothing else, so a key carried outside it would be a key the
	   relay could swap on the way past, which is the one thing this whole
	   mechanism exists to prevent. Putting it in the signed bytes means one
	   message format, one verify path, and no field anybody has to remember to
	   check.
	*/
	commandRotateKey = "rotate-key"
)

/*
How far ahead of us the control plane's clock may be.

Expiry is checked against this machine's clock, and a machine in somebody's
house may be seconds out — enough that a command minted with a sixty second life
arrives already expired. Tolerating a little skew is what stops "your clock is
slow" presenting as "the dashboard does not work", and it costs only that same
window of extra replay life on a command that was going to be replayable for a
minute anyway.
*/
const commandClockSkew = 30 * time.Second

// How long a spent nonce is remembered: its whole possible life plus the skew
// allowance, after which the expiry check refuses it anyway.
const nonceMemory = 2 * time.Minute

var (
	errNoCommandKeys = errors.New("this identity was enrolled before remote control existed, so it cannot verify commands — re-enrol to enable them")
	errReplayed      = errors.New("this command has already been carried out")
)

// signingMessageFor is what the control plane signed.
//
// Domain-separated and structured, like the agent's own proof: a signature over
// unstructured bytes is a signature over anything of that shape. Must stay
// byte-identical to commandMessage in apps/web/src/lib/agents/commands.ts.
func signingMessageFor(agentID, command, nonce string, expiresAt int64) []byte {
	return []byte(fmt.Sprintf("weirdvault-command-v1\n%s\n%s\n%s\n%d", agentID, command, nonce, expiresAt))
}

/*
seenNonces remembers what has already been carried out.

Per identity rather than per process: two identities on one machine are two
accounts, and one account's command history is not a thing the other should be
able to probe by timing.
*/
type seenNonces struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func newSeenNonces() *seenNonces {
	return &seenNonces{seen: map[string]time.Time{}}
}

// remember reports whether this nonce is new, and records it if so.
func (s *seenNonces) remember(nonce string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Swept on use rather than on a timer: the map only grows when commands
	// arrive, so the only moment it needs tidying is when one does.
	for key, at := range s.seen {
		if now.Sub(at) > nonceMemory {
			delete(s.seen, key)
		}
	}

	if _, ok := s.seen[nonce]; ok {
		return false
	}
	s.seen[nonce] = now
	return true
}

// verifyCommand checks that this identity should act on this message.
//
// Returns the command to run, or the reason it will not be run — which is
// reported back through the relay, because a refusal nobody can see is
// indistinguishable from a machine that is broken.
func (id *identity) verifyCommand(msg controlMessage, now time.Time) (string, error) {
	if len(id.cfg.CommandKeys) == 0 {
		return "", errNoCommandKeys
	}
	if msg.AgentID != id.cfg.AgentID {
		// Not "unknown agent": this identity was addressed by name and the name
		// was somebody else's. The likeliest cause is a relay bug, and the
		// second likeliest is the thing this check exists for.
		return "", fmt.Errorf("this command names agent %q, not this one", msg.AgentID)
	}
	if msg.Command == "" || msg.Nonce == "" || msg.Signature == "" {
		return "", errors.New("command, nonce and signature are all required")
	}

	switch {
	case msg.Command == commandRestart,
		msg.Command == commandUpgrade,
		msg.Command == commandStop,
		msg.Command == commandRevoke,
		strings.HasPrefix(msg.Command, commandRotateKey+":"):
	default:
		// Refused rather than ignored, so a control plane newer than this agent
		// gets an answer it can show somebody instead of a silence.
		return "", fmt.Errorf("this build does not know the command %q", msg.Command)
	}

	expiry := time.Unix(msg.ExpiresAt, 0)
	if now.After(expiry.Add(commandClockSkew)) {
		return "", fmt.Errorf("this command expired at %s; this machine's clock says %s",
			expiry.UTC().Format(time.RFC3339), now.UTC().Format(time.RFC3339))
	}

	sig, err := base64.StdEncoding.DecodeString(msg.Signature)
	if err != nil {
		return "", errors.New("signature is not valid base64")
	}

	message := signingMessageFor(id.cfg.AgentID, msg.Command, msg.Nonce, msg.ExpiresAt)
	if !id.cfg.verifyCommandSignature(message, sig) {
		return "", errors.New("this command was not signed by this deployment")
	}

	// Last, and only once everything else passed: a nonce spent on a command
	// that was refused for another reason should not be burned.
	if !id.nonces.remember(msg.Nonce, now) {
		return "", errReplayed
	}
	return msg.Command, nil
}

// verifyCommandSignature tries every key this identity was enrolled with.
//
// A list rather than one key so a deployment can rotate: publish the new key,
// let agents pick it up, retire the old one. Each is tried in turn because
// nothing in the envelope says which was used, and there will only ever be one
// or two.
func (c *Config) verifyCommandSignature(message, sig []byte) bool {
	for _, encoded := range c.CommandKeys {
		raw, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			continue
		}
		if ed25519.Verify(ed25519.PublicKey(raw), message, sig) {
			return true
		}
	}
	return false
}

/*
Carrying one out.

Every command answers, including every refusal. A dashboard that says "sent" and
then shows nothing is indistinguishable from a broken machine, and the refusals
here are the interesting part: "three sessions are open" is the answer somebody
needs, not an error to swallow.

Two of these — restart and upgrade — are process-wide on a machine that may be
serving several accounts. They are therefore refused while *any* identity is
carrying a session, and the refusal names them: person A being told "somebody
else is using this machine" is a fact they can act on, while a silent restart
that cuts person B's shell is not.
*/
func (s *supervisor) runCommand(id *identity, command string) (detail string, err error) {
	switch {
	case command == commandStop:
		// One identity, not the machine. `stop` from the dashboard means "stop
		// mine", and on a shared machine anything else would be one account
		// turning off another's access.
		if err := s.stopIdentityFile(id); err != nil {
			return "", err
		}
		return "stopped; it will not start again until it is started on the machine", nil

	case strings.HasPrefix(command, commandRotateKey+":"):
		return s.rotateKey(id, strings.TrimPrefix(command, commandRotateKey+":"))

	case command == commandRevoke:
		// Same as stop, plus the file. The key is already dead on the control
		// plane — this is the copy on disk, and leaving it would mean a machine
		// that keeps a credential for an account that has disowned it.
		if err := s.stopIdentityFile(id); err != nil {
			return "", err
		}
		if err := os.Remove(id.path); err != nil && !os.IsNotExist(err) {
			return "", fmt.Errorf("stopped, but could not remove %s: %w", id.path, err)
		}
		// The marker outlives the config it referred to and would silently
		// suppress a later re-enrolment under the same name.
		_ = os.Remove(stoppedMarkerFor(id.path))
		return "stopped and removed from this machine", nil

	case command == commandRestart:
		if busy := s.busyIdentities(); len(busy) > 0 {
			return "", fmt.Errorf("not restarting: %s", describeBusy(busy))
		}
		return "restarting", s.restartProcess()

	case command == commandUpgrade:
		if busy := s.busyIdentities(); len(busy) > 0 {
			return "", fmt.Errorf("not upgrading: %s", describeBusy(busy))
		}
		if id.cfg.ReleaseURL == "" {
			return "", errors.New("this identity has no release URL, so there is nowhere to upgrade from — re-enrol to enable updates")
		}
		if !selfUpdate(context.Background(), id.cfg) {
			// Not an error. "Already on the published build" is the most common
			// answer and the dashboard should say so rather than showing a
			// failure.
			return "already running the published build", nil
		}
		return "upgraded, restarting", s.restartProcess()
	}
	return "", fmt.Errorf("this build does not know the command %q", command)
}

/*
stopIdentityFile writes the marker and drops the loop, which is the same thing
`weirdvault stop <id>` does — deliberately, so a machine cannot end up in
a state only one of the two routes can produce.

The loop is cancelled after a moment rather than immediately, and that delay is
load-bearing: the connection being cancelled is the one the answer to this
command travels on. Cancelling first raced the reply and won often enough that a
revoke reported "the machine did not answer" while having done exactly what it
was told — the worst possible pairing, since the operator then tries again or
assumes the machine is broken.

Marking it stopped is what makes the delay safe. The identity is already out of
the running set, so nothing restarts it, and the marker on disk survives whatever
happens next.
*/
func (s *supervisor) stopIdentityFile(id *identity) error {
	marker := stoppedMarkerFor(id.path)
	if err := os.WriteFile(marker, []byte("stopped from the dashboard\n"), 0o644); err != nil {
		return fmt.Errorf("could not write %s: %w", marker, err)
	}

	s.mu.Lock()
	cancel := s.running[id.name]
	delete(s.running, id.name)
	delete(s.live, id.name)
	s.mu.Unlock()

	if cancel != nil {
		go func() {
			time.Sleep(restartGrace)
			cancel()
		}()
	}
	s.touch()
	return nil
}

// busyIdentities names every identity currently carrying a session.
func (s *supervisor) busyIdentities() []identitySnapshot {
	var busy []identitySnapshot
	for _, snap := range s.snapshot() {
		if snap.Sessions > 0 {
			busy = append(busy, snap)
		}
	}
	return busy
}

func describeBusy(busy []identitySnapshot) string {
	parts := make([]string, 0, len(busy))
	for _, snap := range busy {
		parts = append(parts, fmt.Sprintf("%s has %s open", snap.Name, describeSessions(snap.Sessions)))
	}
	return strings.Join(parts, ", ") + ". Close them, or wait, and try again"
}

/*
restartProcess replaces this process with a fresh copy of the binary.

exec rather than exit-and-let-systemd-restart, for the same reason the update
path does it: the pid, the unit and the open descriptors survive, so a
supervisor sees a process that never stopped rather than a restart it might
count against a rate limit — and it works when nothing is supervising at all.

Deferred by a moment so the result can reach the dashboard first. Replacing the
process image is not something the reply survives, and "did my restart work" is
exactly the question the reply answers.
*/
func (s *supervisor) restartProcess() error {
	go func() {
		time.Sleep(restartGrace)
		if err := reexec(); err != nil {
			log.Printf("could not restart: %v", err)
		}
	}()
	return nil
}

// How long to let a reply travel before the process image is replaced.
const restartGrace = 500 * time.Millisecond

/*
rotateKey adds a key this deployment will sign with in future.

The safety of the whole scheme rests on one detail: this command arrives signed
by a key the identity *already* trusts. So the deployment proves it holds the
current key before being allowed to name the next one, and a relay that could
forge this could already forge everything else — which it cannot, because it
cannot sign at all.

The old key is deliberately kept. Rotation is not one instant: some machines are
asleep, and an operator who retires the old key the moment the new one is
published has just made every offline machine unreachable by command until
somebody re-enrols it. Dropping the old one is a separate decision, made when
the fleet is known to have moved, and `weirdvault status` is what says whether it
has.
*/
func (s *supervisor) rotateKey(id *identity, encoded string) (string, error) {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return "", errors.New("rotate-key carried no key")
	}

	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return "", fmt.Errorf("rotate-key carried something that is not an Ed25519 public key")
	}

	// Idempotent: the control plane may send this again before the answer gets
	// back, and a second copy of a key it already has is not a failure.
	for _, existing := range id.cfg.CommandKeys {
		if existing == encoded {
			return "already trusted", nil
		}
	}

	// Written through a copy so a failed save leaves the running identity
	// exactly as it was, rather than trusting a key that is not on disk.
	updated := *id.cfg
	updated.CommandKeys = append(append([]string{}, id.cfg.CommandKeys...), encoded)

	if err := saveConfig(id.path, &updated); err != nil {
		return "", fmt.Errorf("could not write %s: %w", id.path, err)
	}

	id.mu.Lock()
	id.cfg = &updated
	id.mu.Unlock()

	log.Printf("[%s] added a command signing key; %d are now trusted", id.name, len(updated.CommandKeys))
	return fmt.Sprintf("added; %d keys trusted", len(updated.CommandKeys)), nil
}
