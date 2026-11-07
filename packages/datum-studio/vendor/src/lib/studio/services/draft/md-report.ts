/**
 * Laporan kerja MD-native untuk `studio-report` (R3-01; U-15, U-18; D-435). Murni: tanpa I/O, tanpa DB.
 *
 * Agen menulis laporan sebagai Markdown biasa (kepala `Kunci: nilai` + `##` per bab outline), alat
 * mengubahnya menjadi blok kiriman yang SAMA bentuknya dengan draf ber-blok ```json:
 *   slot `record` (studio.slot/v2) -> bab 1..n (studio.chapter/v2) -> slot `references` (bila ada).
 * Konversi isi memakai generator I64 `markdownToContract` (md2contract/v1 + importer md/v1) apa
 * adanya; modul ini hanya menambah alias (nama medan CF + label registri, judul/kunci outline CO)
 * lewat opsi `extraAliases` (alias registri menang) dan membaca kunci alat (misi, docKey, agentId,
 * basis) dari kepala. D-139: agen hanya menulis konten; KD-42: status/reportedAt hilang -> ditolak,
 * tidak ditebak.
 *
 * R3-F (D-439, D-440; review gateway_check/15):
 *   - `basis: <documentId>@rev<n>` di kepala dibaca (bukan dibuang): dasar update tiga arah (#1);
 *   - templat memakai placeholder `<isi: ...>` yang menolak konversi sampai diisi (#2);
 *   - bagian `## Rujukan` (tabel hubungan | dokumen | paragraf | revisi) -> `record.refs`; kunci kepala
 *     `initiator` / `pemberi tugas` -> `record.initiator`; `--agent-id` menang atas `agentId:` kepala;
 *   - butir kerja yang ditulis sebagai daftar diberi peringatan (butir = tabel, #3).
 */
import type { ContractKind, ContractKindDefV2, InlineV2, RunV2 } from "../../contract";
import { CONTRACT_REF_RELS, PARAGRAPH_ROLES_V2, PROVENANCE_MARKS } from "../../contract/enums";
import { DRAFT_BASIS_PATTERN, DRAFT_LIMITS, PID_PATTERN } from "../../contract/env";
import { getContractKindDef } from "../../registry/contracts";
import { ContractImportError, MD2CONTRACT_RECORD_TARGETS, markdownToContract, type ContractImportWarning } from "../import/contract";
import { inlineText as inlineTextOfV2, parseInline } from "../import/inline";
import { atxHeading } from "../import/lexer";
import {
  CARD_ID_RE,
  cleanValue,
  CONTRACT_KEY_RE,
  fenceMask,
  findTables,
  frontMatterEnd,
  frontMatterKeyValue,
  HEADER_SCAN_LINES,
  keyValueOf,
  normalizeHeading,
  normalizeSource,
} from "../import/contract/parse";
import type { MdImportDropped, MdImportWarning } from "../import/types";

export const MD_REPORT_DEFAULT_KIND: ContractKind = "agentWorkReport";

/** Kunci alat di kepala (huruf kecil, seperti `keyValueOf`): bukan isi laporan, tidak dikirim sebagai teks. */
export const MD_REPORT_TOOL_KEYS: Readonly<Record<string, "mission" | "docKey" | "agentId" | "basis" | "draftHeader">> = {
  mission: "mission",
  misi: "mission",
  dockey: "docKey",
  agentid: "agentId",
  // R3-F #1: dasar update (C56). Ditulis agen dari baris yang dicetak submit/update.
  basis: "basis",
  // Kepala draf C55 (sisa draf ber-blok json); tidak bermakna di laporan MD-native, dibuang.
  tujuan: "draftHeader",
  "langkah-berikut": "draftHeader",
};

export type MdReportErrorCode = "MD2CONTRACT_REQUIRED_MISSING" | "MD_REPORT_INVALID" | "MD_REPORT_TARGET_MISSING" | "MD_REPORT_TOO_LARGE" | "TEMPLATE_PLACEHOLDER" | "MERGE_CONFLICT_MARKER";

/** Galat konversi (isi laporan); `details` membawa peringatan CW bila ada. */
export class MdReportError extends Error {
  constructor(
    readonly code: MdReportErrorCode,
    message: string,
    readonly details: { missing?: string[]; warnings?: ContractImportWarning[]; lines?: number[] } = {},
  ) {
    super(message);
    this.name = "MdReportError";
  }
}

/** Alias tambahan dari registri: nama medan CF + label tampil (`labels.fields`), judul + kunci outline CO. */
export function mdReportAliases(def: ContractKindDefV2): { headerKeys: Record<string, string>; headings: Record<string, string> } {
  const headerKeys: Record<string, string> = {};
  for (const f of MD2CONTRACT_RECORD_TARGETS) {
    headerKeys[f.toLowerCase()] = f;
    const label = def.labels.fields[f];
    if (typeof label === "string") headerKeys[label.toLowerCase()] = f;
  }
  const headings: Record<string, string> = {};
  for (const o of def.outline) {
    headings[normalizeHeading(o.title)] = `content:${o.chapterKey}`;
    headings[normalizeHeading(o.outlineKey)] = `content:${o.chapterKey}`;
  }
  return { headerKeys, headings };
}

/** Judul `##` (ternormalisasi) bagian rujukan antar-dokumen -> `record.refs` (D-440). */
export const MD_REPORT_REFS_HEADINGS: readonly string[] = ["rujukan", "rujukan dokumen", "refs"];

/** Aturan nama kunci kepala dan judul bab yang dikenali (gabungan registri + alias tambahan), untuk `--help`. */
export function mdReportRules(kind: ContractKind = MD_REPORT_DEFAULT_KIND): { headerKeys: Record<string, string[]>; chapters: Array<{ key: string; titles: string[] }>; statuses: string[]; refRels: string[] } {
  const def = defOf(kind);
  const extra = mdReportAliases(def);
  const keys: Record<string, string> = { ...extra.headerKeys, ...def.aliases.headerKeys };
  const headerKeys: Record<string, string[]> = {};
  for (const [k, target] of Object.entries(keys)) (headerKeys[target] ??= []).push(k);
  const headings: Record<string, string> = { ...extra.headings, ...def.aliases.headings };
  const chapters = def.outline.map((o) => ({
    key: o.chapterKey,
    titles: Object.entries(headings)
      .filter(([, t]) => t === `content:${o.chapterKey}`)
      .map(([h]) => h),
  }));
  return { headerKeys, chapters, statuses: def.statuses.map((s) => s.code), refRels: [...CONTRACT_REF_RELS] };
}

function defOf(kind: ContractKind): ContractKindDefV2 {
  const def = getContractKindDef(kind);
  if (!def) throw new MdReportError("MD_REPORT_INVALID", `jenis kontrak tidak dikenal: ${String(kind)}`);
  return def;
}

// ── Placeholder templat (R3-F #2, D-439) ────────────────────────────────

/** Placeholder templat: `<isi: petunjuk>`. Tidak punya alias/pola mana pun, jadi tidak pernah lolos sebagai nilai. */
export const PLACEHOLDER_RE = /<isi:[^>\n]*>/;
const placeholder = (hint: string) => `<isi: ${hint.replace(/[<>|\n]/g, " ").replace(/\s+/g, " ").trim()}>`;

/**
 * Baris (1-based) yang masih memuat placeholder templat. Bawaan: di mana pun (termasuk blok ```json
 * draf templat). R3-F2 N8: `skipFences` (jalur MD) mengabaikan baris di dalam pagar kode, sehingga
 * laporan yang MENGUTIP sintaks `<isi: ...>` di blok kode tidak ditolak.
 */
export function findPlaceholders(text: string, opts: { skipFences?: boolean } = {}): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = normalizeSource(text).split("\n");
  const mask = opts.skipFences ? fenceMask(lines) : null;
  lines.forEach((l, i) => {
    if (mask?.[i]) return;
    const m = PLACEHOLDER_RE.exec(l);
    if (m) out.push({ line: i + 1, text: m[0].slice(0, 80) });
  });
  return out;
}

/** Galat bila masih ada placeholder: templat yang belum diisi tidak pernah tersimpan (D-439). */
export function assertNoPlaceholders(text: string, opts: { skipFences?: boolean } = {}): void {
  const hits = findPlaceholders(text, opts);
  if (hits.length === 0) return;
  const shown = hits.slice(0, 8).map((h) => `baris ${h.line} ${h.text}`);
  throw new MdReportError(
    "TEMPLATE_PLACEHOLDER",
    `laporan masih memuat ${hits.length} placeholder templat yang belum diisi (${shown.join("; ")}${hits.length > 8 ? "; ..." : ""}). Ganti setiap <isi: ...> dengan isi nyata (atau hapus barisnya bila tidak berlaku). Tidak ada yang dikirim`,
    { lines: hits.map((h) => h.line) },
  );
}

// ── Penanda konflik `refresh` (R3-F2 N1) ────────────────────────────────

/** Baris penanda konflik yang ditulis `studio-report refresh` (di luar pagar kode). */
export const CONFLICT_MARKER_RE = /^(?:<{7}|>{7})(?: |$)/;

/** Galat bila laporan masih memuat penanda konflik: pilih/gabungkan satu versi dulu (tidak ditebak). */
export function assertNoConflictMarkers(text: string): void {
  const lines = normalizeSource(text).split("\n");
  const mask = fenceMask(lines);
  const hits = lines.flatMap((l, i) => (!mask[i] && CONFLICT_MARKER_RE.test(l) ? [i + 1] : []));
  if (hits.length === 0) return;
  throw new MdReportError(
    "MERGE_CONFLICT_MARKER",
    `laporan masih memuat penanda konflik refresh (baris ${hits.slice(0, 8).join(", ")}${hits.length > 8 ? ", ..." : ""}). Untuk setiap blok <<<<<<< ... ======= ... >>>>>>>: pertahankan satu versi (atau gabungkan isinya), lalu hapus ketiga baris penanda. Tidak ada yang dikirim`,
    { lines: hits },
  );
}

