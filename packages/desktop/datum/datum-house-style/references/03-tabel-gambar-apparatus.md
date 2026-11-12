# 03 · Tabel, Chart & Aparatus Bukti

Standard: GSP Writing Manual Rev A, Chapter 7 (ID p.38-44 / EN p.39-46) and Chapter 9 (ID
p.54-61 / EN p.57-64). Citations are **(ID p.N / EN p.N)**; "[v1.7, Rev A silent]" marks a v1.7
rule the manual does not state and that is kept.

In Swarm, tables, charts and derivations inside a DOCX, HTML or PDF are made through the
datum-studio tools (`references/07`); the rules below are what the output must satisfy.

---

## 1 · Table grammar (7.7, ID p.41-42 / EN p.43-44)

**Horizontal rules only, in three weights. No vertical rules. No coloured or filled head**
(DT-16, checks 7 and 8). Never use Word's built-in Grid Table styles, which carry vertical rules.
Workbook sheet head rows are the one exception (Chapter 11).

| Element | Specification |
|---|---|
| Rule above head, above total | 0.45 mm ink900 (w:sz 10) |
| Rule below head | 0.25 mm ink400 (w:sz 6) |
| Row divider | 0.20 mm ink200 (w:sz 5) |
| Head text | Cond 600, 6.8 pt, capitals, +0.09 em, ink400; left- and bottom-aligned [alignment v1.7] |
| Group band | Cond 600 capitals, ink900, **no fill** (Table 7.3 shows bands A and B, ID p.42) |
| Numerals | Mono, **right-aligned**, never centred: centred digits cannot be compared digit by digit |
| Units | a **Unit column** immediately right of the number column when units differ by row; when every row of a column has the same unit, once in the head, in brackets and lower case: `Panjang (m)`, `Jumlah (Rp)` (DT-17, check 9) |
| Unit text in a column | Cond 7.2 pt ink400 (ID p.49) |
| Zebra | **none in `.docx` or a printed BoQ**: ink100 is only a 5.3 % tone and vanishes in a photocopy (DT-18, E-07) |
| Totals | rule above, Cond 600, no fill [v1.7, Rev A silent on face] |

Header rows repeat across page breaks; rows do not split [v1.7, Rev A silent].

### 1.1 Caption above, SOURCE below, call in the text (DT-15, check 10, ID p.41 / EN p.43)

- **Label printed by Studio.** Studio prints the label; the caption never starts with it; at most
  100 characters. Studio numbers every table and figure and prints the bold capital label with its
  number (`TABEL 4.1`, `GAMBAR 9.4`) itself. The caption text you write is the content sentence
  only, one line, no middle dot. A figure caption that opens with the token is refused at submit
  (400 `SCHEMA_INVALID` (`checkId` `CAPTION_TOKEN_DUPLICATE`)); a table caption that opens with it
  prints the label twice.
- **SOURCE line below the table**, opening `SUMBER` (EN `SOURCE`), ending with `PROVENANS` for a
  data table.
- **Call every table in the prose**, or delete the table.
- The caption says "per <date>" when the content has a validity date (ID p.41).

Example from the manual (Tabel 7.3, ID p.42), as printed: Studio prints `TABEL 7.3`, the caption text
is the sentence after it. The manual's sentence runs to two lines; in Studio keep it to one line of at
most 100 characters.

```
TABEL 7.3  Daftar kuantitas IDS perimeter Lanal bernilai Rp 3.793.000.000, per register
           koordinat Rev B, 14 Oktober 2026.

NO   URAIAN PEKERJAAN                    VOLUME  SATUAN  HARGA SATUAN (Rp)   JUMLAH (Rp)
A    PEKERJAAN SIPIL
A.1  Galian dan urug jalur kabel        3.538,8  m'              85.000     300.798.000
 …
     JUMLAH A + B, SEBELUM PPN                                            3.793.000.000

SUMBER  Register koordinat Rev B, 14 Oktober 2026 · Peta 001 sampai 014. Angka ilustratif.
        PROVENANS volume B.1 ■ TERUKUR · volume A.1, A.2, dan B.2 ◈ DITURUNKAN · harga
        satuan ◇ PEMASOK [B2], 3 kutipan, median diambil.
```

Caption 7.6/11 pt Cond 400 ink700; SOURCE 6.6/9 pt Cond 400 ink400 above a 0.20 mm rule (Table
A.2, ID p.90 / EN p.91).

