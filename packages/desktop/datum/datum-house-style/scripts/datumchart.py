#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
datumchart.py — DATUM chart engine. Figures with an AXIS.

Why this exists
---------------
`references/03-tabel-gambar-apparatus.md` §2 specifies the chart grammar in full — one
accent, a single baseline, direct labelling, Mono value labels, no title inside the plot,
no legend box, no chart border, no gradient — and then leaves every author to hand-author
the SVG. `datum_diagram.py` covers drawings (nodes and connectors); nothing covered charts.
A rule with no producer is a rule that drifts: measured over one engagement, every chart was
a one-off, and the only thing enforcing the grammar was the author remembering it.

This module is the producer of record for axis figures, mirroring the diagram engine's
contract exactly so the two feel like one tool:

    python3 datumchart.py spec.json -o "Gambar 2.1 Beban Daya.svg"
    python3 datumchart.py --estimate spec.json      predicted height before rendering
    python3 datumchart.py --schema

Families
    bar        horizontal bars, categories down the left    — ranking, comparison
    column     vertical columns, categories along the foot  — sequence, time
    threshold  horizontal bars against a stated limit line  — margin against a limit

`threshold` is the one worth naming: an engineering figure whose entire point is the distance
between a measured value and a limit, so the limit is drawn as a labelled rule and every bar
that crosses it takes the alert ink. A bar chart with the limit only mentioned in the caption
makes the reader do the comparison; this makes the drawing do it.

Discipline this engine enforces, so the author cannot forget it
    · width is 128 mm or 166 mm — nothing else is a legal measure   (lint G2)
    · apparatus defaults to "page": the .docx already prints the caption and SUMBER,
      and a figure printing its own prints both twice                (lint 36)
    · at most one accented series or bar                             (§03 §2)
    · no legend box, no chart border, no gradient, no 3-D, no shadow — not offered at all
    · value labels are Mono, unboxed, and always present: an unlabelled bar asks the
      reader to measure pixels
    · SVG only, real text, real vectors — never a rasterised chart
