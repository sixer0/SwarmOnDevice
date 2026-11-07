// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/contract/secfix2-schema-walk.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// SEC-FIX2 N-2 (D-506): setiap larik di skema figur (chart/diagram v1, blok figur dokumen v1, blok figur v2) wajib
// `maxItems`, setiap string wajib `maxLength` (atau pola berjangkar berbatas), dan tidak ada isi terbuka selain yang
// tercatat di ALLOW_OPEN. Uji menelusuri skema kontrak yang SAMA yang dikompilasi validator (`$ref` diikuti), lalu
// memeriksa bahwa batas yang dideklarasikan benar-benar diterapkan validator (N lolos, N+1 ditolak).
import { describe, expect, it } from '../_vitest';
import { CHART_SCHEMA_ID, chartSchema } from '@/lib/studio/contract/schema/chart.schema';
import { COMMON_SCHEMA_ID, commonSchema } from '@/lib/studio/contract/schema/common.schema';
import { DIAGRAM_SCHEMA_ID, diagramSchema } from '@/lib/studio/contract/schema/diagram.schema';
import { DOC_SCHEMA_ID, docSchema } from '@/lib/studio/contract/schema/doc.schema';
import { COMMON_V2_SCHEMA_ID, commonV2Schema } from '@/lib/studio/contract/schema/v2/common.schema';
import { validateSchema } from '@/lib/studio/services/ingest';
import { validateBlockV2 } from '@/lib/studio/services/revisions/v2/body';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- skema JSON bebas bentuk
type Sch = Record<string, any>;

const DOCS: Record<string, Sch> = {
  [CHART_SCHEMA_ID]: chartSchema,
  [DIAGRAM_SCHEMA_ID]: diagramSchema,
  [COMMON_SCHEMA_ID]: commonSchema,
  [DOC_SCHEMA_ID]: docSchema,
  [COMMON_V2_SCHEMA_ID]: commonV2Schema,
};
const SHORT: Record<string, string> = {
  [CHART_SCHEMA_ID]: 'chart/v1',
  [DIAGRAM_SCHEMA_ID]: 'diagram/v1',
  [COMMON_SCHEMA_ID]: 'common/v1',
  [DOC_SCHEMA_ID]: 'doc/v1',
  [COMMON_V2_SCHEMA_ID]: 'common/v2',
};

