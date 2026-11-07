// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/import/dc24-md2contract.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-24 (D-371): generator `md2contract/v1` laporan kerja MD -> studio.doc/v2 `agentWorkReport`.
// Nilai harapan = register masterplan/05_document_contract_specs.md §16 (GA/GL/GF/GS/GI/GV),
// §13.2 (CW-02..CW-04), KD-42 (status tidak pernah ditebak), ditulis sebagai literal.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from '../_vitest';
import {
  ContractImportError,
  markdownToContract,
  type ContractImportOptions,
  type ContractImportResult,
} from '@/lib/studio/services/import/contract';

const KIND = { kind: 'agentWorkReport' } as const;
const run = (md: string, extra: Partial<ContractImportOptions> = {}) => markdownToContract(md, { ...KIND, ...extra });
const codes = (r: { report: { warnings: Array<{ code: string }> } }) => r.report.warnings.map((w) => w.code);
const record = (r: ContractImportResult) => r.doc.sections!.record as unknown as Record<string, unknown>;
const chapters = (r: ContractImportResult) => (r.doc.sections!.content as unknown as { chapters: Array<{ key: string; title: unknown; intro?: unknown[]; sections: Array<{ title: unknown }> }> }).chapters;
function thrown(fn: () => unknown): ContractImportError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ContractImportError) return e;
    throw e;
  }
  throw new Error('expected ContractImportError');
}

const F1 = [
  '# Laporan kerja DC-24 generator',
  '',
  'Status: complete',
  'Agent: coder-execution',
  'Date: 2026-10-30T19:30+07:00',
  'Row: DC-24',
  'Penyusun: gsp-master01',
  'Kartu induk t_249c6b84 dicatat.',
  '',
  '## Ringkasan',
  '',
  'Generator selesai.',
  '',
  '## Changes Made',
  '',
  '| ID | Judul | Status | Owner | Fase | Dep |',
  '|---|---|---|---|---|---|',
  '| t_5943d415 | Kunci kosakata | done | data-analyst | masterplan | |',
  '| DC-03 | Protokol metrik | ready | | | DC-02, DC-01 |',
  '| DC-09 | Usulan baru | usulan | | | |',
  '',
  '## 2. Bukti',
  '',
  'npx tsc 0 galat.',
  '',
  '## Catatan pribadi',
  '',
  'Teks yang tidak punya alias tetap ada.',
  '',
  '## Persistent Issues',
  '',
  'Tidak ada.',
  '',
  '## Next Steps',
  '',
  '- DC-25 CLI',
  '',
  '## Referensi',
  '',
  '- Register 05 https://example.org/reg05.',
  '- Blueprint 07',
  '',
].join('\n');

