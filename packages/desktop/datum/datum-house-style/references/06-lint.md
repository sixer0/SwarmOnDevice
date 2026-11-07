# 06 · Gerbang Rilis dan Baterai 38 Cek

Standard: GSP Writing Manual Rev A, Chapter 13 (ID p.79-82 / EN p.81-85). Citations are
**(ID p.N / EN p.N)**; "[v1.7, Rev A silent]" marks a v1.7 rule the manual does not state and
that is kept. The class of each check against v1.7 (UNCHANGED / CHANGED) is from the Swarm 1.2.0
map of the 38 checks (row 77).

No GSP artefact leaves before it passes one ordered gate, and one failure blocks release
(ID p.79 / EN p.81).

**Run the gate steps of the tier (DT-42a, ID p.79 / EN p.81).** When a step fails, fix the source
and rebuild: a patch on a finished file is lost at the next build. Wrong: the lint reports
"12,3kg" and the writer types the space straight into Word.

**Tools (ID p.79).** `datumcheck.py` at the call site, the drawing engine at build, `datum_lint.py`
and `datumbind.py` on the file. In Swarm: Studio runs its own checks on every DOCX, HTML, SVG and
PDF it writes and renders (read them before delivery); `python scripts/datum_lint.py <file>` with
the bundled Python checks `.xlsx` and `.pptx` (and accepts `.docx`, `.svg`, `.md`, `.html`).
The lint's changed checks follow Rev A in this copy (row 102). [Interpretation D-C.]

---

## 1 · Four stages (13.1, Figure 13.1, ID p.79 / EN p.81)

Some defects are visible only at one moment, so each check has one owning stage: **call site**
(the call that makes a table, figure or name), **build** (the drawing engine), **file** (the
finished file), **eye** (a person reading).

**Call-site guard (DT-42b, ID p.79 / EN p.81).** Run the guard as each table, figure and name is
made, because it names a table by its caption. TERBIT and SERAH documents: zero G1, G2, G3 and
N1 before the file lint.

| Code | Catches |
|---|---|
| G1 | row cell count differs from the header column count |
| G2 | width other than 128 mm or 166 mm |
| G3 | cell text long enough to be cut mid-word |
| N1 | underscore in a folder, file, sheet, table ID or engineering identifier (DT-12) |

The guard still flags headings that open with "Bagaimana"; open the heading with its object (PK).

**The file lint runs 27 of the 38 checks, so its report reads 27/27, never "38/38"** (ID p.79 /
EN p.81). A threshold no tool measures is recorded as "belum diperiksa mesin" (ID p.81).

---

## 2 · The 38 checks (Table 13.1, ID p.80 / EN p.81-82)

Limit zero unless stated. Under Rev A every check is WAJIB (DT-42a) except 15, which is BAKU.

