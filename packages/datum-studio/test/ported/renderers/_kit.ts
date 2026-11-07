// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/_kit.ts (see test/ported/README.md).
// S72: alat bersama uji unit renderer (DOCX, HTML, browser, soffice).
// Murni lokal: fixture repo + profil templat di memori; tanpa DB, tanpa jaringan.
// Pemeriksa XML/ZIP/PNG/sfnt di sini ditulis ulang dari spesifikasi (XML 1.0,
// APPNOTE ZIP, PNG, OpenType `name`), BUKAN memanggil kode produksi, agar
// ekspektasi tidak tautologis.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import type { FigureStore, NormBlock, NormDocSnapshot, RenderContext, RenderLogEntry, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { Register, normalizeRegisterEntry } from '@/lib/studio/engine/bind';
import { normalizeDocument } from '@/lib/studio/services/ingest/normalize';
import { resolveRepoAssetPath, scanCanonicalAssets } from '@/lib/studio/services/templates/assets';
import { loadResolvedProfileFile } from '@/lib/studio/services/templates/import';
import { DATUM_CANONICAL_SLUG, resolveProfileInMemory } from '@/lib/studio/services/templates/profile';

export const REPO = path.resolve(__dirname, '..', '..', '..', 'vendor');
export const FIXTURE_DIR = path.join(__dirname, '..', '_fixtures', 'tests', 'parity', 'fixtures', 'doc');
export const FIXTURES = ['doc_nota_memo', 'doc_nota_tables', 'doc_serah_handover', 'doc_terbit_report'] as const;
export type FixtureName = (typeof FIXTURES)[number];
export const BENCHMARK_PROFILE = path.join(REPO, 'benchmark', 'manual000', 'template.json');
/** Path kerja pendek S72 (brief controller). */
export const S72_WORK = 'C:/Users/TRIAL/AppData/Local/Temp/hq_v21_clone/s72';

export const FIGURE_TYPES = new Set(['chart', 'diagram', 'symbolSheet']);
export const TABLE_FAMILY = new Set([
  'table', 'specTable', 'registerTable', 'exampleWrongRight', 'ruleTable', 'checklist',
  'glossary', 'sourceRegister', 'ruleIndex', 'referenceScale', 'financialTable',
]);

export function sha256(b: Uint8Array | string): string {
  return createHash('sha256').update(b).digest('hex');
}

// ── Templat ──────────────────────────────────────────────────────────────
let canonicalCache: ResolvedTemplate | null = null;
export async function canonicalTemplate(): Promise<ResolvedTemplate> {
  if (canonicalCache) return canonicalCache;
  const ca = await scanCanonicalAssets(REPO);
  canonicalCache = resolveProfileInMemory(
    { base: DATUM_CANONICAL_SLUG, slug: DATUM_CANONICAL_SLUG, kind: 'DOCUMENT', overrides: {} },
    { canonicalAssets: ca, resolveAssetPath: (rel: string) => resolveRepoAssetPath(rel, REPO) },
  );
  return canonicalCache;
}

export async function benchmarkTemplate(): Promise<ResolvedTemplate> {
  const r = await loadResolvedProfileFile(BENCHMARK_PROFILE, { repoRoot: REPO, withCanonicalAssets: true });
  return r.template;
}

/**
 * SR-42 lanjutan (D-138, D-256): fixture doc konten-saja membawa profil tampilan
 * pendamping `<stem>.template.json` (bila ada). Render "resmi" fixture = fixture +
 * pendamping, seperti `render_cli --template`; tanpa pendamping = profil kanonik.
 */
export async function fixtureTemplate(name: FixtureName): Promise<ResolvedTemplate> {
  const file = path.join(FIXTURE_DIR, `${name}.template.json`);
  if (!existsSync(file)) return canonicalTemplate();
  return (await loadResolvedProfileFile(file, { repoRoot: REPO, withCanonicalAssets: true })).template;
}

// ── Fixture -> snapshot ──────────────────────────────────────────────────
export function loadFixtureDoc(name: FixtureName): StudioDocV1 {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as StudioDocV1;
}

export function snapshotOf(doc: StudioDocV1): NormDocSnapshot {
  const r = normalizeDocument(doc);
  if (r.issues.length > 0) throw new Error(`fixture tidak ternormalisasi: ${JSON.stringify(r.issues.slice(0, 3))}`);
  const snap = r.snapshot;
  for (const [k, e] of Object.entries(snap.register)) snap.register[k] = normalizeRegisterEntry(k, e);
  return snap;
}

// ── PNG sintetis (encoder independen, spesifikasi PNG) ──────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'ascii');
  Buffer.from(data).copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
/** PNG RGB putih w x h (opsional garis hitam diagonal agar isi tidak seragam). */
export function makePng(w: number, h: number, seed = 0): Uint8Array {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h, 255);
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0;
    const x = (y + seed) % w;
    raw.fill(0, y * row + 1 + x * 3, y * row + 1 + x * 3 + 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array())]),
  );
}

