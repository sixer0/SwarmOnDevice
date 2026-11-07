/**
 * Profil templat murni (S49; 01_specs.md §1.2 M01-M02, §5.5, §5.6, §8.2 I39).
 *
 * Tanpa I/O dan tanpa Prisma: dipakai layanan DB (`index.ts`), impor berkas
 * (`import.ts`), seed S70, dan CLI benchmark (S67/S97) yang merender tanpa DB.
 *
 * Model lapisan (pewarisan):
 *   default registri (profil DATUM-kanonik)
 *     <- overrides rantai versi dasar (akar -> induk; profil turunan, mis. `datum-manual-000`)
 *     <- overrides milik versi ini
 *   lalu semua kelas T dihitung ulang mesin token (S11). Kelas T TIDAK pernah
 *   disimpan sebagai override; nilai terhitungnya hanya ada di `resolvedParams`.
 *
 * Validasi kunci terhadap registri (0 kunci asing): parameter (`ALL_PARAMS`),
 * peran (`ROLE_KEYS`) dan medan `RoleFormat`, tier (`STUDIO_TIERS`), section
 * (`SECTION_REGISTRY`). Bentuk nilai RoleFormat diperiksa ajv terhadap `$defs`
 * skema bersama (ParaFormat, RunProps, Borders, Shading).
 */
import { sha256Hex, stableStringify } from "../ingest/util";
import { studioAjv, studioValidator } from "../ingest/validate";
import type {
  ParamDef,
  ParamIssue,
  ParamMap,
  ParamValue,
  ResolvedTemplate,
  RoleFormat,
  RoleFormatMap,
  RoleKey,
  SectionPlan,
  StudioTemplateKind,
  StudioTier,
  TemplateProvenance,
} from "../../contract";
import { PROVENANCE_MARKS, ROLE_KEYS, STUDIO_TEMPLATE_KINDS, STUDIO_TIERS } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import { commonRef, JSON_SCHEMA_DIALECT, STUDIO_SCHEMA_URL_BASE } from "../../contract/schema/common.schema";
import { resolveParams } from "../../engine/tokens";
import { checkOverrides, effectiveClass } from "../../engine/tokens/merge";
import { ALL_PARAMS } from "../../params";
import { CANONICAL_REQUIRED_BY_TIER, SECTION_REGISTRY } from "../../registry/sections";

// ── Konstanta ────────────────────────────────────────────────────────────

/** Slug profil DATUM-kanonik (H01 `base: "datum-kanonik"`). */
export const DATUM_CANONICAL_SLUG = "datum-kanonik";
/** Slug profil benchmark Manual 000 (D-44). */
export const MANUAL000_SLUG = "datum-manual-000";
export const TEMPLATE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TEMPLATE_SLUG_MAX = 64;
export const TEMPLATE_NAME_MAX = 200;
/** Batas kedalaman rantai versi dasar (penjaga siklus). */
export const TEMPLATE_BASE_CHAIN_MAX = 32;
/** Medan sah `RoleFormat` (engine.ts). */
export const ROLE_FORMAT_FIELDS = [
  "para",
  "run",
  "labelRun",
  "numberRun",
  "markerRun",
  "glyphRun",
  "cell",
  // Delta S03-d1 kontrak RoleFormat (RQ-4, permintaan RT-01).
  "labelRunByMark",
  "rightCell",
  "firstRowCell",
  "signatureCell",
] as const;

export type TemplateAssets = Record<string, { sha256: string; path: string; kind: string }>;
export const TEMPLATE_ASSET_KINDS = ["font", "raster", "base"] as const;

export type ParamRecord = Record<string, ParamValue>;

// ── Utilitas ─────────────────────────────────────────────────────────────

// S85 R-08: JSON kanonik + sha256 satu sumber (services/ingest/util); untuk data
// JSON murni keluarannya identik dengan implementasi lama (paramsSha256 tetap).
export { sha256Hex, stableStringify };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

const ISSUE_RANK: Record<ParamIssue["code"], number> = {
  PARAM_CLASS_K_FORBIDDEN: 0,
  PARAM_CLASS_T_READONLY: 1,
  PARAM_UNKNOWN_KEY: 2,
  SCHEMA_INVALID: 3,
};

/** Lempar `StudioEngineError` berkode isu peringkat teratas; semua isu di `details.issues` (pola S11). */
export function throwIssues(issues: readonly ParamIssue[], prefix?: string): never {
  const first = [...issues].sort((a, b) => ISSUE_RANK[a.code] - ISSUE_RANK[b.code])[0];
  const more = issues.length > 1 ? ` (+${issues.length - 1} isu lain)` : "";
  throw new StudioEngineError(first.code, `${prefix ? prefix + ": " : ""}${first.message}${more}`, { issues });
}

// ── Provenans ────────────────────────────────────────────────────────────

let registryDigestCache: string | undefined;

/** Sidik registri parameter = sha256 JSON stabil seluruh ParamDef (skema sama dengan seed S70). */
export function registryDigest(registry: readonly ParamDef[] = ALL_PARAMS): string {
  if (registry === ALL_PARAMS && registryDigestCache) return registryDigestCache;
  const d = sha256Hex(stableStringify(registry));
  if (registry === ALL_PARAMS) registryDigestCache = d;
  return d;
}

