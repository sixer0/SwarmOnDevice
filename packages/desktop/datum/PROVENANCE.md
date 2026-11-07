# Provenance: datum-house-style (Swarm 1.2.0 bundled copy, Rev A)

Base: docs/2026-11-06_swarm_1_2_0_datum_installer/test/claude_reference/frozen-skill/ (hash-checked frozen copy of Claude's DATUM skill v1.7 Rev I, GSP-DS-001; 54 files = row 4 inventory = test/claude_reference/SHA256SUMS frozen-skill lines). Row 22 copied it byte-for-byte on 2026-11-07 (cp -Rp, excluding scripts/__pycache__). Rows 99 to 102 and 117/117b then adapted it to GSP Rev A (rows 100/101/102 per decisions C38, C46). Claude's own skill folder is untouched.

This file rewritten by row 103. Recomputed over the bundled tree: 63 files = 54 base files + 9 new. Of the 54 base files, 14 differ from the base and 40 are byte-identical to it.

Row 48a (C103, security review M1/M2) changed scripts/datum_xlsx.py and scripts/datum_diagram.py and added 2 tests: now 65 files = 54 base files + 11 new; of the 54 base files, 15 differ and 39 are byte-identical.

Row 49b (C106, manual DT-28d) changed scripts/datum_docx.py (2 classification runs ALERT to SEAL) and added tests/test_row49b_docx_classification.py: now 66 files = 54 base files + 12 new; of the 54 base files, 16 differ and 38 are byte-identical.

skillSha (sha256 of the bundled SKILL.md, the runtime-manifest field; row 117b, C46 ruling 5):

```
0270ab8118b109bd9d5fc7218fe7f84a4b93e25b532d41e496771265a055c895  SKILL.md
```

Row 156 (C130, decision U24) added the "Output verification" bullets to SKILL.md section 15 (verbatim from masterplan/01_specs_output_verification.md section 8); only SKILL.md changed, file counts are unchanged.

## 1. Base files that differ from the row 4 inventory (16)

| File | Old sha256 (row 4 / v1.7) | New sha256 | Row |
|---|---|---|---|
| SKILL.md | 1629b407fe68dc7a9cf96c41d7b1a9466ec71cf4ea6178e27c542698cf6add7b | 0270ab8118b109bd9d5fc7218fe7f84a4b93e25b532d41e496771265a055c895 | 117, 117b, 156 (C130, final) |
| references/01-kepatuhan-klasifikasi.md | 7f6be78d442bd8c689fb141be3a0ab20afbdecf48ef638c60acd9e788bae58f9 | fe5fdcbc4dd42a38e4d481460b8b8b522b57dd13682a48b6cdfa63cff123b518 | 117 |
| references/02-grid-tipografi.md | bf7f7dcea718860c6b9adaaad355340a99f076e3090f39decca0d0b2da3045a1 | 93a9a5575407125147566635148249b8340c23f29d76e622578d237296def62c | 117, 117b (final) |
| references/03-tabel-gambar-apparatus.md | 069065cf5c97fb0935fc5d219b154fbd9fe6d571d56d2bae962ed70a24934f32 | 5401d711fa578065388bc07b291637a787c0e578bd5214afaee334e047e1c6ff | 117, 117b (final) |
| references/04-workbook.md | 5355fe05974391c76dc45a38200c694946a0ce07ee35f16ac46ff3be6de9a73a | a2b05c89fb13c4ff2938e56f911a9aa614f699deeadb631c5687f60e105d5fd3 | 117 |
| references/05-command-brief.md | 951a27ae7af5ee6520f76a9fada21ef2e0729e8893c658aa7749a52c314d9414 | ad789f2917208a68c4f25b672fba8880ad98c46d8107f671b29fa18dc43a8367 | 117, 117b (final) |
| references/06-lint.md | 5f0f649772a1b864d56770d30efa4df0b3abd087cacb6ad0cc713a9b117ba7d8 | d9b796a31bd117331dde4d5817e8df5d022c1f5f4bb756724947cddfbf7f7319 | 117 |
| references/07-ekosistem-routing.md | d475d43d1440f64d5d16ffd85a0cadd5ecf7dc0f9f5a241fef83c6f644c672ce | c39fd7e0336e05c89f99d6a25bda8b68b7006fdf8780405ce786e50925b252e5 | 117 |
| references/08-skema-diagram.md | bf76d02217faded7c97947ff1643adcb5ab6e2fc26de282176d2aaeca5d7cdfa | 17bcbad42b0e0f429fd0d63b3ffd5ac2f5e75af65b4afa465b1dcfcd34c92cdd | 117 |
| references/09-simbol-standar.md | ae943e0d9ff29a5a69ccbbe181db0e9ecd7a416f1230de4059a0ee7676e711e9 | e435789c79278f6712041737b5131f6abb9574ea563e4d01b3c2d69a7e0edef7 | 117 |
| scripts/datum_diagram.py | be8155fe88c35275c7f6f9ac548f2cae3691b88c79157bca0459840df2366a92 | 5adba0cdb441a9ddec6ac1fb791589a96c2b214cb1e6f0b20c0b7ec1297062cf | 48a (C103) |
| scripts/datum_docx.py | 9871d5fd565e291fb0abc3144878166976279a6a9ebe3ce87866c9ec70d60365 | d7dd62b2b013db01a48cdce8691be4a8568c517e0cf44136d4a4dd03deacdb17 | 49b (C106) |
| scripts/datum_lint.py | 8db92376a0ecb2eae1733e5c23c62eabb3f5a4a188bb38744df900ae814db5d4 | 4ed435a051d6dea907e5f76d2e62449acdd50ca9428aef9ee436b32e4b433bd0 | 102 |
| scripts/datum_pptx.py | 531454e006065cb30eba1c819613d3b8eea2358bc45c1cbe6679cbe399442323 | 4aec32f45badadf0e4ca825f5828f2c2d7c5d29f1a404a34978e9dc2b76ebc57 | 101 (101c final, C87) |
| scripts/datum_xlsx.py | 2cf62971939019e8c35dc51de7ec9be9dcb0cb2b859b518152f5bd728d020c1d | 121a2e9f4e0edd3bf2795994011e9cdb638c77f02cf064b919150cefd2878fb9 | 48a (C103) |
| tokens.json | c440232809f66c19befc75ad76848bf210c6c8db8e48707a79c21618edb644f6 | ff23a87ced75ef81dfc29480ec89c974dbbb1af0d015c8aac70c9990b98849b9 | 99 |

## 2. New files, not in the row 4 inventory (12)

| File | sha256 | Row |
|---|---|---|
| assets/fonts/DejaVuSans.ttf | ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280 | 23 (C46 ruling 1, C49; cp -p from packages/datum-studio/vendor/src/lib/studio/assets/fonts/DejaVuSans.ttf, sha equal to source) |
| assets/fonts/DejaVuSans-Bold.ttf | e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724 | 23 (C46 ruling 1, C49; cp -p from packages/datum-studio/vendor/src/lib/studio/assets/fonts/DejaVuSans-Bold.ttf, sha equal to source) |
| assets/fonts/LICENSE-DejaVu.txt | 0009b5daa1ebfab20b9206c467c62100e1853d379744511ba0f7860f149f7b64 | 23 (C46 ruling 1, C49; cp -p from packages/datum-studio/vendor/src/lib/studio/assets/fonts/LICENSE-DejaVu.txt, sha equal to source) |
| assets/logo/gsp-seal.png | a43657da7dd8e5c06e3474a15b349036a0066011d8272597840f5b3bb8dfe95d | 117b (derived from gsp-tinta.png, recoloured #6E1420, C46 ruling 2) |
| references/rev-a/README.md | a36c86f80f2e05d74068e10438079452ec6302b598abc71a5fe26936f8bf48a4 | 117, 117b (final) |
| references/rev-a/manual_en.txt | c345e440607c4f7364046f27f070416a02f84abf693b1f632270f8dd91dbac42 | 117 |
| references/rev-a/manual_id.txt | 56ba042d594ba39309f839d1b98613dbd8e574dd3c13d5ed96550f847322266c | 117 |
| tests/test_datum_xlsx_rev_a.py | e0ad347cebf9c3b80b10ddeba5eae5080304905613b415ce11180efa61ee7402 | 100 (100c final, C87) |
| tests/test_row101_pptx_br_rules.py | b1b0983b8f8333acc5c5d8801630895e171119ca84a00dc0ef9d2d8f6aa03c20 | 101 (101c final, C87) |
| tests/test_row48a_diagram_png.py | bc41dbc4cf0519d5820865c41c1a129bb6249ade4e6399f9616922af4f73b68c | 48a (C103) |
| tests/test_row48a_formula_injection.py | 13ade25f60cc94bb70431d0c5f63bc84d5f3ef88d2d76c39d0e0b8f78f1cb00c | 48a (C103) |
| tests/test_row49b_docx_classification.py | 941f055ad726cd716f677ae7c69907c1b1d0a70a15e43824d5bc99cb11685070 | 49b (C106) |


## 3. Byte-identical to the row 4 inventory (38)

```
0dca86af29a162a2c6d8f6eaf100bffe9787122e505044f2d140d228cceef980  assets/DATUM Lembar Bukti.pdf
ca564063efd658b173f2be0ac0dd817a9ce8250a8093bded0c9f152df075502e  assets/Sumber Lembar Bukti.html
eed67babf14f4b45de0a57017c1291f37cc96ceede2bc98cbf7873bbd0c0a784  assets/fonts/IBMPlexMono-Italic.ttf
73ac3f3d34ea63d0336449d8312fb8ae163d4bd922c2e78d16b4d7504baa0528  assets/fonts/IBMPlexMono-Regular.ttf
5801cade8aa6cc81bdb3a463e05d55819339b738db383d55863e4a24139d99fd  assets/fonts/IBMPlexMono-SemiBold.ttf
34617bc3fd8a92b16adc6608896e39449336f2c22ef5cf12a261a36a4d6cd235  assets/fonts/IBMPlexMono-SemiBoldItalic.ttf
c6adc2080aa80b36935d1c34fe392180d33bdda4d75945c91bf2c3ccea182498  assets/fonts/IBMPlexSans-Italic.ttf
76e907c029eb4643ae219d9a38a894374e9a92545cb339b81fa321419cf010da  assets/fonts/IBMPlexSans-Regular.ttf
90664322004606a83b106b28009200450aafe8622110367b8d4becd1bb5dd2a0  assets/fonts/IBMPlexSans-SemiBold.ttf
e96c3c1ac695c642591aaebd2fe4068c5326f99507acbcb6c558cc4603451a21  assets/fonts/IBMPlexSans-SemiBoldItalic.ttf
be0b2f99eba64e5e27e7e2ea4610c48d8b097c8d68d9f08bad635252569db1da  assets/fonts/IBMPlexSansCond-Italic.ttf
d3057856ccc7ef347ea104b9b7fb3bf42b7b1befd8b06b9b91c33e5e787a5045  assets/fonts/IBMPlexSansCond-Regular.ttf
09d25ecc8ad8de40f73daa949cc45a5cb43fcc883b5475c0155f54d09c40a471  assets/fonts/IBMPlexSansCond-SemiBold.ttf
0d9e2ff27098bffd12c0e9d634a7705f50c52a36cd78f4ef8ce54d62bea97582  assets/fonts/IBMPlexSansCond-SemiBoldItalic.ttf
075483ede0be9d2db4d3b0b78ea83a43ac0609db4b07a0771cd2f7b45902edf6  assets/fonts/IBMPlexSerif-Italic.ttf
5fdc492c8b95eeb740b75831266bb37d93bd2ff066c1166f30e5db9918001b7b  assets/fonts/IBMPlexSerif-Regular.ttf
07866ea3cc7642e7c11035e557a747be2e61fe7f7487e62a6193cc2b85d2f8d7  assets/fonts/IBMPlexSerif-SemiBold.ttf
aaa6a27ef637f0c45248cdbed9675916441409b1db364162d3724b2b43a78f31  assets/fonts/IBMPlexSerif-SemiBoldItalic.ttf
c34e61350af996f153381fcb4aba65887336c873ee3ed747103290f1718f20a7  assets/fonts/PASANG-DULU.txt
2f4b9bc77aba25bb2df4dcaa3f81ce6d75bcf8c68743dbcf7833852f65857586  assets/logo/gsp-duo.png
8969ac930c18a437681ec1c2464e56a04a353ef549bd3f5e48776fb7f2c467f5  assets/logo/gsp-penuh.png
020443c539fb080397a5ab1069f30276bd9c1ed290cde49c2d77295349015457  assets/logo/gsp-putih.png
69636059ddc4155c66430007d9c8bf280ce44090f408b5ab557f5efd0962111e  assets/logo/gsp-tinta.png
abbc77082c596bcce14104159bec1a7496f02019786ca932b3957266b4252454  assets/logo/gsp-tinta9.png
d9866bd403569564ebec953d3190af21c1bd10496df9650be7047b01e48a8aa3  assets/rules/datum-128.png
e18cd1951b7f0fa5875be0bf518f4d987ef395b44a3400dc2caa8e5e5d773ef5  assets/rules/datum-166.png
63317d01a4ea76b270df6d48161b9fcd71cb8b7e5482b97352756582d55e3b15  assets/rules/datum-gelap.png
c6ec4793fb47c142de2ac5f7dd247248c46987eeae6e379ff11a719ded6be8af  assets/rules/datum-w166.png
e9796186048871ad89c1114ad81adc8f21edcd57efee9a08d5c63303ac05427b  samples/GSP DATUM Contoh Command Brief.pptx
2a98d0fc48d2785914c170ecdc74e3c3c817bf00de8c9a398ebb1596b7aa67d9  samples/GSP DATUM Contoh Laporan Teknis.docx
54b35f6b91881fea08aa76845d22ab6bab8e381cf512873e12929afe671c6d4b  samples/GSP DATUM Contoh RAB.xlsx
37747c9da87e296bcfa168aedbfbef4f15768ef37afc047408c29830598b8f83  scripts/datum_figma_audit.py
9f881183da1d5bdc0128f1a6097d19e97b078381c3d9098f0e7e09119479848a  scripts/datum_render.py
68135583889def34803cd888ef32b9fd283752565e957ba923265dc3a822c950  scripts/datum_symbols.py
5e7bca7f4f62041d688ce53cae4ebdfe51e0e0051e2baf88494681ee94652e54  scripts/datumbind.py
e66a4d2a38937ea4f83517713b73af531395992c1ca9e9770c5db4d83824478d  scripts/datumchart.py
0ae52d57a13f8752cd5d8189f80d9f44985ba5ee3eea98aca53fc0a1db7be7a0  scripts/datumcheck.py
fc0a35d79e39774f047a2b2faeca89e75d539f27da96697402d02e1661d6bd4c  scripts/embed_fonts.py
```