/** Pembaca PNG independen: ukuran IHDR dan pHYs (px/m) bila ada. */
export function pngInfo(b: Uint8Array): { width: number; height: number; physX?: number; physY?: number; unit?: number } | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: { width: number; height: number; physX?: number; physY?: number; unit?: number } = { width: dv.getUint32(16), height: dv.getUint32(20) };
  let p = 8;
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === 'pHYs') {
      out.physX = dv.getUint32(p + 8);
      out.physY = dv.getUint32(p + 12);
      out.unit = b[p + 16];
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

/** Ukuran figur stub: lebar 166 mm, tinggi 60 mm, PNG 300 dpi (1961 x 709 px). */
export const STUB_FIG = { widthMm: 166, heightMm: 60, png: makePng(1961, 709) };

/** FigureStore stub hanya untuk kunci blok figur (chart/diagram/symbolSheet) snapshot. */
export function stubFigures(snap: NormDocSnapshot): FigureStore & { keys: Set<string> } {
  const keys = new Set<string>();
  for (const b of snap.blocks) {
    if (!FIGURE_TYPES.has(b.type)) continue;
    for (const k of [b.artifactLabel, snap.numbering?.[b.blockId], b.blockId, b.address]) if (typeof k === 'string' && k) keys.add(k);
  }
  return {
    keys,
    get: (label: string) => (keys.has(label) ? { png: STUB_FIG.png, widthMm: STUB_FIG.widthMm, heightMm: STUB_FIG.heightMm } : undefined),
  };
}

export interface CtxBundle {
  ctx: RenderContext;
  logs: RenderLogEntry[];
}

export function makeCtx(snap: NormDocSnapshot, tpl: ResolvedTemplate, extra: Partial<RenderContext> = {}): CtxBundle {
  const logs: RenderLogEntry[] = [];
  const ctx: RenderContext = {
    snapshot: snap,
    tpl,
    register: new Register(snap.register ?? {}),
    fixedDate: snap.doc.meta.issueDate,
    figures: stubFigures(snap),
    log: (e) => logs.push(e),
    ...extra,
  };
  return { ctx, logs };
}

// ── XML 1.0: pemeriksa kerapian + pohon minimal ─────────────────────────
export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const NAME = '[A-Za-z_][A-Za-z0-9_.:-]*';
const TAG_RE = new RegExp(`<(/?)(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(/?)>`, 'y');
const ATTR_RE = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'g');
const ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/y;

function invalidCharAt(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return i;
    if (c === 0xfffe || c === 0xffff) return i;
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return i;
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return i;
  }
  return -1;
}

function checkRefs(s: string, where: string, errs: string[]): void {
  for (let i = s.indexOf('&'); i >= 0; i = s.indexOf('&', i + 1)) {
    ENTITY_RE.lastIndex = i;
    if (!ENTITY_RE.test(s)) errs.push(`${where}: '&' tanpa referensi entitas sah dekat "${s.slice(i, i + 24)}"`);
  }
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse XML (subset: tanpa DTD). Mengembalikan akar + daftar galat kerapian. */
export function parseXml(xml: string): { root: XNode | null; errors: string[] } {
  const errors: string[] = [];
  const bad = invalidCharAt(xml);
  if (bad >= 0) errors.push(`karakter tak sah XML 1.0 U+${xml.charCodeAt(bad).toString(16).toUpperCase().padStart(4, '0')} di offset ${bad}`);
  const doc: XNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XNode[] = [doc];
  let i = 0;
  const pushText = (t: string) => {
    if (!t) return;
    checkRefs(t, `teks dalam <${stack[stack.length - 1].name}>`, errors);
    if (t.includes(']]>')) errors.push("teks memuat ']]>'");
    if (stack.length === 1 && t.trim()) errors.push(`teks di luar akar: "${t.trim().slice(0, 30)}"`);
    stack[stack.length - 1].text += unescapeXml(t);
  };
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      pushText(xml.slice(i));
      break;
    }
    pushText(xml.slice(i, lt));
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt);
      if (e < 0) { errors.push('PI tidak tertutup'); break; }
      i = e + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt);
      if (e < 0) { errors.push('komentar tidak tertutup'); break; }
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt);
      if (e < 0) { errors.push('CDATA tidak tertutup'); break; }
      stack[stack.length - 1].text += xml.slice(lt + 9, e);
      i = e + 3;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(xml);
    if (!m) {
      errors.push(`tag rusak di offset ${lt}: "${xml.slice(lt, lt + 40)}"`);
      break;
    }
    const [whole, close, name, attrText, selfClose] = m;
    if (close) {
      const top = stack.pop();
      if (!top || top.name !== name) {
        errors.push(`tag tutup </${name}> tidak cocok dengan <${top?.name}> di offset ${lt}`);
        break;
      }
    } else {
      const attrs: Record<string, string> = {};
      for (const a of attrText.matchAll(ATTR_RE)) {
        const v = a[2] ?? a[3] ?? '';
        if (a[1] in attrs) errors.push(`atribut ganda ${a[1]} pada <${name}>`);
        if (v.includes('<')) errors.push(`'<' dalam nilai atribut ${a[1]} pada <${name}>`);
        checkRefs(v, `atribut ${a[1]} pada <${name}>`, errors);
        attrs[a[1]] = unescapeXml(v);
      }
      const node: XNode = { name, attrs, children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent === doc && doc.children.length > 0) errors.push(`akar kedua <${name}>`);
      parent.children.push(node);
      if (!selfClose) stack.push(node);
    }
    i = lt + whole.length;
  }
  if (stack.length > 1) errors.push(`tag tidak tertutup: ${stack.slice(1).map((n) => n.name).join(' > ')}`);
  return { root: doc.children[0] ?? null, errors };
}

