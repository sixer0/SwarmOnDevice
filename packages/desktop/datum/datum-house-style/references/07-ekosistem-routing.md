# 07 · Routing di Swarm (Swarm routing note)

This file replaces the v1.7 "Ekosistem Routing & Migration Audit", which described Claude's own
skill ecosystem. In Swarm the question is not which sibling skill owns a task but which tool
makes which file. The rules for what the file must look like are in SKILL.md and references 01
to 06, 08 and 09; this note is about routes.

Sources: the GSP Writing Manual Rev A for the duties (citations **(ID p.N / EN p.N)**), and the
Swarm 1.2.0 decisions for the routes (D-C in C19; U6, U7, U10, U12, U13, C2, C4, C9, C28). Route
statements are **Swarm decisions, not manual text**.

---

## 1 · Which tool makes which file (decision D-C)

| Output | Made by | Notes |
|---|---|---|
| `.docx` report, proposal, kajian, sheet (lembar), notes on letterhead | **datum-studio MCP tools** | templates, chapters, slots, revisions, render, verify |
| HTML | datum-studio | judged through its PDF |
| PDF | datum-studio, Chromium print of Studio's HTML inside Swarm | always embeds fonts (DT-09) |
| SVG and PNG figures: charts and technical drawings | datum-studio figure tools and render | Word takes the 300 dpi PNG (DT-36, ID p.63 / EN p.66) |
| `.xlsx` workbook, RAB, BoQ | `scripts/datum_xlsx.py` (Rev A builder) | ship the font folder (DT-09); `references/04` |
| `.pptx` command brief | `scripts/datum_pptx.py` (Rev A builder) | slide figures are Studio PNGs [C28]; ship the font folder; `references/05` |
| NOTA (Markdown) | the normal file tools | title + ISO date file name (Table 2.3, ID p.11 / EN p.11) |
| Letter to a government body (Arial 12, black) | outside the DATUM templates | DT-32 (ID p.16 / EN p.16): if no Studio template fits, say so rather than forcing a DATUM layout |

The Python scripts run only with the bundled Python named in the Swarm note that precedes
SKILL.md, and write only into the user's project folder (or the folder the user names), never
inside the skill folder. The v1.7 engines `datum_docx.py`, `datum_diagram.py`, `datumchart.py`,
`datum_render.py` and `datum_symbols.py` remain in `scripts/` but were not brought to Rev A in
1.2.0; they are not a delivery route for DOCX, HTML, SVG or PDF.

---

## 2 · datum-studio: where it runs

- Studio runs **inside the Swarm desktop app**, which is the single writer of its store. Rendering
  uses Swarm's built-in Chromium. **When Swarm is not running, Studio is not available**, and the
  tools say so (U13, C4).
- The store keeps every document with its revisions and can be searched, so a document can be
  found and re-rendered at any time (U6).