describe('DC-24 F1 laporan tunggal', () => {
  const r = run(F1, { mission: '2026-10-30_hermes-retrial', docKey: 'laporan-kerja-dc24' });

  it('kepala -> contractRecord lewat GF/GS; cardIds dari 40 baris pertama + tabel; doc v2 lolos validasi lokal', () => {
    expect(record(r)).toEqual({
      type: 'contractRecord',
      status: 'complete',
      owner: 'coder-execution',
      taskRef: 'DC-24',
      reportedAt: '2026-10-30T19:30+07:00',
      cardIds: ['t_249c6b84', 't_5943d415'],
      items: [
        { key: 't_5943d415', title: { text: 'Kunci kosakata' }, status: 'done', owner: 'data-analyst', phase: 'masterplan' },
        { key: 'DC-03', title: { text: 'Protokol metrik' }, status: 'ready', dependsOn: ['DC-02', 'DC-01'] },
      ],
    });
    expect(r.doc.$schema).toBe('studio.doc/v2');
    expect(r.doc.template).toEqual({ slug: 'laporan-kerja-agen' });
    expect(r.doc.meta).toEqual({ title: 'Laporan kerja DC-24 generator' });
    expect(r.report.generator).toBe('md2contract/v1');
    expect(r.validation).toEqual({ valid: true, issues: [] });
  });

  it('peringatan berkode: CW-04 kunci tanpa alias, CW-02 status butir, CW-03 judul tanpa alias (urut baris)', () => {
    expect(r.report.warnings.map((w) => [w.code, w.line])).toEqual([
      ['CONTRACT_FIELD_UNMAPPED', 7],
      ['CONTRACT_STATUS_UNMAPPED', 20],
      ['CONTRACT_HEADING_UNMAPPED', 26],
    ]);
    expect(r.report.warnings[1].details).toEqual({ scope: 'item', key: 'DC-09', value: 'usulan' });
    expect(r.report.warnings[2].details).toEqual({ heading: 'Catatan pribadi', normalized: 'catatan pribadi', chapterKey: '6' });
  });

  it('judul ## -> bab outline lewat alias (nomor awal dibuang); bab tambahan kunci 6; referensi -> slot references', () => {
    expect(chapters(r).map((c) => [c.key, c.title, c.sections.map((s) => s.title)])).toEqual([
      ['1', { text: 'Ringkasan' }, [{ text: 'Ringkasan' }]],
      ['2', { text: 'Rincian kerja' }, [{ text: 'Changes Made' }]],
      ['3', { text: 'Bukti' }, [{ text: 'Bukti' }]],
      ['4', { text: 'Isu terbuka' }, [{ text: 'Persistent Issues' }]],
      ['5', { text: 'Langkah berikut' }, [{ text: 'Next Steps' }]],
      ['6', { text: 'Catatan pribadi' }, [{ text: 'Catatan pribadi' }]],
    ]);
    expect(r.doc.sections!.references).toEqual({
      type: 'sourceRegister',
      entries: [
        { id: 'R1', citation: { text: 'Register 05 https://example.org/reg05.' }, url: 'https://example.org/reg05' },
        { id: 'R2', citation: { text: 'Blueprint 07' } },
      ],
    });
    expect(r.report.mapping.missingChapters).toEqual([]);
  });

  it('teks tidak dibuang: kunci tanpa alias tetap di intro bab 1, isi bab tambahan utuh, tabel butir tetap di teks', () => {
    const json = JSON.stringify(r.doc);
    expect(json).toContain('Penyusun: gsp-master01');
    expect(json).toContain('Teks yang tidak punya alias tetap ada.');
    expect(json).toContain('Usulan baru');
    // Baris kepala yang tersimpan di record tidak diulang di prosa.
    expect(json).not.toContain('Agent: coder-execution');
  });

  it('determinisme: dua jalan identik byte; CRLF/BOM = LF', () => {
    const a = JSON.stringify(run(F1, { mission: '2026-10-30_hermes-retrial' }));
    const b = JSON.stringify(run(F1, { mission: '2026-10-30_hermes-retrial' }));
    const c = JSON.stringify(run('\uFEFF' + F1.replace(/\n/g, '\r\n'), { mission: '2026-10-30_hermes-retrial' }));
    expect(a).toBe(b);
    expect(c).toBe(a);
  });

  it('dua judul ber-alias ke bab sama digabung berurutan', () => {
    const x = run('# T\n\nStatus: draft\nTanggal: 2026-10-01\n\n## Bukti\n\nA.\n\n## Verifikasi\n\nB.\n\n## Test Results\n\nC.\n');
    expect(chapters(x).map((c) => [c.key, c.sections.map((s) => s.title)])).toEqual([
      ['3', [{ text: 'Bukti' }, { text: 'Verifikasi' }, { text: 'Test Results' }]],
    ]);
    expect(x.report.mapping.missingChapters).toEqual(['1', '2', '4', '5']);
    expect(record(x).status).toBe('draft');
  });
});

