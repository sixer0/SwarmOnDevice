# syn128 synthetic fixtures (Swarm 1.2.8, row 25b)

Folder N8-301. Every file here is synthetic: filler words (alfa, bravo, ...), synthetic numbers in the `NNN/UJI/...` form, invented product / institution / theme names (Lumen, Dinas Contoh, Pasang Surut), no file from the 1.2.6 anonymised corpus, nothing from a client document or a Research workspace, no home-directory path, no credential. Gate: the row 25b privacy grep (classification marker, 1.2.6 corpus name, home path, key patterns; command in `docs/.../initialization/04_fixtures.md`) returns no file.

Engine measurements below were taken with the diagram engine of release/1.2.8 at 1626326156, whose `vendor/src/lib/studio/engine/**` is byte-identical to BASE e1f9673772 (`git diff --stat e1f9673772 HEAD -- packages/datum-studio/vendor/src/lib/studio/engine` empty). M3 rows add their own N8-475 files here as NEW files; they do not edit these.

## N8-390 debt fixtures (M1)

| File | Item / row | Shape | Measured at BASE engine |
|---|---|---|---|
| `hna_flow_v2.json` | AT-HNA, rows 33, 68 | `block` (inline DiagramV2, 5 nodes stadium/box/diamond, caption, source), `writeBlock` (`{diagram:{spec,caption,source}}` for studio_write / studio_edit), `chapter` (`studio.chapter/v2` with `$schema`; set `target.documentId`) | validateSpec 0 refusals; render score 0 with 1 GEOM_STUB_SEGMENT + 1 GEOM_ARROW_TANGENT REPORT line |
| `hn13_import.md` | AT-HN13, row 32 | markdown: one ```` ```diagram ```` fence (spec JSON) followed by `Gambar:` and `Sumber:` lines, one ```` ```json ```` fence `"type":"diagram"`, one ```` ```json ```` fence `"type":"table"`, one plain fence | both diagram specs pass validateSpec |
| `hn15_wide_table.json` | AT-HN15, row 34 | `args` = studio_write arguments (add `mission`); 6 columns of one 16-character run of wide capitals each | DT-10a lower bound 119.18 mm (not refused). TABLE_OVERFLOW at render is EXPECTED, NOT MEASURED (needs a browser render; row 34 confirms) |
| `hn15_fit_table.json` | AT-HN15, row 34 | `args`, 3-column table | DT-10a lower bound 29.45 mm; expected clean |
| `hn6_engine_entry_collision.json` | AT-HN6, row 35 | `spec` graph 128 mm, 5-way fan-in into the left side of `t` | edgeEntryCollision **0** (2 stubSegment). No engine spec with edgeEntryCollision >= 1 was found (see 04_fixtures.md); row 35 decides |
| `hnb_fit_to_zero.json` | AT-HNB, row 35 | `spec` flow LR 166 mm, 4-node chain | first score 1; AUTO_FIT `terdeteksi (1) ... -> sisa 0`; final 0 defects |
| `hnb2_capacity_adapt.json` | AT-HNB2, row 35 | `spec` graph 166 mm, 5 columns | first render refused DATUM-37-lebar; capacity layout score 0; geometry AUTO_FIT + CAPACITY_ADAPT |
| `hnb4_flow_rank_overflow.json` | AT-HNB4, row 35 | `spec` flow TB 128 mm, 8 nodes on rank 1 | refused DATUM-37-lebar, `peringkat 1 memuat 8 simpul` |
| `hnb4_graph_sheet_overflow.json` | AT-HNB4, row 35 | `spec` graph 128 mm, 5-column chain | refused DATUM-37-lebar (same id), `simpul c3 keluar lebar lembar` |
| `r18g_lr_166.json` | AT-R18g, row 68 (EYE) | `spec` flow LR 166 mm, 4 ranks + 1 control branch | AUTO_FIT -> sisa 0; final lint score 0, width 166 mm |

Diagram fixtures carry `buildOptions: {release: false}` as in syn127.

## M2 fixtures (memory index, projects)

| File | For | Content |
|---|---|---|
| `mem_store_near_budget.json` | 01e MEM-c load budget, T-9 lazy migration | 1.2.7-shaped v2 store (`{version:2, enabled, items}`, no `kind`), 73 ordinary notes of 400 characters (user / agent / learned mix). `promptBlock(items, {budget: 8000})` (opencode `memory/learn.ts`, unchanged since BASE) shows all 73 at 31 727 characters = 7 932 estimated tokens; with a 74th note of the same size 1 note is hidden (footer present) |
| `mem_index_39_entries.json` | 01e MEM-a/b/c | v2 store with 39 `kind:"index"` entries (one below `INDEX_LIMITS.entries` 40, so the next new entry triggers the roll-up) plus 10 ordinary notes. Every line matches N8-005, `missionId` equals group 2, report path under `docs/<missionId>/`, longest line 262 characters, `untrusted: true`. The 39 lines need about 3 000 estimated tokens, over `INDEX_LOAD_BUDGET_TOKENS` 2 000, so the index section must skip lines whole |
| `default_project/` | 01d F-PROJ e/f/g/i (rows 44-46) | Default Project root R: `docs/<missionId>/report/report.md` for 21 root missions in 3 themes (7 each), a marked group `Lumen/.swarm/group.json` (`{version:1, name, kind:"product", created}`) holding 1 mission, and an unmarked child folder `Arsip Lama/` |
| `default_project_missions.json` | same | manifest: mission ids (match the mission-id pattern), titles, type, theme, `expectedGroup`, `groupKind`, `projectDir` relative to R, 2 rows each |

Use: copy `default_project/` into a mkdtemp `Documents/Default Project` and stub `os.homedir`; never point a test at the real Default Project, vault or memory store. Store files go into a mkdtemp data dir as `memory/<key>.json`.