export const CATALOG_DOC = "docs/2026-10-22_doc_artifact_studio/research/01_manual_parameter_catalog.md";

/**
 * Provenans default versi templat (Kc-01), selaras seed S70
 * (`prisma/seed-studio.ts` PROVENANCE_BASE; research/01 §0.1).
 */
export function defaultProvenance(): TemplateProvenance {
  return {
    tokensVersion: "tokens.json 2.0.0",
    manualRevision: "000/GSP/STD/X/2026 Rev A",
    skillVersion: "datum-house-style 2.6.0",
    catalogRef: `${CATALOG_DOC}; registri params sha256:${registryDigest().slice(0, 16)}`,
  };
}

// ── Rencana section kanonik (§5.5) ───────────────────────────────────────

/**
 * Section wajib per tier: sejak delta S03-d2 (IP-23) didefinisikan di
 * `registry/sections.ts` (aman-klien) dan diekspor ulang di sini agar impor
 * lama tetap sah.
 */
export { CANONICAL_REQUIRED_BY_TIER };

/**
 * Rencana section default profil DATUM-kanonik dari registri (identik seed
 * S70): terlarang = tidak aktif di tier ATAU tidak renderable (kanal C01-C15);
 * wajib = `CANONICAL_REQUIRED_BY_TIER`; sisanya opsional; urutan registri.
 * SERAH `requiredPresets.registerTable = ["reconciliation"]`.
 */
export function canonicalSectionPlan(): SectionPlan {
  const plan: SectionPlan = {};
  for (const tier of STUDIO_TIERS) {
    const req = new Set(CANONICAL_REQUIRED_BY_TIER[tier]);
    const required: string[] = [];
    const optional: string[] = [];
    const forbidden: string[] = [];
    for (const s of SECTION_REGISTRY) {
      if (!(s.renderable && s.activeTiers.includes(tier))) forbidden.push(s.key);
      else if (req.has(s.key)) required.push(s.key);
      else optional.push(s.key);
    }
    plan[tier] = tier === "SERAH" ? { required, optional, forbidden, requiredPresets: { registerTable: ["reconciliation"] } } : { required, optional, forbidden };
  }
  return plan;
}

/** Entri rencana untuk satu tier (kosong bila templat tidak mendefinisikannya). */
export function sectionPlanForTier(plan: SectionPlan, tier: StudioTier): SectionPlan[string] {
  return plan[tier] ?? { required: [], optional: [], forbidden: [] };
}

// ── Validasi rencana section ─────────────────────────────────────────────

const SECTION_BY_KEY = new Map(SECTION_REGISTRY.map((s) => [s.key, s]));
const PLAN_LISTS = ["required", "optional", "forbidden"] as const;
/** Medan tier di luar tiga daftar: `requiredPresets` (§5.5), `order` (delta S03-d2, IP-23). */
const PLAN_EXTRA_FIELDS = ["requiredPresets", "order"] as const;

/**
 * Validasi dan normalisasi `SectionPlan` (daftar yang tidak ada -> []).
 * Isu: tier/section/preset tak dikenal -> PARAM_UNKNOWN_KEY; bentuk salah,
 * kunci di dua daftar, section tak-renderable diwajibkan, preset untuk section
 * terlarang -> SCHEMA_INVALID. Medan opsional `order` (delta S03-d2) disimpan
 * apa adanya bila sah: kunci tak dikenal -> PARAM_UNKNOWN_KEY; ganda atau tidak
 * tercantum di daftar tier -> SCHEMA_INVALID.
 */
