#!/usr/bin/env bash
# Rebuild and restart THIS WORKTREE's app, without touching any other checkout.
#
# WHY NOT `scripts/relaunch.sh`. That script identifies instances by their
# EXECUTABLE — `<repo>/node_modules/electron/dist/electron`. A worktree symlinks
# `node_modules` at the main checkout, so both trees resolve to the SAME binary
# and relaunch.sh would kill the user's main-branch app while trying to restart
# this one. (Verified: a main instance was running with that exact exe path.)
#
# So instances are matched by WORKING DIRECTORY instead: /proc/<pid>/cwd is the
# only thing that actually distinguishes two checkouts sharing one binary. The
# `electron-vite preview` supervisor is matched the same way — killing only the
# children leaves it holding the DB handle, and the next launch then contends
# for the same SQLite file.
#
# The DB is this worktree's own copy (.appdata), NEVER the user's real library,
# so a redesign in progress cannot write to the corpus they actually work in.
#
# Usage:
#   scripts/wt-launch.sh              rebuild, then restart
#   scripts/wt-launch.sh --no-build   restart the current build
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG=/tmp/corpus-studio-worktree.log
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- pids whose cwd is THIS worktree ------------------------------------------
instance_pids() {
  local pid cwd
  for pid in $(pgrep -x electron 2>/dev/null) $(pgrep -f 'electron-vite preview' 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || continue
    [ "$cwd" = "$ROOT" ] && echo "$pid"
  done
}

stop_instance() {
  local pids
  pids=$(instance_pids | sort -u)
  [ -z "$pids" ] && return 0
  echo "stopping this worktree's instance…"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 50); do
    [ -z "$(instance_pids)" ] && return 0
    sleep 0.1
  done
  echo "did not exit; sending SIGKILL"
  pids=$(instance_pids | sort -u)
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  sleep 1
  if [ -n "$(instance_pids)" ]; then
    echo "FAILED to stop it; refusing to start a second one" >&2
    exit 1
  fi
}

stop_instance

if [ "$BUILD" = 1 ]; then
  echo "building…"
  npm run build >"$LOG" 2>&1 || { echo "build FAILED — see $LOG"; tail -20 "$LOG"; exit 1; }
fi

echo "starting…"
setsid env XDG_CONFIG_HOME="$ROOT/.appdata" \
  CORPUS_PDF_DIR="/media/varingait/Lobotomite/science-search-aggregator/data/pdfs" \
  npm start >"$LOG" 2>&1 &

# Confirm it actually came up rather than reporting success optimistically.
for _ in $(seq 1 60); do
  sleep 0.5
  if [ -n "$(instance_pids)" ]; then
    echo "running · logs: $LOG"
    exit 0
  fi
done

echo "did NOT start within 30s — last lines of $LOG:"
tail -20 "$LOG"
exit 1
