/**
 * Aparatus tabel/figur HTML (S23): caption di atas, baris SUMBER + PROVENANS
 * di bawah, baris KUNCI figur. Padanan DOCX S17/S19 (DT-15, P5-17..P5-24,
 * P4A-06/07): caption = label (peran `caption.labelRun`) + pemisah
 * (`render.caption.separator`) + teks; SUMBER = label kapital (`labelRun`
 * peran `table.source`/`figure.source`) + isi + `PROVENANS` glif bertanda.
 */
import type { Caption, Inline, NormBlock, ProvenanceMark, RenderContext, RoleKey, RunProps, SourceLine } from "../../../contract";
import { snapApparatusPara } from "../../docx/blocks/rhythm";
import { apparatusLabelRunText, artifactLabelText, keyLineText, provenanceMarkLabelText, wrapperLangOf } from "../../front/texts";
import { escText } from "./escape";
import { inlineHtml, inlinePlain, paraHtml } from "./inline";
import { color, css, fontFamily, hexCss, labels, markColor, markGlyph, pBool, pNum, pStr, role, ruleCss, runCss } from "./style";

/** Label artefak: caption.label > label penomoran blok > numbering snapshot. */
export function artifactLabel(block: NormBlock, ctx: RenderContext, caption?: Caption): string {
  if (caption?.label) return caption.label;
  if (block.artifactLabel) return block.artifactLabel;
  return ctx.snapshot?.numbering?.[block.blockId] ?? "";
}

/**
 * Inline aparatus untuk tampilan: run penanda label ID ("SUMBER  ", "KUNCI  " dari compose) memakai
 * kata bahasa dokumen (S13/F-2). Dokumen ID: objek yang sama dikembalikan (HTML ID byte-sama).
 */
function localizedApparatus<T extends Inline | undefined>(x: T, ctx: RenderContext): T {
  const lang = wrapperLangOf(ctx.snapshot?.doc?.meta);
  if (lang === "ID" || !x || !("runs" in x)) return x;
  return { ...x, runs: x.runs.map((r) => ("t" in r ? { ...r, t: apparatusLabelRunText(r.t, lang) } : r)) } as T;
}

/**
 * C22b / GF-21 (R-74, opt-in): `base` = garis dasar (twip) dari pemanggil (tabel tingkat atas, figur; = DOCX
 * `apparatusParaAdjust`). Dengan `base`, jarak paragraf apparatus dikunci dan leading-nya tetap (GF-21 (a), `snapApparatusPara`,
 * sama dengan DOCX: sebelum ke kisi dengan minimum satu garis dasar, sesudah yang ditulis diganjal ke kisi) dan margin mm tetap
 * HTML (caption 2,2 mm, SUMBER 2,2 mm, KUNCI 1,6 mm) tidak dipasang agar tidak menimpa irama. Tanpa `base` = apa adanya.
 */
function snapped<T extends object>(f: T | undefined, base: number | undefined): T | undefined {
  return base === undefined ? f : (snapApparatusPara(f ?? {}, base) as T);
}

/** Paragraf caption (di atas objek). Label tampil berbahasa dokumen (D-3); alamat tetap. */
export function captionHtml(caption: Caption | undefined, rawLabel: string, ctx: RenderContext, extra?: string, base?: number): string {
  if (!caption) return "";
  const label = artifactLabelText(rawLabel, wrapperLangOf(ctx.snapshot?.doc?.meta));
  const p = ctx.tpl.params;
  const rf = role(ctx, "caption");
  // Row 123 (C40 FIX CP-28, ID p.41 DT-15 "Label caption selalu kapital tebal dengan nomor"): the label is always bold
  // capitals, as DOCX row 122; neither the template role nor labelProps can turn it off (row 98: label not bold).
  const labelRun: RunProps = { ...(rf.labelRun ?? rf.run ?? {}), ...(caption.labelProps ?? {}), b: true, caps: true };
  const sep = caption.separator ?? pStr(p, "render.caption.separator", " ");
  let inner = "";
  if (label) inner += `<span class="st-caption-label" style="${escText(runCss(labelRun, p))}">${escText(label)}</span>`;
  if (label && sep) inner += sep === "\t" ? `<span style="display:inline-block;min-width:3mm">&#9;</span>` : escText(sep);
  inner += inlineHtml(caption.inline, rf.run ?? {}, p, "caption");
  return paraHtml(inner, snapped(caption.format ?? rf.para, base), css("break-after:avoid", base === undefined ? extra : undefined), "st-caption");
}

/**
 * Row 123 (C40 FIX CP-26, ID p.51 DT-10a "Tidak ada unsur yang lebih lebar dari 166 mm"): a SUMBER line stays inside
 * the text span: no wider than 166 mm and broken anywhere rather than run past the edge (row 98: 190.4 mm).
 */
export const SOURCE_SPAN_CSS = "max-width:166mm;overflow-wrap:anywhere";

/**
 * Row 123 (C40 FIX CP-26 + CP-37): CSS of a SUMBER paragraph: the 166 mm span, and the paragraph's own font size =
 * the SUMBER text run, so the separating spaces between the label, text and PROVENANS do not carry the inherited
 * 9.5 pt body size (their line box overlapped the next line by 0.7 mm in the Chromium 1234 print).
 */
export function sourceParagraphCss(ctx: RenderContext, roleKey: RoleKey): string {
  const sz = role(ctx, roleKey).run?.szHalfPt;
  return css(SOURCE_SPAN_CSS, typeof sz === "number" && sz > 0 ? `font-size:${sz / 2}pt` : undefined);
}

const LABEL_LEAD_RE = /^\s*(sumber|source|kunci|key)\b/i;

