// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig02a-geometry-lint.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-02a: lint geometri teks chart (tanpa browser) + REPORT bersaran + tata letak otomatis
// berpagar cacat di renderChart (render bersih byte-identik dengan jalur tanpa fit).
import { describe, it, expect } from '../_vitest';
import { renderChart } from '@/lib/studio/engine/chart/core';
import { withFit } from '@/lib/studio/engine/chart/core/fit';
import { CHART_LINT_OPTIONS, GEOMETRY_CHECKS, geometryIssues, hintCtxFromSpec, lintChartGeometry, pathPolylines } from '@/lib/studio/engine/chart/core/geometry';
import { PARITY_CHART_DIR, clone, readJson } from './_helpers';
import { CLEAN_SVG_MANIFEST, type CleanSvgManifest, sha256 } from './_svgManifest';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const T = (x: number, y: number, s: string, extra = '') =>
  `<text x="${x}" y="${y}" font-family="IBM Plex Sans Condensed" font-size="2.4" fill="#000000" text-anchor="start"${extra}>${s}</text>`;
const svg = (body: string, w = 100, h = 50) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">\n${body}\n</svg>`;

describe('lintChartGeometry', () => {
  it('SVG bersih -> skor 0', () => {
    const g = lintChartGeometry(svg(`${T(5, 10, 'Satu')}${T(5, 20, 'Dua')}<rect data-mark="bar" x="40" y="5" width="20" height="10" fill="#333333"/>`));
    expect(g.score).toBe(0);
    expect(g.nText).toBe(2);
  });

  it('dua teks bertumpuk -> 1 pasangan textOverlap', () => {
    const g = lintChartGeometry(svg(`${T(5, 10, 'Kategori panjang')}${T(8, 10.5, 'Kategori lain')}`));
    expect(g.counts.textOverlap).toBe(1);
    expect(g.defects[0]).toMatchObject({ kind: 'textOverlap', text: 'Kategori panjang', other: 'Kategori lain' });
  });

  it('teks keluar viewBox -> textOutside dengan sisi', () => {
    const g = lintChartGeometry(svg(`<text x="1" y="10" font-family="IBM Plex Sans Condensed" font-size="2.4" fill="#000000" text-anchor="end">Label di kiri</text>`));
    expect(g.counts.textOutside).toBe(1);
    expect(g.defects[0].side).toBe('left');
  });

  it('teks setengah di atas tanda berisi -> textStraddleMark; seluruhnya di dalam -> bukan cacat', () => {
    const half = lintChartGeometry(svg(`<rect data-mark="bar" x="0" y="0" width="12" height="30" fill="#333333"/>${T(8, 10, 'Nilai 123')}`));
    expect(half.counts.textStraddleMark).toBe(1);
    const inside = lintChartGeometry(svg(`<rect data-mark="bar" x="0" y="0" width="60" height="30" fill="#333333"/>${T(8, 10, 'Nilai 123')}`));
    expect(inside.counts.textStraddleMark).toBe(0);
  });

  it('dekorasi tanpa data-mark diabaikan (latar kertas, pita)', () => {
    const g = lintChartGeometry(svg(`<rect data-bg="paper" width="100" height="50" fill="#FFFFFF"/><rect x="0" y="0" width="12" height="30" fill="#EEEEEE"/>${T(8, 10, 'Nilai 123')}`));
    expect(g.score).toBe(0);
  });

  it('garis data menembus teks -> lineThroughText', () => {
    const g = lintChartGeometry(svg(`${T(10, 10, 'Teks sumbu')}<line data-mark="line" x1="0" y1="9.1" x2="90" y2="9.1" stroke="#000000" stroke-width="0.3"/>`));
    expect(g.counts.lineThroughText).toBe(1);
  });

  it('baris tspan dalam satu <text> tidak dibandingkan satu sama lain; dibandingkan dengan teks lain', () => {
    const wrapped = `<text x="10" y="10" font-family="IBM Plex Sans Condensed" font-size="2.4" fill="#000000" text-anchor="start"><tspan x="10" dy="0">Baris satu</tspan><tspan x="10" dy="1">Baris dua</tspan></text>`;
    expect(lintChartGeometry(svg(wrapped)).score).toBe(0);
    expect(lintChartGeometry(svg(wrapped + T(10, 11, 'Teks lain'))).counts.textOverlap).toBeGreaterThan(0);
  });

  it('rotasi ikut dihitung: label miring -45 derajat menggantung ke kiri bawah', () => {
    const rot = `<text x="20" y="20" font-family="IBM Plex Sans Condensed" font-size="2.4" fill="#000000" text-anchor="end" transform="rotate(-45 20 20)">Label miring yang cukup panjang</text>`;
    const g = lintChartGeometry(svg(rot, 100, 30));
    expect(g.counts.textOutside).toBe(1);
    expect(g.defects[0].side).toBe('left');
  });

  it('path busur/kurva diratakan; poligon tertutup diuji isiannya', () => {
    const pl = pathPolylines('M0 0L10 0L10 10Z');
    expect(pl[0][0]).toEqual([0, 0]);
    expect(pl[0][pl[0].length - 1]).toEqual([0, 0]);
    const arc = pathPolylines('M0 0A5 5 0 0 1 10 0');
    expect(arc[0].length).toBeGreaterThan(4);
    expect(arc[0][arc[0].length - 1][0]).toBeCloseTo(10, 6);
  });

  it('deterministik', () => {
    const s = svg(`${T(5, 10, 'Kategori panjang')}${T(8, 10.5, 'Kategori lain')}`);
    expect(lintChartGeometry(s)).toEqual(lintChartGeometry(s));
  });
});

