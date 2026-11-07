/**
 * Pemecah blok Markdown `md/v1` (FIX-H7): baris -> token blok berbaris sumber.
 *
 * Subset CommonMark + GFM yang dipakai naskah agen: judul ATX dan setext, paragraf,
 * daftar (bersarang, berurut/tidak), tabel pipa GFM, blok kode berpagar, kutipan,
 * blok HTML (jenis 1, 2, 6, 7), garis pemisah, front matter YAML. Kode berindentasi
 * empat spasi diperlakukan sebagai paragraf (naskah agen tidak memakainya; menghindari
 * salah tafsir paragraf berindentasi).
 */

export type MdBlock =
  | { kind: "heading"; level: number; text: string; line: number }
  | { kind: "paragraph"; text: string; line: number }
  | { kind: "list"; ordered: boolean; items: MdListItem[]; line: number }
  | { kind: "table"; header: string[]; aligned: boolean; rows: Array<{ cells: string[]; line: number }>; line: number }
  | { kind: "code"; info: string; lines: string[]; unclosed: boolean; line: number }
  | { kind: "quote"; lines: string[]; line: number }
  | { kind: "html"; raw: string; tag: string; line: number }
  | { kind: "hr"; raw: string; line: number }
  | { kind: "frontMatter"; raw: string; line: number };

export interface MdListItem {
  text: string;
  depth: number;
  line: number;
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT1_RE = /^ {0,3}=+[ \t]*$/;
const SETEXT2_RE = /^ {0,3}-+[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*$)/;
const DELIM_CELL_RE = /^:?-+:?$/;
const BLANK_RE = /^[ \t]*$/;

/** Jenis 1 (sampai tag penutup). */
const HTML_RAW_TAGS = new Set(["script", "style", "pre", "textarea"]);
/** Jenis 6 (tag blok; sampai baris kosong). */
const HTML_BLOCK_TAGS = new Set([
  "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col", "colgroup", "dd",
  "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "iframe", "legend", "li", "link", "main", "menu",
  "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p", "param", "section", "source", "summary", "table",
  "tbody", "td", "tfoot", "th", "thead", "title", "tr", "track", "ul",
]);

function isSpTab(c: string | undefined): boolean {
  return c === " " || c === "\t";
}

/**
 * Pangkas spasi/tab di ujung tanpa regex (FIX-HR1, D-334 H-01): `/[ \t]+$/` mencoba setiap
 * posisi di dalam deret spasi panjang yang tidak berada di ujung = O(k^2).
 */
export function trimEndSpTab(s: string): string {
  let e = s.length;
  while (e > 0 && isSpTab(s[e - 1])) e--;
  return e === s.length ? s : s.slice(0, e);
}

/**
 * Judul ATX tanpa regex backtracking (FIX-HR1, D-334 H-01). Semantik identik dengan regex
 * md/v1 sebelumnya `^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$` (kuadratik pada
 * deret spasi panjang): teks = sisa sesudah spasi pembuka tanpa urutan penutup
 * `[ \t]+#+[ \t]*` (atau tanpa spasi akhir saja), lalu `trim()`. `.` regex lama tidak melewati
 * U+2028/U+2029, jadi baris yang memuatnya sesudah `#` tetap bukan judul.
 */
export function atxHeading(l: string): { level: number; text: string } | null {
  let p = 0;
  while (p < 3 && l[p] === " ") p++;
  if (l[p] !== "#") return null;
  let e = p;
  while (l[e] === "#") e++;
  const level = e - p;
  if (level > 6) return null;
  if (e === l.length) return { level, text: "" };
  if (!isSpTab(l[e])) return null;
  if (l.includes("\u2028", e) || l.includes("\u2029", e)) return null;
  let b = e;
  while (isSpTab(l[b])) b++;
  // Ujung baris = [ \t]* (W1), sebelumnya #+ (H), sebelumnya [ \t]+ (W2): penutup bila H dan W2 ada.
  let k = l.length;
  while (k > b && isSpTab(l[k - 1])) k--;
  let h = k;
  while (h > b && l[h - 1] === "#") h--;
  let w = h;
  while (w > b && isSpTab(l[w - 1])) w--;
  const end = h < k && w < h ? w : k;
  return { level, text: l.slice(b, end).trim() };
}

function isBlank(l: string | undefined): boolean {
  return l === undefined || BLANK_RE.test(l);
}

function indentOf(l: string): number {
  return /^ */.exec(l)![0].length;
}

/** Sel baris tabel pipa: pisah pada `|` tanpa escape di luar kode inline; `\|` -> `|`. */
export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "`") {
      let n = 0;
      while (s[i + n] === "`") n++;
      inCode = inCode === n ? 0 : inCode === 0 ? n : inCode;
      cur += s.slice(i, i + n);
      i += n - 1;
      continue;
    }
    if (c === "|" && inCode === 0) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function delimiterCells(line: string | undefined): string[] | null {
  if (line === undefined || !line.includes("-")) return null;
  if (!line.includes("|") && !/^ {0,3}:?-+:?[ \t]*$/.test(line)) return null;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => DELIM_CELL_RE.test(c)) ? cells : null;
}