/** Daftar tanda provenans ber-glif: `■ TERUKUR · ◈ DITURUNKAN`. */
export function provenanceHtml(marks: readonly ProvenanceMark[], ctx: RenderContext, textRun: RunProps): string {
  const p = ctx.tpl.params;
  const rail = role(ctx, "rail.mark");
  const parts: string[] = [];
  for (const m of marks) {
    const glyphRun: RunProps = { faceRole: "symbolGlyph", ...(rail.glyphRun?.[m] ?? {}) };
    const glyphStyle = css(
      `font-family:${fontFamily(glyphRun, p) ?? "sans-serif"}`,
      // Row 123 (C40 FIX CP-37, ID p.52 Tabel 8.3): the glyph takes the size of its label run. Before, it inherited the
      // body size (9.5 pt in a 6.5 pt SUMBER line), so the SUMBER and PROVENANS lines overlapped by 1.8 pt.
      textRun.szHalfPt !== undefined ? `font-size:${textRun.szHalfPt / 2}pt` : undefined,
      `color:${hexCss(glyphRun.color) ?? markColor(ctx.tpl, m)}`,
      "font-style:normal",
    );
    parts.push(
      `<span class="st-mark" data-mark="${escText(m)}"><span style="${escText(glyphStyle)}">${escText(markGlyph(p, m))}</span>` +
        `&#160;<span style="${escText(runCss(textRun, p))}">${escText(provenanceMarkLabelText(m, wrapperLangOf(ctx.snapshot?.doc?.meta)))}</span></span>`,
    );
  }
  return parts.join(" · ");
}

/**
 * Isi baris SUMBER (tanpa elemen pembungkus). Label `SUMBER` ditambahkan bila
 * teks sumber belum diawali kata itu (benchmark kadang menulisnya literal).
 */
export function sourceInner(source: SourceLine, ctx: RenderContext, roleKey: RoleKey): string {
  const src: SourceLine = { ...source, inline: localizedApparatus(source.inline, ctx) };
  const p = ctx.tpl.params;
  const rf = role(ctx, roleKey);
  const L = labels(ctx);
  const textRun = rf.run ?? {};
  const labelRun: RunProps = { ...(rf.labelRun ?? textRun), caps: true, b: rf.labelRun?.b ?? true };
  let inner = "";
  if (!LABEL_LEAD_RE.test(inlinePlain(src.inline))) {
    inner += `<span class="st-source-label" style="${escText(runCss(labelRun, p))}">${escText(L.source)}</span>&#160;&#160;`;
  }
  inner += inlineHtml(src.inline, textRun, p, roleKey);
  const marks = src.provenance ?? [];
  if (marks.length > 0 && pBool(p, "source.glyphKey.include", true)) {
    inner +=
      `<span style="display:inline-block;min-width:4mm"></span>` +
      `<span class="st-source-label" style="${escText(runCss(labelRun, p))}">${escText(L.provenance)}</span>&#160;&#160;` +
      provenanceHtml(marks, ctx, textRun);
  }
  return inner;
}

/** Paragraf SUMBER di bawah objek (garis rambut di atas, pola RL `.src`). */
export function sourceParagraphHtml(src: SourceLine | undefined, ctx: RenderContext, roleKey: RoleKey, ruleAbove: boolean, base?: number): string {
  if (!src) return "";
  const p = ctx.tpl.params;
  const rf = role(ctx, roleKey);
  const hair = ruleAbove ? `border-top:${ruleCss(pNum(p, "rules.hairMm", 0.2), color(ctx.tpl, "rules.hair.colour", "ink200"))};padding-top:1.6mm` : "";
  return paraHtml(sourceInner(src, ctx, roleKey), snapped(src.format ?? rf.para, base), css(base === undefined ? "margin-top:2.2mm" : undefined, hair, "break-before:avoid", sourceParagraphCss(ctx, roleKey)), "st-source");
}

/**
 * Row 123 (C40 FIX CP-35, ID p.13, p.67 Tabel 10.4): an Indonesian document prints its key line in Indonesian: the
 * label KUNCI and the edge kinds named by their line pattern (`keyLineText`); other languages unchanged.
 */
function idKeyLine<T extends Inline | undefined>(x: T, ctx: RenderContext): T {
  const lang = wrapperLangOf(ctx.snapshot?.doc?.meta);
  if (lang !== "ID" || !x) return x;
  if ("text" in x) return { ...x, text: keyLineText(x.text, lang) } as T;
  return { ...x, runs: x.runs.map((r) => ("t" in r ? { ...r, t: keyLineText(r.t, lang) } : r)) } as T;
}

/** Baris KUNCI figur (peran `figure.keyRow`). */
export function keyRowHtml(keyRowIn: Parameters<typeof inlineHtml>[0], ctx: RenderContext, base?: number): string {
  const keyRow = idKeyLine(localizedApparatus(keyRowIn, ctx), ctx);
  if (!keyRow) return "";
  const p = ctx.tpl.params;
  const rf = role(ctx, "figure.keyRow");
  const textRun = rf.run ?? {};
  const labelRun: RunProps = { ...(rf.labelRun ?? textRun), caps: true, b: rf.labelRun?.b ?? true };
  let inner = "";
  if (!LABEL_LEAD_RE.test(inlinePlain(keyRow))) {
    inner += `<span class="st-key-label" style="${escText(runCss(labelRun, p))}">${escText(labels(ctx).key)}</span>&#160;&#160;`;
  }
  inner += inlineHtml(keyRow, textRun, p, "figure.keyRow");
  return paraHtml(inner, snapped(rf.para, base), base === undefined ? "margin-top:1.6mm" : undefined, "st-key");
}
