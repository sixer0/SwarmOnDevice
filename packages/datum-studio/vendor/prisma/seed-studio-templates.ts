/**
 * Helper bersama seed templat turunan-preset (baris S09; research/33 C-01..C-06; D-595).
 *
 * Diekstrak dari jalur `--contract-templates` `prisma/seed-studio.ts` tanpa mengubah perilakunya, agar jalur
 * templat berikutnya (mis. `--doc-type-templates`, S27) memakai helper yang sama dengan satu tabel spec,
 * bukan blok seed tersalin. Tidak ada cabang slug/jenis dokumen: CH-06 dicek untuk setiap spec (S27; slot
 * `contractRecord` hanya sah bila data `contractKind` spec terisi).
 *
 *   - `presetSlotEssentials`: kenop esensial per slot dibaca dari nilai efektif preset (+ override per slot).
 *   - `derivedTemplatePlan` / `ensureDerivedTemplate`: templat = rujukan versi preset terbaru + esensial global
 *     + lapis spec + kerangka; idempoten lewat `ensureSkeletonVersion`.
 *   - `derivedTemplateStoredIssues`: cek baris tersimpan generik (contractKind null-aman, AC-2: tidak terbatas,
 *     tidak terarsip, basis = versi preset terbaru).
 *   - `derivedPresetPlan` / `ensureDerivedPreset` (C21, research/35 §6 M2): preset gaya turunan = versi terbaru
 *     preset dasar + sematan (pemanggil ADMIN, jadi kunci turunan boleh disematkan); idempoten lewat
 *     `ensureSkeletonVersion` (`isPreset`). Tabel spec data murni di `prisma/seed-derived-presets.ts`.
 *   - `runGuardedTemplateTx`: satu transaksi berpenjaga (templat lain dan section type tidak berubah; opsi `presets`
 *     = preset turunan sebagai sasaran tambahan, ditulis sebelum templat), `--dry-run` = rollback lewat sinyal setelah
 *     laporan dan penjaga dihitung.
 *
 * Modul ini tidak membuka koneksi DB sendiri dan tidak memeriksa nama DB izin (penjaga `ALLOWED_DATABASES` tetap
 * di `seed-studio.ts`); runner hanya mencocokkan DB transaksi dengan DB yang sudah diperiksa pemanggil.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { CONTENT_BLOCK_TYPES, ROLE_KEYS, type ParamValue, type RoleKey, type StudioCaller, type StudioTemplateV2, type TemplateSlotDef } from "../src/lib/studio/contract";
import { WRAPPER_TEXT } from "../src/lib/studio/engine/front/texts";
import { catalogRoleFormat, validateParamValue } from "../src/lib/studio/engine/tokens";
import { stableStringify } from "../src/lib/studio/services/ingest";
import { PARAMS_BY_KEY } from "../src/lib/studio/params";
import { ESSENTIAL_KNOBS } from "../src/lib/studio/registry/essentials";
import { contractRecordSkeletonIssues, isScopeAllowedInSlot } from "../src/lib/studio/registry/slots";
import { skeletonSha256, validateSkeleton } from "../src/lib/studio/services/skeleton";
import {
  createTemplateV2InTx,
  createTemplateVersionV2InTx,
  type ParamRecord,
  splitBySurface,
  templateRestriction,
} from "../src/lib/studio/services/templates";
import { ownRoleFormats as ownRolesOf } from "../src/lib/studio/services/templates/v2";

export type Tx = Prisma.TransactionClient;
export type VersionRow = Awaited<ReturnType<PrismaClient["studioTemplateVersion"]["findFirstOrThrow"]>>;
export type SeedLog = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>, err?: unknown) => void;
/** Definisi slot tanpa kenop (kenop dibaca dari preset saat seed). */
export type SlotShape = Omit<TemplateSlotDef, "essentials">;

export const TEMPLATE_V2_SCHEMA_ID = "studio.template/v2" as const;
export const PRESET_TX_TIMEOUT_MS = 180_000;
export const SEED_ACTOR = "seed-studio";
/** Impor profil Manual 000 memuat override kelas K: wajib pemanggil ADMIN_SESSION (KT-16). */
export const ADMIN_CALLER: StudioCaller = { kind: "ADMIN_SESSION", requester: SEED_ACTOR, canWriteClassK: true };

/**
 * Kerangka bawaan 7 slot GSP DATUM (register 03 §6.1 SL-01..SL-07; blueprint §2.3): satu sumber untuk
 * `--presets-and-skeletons` (datum-gsp, datum-kanonik) dan tabel spec `--doc-type-templates` (S26).
 * L8 (D-610): label slot lembar kendali dan daftar isi dari tabel teks pembungkus (`WRAPPER_TEXT`), sumber yang
 * sama dengan terjemahan EN `controlSheetLabelText`; nilainya tetap "Lembar Kendali" / "Daftar Isi" (byte-sama).
 */