export function validateSectionPlan(raw: unknown, root = "/sectionPlan"): { plan: SectionPlan; issues: ParamIssue[] } {
  const issues: ParamIssue[] = [];
  const plan: SectionPlan = {};
  if (!isPlainObject(raw)) {
    issues.push({ key: "sectionPlan", code: "SCHEMA_INVALID", message: "sectionPlan harus objek per tier", pointer: root });
    return { plan, issues };
  }
  for (const tier of Object.keys(raw).sort()) {
    const tp = `${root}/${pointerSegment(tier)}`;
    if (!(STUDIO_TIERS as readonly string[]).includes(tier)) {
      issues.push({ key: tier, code: "PARAM_UNKNOWN_KEY", message: `Tier tidak dikenal di sectionPlan: ${tier}`, pointer: tp });
      continue;
    }
    const entry = raw[tier];
    if (!isPlainObject(entry)) {
      issues.push({ key: tier, code: "SCHEMA_INVALID", message: `sectionPlan.${tier} harus objek`, pointer: tp });
      continue;
    }
    for (const f of Object.keys(entry)) {
      if (!(PLAN_LISTS as readonly string[]).includes(f) && !(PLAN_EXTRA_FIELDS as readonly string[]).includes(f)) {
        issues.push({ key: f, code: "PARAM_UNKNOWN_KEY", message: `Medan tidak dikenal sectionPlan.${tier}.${f}`, pointer: `${tp}/${pointerSegment(f)}` });
      }
    }
    const lists: Record<(typeof PLAN_LISTS)[number], string[]> = { required: [], optional: [], forbidden: [] };
    const seen = new Map<string, string>();
    for (const listName of PLAN_LISTS) {
      const lp = `${tp}/${listName}`;
      const arr = entry[listName];
      if (arr === undefined) continue;
      if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) {
        issues.push({ key: listName, code: "SCHEMA_INVALID", message: `sectionPlan.${tier}.${listName} harus larik string`, pointer: lp });
        continue;
      }
      (arr as string[]).forEach((key, i) => {
        const def = SECTION_BY_KEY.get(key);
        if (!def) {
          issues.push({ key, code: "PARAM_UNKNOWN_KEY", message: `Section tidak dikenal di registri: ${key}`, pointer: `${lp}/${i}` });
          return;
        }
        const prev = seen.get(key);
        if (prev) {
          issues.push({ key, code: "SCHEMA_INVALID", message: `Section ${key} muncul di ${prev} dan ${listName} (tier ${tier})`, pointer: `${lp}/${i}` });
          return;
        }
        if (listName === "required" && !def.renderable) {
          issues.push({ key, code: "SCHEMA_INVALID", message: `Section ${key} tidak dapat dirender sehingga tidak dapat diwajibkan`, pointer: `${lp}/${i}` });
          return;
        }
        seen.set(key, listName);
        lists[listName].push(key);
      });
    }
    const out: SectionPlan[string] = { required: lists.required, optional: lists.optional, forbidden: lists.forbidden };
    const presets = entry.requiredPresets;
    if (presets !== undefined) {
      const pp = `${tp}/requiredPresets`;
      if (!isPlainObject(presets)) {
        issues.push({ key: "requiredPresets", code: "SCHEMA_INVALID", message: `sectionPlan.${tier}.requiredPresets harus objek`, pointer: pp });
      } else {
        const rp: Record<string, readonly string[]> = {};
        for (const key of Object.keys(presets).sort()) {
          const kp = `${pp}/${pointerSegment(key)}`;
          const v = presets[key];
          if (!SECTION_BY_KEY.has(key)) {
            issues.push({ key, code: "PARAM_UNKNOWN_KEY", message: `Section tidak dikenal di requiredPresets: ${key}`, pointer: kp });
          } else if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0 || x.length > 64)) {
            issues.push({ key, code: "SCHEMA_INVALID", message: `requiredPresets.${key} harus larik nama preset`, pointer: kp });
          } else if (seen.get(key) === "forbidden") {
            issues.push({ key, code: "SCHEMA_INVALID", message: `Section ${key} terlarang di tier ${tier} tetapi memiliki preset wajib`, pointer: kp });
          } else {
            rp[key] = [...(v as string[])];
          }
        }
        out.requiredPresets = rp;
      }
    }
    // `order` (opsional): urutan tampil lintas status; kunci registri, unik,
    // dan masing-masing tercantum di salah satu daftar tier ini.
    const order = entry.order;
    if (order !== undefined) {
      const op = `${tp}/order`;
      if (!Array.isArray(order) || order.some((x) => typeof x !== "string")) {
        issues.push({ key: "order", code: "SCHEMA_INVALID", message: `sectionPlan.${tier}.order harus larik kunci section`, pointer: op });
      } else {
        const keys: string[] = [];
        const inOrder = new Set<string>();
        (order as string[]).forEach((key, i) => {
          const kp = `${op}/${i}`;
          if (!SECTION_BY_KEY.has(key)) {
            issues.push({ key, code: "PARAM_UNKNOWN_KEY", message: `Section tidak dikenal di order: ${key}`, pointer: kp });
          } else if (inOrder.has(key)) {
            issues.push({ key, code: "SCHEMA_INVALID", message: `Section ${key} muncul dua kali di order (tier ${tier})`, pointer: kp });
          } else if (!seen.has(key)) {
            issues.push({ key, code: "SCHEMA_INVALID", message: `Section ${key} di order tidak tercantum di required/optional/forbidden tier ${tier}`, pointer: kp });
          } else {
            inOrder.add(key);
            keys.push(key);
          }
        });
        out.order = keys;
      }
    }
    plan[tier] = out;
  }
  return { plan, issues };
}

// ── Validasi roleFormats ─────────────────────────────────────────────────

const ROLE_FORMAT_SCHEMA_ID = `${STUDIO_SCHEMA_URL_BASE}/template-role-format/v1.json`;
const RUN_REF = commonRef("RunProps");
const CELL_FORMAT_REF = commonRef("CellFormat");
/** Peta tanda provenans -> RunProps (glyphRun, labelRunByMark). */
const RUN_BY_MARK = {
  type: "object",
  properties: Object.fromEntries(PROVENANCE_MARKS.map((m) => [m, RUN_REF])),
  additionalProperties: false,
} as const;

const roleFormatSchema = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: ROLE_FORMAT_SCHEMA_ID,
  type: "object",
  properties: {
    para: commonRef("ParaFormat"),
    run: RUN_REF,
    labelRun: RUN_REF,
    numberRun: RUN_REF,
    markerRun: RUN_REF,
    glyphRun: RUN_BY_MARK,
    cell: {
      type: "object",
      properties: {
        borders: commonRef("Borders"),
        marginsTw: {
          type: "object",
          properties: Object.fromEntries(["top", "left", "bottom", "right"].map((s) => [s, { type: "integer" }])),
          additionalProperties: false,
        },
        shading: commonRef("Shading"),
      },
      additionalProperties: false,
    },
    // Delta S03-d1 (RQ-4): bentuk sama dengan medan kontrak sejenis.
    labelRunByMark: RUN_BY_MARK,
    rightCell: CELL_FORMAT_REF,
    firstRowCell: CELL_FORMAT_REF,
    signatureCell: CELL_FORMAT_REF,
  },
  additionalProperties: false,
} as const;

