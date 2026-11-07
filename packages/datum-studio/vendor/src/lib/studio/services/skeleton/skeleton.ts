/**
 * Kerangka templat murni (SR-06; register 03_structural_sections_specs §4.7,
 * §6, §13.5, §15 I44).
 *
 * - `canonicalSkeleton` / `canonicalSlotDef`: bentuk kanonik satu kerangka
 *   (urut posisi, kunci parameter dipartisi menurut lapis simpan M11). Bentuk
 *   ini yang di-hash dan yang dikembalikan saat dibaca ulang dari DB, sehingga
 *   `configSha256`/`skeletonSha256` stabil pulang-pergi.
 * - `implicitSkeleton(plan, tier)`: kerangka dari `sectionPlan` versi templat
 *   lama (§6.3). Urutan slot = `orderedPlanSections` tier itu (kunci `order`
 *   lebih dulu lalu urutan registri) dikurangi kunci `forbidden` dan kunci di
 *   luar C33 (penjaga blueprint SR-06).
 * - `validateSkeleton`: aturan SKELETON_* (400 SCHEMA_INVALID ber-checkId),
 *   SLOT_DUPLICATE (422), kunci parameter slot (PARAM_UNKNOWN_KEY 422, nilai
 *   400, kelas T 400, SLOT_PARAM_SCOPE_INVALID 422). Izin peran/kelas K/lapis
 *   per kunci berubah = `checkTemplateWrite` (access.ts).
 *
 * Modul murni: tanpa I/O.
 */
import type { ParamValue, SectionPlan, StudioSkeletonV1, StudioTier, TemplateSlotDef, ValidationIssue } from "../../contract";
import { STUDIO_SLOT_CONTENT_MODES, STUDIO_TIERS } from "../../contract/enums";
import { SLOT_KEY_PATTERN } from "../../contract/env";
import { StudioEngineError } from "../../contract/errors";
import { effectiveClass } from "../../engine/tokens/merge";
import { PARAMS_BY_KEY } from "../../params";
import { essentialKnobsFor, type EssentialKnobSpec } from "../../registry/essentials";
import { orderedPlanSections, SECTION_REGISTRY } from "../../registry/sections";
import { isScopeAllowedInSlot, isSlotSectionType, SLOT_KIND_BY_TYPE } from "../../registry/slots";
import { sha256Hex, stableStringify } from "../ingest/util";
import { sectionPlanForTier, validateRoleFormats } from "../templates/profile";
import { diffParamMaps, type ParamChange, paramValueProblem, SLOT_SETUP_KEY, SLOT_SETUP_T_FIELDS, storedSurfaceOf } from "./access";

export const SKELETON_SCHEMA = "studio.skeleton/v1" as const;
const SLOT_KEY_RE = new RegExp(SLOT_KEY_PATTERN);
const SECTION_NAME = new Map(SECTION_REGISTRY.map((s) => [s.key, s.name]));

type ParamRecord = Record<string, ParamValue>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function pointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

// ── Bentuk kanonik dan sidik ─────────────────────────────────────────────

/**
 * Gabung `essentials` + `advanced` satu slot menjadi peta datar (kunci yang
 * muncul di keduanya: objek digabung dangkal, `advanced` menang; lainnya
 * `advanced` menang). Dipakai sebelum partisi lapis simpan.
 */
export function flattenSlotParams(slot: Pick<TemplateSlotDef, "essentials" | "advanced">): ParamRecord {
  const out: ParamRecord = {};
  for (const [k, v] of Object.entries(slot.essentials ?? {})) out[k] = clone(v);
  for (const [k, v] of Object.entries(slot.advanced ?? {})) {
    const prev = out[k];
    out[k] = isRecord(prev) && isRecord(v) ? { ...prev, ...clone(v) } : clone(v);
  }
  return out;
}

