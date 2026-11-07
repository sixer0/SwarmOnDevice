# 05 · Command Brief (.pptx) dan Paparan Lisan

Standard: GSP Writing Manual Rev A, Chapter 11.5 to 11.7 (ID p.73-75 / EN p.75-77) and the
cross-chapter rules that name decks (DT-13c, DT-28c, DT-28d, DT-41a to DT-41c, Table 8.1, Annex
A, Table 9.6). Citations are **(ID p.N / EN p.N)**; "[v1.7, Rev A silent]" marks a v1.7 rule the
manual does not state and that is kept. Rule ids BR-nn are the Swarm 1.2.0 numbering (row 75).

**Build with `scripts/datum_pptx.py`** (BR-01, 11.5, ID p.73 / EN p.75), the Rev A briefing builder
in this copy, run only with the bundled Python. A slide figure is the PNG Studio renders for the
same figure [Interpretation C28]. The ARSIP type code of a deck is **DEK**:
`nnn/GSP/DEK/<Roman month>/<year>` (BR-32, Table 3.1, DT-04b, ID p.15 / EN p.15).

---

## 1 · Master and geometry (11.5, Table 11.3, ID p.73-74 / EN p.75)

**16:9, 338.7 mm × 190.5 mm. Margin 18 mm** (BR-02, BR-03).

| Zone (Table 11.3, ID p.74 / EN none) | Position |
|---|---|
| Head | y 11 mm |
| Kicker | 8 pt at y 23 mm |
| Headline | 26 pt at y 31 mm |
| Body / figure | from y 42 mm |
| SOURCE line | slide height − 24 mm |
| Foot | slide height − 12 mm |

(BR-04.) The EN edition gives size and margin only (EN p.75); the zones are applied to both
editions because the master is one builder [Interpretation, row 75 D2]. Head hairline at y 17.5 mm
and foot hairline at height − 14 mm; headline line spacing 31 pt [v1.7, Rev A silent].

**Ground (BR-05, DT-05, ID p.74, p.48 / EN p.50).** White by default: #FCFCFB (or #FBFAF7).

**Dark master, written request only (BR-06, ID p.74 / EN p.50).** Built only on a written request,
by the builder setting `DATUM_BRIEF=gelap`. Never because the subject is "defence", "premium" or
"serious"; an unrequested dark BNPT deck is wrong (ID p.49).

---

## 2 · Palette and identity

**Light master (default).** Ground #FCFCFB · hairline ink200 #C3CBD1 · prose ink700 #2B3640 · head
ink900 #101418 · accent signal #B45309 · meta ink400 #6B7783 (Annex A, ID p.89 / EN p.91).

- **Classification on the light master: seal #6E1420, bold, never alert #9B1C1C** (BR-07, ID p.74;
  DT-28d, ID p.14 / EN p.15). It also sits at the right of the running head (BR-08, DT-28c,
  ID p.14 / EN p.14).
- **Title-bar rule in seal** (BR-09, Table 8.1 "Workbook and deck", ID p.49 / EN p.51).
  [Interpretation C21 D3: the "garis bilah judul" of a deck is the slide head rule.]
- **Slide kicker in signal**; GSP identity and classification in maroon (BR-12, DT-13c, ID p.48 /
  EN p.50). Amber appears only on the kicker, one subject, or the ◈ glyph.
- Panels: #FFFFFF, or ink100 #EFF2F4 on screen [v1.7]. [Interpretation C21 D7: Annex A's "ink100
  not for print fill" applies to printed output; ink100 panels are allowed on a screen deck.]

**Dark master tokens, written request only (BR-11, Annex A, ID p.89 / EN p.91):** ground #0E1216 ·
head #F2F4F5 · prose #AEB8C0 · accent #D98324 · meta #7C8894 · hairline #232B33. **Dark master
(BR-10, DT-41a, PK, ID p.74 / EN p.76):** the title-slide band is #6E1420 and the head
classification #D9756A, because maroon on #0E1216 reaches only 1.6 : 1 while #D9756A reaches
6.0 : 1. Panel #161C22 [v1.7, Rev A silent].

**Logo (BR-13, ID p.74 / EN p.51).** Only on the title slide. Light deck: ID edition logo in seal,
`assets/logo/gsp-seal.png` (DT-13c, ID p.48; C46); EN edition black ink, once,
`assets/logo/gsp-tinta.png` (EN p.51); with the light Datum Rule `assets/rules/datum-166.png`. [Interpretation
C21 D4: Rev A is silent on the dark deck; it keeps the white logo `assets/logo/gsp-putih.png`
and the dark Datum Rule `assets/rules/datum-gelap.png` as in v1.7.]

**Type (BR-15, DT-08a, ID p.50 / EN p.52).** IBM Plex only: Cond for headlines and labels, Serif for
prose, Mono for every figure and foot element [roles v1.7]. **Ship the font folder with the deck**
(BR-14, DT-09, ID p.50 / EN p.52); PowerPoint cannot embed fonts across platforms.

---

