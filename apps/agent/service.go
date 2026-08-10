package main

/*
Starting and stopping the agent, and whether it comes back at boot.

Everything here is a thin, honest wrapper over whatever supervises the agent on
this machine — systemd on Linux, launchd on macOS, nothing at all when somebody
started it by hand. It exists because the alternative is what shipped first: a
person who wants their machine to stop being reachable for an afternoon has to
know they are looking for a systemd unit, know its name, and know that
`systemctl stop` alone means it is back the moment the box reboots. Three facts
none of which the product ever told them.

# Why `stop` also stops it at boot

`systemctl stop` is a statement about right now, and almost nobody means it that
way. "Stop the agent" is said by somebody who wants the machine off the network
until they say otherwise, and a reboot two days later silently undoing that is
the kind of surprise that ends with a machine reachable when its owner believes
it is not. So `stop` disables it as well and says so in one line, `start` enables
it again, and `--keep-enabled` is there for the person who genuinely meant only
this run.

The pair that touches boot alone — `enable` and `disable` — is still here for
somebody who wants the running process left as it is.

# Why this shells out

systemd and launchd both have richer interfaces than their CLIs. Neither is
worth binding to from a program whose entire job is to hold one socket open: the
CLI is the surface every operator already knows, its output is what they would
have seen anyway, and a wrapper that reports something different from
`systemctl status` is worse than no wrapper.
*/

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"
)

const (
	systemdUnit     = "weirdvault-agent.service"
	systemdUnitPath = "/etc/systemd/system/weirdvault-agent.service"

	launchdLabel     = "com.weirdvault.agent"
	launchdPlistPath = "/Library/LaunchDaemons/com.weirdvault.agent.plist"
	launchdLogPath   = "/var/log/weirdvault-agent.log"

	// The name a process must have been started as to be one of ours. Matched as
	// a prefix because a release binary keeps its platform suffix when somebody
	// runs it out of the download directory rather than installing it.
	agentBinaryPrefix = "weirdvault-agent"
)

// supervisorKind is what keeps the agent running on this machine.
type supervisorKind string

const (
	supervisorSystemd supervisorKind = "systemd"
	supervisorLaunchd supervisorKind = "launchd"
	supervisorNone    supervisorKind = "none"
)

// serviceState is one answer to "is it running, and will it come back".
//
// Enabled and Active are deliberately separate. They are the two questions
// people actually have, they fail independently — an enabled service that
// crashed on boot is not running, a running service that was never enabled
// vanishes at the next reboot — and every tool that collapses them into one
// word makes somebody guess which one it meant.
type serviceState struct {
	Kind supervisorKind
	// A unit or plist this program knows how to control exists.
	Installed bool
	// Starts by itself at boot.
	Enabled bool
	// Running right now.
	Active bool
	// The supervisor's own words, e.g. "active (running)" or "inactive (dead)".
	Detail string
	// The supervised process, when there is one.
	PID int
}

// agentProcess is a `weirdvault-agent run` seen in the process table.
//
// Found by looking rather than by a pidfile: a pidfile is a claim about the
// past that survives a kill -9, and the question being answered here is what is
// running now. It also finds the processes this program never started — the one
// somebody launched in a terminal to debug something and forgot, which is the
// single most common reason two agents fight over one machine.
type agentProcess struct {
	PID     int
	Config  string
	Started time.Time // zero when this platform would not say
}

// ---------------------------------------------------------------- detection

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func haveCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// detectSupervisor reports what supervises services here, whether or not the
// agent is installed under it.
//
// The distinction matters for the message a user gets: "systemd is here and the
// agent is not installed under it" sends them to the installer, while "there is
// no systemd here" sends them somewhere else entirely.
func detectSupervisor() supervisorKind {
	switch runtime.GOOS {
	case "linux":
		// Not just the binary: systemctl exists inside containers where PID 1 is
		// not systemd, and every call there fails with a message about D-Bus that
		// explains nothing.
		if haveCommand("systemctl") && fileExists("/run/systemd/system") {
			return supervisorSystemd
		}
	case "darwin":
		if haveCommand("launchctl") {
			return supervisorLaunchd
		}
	}
	return supervisorNone
}

