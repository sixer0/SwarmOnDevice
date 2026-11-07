#!/usr/bin/env python3
"""DATUM v1.1 — Word report builder for PT Gemilang Satria Perkasa.
Typefaces are EMBEDDED (see embed_fonts.py) so the file renders identically on
any machine, Windows or macOS, regardless of what the recipient has installed."""

import json
from docx import Document
from docx.shared import Pt, Mm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_LINE_SPACING
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

import os, sys
SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(SKILL, 'scripts'))
TOKENS = os.path.join(SKILL, 'tokens.json')
ASSET  = os.path.join(SKILL, 'assets') + os.sep
OUT    = os.environ.get('DATUM_OUT', os.getcwd())

T = json.load(open(TOKENS))
W, I = T['colour']['wrapper'], T['colour']['interior']


def C(h): return RGBColor.from_string(h.lstrip('#').upper())
INK, INK7, INK4, SIG, ALERT = C(I['ink900']), C(I['ink700']), C(I['ink400']), C(I['signal']), C(I['alert'])
WINK, WBODY, WMETA, SEAL = C(W['ink']), C(W['body']), C(W['meta']), C(W['seal'])

STRUCT, READ, DATA = 'IBM Plex Sans Cond', 'IBM Plex Serif', 'IBM Plex Mono'

DOC_ID, REV, REV_DATE, CLASS, NPAGES = '005/GSP/KT/VIII/2026', 'B', '01-VIII-2026', 'RAHASIA', 6

# ─────────────────────────── xml helpers ───────────────────────────
def el(tag, **kw):
    e = OxmlElement(tag)
    for k, v in kw.items(): e.set(qn('w:' + k), str(v))
    return e

def borders(obj, **edges):
    is_cell = hasattr(obj, '_tc')
    pr = obj._tc.get_or_add_tcPr() if is_cell else obj._p.get_or_add_pPr()
    tag = 'w:tcBorders' if is_cell else 'w:pBdr'
    b = pr.find(qn(tag))
    if b is None: b = OxmlElement(tag); pr.append(b)
    for side, spec in edges.items():
        old = b.find(qn('w:' + side))
        if old is not None: b.remove(old)
        if spec is None: continue
        sz, col = spec
        b.append(el('w:' + side, val='single', sz=str(sz), space='0', color=col.lstrip('#')))

def shade(cell, hexcol):
    cell._tc.get_or_add_tcPr().append(el('w:shd', val='clear', color='auto', fill=hexcol.lstrip('#')))

def margins(cell, top=0, bottom=0, left=0, right=0):
    m = OxmlElement('w:tcMar')
    for n, v in (('top', top), ('start', left), ('bottom', bottom), ('end', right)):
        m.append(el('w:' + n, w=str(int(v * 56.7)), type='dxa'))
    cell._tc.get_or_add_tcPr().append(m)

def mktable(rows, widths_mm):
    t = doc.add_table(rows=rows, cols=len(widths_mm))
    t.autofit = False
    pr = t._tbl.tblPr
    b = OxmlElement('w:tblBorders')
    for s in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        b.append(el('w:' + s, val='none', sz='0', space='0', color='auto'))
    pr.append(b)
    pr.append(el('w:tblLayout', type='fixed'))
    pr.append(el('w:tblW', w=str(int(sum(widths_mm) * 56.7)), type='dxa'))
    grid = t._tbl.find(qn('w:tblGrid'))
    for gc, wmm in zip(grid.findall(qn('w:gridCol')), widths_mm):
        gc.set(qn('w:w'), str(int(wmm * 56.7)))
    for r in t.rows:
        r._tr.get_or_add_trPr().append(el('w:cantSplit', val='1'))
        for c, wmm in zip(r.cells, widths_mm):
            c.width = Mm(wmm)
            c._tc.get_or_add_tcPr().append(el('w:tcW', w=str(int(wmm * 56.7)), type='dxa'))
    return t

def keep(p): p._p.get_or_add_pPr().append(el('w:keepNext', val='1'))

def run(p, text, face=READ, size=9.5, colour=INK7, bold=False, italic=False, caps=False, track=None):
    r = p.add_run(text)
    r.font.size = Pt(size); r.font.color.rgb = colour; r.font.bold = bold; r.font.italic = italic
    if caps: r.font.all_caps = True
    rpr = r._element.get_or_add_rPr()
    rpr.append(el('w:rFonts', ascii=face, hAnsi=face, cs=face, eastAsia=face))
    if track: rpr.append(el('w:spacing', val=str(int(track * 20))))
    return r

