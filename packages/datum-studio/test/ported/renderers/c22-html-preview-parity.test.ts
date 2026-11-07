// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c22-html-preview-parity.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// C22 (cetak biru identification/03 baris C22): paritas pratinjau HTML untuk opt-in pembungkus ronde cakupan
// DATUM Rev A yang sisi DOCX-nya sudah ada (engine A/B/C/D, register research/38; D-638, D-639). Setiap opt-in:
// HTML render ID/EN dengan nilai opt-in memuat unsur yang sama dengan DOCX; absen = bawaan eksplisit = HTML
// sekarang, byte-identik. Seam: `assembleHtml` (dokumen HTML keluaran). Ekspektasi = literal register / tabel
// teks manual (bukan dihitung ulang dari kode produksi).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormBlock, NormDocSnapshot, ParamMap, RenderContext, RenderScope, ResolvedTemplate, StudioDocV1, TemplateSlotDef } from '@/lib/studio/contract';
import { spineTextOf } from '@/lib/studio/engine/front/texts';
import { htmlBlocks } from '@/lib/studio/engine/html/blocks';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, loadFixtureDoc, makeCtx, sha256, snapshotOf, type FixtureName } from './_kit';

type Lang = 'ID' | 'EN';

let base: ResolvedTemplate;

beforeAll(async () => {
  base = await canonicalTemplate();
});

/** Peta param templat: `set` ditimpa, `drop` dihapus (kasus "absen"). */
function tplWith(set: Record<string, unknown> = {}, drop: string[] = []): ResolvedTemplate {
  const params: Record<string, ParamMap[string]> = { ...base.params, ...(set as ParamMap) };
  for (const k of drop) delete params[k];
  return { ...base, params };
}

function docOf(fixture: FixtureName, lang: Lang, mutate?: (d: any) => void): StudioDocV1 {
  const doc = JSON.parse(JSON.stringify(loadFixtureDoc(fixture))) as any;
  doc.meta.language = lang;
  mutate?.(doc);
  return doc as StudioDocV1;
}

interface HtmlOut {
  html: string;
  logs: { level: string; code?: string; message: string }[];
}

async function html(fixture: FixtureName, lang: Lang, tpl: ResolvedTemplate, mutate?: (d: any) => void): Promise<HtmlOut> {
  const { ctx, logs } = makeCtx(snapshotOf(docOf(fixture, lang, mutate)), tpl);
  return { html: await assembleHtml(ctx, { preview: false }), logs: logs as HtmlOut['logs'] };
}

/** Bagian `<section ... data-wrapper="<kind>">` pertama (unit pembungkus HTML). */
function wrapperSection(h: string, kind: string): string {
  const at = h.indexOf(`data-wrapper="${kind}"`);
  if (at < 0) throw new Error(`pembungkus ${kind} tidak ditemukan`);
  const start = h.lastIndexOf('<', at);
  const end = h.indexOf('</section>', at);
  return h.slice(start, end);
}

const textOf = (h: string): string => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// ── C08 / CS-12 (R-67): subjudul lembar kendali ─────────────────────────────

