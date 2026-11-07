// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/structure/display-field.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// SR-44 / PT-01 / SC-13: setiap medan tampilan terlarang DF-01..DF-69 (register §5.1)
// ditolak skema v2 dengan issue `checkId: "DISPLAY_FIELD"` berpointer TEPAT ke medan itu;
// medan v1 berganti nama VF-01..VF-14 (§5.2) memberi `V1_FIELD` lebih dulu.
// Seam: `validateV2Against` (pemeta tunggal `classifySchemaV2Errors`, D-172) dan
// `STUDIO_ERROR_HTTP` (400 SCHEMA_INVALID). Murni, tanpa DB.
import { describe, expect, it } from '../_vitest';
import { STUDIO_ERROR_HTTP } from '@/lib/studio/contract';
import {
  DISPLAY_FIELDS_BY_LOCATION,
  DISPLAY_FIELDS_GLOBAL,
  V1_FIELD_RENAMES,
} from '@/lib/studio/contract/schema/v2/forbidden';
import { validateV2Against } from '@/lib/studio/services/ingest/validate';
import { BLOCK_AT, getAt, probeDoc, setAt } from './_kit';

const DF_MESSAGE = 'medan tampilan tidak diterima; tampilan diatur templat';

// Lokasi v2 (pointer induk di probeDoc) per asal v1 register §5.1.
const L = {
  root: '',
  meta: '/meta',
  cover: '/sections/cover',
  colophon: '/sections/cover/colophon',
  controlSheet: '/sections/controlSheet',
  signature: '/sections/signature',
  signRole: '/sections/signature/roles/0',
  toc: '/sections/toc',
  contentSlot: '/sections/content',
  outline: '/sections/content/outline/0',
  part: '/sections/content/parts/0',
  chapter: '/sections/content/chapters/1',
  section: '/sections/content/chapters/1/sections/0',
  paragraph: BLOCK_AT(0),
  run: `${BLOCK_AT(0)}/runs/0`,
  rail: `${BLOCK_AT(0)}/rail/0`,
  list: BLOCK_AT(1),
  item: `${BLOCK_AT(1)}/items/0`,
  aside: BLOCK_AT(2),
  mono: BLOCK_AT(3),
  asm: BLOCK_AT(4),
  table: BLOCK_AT(5),
  column: `${BLOCK_AT(5)}/columns/0`,
  row: `${BLOCK_AT(5)}/rows/1`,
  cell: `${BLOCK_AT(5)}/rows/1/cells/0`,
  caption: `${BLOCK_AT(5)}/caption`,
  source: `${BLOCK_AT(5)}/source`,
  derivation: BLOCK_AT(6),
  derivLine: `${BLOCK_AT(6)}/lines/0`,
  chart: BLOCK_AT(7),
  chartData: `${BLOCK_AT(7)}/data`,
  chartPoint: `${BLOCK_AT(7)}/data/points/0`,
  composite: BLOCK_AT(8),
  panel: `${BLOCK_AT(8)}/panels/0`,
  panelData: `${BLOCK_AT(8)}/panels/0/data`,
  diagram: BLOCK_AT(9),
  diagramSpec: `${BLOCK_AT(9)}/spec`,
  diagramNode: `${BLOCK_AT(9)}/spec/nodes/0`,
  image: BLOCK_AT(10),
  symbolSheet: BLOCK_AT(11),
  references: '/sections/references',
  refEntry: '/sections/references/entries/0',
  appendix: '/sections/appendices',
  asset: '/assets/foto-1',
  chartLimit: `${BLOCK_AT(7)}/limit`,
  panelLimit: `${BLOCK_AT(8)}/panels/0/limit`,
} as const;

/** Sisipkan `field` ke objek di `parent`, validasi, kembalikan issue. */
function inject(parent: string, field: string, value: unknown = 1) {
  const doc = probeDoc();
  expect(getAt(doc, parent || '')).toBeTypeOf('object');
  setAt(doc, `${parent}/${field.replace(/~/g, '~0').replace(/\//g, '~1')}`, value);
  return validateV2Against('studio.doc/v2', doc);
}

