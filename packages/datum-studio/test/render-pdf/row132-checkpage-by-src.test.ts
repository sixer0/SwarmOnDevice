// Swarm 1.3.3 row 132 (SB-1, F2 of the row 21 diagnosis): `checkPage` goes to the render bridge by
// `src` (a file in the page's private work folder), never with the page inline.
//
// Before: BridgePage.evaluate sent `html: this.html`, so one measure pass of a 4 MiB page was a 4 MiB
// request line; the bridge socket copied it chunk by chunk (row 21: 1,030 MB allocated per request).
//
// What runs for real: the vendored bridge client (engine/browser/runtime.ts, engine/browser/index.ts
// measureLayout) and, in the "real receiver" block, the desktop bridge's own request validation, path
// policy and dispatcher (protocol.ts, paths.ts, dispatch.ts), loaded by path. What is faked: the
// transport (no socket, so no sandbox bind) and the PageEngine seam (Electron cannot run under bun).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as browser from "../../vendor/src/lib/studio/engine/browser";
import { MEASURE_SCRIPT } from "../../vendor/src/lib/studio/engine/browser/measure";
import * as runtime from "../../vendor/src/lib/studio/engine/browser/runtime";

const BRIDGE_DIR = path.resolve(import.meta.dir, "..", "..", "..", "desktop", "src", "main", "datum-render");
const GOOD_INFO = { electron: "42.3.3", chrome: "142.0.0.0", sandbox: true, contextIsolation: true, nodeIntegration: false, network: "blocked", scripts: ["studio.measure"] };
const RESULT = { paged: true, pageCount: 2, truncated: false, elements: [{ kind: "page", page: 1 }, { kind: "page", page: 2 }] };
const WORK_PREFIX = "datum-studio-render-";
/** Bytes the fixed measure script takes in a request line (JSON-escaped). */
const SCRIPT_BYTES = Buffer.byteLength(JSON.stringify(MEASURE_SCRIPT), "utf8");
const VIEWPORT = { viewport: { width: 794, height: 1123 } };

/** A paged document of about `bytes` bytes (ASCII, so chars = bytes). */
function pageOf(bytes: number): string {
  const head = `<html><body><div class="page">`;
  const tail = `</div><div class="page">b</div></body></html>`;
  return head + "x".repeat(Math.max(0, bytes - head.length - tail.length)) + tail;
}

/** The request the client sent before this row, rebuilt from the new one, to state the size it had. */
function inlineForm(req: runtime.BridgeRequest, html: string): runtime.BridgeRequest {
  const { src: _src, ...rest } = req;
  return { ...rest, html };
}

type Seen = { req: runtime.BridgeRequest; bytes: number; srcText?: string; srcMode?: number; folderMode?: number };
type Answer = (req: runtime.BridgeRequest) => runtime.BridgeReply | Promise<runtime.BridgeReply>;

function fakeBridge(checkPage: Answer = () => ({ ok: true, script: "studio.measure", result: RESULT })): Seen[] {
  const seen: Seen[] = [];
  runtime.setRenderBridgeTransport(async (req) => {
    const s: Seen = { req: { ...req }, bytes: Buffer.byteLength(JSON.stringify(req), "utf8") };
    seen.push(s);
    if (req.op === "hello") return { ok: true, ...GOOD_INFO };
    if (req.op !== "checkPage") return { ok: false, code: "UNKNOWN_OP", message: "?" };
    const src = String(req.src ?? "");
    if (src !== "" && existsSync(src)) {
      s.srcText = readFileSync(src, "utf8");
      s.srcMode = statSync(src).mode & 0o777;
      s.folderMode = statSync(path.dirname(src)).mode & 0o777;
    }
    return checkPage(req);
  });
  return seen;
}

async function errOf(p: Promise<unknown>): Promise<Error & { code?: string; reason?: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string; reason?: string };
  }
  throw new Error("expected a rejection");
}

const scratch: string[] = [];
function scratchDir(): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), "row132-")));
  scratch.push(d);
  return d;
}

