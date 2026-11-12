// @ts-nocheck vitest-typed harness (ported/_vitest) run under bun:test; checked at run time.
// Row 99 (1.2.6, G-06 with M-06, W-05/T-16, W-09/M-07, T-14, W-14): the MCP tool descriptions an agent reads first
// state the 1.2.6 behaviour, and the default tools/list (reports, documents, query) keeps a real margin under the
// 30 500 B pin of mcp-doc-tools.test.ts. Red at e363918a69: none of the new sentences exist.
import { useStudioEnv } from '../ported/_env'; useStudioEnv();
import { describe, it, expect } from '../ported/_vitest';
import { TOOLS } from '../../vendor/scripts/studio/mcp/tools';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as safety from '../../vendor/scripts/studio/mcp/safety';
import { connect, studioMock } from '../ported/mcp/mcp-harness';
import { DOC, MD } from '../ported/draft/r3-stateful-harness';

const d = (name: string): string => TOOLS.find((t) => t.name === name)!.description;

describe('row 99 G-06: tool descriptions', () => {
  it('studio_edit: find/replace reaches figure captions; change is recorded (M-06)', () => {
    expect(d('studio_edit')).toContain('find = frasa >= 3 kata, juga caption/sumber figur');
    expect(d('studio_edit')).toContain('change {what,why,impact} masuk riwayat revisi');
    expect(d('studio_edit')).toContain('Argumen harus objek JSON, bukan string berisi JSON.');
  });

  it('studio_figure_revise: partial spec patch and FIGURE_GRAPH_DELTA (T-16, W-05)', () => {
    expect(d('studio_figure_revise')).toContain('patch parsial');
    expect(d('studio_figure_revise')).toContain('spec digabung');
    expect(d('studio_figure_revise')).toContain('FIGURE_GRAPH_DELTA');
  });

  it('studio_render: up to 540 s; on timeout document_status then file_verify, no blind re-render; labels (W-09, M-07)', () => {
    const t = d('studio_render');
    expect(t).toContain('540 s');
    expect(t).toMatch(/waktu habis[^.]*studio_document_status lalu studio_file_verify/i);
    expect(t).toContain('jangan render ulang buta');
    expect(t).toContain('FILE_VERIFIED(sha256)');
    expect(t).not.toMatch(/tunggu|poll/i);
  });

  it('studio_figure_preview: the inline preview is the gate; standalone checks the figure alone (W-14)', () => {
    const t = d('studio_figure_preview');
    expect(t).toContain('Gerbang = pratinjau inline');
    expect(t).toContain('standalone: hanya figur sendiri');
  });

  it('studio_document_status: findings paging (T-14)', () => {
    const t = d('studio_document_status');
    expect(t).toContain('findings {checkId');
    expect(t).toContain('nextOffset');
  });

  it('every description <= 450 characters', () => {
    for (const t of TOOLS) expect(t.description.length, t.name).toBeLessThanOrEqual(450);
  });

  it('default tools/list (reports,documents,query) < 30 000 B: >= 500 B margin under the mcp-doc-tools 30 500 B pin', async () => {
    const c = await connect({ env: { STUDIO_MCP_TOOLSETS: 'reports,documents,query' } });
    const bytes = Buffer.byteLength(JSON.stringify(await c.client.listTools()));
    expect(bytes).toBeLessThan(30_000);
  });
});

describe('row 99 (controller add-on, row 71 T-17 retention): backupRemoved is printed', () => {
  it('studio_report_refresh overwrite x7: from the 6th write the text and data carry backupRemoved', async () => {
    const m = studioMock();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'row99-g06-')));
    const victim = path.join(root, 'catatan.md');
    fs.writeFileSync(victim, 'ISI-ASLI\n');
    const { call } = await connect({ fetch: m.f, nfs: safety.REAL_NODE_FS, env: { STUDIO_MCP_FILE_ROOTS: root } });
    const removed: number[] = [];
    for (let i = 1; i <= 7; i++) {
      const r = await call('studio_report_refresh', { documentId: DOC, markdown: MD(), outPath: victim, overwrite: true });
      expect(r.isError).toBeFalsy();
      const n = (r.data.backupRemoved as number | undefined) ?? 0;
      removed.push(n);
      if (n > 0) expect(r.text).toContain(`backupRemoved ${n}`);
      else expect(r.text).not.toContain('backupRemoved');
    }
    expect(removed.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(removed.slice(5).every((n) => n > 0)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