export const DATUM_SKELETON_SLOTS: ReadonlyArray<SlotShape> = [
  { slotKey: "cover", sectionType: "cover", label: "Sampul", position: 1, required: true, positionLocked: true, repeatable: false, contentMode: "MIXED", tiers: ["TERBIT", "SERAH"], admits: [] },
  { slotKey: "controlSheet", sectionType: "controlSheet", label: WRAPPER_TEXT.controlKicker.ID, position: 2, required: true, positionLocked: false, repeatable: false, contentMode: "INPUT", tiers: ["TERBIT", "SERAH"], admits: [] },
  { slotKey: "signature", sectionType: "signatureBlock", label: "Tanda Tangan", position: 3, required: true, positionLocked: false, repeatable: false, contentMode: "INPUT", tiers: ["TERBIT", "SERAH"], admits: [] },
  { slotKey: "toc", sectionType: "toc", label: WRAPPER_TEXT.tocKicker.ID, position: 4, required: true, positionLocked: false, repeatable: false, contentMode: "AUTO", tiers: ["TERBIT", "SERAH"], admits: [] },
  { slotKey: "content", sectionType: "chapter", label: "Isi", position: 5, required: true, positionLocked: false, repeatable: true, minItems: 1, contentMode: "INPUT", tiers: [], admits: [...CONTENT_BLOCK_TYPES] },
  { slotKey: "references", sectionType: "sourceRegister", label: "Referensi", position: 6, required: false, positionLocked: false, repeatable: false, contentMode: "INPUT", tiers: [], admits: [] },
  { slotKey: "appendices", sectionType: "appendix", label: "Lampiran", position: 7, required: false, positionLocked: true, repeatable: true, contentMode: "INPUT", tiers: [], admits: [...CONTENT_BLOCK_TYPES] },
];

/** Sinyal rollback `--dry-run` (bukan galat). */
export class DryRunRollback extends Error {
  constructor(readonly report: unknown) {
    super("dry-run: transaksi preset/kerangka di-rollback");
  }
}

export const stable = (v: unknown): string => stableStringify(v ?? null);
export const asRecord = (v: unknown): ParamRecord => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as ParamRecord) : {});

/** Nilai kenop esensial (pemetaan selain `medan`, kunci berlapis essential) dari nilai efektif; nilai tidak sah dilewati. */
export function knobValues(scope: string, effective: ParamRecord, accept: (key: string) => boolean = () => true): { values: ParamRecord; skipped: string[] } {
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

/** Override nilai kenop per slot (`slotKey` -> kunci -> nilai), mis. `cover.kicker.text` per jenis dokumen. */
export type SlotOverrides = Readonly<Record<string, ParamRecord>>;

/**
 * Kerangka berkenop: tiap slot = salinan definisi + kenop esensial lingkup slot dari nilai efektif preset
 * (`null` = tanpa kenop, mis. kerangka preset), lalu override per slot. Override wajib kunci dikenal, berlingkup
 * slot itu, dan bernilai sah; slot override wajib ada di kerangka.
 */
export function presetSlotEssentials(
  slots: ReadonlyArray<SlotShape>,
  presetEffective: ParamRecord | null,
  slotOverrides?: SlotOverrides,
): { slots: TemplateSlotDef[]; skipped: Record<string, string[]> } {
  const unknownSlots = Object.keys(slotOverrides ?? {}).filter((k) => !slots.some((s) => s.slotKey === k));
  if (unknownSlots.length > 0) throw new Error(`Override kenop untuk slot yang tidak ada di kerangka: ${unknownSlots.join(", ")}`);
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
        if (!def) throw new Error(`Override slot ${s.slotKey}: kunci ${key} tidak dikenal registri`);
        if (!isScopeAllowedInSlot(def.scope, s)) throw new Error(`Override slot ${s.slotKey}: kunci ${key} (lingkup ${def.scope}) di luar lingkup slot`);
        const bad = validateParamValue(def, value as ParamValue);
        if (bad !== null) throw new Error(`Override slot ${s.slotKey}: nilai ${key} tidak sah: ${bad}`);
      }
      essentials = { ...essentials, ...over };
    }
    return { ...s, admits: [...s.admits], tiers: [...s.tiers], essentials };
  });
  return { slots: out, skipped };
}

export async function latestVersionOf(tx: Tx, templateId: string, latestVersionNo: number): Promise<VersionRow> {
  return tx.studioTemplateVersion.findUniqueOrThrow({ where: { templateId_versionNo: { templateId, versionNo: latestVersionNo } } });
}

