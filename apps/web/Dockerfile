# The control plane: Next.js app, auth, and encrypted vault storage.
#
# This never sees a plaintext vault or an SSH key — it stores ciphertext and
# serves the JavaScript that does the real work. Build from the repo root:
#   docker build -f apps/web/Dockerfile -t weirdvault-web .

FROM oven/bun:1 AS deps
WORKDIR /app
COPY apps/web/package.json apps/web/bun.lock* ./apps/web/
RUN cd apps/web && bun install --frozen-lockfile

FROM golang:1.26 AS wasm
WORKDIR /src
COPY apps/ssh/go.mod apps/ssh/go.sum ./apps/ssh/
RUN cd apps/ssh && go mod download
COPY apps/ssh ./apps/ssh
# The SSH core is a build input to the web image: the app serves it from
# /public, and a mismatched or missing ssh.wasm means no connections at all.
RUN cd apps/ssh \
 && GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o /ssh.wasm . \
 && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /wasm_exec.js

FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
COPY --from=wasm /ssh.wasm apps/web/public/ssh.wasm
COPY --from=wasm /wasm_exec.js apps/web/public/wasm_exec.js

# NEXT_PUBLIC_* is inlined at build time, so the relay URL must be known here.
ARG NEXT_PUBLIC_RELAY_URL
ENV NEXT_PUBLIC_RELAY_URL=$NEXT_PUBLIC_RELAY_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run --cwd apps/web build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000

RUN groupadd -r weirdvault && useradd -r -g weirdvault weirdvault

COPY --from=build --chown=weirdvault:weirdvault /app/apps/web/.next/standalone ./
COPY --from=build --chown=weirdvault:weirdvault /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=weirdvault:weirdvault /app/apps/web/public ./apps/web/public

# The schema travels with the image that expects it, so a container can never
# come up against a database older than the code it is running. Applied at
# start, not here: a build has no database to talk to.
COPY --from=build --chown=weirdvault:weirdvault /app/apps/web/drizzle ./apps/web/drizzle
COPY --chown=weirdvault:weirdvault apps/web/scripts/migrate.mjs ./apps/web/scripts/migrate.mjs
COPY --chmod=755 apps/web/entrypoint.sh /usr/local/bin/entrypoint.sh

USER weirdvault
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
