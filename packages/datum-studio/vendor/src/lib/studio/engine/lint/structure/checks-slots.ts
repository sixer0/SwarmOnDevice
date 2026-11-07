/**
 * Lint rilis struktur v2 (SR-18; register 03_structural_sections_specs.md
 * §11.4 LD-01..LD-04, §8.1-§8.2; blueprint 05 §2.7, §2.9). Tidak menahan
 * berkas (A10): hasilnya hanya menentukan status rilis.
 *
 * - LD-01 `SLOT_CONTENT_MISSING`: FAIL untuk setiap slot wajib aktif yang
 *   `EMPTY` atau `PARTIAL` (semua tier; pada NOTA, PARTIAL yang hanya karena
 *   celah bab tidak dihitung, putusan controller SR-18).
 * - LD-02 `CONTENT_CHAPTER_GAP`: kunci bab hilang di slot berulang mana pun;
 *   FAIL pada TERBIT/SERAH, REPORT pada NOTA.
 * - LD-03 `SCHEMA_V1_ADAPTED` dan LD-04 `INLINE_FORMAT_STRIPPED`: REPORT dari
 *   `AdaptReportV1` (§14.3). LD-04 terdaftar bermodul `scan` (register), tetapi
 *   dilaporkan dari sini karena sumber datanya laporan adaptor yang sama.
 *
 * Sumber data, berurutan:
 *  1. `CompletenessReportV2` dari pemanggil (layanan kelengkapan I48), bila ada.
 *  2. Snapshot `studio.norm/v2`: state slot DINILAI ULANG dari kerangka +
 *     konten tergabung menurut aturan §8.1/§8.2 (lint tidak memercayai state
 *     tersimpan begitu saja; selisih dengan state tersimpan disebut di detail).
 *  3. Snapshot `studio.norm/v1`: kerangka implisit §6.3 dari `sectionPlan`
 *     tier (KC-8: v1 tunduk pada aturan kelengkapan yang sama). Bab v1
 *     posisional sehingga celah kunci bab tidak mungkin.
 */
import type {
  AdaptReportV1,
  ChapterExpectedSource,
  NormDocSnapshotV2,
  NormSlotV2,
  StudioSlotState,
  StudioTier,
} from "../../../contract";
import { CHAPTER_KEY_LETTER_PATTERN, CHAPTER_KEY_NUMERIC_PATTERN } from "../../../contract";
import { SECTION_REGISTRY } from "../../../registry/sections";
import { SLOT_KIND_BY_TYPE, isSlotSectionType } from "../../../registry/slots";
import { findings, notRun, type CheckOutcome, type Finding, type StructCtx } from "./context";

export const SLOT_CONTENT_MISSING_ID = "SLOT_CONTENT_MISSING";
export const CONTENT_CHAPTER_GAP_ID = "CONTENT_CHAPTER_GAP";
export const SCHEMA_V1_ADAPTED_ID = "SCHEMA_V1_ADAPTED";
export const INLINE_FORMAT_STRIPPED_ID = "INLINE_FORMAT_STRIPPED";

/**
 * Kunci `x` tempat laporan adaptor v1 dibawa snapshot (`snapshot.source.x`
 * pada v2, atau `snapshot.doc.x`). Seam SR-18: penulis snapshot (adaptor
 * SR-09 / compose) diminta menaruh `AdaptReportV1` di sini (file_requests).
 */
export const ADAPT_REPORT_X_KEY = "adaptReportV1";

// ── Penilaian slot ────────────────────────────────────────────────────────

/** Satu slot yang dinilai lint (bentuk bersama ketiga sumber). */
export interface LintSlotStatus {
  slotKey: string;
  label: string;
  sectionType: string;
  required: boolean;
  repeatable: boolean;
  state: StudioSlotState;
  /** State tersimpan di snapshot bila berbeda dari penilaian ulang. */
  storedState?: StudioSlotState;
  /** Hanya slot berulang. */
  chapters?: {
    expected: string[];
    expectedSource: ChapterExpectedSource;
    present: string[];
    missing: string[];
    minItems?: number;
  };
}

