---
task_id: 2026-11-06_swarm_1_2_0_datum_installer
task_slug: swarm_1_2_0_datum_installer
date: 2026-11-06
agent: task-architect
tiering: not set in 01_translated.md (field absent; model_tier: default) - controller applies the per-row models below
status: refined (row 20 pass 2, under U16-U18)
approval: no HIL stop. Classification MAJOR (reason below); the decisions behind it (U16, U17, U18) are already the user's, and U14 (full autonomy) applies. Row 21 records the outcome as C19.
---

# Structured Task: Swarm 1.2.0 with DATUM built in (Studio engine to Manual Rev A, Rev A Python XLSX/PPTX), full dmg installer

## Row status note (read first)

- **Done:** rows 1-19, 63 and 65 (artifacts exist and were accepted in C2-C15, C17). Row 20 is done by this pass.
- **Dropped:** rows 38, 39, 40 and 41. They existed only to fix Studio against Claude's v1.7 lint (U8, F18-1). Under U16 Studio's engine is the standard, so there is nothing to fix toward v1.7. Rows 48, 49 and 67 no longer depend on row 41.
- **Re-planned:** rows 21-37, 42-62, 64, 66-71 (text and dependencies changed where marked in the table).
- **New:** rows 72-116.
- **Frozen as history, not a gate:** the row 14 v1.7 references (`test/claude_reference/`), the row 13 judge and the row 18 scores. Under U18 they are no longer the pass criterion.

## Architecture Challenge & Refinement

**Intent.** Swarm 1.2.0 ships DATUM inside the app for every user (U2). The standard is the GSP Writing Manual Rev A (U16): the ID edition (98 pp, 2 Nov 2026) and the EN edition (99 pp, 3 Nov 2026), copied with sha256 to `research/manual_rev_a/`. DATUM Studio from gsp-datacenter v2.1 is made to run locally and renders DOCX, HTML, SVG and PNG with its own engine. Its PDF is printed from its HTML through Electron Chromium `printToPDF` (U16, C4). Studio is hosted only inside Swarm, and Claude reaches it through the stdio bridge (U13). XLSX and PPTX stay on the bundled Python builders and are brought to Rev A in 1.2.0 (U17). The release is a full dmg with SwarmRelease 1.2.0 and CFBundleShortVersionString 1.2.0 (U3, U4).

**Studio goal (U7, binding).** The goal is standardised, maintainable documents, and Claude can use the same Studio too. There is one template set, one store with revisions and search, template tools (U10) and preview in the existing file tabs (U12).

