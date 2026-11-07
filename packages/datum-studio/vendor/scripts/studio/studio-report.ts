/**
 * CLI laporan kerja agen satu perintah (U-01, D-419; panduan §17.4-§17.9).
 *
 *   npx tsx <repo>/scripts/studio/studio-report.ts submit <laporan.md> [opsi]
 *   npx tsx <repo>/scripts/studio/studio-report.ts update <documentId> <laporan.md> [opsi]
 *   npx tsx <repo>/scripts/studio/studio-report.ts template [--mission m] [--doc-key k] [--format md|json]
 *   npx tsx <repo>/scripts/studio/studio-report.ts check <laporan.md> [--remote <url>] [--json]   (D-441: hanya periksa)
 *   npx tsx <repo>/scripts/studio/studio-report.ts refresh <documentId> <laporan.md> [--out-md <berkas> | --write]   (R3-F2)
 *
 * R3-01 (D-435): masukan MD-native (U-15) — laporan kerja Markdown biasa (kepala `Kunci: nilai` +
 *   `##` per bab outline, TANPA blok ```json) diubah alat (`services/draft/md-report`, generator I64
 *   `markdownToContract`) menjadi blok kiriman yang sama dengan draf ber-blok json, lalu masuk pipa
 *   yang sama (cek lokal, EXAMPLE_TARGET, kiriman berurutan, progres). Format dideteksi otomatis
 *   (ada blok ```json ber-`$schema` C57 -> json) atau `--format md|json`. KD-42: status/reportedAt
 *   hilang -> MD2CONTRACT_REQUIRED_MISSING keluar 1 tanpa kiriman. Update delta (U-16): hanya bagian
 *   yang berbeda dari basis R20 yang dikirim; `--section` membatasi ke bagian tertentu. `template`
 *   (U-18) mencetak templat siap diisi ke stdout (tanpa server, tanpa berkas).
 *
 * submit: blok draf (I63 `extractDraft`, diperiksa lokal lebih dulu seperti `draft-check`) dikirim
 *   berurutan: `studio.slot/v2` -> R13, `studio.chapter/v2` -> R12, `studio.doc/v2` -> R04. Blok
 *   sesudah blok buat-dokumen yang menarget `mission.folder` + `docKey` sama (aturan simulasi
 *   berurutan `services/draft`, U-05a) dikirim dengan `target: { documentId }` dokumen yang baru
 *   dibuat. Lalu kelengkapan R15, render R17 (bawaan HTML), unduh R10 ke memori (sha256 dicocokkan)
 *   dan HEAD R10 `?verify=1`.
 * update: basis dibaca lewat R20 (isi + `revisionNo`); setiap blok bab/slot diarahkan ke
 *   `target: { documentId }`, `baseRevisionNo` diisi otomatis bila tidak ditulis, dan hanya blok
 *   yang isinya berbeda dari basis yang dikirim. Lalu kelengkapan, render, dan verifikasi.
 *   R3-F #1 (D-439): perbandingan TIGA ARAH terhadap revisi dasar salinan agen — baris
 *   `basis: <documentId>@rev<n>` di kepala laporan (dicetak submit/update untuk disalin agen; CLI
 *   tidak pernah menulis berkas agen) atau `--base-rev <n>`. Laporan MD tanpa basis ditolak
 *   `BASIS_MISSING` (kecuali `--force-latest`, tercatat di hasil dan timing). Bagian yang disunting
 *   agen DAN diubah pihak lain sesudah basis -> `BASE_CONFLICT` keluar 1 tanpa kiriman (daftar bagian
 *   bentrok + isi terkini); bagian yang tidak disunting agen tidak pernah dikirim (suntingan pihak lain
 *   tetap), bagian tak bersinggungan dapat dikirim dengan `--section`. `baseRevisionNo` = n, sehingga
 *   cek §9.2 server menjaga jendela balapan.
 *   R3-F2 (D-446, D-448; review 15b N1..N5): BASE_CONFLICT mendaftar SEMUA bagian yang diubah pihak
 *   lain sejak basis dan pemulihannya = `refresh` (gabung per bagian dengan versi server, lossless,
 *   diverifikasi konversi ulang, baris basis terkini; bagian yang diubah keduanya diberi penanda
 *   konflik; berkas agen hanya ditulis dengan `--write`), bukan salin-tempel. Butir/bukti/rujukan record
 *   hanya terhapus bila baris ditandai `~~hapus~~` atau `--allow-remove` (RECORD_ELEMENTS_DROPPED).
 *   R3-F3 (D-453; review 15c R1-R3): TANPA pengecualian "tulisan sendiri" - setiap bagian dikirim dengan
 *   `baseRevisionNo` = basis agen (server = wasit; 409 SCOPE_CONFLICT -> BASE_CONFLICT); penulis terakhir
 *   ber-agentId sama hanya memicu peringatan. `refresh` mempertahankan baris `~~hapus~~`.
 *
 * Badan kiriman dan berkas unduhan HANYA di memori: tanpa berkas sementara dan tanpa curl. Berkas
 * hanya ditulis untuk `--out <dir>` (berkas final, nama dari header `X-Studio-Final-Filename`) dan
 * `--timing <csv>` (baris berwaktu mesin, header 20 kolom protokol research/11 §5.1, RFC 4180).
 * Rahasia dibaca dari env `INTERNAL_API_SECRET`, dikirim hanya sebagai header `x-internal-secret`,
 * tidak pernah dicetak atau ditulis; pengalihan (3xx) tidak diikuti agar rahasia tidak diteruskan.
 *
 * Klien HTTP bersama `./_http-client` (R2-F2 #6): batas waktu, peta galat 3xx/401/429/5xx, `code`
 * server, dan cid sama dengan `draft-check --remote`; studio-report memakai pengalihan `manual`.
 *
 * Kode keluar: 0 sukses; 1 galat isi (draf tidak lolos cek lokal, server menolak kiriman 4xx,
 * sha/verifikasi berkas tidak cocok); 2 galat lingkungan/pemakaian (argumen, rahasia, jaringan,
 * 3xx, 401, 429, 5xx, berkas --out/--timing, nama final di luar FINAL_FILENAME_PATTERN);
 * 3 dokumen belum lengkap (INCOMPLETE) dan `--require-complete` diberikan.
 * Kiriman terputus (R2-F2 #5): galat sesudah ada blok yang tersimpan di server tetap memakai kode
 * keluar penyebabnya (1 atau 2) dan membawa `progress` (documentId, docNumber, revisionNo terakhir,
 * langkah yang sudah tersimpan, langkah gagal, `allBlocksSent`, cara melanjutkan) di stderr dan di
 * `fatal.progress` `--json`. Lanjutkan dengan menjalankan ulang perintah yang sama (idempoten: blok
 * yang sudah tersimpan dijawab `unchanged`) atau `update <documentId> <draf.md>`.
 */
import "./_repo-alias";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DraftCheckResultV2 } from "../../src/lib/studio/contract";
import { DOC_KEY_PATTERN, DRAFT_ACCEPTED_SCHEMAS, FINAL_FILENAME_PATTERN, studioRoutePath, type StudioRouteId } from "../../src/lib/studio/contract/env";
import {
  checkDraftLimits,
  draftBasisRevision,
  draftCreateTargetOf,
  draftLimitMessage,
  dryRunInputOf,
  extractDraft,
  sequentialCreateSources,
  type ExtractedDraftBlock,
} from "../../src/lib/studio/services/draft";
import { CONTRACT_KIND_DEFS, getContractKindDef } from "../../src/lib/studio/registry/contracts";
import { AGENT_FILLER_PREFIX } from "../../src/lib/studio/services/submit/meta";
import {
  assembleReportMarkdown,
  assertNoPlaceholders,
  blocksToDraftMarkdown,
  chapterToMarkdown,
  chapterToReportMarkdown,
  keepRemovalRows,
  MD_REPORT_DEFAULT_KIND,
  MdReportError,
  mdReportRules,
  mdReportToBlocks,
  newSerializeCtx,
  parseMdBasis,
  plainTextOf,
  recordToMarkdown,
  recordToReportMarkdown,
  referencesToReportMarkdown,
  refRemovalKey,
  reportTemplate,
  sameStructure,
  stripToolKeys,
  type AssemblePart,
  type MdReportConversion,
  type ReportPartMarkdown,
} from "../../src/lib/studio/services/draft/md-report";
import { normalizeHeading } from "../../src/lib/studio/services/import/contract/parse";
import { checkDraftLocal, checkDraftRemote, DraftCheckUsageError, withoutPayload } from "./draft-check";
import { httpFailureOf, normalizeBaseUrl, studioRequest, StudioUnreachableError, type HttpFetch, type HttpReply, type HttpResponseLike } from "./_http-client";

export type { HttpFetch, HttpResponseLike } from "./_http-client";

const NAME = "studio-report";

const USAGE = [
  "pemakaian: npx tsx scripts/studio/studio-report.ts submit <laporan.md> [opsi]",
  "           npx tsx scripts/studio/studio-report.ts update <documentId> <laporan.md> [opsi]",
  "           npx tsx scripts/studio/studio-report.ts template [--mission <folder>] [--doc-key <kunci>] [--format md|json]",
  "           npx tsx scripts/studio/studio-report.ts check <laporan.md> [--remote <url>] [--json]",
  "           npx tsx scripts/studio/studio-report.ts refresh <documentId> <laporan.md> [--out-md <berkas> | --write] [--json]",
].join("\n");

/** Aturan kunci kepala dan judul bab laporan MD-native, dibangkitkan dari registri (alias + outline). */
function mdRulesHelp(): string[] {
  const r = mdReportRules();
  const keys = Object.entries(r.headerKeys).map(([field, names]) => `    ${field.padEnd(11)} ${names.join(", ")}`);
  const chapters = r.chapters.map((c) => `    bab ${c.key}: ${c.titles.join(" | ")}`);
  return [
    "Laporan MD-native (tanpa blok ```json): kepala lalu satu judul ## per bab.",
    '  Kepala = baris "Kunci: nilai" sebelum ## pertama (dalam 40 baris pertama) atau frontmatter; kunci tidak peka huruf.',
    "  Kunci alat (tidak masuk isi): mission | misi, docKey, agentId. Kunci record yang dikenali:",
    ...keys,
    `  Status wajib (${r.statuses.join(", ")}) dan ReportedAt wajib (YYYY-MM-DD atau YYYY-MM-DDTHH:MM+07:00);`,
    "  hilang atau tanpa alias -> MD2CONTRACT_REQUIRED_MISSING, keluar 1, tidak ada yang dikirim (tidak ditebak).",
    "  Butir kerja = tabel ber-kolom key|id|kartu + status (opsional judul, owner, fase, dep, bukti); id kartu",
    "  t_xxxxxxxx juga masuk cardIds. Judul ## yang dikenali (huruf kecil, nomor depan diabaikan):",
    ...chapters,
    "    references: referensi. Judul lain -> bab tambahan 6, 7, ... (peringatan CONTRACT_HEADING_UNMAPPED).",
    "    rujukan: tabel | hubungan | dokumen | paragraf | revisi | -> record.refs (hubungan " + r.refRels.join("|") + ";",
    "      dokumen = documentId; paragraf (pid) dan revisi opsional). Baris yang tidak terpetakan -> ditolak.",
    "  Peringatan konversi (CW) dan unsur yang dibuang importer dicetak; bab wajib kosong -> dokumen INCOMPLETE.",
    "  Nilai majemuk (a/b, a dan b, a & b, a atau b) tidak dipotong: status/ReportedAt majemuk ditolak (KD-42).",
    "  Mulai dari: studio-report template --mission <folder> --doc-key <kunci> > laporan.md lalu ganti SEMUA",
    "  <isi: ...>; laporan yang masih memuat placeholder ditolak TEMPLATE_PLACEHOLDER (keluar 1, tidak dikirim).",
    "  Sesudah submit/update, salin baris \"basis: <documentId>@rev<n>\" yang dicetak ke kepala laporan;",
  "  bila basis berikutnya belum dapat dipakai (bagian diubah pihak lain), jalankan refresh.",
  "  Hapus butir/rujukan record: tulis ~~hapus~~ di sel status baris butir / di baris Rujukan.",
  ];
}

const HELP = [
  USAGE,
  "",
  "Mengirim laporan kerja (Markdown biasa atau draf ber-blok ```json, panduan §17.9) sampai berkas",
  "HTML terverifikasi, tanpa curl dan tanpa berkas sementara.",
  "",
  "  submit    kirim semua bagian berurutan (record pembuat dokumen lebih dulu), lalu kelengkapan,",
  "            render HTML, unduh ke memori, dan verifikasi sha256",
  "  update    perbarui dokumen yang ada. WAJIB basis: baris \"basis: <documentId>@rev<n>\" di kepala",
  "            laporan (dicetak submit/update; CLI tidak menulis berkas Anda) atau --base-rev <n>. HANYA",
  "            bagian yang Anda ubah sejak basis yang dikirim (baseRevisionNo = n). Bagian yang Anda ubah",
  "            DAN diubah pihak lain sesudah basis -> BASE_CONFLICT (keluar 1, tidak ada yang dikirim;",
  "            daftar SEMUA bagian yang diubah sejak basis): pulihkan dengan refresh --write (bukan salin).",
  "            Bagian yang tidak Anda ubah tidak dikirim (suntingan pihak lain tetap). Tulisan Anda sendiri",
  "            sesudah basis juga konflik bila basis laporan lama: salin basis baru yang dicetak, atau",
  "            refresh --write. Satu agentId per penulis. Bab yang ada di dokumen tetapi tidak ada di",
  "            laporan TIDAK dihapus; judul (#) tidak diperbarui oleh update. Butir/bukti/rujukan record",
  "            yang tidak ada di laporan -> RECORD_ELEMENTS_DROPPED, kecuali baris ~~hapus~~ / --allow-remove",
  "  refresh   ambil versi server terkini (GET saja, tanpa kiriman) dan gabungkan per bagian dengan",
  "            laporan Anda terhadap basisnya: bagian yang hanya Anda ubah dipertahankan, bagian yang diubah",
  "            pihak lain diambil dari server (lossless), bagian yang diubah keduanya ditandai",
  "            <<<<<<< ======= >>>>>>> (laporan berpenanda ditolak sampai diselesaikan); baris basis",
  "            diperbarui ke revisi terkini. Hasil ke stdout (ringkasan ke stderr), --out-md <berkas>, atau",
  "            --write (menimpa laporan Anda). Hasil diverifikasi konversi ulang; bagian server yang tidak",
  "            dapat ditulis lewat MD tidak ditulis (update tidak menyentuhnya). Keluar 0 bersih, 1 konflik",
  "  template  cetak templat laporan siap diisi ke stdout (dari contoh registri, tanpa ID nyata)",
  "  check     HANYA periksa (tanpa kiriman): konversi seperti submit/update (baris basis -> mode update),",
  "            cek lokal, penjaga target contoh; --remote: dry-run R08 per bagian (POST /api/studio/validate,",
  "            tidak menyimpan apa pun). Keluar 0 valid, 1 ada isu yang menghalangi kiriman, 2 lingkungan.",
  "            Batas: gerbang khusus update (BASE_CONFLICT, RECORD_FIELDS_DROPPED/ELEMENTS_DROPPED,",
  "            pemetaan bab tambahan) hanya dijalankan update; VALID tidak menjamin update lolos",
  "",
  "Opsi:",
  "  --remote <url>       server Studio (bawaan: env HQ_URL), mis. http://127.0.0.1:9021",
  "  --agent-id <id>      agentId untuk blok tanpa medan agentId dan untuk render (1..80 karakter);",
  "                       laporan MD: menang atas baris agentId: kepala (peringatan bila berbeda)",
  "  --mission <folder>   (submit, template) ganti folder misi target semua bagian",
  "  --doc-key <kunci>    (submit, template) ganti docKey target semua bagian",
  "  --format md|json     submit/update: format masukan (bawaan deteksi otomatis: ada blok ```json",
  "                       ber-$schema studio.* = json, selain itu md); template: format templat (bawaan md)",
  "  --section <kunci>    (update) kirim hanya bagian ini, walau sama dengan basis: record, references,",
  "                       atau kunci bab (mis. 3); beberapa dipisah koma; bagian lain tidak dikirim",
  "  --base-rev <n>       (update) revisi dasar salinan Anda; menang atas baris basis kepala",
  "  --force-latest       (update) tanpa basis: bandingkan dengan revisi terkini (perubahan pihak lain",
  "                       pada bagian yang berbeda DAPAT tertimpa); dicatat di hasil dan timing;",
  "                       diabaikan (dengan pemberitahuan) bila laporan memuat baris basis",
  "  --allow-remove       (update) izinkan butir/bukti/rujukan record yang tidak ada di laporan terhapus",
  "  --out-md <berkas>    (refresh) tulis laporan gabungan ke <berkas> (bukan laporan Anda sendiri)",
  "  --write              (refresh) timpa laporan Anda dengan laporan gabungan (eksplisit)",
  "  --out <dir>          simpan berkas final ke <dir> dengan nama dari server (hanya nama yang lolos",
  "                       pola nama final C51); tanpa opsi ini tidak ada berkas yang ditulis",
  "  --timing <csv>       tambahkan baris waktu (header 20 kolom protokol, RFC 4180) ke <csv>;",
  "                       kolom konteks dari env STUDIO_TIMING_RUN_ID, STUDIO_TIMING_ARM,",
  "                       STUDIO_TIMING_REPORT_ID, STUDIO_TIMING_ORDER, STUDIO_TIMING_SESSION_ID",
  "  --step <id>          step_id baris waktu (bawaan: submit atau update)",
  "  --require-complete   keluar 3 bila dokumen belum lengkap (tanpa opsi ini: render dilewati, keluar 0)",
  "  --allow-example      izinkan blok yang menarget misi atau docKey contoh registri (bawaan: ditolak,",
  "                       kode EXAMPLE_TARGET, keluar 2, sebelum kiriman pertama)",
  "  --json               keluaran mesin (JSON); galat dicetak { \"ok\": false, \"fatal\": { ... } }",
  "  -h, --help           tampilkan bantuan ini",
  "",
  "",
  ...mdRulesHelp(),
  "",
  "Rahasia dibaca dari env INTERNAL_API_SECRET dan tidak pernah dicetak.",
  "Kode keluar: 0 sukses, 1 galat isi, 2 galat lingkungan atau pemakaian, 3 dokumen belum lengkap",
  "(--require-complete). Galat sesudah ada blok yang tersimpan tetap keluar 1 atau 2 dan mencetak",
  "documentId, revisionNo terakhir, langkah yang tersimpan, dan langkah yang gagal (--json: fatal.progress);",
  "lanjutkan dengan menjalankan ulang perintah yang sama (idempoten) atau update <documentId> <draf.md>.",
].join("\n");

