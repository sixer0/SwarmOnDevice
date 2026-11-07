// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/r3-stateful-harness.ts (see test/ported/README.md).
// Harness bersama uji R3-F2/R3-F3 (dipindah apa adanya dari r3fix2-refresh.test.ts): laporan MD-native uji,
// server tiruan BERKEADAAN (riwayat revisi, penulis terakhir per bagian, cek lingkup §9.2 -> 409), fs memori.
/* eslint-disable @typescript-eslint/no-explicit-any -- server tiruan berkeadaan memanipulasi JSON proyeksi R20 bebas bentuk */
import { createHash } from 'node:crypto';
import { main, type FsLike, type HttpFetch } from '../../../vendor/scripts/studio/studio-report';
import { mdReportToBlocks, sameStructure } from '../../../vendor/src/lib/studio/services/draft/md-report';

export const SECRET = 'rahasia-uji-r3fix2-jangan-tercetak';
export const DOC = 'cmvvdoc0000000000000r3f2a1';
export const FILE = 'cmvvfile0000000000000r3f2a';
export const MISSION = '2026-11-01_r3f2';
export const DOC_KEY = 'lapkerja-r3f2-uji';
export const A = 'cod-r3-f2';
export const B = 'cod-r3-f2-b';
export const HTML = Buffer.from('<html><body>laporan</body></html>', 'utf8');
export const SHA = createHash('sha256').update(HTML).digest('hex');
export const FINAL = `040-GSP-LAP-XI-2026_rev9_20261101T120000Z_${SHA.slice(0, 8)}.html`;

export interface MdOpts {
  basis?: string | null;
  agent?: string;
  bab1?: string;
  bab3?: string[];
  bab5?: string;
  items?: string[];
  extras?: Array<[string, string]>;
  refs?: string[];
}

export const ITEMS = ['| R3F2-1 | Reproduksi temuan | running | out/probe.txt 120 B sha 55d324b1 |', '| R3F2-2 | Uji refresh | done | out/uji.txt 64 B sha 0a1b2c3d |'];

/** Laporan MD-native: kepala + 5 bab outline (+ bab tambahan, Rujukan). */
export const MD = (o: MdOpts = {}) =>
  [
    '# Laporan uji R3-F2',
    '',
    `mission: ${MISSION}`,
    `docKey: ${DOC_KEY}`,
    ...(o.agent ? [`agentId: ${o.agent}`] : []),
    ...(o.basis === null ? [] : [`basis: ${o.basis ?? `${DOC}@rev6`}`]),
    'Status: partial',
    'Owner: cod-r3-f2',
    'ReportedAt: 2026-11-01T10:00+07:00',
    '',
    '## Ringkasan',
    '',
    o.bab1 ?? 'Ringkasan awal.',
    '',
    '## Rincian kerja',
    '',
    '| key | judul | status | bukti |',
    '|---|---|---|---|',
    ...(o.items ?? ITEMS),
    '',
    '## Bukti',
    '',
    ...(o.bab3 ?? ['Bukti awal.']),
    '',
    '## Isu terbuka',
    '',
    'Tidak ada.',
    '',
    '## Langkah berikut',
    '',
    o.bab5 ?? '- Lanjut.',
    '',
    ...(o.extras ?? []).flatMap(([h, t]) => [`## ${h}`, '', t, '']),
    ...(o.refs ? ['## Rujukan', '', '| hubungan | dokumen | paragraf | revisi |', '|---|---|---|---|', ...o.refs, ''] : []),
  ].join('\n');

/** Isi bab 3 berformat milik penulis B (run, blok kode, kutipan): sasaran N2. */
export const RICH_B = [
  'PENULIS-B: hasil uji **lulus semua** dengan `kode`, *miring*, a \\* b dan a_b.',
  '',
  '```text Keluaran uji',
  'Test Files  25 passed (25)',
  '  baris ``` di dalam',
  '```',
  '',
  '> [!DOCTRINE] Catatan B',
  '> Jangan dihapus.',
  '>',
  '> - bukan daftar',
  '',
  '| kolom | nilai |',
  '|---|---|',
  '| pipa | a\\|b |',
  '',
  'Paragraf polos B.',
];

export type Content = Record<string, any>;

/** Proyeksi R20 dari laporan MD (seperti server: pid `id` disisipkan; `sameContent` mengabaikannya). */
export function contentOf(md: string): Content {
  const { blocks, conversion } = mdReportToBlocks(md.replace(/^basis: .*$/m, ''), { mode: 'create' });
  const record = (blocks[0] as { payload: Record<string, unknown> }).payload;
  const chapters = blocks.filter((b) => b.$schema === 'studio.chapter/v2').map((b) => ({ ...(b as { chapter: Record<string, unknown> }).chapter, id: `bab-${String((b as { chapter: { key: string } }).chapter.key)}` }));
  return { meta: { title: conversion.title }, mission: { folder: MISSION }, docKey: DOC_KEY, sections: { record, content: { type: 'chapter', chapters } } };
}

export interface Call {
  method: string;
  path: string;
  body: any;
}

/**
 * Server tiruan BERKEADAAN: riwayat revisi + penulis terakhir per bagian (`agent:<agentId>`). POST slot/bab
 * menerapkan isi ke revisi terkini (revisi baru, atau `unchanged`); R15 melaporkan penulis per bagian.
 */
