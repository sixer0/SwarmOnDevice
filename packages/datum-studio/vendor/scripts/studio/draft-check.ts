/**
 * CLI pemeriksa draf/checkpoint MD (DC-22, register 05 §11.3-§11.4).
 *
 *   npx tsx scripts/studio/draft-check.ts <berkas.md> [--remote <baseUrl>] [--agent-id <id>] [--emit <n>] [--json [--with-payload]]
 *
 * Dapat dijalankan dari cwd mana pun (U-05c): `npx tsx <repo>/scripts/studio/draft-check.ts ...`;
 * alias `@/*` diselesaikan relatif ke repo oleh `./_repo-alias` (diimpor pertama).
 *
 * Opsi:
 *   --remote <baseUrl>   setiap blok dikirim apa adanya ke R08 `POST /api/studio/validate` (dry-run,
 *                        tanpa tulis DB) dengan header `x-internal-secret` dari env `INTERNAL_API_SECRET`
 *                        (D-334); basis `<documentId>@rev<n>` dibandingkan dengan revisi terkini dokumen
 *                        (R05) -> peringatan DR-08 `DRAFT_BASIS_STALE`
 *   --agent-id <id>      agentId bawaan dry-run (1..80 karakter), setara medan badan R23 `agentId`; dipakai
 *                        untuk blok tanpa medan `agentId` (medan payload blok menang). Hanya bersama
 *                        --remote. Tanpa opsi ini dan tanpa `agentId` blok: tanpa agentId (sama dengan R23)
 *   --emit <n>           cetak teks blok ke-n (1-based) persis seperti tertulis (byte-identik), untuk
 *                        dikirim apa adanya
 *   --json               cetak hasil T2-70 `DraftCheckResultV2` (bentuk respons R23) TANPA medan
 *                        `blocks[].payload` (U-05d); `--with-payload` menyertakannya (= respons R23).
 *                        Dengan --json stdout SELALU JSON sah: galat fatal (kode keluar != 0 di luar
 *                        hasil pemeriksaan) dicetak `{ "fatal": { code, message, details? } }` (U-05b)
 *
 * Simulasi berurutan (U-05a, `services/draft/check.ts`): blok bab/slot sesudah blok buat-dokumen
 * bertarget `mission.folder` + `docKey` sama dianggap menarget dokumen yang akan dibuat (tanpa
 * `META_REQUIRED_FOR_CREATE`); aturan sama dengan R23.
 *
 * Lokal (bawaan): batas C54 (DR-09/DR-10) -> I63 `extractDraft` (DR-01..DR-07) -> skema v2 per blok
 * (validator yang sama dengan R08: `validateV2`, ajv bersama + `classifySchemaV2Errors`) -> pemeriksaan
 * murni §5.6 langkah 6b (I54 `checkContractRecord`: set jenis, pola, tanggal, `items[].key` unik
 * dengan posisi berbasis 1; D-375). Tanpa DB dan tanpa jaringan; DR-08 dan EC25/EC26 tidak diperiksa.
 *
 * Kode keluar: 0 semua blok valid dan tanpa isu error; 1 ada isu error, blok tidak valid, atau draf
 * melebihi batas C54; 2 galat pemakaian/berkas/jaringan.
 * Nilai rahasia tidak pernah dicetak maupun ditulis ke berkas.
 */
import "./_repo-alias";
import fs from "node:fs";
import type { DraftCheckResultV2 } from "../../src/lib/studio/contract";
import { STUDIO_ROUTES } from "../../src/lib/studio/contract/env";
import {
  checkDraftLimits,
  completeDraftCheck,
  draftContractIssues,
  draftLimitMessage,
  extractDraft,
  finalizeDraftResult,
  prepareDraftCheck,
  rejectedDryRun,
  sequentialCreateSources,
  toDraftCheckResult,
  type DraftDryRunOutcome,
} from "../../src/lib/studio/services/draft";
import { isV2SubmissionSchema, validateV2 } from "../../src/app/api/studio/validate/_shared/v2-kit";
import {
  httpFailureOf,
  normalizeBaseUrl as normalizeSharedBaseUrl,
  studioRequest,
  StudioUnreachableError,
  StudioUrlError,
  type HttpFetch,
  type HttpReply,
} from "./_http-client";

const USAGE = "pemakaian: npx tsx scripts/studio/draft-check.ts <berkas.md> [--remote <baseUrl>] [--agent-id <id>] [--emit <n>] [--json [--with-payload]]";

