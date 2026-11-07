# 09 · Simbol Baku, Edisi Standar & Tata Gambar Teknik

Standard: GSP Writing Manual Rev A, Chapter 10.4 to 10.9 (ID p.65-69 / EN p.68-71) and Annex A.
Citations are **(ID p.N / EN p.N)**; "[v1.7, Rev A silent]" marks a v1.7 rule the manual does not
state and that is kept.

Load this whenever a drawing carries electrical, instrumentation, security or military marks,
that is, whenever the drawing is an engineering document rather than a picture of one.

**Producer in Swarm.** Drawings come from the datum-studio figure tools [D-C]. The v1.7 symbol
engine `scripts/datum_symbols.py` (`--list`, `--sheet`, `--check <id>`) stays in the copy as a
catalogue reference [v1.7]. The installed library holds **41 symbols in 4 dialects** (IEC, ISA,
MIL, GSP house legend), not the 87 in 10 that Rev O names; a dialect that is missing is drawn as a
named box with a printed legend (PK; E-36, ID p.67, p.82 / EN p.85). [Interpretation: when Studio
cannot draw a needed standard symbol, use that same workaround and report it.]

---

## 1 · The rule that governs this file (SM-01, ID p.66 / EN p.68)

> **Never invent a standard symbol**: a named box is more honest.

An invented mark that looks official claims conformance to a standard GSP does not hold; a
reviewer who knows IEC 60617 will find it and doubt every other claim on the sheet [v1.7]. The
corollary binds as hard: **where no standard exists, say so.** GSP's security site-plan marks are
a house legend, printed on the same sheet and marked "bukan simbol standar" (SM-03).

---

## 2 · Standards and editions in force (10.4, Table 10.2, ID p.65 / EN p.68)

Cite the edition from this table, never from memory or another file (SM-05). Re-check the table
every year and before naming an edition to a client. Table checked **9 October 2026**.

| Drawing type | Standard and edition |
|---|---|
| Single-line diagram, schematic | IEC 60617:2026 DB · IEC 81346-1:2022 · PUIL 2020 (SNI 0225:2020) |
| P&ID, instrumentation | **ANSI/ISA-5.1-2024** |
| Security plan | GSP house legend, or SIA AG-01 v3.0 when the client uses US practice |
| Operations graphics, COP | MIL-STD-2525E · NATO APP-6D; APP-6E only "reported" |
| Flow, process, architecture | ISO 5807 (1985, confirmed 2019) · BPMN 2.0.2 · UML 2.5.1 · C4 · ArchiMate 4 |
| Lines, racks, labels | ISO 128-2:2022 · EIA-310, 1U = 44,45 mm · ANSI/TIA-606-D |
| Signs and fire | ISO 7010:2019 + Amd 9:2025 · ISO 3864-1:2011 · NFPA 170, not redrawn |
| Annotation | ISO 6433:2012 · ISO 129-1:2018 · ISO 128-3:2020 · ASME Y14.35-2014 (R2019) |

**Stale editions such as ISA-5.1-2022 and ISO 128-2:2020 are not cited** (ID p.65). ANSI/ISA-5.1-2024
is one of the five Annex A rulings that beat the tokens (ID p.89 / EN p.91).

Library prefixes [v1.7]: `iec:*` IEC 60617, `isa:*` ANSI/ISA-5.1, `mil:*` MIL-STD-2525,
`sec:*` GSP house legend (no standard exists).

---

## 3 · Symbol rules SM-01 to SM-12 (Table 10.3, ID p.66 / EN p.68)

11 of the 12 are WAJIB, because a wrong symbol is a wrong compliance claim.

