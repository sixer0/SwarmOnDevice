/**
 * Izin tulis parameter templat dan slot kerangka (SR-06; register
 * 03_structural_sections_specs §13.5, D-134, D-163 T-1, D-170, D-171).
 *
 * Urutan cek per kunci yang BERUBAH (D-134):
 *  1. templat `isPreset` dan pemanggil bukan ADMIN -> 403 PRESET_READONLY
 *  2. templat terbatas (D-98) dan pemanggil bukan ADMIN -> 403 FORBIDDEN
 *  3. kunci tidak ada di registri -> 422 PARAM_UNKNOWN_KEY
 *  4. kelas T (termasuk `slot.setup.pageSizeTw`, R-41) dan kunci lapis turunan
 *     kecuali ADMIN pada templat `isPreset` (sematan; D-165 KT-4, putusan
 *     controller SR-06) -> 400 PARAM_CLASS_T_READONLY
 *  5. kunci slot di luar cakupan slot -> 422 SLOT_PARAM_SCOPE_INVALID
 *  6. kelas K dan pemanggil bukan ADMIN -> 403 PARAM_CLASS_K_FORBIDDEN
 *  7. lapis: advanced/internal hanya ADMIN -> 403 PARAM_SURFACE_FORBIDDEN
 *
 * Aturan PER KENOP (D-170/D-171): tulis lewat kenop esensial bertipe `medan`
 * (`isEssentialFieldPath`, mis. `slot.setup.startOnNewPage`) diizinkan bagi
 * USER walau lapis kunci induk `advanced`; medan lain kunci itu tetap mengikuti
 * lapis kuncinya (403 PARAM_SURFACE_FORBIDDEN).
 *
 * `expertMode` (register §13.5) TIDAK membuka lapis lanjutan bagi USER di v2.1
 * (D-163 T-1: lanjutan HANYA ADMIN); medan diterima agar kontrak R01/R02/R19
 * tetap sama dan dicatat di details.
 *
 * Modul murni: tanpa I/O.
 */
import type { CallerKind, ParamValue, StudioCaller, StudioTier } from "../../contract";
import { STUDIO_TIERS } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import { effectiveClass, validateParamValue } from "../../engine/tokens/merge";
import { PARAMS_BY_KEY, type ScopedParamDef } from "../../params";
import { isEssentialFieldPath, ESSENTIAL_FIELD_PATHS } from "../../registry/essentials";
import { isScopeAllowedInSlot } from "../../registry/slots";
import { stableStringify } from "../ingest/util";

/** Kunci objek pengaturan seksi slot (R-41) dan medannya yang kelas T. */
export const SLOT_SETUP_KEY = "slot.setup";
export const SLOT_SETUP_T_FIELDS: readonly string[] = ["pageSizeTw"];

/** Lapis yang disimpan di M11 (`surface`). */
export type StoredSurface = "essential" | "advanced";

/** Satu perubahan kunci parameter (global templat bila `slot` absen). */
export interface ParamChange {
  key: string;
  /** Nilai baru; `undefined` = kunci dihapus. */
  value: ParamValue | undefined;
  /** Nilai lama; `undefined` = kunci baru. */
  previous: ParamValue | undefined;
  /** Slot pemilik kunci (M11); absen = parameter tingkat templat. */
  slot?: { slotKey: string; sectionType: string; admits: readonly string[] };
}

export interface TemplateWriteTarget {
  isPreset: boolean;
  /** Templat terbatas D-98 (`templateRestriction(resolvedParams).restricted`). */
  restricted: boolean;
  slug?: string;
}

export interface TemplateWriteOptions {
  /** Tanda kesadaran pengguna (register §13.5); tidak membuka lanjutan bagi USER di v2.1 (D-163 T-1). */
  expertMode?: boolean;
  /** Tier dokumen untuk kelas bersyarat (`classNote`). */
  tier?: StudioTier;
}

function isRecord(v: unknown): v is Record<string, ParamValue> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isAdmin(kind: CallerKind | undefined): boolean {
  return kind === "ADMIN_SESSION";
}

function same(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return stableStringify(a) === stableStringify(b);
}

/** Medan objek yang berubah (tambah, ubah, hapus) antara dua nilai kunci objek. */
export function changedFields(prev: ParamValue | undefined, next: ParamValue | undefined): string[] | null {
  const p = prev === undefined ? {} : prev;
  const n = next === undefined ? {} : next;
  if (!isRecord(p) || !isRecord(n)) return null;
  const out: string[] = [];
  for (const f of new Set([...Object.keys(p), ...Object.keys(n)])) {
    if (!same(p[f], n[f])) out.push(f);
  }
  return out.sort();
}

/**
 * true bila perubahan hanya menyentuh medan yang dibuka kenop esensial bertipe
 * `medan` (D-170/D-171; `isEssentialFieldPath` dari `registry/essentials.ts`).
 */