const HELP = [
  USAGE,
  "",
  "Memeriksa satu draf/checkpoint Markdown: kepala (judul, tujuan, langkah-berikut, basis) dan setiap",
  "blok ```json berisi kiriman studio.doc/v2, studio.chapter/v2, atau studio.slot/v2.",
  "",
  "  --remote <baseUrl>   periksa setiap blok di server lewat dry-run POST /api/studio/validate",
  "                       (tidak menyimpan apa pun); rahasia dibaca dari env INTERNAL_API_SECRET.",
  "                       Juga memeriksa apakah basis draf sudah tertinggal dari revisi terkini.",
  "  --agent-id <id>      agentId bawaan dry-run untuk blok tanpa medan agentId (hanya bersama --remote);",
  "                       sama dengan medan agentId badan POST /api/studio/drafts/check",
  "  --emit <n>           cetak isi blok ke-n persis seperti tertulis, mis. --emit 1 > blok1.json",
  "  --json               cetak hasil sebagai JSON (tanpa isi payload blok); galat fatal pun dicetak",
  "                       sebagai JSON { \"fatal\": { \"code\", \"message\" } }",
  "  --with-payload       bersama --json: sertakan blocks[].payload (bentuk persis respons R23)",
  "  -h, --help           tampilkan bantuan ini",
  "",
  "Tanpa --remote pemeriksaan berjalan lokal: tanpa server dan tanpa basis data.",
  "Blok bab/slot sesudah blok pembuat dokumen (misi + docKey sama) diperiksa sebagai bagian dokumen itu.",
  "Dapat dijalankan dari direktori mana pun: npx tsx <repo>/scripts/studio/draft-check.ts draf.md",
  "",
  "Kode keluar: 0 lolos, 1 ada isu galat atau blok tidak valid, 2 galat pemakaian, berkas, atau jaringan.",
].join("\n");

/** Kode galat fatal `--json` (U-05b). */
export type DraftCheckFatalCode =
  | "USAGE_ERROR"
  | "FILE_UNREADABLE"
  | "SECRET_MISSING"
  | "REMOTE_UNREACHABLE"
  | "REMOTE_UNAUTHORIZED"
  | "RATE_LIMITED"
  | "REMOTE_ERROR"
  | "REMOTE_BAD_RESPONSE"
  | "BLOCK_NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_ERROR";

