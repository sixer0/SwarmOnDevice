// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/draft/dc21-extract-draft.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-21 (D-367): ekstraktor draf/checkpoint MD murni (I63). Nilai harapan = register
// 05_document_contract_specs.md §11.1-§11.4 dan §17.2 (DX-1..DX-8), ditulis sebagai literal;
// nomor baris dihitung dari teks fixture, bukan diturunkan dari kode yang diuji.
import { describe, expect, it } from '../_vitest';
import {
  checkDraftLimits,
  extractDraft,
  jsonErrorOffset,
  parseDraftBasis,
  toDraftCheckResult,
} from '@/lib/studio/services/draft';

const md = (...lines: string[]) => lines.join('\n');
const check = (s: string) => toDraftCheckResult(extractDraft(s));
const codes = (xs: Array<{ code: string }>) => xs.map((x) => x.code);

const HEAD = [
  '# DRAF Laporan kerja DC-02',
  'tujuan: register nama document contract',
  'langkah-berikut: kirim slot record lalu bab 1-5',
  'basis: cmvui0qun000qv11gtygb1mk9@rev3',
];

// Contoh §11.1 apa adanya (baris 1-9).
const REGISTER_EXAMPLE = md(
  ...HEAD,
  '',
  '```json',
  '{ "$schema": "studio.slot/v2", "target": { "documentId": "cmvui0qun000qv11gtygb1mk9" }, "slot": "record", "baseRevisionNo": 3,',
  '  "payload": { "type": "contractRecord", "status": "partial", "reportedAt": "2026-10-30" } }',
  '```',
  '',
);

describe('DC-21 contoh register §11.1', () => {
  it('kepala terurai, satu blok slot di baris 6-9, tanpa isu, valid', () => {
    const ex = extractDraft(REGISTER_EXAMPLE);
    expect(ex.header).toEqual({
      title: 'DRAF Laporan kerja DC-02',
      tujuan: 'register nama document contract',
      langkahBerikut: 'kirim slot record lalu bab 1-5',
      basis: 'cmvui0qun000qv11gtygb1mk9@rev3',
    });
    expect(ex.issues).toEqual([]);
    expect(ex.blocks).toHaveLength(1);
    const b = ex.blocks[0];
    expect([b.index, b.line, b.endLine, b.schema]).toEqual([1, 6, 9, 'studio.slot/v2']);
    expect(b.value).toEqual({
      $schema: 'studio.slot/v2',
      target: { documentId: 'cmvui0qun000qv11gtygb1mk9' },
      slot: 'record',
      baseRevisionNo: 3,
      payload: { type: 'contractRecord', status: 'partial', reportedAt: '2026-10-30' },
    });
    expect(b.text).toBe(REGISTER_EXAMPLE.split('\n').slice(6, 8).join('\n'));
    const r = toDraftCheckResult(ex);
    expect(r.valid).toBe(true);
    expect(r.blocks[0]).toMatchObject({ index: 1, line: 6, endLine: 9, schema: 'studio.slot/v2', valid: true, issues: [] });
    expect(r.blocks[0].payload).toEqual(b.value);
  });
});

