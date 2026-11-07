// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/security/asset-quota.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-SEC N-07 (SR-57, D-247): kuota byte aset baru per pemanggil per 24 jam
// (429 RATE_LIMITED + Retry-After), cek ruang disk (STORAGE_WRITE_FAILED), dan
// entri datar aset sebagai hard link (isi disimpan sekali, pembaca lama tetap
// bisa membaca `assets/<sha>.<ext>`). DB diganti stub `aggregate` (tanpa DB).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '../_vitest';
import { resetStudioEnvCache } from '@/lib/studio/contract/env';
import { StudioEngineError } from '@/lib/studio/contract/errors';
import { retryAfterOf } from '@/lib/studio/http/errors';
import {
  ASSET_QUOTA_BYTES_PER_DAY_DEFAULT,
  ASSET_QUOTA_INTERNAL_BYTES_PER_DAY_DEFAULT,
  assertAssetQuota,
  assetQuotaLimits,
  assetQuotaScope,
  type StudioAssetDb,
} from '@/lib/studio/services/images/asset-store';
import { assetRelPath, assetShardRelPath, linkAssetCopy, readImageAsset, writeAssetFile } from '@/lib/studio/services/images/store';

const MIB = 1024 * 1024;
const limits = { perCallerBytes: 10 * MIB, internalBytes: 40 * MIB, minFreeBytes: 100 * MIB };
const user = { kind: 'USER_SESSION' as const, requester: 'user:fixsec' };
const agent = { kind: 'INTERNAL_AGENT' as const, requester: 'agent:any-label' };

function stubDb(sum: number | null, min: Date | null, seen: unknown[] = []): StudioAssetDb {
  return {
    studioAsset: {
      aggregate: async (args: unknown) => {
        seen.push(args);
        return { _sum: { bytes: sum }, _min: { createdAt: min } };
      },
    },
  } as unknown as StudioAssetDb;
}

const plenty = async () => 10_000 * MIB;

