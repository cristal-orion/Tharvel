# Tharvel — build container multi-stage per Coolify.
#
# Stage 1 (ui-builder)   : builda l'UI Vue+Vite, output /build/tharvel/ui/dist
# Stage 2 (server-deps)  : installa deps server con toolchain C++ per better-sqlite3
# Target finale (server) : runtime minimo che esegue tsx sul server, contiene ui/dist
# Target alternativo (ui): runtime separato per servire ui/dist via vite preview
#
# I due target sono usati da docker-compose.yml come servizi distinti
# (tharvel-server su :3000, tharvel-ui su :5173). In una fase successiva
# valuteremo il single-container (server che serve anche ui/dist statica)
# quando l'UI avrà la base URL relativa configurata.

############################################################
# Base — utente non-root condiviso fra i target finali
############################################################
FROM node:22-bookworm-slim AS base
RUN groupadd -r tharvel && useradd -r -g tharvel -m -d /home/tharvel tharvel

############################################################
# UI builder — Vue 3 + Vite → dist statica
############################################################
FROM base AS ui-builder
WORKDIR /build/tharvel
# Copy del minimo necessario per `npm ci` (cache layer).
COPY tharvel/package.json tharvel/package-lock.json ./
COPY tharvel/ui/package.json ui/
COPY tharvel/shared/package.json shared/
COPY tharvel/server/package.json server/
RUN npm ci --workspace=ui --include-workspace-root
# Source UI + build
COPY tharvel/ui/ ui/
COPY tharvel/shared/ shared/
RUN npm run build --workspace=ui

############################################################
# Server deps — incl. toolchain per better-sqlite3 (native)
############################################################
FROM base AS server-deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/tharvel
COPY tharvel/package.json tharvel/package-lock.json ./
COPY tharvel/server/package.json server/
COPY tharvel/shared/package.json shared/
COPY tharvel/ui/package.json ui/
# --include=dev perché `tsx` (devDep) viene usato a runtime.
# Quando passeremo a tsc → dist/index.js togliamo --include=dev e rimuoviamo tsx.
RUN npm ci --workspace=server --include-workspace-root --include=dev

############################################################
# Target: server runtime
############################################################
FROM base AS server
WORKDIR /app
COPY --from=server-deps /build/tharvel/node_modules ./node_modules
COPY --from=server-deps /build/tharvel/server/node_modules ./server/node_modules
COPY tharvel/package.json ./
COPY tharvel/server/ ./server/
COPY tharvel/shared/ ./shared/
RUN mkdir -p /data /var/tharvel/sites \
    && chown -R tharvel:tharvel /app /data /var/tharvel
USER tharvel
ENV NODE_ENV=production \
    PORT=3000 \
    THARVEL_DB_PATH=/data/tharvel.db \
    THARVEL_SITES_ROOT=/var/tharvel/sites
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]

############################################################
# Target: ui runtime — serve dist via vite preview
############################################################
FROM base AS ui
WORKDIR /app
COPY --from=ui-builder /build/tharvel/ui/dist ./dist
COPY --from=ui-builder /build/tharvel/node_modules ./node_modules
COPY --from=ui-builder /build/tharvel/ui/package.json ./
RUN chown -R tharvel:tharvel /app
USER tharvel
ENV NODE_ENV=production
EXPOSE 5173
# `vite preview` serve la dist con fallback SPA; `--host 0.0.0.0` per esporre fuori dal container.
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
