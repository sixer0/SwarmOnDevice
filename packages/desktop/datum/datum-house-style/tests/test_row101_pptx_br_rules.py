#!/usr/bin/env python3
"""Row 101 · unit tests for the Rev A briefing rules on decks built by scripts/datum_pptx.py.

One test per file-testable BR rule (27, research/13_rev_a_briefing_rules.md §2.6), asserted
with python-pptx on the Kasus 03 Rev A decks (ID light, ID dark, EN light), plus the 14
single-rule negative variants N01..N14 of isi.json (each must fail its own rule and no other).

    python3 -I -B tests/test_row101_pptx_br_rules.py

Inputs (read only): DATUM_UJI_ISI = Kasus 03 Rev A isi.json, DATUM_UJI_GAMBAR = the Figure 4.1
PNG rendered by the Studio engine. Both default to the 1.2.0 task folder; the tests skip when
the material is absent. Outputs go to DATUM_UJI_KELUAR or a temporary folder.

Interpretations (row 75 §4 and decisions C21): D1 closing rows by deck language (ID 4, EN 3);
D3 head rule seal on the light master; D4 white logo on the dark deck; D5 transitions count as
animation; D6 one accent = one accent colour per slide; D7 ink100 / panel allowed on screen;
D8 zone tolerance 0.5 mm. Classification words on the title-slide seal band (pita) are read as
the seal band of Tab 8.1 (light text on seal), not as classification runs for BR-07.
"""
import copy
import hashlib
import json
import os
import re
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(SKILL, 'scripts'))

import datum_pptx as DP                       # noqa: E402
from pptx import Presentation                 # noqa: E402
from pptx.util import Mm                      # noqa: E402

TASK = os.path.normpath(os.path.join(SKILL, *(['..'] * 5), 'docs',
                                     '2026-11-06_swarm_1_2_0_datum_installer'))
ISI = os.environ.get('DATUM_UJI_ISI') or os.path.join(
    TASK, 'test', 'material_rev_a_v2', 'Kasus 03 Brief', 'isi.json')
GAMBAR = os.environ.get('DATUM_UJI_GAMBAR') or os.path.join(
    TASK, 'test', 'original_ref_v2', '04', '4.1 Arsitektur sistem pemantauan iklim ruang simpan arsip.png')
HAVE_MATERIAL = os.path.isfile(ISI) and os.path.isfile(GAMBAR)

TOL = Mm(0.5)
CLASS_WORDS = ('SANGAT RAHASIA', 'RAHASIA', 'TERBATAS', 'BIASA')
A_NS = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
NUM = re.compile(r'\d+(?:[.,]\d+)*')
LIGHT_FIXED = {'FCFCFB', 'FBFAF7', '101418', '2B3640', '6B7783', 'C3CBD1', 'EFF2F4', '6E1420',
               'F4F5F6'}
DARK_TOKENS = {'0E1216', 'F2F4F5', 'AEB8C0', 'D98324', '7C8894', '232B33'}       # BR-11
DARK_FIXED = DARK_TOKENS - {'D98324'} | {'161C22', 'D9756A', '6E1420', 'F4F5F6'}


def sha1(path_or_bytes):
    if isinstance(path_or_bytes, bytes):
        return hashlib.sha1(path_or_bytes).hexdigest()
    with open(path_or_bytes, 'rb') as fh:
        return hashlib.sha1(fh.read()).hexdigest()


LOGO = {n: sha1(os.path.join(SKILL, 'assets', 'logo', n))
        for n in os.listdir(os.path.join(SKILL, 'assets', 'logo')) if n.endswith('.png')}


