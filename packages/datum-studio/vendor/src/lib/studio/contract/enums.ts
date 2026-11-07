/**
 * Doc Artifact Studio — enum kontrak (spesifikasi 01_specs.md §1.3, E01-E25).
 *
 * E01-E11 adalah cermin union dari enum Prisma (nilai sama persis dengan
 * prisma/schema.prisma); E12-E25 hanya hidup di TypeScript (tidak masuk DB).
 * Setiap enum diekspor sebagai larik `as const` (untuk validasi runtime dan
 * JSON Schema) plus tipe union turunannya.
 */

// ── E01-E11: cermin enum Prisma ──────────────────────────────────────────
export const STUDIO_TIERS = ["NOTA", "TERBIT", "SERAH"] as const;
export type StudioTier = (typeof STUDIO_TIERS)[number];

export const STUDIO_PARAM_CLASSES = ["B", "K", "T"] as const;
export type StudioParamClass = (typeof STUDIO_PARAM_CLASSES)[number];

export const STUDIO_RELEASE_STATUSES = ["PENDING", "PASS", "FAIL", "NOT_RUN"] as const;
export type StudioReleaseStatus = (typeof STUDIO_RELEASE_STATUSES)[number];

export const STUDIO_OUTPUT_FORMATS = ["DOCX", "PDF", "HTML", "SVG", "PNG"] as const;
export type StudioOutputFormat = (typeof STUDIO_OUTPUT_FORMATS)[number];

export const STUDIO_RENDER_JOB_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"] as const;
export type StudioRenderJobStatus = (typeof STUDIO_RENDER_JOB_STATUSES)[number];

export const STUDIO_ARTIFACT_KINDS = ["CHART", "DIAGRAM", "IMAGE", "HTML"] as const;
export type StudioArtifactKind = (typeof STUDIO_ARTIFACT_KINDS)[number];

export const STUDIO_TEMPLATE_KINDS = ["DOCUMENT", "CHART", "DIAGRAM", "IMAGE", "HTML"] as const;
export type StudioTemplateKind = (typeof STUDIO_TEMPLATE_KINDS)[number];

export const STUDIO_SECTION_GROUPS = ["DOCUMENT", "PAGE_DEVICE", "CHANNEL"] as const;
export type StudioSectionGroup = (typeof STUDIO_SECTION_GROUPS)[number];

export const STUDIO_SECTION_REGISTERS = ["WRAPPER", "INTERIOR", "NONE"] as const;
export type StudioSectionRegister = (typeof STUDIO_SECTION_REGISTERS)[number];

export const STUDIO_OUTPUT_ROLES = ["PRIMARY", "FIGURE"] as const;
export type StudioOutputRole = (typeof STUDIO_OUTPUT_ROLES)[number];

export const STUDIO_NUMBER_SOURCES = ["AGENT", "SEQUENCE"] as const;
export type StudioNumberSource = (typeof STUDIO_NUMBER_SOURCES)[number];

// ── E12-E25: hanya TypeScript ────────────────────────────────────────────

/** E12 — tanda provenans; glif U+25A0, U+25C8, U+25C7, U+25B3 (research/03:141). */
export const PROVENANCE_MARKS = ["TERUKUR", "DITURUNKAN", "PEMASOK", "ASUMSI"] as const;
export type ProvenanceMark = (typeof PROVENANCE_MARKS)[number];
export const PROVENANCE_GLYPHS: Readonly<Record<ProvenanceMark, string>> = {
  TERUKUR: "■",
  DITURUNKAN: "◈",
  PEMASOK: "◇",
  ASUMSI: "△",
};

/** E13 */
export const LINT_CHECK_STATUSES = ["PASS", "FAIL", "NOT_RUN", "REPORT"] as const;
export type LintCheckStatus = (typeof LINT_CHECK_STATUSES)[number];

/** E14 */
export const LINT_HQ_MODES = ["S", "R", "X", "M"] as const;
export type LintHqMode = (typeof LINT_HQ_MODES)[number];

