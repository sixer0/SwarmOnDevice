// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/engine-core/lint-fixl-precision.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-L (D-258, F-062): presisi cek lint yang terbukti positif palsu pada
// Manual DATUM 000. Setiap perbaikan diuji dua arah: kasus yang tetap FAIL
// (aturan tidak dilonggarkan) dan kasus penyebutan/ilustrasi yang kini PASS.
import { describe, it, expect, beforeAll } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { byConstructionChecks, scanText, walkDocument } from '@/lib/studio/engine/lint/scan';
import { check03, isQuantityPlusMinus, joinSegments } from '@/lib/studio/engine/lint/scan/checks';
import { lintStructure } from '@/lib/studio/engine/lint/structure';
import { isNumericDataTable, isPureNumberCell } from '@/lib/studio/engine/lint/structure/checks-a';
import { isWrongRightTable } from '@/lib/studio/engine/lint/structure/checks-d';
import { lintLanguage } from '@/lib/studio/engine/lint/language';
import { splitSentences } from '@/lib/studio/engine/lint/language/tokenize';
import type { StudioDocV1, TableBlock } from '@/lib/studio/contract';
import { canonicalTemplate, makeDoc, snapshotOf, statuses } from './fixtures';

let KAN: ResolvedTemplate;
beforeAll(() => {
  KAN = canonicalTemplate();
});

const cell = (t: string) => ({ text: t });

function table(head: string[], body: string[][], roles: string[], opts: { caption?: boolean } = {}): Record<string, unknown> {
  const w = Math.floor((128 / head.length) * 100) / 100;
  const widths = head.map((_, i) => (i === head.length - 1 ? Math.round((128 - w * (head.length - 1)) * 100) / 100 : w));
  return {
    type: 'table',
    ...(opts.caption === false ? {} : { caption: { inline: { text: 'Tabel uji presisi.' } } }),
    source: { inline: { text: 'SUMBER uji internal.' } },
    columns: head.map((_, i) => ({ widthMm: widths[i], role: roles[i], align: roles[i] === 'numeral' ? 'right' : 'left' })),
    rows: [{ kind: 'header', cells: head.map(cell) }, ...body.map((r) => ({ kind: 'body', cells: r.map(cell) }))],
  };
}

const structOf = (blocks: Record<string, unknown>[]) => lintStructure(snapshotOf(makeDoc({ blocks })), KAN, 'TERBIT');

describe('DATUM-17: ± besaran dinilai, penyebutan tanda dilewati', () => {
  it('± besaran tanpa arti tetap FAIL (angka dan simbol satu huruf)', () => {
    expect(statuses(scanText('Nilai 5 ± 2 saja.', KAN.params), 'DATUM-17')).toEqual(['FAIL']);
    expect(statuses(scanText('Tegangan naik ±5 % saat beban puncak.', KAN.params), 'DATUM-17')).toEqual(['FAIL']);
    expect(statuses(scanText('Hasil x ± U dilaporkan apa adanya.', KAN.params), 'DATUM-17')).toEqual(['FAIL']);
    expect(statuses(scanText('Lebar celah ± (0,2) pada sambungan.', KAN.params), 'DATUM-17')).toEqual(['FAIL']);
  });

  it('± besaran dengan arti di dekatnya tetap PASS', () => {
    expect(statuses(scanText('Tegangan PLN stabil (230 ± 12) V, toleransi rancangan.', KAN.params), 'DATUM-17')).toEqual(['PASS']);
  });

  it('penyebutan tanda ± (nama aturan, butir periksa, akhir baris) PASS', () => {
    expect(statuses(scanText('17\n± tanpa arti yang dinyatakan\n0\nberkas', KAN.params), 'DATUM-17')).toEqual(['PASS']);
    expect(statuses(scanText('Satuan berspasi, ± berarti, numeral Indonesia, satu varian per berkas.', KAN.params), 'DATUM-17')).toEqual(['PASS']);
    expect(statuses(scanText('Periksa jendela di sekitar ±\nTerbuka', KAN.params), 'DATUM-17')).toEqual(['PASS']);
  });

  it('isQuantityPlusMinus: operan angka/simbol vs kata/akhir baris', () => {
    const at = (s: string) => isQuantityPlusMinus(s, s.indexOf('±'));
    expect(at('5 ± 2')).toBe(true);
    expect(at('±0,1 mm')).toBe(true);
    expect(at('y ± −3')).toBe(true);
    expect(at('± σ')).toBe(true);
    expect(at('± tanpa arti')).toBe(false);
    expect(at('meloloskan ± bila kata')).toBe(false);
    expect(at('sekitar ±')).toBe(false);
    expect(at('sekitar ±\n12')).toBe(false);
  });
});

