/**
 * Pembatas laju jendela tetap di memori proses (IP-09). Cukup untuk satu
 * instans HQ; tidak dibagi antarproses. Jumlah kunci dibatasi agar memori
 * tidak tumbuh tanpa batas (kunci kedaluwarsa dibuang lebih dulu).
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Detik sampai jendela berikutnya (0 bila diizinkan). */
  retryAfterSec: number;
}

export interface FixedWindowLimiter {
  hit(key: string, now?: number): RateLimitResult;
  reset(): void;
}

export function createFixedWindowLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }): FixedWindowLimiter {
  const maxKeys = opts.maxKeys ?? 5000;
  const windows = new Map<string, { start: number; count: number }>();

  function prune(now: number): void {
    for (const [k, w] of windows) {
      if (now - w.start >= opts.windowMs) windows.delete(k);
    }
    // Masih penuh: buang yang tertua (urutan sisip Map).
    while (windows.size >= maxKeys) {
      const first = windows.keys().next();
      if (first.done) break;
      windows.delete(first.value);
    }
  }

  return {
    hit(key: string, now: number = Date.now()): RateLimitResult {
      let w = windows.get(key);
      if (!w || now - w.start >= opts.windowMs) {
        if (!w && windows.size >= maxKeys) prune(now);
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      if (w.count > opts.limit) {
        return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((w.start + opts.windowMs - now) / 1000)) };
      }
      return { allowed: true, remaining: opts.limit - w.count, retryAfterSec: 0 };
    },
    reset(): void {
      windows.clear();
    },
  };
}