"""

import json, sys, argparse, math

# ── DATUM interior tokens ──────────────────────────────────────────────────
INK900, INK700, INK400 = '#101418', '#2B3640', '#6B7783'
INK200, INK100, PAPER = '#C3CBD1', '#EFF2F4', '#FCFCFB'
SIGNAL, ALERT, VERD = '#B45309', '#9B1C1C', '#2F6F6B'

STRUCT = 'IBM Plex Sans Condensed'
DATA = 'IBM Plex Mono'

MM = 3.7795275591          # 1 mm at 96 dpi
MEASURE = (128.0, 166.0)
TOL = 1.5


class ChartDefect(Exception):
    pass


def fmt(v, dec=0):
    """Thousands separator '.', decimal separator ',' — DATUM §10, never the reverse."""
    s = f'{v:,.{dec}f}'
    return s.replace(',', '\x00').replace('.', ',').replace('\x00', '.')


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


# ── geometry ───────────────────────────────────────────────────────────────
def tinggi(spec):
    """Predicted height in mm from the spec alone, before anything is rendered.

    Mirrors datum_diagram.py --estimate: an author must be able to learn that a figure
    will not fit on the page WITHOUT paying for a render first.
    """
    n = len(spec.get('data', []))
    fam = spec.get('family', 'bar')
    ap = spec.get('apparatus', 'page')
    if fam == 'column':
        badan = 46.0 + (12.0 if spec.get('sub') else 0.0)
    else:
        badan = n * 7.2 + 6.0
    if spec.get('note'):
        badan += 6.0
    if fam == 'threshold':
        badan += 5.0
    return badan + (22.0 if ap == 'figure' else 0.0)


def periksa(spec):
    """Call-site guard. Same codes as datum_lint.py so nothing new has to be learned."""
    fid = spec.get('id', '(tanpa nomor)')
    w = float(spec.get('width_mm', 128))
    if not any(abs(w - m) <= TOL for m in MEASURE):
        raise ChartDefect(f'[G2] {fid} — lebar {w:g} mm bukan 128 mm maupun 166 mm')
    if '_' in str(fid) or '_' in str(spec.get('title', '')):
        raise ChartDefect(f'[N1] {fid} — penanda gambar memakai garis bawah (DATUM §14)')
    if not spec.get('source'):
        raise ChartDefect(f'[10] {fid} — grafik tanpa baris SUMBER')
    if spec.get('apparatus') == 'figure' and spec.get('in_document'):
        raise ChartDefect(f'[36] {fid} — apparatus "figure" pada grafik yang masuk dokumen; '
                          f'halaman sudah mencetak keterangan dan SUMBER')
    d = spec.get('data') or []
    if not d:
        raise ChartDefect(f'[G1] {fid} — grafik tanpa data')
    aksen = sum(1 for x in d if x.get('accent'))
    if aksen > 1:
        raise ChartDefect(f'[G4] {fid} — {aksen} batang beraksen; satu aksen per gambar (§03 §2)')
    for x in d:
        if 'value' not in x or 'label' not in x:
            raise ChartDefect(f'[G1] {fid} — satu titik data tanpa label atau nilai')
    t = tinggi(spec)
    if t > 247.0:
        raise ChartDefect(f'[33] {fid} — perkiraan tinggi {t:.0f} mm melampaui blok teks A4 '
                          f'247 mm; pisah gambarnya atau kurangi kategorinya')
    if spec.get('family') == 'threshold' and spec.get('limit') is None:
        raise ChartDefect(f'[G5] {fid} — keluarga "threshold" tanpa nilai batas; '
                          f'sebuah batas yang tidak digambar bukan batas')
    return True


# ── render ─────────────────────────────────────────────────────────────────
def _teks(x, y, s, face=STRUCT, size=6.8, colour=INK400, anchor='start',
          bold=False, caps=False, track=0.0):
    w = ' font-weight="600"' if bold else ''
    t = f' letter-spacing="{track}"' if track else ''
    v = esc(s).upper() if caps else esc(s)
    return (f'<text x="{x:.2f}" y="{y:.2f}" font-family="{face}" font-size="{size}"'
            f' fill="{colour}" text-anchor="{anchor}"{w}{t}>{v}</text>')


def render(spec):
    periksa(spec)
    fam = spec.get('family', 'bar')
    W = float(spec.get('width_mm', 128)) * MM
    H = tinggi(spec) * MM
    d = spec['data']
    dec = int(spec.get('dec', 0))
    unit = spec.get('unit', '')
    limit = spec.get('limit')
    puncak = max([abs(x['value']) for x in d] + ([abs(limit)] if limit else []))
    puncak = puncak * 1.14 or 1.0

    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.2f}" height="{H:.2f}" '
         f'viewBox="0 0 {W:.2f} {H:.2f}">']
    # The apparatus contract, machine-readable. A figure that delegates its caption and
    # SUMBER to the page must SAY SO inside the file, or the release lint reads a correct
    # figure as a figure missing its apparatus and fires 29 and 30 — the two checks that
    # obeying 36 would otherwise guarantee failing. datum_diagram.py writes the same
    # marker; any new producer must too.
    if spec.get('apparatus', 'page') == 'page':
        o.append(f'<!-- DATUM-APPARATUS-REQUIRED: caption={esc(spec.get("id",""))} '
                 f'{esc(spec.get("title",""))} | source={esc(spec.get("source",""))} -->')
    o.append(f'<rect width="{W:.2f}" height="{H:.2f}" fill="{PAPER}"/>')

    if fam in ('bar', 'threshold'):
        kiri = 22 * MM                      # category gutter
        kanan = W - 24 * MM                 # value-label gutter, fixed column
        lebar = kanan - kiri
        y = 3 * MM
        tinggi_batang = 4.4 * MM
        jarak = 7.2 * MM
        for x in d:
            v = float(x['value'])
            L = lebar * v / puncak
            lewat = (limit is not None and v > limit)
            warna = ALERT if lewat else (SIGNAL if x.get('accent') else INK700)
            o.append(_teks(kiri - 2.2 * MM, y + tinggi_batang * 0.78, x['label'],
                           DATA, 6.6, INK400, 'end'))
            o.append(f'<rect x="{kiri:.2f}" y="{y:.2f}" width="{L:.2f}" '
                     f'height="{tinggi_batang:.2f}" fill="{warna}"/>')
            # Label nilai duduk pada kolom tetap di tepi kanan, bukan menempel pada
            # ujung batang: menempel membuatnya bertabrakan dengan garis batas persis
            # pada batang yang paling perlu dibaca.
            o.append(_teks(W - 1.5 * MM, y + tinggi_batang * 0.78,
                           fmt(v, dec), DATA, 6.8,
                           ALERT if lewat else (SIGNAL if x.get('accent') else INK900),
                           'end'))
            y += jarak
        dasar = y - jarak + tinggi_batang + 1.4 * MM
        o.append(f'<line x1="{kiri:.2f}" y1="{3*MM:.2f}" x2="{kiri:.2f}" '
                 f'y2="{dasar:.2f}" stroke="{INK900}" stroke-width="1.1"/>')
        if limit is not None:
            xl = kiri + lebar * float(limit) / puncak
            o.append(f'<line x1="{xl:.2f}" y1="{2*MM:.2f}" x2="{xl:.2f}" '
                     f'y2="{dasar:.2f}" stroke="{ALERT}" stroke-width="0.9" '
                     f'stroke-dasharray="3 2"/>')
            # Nama batas dikapitalkan, angka dan satuannya tidak: mengapitalkan seluruh
            # baris mengubah "m" menjadi "M" — meter menjadi mega.
            o.append(_teks(xl, dasar + 3.4 * MM,
                           str(spec.get('limit_label', 'BATAS')).upper(),
                           STRUCT, 6.2, ALERT, 'end', bold=True, track=0.6))
            o.append(_teks(xl + 1.4 * MM, dasar + 3.4 * MM,
                           fmt(limit, dec) + (f' {unit}' if unit else ''),
                           DATA, 6.2, ALERT, 'start'))
        if unit:
            # Satuan dicetak sekali, apa adanya. Mengapitalkannya mengubah "m" menjadi
            # "M" — mega, satuan yang berbeda.
            o.append(_teks(W - 1.5 * MM, dasar + 3.4 * MM, unit, DATA, 6.2, INK400, 'end'))

    elif fam == 'column':
        dasar = H - (10 * MM if spec.get('sub') else 6 * MM)
        atas = 6 * MM
        kiri = 4 * MM
        lebar = W - 8 * MM
        langkah = lebar / len(d)
        lebar_kolom = min(langkah * 0.52, 14 * MM)
        for i, x in enumerate(d):
            v = float(x['value'])
            h = (dasar - atas) * v / puncak
            cx = kiri + langkah * (i + 0.5)
            warna = SIGNAL if x.get('accent') else INK700
            o.append(f'<rect x="{cx - lebar_kolom/2:.2f}" y="{dasar - h:.2f}" '
                     f'width="{lebar_kolom:.2f}" height="{h:.2f}" fill="{warna}"/>')
            o.append(_teks(cx, dasar - h - 1.6 * MM, fmt(v, dec), DATA, 6.8,
                           SIGNAL if x.get('accent') else INK900, 'middle'))
            o.append(_teks(cx, dasar + 3.6 * MM, x['label'], STRUCT, 6.4, INK400,
                           'middle', caps=True, track=0.5))
            if x.get('sub'):
                o.append(_teks(cx, dasar + 7.2 * MM, x['sub'], DATA, 6.0, INK400, 'middle'))
        o.append(f'<line x1="{kiri:.2f}" y1="{dasar:.2f}" x2="{W - kiri:.2f}" '
                 f'y2="{dasar:.2f}" stroke="{INK900}" stroke-width="1.1"/>')
        if unit:
            o.append(_teks(kiri, atas - 1.6 * MM, unit, DATA, 6.2, INK400, 'start'))
    else:
        raise ChartDefect(f'keluarga "{fam}" tidak dikenal; bar · column · threshold')

    if spec.get('note'):
        o.append(_teks(spec.get('width_mm', 128) * MM / 2, H - 1.6 * MM,
                       spec['note'], STRUCT, 6.2, INK400, 'middle'))

    # apparatus "page" is the default: the document prints caption and SUMBER itself
    if spec.get('apparatus') == 'figure':
        o.append(_teks(0, H - 6 * MM, f"{spec['id']}   {spec.get('title','')}",
                       STRUCT, 7.0, INK900))
        o.append(_teks(0, H - 1.6 * MM, f"SUMBER  {spec['source']}",
                       STRUCT, 6.2, INK400))

    o.append('</svg>')
    return '\n'.join(o)


SKEMA = """DATUM chart spec — JSON  (figures with an AXIS; drawings use datum_diagram.py)

