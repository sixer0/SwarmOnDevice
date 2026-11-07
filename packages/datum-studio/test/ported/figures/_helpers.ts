// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/_helpers.ts (see test/ported/README.md).
// S73 (uji unit figures): helper bersama untuk diagram, simbol, dan chart.
// Murni lokal: membaca fixture dari repo, tanpa DB/jaringan/jam/acak.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { StudioEngineError } from '@/lib/studio/contract/errors';

export const REPO = path.resolve(__dirname, '..', '..', '..', 'vendor');
export const OWN_FIXTURES = path.join(__dirname, 'fixtures');
/** Fixture paritas S63 (read-only, milik baris paritas; tidak diubah S73). */
export const PARITY_DIAGRAM_DIR = path.join(__dirname, '..', '_fixtures', 'tests', 'parity', 'fixtures', 'diagram');
export const PARITY_CHART_DIR = path.join(__dirname, '..', '_fixtures', 'tests', 'parity', 'fixtures', 'chart');
/** Sumber acuan HS (di luar repo; hanya dipakai penjaga drift, dilewati bila tidak ada). */
export const HS_BAD_CASES = 'C:\\Users\\TRIAL\\AppData\\Local\\hermes\\skills\\gsp\\datum-house-style\\fixtures_diagram\\bad_cases.json';

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Salinan dalam: renderer/validator tidak boleh berbagi objek antar-kasus. */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export interface BadCase {
  name: string;
  expect: string;
  spec: Record<string, unknown>;
}

export function badCases(): BadCase[] {
  return readJson<{ cases: BadCase[] }>(path.join(OWN_FIXTURES, 'bad_cases.json')).cases;
}

export function hsBadCasesAvailable(): boolean {
  return existsSync(HS_BAD_CASES);
}

/** Semua spec diagram paritas `dg_*.json` (9 keluarga + varian flow terbungkus). */
export function parityDiagramSpecs(): Array<{ file: string; spec: Record<string, unknown> }> {
  return readdirSync(PARITY_DIAGRAM_DIR)
    .filter((f) => f.startsWith('dg_') && f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, spec: readJson<Record<string, unknown>>(path.join(PARITY_DIAGRAM_DIR, file)) }));
}

/** Spec chart per kode: fixture paritas S63 lalu salinan panel galeri S94 (menimpa). */
export function chartSpecsByCode(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const f of readdirSync(PARITY_CHART_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const s = readJson<Record<string, unknown>>(path.join(PARITY_CHART_DIR, f));
    out[String(s.kind)] = s;
  }
  const extra = readJson<{ specs: Record<string, Record<string, unknown>> }>(path.join(OWN_FIXTURES, 'chart_extra_panels.json'));
  Object.assign(out, extra.specs);
  return out;
}

/** Tangkap galat sinkron; gagal bila fungsi tidak melempar. */
export function catchErr(fn: () => unknown): StudioEngineError & { checkId?: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof StudioEngineError) return e as StudioEngineError & { checkId?: string };
    throw e;
  }
  throw new Error('diharapkan melempar StudioEngineError, ternyata tidak');
}

/** `checkId` dari `details` StudioEngineError atau properti DiagramDefect. */
export function checkIdOf(e: StudioEngineError & { checkId?: string }): string | undefined {
  if (e.checkId) return e.checkId;
  const d = e.details as { checkId?: string } | undefined;
  return d?.checkId;
}

/**
 * Pemeriksa keseimbangan tag XML ringan (tanpa dependensi): setiap tag buka punya
 * penutup yang cocok, tanpa sisa. Komentar, deklarasi, dan CDATA dilewati.
 */
export function assertBalancedXml(svg: string): void {
  const body = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (close) {
      const top = stack.pop();
      if (top !== name) throw new Error(`tag penutup </${name}> tidak cocok dengan <${top ?? '(kosong)'}>`);
    } else stack.push(name);
  }
  if (stack.length) throw new Error(`tag tidak ditutup: ${stack.join(', ')}`);
}

/** Atribut akar `<svg ...>`. */
export function rootAttr(svg: string, name: string): string | undefined {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  return new RegExp(`\\s${name}="([^"]*)"`).exec(root)?.[1];
}

export function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}
