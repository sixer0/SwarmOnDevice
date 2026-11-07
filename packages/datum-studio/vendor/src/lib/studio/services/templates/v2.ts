/**
 * Templat `studio.template/v2` (baris SR-07; register 03_structural_sections_specs.md
 * §4.7, §11.2, §13.5; blueprint §2.3; D-134, D-163 T-1/T-2, D-170, D-171, D-182).
 *
 * Aturan kerangka, sidik (`configSha256`/`skeletonSha256`), tulis/baca M10-M12 dan
 * izin per kunci (`checkTemplateWrite`) milik layanan kerangka SR-06
 * (`services/skeleton`) dan DIPAKAI, tidak diduplikasi. Modul ini hanya menambah yang
 * khas templat v2:
 * - Validasi bentuk SID04 (ajv) dan kunci ganda `essentials`/`advanced` tingkat templat.
 * - Cek struktural kunci lapis TEMPLAT (asing 422, kelas T 400, nilai 400).
 * - Perubahan per kunci relatif nilai EFEKTIF sebelumnya (`diffEffective`): override
 *   yang sama dengan nilai warisan preset bukan perubahan (UI mengisi kenop dengan
 *   nilai preset), dipetakan ke `ParamChange` SR-06.
 * - Hak per kunci (termasuk D-182: turunan di luar ADMIN-pada-preset = 400) = SR-06
 *   `checkTemplateWrite`; di sini hanya bidang non-parameter khusus ADMIN (roleFormats).
 * - Non-ADMIN tidak melihat lapis lanjutan: kunci tersembunyi dibawa, kunci bermedan
 *   esensial digabung (`carryHiddenForNonAdmin`); override lama yang kini asing/kelas T
 *   dilewati + dicatat (`sanitizeStoredLayer`).
 *
 * Modul murni: tanpa I/O.
 */
import type { ParamIssue, ParamSurface, ParamValue, StudioCaller, StudioTemplateV2, ValidationIssue } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { TEMPLATE_V2_SCHEMA_ID } from "../../contract/schema/v2/template.schema";
import { effectiveClass, validateParamValue } from "../../engine/tokens/merge";
import { studioValidator } from "../ingest/validate";
import { PARAMS_BY_KEY } from "../../params";
import { ESSENTIAL_FIELD_PATHS } from "../../registry/essentials";
import { type ParamChange, partitionBySurface } from "../skeleton/pure";
import { isPlainObject, type ParamRecord, stableStringify } from "./profile";

export const TEMPLATE_V2_SCHEMA = "studio.template/v2" as const;