/** E15 — A 39 DATUM, B 4 guard, C 19 bahasa, D 21 struktur, H 16 manusia. */
export const LINT_GROUPS = ["A", "B", "C", "D", "H"] as const;
export type LintGroup = (typeof LINT_GROUPS)[number];

/** Keluarga tabel (11 jenis blok berbentuk TableBlock, §3.4). */
export const TABLE_BLOCK_TYPES = [
  "table",
  "specTable",
  "registerTable",
  "exampleWrongRight",
  "ruleTable",
  "checklist",
  "glossary",
  "sourceRegister",
  "ruleIndex",
  "referenceScale",
  "financialTable",
] as const;
export type TableBlockType = (typeof TABLE_BLOCK_TYPES)[number];

/** Jenis blok figur (§3.4). */
export const FIGURE_BLOCK_TYPES = ["chart", "diagram", "image", "symbolSheet"] as const;
export type FigureBlockType = (typeof FIGURE_BLOCK_TYPES)[number];

/** 21 jenis blok isi (§3.4), berurutan sesuai tabel spesifikasi. */
export const CONTENT_BLOCK_TYPES = [
  "paragraph",
  "list",
  "aside",
  "monoBlock",
  "assumptionInline",
  ...TABLE_BLOCK_TYPES,
  "derivation",
  ...FIGURE_BLOCK_TYPES,
] as const;
export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number];