describe('C22 CS-12: subjudul lembar kendali di HTML (controlSheet.subtitle.enabled)', () => {
  const SUB = { ID: 'Kendali dokumen, riwayat revisi, dan pernyataan verifikasi', EN: 'Document control, revision history and verification statement' } as const;

  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: opt-in mencetak subjudul tepat sesudah judul lembar kendali, peran cover.standfirst`, async () => {
      const { html: h } = await html('doc_terbit_report', lang, tplWith({ 'controlSheet.subtitle.enabled': true }));
      const cs = wrapperSection(h, 'controlSheet');
      const ps = [...cs.matchAll(/<(p|h2|h3)\b[^>]*>[\s\S]*?<\/\1>/g)].map((m) => ({ tag: m[0], text: textOf(m[0]) }));
      const hits = ps.filter((p) => p.text === SUB[lang]);
      expect(hits).toHaveLength(1);
      const i = ps.findIndex((p) => p.text === SUB[lang]);
      expect(ps[i - 1].tag).toMatch(/data-role="front\.pageTitle"/);
      expect(ps[i].tag).toMatch(/data-role="cover\.standfirst"/);
    });

    it(`${lang}: absen dan false byte-identik, tanpa subjudul`, async () => {
      const absent = await html('doc_terbit_report', lang, tplWith({}, ['controlSheet.subtitle.enabled']));
      const off = await html('doc_terbit_report', lang, tplWith({ 'controlSheet.subtitle.enabled': false }));
      expect(sha256(off.html)).toBe(sha256(absent.html));
      expect(absent.html).not.toContain(SUB[lang]);
    });
  }
});

// ── C09 / CS-06 (R-68): selalu tiga kolom tanda tangan ─────────────────────

/** Tabel tanda tangan HTML: teks sel per baris (thead + tbody) dan jumlah `<col>`. */
function signatureTable(h: string): { rows: string[][]; cols: number } {
  const t = /<table class="st-signature"[\s\S]*?<\/table>/.exec(h)?.[0];
  if (!t) throw new Error('tabel tanda tangan HTML tidak ditemukan');
  const rows = [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => textOf(c[1])));
  return { rows, cols: (t.match(/<col\b/g) ?? []).length };
}

const role = (r: string, holder: string, date?: string) => ({ role: { text: r }, holder: { text: holder }, ...(date ? { date: { text: date } } : {}) });

describe('C22 CS-06: tiga kolom tanda tangan di HTML (controlSheet.signatures.fillRoles)', () => {
  const FILL = { 'controlSheet.signatures.fillRoles': true };

  it('ID, 1 peran: tiga kolom; peran yang tidak dikirim berlabel bawaan, pemegang kosong', async () => {
    const one = (d: any) => (d.front.signature.roles = [role('Disusun', 'Penyusun laporan', '2026-10-20')]);
    const t = signatureTable((await html('doc_terbit_report', 'ID', tplWith(FILL), one)).html);
    expect(t.rows[0]).toEqual(['Disusun', 'Diperiksa', 'Disetujui']);
    expect(t.rows[1]).toEqual(['', '', '']);
    expect(t.rows[2]).toEqual(['Penyusun laporan', '', '']);
    expect(t.rows[3]).toEqual(['2026-10-20', '', '']);
  });

  it('ID, 2 peran [Disusun, Disetujui]: penyetuju di kolom 3, bukan 2; colsTw kiriman dibuang', async () => {
    const two = (d: any) => {
      d.front.signature.roles = [role('Disusun', 'A'), role('Disetujui', 'C')];
      d.front.signature.colsTw = [4000, 4000];
    };
    const t = signatureTable((await html('doc_terbit_report', 'ID', tplWith(FILL), two)).html);
    expect(t.rows[0]).toEqual(['Disusun', 'Diperiksa', 'Disetujui']);
    expect(t.rows[2]).toEqual(['A', '', 'C']);
    // Wave 165 row 165A (C188 F113-4, consequence edit): the sent colsTw is still dropped, but the block now carries
    // the DOCX signature grid as shares of the 166 mm span (3 cols); was 0 cols (auto widths, squeezed in 48 mm).
    expect(t.cols).toBe(3);
    expect(/<table class="st-signature"[\s\S]*?<\/colgroup>/.exec((await html('doc_terbit_report', 'ID', tplWith(FILL), two)).html)?.[0]).not.toMatch(/width:[0-9.]+mm/);
  });

  it('EN, 1 peran: label EN Prepared by / Reviewed by / Approved by', async () => {
    const one = (d: any) => (d.front.signature.roles = [role('Prepared by', 'Report author')]);
    const t = signatureTable((await html('doc_terbit_report', 'EN', tplWith(FILL), one)).html);
    expect(t.rows[0]).toEqual(['Prepared by', 'Reviewed by', 'Approved by']);
    expect(t.rows[2]).toEqual(['Report author', '', '']);
  });

  it('absen dan false byte-identik (1 peran tetap 1 kolom); 3 peran + opt-in = tanpa opt-in', async () => {
    const one = (d: any) => (d.front.signature.roles = [role('Disusun', 'Penyusun laporan')]);
    const absent = await html('doc_terbit_report', 'ID', tplWith({}, ['controlSheet.signatures.fillRoles']), one);
    const off = await html('doc_terbit_report', 'ID', tplWith({ 'controlSheet.signatures.fillRoles': false }), one);
    expect(sha256(off.html)).toBe(sha256(absent.html));
    expect(signatureTable(absent.html).rows[0]).toEqual(['Disusun']);
    const three = await html('doc_terbit_report', 'ID', tplWith(FILL));
    const threeAbsent = await html('doc_terbit_report', 'ID', tplWith({}, ['controlSheet.signatures.fillRoles']));
    expect(sha256(three.html)).toBe(sha256(threeAbsent.html));
  });
});

// ── C11 / CV-20 (R-70): lebar maksimum judul sampul ────────────────────────

/** `<h1>` judul sampul HTML: gaya h1 dan gaya tiap baris judul (span). */
function coverTitle(h: string): { h1Style: string | undefined; lineStyles: string[] } {
  const m = /<h1 class="st-h st-cover-title"([^>]*)>([\s\S]*?)<\/h1>/.exec(h);
  if (!m) throw new Error('judul sampul HTML tidak ditemukan');
  return {
    h1Style: /style="([^"]*)"/.exec(m[1])?.[1],
    lineStyles: [...m[2].matchAll(/<span class="st-cover-title-line[^"]*" style="([^"]*)"/g)].map((x) => x[1]),
  };
}

describe('C22 CV-20: lebar maksimum judul sampul di HTML (cover.title.maxWidthMm)', () => {
  // Indentasi kanan = bentang penuh 166 - nilai (register R-70): 150 -> 16 mm = 907 tw = 45.35 pt; 120 -> 46 mm = 2608 tw = 130.4 pt.
  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: 150 mm = margin kanan 45.35pt pada blok judul (h1), bukan pada span baris (inline tidak membatasi lebar)`, async () => {
      const t = coverTitle((await html('doc_terbit_report', lang, tplWith({ 'cover.title.maxWidthMm': 150 }))).html);
      expect(t.h1Style).toBe('margin-right:45.35pt');
      expect(t.lineStyles.length).toBeGreaterThan(0);
      for (const st of t.lineStyles) expect(st).not.toMatch(/margin-right/);
    });
  }

  it('120 mm = 130.4pt (turunan grid.fullSpanMm)', async () => {
    const t = coverTitle((await html('doc_terbit_report', 'ID', tplWith({ 'cover.title.maxWidthMm': 120 }))).html);
    expect(t.h1Style).toBe('margin-right:130.4pt');
  });

  it('absen dan null byte-identik; h1 tanpa gaya', async () => {
    const absent = await html('doc_terbit_report', 'ID', tplWith({}, ['cover.title.maxWidthMm']));
    const nul = await html('doc_terbit_report', 'ID', tplWith({ 'cover.title.maxWidthMm': null }));
    expect(sha256(nul.html)).toBe(sha256(absent.html));
    expect(coverTitle(absent.html).h1Style).toBeUndefined();
  });
});

