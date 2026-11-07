/**
 * Blok derivation HTML (padanan DOCX S19; RL 03 §3.4).
 *
 * Aritmetika dibangun dan DIPERIKSA ulang terhadap register lewat
 * `buildDerivationBlock` (engine/bind S12). Cacat (kunci tak terdaftar,
 * ekspresi tidak cocok, tanpa `result`/`closing`) dicatat lalu dilempar sebagai
 * `StudioEngineError("BY_CONSTRUCTION_FAILED")`: turunan yang salah tidak
 * pernah dirender diam-diam.
 *
 * Dua perender (`render.derivation.renderer`, R-14):
 * - `monoLines`: baris Mono padanan Python (uraian 54, nilai rata kanan 18),
 *   tanda provenans per baris masukan (P5-49), vonis berwarna.
 * - `nestedTable`: tabel uraian | nilai | tanda/vonis (profil Manual 000 N01/N02).
 * Keduanya di balik garis kiri `rules.derivationLeft*` (0,45 mm signal), menjorok
 * 4,5 mm, ditutup kalimat akibat bila asumsi gagal (P5-50).
 */
import type { DerivationBlock, NormBlock, ProvenanceMark, RenderContext, RunProps } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { buildDerivationBlock, isVerbatimReproduction, type DerivationBuild, type DerivationRow } from "../../bind";
import { provenanceHtml } from "./apparatus";
import { attr, escText } from "./escape";
import { paraHtml } from "./inline";
import { renderVerbatimDerivation } from "./reproduction";
import { color, css, labels, n, pNum, pStr, role, ruleCss, runCss } from "./style";
import { APPARATUS_TEXT, derivationLabelText, verdictTagText, wrapperLangOf } from "../../front/texts";

/** Tag vonis tampilan berbahasa dokumen (S13/F-2); dokumen ID apa adanya. */
function tagText(tag: string, ctx: RenderContext): string {
  return verdictTagText(tag, wrapperLangOf(ctx.snapshot?.doc?.meta));
}

