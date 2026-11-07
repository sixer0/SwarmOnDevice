// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/s12-client-labels.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S12 (DATUM Rev A; D-597 D-6, D-598 F-1): label klien MCP EN mengikuti register research/31 §4.3 (Prepared by /
// Reviewed by / Approved by), bahasa label = meta.language agen bila dikirim, selain itu bahasa dokumen dari templat
// (R02 `doc.language`) atau dokumen yang ada (R20 `meta.language`), meta.tier diteruskan ke server dan pemilih slot
// depan D-1, label EN lama tetap terbaca di studio_edit, dan judul bab cadangan mengikuti bahasa.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent dan muatan slot bebas bentuk */
import { describe, it, expect } from '../_vitest';
import { connect, reply, type Call } from './mcp-harness';
import { clientServer, DOCID, env, META, SECTIONS } from './implw3-client-mock';
import { buildClient } from '../../../vendor/scripts/studio/mcp/write-client';
import { applyClientMeta, serverClientMeta } from '../../../vendor/scripts/studio/mcp/write-meta';

const FRONT_TIERS = ['TERBIT', 'SERAH'];
const SKELETON = [
  { slotKey: 'cover', sectionType: 'cover', tiers: FRONT_TIERS },
  { slotKey: 'controlSheet', sectionType: 'controlSheet', tiers: FRONT_TIERS },
  { slotKey: 'signature', sectionType: 'signatureBlock', tiers: FRONT_TIERS },
  { slotKey: 'toc', sectionType: 'toc', tiers: FRONT_TIERS },
  { slotKey: 'content', sectionType: 'chapter', tiers: [] },
  { slotKey: 'references', sectionType: 'sourceRegister', tiers: [] },
  { slotKey: 'appendices', sectionType: 'appendix', tiers: [] },
];

/** Parameter terresolusi per templat tiruan (R02 `version.resolvedParams`); `uji-en` = templat ber-`doc.language` EN. */
const PARAMS: Record<string, Record<string, string>> = {
  'uji-en': { 'doc.language': 'EN', 'doc.defaultTier': 'TERBIT' },
  'datum-gsp': { 'doc.language': 'ID', 'doc.defaultTier': 'TERBIT' },
};

/** Server dokumen klien bersama (implw3) dengan R02 per slug templat tiruan. */
function server(o: { exists?: boolean } = {}) {
  const m = clientServer(o);
  const f = async (url: string, init: any) => {
    const p = new URL(url).pathname;
    if (init.method === 'GET' && p.startsWith('/api/studio/templates/')) {
      const slug = decodeURIComponent(p.split('/').pop() ?? '');
      m.calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect, body: undefined });
      const params = PARAMS[slug];
      if (params === undefined) return reply({ status: 404, body: { error: 'templat tidak ada', code: 'TEMPLATE_NOT_FOUND' } });
      return reply({ status: 200, body: { template: { slug }, version: { versionNo: 1, resolvedParams: params }, definition: { skeleton: { slots: SKELETON } } } });
    }
    return m.f(url, init);
  };
  return { ...m, f };
}

const posted = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && new URL(c.url).pathname === path).map((c) => c.body);
const slotPayload = (calls: Call[], slot: string) => posted(calls, '/api/studio/slots').find((b) => b.slot === slot)?.payload;
const coverLabels = (cover: any) => (cover.control as any[][]).flatMap((r) => [r[0].text, r[2].text]).filter((t: string) => t !== '');
const META_FULL = { ...META, approver: 'C. Wibowo' };
const ARGS = { mission: '2026-11-04_s12', docKey: 'klien-s12', meta: META_FULL, sections: SECTIONS };