# ───────────────────────── reading a deck ─────────────────────────
class Deck:
    """A built .pptx plus the context its rules need."""

    def __init__(self, path, edisi, gelap):
        self.path, self.edisi, self.gelap = path, edisi, gelap
        self.prs = Presentation(path)
        self.SW, self.SH = self.prs.slide_width, self.prs.slide_height
        self.zip = zipfile.ZipFile(path)
        self.slides = list(self.prs.slides)

    @staticmethod
    def named(sl, prefix):
        return [s for s in sl.shapes if s.name == prefix or s.name.startswith(prefix + '-')]

    @staticmethod
    def text(shape):
        if getattr(shape, 'has_table', False):
            return '\n'.join(c.text for r in shape.table.rows for c in r.cells)
        return shape.text_frame.text if shape.has_text_frame else ''

    @staticmethod
    def runs(shape):
        if getattr(shape, 'has_table', False):
            for r in shape.table.rows:
                for c in r.cells:
                    for p in c.text_frame.paragraphs:
                        yield from p.runs
        elif shape.has_text_frame:
            for p in shape.text_frame.paragraphs:
                yield from p.runs

    def body_shapes(self, sl):
        return [s for s in sl.shapes if s.name.startswith('isi-')]

    def body_text(self, sl):
        return '\n'.join(self.text(s) for s in self.body_shapes(sl))

    def numbered_text(self, sl):
        """Headline + body text (the slide's numbers in BR-27 / BR-33)."""
        parts = [self.text(s) for s in sl.shapes if s.name in ('judul', 'judul-sampul')]
        parts.append(self.body_text(sl))
        for gf in self.named(sl, 'isi-grafik'):
            parts += [str(c) for c in gf.chart.plots[0].categories]
        return '\n'.join(parts)

    def notes(self, sl):
        return sl.notes_slide.notes_text_frame.text if sl.has_notes_slide else ''

    def slide_xml(self, i):
        sl = self.slides[i]
        xml = sl.part.blob.decode('utf8')
        for rel in sl.part.rels.values():
            if rel.reltype.endswith('/chart'):
                xml += rel.target_part.blob.decode('utf8')
        return xml

    def colours(self, i):
        return {c.upper() for c in re.findall(r'srgbClr val="([0-9A-Fa-f]{6})"', self.slide_xml(i))}

    def ground(self, sl):
        m = re.search(r'<p:bg>.*?srgbClr val="([0-9A-Fa-f]{6})"', sl.part.blob.decode('utf8'), re.S)
        return m.group(1).upper() if m else None


def near(a, b):
    return abs(int(a) - int(b)) <= TOL


def rgb(run):
    try:
        return str(run.font.color.rgb).upper()
    except Exception:
        return None


def close_hex(a, b, d=3):
    return a is not None and all(abs(int(a[i:i + 2], 16) - int(b[i:i + 2], 16)) <= d for i in (0, 2, 4))


# ───────────────────────── the 27 rule checks ─────────────────────────
# Each returns a list of failure strings (empty = pass). APPLIES says which decks a rule covers.
def br02(d):
    f = []
    if abs(d.SW - Mm(338.7)) > Mm(0.1):
        f.append(f'width {d.SW / 36000:.2f} mm')
    if d.SH != 6858000:
        f.append(f'height {d.SH} EMU')
    return f


