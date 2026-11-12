# 08 · Skema, Diagram Alur & Gambar Teknik

Standard: GSP Writing Manual Rev A, Chapter 10 (ID p.62-70 / EN p.65-72) with DT-06, DT-11d,
DT-15 and Annex A. Citations are **(ID p.N / EN p.N)**; "[v1.7, Rev A silent]" marks a v1.7 rule
the manual does not state and that is kept.

`references/03` governs **charts** (things with an axis). This file governs **drawings** (nodes
and connectors). They share the caption and SOURCE apparatus (DT-15) and nothing else.

In Swarm, drawings are produced through the datum-studio figure tools (`studio_figure_preview`,
`studio_figure_revise`, `studio_render`; `references/07`). The rules below are what the drawing
must satisfy.

---

## 0 · The spec contract (10.2, Table 10.1, ID p.62-63 / EN p.65-66)

**DATUM draws from a spec: a JSON file that is the only artefact a person edits.** Review
changes are written into the spec, never into the SVG (ID p.62).

**Every key is mandatory, including keys the engine does not draw but the handover gate checks**
(Table 10.1):

| Key | Mandatory content |
|---|---|
| `family` | one of the nine families (§2) |
| `id`, `title` | chapter-prefixed number and a one-line caption without the label token (§7) |
| `classification` | per the recipient's scheme (Chapter 3; `references/01`) |
| `nodes[]` | id, label, class, `sub` quantity, provenance `mark`, requirement `tag` |
| `edges[]` | `from`, `to`, `kind`, `label`: all four mandatory |
| `legend[]` | key rows; mandatory whenever a `sec:` mark is used |
| `sources[]` | at least one document and article |
| `labels_verified` | `true` only after every number has been checked |
| `width_mm`, `apparatus` | 128 or 166; `"page"` for `.docx` and `.pptx` |

`notes[]` (scope carve-outs, conventions, what is deliberately absent) and `lang` (`id` or
`en`, matching the document) [v1.7, Rev A silent]. Classification, notes, sources and
`labels_verified` are envelope fields: carried, not drawn, and checked at the gate; nothing is
dropped because the renderer ignores it, or a RAHASIA figure ends up on an unmarked sheet [v1.7].

**`labels_verified` (DT-39, ID p.63 / EN p.66).** Render review copies with `false`. Set `true`
only after every capacity, count and job title has a source. An issued spec carries
`"labels_verified": true`. A spec still `false` is not rendered into a deliverable: a plausible
capacity typed into a review copy and never re-checked is how a figure ships wrong while looking
finished [reason v1.7].

**Width and apparatus (DT-36, ID p.63 / EN p.66).** Build at 128 or 166 mm, never between. Write
`"apparatus": "page"` in every spec for a document, because the drawing engine's default
`"figure"` prints the caption and SOURCE twice. `"figure"` is for a standalone SVG.

---

## 1 · A drawing asserts facts (10.1, DT-01b, ID p.62 / EN p.65)

**Draw a box only for a real component and a line only for a real connection.** Never add a box
for symmetry: it reads as a component. **A line through an unrelated box asserts a connection
that does not exist.** Wrong: fibre drawn through a guard-post box on its way to the core switch
(ID p.62).

Why GSP diagrams used to look generated (default Mermaid renders: rounded boxes, stock palette,
unlabelled arrows, no grid, a legend box) and why the reference class is the drawing set (IEC
60617 single line, signal-chain figure, interface diagram, as-built rack) [v1.7 commentary,
Rev A silent]: a diagram that asserts one false thing has lost the right to be believed about the
rest, which is why routing is an engineering problem, not a styling choice.

---

## 2 · Build path and families

**Build from the spec (DT-35, ID p.70 / EN p.72).** Mermaid and Excalidraw are allowed for drafts;
translate their nodes and edges into the spec and ship the SVG. **Figma export is not used,
because its text becomes outlines.** Mermaid in a deliverable fails lint 31.

In Swarm the SVG and PNG come from Studio [D-C]. The v1.7 command lines for
`datum_diagram.py` and `datum_render.py` are not the route; the engine's own schema
(`datum_diagram.py --schema`) remains a reference for key names [v1.7].

**Nine families (10.7, Figure 10.6, ID p.68-69 / EN p.70).** Every spec names one. `graph` is the
escape hatch: an unusual drawing still uses the house style. On a catalogue sheet, one accent per
panel and lint 26 counted per panel (ID p.69).

