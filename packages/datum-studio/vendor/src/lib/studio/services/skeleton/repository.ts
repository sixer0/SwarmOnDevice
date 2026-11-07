/**
 * Baca/tulis kerangka versi templat di DB (SR-06; M10 StudioTemplateSlot, M11
 * StudioTemplateSlotParam, M12 StudioTemplateSlotRoleFormat, MX02
 * `StudioTemplateVersion.skeletonSha256`; register §4.7, §6.3, §15 I44).
 *
 * - `getSkeleton(versionId)`: kerangka eksplisit (baris M10-M12, sidik
 *   diperiksa ulang) atau kerangka implisit dari `sectionPlan` bila versi tidak
 *   punya slot (`skeletonSha256 = null`).
 * - `writeSkeleton(tx, versionId, skeleton)`: validasi + tulis M10-M12 dan
 *   `skeletonSha256` di dalam transaksi pemanggil (SR-07 menyimpan versi
 *   templat + kerangka dalam satu transaksi). Hanya untuk versi BARU: versi yang
 *   sudah berkerangka tidak diubah (D-06, D-62) -> 409 VERSION_CONFLICT.
 * - `loadTemplateLayers` / `resolveSlotsForVersion`: lapis preset + templat dan
 *   nilai efektif per slot (resolve.ts, jalur berlapis).
 *
 * Setiap galat dicatat ke log tahan lama (`skeletonLog`) dengan korelasi lalu
 * dilempar ulang.
 *
 * Swarm twin (row 109, Prisma cut; 01_specs_studio.md §1.2 site 4, store spec §1 M10-M12 FOLD):
 * the slot rows M10-M12 are folded into `template_version.skeleton` (canonical
 * `studio.skeleton/v1` JSON) + `skeleton_sha256`, written once with the version row (the D-06
 * trigger refuses later updates). Reads are the store's; the preset layer of a builtin version
 * comes from the shipped file chain (`builtinTemplate`), of a user version from its base chain.
 *
 * Row 66 (template service): a user version written by the service (v2 definition with a builtin
 * `preset`) takes its preset layer from that preset's shipped chain (`presetFoldBase`), exactly as a
 * builtin derived from that preset does, so a copy resolves like its source.
 */
import { randomUUID } from "node:crypto";
import { findTemplateVersionById, readWith, templateOf, type StudioTx } from "../_swarm-store";
import type {
  ParamMap,
  ParamValue,
  ResolvedSlot,
  RoleFormatMap,
  SectionPlan,
  StudioSkeletonV1,
  StudioTier,
} from "../../contract";
import { STUDIO_TIERS } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import type { DeriveContext, PinPolicy } from "../../engine/tokens";
import type { EssentialKnobSpec } from "../../registry/essentials";
import { builtinTemplate, presetFoldBase } from "../templates";
import { templateRestriction } from "../templates/access";
import { canonicalizeFaceNames } from "../templates/face-names";
import { foldOverrides, TEMPLATE_BASE_CHAIN_MAX } from "../templates/profile";
import { skeletonLog } from "./log";
import { resolveSkeletonSlots, type SlotParamLayers } from "./resolve";
import { canonicalSkeleton, implicitSkeleton, skeletonEssentials, skeletonSha256, validateSkeleton } from "./skeleton";

/** Klien DB: transaksi store (Swarm: `StoreTx`). */
export type SkeletonDb = StudioTx;

/** Kode log integritas sidik kerangka. */
export const SKELETON_SHA_MISMATCH = "TEMPLATE_SKELETON_SHA_MISMATCH";
/** Kode log kunci tersimpan yang tidak diterapkan saat resolusi slot. */
export const SLOT_PARAM_SKIPPED = "SLOT_PARAM_SKIPPED";
/** Tier bawaan bila versi tidak menyebut `doc.defaultTier` (R-49). */
export const DEFAULT_TIER: StudioTier = "TERBIT";