### 1.2 Specification tables (DT-19, ID p.42 / EN p.44)

Columns **parameter · test condition · value · unit**. **No footnotes**: a condition far from its
value is not read. Every value has its test condition on the same row. Wrong: "Resolusi: 4K"
with no condition.

```
PARAMETER              KONDISI UJI                 NILAI   SATUAN
Resolusi horizontal    25 fps, WDR aktif           3.840   px
Jarak IR               Malam, target 1,8 m           200   m
SUMBER Lembar data Pemasok A rev 4. PROVENANS seluruh nilai ◇ PEMASOK [C3].
```

Multi-valued parameters may bullet inside the cell [v1.7, Rev A silent].

### 1.3 Side note instead of a filled box (DT-20, check 2, ID p.43 / EN p.45)

Emphasis is a **ruled side note**: ink900 0.35 mm rule above, ink200 0.20 mm rule below, **no
fill**. Never a cream box with a left bar, the sign of a machine-made document. A Cond 600
capital label and prose at 8.6/12.4 pt [v1.7, Rev A silent on sizes].

### 1.4 Code quotations (7.9, KD-01 to KD-09, ID p.43-44 / EN p.45-46)

Code is copyable Mono text between a top and a bottom rule. Inline commands and values in Mono;
two lines or more in a block; over 30 lines to an annex (KD-01). Text, never a screenshot; no
syntax colouring (KD-02). Blocks numbered `Kode <bab>.<urut>`, separate from tables and
figures, with a caption saying what the code proves and a source naming repository and version
(KD-03). Lines ≤ 72 characters at 7.4 pt; machine lines (hash, path, JSON) up to 88 (KD-04).
No curly quotes or hidden characters (KD-05). Placeholders in capitals and explained after the
block; an underscore in code is syntax, so DT-12 does not apply (KD-06, BAKU). Command and output
in separate blocks (KD-08). Pseudocode one step per line, opening with MASUKAN and KELUARAN
(KD-09).

---

## 2 · Charts (Chapter 9, ID p.54-61 / EN p.57-64)

Charts have an axis. Drawings with nodes and connectors are `08-skema-diagram.md`. Both use the
apparatus of §1.1 and §3.

**Choosing (9.1, ID p.54 / EN p.57).** Five steps every time: 1 write the chart's question in one
sentence (CH-07); 2 identify the data shape (categories, numbers, time, part of a whole,
negative values); 3 count categories and series against Table 9.1 (CH-09); 4 know the reader:
an official gets one message per chart, no radar, sankey or box plot; 5 test against CH-01 to
CH-06 and the five-second test (CH-10). When unsure, go back to bar or line. In Claude's
ecosystem the decision whether a chart exists belonged to gsp-visual-commander; in Swarm, make
it yourself under these rules (SKILL.md §0).

**Count limits (Table 9.1, ID p.55 / EN p.58):** up to 5 categories, pie or donut allowed, bar still
more precise; 6 to 30, sorted bar or lollipop; over 30, top 10 to 15 plus "Lainnya"; over 3
lines, highlight one or use small multiples; thousands of scatter points, hexbin or heatmap.

**Rules (Table 9.2, ID p.55-56 / EN p.58-59):**

| Code | Level | Rule |
|---|---|---|
| CH-01 | WAJIB | Bar, column and area start at zero |
| CH-02 | BAKU | Sort by value unless the order is natural (time, rank, direction) |
| CH-03 | WAJIB | One signal accent on one subject (lint 26) |
| CH-04 | WAJIB | Direct labels; values in Mono without boxes; a key only as a KUNCI row; no legend box |
| CH-05 | WAJIB | No title in the plot; the caption above is the conclusion, with date and basis |
| CH-06 | WAJIB | No 3D, dual Y axis, shadow, gradient, frame, boxed label |
| CH-07 | BAKU | Write the chart's question in one sentence (the spec's `question` key) |
| CH-08 | BAKU | Choose the type from the groups of Figure 9.1; any other needs a written reason |
| CH-09 | BAKU | Categories and series within Table 9.1 |
| CH-10 | WAJIB | The message is caught in five seconds by a colleague who did not make it |
| CH-11 | WAJIB | Alert only for the failing side of a limit or a worsening direction; verd only improving; not for tables |
| CH-12 | WAJIB | A value against a technical limit is drawn as a threshold |
| CH-13 | WAJIB | No KPI tiles and no gauges in documents (lint 01) |
| CH-14 | ANJURAN | A special chart only when bar or line fails, with a written reason |
| CH-15 | WAJIB | The chart is the home of its numbers; none repeated in a body table |

