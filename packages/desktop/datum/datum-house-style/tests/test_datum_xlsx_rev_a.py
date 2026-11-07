"""Rev A workbook rules on a workbook built by scripts/datum_xlsx.py (Swarm 1.2.0 row 100).

One test per file-testable rule of the row 74 register (research/12_rev_a_workbook_rules.md):
WB-01, 02, 04, 05, 08, 09, 10, 11, 12, 15, 17, 18, 19, 21, 22, 24, 25, 26, 27, 28, 31, 32,
33, 34, 35, 37, 38, 39 (28). Pages are GSP Manual Penulisan Rev A, ID / EN.

    DATUM_XLSX_TEST_ISI=<isi.json> python3 -I -B -m unittest discover -s tests -v
    (optional DATUM_XLSX_TEST_FILE=<built .xlsx> tests that file instead of building one)

The test builds the workbook itself (subprocess, same interpreter) unless a file is given.
Cached values: openpyxl writes none, so WB-24 / WB-33 recompute the formulas with the small
evaluator below (independent of the builder's Python arithmetic) instead of a recalculated copy.
Deviations from the register's openpyxl "how", each a ruling of decision C27 / row 100:
WB-22 and WB-25 read percent cells in percent units (12 under 0.0" %"), and WB-22 follows the
VAT chain over two cells (DPP row, then PPN) instead of one nested formula.
"""
import json, math, os, re, subprocess, sys, tempfile, unittest, zipfile
from decimal import Decimal, ROUND_HALF_UP, ROUND_DOWN

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
BUILDER = os.path.join(SKILL, 'scripts', 'datum_xlsx.py')
ISI = os.environ.get('DATUM_XLSX_TEST_ISI')
GIVEN = os.environ.get('DATUM_XLSX_TEST_FILE')

FIXED = ['COVER', 'PETUNJUK', 'KENDALI', 'RINGKASAN-EKSEKUTIF', 'REKAPITULASI', 'RAB', 'AHS']
SIG, VERD, INK, ALERT, SEAL = 'B45309', '2F6F6B', '101418', '9B1C1C', '6E1420'
FORMATS = {'#,##0;-#,##0', '#,##0.0', '0.000##', '0.0" %"'}
FACES = {'IBM Plex Sans', 'IBM Plex Sans Condensed', 'IBM Plex Mono'}


def rgb(colour):
    v = getattr(colour, 'rgb', None)
    return v[-6:].upper() if isinstance(v, str) else ''


def is_numeric(v):
    if isinstance(v, bool):
        return False
    return isinstance(v, (int, float)) or (isinstance(v, str) and v.startswith('=') and '"' not in v)


