# 02 · Grid, Tipografi, Perangkat Halaman, Angka

Standard: GSP Writing Manual Rev A, Chapter 8 (ID p.45-53 / EN p.47-56), Chapter 6 (ID p.35-37 /
EN p.36-38) and Annex A (ID p.89-90 / EN p.91-92). Citations are **(ID p.N / EN p.N)**;
"[v1.7, Rev A silent]" marks a v1.7 rule the manual does not state and that is kept.

Take colour, type, grid and rule values from `tokens.json`; where prose differs, `tokens.json`
wins, except the rulings recorded in Annex A (DT-03, ID p.45 / EN p.47). Annex A's five rulings
beat the tokens: classification in seal and letters in black, rules and ticks ≥ 0.18 mm,
ANSI/ISA-5.1-2024, hyphenated sheet names, Spine String on cover, back cover and dividers
(ID p.89 / EN p.91).

---

## 1 · Page geometry, A4 210 × 297 mm (Derivation 8.6a, Table 8.3, Annex A.3)

```
        24 mm          128 mm text          6      32 mm rail        20 mm
      |<---->|<-------------------------->|<-->|<-------------->|<---->|
 13mm +------+--------- running head -----+----+----------------+------+  <- 0.26 mm seal rule
 26mm +---------------------- body top --------------------------------+
      |   text column                        gutter   evidence rail    |
      |   66 to 80 characters                          empty is correct |
273mm +-------------------- body bottom -------------------------------+
284mm +--------------- register block (8.5 mm) ------------------------+
```

- **Width:** 24 + 128 + 6 + 32 + 20 = 210 mm; full span 128 + 6 + 32 = 166 mm; 12 subcolumns of
  10.667 mm (ID p.51 / EN p.53). If the paper is not A4, derive the grid again.
- **Vertical limits from the top edge:** running head 13, body top 26, body bottom 273, foot with
  the 8.5 mm register block 284 (297 − 13); text block 247 mm (Table 8.3, ID p.52 / EN p.54).
- **Width rule (DT-10a, ID p.51 / EN p.53):** nothing wider than 166 mm; every figure 128 or
  166 mm. ID: maps, charts and wide tables may reach 166 mm. EN: figures 128 mm, 166 mm only for
  maps, charts and wide tables.
- **Baseline (DT-10b, BAKU, ID p.52 / EN p.54):** body spacing, heading space, table rows and
  figure heights are whole multiples of 13.5 pt. **Measure 66 to 80 characters** (check 15, at
  this BAKU level: a departure needs a one-sentence reason in the change log).
- The Datum Rule's ticks fall on the 12 subcolumn boundaries [v1.7, Rev A silent on the tick
  positions; tick count and weight in §4].
- Measure at 9.5 pt Plex Serif over 128 mm ≈ 74 to 78 characters [v1.7, Rev A silent].

For a 16:9 command brief the geometry changes: `05-command-brief.md`.

---

## 2 · Faces and distribution

Four IBM Plex faces (Figure 8.4, Annex A.2, ID p.50, p.89 / EN p.51, p.91):

| Role | Face | Weights |
|---|---|---|
| Structure | IBM Plex Sans Condensed (Cond) | 400, 500 (running head), 600 (+ italics) |
| Reading | IBM Plex Serif | 400, 600 (+ italics) |
| Data | IBM Plex Mono: every numeral, ID, coordinate, register block and rail (ID p.49) | 400, 600 |
| Workbook | IBM Plex Sans | workbook cells only |

**DejaVu Sans is embedded** for ■ ◈ ◇ △, Greek letters, √ ≤ and → (ID p.49 / EN p.51; Annex A.2).
Units in a table column are Cond 7.2 pt ink400; units in prose follow the prose face (ID p.49).

- **Plex only (DT-08a, lint 5, ID p.50 / EN p.52).** No Calibri, Times New Roman, Aptos or Arial
  as body face. Exception: a Tata Naskah Dinas letter in Arial 12 (DT-32).
- **Embedding (DT-09, ID p.50 / EN p.52).** Every `.docx` embeds its fonts (`embed_fonts.py`, OOXML
  obfuscated `.odttf`); a PDF always embeds; an `.xlsx` or `.pptx` ships with the font folder
  (`assets/fonts/` with `PASANG-DULU.txt`).
