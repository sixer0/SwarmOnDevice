// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/r3fix3-own-write.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// R3-F3 (D-453; review gateway_check/15c R1, R2, R3): pengecualian "tulisan sendiri" dimatikan.
// R1: setiap bagian dikirim dengan basis agen (server = wasit); update dari berkas ber-basis lama sesudah
// penggabungan -> BASE_CONFLICT tanpa kiriman, tulisan penulis lain utuh. Alur normal (basis baru dari
// submit/update atau `refresh --write`) tanpa konflik palsu. 409 SCOPE_CONFLICT -> BASE_CONFLICT.
// R2: refresh mempertahankan baris `~~hapus~~`. R3: peringatan agentId sama (pesan saja).
/* eslint-disable @typescript-eslint/no-explicit-any -- server tiruan berkeadaan memanipulasi JSON proyeksi R20 bebas bentuk */
import { describe, it, expect } from '../_vitest';
import type { HttpFetch } from '../../../vendor/scripts/studio/studio-report';
import { A, B, DOC, ITEMS, keyOf, MD, memFs, run, statefulServer, textOf } from './r3-stateful-harness';

const R = ['--remote', 'http://h'];
const keepBoth = (md: string) => md.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, (_m, mine: string, server: string) => mine + server);
const keep = (md: string, side: 'mine' | 'server') => md.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g, (_m, mine: string, server: string) => (side === 'mine' ? mine : server));
const withBasis = (md: string, line: string) => md.replace(/^basis: .*$/m, line);

