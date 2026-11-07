// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/mcp-text.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// MCP-06 (D-469): teks hasil alat MCP netral-MCP (tanpa istilah CLI) dan peringatan C4 sekali per dokumen.
/* eslint-disable @typescript-eslint/no-explicit-any -- structuredContent bebas bentuk */
import { describe, it, expect, beforeEach } from '../_vitest';
import { mcpText, mcpTextDeep } from '../../../vendor/scripts/studio/mcp/cli-text';
import { DOC, MD } from '../draft/r3-stateful-harness';
import { connect, logs, NEW_MD, studioMock } from './mcp-harness';

beforeEach(() => {
  logs.length = 0;
});

/** Opsi CLI (--nama) atau perintah studio-report di teks/rincian. */
const CLI_TERM = /(?<![-\w])--[a-z][a-z-]*|studio-report /;

/** Teks hasil + JSON hasil tanpa isi dokumen asal server (medan markdown/refresh). */
function surface(r: any): string {
  const data = JSON.parse(JSON.stringify(r.data ?? {}));
  delete data.markdown;
  if (data.error?.details) delete data.error.details.refresh;
  if (data.refresh) delete data.refresh;
  const text = String(r.text).replace(/<data-tak-tepercaya[\s\S]*?<\/data-tak-tepercaya>/g, '');
  return `${text}\n${JSON.stringify(data)}`;
}

describe('MCP-06: pemetaan istilah CLI -> nama alat/parameter MCP (lapisan MCP saja)', () => {
  it('mcpText: setiap istilah CLI diganti nama parameter/alat MCP', () => {
    const cases: Array<[string, string]> = [
      ['disimpan: tidak (pakai --out <dir> untuk menyimpan)', 'downloadDir'],
      ['atau berikan --base-rev <n>; --force-latest hanya bila Anda yakin tidak ada penulis lain.', 'baseRev'],
      ['dikirim sekarang dengan --section 1,3 (basis lama', 'sections: ["1","3"]'],
      ['di luar --section, tidak dikirim', 'di luar sections'],
      ['atau berikan --allow-remove. Tidak ada', 'allowRemove=true'],
      ['  ditulis: tidak (laporan gabungan di stdout; --out-md <berkas> atau --write untuk menyimpan)', 'outPath atau write=true'],
      ['jalankan studio-report refresh DOC123 (teks-markdown) --write   (menimpa (teks-markdown) dengan laporan gabungan + basis terkini; atau --out-md <laporan-segar.md>, lalu update HANYA berkas itu) - refresh', 'studio_report_refresh (documentId DOC123'],
      ['jalankan ulang "studio-report update DOC123 (teks-markdown)" dengan baris basis', 'studio_report_update (documentId DOC123)'],
      ['periksa dengan studio-report check sesudah', 'studio_report_check'],
      ['(tambahkan --remote <url>)', 'remote=true'],
    ];
    for (const [input, want] of cases) {
      const out = mcpText(input);
      expect(out, input).toContain(want);
      expect(out, input).not.toMatch(CLI_TERM);
    }
  });

  it('mcpTextDeep melewati medan isi dokumen asal server (markdown/refresh)', () => {
    const v = mcpTextDeep({ note: 'pakai --write', markdown: 'isi dokumen memuat --write dan --section', refresh: [{ markdown: ['--section'] }] }) as any;
    expect(v.note).toBe('pakai write=true');
    expect(v.markdown).toBe('isi dokumen memuat --write dan --section');
    expect(v.refresh[0].markdown[0]).toBe('--section');
  });

  it('hasil submit/update/refresh/check dan galat tidak memuat istilah CLI; basis ingatan disebut "diingat server sesi ini"', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f });
    const all: Array<[string, any]> = [];
    const keep = async (n: string, tool: string, args: Record<string, unknown>) => {
      const r = await call(tool, args);
      all.push([n, r]);
      return r;
    };

    await keep('check lokal', 'studio_report_check', { markdown: NEW_MD, remote: false });
    await keep('check remote', 'studio_report_check', { markdown: NEW_MD });
    const sub = await keep('submit', 'studio_report_submit', { markdown: NEW_MD });
    expect(sub.text).toContain('downloadDir');
    expect(sub.text).toContain('studio_file_verify');

    // basis dari ingatan server
    const mem = await keep('update basis sesi', 'studio_report_update', { documentId: DOC, markdown: MD({ basis: null, bab5: '- Lewat ingatan.' }) });
    expect(mem.isError).toBeFalsy();
    expect(mem.text).toMatch(/basis rev\d+ \(diingat server sesi ini\), terkini rev\d+/);
    expect(mem.data.basis.source).toBe('diingat-server');

    // basis dari baris kepala laporan
    const head = await keep('update baris kepala', 'studio_report_update', { documentId: DOC, markdown: MD({ basis: `${DOC}@rev${m.s.rev()}`, bab5: '- Lewat kepala.' }) });
    expect(head.text).toContain('(baris basis kepala)');

    // basis dari parameter baseRev (laporan memuat baris basis lama; baseRev menang)
    const byRev = await keep('update baseRev', 'studio_report_update', { documentId: DOC, markdown: MD({ basis: `${DOC}@rev1`, bab5: '- Lewat baseRev.' }), baseRev: m.s.rev() });
    expect(byRev.text).toMatch(/basis: rev\d+ \(baseRev\)/);

    // BASE_CONFLICT: B menulis bab 3; A (basis lama) mengubah bab 1 + bab 3
    const stale = `${DOC}@rev${m.s.rev()}`;
    const b = await call('studio_report_update', { documentId: DOC, markdown: MD({ basis: stale, bab3: ['Bukti B.'] }), agentId: 'cod-b' });
    expect(b.isError).toBeFalsy();
    const a = await keep('BASE_CONFLICT', 'studio_report_update', { documentId: DOC, markdown: MD({ basis: stale, bab1: 'A mengubah bab 1.', bab3: ['Bukti A.'] }), agentId: 'cod-a' });
    expect(a.data.error.code).toBe('BASE_CONFLICT');
    expect(a.data.error.message).toContain('studio_report_refresh');
    expect(a.data.error.message).toContain('sections: ["1"]');
    expect(a.data.error.details.refreshCommand).toContain('studio_report_refresh');

    // refresh tanpa menulis berkas
    const ref = await keep('refresh', 'studio_report_refresh', { documentId: DOC, markdown: MD({ basis: stale, bab1: 'A mengubah bab 1.', bab3: ['Bukti A.'] }), agentId: 'cod-a' });
    expect(ref.text).toContain('outPath atau write=true');

    // galat lain: SECTION_UNKNOWN, BASIS_MISSING (refresh tanpa basis)
    const unk = await keep('SECTION_UNKNOWN', 'studio_report_update', { documentId: DOC, markdown: MD({ basis: `${DOC}@rev${m.s.rev()}` }), sections: ['99'] });
    expect(unk.data.error.code).toBe('SECTION_UNKNOWN');
    expect(unk.text).toContain('sections 99');
    const nob = await keep('refresh BASIS_MISSING', 'studio_report_refresh', { documentId: DOC, markdown: MD({ basis: null }) });
    expect(nob.data.error.code).toBe('BASIS_MISSING');
    expect(nob.text).toContain('baseRev');

    for (const [n, r] of all) expect(surface(r), n).not.toMatch(CLI_TERM);
  });
});