// row42 SKIP P1 "Prisma (row 109 cut)": the cases marked it.skip below stub prisma.studioAsset.aggregate (stubDb above) and assert its
// Prisma where-args; the row 109 twin (services/images/asset-store.ts:164-176) runs SQL over the real store tx
// (db.get on table asset), so the stub cannot drive it. Not covered elsewhere: see README gap G1.
describe('assertAssetQuota', () => {
  it.skip('di bawah kuota -> lolos; where memakai requester + jendela 24 jam', async () => {
    const seen: unknown[] = [];
    const now = Date.UTC(2026, 9, 23, 12);
    await assertAssetQuota(user, 2 * MIB, stubDb(5 * MIB, new Date(now - 3600_000), seen), { limits, now, freeBytes: plenty });
    expect(seen[0]).toEqual({
      where: { AND: [{ createdBy: 'user:fixsec' }, { createdAt: { gte: new Date(now - 24 * 3600_000) } }] },
      _sum: { bytes: true },
      _min: { createdAt: true },
    });
  });

  it.skip('melebihi kuota -> 429 RATE_LIMITED reason asset_quota_exceeded + retryAfterSec', async () => {
    const now = Date.UTC(2026, 9, 23, 12);
    const oldest = new Date(now - 23 * 3600_000); // jatuh dari jendela dalam 1 jam
    const err = await assertAssetQuota(user, 2 * MIB, stubDb(9 * MIB, oldest), { limits, now, freeBytes: plenty }).catch((e) => e);
    expect(err).toBeInstanceOf(StudioEngineError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.httpStatus).toBe(429);
    expect(err.details).toMatchObject({ reason: 'asset_quota_exceeded', bucket: 'caller', quotaBytes: 10 * MIB, usedBytes: 9 * MIB, requestedBytes: 2 * MIB, windowHours: 24, retryAfterSec: 3600 });
    expect(retryAfterOf('RATE_LIMITED', err.details)).toBe(3600);
  });

  it.skip('tepat di batas diterima; satu byte lebih ditolak', async () => {
    await expect(assertAssetQuota(user, MIB, stubDb(9 * MIB, new Date()), { limits, freeBytes: plenty })).resolves.toBeUndefined();
    await expect(assertAssetQuota(user, MIB + 1, stubDb(9 * MIB, new Date()), { limits, freeBytes: plenty })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it.skip('agen internal berbagi satu ember (agentId hanya label)', async () => {
    const scope = assetQuotaScope(agent, limits);
    expect(scope.bucket).toBe('internal');
    expect(scope.limitBytes).toBe(40 * MIB);
    expect(scope.where).toEqual({ OR: [{ createdBy: { startsWith: 'agent:' } }, { createdBy: 'anonymous-internal' }] });
    await expect(assertAssetQuota(agent, 2 * MIB, stubDb(39 * MIB, new Date()), { limits, freeBytes: plenty })).rejects.toMatchObject({ code: 'RATE_LIMITED', details: { bucket: 'internal' } });
  });

  it.skip('ruang disk kurang -> STORAGE_WRITE_FAILED insufficient_disk_space; statfs tak terbaca -> dilewati', async () => {
    const err = await assertAssetQuota(user, MIB, stubDb(0, null), { limits, freeBytes: async () => 101 * MIB }).catch((e) => e);
    expect(err).toMatchObject({ code: 'STORAGE_WRITE_FAILED', details: { reason: 'insufficient_disk_space' } });
    await expect(assertAssetQuota(user, MIB, stubDb(0, null), { limits, freeBytes: async () => null })).resolves.toBeUndefined();
  });

  it('bawaan beralasan dan env opsional (nilai tidak sah -> bawaan)', () => {
    const saved = { ...process.env };
    try {
      delete process.env.STUDIO_ASSET_QUOTA_BYTES_PER_DAY;
      delete process.env.STUDIO_ASSET_QUOTA_INTERNAL_BYTES_PER_DAY;
      expect(assetQuotaLimits().perCallerBytes).toBe(ASSET_QUOTA_BYTES_PER_DAY_DEFAULT);
      expect(assetQuotaLimits().internalBytes).toBe(ASSET_QUOTA_INTERNAL_BYTES_PER_DAY_DEFAULT);
      process.env.STUDIO_ASSET_QUOTA_BYTES_PER_DAY = String(64 * MIB);
      expect(assetQuotaLimits().perCallerBytes).toBe(64 * MIB);
      process.env.STUDIO_ASSET_QUOTA_BYTES_PER_DAY = 'abc';
      expect(assetQuotaLimits().perCallerBytes).toBe(ASSET_QUOTA_BYTES_PER_DAY_DEFAULT);
      process.env.STUDIO_ASSET_QUOTA_BYTES_PER_DAY = '10'; // di bawah 1 MiB
      expect(assetQuotaLimits().perCallerBytes).toBe(ASSET_QUOTA_BYTES_PER_DAY_DEFAULT);
    } finally {
      process.env = saved;
    }
  });
});

// PNG 1x1 valid (byte tetap, bukan rahasia).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('IP-47: entri datar = hard link ke shard', () => {
  let root: string;
  const saved = { ...process.env };
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'fixsec-assets-'));
    process.env.STUDIO_WORKSPACE_ROOT = root;
    delete process.env.SHARED_WORKSPACE;
    resetStudioEnvCache();
  });
  afterAll(() => {
    process.env = { ...saved };
    resetStudioEnvCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('shard + datar berbagi isi (nlink 2), pembaca datar dan relPath tetap jalan, ulang idempoten', async () => {
    const bytes = new Uint8Array(PNG_1X1);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const shard = assetShardRelPath(sha, 'image/png');
    const flat = assetRelPath(sha, 'image/png');
    await writeAssetFile(shard, bytes, sha);
    const first = await linkAssetCopy(shard, flat, bytes, sha);
    expect(first).toEqual({ created: true, linked: true });
    const a = statSync(path.join(root, shard));
    const b = statSync(path.join(root, flat));
    expect(b.nlink).toBe(2);
    expect(a.ino).toBe(b.ino);
    expect(readFileSync(path.join(root, flat)).equals(PNG_1X1)).toBe(true);
    // Pembaca lama (tanpa path -> datar) dan baru (relPath shard).
    expect((await readImageAsset({ sha256: sha, mime: 'image/png' })).sha256).toBe(sha);
    expect((await readImageAsset({ sha256: sha, mime: 'image/png', path: shard })).sha256).toBe(sha);
    expect(await linkAssetCopy(shard, flat, bytes, sha)).toEqual({ created: false, linked: false });
  });
});