function expectDisplayField(issues: ReturnType<typeof inject>, pointer: string) {
  const hits = issues.filter((i) => i.checkId === 'DISPLAY_FIELD');
  expect(hits.map((h) => h.pointer)).toEqual([pointer]);
  expect(hits[0].message).toBe(DF_MESSAGE);
  expect(issues.some((i) => i.checkId === 'V1_FIELD')).toBe(false);
}

describe('baseline', () => {
  it('dokumen probe (E1 + semua lokasi DF) lolos skema studio.doc/v2 tanpa isu', () => {
    expect(validateV2Against('studio.doc/v2', probeDoc())).toEqual([]);
  });

  it('SCHEMA_INVALID dipetakan ke HTTP 400 (§2.7)', () => {
    expect(STUDIO_ERROR_HTTP.SCHEMA_INVALID).toBe(400);
  });

  it('register memuat tepat DF-01..DF-52 global dan DF-53..DF-73 per lokasi (IP-63: +DF-70/71; DC-05: +DF-72/73)', () => {
    expect(DISPLAY_FIELDS_GLOBAL).toHaveLength(52);
    expect(Object.keys(DISPLAY_FIELDS_BY_LOCATION)).toEqual(Array.from({ length: 21 }, (_, i) => `DF-${53 + i}`));
  });
});

// ── DF-01..DF-52: setiap nama global di lokasi asal v1 register §5.1 ─────────────
type DfCase = [id: string, field: string, parents: string[]];
const GLOBAL_CASES: DfCase[] = [
  ['DF-01', 'face', [L.run]],
  ['DF-02', 'faceRole', [L.run]],
  ['DF-03', 'szHalfPt', [L.run]],
  ['DF-04', 'color', [L.run]],
  ['DF-05', 'caps', [L.run]],
  ['DF-06', 'smallCaps', [L.run]],
  ['DF-07', 'spacingTw', [L.run]],
  ['DF-08', 'u', [L.run]],
  ['DF-09', 'vertAlign', [L.run]],
  ['DF-10', 'field', [L.run]],
  ['DF-11', 'format', [L.paragraph, L.item, L.cell, L.rail, L.caption, L.source]],
  ['DF-12', 'runDefaults', [L.paragraph]],
  ['DF-13', 'fieldFormats', [L.paragraph, L.chapter, L.toc, L.part]],
  ['DF-14', 'headingFormat', [L.section]],
  ['DF-15', 'signRowFormat', [L.signature]],
  ['DF-16', 'paragraphFormat', [L.chart, L.diagram, L.image, L.symbolSheet]],
  ['DF-17', 'labelProps', [L.caption]],
  ['DF-18', 'setup', [L.cover, L.chapter, L.part, L.toc]],
  ['DF-19', 'layout', [L.table]],
  ['DF-20', 'widthTw', [L.column, L.cell]],
  ['DF-21', 'widthMm', [L.column, L.chart, L.diagram, L.image]],
  ['DF-22', 'heightMm', [L.chart, L.diagram, L.image]],
  ['DF-23', 'width_mm', [L.diagramSpec]],
  ['DF-24', 'colsTw', [L.controlSheet, L.colophon, L.signature, L.toc]],
  ['DF-25', 'cellFormats', [L.colophon, L.signature]],
  ['DF-26', 'firstRowCell', [L.cover]],
  ['DF-27', 'rowCell', [L.cover]],
  ['DF-28', 'borders', [L.cell, L.table]],
  ['DF-29', 'marginsTw', [L.cell]],
  ['DF-30', 'shading', [L.cell]],
  ['DF-31', 'vAlign', [L.cell]],
  ['DF-32', 'cantSplit', [L.row]],
  ['DF-33', 'repeatHeader', [L.row]],
  ['DF-34', 'sourcePlacement', [L.table]],
  ['DF-35', 'rowOrder', [L.signature]],
  ['DF-36', 'numberSeparator', [L.section]],
  ['DF-37', 'apparatus', [L.chart, L.diagramSpec]],
  ['DF-38', 'inDocument', [L.chart]],
  ['DF-39', 'gapMm', [L.composite]],
  ['DF-40', 'params', [L.chart, L.root]],
  ['DF-41', 'overrides', [L.root]],
  ['DF-42', 'kicker', [L.chapter, L.toc]],
  ['DF-43', 'number', [L.section]],
  ['DF-44', 'separator', [L.caption]],
  ['DF-45', 'align', [L.column]],
  ['DF-46', 'marker', [L.item]],
  ['DF-47', 'style', [L.chart]],
  ['DF-48', 'mode', [L.cover, L.toc]],
  ['DF-49', 'sealBand', [L.toc]],
  ['DF-50', 'showChapterList', [L.part]],
  ['DF-51', 'styleId', [L.paragraph, L.root]],
  ['DF-52', 'trailingFormat', [L.paragraph]],
];