| Code | Level | Rule | Test |
|---|---|---|---|
| SM-01 | WAJIB | Do not invent a standard symbol; a named box is more honest | every symbol is in the library or the standard |
| SM-02 | WAJIB | The standard named by the KAK or contract comes first | drawing notation equals the KAK's |
| SM-03 | WAJIB | House legend printed on the same sheet, marked "bukan simbol standar" | lint 34 passes |
| SM-04 | WAJIB | One symbol dialect per drawing | lint 35 passes |
| SM-05 | WAJIB | Edition equals Table 10.2 | every edition matches |
| SM-06 | BAKU | Vendor icons unaltered; generic icons for brand-neutral proposals | vendor icon only once the brand is fixed |
| SM-07 | WAJIB | IEC 81346 designation identical in drawing, BoQ and acceptance test | every designation has a BoQ line |
| SM-08 | WAJIB | Complete sheet: title block, line and capacity labels, source, revision | missing elements = 0 |
| SM-09 | WAJIB | Camera cone computed from focal length and sensor width | plan angle equals Figure 10.7 formula |
| SM-10 | WAJIB | Military identity by shape; frame ratio unchanged | frame from the library at its true ratio |
| SM-11 | WAJIB | Match symbols against the standard document before issue for construction | a matching note exists |
| SM-12 | WAJIB | Paid symbols are bought, not copied | licence evidence exists |

Right: a UPS as `iec:enclosure` with designation `=G01+P01-U1`. Wrong: a home-made UPS glyph. IEC
has no ATS symbol: draw the changeover contact plus its control function (ID p.66).

---

## 4 · IEC 60617, electrical and power [v1.7, Rev A silent on the detail]

The switching family shares one construction (fixed contact, blade hinged open at 30°, terminals
top and bottom) and differs only by the mark that says which device it is:

| Symbol | Distinguishing mark | Means |
|---|---|---|
| `iec:switch` | none | a switch, general |
| `iec:breaker` | `×` on the fixed contact | it can break fault current |
| `iec:disconnector` | short bar across the fixed contact | isolation, not fault breaking |
| `iec:contactor` | arc on the contact | held closed by a coil |

A disconnector drawn as a breaker claims fault breaking the design does not have: a safety claim,
not a drafting slip. A UPS, rectifier or converter is `iec:enclosure`, identified by its
designation. **Verify against the IEC 60617 database entry before issue for construction**
(SM-11, ID p.66). Single-line diagrams run top to bottom; symbol sheets are cut at 247 mm (E-17,
E-18, ID p.82 / EN p.85).

---

## 5 · ANSI/ISA-5.1-2024, instrumentation [form v1.7; edition per Table 10.2]

The bubble is a two-axis code and both axes carry meaning.

| Shape | Function |
|---|---|
| circle | discrete instrument |
| circle inscribed in a square | shared display or shared control |
| hexagon | computer function |
| diamond inscribed in a square | programmable logic control |

| Line | Location |
|---|---|
| none | field mounted |
| single | primary location, accessible to the operator |
| double | auxiliary location, accessible to the operator |
| dashed | inaccessible, behind a panel |

Dropping the line turns a control-room indicator into a field instrument. Valves carry the body
(`isa:valve`) plus the actuator (diaphragm, motor, solenoid); an unactuated body is a manual valve.

---

## 6 · MIL-STD-2525E, identity frames (SM-10, ID p.66 / EN p.68)

**Identity is carried by frame shape, not colour**, and the frame ratio is never altered.

| Identity | Land frame | Air frame [v1.7] |
|---|---|---|
| Friend | rectangle, distinctly wider than tall | dome, open below |
| Neutral | square | square, open below |
| Hostile | diamond, point up | pointed arch, open below |
| Unknown | quatrefoil | cloverleaf, open below |

Friend and neutral differ only in aspect: a neutral square drawn slightly wide asserts the wrong
affiliation. Echelon is an amplifier above the frame, never a change of frame: `Ø` team or crew ·
`•` squad · `••` section · `•••` platoon · `|` company · `||` battalion · `|||` regiment · `X`
brigade · `XX` division · `XXX` corps · `XXXX` army. Colour fill is redundant encoding only
[v1.7].

---

## 7 · Security site plans: GSP house legend, not a standard