**Colour roles (Table 9.4, ID p.57 / EN p.60):** signal #B45309 the one subject; ink400 #6B7783
comparison series; ink200 #C3CBD1 target, past period, remainder; alert #9B1C1C failing side or
bad direction; verd #2F6F6B good direction; ink900 #101418 baseline, labels, limit line. At most
five hex values besides the white ground (DT-06); no blue. Heatmaps use one gradient from white
to signal. Signal marks the subject, not identity; colour direction follows meaning for the
reader, so a cost reduction is not alert (PK). Every colour difference is also carried by label,
position or pattern (DT-34, ID p.57 / EN p.61).

**Captions (9.5, ID p.57 / EN p.61).** A full sentence above the chart carrying the conclusion,
the data date and the number basis (CH-05). The SOURCE line names the base document, date and
provenance mark (DT-15). Chart numbers come from the register (DT-23); Studio prints the label
`GAMBAR 5.3` above the caption itself. Right (the caption text you write): "Sektor B menyumbang 9
dari 23 gangguan sensor IDS, Januari sampai Juni 2026." Wrong: "Gambar 5.3 · Gangguan per
sektor." It opens with the label, so the submit is refused (400 `SCHEMA_INVALID` (`checkId` `CAPTION_TOKEN_DUPLICATE`)),
and it states no conclusion. Prose mentions at most one chart number; the data may be tabled in an
annex (ID p.58).

**Threshold and bullet (9.6, ID p.58 / EN p.61-62).** A limit (contract, regulation, standard,
acceptance criterion) is a threshold (P-11): a labelled ink900 line, and only bars past it take
alert (for a minimum limit, the bars below it). A target is a bullet (P-09): measure bar and
target mark in ink900, qualitative bands in two tones (no fill and ink200), no ink100. Documents
use one bullet row per KPI; tiles and gauges belong to live screens (CH-13).

**Composition and net change (9.7, ID p.58-59 / EN p.62).** Composition across groups: 100 % stacked bar
(K-02), at most four segments, the most important at left. Net change: waterfall (P-10), first
and last bars on zero, change bars labelled plus or minus.

**Catalogue (9.8, Table 9.5, ID p.59-61 / EN p.63).** 58 chart types in six code groups: P
comparison, H relationship, K composition, W time, S distribution, G geospatial and process. Not
used: radar, word cloud, sunburst, gauge, stream graph; a type outside the catalogue needs a
written reason (ID p.61).

**By document type (Table 9.6, ID p.61 / EN p.64):** technical proposal and kajian: Gantt,
flowchart, bar, bullet, threshold (avoid radar for vendors); RAB, BoQ, offer: Sankey, treemap,
waterfall, 100 % stacked bar TKDN (avoid a pie with many slices); briefing to officials: sorted
bar, line, bullet, tile map (avoid box plot, horizon, network); OSINT and forensic reports:
network, barcode, heatmap, table chart (avoid a word cloud as the only evidence).

**Spec keys (Table 9.7, ID p.61 / EN p.64):** `question`, `code` (envelope, not drawn); `family`;
`id`, `title`; `data[]`, `band` (label, value, at most one accent, sub, target, status, bullet
bands); `limit`, `limit_label` (mandatory for a threshold); `unit`, `dec`; `source`; `width_mm`
(128 or 166) and `apparatus` ("page" for documents); `classification`, `labels_verified`
(mandatory, as for drawings, DT-39).

**Engines named by the manual (Table 9.8, ID p.61 / EN p.64):** P-01, P-02, W-02, P-11 with
`datumchart.py`; the other 53 codes through a plot engine that must pass `datum_lint.py`
check 25 on the SVG and the eye checks 12 and 13 (PK); G-04 with `datum_diagram.py`. Output: SVG
with real text, and a 300 dpi PNG for Word (DT-36). **In Swarm: charts → datum-studio chart tools
(D-C)**: `studio_figure_preview`, `studio_figure_revise`, `studio_render` (`references/07`).

Axis: one 1.1 pt ink900 baseline; gridlines 0.20 mm ink200 only where a reader must compare
values; rounded bar caps forbidden [v1.7, Rev A silent].

### 2.1 Series, photographs, sparklines, fills [v1.7, Rev A silent]