/** Partisi peta datar menurut lapis simpan M11 (`storedSurfaceOf`). */
export function partitionBySurface(flat: Readonly<ParamRecord>): { essentials: ParamRecord; advanced: ParamRecord } {
  const essentials: ParamRecord = {};
  const advanced: ParamRecord = {};
  for (const key of Object.keys(flat).sort()) {
    if (storedSurfaceOf(key, flat[key]) === "essential") essentials[key] = clone(flat[key]);
    else advanced[key] = clone(flat[key]);
  }
  return { essentials, advanced };
}

/** Bentuk kanonik satu slot (medan opsional kosong dibuang, tier urut E09, parameter dipartisi). */
export function canonicalSlotDef(slot: TemplateSlotDef): TemplateSlotDef {
  const { essentials, advanced } = partitionBySurface(flattenSlotParams(slot));
  const tiers = STUDIO_TIERS.filter((t) => (slot.tiers ?? []).includes(t));
  const out: TemplateSlotDef = {
    slotKey: slot.slotKey,
    sectionType: slot.sectionType,
    label: slot.label,
    position: slot.position,
    required: slot.required === true,
    positionLocked: slot.positionLocked === true,
    repeatable: slot.repeatable === true,
    contentMode: slot.contentMode,
    tiers,
    admits: [...(slot.admits ?? [])],
    essentials,
  };
  if (typeof slot.minItems === "number") out.minItems = slot.minItems;
  if (typeof slot.maxItems === "number") out.maxItems = slot.maxItems;
  if (Object.keys(advanced).length > 0) out.advanced = advanced;
  if (slot.roleFormats && Object.keys(slot.roleFormats).length > 0) out.roleFormats = clone(slot.roleFormats);
  return out;
}

/** Kerangka kanonik: slot kanonik urut posisi. */
export function canonicalSkeleton(s: Pick<StudioSkeletonV1, "slots">): StudioSkeletonV1 {
  const slots = [...s.slots].map(canonicalSlotDef).sort((a, b) => a.position - b.position);
  return { $schema: SKELETON_SCHEMA, slots };
}

/** M10 `configSha256` = sha256(stableStringify(slot kanonik)). */
export function slotConfigSha256(slot: TemplateSlotDef): string {
  return sha256Hex(stableStringify(canonicalSlotDef(slot)));
}

/** MX02 `skeletonSha256` = sha256(stableStringify(slot kanonik urut posisi)). */
export function skeletonSha256(s: Pick<StudioSkeletonV1, "slots">): string {
  return sha256Hex(stableStringify(canonicalSkeleton(s).slots));
}

// ── Kerangka implisit (§6.3) ─────────────────────────────────────────────

/**
 * Kerangka per tier dari `sectionPlan` versi templat lama (`skeletonSha256 =
 * null`). slotKey = `implicitSlotKey` registri slot (signatureBlock ->
 * signature, chapter -> content, appendix -> appendices, sourceRegister ->
 * references); `required` = ada di daftar wajib tier; `tiers = []`;
 * `contentMode` = bawaan jenis slot; chapter berulang `minItems 1`, appendix
 * berulang; `admits` = bawaan jenis slot; label = nama registri section.
 */
export function implicitSkeleton(plan: SectionPlan, tier: StudioTier): StudioSkeletonV1 {
  const entry = sectionPlanForTier(plan, tier);
  const forbidden = new Set(entry.forbidden);
  const required = new Set(entry.required);
  const slots: TemplateSlotDef[] = [];
  for (const key of orderedPlanSections(entry)) {
    if (forbidden.has(key) || !isSlotSectionType(key)) continue;
    const kind = SLOT_KIND_BY_TYPE.get(key);
    if (!kind) continue;
    const slot: TemplateSlotDef = {
      slotKey: kind.implicitSlotKey,
      sectionType: key,
      label: SECTION_NAME.get(key) ?? key,
      position: slots.length + 1,
      required: required.has(key),
      positionLocked: false,
      repeatable: kind.repeatable,
      contentMode: kind.defaultContentMode,
      tiers: [],
      admits: [...kind.defaultAdmits],
      essentials: {},
    };
    if (kind.implicitMinItems !== undefined) slot.minItems = kind.implicitMinItems;
    slots.push(slot);
  }
  return { $schema: SKELETON_SCHEMA, slots };
}