describe('DATUM-09: tabel data = >= 50 % sel badan angka (HS numeric_data_tables)', () => {
  it('tabel data numerik tanpa satuan tetap FAIL; dengan kolom satuan PASS', () => {
    const body = [['Panel A', '12', '3,5'], ['Panel B', '14', '4,0'], ['Panel C', '11', '2,9']];
    expect(statuses(structOf([table(['Butir', 'Daya', 'Arus'], body, ['text', 'numeral', 'numeral'])]), 'DATUM-09')).toEqual(['FAIL']);
    const withUnit = body.map((r) => [...r, 'kW']);
    expect(statuses(structOf([table(['Butir', 'Daya', 'Arus', 'Satuan'], withUnit, ['text', 'numeral', 'numeral', 'unit'])]), 'DATUM-09')).toEqual(['PASS']);
  });

  it('tabel data tanpa peran numeral tetap dinilai dari isinya (FAIL)', () => {
    const body = [['Panel A', '12', '3'], ['Panel B', '14', '4']];
    expect(statuses(structOf([table(['Butir', 'Daya', 'Arus'], body, ['text', 'text', 'text'])]), 'DATUM-09')).toEqual(['FAIL']);
  });

  it('tabel 2 kolom berperan numeral tetap dinilai (FAIL tanpa satuan)', () => {
    expect(statuses(structOf([table(['Butir', 'Nilai'], [['Alpha', '12'], ['Beta', '14']], ['text', 'numeral'])]), 'DATUM-09')).toEqual(['FAIL']);
  });

  it('tabel teks dengan kolom nomor urut atau cacah aturan PASS (bukan tabel data)', () => {
    const steps = [['1', 'Sisir sendiri tiga cek tercepat', 'Penulis'], ['2', 'Penjaga titik panggil saat bangun', 'datumcheck.py'], ['3', 'Lint gambar saat bangun', 'datum_render.py']];
    expect(statuses(structOf([table(['Langkah', 'Pemeriksaan', 'Alat'], steps, ['numeral', 'text', 'text'])]), 'DATUM-09')).toEqual(['PASS']);
    const counts = [['DT-nn', 'Bentuk dan aparatus bukti', 'House Style', '44'], ['CH-nn', 'Pemilihan chart', 'Panduan Chart', '14']];
    expect(statuses(structOf([table(['Awalan', 'Cakupan', 'Asal', 'Jumlah'], counts, ['id', 'text', 'text', 'numeral'])]), 'DATUM-09')).toEqual(['PASS']);
  });

  it('D-267: kolom nomor urut (1..n) tidak ikut porsi; rekonsiliasi dua rute tanpa satuan tetap FAIL', () => {
    const dist = table(['No', 'Penerima', 'Bentuk', 'Keterangan'], [['1', 'Pengelola gedung', 'PDF', 'asli'], ['2', 'Pemilik gedung', 'Cetak', '3']], ['id', 'text', 'text', 'text']);
    expect(statuses(structOf([dist]), 'DATUM-09')).toEqual(['PASS']);
    const checklist = table(['No', 'Butir pemeriksaan', 'Aturan'], [['1', 'Pertanyaan chart tertulis.', 'CH-07'], ['2', 'Jenis chart sesuai tujuan.', 'CH-08']], ['numeral', 'text', 'id']);
    expect(statuses(structOf([checklist]), 'DATUM-09')).toEqual(['PASS']);
    const qty = table(['No', 'Butir', 'Volume'], [['1', 'Segel', '3'], ['2', 'Bantalan', '4']], ['numeral', 'text', 'numeral']);
    expect(statuses(structOf([qty]), 'DATUM-09')).toEqual(['FAIL']);
    const rk = table(['ID', 'Besaran', 'Rute 1', 'Rute 2'], [['RK-01', 'Debit total', '36', '36']], ['id', 'text', 'text', 'text']);
    expect(statuses(structOf([rk]), 'DATUM-09')).toEqual(['FAIL']);
    const rkUnit = table(['ID', 'Besaran', 'Rute 1 (m3/jam)', 'Rute 2 (m3/jam)'], [['RK-01', 'Debit total', '36', '36']], ['id', 'text', 'text', 'text']);
    expect(statuses(structOf([rkUnit]), 'DATUM-09')).toEqual(['PASS']);
  });

  it('isPureNumberCell dan isNumericDataTable mengikuti HS', () => {
    expect(isPureNumberCell('1.250,5')).toBe(true);
    expect(isPureNumberCell('44')).toBe(true);
    expect(isPureNumberCell('maks. 3')).toBe(false);
    expect(isPureNumberCell('teks')).toBe(false);
    const t = table(['A', 'B', 'C'], [['x', '1', '2']], ['text', 'text', 'text']) as unknown as TableBlock;
    expect(isNumericDataTable(t)).toBe(true);
    const t2 = table(['A', 'B', 'C'], [['x', 'y', '2']], ['text', 'text', 'text']) as unknown as TableBlock;
    expect(isNumericDataTable(t2)).toBe(false);
  });
});

