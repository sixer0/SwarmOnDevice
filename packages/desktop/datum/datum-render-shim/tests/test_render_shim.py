"""Tests for datum-render-shim against a fake render bridge.

Run with the row 15 probe interpreter (never a host python):

    tools/build/datum_runtime_probe/python/bin/python3 -I -B \
        swarm/packages/desktop/datum/datum-render-shim/tests/test_render_shim.py

The module builds a fixture Resources tree in a fresh folder under $ROW106_SCRATCH
(default /private/tmp/claude-501/row106): an APFS clone of the probe interpreter with the shim
wheel installed, the 5-level datum-house-style.pth (F2 rule), bin/rsvg-convert, and a test
datum-python launcher written to runtime spec 1.6 (PATH=$here:/usr/bin:/bin, -I -B). DATUM's
scripts are run from the repo copy unchanged. The probe folder itself is never written.
"""

import hashlib
import importlib.util
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SHIM = os.path.dirname(HERE)
REPO_DESKTOP = os.path.dirname(os.path.dirname(SHIM))
SKILL = os.path.join(REPO_DESKTOP, "datum", "datum-house-style")
SWARM_ONDEVICE = os.path.dirname(os.path.dirname(os.path.dirname(REPO_DESKTOP)))
PROBE_PY = os.path.join(SWARM_ONDEVICE, "tools", "build", "datum_runtime_probe", "python")
GAMBAR = os.path.join(SWARM_ONDEVICE, "docs", "2026-11-06_swarm_1_2_0_datum_installer", "test",
                      "material", "Kasus 04 Diagram", "gambar.json")
SCRATCH = os.environ.get("ROW106_SCRATCH", "/private/tmp/claude-501/row106")
TOKEN = "t" * 64
ELECTRON = "42.3.3"

sys.path.insert(0, os.path.join(SHIM, "src"))
import datum_render_shim  # noqa: E402
from datum_render_shim import rsvg_convert  # noqa: E402
import playwright  # noqa: E402
from playwright import sync_api  # noqa: E402

FX = {}


