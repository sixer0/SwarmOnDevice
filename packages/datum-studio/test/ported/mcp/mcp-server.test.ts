// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/mcp/mcp-server.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// MCP-01 (D-449/D-450/D-457): server MCP Studio stdio. Protokol nyata lewat InMemoryTransport + Client SDK;
// HTTP Studio di-mock (server berkeadaan R3 + rute baca). Bukti: tools/list skema ketat, tiap alat, galat
// membawa code + correlationId, rahasia tidak pernah muncul, nol tulis berkas kecuali alat tulis eksplisit.
/* eslint-disable @typescript-eslint/no-explicit-any -- jawaban JSON-RPC/structuredContent bebas bentuk */
import path from 'node:path';
import { describe, it, expect, beforeEach } from '../_vitest';
import { loadConfig } from '../../../vendor/scripts/studio/mcp/config';
import { guardedFetch, redactSecret, resolveAllowedPath } from '../../../vendor/scripts/studio/mcp/safety';
import { TOOLS } from '../../../vendor/scripts/studio/mcp/tools';
import { DOC, FILE, FINAL, HTML, MD, SHA } from '../draft/r3-stateful-harness';
import { BASE, connect, logs, memNodeFs, NEW_MD, OUTSIDE, reply, ROOT, SECRET, studioMock } from './mcp-harness';

beforeEach(() => {
  logs.length = 0;
});

describe('tools/list, prompts, resources', () => {
  it('22 alat bernama studio_* (semua toolset bawaan; FIG-03b +2), skema object ketat, anotasi, deskripsi; 2 prompt + 4 resource', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'studio_registry',
      'studio_report_template',
      'studio_report_check',
      'studio_report_submit',
      'studio_report_update',
      'studio_report_refresh',
      'studio_contracts_query',
      'studio_search',
      'studio_document_get',
      'studio_render',
      'studio_file_verify',
      'studio_draft_check',
      'studio_templates_list',
      'studio_template_get',
      'studio_document_create',
      'studio_chapter_import_markdown',
      'studio_chapter_submit',
      'studio_slot_fill',
      'studio_document_structure',
      'studio_document_status',
      'studio_figure_preview',
      'studio_figure_revise',
      // row42 ADAPT A10 (row 29, studio spec §5.1): write toolset on by default.
      'studio_write',
      'studio_edit',
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect((t.inputSchema as any).additionalProperties).toBe(false);
      expect(t.description!.length).toBeGreaterThan(40);
      expect(typeof t.annotations?.readOnlyHint).toBe('boolean');
      // MCP-D1: title hanya di tingkat atas (tidak diulang di annotations).
      expect(typeof t.title).toBe('string');
      expect((t.annotations as any).title).toBeUndefined();
      // Tanpa oneOf/anyOf di akar (beberapa penyedia LLM menolaknya).
      // row42 ADAPT A10 (row 29, spec §5.1): studio_write/studio_edit (opt-in in the original, so never checked here) are
      // on by default in Swarm and carry NESTED anyOf (block/edit unions), none at the root. The rule as worded
      // ("di akar") is asserted for every tool; the stricter whole-schema check stays for the original default tools.
      expect(Object.keys(t.inputSchema as object).filter((k) => /^(oneOf|anyOf|allOf)$/.test(k))).toEqual([]);
      if (t.name !== 'studio_write' && t.name !== 'studio_edit') expect(JSON.stringify(t.inputSchema)).not.toMatch(/"(oneOf|anyOf|allOf)"/);
    }
    const ro = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(ro).toEqual(['studio_registry', 'studio_report_template', 'studio_report_check', 'studio_contracts_query', 'studio_search', 'studio_document_get', 'studio_draft_check', 'studio_templates_list', 'studio_template_get', 'studio_document_status']);
    expect(tools.find((t) => t.name === 'studio_report_update')!.inputSchema.required).toEqual(['documentId']);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['studio_dokumen_klien', 'studio_laporan_kerja']);
    const p = await client.getPrompt({ name: 'studio_laporan_kerja', arguments: { mission: '2026-11-01_mcp01', docKey: 'lapkerja-mcp01-a' } });
    const pt = (p.messages[0].content as any).text as string;
    expect(pt).toContain('studio_report_check');
    expect(pt).toContain('docKey: lapkerja-mcp01-a');
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(['studio://resep/dokumen-klien', 'studio://resep/laporan-kerja', 'studio://templat/laporan-kerja', 'studio://panduan/17-0']);
    const guide = await client.readResource({ uri: 'studio://panduan/17-0' });
    expect((guide.contents[0] as any).text).toMatch(/^### 17\.0 Resep satu halaman/);
    await expect(client.readResource({ uri: 'studio://tidak-ada' })).rejects.toThrow(/tidak dikenal/);
  });

  it('alat tak dikenal -> galat protokol InvalidParams', async () => {
    const { client } = await connect();
    await expect(client.callTool({ name: 'studio_hapus_semua', arguments: {} })).rejects.toThrow(/tidak dikenal/);
  });
});

