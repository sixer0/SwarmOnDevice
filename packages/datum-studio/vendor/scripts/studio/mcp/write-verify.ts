/**
 * IMPL-W4 butir 3 (D-547, research/28 T-2): ringkasan verifikasi di SETIAP hasil `studio_write`/`studio_edit`, agar
 * agen tidak membuka zip, crop, atau vision sendiri (r5b DB: 645,7 s dari 683,7 s T2 untuk itu). Isi:
 * - revisi tersimpan + kelengkapan (dari hasil tulis), berkas render + sha256 yang DIHITUNG ULANG atas byte unduhan R10
 *   (dibandingkan dengan sha server);
 * - judul tercetak (tingkat + teks, maks 40) dan keterangan Tabel/Gambar tercetak, dibaca dari byte berkas itu sendiri
 *   (DOCX: `word/document.xml` paragraf ber-`w:outlineLvl` + kicker sebelumnya; HTML: h2/h3 + caption/figcaption);
 * - lint tata letak per figur (jumlah isu dari lint geometri chart/diagram yang sudah ada, lewat route pratinjau figur
 *   FIG-03b yang baca saja), jumlah halaman bila berkas memuatnya;
 * - gema medan record tersimpan (laporan kerja) atau meta tampilan tersimpan (dokumen klien), dibaca ulang dari R20.
 * Teks dokumen (judul, keterangan, nilai meta) = data tak tepercaya: hanya di blok `<data-tak-tepercaya>` dan medan
 * structuredContent bertanda `untrusted` (dinetralkan), sama dengan `studio_document_get`.
 */
import crypto from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { studioRoutePath } from "../../../src/lib/studio/contract/env";
import { http, isRecord, neutralizeDeep, tok, untrustedBlock, untrustedFields, type ToolContext } from "./tool-kit";
import { McpToolError } from "./safety";
import { serverClientMeta } from "./write-meta";

type Rec = Record<string, unknown>;
export const MAX_HEADINGS = 40;
const MAX_CAPTIONS = 40;
const MAX_FIGURES = 12;

