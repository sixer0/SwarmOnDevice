/**
 * Row 110 (Swarm 1.2.0): export the builtin DATUM Studio templates into the read-only folder
 * `packages/datum-studio/templates/` as `studio.template/v2` JSON files (studio spec §6), apply the
 * C40 template-default fixes as recorded diffs, and validate every file against the vendored engine.
 *
 * Rules this script keeps (driver_rules.md, row 110 brief):
 * - The clone's seed files (`vendor/prisma/seed-*.ts`, clone `prisma/seed-*.ts`) are NEVER imported or
 *   run. Their pure data tables are transcribed below (SEED DATA section) and each seed file is read as
 *   text only: its sha256 must equal the sha recorded here, so a changed seed stops the export.
 * - Only reviewed, DB-free vendored modules are imported (contract schema, params registry, token
 *   resolver, skeleton/profile/v2 helpers). No module that imports `@prisma/client` is loaded.
 * - The seed's DB steps (Prisma transactions, `seed-studio-templates.ts:188-226`) are replaced by the
 *   in-memory equivalent of the same functions (knobValues, presetSlotEssentials, computePresetLayer,
 *   derivedTemplatePlan, derivedPresetPlan, derivedPresetRoleFormats), transcribed with file:line refs.
 *
 * Usage (from packages/datum-studio): bun scripts/export-builtin-templates.ts [--check]
 *   --check  = build and validate in memory, compare with the files on disk, write nothing.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";

// contract/index.ts is not imported: it re-exports contract/ui.ts (lucide-react, a UI package not shipped).
// The schema load order and ajv options below are copied from contract/index.ts:80-96 (same order).
import { CONTENT_BLOCK_TYPES, ROLE_KEYS } from "../vendor/src/lib/studio/contract/enums";
import type { ParamValue, RoleKey, StudioTemplateV2, TemplateSlotDef } from "../vendor/src/lib/studio/contract";
import { commonSchema } from "../vendor/src/lib/studio/contract/schema/common.schema";
import { diagramSchema } from "../vendor/src/lib/studio/contract/schema/diagram.schema";
import { chartSchema } from "../vendor/src/lib/studio/contract/schema/chart.schema";
import { docSchema } from "../vendor/src/lib/studio/contract/schema/doc.schema";
import { imageSchema } from "../vendor/src/lib/studio/contract/schema/image.schema";
import { htmlSchema } from "../vendor/src/lib/studio/contract/schema/html.schema";
import { commonV2Schema } from "../vendor/src/lib/studio/contract/schema/v2/common.schema";
import { docV2Schema } from "../vendor/src/lib/studio/contract/schema/v2/doc.schema";
import { chapterV2Schema } from "../vendor/src/lib/studio/contract/schema/v2/chapter.schema";
import { slotV2Schema } from "../vendor/src/lib/studio/contract/schema/v2/slot.schema";
import { templateV2Schema } from "../vendor/src/lib/studio/contract/schema/v2/template.schema";
import { skeletonV1Schema } from "../vendor/src/lib/studio/contract/schema/v2/skeleton.schema";
const STUDIO_SCHEMA_LOAD_ORDER = [commonSchema, diagramSchema, chartSchema, docSchema, imageSchema, htmlSchema, commonV2Schema, docV2Schema, chapterV2Schema, slotV2Schema, templateV2Schema, skeletonV1Schema];
const STUDIO_AJV_OPTIONS = { strict: true, allErrors: true, discriminator: true, allowUnionTypes: true } as const;
import { TEMPLATE_V2_SCHEMA_ID as TEMPLATE_V2_SCHEMA_URL } from "../vendor/src/lib/studio/contract/schema/v2/template.schema";
import { ALL_PARAMS, PARAMS_BY_KEY } from "../vendor/src/lib/studio/params";
import { catalogRoleFormat, resolveParams, validateParamValue } from "../vendor/src/lib/studio/engine/tokens";
import { effectiveClass } from "../vendor/src/lib/studio/engine/tokens/merge";
import { WRAPPER_TEXT } from "../vendor/src/lib/studio/engine/front/texts";
import { ESSENTIAL_KNOBS } from "../vendor/src/lib/studio/registry/essentials";
import { contractRecordSkeletonIssues, isScopeAllowedInSlot } from "../vendor/src/lib/studio/registry/slots";
import { CONTRACT_KIND_DEFS } from "../vendor/src/lib/studio/registry/contracts";
import { skeletonSha256, validateSkeleton } from "../vendor/src/lib/studio/services/skeleton/skeleton";
import { stableStringify } from "../vendor/src/lib/studio/services/ingest/util";
import { canonicalSectionPlan, composeVersion, validateRoleFormats, type ParamRecord } from "../vendor/src/lib/studio/services/templates/profile";
import { parseTemplateV2, splitBySurface, assertTemplateLayerKeys, templateLayerOf } from "../vendor/src/lib/studio/services/templates/v2";
import { loadResolvedTemplateV2File, readTemplateProfileFile } from "../vendor/src/lib/studio/services/templates/import";
import { templateRestriction } from "../vendor/src/lib/studio/services/templates/access";
import { setTemplatesLogSink, type TemplatesLogEntry } from "../vendor/src/lib/studio/services/templates/log";

// ── Paths and provenance ────────────────────────────────────────────────────

const PKG = path.resolve(import.meta.dir, "..");
const VENDOR = path.join(PKG, "vendor");
const OUT = path.join(PKG, "templates");
/** C54 (row 110b): restricted templates (they release lint checks) are NOT shipped; kept as test fixtures. */
const FIXTURES = path.join(PKG, "test-fixtures", "templates");
const FIXTURE_SLUGS = ["datum-manual-000-preset", "datum-manual-000"];
/**
 * Row 49a (C104 M3): the read-only clone of gsp-datacenter (provenance commit, vendor/provenance.json) is optional.
 * Every source is vendored, so the export and `--check` need only this package. When DATUM_STUDIO_CLONE names an
 * existing folder, each vendored source is also compared with the clone (read as data only); unset, empty or a
 * missing folder = no comparison (a note on stderr when it was set but not found).
 */
const CLONE = process.env.DATUM_STUDIO_CLONE?.trim() || undefined;
const CLONE_COMPARE = CLONE !== undefined && existsSync(CLONE);
if (CLONE !== undefined && !CLONE_COMPARE) console.error(`DATUM_STUDIO_CLONE=${CLONE} not found: clone comparison skipped`);
const PROVENANCE_COMMIT = "b0ae7a729d27bd4021393b615ff8450f8777b77c";
const CHECK_ONLY = process.argv.includes("--check");

/** Seed and data files: path relative to the clone root (same path under vendor/ when vendored), expected sha256. */
const SOURCES = {
  seedStudio: { rel: "prisma/seed-studio.ts", sha256: "0620fe31bce6f12a", vendored: true },
  seedStudioTemplates: { rel: "prisma/seed-studio-templates.ts", sha256: "65a09d8a55387abd", vendored: true },
  seedDocTypeTemplates: { rel: "prisma/seed-doc-type-templates.ts", sha256: "438189a2d6d9c4be", vendored: true },
  seedDerivedPresets: { rel: "prisma/seed-derived-presets.ts", sha256: "3f9afaab1ba2e6cb", vendored: true },
  manual000Profile: { rel: "benchmark/manual000/template.json", sha256: "930a26ed93a0496a", vendored: true },
  // Row 49a (C104 M3): byte copies of the clone files at the provenance commit (vendor/provenance.json entries).
  manual000V2: { rel: "benchmark/manual000/template.v2.json", sha256: "882057c5743273fe", vendored: true },
  manual000Preset: { rel: "benchmark/manual000/datum-manual-000.preset.json", sha256: "a951b14918034595", vendored: true },
} as const;
type SourceKey = keyof typeof SOURCES;

function sha256File(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}
function sourcePath(k: SourceKey): string {
  return path.join(VENDOR, SOURCES[k].rel);
}
const sourceShas: Record<string, { path: string; sha256: string }> = {};
for (const k of Object.keys(SOURCES) as SourceKey[]) {
  const sha = sha256File(sourcePath(k));
  const want = SOURCES[k].sha256;
  if (!sha.startsWith(want)) throw new Error(`source ${SOURCES[k].rel}: sha256 ${sha} does not start with the transcribed ${want}; re-read the seed and update SEED DATA`);
  if (CLONE_COMPARE) {
    const cloneSha = sha256File(path.join(CLONE!, SOURCES[k].rel));
    if (cloneSha !== sha) throw new Error(`vendored ${SOURCES[k].rel} differs from the clone (${sha} vs ${cloneSha})`);
  }
  sourceShas[k] = { path: `packages/datum-studio/vendor/${SOURCES[k].rel}`, sha256: sha };
}

