/**
 * Header kuota + bucket `query` (DC-19; register 05_document_contract_specs.md §9.6
 * QH-01..QH-06, C46-C49, E53, KD-38).
 *
 * - Setiap bucket laju (render, validate, import, query) mencatat hasil tagihannya pada
 *   konteks permintaan (`recordQuotaCharge`). Pencatatan hanya terjadi SESUDAH tagihan,
 *   jadi permintaan yang ditolak sebelumnya (mis. 401) tidak pernah membawa header (QH-03).
 * - `applyQuotaHeaders` memasang C48 (sisa bilangan bulat >= 0) dan C49 (nama bucket E53)
 *   pada respons apa pun yang dihasilkan sesudah tagihan: 2xx, 4xx, 429, 5xx (QH-02, QH-03).
 * - Dua bucket ditagih dalam satu permintaan (R08 `?preview=html`, impor `?validate=1`):
 *   header melaporkan bucket dengan sisa terkecil, seri diputus urutan E53 (QH-04, KD-38).
 * - 429 -> C48 = `0`; `Retry-After` dari `reject` tidak disentuh (QH-05).
 * - Nilai = sisa limiter memori proses ini (QH-06, RK-22).
 *
 * Bucket `query` (R21, R22): C46 permintaan per C47 ms per identitas pemanggil (identitas
 * sama dengan bucket validate); env `STUDIO_QUERY_RATE_LIMIT` / `STUDIO_QUERY_RATE_WINDOW_MS`
 * (dibaca sekali).
 *
 * Bucket per agen + plafon identitas (FIX-SEC L-4, D-402), berlaku untuk semua bucket lewat
 * `checkBucketRate`:
 * - Pemanggil TANPA agentId: satu kunci per identitas terautentikasi (perilaku lama, identik).
 * - Pemanggil DENGAN agentId: kunci = identitas terautentikasi + agentId (`quotaAgentRateIdentity`),
 *   sehingga dua agen yang berbagi satu rahasia punya sisa terpisah; DITAMBAH plafon global per
 *   identitas = `STUDIO_QUOTA_AGENT_CEILING_FACTOR` (bilangan bulat 1..64, bawaan 4) x batas bucket,
 *   dalam jendela bucket yang sama. Plafon disusun dari F slot kunci limiter yang sama, diisi
 *   bergiliran, sehingga rotasi agentId berhenti sesudah F x batas permintaan per jendela. Sisa
 *   plafon dihitung F x sisa slot + slot yang belum tersentuh pada putaran ini (tepat bila jendela
 *   slot sejajar; selisih < F bila tidak). Header melaporkan sisa terkecil agen/plafon (QH-04).
 *   Plafon hanya dihitung bila tagihan per agen diizinkan. Env dibaca setiap tagihan.
 */
import { createHash } from "node:crypto";
import type { StudioCaller } from "@/lib/studio/contract/auth";
import { QUOTA_BUCKETS, type QuotaBucket } from "@/lib/studio/contract/enums";
import { STUDIO_QUOTA_BUCKET_HEADER, STUDIO_QUOTA_REMAINING_HEADER } from "@/lib/studio/contract/env";
import type { ReqCtx } from "./context";
import { reject } from "./errors";
import { createFixedWindowLimiter, type FixedWindowLimiter, type RateLimitResult } from "./rate-limit";

// C48/C49 (`contract/env.ts`) dan E53 (`contract/enums.ts`) milik kontrak (IB-DC-1). Diteruskan
// sebagai binding yang SAMA (bukan definisi kedua) untuk barrel `http/index.ts` dan pemakai lama.
export { QUOTA_BUCKETS, STUDIO_QUOTA_BUCKET_HEADER, STUDIO_QUOTA_REMAINING_HEADER, type QuotaBucket };

/** C46 */
export const QUERY_RATE_LIMIT_DEFAULT = 120;
/** C47 */
export const QUERY_RATE_WINDOW_MS_DEFAULT = 60_000;

/** Env faktor plafon identitas (L-4): plafon = faktor x batas bucket per agen. */
export const QUOTA_AGENT_CEILING_FACTOR_ENV = "STUDIO_QUOTA_AGENT_CEILING_FACTOR";
export const QUOTA_AGENT_CEILING_FACTOR_DEFAULT = 4;
/** Batas atas faktor (jumlah slot kunci plafon per identitas per bucket). */
export const QUOTA_AGENT_CEILING_FACTOR_MAX = 64;

type RateCaller = Pick<StudioCaller, "kind" | "username" | "email" | "agentId">;

/**
 * Identitas laju TERAUTENTIKASI pemanggil (tanpa medan yang dikirim klien bebas), satu
 * sumber untuk semua bucket. `renderRateIdentity` (render-guard) mendelegasikan ke sini.
 */
