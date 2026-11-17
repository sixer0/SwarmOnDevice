"""Tes bingkai_lembar.py (hanya unittest, pustaka standar).

Jalankan dari folder ini:  python3 -I -m unittest discover -s . -p 'test_bingkai_lembar.py' -v
(`-I` tidak memasukkan folder kerja ke sys.path, jadi `-m unittest test_bingkai_lembar` saja tidak menemukan modul; `discover -s .` yang melakukannya.)
Golden: testdata/golden_128.svg dan testdata/golden_166.svg. Skrip tidak membuat cap waktu atau id acak,
jadi satu-satunya normalisasi adalah akhir baris (\\r\\n -> \\n). Tes ini tidak boleh ikut dibundel di aplikasi.
"""
import contextlib
import copy
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bingkai_lembar as bl  # noqa: E402

DATA = os.path.join(HERE, "testdata")
SCRIPT = os.path.join(HERE, "bingkai_lembar.py")


def load_meta():
    with open(os.path.join(DATA, "meta.json"), encoding="utf-8") as f:
        return json.load(f)


def slurp(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def norm(s):
    return s.replace("\r\n", "\n")


def run_cli(svg, meta, out):
    return subprocess.run([sys.executable, "-I", SCRIPT, "--svg", svg, "--meta", meta, "--out", out],
                          capture_output=True, text=True)


def frame(n, meta):
    box, inner = bl.read_figure(os.path.join(DATA, "figure_%d.svg" % n))
    return bl.build(box, inner, meta)


class Base(unittest.TestCase):
    def refuses(self, meta, fragment, n=128):
        with self.assertRaises(SystemExit) as cm:
            frame(n, meta)
        self.assertEqual(cm.exception.code, 2)
        return fragment

    def stderr_of(self, meta, n=128):
        with tempfile.TemporaryDirectory() as d:
            mp = os.path.join(d, "m.json")
            with open(mp, "w", encoding="utf-8") as f:
                json.dump(meta, f)
            r = run_cli(os.path.join(DATA, "figure_%d.svg" % n), mp, os.path.join(d, "o.svg"))
            self.assertEqual(r.returncode, 2, r.stdout)
            self.assertFalse(os.path.exists(os.path.join(d, "o.svg")))
            return r.stderr


class TestFieldRefusals(Base):
    FIELDS = [("owner", "OWNER"), ("title", "TITLE"), ("dwg_no", "DWG NO."), ("rev", "REV"),
              ("sheet", "SHEET"), ("classification", "CLASS")]

    def test_each_required_field_empty_is_refused_with_its_name(self):
        for key, label in self.FIELDS:
            meta = load_meta()
            meta[key] = "   "
            err = self.stderr_of(meta)
            self.assertIn("medan strip judul kosong: " + label, err, key)
            self.assertIn("jangan dikarang", err)

    def test_each_required_field_absent_is_refused(self):
        for key, label in self.FIELDS:
            meta = load_meta()
            del meta[key]
            self.assertIn("medan strip judul kosong: " + label, self.stderr_of(meta), key)

    def test_several_missing_fields_are_all_named(self):
        meta = load_meta()
        meta["owner"] = ""
        del meta["rev"]
        self.assertIn("medan strip judul kosong: OWNER, REV", self.stderr_of(meta))

    def test_scale_defaults_to_nts_when_absent(self):
        meta = load_meta()
        del meta["scale"]
        svg, _ = frame(128, meta)
        self.assertIn(">NTS<", svg)

    def test_unknown_key_kind_is_refused(self):
        meta = load_meta()
        meta["key"] = [["bukan_jenis", "x"]]
        err = self.stderr_of(meta)
        self.assertIn("jenis garis kunci tidak dikenal: bukan_jenis", err)
        self.assertIn("accent, alert, control, data, sync, verify", err)

    def test_not_an_svg_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.svg")
            with open(p, "w") as f:
                f.write("bukan svg")
            r = run_cli(p, os.path.join(DATA, "meta.json"), os.path.join(d, "o.svg"))
            self.assertEqual(r.returncode, 2)
            self.assertIn("berkas bukan SVG", r.stderr)

    def test_svg_without_viewbox_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.svg")
            with open(p, "w") as f:
                f.write('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
            r = run_cli(p, os.path.join(DATA, "meta.json"), os.path.join(d, "o.svg"))
            self.assertEqual(r.returncode, 2)
            self.assertIn("SVG tanpa viewBox", r.stderr)

    def test_value_too_long_for_a_narrow_cell_is_refused(self):
        meta = load_meta()
        meta["rev"] = "ABCDEFGHIJ"
        err = self.stderr_of(meta)
        self.assertIn('nilai "ABCDEFGHIJ" terlalu panjang untuk sel REV (maks', err)


class TestTitle(Base):
    def title_texts(self, svg):
        # teks judul memakai font-size 1.9 pada sel TITLE (y = ty+6.4 dan ty+9.3 untuk dua baris)
        return re.findall(r'<text [^>]*font-family="IBM Plex Mono" font-size="1.90"[^>]*>([^<]*)</text>', svg)

    def test_short_title_is_one_line(self):
        meta = load_meta()
        meta["title"] = "Arsitektur VMS"
        svg, _ = frame(128, meta)
        self.assertIn(">Arsitektur VMS<", svg)
        self.assertEqual(len(self.title_texts(svg)), 0)  # satu baris memakai font-size 2.00
        one = re.findall(r'<text x="[\d.]+" y="([\d.]+)" font-family="IBM Plex Mono" font-size="2.00"[^>]*>Arsitektur VMS<', svg)
        self.assertEqual(len(one), 1)

    def test_long_title_splits_in_two_lines_at_a_space(self):
        svg, _ = frame(128, load_meta())  # 52 karakter; sel memuat 42
        lines = self.title_texts(svg)
        self.assertEqual(lines, ["Arsitektur VMS: rekaman di situs,", "manajemen terpusat"])
        ys = [float(y) for y in re.findall(r'<text x="[\d.]+" y="([\d.]+)" font-family="IBM Plex Mono" font-size="1.90"', svg)]
        self.assertAlmostEqual(ys[1] - ys[0], 2.9, places=3)

    def test_title_longer_than_two_lines_is_refused(self):
        meta = load_meta()
        meta["title"] = " ".join(["kata"] * 25)  # 124 karakter > 2 x 42
        self.assertIn("terlalu panjang untuk sel TITLE", self.stderr_of(meta))

    def test_title_without_usable_space_is_refused(self):
        meta = load_meta()
        meta["title"] = "X" * 60
        self.assertIn("terlalu panjang untuk sel TITLE", self.stderr_of(meta))

    def test_title_is_xml_escaped(self):
        meta = load_meta()
        meta["title"] = "A & B <c>"
        svg, _ = frame(128, meta)
        self.assertIn("A &amp; B &lt;c&gt;", svg)


class TestKeyRow(Base):
    def test_key_row_present_with_entries(self):
        svg, _ = frame(128, load_meta())
        self.assertIn(">KEY<", svg)
        for label in ("video", "kendali/API", "subjek"):
            self.assertIn(">%s<" % label, svg)

    def test_no_key_removes_row_and_height(self):
        meta = load_meta()
        meta["key"] = []
        _, (W, H) = frame(128, meta)
        self.assertEqual(W, 142.0)
        self.assertEqual(H, 105.0)  # 111 - KEY_H (6)

    def test_key_overflow_is_refused(self):
        meta = load_meta()
        meta["key"] = [["data", "label sangat %d" % i] for i in range(4)]
        err = self.stderr_of(meta)
        self.assertIn("baris kunci melewati lebar lembar", err)

    def test_same_key_fits_wider_sheet(self):
        meta = load_meta()
        meta["key"] = [["data", "label sangat %d" % i] for i in range(4)]
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            frame(128, meta)
        svg, _ = frame(166, meta)  # 180 mm memuat butir yang sama
        self.assertIn(">KEY<", svg)


class TestSizeArithmetic(Base):
    def outer(self, svg):
        w, h = re.search(r'width="([\d.]+)mm" height="([\d.]+)mm"', svg).groups()
        vb = [float(v) for v in re.search(r'viewBox="([\d. ]+)"', svg).group(1).split()]
        return float(w), float(h), vb

    def test_128_becomes_142(self):
        svg, (W, H) = frame(128, load_meta())
        w, h, vb = self.outer(svg)
        self.assertEqual((w, h), (142.0, 111.0))
        self.assertEqual(vb, [0, 0, 142.0, 111.0])
        self.assertEqual(W - 128, 14.0)  # 2 x (MARGIN 5 + PAD 2)

    def test_166_becomes_180(self):
        svg, (W, H) = frame(166, load_meta())
        w, h, vb = self.outer(svg)
        self.assertEqual((w, h), (180.0, 131.0))
        self.assertEqual(vb, [0, 0, 180.0, 131.0])
        self.assertEqual(W - 166, 14.0)

    def test_height_is_figure_plus_frame_parts(self):
        for n, fh in ((128, 80), (166, 100)):
            _, (W, H) = frame(n, load_meta())
            self.assertEqual(H, 5 + 2 + fh + 2 + 6 + 11 + 5)

    def test_figure_is_embedded_unchanged(self):
        for n in (128, 166):
            raw = slurp(os.path.join(DATA, "figure_%d.svg" % n))
            inner = raw[raw.index(">") + 1:raw.rfind("</svg>")]
            svg, _ = frame(n, load_meta())
            self.assertIn(inner, svg)

    def test_cli_prints_size_line(self):
        with tempfile.TemporaryDirectory() as d:
            r = run_cli(os.path.join(DATA, "figure_166.svg"), os.path.join(DATA, "meta.json"), os.path.join(d, "o.svg"))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("lembar 180.0 x 131.0 mm", r.stdout)


FOOT_RE = re.compile(r'<text x="([\d.]+)" y="([\d.]+)"[^>]*fill="#6B7783"[^>]*>([^<]*)</text>\n</svg>$')


class TestFooter(Base):
    """Baris kaki: status, tanggal, standar dari meta tampil sebagai teks di SVG (ST-8, baris 143)."""

    def test_footer_text_present(self):
        svg, (w, h) = frame(128, load_meta())
        m = FOOT_RE.search(svg)
        self.assertIsNotNone(m, "elemen kaki tidak ada")
        self.assertEqual(m.group(3), "DRAFT \u00b7 2026-11-17 \u00b7 IEC 62676-4:2025")
        self.assertGreater(float(m.group(2)), h - 5.0)  # di jalur bawah, di dalam lembar
        self.assertLess(float(m.group(2)), h)

    def test_footer_partial_and_absent(self):
        meta = load_meta()
        meta["date"] = ""
        svg, _ = frame(128, meta)
        self.assertIn("DRAFT \u00b7 IEC 62676-4:2025</text>", svg)
        for k in ("status", "date", "standards"):
            meta.pop(k, None)
        svg, _ = frame(128, meta)
        self.assertIsNone(FOOT_RE.search(svg))


class TestGolden(Base):
    """Normalisasi: hanya akhir baris. Skrip deterministik (tanpa cap waktu, tanpa id acak)."""

    def check(self, n):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "o.svg")
            r = run_cli(os.path.join(DATA, "figure_%d.svg" % n), os.path.join(DATA, "meta.json"), out)
            self.assertEqual(r.returncode, 0, r.stderr)
            got = norm(slurp(out))
        want = norm(slurp(os.path.join(DATA, "golden_%d.svg" % n)))
        self.assertEqual(got, want)

    def test_golden_128(self):
        self.check(128)

    def test_golden_166(self):
        self.check(166)

    def test_deterministic_two_runs(self):
        a, _ = frame(128, load_meta())
        b, _ = frame(128, copy.deepcopy(load_meta()))
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
