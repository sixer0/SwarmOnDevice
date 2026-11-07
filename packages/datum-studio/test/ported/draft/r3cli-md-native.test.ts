// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/r3cli-md-native.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// R3-01 (D-435; U-15, U-16, U-18): studio-report menerima laporan kerja Markdown biasa (tanpa blok
// ```json), mengubahnya lewat generator I64 `markdownToContract` menjadi blok kiriman yang sama dengan
// draf ber-blok json, update delta hanya mengirim bagian yang berubah, dan `template` mencetak templat
// siap diisi. Server di-mock; fs di-mock (nol tulis berkas).
import { describe, it, expect } from '../_vitest';
import { createHash } from 'node:crypto';
import { checkDraftLocal } from '../../../vendor/scripts/studio/draft-check';
import { detectFormat, main, prepareInput, type FsLike, type HttpFetch } from '../../../vendor/scripts/studio/studio-report';
import { blocksToDraftMarkdown, mdReportToBlocks, reportTemplate, stripToolKeys } from '../../../vendor/src/lib/studio/services/draft/md-report';
import { markdownToContract } from '../../../vendor/src/lib/studio/services/import/contract';

const SECRET = 'rahasia-uji-r3cli-jangan-tercetak';
const DOC = 'cmvvdoc0000000000000000r31';
const FILE = 'cmvvfile00000000000000r31';
const MISSION = '2026-10-31_r3cli';
const DOC_KEY = 'lapkerja-r3-uji';
const HTML = Buffer.from('<html><body>laporan</body></html>', 'utf8');
const SHA = createHash('sha256').update(HTML).digest('hex');
const FINAL = `030-GSP-LAP-X-2026_rev6_20261031T120000Z_${SHA.slice(0, 8)}.html`;

/** Laporan MD-native minimal (kepala + 5 bab outline). */
const MD = (o: { status?: string | null; bab3?: string; mission?: boolean } = {}) =>
  [
    '# Laporan uji R3',
    '',
    ...(o.mission === false ? [] : [`mission: ${MISSION}`, `docKey: ${DOC_KEY}`]),
    ...(o.status === null ? [] : [`Status: ${o.status ?? 'partial'}`]),
    'Owner: cod-r3-01',
    'ReportedAt: 2026-10-31T10:00+07:00',
    '',
    '## Ringkasan',
    '',
    'Ringkasan satu.',
    '',
    '## Rincian kerja',
    '',
    '| key | judul | status |',
    '|---|---|---|',
    '| t_249c6b84 | Tulis bab | done |',
    '',
    '## Bukti',
    '',
    o.bab3 ?? 'Bukti satu.',
    '',
    '## Isu terbuka',
    '',
    'Tidak ada.',
    '',
    '## Langkah berikut',
    '',
    '- Lanjut.',
    '',
  ].join('\n');

