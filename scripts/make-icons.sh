#!/usr/bin/env bash
# Generate the application icon set into build/icons/ FROM THE IN-APP MARK.
#
# The source is src/renderer/logo.png — the same file the sidebar renders. One
# mark, so the icon a user sees in their taskbar, launcher and alt-tab is the
# icon they see inside the window; two sources drift and the app looks like two
# products. The mark is taller than it is wide, so it is padded (never cropped,
# never stretched) into a square with transparent margin.
#
#   scripts/make-icons.sh
#
# Requires ImageMagick (`convert`). png2icns/icnsutils is optional — without it
# the .icns is produced by ImageMagick, which macOS accepts for a dev build but
# which should be regenerated with `iconutil` on a Mac for a release.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=build/icons
mkdir -p "$OUT"

SRC=src/renderer/logo.png
if [ ! -f "$SRC" ]; then
  echo "missing $SRC" >&2
  exit 1
fi

# Square master: fit the mark inside ~86% of the canvas and pad the rest, so it
# keeps a margin at 16px the way every other launcher icon does.
MASTER=$(mktemp --suffix=.png)
trap 'rm -f "$MASTER"' EXIT
convert "$SRC" -background none -gravity center -resize 880x880 \
  -extent 1024x1024 "$MASTER"

# electron-builder's linux `icon: build/icons` wants a directory of NxN.png.
# 512 is also what it uses as the AppImage icon.
for size in 16 32 48 64 128 256 512 1024; do
  convert "$MASTER" -background none -resize "${size}x${size}" \
    "$OUT/${size}x${size}.png"
done
cp "$OUT/512x512.png" "$OUT/icon.png"

# Windows: nsis requires >=256px in the .ico.
convert "$OUT/16x16.png" "$OUT/32x32.png" "$OUT/48x48.png" "$OUT/64x64.png" \
  "$OUT/128x128.png" "$OUT/256x256.png" "$OUT/icon.ico"

# macOS. NOT via ImageMagick: `convert a.png icon.icns` silently writes a plain
# PNG with an .icns extension here, which electron-builder accepts and macOS
# then renders as a blank icon. png2icns if available, else build the container
# directly — the ICNS format is a header plus length-prefixed PNG members.
if command -v png2icns >/dev/null 2>&1; then
  png2icns "$OUT/icon.icns" "$OUT/16x16.png" "$OUT/32x32.png" "$OUT/128x128.png" \
    "$OUT/256x256.png" "$OUT/512x512.png"
else
  python3 scripts/make-icns.py "$OUT/icon.icns" \
    ic07:"$OUT/128x128.png" ic08:"$OUT/256x256.png" \
    ic09:"$OUT/512x512.png" ic10:"$OUT/1024x1024.png"
fi

echo "wrote icons to $OUT from $SRC"