describe('DC-24 KD-42: status tidak pernah ditebak', () => {
  it('status tanpa alias -> CW-02 scope record dan galat exit 3; --status mengisi, CW-02 tetap tercatat', () => {
    const md = '# T\n\nStatus: usulan\nDate: 2026-10-30\n\n## Ringkasan\n\nX.\n';
    const e = thrown(() => run(md));
    expect([e.code, e.exitCode, e.missing]).toEqual(['MD2CONTRACT_REQUIRED_MISSING', 3, ['status']]);
    expect(e.report!.warnings.map((w) => [w.code, w.line, w.details])).toEqual([
      ['CONTRACT_STATUS_UNMAPPED', 3, { scope: 'record', field: 'status', key: 'status', value: 'usulan' }],
    ]);
    const ok = run(md, { status: 'needs-review' });
    expect(record(ok).status).toBe('needs-review');
    expect(codes(ok)).toEqual(['CONTRACT_STATUS_UNMAPPED']);
    expect(ok.report.mapping.record.find((m) => m.field === 'status')).toEqual({ field: 'status', source: 'option', line: 0, raw: 'needs-review', value: 'needs-review' });
    // Baris status tanpa alias tetap utuh di teks.
    expect(JSON.stringify(ok.doc)).toContain('Status: usulan');
  });

  it('status dan reportedAt absen -> galat exit 3 memuat keduanya; tidak ada nilai bawaan', () => {
    const e = thrown(() => run('# T\n\n## Ringkasan\n\nX.\n'));
    expect([e.code, e.exitCode, e.missing]).toEqual(['MD2CONTRACT_REQUIRED_MISSING', 3, ['status', 'reportedAt']]);
  });

  it('opsi status yang bukan kode/alias -> galat pemakaian exit 2; jenis tak dikenal juga exit 2', () => {
    const e = thrown(() => run('# T\n\n## Ringkasan\n\nX.\n', { status: 'active', reportedAt: '2026-10-30' }));
    expect([e.code, e.exitCode]).toEqual(['MD2CONTRACT_USAGE', 2]);
    const k = thrown(() => markdownToContract('# T\n', { kind: 'nope' as never }));
    expect(k.exitCode).toBe(2);
  });

  it('alias GS lain dipetakan apa adanya (perlu_revisi -> needs-review, partial-handoff -> partial)', () => {
    expect(record(run('# T\n\n**Status:** perlu_revisi\nTanggal: 2026-10-30\n\n## Ringkasan\n\nX.\n')).status).toBe('needs-review');
    expect(record(run('# T\n\n- **status:** partial-handoff (lanjut besok)\nTanggal: 2026-10-30\n\n## Ringkasan\n\nX.\n')).status).toBe('partial');
  });

  it('vonis tanpa alias (SETUJU) -> CW-02 field verdict, tidak diisi; PASS dipetakan', () => {
    const x = run('# T\n\nStatus: complete\nTanggal: 2026-10-30\nVerdict: SETUJU\n\n## Ringkasan\n\nX.\n');
    expect(record(x).verdict).toBeUndefined();
    expect(x.report.warnings.map((w) => [w.code, (w.details as { field: string }).field])).toEqual([['CONTRACT_STATUS_UNMAPPED', 'verdict']]);
    expect(record(run('# T\n\nStatus: complete\nTanggal: 2026-10-30\nVonis: PASS\n\n## Ringkasan\n\nX.\n')).verdict).toBe('PASS');
  });
});

