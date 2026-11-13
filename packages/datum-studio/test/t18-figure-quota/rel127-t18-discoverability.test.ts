// @ts-nocheck vitest-typed harness (ported/_vitest) run under bun:test; checked at run time.
// Swarm 1.2.7 row 41 (T-18, AC-T18, N7-110; C3 "no new codes", D-7): the per-document figure quota (lint check D22,
// parameters figure.quota.maxPerDocument / figure.quota.exceptionReason, 1.2.6 row 72) is findable by an agent in the
// tool descriptions it reads first. N7-074 sentence in the vendor studio_write description (write-tools.ts) and in the
// host studio_render suffix (render-wrapper.ts, K7-08); the guide says there is no separate quota code.
// Red at 04067a9d02: neither description names D22 and the guide has no such sentence.
// CHAR (pass at both): registry 103 checks, group D 26; default tools/list (reports,documents,query) < 30 000 B.
import { useStudioEnv } from '../ported/_env'; useStudioEnv();
import { describe, it, expect } from '../ported/_vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS } from '../../vendor/scripts/studio/mcp/tools';
import { LINT_REGISTRY } from '../../vendor/src/lib/studio/registry/lint';
import { RENDER_VERIFY_DESCRIPTION_SUFFIX } from '../../src/mcp-host/verify/render-wrapper';
import { connect } from '../ported/mcp/mcp-harness';

const N7_074 = 'Kuota gambar: cek D22; pengecualian lewat parameter figure.quota.exceptionReason (tercatat REPORT).';
const GUIDE = path.resolve(import.meta.dir, '..', '..', 'vendor', 'docs', 'STUDIO-AGENT-GUIDE.md');
const d = (name: string): string => TOOLS.find((t) => t.name === name)!.description;

describe('row 41 T-18: D22 findable in the tool descriptions (N7-110)', () => {
  it('studio_write description names D22 and figure.quota.exceptionReason (N7-074)', () => {
    const t = d('studio_write');
    expect(t).toContain('D22');
    expect(t).toContain('figure.quota.exceptionReason');
    expect(t).toContain(N7_074);
    expect(t.length).toBeLessThanOrEqual(450);
  });

  it('studio_render host description suffix names D22 and figure.quota.exceptionReason (K7-08)', () => {
    expect(RENDER_VERIFY_DESCRIPTION_SUFFIX).toContain('D22');
    expect(RENDER_VERIFY_DESCRIPTION_SUFFIX).toContain('figure.quota.exceptionReason');
    expect(RENDER_VERIFY_DESCRIPTION_SUFFIX).toContain(N7_074);
  });

  it('the guide says there is no separate quota code', () => {
    expect(fs.readFileSync(GUIDE, 'utf8')).toContain('Tidak ada kode kuota terpisah');
  });

  it('CHAR: no new codes (registry 103, group D 26; D22 registered once)', () => {
    expect(LINT_REGISTRY.length).toBe(103);
    expect(LINT_REGISTRY.filter((r) => r.group === 'D').length).toBe(26);
    expect(LINT_REGISTRY.filter((r) => r.id === 'D22').length).toBe(1);
  });

  it('CHAR: default tools/list (reports,documents,query) < 30 000 B', async () => {
    const c = await connect({ env: { STUDIO_MCP_TOOLSETS: 'reports,documents,query' } });
    const bytes = Buffer.byteLength(JSON.stringify(await c.client.listTools()));
    console.log(`row41 default tools/list: ${bytes} B`);
    expect(bytes).toBeLessThan(30_000);
  });

  it('with the write toolset, the listed studio_write carries the quota sentence', async () => {
    const c = await connect({ env: { STUDIO_MCP_TOOLSETS: 'reports,documents,query,write' } });
    const list = await c.client.listTools();
    console.log(`row41 tools/list incl. write: ${Buffer.byteLength(JSON.stringify(list))} B`);
    const w = list.tools.find((t) => t.name === 'studio_write');
    expect(w?.description).toContain(N7_074);
  });
});
