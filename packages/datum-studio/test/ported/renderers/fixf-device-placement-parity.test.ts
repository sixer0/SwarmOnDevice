// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixf-device-placement-parity.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// FIX-F C2 (D-313, kelas F-055): kenop penempatan/aktif perangkat pembungkus berpengaruh di HTML
// persis seperti di DOCX, lewat predikat bersama `engine/front/apparatus.ts`:
//  - `device.spine.enabled` (kenop esensial USER "Tampilkan string punggung") dan `device.spine.placements`
//    (sampul = "margin luar sampul", pembatas bagian = "pembatas");
//  - `device.datumRule.placements` ("sampul", "pembatas", "atas judul bab").
// Uji merender dokumen yang SAMA ke DOCX dan HTML lalu membandingkan jumlah perangkat per format.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { coverApparatusEnabled, datumRulePlaced, spinePlaced } from '@/lib/studio/engine/front/apparatus';
import { withParams } from '../engine-core/fixtures';
import { canonicalTemplate, loadFixtureDoc, makeCtx, partText, snapshotOf, unzip } from './_kit';

interface Counts {
  /** Datum Rule per tempat (HTML: peran; DOCX: hanya total gambar, lihat `drawings`). */
  rule: { cover: number; part: number; chapter: number };
  /** String punggung per tempat. */
  spine: { cover: number; part: number };
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

function sections(html: string, kind: 'cover' | 'part'): string {
  return [...html.matchAll(new RegExp(`<section[^>]*data-wrapper="${kind}"[\\s\\S]*?</section>`, 'g'))].map((m) => m[0]).join('');
}

function htmlCounts(html: string): Counts {
  const cover = sections(html, 'cover');
  const part = sections(html, 'part');
  const rule = /data-role="wrapper\.datumRule"/g;
  const spine = /data-role="cover\.identityString"/g;
  return {
    rule: { cover: count(cover, rule), part: count(part, rule), chapter: count(html, /data-role="chapter\.datumRule"/g) },
    spine: { cover: count(cover, spine), part: count(part, spine) },
  };
}

/** DOCX: string punggung berputar = tabel `tbRl` (P4S-23); Datum Rule = gambar (dibandingkan sebagai selisih). */
function docxCounts(bytes: Uint8Array): { spine: number; drawings: number } {
  const xml = partText(unzip(bytes), 'word/document.xml');
  return { spine: count(xml, /<w:textDirection w:val="tbRl"\/>/g), drawings: count(xml, /<w:drawing>/g) };
}

async function renderBoth(snapshot: NormDocSnapshot, tpl: ResolvedTemplate): Promise<{ html: Counts; docx: { spine: number; drawings: number } }> {
  const html = await assembleHtml(makeCtx(snapshot, tpl).ctx, { preview: false });
  const detail = await assembleDocxDetailed(makeCtx(snapshot, tpl).ctx);
  return { html: htmlCounts(html), docx: docxCounts(detail.bytes) };
}

function terbit(): StudioDocV1 {
  return JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report'))) as StudioDocV1;
}

describe('engine/front/apparatus: predikat penempatan perangkat (satu sumber DOCX + HTML)', () => {
  it('bawaan registri: semua penempatan aktif', () => {
    for (const w of ['sampul', 'pembatas', 'atas judul bab'] as const) expect(datumRulePlaced({}, w)).toBe(true);
    for (const w of ['margin luar sampul', 'pembatas'] as const) expect(spinePlaced({}, w)).toBe(true);
  });

  it('enabled=false mematikan semua penempatan; placements membatasi tempat', () => {
    expect(spinePlaced({ 'device.spine.enabled': false }, 'margin luar sampul')).toBe(false);
    expect(spinePlaced({ 'device.spine.enabled': false }, 'pembatas')).toBe(false);
    expect(spinePlaced({ 'device.spine.placements': ['pembatas'] }, 'margin luar sampul')).toBe(false);
    expect(datumRulePlaced({ 'device.datumRule.placements': ['sampul'] }, 'atas judul bab')).toBe(false);
    expect(datumRulePlaced({ 'device.datumRule.placements': ['sampul'] }, 'sampul')).toBe(true);
    expect(datumRulePlaced({ 'device.datumRule.enabled': false, 'device.datumRule.placements': ['sampul'] }, 'sampul')).toBe(false);
  });

  it('coverApparatusEnabled (sampul explicit) memakai predikat yang sama', () => {
    expect(coverApparatusEnabled({ 'device.spine.enabled': false }, 'spineString')).toBe(false);
    expect(coverApparatusEnabled({ 'device.datumRule.placements': ['pembatas'] }, 'datumRule')).toBe(false);
    expect(coverApparatusEnabled({}, 'datumRule')).toBe(true);
  });
});

describe('FIX-F C2: kenop perangkat berpengaruh di HTML seperti DOCX (render nyata TERBIT v1)', () => {
  let tpl: ResolvedTemplate;
  let base: { html: Counts; docx: { spine: number; drawings: number } };
  /** Pembatas tanpa medan `body` (string punggung DOCX `!part.body`). */
  let parts: number;
  /** Pembatas berbadan bawaan (tanpa body atau body kosong: Datum Rule pembatas). */
  let autoParts: number;
  let heads: number;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
    const snap = snapshotOf(terbit());
    base = await renderBoth(snap, tpl);
    const doc = snap.doc as any;
    parts = (doc.parts ?? []).filter((p: any) => !p.body).length;
    autoParts = (doc.parts ?? []).filter((p: any) => !Array.isArray(p.body) || p.body.length === 0).length;
    heads = (doc.chapters ?? []).length + (doc.appendices ?? []).length;
  }, 120_000);

