// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/implw6-quiet.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// IMPL-W6: peringatan informasional (ITEM_KEY_COLUMN_ADDED, ITEM_KEY_GENERATED) disembunyikan dari hasil ringkas
// studio_write/studio_edit (laporan kerja) dan tetap tampil dengan `detail: true`; deskripsi alat memuat kalimat
// "argumen harus objek JSON".
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { connect, logs, studioMock } from './mcp-harness';
import { DOC } from '../draft/r3-stateful-harness';
import { TOOLS } from '../../../vendor/scripts/studio/mcp/tools';
import { INFORMATIONAL_WARNING_CODES, quietWarnings } from '../../../vendor/scripts/studio/mcp/tool-kit';

const AGENT = 'cod-implw6';
const MISSION = '2026-11-04_implw6';
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: 'write' };

beforeEach(() => {
  logs.length = 0;
});

// Tabel butir TANPA kolom kunci dan butir tanpa kunci -> ITEM_KEY_COLUMN_ADDED + ITEM_KEY_GENERATED + HEADING_MAPPED.
const SECTIONS = [
  { heading: 'Summary', blocks: ['Semua tugas IMPL-W6 selesai.'] },
  { heading: 'Rincian Pekerjaan', blocks: [[['Judul', 'Status', 'Bukti'], ['Tulis studio_write', 'selesai', 'out/a.txt 12 B'], ['Uji', 'in progress']]] },
  { heading: 'Bukti', blocks: [{ list: ['vitest lulus', 'tsc 0'] }] },
  { heading: 'Risks', blocks: ['Tidak ada.'] },
  { heading: 'Langkah berikut', blocks: ['Uji ronde 5.'] },
];

const codesOf = (r: any): string[] => (r.data.warnings ?? []).map((w: any) => w.code);
const INFO = ['ITEM_KEY_COLUMN_ADDED', 'ITEM_KEY_GENERATED'];

describe('IMPL-W6: peringatan informasional senyap di hasil ringkas', () => {
  it('kelas informasional berisi dua kode ITEM_KEY_* (+ ARGS_UNWRAPPED, META_LIFTED_FROM_EDITS); quietWarnings tidak menyentuh peringatan lain', () => {
    // IMPL-W8: ARGS_UNWRAPPED + META_LIFTED_FROM_EDITS ikut kelas informasional. IMPL-W10 L16-2: ROWS_COALESCED_TO_TABLE
    // (IMPL-W7), SECTION_CREATED dan VERDICT_NORMALIZED (IMPL-W9) dikeluarkan karena mengubah isi tersimpan.
    expect([...INFORMATIONAL_WARNING_CODES].sort()).toEqual([...INFO, 'ARGS_UNWRAPPED', 'META_LIFTED_FROM_EDITS'].sort());
    const all = [{ code: 'ITEM_KEY_GENERATED', message: 'a' }, { code: 'HEADING_MAPPED', message: 'b' }, { code: 'ITEM_KEY_COLUMN_ADDED', message: 'c' }];
    expect(quietWarnings(all, false).map((w) => w.code)).toEqual(['HEADING_MAPPED']);
    expect(quietWarnings(all, true)).toEqual(all);
  });

  it('(a) studio_write laporan tanpa kolom kunci: hasil ringkas tanpa ITEM_KEY_* (teks dan structuredContent), peringatan lain tetap', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_write', { mission: MISSION, docKey: 'lap-implw6', sections: SECTIONS });
    expect(r.isError).toBeFalsy();
    expect(codesOf(r)).not.toContain('ITEM_KEY_COLUMN_ADDED');
    expect(codesOf(r)).not.toContain('ITEM_KEY_GENERATED');
    expect(r.text).not.toContain('ITEM_KEY_');
    // Peringatan yang perlu dibaca agen tidak ikut disenyapkan.
    expect(codesOf(r)).toEqual(expect.arrayContaining(['HEADING_MAPPED', 'STATUS_DEFAULTED']));
    expect(r.text).toContain('peringatan HEADING_MAPPED');
  });

  it('(b) detail: true: ITEM_KEY_* tetap tampil (teks dan structuredContent)', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, env });
    const r = await call('studio_write', { mission: MISSION, docKey: 'lap-implw6', sections: SECTIONS, detail: true });
    expect(r.isError).toBeFalsy();
    expect(codesOf(r)).toEqual(expect.arrayContaining(INFO));
    expect(r.text).toContain('peringatan ITEM_KEY_COLUMN_ADDED');
    expect(r.text).toContain('peringatan ITEM_KEY_GENERATED');
  });

  it('studio_edit laporan (addRow tanpa kunci): ringkas tanpa ITEM_KEY_GENERATED, detail: true menampilkannya', async () => {
    const mk = () =>
      studioMock({ [`GET /api/studio/documents/${DOC}`]: () => ({ status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026', createdBy: `agent:${AGENT}`, currentRevisionNo: 6 }, revision: { revisionNo: 6 } } }) });
    const edits = [{ section: 'Rincian kerja', addRow: [['', 'Uji tambahan W6', 'terblokir', 'out/w6.txt 10 B']] }];
    const quiet = await connect({ fetch: mk().f, env });
    const rq = await quiet.call('studio_edit', { documentId: DOC, edits });
    expect(rq.data.ok, rq.text).toBe(true);
    expect(codesOf(rq)).not.toContain('ITEM_KEY_GENERATED');
    expect(rq.text).not.toContain('ITEM_KEY_');
    const full = await connect({ fetch: mk().f, env });
    const rf = await full.call('studio_edit', { documentId: DOC, edits, detail: true });
    expect(rf.data.ok, rf.text).toBe(true);
    expect(codesOf(rf)).toContain('ITEM_KEY_GENERATED');
    expect(rf.text).toContain('peringatan ITEM_KEY_GENERATED');
  });

  it('(c) deskripsi studio_write dan studio_edit memuat kalimat argumen objek JSON dan tetap <= 450 karakter', () => {
    for (const name of ['studio_write', 'studio_edit']) {
      const t = TOOLS.find((x) => x.name === name)!;
      expect(t.description, name).toContain('Argumen harus objek JSON, bukan string berisi JSON.');
      expect(t.description.length, name).toBeLessThanOrEqual(450);
    }
  });
});
