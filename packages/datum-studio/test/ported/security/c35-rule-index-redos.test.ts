// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/security/c35-rule-index-redos.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// C35 H-01 (CWE-1333): penanda indeks aturan tidak boleh ReDoS pada isi kiriman yang bermusuhan.
// Penanda hanya di awal teks; pola tanpa dua kuantor bersebelahan atas karakter yang sama.
import { describe, expect, it } from '../_vitest';
import { buildRuleIndex } from '@/lib/studio/engine/front/rule-index';

const p = (text: string) => ({ type: 'paragraph', text });
function snap(blocks: unknown[]) {
  return {
    schema: 'studio.norm/v2',
    doc: { meta: { language: 'ID' }, chapters: [{ key: '1', title: { text: 'Bab 1' }, sections: [{ title: { text: 'S' }, blocks }] }], appendices: [] },
    source: { sections: { content: { type: 'chapter', outline: [] } } },
    skeleton: { slots: [{ slotKey: 'content', sectionType: 'chapter' }] },
  } as never;
}
function timed<T>(fn: () => T): { ms: number; value: T } {
  const a = performance.now();
  const value = fn();
  return { ms: performance.now() - a, value };
}

describe('C35 H-01 buildRuleIndex: masukan bermusuhan selesai cepat', () => {
  it('100 kB: kode aturan lalu deret panjang "*" dan karakter penutup < 50 ms', () => {
    const text = 'DT-01' + '*'.repeat(100_000) + 'X';
    const r = timed(() => buildRuleIndex(snap([p(text)])));
    expect(r.value.entries).toEqual([]);
    expect(r.ms).toBeLessThan(50);
  });

  it('100 kB lewat runs (gabungan beberapa run sah) < 50 ms', () => {
    const runs = [{ t: 'DT-01' + '*'.repeat(19_995) }, ...Array.from({ length: 4 }, () => ({ t: '*'.repeat(20_000) })), { t: 'X' }];
    const r = timed(() => buildRuleIndex(snap([{ type: 'paragraph', runs }])));
    expect(r.value.entries).toEqual([]);
    expect(r.ms).toBeLessThan(50);
  });

  it('variasi pemisah bermusuhan (_ ` campur spasi, sesudah tingkat) < 50 ms', () => {
    const texts = [
      'PK-02' + '_'.repeat(50_000) + ' ' + '`'.repeat(50_000) + 'X',
      'DT-01 WAJIB' + '*'.repeat(100_000) + 'X',
      '*'.repeat(100_000) + 'X',
      'TB-04 ·' + ' '.repeat(50_000) + '*'.repeat(50_000) + 'X',
    ];
    for (const t of texts) {
      const r = timed(() => buildRuleIndex(snap([p(t)])));
      expect(r.ms).toBeLessThan(50);
    }
  });

  it('20 paragraf bermusuhan 20.000 karakter selesai cepat (< 100 ms total)', () => {
    const blocks = Array.from({ length: 20 }, () => p('DT-01' + '*'.repeat(19_990) + 'X'));
    const r = timed(() => buildRuleIndex(snap(blocks)));
    expect(r.value.entries).toEqual([]);
    expect(r.ms).toBeLessThan(100);
  });

  it('penanda sah di awal teks panjang tetap dikenali (batas 256 hanya untuk pemindaian penanda)', () => {
    const r = buildRuleIndex(snap([p('**DT-03** · WAJIB — Tulis angka dengan sumber. ' + 'isi '.repeat(10_000))]));
    expect(r.entries.map((e) => [e.code, e.level, e.summary])).toEqual([['DT-03', 'WAJIB', 'Tulis angka dengan sumber']]);
  });
});

// Oracle: pola lama apa adanya (sebelum C35). Bahasanya harus tetap sama persis pada masukan pendek.
const CODE_SRC = String.raw`DT-\d{2}[a-z]?|(?:PK|TB|GA|KD|CH|SM|IL|BP|EG)-\d{2}|SG-L\d-\d{2}|EN-L\d-\d{2}|EN-C-\d{2}`;
const LEVEL_SRC = 'WAJIB|BAKU|ANJURAN|MANDATORY|DEFAULT|ADVISORY';
const OLD_MD = '[*_`]*';
const OLD_MARKER_RE = new RegExp(
  String.raw`^${OLD_MD}(${CODE_SRC})(?![A-Za-z0-9-])${OLD_MD}\s*(?:[·•|:,—–(]\s*)?${OLD_MD}(${LEVEL_SRC})${OLD_MD}\)?(\s*\(PK\))?(?=$|[\s.:;,·•|—–)])`,
);

describe('C35 H-01 pola penanda baru: entri sama dengan pola lama', () => {
  it('semua kombinasi pemisah pendek menghasilkan kode dan tingkat yang sama dengan pola lama', () => {
    const pre = ['', '*', '**', '_', '`'];
    const sep = ['', ' ', '*', '**', ' *', '* ', '*  *', ' · ', '·', ': ', ' :', '( ', '(', ' — ', '–', '|', ', ', ' ,*', '*:*', ' * ', '::', ' · *', '\t'];
    const lvl = ['WAJIB', 'BAKU', 'MANDATORY', 'WAJIBX', 'wajib'];
    const post = ['', '*', '**', ')', '**)', ' (PK)', '** (PK)', '.', ':', 'X', ' isi', '*X'];
    let checked = 0;
    for (const a of pre)
      for (const s of sep)
        for (const l of lvl)
          for (const z of post) {
            const text = `${a}DT-01${s}${l}${z} Kalimat aturan.`;
            const old = OLD_MARKER_RE.exec(text);
            const got = buildRuleIndex(snap([p(text)])).entries;
            const want = old ? [[old[1], old[3] ? `${old[2]} (PK)` : old[2]]] : [];
            expect(got.map((e) => [e.code, e.level]), JSON.stringify(text)).toEqual(want);
            checked += 1;
          }
    expect(checked).toBeGreaterThan(5000);
  });
});
