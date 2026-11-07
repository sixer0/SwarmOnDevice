"""`playwright.sync_api` subset for DATUM (datum-render-shim 1.2.0).

Exactly the calls datum_render.py makes (render.py:96-104, 138-146, 164-199):

    with sync_playwright() as p:
        br = p.chromium.launch(args=[...])
        pg = br.new_page(viewport={...}, device_scale_factor=1)
        pg.goto("file://...")
        pg.wait_for_timeout(ms)
        pg.screenshot(path=..., omit_background=False)     -> bridge op "png"
        pg.pdf(path=..., width="..mm", height="..mm",
               print_background=True, margin={...})        -> bridge op "pdf"
        pg.evaluate(js, {"w": .., "h": ..})                -> bridge op "checkPage"
        br.close()

For screenshot and pdf the page must be render.py's one-<img> wrapper; the shim reads the SVG
path out of it and the bridge builds its own page with the Plex faces (runtime spec 3.2,
"Fonts on this path"). Any other attribute raises NotImplementedError.

With Swarm closed, launch() (or any op) raises SwarmNotRunning, a SystemExit, so the script
stops with the one clear message instead of a traceback (runtime spec 3.3).
"""

import os
import re

import datum_render_shim as _bridge

__all__ = ["sync_playwright", "Error"]

_MAX_PAGE_BYTES = 1024 * 1024

# render.py:88-91 (PNG) and render.py:134-137 (PDF), byte for byte except the captured values.
_PNG_WRAPPER = re.compile(
    r'<!doctype html><meta charset="utf-8">'
    r'<style>html,body\{margin:0;padding:0;background:#fff\}'
    r'img\{display:block;width:(\d+)px;height:(\d+)px;image-rendering:auto\}</style>'
    r'<img src="file://(/[^"]+)">', re.S)
_PDF_WRAPPER = re.compile(
    r'<!doctype html><meta charset="utf-8">'
    r'<style>@page\{size:([0-9.eE+\-]+)mm ([0-9.eE+\-]+)mm;margin:0\}'
    r'html,body\{margin:0\}img\{width:\1mm;height:\2mm\}</style>'
    r'<img src="file://(/[^"]+)">', re.S)
_MM = re.compile(r"\s*([0-9]+(?:\.[0-9]+)?)\s*mm\s*")


class Error(Exception):
    """Like playwright.sync_api.Error: the bridge answered but the operation failed."""


class SwarmNotRunning(SystemExit):
    def __init__(self):
        super().__init__(_bridge.NOT_RUNNING)


def _call(op, **fields):
    try:
        return _bridge.request(op, **fields)
    except _bridge.BridgeUnavailable:
        raise SwarmNotRunning() from None
    except _bridge.BridgeError as exc:
        raise Error(f"DATUM shim: {exc}") from None


class _Shim:
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        raise NotImplementedError(
            f"DATUM shim: {type(self).__name__.lstrip('_')}.{name} not supported")


class _Page(_Shim):
    def __init__(self, viewport, device_scale_factor):
        self._viewport = viewport
        self._dsf = device_scale_factor
        self._kind = None
        self._path = None
        self._svg = None
        self._size = None

    def goto(self, url):
        if not isinstance(url, str) or not url.startswith("file://"):
            raise NotImplementedError("DATUM shim: Page.goto supports file:// URLs only")
        path = url[len("file://"):]
        if not os.path.isabs(path) or not os.path.isfile(path):
            raise Error(f"DATUM shim: page not found: {path}")
        with open(path, "rb") as fh:
            data = fh.read(_MAX_PAGE_BYTES + 1)
        text = data.decode("utf-8", "replace") if len(data) <= _MAX_PAGE_BYTES else ""
        m = _PNG_WRAPPER.fullmatch(text)
        if m:
            self._kind, self._svg = "png", m.group(3)
            self._size = (int(m.group(1)), int(m.group(2)))
        else:
            m = _PDF_WRAPPER.fullmatch(text)
            if m:
                self._kind, self._svg = "pdf", m.group(3)
                self._size = (float(m.group(1)), float(m.group(2)))
            else:
                self._kind = "html"
        self._path = path
        return None

    def wait_for_timeout(self, timeout):
        # The bridge renders synchronously; there is nothing to wait for.
        if not isinstance(timeout, (int, float)) or timeout < 0:
            raise Error("DATUM shim: wait_for_timeout needs a non-negative number")

    def _need(self, kind, what):
        if self._kind != kind:
            raise NotImplementedError(
                f"DATUM shim: Page.{what} supports only datum_render.py's SVG wrapper page")

    def screenshot(self, *, path, omit_background=False):
        self._need("png", "screenshot")
        if omit_background:
            raise NotImplementedError("DATUM shim: omit_background=True not supported")
        if self._dsf not in (None, 1):
            raise NotImplementedError("DATUM shim: device_scale_factor other than 1 not supported")
        width, height = self._size
        vp = self._viewport
        if vp is not None and (vp.get("width"), vp.get("height")) != (width, height):
            raise NotImplementedError("DATUM shim: viewport must equal the image size")
        dst = os.path.abspath(path)
        _call("png", src=self._svg, dst=dst, width=width, height=height)
        with open(dst, "rb") as fh:
            return fh.read()

    def pdf(self, *, path, width, height, print_background=False, margin=None):
        self._need("pdf", "pdf")
        mw, mh = _MM.fullmatch(str(width)), _MM.fullmatch(str(height))
        if not mw or not mh:
            raise NotImplementedError("DATUM shim: Page.pdf width/height must be '<n>mm'")
        for side in (margin or {}).values():
            if str(side).strip() not in ("0", "0mm", "0px"):
                raise NotImplementedError("DATUM shim: Page.pdf supports zero margins only")
        dst = os.path.abspath(path)
        _call("pdf", src=self._svg, dst=dst, widthMm=float(mw.group(1)),
              heightMm=float(mh.group(1)))
        with open(dst, "rb") as fh:
            return fh.read()

    def evaluate(self, expression, arg=None):
        if self._path is None:
            raise Error("DATUM shim: evaluate before goto")
        if not isinstance(expression, str):
            raise NotImplementedError("DATUM shim: evaluate needs the function text")
        if not (isinstance(arg, dict) and set(arg) == {"w", "h"}):
            raise NotImplementedError("DATUM shim: evaluate supports render.py's {w, h} page check only")
        vp = self._viewport or {}
        reply = _call("checkPage", html=self._path, wMm=float(arg["w"]), hMm=float(arg["h"]),
                      script=expression, width=vp.get("width"), height=vp.get("height"))
        return reply.get("result")

    def close(self):
        return None


class _Browser(_Shim):
    def new_page(self, *, viewport=None, device_scale_factor=None):
        if viewport is not None and not (isinstance(viewport, dict)
                                         and set(viewport) == {"width", "height"}):
            raise NotImplementedError("DATUM shim: viewport must be {width, height}")
        return _Page(viewport, device_scale_factor)

    def close(self):
        return None


class _BrowserType(_Shim):
    def launch(self, *, args=None):
        # Chromium flags (render.py:97-98) do not apply to Electron's renderer; ignored.
        if not _bridge.available():
            raise SwarmNotRunning()
        return _Browser()


class _Playwright(_Shim):
    def __init__(self):
        self.chromium = _BrowserType()

    def stop(self):
        return None


class _PlaywrightContextManager(_Shim):
    def __enter__(self):
        return _Playwright()

    def __exit__(self, *exc):
        return False


def sync_playwright():
    return _PlaywrightContextManager()


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    raise NotImplementedError(f"DATUM shim: playwright.sync_api.{name} not supported")
