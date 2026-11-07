// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c34-classification-line-no-number.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// C34 tindak lanjut #4 (D-650): jalur peringatan C16 `CLASSIFICATION_LINE_NO_NUMBER` (R-76 opt-in, pola
// sel register tanpa `{nomor}` = tidak ada nomor dokumen untuk diikuti). DOCX: baris tidak dicetak, kaki
// byte-identik dengan opt-in mati, peringatan dicatat SEKALI per dokumen (bukan per unit interior).
// HTML: lewati diam-diam (kerangka HTML tidak punya kanal log), tanpa `.reg-cls`.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ParamMap, ResolvedTemplate, StudioDocV1 } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { canonicalTemplate, loadFixtureDoc, makeCtx, partText, snapshotOf, unzip } from './_kit';

const LINE = 'render.nota.classificationLine';
const CELLS = 'device.registerBlock.cells';
/** Pola register tanpa `{nomor}` (sel lain sama dengan bawaan Tabel 4.6). */
const NO_NUMBER_CELLS = ['GSP', 'REV · {tanggal}', 'LEMBAR {n} DARI {N}', '{kelas}'];

let base: ResolvedTemplate;
beforeAll(async () => {
  base = await canonicalTemplate();
});

const tplWith = (set: ParamMap): ResolvedTemplate => ({ ...base, params: { ...base.params, ...set } });

function notaDoc(): StudioDocV1 {
  const doc = JSON.parse(JSON.stringify(loadFixtureDoc('doc_nota_memo'))) as StudioDocV1;
  doc.meta.language = 'ID';
  doc.meta.classification = 'terbatas';
  return doc;
}

async function docx(tpl: ResolvedTemplate) {
  const { ctx, logs } = makeCtx(snapshotOf(notaDoc()), tpl);
  const parts = unzip((await assembleDocxDetailed(ctx)).bytes);
  const footers = Object.keys(parts)
    .filter((p) => /^word\/footer\d+\.xml$/.test(p))
    .sort()
    .map((p) => partText(parts, p));
  return { logs, footers, registerFooters: footers.filter((x) => x.includes('<w:tbl>')) };
}

async function html(tpl: ResolvedTemplate): Promise<string> {
  const { ctx } = makeCtx(snapshotOf(notaDoc()), tpl);
  return assembleHtml(ctx, { preview: false });
}

// Wave 165 row 165A for row 165D (C188 F113-12, consequence edit): the R-76 foot line is retired in DOCX and HTML (the
// classification belongs under the number in the cover control block, F56-1). R-76 true now prints what R-76 false
// prints, and no CLASSIFICATION_LINE_NO_NUMBER warning is logged (was: line in the foot, one warning without {nomor}).
describe('C34 #4 DOCX: R-76 foot line retired (F113-12)', () => {
  it('pola tanpa {nomor} + R-76 true: tanpa peringatan, tanpa baris, kaki = opt-in mati', async () => {
    const on = await docx(tplWith({ [LINE]: true, [CELLS]: NO_NUMBER_CELLS }));
    const off = await docx(tplWith({ [LINE]: false, [CELLS]: NO_NUMBER_CELLS }));
    expect(on.registerFooters.length).toBeGreaterThan(1);
    expect(on.logs.some((l) => l.code === 'CLASSIFICATION_LINE_NO_NUMBER')).toBe(false);
    for (const f of on.registerFooters) expect(f).not.toContain('Klasifikasi : ');
    expect(on.footers).toEqual(off.footers);
  }, 60_000);

  it('pola bawaan (ada {nomor}) + R-76 true: tanpa baris di kaki, tanpa peringatan, kaki = opt-in mati', async () => {
    const on = await docx(tplWith({ [LINE]: true }));
    const off = await docx(tplWith({ [LINE]: false }));
    expect(on.logs.some((l) => l.code === 'CLASSIFICATION_LINE_NO_NUMBER')).toBe(false);
    for (const f of on.registerFooters) expect(f).not.toContain('Klasifikasi : ');
    expect(on.footers).toEqual(off.footers);
  }, 60_000);
});

describe('C34 #4 HTML: R-76 foot line retired (F113-12)', () => {
  it('pola tanpa {nomor} + R-76 true: tanpa .reg-cls, keluaran = opt-in mati', async () => {
    const on = await html(tplWith({ [LINE]: true, [CELLS]: NO_NUMBER_CELLS }));
    const off = await html(tplWith({ [LINE]: false, [CELLS]: NO_NUMBER_CELLS }));
    expect(on).not.toContain('reg-cls');
    expect(on).toBe(off);
  }, 60_000);

  it('pola bawaan + R-76 true: tanpa .reg-cls, keluaran = opt-in mati', async () => {
    const on = await html(tplWith({ [LINE]: true }));
    expect(on).not.toContain('reg-cls');
    expect(on).toBe(await html(tplWith({ [LINE]: false })));
  }, 60_000);
});
