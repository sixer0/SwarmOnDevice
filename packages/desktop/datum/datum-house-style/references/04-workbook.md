# 04 · Workbook (.xlsx)

Standard: GSP Writing Manual Rev A, Chapter 11.1 to 11.4 (ID p.71-73 / EN p.73-75), plus the
cross-chapter rules that name workbooks (DT-12, DT-31a, DT-31b, DT-33, DT-06, DT-16, DT-09,
Annex A, E-37). Citations are **(ID p.N / EN p.N)**; "[v1.7, Rev A silent]" marks a v1.7 rule the
manual does not state and that is kept. Rule ids WB-nn are the Swarm 1.2.0 numbering of these
rules (row 74); the manual's own codes are given beside them.

**Build with `scripts/datum_xlsx.py`** (DT-40a, ID p.71 / EN p.73), the Rev A workbook builder in
this copy, run only with the bundled Python. `datum_xlsx.py --check <file>` is the manual's file
test for sheet order (WB-01). Do not use the sample workbook `samples/GSP DATUM Contoh RAB.xlsx`
as a template: Rev A lists the skill's sample cost workbook as breaking its own rules (ink900
title rule, Courier New foot, constants inside formulas, typed terbilang) until rebuilt (E-37,
ID p.82 / EN p.85).

Basis named in the manual: FAST Standard (1.02-02, 1.01-07) and Permen PUPR No. 8 Tahun 2023
(ID p.71-72 / EN p.73-74). ICAEW Twenty Principles and Operis [v1.7, Rev A silent].

---

## 1 · Sheets and names (11.1, ID p.71 / EN p.73)

**Sheets, in this order (WB-02, DT-40a, PK):** `COVER`, `PETUNJUK`, `KENDALI`,
`RINGKASAN-EKSEKUTIF`, `REKAPITULASI`, `RAB`, `AHS`, then `HITUNG-*`, one HITUNG sheet per
calculation domain, e.g. `HITUNG-KABEL` (WB-03). Figures flow one way, from the calculation sheets
to the recapitulation (Figure 11.1 caption, ID p.71 / EN p.73).

| Sheet | Purpose |
|---|---|
| `COVER` | identity; key figures only by reference, no constants [v1.7] |
| `PETUNJUK` | colour key, workbook structure, numbered model limits `BTS-nn` (§4) |
| `KENDALI` | cross-checks and the master flag (§4) |
| `RINGKASAN-EKSEKUTIF` | key figures with units and provenance [v1.7] |
| `REKAPITULASI` | value per chapter, PPN, total, Terbilang |
| `RAB` | bill of quantities and prices |
| `AHS` | unit price analysis, Permen PUPR 8/2023 |
| `HITUNG-*` | one calculation domain per sheet; the only home of constants |

- **Constants live only on HITUNG sheets, prices only on AHS; presentation sheets only refer**
  (FAST 1.02-02) (WB-07, ID p.71 / EN p.73). Calculate once and refer back (FAST 1.01-07).
- **Sheet names (WB-04, DT-12, Table 2.3, ID p.11, p.71 / EN p.11, p.73):** capitals with hyphens,
  at most 31 characters, no underscores, Indonesian. `RINGKASAN-EKSEKUTIF` takes a hyphen (PK).
  Lint 38 and the call-site guard N1.
- **File name (WB-05, ID p.71):** title, number with hyphens, revision, type code RAB:
  `Rencana Anggaran Biaya 008-GSP-RAB-VIII-2026 RevA.xlsx`. Wrong: `RAB_final_v2.xlsx`.
- **EN edition (WB-06, EN p.73, ID none):** PETUNJUK glosses the Indonesian sheet names in
  English (PK); sheet names stay Indonesian.

---

## 2 ⛔ Cell colour is the cell type (11.2, Table 11.1, DT-40b, ID p.71-72 / EN p.73-74)

| Colour | Token | Cell type | Reader's action |
|---|---|---|---|
| Amber | signal #B45309 | typed input (a constant) | may be checked and challenged |
| Verdigris | verd #2F6F6B | link to another sheet in this workbook | change it at its source |
| Ink | ink900 #101418 | formula on this sheet | do not overwrite |
| Red | alert #9B1C1C | link to an outside file, or an error | must be re-verified |

- **Every numeral's colour states its cell type (WB-08).** A typed volume is amber, not verdigris
  (ID p.72). A 12 % AHS overhead shows amber (ID p.72 / EN p.74). Reader's-action column [v1.7].
