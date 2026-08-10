package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/*
The command envelope, from both sides of the language boundary.

Nothing compiles both ends of this format. A round trip written in Go alone
would pass just as happily with the Go and TypeScript halves wrong in the same
way — which is the failure that matters, because the two are written months
apart by people reading different files.

So the fixture below was produced by apps/web/src/lib/agents/commands.ts with a
known seed, and is verified here by the implementation that has to read real
ones. Regenerate it with that module if the format is ever versioned. Do not
hand-edit the signature: a fixture that was made to pass proves nothing.
*/

const (
	fixtureAgentID   = "agent-fixture"
	fixtureNonce     = "bm9uY2UtZml4dHVyZQ=="
	fixtureExpiresAt = int64(1900000000)
	fixturePublicKey = "i8F5CETyflP5XizQUQbK63EOJ8qVZr35FOzEzLmy05Y="
	fixtureSignature = "7AOj1xBCO7cwSuGp+N8H3/pzMnOc84fyOpWQa5HOolpvSng8V4sGOu2nBJg87rNN366JvtncJdhQhXiGtQSyBg=="
)

// fixtureIdentity is an identity enrolled with the fixture deployment's key.
func fixtureIdentity(t *testing.T) *identity {
	t.Helper()
	return &identity{
		name:   "fixture",
		path:   t.TempDir() + "/fixture.json",
		nonces: newSeenNonces(),
		cfg: &Config{
			AgentID: fixtureAgentID,
			// A real seed, so a config written by these tests is one the agent
			// would actually load — saveConfig/loadConfig validate, and a
			// fixture that skipped this would pass a test the product fails.
			PrivateKey:   base64.StdEncoding.EncodeToString(make([]byte, ed25519.SeedSize)),
			RelayURL:     "wss://example.test/agent",
			AllowedPorts: []int{22},
			CommandKeys:  []string{fixturePublicKey},
		},
	}
}

func fixtureCommand() controlMessage {
	return controlMessage{
		Type:      "command",
		ID:        "cmd-1",
		AgentID:   fixtureAgentID,
		Command:   commandRestart,
		Nonce:     fixtureNonce,
		ExpiresAt: fixtureExpiresAt,
		Signature: fixtureSignature,
	}
}

// The message both ends sign, byte for byte.
func TestSigningMessageMatchesTheControlPlane(t *testing.T) {
	got := string(signingMessageFor(fixtureAgentID, commandRestart, fixtureNonce, fixtureExpiresAt))
	want := "weirdvault-command-v1\nagent-fixture\nrestart\nbm9uY2UtZml4dHVyZQ==\n1900000000"

	if got != want {
		t.Fatalf("signing message drifted from the control plane's:\n got %q\nwant %q", got, want)
	}
}

func TestAcceptsACommandTheControlPlaneSigned(t *testing.T) {
	id := fixtureIdentity(t)

	command, err := id.verifyCommand(fixtureCommand(), time.Unix(fixtureExpiresAt-10, 0))
	if err != nil {
		t.Fatalf("a genuine command was refused: %v", err)
	}
	if command != commandRestart {
		t.Fatalf("got command %q, want %q", command, commandRestart)
	}
}

// The property the whole design rests on: the relay carries these and must not
// be able to invent one.
func TestRefusesACommandNobodySigned(t *testing.T) {
	id := fixtureIdentity(t)

	forged := fixtureCommand()
	forged.Command = commandRevoke // the signature covers the command

	if _, err := id.verifyCommand(forged, time.Unix(fixtureExpiresAt-10, 0)); err == nil {
		t.Fatal("a command whose text was changed after signing was accepted")
	}

	unsigned := fixtureCommand()
	unsigned.Signature = base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	if _, err := id.verifyCommand(unsigned, time.Unix(fixtureExpiresAt-10, 0)); err == nil {
		t.Fatal("a command signed with nothing was accepted")
	}
}

// A command captured from one machine must not work on another. On a shared
// machine it is also what makes "stop" mean one account's identity.
func TestRefusesACommandAddressedToAnotherAgent(t *testing.T) {
	id := fixtureIdentity(t)
	id.cfg.AgentID = "some-other-agent"

	if _, err := id.verifyCommand(fixtureCommand(), time.Unix(fixtureExpiresAt-10, 0)); err == nil {
		t.Fatal("a command naming a different agent was accepted")
	}
}

func TestRefusesAnExpiredCommand(t *testing.T) {
	id := fixtureIdentity(t)

	// Past the expiry and past the skew allowance.
	late := time.Unix(fixtureExpiresAt, 0).Add(commandClockSkew).Add(time.Second)
	if _, err := id.verifyCommand(fixtureCommand(), late); err == nil {
		t.Fatal("an expired command was accepted")
	}

	// Inside the skew allowance, for the machine whose clock runs slow.
	early := time.Unix(fixtureExpiresAt, 0).Add(commandClockSkew / 2)
	if _, err := id.verifyCommand(fixtureCommand(), early); err != nil {
		t.Fatalf("a command inside the clock skew allowance was refused: %v", err)
	}
}

