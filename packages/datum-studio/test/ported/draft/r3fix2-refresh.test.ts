// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/r3fix2-refresh.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// R3-F2 (D-446, D-448; review gateway_check/15b N1..N5 + Low): siklus perbaikan 3/3 "tanpa lost update".
// N1 BASE_CONFLICT mendaftar semua bagian yang diubah pihak lain + pemulihan `refresh` (gabung per bagian,
// penanda konflik, berkas agen hanya ditulis --write); N2 konversi balik lossless (bolak-balik identik per
// jenis blok); N3 (dibalik R3-F3: tulisan sendiri ber-basis lama = BASE_CONFLICT); N4 butir/bukti/rujukan hanya terhapus eksplisit;
// N5 judul bab tambahan berformat. Server tiruan BERKEADAAN (dua penulis lewat CLI yang sama), fs di-mock.
/* eslint-disable @typescript-eslint/no-explicit-any -- server tiruan berkeadaan memanipulasi JSON proyeksi R20 bebas bentuk */
import { describe, it, expect } from '../_vitest';
import { parseArgs } from '../../../vendor/scripts/studio/studio-report';
import {
  assembleReportMarkdown,
  chapterToReportMarkdown,
  inlineToMarkdown,
  mdReportToBlocks,
  newSerializeCtx,
  recordToReportMarkdown,
  referencesToReportMarkdown,
  sameStructure,
  type AssemblePart,
} from '../../../vendor/src/lib/studio/services/draft/md-report';
import { A, B, DOC, DOC_KEY, ITEMS, keyOf, MD, memFs, MISSION, RICH_B, run, statefulServer, textOf } from './r3-stateful-harness';

