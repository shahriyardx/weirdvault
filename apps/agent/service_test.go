package main

import (
	"strings"
	"testing"
	"time"
)

// What counts as "an agent is running here".
//
// The match has to be narrow in one direction and wide in the other: a shell
// that happens to mention the binary must not be counted, or `stop` sends
// SIGTERM to somebody's editor; and a binary still carrying its release suffix
// must be, because that is what a machine looks like when somebody ran the
// download rather than installing it.
func TestIsAgentRun(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want bool
	}{
		{"installed binary", []string{"/usr/local/bin/weirdvault-agent", "run"}, true},
		{"with a config", []string{"/usr/local/bin/weirdvault-agent", "run", "--config=/etc/x.json"}, true},
		{"release name kept", []string{"./weirdvault-agent_linux_amd64", "run"}, true},
		{"another subcommand", []string{"/usr/local/bin/weirdvault-agent", "status"}, false},
		{"no subcommand", []string{"/usr/local/bin/weirdvault-agent"}, false},
		{"an editor holding the name", []string{"/usr/bin/vim", "run", "weirdvault-agent"}, false},
		{"empty", nil, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isAgentRun(tc.argv); got != tc.want {
				t.Errorf("isAgentRun(%v) = %v, want %v", tc.argv, got, tc.want)
			}
		})
	}
}

// Which identity a running process is using. Getting this wrong shows a second
// enrolment's state against the first one's row, which is worse than showing
// nothing.
func TestConfigFromArgs(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want string
	}{
		{"default when unsaid", []string{"weirdvault-agent", "run"}, DefaultConfigPath},
		{"long form", []string{"weirdvault-agent", "run", "--config=/etc/a.json"}, "/etc/a.json"},
		{"single dash", []string{"weirdvault-agent", "run", "-config=/etc/b.json"}, "/etc/b.json"},
		{"separate value", []string{"weirdvault-agent", "run", "--config", "/etc/c.json"}, "/etc/c.json"},
		{"after another flag", []string{"weirdvault-agent", "run", "--no-update", "--config=/etc/d.json"}, "/etc/d.json"},
		{"flag with no value", []string{"weirdvault-agent", "run", "--config"}, DefaultConfigPath},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := configFromArgs(tc.argv); got != tc.want {
				t.Errorf("configFromArgs(%v) = %q, want %q", tc.argv, got, tc.want)
			}
		})
	}
}

// ps's elapsed column, which is the only uptime available on macOS.
func TestParseETime(t *testing.T) {
	cases := []struct {
		in   string
		want time.Duration
		ok   bool
	}{
		{"05:03", 5*time.Minute + 3*time.Second, true},
		{"01:05:03", time.Hour + 5*time.Minute + 3*time.Second, true},
		{"2-01:05:03", 48*time.Hour + time.Hour + 5*time.Minute + 3*time.Second, true},
		{"", 0, false},
		{"garbage", 0, false},
		{"1:2:3:4", 0, false},
	}

	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, ok := parseETime(tc.in)
			if ok != tc.ok || got != tc.want {
				t.Errorf("parseETime(%q) = %v, %v; want %v, %v", tc.in, got, ok, tc.want, tc.ok)
			}
		})
	}
}

// The plist is written once and then run as root forever, so the parts that
// make it safe rather than merely working are pinned here: the exact config it
// was told to use, and a KeepAlive that does not undo a deliberate stop.
func TestLaunchdPlist(t *testing.T) {
	plist := launchdPlist("/usr/local/bin/weirdvault-agent", "/etc/weirdvault-agent/agent.json", false)

	for _, want := range []string{
		"<string>" + launchdLabel + "</string>",
		"<string>/usr/local/bin/weirdvault-agent</string>",
		"<string>run</string>",
		"<string>--config=/etc/weirdvault-agent/agent.json</string>",
		"<key>RunAtLoad</key>",
		"<key>SuccessfulExit</key>",
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("plist is missing %q:\n%s", want, plist)
		}
	}

	if strings.Contains(plist, "--no-update") {
		t.Error("plist disabled updates without being asked to")
	}
	if got := launchdPlist("/usr/local/bin/weirdvault-agent", "/etc/a.json", true); !strings.Contains(got, "<string>--no-update</string>") {
		t.Error("--no-update was asked for and did not reach the plist")
	}
}

// A path with an ampersand in it is legal and produces a plist launchd rejects
// as malformed — complaining about the file, not the character.
func TestLaunchdPlistEscapes(t *testing.T) {
	plist := launchdPlist("/opt/a&b/weirdvault-agent", "/etc/x.json", false)
	if !strings.Contains(plist, "/opt/a&amp;b/weirdvault-agent") {
		t.Errorf("path was not escaped:\n%s", plist)
	}
}

// serviceConfigPath reads the config out of what the supervisor recorded. Both
// formats are quoted differently, and reading past the end of the argument
// would produce a path that matches no row in `list`.
func TestServiceConfigPathParsing(t *testing.T) {
	// The shape systemctl show -p ExecStart --value prints.
	systemd := `{ path=/usr/local/bin/weirdvault-agent ; argv[]=/usr/local/bin/weirdvault-agent run --config=/etc/weirdvault-agent/agent.json ; ignore_errors=no }`
	if got := extractConfigFlag(systemd); got != "/etc/weirdvault-agent/agent.json" {
		t.Errorf("systemd ExecStart: got %q", got)
	}

	plist := launchdPlist("/usr/local/bin/weirdvault-agent", "/etc/weirdvault-agent/agent.json", false)
	if got := extractConfigFlag(plist); got != "/etc/weirdvault-agent/agent.json" {
		t.Errorf("launchd plist: got %q", got)
	}

	if got := extractConfigFlag("nothing here"); got != DefaultConfigPath {
		t.Errorf("no flag present: got %q, want the default", got)
	}
}

func TestHumanUptime(t *testing.T) {
	now := time.Now()
	cases := []struct {
		since time.Time
		want  string
	}{
		{time.Time{}, "?"},
		{now.Add(-30 * time.Second), "30s"},
		{now.Add(-90 * time.Second), "1m"},
		{now.Add(-3*time.Hour - 12*time.Minute), "3h12m"},
		{now.Add(-49 * time.Hour), "2d1h"},
	}

	for _, tc := range cases {
		if got := humanUptime(tc.since); got != tc.want {
			t.Errorf("humanUptime(%v) = %q, want %q", tc.since, got, tc.want)
		}
	}
}