// runCmd runs a command and returns its combined output, trimmed.
//
// Combined because the supervisors write the interesting part to stderr —
// `systemctl is-enabled` prints "disabled" to stdout and exits non-zero, but
// `launchctl bootout` explains itself only on stderr, and a wrapper that showed
// one and swallowed the other would be silent exactly when something went
// wrong.
func runCmd(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// sudoHint appends the advice that is right nearly every time a supervisor
// refuses, without pretending to know that permission was the problem.
func sudoHint(err error, verb string) error {
	if os.Geteuid() == 0 {
		return err
	}
	return fmt.Errorf("%w\n\nThis manages a system service, so it usually needs root:\n  sudo %s %s",
		err, filepath.Base(os.Args[0]), verb)
}

// ---------------------------------------------------------------- state

func currentState() serviceState {
	switch detectSupervisor() {
	case supervisorSystemd:
		return systemdState()
	case supervisorLaunchd:
		return launchdState()
	default:
		return serviceState{Kind: supervisorNone}
	}
}

func systemdState() serviceState {
	st := serviceState{Kind: supervisorSystemd, Installed: fileExists(systemdUnitPath)}

	// Output rather than exit status throughout: `is-enabled` exits non-zero for
	// a disabled unit, which is an answer and not an error, and treating it as
	// one would report every stopped agent as a broken query.
	enabled, _ := runCmd("systemctl", "is-enabled", systemdUnit)
	st.Enabled = enabled == "enabled" || enabled == "enabled-runtime" || enabled == "static"

	active, _ := runCmd("systemctl", "is-active", systemdUnit)
	st.Active = active == "active" || active == "activating"

	sub, _ := runCmd("systemctl", "show", "-p", "SubState", "--value", systemdUnit)
	st.Detail = strings.TrimSpace(active + " (" + sub + ")")
	if sub == "" {
		st.Detail = active
	}

	if pid, err := runCmd("systemctl", "show", "-p", "MainPID", "--value", systemdUnit); err == nil {
		if n, err := strconv.Atoi(pid); err == nil && n > 0 {
			st.PID = n
		}
	}
	return st
}

func launchdState() serviceState {
	st := serviceState{Kind: supervisorLaunchd, Installed: fileExists(launchdPlistPath)}

	// `print` exits non-zero when the job is not loaded, which is the answer.
	out, err := runCmd("launchctl", "print", "system/"+launchdLabel)
	if err == nil {
		st.Active = strings.Contains(out, "state = running")
		st.PID = launchdPID(out)
		if st.Active {
			st.Detail = "running"
		} else {
			// Loaded but not running: launchd is holding the job and waiting,
			// usually because it exited and KeepAlive is throttling the restart.
			st.Detail = "loaded, not running"
		}
	} else {
		st.Detail = "not loaded"
	}

	st.Enabled = st.Installed && !launchdDisabled()
	return st
}

// launchdPID pulls the pid out of `launchctl print`, which prints it as
// "pid = 1234" among a hundred other lines.
func launchdPID(out string) int {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "pid = ") {
			continue
		}
		if n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "pid = "))); err == nil {
			return n
		}
	}
	return 0
}

// launchdDisabled reports whether the disabled database says this job must not
// start.
//
// The two spellings are two macOS versions. Older ones print `"label" => true`
// and newer ones `"label" => disabled`, and a check that knew only one of them
// would report a disabled agent as ready to start on half the Macs in use.
func launchdDisabled() bool {
	out, err := runCmd("launchctl", "print-disabled", "system")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, launchdLabel) {
			continue
		}
		return strings.Contains(line, "=> true") || strings.Contains(line, "=> disabled")
	}
	return false
}

// ---------------------------------------------------------------- processes

// agentProcesses lists every `weirdvault-agent run` on this machine, including
// ones no supervisor knows about.
func agentProcesses() []agentProcess {
	if runtime.GOOS == "linux" {
		return procfsProcesses()
	}
	return psProcesses()
}

// isAgentRun reports whether an argv is one of our run processes.
func isAgentRun(argv []string) bool {
	if len(argv) < 2 {
		return false
	}
	return strings.HasPrefix(filepath.Base(argv[0]), agentBinaryPrefix) && argv[1] == "run"
}