/** Header 20 kolom timing.csv (protokol research/11 §5.1), persis. */
export const TIMING_HEADER = [
  "run_id",
  "arm",
  "report_id",
  "order",
  "session_id",
  "seq",
  "step_id",
  "step_kind",
  "action",
  "target",
  "http_status",
  "corr_id",
  "t_start_utc",
  "t_end_utc",
  "dur_s",
  "ok",
  "err_code",
  "bytes",
  "sha16",
  "note",
] as const;

// ── Galat ───────────────────────────────────────────────────────────────

/** Kemajuan kiriman yang terputus (R2-F2 #5): apa yang SUDAH tersimpan di server. */
export interface ReportProgress {
  documentId: string;
  docNumber: string | null;
  /** Revisi terakhir yang dilaporkan server untuk langkah yang sudah sukses. */
  revisionNo: number | null;
  /** Langkah yang sudah sukses, mis. `blok 1 (record)`. */
  completedSteps: string[];
  /** Langkah yang gagal, mis. `blok 3 (bab 2)` atau `render R17`. */
  failedStep: string;
  /** true = semua blok sudah terkirim (galat di kelengkapan, render, unduh, atau simpan). */
  allBlocksSent: boolean;
  /** Cara melanjutkan (Bahasa Indonesia). */
  resume: string;
}

export interface ReportErrorInfo {
  httpStatus?: number;
  correlationId?: string;
  pointer?: string;
  step?: string;
  details?: unknown;
  progress?: ReportProgress;
}

/** Galat yang menghentikan perintah; `exitCode` 1 isi, 2 lingkungan/pemakaian, 3 INCOMPLETE. */
export class ReportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: 1 | 2 | 3,
    readonly info: ReportErrorInfo = {},
  ) {
    super(message);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ── Timing (RFC 4180) ───────────────────────────────────────────────────

/**
 * Netralisasi injeksi formula spreadsheet (R2-F2 #8, OWASP CSV injection): teks yang diawali
 * `=`, `+`, `-`, `@`, tab, atau CR diberi awalan `'`. Pengecualian yang tidak dapat menjadi formula:
 * bilangan desimal bertanda minus (`-1.5`) dan penanda kosong `-` (bawaan kolom konteks).
 */
export function csvNeutralize(s: string): string {
  if (!/^[=+\-@\t\r]/.test(s)) return s;
  return /^-(?:[0-9]+(?:\.[0-9]+)?)?$/.test(s) ? s : `'${s}`;
}

/** Satu medan CSV: dinetralkan ({@link csvNeutralize}), lalu dikutip RFC 4180 bila memuat koma, kutip ganda, CR, atau LF. */
export function csvField(v: string | number | null | undefined): string {
  const s = csvNeutralize(v === null || v === undefined ? "" : String(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Pengurai CSV RFC 4180 minimal (medan berkutip boleh memuat koma dan baris baru). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface TimingContext {
  runId: string;
  arm: string;
  reportId: string;
  order: string;
  sessionId: string;
  stepId: string;
}

export interface TimingEvent {
  kind: "api" | "tool" | "edit";
  action: string;
  target: string;
  httpStatus?: number;
  correlationId?: string;
  tStart: number;
  tEnd: number;
  ok: boolean;
  errCode?: string;
  bytes?: number;
  sha16?: string;
  note?: string;
}

const secs = (ms: number): string => (ms / 1000).toFixed(3);

/** Baris CSV (tanpa LF) untuk satu peristiwa; `seq` diberikan pemanggil. */
export function timingRow(ctx: TimingContext, seq: number, e: TimingEvent): string {
  const cells: Array<string | number | undefined> = [
    ctx.runId,
    ctx.arm,
    ctx.reportId,
    ctx.order,
    ctx.sessionId,
    seq,
    ctx.stepId,
    e.kind,
    e.action,
    e.target,
    e.httpStatus,
    e.correlationId,
    secs(e.tStart),
    secs(e.tEnd),
    ((e.tEnd - e.tStart) / 1000).toFixed(3),
    e.ok ? 1 : 0,
    e.errCode,
    e.bytes,
    e.sha16,
    e.note,
  ];
  return cells.map((c) => csvField(c)).join(",");
}

export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: "utf8"): string;
  appendFileSync(p: string, data: string): void;
  mkdirSync(p: string, opts: { recursive: true }): unknown;
  writeFileSync(p: string, data: Uint8Array, opts: { flag: "wx" }): void;
  readFileSyncBuffer?(p: string): Buffer;
  /** R3-F2: tulis teks utuh (refresh `--out-md` / `--write`; atomik lewat berkas sementara + rename). */
  writeFileText?(p: string, data: string): void;
}

/** Berkas timing: dibuka (header dicek) SEBELUM kiriman pertama, ditulis sekali di akhir. */
export class TimingSink {
  private events: TimingEvent[] = [];
  private constructor(
    private readonly file: string,
    private readonly ctx: TimingContext,
    private readonly fsx: FsLike,
    private readonly needsHeader: boolean,
    private nextSeq: number,
  ) {}

  static open(file: string, ctx: TimingContext, fsx: FsLike): TimingSink {
    let text = "";
    try {
      text = fsx.existsSync(file) ? fsx.readFileSync(file, "utf8") : "";
    } catch (e) {
      throw new ReportError(`tidak dapat membaca berkas timing ${file}: ${e instanceof Error ? e.message : String(e)}`, "TIMING_UNREADABLE", 2);
    }
    const rows = parseCsv(text.replace(/^﻿/, ""));
    if (rows.length > 0 && rows[0].join(",") !== TIMING_HEADER.join(",")) {
      throw new ReportError(`baris pertama ${file} bukan header 20 kolom protokol; berkas tidak diubah`, "TIMING_HEADER_MISMATCH", 2);
    }
    // run_id tertulis dalam bentuk ternetralisasi (#8), jadi dibandingkan dalam bentuk yang sama.
    const runIdCell = csvNeutralize(ctx.runId);
    const prior = rows.slice(1).filter((r) => r.length > 1 && r[0] === runIdCell).length;
    if (text !== "" && !/\n$/.test(text)) {
      throw new ReportError(`berkas timing ${file} tidak diakhiri baris baru; berkas tidak diubah`, "TIMING_HEADER_MISMATCH", 2);
    }
    return new TimingSink(file, ctx, fsx, rows.length === 0, prior + 1);
  }

  add(e: TimingEvent): void {
    this.events.push(e);
  }

  /** Tambahkan semua baris (append-only) dalam satu tulis. */
  flush(): number {
    if (this.events.length === 0) return 0;
    const lines = this.events.map((e) => timingRow(this.ctx, this.nextSeq++, e));
    const data = `${this.needsHeader ? `${TIMING_HEADER.join(",")}\n` : ""}${lines.join("\n")}\n`;
    try {
      this.fsx.appendFileSync(this.file, data);
    } catch (e) {
      throw new ReportError(`tidak dapat menulis berkas timing ${this.file}: ${e instanceof Error ? e.message : String(e)}`, "TIMING_UNWRITABLE", 2);
    }
    const n = this.events.length;
    this.events = [];
    return n;
  }
}

// ── Klien HTTP (badan hanya di memori; `./_http-client`) ─────────────────

interface CallResult {
  status: number;
  headers: HttpResponseLike["headers"];
  body: unknown;
  bytes?: Buffer;
  correlationId?: string;
}

/** Pointer pertama dari badan galat `{ error, code, details }` (details = isu[] / { issues } / { pointer }). */
export function firstPointer(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const d = body.details;
  const fromList = (l: unknown): string | undefined => (Array.isArray(l) && isRecord(l[0]) && typeof l[0].pointer === "string" ? l[0].pointer : undefined);
  return fromList(d) ?? (isRecord(d) ? (fromList(d.issues) ?? (typeof d.pointer === "string" ? d.pointer : undefined)) : undefined) ?? fromList(body.issues);
}

export class StudioClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: HttpFetch,
    private readonly timing: TimingSink | null,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Satu panggilan lewat klien bersama (pengalihan `manual`: rahasia tidak diteruskan); galat HTTP
   * dipetakan `httpFailureOf` ke {@link ReportError} (badan galat tidak pernah memuat rahasia).
   */
  async call(
    method: "GET" | "POST" | "HEAD",
    routePath: string,
    opts: { json?: unknown; binary?: boolean; label: string; target: string; step: string; note?: string; okStatuses?: number[] },
  ): Promise<CallResult> {
    const action = `${method} ${opts.label}`;
    const t0 = this.now();
    let reply: HttpReply;
    try {
      reply = await studioRequest({ baseUrl: this.baseUrl, secret: this.secret, fetchImpl: this.fetchImpl, redirect: "manual" }, method, routePath, {
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        binary: opts.binary,
        okStatuses: opts.okStatuses,
      });
    } catch (e) {
      if (!(e instanceof StudioUnreachableError)) throw e;
      this.timing?.add({ kind: "api", action, target: opts.target, tStart: t0, tEnd: this.now(), ok: false, errCode: e.code, note: opts.note });
      throw new ReportError(e.message, e.code, 2, { step: opts.step });
    }
    const t1 = this.now();
    const failure = reply.ok ? null : httpFailureOf(reply, action);
    const { correlationId, bytes } = reply;
    this.timing?.add({
      kind: "api",
      action,
      target: opts.target,
      httpStatus: reply.status,
      correlationId,
      tStart: t0,
      tEnd: t1,
      ok: reply.ok,
      errCode: failure?.code,
      ...(bytes ? { bytes: bytes.length, sha16: sha256Hex(bytes).slice(0, 16) } : {}),
      note: opts.note,
    });
    if (failure === null) return { status: reply.status, headers: reply.headers, body: reply.body, bytes, correlationId };
    const info: ReportErrorInfo = {
      httpStatus: failure.httpStatus,
      correlationId: failure.correlationId,
      pointer: firstPointer(reply.body),
      step: opts.step,
      ...(failure.details !== undefined ? { details: failure.details } : {}),
    };
    throw new ReportError(failure.message, failure.code, failure.environmental ? 2 : 1, info);
  }
}

export function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

// ── Rencana kiriman ─────────────────────────────────────────────────────

const ROUTE_OF: Record<string, StudioRouteId> = { "studio.slot/v2": "R13", "studio.chapter/v2": "R12", "studio.doc/v2": "R04" };

export interface StepResult {
  block: number;
  schema: string;
  /** `record`, `bab 1`, atau `dokumen`. */
  part: string;
  route: string;
  status: number | null;
  revisionNo: number | null;
  created: boolean;
  unchanged: boolean;
  /** update: tidak dikirim karena isi sama dengan basis, atau di luar `--section`. */
  skipped: boolean;
  /**
   * update: alasan tidak dikirim (`unchanged` = sama dengan basis/terkini; `section` = di luar `--section`;
   * `stale` = R3-F #1: tidak Anda ubah sejak basis, tetapi diubah pihak lain sesudahnya -> isi terkini dipertahankan).
   */
  skipReason?: "unchanged" | "section" | "stale";
  correlationId: string | null;
}

function partOf(v: Record<string, unknown>): string {
  if (v.$schema === "studio.slot/v2") return typeof v.slot === "string" ? v.slot : "slot";
  if (v.$schema === "studio.chapter/v2") return isRecord(v.chapter) && typeof v.chapter.key === "string" ? `bab ${v.chapter.key}` : "bab";
  return "dokumen";
}

/** Ganti folder misi target blok (bab/slot `target.mission`, doc `mission`). */
function withMission(v: Record<string, unknown>, folder: string): Record<string, unknown> {
  if (v.$schema === "studio.doc/v2") return isRecord(v.mission) ? { ...v, mission: { ...v.mission, folder } } : v;
  const t = v.target;
  if (!isRecord(t) || !isRecord(t.mission)) return v;
  return { ...v, target: { ...t, mission: { ...t.mission, folder } } };
}

/** R3-01: ganti docKey target blok bertarget misi (bab/slot `target.docKey`, doc `docKey`). */
function withDocKey(v: Record<string, unknown>, docKey: string): Record<string, unknown> {
  if (v.$schema === "studio.doc/v2") return { ...v, docKey };
  const t = v.target;
  if (!isRecord(t) || !isRecord(t.mission)) return v;
  return { ...v, target: { ...t, docKey } };
}

/** `--mission` lalu `--doc-key` (submit). */
function withTargetOverrides(v: Record<string, unknown>, args: Pick<CliArgs, "mission" | "docKey">): Record<string, unknown> {
  let out = v;
  if (args.mission !== null) out = withMission(out, args.mission);
  if (args.docKey !== null) out = withDocKey(out, args.docKey);
  return out;
}

/** Target `{ documentId }` menggantikan target misi/nomor (bab/slot saja). */
function withDocumentTarget(v: Record<string, unknown>, documentId: string): Record<string, unknown> {
  return { ...v, target: { documentId } };
}

/** Perbandingan struktural tanpa urutan kunci; medan `id` (pid) diabaikan (satu implementasi: md-report). */
export function sameContent(a: unknown, b: unknown): boolean {
  return sameStructure(a, b);
}

/** Isi basis R20 untuk blok bab/slot (null = tidak ada di basis). */
export function baseContentFor(v: Record<string, unknown>, resolved: unknown): unknown {
  if (!isRecord(resolved) || !isRecord(resolved.sections)) return null;
  if (v.$schema === "studio.slot/v2") return typeof v.slot === "string" ? (resolved.sections[v.slot] ?? null) : null;
  if (v.$schema === "studio.chapter/v2" && isRecord(v.chapter)) {
    const key = v.chapter.key;
    const slots = typeof v.slot === "string" ? [resolved.sections[v.slot]] : Object.values(resolved.sections);
    for (const s of slots) {
      if (isRecord(s) && Array.isArray(s.chapters)) {
        const hit = s.chapters.find((c) => isRecord(c) && c.key === key);
        if (hit !== undefined) return hit;
      }
    }
  }
  return null;
}

function draftPayloadOf(v: Record<string, unknown>): unknown {
  return v.$schema === "studio.slot/v2" ? v.payload : v.chapter;
}

// ── Perintah ────────────────────────────────────────────────────────────

export interface CliArgs {
  command: "submit" | "update";
  documentId: string | null;
  file: string;
  remote: string | null;
  agentId: string | null;
  mission: string | null;
  /** R3-01: docKey target (submit). */
  docKey: string | null;
  /** R3-01: format masukan; null = deteksi otomatis. */
  format: "md" | "json" | null;
  /** R3-01 (update): bagian yang dikirim saja (`record`, `references`, kunci bab). */
  sections: string[] | null;
  /** R3-F #1 (update): revisi dasar eksplisit (menang atas baris `basis:` kepala). */
  baseRev: number | null;
  /** R3-F #1 (update): tanpa basis, bandingkan dengan revisi terkini (tercatat). */
  forceLatest: boolean;
  /** R3-F2 N4 (update): izinkan butir/bukti/rujukan record yang tidak ada di laporan ikut terhapus. */
  allowRemove?: boolean;
  out: string | null;
  timing: string | null;
  step: string | null;
  requireComplete: boolean;
  /** D-427: izinkan target misi/docKey contoh registri. */
  allowExample: boolean;
  json: boolean;
}

const usageErr = (m: string) => new ReportError(m, "USAGE_ERROR", 2);

/** R3-01 (U-18): `template` tidak memerlukan server, rahasia, maupun berkas. */
export interface TemplateArgs {
  command: "template";
  mission: string | null;
  docKey: string | null;
  format: "md" | "json";
  json: boolean;
}

const SECTION_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DOC_KEY_RE = new RegExp(DOC_KEY_PATTERN);

/**
 * R3-F2 N1: `refresh` mengambil versi server terkini (GET saja), menggabungkan per bagian terhadap basis
 * laporan, dan menulis laporan gabungan ke stdout / `--out-md`; berkas agen hanya ditulis dengan `--write`.
 */
export interface RefreshArgs {
  command: "refresh";
  documentId: string;
  file: string;
  remote: string | null;
  agentId: string | null;
  baseRev: number | null;
  outMd: string | null;
  write: boolean;
  json: boolean;
}

/** D-441: `check` hanya membaca berkas dan (opsional) dry-run R08; tidak pernah membuat/mengirim/menulis. */
export interface CheckArgs {
  command: "check";
  file: string;
  /** Hanya `--remote` eksplisit memicu jaringan (env HQ_URL tidak dipakai). */
  remote: string | null;
  agentId: string | null;
  mission: string | null;
  docKey: string | null;
  format: "md" | "json" | null;
  allowExample: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs | TemplateArgs | CheckArgs | RefreshArgs | "help" {
  if (argv.some((a) => a === "-h" || a === "--help")) return "help";
  const pos: string[] = [];
  const v: Record<string, string> = {};
  let requireComplete = false;
  let allowExample = false;
  let forceLatest = false;
  let json = false;
  let write = false;
  let allowRemove = false;
  const valued = new Set(["--remote", "--agent-id", "--mission", "--doc-key", "--format", "--section", "--base-rev", "--out", "--timing", "--step", "--out-md"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--write") write = true;
    else if (a === "--allow-remove") allowRemove = true;
    else if (a === "--require-complete") requireComplete = true;
    else if (a === "--allow-example") allowExample = true;
    else if (a === "--force-latest") forceLatest = true;
    else if (valued.has(a)) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) throw usageErr(`${a} memerlukan nilai`);
      if (a in v) throw usageErr(`${a} diberikan lebih dari sekali`);
      v[a] = val;
      i++;
    } else if (a.startsWith("--")) throw usageErr(`opsi tidak dikenal: ${a}`);
    else pos.push(a);
  }
  const command = pos[0];
  const format = v["--format"] ?? null;
  if (format !== null && format !== "md" && format !== "json") throw usageErr(`--format harus md atau json (diberikan "${format}")`);
  const docKey = v["--doc-key"] ?? null;
  if (docKey !== null && !DOC_KEY_RE.test(docKey)) throw usageErr(`--doc-key tidak sah: "${docKey}" (pola ${DOC_KEY_PATTERN})`);
  const baseRevOf = (): number | null => {
    if (v["--base-rev"] === undefined) return null;
    if (!/^[1-9][0-9]{0,5}$/.test(v["--base-rev"])) throw usageErr(`--base-rev harus bilangan bulat positif (diberikan "${v["--base-rev"]}")`);
    return Number(v["--base-rev"]);
  };
  if (command !== "refresh" && (write || v["--out-md"] !== undefined)) throw usageErr(`${write ? "--write" : "--out-md"} hanya berlaku untuk refresh`);
  if (command !== "update" && allowRemove) throw usageErr("--allow-remove hanya berlaku untuk update");
  if (command === "refresh") {
    if (pos.length < 3) throw usageErr("refresh memerlukan <documentId> dan <laporan.md>");
    if (pos.length > 3) throw usageErr(`argumen tidak terduga: ${pos[3]}`);
    const extra = ["--mission", "--doc-key", "--format", "--section", "--out", "--timing", "--step"].find((k) => k in v);
    const flag = requireComplete ? "--require-complete" : allowExample ? "--allow-example" : forceLatest ? "--force-latest" : undefined;
    if (extra !== undefined || flag !== undefined) throw usageErr(`${extra ?? flag} tidak berlaku untuk refresh`);
    if (write && v["--out-md"] !== undefined) throw usageErr("--write dan --out-md tidak boleh dipakai bersama");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(pos[1])) throw usageErr(`documentId tidak sah: "${pos[1]}"`);
    const agentId = v["--agent-id"] ?? null;
    if (agentId !== null && (agentId.length < 1 || agentId.length > 80)) throw usageErr("--agent-id harus 1..80 karakter");
    return { command, documentId: pos[1], file: pos[2], remote: v["--remote"] ?? null, agentId, baseRev: baseRevOf(), outMd: v["--out-md"] ?? null, write, json };
  }
  if (command === "template") {
    if (pos.length > 1) throw usageErr(`argumen tidak terduga: ${pos[1]}`);
    const extra = ["--remote", "--agent-id", "--section", "--base-rev", "--out", "--timing", "--step"].find((k) => k in v);
    const flag = requireComplete ? "--require-complete" : allowExample ? "--allow-example" : forceLatest ? "--force-latest" : undefined;
    if (extra !== undefined || flag !== undefined) throw usageErr(`${extra ?? flag} tidak berlaku untuk template`);
    return { command, mission: v["--mission"] ?? null, docKey, format: format ?? "md", json };
  }
  if (command === "check") {
    // D-441: hanya baca; opsi yang menulis atau mengirim tidak berlaku.
    if (pos.length < 2) throw usageErr("check memerlukan <laporan.md>");
    if (pos.length > 2) throw usageErr(`argumen tidak terduga: ${pos[2]}`);
    const extra = ["--section", "--base-rev", "--out", "--timing", "--step"].find((k) => k in v);
    const flag = requireComplete ? "--require-complete" : forceLatest ? "--force-latest" : undefined;
    if (extra !== undefined || flag !== undefined) throw usageErr(`${extra ?? flag} tidak berlaku untuk check`);
    const agentId = v["--agent-id"] ?? null;
    if (agentId !== null && (agentId.length < 1 || agentId.length > 80)) throw usageErr("--agent-id harus 1..80 karakter");
    return { command, file: pos[1], remote: v["--remote"] ?? null, agentId, mission: v["--mission"] ?? null, docKey, format, allowExample, json };
  }
  if (command !== "submit" && command !== "update") throw usageErr(command === undefined ? "perintah belum diberikan (submit, update, refresh, template, atau check)" : `perintah tidak dikenal: ${command}`);
  const need = command === "submit" ? 2 : 3;
  if (pos.length < need) throw usageErr(command === "submit" ? "berkas <draf.md> belum diberikan" : "update memerlukan <documentId> dan <draf.md>");
  if (pos.length > need) throw usageErr(`argumen tidak terduga: ${pos[need]}`);
  const agentId = v["--agent-id"] ?? null;
  if (agentId !== null && (agentId.length < 1 || agentId.length > 80)) throw usageErr("--agent-id harus 1..80 karakter");
  if (command === "update" && v["--mission"] !== undefined) throw usageErr("--mission hanya berlaku untuk submit");
  if (command === "update" && docKey !== null) throw usageErr("--doc-key hanya berlaku untuk submit");
  if (command === "submit" && v["--section"] !== undefined) throw usageErr("--section hanya berlaku untuk update");
  if (command === "submit" && (v["--base-rev"] !== undefined || forceLatest)) throw usageErr(`${forceLatest ? "--force-latest" : "--base-rev"} hanya berlaku untuk update`);
  const baseRev = baseRevOf();
  if (baseRev !== null && forceLatest) throw usageErr("--base-rev dan --force-latest tidak boleh dipakai bersama");
  let sections: string[] | null = null;
  if (v["--section"] !== undefined) {
    sections = v["--section"].split(",").map((s) => s.trim()).filter((s) => s !== "");
    const bad = sections.find((s) => !SECTION_RE.test(s));
    if (sections.length === 0 || bad !== undefined) throw usageErr(`--section tidak sah: "${v["--section"]}" (record, references, atau kunci bab; pisahkan dengan koma)`);
  }
  const documentId = command === "update" ? pos[1] : null;
  if (documentId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(documentId)) throw usageErr(`documentId tidak sah: "${documentId}"`);
  return {
    command,
    documentId,
    file: command === "submit" ? pos[1] : pos[2],
    remote: v["--remote"] ?? null,
    agentId,
    mission: v["--mission"] ?? null,
    docKey,
    format,
    sections,
    baseRev,
    forceLatest,
    allowRemove,
    out: v["--out"] ?? null,
    timing: v["--timing"] ?? null,
    step: v["--step"] ?? null,
    requireComplete,
    allowExample,
    json,
  };
}