type RoleFormatValidator = ((v: unknown) => boolean) & {
  errors?: Array<{ instancePath: string; message?: string; keyword: string }> | null;
};
/**
 * SR-55 M8: skema RoleFormat lokal didaftarkan SEKALI ke instans Ajv Studio bersama
 * (`commonSchema` sudah dimuat di sana), lalu validatornya ter-cache di `studioValidator`.
 */
function getRoleFormatValidator(): RoleFormatValidator {
  const ajv = studioAjv();
  if (!ajv.getSchema(ROLE_FORMAT_SCHEMA_ID)) ajv.addSchema(roleFormatSchema);
  return studioValidator(ROLE_FORMAT_SCHEMA_ID) as unknown as RoleFormatValidator;
}

/** Validasi `RoleFormatMap`: kunci peran di `ROLE_KEYS`, medan di `ROLE_FORMAT_FIELDS`, nilai lolos `$defs` bersama. */
export function validateRoleFormats(raw: unknown, root = "/roleFormats"): { roleFormats: RoleFormatMap; issues: ParamIssue[] } {
  const issues: ParamIssue[] = [];
  const out: Partial<Record<RoleKey, RoleFormat>> = {};
  if (!isPlainObject(raw)) {
    issues.push({ key: "roleFormats", code: "SCHEMA_INVALID", message: "roleFormats harus objek peran -> format", pointer: root });
    return { roleFormats: out, issues };
  }
  const validate = getRoleFormatValidator();
  for (const role of Object.keys(raw).sort()) {
    const rp = `${root}/${pointerSegment(role)}`;
    if (!(ROLE_KEYS as readonly string[]).includes(role)) {
      issues.push({ key: role, code: "PARAM_UNKNOWN_KEY", message: `Peran tidak dikenal: ${role}`, pointer: rp });
      continue;
    }
    const v = raw[role];
    if (!isPlainObject(v)) {
      issues.push({ key: role, code: "SCHEMA_INVALID", message: `roleFormats.${role} harus objek`, pointer: rp });
      continue;
    }
    const unknownFields = Object.keys(v).filter((f) => !(ROLE_FORMAT_FIELDS as readonly string[]).includes(f));
    for (const f of unknownFields) {
      issues.push({ key: `${role}.${f}`, code: "PARAM_UNKNOWN_KEY", message: `Medan RoleFormat tidak dikenal: ${role}.${f}`, pointer: `${rp}/${pointerSegment(f)}` });
    }
    if (unknownFields.length > 0) continue;
    if (!validate(v)) {
      for (const e of validate.errors ?? []) {
        issues.push({
          key: role,
          code: "SCHEMA_INVALID",
          message: `roleFormats.${role}${e.instancePath.replace(/\//g, ".")} ${e.message ?? e.keyword}`,
          pointer: `${rp}${e.instancePath}`,
        });
      }
      continue;
    }
    out[role as RoleKey] = JSON.parse(JSON.stringify(v)) as RoleFormat;
  }
  return { roleFormats: out, issues };
}

// ── Validasi aset ────────────────────────────────────────────────────────

/** Path aset relatif akar repo, garis miring `/`, tanpa `..` dan tanpa akar absolut. */
export function isSafeRelPath(p: string): boolean {
  if (p.length === 0 || p.length > 512) return false;
  if (p.includes("\\") || p.includes("\0") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Akar aset templat relatif akar repo (S87 L-06): path aset profil/versi hanya
 * boleh di bawah folder ini (bukan seluruh akar repo, mis. `.env`).
 */
export const TEMPLATE_ASSET_ROOT = "src/lib/studio/assets";

/** Ekstensi aset profil yang boleh diimpor (fon, raster, basis DOCX). */
export const TEMPLATE_ASSET_EXTENSIONS: readonly string[] = [".ttf", ".otf", ".woff", ".woff2", ".png", ".jpg", ".jpeg", ".docx"];

/** true bila path di bawah `TEMPLATE_ASSET_ROOT`, tanpa segmen tersembunyi (`.x`). */
export function isTemplateAssetPath(p: string): boolean {
  if (!isSafeRelPath(p) || !p.startsWith(`${TEMPLATE_ASSET_ROOT}/`)) return false;
  return p.split("/").every((seg) => !seg.startsWith("."));
}

/** `isTemplateAssetPath` + ekstensi dalam daftar tertutup (validasi masukan impor). */
export function isImportableAssetPath(p: string): boolean {
  if (!isTemplateAssetPath(p)) return false;
  const dot = p.lastIndexOf(".");
  return dot > p.lastIndexOf("/") && TEMPLATE_ASSET_EXTENSIONS.includes(p.slice(dot).toLowerCase());
}

export function validateAssets(raw: unknown, root = "/assets"): { assets: TemplateAssets; issues: ParamIssue[] } {
  const issues: ParamIssue[] = [];
  const assets: TemplateAssets = {};
  if (!isPlainObject(raw)) {
    issues.push({ key: "assets", code: "SCHEMA_INVALID", message: "assets harus objek id -> {sha256, path, kind}", pointer: root });
    return { assets, issues };
  }
  for (const id of Object.keys(raw).sort()) {
    const p = `${root}/${pointerSegment(id)}`;
    const a = raw[id];
    if (!isPlainObject(a)) {
      issues.push({ key: id, code: "SCHEMA_INVALID", message: `Aset ${id} harus objek`, pointer: p });
      continue;
    }
    const extra = Object.keys(a).filter((k) => !["sha256", "path", "kind"].includes(k));
    if (extra.length > 0) {
      issues.push({ key: id, code: "PARAM_UNKNOWN_KEY", message: `Medan aset tidak dikenal: ${extra.join(", ")}`, pointer: p });
      continue;
    }
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256)) {
      issues.push({ key: id, code: "SCHEMA_INVALID", message: `Aset ${id}: sha256 harus 64 hex huruf kecil`, pointer: `${p}/sha256` });
      continue;
    }
    if (typeof a.path !== "string" || !isImportableAssetPath(a.path)) {
      issues.push({
        key: id,
        code: "SCHEMA_INVALID",
        message: `Aset ${id}: path harus di bawah ${TEMPLATE_ASSET_ROOT}/ tanpa .. atau segmen tersembunyi, ekstensi ${TEMPLATE_ASSET_EXTENSIONS.join("/")}`,
        pointer: `${p}/path`,
      });
      continue;
    }
    if (typeof a.kind !== "string" || !(TEMPLATE_ASSET_KINDS as readonly string[]).includes(a.kind)) {
      issues.push({ key: id, code: "SCHEMA_INVALID", message: `Aset ${id}: kind harus font | raster | base`, pointer: `${p}/kind` });
      continue;
    }
    assets[id] = { sha256: a.sha256, path: a.path, kind: a.kind };
  }
  return { assets, issues };
}

