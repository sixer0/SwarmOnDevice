# Ported Studio tests (row 42, Swarm 1.2.0)

The original DATUM Studio's own unit tests, ported from the read-only clone of gsp-datacenter at commit
`b0ae7a729d27` (`tests/unit/studio/**`, vitest) and run with bun:test against the vendored copy in `../../vendor`
(file set and patches: `../../vendor/provenance.json`). Only tests whose subject is in the vendored file set are ported.
Each ported file starts with a `// Ported by Swarm row 42 from ...` line naming its source path; every change to a
ported file is marked in place with `row42 <id>` and listed below. Task record:
`docs/2026-11-06_swarm_1_2_0_datum_installer/implementation/21_studio_tests.md`.

Run (from `packages/datum-studio`): `bun test test/ported/` (the whole package: `bun test src test`).
Last run 2026-11-07: **188 files, 3384 pass, 76 skip, 2 todo, 0 fail** (`bun test --todo` runs the 2 todo cases; they
fail today, see D1).

## Layout

| Path | What |
|---|---|
| `<dir>/*.test.ts` | ported tests, same relative path as in `tests/unit/studio/` |
| `<dir>/_kit.ts`, `engine-core/fixtures.ts`, `figures/_helpers.ts`, `figures/_svgManifest.ts`, `draft/r3-stateful-harness.ts`, `mcp/mcp-harness.ts`, `mcp/implw3-client-mock.ts`, `renderers/dc12-contract-fixture.ts`, `structure/_kit.ts` | ported helpers |
| `figures/fixtures/*.json`, `figures/__fixtures__/clean-svg-manifest.json` | ported test data |
| `_fixtures/tests/parity/fixtures/{doc,diagram,chart,symbol}/**`, `manifest.json` | data copied from the clone (`tests/parity/fixtures`, 76 JSON files; no code) |
| `_fixtures/benchmark/manual000/doc.json`, `_fixtures/docs/STUDIO-HOWTO-{REPORT,DOCUMENT}.md` | data copied from the clone (not in the vendored set; read by tests as text) |
| `_vitest.ts` | shim: `vitest` API on bun:test (W1) |
| `_env.ts` | `useStudioEnv()` (W5) and `seedModule()` (W14) |

## Adaptation ids

Mechanical (test harness; no assertion changed):

| Id | Change | Why |
|---|---|---|
| W1 | `from 'vitest'` -> `../_vitest` | vitest is not installed; the shim re-exports bun:test and adds `vi.hoisted/mocked/resetModules` |
| W2 | relative imports into the clone's `src/ scripts/ prisma/ benchmark/ docs/` -> same path under `vendor/` | clone layout kept below `vendor/` (spec §1.1) |
| W3 | relative imports into `tests/parity/` -> `_fixtures/tests/parity/` | parity fixtures copied as data |
| W4 | repo-root path anchors (`REPO`, `ROOT`, fixture dirs) -> `vendor/` or `_fixtures/` | same files, new location |
| W5 | first statement `useStudioEnv()` | the host always sets absolute `STUDIO_ASSETS_ROOT` and `STUDIO_WORKSPACE_ROOT` (row 107 M4, spec §2 B: no cwd fallback); restored in the file's afterAll |
| W6 | `toMatchObject` on a `structuredClone` (draft/r3fix-md-report) | bun 1.3.14 `toMatchObject` with asymmetric matchers overwrites the received values with the matcher objects (probe: `[1,2]` -> `{}`) |
| W7 | open-spy assertion: "no open other than a read of the draft" (draft/r2cli-studio-report) | Node's `readFileSync` goes through the exported `fs.openSync`; Bun's native one does not |
| W8 | `async (ctx) => { if (!ok) ctx.skip() }` -> `it.skipIf(!ok)` | bun treats a 1-arg test fn as a done-callback; same guard (no Chromium in a unit run) |
| W9 | mock factory `importOriginal` -> namespace copy; fault flags reset in afterAll (engine-core/lint-runner-fault) | bun has no `importOriginal`; bun module mocks outlive the file (C65/C71 isolation lesson) |
| W10 | figure mocks pass every real export and stub only while the file runs; the `services/templates` mock of the seed tests is commented out | same isolation lesson; the seed mock served only the Prisma cases (P) |
| W11 | MCP `loadConfig` calls get an explicit `STUDIO_MCP_FILE_ROOTS` | row 107 M1: no cwd root; so each assertion reaches its own check |
| W12 | MCP harness passes `repoRoot` (vendor root) to `createStudioMcpServer` | row 29 `_repo-alias` twin reads `STUDIO_VENDOR_ROOT` once at import (fail closed to `/var/empty`) |
| W13 | `// @ts-nocheck` first line | vitest-typed sources; bun-types matcher overloads differ (142 TS2769); keeps `tsgo --noEmit` of the package clean |
| W14 | `vendor/prisma/seed-*.ts` imported through `seedModule()` (computed dynamic import) | otherwise `tsgo` pulls `vendor/prisma/**` (excluded in tsconfig, names `@prisma/client`) into the program |

Behaviour changed on purpose by a Swarm patch (assertion adapted to the patched behaviour, decision cited at the line):

