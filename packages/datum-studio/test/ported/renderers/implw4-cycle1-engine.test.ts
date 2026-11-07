// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/implw4-cycle1-engine.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// IMPL-W4 siklus perbaikan 1 (D-553, review 15 mesin ronde 6): F1 label artefak ganda, F2 penjaga fon menolak SVG sah
// (5 kasus reviewer), F3 kode 422, F4 satu sumber wajah fon (sha256, aset templat), F5 lint struktur memakai label
// snapshot, F6 berkas fon hilang = keras, F7 glif simbol (≤ ≥ →), F10 label yatim/diabaikan diperingatkan, F11 alamat
// label bagian depan.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot } from '@/lib/studio/contract';
import { formatAddress, parseAddress } from '@/lib/studio/contract/address';
import { getStudioEnv, resetStudioEnvCache } from '@/lib/studio/contract/env';
import { closeBrowser, rasterizeSvg } from '@/lib/studio/engine/browser';
import { rasterFontCss } from '@/lib/studio/engine/browser/raster-fonts';
import { walkDoc } from '@/lib/studio/engine/lint/structure/walk';
import { composeV2 } from '@/lib/studio/services/compose';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';

const t = (text: string) => ({ text });
const table = (cap: string) => ({ type: 'table', caption: t(cap), columns: [{ role: 'text' }, { role: 'text' }], rows: [{ kind: 'header', cells: [t('A'), t('B')] }, { cells: [t('x'), t('y')] }], source: { text: 'src' } });
function compose(mut: (d: any) => void) {
  const d = e1();
  mut(d);
  const slots = datumSlots();
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() });
}

describe('F1/F10: compose', () => {
  it('F1: label sumber "2" pada bab 1 + bab 2 tanpa label -> BY_CONSTRUCTION_FAILED (bukan "Tabel 2.1" ganda)', () => {
    expect(() =>
      compose((d) => {
        d.sections.content.chapters[0].sections[0].blocks.push(table('Satu'));
        d.sections.content.outline = [{ key: '1', label: '2' }, { key: '2' }];
      }),
    ).toThrow(/ganda|BY_CONSTRUCTION_FAILED/);
  });

  it('F10: label yatim (kunci outline tanpa bab) -> OUTLINE_LABEL_ORPHAN; label di outline lampiran -> OUTLINE_LABEL_IGNORED', () => {
    const r = compose((d) => {
      d.sections.content.outline = [{ key: '1', label: '1' }, { key: '2', label: '2' }, { key: '9', label: 'X' }];
      d.sections.appendices.outline = [{ key: 'A', label: 'Z' }];
    });
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain('OUTLINE_LABEL_ORPHAN');
    expect(codes).toContain('OUTLINE_LABEL_IGNORED');
  });
});

describe('F5: lint struktur memakai label snapshot', () => {
  it('mode sumber: artefak lint = "Tabel 6.1" (tercetak), bukan "Tabel 2.1" (kunci internal)', () => {
    const r = compose((d) => {
      d.sections.content.chapters[1].title = t('Chapter 6. Temuan');
      d.sections.content.outline = [{ key: '1', label: '1' }, { key: '2', label: '6' }];
    });
    const w = walkDoc(r.snapshot as unknown as NormDocSnapshot);
    expect([...w.artifacts]).toContain('Tabel 6.1');
    expect([...w.artifacts]).not.toContain('Tabel 2.1');
  });
});

describe('F11: alamat label bagian depan', () => {
  it.each(['Tabel FM.1', 'Gambar FM.1', 'Gambar FM.1/caption', 'Turunan D-FM.2', 'Tabel FM.1/2.3', 'Tabel 6.1', 'Gambar A.1'])('%s terurai dan kembali sama', (s) => {
    const p = parseAddress(s);
    expect(p).not.toBeNull();
    expect(formatAddress(p as any)).toBe(s);
  });
  it('alamat posisi tetap memakai kunci internal (FM.1.1 bukan alamat posisi)', () => {
    expect(parseAddress('FM.1')).toBeNull();
  });
});

