// Row 122c (Swarm 1.2.0, decision C96 item 3; row 42 gap G1): the asset quota that row 109 rewrote from a Prisma
// `studioAsset.aggregate` into SQL over the store's `asset` table (vendor services/images/asset-store.ts
// assertAssetQuota + assetQuotaScope) had no test; the ported Prisma-stub cases stay skipped (test/ported/security/
// asset-quota.test.ts, row 42 P). These run the SQL against a REAL temp store (SqliteStudioStore over bun:sqlite).
//
// Original behaviour, read from the clone gsp-datacenter src/lib/studio/services/images/asset-store.ts (read-only):
// - :24-35 quota only for NEW assets ("dedupe tidak dihitung"), bytes per caller per rolling 24 h from the rows'
//   createdBy/createdAt; internal agents share one bucket; over the limit -> 429 RATE_LIMITED,
//   reason "asset_quota_exceeded", Retry-After.
// - :116-124 bucket = createdBy of the requester, or (internal) createdBy startsWith "agent:" OR "anonymous-internal".
// - :167-190 aggregate _sum bytes / _min createdAt where createdAt >= now - 24 h; refuse when used + new > limit
//   (so exactly at the limit passes); details {reason, bucket, quotaBytes, usedBytes, requestedBytes, windowHours: 24,
//   retryAfterSec}.
// - :344-347 the sha256 is looked up first and assertAssetQuota runs only when it is unknown (a re-upload is a dedupe).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { closeHostStore, openHostStore, withStudioTx, type SqliteStudioStore } from "../../src/store-bridge/index.ts";
import type { StudioCaller } from "../../vendor/src/lib/studio/contract/auth";

const PKG = path.resolve(import.meta.dir, "..", "..");
const VENDOR = path.join(PKG, "vendor");
const base = process.env.TMPDIR ?? tmpdir();
mkdirSync(base, { recursive: true });
const WORK = realpathSync(mkdtempSync(path.join(base, "row122c-quota-")));
const ROOT = path.join(WORK, "datum-studio");

const MIB = 1024 * 1024;
const HOUR = 3600_000;
const user: StudioCaller = { kind: "USER_SESSION", requester: "user:row122c", canWriteClassK: false } as StudioCaller;
const other: StudioCaller = { kind: "USER_SESSION", requester: "user:row122c-other", canWriteClassK: false } as StudioCaller;
const agent: StudioCaller = { kind: "INTERNAL_AGENT", requester: "agent:row122c", agentId: "row122c", canWriteClassK: false } as StudioCaller;
const ENV_KEYS = ["STUDIO_WORKSPACE_ROOT", "STUDIO_ASSETS_ROOT", "STUDIO_ASSET_QUOTA_BYTES_PER_DAY", "STUDIO_ASSET_QUOTA_INTERNAL_BYTES_PER_DAY", "STUDIO_ASSET_MIN_FREE_BYTES"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let store: SqliteStudioStore;
let images: typeof import("../../vendor/src/lib/studio/services/images/asset-store");
let resetEnv: () => void;

// ── PNG fixtures: uncompressed (deflate level 0) RGBA, so the byte size is predictable and distinct per seed ──
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** A valid side x side RGBA PNG whose pixels depend on `seed` (different seed = different sha256). */
function png(side: number, seed: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(side * (1 + side * 4));
  for (let y = 0; y < side; y++) {
    const row = y * (1 + side * 4);
    for (let x = 0; x < side * 4; x++) raw[row + 1 + x] = (x * 7 + y * 13 + seed * 31) & 0xff;
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 0 })), chunk("IEND", new Uint8Array(0))]));
}

const quota = (caller: StudioCaller, newBytes: number, opts: Parameters<typeof images.assertAssetQuota>[3] = {}) =>
  withStudioTx((tx) => images.assertAssetQuota(caller, newBytes, tx, { freeBytes: async () => null, ...opts }));
const assetCount = () => Number((store as unknown as { requireReader(): { get(s: string): { n: number } } }).requireReader().get("SELECT count(*) AS n FROM asset").n);

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = ROOT;
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets");
  // Smallest quota the env accepts (1 MiB, asset-store.ts envBytes min) and no disk floor, so the 24 h quota is
  // the only rule a storeAssetRow refusal can come from.
  process.env.STUDIO_ASSET_QUOTA_BYTES_PER_DAY = String(MIB);
  process.env.STUDIO_ASSET_QUOTA_INTERNAL_BYTES_PER_DAY = String(2 * MIB);
  process.env.STUDIO_ASSET_MIN_FREE_BYTES = "0";
  const env = await import("../../vendor/src/lib/studio/contract/env");
  resetEnv = env.resetStudioEnvCache;
  resetEnv(); // an earlier suite in the same bun process may have cached its own root
  store = await openHostStore(ROOT, { release: "1.2.0", logFile: path.join(WORK, "logs", "store.jsonl") });
  images = await import("../../vendor/src/lib/studio/services/images/asset-store");
});