- **Fallback** only when a client edits and cannot install fonts: **Segoe UI Semibold, Georgia,
  Consolas** (ID p.50 / EN p.52). Prefer embedding over falling back [v1.7, Rev A silent].
- **Labels (DT-08b, BAKU, ID p.50 / EN p.52).** Capital labels in Cond at +0.09 em (kickers have
  their own tracking, Table 8.2), display titles at −0.012 em, prose #2B3640. Never a small label
  made of shrunken Serif.

---

## 3 · Type scale, baseline 13.5 pt (Table 8.2, Annex A.2, ID p.50, p.89-90 / EN p.52, p.91)

| Element | Size / leading | Face | Colour | Notes |
|---|---|---|---|---|
| Chapter title (H1) | 16 / 20 pt | Cond 600 | ink900 | Datum Rule above |
| Chapter kicker | 6.8 / 9 pt, +0.16 em, capitals | Cond 600 | signal | e.g. `BAB 5` |
| Section (H2) | 11 / 13.5 pt | Cond 600 | ink900 | number in Mono 8 pt ink400 [v1.7, Rev A silent] |
| Subsection (H3) | 9.5 / 13.5 pt | Cond 600 | ink900 | no fourth level (ID p.46) |
| Body | 9.5 / 13.5 pt | Serif 400 | ink700 | justified, hyphenated [v1.7, Rev A silent] |
| Table body | 8.2 / 11.5 pt | Serif 400 | ink700 | |
| Table numerals | 7.8 / 11.5 pt | Mono 400 | ink900 | flush right |
| Table header | 6.8 / 9 pt, +0.09 em, capitals | Cond 600 | ink400 | bottom-aligned [v1.7, Rev A silent] |
| Group band | 7.4 pt, +0.08 em, capitals | Cond 600 | ink900 | no fill [v1.7, Rev A silent on size] |
| Caption | 7.6 / 11 pt | Cond 400 | ink700 | label in bold capitals (DT-15) |
| SOURCE line | 6.6 / 9 pt | Cond 400 | ink400 | above a 0.20 mm rule |
| Evidence rail | 5.9 pt | Mono 400 | ink400 | |
| Running head | 6.8 / 9 pt, +0.09 em, capitals | Cond 500 | ink400 | classification bold seal |
| Register block | 6.2 pt | Mono 400 | ink400 | numbers bold ink900 |
| Spine String | 6 / 8.4 pt, rotated 90° | Mono 400 | w-meta | |
| Derivation | 7.4 / 11.5 pt | Mono 400 | ink900 | operator-aligned [v1.7] |
| Cover title · kicker · Seal Band | 24 to 26 · 7.4 · 6.4 pt | Cond 600 | w-ink · seal · #F4F5F6 | |
| Drawing text | node 7.6, connector 6.2, minimum 5.5 pt | Cond | ink900 | |

**Numerals are tabular lining everywhere**, which is automatic because every numeral is set in
Plex Mono [v1.7; Rev A: Mono for every numeral, ID p.49].

**Tracking.** Display type −0.012 em; capital micro-labels +0.09 em in the condensed face
(DT-08b, ID p.50 / EN p.52).

---

## 4 · Rules and tints (Annex A.4, Table A.3, ID p.90 / EN p.92)

Word sets rule weight as `w:sz` in eighths of a point: `w:sz = mm × 22.68`, nearest value,
**never below 5**.

| Use | mm | w:sz | Colour |
|---|---|---|---|
| Above table head, above total | 0.45 | 10 | ink900 |
| Row divider, SOURCE rule, register bottom | 0.20 | 5 | ink200 |
| Below table head · running-head closing rule | 0.25 · 0.26 | 6 | ink400 · seal |
| Register top | 0.35 | 8 | seal |
| Revision bar, figure accent | 0.50 | 11 | ink900, signal |
| Datum Rule (1.15 mm ticks) | 0.20, ticks 0.18 | 5 | ink900 |
| Drawing nodes and connectors | 0.30 | 7 | by kind |

- **Floor (DT-11a, lint 21, ID p.53 / EN p.56):** no rule below 0.18 mm; in Word never below
  w:sz 5 (0.22 mm). This floor beats `tokens.json`.
