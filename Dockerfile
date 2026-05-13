# Tharvel — build container multi-stage per Coolify.
#
# Stage 1 (ui-builder)   : builda l'UI Vue+Vite, output /build/tharvel/ui/dist
# Stage 2 (server-deps)  : installa deps server con toolchain C++ per better-sqlite3
# Target finale (server) : single-container, serve API+WS sul :3000 e la ui/dist
#                          statica dalla stessa origin. UI usa URL relativi (vedi
#                          ui/src/site.ts) quindi nessuna config aggiuntiva serve.
# Target alternativo (ui): runtime separato per servire ui/dist via vite preview
#                          (legacy, mantenuto per docker-compose dev).

############################################################
# Base — utente non-root condiviso fra i target finali
############################################################
FROM node:22-bookworm-slim AS base
# `git` serve all'agente Pi (tool `bash`) per il flow publish: commit + push
# verso il repo cliente. Auth via GitHub App installation token (vedi
# tharvel/server/github-app.ts), niente credenziali persistite nel .git/config.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r tharvel && useradd -r -g tharvel -m -d /home/tharvel tharvel

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
# Target: ui runtime — serve dist via vite preview (LEGACY, solo docker-compose dev)
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

############################################################
# Target: server runtime — DEFAULT (ultimo stage, usato da Coolify se non specificato).
# Single-container produzione: API + WS + ui/dist statica.
############################################################
FROM base AS server
WORKDIR /app
COPY --from=server-deps /build/tharvel/node_modules ./node_modules
COPY --from=server-deps /build/tharvel/server/node_modules ./server/node_modules
COPY tharvel/package.json ./
COPY tharvel/server/ ./server/
COPY tharvel/shared/ ./shared/
COPY --from=ui-builder /build/tharvel/ui/dist ./ui-dist
RUN mkdir -p /data /var/tharvel/sites \
    && chown -R tharvel:tharvel /app /data /var/tharvel
USER tharvel
# Identità git per i commit prodotti dall'agente durante il publish. Tieni una
# email "fittizia ma valida" come autore — i commit sono firmati a nome del
# bot, l'attribuzione al cliente reale arriva dal messaggio + dal contesto chat.
ENV NODE_ENV=production \
    PORT=3000 \
    THARVEL_DB_PATH=/data/tharvel.db \
    THARVEL_SITES_ROOT=/var/tharvel/sites \
    GIT_AUTHOR_NAME="Tharvel Bot" \
    GIT_AUTHOR_EMAIL="tharvel@cristal-orion.it" \
    GIT_COMMITTER_NAME="Tharvel Bot" \
    GIT_COMMITTER_EMAIL="tharvel@cristal-orion.it"
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