// configFromArgs recovers which identity a running process is using, so `list`
// can line a process up with a config rather than reporting two facts that the
// reader has to join by hand.
func configFromArgs(argv []string) string {
	for i := 2; i < len(argv); i++ {
		arg := argv[i]
		for _, flagName := range []string{"--config", "-config"} {
			if strings.HasPrefix(arg, flagName+"=") {
				return strings.TrimPrefix(arg, flagName+"=")
			}
			if arg == flagName && i+1 < len(argv) {
				return argv[i+1]
			}
		}
	}
	return DefaultConfigPath
}

// procfsProcesses reads the process table directly.
//
// No `ps`: the smallest Linux images ship busybox, whose ps takes none of the
// flags the real one does, and an agent that cannot list itself on a container
// host is exactly where somebody most needs it to.
func procfsProcesses() []agentProcess {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}

	var found []agentProcess
	self := os.Getpid()
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == self {
			continue
		}

		raw, err := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		if err != nil {
			continue // exited between the readdir and here, or not ours to read
		}
		argv := strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
		if !isAgentRun(argv) {
			continue
		}

		proc := agentProcess{PID: pid, Config: configFromArgs(argv)}
		// The directory's mtime is when the process started. Cheaper and far less
		// brittle than parsing field 22 of /proc/pid/stat and converting clock
		// ticks against /proc/uptime, for an answer printed to the minute.
		if fi, err := os.Stat("/proc/" + entry.Name()); err == nil {
			proc.Started = fi.ModTime()
		}
		found = append(found, proc)
	}
	return found
}

// psProcesses is the same list on macOS, where there is no /proc.
func psProcesses() []agentProcess {
	out, err := runCmd("ps", "-axo", "pid=,etime=,args=")
	if err != nil {
		return nil
	}

	var found []agentProcess
	self := os.Getpid()
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid == self {
			continue
		}
		argv := fields[2:]
		if !isAgentRun(argv) {
			continue
		}

		proc := agentProcess{PID: pid, Config: configFromArgs(argv)}
		if elapsed, ok := parseETime(fields[1]); ok {
			proc.Started = time.Now().Add(-elapsed)
		}
		found = append(found, proc)
	}
	return found
}

// parseETime reads ps's elapsed-time column: [[DD-]HH:]MM:SS.
func parseETime(s string) (time.Duration, bool) {
	var days int
	if before, after, ok := strings.Cut(s, "-"); ok {
		n, err := strconv.Atoi(before)
		if err != nil {
			return 0, false
		}
		days, s = n, after
	}

	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, false
	}
	var nums []int
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return 0, false
		}
		nums = append(nums, n)
	}

	var hours, minutes, seconds int
	if len(nums) == 3 {
		hours, minutes, seconds = nums[0], nums[1], nums[2]
	} else {
		minutes, seconds = nums[0], nums[1]
	}

	return time.Duration(days)*24*time.Hour +
		time.Duration(hours)*time.Hour +
		time.Duration(minutes)*time.Minute +
		time.Duration(seconds)*time.Second, true
}

// humanUptime renders a duration the way somebody reads it out loud.
func humanUptime(since time.Time) string {
	if since.IsZero() {
		return "?"
	}
	d := time.Since(since)
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh%dm", int(d.Hours()), int(d.Minutes())%60)
	default:
		return fmt.Sprintf("%dd%dh", int(d.Hours())/24, int(d.Hours())%24)
	}
}

// signalProcesses asks the listed processes to stop, the way a supervisor
// would.
//
// SIGTERM and not SIGKILL: the agent handles SIGTERM by closing its sockets, so
// sessions it is carrying end rather than being cut mid-byte. A process that
// ignores it is reported rather than escalated — killing something that refused
// to stop is a decision for the person watching, not for a CLI wrapper.
func signalProcesses(procs []agentProcess) (stopped []int, failed []error) {
	for _, proc := range procs {
		if err := syscall.Kill(proc.PID, syscall.SIGTERM); err != nil {
			failed = append(failed, fmt.Errorf("pid %d: %w", proc.PID, err))
			continue
		}
		stopped = append(stopped, proc.PID)
	}
	return stopped, failed
}

// ---------------------------------------------------------------- commands

