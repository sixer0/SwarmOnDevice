// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/implw4-source-numbering.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// IMPL-W4 butir 1 (D-544/D-547, UD-2): penomoran sumber. Bab berlabel di outline (`label`) dicetak PERSIS seperti
// judul sumbernya: tanpa kicker "BAB n", tanpa nomor section mesin, daftar isi dan kepala halaman tanpa "Bab n",
// label Tabel/Gambar = label sumber ("Tabel 6.1", "Tabel FM.1"). Dokumen tanpa label tetap byte-identik.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { validateOutlineV2 } from '@/lib/studio/services/revisions/v2/body';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, makeCtx, partText, unzip } from './_kit';

const t = (text: string) => ({ text });
const table = (cap: string) => ({
  type: 'table',
  caption: t(cap),
  columns: [{ role: 'text' }, { role: 'text' }],
  rows: [{ kind: 'header', cells: [t('Field'), t('Value')] }, { cells: [t('Mission'), t('NL-1')] }],
  source: { text: 'contract.md' },
});

/** e1 dengan bagian depan FM.1 (bab kunci 1) + "Chapter 6." (bab kunci 2), berlabel sumber bila `labels`. */
function sourceDoc(labels: boolean) {
  const d = e1();
  const c = d.sections.content;
  c.chapters[0].title = t('FM.1 Document control block');
  c.chapters[0].sections[0].title = t('Purpose');
  c.chapters[0].sections[0].blocks.push(table('Document control block'));
  c.chapters[1].title = t('Chapter 6. Security and Privacy Design');
  c.chapters[1].sections[0].title = t('6.1 Trust model');
  c.chapters[1].sections.push({ title: t('6.2 Threat matrix'), blocks: [table('Threat register')] });
  c.outline = labels ? [{ key: '1', label: 'FM' }, { key: '2', label: '6' }] : [{ key: '1' }, { key: '2' }];
  return d;
}

function compose(d: any): NormDocSnapshot {
  const slots = datumSlots();
  const params = { ...defaultParams(), 'render.toc.mode': 'static' };
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params }).snapshot as unknown as NormDocSnapshot;
}

async function render(snap: NormDocSnapshot) {
  const { ctx, logs } = makeCtx(snap, BENCH);
  const detail = await assembleDocxDetailed(ctx);
  const files = unzip(detail.bytes);
  const xml = partText(files, 'word/document.xml');
  const headers = Object.keys(files).filter((k) => /^word\/header\d*\.xml$/.test(k)).map((k) => partText(files, k)).join('\n');
  const html = await assembleHtml(makeCtx(snap, BENCH).ctx, { preview: false });
  return { xml, headers, html, logs, bytes: detail.bytes };
}

const paras = (xml: string) => (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((p) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, '')).join(''));

let BENCH: ResolvedTemplate;
beforeAll(async () => {
  BENCH = await benchmarkTemplate();
});

describe('IMPL-W4 penomoran sumber (outline label)', () => {
  it('kontrak: outline menerima label [A-Za-z0-9]{1,8}, menolak bentuk lain', () => {
    expect(validateOutlineV2([{ key: '1', label: 'FM' }, { key: '2', label: '10' }])).toEqual([]);
    expect(validateOutlineV2([{ key: '1', label: 'F M' }]).length).toBeGreaterThan(0);
    expect(validateOutlineV2([{ key: '1', label: '<b>' }]).length).toBeGreaterThan(0);
  });

  it('label Tabel mengikuti nomor bab sumber; bagian depan FM memakai label FM', () => {
    const snap = compose(sourceDoc(true));
    const labels = Object.values(snap.numbering ?? {});
    expect(labels).toContain('Tabel FM.1');
    expect(labels).toContain('Tabel 6.1');
    expect(labels).not.toContain('Tabel 2.1');
    expect(labels).not.toContain('Tabel 1.1');
  });

  it('DOCX: judul bab/section dicetak persis, tanpa kicker BAB n, tanpa nomor ganda; TOC dan kepala halaman tanpa Bab n', async () => {
    const { xml, headers, logs } = await render(compose(sourceDoc(true)));
    const p = paras(xml);
    expect(p).toContain('FM.1 Document control block');
    expect(p).toContain('Chapter 6. Security and Privacy Design');
    expect(p).toContain('6.1 Trust model');
    expect(p).toContain('6.2 Threat matrix');
    expect(p).toContain('Purpose');
    expect(p.filter((x) => /^(BAB|CHAPTER) \d+$/i.test(x))).toEqual([]);
    expect(p.filter((x) => /^\d+\.\d+\s+\d+\.\d+/.test(x))).toEqual([]);
    expect(p.some((x) => x.startsWith('Tabel 6.1'))).toBe(true);
    expect(p.some((x) => x.startsWith('Tabel FM.1'))).toBe(true);
    expect(p.filter((x) => /^Bab [12]$/.test(x))).toEqual([]);
    expect(headers).not.toMatch(/Bab [12]\b/);
    expect(logs.filter((l: any) => l.code === 'NUMBERING_MISMATCH')).toEqual([]);
  });

  it('HTML: tanpa kicker, tanpa nomor section mesin, label TOC kosong', async () => {
    const { html } = await render(compose(sourceDoc(true)));
    expect(html).toContain('Chapter 6. Security and Privacy Design');
    expect(html).not.toMatch(/class="[^"]*st-chapter-kicker[^"]*"[^>]*>\s*BAB/);
    expect(html).not.toMatch(/>BAB [12]</);
    expect(html).not.toMatch(/>2\.1<\/span>/);
    expect(html).not.toMatch(/>Bab [12]</);
  });

  it('tanpa label: perilaku lama (kicker BAB n, nomor section mesin, Tabel kunci.n)', async () => {
    const snap = compose(sourceDoc(false));
    expect(Object.values(snap.numbering ?? {})).toContain('Tabel 2.1');
    const { xml } = await render(snap);
    const p = paras(xml);
    expect(p).toContain('BAB 2');
    expect(p.some((x) => /^2\.1\s+6\.1 Trust model$/.test(x))).toBe(true);
  });
});
