/**
 * Medan terlarang kontrak v2 (register 03_structural_sections_specs.md §5;
 * C29 `DISPLAY_FIELDS_GLOBAL`, C30 `DISPLAY_FIELDS_BY_LOCATION`, C31
 * `V1_FIELD_RENAMES`) dan pemeta galat ajv -> issue `SCHEMA_INVALID` ber-`checkId`
 * (`DISPLAY_FIELD` / `V1_FIELD`, E41).
 *
 * Skema v2 sudah menolak medan ini (`additionalProperties: false`); modul ini
 * hanya MENAMAI penolakan itu dengan pesan awam yang dapat diteruskan agen
 * apa adanya. Prioritas: V1_FIELD diperiksa sebelum DISPLAY_FIELD (§5.2).
 * Pemakai: ingest v2 (SR-12), validate R08 (SR-20), playground (SR-31).
 *
 * D-247 (FIX-S): `render` tidak lagi diterima di badan kiriman (SID01-SID03) maupun
 * sunting (R06/R14/R16); penolakannya dinamai `checkId: "RENDER_FIELD"` dengan pesan
 * yang menunjuk endpoint render (`renderFieldIssue`). Kode galat tetap
 * `SCHEMA_INVALID` (400), pola sama dengan DISPLAY_FIELD/V1_FIELD (E41).
 */
import { CHART_INTENT_LIMITS, CHART_INTENT_ORIENTATIONS, CHART_INTENT_SORTS, TABLE_BLOCK_TYPES } from "../../enums";
import type { ValidationIssue } from "../../types/api";
import { FIGURE_TEXT_CHECK_ID, FIGURE_TEXT_KEYWORD } from "./figure-text";

/** C29 — DF-01..DF-52: nama tidak sah di objek mana pun dalam SID01-SID03. */
export const DISPLAY_FIELDS_GLOBAL = [
  "face", // DF-01
  "faceRole", // DF-02
  "szHalfPt", // DF-03
  "color", // DF-04
  "caps", // DF-05
  "smallCaps", // DF-06
  "spacingTw", // DF-07
  "u", // DF-08
  "vertAlign", // DF-09
  "field", // DF-10
  "format", // DF-11
  "runDefaults", // DF-12
  "fieldFormats", // DF-13
  "headingFormat", // DF-14
  "signRowFormat", // DF-15
  "paragraphFormat", // DF-16
  "labelProps", // DF-17
  "setup", // DF-18
  "layout", // DF-19
  "widthTw", // DF-20
  "widthMm", // DF-21
  "heightMm", // DF-22
  "width_mm", // DF-23
  "colsTw", // DF-24
  "cellFormats", // DF-25
  "firstRowCell", // DF-26
  "rowCell", // DF-27
  "borders", // DF-28
  "marginsTw", // DF-29
  "shading", // DF-30
  "vAlign", // DF-31
  "cantSplit", // DF-32
  "repeatHeader", // DF-33
  "sourcePlacement", // DF-34
  "rowOrder", // DF-35
  "numberSeparator", // DF-36
  "apparatus", // DF-37
  "inDocument", // DF-38
  "gapMm", // DF-39
  "params", // DF-40
  "overrides", // DF-41
  "kicker", // DF-42
  "number", // DF-43
  "separator", // DF-44
  "align", // DF-45
  "marker", // DF-46
  "style", // DF-47
  "mode", // DF-48
  "sealBand", // DF-49
  "showChapterList", // DF-50
  "styleId", // DF-51
  "trailingFormat", // DF-52
] as const;

/** Satu entri DISPLAY_FIELD per lokasi (`location` = nama `$defs`/tipe v2). */
export interface DisplayFieldLocationRule {
  location: string;
  /** Lokasi tambahan dengan aturan sama (DF-72 berlaku di empat objek kontrak; DC-05). */
  alsoAt?: readonly string[];
  /** Nama medan terlarang di lokasi ini. */
  fields?: readonly string[];
  /** Nilai terlarang medan `valueField` (mis. `type`, `role`). */
  valueField?: "type" | "role";
  values?: readonly string[];
  reason: string;
}

/**
 * Petunjuk tampilan chart v1 yang tidak punya padanan konten di v2 (D-227): `axis`
 * (domain sumbu), `max` (skala P-09), `belowTargetColour`, `compassLabels`, `medianLabel`.
 * Medan data sah (`target`, `divider`, `binEdges`, `sectors`, `limit`) tidak termasuk.
 */
const CHART_DISPLAY_HINTS = ["axis", "max", "belowTargetColour", "compassLabels", "medianLabel"] as const;