/** Galat pemakaian/berkas/jaringan (kode keluar 2); `code` = kode fatal `--json`. */
export class DraftCheckUsageError extends Error {
  constructor(
    message: string,
    readonly code: DraftCheckFatalCode = "USAGE_ERROR",
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// ── Pemeriksaan lokal ───────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * §5.6 langkah 6b: I54 `checkContractRecord` atas setiap payload `contractRecord` blok (D-375,
 * menggantikan cek `items[].key` lokal DC-22). `positions` EC27 berbasis 1. Nama lama dipertahankan
 * sebagai ekspor CLI.
 */
export const contractStructureIssues = draftContractIssues;

/** Hasil T2-70 lokal: I63 + skema v2 per blok + langkah 6b. Blok dengan isu ekstraksi galat tidak diperiksa lebih lanjut. */
export function checkDraftLocal(markdown: string): DraftCheckResultV2 {
  const ex = extractDraft(markdown);
  const result = toDraftCheckResult(ex);
  for (const b of result.blocks) {
    if (!b.valid || !isV2SubmissionSchema(b.schema) || !isRecord(b.payload)) continue;
    const schemaIssues = validateV2(b.schema, b.payload);
    b.issues = schemaIssues.length > 0 ? schemaIssues : contractStructureIssues(b.payload);
    b.valid = b.issues.length === 0;
  }
  return finalizeDraftResult(result);
}

// ── Pemeriksaan remote (R08) ────────────────────────────────────────────

/** Fetch yang dapat disuntik (uji); sama dengan klien bersama `./_http-client` (R2-F2 #6). */
export type FetchLike = HttpFetch;

export interface RemoteOptions {
  baseUrl: string;
  secret: string;
  fetchImpl?: FetchLike;
  /** agentId bawaan dry-run (aturan bersama D-392, `services/draft/check.ts`). */
  agentId?: string;
}

/** Asal + path tanpa garis miring akhir; selain http(s) = galat pemakaian (klien bersama `./_http-client`). */
export function normalizeBaseUrl(raw: string): string {
  try {
    return normalizeSharedBaseUrl(raw);
  } catch (e) {
    if (e instanceof StudioUrlError) throw new DraftCheckUsageError(e.message);
    throw e;
  }
}

/**
 * Klien bersama dengan pengalihan DIIKUTI: perilaku lama draft-check yang risikonya diterima USER
 * (D-402 M-2, D-425 #2); lihat kepala `./_http-client`.
 */
async function call(opts: RemoteOptions, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<HttpReply> {
  try {
    return await studioRequest({ baseUrl: opts.baseUrl, secret: opts.secret, fetchImpl: opts.fetchImpl, redirect: "follow" }, init.method, path, { body: init.body, okStatuses: [200] });
  } catch (e) {
    if (e instanceof StudioUnreachableError) throw new DraftCheckUsageError(e.message, "REMOTE_UNREACHABLE");
    throw e;
  }
}

/** Galat server -> kode fatal `--json` draft-check; `details` membawa status, code server, dan cid (peta bersama). */
function serverFailure(path: string, r: HttpReply): DraftCheckUsageError {
  const f = httpFailureOf(r, `${path}`);
  const details: Record<string, unknown> = {
    httpStatus: f.httpStatus,
    ...(f.serverCode !== undefined ? { serverCode: f.serverCode } : {}),
    ...(f.correlationId !== undefined ? { correlationId: f.correlationId } : {}),
  };
  if (f.code === "REMOTE_UNAUTHORIZED" || f.code === "RATE_LIMITED") return new DraftCheckUsageError(f.message, f.code, details);
  const msg = isRecord(r.body) && typeof r.body.error === "string" ? `: ${r.body.error}` : "";
  return new DraftCheckUsageError(`server menjawab ${r.status} untuk ${path}${msg}`, r.status === 200 ? "REMOTE_BAD_RESPONSE" : "REMOTE_ERROR", details);
}

/** Revisi terkini dokumen lewat R05 (DR-08); 404 = dokumen tidak ditemukan (tidak dapat dicek). */
async function currentRevisionNo(documentId: string, opts: RemoteOptions): Promise<number | null> {
  const path = `${STUDIO_ROUTES.R05.replace("[id]", encodeURIComponent(documentId))}`;
  const r = await call(opts, path, { method: "GET" });
  if (r.status === 404) return null;
  if (r.status !== 200) throw serverFailure(path, r);
  const doc = isRecord(r.body) && isRecord(r.body.document) ? r.body.document : null;
  const current = doc && typeof doc.currentRevisionNo === "number" ? doc.currentRevisionNo : null;
  if (current === null) throw new DraftCheckUsageError(`jawaban ${path} tidak memuat document.currentRevisionNo`, "REMOTE_BAD_RESPONSE");
  return current;
}

/** Satu blok ke R08; isu R08 apa adanya (T2-71). */
async function dryRunBlock(text: string, opts: RemoteOptions): Promise<DraftDryRunOutcome> {
  const path = STUDIO_ROUTES.R08;
  const r = await call(opts, path, { method: "POST", body: text });
  if (r.status === 200 && isRecord(r.body) && typeof r.body.valid === "boolean") {
    return {
      valid: r.body.valid,
      issues: Array.isArray(r.body.issues) ? r.body.issues : [],
      ...(r.body.submitPreview !== undefined ? { submitPreview: r.body.submitPreview } : {}),
      ...(r.body.completenessPreview !== undefined ? { completenessPreview: r.body.completenessPreview } : {}),
    };
  }
  if (r.status === 401 || r.status === 429 || r.status >= 500 || !isRecord(r.body)) throw serverFailure(path, r);
  // 4xx lain (403 templat terbatas, 400, 413): blok ditolak server; galat dicatat sebagai isu blok (D-373).
  return rejectedDryRun(
    typeof r.body.code === "string" ? r.body.code : `HTTP_${r.status}`,
    typeof r.body.error === "string" ? r.body.error : `server menjawab ${r.status}`,
    r.body.details,
  );
}

/**
 * Hasil T2-70 dengan dry-run R08 per blok (bentuk respons R23) + DR-08. Orkestrasi sama dengan
 * R23 (`services/draft/check.ts`, AC-19); hanya transportnya HTTP.
 */
export async function checkDraftRemote(markdown: string, opts: RemoteOptions): Promise<DraftCheckResultV2> {
  const o: RemoteOptions = { ...opts, baseUrl: normalizeBaseUrl(opts.baseUrl) };
  return completeDraftCheck(markdown, prepareDraftCheck(markdown), {
    currentRevisionNo: (documentId) => currentRevisionNo(documentId, o),
    dryRun: (input) => dryRunBlock(input.text, o),
  }, o.agentId);
}

// ── Keluaran ────────────────────────────────────────────────────────────

export function exitCodeOf(result: DraftCheckResultV2): 0 | 1 {
  return result.valid ? 0 : 1;
}

function where(i: { line?: number; column?: number }): string {
  if (i.line === undefined) return "";
  return i.column === undefined ? `baris ${i.line} ` : `baris ${i.line} kolom ${i.column} `;
}

function issueLine(i: unknown): string {
  if (!isRecord(i)) return `      ${JSON.stringify(i)}`;
  const pointer = typeof i.pointer === "string" && i.pointer !== "" ? i.pointer : "/";
  return `      ${pointer} ${String(i.keyword ?? i.code ?? "")}: ${String(i.message ?? "")}`;
}

/** Laporan untuk manusia (Bahasa Indonesia). */
export function formatHuman(file: string, result: DraftCheckResultV2, remote: string | null, createSources: ReadonlyMap<number, number> = new Map()): string {
  const h = result.header;
  const out: string[] = [];
  out.push(`draft-check: ${file}${remote ? ` (remote ${remote})` : " (lokal)"}`);
  out.push(`  judul: ${h.title ?? "-"}`);
  out.push(`  tujuan: ${h.tujuan ?? "-"}`);
  out.push(`  langkah-berikut: ${h.langkahBerikut ?? "-"}`);
  out.push(`  basis: ${h.basis ?? "-"}`);
  for (const i of result.issues) {
    out.push(`  [${i.severity === "error" ? "galat" : "peringatan"}] ${where(i)}${i.code}: ${i.message}`);
  }
  for (const b of result.blocks) {
    const src = remote ? createSources.get(b.index) : undefined;
    const via = src !== undefined ? ` (target: dokumen yang dibuat blok ${src})` : "";
    out.push(`  blok ${b.index} (baris ${b.line}-${b.endLine}) ${b.schema ?? "tanpa $schema"}${via}: ${b.valid ? "valid" : "TIDAK VALID"}`);
    for (const i of b.issues.slice(0, 20)) out.push(issueLine(i));
    if (b.issues.length > 20) out.push(`      ... ${b.issues.length - 20} isu lain (pakai --json untuk daftar lengkap)`);
  }
  const errors = result.issues.filter((i) => i.severity === "error").length;
  const warnings = result.issues.length - errors;
  const invalid = result.blocks.filter((b) => !b.valid).length;
  out.push(
    `hasil: ${result.valid ? "LOLOS" : "TIDAK LOLOS"} (galat ${errors}, peringatan ${warnings}, blok ${result.blocks.length}, blok tidak valid ${invalid})`,
  );
  return `${out.join("\n")}\n`;
}

// ── CLI ──────────────────────────────────────────────────────────────────

export interface CliArgs {
  file: string;
  remote: string | null;
  agentId: string | null;
  emit: number | null;
  json: boolean;
  withPayload: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs | "help" {
  let file: string | null = null;
  let remote: string | null = null;
  let agentId: string | null = null;
  let emit: number | null = null;
  let json = false;
  let withPayload = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return "help";
    if (a === "--json") json = true;
    else if (a === "--with-payload") withPayload = true;
    else if (a === "--remote" || a === "--emit" || a === "--agent-id") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new DraftCheckUsageError(`${a} memerlukan nilai`);
      i++;
      if (a === "--remote") remote = v;
      else if (a === "--agent-id") {
        if (v.length < 1 || v.length > 80) throw new DraftCheckUsageError("--agent-id harus 1..80 karakter");
        agentId = v;
      } else {
        if (!/^[1-9][0-9]{0,5}$/.test(v)) throw new DraftCheckUsageError(`--emit memerlukan nomor blok bilangan bulat >= 1 (diberikan "${v}")`);
        emit = Number(v);
      }
    } else if (a.startsWith("--")) throw new DraftCheckUsageError(`opsi tidak dikenal: ${a}`);
    else if (file === null) file = a;
    else throw new DraftCheckUsageError(`argumen tidak terduga: ${a}`);
  }
  if (file === null) throw new DraftCheckUsageError("berkas <berkas.md> belum diberikan");
  if (emit !== null && (json || remote !== null)) throw new DraftCheckUsageError("--emit tidak dapat digabung dengan --json atau --remote");
  if (agentId !== null && remote === null) throw new DraftCheckUsageError("--agent-id hanya berlaku bersama --remote");
  if (withPayload && !json) throw new DraftCheckUsageError("--with-payload hanya berlaku bersama --json");
  return { file, remote, agentId, emit, json, withPayload };
}

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl?: FetchLike;
}