export function quotaRateIdentity(caller: RateCaller): string {
  switch (caller.kind) {
    case "ADMIN_SESSION":
    case "USER_SESSION":
      return `${caller.kind}:${caller.username ?? "?"}`;
    case "GOOGLE_SESSION":
      return `${caller.kind}:${caller.email ?? "?"}`;
    default:
      // Pemegang x-internal-secret: satu identitas (agentId memecah bucket hanya di bawah
      // plafon identitas, L-4; lihat `quotaAgentRateIdentity`).
      return `${caller.kind}:shared`;
  }
}

/**
 * Identitas laju per agen (L-4): identitas terautentikasi + agentId (label dari badan, dapat
 * dipalsukan; karena itu dibatasi plafon identitas). `null` bila pemanggil tanpa agentId.
 */
export function quotaAgentRateIdentity(caller: RateCaller): string | null {
  const agent = typeof caller.agentId === "string" ? caller.agentId : "";
  return agent ? `${quotaRateIdentity(caller)}\u0000agent:${agent}` : null;
}

// ---------------------------------------------------------------------------
// Catatan tagihan per permintaan
// ---------------------------------------------------------------------------

/** Sisa per bucket yang ditagih permintaan ini. WeakMap: ikut terbuang bersama ctx. */
const charges = new WeakMap<ReqCtx, Map<QuotaBucket, number>>();

/**
 * Catat satu tagihan bucket pada permintaan ini. Bucket yang ditagih berulang (mis. R23
 * per blok) menyimpan sisa terkecil.
 */
export function recordQuotaCharge(ctx: ReqCtx, bucket: QuotaBucket, rl: Pick<RateLimitResult, "allowed" | "remaining">): void {
  const remaining = rl.allowed ? Math.max(0, Math.floor(rl.remaining)) : 0;
  let m = charges.get(ctx);
  if (!m) {
    m = new Map();
    charges.set(ctx, m);
  }
  const prev = m.get(bucket);
  m.set(bucket, prev === undefined ? remaining : Math.min(prev, remaining));
}

/** Bucket yang dilaporkan (QH-04): sisa terkecil, seri = urutan E53. `null` = belum ditagih. */
export function quotaReport(ctx: ReqCtx): { bucket: QuotaBucket; remaining: number } | null {
  const m = charges.get(ctx);
  if (!m || m.size === 0) return null;
  let best: { bucket: QuotaBucket; remaining: number } | null = null;
  for (const bucket of QUOTA_BUCKETS) {
    const remaining = m.get(bucket);
    if (remaining === undefined) continue;
    if (best === null || remaining < best.remaining) best = { bucket, remaining };
  }
  return best;
}

/**
 * Pasang C48/C49 pada respons sesudah tagihan (QH-02..QH-05). Tanpa tagihan tercatat
 * (penolakan sebelum tagihan, mis. 401) respons dikembalikan apa adanya. Header beku
 * disalin ke Response baru (pola `withCorrelation`).
 */