| Family | Draw when [v1.7, Rev A gives the families as a figure] |
|---|---|
| `layered` | components in strata: tiers, zones, OSI-like layers; the default for system architecture |
| `topology` | physical or logical network; label every link with its capacity |
| `stack` | named among the nine in v1.7 SKILL.md §12; neither v1.7 reference 08 nor the Rev A text describes it further |
| `flow` | ordered procedure with decision gates; happy path first |
| `swimlane` | a procedure where who acts is the point; one lane per role, every handover labelled (Figure 10.3, ID p.65) |
| `sequence` | message order over time; time is the vertical axis and nothing else |
| `sld` | power or signal chain on a bus, drawn top to bottom (E-17); the busbar is the only heavy stroke |
| `rack` | rack elevation; the U numbers must be right (1U = 44,45 mm, EIA-310) |
| `graph` | anything else; give every node a `col`/`row` |

---

## 3 · Geometry [v1.7, Rev A silent unless cited]

- Horizontal unit 10,667 mm (the 12-subcolumn pitch); vertical unit 4,7625 mm (the 13,5 pt
  baseline).
- Width 128 mm (text column) or 166 mm (full span), never between (DT-36, DT-10a).
- Height at most 247 mm, the A4 text block (Table 8.3; check 33).
- Node height a whole number of baselines; node width uniform within a tier (Figure 10.1 caption:
  "satu lebar kotak per tier", ID p.62 / EN p.65).
- Reserved space is not wasted space: no decorative icon or stretched box to fill a band.

---

## 4 · Nodes: one notation, shape carries meaning (10.3, DT-44, ID p.63 / EN p.66)

**One notation per drawing**: ISO 5807, BPMN, UML, DFD or IEC 60617. **Rounded corners only on ISO
5807 terminators** (lint 23). **Zone boundaries are labelled dashed outlines without fill.**

| Shape | Means | Notation |
|---|---|---|
| `box` | component, process step, equipment | universal |
| terminator | start or end: **a rectangle with 2 mm corner radius, not a stadium** (E-29, E-30, ID p.82 / EN p.85) | ISO 5807 |
| `diamond` | decision; every exit labelled | ISO 5807 |
| `parallelogram` | input or output | ISO 5807 |
| `hexagon` | preparation, gateway | ISO 5807 / BPMN |
| `doubled` | subsystem with further structure | UML component |
| `shadowed` | external entity outside the boundary | DFD Gane-Sarson |
| `circle` | junction, off-page connector | universal |
| `bus` | busbar or backplane, heavy stroke, no enclosure | IEC 60617 |

**Cylinders are not used** and long flows are split in two (E-30, ID p.82 / EN p.85).

**Never invent a standard symbol** (SM-01, ID p.66); a named box is more honest. Symbols, dialects
and editions: `references/09`.

**Node annotation (Table 10.1):** `tag`, the requirement ID (`REQ-CAP-01`), set top-left in Mono,
carried unchanged across the package (DT-27b); `mark`, the provenance glyph top-right (■ ◈ ◇ △),
because a capacity inside a box is a load-bearing number (DT-21); `sub`, the quantity or spec in
Mono under the name: "Switch Akses A · PoE 370 W" is engineering, "Switch" is a picture
[placement v1.7].

---

## 5 · Connectors (10.3, 10.6, Table 10.4, ID p.63, p.67-68 / EN p.66, p.69-70)

**Every connector is labelled with what flows**: protocol, capacity, document or decision outcome
(DT-37, lint 24 and 26). An edge whose content cannot be named usually means the two nodes
should be one. Right: camera to recorder labelled `H.265 · 4 Mbps`. Wrong: an unlabelled arrow.
**Lines are orthogonal only, anchors fanned, and crossings jump** (ID p.63).

**Meaning rides on pattern first, colour second**, so it survives a photocopy (10.6):

| `kind` | Pattern and ink | ISO 128-2 | Carries |
|---|---|---|---|
| `data` | solid, ink900 | 01.1 | the substance that flows |
| `control` | dashed, ink700 | 02.1 | commands |
| `sync` | dotted, ink400 | none | replication |
| `accent` | solid wide, signal | 01.1 | the one main path |
| `alert` | long dash, alert | none | failure |
| `verify` | dash-dot, verd | 04.1 | integrity |

Open arrowheads for control and sync; mitred corners and butt caps; where a horizontal run crosses
a vertical one, the horizontal hops; a run that would cross an unrelated box detours around it
[v1.7 engine conventions, consistent with ID p.63].

---

## 6 · Zones, legends, accent, colour

- **Zones**: a labelled dashed outline, no fill (DT-44). Prefer proximity and alignment over a
  grouping box when the grouping is already obvious [v1.7].