describe('DC-24 reportedAt dan kunci kepala', () => {
  it('GF-07 created hanya bila date/tanggal absen; jam tanpa zona -> tanggal saja (zona tidak ditebak); WIB -> +07:00', () => {
    expect(record(run('# T\n\nStatus: complete\nCreated: 2026-10-01\nTanggal: 2026-10-02\n\n## Ringkasan\n\nX.\n')).reportedAt).toBe('2026-10-02');
    expect(record(run('# T\n\nStatus: complete\nCreated: 2026-10-01\n\n## Ringkasan\n\nX.\n')).reportedAt).toBe('2026-10-01');
    const nz = run('# T\n\nStatus: complete\nDate: 2026-10-03 14:05\n\n## Ringkasan\n\nX.\n');
    expect(record(nz).reportedAt).toBe('2026-10-03');
    expect(nz.report.mapping.notes.map((n) => n.code)).toEqual(['REPORTED_AT_TIME_DROPPED']);
    expect(record(run('# T\n\nStatus: complete\nDate: 2026-10-03 14:05 WIB\n\n## Ringkasan\n\nX.\n')).reportedAt).toBe('2026-10-03T14:05+07:00');
  });

  it('tanggal di luar kalender tidak dipakai (2026-02-30) -> reportedAt hilang', () => {
    const e = thrown(() => run('# T\n\nStatus: complete\nDate: 2026-02-30\n\n## Ringkasan\n\nX.\n'));
    expect(e.missing).toEqual(['reportedAt']);
    expect(e.report!.mapping.notes.map((n) => n.code)).toEqual(['FIELD_VALUE_INVALID']);
  });

  it('frontmatter: kunci GF dipetakan, kunci lain CW-04 dan tetap paragraf di bab 1', () => {
    const x = run('---\nstatus: complete\ndate: 2026-10-30\nkartu: t_0a5e87ca\nproyek: hermes\n---\n# T\n\n## Ringkasan\n\nX.\n');
    expect(record(x)).toMatchObject({ status: 'complete', reportedAt: '2026-10-30', cardIds: ['t_0a5e87ca'] });
    expect(x.report.warnings.map((w) => [w.code, w.line])).toEqual([['CONTRACT_FIELD_UNMAPPED', 5]]);
    expect(chapters(x)[0].intro).toEqual([{ type: 'paragraph', text: 'proyek: hermes' }]);
    expect(x.validation.valid).toBe(true);
  });
});

const F2 = [
  '# PHASE REPORTS misi ORC',
  '',
  '## 2026-09-02 18:40',
  '',
  '```text',
  '[FASE] ORC | TA -> SM | 18:27',
  'RINGKAS: fase TA selesai.',
  'ARTEFAK: docs/x/identification/02_structured.md (314 baris / 38.068 B); catatan tanpa path',
  'JALUR: selesai: TA | berjalan: ORC-SM t_5e359cab | sisa: VRF.',
  'RENCANA: fase SM.',
  'ESTIMASI: SM <= 60 menit.',
  '```',
  '',
  '## 2026-09-02 19:16 WIB',
  '',
  '```text',
  '[FASE] ORC | VRF -> CLOSE | 19:16',
  'STATUS: completed',
  'RINGKAS: misi ORC selesai.',
  'ARTEFAK: docs/x/VERDICT-ORC.md 10.107 B sha256 92a60eca7944055b',
  'SKILL: gsp-verifier',
  'HAMBAT: tidak ada.',
  '```',
  '',
].join('\n');

describe('DC-24 F2 entri PHASE-REPORTS', () => {
  it('entri terakhir (bawaan): GL-13 reportedAt WIB, GL-12 phase, STATUS lewat GS, ARTEFAK -> evidence, label tanpa alias CW-04', () => {
    const x = run(F2);
    expect(record(x)).toEqual({
      type: 'contractRecord',
      status: 'complete',
      reportedAt: '2026-09-02T19:16+07:00',
      phase: { from: 'VRF', to: 'CLOSE' },
      evidence: [{ kind: 'file', ref: 'docs/x/VERDICT-ORC.md', bytes: 10107, sha256: '92a60eca7944055b' }],
    });
    expect(x.report.mapping.form).toBe('F2');
    expect(x.report.mapping.entry).toEqual({ index: 2, count: 2, line: 14, mission: 'ORC' });
    expect(x.report.warnings.map((w) => [w.code, w.line])).toEqual([['CONTRACT_FIELD_UNMAPPED', 21]]);
    expect(chapters(x).map((c) => [c.key, c.sections.map((s) => s.title)])).toEqual([
      ['1', [{ text: 'RINGKAS' }]],
      ['3', [{ text: 'ARTEFAK' }]],
      ['4', [{ text: 'HAMBAT' }]],
    ]);
    expect(JSON.stringify(chapters(x)[0])).toContain('SKILL: gsp-verifier');
    expect(x.validation).toEqual({ valid: true, issues: [] });
  });

  it('entri 1 tanpa STATUS -> exit 3 (KD-42); dengan --status: jam tanpa zona -> tanggal, kartu JALUR -> cardIds', () => {
    const e = thrown(() => run(F2, { entry: 1 }));
    expect(e.missing).toEqual(['status']);
    const x = run(F2, { entry: 1, status: 'complete' });
    expect(record(x)).toEqual({
      type: 'contractRecord',
      status: 'complete',
      reportedAt: '2026-09-02',
      phase: { from: 'TA', to: 'SM' },
      cardIds: ['t_5e359cab'],
      evidence: [{ kind: 'file', ref: 'docs/x/identification/02_structured.md', bytes: 38068 }],
    });
    expect(chapters(x).map((c) => c.key)).toEqual(['1', '2', '3', '5']);
    expect(thrown(() => run(F2, { entry: 3 })).exitCode).toBe(2);
  });
});

