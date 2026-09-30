# PlugSure CSMS — production image.
#
# Deliberately written for the CLASSIC builder frontend: no `# syntax=` directive,
# no BuildKit-only mounts. A `# syntax=docker/dockerfile:1.x` line makes the very
# first thing a build does a pull of the frontend image from Docker Hub, which
# fails on any host whose egress policy does not allow registry.docker.io. Nothing
# below needs it — multi-stage and `COPY --from ... --chown` are classic features.
#
# One image, two entrypoints. The gateway and the API are deployed as separate
# containers from the SAME image so that a billing/API deploy never drops the
# charger WebSockets:
#
#   docker run ... plugsure:latest node dist/apps/gateway.js
#   docker run ... plugsure:latest node dist/apps/api.js
#
# Base image choice: node:22-slim (Debian bookworm), NOT alpine.
#   * glibc, not musl — `pg`, `ws` and `pino` all ship prebuilt glibc binaries and
#     musl has repeatedly produced DNS-resolution and TLS differences that are
#     miserable to debug on a charger integration deadline.
#   * tzdata is installable, and this system cares about wall-clock time:
#     time-of-use tariff blocks (WBP 17:00–22:00 Asia/Jakarta) are computed from
#     local time. An image with no zoneinfo silently bills everything as LWBP.
#   * ~40 MB larger than alpine. Irrelevant for a single Jakarta VM.
#
ARG NODE_VERSION=22

# ---------------------------------------------------------------- deps (dev+prod)
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------- build
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
# tsconfig.build.json pins rootDir=src / outDir=dist, so dist mirrors src:
#   dist/apps/gateway.js, dist/apps/api.js, dist/db/migrate.js, dist/api/server.js
RUN npm run build
# src/api/server.ts resolves its static root as join(here, '../web'). With
# here = /app/dist/api that is /app/dist/web, so the operator console has to be
# copied next to the compiled output. tsc does not copy non-TS assets.
RUN cp -R src/web dist/web && test -f dist/web/index.html
# The driver app (public charging) is served from dist/driver-web at /app.
RUN cp -R src/driver-web dist/driver-web && test -f dist/driver-web/index.html

# ---------------------------------------------------------------- prod deps only
FROM node:${NODE_VERSION}-slim AS prod-deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-slim AS runtime

# dumb-init is PID 1: it reaps zombies and, crucially, forwards SIGTERM to node.
# Without it `docker stop` on the gateway kills the process group hard and the
# graceful drain in startGateway().close() (terminate sockets, close the pool)
# never runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Asia/Jakarta \
    NODE_OPTIONS=--enable-source-maps \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Dedicated unprivileged user (same name as the systemd unit user, for symmetry
# with the no-Docker deployment path).
RUN groupadd --system --gid 10001 plugsure \
 && useradd --system --uid 10001 --gid plugsure --home /app --shell /usr/sbin/nologin plugsure

WORKDIR /app

COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build     --chown=root:root /app/dist ./dist
# package.json must be present at /app: it carries "type": "module", without which
# node refuses to load the ESM output in dist/.
COPY --chown=root:root package.json ./package.json
# src/db/migrate.ts resolves join(here, '../../db/migrations'); with
# here = /app/dist/db that is /app/db/migrations. Keep the SQL where it looks.
COPY --chown=root:root db/migrations ./db/migrations

# v1.3: firmware images and charger diagnostic logs. The only path the app writes;
# mount a volume here (docker-compose does) so uploads survive a redeploy.
RUN mkdir -p /var/lib/plugsure && chown plugsure:plugsure /var/lib/plugsure
ENV STORAGE_DIR=/var/lib/plugsure
VOLUME ["/var/lib/plugsure"]

USER plugsure

# Documentation only — publishing is done by compose / the run command.
EXPOSE 9200 9220

# One healthcheck for both roles.
#   * API  (dist/apps/api.js)     — GET /healthz             -> 200
#   * Gateway (dist/apps/gateway.js) — GET /  on the OCPP port -> 426 Upgrade Required
#     426 is the gateway's *healthy* answer: its HTTP server exists only to be
#     upgraded to a WebSocket. It proves the listener is up and the event loop is
#     responsive, which is all a black-box check can prove here.
# Override HEALTHCHECK_URL per container (docker-compose.yml does exactly this).
ENV HEALTHCHECK_URL="" \
    HEALTHCHECK_OK_STATUS="200,426"
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "const h=require('http');const u=process.env.HEALTHCHECK_URL||('http://127.0.0.1:'+(process.env.API_PORT||9200)+'/healthz');const ok=(process.env.HEALTHCHECK_OK_STATUS||'200,426').split(',').map(s=>Number(s.trim()));const r=h.get(u,{timeout:4000},res=>{res.resume();process.exit(ok.includes(res.statusCode)?0:1)});r.on('timeout',()=>{r.destroy();process.exit(1)});r.on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
# Default role is the API. Override with the container command for the gateway:
#   command: ["node", "dist/apps/gateway.js"]
CMD ["node", "dist/apps/api.js"]
