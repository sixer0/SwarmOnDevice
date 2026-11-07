/**
 * Registri slot kerangka dan cakupan parameter (SR-05).
 *
 * - Jenis slot (C33 `SLOT_SECTION_TYPES`) dan aturan per jenis: contentMode sah,
 *   bawaan, boleh berulang, `admits` (SR-01 §4.7, §6.3).
 * - Kelompok `shared` (C32a `SHARED_PARAM_GROUP_MEMBERS`, SR-01 §13.5).
 * - Delta DC-06 (register 05 §6.2, AM-01, AM-11): jenis slot `contractRecord`
 *   dan validator kerangka kontrak CH-06 `SKELETON_CONTRACT_RECORD`.
 * - `PARAM_SCOPE`: aturan cakupan kunci rinci = transkripsi research/08 §5.8
 *   (diperiksa identik dengan §5.1-5.7) + perubahan research/09 §4.3 (PD-01 ke
 *   `section:sourceRegister`) + cakupan kunci kontrak baru (SR-01 §13.1, research/09 §4.3).
 *   Aturan dievaluasi berurutan, aturan pertama yang cocok menang.
 *
 * Modul murni: tidak mengimpor `params/` (params/index.ts mengisi `scope` setiap
 * ParamDef dari `paramScopeOf`).
 */
import { CONTENT_BLOCK_TYPES, FIGURE_BLOCK_TYPES, TABLE_BLOCK_TYPES, type ParamScopeKind, type StudioSlotContentMode } from "../contract/enums";
import type { ValidationIssue } from "../contract/types/api";
import type { ParamDef } from "../contract/types/params";
import { CONTRACT_RECORD_SECTION_TYPE, isContractKind } from "./contracts";
import { SECTION_REGISTRY } from "./sections";

/** Tata bahasa cakupan (E32): `document` | `section:<kunci registri>` | `shared:<kelompok>` | `slot`. */
export type ParamScope = "document" | "slot" | `section:${string}` | `shared:${string}`;

// ── Jenis slot (C33) ─────────────────────────────────────────────────────

/** C33: sectionType yang sah sebagai slot kerangka. */
export const SLOT_SECTION_TYPES = [
  "cover",
  "controlSheet",
  "signatureBlock",
  "toc",
  "chapter",
  "appendix",
  "sourceRegister",
  "ruleIndex",
  // AM-01 (register 05 §6.2): 8 -> 9.
  "contractRecord",
] as const;
export type SlotSectionType = (typeof SLOT_SECTION_TYPES)[number];

export interface SlotKindDef {
  sectionType: SlotSectionType;
  /** contentMode sah (SR-01 §4.7 `SKELETON_CONTENT_MODE`). */
  contentModes: readonly StudioSlotContentMode[];
  /** Bawaan kerangka implisit (SR-01 §6.3). */
  defaultContentMode: StudioSlotContentMode;
  /** `repeatable = true` hanya untuk chapter/appendix (`SKELETON_REPEATABLE`). */
  repeatable: boolean;
  /** Paling banyak satu slot berjenis ini per kerangka (chapter, appendix). */
  singlePerSkeleton: boolean;
  /** Jenis blok yang boleh masuk `admits` (`SKELETON_ADMITS`); kosong = admits wajib kosong. */
  admitsAllowed: readonly string[];
  /** `admits` bawaan (kerangka bawaan GSP DATUM: 21 jenis blok isi untuk slot berulang). */
  defaultAdmits: readonly string[];
  /** slotKey kerangka implisit (SR-01 §6.3). */
  implicitSlotKey: string;
  /** minItems kerangka implisit (chapter 1). */
  implicitMinItems?: number;
}

const NONE: readonly string[] = [];

