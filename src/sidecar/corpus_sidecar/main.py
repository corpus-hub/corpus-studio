"""Corpus Studio Python sidecar — protocol host.

This is the TRIVIAL sidecar that proves the packaging mechanism end to end:
it is spawned from the packaged app via `resourcePath('sidecar', …)`, speaks the
framed-JSON protocol the pipeline design specifies, and exits when its parent
dies. Real ops (pdfplumber table extraction) are added as entries in `OPS`.

Protocol: one request per line on stdin, one response per line on stdout.

    -> {"id": 1, "op": "ping", "args": {}}
    <- {"id": 1, "ok": true, "result": {...}}
    <- {"id": 1, "ok": false, "error": "...", "kind": "transient"}

Constraints this file must keep (from tmp/pipeline-design.md §14.5):
  * NEVER touch the database and NEVER open a socket. Bytes in, JSON out.
  * Die when the parent dies. The parent passes a dedicated liveness pipe on
    fd 3; a watchdog thread blocks reading it and calls os._exit(1) on EOF.
    It must NOT be stdin — stdin carries request frames, so a watchdog reading
    it would steal them, and the request loop cannot notice EOF while blocked
    inside a long-running op.
  * Be kill-safe: the parent tree-kills us, so there is no cooperative cancel.
"""

from __future__ import annotations

import json
import os
import sys
import threading

PROTOCOL_VERSION = 1
LIVENESS_FD = 3


def op_ping(args: dict) -> dict:
    """Liveness + identity. Used by the packaging verification."""
    return {
        "pong": True,
        "protocol": PROTOCOL_VERSION,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "echo": args.get("echo"),
    }


def op_envkeys(args: dict) -> dict:
    """Report the NAMES of the environment variables this process was given.

    Names only, never values — a check that leaked the secret it is checking
    for would be worse than no check. `verify:sidecar` asserts the gateway
    credential is absent, which is a claim about what the PARENT passed and can
    only be settled from inside the child.
    """
    return {"keys": sorted(os.environ.keys())}


OPS = {"ping": op_ping, "envkeys": op_envkeys}


def _watch_parent() -> None:
    """Exit the moment the parent's end of the liveness pipe closes.

    EOF arrives when the parent dies for ANY reason including SIGKILL, because
    the kernel closes its file descriptors. PR_SET_PDEATHSIG is not used: Node
    cannot set it, and it fires on the death of the parent THREAD, which under a
    libuv threadpool is a spurious-kill hazard.
    """
    try:
        with os.fdopen(LIVENESS_FD, "rb", buffering=0) as pipe:
            while pipe.read(1):
                pass
    except OSError:
        # No liveness pipe was passed (e.g. --selftest). Nothing to watch.
        return
    os._exit(1)


def serve() -> int:
    if _fd_open(LIVENESS_FD):
        threading.Thread(target=_watch_parent, daemon=True).start()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _respond({"id": None, "ok": False, "error": f"bad frame: {exc}", "kind": "permanent"})
            continue

        req_id = req.get("id")
        handler = OPS.get(req.get("op"))
        if handler is None:
            _respond(
                {
                    "id": req_id,
                    "ok": False,
                    "error": f"unknown op: {req.get('op')!r}",
                    "kind": "permanent",
                }
            )
            continue
        try:
            _respond({"id": req_id, "ok": True, "result": handler(req.get("args") or {})})
        except Exception as exc:  # noqa: BLE001 - any op failure is a protocol response
            _respond({"id": req_id, "ok": False, "error": str(exc), "kind": "transient"})
    return 0


def _fd_open(fd: int) -> bool:
    try:
        os.fstat(fd)
        return True
    except OSError:
        return False


def _respond(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        result = op_ping({"echo": "selftest"})
        print(json.dumps(result, indent=2))
        return 0
    return serve()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