  it('bawaan: string punggung di sampul dan setiap pembatas bagian, jumlah HTML = DOCX', () => {
    expect(parts).toBeGreaterThan(0);
    expect(base.html.spine).toEqual({ cover: 1, part: parts });
    expect(base.html.spine.cover + base.html.spine.part).toBe(base.docx.spine);
    // Fixture: P1 `body: []` (badan bawaan tanpa string punggung, seperti DOCX), P2 tanpa body.
    expect(autoParts).toBeGreaterThan(parts);
    expect(base.html.rule).toEqual({ cover: 1, part: autoParts, chapter: heads });
  });

  it('kenop USER "Tampilkan string punggung" mati (device.spine.enabled=false): tanpa string punggung di kedua format', async () => {
    const r = await renderBoth(snapshotOf(terbit()), withParams(tpl, { 'device.spine.enabled': false }));
    expect(r.html.spine).toEqual({ cover: 0, part: 0 });
    expect(r.docx.spine).toBe(0);
  }, 120_000);

  it('device.spine.placements=["pembatas"]: sampul tanpa string punggung, pembatas tetap (HTML = DOCX)', async () => {
    const r = await renderBoth(snapshotOf(terbit()), withParams(tpl, { 'device.spine.placements': ['pembatas'] }));
    expect(r.html.spine).toEqual({ cover: 0, part: parts });
    expect(r.docx.spine).toBe(parts);
  }, 120_000);

  it('device.datumRule.placements=["sampul"]: Datum Rule hanya di sampul; selisih gambar DOCX = selisih HTML', async () => {
    const r = await renderBoth(snapshotOf(terbit()), withParams(tpl, { 'device.datumRule.placements': ['sampul'] }));
    expect(r.html.rule).toEqual({ cover: 1, part: 0, chapter: 0 });
    const htmlDrop = base.html.rule.part + base.html.rule.chapter;
    expect(base.docx.drawings - r.docx.drawings).toBe(htmlDrop);
  }, 120_000);

  it('device.datumRule.placements=["atas judul bab","pembatas"]: sampul tanpa Datum Rule (HTML = DOCX)', async () => {
    const r = await renderBoth(snapshotOf(terbit()), withParams(tpl, { 'device.datumRule.placements': ['atas judul bab', 'pembatas'] }));
    expect(r.html.rule).toEqual({ cover: 0, part: autoParts, chapter: heads });
    expect(base.docx.drawings - r.docx.drawings).toBe(1);
  }, 120_000);
});