def setp(p, before=0, after=0, leading=13.5, align=None, k=False):
    pf = p.paragraph_format
    pf.space_before = Pt(before); pf.space_after = Pt(after)
    if leading: pf.line_spacing = Pt(leading)
    else: pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
    if align is not None: p.alignment = align
    if k: keep(p)
    return p

def para(container, text='', face=READ, size=9.5, colour=INK7, bold=False, italic=False,
         align=None, before=0, after=0, leading=13.5, caps=False, track=None, k=False):
    p = container.add_paragraph(); setp(p, before, after, leading, align, k)
    if text: run(p, text, face, size, colour, bold, italic, caps, track)
    return p

def cpara(cell, text='', **kw):
    if cell.paragraphs and not cell.paragraphs[0].runs:
        p = cell.paragraphs[0]
        setp(p, kw.get('before', 0), kw.get('after', 0), kw.get('leading', 13.5), kw.get('align'), kw.get('k', False))
        if text: run(p, text, kw.get('face', READ), kw.get('size', 9.5), kw.get('colour', INK7),
                     kw.get('bold', False), kw.get('italic', False), kw.get('caps', False), kw.get('track'))
        return p
    return para(cell, text, **kw)

# ─────────────────────────── document setup ───────────────────────────
doc = Document()
st = doc.styles['Normal']
st.font.size = Pt(9.5); st.font.color.rgb = INK7
st.element.rPr.append(el('w:rFonts', ascii=READ, hAnsi=READ, cs=READ, eastAsia=READ))
st.paragraph_format.space_after = Pt(0); st.paragraph_format.line_spacing = Pt(13.5)

def setup(s):
    s.page_width, s.page_height = Mm(210), Mm(297)
    s.left_margin, s.right_margin = Mm(24), Mm(20)
    s.top_margin, s.bottom_margin = Mm(26), Mm(24)
    s.header_distance, s.footer_distance = Mm(13), Mm(13)
    return s

setup(doc.sections[0])

# ══════════════════ PAGE 1 — COVER (Sovereign wrapper) ══════════════════
band = mktable(1, [83, 83])
for i, txt in enumerate(['KLASIFIKASI · RAHASIA', 'SALINAN 03 DARI 06 · TIDAK UNTUK DIEDARKAN']):
    c = band.cell(0, i); shade(c, W['seal']); margins(c, 1.5, 1.5, 2.5 if i == 0 else 0, 2.5)
    cpara(c, txt, face=STRUCT, size=6.4, colour=C('#F6E9E9'), bold=True, caps=True, track=1.3, leading=9,
          align=WD_ALIGN_PARAGRAPH.LEFT if i == 0 else WD_ALIGN_PARAGRAPH.RIGHT)

p = doc.add_paragraph(); setp(p, before=18, after=0, leading=None)
p.add_run().add_picture(ASSET + 'logo/gsp-tinta.png', width=Mm(44))

para(doc, 'Divisi Engineering & Technical Intelligence · Jl. Bangka Raya No. 27, Pela Mampang, '
          'Jakarta Selatan 12720 · Tel. (021) 22715320', STRUCT, 7, WMETA, before=5, after=4, leading=10.5)
r = para(doc, after=24, leading=6); borders(r, bottom=(4, W['rule']))

p = doc.add_paragraph(); setp(p, after=7, leading=None)
p.add_run().add_picture(ASSET + 'rules/datum-w166.png', width=Mm(166))

para(doc, 'Kajian Teknis · Laporan Pemahaman Data & Baseline Engineering',
     STRUCT, 7.4, SEAL, bold=True, caps=True, track=1.5, after=8, leading=11)
para(doc, 'Perluasan Perimeter Ring Terluar', STRUCT, 24, WINK, bold=True, after=0, leading=28)
para(doc, 'Arsenal Barat dan Timur', STRUCT, 24, WINK, bold=True, after=9, leading=28)
para(doc, 'Baseline engineering terverifikasi untuk 70 titik deteksi pada perimeter 6.546,2 m, '
          'Arsenal TNI Angkatan Laut, Batu Poron, Madura.', READ, 10.5, WBODY, italic=True,
     after=6, leading=15)