describe('S12 F-1: bahasa label klien dari templat bila meta.language absen', () => {
  it('(a) templat ber-doc.language EN + meta tanpa language -> label EN register; R04 tanpa medan language baru', async () => {
    const m = server();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { ...ARGS, template: 'uji-en', sections: [...SECTIONS, { heading: ' ', blocks: ['Bagian tanpa judul.'] }] });
    expect(r.isError).toBeFalsy();
    const r04 = posted(m.calls, '/api/studio/documents')[0];
    expect(r04.template).toEqual({ slug: 'uji-en' });
    expect(r04.meta).not.toHaveProperty('language');
    expect(coverLabels(slotPayload(m.calls, 'cover'))).toEqual(['Document number', 'Revision', 'Prepared by', 'Classification']);
    const cs = slotPayload(m.calls, 'controlSheet');
    expect(cs.title).toEqual({ text: 'Control Sheet GSP-UD1-NL-001' });
    expect(cs.revisionHistory[0].what).toBe('First issue');
    expect(cs.verificationChain.map((v: any) => v.role)).toEqual(['Prepared by', 'Reviewed by', 'Approved by']);
    expect(slotPayload(m.calls, 'signature').roles.map((x: any) => x.role.text)).toEqual(['Prepared by', 'Reviewed by', 'Approved by']);
    // Judul bab cadangan (judul kosong) mengikuti bahasa dokumen.
    expect(posted(m.calls, '/api/studio/chapters').map((b) => b.chapter.title.text)).toContain('Chapter 4');
  });

  it('(b) meta.language ID pada templat EN -> label ID (meta eksplisit menang), byte-sama dengan label ID lama', async () => {
    const m = server();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { ...ARGS, template: 'uji-en', meta: { ...META_FULL, language: 'ID' }, sections: [...SECTIONS, { heading: ' ', blocks: ['Bagian tanpa judul.'] }] });
    expect(r.isError).toBeFalsy();
    expect(posted(m.calls, '/api/studio/documents')[0].meta.language).toBe('ID');
    expect(coverLabels(slotPayload(m.calls, 'cover'))).toEqual(['Nomor dokumen', 'Revisi', 'Penyusun', 'Klasifikasi']);
    const cs = slotPayload(m.calls, 'controlSheet');
    expect(cs.title).toEqual({ text: 'Lembar Kendali GSP-UD1-NL-001' });
    expect(cs.revisionHistory[0].what).toBe('Terbit pertama');
    expect(cs.verificationChain.map((v: any) => v.role)).toEqual(['Penyusun', 'Diperiksa', 'Disetujui']);
    expect(slotPayload(m.calls, 'signature').roles.map((x: any) => x.role.text)).toEqual(['Disusun', 'Diperiksa', 'Disetujui']);
    expect(posted(m.calls, '/api/studio/chapters').map((b) => b.chapter.title.text)).toContain('Bab 4');
  });

  it('templat ID (datum-gsp) tanpa meta.language -> label ID tetap', async () => {
    const m = server();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { ...ARGS, template: 'datum-gsp' });
    expect(r.isError).toBeFalsy();
    expect(coverLabels(slotPayload(m.calls, 'cover'))).toEqual(['Nomor dokumen', 'Revisi', 'Penyusun', 'Klasifikasi']);
    expect(slotPayload(m.calls, 'signature').roles.map((x: any) => x.role.text)).toEqual(['Disusun', 'Diperiksa', 'Disetujui']);
  });

  it('tulis ulang dokumen yang ada: bahasa dokumen di server (R20 meta.language EN) dipakai bila meta.language absen', async () => {
    const m = server({ exists: true });
    m.content().meta.language = 'EN';
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { ...ARGS, template: 'datum-gsp' });
    expect(r.isError).toBeFalsy();
    expect(slotPayload(m.calls, 'signature').roles.map((x: any) => x.role.text)).toEqual(['Prepared by', 'Reviewed by', 'Approved by']);
    expect(slotPayload(m.calls, 'controlSheet').title).toEqual({ text: 'Control Sheet GSP-UD1-NL-001' });
  });

  it('builder murni: tanpa bahasa templat label tetap ID (perilaku lama); bahasa templat EN menghasilkan label EN', () => {
    const id = buildClient({ meta: META_FULL, title: null, sections: SECTIONS, today: '2026-11-04' });
    expect(id.slots.signature.roles).toEqual(expect.arrayContaining([expect.objectContaining({ role: { text: 'Disusun' } })]));
    const en = buildClient({ meta: META_FULL, title: null, sections: SECTIONS, today: '2026-11-04', language: 'EN' });
    expect((en.slots.signature as any).roles.map((x: any) => x.role.text)).toEqual(['Prepared by', 'Reviewed by', 'Approved by']);
    expect(en.docMeta).not.toHaveProperty('language');
    const explicit = buildClient({ meta: { ...META_FULL, language: 'ID' }, title: null, sections: SECTIONS, today: '2026-11-04', language: 'EN' });
    expect((explicit.slots.signature as any).roles.map((x: any) => x.role.text)).toEqual(['Disusun', 'Diperiksa', 'Disetujui']);
  });
});

describe('S12 meta.tier diteruskan', () => {
  it('(c) meta.tier NOTA pada dokumen baru -> R04 meta.tier NOTA, slot depan tidak dikirim (D-1)', async () => {
    const m = server();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_write', { ...ARGS, template: 'datum-gsp', meta: { ...META_FULL, tier: 'nota' } });
    expect(r.isError).toBeFalsy();
    expect(posted(m.calls, '/api/studio/documents')[0].meta.tier).toBe('NOTA');
    expect(posted(m.calls, '/api/studio/slots').map((b) => b.slot)).toEqual([]);
    expect(posted(m.calls, '/api/studio/validate').filter((b) => typeof b.slot === 'string')).toEqual([]);
    expect((r.structuredContent.warnings ?? []).map((w: any) => w.code)).toContain('FRONT_SLOTS_OMITTED');
    expect((r.structuredContent.warnings ?? []).map((w: any) => w.code)).not.toContain('META_IGNORED');
  });

  it('studio_edit meta.tier tidak diterapkan (slot depan bergantung tier): META_IGNORED, meta dan slot tetap', () => {
    const c: any = { meta: { title: 'T', author: 'A', tier: 'TERBIT' }, sections: { cover: { type: 'cover' } } };
    const w: any[] = [];
    const { touched } = applyClientMeta(c, { tier: 'NOTA' }, '2026-11-04', (x) => w.push(x));
    expect(c.meta.tier).toBe('TERBIT');
    expect(touched).toEqual([]);
    expect(w.map((x) => x.code)).toContain('META_IGNORED');
  });

  it('tier tak dikenal -> peringatan TIER_IGNORED, tidak dikirim (tier bawaan templat)', () => {
    const b = buildClient({ meta: { ...META_FULL, tier: 'RAHASIA' }, title: null, sections: SECTIONS, today: '2026-11-04' });
    expect(b.docMeta).not.toHaveProperty('tier');
    expect(b.warnings.map((w) => w.code)).toContain('TIER_IGNORED');
  });
});

