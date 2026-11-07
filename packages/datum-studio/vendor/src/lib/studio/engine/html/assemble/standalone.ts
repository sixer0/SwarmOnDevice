/**
 * Penjaga artefak HTML mandiri (S24, KT-11, D-38): satu berkas, tanpa skrip,
 * tanpa rujukan eksternal; aset hanya data: URI.
 *
 * Dua lapis:
 * 1. Content-Security-Policy `<meta>` di awal `<head>`: melarang skrip dan
 *    semua sumber eksternal; hanya gaya inline dan data: untuk gambar/fon.
 * 2. `enforceStandalone` menetralkan konstruksi terlarang yang lolos dari
 *    renderer hulu (seharusnya tidak pernah ada) dan MELAPORKANNYA sebagai
 *    pelanggaran, agar perakit mencatatnya di log job (tidak diam).
 *
 * Pemindaian hanya menyentuh tag nyata: teks isi sudah di-escape renderer
 * (`<`, `>`, kutip menjadi entitas), sehingga prosa yang memuat "src=" atau
 * "url(" tidak pernah diubah. `url(...)` hanya diperiksa di dalam elemen
 * `<style>` dan nilai atribut.
 */

/** Kebijakan CSP artefak HTML Studio. `frame-ancestors` tidak berlaku lewat meta, sengaja tidak ada. */
export const STUDIO_HTML_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "script-src-attr 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "connect-src 'none'",
  "manifest-src 'none'",
  "media-src 'none'",
  "img-src data:",
  "font-src data:",
  "style-src 'unsafe-inline'",
].join("; ");

export const STUDIO_HTML_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${STUDIO_HTML_CSP}">`;

export type StandaloneViolationKind =
  | "forbiddenElement"
  | "eventHandler"
  | "externalUrl"
  | "cssImport"
  | "metaRefresh";

export interface StandaloneViolation {
  kind: StandaloneViolationKind;
  /** Potongan ringkas (maks 120 karakter) untuk log; tanpa isi base64 panjang. */
  detail: string;
}

/** Elemen dengan isi yang dibuang utuh. */
const PAIRED_FORBIDDEN = ["script", "iframe", "object", "applet", "portal", "frameset", "noembed", "template"] as const;
/** Elemen (void atau tak berpasangan) yang tagnya dibuang. */
const TAG_FORBIDDEN = new Set([...PAIRED_FORBIDDEN, "embed", "frame", "base", "link"]);

/** Atribut bernilai URL. */
const URL_ATTRS = new Set([
  "href",
  "xlink:href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "data",
  "background",
  "ping",
  "cite",
  "longdesc",
  "manifest",
  "codebase",
  "archive",
]);

/** data: URI yang boleh: gambar dan fon saja. */
const ALLOWED_DATA_URI =
  /^data:(?:image\/(?:png|jpeg|gif|webp|svg\+xml)|font\/[a-z0-9.+-]+|application\/(?:font-woff2?|font-sfnt|x-font-(?:ttf|truetype|otf|opentype|woff2?)|vnd\.ms-opentype|octet-stream))[;,]/i;

function short(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

function decodeAttrEntities(v: string): string {
  return v
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Target URL yang boleh: fragmen internal (`#id`) atau data: gambar/fon. */
export function isAllowedUrl(raw: string): boolean {
  const v = decodeAttrEntities(raw).trim();
  if (v === "" || v.startsWith("#")) return true;
  return ALLOWED_DATA_URI.test(v);
}

/** Netralkan `url(...)` ke target terlarang dan `@import` di teks CSS. */
function sanitizeCss(css: string, violations: StandaloneViolation[]): string {
  let out = css.replace(/@import\b[^;]*;?/gi, (m) => {
    violations.push({ kind: "cssImport", detail: short(m) });
    return "";
  });
  out = out.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|&quot;(.*?)&quot;|&#39;(.*?)&#39;|([^)]*?))\s*\)/gi, (m, a, b, c, d, e) => {
    const target = String(a ?? b ?? c ?? d ?? e ?? "");
    if (isAllowedUrl(target)) return m;
    violations.push({ kind: "externalUrl", detail: short(`url(${target})`) });
    return "none";
  });
  return out;
}

