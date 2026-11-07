/**
 * Log terstruktur layanan penyimpanan Studio (S52).
 *
 * Dua kegunaan:
 * 1. `storageLog` — log galat/peristiwa layanan ini sendiri. Sink default:
 *    `console` + JSONL harian `<akar>/logs/storage/storage-YYYY-MM-DD.jsonl`
 *    (tahan restart; pola sama dengan sink default engine/soffice S92). S51
 *    boleh mengalihkan lewat `setStorageLogSink` (mis. ke log job di DB).
 * 2. `createLayoutLogSink` — sink JSONL yang menulis DI BAWAH akar menurut tata
 *    letak §7.2 (direktori revisi/artefak hasil `docDir`/`artifactDir`), untuk
 *    dipasang pemanggil ke `setSofficeLogSink` / `setBrowserLogSink` bila
 *    dikehendaki. Tidak pernah menulis ke luar akar (guard `resolveSafe`).
 *
 * Tanpa isi dokumen/PII: hanya pesan, kode, path relatif, angka.
 */
import { appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { appendJsonlDaily } from "../../http/jsonl";
import { assertRealInsideRoot, assertSafeSegment, resolveSafe } from "./paths";

export const STORAGE_SOURCE = "studio.services.storage";

export interface StorageLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  code?: string;
  correlationId?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

export type StorageLogSink = (e: StorageLogEntry) => void | Promise<void>;

async function defaultFileSink(e: StorageLogEntry): Promise<void> {
  // FIX-1 (S87 L-05, S85 R-16): sink JSONL bersama (retensi + batas ukuran).
  await appendJsonlDaily("storage", "storage", e);
}

let sink: StorageLogSink = defaultFileSink;

/** Ganti sink log layanan penyimpanan (null = kembali ke sink berkas default). */
export function setStorageLogSink(s: StorageLogSink | null): void {
  sink = s ?? defaultFileSink;
}

function reportSinkFailure(err: unknown): void {
  console.error(JSON.stringify({ source: STORAGE_SOURCE, level: "error", message: "storage log sink failed", detail: String(err) }));
}

/** Tulis log; kegagalan sink tidak pernah memutus operasi (dilaporkan ke console). */
export function storageLog(e: Omit<StorageLogEntry, "timestamp" | "source">): void {
  const entry: StorageLogEntry = { timestamp: new Date().toISOString(), source: STORAGE_SOURCE, ...e };
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.info(line);
  try {
    Promise.resolve(sink(entry)).catch(reportSinkFailure);
  } catch (err) {
    reportSinkFailure(err);
  }
}

/** Ringkas galat untuk `stack_trace`/`context` tanpa membocorkan isi berkas. */
export function errorFields(err: unknown): { stack_trace?: string; context: Record<string, unknown> } {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return { stack_trace: err.stack, context: { errorName: err.name, errorMessage: err.message, ...(code ? { errno: code } : {}) } };
  }
  return { context: { error: String(err) } };
}

// ── Sink tata letak (untuk setSofficeLogSink / setBrowserLogSink) ─────────

/**
 * Entri yang diterima sink tata letak. Cukup longgar agar `SofficeLogEntry`
 * (S92) dan entri browser (S25, `RenderLogEntry & { source }`) sama-sama
 * dapat diteruskan langsung.
 */
export interface LayoutLogInput {
  timestamp?: string;
  at?: string;
  level: "info" | "warn" | "error";
  source?: string;
  message: string;
  code?: string;
  correlationId?: string;
  address?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
  [extra: string]: unknown;
}

export type LayoutLogSink = (e: LayoutLogInput) => Promise<void>;

export interface LayoutLogSinkOptions {
  /** Direktori relatif akar (hasil `docDir` / `artifactDir`), pemisah `/`. */
  relDir: string;
  /** Nama berkas log (satu segmen). Default `Log Render.jsonl` (DATUM-38: tanpa garis bawah). */
  fileName?: string;
}

export const DEFAULT_LAYOUT_LOG_FILE = "Log Render.jsonl";

/**
 * FIX-SEC N-05 (SR-57, D-247): batas ukuran satu berkas log tata letak. Umur
 * berkas mengikuti direktori revisi/artefak tempatnya (dihapus bersama
 * folder itu), jadi yang dibatasi di sini adalah pertumbuhannya: bawaan
 * 10 MiB (satu render menulis puluhan sampai ratusan baris kecil, jadi batas
 * ini hanya tercapai oleh loop/galat berulang). Env opsional
 * `STUDIO_LAYOUT_LOG_MAX_BYTES` (minimal 64 KiB). Entri di atas batas tidak
 * ditulis; satu peringatan console per sink.
 */
export const LAYOUT_LOG_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
const LAYOUT_LOG_MAX_BYTES_MIN = 64 * 1024;

export function layoutLogMaxBytes(): number {
  const raw = process.env.STUDIO_LAYOUT_LOG_MAX_BYTES;
  if (raw === undefined || raw.trim() === "") return LAYOUT_LOG_MAX_BYTES_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= LAYOUT_LOG_MAX_BYTES_MIN ? n : LAYOUT_LOG_MAX_BYTES_DEFAULT;
}

/**
 * Sink JSONL di dalam tata letak §7.2. Path dibangun dan dijaga sekali saat
 * dibuat (PATH_OUTSIDE_ROOT bila keluar akar); direktori dibuat malas saat
 * entri pertama ditulis, sehingga sink yang tidak pernah dipanggil tidak
 * meninggalkan berkas.
 */
export function createLayoutLogSink(opts: LayoutLogSinkOptions): LayoutLogSink {
  const fileName = opts.fileName ?? DEFAULT_LAYOUT_LOG_FILE;
  assertSafeSegment(fileName);
  const absDir = resolveSafe(opts.relDir);
  const absFile = path.join(absDir, fileName);
  const maxBytes = layoutLogMaxBytes();
  let ready: Promise<void> | null = null;
  let chain: Promise<void> = Promise.resolve();
  /** Ukuran berkas yang diketahui (dibaca sekali saat entri pertama). */
  let size: number | null = null;
  let capReported = false;

  const ensureDir = (): Promise<void> => {
    if (!ready) {
      ready = (async () => {
        await mkdir(absDir, { recursive: true });
        await assertRealInsideRoot(absDir);
      })();
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  };

  return (e: LayoutLogInput): Promise<void> => {
    const record = { ...e, timestamp: e.timestamp ?? e.at ?? new Date().toISOString(), source: e.source ?? "studio" };
    const line = JSON.stringify(record) + "\n";
    // Antre berurutan agar baris JSONL tidak saling sisip.
    chain = chain
      .then(async () => {
        await ensureDir();
        if (size === null) size = await stat(absFile).then((st) => st.size, () => 0);
        const add = Buffer.byteLength(line, "utf8");
        if (size + add > maxBytes) {
          if (!capReported) {
            capReported = true;
            console.warn(JSON.stringify({ source: STORAGE_SOURCE, level: "warn", message: "layout log size cap reached; further entries dropped", context: { relDir: opts.relDir, fileName, maxBytes } }));
          }
          return;
        }
        await appendFile(absFile, line, "utf8");
        size += add;
      })
      .catch((err: unknown) => {
        reportSinkFailure(err);
      });
    return chain;
  };
}