// ── Penghapusan eksplisit `~~hapus~~` (R3-F2 N4) ────────────────────────

/** Sel penanda penghapusan eksplisit baris tabel butir/rujukan. */
export const REMOVE_MARK_RE = /~~\s*hapus\s*~~/i;
const ITEM_KEY_HEADERS: readonly string[] = ["id", "kartu", "card", "key"];

export interface MdReportRemovals {
  /** Kunci butir yang barisnya ditandai `~~hapus~~` (baris dibuang sebelum konversi). */
  items: string[];
  /** Rujukan yang barisnya ditandai `~~hapus~~` di bagian Rujukan. */
  refs: Array<{ rel: string; documentId: string }>;
}

/**
 * Baris tabel butir (kolom key|id|kartu + status) yang memuat sel `~~hapus~~` dibuang dari teks
 * sebelum konversi dan dicatat sebagai penghapusan eksplisit. Peta baris baru -> baris asli
 * dikembalikan agar nomor baris peringatan tetap menunjuk berkas asli.
 */
function takeItemRemovals(markdown: string): { markdown: string; items: string[]; lineMap: number[] | null } {
  const lines = markdown.split("\n");
  const mask = fenceMask(lines);
  const drop = new Set<number>();
  const items: string[] = [];
  for (const t of findTables(lines, mask)) {
    const cols = t.header.map((c) => cleanValue(c).replace(/[*_`]/g, "").trim().toLowerCase());
    const keyIdx = cols.findIndex((c) => ITEM_KEY_HEADERS.includes(c));
    if (keyIdx < 0 || !cols.includes("status")) continue;
    for (const r of t.rows) {
      if (!r.cells.some((c) => REMOVE_MARK_RE.test(c))) continue;
      const key = cleanValue(r.cells[keyIdx] ?? "");
      if (CONTRACT_KEY_RE.test(key) && !items.includes(key)) items.push(key);
      drop.add(r.line - 1);
    }
  }
  if (drop.size === 0) return { markdown, items, lineMap: null };
  const lineMap: number[] = [];
  const kept = lines.filter((_, i) => {
    if (drop.has(i)) return false;
    lineMap.push(i + 1);
    return true;
  });
  return { markdown: kept.join("\n"), items, lineMap };
}

// ── Kunci alat ──────────────────────────────────────────────────────────

export type MdReportBasis = { kind: "new" } | { kind: "revision"; documentId: string; revisionNo: number };

export interface MdReportToolValues {
  mission: string | null;
  docKey: string | null;
  agentId: string | null;
  /** Nilai mentah baris `basis:` (null bila tidak ada). */
  basis: string | null;
  /** Baris (1-based) kunci alat yang dikosongkan sebelum konversi. */
  lines: number[];
  /** R3-F #12: kunci alat yang ditulis lebih dari sekali dengan nilai berbeda (nilai pertama dipakai). */
  duplicates: Array<{ key: string; line: number; kept: string; ignored: string }>;
}

/**
 * Baca dan kosongkan kunci alat di wilayah kepala yang sama dengan generator (frontmatter + baris
 * `Kunci: nilai` di {@link HEADER_SCAN_LINES} baris pertama sebelum `##` pertama, di luar pagar).
 * Baris dikosongkan (bukan dihapus) agar nomor baris peringatan tetap menunjuk berkas asli.
 */
export function stripToolKeys(markdown: string): { markdown: string; tool: MdReportToolValues } {
  const lines = normalizeSource(markdown).split("\n");
  const mask = fenceMask(lines);
  const tool: MdReportToolValues = { mission: null, docKey: null, agentId: null, basis: null, lines: [], duplicates: [] };
  const take = (i: number, key: string, value: string) => {
    const kind = MD_REPORT_TOOL_KEYS[key];
    if (kind === undefined) return;
    const v = cleanValue(value);
    if (kind !== "draftHeader" && v !== "") {
      const prev = tool[kind];
      if (prev === null) tool[kind] = v;
      else if (prev !== v) tool.duplicates.push({ key, line: i + 1, kept: prev, ignored: v });
    }
    tool.lines.push(i + 1);
    lines[i] = "";
  };
  const fmEnd = frontMatterEnd(lines);
  for (let i = 1; i < fmEnd; i++) {
    const kv = frontMatterKeyValue(lines[i]);
    if (kv) take(i, kv.key, kv.value);
  }
  const start = fmEnd >= 0 ? fmEnd + 1 : 0;
  for (let i = start; i < Math.min(lines.length, HEADER_SCAN_LINES); i++) {
    if (mask[i]) continue;
    const h = atxHeading(lines[i]);
    if (h && h.level === 2) break;
    if (h || lines[i].trim().startsWith("|")) continue;
    const kv = keyValueOf(lines[i]);
    if (kv) take(i, kv.key, kv.value);
  }
  return { markdown: lines.join("\n"), tool };
}

const BASIS_RE = new RegExp(DRAFT_BASIS_PATTERN);

/** `basis:` C56 -> dasar; null bila tidak ditulis; galat bila bentuknya salah (tidak ditebak). */
export function parseMdBasis(raw: string | null): MdReportBasis | null {
  if (raw === null) return null;
  const m = BASIS_RE.exec(raw);
  if (!m) throw new MdReportError("MD_REPORT_INVALID", `baris basis tidak sah: "${raw.slice(0, 80)}"; bentuknya "basis: <documentId>@rev<n>" (salin baris yang dicetak submit/update) atau "basis: baru"`);
  return m[1] === undefined ? { kind: "new" } : { kind: "revision", documentId: m[1], revisionNo: Number(m[2]) };
}

// ── Rujukan antar-dokumen (D-440) ───────────────────────────────────────

const REF_COLUMNS: Readonly<Record<string, "rel" | "documentId" | "pid" | "revisionNo">> = {
  rel: "rel",
  hubungan: "rel",
  relasi: "rel",
  documentid: "documentId",
  dokumen: "documentId",
  document: "documentId",
  pid: "pid",
  paragraf: "pid",
  paragraph: "pid",
  revisi: "revisionNo",
  revision: "revisionNo",
  revisionno: "revisionNo",
  rev: "revisionNo",
};

/** Hubungan rujukan: kode E48 + padanan Indonesia (huruf kecil). */
const REF_REL_ALIASES: Readonly<Record<string, (typeof CONTRACT_REF_RELS)[number]>> = {
  basis: "basis",
  dasar: "basis",
  evidence: "evidence",
  bukti: "evidence",
  output: "output",
  keluaran: "output",
  hasil: "output",
  supersedes: "supersedes",
  menggantikan: "supersedes",
};

const DOCUMENT_ID_RE = /^[a-z0-9]{20,40}$/;
const PID_RE = new RegExp(PID_PATTERN);

export interface MdReportRef {
  documentId: string;
  pid?: string;
  revisionNo?: number;
  rel: (typeof CONTRACT_REF_RELS)[number];
}

/**
 * Ambil bagian `## Rujukan` (judul {@link MD_REPORT_REFS_HEADINGS}) sebagai tabel -> refs; baris
 * bagian itu dikosongkan (bukan dihapus) sebelum konversi. Baris yang tidak dapat dipetakan -> galat
 * (rujukan tidak pernah dibuang diam-diam atau ditebak).
 */
export function extractRefs(markdown: string): { markdown: string; refs: MdReportRef[]; line: number | null; removed: Array<{ rel: string; documentId: string }> } {
  const removed: Array<{ rel: string; documentId: string }> = [];
  const lines = markdown.split("\n");
  const mask = fenceMask(lines);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const h = atxHeading(lines[i]);
    if (h && h.level === 2 && MD_REPORT_REFS_HEADINGS.includes(normalizeHeading(h.text))) {
      start = i;
      break;
    }
  }
  if (start < 0) return { markdown, refs: [], line: null, removed };
  let end = start + 1;
  while (end < lines.length && (mask[end] || atxHeading(lines[end])?.level !== 2)) end++;
  const body = lines.slice(start + 1, end);
  const bodyMask = mask.slice(start + 1, end);
  const tables = findTables(body, bodyMask);
  const inTable = new Set<number>();
  for (const t of tables) {
    inTable.add(t.line - 1);
    inTable.add(t.line);
    for (const r of t.rows) inTable.add(r.line - 1);
  }
  const errors: string[] = [];
  const lineOf = (k: number) => start + 1 + k + 1;
  body.forEach((l, k) => {
    if (l.trim() !== "" && !inTable.has(k)) errors.push(`baris ${lineOf(k)} di luar tabel rujukan`);
  });
  const refs: MdReportRef[] = [];
  for (const t of tables) {
    const cols = t.header.map((c) => REF_COLUMNS[cleanValue(c).replace(/[*_`]/g, "").trim().toLowerCase()] ?? null);
    const idx = (f: "rel" | "documentId" | "pid" | "revisionNo") => cols.indexOf(f);
    if (idx("rel") < 0 || idx("documentId") < 0) {
      errors.push(`tabel baris ${lineOf(t.line - 1)} tidak berkolom hubungan + dokumen`);
      continue;
    }
    for (const r of t.rows) {
      const cell = (i: number) => (i >= 0 && i < r.cells.length ? cleanValue(r.cells[i]) : "");
      const where = `baris ${lineOf(r.line - 1)}`;
      // R3-F2 N4: baris bertanda ~~hapus~~ = penghapusan eksplisit (tidak masuk refs).
      if (r.cells.some((c) => REMOVE_MARK_RE.test(c))) {
        const relRaw = cell(idx("rel")).toLowerCase();
        removed.push({ rel: REF_REL_ALIASES[relRaw] ?? relRaw, documentId: cell(idx("documentId")) });
        continue;
      }
      const rel = REF_REL_ALIASES[cell(idx("rel")).toLowerCase()];
      const documentId = cell(idx("documentId"));
      const pid = cell(idx("pid"));
      const revRaw = cell(idx("revisionNo")).replace(/^rev/i, "");
      if (!rel) errors.push(`${where}: hubungan "${cell(idx("rel"))}" bukan ${CONTRACT_REF_RELS.join("|")}`);
      if (!DOCUMENT_ID_RE.test(documentId)) errors.push(`${where}: dokumen "${documentId}" bukan documentId (20-40 huruf kecil/angka)`);
      if (pid !== "" && !PID_RE.test(pid)) errors.push(`${where}: paragraf "${pid}" bukan pid`);
      if (revRaw !== "" && !/^[1-9][0-9]{0,5}$/.test(revRaw)) errors.push(`${where}: revisi "${revRaw}" bukan bilangan bulat positif`);
      if (rel && DOCUMENT_ID_RE.test(documentId)) {
        refs.push({ documentId, ...(pid !== "" && PID_RE.test(pid) ? { pid } : {}), ...(/^[1-9][0-9]{0,5}$/.test(revRaw) ? { revisionNo: Number(revRaw) } : {}), rel });
      }
    }
  }
  if (errors.length > 0) {
    throw new MdReportError(
      "MD_REPORT_INVALID",
      `bagian Rujukan tidak dapat dipetakan ke refs: ${errors.slice(0, 6).join("; ")}${errors.length > 6 ? "; ..." : ""}. Tulis sebagai tabel "| hubungan | dokumen | paragraf | revisi |" (hubungan ${CONTRACT_REF_RELS.join("|")}; dokumen = documentId; paragraf/revisi opsional). Tidak ada yang dikirim`,
    );
  }
  for (let i = start; i < end; i++) lines[i] = "";
  return { markdown: lines.join("\n"), refs, line: start + 1, removed };
}

// ── Konversi ────────────────────────────────────────────────────────────

export interface MdReportOptions {
  kind?: ContractKind;
  /** `create` (submit: record membawa template + meta + target misi) atau `update` (target diganti documentId oleh pemanggil). */
  mode: "create" | "update";
  /** Menimpa kunci alat kepala. */
  mission?: string | null;
  docKey?: string | null;
  /** D-440: `--agent-id` menang atas `agentId:` kepala (peringatan bila berbeda). */
  agentId?: string | null;
  /** update: dokumen tujuan (`target: { documentId }`; misi/docKey kepala tidak dipakai). */
  documentId?: string;
}

/** Catatan konversi milik md-report (bukan CW generator). */
export interface MdReportNotice {
  code: "MD_REPORT_ITEMS_AS_LIST" | "MD_REPORT_TOOL_KEY_DUPLICATE" | "AGENT_ID_OVERRIDDEN";
  line?: number;
  message: string;
}

export interface MdReportConversion {
  format: "md";
  title: string;
  mission: string | null;
  docKey: string | null;
  agentId: string | null;
  /** R3-F #1: baris `basis:` kepala (null = tidak ditulis). */
  basis: MdReportBasis | null;
  /** Peringatan CW generator (status/medan/judul tanpa alias), nomor baris berkas asli. */
  warnings: ContractImportWarning[];
  /** Catatan md-report (butir berbentuk daftar, kunci alat ganda, agentId ditimpa). */
  notices: MdReportNotice[];
  /** Unsur Markdown yang tidak dibawa importer md/v1, per bab. */
  dropped: Array<MdImportDropped & { chapterKey: string }>;
  proseWarnings: Array<MdImportWarning & { chapterKey: string }>;
  /** Bab outline wajib yang kosong di laporan. */
  missingChapters: string[];
  /** Bagian hasil konversi, urut kirim: `record`, `bab 1`, ..., `references`. */
  parts: string[];
  /** D-440: jumlah rujukan `refs` dari bagian Rujukan. */
  refs: number;
  /** R3-F2 N4: baris tabel butir/rujukan bertanda `~~hapus~~` (penghapusan eksplisit). */
  removals: MdReportRemovals;
}

export interface MdReportResult {
  blocks: Array<Record<string, unknown>>;
  conversion: MdReportConversion;
}

/** Bentuk C54 maks laporan MD (sama dengan importer md/v1). */
export const MD_REPORT_MAX_CHARS = 1_000_000;

/** Butir daftar yang tampak seperti butir kerja: diawali id kartu C34 atau kunci C35 berangka. */
const LIST_ITEM_RE = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?[*_`]*([A-Za-z0-9][A-Za-z0-9._-]{0,63})/;

function itemsAsList(lines: readonly string[]): number[] {
  const mask = fenceMask(lines);
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (mask[i]) return;
    const m = LIST_ITEM_RE.exec(l);
    if (m && (CARD_ID_RE.test(m[1]) || (CONTRACT_KEY_RE.test(m[1]) && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1])))) out.push(i + 1);
  });
  return out;
}

/**
 * U-15 — laporan kerja MD-native -> blok kiriman (urutan kirim). Melempar {@link MdReportError}:
 * `MD2CONTRACT_REQUIRED_MISSING` (status/reportedAt hilang atau tanpa alias; KD-42),
 * `TEMPLATE_PLACEHOLDER` (templat belum diisi), `MD_REPORT_TARGET_MISSING` (create tanpa misi/docKey),
 * `MD_REPORT_INVALID` (basis/rujukan tidak sah), `MD_REPORT_TOO_LARGE`.
 */
export function mdReportToBlocks(markdown: string, opts: MdReportOptions): MdReportResult {
  const kind = opts.kind ?? MD_REPORT_DEFAULT_KIND;
  const def = defOf(kind);
  if (markdown.length > MD_REPORT_MAX_CHARS) throw new MdReportError("MD_REPORT_TOO_LARGE", `laporan melebihi ${MD_REPORT_MAX_CHARS} karakter`);
  assertNoPlaceholders(markdown, { skipFences: true });
  assertNoConflictMarkers(markdown);
  const stripped = stripToolKeys(markdown);
  const tool = stripped.tool;
  const basis = parseMdBasis(tool.basis);
  const extracted = extractRefs(stripped.markdown);
  const refs = extracted.refs;
  const removal = takeItemRemovals(extracted.markdown);
  const body = removal.markdown;
  const origLine = (n: number) => (removal.lineMap !== null && n > 0 && n <= removal.lineMap.length ? removal.lineMap[n - 1] : n);
  const mission = opts.mission ?? tool.mission;
  const docKey = opts.docKey ?? tool.docKey;
  if (opts.mode === "create" && (mission === null || docKey === null)) {
    const miss = [...(mission === null ? ["mission"] : []), ...(docKey === null ? ["docKey"] : [])];
    throw new MdReportError(
      "MD_REPORT_TARGET_MISSING",
      `kepala laporan tidak memuat ${miss.join(" dan ")}; tulis baris "mission: <folder misi>" dan "docKey: <kunci dokumen>" di kepala (atau --mission / --doc-key). Tidak ditebak`,
      { missing: miss },
    );
  }
  const notices: MdReportNotice[] = tool.duplicates.map((d) => ({
    code: "MD_REPORT_TOOL_KEY_DUPLICATE",
    line: d.line,
    message: `kunci "${d.key}" ditulis lebih dari sekali dengan nilai berbeda; dipakai "${d.kept}", diabaikan "${d.ignored}"`,
  }));
  const optAgent = opts.agentId !== undefined && opts.agentId !== null && opts.agentId !== "" ? opts.agentId : null;
  if (optAgent !== null && tool.agentId !== null && tool.agentId !== optAgent) {
    notices.push({ code: "AGENT_ID_OVERRIDDEN", message: `--agent-id "${optAgent}" menggantikan agentId kepala "${tool.agentId}" (opsi menang, D-440)` });
  }
  const agentId = optAgent ?? tool.agentId;
  let res: ReturnType<typeof markdownToContract>;
  try {
    res = markdownToContract(body, { kind, extraAliases: mdReportAliases(def) });
  } catch (e) {
    if (e instanceof ContractImportError) {
      if (e.code === "MD2CONTRACT_REQUIRED_MISSING") {
        const hint = e.missing.map((m) => (m === "status" ? `"Status: ${def.statuses.map((s) => s.code).join("|")}"` : `"ReportedAt: YYYY-MM-DD atau YYYY-MM-DDTHH:MM+07:00"`));
        const warnings = (e.report?.warnings ?? []).map((w) => ({ ...w, line: origLine(w.line) }));
        // R3-F2 N7: sebut nilai majemuk (alasan sudah ada di CW) agar agen tahu mengapa ditolak.
        const compound = warnings
          .filter((w) => w.code === "CONTRACT_STATUS_UNMAPPED" && isPlain(w.details) && w.details.reason === "compound" && w.details.scope === "record")
          .map((w) => `${String((w.details as Record<string, unknown>).field)} "${String((w.details as Record<string, unknown>).value)}" majemuk (baris ${w.line}; tulis satu nilai saja)`);
        throw new MdReportError(
          "MD2CONTRACT_REQUIRED_MISSING",
          `nilai wajib record tidak ditemukan atau tanpa alias: ${e.missing.join(", ")}${compound.length > 0 ? ` (${compound.join("; ")})` : ""}; tulis ${hint.join(" dan ")} di kepala laporan. Tidak ditebak (KD-42), tidak ada yang dikirim`,
          { missing: [...e.missing], warnings },
        );
      }
      throw new MdReportError("MD_REPORT_INVALID", `laporan tidak dapat dikonversi: ${e.message}`);
    }
    // Pertahanan (#14): batas md/v1 = MD_REPORT_MAX_CHARS sudah dicek di atas; dibiarkan bila batas importer berubah.
    if (e instanceof Error && (e as { code?: unknown }).code === "PAYLOAD_TOO_LARGE") throw new MdReportError("MD_REPORT_TOO_LARGE", e.message);
    throw e;
  }
  const { doc, report } = res;
  const sections = doc.sections as Record<string, unknown>;
  if (opts.mode === "update" && !opts.documentId) throw new MdReportError("MD_REPORT_INVALID", "update memerlukan documentId");
  const target = opts.mode === "update" ? { documentId: opts.documentId } : { mission: { folder: mission }, docKey };
  const agent = agentId !== null ? { agentId } : {};
  const record: Record<string, unknown> = { ...(sections.record as Record<string, unknown>), ...(refs.length > 0 ? { refs } : {}) };
  if (record.items === undefined) {
    const listLines = itemsAsList(body.split("\n")).map(origLine);
    if (listLines.length > 0) {
      notices.push({
        code: "MD_REPORT_ITEMS_AS_LIST",
        line: listLines[0],
        message: `${listLines.length} butir daftar tampak seperti butir kerja (baris ${listLines.slice(0, 5).join(", ")}) tetapi butir kerja hanya dibaca dari TABEL "| key | judul | status |"; record tidak memuat items[]`,
      });
    }
  }
  const blocks: Array<Record<string, unknown>> = [];
  const parts: string[] = [];
  blocks.push({
    $schema: "studio.slot/v2",
    ...agent,
    target,
    ...(opts.mode === "create" ? { template: doc.template, meta: doc.meta } : {}),
    slot: "record",
    payload: record,
  });
  parts.push("record");
  const content = sections.content as { chapters?: Array<Record<string, unknown>> } | undefined;
  for (const chapter of content?.chapters ?? []) {
    blocks.push({ $schema: "studio.chapter/v2", ...agent, target, chapter });
    parts.push(`bab ${String(chapter.key)}`);
  }
  if (sections.references !== undefined) {
    blocks.push({ $schema: "studio.slot/v2", ...agent, target, slot: "references", payload: sections.references });
    parts.push("references");
  }
  // #11: batas C54 draf hasil konversi diperiksa di sini dengan pesan khusus MD (bukan DRAFT_TOO_LONG generik).
  if (blocks.length > DRAFT_LIMITS.maxBlocks) {
    throw new MdReportError(
      "MD_REPORT_TOO_LARGE",
      `laporan menghasilkan ${blocks.length} bagian (batas ${DRAFT_LIMITS.maxBlocks}: record + bab + references); gabungkan judul ## tambahan (bab 6 dst.) atau pindahkan isinya ke bab outline`,
    );
  }
  const jsonChars = blocks.reduce((n, b) => n + JSON.stringify(b, null, 2).length + 16, 0);
  if (jsonChars > DRAFT_LIMITS.maxChars - 4096) {
    throw new MdReportError("MD_REPORT_TOO_LARGE", `laporan terlalu besar setelah konversi (~${jsonChars} karakter, batas ${DRAFT_LIMITS.maxChars}); pecah menjadi beberapa update per bab (--section)`);
  }
  const conversion: MdReportConversion = {
    format: "md",
    title: doc.meta.title,
    mission,
    docKey,
    agentId,
    basis,
    warnings: report.warnings.map((w) => ({ ...w, line: origLine(w.line) })),
    notices,
    dropped: report.mapping.prose.flatMap((p) => p.dropped.map((d) => ({ ...d, line: origLine(d.line), chapterKey: p.chapterKey }))),
    proseWarnings: report.mapping.prose.flatMap((p) => p.warnings.map((w) => ({ ...w, line: origLine(w.line), chapterKey: p.chapterKey }))),
    missingChapters: report.mapping.missingChapters,
    parts,
    refs: refs.length,
    removals: { items: removal.items, refs: extracted.removed },
  };
  return { blocks, conversion };
}

/** Kepala draf ber-blok ```json di memori. */
export interface DraftHeadOptions {
  tujuan?: string;
  /** `basis:` C56 (bawaan `baru`). */
  basis?: MdReportBasis | null;
}

/** Draf ber-blok ```json di memori dari blok kiriman (masukan pipa `draft-check`/`studio-report` yang sudah ada). */
export function blocksToDraftMarkdown(title: string, blocks: ReadonlyArray<Record<string, unknown>>, head: DraftHeadOptions = {}): string {
  const basis = head.basis && head.basis.kind === "revision" ? `${head.basis.documentId}@rev${head.basis.revisionNo}` : "baru";
  const h = `# ${title.replace(/\s+/g, " ").trim()}\ntujuan: ${head.tujuan ?? "laporan kerja MD-native (studio-report)"}\nlangkah-berikut: kirim ke Studio\nbasis: ${basis}\n`;
  return `${h}\n${blocks.map((b) => `\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`).join("\n")}`;
}

// ── Isi -> Markdown LOSSLESS (R3-F2 N2; `studio-report refresh`) ─────────
//
// Kebalikan importer untuk setiap bentuk yang dihasilkan konversi laporan MD: run `{ t }` berpenanda
// (strong/em/code/sup/sub, `<br>`), paragraf + rel + peran (`<!-- role: x -->`), subjudul (`###`),
// daftar (berurut/tidak; daftar bersebelahan diberi penanda berbeda), tabel (+ caption `Tabel:` +
// `Sumber:`), blok kode (pagar lebih panjang dari isi), kutipan (+ varian `[!X]` + label), gambar,
// referensi, rujukan, kepala record. Setiap inline diverifikasi bolak-balik dengan pengurai yang SAMA
// (`parseInline`); bentuk yang tidak dapat diwakili -> null + alasan (BUKAN teks penanda), dan pemanggil
// memverifikasi lagi per bagian lewat konversi ulang penuh (`mdReportToBlocks`).

function isPlain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Kesamaan struktural tanpa urutan kunci; medan `id` (pid) dan nilai undefined diabaikan. */
export function sameStructure(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameStructure(x, b[i]));
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a).filter((k) => k !== "id" && a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => k !== "id" && b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameStructure(a[k], b[k]));
  }
  return a === b;
}

/** Bagian inline (`{ text }` XOR `{ runs }`) dari objek apa pun (paragraf, sel, judul), atau null. */
function inlinePart(v: unknown): InlineV2 | null {
  if (!isPlain(v)) return null;
  if (typeof v.text === "string" && v.runs === undefined) return { text: v.text };
  if (Array.isArray(v.runs) && v.text === undefined) return { runs: v.runs as RunV2[] };
  return null;
}

/**
 * Teks polos inline untuk bentuk apa pun (string, `{ text }`, `{ runs }` dengan run `{ t }`, larik).
 * Satu ekstraktor (R3-F2 N5/N11): bentuk sah diteruskan ke `import/inline.inlineText`.
 */
export function plainTextOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(plainTextOf).join("");
  const inline = inlinePart(v);
  if (inline === null) return "";
  if ("runs" in inline) return inlineTextOfV2({ runs: inline.runs.filter(isPlain) as RunV2[] });
  return inlineTextOfV2(inline);
}

const NOOP_SINK = { warn: () => undefined, drop: () => undefined };
const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/;
const ENTITY_AHEAD_RE = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/;
const CARD_ID_TEXT_RE = /(?<![A-Za-z0-9_])t_[0-9a-f]{8}(?![A-Za-z0-9_])/g;
const HR_LINE_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** Paragraf yang akan dianggap caption/sumber tabel atau gambar oleh importer (`markdown.ts`). */
const CAPTIONISH_RE = /^(?:\*{1,2}|_{1,2})?(?:Tabel|Table|Gambar|Figure|Fig|Sumber|Source)\b/i;
const DISPLAY_NUM_RE = /^[([]?(?:\d{1,3}|[A-Za-z]{1,3})[.)\]]\s/;
const SECTION_NUM_LEAD_RE = /^(?:[A-Z]|[0-9]+)(?:\.[0-9]+)+\.?\s/;
const ASSET_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>)\]`"']+/;

/** Konteks serialisasi: `cardIds` record tujuan + kunci bab outline + alasan gagal pertama. */
export interface MdSerializeCtx {
  outlineKeys: ReadonlySet<string>;
  why: string | null;
}

export function newSerializeCtx(kind: ContractKind = MD_REPORT_DEFAULT_KIND): MdSerializeCtx {
  return { outlineKeys: new Set(defOf(kind).outline.map((o) => o.chapterKey)), why: null };
}

function fail<T>(ctx: MdSerializeCtx, why: string): T | null {
  ctx.why ??= why;
  return null;
}

type InlineCtx = "prose" | "cell" | "heading" | "alt" | "citation";

/** Escape teks run. `full` = juga `_`, `]`, setiap `<`/`&`/`~`/`\` (dicoba bila escape minimal tidak bolak-balik). */
function escapeRun(t: string, full: boolean, ctx: InlineCtx): string {
  // Id kartu di prosa di-escape (`t\_xxxxxxxx`): teksnya sama, tetapi pemindai kepala 40 baris tidak
  // menambahkannya ke cardIds (cardIds record ditulis utuh di baris CardIds kepala).
  const cardUnderscore = new Set<number>();
  if (ctx !== "cell") for (const m of t.matchAll(CARD_ID_TEXT_RE)) cardUnderscore.add((m.index ?? 0) + 1);
  let o = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    const next = t[i + 1];
    let esc: boolean;
    switch (c) {
      case "*":
      case "`":
      case "[":
        esc = true;
        break;
      case "\\":
        // `\` di ujung teks run bisa bersambung dengan penanda run berikutnya -> selalu di-escape.
        esc = full || next === undefined || ASCII_PUNCT_RE.test(next);
        break;
      case "<":
        esc = full || (next !== undefined && /[A-Za-z/!]/.test(next));
        break;
      case "&":
        esc = full || ENTITY_AHEAD_RE.test(t.slice(i));
        break;
      case "]":
        esc = full;
        break;
      case "~":
        esc = full || next === "~" || t[i - 1] === "~";
        break;
      case "_":
        esc = full || cardUnderscore.has(i);
        break;
      case "|":
        esc = ctx === "cell";
        break;
      case "#":
        esc = ctx === "heading";
        break;
      default:
        esc = false;
    }
    o += esc ? `\\${c}` : c;
  }
  return o;
}