export interface SkeletonRead {
  templateVersionId: string;
  skeleton: StudioSkeletonV1;
  skeletonSha256: string;
  /** true = kerangka dari `sectionPlan` (versi lama tanpa slot). */
  implicit: boolean;
  /** Tier yang dipakai membentuk kerangka implisit (null untuk kerangka eksplisit). */
  tier: StudioTier | null;
}

type ParamRecord = Record<string, ParamValue>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function tierOf(v: unknown): StudioTier | undefined {
  return typeof v === "string" && (STUDIO_TIERS as readonly string[]).includes(v) ? (v as StudioTier) : undefined;
}

/** Jalankan operasi dengan korelasi; galat kontrak = warn, galat tak terduga = error + stack. */
async function runOp<T>(op: string, context: Record<string, unknown>, fn: (cid: string) => Promise<T>): Promise<T> {
  const cid = randomUUID();
  try {
    return await fn(cid);
  } catch (err) {
    if (err instanceof StudioEngineError) {
      skeletonLog({ level: "warn", message: `${op}: ${err.message}`, code: err.code, correlationId: cid, context: { op, ...context } });
      throw err;
    }
    skeletonLog({
      level: "error",
      message: `${op}: galat tak terduga`,
      code: "INTERNAL",
      correlationId: cid,
      stack_trace: err instanceof Error ? err.stack : undefined,
      context: { op, ...context, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

// ── Baca ─────────────────────────────────────────────────────────────────

async function readSkeleton(db: SkeletonDb, templateVersionId: string, tier: StudioTier | undefined, cid: string): Promise<SkeletonRead> {
  if (typeof templateVersionId !== "string" || templateVersionId.length === 0 || templateVersionId.length > 200) {
    throw new StudioEngineError("TEMPLATE_NOT_FOUND", "Versi templat tidak ditemukan");
  }
  const v = findTemplateVersionById(db, templateVersionId);
  if (!v) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi templat tidak ditemukan: ${templateVersionId}`);

  const stored = isRecord(v.skeleton) && Array.isArray((v.skeleton as { slots?: unknown }).slots) ? (v.skeleton as unknown as StudioSkeletonV1) : null;
  if (!stored || stored.slots.length === 0) {
    const params = isRecord(v.resolvedParams) ? v.resolvedParams : {};
    const t = tier ?? tierOf(params["doc.defaultTier"]) ?? DEFAULT_TIER;
    const skeleton = implicitSkeleton((v.sectionPlan ?? {}) as unknown as SectionPlan, t);
    if (v.skeletonSha256) {
      skeletonLog({
        level: "error",
        message: "versi templat memiliki skeletonSha256 tetapi tanpa baris slot; dipakai kerangka implisit",
        code: SKELETON_SHA_MISMATCH,
        correlationId: cid,
        context: { templateVersionId, stored: v.skeletonSha256 },
      });
    }
    return { templateVersionId, skeleton, skeletonSha256: skeletonSha256(skeleton), implicit: true, tier: t };
  }

  const skeleton = canonicalSkeleton({ slots: stored.slots });
  const computed = skeletonSha256(skeleton);
  if (computed !== v.skeletonSha256) {
    skeletonLog({
      level: "error",
      message: "sidik kerangka tersimpan tidak cocok dengan baris slot",
      code: SKELETON_SHA_MISMATCH,
      correlationId: cid,
      context: { templateVersionId, stored: v.skeletonSha256, computed },
    });
  }
  return { templateVersionId, skeleton, skeletonSha256: v.skeletonSha256 ?? computed, implicit: false, tier: null };
}

/**
 * I44 `getSkeleton`: kerangka satu versi templat. Untuk versi lama tanpa slot,
 * kerangka implisit dibentuk untuk `opts.tier` (bawaan `doc.defaultTier` versi,
 * lalu TERBIT).
 */
export async function getSkeleton(templateVersionId: string, opts: { tier?: StudioTier; db?: SkeletonDb } = {}): Promise<SkeletonRead> {
  return runOp("getSkeleton", { templateVersionId, tier: opts.tier ?? null }, (cid) => readWith(opts.db, (db) => readSkeleton(db, templateVersionId, opts.tier, cid)));
}

export interface TemplateSkeletonView extends SkeletonRead {
  template: { id: string; slug: string; name: string; isPreset: boolean; latestVersionNo: number };
  versionNo: number;
  essentials: { global: readonly EssentialKnobSpec[]; bySlot: Record<string, readonly EssentialKnobSpec[]> };
}

/** Kerangka templat (id atau slug) versi tertentu/terbaru + kenop esensial global dan per slot (R19 GET). */
export async function getTemplateSkeleton(
  idOrSlug: string,
  versionNo?: number,
  opts: { tier?: StudioTier; db?: SkeletonDb } = {},
): Promise<TemplateSkeletonView> {
  return runOp("getTemplateSkeleton", { idOrSlug, versionNo: versionNo ?? null }, (cid) =>
    readWith(opts.db, async (db) => {
      if (typeof idOrSlug !== "string" || idOrSlug.length === 0 || idOrSlug.length > 200) {
        throw new StudioEngineError("TEMPLATE_NOT_FOUND", "Templat tidak ditemukan");
      }
      const row = db.get("SELECT * FROM template WHERE id = ? OR slug = ? ORDER BY (id = ?) DESC LIMIT 1", [idOrSlug, idOrSlug, idOrSlug]);
      if (!row) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat tidak ditemukan: ${idOrSlug}`);
      const tt = templateOf(row);
      const t = { id: tt.id, slug: tt.slug, name: tt.name, isPreset: tt.isPreset, latestVersionNo: tt.latestVersionNo };
      const no = versionNo ?? t.latestVersionNo;
      if (!Number.isInteger(no) || no < 1) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi templat ${t.slug} tidak sah: ${String(versionNo)}`);
      const v = db.get<{ id: string }>("SELECT id FROM template_version WHERE template_id = ? AND version_no = ?", [t.id, no]);
      if (!v) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi ${no} templat ${t.slug} tidak ada`);
      const read = await readSkeleton(db, v.id, opts.tier, cid);
      return { ...read, template: t, versionNo: no, essentials: skeletonEssentials(read.skeleton) };
    }),
  );
}

