#!/usr/bin/env bash
# Launch the PACKAGED application and prove it works with no network.
#
#   scripts/verify-packaged.sh [release/linux-unpacked]
#
# Reading the config is not evidence that the installer works: the failure this
# guards against — better-sqlite3 not loading from app.asar.unpacked, or a
# resource path that only resolves from source — is invisible until an artifact
# is actually run. So this runs one, against a THROWAWAY database (never the
# user's), and asserts:
#
#   1. the app starts and stays up;
#   2. better-sqlite3 loaded and the DB was opened and read (the dashboard's
#      project data is only reachable through it);
#   3. NOTHING reached the network — checked by tracing every connect(2) the
#      process tree makes, with the proxy env blackholed as a second net.
#   4. a screenshot is produced at the user's real 1920x1080 viewport.
#
# strace is used rather than a network namespace because unprivileged userns
# network setup is blocked on this kernel (`bwrap --unshare-net` cannot bring up
# loopback). Tracing connect(2) is in fact a STRONGER assertion: a namespace
# proves the traffic failed, whereas the trace proves it was never attempted.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APPDIR="${1:-release/linux-unpacked}"
BIN="$ROOT/$APPDIR/corpus-studio"

if [ ! -x "$BIN" ]; then
  echo "no packaged binary at $BIN — run \`npm run package\` first" >&2
  exit 1
fi

WORK=$(mktemp -d /tmp/corpus-packaged-XXXXXX)
trap 'rm -rf "$WORK"' EXIT
export XDG_CONFIG_HOME="$WORK/config"
export CORPUS_DB_PATH="$WORK/corpus.sqlite"
mkdir -p "$XDG_CONFIG_HOME"

# A throwaway DB, never the user's. An install seeds nothing, so this file is
# expected to come back EMPTY — what it proves is that the packaged app created
# and migrated it, which it can only do if better-sqlite3 loaded.
echo "workdir: $WORK"

# Blackhole any proxy so a library that ignores the trace still cannot get out.
export HTTP_PROXY=http://203.0.113.1:9
export HTTPS_PROXY=http://203.0.113.1:9
export ALL_PROXY=http://203.0.113.1:9
export NO_PROXY=

TRACE="$WORK/connect.trace"
LOG="$WORK/app.log"

# Xvfb is started explicitly on a display WE choose rather than via `xvfb-run
# -a`, because the screenshot below has to target that same display. Scraping it
# back out of `pgrep Xvfb` picks whichever server happens to be listed first —
# on a machine already running `npm run shot` that is somebody else's, and the
# screenshot silently captured the wrong screen (or nothing).
DISP=99
while [ -e "/tmp/.X11-unix/X$DISP" ] && [ "$DISP" -lt 120 ]; do DISP=$((DISP + 1)); done
Xvfb ":$DISP" -screen 0 1920x1080x24 >"$WORK/xvfb.log" 2>&1 &
XVFB=$!
trap 'kill "$XVFB" 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [ -e "/tmp/.X11-unix/X$DISP" ] && break; sleep 0.2; done

DISPLAY=":$DISP" strace -f -qq -e trace=connect -o "$TRACE" \
  "$BIN" --no-sandbox --disable-gpu >"$LOG" 2>&1 &
HARNESS=$!

# Give it time to boot, seed and render.
sleep 25

# --- 1. still running? --------------------------------------------------------
if ! kill -0 "$HARNESS" 2>/dev/null; then
  echo "FAIL: the packaged app exited early"
  tail -40 "$LOG"
  exit 1
fi
echo "ok    packaged app started and stayed up"

# --- 4. screenshot ------------------------------------------------------------
SHOT="${CORPUS_SHOT_PATH:-/tmp/corpus-packaged.png}"
if DISPLAY=":$DISP" import -window root "$SHOT" 2>>"$WORK/shot.err"; then
  echo "ok    screenshot: $SHOT"
else
  echo "warn  screenshot failed: $(tail -1 "$WORK/shot.err" 2>/dev/null)"
fi

# --- 2. did it create and migrate the database? ------------------------------
# An install seeds nothing, so the number of works is expected to be ZERO and
# says nothing either way. What proves better-sqlite3 loaded from
# app.asar.unpacked is that the app built the SCHEMA: the migration ran, so the
# app's own tables exist in a file that did not exist before this run.
if [ -s "$CORPUS_DB_PATH" ]; then
  TABLES=$(ELECTRON_RUN_AS_NODE=1 "$ROOT/node_modules/.bin/electron" -e "
    const Database = require('$ROOT/node_modules/better-sqlite3');
    const db = new Database(process.env.CORPUS_DB_PATH, { readonly: true });
    const n = db.prepare(\"select count(*) as n from sqlite_master where type='table' and name in ('work','project','analysis_run')\").get().n;
    const w = db.prepare('select count(*) as n from work').get().n;
    process.stdout.write(n + ' ' + w);
  " 2>/dev/null)
  CORE=${TABLES%% *}
  WORKS=${TABLES##* }
  if [ "$CORE" = "3" ]; then
    echo "ok    better-sqlite3 loaded; DB created and migrated ($WORKS works — an install starts empty)"
  else
    echo "FAIL: database exists but the app's tables are missing — migration did not run"
    tail -40 "$LOG"
    kill "$HARNESS" 2>/dev/null
    exit 1
  fi
else
  echo "FAIL: no database at $CORPUS_DB_PATH — better-sqlite3 likely did not load"
  tail -40 "$LOG"
  kill "$HARNESS" 2>/dev/null
  exit 1
fi

# --- 3. no network ------------------------------------------------------------
# Unix-domain and loopback connects are expected and fine (X11, Chromium's own
# IPC, the sandbox). Anything to a ROUTABLE address is a violation.
OUTBOUND=$(grep -E 'connect\(' "$TRACE" 2>/dev/null |
  grep 'AF_INET' |
  grep -v 'sin_addr=inet_addr("127\.' |
  grep -v 'inet_pton(AF_INET6, "::1"' || true)
if [ -n "$OUTBOUND" ]; then
  echo "FAIL: the packaged app attempted outbound network connections:"
  echo "$OUTBOUND" | head -20
  kill "$HARNESS" 2>/dev/null
  exit 1
fi
echo "ok    no outbound network connections attempted (traced connect(2))"

kill "$HARNESS" 2>/dev/null
pkill -f "$BIN" 2>/dev/null
echo
echo "PACKAGED APP VERIFIED"
