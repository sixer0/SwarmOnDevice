// @ts-nocheck vitest-typed harness run under bun:test (same as test/ported/mcp); checked at run time.
// Swarm 1.3.3 row 78 (ST-11): an edit does not render the whole document.
// Before: `finishDoc` (vendor/scripts/studio/mcp/write-client-run.ts) posted R17 {scope:"document", formats:["docx"]}
// after EVERY `studio_edit` of a COMPLETE client document, so ten edits = ten full renders (red below: 10).
// After: `studio_edit` never renders; its reply says the revision is not rendered and names the one call
// (`studio_render`); it carries no file id, so a render of an older revision is never shown as the current one.
// The renderer is injected: the mock Studio server's R17 route (clientServer, implw3-client-mock) is wrapped and counted.
import { useStudioEnv } from '../ported/_env'; useStudioEnv();
import { describe, it, expect } from '../ported/_vitest';
import { connect } from '../ported/mcp/mcp-harness';
import { clientServer, DOCID, env as cenv, WRITE_ARGS } from '../ported/mcp/implw3-client-mock';

const FILE = 'cmwfiledocx000000000000w2a';
const env = { ...cenv, STUDIO_MCP_TOOLSETS: 'write,documents' };

/** Mock server + injected renderer: every R17 call is recorded with the revision the server held at that moment. */
function fixture(o = { exists: true }) {
  const m = clientServer(o);
  const renders: Array<{ rev: number; body: any }> = [];
  const downloads: string[] = [];
  const f = async (url: string, init: any) => {
    const p = new URL(url).pathname;
    if (p === `/api/studio/documents/${DOCID}/render`) renders.push({ rev: m.rev(), body: init.body ? JSON.parse(init.body) : null });
    if (p.startsWith('/api/studio/files/')) downloads.push(`${init.method} ${p}`);
    return m.f(url, init);
  };
  return { m, f, renders, downloads };
}

describe('row 78 ST-11: sunting tidak merender seluruh dokumen', () => {
  it('sepuluh studio_edit berurutan pada dokumen COMPLETE -> paling banyak satu render (0), tiap jawaban menyebut render diperlukan', async () => {
    const x = fixture();
    const { call } = await connect({ fetch: x.f, env });
    let text = 'Paragraf pembuka lama.';
    const replies: any[] = [];
    for (let i = 1; i <= 10; i++) {
      const next = `Paragraf pembuka suntingan ke-${i}.`;
      const r = await call('studio_edit', { documentId: DOCID, edits: [{ find: text, replace: next }] });
      expect(r.data.ok, r.text).toBe(true);
      replies.push(r);
      text = next;
    }
    console.log(`[row78] renders per ten edits: ${x.renders.length}; file requests: ${x.downloads.length}`);
    console.log(`[row78] last edit reply:\n${replies[9].text}`);
    expect(x.renders.length).toBeLessThanOrEqual(1);
    expect(x.renders.length).toBe(0);
    // No render file is fetched or re-hashed either (the old path: HEAD ?verify=1 + GET ?download=1 per edit).
    expect(x.downloads).toEqual([]);
    expect(x.m.rev()).toBe(14);
    replies.forEach((r, i) => {
      expect(r.data.revisionNo).toBe(5 + i);
      expect(r.data.completeness.status).toBe('COMPLETE');
      // No stale render: the reply carries no file at all, and says which revision still has to be rendered.
      expect(r.data.render).toBeNull();
      expect(r.data.renderNeeded).toEqual({ revisionNo: 5 + i, reason: 'EDIT_NOT_RENDERED', call: 'studio_render' });
      expect(r.text).toContain(`rev ${5 + i} belum dirender`);
      expect(r.text).toContain(`studio_render { documentId: "${DOCID}" }`);
      expect(r.text).not.toContain(FILE);
      expect(JSON.stringify(r.data)).not.toContain(FILE);
      // The wording for an incomplete document must not appear: the document IS complete.
      expect(r.text).not.toContain('lengkapi isi');
      // The parts of the summary that do not need a render stay: stored revision and stored meta.
      expect(r.data.verify.storedRevision).toBe(5 + i);
      expect(r.text).toContain('tanpa berkas');
    });
  });

  it('sesudah kelompok suntingan: satu studio_render merender revisi terkini (bukan revisi sebelum suntingan)', async () => {
    const x = fixture();
    const { call } = await connect({ fetch: x.f, env });
    let text = 'Paragraf pembuka lama.';
    for (let i = 1; i <= 10; i++) {
      const next = `Paragraf pembuka suntingan ke-${i}.`;
      expect((await call('studio_edit', { documentId: DOCID, edits: [{ find: text, replace: next }] })).data.ok).toBe(true);
      text = next;
    }
    const r = await call('studio_render', { documentId: DOCID, formats: ['docx'] });
    expect(r.data.ok, r.text).toBe(true);
    // One render for the group, made while the server held the last edit's revision, with no pinned older revisionNo.
    expect(x.renders.length).toBe(1);
    expect(x.renders[0].rev).toBe(14);
    expect(x.renders[0].body.revisionNo).toBeUndefined();
    expect(x.renders[0].body.scope).toBe('document');
    expect(r.data.outputs[0].id).toBe(FILE);
  });

  it('detail: true -> nextSteps menyebut studio_render, bukan "lengkapi isi"', async () => {
    const x = fixture();
    const { call } = await connect({ fetch: x.f, env });
    const r = await call('studio_edit', { documentId: DOCID, detail: true, edits: [{ find: 'Paragraf pembuka lama.', replace: 'Paragraf baru.' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(x.renders.length).toBe(0);
    expect(r.data.nextSteps.some((s: string) => s.startsWith('studio_render {'))).toBe(true);
    expect(r.data.nextSteps.some((s: string) => s.includes('lengkapi isi'))).toBe(false);
  });

  it('studio_edit yang tidak mengubah apa pun: tidak merender, tidak mengaku ada yang perlu dirender', async () => {
    const x = fixture();
    const { call } = await connect({ fetch: x.f, env });
    const r = await call('studio_edit', { documentId: DOCID, edits: [{ find: 'Paragraf pembuka lama.', replace: 'Paragraf pembuka lama.' }] });
    expect(r.data.ok, r.text).toBe(true);
    expect(r.data.state).toBe('tidak berubah');
    expect(x.renders.length).toBe(0);
    expect(r.data.renderNeeded).toBeUndefined();
  });

  it('karakterisasi: studio_write (tulis utuh) tetap merender satu kali dan membawa berkasnya', async () => {
    const x = fixture({ exists: false });
    const { call } = await connect({ fetch: x.f, env });
    const r = await call('studio_write', WRITE_ARGS);
    expect(r.data.ok, r.text).toBe(true);
    expect(x.renders.length).toBe(1);
    expect(r.data.render.fileId).toBe(FILE);
    expect(r.data.renderNeeded).toBeUndefined();
    // The render was made after the last part was written: the revision the reply names is the rendered one.
    expect(x.renders[0].rev).toBe(r.data.revisionNo);
  });
});