{
  "family":    "bar | column | threshold",
  "id":        "Gambar 2.1",           word, space, number — no underscore (§14)
  "title":     "one sentence, ends with a full stop",
  "source":    "document + clause the values were read from",
  "width_mm":  128,                    128 text column · 166 full span. Nothing else.
  "unit":      "W",                    printed once at the axis, never on every label
  "dec":       1,                      decimals; Indonesian separators applied for you
  "limit":     100.0,                  threshold family only — drawn, not just mentioned
  "limit_label": "BATAS ETHERNET",
  "apparatus": "page",                 default. "figure" only for a standalone SVG.
  "in_document": true,                 set when the figure is placed in a .docx/.pptx
  "note":      "footline inside the figure, optional",
  "data": [ {"label":"C-01", "value":60.0, "accent":false, "sub":"PTZ"} ]
}

At most one accent. No legend, no border, no gradient, no 3-D — not offered at all.
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description='DATUM chart engine')
    ap.add_argument('spec', nargs='?')
    ap.add_argument('-o', '--out')
    ap.add_argument('--estimate', action='store_true',
                    help='predicted height in mm from the spec, without rendering')
    ap.add_argument('--schema', action='store_true')
    a = ap.parse_args(argv)
    if a.schema:
        print(SKEMA); return 0
    if not a.spec:
        print(__doc__); return 2
    spec = json.load(sys.stdin if a.spec == '-' else open(a.spec, encoding='utf-8'))
    if a.estimate:
        t = tinggi(spec)
        print(f'{spec.get("id","(tanpa nomor)")}  perkiraan tinggi {t:.1f} mm '
              f'· blok teks A4 247 mm · {"MUAT" if t <= 247 else "TIDAK MUAT"}')
        return 0
    svg = render(spec)
    if a.out:
        open(a.out, 'w', encoding='utf-8').write(svg)
        print(f'OK {a.out} · {tinggi(spec):.1f} mm')
    else:
        print(svg)
    return 0


if __name__ == '__main__':
    sys.exit(main())
