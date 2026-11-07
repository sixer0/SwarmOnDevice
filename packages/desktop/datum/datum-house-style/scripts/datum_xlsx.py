#!/usr/bin/env python3
"""DATUM Rev A - workbook (RAB) builder.

    python3 datum_xlsx.py <isi.json> [-o <folder>]   build the workbook named by "keluaran"
    python3 datum_xlsx.py --check <file.xlsx>         FILE test of DT-40a..i (exit 0 = clean)

Rules: GSP Manual Penulisan / Writing Manual Rev A (XXX/GSP/STD/XI/2026; ID 02-XI-2026,
EN 03-XI-2026), chapter 11.1-11.4 (ID pp 71-73, EN pp 73-75), DT-31a (ID p17, EN p18),
DT-33, DT-40a..i. Rule ids WB-nn are the row 74 register (research/12_rev_a_workbook_rules.md).
Swarm 1.2.0 row 100 replaced the v1.7 hard-coded sample (E-37, ID p82: "the sample cost
workbook breaks its own rules and is no template until rebuilt") by a builder driven by the
content file. The content owns the facts; this script owns the form.

Exit codes: 0 built / clean; 1 a KENDALI check or a periksa value failed (nothing written), or
--check found a breach; 2 usage or unreadable input.

Rulings applied here (decisions C22, C27; open points of test/14 section 5):
  * Percent cells (C27, ID p72 Tabel 11.2 "Persen 0.0" %" -> 12,0 %"): the quoted % does not
    scale, so a percent is stored in percent units (12, 2) and every formula that uses it
    divides by the typed cell PEMBAGI-PERSEN = 100 on HITUNG-PAJAK (decision C50, DT-40d ID
    p72: no constant inside a formula). Content files give percents as fractions (0.12); the
    builder multiplies by 100 once when it types the cell.
  * VAT (DT-31a ID p17 / EN p18; DT-40d ID p72 "hitung sekali lalu rujuk ... pecah rumus
    panjang"): DPP = ROUNDDOWN(subtotal x factor,0) on its own row, as Turunan 3.7a prints it
    (ID p17), and PPN = ROUNDDOWN(DPP x rate/divisor,0) refers to that row. The two ROUNDDOWNs and
    both HITUNG-PAJAK references of the manual's right example (ID p72) are kept, split over
    two cells, so the DPP is computed once.
  * Silang PPN (C22): MAX(0, ABS(PPN - ROUND(subtotal x effective rate/divisor,0)) - tolerance),
    so the fixed verdict =IF(ABS(Cn)<0.5,...) passes Turunan 3.7a (difference 1.0) and fails
    a real error. Wording by language: LULUS/GAGAL/SELURUH UJI LULUS (ID p73) or
    PASS/FAIL/ALL CHECKS PASSED (EN p75).
  * Master flag colour (DT-40g ID p73: verd on pass, alert on fail) is a static font colour
    the builder sets from its own Python recalculation; no conditional format (DT-40f ID p72:
    a negative difference is shown by the verdict, not by colour) and no fill (DT-40c). The
    builder refuses to write a workbook whose checks fail ("release only when the flag reads
    SELURUH UJI LULUS", DT-40g).
  * Formulas (decision C103, row 48 M1): only the builder's own formulas are written as
    formulas: the ones it composes, 'SHEET:key' links, and a hitung value the content marks
    with a leading "=" (an arithmetic expression over that sheet's keys, checked by _arith).
    Each is a Formula value; every other text is stored as a string cell even when it starts
    with "=", "+", "-" or "@" (the text is kept as the author gave it, C45). --check flags a
    formula that uses a function outside the builder's set and text that looks like a formula.
  * External links: none are written (DT-40d ID p72: zero values pasted from outside the
    workbook). A formula that does carry one ("[") is coloured alert (Tabel 11.1, ID p71).
  * Rounding: line items, AHS rows and the contingency keep ROUND to whole rupiah; DPP, PPN
    and total ROUNDDOWN (DT-31a ID p17 names only those three).
"""

import json, os, re, sys, math, shutil, zipfile
from decimal import Decimal, ROUND_HALF_UP, ROUND_DOWN
from fractions import Fraction

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKENS = os.path.join(SKILL, 'tokens.json')
FONTS = os.path.join(SKILL, 'assets', 'fonts')

T = json.load(open(TOKENS, encoding='utf-8'))
_I, _WB = T['colour']['interior'], T['colour']['workbook']
X = lambda h: h.lstrip('#').upper()

INK, INK7, INK4, INK2 = X(_I['ink900']), X(_I['ink700']), X(_I['ink400']), X(_I['ink200'])
SIG, VERD, ALERT, FORMULA = X(_WB['input']), X(_WB['sheetlink']), X(_WB['external']), X(_WB['formula'])
HEAD_FILL, HEAD_TEXT = X(_WB['header']), X(_WB.get('header_text', '#FFFFFF'))
SEAL = X(_WB.get('title_bar_rule', T['colour']['wrapper']['seal']))
CLASS_COL = X(_WB.get('classification', T['colour']['wrapper']['seal']))
FLAG_OK, FLAG_FAIL = X(_WB['flagok']), X(_WB['flagfail'])
RETIRED = [X(c) for c in T['colour'].get('rules', {}).get('retired', ['#1A2B4A', '#C9A84C'])]
SCREEN_BAND = X(_I['ink100'])                        # never a print fill (Annex A, ID p89)

SANS, COND, MONO = 'IBM Plex Sans', 'IBM Plex Sans Condensed', 'IBM Plex Mono'
NF = dict(T['workbook'].get('number_formats', {}))
FMT = {'rupiah': NF.get('rupiah', '#,##0;-#,##0'), 'bulat': NF.get('rupiah', '#,##0;-#,##0'),
       'volume': NF.get('volume', '#,##0.0'), 'koefisien': NF.get('koefisien', '0.000##'),
       'persen': NF.get('persen', '0.0" %"')}
FOUR_FORMATS = {FMT['rupiah'], FMT['volume'], FMT['koefisien'], FMT['persen']}
FIXED_ORDER = ['COVER', 'PETUNJUK', 'KENDALI', 'RINGKASAN-EKSEKUTIF', 'REKAPITULASI', 'RAB', 'AHS']
SHEET_NAME = re.compile(r'[A-Z0-9]+(-[A-Z0-9]+)*')

PCT_SHEET = 'HITUNG-PAJAK'   # home of the percent divisor (decision C50)
HEADER_ROW = 6          # every sheet: rows 1-4 title bar, row 5 band or flag, row 6 table head
FREEZE = f'A{HEADER_ROW + 1}'

