// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/seed/l8-skeleton-labels-text-table.test.ts (see test/ported/README.md).
import { seedModule, useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * L8 (D-610; review `verification/24_datum_rev_a_code_review.md` L8): label slot ID kerangka datum-gsp untuk lembar
 * kendali dan daftar isi berasal dari tabel teks pembungkus, jadi terjemahan EN (`controlSheetLabelText`) tetap
 * bekerja setelah satu suntingan; nilai tersimpan tetap byte-sama ("Lembar Kendali", "Daftar Isi").
 */
import { describe, expect, it } from '../_vitest';
import { controlSheetLabelText, WRAPPER_TEXT } from '../../../vendor/src/lib/studio/engine/front/texts';
const { DATUM_SKELETON_SLOTS } = (await import(seedModule('seed-studio-templates'))) as any; // row42 W14

const label = (key: string) => DATUM_SKELETON_SLOTS.find((s) => s.slotKey === key)?.label;

describe('L8: label slot kerangka datum-gsp dari tabel teks', () => {
  it('nilai tersimpan tetap literal lama (kerangka byte-sama)', () => {
    expect(label('controlSheet')).toBe('Lembar Kendali');
    expect(label('toc')).toBe('Daftar Isi');
  });

  it('label = entri ID tabel teks, sehingga dokumen EN menerjemahkan label lembar kendali', () => {
    expect(label('controlSheet')).toBe(WRAPPER_TEXT.controlKicker.ID);
    expect(label('toc')).toBe(WRAPPER_TEXT.tocKicker.ID);
    expect(controlSheetLabelText(label('controlSheet') as string, 'EN')).toBe('Control Sheet');
  });
});