describe('DF-01..DF-52 global: kasus negatif di lokasi asal v1', () => {
  it('tabel kasus mencakup setiap nama DISPLAY_FIELDS_GLOBAL tepat sekali', () => {
    expect(GLOBAL_CASES.map((c) => c[1])).toEqual([...DISPLAY_FIELDS_GLOBAL]);
  });
  const rows = GLOBAL_CASES.flatMap(([id, field, parents]) => parents.map((p) => [id, field, p] as const));
  it.each(rows)('%s `%s` di %s -> DISPLAY_FIELD berpointer tepat', (_id, field, parent) => {
    const issues = inject(parent, field);
    expect(issues.length).toBeGreaterThan(0);
    expectDisplayField(issues, `${parent}/${field}`);
  });
});

// ── DF-53..DF-69: per lokasi (setiap medan/nilai) ───────────────────────────────
const LOCATION_PARENT: Record<string, string> = {
  CaptionV2: L.caption,
  ChartV2: L.chart,
  PartV2: L.part,
  SymbolSheetV2: L.symbolSheet,
  TocPayloadV2: L.toc,
  ControlSheetPayloadV2: L.controlSheet,
  RailLineV2: L.rail,
  ChartPanelV2: L.panel,
  ChartDataV2: L.chartData,
  ImageV2: L.image,
  DiagramV2: L.diagram,
  ChartLimit: L.chartLimit,
};