// The relay delivers these and could deliver one twice.
func TestRefusesAReplayedCommand(t *testing.T) {
	id := fixtureIdentity(t)
	at := time.Unix(fixtureExpiresAt-10, 0)

	if _, err := id.verifyCommand(fixtureCommand(), at); err != nil {
		t.Fatalf("first delivery refused: %v", err)
	}
	_, err := id.verifyCommand(fixtureCommand(), at)
	if !errors.Is(err, errReplayed) {
		t.Fatalf("second delivery of the same command gave %v, want errReplayed", err)
	}
}

// A nonce spent on a command that was refused for another reason should not be
// burned — otherwise a clock skew would make the retry fail for a new reason.
func TestARefusedCommandDoesNotSpendItsNonce(t *testing.T) {
	id := fixtureIdentity(t)

	late := time.Unix(fixtureExpiresAt, 0).Add(2 * commandClockSkew)
	if _, err := id.verifyCommand(fixtureCommand(), late); err == nil {
		t.Fatal("expected the expiry refusal")
	}
	if _, err := id.verifyCommand(fixtureCommand(), time.Unix(fixtureExpiresAt-10, 0)); err != nil {
		t.Fatalf("the retry was refused as a replay: %v", err)
	}
}

// An identity enrolled before remote control existed has no keys, so it cannot
// tell an authorised command from a forged one — and says so rather than
// guessing.
func TestRefusesEveryCommandWithoutKeys(t *testing.T) {
	id := fixtureIdentity(t)
	id.cfg.CommandKeys = nil

	_, err := id.verifyCommand(fixtureCommand(), time.Unix(fixtureExpiresAt-10, 0))
	if !errors.Is(err, errNoCommandKeys) {
		t.Fatalf("got %v, want errNoCommandKeys", err)
	}
	if !strings.Contains(err.Error(), "re-enrol") {
		t.Errorf("the refusal should say how to fix it, got: %v", err)
	}
}

// Rotation: a second key is accepted while the first still is.
func TestAcceptsAnyEnrolledKey(t *testing.T) {
	id := fixtureIdentity(t)
	other, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	id.cfg.CommandKeys = []string{
		base64.StdEncoding.EncodeToString(other),
		fixturePublicKey,
	}

	if _, err := id.verifyCommand(fixtureCommand(), time.Unix(fixtureExpiresAt-10, 0)); err != nil {
		t.Fatalf("a command signed by one of two enrolled keys was refused: %v", err)
	}
}

// A control plane newer than this agent gets an answer rather than silence.
func TestRefusesAnUnknownCommand(t *testing.T) {
	id := fixtureIdentity(t)
	msg := fixtureCommand()
	msg.Command = "self-destruct"

	if _, err := id.verifyCommand(msg, time.Unix(fixtureExpiresAt-10, 0)); err == nil {
		t.Fatal("an unknown command was accepted")
	}
}

// Restart and upgrade are process-wide on a machine that may be serving several
// accounts, so they are refused while anyone is using it — and the refusal says
// who, because "somebody else is using this machine" is a fact person A can act
// on while a silent restart of person B's shell is not.
func TestRestartIsRefusedWhileASessionIsOpen(t *testing.T) {
	dir := t.TempDir()
	sup := newSupervisor(dir, "")

	busy := fixtureIdentity(t)
	busy.name = "bbbb2222"
	busy.sessionOpened()
	busy.sessionOpened()

	asking := fixtureIdentity(t)
	asking.name = "aaaa1111"

	sup.mu.Lock()
	sup.live["bbbb2222"] = busy
	sup.live["aaaa1111"] = asking
	sup.mu.Unlock()

	for _, command := range []string{commandRestart, commandUpgrade} {
		_, err := sup.runCommand(asking, command)
		if err == nil {
			t.Fatalf("%s went ahead while another identity had sessions open", command)
		}
		// The name and the count are the useful part of the refusal.
		if !strings.Contains(err.Error(), "bbbb2222") || !strings.Contains(err.Error(), "2 sessions") {
			t.Errorf("%s refusal should name who is busy and how many, got: %v", command, err)
		}
	}
}

