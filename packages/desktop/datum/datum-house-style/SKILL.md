---
name: datum-house-style
version: "Rev A (Manual Penulisan PT GSP XXX/GSP/STD/XI/2026 Rev A: ID 2 November 2026, EN 3 November 2026)"
description: >-
  DATUM, the GSP house style, Rev A. The form authority for every GSP document and drawing,
  following the GSP Writing Manual Rev A (Manual Penulisan PT GSP, ID 2 Nov 2026 / EN 3 Nov 2026).
  Owns grid, type, colour, page furniture, table, chart and drawing grammar, evidence apparatus,
  Indonesian classification, numbers and units, naming, workbook and briefing form, and the
  38-check release battery. In Swarm, DOCX, HTML, SVG and PDF are made with the datum-studio MCP
  tools, and XLSX and PPTX with the Rev A Python builders in scripts/. AUTO-ACTIVATE on any GSP
  document or drawing: the caller owns content, DATUM owns form. ACTIVATE (ID/EN): house style,
  template GSP, format laporan, rapikan formatnya, tipografi, klasifikasi dokumen,
  RAHASIA/TERBATAS, penamaan berkas, nomor dokumen, PPN, RAB, workbook, paparan, cek lint; and
  any drawing: diagram arsitektur, diagram alur, flowchart, skema, gambar teknik, topologi
  jaringan, swimlane, single-line, elevasi rak, buatkan diagram, Mermaid. NEVER UNDERTRIGGER.
license: GSP Internal Use Only
---

# DATUM, GSP House Style, Rev A

**Standard in force.** *Manual Penulisan PT GSP Bahasa Indonesia*, number XXX/GSP/STD/XI/2026,
Revisi A, 2 November 2026, 98 sheets, and *GSP English Writing Manual*, same number, Revision A,
3 November 2026, 99 sheets. Both name their basis as "datum-house-style v1.9 Rev O"; custodian
ENG-01, Divisi Engineering PT GSP; tier TERBIT (ID p.1, p.6 / EN p.1, p.6). The full text of both
editions ships with this skill in `references/rev-a/` (see its README for checksums).

This file replaces the DATUM v1.7 Rev I text (GSP-DS-001, 4 August 2026). Every rule below
carries its source as **(ID p.N / EN p.N)**, the printed sheet number of each edition. "EN none"
or "ID none" means that edition does not state the rule. A rule marked **[v1.7, Rev A silent]**
is a v1.7 rule the manual neither changes nor removes; it stays as it was. A line marked
**[Interpretation ...]** is a reading made for Swarm 1.2.0, not manual text. Changes from v1.7
are listed at the end of this file and at the end of every reference.

**If this file and the manual disagree, the manual wins.** Report the difference; do not
average the two.

---

## 0 · Swarm note (replaces the Claude-only parts of v1.7)

This copy of DATUM runs inside Swarm. Several things v1.7 named exist only in Claude's own
environment. In Swarm:

| v1.7 named | In Swarm |
|---|---|
| LOKUS (`gsp-output-locality`), `SendUserFile`, `device_commit_files` | Not available. Write deliverables into the user's project folder (or the output folder the user names) with the normal file tools, or download Studio outputs there with `studio_file_verify`. The duty itself stays: the finished file lands in the user's project folder (PK-09, ID p.12 / EN p.12) |
| `kronik` (KRONIK) and its canonical folder file | Not available. Use the project's own folder structure. The manual's five LOKUS parent folders (00 Indeks dan Serah Terima, 01 Masukan, 02 Proses, 03 Hasil, 04 Arsip; ID p.12 / EN p.12) are a reference when the user asks for a structure |
| `arsip` (ARSIP Register Induk) | Not available as a skill. The rules stay: take the number from the register the user names before building; if none is reachable, use `XXX/GSP/<KODE>/<BULAN>/<TAHUN>` and hold release (DT-04a, ID p.12 / EN p.12) |
| Figma and Excalidraw MCP loop, `datum_figma_audit.py` | Not configured by default. Rev A itself drops Figma export (DT-35, ID p.70 / EN p.72). The Studio SVG is the drawing deliverable |
| Sibling skills: `gsp-visual-commander` (PRISMA), `gsp-professional-documents`, `excel-master`, `gsp-keuangan-excel`, `gsp-presentation-maestro`, `gsp-ui-architect`, `veritas`, `knowledge-master` | Not part of Swarm. Where the manual hands a decision to one of them (chart or drawing choice, ID p.54 / EN p.57), make it yourself under the manual's rules. Content and numbers still come from the user: return unsourced content with one line naming the gap (PK-03, ID p.7 / EN p.7) |

Run every Python script only with the bundled Python named in the Swarm note above this file,
never with another interpreter, and never write inside the skill folder.

**Edition.** The ID edition governs Indonesian text and the EN edition governs English text.
[Interpretation: row 76 A1 and row 77 A2 of the Swarm 1.2.0 research; the manual states that the
ID edition rules Indonesian documents and that English text follows the separate English rules,
ID p.6.]

---

## 1 · Routing in Swarm (decision D-C)

| Output | Route |
|---|---|
| `.docx` report, proposal, kajian, sheet (lembar), HTML | **datum-studio MCP tools.** `studio_write` writes, checks, renders and verifies in one call; for finer control use `studio_templates_list`, `studio_template_get`, `studio_document_create`, `studio_chapter_import_markdown` or `studio_chapter_submit`, `studio_slot_fill`, `studio_document_status`, `studio_render`, `studio_file_verify` |
| PDF | Studio renders it from its HTML through Swarm's built-in Chromium (`studio_render`) |
| SVG and PNG figures (charts and technical drawings) | Studio: `studio_figure_preview` to check, `studio_figure_revise` to change one figure, `studio_render` for the files. Word takes the 300 dpi PNG (DT-36, ID p.63 / EN p.66) |
| `.xlsx` (RAB, BoQ, any workbook) | `scripts/datum_xlsx.py`, the Rev A workbook builder (Chapter 11.1 to 11.4; `references/04`) |
| `.pptx` (command brief, paparan) | `scripts/datum_pptx.py`, the Rev A briefing builder (Chapter 11.5 to 11.7; `references/05`). A slide figure is the PNG Studio renders [Interpretation C28] |
| Release check | Studio returns its own checks with every write and render; read them. `scripts/datum_lint.py` checks `.xlsx` and `.pptx` (`references/06`) |

