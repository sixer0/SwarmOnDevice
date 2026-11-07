/**
 * Pembatas laju endpoint pemicu render (FIX-1, S87 M-03).
 *
 * Satu limiter jendela tetap di memori proses untuk SEMUA route yang memicu
 * render atau perakitan berat: POST documents (R04), PATCH blok (R06),
 * POST revisions (R07), POST artifacts (R09), validate `?preview=html` (R08).
 * Kunci = identitas TERAUTENTIKASI pemanggil (bukan `agentId` badan yang dapat
 * diisi bebas, S87 L-02): username sesi HQ, email/sub Google, atau satu ember
 * bersama untuk pemegang `x-internal-secret`. Batas melewati ambang -> 429
 * `RATE_LIMITED` + `Retry-After` (lewat `reject`).
 *
 * Batas bawaan 30 render per 60 detik per pemanggil; dapat diubah lewat env
 * `STUDIO_RENDER_RATE_LIMIT` / `STUDIO_RENDER_RATE_WINDOW_MS` (dibaca sekali).
 * Antrean render berbatas (503 `RENDER_QUEUE_FULL`) ada di services/render.
 *
 * DC-19 (QH-01..QH-05): setiap tagihan dicatat pada ctx (bucket `render`, `./quota`);
 * 429 membawa header kuota, respons lain dipasang route lewat `applyQuotaHeaders`.
 * FIX-R40-5: kunci, tagihan, dan 429 lewat helper bersama `checkBucketRate` (`./quota`).
 */
import type { StudioCaller } from "@/lib/studio/contract/auth";
import type { ReqCtx } from "./context";
import { checkBucketRate, quotaRateIdentity, rateEnvInt } from "./quota";
import { createFixedWindowLimiter, type FixedWindowLimiter } from "./rate-limit";

export const RENDER_RATE_LIMIT_DEFAULT = 30;
export const RENDER_RATE_WINDOW_MS_DEFAULT = 60_000;

let limiter: FixedWindowLimiter | null = null;

function renderLimiter(): FixedWindowLimiter {
  limiter ??= createFixedWindowLimiter({
    limit: rateEnvInt("STUDIO_RENDER_RATE_LIMIT", RENDER_RATE_LIMIT_DEFAULT, 1),
    windowMs: rateEnvInt("STUDIO_RENDER_RATE_WINDOW_MS", RENDER_RATE_WINDOW_MS_DEFAULT, 1000),
  });
  return limiter;
}

/** Hanya untuk uji: buat ulang limiter (membaca env lagi). */
export function resetRenderRateLimiter(): void {
  limiter = null;
}

/** Identitas laju pemanggil (tanpa medan yang dikirim klien bebas). */
export function renderRateIdentity(caller: Pick<StudioCaller, "kind" | "username" | "email">): string {
  // DC-19: satu sumber identitas untuk semua bucket (`quotaRateIdentity`).
  return quotaRateIdentity(caller);
}

/**
 * Hitung satu permintaan render. `null` = diizinkan; selain itu respons 429
 * `RATE_LIMITED` (berisi `retryAfterSec`, header `Retry-After`) yang langsung
 * dikembalikan route. FIX-R40-5: lewat helper bersama `checkBucketRate` (tanpa label
 * `limiter` di log, sama dengan perilaku sebelumnya).
 */
export function checkRenderRate(caller: Pick<StudioCaller, "kind" | "username" | "email">, ctx: ReqCtx): Response | null {
  return checkBucketRate("render", renderLimiter(), caller, ctx, "Too many render requests; retry later");
}
