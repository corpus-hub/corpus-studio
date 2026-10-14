#!/usr/bin/env python3
"""Assemble a real macOS .icns container from PNG members.

Used by scripts/make-icons.sh on hosts without `png2icns`. ImageMagick is NOT a
substitute: `convert x.png out.icns` writes a bare PNG under an .icns name,
which electron-builder happily packages and macOS renders as a blank icon.

    make-icns.py OUT.icns ic07:128.png ic08:256.png ic09:512.png ic10:1024.png

The format is a 'icns' magic + total length, then per member a 4-byte OSType,
a 4-byte big-endian length covering the header itself, and the raw PNG bytes.
"""
import struct
import sys


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    out_path, members = argv[1], argv[2:]

    body = b""
    for member in members:
        ostype, _, png_path = member.partition(":")
        if len(ostype) != 4 or not png_path:
            print(f"bad member spec: {member!r}", file=sys.stderr)
            return 2
        with open(png_path, "rb") as fh:
            data = fh.read()
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            print(f"{png_path} is not a PNG", file=sys.stderr)
            return 1
        body += ostype.encode("ascii") + struct.pack(">I", len(data) + 8) + data

    with open(out_path, "wb") as fh:
        fh.write(b"icns" + struct.pack(">I", len(body) + 8) + body)
    print(f"wrote {out_path} ({len(body) + 8} bytes, {len(members)} members)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