describe('N1 BASE_CONFLICT mendaftar semua bagian + pemulihan refresh (dua penulis, skenario review Q11)', () => {
  it('B mengubah bab 1 dan bab 3; A (basis rev6) mengubah bab 3 -> konflik + daftar bab 1, bab 3; refresh; update; suntingan B di bab 1 TETAP', async () => {
    const s = statefulServer(MD());
    // Penulis B (basis rev6) lewat CLI yang sama.
    const b = await run(['update', DOC, 'b.md', '--remote', 'http://h', '--agent-id', B, '--json'], { fetch: s.f, fs: memFs({ 'b.md': MD({ bab1: 'Ringkasan PENULIS-B kedua.', bab3: RICH_B }) }).fsx });
    expect(b.code).toBe(0);
    expect(s.rev()).toBe(8);
    const bab1B = textOf(s.chapter('1'));
    const bab3B = s.chapter('3');
    // A basi (basis rev6) mengubah bab 3.
    s.reset();
    const aMd = MD({ bab3: ['Bukti awal diperluas A.'] });
    const fa = memFs({ 'a.md': aMd });
    const c = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(c.code).toBe(1);
    expect(s.posts()).toHaveLength(0);
    const fatal = JSON.parse(c.out).fatal;
    expect(fatal.code).toBe('BASE_CONFLICT');
    expect(fatal.details).toMatchObject({ basisRevisionNo: 6, latestRevisionNo: 8, changedByOthers: ['bab 1', 'bab 3'], conflicts: ['bab 3'] });
    expect(fatal.message).toContain('bab 1');
    expect(fatal.message).toContain('refresh');
    expect(fatal.message).not.toMatch(/ganti baris basis menjadi/); // tidak menyuruh mengganti basis lalu menimpa
    // Petunjuk N1 yang LAMA (ganti basis ke rev8 tanpa refresh) kini aman pun: bab 1 tetap, tetapi petunjuknya = refresh.
    // refresh: tanpa --write berkas agen TIDAK ditulis; stdout = laporan gabungan; bab 3 bertanda konflik.
    const r = await run(['refresh', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A], { fetch: s.f, fs: fa.fsx });
    expect(r.code).toBe(1);
    expect(fa.writes).toEqual([]);
    expect(fa.files['a.md']).toBe(aMd);
    expect(s.posts()).toHaveLength(0); // refresh tidak pernah mengirim
    expect(r.out).toContain(`basis: ${DOC}@rev8`);
    expect(r.out).toContain('Ringkasan PENULIS-B kedua.');
    expect(r.out).toMatch(/<<<<<<< ANDA: bab 3[\s\S]*Bukti awal diperluas A\.[\s\S]*=======[\s\S]*PENULIS-B[\s\S]*>>>>>>> SERVER: bab 3/);
    expect(r.err).toContain('bab 1: diambil dari server');
    expect(r.err).toContain('bab 3: KONFLIK');
    // Laporan berpenanda ditolak sampai diselesaikan.
    const marked = await run(['update', DOC, 'm.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 'm.md': r.out }).fsx });
    expect(marked.code).toBe(1);
    expect(marked.err).toContain('MERGE_CONFLICT_MARKER');
    expect(s.posts()).toHaveLength(0);
    // --write menulis berkas agen (eksplisit).
    const w = await run(['refresh', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--write'], { fetch: s.f, fs: fa.fsx });
    expect(w.code).toBe(1);
    expect(fa.writes).toEqual(['text a.md']);
    // A menyelesaikan konflik: ambil versi server (B) + tambah satu paragraf.
    const resolved = fa.files['a.md'].replace(/<<<<<<< ANDA: bab 3[\s\S]*?=======\n/, '').replace(/>>>>>>> SERVER: bab 3.*\n/, '').replace('Paragraf polos B.', 'Paragraf polos B.\n\nTambahan A sesudah refresh.');
    s.reset();
    const u = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--json'], { fetch: s.f, fs: memFs({ 'a.md': resolved }).fsx });
    expect(u.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['3']);
    expect(s.posts()[0].body.baseRevisionNo).toBe(8);
    expect(textOf(s.chapter('1'))).toBe(bab1B); // suntingan B di bab 1 TETAP
    const bab3 = s.chapter('3');
    // Isi berformat B utuh (blok kode, kutipan, tabel, run) + tambahan A.
    expect(sameStructure(bab3.sections[0].blocks.slice(0, bab3B.sections[0].blocks.length), bab3B.sections[0].blocks)).toBe(true);
    expect(JSON.stringify(bab3)).toContain('Tambahan A sesudah refresh.');
    expect(JSON.parse(u.out).nextBasis).toBe(`basis: ${DOC}@rev9`);
  });

  it('B mengubah bab 1 saja, A (basis rev6) mengubah bab 3 -> bab 3 terkirim, bab 1 didaftar (tidak ditimpa); refresh bersih rc 0 -> update 0 kiriman, bab 1 B tetap', async () => {
    const s = statefulServer(MD());
    expect((await run(['update', DOC, 'b.md', '--remote', 'http://h', '--agent-id', B], { fetch: s.f, fs: memFs({ 'b.md': MD({ bab1: 'Ringkasan oleh B.' }) }).fsx })).code).toBe(0);
    const bab1B = textOf(s.chapter('1'));
    s.reset();
    const fa = memFs({ 'a.md': MD({ bab3: ['Bukti oleh A.'] }) });
    const u = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(u.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['3']);
    const j = JSON.parse(u.out);
    expect(j.changedByOthers).toEqual(['bab 1']);
    expect(j.delta.stale).toEqual(['bab 1']);
    expect(j.nextBasis).toBeNull();
    expect(j.nextBasisNote).toContain('refresh');
    expect(j.nextBasisNote).not.toContain('pertahankan baris basis lama');
    const h = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A], { fetch: s.f, fs: fa.fsx });
    expect(h.out).toContain('isi terkini bab 1 diubah pihak lain');
    expect(h.out).not.toContain('Ringkasan oleh B.'); // tidak dicetak untuk disalin
    // refresh --out-md: bersih (rc 0), berkas agen tidak disentuh, basis terkini.
    const r = await run(['refresh', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--out-md', 'segar.md', '--json'], { fetch: s.f, fs: fa.fsx });
    expect(r.code).toBe(0);
    const rj = JSON.parse(r.out);
    expect(rj).toMatchObject({ ok: true, conflicts: [], written: 'segar.md', basis: { from: 6, to: 8 } });
    expect(rj.parts).toEqual(expect.arrayContaining([{ part: 'bab 1', action: 'server' }, { part: 'bab 3', action: 'sama' }]));
    expect(fa.writes).toEqual(['text segar.md']);
    s.reset();
    const u2 = await run(['update', DOC, 'segar.md', '--remote', 'http://h', '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(u2.code).toBe(0);
    expect(s.posts()).toHaveLength(0); // salinan setara terkini: tidak ada yang dikirim
    expect(textOf(s.chapter('1'))).toBe(bab1B);
    expect(JSON.parse(u2.out).nextBasis).toBe(`basis: ${DOC}@rev8`);
  });

  it('refresh: tanpa basis -> BASIS_MISSING rc 1 tanpa jaringan; --out-md ke laporan sendiri -> rc 2; --write + --out-md -> galat pemakaian; refresh draf json -> rc 2', async () => {
    const r = await run(['refresh', DOC, 'a.md', '--remote', 'http://h'], { fs: memFs({ 'a.md': MD({ basis: null }) }).fsx });
    expect(r.code).toBe(1);
    expect(r.err).toContain('BASIS_MISSING');
    const s = statefulServer(MD());
    const self = await run(['refresh', DOC, 'a.md', '--remote', 'http://h', '--out-md', 'a.md'], { fetch: s.f, fs: memFs({ 'a.md': MD() }).fsx });
    expect(self.code).toBe(2);
    expect(() => parseArgs(['refresh', DOC, 'a.md', '--write', '--out-md', 'x.md'])).toThrow(/tidak boleh dipakai bersama/);
    expect(() => parseArgs(['update', DOC, 'a.md', '--out-md', 'x.md'])).toThrow(/hanya berlaku untuk refresh/);
    expect(() => parseArgs(['submit', 'a.md', '--allow-remove'])).toThrow(/hanya berlaku untuk update/);
    expect(parseArgs(['refresh', DOC, 'a.md', '--base-rev', '4'])).toMatchObject({ command: 'refresh', baseRev: 4, write: false, outMd: null });
    const json = await run(['refresh', DOC, 'd.md', '--remote', 'http://h'], { fetch: s.f, fs: memFs({ 'd.md': '# d\nbasis: baru\n\n```json\n{"$schema":"studio.slot/v2","slot":"record"}\n```\n' }).fsx });
    expect(json.code).toBe(2);
    expect(json.err).toContain('REFRESH_JSON_UNSUPPORTED');
  });

  it('bagian server yang tidak dapat ditulis lewat MD (blok chart) -> tidak ditulis, rc 0; update sesudahnya tidak menyentuhnya', async () => {
    const s = statefulServer(MD());
    // Penulis lain (draf json) memasang bab 4 dengan blok yang tidak punya padanan Markdown laporan.
    const chart = { $schema: 'studio.chapter/v2', agentId: B, target: { documentId: DOC }, chapter: { key: '4', title: { text: 'Isu terbuka' }, sections: [{ title: { text: 'Isu terbuka' }, blocks: [{ type: 'chart', spec: { kind: 'bar' } }] }] } };
    await s.f('http://h/api/studio/chapters', { method: 'POST', body: JSON.stringify(chart), headers: {} } as never);
    const fa = memFs({ 'a.md': MD() });
    const r = await run(['refresh', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--write', '--json'], { fetch: s.f, fs: fa.fsx });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.parts).toEqual(expect.arrayContaining([expect.objectContaining({ part: 'bab 4', action: 'tidak-terwakili' })]));
    expect(fa.files['a.md']).not.toContain('## Isu terbuka');
    expect(fa.files['a.md']).not.toContain('[blok');
    s.reset();
    const u = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(u.code).toBe(0);
    expect(s.posts()).toHaveLength(0);
    expect(s.chapter('4').sections[0].blocks[0].type).toBe('chart');
  });
});

describe('N2 konversi balik lossless: MD -> payload -> MD -> payload identik untuk setiap jenis blok', () => {
  const RICH = [
    '# Laporan bolak-balik',
    '',
    `mission: ${MISSION}`,
    `docKey: ${DOC_KEY}`,
    'Status: partial',
    'Verdict: PASS',
    'Owner: cod-r3-f2',
    'Initiator: gsp-master01',
    'TaskRef: R3-F2',
    'ReportedAt: 2026-11-01T10:00+07:00',
    'CardIds: t_249c6b84',
    '',
    'Pembuka bab 1 dengan **tebal** dan t_11111111.',
    '',
    '## Ringkasan',
    '',
    'PENULIS-B: **lulus semua**, `kode`, *miring*, ***keduanya***, H<sub>2</sub>O, x<sup>2</sup>, a \\* b, a_b_c, \\_bukan miring\\_, [tautan](https://x.y/z).',
    '',
    'Baris satu<br>baris dua dan <b>tebal </b>berspasi.',
    '',
    '<!-- role: closingAction -->',
    'Tindakan penutup.',
    '',
    '[TERUKUR] Diukur 93 menit. [CATATAN: dicek ulang]',
    '',
    '[SUMBER: catatan lapangan] Paragraf bersumber.',
    '',
    '### Subjudul C#',
    '',
    '- satu',
    '- dua **tebal**',
    '  - bersarang (diratakan)',
    '- Owner: bukan medan kepala',
    '',
    '* daftar kedua bersebelahan',
    '',
    '1. pertama',
    '2. kedua',
    '',
    '1) daftar berurut kedua',
    '',
    'Tabel 1. ini paragraf biasa? tidak: menjadi caption tabel di bawah',
    '',
    '## Rincian kerja',
    '',
    '| key | judul | status | bukti |',
    '|---|---|---|---|',
    '| t_249c6b84 | Tulis **bab** | done | out/bab2.json 120 B sha 55d324b1 |',
    '| R3F2-1 | Pipa a\\|b | running |  |',
    '',
    'Tabel: Daftar butir',
    '',
    'Sumber: catatan agen [TERUKUR]',
    '',
    '## Bukti',
    '',
    '```text Keluaran uji',
    'Test Files 25 passed',
    '  baris ``` di dalam',
    '```',
    '',
    '```',
    'tanpa label',
    '```',
    '',
    '> [!DOCTRINE] Doktrin',
    '> Paragraf satu.',
    '>',
    '> - bukan daftar',
    '',
    '> Catatan B: jangan dihapus.',
    '',
    `![Diagram alir](sha256:${'a'.repeat(64)})`,
    '',
    'Sumber: dibuat agen [DITURUNKAN]',
    '',
    '---',
    '',
    'Paragraf polos B.',
    '',
    '## Isu terbuka',
    '',
    'Tidak ada. 1. bukan daftar',
    '',
    '## Langkah berikut',
    '',
    '- Lanjut.',
    '',
    '## Catatan *A* `x`',
    '',
    'Isi A.',
    '',
    '## Rujukan',
    '',
    '| hubungan | dokumen | paragraf | revisi |',
    '|---|---|---|---|',
    '| basis | cmvwbis1d01mkv1i8x3hhgsm3 | p-tadha0rs05 | 8 |',
    '',
    '## Referensi',
    '',
    '- Dokumen standar https://contoh.id/a_b',
    '- Buku *penting*',
    '',
  ].join('\n');

  const toMd = (md: string) => {
    const conv = mdReportToBlocks(md, { mode: 'create' });
    const ctx = newSerializeCtx();
    const parts: AssemblePart[] = conv.blocks.map((b: any) => {
      const p = b.slot === 'record' ? recordToReportMarkdown(b.payload, ctx) : b.slot === 'references' ? referencesToReportMarkdown(b.payload, ctx) : chapterToReportMarkdown(b.chapter, ctx);
      if (p === null) throw new Error(`tidak terwakili: ${ctx.why}`);
      return { part: b.slot ?? `bab ${b.chapter.key}`, one: p };
    });
    return { conv, md: assembleReportMarkdown({ title: conv.conversion.title, toolLines: [`mission: ${MISSION}`, `docKey: ${DOC_KEY}`], parts }) };
  };

  it('setiap bagian (record + 6 bab + references) identik sesudah bolak-balik; keluaran idempoten', () => {
    const one = toMd(RICH);
    const two = toMd(one.md);
    expect(two.conv.conversion.parts).toEqual(one.conv.conversion.parts);
    expect(one.conv.conversion.parts).toEqual(['record', 'bab 1', 'bab 2', 'bab 3', 'bab 4', 'bab 5', 'bab 6', 'references']);
    one.conv.blocks.forEach((b, i) => expect(sameStructure(two.conv.blocks[i], b), String(one.conv.conversion.parts[i])).toBe(true));
    expect(toMd(two.md).md).toBe(two.md);
    // Semua jenis blok importer hadir di sumber uji.
    const types = new Set(JSON.stringify(one.conv.blocks).match(/"type":"[a-zA-Z]+"/g));
    for (const t of ['paragraph', 'list', 'table', 'monoBlock', 'aside', 'image']) expect(types.has(`"type":"${t}"`), t).toBe(true);
    expect(JSON.stringify(one.conv.blocks)).toContain('"role":"subheading"');
    expect(JSON.stringify(one.conv.blocks)).toContain('"role":"closingAction"');
    expect(JSON.stringify(one.conv.blocks)).toContain('"rail"');
  });

  it('run {t} berformat tidak hilang (akar N2: inlineText lama mengabaikan t); bentuk tanpa padanan -> null, bukan teks penanda', () => {
    const runs = { runs: [{ t: 'PENULIS-B: ' }, { t: 'lulus semua', strong: true }, { t: ' ' }, { t: 'x`y', code: true }] };
    const md = inlineToMarkdown(runs);
    expect(md).toBe('PENULIS-B: **lulus semua** ``x`y``');
    expect(inlineToMarkdown({ runs: [{ t: 'a' }, { tab: true }, { t: 'b' }] })).toBeNull();
    const ctx = newSerializeCtx();
    expect(chapterToReportMarkdown({ key: '3', title: { text: 'Bukti' }, sections: [{ title: { text: 'Bukti' }, blocks: [{ type: 'chart' }] }] }, ctx)).toBeNull();
    expect(ctx.why).toContain('chart');
  });

  it('refresh bab 3 berformat milik B: hasil gabungan dikonversi ulang = payload server persis (blok kode/kutipan/run utuh)', async () => {
    const s = statefulServer(MD());
    expect((await run(['update', DOC, 'b.md', '--remote', 'http://h', '--agent-id', B], { fetch: s.f, fs: memFs({ 'b.md': MD({ bab3: RICH_B }) }).fsx })).code).toBe(0);
    const fa = memFs({ 'a.md': MD({ bab5: '- Lanjut oleh A.' }) });
    const r = await run(['refresh', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--out-md', 'g.md'], { fetch: s.f, fs: fa.fsx });
    expect(r.code).toBe(0);
    const g = fa.files['g.md'];
    expect(g).toContain('```text Keluaran uji');
    expect(g).toContain('> [!DOCTRINE] Catatan B');
    expect(g).not.toContain('[blok');
    const back = mdReportToBlocks(g, { mode: 'update', documentId: DOC }).blocks.find((b: any) => b.chapter?.key === '3') as any;
    expect(sameStructure(back.chapter, s.chapter('3'))).toBe(true);
    s.reset();
    const u = await run(['update', DOC, 'g.md', '--remote', 'http://h', '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(u.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['5']); // bab 3 B tidak dikirim ulang (setara), hanya suntingan A
  });
});

describe('N3 (dibalik R3-F3 / D-453, review 15c R1): tulisan sendiri dengan basis lama = BASE_CONFLICT; pulih lewat refresh --write', () => {
  it('A mengirim bab 5 (bab 3 basi milik B), lalu menyunting bab 5 lagi dengan basis lama -> BASE_CONFLICT + peringatan agentId; refresh --write -> bab 5 dikirim dengan basis baru', async () => {
    const s = statefulServer(MD());
    expect((await run(['update', DOC, 'b.md', '--remote', 'http://h', '--agent-id', B], { fetch: s.f, fs: memFs({ 'b.md': MD({ bab3: ['Bukti oleh B.'] }) }).fsx })).code).toBe(0);
    const first = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD({ agent: A, bab5: '- Langkah A v1.' }) }).fsx });
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out).nextBasis).toBeNull(); // bab 3 basi
    s.reset();
    const fa = memFs({ 'a.md': MD({ agent: A, bab5: '- Langkah A v2.' }) });
    const again = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: fa.fsx });
    expect(again.code).toBe(1);
    expect(s.posts()).toHaveLength(0); // server = wasit: tidak ada kiriman dengan revisi terkini
    const fatal = JSON.parse(again.out).fatal;
    expect(fatal).toMatchObject({ code: 'BASE_CONFLICT', details: { conflicts: ['bab 5'], changedByOthers: ['bab 3', 'bab 5'] } });
    expect(fatal.details.sameAgentWarnings).toHaveLength(1);
    expect(fatal.message).not.toContain('oleh Anda sendiri');
    // Pemulihan: refresh --write (bab 3 diambil dari server, bab 5 ditandai) -> pilih versi Anda -> terkirim.
    expect((await run(['refresh', DOC, 'a.md', '--remote', 'http://h', '--write'], { fetch: s.f, fs: fa.fsx })).code).toBe(1);
    fa.files['a.md'] = fa.files['a.md'].replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> [^\n]*\n/, '$1');
    const u = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: fa.fsx });
    expect(u.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['5']);
    expect(s.posts()[0].body.baseRevisionNo).toBe(8);
    expect(JSON.stringify(s.chapter('3'))).toContain('Bukti oleh B.');
    // Penulis lain (B) dengan agentId berbeda tetap konflik pada bab 5.
    s.reset();
    const other = await run(['update', DOC, 'b.md', '--remote', 'http://h', '--agent-id', B, '--json'], { fetch: s.f, fs: memFs({ 'b.md': MD({ basis: `${DOC}@rev7`, bab3: ['Bukti oleh B.'], bab5: '- Langkah B.' }) }).fsx });
    expect(other.code).toBe(1);
    expect(JSON.parse(other.out).fatal).toMatchObject({ code: 'BASE_CONFLICT', details: { conflicts: ['bab 5'] } });
    expect(s.posts()).toHaveLength(0);
  });
});

describe('N4 butir/bukti/rujukan hanya terhapus eksplisit', () => {
  it('status butir majemuk (baris ditolak) -> RECORD_ELEMENTS_DROPPED rc 1, 0 kiriman, daftar + alasan; ~~hapus~~ / --allow-remove -> terkirim', async () => {
    const s = statefulServer(MD());
    const bad = MD({ items: [ITEMS[0], '| R3F2-2 | Uji refresh | done dan diverifikasi | out/uji.txt 64 B sha 0a1b2c3d |'] });
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--json'], { fetch: s.f, fs: memFs({ 'a.md': bad }).fsx });
    expect(r.code).toBe(1);
    expect(s.posts()).toHaveLength(0);
    const fatal = JSON.parse(r.out).fatal;
    expect(fatal.code).toBe('RECORD_ELEMENTS_DROPPED');
    expect(fatal.details).toMatchObject({ items: ['R3F2-2'], evidence: ['out/uji.txt (butir R3F2-2)'] });
    expect(fatal.details.rejectedRows.join(' ')).toContain('compound');
    // Penghapusan eksplisit: sel status ~~hapus~~ -> butir + buktinya hilang, baris tidak tersisa di teks bab.
    const del = MD({ items: [ITEMS[0], '| R3F2-2 | Uji refresh | ~~hapus~~ | out/uji.txt 64 B sha 0a1b2c3d |'] });
    const d = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--agent-id', A, '--json'], { fetch: s.f, fs: memFs({ 'a.md': del }).fsx });
    expect(d.code).toBe(0);
    const rec = s.latest().sections.record;
    expect(rec.items.map((i: any) => i.key)).toEqual(['R3F2-1']);
    expect(rec.evidence.map((e: any) => e.ref)).toEqual(['out/probe.txt']);
    expect(JSON.stringify(s.chapter('2'))).not.toContain('R3F2-2');
    // --allow-remove: baris dihapus dari tabel tanpa tanda.
    const s2 = statefulServer(MD());
    const a2 = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--allow-remove', '--json'], { fetch: s2.f, fs: memFs({ 'a.md': MD({ items: [ITEMS[0]] }) }).fsx });
    expect(a2.code).toBe(0);
    expect(JSON.parse(a2.out).notices.join('\n')).toContain('--allow-remove');
  });

  it('rujukan: baris Rujukan dihapus -> ditolak; baris ~~hapus~~ -> terhapus', async () => {
    const REF = 'cmvwbis1d01mkv1i8x3hhgsm3';
    const withRefs = MD({ refs: [`| basis | ${REF} |  |  |`, `| bukti | ${REF} | p-tadha0rs05 | 8 |`] });
    const s = statefulServer(withRefs);
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD({ refs: [`| basis | ${REF} |  |  |`] }) }).fsx });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).fatal).toMatchObject({ code: 'RECORD_ELEMENTS_DROPPED', details: { refs: [`evidence ${REF}`] } });
    const d = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD({ refs: [`| basis | ${REF} |  |  |`, `| bukti | ${REF} | ~~hapus~~ |  |`] }) }).fsx });
    expect(d.code).toBe(0);
    expect(s.latest().sections.record.refs).toEqual([{ documentId: REF, rel: 'basis' }]);
  });
});