- **Tints (DT-11b, ID p.53 / EN p.56):** exactly 15 % or 30 %. ink100 is about a 5 % tone (E-07),
  so a 0.20 mm row divider replaces zebra striping. Diagram fills hatched at 45° and 135°.
- **Photocopy test (DT-11c, ID p.53 / EN p.56):** every SERAH document, by a checker who is not
  the writer: print at 100 %, copy twice, read at 40 cm.

---

## 5 · Cover and control sheet (8.2, ID p.47-48 / EN p.49-50)

Order down the page, **every element ranged left at 24 mm, never centred** (DT-14, lint 6):

1. **Seal Band**, seal fill, 5 mm × 166 mm, text #F4F5F6 6.4 pt Cond 600 capitals. Left
   `KLASIFIKASI · RAHASIA`; right `SALINAN 03 DARI 06 · TIDAK UNTUK DIEDARKAN`, or
   `SALINAN INDUK · PENGGUNAAN INTERNAL GSP` on the master copy (Table 8.1, Annex A.5, ID p.49,
   p.90 / EN p.51, p.92).
2. **Logo**, 44 to 46 mm wide. Once in the whole document, on the cover. ID: logo in seal
   (DT-13c test, ID p.48) → `assets/logo/gsp-seal.png`; EN: black ink (Table 8.1, EN p.51) →
   `assets/logo/gsp-tinta.png`. [gsp-seal.png = gsp-tinta.png recoloured to #6E1420, alpha kept,
   decision C46; provenance in `references/rev-a/README.md`.]
3. **Address line**, 7 pt Cond w-meta, fixed text, closed by a 0.18 mm w-rule:
   `Divisi Engineering & Technical Intelligence · Jl. Bangka Raya No. 27, Pela Mampang, Jakarta
   Selatan 12720 · Tel. (021) 22715320` (ID p.49 / EN p.51).
