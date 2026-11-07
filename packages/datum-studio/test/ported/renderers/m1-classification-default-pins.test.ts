// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/m1-classification-default-pins.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- snapshot/fixture dibaca bebas-bentuk di uji */
// M1 (D-610; review `verification/24_datum_rev_a_code_review.md` M1, D-607): perilaku yang DITERIMA untuk jalur yang
// tidak dicakup baseline S05 (keempat masukannya kapital "TERBATAS", tanpa pasangan Klasifikasi sampul). Dua kasus
// disematkan di sini, bukan di folder baseline:
//   1. Dokumen ID TANPA `classification`: meta mengambil bawaan registri `classification.level` = "Terbatas" (huruf
//      campur, `params/apparatus.ts` P6-02; `compose/merge.ts` `defaultMeta`). Pembungkus DOCX dan HTML mencetak
//      kapital "TERBATAS" di kepala halaman, blok register, dan pita segel; cap terbit memakai huruf awal kapital
//      `{KELAS}` = "T" (format registri `device.issueStamp.format`, semantik sejak sebelum Rev A). Metadata (DOCX
//      `docProps/core.xml`, HTML `<meta studio:classification>`) tetap nilai tersimpan "Terbatas".
//   2. Blok kendali sampul dari klien MCP (`buildClient`, pasangan "Klasifikasi" bernilai huruf campur) dicetak kapital
//      di snapshot dan di keluaran DOCX/HTML.
// Seam: compose v2 + jalur render murni DOCX/HTML (sama dengan gfix1-classification-caps), dan builder klien MCP.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { buildClient } from '../../../vendor/scripts/studio/mcp/write-client';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, makeCtx, unzip } from './_kit';

function compose(d: Record<string, any>): NormDocSnapshot {
  const slots = datumSlots();
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() }).snapshot as unknown as NormDocSnapshot;
}

/** Teks run (`w:t`) per bagian DOCX yang namanya cocok. */
function runsOf(parts: Record<string, Uint8Array>, re: RegExp): string[] {
  return Object.keys(parts)
    .filter((p) => re.test(p))
    .sort()
    .map((p) => (Buffer.from(parts[p]).toString('utf8').match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, '')).join('|'));
}

const visibleHtml = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<meta[^>]*>/g, ' ');

interface Out {
  meta: any;
  coverRows: any[][];
  headers: string[];
  footers: string[];
  body: string;
  core: string;
  html: string;
}

