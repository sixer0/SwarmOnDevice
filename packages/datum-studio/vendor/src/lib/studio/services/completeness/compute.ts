/**
 * Perhitungan kelengkapan murni (SR-11; register §8.1-§8.3, blueprint §2.6, D-131, D-153).
 * Tanpa DB, tanpa jam sistem: hasil ditentukan sepenuhnya oleh masukan.
 *
 * SATU SUMBER (SR-55 M6, FIX-V): urutan kunci bab (`compareChapterKeys`), kunci bab yang
 * diharapkan §8.2 (`expectedChapterKeys`), terisi-tidaknya payload slot tak-berulang
 * (`isSlotPayloadFilled`, sama dengan `M14.filled`), dan state slot E29 §8.1
 * (`slotState` / `slotStateOf`). Compose (`compose/snapshot.ts`, state kerangka snapshot)
 * dan R05 (state cadangan pohon slot) mengimpor fungsi ini, tidak menyalinnya.
 *
 * Dokumen ber-contractKind (DC-11, register 05 §6.5, KD-31): slot berulang kerangka jenis
 * (C58 `skeleton`, mis. `content`) mengharapkan kunci bab CO wajib registri (C58 `outline`)
 * ditambah kunci `outline` dokumen; `expectedSource = "outline"`. Tanpa `contractKind`
 * (atau jenis tak terdaftar) perilaku identik dengan sebelumnya.
 */
import {
  CHAPTER_KEY_LETTER_PATTERN,
  CHAPTER_KEY_NUMERIC_PATTERN,
  type ChapterProgressV2,
  type CompletenessReportV2,
  type SlotStatusV2,
  type StudioSlotState,
} from "@/lib/studio/contract";
import { getContractKindDef } from "@/lib/studio/registry/contracts";
import type { CompletenessChapterInput, CompletenessInput, CompletenessSlotInput } from "./types";

const NUMERIC_KEY = new RegExp(CHAPTER_KEY_NUMERIC_PATTERN);
const LETTER_KEY = new RegExp(CHAPTER_KEY_LETTER_PATTERN);

/** Slot berulang berkunci huruf (lampiran); selain itu berkunci angka (bab). */
export function isLetterKeyed(sectionType: string): boolean {
  return sectionType === "appendix";
}

