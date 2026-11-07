// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/docx-sections.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// S72: struktur XML DOCX per jenis section (registri 29 section DOCUMENT) dan
// kerapian paket OPC. Sampel = 4 fixture paritas S63 (NOTA memo, NOTA tabel,
// SERAH, TERBIT) yang bersama-sama memuat seluruh 29 jenis section DOCUMENT.
// Figur chart/diagram/lembar simbol memakai FigureStore stub (PNG 300 dpi
// sintetis); jalur rasterisasi nyata diuji di browser-chromium.test.ts.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormBlock, NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { DOCX_RENDERERS, dispatchCoverage } from '@/lib/studio/contract/dispatch';
import { assembleDocxDetailed, type AssembleDocxDetail } from '@/lib/studio/engine/docx/assemble';
import { SECTION_REGISTRY } from '@/lib/studio/registry/sections';
import {
  FIGURE_TYPES,
  FIXTURES,
  STUB_FIG,
  TABLE_FAMILY,
  canonicalTemplate,
  findAll,
  loadFixtureDoc,
  makeCtx,
  normWs,
  parseFragment,
  parseXml,
  partText,
  snapshotOf,
  unzip,
  wText,
  type FixtureName,
  type XNode,
} from './_kit';
import { contractReportSnapshot } from './dc12-contract-fixture';

const EMU_PER_MM = 36000;
const TW_PER_MM = 1440 / 25.4;
/** A4 dalam twip (210 x 297 mm), nilai literal ECMA-376/Word. */
const A4_TW = { w: 11906, h: 16838 };

interface Rendered {
  snap: NormDocSnapshot;
  detail: AssembleDocxDetail;
  parts: Record<string, Uint8Array>;
  errors: string[];
}

let tpl: ResolvedTemplate;
const rendered = new Map<FixtureName, Rendered>();
/** DC-13: fixture laporan kerja agen register 05 §5.8 (snapshot norm/v2) = satu-satunya pemuat `contractRecord` (S30). */
const CONTRACT_FIXTURE = 'contract_report_5_8';
let contract: Rendered;

beforeAll(async () => {
  tpl = await canonicalTemplate();
  for (const f of FIXTURES) {
    const snap = snapshotOf(loadFixtureDoc(f));
    const { ctx, logs } = makeCtx(snap, tpl);
    const detail = await assembleDocxDetailed(ctx);
    rendered.set(f, { snap, detail, parts: unzip(detail.bytes), errors: logs.filter((l) => l.level === 'error').map((l) => l.message) });
  }
  {
    const snap = contractReportSnapshot();
    const { ctx, logs } = makeCtx(snap, tpl);
    const detail = await assembleDocxDetailed(ctx);
    contract = { snap, detail, parts: unzip(detail.bytes), errors: logs.filter((l) => l.level === 'error').map((l) => l.message) };
  }
}, 120_000);

const DOC_SECTION_KEYS = SECTION_REGISTRY.filter((s) => s.group === 'DOCUMENT').map((s) => s.key);

describe('cakupan registri dan dispatcher', () => {
  it('registri memuat 29 section DOCUMENT dan dispatcher tidak punya renderer kosong', () => {
    expect(DOC_SECTION_KEYS).toHaveLength(30);
    expect(dispatchCoverage()).toEqual({ docx: [], html: [], charts: [] });
    for (const k of DOC_SECTION_KEYS) expect(typeof DOCX_RENDERERS[k], k).toBe('function');
  });

  it('4 fixture + fixture kontrak §5.8 bersama-sama memuat ke-30 jenis section DOCUMENT', () => {
    const seen = new Set<string>();
    for (const r of [...rendered.values(), contract]) for (const b of r.snap.blocks) seen.add(b.type);
    expect(DOC_SECTION_KEYS.filter((k) => !seen.has(k))).toEqual([]);
  });

  it('fixture kontrak §5.8 dirakit tanpa log error dan setiap bagian XML well-formed', () => {
    expect(contract.errors).toEqual([]);
    const xmlParts = Object.keys(contract.parts).filter((p) => p.endsWith('.xml') || p.endsWith('.rels'));
    expect(xmlParts).toContain('word/document.xml');
    for (const p of xmlParts) expect(parseXml(partText(contract.parts, p)).errors, p).toEqual([]);
  });
});

