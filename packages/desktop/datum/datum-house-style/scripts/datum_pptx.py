#!/usr/bin/env python3
"""DATUM command-brief builder, GSP Writing Manual Rev A (chapter 11.5-11.7).

    python3 datum_pptx.py                         built-in sample deck
    python3 datum_pptx.py isi.json [--varian NAMA ...] [--gambar 'Gambar 4.1=/path/fig.png' ...]
                                   [--keluar DIR]

Output folder: --keluar, else $DATUM_OUT, else the working directory. The Plex font folder
"IBM Plex" is copied beside every deck (DT-09, BR-14).

Master (Rev A 11.5, Table 11.3): 16:9, 338.7 x 190.5 mm, margin 18 mm; head y 11, kicker 8 pt
y 23, headline 26 pt y 31, body from y 42, SUMBER line at height - 24, foot at height - 12.
Default ground is white (DT-05). The dark master is built only with the builder setting
DATUM_BRIEF=gelap: the environment variable for a spec without "varian", or the variant's own
"DATUM_BRIEF" field in isi.json (the written request is recorded beside it; whether it exists
is the reviewer's call, BR-06). Light master: classification seal #6E1420 bold (BR-07), head
rule seal (BR-09, C21 D3), kicker signal (BR-12). Dark master: title band #6E1420, head
classification #D9756A (DT-41a), dark tokens (Annex A), white logo (C21 D4). Logo on the
title slide only (DT-41c): seal maroon gsp-seal.png on the ID light deck (ID p48, C46-2), black
ink on the EN light deck (EN p51). Body at y 42, or directly under a wrapped headline (C50).
The font folder carries Plex and DejaVu Sans with its licence (DT-09, glyph face 8.5). No animation, transition, gradient or stock picture. Every slide
with a number gets a SUMBER / SOURCE line and speaker notes with the derivations (BR-27, 33).

Input schema (Kasus 03 Rev A isi.json): meta, slide[] (jenis: judul, klaim-angka, gambar,
grafik, tabel-spesifikasi, butir, permintaan), edisi_en {meta, slide}, varian[], keluaran{}.
Shape names are stable so tests and reviewers can find each zone: pita, kepala-kiri,
kepala-kanan, garis-kepala, kicker, judul-sampul, judul, isi-*, panel-angka, aksen-garis,
logo, sumber, garis-kaki, kaki-kiri, kaki-kanan, kaki-cap.
"""

import copy
import json
import os
import re
import shutil
import sys

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_TICK_MARK
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Mm, Pt

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKENS = os.path.join(SKILL, 'tokens.json')
ASSET = os.path.join(SKILL, 'assets')
FONT_DIR = os.path.join(ASSET, 'fonts')
FONT_FOLDER_NAME = 'IBM Plex'           # shipped beside the deck (DT-09); no underscore (§14)

T = json.load(open(TOKENS, encoding='utf-8'))
I = T['colour']['interior']
B = T['colour']['brief']
BR = T['brief']
Z = BR['zones_mm']

COND, SERIF, MONO = 'IBM Plex Sans Condensed', 'IBM Plex Serif', 'IBM Plex Mono'
# Provenance glyphs are set in DejaVu Sans, the face Rev A embeds for them (8.5, ID p49 /
# EN p51; Annex A.2, ID p89 / EN p91; decision C44a). Every other run stays Plex (DT-08a).
GLYPH_FACE = 'DejaVu Sans'
GLYPHS = '■◈◇△'
GLYPH_RUN = re.compile('[' + GLYPHS + ']+')
GLYPH_SPLIT = re.compile('([' + GLYPHS + ']+)')

SW, SH = Mm(BR['slide_mm'][0]), Mm(BR['slide_mm'][1])
M = Mm(BR['margin_mm'])
Y_HEAD, Y_KICK, Y_HEADLINE = Mm(Z['head_y']), Mm(Z['kicker_y']), Mm(Z['headline_y'])
Y_BODY_MIN = Mm(Z['body_from_y'])
Y_SOURCE, Y_FOOT = SH - Mm(Z['source_from_bottom']), SH - Mm(Z['foot_from_bottom'])
HEADLINE_PITCH = Pt(31)                 # 26 pt headline on 31 pt lines
FONT_FILES = {(COND, True): 'IBMPlexSansCond-SemiBold.ttf', (COND, False): 'IBMPlexSansCond-Regular.ttf',
              (SERIF, False): 'IBMPlexSerif-Regular.ttf', (SERIF, True): 'IBMPlexSerif-SemiBold.ttf'}