export interface SlotAssessment {
  source: "completeness" | "snapshot-v2" | "implicit-v1";
  slots: LintSlotStatus[];
}

interface ChapterLike {
  key?: unknown;
}

interface RepeatablePayloadLike {
  outline?: Array<{ key?: unknown }>;
  chapters?: ChapterLike[];
}

const NUMERIC_KEY = new RegExp(CHAPTER_KEY_NUMERIC_PATTERN);
const LETTER_KEY = new RegExp(CHAPTER_KEY_LETTER_PATTERN);

function sectionName(sectionType: string): string {
  return SECTION_REGISTRY.find((s) => s.key === sectionType)?.name ?? sectionType;
}

/** §8.2: bab diharapkan (outline atau kontigu), ada, dan hilang. */
export function chapterProgress(
  sectionType: string,
  payload: RepeatablePayloadLike | undefined,
): { expected: string[]; expectedSource: ChapterExpectedSource; present: string[]; missing: string[] } {
  const present = (payload?.chapters ?? []).map((c) => (typeof c?.key === "string" ? c.key : "")).filter((k) => k !== "");
  let expected: string[];
  let expectedSource: ChapterExpectedSource;
  if (Array.isArray(payload?.outline)) {
    expectedSource = "outline";
    expected = payload.outline.map((o) => (typeof o?.key === "string" ? o.key : "")).filter((k) => k !== "");
  } else {
    expectedSource = "contiguous";
    if (sectionType === "appendix") {
      const letters = present.filter((k) => LETTER_KEY.test(k)).map((k) => k.charCodeAt(0));
      const max = letters.length ? Math.max(...letters) : 0;
      expected = max ? Array.from({ length: max - 64 }, (_, i) => String.fromCharCode(65 + i)) : [];
    } else {
      const nums = present.filter((k) => NUMERIC_KEY.test(k)).map(Number);
      const max = nums.length ? Math.max(...nums) : 0;
      expected = Array.from({ length: max }, (_, i) => String(i + 1));
    }
  }
  const have = new Set(present);
  return { expected, expectedSource, present, missing: expected.filter((k) => !have.has(k)) };
}

/** §8.1 dinilai ulang dari kerangka + konten v2 tergabung. */
function assessV2(snap: NormDocSnapshotV2): LintSlotStatus[] {
  const sections = (snap.source?.sections ?? {}) as Record<string, unknown>;
  const out: LintSlotStatus[] = [];
  const slots = [...(snap.skeleton?.slots ?? [])].filter((s) => s.active).sort((a, b) => a.position - b.position);
  for (const s of slots) out.push(assessSlotV2(s, sections[s.slotKey]));
  return out;
}

function assessSlotV2(s: NormSlotV2, payload: unknown): LintSlotStatus {
  const base = { slotKey: s.slotKey, label: s.label || sectionName(s.sectionType), sectionType: s.sectionType, required: s.required, repeatable: s.repeatable };
  const withStored = (st: LintSlotStatus): LintSlotStatus => (s.state && s.state !== st.state ? { ...st, storedState: s.state } : st);
  if (s.omitted) return { ...base, state: "OMITTED" };
  const filled = payload !== undefined && payload !== null;
  if (s.repeatable) {
    const prog = chapterProgress(s.sectionType, filled ? (payload as RepeatablePayloadLike) : undefined);
    const minItems = SLOT_KIND_BY_TYPE.get(s.sectionType)?.implicitMinItems;
    const chapters = { ...prog, ...(minItems !== undefined ? { minItems } : {}) };
    let state: StudioSlotState;
    if (prog.present.length === 0) state = s.required ? "EMPTY" : "OPTIONAL_EMPTY";
    else if (prog.missing.length > 0 || (minItems !== undefined && prog.present.length < minItems)) state = "PARTIAL";
    else state = "FILLED";
    return withStored({ ...base, state, chapters });
  }
  if (s.contentMode === "AUTO") return withStored({ ...base, state: "AUTO_READY" });
  if (s.contentMode === "MIXED" && !filled) return withStored({ ...base, state: "AUTO_READY" });
  if (filled) return withStored({ ...base, state: "FILLED" });
  return withStored({ ...base, state: s.required ? "EMPTY" : "OPTIONAL_EMPTY" });
}

