#!/usr/bin/env python3
"""DATUM SVG renderer — GSP House Style v1.3  (GSP-DS-001)

    python3 datum_render.py figure.svg -o figure.png            # 300 dpi, true size
    python3 datum_render.py *.svg --dpi 600 --outdir raster/
    python3 datum_render.py figure.svg --pdf figure.pdf         # vector, for print

Why this exists
---------------
DATUM says figures are SVG with real text, and that is right for PDF and HTML. But
python-docx and python-pptx cannot place an SVG — Word will either refuse it or fall back
to a bitmap of unknown resolution. So every skill that built a GSP document was inventing
its own rasterisation step, at whatever DPI it guessed, and the type in the figures came
out soft while the type on the page came out sharp. That mismatch is visible and it reads
as amateur.

This renders at a stated DPI, preserving the millimetre dimensions declared on the SVG
root, so a 166 mm figure lands as a 166 mm figure in the document rather than as
"whatever 1960 pixels turns out to be". Prefer the PDF path when the target is print.

Renderer preference: rsvg-convert, then Inkscape, then cairosvg, then headless Chromium.
Chromium is the fallback that is always present in this environment and it honours the
IBM Plex faces if they are installed (see assets/fonts/PASANG-DULU.txt).
"""

import argparse
import glob
import os
import re
import subprocess
import sys

MM_PER_IN = 25.4


def svg_size_mm(path):
    """Read the declared mm size off the root element. Falls back to the viewBox, treating
    user units as mm, which is the convention datum_diagram.py writes."""
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


def which(cmd):
    return subprocess.call(["which", cmd], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL) == 0