/** C30 — DF-53..DF-73: nama/nilai sah di tempat lain, terlarang di lokasi ini. */
export const DISPLAY_FIELDS_BY_LOCATION: Readonly<Record<string, DisplayFieldLocationRule>> = {
  "DF-53": { location: "CaptionV2", fields: ["label"], reason: "label \"Tabel n.m\" milik mesin" },
  "DF-54": { location: "ChartV2", fields: ["columns"], reason: "tata letak komposit = parameter templat" },
  "DF-55": { location: "ChartV2", fields: ["title"], reason: "judul = caption" },
  "DF-56": {
    location: "PartV2",
    fields: ["label", "order", "body", "chapterKeys"],
    reason: "label milik mesin; keanggotaan bab lewat ChapterV2.partId",
  },
  "DF-57": { location: "SymbolSheetV2", fields: ["cols"], reason: "jumlah kolom lembar = parameter symbol.*" },
  "DF-58": { location: "TocPayloadV2", fields: ["title", "note"], reason: "judul/catatan = kenop templat" },
  "DF-59": { location: "ControlSheetPayloadV2", fields: ["kicker"], reason: "kicker = label slot" },
  "DF-60": { location: "BlockV2", valueField: "type", values: ["spacer", "device"], reason: "primitif tata letak tidak ada di v2" },
  "DF-61": {
    location: "ParagraphV2",
    valueField: "role",
    values: ["kicker", "pageTitle", "blockHeading", "addressLine", "title", "standfirst", "scopeLine", "methodStatement"],
    reason: "peran halaman depan",
  },
  "DF-62": { location: "RailLineV2", fields: ["label"], reason: "label rel = templat" },
  // DF-63..DF-69 (D-229): petunjuk tampilan chart v1 (D-227: domain sumbu, skala maks P-09,
  // warna, label arah/median) dan kelas lebar figur; lebar dan rupa figur diatur templat.
  "DF-63": { location: "ChartV2", fields: CHART_DISPLAY_HINTS, reason: "sumbu, skala, warna, dan label grafik diatur templat" },
  "DF-64": { location: "ChartPanelV2", fields: CHART_DISPLAY_HINTS, reason: "sumbu, skala, warna, dan label panel diatur templat" },
  "DF-65": { location: "ChartDataV2", fields: CHART_DISPLAY_HINTS, reason: "data grafik hanya berisi nilai; rupa diatur templat" },
  "DF-66": { location: "ImageV2", fields: ["widthClass"], reason: "lebar gambar = parameter templat image.widthClass" },
  "DF-67": { location: "SymbolSheetV2", fields: ["widthClass"], reason: "lebar lembar simbol = parameter templat symbolSheet.widthClass" },
  "DF-68": { location: "ChartV2", fields: ["widthClass"], reason: "lebar grafik = parameter templat chart.widthClass" },
  "DF-69": { location: "DiagramV2", fields: ["widthClass"], reason: "lebar diagram = parameter templat diagram.widthClass" },
  // DF-70..DF-71 (IP-63, FIX-S; pola FIX-5): kelas lebar panel komposit dan skala maks garis ambang.
  "DF-70": { location: "ChartPanelV2", fields: ["widthClass"], reason: "lebar panel grafik komposit = parameter templat chart.widthClass" },
  "DF-71": { location: "ChartLimit", fields: ["max"], reason: "garis ambang hanya berisi nilai dan label; skala sumbu diatur templat" },
  // DF-72..DF-73 (DC-05, AM-12; register 05 §5.5): susunan tabel catatan kontrak dan rupa chart.custom.
  "DF-72": {
    location: "ContractRecordPayloadV2",
    alsoAt: ["ContractItemV2", "ContractEvidenceV2", "ContractRefV2"],
    fields: ["label", "columns", "order", "heading"],
    reason: "label dan susunan tabel catatan diatur templat",
  },
  "DF-73": {
    location: "ChartCustomFormV2",
    fields: ["palette", "axis", "max", "width", "height", "legend"],
    reason: "rupa grafik kustom diatur templat",
  },
};

/** Satu entri V1_FIELD: medan v1 per lokasi (`locations` = nama `$defs`/tipe v2) dan penggantinya. */
export interface V1FieldRename {
  fields: ReadonlyArray<{ field: string; locations: readonly string[] }>;
  replacement: string;
}

/** Lokasi yang dihitung sebagai "blok" (setiap anggota BlockV2). */
const BLOCK_LOCATIONS = [
  "ParagraphV2",
  "ListV2",
  "AsideV2",
  "MonoBlockV2",
  "AssumptionInlineV2",
  "TableV2",
  "TableLeafV2",
  "DerivationV2",
  "ChartV2",
  "DiagramV2",
  "ImageV2",
  "SymbolSheetV2",
] as const;
const DOC_ROOT = ["StudioDocV2"] as const;
const one = (field: string, locations: readonly string[]) => [{ field, locations }];

