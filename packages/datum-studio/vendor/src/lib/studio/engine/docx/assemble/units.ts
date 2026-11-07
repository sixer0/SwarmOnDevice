/**
 * Perencanaan unit perakit DOCX (KS-06: satu seksi Word per unit), v1 dan v2.
 *
 * v1 (`studio.norm/v1`, 01_specs.md §3.9): validasi unit/blok dan pengelompokan
 * blok per unit dalam urutan `ordinal`; urutan unit = urutan snapshot. TIDAK
 * berubah oleh SR-16.
 *
 * v2 (`studio.norm/v2`, register 03_structural_sections_specs §4.6, blueprint
 * 05 §2.9; SR-16): pengelompokan yang sama ditambah kesadaran slot:
 * - setiap unit merujuk slot kerangka aktif (`slotKey`), urutan = posisi slot
 *   (stabil di dalam slot);
 * - slot AUTO/MIXED sampul, lembar kendali, daftar isi tanpa blok struktural
 *   mendapat blok sintetis (`mode: "auto"`; daftar isi memakai mode efektif
 *   `render.toc.mode` slot, D-165 KT-11);
 * - slot wajib kosong (state `EMPTY`, atau unit `placeholder`) menjadi unit
 *   placeholder pada render draf; pada render non-draf = BY_CONSTRUCTION_FAILED;
 * - penempatan tanda tangan dari kenop slot `slot.placement` (R-42):
 *   `inControlSheet` = tanda tangan dirender di dalam unit lembar kendali (unit
 *   dan blok `signatureBlock` slot itu tidak ditempatkan terpisah);
 *   `standalone` (atau tanpa lembar kendali) = unit sendiri, lembar kendali
 *   tidak memuat tanda tangan.
 * Penyaringan lingkup (`scopePlans`) dijalankan perakit SESUDAH penomoran
 * seluruh dokumen (blueprint 05 §2.9: penomoran dari seluruh dokumen lalu filter).
 */