// runStart starts the agent and makes it start at boot.
func runStart(args []string) error {
	fs := flag.NewFlagSet("start", flag.ExitOnError)
	bootOnly := fs.Bool("boot-only", false, "make it start at boot without starting it now")
	if err := fs.Parse(args); err != nil {
		return err
	}

	st := currentState()
	switch {
	case st.Kind == supervisorSystemd && st.Installed:
		if *bootOnly {
			if out, err := runCmd("systemctl", "enable", systemdUnit); err != nil {
				return sudoHint(fmt.Errorf("systemctl enable: %s", out), "start --boot-only")
			}
			fmt.Println("The agent will start at boot. It is not running yet — `weirdvault-agent start`.")
			return nil
		}
		if out, err := runCmd("systemctl", "enable", "--now", systemdUnit); err != nil {
			return sudoHint(fmt.Errorf("systemctl enable --now: %s", out), "start")
		}

	case st.Kind == supervisorLaunchd && st.Installed:
		// Enable first: a job in the disabled database cannot be bootstrapped,
		// and the error launchd gives for that says "Operation not permitted",
		// which sends people looking for a permissions problem they do not have.
		if out, err := runCmd("launchctl", "enable", "system/"+launchdLabel); err != nil {
			return sudoHint(fmt.Errorf("launchctl enable: %s", out), "start")
		}
		if *bootOnly {
			fmt.Println("The agent will start at boot. It is not running yet — `weirdvault-agent start`.")
			return nil
		}
		// Already-bootstrapped is not a failure here: `start` is a statement
		// about the state you want, and it is already true.
		if out, err := runCmd("launchctl", "bootstrap", "system", launchdPlistPath); err != nil {
			if !strings.Contains(out, "already") && !strings.Contains(out, "service already loaded") {
				return sudoHint(fmt.Errorf("launchctl bootstrap: %s", out), "start")
			}
		}

	default:
		return notInstalledError(st, "start")
	}

	fmt.Println("Started, and it will start again at boot.")
	fmt.Println("It should appear online in the dashboard within a few seconds.")
	return nil
}

// runStop stops the agent, and by default keeps it stopped across reboots.
func runStop(args []string) error {
	fs := flag.NewFlagSet("stop", flag.ExitOnError)
	keepEnabled := fs.Bool("keep-enabled", false, "stop it now, but let it start again at the next boot")
	if err := fs.Parse(args); err != nil {
		return err
	}

	st := currentState()
	switch {
	case st.Kind == supervisorSystemd && st.Installed:
		if *keepEnabled {
			if out, err := runCmd("systemctl", "stop", systemdUnit); err != nil {
				return sudoHint(fmt.Errorf("systemctl stop: %s", out), "stop --keep-enabled")
			}
		} else if out, err := runCmd("systemctl", "disable", "--now", systemdUnit); err != nil {
			return sudoHint(fmt.Errorf("systemctl disable --now: %s", out), "stop")
		}

	case st.Kind == supervisorLaunchd && st.Installed:
		if out, err := runCmd("launchctl", "bootout", "system/"+launchdLabel); err != nil {
			// Not loaded is the state being asked for, not a failure.
			if !strings.Contains(out, "No such process") && !strings.Contains(out, "not find") {
				return sudoHint(fmt.Errorf("launchctl bootout: %s", out), "stop")
			}
		}
		if !*keepEnabled {
			if out, err := runCmd("launchctl", "disable", "system/"+launchdLabel); err != nil {
				return sudoHint(fmt.Errorf("launchctl disable: %s", out), "stop")
			}
		}

	default:
		// No supervisor, or one that never had the agent installed under it. The
		// processes are still real and stopping them is still what was asked for.
		procs := agentProcesses()
		if len(procs) == 0 {
			fmt.Println("No agent is running here.")
			return nil
		}
		stopped, failed := signalProcesses(procs)
		for _, pid := range stopped {
			fmt.Printf("Stopped pid %d.\n", pid)
		}
		if len(failed) > 0 {
			return fmt.Errorf("could not stop every agent: %v", errors.Join(failed...))
		}
		fmt.Println("\nNothing here supervises the agent, so nothing will start it again.")
		return nil
	}

	if *keepEnabled {
		fmt.Println("Stopped. It will start again at the next boot.")
	} else {
		fmt.Println("Stopped, and it will stay stopped across reboots.")
		fmt.Println("Start it again with: weirdvault-agent start")
	}

	// A supervised stop says nothing about a copy somebody launched by hand, and
	// that copy keeps the machine online — which reads as the stop having done
	// nothing at all.
	if strays := strayProcesses(st); len(strays) > 0 {
		fmt.Println()
		fmt.Printf("Note: %d agent process(es) are still running outside the service:\n", len(strays))
		for _, proc := range strays {
			fmt.Printf("  pid %d  %s\n", proc.PID, proc.Config)
		}
		fmt.Println("They were started by hand. Stop them with: kill", pidList(strays))
	}
	return nil
}

