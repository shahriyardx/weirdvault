package main

/*
Which machine this is.

Several accounts can enrol the same box, and one account can enrol it twice.
Both are supported, and both produce agent rows that are genuinely separate
identities on one physical machine — which the dashboard cannot say unless
something tells it they belong together.

Hostname is the obvious candidate and is not good enough. `raspberrypi`,
`localhost` and `ubuntu` are among the most common names in existence, and a
dashboard that grouped on them would eventually tell somebody that two of their
machines were one. So this reads the identifier the platform already keeps for
exactly this purpose, and sends a hash of it.

# What is sent, and what it is worth

A hash, never the id itself. `/etc/machine-id` is documented as something to
keep to yourself — stable, unique, and usable as a tracking identifier by
anything that sees it — so it is domain-separated and hashed here, and what
leaves the machine is a value that is stable for this deployment's purpose and
meaningless anywhere else.

It is self-reported, like the hostname and the version beside it. A machine
could send anything at all. What that buys is a wrong grouping in a list, which
is why it is used for display and for nothing that decides access.

Empty when nothing can be read, which is not an error: the dashboard falls back
to grouping by hostname, exactly as it does for agents enrolled before this
existed.
*/

import (
	"crypto/sha256"
	"encoding/base64"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

/*
Where each platform keeps its identifier.

systemd writes /etc/machine-id; the dbus copy predates it and still exists on
machines that have been upgraded for a decade. Reading both in order is what
makes this work on a container, an old install and a current one alike.
*/
var machineIDFiles = []string{
	"/etc/machine-id",
	"/var/lib/dbus/machine-id",
}

// machineRef is the value sent at enrolment.
func machineRef() string {
	id := rawMachineID()
	if id == "" {
		return ""
	}

	// Domain-separated, so this hash cannot be looked up against a hash of the
	// same id taken by anything else.
	sum := sha256.Sum256([]byte("weirdvault-machine-v1\n" + id))
	// 16 bytes is far past any collision concern for the number of machines one
	// account has, and keeps the value short enough to read in a database.
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}

func rawMachineID() string {
	for _, path := range machineIDFiles {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if id := strings.TrimSpace(string(raw)); id != "" {
			return id
		}
	}

	if runtime.GOOS == "darwin" {
		// No machine-id on macOS. The hardware UUID is the equivalent, and ioreg
		// is the only way to it without cgo.
		out, err := exec.Command("ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
		if err != nil {
			return ""
		}
		return platformUUIDFrom(string(out))
	}
	return ""
}

/*
platformUUIDFrom pulls the UUID out of ioreg's output, which prints it as

	"IOPlatformUUID" = "00000000-0000-1000-8000-001122334455"

Split rather than matched with a pattern, so an unexpected future format is a
miss — and a fallback to grouping by hostname — rather than something worse.
*/
func platformUUIDFrom(out string) string {
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "IOPlatformUUID") {
			continue
		}
		parts := strings.Split(line, "\"")
		// [indent] "IOPlatformUUID" [ = ] "value" → the value is the fourth part
		if len(parts) >= 4 {
			return strings.TrimSpace(parts[3])
		}
	}
	return ""
}