**IEC 62676** is cited for DORI criteria, never as the basis for symbols (10.9, ID p.69 / EN p.71).
No international standard publishes a site-plan symbol set; Table 10.2 allows SIA AG-01 v3.0 when
the client uses US practice (ID p.65).

1. **Every drawing using `sec:` marks prints the legend on the same sheet**, marked "bukan simbol
   standar" (SM-03, lint 34).
2. **The camera cone is computed, not drawn to look right** (SM-09, 10.9, ID p.69 / EN p.71):
   α = 2 × arctan(w ÷ 2f), from the sensor width w and focal length f. Write the lens and the angle
   in the node's `sub` line with ◈ DITURUNKAN. Wrong: a 90° cone "because it looks right" for a
   narrow lens (ID p.70).
3. Seven marks: fixed camera with field-of-view cone, PTZ, PIR detector, fence sensor, access
   reader, vehicle barrier, lighting or camera mast [v1.7].

---

## 8 · ISO 128-2:2022, line types (10.6, Table 10.4, Figure 10.5, ID p.67-68 / EN p.69-70)

Line meaning rides on pattern first and colour second, so it survives a photocopy.

| ISO type | Name | DATUM edge kind | Carries |
|---|---|---|---|
| 01.1 | continuous narrow | `data`; `accent` (wide, signal) | the substance that flows; the one main path |
| 01.2 | continuous wide | busbar, principal outlines [v1.7] | conductors |
| 02.1 | dashed narrow | `control` | commands; hidden detail [v1.7] |
| 04.1 | long-dashed dotted narrow | `verify` | integrity; centre lines and zone boundaries [v1.7] |
| 05.1 | long-dashed double-dotted narrow | future works | scope **outside the contract** |

`sync` (dotted, ink400) and `alert` (long dash, alert) have no ISO 128-2 type (Table 10.4). A
stage-2 camera ring drawn in 05.1 with the note "di luar kontrak" prevents a scope dispute at
handover (ID p.68).

Widths from the ISO R10 series at a 1 : 2 narrow-to-wide ratio [v1.7]; DATUM's weights in Annex
A.4 (0.20, 0.25, 0.30, 0.45, 0.50 mm) with the 0.18 mm floor (DT-11d).

---

## 9 · IEC 81346-1:2022, reference designations (10.8, ID p.69 / EN p.71)

Every physical component carries a designation: `=` function, `+` location, `-` component
(`:` terminal [v1.7]). `=G02+B22-Q1` reads: in system G02, at location B22, component Q1. **The
same designation appears in the drawing, the BoQ and the acceptance-test sheet** (SM-07). Right:
`=G01+P01-Q1` at the node and in the BoQ. Wrong: "MCB utama", "MCB 1" and "Breaker A" for one
component.

A designation that does not resolve to a BoQ line is decoration. Carry both threads: `tag` for the
requirement (DT-27b), `desig` for the physical item. A malformed designation is refused [v1.7].

---

## 10 · Using symbols in a spec [v1.7, key form]

```json
{"id": "cb2", "label": "Pemutus Panel Timur",
 "symbol": "iec:breaker", "desig": "=G02+B22-Q1",
 "sub": "2,71 A segmen", "mark": "DITURUNKAN", "accent": true}
```

The symbol replaces the box; name, designation and rating sit below it. Military nodes may add
`"echelon": "battalion"`. **One dialect per drawing** (SM-04, lint 35): a drawing that needs two
dialects is two drawings. JSON key names are exempt from DT-12 (ID p.11).

---

## 11 · Checks

Lint 34 (`sec:` marks without a published legend) and lint 35 (two dialects in one drawing), both
at the build stage (Table 13.1, ID p.80 / EN p.82). An unknown symbol id and a malformed designation
are refused at build [v1.7].

**Still needs a human** [v1.7; SM-11, SM-07]: is this the right symbol or only a plausible one?
Does the ISA bubble's location line match where the instrument is? On an operational graphic, is
the affiliation right? Does every designation resolve to a real BoQ line?