// ── C12 / CV-19: sampul belakang (device.spine.placements berisi "sampul belakang") ─────────

const PLACED = { 'device.spine.placements': ['margin luar sampul', 'pembatas', 'sampul belakang'] };
const DEFAULT_LIST = { 'device.spine.placements': ['margin luar sampul', 'pembatas'] };
const noCover = () => datumSlots().filter((s) => s.sectionType !== 'cover');

/** Snapshot v2 (compose nyata, kerangka DATUM); tanpa slot sampul = bentuk NOTA (kiriman juga tanpa sampul). */
function composeSnap(slots: TemplateSlotDef[], lang: Lang): NormDocSnapshot {
  const d = e1();
  d.meta.language = lang;
  if (!slots.some((s) => s.sectionType === 'cover')) delete d.sections.cover;
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: defaultParams() }).snapshot as unknown as NormDocSnapshot;
}

async function htmlV2(slots: TemplateSlotDef[], lang: Lang, tpl: ResolvedTemplate, extra: Partial<RenderContext> = {}): Promise<HtmlOut & { snap: NormDocSnapshot }> {
  const snap = composeSnap(slots, lang);
  const { ctx, logs } = makeCtx(snap, tpl, extra);
  return { html: await assembleHtml(ctx, { preview: false }), logs: logs as HtmlOut['logs'], snap };
}

