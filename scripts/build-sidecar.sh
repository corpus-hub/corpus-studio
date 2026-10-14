#!/usr/bin/env bash
# Assemble the Python sidecar payload into resources/sidecar/<platform>/.
#
# WHY python-build-standalone AND NOT PyInstaller: PyInstaller cannot
# cross-compile, so it would need a macOS host and a Windows host just to
# PRODUCE the payloads. python-build-standalone publishes redistributable
# per-platform interpreter tarballs, so this Linux machine can assemble all
# three; only macOS *signing* still needs a Mac (which the dmg needs anyway,
# because better-sqlite3 must be compiled there). It also avoids PyInstaller's
# unpack-to-temp-at-every-start bootloader, which costs startup time and is
# awkward under the macOS hardened runtime.
#
#   scripts/build-sidecar.sh                 # host platform
#   scripts/build-sidecar.sh linux x86_64
#
# The sidecar is PURE PYTHON plus whatever wheels are installed into the
# interpreter tree. It never touches the database and never opens a socket:
# bytes in, JSON out, per the pipeline design.
set -euo pipefail

cd "$(dirname "$0")/.."

PLATFORM="${1:-}"
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Linux) PLATFORM=linux ;;
    Darwin) PLATFORM=darwin ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM=win32 ;;
    *) echo "unsupported host: $(uname -s)" >&2; exit 1 ;;
  esac
fi
ARCH="${2:-$(uname -m)}"

DEST="resources/sidecar/$PLATFORM"
mkdir -p "$DEST"

# The interpreter. Preference order:
#   1. an already-unpacked python-build-standalone tree at $PBS_DIR
#   2. the host python3 (LINUX DEV ONLY — not redistributable, and this script
#      says so loudly rather than shipping a payload that only works here)
if [ -n "${PBS_DIR:-}" ]; then
  echo "using python-build-standalone tree: $PBS_DIR"
  rm -rf "$DEST/python"
  cp -a "$PBS_DIR" "$DEST/python"
  PY="$DEST/python/bin/python3"
else
  echo "PBS_DIR unset — linking the HOST interpreter." >&2
  echo "  This payload is for LOCAL VERIFICATION ONLY and must not be shipped:" >&2
  echo "  download a python-build-standalone tarball for $PLATFORM/$ARCH from" >&2
  echo "  https://github.com/astral-sh/python-build-standalone/releases," >&2
  echo "  unpack it, and re-run with PBS_DIR=<tree>." >&2
  mkdir -p "$DEST/python/bin"
  ln -sf "$(command -v python3)" "$DEST/python/bin/python3"
  PY="$DEST/python/bin/python3"
fi

# The sidecar sources. Pure Python, copied verbatim.
rm -rf "$DEST/corpus_sidecar"
cp -a src/sidecar/corpus_sidecar "$DEST/corpus_sidecar"

# Third-party wheels (pdfplumber et al.) go into the interpreter tree with uv.
# UV_CACHE_DIR must be on the SAME filesystem as this repo or uv copies multi-GB
# wheels instead of hardlinking them from its shared cache.
if [ -f src/sidecar/requirements.txt ] && [ -s src/sidecar/requirements.txt ]; then
  export UV_CACHE_DIR="${UV_CACHE_DIR:-/media/varingait/Lobotomite/.uv-cache}"
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$PY" --target "$DEST/site-packages" \
      -r src/sidecar/requirements.txt
  else
    echo "uv not installed; skipping third-party wheels" >&2
  fi
fi

chmod -R u+rwX,go+rX "$DEST"
echo "sidecar payload assembled at $DEST"
"$PY" "$DEST/corpus_sidecar/main.py" --selftest
