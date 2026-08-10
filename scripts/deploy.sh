#!/bin/sh
# Pull, rebuild, restart — what an upgrade on the server actually is.
#
#   ./scripts/deploy.sh              pull, then rebuild and restart everything
#   ./scripts/deploy.sh --no-pull    deploy what is already checked out
#   ./scripts/deploy.sh --no-build   restart without rebuilding the images
#   ./scripts/deploy.sh --prune      also delete the images this replaced
#
# The two commands in docs/DEPLOY.md § Upgrading, with the checks around them
# that the manual version leaves to whoever is typing at 1am: that .env exists
# before compose reads a missing one, that the pull is a fast-forward rather
# than a merge commit created unattended, and that a change to the agent is
# noticed while it can still be acted on.
#
# The web container migrates before it accepts traffic (apps/web/entrypoint.sh),
# so there is no schema step here. That is deliberate — a migration triggered by
# a deploy script runs from wherever the script was invoked, against whatever
# DATABASE_URL that shell happens to have.

set -eu

PULL=1
BUILD=1
PRUNE=0
COMPOSE_FILE="compose.prod.yaml"

for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --no-build) BUILD=0 ;;
    --prune) PRUNE=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Run from the repo root whatever directory this was called from, so the compose
# file, the build context and the .env are all the ones next to this script
# rather than the ones next to the caller.
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# ---------------------------------------------------------------- preflight

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose -f "$COMPOSE_FILE" "$@"; }
else
  echo "error: docker compose is not installed here." >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "error: $COMPOSE_FILE is not here. Run this from a checkout of the repo." >&2
  exit 1
fi

# Checked before compose reads it, because compose's own message for a missing
# env_file names the file and not what belongs in it.
if [ ! -f .env ]; then
  echo "error: no .env beside $COMPOSE_FILE." >&2
  echo "       cp .env.example .env, then fill in the secrets:" >&2
  echo "         openssl rand -base64 48" >&2
  echo "       What each variable does: docs/DEPLOY.md § Configuration." >&2
  exit 1
fi

# ---------------------------------------------------------------- pull

before=""
after=""

if [ "$PULL" -eq 1 ]; then
  if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "error: not a git checkout, so there is nothing to pull." >&2
    echo "       Deploy what is here with: $0 --no-pull" >&2
    exit 1
  fi

  # A dirty tree on a server is almost always somebody's hand-edit, and a pull
  # over it either refuses halfway or merges it into the release. Neither is
  # something to discover from a container that will not start.
  if [ -n "$(git status --porcelain)" ]; then
    echo "error: there are uncommitted changes here." >&2
    echo >&2
    git status --short >&2
    echo >&2
    echo "       Commit or stash them, or deploy them as they are: $0 --no-pull" >&2
    exit 1
  fi

  before="$(git rev-parse HEAD)"
  echo "==> git pull"
  # --ff-only: a merge commit created unattended on a server is a state nobody
  # can reason about afterwards, and it is never what was meant by "deploy".
  git pull --ff-only
  after="$(git rev-parse HEAD)"

  if [ "$before" = "$after" ]; then
    echo "    already up to date"
  else
    echo
    git --no-pager log --oneline "$before..$after"
    echo
  fi
fi

# ---------------------------------------------------------------- version
#
# A tagged commit sets AGENT_VERSION; anything else leaves it alone.
#
# That value is what every enrolled machine compares itself against, and until
# now it lived only in .env — so releasing meant tagging the repository and then
# editing a file to say the same thing again, and forgetting the second step
# published a fix that reached nobody. Twice, so far.
#
# Only an *exact* tag counts. `git describe` on an untagged commit produces
# something like v1.3.0-4-gabc123, which changes on every commit and would hand
# every machine in the field a new binary to download and re-exec after a
# web-only redeploy — the failure docs/DEPLOY.md warns about. Tag a release and
# the fleet moves; deploy from an untagged commit and it does not.

tag="$(git describe --tags --exact-match 2>/dev/null || true)"
if [ -n "$tag" ]; then
  current="$(sed -n 's/^AGENT_VERSION=//p' .env | head -n1)"
  if [ "$current" != "$tag" ]; then
    if grep -q '^AGENT_VERSION=' .env; then
      # A temporary file and a move, so an interrupted write cannot leave .env
      # half-rewritten — it holds every secret this deployment has.
      sed "s|^AGENT_VERSION=.*|AGENT_VERSION=${tag}|" .env > .env.tmp && mv .env.tmp .env
    else
      printf '\nAGENT_VERSION=%s\n' "$tag" >> .env
    fi
    echo "==> AGENT_VERSION: ${current:-unset} -> ${tag}"
    echo "    Enrolled machines will update to this build."
  fi
fi

# ---------------------------------------------------------------- build & run

if [ "$BUILD" -eq 1 ]; then
  echo "==> docker compose up -d --build"
  compose up -d --build
else
  echo "==> docker compose up -d"
  compose up -d
fi

echo
compose ps

# ---------------------------------------------------------------- afterwards

# The agent is the one component a deploy does not update. Its binaries are
# rebuilt into the web image, but a machine in somebody's house only replaces
# itself when the manifest's AGENT_VERSION differs from the one it is running —
# so shipping agent changes with AGENT_VERSION untouched publishes a fix that
# reaches nobody, silently, forever. See docs/DEPLOY.md § Agent versions.
if [ -n "$before" ] && [ "$before" != "$after" ] && [ -z "$tag" ]; then
  if [ -n "$(git diff --name-only "$before" "$after" -- apps/agent)" ]; then
    echo
    echo "Note: this release changes apps/agent, and this commit is not tagged."
    echo "      No enrolled machine will pick it up: they compare against"
    echo "      AGENT_VERSION, which still reads"
    echo "        $(grep '^AGENT_VERSION=' .env || echo 'AGENT_VERSION= (unset — nothing self-updates)')"
    echo "      Tag the release and deploy again, and this takes care of itself:"
    echo "        git tag -a v1.2.3 -m v1.2.3 && git push --tags"
  fi
fi

if [ "$PRUNE" -eq 1 ]; then
  echo
  echo "==> docker image prune"
  # Dangling only: the images this build just replaced. Never -a, which would
  # also delete images for anything else on the machine that is not running.
  docker image prune -f
fi

echo
echo "Done. The web container migrates before it serves, so a failure to start"
echo "is worth reading in full:"
echo "  docker compose -f $COMPOSE_FILE logs -f web"
