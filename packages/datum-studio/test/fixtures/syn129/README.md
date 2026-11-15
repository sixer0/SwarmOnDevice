# syn129 synthetic fixtures (Swarm 1.2.9, row 23)

Folder N9-150. Every file here is synthetic: invented labels (Server Alfa, Sakelar A, Kolam X, Lajur 1, Tugas D, Data E, tiket gangguan), no file from the 1.2.6 anonymised corpus, nothing from a client document or a Research workspace, no home-directory path, no credential. Diagram specs use no classification marker; the chart envelope says `BIASA`.

Measurements below were taken on the BASE engine (red-base checkout of d4282fcfd8, imported read-only), so every fixture shows its defect before the owning row lands. Diagram fixtures are `{caption, source, spec}` figures in the shape of `syn128/vis68a_live_specs.json`: render them through the preview path (`compose.mapBlock` -> `renderFigure`, param `diagram.widthMm`) at 128 and 166 mm. Owning rows add nothing here except N9-161 (row 30a, conditional).

| Register | File | Keys | Used by | Measured at BASE |
|---|---|---|---|---|
| N9-151 | `a06_zone_sheet_edge.json` | `figure` (topology; zone `z1` = `srv`, `arsip`; non-members `swa`, `swb` one tier below) | row 29, AC-A06, N9-105 | frame x 0.10 vs member `srv` x 0.23 (0.13 mm); frame bottom y 33.34 on `swa`/`swb` top y 33.34 (0.00 mm); both widths |
| N9-152 | `a09_edge_along_outline.json` | `figure`, `clean_twin` (swimlane; edge 1 `tidak` c -> f) | row 31, AC-A09, N9-108; Q1 sweep | `figure`: run at x 85.33 on the `data_object` side of `e` for 11.89 mm, both widths; `clean_twin` (`to_side: left`): >= 10.66 mm from the outline |
| N9-153 | `a10a_header_text.json` | `figure` (swimlane, two pools, two phases; edge 0 `mulai` a -> b) | row 32, AC-A10a, N9-109; Q1 sweep | 128 mm: run at x 48.0 touches `KOLAM X` [47.92, 12.23, 58.74, 14.60] and `LAJUR 2`; 166 mm: run x 50.67, boxes from 53.26 (no contact); no edge along an outline |
| N9-154 | `a10b_edge_clamp_spur.json` | `figure` (legacy flow; edge 0 `masuk` with vias on the node cells; edge 1 `keluar`) | row 33, AC-A10b, N9-110; Q1 sweep | edge 0 doubles back at the clamped via (y 2.38 -> 4.76), one reversal, both widths; edge 1 repeated vertex, no reversal (negative control) |
| N9-155 | `a11_chart_bpmn_flow.json` | `no_direction`, `direction_tb` (the g04 `studio.chart/v1` G-04 envelope with BPMN nodes, `class.row` 0-4) | rows 34, 35, AC-A11a/b, N9-111/N9-112 | `renderChart({...chart, style})`, style `datum` and `gallery`: every event arc rx/ry = 2.50; the two variants render different bytes; g04 is untouched |

Each JSON file carries a `$comment` with the exact paths and coordinates measured.