- Three series, chapter-prefixed: `Gambar 3.1` · `Tabel 5.2` · `Peta 1.1`; maps are their own class.
  Rev A adds the `Kode 7.1` series for code blocks (KD-03). Captions above, SOURCE lines below.
- Photographs: credit first, in brackets, then subject, place, month and year:
  *(Divisi Engineering GSP) Titik B22 menghadap Selat Madura, Batu Poron, Agustus 2021*.
- Sparklines: Tufte's specification, word-sized, single ink; the normal band is defined and
  disclosed in the caption (spec limits, interquartile range or ±1 σ); band tint 15 % or 30 %
  (DT-11b).
- Diagram fills: hatching at 45° and 135°, never grey tints (DT-11b, DT-11d, ID p.53, p.68 /
  EN p.56, p.70); at most three patterns per figure [v1.7].

---

## 3 · Evidence apparatus (Chapter 7, ID p.38-41 / EN p.39-43)

A **load-bearing number** is one the reader uses to decide, such as a total cost or a camera
count (ID p.38).

### 3.1 Provenance marks (Table 7.1, DT-21, DT-22, ID p.38 / EN p.39-40)

| Glyph | Label (ID / EN) | Meaning | Colour |
|---|---|---|---|
| ■ | TERUKUR / MEASURED | read from a source document or instrument | ink900 #101418 |
| ◈ | DITURUNKAN / DERIVED | computed from measured inputs; the derivation is shown | signal #B45309 |
| ◇ | PEMASOK / VENDOR | vendor datasheet claim, not independently verified | ink400 #6B7783 |
| △ | ASUMSI / ASSUMED | assumption with an ID and an impact statement | alert #9B1C1C |

- **One mark per load-bearing number, at its home**: the table or derivation where the number is
  stated (DT-21, check 11 as a screen: paragraphs with quantities and no mark ≤ 50 %).
- **In tables, derivations, SOURCE lines and the rail the glyph always carries its label**; the
  label is written because colour is lost in a photocopy (DT-34). In prose the glyph may stand
  alone once the glyph key has appeared in the document.
- **One mark per clause or row stating the fact** (DT-22). Move extra marks to the rail or table
  row; never delete them, because DT-21 wins. Right: "Perimeter sepanjang 6.546,2 m ■ menuntut
  70 titik deteksi (Turunan 6.1a)." with ◈ for 70 in its derivation. Wrong: "Perimeter ■
  sepanjang 6.546,2 m ■ dengan jarak 93,5 m ◈ menghasilkan 70 ◈ titik ◈." (ID p.39).
- Without a rail, marks go in the table column, the SOURCE line or the derivation block (ID p.38).
- Check that the glyphs render in the PDF (open defect E-32, ID p.82 / EN p.85).

### 3.2 Number binding (DT-23, ID p.40 / EN p.41)

Take every load-bearing number from the quantity register by name; never type it, because a
typed number stays behind when the model changes. Plain integers such as 70 and English-format
numbers are not audited, so the checker matches them by eye at gate step 7. Right: the RAB total
from the register by name. Wrong: "Total Rp 24.475.786.658" typed into the builder. SERAH runs
the number audit (zero untraceable numbers).

### 3.3 Admiralty digraph (DT-25, ID p.39 / EN p.40)

Every external claim carries a two-character grade per NATO AJP-2.1 and STANAG 2511: the letter
grades the reliability of the source, the digit the credibility of the information, judged
separately (check 22). Claims graded A1 to C3 enter documents; F6 does not enter a proposal
(Figure 7.2 caption, ID p.39). A datasheet corroborated by an independent test is [B2];
uncorroborated, [C3]. Right: `◇ PEMASOK [C3] · lembar data OEM rev 4`. Wrong: one digraph in
the annex for all vendor claims.

| Source reliability | | Information credibility | |
|---|---|---|---|
| **A** | Sepenuhnya andal | **1** | Terkonfirmasi sumber independen |
| **B** | Biasanya andal | **2** | Mungkin benar |
| **C** | Cukup andal | **3** | Bisa jadi benar |
| **D** | Biasanya tidak andal | **4** | Diragukan |
| **E** | Tidak andal | **5** | Tidak mungkin |
| **F** | Tidak dapat dinilai | **6** | Tidak dapat dinilai |

[Table wording v1.7; Rev A gives the matrix as Figure 7.2 (image, ID p.39) and EN Table 7.2
(EN p.40).] Client figure from a signed contract [A1]; unattributed forum figure [F6]
[v1.7, Rev A silent].