para(doc, 'Dasar penyusunan proposal teknis · daftar kuantitas dan harga · rencana pelaksanaan · '
          'dokumen pengadaan dan tender', STRUCT, 7.6, WMETA, after=24, leading=12)

ctrl = mktable(4, [32, 56, 26, 52])
for r_, vals in enumerate([('Nomor dokumen', DOC_ID, 'Revisi', f'{REV} · 1 Agustus 2026'),
                           ('Penyusun', 'Divisi Engineering PT GSP', 'Kustodian', 'ENG-01'),
                           ('Ditujukan kepada', 'Direktur PT Gemilang Satria Perkasa', 'Halaman', str(NPAGES)),
                           ('Datum geodetik', 'UTM Zona 49S · WGS-84 · grid 500 m', 'Verifikasi', 'V3 — lulus')]):
    for c_, v in enumerate(vals):
        cell = ctrl.cell(r_, c_); margins(cell, 1.5, 1.5, 0, 3)
        borders(cell, bottom=(4, W['rule']), **({'top': (10, W['ink'])} if r_ == 0 else {}))
        lbl = c_ % 2 == 0
        cpara(cell, v, face=STRUCT if lbl else DATA, size=6.4 if lbl else 7.4,
              colour=WMETA if lbl else WINK, bold=lbl, caps=lbl, track=0.7 if lbl else None, leading=11)

para(doc, before=12, after=0, leading=6)
cf = mktable(1, [83, 83])
for i, (txt, col, al) in enumerate([('PT GEMILANG SATRIA PERKASA · NIB 9120208940517', WMETA, WD_ALIGN_PARAGRAPH.LEFT),
                                    ('// 20260801 ID R — TERBITAN 2', SEAL, WD_ALIGN_PARAGRAPH.RIGHT)]):
    c = cf.cell(0, i); borders(c, top=(4, W['rule'])); margins(c, 1.8, 0, 0, 0)
    cpara(c, txt, face=DATA, size=6.2, colour=col, bold=(i == 1), align=al, leading=9)

doc.add_page_break()

# ══════════════════ interior section ══════════════════
sec = doc.add_section(WD_SECTION.CONTINUOUS); setup(sec)
sec.header.is_linked_to_previous = False
sec.footer.is_linked_to_previous = False
doc.sections[0].header.is_linked_to_previous = False
doc.sections[0].footer.is_linked_to_previous = False

hp = sec.header.paragraphs[0]; setp(hp, leading=9)
hp.paragraph_format.tab_stops.add_tab_stop(Mm(166), WD_TAB_ALIGNMENT.RIGHT)
run(hp, 'PT Gemilang Satria Perkasa · Divisi Engineering · Bab 5', STRUCT, 6.8, INK4, caps=True, track=0.6)
run(hp, '\t' + CLASS, STRUCT, 6.8, SEAL, bold=True, caps=True, track=0.6)
borders(hp, bottom=(4, I['ink200']))

fp = sec.footer.paragraphs[0]; setp(fp, leading=1, after=0)
ftbl = sec.footer.add_table(rows=1, cols=4, width=Mm(166)); ftbl.autofit = False
_pr = ftbl._tbl.tblPr
_b = OxmlElement('w:tblBorders')
for _s in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
    _b.append(el('w:' + _s, val='none', sz='0', space='0', color='auto'))
_pr.append(_b); _pr.append(el('w:tblLayout', type='fixed'))
_pr.append(el('w:tblW', w=str(int(166 * 56.7)), type='dxa'))
_grid = ftbl._tbl.find(qn('w:tblGrid'))
for _gc, _w in zip(_grid.findall(qn('w:gridCol')), [50, 44, 42, 30]):
    _gc.set(qn('w:w'), str(int(_w * 56.7)))
for _c, _w in zip(ftbl.rows[0].cells, [50, 44, 42, 30]):
    _c.width = Mm(_w)
    _c._tc.get_or_add_tcPr().append(el('w:tcW', w=str(int(_w * 56.7)), type='dxa'))

def _fcell(idx, right_div=True, align=WD_ALIGN_PARAGRAPH.LEFT):
    c = ftbl.cell(0, idx)
    margins(c, 1.6, 1.4, 0 if idx == 0 else 2.5, 2.5)
    borders(c, top=(8, I['ink900']), bottom=(4, I['ink200']),
            **({'right': (4, I['ink200'])} if right_div else {}))
    pp = c.paragraphs[0]; setp(pp, leading=8.4, align=align)
    return pp