/** E16 — 21 blok isi + primitif tata letak `spacer`, `device` (KS-05). */
export const BLOCK_TYPES = [...CONTENT_BLOCK_TYPES, "spacer", "device"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** E17 */
export const STRUCTURAL_TYPES = [
  "cover",
  "controlSheet",
  "toc",
  "partDivider",
  "signatureBlock",
  "chapter",
  "section",
  "appendix",
] as const;
export type StructuralType = (typeof STRUCTURAL_TYPES)[number];

type N04 = "01" | "02" | "03" | "04";
type N08 = N04 | "05" | "06" | "07" | "08";
type N09 = N08 | "09";
type N10 = N09 | "10";
type N12 = N10 | "11" | "12";
type N15 = N12 | "13" | "14" | "15";
type N18 = N15 | "16" | "17" | "18";
/** E18 — 58 kode chart tergambar (P15, H9, K12, W10, S8, G4). */
export type DrawnChartCode = `P-${N15}` | `H-${N09}` | `K-${N12}` | `W-${N10}` | `S-${N08}` | `G-${N04}`;
/** E18 — 18 kode `DF-01..DF-18` (drawn=false). */
export type UndrawnChartCode = `DF-${N18}`;
/** E18 — union 76 kode chart. */
export type ChartCode = DrawnChartCode | UndrawnChartCode;

function codeRange<C extends string>(prefix: string, n: number): readonly C[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(2, "0")}` as C);
}

/** E18 — 58 kode tergambar, urutan kelompok P, H, K, W, S, G. */
export const DRAWN_CHART_CODES: readonly DrawnChartCode[] = [
  ...codeRange<DrawnChartCode>("P", 15),
  ...codeRange<DrawnChartCode>("H", 9),
  ...codeRange<DrawnChartCode>("K", 12),
  ...codeRange<DrawnChartCode>("W", 10),
  ...codeRange<DrawnChartCode>("S", 8),
  ...codeRange<DrawnChartCode>("G", 4),
];
/** E18 — 18 kode drawn=false. */
export const UNDRAWN_CHART_CODES: readonly UndrawnChartCode[] = codeRange<UndrawnChartCode>("DF", 18);
/** E18 — semua 76 kode. */
export const CHART_CODES: readonly ChartCode[] = [...DRAWN_CHART_CODES, ...UNDRAWN_CHART_CODES];

/** E19 */
export const DIAGRAM_FAMILIES = ["layered", "topology", "stack", "flow", "swimlane", "sequence", "sld", "rack", "graph"] as const;
export type DiagramFamily = (typeof DIAGRAM_FAMILIES)[number];

/** E20 */
export const DIAGRAM_SHAPES = [
  "box",
  "bus",
  "circle",
  "cylinder",
  "diamond",
  "doubled",
  "hexagon",
  "parallelogram",
  "shadowed",
  "stadium",
] as const;
export type DiagramShape = (typeof DIAGRAM_SHAPES)[number];

/** E21 */
export const DIAGRAM_EDGE_KINDS = ["accent", "alert", "control", "data", "sync", "verify"] as const;
export type DiagramEdgeKind = (typeof DIAGRAM_EDGE_KINDS)[number];

/** E22 — 41 id simbol berbentuk `dialek:nama` (research/03:288). */
export const SYMBOL_DIALECTS = ["iec", "isa", "sec", "mil"] as const;
export type SymbolDialect = (typeof SYMBOL_DIALECTS)[number];

/**
 * E23 — 76 RoleKey (§5.6, U01-U70 berurutan sesuai ID; U71-U76 = delta aditif FIX-TL D-351/D-352:
 * peran entri daftar isi section dan lampiran, gaya bawaan turunan dari peran bab efektif).
 */
export const ROLE_KEYS = [
  "cover.logo",
  "cover.addressLine",
  "cover.hairline",
  "wrapper.datumRule",
  "wrapper.kicker",
  "cover.titleFirst",
  "cover.titleLast",
  "cover.standfirst",
  "cover.scopeLine",
  "cover.identityString",
  "unit.sectionHolder",
  "front.kicker",
  "front.pageTitle",
  "controlSheet.blockHeading",
  "controlSheet.methodStatement",
  "toc.title",
  "toc.note",
  "part.title",
  "part.lede",
  "chapter.kicker",
  "chapter.datumRule",
  "chapter.title",
  "section.heading",
  "body.paragraph",
  "caption",
  "list.bullet",
  "list.number",
  "figure.paragraph",
  "figure.keyRow",
  "figure.source",
  "body.subheading",
  "wrapper.sealBand",
  "cover.controlLabel",
  "cover.controlValue",
  "cover.colophonLeft",
  "cover.colophonRight",
  "controlTable.header",
  "controlTable.cell",
  "signature.space",
  "toc.partLabel",
  "toc.partTitle",
  "toc.partPage",
  "toc.chapterLabel",
  "toc.chapterTitle",
  "toc.chapterPage",
  "part.chapterNo",
  "part.chapterTitle",
  "rail.prose",
  "cell.empty",
  "rail.mark",
  "rail.source",
  "rail.note",
  "table.headerLeft",
  "table.cellMono",
  "table.cellText",
  "table.source",
  "table.headerRight",
  "table.cellNumeralRight",
  "aside.label",
  "aside.body",
  "table.groupBand",
  "derivation.label",
  "derivation.intro",
  "derivation.expr",
  "derivation.value",
  "table.cellGlyph",
  "monoBlock.label",
  "spacer.afterBlock",
  "spacer.afterList",
  "spacer.generic",
  // FIX-TL (D-351/D-352): entri TOC section (indentasi tingkat 2, 1 pt lebih kecil) dan lampiran (bawaan = bab).
  "toc.sectionLabel",
  "toc.sectionTitle",
  "toc.sectionPage",
  "toc.appendixLabel",
  "toc.appendixTitle",
  "toc.appendixPage",
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** E24 — kode galat Studio (§6.3); peta HTTP ada di errors.ts. */
export const STUDIO_ERROR_CODES = [
  "UNAUTHORIZED",
  "PARAM_CLASS_K_FORBIDDEN",
  "PARAM_CLASS_T_READONLY",
  "PARAM_UNKNOWN_KEY",
  "SCHEMA_INVALID",
  "JSON_MALFORMED",
  "CHANGE_FIELDS_REQUIRED",
  "CHANGE_NOTE_REQUIRED",
  "ADDRESS_INVALID",
  "ADDRESS_NOT_FOUND",
  "DOCUMENT_NOT_FOUND",
  "REVISION_NOT_FOUND",
  "TEMPLATE_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
  "FILE_NOT_FOUND",
  "MISSION_REF_NOT_FOUND",
  "DOC_NUMBER_EXISTS",
  "TEMPLATE_SLUG_EXISTS",
  "REVISION_CONFLICT",
  "VERSION_CONFLICT",
  "RENDER_IN_PROGRESS",
  "BY_CONSTRUCTION_FAILED",
  "CHART_KIND_NOT_DRAWN",
  "CHART_KIND_UNKNOWN",
  "DATUM-31",
  "DATUM-39",
  "PAYLOAD_TOO_LARGE",
  "ASSET_TOO_LARGE",
  "ASSET_TYPE_UNSUPPORTED",
  "PATH_OUTSIDE_ROOT",
  "FILE_MISSING_ON_DISK",
  "PDF_ENGINE_UNAVAILABLE",
  "PDF_CONVERT_FAILED",
  "RENDER_TIMEOUT",
  "STORAGE_ROOT_FORBIDDEN",
  "REGISTRY_KIND_UNKNOWN",
  // Delta S03-d1 (aditif): S25 Chromium, S24 perakit HTML, S51 orkestrator render/penyimpanan.
  "BROWSER_UNAVAILABLE",
  "HTML_RENDER_FAILED",
  "RENDER_FAILED",
  "STORAGE_WRITE_FAILED",
  // Delta S03-d2 (aditif; IP-07, D-72): 403 generik untuk sesi sah tanpa hak
  // peran (mis. refresh render-env non-admin). Kelas K tetap PARAM_CLASS_K_FORBIDDEN.
  "FORBIDDEN",
  // Delta FIX-1 (aditif; S87 M-03, L-07): pembatas laju render per pemanggil
  // (429 + Retry-After), antrean render penuh (503 + Retry-After), dan badan
  // tulis dengan Content-Type selain JSON (415).
  "RATE_LIMITED",
  "RENDER_QUEUE_FULL",
  "UNSUPPORTED_MEDIA_TYPE",
  // Delta SR-04 (aditif; register 03_structural_sections_specs.md §11.2,
  // EC01-EC24): kontrak struktur v2 (slot, target, lingkup, pid, kelengkapan).
  "SLOT_UNKNOWN",
  "SLOT_REQUIRED_MISSING",
  "SLOT_DUPLICATE",
  "SLOT_POSITION_LOCKED",
  "SLOT_TYPE_MISMATCH",
  "SLOT_FORBIDDEN_FOR_TIER",
  "SLOT_INPUT_NOT_ACCEPTED",
  "SLOT_ITEMS_OUT_OF_RANGE",
  "BLOCK_TYPE_NOT_ADMITTED",
  "SLOT_USE_CHAPTER_ENDPOINT",
  "SLOT_PARAM_SCOPE_INVALID",
  "PARAM_SURFACE_FORBIDDEN",
  "PRESET_READONLY",
  "INLINE_FORMAT_REJECTED",
  "DOC_TARGET_AMBIGUOUS",
  "META_REQUIRED_FOR_CREATE",
  "META_CONFLICT",
  "TEMPLATE_MISMATCH",
  "SCOPE_CONFLICT",
  "PID_NOT_FOUND",
  "PID_CONFLICT",
  "ASSET_NOT_FOUND",
  "DOCUMENT_INCOMPLETE",
  "CHAPTER_KEY_INVALID",
  // Delta FIX-HR2 (aditif; D-332 C9, SR-56d): path `/api/studio/*` yang tidak cocok
  // route mana pun (catch-all `[[...notfound]]`, FIX-H6). 404.
  "ROUTE_NOT_FOUND",
  // Delta DC-05 (aditif; register 05_document_contract_specs.md §13.1, EC25-EC28, D-363):
  // rujukan kontrak (dokumen/revisi, pid), kunci butir ganda, dan bentuk chart.custom.
  "CONTRACT_REF_NOT_FOUND",
  "CONTRACT_REF_PID_NOT_FOUND",
  "CONTRACT_ITEM_KEY_DUPLICATE",
  "CHART_CUSTOM_FORM_UNSUPPORTED",
  // Swarm patch (row 69a, C78; templates spec §4): new document on an archived template. 403.
  "TEMPLATE_ARCHIVED",
] as const;
export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[number];

/** E25 */
export const CALLER_KINDS = ["ADMIN_SESSION", "USER_SESSION", "GOOGLE_SESSION", "INTERNAL_AGENT"] as const;
export type CallerKind = (typeof CALLER_KINDS)[number];

// ── Delta SR-04 (aditif; register 03_structural_sections_specs.md §3.3, §16.2) ──

/** E26 — cermin enum Prisma `StudioSlotContentMode`. */
export const STUDIO_SLOT_CONTENT_MODES = ["AUTO", "INPUT", "MIXED"] as const;
export type StudioSlotContentMode = (typeof STUDIO_SLOT_CONTENT_MODES)[number];

/** E27 — cermin enum Prisma `StudioRenderScopeKind`. */
export const STUDIO_RENDER_SCOPE_KINDS = ["DOCUMENT", "CHAPTER", "SLOT"] as const;
export type StudioRenderScopeKind = (typeof STUDIO_RENDER_SCOPE_KINDS)[number];

/** E28 — cermin enum Prisma `StudioCompleteness`. */
export const STUDIO_COMPLETENESS_STATUSES = ["INCOMPLETE", "COMPLETE"] as const;
export type StudioCompleteness = (typeof STUDIO_COMPLETENESS_STATUSES)[number];

/** E29 — state slot kelengkapan (§8.1). */
export const STUDIO_SLOT_STATES = ["FILLED", "AUTO_READY", "EMPTY", "PARTIAL", "OPTIONAL_EMPTY", "OMITTED"] as const;
export type StudioSlotState = (typeof STUDIO_SLOT_STATES)[number];

/** E30 — jenis identitas pid (M18 `kind`). */
export const STUDIO_IDENTITY_KINDS = ["CHAPTER", "SUBSECTION", "BLOCK"] as const;
export type StudioIdentityKind = (typeof STUDIO_IDENTITY_KINDS)[number];

/** E31 — lapis permukaan parameter (§13.5). */
export const PARAM_SURFACES = ["essential", "advanced", "derived", "internal"] as const;
export type ParamSurface = (typeof PARAM_SURFACES)[number];

/** E32 — jenis cakupan parameter (`document` | `section:<k>` | `shared:<g>` | `slot`). */
export const PARAM_SCOPE_KINDS = ["document", "section", "shared", "slot"] as const;
export type ParamScopeKind = (typeof PARAM_SCOPE_KINDS)[number];

/** E33 — op struktur R14 PATCH. */
export const STRUCTURE_OPS = [
  "reorder",
  "omitSlot",
  "restoreSlot",
  "setOutline",
  "setMeta",
  "renumberChapters",
  "templateVersion",
] as const;
export type StructureOp = (typeof STRUCTURE_OPS)[number];

/** E34 — op per pid R16 PATCH. */
export const PID_OPS = ["replace", "insertBefore", "insertAfter", "delete", "move"] as const;
export type PidOp = (typeof PID_OPS)[number];

/** E35 — kebijakan `ingest.inlineFormat` (R-38, D-138). */
export const INLINE_FORMAT_POLICIES = ["strip", "reject", "allow"] as const;
export type InlineFormatPolicy = (typeof INLINE_FORMAT_POLICIES)[number];

/** E36 — peran paragraf v2 (KD-16: 4 peran retoris dipertahankan untuk lint). */
export const PARAGRAPH_ROLES_V2 = ["body", "lede", "note", "subheading", "identity", "anchor", "pivot", "closingAction"] as const;
export type ParagraphRoleV2 = (typeof PARAGRAPH_ROLES_V2)[number];

/** E37 — penanda makna run v2. */
export const RUN_MARKS_V2 = ["strong", "em", "code", "sup", "sub"] as const;
export type RunMarkV2 = (typeof RUN_MARKS_V2)[number];

/** E38 — ukuran kertas (D-158). F4 215 x 330 mm = KC-11/KT-2 (nilai lazim Indonesia). */
export const PAPER_SIZES = ["A4", "A3", "A5", "Letter", "Legal", "F4"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];
/** E38 — [lebar, tinggi] mm orientasi potret. */
export const PAPER_SIZE_MM: Readonly<Record<PaperSize, readonly [number, number]>> = {
  A4: [210, 297],
  A3: [297, 420],
  A5: [148, 210],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  F4: [215, 330],
};

/** E39 */
export const PAGE_ORIENTATIONS = ["portrait", "landscape"] as const;
export type PageOrientation = (typeof PAGE_ORIENTATIONS)[number];

/** E40 — nama lingkup render di API (dipetakan ke E27). */
export const RENDER_SCOPE_NAMES = ["document", "chapter", "slot"] as const;
export type RenderScopeName = (typeof RENDER_SCOPE_NAMES)[number];

/** E41 — `checkId` issue `SCHEMA_INVALID` kontrak v2. */
export const SCHEMA_V2_CHECK_IDS = [
  "DISPLAY_FIELD",
  "V1_FIELD",
  "PID_OP_KIND",
  "SKELETON_POSITION",
  "SKELETON_SECTION_TYPE",
  "SKELETON_REPEATABLE",
  "SKELETON_CONTENT_MODE",
  "SKELETON_ADMITS",
  // Delta DC-05 (AM-04; register 05 §5.4, CH-01..CH-06): payload contractRecord, chart.custom, kerangka.
  "CONTRACT_ENUM",
  "CONTRACT_PATTERN",
  "CONTRACT_DATE",
  "CONTRACT_REF_TARGET",
  "CHART_CUSTOM_FORM",
  "SKELETON_CONTRACT_RECORD",
] as const;
export type SchemaV2CheckId = (typeof SCHEMA_V2_CHECK_IDS)[number];

/** E42 — sumber daftar bab yang diharapkan (§8.2). */
export const CHAPTER_EXPECTED_SOURCES = ["outline", "contiguous"] as const;
export type ChapterExpectedSource = (typeof CHAPTER_EXPECTED_SOURCES)[number];

/** E43 */
export const MARGIN_DENSITIES = ["compact", "standard", "wide"] as const;
export type MarginDensity = (typeof MARGIN_DENSITIES)[number];

// ── Delta DC-05 (aditif; register 05_document_contract_specs.md §4, §11.2, §13.2, §14.2, E44-E57) ──
// Kolom jenis/status di DB bertipe TEXT (KD-29); himpunan tertutup ditegakkan di sini dan di skema.

/** E44 — jenis kontrak aktif tahap 1 (CK-01; CK-02..CK-05 dicadangkan, tidak masuk enum, §1.2). */
export const CONTRACT_KINDS = ["agentWorkReport"] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** E45 — status laporan `agentWorkReport` (CS-01..CS-05, §4.1). */
export const AGENT_WORK_REPORT_STATUSES = ["draft", "complete", "partial", "blocked", "needs-review"] as const;
export type AgentWorkReportStatus = (typeof AGENT_WORK_REPORT_STATUSES)[number];

/** E46 — status butir `items[].status` (CI-01..CI-07, §4.2). */
export const CONTRACT_ITEM_STATUSES = ["todo", "ready", "running", "review", "done", "blocked", "cancelled"] as const;
export type ContractItemStatus = (typeof CONTRACT_ITEM_STATUSES)[number];

/** E47 — vonis (CD-01..CD-04, §4.3); huruf besar = bentuk korpus. */
export const CONTRACT_VERDICTS = ["PASS", "CAUTION", "FAIL", "NEEDS_REVIEW"] as const;
export type ContractVerdict = (typeof CONTRACT_VERDICTS)[number];

/** E48 — hubungan rujukan `refs[].rel`. */
export const CONTRACT_REF_RELS = ["basis", "evidence", "output", "supersedes"] as const;
export type ContractRefRel = (typeof CONTRACT_REF_RELS)[number];

/** E49 — jenis bukti `evidence[].kind`. */
export const CONTRACT_EVIDENCE_KINDS = ["file", "command", "commit", "correlation"] as const;
export type ContractEvidenceKind = (typeof CONTRACT_EVIDENCE_KINDS)[number];

/** E50 — kunci outline bab wajib (CO-01..CO-05 = chapterKey 1..5, §4.4). */
export const CONTRACT_OUTLINE_KEYS = ["ringkasan", "rincian", "bukti", "isu", "lanjut"] as const;
export type ContractOutlineKey = (typeof CONTRACT_OUTLINE_KEYS)[number];

/** E51 — `chart.custom` `form.mark` (§12). */
export const CHART_CUSTOM_MARKS = ["bar", "line", "point", "area"] as const;
export type ChartCustomMark = (typeof CHART_CUSTOM_MARKS)[number];

/** E52 — `chart.custom` `form.orientation` (bawaan `vertical`). */
export const CHART_CUSTOM_ORIENTATIONS = ["vertical", "horizontal"] as const;
export type ChartCustomOrientation = (typeof CHART_CUSTOM_ORIENTATIONS)[number];

// ── Delta FIG-03a (aditif; D-482 butir 2): medan maksud analitis blok chart v2 ──
// Konten, bukan tampilan: arah baca kategori, urutan, N teratas + "Lainnya", label sumbu
// singkat. Semua opsional; absen = perilaku mesin sebelum FIG-03a (byte-identik).

/** E58 — `ChartV2.orientation` (absen = `auto` = perilaku mesin, termasuk AUTO_ORIENT). */
export const CHART_INTENT_ORIENTATIONS = ["auto", "horizontal", "vertical"] as const;
export type ChartIntentOrientation = (typeof CHART_INTENT_ORIENTATIONS)[number];

/** E59 — `ChartV2.sort` (absen = `none` = urutan agen, D-368; P-01/P-04 tetap ikut templat). */
export const CHART_INTENT_SORTS = ["none", "desc", "asc"] as const;
export type ChartIntentSort = (typeof CHART_INTENT_SORTS)[number];

/** C61 — batas medan maksud chart (skema v2, skema v1 `intent`, dan pemeriksaan mesin). */
export const CHART_INTENT_LIMITS = {
  topNMin: 3,
  topNMax: 30,
  otherLabelMax: 40,
  labelShortMax: 32,
  labelShortItemsMax: 200,
} as const;

/** Label bawaan kategori gabungan `topN` (mesin menambah " (k)" = jumlah kategori yang digabung). */
export const CHART_INTENT_OTHER_LABEL = "Lainnya";

/** E53 — bucket kuota; urutan = urutan seri QH-04 (KD-38). */
export const QUOTA_BUCKETS = ["render", "validate", "import", "query"] as const;
export type QuotaBucket = (typeof QUOTA_BUCKETS)[number];

/** E54 — kode peringatan kontrak non-penahan (CW-01..CW-04, §13.2; bukan kode galat HTTP). */
export const CONTRACT_WARNING_CODES = [
  "CONTRACT_REF_PID_RETIRED",
  "CONTRACT_STATUS_UNMAPPED",
  "CONTRACT_HEADING_UNMAPPED",
  "CONTRACT_FIELD_UNMAPPED",
] as const;
export type ContractWarningCode = (typeof CONTRACT_WARNING_CODES)[number];

/** E55 — kode isu ekstraktor draf (DR-01..DR-08, §11.2). */
export const DRAFT_ISSUE_CODES = [
  "DRAFT_NO_JSON_BLOCK",
  "DRAFT_FENCE_UNCLOSED",
  "DRAFT_JSON_MALFORMED",
  "DRAFT_BLOCK_NOT_OBJECT",
  "DRAFT_SCHEMA_UNKNOWN",
  "DRAFT_HEADER_INCOMPLETE",
  "DRAFT_BASIS_INVALID",
  "DRAFT_BASIS_STALE",
] as const;
export type DraftIssueCode = (typeof DRAFT_ISSUE_CODES)[number];

/** E56 — `details.reason` 413 R23 (DR-09, DR-10). */
export const DRAFT_LIMIT_REASONS = ["DRAFT_TOO_LONG", "DRAFT_TOO_MANY_BLOCKS"] as const;
export type DraftLimitReason = (typeof DRAFT_LIMIT_REASONS)[number];

/** E57 — R10 `?name=` (bawaan: final bila dokumen ber-contractKind, selain itu DATUM; U-2). */
export const FINAL_NAME_MODES = ["final", "datum"] as const;
export type FinalNameMode = (typeof FINAL_NAME_MODES)[number];