### 3.4 Likelihood language (DT-26, Table 7.2, ID p.39-40 / EN p.41)

Judgements about uncertain events use the seven ICD 203 terms; not for GSP schedule
commitments. A computed probability is written as a number with its basis ("peluang tabrakan di
bawah 10⁻⁶⁰, dihitung dari panjang 256 bit").

| hampir tidak mungkin | sangat kecil kemungkinannya | kecil kemungkinannya | kemungkinan berimbang | kemungkinan besar | sangat mungkin | hampir pasti |
|---|---|---|---|---|---|---|
| 1 % sampai 5 % | 5 % sampai 20 % | 20 % sampai 45 % | 45 % sampai 55 % | 55 % sampai 80 % | 80 % sampai 95 % | 95 % sampai 99 % |

The upper bound of a band is not part of that band (ID p.39). Likelihood and confidence go in
separate sentences: "Serangan ke gerbang perimeter tahun ini kecil kemungkinannya. Keyakinan GSP
sedang." Wrong: "GSP sangat yakin serangan itu kecil kemungkinannya." (ID p.40). The EN edition
adds the PHIA Yardstick gaps (EN p.41).

### 3.5 Derivation blocks (DT-24, ID p.40 / EN p.41-42)

Show the **real arithmetic** and mark **every input**, reserves and factors included. **Close
every derivation with what happens if the assumption fails.** ID: `Turunan <bab>.<urut><huruf>`;
EN: `Derivation <section><letter>`. Intermediate lines show one more decimal than the result,
and the result follows the precision rule of DT-30e. Mono 7.4/11.5 pt ink900 (Table A.2);
against a 0.45 mm signal left rule, indented 4.5 mm, aligned on the operator [v1.7, Rev A
silent on the rule and indent].

```
TURUNAN 7.5A · KAPASITAS SIMPAN REKAMAN CCTV POSKO MANDO (ILUSTRATIF)          (ID p.40)
Kamera terpasang                      48   unit  ■ TERUKUR
Bit rate per kamera                    4   Mbps  ◇ PEMASOK [C3]
Masa simpan                           30   hari  △ ASUMSI ASM-REC-01
Cadangan kapasitas                    25   %     △ ASUMSI ASM-REC-02
Konversi 86.400 s/hari, 8 bit/B, 10⁶ MB/TB         ■ TERUKUR
Larik RAID 6, 10 diska × 12 TB                     ◇ PEMASOK [B2]
Data 30 hari  48 × 4 × 86.400 × 30 ÷ 8 ÷ 10⁶  =  62,21  TB
Kebutuhan     62,21 × 1,25                    =  77,8   TB  ◈ DITURUNKAN
Kapasitas     (10 − 2) × 12                   =  96,0   TB  batas min. 77,8 TB, memenuhi
  Bila masa simpan naik ke 45 hari, kebutuhan menjadi 116,6 TB dan larik memerlukan rak kedua.
```

Wrong: a derivation that stops at "= 77,8 TB" with no consequence sentence (ID p.40). On SERAH,
every load-bearing number has a machine-checked derivation and every recapitulation quantity a
second route (PK-06, ID p.10 / EN p.10).

### 3.6 Assumption register (DT-27a, ID p.41 / EN p.42)

At the end of the chapter or in an annex, before the closing paragraph. Columns **ID ·
assumption · impact if wrong · verification**: an assumption without an impact is a guess.
Right: `ASM-PWR-01 · Faktor daya terpasang 0,85 · Kapasitas kVA naik kira-kira 9 % pada 0,78 ·
Uji terima pabrik`. Wrong: "Kondisi tanah diasumsikan normal" with no ID and no impact.

### 3.7 Requirement IDs (DT-27b, ID p.41 / EN p.42)

Every requirement gets one ID, once, used unchanged across the whole package (kajian, proposal,
BoQ, schedule, acceptance test). Wrong: `R-PWR-2` in the BoQ for `REQ-PWR-02`. **ASM domains and
REQ subsystems are a closed list:** CAM, REC, NET, PWR, CIV, SEC, RDR, VMS, FOR, OSI, SW, OPS,
DOK. A new code is recorded in the project register before use.

### 3.8 Evidence rail (DT-43, BAKU, ID p.38 / EN p.39)

Leave the rail empty when there is nothing to say; a rail filled to look busy marks a template.
Zero rail content that repeats the prose. On SERAH pages carrying load-bearing content the rail
is used (PK-06).

---

## Perubahan dari v1.7

| # | v1.7 rule (section) | Rev A | Source | Class |
|---|---|---|---|---|
| 03-1 | §1 units "own column" always | Unit column when units differ by row; otherwise once in the head as "(m)"; check 9 accepts both | DT-17, ID p.41 / EN p.43 | CHANGED |
| 03-2 | §1 zebra permitted above 12 rows in ink100, never in a printed BoQ | No zebra in `.docx` or a printed BoQ | DT-18, ID p.41 / EN p.43 | CHANGED |
| 03-3 | §1 caption "TABEL 5.2   Daftar kuantitas ... (B1–B35)" | Studio prints the bold capital label with number; the caption text carries no token, one line, at most 100 characters, no middle dot (§1.1); every table called in the prose or deleted; SOURCE ends with PROVENANS | DT-15, ID p.41 / EN p.43; Swarm 1.2.6 W-01 | CHANGED |
| 03-4 | §1 spec tables: three columns, footnote markers resolved at the foot of the same page | Four columns (parameter, test condition, value, unit); no footnotes | DT-19, ID p.42 / EN p.44 | CHANGED |
| 03-5 | §2 producer of record `datumchart.py`, families bar, column, threshold | Same engine for P-01, P-02, W-02, P-11; 53 other codes through a plot engine; in Swarm charts → datum-studio chart tools (D-C) | Table 9.8, ID p.61 / EN p.64 | CHANGED |
| 03-6 | §2 figure grammar: one accent, direct labels, no title in plot, forbidden list | Kept and extended to the 15 coded chart rules, Table 9.1 count limits, Table 9.4 roles, threshold and bullet rules, catalogue exclusions, chart spec keys | CH-01 to CH-15, ID p.54-61 / EN p.57-64 | CHANGED (extended) |
| 03-7 | §3.1 "a load-bearing number with no mark is a defect" (marks wherever the number appears) | One mark at the number's home; glyph with label in tables, derivations, SOURCE and rail; one mark per clause | DT-21, DT-22, ID p.38 / EN p.39-40 | CHANGED |
| 03-8 | §3.2 digraph table only | Adds: A1 to C3 enter documents, F6 never a proposal; example form `◇ PEMASOK [C3] · lembar data OEM rev 4` | DT-25, Figure 7.2, ID p.39 / EN p.40 | CHANGED (added) |
| 03-9 | §3.3 bands "01–05 %" etc. | Bands written with "sampai"; upper bound excluded; not for schedule commitments; computed probabilities as numbers | DT-26, Table 7.2, ID p.39 / EN p.41 | CHANGED |
| 03-10 | §3.4 derivation ID `D-<bab>.<pasal><huruf>`, example "TURUNAN D-7.3B" | `Turunan <bab>.<urut><huruf>` (EN `Derivation <section><letter>`); every input marked including reserves and factors; intermediate lines one more decimal; example replaced by Turunan 7.5a | DT-24, ID p.40 / EN p.41-42 | CHANGED |
| 03-11 | §3.5 assumption register "every chapter resting on assumptions"; `ASM-<domain>-<nn>` | At the end of the chapter or in an annex, before the closing paragraph; closed domain list | DT-27a, ID p.41 / EN p.42 | CHANGED |
| 03-12 | §3.6 `REQ-<subsystem>-<nn>` | Same; closed subsystem list | DT-27b, ID p.41 / EN p.42 | CHANGED (closed list) |
| 03-13 | §4 aside | Same rule, now DT-20 with check 2 | ID p.43 / EN p.45 | KEPT |
| 03-14 | (none) | Number binding audit rule; code quotation rules KD-01 to KD-09; evidence rail DT-43 | ID p.40, p.43-44, p.38 / EN p.41, p.45-46, p.39 | ADDED |
| 03-15 | §2 reference conventions named after firms (CSIS, Rohde & Schwarz, Hensoldt, IISS) | Commentary removed; the rules themselves are kept or replaced above | n/a | REMOVED (commentary) |

Kept as v1.7 [Rev A silent]: head alignment, totals face, header repeat and unsplit rows,
multi-value bullets in a cell, side-note sizes, axis and gridline weights, rounded bar caps,
Peta series, photo credits, sparklines, three-pattern limit, derivation left rule and indent,
digraph grade wording, A1 and F6 application examples.