// ── Override parameter ───────────────────────────────────────────────────

/**
 * Validasi struktur override (objek, kunci di registri, bukan kelas T) tanpa
 * memeriksa hak kelas K. Hak per pemanggil diperiksa terpisah
 * (`assertOverrideRights`, KT-16).
 */
export function validateOverrideKeys(raw: unknown, registry: readonly ParamDef[] = ALL_PARAMS): { overrides: ParamRecord; issues: ParamIssue[] } {
  if (!isPlainObject(raw)) {
    return { overrides: {}, issues: [{ key: "overrides", code: "SCHEMA_INVALID", message: "overrides harus objek kunci -> nilai", pointer: "/overrides" }] };
  }
  const overrides = raw as ParamRecord;
  // ADMIN_SESSION: hanya isu kunci asing dan kelas T yang tersisa.
  const issues = checkOverrides(overrides, "ADMIN_SESSION", registry);
  return { overrides, issues };
}

/**
 * Pisahkan override kelas T (dihitung ulang, tidak disimpan) dari profil
 * impor. Kunci asing tetap ditolak pemanggil.
 */
export function splitDerivedOverrides(
  overrides: ParamRecord,
  registry: readonly ParamDef[] = ALL_PARAMS,
): { kept: ParamRecord; dropped: string[] } {
  const byKey = new Map(registry.map((d) => [d.key, d]));
  const tierRaw = overrides["artifact.tier"];
  const tier = typeof tierRaw === "string" && (STUDIO_TIERS as readonly string[]).includes(tierRaw) ? (tierRaw as StudioTier) : undefined;
  const kept: ParamRecord = {};
  const dropped: string[] = [];
  for (const key of Object.keys(overrides).sort()) {
    const def = byKey.get(key);
    if (def && effectiveClass(def, overrides[key], tier) === "T") dropped.push(key);
    else kept[key] = overrides[key];
  }
  return { kept, dropped };
}

/**
 * Kunci yang BERUBAH dari override lama ke baru (tambah, ubah, hapus), dengan
 * nilai untuk evaluasi kelas bersyarat (nilai lama untuk kunci yang dihapus).
 * `artifact.tier` baru ikut disertakan agar kelas bersyarat tier terevaluasi.
 */
export function changedOverrides(prev: ParamRecord, next: ParamRecord): ParamRecord {
  const out: ParamRecord = {};
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const inPrev = Object.prototype.hasOwnProperty.call(prev, key);
    const inNext = Object.prototype.hasOwnProperty.call(next, key);
    if (inPrev && inNext && stableStringify(prev[key]) === stableStringify(next[key])) continue;
    out[key] = inNext ? next[key] : prev[key];
  }
  if (Object.keys(out).length > 0 && Object.prototype.hasOwnProperty.call(next, "artifact.tier")) {
    out["artifact.tier"] = next["artifact.tier"];
  }
  return out;
}

/** Gabungkan overrides rantai versi dasar (urutan akar -> induk) menjadi satu lapisan `base`. */
export function foldOverrides(chain: readonly ParamRecord[]): ParamRecord {
  const out: ParamRecord = {};
  for (const layer of chain) Object.assign(out, layer);
  return out;
}

// ── Komposisi versi ──────────────────────────────────────────────────────