describe('DC-21 DX-1..DX-8 (register §17.2)', () => {
  it('DX-1 kepala lengkap tanpa blok -> DRAFT_NO_JSON_BLOCK, valid false', () => {
    const r = check(md(...HEAD, '', 'Catatan tanpa blok.'));
    expect(codes(r.issues)).toEqual(['DRAFT_NO_JSON_BLOCK']);
    expect(r.issues[0].severity).toBe('error');
    expect(r.blocks).toEqual([]);
    expect(r.valid).toBe(false);
    expect(r.header.basis).toBe('cmvui0qun000qv11gtygb1mk9@rev3');
  });

  it('DX-2 koma hilang di baris MD ke-9 -> DRAFT_JSON_MALFORMED line 9', () => {
    const s = md(
      ...HEAD, //                                       1-4
      '', //                                            5
      '```json', //                                     6
      '{', //                                           7
      '  "$schema": "studio.slot/v2",', //              8
      '  "slot": "record" "baseRevisionNo": 3', //      9  <- koma hilang
      '}', //                                           10
      '```', //                                         11
    );
    const r = check(s);
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'DRAFT_JSON_MALFORMED', severity: 'error', line: 9, column: 20, blockIndex: 1 }),
    ]);
    expect(r.blocks[0]).toMatchObject({ line: 6, endLine: 11, payload: null, schema: null, valid: false });
    expect(r.valid).toBe(false);
  });

  it('DX-3 dua blok valid (slot record + bab 1) -> 2 blok valid, valid true', () => {
    const s = md(
      ...HEAD, //                                                                    1-4
      '', //                                                                         5
      '```json', //                                                                  6
      '{ "$schema": "studio.slot/v2", "slot": "record", "payload": {} }', //         7
      '```', //                                                                      8
      '', //                                                                         9
      'Bab pertama:', //                                                             10
      '```json', //                                                                  11
      '{', //                                                                        12
      '  "$schema": "studio.chapter/v2",', //                                        13
      '  "chapter": { "key": "1" }', //                                              14
      '}', //                                                                        15
      '```', //                                                                      16
    );
    const r = check(s);
    expect(r.issues).toEqual([]);
    expect(r.blocks.map((b) => [b.index, b.line, b.endLine, b.schema, b.valid])).toEqual([
      [1, 6, 8, 'studio.slot/v2', true],
      [2, 11, 16, 'studio.chapter/v2', true],
    ]);
    expect(r.valid).toBe(true);
  });

  it('DX-4 $schema studio.contract/v1 -> DRAFT_SCHEMA_UNKNOWN', () => {
    const r = check(md(...HEAD, '```json', '{ "$schema": "studio.contract/v1" }', '```'));
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'DRAFT_SCHEMA_UNKNOWN', severity: 'error', line: 5, blockIndex: 1 }),
    ]);
    expect(r.blocks[0]).toMatchObject({ line: 5, endLine: 7, schema: 'studio.contract/v1', valid: false });
    expect(r.valid).toBe(false);
  });

  it('DX-4b objek tanpa $schema -> DRAFT_SCHEMA_UNKNOWN, schema null', () => {
    const r = check(md(...HEAD, '```json', '{ "slot": "record" }', '```'));
    expect(codes(r.issues)).toEqual(['DRAFT_SCHEMA_UNKNOWN']);
    expect(r.blocks[0].schema).toBeNull();
  });

  it('DX-5 pagar json tanpa penutup -> DRAFT_FENCE_UNCLOSED di baris pembuka', () => {
    const r = check(md(...HEAD, '', '```json', '{ "$schema": "studio.slot/v2" }', ''));
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'DRAFT_FENCE_UNCLOSED', severity: 'error', line: 6 }),
    ]);
    expect(r.blocks).toEqual([]);
    expect(r.valid).toBe(false);
  });

  it('DX-6 blok berisi larik -> DRAFT_BLOCK_NOT_OBJECT', () => {
    const r = check(md(...HEAD, '```json', '', '  [ { "$schema": "studio.slot/v2" } ]', '```'));
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'DRAFT_BLOCK_NOT_OBJECT', severity: 'error', line: 7, column: 3, blockIndex: 1 }),
    ]);
    expect(r.blocks[0]).toMatchObject({ line: 5, endLine: 8, schema: null, valid: false });
    expect(r.valid).toBe(false);
  });

  it('DX-7 kepala tanpa tujuan + satu blok valid -> DRAFT_HEADER_INCOMPLETE warning, valid true', () => {
    const r = check(md(HEAD[0], HEAD[2], HEAD[3], '', '```json', '{ "$schema": "studio.doc/v2" }', '```'));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'DRAFT_HEADER_INCOMPLETE', severity: 'warning' })]);
    expect(r.issues[0].message).toContain('tujuan');
    expect(r.header.tujuan).toBeNull();
    expect(r.blocks[0]).toMatchObject({ line: 5, endLine: 7, valid: true });
    expect(r.valid).toBe(true);
  });

  it('DX-8 pagar text berisi JSON + satu pagar json valid -> tepat 1 blok', () => {
    const s = md(
      ...HEAD, //                                          1-4
      '', //                                               5
      'Contoh (tidak dikirim):', //                        6
      '```text', //                                        7
      '{ "$schema": "studio.slot/v2", "slot": "x" }', //   8
      '```json', //                                        9  (isi pagar text, bukan pembuka)
      '```', //                                            10 penutup pagar text
      '````json', //                                       11 empat backtick: diabaikan
      '{ "$schema": "studio.slot/v2" }', //                12
      '````', //                                           13
      '  ```json', //                                      14 berindentasi: diabaikan
      '[1]', //                                            15
      '  ```', //                                          16
      '```json', //                                        17
      '{ "$schema": "studio.slot/v2", "slot": "record" }', // 18
      '```', //                                            19
    );
    const r = check(s);
    expect(r.issues).toEqual([]);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toMatchObject({ index: 1, line: 17, endLine: 19, schema: 'studio.slot/v2', valid: true });
    expect(r.valid).toBe(true);
  });
});

