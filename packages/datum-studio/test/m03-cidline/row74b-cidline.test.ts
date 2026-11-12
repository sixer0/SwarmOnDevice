// @ts-nocheck row74b: harness from test/ported/mcp is vitest-typed (bun-types matcher overloads differ); checked at run time.
// Row 74b (Swarm 1.2.6, item M-03, decision U5; register 00_register.md "cidLine: lists every cid or an explicit count").
// At 1.2.5 a result with more than 3 server correlation ids printed only the first, second and last one in the text
// ("a, b, ... z (N cid; lengkap di structuredContent.correlationIds)"), and opencode does not show structuredContent to the
// model when text exists, so the middle cids were invisible. Now the text line names every cid, plus the explicit count.
// Public entry point: the MCP server (same path opencode uses), stub Studio from the ported harness.
import { useStudioEnv } from '../ported/_env'; useStudioEnv();
import { describe, expect, test } from 'bun:test';
import { DOC } from '../ported/draft/r3-stateful-harness';
import { connect, NEW_MD, studioMock } from '../ported/mcp/mcp-harness';

function cidLineOf(text: string): string {
  const lines = text.split('\n').filter((l) => l.startsWith('correlationIds:'));
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe('row 74b M-03: cidLine lists every cid or an explicit count', () => {
  test('a result with more than 3 cids names every cid from structuredContent.correlationIds in the text, with the count', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f });
    const r = await call('studio_report_check', { markdown: NEW_MD });
    expect(r.isError).toBeFalsy();
    const cids: string[] = r.data.correlationIds;
    expect(cids.length).toBeGreaterThan(3);
    const line = cidLineOf(r.text);
    for (const c of cids) expect(line).toContain(c);
    expect(line).not.toContain('...');
    expect(line).toContain(`(${cids.length} cid)`);
  });

  test('a multi-call submit (more than 3 cids) lists them all in server order', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f });
    const r = await call('studio_report_submit', { markdown: NEW_MD });
    expect(r.isError).toBeFalsy();
    const cids: string[] = r.data.correlationIds;
    expect(cids.length).toBeGreaterThan(3);
    expect(cidLineOf(r.text)).toBe(`correlationIds: ${cids.join(', ')} (${cids.length} cid)`);
  });

  test('up to 3 cids and no server call keep their 1.2.5 lines', async () => {
    const m = studioMock();
    const { call } = await connect({ fetch: m.f });
    const g = await call('studio_document_get', { documentId: DOC, view: 'summary' });
    expect(g.data.correlationIds.length).toBeLessThanOrEqual(3);
    expect(cidLineOf(g.text)).toBe(`correlationIds: ${g.data.correlationIds.join(', ')}`);
    const t = await call('studio_report_template', {});
    expect(cidLineOf(t.text)).toMatch(/^correlationIds: - \(tanpa panggilan server; mcpCallId mcp-/);
  });
});