function isTableStart(lines: readonly string[], i: number): boolean {
  const head = lines[i];
  if (head === undefined || !head.includes("|")) return false;
  const delim = delimiterCells(lines[i + 1]);
  return delim !== null && (lines[i + 1].includes("|") || head.trim().startsWith("|")) && delim.length === splitTableRow(head).length;
}

function htmlStart(line: string): { type: 1 | 2 | 6 | 7; tag: string } | null {
  if (/^ {0,3}<!--/.test(line)) return { type: 2, tag: "!--" };
  const m = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(line);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  if (HTML_RAW_TAGS.has(tag) && !line.trimStart().startsWith("</")) return { type: 1, tag };
  if (HTML_BLOCK_TAGS.has(tag)) return { type: 6, tag };
  // Jenis 7: satu tag lengkap sendirian di baris. `\s[^<>]*` setara `\s+[^<>]*` (\s bagian dari
  // [^<>]) tanpa backtracking kuadratik pada deret spasi panjang (FIX-HR1, D-334 H-01).
  if (/^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>[ \t]*$/.test(line)) return { type: 7, tag };
  return null;
}

function listMatch(line: string): RegExpExecArray | null {
  if (HR_RE.test(line)) return null;
  return LIST_RE.exec(line);
}

/** Baris yang memutus paragraf (CommonMark: daftar berurut hanya bila mulai dari 1). */
function interruptsParagraph(lines: readonly string[], j: number): boolean {
  const l = lines[j];
  if (isBlank(l) || atxHeading(l) !== null || FENCE_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l)) return true;
  const lm = listMatch(l);
  if (lm && lm[3] !== undefined && lm[3].trim() !== "" && (!/\d/.test(lm[2]) || /^1[.)]$/.test(lm[2]))) return true;
  const h = htmlStart(l);
  if (h && h.type !== 7) return true;
  return isTableStart(lines, j);
}

/** Front matter YAML di baris pertama (`---` ... `---`/`...`), atau null. */
function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0] !== "---") return -1;
  for (let j = 1; j < Math.min(lines.length, 200); j++) {
    if (lines[j] === "---" || lines[j] === "...") return j > 1 && /^[A-Za-z0-9_-]+\s*:/.test(lines[1]) ? j : -1;
  }
  return -1;
}

function lexList(lines: readonly string[], start: number): { block: MdBlock; next: number } {
  const first = listMatch(lines[start])!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const markerType = ordered ? first[2].slice(-1) : first[2];
  const items: Array<MdListItem & { contentIndent: number }> = [];
  const levels: number[] = [];
  let j = start;
  let prevBlank = false;
  while (j < lines.length) {
    const l = lines[j];
    if (isBlank(l)) {
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      const nl = lines[k];
      const last = items[items.length - 1];
      if (nl === undefined) break;
      const nm = listMatch(nl);
      if (nm && nm[1].length >= baseIndent) {
        j = k;
        prevBlank = true;
        continue;
      }
      if (last && indentOf(nl) >= Math.max(2, last.contentIndent) && !FENCE_RE.test(nl)) {
        last.text += "\n\n";
        j = k;
        prevBlank = true;
        continue;
      }
      break;
    }
    const m = listMatch(l);
    if (m) {
      const ind = m[1].length;
      const mType = /\d/.test(m[2]) ? m[2].slice(-1) : m[2];
      if (ind <= baseIndent + 1 && (mType !== markerType || /\d/.test(m[2]) !== ordered)) break;
      let depth: number;
      if (levels.length === 0 || ind <= levels[0] + 1) {
        depth = 0;
        levels.length = 0;
        levels.push(ind);
      } else if (ind > levels[levels.length - 1] + 1) {
        depth = levels.length;
        levels.push(ind);
      } else {
        depth = 0;
        for (let d = levels.length - 1; d >= 0; d--) {
          if (levels[d] <= ind + 1) {
            depth = d;
            break;
          }
        }
        levels.length = depth + 1;
      }
      const markerEnd = ind + m[2].length + (m[3] !== undefined ? /^[ \t]*/.exec(l.slice(ind + m[2].length))![0].length : 1);
      items.push({ text: m[3] ?? "", depth, line: j + 1, contentIndent: markerEnd });
      prevBlank = false;
      j++;
      continue;
    }
    const last = items[items.length - 1];
    // Lanjutan: berindentasi, atau malas (baris sebelumnya tidak kosong dan bukan awal blok).
    if (last && (indentOf(l) >= 2 || (!prevBlank && !interruptsParagraph(lines, j)))) {
      last.text += `\n${l.trim()}`;
      j++;
      continue;
    }
    break;
  }
  return {
    block: { kind: "list", ordered, items: items.map(({ text, depth, line }) => ({ text, depth, line })), line: start + 1 },
    next: j,
  };
}