## 3 · Headline and one message per slide (11.6, DT-41b, DT-41c, ID p.74 / EN p.76)

**Every headline is a claim sentence** with a predicate, never a topic label (BR-16).

| Right | Wrong |
|---|---|
| *Penyimpanan 410 TB cukup untuk rekaman 30 hari dari 400 kamera* (ID p.75) | *Kebutuhan Penyimpanan* |
| *Storage of 410 TB holds 30 days of video from 400 cameras.* (EN p.76) | *Storage Requirements* |
| *Perimeter 6.546,2 m menuntut 70 titik. Kuantitas berikutnya mengikuti.* [v1.7] | *Baseline Kuantitas* |

EN only (EG-60, EN p.76): a headline ≤ 90 characters (two lines at 26 pt, PK), sentence case,
ending with a full stop (BR-28).

**Limits per slide (DT-41c test, ID p.74 / EN p.76):**

| Limit | Value | BR |
|---|---|---|
| Body prose | ≤ 55 words | BR-19 |
| Bullets | ≤ 5 | BR-20 |
| Number block rows | ≤ 6 | BR-21 |
| Accent | one per slide [Interpretation row 75 D6: one accent colour] | BR-22 |
| Animation | zero [Interpretation row 75 D5: slide transitions count as animation] | BR-23 |
| Gradients | zero | BR-24 |
| Stock photos | zero | BR-25 |
| Gauges; KPI tiles (ID; EN CH-13, EN p.59) | zero | BR-26 |
| SOURCE line | on every slide that carries a number: `SUMBER` (EN `SOURCE`) | BR-27 |

**Close with the decision (BR-17, BR-18, DT-41b).** The last slide states the decision requested
with its numbers: ID "keputusan dan empat angka dasarnya" (ID p.74); EN "the three deciding
numbers of the executive summary (GA-02)" (EN p.76). [Interpretation C21 D1: the deck follows the
edition of its language, 4 numbers for an ID deck, 3 for an EN deck; reported as a manual
inconsistency.] **Never close with "Terima kasih" / "Thank you."**

**Charts on slides (BR-29, Table 9.6, ID p.61 / EN p.64):** sorted bar, line, bullet, tile map;
avoid box plot, horizon, network. A chart spec placed in a `.pptx` uses `width_mm` "page"
(BR-30, ID p.63 / EN p.66). A reduced slide sample is exempt from the 5.5 pt floor only when a
numbered marker ≥ 5.5 pt points to each element discussed and the text explains it (BR-31,
DT-11d, ID p.68 / EN p.70).

---

## 4 · Slide patterns and furniture [v1.7, Rev A silent unless cited]

**Claim + number block.** Headline left over about 178 mm, a short paragraph beneath, a right-hand
number block opened by an accent rule; values in Mono right-aligned, labels in Cond meta
left-aligned; six rows maximum (BR-21).

**Chart.** Bars in #39454F, the one series that matters in accent, values above the bar unboxed in
Mono; no axis box, gridlines or legend (CH-04, CH-06).

**Spec table.** Parameter, test condition, value (and unit, DT-19), hairlines between rows only;
values carry their provenance mark.

**Assumption slide.** Each item opened by a 0.5 mm accent left rule: ID in Mono accent, assumption,
then "Dampak bila salah" and "Cara verifikasi".

**Head:** entity and division left; programme and classification (seal, bold) right (BR-07, BR-08).
**Foot:** document number (DEK) and revision left, `SLIDE nn / NN` right (Figure 11.3 names the
slide number among its markers, ID p.73).
**SOURCE line** on every slide with a number (BR-27); its two-line form with `PROVENANS` is shown
in the manual's worked example (ID p.86):

```
SUMBER  Register koordinat 70 titik Rev B · Peta 001 sampai 014 · survei lapangan 16 sampai
        21 Agustus 2021. PROVENANS seluruh angka ■ TERUKUR [A1].
```

**Title slide.** Seal band at the very top with classification and copy control, the logo (only
here), the Datum Rule, kicker, title, standfirst, and a foot carrying the Issue Stamp.

**Forbidden, not stated in Rev A [v1.7]:** icon sets, drop shadows, rounded corners, the logo on
every slide (Rev A: logo only on the title slide, BR-13).

---

## 5 · Speaker notes and the spoken briefing (11.7, ID p.75 / EN p.76-77)

The two editions give different texts for 11.7; each deck follows its own edition.

- **Notes carry the evidence (BR-33, ID p.75 / EN p.77).** Every number on a slide has its
  derivation (or its number) and provenance mark in the notes; the spoken script carries no
  marks. A briefer asked where 7,40 kVA comes from reads the derivation off the notes [example
  v1.7].
- **Round when speaking (BR-34).** ID: two significant figures, "sekitar 6,5 km" for 6.546,2 m. EN:
  two or three significant figures, units said in full ("twelve point five billion rupiah", never
  "I-D-R"); dates and counts stay exact.
