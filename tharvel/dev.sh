#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `bash -c` in gnome-terminal è non-login non-interactive: NON sorgenta .bashrc,
# quindi nvm non viene caricato e si finisce sul Node di sistema (18.x), troppo
# vecchio per Vite/tsx. Sorgentiamo nvm.sh esplicitamente prima del comando.
NVM_INIT='[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"'

# Log su file (oltre che a schermo) per poter ricostruire i loop dell'agente:
# tee -a appende, così riavvii incrementali del watcher non perdono storia.
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"

gnome-terminal --title="Tharvel · server" --working-directory="$DIR/server" -- bash -c "$NVM_INIT; npm run dev 2>&1 | tee -a $LOG_DIR/server.log; exec bash"
gnome-terminal --title="Tharvel · ui"     --working-directory="$DIR/ui"     -- bash -c "$NVM_INIT; npm run dev 2>&1 | tee -a $LOG_DIR/ui.log; exec bash"