export interface RenderInfo {
  fileId: string;
  format: string;
  finalFileName: string;
  bytes: number;
  sha256: string;
  sha16: string;
  verified: boolean;
  savedTo: string | null;
}

export interface ReportResult {
  ok: true;
  command: "submit" | "update";
  documentId: string;
  docNumber: string | null;
  revisionNo: number | null;
  completeness: { status: string; missingRequired: unknown[] };
  steps: StepResult[];
  render: RenderInfo | null;
  /** Mengapa render dilewati (dokumen belum lengkap). */
  renderSkipped: string | null;
  /** R3-01: format masukan yang dipakai. */
  format: "md" | "json";
  /** R3-01: laporan konversi MD-native (null untuk draf ber-blok json). */
  conversion: MdReportConversion | null;
  /** R3-01 (U-16, update): bagian yang dikirim vs tidak dikirim (`stale` hanya bila ada, R3-F #1). */
  delta: { sent: string[]; unchanged: string[]; excluded: string[]; stale?: string[] } | null;
  /** R3-F #1 (update): dasar perbandingan yang dipakai. */
  basis: BasisInfo | null;
  /**
   * R3-F #1: baris basis untuk disalin agen ke kepala laporan (`basis: <id>@rev<n>`), atau null bila
   * salinan agen belum setara dengan revisi terkini (alasan di `nextBasisNote`).
   */
  nextBasis: string | null;
  nextBasisNote: string | null;
  /**
   * R3-F #1: bagian yang diubah pihak lain sesudah basis dan tidak Anda ubah (tidak dikirim). R3-F2 N2:
   * `markdown` = isi terkini lossless untuk DIBACA; penyalinan dilakukan `refresh`, bukan manual.
   */
  refresh: Array<{ part: string; markdown: string[] }>;
  /** R3-F2 N1: semua bagian yang diubah pihak lain sejak basis (update). */
  changedByOthers: string[];
  /** R3-F #4 (update): bagian yang ada di dokumen tetapi tidak ada di laporan (tidak dihapus). */
  notInReport: string[];
  /** Pemberitahuan (judul tidak diperbarui, agentId ditimpa, butir daftar, basis diabaikan, ...). */
  notices: string[];
  timingRows: number;
  wallSeconds: number;
}

// ── Masukan MD-native (R3-01, U-15) ──────────────────────────────────────

const DRAFT_SCHEMAS: ReadonlySet<string> = new Set(DRAFT_ACCEPTED_SCHEMAS);

/** Draf ber-blok json = ada blok ```json dengan `$schema` C57; selain itu laporan MD-native. */
export function detectFormat(markdown: string): "md" | "json" {
  return extractDraft(markdown).blocks.some((b) => b.schema !== null && DRAFT_SCHEMAS.has(b.schema)) ? "json" : "md";
}

export interface PreparedInput {
  format: "md" | "json";
  /** Draf ber-blok json (berkas asli, atau hasil konversi di memori). */
  draft: string;
  draftBytes: number;
  conversion: MdReportConversion | null;
}

/** R3-F #1: dasar perbandingan update. */
export interface BasisInfo {
  /** `basis` = tiga arah terhadap revisi n; `force-latest` = terkini (tercatat); `latest-unchecked` = draf json tanpa basis (perilaku lama). */
  mode: "basis" | "force-latest" | "latest-unchecked";
  /** n (mode basis) atau revisi terkini. */
  revisionNo: number | null;
  /** Asal n: `--base-rev` atau baris `basis:` kepala. */
  source: "--base-rev" | "kepala" | null;
  /** Revisi terkini dokumen saat dibaca. */
  latestRevisionNo: number | null;
}

/**
 * Laporan MD-native -> draf ber-blok json di memori (tanpa berkas), lewat `services/draft/md-report`.
 * Galat konversi = galat isi (keluar 1), sebelum kiriman pertama; peringatan CW ikut di `details`.
 */
export function prepareInput(
  args: Pick<CliArgs, "command" | "documentId" | "format" | "mission" | "docKey"> & { agentId?: string | null },
  markdown: string,
  bytes: number,
): PreparedInput {
  const format = args.format ?? detectFormat(markdown);
  try {
    if (format === "json") {
      // R3-F #2: templat json yang belum diisi ditolak dengan pesan yang sama dengan jalur MD.
      assertNoPlaceholders(markdown);
      return { format, draft: markdown, draftBytes: bytes, conversion: null };
    }
    const { blocks, conversion } = mdReportToBlocks(markdown, {
      mode: args.command === "submit" ? "create" : "update",
      mission: args.mission,
      docKey: args.docKey,
      agentId: args.agentId ?? null,
      ...(args.documentId !== null ? { documentId: args.documentId } : {}),
    });
    const draft = blocksToDraftMarkdown(conversion.title, blocks, { basis: conversion.basis });
    return { format, draft, draftBytes: Buffer.byteLength(draft, "utf8"), conversion };
  } catch (e) {
    if (e instanceof MdReportError) {
      const d = e.details;
      throw new ReportError(e.message, e.code, 1, {
        step: format === "md" ? "konversi MD" : "cek templat",
        ...(d.missing || d.warnings || d.lines ? { details: { ...(d.missing ? { missing: d.missing } : {}), ...(d.lines ? { lines: d.lines } : {}), warnings: d.warnings ?? [] } } : {}),
      });
    }
    throw e;
  }
}

/**
 * R3-F #1: dasar update dari `--base-rev`, baris `basis:` kepala (MD: md-report; json: C56 draf),
 * atau `--force-latest`. Laporan MD tanpa basis -> `BASIS_MISSING` (keluar 1, sebelum jaringan); draf
 * json tanpa basis memakai perilaku lama (terkini) dengan pemberitahuan. Basis milik dokumen lain ->
 * `BASIS_DOCUMENT_MISMATCH` (keluar 2; juga menangkap documentId salah ketik, #13).
 */
export function resolveBasis(args: CliArgs, input: PreparedInput): { basis: BasisInfo | null; notices: string[] } {
  let header: { documentId: string; revisionNo: number } | null;
  if (input.conversion) {
    const b = input.conversion.basis;
    header = b && b.kind === "revision" ? { documentId: b.documentId, revisionNo: b.revisionNo } : null;
  } else header = draftBasisRevision(extractDraft(input.draft));
  const notices: string[] = [];
  if (args.command === "submit") {
    if (header !== null) notices.push(`baris basis ${header.documentId}@rev${header.revisionNo} diabaikan oleh submit (submit menarget dokumen lewat mission + docKey); untuk dokumen yang sudah ada pakai update`);
    return { basis: null, notices };
  }
  const documentId = args.documentId as string;
  if (header !== null && header.documentId !== documentId) {
    throw new ReportError(
      `baris basis menunjuk dokumen ${header.documentId}, bukan ${documentId}; periksa documentId perintah (salah ketik?) atau salin baris basis dokumen ini. Tidak ada yang dikirim`,
      "BASIS_DOCUMENT_MISMATCH",
      2,
      { step: "basis" },
    );
  }
  if (args.baseRev !== null) {
    if (header !== null && header.revisionNo !== args.baseRev) notices.push(`--base-rev ${args.baseRev} menggantikan baris basis kepala rev${header.revisionNo}`);
    return { basis: { mode: "basis", revisionNo: args.baseRev, source: "--base-rev", latestRevisionNo: null }, notices };
  }
  if (header !== null) {
    // R3-F2 N6: niat eksplisit operator tidak diabaikan diam-diam.
    if (args.forceLatest) notices.push(`--force-latest diabaikan: kepala laporan memuat baris basis rev${header.revisionNo} (perbandingan tiga arah tetap dipakai; hapus baris basis bila memang ingin --force-latest)`);
    return { basis: { mode: "basis", revisionNo: header.revisionNo, source: "kepala", latestRevisionNo: null }, notices };
  }
  if (args.forceLatest) {
    notices.push("--force-latest: dibandingkan dengan revisi terkini, bukan dengan revisi salinan Anda; perubahan pihak lain pada bagian yang berbeda di laporan DAPAT tertimpa");
    return { basis: { mode: "force-latest", revisionNo: null, source: null, latestRevisionNo: null }, notices };
  }
  if (input.format === "md") {
    throw new ReportError(
      `laporan tidak memuat baris basis; update membandingkan suntingan Anda dengan revisi yang terakhir Anda lihat agar perubahan pihak lain tidak tertimpa. Tulis baris "basis: ${documentId}@rev<n>" di kepala (salin dari keluaran submit/update terakhir) atau berikan --base-rev <n>; --force-latest hanya bila Anda yakin tidak ada penulis lain. Tidak ada yang dikirim`,
      "BASIS_MISSING",
      1,
      { step: "basis" },
    );
  }
  notices.push('draf json tanpa basis (basis: baru): dibandingkan dengan revisi terkini; tulis "basis: <documentId>@rev<n>" di kepala draf agar perubahan pihak lain terdeteksi');
  return { basis: { mode: "latest-unchecked", revisionNo: null, source: null, latestRevisionNo: null }, notices };
}

interface Ctx {
  args: CliArgs;
  client: StudioClient;
  fsx: FsLike;
  timing: TimingSink | null;
  now: () => number;
}

function readDraft(file: string, fsx: FsLike): { markdown: string; bytes: number } {
  let raw: Buffer;
  try {
    raw = fsx.readFileSyncBuffer ? fsx.readFileSyncBuffer(file) : fs.readFileSync(file);
  } catch (e) {
    throw new ReportError(`tidak dapat membaca ${file}: ${e instanceof Error ? e.message : String(e)}`, "FILE_UNREADABLE", 2);
  }
  return { markdown: raw.toString("utf8"), bytes: raw.length };
}

/** Batas C54 + cek lokal `draft-check` (skema v2, kontrak); isu galat pertama -> galat isi (1). */
function checkLocally(markdown: string, bytes: number): ExtractedDraftBlock[] {
  const limit = checkDraftLimits(markdown, { bodyBytes: bytes });
  if (limit !== null) throw new ReportError(`${limit}: ${draftLimitMessage(limit)}`, "PAYLOAD_TOO_LARGE", 1, { details: { reason: limit } });
  const local: DraftCheckResultV2 = checkDraftLocal(markdown);
  if (!local.valid) {
    const top = local.issues.find((i) => i.severity === "error");
    if (top) throw new ReportError(`draf tidak lolos cek lokal: ${top.message}${top.line !== undefined ? ` (baris ${top.line})` : ""}`, top.code, 1, { step: "draft-check" });
    const bad = local.blocks.find((b) => !b.valid);
    const issue = bad && isRecord(bad.issues[0]) ? bad.issues[0] : undefined;
    throw new ReportError(
      `blok ${bad?.index} (baris ${bad?.line}) tidak lolos cek lokal: ${issue && typeof issue.message === "string" ? issue.message : "tidak valid"}; jalankan draft-check untuk rinciannya`,
      issue && typeof issue.keyword === "string" ? issue.keyword : "DRAFT_INVALID",
      1,
      { step: `blok ${bad?.index}`, ...(issue && typeof issue.pointer === "string" ? { pointer: issue.pointer } : {}) },
    );
  }
  return extractDraft(markdown).blocks;
}

// ── Penjaga target contoh registri (D-427) ─────────────────────────────

/** Folder misi + docKey yang ditulis badan kiriman (bab/slot: `target`; doc: tingkat atas). */
function missionTargetOf(v: Record<string, unknown>): { folder: string | null; docKey: string | null } {
  const holder = v.$schema === "studio.doc/v2" ? v : isRecord(v.target) ? v.target : {};
  const folder = isRecord(holder.mission) && typeof holder.mission.folder === "string" ? holder.mission.folder : null;
  return { folder, docKey: typeof holder.docKey === "string" ? holder.docKey : null };
}

/**
 * Folder misi dan docKey yang dipakai contoh registri `items[].examples` (R03 `kind=contracts`),
 * dibaca dari modul registri murni `CONTRACT_KIND_DEFS` (bukan disalin), sehingga penjaga ikut
 * berubah bila contoh berubah.
 */
export function registryExampleTargets(): { folders: ReadonlySet<string>; docKeys: ReadonlySet<string> } {
  const folders = new Set<string>();
  const docKeys = new Set<string>();
  for (const def of CONTRACT_KIND_DEFS) {
    const ex = def.examples as unknown;
    if (!isRecord(ex)) continue;
    const bodies = [ex.record, ...(isRecord(ex.chapters) ? Object.values(ex.chapters) : [])];
    for (const b of bodies) {
      if (!isRecord(b)) continue;
      const t = missionTargetOf(b);
      if (t.folder !== null) folders.add(t.folder);
      if (t.docKey !== null) docKeys.add(t.docKey);
    }
  }
  return { folders, docKeys };
}

/**
 * D-427: tolak (keluar 2, sebelum kiriman pertama) blok yang menarget misi ATAU docKey contoh
 * registri, kecuali `--allow-example`. Pada submit, `--mission` diterapkan lebih dulu (folder efektif).
 */
