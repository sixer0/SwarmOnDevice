/**
 * Renderer DOCX blok `derivation` (S19; DT-24, P5-48..53).
 *
 * Aritmetika diperiksa ulang terhadap register lewat `buildDerivationBlock`
 * (S12, engine/bind): kunci tak terdaftar, hasil tidak cocok, tanpa `result`,
 * atau tanpa kalimat penutup -> galat konstruksi, blok tidak dirender.
 *
 * Dua bentuk (`render.derivation.renderer`, R-14):
 * - `nestedTable` (profil Manual 000, T034/T050 + N01/N02): tabel 1x1 selebar
 *   kolom teks, garis kiri amber (TCP-20: single sz10 `signal`, tcMar
 *   147/255/147/0), label "Turunan D-n.m · Judul" (RS53), tabel bersarang 2
 *   kolom (uraian Mono | nilai Mono rata kanan + glif tanda per baris), `<w:p/>`,
 *   kalimat penutup (RS54).
 * - `monoLines` (bawaan kanonik, HS `DatumDocx.derivation`): paragraf label,
 *   baris mono padanan Python (lebar 54 + 18) + glif tanda, kalimat penutup;
 *   semua paragraf memakai garis kiri amber yang sama sehingga Word
 *   menyambungnya menjadi satu garis.
 */
import type {
  DerivationBlock,
  DerivationLine,
  DocxBlockRenderer,
  DocxFragment,
  Inline,
  NormBlock,
  ParaFormat,
  ProvenanceMark,
  RenderContext,
  RunProps,
} from "../../../contract";
import { BindDefect, buildDerivationBlock, isVerbatimReproduction, type DerivationBuild, type DerivationRow } from "../../bind";
import { mmToTw } from "../../tokens";
import { facesInXml, simpleTableXml } from "../package/xml";
import { DERIVATION_TITLE_SEPARATOR, FIGURE_LABELS, defaultGlyphRun, figureRole, markGlyph, mergePara, mergeRun, tokenColor } from "./defaults";
import { derivationLabelText, verdictTagText, wrapperLangOf } from "../../front/texts";
import { FIGURES_MODULE, failRender } from "./log";
import { inlineRunsXml, paragraphXml, textRun } from "./ooxml";

/** TCP-20: garis kiri amber dan margin sel blok turunan (twip). */
const RULE_SZ = 10;
const CELL_MARGIN_TW = { top: 147, left: 255, bottom: 147, right: 0 } as const;
/** Lebar tabel bersarang = kolom teks - 4 mm (N01/N02: 7030 tw untuk 128 mm). */
const NESTED_INSET_MM = 4;
/** Kolom nilai = lebar rel bukti (N01/N02: 1814 tw = 32 mm). */
const DEFAULT_VALUE_COL_MM = 32;
/** Ruang garis kiri bentuk monoLines (pt, atribut `w:space`). */
const MONO_RULE_SPACE_PT = 12;

export type DerivationRenderer = "monoLines" | "nestedTable";

/**
 * Kolom teks efektif `grid.textColumnMm` (turunan kertas, A4 128 mm); absen =
 * BY_CONSTRUCTION_FAILED, tanpa cadangan literal A4 (D-245 H1).
 */