def br03(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        for s in sl.shapes:
            if s.name == 'pita':
                continue
            if s.left < Mm(18) - TOL or s.left + s.width > d.SW - Mm(18) + TOL:
                f.append(f'slide {n} {s.name}: outside 18 mm margin')
            if s.top < Mm(11) - TOL or s.top > d.SH - Mm(12) + TOL:
                f.append(f'slide {n} {s.name}: above head or below foot')
    return f


def br04(d):
    f = []
    want = {'kepala': Mm(11), 'kicker': Mm(23), 'judul': Mm(31), 'sumber': d.SH - Mm(24),
            'kaki-kiri': d.SH - Mm(12), 'kaki-kanan': d.SH - Mm(12)}
    for n, sl in enumerate(d.slides, 1):
        names = {s.name for s in sl.shapes}
        for need in ('kepala-kiri', 'kepala-kanan', 'kicker', 'kaki-kiri', 'kaki-kanan'):
            if need not in names:
                f.append(f'slide {n}: no {need}')
        if not names & {'judul', 'judul-sampul'}:
            f.append(f'slide {n}: no headline')
        for s in sl.shapes:
            key = ('kepala' if s.name.startswith('kepala-') else
                   'judul' if s.name in ('judul', 'judul-sampul') else s.name)
            if key in want and not near(s.top, want[key]):
                f.append(f'slide {n} {s.name}: top {s.top / 36000:.1f} mm')
            if s.name.startswith('isi-') and s.top < Mm(42) - TOL:
                f.append(f'slide {n} {s.name}: body above 42 mm')
            if s.name == 'kicker' and any(r.font.size is None or r.font.size.pt != 8 for r in d.runs(s)):
                f.append(f'slide {n}: kicker not 8 pt')
            if s.name in ('judul', 'judul-sampul') and any(
                    r.font.size is None or r.font.size.pt != 26 for r in d.runs(s)):
                f.append(f'slide {n}: headline not 26 pt')
        f += body_start(d, n, sl)
    return f


def body_start(d, n, sl):
    """C50: the body starts at y 42 under a one-line headline, directly under a wrapped one.
    Line count from the headline box (lines x 31 pt), cross-checked with the builder's wrap
    estimate; the first body shape must sit on that line, not lower."""
    f = []
    heads = [s for s in sl.shapes if s.name in ('judul', 'judul-sampul')]
    body = [s.top for s in sl.shapes if s.name.startswith('isi-')]
    if not heads or not body:
        return f
    h = heads[0]
    lines = round(h.height / DP.HEADLINE_PITCH)
    if h.name == 'judul':
        est = DP.line_count(d.text(h), h.width)
    else:
        est = sum(DP.line_count(p.text, h.width) for p in h.text_frame.paragraphs if p.text)
    if lines != est:
        f.append(f'slide {n}: headline box {lines} lines, text wraps to {est}')
    want = max(Mm(42), Mm(31) + DP.HEADLINE_PITCH * est)
    if not near(min(body), want):
        f.append(f'slide {n}: body starts at {min(body) / 36000:.1f} mm, '
                 f'want {want / 36000:.1f} mm ({est}-line headline)')
    return f


def br05(d):
    return [f'slide {n}: ground {d.ground(sl)}' for n, sl in enumerate(d.slides, 1)
            if d.ground(sl) not in ('FCFCFB', 'FBFAF7')]


def br06(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        dark = d.ground(sl) == '0E1216' or '0E1216' in d.colours(n - 1)
        if not d.gelap and dark:
            f.append(f'slide {n}: dark ground #0E1216 without DATUM_BRIEF=gelap')
        if d.gelap and d.ground(sl) != '0E1216':
            f.append(f'slide {n}: DATUM_BRIEF=gelap but ground {d.ground(sl)}')
    return f


def class_runs(d, sl):
    for s in sl.shapes:
        if s.name == 'pita':
            continue
        for r in d.runs(s):
            if any(w in r.text.upper() for w in CLASS_WORDS):
                yield s, r


def br07(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        for s, r in class_runs(d, sl):
            if not close_hex(rgb(r), '6E1420') or r.font.bold is not True:
                f.append(f'slide {n} {s.name}: classification {rgb(r)} bold={r.font.bold}')
        for s in sl.shapes:
            for r in d.runs(s):
                if rgb(r) == '9B1C1C':
                    f.append(f'slide {n} {s.name}: run in alert #9B1C1C')
    return f


def br08(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        ok = [s for s in d.named(sl, 'kepala-kanan')
              if near(s.top, Mm(11)) and s.left >= d.SW // 2 - TOL
              and any(any(w in r.text.upper() for w in CLASS_WORDS) for r in d.runs(s))]
        if not ok:
            f.append(f'slide {n}: no classification at the right of the running head')
    return f


def br09(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        rules = [s for s in sl.shapes if s.name == 'garis-kepala']
        if not rules or str(rules[0].fill.fore_color.rgb).upper() != '6E1420':
            f.append(f'slide {n}: head rule not seal')
    return f


def br10(d):
    f = []
    band = [s for s in d.slides[0].shapes if s.name == 'pita']
    if not band or str(band[0].fill.fore_color.rgb).upper() != '6E1420':
        f.append('slide 1: title band not #6E1420')
    for n, sl in enumerate(d.slides, 1):
        for s in d.named(sl, 'kepala-kanan'):
            for r in d.runs(s):
                if any(w in r.text.upper() for w in CLASS_WORDS) and rgb(r) != 'D9756A':
                    f.append(f'slide {n}: head classification {rgb(r)}')
    return f


def br11(d):
    f = []
    role = {'judul': 'F2F4F5', 'judul-sampul': 'F2F4F5', 'isi-uraian': 'AEB8C0',
            'isi-pengantar': 'AEB8C0', 'isi-butir': 'AEB8C0', 'kicker': 'D98324',
            'kepala-kiri': '7C8894', 'sumber': '7C8894', 'kaki-kiri': '7C8894', 'kaki-kanan': '7C8894'}
    for n, sl in enumerate(d.slides, 1):
        if d.ground(sl) != '0E1216':
            f.append(f'slide {n}: ground {d.ground(sl)}')
        extra = d.colours(n - 1) - DARK_TOKENS - DARK_FIXED
        if extra:
            f.append(f'slide {n}: colours outside the dark tokens {sorted(extra)}')
        for s in sl.shapes:
            if s.name in role:
                bad = {rgb(r) for r in d.runs(s)} - {role[s.name]}
                if bad:
                    f.append(f'slide {n} {s.name}: {sorted(map(str, bad))} not {role[s.name]}')
            if s.name in ('garis-kepala', 'garis-kaki') and str(s.fill.fore_color.rgb).upper() != '232B33':
                f.append(f'slide {n} {s.name}: hairline not #232B33')
    return f


def br12(d):
    return [f'slide {n}: kicker {rgb(r)}' for n, sl in enumerate(d.slides, 1)
            for s in d.named(sl, 'kicker') for r in d.runs(s) if rgb(r) != 'B45309']


def pictures(d):
    for n, sl in enumerate(d.slides, 1):
        for s in sl.shapes:
            if s.shape_type == 13:                                   # MSO_SHAPE_TYPE.PICTURE
                yield n, s, sha1(s.image.blob)


def logo_file(d):
    """Dark: white (C21 D4). EN light: black ink (EN p51). ID light: seal maroon (ID p48, C46-2)."""
    return 'gsp-putih.png' if d.gelap else ('gsp-tinta.png' if d.edisi == 'en' else 'gsp-seal.png')


def br13(d):
    f, logos = [], [(n, h) for n, s, h in pictures(d) if h in LOGO.values()]
    want = LOGO[logo_file(d)]
    if [n for n, _ in logos] != [1]:
        f.append(f'logo on slides {[n for n, _ in logos]} (title slide only, once)')
    if any(h != want for _, h in logos):
        f.append(f'logo is not {logo_file(d)}')
    return f


def br14(d):
    folder = os.path.join(os.path.dirname(d.path), DP.FONT_FOLDER_NAME)
    need = [x for x in os.listdir(DP.FONT_DIR) if x.endswith('.ttf')] + ['LICENSE-DejaVu.txt']
    missing = [x for x in need if not os.path.isfile(os.path.join(folder, x))]
    return [f'font folder missing {missing}'] if missing else []


GLYPH_RE = re.compile('[■◈◇△]')


def all_runs(d):
    """Every text run of the deck, slides and speaker notes: (where, run)."""
    for n, sl in enumerate(d.slides, 1):
        for s in sl.shapes:
            for r in d.runs(s):
                yield f'slide {n} {s.name}', r
        if sl.has_notes_slide:
            for p in sl.notes_slide.notes_text_frame.paragraphs:
                for r in p.runs:
                    yield f'slide {n} notes', r


def glyph_font(d):
    """C44a: provenance glyphs ■ ◈ ◇ △ sit in their own runs set in DejaVu Sans (Rev A 8.5,
    ID p49 / EN p51; Annex A.2, ID p89 / EN p91); no Plex run carries a glyph."""
    f, seen = [], 0
    for where, r in all_runs(d):
        if not GLYPH_RE.search(r.text):
            continue
        seen += 1
        if (r.font.name or '').startswith('IBM Plex'):
            f.append(f'{where}: glyph in a Plex run {r.text[:30]!r}')
        elif r.font.name != DP.GLYPH_FACE or GLYPH_RE.sub('', r.text):
            f.append(f'{where}: glyph run {r.text[:30]!r} in {r.font.name}')
    if not seen:
        f.append('no provenance glyph found')
    return f


def br15(d):
    f = []
    names = set()
    for _, r in all_runs(d):
        glyph_only = r.text and not GLYPH_RE.sub('', r.text)
        if not (glyph_only and r.font.name == DP.GLYPH_FACE):    # C44a glyph face allowed
            names.add(r.font.name)
    bad = sorted(str(x) for x in names if not (x or '').startswith('IBM Plex'))
    if bad:
        f.append(f'run fonts {bad}')
    for name in d.zip.namelist():
        if re.search(r'ppt/(theme|charts)/.*\.xml$', name):
            faces = set(re.findall(r'typeface="([^"]*)"', d.zip.read(name).decode('utf8')))
            bad = sorted(x for x in faces if x and not x.startswith('IBM Plex') and not x.startswith('+'))
            if bad:
                f.append(f'{name}: typefaces {bad}')
    return f


def closing_rows(d):
    last = d.slides[-1]
    v = d.named(last, 'isi-angka-nilai')
    return len([p for p in v[0].text_frame.paragraphs if p.runs]) if v else 0


def br17(d):
    want = 3 if d.edisi == 'en' else 4
    got = closing_rows(d)
    return [] if got == want else [f'closing number block {got} rows, edition {d.edisi} wants {want}']


def br18(d):
    t = '\n'.join(d.text(s) for s in d.slides[-1].shapes).lower()
    return [f'last slide closes with {w!r}' for w in ('terima kasih', 'thank you') if w in t]


def br19(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        w = len(d.body_text(sl).split())
        if w > 55:
            f.append(f'slide {n}: {w} body words')
    return f


def br20(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        b = sum(1 for s in sl.shapes if s.has_text_frame for p in s.text_frame.paragraphs
                if p._p.pPr is not None and p._p.pPr.find(A_NS + 'buChar') is not None)
        if b > 5:
            f.append(f'slide {n}: {b} bullets')
    return f


def br21(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        for s in d.named(sl, 'isi-angka-nilai'):
            k = len([p for p in s.text_frame.paragraphs if p.runs])
            if k > 6:
                f.append(f'slide {n}: number block {k} rows')
        for s in sl.shapes:
            if getattr(s, 'has_table', False) and len(s.table.rows) > 6:
                f.append(f'slide {n}: table {len(s.table.rows)} rows')
    return f


def br22(d):
    fixed = DARK_FIXED if d.gelap else LIGHT_FIXED
    f = []
    for i in range(len(d.slides)):
        acc = d.colours(i) - fixed
        if len(acc) > 1:
            f.append(f'slide {i + 1}: {len(acc)} accent colours {sorted(acc)}')
    return f


def br23(d):
    return [f'slide {i + 1}: animation or transition' for i, sl in enumerate(d.slides)
            if re.search(r'<p:(timing|transition)\b', sl.part.blob.decode('utf8'))]


def br24(d):
    return [f'{n}: gradFill' for n in d.zip.namelist()
            if n.endswith('.xml') and b'gradFill' in d.zip.read(n)]


def br25(d):
    allowed = {LOGO[logo_file(d)], sha1(GAMBAR)}
    return [f'slide {n} {s.name}: picture not allowed (stock?)' for n, s, h in pictures(d)
            if h not in allowed]


def br27(d):
    word = 'SOURCE' if d.edisi == 'en' else 'SUMBER'
    f = []
    for n, sl in enumerate(d.slides, 1):
        if re.search(r'\d', d.numbered_text(sl)):
            src = [s for s in sl.shapes if s.name == 'sumber' and d.text(s).strip().startswith(word)
                   and near(s.top, d.SH - Mm(24))]
            if not src:
                f.append(f'slide {n}: numbers without a {word} line')
    return f


def sentence_case(h):
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", h)
    if not words or not h[0].isupper():
        return False
    caps = [w for w in words[1:] if w[0].isupper() and not re.search(r'[A-Z].*[A-Z]', w)]
    return len(caps) <= max(1, len(words) // 4)


def br28(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        for s in sl.shapes:
            if s.name != 'judul':
                continue
            h = d.text(s).strip()
            if len(h) > 90:
                f.append(f'slide {n}: headline {len(h)} characters')
            if not h.endswith('.'):
                f.append(f'slide {n}: headline without a full stop')
            if not sentence_case(h):
                f.append(f'slide {n}: headline not in sentence case')
    return f


def br32(d):
    pat = re.compile(r'(?<![\w-])\d{3}/GSP/DEK/[IVX]+/\d{4}(?![\w/])')
    return [f'slide {n}: foot document id not nnn/GSP/DEK/<month>/<year>'
            for n, sl in enumerate(d.slides, 1)
            if not any(pat.search(d.text(s)) for s in d.named(sl, 'kaki-kiri'))]


def br33(d):
    f = []
    for n, sl in enumerate(d.slides, 1):
        nums = set(NUM.findall(d.numbered_text(sl)))
        if not nums:
            continue
        notes = d.notes(sl)
        if not notes.strip():
            f.append(f'slide {n}: numbers but no speaker notes')
            continue
        miss = sorted(x for x in nums
                      if not re.search(r'(?<![\d.,])' + re.escape(x) + r'(?![\d]|[.,]\d)', notes))
        if miss:
            f.append(f'slide {n}: numbers not in the notes {miss}')
    return f


def eg22(d):
    """EN only (EG-22, EN p24; kept under BR-37): every abbreviation expanded at first use."""
    stop = {'TERBATAS', 'SOURCE', 'PROVENANCE', 'MEASURED', 'DERIVED', 'VENDOR', 'ASSUMED', 'REV',
            'ID', 'EN', 'ISSUE', 'IDR', 'VA', 'kVA', 'Ah', 'Cat', 'GSP'}
    order = []
    for sl in d.slides:
        for s in sl.shapes:
            if s.name in ('judul', 'sumber') or s.name.startswith('isi-'):
                order.append(d.text(s))
            if s.name == 'isi-grafik':
                order += [str(c) for c in s.chart.plots[0].categories]
    text = re.sub(r'\d{3}/GSP/[A-Z]+/[IVX]+/\d{4}|ASM-[A-Z]+-\d+|REQ-[A-Z]+-\d+|PMK|D-5\.1', ' ',
                  ' | '.join(order))
    seen, bad = set(), []
    for m in re.finditer(r'\b[A-Z][A-Za-z]*[A-Z](?:-\d+)?\b', text):
        a = m.group(0)
        if a in stop or a in seen:
            continue
        seen.add(a)
        if text[m.start() - 1] != '(':
            bad.append(a)
    return [f'abbreviation not expanded at first use: {bad}'] if bad else []


RULES = {'BR-02': br02, 'BR-03': br03, 'BR-04': br04, 'BR-05': br05, 'BR-06': br06,
         'BR-07': br07, 'BR-08': br08, 'BR-09': br09, 'BR-10': br10, 'BR-11': br11,
         'BR-12': br12, 'BR-13': br13, 'BR-14': br14, 'BR-15': br15, 'BR-17': br17,
         'BR-18': br18, 'BR-19': br19, 'BR-20': br20, 'BR-21': br21, 'BR-22': br22,
         'BR-23': br23, 'BR-24': br24, 'BR-25': br25, 'BR-27': br27, 'BR-28': br28,
         'BR-32': br32, 'BR-33': br33, 'EG-22': eg22}
LIGHT_ONLY = {'BR-05', 'BR-07', 'BR-09', 'BR-12'}
DARK_ONLY = {'BR-10', 'BR-11'}
EN_ONLY = {'BR-28', 'EG-22'}


def applies(rule, d):
    if rule in LIGHT_ONLY and d.gelap:
        return False
    if rule in DARK_ONLY and not d.gelap:
        return False
    if rule in EN_ONLY and d.edisi != 'en':
        return False
    return True


def failing(d):
    return {r: fn(d) for r, fn in RULES.items() if applies(r, d) and fn(d)}


# ───────────────────────── material and negatives ─────────────────────────
def mutate(doc, n):
    """Apply one negative N.. of isi.json (same path grammar as the material's own checker)."""
    d = copy.deepcopy(doc)
    tgt = d if n['edisi'] == 'id' else d['edisi_en']
    for path, val in n['ubah'].items():
        if path.startswith('varian['):
            name = path[path.index('[') + 1:path.index(']')]
            for v in d['varian']:
                if v['nama'] == name:
                    v[path.split('.')[1]] = val
            continue
        if path.startswith('meta.'):
            tgt['meta'][path[5:]] = val
            continue
        m = re.match(r'slide\[(\d+)\]\.(\w+)(?:\.(\w+))?(\[(\d+)\])?([+-])?$', path)
        si, key, sub, _, idx, op = m.groups()
        s = tgt['slide'][int(si) - 1]
        if sub:
            s[key][sub] = val
        elif idx:
            s[key][int(idx) - 1] = val
        elif op == '+':
            s[key] = s[key] + ([val] if isinstance(s.get(key), list) else val)
        elif op == '-':
            s[key] = s[key][:-val]
        else:
            s[key] = val
    return d


class Material:
    doc = None
    out = None
    decks = {}

    @classmethod
    def setup(cls):
        if cls.doc is not None:
            return
        with open(ISI, encoding='utf-8') as fh:
            cls.doc = json.load(fh)
        cls.out = os.environ.get('DATUM_UJI_KELUAR') or tempfile.mkdtemp(prefix='row101-')
        cls.gambar = {'Gambar 4.1': GAMBAR, 'Figure 4.1': GAMBAR}
        for name, ed, gelap, meta, slides, fname in DP.variants(cls.doc):
            p = DP.build_deck(meta, slides, os.path.join(cls.out, 'positif', fname), ed, gelap,
                              cls.gambar)
            cls.decks[name] = Deck(p, ed, gelap)

    @classmethod
    def build_negative(cls, n):
        doc = mutate(cls.doc, n)
        want = 'id_gelap' if n['id'] == 'N13' else ('en_terang' if n['edisi'] == 'en' else 'id_terang')
        for name, ed, gelap, meta, slides, fname in DP.variants(doc):
            if name == want:
                p = DP.build_deck(meta, slides, os.path.join(cls.out, n['id'], fname), ed, gelap,
                                  cls.gambar)
                return Deck(p, ed, gelap)


@unittest.skipUnless(HAVE_MATERIAL, 'Kasus 03 Rev A material not found')
class TestRuleOnPositiveDecks(unittest.TestCase):
    """Each of the 27 file-testable rules (and EG-22) holds on every deck it applies to."""

    @classmethod
    def setUpClass(cls):
        Material.setup()

    def check(self, rule):
        decks = [d for d in Material.decks.values() if applies(rule, d)]
        self.assertTrue(decks, f'{rule}: no deck to test')
        for d in decks:
            self.assertEqual(RULES[rule](d), [], f'{rule} on {os.path.basename(d.path)}')


for _r in RULES:
    setattr(TestRuleOnPositiveDecks, 'test_' + _r.replace('-', '_'),
            (lambda r: lambda self: self.check(r))(_r))


@unittest.skipUnless(HAVE_MATERIAL, 'Kasus 03 Rev A material not found')
class TestNegativeVariants(unittest.TestCase):
    """N01..N14: each mutated deck fails its own rule and no other rule."""

    @classmethod
    def setUpClass(cls):
        Material.setup()
        cls.neg = {n['id']: n for n in Material.doc['negatif']}

    def run_negative(self, nid):
        n = self.neg[nid]
        d = Material.build_negative(n)
        got = failing(d)
        if nid == 'N13':
            # Builder negative: without DATUM_BRIEF=gelap the builder must not write the dark
            # ground. A correct builder passes every rule here; the BR-06 test must still catch
            # a builder that ignores the setting (sensitivity deck below).
            self.assertFalse(d.gelap)
            self.assertEqual(got, {}, f'N13 deck: {got}')
            bad = Deck(DP.build_deck(d_meta(Material.doc), Material.doc['slide'],
                                     os.path.join(Material.out, 'N13-salah', 'salah.pptx'),
                                     'id', True, Material.gambar), 'id', False)
            self.assertTrue(br06(bad), 'BR-06 did not catch a dark deck built without the setting')
            return
        self.assertEqual(sorted(got), [n['aturan'][0]], f'{nid}: {got}')


def d_meta(doc):
    return doc['meta']


for _n in ['N%02d' % i for i in range(1, 15)]:
    setattr(TestNegativeVariants, 'test_' + _n, (lambda k: lambda self: self.run_negative(k))(_n))


@unittest.skipUnless(HAVE_MATERIAL, 'Kasus 03 Rev A material not found')
class TestGlyphFace(unittest.TestCase):
    """C44a: glyph runs in DejaVu Sans, never Plex, on every deck; the rest stays Plex."""

    @classmethod
    def setUpClass(cls):
        Material.setup()

    def test_glyph_runs_dejavu(self):
        for d in Material.decks.values():
            self.assertEqual(glyph_font(d), [], os.path.basename(d.path))

    def test_glyph_check_catches_plex(self):
        d = Material.decks['id_terang']
        for _, r in all_runs(d):
            if GLYPH_RE.search(r.text):
                r.font.name = DP.SERIF                     # in memory only
                break
        self.assertTrue(glyph_font(d))
        Material.decks['id_terang'] = Deck(d.path, d.edisi, d.gelap)   # reload unchanged file


@unittest.skipUnless(HAVE_MATERIAL, 'Kasus 03 Rev A material not found')
class TestRow101c(unittest.TestCase):
    """C50 fixes: body top (BR-04), seal logo on ID light (BR-13), DejaVu shipped (BR-14)."""

    @classmethod
    def setUpClass(cls):
        Material.setup()

    def test_body_at_42_or_under_headline(self):
        one = wrapped = 0
        for d in Material.decks.values():
            for n, sl in enumerate(d.slides, 1):
                self.assertEqual(body_start(d, n, sl), [], os.path.basename(d.path))
                h = [s for s in sl.shapes if s.name == 'judul']
                if h:
                    k = round(h[0].height / DP.HEADLINE_PITCH)
                    top = min(s.top for s in sl.shapes if s.name.startswith('isi-'))
                    if k == 1:
                        one += 1
                        self.assertTrue(near(top, Mm(42)), f'slide {n}: {top / 36000:.1f} mm')
                    else:
                        wrapped += 1
                        self.assertTrue(near(top, Mm(31) + DP.HEADLINE_PITCH * k))
        self.assertGreater(one, 0)

    def test_body_rule_catches_old_layout(self):
        d = Material.decks['id_terang']
        sl = d.slides[1]
        b = [s for s in sl.shapes if s.name.startswith('isi-')]
        old = b[0].top
        b[0].top = Mm(60)                                       # the v1 layout (58-66 mm)
        try:
            self.assertTrue(body_start(d, 2, sl))
        finally:
            b[0].top = old

    def test_logo_per_edition(self):
        from PIL import Image
        import io
        for name, want in (('id_terang', 'gsp-seal.png'), ('id_gelap', 'gsp-putih.png'),
                           ('en_terang', 'gsp-tinta.png')):
            d = Material.decks[name]
            pics = [(n, s) for n, s, h in pictures(d) if h in LOGO.values()]
            self.assertEqual([n for n, _ in pics], [1], name)
            self.assertEqual(sha1(pics[0][1].image.blob), LOGO[want], name)
        im = Image.open(io.BytesIO([s for n, s, h in pictures(Material.decks['id_terang'])
                                    if n == 1][0].image.blob)).convert('RGBA')
        ink = sorted((cnt, c) for cnt, c in im.getcolors(1 << 22) if c[3] > 200)
        self.assertTrue(ink, 'logo has no opaque pixel')
        self.assertTrue(close_hex('%02X%02X%02X' % ink[-1][1][:3], '6E1420'),
                        f'ID light logo ink {ink[-1][1]} is not seal maroon #6E1420')

    def test_dejavu_shipped(self):
        for d in Material.decks.values():
            folder = os.path.join(os.path.dirname(d.path), DP.FONT_FOLDER_NAME)
            for f in ('DejaVuSans.ttf', 'DejaVuSans-Bold.ttf', 'LICENSE-DejaVu.txt'):
                p = os.path.join(folder, f)
                self.assertTrue(os.path.isfile(p), f)
                self.assertEqual(sha1(p), sha1(os.path.join(DP.FONT_DIR, f)), f)


class TestBuilderBasics(unittest.TestCase):
    """No material needed: the built-in sample builds and keeps the master geometry."""

    def test_sample_builds(self):
        out = tempfile.mkdtemp(prefix='row101-sample-')
        spec = DP.SAMPLE
        p = DP.build_deck(spec['meta'], spec['slide'], os.path.join(out, 'Contoh.pptx'))
        d = Deck(p, 'id', False)
        for r in ('BR-02', 'BR-03', 'BR-04', 'BR-05', 'BR-07', 'BR-08', 'BR-09', 'BR-12',
                  'BR-15', 'BR-17', 'BR-19', 'BR-23', 'BR-24', 'BR-27', 'BR-32', 'BR-33'):
            self.assertEqual(RULES[r](d), [], r)

    def test_dark_needs_setting(self):
        os.environ.pop('DATUM_BRIEF', None)
        v = DP.variants({'meta': {'bahasa': 'id'}, 'slide': []})
        self.assertFalse(v[0][2])


if __name__ == '__main__':
    unittest.main(verbosity=2)