describe('validasi argumen (skema ketat)', () => {
  it('properti tak dikenal, required hilang, markdown+path bersamaan -> INVALID_ARGUMENT dengan correlationId mcp-', async () => {
    const { call } = await connect();
    const a = await call('studio_report_template', { mission: 'm', bocor: 1 });
    expect(a.isError).toBeFalsy(); // IMPL-W3: dapat diperbaiki = hasil normal
    expect(a.data.ok).toBe(false);
    expect(a.data.error.code).toBe('INVALID_ARGUMENT');
    expect(a.data.error.correlationId).toMatch(/^mcp-[0-9a-f-]{36}$/);
    expect(a.data.error.correlationSource).toBe('mcp');
    expect(a.data.error.details[0].pointer).toBe('/bocor');
    expect(a.text).toContain('correlationId: mcp-');
    const b = await call('studio_report_update', { markdown: 'x' });
    expect(b.data.error.code).toBe('INVALID_ARGUMENT');
    const c = await call('studio_report_check', { markdown: NEW_MD, path: path.join(ROOT, 'a.md'), remote: false });
    expect(c.data.error.code).toBe('INVALID_ARGUMENT');
    const d = await call('studio_report_template', { docKey: 'Bukan Pola' });
    expect(d.data.error.details[0].pointer).toBe('/docKey');
  });
});