/** Span kode dengan pagar backtick lebih panjang dari deret backtick isi (+ spasi pengapit bila perlu). */
function codeSpan(t: string, ctx: InlineCtx): string | null {
  if (t.includes("\n") || t === "") return null;
  const longest = Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = t.startsWith("`") || t.endsWith("`") || (t.startsWith(" ") && t.endsWith(" ") && t.trim() !== "") ? " " : "";
  const body = ctx === "cell" ? t.replace(/\|/g, "\\|") : t;
  return `${fence}${pad}${body}${pad}${fence}`;
}

function renderInline(inline: InlineV2, style: "md" | "html", full: boolean, ctx: InlineCtx): string | null {
  const runs: unknown[] = "text" in inline ? [{ t: inline.text }] : inline.runs;
  let out = "";
  for (const r of runs) {
    if (!isPlain(r)) return null;
    if (r.br === "line") {
      out += "<br>";
      continue;
    }
    // `{ tab }` dan bentuk lain tidak punya padanan Markdown.
    if (typeof r.t !== "string") return null;
    let s = r.code === true ? codeSpan(r.t, ctx) : escapeRun(r.t, full, ctx);
    if (s === null) return null;
    if (r.sup === true) s = `<sup>${s}</sup>`;
    else if (r.sub === true) s = `<sub>${s}</sub>`;
    if (style === "md") {
      if (r.strong === true && r.em === true) s = `***${s}***`;
      else if (r.strong === true) s = `**${s}**`;
      else if (r.em === true) s = `*${s}*`;
    } else {
      if (r.em === true) s = `<i>${s}</i>`;
      if (r.strong === true) s = `<b>${s}</b>`;
    }
    out += s;
  }
  return out;
}