NB = ' '   # non-breaking space — register separators must never collapse (Rev C)
_p = _fcell(0)
run(_p, 'GSP' + NB + '·' + NB, DATA, 6.2, INK4); run(_p, DOC_ID, DATA, 6.2, INK, bold=True)
_p = _fcell(1)
run(_p, 'REV' + NB, DATA, 6.2, INK4); run(_p, REV, DATA, 6.2, INK, bold=True)
run(_p, NB + '·' + NB + REV_DATE, DATA, 6.2, INK4)
_p = _fcell(2)
run(_p, 'LEMBAR' + NB, DATA, 6.2, INK4)
_m = run(_p, '', DATA, 6.2, INK, bold=True)
_f = OxmlElement('w:fldSimple'); _f.set(qn('w:instr'), ' PAGE ')
_rr = OxmlElement('w:r')
_rpr = OxmlElement('w:rPr')            # field run must carry the register style, or Word
_rpr.append(el('w:rFonts', ascii=DATA, hAnsi=DATA, cs=DATA))   # renders the page number
_rpr.append(el('w:b'))                 # oversized at the default face/size
_rpr.append(el('w:color', val=I['ink900'].lstrip('#')))
_rpr.append(el('w:sz', val='12')); _rpr.append(el('w:szCs', val='12'))   # 6 pt half-points
_rr.append(_rpr); _f.append(_rr); _m._element.addnext(_f)
run(_p, NB + 'DARI' + NB + '%d' % NPAGES, DATA, 6.2, INK4)
_p = _fcell(3, right_div=False, align=WD_ALIGN_PARAGRAPH.RIGHT)
run(_p, CLASS, DATA, 6.2, SEAL, bold=True)

# ─────────────── body components ───────────────
def block(text, mark, glyph, colour, rails, note=None, revbar=False):
    t = mktable(1, [128, 38])
    tc, rc = t.cell(0, 0), t.cell(0, 1)
    margins(tc, 0, 0, 0, 6); margins(rc, 0, 0, 0, 0)
    cpara(tc, text, align=WD_ALIGN_PARAGRAPH.JUSTIFY, leading=13.5)
    cpara(rc, f'{glyph} {mark}', face=DATA, size=5.9, colour=colour, bold=True, caps=True, leading=8.4)
    for l in rails: para(rc, l, DATA, 5.9, INK4, caps=True, leading=8.4)
    if note: para(rc, note, STRUCT, 6.2, INK4, before=1.5, leading=8.4)
    if revbar:
        for pp in rc.paragraphs: borders(pp, right=(8, I['ink900']))

def h1(kicker, title):
    para(doc, kicker, STRUCT, 6.8, SIG, bold=True, caps=True, track=1.4, after=4, leading=9, k=True)
    p = doc.add_paragraph(); setp(p, after=4, leading=None, k=True)
    p.add_run().add_picture(ASSET + 'rules/datum-128.png', width=Mm(128))
    para(doc, title, STRUCT, 16, INK, bold=True, after=7, leading=20, k=True)

def h2(num, title):
    p = para(doc, before=13.5, after=4, leading=13.5, k=True)
    run(p, num + '   ', DATA, 8, INK4); run(p, title, STRUCT, 11, INK, bold=True)

def h3(title): para(doc, title, STRUCT, 9.5, INK, bold=True, before=9, after=1, leading=13.5, k=True)

def derivation(label, lines, note):
    t = mktable(1, [128]); c = t.cell(0, 0)
    margins(c, 2.6, 2.6, 4.5, 0); borders(c, left=(10, I['signal']))
    cpara(c, label, face=STRUCT, size=6.6, colour=SIG, bold=True, caps=True, track=1.1, leading=9, after=2)
    for l in lines: para(c, l, DATA, 7.4, INK, leading=11.5)
    para(c, note, STRUCT, 7, INK4, before=2, leading=10)
    para(doc, after=0, leading=5)

