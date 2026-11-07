// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/c10-c15-c27-render.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// C10 / C15 / C27 pada render nyata (DOCX dan HTML, templat kanonik): kolom manual lembar kendali, baris KLASIFIKASI
// dan unit penyusun di blok kendali sampul auto tercetak di kedua format, dan nama penyusun tetap di tanda tangan.
// Nilai harapan = literal register research/38 §3.2, §3.3, §3.5. Seam: `composeV2` -> `assembleDocxDetailed` /
// `assembleHtml` (teks dokumen keluaran).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ParamMap, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { withParams } from '../engine-core/fixtures';
import { defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { canonicalTemplate, makeCtx, partText, unzip } from './_kit';

const OPT_IN = {
  'controlSheet.columns.form': 'manual',
  'cover.controlBlock.fields': ['NOMOR DOKUMEN', 'REVISI', 'KLASIFIKASI', 'PENYUSUN', 'KUSTODIAN', 'DITUJUKAN KEPADA', 'TIER', 'BAHASA'],
};

async function render(tpl: ResolvedTemplate, params: Record<string, unknown>, language?: 'EN') {
  const d = e1();
  d.meta.classification = 'Terbatas';
  if (language) d.meta.language = language;
  const r = composeV2({ source: merge(d).doc, skeleton: skeletonInput(), params: { ...defaultParams(), ...params } as ParamMap });
  const t = withParams(tpl, params);
  const snap = r.snapshot as unknown as NormDocSnapshot;
  const html = (await assembleHtml(makeCtx(snap, t).ctx, { preview: false })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const docx = partText(unzip((await assembleDocxDetailed(makeCtx(snap, t).ctx)).bytes), 'word/document.xml')
    .replace(/<w:tab\/>/g, ' ')
    .replace(/<\/w:p>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ');
  return { html, docx };
}

describe('C10 / C15 / C27 render DOCX dan HTML', () => {
  let tpl: ResolvedTemplate;
  beforeAll(async () => {
    tpl = await canonicalTemplate();
  });

  it('ID: kolom manual, STATUS Berlaku, Klasifikasi TERBATAS, PENYUSUN = unit; tanda tangan tetap nama', async () => {
    const out = await render(tpl, { ...OPT_IN, 'cover.controlBlock.preparerUnit': 'Divisi Engineering PT GSP' });
    for (const [fmt, text] of Object.entries(out)) {
      for (const s of ['Penyusun', 'Perubahan', 'Status', 'Berlaku', 'Metode', 'Objek', 'Hasil', 'Media', 'Kembali', 'Klasifikasi', 'TERBATAS', 'Divisi Engineering PT GSP', 'A. Pratama']) {
        expect(text, `${fmt}: ${s}`).toContain(s);
      }
      expect(text, fmt).not.toContain('Uraian');
    }
  }, 120_000);

  it('EN: kolom manual EN, In force, Classification, Prepared by = unit EN', async () => {
    const out = await render(tpl, { ...OPT_IN, 'cover.controlBlock.preparerUnit': 'Engineering Division, PT GSP' }, 'EN');
    for (const [fmt, text] of Object.entries(out)) {
      for (const s of ['Prepared by', 'Change', 'In force', 'Method', 'Object', 'Result', 'Medium', 'Return', 'Classification', 'TERBATAS', 'Engineering Division, PT GSP', 'A. Pratama']) {
        expect(text, `${fmt}: ${s}`).toContain(s);
      }
    }
  }, 120_000);

  it('bawaan: kolom mesin, tanpa baris klasifikasi blok kendali, tanpa unit', async () => {
    const out = await render(tpl, {});
    for (const [fmt, text] of Object.entries(out)) {
      expect(text, fmt).toContain('Uraian');
      expect(text, fmt).not.toContain('Berlaku');
      expect(text, fmt).not.toContain('Divisi Engineering PT GSP');
    }
  }, 120_000);
});