/** Draf ber-blok json berisi konten SETARA dengan {@link MD} (ditulis tangan, bukan dari konverter). */
function equivalentJsonDraft(status = 'partial'): string {
  const target = { mission: { folder: MISSION }, docKey: DOC_KEY };
  const ch = (key: string, title: string, blocks: unknown[], intro?: unknown[]) => ({
    $schema: 'studio.chapter/v2',
    target,
    chapter: { key, title: { text: title }, ...(intro ? { intro } : {}), sections: [{ title: { text: title }, blocks }] },
  });
  const p = (text: string) => ({ type: 'paragraph', text });
  const blocks = [
    {
      $schema: 'studio.slot/v2',
      target,
      template: { slug: 'laporan-kerja-agen' },
      meta: { title: 'Laporan uji R3' },
      slot: 'record',
      payload: {
        type: 'contractRecord',
        status,
        owner: 'cod-r3-01',
        reportedAt: '2026-10-31T10:00+07:00',
        cardIds: ['t_249c6b84'],
        items: [{ key: 't_249c6b84', title: { text: 'Tulis bab' }, status: 'done' }],
      },
    },
    ch('1', 'Ringkasan', [p('Ringkasan satu.')]),
    ch('2', 'Rincian kerja', [
      {
        type: 'table',
        columns: [{ role: 'text' }, { role: 'text' }, { role: 'text' }],
        rows: [
          { kind: 'header', cells: [{ text: 'key' }, { text: 'judul' }, { text: 'status' }] },
          { kind: 'body', cells: [{ text: 't_249c6b84' }, { text: 'Tulis bab' }, { text: 'done' }] },
        ],
      },
    ]),
    ch('3', 'Bukti', [p('Bukti satu.')]),
    ch('4', 'Isu terbuka', [p('Tidak ada.')]),
    ch('5', 'Langkah berikut', [{ type: 'list', items: [{ text: 'Lanjut.' }] }]),
  ];
  return `# Laporan uji R3\ntujuan: t\nlangkah-berikut: l\nbasis: baru\n\n${blocks.map((b) => `\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`).join('\n')}`;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeServer(opts: { base?: unknown } = {}) {
  const calls: Call[] = [];
  let rev = opts.base ? 6 : 0;
  const f: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const c: Call = { method: init.method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    let res: { status: number; body?: unknown; bytes?: Buffer; headers?: Record<string, string> } = { status: 404, body: { error: 'x', code: 'NOT_FOUND' } };
    if (c.method === 'POST' && (c.path === '/api/studio/slots' || c.path === '/api/studio/chapters')) {
      rev++;
      res = { status: 201, body: { document: { id: DOC, docNumber: '030/GSP/LAP/X/2026' }, created: rev === 1, unchanged: false, revision: { revisionNo: rev } } };
    } else if (c.method === 'GET' && c.path === `/api/studio/documents/${DOC}/content`) {
      res = { status: 200, body: { document: { id: DOC, docNumber: '030/GSP/LAP/X/2026' }, revisionNo: 6, content: opts.base } };
    } else if (c.path === `/api/studio/documents/${DOC}/completeness`) {
      res = { status: 200, body: { completeness: { status: 'COMPLETE', missingRequired: [] } } };
    } else if (c.path === `/api/studio/documents/${DOC}/render`) {
      res = { status: 200, body: { job: { revisionNo: rev }, outputs: [{ id: FILE, role: 'PRIMARY', format: 'HTML', scope: { kind: 'DOCUMENT' }, sha256: SHA, finalFileName: FINAL }] } };
    } else if (c.method === 'GET' && c.path === `/api/studio/files/${FILE}`) {
      res = { status: 200, bytes: HTML, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256': SHA } };
    } else if (c.method === 'HEAD') {
      res = { status: 200, headers: { 'x-studio-final-filename': FINAL, 'x-studio-sha256-verified': 'true' } };
    }
    const h = new Map(Object.entries({ 'x-correlation-id': `cid-${calls.length}`, ...(res.headers ?? {}) }));
    return {
      status: res.status,
      headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
      text: async () => (res.body === undefined ? '' : JSON.stringify(res.body)),
      arrayBuffer: async () => {
        const b = res.bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
  return { f, calls, posts: () => calls.filter((c) => c.method === 'POST' && !c.path.endsWith('/render')) };
}

function memFs(files: Record<string, string>) {
  const writes: string[] = [];
  const fsx: FsLike = {
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return files[p];
    },
    readFileSyncBuffer: (p) => Buffer.from(fsx.readFileSync(p, 'utf8'), 'utf8'),
    appendFileSync: (p) => void writes.push(`append ${p}`),
    mkdirSync: (p) => void writes.push(`mkdir ${p}`),
    writeFileSync: (p) => void writes.push(`write ${p}`),
  };
  return { fsx, writes };
}

async function run(argv: string[], o: { fetch?: HttpFetch; fs?: FsLike } = {}) {
  let out = '';
  let err = '';
  let t = 1_793_424_000_000;
  const code = await main(argv, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    env: { INTERNAL_API_SECRET: SECRET },
    fetchImpl: o.fetch ?? (async () => Promise.reject(new Error('tidak boleh dipanggil'))),
    fs: o.fs,
    now: () => (t += 25),
  });
  return { code, out, err };
}

/** Basis R20 hasil konversi MD (pid `id` disisipkan seperti proyeksi server; `sameContent` mengabaikannya). */
function baseFrom(md: string): unknown {
  const { blocks } = mdReportToBlocks(md, { mode: 'create' });
  const withIds = (v: unknown, n = { i: 0 }): unknown =>
    Array.isArray(v) ? v.map((x) => withIds(x, n)) : v && typeof v === 'object' ? { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withIds(x, n)])), ...('type' in v || 'key' in v ? { id: `p${++n.i}` } : {}) } : v;
  const record = (blocks[0] as { payload: unknown }).payload;
  const chapters = blocks.slice(1).map((b) => withIds((b as { chapter: unknown }).chapter));
  return { sections: { record, content: { type: 'chapter', chapters } } };
}

