// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw3-lenient.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W3 butir 3 + 7: kelonggaran skema alat write (varian blok/meta/properti tak dikenal -> peringatan, bukan
// INVALID_ARGUMENT), META_CONFLICT judul laporan sendiri diserap, HEAD verifikasi 404 dicoba ulang singkat.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, studioMock, FILE_ID } from './mcp-harness';
import { DOC, FINAL } from '../draft/r3-stateful-harness';
import { normalizeEditArgs, normalizeWriteArgs } from '../../../vendor/scripts/studio/mcp/write-normalize';

const AGENT = 'cod-implw3';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };

beforeEach(() => {
  logs.length = 0;
});

describe('normalisasi murni', () => {
  it('varian blok -> kanonik; meta angka -> teks; properti tak dikenal -> ARG_IGNORED', () => {
    const a: any = {
      mission: '2026-11-03_implw3',
      docKey: 'k',
      bocor: 1,
      meta: { status: 'selesai', revisi: 0, nested: { x: 1 } },
      sections: [
        { title: 'Ringkasan', content: [{ paragraph: 'satu' }, { type: 'text', text: 'dua' }, { rows: [['a', 'b'], ['1', true]], title: 'Tabel x' }, { items: ['p', 'q'], numbered: true }, { heading: 'Sub' }, { heading: 'Bersarang', blocks: ['isi bersarang'] }, ['butir a', 'butir b']] },
      ],
    };
    const w = normalizeWriteArgs(a);
    expect(a.bocor).toBeUndefined();
    expect(a.meta).toEqual({ status: 'selesai', revisi: '0' });
    expect(a.sections[0].heading).toBe('Ringkasan');
    expect(a.sections[0].blocks).toEqual(['satu', 'dua', { table: [['a', 'b'], ['1', 'true']], caption: 'Tabel x' }, { list: ['p', 'q'], ordered: true }, { subheading: 'Sub' }, { subheading: 'Bersarang' }, 'isi bersarang', { list: ['butir a', 'butir b'] }]);
    expect(w.map((x) => x.code)).toEqual(['ARG_MAPPED', 'ARG_IGNORED']);
  });

  it('edit: {old,new}, baris/kolom datar, occurrence true, pid + offset', () => {
    const a: any = { documentId: 'x', changes: [{ old: 'a', new: 'b' }, { row: 'T-1', column: 'status', value: 2 }, { find: 'c', replace: 'd', occurrence: true }, { pid: 'p-1', offset: '3', with: ',' }] };
    normalizeEditArgs(a);
    expect(a.edits).toEqual([{ find: 'a', replace: 'b' }, { cell: { row: 'T-1', column: 'status' }, value: '2' }, { find: 'c', replace: 'd', occurrence: 'all' }, { pid: 'p-1', at: 3, replace: ',' }]);
  });
});

describe('lewat MCP', () => {
  it('studio_write dengan varian blok dan kunci tak dikenal -> ok (bukan INVALID_ARGUMENT), peringatan ARG_*', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_write', {
      mission: '2026-11-03_implw3',
      docKey: 'lap-varian',
      extra: 'abaikan',
      meta: { status: 'selesai', tanggal: '2026-11-03', nomor: 7 },
      sections: [
        { title: 'Ringkasan', content: [{ paragraph: 'Semua beres.' }] },
        { heading: 'Rincian kerja', blocks: [{ rows: [['judul', 'status'], ['A', 'terblokir']] }] },
        { heading: 'Bukti', blocks: [{ items: ['vitest'] }] },
        { heading: 'Isu terbuka', blocks: ['Tidak ada.'] },
        { heading: 'Langkah berikut', blocks: ['Lanjut.'] },
      ],
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.data.ok, r.text).toBe(true);
    expect(r.data.warnings.map((w: any) => w.code)).toEqual(expect.arrayContaining(['ARG_MAPPED', 'ARG_IGNORED']));
  });

  it('judul baru pada laporan sendiri -> setMeta berbasis revisi yang dibaca (META_UPDATED), bukan 409', async () => {
    // Siklus 1 (W3-M1/W3-L4): laporan yang ada ditulis lewat jalur update; pemanggil = penulis bagian di server tiruan.
    const AGENT = 'cod-r3-f2';
    const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };
    let conflicts = 0;
    const m = studioMock({
      'GET /api/studio/documents': () => ({ status: 200, body: { documents: [{ id: DOC, createdBy: `agent:${AGENT}`, currentRevisionNo: 6 }] } }),
      'GET /api/studio/contracts': () => ({ status: 200, body: { contracts: [{ documentId: DOC }], nextCursor: null } }),
      [`GET /api/studio/documents/${DOC}`]: () => ({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: 6 }, revision: { revisionNo: 6, createdBy: `agent:${AGENT}` } } }),
      // IMPL-W5 E6: cap ReportedAt mengirim record berjudul LAMA (sah); konflik hanya bila record membawa judul baru.
      'POST /api/studio/slots': (c) => (conflicts === 0 && c.body.slot === 'record' && JSON.stringify(c.body).includes('"Baru"') ? (conflicts++, { status: 409, body: { error: 'Meta kiriman berbeda', code: 'META_CONFLICT', details: { fields: { title: { current: 'Lama', sent: 'Baru' } } } } }) : undefined),
      [`PATCH /api/studio/documents/${DOC}/structure`]: (c) => ({ status: 200, body: { revision: { revisionNo: 7 }, echo: c.body } }),
    });
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_write', { mission: '2026-11-01_r3f2', docKey: 'lapkerja-r3f2-uji', title: 'Baru', sections: [{ heading: 'Ringkasan', blocks: ['x'] }] });
    const patch = m.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({ op: 'setMeta', baseRevisionNo: 6, meta: { title: 'Baru' } });
    expect(r.data.code === 'META_CONFLICT').toBe(false);
    expect(JSON.stringify(r.data.warnings ?? [])).toContain('META_UPDATED');
  });

  it('studio_file_verify: HEAD 404 dua kali lalu 200 -> terverifikasi (coba ulang singkat)', async () => {
    let n = 0;
    const m = studioMock({ ['HEAD /api/studio/files/' + FILE_ID]: () => (++n <= 2 ? { status: 404, body: { error: 'belum ada', code: 'FILE_NOT_FOUND' } } : { status: 200, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256-verified': 'true' } }) });
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_file_verify', { fileId: FILE_ID });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.data.ok, r.text).toBe(true);
    expect(n).toBe(3);
  }, 10_000);
});
