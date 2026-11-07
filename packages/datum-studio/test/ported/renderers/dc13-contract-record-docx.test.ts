// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/dc13-contract-record-docx.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- isi blok internal dibaca bebas-bentuk di uji */
// DC-13: perakit DOCX merender blok `contractRecord` lewat keluarga tabel DATUM tanpa
// mengubah jalur dokumen lain (register 05 §3 D-139, §5.7, §6.3, BA-13). Asap: DOCX
// laporan kerja contoh §5.8 terbangun, paket valid, deterministik; paritas teks sel
// HTML = DOCX untuk blok yang sama (DC-12).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormBlock, NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { DOCX_RENDERERS, HTML_RENDERERS } from '@/lib/studio/contract/dispatch';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { getContractKindDef } from '@/lib/studio/registry/contracts';
import { withParams } from '../engine-core/fixtures';
import { CONTRACT_EXPECTED, contractReportSnapshot } from './dc12-contract-fixture';
import { benchmarkTemplate, canonicalTemplate, findAll, makeCtx, normWs, parseFragment, parseXml, partText, sha256, unzip, wText } from './_kit';

const DEF = getContractKindDef('agentWorkReport')!;

let CANON: ResolvedTemplate;
let GSP: ResolvedTemplate;
beforeAll(async () => {
  CANON = await canonicalTemplate();
  GSP = withParams(await benchmarkTemplate(), { 'render.rail.renderer': 'framePr' });
}, 60_000);

function recordBlock(snap: NormDocSnapshot): NormBlock {
  return snap.blocks.find((b) => b.type === 'contractRecord')!;
}

async function build(tpl: ResolvedTemplate) {
  const snap = contractReportSnapshot();
  const { ctx, logs } = makeCtx(snap, tpl);
  const detail = await assembleDocxDetailed(ctx);
  return { snap, detail, logs, parts: unzip(detail.bytes) };
}

/** Teks sel HTML berurutan (td/th), entitas didekode, spasi dinormalkan. */
function htmlCells(html: string): string[] {
  const decode = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&#160;|&nbsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  return [...html.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => normWs(decode(m[1])));
}

function docxCells(xml: string): string[] {
  const { root, errors } = parseFragment(xml);
  expect(errors).toEqual([]);
  return findAll(root, 'w:tc').map((tc) => normWs(wText(tc).replace(/ /g, ' ')));
}

describe.each([
  ['kanonik', () => CANON],
  ['GSP DATUM', () => GSP],
] as const)('asap §5.8 DOCX templat %s', (_name, tplOf) => {
  let r: Awaited<ReturnType<typeof build>>;
  beforeAll(async () => {
    r = await build(tplOf());
  }, 60_000);

  it('terbangun tanpa log error; setiap bagian XML well-formed; satu seksi per unit', () => {
    expect(r.logs.filter((l) => l.level === 'error')).toEqual([]);
    const xmlParts = Object.keys(r.parts).filter((p) => p.endsWith('.xml') || p.endsWith('.rels'));
    expect(xmlParts).toContain('word/document.xml');
    for (const p of xmlParts) expect(parseXml(partText(r.parts, p)).errors, p).toEqual([]);
    expect(r.detail.units.map((u) => u.key)).toEqual(['F:record', '1']);
    expect(findAll(parseXml(r.detail.documentXml).root, 'w:sectPr')).toHaveLength(2);
  });

  it('memuat semua cardId, kunci butir, rujukan bukti, label registri', () => {
    const text = wText(parseXml(r.detail.documentXml).root);
    for (const id of CONTRACT_EXPECTED.cardIds) expect(text).toContain(id);
    for (const k of CONTRACT_EXPECTED.itemKeys) expect(text).toContain(k);
    for (const ref of CONTRACT_EXPECTED.evidenceRefs) expect(text).toContain(ref);
    for (const label of Object.values(DEF.labels.fields).filter((l) => l !== DEF.labels.fields.verdict && l !== DEF.labels.fields.due)) expect(text).toContain(label);
    expect(text).toContain('2026-10-30 12:30 UTC');
  });

  it('empat tabel DATUM (kepala tblHeader, baris cantSplit) dipisah paragraf; tidak ada w:tbl bersebelahan', () => {
    const rec = recordBlock(r.snap);
    const { ctx } = makeCtx(r.snap, tplOf());
    const xml = DOCX_RENDERERS.contractRecord!(rec, ctx).xml;
    const { root, errors } = parseFragment(xml);
    expect(errors).toEqual([]);
    const tbls = root!.children.filter((c) => c.name === 'w:tbl');
    expect(tbls).toHaveLength(4);
    expect(xml).not.toMatch(/<\/w:tbl>\s*<w:tbl[ >]/);
    expect(findAll(root, 'w:tblHeader').length).toBeGreaterThanOrEqual(3);
    for (const tr of findAll(root, 'w:tr')) expect(findAll(tr, 'w:cantSplit').length, 'cantSplit').toBe(1);
    expect(findAll(root, 'w:sectPr')).toHaveLength(0);
    // Paket memuat fragmen yang sama (blok contractItem tidak menambah XML).
    expect(r.detail.documentXml).toContain(xml.slice(0, 200));
  });

  it('paritas teks HTML = DOCX untuk blok yang sama (sel berurutan)', () => {
    const rec = recordBlock(r.snap);
    const { ctx } = makeCtx(r.snap, tplOf());
    const h = htmlCells(HTML_RENDERERS.contractRecord!(rec, ctx));
    const d = docxCells(DOCX_RENDERERS.contractRecord!(rec, ctx).xml);
    expect(h.length).toBeGreaterThan(20);
    expect(d).toEqual(h);
  });

  it('deterministik: dua render berurutan = sha256 sama', async () => {
    const again = await build(tplOf());
    expect(sha256(again.detail.bytes)).toBe(sha256(r.detail.bytes));
  }, 60_000);
});

describe('isi blok rusak', () => {
  it('BY_CONSTRUCTION_FAILED dicatat error, perakitan berhenti', async () => {
    const snap = contractReportSnapshot();
    recordBlock(snap).content = { type: 'contractRecord', facts: { rows: 'x' } };
    const { ctx, logs } = makeCtx(snap, CANON);
    const err: any = await assembleDocxDetailed(ctx).catch((e) => e);
    expect(err?.code).toBe('BY_CONSTRUCTION_FAILED');
    expect(logs.some((l) => l.level === 'error' && /facts bukan TableBlock/.test(l.message))).toBe(true);
  });
});