def figure(fid, caption, png, width_mm=128, source='', provenance=''):
    """Place a DATUM drawing with its full apparatus: caption above, artwork, SUMBER below.

    Build the artwork with scripts/datum_diagram.py, rasterise with scripts/datum_render.py
    at 300 dpi, then hand the PNG here at the same millimetre width the SVG declares.

    The one non-obvious thing this does is release line spacing on the picture paragraph.
    DATUM's Normal style sets an EXACT 13,5 pt leading — correct for prose, and it silently
    crops an inline picture to a single baseline, so a 200 mm figure arrives as a 4,8 mm
    strip. Word gives no warning. Every caller that placed a figure by hand hit this, which
    is why it is a helper rather than a note in the reference.
    """
    p = para(doc, before=6, after=2.4, leading=11, k=True)
    run(p, fid + '   ', STRUCT, 7, INK, bold=True, caps=True, track=0.8)
    run(p, caption, STRUCT, 7.6, INK7)

    pic = doc.add_paragraph()
    setp(pic, after=2.4, leading=None, k=bool(source or provenance))
    pic.add_run().add_picture(png, width=Mm(width_mm))

    if source or provenance:
        sp = para(doc, before=0, after=0, leading=9)
        borders(sp, top=(4, I['ink200']))
        run(sp, 'SUMBER  ', STRUCT, 6.6, INK4, bold=True, track=0.6)
        if source:
            run(sp, source, STRUCT, 6.6, INK4)
        if provenance:
            run(sp, '   PROVENANS ', STRUCT, 6.6, INK4, bold=True, track=0.6)
            run(sp, provenance, STRUCT, 6.6, INK4)
    para(doc, after=0, leading=5)


def datatable(tid, caption, head, widths, rows, total=None, source=''):
    p = para(doc, before=6, after=2.4, leading=11, k=True)
    run(p, tid + '   ', STRUCT, 7, INK, bold=True, caps=True, track=0.8)
    run(p, caption, STRUCT, 7.6, INK7)
    n = len(rows) + 1 + (1 if total else 0) + 1
    ncol = len(head)
    t = mktable(n, widths)
    t.rows[0]._tr.get_or_add_trPr().append(el('w:tblHeader', val='1'))
    for i, (label, al) in enumerate(head):
        c = t.cell(0, i); margins(c, 1.8, 1.8, 0, 2.5)
        borders(c, top=(10, I['ink900']), bottom=(5, I['ink400']))
        cpara(c, label, face=STRUCT, size=6.8, colour=INK4, bold=True, caps=True, track=0.6, leading=9,
              align=WD_ALIGN_PARAGRAPH.RIGHT if al == 'r' else WD_ALIGN_PARAGRAPH.LEFT)
    for ri, row in enumerate(rows, start=1):
        if row[0] == '§':
            c = t.cell(ri, 0).merge(t.cell(ri, ncol - 1))
            margins(c, 3.4, 1.2, 0, 0); borders(c, bottom=(4, I['ink200']))
            cpara(c, row[1], face=STRUCT, size=7.4, colour=INK, bold=True, caps=True, track=0.7, leading=10)
            continue
        for i, v in enumerate(row):
            c = t.cell(ri, i); margins(c, 1.6, 1.6, 0, 2.5); borders(c, bottom=(4, I['ink200']))
            al = head[i][1]
            cpara(c, v,
                  face=DATA if al == 'r' or i == 0 else READ,
                  size=7.8 if al == 'r' else (7 if i == 0 else 8.2),
                  colour=INK if al == 'r' else (INK4 if i == 0 else INK7), leading=11.5,
                  align=WD_ALIGN_PARAGRAPH.RIGHT if al == 'r' else WD_ALIGN_PARAGRAPH.LEFT)
    if total:
        ri = n - 2
        lab = t.cell(ri, 0).merge(t.cell(ri, ncol - 2))
        margins(lab, 2.0, 1.6, 0, 2.5); borders(lab, top=(10, I['ink900']))
        cpara(lab, total[0], face=STRUCT, size=8.4, colour=INK, bold=True, leading=11.5)
        val = t.cell(ri, ncol - 1); margins(val, 2.0, 1.6, 0, 2.5); borders(val, top=(10, I['ink900']))
        cpara(val, total[1], face=DATA, size=8.4, colour=INK, bold=True, leading=11.5,
              align=WD_ALIGN_PARAGRAPH.RIGHT)
    src = t.cell(n - 1, 0).merge(t.cell(n - 1, ncol - 1))
    margins(src, 1.8, 0, 0, 0); borders(src, top=(4, I['ink200']))
    sp = cpara(src, leading=9)
    run(sp, 'SUMBER  ', STRUCT, 6.6, INK4, bold=True, track=0.6)
    run(sp, source, STRUCT, 6.6, INK4)
    para(doc, after=0, leading=5)