/** Versi templat berkerangka = rujukan versi preset + lapis esensial/lanjutan + kerangka; idempoten. */
export async function ensureSkeletonVersion(
  tx: Tx,
  p: {
    slug: string;
    name: string;
    description: string;
    preset: { slug: string; version: VersionRow };
    essentials: ParamRecord;
    advanced?: ParamRecord;
    roleFormats?: Record<string, unknown>;
    skeletonSlots: TemplateSlotDef[];
    changeNote: string;
    /**
     * DC-29: jenis kontrak C58 templat (dibuat dengan medan ini; templat yang ada wajib sama). `null` = templat
     * dokumen output (dibuat tanpa medan; templat yang ada wajib tanpa jenis kontrak); `undefined` = tidak dicek.
     */
    contractKind?: string | null;
    /**
     * C21: true = templat preset gaya (dibuat `isPreset`; templat yang ada wajib preset). Absen = perilaku lama
     * (dibuat non-preset, status preset templat yang ada tidak dicek).
     */
    isPreset?: boolean;
    /**
     * GF-08 (D-605 (1)): the COMPLETE own role formats of the version relative to its preset version (`{}` = none).
     * Given = the definition always carries `roleFormats` (an empty map included), so the service does not carry
     * the previous version's own roles over a new base (`services/templates/index.ts:948-951`), and the unchanged
     * check also compares own role formats. Absent = old behaviour (`roleFormats` above, not compared). Used by the
     * derived preset and derived template paths only; the Manual 000 import keeps `roleFormats`.
     */
    ownRoleFormats?: Record<string, unknown>;
  },
): Promise<{ outcome: "created" | "new-version" | "unchanged"; version: VersionRow; computedSkeletonSha256: string }> {
  if (p.ownRoleFormats !== undefined && p.roleFormats !== undefined) throw new Error(`Templat ${p.slug}: roleFormats dan ownRoleFormats tidak boleh dipakai bersama`);
  const definition: StudioTemplateV2 = {
    $schema: TEMPLATE_V2_SCHEMA_ID,
    preset: { slug: p.preset.slug, version: p.preset.version.versionNo },
    essentials: p.essentials,
    ...(p.advanced && Object.keys(p.advanced).length > 0 ? { advanced: p.advanced } : {}),
    ...(p.roleFormats && Object.keys(p.roleFormats).length > 0 ? { roleFormats: p.roleFormats as StudioTemplateV2["roleFormats"] } : {}),
    ...(p.ownRoleFormats !== undefined ? { roleFormats: p.ownRoleFormats as StudioTemplateV2["roleFormats"] } : {}),
    skeleton: { slots: p.skeletonSlots },
  };
  const baseRoles = asRecord(p.preset.version.roleFormats);
  const sameOwnRoles = (stored: unknown): boolean =>
    p.ownRoleFormats === undefined || stable(ownRolesOf(asRecord(stored), baseRoles)) === stable(ownRolesOf(p.ownRoleFormats, baseRoles));
  const wantSk = skeletonSha256(validateSkeleton({ slots: p.skeletonSlots }));
  const wantLayer = { ...p.essentials, ...(p.advanced ?? {}) };
  const t = await tx.studioTemplate.findUnique({ where: { slug: p.slug } });
  let outcome: "created" | "new-version" | "unchanged";
  if (!t) {
    await createTemplateV2InTx(
      tx,
      {
        slug: p.slug,
        name: p.name,
        kind: "DOCUMENT",
        description: p.description,
        changeNote: p.changeNote,
        template: definition,
        ...(p.contractKind ? { contractKind: p.contractKind } : {}),
        ...(p.isPreset ? { isPreset: true } : {}),
      },
      ADMIN_CALLER,
    );
    outcome = "created";
  } else {
    if (p.isPreset !== undefined && t.isPreset !== p.isPreset) {
      throw new Error(`Templat ${p.slug} ${t.isPreset ? "preset" : "non-preset"}, diharapkan ${p.isPreset ? "preset" : "non-preset"}; tidak diubah seed`);
    }
    if (p.contractKind !== undefined && (t.contractKind ?? null) !== p.contractKind) {
      throw new Error(`Templat ${p.slug} ber-contractKind ${String(t.contractKind)}, diharapkan ${String(p.contractKind)}; tidak diubah seed`);
    }
    const latest = await latestVersionOf(tx, t.id, t.latestVersionNo);
    if (
      latest.skeletonSha256 === wantSk &&
      latest.baseVersionId === p.preset.version.id &&
      stable(asRecord(latest.overrides)) === stable(wantLayer) &&
      sameOwnRoles(latest.roleFormats)
    ) {
      outcome = "unchanged";
    } else {
      await createTemplateVersionV2InTx(tx, t.id, { baseVersionNo: t.latestVersionNo, changeNote: p.changeNote, template: definition }, ADMIN_CALLER);
      outcome = "new-version";
    }
  }
  const t2 = await tx.studioTemplate.findUniqueOrThrow({ where: { slug: p.slug } });
  return { outcome, version: await latestVersionOf(tx, t2.id, t2.latestVersionNo), computedSkeletonSha256: wantSk };
}

// ── Templat turunan-preset (C-01, C-02, C-06) ─────────────────────────────

/** Satu baris tabel spec templat turunan preset. */
export interface DerivedTemplateSpec {
  slug: string;
  name: string;
  description: string;
  presetSlug: string;
  /** Kerangka register (kenop slot dibaca dari preset saat seed). */
  slots: ReadonlyArray<SlotShape>;
  /** Lapis templat (kunci doc.* bawaan jenis/bahasa, dsb.), di atas esensial global preset. */
  layer: ParamRecord;
  slotOverrides?: SlotOverrides;
  /** Jenis kontrak C58; `null` = templat dokumen output (CH-06 tetap dicek: slot `contractRecord` ditolak). */
  contractKind: string | null;
  /** Catatan perubahan versi baru (hanya dipakai bila versi ditulis). */
  changeNote: (c: { presetVersionNo: number; slotCount: number }) => string;
}

