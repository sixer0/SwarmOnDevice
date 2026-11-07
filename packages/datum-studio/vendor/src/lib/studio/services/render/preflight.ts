/**
 * Gerbang awal PDF dan penanda hasil sebagian (FIX-H1; D-321 friksi Hermes C1, D-322).
 *
 * 1. `assertPdfRenderReady(formats)`: bila format efektif memuat PDF dan
 *    render-env tidak siap (mis. fon per-pengguna belum dimuat di sesi Windows),
 *    tolak SEBELUM job dibuat dengan 503 `PDF_ENGINE_UNAVAILABLE` (kode yang ada,
 *    01_specs.md §6.1: "hanya PDF diminta -> 503"; panduan §12: render ulang
 *    setelah `GET /render-env` siap). `details.stage = "preflight"` dan
 *    `jobCreated: false` membedakannya dari galat PDF di dalam job.
 *    Tanpa PDF gerbang tidak memeriksa apa pun (DOCX/HTML tetap jalan).
 * 2. `renderOutcomeMarker(job, outputs, errors)`: `partial` + `failedFormats`
 *    untuk respons R17 (200) dan R09 (201) beserta header
 *    `X-Studio-Render-Status`, agar job PARTIAL tidak terbaca sebagai sukses.
 *    Kode HTTP sengaja tidak diganti (bukan 207): 207 adalah Multi-Status WebDAV
 *    dengan badan multistatus, `fetch().ok` tetap true sehingga tidak menambah
 *    keterdeteksian, dan R09 harus tetap 201 karena baris artefak sudah dibuat.
 *
 * Pesan `causes` berbahasa awam dan tidak memuat path server; rincian teknis
 * tetap di `GET /api/studio/render-env` (R11, butuh sesi).
 *
 * Swarm patch (row 31c; decisions C60/C65; studio spec §4): the readiness default is the render
 * bridge (`./readiness.ts` `bridgePdfReadiness`: handshake + locked-down window), the only PDF engine
 * in Swarm (row 32 prints Studio's HTML through the bridge `pdf` op). `Retry-After` follows that
 * readiness cache window. The two cause rules of the old desktop-office engine are replaced by two
 * bridge rules (`PDF_ENGINE_MISSING` = bridge not reachable, `RENDER_SANDBOX_INACTIVE` = window not
 * locked down); the other rules, the codes and the `details` keys are unchanged.
 */
import type { OutputFileDto, RenderEnvReadiness, RenderJobDto, RenderJobError, StudioOutputFormat } from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { errorMessageOf } from "./common";
import { normalizeFormats } from "./naming";
import { BRIDGE_READINESS_TTL_MS, bridgePdfReadiness } from "./readiness";

export const PDF_PREFLIGHT_STAGE = "preflight";
const DOC_FORMATS: ReadonlySet<StudioOutputFormat> = new Set<StudioOutputFormat>(["DOCX", "PDF", "HTML"]);
export const RENDER_STATUS_HEADER = "X-Studio-Render-Status";
export const RENDER_ENV_STATUS_ENDPOINT = "GET /api/studio/render-env";
// FIX-CLI (D-340, m-5): pesan awam Indonesia; kode `PDF_ENGINE_UNAVAILABLE` dan kunci `details` tetap.
export const PDF_NOT_READY_MESSAGE = "Mesin PDF di server belum siap, jadi permintaan render ditolak sebelum job dibuat; isi dokumen tidak berubah";

/** Detik sampai cek kesiapan berikutnya tidak lagi dari cache (Swarm: jendela cache kesiapan bridge). */
export const PDF_PREFLIGHT_RETRY_AFTER_SEC = Math.ceil(BRIDGE_READINESS_TTL_MS / 1000);

