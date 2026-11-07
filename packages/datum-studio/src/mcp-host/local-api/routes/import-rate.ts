/**
 * Pembatas laju `POST /api/studio/import/markdown` (FIX-HR1, D-334 H-01).
 *
 * Konversi Markdown berjalan sinkron di event loop proses HQ bersama, jadi SETIAP panggilan
 * dihitung (bukan hanya `?validate=1`, yang tetap juga dihitung ember R08). Pola dan sumber
 * sama dengan FIX-1 (`@/lib/studio/http`): limiter jendela tetap `createFixedWindowLimiter`,
 * identitas TERAUTENTIKASI `quotaRateIdentity` (bukan `agentId` badan), respons 429
 * `RATE_LIMITED` + `Retry-After` lewat `reject`. Ember sendiri (`import`), terpisah dari ember
 * render dan validasi.
 *
 * Bawaan 60 permintaan per 60 detik per pemanggil (satu bab per detik; 10 bab Hermes jauh di
 * bawahnya); env `STUDIO_IMPORT_RATE_LIMIT` / `STUDIO_IMPORT_RATE_WINDOW_MS` (dibaca sekali).
 *
 * DC-19 (QH-01..QH-05): setiap tagihan dicatat pada ctx (bucket `import`,
 * `@/lib/studio/http/quota`); 429 membawa header kuota, respons lain dipasang route.
 * FIX-R40-5: kunci, tagihan, dan 429 lewat helper bersama `checkBucketRate`.
 */
import type { StudioCaller } from "@/lib/studio/contract/auth";
import { createFixedWindowLimiter, type FixedWindowLimiter, type ReqCtx } from "@/lib/studio/http";
import { checkBucketRate, rateEnvInt } from "@/lib/studio/http/quota";

export const IMPORT_RATE_LIMIT_DEFAULT = 60;
export const IMPORT_RATE_WINDOW_MS_DEFAULT = 60_000;

let limiter: FixedWindowLimiter | null = null;

function importLimiter(): FixedWindowLimiter {
  limiter ??= createFixedWindowLimiter({
    limit: rateEnvInt("STUDIO_IMPORT_RATE_LIMIT", IMPORT_RATE_LIMIT_DEFAULT, 1),
    windowMs: rateEnvInt("STUDIO_IMPORT_RATE_WINDOW_MS", IMPORT_RATE_WINDOW_MS_DEFAULT, 1000),
  });
  return limiter;
}

/** Hanya untuk uji: buat ulang limiter (membaca env lagi). */
export function resetImportRateLimiter(): void {
  limiter = null;
}

/**
 * Hitung satu permintaan impor. `null` = diizinkan; selain itu respons 429 `RATE_LIMITED`
 * (`retryAfterSec`, header `Retry-After`) yang langsung dikembalikan route.
 */
export function checkImportRate(caller: Pick<StudioCaller, "kind" | "username" | "email">, ctx: ReqCtx): Response | null {
  return checkBucketRate("import", importLimiter(), caller, ctx, "Too many markdown import requests; retry later", "import");
}
