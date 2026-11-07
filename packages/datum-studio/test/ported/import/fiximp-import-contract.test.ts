// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/import/fiximp-import-contract.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-IMP (D-402 L-3, D-403 DC35-F1; register 05 §16.5, KD-42).
// DC35-F1: nilai status/vonis/status butir majemuk (`PASS/FAIL`, `complete/blocked`, `done/blocked`)
// tidak lagi dipetakan ke token pertama: CW-02 `CONTRACT_STATUS_UNMAPPED` (`reason: compound`), teks
// utuh dipertahankan; status kepala wajib tanpa opsi -> MD2CONTRACT_REQUIRED_MISSING exit 3. Nilai
// tunggal ber-catatan (`FAIL (catatan)`) tetap dipetakan (D-377 butir 2).
// L-3: `PHASE_RE` kubik diganti pemindai linear `parsePhaseLine`; kesetaraan dibuktikan diferensial
// acak terhadap regex lama (oracle disalin di sini), kinerja 100 ribu karakter < 1 s.
// D-405: owner (C36) / taskRef (C35) majemuk atau tak cocok pola tidak dipotong: medan kosong + CW-04
// `CONTRACT_FIELD_UNMAPPED` (`reason: compound|pattern`), baris tetap teks bab 1.
import { describe, expect, it } from '../_vitest';
import { ContractImportError, markdownToContract } from '@/lib/studio/services/import/contract';
import { actorValueOf, aliasTokenOf, parsePhaseLine, taskRefValueOf } from '@/lib/studio/services/import/contract/parse';

type Opts = Parameters<typeof markdownToContract>[1];
const run = (md: string, o: Partial<Opts> = {}) => markdownToContract(md, { kind: 'agentWorkReport', ...o } as Opts);
const record = (x: ReturnType<typeof run>) => x.doc.sections!.record as unknown as Record<string, unknown>;
const thrown = (f: () => unknown): ContractImportError => {
  try {
    f();
  } catch (e) {
    if (e instanceof ContractImportError) return e;
    throw e;
  }
  throw new Error('tidak melempar');
};
const head = (status: string, verdict?: string) =>
  ['# L', '', `Status: ${status}`, ...(verdict !== undefined ? [`Verdict: ${verdict}`] : []), 'Date: 2026-10-30', '', '## Ringkasan', '', 'isi.', ''].join('\n');

describe('FIX-IMP DC35-F1: aliasTokenOf', () => {
  const st = (x: string) => ['complete', 'blocked', 'partial', 'draft', 'needs-review', 'partial-handoff'].includes(x.toLowerCase());
  it.each([
    ['complete', 'complete'],
    ['FAIL (satu FAIL pada CHECK 12, PASS lainnya)', 'FAIL'],
    ['FAIL(catatan)', 'FAIL'],
    ['**PASS** (x)', 'PASS'],
    ['`complete`', 'complete'],
    ['complete | Giliran: 06-10-2026 | Pekerja: gsp-data-analyst', 'complete'],
    ['needs-review | vonis FAIL 1 TINGGI', 'needs-review'],
    ['partial-handoff + resume checkpoint', 'partial-handoff'],
    ['complete - semua cek hijau', 'complete'],
    ['PASS (atau FAIL bila ...)', 'PASS'],
  ])('tunggal %j -> token %j', (v, tok) => {
    expect(aliasTokenOf(v, st)).toEqual({ token: tok, compound: false });
  });
  it.each([
    'PASS/FAIL',
    'complete/blocked',
    'todo,blocked',
    'complete|blocked|needs-review|failed',
    'complete, pending controller ratification',
    'complete/partial langsung.',
    'PASS / FAIL',
    'PASS , FAIL',
    'PASS atau FAIL',
    'PASS or FAIL',
    'PASS vs FAIL',
    'complete | blocked',
    'complete ; blocked',
    '**complete** / **blocked**',
    '`complete`/`blocked`',
  ])('majemuk %j -> compound (tidak ditebak)', (v) => {
    expect(aliasTokenOf(v, (x) => st(x) || ['PASS', 'FAIL'].includes(x))).toEqual({ token: null, compound: true });
  });
});