describe('D05: tabel contoh salah/benar berjenis table tidak diaudit sebagai prosa', () => {
  const pair = '3 (satu) Tahun Anggaran dan 36 (dua belas) bulan.';

  it('pasangan angka-terbilang salah di paragraf dan tabel biasa tetap FAIL', () => {
    expect(statuses(structOf([{ type: 'paragraph', text: `Kontrak berlaku ${pair}` }]), 'D05')).toContain('FAIL');
    expect(statuses(structOf([table(['Butir', 'Ketentuan', 'Catatan'], [['K-01', pair, 'mengikat']], ['id', 'text', 'text'])]), 'D05')).toContain('FAIL');
  });

  it('tabel berkepala "Salah" dan "Benar" PASS (kutipan cacat yang disengaja)', () => {
    const t = table(['Aturan', 'Salah, salinan nyata', 'Benar, salinan nyata'], [['SG-L4-06', 'Rp832 ribu', pair]], ['id', 'text', 'text']);
    expect(statuses(structOf([t]), 'D05')).toEqual(['PASS']);
    expect(isWrongRightTable(t as unknown as TableBlock)).toBe(true);
  });

  it('hanya salah satu kolom (Salah saja) bukan tabel contoh', () => {
    const t = table(['Aturan', 'Salah', 'Catatan'], [['SG-L4-06', 'x', pair]], ['id', 'text', 'text']);
    expect(isWrongRightTable(t as unknown as TableBlock)).toBe(false);
    expect(statuses(structOf([t]), 'D05')).toContain('FAIL');
    const t2 = table(['Aturan', 'Kesalahan umum', 'Benar'], [['SG-L4-06', 'x', 'y']], ['id', 'text', 'text']);
    expect(isWrongRightTable(t2 as unknown as TableBlock)).toBe(false);
  });
});

describe('C-27: penanda butir sebaris dan singkatan ref. bukan batas kalimat', () => {
  it('enumerasi "1. ... 2. ..." menghasilkan kalimat butir, bukan kalimat satu kata', () => {
    expect(splitSentences('1. Setiap klaim menyebut kelas asalnya. 2. Setiap batasan ditutup instruksi.')).toEqual([
      '1. Setiap klaim menyebut kelas asalnya.',
      '2. Setiap batasan ditutup instruksi.',
    ]);
  });

  it('kalimat yang diakhiri angka tetap berakhir di titiknya', () => {
    expect(splitSentences('Jumlah panel adalah 3. Semua panel diuji.')).toEqual(['Jumlah panel adalah 3.', 'Semua panel diuji.']);
  });

  it('"ref. 09" tidak memutus kalimat', () => {
    expect(splitSentences('Edisi ini mengalahkan tabel edisi DATUM ref. 09 yang lebih lama.')).toHaveLength(1);
  });

  it('rata-rata kata per kalimat: penanda butir tidak lagi menurunkan rata-rata', () => {
    const text = '1. Setiap klaim beban keputusan menyebut kelas asalnya di badan teks dengan jelas sekali hari ini. 2. Setiap batasan dan ketidakpastian ditutup jalan keluar atau instruksi yang dapat dijalankan.';
    const detail = lintLanguage(snapshotOf(makeDoc({ blocks: [{ type: 'paragraph', text }] })), KAN.params).find((i) => i.checkId === 'C-27')?.detail ?? '';
    expect(detail).toContain('2 kalimat');
  });

  it('prosa yang memang pendek tetap FAIL koridor 18-32', () => {
    const out = lintLanguage(snapshotOf(makeDoc({ blocks: [{ type: 'paragraph', text: 'Panel diuji. Hasil dicatat. Laporan dikirim.' }] })), KAN.params);
    expect(statuses(out, 'C-27')).toEqual(['FAIL']);
  });
});

