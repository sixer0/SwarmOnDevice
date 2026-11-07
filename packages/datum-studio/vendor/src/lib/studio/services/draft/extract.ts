/**
 * Ekstraktor draf/checkpoint MD (DC-21, I63; register 05 §11.1-§11.4). Murni: tanpa I/O,
 * tanpa DB, tanpa validasi skema v2 (ajv/dry-run R08 milik DC-22/DC-23).
 *
 * Aturan pagar (KD-44): blok = baris tepat "```json" (spasi/tab akhir boleh) di kolom 1, ditutup
 * baris "```" di kolom 1. Pagar lain (info apa pun, empat backtick atau lebih, tilde, berindentasi)
 * diabaikan beserta isinya sampai penutup CommonMark-nya. CRLF dinormalkan ke LF; nomor baris
 * 1-based terhadap berkas asli.
 */
import { DRAFT_ACCEPTED_SCHEMAS, DRAFT_BASIS_PATTERN, DRAFT_HEADER_KEYS, DRAFT_LIMITS } from "../../contract/env";
import type { DraftLimitReason } from "../../contract/enums";
import type { DraftCheckResultV2, DraftIssueV2 } from "../../contract/types/v2/contract";
import { atxHeading } from "../import/lexer";
import { jsonErrorOffset } from "./json-locate";

export type DraftHeader = DraftCheckResultV2["header"];

/** Blok `json` hasil I63 (sebelum dry-run R08). */
export interface ExtractedDraftBlock {
  /** 1-based. */
  index: number;
  /** Baris pagar pembuka (1-based). */
  line: number;
  /** Baris pagar penutup (1-based). */
  endLine: number;
  /** Isi blok persis seperti tertulis (akhir baris asli dipertahankan; tanpa pagar). */
  text: string;
  /** Nilai `JSON.parse`; `null` bila sintaks rusak. */
  value: unknown | null;
  /** `$schema` string yang terdeteksi (juga bila bukan anggota C57); `null` bila tidak ada. */
  schema: string | null;
}

export interface ExtractedDraft {
  header: DraftHeader;
  issues: DraftIssueV2[];
  blocks: ExtractedDraftBlock[];
}

const JSON_OPEN_RE = /^```json[ \t]*$/;
const JSON_CLOSE_RE = /^```[ \t]*$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADER_KEY_RE = /^([a-z][a-z-]*):(.*)$/;
const BASIS_RE = new RegExp(DRAFT_BASIS_PATTERN);
const ACCEPTED: ReadonlySet<string> = new Set(DRAFT_ACCEPTED_SCHEMAS);
const HEADER_FIELD: Record<(typeof DRAFT_HEADER_KEYS)[number], keyof DraftHeader> = {
  tujuan: "tujuan",
  "langkah-berikut": "langkahBerikut",
  basis: "basis",
};

interface SplitLines {
  /** Isi baris tanpa terminator. */
  lines: string[];
  /** Terminator asli tiap baris (`"\r\n"`, `"\n"`, atau `""` untuk baris terakhir). */
  ends: string[];
}

function splitLines(md: string): SplitLines {
  const lines: string[] = [];
  const ends: string[] = [];
  const re = /\r\n|\n/g;
  let last = 0;
  for (let m = re.exec(md); m !== null; m = re.exec(md)) {
    lines.push(md.slice(last, m.index));
    ends.push(m[0]);
    last = m.index + m[0].length;
  }
  lines.push(md.slice(last));
  ends.push("");
  return { lines, ends };
}

interface RawBlock {
  /** Indeks baris pembuka (0-based). */
  open: number;
  /** Indeks baris penutup (0-based); `-1` bila tanpa penutup sampai akhir berkas. */
  close: number;
}

interface FenceScan {
  blocks: RawBlock[];
  /** Indeks baris pagar pembuka pertama (jenis apa pun); `lines.length` bila tidak ada. */
  firstFence: number;
}