/** Markdown (LF) -> token blok. */
export function lexMarkdown(src: string): MdBlock[] {
  const lines = src.split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  const fm = frontMatterEnd(lines);
  if (fm > 0) {
    out.push({ kind: "frontMatter", raw: lines.slice(0, fm + 1).join("\n"), line: 1 });
    i = fm + 1;
  }
  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(l);
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      const ch = fence[2][0];
      const n = fence[2].length;
      const ind = fence[1].length;
      const closeRe = new RegExp(`^ {0,3}${ch === "`" ? "`" : "~"}{${n},}[ \\t]*$`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) {
        body.push(lines[j].replace(new RegExp(`^ {0,${ind}}`), ""));
        j++;
      }
      out.push({ kind: "code", info: fence[3].trim(), lines: body, unclosed: j >= lines.length, line: i + 1 });
      i = j + 1;
      continue;
    }
    const atx = atxHeading(l);
    if (atx) {
      out.push({ kind: "heading", level: atx.level, text: atx.text, line: i + 1 });
      i++;
      continue;
    }
    if (HR_RE.test(l)) {
      out.push({ kind: "hr", raw: l.trim(), line: i + 1 });
      i++;
      continue;
    }
    const html = htmlStart(l);
    if (html) {
      let j = i;
      if (html.type === 1) {
        const closeRe = new RegExp(`</${html.tag}\\s*>`, "i");
        while (j < lines.length && !closeRe.test(lines[j])) j++;
        j = Math.min(j + 1, lines.length);
      } else if (html.type === 2) {
        while (j < lines.length && !lines[j].includes("-->")) j++;
        j = Math.min(j + 1, lines.length);
      } else {
        while (j < lines.length && !isBlank(lines[j])) j++;
      }
      out.push({ kind: "html", raw: lines.slice(i, j).join("\n"), tag: html.tag, line: i + 1 });
      i = j;
      continue;
    }
    if (QUOTE_RE.test(l)) {
      const body: string[] = [];
      let j = i;
      while (j < lines.length) {
        const qm = QUOTE_RE.exec(lines[j]);
        if (qm) body.push(qm[1]);
        else if (!isBlank(lines[j]) && body.length > 0 && !isBlank(body[body.length - 1]) && !interruptsParagraph(lines, j)) body.push(lines[j].trim());
        else break;
        j++;
      }
      out.push({ kind: "quote", lines: body, line: i + 1 });
      i = j;
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitTableRow(l);
      const delim = delimiterCells(lines[i + 1])!;
      const rows: Array<{ cells: string[]; line: number }> = [];
      let j = i + 2;
      while (j < lines.length && !isBlank(lines[j]) && lines[j].includes("|") && !QUOTE_RE.test(lines[j])) {
        rows.push({ cells: splitTableRow(lines[j]), line: j + 1 });
        j++;
      }
      out.push({ kind: "table", header, aligned: delim.some((c) => c.startsWith(":") || c.endsWith(":")), rows, line: i + 1 });
      i = j;
      continue;
    }
    if (listMatch(l)) {
      const r = lexList(lines, i);
      out.push(r.block);
      i = r.next;
      continue;
    }
    // Paragraf (+ setext).
    const para: string[] = [l];
    let j = i + 1;
    let heading: number | null = null;
    while (j < lines.length) {
      const nl = lines[j];
      if (SETEXT1_RE.test(nl)) {
        heading = 1;
        j++;
        break;
      }
      if (SETEXT2_RE.test(nl)) {
        heading = 2;
        j++;
        break;
      }
      if (interruptsParagraph(lines, j)) break;
      para.push(nl);
      j++;
    }
    const text = para.map((p) => p.replace(/^[ \t]+/, "")).join("\n");
    if (heading !== null) out.push({ kind: "heading", level: heading, text: text.replace(/\s+/g, " ").trim(), line: i + 1 });
    else out.push({ kind: "paragraph", text: trimEndSpTab(text), line: i + 1 });
    i = j;
  }
  return out;
}
