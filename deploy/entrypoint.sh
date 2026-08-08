#!/bin/sh
# Migrate, then serve.
#
# The schema has to be current before the first request touches it, and start
# is the only moment where the database is both reachable and known to be
# healthy — compose guarantees that with `depends_on: service_healthy`, which
# has no equivalent at image build time.
#
# Migrations are idempotent and recorded in a __migrations table, so a restart
# is a no-op. If several replicas start at once they race; the loser fails its
# transaction and restarts into a no-op. For a single-machine deployment, which
# is what compose.prod.yaml is, that does not arise.
set -e

node apps/web/scripts/migrate.mjs
exec "$@"
