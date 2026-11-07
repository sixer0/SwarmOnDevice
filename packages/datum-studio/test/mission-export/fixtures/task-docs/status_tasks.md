# Status

| Phase | Status |
|---|---|
| Rows 1-20, 63, 65 | done |
| Row 21 | done (C19) |
| Wave 1 | running: 72, 73, 79 (after 72), 80 (after 72), 90 |
| Implementation wave A | running: rows 22, 24, 26, 27, 47, 106 (repo HEAD 029c07829a) |

## Snapshot 2026-11-07 (controller)
- Done: rows 1-30, 37, 47, 63, 65, 72-110, 117, 118. Row 109 gate PASS: controller re-run in fixture HOME, test/prisma-cut 14/0, test/security 28/0, src/store/store.test.ts 17/0; files present under swarm/packages/datum-studio/ (store-bridge/, vendor services/_swarm-store.ts).
- Wave C launched: rows 31 (host MCP server), 64 (template store, migration 0002), 122 (engine DOCX Rev A fixes), 124 (engine diagram fixes). Row 123 follows 122 (shared engine front matter). Then 111, 66-71, 119-121, 32-36, 42-46.
- Mission control master design: report/mission_control_master.html, artifact version 6 (HQ deck, lit rooms, Deliverables panel).
- 2026-11-07: design closed (C59). Also launched rows 32 (PDF via bridge) and 111 (host process lifecycle). In flight: 31, 32, 64, 111, 122, 124. Next on release: 123 (after 122), 33/34 (after 111), 66 (after 64), 119 (after 31), 36, 42-44.
- 2026-11-07: row 64 gate PASS (controller re-run: src/store 25/0, prisma-cut 14/0, security 28/0; migration 0002_datum_template_guard present). Row 66 launched.
- 2026-11-07: row 32 gate PASS (controller re-run, sandbox off for the socket test only: render-pdf 7/0, engine-twins 21/0, prisma-cut 14/0, security 28/0; soffice grep on the PDF path exit 1). Carried: real-Electron print + 16 MiB bridge cap to rows 42/43. Integration pass (later, one small row): delete the convertDocxToPdf stub keeping the soffice barrel for joblog.ts; recount vendor/provenance.json `counts`. Row 31 told about its nonexistent services/render imports.
- 2026-11-07: row 111 gate PASS (controller re-run: datum-studio-host tests 25/0, desktop typecheck exit 0, index.ts +13 lines, real ~/.local/share/swarm/datum-studio absent). Row 31 sent the StudioHostModule export contract. Rows 33, 34 launched. Real-Electron smoke (helper name vs row 30 liveness, quit vs auto-updater) carried to rows 42/43.
- 2026-11-07: row 31 gate PASS (C60). Row 31b launched (revisions port, R14/R16); 31c follows. Row 34 given the bridge header contract (file_requests line 51).
- 2026-11-07: row 122 gate PASS (C61). Launched row 123 and integration pass I-1. Queued: row 110d after row 66, row 31c after 31b.
- 2026-11-07: row 124 gate PASS for code (C62); B-O L1 0.889 on 3 diagram pairs awaits the user's ruling (U18 vs Rev A fixes). Row 124b (CP-45 symbol) queued.
- 2026-11-07: row 34 gate PASS, I-1 closed (C63). Queued: 34b after 33, 110d after 66, 31c after 31b, 124b after 31c/123. Pending user: diagram L1 ruling (C62).
- 2026-11-07: row 33 gate PASS (C64). Row 34b launched.
- 2026-11-07: rows 31b, 66 gate PASS (C65). Launched 31c, 67, T-1. Queued 110d after 67; 68 after 67; 124b after 31c/123; 119 (31 done) next free slot.
- 2026-11-07: T-1 gate PASS (controller re-run combined 15 files: see C66). Product note to integration/row 48: openHostStore root is not checked against the cached STUDIO_WORKSPACE_ROOT (vendor contract/env.ts:204,317-330).
- 2026-11-07: row 34b gate PASS (C67). Launched 119, 35.
- 2026-11-07: row 35 gate PASS (note path = register :102/:106; wrapper absent on the real ~/.local/bin). Row 36 must ship it.
- 2026-11-07: row 123 gate PASS (C69). Running: 31c, 67, 119a. Queued: I-2 and 110d and 68 after 67; 119b after 119a+31c; 124b after 31c.
- 2026-11-07: row 31c gate PASS (C70). Launched 124b. Running: 67, 119a, 124b.
- 2026-11-07: row 119a gate PASS (C71). Launched 119b, T-2.
- 2026-11-07: row 67 gate PASS (C72). Launched 68, 110d. Running: 68, 110d, 119b, 124b, T-2.
- 2026-11-07: T-2 gate PASS (C73), combined 287/0.
- 2026-11-07: row 124b gate PASS (C74). Running: 68, 110d, 119b.
- 2026-11-07: row 110d gate PASS (C75). Queued 110e (built-in logo assets) after 68. Row 119b told to fix its ajv strict schema.
- 2026-11-07: row 68 gate PASS (C76). Launched 110e, 69. Running: 69, 110e, 119b. I-2 after 119b.
- 2026-11-07: row 119b gate PASS (C77), package 397/0. Launched I-2. Queued 119c after I-2; 120 after 119b (renderer) - next slot.
- 2026-11-07: row 69 review accepted (C78). Launched 69a. I-2 told to keep row67-host-guard green.
- 2026-11-07: row 110e gate PASS (C79). Launched row 36 (stage + asset layout). Running: I-2, 36, 69a, 120.
- 2026-11-07: row 120 gate PASS (C80). Row 121 (controller proof) after 119c.
- 2026-11-07: I-2 gate PASS (C81). Launched 120b, 119c. Running: 36, 69a, 119c, 120b.
- 2026-11-07: rows 69a, 36, 120b gate PASS (C82). Launched 69b. Running: 69b, 119c. Next: 70 (security, templates) after 69b; 121 after 119c; then 42-46.
- 2026-11-07: rows 69b, 69c, 119c gate PASS (C84, C85), package 492/0. Launched 119d, 70. Running: 45, 70, 119d. Then 121, 42-44, 48-50.
- 2026-11-07: row 45 gate PASS (C87). Launched 103b. Running: 70, 103b, 119d.
- 2026-11-07: row 103b gate PASS (C88). Running: 70, 119d.
- 2026-11-07: row 119d gate PASS (C89), package 505/0. Launched 42, 43, 44, 46. Running: 42, 43, 44, 46, 70. Then 48, 49, 50 -> 51 commit -> 52 build.
- 2026-11-07: row 46 gate PASS; row 70 CAUTION (C90). Launched 70a, L-1. Running: 42, 43, 44, 70a, L-1.
- 2026-11-07: row 43 gate PASS (C92); F1 -> row 43a launched. Running: 42, 44, 43a, 70a.
- 2026-11-07: row 70a gate PASS, row 70 -> PASS (C93). Running: 42, 44, 43a.
- 2026-11-07: rows 44, 43a gate PASS (C94). Launched 43b. Running: 42, 43b.
- 2026-11-07: row 43b gate PASS (C95). Running: 42.
- 2026-11-07: row 42 gate PASS (C96), package 3910/0. Launched 122c. Running: 112, 122c. Then 48, 49 -> 50 -> 51 -> 52.
- 2026-11-07: row 122c gate PASS (C97). Running: 112.
- 2026-11-07: U21 recorded (Rev A fix wins on the 3 diagram pairs). Running: 112.
- 2026-11-07: launched 48, 49 (row 112 addendum later). Running: 48, 49, 112.
- 2026-11-07: row 112 gate PASS with change (C101). Launched 112b. Running: 48, 49, 112b.
- 2026-11-07: row 112b gate PASS (C102). Running: 48, 49.
- 2026-11-07: row 48 CAUTION (C103). Launched 48a. Running: 48a, 49.
- 2026-11-07: row 49 changes requested (C104), CP-08 corrected. Launched 49a. Running: 48a, 49a.
- 2026-11-07: row 48a gate PASS, row 48 -> PASS (C105). Running: 49a.
- 2026-11-07: row 49a gate PASS, row 49 -> PASS (C106). Launched 49b. Then 50.
- 2026-11-07: row 49b gate PASS (C107). Running: 50.
- 2026-11-07: row 50 PASS (C108). Row 120c running; then row 51 commit.
- 2026-11-07: row 51 committed 1eb98be8e2 (C110). Row 52 build launched.
- 2026-11-07: row 52 build blocked by gates (C111). Launched 52a.
- 2026-11-07: row 52a PASS (C112). Next 51b commit, 52b build.
- 2026-11-07: build 5168775812 PASS 30/30 (C114). Next: 54, 55 isolated runs.
- 2026-11-07: row 54 PASS (C116); row 55 retry running (C117).
- 2026-11-07: row 55 needs-review: F55-1 no PDF in the real app (C118). Launched 24a.
- 2026-11-07: build 503f8651c9 PASS (C121). Launched 55c.
- 2026-11-07: C123 cleanup OK; U23: mission control 1.2.1 next, then e2e via MC on the final build.
- 2026-11-07: U24: verification gate + capacity refusal + ELK/Vega in 1.2.1.
- 2026-11-07: 1.2.1 blueprint accepted (C124). Wave 1: 125, 137, 138, 148, 158, 159.
- 2026-11-07: row 125 PASS (C127). Wave 2: 126, 127, 128, 129, 145.
- 2026-11-07: row 148 PASS + 151b added (C130). Launched 149, 150, 153, 156.