| # | Defect | Stage | Rev A home rule | Class vs v1.7 |
|---|---|---|---|---|
| 1 | KPI tile rows, dashboard stat strips; gauges | file | CH-13 (ID p.55 / EN p.59) | UNCHANGED |
| 2 | Filled callout box with a coloured left bar | file | DT-20 (ID p.43 / EN p.45) | UNCHANGED |
| 3 | Dash excess: ≤ 3 per 1 000 words, 0 in headings | call site, file | TB-09 (ID p.19); EN em dash only (EN p.32) | **CHANGED** |
| 4 | Heading that **ends with "?"** | call site, file | Table 13.1 (ID p.80 / EN p.81) | **CHANGED** |
| 5 | Office default faces (Calibri, Times New Roman, Aptos, Arial as body) | file | DT-08a (ID p.50 / EN p.52) | UNCHANGED |
| 6 | Centred cover | file | DT-14 (ID p.47 / EN p.49) | UNCHANGED |
| 7 | Vertical rules in tables (workbook head rows exempt) | file | DT-16 (ID p.41 / EN p.43) | UNCHANGED |
| 8 | Filled or coloured table head (Word/PDF) | eye | DT-16 | UNCHANGED |
| 9 | Data table without a Unit column or "(unit)" in the head | call site, file | DT-17 (ID p.41 / EN p.43) | UNCHANGED |
| 10 | Table or figure without SOURCE (plus caption and call, DT-15) | call site, file | DT-15 (ID p.41 / EN p.43) | UNCHANGED |
| 11 | Load-bearing numbers without mark: ID screen, paragraphs with quantities and no mark ≤ 50 %; EN eye | file | DT-21 (ID p.38 / EN p.39) | **CHANGED** |
| 12 | Decorative colour | eye | DT-01a, DT-06, DT-13c (ID p.48 / EN p.50) | UNCHANGED |
| 13 | Raster chart | eye | DT-36 (ID p.63 / EN p.66) | UNCHANGED |
| 14 | Page colours: fixed palette not counted; **≤ 2 meaning colours**, never alert with verd; glyphs count | file | DT-06 (ID p.48 / EN p.50) | **CHANGED** |
| 15 | Line outside 66 to 80 characters (**BAKU**) | eye | DT-10b (ID p.52 / EN p.54) | **CHANGED** |
| 16 | Value glued to its unit (`%`, `°C` included; plane angles exempt) | call site, file | DT-30a (ID p.35 / EN p.36) | UNCHANGED |
| 17 | ± without its meaning **within 160 characters**, or in a SOURCE notation line | file | DT-30d (ID p.36 / EN p.37) | **CHANGED** |
| 18 | Classification level not in the recipient's scheme | file | DT-28a (ID p.13 / EN p.13) | UNCHANGED |
| 19 | VAT: ID "PPN selain 11 % efektif"; EN "VAT over IDR 2 from 11 % of the pre-VAT subtotal"; VAT only in the recapitulation; Rev A's own "PPN 12 % × DPP" recap line must pass | file | DT-31a (ID p.17 / EN p.18) | **CHANGED** |
| 20 | Merged cells outside COVER and PETUNJUK prose, **and any hidden row, column or sheet** | file | DT-40e (ID p.72 / EN p.74) | **CHANGED** |
| 21 | Rule below 0.18 mm or **Word w:sz below 5**; tint other than **15 % or 30 %** | file | DT-11a, DT-11b (ID p.53 / EN p.56) | **CHANGED** |
| 22 | External claim without an Admiralty digraph | file | DT-25 (ID p.39 / EN p.40) | UNCHANGED |
| 23 | Rounded corners outside an ISO 5807 terminator | file | DT-44 (ID p.63 / EN p.66) | UNCHANGED |
| 24 | Connector without a label | build | DT-37 (ID p.63 / EN p.66) | UNCHANGED |
| 25 | More than 5 hex values in one figure besides the ground | file | DT-06 (ID p.48 / EN p.50) | UNCHANGED |
| 26 | More than 1 accented subject (per panel on a catalogue sheet) | build | CH-03, DT-37 (ID p.55, p.63, p.69) | UNCHANGED |
| 27 | Drawing line below 0.18 mm | file | DT-11d (ID p.68 / EN p.70) | UNCHANGED |
| 28 | Drawing type below 5.5 pt, **except a reduced page or slide sample with numbered markers ≥ 5.5 pt** | file | DT-11d (ID p.68 / EN p.70) | **CHANGED** (narrow) |
| 29 | Figure without SOURCE | file | DT-15 | UNCHANGED |
| 30 | Figure without number and caption (label `GAMBAR n.m` in bold capitals) | file | DT-15 (ID p.41) | UNCHANGED |
| 31 | Mermaid in a deliverable | file | DT-35 (ID p.70 / EN p.72) | UNCHANGED |
| 32 | Connector crossing an unrelated box | build | DT-01b, 10.3 (ID p.62-63) | UNCHANGED |
| 33 | Figure taller than 247 mm | build | Table 8.3 (ID p.52 / EN p.54) | UNCHANGED |
| 34 | `sec:` marks without a published legend | build | SM-03, Table 10.1 (ID p.66, p.63) | UNCHANGED |
| 35 | Two symbol dialects in one drawing | build | SM-04 (ID p.66 / EN p.68) | UNCHANGED |
| 36 | Apparatus delegated to the page (reminder, not a failure) | call site, file | Table 13.1 | UNCHANGED |
| 37 | Composed sheet beyond A4 | build | Table 13.1, Table 8.3 | UNCHANGED |
| 38 | Underscore in a file, folder, sheet, table or figure ID, engineering identifier | file | DT-12 (ID p.11 / EN p.11) | UNCHANGED |

