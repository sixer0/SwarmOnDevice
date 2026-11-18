import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_kl_index as b

DIAG = "DIAGRAM-STANDARD"
WORDS = ["diagram", "gambar", "topologi", "arsitektur", "satu garis", "urutan", "jadwal", "alur"]


def triggers():
    t = {"domains": {}}
    for d, e in b.EXTERNAL_DOMAINS.items():
        t["domains"][d] = {"terms": e["terms"], "read_order": e["read_order"]}
    t["domains"]["FIBER-OPTIC"] = {"terms": b.SEED["FIBER-OPTIC"].split(), "read_order": ["x"]}
    t["domains"]["STORAGE"] = {"terms": b.SEED["STORAGE"].split(), "read_order": ["y"]}
    return t


class DiagramDomain(unittest.TestCase):
    def test_words_exact(self):
        self.assertEqual(b.EXTERNAL_DOMAINS[DIAG]["terms"], WORDS)

    def test_first_file_is_skill_reference_index(self):
        self.assertEqual(b.EXTERNAL_DOMAINS[DIAG]["read_order"][0], "skill:gsp-diagram-standard/references/index.md")

    def test_match_topologi(self):
        self.assertIn(DIAG, b.match(triggers(), "buat diagram topologi"))

    def test_phrase_satu_garis(self):
        self.assertIn(DIAG, b.match(triggers(), "gambar satu garis panel"))

    def test_weak_word_alone_does_not_trigger(self):
        for w in ("gambar", "alur", "urutan", "jadwal"):
            self.assertNotIn(DIAG, b.match(triggers(), "tolong lihat %s" % w))

    def test_two_weak_words_trigger(self):
        self.assertIn(DIAG, b.match(triggers(), "jadwal dan alur"))

    def test_other_domains_unchanged(self):
        r = b.match(triggers(), "hitung anggaran rugi ruas serat dan kapasitas penyimpanan rekaman 30 hari")
        self.assertIn("FIBER-OPTIC", r); self.assertIn("STORAGE", r); self.assertNotIn(DIAG, r)
        self.assertEqual(b.match(triggers(), "notulen rapat dan surat undangan"), {})

    def test_weak_list_sorted_and_complete(self):
        self.assertEqual(sorted(b.WEAK), sorted(set(b.WEAK)))
        for w in ("alur", "urutan", "jadwal", "gambar"):
            self.assertIn(w, b.WEAK)


if __name__ == "__main__":
    unittest.main()