const logs: TemplatesLogEntry[] = [];
setTemplatesLogSink((e) => {
  logs.push(e);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const stable = (v: unknown): string => stableStringify(v ?? null);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const asRecord = (v: unknown): ParamRecord => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as ParamRecord) : {});
type SlotShape = Omit<TemplateSlotDef, "essentials">;
type SlotOverrides = Readonly<Record<string, ParamRecord>>;

function resolveEffective(base: ParamRecord, overrides: ParamRecord): ParamRecord {
  const r = resolveParams({ base, overrides, registry: ALL_PARAMS });
  if (r.errors.length > 0) throw new Error(`resolveParams: ${r.errors.slice(0, 3).map((e) => `${e.key}: ${e.message}`).join("; ")}`);
  return { ...r.params } as ParamRecord;
}

/** seed-studio-templates.ts:77-93 `knobValues` (transcribed). */
function knobValues(scope: string, effective: ParamRecord, accept: (key: string) => boolean = () => true): { values: ParamRecord; skipped: string[] } {
  const values: ParamRecord = {};
  const skipped: string[] = [];
  for (const knob of ESSENTIAL_KNOBS) {
    if (knob.scope !== scope || knob.mapping === "medan") continue;
    for (const key of knob.keys) {
      if (key in values || skipped.includes(key)) continue;
      const def = PARAMS_BY_KEY.get(key);
      const v = effective[key];
      if (!def || def.surface !== "essential" || v === undefined || validateParamValue(def, v) !== null || !accept(key)) skipped.push(key);
      else values[key] = v;
    }
  }
  return { values, skipped };
}

/** seed-studio-templates.ts:103-133 `presetSlotEssentials` (transcribed). */
function presetSlotEssentials(slots: ReadonlyArray<SlotShape>, presetEffective: ParamRecord | null, slotOverrides?: SlotOverrides): { slots: TemplateSlotDef[]; skipped: Record<string, string[]> } {
  const unknownSlots = Object.keys(slotOverrides ?? {}).filter((k) => !slots.some((s) => s.slotKey === k));
  if (unknownSlots.length > 0) throw new Error(`slot override for slots not in the skeleton: ${unknownSlots.join(", ")}`);
  const skipped: Record<string, string[]> = {};
  const out = slots.map((s) => {
    let essentials: ParamRecord = {};
    if (presetEffective) {
      const k = knobValues(s.sectionType, presetEffective, (key) => isScopeAllowedInSlot(PARAMS_BY_KEY.get(key)!.scope, s));
      if (k.skipped.length > 0) skipped[s.slotKey] = k.skipped;
      essentials = k.values;
    }
    const over = slotOverrides?.[s.slotKey];
    if (over) {
      for (const [key, value] of Object.entries(over)) {
        const def = PARAMS_BY_KEY.get(key);
        if (!def) throw new Error(`slot override ${s.slotKey}: unknown key ${key}`);
        if (!isScopeAllowedInSlot(def.scope, s)) throw new Error(`slot override ${s.slotKey}: key ${key} (scope ${def.scope}) outside the slot`);
        const bad = validateParamValue(def, value as ParamValue);
        if (bad !== null) throw new Error(`slot override ${s.slotKey}: invalid ${key}: ${bad}`);
      }
      essentials = { ...essentials, ...over };
    }
    return { ...s, admits: [...s.admits], tiers: [...s.tiers], essentials };
  });
  return { slots: out, skipped };
}

/** seed-studio.ts:640-662 `computePresetLayer` (transcribed; PIN_PASSES_MAX = 4, seed-studio.ts:513). */
function computePresetLayer(baseline: ParamRecord, baseOverrides: ParamRecord, spec: { decided: ParamRecord; delta: readonly string[]; dropPrefixes: readonly string[] }) {
  const legacy = Object.keys(baseline).filter((k) => !spec.delta.includes(k));
  const layer: ParamRecord = clone(spec.decided);
  let effective: ParamRecord = {};
  let diffs: string[] = [];
  for (let pass = 0; pass < 4; pass++) {
    effective = resolveEffective(baseOverrides, layer);
    diffs = legacy.filter((k) => stable(effective[k]) !== stable(baseline[k]));
    let added = 0;
    for (const k of diffs) {
      const def = PARAMS_BY_KEY.get(k);
      if (!def || k in layer || spec.dropPrefixes.some((p) => k.startsWith(p))) continue;
      if (effectiveClass(def, baseline[k], undefined) === "T" || validateParamValue(def, baseline[k]) !== null) continue;
      layer[k] = clone(baseline[k]);
      added++;
    }
    if (added === 0) break;
  }
  return { layer, effective, unresolved: diffs };
}

/** seed-studio-templates.ts:426-457 `derivedPresetRoleFormats` (transcribed). */
function derivedPresetRoleFormats(slug: string, pins: ParamRecord, overrides: Record<string, Record<string, Record<string, unknown>>>, baseRoleFormats: unknown, baseEffective: ParamRecord): Record<string, unknown> {
  const base = asRecord(baseRoleFormats) as Record<string, unknown>;
  const presetEffective: ParamRecord = { ...baseEffective, ...pins };
  const out: Record<string, unknown> = {};
  for (const [role, patch] of Object.entries(overrides)) {
    if (!(ROLE_KEYS as readonly string[]).includes(role)) throw new Error(`${slug}: unknown role ${role}`);
    const baseRole = base[role] as Record<string, unknown> | undefined;
    if (!baseRole || typeof baseRole !== "object") throw new Error(`${slug}: role ${role} missing in the base preset`);
    const catalog = catalogRoleFormat(presetEffective, role as RoleKey) as Record<string, unknown>;
    const next = clone(baseRole);
    for (const [sub, attrs] of Object.entries(patch)) {
      const baseSub = baseRole[sub] as Record<string, unknown> | undefined;
      if (!baseSub || typeof baseSub !== "object") throw new Error(`${slug}: ${role}.${sub} missing in the base preset`);
      const want = asRecord(catalog[sub]).szHalfPt;
      if ("szHalfPt" in attrs && typeof want === "number" && attrs.szHalfPt !== want) throw new Error(`${slug}: ${role}.${sub} szHalfPt ${String(attrs.szHalfPt)} != catalog ${want}`);
      next[sub] = { ...baseSub, ...attrs };
    }
    if (stable(next) === stable(baseRole)) throw new Error(`${slug}: ${role} equal to the base`);
    out[role] = next;
  }
  return out;
}

// ── SEED DATA (transcribed from the seed files; sha-guarded above) ──────────

/** seed-studio-templates.ts:59-67 `DATUM_SKELETON_SLOTS` (labels from WRAPPER_TEXT as in the seed). */
const DATUM_SKELETON_SLOTS: ReadonlyArray<SlotShape> = [
  { slotKey: "cover", sectionType: "cover", label: "Sampul", position: 1, required: true, positionLocked: true, repeatable: false, contentMode: "MIXED", tiers: ["TERBIT", "SERAH"], admits: [] },
  { slotKey: "controlSheet", sectionType: "controlSheet", label: WRAPPER_TEXT.controlKicker.ID, position: 2, required: true, positionLocked: false, repeatable: false, contentMode: "INPUT", tiers: ["TERBIT", "SERAH"], admits: [] },
  { slotKey: "signature", sectionType: "signatureBlock", label: "Tanda Tangan", position: 3, required: true, positionLocked: false, repeatable: false, contentMode: "INPUT", tiers: ["TERBIT", "SERAH"], admits: [] },
  { slotKey: "toc", sectionType: "toc", label: WRAPPER_TEXT.tocKicker.ID, position: 4, required: true, positionLocked: false, repeatable: false, contentMode: "AUTO", tiers: ["TERBIT", "SERAH"], admits: [] },
  { slotKey: "content", sectionType: "chapter", label: "Isi", position: 5, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: "INPUT", tiers: [], admits: [...CONTENT_BLOCK_TYPES] },
  { slotKey: "references", sectionType: "sourceRegister", label: "Referensi", position: 6, required: false, positionLocked: false, repeatable: false, contentMode: "INPUT", tiers: [], admits: [] },
  { slotKey: "appendices", sectionType: "appendix", label: "Lampiran", position: 7, required: false, positionLocked: true, repeatable: true, contentMode: "INPUT", tiers: [], admits: [...CONTENT_BLOCK_TYPES] },
];

