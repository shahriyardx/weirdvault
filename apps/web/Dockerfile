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

# The agent binaries the installer downloads.
#
# Built here for the same reason ssh.wasm is: they are a build input to the web
# image, and an image without them serves an install command that 404s. They
# are gitignored, so a fresh clone does not have them and nothing else in the
# deploy path would produce them — which is exactly how a working deployment
# ended up handing out a download that did not exist.
#
# checksums.txt is not optional: /install.sh refuses to install without it, and
# a verification skipped when the file is missing verifies nothing. manifest
# .json carries the version too, which checksums.txt has nowhere to put, and is
# what a running agent reads to decide whether to replace itself.
#
# AGENT_VERSION is a build arg because .git is not in the build context. The
# default is honest rather than clever: every binary and the manifest are
# stamped together in this stage, so they always agree with each other, and an
# agent comparing "dev" to "dev" simply does not update.
FROM golang:1.26 AS agent
WORKDIR /src
COPY apps/agent/go.mod apps/agent/go.sum ./apps/agent/
RUN cd apps/agent && go mod download
COPY apps/agent ./apps/agent
ARG AGENT_VERSION=dev
RUN set -eu; \
    cd apps/agent; \
    mkdir -p /out; \
    for target in linux/amd64 linux/arm64 linux/arm darwin/arm64 darwin/amd64; do \
      goos="${target%/*}"; goarch="${target#*/}"; \
      CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
        -ldflags="-s -w -X main.version=${AGENT_VERSION}" \
        -o "/out/weirdvault_${goos}_${goarch}" .; \
    done; \
    cd /out; \
    sha256sum weirdvault_* > checksums.txt; \
    { printf '{\n  "version": "%s",\n  "binaries": {\n' "$AGENT_VERSION"; \
      first=1; \
      while read -r sum file; do \
        [ "$first" -eq 1 ] || printf ',\n'; first=0; \
        printf '    "%s": { "file": "%s", "sha256": "%s" }' "${file#weirdvault_}" "$file" "$sum"; \
      done < checksums.txt; \
      printf '\n  }\n}\n'; } > manifest.json

# Node, not bun, and the reason is a crash rather than a preference. Bun is
# still what resolves and installs the dependencies above — bun.lock is the
# lockfile and stays authoritative — but `next build` under bun 1.3.14 on
# linux/arm64 segfaults as it exits, after the build has already completed. The
# layer fails with exit 133 and reads as a broken build.
#
# `node` inside oven/bun is bun wearing a shim, so calling node there does not
# avoid it; the build has to happen in an image where node is node. The runtime
# stage below is the same base, so this is one fewer image in the graph rather
# than one more.
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
COPY --from=wasm /ssh.wasm apps/web/public/ssh.wasm
COPY --from=wasm /wasm_exec.js apps/web/public/wasm_exec.js

# NEXT_PUBLIC_* is inlined at build time, so the relay URL must be known here.
ARG NEXT_PUBLIC_RELAY_URL
ENV NEXT_PUBLIC_RELAY_URL=$NEXT_PUBLIC_RELAY_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && node node_modules/.bin/next build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000

RUN groupadd -r weirdvault && useradd -r -g weirdvault weirdvault

# Next's standalone output is rooted at /app: it emits server.js, .next/ and a
# trimmed node_modules there, and server.js resolves `.next/static` and `public`
# relative to itself. So static and public go beside it, NOT under apps/web/ —
# putting them there leaves a server that starts and serves no CSS, no
# JavaScript and no ssh.wasm, which is a working container and a blank page.
COPY --from=build --chown=weirdvault:weirdvault /app/apps/web/.next/standalone ./
COPY --from=build --chown=weirdvault:weirdvault /app/apps/web/.next/static ./.next/static
COPY --from=build --chown=weirdvault:weirdvault /app/apps/web/public ./public
COPY --from=agent --chown=weirdvault:weirdvault /out ./public/agent-bin

# The schema travels with the image that expects it, so a container can never
# come up against a database older than the code it is running. Applied at
# start, not here: a build has no database to talk to.
COPY --from=build --chown=weirdvault:weirdvault /app/apps/web/drizzle ./apps/web/drizzle
COPY --chown=weirdvault:weirdvault apps/web/scripts/migrate.mjs ./apps/web/scripts/migrate.mjs
COPY --chmod=755 apps/web/entrypoint.sh /usr/local/bin/entrypoint.sh

USER weirdvault
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