/** C31 — VF-01..VF-14: medan v1 berganti nama di v2. */
export const V1_FIELD_RENAMES: Readonly<Record<string, V1FieldRename>> = {
  "VF-01": { fields: one("blockId", [...BLOCK_LOCATIONS, "ChapterV2", "SectionV2"]), replacement: "id" },
  "VF-02": { fields: one("b", ["RunV2"]), replacement: "strong" },
  "VF-03": { fields: one("i", ["RunV2"]), replacement: "em" },
  "VF-04": { fields: one("runningHeadTitle", ["ChapterV2"]), replacement: "shortTitle" },
  "VF-05": { fields: one("front", DOC_ROOT), replacement: "sections.<slotKey>" },
  "VF-06": { fields: one("parts", DOC_ROOT), replacement: "sections.<slot chapter>.parts" },
  "VF-07": { fields: one("chapters", DOC_ROOT), replacement: "sections.<slot chapter>.chapters" },
  "VF-08": { fields: one("appendices", DOC_ROOT), replacement: "sections.<slot appendix>.chapters" },
  "VF-09": { fields: one("outputs", DOC_ROOT), replacement: "POST /api/studio/documents/{id}/render (formats) sesudah kiriman tersimpan" },
  "VF-10": { fields: one("inline", ["CaptionV2", "SourceV2"]), replacement: "text atau runs langsung" },
  "VF-11": { fields: one("style", ["ListV2"]), replacement: "ordered" },
  "VF-12": { fields: one("accent", ["ChartDataV2"]), replacement: "highlight di blok chart" },
  "VF-13": { fields: one("kicker", ["CoverPayloadV2"]), replacement: "tagline" },
  "VF-14": {
    fields: [
      { field: "spec", locations: ["ChartV2"] },
      { field: "x", locations: BLOCK_LOCATIONS },
    ],
    replacement: "medan chart langsung di blok (spec hanya sah di diagram); x hanya di tingkat dokumen",
  },
};

// ── Pemeta galat ajv -> issue DISPLAY_FIELD / V1_FIELD ───────────────────

/** Pesan issue DISPLAY_FIELD (register §5.1, apa adanya). */
const DISPLAY_FIELD_MESSAGE = "medan tampilan tidak diterima; tampilan diatur templat";

/** D-247: satu-satunya pemicu build dokumen. */
export const RENDER_ENDPOINT = "POST /api/studio/documents/{id}/render";
/** `checkId` issue `SCHEMA_INVALID` untuk medan `render` di badan kiriman/sunting (D-247). */
export const RENDER_FIELD_CHECK_ID = "RENDER_FIELD";
/** Pesan awam yang dapat diteruskan agen apa adanya. */
export const RENDER_FIELD_MESSAGE =
  `render tidak diterima di kiriman atau sunting; build dokumen lewat ${RENDER_ENDPOINT} ` +
  "sesudah kiriman tersimpan (render penuh hanya bila completeness.fullRenderAllowed = true; render bab/slot = draf)";

/** Issue penolakan medan `render` (D-247). */
export function renderFieldIssue(pointer = "/render"): ValidationIssue {
  return { pointer, keyword: "additionalProperties", checkId: RENDER_FIELD_CHECK_ID, message: RENDER_FIELD_MESSAGE };
}

/**
 * Pesan tingkat atas galat `SCHEMA_INVALID`: bila salah satu issue = `RENDER_FIELD`,
 * pesan menunjuk endpoint render (D-247), selain itu `fallback`.
 */
export function schemaInvalidMessage(issues: readonly ValidationIssue[], fallback: string): string {
  return issues.some((i) => i.checkId === RENDER_FIELD_CHECK_ID) ? RENDER_FIELD_MESSAGE : fallback;
}

/** Lokasi akar kiriman yang dulu menerima `render` (SID01-SID03). */
const RENDER_FIELD_ROOTS: ReadonlySet<string> = new Set(["StudioDocV2", "StudioChapterV2", "StudioSlotV2"]);

/** Bentuk minimal galat ajv (tanpa bergantung pada tipe ajv; kontrak aman untuk klien). */
export interface AjvErrorLike {
  instancePath: string;
  keyword: string;
  params: object;
  message?: string;
}

/** Id skema v2 yang dipetakan pemeta ini. */
export type SchemaV2RootId = "studio.doc/v2" | "studio.chapter/v2" | "studio.slot/v2" | "studio.template/v2" | "studio.skeleton/v1";

const ROOT_LOCATION: Readonly<Record<SchemaV2RootId, string>> = {
  "studio.doc/v2": "StudioDocV2",
  "studio.chapter/v2": "StudioChapterV2",
  "studio.slot/v2": "StudioSlotV2",
  "studio.template/v2": "StudioTemplateV2",
  "studio.skeleton/v1": "StudioSkeletonV1",
};

const SLOT_PAYLOAD_BY_TYPE: Readonly<Record<string, string>> = {
  cover: "CoverPayloadV2",
  controlSheet: "ControlSheetPayloadV2",
  signatureBlock: "SignaturePayloadV2",
  toc: "TocPayloadV2",
  sourceRegister: "SourceRegisterPayloadV2",
  ruleIndex: "RuleIndexPayloadV2",
  chapter: "ContentSlotPayloadV2",
  appendix: "AppendixSlotPayloadV2",
  contractRecord: "ContractRecordPayloadV2",
};

const TABLE_TYPES: ReadonlySet<string> = new Set<string>(TABLE_BLOCK_TYPES);
const BLOCK_BY_TYPE: Readonly<Record<string, string>> = {
  paragraph: "ParagraphV2",
  list: "ListV2",
  aside: "AsideV2",
  monoBlock: "MonoBlockV2",
  assumptionInline: "AssumptionInlineV2",
  derivation: "DerivationV2",
  chart: "ChartV2",
  diagram: "DiagramV2",
  image: "ImageV2",
  symbolSheet: "SymbolSheetV2",
};