/** Rencana murni templat turunan dari nilai efektif preset (tanpa DB). */
export function derivedTemplatePlan(spec: DerivedTemplateSpec, presetEffective: ParamRecord) {
  const global = knobValues("global", presetEffective);
  const split = splitBySurface({ ...global.values, ...spec.layer });
  const skeleton = presetSlotEssentials(spec.slots, presetEffective, spec.slotOverrides);
  return {
    globalSkipped: global.skipped,
    split,
    slots: skeleton.slots,
    slotSkipped: skeleton.skipped,
    /** Lapis versi yang disimpan (`overrides`) = esensial + lanjutan. Sidik kerangka dihitung `ensureSkeletonVersion` (sesudah CH-06). */
    overrides: { ...split.essentials, ...split.advanced } as ParamRecord,
  };
}

export type DerivedStoredIssue = "contractKind" | "archived" | "restricted" | "baseVersionId" | "skeletonSha256" | "slots" | "layer" | "roleFormats";

/** Cek baris tersimpan generik (C-06 + AC-2). Kosong = sesuai spec. */
export function derivedTemplateStoredIssues(i: {
  template: { contractKind: string | null; archived: boolean };
  version: { skeletonSha256: string | null; baseVersionId: string | null; resolvedParams: unknown };
  computedSkeletonSha256: string;
  storedSlots: ReadonlyArray<{ slotKey: string; sectionTypeKey: string; position: number }>;
  specSlots: ReadonlyArray<{ slotKey: string; sectionType: string; position: number }>;
  layer: ParamRecord;
  contractKind: string | null;
  presetVersionId: string;
  /**
   * GF-08: stored role formats of the template version and of its preset version. Given = the template must have
   * no own role formats (it inherits the preset roles whole). Absent = not checked (old callers).
   */
  roleFormats?: { stored: unknown; preset: unknown };
}): DerivedStoredIssue[] {
  const issues: DerivedStoredIssue[] = [];
  const eff = asRecord(i.version.resolvedParams);
  if ((i.template.contractKind ?? null) !== (i.contractKind ?? null)) issues.push("contractKind");
  if (i.template.archived) issues.push("archived");
  if (templateRestriction(eff).restricted) issues.push("restricted");
  if (i.version.baseVersionId !== i.presetVersionId) issues.push("baseVersionId");
  if (i.version.skeletonSha256 !== i.computedSkeletonSha256) issues.push("skeletonSha256");
  if (stable(i.storedSlots.map((s) => [s.slotKey, s.sectionTypeKey, s.position])) !== stable(i.specSlots.map((s) => [s.slotKey, s.sectionType, s.position]))) issues.push("slots");
  if (stable(Object.fromEntries(Object.keys(i.layer).map((k) => [k, eff[k]]))) !== stable(i.layer)) issues.push("layer");
  if (i.roleFormats && Object.keys(ownRolesOf(asRecord(i.roleFormats.stored), asRecord(i.roleFormats.preset))).length > 0) issues.push("roleFormats");
  return issues;
}

export type DerivedTemplateReport = Record<string, unknown> & {
  slug: string;
  outcome: "created" | "new-version" | "unchanged";
  storedOk: boolean;
  storedIssues: DerivedStoredIssue[];
  contractKind: string | null;
  versionNo: number;
  ch06Issues: number;
};

/** Satu templat turunan preset lewat layanan templat v2 (CH-06 dicek untuk setiap spec); idempoten. */
export async function ensureDerivedTemplate(tx: Tx, spec: DerivedTemplateSpec): Promise<DerivedTemplateReport> {
  const pt = await tx.studioTemplate.findUnique({ where: { slug: spec.presetSlug } });
  if (!pt || !pt.isPreset) throw new Error(`Preset ${spec.presetSlug} tidak ada atau bukan preset; jalankan --presets-and-skeletons lebih dulu`);
  const presetVersion = await latestVersionOf(tx, pt.id, pt.latestVersionNo);
  const plan = derivedTemplatePlan(spec, asRecord(presetVersion.resolvedParams));
  // Pertahanan seed: CH-06 selalu dicek sebelum layanan (layanan juga menolak 400 SCHEMA_INVALID). Spec tanpa
  // contractKind yang memuat slot `contractRecord` gagal di sini; kerangka tanpa slot itu selalu lolos (S27).
  const ch06 = contractRecordSkeletonIssues(plan.slots, spec.contractKind);
  if (ch06.length > 0) throw new Error(`CH-06 ${spec.slug}: ${ch06.map((i) => `${i.pointer} ${i.message}`).join("; ")}`);
  const r = await ensureSkeletonVersion(tx, {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    preset: { slug: spec.presetSlug, version: presetVersion },
    essentials: plan.split.essentials,
    advanced: plan.split.advanced,
    skeletonSlots: plan.slots,
    changeNote: spec.changeNote({ presetVersionNo: presetVersion.versionNo, slotCount: plan.slots.length }),
    contractKind: spec.contractKind,
    // GF-08: a derived template has no own role formats; it inherits the preset roles whole (no stale carry).
    ownRoleFormats: {},
  });
  const t = await tx.studioTemplate.findUniqueOrThrow({ where: { slug: spec.slug } });
  const stored = await tx.studioTemplateSlot.findMany({
    where: { templateVersionId: r.version.id },
    orderBy: { position: "asc" },
    select: { slotKey: true, sectionTypeKey: true, position: true, required: true, repeatable: true, positionLocked: true, minItems: true, contentMode: true, tiers: true, admits: true },
  });
  const eff = asRecord(r.version.resolvedParams);
  const storedIssues = derivedTemplateStoredIssues({
    template: t,
    version: r.version,
    computedSkeletonSha256: r.computedSkeletonSha256,
    storedSlots: stored,
    specSlots: spec.slots,
    layer: spec.layer,
    contractKind: spec.contractKind,
    presetVersionId: presetVersion.id,
    roleFormats: { stored: r.version.roleFormats, preset: presetVersion.roleFormats },
  });
  return {
    slug: spec.slug,
    kind: spec.contractKind,
    outcome: r.outcome,
    storedOk: storedIssues.length === 0,
    storedIssues,
    contractKind: t.contractKind ?? null,
    templateKind: t.kind,
    versionNo: r.version.versionNo,
    baseVersionId: r.version.baseVersionId,
    preset: { slug: spec.presetSlug, versionNo: presetVersion.versionNo, versionId: presetVersion.id },
    paramsSha256: r.version.paramsSha256,
    skeletonSha256: r.version.skeletonSha256,
    skeletonShaMatchesSeed: r.version.skeletonSha256 === r.computedSkeletonSha256,
    layer: Object.fromEntries(Object.keys(spec.layer).map((k) => [k, eff[k] ?? null])),
    essentials: Object.keys(plan.split.essentials).length,
    advanced: Object.keys(plan.split.advanced),
    skippedKnobKeys: { global: plan.globalSkipped, slots: plan.slotSkipped },
    ch06Issues: ch06.length,
    slots: stored.map((s) => ({ ...s, admits: s.admits.length })),
  };
}