describe('S12 D-6: label EN lama tetap terbaca', () => {
  const legacy = () => ({
    meta: { title: 'Old Study', author: 'GSP Study Team', language: 'EN', rev: 'A', issueDate: '2026-11-03' },
    sections: {
      cover: { type: 'cover', control: [[{ text: 'Document number' }, { text: 'GSP-EN-001' }, { text: 'Revision' }, { text: 'A · 2026-11-03' }], [{ text: 'Author' }, { text: 'GSP Study Team' }, { text: '' }, { text: '' }]] },
      controlSheet: {
        type: 'controlSheet',
        title: { text: 'Control Sheet GSP-EN-001' },
        revisionHistory: [{ rev: 'A', date: '2026-11-03', what: 'First issue', by: 'GSP Study Team' }],
        verificationChain: [{ layer: '1', role: 'Author', name: 'GSP Study Team' }, { layer: '2', role: 'Checked', name: 'B. Santoso' }, { layer: '3', role: 'Approved', name: 'C. Wibowo' }],
      },
      signature: { type: 'signatureBlock', roles: [{ role: { text: 'Prepared' }, holder: { text: 'GSP Study Team' }, date: { text: '2026-11-03' } }, { role: { text: 'Checked' }, holder: { text: 'B. Santoso' } }, { role: { text: 'Approved' }, holder: { text: 'C. Wibowo' } }] },
    },
  });

  it('(d) serverClientMeta membaca penyusun/pemeriksa/penyetuju dari label EN lama (Author, Checked, Approved)', () => {
    const out = serverClientMeta(legacy());
    expect(out).toMatchObject({ number: 'GSP-EN-001', author: 'GSP Study Team', checker: 'B. Santoso', approver: 'C. Wibowo', rev: 'A', date: '2026-11-03' });
  });

  it('(d) applyClientMeta menambal entri berlabel lama di tempat (tanpa entri ganda, label lama tidak diubah)', () => {
    const c: any = legacy();
    const { touched } = applyClientMeta(c, { author: 'New Team', checker: 'D. Putra', approver: 'E. Sari' }, '2026-11-04', () => undefined);
    expect(c.sections.cover.control[1].slice(0, 2)).toEqual([{ text: 'Author' }, { text: 'New Team' }]);
    expect(c.sections.controlSheet.verificationChain).toEqual([{ layer: '1', role: 'Author', name: 'New Team' }, { layer: '2', role: 'Checked', name: 'D. Putra' }, { layer: '3', role: 'Approved', name: 'E. Sari' }]);
    expect(c.sections.signature.roles.map((r: any) => [r.role.text, r.holder.text])).toEqual([['Prepared', 'New Team'], ['Checked', 'D. Putra'], ['Approved', 'E. Sari']]);
    expect(touched.map((t: any) => t.slot ?? t.kind)).toEqual(['meta', 'cover', 'controlSheet', 'signature']);
  });

  it('entri baru di dokumen EN memakai label register (Reviewed by)', () => {
    const c: any = legacy();
    c.sections.controlSheet.verificationChain = [{ layer: '1', role: 'Author', name: 'GSP Study Team' }];
    c.sections.signature.roles = [{ role: { text: 'Prepared' }, holder: { text: 'GSP Study Team' } }];
    applyClientMeta(c, { checker: 'D. Putra' }, '2026-11-04', () => undefined);
    expect(c.sections.controlSheet.verificationChain[1]).toEqual({ layer: '2', role: 'Reviewed by', name: 'D. Putra' });
    expect(c.sections.signature.roles[1]).toEqual({ role: { text: 'Reviewed by' }, holder: { text: 'D. Putra' } });
  });

  it('studio_edit meta pada dokumen EN lama lewat MCP: pemeriksa ditambal di lapis "Checked" yang ada', async () => {
    const m = server({ exists: true });
    const seeded = legacy();
    Object.assign(m.content().meta, seeded.meta);
    Object.assign(m.content().sections, seeded.sections);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOCID, meta: { checker: 'D. Putra' } });
    expect(r.isError).toBeFalsy();
    const chain = m.content().sections.controlSheet.verificationChain;
    expect(chain.filter((v: any) => v.name === 'D. Putra')).toEqual([{ layer: '2', role: 'Checked', name: 'D. Putra' }]);
    expect(chain).toHaveLength(3);
  });
});