/**
 * Peta anak per lokasi: properti -> lokasi anak; indeks larik transparan.
 * `@block` = jenis blok dari `type`; `@slot` = payload slot dari `type`;
 * `@slotMap` / `@map:<L>` = peta berkunci bebas; `@listOrTable:<L>` = larik
 * entri `L` atau objek TableV2; `*` + `@same` = semua turunan tetap lokasi ini.
 */
const CHILD: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  StudioDocV2: {
    meta: "DocMetaV2",
    structure: "Structure",
    sections: "@slotMap",
    register: "@map:RegisterEntry",
    assets: "@map:AssetInputV2",
    change: "ChangeV2",
    mission: "MissionRef",
    template: "TemplateRef",
  },
  StudioChapterV2: {
    target: "DocTargetV2",
    template: "TemplateRef",
    meta: "DocMetaV2",
    chapter: "ChapterV2",
    register: "@map:RegisterEntry",
    assets: "@map:AssetInputV2",
    change: "ChangeV2",
  },
  StudioSlotV2: {
    target: "DocTargetV2",
    template: "TemplateRef",
    meta: "DocMetaV2",
    payload: "@slot",
    register: "@map:RegisterEntry",
    assets: "@map:AssetInputV2",
    change: "ChangeV2",
  },
  StudioTemplateV2: { skeleton: "Skeleton", preset: "PresetRef" },
  StudioSkeletonV1: { slots: "TemplateSlotDef" },
  Skeleton: { slots: "TemplateSlotDef" },
  DocTargetV2: { mission: "MissionRef" },
  CoverPayloadV2: {
    tagline: "InlineV2",
    titleLines: "InlineV2",
    standfirst: "InlineV2",
    scopeLine: "InlineV2",
    addressLine: "InlineV2",
    control: "InlineV2",
    colophon: "Colophon",
    identityString: "InlineV2",
  },
  Colophon: { left: "InlineV2", right: "InlineV2" },
  ControlSheetPayloadV2: {
    title: "InlineV2",
    methodStatement: "InlineV2",
    revisionHistory: "@listOrTable:RevisionEntryV2",
    verificationChain: "@listOrTable:VerificationEntryV2",
    distribution: "@listOrTable:DistributionEntryV2",
  },
  SignaturePayloadV2: { roles: "SignatureRole" },
  SignatureRole: { role: "InlineV2", holder: "InlineV2", date: "InlineV2" },
  ContentSlotPayloadV2: { outline: "OutlineEntryV2", parts: "PartV2", chapters: "ChapterV2" },
  AppendixSlotPayloadV2: { outline: "OutlineEntryV2", chapters: "ChapterV2" },
  TocPayloadV2: { entries: "TocEntry" },
  TocEntry: { label: "InlineV2", title: "InlineV2" },
  SourceRegisterPayloadV2: { entries: "SourceRegisterEntry" },
  SourceRegisterEntry: { citation: "InlineV2" },
  OutlineEntryV2: { title: "InlineV2" },
  PartV2: { title: "InlineV2", lede: "InlineV2" },
  ChapterV2: { title: "InlineV2", intro: "@block", sections: "SectionV2" },
  SectionV2: { title: "InlineV2", blocks: "@block" },
  InlineV2: { runs: "RunV2" },
  CaptionV2: { runs: "RunV2" },
  SourceV2: { runs: "RunV2" },
  RailLineV2: { runs: "RunV2" },
  ParagraphV2: { runs: "RunV2", rail: "RailLineV2" },
  ListV2: { items: "ListItemV2" },
  ListItemV2: { runs: "RunV2", rail: "RailLineV2" },
  AsideV2: { label: "InlineV2", body: "InlineV2" },
  MonoBlockV2: { label: "InlineV2", lines: "InlineV2" },
  AssumptionInlineV2: { runs: "RunV2" },
  TableV2: { caption: "CaptionV2", columns: "ColumnV2", rows: "RowV2", source: "SourceV2" },
  RowV2: { cells: "CellV2" },
  CellV2: { runs: "RunV2", paragraphs: "InlineV2", nested: "TableV2" },
  DerivationV2: {
    title: "InlineV2",
    intro: "InlineV2",
    closing: "InlineV2",
    lines: "DerivationLine",
    result: "DerivationResult",
    verdict: "DerivationVerdict",
  },
  DerivationLine: { label: "InlineV2", value: "InlineV2" },
  DerivationResult: { label: "InlineV2" },
  DerivationVerdict: { label: "InlineV2" },
  ChartV2: {
    data: "ChartDataV2",
    panels: "ChartPanelV2",
    caption: "CaptionV2",
    source: "SourceV2",
    keyRow: "InlineV2",
    limit: "ChartLimit",
    form: "ChartCustomFormV2",
    labelShort: "ChartLabelShortV2",
  },
  // Delta DC-05 (register 05 §5.3): payload contractRecord.
  ContractRecordPayloadV2: { phase: "ContractPhaseV2", refs: "ContractRefV2", evidence: "ContractEvidenceV2", items: "ContractItemV2" },
  ContractItemV2: { title: "InlineV2" },
  ContractEvidenceV2: { note: "InlineV2" },
  ChartPanelV2: { data: "ChartDataV2", limit: "ChartLimit" },
  ChartDataV2: { spec: "DiagramSpecV2", "*": "@same" },
  DiagramSpecV2: { "*": "@same" },
  DiagramV2: { spec: "DiagramSpecV2", caption: "CaptionV2", source: "SourceV2", keyRow: "InlineV2" },
  ImageV2: { caption: "CaptionV2", source: "SourceV2", keyRow: "InlineV2" },
  SymbolSheetV2: { caption: "CaptionV2", source: "SourceV2", keyRow: "InlineV2" },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function blockLocation(node: unknown): string {
  const t = isRecord(node) && typeof node.type === "string" ? node.type : "";
  if (TABLE_TYPES.has(t)) return "TableV2";
  return BLOCK_BY_TYPE[t] ?? "BlockV2";
}