| Id | Decision | Change in the expectation |
|---|---|---|
| A1 | C78, row 69a | `STUDIO_ERROR_CODES` 73 -> 74 (`TEMPLATE_ARCHIVED`) |
| A2 | C40, row 122 (CP-05/CP-06) | registry R-81..R-83 appended: renderer 59 -> 62, total 802 -> 805, `cover.controlBlock.fields` enum + HALAMAN/DATUM GEODETIK/VERIFIKASI, category counts, paramsSha256 pin checked over the params without the 3 new keys |
| A3 | C40, row 122 CP-14 | default issue stamp separator `--` -> U+2014 (registry default unchanged) |
| A4 | row 107 M3 | `resolveProfileInMemory` needs a confined `resolveAssetPath` (engine-core/fixtures) |
| A5 | C40, row 123 CP-07 | ID seal band prints `KLASIFIKASI · <level>` |
| A6 | C40, row 122 CP-11 | ID documents restart sheet numbering at Bab 1; the "no restart by default" claims are checked on EN |
| A7 | C40, row 124 CP-43 and CP-28/48 | DATUM-25 counts only the defs a figure uses: `dg_layered_good` and the "six colours" bad case now build with <= 5 hex outside the background; caption `GAMBAR n` tspan |
| A8 | C40, row 124b CP-35 | key row label in the document language (`KUNCI` for ID) |
| A9 | row 107 M1 | MCP file roots: no cwd default, empty roots refused, UNC refused by the absolute-path rule |
| A10 | row 29 (spec §5.1, mission contract §8.1, U19/C51) | toolsets documents, query, write, templates, reports, missions all on: `studio_write`/`studio_edit` listed by default; the 30 KB list budget checked on the original default set; "no oneOf/anyOf at the root" checked for every tool, the whole-schema check kept for the original default tools |

Cases kept but skipped (`it.skip`/`describe.skip`, reason at the line):

| Id | Count | Reason |
|---|---|---|
| S1 | 16 | spawn the CLI `scripts/studio/md2contract.ts`, not in the vendored set (import/dc25) |
| S2 | 7 | spawn `scripts/studio/draft-check.ts` as a CLI; its direct-run entry is removed (row 107 M5) |
| S3 | 5 | relabelled Plex faces / "IBM Plex Sans Cond" alias not shipped (U9.7, C31, row 108; spec §2 F) |
| S4 | 4 | byte pins (sha256) of pre-patch DOCX/SVG output; the Rev A fixes change bytes on purpose (C40; C23 recorded diffs) |
| S5 | 3 | HTML cover-title leading and DejaVu fallback changed by row 123 CP-37/CP-19 (C40); see O1 |
| E1 | 1 | needs the Electron render bridge (figure rasterisation); none in a bun unit run (render/c18) |
| E2 | 1 | needs PNG assets from a seeded local workspace that the clone does not track (renderers/fixhz2) |
| P | 29 | "Prisma (row 109 cut)": Prisma client/tx stubs drive code that the row 109 twins run as SQL over the store (security/asset-quota 5, seed/c21 9, seed/gf08 7, structure/fixhr2 7, structure/dc09 1) |
| orig | 10 | the original's own guards: Chromium unavailable (6, via W8), source files outside the repo absent (HS bad cases 1, hermes docs 3) |

Defect found (kept failing as `it.todo`, runs with `bun test --todo`):

| Id | Where | What |
|---|---|---|
| D1 | `vendor/src/lib/studio/registry/essentials.ts:103` (`ids("R-", [67, 80])`), params added at `vendor/src/lib/studio/params/render.ts:417-436` | row 122's R-81..R-83 have no surface: `paramSurfaceOf()` returns undefined (essentials.ts:180-182; "undefined = unmapped"), R03 reports surface "unmapped" (`src/mcp-host/local-api/routes/r03-registry.ts:164`). Tests: `structure/params-surface.test.ts` (SC-2), `ui-categories/param-categories.test.ts` (counts). Functional effect is small (access.ts:256-265 treats unmapped as advanced) |

Observations (not failures): O1 HTML/DOCX cover-title parity (ENG-01) no longer holds after row 123 CP-37 (HTML 24 pt title
line 31.7 pt, DOCX 29 pt exact). O2 with `write` on by default, the default `tools/list` is about 39 KB (the original's
30 KB budget held for reports+documents+query); `studio_write`/`studio_edit` carry nested anyOf (none at the root).

## Ported files (188)

Counts are from the last run (junit). Every file also carries W1, W5 and W13; helpers carry W1/W2/W4/W12 as listed in the
implementation report.