import type {
  AnyNormSnapshot,
  NormBlock,
  NormDocSnapshot,
  NormDocSnapshotV2,
  NormSlotV2,
  NormUnit,
  NormUnitKind,
  ParamMap,
  ParamValue,
  RenderLogEntry,
  RenderScope,
  ResolvedSlot,
  SignatureBlock,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { emptyOptionalUnitOmitted, expandRuleIndexMarker, isRuleIndexAutoMarker, PARAM_RULE_INDEX_FROM_MARKERS } from "../../front/rule-index";
import { backCoverPlaced } from "../wrapper/pages";

export interface UnitPlan {
  unit: NormUnit;
  blocks: NormBlock[];
  /** v2: kunci slot kerangka unit. */
  slotKey?: string;
  /** v2: jenis section slot. */
  sectionType?: string;
  /** v2: unit pengganti slot wajib kosong (render draf); dirender sebagai `placeholderText`. */
  placeholder?: boolean;
  /** v2: teks placeholder unit ini (`placeholder`; isi blok `slotPlaceholder`). */
  placeholderText?: string;
  /**
   * v2, unit lembar kendali: tanda tangan untuk `doc.front.signature` konteks
   * unit ini. Objek = tetapkan (inControlSheet), `null` = keluarkan
   * (standalone), absen = tidak diubah.
   */
  signature?: SignatureBlock | null;
  /** v2, unit lembar kendali: slot tanda tangan yang dirender di dalamnya (`inControlSheet`). */
  signatureSlotKey?: string;
}

export interface PlanUnitsOptions {
  /** Render draf (placeholder slot kosong diizinkan). */
  draft?: boolean;
  /** Nilai efektif per slot (RenderContext.slots). */
  slots?: ReadonlyMap<string, ResolvedSlot>;
  /** Parameter dokumen (cadangan bila slot tanpa nilai efektif). */
  params?: ParamMap;
  /** Lingkup render: unit sintetis hanya untuk slot di dalam lingkup (CHAPTER = tidak ada). */
  scope?: RenderScope;
  log?: (e: RenderLogEntry) => void;
}

/** Kenop penempatan tanda tangan (R-42). */
export const PARAM_SLOT_PLACEMENT = "slot.placement";
/** Teks placeholder slot kosong (R-43). */
export const PARAM_SLOT_PLACEHOLDER_TEXT = "slot.placeholderText";
/** Mode daftar isi (R-22). */
export const PARAM_TOC_MODE = "render.toc.mode";

/** Jenis section yang dapat dibangkitkan otomatis tanpa isi (AUTO/MIXED). */
const AUTO_SECTION_TYPES: ReadonlySet<string> = new Set(["cover", "controlSheet", "toc"]);

const KIND_OF_SECTION: Readonly<Record<string, NormUnitKind>> = {
  cover: "cover",
  controlSheet: "controlSheet",
  toc: "toc",
  chapter: "chapter",
  appendix: "appendix",
};

function fail(message: string, details?: unknown): never {
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", message, details);
}

/** Validasi dan pengelompokan blok per unit (aturan v1, dipakai v1 dan v2). */
function groupBlocks(units: readonly NormUnit[], blocks: readonly NormBlock[], allowNoUnits: boolean): Map<string, UnitPlan> {
  if (units.length === 0 && !allowNoUnits) fail("snapshot tanpa unit: minimal satu seksi");
  const plans = new Map<string, UnitPlan>();
  for (const unit of units) {
    if (typeof unit.key !== "string" || unit.key === "") fail(`unit ${unit.kind} tanpa key`);
    if (plans.has(unit.key)) fail(`kunci unit ganda: ${unit.key}`);
    plans.set(unit.key, { unit, blocks: [] });
  }

  const ordinals = new Set<number>();
  const ids = new Set<string>();
  for (const b of blocks) {
    if (!Number.isInteger(b.ordinal)) fail(`ordinal blok tidak bulat: ${b.blockId}`, { blockId: b.blockId });
    if (ordinals.has(b.ordinal)) fail(`ordinal blok ganda: ${b.ordinal}`, { blockId: b.blockId });
    ordinals.add(b.ordinal);
    if (typeof b.blockId !== "string" || b.blockId === "") fail(`blok ordinal ${b.ordinal} tanpa blockId`);
    if (ids.has(b.blockId)) fail(`blockId ganda: ${b.blockId}`);
    ids.add(b.blockId);
    const plan = plans.get(b.unitKey);
    if (!plan) fail(`blok ${b.blockId} merujuk unit tidak dikenal: ${b.unitKey}`, { blockId: b.blockId, address: b.address });
    if (typeof b.type !== "string" || b.type === "") fail(`blok ${b.blockId} tanpa type`, { blockId: b.blockId });
    plan.blocks.push(b);
  }
  for (const plan of plans.values()) plan.blocks.sort((a, b) => a.ordinal - b.ordinal);
  return plans;
}

/**
 * Kelompokkan blok per unit. Melempar BY_CONSTRUCTION_FAILED bila snapshot
 * tidak konsisten: tanpa unit, kunci unit ganda, ordinal ganda/tidak bulat,
 * blok merujuk unit yang tidak ada, atau blockId ganda; v2 juga unit merujuk
 * slot tidak dikenal/tidak aktif dan slot wajib kosong pada render non-draf.
 */
export function planUnits(snapshot: NormDocSnapshot | AnyNormSnapshot, opts: PlanUnitsOptions = {}): UnitPlan[] {
  const s = snapshot as AnyNormSnapshot | undefined;
  if (s?.schema === "studio.norm/v2") return planUnitsV2(s, opts);
  if (!s || s.schema !== "studio.norm/v1") {
    fail(`snapshot bukan studio.norm/v1 atau studio.norm/v2 (${String((s as { schema?: unknown } | undefined)?.schema)})`);
  }
  const units = s.units ?? [];
  const plans = groupBlocks(units, s.blocks ?? [], false);
  // Urutan unit = urutan snapshot.units (urutan dokumen).
  return units.map((u) => plans.get(u.key) as UnitPlan);
}

/** Nilai parameter efektif slot, cadangan parameter dokumen. */
function slotParam(opts: PlanUnitsOptions, slotKey: string, key: string): ParamValue | undefined {
  const fromSlot = opts.slots?.get(slotKey)?.params[key];
  return fromSlot !== undefined ? fromSlot : opts.params?.[key];
}

/** Teks placeholder slot: `ResolvedSlot.placeholderText`, selain itu R-43 dengan `{label}` diganti. */
export function placeholderTextFor(opts: PlanUnitsOptions, slot: Pick<NormSlotV2, "slotKey" | "label">): string {
  const resolved = opts.slots?.get(slot.slotKey)?.placeholderText;
  if (typeof resolved === "string" && resolved.trim() !== "") return resolved;
  const pattern = slotParam(opts, slot.slotKey, PARAM_SLOT_PLACEHOLDER_TEXT);
  return typeof pattern === "string" && pattern.trim() !== "" ? pattern.split("{label}").join(slot.label) : slot.label;
}

/** Mode daftar isi efektif slot (R-22); `undefined` bila param tidak sah. */
export function tocModeFor(opts: PlanUnitsOptions, slotKey: string): "field" | "static" | undefined {
  const v = slotParam(opts, slotKey, PARAM_TOC_MODE);
  return v === "field" || v === "static" ? v : undefined;
}

function syntheticUnit(slot: NormSlotV2, taken: ReadonlySet<string>): NormUnit & { slotKey: string; sectionType: string } {
  let key = `F:${slot.slotKey}`;
  for (let i = 2; taken.has(key); i += 1) key = `F:${slot.slotKey}#${i}`;
  return {
    kind: KIND_OF_SECTION[slot.sectionType] ?? "slot",
    key,
    slotKey: slot.slotKey,
    sectionType: slot.sectionType,
    setup: { header: { mode: "inherit" }, footer: { mode: "inherit" } },
  };
}

function syntheticBlock(unitKey: string, slotKey: string, type: string, content: unknown, seq: number): NormBlock {
  return {
    blockId: `${slotKey}:${type}:auto:${seq}`,
    address: `F:${slotKey}`,
    ordinal: -1 - seq,
    unitKey,
    type,
    content,
    textPlain: "",
    contentSha256: "",
  };
}

function planUnitsV2(s: NormDocSnapshotV2, opts: PlanUnitsOptions): UnitPlan[] {
  const skeleton = s.skeleton;
  if (!skeleton || !Array.isArray(skeleton.slots)) fail("snapshot studio.norm/v2 tanpa kerangka (skeleton.slots)");
  const slotByKey = new Map(skeleton.slots.map((sl) => [sl.slotKey, sl] as const));
  const units = s.units ?? [];
  for (const u of units) {
    const sl = slotByKey.get(u.slotKey);
    if (!sl) fail(`unit ${u.key} merujuk slot tidak dikenal: ${String(u.slotKey)}`, { unitKey: u.key });
    if (!sl.active || sl.omitted) fail(`unit ${u.key} merujuk slot tidak aktif: ${sl.slotKey}`, { unitKey: u.key });
  }
  const grouped = groupBlocks(units, s.blocks ?? [], true);
  const plans: UnitPlan[] = units.map((u) => ({
    ...(grouped.get(u.key) as UnitPlan),
    slotKey: u.slotKey,
    sectionType: u.sectionType,
    placeholder: u.placeholder === true || undefined,
  }));
  const taken = new Set(units.map((u) => u.key));
  const draft = opts.draft === true;
  let seq = 0;

  const activeSlots = skeleton.slots.filter((sl) => sl.active && !sl.omitted).sort((a, b) => a.position - b.position);

  const markPlaceholder = (p: UnitPlan, sl: NormSlotV2): void => {
    if (!draft) {
      fail(`slot wajib "${sl.slotKey}" kosong pada render non-draf (dokumen belum lengkap)`, { slotKey: sl.slotKey });
    }
    // Blok `slotPlaceholder` compose (SR-08) dipertahankan; selain itu dibuat dengan teks slot (R-43).
    const existing = p.blocks.find((b) => b.type === "slotPlaceholder");
    const text = (existing?.content as { text?: unknown } | undefined)?.text;
    p.placeholder = true;
    p.placeholderText = typeof text === "string" ? text : placeholderTextFor(opts, sl);
    p.blocks = [existing ?? syntheticBlock(p.unit.key, sl.slotKey, "slotPlaceholder", { text: p.placeholderText }, seq++)];
    // Placeholder bab/lampiran tidak boleh ikut penomoran/kunci bab (resolveChapterKeys).
    if (p.unit.kind === "chapter" || p.unit.kind === "appendix") p.unit = { ...p.unit, kind: "slot" };
  };

  // Slot di dalam lingkup: unit sintetis (placeholder/otomatis/tanda tangan) hanya
  // dibuat untuk slot ini; snapshot boleh sudah disaring hulu (SR-15 applyRenderScope).
  const scope = opts.scope;
  const inScope = (sl: NormSlotV2): boolean =>
    !scope || scope.kind === "DOCUMENT" ? true : scope.kind === "SLOT" ? scope.key === sl.slotKey : false;

  // (a) Slot aktif tanpa unit: placeholder (wajib kosong, draf) atau unit otomatis (AUTO_READY).
  for (const sl of activeSlots) {
    if (sl.sectionType === "signatureBlock" || !inScope(sl)) continue; // tanda tangan: (c)
    if (plans.some((p) => p.slotKey === sl.slotKey)) continue;
    if (sl.required && sl.state === "EMPTY") {
      const unit = syntheticUnit(sl, taken);
      taken.add(unit.key);
      const p: UnitPlan = { unit, blocks: [], slotKey: sl.slotKey, sectionType: sl.sectionType };
      markPlaceholder(p, sl);
      plans.push(p);
    } else if (sl.state === "AUTO_READY" && AUTO_SECTION_TYPES.has(sl.sectionType)) {
      const unit = syntheticUnit(sl, taken);
      taken.add(unit.key);
      plans.push({ unit, blocks: [], slotKey: sl.slotKey, sectionType: sl.sectionType });
    }
  }

  // (b) Unit placeholder dan blok struktural otomatis.
  for (const p of plans) {
    const sl = slotByKey.get(p.slotKey as string) as NormSlotV2;
    if (sl.sectionType === "signatureBlock") continue;
    const inputEmpty = p.blocks.length === 0 && sl.contentMode === "INPUT";
    if (p.placeholder || inputEmpty) {
      markPlaceholder(p, sl);
      continue;
    }
    if (AUTO_SECTION_TYPES.has(sl.sectionType) && !p.blocks.some((b) => b.type === sl.sectionType)) {
      const content = sl.sectionType === "toc" ? { mode: tocModeFor(opts, sl.slotKey) ?? "field" } : { mode: "auto" };
      p.blocks.unshift(syntheticBlock(p.unit.key, sl.slotKey, sl.sectionType, content, seq++));
    }
  }

  // (c) Penempatan tanda tangan dari kenop slot.
  for (const sl of activeSlots.filter((x) => x.sectionType === "signatureBlock")) {
    const placement = slotParam(opts, sl.slotKey, PARAM_SLOT_PLACEMENT) === "standalone" ? "standalone" : "inControlSheet";
    const ctrl = plans.find((p) => p.sectionType === "controlSheet" && !p.placeholder);
    const ownsBlock = (p: UnitPlan, b: NormBlock): boolean =>
      b.type === "signatureBlock" && ((b as NormBlock & { slotKey?: string }).slotKey === sl.slotKey || p.slotKey === sl.slotKey);
    const sigBlocks: NormBlock[] = [];
    for (const p of plans) for (const b of p.blocks) if (ownsBlock(p, b)) sigBlocks.push(b);
    const content = (sigBlocks[0]?.content as SignatureBlock | undefined) ?? s.doc.front?.signature;
    const empty = !content;

    // Unit placeholder tanda tangan dari compose (draf) dipertahankan apa adanya.
    if (plans.some((p) => p.slotKey === sl.slotKey && p.placeholder)) {
      if (ctrl) ctrl.signature = null;
      continue;
    }

    if (!inScope(sl)) {
      // Di luar lingkup (mis. render slot lembar kendali): hanya efek penempatan pada lembar kendali.
      for (const p of plans) p.blocks = p.blocks.filter((b) => !ownsBlock(p, b));
      if (ctrl) {
        ctrl.signature = placement === "inControlSheet" ? (content ?? null) : null;
        if (placement === "inControlSheet") ctrl.signatureSlotKey = sl.slotKey;
      }
      continue;
    }

    if (placement === "inControlSheet" && ctrl) {
      for (const p of plans) p.blocks = p.blocks.filter((b) => !ownsBlock(p, b));
      for (let i = plans.length - 1; i >= 0; i -= 1) if (plans[i].slotKey === sl.slotKey) plans.splice(i, 1);
      ctrl.signatureSlotKey = sl.slotKey;
      if (content) ctrl.signature = content;
      else if (sl.required && draft) {
        ctrl.signature = null;
        ctrl.blocks.push(syntheticBlock(ctrl.unit.key, sl.slotKey, "slotPlaceholder", { text: placeholderTextFor(opts, sl) }, seq++));
      }
      else if (sl.required) fail(`slot wajib "${sl.slotKey}" kosong pada render non-draf (dokumen belum lengkap)`, { slotKey: sl.slotKey });
      opts.log?.({
        level: "info",
        code: "SIGNATURE_IN_CONTROL_SHEET",
        address: `F:${sl.slotKey}`,
        message: `Tanda tangan slot ${sl.slotKey} dirender di dalam lembar kendali (slot.placement = inControlSheet)`,
      });
      continue;
    }

    if (placement === "inControlSheet") {
      opts.log?.({
        level: "info",
        code: "SIGNATURE_STANDALONE_FALLBACK",
        address: `F:${sl.slotKey}`,
        message: `Lembar kendali tidak ada di rencana unit; tanda tangan slot ${sl.slotKey} dirender sebagai seksi sendiri`,
      });
    }
    if (ctrl) ctrl.signature = null;
    let own = plans.find((p) => p.slotKey === sl.slotKey);
    if (!own) {
      if (empty && !sl.required) continue;
      const unit = syntheticUnit(sl, taken);
      taken.add(unit.key);
      own = { unit, blocks: [], slotKey: sl.slotKey, sectionType: sl.sectionType };
      // Sisipkan sesudah lembar kendali bila ada, selain itu urutan posisi (d).
      const at = ctrl ? plans.indexOf(ctrl) + 1 : plans.length;
      plans.splice(at, 0, own);
    }
    const target = own;
    for (const p of plans) {
      if (p === target) continue;
      const moved = p.blocks.filter((b) => ownsBlock(p, b));
      if (moved.length === 0) continue;
      p.blocks = p.blocks.filter((b) => !ownsBlock(p, b));
      target.blocks.push(...moved.map((b) => ({ ...b, unitKey: target.unit.key })));
    }
    if (target.blocks.length === 0) {
      if (content) target.blocks.push(syntheticBlock(target.unit.key, sl.slotKey, "signatureBlock", content, seq++));
      else markPlaceholder(target, sl);
    } else {
      target.blocks.sort((a, b) => a.ordinal - b.ordinal);
    }
  }

  // (c1) C17 / ST-01 (research/37, R-77 opt-in): penanda `ruleIndex` AUTO diganti judul + tabel
  // indeks dari penanda kode di isi (pembangun bersama dengan HTML). 0 entri: penanda dibiarkan
  // agar (c2) menghilangkan slot opsional seperti hari ini; baris kosong hanya bila unit dipaksa.
  for (const p of plans) {
    const sl = slotByKey.get(p.slotKey as string);
    if (!sl || p.placeholder || slotParam(opts, sl.slotKey, PARAM_RULE_INDEX_FROM_MARKERS) !== true) continue;
    const at = p.blocks.findIndex(isRuleIndexAutoMarker);
    if (at < 0) continue;
    const omitted = emptyOptionalUnitOmitted(sl, p.blocks, { scoped: scope?.kind === "SLOT" && scope.key === sl.slotKey });
    const x = expandRuleIndexMarker(p.blocks[at], s, { forced: !omitted });
    for (const e of x.log) opts.log?.(e);
    if (x.blocks) p.blocks.splice(at, 1, ...x.blocks);
  }

  // (c2) D-299 (FIX-SERAH, SR-50 N-SR50-1): slot opsional tanpa isi tidak memancarkan
  // seksi (halaman kosong). `ruleIndex` v2 = penanda `mode: "auto"` tanpa entri (indeks
  // aturan otomatis belum dibangun), menggantikan penerimaan sementara D-197. Slot wajib
  // dan render lingkup slot itu sendiri tetap dirender.
  for (let i = plans.length - 1; i >= 0; i -= 1) {
    const p = plans[i];
    const sl = slotByKey.get(p.slotKey as string);
    if (!sl || p.placeholder) continue;
    if (!emptyOptionalUnitOmitted(sl, p.blocks, { scoped: scope?.kind === "SLOT" && scope.key === sl.slotKey })) continue;
    plans.splice(i, 1);
    opts.log?.({
      level: "info",
      code: "OPTIONAL_SLOT_EMPTY_OMITTED",
      address: `F:${sl.slotKey}`,
      message: `Slot opsional ${sl.slotKey} (${sl.sectionType}) tanpa isi tidak dirender sebagai seksi (D-299)`,
    });
  }

  // (c3) C12 / CV-19 (opt-in `device.spine.placements` berisi "sampul belakang"): unit terakhir
  // `F:backCover` jenis `cover` (kepala/kaki kosong: tanpa PAGE/register) dengan satu blok `backCover`,
  // hanya pada render DOCUMENT dan bila rencana memuat unit sampul (tanpa sampul, mis. NOTA = tanpa
  // halaman belakang). Unit tanpa slot terurut terakhir di (d). Absen = rencana tidak berubah.
  const documentScope = !scope || scope.kind === "DOCUMENT";
  if (documentScope && opts.params && backCoverPlaced(opts.params) && plans.some((p) => p.unit.kind === "cover" && !p.placeholder)) {
    let key = "F:backCover";
    for (let i = 2; taken.has(key); i += 1) key = `F:backCover#${i}`;
    taken.add(key);
    const unit: NormUnit = { kind: "cover", key, setup: { header: { mode: "inherit" }, footer: { mode: "inherit" } } };
    plans.push({ unit, blocks: [syntheticBlock(key, "backCover", "backCover", { mode: "auto" }, seq++)] });
  }

  // (d) Urutan = posisi slot (stabil di dalam slot).
  const pos = (p: UnitPlan): number => slotByKey.get(p.slotKey as string)?.position ?? Number.MAX_SAFE_INTEGER;
  const ordered = plans.map((p, i) => ({ p, i })).sort((a, b) => pos(a.p) - pos(b.p) || a.i - b.i).map((x) => x.p);
  if (ordered.length === 0) fail("snapshot tanpa unit: minimal satu seksi");
  return ordered;
}

/**
 * Saring rencana unit menurut lingkup render (SR-15 `RenderScope`): DOCUMENT =
 * semua; SLOT = unit slot itu (v1: kunci unit `F:<kunci>`); CHAPTER = unit
 * bab/lampiran berkunci bab itu. Lingkup tanpa unit = BY_CONSTRUCTION_FAILED.
 */
export function scopePlans(plans: readonly UnitPlan[], scope: RenderScope | undefined, chapterKeys: ReadonlyMap<string, string>): UnitPlan[] {
  if (!scope || scope.kind === "DOCUMENT") return [...plans];
  const out =
    scope.kind === "SLOT"
      ? plans.filter((p) =>
          p.slotKey !== undefined
            ? p.slotKey === scope.key || p.signatureSlotKey === scope.key
            : p.unit.key === `F:${scope.key}` || p.unit.key === scope.key || p.unit.kind === scope.key,
        )
      : plans.filter((p) => (p.unit.kind === "chapter" || p.unit.kind === "appendix") && chapterKeys.get(p.unit.key) === scope.key);
  if (out.length === 0) fail(`lingkup ${scope.kind}:${scope.key} tidak memiliki unit untuk dirender`, { scope });
  return out;
}