Notes on the changed checks (ID and EN pages as in the table):

- **3.** ID TB-09 counts both — and –; fixed boilerplate (issue stamp, letterhead, address) is not
  counted. The ID tables disagree with each other (TB-09 p.19, the chapter 5 table p.33); EN
  counts em dashes only. Each document is judged by its own edition.
- **4.** Openings with question words (apa, mengapa, bagaimana, what, how) no longer fail check 4;
  they are the call-site guard's business (ID p.79 / EN p.81).
- **11.** One mark per number at its home; v1.7's "0 unmarked" and its code (fail at ≥ 12 numbers
  with zero marks) can disagree with Rev A either way.
- **14.** v1.7 counted every value (≤ 5 per page).
- **17.** v1.7 accepted a meaning keyword anywhere on the page. A forecast spread is a range,
  never ±.
- **19.** v1.7 failed any "PPN 12 %" string, so it failed Rev A's own recap line (Turunan 3.7a).
  A summary extract of ≤ 5 recap lines copied exactly is exempt (ID p.17).
- **20.** v1.7 checked only merges over formula rows on RAB, AHS, HITUNG and REKAP sheets. Lint 20
  does not read KENDALI; it is checked by eye (ID p.72).
- **21.** v1.7 failed only w:sz < 4 and tints below 15 %.
- **28.** v1.7 had no reduced-sample exemption.

Check 24 runs inside the drawing build, where it can name the offending edge. `"require_edge_labels":
false` in a spec is for a deliberate exception only, with the reason in the SOURCE line [v1.7,
Rev A silent].

---

## 3 · The gate, 10 steps (13.3, Table 13.2, ID p.80-81 / EN p.82-83)

TERBIT runs steps 1 to 5, 7 and 10; SERAH all ten; NOTA steps 1 and 10.

| Step | Check | Stage | Passes when |
|---|---|---|---|
| 1 | Self read-through | eye | read to the last page |
| 2 | Call-site guard | call site | zero G1, G2, G3, N1 |
| 3 | Drawing lint | build | checks 24, 26, 32 to 35 and 37 have zero findings |
| 4 | Text mechanics | file | zero WAJIB breaches of Chapters 4 and 5 |
| 5 | File lint | file | 27 of 27 pass |
| 6 | Number audit | file | zero untraceable numbers |
| 7 | Eye check | eye | checks 8, 12, 13, 15 and the pre-delivery list |
| 8 | Blind jury | eye | LEPAS from two judges |
| 9 | Independent checker, photocopy | eye | traces of steps 2 to 8 present; readable at 40 cm |
| 10 | Deliver and record | file | change log, folder, SHA-256, number when TERBIT or SERAH |

The EN edition adds English scans at steps 4 and 7 (Table 13.2 and 13.3, EN p.82-83).

**Jury and independent checker (13.4, ID p.81 / EN p.84).** Step 8 uses the SG-L6-16 rubric of
Chapter 5: two judges who are not the writer score extracts of 150 to 600 words without the file
name; a judge may be a separate AI session that has not seen the writing. Without a jury the
document is not passed as SERAH and goes to the Director labelled "belum dinilai juri". The
independent checker (neither writer nor judge) checks data, references, gate traces and drawing
logic (PK).

