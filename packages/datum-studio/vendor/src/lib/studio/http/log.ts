/**
 * Log terstruktur tahan-restart untuk route Studio (IP-08, F-024).
 *
 * Sink: console (level sesuai) + JSONL harian
 * `<STUDIO_WORKSPACE_ROOT>/logs/api/studio-api-YYYY-MM-DD.jsonl`. Satu baris =
 * satu objek JSON berkolom tetap (timestamp, level, source, message,
 * correlationId, route, method, code, status, stack_trace, context). Tanpa isi
 * dokumen/berkas dan tanpa PII: pemanggil hanya mengisi id, kode, angka.
 *
 * Kegagalan sink berkas tidak pernah memutus permintaan; dilaporkan ke console.
 * Hanya runtime node.
 */
import path from "node:path";
import { getStudioEnv } from "@/lib/studio/contract/env";
import { appendJsonlDaily } from "./jsonl";

export const STUDIO_API_SOURCE = "studio.api";

export type StudioLogLevel = "info" | "warn" | "error";

export interface StudioApiLogEntry {
  timestamp: string;
  level: StudioLogLevel;
  source: string;
  message: string;
  correlationId: string;
  route?: string;
  method?: string;
  code?: string;
  status?: number;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

/** Masukan log: `timestamp` diisi otomatis; `source` bawaan `studio.api`. */
export type StudioApiLogInput = Omit<StudioApiLogEntry, "timestamp" | "source"> & { source?: string };

/** Direktori log API (di bawah akar Studio). Melempar bila env Studio tidak sah (KT-03). */
export function apiLogDir(): string {
  return path.join(getStudioEnv().workspaceRoot, "logs", "api");
}

async function appendLogFile(entry: StudioApiLogEntry): Promise<void> {
  // FIX-1 (S87 L-05, S85 R-16): sink JSONL bersama (retensi + batas ukuran).
  await appendJsonlDaily("api", "studio-api", entry);
}

function reportSinkFailure(source: string, err: unknown): void {
  console.error(JSON.stringify({ source, level: "error", message: "studio api log sink failed", detail: String(err) }));
}

/**
 * Tulis satu entri log. Medan tambahan pada masukan (mis. hasil spread
 * `ReqCtx`) ikut tertulis apa adanya kecuali `timestamp` yang selalu baru.
 */
export function apiLog(input: StudioApiLogInput): void {
  const entry: StudioApiLogEntry = { ...input, timestamp: new Date().toISOString(), source: input.source ?? STUDIO_API_SOURCE };
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.info(line);
  try {
    appendLogFile(entry).catch((err: unknown) => reportSinkFailure(entry.source, err));
  } catch (err) {
    // getStudioEnv dapat melempar STORAGE_ROOT_FORBIDDEN secara sinkron.
    reportSinkFailure(entry.source, err);
  }
}