- **The key is written on PETUNJUK part A and shows all four colours (WB-09).** The meaning holds
  only in workbooks (ID p.71).
- These cell colours are exempt from the DT-06 meaning-colour count, and amber may appear on input
  cells (WB-13, ID p.48, p.89 / EN p.50, p.91).

---

## 3 · Fills, formulas, number formats (11.3, ID p.72 / EN p.74)

**Fills (DT-40c, PK).** **Fill only header rows: #101418 with white text** (WB-10). Group bands
have **no fill**; they are marked by Cond 600 capitals and a 0.45 mm rule (WB-11). No zebra
(ID p.72). **ink100 #EFF2F4 is a workbook screen band only, never a print fill** (WB-12, Annex A,
ID p.89 / EN p.91). Sheet header rows are exempt from the document table rule DT-16 (WB-14,
ID p.41 / EN p.43). Never the retired navy #1A2B4A or gold #C9A84C, in cells, borders, styles or
theme (WB-15, DT-07, ID p.48 / EN p.50).

**Formulas (DT-40d).** Compute once and refer (FAST 1.01-07). Never type a changeable value inside
a formula, never paste values from outside, split long formulas across cells (WB-16). Logic flows
top to bottom, left to right; one consistent purpose per column [v1.7, Rev A silent].

**Structure (DT-40e, lint 20).** **Merge nothing except COVER and PETUNJUK prose** (WB-17). **Hide
nothing: no hidden rows, columns or sheets** (WB-18). **Freeze panes below the header row**
(WB-19). Lint 20 does not read KENDALI; KENDALI is checked by eye (WB-20, ID p.72 / EN none).

**VAT and terbilang live only on REKAPITULASI (WB-21, DT-31a, check 19).** [Interpretation C22:
the VAT rate constants on a HITUNG sheet and the KENDALI VAT cross-check are not VAT amount rows.]

**VAT formula (WB-22, DT-31a, ID p.17, p.72 / EN p.18, p.74).** PPN = 12 % × DPP, DPP = 11/12 ×
subtotal (PMK 131/2024); unit prices exclude VAT; DPP, PPN and total round **down** to whole
rupiah, no further rounding unless the KAK asks. Right (ID p.72):
`=ROUNDDOWN(ROUNDDOWN(C10*'HITUNG-PAJAK'!C5,0)*'HITUNG-PAJAK'!C6,0)` with 11/12 typed once in C5
and 12 % in C6. Wrong: `=ROUND(C10*0.11,0)`.
[Interpretation C27: the manual prints the rate as "12 %" under the percent format `0.0" %"`; a
stored 0.12 under that format would print "0,1 %". The builder therefore stores the rate as 12
in a cell formatted `0.0" %"` and divides by 100 in the formula (`=DPP*rate/100`, rounded down).
Reported as a manual inconsistency.]

**HPS (WB-23, ID p.72 / EN none).** Round down to thousands of rupiah only when the KAK asks.

**Terbilang (WB-24, DT-31b, ID p.37, p.72 / EN p.38, p.74).** Generate the terbilang line under
every binding sum from the figure, by formula or code; it matches the figure word for word.

**AHS (WB-25, DT-33, ID p.72 / EN p.74).** Permen PUPR 8/2023: A labour, B materials, C equipment,
D = A + B + C, E = percentage × D **within 10 % sampai 15 %** (Pasal 11 ayat (3)), F = D + E.
Write the band, never "maksimum 15 %". Columns `No · Uraian · Kode · Satuan · Koefisien · Harga
Satuan (Rp) · Jumlah Harga (Rp)`; labour codes `L.01` Pekerja, `L.02` Tukang, `L.03` Kepala
tukang, `L.04` Mandor; unit OH [v1.7, Rev A silent]. **Coefficients: three significant figures
(0,150), format `0.000##`** (WB-26).

**Number formats (WB-27, DT-40f, Table 11.2, ID p.72 / EN p.74):**

| Use | Format code |
|---|---|
| Rupiah | `#,##0;-#,##0` |
| Volume | `#,##0.0` |
| Coefficient | `0.000##` |
| Percent | `0.0" %"` |

No `[Red]` anywhere. A negative KENDALI difference is shown by the GAGAL verdict, not by colour
(WB-28, ID p.72 / EN none). Check the printed PDF, because Excel takes separators from the
regional setting (WB-29). Money in tables and the RAB in full, never "rb" or a scaled form (WB-30,
DT-30g, ID p.36 / EN p.38).

---

## 4 · PETUNJUK, KENDALI, maroon head, print (11.4, ID p.72-73 / EN p.74-75)

