// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c22b-html-rail-rhythm.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// C22b (tindak lanjut C22): paritas pratinjau HTML untuk opt-in engine E (delegation_progress/coder_execution_engine_e.md):
//  - C20 / GF-24, R-75 `render.rail.reserveColumn`: pada moda rel K2 (A + framePr) badan unit interior dijaga
//    selebar kolom teks 128 mm (kolom rel 32 mm kosong tanpa chip); tabel/figur tetap selebarnya, caption/SUMBER
//    ikut menyempit hanya bila artefaknya <= 128 mm; table3col dan moda B tidak berubah.
//  - C19 / GF-21, R-74 `render.rhythm.snapToBaseline`: jarak dan tinggi baris kicker/judul bab, kepala section,
//    caption/KUNCI/SUMBER dibulatkan ke kelipatan 13,5 pt (fungsi bersama DOCX); badan tidak disentuh.
// Setiap opt-in: absen = false = HTML sekarang, byte-identik. Seam: `assembleHtml`. Ekspektasi = literal register /
// laporan engine E dan review C34 #5 (mis. caption 120/48/220 tw -> 270/50/220 tw), bukan dihitung ulang dari kode produksi.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ParamMap, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { withParams } from '../engine-core/fixtures';
import { benchmarkTemplate, canonicalTemplate, loadFixtureDoc, makeCtx, sha256, snapshotOf } from './_kit';

type Lang = 'ID' | 'EN';
const RESERVE = 'render.rail.reserveColumn';
const SNAP = 'render.rhythm.snapToBaseline';

let CANON: ResolvedTemplate;
let BENCH: ResolvedTemplate;
let GSP: ResolvedTemplate;

beforeAll(async () => {
  CANON = await canonicalTemplate();
  BENCH = await benchmarkTemplate();
  // datum-gsp = profil benchmark + perender framePr (pola fixr1-rail-k2 / engine E).
  GSP = withParams(BENCH, { 'render.rail.renderer': 'framePr' });
});

function tplWith(base: ResolvedTemplate, set: Record<string, unknown> = {}, drop: string[] = []): ResolvedTemplate {
  const params: Record<string, ParamMap[string]> = { ...base.params, ...(set as ParamMap) };
  for (const k of drop) delete params[k];
  return { ...base, params };
}

function doc(lang: Lang, mutate?: (d: any) => void): StudioDocV1 {
  const d = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report'))) as any;
  d.meta.language = lang;
  mutate?.(d);
  return d as StudioDocV1;
}

async function html(lang: Lang, tpl: ResolvedTemplate, mutate?: (d: any) => void): Promise<string> {
  return assembleHtml(makeCtx(snapshotOf(doc(lang, mutate)), tpl).ctx, { preview: false });
}

const pagesCss = (h: string): string => /<style data-studio="pages">([\s\S]*?)<\/style>/.exec(h)?.[1] ?? '';
const bodyClass = (h: string): string => /<body class="([^"]*)"/.exec(h)?.[1] ?? '';

/** Aturan CSS (satu baris) di gaya halaman yang memuat `needle`. */
const ruleWith = (css: string, needle: string): string | undefined => css.split('\n').find((l) => l.includes(needle));

/** Tabel tingkat atas ber-`layout.widthTw` (7257 tw = 128 mm; 9412 tw = 166 mm) di dua tabel pertama dokumen. */
function tableWidths(d: any): void {
  const tables: any[] = [];
  const walk = (v: any): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (Array.isArray(v.rows) && Array.isArray(v.columns) && typeof v.type === 'string') tables.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(d.chapters ?? d);
  tables[0].layout = { ...(tables[0].layout ?? {}), widthTw: 7257 };
  tables[1].layout = { ...(tables[1].layout ?? {}), widthTw: 9412 };
}

// ── R-75: kolom rel dicadangkan ─────────────────────────────────────────────

