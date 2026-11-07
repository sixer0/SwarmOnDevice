/**
 * Teks kelengkapan berbahasa Indonesia awam (SR-11; register §8.3, PT-05, D-131 butir 2):
 * `message`, `nextSteps`, `forwardToController`. Murni: hanya membaca laporan + identitas.
 * Daftar dipisah ", "; bagian kosong dihilangkan; waktu `HH:MM WIB` (Asia/Jakarta, UTC+7 tanpa DST).
 */
import { studioRoutePath, type ChapterProgressV2, type CompletenessReportV2, type SlotStatusV2 } from "@/lib/studio/contract";
import { isLetterKeyed, latestOf } from "./compute";
import type { CompletenessTextContext } from "./types";

type StructureReport = Pick<CompletenessReportV2, "status" | "revisionNo" | "slots" | "chapters" | "missingRequired">;
export type CompletenessTexts = Pick<CompletenessReportV2, "message" | "nextSteps" | "forwardToController">;

/** WIB = UTC+7 sepanjang tahun (tidak ada DST), jadi offset tetap deterministik tanpa ICU. */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export function formatWibTime(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + WIB_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} WIB`;
}

/** "A", "A dan B", "A, B, dan C". */
function joinDan(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} dan ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, dan ${items[items.length - 1]}`;
}

interface RepeatableGap {
  slot: SlotStatusV2;
  progress: ChapterProgressV2;
  /** Kunci bab hilang (missingRequired "<slotKey>:<kunci>"). */
  keys: string[];
  /** Slot wajib berulang hilang utuh ("<slotKey>" saja): 0 bab atau di bawah minItems. */
  whole: boolean;
  /** Butuh `{"slot":"<slotKey>"}` di POST /chapters (bawaan = slot berulang pertama). */
  slotHint: boolean;
}

interface Gaps {
  /** Label slot wajib yang hilang (tak-berulang dan berulang 0 bab), urut slot. */
  missingLabels: string[];
  /** Label slot tak-berulang yang hilang (langkah POST /slots). */
  slotLabels: string[];
  repeatable: RepeatableGap[];
}

function collectGaps(r: StructureReport): Gaps {
  const bySlot = new Map(r.slots.map((s) => [s.slotKey, s]));
  const firstRepeatable = r.slots.find((s) => r.chapters[s.slotKey])?.slotKey;
  const missingLabels: string[] = [];
  const slotLabels: string[] = [];
  const repeatable = new Map<string, RepeatableGap>();
  const gapFor = (slotKey: string): RepeatableGap | null => {
    const slot = bySlot.get(slotKey);
    const progress = r.chapters[slotKey];
    if (!slot || !progress) return null;
    let g = repeatable.get(slotKey);
    if (!g) {
      g = { slot, progress, keys: [], whole: false, slotHint: isLetterKeyed(slot.sectionType) || slotKey !== firstRepeatable };
      repeatable.set(slotKey, g);
    }
    return g;
  };
  for (const entry of r.missingRequired) {
    const sep = entry.indexOf(":");
    if (sep >= 0) {
      gapFor(entry.slice(0, sep))?.keys.push(entry.slice(sep + 1));
      continue;
    }
    const label = bySlot.get(entry)?.label ?? entry;
    missingLabels.push(label);
    const g = gapFor(entry);
    if (g) g.whole = true;
    else slotLabels.push(label);
  }
  const order = r.slots.map((s) => s.slotKey);
  return {
    missingLabels,
    slotLabels,
    repeatable: [...repeatable.values()].sort((a, b) => order.indexOf(a.slot.slotKey) - order.indexOf(b.slot.slotKey)),
  };
}

function noun(g: RepeatableGap): "bab" | "lampiran" {
  return isLetterKeyed(g.slot.sectionType) ? "lampiran" : "bab";
}

function chaptersEndpoint(g: RepeatableGap): string {
  const base = `POST ${studioRoutePath("R12")}`;
  return g.slotHint ? `${base} {"slot":"${g.slot.slotKey}"}` : base;
}

/** Frasa objek langkah satu slot berulang: "bab 4", "bab", "bab tambahan (minimal 3)". */
function repeatableObject(g: RepeatableGap, forList: boolean): string {
  const n = noun(g);
  if (g.keys.length > 0) return `${n} ${forList ? g.keys.join(", ") : joinDan(g.keys)}`;
  if (g.progress.present.length === 0) return forList ? `${n} pertama` : n;
  return `${n} tambahan (minimal ${g.progress.minItems ?? 1})`;
}

/** Pengisian terakhir di seluruh dokumen: lingkup + penulis + waktu. */
function lastFill(r: StructureReport): { scope: string; by: string | null; at: string } | null {
  const candidates: Array<{ scope: string; by: string | null; at: string; revisionNo: number }> = [];
  for (const s of r.slots) {
    const progress = r.chapters[s.slotKey];
    if (progress) {
      const n = isLetterKeyed(s.sectionType) ? "lampiran" : "bab";
      for (const c of progress.present) if (c.at) candidates.push({ scope: `${n} ${c.key}`, by: c.by || null, at: c.at, revisionNo: c.revisionNo });
    } else if (s.state === "FILLED" && s.lastFilledAt) {
      candidates.push({ scope: s.label, by: s.lastFilledBy, at: s.lastFilledAt, revisionNo: s.lastFilledRevisionNo ?? 0 });
    }
  }
  return latestOf(candidates);
}