- **One accent per drawing**: signal on the single element the reader must not miss (CH-03,
  lint 26). An accent edge on the accented node is part of the same story [v1.7].
- **Legend**: a key row, never a boxed legend (CH-04, ID p.55 / EN p.58); mandatory with any `sec:`
  mark, printed on the same sheet and marked "bukan simbol standar" (SM-03, lint 34).
- **Colour (DT-06, ID p.48, p.68 / EN p.50, p.70):** at most **5 hex values besides the white
  ground** in one drawing, and any page carrying it at most 2 meaning colours (signal plus alert
  or verd, never alert with verd). No blue (ID p.57). [Interpretation C23: inside a figure every
  hex counts, the inks included; the page exemption for the fixed palette does not apply inside
  a figure, and no "ink ramp = one family" rule exists in either edition.]
- Every colour difference is also carried by label, position or pattern (DT-34, ID p.57 / EN p.61).

---

## 7 · Apparatus: the same as every figure (DT-15, ID p.41 / EN p.43)

- **Caption above**: Studio prints the label; the caption never starts with it; at most 100
  characters. Studio numbers the figure (chapter-prefixed, Table 10.1 `id`) and prints the bold
  capital label itself, so the caption text carries no `Gambar`, `GAMBAR` or `Figure` token with
  a number. It is one line: a verdict that names the actor and the number (`Kontraktor menanggung
  62 % biaya kabel`), no middle dot. A caption that opens with the token is refused at submit
  (`CAPTION_TOKEN_DUPLICATE`); one that wraps to a second line fails the gate (`CAPTION_WRAP`).
- **SOURCE line below**, opening `SUMBER`, naming the document and article the drawing was built
  from (`sources[]`), plus `PROVENANS` for any load-bearing quantity in it.
- A topology taken from a vendor carries the Admiralty digraph on that claim (DT-25).
- With `"apparatus": "page"` the page prints caption, legend and SOURCE once; the figure keeps a
  marker so the obligation is visible (check 36 is a reminder, not a failure) [mechanism v1.7].
- Maps are their own series (`Peta 1.1`) [v1.7, Rev A silent].

---

## 8 · Reproduction survival (DT-11d, Annex A, ID p.68, p.90 / EN p.70, p.91-92)

- **Lines at least 0.18 mm; type at least 5.5 pt** (lint 27, 28). Nodes and connectors 0.30 mm,
  accent 0.50 mm (Table A.3).
- **Type: node names 7.6 pt, connector labels 6.2 pt, both Cond, ink900** (Table A.2).
- **A reduced page or slide sample is exempt from the 5.5 pt floor** only when a numbered marker of
  at least 5.5 pt points to each element discussed and the text explains it.
- **Fills hatched at 45° and 135°**, never grey tints: two greys become one after two photocopies.
  At most three patterns per figure [v1.7].
- A 1U rack slot cannot hold a legible name; call it out on a leader to the side [v1.7].
- Acceptance: print at 100 %, photocopy twice, read at 40 cm (DT-11c).

---

## 9 · Placing the figure

| Target | Form |
|---|---|
| PDF, HTML | the SVG itself: live `<text>`, real vectors, searchable (9.10, ID p.61) |
| `.docx` | 300 dpi PNG of the SVG at its declared width (DT-36, ID p.63 / EN p.66) |
| `.pptx` | the PNG Studio renders [Interpretation C28]; 300 dpi per the DT-36 test [Interpretation] |

The declared millimetre width is kept: a 166 mm figure lands as 166 mm. Scaling a raster to fit
a frame makes figure type look soft beside sharp page type [v1.7].

---

## 10 · Illustrations (10.10, ID p.70 / EN p.72)

An illustration is a non-standard picture without nodes and connectors: a scaled plan, a screen,
a matrix, an equipment layout.

- **IL-01 (BAKU):** follow the discipline's conventions: a scaled plan with poché walls,
  dimensions and a sheet data block; screen panels with real content. Zero crossing leader lines,
  internal codes and placeholder text.
- **IL-13 (WAJIB):** derive the plan and the camera views from one geometry specification; never
  draw a camera view freehand. On SERAH, a checker who did not draw it reviews the logic.
  Right: a projected Bareskrim examination-room view shows a cabinet blocking the desk, so the
  cabinet is moved. Wrong: a tidy view that "sees" the operator's face from a camera behind them.

IL-01 stands for IL-01 to IL-12, because the detailed illustration reference is not in the skill
copy (PK; E-35).

---

## 11 · Drawing checks (Table 13.1, ID p.80 / EN p.81-82)