- **Do not read the slide (BR-35, Table 11.4 SG-L1-04 / EG-62).** Speak the impact of the number.
- **Open with the decision or finding (BR-36, SG-L0-05 / EG-61).** ID: background never precedes
  the request: "Bapak Direktur, kami mohon persetujuan mengunci 70 titik kamera." EN: state the
  marking once, then the decision and recommendation.
- **Address and unknowns (BR-37, SG-L5-08, SG-L5-05 / EG-63, EG-64).** ID: address Bapak or Ibu by
  office, GSP is "kami", never "kamu" or "kita"; if unknown, say so and give method and deadline,
  never a guessed number. EN: rank or office, no idioms, expand every acronym, pause after each
  number; answer an unknown with "I don't know" and a dated promise.
- **Close with the request (BR-38, SG-L0-03 / EG-64).** The last sentence asks for the decision. ID:
  a 10-minute paparan follows Figure 11.4. EN: plan each minute as about 130 spoken words and one
  slide (PK).
- EN only: expand every abbreviation at first use, once per deck (EG-22, EN p.24); a deck for a
  foreign delegation is TERBIT unless it is a contract deliverable or tender submission (PK-14,
  EN p.10).

Worked example: ID 14.4 "Chart dan caption untuk paparan Kemhan" (ID p.86-87) turns a topic title,
3D rainbow pie, legend box and red TERBATAS into a claim headline, a sorted bar with one signal
bar, unboxed Mono values and a SUMBER line with PROVENANS.

---

## Perubahan dari v1.7

| # | v1.7 rule (section) | Rev A | Source | Class |
|---|---|---|---|---|
| 05-1 | Preamble: `gsp-presentation-maestro` owns the argument | Not in Swarm; DATUM rules for headline, closing and notes are in the manual itself | ID p.74-75 / EN p.76-77 | REMOVED (ownership line) |
| 05-2 | §1 headline "max ~26 pt" | 26 pt at y 31 mm; EN ≤ 90 characters, sentence case, full stop | Table 11.3, ID p.74; EG-60, EN p.76 | CHANGED |
| 05-3 | §1 kicker "section number and name, accent, 8 pt Cond 600" | 8 pt at y 23 mm in signal; content and face not stated | ID p.74, p.48 / EN p.50 | KEPT (colour, size) |
| 05-4 | §2 light palette `class #9B1C1C` (alert) | Classification seal #6E1420 bold, never alert | BR-07, DT-28d, ID p.74, p.14 / EN p.15 | CHANGED |
| 05-5 | §2 head hairline ink200 #C3CBD1 | Title-bar rule in seal [Interpretation C21 D3] | Table 8.1, ID p.49 / EN p.51 | CHANGED |
| 05-6 | §2 ground #FCFCFB only | #FCFCFB or #FBFAF7 | DT-05, ID p.48 / EN p.50 | CHANGED (widened) |
| 05-7 | §2 dark opt-in "when the task asks" | Written request and builder setting `DATUM_BRIEF=gelap` | ID p.74 / EN p.50 | CHANGED |
| 05-8 | §2 dark tokens with `class #D9756A` and panel #161C22 | Annex A tokens; title band #6E1420 and head class #D9756A as DT-41a; panel not stated | ID p.89, p.74 / EN p.91, p.76 | CHANGED |
| 05-9 | §3 "body prose never exceeds ~55 words" (soft) | ≤ 55 words as a FILE test | DT-41c, ID p.74 / EN p.76 | CHANGED (hard limit) |
| 05-10 | §4 the ask "four numbers" | ID four numbers, EN three [Interpretation C21 D1] | DT-41b, ID p.74 / EN p.76 | CHANGED (EN) |
| 05-11 | §5 header "classification in class" | Seal bold at the right of the head | DT-28c, DT-28d | CHANGED |
| 05-12 | §5 footer layout | DEK type code; slide number marker in Figure 11.3 | Table 3.1, ID p.15, p.73 / EN p.15 | CHANGED (code added) |
| 05-13 | §6 forbidden list | Rev A test list: ≤ 55 words, ≤ 5 bullets, ≤ 6 number rows, one accent, zero animation, stock photos, gradients, gauges (ID also KPI tiles); "Terima kasih" banned; icon sets, shadows, rounded corners not stated (kept as v1.7) | DT-41b, DT-41c, ID p.74 / EN p.76 | CHANGED |
| 05-14 | §7 speaker notes | Same duty plus spoken-briefing rules (rounding, no slide reading, decision first, address, unknowns, close) | 11.7, ID p.75 / EN p.76-77 | CHANGED (added) |
| 05-15 | (none) | Charts for briefings (Table 9.6); chart spec width "page"; reduced-sample exemption; EN EG-22 and PK-14 | ID p.61, p.63, p.68 / EN p.64, p.66, p.70, p.24, p.10 | ADDED |

Kept as v1.7 [Rev A silent]: hairline positions and headline line spacing, panel colours, dark
panel #161C22, white logo and dark Datum Rule on a dark deck (C21 D4), slide patterns, chart bar
colour #39454F, head and foot layout, title-slide composition, icon sets, shadows and rounded
corners forbidden.
