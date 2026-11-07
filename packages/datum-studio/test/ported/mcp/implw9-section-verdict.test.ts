// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw9-section-verdict.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W9 (bukti uji ronde 12, run R12B): (A) studio_edit { section, append } pada laporan kerja membuat section
// laporan baku yang belum ada (Ringkasan, Rincian kerja, Bukti, Isu terbuka, Langkah berikut, Rujukan) di posisi
// bakunya, dengan pemetaan judul yang sama dengan studio_write; Rujukan lewat konversi tabel rujukan yang sama
// (refs[] + validasi documentId/pid). (B) vonis meta dinormalkan dari token awal ("PASS (CHECK 1-8)" -> PASS).
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, reply, studioMock, type Call } from './mcp-harness';
import { DOC, MD, statefulServer } from '../draft/r3-stateful-harness';
import { clientServer, DOCID, env as cenv } from './implw3-client-mock';
import { buildWorkReport } from '../../../vendor/scripts/studio/mcp/write-content';
import { applyEdits, type EditPart } from '../../../vendor/scripts/studio/mcp/write-edit';
import { INFORMATIONAL_WARNING_CODES } from '../../../vendor/scripts/studio/mcp/tool-kit';

const AGENT = 'cod-implw9';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };
const OTHER_DOC = 'cmvvdocother0000000000w9a1';

beforeEach(() => {
  logs.length = 0;
});