/** seed-studio.ts:174-178, 194, 183 (datum-gsp identity, dropped meta, dropped override prefix). */
const DATUM_GSP = {
  slug: "datum-gsp",
  name: "DATUM GSP (profil Manual DATUM 2.6.0)",
  description: "Dokumen resmi GSP mengikuti Manual DATUM 2.6.0; semua pemeriksaan standar berlaku.",
  droppedOverridePrefix: "lint.enforcement",
};

/** seed-studio.ts:545-582 `PRESET_MIGRATIONS` (keys :508-511). */
const PRESET_MIGRATIONS = [
  { templateSlug: "datum-kanonik", presetSlug: "datum-kanonik-preset", presetName: "DATUM Kanonik", presetDescription: "Gaya DATUM dengan nilai bawaan standar; pilihan aman untuk templat baru.", decided: {} as ParamRecord, delta: [] as string[], dropPrefixes: [] as string[] },
  {
    templateSlug: "datum-gsp",
    presetSlug: "datum-gsp-preset",
    presetName: "GSP DATUM",
    presetDescription: "Gaya GSP DATUM: format terukur Manual DATUM untuk dokumen resmi GSP.",
    decided: {
      "device.registerBlock.boldFields": ["nomor dokumen", "revisi", "nomor lembar", "jumlah lembar", "klasifikasi"],
      "symbol.sheet.fit": true,
      "table.widthClass": "full",
      "render.rail.renderer": "framePr",
    } as ParamRecord,
    delta: ["device.registerBlock.boldFields", "symbol.sheet.fit", "table.widthClass", "render.rail.renderer"],
    dropPrefixes: ["lint.enforcement"],
  },
] as const;

/** seed-derived-presets.ts:25-55 `DERIVED_PRESET_SPECS`. */
const DERIVED_PRESET = {
  slug: "datum-gsp-rev-a-preset",
  name: "GSP DATUM Rev A",
  description: "Gaya GSP DATUM dengan skala huruf tabel Manual DATUM Rev A (Tabel 8.2: numeral 7,8 pt, kepala 6,8 pt, caption 7,6 pt).",
  baseSlug: "datum-gsp-preset",
  pins: { "type.scale.tableNumerals.size": 7.8, "type.scale.tableHeader.size": 6.8, "type.scale.caption.size": 7.6, "type.scale.tableHeader.trackEm": 0.09 } as ParamRecord,
  roleFormatOverrides: {
    caption: { run: { szHalfPt: 15 }, labelRun: { szHalfPt: 15 } },
    "table.headerLeft": { run: { szHalfPt: 14, spacingTw: 12 } },
    "table.headerRight": { run: { szHalfPt: 14, spacingTw: 12 } },
    "controlTable.header": { run: { szHalfPt: 14, spacingTw: 12 } },
    "table.cellNumeralRight": { run: { szHalfPt: 16 } },
    "table.cellMono": { run: { szHalfPt: 16 } },
  } as Record<string, Record<string, Record<string, unknown>>>,
};

/** seed-doc-type-templates.ts:27,30,56-82,89-91,103-106,123-145,151-198 (doc-type layers). */
const REV_A_TYPE_CODES = ["PT", "KT", "RAB", "SPH", "SP", "BA", "NDA", "DEK", "LAP", "MAT", "STD", "NOT", "MOD", "VER"];
const SHARED_LAYER: ParamRecord = {
  "doc.typeCode": [...REV_A_TYPE_CODES],
  "org.entityName": "PT GEMILANG SATRIA PERKASA",
  "layout.railMode": "A",
  "table.zebra.minRows": 1000,
  "runningHead.ruleColour": "6E1420",
  "device.registerBlock.topRuleColour": "6E1420",
  "render.docx.pageBackground": true,
  "controlSheet.subtitle.enabled": true,
  "controlSheet.signatures.fillRoles": true,
  "controlSheet.columns.form": "manual",
  "cover.title.maxWidthMm": 150,
  "cover.controlBlock.fields": ["NOMOR DOKUMEN", "REVISI", "KLASIFIKASI", "PENYUSUN", "KUSTODIAN", "DITUJUKAN KEPADA", "TIER", "BAHASA"],
  "device.spine.placements": ["margin luar sampul", "pembatas", "sampul belakang"],
  "render.rhythm.snapToBaseline": true, // ENGINE_E_LAYOUT_OPT_INS = true (:56)
  "render.rail.reserveColumn": true,
};
const SHARED_SLOT_OVERRIDES: SlotOverrides = { toc: { "render.toc.mode": "field" } };
const RULE_INDEX_SLOT: { insertBefore: string; slot: SlotShape } = {
  insertBefore: "appendices",
  slot: { slotKey: "ruleIndex", sectionType: "ruleIndex", label: "Indeks Aturan", position: 0, required: false, positionLocked: false, repeatable: false, contentMode: "AUTO", tiers: [], admits: [] },
};
type DocLanguage = "ID" | "EN";
const DOC_TYPE_LAYERS = [
  { slugBase: "datum-proposal-teknis", typeCode: "PT", tier: "SERAH", title: { ID: "Proposal Teknis", EN: "Technical Proposal" }, kicker: { ID: "PROPOSAL TEKNIS", EN: "TECHNICAL PROPOSAL" } },
  { slugBase: "datum-laporan", typeCode: "LAP", tier: "TERBIT", title: { ID: "Laporan", EN: "Report" }, kicker: { ID: "LAPORAN", EN: "REPORT" } },
  { slugBase: "datum-laporan-verifikasi", typeCode: "VER", tier: "TERBIT", title: { ID: "Laporan Verifikasi dan Uji", EN: "Verification and Test Report" }, kicker: { ID: "LAPORAN VERIFIKASI", EN: "VERIFICATION REPORT" } },
  { slugBase: "datum-standar", typeCode: "STD", tier: "TERBIT", title: { ID: "Standar", EN: "Standard" }, kicker: { ID: "STANDAR", EN: "STANDARD" }, extraSlots: [RULE_INDEX_SLOT], layer: { "render.ruleIndex.fromMarkers": true } as ParamRecord },
  { slugBase: "datum-nota", typeCode: "NOT", tier: "NOTA", title: { ID: "Nota Internal", EN: "Internal Note" }, kicker: { ID: "NOTA INTERNAL", EN: "INTERNAL NOTE" }, layer: { "render.nota.classificationLine": true, "naming.file.form": "judulTanggalIso" } as ParamRecord },
] as const;
const LANGUAGE_LAYERS = [
  {
    language: "ID" as DocLanguage,
    slugSuffix: "",
    nameSuffix: " (DATUM Rev A)",
    slotLabels: {} as Record<string, string>,
    description: (t: { title: string; typeCode: string; tier: string }) => `Dokumen ${t.title} GSP mengikuti Manual DATUM Rev A (kode ${t.typeCode}, tier bawaan ${t.tier}).`,
    layer: { "cover.controlBlock.preparerUnit": "Divisi Engineering PT GSP" } as ParamRecord,
  },
  {
    language: "EN" as DocLanguage,
    slugSuffix: "-en",
    nameSuffix: " (DATUM Rev A, EN)",
    slotLabels: { cover: "Cover", controlSheet: WRAPPER_TEXT.controlKicker.EN, signature: "Signatures", toc: WRAPPER_TEXT.tocKicker.EN, content: "Content", references: "References", appendices: "Appendices", ruleIndex: "Rule Index" } as Record<string, string>,
    description: (t: { title: string; typeCode: string; tier: string }) => `GSP ${t.title} following the DATUM Manual Rev A (type code ${t.typeCode}, default tier ${t.tier}).`,
    layer: { "cover.controlBlock.preparerUnit": "Engineering Division, PT GSP" } as ParamRecord,
  },
];

/** seed-studio.ts:1103-1116 `CONTRACT_TEMPLATES` (laporan-kerja-agen). */
const CONTRACT_TEMPLATE = {
  kind: "agentWorkReport",
  slug: "laporan-kerja-agen",
  name: "Laporan Kerja Agen",
  description: "Laporan kerja tiap agen: catatan laporan, isi laporan (bab 1-5), dan referensi.",
  presetSlug: "datum-gsp-preset",
  slots: [
    { slotKey: "record", sectionType: "contractRecord", label: "Catatan Laporan", position: 1, required: true, positionLocked: true, repeatable: false, contentMode: "INPUT", tiers: [], admits: [] },
    { slotKey: "content", sectionType: "chapter", label: "Isi Laporan", position: 2, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: "INPUT", tiers: [], admits: [...CONTENT_BLOCK_TYPES] },
    { slotKey: "references", sectionType: "sourceRegister", label: "Referensi", position: 3, required: false, positionLocked: false, repeatable: false, contentMode: "INPUT", tiers: [], admits: [] },
  ] as SlotShape[],
};