describe('DATUM-03 (D-263): ambang 0 tetap; aparatus mesin dan contoh salah tidak dihitung', () => {
  const em = (doc: Record<string, unknown>) => {
    const d = doc as unknown as StudioDocV1;
    return check03(joinSegments(walkDocument(d).segments), KAN.params);
  };
  const withCover = (blocks: Record<string, unknown>[]) => ({
    ...(makeDoc({ blocks }) as unknown as Record<string, unknown>),
    front: {
      cover: {
        mode: 'auto',
        data: {
          titleLines: [{ text: 'Laporan Uji Pompa' }],
          identityString: { text: 'LAPORAN · UJI · ID · REV A' },
          colophon: { type: 'colophon', left: { text: 'PT GSP' }, right: { text: '// 20261023 ID T — TERBITAN 1' } },
        },
      },
    },
  });

  it('kepala/cap terbit DATUM ber-em dash, prosa tanpa em dash -> PASS', () => {
    expect(em(withCover([{ type: 'paragraph', text: 'Pompa diuji pada debit rancangan dan lolos.' }]))).toEqual([]);
  });

  it('em dash di paragraf penulis -> FAIL (detail menyebut aparatus yang dikecualikan)', () => {
    const f = em(withCover([{ type: 'paragraph', text: 'Pompa diuji — dan lolos — pada debit rancangan.' }]));
    expect(f.map((x) => x.checkId)).toEqual(['DATUM-03']);
    expect(f[0].detail).toContain('2 dalam');
    expect(f[0].detail).toContain('1 em dash aparatus/contoh salah tidak dihitung');
  });

  it('em dash di judul sampul (prosa penulis, bukan aparatus) tetap dihitung', () => {
    const d = withCover([{ type: 'paragraph', text: 'Paragraf netral.' }]) as unknown as { front: { cover: { data: Record<string, unknown> } } };
    d.front.cover.data.titleLines = [{ text: 'Laporan — Uji Pompa' }];
    expect(em(d).map((x) => x.checkId)).toEqual(['DATUM-03']);
  });

  it('em dash di kolom "Salah" tabel contoh salah/benar -> PASS; di kolom "Benar" atau tabel biasa -> FAIL', () => {
    const wr = (wrong: string, right: string) => table(['Aturan', 'Salah, salinan nyata', 'Benar, salinan nyata'], [['DT-03', wrong, right]], ['id', 'text', 'text']);
    expect(em(makeDoc({ blocks: [wr('Langkah 1 — pasang', 'Langkah 1. Pasang')] }) as unknown as Record<string, unknown>)).toEqual([]);
    expect(em(makeDoc({ blocks: [wr('Langkah 1. Pasang', 'Langkah 1 — pasang')] }) as unknown as Record<string, unknown>).map((x) => x.checkId)).toEqual(['DATUM-03']);
    const plain = table(['ID', 'Sumber A', 'Putusan'], [['R-13', 'Chart: "Langkah 1 — ..."', 'Judul memakai titik']], ['id', 'text', 'text']);
    expect(em(makeDoc({ blocks: [plain] }) as unknown as Record<string, unknown>).map((x) => x.checkId)).toEqual(['DATUM-03']);
  });

  it('format cap terbit dikutip di tabel spesifikasi perangkat -> tidak dihitung; em dash lain di sel yang sama tetap dihitung', () => {
    const spec = (v: string) => table(['Perangkat', 'Spesifikasi', 'Muncul di'], [['Cap terbit', v, 'Kolofon sampul']], ['text', 'text', 'text']);
    expect(em(makeDoc({ blocks: [spec('// YYYYMMDD BAHASA KELAS — TERBITAN n')] }) as unknown as Record<string, unknown>)).toEqual([]);
    expect(em(makeDoc({ blocks: [spec('// YYYYMMDD BAHASA KELAS — TERBITAN n — wajib')] }) as unknown as Record<string, unknown>).map((x) => x.checkId)).toEqual(['DATUM-03']);
  });

  it('jalur penuh runLint: em dash di paragraf tetap FAIL', () => {
    expect(statuses(scanText('Satu klaim — dengan em dash.', KAN.params), 'DATUM-03')).toEqual(['FAIL']);
  });
});

describe('DATUM-04 (D-263, RL Rev K E-27): pertanyaan = berakhiran "?"', () => {
  it('label berawalan kata tanya tidak memicu gerbang by-construction', () => {
    expect(byConstructionChecks(makeDoc({ sectionTitle: 'Siapa memiliki keputusan apa' }), KAN).filter((i) => i.status === 'FAIL').map((i) => i.checkId)).toEqual([]);
    expect(byConstructionChecks(makeDoc({ sectionTitle: 'Apa yang diatur dan mengapa' }), KAN).filter((i) => i.status === 'FAIL').map((i) => i.checkId)).toEqual([]);
  });

  it('judul berakhiran "?" tetap ditolak di TERBIT', () => {
    expect(byConstructionChecks(makeDoc({ sectionTitle: 'Apa temuan utama kajian ini?' }), KAN).filter((i) => i.status === 'FAIL').map((i) => i.checkId)).toEqual(['DATUM-04']);
  });
});