function guardExampleTargets(args: Pick<CliArgs, "allowExample" | "command" | "mission" | "docKey">, blocks: ExtractedDraftBlock[]): void {
  if (args.allowExample) return;
  const { folders, docKeys } = registryExampleTargets();
  blocks.forEach((b, i) => {
    let value = b.value as Record<string, unknown>;
    if (args.command === "submit") value = withTargetOverrides(value, args);
    const t = missionTargetOf(value);
    const hits = [
      ...(t.folder !== null && folders.has(t.folder) ? [`misi "${t.folder}"`] : []),
      ...(t.docKey !== null && docKeys.has(t.docKey) ? [`docKey "${t.docKey}"`] : []),
    ];
    if (hits.length === 0) return;
    throw new ReportError(
      `blok ${i + 1} menarget ${hits.join(" dan ")} milik contoh registri; ganti dengan folder misi dan docKey laporan Anda sendiri (atau --mission <folder>), atau tambahkan --allow-example bila memang disengaja. Tidak ada yang dikirim`,
      "EXAMPLE_TARGET",
      2,
      { step: `blok ${i + 1}` },
    );
  });
}

function docOf(body: unknown): { id: string; docNumber: string | null } | null {
  const d = isRecord(body) && isRecord(body.document) ? body.document : null;
  return d && typeof d.id === "string" ? { id: d.id, docNumber: typeof d.docNumber === "string" ? d.docNumber : null } : null;
}

async function sendBlock(ctx: Ctx, index: number, value: Record<string, unknown>, documentHint: string | null): Promise<{ step: StepResult; doc: { id: string; docNumber: string | null } | null }> {
  const schema = String(value.$schema);
  const routeId = ROUTE_OF[schema];
  const route = studioRoutePath(routeId);
  const part = partOf(value);
  const r = await ctx.client.call("POST", route, { json: value, label: route, target: documentHint ?? routeId, step: `blok ${index} (${part})`, note: `blok ${index} ${part}` });
  const body = r.body;
  const revisionNo = isRecord(body) && isRecord(body.revision) && typeof body.revision.revisionNo === "number" ? body.revision.revisionNo : null;
  return {
    doc: docOf(body),
    step: {
      block: index,
      schema,
      part,
      route: `POST ${route}`,
      status: r.status,
      revisionNo,
      created: isRecord(body) && body.created === true,
      unchanged: isRecord(body) && body.unchanged === true,
      skipped: false,
      correlationId: r.correlationId ?? null,
    },
  };
}

const stepLabel = (s: StepResult): string => `blok ${s.block} (${s.part})`;

/**
 * Kemajuan yang sudah tersimpan (R2-F2 #5). `remaining` = masih ada blok yang belum terkirim.
 * null bila belum ada blok yang tersimpan (tidak ada yang perlu dilanjutkan) atau dokumen tidak dikenal.
 */
function progressOf(
  ctx: Ctx,
  doc: { id: string; docNumber: string | null } | null,
  steps: StepResult[],
  e: ReportError,
  remaining: boolean,
): ReportProgress | null {
  const sent = steps.filter((s) => !s.skipped);
  if (doc === null || (remaining && sent.length === 0)) return null;
  const revisionNo = [...steps].reverse().find((s) => s.revisionNo !== null)?.revisionNo ?? null;
  const file = ctx.args.file;
  const rerun = ctx.args.command === "submit" ? `studio-report submit ${file}` : `studio-report update ${doc.id} ${file}`;
  // R3-F #1: update dilanjutkan dengan baris basis yang SAMA (bagian yang sudah tersimpan = sama dengan
  // terkini -> dilewati; bagian yang diubah pihak lain -> BASE_CONFLICT, tidak ditimpa).
  const conflict = e.code === "SCOPE_CONFLICT" || e.code === "BASE_CONFLICT" ? "bagian itu diubah pihak lain di tengah kiriman: " : "";
  const resume =
    ctx.args.command === "update"
      ? remaining
        ? `${conflict}perbaiki penyebabnya lalu jalankan ulang "${rerun}" dengan baris basis yang SAMA (jangan ganti basis): bagian yang sudah tersimpan dilewati, bagian yang diubah pihak lain dilaporkan BASE_CONFLICT beserta isi terkininya`
        : `semua blok sudah tersimpan; jalankan ulang "${rerun}" dengan baris basis yang sama untuk kelengkapan, render, verifikasi, dan baris basis berikutnya`
      : remaining
        ? `perbaiki penyebabnya lalu jalankan ulang "${rerun}" dengan opsi yang sama (idempoten: blok yang sudah tersimpan dijawab unchanged atau dilewati), atau "studio-report update ${doc.id} ${file}" dengan baris "basis: ${doc.id}@rev${revisionNo ?? "<n>"}" di kepala`
        : `semua blok sudah tersimpan; jalankan ulang "${rerun}" dengan opsi yang sama untuk kelengkapan, render, dan verifikasi`;
  return {
    documentId: doc.id,
    docNumber: doc.docNumber,
    revisionNo,
    completedSteps: sent.map(stepLabel),
    failedStep: e.info.step ?? "-",
    allBlocksSent: !remaining,
    resume,
  };
}

/** Galat blok sesudah ada blok yang tersimpan -> galat yang sama (kode keluar tetap) + `progress`; selain itu apa adanya. */
function interrupted(ctx: Ctx, e: unknown, doc: { id: string; docNumber: string | null } | null, steps: StepResult[]): unknown {
  if (!(e instanceof ReportError) || e.info.progress !== undefined) return e;
  const progress = progressOf(ctx, doc, steps, e, true);
  return progress === null ? e : new ReportError(e.message, e.code, e.exitCode, { ...e.info, progress });
}

/** Satu blok rencana kiriman `submit` (MCP-D4): badan sesudah agentId bawaan dan `--mission`/`--doc-key`. */
export interface SubmitPlanItem {
  /** Indeks blok (1-based). */
  index: number;
  /** Badan yang dikirim (target dokumen buatan blok sebelumnya belum diterapkan, lihat `sourceBlock`). */
  value: Record<string, unknown>;
  /** Indeks blok buat-dokumen sebelumnya yang ditarget blok ini (dikirim ke documentId hasil blok itu), atau null. */
  sourceBlock: number | null;
}

/** Rencana kiriman `submit`: satu sumber untuk {@link runSubmit} dan kait `CliIo.beforeSubmit`. */
export function submitPlanOf(args: Pick<CliArgs, "agentId" | "mission" | "docKey">, blocks: readonly ExtractedDraftBlock[], markdown: string): SubmitPlanItem[] {
  const sources = sequentialCreateSources(extractDraft(markdown));
  return blocks.map((b, i) => ({
    index: i + 1,
    value: withTargetOverrides(dryRunInputOf(b, args.agentId ?? undefined).value, args),
    sourceBlock: sources.get(i + 1) ?? null,
  }));
}

async function runSubmit(ctx: Ctx, blocks: ExtractedDraftBlock[], plan: readonly SubmitPlanItem[]): Promise<{ documentId: string; docNumber: string | null; steps: StepResult[] }> {
  const createdDoc = new Map<number, string>();
  const steps: StepResult[] = [];
  let primary: { id: string; docNumber: string | null } | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const index = i + 1;
    let value = plan[i].value;
    const src = plan[i].sourceBlock ?? undefined;
    const target = src !== undefined ? createdDoc.get(src) : undefined;
    if (target !== undefined) value = withDocumentTarget(value, target);
    let sent: Awaited<ReturnType<typeof sendBlock>>;
    try {
      sent = await sendBlock(ctx, index, value, target ?? primary?.id ?? null);
    } catch (e) {
      throw interrupted(ctx, e, primary, steps);
    }
    const { step, doc } = sent;
    steps.push(step);
    if (doc !== null) {
      primary ??= doc;
      if (draftCreateTargetOf(blocks[i].value as Record<string, unknown>) !== null) createdDoc.set(index, doc.id);
    }
  }
  if (primary === null) throw new ReportError("server tidak mengembalikan document.id untuk kiriman mana pun", "REMOTE_BAD_RESPONSE", 2);
  return { documentId: primary.id, docNumber: primary.docNumber, steps };
}

/** `--section` cocok: slot (`record`, `references`) atau kunci bab (`3`, juga `bab3`/`bab-3`). */
export function sectionMatches(v: Record<string, unknown>, section: string): boolean {
  const s = section.toLowerCase();
  if (v.$schema === "studio.slot/v2") return typeof v.slot === "string" && v.slot.toLowerCase() === s;
  if (v.$schema === "studio.chapter/v2" && isRecord(v.chapter) && typeof v.chapter.key === "string") {
    const key = v.chapter.key.toLowerCase();
    return s === key || s === `bab${key}` || s === `bab-${key}` || s === `bab_${key}`;
  }
  return false;
}

/** `--section` yang tidak cocok dengan bagian mana pun -> galat pemakaian sebelum kiriman pertama. */
function assertSectionsKnown(args: CliArgs, values: ReadonlyArray<Record<string, unknown>>): void {
  if (args.sections === null) return;
  const unknown = args.sections.filter((s) => !values.some((v) => sectionMatches(v, s)));
  if (unknown.length > 0) {
    throw new ReportError(`--section ${unknown.join(", ")} tidak cocok dengan bagian mana pun di laporan (${values.map(partOf).join(", ")}). Tidak ada yang dikirim`, "SECTION_UNKNOWN", 2, {
      step: "--section",
    });
  }
}

/** Teks judul inline (string, `{ text }`, `{ runs }` dengan run `{ t }`; R3-F2 N5: satu ekstraktor bersama). */
const inlineTextOf = plainTextOf;

/** Semua bab dokumen (semua slot berulang) dari proyeksi R20. */
function chaptersOf(resolved: unknown): Array<Record<string, unknown>> {
  if (!isRecord(resolved) || !isRecord(resolved.sections)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const s of Object.values(resolved.sections)) if (isRecord(s) && Array.isArray(s.chapters)) out.push(...s.chapters.filter(isRecord));
  return out;
}

/**
 * R3-F #5: bab tambahan laporan MD (judul `##` tanpa alias; kunci generator = 6 + urutan kemunculan)
 * dicocokkan ke bab dokumen menurut judul ternormalisasi, bukan urutan, sehingga menghapus/menyisipkan
 * judul tidak menggeser isi ke kunci lain. Judul baru -> kunci berikutnya sesudah kunci tertinggi dokumen.
 */
export function remapExtraChapters(values: Array<Record<string, unknown>>, current: unknown): Array<Record<string, unknown>> {
  const def = getContractKindDef(MD_REPORT_DEFAULT_KIND);
  const outline = new Set((def?.outline ?? []).map((o) => o.chapterKey));
  const docExtras = chaptersOf(current).filter((c) => typeof c.key === "string" && !outline.has(c.key));
  const numeric = (k: unknown) => (typeof k === "string" && /^[0-9]+$/.test(k) ? Number(k) : 0);
  let next = Math.max(5, ...chaptersOf(current).map((c) => numeric(c.key))) + 1;
  const used = new Map<string, string>();
  return values.map((v) => {
    if (v.$schema !== "studio.chapter/v2" || !isRecord(v.chapter) || typeof v.chapter.key !== "string" || outline.has(v.chapter.key)) return v;
    const title = inlineTextOf(v.chapter.title);
    const norm = normalizeHeading(title);
    // R3-F2 N5: kunci stabil = judul polos ternormalisasi; judul kosong tidak pernah dicocokkan (tanpa AMBIGUOUS palsu).
    const hits = norm === "" ? [] : docExtras.filter((c) => normalizeHeading(inlineTextOf(c.title)) === norm);
    if (hits.length > 1) {
      throw new ReportError(
        `judul "${title}" dipakai ${hits.length} bab di dokumen (${hits.map((c) => `bab ${String(c.key)}`).join(", ")}); bab tambahan dicocokkan menurut judul, jadi tidak dapat dipilih. Ganti judul di dokumen lewat PATCH /structure atau kirim JSON ber-kunci. Tidak ada yang dikirim`,
        "CHAPTER_TITLE_AMBIGUOUS",
        1,
        { step: "pemetaan bab" },
      );
    }
    const key = hits.length === 1 ? String(hits[0].key) : String(next++);
    if (used.has(key)) {
      throw new ReportError(`judul ## "${title}" muncul lebih dari sekali di laporan (bab ${key}); gabungkan atau ganti salah satu judul. Tidak ada yang dikirim`, "CHAPTER_TITLE_AMBIGUOUS", 1, { step: "pemetaan bab" });
    }
    used.set(key, title);
    return key === v.chapter.key ? v : { ...v, chapter: { ...v.chapter, key } };
  });
}

/** Medan record yang dapat ditulis dari laporan MD (kepala + tabel butir + bagian Rujukan). */
const MD_RECORD_FIELDS: ReadonlySet<string> = new Set(["type", "status", "verdict", "owner", "initiator", "taskRef", "reportedAt", "cardIds", "items", "evidence", "refs"]);

/** Elemen record yang dihapus laporan secara eksplisit (`~~hapus~~`) atau semuanya diizinkan (`--allow-remove`). */
interface RemovalPolicy {
  items: readonly string[];
  refs: ReadonlyArray<{ rel: string; documentId: string }>;
  allowAll: boolean;
}

const removalPolicyOf = (conversion: MdReportConversion | null, allowAll: boolean): RemovalPolicy => ({
  items: conversion?.removals.items ?? [],
  refs: conversion?.removals.refs ?? [],
  allowAll,
});

const recordsOf = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter(isRecord) : []);
const evidenceItemOf = (e: Record<string, unknown>): string => (typeof e.item === "string" ? e.item : "");
const refTargetOf = (r: Record<string, unknown>): string => String(r.documentId ?? r.docNumber ?? "");

/**
 * R3-F #3: record update MENGGANTI payload utuh. Data terstruktur yang ada di dokumen tetapi tidak
 * dihasilkan laporan (items/evidence/refs, atau medan yang tidak dapat ditulis lewat MD seperti
 * due/phase) akan terhapus -> tolak sebelum kiriman pertama (tidak ada yang dikirim). Medan kepala
 * yang dihapus agen (mis. Verdict) = suntingan sah, tidak ditolak. R3-F2 N4: items/evidence/refs yang
 * SEMUA elemennya dihapus eksplisit (`~~hapus~~`) atau `--allow-remove` tidak dihitung di sini
 * (ditangani per elemen oleh {@link assertRecordKeepsElements}).
 */
function assertRecordKeepsData(mine: unknown, current: unknown, conversion: MdReportConversion | null, policy: RemovalPolicy = removalPolicyOf(conversion, false)): void {
  if (!isRecord(mine) || !isRecord(current)) return;
  const allRemoved = (k: string): boolean => {
    if (policy.allowAll) return k === "items" || k === "evidence" || k === "refs";
    if (k === "items") return recordsOf(current.items).every((i) => policy.items.includes(String(i.key)));
    if (k === "evidence") return recordsOf(current.evidence).every((e) => evidenceItemOf(e) !== "" && policy.items.includes(evidenceItemOf(e)));
    if (k === "refs") return recordsOf(current.refs).every((r) => policy.refs.some((x) => x.rel === r.rel && x.documentId === refTargetOf(r)));
    return false;
  };
  const lost = Object.keys(current).filter(
    (k) => current[k] !== undefined && mine[k] === undefined && (k === "items" || k === "evidence" || k === "refs" || (conversion !== null && !MD_RECORD_FIELDS.has(k))) && !allRemoved(k),
  );
  if (lost.length === 0) return;
  const listHint = conversion?.notices.some((n) => n.code === "MD_REPORT_ITEMS_AS_LIST") ? " Butir kerja Anda tampak ditulis sebagai daftar: tulis sebagai tabel." : "";
  throw new ReportError(
    `record di dokumen memuat ${lost.join(", ")} yang tidak dihasilkan laporan; mengirim record akan menghapusnya (record diganti utuh). Butir kerja = tabel "| key | judul | status |" (kolom bukti -> evidence), rujukan = tabel di bagian ## Rujukan; medan lain hanya lewat draf json. Atau kirim bagian lain saja dengan --section.${listHint} Tidak ada yang dikirim`,
    "RECORD_FIELDS_DROPPED",
    1,
    { step: "blok record", details: { lost } },
  );
}

/**
 * R3-F2 N4: penghapusan PER ELEMEN. Butir (kunci), bukti (per butir), dan rujukan (hubungan + dokumen)
 * yang ada di record dokumen tetapi tidak ada di laporan hanya boleh hilang bila baris tabelnya
 * ditandai `~~hapus~~` atau `--allow-remove` diberikan; selain itu tolak (keluar 1, tidak ada yang
 * dikirim) dengan daftar elemen yang akan hilang + alasan baris ditolak (peringatan CW).
 */
function assertRecordKeepsElements(mine: unknown, current: unknown, conversion: MdReportConversion | null, policy: RemovalPolicy): string[] {
  if (!isRecord(mine) || !isRecord(current)) return [];
  const notices: string[] = [];
  const mineItems = new Set(recordsOf(mine.items).map((i) => String(i.key)));
  const curItems = recordsOf(current.items).map((i) => String(i.key));
  const lostItems = curItems.filter((k) => !mineItems.has(k) && !policy.items.includes(k));
  const mineEvidenceItems = new Set(recordsOf(mine.evidence).map(evidenceItemOf));
  const lostEvidence = recordsOf(current.evidence)
    .filter((e) => !mineEvidenceItems.has(evidenceItemOf(e)) && !(evidenceItemOf(e) !== "" && policy.items.includes(evidenceItemOf(e))))
    .map((e) => `${String(e.ref)}${evidenceItemOf(e) !== "" ? ` (butir ${evidenceItemOf(e)})` : ""}`);
  const mineRefs = recordsOf(mine.refs);
  const lostRefs = recordsOf(current.refs)
    .filter((r) => !mineRefs.some((m) => m.rel === r.rel && refTargetOf(m) === refTargetOf(r)) && !policy.refs.some((x) => x.rel === r.rel && x.documentId === refTargetOf(r)))
    .map((r) => `${String(r.rel)} ${refTargetOf(r)}`);
  for (const k of policy.items) if (!curItems.includes(k)) notices.push(`baris ~~hapus~~ butir ${k}: butir itu tidak ada di record dokumen (tidak ada yang dihapus)`);
  const lost = [...lostItems.map((k) => `butir ${k}`), ...lostEvidence.map((e) => `bukti ${e}`), ...lostRefs.map((r) => `rujukan ${r}`)];
  if (lost.length === 0) return notices;
  if (policy.allowAll) return [...notices, `--allow-remove: ${lost.join(", ")} dihapus dari record`];
  // Alasan baris tabel ditolak konversi (status majemuk / tanpa alias / kunci tidak sah), bila ada.
  const why = (conversion?.warnings ?? [])
    .filter((w) => isRecord(w.details) && w.details.scope === "item" && lostItems.includes(String(w.details.key)))
    .map((w) => `baris ${w.line}: ${w.message}`);
  throw new ReportError(
    `record di dokumen memuat ${lost.join(", ")} yang tidak ada di laporan; mengirim record akan menghapusnya.${why.length > 0 ? ` Baris tabel yang ditolak konversi: ${why.join("; ")}.` : ""} Perbaiki barisnya (status butir satu nilai ber-alias, mis. done/running/todo), atau bila memang ingin menghapus: tulis ~~hapus~~ di sel status baris itu (butir + buktinya) / di baris Rujukan, atau berikan --allow-remove. Tidak ada yang dikirim`,
    "RECORD_ELEMENTS_DROPPED",
    1,
    { step: "blok record", details: { items: lostItems, evidence: lostEvidence, refs: lostRefs, rejectedRows: why } },
  );
}

