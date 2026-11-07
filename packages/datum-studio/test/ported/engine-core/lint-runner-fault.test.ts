// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/lint-runner-fault.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S71: injeksi cacat instrumen ke runner lint (engine/lint/scan runLint).
// Prinsip runner (runner.ts, A10/KT-13): cacat instrumen dilaporkan, bukan
// disembunyikan; status rilis PASS hanya bila cek yang berlaku benar-benar
// dijalankan. Uji ini memaksa modul scan (lewat tableGuards) dan modul
// struktur crash pada dokumen nyata, lalu memeriksa laporan.
import { describe, it, expect, vi, beforeEach, afterAll } from '../_vitest'; // row42 W9: + afterAll
import { runLint } from '@/lib/studio/engine/lint/scan';
import { canonicalTemplate, dataTable, makeDoc, snapshotOf, statuses } from './fixtures';
import * as origTables from '@/lib/studio/engine/docx/tables'; // row42 W9
import * as origStructure from '@/lib/studio/engine/lint/structure'; // row42 W9

const fault = vi.hoisted(() => ({ scan: false, structure: false }));

// row42 W9: bun's mock factory gets no importOriginal; the originals are copied from a namespace import before
// the module is replaced (bun patches the live module in place, so the copy must be taken inside the factory,
// before the swap). The wrappers only differ from the originals while a fault flag is set.
vi.mock('@/lib/studio/engine/docx/tables', async () => {
  const mod = { ...origTables };
  return {
    ...mod,
    tableGuards: (...args: Parameters<typeof mod.tableGuards>) => {
      if (fault.scan) throw new Error('cacat instrumen uji (scan)');
      return mod.tableGuards(...args);
    },
  };
});

vi.mock('@/lib/studio/engine/lint/structure', async () => {
  const mod = { ...origStructure };
  return {
    ...mod,
    lintStructure: (...args: Parameters<typeof mod.lintStructure>) => {
      if (fault.structure) throw new Error('cacat instrumen uji (structure)');
      return mod.lintStructure(...args);
    },
  };
});

beforeEach(() => {
  fault.scan = false;
  fault.structure = false;
});
// row42 W9: the bun module mock outlives this file; leave both wrappers in pass-through for later suites.
afterAll(() => {
  fault.scan = false;
  fault.structure = false;
});

// Dokumen TERBIT dengan pelanggaran penahan nyata (judul pertanyaan + G1).
const badDoc = () => makeDoc({ sectionTitle: 'Bagaimana cara memasang panel?', blocks: [dataTable({ badRow: true })] });

describe('runLint saat modul crash', () => {
  it('kontrol: tanpa cacat, dokumen bermasalah -> rilis FAIL', () => {
    const rep = runLint({ snapshot: snapshotOf(badDoc()), tpl: canonicalTemplate(), tier: 'TERBIT', stage: 'ingest' });
    expect(rep.releaseStatus).toBe('FAIL');
    expect(statuses(rep.checks, 'G1')).toContain('FAIL');
  });

  it('modul scan crash: cek scan dilaporkan NOT_RUN dengan galatnya dan runLint tidak melempar', () => {
    fault.scan = true;
    const rep = runLint({ snapshot: snapshotOf(badDoc()), tpl: canonicalTemplate(), tier: 'TERBIT', stage: 'ingest' });
    for (const id of ['G1', 'DATUM-04', 'N1']) {
      expect(statuses(rep.checks, id), id).toEqual(['NOT_RUN']);
      expect(rep.checks.find((c) => c.checkId === id)?.detail, id).toContain('cacat instrumen uji (scan)');
    }
  });

  // TEMUAN F-S71-1 (produksi, pemilik S44): runner.ts releaseStatusFor
  // mengembalikan PASS bila SATU cek berlaku saja berjalan, walau seluruh modul
  // scan dan struktur crash (G1/DATUM-04 tidak pernah dinilai). Ekspektasi di
  // bawah adalah perilaku yang diminta prinsip runner, bukan disesuaikan agar lulus.
  it('modul scan + struktur crash pada dokumen bermasalah -> status rilis TIDAK boleh PASS', () => {
    fault.scan = true;
    fault.structure = true;
    const rep = runLint({ snapshot: snapshotOf(badDoc()), tpl: canonicalTemplate(), tier: 'TERBIT', stage: 'ingest' });
    expect(statuses(rep.checks, 'G1')).toEqual(['NOT_RUN']);
    expect(statuses(rep.checks, 'DATUM-10')).toEqual(['NOT_RUN']);
    expect(rep.releaseStatus).not.toBe('PASS');
  });
});
