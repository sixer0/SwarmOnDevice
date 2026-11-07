/**
 * Pembatas laju R08 `POST /api/studio/validate` (D-280 S2-03, FIX-S2).
 *
 * Setiap panggilan R08 dihitung, bukan hanya `?preview=html`: dry-run kiriman v2
 * (FIX-V) membuka transaksi READ ONLY per permintaan dan menjalankan lint penuh, jadi
 * tanpa batas pemanggil terautentikasi dapat menekan pool DB dan CPU HQ bersama.
 *
 * Pola dan sumber SAMA dengan route kiriman (FIX-1, `@/lib/studio/http`): limiter
 * jendela tetap `createFixedWindowLimiter`, identitas TERAUTENTIKASI
 * `quotaRateIdentity` (bukan `agentId` badan), dan respons 429 `RATE_LIMITED` +
 * `Retry-After` lewat `reject`. Embernya terpisah dan lebih longgar dari ember render
 * (rekomendasi SR-57: validasi interaktif editor tidak menghabiskan jatah kiriman/build);
 * `?preview=html` tetap juga dihitung ember render.
 *
 * Bawaan 120 permintaan per 60 detik per pemanggil; env `STUDIO_VALIDATE_RATE_LIMIT` /
 * `STUDIO_VALIDATE_RATE_WINDOW_MS` (dibaca sekali).
 *
 * DC-19 (QH-01..QH-05): setiap tagihan dicatat pada ctx (bucket `validate`,
 * `@/lib/studio/http/quota`); 429 membawa header kuota, respons lain dipasang route.
 * FIX-R40-5: kunci, tagihan, dan 429 lewat helper bersama `checkBucketRate`.
 */
import type { StudioCaller } from "@/lib/studio/contract/auth";
import { createFixedWindowLimiter, type FixedWindowLimiter, type ReqCtx } from "@/lib/studio/http";
import { checkBucketRate, rateEnvInt } from "@/lib/studio/http/quota";

export const VALIDATE_RATE_LIMIT_DEFAULT = 120;
export const VALIDATE_RATE_WINDOW_MS_DEFAULT = 60_000;

let limiter: FixedWindowLimiter | null = null;

function validateLimiter(): FixedWindowLimiter {
  limiter ??= createFixedWindowLimiter({
    limit: rateEnvInt("STUDIO_VALIDATE_RATE_LIMIT", VALIDATE_RATE_LIMIT_DEFAULT, 1),
    windowMs: rateEnvInt("STUDIO_VALIDATE_RATE_WINDOW_MS", VALIDATE_RATE_WINDOW_MS_DEFAULT, 1000),
  });
  return limiter;
}

/** Hanya untuk uji: buat ulang limiter (membaca env lagi). */
export function resetValidateRateLimiter(): void {
  limiter = null;
}

/**
 * Hitung satu permintaan R08. `null` = diizinkan; selain itu respons 429 `RATE_LIMITED`
 * (`retryAfterSec`, header `Retry-After`) yang langsung dikembalikan route.
 */
export function checkValidateRate(caller: Pick<StudioCaller, "kind" | "username" | "email">, ctx: ReqCtx): Response | null {
  return checkBucketRate("validate", validateLimiter(), caller, ctx, "Too many validate requests; retry later", "validate");
}