/** Pemindai pagar KD-44 (tanpa parse JSON); dipakai bersama oleh I63 dan pemeriksa batas. */
function scanFences(lines: string[]): FenceScan {
  const blocks: RawBlock[] = [];
  let firstFence = lines.length;
  let jsonOpen = -1;
  let other: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (jsonOpen >= 0) {
      if (JSON_CLOSE_RE.test(l)) {
        blocks.push({ open: jsonOpen, close: i });
        jsonOpen = -1;
      }
      continue;
    }
    if (other !== null) {
      const m = FENCE_RE.exec(l);
      if (m && m[2][0] === other.ch && m[2].length >= other.len && m[3].trim() === "") other = null;
      continue;
    }
    if (JSON_OPEN_RE.test(l)) {
      jsonOpen = i;
      if (firstFence === lines.length) firstFence = i;
      continue;
    }
    const m = FENCE_RE.exec(l);
    // CommonMark: info pagar backtick tidak boleh memuat backtick (selain itu kode inline, bukan pagar).
    if (m && !(m[2][0] === "`" && m[3].includes("`"))) {
      other = { ch: m[2][0], len: m[2].length };
      if (firstFence === lines.length) firstFence = i;
    }
  }
  if (jsonOpen >= 0) blocks.push({ open: jsonOpen, close: -1 });
  return { blocks, firstFence };
}

function parseHeader(lines: string[], end: number, issues: DraftIssueV2[]): DraftHeader {
  const header: DraftHeader = { title: null, tujuan: null, langkahBerikut: null, basis: null };
  let basisLine = 0;
  for (let i = 0; i < end; i++) {
    const l = i === 0 && lines[0].startsWith("\uFEFF") ? lines[0].slice(1) : lines[i];
    if (header.title === null && l.startsWith("# ")) {
      const h = atxHeading(l);
      if (h && h.level === 1 && h.text !== "") header.title = h.text;
      continue;
    }
    const m = HEADER_KEY_RE.exec(l);
    if (!m || !Object.prototype.hasOwnProperty.call(HEADER_FIELD, m[1])) continue;
    const field = HEADER_FIELD[m[1] as keyof typeof HEADER_FIELD];
    if (header[field] !== null) continue; // kemunculan pertama menang
    const value = m[2].trim();
    if (value === "") continue;
    header[field] = value;
    if (field === "basis") basisLine = i + 1;
  }
  const missing: string[] = [];
  if (header.title === null) missing.push("judul");
  for (const k of DRAFT_HEADER_KEYS) if (header[HEADER_FIELD[k]] === null) missing.push(k);
  if (missing.length > 0) {
    issues.push({
      code: "DRAFT_HEADER_INCOMPLETE",
      severity: "warning",
      message: `kepala draf tidak lengkap: ${missing.join(", ")} tidak ada`,
    });
  }
  if (header.basis !== null && !BASIS_RE.test(header.basis)) {
    issues.push({
      code: "DRAFT_BASIS_INVALID",
      severity: "warning",
      line: basisLine,
      column: 1,
      message: `basis "${header.basis}" bukan "<documentId>@rev<n>" atau "baru"`,
    });
  }
  return header;
}