// runRestart restarts the agent without touching whether it starts at boot.
func runRestart(args []string) error {
	fs := flag.NewFlagSet("restart", flag.ExitOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}

	st := currentState()
	switch {
	case st.Kind == supervisorSystemd && st.Installed:
		if out, err := runCmd("systemctl", "restart", systemdUnit); err != nil {
			return sudoHint(fmt.Errorf("systemctl restart: %s", out), "restart")
		}
	case st.Kind == supervisorLaunchd && st.Installed:
		// kickstart -k restarts a loaded job in one step; bootout-then-bootstrap
		// would race launchd's own throttling and sometimes leave it unloaded.
		if out, err := runCmd("launchctl", "kickstart", "-k", "system/"+launchdLabel); err != nil {
			return sudoHint(fmt.Errorf("launchctl kickstart: %s", out), "restart")
		}
	default:
		return notInstalledError(st, "restart")
	}

	fmt.Println("Restarted.")
	if !st.Enabled {
		fmt.Println("It is still set not to start at boot — `weirdvault-agent enable` changes that.")
	}
	return nil
}

// runEnable and runDisable touch boot behaviour only, leaving whatever is
// running alone. The common case is covered by start and stop; these are for
// somebody who means precisely one of the two things.
func runEnable(args []string) error {
	fs := flag.NewFlagSet("enable", flag.ExitOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}

	st := currentState()
	switch {
	case st.Kind == supervisorSystemd && st.Installed:
		if out, err := runCmd("systemctl", "enable", systemdUnit); err != nil {
			return sudoHint(fmt.Errorf("systemctl enable: %s", out), "enable")
		}
	case st.Kind == supervisorLaunchd && st.Installed:
		if out, err := runCmd("launchctl", "enable", "system/"+launchdLabel); err != nil {
			return sudoHint(fmt.Errorf("launchctl enable: %s", out), "enable")
		}
	default:
		return notInstalledError(st, "enable")
	}

	fmt.Println("It will start at boot.")
	if !st.Active {
		fmt.Println("It is not running now — `weirdvault-agent start`.")
	}
	return nil
}

func runDisable(args []string) error {
	fs := flag.NewFlagSet("disable", flag.ExitOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}

	st := currentState()
	switch {
	case st.Kind == supervisorSystemd && st.Installed:
		if out, err := runCmd("systemctl", "disable", systemdUnit); err != nil {
			return sudoHint(fmt.Errorf("systemctl disable: %s", out), "disable")
		}
	case st.Kind == supervisorLaunchd && st.Installed:
		if out, err := runCmd("launchctl", "disable", "system/"+launchdLabel); err != nil {
			return sudoHint(fmt.Errorf("launchctl disable: %s", out), "disable")
		}
	default:
		return notInstalledError(st, "disable")
	}

	fmt.Println("It will not start at boot.")
	if st.Active {
		fmt.Println("It is still running now — `weirdvault-agent stop` ends this run too.")
	}
	return nil
}

// notInstalledError explains the case where there is nothing to control, which
// is two different situations that need two different answers.
func notInstalledError(st serviceState, verb string) error {
	switch st.Kind {
	case supervisorSystemd:
		return fmt.Errorf("there is no %s here, so there is no service to %s.\n\n"+
			"The installer writes it:\n"+
			"  curl -fsSL <your weirdvault URL>/install.sh | sudo sh -s -- --token=ENROLL_…\n\n"+
			"Or run the agent in the foreground: weirdvault-agent run", systemdUnit, verb)
	case supervisorLaunchd:
		return fmt.Errorf("this machine is not set up as a service, so there is nothing to %s.\n\n"+
			"Register one for the enrolment already on this machine:\n"+
			"  sudo weirdvault-agent install-service\n\n"+
			"Or run the agent in the foreground: weirdvault-agent run", verb)
	default:
		return fmt.Errorf("nothing here supervises services (no systemd, no launchd), so there is\n"+
			"nothing to %s. Run the agent yourself, or under whatever this machine uses:\n"+
			"  weirdvault-agent run --config=%s", verb, DefaultConfigPath)
	}
}