export interface VersionPayload {
  overrides: ParamRecord;
  resolvedParams: ParamRecord;
  paramsSha256: string;
  roleFormats: RoleFormatMap;
  sectionPlan: SectionPlan;
  assets: TemplateAssets;
  /** Provenans + `meta` profil impor opsional (D-50; disimpan di JSON `provenance`). */
  provenance: TemplateProvenance & { meta?: Record<string, unknown> };
}

/**
 * Bangun isi versi templat: resolusi parameter (kelas T dihitung ulang),
 * roleFormats/sectionPlan efektif (lapisan milik ditimpakan per peran / per
 * tier di atas lapisan dasar), aset, provenans. Melempar StudioEngineError
 * bila ada isu (kunci asing 422, T 400, nilai tidak sah 400).
 */
export function composeVersion(i: {
  baseOverrides: ParamRecord;
  overrides: ParamRecord;
  baseRoleFormats: RoleFormatMap;
  roleFormats?: unknown;
  baseSectionPlan: SectionPlan;
  sectionPlan?: unknown;
  assets: TemplateAssets;
  provenance?: Partial<TemplateProvenance>;
  meta?: Record<string, unknown>;
  registry?: readonly ParamDef[];
}): VersionPayload {
  const registry = i.registry ?? ALL_PARAMS;
  const issues: ParamIssue[] = [];

  const ov = validateOverrideKeys(i.overrides, registry);
  issues.push(...ov.issues);

  let ownRoles: RoleFormatMap = {};
  if (i.roleFormats !== undefined) {
    const r = validateRoleFormats(i.roleFormats);
    issues.push(...r.issues);
    ownRoles = r.roleFormats;
  }
  let ownPlan: SectionPlan = {};
  if (i.sectionPlan !== undefined) {
    const s = validateSectionPlan(i.sectionPlan);
    issues.push(...s.issues);
    ownPlan = s.plan;
  }
  if (issues.length > 0) throwIssues(issues, "Templat tidak sah");

  const { params, errors } = resolveParams({ base: i.baseOverrides, overrides: ov.overrides, registry });
  if (errors.length > 0) throwIssues(errors, "Resolusi parameter gagal");

  const resolvedParams = { ...params } as ParamRecord;
  return {
    overrides: JSON.parse(JSON.stringify(ov.overrides)) as ParamRecord,
    resolvedParams,
    paramsSha256: sha256Hex(stableStringify(resolvedParams)),
    roleFormats: { ...i.baseRoleFormats, ...ownRoles },
    sectionPlan: { ...i.baseSectionPlan, ...ownPlan },
    assets: { ...i.assets },
    provenance: { ...defaultProvenance(), ...(i.provenance ?? {}), ...(i.meta ? { meta: i.meta } : {}) },
  };
}

/** Sidik konten versi untuk impor idempoten (parameter, peran, rencana, aset, dasar). */
export function versionContentDigest(p: Pick<VersionPayload, "paramsSha256" | "roleFormats" | "sectionPlan" | "assets">, baseVersionId: string | null): string {
  return sha256Hex(
    stableStringify({ p: p.paramsSha256, r: p.roleFormats, s: p.sectionPlan, a: p.assets, b: baseVersionId }),
  );
}

/** Payload profil DATUM-kanonik (tanpa override). */
export function canonicalVersionPayload(assets: TemplateAssets = {}): VersionPayload {
  return composeVersion({
    baseOverrides: {},
    overrides: {},
    baseRoleFormats: {},
    baseSectionPlan: canonicalSectionPlan(),
    assets,
  });
}

// ── Berkas profil (impor; dipakai CLI benchmark S67/S97) ─────────────────

/** Bentuk berkas profil: `{ base: "datum-kanonik", overrides, roleFormats, sectionPlan }` (H01) + medan identitas opsional. */
export interface TemplateProfileFile {
  base: string;
  slug?: string;
  name?: string;
  description?: string;
  kind: StudioTemplateKind;
  overrides: ParamRecord;
  roleFormats?: RoleFormatMap;
  sectionPlan?: SectionPlan;
  assets?: TemplateAssets;
  provenance?: Partial<TemplateProvenance>;
  changeNote?: string;
  /**
   * Metadata profil (D-50; mis. `meta.gaps`, `meta.decisions`). Model M02 tidak
   * punya kolom meta: disimpan di JSON `provenance.meta` versi.
   */
  meta?: Record<string, unknown>;
  /**
   * SR-07: kerangka slot (`studio.skeleton/v1` tanpa `$schema`; bentuk `TemplateSlotDef`).
   * Bentuk dan aturan diperiksa layanan v2 (`v2.ts`) saat impor; di sini hanya objek `{ slots }`.
   */
  skeleton?: { slots: unknown[] };
  /** SR-07: templat baru diimpor sebagai preset gaya (`isPreset`, hanya ADMIN). */
  isPreset?: boolean;
}

export interface ParsedTemplateProfile {
  profile: TemplateProfileFile;
  /** Override kelas T yang dibuang (dihitung ulang mesin). */
  droppedDerived: string[];
  /** Medan tingkat atas yang tidak dipakai layanan (mis. `gaps`, `notes`). */
  ignoredFields: string[];
}

const PROFILE_FIELDS = ["$schema", "base", "meta", "slug", "name", "description", "kind", "overrides", "roleFormats", "sectionPlan", "assets", "provenance", "changeNote", "skeleton", "isPreset"];
const PROVENANCE_FIELDS = ["tokensVersion", "manualRevision", "skillVersion", "catalogRef"];