| File | pass | skip | todo | Adaptations |
|---|---|---|---|---|
| `completeness/dc11-contract-completeness.test.ts` | 12 | 0 | 0 | W1, W5, W13 |
| `compose/c10-control-sheet-manual-columns.test.ts` | 9 | 0 | 0 | W1, W5, W13 |
| `compose/c15-c27-cover-control-block.test.ts` | 11 | 0 | 0 | W1, W5, W13 |
| `compose/dc10-contract-record.test.ts` | 15 | 0 | 0 | W1, W5, W13 |
| `compose/dcwire-snapshot-state.test.ts` | 7 | 0 | 0 | W1, W5, W13 |
| `compose/s29-usage-parity.test.ts` | 14 | 0 | 0 | W1, W2, W4, W5, W13, W14 |
| `contract/dc05-contract-delta.test.ts` | 64 | 0 | 0 | A1, W1, W5, W13 |
| `contract/dc35-chart-custom.test.ts` | 51 | 0 | 0 | W1, W5, W13 |
| `contract/dc35-code-matrix.test.ts` | 34 | 0 | 0 | W1, W5, W13 |
| `contract/dc35-findings.test.ts` | 4 | 0 | 0 | W1, W5, W13 |
| `contract/dc35-roundtrip.test.ts` | 6 | 0 | 0 | W1, W2, W5, W13 |
| `contract/fig03a-chart-intent-schema.test.ts` | 10 | 0 | 0 | W1, W5, W13 |
| `contract/secfix2-schema-walk.test.ts` | 15 | 0 | 0 | W1, W5, W13 |
| `contract/secfix3-table-rows.test.ts` | 5 | 0 | 0 | W1, W5, W13 |
| `contracts/dc07-contract-service.test.ts` | 28 | 0 | 0 | W1, W5, W13 |
| `docx-fonts-family.test.ts` | 1 | 2 | 0 | S3, W1, W4, W5, W13 |
| `draft/dc21-extract-draft.test.ts` | 21 | 0 | 0 | W1, W5, W13 |
| `draft/dc22-draft-check.test.ts` | 10 | 6 | 0 | S2, W1, W2, W4, W5, W13 |
| `draft/r2cli-draft-check.test.ts` | 7 | 1 | 0 | S2, W1, W2, W4, W5, W13 |
| `draft/r2cli-studio-report.test.ts` | 14 | 0 | 0 | W1, W2, W5, W7, W13 |
| `draft/r2fix-cli.test.ts` | 17 | 0 | 0 | W1, W2, W5, W13 |
| `draft/r3cli-md-native.test.ts` | 14 | 0 | 0 | W1, W2, W5, W13 |
| `draft/r3fix-md-report.test.ts` | 22 | 0 | 0 | W1, W2, W5, W6, W13 |
| `draft/r3fix2-refresh.test.ts` | 14 | 0 | 0 | W1, W2, W5, W13 |
| `draft/r3fix3-own-write.test.ts` | 7 | 0 | 0 | W1, W2, W5, W13 |
| `engine-core/bind-arith.test.ts` | 84 | 0 | 0 | W1, W5, W13 |
| `engine-core/bind-derivation.test.ts` | 35 | 0 | 0 | W1, W5, W13 |
| `engine-core/bind-format.test.ts` | 45 | 0 | 0 | W1, W5, W13 |
| `engine-core/bind-language.test.ts` | 18 | 0 | 0 | W1, W5, W13 |
| `engine-core/bind-number-conventions-en.test.ts` | 31 | 0 | 0 | W1, W5, W13 |
| `engine-core/bind-number-conventions.test.ts` | 26 | 0 | 0 | W1, W5, W13 |
| `engine-core/lint-d01-register-language.test.ts` | 4 | 0 | 0 | W1, W5, W13 |
| `engine-core/lint-d01-structural-numbering.test.ts` | 12 | 0 | 0 | W1, W5, W13 |
| `engine-core/lint-fixl-precision.test.ts` | 26 | 0 | 0 | W1, W5, W13 |
| `engine-core/lint-number-patterns.test.ts` | 34 | 0 | 0 | W1, W5, W13 |
| `engine-core/lint-render.test.ts` | 30 | 0 | 0 | W1, W5, W13 |
| `engine-core/lint-runner-fault.test.ts` | 3 | 0 | 0 | W1, W5, W9, W13 |
| `engine-core/lint-scan.test.ts` | 33 | 0 | 0 | W1, W5, W13 |
| `engine-core/lint-structure-language.test.ts` | 15 | 0 | 0 | W1, W5, W13 |
| `engine-core/tokens.test.ts` | 28 | 0 | 0 | W1, W5, W13 |
| `engine-core/trust-override.test.ts` | 10 | 0 | 0 | W1, W5, W13 |
| `figures/chart-key-label-en.test.ts` | 118 | 0 | 0 | W1, W5, W13 |
| `figures/chart-lint.test.ts` | 50 | 0 | 0 | W1, W5, W13 |
| `figures/chart-params.test.ts` | 21 | 0 | 0 | W1, W5, W13 |
| `figures/chart-smoke.test.ts` | 121 | 0 | 0 | W1, W5, W13 |
| `figures/clean-svg-manifest.test.ts` | 1 | 3 | 0 | S4, W1, W5, W13 |
| `figures/dc27-chart-custom.test.ts` | 25 | 0 | 0 | W1, W5, W13 |
| `figures/dc27-preset-sweep.test.ts` | 1 | 0 | 0 | W1, W5, W13 |
| `figures/diagram-bad-cases.test.ts` | 40 | 1 | 0 | A7, W1, W5, W13 |
| `figures/diagram-families.test.ts` | 28 | 0 | 0 | A7, W1, W5, W13 |
| `figures/diagram-keyrow-page.test.ts` | 8 | 0 | 0 | W1, W5, W13 |
| `figures/diagram-keyrow-schema.test.ts` | 3 | 0 | 0 | W1, W5, W13 |
| `figures/engfix-core.test.ts` | 12 | 0 | 0 | W1, W5, W13 |
| `figures/engfix-diagram.test.ts` | 5 | 0 | 0 | W1, W5, W13 |
| `figures/fig02a-geometry-lint.test.ts` | 16 | 0 | 0 | W1, W5, W13 |
| `figures/fig02a-textfit.test.ts` | 19 | 0 | 0 | W1, W5, W13 |
| `figures/fig02b-edge-labels.test.ts` | 10 | 0 | 0 | W1, W5, W13 |
| `figures/fig02b-node-wrap.test.ts` | 11 | 0 | 0 | W1, W5, W13 |
| `figures/fig02b2-flowchart.test.ts` | 4 | 0 | 0 | W1, W5, W13 |
| `figures/fig02b2-layout.test.ts` | 10 | 0 | 0 | W1, W5, W13 |
| `figures/fig02b2-order-lanes.test.ts` | 10 | 0 | 0 | W1, W5, W13 |
| `figures/fig02c-labelfit.test.ts` | 15 | 0 | 0 | W1, W5, W13 |
| `figures/fig03a-chart-intent.test.ts` | 22 | 0 | 0 | W1, W5, W13 |
| `figures/fig03a-compose-intent.test.ts` | 3 | 0 | 0 | W1, W5, W13 |
| `figures/fixf-artifact-keyrow.test.ts` | 3 | 0 | 0 | A8, W1, W5, W10, W13 |
| `figures/fixh8-chart-min-height.test.ts` | 7 | 0 | 0 | W1, W5, W13 |
| `figures/fixh8-figure-alt.test.ts` | 7 | 0 | 0 | W1, W5, W13 |
| `figures/secfix-render-capacity.test.ts` | 2 | 0 | 0 | W1, W5, W10, W13 |
| `figures/symbols.test.ts` | 104 | 0 | 0 | W1, W5, W13 |
| `import/dc24-md2contract.test.ts` | 16 | 3 | 0 | W1, W5, W13 |
| `import/dc25-md2contract-cli.test.ts` | 1 | 16 | 0 | S1, W1, W4, W5, W13 |
| `import/fiximp-import-contract.test.ts` | 85 | 0 | 0 | W1, W5, W13 |
| `mcp/implw-write.test.ts` | 21 | 0 | 0 | A10, W1, W2, W5, W13 |
| `mcp/implw10-final.test.ts` | 19 | 0 | 0 | W1, W2, W4, W5, W13 |
| `mcp/implw11-span.test.ts` | 16 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw2-client.test.ts` | 32 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw2-cycle2.test.ts` | 10 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw2-security.test.ts` | 15 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw3-builder.test.ts` | 13 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw3-client-builder.test.ts` | 10 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw3-cycle1.test.ts` | 12 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw3-edit.test.ts` | 11 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw3-lenient.test.ts` | 5 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw3-outcome.test.ts` | 6 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw4-cycle1.test.ts` | 8 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw4-lows.test.ts` | 5 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw4-meta.test.ts` | 8 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw4-numbering.test.ts` | 5 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw4-verify.test.ts` | 4 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw5-edit.test.ts` | 18 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw6-quiet.test.ts` | 5 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw7-rows.test.ts` | 13 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw8-args.test.ts` | 13 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/implw9-section-verdict.test.ts` | 12 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/mcp-d4-security.test.ts` | 18 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/mcp-d5-security.test.ts` | 9 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/mcp-d6-marker-name.test.ts` | 9 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/mcp-doc-tools.test.ts` | 29 | 0 | 0 | A10, W1, W2, W5, W11, W13 |
| `mcp/mcp-fig03b-figure-tools.test.ts` | 13 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/mcp-hardening.test.ts` | 26 | 0 | 0 | A9, W1, W2, W5, W11, W13 |
| `mcp/mcp-server.test.ts` | 24 | 0 | 0 | A9, A10, W1, W2, W5, W11, W13 |
| `mcp/mcp-text.test.ts` | 5 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/s12-client-labels.test.ts` | 12 | 0 | 0 | W1, W2, W5, W13 |
| `mcp/secfix-mcp-paths-owner.test.ts` | 7 | 0 | 0 | W1, W2, W4, W5, W13 |
| `registry/c06-coverage-round-params.test.ts` | 22 | 0 | 0 | A2, W1, W5, W13 |
| `registry/dc06-contract-registry.test.ts` | 29 | 0 | 0 | W1, W5, W13 |
| `registry/dc26-chart-custom.test.ts` | 24 | 0 | 0 | W1, W5, W13 |
| `registry/s11-doc-typecode-nda.test.ts` | 4 | 0 | 0 | A2, W1, W5, W13 |
| `render/c18-file-name-form.test.ts` | 5 | 1 | 0 | E1, W1, W5, W13 |
| `render/dc17-final-name.test.ts` | 38 | 0 | 0 | W1, W5, W13 |
| `renderers/asset-bytes.test.ts` | 11 | 0 | 0 | W1, W5, W13 |
| `renderers/browser-chromium.test.ts` | 3 | 4 | 0 | W1, W5, W8, W13 |
| `renderers/c08-c12-wrapper-opt-ins.test.ts` | 23 | 0 | 0 | W1, W5, W13 |
| `renderers/c10-c15-c27-render.test.ts` | 3 | 0 | 0 | W1, W5, W13 |
| `renderers/c12-back-cover-planner.test.ts` | 5 | 0 | 0 | W1, W5, W13 |
| `renderers/c17-rule-index-builder.test.ts` | 18 | 0 | 0 | W1, W5, W13 |
| `renderers/c17-rule-index-render.test.ts` | 9 | 0 | 0 | W1, W5, W13 |
| `renderers/c22-html-preview-parity.test.ts` | 34 | 0 | 0 | W1, W5, W13 |
| `renderers/c22b-html-rail-rhythm.test.ts` | 9 | 0 | 0 | W1, W5, W13 |
| `renderers/c34-classification-line-no-number.test.ts` | 4 | 0 | 0 | W1, W5, W13 |
| `renderers/c34-rule-index-omission-shared.test.ts` | 5 | 0 | 0 | W1, W5, W13 |
| `renderers/c34b-rhythm-min-baseline.test.ts` | 10 | 0 | 0 | W1, W5, W13 |
| `renderers/dc12-contract-record-html.test.ts` | 13 | 0 | 0 | W1, W5, W13 |
| `renderers/dc13-contract-record-docx.test.ts` | 11 | 0 | 0 | W1, W5, W13 |
| `renderers/docx-determinism.test.ts` | 9 | 1 | 0 | S4, W1, W5, W13 |
| `renderers/docx-fonts-embedded.test.ts` | 6 | 3 | 0 | S3, W1, W5, W13 |
| `renderers/docx-sections.test.ts` | 54 | 0 | 0 | W1, W5, W13 |
| `renderers/docx-table-preset-profile.test.ts` | 7 | 0 | 0 | W1, W5, W13 |
| `renderers/docx-xml-escape.test.ts` | 11 | 0 | 0 | W1, W5, W13 |
| `renderers/en-provenance-mark-labels.test.ts` | 6 | 0 | 0 | W1, W5, W13 |
| `renderers/eng01-role-format-fallback.test.ts` | 3 | 3 | 0 | S5, W1, W5, W13 |
| `renderers/engine-c-coverage-round.test.ts` | 31 | 0 | 0 | A6, W1, W5, W13 |
| `renderers/engine-e-coverage-round.test.ts` | 24 | 0 | 0 | W1, W5, W13 |
| `renderers/fix2-wrapper-text-parity.test.ts` | 20 | 0 | 0 | A3, W1, W5, W13 |
| `renderers/fixf-device-placement-parity.test.ts` | 8 | 0 | 0 | W1, W5, W13 |
| `renderers/fixf-spine-text.test.ts` | 2 | 0 | 0 | W1, W5, W13 |
| `renderers/fixh4-rail-toc.test.ts` | 10 | 0 | 0 | W1, W5, W13 |
| `renderers/fixhz2-decorative-d16.test.ts` | 10 | 1 | 0 | E2, W1, W5, W13 |
| `renderers/fixr1-rail-k2.test.ts` | 11 | 0 | 0 | W1, W5, W13 |
| `renderers/fixserah-front-apparatus.test.ts` | 12 | 0 | 0 | W1, W5, W13 |
| `renderers/fixt2-part-lede-k2.test.ts` | 4 | 0 | 0 | W1, W5, W13 |
| `renderers/fixt2-toc-sections.test.ts` | 10 | 0 | 0 | W1, W5, W13 |
| `renderers/fixtl-toc-levels-roles.test.ts` | 15 | 0 | 0 | A2, W1, W5, W13 |
| `renderers/fixtq-rail-legacy.test.ts` | 4 | 0 | 0 | W1, W5, W13 |
| `renderers/fixtq-toc-bookmarks.test.ts` | 5 | 0 | 0 | W1, W5, W13 |
| `renderers/gf08-gf21-rev-a-render.test.ts` | 9 | 0 | 0 | W1, W2, W5, W13, W14 |
| `renderers/gfix-running-head-fit.test.ts` | 16 | 0 | 0 | W1, W5, W13 |
| `renderers/gfix1-classification-caps.test.ts` | 9 | 0 | 0 | A3, W1, W5, W13 |
| `renderers/html-css-csp.test.ts` | 22 | 0 | 0 | W1, W5, W13 |
| `renderers/i39-seal-band-literal.test.ts` | 6 | 0 | 0 | W1, W5, W13 |
| `renderers/implw10-chart-edge.test.ts` | 5 | 0 | 0 | W1, W4, W5, W13 |
| `renderers/implw4-chart-raster.test.ts` | 1 | 1 | 0 | W1, W5, W8, W13 |
| `renderers/implw4-cycle1-engine.test.ts` | 21 | 0 | 0 | W1, W5, W13 |
| `renderers/implw4-source-numbering.test.ts` | 5 | 0 | 0 | W1, W5, W13 |
| `renderers/implw5-chart-gutter.test.ts` | 3 | 1 | 0 | W1, W5, W8, W13 |
| `renderers/implw5-footer-display.test.ts` | 2 | 0 | 0 | W1, W5, W13 |
| `renderers/m1-classification-default-pins.test.ts` | 9 | 0 | 0 | A3, A5, W1, W2, W5, W13 |
| `renderers/rh03-rule-colour-precedence.test.ts` | 6 | 0 | 0 | W1, W5, W13 |
| `renderers/s06-wrapper-text-single-source.test.ts` | 10 | 0 | 0 | A3, W1, W5, W13 |
| `renderers/s13-wrapper-text-en.test.ts` | 19 | 0 | 0 | A3, W1, W5, W13 |
| `renderers/s18-register-language.test.ts` | 3 | 0 | 0 | W1, W5, W13 |
| `security/asset-quota.test.ts` | 2 | 5 | 0 | P1, W1, W5, W13 |
| `security/c35-css-string-controls.test.ts` | 12 | 0 | 0 | W1, W5, W13 |
| `security/c35-file-name-bidi.test.ts` | 3 | 0 | 0 | W1, W5, W13 |
| `security/c35-rule-index-redos.test.ts` | 6 | 0 | 0 | W1, W5, W13 |
| `security/redact-secrets.test.ts` | 16 | 0 | 0 | W1, W5, W13 |
| `seed/c21-derived-preset-seed.test.ts` | 13 | 9 | 0 | P3, W1, W2, W4, W5, W10, W13, W14 |
| `seed/gf08-rev-a-role-formats.test.ts` | 7 | 7 | 0 | P3, W1, W2, W5, W10, W13, W14 |
| `seed/l8-skeleton-labels-text-table.test.ts` | 2 | 0 | 0 | W1, W2, W5, W13, W14 |
| `seed/s09-seed-template-helpers.test.ts` | 15 | 0 | 0 | W1, W2, W5, W13, W14 |
| `seed/s26-doc-type-template-specs.test.ts` | 16 | 0 | 0 | W1, W2, W4, W5, W13, W14 |
| `seed/s27-doc-type-seed.test.ts` | 12 | 0 | 0 | W1, W2, W4, W5, W13, W14 |
| `structure/adapt-v1.test.ts` | 37 | 0 | 0 | W1, W4, W5, W13 |
| `structure/completeness-shared.test.ts` | 69 | 0 | 0 | W1, W5, W13 |
| `structure/completeness.test.ts` | 27 | 0 | 0 | W1, W5, W13 |
| `structure/dc09-contract-rows.test.ts` | 9 | 1 | 0 | P2, W1, W5, W13 |
| `structure/display-field.test.ts` | 167 | 0 | 0 | W1, W5, W13 |
| `structure/error-codes.test.ts` | 52 | 0 | 0 | W1, W5, W13 |
| `structure/fixh2-overwrite-pure.test.ts` | 7 | 0 | 0 | W1, W5, W13 |
| `structure/fixhr2-overwrite-bounded.test.ts` | 0 | 7 | 0 | P2, W1, W5, W13 |
| `structure/fixhr3-d16-rail-authority.test.ts` | 16 | 0 | 0 | W1, W5, W13 |
| `structure/glyph-compose.test.ts` | 13 | 0 | 0 | W1, W5, W13 |
| `structure/params-surface.test.ts` | 66 | 0 | 1 | D1, W1, W5, W13 |
| `structure/pid-identity.test.ts` | 18 | 0 | 0 | W1, W5, W13 |
| `structure/render-field.test.ts` | 13 | 0 | 0 | W1, W5, W13 |
| `structure/skeleton-reconstruction.test.ts` | 13 | 0 | 0 | W1, W4, W5, W13 |
| `structure/slot-rules.test.ts` | 34 | 0 | 0 | W1, W5, W13 |
| `ui-categories/param-categories.test.ts` | 14 | 0 | 1 | A2, D1, W1, W5, W13 |

## Dropped files (112 of 300 test files in the clone)

By reason: Next.js route 58, UI 12, other not vendored 8, datum_conformance 12, Prisma (row 109 cut) 7, soffice 2, CLI not vendored 3, relabel fonts (U9.7/C31) 1, outside tests/unit/studio 8, outside tests/unit/studio (Prisma) 1.

| File (clone) | Reason | Decision |
|---|---|---|
| `tests/unit/studio/api-contract/dc36-auth-401.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api-contract/dc36-dryrun-db.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api-contract/dc36-files-r10-db.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api-contract/dc36-persist-db.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api-contract/dc36-quota-headers.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api-contract/dc36-r14-template-version-db.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api-contract/dc36-retrieval-db.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api-structure/assets.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/auth.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/dryrun.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/fixc1-contract-order.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/fixf-completeness-filler-label.test.ts` | UI page/component of a dropped surface (document-viewer/completeness-tab.tsx) | spec §8.1, U9.9 |
| `tests/unit/studio/api-structure/fixf-filler-format.test.ts` | UI page/component of a dropped surface (shared/labels.ts) | spec §8.1, U9.9 |
| `tests/unit/studio/api-structure/fixh2-overwrite.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/fixhr2-render-order.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/fixs3-content-roundtrip.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/multipart.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/pid.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/rate.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/submit.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/templates.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api-structure/trust.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c; also Prisma (row 109 cut) | spec §1.3; row 109 |
| `tests/unit/studio/api/artifacts.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/auth.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/client-log.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dc15-contracts-route.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dc16-search-route.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dc18-files-final-name.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dc19-quota.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dc20-render-final-name.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dc23-drafts-check-route.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dc28-registry-contracts.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dcwire-wire.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dcwire2-final-file-name.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/dcwire2-ingest-persist.test.ts` | Prisma (row 109 cut): drives ingest through a Prisma fake (`vi.mock('@/lib/prisma')`, api/_prisma.ts) and asserts its call log; Swarm's ingest repository is the row 109 twin over StudioStore | row 109 |
| `tests/unit/studio/api/dcwire3-ingest-contract-rows.test.ts` | Prisma (row 109 cut): same Prisma fake and call-log assertions as dcwire2 | row 109 |
| `tests/unit/studio/api/fig03b-figure-preview.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixc2-agent-id.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixcli-messages.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixh1-render-preflight.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixh6-route-not-found.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixhr2-route-not-found.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixhz1-render-order.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixqa-bucket-rate.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixqa-route-quota.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixqb-r08-contract-warnings.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixsec-agent-quota.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixsec-drafts-charge.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/fixsec-query-read.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/http-errors.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/ingest.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/r2fix-drafts-charge.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/r2reg-contract-examples.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/revisions.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/secfix-figure-preview.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/secfix2-artifact-create.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/api/secfix2-artifact-render.test.ts` | Prisma (row 109 cut): mocks `services/render/db` with a Prisma client (`studioArtifact.findUnique`); `render/artifact.ts` is a Swarm twin over the store (rows 109/31c); the mock of `render/job` would also stay installed process-wide in bun | row 109, row 31c |
| `tests/unit/studio/api/templates.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/contract/dc35-golden-md2contract.test.ts` | spawns the CLI `scripts/studio/md2contract.ts` (not vendored) on documents outside the repo (`C:/Users/TRIAL/...`; the original skipped when absent) | spec §1.1 |
| `tests/unit/studio/contract/secfix-chart-maxitems.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/contract/secfix2-figure-bounds.test.ts` | UI page/component of a dropped surface (artifact-gallery/spec-templates.ts, template-preview/sample-document.ts) | spec §8.1, U9.9 |
| `tests/unit/studio/contract/secfix3-figure-text.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/contracts/fixqb-contract-issues.test.ts` | subject not in the vendored file set (vendor/provenance.json): `src/lib/studio/services/query/filters.ts` | spec §1.1 |
| `tests/unit/studio/datum-conformance/docx-reader.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/fonts.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/inputs.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/language.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/layout.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/pair-register-vs-seed.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/report-cli.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/rule-index.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/scoring.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/structure-a.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/structure-b.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/datum-conformance/xml.test.ts` | subject `benchmark/datum_conformance/**` (offline scorer) is not in the vendored file set; Swarm scores with its own judge (rows 13, 91) | spec §1.1 |
| `tests/unit/studio/docx-fonts-alias.test.ts` | both cases assert the relabelled alias faces (`renameFontFamily`, `RELABEL_ALIAS_FACES`); the row 108 relabel twin builds none | U9.7, C31, row 108 |
| `tests/unit/studio/fix1/fix1.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/import/fixcli-md2chapter.test.ts` | subject not in the vendored file set (vendor/provenance.json): `src/lib/studio/services/import/index.ts` | spec §1.1 |
| `tests/unit/studio/import/fixcli2-md2contract-dropped.test.ts` | every case spawns the CLI `scripts/studio/md2contract.ts`, which is not in the vendored file set | spec §1.1 |
| `tests/unit/studio/import/fixhr1-limits-role.test.ts` | subject not in the vendored file set (vendor/provenance.json): `src/lib/studio/services/import/index.ts` | spec §1.1 |
| `tests/unit/studio/import/fixhr1-perf.test.ts` | subject not in the vendored file set (vendor/provenance.json): `src/lib/studio/services/import/index.ts` | spec §1.1 |
| `tests/unit/studio/import/fixhr1-route.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/import/fixtq-md2chapter-messages.test.ts` | every case spawns the CLI `scripts/studio/md2chapter.ts`, which is not in the vendored file set | spec §1.1 |
| `tests/unit/studio/import/md-v1.test.ts` | subject not in the vendored file set (vendor/provenance.json): `src/lib/studio/services/import/index.ts` | spec §1.1 |
| `tests/unit/studio/ingest/dc08-contract-gate.test.ts` | Prisma (row 109 cut): same Prisma fake (api/_prisma.ts), asserts dbWrites/callsOf | row 109 |
| `tests/unit/studio/query/dc14-filters.test.ts` | subject not in the vendored file set (vendor/provenance.json): `src/lib/studio/services/query/index.ts` | spec §1.1 |
| `tests/unit/studio/query/fixqb-docnumber-safe-sql.test.ts` | Prisma (row 109 cut): imports `@/lib/prisma` | row 109 |
| `tests/unit/studio/query/fixsec-archived.test.ts` | Prisma (row 109 cut): imports `@/lib/prisma` | row 109 |
| `tests/unit/studio/renderers/soffice-render-env.test.ts` | subject `engine/soffice/**` is excluded; the barrel is the row 108 twin (no `safeBaseName`, no LibreOffice); the cases run reg.exe/HKCU on Windows | spec §1.1, row 108 (G3 NO-GO) |
| `tests/unit/studio/security/log-retention.test.ts` | subject not in the vendored file set (vendor/provenance.json): `src/lib/studio/engine/soffice/log.ts` | spec §1.1 (soffice excluded), row 108 |
| `tests/unit/studio/security/safe-next.test.ts` | subject not in the vendored file set (vendor/provenance.json): `src/app/login/safe-next.ts` | spec §1.1 |
| `tests/unit/studio/security/secret-compare.test.ts` | subject not in the vendored file set (vendor/provenance.json): `src/lib/require-session.ts`, `src/middleware.ts` | spec §1.1 |
| `tests/unit/studio/seed/dc29-ch06-template-save.test.ts` | Prisma (row 109 cut): every case drives `createTemplateV2InTx` with a Prisma tx fake; Swarm's `services/templates` write path is the row 66 TemplateSource twin behind the row 67 guard (FORBIDDEN without it) | row 109, rows 66/67 |
| `tests/unit/studio/structure/fixs3-submission-shape.test.ts` | Next.js route of a dropped surface: `src/app/api/studio/**` is not copied (spec §1.3); the handlers are ported into LocalStudioApi and tested by rows 31/31b/31c | spec §1.3 |
| `tests/unit/studio/template-preview/en-preview-sample.test.ts` | UI page/component of a dropped surface (template-preview/sample-document.ts) | spec §8.1, U9.9 |
| `tests/unit/studio/ui-categories/param-editor-categories.test.ts` | UI page/component of a dropped surface (template-editor/param-editor.tsx) | spec §8.1, U9.9 |
| `tests/unit/studio/ui-categories/param-editor-layout.test.ts` | UI page/component of a dropped surface (template-editor/param-editor-state.ts, template-editor/param-editor.tsx) | spec §8.1, U9.9 |
| `tests/unit/studio/ui-categories/preview-param-groups.test.ts` | UI page/component of a dropped surface (template-preview/index.tsx, template-preview/param-groups.tsx) | spec §8.1, U9.9 |
| `tests/unit/studio/ui-categories/preview-param-tools-categories.test.ts` | UI page/component of a dropped surface (template-preview/index.tsx, template-preview/param-tools.ts) | spec §8.1, U9.9 |
| `tests/unit/studio/ui-categories/ux-simplification.test.ts` | UI page/component of a dropped surface (template-preview/param-tools.ts) | spec §8.1, U9.9 |
| `tests/unit/studio/ui02/ui02-config-labels.test.ts` | UI page/component of a dropped surface (shared/completeness-text.ts, template-editor/model.ts, template-editor/role-format-labels.ts, template-preview/preview-html.ts) | spec §8.1, U9.9 |
| `tests/unit/studio/ui02/ui02-history-and-names.test.ts` | UI page/component of a dropped surface (document-viewer/doc-model.ts, shared/labels.ts, template-editor/model.ts) | spec §8.1, U9.9 |
| `tests/unit/studio/ui04/ui04-text-fixes.test.ts` | UI page/component of a dropped surface (shared/completeness-rail.tsx, shared/labels.ts, template-editor/model.ts, template-editor/values.ts) | spec §8.1, U9.9 |
| `tests/information-library.test.ts` | HQ information library, not Studio | spec §1.1 |
| `tests/integration/studio/studio-db.integration.test.ts` | Prisma (row 109 cut): needs a live Postgres database | row 109 |
| `tests/smoke/anonymous-401.test.ts` | HQ HTTPS smoke probe of the live HQ (network), not Studio code | spec §1.1 |
| `tests/smoke/login-contract.test.ts` | HQ login smoke probe (network), not Studio code | spec §1.1 |
| `tests/unit/agent-roster.test.ts` | HQ agent roster, not Studio | spec §1.1 |
| `tests/unit/garden-public.test.ts` | HQ garden pages, not Studio | spec §1.1 |
| `tests/unit/middleware-devbypass.test.ts` | HQ Next.js middleware, not Studio | spec §1.1 |
| `tests/unit/reject-reason-route.test.ts` | HQ Next.js route, not Studio | spec §1.1 |
| `tests/unit/require-session.test.ts` | HQ session helper (`src/lib/require-session.ts`), not Studio | spec §1.1 |