// ── Build (in-memory replay of the seed order) ──────────────────────────────

interface Built {
  slug: string;
  name: string;
  description: string;
  kind: "DOCUMENT";
  isPreset: boolean;
  contractKind: string | null;
  restrictedNote?: string;
  definition: StudioTemplateV2;
  /** Effective params (registry <- preset chain <- own layer), for checks only. */
  effective: ParamRecord;
  /** Stored role formats (preset chain + own), for the next derived preset. */
  storedRoleFormats: Record<string, unknown>;
  /** Preset layer (overrides) for chained presets. */
  layer: ParamRecord;
  sources: SourceKey[];
  seedRef: string;
}
const built = new Map<string, Built>();
const def = (preset: { slug: string } | undefined, essentials: ParamRecord, advanced: ParamRecord | undefined, roleFormats: Record<string, unknown> | undefined, slots: TemplateSlotDef[]): StudioTemplateV2 => ({
  $schema: "studio.template/v2",
  ...(preset ? { preset } : {}),
  essentials,
  ...(advanced && Object.keys(advanced).length > 0 ? { advanced } : {}),
  ...(roleFormats !== undefined ? { roleFormats: roleFormats as StudioTemplateV2["roleFormats"] } : {}),
  skeleton: { slots },
});

// 1. Canonical profile (ensureCanonicalTemplate; profile.ts:46 pure): overrides {}, roles {}.
const canonical = composeVersion({ baseOverrides: {}, overrides: {}, baseRoleFormats: {}, baseSectionPlan: canonicalSectionPlan(), assets: {} });

// 2. datum-gsp baseline (importDatumGspProfile + toDatumGspProfile, seed-studio.ts:251-357): profile file, enforcement releases dropped.
const gspParsed = await readTemplateProfileFile(sourcePath("manual000Profile"));
const gspDropped = Object.keys(gspParsed.profile.overrides).filter((k) => k.startsWith(DATUM_GSP.droppedOverridePrefix)).sort();
const gspOverrides = Object.fromEntries(Object.entries(gspParsed.profile.overrides).filter(([k]) => !gspDropped.includes(k))) as ParamRecord;
const gspBaseline = composeVersion({ baseOverrides: canonical.overrides, overrides: gspOverrides, baseRoleFormats: {}, roleFormats: gspParsed.profile.roleFormats, baseSectionPlan: canonicalSectionPlan(), sectionPlan: gspParsed.profile.sectionPlan, assets: {} });
// measuredBaselineCorrections (seed-studio.ts:770-795): the recorded source sha equals the file sha by construction, status "applied".
const rawProfile = asRecord(asRecord(JSON.parse(readFileSync(sourcePath("manual000Profile"), "utf8").replace(/^﻿/, ""))).overrides);
const gspCorrections = gspParsed.droppedDerived.filter((k) => k in rawProfile && k in gspBaseline.resolvedParams && stable(rawProfile[k]) !== stable(gspBaseline.resolvedParams[k])).sort();

// 3. Presets and skeleton versions (seedPresetsAndSkeletons, seed-studio.ts:798-913).
const presetReports: Record<string, unknown>[] = [];
for (const spec of PRESET_MIGRATIONS) {
  const baselineParams = spec.templateSlug === "datum-kanonik" ? canonical.resolvedParams : gspBaseline.resolvedParams;
  const guardBaseline: ParamRecord = { ...baselineParams };
  if (spec.templateSlug === "datum-gsp") for (const k of gspCorrections) guardBaseline[k] = clone(rawProfile[k]);
  const baseRoles: Record<string, unknown> = canonical.roleFormats as Record<string, unknown>;
  const computed = computePresetLayer(guardBaseline, canonical.overrides, spec);
  const baselineRoles = (spec.templateSlug === "datum-kanonik" ? canonical.roleFormats : gspBaseline.roleFormats) as Record<string, unknown>;
  const ownRoleFormats = Object.fromEntries(Object.entries(baselineRoles).filter(([role, f]) => stable(f) !== stable(baseRoles[role])));
  const split = splitBySurface(computed.layer);
  const presetSlots = presetSlotEssentials(DATUM_SKELETON_SLOTS, null).slots;
  built.set(spec.presetSlug, {
    slug: spec.presetSlug,
    name: spec.presetName,
    description: spec.presetDescription,
    kind: "DOCUMENT",
    isPreset: true,
    contractKind: null,
    definition: def(undefined, split.essentials, split.advanced, ownRoleFormats, presetSlots), // ensurePreset :665-674 (roleFormats always present)
    effective: computed.effective,
    storedRoleFormats: { ...baseRoles, ...ownRoleFormats },
    layer: computed.layer,
    sources: spec.templateSlug === "datum-gsp" ? ["seedStudio", "manual000Profile"] : ["seedStudio"],
    seedRef: "seed-studio.ts:545-582 PRESET_MIGRATIONS; :664-698 ensurePreset",
  });
  presetReports.push({ preset: spec.presetSlug, layerKeys: Object.keys(computed.layer).length, unresolved: computed.unresolved, ownRoles: Object.keys(ownRoleFormats).length });
  // Phase B: skeleton version of the template (ensureSkeletonVersion, seed-studio-templates.ts:139-227).
  const global = knobValues("global", computed.effective);
  const sk = presetSlotEssentials(DATUM_SKELETON_SLOTS, computed.effective);
  const isGsp = spec.templateSlug === "datum-gsp";
  built.set(spec.templateSlug, {
    slug: spec.templateSlug,
    name: isGsp ? DATUM_GSP.name : "DATUM Kanonik",
    description: isGsp ? DATUM_GSP.description : "Profil kanonik DATUM: nilai bawaan registri parameter (tanpa override).",
    kind: "DOCUMENT",
    isPreset: false,
    contractKind: null,
    definition: def({ slug: spec.presetSlug }, global.values, undefined, undefined, sk.slots),
    effective: resolveEffective(computed.layer, global.values),
    storedRoleFormats: { ...baseRoles, ...ownRoleFormats },
    layer: { ...computed.layer, ...global.values },
    sources: isGsp ? ["seedStudio", "seedStudioTemplates", "manual000Profile"] : ["seedStudio", "seedStudioTemplates"],
    seedRef: "seed-studio.ts:851-868 ensureSkeletonVersion (SR-36)",
  });
}

// 4. datum-manual-000 + preset (importManual000V2, seed-studio.ts:906-1047): read from the vendored v2 file and its sibling
// preset profile (data; row 49a vendored both, so the preset lookup root is vendor/, the clone layout).
{
  const loaded = await loadResolvedTemplateV2File(sourcePath("manual000V2"), { repoRoot: VENDOR });
  if (!loaded.preset.file) throw new Error("manual000 v2: preset profile file not found");
  const presetProfile = await readTemplateProfileFile(loaded.preset.file);
  const presetSlots = loaded.skeleton.slots.map((s) => {
    const { advanced: _a, roleFormats: _r, ...rest } = s;
    void _a;
    void _r;
    return { ...rest, essentials: {} };
  });
  const pSplit = splitBySurface(presetProfile.profile.overrides);
  const presetEff = resolveEffective({}, presetProfile.profile.overrides);
  const presetRoles = (presetProfile.profile.roleFormats ?? {}) as Record<string, unknown>;
  built.set("datum-manual-000-preset", {
    slug: "datum-manual-000-preset",
    name: "DATUM Manual 000",
    description: "Gaya acuan Manual 000 untuk pengujian format terukur (khusus admin).",
    kind: "DOCUMENT",
    isPreset: true,
    contractKind: null,
    definition: def(undefined, pSplit.essentials, pSplit.advanced, presetRoles, presetSlots),
    effective: presetEff,
    storedRoleFormats: presetRoles,
    layer: presetProfile.profile.overrides,
    sources: ["seedStudio", "manual000V2", "manual000Preset"],
    seedRef: "seed-studio.ts:969-988 ensurePreset (SR-38)",
  });
  const droppedT = new Set(loaded.droppedDerived.filter((k) => !k.startsWith("preset:")));
  const keep = (o: ParamRecord | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !droppedT.has(k))) as ParamRecord;
  const d = loaded.definition;
  built.set("datum-manual-000", {
    slug: "datum-manual-000",
    name: "DATUM Manual 000",
    description: "Templat acuan Manual 000 untuk pengujian format terukur (khusus admin).",
    kind: "DOCUMENT",
    isPreset: false,
    contractKind: null,
    definition: def({ slug: "datum-manual-000-preset" }, keep(d.essentials), keep(d.advanced), d.roleFormats as Record<string, unknown> | undefined, loaded.skeleton.slots),
    effective: { ...loaded.template.params } as ParamRecord,
    storedRoleFormats: { ...presetRoles, ...((d.roleFormats ?? {}) as Record<string, unknown>) },
    layer: { ...presetProfile.profile.overrides, ...keep(d.essentials), ...keep(d.advanced) },
    sources: ["seedStudio", "manual000V2", "manual000Preset"],
    seedRef: "seed-studio.ts:990-1002 ensureSkeletonVersion (SR-38)",
  });
}

