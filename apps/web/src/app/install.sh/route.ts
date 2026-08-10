/**
 * The installer, generated for this deployment.
 *
 * Served from the app rather than kept as a static file so the URLs inside it
 * are this deployment's own — a self-hosted install must not hand its users a
 * script pointing at somebody else's origin, and an operator should not have to
 * edit a shell script to change a hostname.
 *
 * ## On `curl | sh`
 *
 * It is a reasonable thing to refuse, and the page that shows this command also
 * offers the manual path. What makes the piped form defensible here is that the
 * script and the binary come from the same origin over the same TLS connection
 * the user is already trusting with their SSH sessions: an attacker who can
 * tamper with this response can tamper with the dashboard that told you to run
 * it. The checksum below is not defending against that — it defends against the
 * binary being served from somewhere else, which is exactly when it is required.
 */

import { agentReleaseUrl } from "@/lib/agents/enrollment"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const origin = new URL(request.url).origin
  // The same resolver the enrolment route hands to agents for self-update. Two
  // copies would drift, and the failure would be an agent updating itself from
  // somewhere the installer never used.
  const base = agentReleaseUrl(origin)

  const script = `#!/bin/sh
# weirdvault-agent installer
#
# Makes this machine reachable from ${origin} without opening a port.
# The agent dials out; nothing dials in.
#
#   curl -fsSL ${origin}/install.sh | sh -s -- --token=ENROLL_...
#
# It installs a binary to /usr/local/bin, writes an identity to
# /etc/weirdvault-agent, and registers a systemd service. It does not touch your
# SSH configuration, and the agent it installs holds no SSH credentials.
#
# To remove all of that again:
#
#   curl -fsSL ${origin}/install.sh | sh -s -- --uninstall

set -eu

APP_URL="${origin}"
RELEASE_BASE="${base}"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/weirdvault-agent"
SERVICE_USER="weirdvault-agent"
SSH_PORT="22"
TOKEN=""
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --token=*) TOKEN="\${arg#*=}" ;;
    --ssh-port=*) SSH_PORT="\${arg#*=}" ;;
    --uninstall) MODE="uninstall" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run this as root (it manages a system service)." >&2
  echo "       try: curl -fsSL $APP_URL/install.sh | sudo sh -s -- $*" >&2
  exit 1
fi

# ---------------------------------------------------------------- uninstall
#
# Every step is written to succeed when the thing it removes is already gone, so
# a half-finished install can be cleaned up by the same command, and running it
# twice is not an error. That matters more than usual here: the most likely
# reason somebody runs this is that something did not work.

if [ "$MODE" = "uninstall" ]; then
  removed=""

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files weirdvault-agent.service >/dev/null 2>&1; then
      systemctl disable --now weirdvault-agent 2>/dev/null || true
      removed="\${removed}  the systemd service (stopped and disabled)\\n"
    fi
    if [ -f /etc/systemd/system/weirdvault-agent.service ]; then
      rm -f /etc/systemd/system/weirdvault-agent.service
      systemctl daemon-reload 2>/dev/null || true
      removed="\${removed}  /etc/systemd/system/weirdvault-agent.service\\n"
    fi
  else
    # No systemd: whatever is running was started by hand or by a supervisor
    # this script did not write, so it says so rather than guessing.
    if pgrep -f "weirdvault-agent run" >/dev/null 2>&1; then
      echo "note: an agent process is running and this machine has no systemd," >&2
      echo "      so stop it however you started it (or: pkill -f 'weirdvault-agent run')." >&2
      echo >&2
    fi
  fi

  if [ -f "\${INSTALL_DIR}/weirdvault-agent" ]; then
    rm -f "\${INSTALL_DIR}/weirdvault-agent"
    removed="\${removed}  \${INSTALL_DIR}/weirdvault-agent\\n"
  fi

  # The config holds this machine's Ed25519 private key. It is the one thing
  # here that is worth removing even if you leave everything else, which is why
  # it is called out separately in the summary below.
  if [ -d "$CONFIG_DIR" ]; then
    rm -rf "$CONFIG_DIR"
    removed="\${removed}  \${CONFIG_DIR}/ (including this machine's private key)\\n"
  fi

  # Only if the installer created it. A pre-existing account of that name is
  # somebody else's and is left alone.
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    if command -v userdel >/dev/null 2>&1; then
      userdel "$SERVICE_USER" 2>/dev/null && removed="\${removed}  the \${SERVICE_USER} system user\\n" || true
    elif command -v deluser >/dev/null 2>&1; then
      deluser "$SERVICE_USER" >/dev/null 2>&1 && removed="\${removed}  the \${SERVICE_USER} system user\\n" || true
    fi
  fi

  echo
  if [ -z "$removed" ]; then
    echo "Nothing to remove — no weirdvault agent is installed here."
  else
    echo "Removed:"
    printf "%b" "$removed"
    echo
    echo "Nothing else was touched. Your SSH configuration, sshd, and any keys in"
    echo "~/.ssh are exactly as they were — the agent never had anything to do with them."
  fi
  echo
  echo "If you have not already, revoke this machine at $APP_URL/dashboard/machines"
  echo "so it cannot connect even if a copy of its key exists somewhere else."
  exit 0
fi

if [ -z "$TOKEN" ]; then
  echo "error: --token is required. Get one from $APP_URL/dashboard/machines" >&2
  exit 2
fi

# ---------------------------------------------------------------- platform

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  armv7l) arch="arm" ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

case "$os" in
  linux|darwin) ;;
  *) echo "error: unsupported operating system $os" >&2; exit 1 ;;
esac

binary="weirdvault-agent_\${os}_\${arch}"
echo "Installing weirdvault-agent for \${os}/\${arch}"

# ---------------------------------------------------------------- download

tmp="$(mktemp -d)"
# Cleans up on every exit path, including the failures below. Without this a
# failed install leaves a partial binary in /tmp on every retry.
trap 'rm -rf "$tmp"' EXIT

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "error: neither curl nor wget is installed" >&2
    exit 1
  fi
}

fetch "\${RELEASE_BASE}/\${binary}" "$tmp/agent" || {
  echo "error: could not download \${RELEASE_BASE}/\${binary}" >&2
  echo "       If you are self-hosting, build it and publish it there:" >&2
  echo "         GOOS=\${os} GOARCH=\${arch} go build -o \${binary} ./apps/agent" >&2
  exit 1
}

# The checksum is required, not best-effort. It is the only thing that makes a
# binary from a release host as trustworthy as one from this origin, and a
# verification that is skipped when the file is missing verifies nothing at all.
if ! fetch "\${RELEASE_BASE}/checksums.txt" "$tmp/checksums.txt"; then
  echo "error: no checksums.txt beside the binary at \${RELEASE_BASE}" >&2
  echo "       Publish one: sha256sum weirdvault-agent_* > checksums.txt" >&2
  exit 1
fi

expected="$(grep " \${binary}$" "$tmp/checksums.txt" | awk '{print $1}' | head -n1)"
if [ -z "$expected" ]; then
  echo "error: checksums.txt has no entry for \${binary}" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/agent" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/agent" | awk '{print $1}')"
else
  echo "error: no sha256sum or shasum available to verify the download" >&2
  exit 1
fi

if [ "$actual" != "$expected" ]; then
  echo "error: checksum mismatch — refusing to install" >&2
  echo "       expected $expected" >&2
  echo "       actual   $actual" >&2
  exit 1
fi

# ---------------------------------------------------------------- install

mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp/agent" "\${INSTALL_DIR}/weirdvault-agent"

# A dedicated account with no shell and no home. The agent needs no privileges
# beyond reading its own config and opening outbound sockets, and running it as
# root would mean a bug in a network-facing daemon is a root bug.
#
# macOS is skipped rather than attempted. Creating a service account there means
# dscl and a free UID search, and there is no systemd to run it under anyway —
# so on a Mac this installs the binary and enrols it, and you start it yourself.
# Warning about a missing useradd on a platform that has never had one reads as
# something going wrong when nothing is.
if [ "$os" = "darwin" ]; then
  SERVICE_USER="root"
elif ! id "$SERVICE_USER" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null || \\
      useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
  elif command -v adduser >/dev/null 2>&1; then
    adduser --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
  else
    echo "warning: no useradd or adduser here, so the agent will run as root" >&2
    SERVICE_USER="root"
  fi
fi

# ---------------------------------------------------------------- enroll

echo
"\${INSTALL_DIR}/weirdvault-agent" enroll \\
  --token="$TOKEN" \\
  --url="$APP_URL" \\
  --config="\${CONFIG_DIR}/agent.json" \\
  --ssh-port="$SSH_PORT"

chown -R "$SERVICE_USER" "$CONFIG_DIR"
chmod 0700 "$CONFIG_DIR"
chmod 0600 "\${CONFIG_DIR}/agent.json"

# ---------------------------------------------------------------- service

if ! command -v systemctl >/dev/null 2>&1; then
  echo
  echo "Enrolled. There is no systemd here, so start the agent yourself:"
  echo "  sudo \${INSTALL_DIR}/weirdvault-agent run --config=\${CONFIG_DIR}/agent.json"
  echo
  echo "To keep it running across reboots, wrap that in whatever this machine"
  echo "uses — launchd on macOS, an rc script, or a supervisor of your choice."
  exit 0
fi

cat > /etc/systemd/system/weirdvault-agent.service <<UNIT
[Unit]
Description=weirdvault agent
Documentation=\${APP_URL}/docs/agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=\${SERVICE_USER}
ExecStart=\${INSTALL_DIR}/weirdvault-agent run --config=\${CONFIG_DIR}/agent.json
Restart=always
RestartSec=5

# Exit 3 means the relay said this agent is revoked or unknown. The agent
# already stopped retrying for that reason; without this line systemd would
# restart it every five seconds forever and undo the decision.
RestartPreventExitStatus=3

# The agent reads one config file and opens outbound sockets. Everything else
# it could reach is a bug waiting to matter, so none of it is reachable.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
ReadOnlyPaths=\${CONFIG_DIR}

# Self-update needs to replace the binary in place, and ProtectSystem=strict
# makes /usr read-only. This is the narrowest hole that allows it: the
# directory the agent already lives in, and nothing else. Writing the whole
# directory rather than the one file is not laziness — the replacement is a
# temp file plus a rename, which is what makes a half-downloaded binary
# impossible, and rename needs somewhere in the same filesystem to write.
#
# If you would rather patch agents yourself, add --no-update to ExecStart above
# and drop this line; the agent then never touches its own binary.
ReadWritePaths=\${INSTALL_DIR}

# MemoryDenyWriteExecute is deliberately absent. The Go runtime does not need
# W+X pages, but re-exec after an update trips it on some kernels, and a
# hardening flag that turns updates into a crash loop is worse than the
# marginal protection it buys on a process that parses no untrusted input
# beyond a JSON control message.

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now weirdvault-agent

echo
echo "Done. The agent is running and should appear at \${APP_URL} within a few seconds."
echo
echo "  systemctl status weirdvault-agent    is it running"
echo "  journalctl -u weirdvault-agent -f    what it is doing"
echo "  weirdvault-agent status              this machine's fingerprint"
`

  return new Response(script, {
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      // Never cached. The script carries this deployment's origin and an
      // operator who moves the app must not have an old one served for a day.
      "Cache-Control": "no-store",
    },
  })
}