function missionLabel(ctx: CompletenessTextContext): string | null {
  if (!ctx.missionFolder) return null;
  return ctx.docKey ? `misi ${ctx.missionFolder}, ${ctx.docKey}` : `misi ${ctx.missionFolder}`;
}

function buildNextSteps(r: StructureReport, gaps: Gaps, ctx: CompletenessTextContext): string[] {
  if (r.status === "COMPLETE") {
    return [`Minta render penuh: POST ${studioRoutePath("R17", { id: ctx.docId })} {scope: "document"}`];
  }
  const steps: string[] = [];
  if (gaps.slotLabels.length > 0) steps.push(`Kirim isi ${gaps.slotLabels.join(", ")}: POST ${studioRoutePath("R13")}`);
  for (const g of gaps.repeatable) {
    const obj = repeatableObject(g, true);
    steps.push(`Kirim ${obj}: ${chaptersEndpoint(g)}`);
  }
  // Saran outline: slot berulang wajib (aktif, tidak AUTO) yang belum punya outline.
  const firstRepeatable = r.slots.find((s) => r.chapters[s.slotKey])?.slotKey;
  for (const s of r.slots) {
    const progress = r.chapters[s.slotKey];
    if (!progress || !s.required || s.state === "AUTO_READY" || progress.expectedSource !== "contiguous") continue;
    const n = isLetterKeyed(s.sectionType) ? "lampiran" : "bab";
    const slotArg = s.slotKey === firstRepeatable ? "" : `, slot: "${s.slotKey}"`;
    steps.push(`Opsional: tetapkan daftar ${n} yang direncanakan: PATCH ${studioRoutePath("R14", { id: ctx.docId })} {op: setOutline${slotArg}}`);
  }
  return steps;
}

/** I48 `completenessTexts`: teks dari laporan + identitas dokumen. */
export function completenessTexts(r: StructureReport, ctx: CompletenessTextContext): CompletenessTexts {
  const gaps = collectGaps(r);
  const nextSteps = buildNextSteps(r, gaps, ctx);
  if (r.status === "COMPLETE") {
    return { message: `Dokumen ${ctx.docNumber} lengkap pada revisi ${r.revisionNo}; render penuh tersedia.`, nextSteps };
  }

  // message
  const misi = missionLabel(ctx);
  const parts: string[] = [];
  if (gaps.missingLabels.length > 0) parts.push(`isi wajib belum ada untuk ${gaps.missingLabels.join(", ")}`);
  for (const g of gaps.repeatable) if (g.keys.length > 0) parts.push(`${noun(g)} belum ada ${g.keys.join(", ")}`);
  const message =
    `Dokumen ${ctx.docNumber}${misi ? ` (${misi})` : ""} belum lengkap pada revisi ${r.revisionNo}` +
    (parts.length > 0 ? `: ${parts.join("; ")}` : "") +
    ". Render penuh ditolak; render bab/slot tersedia sebagai draf.";

  // forwardToController
  const last = lastFill(r);
  const createdEmpty = r.revisionNo === 1 && last === null;
  const sentences: string[] = [
    `Dokumen ${ctx.docNumber}${ctx.missionFolder ? ` (misi ${ctx.missionFolder})` : ""} ` +
      (createdEmpty ? "dibuat kosong pada revisi 1." : `belum lengkap pada revisi ${r.revisionNo}.`),
  ];
  if (gaps.missingLabels.length > 0) sentences.push(`Isi wajib belum ada: ${gaps.missingLabels.join(", ")}.`);
  for (const g of gaps.repeatable) {
    if (g.keys.length === 0) continue;
    const n = noun(g);
    sentences.push(`${n === "bab" ? "Bab" : "Lampiran"} belum ada: ${g.keys.join(", ")}.`);
  }
  if (last && !createdEmpty) {
    const time = formatWibTime(last.at);
    sentences.push(`Terakhir mengisi: ${last.scope}${last.by ? ` oleh ${last.by}` : ""}${time ? ` pukul ${time}` : ""}.`);
  }
  const actions: string[] = [];
  if (gaps.slotLabels.length > 0) actions.push(`${joinDan(gaps.slotLabels)} (POST ${studioRoutePath("R13")})`);
  for (const g of gaps.repeatable) actions.push(`${repeatableObject(g, false)} (${chaptersEndpoint(g)})`);
  if (actions.length > 0) sentences.push(`Langkah berikut: kirim ${actions.join(" serta ")}, lalu minta render penuh.`);

  return { message, nextSteps, forwardToController: sentences.join(" ") };
}