4. **Clear space** with no element, down to the Datum Rule.
5. **Datum Rule**, 166 mm.
6. **Document-type kicker**, 7.4 pt Cond 600 seal, +0.20 em, naming the document type.
7. **Title**, 24 to 26 pt Cond 600 w-ink, longest line ≤ 150 mm, negative tracking.
8. **Standfirst**, 10.5 pt Serif italic w-body.
9. **Scope line**, 7.6 pt Cond w-meta.
10. **Control block**, 4 × 2 under a 0.45 mm rule; labels 6.4 pt Cond, values 7.4 pt Mono: nomor
    dokumen · revisi · penyusun · kustodian · ditujukan kepada · halaman · datum geodetik ·
    verifikasi. **Penyusun is always "Divisi Engineering PT GSP"** (EN "Engineering Division,
    PT GSP").
11. **Colophon**: entity and NIB left in w-meta (`PT GEMILANG SATRIA PERKASA · NIB 9120208940517`),
    Issue Stamp right in bold seal (Table 8.1, ID p.49 / EN p.51).
12. **Spine String**, 6 pt Mono rotated 90° in the outer margin.

**Control sheet** (ID p.48 / EN p.49): follows the cover, opens with the Seal Band, and holds the
revision history, a three-layer verification chain, the method statement, controlled
distribution and three signature columns. Every numbered copy in the Seal Band appears in the
distribution list with a named holder (DT-13b, ID p.48 / EN p.50).

**Sheet counting.** ID: cover, control sheet and dividers carry no number; numbering starts on the
first page of Bab 1 (ID p.48). EN: sheets count from the cover (EN p.50). A document over 20
pages has a contents list to section level. Order of the wrapper for TERBIT and SERAH: cover,
control sheet, signatures, contents, then Bab 1 [Interpretation: row 76 CP-09 reading of DT-02
and 8.2]. NOTA has no wrapper.

---

## 6 · Interior page furniture

**Chapters (DT-13a, ID p.46 / EN p.48).** Each chapter starts a new Word section. No logo on
interior pages. Headings to three levels (4, 4.2, 4.2.1); numbered equations right-aligned and
cited as "Persamaan 4.1".

**Running head (Table 8.1, ID p.49 / EN p.51).** 6.8 pt Cond 500 ink400, +0.09 em, capitals.
Left: entity, division and the chapter actually on that page; right: **classification in bold
seal**; closed by a **0.26 mm seal rule**. Right: `PT GEMILANG SATRIA PERKASA · DIVISI
ENGINEERING · BAB 4` with RAHASIA in maroon at right. Wrong: a head with a logo and a blue rule
(ID p.47).

**Register block (Figure 8.7, Annex A.5, DT-13g, ID p.53, p.90 / EN p.56, p.92).** Four
hairline-divided Mono cells at the foot, 6.2 pt, top rule **seal 0.35 mm**, bottom ink200 0.20 mm:

```
GSP · 005/GSP/KT/VIII/2026 │ REV B · 01-VIII-2026 │ LEMBAR 34 DARI 83 │ RAHASIA
```

- The classification cell is **bold seal**, always last (Table 8.1, Figure 8.7 caption).
- Document number and sheet number **bold ink900**; labels ink400.
- The total N comes from a **NUMPAGES** field. Wrong: "DARI 6" typed into a three-page file.
- **Separators are non-breaking spaces**: ordinary spaces in 6.2 pt Mono collapse into
  `LEMBAR34DARI83`. In HTML `LEMBAR&nbsp;<b>34</b>&nbsp;DARI&nbsp;83`; in DOCX an explicit
  non-breaking space run [v1.7 technique; Rev A states the rule].
- Date in the register is `DD-Roman month-YYYY` (Table 6.2).

**Datum Rule (DT-13f, ID p.53 / EN p.55).** 0.20 mm hairline with 1.15 mm ticks drawn at 0.18 mm or
heavier, plus a solid lead segment. **PDF and HTML:** the lead segment grows with the page
number (`pageNumber ÷ totalPages`; page 1 of 5 fills 20 %). **DOCX:** a fixed 9 mm lead segment
(`assets/rules/datum-128.png` / `datum-166.png`), and the register block's `LEMBAR n DARI N`
carries progress. Above chapter titles only, once on the cover, once per divider (8.7 list,
EN p.54).

**Evidence Rail.** The outer 32 mm column of interior pages. An empty rail is correct; a rail
filled to look busy marks a template (DT-43, BAKU, ID p.38 / EN p.39). Right: `◈ DITURUNKAN ·
D-03 · REQ-SEC-04` beside a derived fence length. Wrong: chapter names and icons in the rail
(ID p.53).

**Spine String (DT-13f, PK).** Cover, every divider and the back cover:
`{type}, {subject}, {language}, rev. {rev}, {month} {year}` (Annex A.5, ID p.90).

**Issue Stamp (Table 6.2, Annex A.5, ID p.37, p.90 / EN p.56).** `// {YYYYMMDD} {ID|EN}
{B|T|R|SR} — TERBITAN {n}`, e.g. `// 20261102 ID T — TERBITAN 1`; EN `// 20261103 EN T — ISSUE 1`.
The separator is the em dash printed in the manual. In bold seal, right of the colophon.

**Every device only in its place (DT-13e, ID p.52 / EN p.55).** Seal Band: head of cover and
control sheet. Datum Rule: above chapter titles, once on cover and dividers. Evidence Rail:
outer column of interior pages. Register Block: foot of every interior page. Spine String:
cover, dividers, back cover. Issue Stamp: colophon (EN p.54).

**PDF colour sample (DT-13d, ID p.49 / EN p.51).** On every build, sample the cover band, the
running-head rule and the register top rule in the PDF: RGB 110, 20, 32 ± 3 per channel. If the
builder still writes an old colour, fix the builder and rebuild. Right: a TNI AL cover band
sampled at RGB 111, 21, 30. Wrong: RGB 20, 17, 15 (black fill) (ID p.49).

---

## 7 · Numbers, units and dates (Chapter 6, ID p.35-37 / EN p.36-38)

Chapter 6 rules are DATUM form at level 3 of the hierarchy, except the binding sums of DT-30g
and DT-31b at level 2; the KAK and regulations beat both (ID p.35). Basis: BIPM SI Brochure,
NIST SP 811, GUM.

| Code | Rule | Right | Wrong | Source |
|---|---|---|---|---|
| DT-30a | One non-breaking space between value and unit, `%` and `°C` included; only plane angles close up (check 16) | `18 %`, `30,2 °C`, `30° 22′ 8″` | `12,3kg`, `25%` | ID p.35 / EN p.36 |
| DT-30b (BAKU) | Repeat the unit on every dimension; ranges with "sampai" | `51 mm × 51 mm × 25 mm`, `8 m sampai 12 m`, `(8 sampai 12) m` | `51 × 51 × 25 mm`, `8-12m`, "hingga" | ID p.35 / EN p.37 |
| DT-30c | Bracket value and tolerance, unit after the bracket | `(63,2 ± 0,1) m` | `63,2 ± 0,1 m` | ID p.36 / EN p.37 |
| DT-30d | State the meaning of every ± within 160 characters of the sign, or once in a notation line in the table SOURCE (check 17) | `(12,40 ± 0,05) V, 1 σ` | a bare ± | ID p.36 / EN p.37 |
| DT-30e | Uncertainty to at most two significant figures; round the value to the same decimal place | `(112,4 ± 1,5) dB, 1 σ` | `(112,37 ± 1,5) dB` | ID p.36 / EN p.37 |
| DT-30f | ID numerals: thousands `.`, decimal `,`; `Rp` then a space | `1.250.000,5`, `Rp 24.475.786.658` | `Rp24.475.786.658` | ID p.36 / EN p.36 |
| DT-30g | Money in tables, the RAB and binding sums in full; prose may use `Rp 3,36 miliar`, one form per file | `Rp 3.360.000.000` | "rb", "ribu" | ID p.36 / EN p.38 |
| DT-30h | Date form by place (Table 6.2) | see below | mixed forms | ID p.37 / EN p.38 |
| DT-30i (BAKU) | Coordinates in decimal degrees, six places, with the datum; DMS only when the KAK asks (PK) | `Lintang −6,244312 · Bujur 106,843017 (WGS 84)` | | ID p.37 / EN p.38 |
| DT-31b | `Terbilang :` under every binding money sum, generated from the figure | | typed words | ID p.37 / EN p.38 |

The four meanings of ± (Table 6.1, ID p.36 / EN p.37): design tolerance; 1 σ; expanded
uncertainty with coverage factor k; 95 % confidence interval. A table full of ± may carry one
notation line in its SOURCE: "Setiap ± pada tabel ini adalah toleransi rancangan."

**Dates by place (Table 6.2, ID p.37 / EN p.38):**

| Place | Form |
|---|---|
| Prose, letters, captions | `2 November 2026` |
| Technical tables, logs, machine file names | `2026-11-02` |
| Time in table cells and logs | `2026-10-27 09.15 WIB` |
| Page furniture and register block | `02-XI-2026` |
| Issue Stamp (fixed form) | `// 20261102 ID T — TERBITAN 1` |

A time sent to another office carries its zone: WIB UTC+7, WITA UTC+8, WIT UTC+9 (Keppres
41/1987). Indonesian text writes the time with a full stop: `pukul 09.00 WIT` (ID p.37).

**English text and bilingual annexes (6.7, ID p.37).** English text uses English conventions:
`1,250,000.5`, `IDR 12.5 billion` in prose, `25 %`, `14 October 2026`, `17:00 WIB (UTC+7)`. One
variant per value class per file; never mix `Rp 1.250.000` and `IDR 1,250,000` in one section.
An English annex in an Indonesian document opens with one line: "This annex uses English
conventions: 1,250,000.5, IDR, 25 %."

---

## Perubahan dari v1.7

| # | v1.7 rule (section) | Rev A | Source | Class |
|---|---|---|---|---|
| 02-1 | §1 running head closed by a 0.20 mm rule | Closed by a 0.26 mm seal rule | Table 8.1, Table A.3, ID p.49, p.90 / EN p.51, p.92 | CHANGED |
| 02-2 | §1 foot "13 mm" | Foot at 284 mm from the top edge (297 − 13), register block 8.5 mm | Table 8.3, ID p.52 / EN p.54 | KEPT (restated) |
| 02-3 | §1 measure 66 to 80 as a hard rule | DT-10b is BAKU (DEFAULT) | ID p.52 / EN p.54 | CHANGED |
| 02-4 | §2 font table without glyph face | DejaVu Sans embedded for ■ ◈ ◇ △, Greek, √ ≤ → | ID p.49 / EN p.51 | CHANGED (added) |
| 02-5 | §2 fallback with second choices Arial Narrow Bold, Cambria, Courier New | Fallback is Segoe UI Semibold, Georgia, Consolas; the second choices are not in Rev A [Interpretation: the manual names exactly three; Courier New is also an E-37 defect] | ID p.50, p.82 / EN p.52, p.85 | REMOVED (second choices) |
| 02-6 | §3 drawing type not in the scale | Drawing text Cond: node 7.6 pt, connector 6.2 pt, minimum 5.5 pt | Table A.2, ID p.90 / EN p.91 | CHANGED (added) |
| 02-7 | §4 rules table: running-head underline 0.20 mm ink200 | 0.26 mm seal | Table A.3, ID p.90 / EN p.92 | CHANGED |
| 02-8 | §4 no Word conversion; floor 0.18 mm | `w:sz = mm × 22.68`, never below 5 (0.22 mm) | DT-11a, Annex A.4, ID p.53, p.90 / EN p.56, p.92 | CHANGED |
| 02-9 | §4 "tint floor 15 %" | Tints exactly 15 % or 30 % | DT-11b, ID p.53 / EN p.56 | CHANGED |
| 02-10 | §5 Seal Band "full text width" | 5 mm × 166 mm, text #F4F5F6; master copy text added | Table 8.1, Annex A.5, ID p.49, p.90 / EN p.51, p.92 | CHANGED |
| 02-11 | §5 logo `gsp-tinta.png` without colour rule | ID: logo in seal (`gsp-seal.png`, C46); EN: black ink (`gsp-tinta.png`) | DT-13c, ID p.48 / Table 8.1, EN p.51 | CHANGED |
| 02-12 | §5 address line without fixed wording | Fixed text, copied exactly | ID p.49 / EN p.51 | CHANGED (added) |
| 02-13 | §5 control block without preparer value | Penyusun always "Divisi Engineering PT GSP" | ID p.47 / EN p.49 | CHANGED (added) |
| 02-14 | §5 colophon "issue stamp ... plus the classification" | Colophon = entity and NIB left, Issue Stamp right in bold seal [Interpretation: Table 8.1 lists no separate classification in the colophon; the stamp carries its letter] | Table 8.1, ID p.49 / EN p.51 | CHANGED |
| 02-15 | §5 Issue Stamp `// 20260801 ID R — Terbitan 2` | `// 20261102 ID T — TERBITAN 1` (capitals; EN `ISSUE`) | Table 6.2, Annex A.5, ID p.37, p.90 / EN p.56 | CHANGED |
| 02-16 | §5 Spine String on cover and dividers (SKILL §7) | Also on the back cover (PK) | DT-13f, ID p.53 / EN p.55 | CHANGED |
| 02-17 | §5 no control-sheet or sheet-counting rule | Control sheet contents, named copy holders, counting per edition, contents over 20 pages | DT-13b, ID p.48 / EN p.49-50 | CHANGED (added) |
| 02-18 | §6 running head: classification in alert, bold | Classification in bold seal | Table 8.1, DT-28d, ID p.49, p.14 / EN p.51, p.15 | CHANGED |
| 02-19 | §6 register block top rule 0.35 mm ink900; classification cell alert | Top rule 0.35 mm seal; classification cell bold seal | Table 8.1, ID p.49 / EN p.51 | CHANGED |
| 02-20 | §6 register total typed | Total from a NUMPAGES field | DT-13g, ID p.53 / EN p.56 | CHANGED (added) |
| 02-21 | §6 Datum Rule ticks weight unstated | Ticks ≥ 0.18 mm | DT-13f, ID p.53 / EN p.55 | CHANGED |
| 02-22 | (none) | §7 numbers, units and dates added from Chapter 6 | ID p.35-37 / EN p.36-38 | ADDED |
| 02-23 | v1.7 SKILL §10 "currency Rp 24.475.786.658 (spaced form)" | Same, now DT-30f; KAK or recipient template may set another form | ID p.36 / EN p.36 | KEPT |

Kept as v1.7 [Rev A silent]: subcolumn tick positions; measure estimate; section number in Mono
8 pt; justified and hyphenated body; header bottom alignment; group band size; reference
designers (Anduril, Palantir, Shield AI) dropped as commentary only.
