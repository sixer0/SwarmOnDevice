"""Row 148 (security finding L1): the builder writes its five files only as regular files inside `--out`.

A name in `--out` that is a symbolic link or a folder, or an `--out` that is itself a link, stops the build before
anything is written. Each file is written to a temporary name inside `--out` and renamed over the old one, so a link or
a hard link that appears at an output name is replaced, never written through. Standard library only; the library is a
synthetic two-file bank in a temporary folder.
"""
import os, shutil, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_kl_index as b

BUILDER = os.path.join(HERE, "build_kl_index.py")
NAMES = ["indeks_struktur.json", "indeks_pemicu.json", "indeks_struktur.md", "indeks_pemicu.md", "indeks_pemicu_ringkas.md"]


def run(root, out):
    return subprocess.run([sys.executable, "-I", BUILDER, "--root", root, "--out", out],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)


class OutSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "bank")
        for rel, text in [("04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-1.md", "---\nreference_id: REF-1\ntitle: kartu\n---\nisi\n"),
                          ("05_DOMAIN-KNOWLEDGE/FIBER-OPTIC/RESUME.md", "## Satu\nisi\n")]:
            os.makedirs(os.path.dirname(os.path.join(self.root, rel)), exist_ok=True)
            with open(os.path.join(self.root, rel), "w", encoding="utf-8") as f:
                f.write(text)
        self.out = os.path.join(self.tmp, "out")
        self.away = os.path.join(self.tmp, "away")
        os.makedirs(self.away)
        self.victim = os.path.join(self.away, "victim.txt")
        with open(self.victim, "w", encoding="utf-8") as f:
            f.write("unchanged\n")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def victim_text(self):
        with open(self.victim, encoding="utf-8") as f:
            return f.read()

    def assert_refused(self, result, word):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(word, result.stderr)
        self.assertEqual(self.victim_text(), "unchanged\n")

    def test_the_builder_names_the_five_files_it_writes(self):
        self.assertEqual(list(b.OUTPUT_FILES), NAMES)

    def test_a_plain_build_writes_five_regular_files_and_no_temporary_file(self):
        result = run(self.root, self.out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(os.listdir(self.out)), sorted(NAMES))
        mask = os.umask(0)
        os.umask(mask)
        for name in NAMES:
            info = os.lstat(os.path.join(self.out, name))
            self.assertTrue(os.path.isfile(os.path.join(self.out, name)) and not os.path.islink(os.path.join(self.out, name)))
            self.assertEqual(info.st_mode & 0o777, 0o666 & ~mask, name)
        # A second build over the first replaces the regular files.
        self.assertEqual(run(self.root, self.out).returncode, 0)
        self.assertEqual(sorted(os.listdir(self.out)), sorted(NAMES))

    def test_a_symlink_at_any_output_name_is_refused_and_nothing_is_written(self):
        for name in NAMES:
            with self.subTest(name=name):
                shutil.rmtree(self.out, ignore_errors=True)
                os.makedirs(self.out)
                os.symlink(self.victim, os.path.join(self.out, name))
                self.assert_refused(run(self.root, self.out), name)
                self.assertEqual(os.listdir(self.out), [name])

    def test_a_dangling_symlink_at_an_output_name_is_refused(self):
        os.makedirs(self.out)
        os.symlink(os.path.join(self.away, "new.txt"), os.path.join(self.out, "indeks_pemicu.md"))
        self.assert_refused(run(self.root, self.out), "indeks_pemicu.md")
        self.assertFalse(os.path.lexists(os.path.join(self.away, "new.txt")))

    def test_a_folder_at_an_output_name_is_refused(self):
        os.makedirs(os.path.join(self.out, "indeks_struktur.json"))
        self.assert_refused(run(self.root, self.out), "indeks_struktur.json")

    def test_an_out_folder_that_is_a_symlink_is_refused(self):
        os.symlink(self.away, self.out)
        self.assert_refused(run(self.root, self.out), "--out")
        self.assertEqual(os.listdir(self.away), ["victim.txt"])

    def test_a_hard_link_at_an_output_name_is_replaced_not_written_through(self):
        os.makedirs(self.out)
        os.link(self.victim, os.path.join(self.out, "indeks_struktur.md"))
        result = run(self.root, self.out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.victim_text(), "unchanged\n")
        self.assertEqual(os.stat(self.victim).st_nlink, 1)

    def test_both_write_paths_refuse_a_symlink(self):
        # With a folder descriptor where the platform has one, by path elsewhere: both refuse the same way.
        for use_dir_fd in ([False, True] if b.dir_fd_supported() else [False]):
            with self.subTest(use_dir_fd=use_dir_fd):
                shutil.rmtree(self.out, ignore_errors=True)
                os.makedirs(self.out)
                os.symlink(self.victim, os.path.join(self.out, "indeks_pemicu.json"))
                with self.assertRaises(SystemExit):
                    b.write_outputs(self.out, [(n, "x\n") for n in NAMES], use_dir_fd=use_dir_fd)
                self.assertEqual(self.victim_text(), "unchanged\n")
                self.assertEqual(os.listdir(self.out), ["indeks_pemicu.json"])
                os.unlink(os.path.join(self.out, "indeks_pemicu.json"))
                b.write_outputs(self.out, [(n, "x\n") for n in NAMES], use_dir_fd=use_dir_fd)
                self.assertEqual(sorted(os.listdir(self.out)), sorted(NAMES))

    def test_a_name_with_a_folder_part_is_refused(self):
        os.makedirs(self.out)
        for name in ["../x.md", "a/x.md", "", ".", ".."]:
            with self.subTest(name=name), self.assertRaises(SystemExit):
                b.write_outputs(self.out, [(name, "x\n")])
        self.assertEqual(os.listdir(self.out), [])


if __name__ == "__main__":
    unittest.main()