export type PdfNotReadyCauseCode =
  | "FONTS_NOT_LOADED_IN_SESSION"
  | "FONTS_NOT_REGISTERED"
  | "FONT_FILES_MISSING"
  | "FONT_FILES_CHANGED"
  | "FONT_FILES_UNREADABLE"
  | "FONT_REGISTRY_UNREADABLE"
  | "SESSION_FONT_CHECK_FAILED"
  | "PDF_ENGINE_MISSING"
  | "RENDER_SANDBOX_INACTIVE"
  | "RENDER_ENV_MANIFEST"
  | "READINESS_CHECK_FAILED"
  | "OTHER";

export interface PdfNotReadyCause {
  code: PdfNotReadyCauseCode;
  /** Bahasa awam, tanpa path server. */
  message: string;
  /** Jumlah butir teknis yang digabung ke penyebab ini. */
  count: number;
}

/** `details` 503 PDF_ENGINE_UNAVAILABLE tahap preflight. */
export interface PdfNotReadyDetails {
  stage: typeof PDF_PREFLIGHT_STAGE;
  jobCreated: false;
  reason: string;
  causes: PdfNotReadyCause[];
  retryable: true;
  /** Sebagian besar penyebab butuh tindakan operator server sebelum dicoba lagi. */
  requiresOperatorAction: boolean;
  retryAfterSec: number;
  requestedFormats: Array<Lowercase<StudioOutputFormat>>;
  /** Siap dipakai sebagai `formats` di badan R17 (tanpa pdf). */
  suggestedFormats: Array<"docx" | "html">;
  statusEndpoint: string;
  checkedAt: string | null;
}

const REASON =
  "Mesin PDF di server belum siap, jadi PDF tidak bisa dibuat sekarang. Tidak ada job render yang dibuat dan isi dokumen tidak berubah. " +
  "Kirim ulang tanpa pdf di formats untuk mendapat DOCX/HTML sekarang, atau coba lagi setelah mesin PDF siap.";

interface CauseRule {
  code: PdfNotReadyCauseCode;
  test: RegExp;
  message: (n: number) => string;
  operator: boolean;
}

// Urutan penting: aturan pertama yang cocok menang (pola jendela sandbox sebelum pola bridge umum).
const CAUSE_RULES: readonly CauseRule[] = [
  {
    code: "FONTS_NOT_LOADED_IN_SESSION",
    test: /font family not loaded in session/i,
    message: (n) =>
      `Fon per-pengguna (${n} berkas fon) sudah terpasang tetapi belum dimuat di sesi Windows yang menjalankan server; operator perlu keluar lalu masuk kembali (sign out/sign in) sesi Windows itu.`,
    operator: true,
  },
  {
    code: "FONTS_NOT_REGISTERED",
    test: /font not registered/i,
    message: (n) => `${n} fon render belum terdaftar untuk pengguna Windows server; administrator perlu mendaftarkan fon lingkungan render.`,
    operator: true,
  },
  {
    code: "FONT_FILES_MISSING",
    test: /font file missing/i,
    message: (n) => `${n} berkas fon render tidak ditemukan di server; administrator perlu memulihkan berkas fon.`,
    operator: true,
  },
  {
    code: "FONT_FILES_CHANGED",
    test: /font sha256 mismatch/i,
    message: (n) => `${n} berkas fon render berbeda dari versi yang dikalibrasi; administrator perlu memulihkan berkas fon yang benar.`,
    operator: true,
  },
  {
    code: "FONT_FILES_UNREADABLE",
    test: /font name table not readable/i,
    message: (n) => `${n} berkas fon render tidak terbaca; administrator perlu memeriksa berkas fon.`,
    operator: true,
  },
  {
    code: "FONT_REGISTRY_UNREADABLE",
    test: /font registry not readable/i,
    message: () => "Daftar fon pengguna Windows server tidak terbaca; administrator perlu memeriksa akun yang menjalankan server.",
    operator: true,
  },
  {
    code: "SESSION_FONT_CHECK_FAILED",
    test: /session font (check skipped|enumeration failed)/i,
    message: () => "Server tidak dapat memeriksa fon yang dimuat di sesi Windows; coba lagi nanti atau minta operator memeriksa sesi server.",
    operator: false,
  },
  {
    code: "RENDER_SANDBOX_INACTIVE",
    test: /sandbox is not active|not locked down/i,
    message: () => "Jendela render PDF di aplikasi Swarm tidak terkunci (sandbox tidak aktif), jadi PDF ditolak; mulai ulang aplikasi Swarm.",
    operator: true,
  },
  {
    code: "PDF_ENGINE_MISSING",
    test: /render bridge/i,
    message: () => "Mesin PDF (jembatan render aplikasi Swarm) tidak terjangkau; jalankan Studio dari aplikasi Swarm yang sedang terbuka, lalu coba lagi.",
    operator: true,
  },
  {
    code: "RENDER_ENV_MANIFEST",
    test: /manifest/i,
    message: () => "Daftar acuan lingkungan render di server tidak terbaca; administrator perlu memperbaikinya.",
    operator: true,
  },
  {
    code: "READINESS_CHECK_FAILED",
    test: /readiness check failed/i,
    message: () => "Pemeriksaan kesiapan mesin PDF gagal dijalankan; coba lagi nanti.",
    operator: false,
  },
];

