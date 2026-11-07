/**
 * Inline kontrak (md-lite `text` XOR `runs[]`) -> HTML untuk sel, caption,
 * baris sumber, dan derivation (S23). Semua teks di-escape; tidak ada medan
 * HTML mentah (KS-08).
 *
 * md-lite mengikuti KS-03 (`DatumDocx.para()`): `**tebal**`, `` `mono` ``,
 * `*miring*`, URL `https?://`, `doi.org/`, `iso.org/`, DOI `10.dddd/`; tanpa
 * escape. URL ditulis sebagai teks Mono, bukan tautan (artefak tanpa rujukan
 * eksternal, S24).
 */
import type { Inline, ParaFormat, ParamMap, RoleKey, Run, RunProps } from "../../../contract";
import { symbolBoundRuns } from "../blocks/semantic";
import { escText } from "./escape";
import { paraCss, runCss } from "./style";

const MD_RE =
  /\*\*([^*]+?)\*\*|`([^`]+)`|\*([^*\s][^*]*?)\*|((?:https?:\/\/|doi\.org\/|iso\.org\/)[^\s<>()]*[^\s<>().,;:]|\b10\.\d{4,9}\/[^\s<>]*[^\s<>().,;:])/g;

/** Urai md-lite menjadi run (teks apa adanya, termasuk spasi). */
export function parseMdLite(text: string): Run[] {
  const out: Run[] = [];
  let last = 0;
  MD_RE.lastIndex = 0;
  for (let m = MD_RE.exec(text); m !== null; m = MD_RE.exec(text)) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: m[1], b: true });
    else if (m[2] !== undefined) out.push({ t: m[2], faceRole: "mono" });
    else if (m[3] !== undefined) out.push({ t: m[3], i: true });
    else if (m[4] !== undefined) out.push({ t: m[4], faceRole: "mono" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

function runProps(r: Run): RunProps {
  const rest: Record<string, unknown> = { ...r };
  delete rest.t;
  delete rest.tab;
  delete rest.br;
  delete rest.field;
  return rest as RunProps;
}

function span(style: string, inner: string): string {
  return style ? `<span style="${escText(style)}">${inner}</span>` : inner;
}

/** Run -> HTML. `base` = format peran; properti run menimpa. */
export function runsHtml(runs: readonly Run[], base: RunProps, params: ParamMap): string {
  let html = "";
  for (const r of runs) {
    const props: RunProps = { ...base, ...runProps(r) };
    // Bila run hanya menyatakan faceRole, `face` dasar tidak boleh menimpanya.
    if ("faceRole" in r && r.faceRole && !("face" in r)) delete props.face;
    if ("face" in r && r.face && !("faceRole" in r)) delete props.faceRole;
    if ("t" in r) html += span(runCss(props, params), escText(r.t));
    else if ("tab" in r) html += span(runCss(props, params), "&#9;");
    else if ("br" in r) html += "<br>";
    // Medan PAGE/NUMPAGES tidak bermakna di fragmen tabel HTML; dilewati.
  }
  return html;
}

/**
 * Inline -> HTML isi (tanpa elemen paragraf). `role` = peran inang run:
 * glif simbol sebaris pada `runs` mendapat `render.run.symbolGlyphByRole[role]`
 * (R-37, paritas DOCX `assemble/bind.ts`; RQ-5).
 */
export function inlineHtml(x: Inline | undefined, base: RunProps, params: ParamMap, role?: RoleKey): string {
  if (!x) return "";
  if ("runs" in x && Array.isArray(x.runs)) return runsHtml(symbolBoundRuns(x.runs, params, role), base, params);
  if ("text" in x && typeof x.text === "string") return runsHtml(parseMdLite(x.text), base, params);
  return "";
}

/** Teks polos Inline (untuk alt/aria/data-*). */
export function inlinePlain(x: Inline | undefined): string {
  if (!x) return "";
  if ("runs" in x && Array.isArray(x.runs)) {
    return x.runs.map((r) => ("t" in r ? r.t : "tab" in r ? "\t" : "br" in r ? "\n" : "")).join("");
  }
  if ("text" in x && typeof x.text === "string") return parseMdLite(x.text).map((r) => ("t" in r ? r.t : "")).join("");
  return "";
}

/** Elemen paragraf (`p` atau `div`) dengan CSS paragraf + tambahan. */
export function paraHtml(inner: string, f: ParaFormat | undefined, extra?: string, cls?: string): string {
  const style = [paraCss(f), extra].filter(Boolean).join(";");
  const c = cls ? ` class="${escText(cls)}"` : "";
  return `<p${c} style="${escText(style)}">${inner.length > 0 ? inner : "&#160;"}</p>`;
}