def line_count(text, width, face=COND, bold=True, size=26, italic=False):
    """Lines a paragraph wraps to in a box `width` EMU wide, measured with the shipped Plex
    file (greedy word wrap at 97 % of the width, so a viewer that wraps a little earlier still
    fits). Used to put the body directly under the headline (BR-04, C50)."""
    from PIL import ImageFont
    fname = FONT_FILES[(face, bold)]
    if italic:
        fname = fname.replace('-Regular', '-Italic').replace('-SemiBold', '-SemiBoldItalic')
    font = ImageFont.truetype(os.path.join(FONT_DIR, fname), 1000)
    limit = width / 12700 * 0.97 * 1000 / size              # EMU -> pt -> font units
    n, cur = 1, ''
    for w in text.split():
        t = (cur + ' ' + w).strip()
        if cur and font.getlength(t) > limit:
            n, cur = n + 1, w
        else:
            cur = t
    return n


def body_top(lines):
    """Body from y 42 under a one-line headline; directly under a wrapped one (Table 11.3,
    ID p74; decision C50)."""
    return max(Y_BODY_MIN, Y_HEADLINE + HEADLINE_PITCH * lines)
NO_STYLE_TABLE = '{2D5ABB26-0587-4C30-8999-92F81FD0307C}'   # "No Style, No Grid"


def hx(h):
    return RGBColor.from_string(h.lstrip('#').upper())


def palette(gelap, edisi='id'):
    """Role -> hex (and logo file) for one master. Light: interior tokens + Rev A light_master.
    Dark: brief tokens."""
    if gelap:
        return dict(ground=B['ground'], head=B['head'], prose=B['prose'], meta=B['meta'],
                    hair=B['hairline'], panel=B['panel'], accent=B['accent'],
                    kicker=B['accent'], cls=B['class'], rule=B['hairline'],
                    band=B['title_band'], band_text=T['colour']['seal_band_text'],
                    bar_rest=B['meta'], logo='gsp-putih.png')
    L = B['light_master']
    return dict(ground=L['ground'][0], head=I['ink900'], prose=I['ink700'], meta=I['ink400'],
                hair=I['ink200'], panel=I['ink100'], accent=I['signal'], kicker=L['kicker'],
                cls=L['classification'], rule=L['head_rule'], band=T['colour']['wrapper']['seal'],
                band_text=T['colour']['seal_band_text'], bar_rest=I['ink400'],
                logo='gsp-tinta.png' if edisi == 'en' else 'gsp-seal.png')
    # logo: ID light deck seal maroon (ID p48; C46-2, derived asset gsp-seal.png); EN light
    # black ink once (EN p51); dark white (C21 D4).


def colour_from_spec(text, pal):
    """'signal #B45309' / 'ink400 #6B7783' -> the master's role colour; any other value is
    taken literally (its hex), so a wrong colour in the input stays visible to the tests."""
    name = (text or '').split()[0].lower() if text else ''
    if name == 'signal':
        return pal['accent']
    if name == 'ink400':
        return pal['bar_rest']
    m = re.search(r'#[0-9A-Fa-f]{6}', text or '')
    return m.group(0) if m else pal['bar_rest']


# ───────────────────────── drawing helpers ─────────────────────────
def textbox(sl, name, x, y, w, h, anchor=MSO_ANCHOR.TOP):
    s = sl.shapes.add_textbox(x, y, w, h)
    s.name = name
    tf = s.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    return s


def para(tf, runs, align=PP_ALIGN.LEFT, spacing=None, after=0, first=False):
    """runs = [(text, face, size, hex, bold, italic[, all_caps])]"""
    p = tf.paragraphs[0] if (first and not tf.paragraphs[0].runs) else tf.add_paragraph()
    p.alignment = align
    if spacing:
        p.line_spacing = Pt(spacing)
    p.space_after = Pt(after)
    for text, face, size, colour, bold, italic, *caps in runs:
        for seg in GLYPH_SPLIT.split(text):
            if not seg:
                continue
            r = p.add_run()
            r.text = seg
            f = r.font
            f.name, f.size, f.bold, f.italic = (GLYPH_FACE if GLYPH_RUN.fullmatch(seg) else face,
                                                Pt(size), bold, italic)
            if colour:
                f.color.rgb = hx(colour)
            if caps and caps[0]:
                f._rPr.set('cap', 'all')        # display capitals; the text keeps its own case
    return p


def rect(sl, name, x, y, w, h, fill):
    s = sl.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    s.name = name
    s.fill.solid()
    s.fill.fore_color.rgb = hx(fill)
    s.line.fill.background()
    s.shadow.inherit = False
    return s