// ── Preset turunan (C21; research/35 §6 M2 (a)-(e)) ───────────────────────

/**
 * Satu baris tabel spec preset turunan: preset gaya baru = versi terbaru preset dasar + sematan. Pemanggil ADMIN,
 * jadi sematan boleh kunci turunan (hanya ADMIN pada preset, `services/skeleton/access.ts:235`). Preset dasar tidak
 * disentuh (penjaga runner: bukan sasaran).
 */
export interface DerivedPresetSpec {
  slug: string;
  name: string;
  description: string;
  /** Preset dasar; versinya = versi terbaru saat seed. */
  baseSlug: string;
  /** Kerangka preset (tanpa kenop, seperti kerangka preset `--presets-and-skeletons`). */
  slots: ReadonlyArray<SlotShape>;
  /** Lapis preset sendiri (override di atas preset dasar). */
  pins: ParamRecord;
  /**
   * GF-08: own role formats as attribute patches over the base preset's role formats (role -> sub-object -> attributes).
   * A patched sub-object = the base sub-object with these attributes replaced; every other attribute and every other
   * role stay the base's. Needed because a written role sub-object wins whole over the catalog `type.scale.*` sizes
   * (`engine/tokens/roles.ts`), so pins alone do not reach the printed runs. Absent = the preset has no own roles.
   */
  roleFormatOverrides?: Readonly<Record<string, RoleFormatPatch>>;
  changeNote: (c: { baseVersionNo: number; pinCount: number }) => string;
}

/** Attribute patch per role sub-object (`run`, `labelRun`, `para`, ...). */
export type RoleFormatPatch = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const isPlainRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * GF-08: own role formats of a derived preset (pure). For each role in `roleFormatOverrides`: the base role format
 * (from the base version's stored role formats) with each patched sub-object = base sub-object + patch attributes.
 * Errors: unknown role, role or sub-object missing in the base (a patched sub-object without its base attributes
 * would drop them, since a written sub-object is used whole), a role equal to the base after patching, or a patched
 * `szHalfPt` that differs from the catalog run size of that role at the preset values (base effective values + the spec pins;
 * `catalogRoleFormat`), so the role formats cannot disagree with the pins. No overrides = undefined.
 */
export function derivedPresetRoleFormats(
  spec: Pick<DerivedPresetSpec, "slug" | "pins" | "roleFormatOverrides">,
  baseRoleFormats: unknown,
  baseEffective: ParamRecord,
): Record<string, unknown> | undefined {
  const overrides = spec.roleFormatOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return undefined;
  const base = asRecord(baseRoleFormats);
  const presetEffective: ParamRecord = { ...baseEffective, ...spec.pins };
  const out: Record<string, unknown> = {};
  for (const [role, patch] of Object.entries(overrides)) {
    if (!(ROLE_KEYS as readonly string[]).includes(role)) throw new Error(`Format peran preset ${spec.slug}: peran ${role} tidak dikenal`);
    const baseRole = base[role];
    if (!isPlainRecord(baseRole)) throw new Error(`Format peran preset ${spec.slug}: peran ${role} tidak ada di preset dasar`);
    const catalog = catalogRoleFormat(presetEffective, role as RoleKey) as Record<string, unknown>;
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(baseRole)) as Record<string, unknown>;
    for (const [sub, attrs] of Object.entries(patch)) {
      const baseSub = baseRole[sub];
      if (!isPlainRecord(baseSub)) throw new Error(`Format peran preset ${spec.slug}: ${role}.${sub} tidak ada di preset dasar`);
      const want = asRecord(catalog[sub]).szHalfPt;
      if ("szHalfPt" in attrs && typeof want === "number" && attrs.szHalfPt !== want) {
        throw new Error(`Format peran preset ${spec.slug}: ${role}.${sub} szHalfPt ${String(attrs.szHalfPt)} berbeda dari ukuran katalog sematan ${want}`);
      }
      next[sub] = { ...baseSub, ...attrs };
    }
    if (stable(next) === stable(baseRole)) throw new Error(`Format peran preset ${spec.slug}: ${role} tanpa beda dari preset dasar`);
    out[role] = next;
  }
  return out;
}