describe('N5 judul bab tambahan berformat', () => {
  it('Catatan *A* / Catatan *B* di dokumen: menyunting Catatan *B* + judul baru Catatan *Baru* -> bab 7 dan bab 8, tanpa AMBIGUOUS palsu, bab 6 tidak tertimpa', async () => {
    const s = statefulServer(MD({ extras: [['Catatan *A*', 'Isi A.'], ['Catatan *B*', 'Isi B.']] }));
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD({ extras: [['Catatan *B*', 'Isi B disunting.'], ['Catatan *Baru*', 'Baru.']] }) }).fsx });
    expect(r.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['7', '8']);
    expect(JSON.stringify(s.chapter('6'))).toContain('Isi A.');
    expect(JSON.parse(r.out).notInReport).toEqual(['bab 6 (Catatan A)']);
    // Judul ber-backtick dan bertautan juga dibaca teks polosnya.
    const s2 = statefulServer(MD({ extras: [['Catatan `kode`', 'Isi K.']] }));
    const r2 = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--json'], { fetch: s2.f, fs: memFs({ 'a.md': MD({ extras: [['Catatan `kode`', 'Isi K disunting.']] }) }).fsx });
    expect(r2.code).toBe(0);
    expect(s2.posts().map(keyOf)).toEqual(['6']);
  });
});