// Asap: 3 laporan kerja nyata pilihan DC-03 (baca saja; dilewati bila workspace Hermes tidak ada).
const HERMES = 'C:/Users/TRIAL/workspace/gsp-hermes/workspace/docs/';
const REAL = [
  {
    path: '2026-10-04-prompt-manual/_work/t_ac989baa/LAPORAN-SELESAI.md',
    mission: '2026-10-04-prompt-manual',
    missing: ['reportedAt'],
    statusSource: 'header',
    warnings: { CONTRACT_HEADING_UNMAPPED: 4 },
    mappedChapters: ['3'],
  },
  {
    path: '2026-10-12-game-success-formula/verification/01_verifier_report.md',
    mission: '2026-10-12-game-success-formula',
    missing: ['status', 'reportedAt'],
    statusSource: 'option',
    warnings: { CONTRACT_FIELD_UNMAPPED: 3, CONTRACT_HEADING_UNMAPPED: 7 },
    mappedChapters: ['1'],
  },
  {
    path: '2026-10-10-tracero-dispatcher-1010/laporan.md',
    mission: '2026-10-10-tracero-dispatcher-1010',
    missing: ['reportedAt'],
    statusSource: 'header',
    warnings: { CONTRACT_HEADING_UNMAPPED: 6 },
    mappedChapters: ['1', '4'],
  },
] as const;

describe.each(REAL)('DC-24 asap laporan nyata $path', (c) => {
  const file = HERMES + c.path;
  it.skipIf(!existsSync(file))('tanpa fallback -> exit 3 apa adanya; dengan fallback -> doc v2 valid, 0 status ditebak, deterministik', () => {
    const md = readFileSync(file, 'utf8');
    const e = thrown(() => run(md, { mission: c.mission }));
    expect([e.code, e.missing]).toEqual(['MD2CONTRACT_REQUIRED_MISSING', [...c.missing]]);

    const opts = { mission: c.mission, docKey: 'laporan-kerja', status: 'complete', reportedAt: '2026-10-30' };
    const r = run(md, opts);
    expect(r.validation).toEqual({ valid: true, issues: [] });
    const counts: Record<string, number> = {};
    for (const w of r.report.warnings) counts[w.code] = (counts[w.code] ?? 0) + 1;
    expect(counts).toEqual(c.warnings);
    // 0 status ditebak: status hanya dari baris kepala ber-alias atau opsi eksplisit.
    const st = r.report.mapping.record.filter((m) => m.field === 'status');
    expect(st.map((m) => m.source)).toEqual([c.statusSource]);
    expect(r.report.mapping.chapters.filter((ch) => ch.outlineKey !== null).map((ch) => ch.key)).toEqual([...c.mappedChapters]);
    expect(JSON.stringify(run(md, opts))).toBe(JSON.stringify(r));
  });
});
