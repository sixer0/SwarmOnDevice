// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/implw5-footer-display.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON kontrak dibaca bebas-bentuk di uji */
// IMPL-W5 D2 (D-557, uji Hermes ronde 6, U-DOC): kaki halaman DOCX dokumen klien mencetak "REV A" di setiap revisi
// (tidak mengikuti revisi dokumen, mis. "Rev 1" di S2) dan nomor server (047/GSP/KT/X/2026), bukan nomor tampilan
// meta.number ("GSP-UD1-NL-001") yang dicetak sampul. Kini blok register kaki halaman memakai nomor dokumen dari blok
// kendali sampul dan revisi terakhir riwayat revisi lembar kendali (model revisi dokumen itu sendiri), dengan cadangan
// meta.docNumber / meta.rev bila keduanya tidak ada (dokumen lama dan Manual 000 mode explicit tidak berubah).
import { beforeAll, describe, expect, it } from '../_vitest';
import type { NormDocSnapshot, ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { composeV2 } from '@/lib/studio/services/compose';
import { datumSlots, defaultParams, e1, merge, skeletonInput } from '../structure/_kit';
import { benchmarkTemplate, makeCtx, partText, unzip } from './_kit';

const t = (text: string) => ({ text });

function compose(d: any): NormDocSnapshot {
  const slots = datumSlots();
  return composeV2({ source: merge(d, undefined, { slots }).doc, skeleton: skeletonInput(slots), params: { ...defaultParams(), 'render.toc.mode': 'static' } }).snapshot as unknown as NormDocSnapshot;
}

/** Teks semua kaki halaman (NBSP -> spasi). */
async function footers(snap: NormDocSnapshot, bench: ResolvedTemplate): Promise<string> {
  const { ctx } = makeCtx(snap, bench);
  const files = unzip((await assembleDocxDetailed(ctx)).bytes);
  return Object.keys(files)
    .filter((k) => /^word\/footer\d*\.xml$/.test(k))
    .map((k) => (partText(files, k).match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, '')).join(''))
    .join('\n')
    .replace(/ /g, ' ');
}

let BENCH: ResolvedTemplate;
beforeAll(async () => {
  BENCH = await benchmarkTemplate();
});

describe('IMPL-W5 D2: kaki halaman DOCX mengikuti nomor tampilan dan revisi dokumen', () => {
  it('blok kendali sampul + riwayat revisi Rev 1 -> kaki halaman "GSP-UD1-NL-001" dan "REV 1", bukan nomor server / REV A', async () => {
    const d = e1();
    d.meta.docNumber = '047/GSP/KT/X/2026';
    d.meta.rev = 'A';
    d.sections.cover.control = [[t('Nomor dokumen'), t('GSP-UD1-NL-001'), t('Revisi'), t('Rev 1 · 2026-11-04')]];
    d.sections.controlSheet.revisionHistory = [
      { rev: 'Rev 0', date: '2026-11-03', what: 'Terbit pertama', by: 'Tim' },
      { rev: 'Rev 1', date: '2026-11-04', what: 'Sesuai revisi.md', by: 'Tim' },
    ];
    const f = await footers(compose(d), BENCH);
    expect(f).toContain('GSP-UD1-NL-001');
    expect(f).not.toContain('047/GSP/KT/X/2026');
    expect(f).toMatch(/REV 1\b/);
    expect(f).not.toMatch(/REV A\b/);
  });

  it('tanpa blok kendali dan riwayat satu huruf -> perilaku lama (meta.docNumber, REV A)', async () => {
    const d = e1();
    d.meta.docNumber = '047/GSP/KT/X/2026';
    d.meta.rev = 'A';
    const f = await footers(compose(d), BENCH);
    expect(f).toContain('047/GSP/KT/X/2026');
    expect(f).toMatch(/REV A\b/);
  });
});
