package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// DefaultConfigPath is where the installer puts the file. Overridable with
// --config so the agent can be run as an unprivileged user for testing without
// touching /etc.
const DefaultConfigPath = "/etc/weirdvault-agent/agent.json"

// Config is everything the agent knows about itself.
//
// The private key lives here in plaintext, which is the honest arrangement: the
// alternative is a passphrase nobody is present to type when systemd starts the
// service at boot. What protects it is file permissions and the fact that it is
// worth so little — see the header in main.go for what an attacker who steals it
// actually gets, which is a pipe to a port they could reach anyway if they are
// already reading files as root on that machine.
type Config struct {
	AgentID string `json:"agentId"`
	// Base64 (std, padded) of the 32-byte Ed25519 seed.
	PrivateKey string `json:"privateKey"`
	// Base of the agent endpoints, e.g. wss://app.example.com/agent. The two
	// paths below it are appended rather than stored, so a deployment that moves
	// does not need two fields kept in step.
	RelayURL string `json:"relayUrl"`
	// Ports on loopback this agent will forward to. Anything not in here is
	// refused however the request arrives.
	AllowedPorts []int `json:"allowedPorts"`
	// Where newer builds are published, from the deployment that enrolled this
	// machine. Empty on an agent enrolled before self-update existed, which
	// disables the check rather than guessing a URL to download root-executed
	// binaries from.
	ReleaseURL string `json:"releaseUrl,omitempty"`
}

func (c *Config) controlURL() string { return c.RelayURL + "/control" }
func (c *Config) streamURL() string  { return c.RelayURL + "/stream" }

// allows reports whether the agent will forward to this port.
//
// The relay names the port in its open request, and the relay takes that from a
// query parameter the browser set. So this list is the only thing standing
// between "somebody can reach your SSH server" and "somebody can reach anything
// listening on loopback on your machine" — including the database that is bound
// to 127.0.0.1 precisely because it was assumed unreachable.
func (c *Config) allows(port int) bool {
	for _, p := range c.AllowedPorts {
		if p == port {
			return true
		}
	}
	return false
}

func (c *Config) validate() error {
	switch {
	case c.AgentID == "":
		return errors.New("config has no agentId")
	case c.PrivateKey == "":
		return errors.New("config has no privateKey")
	case c.RelayURL == "":
		return errors.New("config has no relayUrl")
	case len(c.AllowedPorts) == 0:
		return errors.New("config has no allowedPorts, so this agent can forward nothing")
	}
	return nil
}

func loadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%s does not exist — run `weirdvault-agent enroll` first", path)
		}
		return nil, err
	}

	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("%s is not readable as JSON: %w", path, err)
	}
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &cfg, nil
}

// saveConfig writes the file readable only by its owner.
//
// The mode is set with OpenFile rather than a chmod afterwards, because a chmod
// leaves a window — however short — in which the private key is on disk and
// world-readable. Directories are created 0700 for the same reason.
func saveConfig(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}

	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')

	// Written to a temporary file and renamed, so an interrupted write cannot
	// leave a half-written config that the service then fails to start with.
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}
