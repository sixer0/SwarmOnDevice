// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/registry/s11-doc-typecode-nda.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * S11 (blueprint 02_structured_datum_rev_a.md, P0-2; D-590): kode jenis NDA diterima `doc.typeCode`
 * tanpa mengubah daftar bawaan; nilai bawaan masuk `paramsSha256`, jadi sidik profil kanonik tetap.
 */
import { describe, expect, it } from '../_vitest';
import { PARAMS_BY_KEY } from '@/lib/studio/params';
import { resolveParams, validateParamValue } from '@/lib/studio/engine/tokens';
import { ALL_PARAMS } from '@/lib/studio/params';
import { canonicalVersionPayload } from '@/lib/studio/services/templates';
import { sha256Hex, stableStringify } from '@/lib/studio/services/ingest/util'; // row42 ADAPT A2

const DEF = PARAMS_BY_KEY.get('doc.typeCode')!;

describe('S11 doc.typeCode NDA', () => {
  it('NDA diterima sebagai anggota daftar kode jenis', () => {
    expect(validateParamValue(DEF, ['KT', 'NDA'])).toBeNull();
    const r = resolveParams({ base: {}, overrides: { 'doc.typeCode': ['KT', 'PT', 'NDA'] }, registry: ALL_PARAMS });
    expect(r.errors).toEqual([]);
    expect(r.params['doc.typeCode']).toEqual(['KT', 'PT', 'NDA']);
  });

  it('kode di luar daftar tertutup tetap ditolak', () => {
    expect(validateParamValue(DEF, ['KT', 'XYZ'])).not.toBeNull();
  });

  it('daftar bawaan tidak berubah (NDA tidak masuk bawaan)', () => {
    expect(DEF.default).toEqual(['KT', 'PT', 'RAB', 'SPH', 'SP', 'BA', 'DS', 'STD']);
  });

  it('paramsSha256 kanonik tidak berubah', () => {
    // Nilai sebelum S11 (diukur 2026-11-04 di working tree v2.1, juga `registryParamsSha256` log seed dry-run DEV):
    // a18d36eafa6bdabe9035d1a68b410c439177c33c342937a281205ed5ac517a9f. Pin ini bergerak dengan setiap parameter
    // registri baru berbawaan (verification/30 R2): C06 (R-67..R-80, 2026-11-05) dihitung ulang, bukan ditebak,
    // dan sama dengan `registryParamsSha256` dry-run seed DEV C06. Tambahan enum saja tidak menggerakkannya.
    // row42 ADAPT A2 (C40, row 122): the pin moves with every new registry param with a default (comment above);
    // row 122 appends R-81..R-83 (params/render.ts:417-436). Assert the pin over the params WITHOUT those three keys,
    // and that paramsSha256 is still the hash of the full resolved params.
    const p = canonicalVersionPayload();
    expect(p.paramsSha256).toBe(sha256Hex(stableStringify(p.resolvedParams)));
    const R122 = ['controlSheet.methodStatement.text', 'controlSheet.distribution.defaults', 'cover.controlBlock.geodeticDatum'];
    for (const k of R122) expect(k in p.resolvedParams, k).toBe(true);
    const pre = Object.fromEntries(Object.entries(p.resolvedParams).filter(([k]) => !R122.includes(k)));
    // row49a ADAPT (C104 H1, Rev A DT-28d): P4C-35 color.classificationInk default is now seal at every level; the pin
    // holds with that one value set back to its pre-H1 default, so no other registry default moved.
    expect(pre['color.classificationInk']).toEqual({ SR: 'seal', R: 'seal', T: 'seal', B: 'seal' });
    pre['color.classificationInk'] = { SR: 'alert', R: 'alert', T: 'ink900', B: 'ink900' };
    expect(sha256Hex(stableStringify(pre))).toBe('dcb7166bc12ab7d6c34906b376a7da6d7562f0d8c1d70ea81a3fd4b396a5dfd9');
  });
});