/** Isi terkini satu bagian sebagai Markdown lossless (R3-F2 N2) untuk DIBACA; penyalinan = `refresh`. */
function refreshMarkdown(value: Record<string, unknown>, atNow: unknown): string[] {
  if (atNow === null || atNow === undefined) return ["(bagian ini tidak ada lagi di dokumen terkini)"];
  if (value.$schema === "studio.chapter/v2") return chapterToMarkdown(atNow);
  if (value.slot === "record") return recordToMarkdown(atNow);
  const ctx = newSerializeCtx();
  const md = referencesToReportMarkdown(atNow, ctx);
  return md !== null ? md.body.filter((l, i, a) => !(l === "" && i === a.length - 1)) : [`(slot ${String(value.slot)}: ${ctx.why ?? "tidak dapat ditulis lewat MD"}; lihat GET .../content)`];
}

/** Bagian dokumen (proyeksi R20) per nama bagian: `record`, `references`, `bab <kunci>`. */
export function partsOf(content: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (isRecord(content) && isRecord(content.sections)) {
    if (content.sections.record !== undefined && content.sections.record !== null) out.set("record", content.sections.record);
    if (content.sections.references !== undefined && content.sections.references !== null) out.set("references", content.sections.references);
  }
  for (const c of chaptersOf(content)) out.set(`bab ${String(c.key)}`, c);
  return out;
}

/** Penulis terakhir per bagian (R15: slot `lastFilledBy`/`lastFilledRevisionNo`, bab `present[].by/revisionNo`). */
type LastWriters = Map<string, { by: string | null; revisionNo: number | null }>;

/**
 * Penulis terakhir per bagian dari R15 kelengkapan revisi terkini (penulis = `agent:<agentId>`).
 * R3-F3 (15c R1/R3): HANYA untuk peringatan {@link sameAgentWarningsOf}; tidak pernah mengubah keputusan
 * kirim (penulis terakhir bukan "satu-satunya penulis sejak basis"). Gagal baca -> tanpa peringatan.
 */
async function lastWritersOf(ctx: Ctx, documentId: string, notices: string[]): Promise<LastWriters> {
  const out: LastWriters = new Map();
  try {
    const r15 = studioRoutePath("R15", { id: documentId });
    const got = await ctx.client.call("GET", r15, { label: "/api/studio/documents/{id}/completeness", target: documentId, step: "penulis terakhir R15", note: "penulis terakhir" });
    const comp = isRecord(got.body) && isRecord(got.body.completeness) ? got.body.completeness : null;
    for (const s of comp && Array.isArray(comp.slots) ? comp.slots.filter(isRecord) : []) {
      if (s.slotKey === "record" || s.slotKey === "references") {
        out.set(String(s.slotKey), { by: typeof s.lastFilledBy === "string" ? s.lastFilledBy : null, revisionNo: typeof s.lastFilledRevisionNo === "number" ? s.lastFilledRevisionNo : null });
      }
    }
    const chapters = comp && isRecord(comp.chapters) ? Object.values(comp.chapters).filter(isRecord) : [];
    for (const c of chapters) {
      for (const p of Array.isArray(c.present) ? c.present.filter(isRecord) : []) {
        out.set(`bab ${String(p.key)}`, { by: typeof p.by === "string" ? p.by : null, revisionNo: typeof p.revisionNo === "number" ? p.revisionNo : null });
      }
    }
  } catch (e) {
    if (!(e instanceof ReportError)) throw e;
    notices.push(`penulis terakhir tidak terbaca (${e.code}); peringatan agentId sama dilewati (keputusan kirim tidak terpengaruh)`);
  }
  return out;
}

/**
 * R3-F3 (15c R3): bagian bentrok yang penulis terakhirnya ber-agentId SAMA dengan agentId sekarang tetapi
 * sesudah basis agen -> peringatan saja (tulisan Anda dari berkas lain, atau dua penulis ber-agentId sama).
 */
function sameAgentWarningsOf(writers: LastWriters, parts: readonly string[], agentId: string | null, basisRev: number, refreshCmd: string): string[] {
  if (agentId === null) return [];
  return parts.flatMap((part) => {
    const w = writers.get(part);
    if (w === undefined || w.by !== `${AGENT_FILLER_PREFIX}${agentId}` || w.revisionNo === null || w.revisionNo <= basisRev) return [];
    return [
      `${part}: penulis terakhir (rev${w.revisionNo}) memakai agentId Anda sendiri (${agentId}), padahal basis Anda rev${basisRev}. Bila itu tulisan Anda dari berkas lain, pakai berkas terbaru atau jalankan ${refreshCmd}; bila penulis lain memakai agentId yang sama, setiap penulis wajib memakai agentId berbeda (agentId sama tidak dapat dibedakan). Keputusan tidak berubah: bagian ini tetap konflik`,
    ];
  });
}

/** agentId penulis laporan ini: `--agent-id`, lalu kepala laporan MD, lalu blok pertama yang membawanya. */
function agentIdOf(ctx: Ctx, conversion: MdReportConversion | null, blocks: ExtractedDraftBlock[]): string | null {
  return ctx.args.agentId ?? conversion?.agentId ?? agentIdForRender(ctx, blocks) ?? null;
}

const sectionArgOf = (p: string): string => (p.startsWith("bab ") ? p.slice(4) : p);

/** Perintah refresh siap pakai untuk pesan (berkas agen tidak ditulis tanpa --write). */
export function refreshCommandOf(documentId: string, file: string): string {
  return `studio-report refresh ${documentId} ${file} --write   (menimpa ${path.basename(file)} dengan laporan gabungan + basis terkini; atau --out-md <laporan-segar.md>, lalu update HANYA berkas itu)`;
}

export interface UpdateOutcome {
  documentId: string;
  docNumber: string | null;
  steps: StepResult[];
  basis: BasisInfo;
  latestRevisionNo: number;
  refresh: Array<{ part: string; markdown: string[] }>;
  /** Bagian di luar `--section` yang berbeda dari dokumen (belum terkirim). */
  pending: string[];
  notInReport: string[];
  /** R3-F2 N1: semua bagian yang diubah pihak lain sejak basis (termasuk yang tidak ada di laporan). */
  changedByOthers: string[];
  notices: string[];
}

async function readContent(ctx: Ctx, documentId: string, rev: number | null): Promise<{ revisionNo: number; content: unknown; doc: { id: string; docNumber: string | null } | null }> {
  const r20 = studioRoutePath("R20", { id: documentId });
  const got = await ctx.client.call("GET", rev === null ? r20 : `${r20}?rev=${rev}`, {
    label: "/api/studio/documents/{id}/content",
    target: documentId,
    step: rev === null ? "basis R20" : `basis R20 rev${rev}`,
    note: rev === null ? "basis" : `basis rev${rev}`,
  });
  const revisionNo = isRecord(got.body) && typeof got.body.revisionNo === "number" ? got.body.revisionNo : null;
  if (revisionNo === null) throw new ReportError(`jawaban ${r20} tidak memuat revisionNo`, "REMOTE_BAD_RESPONSE", 2, { correlationId: got.correlationId });
  return { revisionNo, content: isRecord(got.body) ? got.body.content : null, doc: docOf(got.body) };
}

async function runUpdate(ctx: Ctx, documentId: string, blocks: ExtractedDraftBlock[], basisIn: BasisInfo, conversion: MdReportConversion | null): Promise<UpdateOutcome> {
  const now = await readContent(ctx, documentId, null);
  const latest = now.revisionNo;
  const doc = now.doc ?? { id: documentId, docNumber: null };
  const notices: string[] = [];
  let basisRev = latest;
  let atBaseDoc = now.content;
  if (basisIn.mode === "basis") {
    basisRev = basisIn.revisionNo as number;
    if (basisRev > latest) {
      throw new ReportError(`basis rev${basisRev} melampaui revisi terkini dokumen (rev${latest}); periksa baris basis. Tidak ada yang dikirim`, "BASIS_INVALID", 1, { step: "basis" });
    }
    if (basisRev < latest) atBaseDoc = (await readContent(ctx, documentId, basisRev)).content;
  }
  const basis: BasisInfo = { ...basisIn, revisionNo: basisRev, latestRevisionNo: latest };

  // #13: mission/docKey kepala harus milik dokumen ini (bila proyeksi memuatnya).
  if (conversion !== null && isRecord(now.content)) {
    const folder = isRecord(now.content.mission) && typeof now.content.mission.folder === "string" ? now.content.mission.folder : null;
    const key = typeof now.content.docKey === "string" ? now.content.docKey : null;
    const bad = [
      ...(conversion.mission !== null && folder !== null && conversion.mission !== folder ? [`mission "${conversion.mission}" (dokumen: "${folder}")`] : []),
      ...(conversion.docKey !== null && key !== null && conversion.docKey !== key ? [`docKey "${conversion.docKey}" (dokumen: "${key}")`] : []),
    ];
    if (bad.length > 0) throw new ReportError(`kepala laporan ${bad.join(" dan ")} bukan milik dokumen ${documentId}; periksa documentId perintah. Tidak ada yang dikirim`, "DOCUMENT_MISMATCH", 2, { step: "basis" });
  }
  // #10: judul tidak diperbarui update (tanpa META_CONFLICT); beri tahu bila berbeda.
  if (conversion !== null && isRecord(now.content) && isRecord(now.content.meta) && typeof now.content.meta.title === "string" && now.content.meta.title.trim() !== conversion.title.trim()) {
    notices.push(`judul laporan "${conversion.title}" berbeda dari judul dokumen "${now.content.meta.title}": update TIDAK memperbarui judul (pakai PATCH /api/studio/documents/{id}/structure setMeta)`);
  }

  let values = blocks.map((b, i) => {
    const v = dryRunInputOf(b, ctx.args.agentId ?? undefined).value;
    if (v.$schema === "studio.doc/v2") {
      throw new ReportError(`blok ${i + 1} studio.doc/v2 tidak didukung update; kirim perubahan sebagai blok bab atau slot`, "UPDATE_DOC_BLOCK_UNSUPPORTED", 1, { step: `blok ${i + 1}` });
    }
    return withDocumentTarget(v, documentId);
  });
  if (conversion !== null) values = remapExtraChapters(values, now.content);
  assertSectionsKnown(ctx.args, values);

  // #4: bagian di dokumen yang tidak ada di laporan (tidak dihapus).
  const reportKeys = new Set(values.filter((v) => v.$schema === "studio.chapter/v2" && isRecord(v.chapter)).map((v) => String((v.chapter as Record<string, unknown>).key)));
  const notInReport = chaptersOf(now.content)
    .filter((c) => !reportKeys.has(String(c.key)))
    .map((c) => `bab ${String(c.key)}${inlineTextOf(c.title) !== "" ? ` (${inlineTextOf(c.title)})` : ""}`);
  if (isRecord(now.content) && isRecord(now.content.sections) && now.content.sections.references !== undefined && now.content.sections.references !== null && !values.some((v) => v.slot === "references")) {
    notInReport.push("references");
  }

  // Penulis terakhir per bagian hanya dibaca bila ada calon konflik (bagian yang Anda ubah DAN berubah
  // sesudah basis), dan hanya untuk peringatan agentId sama (R3-F3; tidak mengubah keputusan kirim).
  const agentId = agentIdOf(ctx, conversion, blocks);
  const candidate = (value: Record<string, unknown>): boolean => {
    const mine = draftPayloadOf(value);
    const atNow = baseContentFor(value, now.content);
    const atBase = basis.mode === "basis" ? baseContentFor(value, atBaseDoc) : atNow;
    return !sameContent(atBase, atNow) && !sameContent(mine, atNow) && !sameContent(mine, atBase);
  };
  const writers: LastWriters = basis.mode === "basis" && basisRev < latest && agentId !== null && values.some(candidate) ? await lastWritersOf(ctx, documentId, notices) : new Map();

  // Rencana: keputusan per bagian SEBELUM kiriman pertama (konflik/penghapusan = tidak ada yang dikirim).
  type Plan = { index: number; value: Record<string, unknown>; part: string; action: "send" | "unchanged" | "section" | "stale" | "conflict"; atNow: unknown; sameNow: boolean };
  const plans: Plan[] = values.map((value, i) => {
    const part = partOf(value);
    const mine = draftPayloadOf(value);
    const atNow = baseContentFor(value, now.content);
    const atBase = basis.mode === "basis" ? baseContentFor(value, atBaseDoc) : atNow;
    const sameNow = sameContent(mine, atNow);
    // R3-F3 (15c R1): tanpa pengecualian tulisan sendiri; bagian yang berubah sesudah basis = konflik.
    const baseNow = sameContent(atBase, atNow);
    const sections = ctx.args.sections;
    let action: Plan["action"];
    if (sections !== null && !sections.some((s) => sectionMatches(value, s))) action = "section";
    else if (sections !== null) action = !baseNow && !sameNow ? "conflict" : "send"; // --section: dikirim walau sama (server menjawab unchanged)
    else if (sameNow) action = "unchanged";
    else if (sameContent(mine, atBase)) action = "stale"; // tidak Anda ubah; pihak lain mengubahnya sesudah basis
    else action = baseNow ? "send" : "conflict";
    return { index: i + 1, value, part, action, atNow, sameNow };
  });

  // R3-F2 N1: SEMUA bagian yang diubah sejak basis (bukan hanya yang bentrok), termasuk bagian yang
  // tidak ada di laporan (R3-F3: termasuk tulisan agentId yang sama; penulis tidak dapat dibuktikan).
  const changedByOthers: string[] = [];
  if (basis.mode === "basis" && basisRev < latest) {
    const atBaseParts = partsOf(atBaseDoc);
    const atNowParts = partsOf(now.content);
    for (const part of new Set([...atBaseParts.keys(), ...atNowParts.keys()])) {
      if (!sameContent(atBaseParts.get(part) ?? null, atNowParts.get(part) ?? null)) changedByOthers.push(part);
    }
  }

  const conflicts = plans.filter((p) => p.action === "conflict");
  if (conflicts.length > 0) {
    const sendable = plans.filter((p) => p.action === "send").map((p) => p.part);
    const refresh = conflicts.map((p) => ({ part: p.part, markdown: refreshMarkdown(p.value, p.atNow) }));
    const others = changedByOthers.length > 0 ? changedByOthers : conflicts.map((p) => p.part);
    const sameAgentWarnings = sameAgentWarningsOf(writers, conflicts.map((p) => p.part), agentId, basisRev, refreshCommandOf(documentId, ctx.args.file));
    throw new ReportError(
      `sejak basis rev${basisRev} (terkini rev${latest}) pihak lain mengubah: ${others.join(", ")}. Bertumpang dengan suntingan Anda: ${conflicts.map((p) => p.part).join(", ")}. Tidak ada yang dikirim (bagian yang bertumpang tidak pernah ditimpa). Pulihkan TANPA menyalin manual: jalankan ${refreshCommandOf(documentId, ctx.args.file)} — refresh mengambil versi server, mempertahankan bagian yang hanya Anda ubah, mengambil bagian yang diubah pihak lain, menandai bagian yang diubah keduanya dengan penanda <<<<<<< ======= >>>>>>> (gabungkan, hapus penanda), dan menulis baris basis: ${documentId}@rev${latest}; lalu jalankan update lagi dengan berkas hasil refresh.${sendable.length > 0 ? ` Bagian yang tidak bersinggungan (${sendable.join(", ")}) dapat dikirim sekarang dengan --section ${sendable.map(sectionArgOf).join(",")} (basis lama dipertahankan sampai refresh).` : ""}${sameAgentWarnings.length > 0 ? ` Peringatan: ${sameAgentWarnings.join("; ")}.` : ""}`,
      "BASE_CONFLICT",
      1,
      { step: "basis", details: { basisRevisionNo: basisRev, latestRevisionNo: latest, changedByOthers: others, conflicts: conflicts.map((p) => p.part), sendable, refreshCommand: refreshCommandOf(documentId, ctx.args.file), refresh, sameAgentWarnings } },
    );
  }
  const record = plans.find((p) => p.action === "send" && p.value.slot === "record");
  if (record) {
    const policy = removalPolicyOf(conversion, ctx.args.allowRemove === true);
    assertRecordKeepsData(draftPayloadOf(record.value), record.atNow, conversion, policy);
    notices.push(...assertRecordKeepsElements(draftPayloadOf(record.value), record.atNow, conversion, policy));
  } else if ((conversion?.removals.items.length ?? 0) > 0 || (conversion?.removals.refs.length ?? 0) > 0) {
    notices.push("baris ~~hapus~~ ada di laporan, tetapi record tidak dikirim (tidak berubah atau di luar --section): tidak ada yang dihapus");
  }

  const steps: StepResult[] = [];
  const refresh: Array<{ part: string; markdown: string[] }> = [];
  for (const p of plans) {
    // R3-F3 (15c R1): SELALU basis agen; cek lingkup §9.2 server menjadi wasit (409 -> BASE_CONFLICT di bawah).
    const value = p.value.baseRevisionNo === undefined ? { ...p.value, baseRevisionNo: basisRev } : p.value;
    if (p.action !== "send") {
      const skipReason = p.action === "section" ? "section" : p.action === "stale" ? "stale" : "unchanged";
      if (p.action === "stale") refresh.push({ part: p.part, markdown: refreshMarkdown(p.value, p.atNow) });
      steps.push({ block: p.index, schema: String(value.$schema), part: p.part, route: "-", status: null, revisionNo: latest, created: false, unchanged: skipReason !== "section", skipped: true, skipReason, correlationId: null });
      continue;
    }
    try {
      steps.push((await sendBlock(ctx, p.index, value, documentId)).step);
    } catch (e) {
      if (e instanceof ReportError && e.code === "SCOPE_CONFLICT") {
        // R3-F3: server menolak basis lama untuk bagian ini (penulis lain menyela sesudah pembacaan, atau
        // basis laporan lebih lama dari tulisan terakhir bagian itu). Tidak ada yang ditimpa.
        const refreshCommand = refreshCommandOf(documentId, ctx.args.file);
        const conflict = new ReportError(
          `${p.part}: server menolak kiriman karena bagian itu berubah sesudah basis rev${basisRev} (409 SCOPE_CONFLICT); tidak ditimpa. Pulihkan: jalankan ${refreshCommand}, selesaikan penanda <<<<<<< ======= >>>>>>> bila ada, lalu jalankan update lagi dengan berkas hasil refresh`,
          "BASE_CONFLICT",
          1,
          { ...e.info, details: { serverCode: "SCOPE_CONFLICT", part: p.part, basisRevisionNo: basisRev, refreshCommand, server: e.info.details } },
        );
        throw interrupted(ctx, conflict, doc, steps);
      }
      throw interrupted(ctx, e, doc, steps);
    }
  }
  // Bagian di luar --section yang berbeda dari dokumen: belum terkirim, jadi basis baru belum aman.
  const pending = plans.filter((p) => p.action === "section" && !p.sameNow).map((p) => p.part);
  return { documentId, docNumber: doc.docNumber, steps, basis, latestRevisionNo: latest, refresh, pending, notInReport, changedByOthers, notices };
}