**PETUNJUK (WB-34, ID p.73 / EN p.74)** holds three parts:

- **A · Kunci warna**: an example of each of the four cell colours with its meaning (WB-09).
- **B · Struktur workbook**: every sheet and what it holds. Per sheet: class, content, whether it
  has input cells, whether it prints [v1.7, Rev A silent on the detail].
- **C · Batasan model**, numbered `BTS-nn`. Right: "BTS-02 · Galian mengasumsikan tanah tidak
  berbatu...". Wrong: "Angka bersifat perkiraan." on COVER (ID p.73).

**KENDALI (WB-31, WB-32, DT-40g, ID p.73 / EN p.75).** Each check states its difference, its basis
and its verdict. Checks: silang jumlah, silang PPN, silang total, silang AHS ke RAB, uji nol
(ID p.73; EN names only "the cross-checks", EN p.74).

| Check | Method |
|---|---|
| Silang jumlah | subtotal on the detail sheet minus subtotal on the recapitulation [method v1.7] |
| Silang PPN | PPN minus the DT-31a path: `ROUNDDOWN(ROUNDDOWN(subtotal × 11/12) × 12 %)` [Interpretation C22] |
| Silang total | total minus (subtotal + PPN) [method v1.7] |
| Silang AHS ke RAB | unit price on AHS minus the same figure on RAB [method v1.7] |
| Uji nol | subtotal is zero when every volume is zero [method v1.7] |

Verdict formula: ID `=IF(ABS(Cn)<0.5,"LULUS","GAGAL")`; EN `"PASS","FAIL"` (WB-31). The wording
follows the workbook language [Interpretation C22].
[Interpretation C22: v1.7's "PPN minus 11 % of subtotal" fails a correct Rev A workbook. On
Derivation 3.7a's own figures 11 % of Rp 651.575.000 is Rp 71.673.250 and the DT-31a path gives
Rp 71.673.249, a difference of 1, so `ABS(Cn)<0.5` would read GAGAL. The check compares with the
rounded-down DT-31a path; a check against 11 % of the subtotal takes a tolerance of 1.]

**Master flag (WB-33, DT-40g, ID p.73 / EN p.75).** Release only when the master flag in the frozen
pane reads **SELURUH UJI LULUS** (EN **ALL CHECKS PASSED**). The flag is verd when passing and
alert when failing (ID). A flag formula such as `=IF(COUNTIF(D8:D12,"GAGAL")=0,...)` [v1.7; Rev A
gives the flag string only]. Operis hand checks before release (test numbers 1, 10, 1 000;
magnitude; ratio against comparable projects; left-to-right scan) [v1.7, Rev A silent].

**Maroon head (WB-35, DT-40h, Table 8.1, ID p.73, p.49 / EN p.75, p.51).** On every sheet the
classification and the title-bar rule are **seal #6E1420**, replacing the builder's ink900 rule.
The classification is in capitals under the number, in the running head and in the register
foot (WB-36, DT-28c, ID p.14 / EN p.14).

**Print (WB-37, DT-40i, ID p.73 / EN p.75).** A4, one page wide, repeating header rows, gridlines
off, register foot 7 pt Mono. Fit to height 0, footer pattern `GSP · {doc id} | REV {rev} ·
{date}` / `{sheet} · lembar &P dari &N`, margins 0.55 in left and right, 0.6 top, 0.7 bottom
[v1.7, Rev A silent].

**Fonts (WB-38, WB-39, DT-09, Figure 8.4, ID p.50, p.73 / EN p.51-52).** Workbook cells in IBM Plex
Sans (bands Cond, foot Mono); never Calibri, Courier New or Arial. **Ship the font folder with
every `.xlsx`.**

---

## 5 · Process rules that name workbooks

- **Tier before build (WB-42, DT-02, ID p.10 / EN p.10):** NOTA default, TERBIT, SERAH; a package
  (study, RAB, schedule) rises together. EN PK-14 tiers documents, workbooks, decks and drawings
  (EN p.10).
- **Fix at the source and rebuild (WB-41, PK-10, ID p.12 / EN p.12):** a wrong RAB terbilang is
  fixed in the register, then the workbook is rebuilt; never patch the finished file.
- **Charts for a RAB (WB-43, Table 9.6, ID p.61 / EN p.64):** Sankey, treemap, waterfall, 100 %
  stacked bar TKDN; avoid a pie with many slices. The EN list differs in wording (internal Sankey,
  TKDN stacked bar).

