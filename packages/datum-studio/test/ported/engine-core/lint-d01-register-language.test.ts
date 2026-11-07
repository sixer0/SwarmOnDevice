// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/lint-d01-register-language.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S18 (DATUM Rev A, research/33 D-07/D-14): titik konstruksi Register lint
// struktur (`checks-d.ts`) membaca `meta.language`. D01 (audit angka tak
// terlacak, SERAH) menerima bentuk EN hanya untuk dokumen EN.
import { describe, it, expect, beforeAll } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { lintStructureWith } from '@/lib/studio/engine/lint/structure';
import { canonicalTemplate, makeDoc, snapshotOf, statuses } from './fixtures';

let KAN: ResolvedTemplate;
beforeAll(() => {
  KAN = canonicalTemplate();
});

const REGISTER = {
  'biaya pasang': { v: 1250000.5, dec: 1 as const, unit: 'Rp', mark: 'TERUKUR' as const, src: 'RAB' },
};

function d01(language: 'ID' | 'EN', text: string) {
  const doc = makeDoc({ tier: 'SERAH', language, register: REGISTER, blocks: [{ type: 'paragraph', text } as never] });
  return lintStructureWith(snapshotOf(doc), KAN, 'SERAH', { only: ['D01'] });
}

describe('D01 mengikuti konvensi angka bahasa dokumen', () => {
  it('EN: IDR 1,250,000.5 tertelusur -> PASS', () => {
    expect(statuses(d01('EN', 'Installation cost is IDR 1,250,000.5 in total.'), 'D01')).toEqual(['PASS']);
  });

  it('EN: bentuk ID 1.250.000,5 -> FAIL', () => {
    expect(statuses(d01('EN', 'Installation cost is 1.250.000,5 IDR in total.'), 'D01')).toEqual(['FAIL']);
  });

  it('ID: Rp 1.250.000,5 tertelusur -> PASS (perilaku lama)', () => {
    expect(statuses(d01('ID', 'Biaya pasang Rp 1.250.000,5 seluruhnya.'), 'D01')).toEqual(['PASS']);
  });

  it('ID: bentuk EN 1,250,000.5 -> FAIL', () => {
    expect(statuses(d01('ID', 'Biaya pasang IDR 1,250,000.5 seluruhnya.'), 'D01')).toEqual(['FAIL']);
  });
});
