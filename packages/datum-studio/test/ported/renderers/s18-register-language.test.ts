// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/s18-register-language.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S18 (DATUM Rev A, research/33 D-07): `meta.language` dokumen dikabelkan ke
// titik konstruksi Register. Dokumen yang sama dirender lewat jalur render murni
// (`renderSnapshot`): EN -> angka register "1,250,000.5" dengan IDR; ID ->
// "1.250.000,5" dengan Rp. Bahasa hanya dari data dokumen (tanpa slug/jenis).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { renderSnapshot } from '@/lib/studio/services/render/pure/render';
import { canonicalTemplate, loadFixtureDoc, snapshotOf } from './_kit';

/** Fixture SERAH dipangkas ke bab turunan (tanpa chart/diagram) + satu baris biaya register. */
function docIn(language: 'ID' | 'EN'): StudioDocV1 {
  const doc = structuredClone(loadFixtureDoc('doc_serah_handover')) as StudioDocV1 & Record<string, unknown>;
  doc.meta = { ...doc.meta, language };
  doc.register = {
    ...(doc.register ?? {}),
    biaya_pasang: { v: 1250000.5, dec: 1, unit: 'Rp', mark: 'TERUKUR', src: 'RAB pemasangan 2026' },
  };
  const ch0 = doc.chapters[0] as unknown as { sections: Array<{ blocks: Array<Record<string, unknown>> }> };
  const derivation = ch0.sections[0].blocks.find((b) => b.type === 'derivation') as { lines: unknown[] };
  derivation.lines.push({ label: { text: 'Biaya pemasangan' }, value: { registerKey: 'biaya_pasang' } });
  ch0.sections[0].blocks = [derivation as unknown as Record<string, unknown>];
  doc.chapters = [doc.chapters[0]];
  const parts = (doc as unknown as { parts?: Array<{ chapterKeys: string[] }> }).parts ?? [];
  for (const p of parts) p.chapterKeys = p.chapterKeys.filter((k) => k === '1');
  doc.appendices = [];
  return doc;
}

async function renderHtml(snap: NormDocSnapshot, tpl: ResolvedTemplate): Promise<string> {
  const r = await renderSnapshot(snap, tpl, { formats: ['HTML'], measureLayout: false, jobId: `s18-${snap.doc.meta.language}` });
  expect(r.failed, JSON.stringify(r.errors)).toEqual([]);
  const html = r.files.find((f) => f.format === 'HTML' && f.role === 'PRIMARY');
  expect(html).toBeDefined();
  return typeof html!.data === 'string' ? html!.data : Buffer.from(html!.data).toString('utf8');
}

let tpl: ResolvedTemplate;
let htmlEn: string;
let htmlId: string;

beforeAll(async () => {
  tpl = await canonicalTemplate();
  htmlEn = await renderHtml(snapshotOf(docIn('EN')), tpl);
  htmlId = await renderHtml(snapshotOf(docIn('ID')), tpl);
}, 120_000);

describe('S18: konvensi angka register mengikuti meta.language di jalur render murni', () => {
  it('dokumen EN: 1,250,000.5 dengan IDR, tanpa bentuk ID', () => {
    expect(htmlEn).toContain('IDR 1,250,000.5');
    expect(htmlEn).not.toContain('1.250.000,5');
    expect(htmlEn).not.toContain('Rp 1');
  });

  it('dokumen ID: 1.250.000,5 dengan Rp (perilaku lama), tanpa bentuk EN', () => {
    expect(htmlId).toContain('Rp 1.250.000,5');
    expect(htmlId).not.toContain('1,250,000.5');
    expect(htmlId).not.toContain('IDR 1');
  });

  it('angka register lain di turunan ikut konvensi (18,4 kW vs 18.4 kW)', () => {
    expect(htmlId).toContain('18,4 kW');
    expect(htmlEn).toContain('18.4 kW');
  });
});