describe.each(FIXTURES)('paket DOCX %s', (f) => {
  it('dirakit tanpa log error dan setiap bagian XML well-formed', () => {
    const r = rendered.get(f)!;
    expect(r.errors).toEqual([]);
    const xmlParts = Object.keys(r.parts).filter((p) => p.endsWith('.xml') || p.endsWith('.rels'));
    expect(xmlParts).toContain('word/document.xml');
    for (const p of xmlParts) expect(parseXml(partText(r.parts, p)).errors, p).toEqual([]);
  });

  it('setiap bagian punya tipe isi dan setiap relasi internal menunjuk bagian yang ada (OPC)', () => {
    const r = rendered.get(f)!;
    const ct = parseXml(partText(r.parts, '[Content_Types].xml')).root!;
    const defaults = new Set(findAll(ct, 'Default').map((d) => d.attrs.Extension.toLowerCase()));
    const overrides = new Set(findAll(ct, 'Override').map((o) => o.attrs.PartName));
    for (const p of Object.keys(r.parts)) {
      if (p === '[Content_Types].xml') continue;
      const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
      expect(overrides.has(`/${p}`) || defaults.has(ext), `tipe isi untuk ${p}`).toBe(true);
    }
    for (const relPath of Object.keys(r.parts).filter((p) => p.endsWith('.rels'))) {
      const dir = relPath.replace(/_rels\/[^/]*\.rels$/, '');
      for (const rel of findAll(parseXml(partText(r.parts, relPath)).root, 'Relationship')) {
        if (rel.attrs.TargetMode === 'External') continue;
        const target = new URL(rel.attrs.Target, `http://x/${dir}`).pathname.slice(1);
        expect(r.parts[target], `${relPath} ${rel.attrs.Id} -> ${target}`).toBeDefined();
      }
    }
  });

  it('satu sectPr A4 per unit; header/footer setiap seksi ada di paket', () => {
    const r = rendered.get(f)!;
    const doc = parseXml(r.detail.documentXml).root!;
    const sects = findAll(doc, 'w:sectPr');
    expect(sects).toHaveLength(r.snap.units.length);
    expect(r.detail.sectionCount).toBe(r.snap.units.length);
    const rels = Object.fromEntries(findAll(parseXml(partText(r.parts, 'word/_rels/document.xml.rels')).root, 'Relationship').map((x) => [x.attrs.Id, x.attrs.Target]));
    for (const s of sects) {
      const pg = findAll(s, 'w:pgSz')[0];
      expect([Number(pg.attrs['w:w']), Number(pg.attrs['w:h'])]).toEqual([A4_TW.w, A4_TW.h]);
      for (const ref of [...findAll(s, 'w:headerReference'), ...findAll(s, 'w:footerReference')]) {
        const target = rels[ref.attrs['r:id']];
        expect(target, ref.attrs['r:id']).toBeDefined();
        expect(r.parts[`word/${target}`], target).toBeDefined();
      }
    }
  });

  it('wp:docPr id unik dan berurutan 1..n; setiap r:embed menunjuk media yang ada', () => {
    const r = rendered.get(f)!;
    const doc = parseXml(r.detail.documentXml).root!;
    const ids = findAll(doc, 'wp:docPr').map((d) => Number(d.attrs.id));
    expect(ids).toEqual(ids.map((_, i) => i + 1));
    expect(ids.length).toBe(r.detail.drawingCount);
    const rels = Object.fromEntries(findAll(parseXml(partText(r.parts, 'word/_rels/document.xml.rels')).root, 'Relationship').map((x) => [x.attrs.Id, x.attrs.Target]));
    for (const blip of findAll(doc, 'a:blip')) {
      const target = rels[blip.attrs['r:embed']];
      expect(target, blip.attrs['r:embed']).toBeDefined();
      expect(r.parts[`word/${target}`]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

// ── Struktur per jenis section (fragmen renderer per blok) ───────────────
interface Sample {
  fixture: FixtureName | typeof CONTRACT_FIXTURE;
  block: NormBlock;
  frag: XNode;
  errors: string[];
}

function samplesByType(): Map<string, Sample[]> {
  const out = new Map<string, Sample[]>();
  const all: Array<[FixtureName | typeof CONTRACT_FIXTURE, Rendered]> = [...rendered, [CONTRACT_FIXTURE, contract]];
  for (const [fixture, r] of all) {
    const { ctx } = makeCtx(r.snap, tpl, { snapshot: { ...r.snap, numbering: r.detail.numbering } });
    for (const block of r.snap.blocks) {
      const render = DOCX_RENDERERS[block.type];
      if (!render) continue;
      const label = r.detail.numbering[block.blockId];
      const input = label && label !== block.artifactLabel ? { ...block, artifactLabel: label } : block;
      const xml = render(input, ctx).xml;
      const { root, errors } = parseFragment(xml);
      const list = out.get(block.type) ?? [];
      list.push({ fixture, block, frag: root!, errors });
      out.set(block.type, list);
    }
  }
  // SR-42 (D-138): fixture konten-saja (SR-41) tidak lagi memuat blok `device`
  // (sampul/pita/garis disusun dari templat). Renderer v1 `device` tetap ada di
  // DOCX_RENDERERS, jadi diuji dengan satu blok sintetis per jenis tanpa aset.
  if (!out.has('device')) {
    const [fixture, r] = [...rendered][0];
    const { ctx } = makeCtx(r.snap, tpl, { snapshot: { ...r.snap, numbering: r.detail.numbering } });
    const list: Sample[] = [];
    const devices = [
      { device: 'hairline' },
      { device: 'spineString', text: { text: 'GSP 000' } },
      { device: 'issueStamp', text: { text: '23-X-2026' } },
    ];
    devices.forEach((content, i) => {
      const block: NormBlock = {
        blockId: `sr42-device-${i}`,
        address: null,
        ordinal: 0,
        unitKey: 'sr42',
        type: 'device',
        content: { type: 'device', ...content },
        textPlain: '',
        contentSha256: '',
      };
      const { root, errors } = parseFragment(DOCX_RENDERERS.device!(block, ctx).xml);
      list.push({ fixture, block, frag: root!, errors });
    });
    out.set('device', list);
  }
  return out;
}

let samples: Map<string, Sample[]>;
beforeAll(() => {
  samples = samplesByType();
}, 60_000);

function has(n: XNode, name: string): boolean {
  return findAll(n, name).length > 0;
}

/** Penanda struktural wajib per jenis section (dari ECMA-376 + §5.2 registri). */
const REQUIRED: Record<string, string[]> = {
  paragraph: ['w:p', 'w:r', 'w:t'],
  section: ['w:p', 'w:outlineLvl', 'w:keepNext', 'w:t'],
  chapter: ['w:p', 'w:keepNext', 'w:t', 'w:drawing'],
  appendix: ['w:p', 'w:keepNext', 'w:t'],
  list: ['w:p', 'w:ind', 'w:t'],
  aside: ['w:tbl', 'w:tc', 'w:t'],
  monoBlock: ['w:tbl', 'w:tc', 'w:t'],
  assumptionInline: ['w:p', 'w:t'],
  derivation: ['w:p', 'w:pBdr', 'w:t'],
  device: ['w:p'],
  cover: ['w:p'],
  controlSheet: ['w:tbl', 'w:t'],
  toc: ['w:tbl', 'w:t'],
  partDivider: ['w:tbl', 'w:t'],
  signatureBlock: ['w:tbl', 'w:t'],
  chart: ['w:drawing', 'wp:inline', 'a:blip', 'w:t'],
  diagram: ['w:drawing', 'wp:inline', 'a:blip', 'w:t'],
  symbolSheet: ['w:drawing', 'wp:inline', 'a:blip', 'w:t'],
  image: ['w:drawing', 'wp:inline', 'a:blip', 'w:t'],
  // DC-13: tabel fakta/butir/bukti/rujukan lewat keluarga tabel DATUM.
  contractRecord: ['w:tbl', 'w:tblGrid', 'w:tr', 'w:tc', 'w:t'],
};
for (const t of TABLE_FAMILY) REQUIRED[t] = ['w:tbl', 'w:tblGrid', 'w:tr', 'w:tc', 'w:t'];

describe('fragmen DOCX per jenis section', () => {
  it('setiap jenis yang disampel punya daftar penanda wajib', () => {
    expect([...samples.keys()].filter((t) => !REQUIRED[t]).sort()).toEqual([]);
  });

  it.each(Object.keys(REQUIRED).sort())('%s: fragmen well-formed, tanpa w:sectPr/w:body, penanda wajib ada', (type) => {
    const list = samples.get(type) ?? [];
    expect(list.length, `sampel ${type}`).toBeGreaterThan(0);
    for (const s of list) {
      const at = `${s.fixture} ${s.block.address ?? s.block.blockId}`;
      expect(s.errors, at).toEqual([]);
      expect(has(s.frag, 'w:sectPr') || has(s.frag, 'w:body'), at).toBe(false);
      for (const tag of REQUIRED[type]) expect(has(s.frag, tag), `${at} <${tag}>`).toBe(true);
    }
  });

  it('tabel keluarga: tiap baris mengisi tepat kolom tblGrid (gridSpan dihitung) dan lebar grid <= bentang penuh', () => {
    const fullSpanMm = Number(tpl.params['grid.fullSpanMm'] ?? 166);
    for (const type of [...TABLE_FAMILY, 'contractRecord']) {
      for (const s of samples.get(type) ?? []) {
        const at = `${s.fixture} ${type} ${s.block.address}`;
        for (const tbl of findAll(s.frag, 'w:tbl')) {
          const grid = tbl.children.find((c) => c.name === 'w:tblGrid');
          expect(grid, at).toBeDefined();
          const cols = grid!.children.filter((c) => c.name === 'w:gridCol');
          const sum = cols.reduce((a, c) => a + Number(c.attrs['w:w']), 0);
          expect(sum, `${at} lebar grid ${sum} tw`).toBeLessThanOrEqual(Math.ceil(fullSpanMm * TW_PER_MM) + 2);
          for (const tr of tbl.children.filter((c) => c.name === 'w:tr')) {
            const span = tr.children
              .filter((c) => c.name === 'w:tc')
              .reduce((a, tc) => a + Number(findAll(tc, 'w:gridSpan')[0]?.attrs['w:val'] ?? 1), 0);
            expect(span, `${at} baris`).toBe(cols.length);
          }
        }
      }
    }
  });

  it('figur: wp:extent cx = lebar blok x 36000 EMU/mm; cy mengikuti rasio FigureStore', () => {
    for (const type of FIGURE_TYPES) {
      for (const s of samples.get(type) ?? []) {
        const w = (s.block.content as { widthMm: number }).widthMm;
        const ext = findAll(s.frag, 'wp:extent')[0];
        const at = `${s.fixture} ${type} ${s.block.address}`;
        expect(Number(ext.attrs.cx), at).toBe(Math.round(w * EMU_PER_MM));
        const hMm = (s.block.content as { heightMm?: number }).heightMm ?? (STUB_FIG.heightMm * w) / STUB_FIG.widthMm;
        expect(Math.abs(Number(ext.attrs.cy) - hMm * EMU_PER_MM), at).toBeLessThanOrEqual(1);
      }
    }
  });

  it('teks paragraf dan judul seksi dipertahankan (textPlain muncul di w:t)', () => {
    for (const type of ['paragraph', 'section']) {
      for (const s of samples.get(type) ?? []) {
        // textPlain = teks cari (S48) yang masih memuat penanda md-lite `**`/`*`; renderer membuangnya.
        // Tiap baris textPlain (teks utama, isi rel bukti, dst.) harus muncul utuh.
        const got = normWs(wText(s.frag));
        for (const line of s.block.textPlain.split(/\r?\n/)) {
          const want = normWs(line.replace(/\*+/g, ''));
          if (want) expect(got, `${s.fixture} ${s.block.address}`).toContain(want);
        }
      }
    }
  });
});
