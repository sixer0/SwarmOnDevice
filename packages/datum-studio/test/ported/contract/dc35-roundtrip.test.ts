// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/contract/dc35-roundtrip.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// DC-35 (BA-35) — properti bolak-balik (register 05 §10 FN-08, §11.1, §11.3 `--emit`).
// Generator acak deterministik (mulberry32, benih tetap; tanpa dependensi baru) agar kegagalan
// dapat direproduksi: pesan galat memuat benih + indeks kasus.
// (a) Nama final: parse(format(p)) = p, format(parse(n)) = n, finalFileNameOf -> nama yang lolos
//     parser dan bolak-balik; mutasi satu karakter tidak pernah melempar dan tetap bolak-balik bila lolos.
// (b) Draf: extractDraft -> blok `text` byte-identik dengan teks sumber (akhir baris asli, UTF-8),
//     nomor baris pagar sesuai, pagar lain diabaikan; CLI `--emit n` (main in-process) mencetak
//     byte yang sama.
import { afterAll, beforeAll, describe, expect, it } from '../_vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FinalFileNameParts, StudioOutputFormat } from '@/lib/studio/contract';
import { FINAL_FILENAME_PATTERN } from '@/lib/studio/contract/env';
import { extractDraft } from '@/lib/studio/services/draft';
import { docNumberSafe, finalFileNameOf, formatFinalFileName, parseFinalFileName } from '@/lib/studio/services/render/final-name';
import { main } from '../../../vendor/scripts/studio/draft-check';

// ── PRNG deterministik ──────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[int(r, 0, xs.length - 1)];
const pad = (n: number, w: number) => String(n).padStart(w, '0');

const FINAL_RE = new RegExp(FINAL_FILENAME_PATTERN);
const EXTS = ['docx', 'pdf', 'html', 'svg', 'png'] as const;
const FORMATS: Array<[StudioOutputFormat, FinalFileNameParts['ext']]> = [
  ['DOCX', 'docx'],
  ['PDF', 'pdf'],
  ['HTML', 'html'],
  ['SVG', 'svg'],
  ['PNG', 'png'],
];
const DOC_CHARS = 'ABCXYZabcxyz0123456789/._- é#:|\\\t'.split('');
const HEX = '0123456789abcdef';