/** Rencana murni preset turunan (tanpa DB): sematan divalidasi, lapis dipartisi, kerangka tanpa kenop. */
export function derivedPresetPlan(spec: DerivedPresetSpec): { split: { essentials: ParamRecord; advanced: ParamRecord }; slots: TemplateSlotDef[] } {
  if (spec.slug === spec.baseSlug) throw new Error(`Preset ${spec.slug} tidak boleh berbasis preset itu sendiri (basisnya sendiri)`);
  const keys = Object.keys(spec.pins);
  if (keys.length === 0) throw new Error(`Preset ${spec.slug} tanpa sematan; preset turunan tanpa beda tidak dibuat`);
  for (const key of keys) {
    const def = PARAMS_BY_KEY.get(key);
    if (!def) throw new Error(`Sematan preset ${spec.slug}: kunci ${key} tidak dikenal registri`);
    const bad = validateParamValue(def, spec.pins[key] as ParamValue);
    if (bad !== null) throw new Error(`Sematan preset ${spec.slug}: nilai ${key} tidak sah: ${bad}`);
  }
  return { split: splitBySurface(spec.pins), slots: presetSlotEssentials(spec.slots, null).slots };
}

export type DerivedPresetStoredIssue = "isPreset" | "archived" | "restricted" | "baseVersionId" | "skeletonSha256" | "pins" | "roleFormats";

/** Cek baris tersimpan preset turunan. Kosong = sesuai spec (sematan bertahan di nilai efektif tersimpan). */
export function derivedPresetStoredIssues(i: {
  template: { isPreset: boolean; archived: boolean };
  version: { skeletonSha256: string | null; baseVersionId: string | null; resolvedParams: unknown };
  computedSkeletonSha256: string;
  pins: ParamRecord;
  baseVersionId: string;
  /**
   * GF-08: stored role formats of the preset version and of its base version, and the planned own roles (`{}` =
   * none). Given = the stored own roles must equal the plan. Absent = not checked.
   */
  roleFormats?: { stored: unknown; base: unknown; planned: Record<string, unknown> };
}): DerivedPresetStoredIssue[] {
  const issues: DerivedPresetStoredIssue[] = [];
  const eff = asRecord(i.version.resolvedParams);
  if (!i.template.isPreset) issues.push("isPreset");
  if (i.template.archived) issues.push("archived");
  if (templateRestriction(eff).restricted) issues.push("restricted");
  if (i.version.baseVersionId !== i.baseVersionId) issues.push("baseVersionId");
  if (i.version.skeletonSha256 !== i.computedSkeletonSha256) issues.push("skeletonSha256");
  if (stable(Object.fromEntries(Object.keys(i.pins).map((k) => [k, eff[k]]))) !== stable(i.pins)) issues.push("pins");
  if (i.roleFormats && stable(ownRolesOf(asRecord(i.roleFormats.stored), asRecord(i.roleFormats.base))) !== stable(i.roleFormats.planned)) issues.push("roleFormats");
  return issues;
}

export type DerivedPresetReport = Record<string, unknown> & {
  slug: string;
  outcome: "created" | "new-version" | "unchanged";
  storedOk: boolean;
  storedIssues: DerivedPresetStoredIssue[];
  versionNo: number;
  base: { slug: string; versionNo: number; versionId: string };
  /** Nilai efektif tersimpan kunci sematan. */
  pins: ParamRecord;
  /** Nilai efektif kunci yang sama di versi preset dasar (bukti beda). */
  basePins: ParamRecord;
};