# ─────────────── BAB 5 ───────────────
h1('Bab 5', 'Baseline Kuantitas Terverifikasi')
h2('5.1', 'Dasar geodetik dan konsekuensi kuantitasnya')
block('Seluruh kuantitas pada bab ini diturunkan dari satu sumber tunggal: register koordinat 70 titik '
      'kamera yang diekstraksi dari Peta 001–014 dan diverifikasi silang terhadap survei lapangan '
      '16–21 Agustus 2021. Jarak antartitik dihitung dengan rumus haversine pada datum WGS-84, bukan '
      'diukur dari skala gambar, sehingga panjang perimeter yang dilaporkan tidak bergantung pada '
      'ketelitian cetak lembar peta.',
      'TERUKUR', '■', INK, ['SRC 001–014/LBR 1–14', 'SRV 16–21·VIII·2021', 'KEANDALAN [A1]'],
      'Register geodetik lengkap pada Lampiran A.')
para(doc, after=0, leading=6.75)
block('Konsekuensinya dapat diaudit. Panjang perimeter menentukan panjang galian; galian menentukan '
      'kebutuhan serat optik dan kabel kelistrikan; kabel kelistrikan bersama beban puncak menentukan '
      'kapasitas catu daya. Satu koreksi pada register koordinat merambat ke seluruh rantai tersebut.',
      'DITURUNKAN', '◈', SIG, ['REQ-IDS-07', 'REV B'],
      'Kuantitas dikalibrasi ulang pada Rev B.', revbar=True)

derivation('Turunan D-5.1 · Spasi nominal antartitik', [
    'Perimeter terukur          6.546,2  m     [TERUKUR]',
    'Titik deteksi                   70  titik [TERUKUR]',
    '                          ─────────────────',
    'Spasi nominal   6.546,2 ÷ 70 =  93,5  m',
    'Spasi median terukur            97,7  m',
    'Selisih terhadap nominal       + 4,5  %   dalam toleransi ± 8 %'],
    'Toleransi ± 8 % adalah batas rancangan GSP, bukan interval keyakinan statistik. Selisih timbul '
    'dari 6 segmen pesisir tanpa tiang; jarak diserap segmen daratan. Tidak ada celah cakupan.')

h2('5.2', 'Kuantitas pekerjaan sipil dan kelistrikan, sisi Timur')
datatable('Tabel 5.2',
          'Daftar kuantitas Bab I, Intrusion Detection System Arsenal Timur (B1–B35), per register '
          'koordinat Rev B, 31 Juli 2026.',
          [('No', 'l'), ('Uraian pekerjaan', 'l'), ('Volume', 'r'), ('Satuan', 'l'),
           ('Harga satuan', 'r'), ('Jumlah', 'r')],
          [9, 62, 19, 13, 26, 37],
          [['§', 'A · Pekerjaan sipil & struktur'],
           ['1', 'Galian jalur kabel 0,30 m × 0,60 m termasuk urugan pasir dan pemadatan kembali',
            '3.538,8', 'm′', '128.000', '452.966.400'],
           ['2', 'Tapak/pondasi kamera beton K-250 termasuk angkur dan stub', '35', 'titik',
            '2.400.000', '84.000.000'],
           ['3', 'Tiang kamera oktagonal 5 m, galvanis celup panas 85 µm', '35', 'set',
            '9.600.000', '336.000.000'],
           ['§', 'B · Pekerjaan kelistrikan & proteksi'],
           ['4', 'Kabel NYFGBY 4 × 10 mm², distribusi utama perimeter', '3.707,4', 'm',
            '155.000', '574.647.000'],
           ['5', 'Kabel NYFGBY 4 × 2,5 mm², sambungan titik', '962,5', 'm', '80.000', '77.000.000']],
          ('Subtotal kelompok A + B, Arsenal Timur, sebelum PPN', '1.524.613.400'),
          'Register koordinat Rev B · Peta 001–014 · AHS 008/GSP/RAB/VIII/2026, disusun menurut '
          'Permen PUPR No. 8 Tahun 2023.     PROVENANS  volume [DITURUNKAN] · harga satuan [PEMASOK, '
          '3 kutipan, median diambil, keandalan B2].     PPN 11 % diperhitungkan pada lembar '
          'REKAPITULASI, tidak pada harga satuan.')