describe('FIX-IMP DC35-F1: kepala laporan', () => {
  it.each(['PASS/FAIL', 'PASS / FAIL', 'PASS atau FAIL', 'PASS or FAIL', 'PASS,FAIL', 'PASS | FAIL'])(
    'vonis %j -> tanpa verdict + CW-02 compound baris 4, teks utuh di dokumen',
    (v) => {
      const x = run(head('complete', v));
      expect(record(x)).toMatchObject({ status: 'complete' });
      expect(record(x)).not.toHaveProperty('verdict');
      expect(x.report.warnings).toEqual([
        expect.objectContaining({
          code: 'CONTRACT_STATUS_UNMAPPED',
          line: 4,
          details: { scope: 'record', field: 'verdict', key: 'verdict', value: v, reason: 'compound' },
        }),
      ]);
      expect(JSON.stringify(x.doc)).toContain(v);
    },
  );

  it.each(['complete/blocked', 'complete|blocked|needs-review', 'complete atau blocked', 'complete, blocked'])(
    'status %j tanpa opsi -> MD2CONTRACT_REQUIRED_MISSING exit 3 [status] + CW-02 baris 3',
    (v) => {
      const e = thrown(() => run(head(v)));
      expect([e.code, e.exitCode, [...e.missing]]).toEqual(['MD2CONTRACT_REQUIRED_MISSING', 3, ['status']]);
      expect(e.report?.warnings).toEqual([
        expect.objectContaining({ code: 'CONTRACT_STATUS_UNMAPPED', line: 3, details: expect.objectContaining({ field: 'status', reason: 'compound' }) }),
      ]);
    },
  );

  it('status majemuk + opsi status -> status dari opsi, CW-02 tetap, teks kepala tetap di dokumen', () => {
    const x = run(head('complete/blocked'), { status: 'blocked' });
    expect(record(x)).toMatchObject({ status: 'blocked' });
    expect(x.report.warnings.map((w) => [w.code, w.line])).toEqual([['CONTRACT_STATUS_UNMAPPED', 3]]);
    expect(JSON.stringify(x.doc)).toContain('complete/blocked');
  });

  it('kontrol D-377 butir 2: nilai tunggal ber-catatan tetap dipetakan, nol peringatan', () => {
    const x = run(head('complete | Giliran: 06-10-2026', 'FAIL (satu FAIL pada CHECK 12 membatalkan PASS)'));
    expect(record(x)).toMatchObject({ status: 'complete', verdict: 'FAIL' });
    expect(x.report.warnings).toEqual([]);
  });

  it('F2: label STATUS majemuk -> CW-02, tanpa opsi exit 3', () => {
    const md = ['# PHASE REPORTS', '', '## 2026-09-02 19:16 WIB', '', '[FASE] ORC | VRF -> CLOSE | 19:16', 'STATUS: completed/blocked', 'RINGKAS: x.', ''].join('\n');
    const e = thrown(() => run(md));
    expect([...e.missing]).toEqual(['status']);
    expect(e.report?.warnings.map((w) => [w.code, w.line])).toEqual([['CONTRACT_STATUS_UNMAPPED', 6]]);
  });
});

describe('FIX-IMP DC35-F1: status butir tabel', () => {
  const table = (rows: string[]) =>
    ['# L', '', 'Status: complete', 'Date: 2026-10-30', '', '## Changes Made', '', '| ID | Judul | Status |', '|---|---|---|', ...rows, ''].join('\n');
  const detail = (w: { details?: unknown }) => w.details as { scope?: string; reason?: string };

  it('done/blocked, todo,blocked, done atau blocked, `done` / `blocked` -> tidak masuk items[] + CW-02 scope item compound', () => {
    const x = run(table(['| DC-01 | A | done/blocked |', '| DC-02 | B | todo,blocked |', '| DC-03 | C | done atau blocked |', '| DC-04 | D | `done` / `blocked` |']));
    expect(record(x)).not.toHaveProperty('items');
    expect(x.report.warnings.map((w) => [w.code, w.line, detail(w).scope, detail(w).reason])).toEqual([
      ['CONTRACT_STATUS_UNMAPPED', 10, 'item', 'compound'],
      ['CONTRACT_STATUS_UNMAPPED', 11, 'item', 'compound'],
      ['CONTRACT_STATUS_UNMAPPED', 12, 'item', 'compound'],
      ['CONTRACT_STATUS_UNMAPPED', 13, 'item', 'compound'],
    ]);
    expect(JSON.stringify(x.doc)).toContain('done/blocked');
  });

  it('kontrol: status butir tunggal ber-catatan tetap masuk items[]', () => {
    const x = run(table(['| DC-01 | A | done (lihat bukti) |', '| DC-02 | B | **blocked** |']));
    expect((record(x).items as Array<{ key: string; status: string }>).map((i) => [i.key, i.status])).toEqual([
      ['DC-01', 'done'],
      ['DC-02', 'blocked'],
    ]);
    expect(x.report.warnings).toEqual([]);
  });
});