function daysIn(y: number, m: number): number {
  return [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
function randomDocNumber(r: Rng): string {
  const n = int(r, 0, 120);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(r, DOC_CHARS);
  return s;
}
function randomParts(r: Rng): FinalFileNameParts {
  const y = int(r, 0, 9999);
  const mo = int(r, 1, 12);
  const d = int(r, 1, daysIn(y, mo));
  let sha8 = '';
  for (let i = 0; i < 8; i++) sha8 += pick(r, HEX.split(''));
  return {
    docNumberSafe: docNumberSafe(randomDocNumber(r)),
    revisionNo: r() < 0.1 ? 0 : int(r, 1, 999999),
    renderedAt: `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(int(r, 0, 23), 2)}:${pad(int(r, 0, 59), 2)}:${pad(int(r, 0, 59), 2)}Z`,
    sha8,
    ext: pick(r, EXTS),
  };
}

describe('DC-35 properti nama final (FN-08)', () => {
  const SEED = 0x0dc35a;
  const N = 300;

  it(`${N} bagian acak: format cocok C51, parse(format(p)) = p, format(parse(n)) = n`, () => {
    const r = mulberry32(SEED);
    for (let i = 0; i < N; i++) {
      const p = randomParts(r);
      const name = formatFinalFileName(p);
      const ctx = `benih ${SEED} kasus ${i}: ${JSON.stringify(p)} -> ${name}`;
      expect(FINAL_RE.test(name), ctx).toBe(true);
      expect(parseFinalFileName(name), ctx).toEqual(p);
      expect(formatFinalFileName(parseFinalFileName(name)!), ctx).toBe(name);
    }
  });

  it('docNumberSafe acak: idempoten, <= 80, cocok bagian C51', () => {
    const r = mulberry32(SEED + 1);
    const part = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,78}[A-Za-z0-9])?$/;
    for (let i = 0; i < N; i++) {
      const raw = randomDocNumber(r);
      const safe = docNumberSafe(raw);
      const ctx = `benih ${SEED + 1} kasus ${i}: ${JSON.stringify(raw)} -> ${safe}`;
      expect(part.test(safe), ctx).toBe(true);
      expect(docNumberSafe(safe), ctx).toBe(safe);
    }
  });

  it('finalFileNameOf acak (revisi dan artefak): nama lolos parser, bolak-balik, waktu = createdAt detik dipotong', () => {
    const r = mulberry32(SEED + 2);
    for (let i = 0; i < N; i++) {
      const ms = int(r, Date.UTC(1970, 0, 1), Date.UTC(2199, 11, 31, 23, 59, 59, 999));
      const createdAt = new Date(ms);
      const [format, ext] = pick(r, FORMATS);
      let sha256 = '';
      for (let k = 0; k < 64; k++) sha256 += pick(r, '0123456789abcdefABCDEF'.split(''));
      const owner = r() < 0.3 ? { artifactId: randomDocNumber(r) } : { docNumber: randomDocNumber(r), revisionNo: int(r, 0, 999999) };
      const name = finalFileNameOf({ createdAt, sha256, format }, owner);
      const ctx = `benih ${SEED + 2} kasus ${i}: ${JSON.stringify({ ms, format, owner })} -> ${name}`;
      const parsed = parseFinalFileName(name);
      expect(parsed, ctx).not.toBeNull();
      expect(formatFinalFileName(parsed!), ctx).toBe(name);
      expect(parsed!.renderedAt, ctx).toBe(new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z'));
      expect(parsed!.sha8, ctx).toBe(sha256.slice(0, 8).toLowerCase());
      expect(parsed!.ext, ctx).toBe(ext);
      expect(parsed!.revisionNo, ctx).toBe('artifactId' in owner ? 0 : owner.revisionNo);
      if ('artifactId' in owner) expect(parsed!.docNumberSafe.startsWith('ART'), ctx).toBe(true);
    }
  });

  it('mutasi satu karakter: parser tidak melempar; bila lolos, tetap bolak-balik', () => {
    const r = mulberry32(SEED + 3);
    const alphabet = 'Aa0_.-TZrevxé/ 9'.split('');
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < N; i++) {
      const name = formatFinalFileName(randomParts(r));
      const at = int(r, 0, name.length - 1);
      const mutant = name.slice(0, at) + pick(r, alphabet) + name.slice(at + 1);
      const parsed = parseFinalFileName(mutant);
      if (parsed === null) rejected++;
      else {
        accepted++;
        expect(formatFinalFileName(parsed), `benih ${SEED + 3} kasus ${i}: ${mutant}`).toBe(mutant);
      }
    }
    // Kedua cabang benar-benar dilalui (properti tidak hampa).
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});

// ── Draf: extract -> emit byte-identik ─────────────────────────────────────
interface GeneratedDraft {
  markdown: string;
  blocks: Array<{ text: string; line: number; endLine: number; value: unknown }>;
}

const WORDS = ['ringkasan', 'bukti', 'é', 'ü', '漢字', 'tab\t', 'kutip "x"', 'garis \\ miring', '```json di tengah', 'emoji-free', ''];
function randomJsonValue(r: Rng, depth: number): unknown {
  const k = depth > 2 ? int(r, 0, 3) : int(r, 0, 5);
  switch (k) {
    case 0:
      return pick(r, WORDS);
    case 1:
      return int(r, -1000, 1000) / pick(r, [1, 10, 100]);
    case 2:
      return pick(r, [true, false, null]);
    case 3:
      return `${pick(r, WORDS)} ${pick(r, WORDS)}`;
    case 4:
      return Array.from({ length: int(r, 0, 3) }, () => randomJsonValue(r, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = int(r, 0, 3); i > 0; i--) o[`k${int(r, 0, 99)}`] = randomJsonValue(r, depth + 1);
      return o;
    }
  }
}
function randomBlockValue(r: Rng): Record<string, unknown> {
  const schema = pick(r, ['studio.slot/v2', 'studio.chapter/v2', 'studio.doc/v2']);
  const o: Record<string, unknown> = { $schema: schema };
  for (let i = int(r, 0, 4); i > 0; i--) o[`f${i}`] = randomJsonValue(r, 0);
  return o;
}

/** Bangun draf: kepala, prosa, pagar pengecoh, dan blok json; catat teks/baris harapan secara mandiri. */
function generateDraft(r: Rng): GeneratedDraft {
  const lines: string[] = [];
  const ends: string[] = [];
  const crlfMode = pick(r, ['lf', 'crlf', 'mixed'] as const);
  const eol = () => (crlfMode === 'lf' ? '\n' : crlfMode === 'crlf' ? '\r\n' : pick(r, ['\n', '\r\n']));
  const push = (l: string) => {
    lines.push(l);
    ends.push(eol());
  };
  const blocks: GeneratedDraft['blocks'] = [];

  push('# DRAF properti DC-35');
  push('tujuan: uji bolak-balik');
  push('langkah-berikut: kirim apa adanya');
  push('basis: baru');
  push('');
  const k = int(r, 1, 5);
  for (let b = 0; b < k; b++) {
    // Pengecoh sebelum blok: prosa, pagar text, pagar 4-backtick berisi pagar json, tilde.
    switch (int(r, 0, 4)) {
      case 0:
        push(`Prosa ${pick(r, WORDS)} \`\`\`json bukan pagar`);
        break;
      case 1:
        push('```text');
        push('{ "$schema": "studio.slot/v2" }');
        push('```');
        break;
      case 2:
        push('````json');
        push('```json');
        push('{ "$schema": "studio.doc/v2" }');
        push('```');
        push('````');
        break;
      case 3:
        push('~~~');
        push('```json');
        push('~~~');
        break;
      default:
        push('');
    }
    const value = randomBlockValue(r);
    const indent = pick(r, [0, 2, 4, '\t'] as const);
    const bodyLines = JSON.stringify(value, null, indent === 0 ? undefined : indent).split('\n');
    push('```json');
    const open = lines.length; // 1-based baris pagar pembuka
    let text = '';
    bodyLines.forEach((l, i) => {
      push(l);
      text += l + (i < bodyLines.length - 1 ? ends[ends.length - 1] : '');
    });
    push('```');
    blocks.push({ text, line: open, endLine: lines.length, value });
    push('');
  }
  let markdown = '';
  lines.forEach((l, i) => (markdown += l + (i < lines.length - 1 ? ends[i] : pick(r, ['', '\n', '\r\n']))));
  return { markdown, blocks };
}

describe('DC-35 properti draf: extract -> emit byte-identik (§11.1, §11.3)', () => {
  const SEED = 0x0dc35d;
  const N = 60;
  let dir = '';
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc35-draft-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it(`${N} draf acak (LF/CRLF/campur, UTF-8, pagar pengecoh): blok, baris, teks, nilai sesuai`, () => {
    const r = mulberry32(SEED);
    for (let i = 0; i < N; i++) {
      const g = generateDraft(r);
      const ex = extractDraft(g.markdown);
      const ctx = `benih ${SEED} kasus ${i}`;
      expect(ex.issues.filter((x) => x.severity === 'error'), ctx).toEqual([]);
      expect(ex.blocks.map((b) => [b.index, b.line, b.endLine]), ctx).toEqual(g.blocks.map((b, j) => [j + 1, b.line, b.endLine]));
      ex.blocks.forEach((b, j) => {
        expect(b.text, `${ctx} blok ${j + 1}`).toBe(g.blocks[j].text);
        expect(b.value, `${ctx} blok ${j + 1}`).toEqual(g.blocks[j].value);
        expect(JSON.parse(b.text), `${ctx} blok ${j + 1}`).toEqual(g.blocks[j].value);
      });
    }
  });

  it('CLI --emit n (main in-process) mencetak byte blok persis seperti tertulis', async () => {
    const r = mulberry32(SEED + 1);
    for (let i = 0; i < 20; i++) {
      const g = generateDraft(r);
      const file = path.join(dir, `d${i}.md`);
      fs.writeFileSync(file, g.markdown, 'utf8');
      for (let j = 0; j < g.blocks.length; j++) {
        const chunks: string[] = [];
        const code = await main([file, '--emit', String(j + 1)], { stdout: (s) => chunks.push(s), stderr: () => {}, env: {} });
        const ctx = `benih ${SEED + 1} kasus ${i} blok ${j + 1}`;
        expect([0, 1], ctx).toContain(code);
        expect(Buffer.compare(Buffer.from(chunks.join(''), 'utf8'), Buffer.from(g.blocks[j].text, 'utf8')), ctx).toBe(0);
      }
      const missing = await main([file, '--emit', String(g.blocks.length + 1)], { stdout: () => {}, stderr: () => {}, env: {} });
      expect(missing).toBe(2);
    }
  });
});
