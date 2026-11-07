"""Row 48a (decision C103, security review row 48 M2): datum_diagram.py --png runs no shell.

to_png() used os.system() with the --png / -o paths inside a shell string, so a file name
holding $(...) or backticks ran a command. It now passes argument lists to subprocess.run().

    python3 -I -B -m unittest discover -s tests -p 'test_row48a_diagram*.py' -v

A fake rsvg-convert placed first on PATH records its arguments and writes the PNG, so the test
needs no real converter; a real rsvg-convert, when one is on PATH, is exercised as well.
"""
import importlib.util, os, shutil, stat, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), 'scripts', 'datum_diagram.py')

_spec = importlib.util.spec_from_file_location('datum_diagram_row48a', SCRIPT)
dd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dd)

SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10">'
       '<rect width="10" height="10" fill="#101418"/></svg>')
FAKE = """#!/bin/sh
# fake rsvg-convert: one argument per line into ARGS, then write the -o file
for a in "$@"; do printf '%s\\n' "$a"; done > "$ROW48A_ARGS"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift; fi
  shift
done
printf 'PNG' > "$out"
"""
PROBES = ('o$(touch INJECTED).png', 'o`touch INJECTED`.png', 'o"; touch INJECTED; ".png')


class Scratch(unittest.TestCase):
    def setUp(self):
        self.old = os.getcwd(), os.environ.get('PATH', ''), os.environ.get('ROW48A_ARGS')
        self.dir = tempfile.mkdtemp(prefix='row48a-png-')
        os.chdir(self.dir)
        with open('in.svg', 'w', encoding='utf-8') as f:
            f.write(SVG)

    def tearDown(self):
        os.chdir(self.old[0])
        os.environ['PATH'] = self.old[1]
        if self.old[2] is None:
            os.environ.pop('ROW48A_ARGS', None)
        else:
            os.environ['ROW48A_ARGS'] = self.old[2]
        shutil.rmtree(self.dir, ignore_errors=True)

    def fake_path(self):
        bin_dir = os.path.join(self.dir, 'bin')
        os.mkdir(bin_dir)
        exe = os.path.join(bin_dir, 'rsvg-convert')
        with open(exe, 'w', encoding='utf-8') as f:
            f.write(FAKE)
        os.chmod(exe, stat.S_IRWXU)
        os.environ['PATH'] = bin_dir + os.pathsep + '/usr/bin:/bin'
        os.environ['ROW48A_ARGS'] = os.path.join(self.dir, 'args.txt')


class ToPngRunsNoShell(Scratch):
    def test_injection_probes_create_no_marker_and_reach_the_converter_verbatim(self):
        self.fake_path()
        for png in PROBES:
            ok = dd.to_png('in.svg', png, 100)
            self.assertFalse(os.path.exists('INJECTED'), f'{png}: a shell ran the name')
            self.assertTrue(ok, png)
            self.assertTrue(os.path.isfile(png), png)        # the literal name was written
            with open(os.environ['ROW48A_ARGS'], encoding='utf-8') as f:
                self.assertEqual(f.read().splitlines(), ['-w', '100', '-o', png, 'in.svg'])

    @unittest.skipIf(any(os.access(os.path.join(d, 'rsvg-convert'), os.X_OK) for d in ('/usr/bin', '/bin')),
                     'a system rsvg-convert exists')
    def test_no_converter_creates_no_marker(self):
        empty = os.path.join(self.dir, 'empty')
        os.mkdir(empty)
        os.environ['PATH'] = empty + os.pathsep + '/usr/bin:/bin'    # touch reachable, no converter
        for png in PROBES:
            dd.to_png('in.svg', png, 100)                     # False unless cairosvg is installed
            self.assertFalse(os.path.exists('INJECTED'), png)

    @unittest.skipUnless(shutil.which('rsvg-convert'), 'no real rsvg-convert on PATH')
    def test_real_converter_still_writes_png(self):
        self.assertTrue(dd.to_png('in.svg', 'out.png', 64))
        with open('out.png', 'rb') as f:
            self.assertEqual(f.read(8), b'\x89PNG\r\n\x1a\n')


class ArgumentLists(unittest.TestCase):
    def test_lists_keep_each_path_as_one_argument(self):
        rsvg, inkscape = dd.png_commands('a b.svg', 'o$(x).png', 2000)
        self.assertEqual(rsvg, ['rsvg-convert', '-w', '2000', '-o', 'o$(x).png', 'a b.svg'])
        self.assertEqual(inkscape, ['inkscape', '--export-type=png', '--export-width=2000',
                                    '--export-filename=o$(x).png', 'a b.svg'])

    def test_leading_dash_is_not_an_option(self):
        rsvg, inkscape = dd.png_commands('-in.svg', '--o.png', 10)
        self.assertEqual(rsvg[-3:], ['-o', os.path.join('.', '--o.png'), os.path.join('.', '-in.svg')])
        self.assertEqual(inkscape[-1], os.path.join('.', '-in.svg'))

    def test_no_shell_left_in_the_script(self):
        with open(SCRIPT, encoding='utf-8') as f:
            src = f.read()
        self.assertFalse('os.system(' in src, 'os.system( in datum_diagram.py')
        self.assertFalse('shell=True' in src, 'shell=True in datum_diagram.py')


if __name__ == '__main__':
    unittest.main()