function slotLocation(node: unknown): string {
  const t = isRecord(node) && typeof node.type === "string" ? node.type : "";
  return SLOT_PAYLOAD_BY_TYPE[t] ?? "SlotPayloadV2";
}

/** Dekode segmen JSON Pointer (RFC 6901). */
function pointerSegments(pointer: string): string[] {
  if (!pointer) return [];
  return pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function escapeSegment(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Lokasi (nama tipe v2) objek pada `instancePath` di `data`. Ditentukan dari
 * struktur kiriman, bukan `schemaPath` ajv (yang tidak memuat nama `$defs` untuk
 * `$ref` yang dikompilasi terpisah). `"?"` bila tidak dikenali.
 */
export function locateSchemaV2Object(rootId: SchemaV2RootId, data: unknown, instancePath: string): string {
  let loc = ROOT_LOCATION[rootId];
  let node: unknown = data;
  // Lokasi elemen berikutnya bila node saat ini larik/peta.
  let pending: string | null = null;
  for (const seg of pointerSegments(instancePath)) {
    if (Array.isArray(node)) {
      node = node[Number(seg)];
      if (pending === "@block") {
        loc = blockLocation(node);
        pending = null;
      }
      continue;
    }
    const next: unknown = isRecord(node) ? node[seg] : undefined;
    if (pending !== null) {
      // Segmen = kunci peta (sections.<slotKey>, register.<k>, assets.<k>).
      node = next;
      loc = pending === "@slot" ? slotLocation(node) : pending;
      pending = null;
      continue;
    }
    const children = CHILD[loc] ?? {};
    const rule = children[seg] ?? children["*"];
    node = next;
    if (rule === undefined) return "?";
    if (rule === "@same") continue;
    if (rule === "@block") {
      if (Array.isArray(node)) pending = "@block";
      else loc = blockLocation(node);
    } else if (rule === "@slot") {
      loc = slotLocation(node);
    } else if (rule === "@slotMap") {
      pending = "@slot";
      loc = "SectionsMap";
    } else if (rule.startsWith("@map:")) {
      pending = rule.slice("@map:".length);
      loc = "Map";
    } else if (rule.startsWith("@listOrTable:")) {
      loc = Array.isArray(node) ? rule.slice("@listOrTable:".length) : "TableV2";
    } else {
      loc = rule;
    }
  }
  return loc;
}

function valueAt(data: unknown, pointer: string): unknown {
  let node = data;
  for (const seg of pointerSegments(pointer)) {
    if (Array.isArray(node)) node = node[Number(seg)];
    else if (isRecord(node)) node = node[seg];
    else return undefined;
  }
  return node;
}

function v1Rename(field: string, loc: string): string | null {
  for (const rule of Object.values(V1_FIELD_RENAMES)) {
    for (const f of rule.fields) if (f.field === field && f.locations.includes(loc)) return rule.replacement;
  }
  return null;
}

function displayByLocation(field: string, loc: string): boolean {
  return Object.values(DISPLAY_FIELDS_BY_LOCATION).some(
    (r) => (r.location === loc || (r.alsoAt ?? []).includes(loc)) && (r.fields ?? []).includes(field),
  );
}

function displayValue(valueField: "type" | "role", value: unknown, loc: string): boolean {
  if (typeof value !== "string") return false;
  return Object.values(DISPLAY_FIELDS_BY_LOCATION).some(
    (r) => r.valueField === valueField && r.location === loc && (r.values ?? []).includes(value),
  );
}

const GLOBAL_DF: ReadonlySet<string> = new Set<string>(DISPLAY_FIELDS_GLOBAL);

function genericMessage(e: AjvErrorLike): string {
  const p = e.params as Record<string, unknown>;
  if (e.keyword === "additionalProperties" && typeof p.additionalProperty === "string") {
    return `${e.message ?? "additionalProperties"}: "${p.additionalProperty}"`;
  }
  if (e.keyword === "enum" && Array.isArray(p.allowedValues)) {
    return `${e.message ?? "enum"}: ${p.allowedValues.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return e.message ?? e.keyword;
}

// ── Delta DC-05: checkId kontrak + chart.custom (register 05 §5.4, CH-01..CH-05) ──
// Pemetaan per lokasi objek + nama medan (bukan schemaPath ajv). CH-03 kalender
// (mis. 2026-02-30 lolos pola) = pemeriksaan murni pasca-ajv milik I54 (DC-07).
// CH-06 (kerangka templat) dipancarkan validator kerangka (registri slot, DC-06).

const CONTRACT_LOCATIONS: ReadonlySet<string> = new Set([
  "ContractRecordPayloadV2",
  "ContractPhaseV2",
  "ContractRefV2",
  "ContractEvidenceV2",
  "ContractItemV2",
]);
/** Medan bernilai enum E45-E49 di objek kontrak. */
const CONTRACT_ENUM_FIELDS: ReadonlySet<string> = new Set(["status", "verdict", "rel", "kind"]);
/** Medan tanggal (C37 / `isoDate`). */
const CONTRACT_DATE_FIELDS: ReadonlySet<string> = new Set(["reportedAt", "due"]);
const CHART_CUSTOM_PAIR_FIELDS: ReadonlySet<string> = new Set(["form", "data", "panels", "artifactId"]);

const CONTRACT_REF_TARGET_MESSAGE = "rujukan wajib memuat tepat satu dari documentId atau docNumber";

/** Induk + nama medan untuk galat bernilai (indeks larik di ujung dilewati: `cardIds/0` -> `cardIds`). */
function valueField(instancePath: string): { parent: string; field: string } | null {
  const segs = pointerSegments(instancePath);
  let i = segs.length - 1;
  while (i >= 0 && /^\d+$/.test(segs[i])) i--;
  if (i < 0) return null;
  const parent = segs.slice(0, i).map(escapeSegment).join("/");
  return { parent: parent ? `/${parent}` : "", field: segs[i] };
}

/** Pelanggaran pasangan `code = "custom"` / `form` pada satu ChartV2 (pointer relatif chart). */
function chartCustomProblems(node: unknown): Array<{ suffix: string; message: string }> {
  if (!isRecord(node)) return [];
  const out: Array<{ suffix: string; message: string }> = [];
  if (node.code === "custom") {
    if (node.form === undefined) out.push({ suffix: "/form", message: "chart custom wajib memuat form" });
    if (node.panels !== undefined) out.push({ suffix: "/panels", message: "chart custom tidak menerima panels" });
    if (node.artifactId !== undefined) out.push({ suffix: "/artifactId", message: "chart custom tidak menerima artifactId" });
    if (node.data === undefined) out.push({ suffix: "/data", message: "chart custom wajib memuat data" });
  } else if (node.form !== undefined) {
    out.push({ suffix: "/form", message: 'form hanya diterima bila code = "custom"' });
  }
  return out;
}

/** Medan `line`/`exitCode` pada jenis bukti yang salah (CH-04). */
function evidenceTargetProblems(node: unknown): Array<{ suffix: string; message: string }> {
  if (!isRecord(node)) return [];
  const out: Array<{ suffix: string; message: string }> = [];
  if (node.kind !== "file" && node.line !== undefined) out.push({ suffix: "/line", message: 'line hanya untuk bukti kind "file"' });
  if (node.kind !== "command" && node.exitCode !== undefined) {
    out.push({ suffix: "/exitCode", message: 'exitCode hanya untuk bukti kind "command"' });
  }
  return out;
}

function enumList(p: Record<string, unknown>): string {
  return Array.isArray(p.allowedValues) ? p.allowedValues.map((v) => JSON.stringify(v)).join(", ") : "";
}

// ── Delta FIG-03a (D-482 butir 2): medan maksud analitis blok chart -> `CHART_INTENT` ──

const L = CHART_INTENT_LIMITS;
const quoted = (xs: readonly string[]) => xs.map((x) => JSON.stringify(x)).join(", ");
/** Pesan awam per medan maksud (pointer = medan yang salah). */
const CHART_INTENT_MESSAGES: Readonly<Record<string, string>> = {
  orientation: `orientation tidak sah; pakai salah satu: ${quoted(CHART_INTENT_ORIENTATIONS)}`,
  sort: `sort tidak sah; pakai salah satu: ${quoted(CHART_INTENT_SORTS)}`,
  topN: `topN harus bilangan bulat ${L.topNMin}..${L.topNMax} (contoh: "topN": 8)`,
  otherLabel: `otherLabel harus teks 1..${L.otherLabelMax} karakter dan hanya bersama topN`,
  labelShort: `labelShort harus larik 1..${L.labelShortItemsMax} pasangan { "label": <kategori yang ada>, "short": <maks ${L.labelShortMax} karakter> }`,
  label: "labelShort[].label wajib teks 1..200 karakter yang sama persis dengan label kategori data",
  short: `labelShort[].short wajib teks 1..${L.labelShortMax} karakter`,
};

/** Issue `CHART_INTENT` untuk galat ajv pada medan maksud chart; `null` = bukan medan maksud. */
function chartIntentIssue(rootId: SchemaV2RootId, data: unknown, e: AjvErrorLike, prefix: string): ValidationIssue | null {
  const p = e.params as Record<string, unknown>;
  const at = (pointer: string, message: string): ValidationIssue => ({ pointer: prefix + pointer, keyword: e.keyword, checkId: "CHART_INTENT", message });
  const here = locateSchemaV2Object(rootId, data, e.instancePath);
  if (e.keyword === "dependentRequired" && here === "ChartV2" && p.property === "otherLabel") {
    return at(`${e.instancePath}/otherLabel`, "otherLabel hanya diterima bersama topN");
  }
  if (here === "ChartLabelShortV2") {
    if (e.keyword === "required" && typeof p.missingProperty === "string" && CHART_INTENT_MESSAGES[p.missingProperty]) {
      return at(`${e.instancePath}/${p.missingProperty}`, CHART_INTENT_MESSAGES[p.missingProperty]);
    }
    if (e.keyword === "additionalProperties") return at(e.instancePath, 'labelShort[] hanya berisi "label" dan "short"');
    if (e.keyword === "type" || e.keyword === "minItems" || e.keyword === "maxItems") return at(e.instancePath, CHART_INTENT_MESSAGES.labelShort);
  }
  const vf = valueField(e.instancePath);
  if (vf === null || !CHART_INTENT_MESSAGES[vf.field]) return null;
  const parent = locateSchemaV2Object(rootId, data, vf.parent);
  const intentField = parent === "ChartV2" && vf.field !== "label" && vf.field !== "short";
  const pairField = parent === "ChartLabelShortV2" && (vf.field === "label" || vf.field === "short");
  if (!intentField && !pairField) return null;
  return at(e.instancePath, CHART_INTENT_MESSAGES[vf.field]);
}

/**
 * Issue ber-checkId kontrak (CH-01..CH-05) untuk satu galat ajv; `null` = bukan galat kontrak
 * (diteruskan ke pemetaan generik). Keyword issue dibakukan per kelompok agar galat ajv
 * kembar (oneOf + required) terdedup menjadi satu issue.
 */
function classifyContractError(rootId: SchemaV2RootId, data: unknown, e: AjvErrorLike, prefix: string): ValidationIssue[] | null {
  const p = e.params as Record<string, unknown>;
  if (e.keyword === "enum" || e.keyword === "pattern") {
    const vf = valueField(e.instancePath);
    if (vf === null) return null;
    const loc = locateSchemaV2Object(rootId, data, vf.parent);
    const pointer = prefix + e.instancePath;
    if (CONTRACT_LOCATIONS.has(loc)) {
      if (e.keyword === "enum" && CONTRACT_ENUM_FIELDS.has(vf.field)) {
        return [{ pointer, keyword: e.keyword, checkId: "CONTRACT_ENUM", message: `kode kontrak tidak sah; pakai salah satu: ${enumList(p)}` }];
      }
      if (e.keyword === "pattern" && CONTRACT_DATE_FIELDS.has(vf.field)) {
        const shape = vf.field === "reportedAt" ? "YYYY-MM-DD atau waktu ISO ber-zona (mis. 2026-10-30T19:30+07:00)" : "YYYY-MM-DD";
        return [{ pointer, keyword: e.keyword, checkId: "CONTRACT_DATE", message: `tanggal tidak sah; pakai ${shape}` }];
      }
      if (e.keyword === "pattern") {
        return [{ pointer, keyword: e.keyword, checkId: "CONTRACT_PATTERN", message: `format tidak sah; harus cocok pola ${String(p.pattern)}` }];
      }
      return null;
    }
    if (e.keyword === "enum" && loc === "ChartCustomFormV2") {
      return [{ pointer, keyword: e.keyword, checkId: "CHART_CUSTOM_FORM", message: `nilai form tidak sah; pakai salah satu: ${enumList(p)}` }];
    }
    if (e.keyword === "enum" && loc === "ChartPanelV2" && vf.field === "code" && valueAt(data, e.instancePath) === "custom") {
      return [{ pointer, keyword: e.keyword, checkId: "CHART_CUSTOM_FORM", message: "chart custom tidak diterima di panel komposit" }];
    }
    return null;
  }
  const loc = locateSchemaV2Object(rootId, data, e.instancePath);
  const base = prefix + e.instancePath;
  if (loc === "ContractRefV2") {
    const missing = e.keyword === "required" ? p.missingProperty : undefined;
    if (e.keyword === "oneOf" || missing === "documentId" || missing === "docNumber") {
      return [{ pointer: base, keyword: "oneOf", checkId: "CONTRACT_REF_TARGET", message: CONTRACT_REF_TARGET_MESSAGE }];
    }
    return null;
  }
  if (loc === "ContractEvidenceV2" && (e.keyword === "not" || e.keyword === "if")) {
    const probs = evidenceTargetProblems(valueAt(data, e.instancePath));
    if (probs.length === 0) return null;
    return probs.map((x) => ({ pointer: base + x.suffix, keyword: "not", checkId: "CONTRACT_REF_TARGET", message: x.message }));
  }
  if (loc === "ChartV2") {
    const pair =
      e.keyword === "if" ||
      e.keyword === "not" ||
      e.keyword === "oneOf" ||
      (e.keyword === "required" && typeof p.missingProperty === "string" && CHART_CUSTOM_PAIR_FIELDS.has(p.missingProperty));
    if (!pair) return null;
    const probs = chartCustomProblems(valueAt(data, e.instancePath));
    if (probs.length === 0) return null;
    return probs.map((x) => ({ pointer: base + x.suffix, keyword: "if", checkId: "CHART_CUSTOM_FORM", message: x.message }));
  }
  return null;
}

/**
 * Petakan galat ajv skema v2 ke `ValidationIssue`:
 * - medan v1 berganti nama (C31) -> `checkId: "V1_FIELD"`, pesan
 *   "medan v1 tidak diterima di v2; pakai <pengganti>" (diperiksa lebih dulu);
 * - `render` di akar kiriman (D-247) -> `checkId: "RENDER_FIELD"` (pesan menunjuk endpoint render);
 * - medan/nilai tampilan DF-01..DF-73 (C29, C30; DF-72/73 delta DC-05) -> `checkId: "DISPLAY_FIELD"`,
 *   pesan register §5.1 apa adanya;
 * - medan maksud chart FIG-03a (`orientation`, `sort`, `topN`, `otherLabel`, `labelShort`)
 *   -> `checkId: "CHART_INTENT"` dengan pointer medan yang salah;
 * - teks figur v2 di atas batas render (SEC-FIX3 N-5, keyword semu `figureTextLength`) -> `checkId: "FIGURE_TEXT"`;
 * - payload contractRecord dan chart.custom (register 05 §5.4) -> `CONTRACT_ENUM`,
 *   `CONTRACT_PATTERN`, `CONTRACT_DATE`, `CONTRACT_REF_TARGET`, `CHART_CUSTOM_FORM`;
 * - galat lain apa adanya tanpa `checkId`.
 * Pointer issue DISPLAY_FIELD/V1_FIELD menunjuk medan yang ditolak. Hasil didedup.
 */
export function classifySchemaV2Errors(
  rootId: SchemaV2RootId,
  data: unknown,
  errors: readonly AjvErrorLike[] | null | undefined,
  prefix = "",
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: ValidationIssue): void => {
    const k = `${issue.pointer}\u0000${issue.keyword}\u0000${issue.checkId ?? ""}\u0000${issue.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(issue);
  };
  for (const e of errors ?? []) {
    const p = e.params as Record<string, unknown>;
    // SEC-FIX3 N-5: galat semu teks figur (validator v2 bersama, `figure-text.ts`) -> batas render saat kiriman.
    if (e.keyword === FIGURE_TEXT_KEYWORD) {
      push({ pointer: prefix + e.instancePath, keyword: "maxLength", checkId: FIGURE_TEXT_CHECK_ID, message: e.message ?? "teks figur terlalu panjang" });
      continue;
    }
    if (e.keyword === "additionalProperties" && typeof p.additionalProperty === "string") {
      const field = p.additionalProperty;
      const loc = locateSchemaV2Object(rootId, data, e.instancePath);
      const pointer = `${prefix}${e.instancePath}/${escapeSegment(field)}`;
      if (field === "render" && RENDER_FIELD_ROOTS.has(loc)) {
        push(renderFieldIssue(pointer));
        continue;
      }
      const replacement = v1Rename(field, loc);
      if (replacement !== null) {
        push({ pointer, keyword: e.keyword, checkId: "V1_FIELD", message: `medan v1 tidak diterima di v2; pakai ${replacement}` });
        continue;
      }
      if (GLOBAL_DF.has(field) || displayByLocation(field, loc)) {
        push({ pointer, keyword: e.keyword, checkId: "DISPLAY_FIELD", message: DISPLAY_FIELD_MESSAGE });
        continue;
      }
    } else if (e.keyword === "discriminator" && p.tag === "type" && displayValue("type", p.tagValue, "BlockV2")) {
      push({ pointer: `${prefix}${e.instancePath}/type`, keyword: e.keyword, checkId: "DISPLAY_FIELD", message: DISPLAY_FIELD_MESSAGE });
      continue;
    } else if (e.keyword === "enum" && e.instancePath.endsWith("/role")) {
      const parent = e.instancePath.slice(0, -"/role".length);
      const loc = locateSchemaV2Object(rootId, data, parent);
      if (displayValue("role", valueAt(data, e.instancePath), loc)) {
        push({ pointer: prefix + e.instancePath, keyword: e.keyword, checkId: "DISPLAY_FIELD", message: DISPLAY_FIELD_MESSAGE });
        continue;
      }
    }
    const intentIssue = chartIntentIssue(rootId, data, e, prefix);
    if (intentIssue !== null) {
      push(intentIssue);
      continue;
    }
    const contractIssues = classifyContractError(rootId, data, e, prefix);
    if (contractIssues !== null) {
      for (const issue of contractIssues) push(issue);
      continue;
    }
    push({ pointer: prefix + e.instancePath, keyword: e.keyword, message: genericMessage(e) });
  }
  return out;
}