Swarm shows these tools to the model as `datum-studio_<tool>`. Studio runs inside the Swarm
app: when Swarm is not running there is no Studio, and the error says so. Full tool map and
the template tools: `references/07-ekosistem-routing.md`.

The v1.7 Python engines still in `scripts/` (`datum_docx.py`, `datum_diagram.py`,
`datumchart.py`, `datum_render.py`, `datum_symbols.py`) were written for v1.7 and were not
brought to Rev A in Swarm 1.2.0. They are not the delivery route for DOCX, HTML, SVG or PDF.

---

## 2 · The governing rule, levels and authority

**Put on the page only evidence and the apparatus that proves it** (DT-01a, ID p.6 / EN p.6).
Apparatus is what makes a claim checkable: the source line, the provenance mark, the
derivation block, the requirement ID, the evidence rail (ID p.6).

| Level | Meaning | If broken (Table 1.1, ID p.6 / EN p.6) |
|---|---|---|
| WAJIB / MANDATORY | Regulation, compliance or gate | Release defect. The file goes back to its source and is rebuilt |
| BAKU / DEFAULT | GSP default form | May depart with a one-sentence reason in the change log |
| ANJURAN / ADVISORY | Writing and presentation quality | Noted by the judge or checker; does not hold release |

One code is one rule with one level, written once in its home chapter. An uncoded
instruction is ANJURAN unless a coded rule repeats it (ID p.6 / EN p.6).

- **Authority (PK-01, ID p.7 / EN p.6).** Settle every rule clash with the five-level hierarchy
  of Figure 1.1: regulation and contract beat every house rule, and the newest standard
  edition decides only when the levels above are silent. Inside one level, `tokens.json` beats
  prose (DT-03), Table 8.1 beats other colour sources, and SG rules beat language guides
  (ID p.7). A client's or the Director's request sets content (level 4); a written Director
  ruling that changes a house rule is recorded as R-nn (ID p.7).
- **New clashes (PK-02, ID p.7 / EN p.7)** are recorded as the next R-nn row, from R-31, before
  release. "(PK)" marks a working ruling that binds until the Director rules otherwise (ID p.7).
- **Owner split (PK-03, ID p.7 / EN p.7).** Domain specialists own content and numbers; DATUM
  owns form. Return content without a source to its owner with one line naming the gap, or
  write `[angka dari pemilik isi]`, or label it "ilustratif" in the caption or SOURCE line. Such
  a document is DRAF and is never released.
- **Values.** Take colour, type, grid and rule values from `tokens.json`; if prose differs,
  `tokens.json` wins, except the rulings recorded in Annex A (DT-03, ID p.45 / EN p.47). Annex A
  gives five rulings that beat the tokens: classification in seal and letters in black, rules
  and ticks at least 0.18 mm, ANSI/ISA-5.1-2024, hyphenated sheet names, Spine String on cover,
  back cover and dividers (ID p.89 / EN p.91). [Interpretation: the manual's DT-03 test names
  tokens.json v1.9; the `tokens.json` in this copy is the v1.7 file brought to Rev A by row 99.
  Where it still disagrees with Annex A, Annex A wins and the difference is reported.]

---

## 3 · Procedure and tier

**Ten steps, in order (PK-04, Table 1.3, ID p.8 / EN p.7-8).** 1 write recipient, channel,
language and deadline; 2 set tier and Dense Mode status; 3 set classification (Figure 3.1);
4 look up officials, rates, prices, regulations and editions in force; 5 for TERBIT and SERAH,
take the number and form the file name; 6 build the quantity register (value, unit, mark,
source); 7 write text and drawing specs from the register; 8 build the file with its format's
builder; 9 run the tier's release gate; 10 record the change, land the file, record its
checksum, report. NOTA skips steps 5 and 8; chat runs steps 1 and 4 only.

**Missing procedure data (PK-05, ID p.8 / EN p.8).** Carry on with a safe assumption marked △
and named in the handover report. Never ask for the classification level (3.2). Ask only when a
binding money value has no source, and hold release until it has one. With no named recipient,
use the safe default: internal GSP, tier NOTA, ANRI scheme (ID p.9 / EN none).

**Tier (DT-02, ID p.10 / EN p.10).** Set the tier before building. NOTA is the default.
Climbing a tier must be justified; staying never. A package (kajian, RAB, schedule) climbs
together, at one gate, in one pass. NOTA keeps provenance marks and the register.

| Tier | Form | Gate steps (ID p.80 / EN p.83) | When |
|---|---|---|---|
| `NOTA` | Markdown; no cover, register block, PDF or lint [v1.7, Rev A silent on the list of what it drops] | 1 and 10 | Read only inside this division |
| `TERBIT` | Full DATUM file | 1 to 5, 7 and 10 | Crosses divisions or feeds another document |
| `SERAH` | Full apparatus, PDF, number audit | all 10 | Read by an outside party or attached to a tender |

The test: can you name someone outside this division who will read it? If not, it is NOTA
(Figure 2.1 caption, ID p.10 / EN p.10).

**SERAH duties (PK-06, Table 2.1, ID p.10 / EN p.10).** Per document: a second derivation route
for every recapitulation quantity, shown with the difference in a reconciliation table; a
derivation block, machine-checked and closed with its consequence, for every load-bearing
number; the evidence rail used on load-bearing pages; technical drawings from a spec, never
sketched, never Mermaid.

**Dense Mode (PK-07, BAKU, ID p.11 / EN p.11).** Only when the request says "padat" or "dense",
or asks for a manual or handbook. Measure the finished PDF per page: 280 to 340 words, figures
0.5, tables 0.8, quotations 2, page fill 85 % (Table 2.2). A page below profile is WARN and is
fixed by adding content, not by enlarging type (PK). Not a fourth tier.

