// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw4-cycle1.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W4 siklus perbaikan 1 (D-552, review 13 bagian IMPL-W4 = CAUTION): probe p19-p21 sebagai uji.
// W4-M1 saluran meta klien menambal entri yang dimaksud saja (baris sampul/lapis verifikasi/peran tanda tangan lain
//       tetap), menolak (ok:false) perubahan yang tidak dapat diterapkan tanpa kehilangan, cek penulis per slot depan.
// W4-L1 aturan sesi terikat revisi (tulisan pihak lain SESUDAH tulisan sesi -> PART_CHANGED_BY_OTHER).
// W4-L2 batas unduhan + ukuran entri zip; pemindai tag linear.
// W4-I1 peringatan nomor tampilan; W4-I2 petunjuk ulang galat nyata = server.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { strToU8, zipSync } from 'fflate';
import { connect, logs, reply } from './mcp-harness';
import { DOC } from '../draft/r3-stateful-harness';
import { clientServer, DOCID, env, WRITE_ARGS, writes } from './implw3-client-mock';
import { docxPrinted, htmlPrinted } from '../../../vendor/scripts/studio/mcp/write-verify';

beforeEach(() => {
  logs.length = 0;
});

/** p20 K1: dokumen klien dengan baris sampul kustom, lapis verifikasi QA, dan peran tanda tangan Saksi. */
function customDoc() {
  const m = clientServer({ exists: true });
  const c = m.content();
  c.sections.cover.control.push([{ text: 'Proyek' }, { text: 'Alpha-Kustom' }, { text: '' }, { text: '' }]);
  c.sections.controlSheet.verificationChain = [{ layer: '1', role: 'Penyusun', name: 'Tim Kajian GSP' }, { layer: '4', role: 'QA Eksternal', name: 'Auditor X' }];
  c.sections.signature.roles.push({ role: { text: 'Saksi' }, holder: { text: 'Pak Saksi' } });
  return m;
}
const codes = (r: any) => (r.data.warnings ?? []).map((w: any) => w.code);

describe('W4-M1: saluran meta klien menambal, tidak menyusun ulang', () => {
  it('p20 K1: rev + nomor diterapkan; baris sampul Proyek, lapis QA Eksternal, peran Saksi tetap', async () => {
    const m = customDoc();
    const before = structuredClone(m.content().sections);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOCID, meta: { rev: 'B', number: 'N-2\n## Palsu', docNumber: '999/PALSU', agentId: 'mallory', createdBy: 'agent:mallory' } });
    expect(r.data.ok, r.text).toBe(true);
    const s = m.content().sections;
    expect(JSON.stringify(s.cover.control)).toContain('Alpha-Kustom');
    expect(s.controlSheet.verificationChain).toContainEqual({ layer: '4', role: 'QA Eksternal', name: 'Auditor X' });
    expect(s.signature.roles).toContainEqual({ role: { text: 'Saksi' }, holder: { text: 'Pak Saksi' } });
    // entri yang tidak disentuh tetap identik byte
    expect(JSON.stringify(s.cover.control[1])).toBe(JSON.stringify(before.cover.control[1]));
    expect(JSON.stringify(s.signature.roles)).toBe(JSON.stringify(before.signature.roles));
    expect(JSON.stringify(s.controlSheet.verificationChain)).toBe(JSON.stringify(before.controlSheet.verificationChain));
    // nilai yang dimaksud ditambal (satu baris), docNumber server tidak berubah
    expect(JSON.stringify(s.cover.control[0])).toMatch(/999\/PALSU|N-2 ## Palsu/);
    expect(JSON.stringify(s.cover.control[0])).toContain('B · 2026-11-03');
    expect(m.content().meta.docNumber).toBe('018/GSP/KT/XI/2026');
    // W4-I1
    expect(codes(r)).toContain('NUMBER_DISPLAY_ONLY');
  });

  it('perubahan yang tidak dapat diterapkan tanpa kehilangan (bahasa) -> ok:false META_UNSAFE + daftar, 0 tulis', async () => {
    const m = customDoc();
    const n = m.calls.length;
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOCID, meta: { language: 'EN', rev: 'B' } });
    expect(r.data.ok).toBe(false);
    expect(r.isError).toBeFalsy();
    expect(r.data.code).toBe('META_UNSAFE');
    expect(JSON.stringify(r.data.error.details)).toContain('language');
    expect(writes(m.calls.slice(n))).toEqual([]);
  });

  it('slot depan terakhir ditulis pihak lain -> PART_CHANGED_BY_OTHER, 0 tulis', async () => {
    const m = customDoc();
    m.other('slot:signature', (c: any) => c.sections.signature.roles.push({ role: { text: 'Mengetahui' }, holder: { text: 'Direktur' } }));
    const n = m.calls.length;
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOCID, meta: { author: 'Tim Baru' } });
    expect(r.data.ok, r.text).toBe(false);
    expect(r.data.code).toBe('PART_CHANGED_BY_OTHER');
    expect(writes(m.calls.slice(n))).toEqual([]);
  });
});

