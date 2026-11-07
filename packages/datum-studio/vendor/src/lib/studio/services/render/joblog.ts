/**
 * Log job render tahan lama (S51, F-020).
 *
 * Setiap job memegang `JobLog` (entri terstruktur, terbatas). Isinya
 * dipersistenkan ke kolom `StudioRenderJob.engine.log` (DB) setiap kali status
 * job ditulis, sehingga galat jam 3 pagi tetap ada di DB walau proses mati di
 * tengah job. Sink global engine/soffice (S92) dan engine/browser (S25)
 * diarahkan ke sini lewat `setSofficeLogSink` / `setBrowserLogSink` sehingga
 * log soffice tidak lagi ditulis ke `data/studio-workspace/logs/` (di luar tata
 * letak §7.2).
 *
 * Perutean: entri ber-`correlationId` = jobId masuk ke log job itu; entri tanpa
 * korelasi (cek kesiapan, operasi browser) disiarkan ke semua job aktif; bila
 * tidak ada job aktif, disimpan di penyangga yatim (terbatas) dan dilampirkan
 * ke job berikutnya. Tanpa isi dokumen/PII: hanya pesan, kode, konteks teknis.
 */
import type { RenderLogEntry } from "../../contract";
import { setBrowserLogSink, type BrowserLogSink } from "../../engine/browser";
import { setSofficeLogSink, type SofficeLogEntry } from "../../engine/soffice";

export const RENDER_MODULE = "services/render";

/** Batas entri per job (yang lebih lama dari batas tetap dihitung di `dropped`). */
export const JOB_LOG_MAX_ENTRIES = 300;
const ORPHAN_MAX_ENTRIES = 50;
const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_CHARS = 4000;
const MAX_CONTEXT_CHARS = 4000;