/**
 * R3-F #1: baris basis berikutnya untuk disalin agen. Aman hanya bila salinan agen setara dengan
 * revisi akhir: tidak ada bagian `stale`, dan revisi kiriman berurutan sejak revisi yang dibaca (tidak
 * ada penulis lain di sela kiriman).
 */
export function nextBasisOf(
  documentId: string,
  steps: readonly StepResult[],
  /** Revisi yang dibaca sebelum kiriman (update); null = submit (mulai dari kiriman pertama). */
  startRev: number | null,
  staleParts: readonly string[],
  /** Bagian di luar `--section` yang berbeda dari dokumen (belum terkirim). */
  pendingParts: readonly string[] = [],
  /** Perintah refresh untuk pesan (R3-F2 N1). */
  refreshHint: string | null = null,
): { line: string | null; note: string | null } {
  const refreshCmd = refreshHint ?? `studio-report refresh ${documentId} <laporan.md> --out-md <laporan-segar.md>`;
  if (staleParts.length > 0) {
    return {
      line: null,
      note: `salinan Anda tertinggal untuk ${staleParts.join(", ")} (diubah pihak lain; tidak dikirim, suntingan mereka tetap). Jangan salin manual: jalankan ${refreshCmd} — refresh mengambil bagian itu dari server dan menulis baris basis terbaru otomatis`,
    };
  }
  if (pendingParts.length > 0) {
    return {
      line: null,
      note: `${pendingParts.join(", ")} di laporan berbeda dari dokumen dan tidak dikirim (di luar --section); kirim bagian itu, atau jalankan ${refreshCmd} untuk menggabungkan dan memperbarui baris basis`,
    };
  }
  let rev = startRev;
  for (const s of steps) {
    if (s.skipped || s.revisionNo === null) continue;
    if (rev === null) {
      rev = s.unchanged ? s.revisionNo : s.revisionNo - 1;
      if (s.unchanged) continue;
    }
    if (s.unchanged && s.revisionNo === rev) continue;
    if (s.revisionNo !== rev + 1) {
      return { line: null, note: `revisi lain tersimpan di sela kiriman (rev${rev} -> rev${s.revisionNo}); jalankan update sekali lagi dengan baris basis lama untuk melihat bagian yang perlu disegarkan` };
    }
    rev = s.revisionNo;
  }
  return { line: `basis: ${documentId}@rev${rev}`, note: null };
}

function agentIdForRender(ctx: Ctx, blocks: ExtractedDraftBlock[]): string | undefined {
  if (ctx.args.agentId !== null) return ctx.args.agentId;
  for (const b of blocks) if (isRecord(b.value) && typeof b.value.agentId === "string") return b.value.agentId;
  return undefined;
}

const FINAL_FILENAME_RE = new RegExp(FINAL_FILENAME_PATTERN);

/**
 * Nama final boleh disimpan `--out` hanya bila lolos C51 `FINAL_FILENAME_PATTERN` (satu sumber
 * kebenaran dengan server; R2-F2 #9) dan merupakan nama berkas tunggal (tanpa pemisah path).
 */
export function safeFinalName(name: string): boolean {
  return FINAL_FILENAME_RE.test(name) && path.basename(name) === name;
}

async function renderAndVerify(ctx: Ctx, documentId: string, agentId: string | undefined): Promise<{ render: RenderInfo; revisionNo: number | null }> {
  const r17 = studioRoutePath("R17", { id: documentId });
  const rendered = await ctx.client.call("POST", r17, {
    json: { ...(agentId !== undefined ? { agentId } : {}), scope: "document" },
    label: "/api/studio/documents/{id}/render",
    target: documentId,
    step: "render R17",
    note: "render",
  });
  const outputs = isRecord(rendered.body) && Array.isArray(rendered.body.outputs) ? rendered.body.outputs.filter(isRecord) : [];
  const primaryOut =
    outputs.find((o) => o.role === "PRIMARY" && o.format === "HTML" && (!isRecord(o.scope) || o.scope.kind === "DOCUMENT")) ?? outputs.find((o) => o.role === "PRIMARY") ?? outputs[0];
  if (!primaryOut || typeof primaryOut.id !== "string") {
    throw new ReportError("render tidak menghasilkan berkas utama", "RENDER_NO_OUTPUT", 1, { correlationId: rendered.correlationId, step: "render R17", details: isRecord(rendered.body) ? rendered.body.errors : undefined });
  }
  const job = isRecord(rendered.body) && isRecord(rendered.body.job) ? rendered.body.job : null;
  const revisionNo = job && typeof job.revisionNo === "number" ? job.revisionNo : null;
  const fileId = primaryOut.id;
  const r10 = studioRoutePath("R10", { id: fileId });
  const dl = await ctx.client.call("GET", r10, { binary: true, label: "/api/studio/files/{id}", target: fileId, step: "unduh R10", note: "unduh" });
  const bytes = dl.bytes ?? Buffer.alloc(0);
  const sha = sha256Hex(bytes);
  const finalFileName = dl.headers.get("x-studio-final-filename") ?? (typeof primaryOut.finalFileName === "string" ? primaryOut.finalFileName : "");
  const expected = [dl.headers.get("x-studio-sha256"), typeof primaryOut.sha256 === "string" ? primaryOut.sha256 : null].filter((s): s is string => s !== null && s !== "");
  if (expected.some((s) => s.toLowerCase() !== sha)) {
    throw new ReportError(`sha256 berkas unduhan (${sha.slice(0, 16)}) tidak cocok dengan catatan server (${expected[0].slice(0, 16)})`, "SHA_MISMATCH", 1, { correlationId: dl.correlationId, step: "unduh R10" });
  }
  const head = await ctx.client.call("HEAD", `${r10}?verify=1`, { label: "/api/studio/files/{id}?verify=1", target: fileId, step: "verifikasi R10", note: "verify" });
  const verified = head.headers.get("x-studio-sha256-verified") === "true";
  const headName = head.headers.get("x-studio-final-filename");
  if (!verified) throw new ReportError("server melaporkan X-Studio-Sha256-Verified bukan true (isi disk berbeda dari catatan)", "VERIFY_FAILED", 1, { correlationId: head.correlationId, step: "verifikasi R10" });
  if (finalFileName === "" || (headName !== null && headName !== finalFileName)) {
    throw new ReportError(`nama final tidak konsisten (unduh "${finalFileName}", verify "${headName ?? "-"}")`, "VERIFY_FAILED", 1, { correlationId: head.correlationId, step: "verifikasi R10" });
  }

  let savedTo: string | null = null;
  if (ctx.args.out !== null) savedTo = saveFinal(ctx, finalFileName, bytes, sha);
  return {
    revisionNo,
    render: { fileId, format: String(primaryOut.format ?? "HTML"), finalFileName, bytes: bytes.length, sha256: sha, sha16: sha.slice(0, 16), verified, savedTo },
  };
}

function saveFinal(ctx: Ctx, finalFileName: string, bytes: Buffer, sha: string): string {
  const dir = ctx.args.out as string;
  if (!safeFinalName(finalFileName)) {
    throw new ReportError(
      `nama final dari server tidak cocok dengan pola nama final C51 (<docNumberSafe>_rev<n>_<YYYYMMDDTHHMMSSZ>_<sha8>.<ext>); berkas tidak disimpan: "${finalFileName}"`,
      "OUT_NAME_UNSAFE",
      2,
      { step: "simpan" },
    );
  }
  const dest = path.join(dir, finalFileName);
  const t0 = ctx.now();
  try {
    ctx.fsx.mkdirSync(dir, { recursive: true });
    ctx.fsx.writeFileSync(dest, bytes, { flag: "wx" });
  } catch (e) {
    const exists = isRecord(e) && e.code === "EEXIST";
    if (!(exists && ctx.fsx.readFileSyncBuffer && sha256Hex(ctx.fsx.readFileSyncBuffer(dest)) === sha)) {
      throw new ReportError(
        exists ? `${dest} sudah ada dengan isi berbeda; tidak ditimpa` : `tidak dapat menyimpan ${dest}: ${e instanceof Error ? e.message : String(e)}`,
        exists ? "OUT_EXISTS" : "OUT_UNWRITABLE",
        2,
        { step: "simpan" },
      );
    }
  }
  ctx.timing?.add({ kind: "edit", action: "save", target: finalFileName, tStart: t0, tEnd: ctx.now(), ok: true, bytes: bytes.length, sha16: sha.slice(0, 16) });
  return dest;
}

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl?: HttpFetch;
  fs?: FsLike;
  now?: () => number;
  /**
   * MCP-D4 (D-484, M-2): kait opsional host (adaptor MCP) yang dipanggil `submit` sesudah cek lokal, EXAMPLE_TARGET,
   * dan basis, tepat sebelum kiriman pertama, dengan rencana kiriman yang SAMA dengan yang dikirim. Melempar = tidak
   * ada yang dikirim. CLI tidak mengisinya (perilaku CLI tidak berubah).
   */
  beforeSubmit?: (plan: readonly SubmitPlanItem[]) => Promise<void>;
}

/** fs nyata: hanya baca draf/timing, tambah timing, tulis berkas final --out, dan (refresh) --out-md / --write. */
export const REAL_FS: FsLike = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  appendFileSync: (p, d) => fs.appendFileSync(p, d, "utf8"),
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  writeFileSync: (p, d, o) => fs.writeFileSync(p, d, o),
  readFileSyncBuffer: (p) => fs.readFileSync(p),
  writeFileText: (p, d) => {
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, d, "utf8");
    fs.renameSync(tmp, p);
  },
};

function timingContext(args: CliArgs, env: CliIo["env"]): TimingContext {
  const pick = (k: string, d: string) => {
    const s = env[k];
    return s === undefined || s === "" ? d : s;
  };
  return {
    runId: pick("STUDIO_TIMING_RUN_ID", "-"),
    arm: pick("STUDIO_TIMING_ARM", "B"),
    reportId: pick("STUDIO_TIMING_REPORT_ID", "-"),
    order: pick("STUDIO_TIMING_ORDER", ""),
    sessionId: pick("STUDIO_TIMING_SESSION_ID", "-"),
    stepId: args.step ?? args.command,
  };
}

/** Jalankan satu perintah; galat dilempar sebagai {@link ReportError}. */
export async function runReport(args: CliArgs, io: CliIo): Promise<ReportResult> {
  const fsx = io.fs ?? REAL_FS;
  const now = io.now ?? Date.now;
  const t0 = now();
  const secret = io.env.INTERNAL_API_SECRET ?? "";
  if (secret === "") throw new ReportError("env INTERNAL_API_SECRET belum diisi", "SECRET_MISSING", 2);
  const rawUrl = args.remote ?? io.env.HQ_URL ?? "";
  if (rawUrl === "") throw usageErr("berikan --remote <url> atau env HQ_URL");
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawUrl);
  } catch (e) {
    throw usageErr(e instanceof Error ? e.message : String(e));
  }
  const { markdown, bytes } = readDraft(args.file, fsx);
  const timing = args.timing !== null ? TimingSink.open(args.timing, timingContext(args, io.env), fsx) : null;
  const client = new StudioClient(baseUrl, secret, io.fetchImpl ?? (globalThis.fetch as unknown as HttpFetch), timing, now);
  const ctx: Ctx = { args, client, fsx, timing, now };
  let result: ReportResult | null = null;
  let toolOk = false;
  let toolErr: string | undefined;
  let docForTiming = "-";
  let basisMode: BasisInfo["mode"] | null = null;
  let sent: Awaited<ReturnType<typeof runSubmit>> | null = null;
  try {
    const input = prepareInput(args, markdown, bytes);
    let blocks: ExtractedDraftBlock[];
    try {
      blocks = checkLocally(input.draft, input.draftBytes);
    } catch (e) {
      // Hasil konversi MD tidak lolos cek lokal: sebut asalnya (isi laporan, bukan draf yang ditulis agen).
      if (input.format === "md" && e instanceof ReportError) throw new ReportError(`hasil konversi laporan MD tidak lolos cek lokal: ${e.message}`, e.code, e.exitCode, { ...e.info, step: e.info.step ?? "konversi MD" });
      throw e;
    }
    guardExampleTargets(args, blocks);
    const resolvedBasis = resolveBasis(args, input);
    basisMode = resolvedBasis.basis?.mode ?? null;
    const notices = [...(input.conversion?.notices.map((n) => `${n.code}${n.line !== undefined ? ` baris ${n.line}` : ""}: ${n.message}`) ?? []), ...resolvedBasis.notices];
    let upd: UpdateOutcome | null = null;
    if (args.command === "submit") {
      const plan = submitPlanOf(args, blocks, input.draft);
      if (io.beforeSubmit) await io.beforeSubmit(plan);
      sent = await runSubmit(ctx, blocks, plan);
    }
    else {
      upd = await runUpdate(ctx, args.documentId as string, blocks, resolvedBasis.basis as BasisInfo, input.conversion);
      sent = upd;
      notices.push(...upd.notices);
    }
    docForTiming = sent.documentId;
    const r15 = studioRoutePath("R15", { id: sent.documentId });
    const comp = await client.call("GET", r15, { label: "/api/studio/documents/{id}/completeness", target: sent.documentId, step: "kelengkapan R15", note: "kelengkapan" });
    const report = isRecord(comp.body) && isRecord(comp.body.completeness) ? comp.body.completeness : null;
    const completeness = {
      status: report && typeof report.status === "string" ? report.status : "UNKNOWN",
      missingRequired: report && Array.isArray(report.missingRequired) ? report.missingRequired : [],
    };
    const lastRev = [...sent.steps].reverse().find((s) => s.revisionNo !== null)?.revisionNo ?? null;
    let render: RenderInfo | null = null;
    let renderSkipped: string | null = null;
    let revisionNo = report && typeof report.revisionNo === "number" ? report.revisionNo : lastRev;
    if (completeness.status !== "COMPLETE") {
      if (args.requireComplete) {
        throw new ReportError(`dokumen ${sent.documentId} belum lengkap (${completeness.status}); kurang: ${completeness.missingRequired.join(", ") || "-"}`, "DOCUMENT_INCOMPLETE", 3, {
          correlationId: comp.correlationId,
          details: { documentId: sent.documentId, revisionNo, completeness },
        });
      }
      renderSkipped = `dokumen belum lengkap (${completeness.status}); render penuh dilewati`;
    } else {
      const rv = await renderAndVerify(ctx, sent.documentId, agentIdForRender(ctx, blocks));
      render = rv.render;
      revisionNo = rv.revisionNo ?? revisionNo;
    }
    toolOk = true;
    const delta =
      args.command === "update"
        ? {
            sent: sent.steps.filter((s) => !s.skipped).map((s) => s.part),
            unchanged: sent.steps.filter((s) => s.skipReason === "unchanged").map((s) => s.part),
            excluded: sent.steps.filter((s) => s.skipReason === "section").map((s) => s.part),
            ...(upd !== null && upd.refresh.length > 0 ? { stale: upd.refresh.map((x) => x.part) } : {}),
          }
        : null;
    const next = nextBasisOf(sent.documentId, sent.steps, upd ? upd.latestRevisionNo : null, upd ? upd.refresh.map((x) => x.part) : [], upd ? upd.pending : [], refreshCommandOf(sent.documentId, args.file));
    result = {
      ok: true,
      command: args.command,
      documentId: sent.documentId,
      docNumber: sent.docNumber,
      revisionNo,
      completeness,
      steps: sent.steps,
      render,
      renderSkipped,
      format: input.format,
      conversion: input.conversion,
      delta,
      basis: upd ? upd.basis : null,
      nextBasis: next.line,
      nextBasisNote: next.note,
      refresh: upd ? upd.refresh : [],
      changedByOthers: upd ? upd.changedByOthers : [],
      notInReport: upd ? upd.notInReport : [],
      notices,
      timingRows: 0,
      wallSeconds: (now() - t0) / 1000,
    };
    return result;
  } catch (e) {
    toolErr = e instanceof ReportError ? e.code : "INTERNAL_ERROR";
    // Galat sesudah semua blok terkirim (kelengkapan, render, unduh, simpan): kode keluar tetap, `progress` ditambahkan (#5).
    if (sent !== null && e instanceof ReportError && e.exitCode !== 3 && e.info.progress === undefined) {
      const progress = progressOf(ctx, { id: sent.documentId, docNumber: sent.docNumber }, sent.steps, e, false);
      if (progress !== null) throw new ReportError(e.message, e.code, e.exitCode, { ...e.info, progress });
    }
    throw e;
  } finally {
    if (timing) {
      // R3-F #1: --force-latest tercatat di catatan baris tool.
      const note = `${path.basename(args.file)}${basisMode === "force-latest" ? " force-latest" : ""}`;
      timing.add({ kind: "tool", action: `${NAME} ${args.command}`, target: docForTiming !== "-" ? docForTiming : path.basename(args.file), tStart: t0, tEnd: now(), ok: toolOk, errCode: toolErr, note });
      try {
        const rows = timing.flush();
        if (result) result.timingRows = rows;
      } catch (flushErr) {
        // Galat perintah asli lebih penting; galat tulis timing tetap dilaporkan.
        if (toolOk) throw flushErr;
        io.stderr(`${NAME}: peringatan: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}
`);
      }
    }
  }
}

// ── Keluaran ────────────────────────────────────────────────────────────

