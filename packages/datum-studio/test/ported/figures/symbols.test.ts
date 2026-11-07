// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/symbols.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S73: pustaka simbol engine/symbols (S31, I21; D-42): 41 simbol (iec 16, isa 12,
// sec 7, mil 6) - render, viewBox 24 x 24 mm, determinisme, port, lembar per dialek,
// alias kanonik, dan penolakan SCHEMA_INVALID.
import { describe, it, expect } from '../_vitest';
import { SYMBOL_DIALECTS } from '@/lib/studio/contract';
import {
  SYMBOL_COUNTS_BY_DIALECT,
  SYMBOL_IDS,
  SYMBOL_IDS_COUNT,
  canonicalSymbolId,
  symbolPortsMm,
  symbolSheetSvg,
  symbolSvg,
} from '@/lib/studio/engine/symbols';
import { assertBalancedXml, catchErr, rootAttr } from './_helpers';

/** Urutan `--list` HS (dialek terurut, id terurut), dibekukan dari fixture paritas symbols.json. */
const EXPECTED_IDS = [
  'iec:arrester', 'iec:battery', 'iec:breaker', 'iec:busbar', 'iec:changeover', 'iec:contactor', 'iec:ct',
  'iec:disconnector', 'iec:earth', 'iec:enclosure', 'iec:fuse', 'iec:generator', 'iec:lamp', 'iec:motor',
  'iec:switch', 'iec:transformer',
  'isa:auxiliary', 'isa:computer', 'isa:field', 'isa:inaccessible', 'isa:plc', 'isa:primary', 'isa:shared',
  'isa:shared-field', 'isa:valve', 'isa:valve-diaphragm', 'isa:valve-motor', 'isa:valve-solenoid',
];

describe('symbols: katalog', () => {
  it('41 id unik, hitungan per dialek iec 16 / isa 12 / sec 7 / mil 6', () => {
    expect(SYMBOL_IDS).toHaveLength(41);
    expect(SYMBOL_IDS_COUNT).toBe(41);
    expect(new Set(SYMBOL_IDS).size).toBe(41);
    expect(SYMBOL_COUNTS_BY_DIALECT).toEqual({ iec: 16, isa: 12, sec: 7, mil: 6 });
  });

  it('urutan = --list HS: dialek terurut lalu id terurut; awalan iec/isa cocok fixture paritas', () => {
    expect(SYMBOL_IDS.slice(0, EXPECTED_IDS.length)).toEqual(EXPECTED_IDS);
    const dialects = SYMBOL_IDS.map((id) => id.split(':')[0]);
    expect([...new Set(dialects)]).toEqual(['iec', 'isa', 'mil', 'sec']);
    for (const d of SYMBOL_DIALECTS) {
      const ids = SYMBOL_IDS.filter((id) => id.startsWith(`${d}:`));
      expect(ids).toEqual([...ids].sort());
    }
  });

  it('id kanonik: huruf kecil, dialek:nama, tanpa garis bawah (E-11)', () => {
    for (const id of SYMBOL_IDS) expect(id).toMatch(/^(iec|isa|mil|sec):[a-z0-9-]+$/);
  });
});