function build(block: NormBlock, d: DerivationBlock, ctx: RenderContext): DerivationBuild {
  const id = d.id ?? block.artifactLabel ?? ctx.snapshot?.numbering?.[block.blockId] ?? "";
  try {
    return buildDerivationBlock(d, ctx.register, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log({ level: "error", message: `engine/html/tables: derivation ${id || block.blockId} gagal dibangun: ${msg}`, code: "BY_CONSTRUCTION_FAILED", address: block.address ?? undefined });
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", msg, { address: block.address, blockId: block.blockId, derivationId: id, key: (e as { key?: string }).key });
  }
}

function markTag(mark: ProvenanceMark | undefined, ctx: RenderContext, run: RunProps): string {
  return mark ? provenanceHtml([mark], ctx, run) : "";
}

function verdictStyle(row: DerivationRow, ctx: RenderContext): string {
  return css(`color:${row.pass ? color(ctx.tpl, "ink900", "ink900") : color(ctx.tpl, "alert", "alert")}`, "font-weight:600");
}

function monoLinesHtml(b: DerivationBuild, ctx: RenderContext): string {
  const p = ctx.tpl.params;
  const rf = role(ctx, "derivation.expr");
  const run: RunProps = { faceRole: "mono", ...(rf.run ?? {}) };
  const markRun: RunProps = { ...run, faceRole: "condensed", caps: true };
  const lines = b.rows.map((r) => {
    let body: string;
    if (r.kind === "verdict" && r.tag && r.mono.endsWith(r.tag)) {
      body = `${escText(r.mono.slice(0, r.mono.length - r.tag.length))}<span style="${escText(verdictStyle(r, ctx))}">${escText(tagText(r.tag, ctx))}</span>`;
    } else {
      body = escText(r.mono);
    }
    const mark = r.kind !== "text" && r.mark ? `<span style="display:inline-block;width:3mm"></span>${markTag(r.mark, ctx, markRun)}` : "";
    const rowCss = r.kind === "result" ? "display:block;font-weight:600" : "display:block";
    return `<span class="st-derivation-line st-derivation-${r.kind}" style="${rowCss}">${body}${mark}</span>`;
  });
  const style = css(runCss(run, p), "white-space:pre", "margin:0", "display:block", paraLineHeight(rf.para?.lineTw));
  return `<div class="st-derivation-mono" style="${escText(style)}">${lines.join("")}</div>`;
}

function paraLineHeight(lineTw: number | undefined): string | undefined {
  return lineTw ? `line-height:${n(lineTw / 20)}pt` : undefined;
}

function nestedTableHtml(b: DerivationBuild, ctx: RenderContext): string {
  const p = ctx.tpl.params;
  const exprRf = role(ctx, "derivation.expr");
  const valRf = role(ctx, "derivation.value");
  const introRf = role(ctx, "derivation.intro");
  const exprRun: RunProps = { faceRole: "mono", ...(exprRf.run ?? {}) };
  const valRun: RunProps = { faceRole: "mono", ...(valRf.run ?? {}) };
  const markRun: RunProps = { faceRole: "condensed", caps: true, ...(exprRf.run?.szHalfPt ? { szHalfPt: exprRf.run.szHalfPt } : {}) };
  const hair = ruleCss(pNum(p, "rules.hairMm", 0.2), color(ctx.tpl, "rules.hair.colour", "ink200"));
  const primary = ruleCss(pNum(p, "rules.primaryMm", 0.45), color(ctx.tpl, "rules.primary.colour", "ink900"));
  const td = (extra?: string): string => css("padding:0.8mm 2.5mm 0.8mm 0", "vertical-align:top", extra);
  const rows = b.rows.map((r, i) => {
    const top = i === 0 ? "" : r.kind === "result" ? `border-top:${primary}` : `border-top:${hair}`;
    if (r.kind === "text") {
      return `<tr style="break-inside:avoid"><td colspan="3" style="${escText(td(top))}">${paraHtml(escText(r.label), introRf.para, runCss(introRf.run ?? {}, p))}</td></tr>`;
    }
    const weight = r.kind === "result" ? "font-weight:600" : undefined;
    const label = paraHtml(escText(r.label), exprRf.para, css(runCss(exprRun, p), weight));
    const expr = r.expr ? paraHtml(escText(`= ${r.expr}`), exprRf.para, css(runCss(exprRun, p), `color:${color(ctx.tpl, "ink400", "ink400")}`)) : "";
    const value = paraHtml(escText(r.value ?? ""), valRf.para, css(runCss(valRun, p), "text-align:right", "white-space:pre", weight));
    const third =
      r.kind === "verdict" && r.tag
        ? `<span style="${escText(verdictStyle(r, ctx))}">${escText(tagText(r.tag, ctx))}</span>`
        : markTag(r.mark, ctx, markRun);
    return (
      `<tr class="st-derivation-${r.kind}" style="break-inside:avoid">` +
      `<td style="${escText(td(top))}">${label}${expr}</td>` +
      `<td style="${escText(td(css(top, "white-space:nowrap")))}">${value}</td>` +
      `<td style="${escText(td(css(top, "white-space:nowrap")))}">${paraHtml(third, undefined)}</td></tr>`
    );
  });
  return `<table class="st-derivation-table" style="border-collapse:collapse;border-spacing:0;width:100%"><colgroup><col><col style="width:28mm"><col style="width:30mm"></colgroup><tbody>${rows.join("")}</tbody></table>`;
}

/** Renderer HtmlBlockRenderer untuk `derivation`. */
export function renderDerivationBlock(block: NormBlock, ctx: RenderContext): string {
  const d = block.content as DerivationBlock | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.lines)) {
    ctx.log({ level: "error", message: "engine/html/tables: isi blok derivation tidak sah", code: "SCHEMA_INVALID", address: block.address ?? undefined });
    throw new StudioEngineError("SCHEMA_INVALID", "Blok derivation tidak sah", { address: block.address, blockId: block.blockId });
  }
  // IP-26: bentuk reproduksi benchmark (S93) hanya diterima bila dokumen
  // bertanda `x.benchmark` DAN turunan verbatim murni; selain itu jalur
  // terverifikasi di bawah (tanpa result() -> BY_CONSTRUCTION_FAILED).
  if (isVerbatimReproduction(ctx.snapshot?.doc, d)) return renderVerbatimDerivation(block, d, ctx);
  const b = build(block, d, ctx);
  const p = ctx.tpl.params;
  const L = labels(ctx);

  const labelRf = role(ctx, "derivation.label");
  const labelRun: RunProps = labelRf.run ?? labelRf.labelRun ?? {
    faceRole: "condensed",
    b: true,
    caps: true,
    szHalfPt: 13,
    spacingTw: 16,
    color: color(ctx.tpl, "signal", "signal").replace(/^#/, ""),
  };
  // S13/F-2: dokumen berbahasa lain tidak mengulang kata depan alamat ID ("Turunan D-n.m") di belakang label bahasanya.
  const lang = wrapperLangOf(ctx.snapshot?.doc?.meta);
  // Row 123 (C40 FIX CP-30, ID p.40 DT-24): the label word prints once. The id may already carry it ("Turunan D-1.1")
  // and the title may repeat the whole label ("Turunan D-1.1 · Beban"); both are dropped by the helper shared with
  // DOCX row 122 (`derivationLabelText`). Before: "Turunan Turunan D-1.1 · Turunan D-1.1 · Beban puncak perangkat".
  const words = [...new Set(Object.values(APPARATUS_TEXT.derivation))].join("|");
  const shownId = b.id.replace(new RegExp(`^(?:${words})\\s+`, "i"), "");
  const head = shownId ? derivationLabelText(shownId, b.title, lang) : [L.derivation, b.title].filter(Boolean).join(" · ");
  const labelHtml = paraHtml(escText(head), labelRf.para, css(runCss(labelRun, p), "margin-bottom:1.8mm", "break-after:avoid"), "st-derivation-label");

  const renderer = pStr(p, "render.derivation.renderer", "monoLines");
  const bodyHtml = renderer === "nestedTable" ? nestedTableHtml(b, ctx) : monoLinesHtml(b, ctx);

  const introRf = role(ctx, "derivation.intro");
  const noteRun: RunProps = { ...(introRf.run ?? {}) };
  const note = paraHtml(escText(b.note), introRf.para, css(runCss(noteRun, p), "margin-top:1.8mm"), "st-derivation-note");

  const left = ruleCss(pNum(p, "rules.derivationLeftMm", 0.45), color(ctx.tpl, "rules.derivationLeft.colour", "signal"));
  const f = d.format;
  const wrap = css(
    `border-left:${left}`,
    "padding-left:4.5mm",
    `margin:${n(f?.spacingBeforeTw !== undefined ? f.spacingBeforeTw / 20 : 8)}pt 0 ${n(f?.spacingAfterTw !== undefined ? f.spacingAfterTw / 20 : 4)}pt 0`,
    "break-inside:avoid",
  );
  const attrs =
    (block.address ? attr("data-address", block.address) : "") +
    (block.blockId ? attr("data-block-id", block.blockId) : "") +
    attr("data-block-type", "derivation") +
    attr("data-derivation-id", b.id) +
    attr("data-renderer", renderer === "nestedTable" ? "nestedTable" : "monoLines");
  return `<div class="st-derivation"${attrs} style="${escText(wrap)}">${labelHtml}${bodyHtml}${note}</div>`;
}
