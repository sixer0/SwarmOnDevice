// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig02b2-flowchart.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-02b2 (G-04): label simpul flowchart keluarga G dibungkus 3..6 baris saat fit grafik aktif,
// konsisten dengan bungkus simpul diagram. Tanpa fit: perilaku lama (maks 2 baris) tidak berubah.
import { describe, it, expect } from '../_vitest';
import { fitLines } from '@/lib/studio/engine/chart/family-g/flowchart';
import { withFit } from '@/lib/studio/engine/chart/core/fit';
import { textWidthMm } from '@/lib/studio/engine/chart/core/svg';

const LABEL = 'Pengadaan perangkat jaringan inti dan sakelar distribusi kantor';
const ROOM = { w: 22, h: 12 }; // ruang teks simpul keputusan sempit (mm)
const ctx = { minFontPt: 5.5 };

describe('G-04 bungkus label simpul', () => {
  it('tanpa fit: maks 2 baris (perilaku lama)', () => {
    const r = fitLines(ctx, LABEL, ROOM, 6.8);
    expect(r.lines.length).toBeLessThanOrEqual(2);
    expect(r.fits).toBe(false);
  });

  it('dengan fit: dibungkus >= 3 baris yang muat lebar ruang; semua kata tetap ada', () => {
    const r = withFit({ widthMm: 166, notes: [] }, () => fitLines(ctx, LABEL, ROOM, 6.8));
    expect(r.lines.length).toBeGreaterThanOrEqual(3);
    for (const l of r.lines) expect(textWidthMm(l, r.size)).toBeLessThanOrEqual(ROOM.w + 1e-6);
    expect(r.lines.join(' ')).toBe(LABEL);
  });

  it('label yang sudah muat 1-2 baris tidak berubah oleh fit', () => {
    const a = fitLines(ctx, 'Kirim teknisi', ROOM, 6.8);
    const b = withFit({ widthMm: 166, notes: [] }, () => fitLines(ctx, 'Kirim teknisi', ROOM, 6.8));
    expect(b).toEqual(a);
  });

  it('deterministik', () => {
    const f = () => withFit({ widthMm: 166, notes: [] }, () => fitLines(ctx, LABEL, ROOM, 6.8));
    expect(f()).toEqual(f());
  });
});