export const SLOT_KINDS: readonly SlotKindDef[] = [
  { sectionType: "cover", contentModes: ["INPUT", "MIXED"], defaultContentMode: "MIXED", repeatable: false, singlePerSkeleton: false, admitsAllowed: NONE, defaultAdmits: NONE, implicitSlotKey: "cover" },
  { sectionType: "controlSheet", contentModes: ["INPUT", "MIXED"], defaultContentMode: "INPUT", repeatable: false, singlePerSkeleton: false, admitsAllowed: NONE, defaultAdmits: NONE, implicitSlotKey: "controlSheet" },
  { sectionType: "signatureBlock", contentModes: ["INPUT", "MIXED"], defaultContentMode: "INPUT", repeatable: false, singlePerSkeleton: false, admitsAllowed: NONE, defaultAdmits: NONE, implicitSlotKey: "signature" },
  { sectionType: "toc", contentModes: ["AUTO", "MIXED"], defaultContentMode: "AUTO", repeatable: false, singlePerSkeleton: false, admitsAllowed: NONE, defaultAdmits: NONE, implicitSlotKey: "toc" },
  {
    sectionType: "chapter",
    contentModes: ["INPUT"],
    defaultContentMode: "INPUT",
    repeatable: true,
    singlePerSkeleton: true,
    admitsAllowed: CONTENT_BLOCK_TYPES,
    defaultAdmits: CONTENT_BLOCK_TYPES,
    implicitSlotKey: "content",
    implicitMinItems: 1,
  },
  {
    sectionType: "appendix",
    contentModes: ["INPUT"],
    defaultContentMode: "INPUT",
    repeatable: true,
    singlePerSkeleton: true,
    admitsAllowed: CONTENT_BLOCK_TYPES,
    defaultAdmits: CONTENT_BLOCK_TYPES,
    implicitSlotKey: "appendices",
  },
  { sectionType: "sourceRegister", contentModes: ["INPUT", "MIXED"], defaultContentMode: "INPUT", repeatable: false, singlePerSkeleton: false, admitsAllowed: NONE, defaultAdmits: NONE, implicitSlotKey: "references" },
  { sectionType: "ruleIndex", contentModes: ["AUTO", "MIXED"], defaultContentMode: "AUTO", repeatable: false, singlePerSkeleton: false, admitsAllowed: NONE, defaultAdmits: NONE, implicitSlotKey: "ruleIndex" },
  // AM-11 (register 05 §6.2); syarat contractKind templat = `contractRecordSkeletonIssues` (CH-06).
  { sectionType: "contractRecord", contentModes: ["INPUT"], defaultContentMode: "INPUT", repeatable: false, singlePerSkeleton: true, admitsAllowed: NONE, defaultAdmits: NONE, implicitSlotKey: "record" },
];

export const SLOT_KIND_BY_TYPE: ReadonlyMap<string, SlotKindDef> = new Map(SLOT_KINDS.map((k) => [k.sectionType, k]));

export function isSlotSectionType(v: string): v is SlotSectionType {
  return (SLOT_SECTION_TYPES as readonly string[]).includes(v);
}

/** Pointer bawaan isu CH-06 (register 05 §5.4: `/template/skeleton/slots/0`). */
export const CONTRACT_SKELETON_POINTER_BASE = "/template/skeleton/slots";

/**
 * CH-06 `SKELETON_CONTRACT_RECORD` (register 05 §5.4, simpan templat/kerangka):
 * slot `contractRecord` pada templat tanpa contractKind terdaftar (C58), lebih
 * dari satu slot `contractRecord`, atau slot `contractRecord` dengan
 * `repeatable = true`. Murni; pemanggil (simpan templat / R19 / seed) melempar
 * 400 `SCHEMA_INVALID` bila hasilnya tidak kosong. Kerangka tanpa slot
 * `contractRecord` selalu lolos (templat non-kontrak tidak berubah).
 */
export function contractRecordSkeletonIssues(
  slots: ReadonlyArray<{ sectionType?: unknown; repeatable?: unknown }>,
  contractKind: string | null | undefined,
  pointerBase: string = CONTRACT_SKELETON_POINTER_BASE,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const checkId = "SKELETON_CONTRACT_RECORD";
  const kindOk = isContractKind(contractKind);
  let seen = 0;
  slots.forEach((slot, i) => {
    if (slot.sectionType !== CONTRACT_RECORD_SECTION_TYPE) return;
    const pointer = `${pointerBase}/${i}`;
    seen += 1;
    if (!kindOk) {
      const why = contractKind ? `contractKind ${contractKind} tidak terdaftar` : "templat tanpa contractKind";
      issues.push({ pointer, keyword: "dependentRequired", message: `slot contractRecord hanya untuk templat ber-contractKind terdaftar (${why})`, checkId });
    }
    if (seen > 1) {
      issues.push({ pointer, keyword: "maxContains", message: "paling banyak satu slot contractRecord per kerangka", checkId });
    }
    if (slot.repeatable === true) {
      issues.push({ pointer, keyword: "const", message: "slot contractRecord tidak boleh berulang (repeatable = false)", checkId });
    }
  });
  return issues;
}

