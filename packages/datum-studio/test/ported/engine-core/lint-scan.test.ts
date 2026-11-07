// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/lint-scan.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S71: uji unit engine/lint/scan (I34; S44) dan keputusan penahan ingest
// `ingestPolicy` (IP-06, D-90): penegakan per tier, override profil/dokumen,
// cek integritas G1/DATUM-11 tidak dapat dilepas, aturan pengaman D-34.
import { describe, it, expect, beforeAll } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { LINT_REGISTRY } from '@/lib/studio/registry/lint';
import {
  INTEGRITY_CHECKS,
  appliesToTier,
  assembleLintReport,
  byConstructionChecks,
  emDashRate,
  ingestPolicy,
  isBenchmarkDoc,
  questionHeading,
  runLint,
  scanText,
} from '@/lib/studio/engine/lint/scan';
import { resolveEnforcement } from '@/lib/studio/engine/lint/structure';
import { releasedBlockingChecks } from '@/lib/studio/engine/lint/structure/enforcement';
import { benchmarkTemplate, canonicalTemplate, dataTable, loadBenchmarkDoc, makeDoc, snapshotOf, statuses, withParams } from './fixtures';

let KAN: ResolvedTemplate;
let BM: ResolvedTemplate;
beforeAll(async () => {
  KAN = canonicalTemplate();
  BM = await benchmarkTemplate();
});

const QUESTION = 'Bagaimana cara memasang panel?';
const fails = (xs: ReadonlyArray<{ checkId: string; status: string }>) => [...new Set(xs.filter((x) => x.status === 'FAIL').map((x) => x.checkId))].sort();

