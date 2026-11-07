/**
 * Pengurai inline `md/v1` -> `InlineV2` (FIX-H7).
 *
 * Pemetaan (penanda MAKNA saja, RunV2 T2-01):
 *   `**x**`/`__x__` -> strong; `*x*`/`_x_` -> em; `***x***` -> strong+em; `` `x` `` -> code;
 *   `<sup>`/`<sub>` -> sup/sub; `<b>`/`<strong>`, `<i>`/`<em>`, `<code>` -> padanan; `<br>`,
 *   dua spasi atau `\` di ujung baris -> `{ br: "line" }`; `[label](url)` -> teks
 *   `label (url)` (Run tidak memodelkan hyperlink); `<url>` -> teks url; entitas HTML diurai.
 * Dibuang + dilaporkan: tag HTML inline lain (span/font/u/mark/...; `display`), komentar HTML,
 * coretan `~~x~~` (penanda dibuang, isi tetap), gambar inline (isi; gambar harus satu baris
 * tersendiri agar menjadi blok `image` bercaption).
 *
 * Keluaran: `{ text }` bila tanpa penanda dan tidak memuat `*`/`` ` `` (md-lite KS-03 tidak
 * akan menafsirkannya ulang), selain itu `{ runs }`. Deterministik: tanpa waktu/acak.
 */
import type { InlineV2, RunV2 } from "../../contract";
import type { MdDropKind } from "./types";

export interface InlineSink {
  warn(code: string, message: string): void;
  drop(code: string, kind: MdDropKind, excerpt: string): void;
}

interface Flags {
  strong?: boolean;
  em?: boolean;
  code?: boolean;
  sup?: boolean;
  sub?: boolean;
}

type TextRun = { t: string; strong?: boolean; em?: boolean; code?: boolean; sup?: boolean; sub?: boolean };

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const ALNUM = /[A-Za-z0-9À-ɏ]/;
const WS = /\s/;

const ENTITY_RE = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  deg: "°",
  times: "×",
  minus: "−",
  plusmn: "±",
  middot: "·",
};

const AUTOLINK_RE = /^<((?:https?|ftp):\/\/[^\s<>]+|mailto:[^\s<>]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/;
/** `\s[^<>]*?` setara `\s+[^<>]*?` tanpa backtracking kuadratik pada deret spasi (FIX-HR1). */
const TAG_RE = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*?)?)(\/?)>/;
/** Tag inline yang bermakna -> penanda run. */
const SEMANTIC_TAGS: Readonly<Record<string, keyof Flags>> = {
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  code: "code",
  kbd: "code",
  sup: "sup",
  sub: "sub",
};