// strayProcesses is every agent running outside the supervised one.
func strayProcesses(st serviceState) []agentProcess {
	var strays []agentProcess
	for _, proc := range agentProcesses() {
		if st.PID != 0 && proc.PID == st.PID {
			continue
		}
		strays = append(strays, proc)
	}
	return strays
}

func pidList(procs []agentProcess) string {
	var pids []string
	for _, proc := range procs {
		pids = append(pids, strconv.Itoa(proc.PID))
	}
	return strings.Join(pids, " ")
}

// ---------------------------------------------------------------- list

// runList shows every agent identity on this machine and what it is doing.
//
// "Every" rather than "the one at the default path" because machines collect
// them: a test enrolment under a home directory, a config left behind by an
// install that was redone, a second agent someone started by hand pointing at a
// copy of the same file — which is the state that produces two agents claiming
// one machine and a dashboard that flickers between online and offline.
func runList(args []string) error {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	extraConfig := fs.String("config", "", "also look at this config path")
	if err := fs.Parse(args); err != nil {
		return err
	}

	st := currentState()
	procs := agentProcesses()

	// Configs from three places: where the installer puts it, where a user
	// testing without root would, and whatever a running process says it is
	// using — the last of which is the only way to see an agent nobody
	// remembers starting.
	seen := map[string]bool{}
	var paths []string
	add := func(path string) {
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		paths = append(paths, path)
	}
	add(DefaultConfigPath)
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".config", "weirdvault-agent", "agent.json"))
	}
	add(*extraConfig)
	for _, proc := range procs {
		add(proc.Config)
	}

	byConfig := map[string][]agentProcess{}
	for _, proc := range procs {
		byConfig[proc.Config] = append(byConfig[proc.Config], proc)
	}

	out := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(out, "CONFIG\tAGENT\tSTATE")

	rows := 0
	for _, path := range paths {
		if !fileExists(path) && len(byConfig[path]) == 0 {
			continue
		}
		rows++
		fmt.Fprintf(out, "%s\t%s\t%s\n", path, agentIDAt(path), describe(path, st, byConfig[path]))
	}
	out.Flush()

	if rows == 0 {
		fmt.Println("\nNo agent is enrolled on this machine.")
		fmt.Println("Enrol one from Dashboard → Machines → Add a machine.")
		return nil
	}

	fmt.Println()
	switch st.Kind {
	case supervisorNone:
		fmt.Println("Nothing here supervises the agent, so nothing restarts it or starts it at boot.")
	default:
		if !st.Installed {
			fmt.Printf("There is no %s service registered on this machine.\n", st.Kind)
		}
	}
	return nil
}

// agentIDAt reads just the id out of a config, tolerating everything else.
//
// Deliberately not loadConfig: this is a listing, and a config that is
// half-written or from a future version should show up as a row with a caveat
// rather than aborting the whole command. The common failure is not corruption
// at all — it is a plain user running this without root against a file that is
// 0600 and owned by the service account.
func agentIDAt(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsPermission(err) {
			return "(need root to read)"
		}
		return "(no config)"
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.AgentID == "" {
		return "(unreadable)"
	}
	return cfg.AgentID
}

// describe is one machine-readable-ish sentence about one config's agent.
func describe(path string, st serviceState, procs []agentProcess) string {
	var parts []string

	if len(procs) == 0 {
		parts = append(parts, "stopped")
	} else {
		for _, proc := range procs {
			parts = append(parts, fmt.Sprintf("running · pid %d · up %s", proc.PID, humanUptime(proc.Started)))
		}
		if len(procs) > 1 {
			// Two agents on one config both authenticate, both offer the machine,
			// and the relay hands sessions to whichever registered last. Worth
			// saying out loud rather than leaving as two similar-looking rows.
			parts = append(parts, "⚠ more than one process for this config")
		}
	}

	// Boot behaviour belongs only to the config the service actually runs.
	// Claiming it for a config the unit has never heard of would be a plain lie
	// on any machine with a second enrolment.
	if st.Installed && path == serviceConfigPath(st) {
		if st.Enabled {
			parts = append(parts, "starts at boot")
		} else {
			parts = append(parts, "will not start at boot")
		}
	}
	return strings.Join(parts, " · ")
}