**Control (U18, replaces U8 and U1's judge).**
1. **B-O.** The bundled Studio output is compared with the original Studio (gsp-datacenter v2.1, run from the row 17 scratch copy) on the same Rev A material. The pass rule is ≥ 0.9000 per file with the existing similarity script, and the target is identical.
2. **RS.** Studio's own Rev A conformance scorer (`benchmark/datum_conformance`, EXISTS in the clone) runs on both sides.
3. **MJ.** The controller judges samples directly against the manual chapters, with page citations.
4. **CL-U.** Claude's v1.7 lint is used only for the rules that Rev A did not change (map in row 77).
5. **XLSX/PPTX.** There is no Studio original, so these are judged by MJ against the workbook and briefing chapters, plus CL-U.

**Scale category.** Enhancement plus Release. The release tail reuses the 1.1.4 recipe `docs/2026-11-06_swarm_1_1_4_patch/implementation/08e_build_1_1_4_029c07829a.zsh` and the isolated UI check `docs/2026-11-06_swarm_1_1_4_patch/verification/11_ui_home.md` (both verified with Glob in this pass).

### Classification: MAJOR

Reasons:
- Rendering ownership flips back from C16 (Python for everything) to the Studio engine (U16).
- The control changes from v1.7 references to bundled-vs-original Studio plus the manual (U18).
- Four rows drop.
- 45 rows are added, including a new material set, a new reference production and two builder rewrites (U17).

There is no second approval stop: every structural choice is the user's own (U16-U18), U14 grants full autonomy, and the controller records the outcome at row 21. The safe defaults taken under U14 are listed in "Decisions taken under U14".

### Evidence checked in this pass (Glob, Grep, Read)

- **Original Studio scratch (U18 reference side).** These files exist under `/private/tmp/claude-501/row17/`:
  - `studio/scripts/parity/run/render_cli.ts`
  - `stub/preload.ts`, the Prisma/next-auth/lucide stub accepted in C12
  - `runV.zsh`
  - `runtime.ts.orig` (the C14 patch is applied in the scratch copy)
  - `studio/src/lib/studio/assets/fonts/renamed/` with 10 modified Plex files

  Row 17 §8.3 (`research/10_studio_parity_outputs.md:116-126`) shows exit 0 for 01, 04 and 05 on the diagnostic variants.
- **Rev A conformance scorer** at `/private/tmp/claude-501/gspdc/src/benchmark/datum_conformance/`, with `score.ts`, `lib/{cli,docx,score,report,pairs,layout,xml,clash,coverage}.ts` and `rules/*.ts`.
  - External imports are only `fflate` and `node:` modules.
  - `baseline/render_id_samples.ts:43` imports `spawnSync`.
  - It is outside row 11's closure, so row 90 reviews it before anything runs.
  - It scores DOCX only (Grep for pdf, xlsx and pptx in `score.ts` found nothing).
- **Studio lint** (the product guard under U16): `C/src/lib/studio/services/render/lint.ts` over `engine/lint/{structure,scan}/` (Grep).
- **Clone twin targets exist** (C = `/private/tmp/claude-501/gspdc/src`):
  - `src/lib/studio/contract/{env,auth,ui}.ts`
  - `engine/browser/runtime.ts`, `engine/soffice/index.ts`, `engine/docx/fonts/relabel.ts`, `engine/docx/package/parts.ts`
  - `services/render/pure/render.ts`, `services/templates/{assets,import}.ts`
  - `scripts/studio/_repo-alias.ts`, `scripts/studio/mcp/config.ts`
  - `prisma/seed-studio-templates.ts`
- **Swarm repo paths exist** (R = `~/Swarm_OnDevice/swarm`):
  - `packages/desktop/{electron-builder.config.ts, electron-builder.config.test.ts, electron.vite.config.ts, package.json, .gitignore}`
  - `packages/desktop/scripts/{stage-library.ts, stage-cli.ts, stage-setup.ts, check-cli-stage.ts, prebuild.ts}`
  - `packages/desktop/src/main/{index.ts, server.ts, cli-install.ts, onboarding.ts, updater.ts, patch-common.ts}`
  - `packages/opencode/src/skill/index.ts`, `packages/opencode/src/session/installed-tools.ts`, `packages/core/src/config/mcp.ts`
  - `bun.lock`
- **Not yet in the repo:** `packages/datum-studio/` and `packages/desktop/datum/` do not exist (Glob), which confirms that rows 22 and 27 have not run.

### U16 re-resolution of row 19 (`gateway_check/01_spec_reconciliation.md`)

Row 19 assumed C16. Under U16 its basis line ("C16 decides this file") is void. Each item is re-resolved below. Row 81 confirms this table against the amendments. Where this table and row 19 disagree, this table governs.

| Row 19 item | Under C16 | Under U16 (binding for rows 22+) | Owner |
|---|---|---|---|
| N1-N14, N17-N18 | names | **Stand** unchanged | as row 19 |
| N15 | "adapter" name clash | Moot: no adapter. Row 29 is still called the "platform layer" | 29 |
| N16 | L1-A | **Dropped**. U18 levels B-O, RS, MJ, CL-U, T apply (row 78) | 78 |
| §1.2 adapter names (`studio_to_datum.py`, `provenance.json` of the adapter, `adapterSkillSha`, `ContractRenderer`, reason `unmapped`) | new | **Dropped**. Row 72 marks them dropped | 72 |
| K1-K6, K19, K21 | runtime and packaging | **Stand** (no .pyc, osx-sign pass, lxml thinned, union prune, no matplotlib, descriptor file). Row 81 correction: K6 the host has no `datum-python` children (R11); K21 owner is row 110 (builtin export, slug diff 16 vs 18), not 29 | 23, 45, 47, 110 |
| K7 file set | engine excluded | **Reverts to studio spec §1.1**: the 524-file union incl. engine closure A, minus `engine/soffice/*` (replaced by a twin), `contract/auth.ts` (twin) and the parity CLI. The §1.3 twins and patches are back: `browser/runtime.ts` over the bridge, `soffice/index.ts` readiness, `relabel.ts` with no relabelled faces, the PDF-move patch of `render.ts`. NEW-2 is dropped. Row 81 correction: `contract/auth.ts` is not in the 524-file union; the 10 excluded files are 3 parity CLI + 7 `engine/soffice/*`, ship set 514; the auth twin is a NEW file of row 29; engine code in `app.asar` (SZ-4), assets and the two run-time vendor files in `Res/datum-studio/`; `REPO_ROOT` twin to `Res/datum-studio/` (row 29) | 27, 29, 107, 108, 109 |
| K8 PDF, figures, HTML | Python and sheet-only HTML | **Reverts to studio spec §4**: SVG→PNG via the bridge `png` op; `measureLayout` via `checkPage` with Studio's `MEASURE_SCRIPT` (FR3 restored); PDF = `printToPDF` of Studio's own HTML. Formats are those of Studio (docx, html, pdf, svg, png). There is no DOCX→PDF and no soffice | 24, 32, 108 |
| K9 render tools | through the adapter | **Studio engine** (`renderSnapshot`). `revision.lint_report` comes from Studio's lint (`services/render/lint.ts`). Tool names and schemas follow studio spec §5 | 31 |
| K10 template guard | adapter + Claude lint | **Studio engine render + Studio lint (Rev A)** on candidate and reference; a newly failing check rejects. Claude's lint leaves the product guard (row 79 amends templates spec §5.2-5.4). Row 81 correction: owners 67 + 66 (U.1a lint-param key print) + 45 (build-time guard); G-U2 resolved: row 45 runs the builtin guard through the repo's Electron, never playwright or a system Chrome; if not feasible at build, row 45 records it and row 55 runs `studio_template_check` over every builtin in the built app, any reject = row 55 FAIL | 79, 67, 66, 45 |
| K11 param mapping | unmapped = locked | Moot. Editable = form lock P1-P9 (incl. C13 H1 P9) only. Case 06 `cover.title.sizePt` is traced to `formats.ts:167`, which ships again. Row 81 correction: P is not `cover.title.sizePt` (C25, R6); rest stands | 79, 66 |
| K12 H2 escape | moot | **Stands again**: the XML-escape patch at `engine/docx/package/parts.ts:173` is in the patch list | 107 |
| K13 F-S1..F-S3 | relax to Claude | **Correct Rev A rules, kept.** The Rev A material satisfies them (legend key rows, `result()` rows, filled controlSheet) | 82, 83, 84 |
| K14 re-render sha | L1 after normalisation | Row 43 asserts DOCX sha equality. If Studio writes a per-run field, the test asserts L1 = 1.0000 after equivalence §5.1 normalisation and quotes the field. Row 24 keeps the 20-raster byte-equality proof | 24, 43 |
| K15 preview | companion PDF only | **Studio spec §8.2 stands** (P1-P8, original hint text) | 112 |
| K16 packaging sizes | Studio assets not shipped | **Studio assets ship**: `default.docx`, the 16 standard Plex, DejaVu, Inter, the logos and the licence texts; no `fonts/renamed/` (U9.7). Row 80 resets SZ-3 | 80, 36, 47 |
| K17 levels | L1-A | U18 levels (row 78). The v1.7 references are history | 78 |
| K18 row wording | - | Stands, except: row 42 includes engine tests; row 55 renders DOCX, HTML, SVG, PNG and PDF; row 49 checks divergence between Studio's Rev A tokens and the Python builders' tokens | 42, 49, 55 |
| K20 guard vs judge | - | The guard is product (Studio lint). The judge is the controller (U18) | 67, 56 |
| F18-1..F18-4 | - | F18-1 is not a finding under U16. F18-2 (Studio SVG fails v1.7 checks 25 and 30) goes to row 77, which classifies 25 and 30 as changed or unchanged. F18-3 → material rows 82-84. F18-4 is history. Row 81 correction: F18-2 is classified (C23); owner moves from 77 to 108 | 77, 82-84, 108 |
| Row 11 / row 65 findings moved by C16 | moot | **Back to their engine targets**: M3 (`engine/docx/blocks/media.ts:112`, `engine/html/blocks/device.ts`), M4 (`engine/docx/wrapper/media.ts` cwd) and H2 → row 107. M6 (bridge safety) → 24. M1, M2 → 31. M5 → 29, 31. M7 → 31, 34, 48. Row 81 correction: M4 also names `engine/docx/fonts/catalog.ts:80` and `services/ingest/assets.ts:134`; route M4: row 111 forks the host with cwd = `Res/datum-studio/` (read-only, sealed) and tests it; row 107 patches `engine/docx/wrapper/media.ts` as listed | 107, 24, 29, 31, 34, 48, 111 |

### Python path in 1.2.0 (after U16 and U17)

- **What the bundled runtime runs:** the Rev A XLSX builder (`datum_xlsx.py`), the Rev A PPTX builder (`datum_pptx.py`), their figure helpers through the render shim, and the bundled `datum_lint.py` with the workbook and briefing checks aligned to Rev A (row 102).
- **Edits happen in the bundled copy only:** `packages/desktop/datum/datum-house-style/`, created by row 22. Claude's own folder is never edited (hard constraint).
- **Every divergence from the row 4 hashes is recorded.** Row 103 lists it in the copy provenance and in `skillSha`.
- **Routing for the Swarm model.** Row 25 makes the built-in skill body route DOCX, HTML, SVG and PDF to the datum-studio tools, and XLSX and PPTX to the Python builders. The v1.7 DOCX helpers remain in the copy (nothing is deleted), but the body tells the model not to use them for documents.

### Decisions taken under U14 (safe defaults; row 21 records them as C19)

| # | Question | Default taken | Why |
|---|---|---|---|
| D-A | Fonts of the original-Studio reference | Render with `fonts/renamed/` moved aside **in the scratch copy only**, so both sides use the same 16 standard Plex (U9.7). One extra information-only run with them present is recorded | Without this, B-O measures U9.7 instead of the port. HYPOTHESIS until rows 93-95 show it: the relabelled faces change the DOCX font tables |
| D-B | Product template guard | Studio's engine lint (Rev A), not Claude's lint | Rev A is the standard (U16); Claude's lint is v1.7 |
| D-C | Built-in skill body routing | DOCX, HTML, SVG and PDF → Studio tools; XLSX and PPTX → Rev A Python builders | One standard per format |
| D-D | Plex duplicated in skill and Studio assets | Accept in 1.2.0 (a few MB, inside the +350 MB cap). Dedupe later | Simplicity; row 80 measures it |
| D-E | Case 06 original side | Render the source template with the original if its slug resolves offline. Otherwise record UNKNOWN and judge T plus RS only | The original's template editor needs Postgres |
| D-F | HTML and PNG pairs in B-O | Reported as information (normalised diff, dimensions, pixel-diff), not scored. HTML is judged through its PDF | `test/judge/` has no HTML or PNG feature extractor (Glob: `feat_{docx,xlsx,svg,pdf,pptx}.py`) |

### Challenge

- **Identical is a target, not the pass rule.** The original renders through playwright Chromium 1234 with `--disable-gpu`, while the bundle renders through Electron 42's Chromium via the bridge. PNG bytes will differ, and the DOCX embeds those PNGs. The pass rule is ≥ 0.9000 per file, with no averaging. Row 56 reports the identical flag per file.
- **Where divergence can enter.** The engine files are copied verbatim (sha checked by row 27). Divergence can enter only through the twins and patches (rows 29, 107, 108, 109, 32). Row 42 runs the original engine tests on the copy, so engine logic errors surface before the build. The built-app B-O at row 56 is the gate.
- **Circularity.** The controller writes the U18 amendment, the material, the references and the manual judgments. Mitigations:
  - the scorer is Studio's own code, not written by the controller;
  - the similarity weights are unchanged from equivalence spec §5;
  - the material is frozen (row 89) before the references, and the references (row 97) before any bundled output;
  - the original deviations from Rev A are judged as a baseline (row 98) before the bundled outputs (row 113).
- **Assumptions.** The repo is built on swarm/main 029c07829a. Studio's DOCX may carry a per-run field (K14 fallback). The scorer runs under bun with only `fflate` (to be proven by row 91).

### Hard constraints (all rows, unchanged)

- Never touch `~/.swarm-patch-key/`.
- No `git push`, including the gsp-datacenter clone. Never open a PR there.
- Read-only sources are the clone `/private/tmp/claude-501/gspdc/src`, Claude's DATUM folder, the manual PDFs and the user's library folders. Copy from them; never modify them. The row 17 scratch copy is the only place where the C14 patch and the D-A font move may exist.
- No clone code runs before it has been reviewed: row 11 for the Studio closure, row 65 for the template files, row 90 for the scorer.
- Tests never touch the real `~/.swarm`, `~/.config/swarm`, `~/.local/share/swarm`, a running Swarm, or `~/.claude` config files. They use a fixture HOME and XDG under `/private/tmp/claude-501`, `HTTP_PROXY=HTTPS_PROXY=http://127.0.0.1:9` and `NO_PROXY=127.0.0.1,localhost`. U15 allows the one read of the thinker key for row 58 only.
- Never `/usr/bin/open` in tests.
- Package installs go only into build-local folders. One lockfile writer at a time.
- A model is called only in row 58, with synthetic material. The key is never printed, logged or committed.
- One build at a time (`tools/build/.candidate_build.lock`). The repo is not edited during a build.
- Tests and `bun typecheck` run only from package directories.
- The permission suite keeps exactly the 66 baseline failures, compared by name.
- The old `/Applications/Swarm.app` goes to the Trash and is never hard-deleted (U9.10, U14).

**Review stop rule (memory `swarm_1_1_1_release.md`).** Rows 48-49 block only on open High or Medium findings.

## Structured Task Breakdown

| Step | Task Description | Agent_to_Invoke | Expected Output | Depends On | Verification | Phase |
|------|------------------|-----------------|-----------------|------------|--------------|-------|
| 1 | Write the names-and-constants register every later row uses verbatim: resource folders, built-in skill name, MCP server id, launcher path name, tool names, store file name, environment variable names, release numbers (Tier 3) | data-analyst | masterplan/00_names_register.md | - | Each name once with meaning; SwarmRelease and CFBundleShortVersionString 1.2.0 | masterplan |
| 2 | Inventory the static import closure of the Studio engine and the MCP tool layer from the clone as text, without running clone code, listing files, packages, transitive Prisma or Next imports (Tier 3) | coder-execution | research/04_studio_import_closure.md | - | File list with counts; each Prisma or next import with file:line; parser script in the scratchpad | research |
| 3 | Collect licence and redistribution facts for Studio fonts, renamed IBM Plex files, GSP logos and the repo, including OFL Reserved Font Name terms (Tier 2) | data-collector | research/05_licence_facts.md | - | Each asset has a licence text path or UNKNOWN; D-317 quoted; no rights conclusion stated as fact | research |
| 4 | Inventory Claude's DATUM skill: imports per script, external binaries, SVG and PDF renderer, font lookup, tokens.json path, references/ rules, Claude-only references (Tier 2) | explore | research/06_datum_skill_inventory.md | - | 66 files with sha256; imports with file:line; PDF renderer named or UNKNOWN | research |
| 5 | Record current packaging facts: signing and entitlements, staging hooks, extraResources slots, how the swarm CLI launcher is installed, 1.1.4 dmg and app sizes (Tier 2) | explore | research/07_packaging_facts.md | - | Sizes from du and ls quoted; each claim with file:line | research |
| 6 | Analyse the 1.19.3 to 1.2.0 version change across updater.ts, swarm-patch semver checks, patch-common bundle_version, onboarding, migrate.ts, recipe gate :200, test pin :502 (Tier 1) | data-analyst | research/08_version_check.md | - | One verdict per site with file:line; every needed change listed as its own item; downgrade risk stated | research |
| 7 | Write the Studio spec for one shared server: file set, Prisma cut, macOS replacements for Windows gates, server runtime under the runAsNode-off fuse, PDF path when Claude launches it, the kept tools of the 24, one template set, SDK version, UI pages out of scope (Tier 1) | data-analyst | masterplan/01_specs_studio.md | 1, 2 | Each kept or dropped tool has a reason; runtime and PDF choices each with two rejected alternatives; viewer need answered yes or no with evidence | masterplan |
| 8 | Write the store spec: kept Studio models, SQLite schema in Swarm's existing style, WAL with BEGIN IMMEDIATE and busy timeout for two processes, FTS5 availability, D-06 revisions, data folder location, backup as folder copy (Tier 1) | data-analyst | masterplan/01_specs_studio_store.md | 1, 2, 7 | Model table keep or drop with reason; FTS5 and WAL proven by a probe command with output; get, search, contracts_query mapped to queries | masterplan |
| 9 | Write the runtime and built-in skill spec: relocatable signed Python, pinned wheels, SVG renderer, IBM Plex without system install, skill registration with path placeholders, the Swarm note for Claude-only references (Tier 1) | data-analyst | masterplan/01_specs_runtime.md | 1, 4 | One choice per concern with alternatives; versions pinned or marked for row 15; reference folder untouched | masterplan |
| 10 | Write the equivalence and control spec: control is Claude's current DATUM skill; judge is its datum_lint.py 38 checks plus its references/ rules on both sides plus L1 and L2 similarity at 90 %; frozen reference with hashes; material list per format; separate reference environment; single model-run protocol (Tier 1) | data-analyst | masterplan/01_specs_equivalence.md | 1, 4 | Metric computable from files alone; each format has a case; Studio lint explicitly not the judge; circular parts named | masterplan |
| 11 | Security-review the row 7 Studio closure as code text before anything from it runs: process spawn, file writes, network, eval, install scripts of its packages (Tier 1) | security-review | verification/03_studio_prereview.md | 7, 8 | Findings table with severity; go or no-go per file group; zero open High before row 17 | verification |
| 12 | Write the synthetic test material per the equivalence spec, with no repo content and no private data (Tier 3) | coder-execution | test/00_material.md | 10 | Manifest lists every file under test/material with sha256; each spec case has an input | test |
| 13 | Write the judge script per the spec: similarity per file plus a wrapper that runs the frozen copy of Claude's datum_lint.py, with a self-test on identical and known-different pairs | coder-execution | test/01_judge_script.md | 10 | Self-test 100 % on identical and below 90 % on the different pair, output quoted; lint wrapper calls only the frozen copy | test |
| 14 | CONTROL: produce Claude's reference outputs from the material with Claude's current DATUM skill in the controller's own environment, then freeze them with hashes before any Swarm or Studio output exists | master-controller | gateway_check/02_reference_freeze.md | 10, 12 | Every case has a reference file with sha256 and Claude lint output; environment versions recorded; freeze time earlier than rows 15 and 17 | gateway_check |
| 15 | Probe the runtime: build-local Python with the row 9 wheels in a NEW folder under tools/build, run every DATUM tool from a copy of the skill on its samples with python -I and a fixture HOME, measure sizes per component (Tier 2) | coder-execution | research/09_runtime_probe.md | 9, 14 | Each of 12 tools has exit code and output quoted; du per component; host python not on PATH | research |
| 16 | Write the packaging spec: size budget from row 15, ad-hoc signing of nested binaries under hardened runtime, stage hooks, the launcher install, what notarisation would need (Tier 1) | data-analyst | masterplan/01_specs_packaging.md | 5, 7, 15 | Budget measured or labelled estimate; signing order matches electron-builder.config.ts:156-190 | masterplan |
| 17 | Produce Studio parity outputs: run the reviewed closure from a scratch copy on the material, render DOCX, HTML, SVG | coder-execution | research/10_studio_parity_outputs.md | 11, 14 | Each material case has an output with sha256; clone git status clean | research |
| 18 | CONTROL: judge the row 17 outputs against the frozen references with the row 13 script and Claude's lint, listing every failing check as a finding | master-controller | gateway_check/03_judge_parity.md | 13, 17 | Score per file and format quoted; lint verdict per check side by side; each failure is a numbered finding | gateway_check |
| 19 | Reconcile specs 7-10 and 16 with the names register and the row 18 findings; list every disagreement with its fix owner | verifier | gateway_check/01_spec_reconciliation.md | 6, 7, 8, 9, 10, 16, 18 | Zero unresolved name mismatches; every conflict or finding routed to a named row | gateway_check |
| 20 | Refine this blueprint from rows 1-19 under U16-U18 (DONE in this pass) | task-architect | identification/02_structured.md | 19 | Every implementation row traces to a spec section, a U-decision or a finding; no L row; classification MAJOR with reason | masterplan |
| 21 | Record U16-U18 and the U14 defaults D-A to D-F as decision C19 (row 21 gate outcome, MAJOR accepted, C16 superseded, rows 38-41 dropped) with no HIL stop | master-controller | decisions/decisions.md | 20 | C19 cites U16, U17, U18 and this blueprint; D-A to D-F listed; no user question asked | gateway_check |
| 22 | Copy Claude's DATUM skill byte-identical into packages/desktop/datum/datum-house-style/ as the base of the bundled copy | coder-execution | implementation/01_datum_skill_copy.md | 21 | sha256 of every file equals row 4; source folder unchanged | implementation |
| 23 | Write the runtime stage script per the runtime spec with row 19 K1, K3, K4, K5 applied, installing the row 106 shim as a local dist | coder-execution | implementation/02_runtime_stage.md | 15, 16, 21, 106 | Two runs give the same sha manifest; every library imports under datum-python; no matplotlib and no .pyc in the stage | implementation |
| 24 | Implement the main-process render bridge with ops png, pdf with html src and preferCSSPageSize, checkPage running Studio's MEASURE_SCRIPT, on a hidden sandboxed window per runtime spec 3.2 and studio spec 4 | coder-execution | implementation/03_render_bridge.md | 7, 9, 21 | Unit test renders one SVG to PNG and one HTML to PDF over the socket with the token; 20 rasters of one SVG byte-equal; window has sandbox true, JS off, network blocked | implementation |
| 25 | Register datum-house-style as a built-in skill whose Swarm body routes documents to the datum-studio tools per D-C, with a unit test | coder-execution | implementation/04_skill_builtin.md | 9, 22, 72 | bun typecheck in packages/opencode exits 0; test finds the skill under a fixture resource path; body names the register tool ids and the D-C routing | implementation |
| 26 | Apply the version-guard changes listed in row 6, or record with evidence that none is needed | coder-execution | implementation/05_version_guard.md | 6, 21 | Each row 6 item closed with a diff or evidence; targeted desktop tests pass | implementation |
| 27 | Copy the studio spec 1.1 file set (engine closure A included, fonts/renamed excluded) verbatim into packages/datum-studio/vendor/ with provenance.json of commit b0ae7a7 | coder-execution | implementation/06_studio_copy.md | 11, 21 | sha256 per file equals the clone; no file from fonts/renamed; clone git status clean | implementation |
| 28 | Add the Studio package manifest with pinned dependencies (ajv 8.20.0, fflate 0.8.3, MCP SDK 1.29.0) installed under the lockfile lock | coder-execution | implementation/07_studio_deps.md | 27 | bun install exits 0; lockfile diff limited to the new package; fflate advisory scan quoted | implementation |
| 29 | Write the Studio platform layer: env.ts macOS replacements A-J of studio spec 2 plus the twins of contract/auth.ts, contract/ui.ts, _repo-alias.ts and the config.ts patch | coder-execution | implementation/08_studio_platform.md | 28, 107 | bun typecheck of the touched files exits 0; Grep finds no next, next-auth or lucide-react import; a relative STUDIO_WORKSPACE_ROOT is refused in a test | implementation |
| 30 | Implement the store per the store spec: WAL, BEGIN IMMEDIATE with busy timeout, FTS5 required, D-06 revisions, content-addressed outputs, the bun:sqlite/node:sqlite driver seam | coder-execution | implementation/09_studio_store.md | 8, 28 | bun typecheck exits 0; create-revise-search unit test passes under bun and under Electron Node; store path comes only from the data folder argument | implementation |
| 31 | Implement the MCP server in the host over the engine and the store: the 23 tools of studio spec 5 on streamable HTTP at 127.0.0.1 with the token, LocalStudioApi routing, per-session file root | coder-execution | implementation/10_studio_mcp.md | 29, 30, 108, 109, 110 | Tool list equals studio spec 5; test fails if globalThis.fetch is called; paths outside the session root refused | implementation |
| 32 | Apply the render.ts patch that prints Studio's PDF from its own HTML through the bridge pdf op (D-15 reversal), with a page-count test | coder-execution | implementation/11_studio_pdf.md | 24, 108 | Test renders one sample sheet PDF with the expected page count; no soffice reference left in the render path | implementation |
| 33 | Register datum-studio as a built-in MCP entry for every Swarm user pointing at the host endpoint per studio spec 9 | coder-execution | implementation/12_studio_mcp_register.md | 31, 111 | Fixture-HOME config resolution lists datum-studio; no user config file written; typecheck exits 0 | implementation |
| 34 | Install the ~/.local/bin/datum-studio wrapper beside the swarm CLI install, exec-ing the launcher that runs datum-studio-bridge.js | coder-execution | implementation/13_studio_launcher.md | 21, 31, 111 | With a host fixture the wrapper lists the tools; without the host it exits 3 with the start-Swarm message; no ~/.claude file written | implementation |
| 35 | Write the shipped CLAUDE_SETUP.md note with the exact claude mcp add line for the wrapper | coder-execution | implementation/14_claude_setup_note.md | 21, 34 | Note names the wrapper path from the register; command is shown, never executed by the row | implementation |
| 36 | Write the Studio stage script that bundles bridge, launcher, templates, samples, Studio assets and studio-manifest.json into .datum-studio-stage | coder-execution | implementation/15_studio_stage.md | 31, 80, 110 | Stage verify prints DATUM_STUDIO_STAGE_OK; size within the row 80 SZ-3; manifest sha check passes | implementation |
| 37 | Implement store backup and export (VACUUM INTO plus folder copy) with a restore check | coder-execution | implementation/16_studio_store_export.md | 30 | Export reopens with equal document and revision counts; target inside the store refused | implementation |
| 42 | Port the Studio unit tests covering the kept engine, contract, registry, templates, ingest and store paths, then run them | test-expert | implementation/21_studio_tests.md | 31, 32 | Ported list with a reason per dropped test; all ported tests pass, output quoted | implementation |
| 43 | Prove retrieval after a restart: create documents with revisions and outputs, restart the host, list, fetch, re-render, search them | test-expert | implementation/22_studio_retrieval_test.md | 30, 31, 32, 37 | Test passes under Electron Node; fails when the store is swapped for memory (mutation quoted); re-rendered DOCX sha equal, or L1 1.0000 per K14 with the per-run field quoted | implementation |
| 44 | Prove two clients (a Swarm session and a bridge client) through one host do not corrupt the store | test-expert | implementation/23_studio_concurrency_test.md | 30, 31, 111 | No lost write in the run, counts quoted; fails when the host write queue is bypassed (mutation quoted) | implementation |
| 45 | Wire electron-builder for the skill copy, runtime and Studio stage folders, the datum-studio-host electron-vite input, the prebuild.ts hook, with its config test | coder-execution | implementation/24_builder_wiring.md | 21, 22, 23, 36, 80, 103, 111 | electron-builder.config.test.ts passes; each stage folder has a build-gate hook; only this row edits these four files in its wave | implementation |
| 46 | Bump the release to 1.2.0 in SWARM_RELEASE, package.json version, onboarding and their test pins per row 6 | coder-execution | implementation/25_version_bump.md | 6, 45 | onboarding and builder config tests pass; Grep shows 1.2.0 at every site of row 6 | implementation |
| 47 | Write the 1.2.0 build recipe from 08e with the packaging gates (version x3, NOPYC-1, MACHO-1, SZ-1..SZ-6 with the row 80 SZ-3, SMOKE-1) | coder-execution | implementation/26_build_recipe.md | 5, 6, 16, 80 | Diff against 08e shows only the listed changes, each explained | implementation |
| 48 | Security-review bundled executables, render bridge, host endpoint and bridge launcher, store and output paths, the imported Studio engine with its patches, the Rev A Python builders | security-review | verification/02_security.md | 22, 23, 24, 25, 26, 29, 30, 31, 32, 33, 34, 35, 36, 37, 43, 44, 45, 46, 69, 81, 103, 106, 107, 108, 109, 110, 111, 112 | Zero open High or Medium under the stop rule; every bundled binary listed with origin and hash | verification |
| 49 | Review the change for correctness, simplicity, maintainability of the one template set, divergence between Studio Rev A tokens and the Python builders | senior-code-reviewer | verification/10_code_review.md | 22, 23, 24, 25, 26, 29, 30, 31, 32, 33, 34, 35, 36, 37, 42, 43, 44, 45, 46, 69, 103, 106, 107, 108, 109, 110, 111, 112 | Findings table with severity; zero open High or Medium | verification |
| 50 | Run typecheck and full suites of opencode, app, desktop and the Studio package, diffing failing names against a fresh HEAD baseline | verifier | test/05_test_report.md | 48, 49, 70, 98 | Typechecks exit 0; app, desktop, Studio 0 failures; permission failing set equals the 66 baseline names | test |
| 51 | Make one local commit of the 1.2.0 change, no push | git-specialist | implementation/27_commit.md | 50 | git status --porcelain empty; git log -1 quoted; no push | implementation |
| 52 | Build 1.2.0 with the row 47 recipe filled with the row 51 commit | coder-execution | implementation/28_build_1_2_0.md | 47, 51 | Recipe prints PASS; SwarmRelease 1.2.0 and CFBundleShortVersionString 1.2.0 quoted; dmg sha256 recorded | implementation |
| 53 | Check the signature and size of the built app and dmg | verifier | verification/04_codesign_size.md | 52 | codesign verify deep strict quoted; spctl result quoted as it is for an ad-hoc app; sizes against budget | verification |
| 54 | Run the built app in isolation: the bundled Rev A XLSX and PPTX builders on the Kasus 02 and 03 Rev A material, collecting outputs | verifier | verification/05_app_datum_tools.md | 52, 89 | Env dump shows fixture paths and no host python; outputs L1 1.0000 against the row 104 and 105 dev outputs; bundled lint exit quoted | verification |
| 55 | Run the built app in isolation on the Rev A material: Studio tools render cases 01, 04, 05 (DOCX, HTML, SVG, PNG, PDF) into the store, then fetch one document after an app restart | verifier | verification/06_app_studio.md | 52, 89 | Outputs with sha256; PDF present; document made before restart fetched and found by search after it; B-FIX DOCX per R14 rendered | verification |
| 56 | CONTROL (U18 B-O and RS): compare the row 55 outputs with the frozen original reference using the row 92 wrapper, with the row 91 scorer on both sides | master-controller | gateway_check/04_judge_bundled_vs_original.md | 55, 91, 92, 97 | Score per file at least 0.9000 with the identical flag quoted; scorer verdict equal per rule on both sides; CL-U verdicts of row 77 identical | gateway_check |
| 57 | CONTROL: register the built app's wrapper at local scope (U9.5) with the row 55 app running, create a document from Claude, fetch one Swarm made, then remove the registration | master-controller | gateway_check/05_claude_mcp_proof.md | 55 | Both directions fetched; claude mcp list after removal quoted; no other Claude config changed | gateway_check |
| 58 | Run the single approved end-to-end Swarm session with the thinker model under U15 on the Kasus 07 Rev A prompt, collecting outputs | verifier | test/04_e2e_run.md | 56, 88 | U15 terms followed; outputs with sha256; key absent from logs (match count 0 quoted) and fixture auth.json deleted | test |
| 59 | CONTROL (U18 on L2): judge the row 58 outputs against Manual Rev A with the row 91 scorer on DOCX, the row 76 points on every file, the row 77 CL-U checks | master-controller | gateway_check/06_judge_l2.md | 58, 76, 77, 91 | Scorer verdict per DOCX quoted; point verdict per file with manual page; CL-U verdicts quoted | gateway_check |
| 60 | Final verification of the success criteria of 01_translated.md and U1-U18 with evidence | verifier | verification/01_verification.md | 53, 54, 56, 57, 59, 71, 104, 105, 113, 114 | Each criterion PASS or FAIL with a quoted artifact line | verification |
| 61 | Under U9.10 and U14 move the old /Applications/Swarm.app to the Trash, then install the 1.2.0 app from the dmg | coder-execution | implementation/29_install.md | 60 | Old app present in ~/.Trash; no hard delete; no launch by the agent | implementation |
| 62 | Check the installed app read-only | verifier | verification/07_installed_app.md | 61 | SwarmRelease and CFBundleShortVersionString 1.2.0; codesign verify ok; DATUM, Studio and launcher resources present | verification |
| 63 | Write the template spec (U10): the Studio template model (slots, params, role formats, section types), create from scratch or copy, versioning in the shared store with a store and migration note, preview, the lint guard verdict (reject or warn), which files to port from services/templates, registry, params and the 3ebe486 template-editor logic (Tier 1) | data-analyst | masterplan/01_specs_studio_templates.md | 1, 2, 7, 8 | Port file list traced to the clone with file:line; guard rule names Claude's datum_lint as judge; version rules state that old versions are kept and documents keep their render version | masterplan |
| 64 | Implement versioned template tables and the document-to-template-version link in the store per the row 63 store note, with migration 0002 | coder-execution | implementation/30_template_store.md | 30, 37, 63 | bun typecheck exits 0; unit test keeps old versions after a new one; an existing store migrates with document counts unchanged | implementation |
| 65 | Security-review the row 63 port files that are outside row 11's closure as code text before they run | security-review | verification/08_template_prereview.md | 63 | Findings table with severity; go or no-go per file; zero open High before row 66 | verification |
| 66 | Implement the template service per row 63 with its row 79 amendment: create from scratch, copy, modify slots, params, role formats, section types under the form lock P1-P9 | coder-execution | implementation/31_template_service.md | 29, 64, 65, 79 | bun typecheck exits 0; unit test copies datum-gsp and changes one slot as a new version; Grep finds no prisma import | implementation |
| 67 | Implement template preview with sample content plus the row 79 guard (Studio engine lint on candidate and reference renders; a newly failing check rejects) | coder-execution | implementation/32_template_guard.md | 32, 66, 79 | A template that breaks a Rev A check is refused; a valid copy passes; guard report quoted | implementation |
| 68 | Add the template MCP tools to the Studio server: create, copy, modify, preview, list versions, re-render a document on a newer template version | coder-execution | implementation/33_template_mcp.md | 31, 67 | Tool list equals row 63 as amended by row 79; stdio test re-renders a document on a newer version while the old render keeps its version | implementation |
| 69 | Test the template tools end to end: versions kept, document keeps its version, re-render on newer, guard refusal, malformed or oversized input refused | test-expert | implementation/34_template_tests.md | 68 | All tests pass, output quoted; guard test fails when the guard is bypassed (mutation quoted) | implementation |
| 70 | Security-review the template tools with template input treated as untrusted: paths, sizes, OOXML and markup injection, asset references, guard bypass | security-review | verification/09_template_security.md | 69 | Zero open High or Medium under the stop rule; each input field has a stated check | verification |
| 71 | CONTROL (U18 T and RS): in the row 55 fixture store copy datum-gsp, modify P per R6 (roleFormats cover.titleFirst/cover.titleLast run.szHalfPt, V = 52) via MCP, render the Kasus 01 Rev A content, judge it | master-controller | gateway_check/07_template_control.md | 55, 85, 91 | MCP calls and new version id quoted; T rules of row 78 and scorer verdict quoted; Calibri attempt refused with TEMPLATE_FORM_LOCKED | gateway_check |
| 72 | Write the U16-U18 register amendment: Rev A material folder and file names, level names B-O, RS, MJ, CL-U, T, scorer and compare script names, manual rule ids, the C16 names now dropped (Tier 3) | data-analyst | masterplan/00b_names_register_rev_a.md | - | Each name once with meaning; every C16-only name of row 19 section 1.2 marked dropped or kept; no clash with register sections 1-10 | masterplan |
| 73 | Extract the text of both Rev A manual PDFs with one page marker per page (Tier 3) | document-reader | research/11_manual_rev_a_text.md | - | Page counts 98 (ID) and 99 (EN) quoted; PDF sha256 equal to research/manual_rev_a/SHA256SUMS; text files under research/manual_rev_a/text/ | research |
| 74 | Write the Rev A workbook (RAB) rules as numbered rules with ID and EN page citations (Tier 1) | data-analyst | research/12_rev_a_workbook_rules.md | 72, 73 | Each rule has an ID and an EN page; each rule marked file-testable or judge-only; differences from frozen references/04-workbook.md listed | research |
| 75 | Write the Rev A briefing (paparan) rules as numbered rules with ID and EN page citations (Tier 1) | data-analyst | research/13_rev_a_briefing_rules.md | 72, 73 | Each rule has an ID and an EN page; each rule marked file-testable or judge-only; differences from frozen references/05-command-brief.md listed | research |
| 76 | Write the Rev A conformance points the controller judges by hand for documents, diagrams and sheets, with a sample-selection rule (Tier 1) | data-analyst | research/14_rev_a_conformance_points.md | 72, 73 | Each point has an ID and EN page plus a pass test; points the row 91 scorer automates carry its rule id; sampling rule stated before any output exists | research |
| 77 | Map Claude's 38 v1.7 checks to Rev A as unchanged, changed or absent, defining the CL-U set (Tier 1) | data-analyst | research/15_rev_a_v17_check_map.md | 4, 72, 73 | All 38 checks classified with a manual page or "not in manual"; CL-U set listed; checks 25 and 30 of F18-2 classified | research |
| 78 | Write the U18 amendment of the equivalence spec: levels, pass rules (at least 0.9000 per file, identical as target, no averaging), Rev A material list per case, the L2 rule, v1.7 references as history (Tier 1) | data-analyst | masterplan/01_specs_equivalence_u18.md | 72, 76, 77 | Every case has a level and a pass rule; similarity weights unchanged from equivalence spec 5 or each change justified before any bundled output; circular parts named | masterplan |
| 79 | Write the U16 amendment of the template spec: guard on Studio engine lint (D-B), K10 and K11 re-resolution, preview formats, case 06 assertions on the Studio engine (Tier 1) | data-analyst | masterplan/01_specs_studio_templates_u16.md | 72 | Guard names Studio lint (services/render/lint.ts) as the product guard; reason unmapped dropped; cover.title.sizePt traced to formats.ts:167 | masterplan |
| 80 | Write the U16 amendment of the packaging spec: Studio engine assets in datum-studio/, the new SZ-3 limit, the D-D Plex duplication (Tier 1) | data-analyst | masterplan/01_specs_packaging_u16.md | 72 | Asset list with KB from du of the clone; SZ-3 value stated; total stays inside the +350 MB cap | masterplan |
| 81 | Reconcile amendments 77-80 with the register amendment and this blueprint's U16 re-resolution table, routing every conflict to a row | verifier | gateway_check/08_spec_reconciliation_u16.md | 77, 78, 79, 80 | Zero unresolved names; every re-resolution row confirmed or corrected; every row 18 finding routed | gateway_check |
| 82 | Write the Kasus 01 Rev A Studio input from the row 17 diagnostic variant (legend keys, result() rows, filled controlSheet), synthetic only | coder-execution | test/10_material_rev_a_01.md | 78 | Original Studio in the row 17 scratch accepts it in a dry run with errors [] (quoted); diff against laporan.studio.json listed; no private data | test |
| 83 | Write the Kasus 04 Rev A Studio diagram input from the row 17 diagnostic variant (legend keys), synthetic only | coder-execution | test/11_material_rev_a_04.md | 78 | Original Studio accepts it in a dry run with errors [] (quoted); diff against gambar.studio.json listed; no private data | test |
| 84 | Write the Kasus 05 Rev A Studio sheet input from the row 17 diagnostic variant (legend keys, result() rows, filled controlSheet), synthetic only | coder-execution | test/12_material_rev_a_05.md | 78 | Original Studio accepts it in a dry run with errors [] (quoted); diff against lembar.studio.json listed; no private data | test |
| 85 | Check Kasus 06 operasi.json against the row 79 template amendment, writing a Rev A version only if a field must change | coder-execution | test/13_material_rev_a_06.md | 79 | Each operation traced to a spec section; unchanged file reused with its sha or new file with its sha; Calibri negative kept | test |
| 86 | Write the Kasus 02 Rev A RAB workbook content from the row 74 rules, synthetic only | coder-execution | test/14_material_rev_a_02.md | 74 | Every file-testable workbook rule exercised by at least one field (rule ids listed); no private data; sha256 quoted | test |
| 87 | Write the Kasus 03 Rev A paparan content from the row 75 rules, synthetic only | coder-execution | test/15_material_rev_a_03.md | 75 | Every file-testable briefing rule exercised by at least one slide field (rule ids listed); no private data; sha256 quoted | test |
| 88 | Write the Kasus 07 Rev A prompt for the thinker run per row 78, keeping data proyek.json unchanged | coder-execution | test/16_material_rev_a_07.md | 78 | Prompt names the Rev A format per requested file; data proyek.json sha unchanged; no private data | test |
| 89 | Freeze the Rev A material: manifest with sha256 of every file in the Rev A material folder, tree made read-only | coder-execution | test/17_material_rev_a_freeze.md | 81, 82, 83, 84, 85, 86, 87, 88 | Manifest line count equals file count; each row 78 case has its inputs; freeze time earlier than row 93 | test |
| 90 | Security-review the clone's benchmark/datum_conformance as code text before it runs (outside row 11's closure) | security-review | verification/09_scorer_prereview.md | - | Findings table with severity; go or no-go per file incl. baseline/render_id_samples.ts (spawnSync); zero open High before row 91 | verification |
| 91 | Wrap the reviewed Rev A scorer as an offline judge tool copied into test/judge/conformance/ with provenance, run by bun in a fixture HOME, with a self-test | coder-execution | test/18_rev_a_scorer.md | 90 | sha per copied file equals the clone; self-test on the scorer's own fixtures plus the row 17 variant DOCX quoted; dead proxy set and no network call | test |
| 92 | Write the B-O compare wrapper over test/judge/similarity.py: pairs per case, identical flag after normalisation, HTML and PNG as information (D-F) | coder-execution | test/19_compare_bo.md | 78 | Identical pair 1.0000 with identical flag; known-different pair below 0.9000; similarity.py weights unchanged (diff quoted) | test |
| 93 | CONTROL: render the Kasus 01 Rev A input with the original Studio in /private/tmp/claude-501/row17/studio (C14 patch, preload stub, fonts/renamed moved aside per D-A) as docx, html, svg | master-controller | gateway_check/09_original_ref_01.md | 89 | Exit 0 with errors [] quoted; sha256 per output; clone git status clean; two runs, L1 ≥ 0.9990 quoted; B-FIX DOCX rendered (93, 95); html printed to PDF with the row 18 page.pdf method | gateway_check |
| 94 | CONTROL: render the Kasus 04 Rev A input with the original Studio under D-A as svg and png | master-controller | gateway_check/09_original_ref_04.md | 89 | Exit 0 with errors [] quoted; sha256 per output; clone git status clean; two runs, L1 ≥ 0.9990 quoted | gateway_check |
| 95 | CONTROL: render the Kasus 05 Rev A input with the original Studio under D-A as docx, html, svg, printing its HTML to PDF with the row 18 page.pdf method | master-controller | gateway_check/09_original_ref_05.md | 89 | Exit 0 with errors [] quoted; sha256 per output incl. the PDF; clone git status clean; two runs, L1 ≥ 0.9990 quoted; B-FIX DOCX rendered (93, 95) | gateway_check |
| 96 | CONTROL: render the Kasus 01 Rev A content on the Kasus 06 source template with the original Studio, or record UNKNOWN with the error per D-E | master-controller | gateway_check/09_original_ref_06.md | 89 | Output sha256 or the verbatim error quoted; slug resolution path shown; clone git status clean | gateway_check |
| 97 | CONTROL: freeze the original-Studio reference with hashes plus the row 91 scorer verdict per DOCX | master-controller | gateway_check/10_original_ref_freeze.md | 91, 93, 94, 95, 96 | SHA256SUMS covers every reference file; scorer verdicts quoted; tree read-only with a freeze time earlier than row 52 | gateway_check |
| 98 | CONTROL: judge samples of the frozen original reference against the row 76 points as the Rev A baseline | master-controller | gateway_check/11_manual_baseline.md | 76, 97 | Each sampled point has a verdict with manual page; every original deviation listed as baseline; sampling follows the row 76 rule | gateway_check |
| 99 | Apply the Rev A token delta to tokens.json of the bundled skill copy, or record with page evidence that none is needed | coder-execution | implementation/40_rev_a_tokens.md | 22, 74, 75 | Each changed token cites a manual page; JSON valid; Claude's folder unchanged (sha quoted) | implementation |
| 100 | Update datum_xlsx.py in the bundled skill copy to the row 74 Rev A workbook rules | coder-execution | implementation/41_rev_a_xlsx.md | 74, 86, 99 | Builder on Kasus 02 Rev A exits 0 under datum-python; each file-testable rule of row 74 asserted in a unit test; Claude's folder unchanged | implementation |
| 101 | Update datum_pptx.py in the bundled skill copy to the row 75 Rev A briefing rules | coder-execution | implementation/42_rev_a_pptx.md | 75, 87, 99 | Builder on Kasus 03 Rev A exits 0 under datum-python; each file-testable rule of row 75 asserted in a unit test; Claude's folder unchanged | implementation |
| 102 | Update the bundled datum_lint.py so the xlsx and pptx checks that row 77 marks changed follow Rev A | coder-execution | implementation/43_rev_a_lint.md | 22, 77 | Code of unchanged checks identical by diff; each changed check cites its rule id; Claude's folder unchanged | implementation |
| 103 | Update the bundled-copy provenance: every file differing from row 4 with old and new sha, plus skillSha | coder-execution | implementation/44_skill_copy_provenance.md | 99, 100, 101, 102 | Every differing file listed with its row; unlisted files byte-identical to row 4; skillSha equals the copy's SKILL.md sha | implementation |
| 104 | CONTROL (U18 MJ and CL-U): judge the row 100 XLSX on Kasus 02 Rev A against the row 74 rules | master-controller | gateway_check/12_judge_xlsx.md | 89, 100, 102 | Verdict per rule with manual page; CL-U verdicts quoted; dev output sha recorded for row 54 | gateway_check |
| 105 | CONTROL (U18 MJ and CL-U): judge the row 101 PPTX on Kasus 03 Rev A against the row 75 rules | master-controller | gateway_check/13_judge_pptx.md | 89, 101, 102 | Verdict per rule with manual page; CL-U verdicts quoted; dev output sha recorded for row 54 | gateway_check |
| 106 | Write datum-render-shim (rsvg-convert and a playwright.sync_api subset) forwarding to the render bridge, as a local dist for the runtime stage | coder-execution | implementation/45_render_shim.md | 21 | datum_render on a sample SVG exits 0 against a bridge stub; stderr label equals the register; no network call | implementation |
| 107 | Apply the security patch list to the copied Studio files: row 11 M1, M3, M4, M5, row 65 H2 at parts.ts:173, the assets.ts and import.ts cwd defaults | coder-execution | implementation/35_studio_security_patches.md | 27, 98 | provenance.json marks each file patched with old and new sha; one unit test per patch fails on the unpatched file; no other file changed | implementation |
| 108 | Write the engine twins of studio spec 1.3: browser/runtime.ts over the render bridge, soffice/index.ts readiness via the bridge, relabel.ts without relabelled faces | coder-execution | implementation/36_studio_engine_twins.md | 24, 28, 107, 98 | Grep finds no playwright-core import; unit test rasterises through a bridge stub; BROWSER_UNAVAILABLE when the handshake reports sandbox false; writes `implementation/36a_c23_recorded_diff.md`; fixes C23 incl. DATUM-25 count | implementation |
| 109 | Write the Prisma cut of studio spec 1.2: twins and patches of the 11 runtime sites plus the type-only import lines over StudioStore | coder-execution | implementation/37_studio_prisma_cut.md | 8, 28, 30, 107 | Grep finds no @prisma/client or @/lib/prisma import; bun typecheck of services exits 0; ingest unit test appends a revision through a store fake | implementation |
| 110 | Export the builtin templates from the seed files into the read-only template folder per studio spec 6 | coder-execution | implementation/38_builtin_template_export.md | 28 | Slug list diffed against studio spec 6 (16) and D-665 (18) with each difference explained; datum-gsp present; sha per file recorded | implementation |
| 111 | Implement the datum-studio-host utility process lifecycle: fork from main after whenReady, DATUM_RENDER variables passed in, datum-studio.env descriptor, store lock | coder-execution | implementation/39_studio_host_process.md | 21, 24, 31 | Fixture-HOME test starts the host with a 0600 descriptor removed on quit; a second host refuses with STORE_LOCKED; a stale lock is moved aside, never deleted; host cwd = `Res/datum-studio/` asserted (M4) | implementation |
| 112 | Implement the file-tab preview of studio spec 8.2 (P1-P8) for Studio PDF and HTML outputs inside the existing file tabs | coder-execution | implementation/46_preview.md | 32, 111 | Test opens a PDF and an HTML output in the preview; no new panel added; typecheck exits 0 | implementation |
| 113 | CONTROL (U18 MJ): judge samples of the row 55 bundled Studio outputs against the row 76 points relative to the row 98 baseline | master-controller | gateway_check/14_manual_judge_bundled.md | 55, 76, 98 | Point verdicts with manual page; every difference from the baseline is a numbered finding; zero bundled-only deviations for PASS | gateway_check |
| 114 | Check the built app's UI in isolation per the 1.1.4 11_ui_home.md method, including a Studio PDF opened in the file-tab preview | verifier | verification/12_ui_preview.md | 52, 112 | Isolated env dump quoted; home renders; preview shows the PDF (screenshot path quoted) | verification |
| 115 | Move the 16 IBM Plex files of C7 from ~/Library/Fonts to the Trash per gateway_check/02_fonts_installed.txt | coder-execution | implementation/47_fonts_trash.md | 56, 59, 71, 104, 105, 113 | Each of the 16 present in ~/.Trash with matching sha256; none left in ~/Library/Fonts; no other font touched | implementation |
| 116 | Persist memory: 1.2.0 outcome, U16-U18, lessons, open items | master-controller | memory/swarm_1_2_0_release.md | 62, 115 | File exists with an index line in MEMORY.md; no secret or key in it; open items listed | report |