/** Hasil `--json` tanpa `blocks[].payload` (U-05d); urutan medan lain tetap. */
export function withoutPayload(result: DraftCheckResultV2): unknown {
  return {
    ...result,
    blocks: result.blocks.map((b) => {
      const rest: Partial<DraftCheckResultV2["blocks"][number]> = { ...b };
      delete rest.payload;
      return rest;
    }),
  };
}

/** Badan galat fatal `--json` (U-05b). */
export function fatalJson(code: DraftCheckFatalCode, message: string, details?: Record<string, unknown>): string {
  return `${JSON.stringify({ fatal: { code, message, ...(details ? { details } : {}) } }, null, 2)}
`;
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  // Diketahui sebelum pengurai agar galat pemakaian pun dicetak sebagai JSON (U-05b).
  const wantsJson = argv.includes("--json");
  const fatal = (code: DraftCheckFatalCode, message: string, rc: 1 | 2, opts: { usage?: boolean; details?: Record<string, unknown>; hint?: string } = {}): number => {
    io.stderr(`draft-check: ${message}${opts.hint ?? ""}
${opts.usage ? `${USAGE}
` : ""}`);
    if (wantsJson) io.stdout(fatalJson(code, message, opts.details));
    return rc;
  };
  try {
    return await run(argv, io, fatal);
  } catch (e) {
    return fatal("INTERNAL_ERROR", `galat tak terduga: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, 2);
  }
}

type FatalFn = (code: DraftCheckFatalCode, message: string, rc: 1 | 2, opts?: { usage?: boolean; details?: Record<string, unknown>; hint?: string }) => number;

async function run(argv: readonly string[], io: CliIo, fatal: FatalFn): Promise<number> {
  let args: CliArgs | "help";
  try {
    args = parseArgs(argv);
  } catch (e) {
    return fatal(e instanceof DraftCheckUsageError ? e.code : "USAGE_ERROR", e instanceof Error ? e.message : String(e), 2, { usage: true });
  }
  if (args === "help") {
    io.stdout(argv.includes("--json") ? `${JSON.stringify({ help: HELP }, null, 2)}
` : `${HELP}
`);
    return 0;
  }

  let raw: Buffer;
  try {
    raw = fs.readFileSync(args.file);
  } catch (e) {
    return fatal("FILE_UNREADABLE", `tidak dapat membaca ${args.file}: ${e instanceof Error ? e.message : String(e)}`, 2);
  }
  const markdown = raw.toString("utf8");

  const limit = checkDraftLimits(markdown, { bodyBytes: raw.length });
  if (limit !== null) {
    return fatal("PAYLOAD_TOO_LARGE", `${limit}: ${draftLimitMessage(limit)}`, 1, { details: { reason: limit }, hint: "; pecah draf menjadi beberapa berkas" });
  }

  if (args.emit !== null) {
    const ex = extractDraft(markdown);
    const block = ex.blocks[args.emit - 1];
    if (!block) return fatal("BLOCK_NOT_FOUND", `blok ${args.emit} tidak ada; draf memuat ${ex.blocks.length} blok json tertutup`, 2);
    io.stdout(block.text);
    const local = checkDraftLocal(markdown).blocks[args.emit - 1];
    if (!local.valid) {
      io.stderr(`draft-check: catatan: blok ${args.emit} tidak valid secara lokal; jalankan tanpa --emit untuk rinciannya
`);
      return 1;
    }
    return 0;
  }

  let result: DraftCheckResultV2;
  if (args.remote !== null) {
    const secret = io.env.INTERNAL_API_SECRET ?? "";
    if (secret === "") return fatal("SECRET_MISSING", "--remote memerlukan env INTERNAL_API_SECRET yang terisi", 2);
    try {
      result = await checkDraftRemote(markdown, { baseUrl: args.remote, secret, fetchImpl: io.fetchImpl, ...(args.agentId !== null ? { agentId: args.agentId } : {}) });
    } catch (e) {
      if (e instanceof DraftCheckUsageError) return fatal(e.code, e.message, 2, e.details ? { details: e.details } : {});
      throw e;
    }
  } else {
    result = checkDraftLocal(markdown);
  }

  if (args.json) {
    io.stdout(`${JSON.stringify(args.withPayload ? result : withoutPayload(result), null, 2)}
`);
  } else {
    io.stdout(formatHuman(args.file, result, args.remote, args.remote !== null ? sequentialCreateSources(extractDraft(markdown)) : undefined));
  }
  return exitCodeOf(result);
}

// Swarm patch (row 107, row 11 M5): the direct-run entry guard block is removed so that
// main() can never run as a side effect of loading this module inside the host bundle. Callers
// invoke main(argv, io) explicitly.