describe('W4-L1: aturan sesi terikat revisi', () => {
  it('p21 S2: sesi A menulis cover, pihak lain menulis cover sesudahnya (R15 null) -> tulis ulang A ditolak, tulisan pihak lain tetap', async () => {
    const m = clientServer();
    const nullCover = async (url: string, init: any) => {
      const res = await m.f(url, init);
      if (!new URL(url).pathname.endsWith('/completeness')) return res;
      const b = JSON.parse(await res.text());
      for (const sl of b.completeness.slots ?? []) if (sl.slotKey === 'cover') sl.lastFilledBy = null;
      return reply({ status: 200, body: b });
    };
    const a = await connect({ fetch: nullCover as any, env });
    // sesi A menulis dokumen (cover dicatat sesi beserta revisinya), lalu menyunting meta (cover lagi)
    const w0 = await a.call('studio_write', WRITE_ARGS);
    expect(w0.data.ok, w0.text).toBe(true);
    const e1 = await a.call('studio_edit', { documentId: DOCID, meta: { rev: 'B' } });
    expect(e1.data.ok, e1.text).toBe(true);
    m.other('slot:cover', (c: any) => (c.sections.cover = { ...c.sections.cover, standfirst: { text: 'STANDFIRST-PIHAK-LAIN' } }));
    // A menyunting bab 1 sehingga penulis terakhir DOKUMEN = A (pagar dokumen tidak lagi menahan)
    const e2 = await a.call('studio_edit', { documentId: DOCID, edits: [{ find: 'Kajian ini disusun', replace: 'Kajian ini dibuat' }] });
    expect(e2.data.ok, e2.text).toBe(true);
    const w = await a.call('studio_write', { ...WRITE_ARGS, meta: { ...WRITE_ARGS.meta, standfirst: 'Versi saya' } });
    expect(w.data.ok).toBe(false);
    expect(w.data.code).toBe('PART_CHANGED_BY_OTHER');
    expect(JSON.stringify(m.content().sections.cover)).toContain('STANDFIRST-PIHAK-LAIN');
  });
});

describe('W4-L2: batas ukuran dan pemindai linear', () => {
  it('entri document.xml > 20 MB tidak didekompresi -> VERIFY_TOO_LARGE', () => {
    const zip = zipSync({ 'word/document.xml': [new Uint8Array(21 * 1024 * 1024).fill(0x41), { level: 1 }] });
    expect(() => docxPrinted(zip)).toThrow(/VERIFY_TOO_LARGE|terlalu besar/);
  });

  it('80.000 tag pembuka tanpa penutup dipindai linear (DOCX dan HTML < 1 s)', () => {
    const n = 80_000;
    const t0 = Date.now();
    docxPrinted(zipSync({ 'word/document.xml': strToU8('<w:document>' + '<w:p a="1">x'.repeat(n) + '</w:document>') }));
    htmlPrinted(strToU8('<html><body>' + '<p>x'.repeat(n) + '</body></html>'));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('render > 25 MB: tanpa unduhan, ringkasan VERIFY_TOO_LARGE, tulisan tetap ok', async () => {
    const m = clientServer({ exists: true });
    const f = async (url: string, init: any) => {
      if (new URL(url).pathname === `/api/studio/documents/${DOCID}/render`) return reply({ status: 200, body: { outputs: [{ id: 'cmwfiledocx000000000000w2a', format: 'DOCX', sha256: 'b'.repeat(64), byteSize: 30 * 1024 * 1024 }] } });
      return m.f(url, init);
    };
    const { call } = await connect({ fetch: f as any, env });
    const r = await call('studio_edit', { documentId: DOCID, meta: { rev: 'B' } });
    expect(r.data.ok, r.text).toBe(true);
    expect(r.data.verify.error).toBe('VERIFY_TOO_LARGE');
    expect(m.calls.some((c) => c.method === 'GET' && c.url.includes('/api/studio/files/'))).toBe(false);
  });
});

describe('W4-I2: petunjuk ulang galat nyata', () => {
  it('server tak terjangkau identik ke-3 -> "server bermasalah", tidak pernah "berhenti mengulang"', async () => {
    const f = async () => {
      throw new Error('ECONNREFUSED');
    };
    const { call } = await connect({ fetch: f as any, env: { STUDIO_AGENT_ID: 'cod-r3-f2', STUDIO_MCP_TOOLSETS: 'write' } });
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await call('studio_edit', { documentId: DOC, edits: [{ find: 'satu dua tiga', replace: 'x' }] }));
    for (const r of rs) expect(r.data.hint).not.toContain('berhenti mengulang');
    expect(rs[2].data.hint).toContain('server bermasalah; tunggu lalu coba lagi');
  });
});
