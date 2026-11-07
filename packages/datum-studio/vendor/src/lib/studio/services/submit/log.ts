/**
 * Log terstruktur tahan lama layanan kiriman parsial (SR-13).
 *
 * Sink: JSONL harian `<STUDIO_WORKSPACE_ROOT>/logs/submit/submit-YYYY-MM-DD.jsonl`
 * (pola sama dengan layanan ingest/revisi, sink bersama `appendJsonlDaily`)
 * + console. Tanpa isi dokumen/PII: hanya id dokumen, nomor revisi, lingkup,
 * kode, jumlah, stack.
 */
import { randomUUID } from "node:crypto";
import { appendJsonlDaily } from "../../http/jsonl";
import { StudioEngineError } from "../../contract/errors";

export const SUBMIT_SOURCE = "studio.services.submit";

export interface SubmitLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: typeof SUBMIT_SOURCE;
  message: string;
  correlationId: string;
  code?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

export type SubmitLogSink = (e: SubmitLogEntry) => void | Promise<void>;

async function fileSink(e: SubmitLogEntry): Promise<void> {
  await appendJsonlDaily("submit", "submit", e);
}

let sink: SubmitLogSink = fileSink;

/** Ganti sink (uji / sink DB); null = kembali ke sink berkas bawaan. */
export function setSubmitLogSink(s: SubmitLogSink | null): void {
  sink = s ?? fileSink;
}

export function newSubmitCorrelationId(): string {
  return randomUUID();
}

/** Tulis log; kegagalan sink tidak pernah memutus layanan (dilaporkan ke console). */
export function submitLog(e: Omit<SubmitLogEntry, "timestamp" | "source">): void {
  const entry: SubmitLogEntry = { timestamp: new Date().toISOString(), source: SUBMIT_SOURCE, ...e };
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.info(line);
  const fail = (err: unknown) =>
    console.error(JSON.stringify({ source: SUBMIT_SOURCE, level: "error", message: "submit log sink failed", detail: String(err) }));
  try {
    Promise.resolve(sink(entry)).catch(fail);
  } catch (err) {
    fail(err);
  }
}

/** Catat galat: StudioEngineError = warn (galat operasional), selain itu error + stack. */
export function submitLogError(correlationId: string, message: string, err: unknown, context?: Record<string, unknown>): void {
  if (err instanceof StudioEngineError) {
    submitLog({ level: "warn", message, correlationId, code: err.code, context: { ...context, detail: err.message } });
    return;
  }
  const e = err instanceof Error ? err : new Error(String(err));
  submitLog({ level: "error", message, correlationId, code: "INTERNAL", stack_trace: e.stack, context: { ...context, detail: e.message } });
}
