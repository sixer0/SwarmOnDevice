/**
 * Antrean render berbatas (FIX-1, S87 M-03).
 *
 * Semua job render (revisi dan artefak) masuk lewat satu gerbang proses:
 * paling banyak `maxConcurrent` job berjalan, paling banyak `maxQueued`
 * menunggu. Permintaan berikutnya ditolak SEBELUM job dibuat dengan
 * `StudioEngineError("RENDER_QUEUE_FULL")` 503 + `details.retryAfterSec`
 * (route memasang header `Retry-After`). Dengan begitu antrean render bridge
 * (engine/browser) di bawahnya tidak pernah menerima lebih dari `maxConcurrent`
 * job dari layanan.
 *
 * Bawaan: 2 berjalan, 8 menunggu.
 * Env opsional (dibaca saat gerbang dibuat): `STUDIO_RENDER_MAX_CONCURRENT`,
 * `STUDIO_RENDER_MAX_QUEUED`, `STUDIO_RENDER_QUEUE_RETRY_AFTER_SEC`.
 * Hanya memori proses (satu instans HQ), tanpa persistensi.
 *
 * Swarm patch (row 31c): comments only (the desktop-office PDF engine and its instance limit are not
 * in Swarm; the gate code is verbatim).
 */
import { StudioEngineError } from "../../contract/errors";

export const RENDER_MAX_CONCURRENT_DEFAULT = 2;
export const RENDER_MAX_QUEUED_DEFAULT = 8;
export const RENDER_QUEUE_RETRY_AFTER_SEC_DEFAULT = 30;

export interface RenderGateStats {
  running: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
}

export interface RenderGate {
  /** Jalankan `fn` saat slot tersedia; antrean penuh -> RENDER_QUEUE_FULL (503). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Tolak sekarang bila antrean penuh (cek awal sebelum kerja mahal, tanpa memesan slot). */
  assertCapacity(): void;
  stats(): RenderGateStats;
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export function createRenderGate(opts: { maxConcurrent: number; maxQueued: number; retryAfterSec: number }): RenderGate {
  let running = 0;
  const waiters: Array<() => void> = [];

  const full = (): boolean => running >= opts.maxConcurrent && waiters.length >= opts.maxQueued;
  const queueFull = (): never => {
    throw new StudioEngineError("RENDER_QUEUE_FULL", "Render queue is full; retry later", {
      retryAfterSec: opts.retryAfterSec,
      running,
      queued: waiters.length,
      maxConcurrent: opts.maxConcurrent,
      maxQueued: opts.maxQueued,
    });
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next) next(); // slot berpindah langsung ke penunggu (running tetap)
    else running -= 1;
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (running < opts.maxConcurrent) {
        running += 1;
      } else {
        if (waiters.length >= opts.maxQueued) queueFull();
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
    assertCapacity(): void {
      if (full()) queueFull();
    },
    stats(): RenderGateStats {
      return { running, queued: waiters.length, maxConcurrent: opts.maxConcurrent, maxQueued: opts.maxQueued };
    },
  };
}

let gate: RenderGate | null = null;

/** Gerbang render proses (dibuat malas dari env). */
export function renderGate(): RenderGate {
  gate ??= createRenderGate({
    maxConcurrent: envInt("STUDIO_RENDER_MAX_CONCURRENT", RENDER_MAX_CONCURRENT_DEFAULT, 1),
    maxQueued: envInt("STUDIO_RENDER_MAX_QUEUED", RENDER_MAX_QUEUED_DEFAULT, 0),
    retryAfterSec: envInt("STUDIO_RENDER_QUEUE_RETRY_AFTER_SEC", RENDER_QUEUE_RETRY_AFTER_SEC_DEFAULT, 1),
  });
  return gate;
}

/** Hanya untuk uji: buang gerbang (env dibaca ulang). */
export function resetRenderGate(): void {
  gate = null;
}

/** Cek awal route sebelum ingest/sunting (503 bila antrean sudah penuh). */
export function assertRenderCapacity(): void {
  renderGate().assertCapacity();
}

/**
 * true bila job gagal SELURUHNYA karena antrean penuh (galat `RENDER_QUEUE_FULL`
 * dari gerbang ini atau dari antrean render bridge/Chromium, FIX-8) dan tanpa
 * berkas: route memetakannya ke 503 + `Retry-After`, bukan 200/201 diam-diam.
 */
export function isQueueFullOutcome(outcome: { outputs: readonly unknown[]; errors: ReadonlyArray<{ code: string }> }): boolean {
  return outcome.outputs.length === 0 && outcome.errors.length > 0 && outcome.errors.every((e) => e.code === "RENDER_QUEUE_FULL");
}

/** Detik `Retry-After` bawaan untuk antrean penuh (env `STUDIO_RENDER_QUEUE_RETRY_AFTER_SEC`). */
export function renderQueueRetryAfterSec(): number {
  return envInt("STUDIO_RENDER_QUEUE_RETRY_AFTER_SEC", RENDER_QUEUE_RETRY_AFTER_SEC_DEFAULT, 1);
}