/** Slot aktif untuk tier dokumen: `tiers` kosong atau memuat tier itu (§6.1). */
export function isSlotActive(slot: Pick<TemplateSlotDef, "tiers">, tier: StudioTier): boolean {
  return !slot.tiers || slot.tiers.length === 0 || slot.tiers.includes(tier);
}

// ── Validasi (§4.7) ──────────────────────────────────────────────────────

function issue(pointer: string, keyword: string, message: string, checkId?: string): ValidationIssue {
  return checkId ? { pointer, keyword, message, checkId } : { pointer, keyword, message };
}

function throwSchema(issues: ValidationIssue[]): never {
  const more = issues.length > 1 ? ` (+${issues.length - 1} isu lain)` : "";
  throw new StudioEngineError("SCHEMA_INVALID", `Kerangka tidak sah: ${issues[0].message}${more}`, { issues });
}

/** Aturan bentuk per slot (SKELETON_*); tidak memeriksa parameter. */
function structuralIssues(s: Pick<StudioSkeletonV1, "slots">): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(s.slots) || s.slots.length === 0) {
    return [issue("/slots", "minItems", "kerangka wajib memuat paling sedikit satu slot", "SKELETON_POSITION")];
  }
  const n = s.slots.length;
  const positions = s.slots.map((x) => x.position);
  const sorted = [...positions].sort((a, b) => a - b);
  if (!sorted.every((p, i) => p === i + 1)) {
    issues.push(issue("/slots", "position", `posisi slot harus unik dan kontigu 1..${n} (diterima: ${positions.join(", ")})`, "SKELETON_POSITION"));
  }
  const perType = new Map<string, number>();
  s.slots.forEach((slot, i) => {
    const p = `/slots/${i}`;
    if (typeof slot.slotKey !== "string" || !SLOT_KEY_RE.test(slot.slotKey)) {
      issues.push(issue(`${p}/slotKey`, "pattern", `slotKey harus ${SLOT_KEY_PATTERN}`));
    }
    if (typeof slot.label !== "string" || slot.label.trim().length === 0) {
      issues.push(issue(`${p}/label`, "required", "label slot wajib diisi"));
    }
    const kind = typeof slot.sectionType === "string" ? SLOT_KIND_BY_TYPE.get(slot.sectionType) : undefined;
    if (!kind) {
      issues.push(issue(`${p}/sectionType`, "enum", `sectionType ${String(slot.sectionType)} bukan jenis slot kerangka`, "SKELETON_SECTION_TYPE"));
      return;
    }
    const count = (perType.get(kind.sectionType) ?? 0) + 1;
    perType.set(kind.sectionType, count);
    if (kind.singlePerSkeleton && count > 1) {
      issues.push(issue(`${p}/sectionType`, "maxContains", `paling banyak satu slot berjenis ${kind.sectionType} per kerangka`, "SKELETON_SECTION_TYPE"));
    }
    if (slot.repeatable && !kind.repeatable) {
      issues.push(issue(`${p}/repeatable`, "const", `slot berjenis ${kind.sectionType} tidak boleh berulang`, "SKELETON_REPEATABLE"));
    }
    const hasMin = slot.minItems !== undefined && slot.minItems !== null;
    const hasMax = slot.maxItems !== undefined && slot.maxItems !== null;
    if ((hasMin || hasMax) && !slot.repeatable) {
      issues.push(issue(`${p}`, "dependentRequired", "minItems/maxItems hanya untuk slot berulang", "SKELETON_REPEATABLE"));
    }
    for (const f of ["minItems", "maxItems"] as const) {
      const v = slot[f];
      if (v !== undefined && v !== null && !(Number.isInteger(v) && v >= 0)) {
        issues.push(issue(`${p}/${f}`, "minimum", `${f} harus bilangan bulat >= 0`, "SKELETON_REPEATABLE"));
      }
    }
    if (hasMin && hasMax && (slot.minItems as number) > (slot.maxItems as number)) {
      issues.push(issue(`${p}/minItems`, "maximum", "minItems tidak boleh lebih besar dari maxItems", "SKELETON_REPEATABLE"));
    }
    if (!(STUDIO_SLOT_CONTENT_MODES as readonly string[]).includes(slot.contentMode) || !kind.contentModes.includes(slot.contentMode)) {
      issues.push(
        issue(`${p}/contentMode`, "enum", `contentMode slot ${kind.sectionType} harus salah satu dari ${kind.contentModes.join(", ")}`, "SKELETON_CONTENT_MODE"),
      );
    }
    const admits = Array.isArray(slot.admits) ? slot.admits : [];
    if (kind.admitsAllowed.length === 0 && admits.length > 0) {
      issues.push(issue(`${p}/admits`, "maxItems", `admits harus kosong untuk slot berjenis ${kind.sectionType}`, "SKELETON_ADMITS"));
    }
    const badAdmits = admits.filter((a) => !kind.admitsAllowed.includes(a));
    if (kind.admitsAllowed.length > 0 && badAdmits.length > 0) {
      issues.push(issue(`${p}/admits`, "enum", `admits tidak dikenal: ${badAdmits.join(", ")}`, "SKELETON_ADMITS"));
    }
    if (new Set(admits).size !== admits.length) {
      issues.push(issue(`${p}/admits`, "uniqueItems", "admits tidak boleh ganda", "SKELETON_ADMITS"));
    }
    const tiers = Array.isArray(slot.tiers) ? slot.tiers : [];
    if (tiers.some((t) => !(STUDIO_TIERS as readonly string[]).includes(t)) || new Set(tiers).size !== tiers.length) {
      issues.push(issue(`${p}/tiers`, "enum", `tiers harus subset unik dari ${STUDIO_TIERS.join(", ")}`));
    }
    for (const f of ["essentials", "advanced", "roleFormats"] as const) {
      const v = slot[f];
      if (f === "essentials" ? !isRecord(v) : v !== undefined && !isRecord(v)) {
        issues.push(issue(`${p}/${f}`, "type", `${f} harus objek`));
      }
    }
  });
  return issues;
}