/**
 * Inline -> Markdown yang diurai kembali PERSIS menjadi inline yang sama (diverifikasi dengan
 * `parseInline`). Urutan percobaan: penanda Markdown + escape minimal, tag HTML + escape minimal,
 * lalu keduanya dengan escape penuh. null = tidak dapat diwakili (mis. run `{ tab }`).
 */
export function inlineToMarkdown(v: unknown, ctx: InlineCtx = "prose"): string | null {
  const inline = inlinePart(v);
  if (inline === null) return null;
  for (const full of [false, true]) {
    for (const style of ["md", "html"] as const) {
      const s = renderInline(inline, style, full, ctx);
      if (s === null) return null;
      const src = ctx === "cell" ? s.replace(/\\\|/g, "|") : s;
      if (sameStructure(parseInline(src, NOOP_SINK), inline)) return s;
    }
  }
  return null;
}

/** Netralkan awal baris yang akan dibaca sebagai struktur blok/kepala oleh lexer atau generator. */
function guardLineStart(s: string): string {
  let out = s;
  if (/^[#>+=|-]/.test(out) || HR_LINE_RE.test(out)) out = `\\${out}`;
  else {
    const m = /^(\d{1,9})([.)])/.exec(out);
    if (m) out = `${m[1]}\\${m[2]}${out.slice(m[0].length)}`;
  }
  // Baris `Kunci: nilai` di 40 baris pertama dibaca generator sebagai medan record.
  if (keyValueOf(out) !== null) {
    const k = out.indexOf(":");
    out = `${out.slice(0, k)}\\${out.slice(k)}`;
  }
  // Paragraf `Tabel ...:` / `Sumber: ...` di dekat tabel/gambar dibaca importer sebagai caption/sumber.
  if (CAPTIONISH_RE.test(out)) out = out.replace(/(?<!\\)([.:])/g, "\\$1");
  return out;
}

/** Awal judul `##` yang dibuang sebagai nomor tampilan (`1.`, `A)`, `3.1`) di-escape. */
function guardHeading(s: string): string {
  if (!DISPLAY_NUM_RE.test(s) && !SECTION_NUM_LEAD_RE.test(s)) return s;
  const sp = s.search(/\s/);
  return s.slice(0, sp).replace(/(?<!\\)([.)\]])/g, "\\$1") + s.slice(sp);
}