describe('DC-21 kepala, basis, nomor baris', () => {
  it('kepala = baris sebelum pagar pertama; kunci sesudah pagar tidak dibaca', () => {
    const ex = extractDraft(md('# Judul', '```text', 'x', '```', 'tujuan: telat', '```json', '{"$schema":"studio.doc/v2"}', '```'));
    expect(ex.header).toEqual({ title: 'Judul', tujuan: null, langkahBerikut: null, basis: null });
    expect(ex.issues[0]).toMatchObject({ code: 'DRAFT_HEADER_INCOMPLETE', severity: 'warning' });
    expect(ex.issues[0].message).toContain('tujuan, langkah-berikut, basis');
  });

  it('basis tak cocok C56 -> DRAFT_BASIS_INVALID warning di baris basis; "baru" sah', () => {
    const bad = extractDraft(md('# J', 'tujuan: t', 'langkah-berikut: l', 'basis: DOC@rev0', '```json', '{"$schema":"studio.doc/v2"}', '```'));
    expect(bad.issues).toEqual([expect.objectContaining({ code: 'DRAFT_BASIS_INVALID', severity: 'warning', line: 4 })]);
    expect(toDraftCheckResult(bad).valid).toBe(true);
    const ok = extractDraft(md('# J', 'tujuan: t', 'langkah-berikut: l', 'basis: baru', '```json', '{"$schema":"studio.doc/v2"}', '```'));
    expect(ok.issues).toEqual([]);
  });

  it('parseDraftBasis mengurai documentId dan revisi', () => {
    expect(parseDraftBasis('cmvui0qun000qv11gtygb1mk9@rev3')).toEqual({
      kind: 'revision',
      documentId: 'cmvui0qun000qv11gtygb1mk9',
      revisionNo: 3,
    });
    expect(parseDraftBasis('baru')).toEqual({ kind: 'baru' });
    expect(parseDraftBasis('x@rev3')).toBeNull();
  });

  it('CRLF: nomor baris terhadap berkas asli, text mempertahankan akhir baris asli', () => {
    const s = REGISTER_EXAMPLE.replace(/\n/g, '\r\n');
    const ex = extractDraft(s);
    expect(ex.issues).toEqual([]);
    expect([ex.blocks[0].line, ex.blocks[0].endLine]).toEqual([6, 9]);
    expect(ex.blocks[0].text).toBe(REGISTER_EXAMPLE.split('\n').slice(6, 8).join('\r\n'));
    expect(ex.header.basis).toBe('cmvui0qun000qv11gtygb1mk9@rev3');
    const broken = extractDraft(['```json', '{', '  "a": 1', '  "b": 2', '}', '```'].join('\r\n'));
    expect(broken.issues).toContainEqual(expect.objectContaining({ code: 'DRAFT_JSON_MALFORMED', line: 4, column: 3 }));
  });

  it('BOM di awal berkas tidak merusak judul; blok kosong -> JSON_MALFORMED', () => {
    const ex = extractDraft('\uFEFF' + md('# Judul', '```json', '```'));
    expect(ex.header.title).toBe('Judul');
    expect(ex.issues).toContainEqual(expect.objectContaining({ code: 'DRAFT_JSON_MALFORMED', line: 3, blockIndex: 1 }));
  });

  it('blok rusak tidak menghentikan blok berikutnya; isu urut posisi', () => {
    const r = check(md(...HEAD, '```json', '{,}', '```', '```json', '{"$schema":"studio.chapter/v2"}', '```'));
    expect(codes(r.issues)).toEqual(['DRAFT_JSON_MALFORMED']);
    expect(r.issues[0]).toMatchObject({ line: 6, column: 2 });
    expect(r.blocks.map((b) => b.valid)).toEqual([false, true]);
    expect(r.valid).toBe(false);
  });
});

