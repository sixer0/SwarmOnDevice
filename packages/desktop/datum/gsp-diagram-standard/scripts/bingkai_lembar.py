#!/usr/bin/env python3
"""Bingkai lembar GSP untuk gambar hasil DATUM Studio.

Membungkus SVG gambar yang dihasilkan Studio (studio_render figures:["svg"]) dengan
lapisan luar menurut GSP Diagram Manual Rev B bab 7: bingkai, rujukan zona, baris kunci,
dan strip judul (owner, title, drawing number, rev, sheet, scale, classification).
Isi gambar tidak diubah dan tidak digambar ulang: SVG Studio disisipkan apa adanya.

Pakai:
  python3 bingkai_lembar.py --svg gambar.svg --meta lembar.json --out lembar.svg

lembar.json (semua nilai berasal dari register dokumen, bukan dikarang):
  {
    "owner": "PT GSP",
    "title": "Arsitektur VMS: rekaman di situs, manajemen terpusat",
    "dwg_no": "GSP-UJI-VSS-110",
    "rev": "A",
    "sheet": "1/6",
    "scale": "NTS",
    "classification": "BIASA",
    "status": "DRAFT",
    "date": "2026-11-17",
    "standards": "IEC 62676-4:2025",
    "key": [["data", "video"], ["control", "kendali/API"], ["accent", "subjek"]]
  }

Hanya pustaka standar Python. Satuan mm (viewBox dalam mm, sama dengan SVG Studio).
"""
import argparse
import json
import re
import sys
from xml.sax.saxutils import escape

INK = "#2B3640"
MUTED = "#6B7783"
RULE = "#C3CBD1"
MAROON = "#6E1420"
ACCENT = "#B45309"

MARGIN = 5.0        # jalur rujukan zona di keempat sisi
PAD = 2.0           # jarak bingkai dalam ke gambar
KEY_H = 6.0         # tinggi baris kunci
TITLE_H = 11.0      # tinggi strip judul
ZONE_COLS = 8

LINE_STYLES = {
    "data": 'stroke="%s" stroke-width="0.45"' % INK,
    "control": 'stroke="%s" stroke-width="0.45" stroke-dasharray="1.6 1.0"' % INK,
    "sync": 'stroke="%s" stroke-width="0.45" stroke-dasharray="0.4 0.8"' % INK,
    "alert": 'stroke="#9B1C1C" stroke-width="0.45" stroke-dasharray="3.0 1.2"',
    "verify": 'stroke="#2F6F6B" stroke-width="0.45" stroke-dasharray="2.2 0.8 0.4 0.8"',
    "accent": 'stroke="%s" stroke-width="0.6"' % ACCENT,
}


def die(msg):
    sys.stderr.write("bingkai_lembar: " + msg + "\n")
    sys.exit(2)


def read_figure(path):
    raw = open(path, encoding="utf-8").read()
    m = re.search(r"<svg\b[^>]*>", raw)
    if not m:
        die("berkas bukan SVG: " + path)
    tag = m.group(0)
    vb = re.search(r'viewBox="([\d.\-\s]+)"', tag)
    if not vb:
        die("SVG tanpa viewBox; pakai SVG dari studio_render figures:[\"svg\"]")
    x0, y0, w, h = [float(v) for v in vb.group(1).split()]
    inner = raw[m.end():raw.rfind("</svg>")]
    return (x0, y0, w, h), inner


def txt(x, y, s, size=1.9, fill=INK, family="mono", weight="400", anchor="start", spacing=None):
    fam = "IBM Plex Mono" if family == "mono" else "IBM Plex Sans Condensed"
    extra = ' letter-spacing="%s"' % spacing if spacing else ""
    return ('<text x="%.3f" y="%.3f" font-family="%s" font-size="%.2f" font-weight="%s" '
            'fill="%s" text-anchor="%s"%s>%s</text>' % (x, y, fam, size, weight, fill, anchor, extra, escape(s)))