function railPrefix(rail: unknown, ctx: MdSerializeCtx): string | null {
  if (rail === undefined) return "";
  if (!Array.isArray(rail)) return fail(ctx, "rel bukan larik");
  const parts: string[] = [];
  for (const r of rail) {
    if (!isPlain(r) || r.runs !== undefined) return fail(ctx, "rel berformat (runs)");
    const text = typeof r.text === "string" ? r.text : undefined;
    if (text !== undefined && (text === "" || /[\]\n]/.test(text) || text.trim() !== text || /\s{2}/.test(text))) return fail(ctx, "teks rel memuat ] atau spasi tepi");
    if (r.kind === "mark" && typeof r.mark === "string" && (PROVENANCE_MARKS as readonly string[]).includes(r.mark)) parts.push(text !== undefined ? `[${r.mark}: ${text}]` : `[${r.mark}]`);
    else if (r.kind === "source" && text !== undefined) parts.push(`[SUMBER: ${text}]`);
    else if (r.kind === "note" && text !== undefined) parts.push(`[CATATAN: ${text}]`);
    else return fail(ctx, `rel ${String(r.kind)} tidak dikenal`);
  }
  return parts.join(" ");
}

/** Baris teks (paragraf/butir/kutipan) = rel + inline; awal baris dinetralkan bila tanpa rel. */
function proseLine(b: Record<string, unknown>, ctx: MdSerializeCtx): string | null {
  const rail = railPrefix(b.rail, ctx);
  if (rail === null) return null;
  const inline = inlinePart(b);
  if (inline === null) return fail(ctx, "inline bukan { text } atau { runs }");
  const empty = "text" in inline && inline.text === "";
  const text = empty ? "" : inlineToMarkdown(inline, "prose");
  if (text === null) return fail(ctx, "inline tidak dapat diwakili Markdown (mis. tab)");
  if (rail === "") return text === "" ? fail(ctx, "paragraf kosong") : guardLineStart(text);
  return text === "" ? rail : `${rail} ${text}`;
}

const ASIDE_KEYS: Readonly<Record<string, string>> = { doctrine: "DOCTRINE", story: "STORY", quickCheck: "QUICKCHECK", ifInDoubt: "IFINDOUBT", generic: "GENERIC" };
const ROLE_SET: ReadonlySet<string> = new Set<string>(PARAGRAPH_ROLES_V2);

function blockLines(b: unknown, listMarker: { unordered: string; ordered: string }, ctx: MdSerializeCtx): string[] | null {
  if (!isPlain(b)) return fail(ctx, "blok bukan objek");
  switch (b.type) {
    case "paragraph": {
      if (b.role === "subheading") {
        if (b.rail !== undefined) return fail(ctx, "subjudul ber-rel");
        const t = inlineToMarkdown(b, "heading");
        return t === null || t === "" ? fail(ctx, "subjudul tidak dapat diwakili") : [`### ${t}`];
      }
      const line = proseLine(b, ctx);
      if (line === null) return null;
      if (b.role === undefined) return [line];
      if (typeof b.role !== "string" || !ROLE_SET.has(b.role)) return fail(ctx, `peran paragraf ${String(b.role)} tidak dikenal`);
      return [`<!-- role: ${b.role} -->`, line];
    }
    case "list": {
      if (!Array.isArray(b.items) || b.items.length === 0) return fail(ctx, "daftar kosong");
      const ordered = b.ordered === true;
      if (b.ordered !== undefined && b.ordered !== true) return fail(ctx, "daftar ordered:false eksplisit");
      const out: string[] = [];
      for (let i = 0; i < b.items.length; i++) {
        const it = b.items[i];
        if (!isPlain(it)) return fail(ctx, "butir daftar bukan objek");
        const line = proseLine(it, ctx);
        if (line === null) return null;
        out.push(`${ordered ? `${i + 1}${listMarker.ordered}` : listMarker.unordered} ${line}`);
      }
      return out;
    }
    case "table":
      return tableLines(b, ctx);
    case "monoBlock":
      return codeLines(b, ctx);
    case "aside": {
      const key = typeof b.variant === "string" ? ASIDE_KEYS[b.variant] : undefined;
      if (key === undefined) return fail(ctx, `varian kutipan ${String(b.variant)} tidak dikenal`);
      if (!Array.isArray(b.body) || b.body.length === 0) return fail(ctx, "kutipan tanpa isi");
      const out: string[] = [];
      if (b.label !== undefined || b.variant !== "generic") {
        const label = b.label === undefined ? "" : inlineToMarkdown(b.label, "prose");
        if (label === null || (b.label !== undefined && label === "")) return fail(ctx, "label kutipan tidak dapat diwakili");
        out.push(`> [!${key}]${label !== "" ? ` ${label}` : ""}`);
      }
      const paras: string[] = [];
      for (const p of b.body) {
        const t = inlineToMarkdown(p, "prose");
        if (t === null || t === "") return fail(ctx, "paragraf kutipan tidak dapat diwakili");
        paras.push(`> ${guardLineStart(t)}`);
      }
      return [...out, ...paras.flatMap((p, i) => (i === 0 ? [p] : [">", p]))];
    }
    case "image": {
      const asset = typeof b.asset === "string" ? b.asset : "";
      if (!/^sha256:[0-9a-f]{64}$/.test(asset) && !ASSET_KEY_RE.test(asset)) return fail(ctx, "aset gambar bukan sha256:<hex> atau kunci aset");
      const alt = inlineToMarkdown(b.caption, "alt");
      if (alt === null || alt === "" || alt.includes("]")) return fail(ctx, "caption gambar tidak dapat diwakili");
      const src = sourceLine(b.source, ctx);
      if (src === null) return null;
      return [`![${guardLineStart(alt)}](${asset})`, "", src];
    }
    default:
      return fail(ctx, `blok ${String(b.type)} tidak dapat ditulis lewat Markdown laporan`);
  }
}

