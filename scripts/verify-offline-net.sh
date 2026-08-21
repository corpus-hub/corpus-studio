#!/usr/bin/env bash
# PROVE the offline rule by observation, not by reading the source.
#
#   npm run verify:offline:net
#
# `verify:offline` greps for URLs and asserts that our own offline flags are
# still set. Neither can see inside a dependency: tesseract.js's CDN default and
# transformers.js's hub fetch live in code we did not write, and the packaged
# node_modules is not in the bundle the URL grep walks. So the only real proof
# is to run the thing and watch the syscalls.
#
# WHY strace AND NOT A NETWORK NAMESPACE: `unshare -rn` is refused on this
# kernel (`apparmor_restrict_unprivileged_userns=1`), and `bwrap --unshare-net`
# cannot bring up loopback. `resources/payloads.json` and the header of
# `verify-payloads.ts` still suggest `unshare -rn`; that advice is dead here.
# Tracing connect(2) is also a STRONGER assertion: a namespace proves a fetch
# would have failed, this proves none was attempted.
#
# The proxies are blackholed as a second net: anything that consults them tries
# to reach 203.0.113.1 (TEST-NET-3, guaranteed unroutable) and shows up in the
# trace rather than quietly succeeding through a real proxy.
set -uo pipefail
cd "$(dirname "$0")/.."

if ! command -v strace >/dev/null 2>&1; then
  echo "strace is not installed — cannot PROVE the offline claim, only assert it." >&2
  echo "Install strace, or run this on a machine that has it." >&2
  exit 1
fi

TRACE="$(mktemp -t corpus-offline-trace-XXXXXX)"
OUT="$(mktemp -t corpus-offline-out-XXXXXX)"
trap 'rm -f "$TRACE" "$OUT"' EXIT

TARGET="${1:-payloads}"
case "$TARGET" in
  payloads) CMD=(env ELECTRON_RUN_AS_NODE=1 npx electron --import tsx scripts/verify-payloads.ts) ;;
  pipeline) CMD=(env ELECTRON_RUN_AS_NODE=1 npx electron --import tsx scripts/verify-pipeline.ts) ;;
  *) echo "usage: $0 [payloads|pipeline]" >&2; exit 2 ;;
esac

echo "tracing connect(2) while running: $TARGET"
HTTP_PROXY=http://203.0.113.1:9 \
HTTPS_PROXY=http://203.0.113.1:9 \
ALL_PROXY=http://203.0.113.1:9 \
  strace -f -qq -e trace=connect -o "$TRACE" "${CMD[@]}" >"$OUT" 2>&1
STATUS=$?

tail -20 "$OUT"

# Loopback is exempt: Electron's own internals talk to themselves, and a local
# socket is not a network fetch. Anything else is a violation.
ROUTABLE=$(grep 'AF_INET' "$TRACE" 2>/dev/null | grep -v '127\.0\.0\.1' | grep -v '"::1"' || true)
COUNT=$(printf '%s' "$ROUTABLE" | grep -c . || true)

echo
if [ "$STATUS" -ne 0 ]; then
  echo "FAIL  the traced run itself failed (exit $STATUS) — see the output above"
  exit 1
fi
if [ "$COUNT" -ne 0 ]; then
  echo "FAIL  $COUNT routable connect(2) call(s) — the offline rule is BROKEN:"
  printf '%s\n' "$ROUTABLE" | head -20
  exit 1
fi
echo "ok    zero routable connect(2) calls — nothing was fetched"