## Execution Profile

| Step | Ownership Area | Deps (kind) | Size | Model | Shared Resources | Checks | Review |
|------|----------------|-------------|------|-------|------------------|--------|--------|
| 1-19 | DONE (see the 2026-11-06 pass 1 profile in decisions C2-C15, C17) | - | - | - | - | - | gate |
| 20 | docs only | 19:B | M | opus | - | trace, no L, MAJOR | gate |
| 21 | docs only (controller) | 20:B | S | opus (controller) | - | C19, D-A to D-F, no question | gate |
| 22 | NEW under EXISTS: swarm/packages/desktop/: datum/datum-house-style/ | 21:B | S | sonnet (byte copy, sha check) | - | sha per file, source untouched | gate |
| 23 | NEW under EXISTS: swarm/packages/desktop/scripts/: stage-datum-runtime.ts; stage NEW under EXISTS: swarm/packages/desktop/; EXISTS: swarm/packages/desktop/.gitignore (sole writer) | 15:B, 16:B, 21:B, 106:C | M | opus | network (package fetch), heavy-host | repeatable, imports, no matplotlib/pyc | gate |
| 24 | NEW under EXISTS: swarm/packages/desktop/src/main/: render bridge module | 7:C, 9:C, 21:B | M | opus | - | png+pdf over socket, 20 rasters, window flags | gate |
| 25 | EXISTS: swarm/packages/opencode/src/skill/index.ts; NEW under EXISTS: swarm/packages/opencode/src/skill/: datum-root.ts | 9:C, 22:B, 72:C | M | opus | - | typecheck, fixture test, routing body | gate |
| 26 | UNKNOWN - executor declares from row 6 (candidates EXISTS: swarm/packages/desktop/src/main/updater.ts, EXISTS: .../patch-common.ts) | 6:C, 21:B | S | opus | - | items closed, targeted tests | gate |
| 27 | NEW under EXISTS: swarm/packages/: datum-studio/vendor/ and provenance.json | 11:C, 21:B | S | sonnet (verbatim copy, sha check) | - | sha per file, no renamed fonts, clone clean | gate |
| 28 | NEW: swarm/packages/datum-studio/package.json; EXISTS: swarm/bun.lock | 27:B | S | sonnet (pinned install, checkable) | lockfile | install exit, lockfile diff, advisory scan | gate |
| 29 | datum-studio/vendor: contract/{env,auth,ui}.ts, scripts/studio/{_repo-alias,mcp/config}.ts (clone EXISTS, verified this pass) | 28:B, 107:B | M | opus | - | typecheck, no next imports, root refused | gate |
| 30 | NEW under datum-studio/: store module (executor declares paths) | 8:C, 28:B | M | opus | - | typecheck, bun+Electron Node test, path arg | gate |
| 31 | NEW under datum-studio/: host MCP server (executor declares paths); vendor/scripts/studio/mcp/* read | 29:B, 30:B, 108:B, 109:B, 110:C | M | opus | port (loopback, per launch) | 23 tools, no fetch, root guard | gate |
| 32 | datum-studio/vendor: services/render/pure/render.ts (clone EXISTS) | 24:C, 108:B | M | opus | - | page count, no soffice | gate |
| 33 | EXISTS: swarm/packages/opencode/src/session/installed-tools.ts (pattern; executor declares the write site) | 31:C, 111:B | S | opus | - | resolution, no user file, typecheck | gate |
| 34 | NEW beside EXISTS: swarm/packages/desktop/src/main/cli-install.ts (executor declares) | 21:B, 31:C, 111:C | S | opus | - | wrapper lists tools, exit 3, no ~/.claude | gate |
| 35 | NEW under datum-studio/: CLAUDE_SETUP.md | 21:B, 34:C | S | opus | - | path, command shown only | gate |
| 36 | NEW under EXISTS: swarm/packages/desktop/scripts/: stage-datum-studio.ts | 31:B, 80:B, 110:B | S | opus | - | stage ok, SZ-3, manifest | gate |
| 37 | datum-studio store module: export (after row 30, sequential) | 30:B | S | opus | - | reopen counts, target guard | gate |
| 42 | datum-studio tests folder (executor declares) | 31:B, 32:B | M | opus | heavy-host | ported list, pass | gate |
| 43 | datum-studio retrieval test | 30:B, 31:B, 32:B, 37:B | M | opus | - | pass, mutation, sha or L1 | gate |
| 44 | datum-studio concurrency test | 30:B, 31:B, 111:B | M | opus | - | no lost write, mutation | gate |
| 45 | EXISTS: swarm/packages/desktop/electron-builder.config.ts, EXISTS: .../electron-builder.config.test.ts, EXISTS: .../electron.vite.config.ts, EXISTS: .../scripts/prebuild.ts (single writer) | 21:B, 22:C, 23:C, 36:C, 80:C, 103:C, 111:C | M | opus | - | config test, hooks, single writer | gate |
| 46 | EXISTS: electron-builder.config.ts (after 45), EXISTS: swarm/packages/desktop/package.json, EXISTS: .../src/main/onboarding.ts | 6:C, 45:B | S | sonnet (fixed constants) | - | tests, Grep | gate |
| 47 | NEW under EXISTS: docs/2026-11-06_swarm_1_2_0_datum_installer/implementation/: recipe .zsh | 5:B, 6:C, 16:B, 80:B | S | opus | - | diff explained | gate |
| 48 | docs only | implementation rows as listed: B; 81:B | M | opus | - | stop rule, binary list | gate |
| 49 | docs only | implementation rows as listed: B | M | opus | - | stop rule | gate |
| 50 | docs only (runs in package dirs) | 48:B, 49:B, 70:B, 98:B | S | opus | heavy-host | typecheck, suites, 66 names | gate |
| 51 | git: swarm repo | 50:B | S | sonnet (scripted commit) | git index | clean tree, log | gate |
| 52 | NEW under EXISTS: tools/build/: desktop_<commit10> | 47:B, 51:B | S | sonnet (run recipe, report) | heavy-host, build lock, repo frozen | PASS, plist, sha | gate |
| 53 | docs only | 52:B | S | opus | - | codesign, spctl, sizes | gate |
| 54 | fixture HOME/XDG NEW under EXISTS: /private/tmp/claude-501 | 52:B, 89:B, 104:C, 105:C | S | opus | heavy-host | env, L1 1.0 vs dev, lint | gate |
| 55 | fixture HOME/XDG NEW under EXISTS: /private/tmp/claude-501 (kept for 57, 71) | 52:B, 89:B | S | opus | heavy-host, app window | outputs, PDF, restart | gate |
| 56 | docs only (controller) | 55:B, 91:B, 92:B, 97:B | M | opus (controller) | - | score+identical, RS, CL-U | gate |
| 57 | Claude Code local-scope registration (temporary), row 55 fixture | 55:B | S | opus (controller) | row 55 app and store | both ways, removal, no other config | gate |
| 58 | fixture HOME/XDG NEW under EXISTS: /private/tmp/claude-501/row58 | 56:B, 88:B | M | opus | model endpoint (one run), real auth.json read once (U15) | U15, sha, key absent | gate |
| 59 | docs only (controller) | 58:B, 76:B, 77:B, 91:B | M | opus (controller) | - | RS, MJ, CL-U | gate |
| 60 | docs only | 53:B, 54:B, 56:B, 57:B, 59:B, 71:B, 104:B, 105:B, 113:B, 114:B | S | opus | - | criteria | gate |
| 61 | /Applications/Swarm.app (replace), ~/.Trash | 60:B | S | sonnet (scripted move, checkable) | /Applications/Swarm.app | Trash, no delete, no launch | gate |
| 62 | docs only (read-only of /Applications/Swarm.app) | 61:B | S | opus | /Applications/Swarm.app | plist, codesign, resources | gate |
| 63 | DONE | - | - | - | - | - | gate |
| 64 | datum-studio store module: template tables, migration 0002 | 30:B, 37:C, 63:C | M | opus | - | typecheck, versions kept, migration | gate |
| 65 | DONE | - | - | - | - | - | gate |
| 66 | datum-studio template service (executor declares paths; vendor services/templates read) | 29:B, 64:B, 65:B, 79:B | M | opus | - | typecheck, copy+modify, no prisma | gate |
| 67 | datum-studio template preview and guard | 32:C, 66:B, 79:B | M | opus | - | refuse, pass, report | gate |
| 68 | datum-studio host MCP server (after row 31, sequential) | 31:B, 67:B | M | opus | - | tool list, re-render | gate |
| 69 | datum-studio template tests | 68:B | M | opus | - | pass, mutation | gate |
| 70 | docs only | 69:B | M | opus | - | stop rule, per-field checks | gate |
| 71 | row 55 fixture store (controller) | 55:B, 85:B, 91:B | M | opus (controller) | row 55 app and store | MCP calls, T+RS, lock refusal | gate |
| 72 | docs only | - | S | opus | - | names once, dropped names, no clash | gate |
| 73 | docs only (reads EXISTS: research/manual_rev_a/*.pdf) | - | S | sonnet (text extraction, checkable) | - | page counts, sha, text files | gate |
| 74 | docs only | 72:C, 73:B | M | opus | - | pages, testable flag, diff to v1.7 | gate |
| 75 | docs only | 72:C, 73:B | M | opus | - | pages, testable flag, diff to v1.7 | gate |
| 76 | docs only | 72:C, 73:B | M | opus | - | pages, scorer ids, sampling rule | gate |
| 77 | docs only | 4:C, 72:C, 73:B | M | opus | - | 38 classified, CL-U, 25/30 | gate |
| 78 | docs only | 72:C, 76:C, 77:B | M | opus | - | levels, weights, circularity | gate |
| 79 | docs only | 72:C | S | opus | - | guard, unmapped dropped, trace | gate |
| 80 | docs only (reads the clone with du) | 72:C | S | opus | - | KB list, SZ-3, cap | gate |
| 81 | docs only | 77:B, 78:B, 79:B, 80:B | S | opus | - | names, re-resolution, findings | gate |
| 82 | NEW under EXISTS: docs/.../test/: Rev A material folder (name from row 72); dry run in EXISTS: /private/tmp/claude-501/row17/studio | 72:C, 78:B | S | opus | row17 scratch (one runner at a time) | dry run, diff, synthetic | gate |
| 83 | same folder, case 04 files | 72:C, 78:B | S | opus | row17 scratch | dry run, diff, synthetic | gate |
| 84 | same folder, case 05 files | 72:C, 78:B | S | opus | row17 scratch | dry run, diff, synthetic | gate |
| 85 | same folder, case 06 files | 79:B | S | opus | - | trace, sha, negative kept | gate |
| 86 | same folder, case 02 files | 74:B | S | opus | - | rule coverage, synthetic, sha | gate |
| 87 | same folder, case 03 files | 75:B | S | opus | - | rule coverage, synthetic, sha | gate |
| 88 | same folder, case 07 files | 78:B | S | opus | - | formats, data sha, synthetic | gate |
| 89 | Rev A material folder (read-only after) | 81:B, 82:B, 83:B, 84:B, 85:B, 86:B, 87:B, 88:B | S | sonnet (hash manifest) | - | count, coverage, freeze time | gate |
| 90 | docs only (reads EXISTS: /private/tmp/claude-501/gspdc/src/benchmark/datum_conformance/) | - | S | opus | - | severity, go/no-go, zero High | gate |
| 91 | NEW under EXISTS: docs/.../test/judge/: conformance/ | 90:B | M | opus | - | sha, self-test, offline | gate |
| 92 | NEW under EXISTS: docs/.../test/judge/: B-O compare wrapper (reads EXISTS: test/judge/similarity.py) | 78:B | S | opus | - | identical, different, weights | gate |
| 93 | EXISTS: /private/tmp/claude-501/row17/studio (scratch only); output NEW under docs/.../test/: original reference folder | 89:B | S | opus (controller) | row17 scratch, heavy-host (Chromium 1234) | exit, sha, clone clean | gate |
| 94 | same as 93, case 04 | 89:B | S | opus (controller) | row17 scratch, heavy-host | exit, sha, clone clean | gate |
| 95 | same as 93, case 05 | 89:B | S | opus (controller) | row17 scratch, heavy-host | exit, sha incl. PDF, clone clean | gate |
| 96 | same as 93, case 06 | 89:B | S | opus (controller) | row17 scratch | sha or error, slug path, clone clean | gate |
| 97 | original reference folder (read-only after) | 91:B, 93:B, 94:B, 95:B, 96:B | S | opus (controller) | - | sums, scorer, freeze time | gate |
| 98 | docs only (controller) | 76:B, 97:B | M | opus (controller) | - | verdicts, baseline, sampling | gate |
| 99 | packages/desktop/datum/datum-house-style/tokens.json (after row 22) | 22:B, 74:B, 75:B | S | opus | - | pages, JSON, Claude folder | gate |
| 100 | packages/desktop/datum/datum-house-style/scripts/datum_xlsx.py (after row 22) | 74:B, 86:C, 99:B | M | opus | - | exit, rule tests, Claude folder | gate |
| 101 | packages/desktop/datum/datum-house-style/scripts/datum_pptx.py (after row 22) | 75:B, 87:C, 99:B | M | opus | - | exit, rule tests, Claude folder | gate |
| 102 | packages/desktop/datum/datum-house-style/scripts/datum_lint.py (after row 22) | 22:B, 77:B | S | opus | - | unchanged diff, rule ids, Claude folder | gate |
| 103 | bundled-copy provenance file (NEW beside the copy) and runtime-manifest skillSha field | 99:B, 100:B, 101:B, 102:B | S | sonnet (hash listing) | - | listed, unlisted equal, skillSha | gate |
| 104 | docs only (controller); runs the dev datum-python from the row 23 stage or the row 15 probe | 89:B, 100:B, 102:B | S | opus (controller) | - | rules, CL-U, sha | gate |
| 105 | docs only (controller) | 89:B, 101:B, 102:B | S | opus (controller) | - | rules, CL-U, sha | gate |
| 106 | UNKNOWN - executor declares (local dist consumed by row 23; parent NEW under EXISTS: swarm/packages/desktop/) | 9:C, 21:B, 24:C | S | opus | - | exit vs stub, label, no network | gate |
| 107 | datum-studio/vendor: contract/env.ts read root, services/templates/{assets,import}.ts, engine/docx/package/parts.ts, engine/docx/blocks/media.ts, engine/html/blocks/device.ts, engine/docx/wrapper/media.ts (clone paths per row 11/65 reports) | 27:B, 98:C | S | opus | - | provenance, per-patch test, scope | gate |
| 108 | datum-studio/vendor: engine/browser/runtime.ts, engine/soffice/index.ts, engine/docx/fonts/relabel.ts (clone EXISTS) | 24:C, 28:B, 107:B, 98:C | M | opus | - | no playwright, raster stub, refusal | gate |
| 109 | datum-studio/vendor: services/** Prisma sites of studio spec 1.2 | 8:C, 28:B, 30:C, 107:B | M | opus | - | no prisma, typecheck, ingest test | gate |
| 110 | NEW under datum-studio/: templates/ export (reads EXISTS: clone prisma/seed-studio-templates.ts) | 28:B | S | opus | - | slug diff, datum-gsp, sha | gate |
| 111 | NEW under EXISTS: swarm/packages/desktop/src/main/: host lifecycle module; fork call in EXISTS: .../src/main/index.ts | 21:B, 24:C, 31:C | M | opus | - | descriptor, STORE_LOCKED, stale lock | gate |
| 112 | UNKNOWN - executor declares from studio spec 8.2 (existing file-tab component) | 32:B, 111:C | M | opus | - | PDF+HTML preview, no panel, typecheck | gate |
| 113 | docs only (controller) | 55:B, 76:B, 98:B | M | opus (controller) | - | verdicts, findings, PASS rule | gate |
| 114 | fixture HOME/XDG NEW under EXISTS: /private/tmp/claude-501 | 52:B, 112:C | S | opus | heavy-host, app window | env, home, preview | gate |
| 115 | ~/Library/Fonts (16 listed files only), ~/.Trash | 56:B, 59:B, 71:B, 104:B, 105:B, 113:B | S | sonnet (scripted move, sha check) | - | Trash, none left, no other font | gate |
| 116 | memory folder of this project | 62:B, 115:B | S | opus (controller) | - | file, index line, no secret | gate |

**Honesty of the profile.**
- Sizes, models, waves and the budget are estimates.
- EXISTS paths were verified in this pass with Glob or Grep (lists in "Evidence checked in this pass"). Counts: EXISTS = 31 (all verified), NEW-under = 24, UNKNOWN = 3 (rows 26, 106, 112).
- `datum-studio/vendor/...` paths are clone paths verified in the clone. They exist in the repo only after row 27.
- Drivers declare exact paths before writing.
- Single writers:
  - row 45 for the four build files;
  - row 23 for `.gitignore`;
  - rows 99-103 for the bundled skill copy, each on a different file, with row 103 last;
  - the store module: rows 30 → 37 → 64 in order;
  - the host MCP server: rows 31 → 68.
- The row 17 scratch is one runner at a time (rows 82-84 dry runs, 93-96 renders).
- Row 48 depends on the implementation rows listed in its Depends On column.

**Cost (estimate).**
- **Rows.** 90 rows remain to run (rows 21-37, 42-62, 64, 66-116): 37 M and 53 S. By model: 79 opus (16 of them controller rows) and 11 sonnet (rows 22, 27, 28, 46, 51, 52, 61, 73, 89, 103, 115).
- **Waves.** The B edges give about 21 waves. Widest wave: W2 with 17 rows (22, 23, 24, 26, 27, 34, 35, 45, 47, 74, 75, 76, 77, 85, 91, 106, 111). Then W4 with 13 and W6 with 13. W1 is 21, 72, 73, 79, 80, 90.
- **Critical path.** 21-27-28-30-64-66-67-68-69-70-50-51-52-55-56-58-59-60-61-62-116. The template chain 64-70 is the longest Studio stretch. Two levers shorten it:
  - start row 64 as soon as row 30 lands (row 37 is a C dependency);
  - let the controller run rows 48 and 49 on the non-template rows by contract while 66-70 finish. This saves about 2 waves; row 50 still waits for row 70.

  The reference side (72-73-77-78-81-89-93-97) finishes around W7, well before row 52, so it is not critical.
- **Budget.** 37 x ~250k + 53 x ~100k, about 14.6M tokens for the remaining rows. The three most expensive rows are 31 (MCP server in the host), 109 (Prisma cut over 11 sites) and 108 (engine twins over the bridge), then 24 (render bridge).

## Dependencies

- `identification/01_original.md`, `01_translated.md`, `decisions/decisions.md` (U1-U18, C1-C18; C19 written by row 21).
- Specs: `masterplan/00_names_register.md`, `01_specs_studio.md` (§1-§10 valid again under U16), `01_specs_studio_store.md`, `01_specs_runtime.md`, `01_specs_equivalence.md` (§5 metric kept; §6 levels replaced by row 78), `01_specs_studio_templates.md` (amended by row 79), `01_specs_packaging.md` (amended by row 80), `gateway_check/01_spec_reconciliation.md` (re-resolved above).
- Read-only sources: the clone, the row 17 scratch, Claude's DATUM folder, `research/manual_rev_a/`.
- 1.1.4 models: the 08e recipe and `verification/11_ui_home.md`.

## Verification & Testing Strategy

- **Control (U18, binding).**
  - B-O: bundled Studio vs the frozen original Studio, ≥ 0.9000 per file, identical as the target (rows 56, 92, 97).
  - RS: the Rev A scorer on both sides (rows 91, 56, 59, 71, 97).
  - MJ: the controller judges against the manual with page citations (rows 98, 104, 105, 113, 59).
  - CL-U: Claude's lint for unchanged rules only (rows 77, 56, 59, 104, 105).
  - XLSX/PPTX: MJ plus CL-U.
  - Freeze order: material (89) → original reference (97) → bundled outputs (55). The v1.7 references are history.
- **Unit**: targeted tests and typecheck per row, from package directories.
- **Studio**: ported engine and service tests (row 42), retrieval after restart (row 43), two clients through one host (row 44), built app with restart (row 55), Claude through the bridge (row 57), template control (row 71), preview (rows 112, 114).
- **Regression**: full suites once (row 50). The 66 permission baseline failures stay unchanged by name.
- **Security**: rows 11, 65 and 90 run before any clone code; rows 48 and 70 run before the commit.
- **Performance and size**: rows 15, 16 and 80 set the budget; row 53 checks it.
- **Rollback**: the old app stays in the Trash. The commit is local (`git revert`). The store is backed up as a folder copy (row 37). The C7 fonts go to the Trash (row 115).
- **Acceptance**: row 60.

## Risk Assessment

- **B-O below 0.90 from twins.** Raster differences between Chromium builds, or fonts if D-A is wrong. Mitigation: verbatim engine copy; row 42 engine tests; the D-A like-for-like font input; the information run with renamed fonts; a finding becomes a new small row.
- **Original Studio deviates from Rev A itself.** Mitigation: the row 98 baseline. Only bundled-only deviations count against the port (row 113).
- **Scorer code untrusted.** Mitigation: row 90 review first; `render_id_samples.ts` is not run.
- **XLSX/PPTX Rev A interpretation.** Mitigation: rules with page citations (rows 74, 75) before the builders; judged by MJ (rows 104, 105).
- **Bundled lint diverging from Claude's.** Mitigation: unchanged checks byte-identical (row 102); provenance (row 103).
- **Two clients on one store.** Mitigation: a single host writer; row 44 with a mutation run.
- **Signing and size.** Studio assets add MB. Mitigation: rows 80, 47, 53.
- **Version downgrade logic.** Mitigation: rows 6, 26, 46, 52.

## Recommendation & Next-Plan Summary

### Key Findings Summary
| # | Finding | Confidence | Evidence Source | Implication |
|---|---------|------------|-----------------|-------------|
| 1 | The original Studio renders the Rev A-valid variants offline on this Mac with the C14 patch and preload stub | High | research/10_studio_parity_outputs.md:116-126 | It can serve as the U18 reference side (rows 93-96) |
| 2 | Studio's Rev A conformance scorer exists, DOCX only, deps fflate and node only | High | clone benchmark/datum_conformance/ (Glob, Grep) | Row 90 review, then row 91 wrapper |
| 3 | F-S1..F-S3 are Rev A rules, and the diagnostic variants satisfy them | High | research/10:122-126 | Rev A material rows 82-84 derive from the variants |
| 4 | The clone keeps 10 modified Plex fonts that 1.2.0 must not ship (U9.7) | High | /private/tmp/claude-501/row17/studio/src/lib/studio/assets/fonts/renamed/ (Glob) | D-A like-for-like reference |
| 5 | test/judge has no HTML or PNG feature extractor | High | Glob test/judge/feat_*.py | D-F information-only pairs |

### Priority Recommendations
| Priority | Recommendation | Rationale | Risk if Ignored | Target Phase/Task |
|----------|---------------|-----------|-----------------|-------------------|
| P0 | Freeze the material, then the original reference, before any bundled output | U18 integrity | Tuned comparisons | Rows 89, 97, 55 |
| P0 | Review the scorer before running it | Untrusted code | Compromise | Row 90 |
| P1 | Start the reference side and the manual rows in W1-W2 | Off the critical path, if they start early | Late control | Rows 72-81 |
| P2 | Dedupe the Plex copies after 1.2.0 | Size | A few MB | Later task |

### Pending Decisions for Human-in-Loop
| # | Decision Required | Options | Recommended Option | Impact |
|---|-------------------|---------|-------------------|--------|
| 1 | None open: D-A to D-F are taken under U14 and recorded at row 21 | - | - | No stop |

### Next-Plan Recommendations
- **Immediate next step**: row 21 (record C19), then W1 (rows 72, 73, 79, 80, 90) in one message.
- **Subsequent tasks**: W2 (17 rows; the controller mediates ownership); the Studio port chain 27-28-107-29/108/109/30-31; the reference side 77-78-81-89-93..97; the builders 99-103; then reviews, build and control.
- **Parallelizable work**: manual rows 74-77; material rows 82-88; reference renders 93-96 (sequential in the scratch, parallel with the port); builders 100 and 101.
- **Cross-task continuity notes**: record C19. When the final control row is done, the C7 fonts go to the Trash (row 115). Memory goes into `swarm_1_2_0_release.md` (row 116).

## Agent Mapping Rationale

- **data-analyst**: the Tier 1 manual extraction and the spec amendments, which need interpretation with page citations.
- **document-reader**: mechanical PDF text extraction (sonnet).
- **coder-execution**: the port, twins, patches, bridge, host, builders, material, judge wrappers, stage, recipe and install. Sonnet only for verbatim copies, pinned installs, constants, hash manifests and scripted moves.
- **master-controller**: every U18 control row (reference production, freeze, manual judging, B-O), the row 21 record and memory, because U18 makes the controller the judge.
- **security-review**: the scorer (row 90), the main review (row 48) and the template input (row 70).
- **test-expert**: engine and service tests, retrieval, concurrency, template tests.
- **verifier, senior-code-reviewer, git-specialist**: reconciliation, built-app checks, review and commit. Entry and verification agents are never downgraded.

---
*Generated: 2026-11-06*
*Last Updated: 2026-11-06 (row 20 pass 2: U16-U18 refinement, rows 38-41 dropped, rows 72-116 added)*

## Addendum C34 (controller, 2026-11-07)

| Step | Task Description | Agent_to_Invoke | Expected Output | Depends On | Verification | Phase |
|------|------------------|-----------------|-----------------|------------|--------------|-------|
| 117 | Rewrite the bundled skill's SKILL.md and references/01-09 to Manual Rev A with page citations, D-C routing note, and the Rev A manual text in references/rev-a/ | data-analyst | implementation/NN_row117_skill_rev_a.md | 22, 74, 75, 76, 77 | Every changed/removed v1.7 rule listed with ID/EN page; scripts/, tokens.json, assets/ untouched; sha before/after recorded | implementation |

Profile: 117 | bundled skill copy SKILL.md + references/ (+ NEW references/rev-a/) | 22:B, 74:B, 75:B, 76:B, 77:B | M | opus | - | citations, untouched files, sha | gate. Rows 25 and 103 gain 117:C.

## Addendum U19/U20 (controller, 2026-11-07): mission data foundation in 1.2.0

| Step | Task Description | Agent_to_Invoke | Expected Output | Depends On | Verification | Phase |
|------|------------------|-----------------|-----------------|------------|--------------|-------|
| 118 | Write the mission/report contract spec: mission entity, types with phase templates (U20), session-mission relation, rows/deps/waves/status/reports/decisions/findings/locks, JSON schema, store tables (contract for row 30), MCP tool set reusing Studio's studio_report_* (kept per U19) | data-analyst | masterplan/01_specs_mission_contract.md | 8, 7 | Schema validates this task's own blueprint, status and decisions as an example; every field has a type and rule; phase templates for at least research, debug, feature/release, document | masterplan |
| 119 | Implement the mission tables, schema validation and the mission/report MCP tools in the Studio package, with tests | coder-execution | implementation/NN_row119_mission.md | 118, 30, 31 | Tests: create mission, approve, report per row, refuse report without mission id, multi-mission per session, paused/superseded; typecheck 0 | implementation |
| 120 | Generate /docs Markdown (blueprint table, status, decisions) from the store for one mission, proving the store can be the source | coder-execution | implementation/NN_row120_mission_export.md | 119 | Generated table equals the hand-written one for a sample mission (diff quoted) | implementation |
| 121 | CONTROL: the controller records this task's own mission (1.2.0) and one research mission through the MCP tools as a dogfood check | master-controller | gateway_check/06_mission_dogfood.md | 119, 57 | Both missions readable back with correct phases per type; one refused malformed report quoted | gateway_check |

Profile: 118 docs only | 7:C, 8:C | M | opus. 119 packages/datum-studio (mission module, NEW) | 118:C, 30:B, 31:B | M | opus. 120 packages/datum-studio (export, NEW) | 119:B | S | sonnet (mechanical render, diff-checkable). 121 docs only (controller) | 119:B, 57:B | S | opus. Rows 48/49 (reviews) gain 119:C; row 31's kept-tool list gains the studio_report_* tools.

## Addendum C40 split (controller, 2026-11-07): engine Rev A fixes as separate rows after the twins

| Step | Task Description | Agent_to_Invoke | Expected Output | Depends On | Verification | Phase |
|------|------------------|-----------------|-----------------|------------|--------------|-------|
| 122 | Engine Rev A fixes, DOCX/front matter: issue stamp U+2014 + classification letter (CP-14), classification line (CP-15), control fields/sheet/signatures from template data (CP-05/06/09), page numbering restart (CP-11), bold caption label (CP-28 docx), derivation label (CP-30), raster width 1512 px (CP-47), keep-with-next (CP-51) | coder-execution | implementation/NN_row122_engine_docx.md | 108, 109, 110 | Each fix has a failing-before / passing-after test and a recorded diff; B-O exclusion entries written in the C23 format | implementation |
| 123 | Engine Rev A fixes, HTML/PDF: logo in PDF (CP-02), band text/label/copy control (CP-07), kicker (CP-04), Datum Rule lead growth (CP-23), SUMBER within 166 mm (CP-26), glyph fallback to DejaVu not Menlo (CP-19), key language (CP-35), overlaps/clipping (CP-37) | coder-execution | implementation/NN_row123_engine_html.md | 108, 109, 110 | Same as 122, checked on PDFs printed through the render bridge | implementation |
| 124 | Engine Rev A fixes, diagrams: colour roles <= 5 (CP-43, C23 check 25, C29 K-32), GAMBAR label (CP-28/48), mark colours (CP-29), connector routing (CP-41), symbol drawing (CP-45), key line fit (CP-46) | coder-execution | implementation/NN_row124_engine_svg.md | 108 | Same as 122; writes implementation/36a_c23_recorded_diff.md | implementation |

Profile: 122 vendor engine/docx + compose (claims first) | 108:B, 109:B, 110:C | M | opus. 123 vendor engine/html + render bridge client | 108:B, 109:B, 110:C | M | opus. 124 vendor engine/diagram | 108:B | M | opus. Row 108 now covers only the spec 1.3 twins; rows 50 and 56 gain 122-124 as B deps.

## U23 addendum: mission control 1.2.1 (task-architect, 2026-11-07)

**Basis.** U23 (the user's own plan change): build the 1.2.1 mission control dashboard now, on top of the 1.2.0 commits (1eb98be8e2, 5168775812, 503f8651c9; C110, C113, C120). Then run the end-to-end session through it. Every pending verification row runs once, on the final build. The design is closed (C59): `report/mission_control_master.html` v6. The data is closed too: U19, U20, C57, C71, C77, C80, C85, C89.

**Classification: MINOR.** All 23 new rows are S or M and stay inside the U23 scope. No new user approval is needed, apart from the install re-confirmation that U23 already requires (row 147) and one open question (below).

### Evidence checked in this pass (Glob, Grep, Read; paths are under `swarm/packages/` unless stated)

- **Where the dashboard goes.**
  - The swarm view is `app/src/pages/session/swarm/swarm-view.tsx` (`SwarmAgents` at :355; the model rebuilds every second, comment at :361).
  - It is mounted by the session map pane at `app/src/pages/session/map/session-map-view.tsx:1495` when the "agents" filter is selected (:1491-1499).
  - Model and controller follow the pattern of `swarm/swarm-model.ts`, `swarm-controller.ts` and `swarm-model.test.ts` (all EXIST).
  - The home agent board is `app/src/pages/home/agent-board-view.tsx:353`. It is not used: U19 asks for the session-level swarm view, and the session pane is the "Side pane 420" size of the master design (`mission_control_master.html:113`).
- **How the app reaches the host. The simplest existing path is desktop IPC; there is no model call.**
  - The renderer may call only `window.api` from the preload (`desktop/AGENTS.md`). IPC handlers live in `desktop/src/main/ipc.ts` (51 `ipcMain.handle`). The preload is `desktop/src/preload/index.ts` (`contextBridge`, :1) and `preload/types.ts`.
  - The host is a utility process owned by main: `desktop/src/main/datum-studio-host/start.ts:50-146` (`createDatumStudio`, `state.running.url` at :102). Main creates the Bearer token itself (`lifecycle.ts:134`). The token reaches the host only in the start message (`protocol.ts:7-11`) and the 0600 descriptor (`descriptor.ts:14-15`). The handle exposes `url` but not the token (`lifecycle.ts:60-65`).
  - The host serves only `/mcp`, streamable HTTP with sessions (`datum-studio/src/mcp-host/http-server.ts:26, :123-124, :174`).
  - A main-side JSON-RPC client over that endpoint already exists in the repo: `desktop/scripts/datum-studio-bridge.ts`, the row 34 client, written without the SDK (C63).
  - Rejected: going through the opencode sidecar. Its MCP HTTP group has only status, add, auth, connect and disconnect, and no tool call (`opencode/src/server/routes/instance/httpapi/groups/mcp.ts:45-128`). Adding a tool call would change the public HttpApi and force an SDK regeneration (`swarm/AGENTS.md`).
  - Rejected: reaching the host straight from the renderer, because it would need the token there.
- **Read tools that already exist.** `studio_mission_list` (session overview) and `studio_mission_get` (detail; `include` adds requests, checkpoints and messages). Spec `masterplan/01_specs_mission_contract.md:592-593`; `implementation/63_row119b_mission_tools.md:62-63`.
- **Write tools that already exist.**
  - Decision answer: `studio_mission_answer_decision`. It records a U decision and releases the blocked rows (`59_row119a_mission_store.md:42`).
  - Owner instruction: `studio_mission_update_row` with `messages[] {from: owner, to: controller, kind: instruction}`. It is never executed (`63_row119b_mission_tools.md:70`).
- **How text gets to the running agent.** The existing session prompt call: `app/src/pages/session/swarm/swarm-controller.ts:308` (`sdk().api.session.prompt`).
- **Deliverables.**
  - Files open in a tab with `openTab(file.tab(path))` (`app/src/pages/session/session-side-panel.tsx:747`).
  - Studio PDF and HTML render inside the tab through `FilePreviewGate` (`app/src/pages/session/file-tabs.tsx:498, :793`; C101, C102).
  - UNKNOWN: whether a Studio output already sits under the session root, which is the only place a tab can open (C101: the core realpath check). Row 125 answers this.
- **Session filter.** Swarm sends no session id to MCP tools (`01_specs_mission_contract.md:95`, catalog.ts:54-66), so `session` links can be empty. Default chosen here: list by `projectDir` (the mission's `project.dir` equals the session directory, spec :60). The `_meta` session id is left for later (P2).
- **Version sites.**
  - Row 46 sites: `implementation/73_version_bump.md:7-13`.
  - `bun.lock:402` (C90, C91).
  - `STUDIO_RELEASE = "1.2.0"` in `desktop/src/main/datum-studio-host/protocol.ts:5` is not a row 6 site; row 137 records the decision for it.
  - The recipe has `RELEASE=1.2.0` and `BASE_VERSION=1.2.0` at `implementation/26c_build_1_2_0.zsh:43-44`.
  - The recipe copies 26d and 26e are taken, so the new copy is 26f.
- **Build output folder.** `tools/build/desktop_503f8651c9/SHA256SUMS` EXISTS (the parent folder of the new build output).
- **Rules for running the app.** `delegation_progress/driver_rules.md:16-17`: `--use-mock-keychain`, `OPENCODE_TEST_ONBOARDING_ROOT`, `env -i` and an EXIT trap (C99, C117, C118). How the app is driven: CDP on loopback with `Page.captureScreenshot` (`docs/2026-11-06_swarm_1_1_4_patch/verification/11_ui_home.md:48-49`).

### Design choices (simplest; row 125 confirms or corrects them with evidence)

1. **No new panel.** Mission control becomes a section at the top of `SwarmAgents`, with a mission selector when there are several missions. It is shown only when `window.api` has the mission bridge and the project has at least one mission. The web build and projects without missions are unchanged (memory "keep the UI simple").
2. **Read path.** Renderer → `window.api` (preload) → `ipc.ts` handler → a main-side client → the host `/mcp`, using the token main already holds. It follows the JSON-RPC handshake of `datum-studio-bridge.ts`. The client has an allow-list of exactly four tools: list, get, answer_decision and update_row with messages only. The token never reaches the renderer.
3. **Live updates by polling.** While the view is visible, poll every 3 s: a cheap `list` that compares `updatedAt`, then `get` only for a changed mission. There is no event channel. Row 125 sets the interval with the C94 note in mind: reads take the write lock (`store-bridge/db.ts:42-44`).
4. **Write paths: two only.**
   - Answering a decision calls `studio_mission_answer_decision` (by user).
   - Sending an instruction calls `update_row` with an owner→controller instruction message. The "Prioritise unblock" chip is a preset instruction. "What's blocking?" is computed locally and writes nothing.
   - After either write, the same text is sent as a normal prompt into the open session (`swarm-controller.ts:308`), so the running agent learns it without polling. This is Pending decision 1 below.
5. **Mission approval needs no new button.** The agent requests a decision ("approve the plan?"). The user's answer records the U decision. The agent then calls `studio_mission_approve` with that U id. The approve, pause and accept-row buttons listed in contract §1 are not in the closed v6 design, so they are out of 1.2.1.

### Structured Task Breakdown (U23 rows)

| Step | Task Description | Agent_to_Invoke | Expected Output | Depends On | Verification | Phase |
|------|------------------|-----------------|-----------------|------------|--------------|-------|
| 125 | Write the mission control UI data/API spec: map every v6 design element (HQ deck You + Swarm, hologram ring %, waves bar, decision beacon, phase rooms per type, agents with status and checkpoint bar, decision card, command feed, chips, instruction input, Deliverables panel, dock, mission selector) to a studio_mission_list/get field or a write tool, fix the read path, polling interval, session filter, deliverable-to-file rule, IPC channel names, the TS view-model type, the EN and ID strings table (Tier 1) | data-analyst | masterplan/01_specs_mission_control_ui.md | U23, 118, 119, 120 | Every element of report/mission_control_master.html has a field/tool with spec line or a stated gap routed to row 126; read path and both write paths cite file:line; strings table has EN and ID for every key | masterplan |
| 126 | Add the host read fields that row 125 lists as missing (for example deliverable documents per mission with outputs and status), or record with evidence that none is needed | coder-execution | implementation/91_row126_mission_read_fields.md | 125 | New fields covered by a test through the real host server; mission-tools suite stays green; no write tool changed | implementation |
| 127 | Implement the desktop mission bridge: main-side client to the host /mcp with an allow-list of four tools, IPC handlers, preload window.api typing | coder-execution | implementation/92_row127_desktop_mission_bridge.md | 125, 126 | Test on a real host fixture returns list and get JSON with no model call; a non-allow-listed tool is refused; renderer-side API has no token (Grep); desktop typecheck exit 0 | implementation |
| 128 | Add the row 125 EN and ID strings as i18n keys with the parity exemption update | coder-execution | implementation/93_row128_mission_strings.md | 125 | Keys equal the row 125 table byte for byte; app i18n parity tests pass; exemption count change stated | implementation |
| 129 | Implement the mission view model and poll controller in the app (mission JSON to HQ model: type phases only, agents per row, status colours, checkpoints, progress = rows done/total, waves, open decision, deliverables, feed) | coder-execution | implementation/94_row129_mission_model.md | 125, 127 | Unit tests on the model pass per mission type; polling stops when hidden (test); app typecheck exit 0 | implementation |
| 130 | Implement the HQ command deck component (You + Swarm, progress ring, decision beacon, lit phase rooms with agents; radial when wide, lanes when narrow) per v6 | coder-execution | implementation/95_row130_mission_hq.md | 128, 129 | Component test renders 4 and 5 phase types with only the type's phases; beacon present only with an open request; app typecheck exit 0 | implementation |
| 131 | Implement the decision card and command channel component (options with consequence and Recommended, answer call, feed of last messages, two chips, instruction input with session prompt per row 125) | coder-execution | implementation/96_row131_mission_command.md | 127, 128, 129 | Test: answering calls the bridge with the chosen option and by user; instruction calls update_row with an owner instruction; empty or oversize text refused | implementation |
| 132 | Implement the Deliverables panel component (docKey/TaskRef/status/formats per mission, n/m final, click opens the file tab via openTab(file.tab(path)) or shows the row 125 not-in-project state) | coder-execution | implementation/97_row132_mission_deliverables.md | 128, 129 | Test: a Studio PDF deliverable opens a file tab; a deliverable without a project file shows the stated state; no new panel | implementation |
| 133 | Mount mission control in SwarmAgents with the mission selector and the one-screen responsive shell (sidebar above 760 px, bottom sheet plus dock below) | coder-execution | implementation/98_row133_mission_mount.md | 130, 131, 132 | Test at 420, 900 and 1280 px widths shows sidebar or bottom sheet as specified; view absent without window.api or without missions; app typecheck exit 0 | implementation |
| 134 | Test mission control end to end in the app test harness with one fixture mission per type (research, debug, feature-release, document) generated through the real mission store, including an open decision, checkpoints, messages and deliverables | test-expert | implementation/99_row134_mission_control_tests.md | 126, 127, 133 | Fixtures generated by a script against the real store (not hand-written); all tests pass with output quoted; one mutation (phase filter removed) fails | implementation |
| 135 | Security-review the new write paths and the IPC surface: decision answer, owner instruction, session prompt text, tool allow-list, token containment, rendering of mission text | security-review | verification/13_row135_mission_control_security.md | 126, 127, 131, 133 | Findings table with severity; zero open High or Medium under the stop rule; each IPC argument has a stated check | verification |
| 136 | Review rows 126-133 for correctness, simplicity, single ownership and the keep-the-UI-simple rule | senior-code-reviewer | verification/14_row136_mission_control_review.md | 126, 127, 128, 129, 130, 131, 132, 133 | Findings table with severity; zero open High or Medium | verification |
| 137 | Bump the release to 1.2.1 at the row 46 sites (not bun.lock: row 161's bun add rewrites bun.lock:402 from package.json), recording the STUDIO_RELEASE keep-or-change decision | coder-execution | implementation/100_row137_version_1_2_1.md | U23 | onboarding and builder config tests pass; Grep shows 1.2.1 at every row 46 site; bun.lock untouched by this row (git diff) | implementation |
| 138 | Write recipe 26f as a copy of 26c with RELEASE and BASE_VERSION 1.2.1 | coder-execution | implementation/26f_build_1_2_1.zsh | U23 | Diff against 26c shows only the version lines and the header comment | implementation |
| 139 | Run typecheck and full suites of opencode, app, desktop and datum-studio against the 503f8651c9 baseline names | verifier | test/06_test_report_1_2_1.md | 134, 135, 136, 137 | Typechecks exit 0; app, desktop, datum-studio 0 new failures; permission failing set equals the 66 baseline names; pre-commit secret scan clean | test |
| 140 | Make one local commit of the 1.2.1 change on top of 503f8651c9, no push | git-specialist | implementation/101_row140_commit.md | 139 | git status --porcelain empty; git log -1 quoted with parent 503f8651c9; no push | implementation |
| 141 | Build 1.2.1 with recipe 26f filled with the row 140 commit | coder-execution | implementation/102_row141_build_1_2_1.md | 138, 140 | Recipe prints CANDIDATE_BUILD PASS with 0 FAIL lines; SwarmRelease and CFBundleShortVersionString 1.2.1 quoted; dmg sha256 recorded | implementation |
| 142 | Check signature, size and unchanged runtime of the 1.2.1 build (replaces row 53 for the final build; keeps row 54 valid) | verifier | verification/15_row142_build_check_1_2_1.md | 141 | codesign deep strict OK quoted; sizes within SZ gates; datum-python and builder shas unchanged (else row 54 re-run), SKILL.md differs only by row 156 with PROVENANCE matching; Studio host chunk contains the row 161 packages and makes no network fetch (Grep + dead-proxy run) | verification |
| 143 | Re-run row 55 (Studio tools in the isolated built app, restart fetch, PDF) on the 1.2.1 build with the row 55b material adaptations | verifier | verification/16_row143_app_studio_1_2_1.md | 142 | Isolation proof per driver_rules :16-17; SHA256SUMS of outputs; PDFs present with page counts; app stopped (pgrep 0) | verification |
| 144 | Check mission control in the isolated 1.2.1 app on the row 121 missions plus the row 134 fixtures seeded through the bundled bridge: views at 420, 900 and 1280 px, one decision answered and one instruction sent through the UI over CDP | verifier | verification/17_row144_mission_control_ui.md | 121, 142 | Screenshots per width quoted by path; answered decision and instruction read back with studio_mission_get; isolation proof; app stopped | verification |
| 145 | Write the mission addendum to the Kasus 07 Rev A prompt (create a document mission in the session directory, request the plan approval as a decision, report per row, produce the deliverables with Studio under the mission folder) keeping data proyek.json unchanged | coder-execution | test/20_material_rev_a_07_mission.md | 88, 125 | Addendum names every mission tool it expects by register name; data proyek.json sha unchanged; no private data | test |
| 146 | END TO END under U15, U23 and U24: run the row 58 thinker session in the isolated 1.2.1 app on Kasus 07 with the row 145 addendum, answer its decision request in the mission control UI over CDP, capture the HQ view at start, mid and end, then export the mission with studio_mission_export (row 120) | verifier | test/04_e2e_run_mission.md | 56, 144, 145 | Mission created, rows progressed, decision answered (U id quoted); at least one deliverable shown Verified in mission control with its verification report quoted (row 154) and no row done on an unverified output; 3 screenshots + export with sha256; key absent from logs (count 0); fixture auth.json deleted; app stopped | test |
| 147 | Ask the user to re-confirm the install of the 1.2.1 dmg (U9.10 as re-required by U23), presenting row 60's verdict | master-controller | decisions/decisions.md | 60 | A U decision with the user's own words recorded before row 61 starts; no install without it | gateway_check |

### Re-sequenced rows (U23: run once on the final 1.2.1 build)

| Step | Change | New Depends On |
|------|--------|----------------|
| 54 | Stays valid (C121 reasoning) if row 142 shows the runtime and the bundled skill are unchanged. Otherwise it is re-run on the 1.2.1 build | 52, 89, 104, 105 (+142 check) |
| 55 | Superseded by 143 for every later row | - |
| 56 | B-O and RS on the row 143 outputs | 143, 91, 92, 97 (+122-124 per C56) |
| 57 | Claude MCP proof under U22 with the row 143 app | 143 |
| 58 | DROPPED (U23): replaced by 146, the same U15 run driven as a mission | - |
| 59 | Judge the row 146 outputs | 146, 76, 77, 91 |
| 60 | Final verification of the 01_translated.md criteria, U1-U23 and the mission control rows | 142, 54, 56, 57, 59, 71, 104, 105, 113, 114, 121, 134, 135, 136, 144, 146 |
| 61 | Install 1.2.1 (old app to the Trash) | 60, 147 |
| 62 | Check the installed app read-only, now expecting 1.2.1 | 61 |
| 71 | Template control in the row 143 fixture store | 143, 85, 91 |
| 113 | MJ on the row 143 outputs | 143, 76, 98 |
| 114 | Isolated UI and file-tab preview check on the 1.2.1 build | 142, 112 |
| 115 | Unchanged rule (fonts to the Trash after the last control row) | 56, 59, 71, 104, 105, 113 |
| 116 | Memory for 1.2.0 and 1.2.1 (file `swarm_1_2_1_release.md`; supersedes the 1.2.0 name) | 62, 115 |
| 121 | Dogfood: record this task's mission and one research mission in the 1.2.1 app's fixture store through the bundled bridge | 142, 119 |

### Execution Profile (U23 rows)

| Step | Ownership Area | Deps (kind) | Size | Model | Shared Resources | Checks | Review |
|------|----------------|-------------|------|-------|------------------|--------|--------|
| 125 | docs only (reads EXISTS: report/mission_control_master.html, EXISTS: masterplan/01_specs_mission_contract.md) | 118:C, 119:C, 120:C | M | opus | - | element map, cited paths, strings EN/ID | gate |
| 126 | datum-studio mission tools: EXISTS: swarm/packages/datum-studio/src/mcp-host/mission/mission-tools.ts (additive read fields only) | 125:B | S | opus | ports (host test, sandbox off) | host test, suite green, no write change | gate |
| 127 | desktop mission bridge: EXISTS: swarm/packages/desktop/src/main/ipc.ts, EXISTS: .../src/preload/index.ts, EXISTS: .../src/preload/types.ts (single writer this wave); NEW under EXISTS: swarm/packages/desktop/src/main/datum-studio-host/: mission client; EXISTS: .../datum-studio-host/start.ts (call seam) | 125:B, 126:C | M | opus | ports (host fixture) | real host read, allow-list, no token in renderer | gate |
| 128 | app i18n: EXISTS: swarm/packages/app/src/i18n/en.ts, EXISTS: .../id.ts (single writer); exemption list in EXISTS: .../i18n/parity-exemption-guard.test.ts or EXISTS: .../parity.test.ts (executor declares) | 125:B | S | sonnet (copy strings from spec) | - | keys equal spec, parity, count | gate |
| 129 | NEW under EXISTS: swarm/packages/app/src/pages/session/swarm/: mission model + poll controller (+ test) | 125:B, 127:C | M | opus | - | model per type, poll stops, typecheck | gate |
| 130 | NEW under EXISTS: swarm/packages/app/src/pages/session/swarm/: HQ deck component (+ test) | 128:B, 129:B | M | opus | - | 4/5 phases, beacon rule, typecheck | gate |
| 131 | NEW under EXISTS: swarm/packages/app/src/pages/session/swarm/: decision + command component (+ test) | 127:C, 128:B, 129:B | M | opus | - | answer call, instruction call, text limits | gate |
| 132 | NEW under EXISTS: swarm/packages/app/src/pages/session/swarm/: deliverables component (+ test); uses EXISTS: app/src/pages/session/session-side-panel.tsx:747 pattern (read only) | 128:B, 129:B | S | opus | - | opens tab, not-in-project state, no panel | gate |
| 133 | EXISTS: swarm/packages/app/src/pages/session/swarm/swarm-view.tsx (sole writer, mount); NEW under same folder: mission control shell | 130:B, 131:B, 132:B | M | opus | - | 3 widths, hidden rule, typecheck | gate |
| 134 | test files NEW under EXISTS: swarm/packages/app/src/pages/session/swarm/; fixture generator UNKNOWN - executor declares (under EXISTS: swarm/packages/datum-studio/test/ or the app folder) | 126:B, 127:B, 133:B | M | opus | heavy-host | real-store fixtures, pass, mutation | gate |
| 135 | docs only | 126:B, 127:B, 131:B, 133:B | S | opus | - | stop rule, per-argument checks | gate |
| 136 | docs only | 126:B, 127:B, 128:B, 129:B, 130:B, 131:B, 132:B, 133:B | S | opus | - | stop rule | gate |
| 137 | EXISTS: swarm/packages/desktop/electron-builder.config.ts, EXISTS: .../electron-builder.config.test.ts, EXISTS: .../package.json, EXISTS: .../src/main/onboarding.ts (+ its test), EXISTS: .../datum-studio-host/protocol.ts:5 (decision only) | - | S | sonnet (fixed constants) | - | tests, Grep 1.2.1, bun.lock untouched | gate |
| 138 | NEW under EXISTS: docs/2026-11-06_swarm_1_2_0_datum_installer/implementation/: 26f recipe (from EXISTS: 26c_build_1_2_0.zsh:43-44) | - | S | sonnet (copy with version edit) | - | diff only versions | gate |
| 139 | docs only (runs in package dirs) | 134:B, 135:B, 136:B, 137:B | S | opus | heavy-host | typechecks, suites, 66 names | gate |
| 140 | git: swarm repo | 139:B | S | sonnet (scripted commit) | git index | clean tree, parent, no push | gate |
| 141 | NEW under EXISTS: tools/build/: desktop_<commit10> | 138:B, 140:B | S | sonnet (run recipe, report) | heavy-host, build lock, repo frozen | PASS, plist 1.2.1, sha | gate |
| 142 | docs only (reads the row 141 output) | 141:B | S | opus | - | codesign, sizes, runtime sha | gate |
| 143 | fixture HOME/XDG/userData NEW under EXISTS: /private/tmp/claude-501 (kept for 57, 71) | 142:B | S | opus | heavy-host, app window (one built app per fixture) | isolation, sums, PDFs | gate |
| 144 | fixture HOME/XDG/userData NEW under EXISTS: /private/tmp/claude-501 | 121:B, 142:B, 134:C | S | opus | heavy-host, app window, CDP port (loopback) | 3 widths, answer read back, isolation | gate |
| 145 | NEW under EXISTS: docs/.../test/: Kasus 07 mission addendum (frozen material untouched) | 88:B, 125:B | S | opus | - | tool names, data sha, synthetic | gate |
| 146 | fixture HOME/XDG/userData NEW under EXISTS: /private/tmp/claude-501/row146 | 56:B, 144:B, 145:B | M | opus | model endpoint (one run), real auth.json read once (U15), app window, CDP port | mission flow, 3 shots + export, key absent | gate |
| 147 | docs only (controller, user question) | 60:B | S | opus (controller) | - | U decision before 61 | gate |

Re-sequenced rows keep their earlier profile lines (size, model, ownership, resources). Only their dependencies change to the "New Depends On" column above, all of kind B. Row 58 is dropped.

### U24 widening: Studio quality in 1.2.1 (rows 148-163)

**Basis.** U24 (the user's own words: "Both in 1.2.1") adds three things:
- (A) an output verification gate;
- (B) a clear refusal when a diagram or chart is over capacity;
- (C) stronger engines: ELK.js for diagram layout, and Vega-Lite (or ECharts only where a needed type requires it) for missing chart types.

The classification stays **MINOR**: every row is S or M, and the scope is the user's own decision.

**Order.** A and B run alongside the mission control UI rows. In C, the facts and the security pre-review come first, then the single lockfile writer (row 161), then ELK (row 162) and Vega (row 163). Everything lands before the commit (row 140, through row 139). The E2E (row 146) must show a verified deliverable in mission control.

**Evidence checked in this pass (Glob, Grep).** Paths are under `swarm/packages/datum-studio/vendor/src/lib/studio/` unless stated.
- **Capacity:** `engine/diagram/build/capacity.ts` and `engine/diagram/core/estimate.ts` EXIST.
- **Diagram layout and routing:** `engine/diagram/layout-a/layered.ts:31` (`layoutLayered`), `engine/diagram/build/index.ts:36` (`routeEdges`), `engine/diagram/build/route.ts:235` (`routePlaced`).
- **Charts:** `engine/chart/core/render.ts:57` (`renderChart`), `services/render/figures.ts:100` (`chartSvg`), `registry/charts.ts`.
- **Lint:** `services/render/lint.ts` (the product guard, D-B) and `engine/diagram/fit/lint.ts`.
- **The render tool:** `studio_render` at `swarm/packages/datum-studio/vendor/scripts/studio/mcp/tools.ts:824`.
- **Bridge page scripts are allow-listed in desktop main:** `swarm/packages/desktop/src/main/datum-studio-host/start.ts:12, :18` (`STUDIO_BRIDGE_EXTRA_SCRIPTS`; C39).
- **Skill files:** `swarm/packages/desktop/datum/datum-house-style/SKILL.md` and `swarm/packages/desktop/datum/PROVENANCE.md` EXIST. The stage gate compares the skill to PROVENANCE (C87).
- **Package files:** `swarm/packages/datum-studio/package.json` and `swarm/bun.lock` EXIST.

**Two interactions that move U23 rows.**
1. `bun add` rewrites `bun.lock` and takes the workspace version from `package.json`. So row 137 no longer edits `bun.lock`: row 161 runs after it, and `bun.lock:402` becomes 1.2.1 through the regeneration.
2. Row 156 changes `SKILL.md`, which is the source of skillSha. The stage writes skillSha at build time (C49). Row 142's check now expects this one change.

| Step | Task Description | Agent_to_Invoke | Expected Output | Depends On | Verification | Phase |
|------|------------------|-----------------|-----------------|------------|--------------|-------|
| 148 | Write the output verification spec: report fields (Rev A lint on the output, per-page overlap/clipping via bridge checkPage, content fidelity of text/numbers/tables vs submitted content, page count, figure fit, empty required slots), unverified/verified output state, the mission rule (deliverable Final and row done only with verified outputs, tied to the 119a-d guard), the exact SKILL.md rule text, time and rate-limit cost (C73) (Tier 1) | data-analyst | masterplan/01_specs_output_verification.md | U24, 31, 119 | Each check names its engine function or bridge op with file:line; state transitions and refusal codes listed; SKILL.md text given verbatim; deliberately-broken cases defined for row 157 | masterplan |
| 149 | Add the output verification state to the store (migration 0004: one verification record per output file, store API read/write) | coder-execution | implementation/103_row149_verification_store.md | 148 | Migration 0004 applies on a 0003 store with counts unchanged; unit tests under bun and Electron Node; 0001-0003 files byte-identical | implementation |
| 150 | Implement the report checks that need no browser: Rev A lint on the output, page count, empty required slots, figure fit | coder-execution | implementation/104_row150_verify_static.md | 148 | One passing and one failing fixture per check; reuses services/render/lint.ts and fit/lint.ts (no copy); typecheck 0 new errors | implementation |
| 151 | Implement the per-page overlap/clipping check as a bridge page script plus its host-side caller | coder-execution | implementation/105_row151_verify_overlap.md | 148, 127 | Test through a bridge stub flags an overlapping and a clipped page; script name filed for row 152; no network | implementation |
| 152 | Add the row 151 script to the desktop bridge allow-list (STUDIO_BRIDGE_EXTRA_SCRIPTS) | coder-execution | implementation/106_row152_bridge_allowlist.md | 127, 151 | start.test.ts equality pin updated and passing; desktop typecheck exit 0; diff limited to the allow-list | implementation |
| 153 | Implement the content-fidelity diff: output text, numbers and tables against the submitted content | coder-execution | implementation/107_row153_verify_fidelity.md | 148 | Test: a dropped paragraph, a changed number and a missing table row are each reported with location; an exact render reports 0 differences | implementation |
| 154 | Wrap studio_render so it returns the verification report and records the verified/unverified state per output | coder-execution | implementation/108_row154_render_verify_wrapper.md | 149, 150, 151, 153 | Host test: render returns report; failing check leaves outputs unverified; vendored tools.ts byte-identical (wrapper via the row 119b hook) | implementation |
| 155 | Apply the mission rule: a deliverable shows Final and a row may go done only when its outputs are verified | coder-execution | implementation/109_row155_mission_verified_rule.md | 148, 149 | Refusal code of row 148 quoted for done-with-unverified; verified path passes; mission-tools and src/store suites green | implementation |
| 156 | Write the row 148 verification rule into the bundled SKILL.md with its PROVENANCE line | coder-execution | implementation/110_row156_skill_verify_rule.md | 148 | SKILL.md text equals row 148 verbatim; PROVENANCE line sha equals the new SKILL.md; check-datum-stage gate shows only the expected failures; Claude's folder unchanged | implementation |
| 157 | Test the verification gate end to end through the host, including a deliberately broken render (overlap, clipped page, dropped content) that must be caught and must keep the row from done | test-expert | implementation/111_row157_verification_tests.md | 152, 154, 155 | Every broken case reported unverified with its check named; row done refused; one mutation (gate bypassed) fails the suite | implementation |
| 158 | Make the diagram and chart engines refuse over-capacity input with a concrete suggestion (split, fewer nodes, max N) instead of squeezing, with tests | coder-execution | implementation/112_row158_capacity_refusal.md | U24 | Over-capacity fixture refused with the suggestion text and limits; at-capacity fixture renders unchanged (sha); provenance marks the patched vendor files | implementation |
| 159 | Collect licence and supply-chain facts for ELK.js, vega and vega-lite (ECharts only if a needed chart type requires it): exact versions, integrity hashes, licences, transitive packages, size, offline bundling into the Studio host chunk, the chart types the Rev A families lack; tarballs to scratch, nothing executed (Tier 1) | data-analyst | research/16_engine_deps.md | U24 | Each package has version, integrity, licence text path, size; ECharts need answered yes/no with the type; no conclusion on rights stated as legal fact | research |
| 160 | Security-review the row 159 package code as text before it is installed or run: install scripts, network, eval or Function use (vega expressions), file access | security-review | verification/18_row160_engine_deps_prereview.md | 159 | Findings table with severity; go/no-go per package; expression-evaluation mode decided; zero open High | verification |
| 161 | Add the approved packages to packages/datum-studio with exact pins under the lockfile lock (single lockfile writer) | coder-execution | implementation/113_row161_engine_deps.md | 137, 160 | bun.lock diff limited to the new packages and the :402 workspace version 1.2.1; integrity hashes equal row 159; no install script ran (log) | implementation |
| 162 | Implement the ELK layout adapter: ELK computes positions and orthogonal routes only; Studio keeps its SVG drawing and Rev A apparatus; record the B-O divergence as under U21 | coder-execution | implementation/114_row162_elk_layout.md | 161, 158 | Existing diagram tests and the CP-41 fixtures pass; recorded diff file written; bundled lint 27/27 on case 04 | implementation |
| 163 | Implement the Vega-Lite chart family for the missing types, themed to DATUM tokens, colour roles at most 5, SVG plus 1512 px PNG | coder-execution | implementation/115_row163_vega_charts.md | 159, 161 | One fixture per new type passes Rev A lint and the template guard; PNG 1512 px wide; no network at render (dead proxy) | implementation |

**Changes to the U23 rows (from U24)**

| Step | Change |
|---|---|
| 126 | Also exposes the verified state per deliverable (149:C) |
| 132 | Shows Verified or Unverified per deliverable; Final only when verified (148:C) |
| 134 | Fixtures include a verified and an unverified deliverable (155:C) |
| 135 | Also covers the verified-state write and the mission rule (151, 152, 154, 155 as B); size becomes M |
| 136 | Also reviews rows 149-158, 162, 163 (B); size becomes M |
| 139 | Adds 156, 157, 158, 160, 162, 163 as B deps |
| 144 | Also shows one verified and one unverified deliverable in the UI |
| 145 | Uses the row 148 report names (148:C) |
| 56, 113 | Diagram pairs changed by row 162 are reported as FIX-DIVERGENCE with the row 162 recorded diff (as U21); the score is never adjusted |
| 60 | Adds 157 and 158 as B deps |

**Execution Profile (U24 rows)**

| Step | Ownership Area | Deps (kind) | Size | Model | Shared Resources | Checks | Review |
|------|----------------|-------------|------|-------|------------------|--------|--------|
| 148 | docs only | 31:C, 119:C | M | opus | - | file:line per check, codes, verbatim skill text | gate |
| 149 | datum-studio store: NEW under EXISTS: swarm/packages/datum-studio/src/store/migrations/: 0004; EXISTS: .../src/store/studio-store.ts (sole writer this wave) | 148:B | S | opus | - | migration, bun+Electron, old migrations equal | gate |
| 150 | NEW under EXISTS: swarm/packages/datum-studio/src/mcp-host/: verify module (static checks); reads EXISTS: vendor services/render/lint.ts, engine/diagram/fit/lint.ts | 148:B | M | opus | - | pass/fail per check, reuse, typecheck | gate |
| 151 | same verify module: overlap page script + caller (separate file from row 150) | 148:B, 127:B | M | opus | - | overlap, clip, no network | gate |
| 152 | EXISTS: swarm/packages/desktop/src/main/datum-studio-host/start.ts:18 (+ start.test.ts) | 127:B, 151:C | S | sonnet (one allow-list entry) | - | pin test, typecheck, diff | gate |
| 153 | same verify module: fidelity diff (own file) | 148:B | M | opus | - | three defects found, exact = 0 | gate |
| 154 | NEW under EXISTS: swarm/packages/datum-studio/src/mcp-host/mission/ or verify module: render wrapper (executor declares) | 149:B, 150:B, 151:B, 153:B | M | opus | ports (host test) | report, unverified state, vendor untouched | gate |
| 155 | EXISTS: swarm/packages/datum-studio/src/store/mission/mission-store.ts; EXISTS: .../src/mcp-host/mission/mission-tools.ts | 148:B, 149:B | M | opus | - | refusal, verified pass, suites | gate |
| 156 | EXISTS: swarm/packages/desktop/datum/datum-house-style/SKILL.md, EXISTS: swarm/packages/desktop/datum/PROVENANCE.md | 148:B | S | sonnet (text from spec) | - | verbatim, PROVENANCE sha, gate | gate |
| 157 | test files NEW under EXISTS: swarm/packages/datum-studio/test/ | 152:B, 154:B, 155:B | M | opus | ports (host test) | broken caught, done refused, mutation | gate |
| 158 | vendor: EXISTS: engine/diagram/build/capacity.ts, EXISTS: engine/diagram/core/estimate.ts; chart capacity site UNKNOWN - executor declares (near EXISTS: engine/chart/core/render.ts) | - | M | opus | - | refusal text, at-capacity sha, provenance | gate |
| 159 | docs only; tarballs NEW under EXISTS: /private/tmp/claude-501 (row159) | - | M | opus | network (public registry metadata/tarballs only) | versions+integrity, licences, ECharts need | gate |
| 160 | docs only (reads the row 159 tarballs) | 159:B | S | opus | - | severity, go/no-go, eval mode | gate |
| 161 | EXISTS: swarm/packages/datum-studio/package.json, EXISTS: swarm/bun.lock | 137:B, 160:B | S | sonnet (pinned install, checkable) | lockfile, network (registry) | lock diff, integrity, no scripts | gate |
| 162 | NEW under EXISTS: vendor engine/diagram/: ELK adapter; layout selection in EXISTS: engine/diagram/layout-a/layered.ts or build/index.ts (executor declares) | 158:C, 161:B | M | opus | - | diagram tests + CP-41, recorded diff, lint | gate |
| 163 | NEW under EXISTS: vendor engine/chart/: Vega family; EXISTS: vendor registry/charts.ts | 159:B, 161:B | M | opus | - | lint+guard per type, 1512 px, offline | gate |

Profile changes for U23 rows: 126 gains 149:C; 132 gains 148:C; 134 gains 155:C; 135 becomes M with 151:B, 152:B, 154:B, 155:B; 136 becomes M with 149:B-158:B, 162:B, 163:B; 139 gains 156:B, 157:B, 158:B, 160:B, 162:B, 163:B; 145 gains 148:C; 60 gains 157:B, 158:B.

**Honesty of the profile (U23 and U24).**
- Sizes, models, waves and the budget are estimates.
- EXISTS paths were verified in this pass (the two evidence lists above). Counts: 33 EXISTS (all verified), 19 NEW-under, 3 UNKNOWN (row 134's fixture generator, row 154's exact folder, row 158's chart capacity site).
- Rows 125 and 148 may move an item into rows 126 or 149. Drivers declare exact paths in `file_claims.md` before writing.
- Single writers in a wave:
  - row 127 for `ipc.ts` and the preload;
  - row 152 for `start.ts`, after 127;
  - row 128 for `en.ts` and `id.ts`;
  - row 133 for `swarm-view.tsx`;
  - row 149 for `studio-store.ts`, before row 155;
  - row 161 for `bun.lock`, after 137 (its only writer in 1.2.1);
  - the verify module: rows 150, 151 and 153 each write their own file, and row 154 composes them.
- Vendor edits in rows 158, 162 and 163 are recorded in `vendor/provenance.json`, as rows 107 and 122 did.

### Cost statement (estimate, U23 + U24)

- **New rows: 39 (125-163).**
  - By size: 21 M (125, 127, 129, 130, 131, 133, 134, 135, 136, 146, 148, 150, 151, 153, 154, 155, 157, 158, 159, 162, 163) and 18 S.
  - By model: 31 opus (1 of them a controller row, 147) and 8 sonnet (128, 137, 138, 140, 141, 152, 156, 161).
  - Re-sequenced rows still to run: 13 (54 as a check only, 56, 57, 59, 60, 61, 62, 71, 113, 114, 115, 116, 121). Row 58 is dropped.
- **Waves (B edges only): 18.**

  | Wave | Rows |
  |---|---|
  | W1 | 125, 137, 138, 148, 158, 159 |
  | W2 | 126, 127, 128, 129, 145, 149, 150, 153, 156, 160 |
  | W3 | 130, 131, 132, 151, 155, 161 |
  | W4 | 133, 152, 154, 162, 163 |
  | W5 | 134, 135, 136, 157 |
  | W6 | 139 |
  | W7 | 140 |
  | W8 | 141 |
  | W9 | 142 |
  | W10 | 143, 114, 121 |
  | W11 | 56, 57, 71, 113, 144 |
  | W12 | 146 |
  | W13 | 59 |
  | W14 | 60, 115 |
  | W15 | 147 |
  | W16 | 61 |
  | W17 | 62 |
  | W18 | 116 |

  The widest wave is W2, with 10 rows. The controller may hold some of them back if the host load or its own mediation capacity requires it (CLAUDE.md §6).
- **Critical path:** 125-129-130-133-134-139-140-141-142-143-56-146-59-60-147-61-62-116.
  - Three chains now reach row 139 in W6 at the same depth, so a delay in any of them moves the release:
    - mission control UI: 125-129-130-133-134;
    - verification gate: 148-149/150/153-151-154-157;
    - engines: 159-160-161-162/163.
  - Levers:
    - Ask the row 147 question together with row 60's result. This saves one wave.
    - Launch rows 159 and 160 at once, because the engine chain carries the most risk (licences, vega eval mode).
    - If ELK misses its tests, row 162 can be dropped by a decision without blocking A or B.
    - Not recommended: starting row 146 before row 56.
- **Budget:** 21 x ~250k + 18 x ~100k = ~7.1M tokens for the new rows, plus ~1.8M for the re-sequenced rows, ~8.9M in total. The most expensive rows are 146 (E2E), 162 (ELK adapter), 153 (fidelity diff), 163 (Vega family) and 130 (HQ SVG).

### Pending decisions for the user

| # | Decision Required | Options | Recommended Option | Impact |
|---|-------------------|---------|-------------------|--------|
| 1 | In row 146, who presses the decision card in the mission control UI? The store records the answer as a `U` (user) decision | A: the controller clicks over CDP on your behalf under U23, and the decision text says so. B: you click it live during the run | A (no waiting; honest wording; contract limit L3 already accepts that the tool cannot prove who answered) | B is the stronger proof, but row 146 then waits for you |
| 2 | Install of 1.2.1 | Re-confirm at row 147 | Ask together with the row 60 result | Required by U23 |

---
*Last Updated: 2026-11-07 (U23 addendum: rows 125-147, row 58 dropped, verification re-sequenced onto the 1.2.1 build; U24 widening: rows 148-163)*