export function isEssentialFieldChange(key: string, prev: ParamValue | undefined, next: ParamValue | undefined): boolean {
  if (!ESSENTIAL_FIELD_PATHS.has(key)) return false;
  const fields = changedFields(prev, next);
  return fields !== null && fields.length > 0 && fields.every((f) => isEssentialFieldPath(key, f));
}

/**
 * Lapis simpan M11 satu nilai: `essential` bila lapis registri essential, atau
 * bila nilainya objek yang hanya memuat medan kenop esensial `medan`; selain itu
 * `advanced` (lanjutan, turunan sematan, internal).
 */
export function storedSurfaceOf(key: string, value: ParamValue): StoredSurface {
  const def = PARAMS_BY_KEY.get(key);
  if (def?.surface === "essential") return "essential";
  if (ESSENTIAL_FIELD_PATHS.has(key) && isRecord(value)) {
    const fields = Object.keys(value);
    if (fields.length > 0 && fields.every((f) => isEssentialFieldPath(key, f))) return "essential";
  }
  return "advanced";
}

/** Diff dua peta parameter: kunci tambah/ubah/hapus (D-134), urut kunci. */
export function diffParamMaps(
  prev: Readonly<Record<string, ParamValue>>,
  next: Readonly<Record<string, ParamValue>>,
  slot?: ParamChange["slot"],
): ParamChange[] {
  const out: ParamChange[] = [];
  for (const key of [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort()) {
    const has = (o: object) => Object.prototype.hasOwnProperty.call(o, key);
    const pv = has(prev) ? prev[key] : undefined;
    const nv = has(next) ? next[key] : undefined;
    if (same(pv, nv)) continue;
    out.push(slot ? { key, value: nv, previous: pv, slot } : { key, value: nv, previous: pv });
  }
  return out;
}

interface Failure {
  change: ParamChange;
  message: string;
  details?: Record<string, unknown>;
}

function where(c: ParamChange): string {
  return c.slot ? `slot ${c.slot.slotKey}: ${c.key}` : c.key;
}

function tierFrom(v: ParamValue | undefined): StudioTier | undefined {
  return typeof v === "string" && (STUDIO_TIERS as readonly string[]).includes(v) ? (v as StudioTier) : undefined;
}

function classT(def: ScopedParamDef, c: ParamChange, tier: StudioTier | undefined): boolean {
  const v = c.value !== undefined ? c.value : c.previous;
  return v !== undefined && effectiveClass(def, v, tier) === "T";
}

function classK(def: ScopedParamDef, c: ParamChange, tier: StudioTier | undefined): boolean {
  const v = c.value !== undefined ? c.value : c.previous;
  return v !== undefined && effectiveClass(def, v, tier) === "K";
}

/** Medan kelas T di dalam `slot.setup` yang berubah (R-41: `pageSizeTw` = 400, pointer `/pageSizeTw`). */
function setupTFields(c: ParamChange): string[] {
  if (c.key !== SLOT_SETUP_KEY) return [];
  const fields = changedFields(c.previous, c.value) ?? [];
  return fields.filter((f) => SLOT_SETUP_T_FIELDS.includes(f));
}

function throwFailures(code: Parameters<typeof codeMessage>[0], failures: Failure[], extra: Record<string, unknown> = {}): never {
  const first = failures[0];
  const more = failures.length > 1 ? ` (+${failures.length - 1} kunci lain)` : "";
  throw new StudioEngineError(code, `${codeMessage(code)}: ${first.message}${more}`, {
    keys: failures.map((f) => f.change.key),
    ...(failures[0].change.slot ? { slotKey: failures[0].change.slot.slotKey } : {}),
    failures: failures.map((f) => ({ key: f.change.key, slotKey: f.change.slot?.slotKey ?? null, message: f.message, ...(f.details ?? {}) })),
    ...extra,
  });
}

function codeMessage(
  code: "PARAM_UNKNOWN_KEY" | "PARAM_CLASS_T_READONLY" | "SLOT_PARAM_SCOPE_INVALID" | "PARAM_CLASS_K_FORBIDDEN" | "PARAM_SURFACE_FORBIDDEN",
): string {
  switch (code) {
    case "PARAM_UNKNOWN_KEY":
      return "Parameter tidak dikenal";
    case "PARAM_CLASS_T_READONLY":
      return "Parameter dihitung mesin dan tidak dapat ditimpa";
    case "SLOT_PARAM_SCOPE_INVALID":
      return "Parameter tidak berlaku untuk slot ini";
    case "PARAM_CLASS_K_FORBIDDEN":
      return "Parameter kelas K hanya dapat diubah peran ADMINISTRATOR";
    case "PARAM_SURFACE_FORBIDDEN":
      return "Pengaturan ini hanya dapat diubah peran ADMINISTRATOR";
  }
}

/**
 * Tegakkan izin tulis templat/kerangka atas kunci yang BERUBAH (register §13.5,
 * urutan 1-7). Melempar `StudioEngineError` dengan semua kunci yang gagal pada
 * tahap pertama yang gagal (`details.keys`, `details.failures`).
 */
export function checkTemplateWrite(
  caller: Pick<StudioCaller, "kind"> | null | undefined,
  tpl: TemplateWriteTarget,
  changes: readonly ParamChange[],
  opts: TemplateWriteOptions = {},
): void {
  const admin = isAdmin(caller?.kind);
  // 1-2: penolakan berbasis peran untuk seluruh penulisan (termasuk perubahan kerangka tanpa parameter).
  if (tpl.isPreset && !admin) {
    throw new StudioEngineError("PRESET_READONLY", "Preset gaya hanya dapat diubah peran ADMINISTRATOR; pilih preset lalu atur kenop di templat Anda", {
      ...(tpl.slug ? { templateSlug: tpl.slug } : {}),
    });
  }
  if (tpl.restricted && !admin) {
    throw new StudioEngineError("FORBIDDEN", "Templat terbatas hanya dapat diubah peran ADMINISTRATOR (D-98)", {
      reason: "TEMPLATE_RESTRICTED",
      ...(tpl.slug ? { templateSlug: tpl.slug } : {}),
    });
  }
  if (changes.length === 0) return;

  const tierChange = changes.find((c) => c.key === "artifact.tier" && !c.slot);
  const tier = opts.tier ?? tierFrom(tierChange?.value);

  // 3: kunci tak dikenal.
  const unknown = changes.filter((c) => !PARAMS_BY_KEY.has(c.key));
  if (unknown.length > 0) {
    throwFailures("PARAM_UNKNOWN_KEY", unknown.map((c) => ({ change: c, message: where(c) })));
  }
  const defOf = (c: ParamChange) => PARAMS_BY_KEY.get(c.key) as ScopedParamDef;

  // 4: kelas T, medan T di dalam slot.setup, dan kunci lapis turunan (D-165 KT-4: turunan
  // beracuan hanya dapat DISEMATKAN ADMIN pada preset; selain itu 400, bukan 403).
  const tFail: Failure[] = [];
  for (const c of changes) {
    if (classT(defOf(c), c, tier)) tFail.push({ change: c, message: where(c) });
    else if (defOf(c).surface === "derived" && !(admin && tpl.isPreset)) {
      tFail.push({ change: c, message: `${where(c)} (turunan; hanya dapat disematkan ADMINISTRATOR pada preset)`, details: { surface: "derived" } });
    } else for (const f of setupTFields(c)) tFail.push({ change: c, message: `${where(c)}.${f}`, details: { pointer: `/${f}` } });
  }
  if (tFail.length > 0) throwFailures("PARAM_CLASS_T_READONLY", tFail);

  // 5: cakupan slot.
  const scopeFail = changes
    .filter((c) => c.slot && !isScopeAllowedInSlot(defOf(c).scope, c.slot))
    .map((c) => ({ change: c, message: `${where(c)} (cakupan ${defOf(c).scope})`, details: { paramKey: c.key, scope: defOf(c).scope } }));
  if (scopeFail.length > 0) throwFailures("SLOT_PARAM_SCOPE_INVALID", scopeFail);

  // 6: kelas K.
  if (!admin) {
    const kFail = changes.filter((c) => classK(defOf(c), c, tier)).map((c) => ({ change: c, message: where(c) }));
    if (kFail.length > 0) throwFailures("PARAM_CLASS_K_FORBIDDEN", kFail);
  }

  // 7: lapis (per kenop untuk medan esensial, D-170).
  const surfaceFail: Failure[] = [];
  for (const c of changes) {
    const surface = defOf(c).surface;
    // Turunan sudah ditangani tahap 4 (400 PARAM_CLASS_T_READONLY).
    if (surface === "essential" || surface === "derived" || admin) continue;
    if (surface !== "internal" && isEssentialFieldChange(c.key, c.previous, c.value)) continue;
    const fields = changedFields(c.previous, c.value);
    const blocked = fields && ESSENTIAL_FIELD_PATHS.has(c.key) ? fields.filter((f) => !isEssentialFieldPath(c.key, f)) : undefined;
    surfaceFail.push({
      change: c,
      message: blocked && blocked.length > 0 ? `${where(c)}.${blocked.join(", .")}` : where(c),
      details: { surface: surface ?? "advanced", ...(blocked && blocked.length > 0 ? { fields: blocked } : {}) },
    });
  }
  if (surfaceFail.length > 0) {
    throwFailures("PARAM_SURFACE_FORBIDDEN", surfaceFail, {
      surface: surfaceFail[0].details?.surface ?? "advanced",
      ...(opts.expertMode ? { expertModeIgnored: true } : {}),
    });
  }
}

/** Validasi nilai satu kunci (bentuk/rentang); null = sah. */
export function paramValueProblem(key: string, value: ParamValue): string | null {
  const def = PARAMS_BY_KEY.get(key);
  if (!def) return "parameter tidak dikenal";
  return validateParamValue(def, value);
}