/** Laporan milik pemanggil di server berkeadaan dengan teks awal `seed`. */
function mock(seed = MD()) {
  const s = statefulServer(seed);
  const calls: Call[] = [];
  const f = async (url: string, init: any) => {
    const u = new URL(url);
    calls.push({ method: init.method, url, headers: init.headers, redirect: init.redirect, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'POST' && u.pathname === '/api/studio/validate') return reply({ status: 200, body: { valid: true, issues: [] } });
    if (init.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}`) return reply({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: s.rev() }, revision: { revisionNo: s.rev() } } });
    return s.f(url, init);
  };
  return { f, calls, s };
}
const writes = (calls: Call[]) => calls.filter((c) => (c.method === 'POST' || c.method === 'PATCH') && !/\/(render|validate)$/.test(new URL(c.url).pathname));
const codes = (r: any): string[] => [...(r.data.warnings ?? []), ...(r.warnings ?? [])].map((w: any) => w.code);
const NO_BAB4 = MD().replace('## Isu terbuka\n\nTidak ada.\n\n', '');

describe('A: append membuat section laporan baku yang belum ada', () => {
  it('Rujukan (bukti R12B: larik berisi satu tabel) -> section dibuat, refs tersimpan, SECTION_CREATED (detail)', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f as any, env });
    expect(m.s.latest().sections.record.refs ?? []).toEqual([]);
    const r = await call('studio_edit', { documentId: DOC, detail: true, edits: [{ section: 'Rujukan', append: [[['hubungan', 'dokumen', 'paragraf'], ['bukti', OTHER_DOC, 'p-ringkas-1']]] }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.s.latest().sections.record.refs).toEqual([{ documentId: OTHER_DOC, pid: 'p-ringkas-1', rel: 'evidence' }]);
    expect(codes(r)).toContain('SECTION_CREATED');
    expect(r.data.edited).toEqual(['record']);
    // Append kedua ke Rujukan yang kini ada: tidak membuat section kedua, baris ditambahkan.
    const r2 = await call('studio_edit', { documentId: DOC, detail: true, edits: [{ section: 'Rujukan', append: [{ ref: { rel: 'basis', documentId: OTHER_DOC } }] }] });
    expect(r2.data.ok, r2.text).toBe(true);
    expect(codes(r2)).not.toContain('SECTION_CREATED');
    expect(m.s.latest().sections.record.refs.map((x: any) => x.rel)).toEqual(['evidence', 'basis']);
  });

  it('Rujukan dengan pid tak sah -> penolakan yang sama dengan jalur studio_write (MD_REPORT_INVALID), 0 tulis', async () => {
    const table = [['hubungan', 'dokumen', 'paragraf'], ['bukti', OTHER_DOC, 'P 1!']];
    const w = studioMock();
    const cw = await connect({ fetch: w.f, env });
    const rw = await cw.call('studio_write', { mission: '2026-11-04_implw9', docKey: 'lap-implw9', sections: [{ heading: 'Ringkasan', blocks: ['x'] }, { heading: 'Rujukan', blocks: [table] }] });
    expect(rw.data.ok).toBe(false);
    const m = mock();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Rujukan', append: [table] }] });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe(rw.data.error.code);
    expect(r.data.error.code).toBe('MD_REPORT_INVALID');
    expect(writes(m.calls)).toEqual([]);
  });

  it('Rujukan menolak blok teks (bukan tabel/ref) -> EDIT_INVALID, 0 tulis', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Rujukan', append: ['teks bebas'] }] });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('EDIT_INVALID');
    expect(writes(m.calls)).toEqual([]);
  });

  it('bab wajib yang belum ada (Isu terbuka) -> bab 4 dibuat dengan judul baku, blok ditambahkan; bab lain tidak dikirim', async () => {
    const m = mock(NO_BAB4);
    const { call } = await connect({ fetch: m.f as any, env });
    expect(m.s.chapter('4')).toBeUndefined();
    const r = await call('studio_edit', { documentId: DOC, detail: true, edits: [{ section: 'isu terbuka', append: ['Isu baru: kuota uji.', { list: ['a', 'b'] }] }] });
    expect(r.data.ok, r.text).toBe(true);
    const ch = m.s.chapter('4');
    expect(ch.sections[0].title.text ?? JSON.stringify(ch.sections[0].title)).toContain('Isu terbuka');
    expect(ch.sections[0].blocks.map((b: any) => b.type)).toEqual(['paragraph', 'list']);
    expect(codes(r)).toContain('SECTION_CREATED');
    expect(r.data.edited).toContain('bab 4');
    expect(r.data.edited.filter((p: string) => p.startsWith('bab '))).toEqual(['bab 4']);
  });

  it('judul alias (Risks -> Isu terbuka, pemetaan studio_write) juga membuat bab baku', async () => {
    const m = mock(NO_BAB4);
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Risks', append: 'Risiko anggaran.' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(JSON.stringify(m.s.chapter('4'))).toContain('Risiko anggaran.');
  });

  it('posisi baku: bagian baru disisipkan menurut urutan bab, Rujukan di ekor record (fungsi murni)', () => {
    const part = (p: string, body: string[], tail: string[] = []): EditPart => ({ part: p, md: { header: p === 'record' ? ['Status: partial'] : [], intro: [], body, tail } });
    const parts = [part('record', []), part('bab 1', ['## Ringkasan', '', 'x', '']), part('bab 3', ['## Bukti', '', 'y', '']), part('bab 5', ['## Langkah berikut', '', 'z', ''])];
    const ws: any[] = [];
    const { plan } = applyEdits(parts, [{ section: 'Isu terbuka', append: ['Isu.'] }, { section: 'Rujukan', append: [[['hubungan', 'dokumen'], ['bukti', OTHER_DOC]]] }], (w) => ws.push(w), { createMissing: true });
    expect(parts.map((p) => p.part)).toEqual(['record', 'bab 1', 'bab 3', 'bab 4', 'bab 5']);
    expect(parts[3].md.body[0]).toBe('## Isu terbuka');
    expect(parts[0].md.tail[0]).toBe('## Rujukan');
    expect(parts[0].md.tail.join('\n')).toContain(OTHER_DOC);
    expect(plan.refCells).toBe(true);
    expect([...(plan.created ?? [])]).toEqual(['bab 4']);
    expect(ws.filter((w) => w.code === 'SECTION_CREATED')).toHaveLength(2);
  });

  it('section non-baku yang tidak ada -> TEXT_NOT_FOUND seperti dulu, 0 tulis', async () => {
    const m = mock();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, edits: [{ section: 'Bab Fiktif', append: 'Y.' }] });
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('TEXT_NOT_FOUND');
    expect(writes(m.calls)).toEqual([]);
  });

  it('dokumen klien: append ke section yang tidak ada tetap TEXT_NOT_FOUND (tanpa pembuatan section)', async () => {
    for (const section of ['Ringkasan', 'Rujukan', 'Isu terbuka']) {
      const m = clientServer({ exists: true });
      const { call } = await connect({ fetch: m.f as any, env: cenv });
      const r = await call('studio_edit', { documentId: DOCID, edits: [{ section, append: 'Teks.' }] });
      expect(r.data.ok, section).toBe(false);
      expect(r.data.error.code).toBe('TEXT_NOT_FOUND');
      expect(m.calls.filter((c) => (c.method === 'POST' || c.method === 'PATCH') && !c.url.endsWith('/validate'))).toEqual([]);
    }
  });
});

describe('B: normalisasi vonis', () => {
  const header = (verdict: string) => {
    const b = buildWorkReport({ mission: '2026-11-04_x', docKey: 'lap-1', title: null, meta: { verdict }, sections: [{ heading: 'Ringkasan', blocks: ['x'] }], agentId: AGENT, now: 0 });
    return { line: /^Verdict: (.*)$/m.exec(b.markdown)?.[1] ?? null, codes: b.warnings.map((w) => w.code), warnings: b.warnings };
  };

  it('token awal yang terpetakan -> nilai enum + VERDICT_NORMALIZED (teks asli di rincian)', () => {
    const cases: Array<[string, string]> = [
      ['PASS (CHECK 1-8)', 'PASS'], ['pass: semua lulus', 'PASS'], ['NEEDS-REVIEW, lihat isu', 'NEEDS_REVIEW'], ['needs review (2 temuan)', 'NEEDS_REVIEW'],
      ['LULUS - cek 1-8', 'PASS'], ['Butuh tinjauan: data', 'NEEDS_REVIEW'],
      ['WASPADA (kuota)', 'CAUTION'], ['FAIL; lihat log', 'FAIL'], ['caution - minor', 'CAUTION'],
      // IMPL-W10 L16-1: "GAGAL 2 dari 8", "PERLU TINJAUAN lanjutan", "lulus dengan catatan minor" (sisa diawali kata/angka,
      // bukan anotasi netral) kini VERDICT_DROPPED; lihat implw10-final.test.ts.
    ];
    for (const [raw, want] of cases) {
      const h = header(raw);
      expect(h.line, raw).toBe(want);
      expect(h.codes, raw).toContain('VERDICT_NORMALIZED');
      expect(h.warnings.find((w) => w.code === 'VERDICT_NORMALIZED')?.message, raw).toContain(raw);
      expect(h.codes, raw).not.toContain('VERDICT_DROPPED');
    }
  });

  it('nilai persis/alias penuh tetap tanpa peringatan; tanpa token terpetakan tetap VERDICT_DROPPED', () => {
    for (const [raw, want] of [['PASS', 'PASS'], ['lulus', 'PASS'], ['needs-review', 'NEEDS_REVIEW'], ['lulus dengan catatan', 'CAUTION']]) {
      const h = header(raw);
      expect(h.line, raw).toBe(want);
      expect(h.codes, raw).not.toContain('VERDICT_NORMALIZED');
    }
    for (const raw of ['xyz', '(PASS)', '8/8 lulus', 'not pass', 'GAGAL 2 dari 8', 'PERLU TINJAUAN lanjutan', 'lulus dengan catatan minor']) {
      const h = header(raw);
      expect(h.line, raw).toBeNull();
      expect(h.codes, raw).toContain('VERDICT_DROPPED');
    }
  });

  it('studio_write dan studio_edit meta: "PASS (CHECK 1-8)" -> PASS di record; VERDICT_NORMALIZED tampil (IMPL-W10 L16-2)', async () => {
    const w = studioMock();
    const cw = await connect({ fetch: w.f, env });
    const rw = await cw.call('studio_write', { mission: '2026-11-04_implw9', docKey: 'lap-implw9', meta: { status: 'complete', verdict: 'PASS (CHECK 1-8)' }, sections: [{ heading: 'Ringkasan', blocks: ['x'] }] });
    expect(rw.data.ok, rw.text).toBe(true);
    expect(w.s.latest().sections.record.verdict).toBe('PASS');
    expect(codes(rw)).toContain('VERDICT_NORMALIZED');
    expect(rw.text).toContain('VERDICT_NORMALIZED');

    const m = mock();
    const { call } = await connect({ fetch: m.f as any, env });
    const r = await call('studio_edit', { documentId: DOC, meta: { verdict: 'PASS (CHECK 1-8)' } });
    expect(r.data.ok, r.text).toBe(true);
    expect(m.s.latest().sections.record.verdict).toBe('PASS');
    expect(codes(r)).toContain('VERDICT_NORMALIZED');
    const r2 = await call('studio_edit', { documentId: DOC, detail: true, meta: { verdict: 'gagal: 2 cek' } });
    expect(r2.data.ok, r2.text).toBe(true);
    expect(m.s.latest().sections.record.verdict).toBe('FAIL');
    expect(codes(r2)).toContain('VERDICT_NORMALIZED');
    const r3 = await call('studio_edit', { documentId: DOC, meta: { verdict: 'xyz' } });
    expect(codes(r3)).toContain('VERDICT_DROPPED');
    expect(m.s.latest().sections.record.verdict).toBe('FAIL');
  });

  it('kedua kode baru TIDAK informasional (IMPL-W10 L16-2: keduanya mengubah isi tersimpan)', () => {
    expect(INFORMATIONAL_WARNING_CODES.has('SECTION_CREATED')).toBe(false);
    expect(INFORMATIONAL_WARNING_CODES.has('VERDICT_NORMALIZED')).toBe(false);
  });
});