def bullets(p, char='•'):
    pPr = p._p.get_or_add_pPr()
    pPr.set('marL', str(Mm(6)))
    pPr.set('indent', str(-Mm(6)))
    bf = etree.SubElement(pPr, qn('a:buFont'))
    bf.set('typeface', COND)
    bc = etree.SubElement(pPr, qn('a:buChar'))
    bc.set('char', char)


# ───────────────────────── slide furniture ─────────────────────────
class Deck:
    def __init__(self, meta, slides, edisi, gelap, gambar):
        self.meta, self.slides, self.edisi, self.gelap = meta, slides, edisi, gelap
        self.gambar = gambar or {}
        self.pal = palette(gelap, edisi)
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = SW, SH
        self.blank = self.prs.slide_layouts[6]
        self.N = len(slides)

    def furniture(self, sl, n):
        P, m = self.pal, self.meta
        sl.background.fill.solid()
        sl.background.fill.fore_color.rgb = hx(P['ground'])
        half = (SW - 2 * M) // 2
        k = textbox(sl, 'kepala-kiri', M, Y_HEAD, half, Mm(5))
        para(k.text_frame, [(m.get('kepala_kiri', ''), COND, 8, P['meta'], False, False)], first=True)
        k = textbox(sl, 'kepala-kanan', SW // 2, Y_HEAD, SW - M - SW // 2, Mm(5))
        para(k.text_frame, [(m.get('kepala_kanan', '') + '     ', COND, 8, P['meta'], False, False),
                            (m['klasifikasi'], COND, 8, P['cls'], True, False)],
             align=PP_ALIGN.RIGHT, first=True)
        rect(sl, 'garis-kepala', M, Mm(17.5), SW - 2 * M,
             Mm(T['rules_mm']['running_head_close']), P['rule'])
        rect(sl, 'garis-kaki', M, SH - Mm(14), SW - 2 * M, Mm(0.18), P['hair'])
        f = textbox(sl, 'kaki-kiri', M, Y_FOOT, Mm(150), Mm(5))
        para(f.text_frame, [(f"GSP · {m['nomor']} · REV {m.get('rev', 'A')}", MONO, 7, P['meta'],
                             False, False)], first=True)
        f = textbox(sl, 'kaki-kanan', SW - M - Mm(40), Y_FOOT, Mm(40), Mm(5))
        pola = m.get('kaki_kanan_pola', 'SLIDE {n} / {N}')
        para(f.text_frame, [(pola.format(n=n, N=self.N), MONO, 7, P['meta'], False, False)],
             align=PP_ALIGN.RIGHT, first=True)

    def kicker(self, sl, text):
        k = textbox(sl, 'kicker', M, Y_KICK, Mm(220), Mm(5))
        para(k.text_frame, [(text, COND, BR['kicker_pt'], self.pal['kicker'], True, False, True)],
             first=True)

    def headline(self, sl, text, w=None):
        """Claim headline at y 31; returns the body top (y 42, or under a wrapped headline)."""
        w = w or (SW - 2 * M)
        n = line_count(text, w)
        h = textbox(sl, 'judul', M, Y_HEADLINE, w, HEADLINE_PITCH * n)
        para(h.text_frame, [(text, COND, BR['headline_pt'], self.pal['head'], True, False)],
             spacing=31, first=True)
        return body_top(n)

    def source(self, sl, text):
        if not (text or '').strip():
            return
        s = textbox(sl, 'sumber', M, Y_SOURCE, SW - 2 * M, Mm(8))
        para(s.text_frame, [(text, COND, 7.5, self.pal['meta'], False, False)], spacing=9.5,
             first=True)

    def logo(self, sl):
        p = sl.shapes.add_picture(os.path.join(ASSET, 'logo', self.pal['logo']),
                                  SW - M - Mm(48), Y_HEADLINE, width=Mm(48))
        p.name = 'logo'

    def prose(self, sl, text, x, y, w, h, size=12):
        if not (text or '').strip():
            return
        t = textbox(sl, 'isi-uraian', x, y, w, h)
        para(t.text_frame, [(text, SERIF, size, self.pal['prose'], False, False)],
             spacing=size * 1.42, first=True)

    def numbers(self, sl, rows, aksen, x0, y0, panel=False):
        P = self.pal
        pitch = Mm(11)
        hot = (aksen or {}).get('nilai') if (aksen or {}).get('jenis') == 'baris-angka' else None
        if panel:
            rect(sl, 'panel-angka', x0 - Mm(5), y0 - Mm(6), SW - M - (x0 - Mm(5)),
                 pitch * len(rows) + Mm(10), P['panel'])
        rect(sl, 'aksen-garis', x0, y0 - Mm(2.5), SW - M - x0 - (Mm(5) if panel else 0),
             Mm(0.45), P['accent'])
        v = textbox(sl, 'isi-angka-nilai', x0, y0, Mm(46), pitch * len(rows))
        lab = textbox(sl, 'isi-angka-label', x0 + Mm(50), y0,
                      SW - M - x0 - Mm(50) - (Mm(5) if panel else 0), pitch * len(rows))
        sp = pitch / 12700                                       # EMU -> pt
        for i, (val, label) in enumerate(rows):
            para(v.text_frame, [(val, MONO, 14, P['accent'] if val == hot else P['head'], True,
                                 False)], align=PP_ALIGN.RIGHT, spacing=sp, first=(i == 0))
            para(lab.text_frame, [(label, COND, 10.5, P['meta'], False, False)], spacing=sp,
                 first=(i == 0))

    # ───────────── slide types ─────────────
    def s_judul(self, sl, s, n):
        P = self.pal
        band = rect(sl, 'pita', 0, 0, SW, Mm(5), P['band'])
        tf = band.text_frame
        tf.margin_left, tf.margin_top, tf.margin_bottom = M, 0, 0
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        para(tf, [(s.get('pita', ''), COND, T['type']['scale_pt']['seal_band']['size'],
                   P['band_text'], True, False)], first=True)
        if s.get('kicker'):
            self.kicker(sl, s['kicker'])
        tw = SW - 2 * M - Mm(60)
        nl = sum(line_count(x, tw) for x in s.get('judul_baris', [])) or 1
        t = textbox(sl, 'judul-sampul', M, Y_HEADLINE, tw, HEADLINE_PITCH * nl)
        y = body_top(nl)
        for i, line in enumerate(s.get('judul_baris', [])):
            para(t.text_frame, [(line, COND, BR['headline_pt'], P['head'], True, False)],
                 spacing=31, first=(i == 0))
        if s.get('pengantar'):
            k = line_count(s['pengantar'], Mm(200), SERIF, False, 13, italic=True)
            t = textbox(sl, 'isi-pengantar', M, y, Mm(200), Pt(18.5) * k)
            para(t.text_frame, [(s['pengantar'], SERIF, 13, P['prose'], False, True)],
                 spacing=18.5, first=True)
            y = y + Pt(18.5) * k + Mm(4)
        if s.get('penerima'):
            t = textbox(sl, 'isi-penerima', M, y, Mm(200), Mm(6))
            para(t.text_frame, [(s['penerima'], COND, 10, P['meta'], False, False)], first=True)
        if s.get('cap_terbitan'):
            c = textbox(sl, 'kaki-cap', Mm(170), Y_FOOT, SW - M - Mm(44) - Mm(170), Mm(5))
            para(c.text_frame, [(s['cap_terbitan'], MONO, 7, P['cls'], True, False)],
                 align=PP_ALIGN.RIGHT, first=True)

    def s_klaim_angka(self, sl, s, n):
        y = self.headline(sl, s['klaim'])
        self.prose(sl, s.get('uraian'), M, y, Mm(160), Mm(80))
        self.numbers(sl, s.get('angka', []), s.get('aksen'), Mm(192), y + Mm(3))

    def s_permintaan(self, sl, s, n):
        y = self.headline(sl, s['klaim'])
        self.prose(sl, s.get('uraian'), M, y, Mm(155), Mm(80))
        self.numbers(sl, s.get('angka', []), s.get('aksen'), Mm(196), y + Mm(7),
                     panel=bool(s.get('panel')))

    def s_gambar(self, sl, s, n):
        y = self.headline(sl, s['klaim'])
        self.prose(sl, s.get('uraian'), M, y, Mm(150), Mm(80))
        path = self.gambar.get(s.get('gambar_id')) or s.get('rujukan')
        if not path or not path.lower().endswith('.png') or not os.path.isfile(path):
            raise SystemExit(f"datum_pptx: slide {n}: no PNG for {s.get('gambar_id')!r}; pass "
                             f"--gambar '{s.get('gambar_id')}=/path/figure.png' (the diagram "
                             f"rendered by the Studio engine)")
        from PIL import Image
        with Image.open(path) as im:
            wpx, hpx = im.size
        top = y
        hmax = min(Y_SOURCE - Mm(2) - top, Mm(118))
        wmax = SW - 2 * M - Mm(160)
        h = hmax
        w = Emu(int(h * wpx / hpx))
        if w > wmax:
            w, h = wmax, Emu(int(wmax * hpx / wpx))
        p = sl.shapes.add_picture(path, SW - M - w, top, width=w, height=h)
        p.name = 'isi-gambar'

    def s_grafik(self, sl, s, n):
        P = self.pal
        y0 = self.headline(sl, s['klaim'])
        self.prose(sl, s.get('uraian'), M, y0, SW - 2 * M, Mm(12))
        g = s['grafik']
        data = sorted(g['data'], key=lambda d: -d[1])            # sorted bar (Tab 9.6)
        cd = CategoryChartData()
        cd.categories = [d[0] for d in data]
        cd.add_series(g.get('satuan', ''), [d[1] for d in data])
        y = y0 + Mm(14)
        gf = sl.shapes.add_chart(XL_CHART_TYPE.BAR_CLUSTERED, M, y, SW - 2 * M,
                                 Y_SOURCE - Mm(2) - y, cd)   # width_mm "page" (BR-30)
        gf.name = 'isi-grafik'
        ch = gf.chart
        ch.has_legend = False
        ch.has_title = False
        ch.font.name, ch.font.size = COND, Pt(10)
        ch.font.color.rgb = hx(P['prose'])
        plot = ch.plots[0]
        plot.gap_width = 60
        plot.vary_by_categories = False
        ser = plot.series[0]
        hot = colour_from_spec(g.get('warna_sorot', 'signal'), P)
        rest = colour_from_spec(g.get('warna_lain', 'ink400'), P)
        for i, d in enumerate(data):
            pt = ser.points[i]
            pt.format.fill.solid()
            pt.format.fill.fore_color.rgb = hx(hot if d[0] == g.get('sorot') else rest)
            pt.format.line.fill.background()
            dl = pt.data_label
            dl.position = XL_LABEL_POSITION.OUTSIDE_END
            tf = dl.text_frame
            tf.text = ''
            r = tf.paragraphs[0].add_run()
            r.text = f"{d[2]} {g.get('satuan', '')}".strip()
            r.font.name, r.font.size, r.font.bold = MONO, Pt(10), False
            r.font.color.rgb = hx(P['head'])
        ca = ch.category_axis
        ca.reverse_order = True
        ca.major_tick_mark = XL_TICK_MARK.NONE
        ca.minor_tick_mark = XL_TICK_MARK.NONE
        ca.has_major_gridlines = False
        ca.format.line.color.rgb = hx(P['hair'])
        ca.tick_labels.font.name, ca.tick_labels.font.size = COND, Pt(10)
        ca.tick_labels.font.color.rgb = hx(P['prose'])
        va = ch.value_axis
        va.has_major_gridlines = False
        va.minimum_scale, va.maximum_scale = 0, max(d[1] for d in data) * 1.18
        va.visible = False
        # transparent chart and plot area: the slide ground shows through on both masters
        cs = ch._chartSpace
        for parent, before in ((cs, cs.find(qn('c:txPr'))), (cs.chart.plotArea, None)):
            sp = etree.Element(qn('c:spPr'))
            if before is not None:
                before.addprevious(sp)          # chartSpace: c:chart, c:spPr, c:txPr
            else:
                parent.append(sp)               # plotArea: spPr is last (no extLst written)
            etree.SubElement(sp, qn('a:noFill'))
            ln = etree.SubElement(sp, qn('a:ln'))
            etree.SubElement(ln, qn('a:noFill'))

    def s_tabel(self, sl, s, n):
        P = self.pal
        y = self.headline(sl, s['klaim'])
        rows = [s['kolom']] + s['baris']
        widths = [0.30, 0.36, 0.34]
        pitch = Mm(10)
        gf = sl.shapes.add_table(len(rows), len(s['kolom']), M, y, SW - 2 * M,
                                 pitch * len(rows))
        gf.name = 'isi-tabel'
        tbl = gf.table
        tblPr = tbl._tbl.tblPr
        tblPr.set('firstRow', '0')
        tblPr.set('bandRow', '0')
        sid = tblPr.find(qn('a:tableStyleId'))
        if sid is None:
            sid = etree.SubElement(tblPr, qn('a:tableStyleId'))
        sid.text = NO_STYLE_TABLE
        total = SW - 2 * M
        for j, wf in enumerate(widths[:len(s['kolom'])]):
            tbl.columns[j].width = Emu(int(total * wf))
        for i, row in enumerate(rows):
            tbl.rows[i].height = pitch
            for j, val in enumerate(row):
                cell = tbl.cell(i, j)
                cell.margin_left = 0 if j == 0 else Mm(2)
                cell.margin_right = Mm(2)
                cell.margin_top = cell.margin_bottom = Mm(1)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                tf = cell.text_frame
                tf.word_wrap = True
                if i == 0:
                    run = (val, COND, 8, P['meta'], True, False, True)
                elif j == 0:
                    run = (val, COND, 11, P['head'], True, False)
                elif j == len(row) - 1:
                    run = (val, MONO, 10.5, P['head'], False, False)
                else:
                    run = (val, SERIF, 10.5, P['prose'], False, False)
                tf.text = ''
                para(tf, [run], first=True)
                tcPr = cell._tc.get_or_add_tcPr()
                for ch in list(tcPr):
                    tcPr.remove(ch)
                for side in ('lnL', 'lnR', 'lnT'):
                    ln = etree.SubElement(tcPr, qn('a:' + side))
                    ln.set('w', '0')
                    etree.SubElement(ln, qn('a:noFill'))
                ln = etree.SubElement(tcPr, qn('a:lnB'))
                ln.set('w', str(Mm(0.45) if i == 0 else Mm(0.20)))
                sf = etree.SubElement(ln, qn('a:solidFill'))
                c = etree.SubElement(sf, qn('a:srgbClr'))
                c.set('val', (P['head'] if i == 0 else P['hair']).lstrip('#').upper())
                etree.SubElement(tcPr, qn('a:noFill'))

    def s_butir(self, sl, s, n):
        P = self.pal
        y = self.headline(sl, s['klaim'])
        t = textbox(sl, 'isi-butir', M, y, Mm(260), Mm(100))
        for i, item in enumerate(s.get('butir', [])):
            p = para(t.text_frame, [(item, SERIF, 13, P['prose'], False, False)], spacing=18.5,
                     after=7, first=(i == 0))
            bullets(p)

    KINDS = {'judul': 's_judul', 'klaim-angka': 's_klaim_angka', 'gambar': 's_gambar',
             'grafik': 's_grafik', 'tabel-spesifikasi': 's_tabel', 'butir': 's_butir',
             'permintaan': 's_permintaan'}

    def notes(self, sl, s):
        cp = s.get('catatan_pembicara') or {}
        naskah, turunan = (cp.get('naskah') or '').strip(), cp.get('turunan') or []
        if not naskah and not turunan:
            return
        tf = sl.notes_slide.notes_text_frame
        en = self.edisi == 'en'
        first = True
        if naskah:
            para(tf, [('SCRIPT' if en else 'NASKAH', COND, 10, None, True, False)], first=True)
            para(tf, [(naskah, SERIF, 12, None, False, False)], after=6)
            first = False
        if turunan:
            para(tf, [('DERIVATION' if en else 'TURUNAN', COND, 10, None, True, False)],
                 first=first)
            for line in turunan:
                para(tf, [(line, MONO, 10, None, False, False)])

    def build(self):
        for n, s in enumerate(self.slides, start=1):
            sl = self.prs.slides.add_slide(self.blank)
            self.furniture(sl, n)
            if s.get('jenis') != 'judul' and s.get('kicker'):
                self.kicker(sl, s['kicker'])
            kind = self.KINDS.get(s.get('jenis'))
            if not kind:
                raise SystemExit(f"datum_pptx: slide {n}: unknown jenis {s.get('jenis')!r}")
            getattr(self, kind)(sl, s, n)
            if s.get('logo'):
                self.logo(sl)
            self.source(sl, s.get('sumber'))
            self.notes(sl, s)
        clean_theme(self.prs)
        cp = self.prs.core_properties
        title = ' '.join(self.slides[0].get('judul_baris', [])) or self.slides[0].get('klaim', '')
        cp.title = title
        cp.subject = self.meta['nomor']
        cp.author = cp.last_modified_by = 'PT Gemilang Satria Perkasa'
        cp.keywords = self.meta['klasifikasi']
        cp.language = 'en-GB' if self.edisi == 'en' else 'id-ID'
        cp.category = 'DEK'
        cp.comments = 'datum_pptx.py Rev A' + (' · DATUM_BRIEF=gelap' if self.gelap else '')
        cp.revision = 1
        return self.prs


def clean_theme(prs):
    """Every theme part (slide master and notes master): Plex as the major/minor Latin font,
    no script-font list (Calibri, Times New Roman ...), no gradient fill styles (BR-15, BR-24)."""
    A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    for part in prs.part.package.iter_parts():
        if '/theme/' not in str(part.partname):
            continue
        el = part._element if hasattr(part, '_element') else etree.fromstring(part.blob)
        for tag, face in (('majorFont', COND), ('minorFont', SERIF)):
            for f in el.iter('{%s}%s' % (A, tag)):
                for child in list(f):
                    if child.tag == '{%s}latin' % A:
                        child.set('typeface', face)
                        for k in ('panose', 'pitchFamily', 'charset'):
                            child.attrib.pop(k, None)
                    elif child.tag == '{%s}font' % A:
                        f.remove(child)
        for g in list(el.iter('{%s}gradFill' % A)):
            sf = etree.Element('{%s}solidFill' % A)
            etree.SubElement(sf, '{%s}schemeClr' % A).set('val', 'phClr')
            g.addprevious(sf)
            g.getparent().remove(g)
        if not hasattr(part, '_element'):
            part._blob = etree.tostring(el, xml_declaration=True, encoding='UTF-8',
                                        standalone=True)


def ship_fonts(out_dir):
    dst = os.path.join(out_dir, FONT_FOLDER_NAME)
    os.makedirs(dst, exist_ok=True)
    for f in sorted(os.listdir(FONT_DIR)):
        if f.endswith('.ttf') or f.endswith('.txt'):
            shutil.copyfile(os.path.join(FONT_DIR, f), os.path.join(dst, f))
    return dst


def build_deck(meta, slides, out_path, edisi='id', gelap=False, gambar=None, fonts=True):
    """Build one deck; returns out_path. gelap is the DATUM_BRIEF=gelap setting."""
    prs = Deck(meta, slides, edisi, gelap, gambar).build()
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    prs.save(out_path)
    if fonts:
        ship_fonts(os.path.dirname(os.path.abspath(out_path)))
    return out_path


def variants(spec):
    """isi.json -> [(name, edisi, gelap, meta, slides, file name)]. Without "varian": one
    deck in the spec's language, dark only when the environment says DATUM_BRIEF=gelap."""
    out = []
    keluaran = spec.get('keluaran', {})
    if not spec.get('varian'):
        gelap = os.environ.get('DATUM_BRIEF', '').strip().lower() == 'gelap'
        ed = spec.get('meta', {}).get('bahasa', 'id')
        out.append(('utama', ed, gelap, spec['meta'], spec['slide'],
                    keluaran.get('utama', 'GSP DATUM Paparan.pptx')))
        return out
    for v in spec['varian']:
        ed = v.get('edisi', 'id')
        src = spec['edisi_en'] if ed == 'en' else spec
        gelap = (v.get('DATUM_BRIEF') or '').strip().lower() == 'gelap'
        out.append((v['nama'], ed, gelap, src['meta'], src['slide'],
                    keluaran.get(v['nama'], f"GSP DATUM Paparan {v['nama']}.pptx")))
    return out


# ───────────────────────── built-in sample (no input file) ─────────────────────────
SAMPLE = {
    'meta': {'bahasa': 'id', 'nomor': '000/GSP/DEK/VIII/2026', 'rev': 'B', 'klasifikasi': 'RAHASIA',
             'kepala_kiri': 'PT GEMILANG SATRIA PERKASA · DIVISI ENGINEERING',
             'kepala_kanan': 'PERIMETER RING TERLUAR 2026', 'kaki_kanan_pola': 'SLIDE {n} / {N}'},
    'keluaran': {'utama': 'GSP DATUM Contoh Command Brief.pptx'},
    'slide': [
        {'jenis': 'judul', 'pita': 'KLASIFIKASI · RAHASIA', 'kicker': 'PAPARAN · BASELINE ENGINEERING',
         'judul_baris': ['Perluasan Perimeter Ring Terluar', 'Kawasan Barat dan Timur'],
         'pengantar': 'Baseline terverifikasi untuk titik deteksi pada perimeter terukur, disiapkan '
                      'agar kuantitas dapat dikunci sebelum dokumen lelang.',
         'penerima': 'Kepada Pimpinan Satuan Kerja', 'logo': True,
         'cap_terbitan': '// 20260801 ID R, TERBITAN 2',
         'catatan_pembicara': {'naskah': 'Bapak Pimpinan, kami mohon persetujuan mengunci kuantitas '
                                         'sebelum dokumen lelang disusun.', 'turunan': []}},
        {'jenis': 'klaim-angka', 'kicker': 'Bagian 2 · Baseline',
         'klaim': 'Perimeter 6.546,2 m menuntut 70 titik deteksi.',
         'uraian': 'Register koordinat adalah satu-satunya sumber dimensi. Galian, serat optik dan '
                   'catu daya diturunkan darinya.',
         'angka': [['6.546,2 m', 'perimeter terukur'], ['70', 'titik deteksi'],
                   ['97,7 m', 'spasi median'], ['7,40 kVA', 'daya semu puncak']],
         'aksen': {'jenis': 'baris-angka', 'nilai': '70'},
         'sumber': 'SUMBER Register koordinat Rev B · survei lapangan. PROVENANS perimeter dan spasi '
                   '■ TERUKUR [A1] · titik dan daya ◈ DITURUNKAN.',
         'catatan_pembicara': {'naskah': 'Perimeter sekitar enam koma lima kilometer menuntut tujuh '
                                         'puluh titik.',
                               'turunan': ['6.546,2 m perimeter, register koordinat. ■ TERUKUR [A1]',
                                           '70 titik = 6.546,2 m / 97,7 m spasi median, dibulatkan. ◈ DITURUNKAN',
                                           '97,7 m spasi median terukur. ■ TERUKUR [A1]',
                                           '7,40 kVA daya semu puncak, Turunan D-7.3a. ◈ DITURUNKAN']}},
        {'jenis': 'butir', 'kicker': 'Bagian 3 · Asumsi terbuka',
         'klaim': 'Tiga asumsi mengikat angka, dan semuanya dapat diuji sebelum kontrak.',
         'butir': ['cos φ terpasang 0,85; diuji saat uji terima pabrik.',
                   'Tegangan jaringan (230 ± 12) V, toleransi rancangan; direkam 7 hari.',
                   'Tanah tidak berbatu di seluruh jalur; dicek dengan sondir 6 titik.'],
         'sumber': 'SUMBER Register asumsi ASM-PWR-01, ASM-PWR-03, ASM-SIP-02. PROVENANS seluruh '
                   'nilai △ ASUMSI.',
         'catatan_pembicara': {'naskah': 'Tiga asumsi masih terbuka dan masing-masing punya cara uji.',
                               'turunan': ['0,85: cos φ terpasang, ASM-PWR-01. △ ASUMSI',
                                           '(230 ± 12) V, perekaman 7 hari, ASM-PWR-03. △ ASUMSI',
                                           'Sondir 6 titik, ASM-SIP-02. △ ASUMSI']}},
        {'jenis': 'permintaan', 'kicker': 'Bagian 4 · Keputusan yang diminta',
         'klaim': 'Kami mohon persetujuan untuk mengunci kuantitas sebelum dokumen lelang disusun.',
         'uraian': 'Setelah dikunci, seluruh dokumen berikutnya dibangun di atas satu register yang '
                   'sama dan diaudit sebagai satu kesatuan.',
         'angka': [['70', 'titik deteksi dikunci'], ['6.546,2 m', 'perimeter terukur'],
                   ['7,40 kVA', 'daya semu puncak'], ['3', 'asumsi terbuka, semua dapat diuji']],
         'aksen': {'jenis': 'baris-angka', 'nilai': '70'}, 'panel': 'ink100',
         'sumber': 'SUMBER Register koordinat Rev B · register asumsi. PROVENANS titik dan daya '
                   '◈ DITURUNKAN · perimeter ■ TERUKUR [A1].',
         'catatan_pembicara': {'naskah': 'Kami mohon Bapak menyetujui penguncian tujuh puluh titik hari ini.',
                               'turunan': ['70 titik: slide 2. ◈ DITURUNKAN',
                                           '6.546,2 m: slide 2. ■ TERUKUR [A1]',
                                           '7,40 kVA: slide 2. ◈ DITURUNKAN',
                                           '3 asumsi: slide 3. △ ASUMSI']}},
    ],
}


def main(argv):
    args, varian, gambar, keluar = [], [], {}, None
    it = iter(argv)
    for a in it:
        if a == '--varian':
            varian.append(next(it))
        elif a == '--gambar':
            k, _, v = next(it).partition('=')
            gambar[k.strip()] = os.path.abspath(v.strip())
        elif a == '--keluar':
            keluar = next(it)
        elif a in ('-h', '--help'):
            print(__doc__)
            return 0
        else:
            args.append(a)
    out_dir = os.path.abspath(keluar or os.environ.get('DATUM_OUT') or os.getcwd())
    if args:
        spec = json.load(open(args[0], encoding='utf-8'))
        base = os.path.dirname(os.path.abspath(args[0]))
        for s in spec.get('slide', []) + spec.get('edisi_en', {}).get('slide', []):
            if s.get('rujukan') and not os.path.isabs(s['rujukan']):
                s['rujukan'] = os.path.normpath(os.path.join(base, s['rujukan']))
    else:
        spec = copy.deepcopy(SAMPLE)
    for name, ed, gelap, meta, slides, fname in variants(spec):
        if varian and name not in varian:
            continue
        path = build_deck(meta, slides, os.path.join(out_dir, fname), ed, gelap, gambar)
        print(f"pptx ok  {name}  {'gelap' if gelap else 'terang'}  {ed}  {path}")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
