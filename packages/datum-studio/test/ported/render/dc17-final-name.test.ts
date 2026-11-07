// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/render/dc17-final-name.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-17: nama berkas final (register 05 §10 FN-01..FN-08, I59-I62, C51-C53).
import { describe, expect, it } from '../_vitest';
import {
  FINAL_ARTIFACT_PREFIX,
  FINAL_DOC_NUMBER_MAX,
  FINAL_FILENAME_PATTERN,
  docNumberSafe,
  finalFileNameOf,
  formatFinalFileName,
  parseFinalFileName,
  type FinalFileNameParts,
} from '@/lib/studio/services/render/final-name';

const SHA = '55d324b1' + 'a0'.repeat(28);
const AT = new Date('2026-10-30T12:58:00.000Z');
const EXAMPLE = '003-GSP-KT-X-2026_rev12_20261030T125800Z_55d324b1.html';

describe('konstanta C51-C53', () => {
  it('bernilai sesuai register', () => {
    expect(FINAL_DOC_NUMBER_MAX).toBe(80);
    expect(FINAL_ARTIFACT_PREFIX).toBe('ART-');
    expect(new RegExp(FINAL_FILENAME_PATTERN).test(EXAMPLE)).toBe(true);
  });
});

describe('contoh register (FN-01, FN-05)', () => {
  it('finalFileNameOf menghasilkan nama contoh', () => {
    const name = finalFileNameOf(
      { createdAt: AT, sha256: SHA, format: 'HTML' },
      { docNumber: '003/GSP/KT/X/2026', revisionNo: 12 },
    );
    expect(name).toBe(EXAMPLE);
  });
  it('sha huruf besar diturunkan; ekstensi dari FORMAT_EXT', () => {
    const f = (format: 'DOCX' | 'PDF' | 'SVG' | 'PNG') =>
      finalFileNameOf({ createdAt: AT, sha256: SHA.toUpperCase(), format }, { docNumber: 'A1', revisionNo: 1 });
    expect(f('DOCX')).toBe('A1_rev1_20261030T125800Z_55d324b1.docx');
    expect(f('PDF')).toMatch(/\.pdf$/);
    expect(f('SVG')).toMatch(/\.svg$/);
    expect(f('PNG')).toMatch(/\.png$/);
  });
  it('parse contoh', () => {
    expect(parseFinalFileName(EXAMPLE)).toEqual({
      docNumberSafe: '003-GSP-KT-X-2026',
      revisionNo: 12,
      renderedAt: '2026-10-30T12:58:00Z',
      sha8: '55d324b1',
      ext: 'html',
    });
  });
});

describe('docNumberSafe (FN-02)', () => {
  it('aturan 1: runtun karakter asing menjadi satu "-"', () => {
    expect(docNumberSafe('003/GSP/KT/X/2026')).toBe('003-GSP-KT-X-2026');
    expect(docNumberSafe('a b\tc')).toBe('a-b-c');
    expect(docNumberSafe('aéèb')).toBe('a-b');
    expect(docNumberSafe('a_b')).toBe('a-b');
  });
  it('aturan 2: "-" beruntun dirapatkan', () => {
    expect(docNumberSafe('a--b---c')).toBe('a-b-c');
    expect(docNumberSafe('a - b')).toBe('a-b');
    expect(docNumberSafe('a///b')).toBe('a-b');
  });
  it('aturan 3: "-" dan "." di awal/akhir dibuang; titik di tengah tetap', () => {
    expect(docNumberSafe('..abc-.-')).toBe('abc');
    expect(docNumberSafe('/x.y/')).toBe('x.y');
    expect(docNumberSafe('-.v1.2.-')).toBe('v1.2');
  });
  it('aturan 4: dipotong 80 lalu "-"/"." akhir dibuang lagi', () => {
    expect(docNumberSafe('a'.repeat(100))).toBe('a'.repeat(80));
    expect(docNumberSafe('a'.repeat(79) + '-bcd')).toBe('a'.repeat(79));
    expect(docNumberSafe('a'.repeat(78) + '.-.x')).toBe('a'.repeat(78));
    expect(docNumberSafe('a'.repeat(80)).length).toBe(80);
  });
  it('aturan 5: kosong menjadi DOC', () => {
    expect(docNumberSafe('')).toBe('DOC');
    expect(docNumberSafe('///')).toBe('DOC');
    expect(docNumberSafe('..-.')).toBe('DOC');
  });
  it('hasil selalu cocok C51 dan idempoten', () => {
    for (const raw of ['', '//', '003/GSP/KT/X/2026', 'x'.repeat(200), '.a.', 'é']) {
      const s = docNumberSafe(raw);
      const name = formatFinalFileName({ docNumberSafe: s, revisionNo: 1, renderedAt: '2026-01-02T03:04:05Z', sha8: 'abcdef01', ext: 'png' });
      expect(parseFinalFileName(name)).not.toBeNull();
      expect(docNumberSafe(s)).toBe(s);
    }
  });
});

describe('artefak (FN-03)', () => {
  it('rev0 dan awalan ART-, karakter asing dibuang', () => {
    const name = finalFileNameOf({ createdAt: AT, sha256: SHA, format: 'PNG' }, { artifactId: 'cm_x!y-9' });
    expect(name).toBe('ART-cmxy-9_rev0_20261030T125800Z_55d324b1.png');
    expect(parseFinalFileName(name)?.revisionNo).toBe(0);
  });
  it('id kosong atau terlalu panjang tetap cocok C51', () => {
    const empty = finalFileNameOf({ createdAt: AT, sha256: SHA, format: 'SVG' }, { artifactId: '$$$' });
    expect(empty).toBe('ART_rev0_20261030T125800Z_55d324b1.svg');
    const long = finalFileNameOf({ createdAt: AT, sha256: SHA, format: 'SVG' }, { artifactId: 'z'.repeat(200) });
    expect(parseFinalFileName(long)?.docNumberSafe.length).toBe(80);
  });
});