describe('DF-53..DF-69 per lokasi: setiap medan', () => {
  // DC-05: DF-72/DF-73 (payload contractRecord, form chart.custom) tidak punya induk di probe doc ini;
  // diuji di tests/unit/studio/contract/dc05-contract-delta.test.ts.
  const fieldRows = Object.entries(DISPLAY_FIELDS_BY_LOCATION)
    .filter(([id]) => id !== 'DF-72' && id !== 'DF-73')
    .flatMap(([id, r]) => (r.fields ?? []).map((f) => [id, r.location, f] as const));
  it('jumlah kasus medan per lokasi = 33 (DF-53..59, 62..71; DF-60/61 berupa nilai)', () => {
    expect(fieldRows).toHaveLength(33);
  });
  it.each(fieldRows)('%s %s.%s -> DISPLAY_FIELD berpointer tepat', (_id, location, field) => {
    const parent = LOCATION_PARENT[location];
    expect(parent, `lokasi ${location} punya induk di probe`).toBeDefined();
    const issues = inject(parent, field, field === 'body' || field === 'chapterKeys' ? ['x'] : 1);
    expectDisplayField(issues, `${parent}/${field}`);
  });

  it('DF-65 berlaku di SETIAP varian ChartDataV2 (11 shape) dan data panel', () => {
    const variants: Record<string, unknown> = {
      categorical: { shape: 'categorical', points: [{ label: 'A', value: 1 }] },
      series: { shape: 'series', categories: ['a'], series: [{ name: 's', values: [1] }] },
      xy: { shape: 'xy', points: [{ x: 1, y: 2 }] },
      matrix: { shape: 'matrix', rows: ['r'], cols: ['c'], values: [[1]] },
      intervals: { shape: 'intervals', items: [{ label: 'a', start: 1, end: 2 }] },
      graph: { shape: 'graph', nodes: [{ id: 'a', label: 'A' }], links: [] },
      distribution: { shape: 'distribution', groups: [{ name: 'g', values: [1] }] },
      tiles: { shape: 'tiles', tiles: [{ code: 'A', row: 0, col: 0 }] },
      ohlc: { shape: 'ohlc', points: [{ t: 't', o: 1, h: 2, l: 0, c: 1 }] },
      sets: { shape: 'sets', sets: [{ name: 'a', size: 1 }], overlaps: [] },
      steps: { shape: 'steps', spec: { family: 'flow', nodes: [{ id: 'n', label: 'N', class: {} }] } },
    };
    const hints = DISPLAY_FIELDS_BY_LOCATION['DF-65'].fields ?? [];
    expect(hints).toEqual(['axis', 'max', 'belowTargetColour', 'compassLabels', 'medianLabel']);
    for (const [shape, data] of Object.entries(variants)) {
      const base = probeDoc();
      setAt(base, `${L.chart}/data`, structuredClone(data));
      expect(validateV2Against('studio.doc/v2', base), `varian ${shape} sah`).toEqual([]);
      for (const h of hints) {
        const doc = probeDoc();
        setAt(doc, `${L.chart}/data`, { ...(structuredClone(data) as object), [h]: 1 });
        expectDisplayField(validateV2Against('studio.doc/v2', doc), `${L.chartData}/${h}`);
        const doc2 = probeDoc();
        setAt(doc2, `${L.panel}/data`, { ...(structuredClone(data) as object), [h]: 1 });
        expectDisplayField(validateV2Against('studio.doc/v2', doc2), `${L.panelData}/${h}`);
      }
    }
  });
  it('DF-70 ChartPanelV2.widthClass dan DF-71 ChartLimit.max juga di garis ambang panel', () => {
    expectDisplayField(inject(L.panel, 'widthClass', 'full'), `${L.panel}/widthClass`);
    expectDisplayField(inject(L.panelLimit, 'max', 100), `${L.panelLimit}/max`);
    expectDisplayField(inject(L.chartLimit, 'max', 100), `${L.chartLimit}/max`);
  });
  it('positif: ChartLimit hanya {value, label} (data, D-223) diterima', () => {
    expect(validateV2Against('studio.doc/v2', probeDoc())).toEqual([]);
  });
});

describe('DF-60/DF-61: nilai terlarang', () => {
  it.each(['spacer', 'device'])('DF-60 blok bertipe %s -> DISPLAY_FIELD di /type', (type) => {
    const doc = probeDoc();
    setAt(doc, L.paragraph, { type });
    const issues = validateV2Against('studio.doc/v2', doc);
    expectDisplayField(issues, `${L.paragraph}/type`);
  });

  it('DF-60 juga di intro bab', () => {
    const doc = probeDoc();
    doc.sections.content.chapters[0].intro = [{ type: 'device' }];
    expectDisplayField(validateV2Against('studio.doc/v2', doc), '/sections/content/chapters/0/intro/0/type');
  });

  const roles = DISPLAY_FIELDS_BY_LOCATION['DF-61'].values ?? [];
  it('DF-61 memuat 8 peran halaman depan (KD-16)', () => {
    expect(roles).toEqual(['kicker', 'pageTitle', 'blockHeading', 'addressLine', 'title', 'standfirst', 'scopeLine', 'methodStatement']);
  });
  it.each(roles)('DF-61 paragraph.role = %s -> DISPLAY_FIELD di /role', (role) => {
    const issues = inject(L.paragraph, 'role', role);
    expectDisplayField(issues, `${L.paragraph}/role`);
  });
  it.each(['body', 'lede', 'note', 'subheading', 'identity', 'anchor', 'pivot', 'closingAction'])(
    'positif: peran makna %s diterima (KD-16)',
    (role) => {
      expect(inject(L.paragraph, 'role', role)).toEqual([]);
    },
  );
  it('peran tak dikenal (bukan DF-61) ditolak TANPA checkId DISPLAY_FIELD', () => {
    const issues = inject(L.paragraph, 'role', 'bogus');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.checkId === 'DISPLAY_FIELD')).toBe(false);
  });
});

