// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/asset-bytes.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S72: resolusi aset `docAssetBytes` (IP-34, D-105, D-110): urutan
// ctx.assetBytes -> dataBase64 -> tidak ada; galat lookup -> peringatan +
// cadangan; render hanya-assetBytes identik byte dengan render dataBase64
// (DOCX dan HTML) dan byte media DOCX = byte aset.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { RenderContext, RenderLogEntry, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { decodeBase64, docAssetBytes } from '@/lib/studio/engine/bind/asset-bytes';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { canonicalTemplate, loadFixtureDoc, makeCtx, makePng, sha256, snapshotOf, unzip } from './_kit';

const PNG_A = makePng(40, 20, 1);
const PNG_B = makePng(40, 20, 7);
const B64_A = Buffer.from(PNG_A).toString('base64');

function fakeCtx(assets: Record<string, unknown>, assetBytes?: RenderContext['assetBytes']): { ctx: RenderContext; logs: RenderLogEntry[] } {
  const logs: RenderLogEntry[] = [];
  const ctx = {
    snapshot: { doc: { assets } },
    log: (e: RenderLogEntry) => logs.push(e),
    ...(assetBytes ? { assetBytes } : {}),
  } as unknown as RenderContext;
  return { ctx, logs };
}

describe('docAssetBytes (unit)', () => {
  it('kunci tidak terdaftar -> undefined', () => {
    expect(docAssetBytes(fakeCtx({}).ctx, 'x')).toBeUndefined();
  });

  it('assetBytes menang atas dataBase64 dan dipanggil dengan (sha256, kunci)', () => {
    const calls: unknown[][] = [];
    const { ctx } = fakeCtx({ k: { kind: 'raster', sha256: 'ab'.repeat(32), dataBase64: B64_A } }, (...a) => {
      calls.push(a);
      return PNG_B;
    });
    const r = docAssetBytes(ctx, 'k')!;
    expect(r.source).toBe('assetBytes');
    expect(Buffer.from(r.bytes!).equals(Buffer.from(PNG_B))).toBe(true);
    expect(calls).toEqual([['ab'.repeat(32), 'k']]);
  });

  it('assetBytes kosong/undefined -> cadangan dataBase64 (base64 dinormalisasi tanpa spasi)', () => {
    const spaced = B64_A.replace(/(.{10})/g, '$1\n ');
    for (const ret of [undefined, new Uint8Array()]) {
      const { ctx } = fakeCtx({ k: { kind: 'raster', sha256: 'cd'.repeat(32), dataBase64: spaced } }, () => ret);
      const r = docAssetBytes(ctx, 'k')!;
      expect(r.source).toBe('dataBase64');
      expect(r.base64).toBe(B64_A);
      expect(Buffer.from(r.bytes!).equals(Buffer.from(PNG_A))).toBe(true);
    }
  });

  it('assetBytes melempar -> 1 peringatan ASSET_BYTES_LOOKUP_FAILED + cadangan dataBase64, render tidak gagal', () => {
    const { ctx, logs } = fakeCtx({ k: { kind: 'raster', sha256: 'ef'.repeat(32), dataBase64: B64_A } }, () => {
      throw new Error('disk hilang');
    });
    const r = docAssetBytes(ctx, 'k', '1.2.3')!;
    expect(r.source).toBe('dataBase64');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warn', code: 'ASSET_BYTES_LOOKUP_FAILED', address: '1.2.3' });
  });

  it('tanpa sha256 assetBytes tidak dipanggil', () => {
    let called = false;
    const { ctx } = fakeCtx({ k: { kind: 'raster', dataBase64: B64_A } }, () => {
      called = true;
      return PNG_B;
    });
    expect(docAssetBytes(ctx, 'k')!.source).toBe('dataBase64');
    expect(called).toBe(false);
  });

  it('dataBase64 tidak sah -> invalidBase64; dataBase64 kosong -> hanya ref (jalur lama pemanggil)', () => {
    expect(docAssetBytes(fakeCtx({ k: { kind: 'raster', dataBase64: '@@@not-base64' } }).ctx, 'k')).toMatchObject({ invalidBase64: true });
    const r = docAssetBytes(fakeCtx({ k: { kind: 'raster', dataBase64: '' } }).ctx, 'k')!;
    expect(r.bytes).toBeUndefined();
    expect(r.source).toBeUndefined();
  });

  it('decodeBase64: kosong/tidak sah -> undefined; sah -> byte asli', () => {
    expect(decodeBase64('')).toBeUndefined();
    expect(decodeBase64('a$b')).toBeUndefined();
    expect(Buffer.from(decodeBase64(B64_A)!).equals(Buffer.from(PNG_A))).toBe(true);
  });
});

/** Kunci aset yang benar-benar dirujuk blok (medan `asset`) di dokumen. */
function referencedAssetKeys(doc: StudioDocV1): string[] {
  const keys = new Set<string>();
  const walk = (o: unknown, inAssets: boolean): void => {
    if (Array.isArray(o)) for (const v of o) walk(v, inAssets);
    else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (!inAssets && k === 'asset' && typeof v === 'string') keys.add(v);
        walk(v, false);
      }
    }
  };
  for (const [k, v] of Object.entries(doc as unknown as Record<string, unknown>)) if (k !== 'assets') walk(v, false);
  return [...keys].sort();
}

