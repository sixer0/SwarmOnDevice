# syn127 synthetic fixtures (Swarm 1.2.7, row 20)

Every file here is synthetic: filler words (alfa, bravo, ...), synthetic numbers in the `NNN/UJI/...` form, no file from `anon126/`, nothing from a client document. Gate: `grep -rlE '[0-9]{3}/GSP/' .` returns no file.

Defect equivalence below was measured at the engine and verify code of 04067a9d02 (unchanged on release/1.2.7 when the fixtures were made).

| File | Item | Shape | Defect it reproduces (measured) |
|---|---|---|---|
| `n3_d01_150.json` | N-3 | host document: `template`, `docKey`, `title`, `meta`, `slots`, `chapters[]` (chapter v2 without `target`) | 150 untracked decimal-comma numbers on tier SERAH = 150 D01 findings (probe9 N-3: `D01=101`, page total 150) |
| `n4_pdf_only_doc.json` | N-4 | host document | one chapter, two paragraphs, no figure; docx renders without the bridge |
| `n5_page_witness_report.json` | N-5 | `report`: `OutputVerificationReport` | one verified HTML output with 2 page images |
| `n6_entry_collision.svg` | N-6, AC-T03 | hand SVG | `edgeEntryCollision` 1; FIGURE_FIT FAIL `FIG_GEOMETRY` edgeEntryCollision |
| `n6_entry_clear.svg` | N-6 | hand SVG | same figure, ends 5.0 mm apart: no defect, FIGURE_FIT PASS |
| `t03_stub.svg` | AC-T03 | hand SVG | `stubSegment` 1; FIGURE_FIT FAIL `FIG_GEOMETRY` stubSegment |
| `t03_tangent.svg` | AC-T03 | hand SVG | `arrowTangent` 1; FIGURE_FIT FAIL `FIG_GEOMETRY` arrowTangent |
| `t03_two_line_colours.svg` | AC-T03 | hand SVG | a data line (#101418) and a dashed control line (#B4532A) share one trunk into one port: `edgeCollinear` 1 (NOTE, report-only) + `edgeEntryCollision` 1 (FAIL). FIGURE_FIT has no colour code; the FAIL raised is `FIG_GEOMETRY` edgeEntryCollision (GEOM_ENTRY_COLLISION) |
| `f6_fan_in_specs.json` | F-6 | `specs[]`: `{name, spec}` | the 8 probe9 fan-in configurations; `buildDiagramSvgAuto` gives `edgeEntryCollision` 0 for all 8 |
| `n7_autofit_t03_rest.json` | N-7 | `spec`, `buildOptions`, `expected` | first render score 1; AUTO_FIT -> `sisa 0`, suggest `tidak ada`, and 1 `GEOM_STUB_SEGMENT` follows (buildDiagramSvg and buildDiagramSvgAuto) |
| `n10_write_dt10a.json` | N-10 | `args`: `studio_write` arguments (add `mission`) | 3 columns of `R-01/.../R-12`: render refused FIGURE_OVER_CAPACITY (DT-10a) |
| `n11_id_list_table.json` | N-11 | `variants.{slash,comma,semicolon}`: table rows | each variant `minMm` 201.7, refused DT-10a |
| `t06_chart_w03_five_lines.json` | T-06 | `spec`: W-03 chart | refused `DATUM-25` "5 garis > 3" |
| `t06_diagram_six_colours.json` | T-06 | `spec`: diagram | refused DATUM-25, `dihitung 6:` and `sisa −1` |
| `t11_flow_inline_v2.json` | T-11 | `block`: inline v2 diagram block | flow without direction; with `direction:"LR"` at 166 mm the source x is left of every target |
| `t12_standalone_key_source.json` | T-12 | `block` + `figureLabel` | at 128 mm (apparatus figure): KEY/KUNCI row drawn (2 edge kinds), SUMBER wraps to 2 lines |
| `t13_chapter_page_rules.json` | T-13 | `rules[]` (CSSPageRule-like, `style` = longhands), `pageHeightMm` | `contentHeightMm` null (margin-box rule first) |
| `t13_document_page_rules.json` | T-13 | same | `contentHeightMm` 247 |
| `m03_render_fail_doc.json` | M-03/M-08 | host document, `harness.bridge:false` | html output RENDER_UNVERIFIED with fail=EMPTY_SLOTS (figure placeholder without the bridge, probe9 M-03) |

Host documents: create with `studio_document_create {template, docKey, title, meta?, mission}`, fill each `slots` entry with `studio_slot_fill`, submit each `chapters[i]` with `studio_chapter_submit` after adding `target: {documentId}`.

T-13 rules: `style.getPropertyValue(name)` should return `style[name]` or `""`.
