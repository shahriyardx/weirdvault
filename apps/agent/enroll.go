package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

const enrollTimeout = 30 * time.Second

type enrollRequest struct {
	Token     string `json:"token"`
	PublicKey string `json:"publicKey"`
	Hostname  string `json:"hostname"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Version   string `json:"version"`
}

type enrollResponse struct {
	AgentID    string `json:"agentId"`
	RelayURL   string `json:"relayUrl"`
	ReleaseURL string `json:"releaseUrl"`
	Error      string `json:"error"`
}

// runEnroll trades a one-time token for a lasting identity.
//
// The keypair is generated here and the private half never leaves the machine —
// the server is sent a public key and learns nothing it could use to impersonate
// this agent. That is the same shape as the rest of the product: the thing that
// proves who you are is created where you are.
func runEnroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	token := fs.String("token", "", "one-time enrollment token from the dashboard")
	appURL := fs.String("url", "", "base URL of your weirdvault deployment")
	configPath := fs.String("config", DefaultConfigPath, "where to write the agent identity")
	port := fs.Int("ssh-port", 22, "the local sshd port to forward to")
	force := fs.Bool("force", false, "overwrite an existing enrollment")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *token == "" || *appURL == "" {
		return fmt.Errorf("both --token and --url are required")
	}

	// Refusing rather than overwriting. An accidental re-enrol would orphan the
	// existing agent row: the machine would come back under a new id, the old
	// host entry in somebody's vault would point at an agent that never
	// reconnects, and the only symptom is a host that is permanently offline.
	if _, err := os.Stat(*configPath); err == nil && !*force {
		return fmt.Errorf(
			"%s already exists — this machine is already enrolled. Pass --force to replace it, "+
				"and revoke the old agent in the dashboard afterwards", *configPath)
	}

	base := strings.TrimRight(*appURL, "/")
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return fmt.Errorf("--url must start with http:// or https://")
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fmt.Errorf("could not generate a key: %w", err)
	}

	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "unknown"
	}

	body, err := json.Marshal(enrollRequest{
		Token:     *token,
		PublicKey: base64.StdEncoding.EncodeToString(pub),
		Hostname:  hostname,
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
		Version:   version,
	})
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: enrollTimeout}
	resp, err := client.Post(base+"/api/agents/enroll", "application/json", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("could not reach %s: %w", base, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return fmt.Errorf("could not read the response: %w", err)
	}

	var out enrollResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		// An empty body is the common shape of a server-side crash, and printing
		// nothing after the colon reads as the message being cut off rather than
		// as the fact it is. Say which, because the two send you to different
		// places: a body means the server had an opinion, none means look at its
		// logs.
		detail := truncate(string(raw), 200)
		if len(bytes.TrimSpace(raw)) == 0 {
			detail = "(empty body — check the server's logs)"
		}
		return fmt.Errorf("unreadable response from %s (%d): %s", base, resp.StatusCode, detail)
	}
	if resp.StatusCode != http.StatusOK {
		if out.Error != "" {
			return fmt.Errorf("enrollment refused: %s", out.Error)
		}
		return fmt.Errorf("enrollment refused (%d)", resp.StatusCode)
	}
	if out.AgentID == "" || out.RelayURL == "" {
		return fmt.Errorf("the server accepted the enrollment but returned no identity")
	}

	cfg := &Config{
		AgentID: out.AgentID,
		// The seed, not the 64-byte expanded key: it is half the bytes and the
		// expanded form is derivable from it, so storing both would be storing
		// the same secret twice.
		PrivateKey:   base64.StdEncoding.EncodeToString(priv.Seed()),
		RelayURL:     out.RelayURL,
		ReleaseURL:   out.ReleaseURL,
		AllowedPorts: []int{*port},
	}
	if err := saveConfig(*configPath, cfg); err != nil {
		return fmt.Errorf("could not write %s: %w", *configPath, err)
	}

	fmt.Printf("Enrolled as %s\n", out.AgentID)
	fmt.Printf("Fingerprint: %s\n", fingerprint(pub))
	fmt.Printf("Forwarding to 127.0.0.1:%d\n\n", *port)
	fmt.Printf("Check that fingerprint against the one on the enrollment page before\n")
	fmt.Printf("you adopt this machine. Then: systemctl enable --now weirdvault-agent\n")
	return nil
}

// runStatus prints what this machine's identity is, without connecting.
//
// The fingerprint is the point: it is what somebody compares against the
// dashboard when they are not sure whether the machine in front of them is the
// one the browser is showing.
//
// It also answers the question people were actually asking when they ran it.
// Identity alone left "is this thing even running?" to systemctl, which meant
// knowing the unit's name — so the running state is here too, in the words the
// rest of the CLI uses.
func runStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	configPath := fs.String("config", DefaultConfigPath, "path to the agent identity")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	priv, err := cfg.privateKey()
	if err != nil {
		return err
	}

	fmt.Printf("Agent:       %s\n", cfg.AgentID)
	fmt.Printf("Version:     %s\n", version)
	fmt.Printf("Fingerprint: %s\n", fingerprint(priv.Public().(ed25519.PublicKey)))
	fmt.Printf("Relay:       %s\n", cfg.RelayURL)
	fmt.Printf("Forwards to: 127.0.0.1:%v\n", cfg.AllowedPorts)
	if cfg.ReleaseURL == "" {
		fmt.Printf("Updates:     off (enrolled before self-update; re-enrol to enable)\n")
	} else {
		fmt.Printf("Updates:     %s\n", cfg.ReleaseURL)
	}

	printRunningState(*configPath)
	return nil
}

// printRunningState says whether the agent is up, and whether it will be after
// a reboot.
//
// The process list is what makes this trustworthy rather than merely
// supervisor-shaped. A service reporting "inactive" while somebody's
// hand-started copy holds the connection open is the exact state that makes
// people distrust the whole command, so both are printed and neither is
// inferred from the other.
func printRunningState(configPath string) {
	st := currentState()
	procs := agentProcesses()

	fmt.Println()
	switch {
	case st.Installed && st.Active:
		fmt.Printf("Running:     yes, as a %s service", st.Kind)
		if st.PID != 0 {
			fmt.Printf(" (pid %d)", st.PID)
		}
		fmt.Println()
	case st.Installed:
		fmt.Printf("Running:     no — %s service is %s\n", st.Kind, st.Detail)
	case len(procs) > 0:
		fmt.Printf("Running:     yes, started by hand (pid %s)\n", pidList(procs))
	default:
		fmt.Printf("Running:     no\n")
	}

	switch {
	case !st.Installed:
		fmt.Printf("At boot:     nothing will start it — no service is registered here\n")
	case st.Enabled:
		fmt.Printf("At boot:     starts automatically\n")
	default:
		fmt.Printf("At boot:     stays stopped (weirdvault-agent start changes that)\n")
	}

	// Only when it adds something: a supervised agent whose one process is the
	// service's own does not need the same pid printed twice.
	if strays := strayProcesses(st); len(strays) > 0 && st.Installed {
		fmt.Printf("Also:        %d process(es) running outside the service (pid %s)\n",
			len(strays), pidList(strays))
	}

	// The identity printed above and the one the service runs are the same file
	// almost always — and when they are not, every line above is about a machine
	// the dashboard is not showing. Saying which file the service uses is the
	// difference between that being obvious and being invisible.
	if service := serviceConfigPath(st); st.Installed && service != configPath {
		fmt.Printf("Note:        the service runs a different identity: %s\n", service)
	}
}

// privateKey decodes the stored seed.
func (c *Config) privateKey() (ed25519.PrivateKey, error) {
	seed, err := base64.StdEncoding.DecodeString(c.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("privateKey is not valid base64: %w", err)
	}
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("privateKey is %d bytes, expected %d", len(seed), ed25519.SeedSize)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