// serviceConfigPath is the config the installed service was written to use.
//
// Read out of the unit rather than assumed, because --config exists and people
// use it. Falls back to the default, which is what the installer writes.
func serviceConfigPath(st serviceState) string {
	var raw string
	switch st.Kind {
	case supervisorSystemd:
		out, err := runCmd("systemctl", "show", "-p", "ExecStart", "--value", systemdUnit)
		if err != nil {
			return DefaultConfigPath
		}
		raw = out
	case supervisorLaunchd:
		data, err := os.ReadFile(launchdPlistPath)
		if err != nil {
			return DefaultConfigPath
		}
		raw = string(data)
	default:
		return DefaultConfigPath
	}

	return extractConfigFlag(raw)
}

// extractConfigFlag finds --config= in a systemd ExecStart line or a launchd
// plist.
//
// Both formats wrap the argument differently — systemd quotes the whole argv,
// launchd puts it in an XML element — so the flag itself is the stable part:
// find it and read to whichever delimiter comes first. Reading past the end
// would produce a path matching no row in `list`, which reads as the service
// running an identity that does not exist.
func extractConfigFlag(raw string) string {
	idx := strings.Index(raw, "--config=")
	if idx < 0 {
		return DefaultConfigPath
	}
	rest := raw[idx+len("--config="):]
	if end := strings.IndexAny(rest, " \t\n\"<;"); end >= 0 {
		rest = rest[:end]
	}
	if rest == "" {
		return DefaultConfigPath
	}
	return rest
}

// ---------------------------------------------------------------- logs

// runLogs hands over to whatever already holds the agent's output.
//
// It execs rather than copying the stream, so ^C, paging and colour behave the
// way they do when the user runs journalctl themselves — and so `logs -f` is
// not a second process to kill.
func runLogs(args []string) error {
	fs := flag.NewFlagSet("logs", flag.ExitOnError)
	follow := fs.Bool("f", false, "keep printing as new lines arrive")
	lines := fs.Int("n", 50, "how many recent lines to show")
	if err := fs.Parse(args); err != nil {
		return err
	}

	st := currentState()
	switch {
	case st.Kind == supervisorSystemd && st.Installed:
		argv := []string{"journalctl", "-u", systemdUnit, "-n", strconv.Itoa(*lines)}
		if *follow {
			argv = append(argv, "-f")
		}
		return execInPlace(argv)

	case st.Kind == supervisorLaunchd:
		if !fileExists(launchdLogPath) {
			return fmt.Errorf("no log file at %s yet.\n\n"+
				"launchd writes there once the service has run. If you start the agent by hand,\n"+
				"its output goes to that terminal instead", launchdLogPath)
		}
		argv := []string{"tail", "-n", strconv.Itoa(*lines)}
		if *follow {
			argv = append(argv, "-f")
		}
		return execInPlace(append(argv, launchdLogPath))

	default:
		return fmt.Errorf("there is no service here collecting logs.\n\n" +
			"Run the agent in the foreground and its output is the log:\n" +
			"  weirdvault-agent run")
	}
}

func execInPlace(argv []string) error {
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return fmt.Errorf("%s is not installed here", argv[0])
	}
	return syscall.Exec(path, argv, os.Environ())
}

// ---------------------------------------------------------------- macOS service

/*
install-service, for macOS.

On Linux the installer writes the systemd unit, and that unit is the one place
its contents live. macOS had nothing: install.sh enrolled the machine, printed
"start it yourself", and left the person to write a plist — which meant the
agent did not survive a reboot on the platform where "the machine at home" is
most often a Mac.

This writes the plist for the enrolment already on the machine. It is
deliberately not a general service installer: it takes no command to run, only
which config to point at, so the only thing it can start is this agent.
*/

