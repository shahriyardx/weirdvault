package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
	tmp, err := os.CreateTemp(dir, ".weirdvault-agent-*")
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

	return os.Rename(tmpName, self)
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