describe('symbols: render setiap simbol', () => {
  for (const id of SYMBOL_IDS) {
    it(`${id}: SVG 24 x 24 mm, viewBox 0 0 24 24, deterministik, berimbang`, () => {
      const a = symbolSvg(id);
      const b = symbolSvg(id);
      expect(a).toBe(b);
      expect(a.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(rootAttr(a, 'viewBox')).toBe('0 0 24 24');
      expect(rootAttr(a, 'width')).toBe('24mm');
      expect(rootAttr(a, 'height')).toBe('24mm');
      expect(rootAttr(a, 'data-mark')).toBe('node');
      expect(rootAttr(a, 'data-symbol')).toBe(id);
      assertBalancedXml(a);
      // punya geometri nyata, tanpa raster/rujukan luar, warna hanya hex palet
      expect(a).toMatch(/<(line|rect|circle|path|polygon|polyline|ellipse)\b/);
      expect(a).not.toMatch(/<image\b|href="http/);
      for (const m of a.matchAll(/(?:fill|stroke)="([^"]+)"/g)) expect(m[1]).toMatch(/^(#[0-9A-F]{6}|none)$/);
      // tidak ada NaN/Infinity/undefined bocor ke atribut
      expect(a).not.toMatch(/NaN|Infinity|undefined/);
    });
  }

  it('semua 41 SVG berbeda satu sama lain (tidak ada simbol kosong/duplikat)', () => {
    const bodies = SYMBOL_IDS.map((id) => symbolSvg(id).replace(/data-symbol="[^"]*"/, ''));
    expect(new Set(bodies).size).toBe(41);
  });
});

describe('symbols: port sambungan', () => {
  for (const id of SYMBOL_IDS) {
    it(`${id}: port di dalam petak 0..24 mm, nama unik, deterministik`, () => {
      const p = symbolPortsMm(id);
      expect(p).toEqual(symbolPortsMm(id));
      expect(new Set(p.map((x) => x.name)).size).toBe(p.length);
      for (const { x, y } of p) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(24);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(24);
      }
    });
  }
});

describe('symbols: alias dan penolakan', () => {
  it('alias garis bawah Rev F dan huruf besar dikanonkan, keluaran sama', () => {
    expect(canonicalSymbolId('isa:shared_field')).toBe('isa:shared-field');
    expect(canonicalSymbolId('MIL:FRIEND_AIR')).toBe('mil:friend-air');
    expect(canonicalSymbolId('  IEC:Breaker ')).toBe('iec:breaker');
    expect(symbolSvg('isa:valve_motor')).toBe(symbolSvg('isa:valve-motor'));
    expect(symbolPortsMm('IEC:MOTOR')).toEqual(symbolPortsMm('iec:motor'));
  });

  it.each(['iec:tidak-ada', 'xyz:breaker', '', 'breaker', 'iec_breaker', 'iec:breaker<script>'])('id tidak sah %j -> SCHEMA_INVALID', (id) => {
    const e = catchErr(() => symbolSvg(id));
    expect(e.code).toBe('SCHEMA_INVALID');
    expect(catchErr(() => symbolPortsMm(id)).code).toBe('SCHEMA_INVALID');
  });
});

describe('symbols: lembar per dialek', () => {
  for (const d of SYMBOL_DIALECTS) {
    it(`${d}: setiap halaman 166 x 247 mm, memuat setiap simbol dialek tepat sekali, deterministik`, () => {
      const pages = symbolSheetSvg(d);
      expect(pages).toEqual(symbolSheetSvg(d));
      expect(pages.length).toBeGreaterThanOrEqual(1);
      const all = pages.join('');
      for (const p of pages) {
        expect(rootAttr(p, 'viewBox')).toBe('0 0 166 247');
        expect(rootAttr(p, 'data-dialect')).toBe(d);
        assertBalancedXml(p);
      }
      const ids = SYMBOL_IDS.filter((id) => id.startsWith(`${d}:`));
      for (const id of ids) {
        expect(all.split(`data-symbol="${id}"`).length - 1).toBe(1);
      }
      expect(pages[0]).toContain(`PUSTAKA SIMBOL ${d.toUpperCase()} LEMBAR 1/${pages.length}`);
    });
  }

  it('cols 3 = satu halaman per dialek (paritas S31); cols 1 memecah halaman', () => {
    for (const d of SYMBOL_DIALECTS) expect(symbolSheetSvg(d, 3)).toHaveLength(1);
    expect(symbolSheetSvg('iec', 1).length).toBeGreaterThan(1);
  });

  it.each([0, 7, 2.5, -1, Number.NaN])('cols tidak sah %s -> SCHEMA_INVALID', (cols) => {
    expect(catchErr(() => symbolSheetSvg('iec', cols)).code).toBe('SCHEMA_INVALID');
  });

  it('dialek tidak dikenal -> SCHEMA_INVALID', () => {
    expect(catchErr(() => symbolSheetSvg('ansi' as never)).code).toBe('SCHEMA_INVALID');
  });
});