// ── Lapis templat dan resolusi slot ─────────────────────────────────────

export interface TemplateLayers {
  templateId: string;
  slug: string;
  templateVersionId: string;
  versionNo: number;
  isPreset: boolean;
  /** Templat terbatas D-98 (dihitung dari parameter efektif). */
  restricted: boolean;
  /** Lapis 2 + 3-4 untuk resolusi berlapis. */
  layers: SlotParamLayers;
  /** Kunci yang disematkan rantai preset/dasar. */
  presetPins: ReadonlySet<string>;
  /** Parameter efektif templat tersimpan (lapis 1-4 + turunan). */
  params: ParamMap;
  roleFormats: RoleFormatMap;
  sectionPlan: SectionPlan;
  paramsSha256: string;
}

async function loadLayers(db: SkeletonDb, templateVersionId: string): Promise<TemplateLayers> {
  const v = findTemplateVersionById(db, templateVersionId);
  if (!v) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi templat tidak ditemukan: ${templateVersionId}`);
  // Rantai versi dasar (akar -> induk), sama dengan resolusi templat (D-62). A builtin version's
  // preset chain lives in the shipped files (store pins have no base row, §7.2).
  const chain: ParamRecord[] = [];
  const builtinRoot = (b: { template: { origin: string; slug: string } }): boolean => {
    if (b.template.origin !== "builtin") return false;
    const shipped = builtinTemplate(b.template.slug);
    if (!shipped) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat bawaan tidak dikirim: ${b.template.slug}`);
    chain.unshift(shipped.presetFold);
    return true;
  };
  // Row 66: a user version saved by the template service holds its full template layer, folded on
  // the builtin preset its definition names (the clone's baseVersionId = preset version). Its preset
  // layer is that preset's shipped chain; `base_version_id` is lineage only (source or previous
  // version), so it is not walked. Other user rows (no v2 definition) keep the row 109 walk.
  const presetSlug = userPresetSlug(v);
  if (presetSlug !== null) chain.push(presetFoldBase(presetSlug).baseOverrides);
  else if (!builtinRoot(v)) {
    const visited = new Set<string>([v.id]);
    let next = v.baseVersionId;
    while (next) {
      if (visited.has(next) || visited.size > TEMPLATE_BASE_CHAIN_MAX) {
        throw new StudioEngineError("SCHEMA_INVALID", `Rantai versi dasar templat melingkar atau lebih dari ${TEMPLATE_BASE_CHAIN_MAX}`);
      }
      visited.add(next);
      const b = findTemplateVersionById(db, next);
      if (!b) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi dasar templat tidak ditemukan: ${next}`);
      chain.unshift(isRecord(b.overrides) ? (b.overrides as ParamRecord) : {});
      if (builtinRoot(b)) break;
      next = b.baseVersionId;
    }
  }
  const preset = foldOverrides(chain);
  const params = (isRecord(v.resolvedParams) ? v.resolvedParams : {}) as unknown as ParamMap;
  return {
    templateId: v.template.id,
    slug: v.template.slug,
    templateVersionId: v.id,
    versionNo: v.versionNo,
    isPreset: v.template.isPreset,
    restricted: templateRestriction(params).restricted,
    layers: { preset, template: isRecord(v.overrides) ? (v.overrides as ParamRecord) : {} },
    presetPins: new Set(Object.keys(preset)),
    params,
    roleFormats: (v.roleFormats ?? {}) as unknown as RoleFormatMap,
    sectionPlan: (v.sectionPlan ?? {}) as unknown as SectionPlan,
    paramsSha256: v.paramsSha256,
  };
}

/** Preset slug of a user version written by the row 66 service (`studio.template/v2` definition with `preset`), else null. */
function userPresetSlug(v: { template: { origin: string }; definition: unknown }): string | null {
  if (v.template.origin !== "user" || !isRecord(v.definition) || v.definition.$schema !== "studio.template/v2") return null;
  const p = v.definition.preset;
  return isRecord(p) && typeof p.slug === "string" ? p.slug : null;
}

/** Lapis preset (rantai `baseVersionId`) + override templat satu versi, untuk resolusi slot dan cek izin. */
export async function loadTemplateLayers(templateVersionId: string, opts: { db?: SkeletonDb } = {}): Promise<TemplateLayers> {
  return runOp("loadTemplateLayers", { templateVersionId }, () => readWith(opts.db, (db) => loadLayers(db, templateVersionId)));
}

export interface ResolvedVersionSlots extends SkeletonRead {
  template: TemplateLayers;
  /** Nilai efektif per slot (hanya slot aktif bila `tier` diisi). */
  slots: ReadonlyMap<string, ResolvedSlot>;
}

/**
 * Kerangka + nilai efektif per slot satu versi templat (resolusi berlapis
 * penuh, `deriveLayered` sekali per slot). Kunci tersimpan yang tidak dapat
 * diterapkan dicatat (warn `SLOT_PARAM_SKIPPED`), tidak menggagalkan render.
 */
export async function resolveSlotsForVersion(
  templateVersionId: string,
  opts: { tier?: StudioTier; activeOnly?: boolean; ctx?: DeriveContext; pinPolicy?: PinPolicy; db?: SkeletonDb } = {},
): Promise<ResolvedVersionSlots> {
  return runOp("resolveSlotsForVersion", { templateVersionId, tier: opts.tier ?? null }, (cid) => readWith(opts.db, async (db) => {
    const template = await loadLayers(db, templateVersionId);
    const read = await readSkeleton(db, templateVersionId, opts.tier, cid);
    const filterTier = opts.activeOnly === false ? undefined : (opts.tier ?? read.tier ?? undefined);
    const { slots, issues } = resolveSkeletonSlots(
      { params: template.params, roleFormats: template.roleFormats },
      read.skeleton.slots,
      template.presetPins,
      { layers: template.layers, ctx: opts.ctx, pinPolicy: opts.pinPolicy, tier: filterTier },
    );
    if (issues.length > 0) {
      skeletonLog({
        level: "warn",
        message: "kunci parameter tersimpan tidak diterapkan saat resolusi slot",
        code: SLOT_PARAM_SKIPPED,
        correlationId: cid,
        context: { templateVersionId, issues: issues.map((i) => ({ key: i.key, code: i.code, pointer: i.pointer ?? null })) },
      });
    }
    // Swarm patch (row 165D, F113-11): the per-slot params/role formats the render uses carry the canonical family
    // names too ("IBM Plex Sans Cond" -> "IBM Plex Sans Condensed"), as templates/index.ts resolvedFromVersion.
    return { ...read, template: canonicalizeFaceNames(template), slots: canonicalizeFaceNames(slots) };
  }));
}

// ── Tulis ────────────────────────────────────────────────────────────────

export interface WriteSkeletonResult {
  skeleton: StudioSkeletonV1;
  skeletonSha256: string;
  slotIds: Record<string, string>;
}

/** Folded skeleton for a NEW template version row (the store writes it with the row, §7.3). */
export function skeletonForInsert(input: Pick<StudioSkeletonV1, "slots">, opts: { tier?: StudioTier } = {}): { skeleton: StudioSkeletonV1; skeletonSha256: string } {
  const skeleton = canonicalSkeleton(validateSkeleton(input, opts));
  return { skeleton, skeletonSha256: skeletonSha256(skeleton) };
}

/**
 * I44 `writeSkeleton`. Swarm: a version's skeleton is part of its immutable row, so it can only be
 * given at insert (`skeletonForInsert` + `addTemplateVersion`/`createUserTemplate`, row 66). Here it
 * validates and confirms a version that already carries exactly this skeleton; any other case is
 * the clone's 409 VERSION_CONFLICT ("simpan sebagai versi baru"). Slot ids = slot keys (M10 folded).
 */
export async function writeSkeleton(
  tx: SkeletonDb,
  templateVersionId: string,
  input: Pick<StudioSkeletonV1, "slots">,
  opts: { tier?: StudioTier } = {},
): Promise<WriteSkeletonResult> {
  return runOp("writeSkeleton", { templateVersionId, slots: Array.isArray(input?.slots) ? input.slots.length : null }, async (cid) => {
    const { skeleton, skeletonSha256: sha } = skeletonForInsert(input, opts);
    const v = findTemplateVersionById(tx, templateVersionId);
    if (!v) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi templat tidak ditemukan: ${templateVersionId}`);
    if (v.skeletonSha256 !== sha) {
      throw new StudioEngineError("VERSION_CONFLICT", "Versi templat sudah memiliki kerangka; simpan sebagai versi baru", {
        templateVersionId,
        skeletonSha256: v.skeletonSha256,
      });
    }
    const slotIds: Record<string, string> = {};
    for (const slot of skeleton.slots) slotIds[slot.slotKey] = slot.slotKey;
    skeletonLog({ level: "info", message: "Kerangka versi templat dikonfirmasi", code: "TEMPLATE_SKELETON_WRITTEN", correlationId: cid, context: { templateVersionId, skeletonSha256: sha, slots: skeleton.slots.map((s) => s.slotKey) } });
    return { skeleton, skeletonSha256: sha, slotIds };
  });
}