/** Satu preset turunan lewat layanan templat v2, pemanggil ADMIN, basis = versi terbaru preset dasar; idempoten. */
export async function ensureDerivedPreset(tx: Tx, spec: DerivedPresetSpec): Promise<DerivedPresetReport> {
  const plan = derivedPresetPlan(spec);
  const bt = await tx.studioTemplate.findUnique({ where: { slug: spec.baseSlug } });
  if (!bt || !bt.isPreset) throw new Error(`Preset dasar ${spec.baseSlug} tidak ada atau bukan preset; jalankan --presets-and-skeletons lebih dulu`);
  const baseVersion = await latestVersionOf(tx, bt.id, bt.latestVersionNo);
  const ownRoles = derivedPresetRoleFormats(spec, baseVersion.roleFormats, asRecord(baseVersion.resolvedParams)) ?? {};
  const r = await ensureSkeletonVersion(tx, {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    preset: { slug: spec.baseSlug, version: baseVersion },
    essentials: plan.split.essentials,
    advanced: plan.split.advanced,
    skeletonSlots: plan.slots,
    changeNote: spec.changeNote({ baseVersionNo: baseVersion.versionNo, pinCount: Object.keys(spec.pins).length }),
    isPreset: true,
    ownRoleFormats: ownRoles,
  });
  const t = await tx.studioTemplate.findUniqueOrThrow({ where: { slug: spec.slug } });
  const storedIssues = derivedPresetStoredIssues({
    template: t,
    version: r.version,
    computedSkeletonSha256: r.computedSkeletonSha256,
    pins: spec.pins,
    baseVersionId: baseVersion.id,
    roleFormats: { stored: r.version.roleFormats, base: baseVersion.roleFormats, planned: ownRoles },
  });
  const pick = (v: unknown) => Object.fromEntries(Object.keys(spec.pins).map((k) => [k, asRecord(v)[k] ?? null])) as ParamRecord;
  return {
    slug: spec.slug,
    outcome: r.outcome,
    storedOk: storedIssues.length === 0,
    storedIssues,
    isPreset: t.isPreset,
    versionNo: r.version.versionNo,
    base: { slug: spec.baseSlug, versionNo: baseVersion.versionNo, versionId: baseVersion.id },
    baseVersionId: r.version.baseVersionId,
    paramsSha256: r.version.paramsSha256,
    skeletonSha256: r.version.skeletonSha256,
    skeletonShaMatchesSeed: r.version.skeletonSha256 === r.computedSkeletonSha256,
    pins: pick(r.version.resolvedParams),
    basePins: pick(baseVersion.resolvedParams),
    layer: { essentials: Object.keys(plan.split.essentials), advanced: Object.keys(plan.split.advanced) },
    roleFormatOverrides: Object.keys(ownRoles).sort(),
    // Evidence: run sizes (w:sz half-points) of the overridden roles, stored vs base, per sub-object.
    roleSizes: Object.fromEntries(
      Object.keys(ownRoles)
        .sort()
        .map((role) => {
          const sizes = (v: unknown) => Object.fromEntries(Object.entries(asRecord(asRecord(v)[role])).filter(([, x]) => isPlainRecord(x) && "szHalfPt" in x).map(([sub, x]) => [sub, asRecord(x).szHalfPt]));
          return [role, { stored: sizes(r.version.roleFormats), base: sizes(baseVersion.roleFormats) }];
        }),
    ),
  };
}

// ── Runner transaksi berpenjaga (C-04) ────────────────────────────────────

interface TemplateSnapshotRow {
  slug: string;
  latestVersionNo: number;
  updatedAt: Date;
  contractKind: string | null;
  versions: bigint;
  paramsSha256: string | null;
  skeletonSha256: string | null;
}

/** Sidik templat selain sasaran: penjaga "templat lama tidak berubah" (§6.3). */
export async function snapshotTemplates(db: Tx, exclude: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const rows = await db.$queryRaw<TemplateSnapshotRow[]>`
    select t.slug, t."latestVersionNo", t."updatedAt", t."contractKind",
           (select count(*) from "StudioTemplateVersion" y where y."templateId" = t.id) as versions,
           v."paramsSha256", v."skeletonSha256"
    from "StudioTemplate" t left join "StudioTemplateVersion" v on v."templateId" = t.id and v."versionNo" = t."latestVersionNo"
    where t.slug <> all(${[...exclude]}::text[])
    order by t.slug`;
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString(), versions: Number(r.versions) }));
}

/** DB transaksi wajib sama dengan DB yang sudah diperiksa penjaga izin pemanggil. */
export async function assertTxDatabase(tx: Tx, db: string): Promise<void> {
  const current = (await tx.$queryRaw<{ db: string }[]>`select current_database() as db`)[0]?.db;
  if (current !== db) throw new Error(`DB transaksi '${current}' berbeda dari DB yang diperiksa '${db}'`);
}

export interface SectionTypeSeedResult {
  registry: number;
  created: string[];
  updated: string[];
  unchanged: number;
}

export interface GuardedTemplateTxOptions {
  /** Pesan log laporan (mis. "Templat jenis kontrak"). */
  label: string;
  guardFailMessage: string;
  dryRunDoneMessage: string;
  /** DB yang sudah lolos penjaga izin pemanggil. */
  database: string;
  dryRun: boolean;
  /** Tabel spec; tiap baris satu templat sasaran. */
  specs: readonly DerivedTemplateSpec[];
  build?: (tx: Tx, spec: DerivedTemplateSpec) => Promise<DerivedTemplateReport>;
  /**
   * C21: tabel spec preset turunan; tiap baris satu preset sasaran, ditulis di transaksi yang sama SEBELUM templat
   * (templat dapat merujuk preset itu). Slug preset ikut sasaran penjaga; preset dasarnya bukan sasaran, jadi wajib
   * tidak berubah.
   */
  presets?: readonly DerivedPresetSpec[];
  buildPreset?: (tx: Tx, spec: DerivedPresetSpec) => Promise<DerivedPresetReport>;
  /**
   * true = section type wajib tidak tersentuh sama sekali (tanpa create/update; penjaga gagal bila registri dan DB
   * berbeda). false/absen = section type yang tersentuh wajib = yang ditulis seed (jalur kontrak, perilaku S09).
   */
  freezeSectionTypes?: boolean;
  /** Hitungan bukti di akhir transaksi. */
  counts: (tx: Tx) => Promise<Record<string, number>>;
  timeoutMs?: number;
}

export interface GuardedTemplateTxSummary {
  sectionTypes: { create: string[]; update: string[]; unchanged: number };
  templates: Array<{ slug: string; outcome: string; versionNo: number; contractKind: string | null }>;
  /** Hanya bila opsi `presets` tidak kosong. */
  presets?: Array<{ slug: string; outcome: string; versionNo: number; base: { slug: string; versionNo: number } }>;
  counts: Record<string, number>;
  guardOk: boolean;
}

