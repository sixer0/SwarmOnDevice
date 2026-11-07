// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/fixf-spine-text.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-F lanjutan (D-314): string punggung bawaan HTML = DOCX lewat satu fungsi `engine/front/texts.ts`
// (`spineTextOf`): bulan angka Romawi seperti DOCX (dulu HTML memakai nama bulan "OKTOBER").
import { beforeAll, describe, expect, it } from '../_vitest';
import type { ResolvedTemplate } from '@/lib/studio/contract';
import { assembleDocxDetailed } from '@/lib/studio/engine/docx/assemble';
import { assembleHtml } from '@/lib/studio/engine/html/assemble';
import { spineTextOf } from '@/lib/studio/engine/front/texts';
import { canonicalTemplate, loadFixtureDoc, makeCtx, partText, snapshotOf, unzip } from './_kit';

const META = { title: 'T', rev: 'B', typeCode: 'KT', subject: 'POMPA', tier: 'TERBIT', classification: 'TERBATAS', language: 'ID', author: 'Tim', issueDate: '2026-10-08' } as const;

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

describe('spineTextOf: satu sumber string punggung', () => {
  it('bulan Romawi, urutan dan pemisah P4S-24; bahasa tidak mengubah bulan', () => {
    expect(spineTextOf(META as never, {})).toBe('KT · POMPA · ID · REV B · X · 2026');
    expect(spineTextOf({ ...META, language: 'EN' } as never, {})).toBe('KT · POMPA · EN · REV B · X · 2026');
    expect(spineTextOf(META as never, { 'device.spine.fields': ['bulan', 'tahun'] })).toBe('X · 2026');
  });

  it('render nyata TERBIT v1: teks string punggung HTML = DOCX (sampul + pembatas)', async () => {
    const tpl: ResolvedTemplate = await canonicalTemplate();
    const snap = snapshotOf(JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report'))));
    const html = await assembleHtml(makeCtx(snap, tpl).ctx, { preview: false });
    const docx = partText(unzip((await assembleDocxDetailed(makeCtx(snap, tpl).ctx)).bytes), 'word/document.xml');
    const htmlSpines = [...html.matchAll(/data-role="cover\.identityString"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, '')).trim());
    const docxSpines = [...docx.matchAll(/<w:tbl>(?:(?!<\/w:tbl>)[\s\S])*?<w:textDirection w:val="tbRl"\/>[\s\S]*?<\/w:tbl>/g)].map((m) =>
      decode((m[0].match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim(),
    );
    expect(htmlSpines.length).toBeGreaterThan(1);
    expect(htmlSpines).toEqual(docxSpines);
    const expected = spineTextOf(snap.doc.meta, tpl.params);
    // Sampul fixture membawa `identityString` konten; string punggung bawaan = pembatas bagian (dan sampul tanpa konten).
    expect(htmlSpines.slice(1)).toEqual(htmlSpines.slice(1).map(() => expected));
    // sampul tanpa identityString konten: teks bawaan yang sama di kedua format
    const bare = JSON.parse(JSON.stringify(loadFixtureDoc('doc_terbit_report')));
    expect(bare.front.cover.data.identityString).toBeDefined();
    delete bare.front.cover.data.identityString;
    const snap2 = snapshotOf(bare);
    const html2 = await assembleHtml(makeCtx(snap2, tpl).ctx, { preview: false });
    const docx2 = partText(unzip((await assembleDocxDetailed(makeCtx(snap2, tpl).ctx)).bytes), 'word/document.xml');
    const coverSpine = decode((/<section[^>]*data-wrapper="cover"[\s\S]*?data-role="cover\.identityString"[^>]*>([\s\S]*?)<\/div>/.exec(html2)?.[1] ?? '').replace(/<[^>]+>/g, '')).trim();
    expect(coverSpine).toBe(expected);
    const docxFirstSpine = /<w:textDirection w:val="tbRl"\/>[\s\S]*?<\/w:tbl>/.exec(docx2)?.[0] ?? '';
    expect(decode((docxFirstSpine.match(/<w:t[^>]*>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim()).toBe(expected);
    expect(expected).not.toMatch(/JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER/);
  }, 120_000);
});
