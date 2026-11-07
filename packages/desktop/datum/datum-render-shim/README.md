# datum-render-shim 1.2.0

Stand-ins that let DATUM's unchanged scripts render inside Swarm through the render bridge in
Electron main (Electron's own Chromium). Runtime spec: `masterplan/01_specs_runtime.md` §3.2-3.3
of the 1.2.0 task folder. Not librsvg, not Playwright.

| Part | Installed at (Resources) | Serves |
|---|---|---|
| `bin/rsvg-convert` (sh, execs `../python/bin/python3 -I -B -m datum_render_shim.rsvg_convert`) | `datum-runtime/bin/rsvg-convert`, mode 0755 | `datum_render.py` PNG/PDF, `datum_diagram.py --png` |
| `src/playwright/sync_api` | `datum-runtime/python/lib/python3.14/site-packages/` (via the wheel) | `datum_render.py --check-page` and its Chromium branches |
| `src/datum_render_shim` | same site-packages | bridge client (AF_UNIX only) |

Build the wheel (stdlib only, reproducible): `python3 -I -B build_wheel.py --out DIR`, then
`pip install --no-index --no-deps --require-hashes --target <site-packages>` with its sha256.

Bridge: `DATUM_RENDER_SOCKET` + `DATUM_RENDER_TOKEN` from the sidecar env; one JSON line per
connection each way. Requests carry `token`; ops `png {src,dst,width,height}`,
`pdf {src,dst,widthMm,heightMm}`, `checkPage {html,wMm,hMm,script,width,height}` (paths absolute,
`html` is a file path, `width/height` the viewport px). Reply `{ok:true, electron, result?}` or
`{ok:false, error}`. Bridge absent: `Swarm app not running: DATUM rendering needs Swarm open`, exit 1.

Tests: `tools/build/datum_runtime_probe/python/bin/python3 -I -B tests/test_render_shim.py`
(binds a Unix socket for the fake bridge; the Claude Code sandbox refuses that bind).
