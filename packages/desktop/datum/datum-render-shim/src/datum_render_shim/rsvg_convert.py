"""`rsvg-convert` stand-in: exactly the call shapes DATUM's scripts use.

    rsvg-convert -w W -h H -o DST SRC      datum_render.py render_png (render.py:62)
    rsvg-convert -w W -o DST SRC           datum_diagram.py to_png (diagram.py:2032)
    rsvg-convert -f pdf -o DST SRC         datum_render.py render_pdf (render.py:116)
    rsvg-convert -v | --version

Run as `python3 -I -B -m datum_render_shim.rsvg_convert` by bin/rsvg-convert. Exit 0 when the
bridge wrote DST, 1 otherwise (runtime spec 3.2 (b)).
"""

import os
import sys

from . import (NOT_RUNNING, BridgeError, BridgeUnavailable, __version__, label, request,
               svg_size_mm)

USAGE = ("usage: rsvg-convert -w W [-h H] -o DST.png SRC.svg | "
         "rsvg-convert -f pdf -o DST.pdf SRC.svg  (DATUM shim subset)")
MAX_PX = 32767


class UsageError(Exception):
    pass


def _px(value, flag):
    try:
        n = int(value, 10)
    except (TypeError, ValueError):
        raise UsageError(f"{flag} needs a whole number of pixels") from None
    if not 1 <= n <= MAX_PX:
        raise UsageError(f"{flag} must be between 1 and {MAX_PX}")
    return n


def parse(argv):
    opts = {"w": None, "h": None, "o": None, "f": "png"}
    src = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("-w", "-h", "-o", "-f"):
            if i + 1 >= len(argv):
                raise UsageError(f"{arg} needs a value")
            opts[arg[1]] = argv[i + 1]
            i += 2
            continue
        if arg.startswith("-") and arg != "-":
            raise UsageError(f"option {arg} is not supported by the DATUM shim")
        if src is not None:
            raise UsageError("exactly one input file")
        src = arg
        i += 1

    if src is None or src == "-":
        raise UsageError("an input SVG file is required (stdin is not supported)")
    if not opts["o"]:
        raise UsageError("-o DST is required (stdout is not supported)")
    fmt = opts["f"].lower()
    if fmt not in ("png", "pdf"):
        raise UsageError(f"format {opts['f']} is not supported (png, pdf)")
    dst = os.path.abspath(opts["o"])
    src = os.path.abspath(src)
    if not os.path.isfile(src):
        raise UsageError(f"input not found: {src}")
    if not dst.lower().endswith("." + fmt):
        raise UsageError(f"output must end .{fmt}")

    if fmt == "pdf":
        if opts["w"] is not None or opts["h"] is not None:
            raise UsageError("-w/-h are not supported with -f pdf")
        w_mm, h_mm = svg_size_mm(src)
        return "pdf", {"src": src, "dst": dst, "widthMm": w_mm, "heightMm": h_mm}

    if opts["w"] is None:
        raise UsageError("-w W is required for PNG")
    width = _px(opts["w"], "-w")
    if opts["h"] is not None:
        height = _px(opts["h"], "-h")
    else:
        # Keep the SVG's aspect, from its declared mm size (same rule as render.py:36-48).
        w_mm, h_mm = svg_size_mm(src)
        height = max(1, min(MAX_PX, round(width * h_mm / w_mm))) if w_mm > 0 else width
    return "png", {"src": src, "dst": dst, "width": width, "height": height}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv in (["-v"], ["--version"]):
        print(f"rsvg-convert (datum-render-shim {__version__}, forwards to Swarm Chromium)")
        return 0
    try:
        op, fields = parse(argv)
    except UsageError as exc:
        print(f"rsvg-convert: {exc}\n{USAGE}", file=sys.stderr)
        return 1
    except (OSError, UnicodeDecodeError) as exc:
        print(f"rsvg-convert: cannot read input ({exc.__class__.__name__})", file=sys.stderr)
        return 1

    try:
        reply = request(op, **fields)
    except BridgeUnavailable:
        print(NOT_RUNNING, file=sys.stderr)
        return 1
    except BridgeError as exc:
        print(f"rsvg-convert: DATUM shim: render failed: {exc}", file=sys.stderr)
        return 1

    dst = fields["dst"]
    if not os.path.isfile(dst) or os.path.getsize(dst) == 0:
        print("rsvg-convert: DATUM shim: render bridge reported success but wrote no file",
              file=sys.stderr)
        return 1
    print(label(reply), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
