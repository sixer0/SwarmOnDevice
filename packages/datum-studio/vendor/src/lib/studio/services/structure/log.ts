/**
 * Log terstruktur tahan lama repositori struktur (SR-10).
 *
 * Sink: JSONL harian `<STUDIO_WORKSPACE_ROOT>/logs/structure/structure-YYYY-MM-DD.jsonl`
 * lewat helper bersama `http/jsonl` (retensi + batas ukuran), ditambah console.
 * Tanpa isi dokumen/PII: hanya id dokumen/revisi, pid, alamat, kode, stack.
 */
import { randomUUID } from "node:crypto";
import { appendJsonlDaily } from "../../http/jsonl";

export const STRUCTURE_SOURCE = "studio.services.structure";

export interface StructureLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: typeof STRUCTURE_SOURCE;
  message: string;
  correlationId: string;
  code?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

export type StructureLogSink = (e: StructureLogEntry) => void | Promise<void>;

async function fileSink(e: StructureLogEntry): Promise<void> {
  await appendJsonlDaily("structure", "structure", e);
}

let sink: StructureLogSink = fileSink;

/** Ganti sink (uji / sink DB); null = kembali ke sink berkas bawaan. */
export function setStructureLogSink(s: StructureLogSink | null): void {
  sink = s ?? fileSink;
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** Tulis log; kegagalan sink tidak pernah memutus layanan (dilaporkan ke console). */
export function structureLog(e: Omit<StructureLogEntry, "timestamp" | "source">): void {
  const entry: StructureLogEntry = { timestamp: new Date().toISOString(), source: STRUCTURE_SOURCE, ...e };
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.info(line);
  const fail = (err: unknown) =>
    console.error(
      JSON.stringify({ source: STRUCTURE_SOURCE, level: "error", message: "structure log sink failed", detail: String(err) }),
    );
  try {
    Promise.resolve(sink(entry)).catch(fail);
  } catch (err) {
    fail(err);
  }
}

/** Catat galat dengan kode (bila ada) dan stack. */
export function logStructureError(
  correlationId: string,
  message: string,
  err: unknown,
  context?: Record<string, unknown>,
): void {
  const code =
    err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;
  structureLog({
    level: "error",
    message: `${message}: ${err instanceof Error ? err.message : String(err)}`,
    correlationId,
    code,
    stack_trace: err instanceof Error ? err.stack : undefined,
    context,
  });
}