// ── Kelompok shared (C32a) dan perangkat halaman ─────────────────────────

/** C32a: anggota kelompok `shared:<kelompok>` = jenis blok yang memakainya (SR-01 §13.5). */
export const SHARED_PARAM_GROUP_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  caption: [...TABLE_BLOCK_TYPES, ...FIGURE_BLOCK_TYPES],
  source: [...TABLE_BLOCK_TYPES, ...FIGURE_BLOCK_TYPES],
  artifact: [...TABLE_BLOCK_TYPES, ...FIGURE_BLOCK_TYPES],
  marks: CONTENT_BLOCK_TYPES,
};

/** Tujuh perangkat halaman (SECTION_REGISTRY grup PAGE_DEVICE); cakupannya boleh ditimpa di slot mana pun. */
export const PAGE_DEVICE_SECTION_TYPES: readonly string[] = SECTION_REGISTRY.filter((s) => s.group === "PAGE_DEVICE").map((s) => s.key);

// ── PARAM_SCOPE (research/08 §5.8 + delta) ───────────────────────────────

type ScopeRuleTable = {
  /** Aturan 0 dan 3 research/08 + PD-01 (research/09 §4.3) + kunci kontrak baru. */
  readonly exact: Readonly<Record<string, ParamScope>>;
  /** Aturan 1-2: grup katalog. */
  readonly groups: Readonly<Record<string, ParamScope>>;
  /** Aturan 4: prefiks (batas segmen titik), urutan berarti. */
  readonly prefixes: ReadonlyArray<readonly [string, ParamScope]>;
  /** Aturan 5. */
  readonly fallback: ParamScope;
};

const DOC: ParamScope = "document";

/**
 * Sumber tunggal cakupan kunci rinci (SR-01 §13.5). Urutan evaluasi:
 * exact -> groups -> prefixes -> fallback.
 */