def png_bytes(w, h):
    raw = b"".join(b"\x00" + b"\xff" * (w * 3) for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def png_size(path):
    with open(path, "rb") as fh:
        head = fh.read(24)
    assert head[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", head[16:24])


class FakeBridge:
    """Stands in for row 24's bridge: token check, absolute paths, .png/.pdf dst, one JSON line."""

    def __init__(self, folder):
        os.makedirs(folder, mode=0o700, exist_ok=True)
        self.path = os.path.join(folder, "render.sock")
        self.requests = []
        self.check_result = []
        self.fail = None
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(self.path)
        os.chmod(self.path, 0o600)
        self.srv.listen(8)
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        while True:
            try:
                conn, _ = self.srv.accept()
            except OSError:
                return
            with conn:
                buf = b""
                while b"\n" not in buf:
                    c = conn.recv(65536)
                    if not c:
                        break
                    buf += c
                try:
                    reply = self._handle(json.loads(buf.split(b"\n", 1)[0]))
                except Exception as exc:  # noqa: BLE001
                    reply = {"ok": False, "error": f"fake bridge: {exc}"}
                conn.sendall((json.dumps(reply) + "\n").encode())

    def _handle(self, req):
        self.requests.append(req)
        if req.get("token") != TOKEN:
            return {"ok": False, "code": "BAD_TOKEN", "error": "bad token"}
        if self.fail:
            return {"ok": False, "error": self.fail}
        op = req.get("op")
        if op in ("png", "pdf"):
            for k in ("src", "dst"):
                if not os.path.isabs(req[k]):
                    return {"ok": False, "error": f"{k} must be absolute"}
            if not req["dst"].endswith("." + op):
                return {"ok": False, "error": "bad dst extension"}
            with open(req["dst"], "wb") as fh:
                fh.write(png_bytes(req["width"], req["height"]) if op == "png"
                         else b"%PDF-1.4\n% fake bridge\n%%EOF\n")
            return {"ok": True, "electron": ELECTRON}
        if op == "checkPage":
            return {"ok": True, "electron": ELECTRON, "result": self.check_result}
        return {"ok": False, "error": "unknown op"}

    def close(self):
        self.srv.close()
        if os.path.exists(self.path):
            os.unlink(self.path)


def setUpModule():
    os.makedirs(SCRATCH, exist_ok=True)
    root = tempfile.mkdtemp(prefix="fx-", dir=SCRATCH)
    res = os.path.join(root, "Resources")
    rt = os.path.join(res, "datum-runtime")
    os.makedirs(os.path.join(rt, "bin"))
    # APFS clone of the probe interpreter: the probe folder is only read.
    subprocess.run(["/bin/cp", "-cR", PROBE_PY, os.path.join(rt, "python")], check=True)
    os.symlink(SKILL, os.path.join(res, "datum-house-style"))
    py = os.path.join(rt, "python", "bin", "python3")
    sp = os.path.join(rt, "python", "lib", "python3.14", "site-packages")
    pth = os.path.join(sp, "datum-house-style.pth")
    os.unlink(pth)  # the clone's 4-level probe line; Res needs 5 levels (F2/F3)
    with open(pth, "w") as fh:
        fh.write("../../../../../datum-house-style/scripts\n")

    dist = os.path.join(root, "dist")
    out = subprocess.run([py, "-I", "-B", os.path.join(SHIM, "build_wheel.py"), "--out", dist],
                         check=True, capture_output=True, text=True).stdout.split()
    FX["wheel_sha"], FX["wheel"] = out[0], out[1]
    pip = subprocess.run([py, "-I", "-B", "-m", "pip", "install", "--no-index", "--no-deps",
                          "--no-compile", "--disable-pip-version-check", "--no-cache-dir",
                          "--target", sp, FX["wheel"]], capture_output=True, text=True)
    FX["pip"] = pip.stdout + pip.stderr
    assert pip.returncode == 0, FX["pip"]

    shutil.copyfile(os.path.join(SHIM, "bin", "rsvg-convert"), os.path.join(rt, "bin", "rsvg-convert"))
    os.chmod(os.path.join(rt, "bin", "rsvg-convert"), 0o755)
    launcher = os.path.join(rt, "bin", "datum-python")
    with open(launcher, "w") as fh:  # test launcher per runtime spec 1.6 (row 23 ships the real one)
        fh.write('#!/bin/sh\nself=$(/usr/bin/readlink -f "$0")\nhere=$(/usr/bin/dirname "$self")\n'
                 'PATH="$here:/usr/bin:/bin"\nexport PATH\n'
                 'exec "$here/../python/bin/python3" -I -B "$@"\n')
    os.chmod(launcher, 0o755)

    decoy = os.path.join(root, "decoy-homebrew-bin")  # R3: a planted renderer must not win
    os.makedirs(decoy)
    FX["decoy_marker"] = os.path.join(root, "decoy-used")
    with open(os.path.join(decoy, "rsvg-convert"), "w") as fh:
        fh.write(f'#!/bin/sh\ntouch "{FX["decoy_marker"]}"\nexit 0\n')
    os.chmod(os.path.join(decoy, "rsvg-convert"), 0o755)

    work = os.path.join(root, "work")
    home = os.path.join(root, "home")
    os.makedirs(work)
    os.makedirs(home)
    svg = os.path.join(work, "Gambar Uji 1.svg")
    with open(svg, "w") as fh:
        fh.write('<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" '
                 'viewBox="0 0 40 20"><rect width="40" height="20" fill="#fff"/></svg>\n')
    FX.update(root=root, rt=rt, py=py, sp=sp, launcher=launcher, decoy=decoy, work=work,
              home=home, svg=svg, bridge=FakeBridge(os.path.join(root, "b")))
    time.sleep(1.1)  # mtime granularity for the seal check
    FX["marker"] = os.path.join(root, "marker")
    open(FX["marker"], "w").close()


def tearDownModule():
    FX["bridge"].close()


def env(bridge=True, sock=None):
    e = {"HOME": FX["home"], "TMPDIR": FX["home"], "PATH": f"{FX['decoy']}:/usr/bin:/bin",
         "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
         "ALL_PROXY": "http://127.0.0.1:9", "NO_PROXY": "127.0.0.1,localhost",
         "DATUM_OUT": FX["work"]}
    if bridge:
        e["DATUM_RENDER_SOCKET"] = sock or FX["bridge"].path
        e["DATUM_RENDER_TOKEN"] = TOKEN
    return e


def run(args, exe=None, **kw):
    return subprocess.run([exe or FX["launcher"], *args], cwd=FX["work"], env=env(**kw),
                          capture_output=True, text=True, timeout=120)


def script(name):
    return os.path.join(SKILL, "scripts", name)


class RenderViaShim(unittest.TestCase):
    def setUp(self):
        FX["bridge"].requests.clear()
        FX["bridge"].fail = None
        FX["bridge"].check_result = []

    def test_render_png_selects_rsvg_shim(self):
        out = os.path.join(FX["work"], "Gambar Uji 1.png")
        r = run([script("datum_render.py"), FX["svg"], "-o", out, "--dpi", "300"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("= 472×236 px  (rsvg-convert)", r.stdout)
        self.assertIn(f"rsvg-convert: DATUM shim -> Swarm Chromium (Electron {ELECTRON})", r.stderr)
        self.assertEqual(png_size(out), (472, 236))  # round(40/25.4*300), round(20/25.4*300)
        reqs = FX["bridge"].requests
        self.assertEqual([q["op"] for q in reqs], ["png"])
        self.assertEqual((reqs[0]["src"], reqs[0]["dst"], reqs[0]["width"], reqs[0]["height"]),
                         (FX["svg"], out, 472, 236))
        self.assertFalse(os.path.exists(FX["decoy_marker"]), "planted rsvg-convert was used")

    def test_render_pdf_selects_rsvg_shim(self):
        out = os.path.join(FX["work"], "Gambar Uji 1.pdf")
        r = run([script("datum_render.py"), FX["svg"], "--pdf", out])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("(vector, rsvg-convert)", r.stdout)
        q = FX["bridge"].requests[0]
        self.assertEqual((q["op"], q["dst"], q["widthMm"], q["heightMm"]), ("pdf", out, 40.0, 20.0))

    def test_diagram_png_through_shim(self):
        svg = os.path.join(FX["work"], "Gambar Diagram.svg")
        png = os.path.join(FX["work"], "Gambar Diagram.png")
        r = run([script("datum_diagram.py"), GAMBAR, "-o", svg, "--png", png])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.isfile(png), r.stdout + r.stderr)
        q = FX["bridge"].requests[-1]
        w_mm, h_mm = datum_render_shim.svg_size_mm(svg)
        self.assertEqual((q["op"], q["width"], q["height"]), ("png", 2000, round(2000 * h_mm / w_mm)))
        self.assertEqual(png_size(png), (2000, round(2000 * h_mm / w_mm)))

    def test_check_page_through_playwright_shim(self):
        sheet = os.path.join(SKILL, "assets", "Sumber Lembar Bukti.html")
        r = run([script("datum_render.py"), sheet, "--check-page"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("page geometry clean", r.stdout)
        q = FX["bridge"].requests[0]
        self.assertEqual((q["op"], q["html"], q["wMm"], q["hMm"], q["width"], q["height"]),
                         ("checkPage", sheet, 210.0, 297.0, 1240, 1754))
        self.assertIn("querySelectorAll('.page')", q["script"])
        FX["bridge"].check_result = [{"page": 1, "what": "tbl", "over": "4.2", "axis": "bawah"}]
        r = run([script("datum_render.py"), sheet, "--check-page"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("LINT 37 · lembar 1 · 'tbl' melewati batas bawah sebesar 4.2 mm", r.stdout)

    def test_bridge_absent_clear_error(self):
        out = os.path.join(FX["work"], "absent.png")
        for kw in ({"bridge": False}, {"sock": os.path.join(FX["root"], "nope.sock")}):
            r = run([script("datum_render.py"), FX["svg"], "-o", out], **kw)
            self.assertEqual(r.returncode, 1, r.stdout)
            self.assertIn(datum_render_shim.NOT_RUNNING, r.stderr)
            self.assertNotIn("Traceback", r.stderr)
            self.assertFalse(os.path.exists(out))
            self.assertFalse(os.path.exists(out + ".render.html"))
            sheet = os.path.join(SKILL, "assets", "Sumber Lembar Bukti.html")
            r = run([script("datum_render.py"), sheet, "--check-page"], **kw)
            self.assertEqual(r.returncode, 1)
            self.assertIn(datum_render_shim.NOT_RUNNING, r.stderr)
            self.assertNotIn("Traceback", r.stderr)
        self.assertEqual(FX["bridge"].requests, [])

    def test_bridge_error_is_reported(self):
        FX["bridge"].fail = "page crashed"
        r = run(["-w", "10", "-o",
                 os.path.join(FX["work"], "e.png"), FX["svg"]], exe=os.path.join(FX["rt"], "bin", "rsvg-convert"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("rsvg-convert: DATUM shim: render failed: page crashed", r.stderr)

    def test_rsvg_usage_rejected_without_bridge_call(self):
        bad = [["-w", "10", FX["svg"]], ["-x", "1", "-o", "a.png", FX["svg"]],
               ["-w", "10", "-o", "a.jpg", FX["svg"]], ["-f", "svg", "-o", "a.svg", FX["svg"]],
               ["-w", "0", "-o", "a.png", FX["svg"]], ["-w", "10", "-o", "a.png", "missing.svg"],
               ["-f", "pdf", "-w", "10", "-o", "a.pdf", FX["svg"]], []]
        for a in bad:
            r = run([*a], exe=os.path.join(FX["rt"], "bin", "rsvg-convert"))
            self.assertEqual(r.returncode, 1, a)
            self.assertIn("usage: rsvg-convert", r.stderr, a)
        self.assertEqual(FX["bridge"].requests, [])

    def test_relative_paths_sent_absolute(self):
        r = run(["-w", "40", "-o", "rel.png",
                 os.path.basename(FX["svg"])], exe=os.path.join(FX["rt"], "bin", "rsvg-convert"))
        self.assertEqual(r.returncode, 0, r.stderr)
        q = FX["bridge"].requests[0]
        self.assertEqual((q["src"], q["dst"], q["height"]),
                         (FX["svg"], os.path.join(FX["work"], "rel.png"), 20))

    def test_seal_nothing_written_into_runtime_or_skill(self):
        run([script("datum_render.py"), FX["svg"], "-o", os.path.join(FX["work"], "s.png")])
        newer = subprocess.run(["/usr/bin/find", FX["rt"], "-newer", FX["marker"]],
                               capture_output=True, text=True).stdout.split()
        self.assertEqual(newer, [])
        pyc = subprocess.run(["/usr/bin/find", SKILL, "-name", "__pycache__"],
                             capture_output=True, text=True).stdout.split()
        self.assertEqual(pyc, [])


class InProcess(unittest.TestCase):
    """datum_render.py's own playwright branches, loaded from the repo copy unchanged."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("datum_render_under_test", script("datum_render.py"))
        cls.render = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.render)

    def setUp(self):
        FX["bridge"].requests.clear()
        FX["bridge"].fail = None
        self.saved = dict(os.environ)
        os.environ.clear()
        os.environ.update(env())
        os.environ["PATH"] = "/usr/bin:/bin"  # no rsvg-convert: reach the playwright branches
        self.connects = []
        if not FX.get("hook"):
            sys.addaudithook(lambda ev, args: FX.get("audit") is not None and ev in (
                "socket.connect", "socket.getaddrinfo", "urllib.Request") and FX["audit"].append((ev, args[1:])))
            FX["hook"] = True
        FX["audit"] = self.connects

    def tearDown(self):
        FX["audit"] = None
        os.environ.clear()
        os.environ.update(self.saved)

    def test_chromium_png_branch_uses_shim_and_only_the_unix_socket(self):
        dst = os.path.join(FX["work"], "inproc.png")
        self.assertTrue(self.render._chromium_png(FX["svg"], dst, 472, 236))
        self.assertEqual(png_size(dst), (472, 236))
        self.assertFalse(os.path.exists(dst + ".render.html"))
        q = FX["bridge"].requests[0]
        self.assertEqual((q["op"], q["src"], q["width"]), ("png", FX["svg"], 472))
        self.assertEqual(self.connects, [("socket.connect", (FX["bridge"].path,))])

    def test_render_pdf_playwright_branch(self):
        dst = os.path.join(FX["work"], "inproc.pdf")
        self.assertEqual(self.render.render_pdf(FX["svg"], dst), "chromium")
        q = FX["bridge"].requests[0]
        self.assertEqual((q["op"], q["widthMm"], q["heightMm"]), ("pdf", 40.0, 20.0))
        self.assertTrue(all(ev == "socket.connect" and a == (FX["bridge"].path,) for ev, a in self.connects))

    def test_chromium_png_bridge_error_falls_back_cleanly(self):
        FX["bridge"].fail = "boom"
        self.assertFalse(self.render._chromium_png(FX["svg"], os.path.join(FX["work"], "f.png"), 4, 2))

    def test_unsupported_api_raises_not_implemented(self):
        with sync_api.sync_playwright() as p:
            for thunk in (lambda: p.firefox, lambda: p.chromium.launch().new_context(),
                          lambda: p.chromium.launch().new_page().click("a"),
                          lambda: sync_api.async_playwright, lambda: playwright.async_api):
                with self.assertRaises(NotImplementedError):
                    thunk()
            pg = p.chromium.launch().new_page()
            pg.goto("file://" + os.path.join(SKILL, "assets", "Sumber Lembar Bukti.html"))
            with self.assertRaises(NotImplementedError):
                pg.screenshot(path=os.path.join(FX["work"], "x.png"))


class Static(unittest.TestCase):
    def test_no_network_code(self):
        for root, _, files in os.walk(os.path.join(SHIM, "src")):
            for f in files:
                if f.endswith(".py"):
                    with open(os.path.join(root, f), encoding="utf-8") as fh:
                        text = fh.read()
                    for word in ("AF_INET", "urllib", "http.client", "getaddrinfo", "subprocess"):
                        self.assertNotIn(word, text, f"{f}: {word}")

    def test_wheel_reproducible_and_named(self):
        import zipfile
        if True:
            d = tempfile.mkdtemp(prefix="wheel-", dir=SCRATCH)
            out = subprocess.run([FX["py"], "-I", "-B", os.path.join(SHIM, "build_wheel.py"),
                                  "--out", d], check=True, capture_output=True, text=True).stdout
            self.assertEqual(out.split()[0], FX["wheel_sha"])
        with open(FX["wheel"], "rb") as fh:
            wheel_bytes = fh.read()
        with zipfile.ZipFile(FX["wheel"]) as zf:
            names = zf.namelist()
            meta = zf.read("datum_render_shim-1.2.0.dist-info/METADATA").decode()
        self.assertIn("Name: datum-render-shim", meta)
        self.assertIn("playwright/sync_api/__init__.py", names)
        self.assertFalse(any("__pycache__" in n or n.startswith("tests/") for n in names))
        self.assertTrue(os.path.isdir(os.path.join(FX["sp"], "datum_render_shim-1.2.0.dist-info")))
        self.assertEqual(hashlib.sha256(wheel_bytes).hexdigest(), FX["wheel_sha"])

    def test_launcher_resolves_to_shim(self):
        r = run(["-c", "import shutil,playwright.sync_api as s;print(shutil.which('rsvg-convert'));print(s.__file__)"])
        self.assertEqual(r.returncode, 0, r.stderr)
        which, mod = r.stdout.split()
        self.assertEqual(which, os.path.join(FX["rt"], "bin", "rsvg-convert"))
        self.assertTrue(mod.startswith(FX["sp"]), mod)


if __name__ == "__main__":
    unittest.main(verbosity=2)
