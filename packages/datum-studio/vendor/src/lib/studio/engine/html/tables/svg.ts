/**
 * Sanitasi SVG tak tepercaya untuk penyisipan INLINE di HTML (S23), plus
 * pengode data URI raster.
 *
 * Tokenizer berbasis string (tanpa DOM): setiap tag dibangun ulang dari daftar
 * putih struktur, bukan disalin mentah.
 * - Elemen dibuang beserta subpohonnya: `script`, `foreignObject`, elemen
 *   animasi (`set`, `animate*`, dapat menulis `href`), `iframe`, `object`,
 *   `embed`, media, `handler`, `listener`, `discard`.
 * - Atribut dibuang: `on*`, `href`/`xlink:href`/`src` yang bukan `#id` lokal
 *   atau data URI raster (png/jpeg/gif/webp), nilai apa pun yang memuat
 *   `javascript:`/`vbscript:`, `url(...)` yang bukan `#id` atau data URI raster.
 * - `<style>` dibuang utuh: CSS di SVG inline tidak berlingkup dan akan bocor
 *   ke seluruh halaman (produsen chart/diagram DATUM memakai atribut, bukan CSS).
 * - Komentar, instruksi pemrosesan, DOCTYPE (termasuk deklarasi ENTITY) dibuang.
 * - `id` dan rujukan lokal (`#id`, `url(#id)`) diberi prefiks per figur agar
 *   beberapa SVG inline dalam satu halaman tidak bertabrakan.
 * Teks SVG tetap teks nyata (`<text>`), tidak dirasterisasi.
 */
import { escText, safeIdent } from "./escape";
import { n } from "./style";

/** Elemen yang dibuang beserta seluruh isinya. */
export const SVG_DROPPED_ELEMENTS: readonly string[] = [
  "script",
  "style",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "canvas",
  "handler",
  "listener",
  "set",
  "animate",
  "animatemotion",
  "animatetransform",
  "animatecolor",
  "discard",
  "html",
  "body",
  "meta",
  "link",
  "base",
];

const DROPPED = new Set(SVG_DROPPED_ELEMENTS);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const RASTER_DATA_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;
const HREF_ATTRS = new Set(["href", "xlink:href", "src"]);

export interface SvgSanitizeOptions {
  /** Prefiks id lokal (mis. id blok). */
  idPrefix: string;
  /** Lebar/tinggi root ditulis ulang ke mm bila diberikan. */
  widthMm?: number;
  heightMm?: number;
  /** aria-label root bila root belum punya. */
  ariaLabel?: string;
}

export interface SvgSanitizeResult {
  svg: string;
  /** Hitungan unsur yang dibuang (untuk log). */
  removed: { elements: number; attributes: number };
}

const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Dekode entitas dasar + numerik; entitas bernama lain dibiarkan literal. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,31});/g, (all, ent: string) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "";
      return String.fromCodePoint(cp);
    }
    return NAMED[ent] ?? all;
  });
}

/** Normalisasi untuk deteksi skema berbahaya (hapus spasi/kendali, huruf kecil). */
function squash(s: string): string {
  return s.replace(/[\u0000- \u007F-\u009F]+/g, "").toLowerCase();
}

function isDangerous(value: string): boolean {
  const q = squash(value);
  return q.includes("javascript:") || q.includes("vbscript:") || q.includes("data:text/html") || q.includes("expression(");
}