/** Unit alir HTML (`<section class="st-unit ...">`) berurutan: tag pembuka + isi sampai unit berikut. */
function units(h: string): Array<{ open: string; body: string }> {
  const opens = [...h.matchAll(/<section class="st-unit\b[^>]*>/g)];
  return opens.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < opens.length ? (opens[i + 1].index ?? h.length) : h.indexOf('</body>');
    return { open: m[0], body: h.slice(start, end) };
  });
}

describe('C22 CV-19: sampul belakang di HTML', () => {
  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: opt-in + unit sampul + DOCUMENT = unit terakhir F:backCover berisi tepat satu string punggung, tanpa register/kepala halaman`, async () => {
      const on = await htmlV2(datumSlots(), lang, tplWith(PLACED));
      const off = await htmlV2(datumSlots(), lang, tplWith({}));
      const u = units(on.html);
      expect(u.length).toBe(units(off.html).length + 1);
      const last = u[u.length - 1];
      expect(last.open).toMatch(/data-unit="cover"/);
      expect(last.open).toMatch(/data-unit-key="F:backCover"/);
      const spines = [...last.body.matchAll(/<div class="[^"]*\bst-spine\b[^"]*"[^>]*data-role="cover\.identityString"[^>]*>([\s\S]*?)<\/div>/g)];
      expect(spines).toHaveLength(1);
      expect(textOf(spines[0][1])).toBe(spineTextOf(on.snap.doc.meta, tplWith(PLACED).params));
      expect(last.body).not.toMatch(/class="(?:reg|runhead)\b/);
      // Kotak margin @page unit terakhir tanpa nomor lembar (RB-07/RB-08/SB-01: halaman pembungkus).
      const rule = new RegExp(`@page st-u-${u.length - 1}\{[^\n]*`).exec(on.html)?.[0] ?? '';
      expect(rule).not.toBe('');
      expect(rule).not.toMatch(/counter\(page/);
    });
  }

  it('NOTA (tanpa slot sampul) dengan opt-in: tanpa sampul belakang, byte-identik dengan tanpa opt-in', async () => {
    const on = await htmlV2(noCover(), 'ID', tplWith(PLACED));
    const off = await htmlV2(noCover(), 'ID', tplWith({}));
    expect(sha256(on.html)).toBe(sha256(off.html));
  });

  it('lingkup SLOT / CHAPTER dengan opt-in: tanpa F:backCover', async () => {
    for (const scope of [{ kind: 'SLOT', key: 'cover' }, { kind: 'CHAPTER', key: '1' }] as RenderScope[]) {
      const r = await htmlV2(datumSlots(), 'ID', tplWith(PLACED), { scope, draft: true });
      expect(r.html, scope.kind).not.toContain('data-unit-key="F:backCover"');
    }
  });

  it('absen = daftar bawaan eksplisit: HTML byte-identik', async () => {
    const absent = await htmlV2(datumSlots(), 'ID', tplWith({}, ['device.spine.placements']));
    const dflt = await htmlV2(datumSlots(), 'ID', tplWith(DEFAULT_LIST));
    expect(sha256(dflt.html)).toBe(sha256(absent.html));
    expect(absent.html).not.toContain('F:backCover');
  });

  it('renderer backCover tanpa penempatan: tanpa string punggung, log warn BY_CONSTRUCTION_FAILED', () => {
    const render = (htmlBlocks as Record<string, ((b: NormBlock, c: RenderContext) => string) | undefined>).backCover;
    expect(typeof render).toBe('function');
    const { ctx, logs } = makeCtx(composeSnap(datumSlots(), 'ID'), tplWith({}));
    const block = { blockId: 'backCover:backCover:auto:0', address: 'F:backCover', ordinal: -1, unitKey: 'F:backCover', type: 'backCover', content: { mode: 'auto' }, textPlain: '', contentSha256: '' } as NormBlock;
    const out = render?.(block, ctx) ?? '';
    expect(out).not.toMatch(/st-spine/);
    expect((logs as HtmlOut['logs']).some((l) => l.level === 'warn' && l.code === 'BY_CONSTRUCTION_FAILED')).toBe(true);
  });
});

// ── C14 / GF-22 (R-72, R-73): warna garis kepala halaman dan garis atas blok register ─────────

/** Isi `<style data-studio="pages">` (CSS perabot halaman dinamis). */
const pagesCss = (h: string): string => /<style data-studio="pages">([\s\S]*?)<\/style>/.exec(h)?.[1] ?? '';

describe('C22 GF-22: warna garis kepala halaman (.runhead) dan garis atas register (.reg) di HTML', () => {
  const SEAL = { 'runningHead.ruleColour': '6E1420', 'device.registerBlock.topRuleColour': '6E1420' };

  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: kedua param 6E1420 = garis bawah kepala halaman dan garis atas register berwarna segel`, async () => {
      const css = pagesCss((await html('doc_terbit_report', lang, tplWith(SEAL))).html);
      expect(css).toContain('.runhead{border-bottom-color:#6E1420}');
      expect(css).toContain('.reg{border-top-color:#6E1420}');
    });
  }

  it('param bekerja sendiri-sendiri; hex huruf kecil berawalan # dinormalkan', async () => {
    const head = pagesCss((await html('doc_terbit_report', 'ID', tplWith({ 'runningHead.ruleColour': '#6e1420' }))).html);
    expect(head).toContain('.runhead{border-bottom-color:#6E1420}');
    expect(head).not.toContain('.reg{border-top-color');
    const reg = pagesCss((await html('doc_terbit_report', 'ID', tplWith({ 'device.registerBlock.topRuleColour': '6E1420' }))).html);
    expect(reg).toContain('.reg{border-top-color:#6E1420}');
    expect(reg).not.toContain('.runhead{border-bottom-color');
  });

  it('absen = bawaan registri eksplisit (C3CBD1 / 101418) = nilai tidak sah: HTML byte-identik', async () => {
    const keys = ['runningHead.ruleColour', 'device.registerBlock.topRuleColour'];
    const absent = await html('doc_terbit_report', 'ID', tplWith({}, keys));
    const dflt = await html('doc_terbit_report', 'ID', tplWith({ 'runningHead.ruleColour': 'C3CBD1', 'device.registerBlock.topRuleColour': '101418' }));
    const bad = await html('doc_terbit_report', 'ID', tplWith({ 'runningHead.ruleColour': 'merah', 'device.registerBlock.topRuleColour': 12 }));
    expect(sha256(dflt.html)).toBe(sha256(absent.html));
    expect(sha256(bad.html)).toBe(sha256(absent.html));
  });
});