function seg(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// ── Bentuk (ajv SID04) ───────────────────────────────────────────────────

type AjvValidator = ((v: unknown) => boolean) & {
  errors?: Array<{ instancePath: string; message?: string; keyword: string; params?: Record<string, unknown> }> | null;
};
/** SR-55 M8: validator dari instans Ajv Studio bersama (satu per proses, ter-cache di `studioValidator`). */
function getTemplateValidator(): AjvValidator {
  return studioValidator(TEMPLATE_V2_SCHEMA_ID) as unknown as AjvValidator;
}

/** 400 SCHEMA_INVALID dengan `details.issues` (ValidationIssue). */
export function throwSchemaIssues(issues: readonly ValidationIssue[], prefix: string): never {
  const more = issues.length > 1 ? ` (+${issues.length - 1} isu lain)` : "";
  throw new StudioEngineError("SCHEMA_INVALID", `${prefix}: ${issues[0].message}${more}`, { issues });
}

/** Validasi bentuk `studio.template/v2` (SID04) + kunci ganda lapis templat; kembalikan salinan dalam. */
export function parseTemplateV2(raw: unknown, root = "/template"): StudioTemplateV2 {
  const v = getTemplateValidator();
  if (!v(raw)) {
    throwSchemaIssues(
      (v.errors ?? []).map((e) => ({
        pointer: `${root}${e.instancePath}`,
        keyword: e.keyword,
        message: `${e.message ?? e.keyword}${e.keyword === "additionalProperties" && e.params?.additionalProperty ? `: ${String(e.params.additionalProperty)}` : ""}`,
      })),
      "Templat studio.template/v2 tidak sah",
    );
  }
  const tpl = clone(raw as StudioTemplateV2);
  const dup = Object.keys(tpl.advanced ?? {}).filter((k) => has(tpl.essentials, k));
  if (dup.length > 0) {
    throwSchemaIssues(
      dup.map((k) => ({ pointer: `${root}/advanced/${seg(k)}`, keyword: "duplicateKey", message: `kunci ${k} ada di essentials dan advanced` })),
      "Templat tidak sah",
    );
  }
  return tpl;
}

// ── Lapis templat ────────────────────────────────────────────────────────

/** Lapis datar templat = esensial ∪ lanjutan (KD-21; penyimpanan `overrides` datar, D-62). */
export function templateLayerOf(t: Pick<StudioTemplateV2, "essentials" | "advanced">): ParamRecord {
  return { ...clone(t.essentials), ...clone(t.advanced ?? {}) } as ParamRecord;
}

function tierOf(layer: ParamRecord): Parameters<typeof effectiveClass>[2] {
  const t = layer["artifact.tier"];
  return typeof t === "string" ? (t as Parameters<typeof effectiveClass>[2]) : undefined;
}

/**
 * Cek struktural kunci lapis templat, urutan §13.5: asing (422) -> kelas T (400,
 * termasuk `slot.setup.pageSizeTw`) -> nilai tidak sah (400).
 */
export function assertTemplateLayerKeys(layer: ParamRecord, root = "/template/essentials"): void {
  const unknown: ParamIssue[] = [];
  const derived: ParamIssue[] = [];
  const invalid: ParamIssue[] = [];
  const tier = tierOf(layer);
  for (const key of Object.keys(layer).sort()) {
    const pointer = `${root}/${seg(key)}`;
    const def = PARAMS_BY_KEY.get(key);
    if (!def) {
      unknown.push({ key, code: "PARAM_UNKNOWN_KEY", message: `Parameter tidak dikenal: ${key}`, pointer });
      continue;
    }
    const v = layer[key];
    if (effectiveClass(def, v, tier) === "T") {
      derived.push({ key, code: "PARAM_CLASS_T_READONLY", message: `Parameter ${key} dihitung mesin dan tidak dapat ditimpa`, pointer });
      continue;
    }
    if (key === "slot.setup" && isPlainObject(v) && has(v, "pageSizeTw")) {
      derived.push({ key, code: "PARAM_CLASS_T_READONLY", message: "slot.setup.pageSizeTw diturunkan dari ukuran kertas dan tidak dapat ditimpa", pointer: `${pointer}/pageSizeTw` });
      continue;
    }
    const bad = validateParamValue(def, v);
    if (bad) invalid.push({ key, code: "SCHEMA_INVALID", message: `Nilai ${key} tidak sah: ${bad}`, pointer });
  }
  for (const [code, list] of [
    ["PARAM_UNKNOWN_KEY", unknown],
    ["PARAM_CLASS_T_READONLY", derived],
    ["SCHEMA_INVALID", invalid],
  ] as const) {
    if (list.length > 0) {
      throw new StudioEngineError(code, `Templat tidak sah: ${list[0].message}${list.length > 1 ? ` (+${list.length - 1} isu lain)` : ""}`, { issues: list });
    }
  }
}

/**
 * Override tersimpan versi lama yang kini asing atau kelas T (mis. override v1
 * `page.sizeMm` sebelum SR-05) tidak dibawa ke versi baru dan tidak dihitung sebagai
 * perubahan; dikembalikan agar pemanggil mencatatnya (migrasi = SR-36).
 */
export function sanitizeStoredLayer(layer: ParamRecord): { kept: ParamRecord; skipped: string[] } {
  const kept: ParamRecord = {};
  const skipped: string[] = [];
  const tier = tierOf(layer);
  for (const key of Object.keys(layer).sort()) {
    const def = PARAMS_BY_KEY.get(key);
    if (!def || effectiveClass(def, layer[key], tier) === "T") skipped.push(key);
    else kept[key] = layer[key];
  }
  return { kept, skipped };
}

/**
 * Pemanggil non-ADMIN tidak melihat lapis lanjutan (GET hanya preset + esensial,
 * D-163 T-1): kunci non-esensial yang ada di lapis lama dan tidak dikirim DIBAWA;
 * kunci bermedan esensial (`ESSENTIAL_FIELD_PATHS`, mis. `slot.setup`) digabung
 * `{...nilaiSebelum, ...kiriman}` agar kiriman proyeksi esensial sah. Perubahan medan
 * lain tetap tertangkap `checkTemplateWrite` (403 PARAM_SURFACE_FORBIDDEN).
 */
export function carryHiddenForNonAdmin(prev: ParamRecord, next: ParamRecord, inherited: Readonly<Record<string, ParamValue>>): ParamRecord {
  const out: ParamRecord = { ...next };
  for (const key of Object.keys(prev)) {
    if (!has(next, key) && PARAMS_BY_KEY.get(key)?.surface !== "essential") out[key] = clone(prev[key]);
  }
  for (const key of Object.keys(out)) {
    if (!ESSENTIAL_FIELD_PATHS.has(key)) continue;
    const before = has(prev, key) ? prev[key] : inherited[key];
    if (isPlainObject(before) && isPlainObject(out[key])) out[key] = { ...clone(before as ParamRecord), ...(out[key] as ParamRecord) };
  }
  return out;
}

/**
 * Kunci yang BERUBAH nilai efektifnya (D-134) sebagai `ParamChange` SR-06: sebelum =
 * lapis lama atau nilai warisan; sesudah = lapis baru atau nilai warisan. Override yang
 * sama dengan nilai warisan bukan perubahan.
 */
export function diffEffective(
  prev: ParamRecord,
  next: ParamRecord,
  inherited: Readonly<Record<string, ParamValue>>,
  slot?: ParamChange["slot"],
): ParamChange[] {
  const out: ParamChange[] = [];
  for (const key of [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort()) {
    const previous = has(prev, key) ? prev[key] : inherited[key];
    const value = has(next, key) ? next[key] : inherited[key];
    if (stableStringify(previous ?? null) === stableStringify(value ?? null)) continue;
    out.push(slot ? { key, value, previous, slot } : { key, value, previous });
  }
  return out;
}

/** 403 PARAM_SURFACE_FORBIDDEN untuk perubahan non-parameter yang hanya ADMIN (roleFormats). */
export function assertAdminOnlyFields(caller: Pick<StudioCaller, "kind">, fields: readonly string[]): void {
  if (caller.kind === "ADMIN_SESSION" || fields.length === 0) return;
  throw new StudioEngineError("PARAM_SURFACE_FORBIDDEN", `Pengaturan ini hanya dapat diubah peran ADMINISTRATOR: ${fields[0]}${fields.length > 1 ? ` (+${fields.length - 1} lain)` : ""}`, {
    keys: [...fields],
    surface: "advanced",
  });
}

/** roleFormats milik lapis = entri yang berbeda dari roleFormats dasar. */
export function ownRoleFormats(stored: Record<string, unknown> | null | undefined, base: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [role, f] of Object.entries(stored ?? {})) {
    if (stableStringify(f ?? null) !== stableStringify(base?.[role] ?? null)) out[role] = clone(f);
  }
  return out;
}

// ── Tampilan v2 (R02 GET) ────────────────────────────────────────────────

/** Lapis registri satu kunci (undefined = kunci tak dikenal). */
export function surfaceOfKey(key: string): ParamSurface | undefined {
  return PARAMS_BY_KEY.get(key)?.surface;
}

/** Pisahkan lapis datar ke `essentials`/`advanced` menurut lapis simpan SR-06 (`partitionBySurface`). */
export function splitBySurface(layer: ParamRecord): { essentials: ParamRecord; advanced: ParamRecord } {
  return partitionBySurface(layer);
}

/** Proyeksi nilai kunci ke medan yang dibuka kenop esensial (`ESSENTIAL_FIELD_PATHS`); null bila tidak ada. */
export function essentialProjection(key: string, value: ParamValue | undefined): ParamRecord | null {
  const fields = ESSENTIAL_FIELD_PATHS.get(key);
  if (!fields || !isPlainObject(value)) return null;
  const out: ParamRecord = {};
  for (const f of fields) if (has(value, f)) out[f] = clone((value as ParamRecord)[f]);
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Lapis datar -> `essentials` (+ proyeksi medan esensial bila lanjutan disembunyikan) dan
 * `advanced` (hanya bila `includeAdvanced`). Partisi = lapis simpan SR-06.
 */
export function layerToSurfaces(layer: ParamRecord, includeAdvanced: boolean): { essentials: ParamRecord; advanced?: ParamRecord } {
  const { essentials, advanced } = partitionBySurface(layer);
  if (includeAdvanced) return Object.keys(advanced).length > 0 ? { essentials, advanced } : { essentials };
  for (const key of Object.keys(advanced)) {
    const proj = essentialProjection(key, advanced[key]);
    if (proj) essentials[key] = proj;
  }
  return { essentials };
}