const OTHER_RULE: CauseRule = {
  code: "OTHER",
  test: /./,
  message: () => `Lingkungan render belum siap; rincian teknis ada di ${RENDER_ENV_STATUS_ENDPOINT}.`,
  operator: true,
};

/** Kelompokkan `readiness.errors` teknis menjadi penyebab awam (urutan kemunculan pertama). */
export function layCausesOf(errors: readonly string[]): { causes: PdfNotReadyCause[]; requiresOperatorAction: boolean } {
  const groups = new Map<PdfNotReadyCauseCode, { rule: CauseRule; count: number }>();
  for (const e of errors) {
    const rule = CAUSE_RULES.find((r) => r.test.test(e)) ?? OTHER_RULE;
    const g = groups.get(rule.code);
    if (g) g.count++;
    else groups.set(rule.code, { rule, count: 1 });
  }
  if (groups.size === 0) groups.set("OTHER", { rule: OTHER_RULE, count: 0 });
  const list = [...groups.values()];
  return {
    causes: list.map(({ rule, count }) => ({ code: rule.code, message: rule.message(count), count })),
    requiresOperatorAction: list.some(({ rule }) => rule.operator),
  };
}

function lower<T extends StudioOutputFormat>(f: T): Lowercase<T> {
  return f.toLowerCase() as Lowercase<T>;
}

/** `formats` R17 tanpa pdf: format dokumen lain yang diminta, atau docx+html bila hanya pdf. */
export function suggestedFormatsWithoutPdf(formats: readonly StudioOutputFormat[]): Array<"docx" | "html"> {
  const rest = formats.filter((f): f is "DOCX" | "HTML" => f === "DOCX" || f === "HTML").map((f) => lower(f));
  return rest.length > 0 ? rest : ["docx", "html"];
}

export function pdfNotReadyDetails(
  formats: readonly StudioOutputFormat[],
  readiness: Pick<RenderEnvReadiness, "errors" | "checkedAt"> | null,
  failure?: unknown,
): PdfNotReadyDetails {
  const errors = readiness ? readiness.errors : [`render-env readiness check failed: ${errorMessageOf(failure)}`];
  const { causes, requiresOperatorAction } = layCausesOf(errors);
  return {
    stage: PDF_PREFLIGHT_STAGE,
    jobCreated: false,
    reason: REASON,
    causes,
    retryable: true,
    requiresOperatorAction,
    retryAfterSec: PDF_PREFLIGHT_RETRY_AFTER_SEC,
    requestedFormats: formats.map((f) => lower(f)),
    suggestedFormats: suggestedFormatsWithoutPdf(formats),
    statusEndpoint: RENDER_ENV_STATUS_ENDPOINT,
    checkedAt: readiness?.checkedAt ?? null,
  };
}

