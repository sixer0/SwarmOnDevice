/**
 * Log terstruktur tahan lama layanan ingest (S48).
 *
 * Sink: JSONL harian `<STUDIO_WORKSPACE_ROOT>/logs/ingest/ingest-YYYY-MM-DD.jsonl`
 * (pola sama dengan layanan revisi S50) + console. Tanpa isi dokumen/PII:
 * hanya nomor dokumen, slug templat, kode, jumlah, stack.
 */
import { randomUUID } from "node:crypto";
import { appendJsonlDaily } from "../../http/jsonl";

export const INGEST_SOURCE = "studio.services.ingest";

export interface IngestLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: typeof INGEST_SOURCE;
  message: string;
  correlationId: string;
  code?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

export type IngestLogSink = (e: IngestLogEntry) => void | Promise<void>;

async function fileSink(e: IngestLogEntry): Promise<void> {
  // FIX-1 (S87 L-05, S85 R-16): sink JSONL bersama (retensi + batas ukuran).
  await appendJsonlDaily("ingest", "ingest", e);
}

let sink: IngestLogSink = fileSink;

/** Ganti sink (uji / sink DB); null = kembali ke sink berkas default. */
export function setIngestLogSink(s: IngestLogSink | null): void {
  sink = s ?? fileSink;
}

export function newIngestCorrelationId(): string {
  return randomUUID();
}

/** Tulis log; kegagalan sink tidak pernah memutus layanan (dilaporkan ke console). */
export function ingestLog(e: Omit<IngestLogEntry, "timestamp" | "source">): void {
  const entry: IngestLogEntry = { timestamp: new Date().toISOString(), source: INGEST_SOURCE, ...e };
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.info(line);
  const fail = (err: unknown) =>
    console.error(JSON.stringify({ source: INGEST_SOURCE, level: "error", message: "ingest log sink failed", detail: String(err) }));
  try {
    Promise.resolve(sink(entry)).catch(fail);
  } catch (err) {
    fail(err);
  }
}
