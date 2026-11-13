# Diagram flow: flowcharts, swimlanes and BPMN in Studio

Use this for any flowchart, cross-functional (swimlane) flow, BPMN process or business flow that goes into a
Studio document. Studio draws the figure from a diagram spec; there is no canvas to drag shapes on. Field
names, allowed values and defaults are not repeated here: read the two Studio resources before your first
spec and use their names exactly.

- studio://skema/diagram: the block, families, every shape token, node and edge basics, the working norms.
- studio://skema/diagram-visio: the three shape sets, the container fields and the connector fields with their
  values and defaults. An absent field draws exactly as before; an explicit default draws the same as absent.

## 1. Pick a shape set and a family
- Basic flowchart (basic-flowchart): family flow, with direction "LR" or "TB" when a decision branches, or graph
  with class.col and class.row when you place nodes yourself. The resource maps each Visio shape (start/end,
  process, decision, subprocess, document, data, page references, preparation, database) to its token.
- Cross-functional (cross-functional): family swimlane. Each node's class.lane names its lane; lanes appear in
  the order the nodes first use them, so moving a lane = reordering nodes. Phases and lane_orientation: section 2.
- BPMN basic (bpmn-basic): family flow or swimlane; pools for participants (section 2).
- One notation per figure (DATUM-35): flowchart (ISO 5807) shapes or BPMN shapes, never both. box, circle,
  cylinder and annotation work in either; diamond is a decision in both.
- predefined is the flowchart "Subprocess" (side bars); subprocess is the BPMN collapsed sub-process with [+].
  Do not swap them.
- event_type (message or timer) is only for the three event shapes (P1-event_type).
- Event and gateway labels sit below the shape (beside the circle when a top-to-bottom flow leaves it
  downward); every other label sits inside its shape. Keep node labels short (about 40 characters, detail in sub).

## 2. Containers: lanes, phases, pools, groups
- phases: spec phases plus class.phase on every node. pools: spec pools plus class.pool on every node. All nodes
  or none, every id known (P1-containers). A lane inside a pool is optional; a lane name may repeat across pools.
- lane_orientation "vertical" turns lanes into columns with headers on top.
- Width: at 166 mm three lanes or three phases fit; at 128 mm keep to two, or the figure is refused (DATUM-37).
  A horizontal pool figure holds two node columns at 166 mm and one at 128 mm. For a wider process use
  lane_orientation "vertical" with the pools, fewer columns, or split it into two diagrams.
- A BPMN group is a zone with style "group". In a swimlane a group reaches into the neighbouring lane unless
  its nodes sit in the first or last lane: put grouped nodes in an outer lane.

## 3. Connectors
Every edge has from, to, kind and label (DATUM-24). kind sets the colour and the default line and head; the
style fields below change one thing each. Line styles (kind + dash + weight) are budgeted (DATUM-25L).
- Route style: route replaces the default router with a straight or a curved line. Straight and curved lines
  never detour: a line through another node is a defect, so move the nodes or use via. Curved lines take no via.
- Glue: from_side / to_side pin an end to one side; from_slot / to_slot (a fraction along that side) need the
  side (P1-edge-style). Two ends on one side closer than 1.5 mm are GEOM_ENTRY_COLLISION. No explicit side on a
  bus node.