/**
 * Validasi kerangka (simpan templat / R19). Urutan: bentuk (400 SCHEMA_INVALID,
 * checkId SKELETON_*) -> slotKey ganda (422 SLOT_DUPLICATE) -> kunci parameter
 * tak dikenal (422) -> nilai tidak sah (400 SCHEMA_INVALID) -> kelas T (400)
 * -> cakupan slot (422 SLOT_PARAM_SCOPE_INVALID). Mengembalikan kerangka kanonik.
 */
export function validateSkeleton(s: Pick<StudioSkeletonV1, "slots">, opts: { tier?: StudioTier } = {}): StudioSkeletonV1 {
  const structural = structuralIssues(s);
  if (structural.length > 0) throwSchema(structural);

  const byKey = new Map<string, number[]>();
  for (const slot of s.slots) byKey.set(slot.slotKey, [...(byKey.get(slot.slotKey) ?? []), slot.position]);
  const dup = [...byKey.entries()].find(([, ps]) => ps.length > 1);
  if (dup) {
    throw new StudioEngineError("SLOT_DUPLICATE", `slotKey ${dup[0]} muncul lebih dari sekali di kerangka`, { slotKey: dup[0], positions: dup[1] });
  }

  const unknown: Array<{ slotKey: string; key: string; pointer: string }> = [];
  const invalid: ValidationIssue[] = [];
  const tReadonly: Array<{ slotKey: string; key: string; pointer: string }> = [];
  const scope: Array<{ slotKey: string; paramKey: string; scope: string }> = [];
  s.slots.forEach((slot, i) => {
    for (const f of ["essentials", "advanced"] as const) {
      for (const [key, value] of Object.entries(slot[f] ?? {})) {
        const pointer = `/slots/${i}/${f}/${pointerSegment(key)}`;
        const def = PARAMS_BY_KEY.get(key);
        if (!def) {
          unknown.push({ slotKey: slot.slotKey, key, pointer });
          continue;
        }
        const bad = paramValueProblem(key, value);
        if (bad) invalid.push(issue(pointer, "param", `nilai ${key} tidak sah: ${bad}`));
        if (effectiveClass(def, value, opts.tier) === "T") tReadonly.push({ slotKey: slot.slotKey, key, pointer });
        else if (key === SLOT_SETUP_KEY && isRecord(value)) {
          for (const tf of SLOT_SETUP_T_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(value, tf)) tReadonly.push({ slotKey: slot.slotKey, key: `${key}.${tf}`, pointer: `${pointer}/${tf}` });
          }
        }
        if (!isScopeAllowedInSlot(def.scope, slot)) scope.push({ slotKey: slot.slotKey, paramKey: key, scope: def.scope });
      }
    }
    if (slot.roleFormats !== undefined) {
      const r = validateRoleFormats(slot.roleFormats, `/slots/${i}/roleFormats`);
      for (const ri of r.issues) invalid.push(issue(ri.pointer ?? `/slots/${i}/roleFormats`, "roleFormat", ri.message));
    }
  });
  if (unknown.length > 0) {
    throw new StudioEngineError("PARAM_UNKNOWN_KEY", `Parameter slot tidak dikenal: ${unknown[0].slotKey}: ${unknown[0].key}`, {
      keys: unknown.map((u) => u.key),
      slotKey: unknown[0].slotKey,
      issues: unknown,
    });
  }
  if (invalid.length > 0) throwSchema(invalid);
  if (tReadonly.length > 0) {
    throw new StudioEngineError("PARAM_CLASS_T_READONLY", `Parameter dihitung mesin dan tidak dapat ditimpa: ${tReadonly[0].slotKey}: ${tReadonly[0].key}`, {
      keys: tReadonly.map((t) => t.key),
      slotKey: tReadonly[0].slotKey,
      pointer: tReadonly[0].pointer,
      issues: tReadonly,
    });
  }
  if (scope.length > 0) {
    const f = scope[0];
    throw new StudioEngineError(
      "SLOT_PARAM_SCOPE_INVALID",
      `Parameter ${f.paramKey} (cakupan ${f.scope}) tidak berlaku untuk slot ${f.slotKey}; atur di tingkat templat atau di slot yang sesuai`,
      { slotKey: f.slotKey, paramKey: f.paramKey, scope: f.scope, all: scope },
    );
  }
  return canonicalSkeleton(s);
}

