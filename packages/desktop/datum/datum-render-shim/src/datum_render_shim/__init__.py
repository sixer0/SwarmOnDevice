"""datum-render-shim 1.2.0: the client side of Swarm's DATUM render bridge.

DATUM's scripts render through `rsvg-convert` (datum_render.py, datum_diagram.py --png) and,
for `--check-page`, through `playwright.sync_api`. In Swarm neither exists. This package and
the `rsvg-convert` stand-in forward those calls to the render bridge in Swarm's Electron main
process, which renders with Electron's own Chromium (runtime spec section 3.2).

Wire contract (runtime spec 3.2 (a)): one Unix-socket connection per request, one JSON line
each way. The socket path and the per-launch token come from the environment Swarm gives
its sidecar (`DATUM_RENDER_SOCKET`, `DATUM_RENDER_TOKEN`). Requests:

    {"op":"png", "src", "dst", "width", "height", "token"}
    {"op":"pdf", "src", "dst", "widthMm", "heightMm", "token"}
    {"op":"checkPage", "html", "wMm", "hMm", "script", "width", "height", "token"}

The reply is one JSON object: {"ok": true, "electron": "<ver>", "result": ...} or
{"ok": false, "error": "<text>"}. Only AF_UNIX sockets are used: no network.
"""

import json
import os
import re
import socket
import stat

__version__ = "1.2.0"

ENV_SOCKET = "DATUM_RENDER_SOCKET"
ENV_TOKEN = "DATUM_RENDER_TOKEN"

# The exact message of runtime spec section 3.3.
NOT_RUNNING = "Swarm app not running: DATUM rendering needs Swarm open"

CONNECT_TIMEOUT_S = 5.0
REPLY_TIMEOUT_S = 180.0
MAX_REPLY_BYTES = 4 * 1024 * 1024

_VERSION_RE = re.compile(r"[0-9A-Za-z.+\-]{1,40}")
_UNPRINTABLE_RE = re.compile(r"[^\x20-\x7e]")
MM_PER_IN = 25.4


class BridgeUnavailable(Exception):
    """The render bridge cannot be reached: Swarm is closed or the env is missing."""

    def __init__(self):
        super().__init__(NOT_RUNNING)


class BridgeError(Exception):
    """The bridge was reached but the request failed."""


def _env():
    path = os.environ.get(ENV_SOCKET, "")
    token = os.environ.get(ENV_TOKEN, "")
    if not path or not token or not os.path.isabs(path):
        raise BridgeUnavailable()
    return path, token


def available():
    """True when the env names a socket file that exists. A stale socket still fails later,
    at connect time, with the same BridgeUnavailable."""
    try:
        path, _ = _env()
        return stat.S_ISSOCK(os.stat(path).st_mode)
    except (BridgeUnavailable, OSError):
        return False


def _clean(text, limit=300):
    """Bridge text is shown to the user; keep it short and printable."""
    return _UNPRINTABLE_RE.sub(" ", str(text))[:limit]


def request(op, **fields):
    """Send one request, return the reply dict. Raises BridgeUnavailable or BridgeError."""
    path, token = _env()
    msg = dict(fields)
    msg["op"] = op
    msg["token"] = token
    line = (json.dumps(msg, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(CONNECT_TIMEOUT_S)
        try:
            sock.connect(path)
        except OSError:
            # ENOENT, ECONNREFUSED (stale socket), EACCES, timeout: Swarm is not serving.
            raise BridgeUnavailable() from None
        sock.settimeout(REPLY_TIMEOUT_S)
        buf = bytearray()
        try:
            sock.sendall(line)
            while b"\n" not in buf:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > MAX_REPLY_BYTES:
                    raise BridgeError("render bridge reply too large")
        except TimeoutError:
            raise BridgeError("render bridge did not answer in time") from None
        except OSError as exc:
            raise BridgeError(f"render bridge connection failed ({exc.__class__.__name__})") from None
    finally:
        sock.close()

    raw = bytes(buf).split(b"\n", 1)[0]
    if not raw:
        raise BridgeError("render bridge closed the connection without a reply")
    try:
        reply = json.loads(raw)
    except ValueError:
        raise BridgeError("render bridge sent an unreadable reply") from None
    if not isinstance(reply, dict):
        raise BridgeError("render bridge sent an unreadable reply")
    if reply.get("ok") is not True:
        raise BridgeError(_clean(reply.get("error") or reply.get("code") or "render failed"))
    return reply


def electron_version(reply):
    ver = reply.get("electron")
    if isinstance(ver, str) and _VERSION_RE.fullmatch(ver):
        return ver
    return "unknown"


def label(reply):
    """The stderr line of runtime spec 3.2 (b), so a log never mistakes the shim for librsvg."""
    return f"rsvg-convert: DATUM shim -> Swarm Chromium (Electron {electron_version(reply)})"


def svg_size_mm(path):
    """Same rule as datum_render.py svg_size_mm (render.py:36-48): the root's mm size, else the
    viewBox in user units as mm, else 166 x 100."""
    with open(path, encoding="utf-8") as fh:
        head = fh.read(2048)
    w = re.search(r'\bwidth="([0-9.]+)mm"', head)
    h = re.search(r'\bheight="([0-9.]+)mm"', head)
    if w and h:
        return float(w.group(1)), float(h.group(1))
    vb = re.search(r'viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"', head)
    if vb:
        return float(vb.group(1)), float(vb.group(2))
    return 166.0, 100.0