export function excerptOf(s: string, max = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function decodeEntity(body: string): string | null {
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const cp = parseInt(body.slice(2), 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  if (body.startsWith("#")) {
    const cp = parseInt(body.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  return NAMED_ENTITIES[body] ?? null;
}

/**
 * Memo kegagalan per string (pengaman kompleksitas, masukan agen hingga 5 MiB), agar pembuka
 * tak berpasangan beruntun tidak kuadratik:
 * - `tick`/`tag`: pencarian penutup (backtick, tag HTML) gagal dari p -> gagal dari setiap >= p;
 * - `dead`: posisi yang DIKUNJUNGI pindaian penanda yang gagal. Pindaian lain yang tiba di posisi
 *   itu (sesudah titik mulainya) menempuh lintasan identik, jadi langsung gagal.
 */
interface ScanMemo {
  tick: Map<number, number>;
  tag: Map<string, number>;
  dead: Map<string, Uint8Array>;
  /** Pasangan `[` -> `]` (sarang, escape dihormati), dihitung sekali O(n); -1 = tanpa pasangan. */
  brackets?: Int32Array;
  /** Posisi terkecil asal pencarian `-->` yang gagal (FIX-HR1: `<!--` beruntun tanpa penutup). */
  commentFail?: number;
}

function newMemo(): ScanMemo {
  return { tick: new Map(), tag: new Map(), dead: new Map() };
}

/**
 * Ujung komentar HTML `<!-- ... -->` yang dimulai di `at`, atau -1. Setara regex lama
 * `^<!--[\s\S]*?-->` (penutup pertama sesudah pembuka), tetapi kegagalan dimemo: tanpa `-->`
 * sesudah p berarti tanpa `-->` sesudah setiap posisi >= p.
 */
function commentEnd(s: string, at: number, memo: ScanMemo): number {
  if (!s.startsWith("<!--", at)) return -1;
  const from = at + 4;
  if (memo.commentFail !== undefined && from >= memo.commentFail) return -1;
  const k = s.indexOf("-->", from);
  if (k < 0) {
    memo.commentFail = Math.min(memo.commentFail ?? from, from);
    return -1;
  }
  return k + 3;
}

function bracketPairs(s: string, memo: ScanMemo): Int32Array {
  if (memo.brackets) return memo.brackets;
  const pairs = new Int32Array(s.length).fill(-1);
  const stack: number[] = [];
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "[") stack.push(j);
    else if (c === "]" && stack.length > 0) pairs[stack.pop()!] = j;
  }
  memo.brackets = pairs;
  return pairs;
}

/** Batas panjang teks tautan yang dipindai (CommonMark membatasi label 999 karakter). */
const LINK_LABEL_SCAN_MAX = 2000;

/** Posisi penutup kode inline dengan panjang backtick tepat `n`, atau -1. */
function backtickClose(s: string, from: number, n: number, memo: ScanMemo): number {
  const failed = memo.tick.get(n);
  if (failed !== undefined && from >= failed) return -1;
  const r = backtickScan(s, from, n);
  if (r < 0) memo.tick.set(n, Math.min(failed ?? from, from));
  return r;
}

function backtickScan(s: string, from: number, n: number): number {
  let j = from;
  while (j < s.length) {
    const k = s.indexOf("`", j);
    if (k < 0) return -1;
    let e = k;
    while (s[e] === "`") e++;
    if (e - k === n) return k;
    j = e;
  }
  return -1;
}

function runLength(s: string, at: number, ch: string): number {
  let e = at;
  while (s[e] === ch) e++;
  return e - at;
}

/**
 * Posisi penutup penanda `delim` (`*`, `**`, `***`, `_`, `__`, `~~`) mulai `from`, atau -1.
 * Lompati escape dan kode inline; untuk `*` tunggal, pasangan `**...**` di dalamnya dilompati.
 */
function findClose(s: string, from: number, delim: string, memo: ScanMemo): number {
  let dead = memo.dead.get(delim);
  if (!dead) {
    dead = new Uint8Array(s.length + 1);
    memo.dead.set(delim, dead);
  }
  const visited: number[] = [];
  const pos = closeScan(s, from, delim, memo, dead, visited);
  if (pos < 0) for (const v of visited) dead[v] = 1;
  return pos;
}

function closeScan(s: string, from: number, delim: string, memo: ScanMemo, dead: Uint8Array, visited: number[]): number {
  const ch = delim[0];
  for (let j = from; j < s.length; j++) {
    // Di titik mulai, `closable` berbeda dari pindaian terdahulu; sesudahnya lintasan identik.
    if (j > from && dead[j] === 1) return -1;
    visited.push(j);
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "`") {
      const n = runLength(s, j, "`");
      const cl = backtickClose(s, j + n, n, memo);
      j = (cl >= 0 ? cl + n : j + n) - 1;
      continue;
    }
    if (c !== ch) continue;
    const len = runLength(s, j, ch);
    const prev = s[j - 1] ?? " ";
    const after = s[j + len] ?? " ";
    const closable = j > from && !WS.test(prev) && !(ch === "_" && ALNUM.test(after));
    if (closable && len >= delim.length) {
      if (delim.length === 1 && len === 2) {
        // `**` di dalam `*...*`: pasangan bersarang, bukan penutup.
        const inner = findClose(s, j + 2, ch + ch, memo);
        if (inner >= 0) {
          j = inner + 1;
          continue;
        }
      }
      return j + (len - delim.length);
    }
    j += len - 1;
  }
  return -1;
}

/** Tag penutup `</name>` pertama mulai `from` (tak peka huruf), atau null; kegagalan dimemo. */
function tagClose(s: string, from: number, name: string, memo: ScanMemo): { index: number; length: number } | null {
  const failed = memo.tag.get(name);
  if (failed !== undefined && from >= failed) return null;
  const re = new RegExp(`</${name}\\s*>`, "gi");
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m) {
    memo.tag.set(name, Math.min(failed ?? from, from));
    return null;
  }
  return { index: m.index, length: m[0].length };
}