/** §6.3 kerangka implisit dari `sectionPlan[tier]` untuk snapshot v1 (KC-8). */
function assessImplicitV1(ctx: StructCtx): LintSlotStatus[] | undefined {
  const plan = ctx.tpl.sectionPlan?.[ctx.tier];
  if (!plan) return undefined;
  const doc = ctx.doc;
  const order = [...(plan.order ?? []), ...plan.required, ...plan.optional];
  const seen = new Set<string>();
  const required = new Set(plan.required);
  const out: LintSlotStatus[] = [];
  for (const type of order) {
    if (seen.has(type) || !isSlotSectionType(type)) continue;
    seen.add(type);
    const kind = SLOT_KIND_BY_TYPE.get(type);
    if (!kind) continue;
    const req = required.has(type);
    const base = { slotKey: kind.implicitSlotKey, label: sectionName(type), sectionType: type, required: req, repeatable: kind.repeatable };
    if (kind.repeatable) {
      const n = type === "chapter" ? doc.chapters.length : (doc.appendices ?? []).length;
      const minItems = kind.implicitMinItems;
      const state: StudioSlotState = n === 0 ? (req ? "EMPTY" : "OPTIONAL_EMPTY") : minItems !== undefined && n < minItems ? "PARTIAL" : "FILLED";
      out.push({ ...base, state });
      continue;
    }
    if (kind.defaultContentMode === "AUTO") {
      out.push({ ...base, state: "AUTO_READY" });
      continue;
    }
    const filled =
      type === "cover" ? !!doc.front?.cover
      : type === "controlSheet" ? !!doc.front?.controlSheet
      : type === "toc" ? !!doc.front?.toc
      : type === "signatureBlock" ? !!doc.front?.signature
      : ctx.walk.items.some((i) => i.block.type === type);
    if (kind.defaultContentMode === "MIXED" && !filled) out.push({ ...base, state: "AUTO_READY" });
    else out.push({ ...base, state: filled ? "FILLED" : req ? "EMPTY" : "OPTIONAL_EMPTY" });
  }
  return out;
}

function assessFromCompleteness(ctx: StructCtx): LintSlotStatus[] {
  const rep = ctx.completeness;
  if (!rep) return [];
  return rep.slots.map((s) => {
    const prog = rep.chapters?.[s.slotKey];
    return {
      slotKey: s.slotKey,
      label: s.label || sectionName(s.sectionType),
      sectionType: s.sectionType,
      required: s.required,
      repeatable: prog !== undefined,
      state: s.state,
      ...(prog
        ? {
            chapters: {
              expected: prog.expected,
              expectedSource: prog.expectedSource,
              present: prog.present.map((p) => p.key),
              missing: prog.missing,
              ...(prog.minItems !== undefined ? { minItems: prog.minItems } : {}),
            },
          }
        : {}),
    };
  });
}

const assessCache = new WeakMap<StructCtx, SlotAssessment | null>();

/** Penilaian slot bersama LD-01/LD-02 (dicache per konteks); null = tidak dapat dinilai. */
export function assessSlots(ctx: StructCtx): SlotAssessment | null {
  const hit = assessCache.get(ctx);
  if (hit !== undefined) return hit;
  let res: SlotAssessment | null;
  if (ctx.completeness) res = { source: "completeness", slots: assessFromCompleteness(ctx) };
  else if (ctx.v2) res = { source: "snapshot-v2", slots: assessV2(ctx.v2) };
  else {
    const slots = assessImplicitV1(ctx);
    res = slots ? { source: "implicit-v1", slots } : null;
  }
  assessCache.set(ctx, res);
  return res;
}

const SOURCE_NOTE: Record<SlotAssessment["source"], string> = {
  completeness: "laporan kelengkapan layanan",
  "snapshot-v2": "kerangka snapshot studio.norm/v2 dinilai ulang",
  "implicit-v1": "kerangka implisit sectionPlan (snapshot v1)",
};