afterAll(async () => {
  if (store) await closeHostStore(store);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetEnv?.();
});

describe("asset quota SQL over the store (row 109 twin of the original aggregate)", () => {
  // 380 x 380 RGBA uncompressed = 577 600 raw bytes + filter bytes: a little over 0.55 MiB, so two new ones exceed 1 MiB.
  const A = png(380, 1);
  const B = png(380, 2);

  test("the quota limit: new bytes count per caller in the 24 h window; exactly at the limit passes, one byte over does not", async () => {
    expect(A.byteLength).toBeGreaterThan(MIB / 2);
    const first = await images.storeAssetRow(user, { file: A, mime: "image/png" });
    expect(first.created).toBe(true);
    expect(first.row.bytes).toBe(A.byteLength);
    const limits = { perCallerBytes: MIB, internalBytes: 2 * MIB, minFreeBytes: 0 };
    await expect(quota(user, MIB - A.byteLength, { limits })).resolves.toBeUndefined();
    await expect(quota(user, MIB - A.byteLength + 1, { limits })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // Another requester's bucket is empty (created_by = ?), so the same request passes for them.
    await expect(quota(other, MIB - A.byteLength + 1, { limits })).resolves.toBeUndefined();
    // Rows older than 24 h leave the window (time_created >= now - 24 h).
    await expect(quota(user, MIB - A.byteLength + 1, { limits, now: Date.now() + 24 * HOUR + 60_000 })).resolves.toBeUndefined();
  });

  test("the refusal: 429 RATE_LIMITED, reason asset_quota_exceeded, details as the original, and no row or file kept", async () => {
    const before = assetCount();
    const err = await images.storeAssetRow(user, { file: B, mime: "image/png" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf((await import("../../vendor/src/lib/studio/contract/errors")).StudioEngineError);
    const e = err as { code: string; httpStatus: number; details: Record<string, unknown> };
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.httpStatus).toBe(429);
    expect(e.details).toMatchObject({ reason: "asset_quota_exceeded", bucket: "caller", quotaBytes: MIB, usedBytes: A.byteLength, requestedBytes: B.byteLength, windowHours: 24 });
    // Retry-After counts from the oldest row in the window (just written): close to the full 24 h.
    expect(e.details.retryAfterSec as number).toBeGreaterThan(24 * 3600 - 120);
    expect(e.details.retryAfterSec as number).toBeLessThanOrEqual(24 * 3600);
    expect(assetCount()).toBe(before);
    const shaB = createHash("sha256").update(B).digest("hex");
    expect(existsSync(path.join(ROOT, "assets", shaB.slice(0, 2), `${shaB}.png`))).toBe(false);
    // Internal agents share one bucket (agent:* or anonymous-internal); the user's row is not in it.
    const scope = images.assetQuotaScope(agent);
    expect(scope.bucket).toBe("internal");
    await expect(quota(agent, 2 * MIB)).resolves.toBeUndefined();
    await expect(quota({ ...agent, requester: "anonymous-internal" } as StudioCaller, 2 * MIB + 1)).rejects.toMatchObject({ code: "RATE_LIMITED", details: { bucket: "internal", usedBytes: 0 } });
  });

  test("a deduplicated asset does not count twice: a re-upload passes over quota and the used bytes hold it once", async () => {
    // The user's quota is spent (B was refused above); the same bytes as A are a dedupe, so no quota check runs.
    const again = await images.storeAssetRow(user, { file: A, mime: "image/png" });
    expect(again.created).toBe(false);
    // Same bytes from another requester: still the one row, still owned by the first uploader, nothing charged.
    const fromOther = await images.storeAssetRow(other, { file: A, mime: "image/png" });
    expect(fromOther.created).toBe(false);
    expect(fromOther.row.id).toBe(again.row.id);
    const rows = (store as unknown as { requireReader(): { all(s: string, p: unknown[]): Array<{ created_by: string; bytes: number }> } })
      .requireReader()
      .all("SELECT created_by, bytes FROM asset WHERE sha256 = ?", [again.row.sha256]);
    expect(rows).toEqual([{ created_by: "user:row122c", bytes: A.byteLength }]);
    // usedBytes after three uploads of A = A once.
    const err = await quota(user, MIB, { limits: { perCallerBytes: MIB, internalBytes: 2 * MIB, minFreeBytes: 0 } }).catch((x: { details: Record<string, unknown> }) => x);
    expect(err).toMatchObject({ code: "RATE_LIMITED", details: { usedBytes: A.byteLength } });
    await expect(quota(other, MIB)).resolves.toBeUndefined();
  });
});
