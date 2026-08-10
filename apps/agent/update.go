package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

/*
Self-update, at startup.

An agent lives on a machine in somebody's house. Once installed it runs whatever
binary it got, and every fix after that reaches it only if a person walks over
and copies a file — which is not a workaround, it is a missing feature. So it
checks for a newer build when it starts, replaces itself, and re-execs.

# What this is trusting

Everything, and it is worth saying so plainly rather than implying the checksum
does more than it does. This downloads a binary and runs it as root. The
manifest and the binary come from the same origin, so the SHA-256 in the
manifest proves the download was not truncated or corrupted — it does not prove
the origin is honest. TLS to the deployment's own domain is the actual trust
anchor, and it is the same one the install command already relies on: anyone who
can tamper with this response could have tampered with the installer that put
the agent here.

What that trust does NOT extend to is plaintext. `install.sh` is fetched once by
a person who can read the URL they typed; this runs unattended, forever, as
root. So http:// is refused unless it is loopback, where there is no network to
be in the middle of.

# Bounded to one attempt

The re-exec'd process finds an environment marker and skips the check. Without
it, a manifest whose version never matches what the binary reports would
re-exec on every start, forever, at whatever rate systemd restarts it.
*/

const (
	updateTimeout = 60 * time.Second

	// Set before re-exec, checked at startup. One update attempt per start.
	updatedMarker = "WEIRDVAULT_AGENT_UPDATED"
)

type releaseManifest struct {
	Version  string `json:"version"`
	Binaries map[string]struct {
		File   string `json:"file"`
		SHA256 string `json:"sha256"`
	} `json:"binaries"`
}

// selfUpdate replaces this binary if the deployment is publishing a different
// one. Reports whether the caller should re-exec.
//
// Every failure is a log line and a false, never a fatal: an agent that will
// not start because a release server is down is far worse than an agent running
// last week's build.
func selfUpdate(ctx context.Context, cfg *Config) bool {
	if os.Getenv(updatedMarker) != "" {
		return false
	}
	if cfg.ReleaseURL == "" {
		// Enrolled before self-update existed. Saying so beats silence: it is
		// the difference between "up to date" and "never checking".
		log.Printf("self-update: not configured for this agent (re-enrol to enable)")
		return false
	}

	base, err := releaseBase(cfg.ReleaseURL)
	if err != nil {
		log.Printf("self-update: %v", err)
		return false
	}

	manifest, err := fetchManifest(ctx, base)
	if err != nil {
		log.Printf("self-update: %v", err)
		return false
	}
	if manifest.Version == "" || manifest.Version == version {
		return false
	}

	target := runtime.GOOS + "_" + runtime.GOARCH
	entry, ok := manifest.Binaries[target]
	if !ok {
		log.Printf("self-update: %s publishes no build for %s", base, target)
		return false
	}

	// Deliberately not a version comparison. These are `git describe` strings
	// rather than semver, and inventing an ordering for them would be inventing
	// a wrong one. "Different" means update, which does mean the control plane
	// could move an agent backwards — it is already the authority on whether
	// that agent may connect at all, so this grants it nothing new.
	log.Printf("self-update: %s -> %s", version, manifest.Version)

	if err := replaceSelf(ctx, base, entry.File, entry.SHA256); err != nil {
		log.Printf("self-update failed, continuing on %s: %v", version, err)
		return false
	}

	log.Printf("self-update: installed %s, restarting", manifest.Version)
	return true
}

/*
runUpgrade is the same update, asked for on purpose.

The automatic one happens at startup and nowhere else, which is right for a
machine nobody is sitting at — and wrong for the person who is. They have just
been told a fix exists, and their options were to restart a service and hope
that was what "checks at startup" meant, or to read this file. Neither is an
answer to "update it".

It also gives an honest way to look without touching anything: --check prints
what the deployment publishes against what is running, which is the question
behind most of the times somebody would have run the upgrade.
*/
func runUpgrade(args []string) error {
	fs := flag.NewFlagSet("upgrade", flag.ExitOnError)
	configPath := fs.String("config", DefaultConfigPath, "path to the agent identity")
	check := fs.Bool("check", false, "say what is published, and install nothing")
	force := fs.Bool("force", false, "reinstall even when the published build reports the same version")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if cfg.ReleaseURL == "" {
		return fmt.Errorf("this agent has no release URL, so there is nowhere to upgrade from.\n\n" +
			"It was enrolled before self-update existed. Re-enrolling from the dashboard fixes\n" +
			"that permanently — and until then, replacing the binary by hand is the only route")
	}

	base, err := releaseBase(cfg.ReleaseURL)
	if err != nil {
		return err
	}

	ctx := context.Background()
	manifest, err := fetchManifest(ctx, base)
	if err != nil {
		return err
	}

	fmt.Printf("Running:   %s\n", version)
	fmt.Printf("Published: %s (%s)\n", manifest.Version, base)

	target := runtime.GOOS + "_" + runtime.GOARCH
	entry, ok := manifest.Binaries[target]
	if !ok {
		return fmt.Errorf("%s publishes no build for %s", base, target)
	}

	// Same rule as the automatic path: different means update, because these are
	// `git describe` strings and an ordering invented for them would be wrong in
	// exactly the case that matters — a deployment rolling its fleet back.
	same := manifest.Version == version
	if *check {
		if same {
			fmt.Println("\nUp to date.")
		} else {
			fmt.Println("\nA different build is published. Install it: weirdvault upgrade")
		}
		return nil
	}
	if same && !*force {
		fmt.Println("\nUp to date. Nothing to do (--force reinstalls anyway).")
		return nil
	}

	if err := replaceSelf(ctx, base, entry.File, entry.SHA256); err != nil {
		// Writing next to the running binary is the step that needs root, and it
		// is the one people hit — /usr/local/bin is not theirs to write.
		return sudoHint(fmt.Errorf("could not install %s: %w", manifest.Version, err), "upgrade")
	}
	fmt.Printf("\nInstalled %s.\n", manifest.Version)

	// The new binary is on disk; the process holding the connection is still the
	// old one. Restarting is the whole point of having asked, so it happens here
	// rather than being left as a sentence somebody has to notice.
	st := currentState()
	switch {
	case st.Installed && st.Active:
		if err := runRestart(nil); err != nil {
			return fmt.Errorf("installed, but could not restart the service: %w", err)
		}
	case st.Installed:
		fmt.Println("The service is not running, so nothing needed restarting.")
	case len(agentProcesses()) > 0:
		fmt.Println("An agent started by hand is still running the old build. Stop and start it")
		fmt.Println("to pick this up: weirdvault stop")
	}
	return nil
}