// 5. Derived preset datum-gsp-rev-a-preset (ensureDerivedPreset, seed-studio-templates.ts:476-...).
{
  const base = built.get(DERIVED_PRESET.baseSlug)!;
  for (const [k, v] of Object.entries(DERIVED_PRESET.pins)) {
    const pd = PARAMS_BY_KEY.get(k);
    if (!pd || validateParamValue(pd, v as ParamValue) !== null) throw new Error(`rev-a pin ${k} invalid`);
  }
  const split = splitBySurface(DERIVED_PRESET.pins);
  const ownRoles = derivedPresetRoleFormats(DERIVED_PRESET.slug, DERIVED_PRESET.pins, DERIVED_PRESET.roleFormatOverrides, base.storedRoleFormats, base.effective);
  const layer = { ...base.layer, ...DERIVED_PRESET.pins };
  built.set(DERIVED_PRESET.slug, {
    slug: DERIVED_PRESET.slug,
    name: DERIVED_PRESET.name,
    description: DERIVED_PRESET.description,
    kind: "DOCUMENT",
    isPreset: true,
    contractKind: null,
    definition: def({ slug: DERIVED_PRESET.baseSlug }, split.essentials, split.advanced, ownRoles, presetSlotEssentials(DATUM_SKELETON_SLOTS, null).slots),
    effective: resolveEffective(base.layer, DERIVED_PRESET.pins),
    storedRoleFormats: { ...base.storedRoleFormats, ...ownRoles },
    layer,
    sources: ["seedDerivedPresets", "seedStudioTemplates"],
    seedRef: "seed-derived-presets.ts:25-55; seed-studio-templates.ts:460-475 derivedPresetPlan",
  });
}

/** derivedTemplatePlan + ensureDerivedTemplate (seed-studio-templates.ts:246-330). */
function addDerivedTemplate(spec: { slug: string; name: string; description: string; presetSlug: string; slots: ReadonlyArray<SlotShape>; layer: ParamRecord; slotOverrides?: SlotOverrides; contractKind: string | null }, sources: SourceKey[], seedRef: string): void {
  const preset = built.get(spec.presetSlug)!;
  const global = knobValues("global", preset.effective);
  const split = splitBySurface({ ...global.values, ...spec.layer });
  const sk = presetSlotEssentials(spec.slots, preset.effective, spec.slotOverrides);
  const ch06 = contractRecordSkeletonIssues(sk.slots, spec.contractKind);
  if (ch06.length > 0) throw new Error(`CH-06 ${spec.slug}: ${ch06.map((i) => i.message).join("; ")}`);
  const own = { ...split.essentials, ...split.advanced };
  built.set(spec.slug, {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    kind: "DOCUMENT",
    isPreset: false,
    contractKind: spec.contractKind,
    definition: def({ slug: spec.presetSlug }, split.essentials, split.advanced, {}, sk.slots), // ownRoleFormats: {} -> roleFormats always present
    effective: resolveEffective(preset.layer, own),
    storedRoleFormats: preset.storedRoleFormats,
    layer: { ...preset.layer, ...own },
    sources,
    seedRef,
  });
}

// 6. Contract template laporan-kerja-agen (contractDerivedSpec, seed-studio.ts:1146-1163).
{
  const regDef = CONTRACT_KIND_DEFS.find((d) => d.kind === CONTRACT_TEMPLATE.kind);
  if (!regDef || regDef.templateSlug !== CONTRACT_TEMPLATE.slug) throw new Error("contract registry mismatch for laporan-kerja-agen");
  const typeCodes = PARAMS_BY_KEY.get("doc.typeCode")!.default as string[];
  const list = typeCodes.includes(regDef.typeCode) ? [...typeCodes] : [...typeCodes, regDef.typeCode];
  addDerivedTemplate(
    { slug: CONTRACT_TEMPLATE.slug, name: CONTRACT_TEMPLATE.name, description: CONTRACT_TEMPLATE.description, presetSlug: CONTRACT_TEMPLATE.presetSlug, slots: CONTRACT_TEMPLATE.slots, layer: { "doc.defaultTier": regDef.tier, "doc.defaultTypeCode": regDef.typeCode, "doc.typeCode": list }, contractKind: CONTRACT_TEMPLATE.kind },
    ["seedStudio", "seedStudioTemplates"],
    "seed-studio.ts:1103-1163 CONTRACT_TEMPLATES / contractDerivedSpec",
  );
}

// 7. Ten Rev A doc-type templates (composeSpec, seed-doc-type-templates.ts:212-236).
for (const type of DOC_TYPE_LAYERS) {
  for (const lang of LANGUAGE_LAYERS) {
    const slots: SlotShape[] = DATUM_SKELETON_SLOTS.map((s) => ({ ...s, admits: [...s.admits], tiers: [...s.tiers] }));
    for (const extra of ("extraSlots" in type ? type.extraSlots : []) ?? []) {
      const at = slots.findIndex((s) => s.slotKey === extra.insertBefore);
      if (at < 0) throw new Error(`extra slot ${extra.slot.slotKey}: ${extra.insertBefore} missing`);
      slots.splice(at, 0, { ...extra.slot, admits: [...extra.slot.admits], tiers: [...extra.slot.tiers] });
    }
    const labelled = slots.map((s, i) => ({ ...s, label: lang.slotLabels[s.slotKey] ?? s.label, position: i + 1 }));
    const title = type.title[lang.language];
    const kicker = type.kicker[lang.language];
    addDerivedTemplate(
      {
        slug: `${type.slugBase}${lang.slugSuffix}`,
        name: `${title}${lang.nameSuffix}`,
        description: lang.description({ title, typeCode: type.typeCode, tier: type.tier }),
        presetSlug: DERIVED_PRESET.slug,
        slots: labelled,
        layer: { ...SHARED_LAYER, ...("layer" in type ? type.layer : {}), ...lang.layer, "doc.defaultTypeCode": type.typeCode, "doc.defaultTier": type.tier, "doc.language": lang.language },
        slotOverrides: { ...SHARED_SLOT_OVERRIDES, cover: { "cover.kicker.text": kicker } },
        contractKind: null,
      },
      ["seedDocTypeTemplates", "seedStudioTemplates"],
      "seed-doc-type-templates.ts:212-236 composeSpec",
    );
  }
}

// ── C40 template-default fixes (recorded diffs) ─────────────────────────────

interface Fix {
  cp: string;
  manual: string;
  slug: string;
  pointer: string;
  before: unknown;
  after: unknown;
  note: string;
  /** Decision that ordered the fix when it is not C40/row 110 (row 110d: C61, C69, C72). */
  decision?: string;
}
/** Decision tag written on every fix recorded while it is set (row 110d block below). */
let fixDecision: string | undefined;
const fixes: Fix[] = [];
const unfixed = new Map<string, StudioTemplateV2>();

function setLayer(b: Built, key: string, value: ParamValue, cp: string, manual: string, note: string): void {
  const pd = PARAMS_BY_KEY.get(key);
  if (!pd) throw new Error(`fix ${b.slug}: unknown key ${key}`);
  const bad = validateParamValue(pd, value);
  if (bad !== null) throw new Error(`fix ${b.slug}: ${key} invalid: ${bad}`);
  if (stable(b.effective[key]) === stable(value)) return; // already Rev A: no change recorded
  const target = pd.surface === "essential" ? "essentials" : "advanced";
  if (!unfixed.has(b.slug)) unfixed.set(b.slug, clone(b.definition));
  const d = b.definition as unknown as Record<string, ParamRecord>;
  d[target] = { ...(d[target] ?? {}), [key]: value };
  // keep key order stable: essentials first, advanced after (definition object order unchanged)
  if (target === "advanced" && !("advanced" in b.definition)) {
    const { skeleton, roleFormats, ...rest } = b.definition;
    b.definition = { ...rest, advanced: d.advanced, ...(roleFormats !== undefined ? { roleFormats } : {}), skeleton } as StudioTemplateV2;
  }
  fixes.push({ cp, manual, slug: b.slug, pointer: `/${target}/${key}`, before: b.effective[key] ?? null, after: value, note, ...(fixDecision ? { decision: fixDecision } : {}) });
  b.effective = { ...b.effective, [key]: value };
}

