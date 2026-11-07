// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/trust-override.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S71: override penegakan dan penanda benchmark hanya dari pemanggil
// tepercaya (D-91, D-98, D-102). Mesin (engine/lint, engine/bind) membaca
// dokumen apa adanya; gerbang kepercayaan ada di services/ingest/trust.ts dan
// services/templates/access.ts. Uji ini menyambung keduanya tanpa DB:
// pembersihan untuk pemanggil tak tepercaya -> mesin kembali menahan.
import { describe, it, expect, beforeAll } from '../_vitest';
import type { ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { CALLER_KINDS, type CallerKind } from '@/lib/studio/contract/enums';
import { byConstructionChecks } from '@/lib/studio/engine/lint/scan';
import { isVerbatimReproduction } from '@/lib/studio/engine/bind';
import {
  BENCHMARK_MARKER_STRIPPED,
  ENFORCEMENT_OVERRIDE_STRIPPED,
  enforcementStrippedNotice,
  isBenchmarkTrusted,
  stripBenchmarkMarkers,
  stripEnforcementOverride,
  strippedNotice,
} from '@/lib/studio/services/ingest/trust';
import { isTrustedCaller, templateRestriction } from '@/lib/studio/services/templates/access';
import { benchmarkTemplate, canonicalTemplate, dataTable, makeDoc } from './fixtures';

let KAN: ResolvedTemplate;
let BM: ResolvedTemplate;
beforeAll(async () => {
  KAN = canonicalTemplate();
  BM = await benchmarkTemplate();
});

const UNTRUSTED: CallerKind[] = CALLER_KINDS.filter((k) => k !== 'ADMIN_SESSION');
const fails = (xs: ReadonlyArray<{ checkId: string; status: string }>) => [...new Set(xs.filter((x) => x.status === 'FAIL').map((x) => x.checkId))].sort();

/** Jalur ingest yang disederhanakan: buang penanda + override dokumen bila pemanggil tidak tepercaya. */
function sanitize(doc: StudioDocV1, caller: CallerKind, opts: { trustedHarness?: boolean } = {}): StudioDocV1 {
  if (isTrustedCaller({ kind: caller }, opts)) return doc;
  return stripEnforcementOverride(stripBenchmarkMarkers(doc).doc).doc;
}

describe('isTrustedCaller / isBenchmarkTrusted', () => {
  it('hanya ADMIN_SESSION atau trustedHarness', () => {
    expect(isTrustedCaller({ kind: 'ADMIN_SESSION' })).toBe(true);
    for (const k of UNTRUSTED) {
      expect(isTrustedCaller({ kind: k }), k).toBe(false);
      expect(isTrustedCaller({ kind: k }, { trustedHarness: true }), k).toBe(true);
      expect(isBenchmarkTrusted({ kind: k }, {}), k).toBe(false);
    }
    expect(isTrustedCaller(null)).toBe(false);
    expect(isTrustedCaller(undefined, {})).toBe(false);
  });

  it('trustedHarness harus boolean true persis (nilai truthy dari body tidak lolos)', () => {
    for (const v of ['true', 1, {}, []]) {
      expect(isTrustedCaller({ kind: 'USER_SESSION' }, { trustedHarness: v as unknown as boolean }), JSON.stringify(v)).toBe(false);
    }
  });

  it('kind palsu / huruf berbeda tidak dianggap admin', () => {
    for (const k of ['admin_session', 'ADMINISTRATOR', ' ADMIN_SESSION', '']) {
      expect(isTrustedCaller({ kind: k as CallerKind }), k).toBe(false);
    }
  });
});

describe('stripBenchmarkMarkers / stripEnforcementOverride', () => {
  it('membuang x.benchmark, x.enforcement, x.lintEnforcement tanpa memutasi asli; x kosong dihapus', () => {
    const doc = makeDoc({ x: { benchmark: true, enforcement: 'report', lintEnforcement: { 'DATUM-04': 'release' } } });
    const snapshot = JSON.stringify(doc);
    const a = stripBenchmarkMarkers(doc);
    expect(a.stripped.sort()).toEqual(['/document/x/benchmark', '/document/x/enforcement']);
    const b = stripEnforcementOverride(a.doc);
    expect(b.stripped).toEqual(['/document/x/lintEnforcement']);
    expect('x' in (b.doc as object)).toBe(false);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('kunci x lain dipertahankan; masukan bukan objek dikembalikan apa adanya', () => {
    const r = stripBenchmarkMarkers(makeDoc({ x: { benchmark: {}, catatan: 'tetap' } }));
    expect((r.doc as StudioDocV1).x).toEqual({ catatan: 'tetap' });
    expect(stripBenchmarkMarkers(null)).toEqual({ doc: null, stripped: [] });
    expect(stripBenchmarkMarkers('teks')).toEqual({ doc: 'teks', stripped: [] });
  });

  it('pemberitahuan pembuangan = REPORT (bukan penahan) dengan kode tetap', () => {
    expect(strippedNotice(['/document/x/benchmark'], { kind: 'USER_SESSION' })).toMatchObject({ checkId: BENCHMARK_MARKER_STRIPPED, status: 'REPORT' });
    expect(enforcementStrippedNotice(['/document/x/lintEnforcement'], { kind: 'INTERNAL_AGENT' })).toMatchObject({
      checkId: ENFORCEMENT_OVERRIDE_STRIPPED,
      status: 'REPORT',
    });
  });
});

describe('ujung ke ujung tanpa DB: override/penanda dihormati hanya dari pemanggil tepercaya', () => {
  const offending = () =>
    makeDoc({
      sectionTitle: 'Bagaimana cara memasang panel?',
      blocks: [dataTable({ badRow: true })],
      x: { benchmark: true, lintEnforcement: { 'DATUM-04': 'release' } },
    });

  it('pemanggil tak tepercaya: penanda + override dibuang -> DATUM-04 dan G1 kembali menahan', () => {
    for (const k of UNTRUSTED) {
      expect(fails(byConstructionChecks(sanitize(offending(), k), KAN)), k).toEqual(['DATUM-04', 'G1']);
    }
  });

  it('ADMIN_SESSION / harness: penanda dihormati (D-34 -> tidak menahan)', () => {
    expect(byConstructionChecks(sanitize(offending(), 'ADMIN_SESSION'), KAN)).toEqual([]);
    expect(byConstructionChecks(sanitize(offending(), 'USER_SESSION', { trustedHarness: true }), KAN)).toEqual([]);
  });

  it('reproduksi verbatim turunan: setelah pembersihan pemanggil tak tepercaya tidak berlaku', () => {
    const der = {
      type: 'derivation',
      title: { text: 'Turunan uji' },
      lines: [{ label: { text: 'kolom' }, value: { text: '128 mm' }, mark: 'TERUKUR' }],
      closing: { text: 'Bila halaman berubah, turunkan ulang.' },
    } as never;
    const doc = makeDoc({ x: { benchmark: true } });
    expect(isVerbatimReproduction(sanitize(doc, 'ADMIN_SESSION'), der)).toBe(true);
    for (const k of UNTRUSTED) expect(isVerbatimReproduction(sanitize(doc, k), der), k).toBe(false);
  });

  it('templateRestriction: profil benchmark TERBATAS (melepas cek penolak), kanonik tidak', () => {
    expect(templateRestriction(BM.params)).toEqual({ restricted: true, releasedChecks: ['DATUM-04', 'DATUM-09', 'G3'] });
    expect(templateRestriction(KAN.params)).toEqual({ restricted: false, releasedChecks: [] });
    expect(templateRestriction(null)).toEqual({ restricted: false, releasedChecks: [] });
    // Menaikkan ke block atau melepas cek non-penolak tidak membuat TERBATAS.
    expect(templateRestriction({ ...KAN.params, 'lint.enforcementOverride': { 'DATUM-03': 'off', 'DATUM-04': 'block' } }).restricted).toBe(false);
    expect(templateRestriction({ ...KAN.params, 'lint.enforcementOverride': { G1: 'off' } }).restricted).toBe(true);
  });
});