- Swarm shows each tool to the model as `datum-studio_<tool>`, for example
  `datum-studio_studio_write`. (Claude Code on the same Mac reaches the same Studio through Swarm;
  its tool names follow Claude Code's own MCP naming.)
- Generated DOCX, PDF, HTML and SVG can be previewed in Swarm's file tabs; XLSX and PPTX have no
  preview in 1.2.0 (U12, C4).

---

## 3 · datum-studio tools

Each tool publishes its own input schema; `studio_registry` (kind `schema`) returns the JSON
schemas the chapter, slot and figure calls need. Do not guess field names.

**Documents and outputs (18):**

| Tool | Use |
|---|---|
| `studio_write` | one call that writes, checks, renders and verifies a document |
| `studio_edit` | patch-style edit of the latest revision |
| `studio_templates_list` | list the template set (shipped and user, archived hidden) |
| `studio_template_get` | the slot skeleton of a template before writing |
| `studio_document_create` | create a structured client document |
| `studio_chapter_import_markdown` | add or replace a chapter from Markdown (supports a dry run) |
| `studio_chapter_submit` | add or replace a chapter as JSON (supports a dry run) |
| `studio_slot_fill` | fill required DATUM parts: control sheet, signatures, references |
| `studio_document_structure` | reorder, outline, move to a newer template version |
| `studio_document_status` | completeness before render |
| `studio_document_get` | read a document or a given revision |
| `studio_render` | produce DOCX, HTML, PDF, SVG and PNG |
| `studio_file_verify` | check the checksum and download an output into the user's project |
| `studio_search` | full-text search across stored documents |
| `studio_contracts_query` | find by mission, document key, number, status or owner |
| `studio_figure_preview` | check one chart or drawing before a full render |
| `studio_figure_revise` | change one figure without resending its chapter |
| `studio_registry` | schemas and registries the other calls need |

**Templates (5):**

| Tool | Use |
|---|---|
| `studio_template_create` | new user template, slug `user-...`, from a shipped or user template |
| `studio_template_update` | new version of a user template; shipped templates are refused |
| `studio_template_check` | schema and DATUM guard check, saves nothing |
| `studio_template_preview` | render the template's sample to HTML, PDF or PNG |
| `studio_template_archive` | hide or restore a user template; nothing is deleted |

Shipped templates are read-only; user templates keep every version, and documents keep the
version they were made with (C2). **Form is locked**: colour, typography, page grid, checks,
classification and provenance keys and role formats cannot be changed through a template; the
guard refuses such a change (C9). Rev A is the form, not a template option.

### 3.1 Typical flows

1. **New document.** `studio_templates_list` → `studio_template_get` → `studio_document_create` →
   `studio_chapter_import_markdown` (dry run first) → `studio_slot_fill` (control sheet,
   signatures, references) → `studio_document_status` → `studio_render` → `studio_file_verify`
   into the user's project folder. Or `studio_write` for the whole path in one call.
2. **Change a document.** `studio_document_get` → `studio_edit` (or the chapter and slot tools
   with the revision number they expect) → `studio_render` → `studio_file_verify`.
3. **Find a document again.** `studio_search` or `studio_contracts_query`, then
   `studio_document_get`.
4. **One figure.** `studio_figure_preview` until it is right, then `studio_figure_revise`; the next
   render carries it. For a slide, render the PNG and place it with `datum_pptx.py` [C28].

Before delivery, read the checks and issues each write and render returns; do not deliver while
a WAJIB issue is open (DT-42a, ID p.79 / EN p.81).

---

## 4 · The duties every route keeps (Rev A)

- **Owner split (PK-03, ID p.7 / EN p.7).** The user (or the domain owner) supplies content,
  numbers and sources; DATUM supplies form, apparatus, classification and the gate. Content
  without a source goes back with one line naming the gap, or is labelled
  `[angka dari pemilik isi]` or "ilustratif", and the document stays DRAF. Right: a topology spec
  returned with "kapasitas tautan 4 tidak bersumber". Wrong: the writer fills in "10 Gbps"
  because it looks plausible (ID p.8).
- **Drawings and charts.** Rev A gives the decision whether a chart or drawing exists to
  gsp-visual-commander (9.1, ID p.54 / EN p.57); in Swarm make that decision yourself under
  Chapters 9 and 10. Two refusals still point in opposite directions: do not refuse a sound spec
  on taste, and do not invent a drawing (no family picked for show, no node added for balance, no
  unsourced quantity) [v1.7 principle, consistent with PK-03 and DT-01b].
- **Live screens** (interactive dashboards) are not document figures (9.1, ID p.54 / EN p.57).
- **Number before build, name, change log, land, fix at the source** (DT-04a, DT-12, PK-08, PK-09,
  PK-10, ID p.11-12 / EN p.11-12).
- **Tier first** (DT-02, ID p.10 / EN p.10); NOTA is the default.
- **Retired palette** navy #1A2B4A and gold #C9A84C never appear in any output (DT-07, ID p.48 /
  EN p.50).

---

## Perubahan dari v1.7

The whole v1.7 file described Claude's skill ecosystem; decision C34 makes this file the Swarm
routing note.

| # | v1.7 section | Rev A / Swarm | Source | Class |
|---|---|---|---|---|
| 07-1 | §1 position diagram (gsp-professional-documents, excel-master, gsp-presentation-maestro, gsp-visual-commander, gsp-ui-architect, domain specialists, veritas, knowledge-master) | Replaced by the tool routing of §1; those skills are not in Swarm | D-C, C34 | REMOVED |
| 07-2 | §1 handoff contract (caller supplies content, DATUM does not invent) | Kept as PK-03 | ID p.7 / EN p.7 | KEPT |
| 07-3 | §2 disambiguation table by skill | Replaced by §1 and §4 | D-C | REMOVED |
| 07-4 | §2a spec contract PRISMA → spec → datum_diagram.py | Spec contract kept in `references/08` (Table 10.1); producer in Swarm is Studio | ID p.62-63 / EN p.65-66; D-C | CHANGED |
| 07-5 | §3 migration audit (navy/gold and Calibri counts in 13 skills, priorities 1 to 4) | Removed: an audit of Claude's skills, not a rule. The rule behind it stays: DT-07, DT-08a | ID p.48, p.50 / EN p.50, p.52 | REMOVED |
| 07-6 | §4 migration edit paragraph | Removed (no sibling skills to edit) | C34 | REMOVED |
| 07-7 | §5 migration order | Removed | C34 | REMOVED |
| 07-8 | §6 skills DATUM calls (veritas, knowledge-master, gsp-visual-commander, excel-master) | Removed; the duties stay: look up changing facts (DT-29a, ID p.15-16), number audit (DT-23), drawing decision made under Chapters 9 and 10 | ID p.15-16, p.40, p.54 | REMOVED |
| 07-9 | §6b Mermaid drift and the diagram-authority paragraph | Rule kept as DT-35 (Mermaid drafts only, never shipped; lint 31) in `references/08` | ID p.70 / EN p.72 | REMOVED (narrative) |
| 07-10 | §7 skills that should call DATUM automatically, canvas-design | Removed; in Swarm DATUM is built in and auto-activates on any GSP document | C34, U2 | REMOVED |
| 07-11 | (none) | Studio tool map, template tools and form lock, typical flows | U7, U10, C2, C4, C9 | ADDED |