export interface Printed {
  /** `tb` (IMPL-W7) = jumlah tabel tercetak sesudah judul ini dan sebelum judul berikutnya (hanya bila > 0). */
  headings: Array<{ l: number; t: string; k?: string; tb?: number }>;
  captions: string[];
  pages: number | null;
  /** IMPL-W7: jumlah tabel tercetak di seluruh berkas (termasuk tabel templat seperti blok kendali). */
  tables: number;
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
const squash = (s: string) => s.replace(/[\t  ]+/g, " ").trim();
/** Keterangan tercetak: label mesin + pemisah (tab atau >= 2 spasi), bukan kalimat badan "Table 6.1 condenses ...". */
const CAPTION_RE = /^(?:Tabel|Gambar|Turunan|Table|Figure|Lampiran)\s+[A-Za-z0-9]+(?:[.\-][A-Za-z0-9]+)*(?:\t| {2,}| )/;
const KICKER_RE = /^(?:BAB|CHAPTER|LAMPIRAN|APPENDIX|BAGIAN|PART)\s+\S{1,8}$/i;

/** IMPL-W4 W4-L2 (review 13): batas unduhan render dan ukuran tak terkompresi entri zip yang dibaca. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ELEMENTS = 100_000;
const tooLarge = (what: string) => new McpToolError("VERIFY_TOO_LARGE", `${what} terlalu besar untuk ringkasan verifikasi; tulisan tetap tersimpan, pakai studio_file_verify`);

/** Posisi semua kemunculan `needle` (satu lintasan). */
function positions(src: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}
/** Indeks pertama di `list` (urut naik) yang >= x, atau -1 (pencarian biner). */
function firstAtLeast(list: readonly number[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? list[lo] : -1;
}
/**
 * W4-L2: elemen `<nama ...>isi</nama>` tanpa regex kuadratik. Posisi penutup per nama dikumpulkan sekali, tiap pembuka
 * mencari penutup berikutnya dengan pencarian biner; pembuka tanpa penutup dilewati. Paling banyak MAX_ELEMENTS.
 */
function elements(src: string, open: RegExp, names: readonly string[]): Array<{ name: string; inner: string; at: number }> {
  const closes = new Map(names.map((n) => [n, positions(src, `</${n}>`)]));
  const out: Array<{ name: string; inner: string; at: number }> = [];
  open.lastIndex = 0;
  for (let m = open.exec(src); m !== null && out.length < MAX_ELEMENTS; m = open.exec(src)) {
    const name = m[1];
    const start = m.index + m[0].length;
    const end = firstAtLeast(closes.get(name) ?? [], start);
    if (end < 0) continue;
    out.push({ name, inner: src.slice(start, end), at: m.index });
    open.lastIndex = end + name.length + 3;
  }
  return out;
}

/**
 * IMPL-W7: hitung tabel tercetak (posisi pembuka `tableAt`) dan bagikan ke judul terdekat sebelumnya (`headAt`, urut
 * naik, paralel dengan `headings`). Tabel sebelum judul pertama hanya masuk total.
 */
function countTables(tableAt: readonly number[], headAt: readonly number[], headings: Printed["headings"]): number {
  let h = -1;
  for (const t of tableAt) {
    while (h + 1 < headAt.length && headAt[h + 1] < t) h++;
    if (h >= 0) headings[h].tb = (headings[h].tb ?? 0) + 1;
  }
  return tableAt.length;
}
const openTags = (src: string, re: RegExp): number[] => {
  const out: number[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(src); m !== null && out.length < MAX_ELEMENTS; m = re.exec(src)) out.push(m.index);
  return out;
};

/** Judul + keterangan tercetak dari byte DOCX. Entri > MAX_ENTRY_BYTES tidak didekompresi (VERIFY_TOO_LARGE). */
export function docxPrinted(bytes: Uint8Array): Printed {
  let big = false;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (f.name !== "word/document.xml" && f.name !== "docProps/app.xml") return false;
      if (f.originalSize > MAX_ENTRY_BYTES) big = true;
      return !big;
    },
  });
  if (big) throw tooLarge("entri DOCX");
  const xml = files["word/document.xml"] ? strFromU8(files["word/document.xml"]) : "";
  const app = files["docProps/app.xml"] ? strFromU8(files["docProps/app.xml"]) : "";
  const headings: Printed["headings"] = [];
  const headAt: number[] = [];
  const captions: string[] = [];
  let prev = "";
  for (const { inner: p, at } of elements(xml, /<(w:p)(?=[ >])[^>]*>/g, ["w:p"])) {
    const raw = unxml((p.match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>|<w:tab\/>/g) ?? []).map((t) => (t === "<w:tab/>" ? "\t" : t.replace(/<[^>]+>/g, ""))).join(""));
    if (raw.trim() === "") continue;
    const lvl = /<w:outlineLvl w:val="(\d)"/.exec(p);
    if (lvl !== null && headings.length < MAX_HEADINGS) {
      const l = Number(lvl[1]);
      headings.push({ l, t: squash(raw), ...(l === 0 && KICKER_RE.test(prev.trim()) ? { k: squash(prev) } : {}) });
      headAt.push(at);
    } else if (lvl === null && CAPTION_RE.test(raw) && captions.length < MAX_CAPTIONS) captions.push(squash(raw));
    prev = raw;
  }
  const pg = /<Pages>(\d+)<\/Pages>/.exec(app);
  const tables = countTables(openTags(xml, /<w:tbl[\s>]/g), headAt, headings);
  return { headings, captions, pages: pg !== null ? Number(pg[1]) : null, tables };
}