function patchRole(b: Built, role: string, sub: string, attrs: Record<string, unknown>, fallback: Record<string, unknown>, cp: string, manual: string, note: string): void {
  if (!unfixed.has(b.slug)) unfixed.set(b.slug, clone(b.definition));
  const own = clone(asRecord(b.definition.roleFormats)) as Record<string, Record<string, unknown>>;
  const stored = asRecord(b.storedRoleFormats[role]) as Record<string, unknown>;
  const baseRole = own[role] ?? (Object.keys(stored).length > 0 ? clone(stored) : {});
  const baseSub = asRecord(baseRole[sub]);
  const nextSub = Object.keys(baseSub).length > 0 ? { ...baseSub, ...attrs } : { ...fallback, ...attrs };
  if (stable(nextSub) === stable(baseSub)) return;
  own[role] = { ...baseRole, [sub]: nextSub };
  const { skeleton, ...rest } = b.definition;
  b.definition = { ...rest, roleFormats: own as StudioTemplateV2["roleFormats"], skeleton } as StudioTemplateV2;
  fixes.push({ cp, manual, slug: b.slug, pointer: `/roleFormats/${role}/${sub}`, before: Object.keys(baseSub).length > 0 ? baseSub : null, after: nextSub, note, ...(fixDecision ? { decision: fixDecision } : {}) });
  b.storedRoleFormats = { ...b.storedRoleFormats, [role]: own[role] };
}

const SEAL = "6E1420";
/** Benchmark run of `wrapper.kicker` (engine/docx/wrapper/formats.ts:177-178) with the Rev A size; used when a template has no own role. */
const KICKER_FALLBACK = { faceRole: "condensed", szHalfPt: 14, color: SEAL, b: true, i: false, caps: true, spacingTw: 30 };

// F1 band text #F4F5F6 (CP-07; ID p.49 Table 8.1 "Pita segel ... teks #F4F5F6"). Param drives the HTML band
// (engine/html/base/css.ts:350 var(--w-cream)) and the DOCX band without own role (formats.ts:229).
// F2 kicker 7,4 pt Cond 600 seal, +0,20 em (CP-04; ID p.47 item 6). DOCX w:sz is in half points: 15 = 7,5 pt is
// the nearest step to 7,4 (14 = 7,0 pt is the measured fail); +0,20 em x 7,4 pt = 29,6 tw -> spacingTw 30.
// F3 control block (CP-05/CP-15; ID p.47 item 10, EN p.49): row 110d (C61) replaced row 110's interim list (the
// original's seed-doc-type-templates.ts:81 list with KLASIFIKASI third) by the manual's 8 fields, now that row 122
// added HALAMAN, DATUM GEODETIK and VERIFIKASI to the engine enum. KLASIFIKASI is NOT a field: the engine prints the
// classification line inside the number cell (CP-15, ID p.13-14 DT-28c), which would otherwise make 9 fields;
// preparer "Divisi Engineering PT GSP" (ID p.47).
// F4 title line <= 150 mm (CP-04; ID p.47 item 7) via R-70 cover.title.maxWidthMm.
// F5 control sheet form (CP-06; ID p.48): subtitle, three signature columns filled, manual column form (R-67..R-69).
/** ID p.47 butir 10 / EN p.49, in the manual's order: number, revision, preparer, custodian, addressee, sheets, geodetic datum, verification. */
const MANUAL_FIELDS: ParamValue = ["NOMOR DOKUMEN", "REVISI", "PENYUSUN", "KUSTODIAN", "DITUJUKAN KEPADA", "HALAMAN", "DATUM GEODETIK", "VERIFIKASI"];
const ROW110D_DECISION = "C61, C69, C72 (row 110d)";
const FIELDS_NOTE = "the manual's 8 fields in order, no KLASIFIKASI (the engine prints the classification line under the number, CP-15; C61, row 110d)";
function coverAndSheetFixes(b: Built): void {
  setLayer(b, "color.wrapper.cream", "F4F5F6", "CP-07", "ID p.49 Tabel 8.1", "band text colour");
  fixDecision = ROW110D_DECISION;
  setLayer(b, "cover.controlBlock.fields", MANUAL_FIELDS, "CP-05, CP-15", "ID p.47 butir 10; EN p.49; ID p.13-14 DT-28c", FIELDS_NOTE);
  fixDecision = undefined;
  setLayer(b, "cover.controlBlock.preparerUnit", "Divisi Engineering PT GSP", "CP-05", "ID p.47", "preparer value; ID text (EN documents should use the -en doc types)");
  setLayer(b, "cover.title.maxWidthMm", 150, "CP-04", "ID p.47 butir 7", "longest title line <= 150 mm");
  setLayer(b, "controlSheet.subtitle.enabled", true, "CP-06", "ID p.48", "control-sheet subtitle");
  setLayer(b, "controlSheet.signatures.fillRoles", true, "CP-06, CP-09", "ID p.48; ID p.10 DT-02", "three signature columns");
  setLayer(b, "controlSheet.columns.form", "manual", "CP-06", "ID p.48", "manual column form of the control-sheet tables");
}

// datum-kanonik: cases 01 and 05 (all C40 cover and control-sheet defaults).
{
  const b = built.get("datum-kanonik")!;
  coverAndSheetFixes(b);
  patchRole(b, "wrapper.kicker", "run", { szHalfPt: 15, color: SEAL, caps: true, spacingTw: 30 }, KICKER_FALLBACK, "CP-04", "ID p.47 butir 6; ID p.48 DT-13c", "kicker 7,5 pt (nearest half point to 7,4) seal caps +0,20 em");
}
// datum-gsp-preset: the GSP family (datum-gsp, datum-gsp-rev-a-preset, 10 doc types, laporan-kerja-agen). Own
// measured roles win whole over the param (formats.ts:403-405), so the band and kicker runs are patched too.
{
  const b = built.get("datum-gsp-preset")!;
  setLayer(b, "color.wrapper.cream", "F4F5F6", "CP-07", "ID p.49 Tabel 8.1", "band text colour (HTML band)");
  patchRole(b, "wrapper.sealBand", "run", { color: "F4F5F6" }, {}, "CP-07", "ID p.49 Tabel 8.1", "band text colour (DOCX band role)");
  patchRole(b, "wrapper.kicker", "run", { szHalfPt: 15 }, KICKER_FALLBACK, "CP-04", "ID p.47 butir 6", "kicker 7,5 pt (nearest half point to 7,4)");
  // Row 49a (C104 M1): the measured band run (szHalfPt 12 = 6,0 pt) wins over the engine role, so the GSP family needs
  // the size here too; datum-kanonik has no own band role and follows engine/docx/wrapper/formats.ts (cond(13)).
  fixDecision = "C104 (row 49a)";
  patchRole(b, "wrapper.sealBand", "run", { szHalfPt: 13 }, {}, "C104 M1", "ID p.90 Tabel A.2 pita segel 6,4 (manual_id.txt:4920)", "band text 6,5 pt (w:sz 13, nearest half point to 6,4, as the C54 kicker ruling); was 6,0 pt");
  fixDecision = undefined;
}
// Templates derived from datum-gsp-preset now inherit the fixed cream value (effective values, checks only).
for (const b of built.values()) {
  let p = b.definition.preset?.slug;
  while (p && p !== "datum-gsp-preset") p = built.get(p)?.definition.preset?.slug;
  if (p === "datum-gsp-preset") b.effective = { ...b.effective, "color.wrapper.cream": "F4F5F6" };
}
// datum-gsp: cover and control-sheet defaults (case 06 X; B-O through these recorded diffs, C40/C23).
coverAndSheetFixes(built.get("datum-gsp")!);
// Row 174 (C218 F146b-5): datum-gsp reserves the rail column like the Rev A family (SHARED_LAYER above). Without it, in
// rail mode K2 a paragraph with no rail chip is set at the full 165,9 mm (RAIL_K2_CSS max-width:none, html/base/shell.ts)
// and DATUM-15 fails (run 146b; 91,4 characters per line measured in the real bridge, test/row174 e2e).
fixDecision = "C218 (row 174)";
setLayer(built.get("datum-gsp")!, "render.rail.reserveColumn", true, "F146b-5", "ID:2705-2711; EN:2764 (seed-doc-type-templates.ts:69)", "rail column reserved on interior pages, body paragraphs at the text column (DATUM-15)");
fixDecision = undefined;