/** Bungkus fragmen OOXML (banyak akar, prefiks namespace) agar dapat diperiksa. */
export function parseFragment(xml: string): { root: XNode | null; errors: string[] } {
  return parseXml(`<frag>${xml}</frag>`);
}

export function findAll(n: XNode | null, name: string, out: XNode[] = []): XNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** Teks `w:t` berurutan (w:tab -> spasi), dinormalisasi spasi. */
export function wText(n: XNode | null): string {
  const parts: string[] = [];
  const walk = (x: XNode) => {
    if (x.name === 'w:t') parts.push(x.text);
    else if (x.name === 'w:tab' || x.name === 'w:br') parts.push(' ');
    for (const c of x.children) walk(c);
  };
  if (n) walk(n);
  return parts.join('');
}

export function normWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── ZIP ──────────────────────────────────────────────────────────────────
export function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

export function partText(parts: Record<string, Uint8Array>, p: string): string {
  const b = parts[p];
  if (!b) throw new Error(`bagian ${p} tidak ada`);
  return new TextDecoder().decode(b);
}

/** Entri ZIP dari local file header berurutan (APPNOTE 4.3.7): nama + tanggal/waktu DOS. */
export function zipLocalEntries(bytes: Uint8Array): Array<{ name: string; dosTime: number; dosDate: number }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<{ name: string; dosTime: number; dosDate: number }> = [];
  let p = 0;
  while (p + 30 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const flags = dv.getUint16(p + 6, true);
    const dosTime = dv.getUint16(p + 10, true);
    const dosDate = dv.getUint16(p + 12, true);
    const csize = dv.getUint32(p + 18, true);
    const nlen = dv.getUint16(p + 26, true);
    const xlen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nlen));
    out.push({ name, dosTime, dosDate });
    if (flags & 0x08) throw new Error('data descriptor tidak didukung pembaca uji');
    p += 30 + nlen + xlen + csize;
  }
  return out;
}

export function dosDateOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return ((y - 1980) << 9) | (m << 5) | d;
}

// ── OpenType `name` (nameID 1 / 16) ─────────────────────────────────────
export function sfntFamilies(b: Uint8Array): { sfntVersion: number; family?: string; typoFamily?: string } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sfntVersion = dv.getUint32(0);
  const numTables = dv.getUint16(4);
  let nameOff = -1;
  for (let t = 0; t < numTables; t++) {
    const rec = 12 + t * 16;
    const tag = String.fromCharCode(b[rec], b[rec + 1], b[rec + 2], b[rec + 3]);
    if (tag === 'name') nameOff = dv.getUint32(rec + 8);
  }
  if (nameOff < 0) return { sfntVersion };
  const count = dv.getUint16(nameOff + 2);
  const strOff = nameOff + dv.getUint16(nameOff + 4);
  const found: Record<number, string> = {};
  for (let r = 0; r < count; r++) {
    const rec = nameOff + 6 + r * 12;
    const platform = dv.getUint16(rec);
    const encoding = dv.getUint16(rec + 2);
    const language = dv.getUint16(rec + 4);
    const nameId = dv.getUint16(rec + 6);
    const len = dv.getUint16(rec + 8);
    const off = dv.getUint16(rec + 10);
    if ((nameId !== 1 && nameId !== 16) || platform !== 3 || encoding !== 1 || language !== 0x409) continue;
    let s = '';
    for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(strOff + off + k));
    found[nameId] = s;
  }
  return { sfntVersion, family: found[1], typoFamily: found[16] };
}

/** Kebalikan obfuscation ECMA-376 (implementasi independen dari uji). */
export function deobfuscateOdttf(odttf: Uint8Array, guid: string): Uint8Array {
  const hex = guid.replace(/[{}-]/g, '');
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = parseInt(hex.slice(30 - i * 2, 32 - i * 2), 16);
  const out = new Uint8Array(odttf);
  for (let i = 0; i < 32; i++) out[i] ^= key[i % 16];
  return out;
}

export function blockOf(snap: NormDocSnapshot, pred: (b: NormBlock) => boolean): NormBlock {
  const b = snap.blocks.find(pred);
  if (!b) throw new Error('blok tidak ditemukan');
  return b;
}