describe('C22b R-75: kolom rel dicadangkan di HTML (render.rail.reserveColumn)', () => {
  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: K2 + R-75 = badan unit interior dibatasi var(--col); unit pembungkus, aside, monoBlock, isi tabel/figur dan pembuka lampiran tidak`, async () => {
      const h = await html(lang, tplWith(CANON, { [RESERVE]: true }));
      expect(bodyClass(h)).toContain('st-rail-k2');
      const rule = ruleWith(pagesCss(h), 'max-width:var(--col)');
      expect(rule).toBeDefined();
      // Hanya unit interior (WRAPPER_KINDS DOCX: cover, controlSheet, toc, part).
      expect(rule).toMatch(/\.st-unit:not\(\.st-unit-cover,\.st-unit-controlSheet,\.st-unit-toc,\.st-unit-part\)/);
      // Yang dipersempit DOCX: paragraf, daftar, asumsi, register sumber, placeholder, kicker/judul bab, kepala section.
      for (const cls of ['.st-p', '.st-list', '.st-asm', '.st-srcreg-entry', '.st-placeholder', '.st-chapter-kicker', '.st-chapter-title', '.st-section-heading']) expect(rule).toContain(cls);
      // Yang tidak: aside/monoBlock (kotak perangkat), isi tabel/figur, inang chip (grid sendiri), pembuka lampiran.
      for (const cls of ['.st-aside *', '.st-monoblock *', '.st-table *', '.st-figure *', '.st-railhost *', '.st-appendix-head *']) expect(rule).toContain(cls);
      expect(rule?.split('{')[0]).not.toMatch(/:is\([^)]*\.st-aside[,)]/);
    });
  }

  it('caption/SUMBER tabel ikut 128 mm hanya bila tabelnya <= 128 mm; tabel bentang penuh dan figur tidak berubah', async () => {
    const on = await html('ID', tplWith(CANON, { [RESERVE]: true }), tableWidths);
    const off = await html('ID', tplWith(CANON), tableWidths);
    const wrappers = [...on.matchAll(/<div class="st-table"[^>]*>/g)].map((m) => m[0]);
    expect(wrappers.filter((w) => w.includes('data-rail-reserve'))).toHaveLength(1);
    const narrow = /<div class="st-table"[^>]*data-rail-reserve[^>]*>[\s\S]*?<table class="st-table-grid" style="([^"]*)"/.exec(on)?.[1];
    // 7257 tw = 128,006 mm (pembulatan twip).
    expect(narrow).toMatch(/width:128(\.0\d+)?mm/);
    expect(ruleWith(pagesCss(on), '[data-rail-reserve]')).toMatch(/\.st-table\[data-rail-reserve\] > :is\(\.st-caption,\.st-source\)\{max-width:var\(--col\)\}/);
    // Lebar tabel dan figur sama dengan tanpa opt-in.
    const widths = (h: string) => [...h.matchAll(/<table class="st-table-grid" style="([^"]*)"/g)].map((m) => m[1]);
    const figs = (h: string) => [...h.matchAll(/<figure class="st-figure[^"]*"[^>]*style="([^"]*)"/g)].map((m) => m[1]);
    expect(widths(on)).toEqual(widths(off));
    expect(figs(on)).toEqual(figs(off));
  });

  it('absen = false byte-identik; table3col dan moda B dengan R-75 = tanpa R-75', async () => {
    const absent = await html('ID', tplWith(CANON, {}, [RESERVE]), tableWidths);
    const off = await html('ID', tplWith(CANON, { [RESERVE]: false }), tableWidths);
    expect(sha256(off)).toBe(sha256(absent));
    const t3On = await html('ID', tplWith(BENCH, { [RESERVE]: true }), tableWidths);
    const t3Off = await html('ID', tplWith(BENCH), tableWidths);
    expect(sha256(t3On)).toBe(sha256(t3Off));
    const bOn = await html('ID', tplWith(CANON, { [RESERVE]: true, 'layout.railMode': 'B' }), tableWidths);
    const bOff = await html('ID', tplWith(CANON, { 'layout.railMode': 'B' }), tableWidths);
    expect(sha256(bOn)).toBe(sha256(bOff));
  });
});

// ── R-74: irama garis dasar 13,5 pt ─────────────────────────────────────────

/** Gaya elemen pertama berkelas `cls` (tag apa pun). */
const styleOf = (h: string, cls: string): string => new RegExp(`<[a-z0-9]+ class="[^"]*\\b${cls}\\b[^"]*"[^>]*style="([^"]*)"`).exec(h)?.[1] ?? '';
/** Bagian ParaFormat gaya (margin-top/bottom, line-height) secara berurutan. */
const paraPart = (style: string): string => style.split(';').filter((d) => /^(margin-top|margin-bottom|line-height):/.test(d)).join(';');

