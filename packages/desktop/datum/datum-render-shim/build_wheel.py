"""Build datum_render_shim-1.2.0-py3-none-any.whl reproducibly, with the stdlib only.

    python3 -I -B build_wheel.py --out DIR      prints "<sha256>  <wheel path>"

Fixed timestamps, sorted entries and fixed modes, so two builds give the same bytes and the
runtime stage (row 23) can pin the wheel's sha256 and install it with
`pip install --no-index --no-deps --require-hashes --target <site-packages>`.
bin/rsvg-convert is not in the wheel: the stage copies it to datum-runtime/bin/ (mode 0755).
"""

import argparse
import base64
import hashlib
import os
import sys
import zipfile

NAME = "datum_render_shim"
VERSION = "1.2.0"
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
PACKAGES = ("datum_render_shim", "playwright")
DATE = (1980, 1, 1, 0, 0, 0)

METADATA = f"""Metadata-Version: 2.1
Name: datum-render-shim
Version: {VERSION}
Summary: Swarm's rsvg-convert and playwright.sync_api stand-ins for DATUM, forwarding to the Swarm render bridge (not Playwright)
License: MIT
Requires-Python: >=3.14
"""
WHEEL = """Wheel-Version: 1.0
Generator: datum-render-shim build_wheel.py
Root-Is-Purelib: true
Tag: py3-none-any
"""


def sources():
    out = []
    for pkg in PACKAGES:
        for root, dirs, files in os.walk(os.path.join(SRC, pkg)):
            dirs[:] = sorted(d for d in dirs if d != "__pycache__")
            for f in sorted(files):
                if f.endswith(".py"):
                    full = os.path.join(root, f)
                    out.append((os.path.relpath(full, SRC).replace(os.sep, "/"), full))
    return sorted(out)


def _digest(data):
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()


def build(out_dir):
    dist_info = f"{NAME}-{VERSION}.dist-info"
    entries = []
    for arc, full in sources():
        with open(full, "rb") as fh:
            entries.append((arc, fh.read()))
    entries.append((f"{dist_info}/METADATA", METADATA.encode()))
    entries.append((f"{dist_info}/WHEEL", WHEEL.encode()))
    entries.append((f"{dist_info}/top_level.txt", ("\n".join(PACKAGES) + "\n").encode()))
    record = "".join(f"{a},{_digest(d)},{len(d)}\n" for a, d in entries)
    record += f"{dist_info}/RECORD,,\n"
    entries.append((f"{dist_info}/RECORD", record.encode()))

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{NAME}-{VERSION}-py3-none-any.whl")
    with zipfile.ZipFile(path + ".part", "w") as zf:
        for arc, data in entries:
            info = zipfile.ZipInfo(arc, DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            zf.writestr(info, data, compresslevel=9)
    os.replace(path + ".part", path)
    with open(path, "rb") as fh:
        return path, hashlib.sha256(fh.read()).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True)
    path, sha = build(os.path.abspath(ap.parse_args().out))
    print(f"{sha}  {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