function slotAddress(s: LintSlotStatus): string | undefined {
  return s.repeatable ? undefined : `F:${s.slotKey}`;
}

// ── LD-01 ─────────────────────────────────────────────────────────────────

/**
 * PARTIAL semata karena kunci bab hilang (minItems terpenuhi). Putusan controller
 * SR-18 (amandemen register §11.4 LD-01): pada NOTA keadaan ini tidak dihitung
 * LD-01; celah bab ditangani LD-02 (REPORT NOTA).
 */
function partialOnlyByGap(s: LintSlotStatus): boolean {
  const c = s.chapters;
  if (!c || c.missing.length === 0) return false;
  return c.minItems === undefined || c.present.length >= c.minItems;
}

/**
 * LD-01 slot wajib aktif `EMPTY`/`PARTIAL` = FAIL (semua tier). Pengecualian
 * NOTA (putusan controller SR-18): PARTIAL yang hanya disebabkan celah bab
 * tidak dihitung; EMPTY dan minItems tak terpenuhi tetap FAIL.
 */
function slotContentMissing(ctx: StructCtx): CheckOutcome {
  const a = assessSlots(ctx);
  if (!a) return notRun(`kerangka tidak dapat dibentuk: snapshot v1 tanpa rencana section tier ${ctx.tier} di templat ${ctx.tpl.templateId} v${ctx.tpl.versionNo}`);
  const required = a.slots.filter((s) => s.required && s.state !== "OMITTED");
  const f: Finding[] = [];
  for (const s of required) {
    if (s.state !== "EMPTY" && s.state !== "PARTIAL") continue;
    if (s.state === "PARTIAL" && ctx.tier === "NOTA" && partialOnlyByGap(s)) continue;
    const why =
      s.state === "EMPTY"
        ? s.repeatable
          ? "belum ada bab (POST /api/studio/chapters)"
          : "isi belum dikirim (POST /api/studio/slots)"
        : s.chapters && s.chapters.missing.length > 0
          ? `bab belum ada ${s.chapters.missing.join(", ")}`
          : `jumlah bab ${s.chapters?.present.length ?? 0} di bawah minItems ${s.chapters?.minItems ?? "?"}`;
    const stored = s.storedState ? ` (state tersimpan ${s.storedState})` : "";
    const address = slotAddress(s);
    f.push({ ...(address ? { address } : {}), detail: `slot wajib "${s.label}" (${s.slotKey}) ${s.state}${stored}: ${why}; revisi tidak dapat dirilis (D-131)` });
  }
  return findings(f, `${required.length} slot wajib aktif berisi (${SOURCE_NOTE[a.source]})`);
}

// ── LD-02 ─────────────────────────────────────────────────────────────────

function gapStatus(tier: StudioTier): "FAIL" | "REPORT" {
  return tier === "NOTA" ? "REPORT" : "FAIL";
}

/** LD-02 kunci bab hilang di slot berulang: FAIL TERBIT/SERAH, REPORT NOTA. */
function contentChapterGap(ctx: StructCtx): CheckOutcome {
  const a = assessSlots(ctx);
  if (!ctx.completeness && !ctx.v2) {
    return findings([], "snapshot studio.norm/v1: bab posisional tanpa kunci, celah bab tidak mungkin");
  }
  if (!a) return notRun("kerangka slot tidak dapat dibentuk");
  const rep = a.slots.filter((s) => s.repeatable && s.state !== "OMITTED" && s.chapters);
  const status = gapStatus(ctx.tier);
  const f: Finding[] = [];
  for (const s of rep) {
    const c = s.chapters;
    if (!c || c.missing.length === 0) continue;
    const src = c.expectedSource === "outline" ? `outline ${c.expected.join(", ")}` : `kontigu ${c.expected[0]}..${c.expected.at(-1)}`;
    f.push({
      status,
      detail: `slot "${s.label}" (${s.slotKey}): bab belum ada ${c.missing.join(", ")} (diharapkan ${src}; ada ${c.present.join(", ") || "-"})${status === "REPORT" ? "; NOTA: dilaporkan saja" : ""}`,
    });
  }
  return findings(f, `${rep.length} slot berulang tanpa celah bab (${SOURCE_NOTE[a.source]})`);
}