---

## 4 · Pre-delivery list (13.5, Table 13.3, ID p.81-82; EN Table 13.4, 22 items, EN p.84)

Gate step 7. Print, tick by hand, file with the tool traces.

| Item | Test | Codes |
|---|---|---|
| 1 Tier and number | eye: number from the Register Induk | DT-02, DT-04a, DT-04b |
| 2 Channel | eye: opening suits the channel | SG-L0-05 |
| 3 First page | eye: a measured anchor | SG-L0-01, SG-L0-02 |
| 4 Classification | check 18; eye: living regulations | DT-28a to DT-28e, DT-29a |
| 5 Load-bearing numbers | check 11 and audit | DT-21 to DT-23 |
| 6 Apparatus | checks 10, 29, 30; eye: derivations with consequence, IDs identical | DT-15, DT-24, DT-27a, DT-27b, DT-43 |
| 7 Tables | checks 7, 9; eye check 8 | DT-16, DT-17 |
| 8 Charts | eye: one accent, zero start, chart numbers not repeated in body tables | CH-01 to CH-15 |
| 9 Technical drawings | build: from spec, one dialect, legend | DT-35, DT-39, SM-04 |
| 10 Numbers and units | checks 16, 17; eye: terbilang matches | DT-30a to DT-30i, DT-31b, SG-L4-05 |
| 11 Sentences | file: Chapter 5 thresholds | SG-L3-09, SG-L6-01, SG-L6-02 |
| 12 Actors | eye: human actors | SG-L4-01, SG-L4-03 |
| 13 Address | eye: institutional address, no "kamu" | SG-L5-08 |
| 14 Turning moment | eye: present | SG-L1-10 |
| 15 Close | eye: action and addressee | SG-L0-03 |
| 16 Lint | call site zero G; file 27 of 27 | DT-42a, DT-42b |
| 17 SERAH only | file number audit; LEPAS ticked after step 8 | DT-23, SG-L6-16 |
| 18 Photocopy | eye: 100 %, two copies, 40 cm | DT-11c, DT-34 |
| 19 File name | call site N1; file check 38 | DT-12 |
| 20 Colophon | eye: one honest sentence | DT-42c |
| 21 Spelling and words | file and eye: Chapter 4 TB rules | TB-01 to TB-23 |

Eye checks from v1.7 that the list carries: photocopy test (item 18); every derivation closes
with its consequence (item 6); current regulations (item 4); terbilang matches (item 10); logo on
one page (DT-14, check 6); the package reconciles (requirement IDs, quantities, totals across
kajian, proposal, BoQ, schedule, DT-27b); every box and line in a drawing is real (DT-01b).
"Is the evidence rail honest?" is DT-43. "Is every heading a claim or a label?": in a brief a
label is a defect (DT-41b); in a report labels are fine, never a heading ending with "?".

---

## 5 · Colophon and production traces (13.6, DT-42c, ID p.82 / EN p.85)

Remove traces of the tools that produced the document (builder, lint, skill) from reader-facing
text. Instruments and inspection tools (forensic software, measuring instruments) are named with
their versions. State the document's status in one colophon sentence. Right: "Dokumen ini lulus
pemeriksaan bentuk dan dinilai dua juri." Wrong: "DATUM LINT 27/27 PASS · JURY LEPAS".

---

## 6 · Open defects and their workarounds (13.7, Table 13.4, ID p.82 / EN p.85)