describe('DC-21 batas C54 (DR-09, DR-10)', () => {
  it('dalam batas -> null', () => {
    expect(checkDraftLimits(REGISTER_EXAMPLE)).toBeNull();
    expect(checkDraftLimits(REGISTER_EXAMPLE, { bodyBytes: 4194304 })).toBeNull();
  });

  it('badan > bodyBytes atau markdown > maxChars -> DRAFT_TOO_LONG', () => {
    expect(checkDraftLimits('x', { bodyBytes: 4194305 })).toBe('DRAFT_TOO_LONG');
    expect(checkDraftLimits('x'.repeat(2000001))).toBe('DRAFT_TOO_LONG');
    expect(checkDraftLimits('x'.repeat(2000000))).toBeNull();
  });

  it('blok > maxBlocks (20) -> DRAFT_TOO_MANY_BLOCKS; pagar lain tidak dihitung', () => {
    const blk = '```json\n{"$schema":"studio.doc/v2"}\n```';
    expect(checkDraftLimits(Array(20).fill(blk).join('\n'))).toBeNull();
    expect(checkDraftLimits(Array(21).fill(blk).join('\n'))).toBe('DRAFT_TOO_MANY_BLOCKS');
    expect(checkDraftLimits(Array(30).fill('```text\n{}\n```').join('\n'))).toBeNull();
  });
});

describe('DC-21 jsonErrorOffset', () => {
  it('-1 untuk JSON sah; offset galat untuk JSON rusak (selaras JSON.parse)', () => {
    const valid = ['{}', '[]', ' {"a":[1,-2.5e+3,true,false,null,"\\u00e9\\n"]} ', '0', '"x"'];
    for (const s of valid) {
      expect(() => JSON.parse(s)).not.toThrow();
      expect(jsonErrorOffset(s)).toBe(-1);
    }
    const invalid: Array<[string, number]> = [
      ['{"a":1 "b":2}', 7],
      ['[1,]', 3],
      ['{"a" 1}', 5],
      ['{"a":01}', 6],
      ['tru', 3],
      ['{"a":"\\x"}', 7],
      ['[1', 2],
      ['{} {}', 3],
      ['', 0],
    ];
    for (const [s, off] of invalid) {
      expect(() => JSON.parse(s)).toThrow();
      expect(jsonErrorOffset(s)).toBe(off);
    }
  });

  it('larik sangat dalam tidak meluapkan tumpukan', () => {
    const deep = '['.repeat(200000);
    expect(jsonErrorOffset(deep)).toBe(200000);
    const r = extractDraft(md('```json', deep, '```'));
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'DRAFT_JSON_MALFORMED', line: 2, column: 200001 }));
  });
});