describe('geometryIssues', () => {
  it('REPORT (tidak pernah FAIL) per jenis cacat, dengan suggest yang bisa dipakai agen', () => {
    const g = lintChartGeometry(svg(`${T(5, 10, 'Kategori panjang')}${T(8, 10.5, 'Kategori lain')}${T(95, 30, 'Keluar kanan')}`));
    const ctx = { code: 'P-02', nCategories: 20, maxLabelChars: 60, maxSeriesChars: 0 };
    const issues = geometryIssues(g, ctx);
    expect(issues.map((i) => i.checkId).sort()).toEqual([GEOMETRY_CHECKS.textOutside, GEOMETRY_CHECKS.textOverlap].sort());
    for (const i of issues) {
      expect(i.status).toBe('REPORT');
      expect(i.suggest).toContain('orientation: "horizontal"');
      expect(i.suggest).toContain('labelShort');
      expect(i.suggest).toContain('topN');
      expect(i.detail).toContain('saran:');
    }
  });

  it('hintCtxFromSpec membaca jumlah kategori dan panjang label/seri', () => {
    const c = hintCtxFromSpec({ kind: 'P-03', data: { shape: 'series', categories: ['a', 'bbbb'], series: [{ name: 'xyz', values: [1, 2] }] } });
    expect(c).toEqual({ code: 'P-03', nCategories: 2, maxLabelChars: 4, maxSeriesChars: 3 });
  });
});

describe('renderChart: tata letak otomatis berpagar cacat (FIG-02a)', () => {
  const fixtures = readdirSync(PARITY_CHART_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson<Record<string, unknown>>(path.join(PARITY_CHART_DIR, f)));

  // ENG-FIX #3: uji ini dulu bernama "byte-identik" tetapi tidak membandingkan dengan acuan apa pun.
  // Kini setiap fixture lint-bersih (gaya datum) dibandingkan dengan sha256 yang di-commit di
  // `__fixtures__/clean-svg-manifest.json` (penjaga lengkap: `clean-svg-manifest.test.ts`).
  it('fixture yang lint-bersih (datum): sha256 SVG == manifest yang di-commit, tanpa isu AUTO_FIT/GEOM_*', () => {
    const manifest = readJson<CleanSvgManifest>(CLEAN_SVG_MANIFEST).renders;
    const files = readdirSync(PARITY_CHART_DIR).filter((f) => f.endsWith('.json')).sort();
    let clean = 0;
    for (const f of files) {
      const r = renderChart({ ...clone(readJson<Record<string, unknown>>(path.join(PARITY_CHART_DIR, f))), style: 'datum' } as never);
      if (r.report.issues.some((i) => i.checkId === 'AUTO_FIT' || i.checkId.startsWith('GEOM_'))) continue; // render fit; dikunci di manifest `fitted`
      clean++;
      expect(lintChartGeometry(r.svg, CHART_LINT_OPTIONS).score).toBe(0);
      expect(sha256(r.svg)).toBe(manifest[`chart/${f}@datum`]);
    }
    expect(clean).toBeGreaterThan(40);
  });

  it('P-02 berlabel panjang -> AUTO_ORIENT ke batang horizontal, lint bersih, deterministik', () => {
    const spec = clone(fixtures.find((s) => s.kind === 'P-02')) as Record<string, unknown> & { data: { points: { label: string }[] } };
    spec.data.points.forEach((p, i) => (p.label = `Dinas Pekerjaan Umum dan Penataan Ruang Kabupaten ${i + 1}`));
    const a = renderChart(clone(spec) as never);
    const b = renderChart(clone(spec) as never);
    expect(a.svg).toBe(b.svg);
    const ids = a.report.issues.map((i) => i.checkId);
    expect(ids).toContain('AUTO_FIT');
    expect(ids).toContain('AUTO_ORIENT');
    expect(a.svg).toContain('data-chart="P-01"');
    expect(lintChartGeometry(a.svg).score).toBe(0);
    expect(a.report.issues.filter((i) => i.status === 'FAIL')).toEqual([]);
  });

  it('caption apparatus figure panjang dibungkus (tspan) dan kanvas bertambah tinggi', () => {
    const spec = clone(fixtures.find((s) => s.kind === 'P-03')) as Record<string, unknown>;
    spec.apparatus = 'figure';
    spec.id = 'Gambar 8.12';
    spec.title = 'Perbandingan realisasi dan target anggaran pemeliharaan infrastruktur jaringan menurut satuan kerja perangkat daerah selama tiga tahun anggaran terakhir.';
    delete spec.heightMm;
    const r = renderChart(clone(spec) as never);
    expect(r.report.issues.map((i) => i.checkId)).toContain('CAPTION_WRAP');
    expect(r.svg).toContain('<tspan');
    expect(lintChartGeometry(r.svg).counts.textOutside).toBe(0);
  });

  it('di luar withFit, pembantu sadar-fit tidak aktif (render P-02 panjang tanpa autofit tetap kolom)', () => {
    // withFit hanya aktif di dalam render ulang; status dipulihkan setelahnya.
    const notes: { checkId: string; detail: string }[] = [];
    const inside = withFit({ widthMm: 128, notes }, () => 1);
    expect(inside).toBe(1);
    const spec = clone(fixtures.find((s) => s.kind === 'P-02')) as never;
    expect(renderChart(spec).svg).toContain('data-chart="P-02"');
  });
});