---

## 4 · Names and numbers

**No underscore in any name a person reads (DT-12, ID p.11 / EN p.11).** Folders, files, sheets,
table and figure IDs, engineering identifiers: spaces or hyphens. DT-12 does not apply to names
that program syntax requires: Python modules, variables, placeholders (KD-06) and JSON keys.

| Object | Form | Right | Wrong (Table 2.3, ID p.11-12 / EN p.11) |
|---|---|---|---|
| Folder | two-digit order prefix | `03 Hasil` | `03_hasil` |
| NOTA file | title and ISO date | `Nota Rencana Uji 2026-11-02.md` | `nota_uji.md` |
| Workbook sheet | capitals, hyphen, max 31 characters | `HITUNG-KABEL` | `HITUNG_KABEL` |
| Table and figure ID | word, space, number | `Tabel 4.1` | `Tabel_4.1`, `g2` |
| Engineering identifier | hyphen | `REQ-FO-05` | `REQ_FO_05` |
| Document file | title, number with hyphens, revision | `Rencana Anggaran Biaya 008-GSP-RAB-VIII-2026 RevA.xlsx` (ID p.71) | `RAB_final_v2.xlsx` |

Build the file name from the same string as the caption or title (Figure 2.2, ID p.11 / EN p.11).

**Number (DT-04a, ID p.12 / EN p.12).** Take it from the Register Induk before building. If the
register is out of reach, use `XXX/GSP/<KODE>/<BULAN>/<TAHUN>` in the document and its hyphen
form in the file name, with the document's own code and month, note it, and hold release until
the real number is taken. Revisions raise the Rev, never the number: Draf 1, Draf 2, then RevA,
no decimals. Every issued file carries a revision history block.

**Pattern (DT-04b, ID p.15 / EN p.15).** `005/GSP/KT/VIII/2026`: Roman month, no classification
prefix (no SR, R, T or B in front). Type codes are a closed list (Table 3.1, ID p.15 / EN p.15):
PT, KT, RAB, SPH, SP, BA, NDA, DEK, LAP, MAT, STD, NOT, MOD, VER. DS is retired.

**Change log (PK-08, ID p.12 / EN p.12).** One line per change: what · why · effect.
**Land the file (PK-09, ID p.12 / EN p.12)** in the user's project folder. **Fix at the source and
rebuild (PK-10, ID p.12 / EN p.12)**; never patch a finished file.

---

## 5 · Compliance: defects, not preferences

Chapter 3 rules are WAJIB and sit at levels 1 and 2 of the hierarchy; no form or language rule
can loosen them (ID p.13 / EN p.13). Full text: `references/01-kepatuhan-klasifikasi.md`.
**Read it before writing any RAB or any classified document.**

- **Classification by recipient (DT-28a, ID p.13 / EN p.13).** Kemhan and TNI have no TERBATAS;
  Polri, civil bodies, BIN, BNPT and internal GSP do (lint 18).
- **Choose the level without asking (DT-28b, ID p.13 / EN p.13):** first the RAHASIA floor for
  installation, case and personal data; then the client's level if not below the floor; then
  the recipient scheme by content. When unsure between two, take the higher and mark △.
- **Marking (DT-28c to DT-28e, ID p.14 / EN p.14-15):** capitals on its own line under the number;
  in DATUM documents also at the right of the running head and in the right cell of the
  register block; classification text in **seal #6E1420, bold, never alert**; urgency (derajat)
  on its own line, never in the classification field. Letters to Indonesian government bodies
  stay black (DT-32).
- **Regulations (DT-29a, Table 3.2, ID p.15 / EN p.15):** cite only the "Cite" column.
- **VAT (DT-31a, ID p.17 / EN p.18):** PPN 12 % on DPP nilai lain 11/12 of the subtotal, computed
  only in the recapitulation; unit prices exclude VAT; DPP, PPN and total round down to whole
  rupiah (Derivation 3.7a). Prose may say "termasuk PPN 11 % efektif".
- **Stamp duty (DT-29b, ID p.17 / EN p.18):** "meterai Rp 10.000" (UU No. 10 Tahun 2020).
- **Letters to government bodies (DT-32, ID p.16 / EN p.16):** the recipient's Tata Naskah Dinas,
  Arial 12, black ink including the classification. The report it carries stays DATUM.

---

## 6 · Colour

**Ground (DT-05, ID p.48 / EN p.50).** Paper #FCFCFB (interior) or #FBFAF7 (wrapper). A dark
ground only when a written task names a command centre, HUD, dark mode, a 24-hour operations
screen, or a client register that requires it. "Defence", "premium" or "serious" is not such a
task (ID p.49 example: an unrequested dark BNPT deck is wrong).

**Counting (DT-06, ID p.48 / EN p.50).** The fixed palette (paper, ink900, ink700, ink400, ink200,
seal, chapter kicker) is not counted on a page. A page carries at most **2 meaning colours**:
signal plus one of alert or verd, never alert with verd, and provenance glyphs count (PK). A
figure or chart carries at most **5 hex values besides the white ground** (lint 14 and 25). The
workbook cell colours of Table 11.1 are excepted (EN p.50).

**Roles (DT-13c, ID p.48 / EN p.50).** GSP identity and classification in seal maroon; chapter and
slide kickers in signal; document-type kicker in seal. Amber only on the chapter kicker, one
subject, or the ◈ glyph (and workbook input cells, EN p.50). **Retired: navy #1A2B4A and gold
#C9A84C** (DT-07, ID p.48 / EN p.50); a search of files and templates must find nothing.

**Palette (Annex A Table A.1, ID p.89 / EN p.91).**