const ATTR_RE = /(\s+)([^\s"'>/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Periksa satu tag pembuka; kembalikan tag (mungkin diubah) atau "" bila dibuang. */
function sanitizeTag(tag: string, name: string, attrs: string, selfClose: string, violations: StandaloneViolation[]): string {
  const lower = name.toLowerCase();
  if (TAG_FORBIDDEN.has(lower)) {
    violations.push({ kind: "forbiddenElement", detail: short(tag) });
    return "";
  }
  if (lower === "meta" && /http-equiv\s*=\s*["']?\s*refresh/i.test(attrs)) {
    violations.push({ kind: "metaRefresh", detail: short(tag) });
    return "";
  }
  let changed = false;
  const rebuilt = attrs.replace(ATTR_RE, (m, ws: string, an: string, eq?: string, dq?: string, sq?: string, uq?: string) => {
    const attrName = an.toLowerCase();
    const value = dq ?? sq ?? uq;
    if (/^on/.test(attrName)) {
      violations.push({ kind: "eventHandler", detail: short(`<${name} ${an}>`) });
      changed = true;
      return "";
    }
    if (value === undefined) return m;
    if (URL_ATTRS.has(attrName)) {
      const targets = attrName === "srcset" ? value.split(",").map((p) => p.trim().split(/\s+/)[0] ?? "") : [value];
      const bad = targets.find((t) => !isAllowedUrl(t));
      if (bad !== undefined) {
        violations.push({ kind: "externalUrl", detail: short(`<${name} ${an}="${bad}">`) });
        changed = true;
        return "";
      }
      return m;
    }
    if (/url\(|@import/i.test(value)) {
      const clean = sanitizeCss(value, violations);
      if (clean !== value) {
        changed = true;
        const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
        return `${ws}${an}${eq ?? "="}${q}${clean}${q}`;
      }
    }
    return m;
  });
  return changed ? `<${name}${rebuilt}${selfClose}>` : tag;
}

/**
 * Netralkan skrip, handler event, rujukan eksternal, `@import`, dan meta refresh.
 * Keluaran identik byte bila tidak ada pelanggaran.
 */
export function enforceStandalone(html: string): { html: string; violations: StandaloneViolation[] } {
  const violations: StandaloneViolation[] = [];
  let out = html;
  for (const el of PAIRED_FORBIDDEN) {
    const re = new RegExp(`<${el}\\b[^>]*>[\\s\\S]*?<\\/${el}\\s*>`, "gi");
    out = out.replace(re, (m) => {
      violations.push({ kind: "forbiddenElement", detail: short(m) });
      return "";
    });
  }
  // Isi <style>: url() dan @import.
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open: string, css: string, close: string) => {
    const clean = sanitizeCss(css, violations);
    return clean === css ? m : `${open}${clean}${close}`;
  });
  // Tag pembuka (termasuk SVG). Teks isi sudah ter-escape, jadi pola ini hanya mengenai tag nyata.
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g, (tag, name: string, attrs: string, selfClose: string) =>
    sanitizeTag(tag, name, attrs, selfClose, violations),
  );
  // Tag penutup yatim elemen terlarang.
  out = out.replace(/<\/(script|iframe|object|applet|portal|frameset|noembed|template|embed|frame)\s*>/gi, (m) => {
    violations.push({ kind: "forbiddenElement", detail: short(m) });
    return "";
  });
  return { html: out, violations };
}

/**
 * Sisipkan `<meta charset>`, CSP, dan `extraHead` di awal `<head>`. `<meta charset>`
 * lain dibuang agar deklarasi charset tetap di 1024 bait pertama.
 * Dokumen tanpa `<head>`/`<html>` dibungkus kerangka minimal.
 */
export function injectHead(html: string, extraHead: string): string {
  const lead = `<meta charset="utf-8">${STUDIO_HTML_CSP_META}${extraHead}`;
  const stripped = html.replace(/<meta\s+charset\s*=\s*["']?[^"'>\s]*["']?\s*\/?>/gi, "");
  const head = /<head\b[^>]*>/i.exec(stripped);
  if (head) return `${stripped.slice(0, head.index + head[0].length)}${lead}${stripped.slice(head.index + head[0].length)}`;
  const htmlTag = /<html\b[^>]*>/i.exec(stripped);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${stripped.slice(0, at)}<head>${lead}</head>${stripped.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(stripped);
  const rest = doctype ? stripped.slice(doctype[0].length) : stripped;
  return `<!DOCTYPE html><html><head>${lead}</head><body>${rest}</body></html>`;
}