def terbilang(n):          # reference function, same as test/14 section 4 (v1.7 rab.py:160-172)
    s = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas']
    if n < 12: return s[n]
    if n < 20: return terbilang(n - 10) + ' belas'
    if n < 100: return terbilang(n // 10) + ' puluh' + (' ' + terbilang(n % 10) if n % 10 else '')
    if n < 200: return 'seratus' + (' ' + terbilang(n - 100) if n > 100 else '')
    if n < 1000: return terbilang(n // 100) + ' ratus' + (' ' + terbilang(n % 100) if n % 100 else '')
    if n < 2000: return 'seribu' + (' ' + terbilang(n - 1000) if n > 1000 else '')
    for size, w in ((10**12, 'triliun'), (10**9, 'miliar'), (10**6, 'juta'), (10**3, 'ribu')):
        if n >= size:
            h, r = divmod(n, size)
            return terbilang(h) + ' ' + w + (' ' + terbilang(r) if r else '')


class Eval:
    """Recursive-descent evaluator for the formulas the builder writes: + - * / ( ), refs,
    ranges, SUM, ROUND, ROUNDDOWN, MAX, ABS, COUNTIF(range, number). No eval()."""
    TOK = re.compile(r"\s*(?:(?P<num>\d+\.?\d*)|(?P<ref>(?:'[^']+'|[A-Z0-9]+)!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?"
                     r"|\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)(?![A-Z(])|(?P<fn>[A-Z]+)(?=\()|(?P<op>[-+*/(),]))")

    def __init__(self, wb):
        self.wb, self.memo = wb, {}

    def cell(self, sheet, coord):
        k = (sheet, coord.replace('$', ''))
        if k not in self.memo:
            v = self.wb[sheet][k[1]].value
            self.memo[k] = self.formula(v[1:], sheet) if isinstance(v, str) and v.startswith('=') else v
        return self.memo[k]

    def formula(self, f, sheet):
        toks, pos = [], 0
        while pos < len(f):
            m = self.TOK.match(f, pos)
            if not m:
                raise ValueError(f'cannot read {f!r} at {pos}')
            toks.append((m.lastgroup, m.group(m.lastgroup)))
            pos = m.end()
        st = {'t': toks, 'i': 0, 'sheet': sheet}
        v = self.add(st)
        assert st['i'] == len(toks), f
        return v

    def peek(self, st):
        return st['t'][st['i']][1] if st['i'] < len(st['t']) else None

    def take(self, st):
        st['i'] += 1
        return st['t'][st['i'] - 1]

    def add(self, st):
        v = self.mul(st)
        while self.peek(st) in ('+', '-'):
            op = self.take(st)[1]
            r = self.mul(st)
            v = v + r if op == '+' else v - r
        return v

    def mul(self, st):
        v = self.prim(st)
        while self.peek(st) in ('*', '/'):
            op = self.take(st)[1]
            r = self.prim(st)
            v = v * r if op == '*' else v / r
        return v

    def rng(self, text, sheet):
        if '!' in text:
            sheet, text = text.rsplit('!', 1)
            sheet = sheet.strip("'")
        if ':' in text:
            from openpyxl.utils.cell import range_boundaries
            from openpyxl.utils import get_column_letter
            c1, r1, c2, r2 = range_boundaries(text.replace('$', ''))
            return [self.cell(sheet, f'{get_column_letter(c)}{r}') for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)]
        return self.cell(sheet, text)

    def prim(self, st):
        kind, v = self.take(st)
        if kind == 'num':
            return float(v)
        if kind == 'ref':
            return self.rng(v, st['sheet'])
        if v == '-':
            return -self.prim(st)
        if v == '(':
            r = self.add(st)
            self.take(st)
            return r
        if kind == 'fn':
            self.take(st)
            args = [self.add(st)]
            while self.peek(st) == ',':
                self.take(st)
                args.append(self.add(st))
            self.take(st)
            return self.call(v, args)
        raise ValueError(v)

    @staticmethod
    def d(x):
        return Decimal(f'{float(x):.15g}')

    def call(self, fn, a):
        if fn == 'SUM':
            return sum(x for x in a[0] if isinstance(x, (int, float)))
        if fn == 'ROUND':
            return float(self.d(a[0]).quantize(Decimal(1).scaleb(-int(a[1])), rounding=ROUND_HALF_UP))
        if fn == 'ROUNDDOWN':
            return float(self.d(a[0]).quantize(Decimal(1).scaleb(-int(a[1])), rounding=ROUND_DOWN))
        if fn == 'MAX':
            return max(a)
        if fn == 'ABS':
            return abs(a[0])
        if fn == 'COUNTIF':
            return sum(1 for x in a[0] if isinstance(x, (int, float)) and x == a[1])
        raise ValueError(fn)


class RevAWorkbook(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        import openpyxl
        if not (ISI or GIVEN):
            raise unittest.SkipTest('set DATUM_XLSX_TEST_ISI (content json) or DATUM_XLSX_TEST_FILE')
        cls.isi = None
        if ISI:
            with open(ISI, encoding='utf-8') as fh:
                cls.isi = json.load(fh)
        if GIVEN:
            cls.path, cls.build_rc, cls.build_out = GIVEN, 0, ''
        else:
            cls.tmp = tempfile.mkdtemp(prefix='datum-xlsx-')
            p = subprocess.run([sys.executable, '-I', '-B', BUILDER, ISI, '-o', cls.tmp],
                               capture_output=True, text=True)
            cls.build_rc, cls.build_out = p.returncode, p.stdout + p.stderr
            cls.path = os.path.join(cls.tmp, cls.isi['keluaran'])
        cls.wb = openpyxl.load_workbook(cls.path)
        cls.ev = Eval(cls.wb)
        cls.lang = (cls.isi or {}).get('bahasa', 'id')

    # helpers
    def cells(self, sheets=None):
        for ws in self.wb.worksheets:
            if sheets is None or ws.title in sheets:
                for row in ws.iter_rows():
                    for c in row:
                        yield ws, c

    def find(self, sheet, pattern):
        rx = re.compile(pattern, re.I)
        for _, c in self.cells([sheet]):
            if isinstance(c.value, str) and not c.value.startswith('=') and rx.search(c.value):
                return c
        self.fail(f'no cell matching {pattern!r} on {sheet}')

    def value_right_of(self, label_cell):
        ws = label_cell.parent
        for col in range(label_cell.column + 1, ws.max_column + 1):
            c = ws.cell(row=label_cell.row, column=col)
            if is_numeric(c.value):
                return c
        self.fail(f'no value right of {label_cell.coordinate}')

    def header_rows(self, ws):
        return sorted({c.row for row in ws.iter_rows() for c in row
                       if c.fill is not None and c.fill.fill_type == 'solid'})

    # ── WB-01 · ID p71 / EN p73 (DT-40a): built with datum_xlsx.py; --check exits 0
    def test_wb01_built_and_check_exit_0(self):
        self.assertEqual(self.build_rc, 0, self.build_out)
        p = subprocess.run([sys.executable, '-I', '-B', BUILDER, '--check', self.path], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    # ── WB-02 · ID p71 / EN p73 (DT-40a): sheet order
    def test_wb02_sheet_order(self):
        names = self.wb.sheetnames
        self.assertEqual(names[:7], FIXED)
        self.assertGreaterEqual(len(names), 8)
        self.assertTrue(all(n.startswith('HITUNG-') for n in names[7:]), names)

    # ── WB-04 · ID p11, p71 / EN p11, p73 (DT-12): sheet-name form
    def test_wb04_sheet_names(self):
        for t in self.wb.sheetnames:
            self.assertRegex(t, r'^[A-Z0-9]+(-[A-Z0-9]+)*$')
            self.assertLessEqual(len(t), 31)
            self.assertNotIn('_', t)
        self.assertIn('RINGKASAN-EKSEKUTIF', self.wb.sheetnames)

    # ── WB-05 · ID p71, p15 / EN p11, p15: file name, type code RAB
    def test_wb05_file_name(self):
        name = os.path.basename(self.path)
        self.assertNotIn('_', name)
        self.assertIn('-RAB-', name)
        self.assertRegex(name, r'^.+ \d{3}-GSP-RAB-[IVX]+-\d{4} Rev[A-Z]\.xlsx$')

    # ── WB-08 · ID p71-72 / EN p73-74 (Tabel 11.1, DT-40b): numeral colour = cell type
    def test_wb08_numeral_colour_is_cell_type(self):
        n = 0
        for ws, c in self.cells():
            if not is_numeric(c.value):
                continue
            v = c.value
            want = SIG if not isinstance(v, str) else ALERT if '[' in v else VERD if '!' in v else INK
            self.assertEqual(rgb(c.font.color), want, f'{ws.title}!{c.coordinate} {v!r}')
            n += 1
        self.assertGreater(n, 50)
        ahs_rate = [c for ws, c in self.cells(['AHS']) if c.number_format == '0.0" %"' and not isinstance(c.value, str)]
        self.assertTrue(ahs_rate and all(rgb(c.font.color) == SIG for c in ahs_rate), 'AHS overhead is amber (ID p72)')
        typed_vol = [c for ws, c in self.cells(['RAB']) if c.column == 3 and isinstance(c.value, (int, float))]
        self.assertTrue(typed_vol and all(rgb(c.font.color) == SIG for c in typed_vol), 'typed volume amber (ID p72)')

    # ── WB-09 · ID p71-72 / EN p74: PETUNJUK part A shows all four colours
    def test_wb09_colour_key(self):
        cols = {rgb(c.font.color) for _, c in self.cells(['PETUNJUK']) if c.value is not None}
        self.assertTrue({SIG, VERD, INK, ALERT} <= cols, cols)
        txt = ' '.join(str(c.value) for _, c in self.cells(['PETUNJUK']) if c.value)
        for h in (SIG, VERD, INK, ALERT):
            self.assertIn('#' + h, txt)

    # ── WB-10 · ID p72 / EN p74 (DT-40c): fill only header rows, #101418, white text
    def test_wb10_header_only_fill(self):
        for ws in self.wb.worksheets:
            heads = self.header_rows(ws)
            self.assertTrue(heads, ws.title)
            last = max(c.column for row in ws.iter_rows(min_row=heads[0], max_row=heads[0]) for c in row)
            for r in heads:
                for col in range(1, last + 1):
                    c = ws.cell(row=r, column=col)
                    self.assertEqual(c.fill.fill_type, 'solid', f'{ws.title}!{c.coordinate} header gap')
                    self.assertEqual(rgb(c.fill.fgColor), INK, f'{ws.title}!{c.coordinate}')
                    self.assertEqual(rgb(c.font.color), 'FFFFFF', f'{ws.title}!{c.coordinate}')
                    self.assertTrue(c.font.b)
            for _, c in self.cells([ws.title]):
                if c.fill is not None and c.fill.fill_type == 'solid':
                    self.assertIn(c.row, heads)

    # ── WB-11 · ID p72 / EN p74 (DT-40c): bands unfilled, Cond, capitals, rule (partial)
    def test_wb11_group_bands(self):
        cond = [(ws, c) for ws, c in self.cells() if c.value is not None and c.font.name == 'IBM Plex Sans Condensed']
        self.assertTrue(cond)
        for ws, c in cond:
            self.assertIsNone(c.fill.fill_type, f'{ws.title}!{c.coordinate}')
            self.assertEqual(c.value, c.value.upper(), f'{ws.title}!{c.coordinate}')
            self.assertTrue(c.font.b)
            self.assertIsNotNone(c.border.bottom.style, f'{ws.title}!{c.coordinate} band rule')
        if self.isi:
            bands = {b[1].upper() for b in self.isi['rab']['butir'] if b[0] == '§'}
            got = {c.value for ws, c in cond if ws.title == 'RAB'}
            self.assertEqual(bands, got)
            groups = {g[1].upper() for g in self.isi['ahs']['kelompok']}
            self.assertTrue(groups <= {c.value for ws, c in cond if ws.title == 'AHS'})

    # ── WB-12 · ID p89 / EN p91 (Annex A): ink100 never a fill
    def test_wb12_no_ink100_fill(self):
        for ws, c in self.cells():
            if c.fill is not None and c.fill.fill_type:
                self.assertNotEqual(rgb(c.fill.fgColor), 'EFF2F4', f'{ws.title}!{c.coordinate}')

    # ── WB-15 · ID p48 / EN p50 (DT-07): retired navy / gold nowhere
    def test_wb15_no_retired_colour(self):
        for ws, c in self.cells():
            sides = [getattr(c.border, k, None) for k in ('bottom', 'top', 'left', 'right')]
            for col in [rgb(c.font.color), rgb(c.fill.fgColor) if c.fill is not None else ''] + \
                       [rgb(getattr(sd, 'color', None)) for sd in sides]:
                self.assertNotIn(col, ('1A2B4A', 'C9A84C'), f'{ws.title}!{c.coordinate}')
        with zipfile.ZipFile(self.path) as z:
            for n in z.namelist():
                if n.endswith('.xml'):
                    data = z.read(n).upper()
                    self.assertNotIn(b'1A2B4A', data, n)
                    self.assertNotIn(b'C9A84C', data, n)

    # ── WB-17 · ID p72 / EN p74 (DT-40e): merges only in COVER and PETUNJUK prose
    def test_wb17_merges(self):
        for ws in self.wb.worksheets:
            if ws.title in ('COVER', 'PETUNJUK'):
                for rg in ws.merged_cells.ranges:
                    v = ws.cell(row=rg.min_row, column=rg.min_col).value
                    self.assertIsInstance(v, str, f'{ws.title}!{rg}')
                    self.assertFalse(v.startswith('='), f'{ws.title}!{rg} merges a formula')
            else:
                self.assertEqual(list(ws.merged_cells.ranges), [], ws.title)

    # ── WB-18 · ID p72 / EN p74 (DT-40e): hide nothing
    def test_wb18_hide_nothing(self):
        for ws in self.wb.worksheets:
            self.assertEqual(ws.sheet_state, 'visible')
            self.assertFalse(any(d.hidden for d in ws.row_dimensions.values()), ws.title)
            self.assertFalse(any(d.hidden for d in ws.column_dimensions.values()), ws.title)

    # ── WB-19 · ID p72 / EN p74 (DT-40e): freeze below the header row
    def test_wb19_freeze_below_header(self):
        for ws in self.wb.worksheets:
            self.assertEqual(ws.freeze_panes, f'A{self.header_rows(ws)[0] + 1}', ws.title)

    # ── WB-21 · ID p72, p17 / EN p74, p18 (DT-31a): VAT and terbilang only on REKAPITULASI.
    # Exclusions (research/12 reading, accepted in C22): HITUNG-* rate constants, KENDALI check.
    def test_wb21_vat_and_terbilang_only_on_recap(self):
        words = None
        for ws, c in self.cells(['REKAPITULASI']):
            if c.value == 'Terbilang' or c.value == 'In words':
                words = ws.cell(row=c.row, column=c.column + 1).value
        self.assertTrue(words)
        for ws in self.wb.worksheets:
            if ws.title == 'REKAPITULASI':
                continue
            for row in ws.iter_rows():
                label = next((c for c in row if isinstance(c.value, str) and not c.value.startswith('=')), None)
                nums = [c for c in row if is_numeric(c.value)]
                if label is not None and nums and not ws.title.startswith('HITUNG-'):
                    self.assertNotRegex(label.value, r'^\s*(PPN|VAT|DPP|Terbilang|In words)\b',
                                        f'{ws.title}!{label.coordinate}')
                for c in row:
                    if isinstance(c.value, str):
                        self.assertNotIn(words, c.value, f'{ws.title}!{c.coordinate} repeats the terbilang')
                        self.assertNotRegex(c.value, r'^(Terbilang|In words)$', f'{ws.title}!{c.coordinate}')

    # ── WB-22 · ID p17, p72 / EN p18, p74 (DT-31a): VAT = ROUNDDOWN(ROUNDDOWN(sub x 11/12) x 12 %)
    def test_wb22_vat_formula_and_value(self):
        ws = self.wb['REKAPITULASI']
        dpp_c = self.value_right_of(self.find('REKAPITULASI', r'^(DPP|Tax base)'))
        ppn_c = self.value_right_of(self.find('REKAPITULASI', r'^(PPN|VAT)\b'))
        sub_c = self.value_right_of(self.find('REKAPITULASI', r'sebelum PPN|before VAT'))
        for c in (dpp_c, ppn_c):
            self.assertTrue(c.value.startswith('=ROUNDDOWN('), c.value)
            self.assertNotRegex(c.value, r'0\.11|0\.12|11/12|\*11\b|\*12\b')
        m_dpp = re.fullmatch(r"=ROUNDDOWN\((C\d+)\*'HITUNG-PAJAK'!(C\d+),0\)", dpp_c.value)
        m_ppn = re.fullmatch(r"=ROUNDDOWN\((C\d+)\*'HITUNG-PAJAK'!(C\d+)/'HITUNG-PAJAK'!(C\d+),0\)", ppn_c.value)
        self.assertTrue(m_dpp, dpp_c.value)
        self.assertTrue(m_ppn, ppn_c.value)
        self.assertEqual(m_dpp.group(1), sub_c.coordinate)
        self.assertEqual(m_ppn.group(1), dpp_c.coordinate)
        hp = self.wb['HITUNG-PAJAK']
        self.assertAlmostEqual(hp[m_dpp.group(2)].value, 11 / 12, places=12)
        self.assertEqual(hp[m_ppn.group(2)].value, 12)                     # C27 percent units
        self.assertEqual(hp[m_ppn.group(2)].number_format, '0.0" %"')
        self.assertEqual(hp[m_ppn.group(3)].value, 100)                    # C50 percent divisor
        sub = self.ev.cell('REKAPITULASI', sub_c.coordinate)
        dpp = self.ev.cell('REKAPITULASI', dpp_c.coordinate)
        ppn = self.ev.cell('REKAPITULASI', ppn_c.coordinate)
        self.assertEqual(dpp, math.floor(sub * 11 / 12))
        self.assertEqual(ppn, math.floor(dpp * 12 / 100))
        tot_c = self.value_right_of(self.find('REKAPITULASI', r'^TOTAL'))
        self.assertTrue(tot_c.value.startswith('=ROUNDDOWN('))
        self.assertEqual(self.ev.cell('REKAPITULASI', tot_c.coordinate), sub + ppn)
        if self.isi:
            P = self.isi['periksa']
            self.assertEqual((sub, dpp, ppn), (P['subtotal'], P['dpp'], P['ppn']))
        # Turunan 3.7a (ID p17 / EN p18) on the same two-cell path: 71 673 249
        self.assertEqual(math.floor(math.floor(651575000 * 11 / 12) * 12 / 100), 71673249)

    # ── WB-24 · ID p37, p72 / EN p38, p74 (DT-31b): terbilang generated from the total
    def test_wb24_terbilang_matches_total(self):
        lab = self.find('REKAPITULASI', r'^(Terbilang|In words)$')
        words = lab.parent.cell(row=lab.row, column=lab.column + 1).value
        tot_c = self.value_right_of(self.find('REKAPITULASI', r'^TOTAL'))
        total = int(self.ev.cell('REKAPITULASI', tot_c.coordinate))
        if self.lang == 'id':
            self.assertEqual(words, terbilang(total) + ' rupiah')
        if self.isi:
            self.assertEqual(words, self.isi['periksa']['terbilang'])
            self.assertEqual(total, self.isi['periksa']['total'])

    # ── WB-25 · ID p72 / EN p74 (DT-33): AHS rows A..F, E rate in 10-15 %, F = D + E
    def test_wb25_ahs_structure(self):
        ws = self.wb['AHS']
        letters = {c.value: c for c in ws['A'] if c.value in ('A', 'B', 'C', 'D', 'E', 'F')}
        self.assertEqual(set(letters), set('ABCDEF'))
        d, e, f = (letters[k].row for k in 'DEF')
        rate = ws[f'E{e}'].value
        self.assertTrue(10 <= rate <= 15, rate)                             # percent units (C27)
        self.assertRegex(ws[f'G{e}'].value, rf"^=ROUND\(E{e}\*G{d}/'HITUNG-PAJAK'!C\d+,0\)$")
        self.assertEqual(ws[f'G{f}'].value, f'=ROUND(G{d}+G{e},0)')
        sums = re.findall(r'G\d+', ws[f'G{d}'].value)
        self.assertEqual(len(sums), 3)
        for _, c in self.cells(['AHS']):
            if isinstance(c.value, str):
                self.assertNotRegex(c.value, r'(?i)maksimum 15|maximum 15')
        if self.isi:
            P = self.isi['periksa']
            got = [self.ev.cell('AHS', f'G{r}') for r in (d, e, f)]
            self.assertEqual(got, [P['harga_ahs_D'], P['harga_ahs_E'], P['harga_ahs']])

    # ── WB-26 · ID p72 / EN p74: coefficients 0.000##
    def test_wb26_coefficient_format(self):
        ws = self.wb['AHS']
        head = next(c for c in ws[self.header_rows(ws)[1]] if c.value in ('Koefisien', 'Coefficient'))
        coef = [ws.cell(row=r, column=head.column) for r in range(head.row + 1, ws.max_row + 1)
                if isinstance(ws.cell(row=r, column=head.column).value, float)
                and ws.cell(row=r, column=head.column).value < 10]
        self.assertGreaterEqual(len(coef), 6)
        for c in coef:
            self.assertEqual(c.number_format, '0.000##', c.coordinate)

    # ── WB-27 · ID p72 / EN p74 (DT-40f, Tabel 11.2): four codes, zero [Red]
    def test_wb27_number_formats(self):
        for ws, c in self.cells():
            self.assertNotIn('[Red]', c.number_format or '', f'{ws.title}!{c.coordinate}')
            if is_numeric(c.value):
                self.assertIn(c.number_format, FORMATS, f'{ws.title}!{c.coordinate}')

    # ── WB-28 · ID p72 (DT-40f): KENDALI difference by verdict, not colour
    def test_wb28_negative_by_verdict(self):
        ws = self.wb['KENDALI']
        self.assertEqual(len(list(ws.conditional_formatting)), 0)
        diffs = [c for c in ws['C'] if is_numeric(c.value)]
        self.assertEqual(len(diffs), 5)
        for c in diffs:
            self.assertNotIn('[Red]', c.number_format)
            self.assertEqual(c.number_format, '#,##0;-#,##0')
            self.assertRegex(ws[f'D{c.row}'].value, rf'^=IF\(ABS\(C{c.row}\)<0\.5,')

    # ── WB-31 · ID p73 / EN p75 (DT-40g): difference, basis, verdict formula per check
    def test_wb31_verdict_rows(self):
        ws = self.wb['KENDALI']
        p, f = ('PASS', 'FAIL') if self.lang == 'en' else ('LULUS', 'GAGAL')
        rx = re.compile(rf'^=IF\(ABS\(C(\d+)\)<0\.5,"{p}","{f}"\)$')
        rows = [c for c in ws['D'] if isinstance(c.value, str) and rx.match(c.value)]
        self.assertEqual(len(rows), 5)
        for c in rows:
            self.assertEqual(int(rx.match(c.value).group(1)), c.row)
            self.assertTrue(is_numeric(ws[f'C{c.row}'].value))
            self.assertTrue(isinstance(ws[f'E{c.row}'].value, str) and ws[f'E{c.row}'].value.strip())

    # ── WB-32 · ID p73: the five KENDALI checks
    def test_wb32_five_checks(self):
        names = [str(c.value).lower() for c in self.wb['KENDALI']['A'] if c.value]
        for want in ('silang jumlah', 'silang ppn', 'silang total', 'silang ahs ke rab', 'uji nol'):
            self.assertIn(want, names)

    # ── WB-33 · ID p73 / EN p75 (DT-40g): master flag in the frozen pane, pass string, verd
    def test_wb33_master_flag(self):
        ws = self.wb['KENDALI']
        ok = 'ALL CHECKS PASSED' if self.lang == 'en' else 'SELURUH UJI LULUS'
        flag = next(c for _, c in self.cells(['KENDALI']) if isinstance(c.value, str) and c.value.startswith('=IF(COUNTIF('))
        frozen_row = int(re.match(r'[A-Z]+(\d+)', ws.freeze_panes).group(1))
        self.assertLess(flag.row, frozen_row)
        self.assertIn(f'"{ok}"', flag.value)
        self.assertIsNone(flag.fill.fill_type)
        diffs = [self.ev.cell('KENDALI', c.coordinate) for c in ws['C'] if is_numeric(c.value)]
        all_pass = all(abs(x) < 0.5 for x in diffs)
        self.assertTrue(all_pass, diffs)
        self.assertEqual(rgb(flag.font.color), VERD if all_pass else ALERT)
        for c in ws['D']:
            if isinstance(c.value, str) and c.value.startswith('=IF(ABS('):
                self.assertEqual(rgb(c.font.color), VERD)
        if self.isi:
            self.assertEqual(self.isi['periksa']['bendera'], ok)

    # ── WB-34 · ID p73 / EN p74: PETUNJUK parts and BTS-nn; no generic disclaimer on COVER
    def test_wb34_petunjuk_parts(self):
        txt = [str(c.value) for _, c in self.cells(['PETUNJUK']) if c.value]
        self.assertTrue(any(re.fullmatch(r'BTS-\d{2}', t) for t in txt))
        self.assertTrue(any(re.match(r'A · ', t) for t in txt) and any(re.match(r'B · ', t) for t in txt)
                        and any(re.match(r'C · ', t) for t in txt))
        cover = ' '.join(str(c.value) for _, c in self.cells(['COVER']) if c.value)
        self.assertNotIn('Angka bersifat perkiraan', cover)

    # ── WB-35 · ID p73, p49 / EN p75, p51 (DT-40h): classification and title-bar rule in seal
    def test_wb35_seal(self):
        k = (self.isi or {}).get('meta', {}).get('klasifikasi', 'TERBATAS').upper()
        for ws in self.wb.worksheets:
            marks = [c for _, c in self.cells([ws.title]) if c.value == k and c.row <= 4]
            self.assertGreaterEqual(len(marks), 2, ws.title)
            for c in marks:
                self.assertEqual(rgb(c.font.color), SEAL, f'{ws.title}!{c.coordinate}')
            width = max(c.column for row in ws.iter_rows(min_row=6, max_row=6) for c in row)
            for col in range(1, width + 1):
                b = ws.cell(row=4, column=col).border.bottom
                self.assertEqual(rgb(b.color), SEAL, f'{ws.title} title-bar rule col {col}')
            self.assertEqual(ws.oddFooter.right.text, k)
            self.assertEqual(ws.oddFooter.right.color, SEAL)

    # ── WB-37 · ID p73 / EN p75 (DT-40i): A4, one wide, repeating head, no grid, 7 pt Mono foot
    def test_wb37_print(self):
        for ws in self.wb.worksheets:
            self.assertEqual(str(ws.page_setup.paperSize), str(ws.PAPERSIZE_A4), ws.title)
            self.assertTrue(ws.sheet_properties.pageSetUpPr.fitToPage)
            self.assertEqual(ws.page_setup.fitToWidth, 1)
            self.assertTrue(ws.print_title_rows)
            self.assertFalse(ws.print_options.gridLines)
            for part in (ws.oddFooter.left, ws.oddFooter.center, ws.oddFooter.right):
                self.assertIn('Mono', part.font or '', ws.title)
                self.assertEqual(part.size, 7)

    # ── WB-38 · ID p50, p73 / EN p52 (DT-09): font folder beside the .xlsx
    def test_wb38_font_folder(self):
        folder = os.path.join(os.path.dirname(self.path), (self.isi or {}).get('folder_fon', 'fonts'))
        self.assertTrue(os.path.isdir(folder), folder)
        ttf = [f for f in os.listdir(folder) if f.endswith('.ttf')]
        for fam in ('IBMPlexSans-', 'IBMPlexSansCond-', 'IBMPlexMono-', 'DejaVuSans'):
            self.assertTrue(any(f.startswith(fam) for f in ttf), fam)
        self.assertTrue(os.path.isfile(os.path.join(folder, 'LICENSE-DejaVu.txt')))   # C50, as the decks

    # ── WB-39 · ID p50, p89 / EN p51, p91: cells in IBM Plex (Sans; Cond bands; Mono foot)
    def test_wb39_faces(self):
        for ws, c in self.cells():
            if c.value is not None:
                self.assertIn(c.font.name, FACES, f'{ws.title}!{c.coordinate}')
        with zipfile.ZipFile(self.path) as z:
            styles = z.read('xl/styles.xml').decode('utf8') + z.read('xl/theme/theme1.xml').decode('utf8')
        for bad in ('Calibri', 'Courier New', 'Arial', 'Cambria'):
            self.assertNotIn(f'"{bad}', styles)


class NoConstantInFormulas(unittest.TestCase):
    """WB-16 file proxy, decision C50 (DT-40d ID p72 "Nol konstanta di dalam rumus"): no numeric
    literal in any formula except 0 (ROUND digits, MAX floor, COUNTIF zero test) and the 0.5
    verdict threshold of =IF(ABS(Cn)<0.5,...) (ID p73)."""

    def test_no_numeric_literal_in_formulas(self):
        import openpyxl
        path = GIVEN
        if not path:
            if not ISI:
                self.skipTest('set DATUM_XLSX_TEST_ISI or DATUM_XLSX_TEST_FILE')
            with open(ISI, encoding='utf-8') as fh:
                name = json.load(fh)['keluaran']
            tmp = tempfile.mkdtemp(prefix='datum-xlsx-lit-')
            p = subprocess.run([sys.executable, '-I', '-B', BUILDER, ISI, '-o', tmp], capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            path = os.path.join(tmp, name)
        wb = openpyxl.load_workbook(path)
        n = 0
        for ws in wb.worksheets:
            for row in ws.iter_rows():
                for c in row:
                    if isinstance(c.value, str) and c.value.startswith('='):
                        f = re.sub(r'"[^"]*"', '""', c.value)                       # drop string literals
                        f = re.sub(r"'[^']*'!|[A-Z]+!|\$?[A-Z]{1,3}\$?\d+", ' ', f)   # drop references
                        lits = re.findall(r'(?<![A-Za-z_])\d+(?:\.\d+)?', f)
                        bad = [x for x in lits if float(x) not in (0.0, 0.5)]
                        self.assertEqual(bad, [], f'{ws.title}!{c.coordinate} {c.value}')
                        n += 1
        self.assertGreater(n, 40)


class ContentUnchanged(unittest.TestCase):
    """Decision C45: the builder writes the author's text unchanged; a TB-09 breach (en-dash
    ranges, ID p19 "Rentang ditulis dengan sampai") is reported by lint check 03, not fixed."""
    TEXT = 'Ruang R1–R4, rak 1–9, lajur A1–A6, baris 2–8, tingkat 1–3, survei 12–14 Oktober 2026'

    def test_en_dash_range_written_unchanged_and_linted(self):
        import openpyxl
        if not ISI:
            self.skipTest('set DATUM_XLSX_TEST_ISI')
        with open(ISI, encoding='utf-8') as fh:
            isi = json.load(fh)
        row = next(r for r in isi['sampul']['baris'] if r[0] == 'Lokasi')
        row[1] = self.TEXT
        tmp = tempfile.mkdtemp(prefix='datum-xlsx-dash-')
        src = os.path.join(tmp, 'isi.json')
        with open(src, 'w', encoding='utf-8') as fh:
            json.dump(isi, fh, ensure_ascii=False)
        out = os.path.join(tmp, 'Keluaran Uji')
        p = subprocess.run([sys.executable, '-I', '-B', BUILDER, src, '-o', out], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        path = os.path.join(out, isi['keluaran'])
        wb = openpyxl.load_workbook(path)
        vals = [c.value for row_ in wb['COVER'].iter_rows() for c in row_ if isinstance(c.value, str)]
        self.assertIn(self.TEXT, vals)
        lint = subprocess.run([sys.executable, '-I', '-B', os.path.join(SKILL, 'scripts', 'datum_lint.py'), path],
                              capture_output=True, text=True)
        self.assertEqual(lint.returncode, 1, lint.stdout)
        self.assertRegex(lint.stdout, r'\[03\].*dash')


def _read(p):
    with open(p, encoding='utf-8') as fh:
        return fh.read()


class RuleCount(unittest.TestCase):
    def test_28_file_testable_rules_covered(self):
        ids = sorted({m for m in re.findall(r'def test_wb(\d\d)_', _read(__file__))})
        self.assertEqual(ids, ['01', '02', '04', '05', '08', '09', '10', '11', '12', '15', '17', '18', '19', '21',
                               '22', '24', '25', '26', '27', '28', '31', '32', '33', '34', '35', '37', '38', '39'])


if __name__ == '__main__':
    unittest.main()