/**
 * Parse dan validasi isi berkas profil. Medan tingkat atas tak dikenal
 * DIABAIKAN dan dilaporkan (D-50); `meta.slug`/`meta.name`/`meta.kind`/
 * `meta.description` menjadi cadangan identitas bila medan tingkat atas tidak
 * ada; `meta` utuh disimpan. Kunci asing di dalam `overrides`, `roleFormats`,
 * `sectionPlan` (parameter, peran, section, tier) DITOLAK (0 kunci asing).
 * Override kelas T dibuang dan dilaporkan bila `dropDerived` (default true),
 * selain itu ditolak 400. `sectionPlan` kosong = rencana dasar (registri).
 */
export function parseTemplateProfile(raw: unknown, opts: { dropDerived?: boolean } = {}): ParsedTemplateProfile {
  const issues: ParamIssue[] = [];
  if (!isPlainObject(raw)) {
    throwIssues([{ key: "profile", code: "SCHEMA_INVALID", message: "Berkas profil harus objek JSON", pointer: "" }]);
  }
  const ignoredFields = Object.keys(raw).filter((k) => !PROFILE_FIELDS.includes(k)).sort();
  let meta: Record<string, unknown> | undefined;
  if (raw.meta !== undefined) {
    if (isPlainObject(raw.meta)) meta = JSON.parse(JSON.stringify(raw.meta)) as Record<string, unknown>;
    else issues.push({ key: "meta", code: "SCHEMA_INVALID", message: "meta harus objek", pointer: "/meta" });
  }
  const pick = (f: "slug" | "name" | "kind" | "description"): unknown => (raw[f] !== undefined ? raw[f] : meta?.[f]);

  const base = raw.base === undefined ? DATUM_CANONICAL_SLUG : raw.base;
  if (typeof base !== "string" || !TEMPLATE_SLUG_RE.test(base) || base.length > TEMPLATE_SLUG_MAX) {
    issues.push({ key: "base", code: "SCHEMA_INVALID", message: "base harus slug templat", pointer: "/base" });
  }
  for (const f of ["slug"] as const) {
    const v = pick(f);
    if (v !== undefined && (typeof v !== "string" || !TEMPLATE_SLUG_RE.test(v) || v.length > TEMPLATE_SLUG_MAX)) {
      issues.push({ key: f, code: "SCHEMA_INVALID", message: `${f} harus slug ^[a-z0-9]+(-[a-z0-9]+)*$ maks ${TEMPLATE_SLUG_MAX}`, pointer: `/${f}` });
    }
  }
  for (const f of ["name", "description"] as const) {
    const v = pick(f);
    if (v !== undefined && typeof v !== "string") issues.push({ key: f, code: "SCHEMA_INVALID", message: `${f} harus string`, pointer: `/${f}` });
  }
  for (const f of ["changeNote"] as const) {
    const v = raw[f];
    if (v !== undefined && typeof v !== "string") issues.push({ key: f, code: "SCHEMA_INVALID", message: `${f} harus string`, pointer: `/${f}` });
  }
  const kind = pick("kind") === undefined ? "DOCUMENT" : pick("kind");
  if (typeof kind !== "string" || !(STUDIO_TEMPLATE_KINDS as readonly string[]).includes(kind)) {
    issues.push({ key: "kind", code: "SCHEMA_INVALID", message: `kind harus salah satu dari ${STUDIO_TEMPLATE_KINDS.join(", ")}`, pointer: "/kind" });
  }

  let overrides: ParamRecord = {};
  let droppedDerived: string[] = [];
  if (!isPlainObject(raw.overrides)) {
    issues.push({ key: "overrides", code: "SCHEMA_INVALID", message: "overrides wajib objek kunci -> nilai", pointer: "/overrides" });
  } else {
    const all = raw.overrides as ParamRecord;
    const split = opts.dropDerived === false ? { kept: all, dropped: [] } : splitDerivedOverrides(all);
    overrides = split.kept;
    droppedDerived = split.dropped;
    issues.push(...validateOverrideKeys(overrides).issues);
  }

  let roleFormats: RoleFormatMap | undefined;
  if (raw.roleFormats !== undefined) {
    const r = validateRoleFormats(raw.roleFormats);
    issues.push(...r.issues);
    roleFormats = r.roleFormats;
  }
  let sectionPlan: SectionPlan | undefined;
  if (raw.sectionPlan !== undefined) {
    const s = validateSectionPlan(raw.sectionPlan);
    issues.push(...s.issues);
    sectionPlan = s.plan;
  }
  let assets: TemplateAssets | undefined;
  if (raw.assets !== undefined) {
    const a = validateAssets(raw.assets);
    issues.push(...a.issues);
    assets = a.assets;
  }
  let provenance: Partial<TemplateProvenance> | undefined;
  if (raw.provenance !== undefined) {
    if (!isPlainObject(raw.provenance)) {
      issues.push({ key: "provenance", code: "SCHEMA_INVALID", message: "provenance harus objek", pointer: "/provenance" });
    } else {
      provenance = {};
      for (const [k, v] of Object.entries(raw.provenance)) {
        if (!PROVENANCE_FIELDS.includes(k)) {
          issues.push({ key: k, code: "PARAM_UNKNOWN_KEY", message: `Medan provenance tidak dikenal: ${k}`, pointer: `/provenance/${pointerSegment(k)}` });
        } else if (typeof v !== "string") {
          issues.push({ key: k, code: "SCHEMA_INVALID", message: `provenance.${k} harus string`, pointer: `/provenance/${pointerSegment(k)}` });
        } else {
          (provenance as Record<string, string>)[k] = v;
        }
      }
    }
  }
  // SR-07: kerangka dan penanda preset (aturan kerangka penuh di v2.ts saat impor).
  let skeleton: { slots: unknown[] } | undefined;
  if (raw.skeleton !== undefined) {
    if (!isPlainObject(raw.skeleton) || !Array.isArray(raw.skeleton.slots) || Object.keys(raw.skeleton).some((k) => k !== "slots" && k !== "$schema")) {
      issues.push({ key: "skeleton", code: "SCHEMA_INVALID", message: "skeleton harus objek { slots: TemplateSlotDef[] }", pointer: "/skeleton" });
    } else {
      skeleton = { slots: JSON.parse(JSON.stringify(raw.skeleton.slots)) as unknown[] };
    }
  }
  if (raw.isPreset !== undefined && typeof raw.isPreset !== "boolean") {
    issues.push({ key: "isPreset", code: "SCHEMA_INVALID", message: "isPreset harus boolean", pointer: "/isPreset" });
  }
  if (issues.length > 0) throwIssues(issues, "Profil templat tidak sah");

  return {
    profile: {
      base: base as string,
      slug: pick("slug") as string | undefined,
      name: pick("name") as string | undefined,
      description: pick("description") as string | undefined,
      kind: kind as StudioTemplateKind,
      overrides,
      roleFormats,
      sectionPlan,
      assets,
      provenance,
      changeNote: raw.changeNote as string | undefined,
      meta,
      ...(skeleton ? { skeleton } : {}),
      ...(raw.isPreset === true ? { isPreset: true } : {}),
    },
    droppedDerived,
    ignoredFields,
  };
}