describe('Low: N6 --force-latest diabaikan diberitahukan, N7 alasan majemuk, N8 placeholder di blok kode', () => {
  it('N6: kepala berbasis + --force-latest -> pemberitahuan', async () => {
    const s = statefulServer(MD());
    const r = await run(['update', DOC, 'a.md', '--remote', 'http://h', '--force-latest', '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD() }).fsx });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).notices.join('\n')).toContain('--force-latest diabaikan');
  });
  it('N7: Status majemuk disebut di pesan MD2CONTRACT_REQUIRED_MISSING', () => {
    expect(() => mdReportToBlocks(MD({ basis: null }).replace('Status: partial', 'Status: complete dan sudah diverifikasi'), { mode: 'create' })).toThrow(/status "complete dan sudah diverifikasi" majemuk/);
  });
  it('N8: sintaks <isi: ...> di dalam blok kode tidak ditolak; di luar blok kode tetap ditolak', () => {
    const quoted = MD({ basis: null, bab3: ['```text', 'Status: <isi: draft atau complete>', '```'] });
    expect(() => mdReportToBlocks(quoted, { mode: 'create' })).not.toThrow();
    expect(() => mdReportToBlocks(MD({ basis: null, bab3: ['Status: <isi: x>'] }), { mode: 'create' })).toThrow(/placeholder/);
  });
});
