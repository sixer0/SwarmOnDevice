// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/gf08-gf21-rev-a-render.test.ts (see test/ported/README.md).
import { seedModule, useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// GF-08 + GF-21 follow-up (verification/22 revision 3 §9; C33 re-measure).
//
// GF-08 seam: the derived-preset plan (`derivedPresetRoleFormats`, the seed's own code path) applied to the measured
// Manual 000 role formats the 10 templates inherit, then a pure DOCX render (`assembleDocxDetailed`). Expected run
// sizes are Table 8.2 (`ID:2633-2635`) at the nearest half-point: caption 7.6 pt -> w:sz 15, header 6.8 pt -> 14,
// numerals 7.8 pt -> 16. Control = the same render without the overrides (inherited 14 / 13 / 15 / 14).
//
// GF-21 seam: the same render with R-74 `render.rhythm.snapToBaseline`. Captions, KEY and SOURCE keep their own
// leading (Table 8.2 caption "7,6 / 11 pt" = line 220 exact); only before/after are moved so the one-line block ends
// on the 13.5 pt (270 tw) grid. Table rows get a `w:trHeight atLeast` that covers the estimated wrapped lines.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ParamMap, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { benchmarkTemplate, loadFixtureDoc, makeCtx, partText, sha256, snapshotOf, unzip } from './_kit';
const { derivedPresetRoleFormats } = (await import(seedModule('seed-studio-templates'))) as any; // row42 W14
const { DERIVED_PRESET_SPECS } = (await import(seedModule('seed-derived-presets'))) as any; // row42 W14
import { withParams } from '../engine-core/fixtures';

const SNAP = 'render.rhythm.snapToBaseline';
const BASE = 270;
let GSP: ResolvedTemplate;
let REV_A: ResolvedTemplate;

beforeAll(async () => {
  const bench = await benchmarkTemplate();
  // datum-gsp family = measured Manual 000 profile + framePr rail (pattern of engine E / C22b tests).
  GSP = withParams(bench, { 'render.rail.renderer': 'framePr' });
  const spec = DERIVED_PRESET_SPECS.find((s) => s.slug === 'datum-gsp-rev-a-preset')!;
  const own = derivedPresetRoleFormats(spec, GSP.roleFormats, GSP.params as Record<string, never>)!;
  REV_A = { ...GSP, params: { ...GSP.params, ...(spec.pins as ParamMap) }, roleFormats: { ...GSP.roleFormats, ...(own as ResolvedTemplate['roleFormats']) } };
});

function tplWith(base: ResolvedTemplate, set: Record<string, unknown> = {}): ResolvedTemplate {
  return { ...base, params: { ...base.params, ...(set as ParamMap) } };
}

function fixture(mutate?: (d: any) => void): StudioDocV1 {
  const d = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report'))) as any;
  mutate?.(d);
  return d as StudioDocV1;
}

async function docx(tpl: ResolvedTemplate, mutate?: (d: any) => void): Promise<{ xml: string; bytes: Uint8Array }> {
  const snap: NormDocSnapshot = snapshotOf(fixture(mutate));
  const { ctx } = makeCtx(snap, tpl);
  const d = await assembleDocxDetailed(ctx);
  return { xml: partText(unzip(d.bytes), 'word/document.xml'), bytes: d.bytes };
}

const paragraphs = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
const textOf = (p: string) => (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
interface Run { text: string; sz?: number; font?: string; caps: boolean; spacing?: number }
const runsOf = (x: string): Run[] =>
  (x.match(/<w:r>[\s\S]*?<\/w:r>/g) ?? [])
    .map((r) => ({
      text: textOf(r),
      sz: Number(/<w:sz w:val="(\d+)"/.exec(r)?.[1] ?? NaN) || undefined,
      font: /<w:rFonts w:ascii="([^"]+)"/.exec(r)?.[1],
      caps: /<w:caps\/>/.test(r),
      spacing: Number(/<w:spacing w:val="(-?\d+)"/.exec(r)?.[1] ?? NaN) || undefined,
    }))
    .filter((r) => r.text.trim() !== '');
const spacingOf = (p: string) => {
  const m = /<w:spacing ([^>]*)\/>/.exec(p.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, ''))?.[1] ?? '';
  const a = (k: string) => {
    const hit = new RegExp('w:' + k + '="([0-9]+)"').exec(m);
    return hit ? Number(hit[1]) : undefined;
  };
  return { before: a('before'), after: a('after'), line: a('line'), rule: /w:lineRule="(\w+)"/.exec(m)?.[1] };
};
/** Top-level tables that directly follow a "Tabel n"/"Table n" caption paragraph. */
function captionedTables(xml: string): Array<{ caption: string; tbl: string }> {
  const out: Array<{ caption: string; tbl: string }> = [];
  let depth = 0;
  let start = -1;
  let caption = '';
  for (const m of xml.matchAll(/<w:tbl>|<\/w:tbl>/g)) {
    if (m[0] === '<w:tbl>') {
      if (depth === 0) {
        start = m.index!;
        const before = xml.slice(0, start);
        caption = before.slice(before.lastIndexOf('<w:p>'));
      }
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0 && /^(Tabel|Table) [0-9A-Z]/.test(textOf(caption))) out.push({ caption, tbl: xml.slice(start, m.index! + 8) });
    }
  }
  return out;
}
/** Top-level rows of a table (nested tables skipped). */
function topRows(tbl: string): string[] {
  const rows: string[] = [];
  let depth = 0;
  let start = -1;
  for (const m of tbl.matchAll(/<w:tbl>|<\/w:tbl>|<w:tr>|<\/w:tr>/g)) {
    if (m[0] === '<w:tbl>') depth += 1;
    else if (m[0] === '</w:tbl>') depth -= 1;
    else if (depth === 1 && m[0] === '<w:tr>') start = m.index!;
    else if (depth === 1 && m[0] === '</w:tr>') rows.push(tbl.slice(start, m.index! + 7));
  }
  return rows;
}
const isHeaderRow = (r: string) => r.includes('<w:tblHeader/>');