**Why it matters [v1.7].** FAST 2.06-02: "Unless clearly documented and presented to the model
customer, implicit assumptions may be construed as nothing more than serious model error." A
workbook that cannot be printed cleanly cannot be submitted, and a tender panel will print it.

---

## Perubahan dari v1.7

| # | v1.7 rule (section) | Rev A | Source | Class |
|---|---|---|---|---|
| 04-1 | Preamble: `excel-master` and `gsp-keuangan-excel` own logic and content, DATUM owns the skin | Not stated; in Swarm there are no such skills (SKILL.md §0) | n/a | REMOVED |
| 04-2 | §1 sheet `RINGKASAN EKSEKUTIF` with a space | `RINGKASAN-EKSEKUTIF`; names in capitals with hyphens, ≤ 31 characters | DT-40a, DT-12, ID p.71, p.11 / EN p.73, p.11 | CHANGED |
| 04-3 | §1 sheet class column (Sajian, Kendali, Dasar harga, Hitung) | Classes not named; flow and constants/prices/refer split only | ID p.71 / EN p.73 | KEPT as description [Rev A silent] |
| 04-4 | §2 fills: ink900 header rows and **ink100 group bands** | Group bands without fill (Cond 600 capitals + 0.45 mm rule); ink100 never a print fill; header fill #101418 with white text | DT-40c, Annex A, ID p.72, p.89 / EN p.74, p.91 | CHANGED |
| 04-5 | §4 Silang PPN = PPN − 11 % of subtotal | Compare with the DT-31a rounded-down path [Interpretation C22] | DT-31a, ID p.17 / EN p.18 | CHANGED |
| 04-6 | §4 KENDALI strings Indonesian only; fail message "ADA UJI YANG GAGAL — JANGAN TERBITKAN" | ID LULUS/GAGAL/SELURUH UJI LULUS; EN PASS/FAIL/ALL CHECKS PASSED; fail message not in Rev A | DT-40g, ID p.73 / EN p.75 | CHANGED |
| 04-7 | §5 "koefisien to three non-zero decimals" | Three significant figures (0,150), format `0.000##` | ID p.72 / EN p.74 | CHANGED |
| 04-8 | §5 "HPS totals round down" (always) | DPP, PPN, total round down to whole rupiah; HPS to thousands only if the KAK asks | DT-31a, ID p.17, p.72 | CHANGED |
| 04-9 | §5 row E "band 10 %–15 %" | Same band written "10 % sampai 15 %", cited to Pasal 11 ayat (3), D = A + B + C, F = D + E | DT-33, ID p.72 / EN p.74 | KEPT (wording) |
| 04-10 | §6 "no merged cells in any computation zone" | Zero merged cells outside COVER and PETUNJUK prose | DT-40e, ID p.72 / EN p.74 | CHANGED |
| 04-11 | §6 freeze pane "carries the time or period axis and the master flag" | Freeze below the header row; master flag in the frozen pane; time axis not mentioned | DT-40e, DT-40g, ID p.72-73 / EN p.74-75 | CHANGED |
| 04-12 | §6 "units belong in the label on every line item" | Not stated for workbooks | n/a | KEPT [Rev A silent] |
| 04-13 | §7 footer "classification in seal" | Classification **and the title-bar rule** in seal on every sheet | DT-40h, ID p.73 / EN p.75 | CHANGED |
| 04-14 | (none) | Four number formats and zero `[Red]`; negative difference by verdict; check the printed PDF | DT-40f, ID p.72 / EN p.74 | ADDED |
| 04-15 | (none) | VAT formula shape with both factors on a HITUNG sheet, ROUNDDOWN twice; rate cell per C27 | DT-31a, ID p.72 / EN p.74 | ADDED |
| 04-16 | (none) | Font folder ships with every `.xlsx`; IBM Plex Sans cells; no Courier New foot | DT-09, E-37, ID p.50, p.82 / EN p.52, p.85 | ADDED |
| 04-17 | (none) | File name with type code and revision; EN PETUNJUK gloss; lint 20 skips KENDALI; money in full; tier and charts for RAB; sample workbook not a template | ID p.71-72, p.36, p.61, p.82 / EN p.73-74, p.38, p.64, p.85 | ADDED |

Kept as v1.7 [Rev A silent]: sheet purposes and classes, reader's-action column, ICAEW and Operis
basis, PETUNJUK part B detail, master-flag formula, Operis hand checks, AHS columns and labour
codes, column purpose and flow, units in labels, print fit-to-height, footer pattern and margins.