Build stage: 24 connector without label · 26 more than one accent · 32 connector through a box ·
33 taller than 247 mm · 34 `sec:` without legend · 35 two dialects · 37 sheet beyond A4. File
stage: 23 rounded corners · 25 more than 5 hex · 27 line below 0.18 mm · 28 type below 5.5 pt
(reduced-sample exemption) · 29 no SOURCE · 30 no number and caption · 31 Mermaid. Full table:
`references/06`.

**Still needs a human eye** [v1.7; DT-01b, ID p.62]: is every box a real component? does every
connector match a real interface, including direction? do the quantities reconcile with the BoQ
and the kajian? would a hostile reviewer read any line as asserting something not intended?

---

## Perubahan dari v1.7

| # | v1.7 rule (section) | Rev A | Source | Class |
|---|---|---|---|---|
| 08-1 | §0 spec "decided by gsp-visual-commander at Gates 0 to 5" | Spec contract kept; the decision is made by the writer in Swarm; producer is Studio [D-C] | ID p.54, p.62 / EN p.57, p.65 | CHANGED |
| 08-2 | §0.4 `labels_verified` set by PRISMA after veritas | Review copies `false`; `true` only after every capacity, count and title has a source | DT-39, ID p.63 / EN p.66 | CHANGED |
| 08-3 | §0.1 key list (`nodes {id,label,tier,sub,mark,tag}`) | Table 10.1 keys; `nodes[]` carry class, sub, mark, tag; `sources[]` at least one document **and article** | ID p.63 / EN p.66 | CHANGED |
| 08-4 | §2 build commands with file names `gambar_4_1.svg` | Removed: underscores break DT-12, and the Swarm route is Studio | DT-12, ID p.11 / EN p.11 | REMOVED |
| 08-5 | §2 Excalidraw drafting, Figma review and handoff, Figma one-way loop, `datum_figma_audit.py` cycle | Mermaid and Excalidraw for drafts; Figma export not used | DT-35, ID p.70 / EN p.72 | REMOVED (Figma loop) / CHANGED |
| 08-6 | §2 family table (8 rows) | Nine families (Figure 10.6); catalogue sheets count the accent per panel | ID p.68-69 / EN p.70 | CHANGED (added) |
| 08-7 | §4 `stadium` terminator, the only shape with a radius | Terminator = rectangle with 2 mm corners, not a stadium | E-29, ID p.82 / EN p.85 | CHANGED |
| 08-8 | §4 `cylinder` for stored data | Cylinders not used; long flows split in two | E-30, ID p.82 / EN p.85 | REMOVED |
| 08-9 | §5 edge pattern table | Same six kinds, now with ISO 128-2 codes (Table 10.4) | ID p.67-68 / EN p.69-70 | KEPT (codes added) |
| 08-10 | §6 "five colour values maximum, as everywhere else" | ≤ 5 hex besides the ground in a figure; page ≤ 2 meaning colours; no blue | DT-06, ID p.48, p.57, p.68 / EN p.50, p.70 | CHANGED |
| 08-11 | §7 caption "GAMBAR 4.1 in condensed 600 uppercase, then one sentence ending in a full stop" | Studio prints the bold capital label with number; the caption text carries no token, one line, at most 100 characters, no middle dot (§7) | DT-15, ID p.41 / EN p.43; Swarm 1.2.6 W-01 | CHANGED (wording) |
| 08-12 | §8 edge annotations 6.2 pt Mono | Connector labels 6.2 pt Cond | Table A.2, ID p.90 / EN p.91 | CHANGED |
| 08-13 | §8 minimum type 5.5 pt, no exemption | Reduced page or slide sample exemption | DT-11d, ID p.68 / EN p.70 | CHANGED |
| 08-14 | §9 `.pptx` at 200 dpi; `figure()` helper in `datum_docx.py` | Studio PNG; 300 dpi per DT-36 test [Interpretation]; `datum_docx.py` not the Swarm route | DT-36, ID p.63 / EN p.66; D-C | CHANGED |
| 08-15 | §11 owner table (domain specialists, veritas, gsp-visual-commander, gsp-ui-architect) | Replaced by the Swarm note; live screens are not document figures | ID p.54 / EN p.57 | REMOVED |
| 08-16 | (none) | Illustrations IL-01 and IL-13 | ID p.70 / EN p.72 | ADDED |

Kept as v1.7 [Rev A silent]: `notes[]` and `lang` keys, envelope principle, commentary on
generated-looking diagrams, geometry units, node shapes other than terminator and cylinder, node
annotation placement, routing conventions, zone and accent guidance, page-apparatus marker, Peta
series, three-pattern limit, 1U callouts, raster scaling note, human-eye questions.