describe('F4/F6/F7: sumber wajah fon raster', () => {
  const svgMono = '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="8mm" viewBox="0 0 40 8"><text x="1" y="6" font-family="IBM Plex Mono" font-size="4">a</text></svg>';
  it('F4: bawaan = manifest aset S13 (sha256 terverifikasi) + F7 wajah simbol DejaVu komposit di keluarga Plex', () => {
    const f = rasterFontCss(svgMono);
    expect(f.families).toEqual(['IBM Plex Mono']);
    const rules = f.css.match(/@font-face\{[^}]*\}/g) ?? [];
    expect(rules.filter((r) => r.includes('font-family:"IBM Plex Mono"') && r.includes('unicode-range')).length).toBeGreaterThan(0);
    expect(rules.findIndex((r) => r.includes('unicode-range'))).toBeGreaterThan(rules.findIndex((r) => !r.includes('unicode-range')));
  });
  it('F4: aset fon templat dengan sha256 salah -> BY_CONSTRUCTION_FAILED', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'w4f4-'));
    const p = path.join(dir, 'IBMPlexMono-Regular.ttf');
    writeFileSync(p, 'bukan fon');
    const dejavu = path.resolve('src/lib/studio/assets/fonts/DejaVuSans.ttf');
    const tpl: any = { params: {}, assets: { 'fonts/IBMPlexMono-Regular.ttf': { kind: 'font', absPath: p, sha256: '0'.repeat(64) }, 'fonts/DejaVuSans.ttf': { kind: 'font', absPath: dejavu } } };
    expect(() => rasterFontCss(svgMono, tpl)).toThrow(/sha256 fon tidak cocok/);
  });
  it('F6: keluarga templat tanpa berkas -> FILE_MISSING_ON_DISK (keras, bukan fon sistem diam-diam)', () => {
    const tpl: any = { params: {}, assets: { 'fonts/IBMPlexSerif-Regular.ttf': { kind: 'font', absPath: path.join(tmpdir(), 'tidak-ada-w4.ttf') } } };
    expect(() => rasterFontCss(svgMono, tpl)).toThrow(/tidak ditemukan|tidak ada/);
  });
});

function chromiumAvailability(): { ok: boolean; reason: string } {
  try {
    createRequire(__filename).resolve('playwright-core');
  } catch {
    return { ok: false, reason: 'playwright-core tidak terpasang' };
  }
  resetStudioEnvCache();
  const p = getStudioEnv().chromiumPath;
  return existsSync(p) ? { ok: true, reason: '' } : { ok: false, reason: `biner Chromium tidak ada: ${p}` };
}

describe('F2/F3/F7: rasterisasi', () => {
  const avail = chromiumAvailability();
  afterAll(async () => {
    if (avail.ok) await closeBrowser();
  }, 30_000);
  const svg = (body: string, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="8mm" viewBox="0 0 40 8">${defs}<rect width="40" height="8" fill="#fff"/>${body}</svg>`;
  const R = (s: string, tpl?: any) => rasterizeSvg(s, { widthMm: 40, heightMm: 8, dpi: 300, ...(tpl ? { tpl } : {}) });
  const CASES: Array<[string, string]> = [
    ['Mono hanya di <text> kosong', svg('<text x="1" y="6" font-family="IBM Plex Sans Condensed" font-size="3">ok</text><text x="20" y="6" font-family="IBM Plex Mono" font-size="3"></text>')],
    ['Mono hanya di <text> spasi', svg('<text x="1" y="6" font-family="IBM Plex Sans Condensed" font-size="3">ok</text><text x="20" y="6" font-family="IBM Plex Mono" font-size="3">   </text>')],
    ['italic saja', svg('<text x="1" y="6" font-family="IBM Plex Sans" font-style="italic" font-size="3">miring</text>')],
    ['Plex hanya cadangan di daftar', svg('<text x="1" y="6" font-family="Arial, IBM Plex Sans" font-size="3">cadangan</text>')],
    ['aturan <style> tak terpakai', svg('<text x="1" y="6" font-family="IBM Plex Sans Condensed" font-size="3">ok</text>', '<style>.tak{font-family:IBM Plex Mono}</style>')],
  ];
  it.each(CASES)('F2: %s -> dirasterisasi (tanpa penolakan)', async (_n, s) => {
    if (!avail.ok) return;
    const png = await R(s);
    expect(png.length).toBeGreaterThan(100);
  }, 60_000);

  it('F3: wajah tertanam yang benar-benar dipakai gagal dimuat -> 422 BY_CONSTRUCTION_FAILED (bukan BROWSER_UNAVAILABLE)', async () => {
    if (!avail.ok) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'w4f3-'));
    const files: Record<string, any> = {};
    for (const f of ['IBMPlexMono-Regular.ttf', 'IBMPlexSerif-Regular.ttf', 'IBMPlexSansCond-Regular.ttf', 'IBMPlexSans-Regular.ttf', 'DejaVuSans.ttf']) {
      const p = path.join(dir, f);
      writeFileSync(p, Buffer.from('ini bukan berkas fon yang sah'.repeat(10)));
      files[`fonts/${f}`] = { kind: 'font', absPath: p, sha256: createHash('sha256').update(Buffer.from('ini bukan berkas fon yang sah'.repeat(10))).digest('hex') };
    }
    const err: any = await R(svg('<text x="1" y="6" font-family="IBM Plex Mono" font-size="3">angka 0248</text>'), { params: {}, assets: files }).catch((e) => e);
    expect(err?.code).toBe('BY_CONSTRUCTION_FAILED');
  }, 60_000);

  it('F7: "≤ ≥ →" dalam IBM Plex Mono dicetak wajah simbol (beda dari cadangan bawaan)', async () => {
    if (!avail.ok) return;
    const plex = Buffer.from(await R(svg('<text x="1" y="6" font-family="IBM Plex Mono" font-size="4">≤ ≥ →</text>')));
    const fallback = Buffer.from(await R(svg('<text x="1" y="6" font-family="NoSuchFontXyz" font-size="4">≤ ≥ →</text>')));
    expect(plex.equals(fallback)).toBe(false);
  }, 60_000);
});
