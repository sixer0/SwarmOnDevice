/**
 * Log terstruktur layanan templat (S49).
 *
 * Sink default tahan-restart: JSONL harian di
 * `<STUDIO_WORKSPACE_ROOT>/logs/templates/templates-YYYY-MM-DD.jsonl` (rotasi
 * per hari; skema DB bersama tidak memuat tabel log) + `console` untuk dev.
 * Tanpa PII/isi: hanya id/slug templat, nomor versi, kode galat, kunci
 * parameter yang ditolak.
 */
import { appendJsonlDaily } from "../../http/jsonl";

export interface TemplatesLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: "studio.services.templates";
  message: string;
  /** Kode galat Studio atau penanda peristiwa. */
  code?: string;
  /** Korelasi per operasi layanan. */
  correlationId?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

export type TemplatesLogSink = (e: TemplatesLogEntry) => void | Promise<void>;

async function fileSink(e: TemplatesLogEntry): Promise<void> {
  // FIX-1 (S87 L-05, S85 R-16): sink JSONL bersama (retensi + batas ukuran).
  await appendJsonlDaily("templates", "templates", e);
}

let sink: TemplatesLogSink = fileSink;

/** Ganti sink log (null = kembali ke sink berkas default). Dipakai uji. */
export function setTemplatesLogSink(s: TemplatesLogSink | null): void {
  sink = s ?? fileSink;
}

function reportSinkFailure(err: unknown): void {
  console.error(
    JSON.stringify({ source: "studio.services.templates", level: "error", message: "templates log sink failed", detail: String(err) }),
  );
}

/** Tulis log; kegagalan sink tidak pernah memutus operasi layanan (dilaporkan ke console). */
export function templatesLog(e: Omit<TemplatesLogEntry, "timestamp" | "source">): void {
  const entry: TemplatesLogEntry = { timestamp: new Date().toISOString(), source: "studio.services.templates", ...e };
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