/**
 * Tabel spec dalam SATU transaksi; penjaga: templat selain sasaran (preset turunan + templat tabel) tidak berubah
 * dan tidak bertambah, section type yang tersentuh = yang ditulis seed, setiap sasaran `storedOk`. Gagal = galat
 * (rollback). `dryRun` = rollback lewat `DryRunRollback` setelah laporan dan penjaga dihitung (0 tulis ter-commit).
 */
export async function runGuardedTemplateTx(
  client: Pick<PrismaClient, "$transaction">,
  opts: GuardedTemplateTxOptions,
  deps: { log: SeedLog; seedSectionTypes: (tx: Tx) => Promise<SectionTypeSeedResult> },
): Promise<GuardedTemplateTxSummary> {
  const presetSpecs = opts.presets ?? [];
  const targets = [...presetSpecs.map((s) => s.slug), ...opts.specs.map((s) => s.slug)];
  const duplicate = targets.filter((s, i) => targets.indexOf(s) !== i);
  if (duplicate.length > 0) throw new Error(`Slug sasaran ganda di tabel spec: ${[...new Set(duplicate)].join(", ")}`);
  const build = opts.build ?? ensureDerivedTemplate;
  const buildPreset = opts.buildPreset ?? ensureDerivedPreset;
  try {
    return await client.$transaction(
      async (tx) => {
        await assertTxDatabase(tx, opts.database);
        const beforeTemplates = await snapshotTemplates(tx, targets);
        const beforeSections = new Map((await tx.studioSectionType.findMany({ select: { key: true, updatedAt: true } })).map((r) => [r.key, r.updatedAt.toISOString()]));
        // FK slot -> section type: baris section type wajib ada di transaksi yang sama (dry-run: ikut di-rollback).
        const sectionTypes = await deps.seedSectionTypes(tx);
        // Preset turunan lebih dulu: templat tabel boleh merujuknya di transaksi yang sama.
        const presets: DerivedPresetReport[] = [];
        for (const spec of presetSpecs) presets.push(await buildPreset(tx, spec));
        const templates: DerivedTemplateReport[] = [];
        for (const spec of opts.specs) templates.push(await build(tx, spec));
        const afterTemplates = await snapshotTemplates(tx, targets);
        const afterByslug = new Map(afterTemplates.map((r) => [String(r.slug), r]));
        const changedTemplates = beforeTemplates.filter((b) => stable(b) !== stable(afterByslug.get(String(b.slug)) ?? null)).map((b) => String(b.slug));
        const addedTemplates = afterTemplates.filter((a) => !beforeTemplates.some((b) => b.slug === a.slug)).map((a) => String(a.slug));
        const afterSections = await tx.studioSectionType.findMany({ select: { key: true, updatedAt: true } });
        const sectionTypesTouched = afterSections.filter((r) => beforeSections.has(r.key) && beforeSections.get(r.key) !== r.updatedAt.toISOString()).map((r) => r.key);
        const counts = await opts.counts(tx);
        const guard = {
          ok:
            changedTemplates.length === 0 &&
            addedTemplates.length === 0 &&
            stable([...sectionTypesTouched].sort()) === stable([...sectionTypes.updated].sort()) &&
            (opts.freezeSectionTypes !== true || (sectionTypes.created.length === 0 && sectionTypes.updated.length === 0 && sectionTypesTouched.length === 0)) &&
            templates.every((t) => t.storedOk === true) &&
            presets.every((p) => p.storedOk === true),
          targets,
          otherTemplates: beforeTemplates.length,
          changedTemplates,
          addedTemplates,
          sectionTypesTouched,
          otherTemplatesBefore: beforeTemplates,
        };
        deps.log(guard.ok ? "info" : "error", opts.label, {
          database: opts.database,
          dryRun: opts.dryRun,
          sectionTypes,
          ...(presets.length > 0 ? { presets } : {}),
          templates,
          counts,
          guard,
        });
        if (!guard.ok) throw new Error(opts.guardFailMessage);
        const summary: GuardedTemplateTxSummary = {
          sectionTypes: { create: sectionTypes.created, update: sectionTypes.updated, unchanged: sectionTypes.unchanged },
          templates: templates.map((t) => ({ slug: t.slug, outcome: t.outcome, versionNo: t.versionNo, contractKind: t.contractKind })),
          ...(presets.length > 0
            ? { presets: presets.map((p) => ({ slug: p.slug, outcome: p.outcome, versionNo: p.versionNo, base: { slug: p.base.slug, versionNo: p.base.versionNo } })) }
            : {}),
          counts,
          guardOk: guard.ok,
        };
        if (opts.dryRun) throw new DryRunRollback(summary);
        return summary;
      },
      { timeout: opts.timeoutMs ?? PRESET_TX_TIMEOUT_MS, maxWait: 10_000 },
    );
  } catch (err) {
    if (err instanceof DryRunRollback) {
      deps.log("info", opts.dryRunDoneMessage, { database: opts.database, plan: err.report });
      return err.report as GuardedTemplateTxSummary;
    }
    throw err;
  }
}