// ── Row 110d (C61, C69, C72): Rev A control block and control-sheet data on every shipped template ──
//
// Values (manual pages are the printed page numbers of research/manual_rev_a/manual_{id,en}.txt):
// - cover.controlBlock.fields: MANUAL_FIELDS (ID p.47 butir 10, EN p.49).
// - R-83 cover.controlBlock.geodeticDatum = "WGS 84": the manual's datum for every coordinate (ID p.37 DT-30i "(WGS 84)",
//   EN p.38 DT-30i "(WGS 84)"). The R-83 default "" makes the engine skip the DATUM GEODETIK field (params/render.ts R-83).
// - R-82 controlSheet.distribution.defaults: the master-copy row of the manual's own control sheet (ID p.2 "C · DISTRIBUSI
//   TERKENDALI": Induk / Divisi Engineering PT GSP (ENG-01) / Word dan PDF, folder standar / Tidak; EN p.2 "C · CONTROLLED
//   DISTRIBUTION": Master / Engineering Division, PT GSP (ENG-01) / Word and PDF, standards folder / No). The second row
//   (Kerja/Working: GSP writers and AI writing systems) names the manual's own readers and is not a template default.
// - R-81 controlSheet.methodStatement.text stays "" (not printed): the manual gives no generic method statement. Its own
//   (ID p.2 "Manual ini mengatur bentuk dan bahasa, bukan isi teknis ...") describes the manual, not a document type,
//   and p.48 only says the control sheet holds one. It is document content.
// Root presets carry the ID values; templates inherit them; a template with its own (older) value or another edition
// gets its own key. Restricted fixtures (C54) are left as measured.
const GEODETIC_DATUM: ParamValue = "WGS 84";
const DISTRIBUTION: Record<DocLanguage, ParamValue> = {
  ID: { rows: [["Induk", "Divisi Engineering PT GSP (ENG-01)", "Word dan PDF, folder standar", "Tidak"]] },
  EN: { rows: [["Master", "Engineering Division, PT GSP (ENG-01)", "Word and PDF, standards folder", "No"]] },
};
const ROW110D_KEYS = ["cover.controlBlock.fields", "cover.controlBlock.geodeticDatum", "controlSheet.distribution.defaults"];
const ownsKey = (b: Built, key: string): boolean => key in (b.definition.essentials ?? {}) || key in asRecord(b.definition.advanced);
const languageOf = (b: Built): DocLanguage => (b.effective["doc.language"] === "EN" ? "EN" : "ID");
function row110dData(b: Built): void {
  setLayer(b, "cover.controlBlock.fields", MANUAL_FIELDS, "CP-05, CP-15", "ID p.47 butir 10; EN p.49; ID p.13-14 DT-28c", FIELDS_NOTE);
  setLayer(b, "cover.controlBlock.geodeticDatum", GEODETIC_DATUM, "CP-05", "ID p.37 DT-30i; EN p.38 DT-30i; ID p.47 butir 10", "R-83 geodetic datum of the control block: WGS 84, the manual's coordinate datum");
  setLayer(b, "controlSheet.distribution.defaults", DISTRIBUTION[languageOf(b)], "CP-06", languageOf(b) === "EN" ? "EN p.2 C; EN p.49-50" : "ID p.2 C; ID p.48 DT-13b", `R-82 controlled distribution, master-copy row of the manual's ${languageOf(b)} control sheet`);
}
fixDecision = ROW110D_DECISION;
const SHIPPED_BUILT = [...built.values()].filter((b) => !FIXTURE_SLUGS.includes(b.slug));
for (const b of SHIPPED_BUILT.filter((x) => !x.definition.preset)) row110dData(b);
// Effective values follow the preset chain (insertion order puts every preset before the templates on it).
for (const b of SHIPPED_BUILT.filter((x) => x.definition.preset)) {
  const parent = built.get(b.definition.preset!.slug)!;
  for (const key of ROW110D_KEYS) if (!ownsKey(b, key)) b.effective = { ...b.effective, [key]: parent.effective[key] };
}
for (const b of SHIPPED_BUILT.filter((x) => x.definition.preset)) row110dData(b);
fixDecision = undefined;

// ── Validation (vendored engine schema + validators) ────────────────────────

const ajv = new Ajv2020({ ...STUDIO_AJV_OPTIONS });
for (const schema of STUDIO_SCHEMA_LOAD_ORDER) ajv.addSchema(schema as unknown as AnySchema);
const validateV2 = ajv.getSchema(TEMPLATE_V2_SCHEMA_URL);
if (!validateV2) throw new Error(`schema ${TEMPLATE_V2_SCHEMA_URL} not registered`);