// ── GF-08: Table 8.2 run sizes in the DOCX ───────────────────────────────

describe('GF-08: the Rev A preset role formats put the Table 8.2 run sizes into the DOCX', () => {
  it('control: the inherited measured role formats print caption label 14, header 13, numerals 15 (the C32 finding)', async () => {
    const { xml } = await docx(GSP);
    const [t] = captionedTables(xml);
    expect(t).toBeDefined();
    expect(runsOf(t.caption)[0].sz).toBe(14);
    expect(new Set(runsOf(topRows(t.tbl).find(isHeaderRow)!).map((r) => r.sz))).toEqual(new Set([13]));
  }, 60_000);

  it('caption: identifier and text runs at w:sz 15 (7.6 pt -> 7.5 pt); leading stays 11 pt (line 220 exact)', async () => {
    const { xml } = await docx(REV_A);
    const tables = captionedTables(xml);
    expect(tables.length).toBeGreaterThan(0);
    for (const { caption } of tables) {
      const runs = runsOf(caption);
      expect(runs.length, textOf(caption)).toBeGreaterThan(0);
      for (const r of runs) expect(r.sz, `${textOf(caption)} / ${r.text}`).toBe(15);
      expect(spacingOf(caption)).toMatchObject({ line: 220, rule: 'exact' });
    }
  }, 60_000);

  it('table header: w:sz 14 (6.8 pt -> 7.0 pt), caps, tracking 12 tw (0.09 em); numerals Mono w:sz 16 (7.8 pt -> 8.0 pt)', async () => {
    const { xml } = await docx(REV_A);
    let headers = 0;
    let numerals = 0;
    for (const { tbl } of captionedTables(xml)) {
      for (const row of topRows(tbl)) {
        for (const r of runsOf(row)) {
          if (isHeaderRow(row)) {
            headers += 1;
            expect(r.sz, r.text).toBe(14);
            expect(r.caps, r.text).toBe(true);
            expect(r.spacing, r.text).toBe(12);
          } else if (r.font === 'IBM Plex Mono') {
            numerals += 1;
            expect(r.sz, r.text).toBe(16);
          }
        }
      }
    }
    expect(headers).toBeGreaterThan(3);
    expect(numerals).toBeGreaterThan(3);
  }, 60_000);
});

// ── GF-21 (a): captions, KEY and SOURCE keep their leading under R-74 ─────