// SR-42 (D-138): fixture SERAH kini KONTEN SAJA (SR-41); blok device logo (sampul)
// disusun dari templat, jadi aset `logo_ilustrasi` tetap dideklarasikan tetapi tidak
// lagi dirujuk blok mana pun. Ekspektasi media/HTML/integritas memakai aset yang dirujuk.
const SERAH_REFERENCED = referencedAssetKeys(loadFixtureDoc('doc_serah_handover'));

describe('render: hanya-assetBytes = dataBase64 (fixture SERAH: aset yang dirujuk blok)', () => {
  let tpl: ResolvedTemplate;
  let base: StudioDocV1;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
    base = loadFixtureDoc('doc_serah_handover');
  }, 60_000);

  /** Dokumen salinan dengan dataBase64 dibuang + peta sha256 -> byte. */
  function stripped(): { doc: StudioDocV1; bytes: Map<string, Uint8Array> } {
    const doc = structuredClone(base);
    const bytes = new Map<string, Uint8Array>();
    for (const a of Object.values(doc.assets ?? {}) as Array<{ sha256: string; dataBase64?: string }>) {
      bytes.set(a.sha256, new Uint8Array(Buffer.from(a.dataBase64!, 'base64')));
      delete a.dataBase64;
    }
    return { doc, bytes };
  }

  it('fixture memang memuat aset raster ber-sha256 yang cocok dengan byte dataBase64', () => {
    const assets = Object.values(base.assets ?? {}) as Array<{ sha256: string; dataBase64: string }>;
    // SR-42 lanjutan (D-256): SR-41 menghapus `logo_ilustrasi` (sampul dibangun templat) dan
    // check_doc_fixtures kini menandai aset tak dirujuk; fixture SERAH memuat >= 1 aset, semuanya dirujuk.
    expect(assets.length).toBeGreaterThanOrEqual(1);
    for (const a of assets) expect(sha256(Buffer.from(a.dataBase64, 'base64'))).toBe(a.sha256);
    expect(SERAH_REFERENCED.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(base.assets ?? {}).sort()).toEqual(SERAH_REFERENCED);
  });

  /** sha256 aset yang dirujuk blok. */
  const referencedShas = (): string[] =>
    SERAH_REFERENCED.map((k) => (base.assets as Record<string, { sha256: string }>)[k].sha256);

  it('DOCX sha256 identik; media DOCX memuat byte aset persis; tanpa peringatan lookup', async () => {
    const withB64 = makeCtx(snapshotOf(structuredClone(base)), tpl);
    const a = await assembleDocxDetailed(withB64.ctx);
    const s = stripped();
    const onlyBytes = makeCtx(snapshotOf(s.doc), tpl, { assetBytes: (sha) => s.bytes.get(sha) });
    const b = await assembleDocxDetailed(onlyBytes.ctx);
    expect(sha256(b.bytes)).toBe(sha256(a.bytes));
    const media = Object.entries(unzip(b.bytes)).filter(([p]) => p.startsWith('word/media/')).map(([, v]) => sha256(v));
    for (const sha of referencedShas()) expect(media, `media untuk aset ${sha.slice(0, 12)}`).toContain(sha);
    expect(onlyBytes.logs.filter((l) => l.code === 'ASSET_BYTES_LOOKUP_FAILED')).toEqual([]);
  }, 60_000);

  it('HTML sha256 identik dan gambar aset tertanam sebagai data:image/png;base64 byte yang sama', async () => {
    const a = await assembleHtml(makeCtx(snapshotOf(structuredClone(base)), tpl).ctx, { preview: false });
    const s = stripped();
    const b = await assembleHtml(makeCtx(snapshotOf(s.doc), tpl, { assetBytes: (sha) => s.bytes.get(sha) }).ctx, { preview: false });
    expect(sha256(b)).toBe(sha256(a));
    for (const sha of referencedShas()) expect(b).toContain(`data:image/png;base64,${Buffer.from(s.bytes.get(sha)!).toString('base64')}`);
  }, 60_000);

  it.each(SERAH_REFERENCED)(
    'integritas: assetBytes mengembalikan byte yang sha256-nya bukan deklarasi (%s) -> BY_CONSTRUCTION_FAILED, tidak diam-diam dipakai',
    async (key) => {
      const doc = structuredClone(base);
      const sha = (doc.assets as Record<string, { sha256: string }>)[key].sha256;
      const wrong = makePng(600, 200, 3);
      const { ctx } = makeCtx(snapshotOf(doc), tpl, { assetBytes: (s) => (s === sha ? wrong : undefined) });
      await expect(assembleDocxDetailed(ctx)).rejects.toMatchObject({ code: 'BY_CONSTRUCTION_FAILED' });
    },
    60_000,
  );
});