async function render(d: Record<string, any>, tpl: ResolvedTemplate): Promise<Out> {
  const snap = compose(d);
  const parts = unzip((await assembleDocxDetailed(makeCtx(snap, tpl).ctx)).bytes);
  return {
    meta: (snap as any).doc.meta,
    coverRows: (snap as any).doc.front.cover?.data?.control?.rows ?? [],
    headers: runsOf(parts, /^word\/header\d+\.xml$/),
    footers: runsOf(parts, /^word\/footer\d+\.xml$/),
    body: runsOf(parts, /^word\/document\.xml$/).join('\n'),
    core: Buffer.from(parts['docProps/core.xml']).toString('utf8'),
    html: await assembleHtml(makeCtx(snap, tpl).ctx, { preview: false }),
  };
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('M1 (1): dokumen ID tanpa klasifikasi, bawaan registri "Terbatas"', () => {
  let o: Out;
  beforeAll(async () => {
    const d = e1();
    expect(d.meta).not.toHaveProperty('classification');
    o = await render(d, await canonicalTemplate());
  }, 180_000);

  it('meta tersimpan = bawaan registri huruf campur (nilai tidak diubah)', () => {
    expect(o.meta.classification).toBe('Terbatas');
    expect(o.meta.language).toBe('ID');
  });

  it('DOCX: kepala halaman dan blok register mencetak "TERBATAS" di setiap bagian yang memuatnya', () => {
    const withMark = o.headers.filter((h) => h.includes('TERBATAS'));
    expect(withMark.length).toBeGreaterThanOrEqual(4);
    expect(o.footers.filter((f) => f.includes('TERBATAS')).length).toBeGreaterThanOrEqual(4);
    expect([...o.headers, ...o.footers].join('\n')).not.toMatch(/Terbatas/);
  });

  it('DOCX: pita segel "KLASIFIKASI · TERBATAS" dan cap terbit huruf awal kapital', () => {
    expect(count(o.body, 'KLASIFIKASI · TERBATAS')).toBeGreaterThanOrEqual(1);
    // row42 ADAPT A3 (C40, row 122 CP-14; front/texts.ts:55-61,544-545): the default stamp prints U+2014; the registry default keeps '--'.
    expect(o.body).toContain('// 20261023 ID T — TERBITAN 1');
    expect(o.body).not.toMatch(/Terbatas/);
  });

  it('DOCX: metadata core.xml tetap nilai tersimpan', () => {
    expect(o.core).toContain('· Terbatas');
  });

  it('HTML: kepala halaman, register, pita segel, dan @page kapital; cap terbit huruf awal kapital', () => {
    const h = o.html;
    expect(count(h, '<span class="cls">TERBATAS</span>')).toBeGreaterThanOrEqual(4);
    // row49a ADAPT (C104 H1, Rev A DT-28d; engine/html/base/markup.ts registerHtml): {kelas} is now its own bold
    // class-ink element `<b class="cls">` (seal), so a bold {kelas} no longer takes `.reg b` ink900. Text unchanged.
    expect(h).toMatch(/<div class="reg st-screen">(?:(?!<\/div><\/div>).)*<div><b class="cls">TERBATAS<\/b><\/div><\/div>/);
    // row42 ADAPT A5 (C40, row 123 CP-07; engine/html/blocks/device.ts): the ID seal band now prints the DOCX/EN pair
    // `KLASIFIKASI · <level>` (sealBandTextsOf), no longer the bare level.
    expect(count(h, '<span class="st-seal-left">KLASIFIKASI · TERBATAS</span>')).toBeGreaterThanOrEqual(1);
    expect(h).toContain('@top-right{content:"TERBATAS"');
    expect(h).toContain('@bottom-right{content:"TERBATAS"');
    // row42 ADAPT A3 (C40, row 122 CP-14; front/texts.ts:55-61,544-545): the default stamp prints U+2014; the registry default keeps '--'.
    expect(h).toMatch(/data-role="cover\.colophonRight">\/\/ 20261023 ID T — TERBITAN 1/);
    expect(visibleHtml(h)).not.toMatch(/Terbatas/);
  });

  it('HTML: metadata <meta studio:classification> tetap nilai tersimpan', () => {
    expect(o.html).toContain('<meta name="studio:classification" content="Terbatas">');
  });
});

describe('M1 (2): blok kendali sampul klien MCP dengan pasangan "Klasifikasi" huruf campur', () => {
  let o: Out;
  let mcpCover: any;
  beforeAll(async () => {
    const built = buildClient({
      meta: { title: 'Kajian Kesiapan GI Cikupa', number: 'GSP-UD1-NL-001', author: 'Tim Kajian GSP', checker: 'B. Santoso', rev: 'A', date: '2026-10-23', classification: 'Terbatas' },
      title: null,
      sections: [{ heading: 'Pendahuluan', blocks: ['Kajian ini disusun untuk manajer aset.'] }],
      today: '2026-10-23',
    });
    mcpCover = built.slots.cover;
    const d = e1();
    d.meta = { ...d.meta, ...built.docMeta };
    d.sections.cover = mcpCover;
    o = await render(d, await canonicalTemplate());
  }, 180_000);

  it('muatan klien membawa nilai huruf campur di sebelah label "Klasifikasi" (masukan tidak diubah klien)', () => {
    const pair = (mcpCover.control as any[][]).flatMap((r) => [[r[0], r[1]], [r[2], r[3]]]).find(([l]) => l?.text === 'Klasifikasi');
    expect(pair?.[1]).toEqual({ text: 'Terbatas' });
  });

  it('snapshot: sel nilai pasangan Klasifikasi dicetak kapital', () => {
    const cells = o.coverRows.flatMap((r) => [[r[0], r[1]], [r[2], r[3]]]);
    const pair = cells.find(([l]) => l?.text === 'Klasifikasi');
    expect(pair?.[1]).toEqual({ text: 'TERBATAS' });
  });

  it('DOCX dan HTML: blok kendali sampul memuat "Klasifikasi" lalu "TERBATAS"; tanpa "Terbatas" tampak', () => {
    expect(o.body).toMatch(/Klasifikasi\|TERBATAS/);
    expect(o.body).not.toMatch(/Terbatas/);
    expect(o.html).toMatch(/Klasifikasi<\/[a-z]+>(?:<[^>]+>)*TERBATAS/);
    expect(visibleHtml(o.html)).not.toMatch(/Terbatas/);
  });
});