describe('MCP-06: peringatan C4 (Owner != agentId) sekali per documentId per proses sesi', () => {
  it('check/submit/update berulang: peringatan hanya pada pemunculan pertama per dokumen; proses (sesi) baru memberi peringatan lagi', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, config: { defaultAgentId: 'hermes-gsp-master01' } });
    const mismatch = (md: string) => md.replace('Owner: cod-r3-f2', 'Owner: gsp-master01');
    const md = mismatch(NEW_MD);

    const c1 = await call('studio_report_check', { markdown: md });
    expect(c1.data.warnings).toEqual([expect.objectContaining({ code: 'OWNER_AGENT_MISMATCH' })]);
    const c2 = await call('studio_report_check', { markdown: md });
    expect(c2.data.warnings).toBeUndefined();
    expect(c2.text).not.toContain('OWNER_AGENT_MISMATCH');

    const s = await call('studio_report_submit', { markdown: md });
    expect(s.data.warnings).toEqual([expect.objectContaining({ code: 'OWNER_AGENT_MISMATCH' })]);

    // update dokumen yang sama: sudah diperingatkan saat submit
    const u1 = await call('studio_report_update', { documentId: DOC, markdown: mismatch(MD({ basis: null, bab1: 'u1' })) });
    expect(u1.isError).toBeFalsy();
    expect(u1.data.warnings).toBeUndefined();
    const u2 = await call('studio_report_update', { documentId: DOC, markdown: mismatch(MD({ basis: null, bab1: 'u2' })) });
    expect(u2.data.warnings).toBeUndefined();
    expect(u2.text).not.toContain('OWNER_AGENT_MISMATCH');

    // proses MCP lain (sesi baru): peringatan muncul lagi satu kali untuk dokumen ini
    const m2 = studioMock();
    const other = await connect({ fetch: m2.f, config: { defaultAgentId: 'hermes-gsp-master01' } });
    const w1 = await other.call('studio_report_update', { documentId: DOC, markdown: mismatch(MD({ bab1: 'w1' })) });
    expect(w1.data.warnings).toEqual([expect.objectContaining({ code: 'OWNER_AGENT_MISMATCH' })]);
    const w2 = await other.call('studio_report_update', { documentId: DOC, markdown: mismatch(MD({ basis: null, bab1: 'w2' })) });
    expect(w2.data.warnings).toBeUndefined();
  });

  it('tanpa ketidakcocokan tidak ada peringatan', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, config: { defaultAgentId: 'hermes-gsp-master01' } });
    const ok = await call('studio_report_check', { markdown: NEW_MD.replace('Owner: cod-r3-f2', 'Owner: hermes-gsp-master01') });
    expect(ok.data.warnings).toBeUndefined();
  });
});