/**
 * Ringkasan konversi MD-native: bagian, peringatan CW, unsur dibuang. Bab wajib kosong hanya untuk
 * submit (R3-F #4: pada update bab yang hilang dari laporan TIDAK dihapus; status kelengkapan nyata
 * dicetak dari R15, dan bab yang tidak ada di laporan dilaporkan terpisah).
 */
function conversionLines(c: MdReportConversion, command: "submit" | "update"): string[] {
  const out = [`  konversi MD: ${c.parts.join(", ")}${c.refs > 0 ? ` (record.refs: ${c.refs})` : ""}`];
  for (const w of c.warnings) out.push(`  peringatan baris ${w.line} ${w.code}: ${w.message}`);
  for (const w of c.proseWarnings) out.push(`  peringatan bab ${w.chapterKey} baris ${w.line} ${w.code}: ${w.message}`);
  for (const d of c.dropped) out.push(`  dibuang bab ${d.chapterKey} baris ${d.line} ${d.code}: ${d.excerpt}`);
  if (command === "submit" && c.missingChapters.length > 0) out.push(`  bab wajib kosong di laporan: ${c.missingChapters.join(", ")} (dokumen akan belum lengkap)`);
  return out;
}

function warningsOf(details: unknown): Array<{ line?: unknown; code?: unknown; message?: unknown }> {
  return isRecord(details) && Array.isArray(details.warnings) ? details.warnings.filter(isRecord) : [];
}

export function formatHuman(r: ReportResult): string {
  const out: string[] = [];
  out.push(`${NAME} ${r.command}: dokumen ${r.documentId}${r.docNumber ? ` (${r.docNumber})` : ""}`);
  if (r.conversion) out.push(...conversionLines(r.conversion, r.command));
  for (const n of r.notices) out.push(`  pemberitahuan ${n}`);
  if (r.basis) {
    const b = r.basis;
    out.push(
      b.mode === "basis"
        ? `  basis: rev${b.revisionNo} (${b.source === "--base-rev" ? "--base-rev" : "baris basis kepala"}), terkini rev${b.latestRevisionNo}`
        : `  basis: terkini rev${b.latestRevisionNo} (${b.mode === "force-latest" ? "--force-latest, tercatat" : "draf json tanpa basis"})`,
    );
  }
  for (const s of r.steps) {
    if (s.skipReason === "section") out.push(`  blok ${s.block} ${s.part}: di luar --section, tidak dikirim`);
    else if (s.skipReason === "stale") out.push(`  blok ${s.block} ${s.part}: tidak Anda ubah sejak basis, tetapi diubah pihak lain; isi terkini dipertahankan, tidak dikirim`);
    else if (s.skipped) out.push(`  blok ${s.block} ${s.part}: tidak berubah, tidak dikirim`);
    else {
      const what = s.created ? "dokumen dibuat" : s.unchanged ? "tidak berubah" : "revisi baru";
      out.push(`  blok ${s.block} ${s.part} -> ${s.route}: ${s.status} rev${s.revisionNo ?? "-"} (${what})${s.correlationId ? ` cid ${s.correlationId}` : ""}`);
    }
  }
  if (r.delta) {
    out.push(`  dikirim: ${r.delta.sent.length > 0 ? r.delta.sent.join(", ") : "tidak ada (semua sama dengan basis)"}`);
    out.push(`  tidak berubah: ${r.delta.unchanged.length > 0 ? r.delta.unchanged.join(", ") : "-"}`);
    if (r.delta.excluded.length > 0) out.push(`  di luar --section: ${r.delta.excluded.join(", ")}`);
  }
  if (r.notInReport.length > 0) {
    out.push(`  ada di dokumen, tidak ada di laporan: ${r.notInReport.join(", ")} -> TIDAK dihapus (hapus lewat PATCH /api/studio/documents/{id}/structure bila memang dimaksud)`);
  }
  out.push(`  kelengkapan: ${r.completeness.status}${r.completeness.missingRequired.length > 0 ? ` (kurang: ${r.completeness.missingRequired.join(", ")})` : ""}`);
  if (r.renderSkipped) out.push(`  render: ${r.renderSkipped}`);
  out.push("hasil:");
  out.push(`  documentId: ${r.documentId}`);
  out.push(`  revisionNo: ${r.revisionNo ?? "-"}`);
  if (r.render) {
    out.push(`  sha16: ${r.render.sha16}`);
    out.push(`  nama final: ${r.render.finalFileName}`);
    out.push(`  verifikasi: sha256 cocok, X-Studio-Sha256-Verified ${r.render.verified ? "true" : "false"} (${r.render.bytes} bita)`);
    out.push(`  disimpan: ${r.render.savedTo ?? "tidak (pakai --out <dir> untuk menyimpan)"}`);
  }
  out.push(`  kelengkapan: ${r.completeness.status}`);
  out.push(`  waktu: ${r.wallSeconds.toFixed(3)} s`);
  if (r.changedByOthers.length > 0) out.push(`diubah pihak lain sejak basis: ${r.changedByOthers.join(", ")} (bagian itu tidak ditimpa)`);
  if (r.refresh.length > 0) {
    out.push(`isi terkini ${r.refresh.map((f) => f.part).join(", ")} diubah pihak lain sejak basis: tidak dikirim, suntingan mereka tetap. Jangan salin manual; ambil lewat:`);
    out.push(`  ${refreshCommandOf(r.documentId, "<laporan.md>")}`);
  }
  if (r.nextBasis !== null) {
    out.push(`basis berikutnya (salin ke kepala laporan, ganti baris basis lama, sebelum update berikutnya):`);
    out.push(`  ${r.nextBasis}`);
  } else if (r.nextBasisNote !== null) out.push(`basis berikutnya: belum dapat dipakai; ${r.nextBasisNote}`);
  return `${out.join("\n")}\n`;
}

function formatError(e: ReportError): string {
  const lines = [`${NAME}: galat ${e.code}${e.info.httpStatus ? ` (HTTP ${e.info.httpStatus})` : ""}${e.info.step ? ` pada ${e.info.step}` : ""}: ${e.message}`];
  if (e.info.pointer !== undefined) lines.push(`  pointer: ${e.info.pointer === "" ? "/" : e.info.pointer}`);
  if (e.info.correlationId) lines.push(`  x-correlation-id: ${e.info.correlationId}`);
  for (const w of warningsOf(e.info.details)) lines.push(`  peringatan baris ${String(w.line)} ${String(w.code)}: ${String(w.message)}`);
  // R3-F #1 / R3-F2 N2: BASE_CONFLICT membawa isi terkini (lossless) bagian yang bentrok, hanya untuk dibaca.
  const refresh = isRecord(e.info.details) && Array.isArray(e.info.details.refresh) ? e.info.details.refresh.filter(isRecord) : [];
  for (const f of refresh) {
    lines.push(`  isi terkini ${String(f.part)} (hanya untuk dibaca; JANGAN disalin manual, pakai refresh):`);
    if (Array.isArray(f.markdown)) for (const l of f.markdown) lines.push(`    ${String(l)}`);
  }
  const p = e.info.progress;
  if (p) {
    lines.push(`  dokumen: ${p.documentId}${p.docNumber ? ` (${p.docNumber})` : ""}, revisionNo terakhir: ${p.revisionNo ?? "-"}`);
    lines.push(`  sudah tersimpan: ${p.completedSteps.length > 0 ? p.completedSteps.join(", ") : "-"}`);
    lines.push(`  langkah gagal: ${p.failedStep}`);
    lines.push(`  lanjutkan: ${p.resume}`);
  }
  return `${lines.join("\n")}\n`;
}

function fatalJson(e: ReportError): string {
  const { httpStatus, correlationId, pointer, step, details, progress } = e.info;
  return `${JSON.stringify(
    {
      ok: false,
      exitCode: e.exitCode,
      fatal: {
        code: e.code,
        message: e.message,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(correlationId !== undefined ? { correlationId } : {}),
        ...(pointer !== undefined ? { pointer } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(details !== undefined ? { details } : {}),
        ...(progress !== undefined ? { progress } : {}),
      },
    },
    null,
    2,
  )}\n`;
}

// ── refresh (R3-F2 N1): gabung per bagian dengan versi server ────────────

/** Keputusan per bagian `refresh`. */
export type RefreshAction =
  /** Laporan Anda = server. */
  | "sama"
  /** Hanya Anda yang mengubah: versi Anda dipertahankan. */
  | "anda"
  /** Hanya pihak lain yang mengubah: versi server diambil. */
  | "server"
  /** Bagian baru di server (tidak ada di basis dan di laporan): diambil. */
  | "server-baru"
  /** Dihapus di server, tidak Anda ubah: dihilangkan dari laporan. */
  | "dihapus-server"
  /** Tidak ada di laporan Anda dan tidak diubah pihak lain: tetap tidak ditulis (update tidak menghapusnya). */
  | "dihilangkan"
  /** Diubah keduanya: ditandai penanda konflik. */
  | "konflik"
  /** Versi server tidak dapat ditulis utuh lewat Markdown laporan: tidak ditulis (update tidak menyentuhnya). */
  | "tidak-terwakili";

export interface RefreshPart {
  part: string;
  action: RefreshAction;
  note?: string;
}

export interface RefreshResult {
  ok: boolean;
  command: "refresh";
  documentId: string;
  file: string;
  basis: { from: number; to: number; line: string };
  parts: RefreshPart[];
  conflicts: string[];
  /** Bagian yang tidak dapat ditulis ulang utuh (alasan); bila memuat versi Anda / record -> berkas TIDAK ditulis. */
  unrepresentable: Array<{ part: string; side: "anda" | "server"; reason: string }>;
  notices: string[];
  /** Laporan gabungan (selalu ada; juga ditulis ke `written` bila --out-md / --write). */
  markdown: string;
  written: string | null;
  exitCode: 0 | 1;
}

const partOrder = (p: string): number => (p === "record" ? -1 : p === "references" ? 1e9 : /^bab [0-9]+$/.test(p) ? Number(p.slice(4)) : 1e8);

/** Payload per bagian dari blok kiriman (record/references = payload slot; bab = chapter). */
export function partsOfValues(values: ReadonlyArray<Record<string, unknown>>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const v of values) out.set(partOf(v), draftPayloadOf(v));
  return out;
}

function serializePart(part: string, payload: unknown, why: { reason: string | null }): ReportPartMarkdown | null {
  const ctx = newSerializeCtx();
  const md = part === "record" ? recordToReportMarkdown(payload, ctx) : part === "references" ? referencesToReportMarkdown(payload, ctx) : chapterToReportMarkdown(payload, ctx);
  if (md === null) why.reason = ctx.why ?? "tidak diketahui";
  return md;
}

/**
 * R3-F2 N1 — `refresh <documentId> <laporan.md>`: baca terkini + basis laporan (GET R20, R15 bila
 * perlu untuk peringatan agentId sama), putuskan per bagian (tiga arah, tanpa pengecualian penulis), rakit
 * laporan gabungan lossless dengan baris basis terkini, VERIFIKASI dengan konversi ulang penuh (setiap
 * bagian hasil = versi yang dipilih, persis), lalu tulis ke stdout / `--out-md` / `--write`. Tidak
 * pernah mengirim apa pun ke server. Keluar 0 bersih; 1 ada konflik (berkas bertanda) atau bagian
 * Anda/record tidak terwakili (berkas tidak ditulis); 2 lingkungan.
 */
