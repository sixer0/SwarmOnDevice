/**
 * Lingkup render pada snapshot (SR-15, blueprint 05 §2.9, register 03 §4.6,
 * §12 R17, §15.1). Murni: tanpa DB, tanpa I/O.
 *
 * - `DOCUMENT`: snapshot apa adanya (render penuh; gerbang COMPLETE milik
 *   layanan, bukan fungsi ini).
 * - `CHAPTER <k>`: unit bab/lampiran berkunci k saja.
 * - `SLOT <slotKey>`: unit milik slot itu (v2: `NormUnitV2.slotKey`; v1: jenis
 *   unit halaman depan `cover`/`controlSheet`/`toc`). Slot wajib yang kosong
 *   mendapat unit `placeholder: true` (register §4.6); slot opsional kosong
 *   tidak punya apa pun untuk dirender (404 ADDRESS_NOT_FOUND).
 *
 * Penomoran artefak (`numbering`) dan register TIDAK difilter: label dihitung
 * dari seluruh dokumen lalu unit difilter, sehingga bab 3 tetap bernomor
 * "Gambar 3.1" pada render bab (§2.6 butir 5). Nomor halaman lokal dan
 * penanda draf (KC-4 opsi a) dirakit perakit dari `RenderContext.scope`/`draft`.
 */
import type { AnyNormSnapshot, NormBlock, NormDocSnapshotV2, NormSlotV2, NormUnit, NormUnitV2, RenderScope } from "../../../contract";
import { isNormSnapshotV2 } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import type { DraftScopeLayout } from "../naming";

/** Jenis unit halaman depan v1 yang dapat dirender sebagai lingkup slot. */
const V1_SLOT_UNIT_KINDS: ReadonlySet<string> = new Set(["cover", "controlSheet", "toc"]);

export interface ScopedSnapshot {
  scope: RenderScope;
  /** true untuk CHAPTER/SLOT (draf). */
  draft: boolean;
  /** Snapshot terfilter (skema sama dengan masukan). */
  snapshot: AnyNormSnapshot;
  /** Tata letak berkas draf; absen untuk DOCUMENT. */
  layout?: DraftScopeLayout;
  /** Slot wajib kosong yang mendapat unit placeholder. */
  placeholderSlots: string[];
}

function chapterUnits(units: readonly NormUnit[], key: string): NormUnit[] {
  return units.filter((u) => (u.kind === "chapter" || u.kind === "appendix") && u.key === key);
}

function keepUnits<S extends AnyNormSnapshot>(s: S, units: readonly NormUnit[]): S {
  const keys = new Set(units.map((u) => u.key));
  const blocks = (s.blocks as readonly NormBlock[]).filter((b) => keys.has(b.unitKey));
  return { ...s, units: [...units], blocks } as S;
}

function chapterScope(s: AnyNormSnapshot, key: string): ScopedSnapshot {
  const units = chapterUnits(s.units, key);
  if (units.length === 0) {
    const available = s.units.filter((u) => u.kind === "chapter" || u.kind === "appendix").map((u) => u.key);
    throw new StudioEngineError("ADDRESS_NOT_FOUND", `Bab "${key}" tidak ada pada revisi ini`, { scope: "chapter", key, available });
  }
  const appendix = units.every((u) => u.kind === "appendix");
  return {
    scope: { kind: "CHAPTER", key },
    draft: true,
    snapshot: keepUnits(s, units),
    layout: { kind: "CHAPTER", key, appendix },
    placeholderSlots: [],
  };
}

function placeholderUnit(slot: NormSlotV2, taken: ReadonlySet<string>): NormUnitV2 {
  let key = `slot:${slot.slotKey}`;
  for (let n = 2; taken.has(key); n++) key = `slot:${slot.slotKey}:${n}`;
  return {
    kind: "slot",
    key,
    slotKey: slot.slotKey,
    sectionType: slot.sectionType,
    placeholder: true,
    setup: { header: { mode: "inherit" }, footer: { mode: "inherit" } },
  };
}