# ─────────────── BAB 7 ───────────────
h1('Bab 7', 'Beban Puncak dan Penampang Penghantar')
h2('7.3', 'Beban puncak sistem')
block('Beban puncak dihitung pada kondisi terburuk, yaitu pemanas lensa aktif, iluminator inframerah '
      'penuh, dan pemanas kabinet aktif serentak, dikalikan jumlah titik, ditambah beban perangkat '
      'jaringan pada setiap simpul agregasi. Faktor keserempakan tidak diterapkan, karena kondisi '
      'terburuk pada objek pesisir Madura adalah malam hari musim hujan ketika seluruh beban tersebut '
      'memang aktif serentak.',
      'DITURUNKAN', '◈', SIG, ['REQ-PWR-02'], 'Faktor keserempakan sengaja tidak diterapkan.')

derivation('Turunan D-7.3a · Beban puncak agregat', [
    'Kamera + pemanas lensa      70 × 32,0 W  =  2.240,0  W  [PEMASOK B2]',
    'Iluminator IR               70 × 28,0 W  =  1.960,0  W  [PEMASOK B2]',
    'Pemanas kabinet             70 × 18,0 W  =  1.260,0  W  [PEMASOK B2]',
    'Sakelar agregasi PoE         7 × 95,0 W  =    665,0  W  [PEMASOK B2]',
    'Radio backhaul               7 × 24,0 W  =    168,0  W  [PEMASOK C3]',
    '                                          ───────────',
    'Beban puncak                                 6.293,0  W',
    'Daya semu   6.293 ÷ cos φ 0,85            =  7.403,5  VA  =  7,40 kVA',
    'Kapasitas terpasang  7,40 × 1,25 headroom =  9,25 kVA  →  pilih 10 kVA'],
    'Konsumsi per perangkat diambil dari lembar data pemasok pada kondisi nominal 24 V; belum ada '
    'pengukuran lapangan. Ditandai [PEMASOK] dengan derajat keandalan Admiralty dan wajib diverifikasi '
    'pada uji terima pabrik.')

derivation('Turunan D-7.3b · Susut tegangan pada segmen terjauh', [
    'Segmen terpanjang B22 → panel Timur          412,0  m    [TERUKUR]',
    'Arus segmen (8 titik × 78 W ÷ 230 V)           2,71  A',
    'Penghantar NYFGBY 4 × 10 mm², ρ 0,0175 Ω·mm²/m',
    'Susut  ΔV = 2 × ρ × L × I ÷ A',
    '          = 2 × 0,0175 × 412,0 × 2,71 ÷ 10   =  3,91  V',
    'Susut relatif  3,91 ÷ 230                    =  1,70  %   batas 3 % — memenuhi'],
    'Pada penampang 4 mm² susut menjadi 4,25 % dan tidak memenuhi SNI 0225:2020 (PUIL) pasal 525. '
    'Pemilihan 10 mm² karena itu bersifat mengikat, bukan cadangan.')

h3('Register asumsi yang mengikat pasal ini')
datatable('Tabel 7.3', 'Asumsi yang mengikat perhitungan beban dan penghantar, per 1 Agustus 2026.',
          [('ID', 'l'), ('Asumsi', 'l'), ('Dampak bila salah', 'l'), ('Verifikasi', 'l')],
          [26, 54, 46, 40][:4] if False else [26, 52, 48, 40],
          [['ASM-PWR-01', 'cos φ terpasang 0,85', 'Kapasitas kVA naik ≈ 9 % pada 0,78', 'Uji terima pabrik'],
           ['ASM-PWR-02', 'Pemanas kabinet aktif serentak', 'Konservatif, tidak menaikkan risiko', 'Tidak perlu'],
           ['ASM-PWR-03', 'Tegangan jaringan PLN stabil (230 ± 12) V',
            'Susut melebihi batas pada 218 V', 'Perekaman 7 hari']],
          None,
          'Lembar data pemasok (3 kutipan) · register koordinat Rev B · SNI 0225:2020 (PUIL) pasal 525.     '
          'Notasi ± menyatakan toleransi rancangan, bukan ketidakpastian pengukuran.')

doc.save(os.path.join(OUT, '_raw.docx'))
import embed_fonts
embed_fonts.embed(os.path.join(OUT, '_raw.docx'), os.path.join(OUT, 'GSP DATUM Contoh Laporan Teknis.docx'), embed_fonts.PLEX)
print('docx ok (fonts embedded)')
