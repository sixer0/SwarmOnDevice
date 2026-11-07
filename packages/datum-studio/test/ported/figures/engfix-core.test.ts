// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/engfix-core.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// ENG-FIX (D-502, review kode ronde 4 `verification/10_round4_code_review.md`): perbaikan inti
// pagar fit chart. #1 penjaga tepi kanvas memakai tepi kanvas nyata; #2 `attempt()` hanya
// menelan StudioEngineError; #4 skor kandidat memberi penalti label disembunyikan/dipotong;
// #9 `attachFullLabels` hanya pada teks label kategori.
import { describe, it, expect } from '../_vitest';
import { StudioEngineError } from '@/lib/studio/contract/errors';
import type { StudioChartV1, SvgResult } from '@/lib/studio/contract';
import { autoFitChart, candidateScore } from '@/lib/studio/engine/chart/core/autofit';
import { fitHidden, withFit } from '@/lib/studio/engine/chart/core/fit';
import { lintChartGeometry } from '@/lib/studio/engine/chart/core/geometry';
import { attachFullLabels } from '@/lib/studio/engine/chart/core/intent';
import { SvgDoc } from '@/lib/studio/engine/chart/core/svg';
import { fitWithinSpan, measure } from '@/lib/studio/engine/chart/core/textfit';

const W = 128;
const textIn = (fn: (d: SvgDoc) => void): string => {
  const d = new SvgDoc(W, 50);
  withFit({ widthMm: W, notes: [] }, () => fn(d));
  return d.toString();
};

describe('#1 penjaga tepi kanvas (SvgDoc.text dalam withFit)', () => {
  it('teks rata kiri di x=0 yang muat tidak diubah (anchor tetap start, x tetap 0)', () => {
    const out = textIn((d) => d.text(0, 40, 'Gambar 1   Judul pendek', { sizePt: 6.4, fill: '#000000' }));
    expect(out).toMatch(/<text x="0" y="40" [^>]*text-anchor="start"[^>]*>Gambar 1   Judul pendek<\/text>/);
  });

  it('teks rata kanan tepat di tepi kanan yang muat tidak diubah', () => {
    const out = textIn((d) => d.text(W, 40, 'SUMBER: data dinas', { sizePt: 6.4, fill: '#000000', anchor: 'end' }));
    expect(out).toMatch(/<text x="128" y="40" [^>]*text-anchor="end"[^>]*>SUMBER: data dinas<\/text>/);
  });

  it('teks yang benar-benar keluar tepi kiri tetap dijaga ke dalam kanvas', () => {
    const out = textIn((d) => d.text(1, 20, 'Label tengah cukup panjang', { sizePt: 6.4, fill: '#000000', anchor: 'middle' }));
    expect(lintChartGeometry(`<svg viewBox="0 0 ${W} 50">${out}</svg>`).counts.textOutside).toBe(0);
    expect(out).not.toMatch(/<text x="1" /);
  });

  it('fitWithinSpan: batas "keluar" opsional terpisah dari rentang penempatan', () => {
    const font = { pt: 6.4 };
    // muat di kanvas [0, 128] walau di luar rentang penempatan [0.4, 127.6] -> null
    expect(fitWithinSpan('Judul pendek', 0, 'start', 0.4, 127.6, font, 2, { lo: 0, hi: 128 })).toBeNull();
    // tanpa batas terpisah: perilaku lama (dipindah)
    expect(fitWithinSpan('Judul pendek', 0, 'start', 0.4, 127.6, font)).not.toBeNull();
    // keluar kanvas nyata -> ditempatkan di [0.4, 127.6]
    const w = measure('Judul pendek', 6.4);
    const f = fitWithinSpan('Judul pendek', -2, 'start', 0.4, 127.6, font, 2, { lo: 0, hi: 128 });
    expect(f).not.toBeNull();
    expect(f!.x - w / 2).toBeGreaterThanOrEqual(0.4 - 1e-9);
  });
});

const SPEC = { kind: 'P-01', widthMm: W, data: { shape: 'categorical', points: [{ label: 'a', value: 1 }] } } as unknown as StudioChartV1;
const FIRST_SVG = `<svg viewBox="0 0 ${W} 40"><text x="10" y="10" font-family="IBM Plex Sans Condensed" font-size="2.4" fill="#000000" text-anchor="start">Kategori panjang</text><text x="12" y="10.4" font-family="IBM Plex Sans Condensed" font-size="2.4" fill="#000000" text-anchor="start">Kategori lain</text></svg>`;
const FIRST: SvgResult = { svg: FIRST_SVG, widthMm: W, heightMm: 40, report: { issues: [] } } as unknown as SvgResult;

describe('#2 autoFitChart: hanya StudioEngineError yang ditelan', () => {
  const firstGeo = lintChartGeometry(FIRST_SVG);

  it('pembantu fit melempar TypeError -> galat diteruskan (tidak diam-diam jatuh ke render pertama)', () => {
    const r = {
      render: () => {
        throw new TypeError('regresi pembantu fit');
      },
      estimate: () => 40,
      maxHeightMm: 200,
    };
    expect(firstGeo.score).toBeGreaterThan(0);
    expect(() => autoFitChart(SPEC, FIRST, firstGeo, r)).toThrow(TypeError);
  });

  it('kandidat ditolak mesin (StudioEngineError, mis. DATUM-33) -> render pertama dipertahankan', () => {
    const r = {
      render: () => {
        throw new StudioEngineError('BY_CONSTRUCTION_FAILED', 'DATUM-33: tinggi');
      },
      estimate: () => 40,
      maxHeightMm: 200,
    };
    const out = autoFitChart(SPEC, FIRST, firstGeo, r);
    expect(out.res).toBe(FIRST);
    expect(out.extra.map((i) => i.checkId)).not.toContain('AUTO_FIT');
  });
});

