/**
 * Log terstruktur tahan lama layanan kontrak (DC-07).
 *
 * Sink: JSONL harian `<STUDIO_WORKSPACE_ROOT>/logs/contracts/contracts-YYYY-MM-DD.jsonl`
 * lewat helper bersama `http/jsonl` (retensi + batas ukuran), ditambah console.
 * Tanpa isi payload: hanya kode galat, jumlah, stack (pola `services/query/log.ts`).
 */
import { randomUUID } from "node:crypto";
import { appendJsonlDaily } from "../../http/jsonl";

export const CONTRACTS_SOURCE = "studio.services.contracts";

export interface ContractsLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: typeof CONTRACTS_SOURCE;
  message: string;
  correlationId: string;
  code?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

export type ContractsLogSink = (e: ContractsLogEntry) => void | Promise<void>;

async function fileSink(e: ContractsLogEntry): Promise<void> {
  await appendJsonlDaily("contracts", "contracts", e);
}

let sink: ContractsLogSink = fileSink;

/** Ganti sink (uji / sink DB); null = kembali ke sink berkas bawaan. */
export function setContractsLogSink(s: ContractsLogSink | null): void {
  sink = s ?? fileSink;
}

export function newContractsCorrelationId(): string {
  return randomUUID();
}

/** Tulis log; kegagalan sink tidak pernah memutus layanan (dilaporkan ke console). */
export function contractsLog(e: Omit<ContractsLogEntry, "timestamp" | "source">): void {
  const entry: ContractsLogEntry = { timestamp: new Date().toISOString(), source: CONTRACTS_SOURCE, ...e };
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.info(line);
  const failSink = (err: unknown) =>
    console.error(JSON.stringify({ source: CONTRACTS_SOURCE, level: "error", message: "contracts log sink failed", detail: String(err) }));
  try {
    Promise.resolve(sink(entry)).catch(failSink);
  } catch (err) {
    failSink(err);
  }
}

/** Catat galat dengan kode (bila ada) dan stack. */
export function logContractsError(correlationId: string, message: string, err: unknown, context?: Record<string, unknown>): void {
  const code =
    err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;
  contractsLog({
    level: "error",
    message: `${message}: ${err instanceof Error ? err.message : String(err)}`,
    correlationId,
    code,
    stack_trace: err instanceof Error ? err.stack : undefined,
    context,
  });
}