describe('alat laporan kerja (logika studio-report dipakai ulang)', () => {
  it('template: tanpa server dan tanpa rahasia', async () => {
    const { call } = await connect({ config: { secret: '' } });
    const r = await call('studio_report_template', { mission: '2026-11-01_mcp01', docKey: 'lapkerja-mcp01-a' });
    expect(r.isError).toBeFalsy();
    expect(r.data.template).toContain('docKey: lapkerja-mcp01-a');
    expect(r.text).toContain('<isi:');
  });

  it('check remote=false: nol jaringan; remote: hanya R08 (tanpa kiriman)', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f });
    const local = await call('studio_report_check', { markdown: NEW_MD, remote: false });
    expect(local.data.valid).toBe(true);
    expect(m.calls).toHaveLength(0);
    const remote = await call('studio_report_check', { markdown: NEW_MD });
    expect(remote.data.valid).toBe(true);
    expect(m.calls.length).toBeGreaterThan(0);
    expect(m.calls.every((c) => c.url.endsWith('/api/studio/validate'))).toBe(true);
    expect(remote.text).toContain('VALID');
  });

  it('check: laporan tanpa Status -> MD2CONTRACT_REQUIRED_MISSING (isError), tidak ada kiriman', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f });
    const r = await call('studio_report_check', { markdown: NEW_MD.replace(/^Status: .*$/m, '') });
    expect(r.isError).toBeFalsy(); // IMPL-W3: dapat diperbaiki = hasil normal
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('MD2CONTRACT_REQUIRED_MISSING');
    expect(m.calls).toHaveLength(0);
  });

  it('submit -> update delta -> update tanpa basis ditolak; nextBasis + render terverifikasi; nol tulis', async () => {
    const m = studioMock();
    const mem = memNodeFs();
    const { call } = await connect({ fetch: m.f, nfs: mem.nfs, config: { defaultAgentId: 'cod-mcp-01' } });
    const s = await call('studio_report_submit', { markdown: NEW_MD });
    expect(s.isError).toBeFalsy();
    expect(s.data.documentId).toBe(DOC);
    expect(s.data.render).toMatchObject({ fileId: FILE, finalFileName: FINAL, verified: true, sha256: SHA, savedTo: null });
    expect(s.data.nextBasis).toMatch(new RegExp(`^basis: ${DOC}@rev\\d+$`));
    expect(s.text).toContain('studio_report_refresh');
    // agentId bawaan env dipakai (laporan tanpa baris agentId:).
    expect(m.calls.filter((c) => c.method === 'POST' && c.body?.agentId).every((c) => c.body.agentId === 'cod-mcp-01')).toBe(true);
    const rev = m.s.rev();
    const updMd = MD({ basis: `${DOC}@rev${rev}`, bab1: 'Ringkasan diperbarui lewat MCP.' });
    const u = await call('studio_report_update', { documentId: DOC, markdown: updMd });
    expect(u.isError).toBeFalsy();
    expect(u.data.delta.sent).toEqual(['bab 1']);
    expect(m.s.rev()).toBe(rev + 1);
    // C2: tanpa baris basis -> basis yang diingat sesi (nextBasis update terakhir), dicatat di hasil.
    const mem2 = await call('studio_report_update', { documentId: DOC, markdown: MD({ basis: null, bab1: 'lain' }) });
    expect(mem2.isError).toBeFalsy();
    expect(mem2.data.basisFromSession).toMatchObject({ line: `basis: ${DOC}@rev${rev + 1}`, from: 'studio_report_update' });
    expect(mem2.text).toContain(`basis dipakai: basis: ${DOC}@rev${rev + 1}`);
    expect(m.s.rev()).toBe(rev + 2);
    // Sesi baru (proses server lain) tidak punya ingatan -> BASIS_MISSING, tanpa kiriman.
    const fresh = await connect({ fetch: m.f, nfs: mem.nfs });
    const nb = await fresh.call('studio_report_update', { documentId: DOC, markdown: MD({ basis: null, bab1: 'lain lagi' }) });
    expect(nb.data.error.code).toBe('BASIS_MISSING');
    expect(nb.data.error.correlationId).toMatch(/^mcp-/);
    expect(m.s.rev()).toBe(rev + 2);
    expect(mem.writes).toEqual([]);
  });

  it('update draf ber-blok json tanpa basis -> BASIS_MISSING (MCP mewajibkan basis; CLI memakai terkini)', async () => {
    const m = studioMock();
    const { call: c1 } = await connect({ fetch: m.f });
    const tpl = await c1('studio_report_template', { mission: '2026-11-01_mcp01', docKey: 'lapkerja-mcp01-j', format: 'json' });
    const json = (tpl.data.template as string).replace(/<isi: [^>]*>/g, 'x');
    const r = await c1('studio_report_update', { documentId: DOC, markdown: json });
    expect(r.isError).toBeFalsy(); // IMPL-W3: dapat diperbaiki = hasil normal
    expect(r.data.ok).toBe(false);
    expect(r.data.error.code).toBe('BASIS_MISSING');
    expect(m.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('BASE_CONFLICT: code + cid; refresh teks -> markdown gabungan tanpa tulis; write=true dengan teks ditolak', async () => {
    const m = studioMock();
    const mem = memNodeFs();
    const { call } = await connect({ fetch: m.f, nfs: mem.nfs });
    const b = await call('studio_report_update', { documentId: DOC, markdown: MD({ bab3: ['Bukti versi B.'] }), agentId: 'cod-mcp-01-b' });
    expect(b.isError).toBeFalsy();
    const a = await call('studio_report_update', { documentId: DOC, markdown: MD({ bab3: ['Bukti versi A.'] }), agentId: 'cod-mcp-01' });
    expect(a.data.error.code).toBe('BASE_CONFLICT');
    expect(a.data.error.details.conflicts).toEqual(['bab 3']);
    const r = await call('studio_report_refresh', { documentId: DOC, markdown: MD({ bab3: ['Bukti versi A.'] }), agentId: 'cod-mcp-01' });
    expect(r.isError).toBeFalsy();
    expect(r.data.conflicts).toEqual(['bab 3']);
    expect(r.data.markdown).toContain('<<<<<<<');
    expect(r.data.markdown).toContain(`basis: ${DOC}@rev${m.s.rev()}`);
    expect(r.data.written).toBeNull();
    const w = await call('studio_report_refresh', { documentId: DOC, markdown: MD(), write: true });
    expect(w.data.error.code).toBe('INVALID_ARGUMENT');
    expect(mem.writes).toEqual([]);
    expect(m.calls.filter((c) => c.method === 'POST' && !c.url.endsWith('/render')).length).toBe(1);
  });

  it('refresh path + write=true + overwrite: cadangan lalu satu tulis; outPath di luar akar -> PATH_OUTSIDE_ROOTS tanpa jaringan', async () => {
    const m = studioMock();
    const file = path.join(ROOT, 'laporan.md');
    const mem = memNodeFs({ [file]: MD() });
    const { call } = await connect({ fetch: m.f, nfs: mem.nfs });
    const r = await call('studio_report_refresh', { documentId: DOC, path: file, write: true, overwrite: true });
    expect(r.isError).toBeFalsy();
    expect(r.data.written).toBe(file);
    expect(r.data.backup).toMatch(/laporan\.md\.bak-\d{8}T\d{6}Z$/);
    expect(mem.writes).toEqual([`copy ${r.data.backup}`, `atomic ${file}`]);
    m.calls.length = 0;
    const o = await call('studio_report_refresh', { documentId: DOC, path: file, outPath: path.join(OUTSIDE, 'x.md') });
    expect(o.data.error.code).toBe('PATH_OUTSIDE_ROOTS');
    expect(m.calls).toHaveLength(0);
    const rel = await call('studio_report_check', { path: 'laporan.md', remote: false });
    expect(rel.data.error.code).toBe('PATH_INVALID');
    const esc = await call('studio_report_check', { path: path.join(ROOT, '..', 'di-luar-akar', 'a.md'), remote: false });
    expect(esc.data.error.code).toBe('PATH_OUTSIDE_ROOTS');
    expect(mem.writes).toHaveLength(2);
  });
});

describe('alat baca langsung (R03, R21, R22, R05/R20, R17, R10)', () => {
  it('registry contracts: contoh disaring bawaan, templat hanya bila includeTemplate (MCP-D1)', async () => {
    const m = studioMock({
      'GET /api/studio/registry': (c) => ({ status: 200, body: { kind: new URL(c.url).searchParams.get('kind'), count: 1, items: [{ kind: 'agentWorkReport', templateSlug: 'lapkerja', statuses: [{ code: 'draft' }], verdicts: [{ code: 'PASS' }], itemStatuses: [{ code: 'done' }], outline: [{ chapterKey: '1', title: 'Ringkasan', required: true }], examples: { big: 1 } }], meta: { kinds: ['agentWorkReport'] } } }),
    });
    const { call } = await connect({ fetch: m.f });
    const r = await call('studio_registry', {});
    expect(m.calls[0].url).toBe(`${BASE}/api/studio/registry?kind=contracts`);
    expect(r.data.items[0].examples).toBeUndefined();
    expect(r.data.template).toBeUndefined();
    expect(r.text).toContain('studio_report_template');
    expect(r.text).toContain('agentWorkReport');
    const t = await call('studio_registry', { includeTemplate: true });
    expect(t.data.template).toContain('## Ringkasan');
    const e = await call('studio_registry', { includeExamples: true, includeTemplate: false });
    expect(e.data.items[0].examples).toEqual({ big: 1 });
    expect(e.data.template).toBeUndefined();
  });

  it('contracts_query dan search: parameter kueri dirakit benar', async () => {
    const m = studioMock({
      'GET /api/studio/contracts': () => ({ status: 200, body: { contracts: [{ documentId: DOC, docNumber: '040', status: 'complete', owner: 'cod-mcp-01', revisionNo: 3, completeness: { status: 'COMPLETE' }, title: 'Lap' }], nextCursor: null } }),
      'GET /api/studio/search': () => ({ status: 200, body: { hits: [{ documentId: DOC, docNumber: '040', address: '1.1.1', snippet: 'kata [[cocok]]' }], nextCursor: 'c2', query: { q: 'cocok', config: 'simple' } } }),
    });
    const { call } = await connect({ fetch: m.f });
    const q = await call('studio_contracts_query', { mission: '2026-11-01_mcp01', status: ['complete', 'partial'], includeArchived: true, take: 5 });
    const qu = new URL(m.calls[0].url);
    expect(Object.fromEntries(qu.searchParams)).toEqual({ mission: '2026-11-01_mcp01', status: 'complete,partial', take: '5', includeArchived: '1' });
    expect(q.data.contracts).toHaveLength(1);
    expect(q.text).toContain(DOC);
    const s = await call('studio_search', { q: 'cocok', documentId: 'cmvvdoc0000000000000r3f2a1', revisionNo: 2 });
    expect(new URL(m.calls[1].url).searchParams.get('revisionNo')).toBe('2');
    expect(s.data.nextCursor).toBe('c2');
    const bad = await call('studio_search', { q: 'cocok', revisionNo: 2 });
    expect(bad.data.error.code).toBe('INVALID_ARGUMENT');
  });

  it('document_get: summary tanpa tree bawaan; content R20 dengan slot/bab', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f });
    const s = await call('studio_document_get', { documentId: DOC, view: 'summary' });
    expect(s.data.tree).toBeUndefined();
    expect(s.data.completeness.status).toBe('COMPLETE');
    const t = await call('studio_document_get', { documentId: DOC, view: 'summary', includeTree: true });
    expect(t.data.tree).toEqual({ big: true });
    const c = await call('studio_document_get', { documentId: DOC });
    expect(c.data.content.sections.record).toBeDefined();
    expect(c.data.revisionNo).toBe(6);
  });

  it('render: badan R17 dirakit (agentId bawaan), keluaran ringkas; key untuk document ditolak', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, config: { defaultAgentId: 'cod-mcp-01' } });
    const r = await call('studio_render', { documentId: DOC });
    expect(m.calls[0].body).toEqual({ scope: 'document', agentId: 'cod-mcp-01' });
    expect(r.data.outputs[0]).toMatchObject({ id: FILE, finalFileName: FINAL, sha256: SHA });
    const bad = await call('studio_render', { documentId: DOC, key: '1' });
    expect(bad.data.error.code).toBe('INVALID_ARGUMENT');
  });

  it('file_verify: HEAD saja tanpa downloadDir (nol tulis); dengan downloadDir: unduh, sha cocok, satu tulis', async () => {
    const m = studioMock({ ['HEAD /api/studio/files/' + FILE]: () => ({ status: 200, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256-verified': 'true', 'x-studio-sha256': SHA } }) });
    const mem = memNodeFs();
    const { call } = await connect({ fetch: m.f, nfs: mem.nfs });
    const v = await call('studio_file_verify', { fileId: FILE });
    expect(v.data).toMatchObject({ verified: true, finalFileName: FINAL, finalNameValid: true, savedTo: null, sha256: SHA });
    expect(m.calls.map((c) => `${c.method} ${new URL(c.url).search}`)).toEqual(['HEAD ?verify=1']);
    expect(mem.writes).toEqual([]);
    const dir = path.join(ROOT, 'unduhan');
    const d = await call('studio_file_verify', { fileId: FILE, downloadDir: dir, expectedSha256: SHA });
    expect(d.data.savedTo).toBe(path.join(dir, FINAL));
    expect(d.data.bytes).toBe(HTML.length);
    expect(mem.writes).toEqual([`mkdir ${dir}`, `wx ${path.join(dir, FINAL)}`]);
    const out = await call('studio_file_verify', { fileId: FILE, downloadDir: OUTSIDE });
    expect(out.data.error.code).toBe('PATH_OUTSIDE_ROOTS');
  });

  it('file_verify: verified=false -> VERIFY_FAILED dengan cid server; nama di luar C51 tidak diunduh', async () => {
    let verified = 'false';
    let name = FINAL;
    const m = studioMock({ ['HEAD /api/studio/files/' + FILE]: () => ({ status: 200, headers: { 'x-studio-final-filename': name, 'x-studio-sha256-verified': verified, 'x-studio-sha256': SHA, 'x-correlation-id': 'cid-verify-1' } }) });
    const mem = memNodeFs();
    const { call } = await connect({ fetch: m.f, nfs: mem.nfs });
    const v = await call('studio_file_verify', { fileId: FILE });
    expect(v.data.error).toMatchObject({ code: 'VERIFY_FAILED', correlationId: 'cid-verify-1', correlationSource: 'server' });
    verified = 'true';
    name = '../../jahat.html';
    const n = await call('studio_file_verify', { fileId: FILE, downloadDir: path.join(ROOT, 'u') });
    expect(n.data.error.code).toBe('OUT_NAME_UNSAFE');
    expect(m.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    expect(mem.writes).toEqual([]);
  });

  it('draft_check: lokal tanpa jaringan; remote lewat R08', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f });
    const tpl = await call('studio_report_template', { mission: '2026-11-01_mcp01', docKey: 'lapkerja-mcp01-d', format: 'json' });
    const draft = tpl.data.template as string;
    const l = await call('studio_draft_check', { markdown: draft, remote: false });
    expect(l.isError).toBeFalsy();
    expect(typeof l.data.valid).toBe('boolean');
    expect(m.calls).toHaveLength(0);
    const r = await call('studio_draft_check', { markdown: draft });
    expect(r.data.remote).toBe(true);
    expect(m.calls.some((c) => c.url.endsWith('/api/studio/validate'))).toBe(true);
  });
});