def render_png(src, dst, dpi):
    w_mm, h_mm = svg_size_mm(src)
    px_w = max(1, round(w_mm / MM_PER_IN * dpi))
    px_h = max(1, round(h_mm / MM_PER_IN * dpi))

    if which("rsvg-convert"):
        if subprocess.call(["rsvg-convert", "-w", str(px_w), "-h", str(px_h),
                            "-o", dst, src]) == 0:
            return px_w, px_h, "rsvg-convert"
    if which("inkscape"):
        if subprocess.call(["inkscape", "--export-type=png", f"--export-width={px_w}",
                            f"--export-filename={dst}", src],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0:
            return px_w, px_h, "inkscape"
    try:
        import cairosvg
        cairosvg.svg2png(url=src, write_to=dst, output_width=px_w, output_height=px_h)
        return px_w, px_h, "cairosvg"
    except Exception:
        pass
    if _chromium_png(src, dst, px_w, px_h):
        return px_w, px_h, "chromium"
    raise SystemExit("no SVG renderer available — install rsvg-convert, inkscape, "
                     "cairosvg or playwright's chromium")


def _chromium_png(src, dst, px_w, px_h):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False
    svg = os.path.abspath(src)
    html = (f'<!doctype html><meta charset="utf-8">'
            f'<style>html,body{{margin:0;padding:0;background:#fff}}'
            f'img{{display:block;width:{px_w}px;height:{px_h}px;image-rendering:auto}}</style>'
            f'<img src="file://{svg}">')
    tmp = os.path.abspath(dst) + ".render.html"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(html)
    try:
        with sync_playwright() as p:
            br = p.chromium.launch(args=["--force-color-profile=srgb",
                                         "--font-render-hinting=none"])
            pg = br.new_page(viewport={"width": px_w, "height": px_h},
                             device_scale_factor=1)
            pg.goto(f"file://{tmp}")
            pg.wait_for_timeout(350)
            pg.screenshot(path=dst, omit_background=False)
            br.close()
        return True
    except Exception as exc:  # noqa: BLE001 — renderer failures are reported, not raised
        print(f"  chromium render failed: {exc}", file=sys.stderr)
        return False
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def render_pdf(src, dst):
    if which("rsvg-convert"):
        if subprocess.call(["rsvg-convert", "-f", "pdf", "-o", dst, src]) == 0:
            return "rsvg-convert"
    if which("inkscape"):
        if subprocess.call(["inkscape", "--export-type=pdf", f"--export-filename={dst}", src],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0:
            return "inkscape"
    try:
        import cairosvg
        cairosvg.svg2pdf(url=src, write_to=dst)
        return "cairosvg"
    except Exception:
        pass
    try:
        from playwright.sync_api import sync_playwright
        w_mm, h_mm = svg_size_mm(src)
        svg = os.path.abspath(src)
        tmp = os.path.abspath(dst) + ".render.html"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(f'<!doctype html><meta charset="utf-8">'
                     f'<style>@page{{size:{w_mm}mm {h_mm}mm;margin:0}}'
                     f'html,body{{margin:0}}img{{width:{w_mm}mm;height:{h_mm}mm}}</style>'
                     f'<img src="file://{svg}">')
        with sync_playwright() as p:
            br = p.chromium.launch()
            pg = br.new_page()
            pg.goto(f"file://{tmp}")
            pg.wait_for_timeout(300)
            pg.pdf(path=dst, width=f"{w_mm}mm", height=f"{h_mm}mm",
                   print_background=True, margin={"top": "0", "bottom": "0",
                                                  "left": "0", "right": "0"})
            br.close()
        os.remove(tmp)
        return "chromium"
    except Exception:
        raise SystemExit("no SVG→PDF renderer available")


def check_page(html_path, w_mm=210.0, h_mm=297.0):
    """Report any element that overflows the A4 sheet.

    This closes a real gap. Lint check 33 catches a FIGURE taller than the text block, but
    a composed sheet fails differently: the figures each fit, and the page still overruns
    because prose, a table and a derivation were added underneath. The lint reads the HTML
    source and cannot see that — only a renderer knows where the boxes actually land. So
    the check lives here, where the geometry is real.
    """
    from playwright.sync_api import sync_playwright
    findings = []
    with sync_playwright() as p:
        br = p.chromium.launch()
        pg = br.new_page(viewport={"width": 1240, "height": 1754}, device_scale_factor=1)
        pg.goto("file://" + os.path.abspath(html_path))
        pg.wait_for_timeout(500)
        findings = pg.evaluate("""(dims) => {
            const mm = 96 / 25.4, out = [];
            document.querySelectorAll('.page').forEach((pageEl, i) => {
                const pr = pageEl.getBoundingClientRect();
                const limitB = pr.top + dims.h * mm, limitR = pr.left + dims.w * mm;
                const reg = pageEl.querySelector('.reg');
                const floor = reg ? reg.getBoundingClientRect().top : limitB;
                pageEl.querySelectorAll('.body *').forEach(el => {
                    if (!el.getClientRects().length) return;
                    const b = el.getBoundingClientRect();
                    if (b.height < 1 && b.width < 1) return;
                    if (b.bottom > floor + 0.5) out.push({page: i + 1,
                        what: ((el.className && el.className.baseVal !== undefined
                                ? el.className.baseVal : el.className)
                               || el.tagName).toString().slice(0, 30),
                        over: ((b.bottom - floor) / mm).toFixed(1), axis: 'bawah'});
                    if (b.right > limitR + 0.5) out.push({page: i + 1,
                        what: ((el.className && el.className.baseVal !== undefined
                                ? el.className.baseVal : el.className)
                               || el.tagName).toString().slice(0, 30),
                        over: ((b.right - limitR) / mm).toFixed(1), axis: 'kanan'});
                });
            });
            // keep the WORST offender per key: reporting the first one understates the
            // overrun (a sheet 476 mm too long reported as '21.5 mm' is worse than useless)
            const worst = new Map();
            out.forEach(f => {const k = f.what + f.axis;
                if (!worst.has(k) || +f.over > +worst.get(k).over) worst.set(k, f);});
            return [...worst.values()].sort((a, b) => b.over - a.over).slice(0, 12);
        }""", {"w": w_mm, "h": h_mm})
        br.close()
    return findings


def main():
    ap = argparse.ArgumentParser(description="DATUM SVG renderer")
    ap.add_argument("svg", nargs="+", help="input .svg files (globs accepted)")
    ap.add_argument("-o", "--out", default=None, help="output file (single input only)")
    ap.add_argument("--outdir", default=None, help="output directory for batch mode")
    ap.add_argument("--dpi", type=int, default=300,
                    help="raster resolution; 300 for DOCX, 600 for print proofs")
    ap.add_argument("--pdf", default=None, help="write PDF instead of PNG (single input)")
    ap.add_argument("--check-page", action="store_true",
                    help="render an HTML sheet and report anything overflowing the A4 page")
    args = ap.parse_args()

    if args.check_page:
        bad = check_page(args.svg[0])
        if not bad:
            print(f"{args.svg[0]}: page geometry clean — nothing overflows A4")
            return 0
        print(f"{args.svg[0]}: {len(bad)} overflow(s)")
        for f in bad:
            print(f"  LINT 37 · lembar {f['page']} · '{f['what']}' melewati batas "
                  f"{f['axis']} sebesar {f['over']} mm")
        return 1

    files = []
    for pattern in args.svg:
        files.extend(sorted(glob.glob(pattern)) or [pattern])

    if args.pdf:
        if len(files) != 1:
            raise SystemExit("--pdf takes exactly one input")
        engine = render_pdf(files[0], args.pdf)
        print(f"{files[0]} → {args.pdf}  (vector, {engine})")
        return 0

    for src in files:
        if not os.path.exists(src):
            print(f"missing: {src}", file=sys.stderr)
            continue
        if args.out and len(files) == 1:
            dst = args.out
        else:
            base = os.path.splitext(os.path.basename(src))[0] + ".png"
            dst = os.path.join(args.outdir or os.path.dirname(src) or ".", base)
        os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
        w_mm, h_mm = svg_size_mm(src)
        px_w, px_h, engine = render_png(src, dst, args.dpi)
        print(f"{src} → {dst}  {w_mm:.1f}×{h_mm:.1f} mm @ {args.dpi} dpi "
              f"= {px_w}×{px_h} px  ({engine})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