function resolve(ref: string): { node: Sch; at: string } {
  const [id, frag = ''] = ref.split('#');
  const root = DOCS[id];
  if (!root) throw new Error(`$ref tak dikenal: ${ref}`);
  let node: Sch = root;
  for (const seg of frag.split('/').filter(Boolean)) node = node[seg];
  if (node === undefined) throw new Error(`$ref tak teresolusi: ${ref}`);
  return { node, at: `${SHORT[id]}${frag ? `#${frag}` : ''}` };
}

/**
 * Isi terbuka yang sengaja diizinkan (dengan alasan). Lokasi = lokasi skema yang dilaporkan penelusur.
 * - chart/v1 `x` (spec dan panel): metadata tak-tergambar (D-113); mesin mengabaikannya, dibatasi
 *   `FIGURE_LIMITS.figureBytes` di cek kapasitas.
 * - doc/v1 blok `x`: metadata blok yang tidak masuk mesin figur; dibatasi ukuran blok di cek kapasitas render.
 */
const ALLOW_OPEN = new Set([
  'chart/v1/properties/x',
  'chart/v1#/$defs/ChartPanelSpec/properties/x',
  'doc/v1#/$defs/ChartBlock/properties/x',
  'doc/v1#/$defs/DiagramBlock/properties/x',
]);

/** Pola berjangkar tanpa `*`/`+` = panjang berbatas. */
const boundedPattern = (p: unknown) => typeof p === 'string' && p.startsWith('^') && p.endsWith('$') && !/[*+]/.test(p.replace(/\\./g, ''));

interface Walk {
  arrays: string[];
  strings: string[];
  open: string[];
  maxItems: Map<string, number>;
  seen: Set<string>;
}

function walk(s: unknown, at: string, w: Walk, override?: Sch): void {
  if (typeof s !== 'object' || s === null) return;
  let node = s as Sch;
  if (override) node = { ...node, ...override };
  if (typeof node.$ref === 'string') {
    // `$ref` + saudara (2020-12): saudara `properties`/`additionalProperties` mempersempit target (batas khusus figur).
    const { $ref: _ref, ...rest } = node;
    void _ref;
    const sib = rest.properties || typeof rest.additionalProperties === 'object' ? rest : undefined;
    const key = `${node.$ref}|${sib ? JSON.stringify(sib) : ''}`;
    if (w.seen.has(key)) return;
    w.seen.add(key);
    const t = resolve(node.$ref);
    walkProps(t.node, t.at, w, sib);
    return;
  }
  walkProps(node, at, w);
}

function walkProps(node: Sch, at: string, w: Walk, sib?: Sch): void {
  if (typeof node !== 'object' || node === null) return;
  if (typeof node.$ref === 'string') return walk(node, at, w);
  const types: string[] = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const fixed = node.const !== undefined || Array.isArray(node.enum);
  if (types.includes('array') || node.items !== undefined || node.prefixItems !== undefined) {
    if (typeof node.maxItems !== 'number') w.arrays.push(at);
    else w.maxItems.set(at, node.maxItems);
  }
  if (types.includes('string') && !fixed && typeof node.maxLength !== 'number' && !boundedPattern(node.pattern)) w.strings.push(at);
  const isOpenObj =
    node.additionalProperties === true ||
    (types.includes('object') && node.properties === undefined && node.additionalProperties === undefined && node.oneOf === undefined && node.anyOf === undefined);
  const untyped = types.length === 0 && !fixed && Object.keys(node).every((k) => ['description', 'title'].includes(k));
  if ((isOpenObj || untyped) && !ALLOW_OPEN.has(at)) w.open.push(at);
  if (typeof node.additionalProperties === 'object' && typeof node.maxProperties !== 'number') w.open.push(`${at} (peta tanpa maxProperties)`);

  if (node.properties && typeof node.properties === 'object' && !ALLOW_OPEN.has(at)) {
    for (const [k, v] of Object.entries(node.properties as Sch)) walk(v, `${at}/properties/${k}`, w, sib?.properties?.[k]);
  }
  if (node.items !== undefined) walk(node.items, `${at}/items`, w);
  if (Array.isArray(node.prefixItems)) node.prefixItems.forEach((x: unknown, i: number) => walk(x, `${at}/prefixItems/${i}`, w));
  if (typeof node.additionalProperties === 'object') walk(node.additionalProperties, `${at}/additionalProperties`, w, sib?.additionalProperties);
  for (const k of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(node[k])) node[k].forEach((x: unknown, i: number) => walk(x, `${at}/${k}/${i}`, w));
  }
  for (const k of ['if', 'then', 'else', 'contains'] as const) if (node[k] !== undefined) walk(node[k], `${at}/${k}`, w);
  for (const k of ['dependentSchemas', 'patternProperties'] as const) {
    if (node[k]) for (const [kk, v] of Object.entries(node[k] as Sch)) walk(v, `${at}/${k}/${kk}`, w);
  }
  // `not` sengaja tidak ditelusuri: isinya menolak, bukan menerima.
}

/** Akar skema figur yang diterima masukan agen/artefak. */
const ROOTS: Array<[string, string]> = [
  ['studio.chart/v1 (artefak R09)', CHART_SCHEMA_ID],
  ['studio.diagram/v1 (artefak R09)', DIAGRAM_SCHEMA_ID],
  ['doc/v1 ChartBlock', `${DOC_SCHEMA_ID}#/$defs/ChartBlock`],
  ['doc/v1 DiagramBlock', `${DOC_SCHEMA_ID}#/$defs/DiagramBlock`],
  ['v2 ChartV2', `${COMMON_V2_SCHEMA_ID}#/$defs/ChartV2`],
  ['v2 DiagramV2', `${COMMON_V2_SCHEMA_ID}#/$defs/DiagramV2`],
];

function walkAll(): Walk {
  const w: Walk = { arrays: [], strings: [], open: [], maxItems: new Map(), seen: new Set() };
  for (const [, ref] of ROOTS) walk({ $ref: ref }, ref, w);
  return w;
}

describe('SEC-FIX2 N-2: penelusuran skema figur (v1 + v2)', () => {
  const w = walkAll();

  it('menelusuri semua akar figur (cakupan tidak kosong)', () => {
    expect(w.maxItems.size + w.arrays.length).toBeGreaterThan(40);
  });

  it('tidak ada larik figur tanpa maxItems', () => {
    expect(w.arrays).toEqual([]);
  });

  it('tidak ada string figur tanpa maxLength (atau pola berjangkar berbatas)', () => {
    expect(w.strings).toEqual([]);
  });

  it('tidak ada isi terbuka/peta tanpa batas selain ALLOW_OPEN', () => {
    expect(w.open).toEqual([]);
  });
});