// ── LD-03 / LD-04 ─────────────────────────────────────────────────────────

function isAdaptReport(x: unknown): x is AdaptReportV1 {
  if (!x || typeof x !== "object") return false;
  const r = x as Partial<AdaptReportV1>;
  return r.schema === "studio.doc/v1" && typeof r.policy === "string" && typeof r.stripped === "object" && r.stripped !== null;
}

/** Laporan adaptor: dari pemanggil, lalu `snapshot.source.x`, lalu `snapshot.doc.x`. */
export function adaptReportOf(ctx: StructCtx): AdaptReportV1 | undefined {
  if (ctx.adaptReport) return ctx.adaptReport;
  const fromSource = (ctx.v2?.source?.x as Record<string, unknown> | undefined)?.[ADAPT_REPORT_X_KEY];
  if (isAdaptReport(fromSource)) return fromSource;
  const fromDoc = (ctx.doc.x as Record<string, unknown> | undefined)?.[ADAPT_REPORT_X_KEY];
  return isAdaptReport(fromDoc) ? fromDoc : undefined;
}

function counts(rec: Record<string, number> | undefined): string {
  const e = Object.entries(rec ?? {}).filter(([, n]) => typeof n === "number" && n > 0);
  return e.length ? e.map(([k, n]) => `${k} ${n}`).join(", ") : "-";
}

/** LD-03 REPORT; detail memuat ringkasan + `AdaptReportV1` (JSON). */
function schemaV1Adapted(ctx: StructCtx): CheckOutcome {
  const r = adaptReportOf(ctx);
  if (!r) {
    return findings(
      [],
      ctx.v2 ? "kiriman studio.doc/v2 asli (tanpa laporan adaptor v1)" : "revisi jalur studio.norm/v1 lama (tidak melalui adaptor v1 -> v2)",
    );
  }
  const d = r.dropped;
  const detail =
    `kiriman studio.doc/v1 diadaptasi ke v2 (kebijakan ingest.inlineFormat ${r.policy}): dibuang ${counts(r.stripped)}; ` +
    `dilepas spacer ${d?.spacer ?? 0}, device ${d?.device ?? 0}, glif simbol ${d?.symbolGlyphRuns ?? 0}, medan ${d?.fieldRuns ?? 0}, ` +
    `butir depan ${d?.frontItems ?? 0}, entri daftar isi ${d?.tocEntries ?? 0}; diganti nama ${counts(r.renamed)}. details=${JSON.stringify(r)}`;
  return findings([{ status: "REPORT", detail }], "");
}

/** LD-04 REPORT; hitungan per nama medan tampilan yang dibuang (`strip`). */
export function inlineFormatStripped(ctx: StructCtx): CheckOutcome {
  const r = adaptReportOf(ctx);
  if (!r) return findings([], "tidak ada adaptasi v1; tidak ada medan tampilan yang dibuang");
  const total = Object.values(r.stripped ?? {}).reduce((a, n) => a + (typeof n === "number" ? n : 0), 0);
  if (r.policy !== "strip" || total === 0) return findings([], `kebijakan ingest.inlineFormat ${r.policy}; 0 medan tampilan dibuang`);
  return findings([{ status: "REPORT", detail: `${total} medan tampilan v1 dibuang (ingest.inlineFormat strip): ${counts(r.stripped)}` }], "");
}

/** Cek registri bermodul structure milik SR-18 (LD-01..LD-03). LD-04 (modul scan) lewat `inlineFormatStripped`. */
export const STRUCTURE_SLOT_CHECKS: Readonly<Record<string, (ctx: StructCtx) => CheckOutcome>> = {
  [SLOT_CONTENT_MISSING_ID]: slotContentMissing,
  [CONTENT_CHAPTER_GAP_ID]: contentChapterGap,
  [SCHEMA_V1_ADAPTED_ID]: schemaV1Adapted,
};
