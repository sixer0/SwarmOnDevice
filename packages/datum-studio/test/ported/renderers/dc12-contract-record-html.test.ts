// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/dc12-contract-record-html.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- isi blok internal dibaca bebas-bentuk di uji */
// DC-12: perakit HTML merender blok `contractRecord` (tabel fakta, butir, bukti, rujukan)
// bergaya DATUM dari templat (register 05 §3 D-139, §5.7, §6.3, BA-12). Asap: HTML laporan
// kerja contoh §5.8 lolos `enforceStandalone` dengan 0 pelanggaran dan memuat semua cardId.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormBlock, NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { HTML_RENDERERS } from '@/lib/studio/contract/dispatch';
import { assembleHtml, enforceStandalone, HtmlAssembleError } from '@/lib/studio/engine/html/assemble';
import { getContractKindDef } from '@/lib/studio/registry/contracts';
import { withParams } from '../engine-core/fixtures';
import { CONTRACT_EXPECTED, contractReportSnapshot } from './dc12-contract-fixture';
import { benchmarkTemplate, canonicalTemplate, makeCtx } from './_kit';

const DEF = getContractKindDef('agentWorkReport')!;

let CANON: ResolvedTemplate;
let GSP: ResolvedTemplate;
beforeAll(async () => {
  CANON = await canonicalTemplate();
  // Preset GSP DATUM (register 05 §6.3 `datum-gsp-preset`) = profil benchmark + perender rel framePr (D-327).
  GSP = withParams(await benchmarkTemplate(), { 'render.rail.renderer': 'framePr' });
}, 60_000);

const count = (s: string, sub: string) => s.split(sub).length - 1;

function recordBlock(snap: NormDocSnapshot): NormBlock {
  return snap.blocks.find((b) => b.type === 'contractRecord')!;
}

async function render(snap: NormDocSnapshot, tpl: ResolvedTemplate, preview = false) {
  const { ctx, logs } = makeCtx(snap, tpl);
  const html = await assembleHtml(ctx, { preview });
  return { html, logs };
}

describe.each([
  ['kanonik', () => CANON],
  ['GSP DATUM', () => GSP],
] as const)('asap §5.8 HTML templat %s', (_name, tplOf) => {
  let html: string;
  let logs: Array<{ level: string; message: string }>;
  const snap = contractReportSnapshot();
  const rec = recordBlock(snap);

  beforeAll(async () => {
    ({ html, logs } = await render(snap, tplOf()));
  }, 60_000);

  it('dirakit tanpa log error; enforceStandalone 0 pelanggaran (dan idempoten)', () => {
    expect(logs.filter((l) => l.level === 'error')).toEqual([]);
    const { html: again, violations } = enforceStandalone(html);
    expect(violations).toEqual([]);
    expect(again).toBe(html);
  });

  it('memuat semua cardId, kunci butir, dan rujukan bukti', () => {
    for (const id of CONTRACT_EXPECTED.cardIds) expect(html).toContain(id);
    for (const k of CONTRACT_EXPECTED.itemKeys) expect(html).toContain(k);
    for (const r of CONTRACT_EXPECTED.evidenceRefs) expect(html).toContain(r);
  });

  it('label medan dan kepala kolom = registri C58 (dari blok); status/waktu terproyeksi', () => {
    for (const label of [DEF.labels.fields.status, DEF.labels.fields.owner, DEF.labels.fields.reportedAt, DEF.labels.fields.cardIds]) expect(html).toContain(`>${label}<`);
    expect(html).toContain('>Selesai<');
    expect(html).toContain('2026-10-30 12:30 UTC');
    for (const h of ['Kunci', 'Judul', 'Jenis', 'Rujukan', 'Hubungan']) expect(html).toContain(`>${h}<`);
  });

  it('satu wadah contractRecord beralamat F:record; empat bagian berurutan; tabel bergaya DATUM', () => {
    expect(count(html, 'data-address="F:record"')).toBe(1);
    expect(html).toContain(`data-block-id="${rec.blockId}"`);
    expect(html).toContain('data-contract-kind="agentWorkReport"');
    const parts = [...html.matchAll(/data-part="(\w+)"/g)].map((m) => m[1]);
    expect(parts).toEqual(['facts', 'items', 'evidence', 'refs']);
    // Perender tabel DATUM: grid tanpa garis tegak, kepala berulang (thead) untuk tabel berkepala.
    expect(count(html.slice(html.indexOf('st-contract-record')), 'class="st-table-grid"')).toBeGreaterThanOrEqual(4);
    expect(count(html.slice(html.indexOf('st-contract-record')), 'display:table-header-group')).toBeGreaterThanOrEqual(3);
  });

  it('butir F:record/<n> beralamat tepat sekali pada baris tabel butir, id = pid butir (§5.7)', () => {
    const items = snap.blocks.filter((b) => b.type === 'contractItem');
    expect(items.map((b) => b.address)).toEqual(['F:record/1', 'F:record/2']);
    const pids = (rec.content as any).itemPids as string[];
    expect(pids).toEqual(items.map((b) => (b as NormBlock & { pid?: string }).pid));
    items.forEach((b, i) => {
      expect(count(html, `data-address="${b.address}"`)).toBe(1);
      expect(html).toMatch(new RegExp(`<tr class="st-row st-row-body"[^>]*data-address="${b.address}" id="${pids[i]}" data-pid="${pids[i]}"`));
    });
    expect(html).not.toContain('data-block-type="contractItem"');
  });
});

describe('label datang dari blok, bukan hardcode', () => {
  it('label fakta dan kepala kolom diganti di blok -> HTML mengikuti', () => {
    const snap = contractReportSnapshot();
    const rec = recordBlock(snap);
    const c = structuredClone(rec.content) as any;
    c.facts.rows[0].cells[0] = { text: 'LABEL-UJI-FAKTA' };
    c.items.rows[0].cells[1] = { text: 'KEPALA-UJI-JUDUL' };
    const { ctx } = makeCtx(snap, CANON);
    const out = HTML_RENDERERS.contractRecord!({ ...rec, content: c }, ctx);
    expect(out).toContain('>LABEL-UJI-FAKTA<');
    expect(out).toContain('>KEPALA-UJI-JUDUL<');
    // "Status" tinggal sekali: kepala kolom tabel butir (label fakta sudah diganti).
    expect(count(out, `>${DEF.labels.fields.status}<`)).toBe(1);
  });
});

describe('isi blok rusak', () => {
  const broken = (): NormDocSnapshot => {
    const snap = contractReportSnapshot();
    const rec = recordBlock(snap);
    rec.content = { type: 'contractRecord', facts: 'bukan tabel' };
    return snap;
  };

  it('artefak: HTML_RENDER_FAILED dengan causeCode BY_CONSTRUCTION_FAILED, dicatat error', async () => {
    const { ctx, logs } = makeCtx(broken(), CANON);
    const err = await assembleHtml(ctx, { preview: false }).catch((e) => e);
    expect(err).toBeInstanceOf(HtmlAssembleError);
    expect(err.code).toBe('HTML_RENDER_FAILED');
    expect(err.causeCode).toBe('BY_CONSTRUCTION_FAILED');
    expect(logs.some((l) => l.level === 'error' && /facts bukan TableBlock/.test(l.message))).toBe(true);
  });

  it('pratinjau: blok pengganti beralamat F:record, render berlanjut', async () => {
    const { html } = await render(broken(), CANON, true);
    expect(html).toMatch(/class="st-missing" data-block-type="contractRecord" data-address="F:record"/);
  });
});