// The same commands go ahead once nothing is being carried.
func TestStopIsNotRefusedByAnotherIdentitysSession(t *testing.T) {
	dir := t.TempDir()
	sup := newSupervisor(dir, "")

	busy := fixtureIdentity(t)
	busy.name = "bbbb2222"
	busy.sessionOpened()

	mine := fixtureIdentity(t)
	mine.name = "aaaa1111"
	mine.path = filepath.Join(dir, "aaaa1111.json")
	if err := os.WriteFile(mine.path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	sup.mu.Lock()
	sup.live["bbbb2222"] = busy
	sup.live["aaaa1111"] = mine
	sup.mu.Unlock()

	// Stopping one account's identity does not interrupt another's session, so
	// somebody else being busy is not a reason to refuse it.
	if _, err := sup.runCommand(mine, commandStop); err != nil {
		t.Fatalf("stop was refused because a different identity was busy: %v", err)
	}
	if !stoppedMarkerExists(mine.path) {
		t.Error("stop did not leave the marker that keeps it stopped across a reboot")
	}
	if _, err := os.Stat(mine.path); err != nil {
		t.Error("stop removed the config; only revoke should do that")
	}
}

// Revoke removes the key from the machine — the half of "I revoked it" that the
// database cannot do.
func TestRevokeRemovesTheIdentityFromDisk(t *testing.T) {
	dir := t.TempDir()
	sup := newSupervisor(dir, "")

	id := fixtureIdentity(t)
	id.name = "aaaa1111"
	id.path = filepath.Join(dir, "aaaa1111.json")
	if err := os.WriteFile(id.path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	sup.mu.Lock()
	sup.live["aaaa1111"] = id
	sup.mu.Unlock()

	if _, err := sup.runCommand(id, commandRevoke); err != nil {
		t.Fatalf("revoke failed: %v", err)
	}
	if _, err := os.Stat(id.path); !os.IsNotExist(err) {
		t.Error("the identity file survived a revoke")
	}
	// The marker would otherwise outlive the file it referred to and silently
	// suppress a later re-enrolment under the same name.
	if stoppedMarkerExists(id.path) {
		t.Error("revoke left a stopped marker behind")
	}
}

/*
Key rotation, from the agent's side.

The property that matters: the instruction adding a key must itself be signed by
a key already trusted. A deployment proves it holds the current key before it
may name the next one — and a relay, which can sign nothing, cannot do this at
all.
*/
func TestRotateKeyAddsAKeySignedByTheCurrentOne(t *testing.T) {
	dir := t.TempDir()
	sup := newSupervisor(dir, "")

	id := fixtureIdentity(t)
	id.name = "aaaa1111"
	id.path = filepath.Join(dir, "aaaa1111.json")
	if err := saveConfig(id.path, id.cfg); err != nil {
		t.Fatal(err)
	}

	newPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(newPub)

	detail, err := sup.runCommand(id, commandRotateKey+":"+encoded)
	if err != nil {
		t.Fatalf("rotation failed: %v", err)
	}
	if !strings.Contains(detail, "2 keys") {
		t.Errorf("expected the reply to say how many are trusted, got %q", detail)
	}

	// The old key is deliberately kept: a machine that was asleep during the
	// rotation must still be commandable, and retiring the old key is a separate
	// decision made by a person watching the sweep.
	if len(id.cfg.CommandKeys) != 2 || id.cfg.CommandKeys[0] != fixturePublicKey {
		t.Fatalf("expected both keys, got %v", id.cfg.CommandKeys)
	}

	// And it survives a restart, which is the only thing that makes it a
	// rotation rather than a change of mind.
	saved, err := loadConfig(id.path)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.CommandKeys) != 2 {
		t.Errorf("the new key was not written to disk: %v", saved.CommandKeys)
	}
}

// The control plane may send it again before the answer gets back.
func TestRotateKeyIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	sup := newSupervisor(dir, "")

	id := fixtureIdentity(t)
	id.path = filepath.Join(dir, "aaaa1111.json")
	if err := saveConfig(id.path, id.cfg); err != nil {
		t.Fatal(err)
	}

	detail, err := sup.runCommand(id, commandRotateKey+":"+fixturePublicKey)
	if err != nil {
		t.Fatalf("re-sending a key it already has should not fail: %v", err)
	}
	if detail != "already trusted" {
		t.Errorf("got %q, want the no-op answer", detail)
	}
	if len(id.cfg.CommandKeys) != 1 {
		t.Errorf("the key was added twice: %v", id.cfg.CommandKeys)
	}
}

// A rotation carrying nonsense must not be written; a config full of unusable
// keys is how an identity ends up unable to verify anything.
func TestRotateKeyRefusesSomethingThatIsNotAKey(t *testing.T) {
	sup := newSupervisor(t.TempDir(), "")
	id := fixtureIdentity(t)

	for _, bad := range []string{"", "   ", "not-base64!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		if _, err := sup.runCommand(id, commandRotateKey+":"+bad); err == nil {
			t.Errorf("accepted %q as a public key", bad)
		}
	}
	if len(id.cfg.CommandKeys) != 1 {
		t.Errorf("a refused rotation changed the trusted set: %v", id.cfg.CommandKeys)
	}
}

// And the whole point: an unsigned rotation is refused before any of the above.
func TestRotateKeyMustBeSigned(t *testing.T) {
	id := fixtureIdentity(t)

	newPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	msg := fixtureCommand()
	msg.Command = commandRotateKey + ":" + base64.StdEncoding.EncodeToString(newPub)
	// The fixture signature covers "restart", not this.

	if _, err := id.verifyCommand(msg, time.Unix(fixtureExpiresAt-10, 0)); err == nil {
		t.Fatal("a rotation the deployment did not sign was accepted")
	}
}