/**
 * Resolusi profil di memori tanpa DB (CLI benchmark): dasar HARUS profil
 * DATUM-kanonik. `templateId`/`versionId` sintetis berawalan `file:`.
 */
export function resolveProfileInMemory(
  profile: TemplateProfileFile,
  opts: { canonicalAssets?: TemplateAssets; resolveAssetPath?: (relPath: string) => string } = {},
): ResolvedTemplate {
  if (profile.base !== DATUM_CANONICAL_SLUG) {
    throw new StudioEngineError(
      "TEMPLATE_NOT_FOUND",
      `Resolusi tanpa DB hanya mendukung base "${DATUM_CANONICAL_SLUG}" (diminta "${profile.base}")`,
    );
  }
  const p = composeVersion({
    baseOverrides: {},
    overrides: profile.overrides,
    baseRoleFormats: {},
    roleFormats: profile.roleFormats,
    baseSectionPlan: canonicalSectionPlan(),
    sectionPlan: profile.sectionPlan,
    assets: { ...(opts.canonicalAssets ?? {}), ...(profile.assets ?? {}) },
    provenance: profile.provenance,
    meta: profile.meta,
  });
  // Swarm patch (row 107, row 11 M3): no unconfined default resolver (`rel => rel`); templates are
  // untrusted input (U10), so a caller must pass a confined resolver such as resolveRepoAssetPath.
  const resolvePath = opts.resolveAssetPath;
  if (!resolvePath) throw new StudioEngineError("PATH_OUTSIDE_ROOT", "resolveProfileInMemory requires resolveAssetPath (no unconfined default)");
  return toResolvedTemplate({
    templateId: `file:${profile.slug ?? MANUAL000_SLUG}`,
    versionId: `file:${p.paramsSha256.slice(0, 16)}`,
    versionNo: 0,
    resolvedParams: p.resolvedParams,
    roleFormats: p.roleFormats,
    sectionPlan: p.sectionPlan,
    assets: p.assets,
    resolveAssetPath: resolvePath,
  });
}

/** Bentuk `ResolvedTemplate` beku dari isi versi tersimpan. */
export function toResolvedTemplate(i: {
  templateId: string;
  versionId: string;
  versionNo: number;
  resolvedParams: ParamRecord;
  roleFormats: RoleFormatMap;
  sectionPlan: SectionPlan;
  assets: TemplateAssets;
  resolveAssetPath: (relPath: string) => string;
}): ResolvedTemplate {
  const assets: Record<string, { sha256: string; absPath: string; kind: "font" | "raster" | "base" }> = {};
  for (const [id, a] of Object.entries(i.assets)) {
    const kind = (TEMPLATE_ASSET_KINDS as readonly string[]).includes(a.kind) ? (a.kind as "font" | "raster" | "base") : "raster";
    assets[id] = { sha256: a.sha256, absPath: i.resolveAssetPath(a.path), kind };
  }
  return Object.freeze({
    templateId: i.templateId,
    versionId: i.versionId,
    versionNo: i.versionNo,
    params: Object.freeze({ ...i.resolvedParams }) as ParamMap,
    roleFormats: Object.freeze({ ...i.roleFormats }),
    sectionPlan: Object.freeze({ ...i.sectionPlan }),
    assets: Object.freeze(assets),
  });
}