// Oracle = regex lama (index.ts sebelum FIX-IMP), hanya dipakai pada masukan pendek.
const OLD_PHASE_RE = /^\[FASE\]\s*(.+?)\s*\|\s*(.+?)\s*->\s*(.+?)\s*\|\s*\d{1,2}:\d{2}\s*$/;
const oracle = (s: string) => {
  const m = OLD_PHASE_RE.exec(s);
  return m ? { mission: m[1], from: m[2], to: m[3] } : null;
};

describe('FIX-IMP L-3: parsePhaseLine = regex lama, linear', () => {
  it.each([
    '[FASE] ORC | TA -> SM | 18:27',
    '[FASE] ORC | VRF -> CLOSE | 19:16',
    '[FASE]ORC|TA->SM|9:05',
    '[FASE]  misi  dua  |  dari  ->  ke  |  18:27  ',
    '[FASE] a | b | c -> d -> e | f | 10:00',
    '[FASE] a | b -> | 10:00',
    '[FASE] | a -> b | 10:00',
    '[FASE]  | a -> b | 10:00',
    '[FASE] a | b -> c | 123:00',
    '[FASE] a | b -> c | 10:0',
    '[FASE] a | b -> c',
    '[FASE] a |\u2028b -> c | 10:00',
    '[FASE] a | b ->\u2028c | 10:00',
    '[FASE] a | b ->\u00a0c | 10:00',
    '[FASE] a | b -> c | 10:00\t',
    'FASE a | b -> c | 10:00',
  ])('kasus tangan %j', (s) => {
    expect(parsePhaseLine(s)).toEqual(oracle(s));
  });

  it('diferensial acak (seed tetap, 40.000 masukan pendek): hasil identik, termasuk tidak-cocok', () => {
    const parts = [' ', ' ', '|', '-', '>', '->', 'a', 'b', '1', '2', ':', '\t', '\u2028', '\n', '\u00a0', '12:30', ' | 9:05', 'x'];
    let seed = 20261031;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let matched = 0;
    const diffs: string[] = [];
    for (let k = 0; k < 40_000; k++) {
      let s = '[FASE]';
      const len = Math.floor(rnd() * 14);
      for (let i = 0; i < len; i++) s += parts[Math.floor(rnd() * parts.length)];
      if (rnd() < 0.5) s += ' | 9:05';
      const want = oracle(s);
      if (want) matched++;
      if (JSON.stringify(parsePhaseLine(s)) !== JSON.stringify(want)) diffs.push(JSON.stringify(s));
    }
    expect(diffs.slice(0, 5)).toEqual([]);
    expect(matched).toBeGreaterThan(500);
  });

  const N = 100_000;
  const shape = (unit: string, suffix: string) => `[FASE] ${unit.repeat(Math.ceil(N / unit.length))}`.slice(0, N - suffix.length) + suffix;
  it.each([
    ['a|->', ''],
    ['a|->', ' | 10:00'],
    ['a|-', '| 10:00'],
    [' ', 'a | b -> c | 10:00'],
    ['| ', '-> | 1:00'],
    ['-> ', '| 10:00'],
    [' | ->', ' | 10:00'],
  ])('patologis 100.000 karakter unit %j akhiran %j < 1 s', (unit, suffix) => {
    const s = shape(unit, suffix);
    expect(s.length).toBe(N);
    const t0 = performance.now();
    parsePhaseLine(s);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('ujung ke ujung: entri F2 dengan baris [FASE] patologis 100.000 karakter < 1 s', () => {
    const md = ['# PHASE REPORTS', '', '## 2026-09-02 19:16 WIB', '', shape('a|->', ''), 'STATUS: complete', 'RINGKAS: x.', ''].join('\n');
    const t0 = performance.now();
    const x = run(md);
    const ms = performance.now() - t0;
    expect(record(x)).toMatchObject({ status: 'complete' });
    expect(ms).toBeLessThan(1000);
  });
});

describe('FIX-IMP D-405: owner/taskRef berpola tidak dipotong', () => {
  it.each([
    ['DC-24', { value: 'DC-24' }],
    ['t_5661a08b (MSIMON-COUNT-R2)', { value: 't_5661a08b' }],
    ['`DC-24`', { value: 'DC-24' }],
    ['DC-03 | Giliran: 06-10-2026', { value: 'DC-03' }],
    ['DC-03/DC-04', { value: null, reason: 'compound' }],
    ['DC-03, DC-04', { value: null, reason: 'compound' }],
    ['DC-03 atau DC-04', { value: null, reason: 'compound' }],
    ['DC-03 | DC-04', { value: null, reason: 'compound' }],
    ['DC-03:x', { value: null, reason: 'compound' }],
    ['#12', { value: null, reason: 'pattern' }],
  ])('taskRefValueOf %j', (v, want) => {
    expect(taskRefValueOf(v)).toEqual(want);
  });

  it.each([
    ['coder-execution', { value: 'coder-execution' }],
    ['Coder-Execution (independen)', { value: 'coder-execution' }],
    ['gsp-coder | vonis FAIL', { value: 'gsp-coder' }],
    ['coder/verifier', { value: null, reason: 'compound' }],
    ['coder-execution, verifier', { value: null, reason: 'compound' }],
    ['coder + verifier-2', { value: null, reason: 'compound' }],
  ])('actorValueOf %j', (v, want) => {
    expect(actorValueOf(v)).toEqual(want);
  });

  const md = (lines: string[]) => ['# L', '', 'Status: complete', 'Date: 2026-10-30', ...lines, '', '## Ringkasan', '', 'isi.', ''].join('\n');

  it('kepala Row: DC-03/DC-04 + Agent: coder/verifier -> tanpa taskRef/owner, CW-04 compound, baris tetap di bab 1', () => {
    const x = run(md(['Row: DC-03/DC-04', 'Agent: coder/verifier']));
    expect(record(x)).not.toHaveProperty('taskRef');
    expect(record(x)).not.toHaveProperty('owner');
    expect(x.report.warnings).toEqual([
      expect.objectContaining({ code: 'CONTRACT_FIELD_UNMAPPED', line: 5, details: { scope: 'record', field: 'taskRef', key: 'row', value: 'DC-03/DC-04', reason: 'compound' } }),
      expect.objectContaining({ code: 'CONTRACT_FIELD_UNMAPPED', line: 6, details: { scope: 'record', field: 'owner', key: 'agent', value: 'coder/verifier', reason: 'compound' } }),
    ]);
    const ch1 = JSON.stringify((x.doc.sections!.content as { chapters: unknown[] }).chapters[0]);
    expect(ch1).toContain('Row: DC-03/DC-04');
    expect(ch1).toContain('Agent: coder/verifier');
  });

  it('kepala nilai tak cocok pola -> CW-04 reason pattern (bukan lagi catatan diam)', () => {
    const x = run(md(['Row: #12']));
    expect(record(x)).not.toHaveProperty('taskRef');
    expect(x.report.warnings.map((w) => [w.code, w.line, (w.details as { reason: string }).reason])).toEqual([['CONTRACT_FIELD_UNMAPPED', 5, 'pattern']]);
  });

  it('kontrol: nilai tunggal tetap dipetakan, nol peringatan', () => {
    const x = run(md(['Row: DC-24', 'Agent: coder-execution']));
    expect(record(x)).toMatchObject({ taskRef: 'DC-24', owner: 'coder-execution' });
    expect(x.report.warnings).toEqual([]);
  });

  it('owner butir majemuk -> butir masuk tanpa owner + CW-04 scope item; sel tetap di tabel teks', () => {
    const x = run(
      ['# L', '', 'Status: complete', 'Date: 2026-10-30', '', '## Changes Made', '', '| ID | Judul | Status | Owner |', '|---|---|---|---|', '| DC-01 | A | done | coder/verifier |', '| DC-02 | B | done | data-analyst |', ''].join('\n'),
    );
    expect((record(x).items as Array<Record<string, unknown>>).map((i) => [i.key, i.owner])).toEqual([
      ['DC-01', undefined],
      ['DC-02', 'data-analyst'],
    ]);
    expect(x.report.warnings).toEqual([
      expect.objectContaining({ code: 'CONTRACT_FIELD_UNMAPPED', line: 10, details: { scope: 'item', field: 'owner', key: 'DC-01', value: 'coder/verifier', reason: 'compound' } }),
    ]);
    expect(JSON.stringify(x.doc)).toContain('coder/verifier');
  });
});