def build(fig_box, inner, meta):
    x0, y0, fw, fh = fig_box
    key = meta.get("key") or []
    key_h = KEY_H if key else 0.0
    W = fw + 2 * (MARGIN + PAD)
    H = MARGIN + PAD + fh + PAD + key_h + TITLE_H + MARGIN
    fx, fy = MARGIN + PAD, MARGIN + PAD
    inner_x, inner_y = MARGIN, MARGIN
    inner_w, inner_h = W - 2 * MARGIN, H - 2 * MARGIN
    out = []
    out.append('<?xml version="1.0" encoding="UTF-8"?>')
    out.append('<svg xmlns="http://www.w3.org/2000/svg" width="%.3fmm" height="%.3fmm" viewBox="0 0 %.3f %.3f" version="1.1">' % (W, H, W, H))
    out.append("<!-- bingkai_lembar.py: lapisan luar GSP Diagram Manual Rev B bab 7; isi = SVG Studio tanpa perubahan -->")
    font_dir = meta.get("font_dir")
    if font_dir:
        faces = [("IBM Plex Mono", "400", "IBMPlexMono-Regular.ttf"), ("IBM Plex Mono", "600", "IBMPlexMono-SemiBold.ttf"),
                 ("IBM Plex Sans Condensed", "400", "IBMPlexSansCond-Regular.ttf"),
                 ("IBM Plex Sans Condensed", "600", "IBMPlexSansCond-SemiBold.ttf")]
        css = "".join('@font-face{font-family:"%s";font-weight:%s;src:url("file://%s/%s")}' % (f, w, font_dir, n) for f, w, n in faces)
        out.append("<style>%s</style>" % css)
    out.append('<rect x="0" y="0" width="%.3f" height="%.3f" fill="#FFFFFF"/>' % (W, H))
    # bingkai luar dan dalam
    out.append('<rect x="0.3" y="0.3" width="%.3f" height="%.3f" fill="none" stroke="%s" stroke-width="0.18"/>' % (W - 0.6, H - 0.6, RULE))
    out.append('<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f" fill="none" stroke="%s" stroke-width="0.5"/>' % (inner_x, inner_y, inner_w, inner_h, INK))
    # rujukan zona: angka di atas dan bawah, huruf di kiri dan kanan
    cw = inner_w / ZONE_COLS
    for i in range(ZONE_COLS):
        cx = inner_x + cw * (i + 0.5)
        out.append(txt(cx, MARGIN - 1.6, str(i + 1), 1.8, MUTED, anchor="middle"))
        out.append(txt(cx, H - 1.4, str(i + 1), 1.8, MUTED, anchor="middle"))
        if i:
            xx = inner_x + cw * i
            out.append('<path d="M%.3f,%.3f v-1.2 M%.3f,%.3f v1.2" stroke="%s" stroke-width="0.18"/>' % (xx, inner_y, xx, inner_y + inner_h, MUTED))
    draw_h = inner_h - TITLE_H
    rows = max(2, int(round(draw_h / cw)))
    rh = draw_h / rows
    for r in range(rows):
        cy = inner_y + rh * (r + 0.5) + 0.6
        letter = chr(ord("A") + r)
        out.append(txt(MARGIN / 2, cy, letter, 1.8, MUTED, anchor="middle"))
        out.append(txt(W - MARGIN / 2, cy, letter, 1.8, MUTED, anchor="middle"))
        if r:
            yy = inner_y + rh * r
            out.append('<path d="M%.3f,%.3f h-1.2 M%.3f,%.3f h1.2" stroke="%s" stroke-width="0.18"/>' % (inner_x, yy, inner_x + inner_w, yy, MUTED))
    # gambar Studio, tanpa perubahan
    out.append('<svg x="%.3f" y="%.3f" width="%.3f" height="%.3f" viewBox="%.3f %.3f %.3f %.3f">' % (fx, fy, fw, fh, x0, y0, fw, fh))
    out.append(inner)
    out.append("</svg>")
    # baris kunci
    ty = inner_y + inner_h - TITLE_H
    if key:
        ky = ty - key_h
        out.append('<path d="M%.3f,%.3f h%.3f" stroke="%s" stroke-width="0.18"/>' % (inner_x, ky, inner_w, RULE))
        out.append(txt(inner_x + 2, ky + 3.9, "KEY", 1.8, MUTED, spacing="0.25"))
        kx = inner_x + 12
        for kind, label in key:
            style = LINE_STYLES.get(kind)
            if not style:
                die("jenis garis kunci tidak dikenal: %s (pakai %s)" % (kind, ", ".join(sorted(LINE_STYLES))))
            out.append('<path d="M%.3f,%.3f h9" fill="none" %s/>' % (kx, ky + 3.2, style))
            out.append(txt(kx + 10.5, ky + 3.9, label, 1.9, INK, family="sans"))
            kx += 10.5 + 1.25 * len(label) + 6
        if kx > inner_x + inner_w:
            die("baris kunci melewati lebar lembar; kurangi butir atau perpendek label")
    # strip judul
    out.append('<path d="M%.3f,%.3f h%.3f" stroke="%s" stroke-width="0.5"/>' % (inner_x, ty, inner_w, INK))
    cells = [("OWNER", meta.get("owner", ""), 0.10), ("TITLE", meta.get("title", ""), 0.40),
             ("DWG NO.", meta.get("dwg_no", ""), 0.18), ("REV", meta.get("rev", ""), 0.06),
             ("SHEET", meta.get("sheet", ""), 0.08), ("SCALE", meta.get("scale", "NTS"), 0.07),
             ("CLASS", meta.get("classification", ""), 0.11)]
    missing = [name for name, val, _ in cells if not str(val).strip()]
    if missing:
        die("medan strip judul kosong: " + ", ".join(missing) + " (ambil dari register; jangan dikarang)")
    cx = inner_x
    for name, val, share in cells:
        cwid = inner_w * share
        if cx > inner_x:
            out.append('<path d="M%.3f,%.3f v%.3f" stroke="%s" stroke-width="0.25"/>' % (cx, ty, TITLE_H, INK))
        out.append(txt(cx + 1.3, ty + 3.2, name, 1.6, MUTED, spacing="0.2"))
        maxc = int((cwid - 2.6) / 1.17)
        val = str(val)
        if name == "TITLE" and maxc < len(val) <= 2 * maxc:
            cut = val.rfind(" ", 0, maxc + 1)
            if cut > 0 and len(val) - cut - 1 <= maxc:
                out.append(txt(cx + 1.3, ty + 6.4, val[:cut], 1.9, INK))
                out.append(txt(cx + 1.3, ty + 9.3, val[cut + 1:], 1.9, INK))
                cx += cwid
                continue
        if len(val) > maxc:
            die('nilai "%s" terlalu panjang untuk sel %s (maks %d karakter)' % (val, name, maxc))
        fill = MAROON if name == "CLASS" else INK
        weight = "600" if name in ("DWG NO.", "CLASS") else "400"
        out.append(txt(cx + 1.3, ty + 8.0, val, 2.0, fill, weight=weight))
        cx += cwid
    foot = " · ".join(x for x in (meta.get("status"), meta.get("date"), meta.get("standards")) if x)
    if foot:
        out.append(txt(inner_x, H - MARGIN + 3.4 - 0.2, foot, 1.6, MUTED))
    out.append("</svg>")
    return "\n".join(out), (W, H)


def main():
    ap = argparse.ArgumentParser(description="Bingkai lembar GSP untuk SVG gambar Studio")
    ap.add_argument("--svg", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    meta = json.load(open(a.meta, encoding="utf-8"))
    box, inner = read_figure(a.svg)
    svg, (W, H) = build(box, inner, meta)
    open(a.out, "w", encoding="utf-8").write(svg)
    print("lembar %.1f x %.1f mm -> %s" % (W, H, a.out))


if __name__ == "__main__":
    main()