// ── C16 / CL-02 NOTA (R-76): baris klasifikasi di bawah nomor dokumen ─────────

describe('C22 CL-02 NOTA: baris klasifikasi di bawah sel nomor register HTML (render.nota.classificationLine)', () => {
  const LINE = { 'render.nota.classificationLine': true };
  const terbatas = (d: any) => (d.meta.classification = 'terbatas');
  const EXPECT = { ID: 'Klasifikasi : TERBATAS', EN: 'Classification: TERBATAS' } as const;

  // Wave 165 row 165A for row 165D (C188 F113-12, consequence edit): the R-76 foot line is retired in HTML too (screen
  // `.reg-cls` and the print margin box second line); was: "Klasifikasi : TERBATAS" after every register.
  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: R-76 true = keluaran tanpa baris "${EXPECT[lang]}" (layar dan cetak), sama dengan opt-in mati`, async () => {
      const on = (await html('doc_nota_memo', lang, tplWith(LINE), terbatas)).html;
      const off = (await html('doc_nota_memo', lang, tplWith({}), terbatas)).html;
      expect(on).not.toContain('reg-cls');
      expect(pagesCss(on)).not.toContain(`"\\A" "${EXPECT[lang]}"`);
      expect(sha256(on)).toBe(sha256(off));
    });
  }

  it('pola register tanpa {nomor}: tanpa baris (tidak ada nomor untuk diikuti)', async () => {
    const cells = { 'device.registerBlock.cells': ['REV · {tanggal}', 'LEMBAR {n} DARI {N}', '{kelas}'] };
    const on = (await html('doc_nota_memo', 'ID', tplWith({ ...LINE, ...cells }), terbatas)).html;
    const off = (await html('doc_nota_memo', 'ID', tplWith(cells), terbatas)).html;
    expect(sha256(on)).toBe(sha256(off));
  });

  it('absen dan false byte-identik', async () => {
    const absent = await html('doc_nota_memo', 'ID', tplWith({}, ['render.nota.classificationLine']), terbatas);
    const off = await html('doc_nota_memo', 'ID', tplWith({ 'render.nota.classificationLine': false }), terbatas);
    expect(sha256(off.html)).toBe(sha256(absent.html));
    expect(absent.html).not.toContain('reg-cls');
  });
});

// ── C10 / CS-11 dan C15 + C27 / CL-02 T/S + CV-15 (engine B): lewat compose + teks bersama ─────────
// Konfirmasi: HTML tidak punya kode sendiri untuk ini; nilainya datang dari compose (tabel lembar kendali) dan
// `controlBlockRowsText` (blok kendali sampul auto), jadi HTML = DOCX tanpa perubahan mesin HTML.

/** Snapshot v2 dengan param yang juga diberikan ke compose (C10/C27 dibaca compose, R-69/R-79 kunci compose). */
async function htmlComposed(params: Record<string, unknown>, lang: Lang): Promise<string> {
  const d = e1();
  d.meta.classification = 'Terbatas';
  d.meta.language = lang;
  const r = composeV2({ source: merge(d).doc, skeleton: skeletonInput(), params: { ...defaultParams(), ...params } as ParamMap });
  const { ctx } = makeCtx(r.snapshot as unknown as NormDocSnapshot, tplWith(params));
  return assembleHtml(ctx, { preview: false });
}

/** Kepala kolom tiap tabel di unit lembar kendali HTML. */
function controlSheetHeads(h: string): string[][] {
  const cs = wrapperSection(h, 'controlSheet');
  return [...cs.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((t) => [...(/<tr\b[^>]*>([\s\S]*?)<\/tr>/.exec(t[0])?.[1] ?? '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((c) => textOf(c[1])));
}

/** Baris blok kendali sampul HTML (`table.st-control`): teks sel per baris. */
function coverControlRows(h: string): string[][] {
  const t = /<table class="st-control"[\s\S]*?<\/table>/.exec(wrapperSection(h, 'cover'))?.[0];
  if (!t) throw new Error('blok kendali sampul HTML tidak ditemukan');
  return [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => textOf(c[1])));
}

describe('C22 konfirmasi CS-11: kolom manual lembar kendali di HTML (controlSheet.columns.form)', () => {
  const MANUAL = { 'controlSheet.columns.form': 'manual' };
  const HEADS = {
    ID: [['Rev', 'Tanggal', 'Penyusun', 'Perubahan', 'Status'], ['Lapis', 'Metode', 'Objek', 'Hasil'], ['Salinan', 'Pemegang', 'Media', 'Kembali']],
    EN: [['Rev', 'Date', 'Prepared by', 'Change', 'Status'], ['Layer', 'Method', 'Object', 'Result'], ['Copy', 'Holder', 'Medium', 'Return']],
  } as const;
  const IN_FORCE = { ID: 'Berlaku', EN: 'In force' } as const;

  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: manual = kepala kolom manual tiga tabel; baris revisi terakhir STATUS ${IN_FORCE[lang]}`, async () => {
      const h = await htmlComposed(MANUAL, lang);
      const heads = controlSheetHeads(h);
      for (const want of HEADS[lang]) expect(heads).toContainEqual([...want]);
      const cs = wrapperSection(h, 'controlSheet');
      const rev = [...cs.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((t) => t[0]).find((t) => textOf(t).includes(HEADS[lang][0][3]));
      const rows = [...(rev ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => textOf(c[1])));
      expect(rows[rows.length - 1][4]).toBe(IN_FORCE[lang]);
    });
  }

  it('absen = "mesin" = null: HTML byte-identik', async () => {
    const absent = await htmlComposed({}, 'ID');
    expect(sha256(await htmlComposed({ 'controlSheet.columns.form': 'mesin' }, 'ID'))).toBe(sha256(absent));
    expect(sha256(await htmlComposed({ 'controlSheet.columns.form': null }, 'ID'))).toBe(sha256(absent));
  });
});