WORDS = {
    'id': dict(pass_='LULUS', fail='GAGAL', flag_ok='SELURUH UJI LULUS', flag_label='BENDERA INDUK',
               sumber='SUMBER', catatan='CATATAN', item='Butir', desc='Keterangan',
               key_band='ANGKA KUNCI · SELURUH NILAI TERTAUT KE LEMBAR SUMBER',
               legend=['Contoh', 'Warna', 'Hex', 'Arti', 'Tindakan pembaca', 'Golongan'],
               struct=['Lembar', 'Golongan', 'Isi', 'Sel masukan', 'Dicetak', ''],
               hitung=['Kode', 'Besaran', 'Nilai', 'Satuan', 'Sumber'],
               ringkas=['Angka kunci', 'Nilai', 'Satuan', 'Lembar sumber'],
               rekap=['Bab', 'Uraian', 'Nilai (Rp)', 'Bagian subtotal', 'Sumber'],
               rab=['No', 'Uraian pekerjaan', 'Volume', 'Satuan', 'Harga satuan (Rp)', 'Jumlah (Rp)'],
               hd=['Kode', 'Uraian', 'Satuan', '', '', 'Harga dasar (Rp)', 'Sumber'],
               ahs=['No', 'Uraian', 'Kode', 'Satuan', 'Koefisien', 'Harga satuan (Rp)', 'Jumlah harga (Rp)'],
               group_sum='Jumlah harga', sheet='Lembar', range=' sampai ', pct_label='Pembagi persen',
               pct_basis='Sel persen menyimpan angka persen (12 untuk 12,0 %, Tabel 11.2 dan keputusan C27); rumus membaginya dengan sel ini, tidak dengan konstanta (DT-40d)', jumlah_bab='Jumlah Bab', basis='DASAR KUANTITAS'),
    'en': dict(pass_='PASS', fail='FAIL', flag_ok='ALL CHECKS PASSED', flag_label='MASTER FLAG',
               sumber='SOURCE', catatan='NOTE', item='Item', desc='Detail',
               key_band='KEY FIGURES · EVERY VALUE LINKED TO ITS SOURCE SHEET',
               legend=['Example', 'Colour', 'Hex', 'Meaning', 'Reader action', 'Cell type'],
               struct=['Sheet', 'Class', 'Content', 'Input cells', 'Printed', ''],
               hitung=['Code', 'Quantity', 'Value', 'Unit', 'Source'],
               ringkas=['Key figure', 'Value', 'Unit', 'Source sheet'],
               rekap=['Chapter', 'Description', 'Value (IDR)', 'Share of subtotal', 'Source'],
               rab=['No', 'Work item', 'Volume', 'Unit', 'Unit price (IDR)', 'Amount (IDR)'],
               hd=['Code', 'Description', 'Unit', '', '', 'Base price (IDR)', 'Source'],
               ahs=['No', 'Description', 'Code', 'Unit', 'Coefficient', 'Unit price (IDR)', 'Amount (IDR)'],
               group_sum='Subtotal', sheet='Sheet', range=' to ', pct_label='Percent divisor',
               pct_basis='Percent cells hold percent figures (12 for 12.0 %, Table 11.2 and decision C27); formulas divide by this cell, not by a constant (DT-40d)', jumlah_bab='Sum of chapters', basis='QUANTITY BASIS'),
}


# ───────────────────────── Excel arithmetic in Python ─────────────────────────
def _d(x):
    return Decimal(f'{float(x):.15g}')                 # Excel keeps 15 significant digits


def xround(x, n=0):
    """Excel ROUND: half away from zero."""
    return float(_d(x).quantize(Decimal(1).scaleb(-n), rounding=ROUND_HALF_UP))


def xdown(x, n=0):
    """Excel ROUNDDOWN: toward zero."""
    return float(_d(x).quantize(Decimal(1).scaleb(-n), rounding=ROUND_DOWN))


