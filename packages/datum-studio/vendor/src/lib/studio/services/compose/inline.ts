/**
 * Pemetaan Inline v2 -> Inline internal (v1) (SR-08; blueprint §0 tabel uji
 * prinsip, §2.9; register §14.3 arah balik).
 *
 * - Penanda makna: `strong` -> `b`, `em` -> `i`, `code` -> `faceRole: "mono"`,
 *   `sup`/`sub` -> `vertAlign`. Tidak ada properti tipografis lain.
 * - Pemecahan glif (R-40 `render.run.symbolGlyphs`): run bentuk `runs` dipecah
 *   pada setiap karakter glif; potongan glif mendapat `faceRole: "symbolGlyph"`
 *   (wajah simbol milik templat, D-139 butir b). Bentuk `text` (md-lite) tidak
 *   diubah: pengurai md-lite mesin memegang teksnya (A9).
 * - Label aparatus figur (D-145): "KUNCI"/"SUMBER" DIBANGKITKAN STRUKTURAL dari
 *   medan `keyRow`/`source` sebagai run label pertama; agen tidak pernah
 *   mengirim label dan teks agen tidak dipindai untuk label.
 */
import type { Inline, InlineV2, Run, RunV2 } from "../../contract";
import { FIGURE_LABELS, FIGURE_LABEL_SPACING } from "../../engine/docx/figures/defaults";

/** Bawaan R-40 bila parameter absen (sama dengan default registri). */
export const DEFAULT_SYMBOL_GLYPHS: readonly string[] = ["■", "◈", "◇", "△"];

export interface InlineCtx {
  /** Karakter glif simbol (R-40); satu karakter per butir. */
  glyphs: ReadonlySet<string>;
}

export function glyphSet(value: unknown): ReadonlySet<string> {
  const list = Array.isArray(value) ? value.filter((g): g is string => typeof g === "string" && g.length > 0) : DEFAULT_SYMBOL_GLYPHS;
  return new Set(list);
}

/** Pecah teks pada karakter glif (iterasi titik kode, aman untuk karakter di luar BMP). */
function splitGlyphs(t: string, glyphs: ReadonlySet<string>): Array<{ t: string; glyph: boolean }> {
  if (glyphs.size === 0) return [{ t, glyph: false }];
  const out: Array<{ t: string; glyph: boolean }> = [];
  let buf = "";
  for (const ch of t) {
    if (glyphs.has(ch)) {
      if (buf !== "") out.push({ t: buf, glyph: false });
      buf = "";
      out.push({ t: ch, glyph: true });
    } else {
      buf += ch;
    }
  }
  if (buf !== "") out.push({ t: buf, glyph: false });
  return out.length > 0 ? out : [{ t, glyph: false }];
}

/** Satu run v2 -> run internal (dipecah pada glif). */
export function mapRun(r: RunV2, ctx: InlineCtx): Run[] {
  if ("tab" in r) return [{ tab: true }];
  if ("br" in r) return [{ br: "line" }];
  const props: Record<string, unknown> = {};
  if (r.strong) props.b = true;
  if (r.em) props.i = true;
  if (r.code) props.faceRole = "mono";
  if (r.sup) props.vertAlign = "superscript";
  else if (r.sub) props.vertAlign = "subscript";
  return splitGlyphs(r.t, ctx.glyphs).map((piece) =>
    piece.glyph ? ({ ...props, t: piece.t, faceRole: "symbolGlyph" } as Run) : ({ ...props, t: piece.t } as Run),
  );
}

export function mapRuns(runs: readonly RunV2[], ctx: InlineCtx): Run[] {
  return runs.flatMap((r) => mapRun(r, ctx));
}

/** InlineV2 -> Inline internal. `text` apa adanya (md-lite mesin). */
export function mapInline(i: InlineV2, ctx: InlineCtx): Inline {
  if ("runs" in i) return { runs: mapRuns(i.runs, ctx) };
  return { text: i.text };
}

export function mapInlineOpt(i: InlineV2 | undefined, ctx: InlineCtx): Inline | undefined {
  return i === undefined ? undefined : mapInline(i, ctx);
}

/** Inline v2 polos (penyusun judul diagram/chart, pesan). */
export function inlineV2Plain(i: InlineV2 | undefined): string {
  if (!i) return "";
  if ("text" in i) return i.text;
  return i.runs.map((r) => ("t" in r ? r.t : "tab" in r ? "\t" : "\n")).join("");
}

export type ApparatusLabel = "key" | "source";

/** Teks run label aparatus persis BM (`FIGURE_LABEL_SPACING`): "KUNCI  ", "SUMBER  ". */
export function apparatusLabelText(kind: ApparatusLabel): string {
  return kind === "key" ? FIGURE_LABELS.key + FIGURE_LABEL_SPACING.keyAfter : FIGURE_LABELS.source + FIGURE_LABEL_SPACING.sourceAfter;
}

/**
 * Inline aparatus (`keyRow`/`source` figur) -> bentuk `runs` dengan run label
 * dibangkitkan dari jenis medan (bukan dari teks). Bentuk `text` dijadikan satu
 * run apa adanya (mesin figur memperlakukan teks aparatus sebagai teks polos,
 * jadi tidak ada md-lite yang hilang) sehingga label TIDAK lagi dideteksi atau
 * dipangkas dari teks agen.
 */
export function apparatusInline(i: InlineV2, kind: ApparatusLabel, ctx: InlineCtx): Inline {
  const content: Run[] = "runs" in i ? mapRuns(i.runs, ctx) : mapRuns([{ t: i.text }], ctx);
  return { runs: [{ t: apparatusLabelText(kind) }, ...content] };
}