describe('R1 tulisan sendiri tidak lagi melewati cek basis server', () => {
  it('urutan R1: B tulis bab 3; A konflik -> refresh --out-md -> gabung -> kirim; A update dari berkas ASLI basis lama -> BASE_CONFLICT, 0 kiriman, tulisan B utuh; refresh --write -> update aman', async () => {
    const s = statefulServer(MD());
    const b = await run(['update', DOC, 'b.md', ...R, '--agent-id', B], { fetch: s.f, fs: memFs({ 'b.md': MD({ bab3: ['Bukti versi B: hasil penulis kedua.'] }) }).fsx });
    expect(b.code).toBe(0);
    expect(s.rev()).toBe(7);
    const aMd = MD({ bab3: ['Bukti versi A: hasil penulis pertama.'] });
    const fa = memFs({ 'a.md': aMd });
    const c = await run(['update', DOC, 'a.md', ...R, '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(JSON.parse(c.out).fatal.code).toBe('BASE_CONFLICT');
    // Langkah 1 panduan lama: --out-md (berkas asli tetap ber-basis rev6).
    const r = await run(['refresh', DOC, 'a.md', ...R, '--agent-id', A, '--out-md', 'segar.md'], { fetch: s.f, fs: fa.fsx });
    expect(r.code).toBe(1);
    fa.files['segar.md'] = keepBoth(fa.files['segar.md']);
    const u = await run(['update', DOC, 'segar.md', ...R, '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(u.code).toBe(0);
    expect(s.rev()).toBe(8);
    expect(textOf(s.chapter('3'))).toContain('versi B');
    expect(textOf(s.chapter('3'))).toContain('versi A');
    // R1: kembali ke berkas asli (basis rev6, bab 3 versi A pra-gabung).
    s.reset();
    expect(fa.files['a.md']).toBe(aMd);
    const x = await run(['update', DOC, 'a.md', ...R, '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(x.code).toBe(1);
    const fatal = JSON.parse(x.out).fatal;
    expect(fatal.code).toBe('BASE_CONFLICT');
    expect(fatal.details).toMatchObject({ basisRevisionNo: 6, latestRevisionNo: 8, conflicts: ['bab 3'] });
    expect(fatal.details.changedByOthers).toContain('bab 3');
    expect(fatal.message).toContain('refresh');
    expect(fatal.message).not.toContain('oleh Anda sendiri');
    // R3: penulis terakhir bab 3 = agentId yang sama, basis lebih lama -> peringatan (pesan saja).
    expect(fatal.details.sameAgentWarnings.join('\n')).toContain(`bab 3`);
    expect(fatal.message).toContain('agentId');
    expect(s.posts()).toHaveLength(0);
    expect(s.rev()).toBe(8);
    expect(textOf(s.chapter('3'))).toContain('versi B');
    // Pemulihan: refresh --write (satu berkas, basis diperbarui) -> bab 3 konflik ditandai; pilih server -> 0 kiriman.
    const w = await run(['refresh', DOC, 'a.md', ...R, '--agent-id', A, '--write', '--json'], { fetch: s.f, fs: fa.fsx });
    expect(w.code).toBe(1);
    const wj = JSON.parse(w.out);
    expect(wj.conflicts).toEqual(['bab 3']);
    expect(JSON.stringify(wj.parts)).not.toContain('oleh Anda sendiri');
    expect(wj.notices.join('\n')).toContain('agentId');
    expect(fa.files['a.md']).toContain(`basis: ${DOC}@rev8`);
    fa.files['a.md'] = keep(fa.files['a.md'], 'server');
    s.reset();
    const y = await run(['update', DOC, 'a.md', ...R, '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(y.code).toBe(0);
    expect(s.posts()).toHaveLength(0);
    expect(textOf(s.chapter('3'))).toContain('versi B');
    expect(JSON.parse(y.out).nextBasis).toBe(`basis: ${DOC}@rev8`);
  });

  it('alur normal submit -> update -> update dengan basis baru (dicetak CLI, atau refresh --write) tanpa konflik palsu', async () => {
    const s = statefulServer(MD({ bab1: 'Ringkasan benih.' }));
    const f = memFs({ 'a.md': MD({ basis: null, agent: A }) });
    const sub = await run(['submit', 'a.md', ...R, '--json'], { fetch: s.f, fs: f.fsx });
    expect(sub.code).toBe(0);
    const b1 = JSON.parse(sub.out).nextBasis as string;
    expect(b1).toBe(`basis: ${DOC}@rev7`);
    // update 1: basis dari submit.
    f.files['a.md'] = MD({ basis: b1.slice(7), agent: A, bab5: '- Langkah v1.' });
    s.reset();
    const u1 = await run(['update', DOC, 'a.md', ...R, '--json'], { fetch: s.f, fs: f.fsx });
    expect(u1.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['5']);
    expect(s.posts()[0].body.baseRevisionNo).toBe(7);
    const b2 = JSON.parse(u1.out).nextBasis as string;
    expect(b2).toBe(`basis: ${DOC}@rev8`);
    // update 2: basis dari update 1 -> bagian yang sama lagi, tanpa konflik.
    f.files['a.md'] = withBasis(f.files['a.md'], b2).replace('- Langkah v1.', '- Langkah v2.');
    s.reset();
    const u2 = await run(['update', DOC, 'a.md', ...R, '--json'], { fetch: s.f, fs: f.fsx });
    expect(u2.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['5']);
    expect(s.posts()[0].body.baseRevisionNo).toBe(8);
    expect(JSON.parse(u2.out).nextBasis).toBe(`basis: ${DOC}@rev9`);
    // Basis tidak disalin (berkas masih rev8): refresh --write memperbarui basis (bab 5 = server) -> update 3 tanpa konflik.
    const w = await run(['refresh', DOC, 'a.md', ...R, '--write', '--json'], { fetch: s.f, fs: f.fsx });
    expect(w.code).toBe(0);
    expect(JSON.parse(w.out).parts).toEqual(expect.arrayContaining([{ part: 'bab 5', action: 'sama' }]));
    expect(f.files['a.md']).toContain(`basis: ${DOC}@rev9`);
    f.files['a.md'] = f.files['a.md'].replace('- Langkah v2.', '- Langkah v3.');
    s.reset();
    const u3 = await run(['update', DOC, 'a.md', ...R, '--json'], { fetch: s.f, fs: f.fsx });
    expect(u3.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['5']);
    expect(s.posts()[0].body.baseRevisionNo).toBe(9);
  });

  it('basis lama atas tulisan sendiri (basis tidak diperbarui) -> BASE_CONFLICT + peringatan agentId; refresh --write -> pilih versi Anda -> terkirim', async () => {
    const s = statefulServer(MD());
    const f = memFs({ 'a.md': MD({ agent: A, bab5: '- Langkah v1.' }) });
    expect((await run(['update', DOC, 'a.md', ...R], { fetch: s.f, fs: f.fsx })).code).toBe(0);
    expect(s.rev()).toBe(7);
    f.files['a.md'] = f.files['a.md'].replace('- Langkah v1.', '- Langkah v2.'); // basis tetap rev6
    s.reset();
    const c = await run(['update', DOC, 'a.md', ...R, '--json'], { fetch: s.f, fs: f.fsx });
    expect(c.code).toBe(1);
    const fatal = JSON.parse(c.out).fatal;
    expect(fatal.code).toBe('BASE_CONFLICT');
    expect(fatal.details.conflicts).toEqual(['bab 5']);
    expect(fatal.details.sameAgentWarnings).toHaveLength(1);
    expect(fatal.message).toContain('--write');
    expect(s.posts()).toHaveLength(0);
    const w = await run(['refresh', DOC, 'a.md', ...R, '--write'], { fetch: s.f, fs: f.fsx });
    expect(w.code).toBe(1);
    f.files['a.md'] = keep(f.files['a.md'], 'mine');
    s.reset();
    const u = await run(['update', DOC, 'a.md', ...R, '--json'], { fetch: s.f, fs: f.fsx });
    expect(u.code).toBe(0);
    expect(s.posts().map(keyOf)).toEqual(['5']);
    expect(s.posts()[0].body.baseRevisionNo).toBe(7);
    expect(textOf(s.chapter('5'))).toContain('Langkah v2.');
  });

  it('R3: penulis lain memakai agentId yang SAMA -> kini BASE_CONFLICT (tidak menimpa) + peringatan agentId', async () => {
    const s = statefulServer(MD());
    expect((await run(['update', DOC, 'b.md', ...R, '--agent-id', A], { fetch: s.f, fs: memFs({ 'b.md': MD({ bab1: 'Ringkasan penulis kedua berid sama.' }) }).fsx })).code).toBe(0);
    s.reset();
    const c = await run(['update', DOC, 'a.md', ...R, '--agent-id', A, '--json'], { fetch: s.f, fs: memFs({ 'a.md': MD({ bab1: 'Ringkasan A basi.' }) }).fsx });
    expect(c.code).toBe(1);
    const fatal = JSON.parse(c.out).fatal;
    expect(fatal.code).toBe('BASE_CONFLICT');
    expect(fatal.details.sameAgentWarnings.join('\n')).toMatch(/agentId sama|agentId yang sama/);
    expect(s.posts()).toHaveLength(0);
    expect(textOf(s.chapter('1'))).toContain('berid sama');
  });

  it('409 SCOPE_CONFLICT dari server (penulis lain menyela sesudah pembacaan) -> BASE_CONFLICT dengan petunjuk refresh --write; tulisan penyela utuh', async () => {
    const s = statefulServer(MD());
    let injected = false;
    const racing: HttpFetch = async (url, init) => {
      if (!injected && init.method === 'POST' && url.endsWith('/api/studio/chapters')) {
        injected = true;
        const body = { $schema: 'studio.chapter/v2', agentId: B, target: { documentId: DOC }, chapter: { key: '3', title: { text: 'Bukti' }, sections: [{ title: { text: 'Bukti' }, blocks: [{ type: 'paragraph', text: { text: 'Penyela B.' } }] }] } };
        await s.f(url, { method: 'POST', body: JSON.stringify(body), headers: {} } as never);
      }
      return s.f(url, init);
    };
    const c = await run(['update', DOC, 'a.md', ...R, '--agent-id', A, '--json'], { fetch: racing, fs: memFs({ 'a.md': MD({ bab3: ['Bukti oleh A.'] }) }).fsx });
    expect(c.code).toBe(1);
    const fatal = JSON.parse(c.out).fatal;
    expect(fatal.code).toBe('BASE_CONFLICT');
    expect(fatal.message).toContain('refresh');
    expect(fatal.message).toContain('--write');
    expect(fatal.details).toMatchObject({ serverCode: 'SCOPE_CONFLICT' });
    expect(textOf(s.chapter('3'))).toContain('Penyela B.');
    expect(textOf(s.chapter('3'))).not.toContain('Bukti oleh A.');
  });
});

describe('R2 refresh mempertahankan baris ~~hapus~~', () => {
  it('A tandai ~~hapus~~ R3F2-2 + ubah bab 5, B ubah bab 5 -> BASE_CONFLICT; refresh menulis ulang baris ~~hapus~~; pilih versi A -> butir terhapus', async () => {
    const s = statefulServer(MD());
    expect((await run(['update', DOC, 'b.md', ...R, '--agent-id', B], { fetch: s.f, fs: memFs({ 'b.md': MD({ bab5: '- Langkah dari B.' }) }).fsx })).code).toBe(0);
    const aMd = MD({ items: [ITEMS[0], '| R3F2-2 | Uji refresh | ~~hapus~~ | out/uji.txt 64 B sha 0a1b2c3d |'], bab5: '- Langkah dari A.' });
    const fa = memFs({ 'a.md': aMd });
    const c = await run(['update', DOC, 'a.md', ...R, '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(JSON.parse(c.out).fatal).toMatchObject({ code: 'BASE_CONFLICT', details: { conflicts: ['bab 5'] } });
    const r = await run(['refresh', DOC, 'a.md', ...R, '--agent-id', A, '--out-md', 'segar.md'], { fetch: s.f, fs: fa.fsx });
    expect(r.code).toBe(1);
    const seg = fa.files['segar.md'];
    expect(seg).toContain('| R3F2-2 | Uji refresh | ~~hapus~~ |');
    expect(seg.match(/R3F2-2/g)).toHaveLength(1);
    fa.files['segar.md'] = keep(seg, 'mine');
    s.reset();
    const u = await run(['update', DOC, 'segar.md', ...R, '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(u.code).toBe(0);
    expect(s.latest().sections.record.items.map((i: any) => i.key)).toEqual(['R3F2-1']);
    expect(textOf(s.chapter('5'))).toContain('Langkah dari A.');
  });

  it('rujukan ~~hapus~~ dipertahankan refresh; bila tabel butir ikut konflik, baris ~~hapus~~ ditulis di sisi ANDA saja', async () => {
    const REF = 'cmvwbis1d01mkv1i8x3hhgsm3';
    const withRefs = MD({ refs: [`| basis | ${REF} |  |  |`, `| bukti | ${REF} | p-tadha0rs05 | 8 |`] });
    const s = statefulServer(withRefs);
    expect((await run(['update', DOC, 'b.md', ...R, '--agent-id', B], { fetch: s.f, fs: memFs({ 'b.md': withRefs.replace('- Lanjut.', '- Langkah dari B.') }).fsx })).code).toBe(0);
    const aMd = MD({ refs: [`| basis | ${REF} |  |  |`, `| bukti | ${REF} | ~~hapus~~ |  |`], bab5: '- Langkah dari A.' });
    const fa = memFs({ 'a.md': aMd });
    const r = await run(['refresh', DOC, 'a.md', ...R, '--agent-id', A, '--out-md', 'segar.md'], { fetch: s.f, fs: fa.fsx });
    expect(r.code).toBe(1);
    expect(fa.files['segar.md']).toContain(`| evidence | ${REF} | ~~hapus~~ |`); // hubungan ditulis dalam bentuk kanonik
    fa.files['segar.md'] = keep(fa.files['segar.md'], 'mine');
    const u = await run(['update', DOC, 'segar.md', ...R, '--agent-id', A, '--json'], { fetch: s.f, fs: fa.fsx });
    expect(u.code).toBe(0);
    expect(s.latest().sections.record.refs).toEqual([{ documentId: REF, rel: 'basis' }]);
    // B juga mengubah baris R3F2-2 (bab 2 + record konflik): ~~hapus~~ di sisi ANDA, baris B utuh di sisi SERVER.
    const s2 = statefulServer(MD());
    expect((await run(['update', DOC, 'b.md', ...R, '--agent-id', B], { fetch: s2.f, fs: memFs({ 'b.md': MD({ items: [ITEMS[0], '| R3F2-2 | Uji refresh diubah B | done | out/uji.txt 64 B sha 0a1b2c3d |'] }) }).fsx })).code).toBe(0);
    const f2 = memFs({ 'a.md': MD({ items: [ITEMS[0], '| R3F2-2 | Uji refresh | ~~hapus~~ | out/uji.txt 64 B sha 0a1b2c3d |'] }) });
    const r2 = await run(['refresh', DOC, 'a.md', ...R, '--agent-id', A, '--out-md', 'segar.md'], { fetch: s2.f, fs: f2.fsx });
    expect(r2.code).toBe(1);
    const seg2 = f2.files['segar.md'];
    expect(seg2).toMatch(/<<<<<<< ANDA: bab 2[\s\S]*\| R3F2-2 \| Uji refresh \| ~~hapus~~ \|[\s\S]*=======[\s\S]*Uji refresh diubah B[\s\S]*>>>>>>> SERVER: bab 2/);
    expect(seg2.match(/~~hapus~~/g)).toHaveLength(1);
    // Pilih versi A -> butir terhapus; pilih versi server -> butir B tetap (tanpa ~~hapus~~).
    expect(keep(seg2, 'server')).not.toContain('~~hapus~~');
    f2.files['segar.md'] = keep(seg2, 'mine');
    const u2 = await run(['update', DOC, 'segar.md', ...R, '--agent-id', A, '--json'], { fetch: s2.f, fs: f2.fsx });
    expect(u2.code).toBe(0);
    expect(s2.latest().sections.record.items.map((i: any) => i.key)).toEqual(['R3F2-1']);
  });
});
