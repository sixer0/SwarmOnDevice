"""Row 49b (decision C106, manual Rev A DT-28d): datum_docx.py prints the classification in seal #6E1420, bold.

The running head run and the register run used ALERT (#9B1C1C). The test runs the demo builder into a
temp dir and reads header/footer XML: every run whose text is the classification word must be bold
and coloured with the token colour.seal.

    python3 -I -B -m unittest discover -s tests -p 'test_row49b*.py' -v
"""
import json, os, re, subprocess, sys, tempfile, unittest, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
SCRIPT = os.path.join(SKILL, 'scripts', 'datum_docx.py')
SEAL = json.load(open(os.path.join(SKILL, 'tokens.json')))['colour']['wrapper']['seal'].lstrip('#').upper()
CLASS = 'RAHASIA'


class DocxClassification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='row49b_')
        env = dict(os.environ, DATUM_OUT=cls.tmp)
        r = subprocess.run([sys.executable, '-I', '-B', SCRIPT], env=env, cwd=cls.tmp,
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr[-2000:]
        z = zipfile.ZipFile(os.path.join(cls.tmp, 'GSP DATUM Contoh Laporan Teknis.docx'))
        cls.parts = {n: z.read(n).decode('utf8') for n in z.namelist()
                     if re.match(r'word/(header|footer)\d*\.xml$', n)}

    def runs(self, prefix):
        out = []
        for n, x in self.parts.items():
            if not n.startswith('word/' + prefix): continue
            for m in re.finditer(r'<w:r>.*?</w:r>|<w:r [^>]*>.*?</w:r>', x, re.S):
                t = ''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', m.group(0)))
                if t.strip() == CLASS: out.append(m.group(0))
        return out

    def check(self, prefix):
        rs = self.runs(prefix)
        self.assertEqual(len(rs), 1, 'one classification run expected in %s*' % prefix)
        self.assertRegex(rs[0], r'<w:color w:val="%s"' % SEAL)
        self.assertRegex(rs[0], r'<w:b/>|<w:b w:val="(1|true)"/>')
        self.assertNotIn('9B1C1C', rs[0].upper())

    def test_running_head_classification_is_seal_bold(self): self.check('header')
    def test_register_classification_is_seal_bold(self): self.check('footer')
    def test_seal_token_is_6e1420(self): self.assertEqual(SEAL, '6E1420')


if __name__ == '__main__':
    unittest.main()