function textColumnMm(ctx: RenderContext): number {
  const v = num(ctx.tpl.params["grid.textColumnMm"]);
  if (v === undefined) failRender(ctx, "BY_CONSTRUCTION_FAILED", "Kolom teks tidak terbaca: grid.textColumnMm wajib ada di parameter templat", undefined, { key: "grid.textColumnMm" });
  return v;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** "D-4.1": `block.id` > label penomoran tanpa awalan "Turunan". */
export function derivationId(block: NormBlock, d: DerivationBlock, numbering: Readonly<Record<string, string>>): string | undefined {
  if (d.id) return d.id;
  const label = block.artifactLabel ?? numbering[block.blockId];
  if (!label) return undefined;
  return label.replace(new RegExp(`^${FIGURE_LABELS.derivationPrefix}\\s+`), "").trim() || undefined;
}

function asDerivation(block: NormBlock, ctx: RenderContext): DerivationBlock {
  const c = block.content as Partial<DerivationBlock> | null;
  if (!c || typeof c !== "object" || c.type !== "derivation" || !Array.isArray(c.lines) || !c.title || !c.closing) {
    failRender(ctx, "BY_CONSTRUCTION_FAILED", `Blok ${block.blockId} bukan blok derivation yang lengkap`, block.address ?? undefined);
  }
  return c as DerivationBlock;
}

function build(block: NormBlock, d: DerivationBlock, ctx: RenderContext): DerivationBuild {
  const id = derivationId(block, d, ctx.snapshot.numbering);
  if (!id) {
    failRender(ctx, "BY_CONSTRUCTION_FAILED", `Turunan ${block.blockId} tanpa id (D-C.n) dan tanpa penomoran`, block.address ?? undefined);
  }
  try {
    return buildDerivationBlock(d, ctx.register, id);
  } catch (e) {
    if (e instanceof BindDefect) {
      failRender(ctx, "BY_CONSTRUCTION_FAILED", e.message, block.address ?? undefined, { key: e.key });
    }
    failRender(
      ctx,
      "BY_CONSTRUCTION_FAILED",
      `Turunan ${id} gagal dibangun: ${e instanceof Error ? e.message : String(e)}`,
      block.address ?? undefined,
    );
  }
}

/**
 * Label tampilan "Turunan D-4.1 · Judul" (kata depan berbahasa dokumen, S13/F-2; id = alamat, tetap).
 * Row 122 (C40 FIX CP-30): judul yang sudah memuat label ("Turunan D-4.1 · Judul") tidak mengulang label
 * (helper bersama `front/texts.ts` `derivationLabelText`, juga untuk HTML).
 */
function labelText(b: DerivationBuild, ctx: RenderContext): string {
  return derivationLabelText(b.id, b.title, wrapperLangOf(ctx.snapshot?.doc?.meta), DERIVATION_TITLE_SEPARATOR);
}

interface Roles {
  label: ReturnType<typeof figureRole>;
  intro: ReturnType<typeof figureRole>;
  expr: ReturnType<typeof figureRole>;
  value: ReturnType<typeof figureRole>;
}

function roles(ctx: RenderContext): Roles {
  return {
    label: figureRole(ctx.tpl, "derivation.label"),
    intro: figureRole(ctx.tpl, "derivation.intro"),
    expr: figureRole(ctx.tpl, "derivation.expr"),
    value: figureRole(ctx.tpl, "derivation.value"),
  };
}

function glyphXml(mark: ProvenanceMark | undefined, ctx: RenderContext, r: Roles, base: RunProps): string {
  if (!mark) return "";
  const props = mergeRun(base, defaultGlyphRun(ctx.tpl), r.value.glyphRun?.[mark]);
  return textRun(markGlyph(ctx.tpl.params, mark), props, ctx.tpl.params);
}

/** Run vonis: MEMENUHI berwarna verd, TIDAK MEMENUHI berwarna alert. */
function verdictTagXml(row: DerivationRow, base: RunProps, ctx: RenderContext): string {
  if (row.kind !== "verdict" || !row.tag) return "";
  const color = tokenColor(ctx.tpl, row.pass ? "verd" : "alert");
  return textRun(`   ${verdictTagText(row.tag, wrapperLangOf(ctx.snapshot?.doc?.meta))}`, mergeRun(base, { b: true, color }), ctx.tpl.params);
}

// ── nestedTable ──────────────────────────────────────────────────────────

function nestedTableXml(b: DerivationBuild, d: DerivationBlock, ctx: RenderContext, r: Roles): string {
  const p = ctx.tpl.params;
  const textColMm = textColumnMm(ctx);
  const outerTw = mmToTw(textColMm);
  const innerTw = mmToTw(textColMm - NESTED_INSET_MM);
  const valueTw = Math.min(mmToTw(num(p["grid.evidenceRailMm"]) ?? DEFAULT_VALUE_COL_MM), Math.round(innerTw / 2));
  const labelTw = innerTw - valueTw;

  const exprRun = mergeRun(r.expr.run, d.runDefaults);
  const valueRun = mergeRun(r.value.run, d.runDefaults);
  const rows = b.rows
    .filter((row) => row.kind !== "text")
    .map((row) => [
      {
        widthTw: labelTw,
        paragraphsXml: paragraphXml(r.expr.para, textRun(row.label, exprRun, p) + verdictTagXml(row, exprRun, ctx)),
      },
      {
        widthTw: valueTw,
        paragraphsXml: paragraphXml(
          mergePara(r.value.para),
          textRun(row.mark ? `${row.value ?? ""} ` : (row.value ?? ""), valueRun, p) + glyphXml(row.mark, ctx, r, valueRun),
        ),
      },
    ]);

  const intro = b.rows.find((row) => row.kind === "text");
  let cellXml = paragraphXml(mergePara(r.label.para, d.format), textRun(labelText(b, ctx), r.label.run ?? {}, p));
  if (intro) cellXml += paragraphXml(mergePara(r.intro.para, { spacingBeforeTw: 0, spacingAfterTw: 40 }), textRun(intro.label, r.intro.run ?? {}, p));
  if (rows.length > 0) cellXml += simpleTableXml([labelTw, valueTw], rows) + "<w:p/>";
  cellXml += paragraphXml(r.intro.para, textRun(b.note, mergeRun(r.intro.run, d.runDefaults), p));

  const amber = tokenColor(ctx.tpl, "signal");
  return simpleTableXml(
    [outerTw],
    [
      [
        {
          widthTw: outerTw,
          paragraphsXml: cellXml,
          borders: { left: { val: "single", sz: RULE_SZ, space: 0, color: amber } },
          marginsTw: { ...CELL_MARGIN_TW },
        },
      ],
    ],
  );
}

// ── monoLines ────────────────────────────────────────────────────────────

function monoLinesXml(b: DerivationBuild, d: DerivationBlock, ctx: RenderContext, r: Roles): string {
  const p = ctx.tpl.params;
  const amber = tokenColor(ctx.tpl, "signal");
  const rule: ParaFormat = {
    borders: { left: { val: "single", sz: RULE_SZ, space: MONO_RULE_SPACE_PT, color: amber } },
    indLeftTw: CELL_MARGIN_TW.left,
  };
  const keep: ParaFormat = { keepNext: true, keepLines: true };
  const exprRun = mergeRun(r.expr.run, d.runDefaults);

  let xml = paragraphXml(mergePara(r.label.para, d.format, rule, keep, { spacingBeforeTw: CELL_MARGIN_TW.top }), textRun(labelText(b, ctx), r.label.run ?? {}, p));
  for (const row of b.rows) {
    if (row.kind === "text") {
      xml += paragraphXml(mergePara(r.intro.para, rule, keep, { spacingBeforeTw: 0, spacingAfterTw: 40 }), textRun(row.label, r.intro.run ?? {}, p));
      continue;
    }
    const mono = row.kind === "verdict" && row.tag ? row.mono.slice(0, row.mono.length - row.tag.length).trimEnd() : row.mono;
    xml += paragraphXml(
      mergePara(r.expr.para, rule, keep),
      textRun(mono, exprRun, p) + (row.mark ? textRun(" ", exprRun, p) + glyphXml(row.mark, ctx, r, exprRun) : "") + verdictTagXml(row, exprRun, ctx),
    );
  }
  xml += paragraphXml(
    mergePara(r.intro.para, rule, { spacingAfterTw: CELL_MARGIN_TW.bottom }),
    textRun(b.note, mergeRun(r.intro.run, d.runDefaults), p),
  );
  return xml;
}

// ── Reproduksi benchmark (D-79) ─────────────────────────────────────────

/*
 * Mode reproduksi benchmark (D-79, D-91, D-98). Predikat SATU SUMBER
 * `isVerbatimReproduction(doc, block)` di `engine/bind/reproduction.ts`
 * (INT-M; sama dengan mesin HTML): dokumen bertanda `x.benchmark` DAN
 * turunan verbatim murni (tanpa `result`/`verdict`, nilai baris Inline bukan
 * `registerKey`, `title`/`closing` berisi teks). Selain itu
 * `buildDerivationBlock` S12 tetap berlaku dan turunan tanpa `result()`
 * tetap DITOLAK. Tata letak C8: judul, [intro], tabel uraian | nilai + glif
 * tanda, `<w:p/>`, penutup; run apa adanya (C1) tanpa prefiks tambahan.
 */

/** Kode log (bukan StudioErrorCode) saat turunan dirender verbatim (= HTML). */
export const RENDER_DERIVATION_VERBATIM = "RENDER_DERIVATION_VERBATIM";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Format paragraf medan Inline-only: `fieldFormats` kontrak (G-06), lalu jejak S93 `x.<medan>Format`. */
function xFormat(d: DerivationBlock, field: "title" | "intro" | "closing"): ParaFormat | undefined {
  const ff = d.fieldFormats as Record<string, ParaFormat | undefined> | undefined;
  if (ff && isRecord(ff[field])) return ff[field];
  const v = isRecord(d.x) ? d.x[`${field}Format`] : undefined;
  return isRecord(v) ? (v as ParaFormat) : undefined;
}

function inlineXml(i: Inline | undefined, base: RunProps | undefined, ctx: RenderContext): string {
  return i ? inlineRunsXml(i, base ?? {}, ctx.tpl.params) : "";
}

function verbatimValueXml(l: DerivationLine, valueRun: RunProps, ctx: RenderContext, r: Roles): string {
  const v = l.value && !("registerKey" in l.value) ? (l.value as Inline) : undefined;
  return inlineXml(v, valueRun, ctx) + glyphXml(l.mark, ctx, r, valueRun);
}

function verbatimNestedTableXml(d: DerivationBlock, ctx: RenderContext, r: Roles): string {
  const p = ctx.tpl.params;
  const textColMm = textColumnMm(ctx);
  const outerTw = mmToTw(textColMm);
  const innerTw = mmToTw(textColMm - NESTED_INSET_MM);
  const valueTw = Math.min(mmToTw(num(p["grid.evidenceRailMm"]) ?? DEFAULT_VALUE_COL_MM), Math.round(innerTw / 2));
  const labelTw = innerTw - valueTw;
  const exprRun = mergeRun(r.expr.run, d.runDefaults);
  const valueRun = mergeRun(r.value.run, d.runDefaults);

  // C8: sel = judul, [intro], tabel baris bersarang, <w:p/> (KT-19), penutup.
  let cellXml = paragraphXml(mergePara(r.label.para, xFormat(d, "title"), d.format), inlineXml(d.title, r.label.run, ctx));
  if (d.intro) {
    cellXml += paragraphXml(mergePara(r.intro.para, { spacingBeforeTw: 0, spacingAfterTw: 40 }, xFormat(d, "intro")), inlineXml(d.intro, r.intro.run, ctx));
  }
  const rows = d.lines.map((l) => [
    { widthTw: labelTw, paragraphsXml: paragraphXml(r.expr.para, inlineXml(l.label, exprRun, ctx)) },
    { widthTw: valueTw, paragraphsXml: paragraphXml(mergePara(r.value.para), verbatimValueXml(l, valueRun, ctx, r)) },
  ]);
  if (rows.length > 0) cellXml += simpleTableXml([labelTw, valueTw], rows) + "<w:p/>";
  cellXml += paragraphXml(mergePara(r.intro.para, xFormat(d, "closing")), inlineXml(d.closing, mergeRun(r.intro.run, d.runDefaults), ctx));

  const amber = tokenColor(ctx.tpl, "signal");
  return simpleTableXml(
    [outerTw],
    [[{ widthTw: outerTw, paragraphsXml: cellXml, borders: { left: { val: "single", sz: RULE_SZ, space: 0, color: amber } }, marginsTw: { ...CELL_MARGIN_TW } }]],
  );
}

function verbatimMonoLinesXml(d: DerivationBlock, ctx: RenderContext, r: Roles): string {
  const amber = tokenColor(ctx.tpl, "signal");
  const rule: ParaFormat = { borders: { left: { val: "single", sz: RULE_SZ, space: MONO_RULE_SPACE_PT, color: amber } }, indLeftTw: CELL_MARGIN_TW.left };
  const keep: ParaFormat = { keepNext: true, keepLines: true };
  const exprRun = mergeRun(r.expr.run, d.runDefaults);
  let xml = paragraphXml(
    mergePara(r.label.para, xFormat(d, "title"), d.format, rule, keep, { spacingBeforeTw: CELL_MARGIN_TW.top }),
    inlineXml(d.title, r.label.run, ctx),
  );
  if (d.intro) xml += paragraphXml(mergePara(r.intro.para, rule, keep, { spacingBeforeTw: 0, spacingAfterTw: 40 }), inlineXml(d.intro, r.intro.run, ctx));
  for (const l of d.lines) {
    xml += paragraphXml(mergePara(r.expr.para, rule, keep), inlineXml(l.label, exprRun, ctx) + textRun(" ", exprRun, ctx.tpl.params) + verbatimValueXml(l, exprRun, ctx, r));
  }
  xml += paragraphXml(
    mergePara(r.intro.para, xFormat(d, "closing"), rule, { spacingAfterTw: CELL_MARGIN_TW.bottom }),
    inlineXml(d.closing, mergeRun(r.intro.run, d.runDefaults), ctx),
  );
  return xml;
}

export const renderDerivation: DocxBlockRenderer = (block: NormBlock, ctx: RenderContext): DocxFragment => {
  const d = asDerivation(block, ctx);
  const r = roles(ctx);
  const mode: DerivationRenderer = ctx.tpl.params["render.derivation.renderer"] === "nestedTable" ? "nestedTable" : "monoLines";
  if (isVerbatimReproduction(ctx.snapshot?.doc, d)) {
    // Mode reproduksi: baris ditulis apa adanya; tidak ada aritmetika yang dapat diuji (D-79/D-91).
    ctx.log({
      level: "info",
      code: RENDER_DERIVATION_VERBATIM,
      message: `${FIGURES_MODULE}: turunan ${block.blockId} dirender verbatim (mode reproduksi benchmark)`,
      address: block.address ?? undefined,
      at: ctx.fixedDate,
    });
    const vx = mode === "nestedTable" ? verbatimNestedTableXml(d, ctx, r) : verbatimMonoLinesXml(d, ctx, r);
    return { xml: vx, facesUsed: facesInXml(vx) };
  }
  const b = build(block, d, ctx);
  const xml = mode === "nestedTable" ? nestedTableXml(b, d, ctx, r) : monoLinesXml(b, d, ctx, r);
  return { xml, facesUsed: facesInXml(xml) };
};