| Token | Hex | Role |
|---|---|---|
| paper (wrapper), ink, body | #FBFAF7, #14110F, #33302C | cover paper, title and prose |
| meta, rule | #7A756E, #C4BEB4 | letterhead address and Spine String, cover rules |
| seal | #6E1420 | identity: letterhead, Seal Band, Issue Stamp, classification |
| paper (interior) | #FCFCFB | ground of every output |
| ink900 | #101418 | headings, numerals, axes, ■ |
| ink700 | #2B3640 | body prose and captions |
| ink400 | #6B7783 | labels, SOURCE, rail, chart context, ◇ |
| ink200 | #C3CBD1 | row dividers, chart ground |
| ink100 | #EFF2F4 | workbook screen band only, never a print fill |
| signal | #B45309 | one figure subject, ◈, chapter kicker, typed workbook constants |
| alert | #9B1C1C | over the limit, △, errors and links to outside files |
| verd | #2F6F6B | improving, links between sheets |

Seal Band text #F4F5F6. Tints only 15 % and 30 %. No blue, navy or gold. Dark brief, on
written request only: ground #0E1216, head #F2F4F5, prose #AEB8C0, accent #D98324, meta #7C8894,
hairline #232B33 (ID p.89 / EN p.91); head classification #D9756A (DT-41a, ID p.74 / EN p.76).

Body prose is ink700; ink900 is for headings, primary rules and numerals [v1.7; Rev A Table 8.2
agrees, ID p.50 / EN p.52].

---

## 7 · Type

Four IBM Plex faces (Figure 8.4, Annex A.2, ID p.50, p.89 / EN p.51, p.91):

| Role | Face | Carries |
|---|---|---|
| Structure | IBM Plex Sans Condensed (Cond) 400/500/600 | headings, running head, table heads, labels, captions |
| Reading | IBM Plex Serif 400/600 + italic | body prose |
| Data | IBM Plex Mono 400/600 | every numeral, ID, coordinate, register block, rail (ID p.49) |
| Workbook | IBM Plex Sans | workbook cells only |

DejaVu Sans is embedded for ■ ◈ ◇ △, Greek letters, √ ≤ and → (ID p.49 / EN p.51).

- **Plex only (DT-08a, ID p.50 / EN p.52):** no Calibri, Times New Roman, Aptos or Arial as body
  face (lint 5). Exception: a Tata Naskah Dinas covering letter in Arial 12 (DT-32).
- **Embed (DT-09, ID p.50 / EN p.52):** every `.docx` embeds its fonts; a PDF always embeds; an
  `.xlsx` or `.pptx` ships with the font folder (`assets/fonts/`, with `PASANG-DULU.txt`).
- **Fallback** when a client edits and cannot install fonts: Segoe UI Semibold, Georgia, Consolas
  (ID p.50 / EN p.52).
- **Labels (DT-08b, BAKU, ID p.50 / EN p.52):** capital labels in Cond at +0.09 em, display titles
  at −0.012 em, prose #2B3640; never a label made of shrunken Serif.

Core sizes (Table 8.2, ID p.50 / EN p.52): chapter title 16/20 pt Cond 600 ink900; chapter kicker
6.8 pt Cond 600 capitals +0.16 em signal; body 9.5/13.5 pt Serif ink700; table numeral 7.8 pt
Mono flush right ink900; table head 6.8 pt Cond 600 capitals +0.09 em ink400; caption 7.6/11 pt
Cond 400 ink700. Full scale: `references/02` and Annex A.2.

---

## 8 · Grid, A4

```
|<-24 mm->|<---- 128 mm text ---->|<-6->|<-- 32 mm evidence rail -->|<-20 mm->|
```

24 + 128 + 6 + 32 + 20 = 210 mm; full span 166 mm; 12 subcolumns of 10.667 mm (Derivation 8.6a,
ID p.51 / EN p.53). Vertical limits from the top edge: running head 13, body top 26, body bottom
273, foot (register block 8.5 mm) 284 mm; text block 247 mm (Table 8.3, ID p.52 / EN p.54).

- **Width (DT-10a, ID p.51 / EN p.53):** nothing wider than 166 mm; every figure 128 or 166 mm.
- **Baseline and measure (DT-10b, BAKU, ID p.52 / EN p.54):** body spacing, heading space, table
  rows and figure heights are multiples of 13.5 pt; line length 66 to 80 characters (check 15).

---

## 9 · Page furniture

**Interior (DT-13a, ID p.46 / EN p.48).** Every chapter starts a new Word section. The logo is on
the cover only. The running head names the chapter on that page. Headings to three levels
(4, 4.2, 4.2.1), never a fourth; numbered equations right-aligned (ID p.46).

**Cover, top down (8.2, ID p.47 / EN p.49):** 1 Seal Band; 2 logo 44 to 46 mm; 3 address line;
4 clear space to the Datum Rule; 5 Datum Rule 166 mm; 6 document-type kicker 7.4 pt Cond 600
seal +0.20 em; 7 title 24 to 26 pt Cond 600 w-ink, line ≤ 150 mm; 8 standfirst 10.5 pt Serif
italic w-body; 9 scope line 7.6 pt Cond w-meta; 10 control block 4 × 2 under a 0.45 mm rule,
labels 6.4 pt Cond, values 7.4 pt Mono; 11 colophon; 12 Spine String. The control block holds
number, revision, preparer, custodian, addressee, sheets, geodetic datum and verification; the
preparer is always "Divisi Engineering PT GSP" (EN "Engineering Division, PT GSP").
**Everything ranged left at 24 mm; logo once in the whole document** (DT-14, lint 6,
ID p.47 / EN p.49).

**Control sheet (ID p.48 / EN p.49).** Follows the cover: revision history, three-layer
verification chain, method statement, controlled distribution, three signature columns. Every
numbered copy has a named holder (DT-13b, ID p.48 / EN p.50). Cover, control sheet and dividers
carry no sheet number; numbering starts on the first page of Bab 1 (ID p.48). EN: sheets count
from the cover (EN p.50). A document over 20 pages has a contents list to section level.

**GSP letterhead in seal (Table 8.1, ID p.49 / EN p.51):**

| Element | Colour and form |
|---|---|
| Seal Band | seal fill, text #F4F5F6, 5 mm × 166 mm, classification left, copy control right |
| Address line | 7 pt Cond w-meta, fixed text, 0.18 mm w-rule below |
| Colophon | entity and NIB left in w-meta, Issue Stamp right in bold seal |
| Running head | text ink400, classification bold seal, rule seal 0.26 mm |
| Register block | top rule seal 0.35 mm, bottom ink200 0.20 mm, classification cell bold seal |
| Workbook and deck | classification and title-bar rule in seal |