/** `Sumber: teks [TANDA]` (sumber tabel/gambar). */
function sourceLine(source: unknown, ctx: MdSerializeCtx): string | null {
  if (!isPlain(source)) return fail(ctx, "sumber tidak ada");
  const t = inlineToMarkdown(source, "prose");
  if (t === null || t === "") return fail(ctx, "sumber tidak dapat diwakili");
  const marks = source.provenance;
  if (marks !== undefined && (!Array.isArray(marks) || marks.some((m) => typeof m !== "string" || !(PROVENANCE_MARKS as readonly string[]).includes(m)))) return fail(ctx, "provenans sumber tidak sah");
  const tail = Array.isArray(marks) && marks.length > 0 ? ` ${marks.map((m) => `[${String(m)}]`).join(" ")}` : "";
  return `Sumber: ${t}${tail}`;
}

function tableLines(b: Record<string, unknown>, ctx: MdSerializeCtx): string[] | null {
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (rows.length === 0 || !isPlain(rows[0]) || rows[0].kind !== "header") return fail(ctx, "tabel tanpa baris kepala tunggal di awal");
  const ncol = Array.isArray(rows[0].cells) ? rows[0].cells.length : 0;
  if (ncol === 0) return fail(ctx, "tabel tanpa kolom");
  const lines: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!isPlain(row) || !Array.isArray(row.cells) || row.cells.length !== ncol || (r > 0 && row.kind !== "body")) return fail(ctx, "baris tabel tidak seragam");
    const cells: string[] = [];
    for (const c of row.cells) {
      if (isPlain(c) && Object.keys(c).filter((k) => k !== "id").length === 0) {
        cells.push("");
        continue;
      }
      const t = inlineToMarkdown(c, "cell");
      if (t === null || t === "") return fail(ctx, "sel tabel tidak dapat diwakili");
      cells.push(t);
    }
    lines.push(`| ${cells.join(" | ")} |`);
    if (r === 0) lines.push(`|${" --- |".repeat(ncol)}`);
  }
  if (b.caption !== undefined) {
    const cap = inlineToMarkdown(b.caption, "prose");
    if (cap === null || cap === "") return fail(ctx, "caption tabel tidak dapat diwakili");
    lines.push("", `Tabel: ${cap}`);
  }
  if (b.source !== undefined) {
    const src = sourceLine(b.source, ctx);
    if (src === null) return null;
    lines.push("", src);
  }
  return lines;
}

function codeLines(b: Record<string, unknown>, ctx: MdSerializeCtx): string[] | null {
  const label = plainTextOf(b.label);
  if (inlinePart(b.label) === null || label === "" || label !== label.trim() || /\s{2}|\n/.test(label)) return fail(ctx, "label blok kode tidak dapat diwakili");
  if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.some((l) => inlinePart(l) === null)) return fail(ctx, "baris blok kode tidak sah");
  const lines = b.lines.map(plainTextOf);
  if (lines.some((l) => l.includes("\n")) || lines[lines.length - 1].trim() === "") return fail(ctx, "baris blok kode tidak dapat diwakili");
  const ch = label.includes("`") ? "~" : "`";
  const lead = new RegExp(`^ {0,3}(\\${ch}+)`);
  const n = Math.max(3, ...lines.map((l) => (lead.exec(l)?.[1].length ?? 0) + 1));
  const fence = ch.repeat(n);
  return [`${fence}${/\s/.test(label) ? `text ${label}` : label}`, ...lines, fence];
}

/** Blok -> baris Markdown dipisah baris kosong; daftar bersebelahan sejenis diberi penanda bergantian. */
function blocksLines(blocks: unknown, ctx: MdSerializeCtx): string[] | null {
  if (blocks === undefined) return [];
  if (!Array.isArray(blocks)) return fail(ctx, "blok bukan larik");
  const out: string[] = [];
  let prev: Record<string, unknown> | null = null;
  const marker = { unordered: "-", ordered: "." };
  for (const b of blocks) {
    if (isPlain(b) && b.type === "list" && prev?.type === "list" && (prev.ordered === true) === (b.ordered === true)) {
      if (b.ordered === true) marker.ordered = marker.ordered === "." ? ")" : ".";
      else marker.unordered = marker.unordered === "-" ? "*" : "-";
    }
    const lines = blockLines(b, marker, ctx);
    if (lines === null) return null;
    if (out.length > 0) out.push("");
    out.push(...lines);
    prev = isPlain(b) ? b : null;
  }
  return out;
}

/** Bagian laporan MD: kepala (record), pembuka bab 1, badan bab, ekor (Rujukan). */
export interface ReportPartMarkdown {
  header: string[];
  intro: string[];
  body: string[];
  tail: string[];
}

const EMPTY_PART = (): ReportPartMarkdown => ({ header: [], intro: [], body: [], tail: [] });

/**
 * Bab (proyeksi R20 atau kiriman) -> bagian laporan MD lossless: setiap section = `## judul` + blok;
 * `intro` hanya untuk bab 1 (ditaruh sebelum `##` pertama). Bab tambahan = tepat satu section.
 * null + `ctx.why` bila ada bentuk yang tidak dapat diwakili.
 */
export function chapterToReportMarkdown(chapter: unknown, ctx: MdSerializeCtx): ReportPartMarkdown | null {
  if (!isPlain(chapter) || typeof chapter.key !== "string") return fail(ctx, "bab tanpa kunci");
  const intro = blocksLines(chapter.intro, ctx);
  if (intro === null) return null;
  if (intro.length > 0 && chapter.key !== "1") return fail(ctx, `bab ${chapter.key} memuat pembuka (intro) di luar bab 1`);
  const sections = Array.isArray(chapter.sections) ? chapter.sections : [];
  if (!ctx.outlineKeys.has(chapter.key) && sections.length !== 1) return fail(ctx, `bab tambahan ${chapter.key} memuat ${sections.length} section`);
  const body: string[] = [];
  for (const s of sections) {
    if (!isPlain(s)) return fail(ctx, "section bukan objek");
    const title = inlineToMarkdown(s.title, "heading");
    if (title === null || title === "") return fail(ctx, "judul section tidak dapat diwakili");
    const blocks = blocksLines(s.blocks, ctx);
    if (blocks === null) return null;
    body.push(`## ${guardHeading(title)}`, ...(blocks.length > 0 ? ["", ...blocks] : []), "");
  }
  return { ...EMPTY_PART(), intro, body };
}

/** Medan record yang dapat ditulis lewat laporan MD (kepala + tabel butir di bab + bagian Rujukan). */
export const MD_WRITABLE_RECORD_FIELDS: ReadonlySet<string> = new Set(["type", "status", "verdict", "owner", "initiator", "taskRef", "reportedAt", "cardIds", "items", "evidence", "refs"]);
const RECORD_HEADER_KEYS: ReadonlyArray<[string, string]> = [
  ["status", "Status"],
  ["verdict", "Verdict"],
  ["owner", "Owner"],
  ["initiator", "Initiator"],
  ["taskRef", "TaskRef"],
  ["reportedAt", "ReportedAt"],
];

/**
 * Payload record -> baris kepala `Kunci: nilai` (+ `CardIds:` utuh, urutan tersimpan) dan bagian
 * `## Rujukan` (tabel). Butir kerja/bukti TIDAK ditulis di sini: keduanya berasal dari tabel butir di
 * bab (tabel tetap di teks bab), jadi pemanggil memverifikasi kecocokannya lewat konversi ulang.
 */
export function recordToReportMarkdown(payload: unknown, ctx: MdSerializeCtx): ReportPartMarkdown | null {
  if (!isPlain(payload) || payload.type !== "contractRecord") return fail(ctx, "record bukan contractRecord");
  const extra = Object.keys(payload).filter((k) => payload[k] !== undefined && !MD_WRITABLE_RECORD_FIELDS.has(k));
  if (extra.length > 0) return fail(ctx, `record memuat ${extra.join(", ")} yang tidak dapat ditulis lewat MD (hanya draf json)`);
  const header: string[] = [];
  for (const [k, label] of RECORD_HEADER_KEYS) {
    const v = payload[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || v === "" || /\n/.test(v)) return fail(ctx, `record.${k} bukan teks satu baris`);
    header.push(`${label}: ${v}`);
  }
  if (payload.cardIds !== undefined) {
    if (!Array.isArray(payload.cardIds) || payload.cardIds.some((c) => typeof c !== "string" || !CARD_ID_RE.test(c))) return fail(ctx, "record.cardIds tidak sah");
    if (payload.cardIds.length > 0) header.push(`CardIds: ${payload.cardIds.join(", ")}`);
  }
  const tail: string[] = [];
  if (payload.refs !== undefined) {
    if (!Array.isArray(payload.refs)) return fail(ctx, "record.refs bukan larik");
    if (payload.refs.length > 0) {
      tail.push("## Rujukan", "", "| hubungan | dokumen | paragraf | revisi |", "| --- | --- | --- | --- |");
      for (const r of payload.refs) {
        if (!isPlain(r) || typeof r.documentId !== "string" || !DOCUMENT_ID_RE.test(r.documentId) || typeof r.rel !== "string") return fail(ctx, "rujukan tanpa documentId (docNumber tidak dapat ditulis lewat MD)");
        const extraRef = Object.keys(r).filter((k) => r[k] !== undefined && !["documentId", "pid", "revisionNo", "rel"].includes(k));
        if (extraRef.length > 0) return fail(ctx, `rujukan memuat ${extraRef.join(", ")}`);
        tail.push(`| ${r.rel} | ${r.documentId} | ${typeof r.pid === "string" ? r.pid : ""} | ${typeof r.revisionNo === "number" ? String(r.revisionNo) : ""} |`);
      }
      tail.push("");
    }
  }
  return { ...EMPTY_PART(), header, tail };
}

