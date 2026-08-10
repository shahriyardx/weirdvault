// Command weirdvault-agent makes a machine reachable that cannot be dialled.
//
// A server behind a home router, a laptop on hotel wifi, a box on a corporate
// network with no inbound rule — none of them have an address the relay can
// connect to. So this connects outward instead. It holds one WebSocket to the
// relay and waits; when a browser asks for this machine, the relay says so, and
// the agent dials back with a second WebSocket and pipes it to sshd on
// loopback.
//
// # What this program can and cannot do
//
// It is a pipe to a port. It holds no SSH credentials, performs no SSH
// handshake, and cannot read a byte of what passes through it: the session is
// encrypted end-to-end between the user's browser tab and sshd on this machine,
// and this process sits in the middle of that ciphertext exactly as the relay
// does. Its private key authenticates *the machine to the relay* — it says "the
// agent you enrolled is here", nothing more.
//
// That matters for what a stolen agent.json is worth. It lets the thief
// impersonate this machine to the relay, which means they could offer a
// connection and see ciphertext — which they cannot decrypt, and which host key
// pinning in the browser will reject the moment they try to substitute their own
// sshd. It does not let them log in. Revoking the agent in the dashboard makes
// the key useless immediately, because the relay asks the control plane on every
// reconnect.
//
// # Usage
//
//	weirdvault-agent enroll --token=ENROLL_… --url=https://app.example.com
//	weirdvault-agent run [--config=/etc/weirdvault-agent/agent.json]
//	weirdvault-agent status
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
)

// version is stamped at build time with -ldflags "-X main.version=…".
var version = "dev"

// signingMessage is what an agent signs to prove it holds its key.
//
// Domain-separated and structured rather than a bare nonce. A signature over
// unstructured random bytes is a signature over anything of the same length,
// which is how a key issued for one purpose ends up validating in another. The
// agent id is inside it so a nonce captured from one agent's handshake cannot be
// replayed into another's.
//
// This must stay byte-identical to verifyingMessage in
// apps/web/src/lib/agents/verify.ts.
func signingMessage(agentID, nonce string) []byte {
	return []byte("weirdvault-agent-v1\n" + agentID + "\n" + nonce)
}

// fingerprint renders a public key the way SSH renders host keys, because it is
// shown next to one in the dashboard and two formats for one idea is one too
// many.
func fingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "enroll":
		err = runEnroll(os.Args[2:])
	case "run":
		err = runAgent(os.Args[2:])
	case "status":
		err = runStatus(os.Args[2:])
	case "start":
		err = runStart(os.Args[2:])
	case "stop":
		err = runStop(os.Args[2:])
	case "restart":
		err = runRestart(os.Args[2:])
	case "enable":
		err = runEnable(os.Args[2:])
	case "disable":
		err = runDisable(os.Args[2:])
	case "list", "ps":
		err = runList(os.Args[2:])
	case "remove", "forget":
		err = runRemove(os.Args[2:])
	case "logs":
		err = runLogs(os.Args[2:])
	case "upgrade":
		err = runUpgrade(os.Args[2:])
	case "install-service":
		err = runInstallService(os.Args[2:])
	case "uninstall-service":
		err = runUninstallService(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}

	if err != nil {
		// A rejection has already explained itself at length, and prefixing it
		// with "error:" would bury the instructions under a word. Its own exit
		// code lets a supervisor tell "this will never work" from "the network
		// was down" — see RestartPreventExitStatus in the systemd unit.
		if errors.Is(err, errRejected) {
			os.Exit(exitRejected)
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `weirdvault-agent — reach this machine without opening a port

  enroll --token=… --url=…   register this machine with your account
  run [--config=…]           hold the connection open (what the service runs)
  status [--config=…]        this machine's identity, and whether it is running

Running it, and whether it comes back:

  start [--boot-only]        start now, and at every boot
  stop [--keep-enabled]      stop now, and stay stopped across reboots
  restart                    restart without changing boot behaviour
  enable | disable           change only whether it starts at boot
  list                       every agent on this machine, and what it is doing
  remove <id>                delete one identity from this machine
  logs [-f] [-n N]           what the service has been saying
  upgrade [--check]          install the build this deployment publishes

  install-service            macOS: register the launchd daemon (Linux: the
  uninstall-service          installer writes the systemd unit)
  version

Enrollment is one-time. The token is single-use and expires; get one from
Dashboard → Machines → Add a machine.
`)
}