/** `[label](url "judul")` mulai `at` (karakter `[`), atau null. */
function matchLink(s: string, at: number, memo: ScanMemo): { label: string; url: string; end: number } | null {
  const j = bracketPairs(s, memo)[at];
  if (j < 0 || j - at > LINK_LABEL_SCAN_MAX || s[j + 1] !== "(") return null;
  const m = /^\(\s*(<[^<>\n]*>|[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)?(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(s.slice(j + 1));
  if (!m) return null;
  let url = m[1] ?? "";
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
  return { label: s.slice(at + 1, j), url, end: j + 1 + m[0].length };
}

function withFlag(flags: Flags, f: keyof Flags): Flags {
  const out: Flags = { ...flags, [f]: true };
  // RunV2: sup dan sub tidak boleh keduanya true; yang terdalam menang.
  if (f === "sup") delete out.sub;
  if (f === "sub") delete out.sup;
  return out;
}

function makeRun(t: string, flags: Flags): TextRun {
  const r: TextRun = { t };
  if (flags.strong) r.strong = true;
  if (flags.em) r.em = true;
  if (flags.code) r.code = true;
  if (flags.sup) r.sup = true;
  if (flags.sub) r.sub = true;
  return r;
}

/** Batas sarang penanda inline (pengaman tumpukan); lebih dalam = penanda dibaca literal. */
const MAX_INLINE_DEPTH = 24;

/**
 * Penyangga teks run (FIX-HR1, D-334 H-01): potongan di array, digabung sekali saat flush.
 * Spasi akhir diperiksa/dipangkas dari potongan terakhir saja, jadi biaya per baris baru
 * sebanding dengan spasi yang dibuang, bukan panjang penyangga (dulu regex berjangkar `$`
 * atas penyangga yang terus tumbuh = O(n^2)).
 */
class TextBuf {
  private readonly parts: string[] = [];

  push(t: string): void {
    if (t) this.parts.push(t);
  }

  /** Jumlah spasi (U+0020) di ujung, dihitung paling banyak sampai `cap`. */
  trailingSpaces(cap: number): number {
    let n = 0;
    for (let k = this.parts.length - 1; k >= 0; k--) {
      const p = this.parts[k];
      for (let e = p.length - 1; e >= 0; e--) {
        if (p[e] !== " ") return n;
        if (++n >= cap) return n;
      }
    }
    return n;
  }

  /** Pangkas spasi (dan tab bila `tabs`) di ujung. */
  trimEnd(tabs: boolean): void {
    while (this.parts.length > 0) {
      const last = this.parts[this.parts.length - 1];
      let e = last.length;
      while (e > 0 && (last[e - 1] === " " || (tabs && last[e - 1] === "\t"))) e--;
      if (e === 0) {
        this.parts.pop();
        continue;
      }
      if (e < last.length) this.parts[this.parts.length - 1] = last.slice(0, e);
      return;
    }
  }

  take(): string {
    const t = this.parts.length === 1 ? this.parts[0] : this.parts.join("");
    this.parts.length = 0;
    return t;
  }
}

function walk(s: string, flags: Flags, out: RunV2[], sink: InlineSink, depth = 0): void {
  const memo = newMemo();
  const nest = depth < MAX_INLINE_DEPTH;
  const buf = new TextBuf();
  const flush = (): void => {
    const t = buf.take();
    if (t) out.push(makeRun(t, flags));
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1];
      if (n === "\n") {
        flush();
        out.push({ br: "line" });
        i += 2;
        while (s[i] === " " || s[i] === "\t") i++;
        continue;
      }
      if (n !== undefined && ASCII_PUNCT.test(n)) {
        buf.push(n);
        i += 2;
        continue;
      }
      buf.push(c);
      i++;
      continue;
    }
    if (c === "\n") {
      if (buf.trailingSpaces(2) >= 2) {
        buf.trimEnd(false);
        flush();
        out.push({ br: "line" });
      } else {
        buf.trimEnd(true);
        buf.push(" ");
      }
      i++;
      while (s[i] === " " || s[i] === "\t") i++;
      continue;
    }
    if (c === "`") {
      const n = runLength(s, i, "`");
      const cl = backtickClose(s, i + n, n, memo);
      if (cl >= 0) {
        let content = s.slice(i + n, cl).replace(/\n/g, " ");
        if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim()) content = content.slice(1, -1);
        flush();
        out.push(makeRun(content, withFlag(flags, "code")));
        i = cl + n;
        continue;
      }
      buf.push(s.slice(i, i + n));
      i += n;
      continue;
    }
    if (c === "!" && s[i + 1] === "[") {
      const l = matchLink(s, i + 1, memo);
      if (l) {
        flush();
        sink.drop("INLINE_IMAGE", "content", s.slice(i, l.end));
        sink.warn("INLINE_IMAGE", "inline image dropped: put ![caption](sha256:...) on its own line to make an image block");
        i = l.end;
        continue;
      }
    }
    if (c === "[" && nest) {
      const l = matchLink(s, i, memo);
      if (l) {
        flush();
        const before = out.length;
        walk(l.label, flags, out, sink, depth + 1);
        const labelText = out
          .slice(before)
          .map((r) => ("t" in r ? r.t : ""))
          .join("")
          .trim();
        if (l.url && labelText !== l.url) out.push(makeRun(labelText ? ` (${l.url})` : l.url, flags));
        i = l.end;
        continue;
      }
    }
    if (c === "<") {
      const ce = commentEnd(s, i, memo);
      if (ce >= 0) {
        flush();
        sink.drop("HTML_COMMENT", "html", s.slice(i, ce));
        i = ce;
        continue;
      }
      const rest = s.slice(i);
      const al = AUTOLINK_RE.exec(rest);
      if (al) {
        buf.push(al[1]);
        i += al[0].length;
        continue;
      }
      const tm = TAG_RE.exec(rest);
      if (tm) {
        const closing = tm[1] === "/";
        const name = tm[2].toLowerCase();
        flush();
        if (name === "br") {
          out.push({ br: "line" });
          i += tm[0].length;
          continue;
        }
        const sem = SEMANTIC_TAGS[name];
        if (sem && !closing && nest) {
          const open = i + tm[0].length;
          const cl = tagClose(s, open, name, memo);
          if (cl) {
            if (tm[3].trim()) sink.drop("HTML_ATTRIBUTES", "display", tm[0]);
            walk(s.slice(open, cl.index), withFlag(flags, sem), out, sink, depth + 1);
            i = cl.index + cl.length;
            continue;
          }
        }
        if (name === "img") {
          sink.drop("HTML_IMAGE", "content", tm[0]);
          sink.warn("HTML_IMAGE", "<img> dropped: use ![caption](sha256:...) on its own line");
        } else if (!closing) sink.drop("HTML_INLINE", "display", tm[0]);
        i += tm[0].length;
        continue;
      }
    }
    if (c === "&") {
      const em = ENTITY_RE.exec(s.slice(i));
      const dec = em ? decodeEntity(em[1]) : null;
      if (em && dec !== null) {
        buf.push(dec);
        i += em[0].length;
        continue;
      }
    }
    if (nest && c === "~" && s[i + 1] === "~") {
      const cl = findClose(s, i + 2, "~~", memo);
      if (cl > i + 2 && !WS.test(s[i + 2])) {
        flush();
        sink.drop("STRIKETHROUGH", "display", s.slice(i, cl + 2));
        walk(s.slice(i + 2, cl), flags, out, sink, depth + 1);
        i = cl + 2;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const len = runLength(s, i, c);
      const prev = s[i - 1] ?? " ";
      const next = s[i + len] ?? " ";
      const canOpen = nest && !WS.test(next) && !(c === "_" && ALNUM.test(prev));
      if (canOpen) {
        const tries: Array<[number, Flags]> = [];
        if (len >= 3) tries.push([3, withFlag(withFlag(flags, "strong"), "em")]);
        if (len >= 2) tries.push([2, withFlag(flags, "strong")]);
        tries.push([1, withFlag(flags, "em")]);
        let done = false;
        for (const [n, f] of tries) {
          const cl = findClose(s, i + n, c.repeat(n), memo);
          if (cl > i + n) {
            flush();
            walk(s.slice(i + n, cl), f, out, sink, depth + 1);
            i = cl + n;
            done = true;
            break;
          }
        }
        if (done) continue;
      }
      buf.push(s.slice(i, i + len));
      i += len;
      continue;
    }
    buf.push(c);
    i++;
  }
  flush();
}

function sameFlags(a: TextRun, b: TextRun): boolean {
  return !!a.strong === !!b.strong && !!a.em === !!b.em && !!a.code === !!b.code && !!a.sup === !!b.sup && !!a.sub === !!b.sub;
}

function isText(r: RunV2): r is TextRun {
  return "t" in r;
}

function isBr(r: RunV2 | undefined): boolean {
  return r !== undefined && "br" in r;
}

/** Rapikan: spasi beruntun (di luar kode) jadi satu, gabung run setara, pangkas tepi, buang run kosong. */
function tidy(runs: RunV2[]): RunV2[] {
  const merged: RunV2[] = [];
  for (const r of runs) {
    const cur = isText(r) && !r.code ? { ...r, t: r.t.replace(/[ \t]+/g, " ") } : r;
    const last = merged[merged.length - 1];
    if (last && isText(last) && isText(cur) && sameFlags(last, cur)) merged[merged.length - 1] = { ...last, t: last.t + cur.t };
    else merged.push(cur);
  }
  for (let k = 0; k < merged.length; k++) {
    const r = merged[k];
    if (!isText(r) || r.code) continue;
    let t = r.t;
    if (k === 0 || isBr(merged[k - 1])) t = t.replace(/^ +/, "");
    if (k === merged.length - 1 || isBr(merged[k + 1])) t = t.replace(/ +$/, "");
    merged[k] = { ...r, t };
  }
  const out = merged.filter((r) => !isText(r) || r.t !== "");
  // br/tab di tepi tidak bermakna.
  while (out.length && !isText(out[0])) out.shift();
  while (out.length && !isText(out[out.length - 1])) out.pop();
  return out;
}

/** Inline mentah Markdown -> RunV2[] rapi. */
export function parseInlineRuns(src: string, sink: InlineSink): RunV2[] {
  const out: RunV2[] = [];
  walk(src, {}, out, sink);
  return tidy(out);
}

/** RunV2[] -> InlineV2 (text bila polos dan aman terhadap md-lite, selain itu runs). */
export function inlineOfRuns(runs: RunV2[]): InlineV2 {
  if (runs.every((r) => isText(r) && !r.strong && !r.em && !r.code && !r.sup && !r.sub)) {
    const text = runs.map((r) => (isText(r) ? r.t : "")).join("");
    return /[*`]/.test(text) ? { runs: [{ t: text }] } : { text };
  }
  return { runs };
}

/** Teks polos verbatim (baris kode) -> InlineV2 tanpa tafsir md-lite. */
export function plainInline(text: string): InlineV2 {
  return /[*`]/.test(text) ? { runs: [{ t: text }] } : { text };
}

export function parseInline(src: string, sink: InlineSink): InlineV2 {
  return inlineOfRuns(parseInlineRuns(src, sink));
}

/** Teks polos dari InlineV2 (untuk perbandingan dan pesan). */
export function inlineText(inline: InlineV2): string {
  if ("text" in inline) return inline.text;
  return inline.runs.map((r) => ("t" in r ? r.t : "br" in r ? "\n" : "\t")).join("");
}