| ID | Workaround or status |
|---|---|
| E-04 | Copy the Word builder pattern; do not import it |
| E-07 | No zebra in `.docx` |
| E-16 | Count colours by DT-06 |
| E-17, E-18 | Single-line diagrams top to bottom; symbol sheets cut at 247 mm |
| E-29, E-30 | ISO 5807 terminators are rectangles with 2 mm corners, not stadiums; no cylinders; long flows split in two |
| E-32 | Check provenance glyphs in the PDF render |
| E-34 | Other chart types through the plot engine, then the five-second test |
| E-35 | Dense Mode references, book builder and illustration engine not shipped; Dense Mode uses Table 2.2 and IL rules the Chapter 10 summary (PK) |
| E-36 | Installed symbol library: 41 symbols in 4 dialects, not 87 in 10; missing dialects drawn as named boxes with a printed legend |
| E-37 | The skill's sample RAB workbook breaks its own rules; not a template until rebuilt |
| E-38 | Ruling register R-23 to R-29 incomplete; content is written in the chapters |
| E-39 | Confirm maroon classification marking with the recipient's records officer; letters stay black |

---

## 7 · Exit codes [v1.7, Rev A silent]

`datum_lint.py`: `0` clean · `1` one or more checks failed · `2` file unreadable or format
unsupported. One line per failure with the check number, location and offending value.

---

## Perubahan dari v1.7

| # | v1.7 rule (section) | Rev A | Source | Class |
|---|---|---|---|---|
| 06-1 | "38 checks ... any failure blocks release" | Four stages; the file lint covers 27 of 38, reported 27/27; check 15 BAKU | ID p.79-80 / EN p.81-82 | CHANGED |
| 06-2 | Check 3 em dashes only, all text | ID: — and – both count, boilerplate excluded | TB-09, ID p.19 / EN p.32 | CHANGED |
| 06-3 | Check 4 question-form headings (openings and "?") | Only a heading ending with "?"; openings go to the guard | ID p.80, p.79 / EN p.81 | CHANGED |
| 06-4 | Check 11 "0 unmarked" | One mark at the home; ID screen ≤ 50 % | DT-21, ID p.38 / EN p.39 | CHANGED |
| 06-5 | Check 14 "≤ 5 values per page" | Fixed palette free; ≤ 2 meaning colours | DT-06, ID p.48 / EN p.50 | CHANGED |
| 06-6 | Check 15 blocking | BAKU (DEFAULT) | DT-10b, ID p.52 / EN p.54 | CHANGED |
| 06-7 | Check 17 meaning anywhere | Within 160 characters or SOURCE notation line | DT-30d, ID p.36 / EN p.37 | CHANGED |
| 06-8 | Check 19 "PPN other than 11 % for 2026" | Arithmetic VAT check; recap only; "PPN 12 % × DPP" allowed | DT-31a, ID p.17, p.80 / EN p.18, p.82 | CHANGED |
| 06-9 | Check 20 merged cells in computation zone | Merges outside COVER and PETUNJUK prose, plus hidden rows, columns, sheets | DT-40e, ID p.72 / EN p.74 | CHANGED |
| 06-10 | Check 21 "< 0.18 mm or tints < 15 %" | Word w:sz ≥ 5; tints exactly 15 % or 30 % | DT-11a, DT-11b, ID p.53 / EN p.56 | CHANGED |
| 06-11 | Check 28 "< 5.5 pt, 0" | Reduced page or slide sample exemption | DT-11d, ID p.68 / EN p.70 | CHANGED |
| 06-12 | Check 23 "outside a flowchart terminator" | Terminator = rectangle with 2 mm corners (E-29) | ID p.63, p.82 / EN p.66, p.85 | KEPT (terminator form clarified) |
| 06-13 | "Manual checks the script cannot make" (9 items) | Gate step 7 with the 21-item pre-delivery list (EN 22 items); items mapped in §4 | ID p.80-82 / EN p.83-84 | CHANGED |
| 06-14 | (none) | Gate of 10 steps by tier; call-site guard G1 to N1; jury and independent checker; colophon rule; open-defect table | ID p.79-82 / EN p.81-85 | ADDED |

Kept as v1.7 [Rev A silent]: purpose statement, the `require_edge_labels` exception, exit codes and
output format. The CL-U checks (unchanged) keep their v1.7 verdicts: 1, 2, 5 to 10, 12, 13, 16, 18,
22 to 27, 29 to 38.