Fixed text, copied exactly (ID p.49 / EN p.51): `Divisi Engineering & Technical Intelligence ·
Jl. Bangka Raya No. 27, Pela Mampang, Jakarta Selatan 12720 · Tel. (021) 22715320` and
`PT GEMILANG SATRIA PERKASA · NIB 9120208940517`. **Sample the PDF on every build:** cover band,
running-head rule and register top rule read RGB 110, 20, 32 ± 3 (DT-13d, ID p.49 / EN p.51).

Logo colour differs by edition: the ID test reads the logo as seal (DT-13c, ID p.48); the EN
edition keeps the logo black ink, once (Table 8.1, EN p.51). Indonesian documents use
`assets/logo/gsp-seal.png` (seal #6E1420, ID p.48); English documents use
`assets/logo/gsp-tinta.png` (black, EN p.51). [gsp-seal.png is gsp-tinta.png recoloured to
#6E1420 with its alpha kept, decision C46; provenance in `references/rev-a/README.md`.]

**Six signature devices, each in one place (8.7, DT-13e, ID p.52 / EN p.54-55):**

1. **Seal Band**: head of the cover and the control sheet. Left `KLASIFIKASI · {level}`; right
   `SALINAN {c} DARI {C} · TIDAK UNTUK DIEDARKAN`, or `SALINAN INDUK · PENGGUNAAN INTERNAL GSP`
   on the master copy (Annex A.5, ID p.90 / EN p.92).
2. **Datum Rule**: above chapter titles, once on the cover and once per divider. Hairline
   0.20 mm with 1.15 mm ticks drawn at 0.18 mm or heavier (DT-13f, Table A.3, ID p.53, p.90 /
   EN p.55, p.92). In a PDF the lead segment grows with the page number; in a `.docx` it stays
   9 mm (ID p.53 / EN p.55).
3. **Evidence Rail**: the outer 32 mm column of interior pages. An empty rail is correct
   (DT-43, BAKU, ID p.38 / EN p.39).
4. **Register Block**: foot of every interior page:
   `GSP · {number} │ REV {rev} · {DD-Roman month-YYYY} │ LEMBAR {n} DARI {N} │ {classification}`
   (Annex A.5, ID p.90). Document and sheet numbers bold ink900; the total comes from a
   NUMPAGES field; cell separators are non-breaking spaces (DT-13g, ID p.53 / EN p.56).
5. **Spine String**: outer margin of the cover, every divider and the back cover (DT-13f, PK):
   `{type}, {subject}, {language}, rev. {rev}, {month} {year}` (ID p.90).
6. **Issue Stamp**: in the colophon, bold seal: `// 20261102 ID T — TERBITAN 1`, i.e. date,
   language, classification letter (B, T, R, SR), issue number (Table 6.2, Annex A.5, ID p.37,
   p.90). EN: `// 20261103 EN T — ISSUE 1` (EN p.56).

---

## 10 · Evidence apparatus

Full grammar: `references/03-tabel-gambar-apparatus.md`.

**Provenance marks (Table 7.1, ID p.38 / EN p.39):**

| Glyph | Label (ID / EN) | Meaning | Colour |
|---|---|---|---|
| ■ | TERUKUR / MEASURED | read from a source document or instrument | ink900 #101418 |
| ◈ | DITURUNKAN / DERIVED | computed from measured inputs; derivation shown | signal #B45309 |
| ◇ | PEMASOK / VENDOR | vendor datasheet claim, not independently verified | ink400 #6B7783 |
| △ | ASUMSI / ASSUMED | assumption with an ID and an impact statement | alert #9B1C1C |

- **One mark per load-bearing number, at its home** (the table or derivation where it is stated).
  In tables, derivations, SOURCE lines and the rail the glyph always carries its label; in prose
  the glyph may stand alone after the key has appeared once (DT-21, check 11, ID p.38 / EN p.39).
- **One mark per clause**; move extra marks to the rail or table row, never delete them (DT-22,
  ID p.38 / EN p.40).
- **Number binding (DT-23, ID p.40 / EN p.41).** Every load-bearing number is taken from the
  quantity register by name, never typed. Plain integers such as 70 and English-format numbers
  are not audited; the checker matches them by eye at gate step 7.
- **Derivation block (DT-24, ID p.40 / EN p.41).** Show the real arithmetic; mark every input,
  including reserves and factors; close with what happens if the assumption fails. ID form
  `Turunan <bab>.<urut><huruf>` (Turunan 7.5a); intermediate lines show one more decimal than
  the result.
- **Admiralty digraph (DT-25, ID p.39 / EN p.40).** Every external claim carries a two-character
  grade (NATO AJP-2.1, STANAG 2511), letter and digit judged separately. Example
  `◇ PEMASOK [C3] · lembar data OEM rev 4`.
- **Likelihood words (DT-26, ID p.39 / EN p.41)** from the seven ICD 203 terms; not for GSP
  schedule commitments; a computed probability is written as a number with its basis.
- **Assumption register (DT-27a, ID p.41 / EN p.42)** at the end of the chapter or in an annex,
  columns ID, assumption, impact if wrong, verification. **Requirement IDs (DT-27b)** assigned once
  and carried unchanged across the package. ASM and REQ domains are a closed list: CAM, REC,
  NET, PWR, CIV, SEC, RDR, VMS, FOR, OSI, SW, OPS, DOK (ID p.41 / EN p.42).

**Tables (DT-16 to DT-20, ID p.41-43 / EN p.43-45):** horizontal rules only, in three weights;
no vertical rules, no coloured head (workbook sheet heads excepted); a Unit column when units
differ by row, or the unit once in the head as "(m)"; numerals Mono, right-aligned; no zebra in
`.docx`; caption label in bold capitals with its number (`TABEL 4.1`, `GAMBAR 9.4`), then the
sentence with no middle dot; SOURCE line below, ending in PROVENANS; every table called in the
prose. Spec tables: parameter, test condition, value, unit; no footnotes (DT-19). Emphasis: the
ruled side note, ink900 0.35 mm above, ink200 0.20 mm below, no fill; never a filled box with a
left bar (DT-20, check 2).

---

## 11 · Numbers, units, dates (Chapter 6)

Full text: `references/02` §7 and the manual, ID p.35-37 / EN p.36-38.

- **Value and unit** separated by one non-breaking space, `%` and `°C` included: `18 %`,
  `30,2 °C`; only plane angles close up: `30° 22′ 8″` (DT-30a, check 16, ID p.35 / EN p.36).
- **Each dimension carries its unit** (`51 mm × 51 mm × 25 mm`); ranges with "sampai":
  `8 m sampai 12 m` (DT-30b, BAKU, ID p.35 / EN p.37).
- **Tolerance in brackets:** `(63,2 ± 0,1) m` (DT-30c, ID p.36 / EN p.37). **Every ± states its
  meaning within 160 characters of the sign**, or in a notation line in the table SOURCE (DT-30d,
  check 17, ID p.36 / EN p.37). The four meanings: design tolerance, 1 σ, expanded uncertainty
  with k, 95 % CI (Table 6.1).
- **Uncertainty** to at most two significant figures, and the value rounded to the same decimal
  place (DT-30e, ID p.36 / EN p.37).
- **ID numerals:** `1.250.000,5`; `Rp 24.475.786.658` with a space after Rp (DT-30f, ID p.36 /
  EN p.36). Money in tables, the RAB and binding sums in full; prose may write `Rp 3,36 miliar`,
  one form per file (DT-30g, ID p.36 / EN p.38).
- **Terbilang** under every binding money sum, generated from the same figure (DT-31b, ID p.37 /
  EN p.38).
- **Dates by place (DT-30h, Table 6.2, ID p.37 / EN p.38):** prose, letters, captions
  `2 November 2026`; technical tables, logs, machine file names `2026-11-02`; times in tables
  and logs `2026-10-27 09.15 WIB`; page furniture and register `02-XI-2026`. A time sent to
  another office carries its zone (WIB UTC+7, WITA UTC+8, WIT UTC+9).
- **Coordinates** in decimal degrees to six places with the datum, `−6,244312 · 106,843017
  (WGS 84)` (DT-30i, BAKU, ID p.37 / EN p.38).
- **English text** uses English conventions: `1,250,000.5`, `IDR 12.5 billion` in prose, `25 %`,
  `14 October 2026`, `17:00 WIB (UTC+7)`; never mix Rp and IDR forms in one section (ID p.37).

---

## 12 · Reproduction survival

- **No rule below 0.18 mm; Word never below w:sz 5 (0.22 mm)** (DT-11a, lint 21, ID p.53 /
  EN p.56; Table A.3, ID p.90 / EN p.92).
- **Tints exactly 15 % or 30 %**; a 0.20 mm row divider instead of zebra; diagram fills hatched at
  45° and 135°; every colour difference also carried by label or pattern (DT-11b, DT-34, ID p.53,
  p.57 / EN p.56, p.61).
- **Photocopy test (DT-11c, ID p.53 / EN p.56):** on every SERAH document, by a checker who is not
  the writer: print at 100 %, photocopy twice, read at 40 cm; anything lost fails.
- **Drawings (DT-11d, ID p.68 / EN p.70):** lines at least 0.18 mm, type at least 5.5 pt. A reduced
  page or slide sample is exempt only when a numbered marker of at least 5.5 pt points to each
  element discussed and the text explains it.

---

## 13 · Charts and technical drawings

Chart rules CH-01 to CH-15 (Table 9.2, ID p.55-56 / EN p.58-59) and the chart roles of Table 9.4
(ID p.57 / EN p.60): one signal accent on one subject; direct labels, no legend box; no title
in the plot, the caption above is the conclusion; no 3D, dual Y axis, shadow, gradient, frame
or boxed label; bars and areas start at zero; a value against a technical limit is a threshold
with a drawn, labelled ink900 line; no KPI tiles or gauges in documents; the chart is the home
of its numbers. Grammar: `references/03`.

Drawings (Chapter 10, ID p.62-70 / EN p.65-72): every box is a real component and every line a
real connection (DT-01b); built from a spec with the keys of Table 10.1; `labels_verified` true
only after every capacity, count and title has a source (DT-39); width 128 or 166 mm,
`"apparatus": "page"` for documents (DT-36); one notation per drawing, rounded corners only on
ISO 5807 terminators, zones as labelled dashed outlines without fill (DT-44); every connector
labelled with what flows (DT-37); Mermaid and Excalidraw for drafts only, Figma export never
(DT-35). Grammar: `references/08-skema-diagram.md`; symbols and editions:
`references/09-simbol-standar.md`.

---

## 14 · Workbooks and briefings

- **Workbook (Chapter 11.1 to 11.4, ID p.71-73 / EN p.73-75):** sheets COVER, PETUNJUK, KENDALI,
  RINGKASAN-EKSEKUTIF, REKAPITULASI, RAB, AHS, HITUNG-*; cell colour states the cell type; fill
  only header rows; merge and hide nothing; four number formats; KENDALI verdicts and a master
  flag in the frozen pane; seal classification and title-bar rule. `references/04-workbook.md`.
- **Command brief and spoken briefing (Chapter 11.5 to 11.7, ID p.73-75 / EN p.75-77):** 16:9,
  338.7 × 190.5 mm, margin 18 mm, white ground; claim headlines; ≤ 55 words, ≤ 5 bullets, ≤ 6
  number rows, one accent, no animation, gradients, stock photos, gauges; a SOURCE line on every
  slide with a number; close with the decision. `references/05-command-brief.md`.

---

## 15 · Release gate

Full text: `references/06-lint.md`.

- **Gate by tier (DT-42a, ID p.79 / EN p.81).** A failing step is fixed at the source and rebuilt.
- **Call-site guard (DT-42b, ID p.79 / EN p.81).** G1 cell count, G2 width other than 128 or
  166 mm, G3 cell too long, N1 underscore in a name: zero before the file lint, for TERBIT and
  SERAH. The guard still flags headings that open with "Bagaimana": open headings with their
  object (PK).
- **38 checks, four stages** (Table 13.1, ID p.80 / EN p.81-82): call site, build, file, eye.
  **The file lint runs 27 of the 38, so its report reads 27/27, never 38/38** (ID p.79 / EN p.81).
- **Colophon (DT-42c, ID p.82 / EN p.85).** No production traces in reader-facing text: no
  builder, lint, skill, machine status, file path, markup or edition history. State the
  document's status in one honest colophon sentence ("Dokumen ini lulus pemeriksaan bentuk dan
  dinilai dua juri."). Instruments and inspection tools (forensic software, meters) are named
  with their versions.
- **Output verification (Swarm, decision U24).** Every `studio_render` answer carries a
  verification report (`verification` in its structured content). Each output is
  **verified** or **unverified**. An output is verified only when every check that applies to
  it passed: Rev A lint, overlap and clipping per page, content fidelity (text, numbers and
  tables against what you submitted), page count, figure fit and empty required slots. A
  check that could not be measured reads UNKNOWN and leaves the output unverified; UNKNOWN is
  never a pass. Work every deliverable through this loop, every time:
  1. **Render.** Call `studio_render` with the formats the reader needs, and add `pdf` for a
     client document. Studio adds the HTML it measures; keep it.
  2. **Read the report.** Read every FAIL and UNKNOWN line: check, page, address, detail. The
     text lists them per unverified output in a fenced block, one line per check: `check`,
     `verdict`, `page`, `address`, `measured`, `expected`, `rule`, `message`. A LINT line names
     the lint rule and what it inspects; `studio_document_status` shows the same lint findings.
  3. **Look at the pages.** Open every page image the report lists under `pages[].png`. When
     it lists none, open the PDF or HTML output and look at every page. Look for what the
     checks cannot see: wrong emphasis, awkward breaks, a figure that says the wrong thing.
  4. **Fix at the source.** Change the content, the figure spec or the template parameter
     that caused the finding (`studio_edit`, `studio_chapter_submit`, `studio_slot_fill`,
     `studio_figure_revise`). Never edit an output file by hand.
  5. **Render again** and go back to step 2 until every output is verified.
- **Never report unverified output as done.** Do not call a deliverable done, final or ready
  while any of its outputs is unverified. Report it as blocked or needs-review, quote the
  failing checks and say what you tried. Stop after five render rounds on one deliverable
  without reaching verified, and report what still fails instead of looping. An UNKNOWN that
  stays UNKNOWN after one more render (for example when the Swarm app is not running) is
  reported the same way.
- **Missions.** Give a deliverable document the docKey `row-<row>-<name>` of the row that
  makes it. Studio refuses to set that row to done (`OUTPUT_UNVERIFIED`) until every output of
  the deliverable's current revision is verified, including a verified PDF or HTML.
- **Two different "verified".** `studio_write` and `studio_file_verify` report a file as
  verified ("terverifikasi") when its sha256 matches. That is a file check, not this
  verification: after `studio_write`, call `studio_render` for the report.

---

## 16 · What this skill does not restate

Grammar (Chapter 4, TB-nn), Expert Style (Chapter 5, SG-Ln-nn, the four-dimension judge and the
LEPAS gate), code quotations (Chapter 7.9, KD-nn), chat (Chapter 12, BP-nn), and the worked
examples (Chapter 14) are binding parts of Rev A that this file does not copy. Read them in
`references/rev-a/manual_id.txt` (or `manual_en.txt`) by page. Rule index: Annex B (ID p.91-96 /
EN p.93-97).

---

## 17 · References: load only what the task needs

| Task | Load |
|---|---|
| Classification, document number, a regulation, a letter, PPN | `references/01-kepatuhan-klasifikasi.md` |
| Page, sizes, cover, page furniture, numbers and units | `references/02-grid-tipografi.md` |
| Table, chart, derivation, SOURCE line, provenance | `references/03-tabel-gambar-apparatus.md` |
| Any `.xlsx` | `references/04-workbook.md` |
| Any `.pptx` or spoken briefing | `references/05-command-brief.md` |
| Finishing anything (mandatory) | `references/06-lint.md` |
| Which tool makes which file in Swarm; Studio tools | `references/07-ekosistem-routing.md` |
| Any schematic, architecture, topology, flow, swimlane, sequence, single-line or rack drawing | `references/08-skema-diagram.md` |
| Electrical, instrumentation, security or military symbols; line types; IEC 81346 | `references/09-simbol-standar.md` |
| Anything else, or a doubt about the wording | `references/rev-a/manual_id.txt`, `manual_en.txt` |

---

## Perubahan dari v1.7

Rules of the v1.7 SKILL.md that Rev A changed or removed, with the Rev A source. v1.7 rules not
listed here and marked [v1.7, Rev A silent] above are kept as they were.

| # | v1.7 (SKILL.md section) | Rev A | Source |
|---|---|---|---|
| S1 | Identity "DATUM v1.7, GSP-DS-001, Revision I" | Standard is Manual Rev A, XXX/GSP/STD/XI/2026, basis v1.9 Rev O; type code DS retired | ID p.1, p.6, p.15 / EN p.1, p.6, p.15 |
| S2 | LOKUS, ARSIP and KRONIK boxes (SendUserFile, device_commit_files, Catatan Sesi via arsip) | Replaced by the Swarm note §0; the duties (number before build, land in the project folder, change log) stay as PK-08, PK-09, DT-04a | ID p.12 / EN p.12 |
| S3 | Revision notes Rev C to Rev I, Figma loop narrative (Rev H) | Removed: history of v1.7, not rules. Figma export is not used (DT-35) | ID p.70 / EN p.72 |
| S4 | §2 build paths: python-docx, datum_diagram.py, datumchart.py, Chromium HTML, Figma audit | Swarm routing D-C: DOCX/HTML/SVG/PDF through Studio, XLSX/PPTX through the Rev A builders | Decision C19 D-C (interpretation, not manual text) |
| S5 | §2 "open assets/DATUM Lembar Bukti.pdf before writing" | Removed as the reference of record: it shows v1.7 form. The manual pages are the specimen | ID p.1-2 (specimen cover and control sheet) |
| S6 | §2a tier table only | Gate steps per tier added (NOTA 1 and 10, TERBIT 1 to 5, 7, 10, SERAH all); Dense Mode PK-07 added | ID p.80, p.11 / EN p.83, p.11 |
| S7 | §4 "five values maximum on any page" | Fixed palette not counted on a page; ≤ 2 meaning colours per page; ≤ 5 hex per figure or chart | DT-06, ID p.48 / EN p.50 |
| S8 | §4 "WARNA DASAR = PUTIH (Rev J)" | Same rule now DT-05 (written task only); the "Rev J" label is dropped | ID p.48 / EN p.50 |
| S9 | §4 command-brief palette with `class #D9756A` in the token list | Dark brief tokens per Annex A (no class token there); head classification #D9756A moves to DT-41a | ID p.89, p.74 / EN p.91, p.76 |
| S10a | §7 logo `gsp-tinta.png` on every cover | ID edition: logo in seal → `gsp-seal.png` (C46); EN edition: black `gsp-tinta.png` | DT-13c, ID p.48 / Table 8.1, EN p.51 |
| S10 | §5 font table without glyph face | DejaVu Sans embedded for provenance glyphs, Greek, √ ≤ → | ID p.49 / EN p.51 |
| S11 | §6 measure 66 to 80 as a blocking lint | DT-10b is BAKU (DEFAULT): a departure needs a one-sentence reason | ID p.52 / EN p.54 |
| S12 | §7 Datum Rule ticks unstated weight; Spine String on cover and dividers | Ticks ≥ 0.18 mm; Spine String also on the back cover (PK) | DT-13f, ID p.53 / EN p.55 |
| S13 | §7 Register Block classification and Seal Band without seal colour rules | Running head, register and Seal Band per Table 8.1 (seal); PDF colour sample DT-13d; total from NUMPAGES | ID p.49, p.53 / EN p.51, p.56 |
| S14 | §7 Issue Stamp `// 20260801 ID R — Terbitan 2` | `// 20261102 ID T — TERBITAN 1` (capitals; letter = classification B, T, R, SR) | ID p.37, p.90 / EN p.56 |
| S15 | §8 "every load-bearing number carries a mark" (every mention) | One mark at the number's home; glyph with label in tables, derivations, SOURCE, rail; check 11 is a screen (≤ 50 % unmarked quantity paragraphs) | DT-21, ID p.38 / EN p.39 |
| S16 | §8 derivation ID `Turunan D-03` | `Turunan <bab>.<urut><huruf>`; intermediate lines one more decimal | DT-24, ID p.40 / EN p.42 |
| S17 | §8 binding: every number audited | Plain integers and English-format numbers are not audited; matched by eye at gate step 7 | DT-23, ID p.40 / EN p.41 |
| S18 | §9 PPN "11 % effective" and PPN 12 % treated as wrong | PPN 12 % × DPP nilai lain 11/12, only in the recapitulation, rounded down; "11 % efektif" allowed in prose | DT-31a, ID p.17 / EN p.18 |
| S19 | §9 regulation list Perpres 12/2021 → 46/2025 | Cite "Perpres No. 16 Tahun 2018 sebagaimana telah diubah terakhir dengan Perpres No. 46 Tahun 2025" | Table 3.2, ID p.15 / EN p.15 |
| S20 | §9 classification without placement and colour | DT-28b floor, DT-28c placement, DT-28d seal bold, DT-28e urgency line added | ID p.13-14 / EN p.13-15 |
| S21 | §10 ranges unstated; Rp form only | Ranges with "sampai"; dates by place (Table 6.2); coordinates decimal degrees; ± meaning within 160 characters | DT-30b, DT-30h, DT-30i, DT-30d, ID p.35-37 / EN p.36-38 |
| S22 | §11 "minimum rule 0.18 mm (0.51 pt)" only | Word floor w:sz 5 (0.22 mm); tints exactly 15 % or 30 %; reduced-sample exemption for drawings | DT-11a, DT-11b, DT-11d, ID p.53, p.68 / EN p.56, p.70 |
| S23 | §12 "draft in Excalidraw, review in Figma, ship the SVG" | Mermaid and Excalidraw for drafts; Figma export not used | DT-35, ID p.70 / EN p.72 |
| S24 | §13 "datum_lint.py runs 38 automated checks; any failure blocks release" | File lint covers 27 of 38, reported 27/27; checks run in four stages; check 15 is DEFAULT | ID p.79-80 / EN p.81-82 |
| S25 | §13 headline six: "no question-form headings" | Check 4 fails only a heading that ends with "?"; question-word openings go to the call-site guard | Table 13.1, ID p.80, p.79 / EN p.81 |
| S26 | §13 headline six: "≤ 3 em-dashes per 1 000 words" | ID: both — and – count, ≤ 3 per 1 000 words, 0 in headings; fixed boilerplate not counted | TB-09, ID p.19 / EN p.32 |
| S27 | §14 carve-out: existing Python modules only | DT-12 does not apply to program-syntax names: Python modules, variables, placeholders, JSON keys | ID p.11 / EN p.11 |
| S28 | §14 file name without revision | File name carries the revision (`... 008-GSP-RAB-VIII-2026 RevA.xlsx`); NOTA files are title + ISO date | Figure 2.2, Table 2.3, ID p.11, p.71 / EN p.11, p.73 |
| S29 | §15 position in the arsenal (Claude sibling skills, LOKUS and KRONIK) | Replaced by §0 and `references/07` (Swarm routing note) | Decision C34 |
| S30 | No colophon rule | DT-42c: no production traces in reader-facing text | ID p.82 / EN p.85 |

---
*Rev A rewrite for Swarm 1.2.0, row 117, 7 November 2026. Source: Manual Rev A text in
`references/rev-a/`. Claude's own DATUM folder is unchanged.*