- Bend points: via is a list of lattice points {col, row}, only in flow without direction, graph and swimlane
  (P3-via-family), at most 8 (P1-via). Take them from structuredContent.figure.lattice of the preview (cell size
  col_mm / row_mm, sheet size cols / rows, each node's [col0, row0, col1, row1]) for the same template width:
  the lattice is centred per width, so a via chosen at 128 mm can land elsewhere at 166 mm. The lattice is the
  first layout; when the preview reports AUTO_FIT, preview again and re-check. Put via points in the free gap
  between node boxes. A point outside the sheet is refused BY_CONSTRUCTION_FAILED with checkId P1-via.
- Arrowheads: arrow_start / arrow_end set the head type at each end, arrow_start_size / arrow_end_size its
  size. A start size needs arrow_start, and no size goes on a "none" head (P1-edge-style).
- Line: dash and weight.
- Label position: label_at fixes the label at a point along the line (the values are in the resource). A fixed
  label that collides is reported, never moved. Without label_at Studio places the label. Edge labels stay short (about 20
  characters). A one-lattice gap with a lane rule across it cannot hold a label: Studio draws a leader
  (LABEL_LEADER, a defect). Widen the gap (nodes further apart, another column or row) or shorten the label.
- Jumps: crossings are defects (GEOM_EDGE_CROSS); rearrange nodes first. jumps "off" (spec level) draws a
  crossing without the hop arc; curved and diagonal lines never get hops.
- Decisions: enter a diamond or gateway from the top and leave by its vertices; it needs an exit and every exit
  has a label (P3-diamond-exits). Two entries on one side of a flat diamond stay on its slant.

## 4. BPMN recipes
- Sequence flow: kind "data".
- Message flow between pools: kind "control" with arrow_start "circle" and arrow_end "open". A sequence flow
  that leaves its pool gets the notice POOL_FLOW_CROSSES: make it a message flow.
- Association (annotation, data object, data store): kind "sync" with arrow_end "none".

## 5. Examples (each validates and renders with 0 defects at 128 and 166 mm)
Flowchart with a decision:
```json
{"type":"diagram","caption":{"text":"Permohonan diperiksa sebelum diproses."},"source":{"text":"SUMBER: contoh sintetis."},"spec":{"family":"flow","direction":"LR","labels_verified":true,"nodes":[{"id":"a","label":"Mulai","shape":"stadium","class":{}},{"id":"b","label":"Lengkap?","shape":"diamond","class":{}},{"id":"c","label":"Proses","class":{}},{"id":"d","label":"Tolak","shape":"stadium","class":{}}],"edges":[{"from":"a","to":"b","kind":"data","label":"masuk"},{"from":"b","to":"c","kind":"data","label":"ya"},{"from":"b","to":"d","kind":"data","label":"tidak"}]}}
```
Cross-functional flow with two phases:
```json
{"type":"diagram","caption":{"text":"Pengajuan berpindah dari pemohon ke petugas dalam dua fase."},"source":{"text":"SUMBER: contoh sintetis."},"spec":{"family":"swimlane","labels_verified":true,"phases":[{"id":"f1","label":"Ajukan"},{"id":"f2","label":"Periksa"}],"nodes":[{"id":"a","label":"Isi formulir","class":{"lane":"Pemohon","phase":"f1"}},{"id":"b","label":"Periksa berkas","class":{"lane":"Petugas","phase":"f2"}}],"edges":[{"from":"a","to":"b","kind":"control","label":"kirim"}]}}
```
BPMN collaboration, two vertical pools with a message flow:
```json
{"type":"diagram","caption":{"text":"Pemohon mengirim berkas dan petugas menerimanya."},"source":{"text":"SUMBER: contoh sintetis."},"spec":{"family":"swimlane","lane_orientation":"vertical","labels_verified":true,"pools":[{"id":"p1","label":"Pemohon"},{"id":"p2","label":"Kantor"}],"nodes":[{"id":"s","label":"Mulai","shape":"event_start","class":{"pool":"p1"}},{"id":"t","label":"Kirim berkas","shape":"task","class":{"pool":"p1"}},{"id":"r","label":"Terima berkas","shape":"task","class":{"pool":"p2"}}],"edges":[{"from":"s","to":"t","kind":"data","label":"ke"},{"from":"t","to":"r","kind":"control","label":"berkas","arrow_start":"circle","arrow_end":"open"}]}}
```
Connector styling on a graph (glue, bend point, heads, dash, fixed label):
```json
{"type":"diagram","caption":{"text":"Konektor diatur sisi, titik belok, kepala dan posisi label."},"source":{"text":"SUMBER: contoh sintetis."},"spec":{"family":"graph","labels_verified":true,"nodes":[{"id":"a","label":"Langkah A","class":{"col":0,"row":0}},{"id":"b","label":"Langkah B","class":{"col":2,"row":0}},{"id":"c","label":"Langkah C","class":{"col":0,"row":2}},{"id":"d","label":"Langkah D","class":{"col":2,"row":2}}],"edges":[{"from":"a","to":"b","kind":"control","label":"putar","from_side":"bottom","to_side":"bottom","via":[{"col":6,"row":8}]},{"from":"a","to":"c","kind":"data","label":"awal","label_at":"start","dash":"dashed"},{"from":"b","to":"d","kind":"data","label":"kepala","arrow_start":"diamond","arrow_end_size":"l"}]}}
```

## 6. Save, revise, check
- The same block goes into studio_chapter_submit, studio_write (a diagram block), studio_edit (append) and
  studio_chapter_import_markdown (a diagram fence); every field above is kept.
- studio_figure_revise merges spec keys, but arrays (nodes, edges, phases, pools, via) replace whole: send the
  full list. A style-only change gives no FIGURE_GRAPH_DELTA; after any other change read it.
- Set labels_verified true only after you checked every label against the source; until then the preview
  lists P1-labels_verified.
- Gate: studio_figure_preview inline; figure.defects must be empty (notices such as AUTO_FIT, LABEL_MOVED or
  POOL_FLOW_CROSSES are information). Then render with studio_render and look at the PNG: every arrowhead
  reaches its node, labels are clear of lines and outlines. The figure is done only after both.

## 7. Fix a refusal or defect
- SCHEMA_INVALID: unknown field or value; the hint names the right field. Check the resource spelling.
- DATUM-35: two notations mixed. Use only flowchart shapes or only BPMN shapes (plus the shared ones).
- DATUM-25L: too many line styles. Reuse kind, dash and weight combinations.
- P1-edge-style: slot without side, size without head type, curved with via, explicit side on a bus.
- P1-via: malformed point, more than 8, or outside the sheet. Re-read figure.lattice.
- P3-via-family: via in a family that places lines itself. Use flow without direction, graph or swimlane.
- P1-containers: phases, pools or lane_orientation outside swimlane, a duplicate or unknown id, or a node
  without class.phase / class.pool while the others have one.
- P1-event_type: event_type on a shape that is not an event.
- P3-diamond-exits: a decision or gateway without an exit. Add its exits, each with a label.
- DATUM-37 (FIGURE_OVER_CAPACITY): too wide. Fewer lanes, phases or columns, vertical pools, or two diagrams.
- GEOM_* defects (GEOM_LABEL_COLLISION, GEOM_EDGE_NODE, GEOM_ARROW_TANGENT, GEOM_STUB_SEGMENT ...): the
  message names the node or label; move nodes, change a side, shorten a label, or drop label_at.
- LABEL_LEADER: the label had no room on its line; widen the gap or shorten the label.
- POOL_FLOW_CROSSES (notice): a sequence flow leaves its pool; use a message flow.