afterEach(() => {
  runtime.setRenderBridgeTransport(null);
  runtime.setBrowserLogSink(null);
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("row 132: the checkPage request carries a path, not the page", () => {
  test("4 MiB page: no html field, request = script + under 1 KiB, src is the fixed file in the private work folder, result unchanged", async () => {
    const html = pageOf(4 * 1024 * 1024);
    const seen = fakeBridge();
    const r = await browser.measureLayout(html);

    expect(seen.map((s) => s.req.op)).toEqual(["hello", "checkPage"]);
    const cp = seen[1];
    expect("html" in cp.req).toBe(false);
    expect(JSON.stringify(cp.req)).not.toContain("xxxxxxxx");
    // What is left is the fixed measure script (about 13 KB, sent with every request) plus under 1 KiB.
    expect(cp.bytes).toBeLessThan(SCRIPT_BYTES + 1024);
    const was = Buffer.byteLength(JSON.stringify(inlineForm(cp.req, html)), "utf8");
    expect(was).toBeGreaterThan(4 * 1024 * 1024);
    console.log(`row132 request size, 4 MiB page: before ${was} B (inline), after ${cp.bytes} B (src)`);

    // The path: fixed name, directly inside a fresh datum-studio-render-* folder under the temp root.
    const src = String(cp.req.src);
    expect(path.isAbsolute(src)).toBe(true);
    expect(path.basename(src)).toBe(runtime.CHECK_PAGE_FILE);
    expect(path.basename(path.dirname(src)).startsWith(WORK_PREFIX)).toBe(true);
    expect(realpathSync(path.dirname(path.dirname(src)))).toBe(realpathSync(tmpdir()));
    // What the bridge reads there is the page, byte for byte, in a private file and folder.
    expect(cp.srcText).toBe(html);
    expect(cp.srcMode).toBe(0o600);
    expect(cp.folderMode).toBe(0o700);

    // The rest of the request is what it was (row 108 pins the same fields).
    expect(cp.req.script).toBe(MEASURE_SCRIPT);
    expect(cp.req.arg).toEqual({ pageWidthMm: 210, pageHeightMm: 297, maxElements: 20000 });
    expect(cp.req.viewportWidth).toBe(794);
    expect(cp.req.viewportHeight).toBe(1123);
    expect(Number(cp.req.wMm)).toBeCloseTo(794 / (96 / 25.4), 6);
    expect(Number(cp.req.hMm)).toBeCloseTo(1123 / (96 / 25.4), 6);

    // Result: what the bridge answered, as before.
    expect(r.pageCount).toBe(2);
    expect(r.pageCountSource).toBe("elements");
    expect(r.elements).toEqual(RESULT.elements as never);

    // Success: the file and its folder are gone.
    expect(existsSync(src)).toBe(false);
    expect(existsSync(path.dirname(src))).toBe(false);
  });

  test("the request size does not grow with the page", async () => {
    const seen = fakeBridge();
    await browser.measureLayout(pageOf(2000));
    await browser.measureLayout(pageOf(1024 * 1024));
    const sizes = seen.filter((s) => s.req.op === "checkPage").map((s) => s.bytes);
    expect(sizes).toHaveLength(2);
    expect(sizes[0]).toBe(sizes[1]);
  });
});

describe("row 132: the page file is removed after failure, and failures map as before", () => {
  const cases: Array<{ name: string; answer: Answer; code: string; reason?: string; message: RegExp }> = [
    { name: "bridge RENDER_FAILED", answer: () => ({ ok: false, code: "RENDER_FAILED", message: "x" }), code: "BROWSER_UNAVAILABLE", reason: "RENDER_FAILED", message: /failed \(RENDER_FAILED/ },
    { name: "bridge RENDER_TIMEOUT", answer: () => ({ ok: false, code: "RENDER_TIMEOUT", message: "slow" }), code: "RENDER_TIMEOUT", message: /timed out in the render bridge/ },
    { name: "bridge INPUT_TOO_LARGE", answer: () => ({ ok: false, code: "INPUT_TOO_LARGE", message: "src is larger than the input cap" }), code: "BY_CONSTRUCTION_FAILED", reason: "INPUT_INVALID", message: /refused the input \(INPUT_TOO_LARGE\)/ },
    { name: "bridge PATH_REFUSED", answer: () => ({ ok: false, code: "PATH_REFUSED", message: "src is outside the allowed roots" }), code: "BY_CONSTRUCTION_FAILED", reason: "INPUT_INVALID", message: /refused the input \(PATH_REFUSED\)/ },
    { name: "bridge SCRIPT_NOT_ALLOWED", answer: () => ({ ok: false, code: "SCRIPT_NOT_ALLOWED", message: "no" }), code: "BROWSER_UNAVAILABLE", reason: "RENDER_FAILED", message: /failed \(SCRIPT_NOT_ALLOWED/ },
    {
      name: "transport dies",
      answer: () => {
        throw new Error("connect ENOENT /no/bridge.sock");
      },
      code: "BROWSER_UNAVAILABLE",
      reason: "RENDER_FAILED",
      message: /Render bridge unavailable/,
    },
  ];
  for (const c of cases) {
    test(`${c.name} -> ${c.code}${c.reason ? `/${c.reason}` : ""}; nothing left behind`, async () => {
      const seen = fakeBridge(c.answer);
      const e = await errOf(browser.measureLayout(pageOf(4000)));
      expect(e.code).toBe(c.code);
      if (c.reason) expect(e.reason).toBe(c.reason);
      expect(e.message).toMatch(c.message);
      const cp = seen.find((s) => s.req.op === "checkPage")!;
      expect(cp.srcText).toBe(pageOf(4000));
      expect(existsSync(String(cp.req.src))).toBe(false);
      expect(existsSync(path.dirname(String(cp.req.src)))).toBe(false);
    });
  }
});

describe("row 132: BridgePage itself (work folder still alive)", () => {
  test("the page file is gone as soon as evaluate returns, on success and on failure; a second measure works", async () => {
    const dir = scratchDir();
    const page = new runtime.BridgePage("measureLayout", VIEWPORT, dir);
    await page.setContent(pageOf(3000));
    let fail = false;
    const seen = fakeBridge(() => (fail ? { ok: false, code: "RENDER_FAILED", message: "x" } : { ok: true, result: RESULT }));
    const expr = `${MEASURE_SCRIPT}(${JSON.stringify({ pageWidthMm: 210, pageHeightMm: 297, maxElements: 5 })})`;

    expect(await page.evaluate(expr)).toEqual(RESULT);
    expect(readdirSync(dir)).toEqual([]);
    expect(await page.evaluate(expr)).toEqual(RESULT);
    expect(readdirSync(dir)).toEqual([]);
    fail = true;
    const e = await errOf(page.evaluate(expr));
    expect(e.reason).toBe("RENDER_FAILED");
    expect(readdirSync(dir)).toEqual([]);

    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.req.src).toBe(path.join(dir, runtime.CHECK_PAGE_FILE));
      expect(s.srcText).toBe(pageOf(3000));
      expect(s.req.arg).toEqual({ pageWidthMm: 210, pageHeightMm: 297, maxElements: 5 });
    }
  });

  test("a link planted at the file name is replaced, never written through", async () => {
    const dir = scratchDir();
    const outside = path.join(scratchDir(), "victim.html");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, path.join(dir, runtime.CHECK_PAGE_FILE));
    const page = new runtime.BridgePage("measureLayout", VIEWPORT, dir);
    await page.setContent(pageOf(500));
    const seen = fakeBridge();
    await page.evaluate(`${MEASURE_SCRIPT}(${JSON.stringify({})})`);
    expect(seen[0].srcText).toBe(pageOf(500));
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("an empty page is refused as before (INPUT_INVALID, BAD_REQUEST) without a request and without a file", async () => {
    const dir = scratchDir();
    const page = new runtime.BridgePage("measureLayout", VIEWPORT, dir);
    const seen = fakeBridge();
    const e = await errOf(page.evaluate(`${MEASURE_SCRIPT}(${JSON.stringify({})})`));
    expect(e.reason).toBe("INPUT_INVALID");
    expect(e.code).toBe("BY_CONSTRUCTION_FAILED");
    expect(e.message).toBe("Render bridge refused the input (BAD_REQUEST)");
    expect(seen).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("print media is still refused before anything is written or sent", async () => {
    const dir = scratchDir();
    const page = new runtime.BridgePage("measureLayout", VIEWPORT, dir);
    await page.setContent(pageOf(500));
    await page.emulateMedia({ media: "print" });
    const seen = fakeBridge();
    const e = await errOf(page.evaluate(`${MEASURE_SCRIPT}(${JSON.stringify({})})`));
    expect(e.message).toMatch(/print media emulation/);
    expect(seen).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });
});

// ── The real receiver (desktop bridge code, no socket, fake page engine) ──────────────────────────

type Job = { html: string; viewportWidth: number; viewportHeight: number; expression: string };
type DispatchModule = { createDispatcher(d: { engine: unknown; policy: unknown; fonts: () => unknown; scripts: unknown }): (body: unknown) => Promise<Record<string, unknown>> };
type PathsModule = { defaultPolicy(home?: string): { roots: string[]; maxInputBytes: number } };
type ScriptsModule = { ScriptAllowList: new () => { add(name: string, text: string): unknown } };
type ProtocolModule = { errorResponse(id: undefined, e: unknown): Record<string, unknown> };

async function realReceiver(policyEdit?: (p: { roots: string[]; maxInputBytes: number }) => void) {
  const dispatchModule = (await import(path.join(BRIDGE_DIR, "dispatch.ts"))) as DispatchModule;
  const pathsModule = (await import(path.join(BRIDGE_DIR, "paths.ts"))) as PathsModule;
  const scriptsModule = (await import(path.join(BRIDGE_DIR, "scripts.ts"))) as ScriptsModule;
  const protocolModule = (await import(path.join(BRIDGE_DIR, "protocol.ts"))) as ProtocolModule;
  const jobs: Job[] = [];
  const engine = {
    async evaluate(job: Job) {
      jobs.push(job);
      return { paged: true, pageCount: (job.html.match(/class="page"/g) ?? []).length, truncated: false, elements: [] };
    },
    info: () => GOOD_INFO,
  };
  const scripts = new scriptsModule.ScriptAllowList();
  for (const s of runtime.STUDIO_BRIDGE_SCRIPTS) scripts.add(s.name, s.text);
  const policy = pathsModule.defaultPolicy(scratchDir());
  policyEdit?.(policy);
  const dispatch = dispatchModule.createDispatcher({ engine, policy, fonts: () => ({ css: "", files: [], faceCount: 0 }), scripts });
  const sizes: number[] = [];
  const sources: string[] = [];
  runtime.setRenderBridgeTransport(async (req) => {
    sizes.push(Buffer.byteLength(JSON.stringify(req), "utf8"));
    if (req.op === "checkPage") sources.push(String(req.src));
    try {
      return { ok: true, ...(await dispatch(JSON.parse(JSON.stringify(req)))) };
    } catch (e) {
      return protocolModule.errorResponse(undefined, e) as runtime.BridgeReply;
    }
  });
  return { jobs, sizes, sources, dispatch };
}

describe("row 132: the bridge's own validation, path policy and dispatcher accept the request", () => {
  test("the engine gets the same job as with the inline form; the result comes back; the request stays small", async () => {
    const html = pageOf(1024 * 1024);
    const { jobs, sizes, dispatch } = await realReceiver();
    const r = await browser.measureLayout(html);
    expect(r.pageCount).toBe(2);
    expect(r.pageCountSource).toBe("elements");
    expect(jobs).toHaveLength(1);
    // The request of before this row (page inline), given to the same dispatcher: identical engine job and reply.
    const arg = { pageWidthMm: 210, pageHeightMm: 297, maxElements: 20000 };
    const inline = await dispatch({ op: "checkPage", html, wMm: 794 / (96 / 25.4), hMm: 1123 / (96 / 25.4), script: MEASURE_SCRIPT, arg, viewportWidth: 794, viewportHeight: 1123 });
    expect(jobs).toHaveLength(2);
    expect(jobs[0].html.length).toBeGreaterThan(html.length);
    expect(jobs[0].html === jobs[1].html).toBe(true);
    expect(jobs[0].expression === jobs[1].expression).toBe(true);
    expect((inline.result as { pageCount: number }).pageCount).toBe(2);
    expect(jobs[0].viewportWidth).toBe(794);
    expect(jobs[0].viewportHeight).toBe(1123);
    expect(jobs[0].expression.includes(MEASURE_SCRIPT)).toBe(true);
    expect(Math.max(...sizes)).toBeLessThan(SCRIPT_BYTES + 1024);
  });

  test("a page over the bridge input cap is refused as INPUT_INVALID, like the inline form was", async () => {
    await realReceiver((p) => {
      p.maxInputBytes = 1000;
    });
    const e = await errOf(browser.measureLayout(pageOf(5000)));
    expect(e.reason).toBe("INPUT_INVALID");
    expect(e.message).toBe("Render bridge refused the input (INPUT_TOO_LARGE)");
  });

  test("a bridge whose roots do not cover the work folder refuses the path (PATH_REFUSED), and the file is still removed", async () => {
    const { sources } = await realReceiver((p) => {
      p.roots = ["/nonexistent-root-row132"];
    });
    const e = await errOf(browser.measureLayout(pageOf(5000)));
    expect(e.reason).toBe("INPUT_INVALID");
    expect(e.message).toBe("Render bridge refused the input (PATH_REFUSED)");
    expect(sources).toHaveLength(1);
    expect(existsSync(path.dirname(sources[0]))).toBe(false);
  });
});
