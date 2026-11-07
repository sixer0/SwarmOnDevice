/**
 * Log terstruktur layanan kerangka (SR-06).
 *
 * Sink default tahan-restart: JSONL harian bersama (retensi + batas ukuran) di
 * `<STUDIO_WORKSPACE_ROOT>/logs/skeleton/skeleton-YYYY-MM-DD.jsonl` + `console`.
 * Tanpa PII/isi: hanya id versi templat, slotKey, kunci parameter, kode galat.
 */
import { appendJsonlDaily } from "../../http/jsonl";

export interface SkeletonLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: "studio.services.skeleton";
  message: string;
  /** Kode galat Studio atau penanda peristiwa. */
  code?: string;
  correlationId?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

export type SkeletonLogSink = (e: SkeletonLogEntry) => void | Promise<void>;

async function fileSink(e: SkeletonLogEntry): Promise<void> {
  await appendJsonlDaily("skeleton", "skeleton", e);
}

let sink: SkeletonLogSink = fileSink;

/** Ganti sink log (null = kembali ke sink berkas default). Dipakai uji. */
export function setSkeletonLogSink(s: SkeletonLogSink | null): void {
  sink = s ?? fileSink;
}

function reportSinkFailure(err: unknown): void {
  console.error(JSON.stringify({ source: "studio.services.skeleton", level: "error", message: "skeleton log sink failed", detail: String(err) }));
}

/** Tulis log; kegagalan sink tidak pernah memutus operasi layanan (dilaporkan ke console). */
export function skeletonLog(e: Omit<SkeletonLogEntry, "timestamp" | "source">): void {
  const entry: SkeletonLogEntry = { timestamp: new Date().toISOString(), source: "studio.services.skeleton", ...e };
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
