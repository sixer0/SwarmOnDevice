/**
 * Blok struktural v2 slot (RQ-7, D-188; temuan SR-33 dan SR-17 F1): renderer DOCX
 * untuk tiga jenis blok yang dipancarkan compose SR-08 tetapi belum ada di peta
 * renderer kontrak. Perilaku setara perakit HTML SR-17
 * (`engine/html/assemble/slots.ts` `SLOT_BLOCK_RENDERERS`):
 *
 * - `sourceRegisterEntry`: satu entri register sumber per alamat
 *   `F:<slotKey>/<n>` (konten `{id, citation, kind?, url?, accessed?}`). Satu
 *   paragraf: penanda `[n]` (wajah mono) + tab, lalu `citation` · `kind` · `url`
 *   · `accessed`. URL ditulis sebagai teks, bukan tautan (paritas HTML KT-11).
 *   Urutan = urutan kiriman (n dari alamat compose).
 * - `slotPlaceholder`: unit slot wajib kosong pada render draf; teks dari
 *   compose (`slot.placeholderText`), kotak garis putus + miring (setara CSS
 *   `.st-placeholder`).
 * - `ruleIndex`: penanda unit indeks aturan otomatis saja (paragraf kosong +
 *   log `warn`), sama dengan HTML yang belum membangun indeks.
 *
 * Tampilan dari templat (D-139): format paragraf/run = peran `body.paragraph`
 * resolved; konten tidak membawa medan tampilan. Konstanta tata letak di bawah
 * (gantung 8 mm, warna penanda draf) menyalin konstanta perakit HTML.
 */
import type { BorderSpec, Inline, ParaFormat, RunProps } from "../../../contract";
import type { BlockEnv } from "./env";
import { plainHostVariant } from "./rail";
import { hostFormat } from "./text";
import { el } from "./xml";

/** Gantung entri register = HTML `padding-left:8mm; text-indent:-8mm`. */
const ENTRY_HANGING_MM = 8;
/** Pemisah bagian entri, sama dengan HTML (`parts.join(" · ")`). */
const ENTRY_SEPARATOR = " · ";
/** Penanda draf (HTML `.st-placeholder`: 0.5pt dashed #B45309, miring, padding 4mm). */
const PLACEHOLDER_COLOR = "B45309";
const PLACEHOLDER_BORDER: BorderSpec = { val: "dashed", sz: 4, color: PLACEHOLDER_COLOR, space: 4 };

function record(content: unknown): Record<string, unknown> {
  return content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : {};
}

function isInline(v: unknown): v is Inline {
  const o = record(v);
  return typeof o.text === "string" || Array.isArray(o.runs);
}

/** Format paragraf peran badan tanpa rel (blok slot tidak membawa rel bukti); kolom tercadang (C20) = badan 128 mm. */
function bodyFormat(env: BlockEnv): { para: ParaFormat; run: RunProps } {
  const f = hostFormat(env, "body.paragraph", [], undefined, plainHostVariant(env));
  return { para: f.para, run: f.run };
}

function plainRun(env: BlockEnv, text: string, base: RunProps): string {
  return env.run({ t: text }, base);
}

// ── sourceRegisterEntry ──────────────────────────────────────────────────

export function renderSourceRegisterEntry(env: BlockEnv): string {
  const c = record(env.block.content);
  if (!isInline(c.citation)) throw env.fail("sourceRegisterEntry.citation wajib memuat text atau runs");
  const n = env.block.address ? /\/(\d+)$/.exec(env.block.address)?.[1] : undefined;
  if (!n) env.warn(`sourceRegisterEntry tanpa nomor urut pada alamat (${env.block.address ?? "tanpa alamat"}); penanda [n] dilewati`);

  const f = bodyFormat(env);
  const hang = env.mmToTw(ENTRY_HANGING_MM);
  const left = (f.para.indLeftTw ?? 0) + hang;
  const para: ParaFormat = { ...f.para, indLeftTw: left, indHangingTw: hang, tabs: [{ posTw: left, val: "left" }] };
  delete para.indFirstLineTw; // gantung dan inden baris pertama saling meniadakan

  let xml = "";
  if (n) xml += env.run({ t: `[${n}]` }, env.mergeRun(f.run, { faceRole: "mono" }), el("w:tab"));
  xml += env.inline(c.citation, f.run, true, "body.paragraph");
  for (const k of ["kind", "url", "accessed"] as const) {
    const v = c[k];
    if (typeof v === "string" && v !== "") xml += plainRun(env, ENTRY_SEPARATOR + v, f.run);
  }
  return env.para(para, xml);
}

// ── slotPlaceholder ──────────────────────────────────────────────────────

export function renderSlotPlaceholder(env: BlockEnv): string {
  const text = record(env.block.content).text;
  const f = bodyFormat(env);
  const para: ParaFormat = {
    ...f.para,
    borders: { top: PLACEHOLDER_BORDER, bottom: PLACEHOLDER_BORDER, left: PLACEHOLDER_BORDER, right: PLACEHOLDER_BORDER },
  };
  const run = env.mergeRun(f.run, { i: true, color: PLACEHOLDER_COLOR });
  return env.para(para, typeof text === "string" && text !== "" ? plainRun(env, text, run) : "");
}

// ── ruleIndex ────────────────────────────────────────────────────────────

export function renderRuleIndex(env: BlockEnv): string {
  env.warn(`ruleIndex (${env.block.address ?? env.block.blockId}) dirender sebagai penanda saja; indeks aturan otomatis belum dibangun di DOCX`);
  return env.para(bodyFormat(env).para, "");
}
