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
import { publicOrigin } from "@/lib/origin"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const origin = publicOrigin(request)
  // The same resolver the enrolment route hands to agents for self-update. Two
  // copies would drift, and the failure would be an agent updating itself from
  // somewhere the installer never used.
  const base = agentReleaseUrl(origin)

  const script = `#!/bin/sh
# weirdvault installer
#
# Makes this machine reachable from ${origin} without opening a port.
# The agent dials out; nothing dials in.
#
#   curl -fsSL ${origin}/install.sh | sh -s -- --token=ENROLL_...
#
# It installs a binary to /usr/local/bin, writes an identity to
# /etc/weirdvault, and registers a systemd service. It does not touch your
# SSH configuration, and the agent it installs holds no SSH credentials.
#
# To remove all of that again — though once it is installed, the binary itself
# does this and does not need the script:
#
#   sudo weirdvault uninstall
#   curl -fsSL ${origin}/install.sh | sh -s -- --uninstall
#
# To reinstall the binary and the service for a machine that is already enrolled,
# without touching its identity or minting a new token:
#
#   curl -fsSL ${origin}/install.sh | sh -s -- --repair
#
# To add a second identity for an account that already has one here — two rows,
# two agents, the machine listed twice, which is occasionally what you want:
#
#   curl -fsSL ${origin}/install.sh | sh -s -- --token=ENROLL_... --force

set -eu

APP_URL="${origin}"
RELEASE_BASE="${base}"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/weirdvault"
SERVICE_USER="weirdvault"
LAUNCHD_LABEL="com.weirdvault"
LAUNCHD_PLIST="/Library/LaunchDaemons/com.weirdvault.plist"

# Where the binary the service runs actually lives, on Linux.
#
# Not /usr/local/bin, and this is the fix for a bug that made self-update
# impossible on every install that got a dedicated service user. The agent
# replaces its own binary — that is the whole update mechanism — and it runs as
# an unprivileged account, so the file has to sit in a directory that account
# owns. /usr/local/bin is root:root 0755, and no systemd directive changes that:
# ReadWritePaths lifts the sandbox's read-only remount, not the ownership, so
# the write failed with "permission denied" while every unit directive looked
# correct.
#
# /usr/local/bin/weirdvault becomes a symlink to here, so the command
# people type is unchanged, and \`upgrade\` resolves the link before replacing
# the target.
STATE_DIR="/var/lib/weirdvault"
BIN_DIR="\${STATE_DIR}/bin"

SSH_PORT="22"
TOKEN=""
MODE="install"
FORCE=""

for arg in "$@"; do
  case "$arg" in
    --token=*) TOKEN="\${arg#*=}" ;;
    --ssh-port=*) SSH_PORT="\${arg#*=}" ;;
    # Enrol even though this account already has an identity on this machine.
    # The refusal it bypasses exists because two identities for one account
    # means two rows, both online, and the machine listed twice — so this is for
    # somebody who means exactly that, or who is rebuilding after a config was
    # lost. It does not touch anybody else's identity here.
    --force) FORCE="--force" ;;
    --uninstall) MODE="uninstall" ;;
    # Reinstall the binary and the service for the enrolment already on this
    # machine. No token, because the machine is already enrolled and minting one
    # would replace an identity that is working — which is what somebody
    # migrating an install broken by the bug above would otherwise have to do.
    --repair) MODE="repair" ;;
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
  # The binary knows how to remove itself, and knowing it in two places is how
  # the two drift. This script keeps its own copy for the case that made it
  # necessary: an install too broken to run, or one from before the command
  # existed.
  if [ -x "\${INSTALL_DIR}/weirdvault" ]; then
    exec "\${INSTALL_DIR}/weirdvault" uninstall --yes
  fi

  removed=""

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files weirdvault.service >/dev/null 2>&1; then
      systemctl disable --now weirdvault 2>/dev/null || true
      removed="\${removed}  the systemd service (stopped and disabled)\\n"
    fi
    if [ -f /etc/systemd/system/weirdvault.service ]; then
      rm -f /etc/systemd/system/weirdvault.service
      systemctl daemon-reload 2>/dev/null || true
      removed="\${removed}  /etc/systemd/system/weirdvault.service\\n"
    fi
  elif [ -f "$LAUNCHD_PLIST" ]; then
    # macOS. Booted out and removed from the disabled database as well as
    # deleted: a label left disabled there outlives the plist, and a later
    # reinstall would write a daemon that silently never starts.
    launchctl bootout "system/\${LAUNCHD_LABEL}" 2>/dev/null || true
    launchctl enable "system/\${LAUNCHD_LABEL}" 2>/dev/null || true
    rm -f "$LAUNCHD_PLIST"
    removed="\${removed}  the launchd daemon (stopped and removed)\\n"
  else
    # No service manager we wrote to: whatever is running was started by hand or
    # by a supervisor this script did not write, so it says so rather than
    # guessing.
    if pgrep -f "weirdvault run" >/dev/null 2>&1; then
      echo "note: an agent process is running and this machine has no service," >&2
      echo "      so stop it however you started it (or: pkill -f 'weirdvault run')." >&2
      echo >&2
    fi
  fi

  # -e is false for a dangling symlink, so both tests: the link is what is left
  # behind when the state directory was removed by hand first.
  if [ -e "\${INSTALL_DIR}/weirdvault" ] || [ -L "\${INSTALL_DIR}/weirdvault" ]; then
    rm -f "\${INSTALL_DIR}/weirdvault"
    removed="\${removed}  \${INSTALL_DIR}/weirdvault\\n"
  fi

  # Where the binary the service runs lives, and the only thing in it.
  if [ -d "$STATE_DIR" ]; then
    rm -rf "$STATE_DIR"
    removed="\${removed}  \${STATE_DIR}/\\n"
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

if [ "$MODE" = "repair" ]; then
  # Any identity will do. A machine shared by several accounts has one file per
  # account, and a machine installed before that had exactly agent.json.
  if [ -z "$(ls "\${CONFIG_DIR}"/*.json 2>/dev/null)" ]; then
    echo "error: nothing to repair — no identity in \${CONFIG_DIR}." >&2
    echo "       This machine is not enrolled. Add it from $APP_URL/dashboard/machines" >&2
    exit 1
  fi
elif [ -z "$TOKEN" ]; then
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

binary="weirdvault_\${os}_\${arch}"
echo "Installing weirdvault for \${os}/\${arch}"

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
  echo "       Publish one: sha256sum weirdvault_* > checksums.txt" >&2
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
#
# On Linux the binary goes in a directory the service account owns, because the
# agent replaces its own binary to update and cannot write to a root-owned one.
# /usr/local/bin/weirdvault is then a symlink, so the command people type
# is unchanged and "weirdvault upgrade" resolves it before replacing the
# target. On macOS the daemon runs as root, so the binary stays where it was.

if [ "$os" = "darwin" ]; then
  BIN_TARGET="\${INSTALL_DIR}/weirdvault"
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$tmp/agent" "$BIN_TARGET"
else
  BIN_TARGET="\${BIN_DIR}/weirdvault"
  mkdir -p "$BIN_DIR" "$INSTALL_DIR"
  install -m 0755 "$tmp/agent" "$BIN_TARGET"
  # -f because an install from before this layout left a real file here, and a
  # symlink that cannot be created would leave the old binary shadowing the new
  # one on PATH — the confusing half-state where "weirdvault version"
  # disagrees with what the service is running.
  ln -sf "$BIN_TARGET" "\${INSTALL_DIR}/weirdvault"
fi

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

if [ "$MODE" = "repair" ]; then
  echo "Repairing the install for the enrolment already on this machine."
  echo "Its identity and key in \${CONFIG_DIR} are untouched."
else
  echo
  # No --config: the identity is named after the agent id the server chooses,
  # because everybody pastes an identical command and only the token differs.
  # That is what lets several accounts share one machine.
  # $FORCE is unquoted on purpose: it is either empty, in which case it must
  # disappear rather than become an empty argument, or exactly "--force".
  "$BIN_TARGET" enroll \\
    --token="$TOKEN" \\
    --url="$APP_URL" \\
    --config-dir="$CONFIG_DIR" \\
    --ssh-port="$SSH_PORT" \\
    $FORCE
fi

chown -R "$SERVICE_USER" "$CONFIG_DIR"
chmod 0700 "$CONFIG_DIR"
# Every identity, not one named file: this directory holds one private key per
# account on the machine, and a new one has just been added to it.
chmod 0600 "\${CONFIG_DIR}"/*.json 2>/dev/null || true

# The service account has to own the binary it replaces, which is the entire
# point of putting it here. Without this the update downloads, verifies its
# checksum, and fails on the write — reported in a log nobody is reading.
if [ "$os" != "darwin" ]; then
  chown -R "$SERVICE_USER" "$STATE_DIR"
fi

# ---------------------------------------------------------------- service

# macOS: the agent writes its own launchd daemon, because the plist has to name
# the binary and config that were just installed and duplicating that template
# here would be a second copy to keep in step. It starts it too.
if [ "$os" = "darwin" ]; then
  echo
  "$BIN_TARGET" install-service --config-dir="$CONFIG_DIR"
  echo
  echo "  weirdvault status              is it running, and will it start at boot"
  echo "  weirdvault stop                stop it, and keep it stopped"
  echo "  weirdvault logs -f             what it is doing"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo
  echo "Enrolled. There is no service manager here that this script knows, so start"
  echo "the agent yourself:"
  echo "  sudo \${INSTALL_DIR}/weirdvault run --config=\${CONFIG_DIR}/agent.json"
  echo
  echo "To keep it running across reboots, wrap that in whatever this machine uses —"
  echo "an rc script, or a supervisor of your choice."
  exit 0
fi

cat > /etc/systemd/system/weirdvault.service <<UNIT
[Unit]
Description=weirdvault agent
Documentation=\${APP_URL}/docs/agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=\${SERVICE_USER}
ExecStart=\${BIN_TARGET} run --config-dir=\${CONFIG_DIR}
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
# The identity directory has to be writable, and it did not used to be.
#
# "stop" from the dashboard writes a marker beside an identity, and "revoke"
# deletes one — that is how "stopped" survives a reboot and how a revoked key
# stops existing on the machine. Both were designed against a directory this
# unit had pinned read-only, so both failed at the write with an error naming a
# read-only file system while every other part of the path worked.
#
# What this grants is narrower than it looks: the process already reads every
# private key in here, because it needs them to run. Anything able to make it
# write a file could already read all of them.
ReadWritePaths=\${CONFIG_DIR}

# Self-update replaces this binary, so the directory holding it has to be
# writable by the account below — which is why the binary is here and not in
# /usr/local/bin. Two separate things are needed and only one of them is a
# systemd directive:
#
#   StateDirectory   creates /var/lib/weirdvault owned by User=, and
#                    exempts it from the read-only remount ProtectSystem=strict
#                    applies to everything else.
#   ownership        is what actually permits the write. An earlier version of
#                    this unit pointed ReadWritePaths at /usr/local/bin and
#                    looked correct, but that directory is root:root 0755 and
#                    the service user cannot create a file in it — so every
#                    update downloaded, verified its checksum, and failed on
#                    the rename.
#
# The replacement is a temp file plus a rename, which is what makes a
# half-downloaded binary impossible, and rename needs the same filesystem — so
# it is the directory that must be writable, not the file.
#
# If you would rather patch agents yourself, add --no-update to ExecStart above;
# the agent then never touches its own binary.
StateDirectory=weirdvault

# /run/weirdvault, owned by the account below, where the daemon publishes
# what each identity is doing. One process can serve several accounts, so the
# CLI cannot learn that from the process table — see runtimestate.go.
RuntimeDirectory=weirdvault

# MemoryDenyWriteExecute is deliberately absent. The Go runtime does not need
# W+X pages, but re-exec after an update trips it on some kernels, and a
# hardening flag that turns updates into a crash loop is worse than the
# marginal protection it buys on a process that parses no untrusted input
# beyond a JSON control message.

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now weirdvault

echo
if [ "$MODE" = "repair" ]; then
  echo "Repaired. Same machine, same identity — only the binary and the unit changed."
else
  echo "Done. The agent is running and should appear at \${APP_URL} within a few seconds."
fi
echo
echo "  weirdvault status              is it running, and its fingerprint"
echo "  weirdvault uninstall           remove all of this again"
echo "  weirdvault list                every account with an agent here"
echo "  weirdvault stop [id]           stop one identity, or all of them"
echo "  weirdvault start [id]          start it again"
echo "  weirdvault logs -f             what it is doing"
echo
echo "Another person can add this same machine to their own account: they run"
echo "their own install command, and the two identities are independent."
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