describe('U-15 konversi MD-native', () => {
  it('payload kiriman MD = payload draf json setara (record + bab 1..5), target bab = documentId baru', async () => {
    const a = fakeServer();
    const ra = await run(['submit', 'l.md', '--remote', 'http://h', '--agent-id', 'cod-r3-01'], { fetch: a.f, fs: memFs({ 'l.md': MD() }).fsx });
    const b = fakeServer();
    const rb = await run(['submit', 'd.md', '--remote', 'http://h', '--agent-id', 'cod-r3-01'], { fetch: b.f, fs: memFs({ 'd.md': equivalentJsonDraft() }).fsx });
    expect([ra.code, rb.code]).toEqual([0, 0]);
    expect(a.posts().map((c) => c.path)).toEqual(['/api/studio/slots', ...Array(5).fill('/api/studio/chapters')]);
    expect(a.posts().map((c) => c.body)).toEqual(b.posts().map((c) => c.body));
    expect((a.posts()[1].body as { target: unknown }).target).toEqual({ documentId: DOC });
    expect(ra.out).toContain('konversi MD: record, bab 1, bab 2, bab 3, bab 4, bab 5');
  });

  it('format: deteksi otomatis (json bila ada blok ber-$schema studio.*), --format memaksa', () => {
    expect(detectFormat(MD())).toBe('md');
    expect(detectFormat(equivalentJsonDraft())).toBe('json');
    expect(detectFormat(`${MD()}\n\`\`\`json\n{"a":1}\n\`\`\`\n`)).toBe('md');
    const forced = prepareInput({ command: 'submit', documentId: null, format: 'md', mission: null, docKey: null }, MD(), 10);
    expect(forced.format).toBe('md');
    expect(checkDraftLocal(forced.draft).valid).toBe(true);
  });

  it('kunci alat (mission/docKey/agentId) tidak masuk isi; label registri dan nama medan CF dikenali; judul outline -> bab 1..5 tanpa peringatan', () => {
    const md = MD().replace('Owner: cod-r3-01', 'Penanggung jawab: cod-r3-01\nagentId: penulis-r3').replace('ReportedAt:', 'Waktu lapor:');
    const { blocks, conversion } = mdReportToBlocks(md, { mode: 'create' });
    expect(conversion.warnings).toEqual([]);
    expect(conversion.missingChapters).toEqual([]);
    expect(conversion.agentId).toBe('penulis-r3');
    const rec = blocks[0] as { agentId: string; payload: Record<string, unknown> };
    expect(rec.agentId).toBe('penulis-r3');
    expect(rec.payload).toMatchObject({ status: 'partial', owner: 'cod-r3-01', reportedAt: '2026-10-31T10:00+07:00' });
    expect(JSON.stringify(blocks)).not.toMatch(/docKey: |mission: |agentId: /);
    expect(stripToolKeys(md).tool).toMatchObject({ mission: MISSION, docKey: DOC_KEY, agentId: 'penulis-r3' });
  });

  it('keluaran md2contract tanpa extraAliases tidak berubah (judul outline tetap CW-03)', () => {
    const r = markdownToContract(MD().replace('ReportedAt:', 'Date:'), { kind: 'agentWorkReport' });
    expect(() => markdownToContract(MD(), { kind: 'agentWorkReport' })).toThrow(/reportedAt/); // nama medan CF hanya lewat extraAliases
    expect(r.report.warnings.map((w) => w.code)).toContain('CONTRACT_HEADING_UNMAPPED');
  });

  it('KD-42: status hilang -> MD2CONTRACT_REQUIRED_MISSING rc 1, tanpa permintaan; status tanpa alias -> peringatan CW dicetak', async () => {
    const s = fakeServer();
    const r = await run(['submit', 'l.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'l.md': MD({ status: null }) }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain('MD2CONTRACT_REQUIRED_MISSING');
    expect(r.err).toContain('Status:');
    expect(s.calls).toHaveLength(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, exitCode: 1, fatal: { code: 'MD2CONTRACT_REQUIRED_MISSING', details: { missing: ['status'] } } });
    const u = await run(['submit', 'l.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 'l.md': MD({ status: 'selesai-semua' }) }).fsx });
    expect(u.code).toBe(1);
    expect(u.err).toContain('CONTRACT_STATUS_UNMAPPED');
    expect(s.calls).toHaveLength(0);
  });

  it('submit tanpa mission/docKey -> MD_REPORT_TARGET_MISSING rc 1 tanpa permintaan; --mission + --doc-key mengisinya', async () => {
    const s = fakeServer();
    const r = await run(['submit', 'l.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 'l.md': MD({ mission: false }) }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain('MD_REPORT_TARGET_MISSING');
    expect(s.calls).toHaveLength(0);
    const ok = await run(['submit', 'l.md', '--remote', 'http://h', '--mission', MISSION, '--doc-key', DOC_KEY], { fetch: s.f, fs: memFs({ 'l.md': MD({ mission: false }) }).fsx });
    expect(ok.code).toBe(0);
    expect((s.posts()[0].body as { target: unknown }).target).toEqual({ mission: { folder: MISSION }, docKey: DOC_KEY });
  });

  it('nol berkas tulis tanpa --out/--timing', async () => {
    const { fsx, writes } = memFs({ 'l.md': MD() });
    expect((await run(['submit', 'l.md', '--remote', 'http://h'], { fetch: fakeServer().f, fs: fsx })).code).toBe(0);
    expect(writes).toEqual([]);
  });
});

describe('U-16 update delta', () => {
  it('hanya record yang berubah dikirim (status disunting), baseRevisionNo otomatis, ringkasan dikirim vs tidak berubah', async () => {
    const s = fakeServer({ base: baseFrom(MD()) });
    const r = await run(['update', DOC, 'l.md', '--remote', 'http://h', '--base-rev', '6', '--json'], { fetch: s.f, fs: memFs({ 'l.md': MD({ status: 'complete' }) }).fsx });
    expect(r.code).toBe(0);
    expect(s.posts().map((c) => c.path)).toEqual(['/api/studio/slots']);
    expect(s.posts()[0].body).toMatchObject({ target: { documentId: DOC }, baseRevisionNo: 6, slot: 'record', payload: { status: 'complete' } });
    expect(s.posts()[0].body).not.toHaveProperty('meta'); // update MD: meta/template tidak dikirim (tanpa META_CONFLICT judul)
    const j = JSON.parse(r.out);
    expect(j.delta).toEqual({ sent: ['record'], unchanged: ['bab 1', 'bab 2', 'bab 3', 'bab 4', 'bab 5'], excluded: [] });
    expect(j.format).toBe('md');
  });

  it('satu paragraf bab 3 disunting -> hanya bab 3 dikirim; tanpa perubahan -> tidak ada kiriman', async () => {
    const s = fakeServer({ base: baseFrom(MD()) });
    const r = await run(['update', DOC, 'l.md', '--remote', 'http://h', '--base-rev', '6'], { fetch: s.f, fs: memFs({ 'l.md': MD({ bab3: 'Bukti dua (disunting).' }) }).fsx });
    expect(r.code).toBe(0);
    expect(s.posts().map((c) => (c.body as { chapter?: { key: string } }).chapter?.key)).toEqual(['3']);
    expect(r.out).toContain('dikirim: bab 3');
    const n = fakeServer({ base: baseFrom(MD()) });
    const r0 = await run(['update', DOC, 'l.md', '--remote', 'http://h', '--base-rev', '6'], { fetch: n.f, fs: memFs({ 'l.md': MD() }).fsx });
    expect(r0.code).toBe(0);
    expect(n.posts()).toHaveLength(0);
    expect(r0.out).toContain('dikirim: tidak ada');
  });

  it('--section 3 mengirim hanya bab 3 walau sama; --section tak dikenal -> SECTION_UNKNOWN rc 2 tanpa kiriman', async () => {
    const s = fakeServer({ base: baseFrom(MD()) });
    const r = await run(['update', DOC, 'l.md', '--remote', 'http://h', '--base-rev', '6', '--section', '3', '--json'], { fetch: s.f, fs: memFs({ 'l.md': MD({ status: 'complete' }) }).fsx });
    expect(r.code).toBe(0);
    expect(s.posts().map((c) => c.path)).toEqual(['/api/studio/chapters']);
    expect(JSON.parse(r.out).delta).toEqual({ sent: ['bab 3'], unchanged: [], excluded: ['record', 'bab 1', 'bab 2', 'bab 4', 'bab 5'] });
    const bad = fakeServer({ base: baseFrom(MD()) });
    const rb = await run(['update', DOC, 'l.md', '--remote', 'http://h', '--base-rev', '6', '--section', '9'], { fetch: bad.f, fs: memFs({ 'l.md': MD() }).fsx });
    expect(rb.code).toBe(2);
    expect(rb.err).toContain('SECTION_UNKNOWN');
    expect(bad.posts()).toHaveLength(0);
    expect((await run(['submit', 'l.md', '--section', '3'])).code).toBe(2);
  });
});

/** R3-F #2 (D-439): templat berisi placeholder `<isi: ...>`; isi seperti agen (baris kepala, butir, isi bab; Rujukan dihapus). */
function fillTemplate(t: string): string {
  const out: string[] = [];
  let skip = false;
  for (const l of t.split('\n')) {
    if (l.startsWith('## Rujukan')) skip = true;
    else if (skip && l.startsWith('## ')) skip = false;
    if (skip || l.startsWith('Initiator:')) continue;
    if (l.startsWith('# ')) out.push('# Laporan uji templat');
    else if (l.startsWith('Status:')) out.push('Status: partial');
    else if (l.startsWith('Owner:')) out.push('Owner: cod-r3-01');
    else if (l.startsWith('TaskRef:')) out.push('TaskRef: R3-01');
    else if (l.startsWith('ReportedAt:')) out.push('ReportedAt: 2026-10-31T10:00+07:00');
    else if (l.startsWith('| <isi:')) out.push('| t_249c6b84 | Tulis bab | done | cod-r3-01 | out/bab.json 10 B |');
    else if (l.startsWith('<isi:')) out.push('Isi bab.');
    else out.push(l);
  }
  return out.join('\n');
}

describe('U-18 template', () => {
  it('md: kepala + 5 judul bab wajib; diisi misi/docKey -> konversi tanpa peringatan dan lolos draft-check lokal', async () => {
    const r = await run(['template', '--mission', MISSION, '--doc-key', DOC_KEY]);
    expect(r.code).toBe(0);
    for (const h of ['## Ringkasan', '## Rincian kerja', '## Bukti', '## Isu terbuka', '## Langkah berikut']) expect(r.out).toContain(h);
    expect(r.out).toContain(`mission: ${MISSION}`);
    expect(r.out).not.toMatch(/cmv[a-z0-9]{20,}/); // tanpa ID dokumen nyata
    // R3-F #2: apa adanya ditolak (placeholder); sesudah diisi lolos.
    expect(() => prepareInput({ command: 'submit', documentId: null, format: null, mission: null, docKey: null }, r.out, 1)).toThrow(/placeholder/);
    const filled = fillTemplate(r.out);
    const p = prepareInput({ command: 'submit', documentId: null, format: null, mission: null, docKey: null }, filled, Buffer.byteLength(filled));
    expect(p.format).toBe('md');
    expect(p.conversion?.warnings).toEqual([]);
    expect(p.conversion?.missingChapters).toEqual([]);
    expect(p.conversion?.parts).toEqual(['record', 'bab 1', 'bab 2', 'bab 3', 'bab 4', 'bab 5']);
    const local = checkDraftLocal(p.draft);
    expect(local.valid).toBe(true);
    expect(local.blocks).toHaveLength(6);
  });

  it('json: draf ber-blok json dari examples (placeholder, R3-F #2: ditolak sampai diisi); tanpa opsi = target contoh -> EXAMPLE_TARGET rc 2 tanpa kiriman', async () => {
    const j = await run(['template', '--format', 'json', '--mission', MISSION, '--doc-key', DOC_KEY]);
    expect(j.code).toBe(0);
    expect(detectFormat(j.out)).toBe('json');
    expect(checkDraftLocal(j.out).valid).toBe(false);
    expect(() => prepareInput({ command: 'submit', documentId: null, format: null, mission: null, docKey: null }, j.out, 1)).toThrow(/placeholder/);
    const plain = fillTemplate(reportTemplate({ format: 'md' }));
    const s = fakeServer();
    const r = await run(['submit', 't.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 't.md': plain }).fsx });
    expect(r.code).toBe(2);
    expect(r.err).toContain('EXAMPLE_TARGET');
    expect(s.calls).toHaveLength(0);
    expect((await run(['template', '--remote', 'http://h'])).code).toBe(2);
  });

  it('--help memuat aturan kunci kepala dan judul bab dari registri', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/reportedAt\s+.*waktu lapor/);
    expect(r.out).toContain('bab 4: isu terbuka');
    expect(r.out).toContain('template');
  });

  it('biaya tulis: laporan MD jauh lebih kecil dari draf json setara', () => {
    const md = fillTemplate(reportTemplate({ format: 'md', mission: MISSION, docKey: DOC_KEY }));
    const { blocks, conversion } = mdReportToBlocks(md, { mode: 'create' });
    const json = blocksToDraftMarkdown(conversion.title, blocks);
    expect(Buffer.byteLength(md)).toBeLessThan(Buffer.byteLength(json) / 2);
  });
});
