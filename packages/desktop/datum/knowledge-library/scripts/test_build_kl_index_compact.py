import json, os, sys, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_kl_index as b


def staged():
    with open(os.path.join(HERE, "indeks_pemicu.json"), encoding="utf-8") as f:
        return json.load(f)


class CompactIndex(unittest.TestCase):
    """Row 97 (KL-1 item 2, C7 item 1): the compact index is short enough for the knowledge-library skill body."""

    def test_staged_file_is_builder_output(self):
        with open(os.path.join(HERE, "indeks_pemicu_ringkas.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), b.md_compact(staged()))

    def test_fits_its_budget(self):
        self.assertLessEqual(len(b.md_compact(staged()).encode("utf-8")), b.COMPACT_MAX_BYTES)
        self.assertLessEqual(b.COMPACT_MAX_BYTES, 1040)

    def test_one_line_per_domain_with_a_strong_word_first(self):
        t = staged()
        weak = set(t["weak"])
        lines = b.md_compact(t).splitlines()
        for d, e in t["domains"].items():
            line = next(l for l in lines if l.split(":")[0].split(" ")[0] == d)
            words = line.split(": ", 1)[1].split(" ")
            strong = [w for w in e["terms"] if w not in weak]
            if strong:
                self.assertEqual(words[0], strong[0].split(" ")[0], d)
            self.assertTrue(set(words) <= set(" ".join(e["terms"]).split(" ")), d)

    def test_skill_prefixed_first_file_is_shown(self):
        line = next(l for l in b.md_compact(staged()).splitlines() if l.startswith("DIAGRAM-STANDARD"))
        self.assertTrue(line.startswith("DIAGRAM-STANDARD (skill:gsp-diagram-standard/references/index.md): diagram"))

    def test_more_room_gives_more_words_never_fewer(self):
        t = staged()
        small = b.md_compact(t)
        large = b.md_compact(t, limit=4096)
        self.assertGreater(len(large), len(small))
        for a, z in zip(small.splitlines(), large.splitlines()):
            self.assertTrue(z.startswith(a), a)

    def test_too_small_a_budget_fails_the_build(self):
        with self.assertRaises(SystemExit):
            b.md_compact(staged(), limit=200)

    def test_no_internal_abbreviation_and_no_template_tokens(self):
        text = b.md_compact(staged())
        self.assertNotIn("EKAS", text.upper().replace("EKAS-LAPIS", ""))
        for token in ("{{", "!`", "$1", "$ARGUMENTS", " @"):
            self.assertNotIn(token, text)


if __name__ == "__main__":
    unittest.main()
