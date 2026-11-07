// @ts-nocheck row42 W13: vitest-typed source run under bun:test (bun-types matcher overloads differ); checked at run time.
// Ported by Swarm row 42 from gsp-datacenter b0ae7a7 tests/unit/studio/figures/diagram-keyrow-schema.test.ts (see test/ported/README.md).
import { useStudioEnv } from '../_env'; useStudioEnv(); // row42 W5: host env (STUDIO_ASSETS_ROOT, STUDIO_WORKSPACE_ROOT), restored afterAll
/**
 * FIX-Z (D-288/D-290): `keyRowOnPage` adalah medan INTERNAL compose pada tipe
 * `StudioDiagramV1`; skema (artefak v1, dokumen v1, dokumen v2) menolaknya dari agen.
 */
import { describe, expect, it } from '../_vitest';
import type { StudioDiagramV1 } from '@/lib/studio/contract';
import { COMMON_V2_SCHEMA_ID } from '@/lib/studio/contract/schema/v2/common.schema';
import { schemaUrl, studioValidator } from '@/lib/studio/services/ingest/validate';
import { diagramSpec } from '@/lib/studio/services/compose/blocks';

const BASE = { $schema: 'studio.diagram/v1', family: 'flow', id: '1.1', title: 'Judul.', classification: 'TERBATAS', width_mm: 166, sources: ['sumber'], nodes: [{ id: 'a', label: 'A', class: {} }] };

describe('keyRowOnPage: bukan medan agen', () => {
  const v = () => studioValidator(schemaUrl('studio.diagram/v1'));
  it('skema studio.diagram/v1 (jalur artefak agen) menerima tanpa, menolak dengan', () => {
    expect(v()(BASE)).toBe(true);
    expect(v()({ ...BASE, keyRowOnPage: true })).toBe(false);
    expect(v()({ ...BASE, keyRowOnPage: false })).toBe(false);
  });
  it('tipe StudioDiagramV1 memuat medan opsional', () => {
    const s: StudioDiagramV1 = { ...(BASE as unknown as StudioDiagramV1), keyRowOnPage: true };
    expect(s.keyRowOnPage).toBe(true);
  });
  it('spec diagram v2 dari agen tidak menerimanya; compose tidak membawanya tanpa keyRow', () => {
    const spec = { family: 'flow', nodes: [{ id: 'a', label: 'A', class: {} }] };
    const val = studioValidator(`${COMMON_V2_SCHEMA_ID}#/$defs/DiagramSpecV2`);
    expect(val(spec)).toBe(true);
    expect(val({ ...spec, keyRowOnPage: true })).toBe(false);
    const out = diagramSpec(spec as never, 'Judul.', 'Sumber.', 166, { glyphs: new Set(), params: {}, classification: 'TERBATAS', artifactLabel: 'Gambar 1.1' } as never);
    expect('keyRowOnPage' in out).toBe(false);
  });
});
