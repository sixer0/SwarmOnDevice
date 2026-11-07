/**
 * Run dan Inline -> HTML (S22). `runs[]` dirender apa adanya (spasi, tab,
 * baris baru, medan); `text` diurai md-lite seperti HS `datum_docx.py:197-199,
 * 548-575` (**tebal**, `mono`, *miring*, URL/DOI). Semua teks di-escape.
 *
 * URL TIDAK dijadikan `<a href>`: artefak HTML mandiri dilarang membawa
 * rujukan eksternal (S24, KT-11); URL tampil sebagai teks bergaya tautan.
 */
import type { Inline, Run, RunProps } from "../../../contract";
import { HTML_BLOCK_CLASSES as C } from "./classes";
import { attr, escapeHtml } from "./escape";
import { classStyle, runStyle } from "./style";

/** Run internal: Run kontrak + penanda md-lite. */
export type HtmlRun = Run & { url?: boolean; sizeDeltaPt?: number };

const INLINE_RE =
  /(\*\*.+?\*\*|`[^`]+`|\*[^*\n]+(?<!\*)\*(?!\*)|https?:\/\/[^\s|)]+|doi\.org\/[^\s|)<>,;]+|iso\.org\/[^\s|)<>,;]+|(?<![\d./])10\.\d{4}\/[^\s|)<>,;]+)/;

const URL_START = /^(https?:\/\/|doi\.org\/|iso\.org\/|10\.\d{4}\/)/;

export interface MdLiteRoles {
  mono: RunProps;
  bold: RunProps;
  italic: RunProps;
}

export const DEFAULT_MD_ROLES: MdLiteRoles = { mono: { faceRole: "mono" }, bold: { b: true }, italic: { i: true } };

/** Pengurai md-lite (padanan `parseMdLite` S16) ke run HTML. */
export function parseMdLiteHtml(text: string, roles: MdLiteRoles = DEFAULT_MD_ROLES): HtmlRun[] {
  const out: HtmlRun[] = [];
  if (typeof text !== "string" || text.length === 0) return out;
  for (const tok of text.split(INLINE_RE)) {
    if (!tok) continue;
    if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) {
      out.push({ ...roles.bold, t: tok.slice(2, -2) });
    } else if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) {
      out.push({ ...roles.mono, t: tok.slice(1, -1), sizeDeltaPt: roles.mono.szHalfPt === undefined ? -0.8 : 0 });
    } else if (tok.startsWith("*") && tok.endsWith("*") && tok.length > 2) {
      out.push({ ...roles.italic, t: tok.slice(1, -1) });
    } else if (URL_START.test(tok)) {
      const m = /[.,;)]+$/.exec(tok);
      const core = m ? tok.slice(0, m.index) : tok;
      if (core) out.push({ ...roles.mono, t: core, url: true, u: "single", sizeDeltaPt: roles.mono.szHalfPt === undefined ? -0.8 : 0 });
      if (m) out.push({ t: m[0] });
    } else {
      out.push({ t: tok });
    }
  }
  return out;
}

function runProps(r: HtmlRun): RunProps {
  // Medan RunProps saja (tanpa t/tab/br/field/url).
  const { face, faceRole, szHalfPt, color, b, i, caps, spacingTw, u, vertAlign, smallCaps } = r as RunProps & { smallCaps?: boolean };
  const out: RunProps & { smallCaps?: boolean } = { face, faceRole, szHalfPt, color, b, i, caps, spacingTw, u, vertAlign };
  if (smallCaps !== undefined) out.smallCaps = smallCaps;
  return out;
}

function wrap(inner: string, r: HtmlRun, extra: string[] = []): string {
  const st = runStyle(runProps(r), r.sizeDeltaPt ?? 0);
  if (r.url) st.classes.push(C.url);
  const { cls, style } = classStyle([...extra, ...st.classes], st.decl);
  let html = cls || style ? `<span${attr("class", cls)}${attr("style", style)}>${inner}</span>` : inner;
  if (st.vert) html = `<${st.vert}>${html}</${st.vert}>`;
  return html;
}

/** Satu run -> HTML. Gaya dasar paragraf diwarisi lewat CSS; run hanya membawa propertinya sendiri. */
export function runHtml(r: HtmlRun): string {
  if (!r || typeof r !== "object") return "";
  if ("t" in r && typeof r.t === "string") return wrap(escapeHtml(r.t), r);
  if ("tab" in r && r.tab === true) return wrap("\t", r, [C.tab]);
  if ("br" in r && r.br === "line") return "<br>";
  if ("field" in r && (r.field === "PAGE" || r.field === "NUMPAGES")) {
    const st = runStyle(runProps(r));
    const { cls, style } = classStyle([C.field, ...st.classes], st.decl);
    return `<span${attr("class", cls)}${attr("style", style)}${attr("data-field", r.field)}></span>`;
  }
  return "";
}

export function runsHtml(runs: readonly HtmlRun[] | undefined): string {
  if (!Array.isArray(runs)) return "";
  return runs.map(runHtml).join("");
}

/** Transformasi run sebelum ditulis (mis. aturan run semantik templat, `./semantic`). */
export type RunTransform = (runs: readonly HtmlRun[]) => HtmlRun[];

/**
 * Inline (text XOR runs) -> HTML. `text` diurai md-lite; `runs` apa adanya.
 * `transform` (opsional) diterapkan pada run hasil keduanya (RT-01/RQ-5).
 */
export function inlineHtml(inline: Partial<Inline> | undefined, roles: MdLiteRoles = DEFAULT_MD_ROLES, transform?: RunTransform): string {
  if (!inline || typeof inline !== "object") return "";
  const i = inline as { text?: unknown; runs?: unknown };
  let runs: HtmlRun[] | undefined;
  if (Array.isArray(i.runs)) runs = i.runs as HtmlRun[];
  else if (typeof i.text === "string") runs = parseMdLiteHtml(i.text, roles);
  if (!runs) return "";
  return runsHtml(transform ? transform(runs) : runs);
}

/** Teks polos dari Inline (untuk label turunan, mis. kicker otomatis). */
export function inlinePlain(inline: Partial<Inline> | undefined): string {
  if (!inline || typeof inline !== "object") return "";
  const i = inline as { text?: unknown; runs?: unknown };
  if (typeof i.text === "string") return i.text;
  if (Array.isArray(i.runs)) {
    return (i.runs as Run[])
      .map((r) => ("t" in r && typeof r.t === "string" ? r.t : "tab" in r ? "\t" : "br" in r ? "\n" : ""))
      .join("");
  }
  return "";
}

export function hasInline(inline: unknown): inline is Inline {
  if (!inline || typeof inline !== "object") return false;
  const i = inline as { text?: unknown; runs?: unknown };
  return typeof i.text === "string" || Array.isArray(i.runs);
}