// ── Kenop esensial per kerangka (R19 GET) ───────────────────────────────

/** Kenop esensial global + per slot (menurut sectionType slot) untuk satu kerangka. */
export function skeletonEssentials(s: Pick<StudioSkeletonV1, "slots">): {
  global: readonly EssentialKnobSpec[];
  bySlot: Record<string, readonly EssentialKnobSpec[]>;
} {
  const bySlot: Record<string, readonly EssentialKnobSpec[]> = {};
  for (const slot of s.slots) bySlot[slot.slotKey] = essentialKnobsFor(slot.sectionType);
  return { global: essentialKnobsFor("global"), bySlot };
}

// ── Perubahan parameter antar kerangka (D-134) ──────────────────────────

/**
 * Kunci parameter slot yang berubah dari kerangka lama ke baru (per slotKey;
 * slot baru atau berganti sectionType dibandingkan dengan peta kosong). Slot
 * yang dihapus tidak menghasilkan perubahan parameter (perubahan struktur).
 */
export function skeletonParamChanges(prev: Pick<StudioSkeletonV1, "slots"> | null | undefined, next: Pick<StudioSkeletonV1, "slots">): ParamChange[] {
  const before = new Map((prev?.slots ?? []).map((s) => [s.slotKey, s]));
  const out: ParamChange[] = [];
  for (const slot of [...next.slots].sort((a, b) => a.position - b.position)) {
    const old = before.get(slot.slotKey);
    const prevParams = old && old.sectionType === slot.sectionType ? flattenSlotParams(old) : {};
    out.push(...diffParamMaps(prevParams, flattenSlotParams(slot), { slotKey: slot.slotKey, sectionType: slot.sectionType, admits: slot.admits ?? [] }));
  }
  return out;
}