def terbilang_id(n):
    s = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan',
         'sepuluh', 'sebelas']
    if n < 12:
        return s[n]
    if n < 20:
        return terbilang_id(n - 10) + ' belas'
    if n < 100:
        return terbilang_id(n // 10) + ' puluh' + (' ' + terbilang_id(n % 10) if n % 10 else '')
    if n < 200:
        return 'seratus' + (' ' + terbilang_id(n - 100) if n > 100 else '')
    if n < 1000:
        return terbilang_id(n // 100) + ' ratus' + (' ' + terbilang_id(n % 100) if n % 100 else '')
    if n < 2000:
        return 'seribu' + (' ' + terbilang_id(n - 1000) if n > 1000 else '')
    for size, w in ((10**12, 'triliun'), (10**9, 'miliar'), (10**6, 'juta'), (10**3, 'ribu')):
        if n >= size:
            h, r = divmod(n, size)
            return terbilang_id(h) + ' ' + w + (' ' + terbilang_id(r) if r else '')
    raise ValueError(n)


def terbilang_en(n):
    ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
            'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
            'eighteen', 'nineteen']
    tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
    if n < 20:
        return ones[n]
    if n < 100:
        return tens[n // 10] + ('-' + ones[n % 10] if n % 10 else '')
    if n < 1000:
        return ones[n // 100] + ' hundred' + (' ' + terbilang_en(n % 100) if n % 100 else '')
    for size, w in ((10**12, 'trillion'), (10**9, 'billion'), (10**6, 'million'), (10**3, 'thousand')):
        if n >= size:
            h, r = divmod(n, size)
            return terbilang_en(h) + ' ' + w + (' ' + terbilang_en(r) if r else '')
    raise ValueError(n)


def _arith(expr, env):
    """+ - * / and parentheses over names in env; no eval()."""
    toks = re.findall(r'\s*(\d+\.?\d*|[A-Za-z_][A-Za-z0-9_]*|[-+*/()])', expr)
    if ''.join(toks).replace(' ', '') != expr.replace(' ', ''):
        raise ValueError(f'unsupported formula: {expr}')
    pos = [0]

    def peek():
        return toks[pos[0]].strip() if pos[0] < len(toks) else None

    def take():
        pos[0] += 1
        return toks[pos[0] - 1].strip()

    def prim():
        t = take()
        if t == '(':
            v = add()
            take()
            return v
        if t == '-':
            return -prim()
        if re.match(r'\d', t):
            return float(t)
        return float(env[t])

    def mul():
        v = prim()
        while peek() in ('*', '/'):
            v = v * prim() if take() == '*' else v / prim()
        return v

    def add():
        v = mul()
        while peek() in ('+', '-'):
            v = v + mul() if take() == '+' else v - mul()
        return v

    v = add()
    if pos[0] != len(toks):
        raise ValueError(f'unsupported formula: {expr}')
    return v


# ───────────────────────── builder ─────────────────────────
class BuildError(Exception):
    pass


class Formula(str):
    """A formula the builder itself intends (decision C103, row 48 M1). put() writes only these
    as formulas; any other str, even one starting with "=", is stored as a string cell."""


def xl_text(text):
    """Content text inside an Excel string literal: a quote is doubled, so it cannot end the
    literal and add formula text (C103)."""
    return str(text).replace('"', '""')


class Book:
    def __init__(self, isi):
        from openpyxl import Workbook
        from openpyxl.styles import Font
        self.isi = isi
        self.lang = 'en' if isi.get('bahasa') == 'en' else 'id'
        self.W = WORDS[self.lang]
        m = isi['meta']
        self.doc_id, self.rev, self.rev_date = m['nomor'], m['rev'], m['tanggal_rev']
        self.klass = m['klasifikasi'].upper()
        self.ref, self.val = {}, {}      # 'SHEET:key' -> (sheet, coord) / Python value
        self.wb = Workbook()
        self.wb.remove(self.wb.active)
        for st in self.wb._named_styles:   # openpyxl seeds Normal with Calibri 11
            st.font = Font(name=SANS, size=9, color=INK7)
        self.sheets = {}
        self.ncol = {}

    # ---- primitives ----
    def font(self, size=9, bold=False, col=INK7, face=SANS, it=False):
        from openpyxl.styles import Font
        return Font(name=face, size=size, bold=bold, color=col, italic=it)

    def put(self, ws, ref, val, font=None, align=None, border=None, fmt=None):
        c = ws[ref]
        c.value = val           # content text is written as the author gave it (decision C45)
        if isinstance(val, str) and not isinstance(val, Formula):
            c.data_type = 's'   # C103 M1: text stays text even when it starts with "="
        c.font = font or self.font()
        if align:
            c.alignment = align
        if border:
            c.border = border
        if fmt:
            c.number_format = fmt
        return c

    @staticmethod
    def al(h='left', wrap=False, v='center'):
        from openpyxl.styles import Alignment
        return Alignment(horizontal=h, vertical='top' if wrap else v, wrap_text=wrap)

    @staticmethod
    def rule(style='hair', col=INK2, top=False):
        from openpyxl.styles import Border, Side
        s = Side(style=style, color=col)
        return Border(top=s) if top else Border(bottom=s)

    def numcol(self, value):
        """Tabel 11.1 (ID p71 / EN p73): typed -> signal, other-sheet link -> verd, external
        link -> alert, formula on this sheet -> ink900."""
        if isinstance(value, Formula):
            if '[' in value:
                return ALERT
            return VERD if '!' in value else FORMULA
        return SIG

    def num(self, ws, ref, value, fmtkey, bold=False, size=9, border=None):
        if fmtkey not in FMT:
            raise BuildError(f'unknown number format key "{fmtkey}" at {ws.title}!{ref}')
        return self.put(ws, ref, value, self.font(size, bold, self.numcol(value)),
                        self.al('right'), border or self.rule(), FMT[fmtkey])

    def a(self, sym, here):
        """Formula address of a registered symbol 'SHEET:key' as seen from sheet `here`."""
        if sym not in self.ref:
            raise BuildError(f'unresolved reference {sym}')
        sh, coord = self.ref[sym]
        if sh == here:
            return coord
        return (f"'{sh}'!{coord}" if not re.fullmatch(r'[A-Za-z0-9]+', sh) else f'{sh}!{coord}')

    def reg(self, sheet, key, coord, value):
        self.ref[f'{sheet}:{key}'] = (sheet, coord)
        self.val[f'{sheet}:{key}'] = value

    def v(self, sym):
        return self.val[sym]

    def text_height(self, ws, row, text, width_chars):
        lines = max(1, math.ceil(len(text) / max(width_chars * 1.1, 1)))
        ws.row_dimensions[row].height = max(15, 12.5 * lines + 3)

    # ---- sheet frame ----
    def sheet(self, name):
        from openpyxl.utils import get_column_letter
        from openpyxl.worksheet.properties import PageSetupProperties
        widths = self.isi['bentuk']['lebar'][name]
        title, subtitle = self.isi['lembar'][name]
        ws = self.wb.create_sheet(name)
        self.sheets[name], n = ws, len(widths)
        self.ncol[name] = n
        ws.sheet_view.showGridLines = False
        for i, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
        last = get_column_letter(n)
        pub = self.isi['meta'].get('penerbit', 'PT GEMILANG SATRIA PERKASA')
        # Title bar: publisher + running-head classification (DT-28c, ID p14), title, register
        # line, classification on its own line under the number; seal rule (DT-40h, ID p73).
        self.put(ws, 'A1', pub, self.font(7.5, True, INK4), self.al())
        self.put(ws, f'{last}1', self.klass, self.font(7.5, True, CLASS_COL), self.al('right'))
        self.put(ws, 'A2', title, self.font(13, True, INK), self.al())
        self.put(ws, 'A3', f'{self.doc_id} · REV {self.rev} · {self.rev_date} · {subtitle}',
                 self.font(7.5, False, INK4, MONO), self.al())
        self.put(ws, 'A4', self.klass, self.font(8, True, CLASS_COL), self.al())
        for i in range(1, n + 1):
            ws.cell(row=4, column=i).border = self.rule('medium', SEAL)
        ws.row_dimensions[1].height = 14
        ws.row_dimensions[2].height = 20
        # Print (DT-40i, ID p73 / EN p75): A4, one page wide, repeating head, no gridlines,
        # 7 pt Mono register foot (DT-28c: classification right of head and foot).
        ws.page_setup.orientation = 'landscape' if n > 5 else 'portrait'
        ws.page_setup.paperSize = ws.PAPERSIZE_A4
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
        ws.print_options.gridLines = False
        ws.print_title_rows = f'1:{HEADER_ROW}'
        for part, text, col in ((ws.oddFooter.left, f'GSP · {self.doc_id}  |  REV {self.rev} · {self.rev_date}', INK4),
                                (ws.oddFooter.center, '&A  ·  &P / &N', INK4),
                                (ws.oddFooter.right, self.klass, CLASS_COL),
                                (ws.oddHeader.right, self.klass, CLASS_COL)):
            part.text, part.size, part.font, part.color = text, 7, MONO, col
        ws.page_margins.left = ws.page_margins.right = 0.55
        ws.page_margins.top, ws.page_margins.bottom = 0.6, 0.7
        ws.freeze_panes = FREEZE          # DT-40e: freeze below the header row
        return ws

    def header(self, ws, row, labels, right=()):
        """Header rows are the only filled cells: #101418, white text (DT-40c, ID p72)."""
        from openpyxl.styles import PatternFill
        n = self.ncol[ws.title]
        labels = list(labels) + [''] * (n - len(labels))
        for i, lab in enumerate(labels[:n], start=1):
            c = ws.cell(row=row, column=i)
            c.value = lab or None
            if isinstance(c.value, str):
                c.data_type = 's'   # C103 M1: header labels may come from content (kepala)
            c.font = self.font(8, True, HEAD_TEXT)
            c.fill = PatternFill('solid', fgColor=HEAD_FILL)
            c.alignment = self.al('right' if i in right else 'left')
        ws.row_dimensions[row].height = 20

    def band(self, ws, row, text, first_col=1, lead=None):
        """Group band: no fill, Cond 600 capitals, rule under (DT-40c, ID p72)."""
        n = self.ncol[ws.title]
        if lead is not None:
            self.put(ws, f'A{row}', lead, self.font(8.5, True, INK, COND), self.al())
        col = 'ABCDEFGHIJ'[first_col - 1]
        self.put(ws, f'{col}{row}', text.upper(), self.font(8.5, True, INK, COND), self.al())
        for i in range(1, n + 1):
            ws.cell(row=row, column=i).border = self.rule('medium', INK)
        ws.row_dimensions[row].height = 18

    def textrow(self, ws, row, label, text, merge_to=None, label_col='A', text_col='B'):
        n = self.ncol[ws.title]
        if label:
            self.put(ws, f'{label_col}{row}', label, self.font(7.5, True, INK4), self.al(wrap=True))
        self.put(ws, f'{text_col}{row}', text, self.font(7.5, False, INK4), self.al(wrap=True))
        width = ws.column_dimensions[text_col].width
        if merge_to:
            ws.merge_cells(f'{text_col}{row}:{merge_to}{row}')
            width = sum(ws.column_dimensions[c].width for c in 'ABCDEFGHIJ'[
                'ABCDEFGHIJ'.index(text_col):'ABCDEFGHIJ'.index(merge_to) + 1])
        self.text_height(ws, row, text, width)

    def ref_or_value(self, raw, here):
        """'SHEET:key' -> formula link; '=a*b' over this sheet's keys -> formula."""
        if isinstance(raw, str) and re.fullmatch(r'[A-Z0-9-]+:[A-Za-z0-9_.-]+', raw):
            return Formula('=' + self.a(raw, here)), self.v(raw)
        return raw, raw

    # ---- sheets ----
    def build_hitung(self, name):
        ws = self.sheets[name]
        rows = self.isi['hitung'][name]
        self.header(ws, HEADER_ROW, self.W['hitung'], right=(3,))
        r = HEADER_ROW + 1
        local = {}
        for key, label, value, unit, fmtkey, kind, src in rows:
            coord = f'C{r}'
            self.reg(name, key, coord, None)
            local[key] = coord
            if isinstance(value, str) and value.startswith('='):
                expr = value[1:]
                f = Formula('=' + re.sub(r'[A-Za-z_][A-Za-z0-9_]*', lambda m: local[m.group(0)], expr))
                env = {k: self.v(f'{name}:{k}') for k in local}
                pv = _arith(expr, env)
            elif isinstance(value, str) and re.fullmatch(r'\d+/\d+', value):
                f = pv = float(Fraction(value))           # typed once as a number (WB-22)
            elif isinstance(value, str):
                f, pv = self.ref_or_value(value, name)
            else:
                f = pv = round(value * 100, 9) if fmtkey == 'persen' else value   # C27 percent units
                if isinstance(f, float) and f.is_integer() and fmtkey != 'volume':
                    f = pv = int(f)
            self.val[f'{name}:{key}'] = pv
            self.put(ws, f'A{r}', key.upper().replace('_', '-'), self.font(8, True, INK, MONO), self.al(),
                     self.rule())
            self.put(ws, f'B{r}', label, self.font(8.5, False, INK7), self.al(), self.rule())
            self.num(ws, coord, f, fmtkey)
            self.put(ws, f'D{r}', unit or None, self.font(8, False, INK4), self.al(), self.rule())
            self.put(ws, f'E{r}', src, self.font(7.5, False, INK4), self.al(), self.rule())
            r += 1
        if name == PCT_SHEET:
            # Decision C50 (WB-16, DT-40d ID p72 "nol konstanta di dalam rumus"): the divisor
            # that turns a C27 percent cell (12 under 0.0" %") into a factor is typed once here
            # and every percent formula refers to it.
            self.put(ws, f'A{r}', 'PEMBAGI-PERSEN', self.font(8, True, INK, MONO), self.al(), self.rule())
            self.put(ws, f'B{r}', self.W['pct_label'], self.font(8.5, False, INK7), self.al(), self.rule())
            self.num(ws, f'C{r}', 100, 'bulat')
            ws[f'D{r}'].border = self.rule()
            self.put(ws, f'E{r}', self.W['pct_basis'], self.font(7.5, False, INK4), self.al(wrap=True), self.rule())
            self.text_height(ws, r, self.W['pct_basis'], ws.column_dimensions['E'].width)
            self.reg(name, 'pembagi_persen', f'C{r}', 100)

    def pct(self, here):
        """Address of the percent divisor (decision C50) as seen from sheet `here`."""
        return self.a(f'{PCT_SHEET}:pembagi_persen', here)

    def build_ahs(self):
        ws, A = self.sheets['AHS'], self.isi['ahs']
        hd = A['harga_dasar']
        self.band(ws, HEADER_ROW - 1, hd['judul'])
        self.header(ws, HEADER_ROW, self.W['hd'], right=(6,))
        r = HEADER_ROW + 1
        for code, ur, sat, price, src in hd['butir']:
            self.put(ws, f'A{r}', code, self.font(8, True, INK, MONO), self.al(), self.rule())
            self.put(ws, f'B{r}', ur, self.font(8.5, False, INK7), self.al(), self.rule())
            self.put(ws, f'C{r}', sat, self.font(8, False, INK4), self.al(), self.rule())
            for c in 'DE':
                ws[f'{c}{r}'].border = self.rule()
            self.num(ws, f'F{r}', price, 'rupiah')
            self.put(ws, f'G{r}', src, self.font(7.5, False, INK4), self.al(), self.rule())
            self.reg('AHS', code, f'F{r}', price)
            r += 1
        r += 1
        self.put(ws, f'A{r}', A['kode'], self.font(9, True, INK, MONO), self.al())
        self.put(ws, f'B{r}', A['judul'], self.font(9, True, INK), self.al())
        r += 1
        self.header(ws, r, self.W['ahs'], right=(5, 6, 7))
        r += 1
        sums, pv_sum = [], 0
        for letter, title, items in A['kelompok']:
            self.band(ws, r, title, first_col=2, lead=letter)
            r += 1
            first = r
            for ur, kode, sat, koef, price in items:
                self.put(ws, f'B{r}', ur, self.font(8.5, False, INK7), self.al(), self.rule())
                self.put(ws, f'C{r}', kode, self.font(8, False, INK4, MONO), self.al(), self.rule())
                self.put(ws, f'D{r}', sat, self.font(8, False, INK4), self.al(), self.rule())
                ws[f'A{r}'].border = self.rule()
                self.num(ws, f'E{r}', koef, 'koefisien')
                self.num(ws, f'F{r}', price, 'rupiah')
                self.num(ws, f'G{r}', Formula(f'=ROUND(E{r}*F{r},0)'), 'rupiah')
                pv_sum += xround(koef * price)
                r += 1
            self.put(ws, f'B{r}', f"{self.W['group_sum']} {title.lower()}", self.font(8, True, INK7, it=True),
                     self.al(), self.rule('thin', INK4, top=True))
            self.num(ws, f'G{r}', Formula(f'=SUM(G{first}:G{r - 1})'), 'rupiah', bold=True,
                     border=self.rule('thin', INK4, top=True))
            sums.append(f'G{r}')
            r += 1
        (dk, dl, _), (ek, el, _), (fk, fl, _) = A['baris_akhir']
        rate = round(A['biaya_umum'] * 100, 9)            # C27 percent units
        rate = int(rate) if float(rate).is_integer() else rate
        top = self.rule('medium', INK, top=True)
        self.put(ws, f'A{r}', dk, self.font(8.5, True, INK, MONO), self.al(), top)
        self.put(ws, f'B{r}', dl, self.font(8.5, True, INK), self.al(), top)
        self.num(ws, f'G{r}', Formula('=' + '+'.join(sums)), 'rupiah', bold=True, border=top)
        D, pD = r, pv_sum
        r += 1
        self.put(ws, f'A{r}', ek, self.font(8.5, True, INK, MONO), self.al(), self.rule())
        self.put(ws, f'B{r}', el, self.font(8.5, False, INK7), self.al(), self.rule())
        self.num(ws, f'E{r}', rate, 'persen')
        self.num(ws, f'G{r}', Formula(f"=ROUND(E{r}*G{D}/{self.pct('AHS')},0)"), 'rupiah')
        E, pE = r, xround(rate * pD / 100)
        r += 1
        self.put(ws, f'A{r}', fk, self.font(9, True, INK, MONO), self.al(), top)
        self.put(ws, f'B{r}', f"{fl} · {A.get('satuan_akhir', '')}".rstrip(' ·'), self.font(9, True, INK), self.al(), top)
        self.num(ws, f'G{r}', Formula(f'=ROUND(G{D}+G{E},0)'), 'rupiah', bold=True, size=10, border=top)
        pF = xround(pD + pE)
        self.reg('AHS', A['kode'], f'G{r}', pF)
        self.reg('AHS', 'D', f'G{D}', pD)
        self.reg('AHS', 'E', f'G{E}', pE)
        self.reg('AHS', 'E_rate', f'E{E}', rate)
        r += 2
        if A.get('catatan'):
            self.textrow(ws, r, self.W['catatan'], A['catatan'])

    def build_rab(self):
        ws, R = self.sheets['RAB'], self.isi['rab']
        self.header(ws, HEADER_ROW, self.W['rab'], right=(3, 5, 6))
        r = HEADER_ROW + 1
        first, total = None, 0
        self.rab_vol, self.rab_price, self.rab_items = [], [], []
        for it in R['butir']:
            if it[0] == '§':
                self.band(ws, r, it[1], first_col=2)
                r += 1
                continue
            first = first or r
            no, ur, vol, sat, price = it
            fv, pv = self.ref_or_value(vol, 'RAB')
            fp, pp = self.ref_or_value(price, 'RAB')
            self.put(ws, f'A{r}', str(no), self.font(8, False, INK4), self.al(), self.rule())   # a label, not a numeral
            self.put(ws, f'B{r}', ur, self.font(8.5, False, INK7), self.al(wrap=True), self.rule())
            self.num(ws, f'C{r}', fv, 'volume')
            self.put(ws, f'D{r}', sat, self.font(8, False, INK4), self.al(), self.rule())
            self.num(ws, f'E{r}', fp, 'rupiah')
            self.num(ws, f'F{r}', Formula(f'=ROUND(C{r}*E{r},0)'), 'rupiah')
            self.text_height(ws, r, ur, ws.column_dimensions['B'].width)
            total += xround(pv * pp)
            self.rab_vol.append(pv)
            self.rab_price.append(pp)
            self.rab_items.append((no, price, f'E{r}', pp))
            r += 1
        self.rab_range = (first, r - 1)
        r += 1
        top = self.rule('medium', INK, top=True)
        self.put(ws, f'B{r}', R['subtotal_teks'], self.font(9, True, INK), self.al(), top)
        for c in 'ACDE':
            ws[f'{c}{r}'].border = top
        self.num(ws, f'F{r}', Formula(f'=SUM(F{first}:F{r - 2})'), 'rupiah', bold=True, size=10, border=top)
        self.reg('RAB', 'subtotal', f'F{r}', total)
        r += 2
        if R.get('sumber'):
            self.textrow(ws, r, None, f"{self.W['sumber']}  {R['sumber']}")

    def build_rekap(self):
        ws, K = self.sheets['REKAPITULASI'], self.isi['rekapitulasi']
        hp = 'HITUNG-PAJAK'
        self.header(ws, HEADER_ROW, self.W['rekap'], right=(3, 4))
        r = HEADER_ROW + 1
        first = r
        rows_pct = []
        for bab, ur, ref, src in K['bab']:
            f, pv = self.ref_or_value(ref, 'REKAPITULASI')
            self.put(ws, f'A{r}', bab, self.font(8.5, True, INK, MONO), self.al(), self.rule())
            self.put(ws, f'B{r}', ur, self.font(8.5, False, INK7), self.al(), self.rule())
            self.num(ws, f'C{r}', f, 'rupiah', bold=True)
            self.put(ws, f'E{r}', src, self.font(7.5, False, INK4), self.al(), self.rule())
            self.reg('REKAPITULASI', f'bab_{bab}', f'C{r}', pv)
            rows_pct.append(r)
            r += 1
        babs = [self.v(f'REKAPITULASI:bab_{b[0]}') for b in K['bab']]
        jb = sum(babs)
        labels = [b[0] for b in K['bab']]
        self.put(ws, f'B{r}', f"{self.W['jumlah_bab']} {labels[0]}{self.W['range']}{labels[-1]}" if len(labels) > 1 else f"{self.W['jumlah_bab']} {labels[0]}", self.font(8.5, True, INK7),
                 self.al(), self.rule())
        self.num(ws, f'C{r}', Formula(f'=SUM(C{first}:C{r - 1})'), 'rupiah')
        self.reg('REKAPITULASI', 'jumlah_bab', f'C{r}', jb)
        rows_pct.append(r)
        r += 1
        cad = K['cadangan']
        p = self.a(cad['persen'], 'REKAPITULASI')
        self.put(ws, f'B{r}', cad['teks'], self.font(8.5, False, INK7), self.al(), self.rule())
        self.num(ws, f'C{r}', Formula(f"=ROUND(C{r - 1}*{p}/{self.pct('REKAPITULASI')},0)"), 'rupiah')
        self.put(ws, f'E{r}', cad.get('sumber'), self.font(7.5, False, INK4), self.al(), self.rule())
        pc = xround(jb * self.v(cad['persen']) / 100)
        self.reg('REKAPITULASI', 'cadangan', f'C{r}', pc)
        rows_pct.append(r)
        r += 1
        top = self.rule('medium', INK, top=True)
        sub_r = r
        self.put(ws, f'B{r}', K['subtotal_teks'], self.font(9, True, INK), self.al(), top)
        for c in 'ADE':
            ws[f'{c}{r}'].border = top
        self.num(ws, f'C{r}', Formula(f'=C{r - 2}+C{r - 1}'), 'rupiah', bold=True, size=10, border=top)
        sub = jb + pc
        self.reg('REKAPITULASI', 'subtotal', f'C{r}', sub)
        r += 1
        fd, tr = self.a(f'{hp}:faktor_dpp', 'REKAPITULASI'), self.a(f'{hp}:tarif', 'REKAPITULASI')
        self.put(ws, f'B{r}', K['dpp']['teks'], self.font(8.5, False, INK7), self.al(), self.rule())
        self.num(ws, f'C{r}', Formula(f'=ROUNDDOWN(C{sub_r}*{fd},0)'), 'rupiah')
        dpp = xdown(sub * self.v(f'{hp}:faktor_dpp'))
        self.reg('REKAPITULASI', 'dpp', f'C{r}', dpp)
        dpp_r = r
        r += 1
        self.put(ws, f'B{r}', K['ppn']['teks'], self.font(8.5, False, INK7), self.al(), self.rule())
        self.num(ws, f'C{r}', Formula(f"=ROUNDDOWN(C{dpp_r}*{tr}/{self.pct('REKAPITULASI')},0)"), 'rupiah')
        ppn = xdown(dpp * self.v(f'{hp}:tarif') / 100)
        self.reg('REKAPITULASI', 'ppn', f'C{r}', ppn)
        ppn_r = r
        r += 1
        self.put(ws, f'B{r}', K['total']['teks'], self.font(10, True, INK), self.al(), top)
        for c in 'ADE':
            ws[f'{c}{r}'].border = top
        self.num(ws, f'C{r}', Formula(f'=ROUNDDOWN(C{sub_r}+C{ppn_r},0)'), 'rupiah', bold=True, size=11, border=top)
        tot = xdown(sub + ppn)
        self.reg('REKAPITULASI', 'total', f'C{r}', tot)
        for rr in rows_pct:
            self.num(ws, f'D{rr}', Formula(f"=C{rr}/C${sub_r}*{self.pct('REKAPITULASI')}"), 'persen')
        r += 1
        tb = K['terbilang']
        words = (terbilang_en if self.lang == 'en' else terbilang_id)(int(tot)) + tb.get('akhiran', '')
        self.terbilang = words
        self.put(ws, f'A{r}', tb.get('label', 'Terbilang'), self.font(8, True, INK4), self.al())
        self.put(ws, f'B{r}', words, self.font(8.5, False, INK7, it=True), self.al(wrap=True))
        self.text_height(ws, r, words, ws.column_dimensions['B'].width)
        self.reg('REKAPITULASI', 'terbilang', f'B{r}', words)
        r += 2
        if K.get('dasar'):
            self.band(ws, r, self.W['basis'])
            r += 1
            for label, ref, note, fmtkey in K['dasar']:
                f, pv = self.ref_or_value(ref, 'REKAPITULASI')
                self.put(ws, f'B{r}', label, self.font(8.5, False, INK7), self.al(), self.rule())
                self.num(ws, f'C{r}', f, fmtkey)
                self.put(ws, f'D{r}', note, self.font(7.5, False, INK4), self.al(), self.rule())
                ws[f'E{r}'].border = self.rule()
                r += 1

    def build_ringkasan(self):
        ws, S = self.sheets['RINGKASAN-EKSEKUTIF'], self.isi['ringkasan']
        self.header(ws, HEADER_ROW, self.W['ringkas'], right=(2,))
        r = HEADER_ROW + 1
        for label, ref, unit, fmtkey in S['baris']:
            f, _ = self.ref_or_value(ref, 'RINGKASAN-EKSEKUTIF')
            self.put(ws, f'A{r}', label, self.font(8.5, False, INK7), self.al(), self.rule())
            self.num(ws, f'B{r}', f, fmtkey, bold=True, size=10)
            self.put(ws, f'C{r}', unit, self.font(8, False, INK4), self.al(), self.rule())
            self.put(ws, f'D{r}', f"{self.W['sheet']} {ref.split(':')[0]}", self.font(7.5, False, INK4),
                     self.al(), self.rule())
            r += 1
        if S.get('sumber'):
            r += 1
            self.textrow(ws, r, None, f"{self.W['sumber']}  {S['sumber']}", text_col='A')

    def build_kendali(self):
        ws, Kd = self.sheets['KENDALI'], self.isi['kendali']
        W, hp = self.W, 'HITUNG-PAJAK'
        here = 'KENDALI'
        q = lambda s: self.a(s, here)
        ahs_items = [it for it in self.rab_items if it[1] == f"AHS:{self.isi['ahs']['kode']}"]
        if not ahs_items:
            raise BuildError('no RAB item is priced by the AHS analysis (silang AHS ke RAB)')
        ahs_cell = "RAB!" + ahs_items[0][2]
        r0, r1 = self.rab_range
        # The five checks of ch. 11.4 (ID p73), in the content's order and wording.
        formulas = [
            (f"={q('RAB:subtotal')}-{q('REKAPITULASI:bab_I')}",
             self.v('RAB:subtotal') - self.v('REKAPITULASI:bab_I')),
            (f"=MAX(0,ABS({q('REKAPITULASI:ppn')}-ROUND({q('REKAPITULASI:subtotal')}*"
             f"{q(hp + ':tarif_efektif')}/{self.pct(here)},0))-{q(hp + ':toleransi')})",
             max(0, abs(self.v('REKAPITULASI:ppn') - xround(self.v('REKAPITULASI:subtotal')
                                                             * self.v(hp + ':tarif_efektif') / 100))
                 - self.v(hp + ':toleransi'))),
            (f"={q('REKAPITULASI:total')}-({q('REKAPITULASI:subtotal')}+{q('REKAPITULASI:ppn')})",
             self.v('REKAPITULASI:total') - (self.v('REKAPITULASI:subtotal') + self.v('REKAPITULASI:ppn'))),
            (f"={q('AHS:' + self.isi['ahs']['kode'])}-{ahs_cell}",
             self.v('AHS:' + self.isi['ahs']['kode']) - ahs_items[0][3]),
            (f'=COUNTIF(RAB!C{r0}:C{r1},0)+COUNTIF(RAB!E{r0}:E{r1},0)',
             sum(1 for x in self.rab_vol if x == 0) + sum(1 for x in self.rab_price if x == 0)),
        ]
        if len(Kd['uji']) != 5:
            raise BuildError('KENDALI needs the five checks of ch. 11.4 (ID p73)')
        self.header(ws, HEADER_ROW, Kd.get('kepala', ['Uji', 'Cara', 'Selisih', 'Vonis', 'Dasar']), right=(3,))
        r = HEADER_ROW + 1
        self.verdicts = []
        self.silang_ppn = formulas[1][1]
        for (name, how, _, basis), (f, pv) in zip(Kd['uji'], formulas):
            ok = abs(pv) < 0.5
            self.verdicts.append(W['pass_'] if ok else W['fail'])
            self.put(ws, f'A{r}', name, self.font(8.5, True, INK), self.al(), self.rule())
            self.put(ws, f'B{r}', how, self.font(8, False, INK7), self.al(wrap=True), self.rule())
            self.num(ws, f'C{r}', Formula(f), 'rupiah')
            self.put(ws, f'D{r}', Formula(f'=IF(ABS(C{r})<0.5,"{W["pass_"]}","{W["fail"]}")'),
                     self.font(8.5, True, FLAG_OK if ok else FLAG_FAIL), self.al(), self.rule())
            self.put(ws, f'E{r}', basis, self.font(7.5, False, INK4), self.al(), self.rule())
            self.text_height(ws, r, how, ws.column_dimensions['B'].width)
            self.reg('KENDALI', f'uji{r}', f'C{r}', pv)
            r += 1
        flag = Kd['bendera']
        ok_txt, bad_txt = flag.get('lulus', W['flag_ok']), flag['gagal']
        all_ok = all(v == W['pass_'] for v in self.verdicts)
        self.flag = ok_txt if all_ok else bad_txt
        fr = HEADER_ROW - 1                      # above the head, inside the frozen pane
        self.put(ws, f'A{fr}', W['flag_label'], self.font(9, True, INK), self.al())
        self.put(ws, f'B{fr}', Formula(f'=IF(COUNTIF(D{HEADER_ROW + 1}:D{r - 1},"{W["fail"]}")=0,'
                                       f'"{xl_text(ok_txt)}","{xl_text(bad_txt)}")'),
                 self.font(10, True, FLAG_OK if all_ok else FLAG_FAIL), self.al())
        ws.row_dimensions[fr].height = 22

    def build_petunjuk(self):
        ws, P = self.sheets['PETUNJUK'], self.isi['petunjuk']
        n = self.ncol['PETUNJUK']
        last = 'ABCDEFGHIJ'[n - 1]
        J = P['judul_bagian']
        self.band(ws, HEADER_ROW - 1, J['A'])
        self.header(ws, HEADER_ROW, self.W['legend'], right=(1,))
        r = HEADER_ROW + 1
        for ex, name, hexv, mean, act, kind in P['legenda']:
            self.put(ws, f'A{r}', ex, self.font(9, True, hexv.upper()), self.al('right'), self.rule())
            self.put(ws, f'B{r}', name, self.font(8, True, INK4, MONO), self.al(), self.rule())
            self.put(ws, f'C{r}', '#' + hexv.upper(), self.font(8, False, INK4, MONO), self.al(), self.rule())
            self.put(ws, f'D{r}', mean, self.font(8, False, INK7), self.al(wrap=True), self.rule())
            self.put(ws, f'E{r}', act, self.font(8, False, INK7), self.al(wrap=True), self.rule())
            self.put(ws, f'F{r}', kind, self.font(8, True, INK4), self.al(), self.rule())
            self.text_height(ws, r, mean, ws.column_dimensions['D'].width)
            r += 1
        r += 1
        self.band(ws, r, J['B'])
        r += 1
        self.header(ws, r, self.W['struct'])
        r += 1
        for row in P['struktur']:
            self.put(ws, f'A{r}', row[0], self.font(8, True, INK, MONO), self.al(), self.rule())
            for col, val in zip('BCDE', row[1:]):
                self.put(ws, f'{col}{r}', val, self.font(8, False, INK7), self.al(wrap=True), self.rule())
            ws[f'F{r}'].border = self.rule()
            self.text_height(ws, r, row[2], ws.column_dimensions['C'].width)
            r += 1
        r += 1
        self.band(ws, r, J['C'])
        r += 1
        for code, text in P['batasan']:
            self.put(ws, f'A{r}', code, self.font(8, True, INK, MONO), self.al(v='top'), self.rule())
            self.textrow(ws, r, None, text, merge_to=last if P.get('gabung_prosa') else None)
            for k in range(2, n + 1):
                ws.cell(row=r, column=k).border = self.rule()
            r += 1

    def build_cover(self):
        ws, C = self.sheets['COVER'], self.isi['sampul']
        n = self.ncol['COVER']
        last = 'ABCDEFGHIJ'[n - 1]
        self.header(ws, HEADER_ROW, [self.W['item'], self.W['desc']])
        r = HEADER_ROW + 1
        for label, val, strong in C['baris']:
            b = self.rule('medium', INK, top=True) if strong else self.rule()
            self.put(ws, f'A{r}', label, self.font(8, True, INK4), self.al(), b)
            self.put(ws, f'B{r}', val, self.font(8.5, strong, INK), self.al(wrap=True), b)
            for k in range(3, n + 1):
                ws.cell(row=r, column=k).border = b
            if C.get('gabung_prosa'):
                ws.merge_cells(f'B{r}:{last}{r}')
            self.text_height(ws, r, val, sum(ws.column_dimensions[c].width for c in 'BCDE'[:n - 1]))
            r += 1
        r += 1
        self.band(ws, r, self.W['key_band'])
        r += 1
        for label, ref, unit, note, fmtkey in C['angka_kunci']:
            f, _ = self.ref_or_value(ref, 'COVER')
            self.put(ws, f'A{r}', label, self.font(8.5, False, INK7), self.al(), self.rule())
            self.num(ws, f'B{r}', f, fmtkey, bold=True, size=10)
            self.put(ws, f'C{r}', unit, self.font(8, False, INK4), self.al(), self.rule())
            self.put(ws, f'D{r}', note, self.font(7.5, False, INK4), self.al(), self.rule())
            ws[f'E{r}'].border = self.rule()
            r += 1
        if C.get('cap_terbitan'):
            r += 1
            self.put(ws, f'A{r}', C['cap_terbitan'], self.font(7.5, True, SEAL, MONO), self.al())

    # ---- whole book ----
    def build(self):
        order = self.isi['urutan_lembar']
        problems = check_names(order)
        if problems:
            raise BuildError('; '.join(problems))
        for name in order:
            self.sheet(name)
        for name in order[7:]:
            self.build_hitung(name)
        self.build_ahs()
        self.build_rab()
        self.build_rekap()
        self.build_ringkasan()
        self.build_kendali()
        self.build_petunjuk()
        self.build_cover()
        self.verify()

    def verify(self):
        """Python recalculation against the content's periksa block; stop on any difference."""
        W = self.W
        errs = [f'KENDALI check {i + 1} reads {v}' for i, v in enumerate(self.verdicts) if v != W['pass_']]
        P = self.isi.get('periksa', {})
        got = {'volume_kabel': self.val.get('HITUNG-KABEL:volume'),
               'kepadatan': self.val.get('HITUNG-RUANG:kepadatan'),
               'harga_ahs_D': self.v('AHS:D'), 'harga_ahs_E': self.v('AHS:E'),
               'harga_ahs': self.v('AHS:' + self.isi['ahs']['kode']),
               'subtotal_rab': self.v('RAB:subtotal'), 'jumlah_bab': self.v('REKAPITULASI:jumlah_bab'),
               'cadangan': self.v('REKAPITULASI:cadangan'), 'subtotal': self.v('REKAPITULASI:subtotal'),
               'dpp': self.v('REKAPITULASI:dpp'), 'ppn': self.v('REKAPITULASI:ppn'),
               'total': self.v('REKAPITULASI:total'), 'terbilang': self.terbilang,
               'vonis': self.verdicts, 'bendera': self.flag,
               'selisih_silang_ppn': self.silang_ppn}
        for k, want in P.items():
            if k not in got or got[k] is None:
                continue
            have = got[k]
            same = (abs(float(have) - float(want)) < 1e-6) if isinstance(want, (int, float)) else have == want
            if not same:
                errs.append(f'periksa.{k}: built {have!r}, content expects {want!r}')
        if errs:
            raise BuildError('; '.join(errs))

    def save(self, out_dir):
        name = self.isi['keluaran']
        if '_' in name or not name.lower().endswith('.xlsx'):
            raise BuildError(f'file name "{name}" must be .xlsx without underscores (DT-12, ID p11)')
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, name)
        tmp = path + '.part'
        self.wb.save(tmp)
        scrub(tmp, path, issue_stamp(self.rev_date))
        os.remove(tmp)
        # DT-09 / DT-40i (ID p50, p73): every .xlsx ships with the font folder.
        fdir = os.path.join(out_dir, self.isi.get('folder_fon', 'fonts'))
        os.makedirs(fdir, exist_ok=True)
        for f in sorted(os.listdir(FONTS)):
            if f.lower().endswith(('.ttf', '.otf', '.txt')):
                shutil.copyfile(os.path.join(FONTS, f), os.path.join(fdir, f))
        return path


ROMAN = {'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9,
         'X': 10, 'XI': 11, 'XII': 12}


def issue_stamp(rev_date):
    """'06-XI-2026' -> '2026-11-06T00:00:00Z'; None if the form is not dd-ROMAN-yyyy."""
    m = re.fullmatch(r'(\d{1,2})-([IVX]+)-(\d{4})', rev_date or '')
    if not m or m.group(2) not in ROMAN:
        return None
    return f'{m.group(3)}-{ROMAN[m.group(2)]:02d}-{int(m.group(1)):02d}T00:00:00Z'


def scrub(src, dst, stamp=None):
    """openpyxl seeds styles.xml and theme1.xml with Calibri/Cambria; rewrite them to Plex so
    the file carries no forbidden face (lint 5) and no retired colour (DT-07). The package is
    rewritten with fixed zip times and the revision date as created/modified, so the same
    content gives the same bytes (rebuild at source, PK-10, ID p12)."""
    with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zo:
        for n in zi.namelist():
            d = zi.read(n)
            if n == 'docProps/core.xml' and stamp:
                d = re.sub(rb'(<dcterms:(?:created|modified)[^>]*>)[^<]*(<)',
                           rb'\g<1>' + stamp.encode() + rb'\g<2>', d)
            if n in ('xl/styles.xml', 'xl/theme/theme1.xml'):
                t = d.decode('utf8')
                t = re.sub(r'(val|typeface)="(Calibri|Cambria|Arial|Times New Roman|Courier New)[^"]*"',
                           r'\1="%s"' % SANS, t)
                for c in RETIRED:
                    t = re.sub(c, INK, t, flags=re.I)
                d = t.encode('utf8')
            zo.writestr(zipfile.ZipInfo(n, date_time=(1980, 1, 1, 0, 0, 0)), d, zipfile.ZIP_DEFLATED)


# ───────────────────────── --check (DT-40a FILE test) ─────────────────────────
def check_names(order):
    out = []
    if order[:7] != FIXED_ORDER or len(order) < 8 or not all(s.startswith('HITUNG-') for s in order[7:]):
        out.append(f'sheet order {order} is not {FIXED_ORDER} + HITUNG-* (DT-40a, ID p71 / EN p73)')
    for s in order:
        if not SHEET_NAME.fullmatch(s) or len(s) > 31 or '_' in s:
            out.append(f'sheet name "{s}": capitals and hyphens, at most 31, no underscore (DT-12, ID p11)')
    return out


# C103 (row 48 M1): the functions the builder's formulas use. A formula cell that calls any
# other function (HYPERLINK, WEBSERVICE, ...) or carries a DDE "|" is not one of its shapes.
BUILDER_FUNCS = {'ABS', 'COUNTIF', 'IF', 'MAX', 'ROUND', 'ROUNDDOWN', 'SUM'}


def formula_like(text):
    """Text a spreadsheet would read as a formula or command if it were typed or exported as
    CSV: a leading "=", "@", tab or CR, or a leading "+"/"-" that is not a bullet, a dash or a
    plain signed number (C103)."""
    t = text.lstrip(' ')
    if not t:
        return False
    if t[0] in '=@\t\r':
        return True
    if t[0] in '+-':
        rest = t[1:]
        return not (rest == '' or rest[0].isspace() or rest[0] in '+-'
                    or re.fullmatch(r'\d[\d.,]*\s*%?', rest))
    return False


def _rgb(colour):
    try:
        return (colour.rgb or '')[-6:].upper() if colour is not None and isinstance(colour.rgb, str) else ''
    except Exception:
        return ''


def check_file(path):
    """Structural FILE test of a built workbook. Returns a list of findings."""
    import openpyxl
    out = []
    if '_' in os.path.basename(path):
        out.append('file name carries an underscore (DT-12, ID p11)')
    wb = openpyxl.load_workbook(path)
    out += check_names(wb.sheetnames)
    for ws in wb.worksheets:
        t = ws.title
        if ws.sheet_state != 'visible':
            out.append(f'{t}: sheet is {ws.sheet_state} (DT-40e)')
        if any(d.hidden for d in ws.row_dimensions.values()) or any(d.hidden for d in ws.column_dimensions.values()):
            out.append(f'{t}: hidden rows or columns (DT-40e)')
        if t not in ('COVER', 'PETUNJUK') and ws.merged_cells.ranges:
            out.append(f'{t}: merged cells outside COVER and PETUNJUK (DT-40e)')
        if t == 'KENDALI' and len(list(ws.conditional_formatting)):
            out.append(f'{t}: conditional format on KENDALI (DT-40f)')
        heads = set()
        for row in ws.iter_rows():
            for c in row:
                fill = c.fill.fgColor if c.fill is not None and c.fill.fill_type == 'solid' else None
                if fill is not None:
                    heads.add(c.row)
                    if _rgb(fill) != HEAD_FILL or _rgb(c.font.color) != HEAD_TEXT:
                        out.append(f'{t}!{c.coordinate}: fill other than the #101418/white header (DT-40c)')
                for col in (_rgb(c.font.color) if c.font else '', _rgb(fill) if fill is not None else ''):
                    if col in RETIRED or (col == SCREEN_BAND and fill is not None):
                        out.append(f'{t}!{c.coordinate}: retired or screen-only colour {col} (DT-07, Annex A)')
                if c.font and c.font.name and c.font.name not in (SANS, COND, MONO):
                    out.append(f'{t}!{c.coordinate}: face {c.font.name} (Annex A.2)')
                if '[Red]' in (c.number_format or ''):
                    out.append(f'{t}!{c.coordinate}: [Red] format (DT-40f)')
                v = c.value
                if c.data_type == 'f' and isinstance(v, str):
                    code = re.sub(r'"(?:[^"]|"")*"', '""', v)      # string literals are text, not calls
                    bad = sorted(set(re.findall(r'([A-Z_][A-Z0-9._]*)\s*\(', code.upper())) - BUILDER_FUNCS)
                    if bad or '|' in code:
                        out.append(f'{t}!{c.coordinate}: formula {v[:60]!r} is not one of the builder\'s '
                                   f'formula shapes ({", ".join(bad) or "DDE |"}; C103)')
                elif isinstance(v, str) and formula_like(v):
                    out.append(f'{t}!{c.coordinate}: text {v[:60]!r} looks like a formula; it is stored '
                               f'as text, not marked as a formula - check the content (C103)')
                numeric = (isinstance(v, (int, float)) and not isinstance(v, bool)) or \
                          (c.data_type == 'f' and isinstance(v, str) and '"' not in v)
                if numeric:
                    if c.number_format not in FOUR_FORMATS:
                        out.append(f'{t}!{c.coordinate}: number format {c.number_format!r} not in Tabel 11.2 (DT-40f)')
                    want = SIG if not isinstance(v, str) else (ALERT if '[' in v else VERD if '!' in v else FORMULA)
                    if _rgb(c.font.color) != want:
                        out.append(f'{t}!{c.coordinate}: numeral colour {_rgb(c.font.color)} should be {want} (DT-40b)')
        if not heads:
            out.append(f'{t}: no header row')
        elif ws.freeze_panes != f'A{min(heads) + 1}':
            out.append(f'{t}: freeze {ws.freeze_panes} is not below the header row {min(heads)} (DT-40e)')
        if _rgb(ws['A4'].font.color) != CLASS_COL or _rgb(ws['A4'].border.bottom.color) != SEAL:
            out.append(f'{t}: classification / title-bar rule not seal #{SEAL} (DT-40h)')
        if str(ws.page_setup.paperSize) != str(ws.PAPERSIZE_A4) or ws.page_setup.fitToWidth != 1 \
                or not ws.sheet_properties.pageSetUpPr.fitToPage or not ws.print_title_rows \
                or ws.print_options.gridLines or ws.oddFooter.left.font != MONO or ws.oddFooter.left.size != 7:
            out.append(f'{t}: print setup is not A4 / one wide / repeating head / no grid / 7 pt Mono foot (DT-40i)')
    if 'KENDALI' in wb.sheetnames:
        verdict = re.compile(r'^=IF\(ABS\(C\d+\)<0\.5,"(LULUS|PASS)","(GAGAL|FAIL)"\)$')
        ws = wb['KENDALI']
        found = [c for row in ws.iter_rows() for c in row if isinstance(c.value, str) and verdict.match(c.value)]
        if len(found) < 5:
            out.append(f'KENDALI: {len(found)} verdict formulas, five checks required (DT-40g)')
    return out


def main(argv):
    if len(argv) >= 2 and argv[1] == '--check':
        if len(argv) != 3 or not os.path.isfile(argv[2]):
            print('usage: datum_xlsx.py --check <file.xlsx>', file=sys.stderr)
            return 2
        try:
            found = check_file(argv[2])
        except Exception as e:
            print(json.dumps({'level': 'error', 'source': 'datum_xlsx.check', 'message': str(e),
                              'file': os.path.basename(argv[2])}), file=sys.stderr)
            return 2
        for f in found:
            print('  x ' + f)
        print(f'datum_xlsx --check: {len(found)} finding(s)')
        return 1 if found else 0
    args = argv[1:]
    out_dir = os.environ.get('DATUM_OUT', os.getcwd())
    if '-o' in args:
        i = args.index('-o')
        if i + 1 >= len(args):
            print(__doc__, file=sys.stderr)
            return 2
        out_dir = args[i + 1]
        del args[i:i + 2]
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        isi = json.load(open(args[0], encoding='utf-8'))
    except (OSError, ValueError) as e:
        print(json.dumps({'level': 'error', 'source': 'datum_xlsx.load', 'message': str(e)}), file=sys.stderr)
        return 2
    try:
        book = Book(isi)
        book.build()
        path = book.save(out_dir)
    except (BuildError, KeyError, ValueError, TypeError) as e:
        print(json.dumps({'level': 'error', 'source': 'datum_xlsx.build', 'message': f'{type(e).__name__}: {e}',
                          'content': os.path.basename(args[0])}, ensure_ascii=False), file=sys.stderr)
        return 1
    found = check_file(path)
    for f in found:
        print('  x ' + f)
    print(f'xlsx ok: {path}' if not found else f'xlsx built with {len(found)} finding(s): {path}')
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