// ── Batas diterapkan validator, bukan hanya dideklarasikan ───────────────────────────────────────────────────
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
/** maxItems yang dideklarasikan penelusur pada lokasi skema (sumber kebenaran = skema, bukan konstanta uji). */
function declared(loc: string): number {
  const w = walkAll();
  const n = w.maxItems.get(loc);
  if (n === undefined) throw new Error(`lokasi tanpa maxItems: ${loc}`);
  return n;
}

const nodes = (n: number) => range(n).map((i) => ({ id: `n${i}`, label: `N${i}`, class: {} }));
const v1Diagram = (extra: Sch) => ({
  $schema: 'studio.diagram/v1', family: 'graph', id: 'Gambar 1.1', title: 'Alur.', classification: 'TERBATAS', width_mm: 166,
  sources: ['s'], nodes: nodes(3), edges: [], ...extra,
});
const v2Diagram = (spec: Sch, extra: Sch = {}) => ({
  type: 'diagram', caption: { text: 'Diagram' }, source: { text: 'Uji' }, spec: { family: 'graph', nodes: nodes(3), ...spec }, ...extra,
});
const v1Chart = (extra: Sch) => ({ $schema: 'studio.chart/v1', kind: 'P-02', title: 'Beban', source: 'Uji', widthMm: 166, ...extra });
const pts = (n: number) => range(n).map((i) => ({ label: `K${i}`, value: i }));
const zones = (n: number) => range(n).map((i) => ({ id: `z${i}`, label: `Z${i}`, members: ['n0'] }));
const strs = (n: number) => range(n).map((i) => `S${i}`);

/** [nama, lokasi skema, pembuat masukan(N), validator -> pointer galat maxItems]. */
const APPLIED: Array<[string, string, (n: number) => unknown, (x: unknown) => string[]]> = [
  ['v1 diagram zones', 'diagram/v1/properties/zones', (n) => v1Diagram({ zones: zones(n) }), (x) => maxItems(validateSchema('studio.diagram/v1', x))],
  ['v1 diagram zones.members', 'diagram/v1/properties/zones/items/properties/members', (n) => v1Diagram({ zones: [{ id: 'z', label: 'Z', members: range(n).map(() => 'n0') }] }), (x) => maxItems(validateSchema('studio.diagram/v1', x))],
  ['v1 diagram legend', 'diagram/v1/properties/legend', (n) => v1Diagram({ legend: strs(n) }), (x) => maxItems(validateSchema('studio.diagram/v1', x))],
  ['v1 diagram notes', 'diagram/v1/properties/notes', (n) => v1Diagram({ notes: strs(n) }), (x) => maxItems(validateSchema('studio.diagram/v1', x))],
  ['v1 diagram sources', 'diagram/v1/properties/sources', (n) => v1Diagram({ sources: strs(n) }), (x) => maxItems(validateSchema('studio.diagram/v1', x))],
  ['v1 diagram nodes', 'diagram/v1/properties/nodes', (n) => v1Diagram({ nodes: nodes(n) }), (x) => maxItems(validateSchema('studio.diagram/v1', x))],
  ['v1 chart points', 'chart/v1#/$defs/ChartData/oneOf/0/properties/points', (n) => v1Chart({ data: { shape: 'categorical', points: pts(n) } }), (x) => maxItems(validateSchema('studio.chart/v1', x))],
  ['v2 diagram zones', 'diagram/v1/properties/zones', (n) => v2Diagram({ zones: zones(n) }), (x) => maxItems(validateBlockV2(x, '/b'))],
  ['v2 diagram legend', 'diagram/v1/properties/legend', (n) => v2Diagram({ legend: strs(n) }), (x) => maxItems(validateBlockV2(x, '/b'))],
  ['v2 diagram notes', 'diagram/v1/properties/notes', (n) => v2Diagram({ notes: strs(n) }), (x) => maxItems(validateBlockV2(x, '/b'))],
  ['v2 keyRow runs', 'common/v2#/$defs/InlineV2/properties/runs', (n) => v2Diagram({}, { keyRow: { runs: range(n).map(() => ({ t: 'a' })) } }), (x) => maxItems(validateBlockV2(x, '/b'))],
];
function maxItems(issues: Array<{ keyword: string; pointer: string }>): string[] {
  return issues.filter((i) => i.keyword === 'maxItems').map((i) => i.pointer);
}

describe('SEC-FIX2 N-2: batas yang dideklarasikan diterapkan validator (N lolos, N+1 ditolak maxItems)', () => {
  for (const [name, loc, mk, run] of APPLIED) {
    it(name, () => {
      const n = declared(loc);
      expect(run(mk(n)), `${name} @${n}`).toEqual([]);
      expect(run(mk(n + 1)).length, `${name} @${n + 1}`).toBeGreaterThan(0);
    });
  }
});