export function applyQuotaHeaders(res: Response, ctx: ReqCtx): Response {
  const report = quotaReport(ctx);
  if (!report) return res;
  const remaining = res.status === 429 ? "0" : String(report.remaining);
  try {
    res.headers.set(STUDIO_QUOTA_REMAINING_HEADER, remaining);
    res.headers.set(STUDIO_QUOTA_BUCKET_HEADER, report.bucket);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set(STUDIO_QUOTA_REMAINING_HEADER, remaining);
    headers.set(STUDIO_QUOTA_BUCKET_HEADER, report.bucket);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/**
 * Pembungkus satu titik untuk route handler: jalankan isi route lalu pasang header kuota
 * pada respons apa pun yang dihasilkan (2xx/4xx/429/5xx). Galat yang lolos dilempar ulang
 * tanpa diubah.
 */
export async function withQuotaHeaders(ctx: ReqCtx, run: () => Promise<Response>): Promise<Response> {
  return applyQuotaHeaders(await run(), ctx);
}

// ---------------------------------------------------------------------------
// Helper laju bersama (FIX-R40-5): render, validate, import, query
// ---------------------------------------------------------------------------

/**
 * Bilangan bulat env >= `min`; kosong/tidak sah -> `fallback`. Dipakai keempat bucket
 * untuk batas (`min` 1) dan jendela (`min` 1000 ms).
 */
export function rateEnvInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/** Kunci limiter = sha256(`bucket` NUL `identity`)[0..32]. */
function bucketKey(bucket: QuotaBucket, identity: string): string {
  return createHash("sha256").update(`${bucket}\u0000${identity}`).digest("hex").slice(0, 32);
}

/** Faktor plafon identitas dari env (1..MAX; tidak sah -> bawaan). */
export function quotaAgentCeilingFactor(): number {
  return Math.min(QUOTA_AGENT_CEILING_FACTOR_MAX, rateEnvInt(QUOTA_AGENT_CEILING_FACTOR_ENV, QUOTA_AGENT_CEILING_FACTOR_DEFAULT, 1));
}

/** Giliran slot plafon per (bucket, identitas), per instans limiter (reset limiter = reset giliran). */
const ceilingTurns = new WeakMap<FixedWindowLimiter, Map<string, number>>();
const CEILING_TURNS_MAX_KEYS = 5000;

/**
 * Satu tagihan plafon identitas (L-4): slot `turn mod F` dari F kunci limiter yang sama
 * (masing-masing berbatas `limit` bucket), sehingga total per jendela <= F x limit. Sisa yang
 * dilaporkan = F x sisa slot + slot yang belum tersentuh pada putaran ini.
 */
function hitIdentityCeiling(bucket: QuotaBucket, limiter: FixedWindowLimiter, identity: string): RateLimitResult {
  const factor = quotaAgentCeilingFactor();
  let turns = ceilingTurns.get(limiter);
  if (!turns) {
    turns = new Map();
    ceilingTurns.set(limiter, turns);
  }
  const base = `${bucket}\u0000${identity}`;
  const turn = turns.get(base) ?? 0;
  if (!turns.has(base) && turns.size >= CEILING_TURNS_MAX_KEYS) turns.clear();
  turns.set(base, turn + 1);
  const slot = turn % factor;
  const rl = limiter.hit(bucketKey(bucket, `${identity}\u0000ceiling:${slot}`));
  return rl.allowed ? { ...rl, remaining: rl.remaining * factor + (factor - 1 - slot) } : rl;
}

function rateLimitedResponse(
  ctx: ReqCtx,
  caller: RateCaller,
  rl: RateLimitResult,
  message: string,
  logLabel: string | undefined,
  extra?: Record<string, unknown>,
): Response {
  return applyQuotaHeaders(
    reject(ctx, "RATE_LIMITED", message, { retryAfterSec: rl.retryAfterSec }, {
      callerKind: caller.kind,
      retryAfterSec: rl.retryAfterSec,
      ...(logLabel === undefined ? {} : { limiter: logLabel }),
      ...extra,
    }),
    ctx,
  );
}

/**
 * Satu tagihan bucket untuk pemanggil terautentikasi: kunci = sha256(`bucket` NUL identitas)[0..32]
 * dengan identitas = `quotaRateIdentity` (tanpa agentId, perilaku lama) atau
 * `quotaAgentRateIdentity` (dengan agentId, L-4), `hit`, catat tagihan pada ctx (QH-03). Dengan
 * agentId, tagihan yang diizinkan juga menagih plafon identitas (sisa terkecil tercatat, QH-04).
 * Hasil: `null` bila diizinkan atau respons 429 `RATE_LIMITED` + `Retry-After` + header kuota
 * (QH-05); 429 karena plafon membawa `scope: "identityCeiling"` pada konteks log.
 * `logLabel` mengisi `limiter` pada konteks log 429; bucket render tidak memakainya
 * (perilaku log sebelum penyatuan dipertahankan).
 */
export function checkBucketRate(
  bucket: QuotaBucket,
  limiter: FixedWindowLimiter,
  caller: RateCaller,
  ctx: ReqCtx,
  message: string,
  logLabel?: string,
): Response | null {
  const identity = quotaRateIdentity(caller);
  const agentIdentity = quotaAgentRateIdentity(caller);
  const rl = limiter.hit(bucketKey(bucket, agentIdentity ?? identity));
  recordQuotaCharge(ctx, bucket, rl);
  if (!rl.allowed) return rateLimitedResponse(ctx, caller, rl, message, logLabel);
  if (agentIdentity === null) return null;
  const ceiling = hitIdentityCeiling(bucket, limiter, identity);
  recordQuotaCharge(ctx, bucket, ceiling);
  if (ceiling.allowed) return null;
  return rateLimitedResponse(ctx, caller, ceiling, message, logLabel, { scope: "identityCeiling" });
}

// ---------------------------------------------------------------------------
// Bucket `query` (R21, R22)
// ---------------------------------------------------------------------------

let queryLimiterInstance: FixedWindowLimiter | null = null;

function queryLimiter(): FixedWindowLimiter {
  queryLimiterInstance ??= createFixedWindowLimiter({
    limit: rateEnvInt("STUDIO_QUERY_RATE_LIMIT", QUERY_RATE_LIMIT_DEFAULT, 1),
    windowMs: rateEnvInt("STUDIO_QUERY_RATE_WINDOW_MS", QUERY_RATE_WINDOW_MS_DEFAULT, 1000),
  });
  return queryLimiterInstance;
}

/** Hanya untuk uji: buat ulang limiter (membaca env lagi). */
export function resetQueryRateLimiter(): void {
  queryLimiterInstance = null;
}

/**
 * Hitung satu permintaan R21/R22. `null` = diizinkan (tagihan tercatat; route memasang
 * header lewat `applyQuotaHeaders`/`withQuotaHeaders`); selain itu respons 429
 * `RATE_LIMITED` + `Retry-After` + header kuota yang langsung dikembalikan route.
 */
export function checkQueryRate(caller: RateCaller, ctx: ReqCtx): Response | null {
  return checkBucketRate("query", queryLimiter(), caller, ctx, "Too many query requests; retry later", "query");
}