describe('#4 skor kandidat: penalti label disembunyikan/dipotong', () => {
  const T = (x: number, y: number, s: string) =>
    `<text x="${x}" y="${y}" font-family="IBM Plex Sans Condensed" font-size="2.4" fill="#000000" text-anchor="start">${s}</text>`;
  const svgOf = (body: string, h = 40) => `<svg viewBox="0 0 ${W} ${h}">${body}</svg>`;
  const overlapPair = (y: number) => `${T(10, y, 'Kategori panjang')}${T(12, y + 0.4, 'Kategori lain')}`;

  it('candidateScore = cacat (+1 tambahan per teks keluar kanvas) + 1 per label disembunyikan + 0,5 per label elipsis', () => {
    const ell = svgOf(`<g data-fit="ellipsis"><title>Teks penuh</title>${T(5, 5, 'Teks…')}</g>`);
    expect(candidateScore({ score: 0 }, svgOf(''), 6)).toBe(6);
    expect(candidateScore({ score: 1 }, svgOf(''), 0)).toBe(1);
    expect(candidateScore({ score: 0 }, ell, 0)).toBe(0.5);
    // teks keluar kanvas = 2 (lebih buruk dari satu label disembunyikan)
    expect(candidateScore({ score: 1, counts: { textOutside: 1 } }, svgOf(''), 0)).toBe(2);
    expect(candidateScore({ score: 0, counts: { textOutside: 0 } }, svgOf(''), 1)).toBe(1);
  });

  it('fitHidden menjumlah di dalam withFit (tanpa ringkasan) dan diabaikan di luar fit', () => {
    fitHidden(3);
    const st = { widthMm: W, notes: [] as { checkId: string; detail: string }[], hidden: undefined as number | undefined };
    withFit(st, () => {
      fitHidden(2);
      fitHidden(2);
      fitHidden(0);
    });
    expect(st.hidden).toBe(4);
  });

  it('kandidat yang menyembunyikan 6 label (0 cacat) kalah dari kandidat dengan 1 tumpuk kecil', () => {
    const first = svgOf(`${overlapPair(5)}${overlapPair(15)}${overlapPair(25)}`);
    const firstGeo = lintChartGeometry(first);
    expect(firstGeo.score).toBe(3);
    const r = {
      render: (_s: StudioChartV1, h?: number) => {
        if (h === 40) {
          fitHidden(6); // pembantu fit menyembunyikan 6 label -> lint bersih
          return { res: { svg: svgOf(T(10, 5, 'Sisa')), widthMm: W, heightMm: 40, report: { issues: [] } } as unknown as SvgResult, heightMm: 40 };
        }
        return { res: { svg: svgOf(overlapPair(5), 50), widthMm: W, heightMm: 50, report: { issues: [] } } as unknown as SvgResult, heightMm: 50 };
      },
      estimate: () => 40,
      maxHeightMm: 200,
    };
    const out = autoFitChart(SPEC, { ...FIRST, svg: first } as SvgResult, firstGeo, r);
    expect(out.res.heightMm).toBe(50);
    expect(lintChartGeometry(out.res.svg).score).toBe(1);
    expect(out.extra.find((i) => i.checkId === 'AUTO_FIT')?.detail).toContain('sisa 1');
  });
});

describe('#9 attachFullLabels hanya pada teks label kategori', () => {
  const T = (s: string, extra = '') => `<text x="5" y="5" font-family="IBM Plex Mono" font-size="2.3" fill="#000000" text-anchor="end"${extra}>${s}</text>`;

  it('label sumbu kategori mendapat <title>; label nilai/tick angka yang kebetulan sama tidak', () => {
    const shorts = new Map([['DPUPR', 'Dinas Pekerjaan Umum dan Penataan Ruang']]);
    const svg = `<svg>${T('DPUPR')}${T('DPUPR', ' data-label="value"')}${T('DPUPR', ' data-label="series"')}</svg>`;
    const out = attachFullLabels(svg, shorts);
    expect(out.split('data-label-short="1"').length - 1).toBe(1);
    expect(out).toContain('<g data-label-short="1"><title>Dinas Pekerjaan Umum dan Penataan Ruang</title><text');
  });

  it('label singkat angka tidak menempel ke tick/nilai angka', () => {
    const shorts = new Map([['2020', 'Tahun anggaran 2020']]);
    const svg = `<svg>${T('2020')}${T('2020', ' data-label="value"')}</svg>`;
    expect(attachFullLabels(svg, shorts)).toBe(svg);
  });

  it('spasi ganda di teks dibaca seperti peramban (unescape bersama)', () => {
    const shorts = new Map([['A & B', 'Alpha dan Beta']]);
    const out = attachFullLabels(`<svg>${T('A &amp;  B')}</svg>`, shorts);
    expect(out).toContain('<title>Alpha dan Beta</title>');
  });
});