describe('scanText: pemindai teks X', () => {
  it('DATUM-03 em dash: default 0 per 1.000 kata -> FAIL; parameter dinaikkan -> PASS', () => {
    const t = 'Satu klaim — dengan em dash di tengah kalimat yang cukup panjang untuk dihitung.';
    expect(statuses(scanText(t, KAN.params), 'DATUM-03')).toEqual(['FAIL']);
    expect(statuses(scanText(t, { ...KAN.params, 'prose.emDash': { maxPer1000Words: 100, inHeadings: 0 } }), 'DATUM-03')).toEqual(['PASS']);
    expect(emDashRate('a — b').count).toBe(1);
  });

  it('DATUM-16 nilai menempel satuan, DATUM-19 PPN selain 11 %, DATUM-31 Mermaid, DATUM-17 ± tanpa arti', () => {
    const r = scanText('Panjang 12mm.\nPPN 10 % dikenakan.\ngraph TD\nNilai 5 ± 2 saja.', KAN.params);
    expect(fails(r)).toEqual(['DATUM-16', 'DATUM-17', 'DATUM-19', 'DATUM-31']);
  });

  it('teks bersih -> semua PASS; PPN 11 % dan PPN 12 % x DPP sah', () => {
    const r = scanText('Panjang 12 mm. PPN 11 % berlaku. PPN 12 % atas DPP 11/12 nilai lain. Toleransi 5 ± 2 mm.', KAN.params);
    expect(fails(r)).toEqual([]);
    expect(r.every((i) => i.status === 'PASS')).toBe(true);
  });

  // D-263 (merevisi D-55): pertanyaan = berakhiran "?" (RL Rev K E-27); awalan kata tanya saja tidak memicu.
  it.each([
    ['Bagaimana cara memasang panel?', true],
    ['Apakah grid menutup', false],
    ['What is the grid width', false],
    ['Grid menutup di 210 mm', false],
    ['Apa adanya: kolom teks 128 mm', false],
    ['Siapa memiliki keputusan apa', false],
    ['Grid menutup di 210 mm?  ', true],
  ])('questionHeading(%j) -> %s', (t, bad) => {
    expect(questionHeading(t) !== null).toBe(bad);
  });

  it('masukan patologis tidak melempar dan selesai cepat', () => {
    const t0 = Date.now();
    expect(() => scanText('±'.repeat(20000) + 'PPN'.repeat(5000) + '—'.repeat(5000), KAN.params)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('byConstructionChecks: penahan ingest per tier (D-90)', () => {
  it('judul pertanyaan (DATUM-04) menahan TERBIT/SERAH, tidak menahan NOTA', () => {
    for (const tier of ['TERBIT', 'SERAH'] as const) {
      expect(fails(byConstructionChecks(makeDoc({ tier, sectionTitle: QUESTION }), KAN)), tier).toEqual(['DATUM-04']);
    }
    expect(fails(byConstructionChecks(makeDoc({ tier: 'NOTA', sectionTitle: QUESTION }), KAN))).toEqual([]);
  });

  it('G1 (integritas tabel) menahan di SEMUA tier, termasuk NOTA', () => {
    for (const tier of ['NOTA', 'TERBIT', 'SERAH'] as const) {
      const r = byConstructionChecks(makeDoc({ tier, blocks: [dataTable({ badRow: true })] }), KAN);
      expect(fails(r), tier).toContain('G1');
    }
  });

  it('cek non-penahan (DATUM-03 em dash, A10) tidak pernah muncul sebagai penahan ingest', () => {
    const doc = makeDoc({ blocks: [{ type: 'paragraph', text: 'Klaim — dengan em dash.' }] });
    expect(byConstructionChecks(doc, KAN).map((i) => i.checkId)).not.toContain('DATUM-03');
  });

  it('garis bawah pada nama berkas aset (N1/DATUM-38) menahan; nomor dokumen bergaris miring tidak', () => {
    const doc = makeDoc({
      docNumber: '001/GSP/STD/X/2026',
      assets: { a: { kind: 'raster', mime: 'image/png', sha256: 'a'.repeat(64), path: 'data/misi_2026/foto_lapangan.png' } },
    });
    const r = byConstructionChecks(doc, KAN);
    expect(fails(r)).toEqual(['DATUM-38', 'N1']);
    // D-80: hanya stem berkas diuji, segmen direktori tidak.
    expect(r.filter((i) => i.status === 'FAIL').every((i) => i.detail?.includes('foto_lapangan'))).toBe(true);
  });

  it('dokumen bersih -> tidak ada FAIL penahan', () => {
    expect(fails(byConstructionChecks(makeDoc({ blocks: [dataTable()] }), KAN))).toEqual([]);
  });
});

describe('override penegakan: profil templat (semua mode) vs dokumen (hanya block -> release)', () => {
  it('profil melepas DATUM-04 -> tidak menahan', () => {
    const tpl = withParams(KAN, { 'lint.enforcementOverride': { 'DATUM-04': 'release' } });
    expect(fails(byConstructionChecks(makeDoc({ sectionTitle: QUESTION }), tpl))).toEqual([]);
  });

  it('profil TIDAK dapat melepas cek integritas G1', () => {
    const tpl = withParams(KAN, { 'lint.enforcementOverride': { G1: 'off', 'DATUM-11': 'release' } });
    expect(fails(byConstructionChecks(makeDoc({ blocks: [dataTable({ badRow: true })] }), tpl))).toContain('G1');
    const p = ingestPolicy(makeDoc(), tpl);
    for (const id of INTEGRITY_CHECKS) {
      expect(p.mode(id), id).toBe('block');
      expect(p.blocks(id, 'NOTA'), id).toBe(true);
    }
  });

  it('dokumen menurunkan block -> release diterima (bila dokumen sampai ke mesin)', () => {
    const doc = makeDoc({ sectionTitle: QUESTION, x: { lintEnforcement: { 'DATUM-04': 'release' } } });
    expect(fails(byConstructionChecks(doc, KAN))).toEqual([]);
  });

  it('dokumen meminta "off"/"report" atau menaikkan -> ditolak dan tercatat di rejected', () => {
    const doc = makeDoc({ sectionTitle: QUESTION, x: { lintEnforcement: { 'DATUM-04': 'off', 'DATUM-03': 'block', 'ZZZ-1': 'release' } } });
    expect(fails(byConstructionChecks(doc, KAN))).toEqual(['DATUM-04']);
    const res = resolveEnforcement(KAN, doc);
    expect(res.rejected.map((r) => [r.source, r.checkId])).toEqual([
      ['document', 'DATUM-04'],
      ['document', 'DATUM-03'],
      ['document', 'ZZZ-1'],
    ]);
    expect(res.overrides).toEqual({});
  });

  it('dokumen tidak dapat menaikkan cek yang dilepas profil kembali menjadi off; profil rusak dilaporkan', () => {
    const bad = withParams(KAN, { 'lint.enforcementOverride': { 'DATUM-04': 'matikan', 'NOPE-9': 'off' } });
    const res = resolveEnforcement(bad);
    expect(res.rejected.map((r) => r.checkId).sort()).toEqual(['DATUM-04', 'NOPE-9']);
    const notObject = withParams(KAN, { 'lint.enforcementOverride': 'off' });
    expect(resolveEnforcement(notObject).rejected).toEqual([expect.objectContaining({ source: 'profile', checkId: '*' })]);
  });

  it('releasedBlockingChecks: profil benchmark = TERBATAS (DATUM-04, DATUM-09, G3); kanonik tidak', () => {
    expect(releasedBlockingChecks(BM)).toEqual(['DATUM-04', 'DATUM-09', 'G3']);
    expect(releasedBlockingChecks(KAN)).toEqual([]);
  });
});

describe('aturan pengaman D-34: penanda benchmark menurunkan penahan menjadi status rilis', () => {
  it('isBenchmarkDoc: x.benchmark true/objek atau x.enforcement="report"', () => {
    expect(isBenchmarkDoc({ x: { benchmark: true } })).toBe(true);
    expect(isBenchmarkDoc({ x: { benchmark: {} } })).toBe(true);
    expect(isBenchmarkDoc({ x: { enforcement: 'report' } })).toBe(true);
    expect(isBenchmarkDoc({ x: { benchmark: 'true' } })).toBe(false);
    expect(isBenchmarkDoc({ x: { enforcement: 'off' } })).toBe(false);
    expect(isBenchmarkDoc({})).toBe(false);
  });

  it('dokumen bertanda: byConstructionChecks kosong, termasuk G1; decide = downgrade', () => {
    const doc = makeDoc({ blocks: [dataTable({ badRow: true })], sectionTitle: QUESTION, x: { benchmark: true } });
    expect(byConstructionChecks(doc, KAN)).toEqual([]);
    expect(ingestPolicy(doc, KAN).decide({ checkId: 'G1', status: 'FAIL' }, 'TERBIT')).toBe('downgrade');
    const plain = makeDoc({ blocks: [dataTable({ badRow: true })] });
    expect(ingestPolicy(plain, KAN).decide({ checkId: 'G1', status: 'FAIL' }, 'NOTA')).toBe('block');
    expect(ingestPolicy(plain, KAN).decide({ checkId: 'DATUM-04', status: 'FAIL' }, 'NOTA')).toBe('pass');
    expect(ingestPolicy(plain, KAN).decide({ checkId: 'DATUM-04', status: 'PASS' }, 'TERBIT')).toBe('pass');
  });

  // D-263: judul 2.4/11.1 Manual 000 tidak berakhiran "?" -> DATUM-04 tidak lagi menahan; G3 tetap.
  it('benchmark Manual 000: profil benchmark tanpa penanda -> 0 FAIL penahan; profil kanonik tanpa penanda -> G3 menahan', () => {
    const doc = loadBenchmarkDoc();
    expect(byConstructionChecks(doc, BM)).toEqual([]);
    const noMarker: typeof doc = { ...doc };
    delete noMarker.x;
    expect(fails(byConstructionChecks(noMarker, BM))).toEqual([]);
    expect(fails(byConstructionChecks(noMarker, KAN))).toEqual(['G3']);
  });
});

describe('runLint: laporan jujur, status rilis per tier', () => {
  it('setiap entri registri dilaporkan tepat satu kali per cek atau lebih (beralamat); render NOT_RUN di tahap ingest', () => {
    const rep = runLint({ snapshot: snapshotOf(makeDoc()), tpl: KAN, tier: 'TERBIT', stage: 'ingest' });
    const ids = new Set(rep.checks.map((c) => c.checkId));
    for (const d of LINT_REGISTRY) expect(ids.has(d.id), d.id).toBe(true);
    for (const d of LINT_REGISTRY.filter((x) => x.module === 'render')) {
      expect(statuses(rep.checks, d.id), d.id).toEqual(['NOT_RUN']);
    }
    for (const d of LINT_REGISTRY.filter((x) => x.module === 'human')) {
      expect(statuses(rep.checks, d.id), d.id).toEqual(['NOT_RUN']);
    }
    expect(rep.banner).toContain('berkas tidak ditahan (A10)');
  });

  it('tahap post: cek render tidak diisi NOT_RUN oleh runner (ditambahkan pemanggil)', () => {
    const rep = runLint({ snapshot: snapshotOf(makeDoc()), tpl: KAN, tier: 'TERBIT', stage: 'post' });
    expect(rep.checks.filter((c) => LINT_REGISTRY.find((d) => d.id === c.checkId)?.module === 'render')).toEqual([]);
    expect(rep.banner).toMatch(/cek modul render ditambahkan pemanggil/);
  });

  it('NOTA: hanya 4 cek struktur v2 berlaku (D-178); FAIL scan tier lain tidak menahan; slot berisi -> rilis PASS (D-180)', () => {
    // SR-42: sebelum SR-18 tidak ada cek bertier NOTA (rilis NOT_RUN + banner
    // "lint tidak diwajibkan"). D-178 menjadikan LD-01..LD-04 bertier semua;
    // D-180: NOTA dengan bab berisi -> SLOT_CONTENT_MISSING PASS -> rilis PASS.
    const rep = runLint({ snapshot: snapshotOf(makeDoc({ tier: 'NOTA', sectionTitle: QUESTION })), tpl: KAN, tier: 'NOTA', stage: 'ingest' });
    expect(LINT_REGISTRY.filter((d) => appliesToTier(d.id, 'NOTA')).map((d) => d.id).sort()).toEqual(['CONTENT_CHAPTER_GAP', 'INLINE_FORMAT_STRIPPED', 'SCHEMA_V1_ADAPTED', 'SLOT_CONTENT_MISSING']);
    expect(statuses(rep.checks, 'SLOT_CONTENT_MISSING')).toEqual(['PASS']);
    expect(rep.releaseStatus).toBe('PASS');
    expect(rep.banner).not.toContain('lint tidak diwajibkan pada tier NOTA');
  });

  it('TERBIT dengan FAIL -> rilis FAIL; gate.lintFailureBlocksRelease=false -> PASS dengan catatan', () => {
    const snap = snapshotOf(makeDoc({ sectionTitle: QUESTION }));
    expect(runLint({ snapshot: snap, tpl: KAN, tier: 'TERBIT', stage: 'ingest' }).releaseStatus).toBe('FAIL');
    const lenient = withParams(KAN, { 'gate.lintFailureBlocksRelease': false });
    const rep = runLint({ snapshot: snap, tpl: lenient, tier: 'TERBIT', stage: 'ingest' });
    expect(rep.releaseStatus).toBe('PASS');
    expect(rep.banner).toMatch(/FAIL tidak menahan rilis \(P16-01 false\)/);
  });

  it('override profil "report" mengubah FAIL scan -> REPORT; "off" -> satu NOT_RUN', () => {
    const snap = snapshotOf(makeDoc({ sectionTitle: QUESTION, blocks: [{ type: 'paragraph', text: 'Panjang 12mm.' }] }));
    const tpl = withParams(KAN, { 'lint.enforcementOverride': { 'DATUM-04': 'report', 'DATUM-16': 'off' } });
    const rep = runLint({ snapshot: snap, tpl, tier: 'TERBIT', stage: 'ingest' });
    expect(statuses(rep.checks, 'DATUM-04')).toEqual(['REPORT']);
    expect(statuses(rep.checks, 'DATUM-16')).toEqual(['NOT_RUN']);
  });

  it('snapshot rusak: modul gagal dilaporkan NOT_RUN beralasan, runLint tidak melempar', () => {
    const broken = { schema: 'studio.norm/v1', doc: null, units: [], blocks: [], numbering: {}, register: {} } as never;
    const rep = runLint({ snapshot: broken, tpl: KAN, tier: 'TERBIT', stage: 'ingest' });
    // Status rilis saat modul crash diuji terpisah: lint-runner-fault.test.ts (temuan F-S71-1).
    expect(statuses(rep.checks, 'DATUM-04')).toEqual(['NOT_RUN']);
    expect(statuses(rep.checks, 'DATUM-01')).toEqual(['NOT_RUN']);
    expect(rep.checks.some((c) => c.status === 'NOT_RUN' && /tidak dijalankan/.test(c.detail ?? ''))).toBe(true);
  });

  it('assembleLintReport: tier tidak dikenal jatuh ke NOTA; tanpa isu -> semua NOT_RUN dengan alasan', () => {
    const rep = assembleLintReport({ tier: 'XYZ', stage: 'ingest', issues: [], params: {} });
    expect(rep.tier).toBe('NOTA');
    expect(rep.checks.every((c) => c.status === 'NOT_RUN' && (c.detail ?? '').length > 0)).toBe(true);
  });

  it('benchmark Manual 000 (profil benchmark): rilis FAIL dilaporkan, NOT-RUN jujur, deterministik', () => {
    const doc = loadBenchmarkDoc();
    const snap = snapshotOf(doc);
    const a = runLint({ snapshot: snap, tpl: BM, tier: 'TERBIT', stage: 'ingest' });
    const b = runLint({ snapshot: snap, tpl: BM, tier: 'TERBIT', stage: 'ingest' });
    expect(a).toEqual(b);
    expect(a.releaseStatus).toBe('FAIL');
    expect(a.banner).toMatch(/NOT-RUN \d+ \(alasan per cek\)/);
    expect(a.checks.filter((c) => c.status === 'NOT_RUN').every((c) => (c.detail ?? '').trim().length > 0)).toBe(true);
  });
});