describe('waktu (FN-04)', () => {
  it('detik dipotong, bukan dibulatkan', () => {
    const name = finalFileNameOf(
      { createdAt: new Date('2026-10-30T12:58:59.999Z'), sha256: SHA, format: 'HTML' },
      { docNumber: 'D', revisionNo: 3 },
    );
    expect(name).toContain('_20261030T125859Z_');
  });
  it('UTC tanpa memandang zona proses', () => {
    const name = finalFileNameOf(
      { createdAt: new Date('2026-12-31T23:59:59.500Z'), sha256: SHA, format: 'HTML' },
      { docNumber: 'D', revisionNo: 1 },
    );
    expect(name).toContain('_20261231T235959Z_');
  });
  it('Date tidak sah melempar RangeError', () => {
    expect(() => finalFileNameOf({ createdAt: new Date(NaN), sha256: SHA, format: 'HTML' }, { docNumber: 'D', revisionNo: 1 })).toThrow(RangeError);
  });
});

describe('bolak-balik (FN-08)', () => {
  const docs = ['003/GSP/KT/X/2026', 'A', 'a.b-c', '12', 'DOC-1', 'x'.repeat(80), 'Rev 2 / Final', '..x..', 'unï/cödé', ''];
  const revs = [0, 1, 12, 999999];
  const stamps = ['2026-10-30T12:58:00Z', '2028-02-29T00:00:00Z', '2026-12-31T23:59:59Z'];
  const exts: FinalFileNameParts['ext'][] = ['docx', 'pdf', 'html', 'svg', 'png'];
  const cases: FinalFileNameParts[] = [];
  docs.forEach((d, i) => {
    cases.push({
      docNumberSafe: docNumberSafe(d),
      revisionNo: revs[i % revs.length],
      renderedAt: stamps[i % stamps.length],
      sha8: SHA.slice(0, 7) + String(i % 10),
      ext: exts[i % exts.length],
    });
  });
  for (const e of exts) {
    cases.push({ docNumberSafe: 'Z9', revisionNo: 7, renderedAt: stamps[0], sha8: '0123abcd', ext: e });
  }
  for (const r of revs) {
    cases.push({ docNumberSafe: 'R', revisionNo: r, renderedAt: stamps[1], sha8: 'deadbeef', ext: 'pdf' });
  }
  cases.push({ docNumberSafe: 'a--b', revisionNo: 2, renderedAt: stamps[2], sha8: '00000000', ext: 'docx' });

  it('memuat minimal 20 kasus', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
  it.each(cases.map((c, i) => [i, c] as const))('kasus %i: parse(format(x)) = x dan format(parse(n)) = n', (_i, parts) => {
    const name = formatFinalFileName(parts);
    const back = parseFinalFileName(name);
    expect(back).toEqual(parts);
    expect(formatFinalFileName(back as FinalFileNameParts)).toBe(name);
  });
});

describe('penolakan parser (FN-08)', () => {
  const ok = (stamp: string) => `X_rev1_${stamp}_55d324b1.pdf`;
  it('tanggal kalender atau jam tidak sah -> null', () => {
    expect(parseFinalFileName(ok('20261301T000000Z'))).toBeNull(); // bulan 13
    expect(parseFinalFileName(ok('20260230T000000Z'))).toBeNull(); // 30 Februari
    expect(parseFinalFileName(ok('20260229T000000Z'))).toBeNull(); // 2026 bukan kabisat
    expect(parseFinalFileName(ok('20260431T000000Z'))).toBeNull(); // 31 April
    expect(parseFinalFileName(ok('20260000T000000Z'))).toBeNull();
    expect(parseFinalFileName(ok('20261030T240000Z'))).toBeNull();
    expect(parseFinalFileName(ok('20261030T006000Z'))).toBeNull();
    expect(parseFinalFileName(ok('20261030T000060Z'))).toBeNull();
    expect(parseFinalFileName(ok('20280229T000000Z'))?.renderedAt).toBe('2028-02-29T00:00:00Z');
  });
  it('nama tak cocok regex C51 -> null', () => {
    const bad = [
      '',
      'X_rev1_20261030T125800Z_55d324b1.txt',
      'X_rev1_20261030T125800Z_55D324B1.pdf',
      'X_rev1_20261030T125800Z_55d324b.pdf',
      'X_rev01_20261030T125800Z_55d324b1.pdf',
      'X_rev1000000_20261030T125800Z_55d324b1.pdf',
      'X_rev_20261030T125800Z_55d324b1.pdf',
      '-X_rev1_20261030T125800Z_55d324b1.pdf',
      'X._rev1_20261030T125800Z_55d324b1.pdf',
      'A_B_rev1_20261030T125800Z_55d324b1.pdf',
      `${'a'.repeat(81)}_rev1_20261030T125800Z_55d324b1.pdf`,
      'dir/X_rev1_20261030T125800Z_55d324b1.pdf',
      'X_rev1_20261030T125800Z_55d324b1.pdf\n',
      'X_rev1_2026-10-30T12:58:00Z_55d324b1.pdf',
    ];
    for (const n of bad) expect(parseFinalFileName(n), n).toBeNull();
  });
});