export type ReadinessFn = () => Promise<Pick<RenderEnvReadiness, "ready" | "errors" | "checkedAt">>;

/**
 * Lempar 503 `PDF_ENGINE_UNAVAILABLE` (tahap preflight) bila `formats` memuat PDF
 * dan render-env tidak siap. Tidak memeriksa apa pun bila PDF tidak diminta.
 * Cek kesiapan memakai cache C15, jadi murah dipanggil per permintaan.
 */
export async function assertPdfRenderReady(
  formats: readonly string[] | undefined,
  readiness: ReadinessFn = bridgePdfReadiness,
): Promise<void> {
  const fmts = normalizeFormats([...(formats ?? [])]);
  if (!fmts.includes("PDF")) return;
  let r: Awaited<ReturnType<ReadinessFn>> | null = null;
  let failure: unknown;
  try {
    r = await readiness();
  } catch (e) {
    failure = e;
  }
  if (r?.ready) return;
  throw new StudioEngineError("PDF_ENGINE_UNAVAILABLE", PDF_NOT_READY_MESSAGE, pdfNotReadyDetails(fmts, r, failure));
}

/** Benar bila galat adalah penolakan preflight PDF (bukan galat PDF di dalam job). */
export function isPdfPreflightRejection(e: unknown): e is StudioEngineError & { details: PdfNotReadyDetails } {
  return (
    e instanceof StudioEngineError &&
    e.code === "PDF_ENGINE_UNAVAILABLE" &&
    typeof e.details === "object" &&
    e.details !== null &&
    (e.details as { stage?: unknown }).stage === PDF_PREFLIGHT_STAGE
  );
}

/** Pasang `Retry-After` (detik) pada respons. */
export function withRetryAfterHeader(res: Response, sec: number): Response {
  const headers = new Headers(res.headers);
  headers.set("Retry-After", String(Math.max(1, Math.ceil(sec))));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Penanda hasil render untuk badan respons R17/R09. */
export interface RenderOutcomeMarker {
  /** true bila job PARTIAL: sebagian format/berkas gagal. Selalu ada. */
  partial: boolean;
  /** Format diminta yang gagal (huruf besar, sama dengan `job.formats`); kosong bila tidak ada. */
  failedFormats: StudioOutputFormat[];
}

/**
 * `failedFormats` = format job tanpa berkas keluaran, digabung format yang disebut
 * `errors[].format`. Pada render dokumen (ada berkas PRIMARY DOCX/PDF/HTML),
 * SVG/PNG tanpa berkas tidak dihitung gagal karena dokumen bisa saja tanpa figur;
 * kegagalan figur tetap masuk lewat `errors[].format`. `partial` mengikuti status
 * job, sehingga job PARTIAL tanpa format gagal (mis. galat lint) tetap ditandai.
 */
export function renderOutcomeMarker(
  job: Pick<RenderJobDto, "status" | "formats">,
  outputs: ReadonlyArray<Pick<OutputFileDto, "format" | "role">>,
  errors: ReadonlyArray<Pick<RenderJobError, "format">> = [],
): RenderOutcomeMarker {
  const produced = new Set(outputs.map((o) => o.format));
  const docRender = outputs.some((o) => o.role === "PRIMARY" && DOC_FORMATS.has(o.format));
  const failed = new Set<StudioOutputFormat>();
  if (job.status !== "SUCCEEDED") {
    for (const f of job.formats) {
      if (produced.has(f)) continue;
      if (docRender && !DOC_FORMATS.has(f)) continue;
      failed.add(f);
    }
  }
  for (const e of errors) if (e.format && job.formats.includes(e.format)) failed.add(e.format);
  return { partial: job.status === "PARTIAL", failedFormats: job.formats.filter((f) => failed.has(f)) };
}

/** Header status job untuk respons sukses render (R17/R09). */
export function renderStatusHeaders(job: Pick<RenderJobDto, "status">): Record<string, string> {
  return { [RENDER_STATUS_HEADER]: job.status };
}
