/**
 * Log terstruktur tahan lama layanan revisi (S50).
 *
 * Sink: JSONL harian di `<STUDIO_WORKSPACE_ROOT>/logs/revisions/revisions-YYYY-MM-DD.jsonl`
 * (rotasi per hari, pola sama dengan engine/soffice S92) + console untuk dev.
 * Tanpa isi dokumen/PII: hanya id dokumen/revisi, alamat, kode, stack.
 */
import { randomUUID } from "node:crypto";
import { appendJsonlDaily } from "../../http/jsonl";

export const REVISIONS_SOURCE = "studio.services.revisions";

export interface RevisionLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: typeof REVISIONS_SOURCE;
  message: string;
  correlationId: string;
  code?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

export type RevisionLogSink = (e: RevisionLogEntry) => void | Promise<void>;

async function fileSink(e: RevisionLogEntry): Promise<void> {
  // FIX-1 (S87 L-05, S85 R-16): sink JSONL bersama (retensi + batas ukuran).
  await appendJsonlDaily("revisions", "revisions", e);
}

let sink: RevisionLogSink = fileSink;

/** Ganti sink (uji / sink DB); null = kembali ke sink berkas default. */
export function setRevisionLogSink(s: RevisionLogSink | null): void {
  sink = s ?? fileSink;
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** Tulis log; kegagalan sink tidak pernah memutus layanan (dilaporkan ke console). */
export function revisionLog(e: Omit<RevisionLogEntry, "timestamp" | "source">): void {
  const entry: RevisionLogEntry = { timestamp: new Date().toISOString(), source: REVISIONS_SOURCE, ...e };
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.info(line);
  const fail = (err: unknown) =>
    console.error(
      JSON.stringify({ source: REVISIONS_SOURCE, level: "error", message: "revision log sink failed", detail: String(err) }),
    );
  try {
    Promise.resolve(sink(entry)).catch(fail);
  } catch (err) {
    fail(err);
  }
}

/** Catat galat dengan kode (bila StudioEngineError) dan stack. */
export function logError(correlationId: string, message: string, err: unknown, context?: Record<string, unknown>): void {
  const code =
    err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;
  revisionLog({
    level: "error",
    message: `${message}: ${err instanceof Error ? err.message : String(err)}`,
    correlationId,
    code,
    stack_trace: err instanceof Error ? err.stack : undefined,
    context,
  });
}