/** Tulis ulang `url(#id)` dengan prefiks; null bila ada `url()` non-lokal/non-raster. */
function rewriteUrls(value: string, prefix: string): string | null {
  let bad = false;
  const out = value.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_all: string, _q: string, target: string) => {
    const t = target.trim();
    if (t.startsWith("#")) return `url(#${prefix}${t.slice(1)})`;
    if (RASTER_DATA_RE.test(t)) return `url("${t.replace(/\s+/g, "")}")`;
    bad = true;
    return "none";
  });
  // `url(` yang tidak terurai pola di atas (kutip ganjil dsb.) dianggap tidak aman.
  if (!bad && /url\(\s*['"]?\s*(?!#|data:image\/)/i.test(out.replace(/url\(#[^)]*\)|url\("data:image\/[^"]*"\)/gi, ""))) bad = true;
  return bad ? null : out;
}

interface Tag {
  name: string;
  close: boolean;
  selfClose: boolean;
  attrs: Array<[string, string]>;
}

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseTag(raw: string): Tag | null {
  const m = /^<\s*(\/)?\s*([^\s/>]+)([\s\S]*?)(\/)?\s*>$/.exec(raw);
  if (!m) return null;
  const attrs: Array<[string, string]> = [];
  if (!m[1]) {
    const body = m[3] ?? "";
    ATTR_RE.lastIndex = 0;
    for (let a = ATTR_RE.exec(body); a !== null; a = ATTR_RE.exec(body)) {
      attrs.push([a[1], a[2] ?? a[3] ?? a[4] ?? ""]);
    }
  }
  return { name: m[2], close: !!m[1], selfClose: !!m[4], attrs };
}

/** Bersihkan satu atribut; null = buang. */
function cleanAttr(name: string, rawValue: string, prefix: string): string | null {
  const ln = name.toLowerCase();
  if (!NAME_RE.test(name) || ln.startsWith("on") || ln === "src") return null;
  let value = decodeEntities(rawValue);
  if (isDangerous(value)) return null;
  if (HREF_ATTRS.has(ln) || ln.endsWith(":href")) {
    const v = value.trim();
    if (v.startsWith("#")) return `#${prefix}${v.slice(1)}`;
    if (RASTER_DATA_RE.test(v)) return v.replace(/\s+/g, "");
    return null;
  }
  if (ln === "id") return `${prefix}${value}`;
  if (/url\s*\(/i.test(value)) {
    const r = rewriteUrls(value, prefix);
    if (r === null) return null;
    value = r;
  }
  return value;
}

/**
 * Bersihkan SVG. Masukan tanpa elemen root `<svg>` menghasilkan string kosong
 * (pemanggil menulis placeholder dan log).
 */
export function sanitizeSvg(input: string, opts: SvgSanitizeOptions): SvgSanitizeResult {
  const prefix = `${safeIdent(opts.idPrefix)}-`;
  const removed = { elements: 0, attributes: 0 };
  const src = String(input);
  const start = src.search(/<svg[\s>/]/i);
  if (start < 0) return { svg: "", removed };
  const body = src.slice(start);

  const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<![^>]*>|<\?[\s\S]*?(?:\?>|$)|<\/?[A-Za-z_][^>]*>|[^<]+|</g;
  let out = "";
  /** Nama elemen terbuang yang sedang dilewati + kedalaman sarang namanya. */
  let dropName: string | null = null;
  let dropDepth = 0;
  let rootSeen = false;
  /** Elemen terbuka: nama huruf kecil (pencocokan) + nama asli (keluaran, mis. clipPath). */
  const stack: Array<{ l: string; name: string }> = [];

  for (let m = TOKEN_RE.exec(body); m !== null; m = TOKEN_RE.exec(body)) {
    const tok = m[0];
    if (tok.startsWith("<![CDATA[")) {
      if (dropName === null) out += escText(m[1] ?? "");
      continue;
    }
    if (tok.startsWith("<!") || tok.startsWith("<?")) continue; // komentar, DOCTYPE/ENTITY, PI
    if (tok === "<") {
      if (dropName === null) out += "&lt;";
      continue;
    }
    if (!tok.startsWith("<")) {
      if (dropName === null) out += escText(decodeEntities(tok));
      continue;
    }
    const tag = parseTag(tok);
    if (!tag) continue;
    const lname = tag.name.toLowerCase();

    if (dropName !== null) {
      if (lname === dropName && !tag.selfClose) {
        dropDepth += tag.close ? -1 : 1;
        if (dropDepth === 0) dropName = null;
      }
      continue;
    }
    if (!NAME_RE.test(tag.name)) {
      removed.elements++;
      continue;
    }
    if (tag.close) {
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].l === lname) {
          idx = i;
          break;
        }
      }
      if (idx < 0) continue; // tag tutup liar diabaikan
      while (stack.length > idx) out += `</${(stack.pop() as { name: string }).name}>`;
      if (stack.length === 0) break; // root selesai
      continue;
    }
    if (DROPPED.has(lname)) {
      removed.elements++;
      if (!tag.selfClose) {
        dropName = lname;
        dropDepth = 1;
      }
      continue;
    }
    const isRoot = !rootSeen;
    if (isRoot && lname !== "svg") return { svg: "", removed };
    rootSeen = true;

    let attrs = "";
    let hasAria = false;
    let hasXmlns = false;
    for (const [name, rawValue] of tag.attrs) {
      const ln = name.toLowerCase();
      if (isRoot && (ln === "width" || ln === "height") && (opts.widthMm !== undefined || opts.heightMm !== undefined)) continue;
      const value = cleanAttr(name, rawValue, prefix);
      if (value === null) {
        removed.attributes++;
        continue;
      }
      if (ln === "aria-label") hasAria = true;
      if (ln === "xmlns") hasXmlns = true;
      attrs += ` ${name}="${escText(value)}"`;
    }
    if (isRoot) {
      if (!hasXmlns) attrs = ` xmlns="http://www.w3.org/2000/svg"${attrs}`;
      if (opts.widthMm !== undefined) attrs += ` width="${n(opts.widthMm)}mm"`;
      if (opts.heightMm !== undefined) attrs += ` height="${n(opts.heightMm)}mm"`;
      if (!hasAria && opts.ariaLabel) attrs += ` role="img" aria-label="${escText(opts.ariaLabel)}"`;
    }
    if (tag.selfClose) {
      out += `<${tag.name}${attrs}/>`;
      if (isRoot) break;
      continue;
    }
    out += `<${tag.name}${attrs}>`;
    stack.push({ l: lname, name: tag.name });
  }
  // Masukan terpotong: tutup elemen yang masih terbuka.
  while (stack.length > 0) out += `</${(stack.pop() as { name: string }).name}>`;
  return { svg: out, removed };
}

// ── Raster ───────────────────────────────────────────────────────────────

/** Byte -> base64 (Buffer bila ada; cadangan murni). */
export function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    s += abc[a >> 2] + abc[((a & 3) << 4) | (b >> 4)];
    s += i + 1 < bytes.length ? abc[((b & 15) << 2) | (c >> 6)] : "=";
    s += i + 2 < bytes.length ? abc[c & 63] : "=";
  }
  return s;
}

/** Deteksi mime raster dari tanda tangan berkas. */
export function sniffRasterMime(bytes: Uint8Array): "image/png" | "image/jpeg" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

/** Data URI raster dari byte; undefined bila bukan PNG/JPEG. */
export function rasterDataUri(bytes: Uint8Array): string | undefined {
  const mime = sniffRasterMime(bytes);
  return mime ? `data:${mime};base64,${toBase64(bytes)}` : undefined;
}

/** Data URI dari base64 AssetRef; undefined bila base64/mime tidak sah. */
export function base64DataUri(mime: string, b64: string): string | undefined {
  if (mime !== "image/png" && mime !== "image/jpeg") return undefined;
  const clean = b64.replace(/\s+/g, "");
  if (clean.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return undefined;
  return `data:${mime};base64,${clean}`;
}
