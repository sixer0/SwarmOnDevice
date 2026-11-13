# Rev A manual text (bundled for DATUM in Swarm)

Plain-text extracts of the two editions of the GSP Writing Manual Rev A, the standard this skill
follows. Internal GSP use only (classification of the source: TERBATAS, master copy for internal
GSP use, ID p.1 / EN p.1).

| File | Edition | Pages | sha256 of this file |
|---|---|---|---|
| `manual_id.txt` | Manual Penulisan PT GSP Bahasa Indonesia, XXX/GSP/STD/XI/2026, Revisi A, 2 November 2026 | 98 | `56ba042d594ba39309f839d1b98613dbd8e574dd3c13d5ed96550f847322266c` |
| `manual_en.txt` | GSP English Writing Manual, XXX/GSP/STD/XI/2026, Revision A, 3 November 2026 | 99 | `c345e440607c4f7364046f27f070416a02f84abf693b1f632270f8dd91dbac42` |

Source PDFs (not shipped here):

| PDF | sha256 |
|---|---|
| `Manual Penulisan PT GSP Bahasa Indonesia XXX-GSP-STD-XI-2026 RevA.pdf` | `41ab78c4e465746b8b745a9b15df7155eecc1aabba3f0fd1467e94afae0cd62f` |
| `GSP English Writing Manual XXX-GSP-STD-XI-2026 RevA.pdf` | `7dfafb0a1643da1f0bb5c090eb8585a27c1b2631f5bc216d53474287976910df` |

**How to read them.** Each page starts with a line `===== page N =====`; N equals the sheet number
printed in the page footer ("LEMBAR N DARI 98" / "SHEET N OF 99"). Citations in SKILL.md and
references 01 to 09 use these numbers as "(ID p.N / EN p.N)".

**Known limits of the text layer.** Figures are images, so figure content is missing; only the
captions are text. The right-hand TEST column of each coded rule is interleaved with the rule
text and partly scrambled; where a test reads garbled, check the PDF. DT-06 and DT-15 were
re-read from the PDFs in the Swarm 1.2.0 research (row 77) for that reason.

**Provenance.** Byte copies of `research/manual_rev_a/manual_id.txt` and `manual_en.txt` of the
Swarm 1.2.0 task folder (docs/2026-11-06_swarm_1_2_0_datum_installer), whose `SHA256SUMS` lists
the two PDFs above. Copied 2026-11-07 by row 117; `cmp` against the source reported no difference.
The empty table-of-contents extracts (`manual_id.toc.txt`, `manual_en.toc.txt`, 0 bytes) were not
copied.

Do not edit the manual texts. If the manual is revised, replace both files and this README together
and re-check every citation in SKILL.md and references 01 to 09.

## Logo provenance: assets/logo/gsp-seal.png (decision C46, row 117b)

The ID edition reads the logo as seal #6E1420 (DT-13c test, ID p.48); the EN edition keeps it
black (Table 8.1, EN p.51). No seal-coloured logo shipped with the skill, so one was derived.

| File | sha256 |
|---|---|
| source `assets/logo/gsp-tinta.png` (RGBA 2390 × 1285, one opaque colour RGB 20, 17, 15) | `69636059ddc4155c66430007d9c8bf280ce44090f408b5ab557f5efd0962111e` |
| derived `assets/logo/gsp-seal.png` (RGBA 2390 × 1285, one opaque colour RGB 110, 20, 32) | `a43657da7dd8e5c06e3474a15b349036a0066011d8272597840f5b3bb8dfe95d` |

Method: Pillow under the row 15 probe Python (`tools/build/datum_runtime_probe/python/bin/python3.14
-I -B`), a one-off recolour script (not shipped): open the source as RGBA, make a
same-size image filled with #6E1420, put the source's alpha channel on it unchanged, save PNG.
Checked by the script: alpha channel byte-identical to the source; the only opaque colour is
(110, 20, 32). The shape is unchanged; only the ink colour differs.