describe('GF-21 (a): R-74 keeps the caption / KEY / SOURCE leading and snaps only the spacing', () => {
  // Review C34 #5 (D-650): before 120 -> 270 (a non-zero spacing never rounds to 0; was 0); after 48 padded -> 50.
  it('table caption: 120/48/220 -> 270/50/220 (line kept, block = 270 + 220 + 50 = 540 tw on the grid)', async () => {
    const { xml } = await docx(tplWith(REV_A, { [SNAP]: true }));
    const tables = captionedTables(xml);
    expect(tables.length).toBeGreaterThan(0);
    for (const { caption } of tables) expect(spacingOf(caption), textOf(caption)).toEqual({ before: 270, after: 50, line: 220, rule: 'exact' });
  }, 60_000);

  it('figure caption, KEY and SOURCE: line height unchanged from R-74 off; before on the grid; one-line block ends on the grid', async () => {
    const off = paragraphs((await docx(REV_A)).xml);
    const on = paragraphs((await docx(tplWith(REV_A, { [SNAP]: true }))).xml);
    // Figure apparatus = the caption just before a picture paragraph and the KEY/SOURCE lines just after it.
    const apparatus: string[] = [];
    on.forEach((p, i) => {
      if (!p.includes('<wp:extent') || !/^(Gambar|Figure) \d/.test(textOf(on[i - 1] ?? ''))) return;
      apparatus.push(on[i - 1]);
      for (let j = i + 1; j < on.length && /^(KUNCI|KEY|SUMBER|SOURCE)/.test(textOf(on[j])); j++) apparatus.push(on[j]);
    });
    let checked = 0;
    for (const p of apparatus) {
      const t = textOf(p);
      const o = off.find((x) => textOf(x) === t);
      if (!o) continue;
      const s = spacingOf(p);
      const so = spacingOf(o);
      if (so.rule !== 'exact' || so.line === undefined) continue;
      checked += 1;
      expect(s.line, t).toBe(so.line);
      expect(s.rule, t).toBe('exact');
      expect((s.before ?? 0) % BASE, t).toBe(0);
      expect(((s.before ?? 0) + s.line! + (s.after ?? 0)) % BASE, t).toBe(0);
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('R-74 off = byte-identical to the render without the param (old templates unchanged)', async () => {
    const absent = await docx(REV_A);
    const off = await docx(tplWith(REV_A, { [SNAP]: false }));
    expect(sha256(off.bytes)).toBe(sha256(absent.bytes));
  }, 60_000);
});

// ── GF-21 (a) HTML parity ────────────────────────────────────────────────

const styleOf = (h: string, cls: string): string => new RegExp(`<[a-z0-9]+ class="[^"]*\\b${cls}\\b[^"]*"[^>]*style="([^"]*)"`).exec(h)?.[1] ?? '';
const paraPart = (style: string): string => style.split(';').filter((d) => /^(margin-top|margin-bottom|line-height):/.test(d)).join(';');

describe('GF-21 (a) HTML: the preview keeps the caption leading like the DOCX', () => {
  // Review C34 #5: margin-top 0 -> 13.5 pt (before 120 -> 270 tw, one baseline).
  it('caption 120/48/220 tw -> margin 13.5 / 2.5 pt, line-height 11 pt', async () => {
    const h = await assembleHtml(makeCtx(snapshotOf(fixture()), tplWith(REV_A, { [SNAP]: true })).ctx, { preview: false });
    expect(paraPart(styleOf(h, 'st-caption'))).toBe('margin-top:13.5pt;margin-bottom:2.5pt;line-height:11pt');
  });
});

// ── GF-21 (b): table rows cover the estimated wrapped lines ──────────────

/**
 * Rule table "Tabel 2.1" with fixed column widths 1641 + 5616 tw (= 128 mm, G2) so the expectations are hand-computed
 * from the font files (PyMuPDF on render-env/semibold-bundle/fonts/same, 8 pt):
 * - id cell (IBM Plex Mono 8 pt = Rev A numerals, 0.6 em = 96 tw per glyph), text width 1641 - 141 = 1500 tw:
 *   "SU-01 SU-02 SU-03 SU-04" -> "SU-01 SU-02" (1056 tw) + "SU-03 SU-04" = 2 lines; cell 85 + 85 + 2 x 210 = 590 -> 810.
 * - text cell (IBM Plex Serif 8 pt), text width 5616 - 141 = 5475 tw = 96.6 mm: the 113-character sentence below is
 *   152.3 mm in Serif and 129.9 mm in Plex Sans Cond = 2 lines either way; cell 85 + 85 + 2 x 220 = 610 -> 810
 *   (the 610 tw case of verification/22 GF-21).
 */
const LONG = 'Kelembapan relatif dijaga 40 sampai 60 persen pada seluruh lorong dingin dan diperiksa setiap pergantian giliran.';
function wrappedRuleTable(d: any): void {
  const t = d.chapters[1].sections[0].blocks[1];
  t.columns = [{ role: 'id', widthTw: 1641 }, { role: 'text', widthTw: 5616 }];
  t.rows[1].cells[0].text = 'SU-01 SU-02 SU-03 SU-04';
  t.rows[2].cells[1].text = LONG;
}
const trHeight = (row: string) => Number(/<w:trHeight w:val="(\d+)" w:hRule="atLeast"\/>/.exec(row)?.[1] ?? NaN);

describe('GF-21 (b): R-74 row minimum height covers the estimated wrapped lines', () => {
  it('wrapped Mono and Serif rows get 810 (3 x 270); single-line rows and the header keep 540', async () => {
    const { xml } = await docx(tplWith(REV_A, { [SNAP]: true }), wrappedRuleTable);
    const t = captionedTables(xml).find((x) => textOf(x.caption).includes('Aturan batas suhu'))!;
    const rows = topRows(t.tbl);
    expect(rows[1]).toContain('SU-01 SU-02 SU-03 SU-04');
    expect(rows.map(trHeight).slice(0, 3)).toEqual([540, 810, 810]);
  }, 60_000);

  it('every top-level row height stays a multiple of 270 and the cell XML is unchanged (only trPr differs)', async () => {
    const off = await docx(REV_A, wrappedRuleTable);
    const on = await docx(tplWith(REV_A, { [SNAP]: true }), wrappedRuleTable);
    for (const { tbl } of captionedTables(on.xml)) for (const r of topRows(tbl)) expect(trHeight(r) % BASE, r.slice(0, 80)).toBe(0);
    const strip = (x: string) => x.replace(/<w:trHeight w:val="[0-9]+" w:hRule="atLeast"\/>/g, '').replace(/<w:trPr><\/w:trPr>/g, '');
    const tbls = (x: string) => x.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];
    expect(tbls(strip(on.xml))).toEqual(tbls(off.xml));
  }, 60_000);
});