/** Baris/kolom 1-based dari offset di isi blok yang dinormalkan LF; isi mulai di baris `firstLine`. */
function positionOf(norm: string, offset: number, firstLine: number): { line: number; column: number } {
  let line = firstLine;
  let lineStart = 0;
  for (let p = norm.indexOf("\n"); p !== -1 && p < offset; p = norm.indexOf("\n", p + 1)) {
    line++;
    lineStart = p + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

function firstContentPosition(norm: string, firstLine: number): { line: number; column: number } {
  let p = 0;
  while (p < norm.length && (norm[p] === " " || norm[p] === "\t" || norm[p] === "\n" || norm[p] === "\r")) p++;
  return positionOf(norm, p, firstLine);
}

/**
 * I63 — ekstraksi draf MD: kepala ringkas + blok `json` bernomor baris + isu DR-01..DR-07.
 * DR-08 (basis basi) butuh DB (R23/CLI `--remote`); DR-09/DR-10 lewat {@link checkDraftLimits}
 * yang dipanggil pemakai sebelum I63.
 */
export function extractDraft(markdown: string): ExtractedDraft {
  const { lines, ends } = splitLines(markdown);
  const scan = scanFences(lines);
  const issues: DraftIssueV2[] = [];
  const header = parseHeader(lines, scan.firstFence, issues);
  const blocks: ExtractedDraftBlock[] = [];

  for (const raw of scan.blocks) {
    if (raw.close < 0) {
      issues.push({
        code: "DRAFT_FENCE_UNCLOSED",
        severity: "error",
        line: raw.open + 1,
        column: 1,
        message: `pagar json di baris ${raw.open + 1} tidak ditutup sampai akhir berkas`,
      });
      continue;
    }
    const index = blocks.length + 1;
    const body = lines.slice(raw.open + 1, raw.close);
    const norm = body.join("\n");
    let text = "";
    for (let i = raw.open + 1; i < raw.close; i++) text += lines[i] + (i < raw.close - 1 ? ends[i] : "");
    const firstLine = raw.open + 2;
    const block: ExtractedDraftBlock = { index, line: raw.open + 1, endLine: raw.close + 1, text, value: null, schema: null };
    blocks.push(block);

    let value: unknown;
    try {
      value = JSON.parse(norm);
    } catch {
      const off = jsonErrorOffset(norm);
      const pos = positionOf(norm, off < 0 ? norm.length : off, firstLine);
      issues.push({
        code: "DRAFT_JSON_MALFORMED",
        severity: "error",
        line: pos.line,
        column: pos.column,
        blockIndex: index,
        message: `JSON blok ${index} rusak di baris ${pos.line} kolom ${pos.column}`,
      });
      continue;
    }
    block.value = value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      const pos = firstContentPosition(norm, firstLine);
      issues.push({
        code: "DRAFT_BLOCK_NOT_OBJECT",
        severity: "error",
        line: pos.line,
        column: pos.column,
        blockIndex: index,
        message: `blok ${index} harus satu objek JSON (ditemukan ${Array.isArray(value) ? "larik" : value === null ? "null" : typeof value})`,
      });
      continue;
    }
    const schema = (value as Record<string, unknown>)["$schema"];
    block.schema = typeof schema === "string" ? schema : null;
    if (block.schema === null || !ACCEPTED.has(block.schema)) {
      issues.push({
        code: "DRAFT_SCHEMA_UNKNOWN",
        severity: "error",
        line: block.line,
        column: 1,
        blockIndex: index,
        message:
          block.schema === null
            ? `blok ${index} tanpa "$schema"`
            : `blok ${index}: "$schema" "${block.schema}" bukan salah satu dari ${DRAFT_ACCEPTED_SCHEMAS.join(", ")}`,
      });
    }
  }

  if (scan.blocks.length === 0) {
    issues.push({ code: "DRAFT_NO_JSON_BLOCK", severity: "error", message: "tidak ada blok ```json di draf" });
  }
  return { header, issues, blocks };
}

/**
 * Batas C54 (DR-09/DR-10, alasan 413 E56). `bodyBytes` = ukuran badan permintaan bila ada (R23);
 * `markdown.length` dibandingkan dengan `maxChars`; jumlah pagar `json` (termasuk yang tidak
 * ditutup) dengan `maxBlocks`. `null` = dalam batas.
 */
export function checkDraftLimits(markdown: string, opts: { bodyBytes?: number } = {}): DraftLimitReason | null {
  if (opts.bodyBytes !== undefined && opts.bodyBytes > DRAFT_LIMITS.bodyBytes) return "DRAFT_TOO_LONG";
  if (markdown.length > DRAFT_LIMITS.maxChars) return "DRAFT_TOO_LONG";
  if (scanFences(splitLines(markdown).lines).blocks.length > DRAFT_LIMITS.maxBlocks) return "DRAFT_TOO_MANY_BLOCKS";
  return null;
}

/** `basis` C56 terurai; `null` bila tidak cocok pola. */
export function parseDraftBasis(
  basis: string,
): { kind: "baru" } | { kind: "revision"; documentId: string; revisionNo: number } | null {
  const m = BASIS_RE.exec(basis);
  if (!m) return null;
  if (m[1] === undefined) return { kind: "baru" };
  return { kind: "revision", documentId: m[1], revisionNo: Number(m[2]) };
}

/**
 * Hasil T2-70 lokal dari I63 (tanpa dry-run R08): blok `valid` bila tanpa isu error ber-`blockIndex`
 * miliknya; `payload` = nilai blok. DC-22/DC-23 menimpa `valid`/`issues`/pratinjau per blok
 * dengan hasil R08.
 */
export function toDraftCheckResult(ex: ExtractedDraft): DraftCheckResultV2 {
  const bad = new Set<number>();
  for (const i of ex.issues) if (i.severity === "error" && i.blockIndex !== undefined) bad.add(i.blockIndex);
  const blocks = ex.blocks.map((b) => ({
    index: b.index,
    line: b.line,
    endLine: b.endLine,
    schema: b.schema,
    valid: !bad.has(b.index),
    issues: [] as unknown[],
    payload: b.value,
  }));
  const valid = !ex.issues.some((i) => i.severity === "error") && blocks.every((b) => b.valid);
  return { valid, header: ex.header, issues: ex.issues, blocks };
}