describe('C22b R-74: irama garis dasar di HTML (render.rhythm.snapToBaseline)', () => {
  const ON = { [SNAP]: true };

  for (const lang of ['ID', 'EN'] as const) {
    // Review C34 #5 (D-650): a non-zero spacing never rounds to 0, so the kicker and section-heading after 80 tw now
    // become one baseline (270 tw = 13.5 pt) instead of 0 (laporan engine E: 180->270, 400->540, 140->270, 80->0 then).
    it(`${lang}: kicker/judul bab dan kepala section pada kelipatan 13,5 pt (180->270, 400->540, 140->270, 80->270)`, async () => {
      const h = await html(lang, tplWith(GSP, ON));
      expect(paraPart(styleOf(h, 'st-chapter-kicker'))).toBe('margin-top:0pt;margin-bottom:13.5pt;line-height:13.5pt');
      expect(paraPart(styleOf(h, 'st-chapter-title'))).toBe('margin-top:0pt;margin-bottom:13.5pt;line-height:27pt');
      expect(paraPart(styleOf(h, 'st-section-heading'))).toBe('margin-top:13.5pt;margin-bottom:13.5pt;line-height:13.5pt');
    });
  }

  // GF-21 (a) follow-up: the caption keeps its 11 pt leading (Table 8.2 "7,6 / 11 pt", ID:2635). Review C34 #5: before
  // 120 -> 270 (one baseline, no longer 0); the authored after 48 is padded to the grid (270 + 220 + 50 = 540 tw),
  // same rule as the DOCX (`snapApparatusPara`).
  it('caption 120/48/220 tw -> 270/50/220 tw; margin mm tetap caption/KUNCI/SUMBER tidak menimpa irama', async () => {
    const on = await html('ID', tplWith(GSP, ON));
    const cap = styleOf(on, 'st-caption');
    expect(paraPart(cap)).toBe('margin-top:13.5pt;margin-bottom:2.5pt;line-height:11pt');
    expect(cap).not.toContain('2.2mm');
    for (const cls of ['st-key', 'st-source']) {
      const all = [...on.matchAll(new RegExp(`<p class="${cls}" style="([^"]*)"`, 'g'))].map((m) => m[1]);
      expect(all.length, cls).toBeGreaterThan(0);
      for (const st of all) expect(st, cls).not.toMatch(/margin-top:(2\.2|1\.6)mm/);
    }
  });

  it('badan tidak disentuh: gaya paragraf badan (st-p) sama dengan tanpa opt-in', async () => {
    const ps = (h: string) => [...h.matchAll(/<p class="st-p\b[^"]*"[^>]*style="([^"]*)"/g)].map((m) => m[1]);
    const on = ps(await html('ID', tplWith(GSP, ON)));
    const off = ps(await html('ID', tplWith(GSP)));
    expect(on.length).toBeGreaterThan(0);
    expect(on).toEqual(off);
  });

  it('absen = false byte-identik (datum-gsp dan kanonik)', async () => {
    for (const base of [GSP, CANON]) {
      const absent = await html('ID', tplWith(base, {}, [SNAP]));
      const off = await html('ID', tplWith(base, { [SNAP]: false }));
      expect(sha256(off)).toBe(sha256(absent));
    }
  });
});