export const PARAM_SCOPE: ScopeRuleTable = {
  exact: {
    // Aturan 0: kelompok ukuran halaman di namespace section -> document (research/08 §14).
    "cover.leftMarginMm": DOC,
    "cover.datumRule.widthMm": DOC,
    "table.columnWidthSumMm": DOC,
    "chart.output.widthMm": DOC,
    "diagram.widthMm": DOC,
    "diagram.maxHeightMm": DOC,
    // RQ-8/RQ-12 (D-162): lebar figur turunan (class T, figureWidthFromClass) berlingkup document seperti chart/diagram.
    "image.widthMm": DOC,
    "symbolSheet.widthMm": DOC,
    // Aturan 3.
    "admiralty.scaleTablePrintedOnceInAppendix": "section:referenceScale",
    "render.section.numberSeparator": "section:section",
    "render.section.registerBlockLayout": "section:registerBlock",
    // research/09 §4.3 (KT-9): PD-01 menjadi kenop slot Referensi.
    "sourceRegister.columns": "section:sourceRegister",
    // Kunci kontrak baru (SR-01 §13.1 R-38..R-52; research/09 §4.3 R-53..R-58).
    "ingest.inlineFormat": DOC,
    "render.draft.marker": DOC,
    "render.run.symbolGlyphs": DOC,
    "slot.setup": "slot",
    "slot.placement": "slot",
    "slot.placeholderText": "slot",
    "page.size": DOC,
    "page.orientation": "slot",
    "page.customSizeMm": DOC,
    "grid.marginDensity": DOC,
    "doc.defaultTypeCode": DOC,
    "doc.defaultTier": DOC,
    "chart.composite.columns": "section:chart",
    "chart.composite.gapMm": "section:chart",
    "render.table.columnProfiles": "section:table",
    "grid.marginBottomMm": DOC,
    "symbol.sheet.fit": "section:symbolSheet",
    "table.widthClass": "section:table",
    "chart.widthClass": "section:chart",
    "diagram.widthClass": "section:diagram",
    // RQ-8/RQ-12: kelas lebar per jenis figur, pola sama dengan table/chart/diagram.
    "image.widthClass": "section:image",
    "symbolSheet.widthClass": "section:symbolSheet",
    "appendix.kicker.pattern": "section:appendix",
    // FIX-TL (D-351/D-352): kedalaman daftar isi, cakupan sama dengan kenop render.toc.* (prefiks di bawah).
    "toc.levels": "section:toc",
  },
  groups: {
    P1: DOC,
    P3: DOC,
    P11: DOC,
    P15: DOC,
    P16: DOC,
    PA: DOC,
    PB: DOC,
    PC: DOC,
    PD: DOC,
    P7: "section:chart",
    P8: "section:chart",
    P7X: "section:chart",
    P9: "section:diagram",
    P10: "section:symbolSheet",
  },
  prefixes: [
    ["device.datumRule.", "section:datumRule"],
    ["device.evidenceRail.", "section:evidenceRail"],
    ["render.rail.", "section:evidenceRail"],
    ["device.registerBlock.", "section:registerBlock"],
    ["registerBlock.", "section:registerBlock"],
    ["device.sealBand.", "section:sealBand"],
    ["device.spine.", "section:spineString"],
    ["device.issueStamp.", "section:issueStampColophon"],
    ["runningHead.", "section:runningHead"],
    ["render.runningHead.", "section:runningHead"],
    ["wrapper.", "section:runningHead"],
    ["controlSheet.signatures.", "section:signatureBlock"],
    ["controlSheet.", "section:controlSheet"],
    ["cover.", "section:cover"],
    ["render.cover.", "section:cover"],
    ["chapter.", "section:chapter"],
    ["table.", "section:table"],
    ["render.table.", "section:table"],
    ["specTable.", "section:specTable"],
    ["render.specTable.", "section:specTable"],
    ["assumptionRegister.", "section:registerTable"],
    ["aside.", "section:aside"],
    ["derivation.", "section:derivation"],
    ["render.derivation.", "section:derivation"],
    ["render.list.", "section:list"],
    ["render.toc.", "section:toc"],
    ["ahs.", "section:financialTable"],
    ["vat.", "section:financialTable"],
    ["boq.", "section:financialTable"],
    ["stampDuty.", "section:financialTable"],
    ["hps.", "section:financialTable"],
    ["caption.", "shared:caption"],
    ["render.caption.", "shared:caption"],
    ["source.", "shared:source"],
    ["artifact.", "shared:artifact"],
    ["marks.", "shared:marks"],
  ],
  fallback: DOC,
};

/** Cakupan satu kunci rinci (research/08 §5.8). */
export function paramScopeOf(def: Pick<ParamDef, "key" | "group">): ParamScope {
  const exact = PARAM_SCOPE.exact[def.key];
  if (exact) return exact;
  const byGroup = PARAM_SCOPE.groups[def.group];
  if (byGroup) return byGroup;
  for (const [prefix, scope] of PARAM_SCOPE.prefixes) {
    if (def.key.startsWith(prefix)) return scope;
  }
  return PARAM_SCOPE.fallback;
}

export function parseParamScope(scope: ParamScope): { kind: ParamScopeKind; target?: string } {
  if (scope === "document" || scope === "slot") return { kind: scope };
  const i = scope.indexOf(":");
  return { kind: scope.slice(0, i) as ParamScopeKind, target: scope.slice(i + 1) };
}

/**
 * Kunci boleh di M11 sebuah slot (SR-01 §13.5) bila cakupannya `slot`; atau
 * `section:X` dengan X = sectionType slot, X anggota `admits`, atau X perangkat
 * halaman; atau `shared:G` dengan anggota G beririsan dengan `admits`.
 * Selain itu pemanggil menjawab 422 `SLOT_PARAM_SCOPE_INVALID`.
 */
export function isScopeAllowedInSlot(scope: ParamScope, slot: { sectionType: string; admits?: readonly string[] }): boolean {
  const { kind, target } = parseParamScope(scope);
  if (kind === "slot") return true;
  if (kind === "document" || !target) return false;
  const admits = slot.admits ?? [];
  if (kind === "section") return target === slot.sectionType || admits.includes(target) || PAGE_DEVICE_SECTION_TYPES.includes(target);
  const members = SHARED_PARAM_GROUP_MEMBERS[target] ?? [];
  return members.some((m) => admits.includes(m));
}
