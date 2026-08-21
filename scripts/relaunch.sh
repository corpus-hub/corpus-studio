#!/usr/bin/env bash
# Rebuild (unless --no-build) and restart the app as ONE command.
#
# WHY THIS EXISTS. `pkill -f electron & npm start` in a single shell races: the
# pkill pattern matches the newly-spawned process as often as the old one, so
# the launch dies immediately and silently. This waits for the old instance to
# actually exit before starting the new one, and reports the real outcome.
#
# And a substring pattern cannot identify this app at all. `npm start` runs
# `electron-vite preview`, which spawns `<repo>/node_modules/electron/dist/
# electron .` — a cmdline containing neither `out/main` nor the repo name. So we
# match by EXECUTABLE (`readlink /proc/<pid>/exe` == this repo's electron binary)
# plus the `electron-vite preview` supervisor. Killing only the children would
# leave the supervisor holding the DB handle, and a second instance would then
# contend for the same SQLite file.
#
# It escalates to SIGKILL if an instance is wedged, then starts a detached one
# and verifies it came up, printing `running · logs: /tmp/corpus-studio.log` or
# the tail of the log on failure.
#
# Usage:
#   scripts/relaunch.sh              rebuild, then restart
#   scripts/relaunch.sh --no-build   restart the current build
#   scripts/relaunch.sh --seed       reseed a fresh DB first, then rebuild+restart
set -uo pipefail

cd "$(dirname "$0")/.."

BUILD=1
SEED=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --seed) SEED=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

LOG=/tmp/corpus-studio.log

ROOT="$PWD"
ELECTRON_BIN="$ROOT/node_modules/electron/dist/electron"

# --- stop any running instance -------------------------------------------------
# Identify our processes by their EXECUTABLE (this repo's vendored electron
# binary), not by a cmdline substring. `npm start` runs `electron-vite preview`,
# which spawns `<repo>/node_modules/electron/dist/electron .` — a cmdline that
# contains neither "out/main" nor this repo's name, so substring patterns match
# nothing and the old instance survives the "kill".
#
# THE EXECUTABLE IS NOT ENOUGH ON ITS OWN: the environment decides too.
#
# A plugin host runs `ELECTRON_RUN_AS_NODE=1 <this repo's electron> host.js`, so
# it passes the exe test exactly as the app does — it IS this tree's binary. That
# made this function report a node helper as a running app, and the START check
# below shares the function: it found the retriever's host, printed
# "running · logs: …" and exited 0 while the app itself had died on boot. The
# script's whole promise is that it reports the real outcome, and it was
# reporting the outcome of a different process.
#
# `ELECTRON_RUN_AS_NODE` in the environment is what tells the two apart, and it
# is read from /proc rather than assumed from the cmdline, which a host is free
# to shape however it likes.
is_app_process() {
  local pid=$1 exe
  exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null) || return 1
  [ "$exe" = "$ELECTRON_BIN" ] || return 1
  tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qx 'ELECTRON_RUN_AS_NODE=1' && return 1
  return 0
}

instance_pids() {
  local pid
  for pid in $(pgrep -x electron 2>/dev/null); do
    is_app_process "$pid" && echo "$pid"
  done
  # The electron-vite preview supervisor: killing only the children leaves it
  # alive and it would keep the port/DB handle open.
  pgrep -f "electron-vite preview" 2>/dev/null || true

  # AN INSTALLED COPY IS AN INSTANCE TOO, and stopping only this tree's was why
  # the script could report success over a launch that never happened.
  #
  # A packaged build (the AppImage, the deb) is the SAME app on the SAME
  # userData: it holds `requestSingleInstanceLock` and the WAL lock on
  # `defaultDbPath()`. So with one running, `npm start` exits within a second —
  # correctly, that refusal is the lock working — and the user goes on looking at
  # the installed copy, which is a build from before whatever was just changed.
  # That is the exact failure this script exists to prevent, arriving through the
  # one instance it did not look for.
  #
  # Matched by executable NAME rather than path: an AppImage mounts itself under
  # a fresh `/tmp/.mount_<random>/` every launch, so there is no stable path to
  # compare against. Only the main process is listed — killing it takes its own
  # children with it — and it is identified by having no `--type=` argument.
  local pid exe
  for pid in $(pgrep -x corpus-studio 2>/dev/null); do
    exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null) || continue
    [ "$exe" = "$ELECTRON_BIN" ] && continue
    grep -qz -- '--type=' "/proc/$pid/cmdline" 2>/dev/null && continue
    echo "$pid"
  done
}

stop_instance() {
  local pids
  pids=$(instance_pids | sort -u)
  [ -z "$pids" ] && return 0

  echo "stopping running instance…"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 50); do
    [ -z "$(instance_pids)" ] && return 0
    sleep 0.1
  done

  # Still alive after 5s: it is wedged, so escalate rather than launch a second
  # instance that would contend for the same SQLite file.
  echo "did not exit; sending SIGKILL"
  pids=$(instance_pids | sort -u)
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  sleep 1

  if [ -n "$(instance_pids)" ]; then
    echo "FAILED to stop the running instance; refusing to start a second one" >&2
    exit 1
  fi
}

stop_instance

if [ "$SEED" = "1" ]; then
  echo "seeding a fresh database…"
  npm run seed:fresh >"$LOG" 2>&1 || { echo "seed FAILED — see $LOG"; exit 1; }
fi

if [ "$BUILD" = "1" ]; then
  echo "building…"
  npm run build >"$LOG" 2>&1 || { echo "build FAILED — see $LOG"; tail -20 "$LOG"; exit 1; }
fi

# --- start ---------------------------------------------------------------------
# setsid detaches from this script's process group, so the app survives the
# shell that launched it.
echo "starting…"
setsid npm start >"$LOG" 2>&1 &

# Confirm it actually came up rather than reporting success optimistically.
# Wait for the electron BINARY, not the `electron-vite preview` supervisor: the
# supervisor appears within milliseconds and is still there when the app itself
# crashes on boot, so waiting on it would report success for a dead app.
for _ in $(seq 1 60); do
  sleep 0.5
  for pid in $(pgrep -x electron 2>/dev/null); do
    if is_app_process "$pid"; then
      echo "running · logs: $LOG"
      exit 0
    fi
  done
done

echo "app did NOT start within 30s — last lines of $LOG:"
tail -20 "$LOG"
exit 1