export interface JobLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  code?: string;
  /** = jobId. */
  correlationId?: string;
  address?: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...[+${s.length - max}]` : s;
}

function clipContext(ctx: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  try {
    const json = JSON.stringify(ctx);
    if (json.length <= MAX_CONTEXT_CHARS) return JSON.parse(json) as Record<string, unknown>;
    return { truncated: true, preview: json.slice(0, MAX_CONTEXT_CHARS) };
  } catch {
    return { unserializable: true };
  }
}

function sanitize(e: JobLogEntry): JobLogEntry {
  const out: JobLogEntry = {
    timestamp: e.timestamp,
    level: e.level,
    source: e.source,
    message: clip(String(e.message ?? ""), MAX_MESSAGE_CHARS),
  };
  if (e.code) out.code = String(e.code);
  if (e.correlationId) out.correlationId = e.correlationId;
  if (e.address) out.address = e.address;
  if (e.stack_trace) out.stack_trace = clip(e.stack_trace, MAX_STACK_CHARS);
  const ctx = clipContext(e.context);
  if (ctx) out.context = ctx;
  return out;
}

export interface JobLogListener {
  /** Dipanggil untuk entri soffice ber-korelasi job ini (mis. SOFFICE_QUEUED). */
  onSofficeEvent?: (e: SofficeLogEntry) => void;
}

export class JobLog {
  readonly jobId: string;
  private readonly entries: JobLogEntry[] = [];
  private droppedCount = 0;
  listener: JobLogListener = {};

  constructor(jobId: string) {
    this.jobId = jobId;
  }

  push(e: Omit<JobLogEntry, "timestamp" | "correlationId"> & { timestamp?: string; correlationId?: string }): void {
    const entry = sanitize({ ...e, timestamp: e.timestamp ?? new Date().toISOString(), correlationId: e.correlationId ?? this.jobId });
    if (this.entries.length >= JOB_LOG_MAX_ENTRIES) {
      // Pertahankan galat: buang entri info tertua lebih dulu.
      const idx = this.entries.findIndex((x) => x.level === "info");
      if (idx >= 0 && entry.level !== "info") this.entries.splice(idx, 1);
      else {
        this.droppedCount++;
        return;
      }
      this.droppedCount++;
    }
    this.entries.push(entry);
  }

  /** Adapter `RenderContext.log` (engine/* memanggil ini). */
  readonly renderLog = (e: RenderLogEntry): void => {
    this.push({ level: e.level, source: "engine", message: e.message, code: e.code, address: e.address });
  };

  info(message: string, extra?: { code?: string; context?: Record<string, unknown> }): void {
    this.push({ level: "info", source: RENDER_MODULE, message, ...extra });
  }

  warn(message: string, extra?: { code?: string; context?: Record<string, unknown> }): void {
    this.push({ level: "warn", source: RENDER_MODULE, message, ...extra });
  }

  error(message: string, extra?: { code?: string; err?: unknown; context?: Record<string, unknown> }): void {
    const stack = extra?.err instanceof Error ? extra.err.stack : undefined;
    this.push({ level: "error", source: RENDER_MODULE, message, code: extra?.code, stack_trace: stack, context: extra?.context });
  }

  snapshot(): { entries: JobLogEntry[]; dropped: number } {
    return { entries: this.entries.slice(), dropped: this.droppedCount };
  }
}

// ── Registri job aktif + sink global ───────────────────────────────────────

interface SinkState {
  installed: boolean;
  active: Map<string, JobLog>;
  orphans: JobLogEntry[];
}

const STATE_KEY = "__studioRenderJobLogS51";

function state(): SinkState {
  const g = globalThis as unknown as Record<string, SinkState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = { installed: false, active: new Map(), orphans: [] };
    g[STATE_KEY] = s;
  }
  return s;
}

function route(entry: JobLogEntry, correlationId: string | undefined, raw?: SofficeLogEntry): void {
  const s = state();
  const target = correlationId ? s.active.get(correlationId) : undefined;
  if (target) {
    target.push(entry);
    if (raw) {
      try {
        target.listener.onSofficeEvent?.(raw);
      } catch (err) {
        console.error(JSON.stringify({ source: RENDER_MODULE, level: "error", message: "job log listener failed", detail: String(err) }));
      }
    }
    return;
  }
  if (s.active.size > 0) {
    for (const log of s.active.values()) log.push({ ...entry, correlationId: log.jobId });
    return;
  }
  s.orphans.push(sanitize(entry));
  if (s.orphans.length > ORPHAN_MAX_ENTRIES) s.orphans.splice(0, s.orphans.length - ORPHAN_MAX_ENTRIES);
}

const sofficeSink = (e: SofficeLogEntry): void => {
  route(
    {
      timestamp: e.timestamp,
      level: e.level,
      source: e.source,
      message: e.message,
      code: e.code,
      correlationId: e.correlationId,
      stack_trace: e.stack_trace,
      context: e.context,
    },
    e.correlationId,
    e,
  );
};

const browserSink: BrowserLogSink = (e) => {
  route(
    {
      timestamp: e.at ?? new Date().toISOString(),
      level: e.level,
      source: e.source,
      message: e.message,
      code: e.code,
      context: e.op || e.durationMs !== undefined ? { op: e.op, durationMs: e.durationMs } : undefined,
    },
    undefined,
  );
};

/** Pasang sink soffice + browser sekali per proses (idempoten). */
export function installRenderLogSinks(): void {
  const s = state();
  if (s.installed) return;
  setSofficeLogSink(sofficeSink);
  setBrowserLogSink(browserSink);
  s.installed = true;
}

/** Daftarkan log job sebagai aktif; entri yatim sebelumnya dilampirkan. */
export function registerJobLog(log: JobLog): void {
  installRenderLogSinks();
  const s = state();
  if (s.orphans.length > 0) {
    for (const o of s.orphans.splice(0)) log.push({ ...o, correlationId: log.jobId, context: { ...(o.context ?? {}), orphanFrom: o.correlationId ?? null } });
  }
  s.active.set(log.jobId, log);
}

export function unregisterJobLog(log: JobLog): void {
  state().active.delete(log.jobId);
}