/** Slot `references` (sourceRegister) -> `## Referensi` + satu butir per entri (id R1..Rn berurutan). */
export function referencesToReportMarkdown(payload: unknown, ctx: MdSerializeCtx): ReportPartMarkdown | null {
  if (!isPlain(payload) || payload.type !== "sourceRegister" || !Array.isArray(payload.entries)) return fail(ctx, "references bukan sourceRegister");
  const body = ["## Referensi", ""];
  for (let i = 0; i < payload.entries.length; i++) {
    const e = payload.entries[i];
    if (!isPlain(e) || e.id !== `R${i + 1}`) return fail(ctx, "id referensi tidak berurutan R1..Rn");
    const extraKeys = Object.keys(e).filter((k) => e[k] !== undefined && !["id", "citation", "url"].includes(k));
    if (extraKeys.length > 0) return fail(ctx, `referensi memuat ${extraKeys.join(", ")}`);
    const t = inlineToMarkdown(e.citation, "citation");
    if (t === null || t === "") return fail(ctx, "sitasi referensi tidak dapat diwakili");
    const url = URL_IN_TEXT_RE.exec(t)?.[0].replace(/[.,;:]+$/, "");
    if ((e.url ?? undefined) !== (url !== undefined && url.length <= 2000 ? url : undefined)) return fail(ctx, "url referensi tidak tertulis di teks sitasi");
    body.push(`- ${t}`);
  }
  body.push("");
  return { ...EMPTY_PART(), body };
}

/** Satu bagian rakitan: satu versi, atau konflik dua versi (null = bagian tidak ada di sisi itu). */
export type AssemblePart =
  | { part: string; one: ReportPartMarkdown }
  | { part: string; conflict: { mine: ReportPartMarkdown | null; server: ReportPartMarkdown | null; mineLabel: string; serverLabel: string } };

export interface AssembleInput {
  title: string;
  /** Baris kunci alat (mission/docKey/agentId/basis) apa adanya. */
  toolLines: string[];
  /** Urut: record, bab (kunci), references. */
  parts: AssemblePart[];
}

/**
 * Rakit laporan MD dari bagian. `pick`: `markers` = konflik ditulis dengan penanda
 * `<<<<<<< ... ======= ... >>>>>>>` per wilayah yang berbeda (laporan ditolak konversi sampai
 * diselesaikan); `mine`/`server` = konflik diselesaikan ke satu sisi (untuk verifikasi).
 */
export function assembleReportMarkdown(input: AssembleInput, pick: "markers" | "mine" | "server" = "markers"): string {
  const regions: Record<keyof ReportPartMarkdown, string[]> = { header: [], intro: [], body: [], tail: [] };
  for (const p of input.parts) {
    for (const r of ["header", "intro", "body", "tail"] as const) {
      if ("one" in p) {
        regions[r].push(...p.one[r]);
        continue;
      }
      const mine = p.conflict.mine?.[r] ?? [];
      const server = p.conflict.server?.[r] ?? [];
      if (pick === "mine") regions[r].push(...mine);
      else if (pick === "server") regions[r].push(...server);
      else if (mine.join("\n") === server.join("\n")) regions[r].push(...mine);
      else regions[r].push(`<<<<<<< ${p.conflict.mineLabel}`, ...mine, "=======", ...server, `>>>>>>> ${p.conflict.serverLabel}`, ...(r === "header" ? [] : [""]));
    }
  }
  const out = [`# ${input.title.replace(/\s+/g, " ").trim()}`, "", ...input.toolLines, ...regions.header, ""];
  if (regions.intro.length > 0) out.push(...regions.intro, "");
  out.push(...regions.body, ...regions.tail);
  // Rapikan baris kosong beruntun (di luar pagar kode) dan akhiri dengan satu LF.
  const mask = fenceMask(out);
  const tidy = out.filter((l, i) => !(l === "" && !mask[i] && i > 0 && out[i - 1] === "" && !mask[i - 1]));
  while (tidy.length > 0 && tidy[tidy.length - 1] === "") tidy.pop();
  return `${tidy.join("\n")}\n`;
}

// ── `refresh` mempertahankan baris `~~hapus~~` (R3-F3, review 15c R2) ─────

/** Kunci rujukan untuk mencocokkan baris `~~hapus~~` dengan rujukan server: `<rel>|<documentId>`. */
export const refRemovalKey = (rel: string, documentId: string): string => `${rel}|${documentId}`;

/** Sisi tiap baris terhadap penanda konflik refresh: di luar, sisi ANDA, atau sisi SERVER. */
function conflictSides(lines: readonly string[], mask: readonly boolean[]): Array<"none" | "mine" | "server"> {
  let side: "none" | "mine" | "server" = "none";
  return lines.map((l, i) => {
    if (mask[i]) return side;
    if (l.startsWith("<<<<<<< ")) side = "mine";
    else if (l === "=======" && side === "mine") side = "server";
    else if (l.startsWith(">>>>>>> ")) {
      side = "none";
      return "server";
    }
    return side;
  });
}

