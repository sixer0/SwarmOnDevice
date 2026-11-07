// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/fig02a-textfit.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIG-02a: modul bersama `textfit` (ukur, bungkus, potong) — API yang juga dipakai FIG-02b.
import { describe, it, expect } from '../_vitest';
import {
  ELLIPSIS,
  ellipsize,
  firstBaseline,
  fitWithinSpan,
  lineHeightMm,
  measure,
  measureEm,
  tspanLines,
  wrap,
  wrapEllipsize,
} from '@/lib/studio/engine/chart/core/textfit';

const LONG = 'Dinas Pekerjaan Umum dan Penataan Ruang Kabupaten Bandung Barat';
const MM_PER_PT = 25.4 / 72;

describe('textfit.measure', () => {
  it('struct memakai tabel glif IBM Plex Sans Condensed: "Pengadaan perangkat" = 8,805 em (Chromium, 400)', () => {
    // Acuan independen: canvas.measureText Chromium pada IBMPlexSansCond-Regular.ttf.
    expect(measureEm('Pengadaan perangkat')).toBeCloseTo(8.805, 1);
    expect(measureEm('Pengadaan perangkat', 'struct', true)).toBeCloseTo(9.175, 1);
  });

  it('mono = 0,6 em per glif; mm = em x pt x 25,4/72 + tracking per glif', () => {
    expect(measure('ABCDE', 10, 'data')).toBeCloseTo(5 * 0.6 * 10 * MM_PER_PT, 9);
    expect(measure('ab', 10, 'data', { trackMm: 0.5 })).toBeCloseTo(2 * 0.6 * 10 * MM_PER_PT + 1.0, 9);
  });

  it('caps mengukur versi kapital (lebih lebar dari huruf kecil)', () => {
    expect(measure('kategori', 6.4, 'struct', { caps: true })).toBeGreaterThan(measure('kategori', 6.4));
  });

  it('glif di luar tabel = 0,5 em', () => {
    expect(measureEm('漢')).toBeCloseTo(0.5, 9);
  });
});

describe('textfit.wrap', () => {
  const font = { pt: 6.4 };

  it('teks yang muat tetap satu baris', () => {
    const r = wrap('Kategori 01', 50, 3, font);
    expect(r).toEqual({ lines: ['Kategori 01'], widthMm: measure('Kategori 01', 6.4), fits: true });
  });

  it('memecah di batas kata, setiap baris <= maxW, kata utuh dan berurutan', () => {
    const r = wrap(LONG, 30, 3, font);
    expect(r.fits).toBe(true);
    expect(r.lines.length).toBeGreaterThan(1);
    expect(r.lines.length).toBeLessThanOrEqual(3);
    for (const l of r.lines) expect(measure(l, 6.4)).toBeLessThanOrEqual(30 + 1e-9);
    expect(r.lines.join(' ')).toBe(LONG);
  });

  it('memilih jumlah baris paling sedikit yang muat', () => {
    const w = measure(LONG, 6.4);
    const r = wrap(LONG, w * 0.6, 3, font);
    expect(r.fits).toBe(true);
    expect(r.lines).toHaveLength(2);
  });

  it('baris terlebar minimum (seimbang): 2 baris tidak lebih lebar dari pemecahan rakus', () => {
    const w = measure(LONG, 6.4);
    const r = wrap(LONG, w * 0.6, 2, font);
    // pemecahan rakus mengisi baris pertama sampai penuh
    const words = LONG.split(' ');
    let first = '';
    for (const word of words) {
      const t = first ? `${first} ${word}` : word;
      if (measure(t, 6.4) > w * 0.6) break;
      first = t;
    }
    const greedyMax = Math.max(measure(first, 6.4), measure(LONG.slice(first.length + 1), 6.4));
    expect(r.widthMm).toBeLessThanOrEqual(greedyMax + 1e-9);
  });

  it('tidak muat dalam maxLines -> fits=false, tetap <= maxLines baris', () => {
    const r = wrap(LONG, 10, 2, font);
    expect(r.fits).toBe(false);
    expect(r.lines.length).toBeLessThanOrEqual(2);
    expect(r.lines.join(' ')).toBe(LONG);
  });

  it('deterministik', () => {
    expect(wrap(LONG, 25, 3, font)).toEqual(wrap(LONG, 25, 3, font));
  });
});

describe('textfit.ellipsize / wrapEllipsize', () => {
  const font = { pt: 6.4 };

  it('teks muat dikembalikan apa adanya', () => {
    expect(ellipsize('Pendek', 40, font)).toEqual({ text: 'Pendek', truncated: false });
  });

  it('teks panjang dipotong ke <= maxW dan diakhiri elipsis; prefiks teks asli', () => {
    const e = ellipsize(LONG, 20, font);
    expect(e.truncated).toBe(true);
    expect(e.text.endsWith(ELLIPSIS)).toBe(true);
    expect(measure(e.text, 6.4)).toBeLessThanOrEqual(20 + 1e-9);
    expect(LONG.startsWith(e.text.slice(0, -1).trimEnd())).toBe(true);
  });

  it('wrapEllipsize: <= maxLines baris, semua <= maxW, truncated bila ada yang hilang', () => {
    const r = wrapEllipsize(LONG, 18, 2, font);
    expect(r.lines).toHaveLength(2);
    expect(r.truncated).toBe(true);
    for (const l of r.lines) expect(measure(l, 6.4)).toBeLessThanOrEqual(18 + 1e-9);
  });
});

describe('textfit.fitWithinSpan', () => {
  const font = { pt: 6.4 };

  it('label yang muat -> null (jalur lama)', () => {
    expect(fitWithinSpan('Kat 01', 50, 'middle', 0, 128, font)).toBeNull();
  });

  it('label tengah di tepi kiri digeser ke dalam (tetap satu baris)', () => {
    const f = fitWithinSpan('Kategori panjang', 2, 'middle', 0.4, 127.6, font);
    expect(f).not.toBeNull();
    const w = measure('Kategori panjang', 6.4);
    expect(f!.lines).toEqual(['Kategori panjang']);
    expect(f!.x - w / 2).toBeGreaterThanOrEqual(0.4 - 1e-9);
  });

  it('label rata kanan yang melewati tepi kiri dibungkus ke ruang sampai tepi', () => {
    const f = fitWithinSpan(LONG, 40, 'end', 0.4, 127.6, font);
    expect(f).not.toBeNull();
    expect(f!.anchor).toBe('end');
    for (const l of f!.lines) expect(measure(l, 6.4)).toBeLessThanOrEqual(40 - 0.4 + 1e-9);
  });
});

describe('textfit.tspanLines / firstBaseline / lineHeightMm', () => {
  it('satu baris = teks polos ter-escape; multi-baris = tspan x/dy dalam satu <text>', () => {
    expect(tspanLines(['a & b'], 3, 2.7)).toBe('a &amp; b');
    expect(tspanLines(['a', 'b<c'], 3, 2.7)).toBe('<tspan x="3" dy="0">a</tspan><tspan x="3" dy="2.7">b&lt;c</tspan>');
  });

  it('firstBaseline rata atas/tengah/bawah', () => {
    expect(firstBaseline(10, 3, 2, 'top')).toBe(10);
    expect(firstBaseline(10, 3, 2, 'middle')).toBe(8);
    expect(firstBaseline(10, 3, 2, 'bottom')).toBe(6);
  });

  it('tinggi baris = 1,2 em', () => {
    expect(lineHeightMm({ pt: 10 })).toBeCloseTo(12 * MM_PER_PT, 9);
  });
});