export async function runRefresh(args: RefreshArgs, io: CliIo): Promise<RefreshResult> {
  const fsx = io.fs ?? REAL_FS;
  const secret = io.env.INTERNAL_API_SECRET ?? "";
  if (secret === "") throw new ReportError("env INTERNAL_API_SECRET belum diisi", "SECRET_MISSING", 2);
  const rawUrl = args.remote ?? io.env.HQ_URL ?? "";
  if (rawUrl === "") throw usageErr("berikan --remote <url> atau env HQ_URL");
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawUrl);
  } catch (e) {
    throw usageErr(e instanceof Error ? e.message : String(e));
  }
  const documentId = args.documentId;
  const { markdown, bytes } = readDraft(args.file, fsx);
  if (detectFormat(markdown) !== "md") throw new ReportError("refresh hanya untuk laporan MD-native (draf ber-blok json: baca GET .../content dan gabungkan sendiri)", "REFRESH_JSON_UNSUPPORTED", 2, { step: "refresh" });
  const input = prepareInput({ command: "update", documentId, format: "md", mission: null, docKey: null, agentId: args.agentId }, markdown, bytes);
  const conversion = input.conversion as MdReportConversion;
  const header = conversion.basis && conversion.basis.kind === "revision" ? conversion.basis : null;
  if (header !== null && header.documentId !== documentId) {
    throw new ReportError(`baris basis menunjuk dokumen ${header.documentId}, bukan ${documentId}; periksa documentId perintah. Tidak ada yang ditulis`, "BASIS_DOCUMENT_MISMATCH", 2, { step: "basis" });
  }
  const basisRev = args.baseRev ?? header?.revisionNo ?? null;
  if (basisRev === null) {
    throw new ReportError(
      `laporan tidak memuat baris basis; refresh membedakan suntingan Anda dari perubahan pihak lain lewat basis. Tulis "basis: ${documentId}@rev<n>" (revisi yang terakhir Anda lihat) atau berikan --base-rev <n>. Tidak ada yang ditulis`,
      "BASIS_MISSING",
      1,
      { step: "basis" },
    );
  }
  const blocks = checkLocally(input.draft, input.draftBytes);
  const cliArgs: CliArgs = { command: "update", documentId, file: args.file, remote: args.remote, agentId: args.agentId, mission: null, docKey: null, format: "md", sections: null, baseRev: basisRev, forceLatest: false, out: null, timing: null, step: null, requireComplete: false, allowExample: false, json: args.json };
  const ctx: Ctx = { args: cliArgs, client: new StudioClient(baseUrl, secret, io.fetchImpl ?? (globalThis.fetch as unknown as HttpFetch), null, io.now ?? Date.now), fsx, timing: null, now: io.now ?? Date.now };
  const now = await readContent(ctx, documentId, null);
  const latest = now.revisionNo;
  if (basisRev > latest) throw new ReportError(`basis rev${basisRev} melampaui revisi terkini dokumen (rev${latest}); periksa baris basis. Tidak ada yang ditulis`, "BASIS_INVALID", 1, { step: "basis" });
  const atBase = basisRev < latest ? (await readContent(ctx, documentId, basisRev)).content : now.content;
  const notices: string[] = [];

  const values = remapExtraChapters(
    blocks.map((b) => withDocumentTarget(b.value as Record<string, unknown>, documentId)),
    now.content,
  );
  const mineParts = partsOfValues(values);
  const baseParts = partsOf(atBase);
  const nowParts = partsOf(now.content);
  const allParts = [...new Set([...mineParts.keys(), ...baseParts.keys(), ...nowParts.keys()])].sort((a, b) => partOrder(a) - partOrder(b) || a.localeCompare(b));
  const agentId = args.agentId ?? conversion.agentId;
  const has = (m: Map<string, unknown>, p: string) => m.has(p);
  const same = (a: Map<string, unknown>, b: Map<string, unknown>, p: string) => (has(a, p) && has(b, p) ? sameContent(a.get(p), b.get(p)) : has(a, p) === has(b, p));
  const needWriters = agentId !== null && basisRev < latest && allParts.some((p) => has(mineParts, p) && !same(mineParts, nowParts, p) && !same(mineParts, baseParts, p) && !same(baseParts, nowParts, p));
  const writers = needWriters ? await lastWritersOf(ctx, documentId, notices) : (new Map() as LastWriters);

  // Keputusan per bagian.
  type Pick = { part: string; action: RefreshAction; mine?: unknown; server?: unknown; note?: string };
  const picks: Pick[] = allParts.map((part) => {
    const mine = mineParts.get(part);
    const server = nowParts.get(part);
    if (!has(mineParts, part)) {
      if (same(baseParts, nowParts, part)) return { part, action: "dihilangkan", note: "tidak ada di laporan Anda dan tidak diubah pihak lain; tetap tidak ditulis (update tidak menghapusnya)" };
      return { part, action: has(baseParts, part) ? "server" : "server-baru", server };
    }
    if (same(mineParts, nowParts, part)) return { part, action: "sama", mine };
    if (same(mineParts, baseParts, part)) return has(nowParts, part) ? { part, action: "server", server } : { part, action: "dihapus-server", note: "dihapus di server sesudah basis; dihilangkan dari laporan" };
    if (same(baseParts, nowParts, part)) return { part, action: "anda", mine };
    return { part, action: "konflik", mine, server: has(nowParts, part) ? server : undefined };
  });
  // R3-F3 (15c R3): penulis terakhir bagian konflik ber-agentId sama -> peringatan saja (keputusan tetap konflik).
  notices.push(...sameAgentWarningsOf(writers, picks.filter((p) => p.action === "konflik").map((p) => p.part), agentId, basisRev, "update dengan berkas hasil refresh ini"));

  // Serialisasi; versi server yang tidak terwakili tidak ditulis (update tidak menyentuh bagian yang tidak ada di laporan).
  const unrepresentable: RefreshResult["unrepresentable"] = [];
  const md = new Map<string, { one?: ReportPartMarkdown; mine?: ReportPartMarkdown | null; server?: ReportPartMarkdown | null; payloadMine?: unknown; payloadServer?: unknown }>();
  for (const p of picks) {
    if (p.action === "dihilangkan" || p.action === "dihapus-server") continue;
    const why = { reason: null as string | null };
    if (p.action === "konflik") {
      const m = serializePart(p.part, p.mine, why);
      if (m === null) unrepresentable.push({ part: p.part, side: "anda", reason: why.reason ?? "-" });
      const s = p.server === undefined ? null : serializePart(p.part, p.server, why);
      if (p.server !== undefined && s === null) unrepresentable.push({ part: p.part, side: "server", reason: why.reason ?? "-" });
      md.set(p.part, { mine: m, server: s, payloadMine: p.mine, payloadServer: p.server });
      continue;
    }
    const fromServer = p.action === "server" || p.action === "server-baru";
    const payload = fromServer ? p.server : p.mine;
    const one = serializePart(p.part, payload, why);
    if (one === null) {
      unrepresentable.push({ part: p.part, side: fromServer ? "server" : "anda", reason: why.reason ?? "-" });
      if (fromServer && p.part !== "record") {
        p.action = "tidak-terwakili";
        p.note = `versi server tidak dapat ditulis utuh lewat Markdown laporan (${why.reason ?? "-"}); tidak ditulis, update tidak menyentuhnya`;
      }
      continue;
    }
    md.set(p.part, { one, payloadMine: fromServer ? undefined : payload, payloadServer: fromServer ? payload : undefined });
  }

  const tool = stripToolKeys(markdown).tool;
  const basisLine = `basis: ${documentId}@rev${latest}`;
  const toolLines = [...(tool.mission !== null ? [`mission: ${tool.mission}`] : []), ...(tool.docKey !== null ? [`docKey: ${tool.docKey}`] : []), ...(tool.agentId !== null ? [`agentId: ${tool.agentId}`] : []), basisLine];
  const label = (p: string) => ({ mineLabel: `ANDA: ${p} (laporan Anda, basis rev${basisRev})`, serverLabel: `SERVER: ${p} (rev${latest}, diubah pihak lain sesudah basis)` });
  const assemble = (pick: "markers" | "mine" | "server"): string => {
    const parts: AssemblePart[] = [];
    for (const p of picks) {
      const m = md.get(p.part);
      if (m === undefined) continue;
      if (m.one !== undefined) parts.push({ part: p.part, one: m.one });
      else parts.push({ part: p.part, conflict: { mine: m.mine ?? null, server: m.server ?? null, ...label(p.part) } });
    }
    return assembleReportMarkdown({ title: conversion.title, toolLines, parts }, pick);
  };

  // Verifikasi: konversi ulang penuh; setiap bagian hasil harus PERSIS versi yang dipilih.
  const verify = (pick: "mine" | "server"): Map<string, string> => {
    const bad = new Map<string, string>();
    let got: Map<string, unknown>;
    try {
      const re = mdReportToBlocks(assemble(pick), { mode: "update", documentId });
      got = partsOfValues(remapExtraChapters(re.blocks, now.content));
    } catch (e) {
      bad.set("*", e instanceof Error ? e.message : String(e));
      return bad;
    }
    for (const [part, m] of md) {
      const want = m.one !== undefined ? (m.payloadServer ?? m.payloadMine) : pick === "mine" ? m.payloadMine : m.payloadServer;
      const present = m.one !== undefined || (pick === "mine" ? m.mine : m.server) !== null;
      if (!present) {
        if (got.has(part)) bad.set(part, "bagian muncul padahal sisi ini tidak memilikinya");
        continue;
      }
      if (!got.has(part)) bad.set(part, "bagian hilang sesudah konversi ulang");
      else if (!sameContent(got.get(part), want)) bad.set(part, "isi berbeda sesudah konversi ulang");
    }
    for (const part of got.keys()) if (!md.has(part)) bad.set(part, "bagian tak terduga sesudah konversi ulang");
    return bad;
  };
  const hasConflict = picks.some((p) => p.action === "konflik");
  // Record wajib ada (KD-42: Status/ReportedAt); record yang tidak terwakili = tidak ada yang ditulis.
  const recordBroken = !md.has("record") || unrepresentable.some((u) => u.part === "record");
  // Bagian server (non-konflik) yang gagal verifikasi dibuang dari berkas (tidak terwakili), lalu ulangi.
  for (let round = 0; round < 8 && !recordBroken; round++) {
    const badMine = verify("mine");
    const badServer = hasConflict ? verify("server") : badMine;
    const dropped = [...md.keys()].filter((part) => {
      const m = md.get(part)!;
      if (m.one === undefined || part === "record" || m.payloadServer === undefined) return false;
      return badMine.has(part) && badServer.has(part);
    });
    if (dropped.length === 0) break;
    for (const part of dropped) {
      const p = picks.find((x) => x.part === part)!;
      const reason = badMine.get(part) ?? "-";
      unrepresentable.push({ part, side: "server", reason });
      p.action = "tidak-terwakili";
      p.note = `versi server tidak dapat ditulis ulang utuh (${reason}); tidak ditulis, update tidak menyentuhnya`;
      md.delete(part);
    }
  }
  const badMine = recordBroken ? new Map<string, string>() : verify("mine");
  const badServer = recordBroken ? badMine : hasConflict ? verify("server") : badMine;
  for (const [part, m] of md) {
    const failMine = badMine.get(part) ?? badMine.get("*");
    const failServer = badServer.get(part) ?? badServer.get("*");
    if (m.one !== undefined) {
      // Non-konflik: harus lolos di salah satu varian (gagal di satu varian = bergantung pada bagian konflik, mis. butir record dari tabel bab).
      if (failMine !== undefined && failServer !== undefined) unrepresentable.push({ part, side: m.payloadServer !== undefined ? "server" : "anda", reason: failMine });
      else if (failMine !== undefined || failServer !== undefined) notices.push(`${part}: hasilnya bergantung pada pilihan versi bagian konflik (mis. butir kerja record dibaca dari tabel bab); periksa dengan studio-report check sesudah menyelesaikan konflik`);
    } else {
      if (failMine !== undefined && m.mine !== null) unrepresentable.push({ part, side: "anda", reason: failMine });
      if (failServer !== undefined && m.server !== null) unrepresentable.push({ part, side: "server", reason: failServer });
    }
  }
  const omitted = new Set(picks.filter((p) => p.action === "tidak-terwakili").map((p) => p.part));
  const blocking = unrepresentable.filter((u) => !omitted.has(u.part) || u.side === "anda");
  // R3-F3 (15c R2): baris ~~hapus~~ laporan asli ditulis kembali (butir/rujukan yang masih ada di server).
  const nowRecord = nowParts.get("record");
  const alive = {
    items: new Set(recordsOf(isRecord(nowRecord) ? nowRecord.items : undefined).map((i) => String(i.key ?? ""))),
    refs: new Set(recordsOf(isRecord(nowRecord) ? nowRecord.refs : undefined).map((r) => refRemovalKey(String(r.rel ?? ""), String(r.documentId ?? "")))),
  };
  const kept = keepRemovalRows(assemble("markers"), markdown, alive);
  notices.push(...kept.notices);
  const merged = kept.markdown;
  const conflicts = picks.filter((p) => p.action === "konflik").map((p) => p.part);
  let written: string | null = null;
  if (blocking.length === 0 && (args.write || args.outMd !== null)) {
    const dest = args.write ? args.file : (args.outMd as string);
    if (!args.write && path.resolve(dest) === path.resolve(args.file)) throw usageErr("--out-md menunjuk berkas laporan itu sendiri; pakai --write untuk menimpanya");
    if (!fsx.writeFileText) throw new ReportError("penulisan berkas tidak tersedia di lingkungan ini", "OUT_UNWRITABLE", 2, { step: "refresh" });
    try {
      fsx.writeFileText(dest, merged);
    } catch (e) {
      throw new ReportError(`tidak dapat menulis ${dest}: ${e instanceof Error ? e.message : String(e)}`, "OUT_UNWRITABLE", 2, { step: "refresh" });
    }
    written = dest;
  }
  if (blocking.length > 0) notices.push("berkas TIDAK ditulis: ada bagian yang tidak dapat ditulis ulang utuh (lihat daftar); laporan asli tetap");
  const exitCode: 0 | 1 = conflicts.length > 0 || blocking.length > 0 ? 1 : 0;
  return {
    ok: exitCode === 0,
    command: "refresh",
    documentId,
    file: args.file,
    basis: { from: basisRev, to: latest, line: basisLine },
    parts: picks.map((p) => ({ part: p.part, action: p.action, ...(p.note !== undefined ? { note: p.note } : {}) })),
    conflicts,
    unrepresentable: blocking,
    notices,
    markdown: merged,
    written,
    exitCode,
  };
}

const REFRESH_ACTION_TEXT: Readonly<Record<RefreshAction, string>> = {
  sama: "sama dengan server",
  anda: "versi Anda dipertahankan (hanya Anda yang mengubah)",
  server: "diambil dari server (diubah pihak lain)",
  "server-baru": "baru di server, diambil",
  "dihapus-server": "dihapus di server, dihilangkan",
  dihilangkan: "tidak ada di laporan Anda, tetap tidak ditulis",
  konflik: "KONFLIK (diubah keduanya): ditandai <<<<<<< ======= >>>>>>>",
  "tidak-terwakili": "tidak dapat ditulis lewat MD, tidak ditulis",
};

export function formatRefreshHuman(r: RefreshResult): string {
  const out = [`${NAME} refresh ${r.file}: dokumen ${r.documentId}, basis rev${r.basis.from} -> rev${r.basis.to} (tidak ada yang dikirim ke server)`];
  for (const p of r.parts) out.push(`  ${p.part}: ${REFRESH_ACTION_TEXT[p.action]}${p.note ? ` — ${p.note}` : ""}`);
  for (const u of r.unrepresentable) out.push(`  tidak terwakili ${u.part} (versi ${u.side}): ${u.reason}`);
  for (const n of r.notices) out.push(`  pemberitahuan ${n}`);
  out.push(`  baris basis di laporan gabungan: ${r.basis.line}`);
  out.push(r.written !== null ? `  ditulis: ${r.written}` : r.unrepresentable.length > 0 ? "  ditulis: tidak" : "  ditulis: tidak (laporan gabungan di stdout; --out-md <berkas> atau --write untuk menyimpan)");
  if (r.conflicts.length > 0) {
    out.push(`langkah berikut: di ${r.conflicts.join(", ")} pilih/gabungkan isi antara <<<<<<< dan >>>>>>>, hapus ketiga baris penanda, lalu jalankan update dengan berkas itu (laporan berpenanda ditolak MERGE_CONFLICT_MARKER).`);
  } else if (r.unrepresentable.length === 0) {
    out.push("langkah berikut: sunting laporan gabungan bila perlu, lalu jalankan update dengan berkas itu (basis sudah terkini).");
  }
  return `${out.join("\n")}\n`;
}

// ── check (D-441): hanya baca ───────────────────────────────────────────

export interface CheckResult {
  ok: boolean;
  command: "check";
  file: string;
  format: "md" | "json";
  /** Mode konversi: `update` bila laporan MD memuat baris basis `<documentId>@rev<n>`, selain itu `create`. */
  mode: "create" | "update";
  documentId: string | null;
  parts: string[];
  conversion: MdReportConversion | null;
  notices: string[];
  /** Hasil dry-run R08 per bagian (bentuk draft-check T2-70 tanpa payload), null tanpa `--remote`. */
  remote: unknown;
  /** Isu dry-run yang menghalangi kiriman. */
  issues: Array<{ block: number; part: string; pointer: string; code: string; message: string }>;
  exitCode: 0 | 1;
}

/**
 * D-441 — periksa laporan tanpa menulis: konversi (jalur yang sama dengan submit/update, termasuk
 * baris basis dan `extraAliases`), cek lokal C54 + `checkDraftLocal`, penjaga target contoh, lalu
 * (dengan `--remote`) dry-run R08 per bagian lewat jalur `draft-check --remote` (GET R05 untuk DR-08
 * + POST /api/studio/validate; tidak ada create/submit/update). Tidak menulis berkas apa pun.
 * Galat isi -> {@link ReportError} keluar 1; lingkungan -> 2.
 */
export async function runCheck(args: CheckArgs, io: CliIo): Promise<CheckResult> {
  const fsx = io.fs ?? REAL_FS;
  let secret = "";
  let baseUrl: string | null = null;
  if (args.remote !== null) {
    secret = io.env.INTERNAL_API_SECRET ?? "";
    if (secret === "") throw new ReportError("env INTERNAL_API_SECRET belum diisi (diperlukan --remote)", "SECRET_MISSING", 2);
    try {
      baseUrl = normalizeBaseUrl(args.remote);
    } catch (e) {
      throw usageErr(e instanceof Error ? e.message : String(e));
    }
  }
  const { markdown, bytes } = readDraft(args.file, fsx);
  const format = args.format ?? detectFormat(markdown);
  let documentId: string | null = null;
  if (format === "md") {
    try {
      const b = parseMdBasis(stripToolKeys(markdown).tool.basis);
      if (b !== null && b.kind === "revision") documentId = b.documentId;
    } catch (e) {
      if (e instanceof MdReportError) throw new ReportError(e.message, e.code, 1, { step: "konversi MD" });
      throw e;
    }
  }
  const command = documentId !== null ? "update" : "submit";
  const input = prepareInput({ command, documentId, format, mission: args.mission, docKey: args.docKey, agentId: args.agentId }, markdown, bytes);
  let blocks: ExtractedDraftBlock[];
  try {
    blocks = checkLocally(input.draft, input.draftBytes);
  } catch (e) {
    if (input.format === "md" && e instanceof ReportError) throw new ReportError(`hasil konversi laporan MD tidak lolos cek lokal: ${e.message}`, e.code, e.exitCode, { ...e.info, step: e.info.step ?? "konversi MD" });
    throw e;
  }
  try {
    guardExampleTargets({ allowExample: args.allowExample, command, mission: args.mission, docKey: args.docKey }, blocks);
  } catch (e) {
    // Pada check, target contoh = isu yang menghalangi kiriman (keluar 1), bukan galat pemakaian.
    if (e instanceof ReportError) throw new ReportError(e.message, e.code, 1, e.info);
    throw e;
  }
  const notices = input.conversion?.notices.map((n) => `${n.code}${n.line !== undefined ? ` baris ${n.line}` : ""}: ${n.message}`) ?? [];
  const parts = blocks.map((b) => partOf(b.value as Record<string, unknown>));
  let remote: unknown = null;
  const issues: CheckResult["issues"] = [];
  if (baseUrl !== null) {
    let r: DraftCheckResultV2;
    try {
      r = await checkDraftRemote(input.draft, { baseUrl, secret, fetchImpl: io.fetchImpl, ...(args.agentId !== null ? { agentId: args.agentId } : {}) });
    } catch (e) {
      if (e instanceof DraftCheckUsageError) throw new ReportError(e.message, e.code, 2, e.details !== undefined ? { details: e.details } : {});
      throw e;
    }
    remote = withoutPayload(r);
    r.blocks.forEach((b, i) => {
      if (b.valid) return;
      for (const raw of b.issues.length > 0 ? b.issues : [{}]) {
        const x = isRecord(raw) ? raw : {};
        issues.push({
          block: i + 1,
          part: parts[i] ?? `blok ${i + 1}`,
          pointer: typeof x.pointer === "string" ? x.pointer : "",
          code: String(x.keyword ?? x.code ?? "INVALID"),
          message: String(x.message ?? "tidak valid"),
        });
      }
    });
    for (const i of r.issues) if (i.severity === "error") issues.push({ block: 0, part: "draf", pointer: "", code: i.code, message: i.message });
    for (const i of r.issues) if (i.severity !== "error") notices.push(`${i.code}: ${i.message}`);
  }
  const ok = issues.length === 0;
  return { ok, command: "check", file: args.file, format: input.format, mode: command === "update" ? "update" : "create", documentId, parts, conversion: input.conversion, notices, remote, issues, exitCode: ok ? 0 : 1 };
}

export function formatCheckHuman(r: CheckResult): string {
  const out = [`${NAME} check ${r.file}: ${r.ok ? "VALID" : "TIDAK VALID"} (format ${r.format}, mode ${r.mode}${r.documentId ? ` dokumen ${r.documentId}` : ""}; tidak ada yang dikirim)`];
  if (r.conversion) out.push(...conversionLines(r.conversion, r.mode === "update" ? "update" : "submit"));
  else out.push(`  bagian: ${r.parts.join(", ")}`);
  for (const n of r.notices) out.push(`  pemberitahuan ${n}`);
  out.push(r.remote === null ? "  dry-run R08: tidak dijalankan (tambahkan --remote <url>)" : `  dry-run R08: ${r.issues.length === 0 ? "semua bagian valid" : `${r.issues.length} isu`}`);
  for (const i of r.issues) out.push(`  isu ${i.part}: ${i.pointer === "" ? "/" : i.pointer} ${i.code}: ${i.message}`);
  return `${out.join("\n")}\n`;
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const wantsJson = argv.includes("--json");
  const fail = (e: ReportError, usage = false): number => {
    io.stderr(`${formatError(e)}${usage ? `${USAGE}\n` : ""}`);
    if (wantsJson) io.stdout(fatalJson(e));
    return e.exitCode;
  };
  let args: CliArgs | TemplateArgs | CheckArgs | RefreshArgs | "help";
  try {
    args = parseArgs(argv);
  } catch (e) {
    return fail(e instanceof ReportError ? e : usageErr(String(e)), true);
  }
  if (args === "help") {
    io.stdout(wantsJson ? `${JSON.stringify({ help: HELP }, null, 2)}\n` : `${HELP}\n`);
    return 0;
  }
  if (args.command === "template") {
    // U-18: hanya stdout; tanpa server, rahasia, maupun berkas.
    const text = reportTemplate({ format: args.format, mission: args.mission, docKey: args.docKey });
    io.stdout(args.json ? `${JSON.stringify({ ok: true, command: "template", format: args.format, mission: args.mission, docKey: args.docKey, template: text }, null, 2)}\n` : text);
    return 0;
  }
  if (args.command === "refresh") {
    try {
      const result = await runRefresh(args, io);
      if (args.json) io.stdout(`${JSON.stringify({ ...result, markdown: result.written === null && result.unrepresentable.length === 0 ? result.markdown : undefined }, null, 2)}\n`);
      else if (result.written === null && result.unrepresentable.length === 0) {
        // Laporan gabungan ke stdout (dapat dialihkan ke berkas); ringkasan ke stderr.
        io.stdout(result.markdown);
        io.stderr(formatRefreshHuman(result));
      } else io.stdout(formatRefreshHuman(result));
      return result.exitCode;
    } catch (e) {
      if (e instanceof ReportError) return fail(e);
      return fail(new ReportError(`galat tak terduga: ${e instanceof Error ? e.message : String(e)}`, "INTERNAL_ERROR", 2));
    }
  }
  if (args.command === "check") {
    try {
      const result = await runCheck(args, io);
      io.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatCheckHuman(result));
      return result.exitCode;
    } catch (e) {
      if (e instanceof ReportError) return fail(e);
      return fail(new ReportError(`galat tak terduga: ${e instanceof Error ? e.message : String(e)}`, "INTERNAL_ERROR", 2));
    }
  }
  try {
    const result = await runReport(args, io);
    io.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(result));
    return 0;
  } catch (e) {
    if (e instanceof ReportError) return fail(e);
    return fail(new ReportError(`galat tak terduga: ${e instanceof Error ? e.message : String(e)}`, "INTERNAL_ERROR", 2));
  }
}

// Swarm patch (row 107, row 11 M5): the direct-run entry guard block is removed so that
// main() (argv-driven REAL_FS writes) can never run as a side effect of loading this module inside
// the host bundle. Callers invoke main(argv, io) explicitly.