---

## Perubahan dari v1.7

| # | v1.7 rule (section) | Rev A | Source | Class |
|---|---|---|---|---|
| 09-1 | Preamble: "this file is the arsenal's only symbol library"; gsp-visual-commander Gate 4 keeps the decision | Ownership lines removed (Swarm note); the library facts are E-36 | ID p.67, p.82 / EN p.85 | REMOVED (ownership) |
| 09-2 | §2 currency "verified 2 August 2026" | Table 10.2 checked 9 October 2026 | ID p.65 / EN p.68 | CHANGED |
| 09-3 | §2 `isa:*` ANSI/ISA-5.1 **2022** current | **ANSI/ISA-5.1-2024**; ISA-5.1-2022 is stale and not cited | Table 10.2, Annex A, ID p.65, p.89 / EN p.68, p.91 | CHANGED |
| 09-4 | §2 `iec:*` IEC 60617 DB, parts 2 to 13 | IEC 60617:2026 DB with IEC 81346-1:2022 and PUIL 2020 | ID p.65 / EN p.68 | CHANGED |
| 09-5 | §2 NATO APP-6 D (2017), later edition reported unconfirmed | APP-6D; APP-6E only "reported" | ID p.65 / EN p.68 | KEPT (wording) |
| 09-6 | §2 currency table limited to IEC, ISA, MIL, APP-6, ISO 128-2, IEC 81346 | Adds flow and architecture (ISO 5807, BPMN 2.0.2, UML 2.5.1, C4, ArchiMate 4), racks and labels (EIA-310, ANSI/TIA-606-D), signs (ISO 7010, ISO 3864-1, NFPA 170), annotation (ISO 6433, ISO 129-1, ISO 128-3, ASME Y14.35), SIA AG-01 for US-practice security plans | ID p.65 / EN p.68 | CHANGED (added) |
| 09-7 | (none) | SM-01 to SM-12 with levels and tests | Table 10.3, ID p.66 / EN p.68 | ADDED |
| 09-8 | §6 seven `sec:` marks, no library size | Installed library 41 symbols in 4 dialects; missing dialects as named boxes with printed legend | E-36, ID p.67, p.82 / EN p.85 | CHANGED (added) |
| 09-9 | §6 camera cone "derived from the real focal length" | Formula α = 2 × arctan(w ÷ 2f); lens and angle in `sub` with ◈ DITURUNKAN | SM-09, 10.9, ID p.69 / EN p.71 | CHANGED (formula) |
| 09-10 | §7 line types 01.1, 01.2, 02.1, 04.1 (`centre`), 05.1 (`future`) | Table 10.4 maps `verify` to 04.1 and gives `sync`, `alert` no ISO type; 05.1 marks out-of-contract scope | ID p.67-68 / EN p.69-70 | CHANGED |
| 09-11 | §3 "verify before issue for construction" | Now SM-11 (WAJIB, a matching note) | ID p.66 / EN p.68 | KEPT (coded) |
| 09-12 | §8 IEC 81346 thread | Now SM-07: the same designation in drawing, BoQ and acceptance test | ID p.66, p.69 / EN p.68, p.71 | KEPT (coded) |
| 09-13 | Build path `scripts/datum_symbols.py` | Studio is the drawing route in Swarm [D-C]; the engine stays as a catalogue reference | D-C | CHANGED |
| 09-14 | §2 "re-check annually; knowledge-master researches, veritas certifies" | Re-check every year and before naming an edition to a client; no sibling skills | ID p.65 | CHANGED |

Kept as v1.7 [Rev A silent]: the cost argument against invented symbols, IEC switching family and
enclosure guidance, ISA bubble axes and valve actuators, MIL air frames, echelon amplifiers and
colour-fill note, the seven `sec:` marks, R10 widths, the `:` terminal prefix, spec key form, and
the human-eye questions.