// ── Matriks: "nama tidak sah di mana pun" (PT-01, PT-02) ─────────────────────────
describe('matriks global: setiap DF-01..DF-52 di setiap lokasi objek v2', () => {
  const parents = Object.values(L).filter((p) => p !== L.diagramNode);
  // Pengecualian register: VF lebih dulu (§5.2 prioritas), D-172 `u` simpul diagram = data.
  const v1First: Record<string, string> = { [`${L.list}|style`]: 'ordered', [`${L.cover}|kicker`]: 'tagline' };
  const rows = DISPLAY_FIELDS_GLOBAL.flatMap((f) => parents.map((p) => [f, p] as const));
  it(`jumlah kombinasi = ${DISPLAY_FIELDS_GLOBAL.length} x ${parents.length}`, () => {
    expect(rows.length).toBe(52 * parents.length);
  });
  it('setiap kombinasi ditolak berpointer tepat (DISPLAY_FIELD, atau V1_FIELD untuk VF-11/VF-13)', () => {
    const failures: string[] = [];
    for (const [field, parent] of rows) {
      const issues = inject(parent, field);
      const pointer = `${parent}/${field}`;
      const vf = v1First[`${parent}|${field}`];
      const want = vf ? 'V1_FIELD' : 'DISPLAY_FIELD';
      const hits = issues.filter((i) => i.checkId === want && i.pointer === pointer);
      if (hits.length !== 1) failures.push(`${field}@${parent || '/'} -> ${JSON.stringify(issues.slice(0, 2))}`);
      if (vf && !hits[0]?.message.includes(vf)) failures.push(`${field}@${parent}: pesan V1 tanpa "${vf}"`);
    }
    expect(failures).toEqual([]);
  });
  it('D-172: `u` pada simpul diagram adalah data (bukan DF-08) dan diterima', () => {
    expect(inject(L.diagramNode, 'u', 2)).toEqual([]);
  });
  it('simpul diagram tetap menolak DF lain (mis. color) dengan DISPLAY_FIELD', () => {
    expectDisplayField(inject(L.diagramNode, 'color', 'red'), `${L.diagramNode}/color`);
  });
});

// ── VF-01..VF-14: V1_FIELD lebih dulu dari DISPLAY_FIELD ─────────────────────────
describe('VF-01..VF-14: medan v1 berganti nama -> V1_FIELD berpointer + pengganti', () => {
  const cases: Array<[string, string, string, unknown]> = [
    ['VF-01', L.paragraph, 'blockId', 'b1'],
    ['VF-01', L.chapter, 'blockId', 'c1'],
    ['VF-01', L.section, 'blockId', 's1'],
    ['VF-02', L.run, 'b', true],
    ['VF-03', L.run, 'i', true],
    ['VF-04', L.chapter, 'runningHeadTitle', 'x'],
    ['VF-05', L.root, 'front', {}],
    ['VF-06', L.root, 'parts', []],
    ['VF-07', L.root, 'chapters', []],
    ['VF-08', L.root, 'appendices', []],
    ['VF-09', L.root, 'outputs', ['docx']],
    ['VF-10', L.caption, 'inline', { text: 'x' }],
    ['VF-10', L.source, 'inline', { text: 'x' }],
    ['VF-11', L.list, 'style', 'number'],
    ['VF-12', L.chartPoint, 'accent', true],
    ['VF-12', L.chartData, 'accent', true],
    ['VF-13', L.cover, 'kicker', { text: 'x' }],
    ['VF-14', L.chart, 'spec', {}],
    ['VF-14', L.paragraph, 'x', {}],
  ];
  it.each(cases)('%s %s/%s', (id, parent, field, value) => {
    const issues = inject(parent, field, value);
    const hit = issues.filter((i) => i.checkId === 'V1_FIELD');
    // VF-12 pada titik data: lokasi ChartDataV2 diwariskan ke turunan (`*: @same`).
    expect(hit.map((h) => h.pointer)).toEqual([`${parent}/${field}`]);
    expect(hit[0].message).toBe(`medan v1 tidak diterima di v2; pakai ${V1_FIELD_RENAMES[id].replacement}`);
    expect(issues.some((i) => i.checkId === 'DISPLAY_FIELD')).toBe(false);
  });
});