// releaseBase validates where updates may come from.
func releaseBase(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("release URL is unparseable: %w", err)
	}
	if u.Scheme == "http" && !isLoopback(u.Hostname()) {
		// The one hard refusal in this file. A root-executed binary fetched over
		// plaintext, unattended, forever, is remote code execution for anyone on
		// the path.
		return "", fmt.Errorf("refusing to self-update over plaintext http from %s", u.Host)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("release URL must be http or https, got %q", u.Scheme)
	}
	return strings.TrimRight(raw, "/"), nil
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func fetchManifest(ctx context.Context, base string) (*releaseManifest, error) {
	body, err := get(ctx, base+"/manifest.json", 1<<20)
	if err != nil {
		return nil, fmt.Errorf("could not read the release manifest: %w", err)
	}
	var m releaseManifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, fmt.Errorf("release manifest is not readable: %w", err)
	}
	return &m, nil
}

// replaceSelf downloads, verifies, and swaps the running binary.
func replaceSelf(ctx context.Context, base, file, wantSHA string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	// Resolved because the path may be a symlink, and replacing the link rather
	// than its target would leave the real binary stale and the link pointing at
	// a file the package manager does not know about.
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		return err
	}

	binary, err := get(ctx, base+"/"+file, 128<<20)
	if err != nil {
		return err
	}

	sum := sha256.Sum256(binary)
	if got := hex.EncodeToString(sum[:]); !strings.EqualFold(got, wantSHA) {
		return fmt.Errorf("checksum mismatch: manifest says %s, download is %s", wantSHA, got)
	}

	// Written beside the target, not in /tmp: rename is only atomic within a
	// filesystem, and a cross-device rename would fall back to a copy that can
	// be interrupted halfway — leaving a truncated binary where the agent was.
	dir := filepath.Dir(self)
	tmp, err := os.CreateTemp(dir, ".weirdvault-*")
	if err != nil {
		return fmt.Errorf("cannot write to %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeds

	if _, err := tmp.Write(binary); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return err
	}
	// Closed before the rename: on some systems replacing a file that is still
	// open for writing is refused outright.
	if err := tmp.Close(); err != nil {
		return err
	}

	// The replacement inherits the ownership of what it replaces.
	//
	// Both accounts write this file. The service runs unprivileged and updates
	// itself at startup; a person runs `weirdvault upgrade` with sudo. Left
	// alone, the second leaves a root-owned binary in a directory the service
	// account owns — and the next automatic update fails on a file it can no
	// longer replace, one release later, with nobody connecting the two events.
	if err := preserveOwner(self, tmpName); err != nil {
		return err
	}

	return os.Rename(tmpName, self)
}

// preserveOwner gives the replacement the same owner as the file it replaces.
//
// A no-op when they already match, which is the common case — the service
// updating itself — because chown to the identity it already has is a syscall
// that can only fail. Failures are otherwise ignored for the same reason
// `upgrade` works at all when run by the owner: a non-root process cannot chown
// and does not need to.
func preserveOwner(existing, replacement string) error {
	info, err := os.Stat(existing)
	if err != nil {
		return nil // being replaced for the first time; nothing to inherit
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}

	current, err := os.Stat(replacement)
	if err != nil {
		return err
	}
	if now, ok := current.Sys().(*syscall.Stat_t); ok && now.Uid == stat.Uid && now.Gid == stat.Gid {
		return nil
	}

	if err := os.Chown(replacement, int(stat.Uid), int(stat.Gid)); err != nil {
		// Only fatal for root, which is the case that would otherwise produce the
		// silently-broken install described above. An unprivileged process that
		// cannot chown is one whose write already landed as the right user.
		if os.Geteuid() == 0 {
			return fmt.Errorf("could not keep %s owned by uid %d: %w", existing, stat.Uid, err)
		}
	}
	return nil
}

func get(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, updateTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned %d", rawURL, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}