const report: Record<string, unknown>[] = [];
const MAX_DEF_BYTES = 512 * 1024;
for (const b of built.values()) {
  const text = `${JSON.stringify(b.definition, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  const issues: string[] = [];
  if (!validateV2(b.definition)) issues.push(...(validateV2.errors ?? []).map((e) => `ajv ${e.instancePath} ${e.message}`));
  try {
    parseTemplateV2(JSON.parse(text), "");
  } catch (e) {
    issues.push(`parseTemplateV2: ${(e as Error).message}`);
  }
  try {
    validateSkeleton(b.definition.skeleton);
  } catch (e) {
    issues.push(`validateSkeleton: ${(e as Error).message}`);
  }
  try {
    assertTemplateLayerKeys(templateLayerOf(b.definition), "/essentials");
  } catch (e) {
    issues.push(`assertTemplateLayerKeys: ${(e as Error).message}`);
  }
  if (b.definition.roleFormats) {
    const r = validateRoleFormats(b.definition.roleFormats);
    issues.push(...r.issues.map((i) => `roleFormats ${i.pointer} ${i.message}`));
  }
  for (const [k, v] of Object.entries(templateLayerOf(b.definition))) {
    const pd = PARAMS_BY_KEY.get(k);
    if (!pd) issues.push(`unknown key ${k}`);
    else if (validateParamValue(pd, v) !== null) issues.push(`${k}: ${validateParamValue(pd, v)}`);
  }
  if (bytes > MAX_DEF_BYTES) issues.push(`size ${bytes} > ${MAX_DEF_BYTES}`);
  const restriction = templateRestriction(b.effective);
  report.push({
    slug: b.slug,
    bytes,
    sha256: createHash("sha256").update(text).digest("hex"),
    skeletonSha256: skeletonSha256(validateSkeleton(b.definition.skeleton)),
    language: b.effective["doc.language"] ?? null,
    restricted: restriction.restricted,
    releasedChecks: restriction.releasedChecks,
    issues,
    text,
  });
}
const failed = report.filter((r) => (r.issues as string[]).length > 0);

// ── Write ───────────────────────────────────────────────────────────────────

const ORDER = [
  "datum-kanonik-preset", "datum-kanonik", "datum-gsp-preset", "datum-gsp", "datum-gsp-rev-a-preset",
  "datum-manual-000-preset", "datum-manual-000", "laporan-kerja-agen",
  ...DOC_TYPE_LAYERS.flatMap((t) => LANGUAGE_LAYERS.map((l) => `${t.slugBase}${l.slugSuffix}`)),
];
if (ORDER.length !== built.size || ORDER.some((s) => !built.has(s))) throw new Error(`slug order mismatch: ${[...built.keys()].join(",")}`);
const SHIPPED = ORDER.filter((s) => !FIXTURE_SLUGS.includes(s));
const dirOf = (slug: string): string => (FIXTURE_SLUGS.includes(slug) ? FIXTURES : OUT);
for (const slug of SHIPPED) {
  // A shipped template may never reach a restricted (fixture) preset.
  let p = built.get(slug)!.definition.preset?.slug;
  while (p) {
    if (FIXTURE_SLUGS.includes(p)) throw new Error(`shipped ${slug} depends on fixture ${p}`);
    p = built.get(p)?.definition.preset?.slug;
  }
}

const entryOf = (slug: string) => {
    const b = built.get(slug)!;
    const r = report.find((x) => x.slug === slug)!;
    return {
      slug,
      file: `${slug}.json`,
      sha256: r.sha256,
      bytes: r.bytes,
      name: b.name,
      description: b.description,
      kind: b.kind,
      isPreset: b.isPreset,
      contractKind: b.contractKind,
      preset: b.definition.preset?.slug ?? null,
      language: r.language,
      restricted: r.restricted,
      releasedChecks: r.releasedChecks,
      skeletonSha256: r.skeletonSha256,
      slots: b.definition.skeleton.slots.map((s) => s.slotKey),
      c40Fixes: fixes.filter((f) => f.slug === slug).length,
      seedRef: b.seedRef,
      sources: b.sources.map((k) => sourceShas[k]),
    };
};
// ── Row 110e (C75): the manual's cover logo per edition, shipped with the builtins ──────────────
// The fold (vendor services/templates/index.ts foldTemplateDefinition) gives every version folded on a
// builtin the `editionAssets` of its resolved `doc.language`, so builtins and user copies fold alike.
// - ID: DT-13c (ID p.48) "Logo, kop, pita segel, klasifikasi, dan kicker jenis dokumen bernilai seal"
//   -> gsp-seal.png (gsp-tinta.png recoloured to #6E1420, C46 / row 117b).
// - EN: DT-13c (EN p.50) "keep the logo black" and Table 8.1 (EN p.51) "Black ink, once: on the cover"
//   -> gsp-tinta.png (the black ink mark; also the engine's fallback, media.ts DEFAULT_LOGO_REL_PATH).
// - Both: cover item 2 "Logo, 44 sampai 46 mm" (ID p.47, EN p.49) and DT-14 "logo once" (ID p.47,
//   EN p.49): the engines place it once, on the cover, at 44 mm (CP-02).
// The files sit under the Studio asset root (row 107: resolveRepoAssetPath + assertStudioAssetPath accept
// template assets only there) and are byte copies of datum-house-style/assets/logo/ (sha checked here).
const STUDIO_ASSET_ROOT_REL = "src/lib/studio/assets";
const HOUSE_STYLE_LOGO = path.join(PKG, "..", "desktop", "datum", "datum-house-style", "assets", "logo");
const EDITION_LOGOS = [
  { language: "ID", file: "gsp-seal.png", manual: "DT-13c ID p.48 (logo in seal; C46 derived file); cover item 2 ID p.47 (44-46 mm); DT-14 ID p.47 (once)" },
  { language: "EN", file: "gsp-tinta.png", manual: "DT-13c EN p.50 (keep the logo black); Table 8.1 EN p.51 (black ink, once, on the cover); cover item 2 EN p.49 (44-46 mm); DT-14 EN p.49 (once)" },
] as const;
const editionAssets: Record<string, Record<string, { sha256: string; path: string; kind: "raster" }>> = {};
const editionAssetsRef: Record<string, unknown>[] = [];
for (const l of EDITION_LOGOS) {
  const rel = `${STUDIO_ASSET_ROOT_REL}/logo/${l.file}`;
  const shipped = path.join(VENDOR, ...rel.split("/"));
  const source = path.join(HOUSE_STYLE_LOGO, l.file);
  const sha = sha256File(shipped);
  const srcSha = sha256File(source);
  if (sha !== srcSha) throw new Error(`edition logo ${l.file}: shipped sha ${sha} differs from datum-house-style ${srcSha}`);
  editionAssets[l.language] = { logo: { sha256: sha, path: rel, kind: "raster" } };
  editionAssetsRef.push({ language: l.language, asset: "logo", path: rel, sha256: sha, bytes: readFileSync(shipped).length, sameBytesAs: `packages/desktop/datum/datum-house-style/assets/logo/${l.file}`, manual: l.manual });
}
for (const slug of SHIPPED) {
  const lang = report.find((x) => x.slug === slug)!.language as string | null;
  if (!lang || !editionAssets[lang]) throw new Error(`shipped ${slug}: doc.language ${String(lang)} has no edition logo`);
}

const catalog = {
  $schema: "datum-studio.builtin-templates/v1",
  note: "Builtin DATUM Studio templates (read-only, changed only in a release). Exported by scripts/export-builtin-templates.ts (row 110); never edit by hand. Restricted templates are excluded (C54) and live in test-fixtures/templates/.",
  provenanceCommit: PROVENANCE_COMMIT,
  sources: sourceShas,
  count: SHIPPED.length,
  // Row 110e (C75): doc.language -> template assets given to every version folded on a builtin.
  editionAssets,
  editionAssetsRef,
  excluded: FIXTURE_SLUGS.map((slug) => ({ slug, reason: "C54: restricted, releases lint checks; test fixture only", location: `test-fixtures/templates/${slug}.json` })),
  templates: SHIPPED.map(entryOf),
};
const fixtureCatalog = {
  $schema: "datum-studio.builtin-templates/v1",
  note: "TEST FIXTURES ONLY, never shipped (C54): restricted templates exported by scripts/export-builtin-templates.ts.",
  provenanceCommit: PROVENANCE_COMMIT,
  sources: sourceShas,
  count: FIXTURE_SLUGS.length,
  templates: FIXTURE_SLUGS.map(entryOf),
};

const c40 = {
  $schema: "datum-studio.c40-template-fixes/v1",
  decision: "C40 (decisions/decisions.md): template defaults owned by row 110; fixes with a `decision` field were made by row 110d (C61, C69, C72)",
  count: fixes.length,
  fixes,
};

if (failed.length > 0) {
  for (const f of failed) console.error(`INVALID ${f.slug}: ${(f.issues as string[]).join(" | ")}`);
}
const summary = {
  templates: ORDER.length,
  shipped: SHIPPED.length,
  fixtures: FIXTURE_SLUGS,
  valid: ORDER.length - failed.length,
  failed: failed.map((f) => f.slug),
  presets: catalog.templates.filter((t) => t.isPreset).map((t) => t.slug),
  restrictedShipped: catalog.templates.filter((t) => t.restricted).map((t) => t.slug),
  largestShippedBytes: Math.max(...report.filter((r) => SHIPPED.includes(r.slug as string)).map((r) => r.bytes as number)),
  fixes: fixes.length,
  gspCorrections,
  gspDroppedOverrides: gspDropped,
  presetReports,
  logEntries: logs.length,
};

if (CHECK_ONLY) {
  let drift = 0;
  for (const r of report) {
    const f = path.join(dirOf(r.slug as string), `${r.slug}.json`);
    if (!existsSync(f) || readFileSync(f, "utf8") !== r.text) {
      drift++;
      console.error(`DRIFT ${r.slug}`);
    }
  }
  for (const [dir, cat] of [[OUT, catalog], [FIXTURES, fixtureCatalog]] as const) {
    const f = path.join(dir, "catalog.json");
    if (!existsSync(f) || readFileSync(f, "utf8") !== `${JSON.stringify(cat, null, 2)}\n`) {
      drift++;
      console.error(`DRIFT ${path.relative(PKG, f)}`);
    }
  }
  for (const slug of FIXTURE_SLUGS) {
    if (existsSync(path.join(OUT, `${slug}.json`))) {
      drift++;
      console.error(`SHIPPED-FIXTURE ${slug} still in templates/`);
    }
  }
  console.log(JSON.stringify({ ...summary, drift }, null, 2));
  process.exit(failed.length > 0 || drift > 0 ? 1 : 0);
}
if (failed.length > 0) process.exit(1);

mkdirSync(path.join(OUT, "c40_fixes"), { recursive: true });
mkdirSync(FIXTURES, { recursive: true });
for (const slug of FIXTURE_SLUGS) if (existsSync(path.join(OUT, `${slug}.json`))) throw new Error(`${slug}.json is still in templates/: move it to test-fixtures/templates/ first (files are never deleted)`);
for (const r of report) writeFileSync(path.join(dirOf(r.slug as string), `${r.slug}.json`), r.text as string);
writeFileSync(path.join(OUT, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(path.join(FIXTURES, "catalog.json"), `${JSON.stringify(fixtureCatalog, null, 2)}\n`);
writeFileSync(path.join(OUT, "c40_fixes", "c40_fixes.json"), `${JSON.stringify(c40, null, 2)}\n`);
// Unified diffs of each fixed definition (before = seed export, after = shipped file).
const scratch = process.env.ROW110_SCRATCH ?? path.join(process.env.TMPDIR ?? "/tmp", "row110-diff");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
for (const [slug, before] of unfixed) {
  const a = path.join(scratch, `${slug}.seed.json`);
  writeFileSync(a, `${JSON.stringify(before, null, 2)}\n`);
  const p = Bun.spawnSync(["diff", "-u", "--label", `seed-export/${slug}.json`, "--label", `templates/${slug}.json`, a, path.join(OUT, `${slug}.json`)]);
  writeFileSync(path.join(OUT, "c40_fixes", `${slug}.diff`), p.stdout);
}
console.log(JSON.stringify(summary, null, 2));