/** ISO 8601 UTC atau null. */
export function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Urutan alami kunci bab: angka menurut nilai, lalu huruf, lalu sisanya leksikal. */
export function compareChapterKeys(a: string, b: string): number {
  const an = NUMERIC_KEY.test(a), bn = NUMERIC_KEY.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Kunci outline unik berurutan (§8.2); null bila outline absen, kosong, atau tanpa kunci string. */
function outlineKeyList(outline: unknown): string[] | null {
  if (!Array.isArray(outline) || outline.length === 0) return null;
  const keys: string[] = [];
  for (const e of outline) {
    const k = e && typeof e === "object" ? (e as { key?: unknown }).key : undefined;
    if (typeof k === "string" && !keys.includes(k)) keys.push(k);
  }
  return keys.length > 0 ? keys : null;
}

/** `payload.outline` slot berulang (M14 `RepeatableSlotMetaV2` atau payload sumber); undefined bila absen. */
function outlineOf(payload: unknown): unknown {
  return payload && typeof payload === "object" ? (payload as { outline?: unknown }).outline : undefined;
}

/** Kunci kontigu "1".."max" atau "A"..huruf terbesar dari kunci yang ada (§8.2). */
function contiguousKeys(present: readonly string[], letters: boolean): string[] {
  if (letters) {
    let max = 0;
    for (const k of present) if (LETTER_KEY.test(k)) max = Math.max(max, k.charCodeAt(0) - 64);
    return Array.from({ length: max }, (_, i) => String.fromCharCode(65 + i));
  }
  let max = 0;
  for (const k of present) if (NUMERIC_KEY.test(k)) max = Math.max(max, Number(k));
  return Array.from({ length: max }, (_, i) => String(i + 1));
}

/**
 * Kunci bab CO wajib (C58 `outline`, `required`) untuk satu slot dokumen ber-contractKind
 * (register 05 §6.5, KD-31). Berlaku hanya untuk slot berulang kerangka jenis (C58
 * `skeleton`, cocok `slotKey` + `sectionType`); null bila `contractKind` absen, jenis tidak
 * terdaftar, slot bukan slot berulang jenis itu, atau jenis tanpa bab wajib (perilaku
 * non-kontrak). Jenis tak terdaftar ditolak lebih awal oleh compose (422 CONTRACT_KIND).
 */
export function contractRequiredChapterKeys(
  contractKind: string | null | undefined,
  slotKey: string,
  sectionType: string,
): string[] | null {
  if (!contractKind) return null;
  const def = getContractKindDef(contractKind);
  if (!def) return null;
  if (!def.skeleton.some((s) => s.repeatable && s.slotKey === slotKey && s.sectionType === sectionType)) return null;
  const keys = def.outline.filter((o) => o.required).map((o) => o.chapterKey);
  return keys.length > 0 ? keys : null;
}

/**
 * Kunci bab yang diharapkan satu slot berulang (§8.2): kunci `outline` bila berisi,
 * selain itu kontigu (`"1".."max"`, lampiran `"A"..huruf terbesar`; 0 bab = `[]`).
 *
 * `requiredKeys` (kunci CO wajib dokumen ber-contractKind, 05 §6.5): bila berisi,
 * expected = `requiredKeys` ∪ kunci `outline` (urut alami), sumber selalu `"outline"`;
 * `outline` absen/null tidak menghapus kunci wajib.
 */
export function expectedChapterKeys(
  sectionType: string,
  outline: unknown,
  presentKeys: readonly string[],
  requiredKeys?: readonly string[] | null,
): { expected: string[]; source: "outline" | "contiguous" } {
  const fromOutline = outlineKeyList(outline);
  if (requiredKeys && requiredKeys.length > 0) {
    const union = [...requiredKeys];
    for (const k of fromOutline ?? []) if (!union.includes(k)) union.push(k);
    return { expected: union.sort(compareChapterKeys), source: "outline" };
  }
  if (fromOutline) return { expected: fromOutline, source: "outline" };
  return { expected: contiguousKeys(presentKeys, isLetterKeyed(sectionType)), source: "contiguous" };
}

/**
 * Payload slot tak-berulang dianggap terisi (`M14.filled`, KD-09): objek dengan medan
 * terdefinisi selain `type`. Payload absen/null atau `{ type }` saja = kosong.
 */
export function isSlotPayloadFilled(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const rec = payload as Record<string, unknown>;
  return Object.keys(rec).some((k) => k !== "type" && rec[k] !== undefined);
}

/**
 * Kemajuan bab satu slot berulang (T2-60b). `requiredKeys` = kunci CO wajib dokumen
 * ber-contractKind (`contractRequiredChapterKeys`); absen = perilaku non-kontrak.
 */
export function chapterProgress(slot: CompletenessSlotInput, requiredKeys?: readonly string[] | null): ChapterProgressV2 {
  const rows: CompletenessChapterInput[] = [...(slot.chapters ?? [])].sort((a, b) => compareChapterKeys(a.key, b.key));
  const presentKeys = rows.map((c) => c.key);
  const { expected, source } = expectedChapterKeys(slot.sectionType, outlineOf(slot.row?.payload), presentKeys, requiredKeys);
  const progress: ChapterProgressV2 = {
    expected,
    expectedSource: source,
    present: rows.map((c) => ({ key: c.key, pid: c.pid, by: c.by ?? "", at: toIso(c.at) ?? "", revisionNo: c.revisionNo ?? 0 })),
    missing: expected.filter((k) => !presentKeys.includes(k)),
  };
  if (slot.minItems != null) progress.minItems = slot.minItems;
  if (slot.maxItems != null) progress.maxItems = slot.maxItems;
  return progress;
}

/** State slot (E29), tabel §8.1 dievaluasi berurutan. */
export function slotState(slot: CompletenessSlotInput, progress: ChapterProgressV2 | null): StudioSlotState {
  // Slot wajib tanpa baris M14 tidak sah (wajib tidak dapat di-OMIT, EC02);
  // diperlakukan sebagai baris kosong agar tetap tercatat hilang, bukan OMITTED.
  if (!slot.row && !slot.required) return "OMITTED";
  const filled = slot.row?.filled === true;
  if (slot.contentMode === "AUTO") return "AUTO_READY";
  if (slot.contentMode === "MIXED" && !filled) return "AUTO_READY";
  if (!slot.repeatable) {
    if (filled) return "FILLED";
    return slot.required ? "EMPTY" : "OPTIONAL_EMPTY";
  }
  const count = progress?.present.length ?? 0;
  if (count === 0) return slot.required ? "EMPTY" : "OPTIONAL_EMPTY";
  const min = slot.minItems ?? 0;
  if ((progress?.missing.length ?? 0) > 0 || count < min) return "PARTIAL";
  return "FILLED";
}

/** Masukan ringkas state slot untuk pemanggil yang tidak memegang baris M14/M15 lengkap. */
export interface SlotStateInput {
  sectionType: string;
  required: boolean;
  repeatable: boolean;
  contentMode: CompletenessSlotInput["contentMode"];
  minItems?: number | null;
  /** Slot OMIT (tanpa baris M14). */
  omitted: boolean;
  /** `M14.filled`: slot tak-berulang = `isSlotPayloadFilled(payload)`; berulang = ada bab. */
  filled: boolean;
  /** `payload.outline` slot berulang (bila ada). */
  outline?: unknown;
  /** Kunci bab yang ada (slot berulang). */
  chapterKeys?: readonly string[];
  /** Kunci slot; hanya dibaca bersama `contractKind` (05 §6.5). */
  slotKey?: string;
  /** Jenis kontrak templat (MX08); absen = perilaku non-kontrak. */
  contractKind?: string | null;
}

/**
 * State slot E29 (§8.1) dari masukan ringkas: membentuk `CompletenessSlotInput` lalu
 * memakai `chapterProgress` + `slotState` yang sama dengan laporan kelengkapan.
 */
export function slotStateOf(i: SlotStateInput): StudioSlotState {
  const slot: CompletenessSlotInput = {
    slotKey: i.slotKey ?? "",
    sectionType: i.sectionType,
    label: "",
    required: i.required,
    repeatable: i.repeatable,
    minItems: i.minItems ?? null,
    contentMode: i.contentMode,
    active: true,
    row: i.omitted
      ? null
      : { filled: i.filled, payload: i.outline !== undefined ? { outline: i.outline } : null, lastFilledBy: null, lastFilledAt: null, lastFilledRevisionNo: null },
    ...(i.repeatable ? { chapters: (i.chapterKeys ?? []).map((key) => ({ key, pid: "", by: null, at: null, revisionNo: null })) } : {}),
  };
  const omitted = !slot.row && !slot.required;
  const required = contractRequiredChapterKeys(i.contractKind, slot.slotKey, slot.sectionType);
  return slotState(slot, i.repeatable && !omitted ? chapterProgress(slot, required) : null);
}

/** Kunci `missingRequired` satu slot (§8.3). */
function missingRequiredFor(slot: CompletenessSlotInput, state: StudioSlotState, progress: ChapterProgressV2 | null): string[] {
  if (!slot.required) return [];
  if (!slot.repeatable || !progress) return state === "EMPTY" ? [slot.slotKey] : [];
  if (state === "AUTO_READY") return [];
  const count = progress.present.length;
  if (progress.missing.length > 0) return progress.missing.map((k) => `${slot.slotKey}:${k}`);
  if (count === 0 || count < (slot.minItems ?? 0)) return [slot.slotKey];
  return [];
}

/**
 * Laporan tanpa teks (`message`/`nextSteps`/`forwardToController` diisi `completenessTexts`).
 * Slot tidak aktif tidak dicantumkan; slot OMIT tidak punya entri `chapters`.
 */
export function computeStructure(input: CompletenessInput): Omit<CompletenessReportV2, "message" | "nextSteps" | "forwardToController"> {
  const slots: SlotStatusV2[] = [];
  const chapters: Record<string, ChapterProgressV2> = {};
  const missingRequired: string[] = [];
  for (const slot of input.slots) {
    if (!slot.active) continue;
    const omitted = !slot.row && !slot.required;
    const progress = slot.repeatable && !omitted ? chapterProgress(slot, contractRequiredChapterKeys(input.contractKind, slot.slotKey, slot.sectionType)) : null;
    const state = slotState(slot, progress);
    if (progress) chapters[slot.slotKey] = progress;
    // Penulis terakhir slot berulang = bab terbaru (baris M14 berulang tidak membawa isi bab).
    const latestChapter = progress ? latestOf(progress.present) : null;
    slots.push({
      slotKey: slot.slotKey,
      label: slot.label,
      sectionType: slot.sectionType,
      state,
      required: slot.required,
      lastFilledBy: latestChapter ? latestChapter.by || null : slot.row?.filled ? slot.row.lastFilledBy : null,
      lastFilledAt: latestChapter ? latestChapter.at || null : slot.row?.filled ? toIso(slot.row.lastFilledAt) : null,
      lastFilledRevisionNo: latestChapter ? latestChapter.revisionNo || null : slot.row?.filled ? slot.row.lastFilledRevisionNo : null,
    });
    missingRequired.push(...missingRequiredFor(slot, state, progress));
  }
  const complete = missingRequired.length === 0;
  return {
    status: complete ? "COMPLETE" : "INCOMPLETE",
    revisionNo: input.revisionNo,
    fullRenderAllowed: complete,
    slots,
    chapters,
    missingRequired,
  };
}

/** Entri dengan `at` terbaru (seri: revisi lebih tinggi, lalu urutan terakhir). */
export function latestOf<T extends { at: string; revisionNo: number }>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const it of items) {
    if (!it.at) continue;
    if (!best || it.at > best.at || (it.at === best.at && it.revisionNo >= best.revisionNo)) best = it;
  }
  return best;
}