function slotScopeV2(s: NormDocSnapshotV2, key: string): ScopedSnapshot {
  const slot = s.skeleton.slots.find((x) => x.slotKey === key);
  if (!slot || !slot.active) {
    const known = s.skeleton.slots.filter((x) => x.active).map((x) => x.slotKey);
    throw new StudioEngineError("SLOT_UNKNOWN", `Slot "${key}" tidak ada di kerangka dokumen ini`, { slotKey: key, known });
  }
  const layout: DraftScopeLayout = { kind: "SLOT", key, label: slot.label };
  let units: NormUnit[] = s.units.filter((u) => u.slotKey === key);
  // Tanda tangan `inControlSheet` tidak punya unit sendiri: dirender di unit lembar kendali.
  if (units.length === 0 && slot.sectionType === "signatureBlock") {
    const control = s.skeleton.slots.find((x) => x.sectionType === "controlSheet" && x.active);
    if (control) units = s.units.filter((u) => u.slotKey === control.slotKey);
  }
  if (units.length > 0) return { scope: { kind: "SLOT", key }, draft: true, snapshot: keepUnits(s, units), layout, placeholderSlots: [] };
  if (!slot.required || slot.omitted) {
    throw new StudioEngineError("ADDRESS_NOT_FOUND", `Slot "${key}" kosong; tidak ada isi untuk dirender`, { slotKey: key, state: slot.state, required: slot.required });
  }
  const unit = placeholderUnit(slot, new Set(s.units.map((u) => u.key)));
  const out: NormDocSnapshotV2 = { ...s, units: [unit], blocks: [] };
  return { scope: { kind: "SLOT", key }, draft: true, snapshot: out, layout, placeholderSlots: [slot.slotKey] };
}

function slotScopeV1(s: AnyNormSnapshot, key: string): ScopedSnapshot {
  if (!V1_SLOT_UNIT_KINDS.has(key)) {
    throw new StudioEngineError("SLOT_UNKNOWN", `Slot "${key}" tidak dikenal untuk dokumen v1 (cover, controlSheet, toc)`, { slotKey: key, known: [...V1_SLOT_UNIT_KINDS] });
  }
  const units = s.units.filter((u) => u.kind === key);
  if (units.length === 0) {
    throw new StudioEngineError("ADDRESS_NOT_FOUND", `Slot "${key}" tidak ada pada revisi ini`, { slotKey: key });
  }
  return { scope: { kind: "SLOT", key }, draft: true, snapshot: keepUnits(s, units), layout: { kind: "SLOT", key, label: key }, placeholderSlots: [] };
}

/** Terapkan lingkup ke snapshot. Melempar ADDRESS_NOT_FOUND (404) / SLOT_UNKNOWN (422). */
export function applyRenderScope(snapshot: AnyNormSnapshot, scope: RenderScope | undefined): ScopedSnapshot {
  if (!scope || scope.kind === "DOCUMENT") {
    return { scope: { kind: "DOCUMENT" }, draft: false, snapshot, placeholderSlots: [] };
  }
  const key = String(scope.key ?? "").trim();
  if (!key) throw new StudioEngineError("SCHEMA_INVALID", `scope ${scope.kind} requires a key`, { scope: scope.kind });
  if (scope.kind === "CHAPTER") return chapterScope(snapshot, key);
  return isNormSnapshotV2(snapshot) ? slotScopeV2(snapshot, key) : slotScopeV1(snapshot, key);
}

/** sha256 aset yang dirujuk blok snapshot v2 (`NormBlockV2.assetSha256`). */
export function snapshotAssetShas(snapshot: AnyNormSnapshot): string[] {
  if (!isNormSnapshotV2(snapshot)) return [];
  const out = new Set<string>();
  for (const b of snapshot.blocks) if (typeof b.assetSha256 === "string" && b.assetSha256) out.add(b.assetSha256.toLowerCase());
  return [...out];
}