func runInstallService(args []string) error {
	fs := flag.NewFlagSet("install-service", flag.ExitOnError)
	configPath := fs.String("config", DefaultConfigPath, "path to the agent identity")
	noUpdate := fs.Bool("no-update", false, "do not let the agent replace its own binary")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if runtime.GOOS != "darwin" {
		return errors.New("this writes a launchd plist and only applies to macOS.\n\n" +
			"On Linux the installer writes the systemd unit:\n" +
			"  curl -fsSL <your weirdvault URL>/install.sh | sudo sh -s -- --token=ENROLL_…")
	}
	if os.Geteuid() != 0 {
		return errors.New("writing to /Library/LaunchDaemons needs root: sudo weirdvault-agent install-service")
	}

	// Refuse before writing a service that cannot start: a plist pointing at a
	// config that is not there produces a job launchd retries and fails forever,
	// with the reason in a log nobody is looking at yet.
	if _, err := loadConfig(*configPath); err != nil {
		return err
	}

	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not find this binary's path: %w", err)
	}
	self, err = filepath.Abs(self)
	if err != nil {
		return err
	}

	plist := launchdPlist(self, *configPath, *noUpdate)
	if err := os.WriteFile(launchdPlistPath, []byte(plist), 0o644); err != nil {
		return fmt.Errorf("could not write %s: %w", launchdPlistPath, err)
	}
	// launchd refuses to load a plist that is group- or world-writable, and the
	// error it gives for that names a permission problem without naming the file.
	if err := os.Chown(launchdPlistPath, 0, 0); err != nil {
		return fmt.Errorf("could not set ownership on %s: %w", launchdPlistPath, err)
	}

	fmt.Printf("Wrote %s\n", launchdPlistPath)
	return runStart(nil)
}

func runUninstallService(args []string) error {
	fs := flag.NewFlagSet("uninstall-service", flag.ExitOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}

	if runtime.GOOS != "darwin" {
		return errors.New("this removes a launchd plist and only applies to macOS.\n\n" +
			"On Linux, the installer's --uninstall removes the systemd unit:\n" +
			"  curl -fsSL <your weirdvault URL>/install.sh | sudo sh -s -- --uninstall")
	}
	if !fileExists(launchdPlistPath) {
		fmt.Println("No launchd service is installed here.")
		return nil
	}
	if os.Geteuid() != 0 {
		return errors.New("removing from /Library/LaunchDaemons needs root: sudo weirdvault-agent uninstall-service")
	}

	if out, err := runCmd("launchctl", "bootout", "system/"+launchdLabel); err != nil {
		if !strings.Contains(out, "No such process") && !strings.Contains(out, "not find") {
			return fmt.Errorf("launchctl bootout: %s", out)
		}
	}
	if err := os.Remove(launchdPlistPath); err != nil {
		return fmt.Errorf("could not remove %s: %w", launchdPlistPath, err)
	}

	fmt.Printf("Removed %s. The agent's identity in %s is untouched.\n", launchdPlistPath, DefaultConfigPath)
	return nil
}

// launchdPlist renders the daemon definition.
//
// KeepAlive is conditional on a failed exit rather than unconditional, so the
// agent's own clean shutdown — the one SIGTERM produces — is not immediately
// undone by launchd starting it again.
//
// It has no equivalent of systemd's RestartPreventExitStatus, so a revoked
// agent, which exits 3 on purpose and would be right to stay down, is started
// again every ten seconds. The agent says so in the log line it prints before
// exiting, and `weirdvault-agent stop` is what ends it.
func launchdPlist(binary, configPath string, noUpdate bool) string {
	args := []string{binary, "run", "--config=" + configPath}
	if noUpdate {
		args = append(args, "--no-update")
	}

	var argXML strings.Builder
	for _, arg := range args {
		fmt.Fprintf(&argXML, "    <string>%s</string>\n", xmlEscape(arg))
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + launchdLabel + `</string>
  <key>ProgramArguments</key>
  <array>
` + argXML.String() + `  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>` + launchdLogPath + `</string>
  <key>StandardErrorPath</key>
  <string>` + launchdLogPath + `</string>
</dict>
</plist>
`
}

// xmlEscape covers the characters a path can legally contain. A path with an
// ampersand in it would otherwise produce a plist launchd rejects as malformed,
// and it would say so about the file rather than the character.
func xmlEscape(s string) string {
	return strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
	).Replace(s)
}