export function statefulServer(seedMd: string, seedRev = 6) {
  const history = new Map<number, Content>([[seedRev, contentOf(seedMd)]]);
  let rev = seedRev;
  const writers = new Map<string, { by: string; revisionNo: number }>();
  for (const k of ['record', 'bab 1', 'bab 2', 'bab 3', 'bab 4', 'bab 5']) writers.set(k, { by: `agent:${A}`, revisionNo: seedRev });
  const calls: Call[] = [];
  const latest = () => history.get(rev)!;
  const apply = (body: any): { unchanged: boolean } => {
    const next: Content = structuredClone(latest());
    let part: string;
    if (body.$schema === 'studio.slot/v2') {
      part = body.slot;
      next.sections[body.slot] = body.payload;
    } else {
      part = `bab ${body.chapter.key}`;
      const chapters: any[] = next.sections.content.chapters;
      const i = chapters.findIndex((c) => c.key === body.chapter.key);
      const ch = { ...body.chapter, id: `bab-${body.chapter.key}` };
      if (i >= 0) chapters[i] = ch;
      else chapters.push(ch);
    }
    if (sameStructure(next, latest())) return { unchanged: true };
    rev++;
    history.set(rev, next);
    writers.set(part, { by: `agent:${body.agentId ?? 'internal'}`, revisionNo: rev });
    return { unchanged: false };
  };
  const f: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const c: Call = { method: init.method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    let res: { status: number; body?: unknown; bytes?: Buffer; headers?: Record<string, string> } = { status: 404, body: { error: 'x', code: 'NOT_FOUND' } };
    const scope = c.body ? (c.body.$schema === 'studio.slot/v2' ? c.body.slot : `bab ${c.body.chapter?.key}`) : '';
    if (c.method === 'POST' && typeof c.body?.baseRevisionNo === 'number' && (writers.get(scope)?.revisionNo ?? 0) > c.body.baseRevisionNo) {
      // Cek lingkup §9.2 seperti server: bagian berubah sesudah baseRevisionNo -> 409 (siapa pun penulisnya).
      res = { status: 409, body: { error: 'scope changed', code: 'SCOPE_CONFLICT', details: { scope, baseRevisionNo: c.body.baseRevisionNo, changedInRevisionNo: writers.get(scope)?.revisionNo } } };
    } else if (c.method === 'POST' && (u.pathname === '/api/studio/slots' || u.pathname === '/api/studio/chapters')) {
      const r = apply(c.body);
      res = { status: r.unchanged ? 200 : 201, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026' }, created: false, unchanged: r.unchanged, revision: { revisionNo: rev } } };
    } else if (c.method === 'GET' && u.pathname === `/api/studio/documents/${DOC}/content`) {
      const want = u.searchParams.get('rev');
      const n = want === null ? rev : Number(want);
      res = history.has(n) ? { status: 200, body: { document: { id: DOC, docNumber: '040/GSP/LAP/XI/2026' }, revisionNo: n, content: history.get(n) } } : { status: 404, body: { error: 'x', code: 'REVISION_NOT_FOUND' } };
    } else if (u.pathname === `/api/studio/documents/${DOC}/completeness`) {
      const present = [...writers].filter(([k]) => k.startsWith('bab ')).map(([k, w]) => ({ key: k.slice(4), by: w.by, revisionNo: w.revisionNo }));
      const rw = writers.get('record');
      res = { status: 200, body: { completeness: { status: 'COMPLETE', revisionNo: rev, missingRequired: [], slots: [{ slotKey: 'record', lastFilledBy: rw?.by ?? null, lastFilledRevisionNo: rw?.revisionNo ?? null }], chapters: { content: { present } } } } };
    } else if (u.pathname === `/api/studio/documents/${DOC}/render`) {
      res = { status: 200, body: { job: { revisionNo: rev }, outputs: [{ id: FILE, role: 'PRIMARY', format: 'HTML', scope: { kind: 'DOCUMENT' }, sha256: SHA, finalFileName: FINAL }] } };
    } else if (c.method === 'GET' && u.pathname === `/api/studio/files/${FILE}`) {
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
  const chapter = (key: string) => latest().sections.content.chapters.find((c: any) => c.key === key);
  return { f, calls, latest, chapter, rev: () => rev, posts: () => calls.filter((c) => c.method === 'POST' && !c.path.endsWith('/render')), reset: () => (calls.length = 0) };
}

export function memFs(files: Record<string, string>) {
  const writes: string[] = [];
  const fsx: FsLike = {
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return files[p];
    },
    readFileSyncBuffer: (p) => Buffer.from(fsx.readFileSync(p, 'utf8'), 'utf8'),
    appendFileSync: () => undefined,
    mkdirSync: (p) => void writes.push(`mkdir ${p}`),
    writeFileSync: (p) => void writes.push(`write ${p}`),
    writeFileText: (p, d) => {
      writes.push(`text ${p}`);
      files[p] = d;
    },
  };
  return { fsx, writes, files };
}

export async function run(argv: string[], o: { fetch?: HttpFetch; fs?: FsLike } = {}) {
  let out = '';
  let err = '';
  let t = 1_793_510_400_000;
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

export const keyOf = (c: Call) => c.body.chapter?.key ?? c.body.slot;
export const textOf = (ch: any) => JSON.stringify(ch);