const stripTags = (s: string) => squash(unxml(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")));

/** Judul + keterangan tercetak dari byte HTML (laporan kerja dirender HTML). */
export function htmlPrinted(bytes: Uint8Array): Printed {
  if (bytes.length > MAX_ENTRY_BYTES) throw tooLarge("HTML");
  const html = Buffer.from(bytes).toString("utf8");
  const headings: Printed["headings"] = [];
  const headAt: number[] = [];
  const captions: string[] = [];
  let prev = "";
  for (const { name: tag, inner, at } of elements(html, /<(h[23]|p|figcaption|caption)\b[^>]*>/g, ["h2", "h3", "p", "figcaption", "caption"])) {
    const text = stripTags(inner);
    if (text === "") continue;
    if ((tag === "h2" || tag === "h3") && headings.length < MAX_HEADINGS) {
      headings.push({ l: tag === "h2" ? 0 : 1, t: text, ...(tag === "h2" && KICKER_RE.test(prev) ? { k: prev } : {}) });
      headAt.push(at);
    } else if ((tag === "figcaption" || tag === "caption") && captions.length < MAX_CAPTIONS) captions.push(text);
    prev = tag === "p" ? text : "";
  }
  const tables = countTables(openTags(html, /<table[\s>]/g), headAt, headings);
  return { headings, captions, pages: null, tables };
}

const sha256 = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

/** Figur (chart/diagram) di isi R20: pid + bab, urut dokumen. */
function figuresOf(content: Rec): Array<{ pid: string; key: string }> {
  const out: Array<{ pid: string; key: string }> = [];
  const chapters = isRecord(content.sections) && isRecord(content.sections.content) && Array.isArray(content.sections.content.chapters) ? content.sections.content.chapters : [];
  for (const ch of chapters) {
    if (!isRecord(ch)) continue;
    const blocks = [...(Array.isArray(ch.intro) ? ch.intro : []), ...(Array.isArray(ch.sections) ? ch.sections.flatMap((s) => (isRecord(s) && Array.isArray(s.blocks) ? s.blocks : [])) : [])];
    for (const b of blocks) if (isRecord(b) && (b.type === "chart" || b.type === "diagram") && typeof b.id === "string") out.push({ pid: b.id, key: String(ch.key) });
  }
  return out;
}

export interface VerifyInput {
  documentId: string;
  render: { fileId: string; sha256: string; format: string; bytes?: number | null } | null;
  kind: "report" | "client";
  /** IMPL-W4 butir 5: judul bab/section isi SEBELUM suntingan; sama dengan sesudahnya -> daftar judul tidak dicetak ulang. */
  priorTitles?: string;
  detail?: boolean;
}

/** Judul bab + section isi R20 (urut), untuk tahu apakah suntingan menyentuh judul. */
export function titlesOf(content: unknown): string {
  const chapters = isRecord(content) && isRecord(content.sections) && isRecord(content.sections.content) && Array.isArray(content.sections.content.chapters) ? content.sections.content.chapters : [];
  return JSON.stringify(chapters.filter(isRecord).map((c) => [c.title, Array.isArray(c.sections) ? c.sections.filter(isRecord).map((s) => s.title) : []]));
}

export interface Verified {
  /** structuredContent `verify` (dinetralkan; medan teks dokumen bertanda tak tepercaya oleh pemanggil). */
  data: Rec;
  /** baris ringkas (hanya token aman). */
  line: string;
  /** blok tak tepercaya (judul, keterangan, gema) atau null. */
  block: string | null;
}

/**
 * Ringkasan verifikasi sesudah tulis/sunting. Galat jaringan di sini TIDAK menggagalkan hasil tulis (tulisan sudah
 * tersimpan): ringkasan memuat `error` dengan kode aman dan agen dapat memakai studio_file_verify.
 */
export async function verifySummary(ctx: ToolContext, v: VerifyInput): Promise<Verified> {
  const data: Rec = {};
  const lines: string[] = [];
  try {
    const r20 = await http(ctx, "GET", studioRoutePath("R20", { id: v.documentId }), "GET /api/studio/documents/{id}/content");
    const body = isRecord(r20.body) ? r20.body : {};
    const content = isRecord(body.content) ? body.content : {};
    if (typeof body.revisionNo === "number") data.storedRevision = body.revisionNo;
    const sections = isRecord(content.sections) ? content.sections : {};
    if (v.kind === "report" && isRecord(sections.record)) {
      const r = sections.record;
      data.record = Object.fromEntries(["status", "verdict", "reportedAt", "owner", "initiator", "taskRef", "cardIds"].filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
    }
    if (v.kind === "client") {
      const m = serverClientMeta(content);
      data.meta = Object.fromEntries(["title", "number", "rev", "date"].filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));
    }
    if (v.render !== null) {
      // W4-L2: berkas lebih besar dari batas tidak diunduh/diurai (ringkasan tidak lengkap, tulisan tetap sukses).
      if (typeof v.render.bytes === "number" && v.render.bytes > MAX_DOWNLOAD_BYTES) throw tooLarge("berkas render");
      const dl = await http(ctx, "GET", `${studioRoutePath("R10", { id: v.render.fileId })}?download=1`, "GET /api/studio/files/{id}", { binary: true });
      const bytes = dl.bytes ?? Buffer.alloc(0);
      if (bytes.length > MAX_DOWNLOAD_BYTES) throw tooLarge("berkas render");
      const got = sha256(bytes);
      data.file = { fileId: v.render.fileId, format: tok(v.render.format), bytes: bytes.length, sha256: got, shaMatch: got === v.render.sha256 };
      const printed = String(v.render.format).toUpperCase() === "DOCX" ? docxPrinted(bytes) : htmlPrinted(bytes);
      data.headings = printed.headings;
      data.captions = printed.captions;
      data.tableCount = printed.tables;
      if (printed.pages !== null) data.pages = printed.pages;
      const same = v.priorTitles !== undefined && v.detail !== true && v.priorTitles === titlesOf(content);
      if (same) data.headingsUnchanged = true;
      // IMPL-W7: jumlah tabel per judul (" [tabel N]"); bila daftar judul tidak dicetak, satu baris "tabel per judul".
      const withTables = printed.headings.filter((h) => (h.tb ?? 0) > 0);
      lines.push(
        ...(same ? [`judul: ${printed.headings.length}, tidak berubah oleh suntingan ini (daftar: detail: true)`, ...(withTables.length > 0 ? [`tabel per judul: ${withTables.map((h) => `${h.t} [tabel ${h.tb}]`).join("; ")}`] : [])] : printed.headings.map((h) => `${"  ".repeat(Math.min(h.l, 2))}${h.k ? `${h.k} | ` : ""}${h.t}${(h.tb ?? 0) > 0 ? ` [tabel ${h.tb}]` : ""}`)),
        ...printed.captions.map((c) => `keterangan: ${c}`),
      );
    }
    const figs = v.kind === "client" ? figuresOf(content).slice(0, MAX_FIGURES) : [];
    if (figs.length > 0) {
      const figures: Rec[] = [];
      for (const f of figs) {
        // Route pratinjau figur FIG-03b (baca saja; tanpa job/berkas/baris DB), sama dengan studio_figure_preview.
        const pr = await http(ctx, "POST", `/api/studio/documents/${encodeURIComponent(v.documentId)}/figures/preview`, "POST /api/studio/documents/{id}/figures/preview", { json: { pid: f.pid } });
        const b = isRecord(pr.body) ? pr.body : {};
        const fig = isRecord(b.figure) ? b.figure : {};
        const issues = Array.isArray(fig.issues) ? fig.issues.filter(isRecord) : [];
        const layout = typeof fig.layoutIssueCount === "number" ? fig.layoutIssueCount : issues.filter((i) => i.info !== true).length;
        figures.push({ pid: f.pid, rendered: b.rendered === true, layoutIssues: layout, checks: [...new Set(issues.filter((i) => i.info !== true).map((i) => tok(i.checkId, "?")))] });
      }
      data.figures = figures;
    }
    if (data.record !== undefined) lines.push(`record: ${Object.entries(data.record as Record<string, unknown>).map(([k, x]) => `${k}=${Array.isArray(x) ? x.join(",") : String(x)}`).join("; ")}`);
    if (data.meta !== undefined) lines.push(`meta: ${Object.entries(data.meta as Record<string, unknown>).map(([k, x]) => `${k}=${String(x)}`).join("; ")}`);
  } catch (e) {
    data.error = tok(isRecord(e) && typeof (e as Rec).code === "string" ? (e as Rec).code : "VERIFY_INCOMPLETE", "VERIFY_INCOMPLETE");
  }
  const file = isRecord(data.file) ? data.file : null;
  const figs = Array.isArray(data.figures) ? (data.figures as Rec[]) : [];
  const issuesTotal = figs.reduce((n, f) => n + (typeof f.layoutIssues === "number" ? f.layoutIssues : 0), 0);
  const parts = [
    `verifikasi: rev tersimpan ${tok(data.storedRevision)}`,
    file !== null ? `berkas ${tok(file.fileId)} ${tok(file.format)} sha256 ${String(file.sha256).slice(0, 16)} ${file.shaMatch === true ? "cocok (dihitung ulang dari unduhan)" : "TIDAK cocok"}` : "tanpa berkas",
    ...(Array.isArray(data.headings) ? [`${(data.headings as unknown[]).length} judul`, `${(data.captions as unknown[]).length} keterangan`, `${tok(data.tableCount)} tabel`] : []),
    ...(typeof data.pages === "number" ? [`${data.pages} halaman`] : []),
    ...(figs.length > 0 ? [`figur ${figs.length}: ${issuesTotal} isu tata letak${issuesTotal > 0 ? ` (${figs.filter((f) => (f.layoutIssues as number) > 0).map((f) => tok(f.pid)).join(", ")})` : ""}`] : []),
    ...(isRecord(data.record) && typeof data.record.status === "string" ? [`status tersimpan ${tok(data.record.status)}`] : []),
    ...(typeof data.error === "string" ? [`ringkasan tidak lengkap (${data.error}); pakai studio_file_verify`] : []),
  ];
  return { data: neutralizeDeep(data) as Rec, line: parts.join("; "), block: lines.length > 0 ? untrustedBlock(lines.join("\n"), { jenis: "verifikasi", documentId: v.documentId }) : null };
}

/**
 * IMPL-W4 butir 3/5 (laporan kerja): tempel ringkasan verifikasi ke hasil `resultOutput` dan ringkas bawaannya
 * (baris `lanjut:` dan `nextSteps` hanya dengan `detail: true`). Render dibaca dari `data.render`.
 */
export async function withVerify(ctx: ToolContext, out: { text: string; data: Record<string, unknown>; warnings?: Array<{ code: string; message: string }> }, kind: "report" | "client", detail: boolean, priorTitles?: string): Promise<typeof out> {
  const id = typeof out.data.documentId === "string" ? out.data.documentId : null;
  if (id === null) return out;
  const r = isRecord(out.data.render) ? out.data.render : null;
  const render = r !== null && typeof r.fileId === "string" && typeof r.sha256 === "string" ? { fileId: r.fileId, sha256: r.sha256, format: String(r.format ?? "HTML"), bytes: typeof r.bytes === "number" ? r.bytes : null } : null;
  const v = await verifySummary(ctx, { documentId: id, kind, render, detail, ...(priorTitles !== undefined ? { priorTitles } : {}) });
  const keep = out.text.split("\n").filter((l) => detail || !l.startsWith("lanjut: studio_"));
  const data: Record<string, unknown> = { ...out.data, render: compactRender(out.data.render, detail), verify: compactVerify(v.data, detail), ...untrustedFields(detail ? ["verify.headings", "verify.captions", "verify.record"] : ["verify.record"]) };
  if (!detail) delete data.nextSteps;
  const lines = keep.filter((l) => detail || !l.startsWith("berkas: "));
  return { ...out, text: [...lines, v.line, ...(v.block !== null ? [v.block] : [])].join("\n"), data };
}

/**
 * IMPL-W4 butir 5: structuredContent ringkas. Daftar judul/keterangan sudah ada di blok teks; di structuredContent hanya
 * jumlahnya (daftar penuh dengan `detail: true`). Berkas cukup `shaMatch` (fileId + sha ada di `render`).
 */
export function compactVerify(data: Record<string, unknown>, detail: boolean): Record<string, unknown> {
  if (detail) return data;
  const out: Record<string, unknown> = { ...data };
  const file = isRecord(data.file) ? data.file : null;
  delete out.file;
  if (file !== null) out.shaMatch = file.shaMatch === true;
  if (Array.isArray(data.headings)) out.headingCount = data.headings.length;
  if (Array.isArray(data.captions)) out.captionCount = data.captions.length;
  delete out.headings;
  delete out.captions;
  if (Array.isArray(data.figures)) out.figures = (data.figures as Record<string, unknown>[]).map((f) => ({ pid: f.pid, layoutIssues: f.layoutIssues, ...((f.layoutIssues as number) > 0 ? { checks: f.checks } : {}) }));
  return out;
}

/** Render ringkas: fileId + sha256 + verified (bytes/format/nama final hanya dengan `detail: true`). */
export function compactRender(render: unknown, detail: boolean): unknown {
  if (detail || !isRecord(render)) return render;
  return { fileId: render.fileId, format: render.format, sha256: render.sha256, verified: render.verified };
}