describe('galat server, rahasia, pagar jaringan', () => {
  it('401 -> REMOTE_UNAUTHORIZED; 409 -> code server + cid; jaringan mati -> REMOTE_UNREACHABLE', async () => {
    const m = studioMock({
      'GET /api/studio/contracts': () => ({ status: 401, body: { error: 'unauthorized' }, headers: { 'x-correlation-id': 'cid-401' } }),
      'POST /api/studio/documents/x1/render': () => ({ status: 409, body: { error: 'belum lengkap', code: 'DOCUMENT_INCOMPLETE', details: { allowedScopes: ['chapter'] } }, headers: { 'x-correlation-id': 'cid-409' } }),
    });
    const { call } = await connect({ fetch: m.f });
    const a = await call('studio_contracts_query', {});
    expect(a.data.error).toMatchObject({ code: 'REMOTE_UNAUTHORIZED', httpStatus: 401, correlationId: 'cid-401' });
    const b = await call('studio_render', { documentId: 'x1' });
    expect(b.data.error).toMatchObject({ code: 'DOCUMENT_INCOMPLETE', httpStatus: 409, correlationId: 'cid-409', details: { allowedScopes: ['chapter'] } });
    expect(b.text).toContain('cid-409');
    const down = await connect({ fetch: async () => Promise.reject(new Error('ECONNREFUSED')) });
    const c = await down.call('studio_search', { q: 'apa saja' });
    expect(c.data.error.code).toBe('REMOTE_UNREACHABLE');
  });

  it('rahasia tidak pernah muncul di hasil alat maupun log, walau server memantulkannya; header hanya x-internal-secret', async () => {
    const m = studioMock({
      'GET /api/studio/search': () => ({ status: 400, body: { error: `nilai buruk ${SECRET}`, code: 'SCHEMA_INVALID', details: [{ pointer: '/query/q', message: SECRET }] } }),
    });
    const mem = memNodeFs();
    const { call, outputs } = await connect({ fetch: m.f, nfs: mem.nfs });
    await call('studio_report_template', {});
    await call('studio_report_check', { markdown: NEW_MD });
    await call('studio_report_submit', { markdown: NEW_MD });
    await call('studio_search', { q: 'apa saja' });
    await call('studio_document_get', { documentId: DOC });
    await call('studio_report_update', { documentId: DOC, markdown: MD({ basis: null }) });
    const all = [...outputs, ...logs].join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).toContain('[RAHASIA-DISENSOR]');
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(() => JSON.parse(l)).not.toThrow();
    for (const c of m.calls) {
      expect(c.headers['x-internal-secret']).toBe(SECRET);
      expect(c.redirect).toBe('manual');
      expect(new URL(c.url).origin).toBe(BASE);
      expect(JSON.stringify(c.body ?? {})).not.toContain(SECRET);
    }
    expect(mem.writes).toEqual([]);
  });

  it('SECRET_MISSING untuk alat ber-server bila rahasia kosong (tanpa jaringan)', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f, config: { secret: '' } });
    const r = await call('studio_search', { q: 'apa saja' });
    expect(r.data.error.code).toBe('SECRET_MISSING');
    const s = await call('studio_report_submit', { markdown: NEW_MD });
    expect(s.data.error.code).toBe('SECRET_MISSING');
    expect(m.calls).toHaveLength(0);
  });

  it('draft_check remote: 302 tidak diikuti (satu panggilan, galat), rahasia tidak ke host lain', async () => {
    const m = studioMock({ 'POST /api/studio/validate': () => ({ status: 302, headers: { location: 'http://evil.example/steal' } }) });
    const { call } = await connect({ fetch: m.f });
    const tpl = await call('studio_report_template', { mission: '2026-11-01_mcp01', docKey: 'lapkerja-mcp01-r', format: 'json' });
    const r = await call('studio_draft_check', { markdown: (tpl.data.template as string).replace(/<isi: [^>]*>/g, 'x') });
    const validates = m.calls.filter((c) => c.url.endsWith('/validate'));
    expect(validates.every((c) => c.redirect === 'manual')).toBe(true);
    expect(m.calls.every((c) => new URL(c.url).origin === BASE)).toBe(true);
    expect(r.isError).toBe(true); // REMOTE_REDIRECT = kegagalan nyata
    expect(r.data.error.code).toBe('REMOTE_ERROR');
    expect(validates).toHaveLength(1);
  });

  it('guardedFetch menolak asal lain dan memaksa redirect manual', async () => {
    const seen: string[] = [];
    const g = guardedFetch(BASE, async (url, init) => {
      seen.push(`${url} ${init.redirect}`);
      return reply({ status: 200 });
    });
    await g(`${BASE}/api/x`, { method: 'GET', headers: {}, redirect: 'follow' });
    await expect(g('http://evil.example/api/x', { method: 'GET', headers: {}, redirect: 'manual' })).rejects.toThrow(/ditolak/);
    await expect(g('http://127.0.0.1:9022/api/x', { method: 'GET', headers: {}, redirect: 'manual' })).rejects.toThrow(/ditolak/);
    expect(seen).toEqual([`${BASE}/api/x manual`]);
  });

  it('redactSecret dan resolveAllowedPath', () => {
    expect(redactSecret(`a ${SECRET} b ${SECRET}`, SECRET)).toBe('a [RAHASIA-DISENSOR] b [RAHASIA-DISENSOR]');
    expect(redactSecret('abc', '')).toBe('abc');
    const mem = memNodeFs({ [path.join(ROOT, 'a.md')]: 'x', [path.join(ROOT, 'a.exe')]: 'x' });
    expect(resolveAllowedPath(path.join(ROOT, 'a.md'), [ROOT], 'read-report', mem.nfs)).toBe(path.join(ROOT, 'a.md'));
    expect(() => resolveAllowedPath(path.join(ROOT, 'a.exe'), [ROOT], 'read-report', mem.nfs)).toThrow(/hanya berkas/);
    expect(() => resolveAllowedPath(path.join(ROOT, 'a.md'), [ROOT], 'read-report', mem.nfs, 0)).toThrow(/melebihi/);
    expect(() => resolveAllowedPath(`${ROOT}\u0000x`, [ROOT], 'read-report', mem.nfs)).toThrow(/NUL/);
    expect(() => resolveAllowedPath(path.join(ROOT, 'x.txt'), [ROOT], 'write-report', mem.nfs)).toThrow(/\.md/);
  });

  it('konfigurasi: bawaan 127.0.0.1:9021, akar baca = cwd (tulis nonaktif), URL/akar relatif ditolak', () => {
    // row42 ADAPT A9 (row 107 M1; mcp/config.ts:108-112): no cwd root default any more; empty roots are refused, and an
    // explicit root enables writes (the host always passes one). Other defaults unchanged.
    expect(() => loadConfig({}, ROOT)).toThrow(/STUDIO_MCP_FILE_ROOTS/);
    const c = loadConfig({ STUDIO_MCP_FILE_ROOTS: ROOT }, ROOT);
    expect(c).toMatchObject({ baseUrl: 'http://127.0.0.1:9021', secret: '', defaultAgentId: null, fileRoots: [ROOT], fileWriteEnabled: true });
    expect(() => loadConfig({ STUDIO_MCP_FILE_ROOTS: ROOT, STUDIO_BASE_URL: 'ftp://x' }, ROOT)).toThrow(/http/);
    expect(() => loadConfig({ STUDIO_MCP_FILE_ROOTS: 'relatif' }, ROOT)).toThrow(/absolut/);
    expect(TOOLS).toHaveLength(24); // IMPL-W: +studio_write, +studio_edit (toolset write)
  });
});