describe('C22 konfirmasi CL-02 T/S + CV-15: blok kendali sampul auto di HTML', () => {
  const FIELDS = { 'cover.controlBlock.fields': ['NOMOR DOKUMEN', 'REVISI', 'KLASIFIKASI', 'PENYUSUN', 'KUSTODIAN', 'DITUJUKAN KEPADA', 'TIER', 'BAHASA'] };
  const UNIT = { ID: 'Divisi Engineering PT GSP', EN: 'Engineering Division, PT GSP' } as const;
  const LABELS = { ID: { k: 'Klasifikasi', p: 'Penyusun' }, EN: { k: 'Classification', p: 'Prepared by' } } as const;

  for (const lang of ['ID', 'EN'] as const) {
    it(`${lang}: baris ${LABELS[lang].k} TERBATAS di bawah nomor (baris 2); ${LABELS[lang].p} = unit penyusun`, async () => {
      const h = await htmlComposed({ ...FIELDS, 'cover.controlBlock.preparerUnit': UNIT[lang] }, lang);
      const rows = coverControlRows(h);
      expect(rows[1].slice(0, 2)).toEqual([LABELS[lang].k, 'TERBATAS']);
      const flat = rows.flatMap((r) => [[r[0], r[1]], [r[2], r[3]]]);
      expect(flat).toContainEqual([LABELS[lang].p, UNIT[lang]]);
    });
  }

  // Wave 165 row 165A (C189 F56-1, consequence edit): without a KLASIFIKASI field in the list the engine adds its own
  // Klasifikasi field under the number (was: a second line inside the number cell, so no 'Klasifikasi' cell).
  it('bawaan (daftar medan registri, tanpa unit): medan Klasifikasi di bawah nomor, penyusun = meta.author; absen = kosong byte-identik', async () => {
    const absent = await htmlComposed({}, 'ID');
    const rows = coverControlRows(absent);
    expect(rows[1].slice(0, 2)).toEqual(['Klasifikasi', 'TERBATAS']);
    expect(rows.flat().filter((c) => c === 'Klasifikasi')).toHaveLength(1);
    expect(rows.flat()).not.toContain(UNIT.ID);
    expect(sha256(await htmlComposed({ 'cover.controlBlock.preparerUnit': '' }, 'ID'))).toBe(sha256(absent));
  });
});