const tableCols = (header: readonly string[]): string[] => header.map((c) => cleanValue(c).replace(/[*_`]/g, "").trim().toLowerCase());

/** Judul `##` terdekat di atas baris `i` (dinormalkan), di luar pagar kode. */
function headingAbove(lines: readonly string[], mask: readonly boolean[], i: number): string | null {
  for (let k = i; k >= 0; k--) {
    if (mask[k]) continue;
    const h = atxHeading(lines[k]);
    if (h && h.level === 2) return normalizeHeading(h.text);
  }
  return null;
}

/**
 * `refresh` menulis laporan gabungan dari payload, sedangkan baris `~~hapus~~` dibuang sebelum konversi;
 * tanpa langkah ini niat hapus eksplisit hilang (update berikutnya ditolak RECORD_ELEMENTS_DROPPED).
 * Baris `~~hapus~~` laporan asli ditulis kembali ke tabel butir / tabel Rujukan laporan gabungan, hanya
 * untuk butir/rujukan yang masih ada di server (`alive`); di wilayah konflik hanya di sisi ANDA. Baris
 * itu dibuang lagi sebelum konversi, jadi isi bagian hasil verifikasi tidak berubah.
 */
export function keepRemovalRows(merged: string, original: string, alive: { items: ReadonlySet<string>; refs: ReadonlySet<string> }): { markdown: string; notices: string[] } {
  const notices: string[] = [];
  const src = normalizeSource(original).split("\n");
  const srcMask = fenceMask(src);
  const itemRows: Array<{ key: string; line: string }> = [];
  const refRows: Array<{ key: string; rel: string; documentId: string }> = [];
  for (const t of findTables(src, srcMask)) {
    const cols = tableCols(t.header);
    const keyIdx = cols.findIndex((c) => ITEM_KEY_HEADERS.includes(c));
    const isItems = keyIdx >= 0 && cols.includes("status");
    const refCols = cols.map((c) => REF_COLUMNS[c] ?? null);
    const isRefs = !isItems && MD_REPORT_REFS_HEADINGS.includes(headingAbove(src, srcMask, t.line - 1) ?? "") && refCols.includes("rel") && refCols.includes("documentId");
    for (const r of t.rows) {
      if (!r.cells.some((c) => REMOVE_MARK_RE.test(c))) continue;
      if (isItems) {
        const key = cleanValue(r.cells[keyIdx] ?? "");
        if (alive.items.has(key)) itemRows.push({ key, line: src[r.line - 1] });
      } else if (isRefs) {
        const cell = (f: "rel" | "documentId") => cleanValue(r.cells[refCols.indexOf(f)] ?? "");
        const relRaw = cell("rel").toLowerCase();
        const rel = REF_REL_ALIASES[relRaw] ?? relRaw;
        const documentId = cell("documentId");
        if (alive.refs.has(refRemovalKey(rel, documentId))) refRows.push({ key: refRemovalKey(rel, documentId), rel, documentId });
      }
    }
  }
  if (itemRows.length === 0 && refRows.length === 0) return { markdown: merged, notices };

  const lines = merged.replace(/\n$/, "").split("\n");
  const mask = fenceMask(lines);
  const sides = conflictSides(lines, mask);
  const tables = findTables(lines, mask).filter((t) => sides[t.line - 1] !== "server");
  const inserts = new Map<number, string[]>(); // indeks baris terakhir tabel -> baris yang disisipkan sesudahnya
  const add = (at: number, rows: string[]) => inserts.set(at, [...(inserts.get(at) ?? []), ...rows]);

  if (itemRows.length > 0) {
    const t = tables.find((x) => {
      const cols = tableCols(x.header);
      return cols.some((c) => ITEM_KEY_HEADERS.includes(c)) && cols.includes("status");
    });
    if (t === undefined) {
      notices.push(`baris ~~hapus~~ butir ${itemRows.map((r) => r.key).join(", ")} tidak dapat ditulis ulang (tabel butir tidak ada di laporan gabungan); tulis ulang sendiri bila tetap ingin menghapus`);
    } else {
      const keyIdx = tableCols(t.header).findIndex((c) => ITEM_KEY_HEADERS.includes(c));
      const present = new Set(t.rows.map((r) => cleanValue(r.cells[keyIdx] ?? "")));
      const dup = itemRows.filter((r) => present.has(r.key));
      if (dup.length > 0) notices.push(`baris ~~hapus~~ butir ${dup.map((r) => r.key).join(", ")} tidak ditulis ulang: butir itu tercantum di tabel butir laporan gabungan; tandai ulang ~~hapus~~ bila tetap ingin menghapus`);
      const rows = itemRows.filter((r) => !present.has(r.key)).map((r) => r.line);
      if (rows.length > 0) add(t.rows.length > 0 ? t.rows[t.rows.length - 1].line - 1 : t.line, rows);
    }
  }
  const tail: string[] = [];
  if (refRows.length > 0) {
    const rows = refRows.map((r) => `| ${r.rel} | ${r.documentId} | ~~hapus~~ |  |`);
    const t = tables.find((x) => {
      const cols = tableCols(x.header).map((c) => REF_COLUMNS[c] ?? null);
      return MD_REPORT_REFS_HEADINGS.includes(headingAbove(lines, mask, x.line - 1) ?? "") && cols[0] === "rel" && cols[1] === "documentId";
    });
    if (t !== undefined) add(t.rows.length > 0 ? t.rows[t.rows.length - 1].line - 1 : t.line, rows);
    else tail.push("", "## Rujukan", "", "| hubungan | dokumen | paragraf | revisi |", "| --- | --- | --- | --- |", ...rows);
  }
  const out: string[] = [];
  lines.forEach((l, i) => {
    out.push(l);
    out.push(...(inserts.get(i) ?? []));
  });
  out.push(...tail);
  return { markdown: `${out.join("\n")}\n`, notices };
}

// ── Isi -> Markdown untuk dibaca (pesan konflik/penyegaran) ──────────────

/** Bab -> Markdown lossless untuk DIBACA (bukan disalin manual; pakai `refresh`). */
export function chapterToMarkdown(chapter: unknown): string[] {
  const ctx = newSerializeCtx();
  const md = chapterToReportMarkdown(chapter, ctx);
  if (md === null) return [`(bab ini memuat bentuk yang tidak dapat ditulis lewat Markdown laporan: ${ctx.why ?? "tidak diketahui"}; lihat GET /api/studio/documents/{id}/content)`];
  const lines = [...md.intro, ...(md.intro.length > 0 ? [""] : []), ...md.body];
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Payload record -> baris kepala + bagian Rujukan untuk DIBACA (butir kerja ada di tabel bab). */
export function recordToMarkdown(payload: unknown): string[] {
  const ctx = newSerializeCtx();
  const md = recordToReportMarkdown(payload, ctx);
  if (md === null) return [`(record memuat bentuk yang tidak dapat ditulis lewat Markdown laporan: ${ctx.why ?? "tidak diketahui"})`];
  const items = isPlain(payload) && Array.isArray(payload.items) ? payload.items.filter(isPlain) : [];
  return [
    ...md.header,
    ...(items.length > 0 ? [`(butir kerja: ${items.map((it) => `${String(it.key)} ${String(it.status)}`).join(", ")} — ditulis di tabel butir bab)`] : []),
    ...(md.tail.length > 0 ? ["", ...md.tail] : []),
  ];
}

/** Petunjuk templat: teks polos blok contoh (paragraf/daftar). */
function hintLines(b: Record<string, unknown>): string[] {
  if (b.type === "list" && Array.isArray(b.items)) return b.items.map((it, i) => `${b.ordered === true ? `${i + 1}.` : "-"} ${plainTextOf(it)}`);
  if (b.type === "paragraph") return [plainTextOf(b)];
  return typeof b.type === "string" ? [`[blok ${b.type}]`] : [];
}

// ── Templat (U-18; placeholder R3-F #2) ─────────────────────────────────

export interface ReportTemplateOptions {
  kind?: ContractKind;
  format: "md" | "json";
  /** Tanpa nilai: target contoh registri dipakai (ditolak EXAMPLE_TARGET saat dikirim apa adanya). */
  mission?: string | null;
  docKey?: string | null;
}

/** Petunjuk isi per bab outline: contoh pertama registri dipendekkan (petunjuk, bukan isi). */
function chapterHint(ex: unknown): string {
  const ch = ex as { chapter?: { sections?: Array<{ blocks?: Array<Record<string, unknown>> }> } } | undefined;
  const first = ch?.chapter?.sections?.[0]?.blocks?.[0];
  const text = first ? hintLines(first).join(" ").replace(/\s+/g, " ").trim() : "";
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

/** Ganti nilai teks contoh dengan placeholder (medan bentuk `type`/`kind`/`role` dipertahankan). */
function placeholderize(v: unknown, path: string[] = []): unknown {
  if (Array.isArray(v)) return v.map((x) => placeholderize(x, path));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, placeholderize(x, [...path, k])]));
  if (typeof v === "string" && path[path.length - 1] === "text") return placeholder(`contoh: ${v.slice(0, 60)}`);
  return v;
}

/**
 * U-18 — templat laporan kerja siap diisi dari registri (outline/alias + petunjuk dari `examples`),
 * tanpa ID nyata. R3-F #2 (D-439): setiap medan dan isi bab berupa placeholder `<isi: ...>`; laporan
 * yang masih memuatnya ditolak `TEMPLATE_PLACEHOLDER` (dan status/ReportedAt placeholder tidak punya
 * alias, KD-42), sehingga templat yang tidak disunting tidak pernah tersimpan.
 */
export function reportTemplate(opts: ReportTemplateOptions): string {
  const def = defOf(opts.kind ?? MD_REPORT_DEFAULT_KIND);
  const ex = def.examples;
  const rec = ex.record as unknown as { target: { mission: { folder: string }; docKey: string }; meta: { title: string }; payload: Record<string, unknown> };
  const mission = opts.mission ?? rec.target.mission.folder;
  const docKey = opts.docKey ?? rec.target.docKey;
  const target = { mission: { folder: mission }, docKey };
  const statuses = def.statuses.map((s) => s.code).join(" atau ");
  const itemStatuses = [...new Set(Object.values(def.aliases.itemStatuses))].join(" atau ");
  const title = placeholder("judul laporan");

  if (opts.format === "json") {
    const payload = {
      type: "contractRecord",
      status: placeholder(statuses),
      owner: placeholder("id agen penanggung jawab"),
      taskRef: placeholder("rujukan tugas, mis. R3-01"),
      reportedAt: placeholder("YYYY-MM-DD atau YYYY-MM-DDTHH:MM+07:00"),
      items: [{ key: placeholder("t_xxxxxxxx atau KUNCI-1"), title: { text: placeholder("judul butir") }, status: placeholder(itemStatuses) }],
    };
    const record = { ...(ex.record as unknown as Record<string, unknown>), target, meta: { title }, payload };
    const chapters = def.outline
      .map((o) => ex.chapters[o.chapterKey] as unknown as Record<string, unknown> | undefined)
      .filter((c): c is Record<string, unknown> => c !== undefined)
      .map((c) => ({ ...c, target, chapter: placeholderize(c.chapter) }));
    return blocksToDraftMarkdown(title, [record, ...chapters], { tujuan: "laporan kerja (draf ber-blok json)" });
  }

  const out: string[] = [
    `# ${title}`,
    "",
    `mission: ${mission}`,
    `docKey: ${docKey}`,
    `Status: ${placeholder(statuses)}`,
    `Owner: ${placeholder("id agen penanggung jawab, huruf kecil")}`,
    `Initiator: ${placeholder("id agen pemberi tugas; hapus baris bila tidak ada")}`,
    `TaskRef: ${placeholder("rujukan tugas, mis. R3-01; hapus baris bila tidak ada")}`,
    `ReportedAt: ${placeholder("YYYY-MM-DD atau YYYY-MM-DDTHH:MM+07:00")}`,
  ];
  for (const o of def.outline) {
    out.push("", `## ${o.title}`, "");
    if (o.chapterKey === "2") {
      out.push(
        "| key | judul | status | owner | bukti |",
        "|---|---|---|---|---|",
        `| ${placeholder("t_xxxxxxxx atau KUNCI-1")} | ${placeholder("judul butir")} | ${placeholder(`status butir: ${itemStatuses}`)} | ${placeholder("id agen")} | ${placeholder("path berkas, ukuran B, sha")} |`,
        "",
      );
    }
    const hint = chapterHint(ex.chapters[o.chapterKey]);
    out.push(placeholder(`${o.title}${hint !== "" ? `; contoh: ${hint}` : ""}`));
  }
  out.push(
    "",
    "## Rujukan",
    "",
    "| hubungan | dokumen | paragraf | revisi |",
    "|---|---|---|---|",
    `| ${placeholder(CONTRACT_REF_RELS.join(" atau "))} | ${placeholder("documentId dokumen yang dirujuk")} | ${placeholder("pid; boleh kosong")} | ${placeholder("revisi; boleh kosong")} |`,
    "",
    placeholder("hapus seluruh bagian Rujukan bila laporan tidak merujuk dokumen lain"),
  );
  return `${out.join("\n")}\n`;
}
