// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/renderers/docx-table-preset-profile.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
// FIX-T (D-277 M-2, D-166 KC-6): preset tabel yang menjadi kunci profil lebar
// kolom templat (`render.table.columnProfiles`) adalah jenis tabel sah, bukan
// "preset tidak dikenal"; preset tanpa profil dan tanpa makna mesin tetap
// diperingatkan; profil yang tidak cocok jumlah kolom dilaporkan.
import { beforeAll, describe, expect, it } from '../_vitest';
import type { RenderContext, RenderLogEntry, ResolvedTemplate, TableBlock } from '@/lib/studio/contract';
import { renderTableXml } from '@/lib/studio/engine/docx/tables';
import { resolvePresetDefaults } from '@/lib/studio/engine/docx/tables/presets';
import { canonicalTemplate, loadFixtureDoc, makeCtx, snapshotOf } from './_kit';

const PROFILES = { 'm000-t01': { colsTw: [3000, 6412] }, distribution: { colsTw: [1000, 2000, 6412] } };

function tableOf(preset: string | undefined, ncols: number, widths?: number[]): TableBlock {
  return {
    type: 'table',
    ...(preset !== undefined ? { preset } : {}),
    columns: Array.from({ length: ncols }, (_, i) => (widths ? { widthTw: widths[i] } : {})),
    rows: [{ cells: Array.from({ length: ncols }, (_, i) => ({ text: `sel ${i + 1}` })) }],
  } as TableBlock;
}

describe('resolvePresetDefaults: preset profil kolom', () => {
  it('token berprofil masuk profiled, bukan unknown', () => {
    const r = resolvePresetDefaults('table', 'm000-t01', new Set(['m000-t01']));
    expect(r.unknown).toEqual([]);
    expect(r.profiled).toEqual(['m000-t01']);
  });
  it('tanpa profil tetap unknown (perilaku lama)', () => {
    expect(resolvePresetDefaults('table', 'm000-t01').unknown).toEqual(['m000-t01']);
  });
  it('preset mesin tetap memberi default peran walau juga berprofil', () => {
    const r = resolvePresetDefaults('registerTable', 'distribution', new Set(['distribution']));
    expect(r.unknown).toEqual([]);
    expect(r.profiled).toEqual(['distribution']);
    expect(r.defaults.roles).toEqual(['id']);
  });
});

describe('renderTableXml: peringatan preset', () => {
  let base: ResolvedTemplate;
  let snapCtx: (tpl: ResolvedTemplate) => { ctx: RenderContext; logs: RenderLogEntry[] };
  beforeAll(async () => {
    base = await canonicalTemplate();
    const snap = snapshotOf(loadFixtureDoc('doc_nota_tables'));
    snapCtx = (tpl) => makeCtx(snap, tpl);
  });
  const withProfiles = (): ResolvedTemplate => ({ ...base, params: { ...base.params, 'render.table.columnProfiles': PROFILES } });
  const tableWarns = (logs: RenderLogEntry[]) => logs.filter((l) => l.level === 'warn' && l.message.includes('preset'));

  it('preset berprofil + lebar dari compose: 0 peringatan, grid = profil', () => {
    const { ctx, logs } = snapCtx(withProfiles());
    const { xml } = renderTableXml(tableOf('m000-t01', 2, [3000, 6412]), ctx);
    expect(tableWarns(logs)).toEqual([]);
    expect(xml).toContain('<w:gridCol w:w="3000"/><w:gridCol w:w="6412"/>');
  });

  it('preset tanpa profil di templat: tetap "preset tidak dikenal"', () => {
    const { ctx, logs } = snapCtx(base);
    renderTableXml(tableOf('m000-t01', 2, [3000, 6412]), ctx);
    expect(tableWarns(logs).map((l) => l.message)).toEqual(['[docx/tables] preset tidak dikenal untuk table: m000-t01']);
  });

  it('profil ada tetapi jumlah kolom beda (lebar tidak diterapkan): dilaporkan', () => {
    const { ctx, logs } = snapCtx(withProfiles());
    renderTableXml(tableOf('m000-t01', 3), ctx);
    const msgs = tableWarns(logs).map((l) => l.message);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('profil lebar kolom preset "m000-t01" (2 kolom) tidak cocok dengan tabel 3 kolom');
  });

  it('kunci prototipe ("constructor") bukan profil', () => {
    const { ctx, logs } = snapCtx(withProfiles());
    renderTableXml(tableOf('constructor', 2), ctx);
    expect(tableWarns(logs).map((l) => l.message)).toEqual(['[docx/tables] preset tidak dikenal untuk table: constructor']);
  });
});
