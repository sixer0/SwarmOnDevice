/**
 * Swarm TWIN (row 108, studio spec §1.3 and §2 D/G, decisions C4/C14): Studio's browser runtime over
 * the Swarm render bridge. Studio no longer launches a Chromium of its own and `playwright-core` is
 * gone. Every page operation is sent to the render bridge in Electron main (row 24) over its Unix
 * socket (`DATUM_RENDER_SOCKET`) with the per-launch token (`DATUM_RENDER_TOKEN`):
 *   - png        SVG file -> PNG file (fixed sandboxed window, page JS off, network blocked)
 *   - pdf        HTML file -> PDF file (printToPDF, preferCSSPageSize)
 *   - checkPage  allow-listed fixed page script (Studio MEASURE_SCRIPT) on HTML content
 *   - pagePng    HTML file -> one PNG per printed page (row 151b, C130 GAP-1): {@link rasterizeHtmlPages}
 *   - hello      handshake: the bridge reports its window settings
 *
 * Replaces the original sandbox rules (runtime.ts:1-23 of the clone):
 *   - The OS sandbox is now asserted at the bridge handshake: `sandbox: true`, `contextIsolation: true`,
 *     `nodeIntegration: false`, `network: "blocked"`. Anything else = `BROWSER_UNAVAILABLE` (reason
 *     `SANDBOX_UNAVAILABLE`), never a silent fallback (spec §2 G). The `chrome://sandbox` probe and
 *     the scratch-only probe patch of C14 are NOT part of this twin.
 *   - One operation at a time (semaphore 1, bounded queue) and the per-operation timeout are kept
 *     verbatim from the original; the bridge also serialises its jobs.
 *   - Error messages that can reach a client never carry raw bridge text or the token; details go to
 *     the browser log sink only.
 *
 * Entry points of `index.ts` are kept unchanged (getBrowser, rasterizeSvg, measureLayout,
 * previewHtml, closeBrowser): this module hands index.ts a page object with the subset of the
 * Playwright `Page` API that index.ts calls, mapped onto the bridge ops. Not served by the bridge
 * (fail closed with BROWSER_UNAVAILABLE): HTML screenshots (`previewHtml`; previews open in the
 * Swarm file tabs, spec §8) and print-media emulation.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { RenderLogEntry } from "../../contract/engine";
import { RASTER_TIMEOUT_MAX_MS, STUDIO_CHROMIUM_TIMEOUT_MS } from "../../contract/env";
import type { StudioErrorCode } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import { FONTS_READY_SCRIPT, MEASURE_SCRIPT } from "./measure";

export type BrowserFailureReason = "LAUNCH_FAILED" | "SANDBOX_UNAVAILABLE" | "INPUT_INVALID" | "RENDER_FAILED";

/** Contract code per reason (unchanged from the original, IP-05, D-38). */
const REASON_CODE: Readonly<Record<BrowserFailureReason, StudioErrorCode>> = {
  LAUNCH_FAILED: "BROWSER_UNAVAILABLE",
  SANDBOX_UNAVAILABLE: "BROWSER_UNAVAILABLE",
  RENDER_FAILED: "BROWSER_UNAVAILABLE",
  INPUT_INVALID: "BY_CONSTRUCTION_FAILED",
};

/** Browser service error other than timeout (unchanged from the original). */
export class StudioBrowserError extends StudioEngineError {
  readonly reason: BrowserFailureReason;
  readonly op: string;

  constructor(reason: BrowserFailureReason, op: string, message: string, options?: { cause?: unknown }) {
    super(REASON_CODE[reason], message, { reason, op });
    this.name = "StudioBrowserError";
    this.reason = reason;
    this.op = op;
    if (options && "cause" in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Structured log sink; the render job log installs one (durable). */
export type BrowserLogSink = (e: RenderLogEntry & { source: "engine/browser"; op?: string; durationMs?: number }) => void;

// ── Render bridge client ─────────────────────────────────────────────────

export const RENDER_SOCKET_ENV = "DATUM_RENDER_SOCKET";
export const RENDER_TOKEN_ENV = "DATUM_RENDER_TOKEN";
/** Upper bound of one reply line (bridge MAX_LINE_BYTES is 24 MiB for requests; replies are small). */
const MAX_REPLY_BYTES = 32 * 1024 * 1024;

export type BridgeOp = "hello" | "png" | "pdf" | "checkPage" | "pagePng";
export type BridgeRequest = { op: BridgeOp } & Record<string, unknown>;
export type BridgeReply = ({ ok: true } & Record<string, unknown>) | { ok: false; code?: string; message?: string; error?: string };
/**
 * Options of one transport call. Swarm 1.2.6 M-04: `timeoutMs` is the host-side limit of the page
 * operation the request belongs to (default STUDIO_CHROMIUM_TIMEOUT_MS).
 */
export interface BridgeTransportOptions {
  timeoutMs?: number;
}
/** One request -> one reply. The token is added by the transport, never by callers. */
export type BridgeTransport = (req: BridgeRequest, opts?: BridgeTransportOptions) => Promise<BridgeReply>;

/**
 * Swarm 1.2.6 M-04 (N-047): the socket read waits for the op limit plus this margin, so the
 * host-side op timer (or the bridge's own RENDER_TIMEOUT reply) decides, not the socket read.
 */
export const BRIDGE_READ_MARGIN_MS = 45000;

/** What the bridge reports at the handshake (row 24 dispatch.ts EngineInfo + hello extras). */
export interface BridgeInfo {
  electron: string;
  chrome: string;
  sandbox: boolean;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  javascriptContent?: boolean;
  network?: string;
  fonts?: number;
  scripts?: string[];
}

/** Fixed page scripts Studio sends to `checkPage`; the host registers them in the bridge allow-list (row 24 scripts.ts). */
export const STUDIO_BRIDGE_SCRIPTS: ReadonlyArray<{ name: string; text: string }> = [{ name: "studio.measure", text: MEASURE_SCRIPT }];

class BridgeTransportError extends Error {
  constructor(
    readonly kind: "not-configured" | "connect" | "protocol",
    message: string,
  ) {
    super(message);
    this.name = "BridgeTransportError";
  }
}

/** Default transport: one connection per request over the bridge Unix socket (row 24 socket-server.ts). */
export const socketTransport: BridgeTransport = (req, opts) => {
  const readTimeoutMs = (opts?.timeoutMs ?? STUDIO_CHROMIUM_TIMEOUT_MS) + BRIDGE_READ_MARGIN_MS;
  const socketPath = process.env[RENDER_SOCKET_ENV]?.trim() ?? "";
  const token = process.env[RENDER_TOKEN_ENV]?.trim() ?? "";
  if (socketPath === "" || token === "" || !path.isAbsolute(socketPath)) {
    return Promise.reject(new BridgeTransportError("not-configured", `${RENDER_SOCKET_ENV}/${RENDER_TOKEN_ENV} not set (Swarm render bridge not running)`));
  }
  return new Promise<BridgeReply>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (err: Error | null, reply?: BridgeReply) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(reply!);
    };
    const sock = net.createConnection({ path: socketPath });
    sock.setTimeout(readTimeoutMs, () => done(new BridgeTransportError("protocol", "render bridge did not answer in time")));
    sock.on("error", (e) => done(new BridgeTransportError("connect", `render bridge socket error: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
    sock.on("connect", () => sock.write(`${JSON.stringify({ ...req, token })}\n`));
    sock.on("data", (b: Buffer) => {
      size += b.length;
      if (size > MAX_REPLY_BYTES) return done(new BridgeTransportError("protocol", "render bridge reply too large"));
      const nl = b.indexOf(0x0a);
      if (nl < 0) {
        chunks.push(b);
        return;
      }
      chunks.push(b.subarray(0, nl));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeReply;
        if (typeof parsed !== "object" || parsed === null || typeof (parsed as { ok?: unknown }).ok !== "boolean") {
          return done(new BridgeTransportError("protocol", "render bridge reply has no ok field"));
        }
        done(null, parsed);
      } catch {
        done(new BridgeTransportError("protocol", "render bridge reply is not JSON"));
      }
    });
    sock.on("end", () => done(new BridgeTransportError("protocol", "render bridge closed the connection without a reply")));
  });
};

// ── Process state ────────────────────────────────────────────────────────

/** Handle of the bridge "browser" (stands in for the Playwright Browser of the original). */
export interface Browser {
  readonly info: BridgeInfo;
  version(): string;
  isConnected(): boolean;
  close(): Promise<void>;
}

interface BrowserState {
  browser: Browser | null;
  launching: Promise<Browser> | null;
  /** Tail of the semaphore-1 queue. */
  tail: Promise<void>;
  queued: number;
  sink: BrowserLogSink | null;
  transport: BridgeTransport | null;
}

const STATE_KEY = "__studioBrowserStateSwarmBridge";

function state(): BrowserState {
  const g = globalThis as unknown as Record<string, BrowserState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = { browser: null, launching: null, tail: Promise.resolve(), queued: 0, sink: null, transport: null };
    g[STATE_KEY] = s;
  }
  return s;
}

export function setBrowserLogSink(sink: BrowserLogSink | null): void {
  state().sink = sink;
}

/** Replace the bridge transport (tests, host wiring); null = the Unix socket transport. Drops the cached handshake. */
export function setRenderBridgeTransport(t: BridgeTransport | null): void {
  const s = state();
  s.transport = t;
  s.browser = null;
}

export function logBrowser(level: RenderLogEntry["level"], message: string, extra?: { op?: string; durationMs?: number; code?: string }): void {
  const entry = { source: "engine/browser" as const, level, message, at: new Date().toISOString(), ...extra };
  const sink = state().sink;
  if (sink) {
    try {
      sink(entry);
      return;
    } catch {
      // Caller sink failed: fall back to stderr so the entry is not lost.
    }
  }
  if (level !== "info") console.error(JSON.stringify(entry));
}

const INPUT_CODES = new Set(["BAD_REQUEST", "PATH_REFUSED", "INPUT_TOO_LARGE", "SVG_INVALID", "LINE_TOO_LONG"]);

/** Send one op to the bridge; map transport failures and bridge error codes to Studio errors. */
export async function bridgeCall(op: string, req: BridgeRequest, timeoutMs?: number): Promise<Record<string, unknown>> {
  const s = state();
  const transport = s.transport ?? socketTransport;
  let reply: BridgeReply;
  try {
    reply = await transport(req, timeoutMs === undefined ? undefined : { timeoutMs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logBrowser("error", `render bridge ${req.op} failed: ${msg}`, { op, code: "BROWSER_UNAVAILABLE" });
    // A dead bridge invalidates the handshake: the next operation handshakes again.
    s.browser = null;
    const reason: BrowserFailureReason = e instanceof BridgeTransportError && e.kind !== "protocol" ? "LAUNCH_FAILED" : "RENDER_FAILED";
    throw new StudioBrowserError(reason, op, "Render bridge unavailable (is the Swarm app running? see engine/browser log)", { cause: e });
  }
  if (reply.ok) return reply;
  const code = typeof reply.code === "string" ? reply.code : "RENDER_FAILED";
  const detail = typeof reply.message === "string" ? reply.message : typeof reply.error === "string" ? reply.error : "";
  logBrowser("error", `render bridge ${req.op} refused: ${code}${detail ? ` (${detail})` : ""}`, { op, code });
  if (code === "RENDER_TIMEOUT") throw new StudioEngineError("RENDER_TIMEOUT", `Browser operation '${op}' timed out in the render bridge`, { op });
  if (INPUT_CODES.has(code)) throw new StudioBrowserError("INPUT_INVALID", op, `Render bridge refused the input (${code})`);
  throw new StudioBrowserError("RENDER_FAILED", op, `Render bridge operation '${op}' failed (${code}; see engine/browser log)`);
}

/** null when the handshake shows a sandboxed, isolated, Node-free, offline render window; else the reason. */
export function judgeBridgeInfo(info: Partial<BridgeInfo> | null | undefined): string | null {
  if (!info || typeof info !== "object") return "render bridge handshake returned nothing";
  const bad: string[] = [];
  if (info.sandbox !== true) bad.push(`sandbox=${String(info.sandbox)}`);
  if (info.contextIsolation !== true) bad.push(`contextIsolation=${String(info.contextIsolation)}`);
  if (info.nodeIntegration !== false) bad.push(`nodeIntegration=${String(info.nodeIntegration)}`);
  if (info.network !== undefined && info.network !== "blocked") bad.push(`network=${String(info.network)}`);
  return bad.length > 0 ? `render window is not locked down: ${bad.join(", ")}` : null;
}

/** Handshake (`hello`): the bridge must report the locked-down window, else BROWSER_UNAVAILABLE (SANDBOX_UNAVAILABLE). */
export async function bridgeHandshake(): Promise<BridgeInfo> {
  const op = "sandbox-check";
  const r = (await bridgeCall(op, { op: "hello" })) as unknown as BridgeInfo;
  const verdict = judgeBridgeInfo(r);
  if (verdict !== null) {
    logBrowser("error", `Render bridge sandbox check failed: ${verdict}`, { op, code: "BROWSER_UNAVAILABLE" });
    throw new StudioBrowserError("SANDBOX_UNAVAILABLE", op, "Render window OS sandbox is not active; rendering refused (see engine/browser log)");
  }
  return {
    electron: String(r.electron ?? ""),
    chrome: String(r.chrome ?? ""),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    javascriptContent: r.javascriptContent,
    network: r.network,
    fonts: r.fonts,
    scripts: Array.isArray(r.scripts) ? r.scripts.map(String) : undefined,
  };
}

async function launch(): Promise<Browser> {
  const started = Date.now();
  const info = await bridgeHandshake();
  let connected = true;
  const browser: Browser = {
    info,
    version: () => `Electron ${info.electron} (Chromium ${info.chrome}) via render bridge`,
    isConnected: () => connected,
    close: async () => {
      connected = false;
    },
  };
  logBrowser("info", `${browser.version()} ready (sandboxed)`, { op: "launch", durationMs: Date.now() - started });
  return browser;
}

/** Single instance; parallel launches share one promise (unchanged contract). */
export async function ensureBrowser(): Promise<Browser> {
  const s = state();
  if (s.browser && s.browser.isConnected()) return s.browser;
  if (!s.launching) {
    s.launching = launch()
      .catch((e: unknown) => {
        if (e instanceof StudioEngineError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        logBrowser("error", `Render bridge handshake failed: ${msg}`, { op: "launch" });
        throw new StudioBrowserError("LAUNCH_FAILED", "launch", "Render bridge handshake failed (see engine/browser log)", { cause: e });
      })
      .then((b) => {
        s.browser = b;
        return b;
      })
      .finally(() => {
        s.launching = null;
      });
  }
  return s.launching;
}

// ── Bounded queue (verbatim from the original, FIX-8, S87 M-03) ──────────
export const BROWSER_MAX_QUEUED_DEFAULT = 16;
/** Swarm 1.2.6 M-04 (N-048, 01d F4): 240000 = 2 x RASTER_TIMEOUT_MAX_MS, at least the bridge JOB_TIMEOUT_MS (ladder I-5); env STUDIO_CHROMIUM_QUEUE_WAIT_MS kept. */
export const BROWSER_QUEUE_WAIT_MS_DEFAULT = 2 * RASTER_TIMEOUT_MAX_MS;
export const BROWSER_QUEUE_RETRY_AFTER_SEC_DEFAULT = 30;

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export function browserQueueLimits(): { maxQueued: number; maxWaitMs: number; retryAfterSec: number } {
  return {
    maxQueued: envInt("STUDIO_CHROMIUM_MAX_QUEUED", BROWSER_MAX_QUEUED_DEFAULT, 0),
    maxWaitMs: envInt("STUDIO_CHROMIUM_QUEUE_WAIT_MS", BROWSER_QUEUE_WAIT_MS_DEFAULT, 1),
    retryAfterSec: envInt("STUDIO_RENDER_QUEUE_RETRY_AFTER_SEC", BROWSER_QUEUE_RETRY_AFTER_SEC_DEFAULT, 1),
  };
}

export function browserQueueState(): { queued: number; maxQueued: number } {
  return { queued: state().queued, maxQueued: browserQueueLimits().maxQueued };
}

function queueFull(reason: "queue_full" | "wait_timeout", limits: ReturnType<typeof browserQueueLimits>, inQueue: number): StudioEngineError {
  logBrowser("warn", `Chromium queue rejected operation (${reason}; in queue ${inQueue}, max waiting ${limits.maxQueued})`, { op: "queue", code: "RENDER_QUEUE_FULL" });
  return new StudioEngineError(
    "RENDER_QUEUE_FULL",
    reason === "queue_full" ? "Browser render queue is full; retry later" : "Browser render queue wait exceeded; retry later",
    { reason, retryAfterSec: limits.retryAfterSec, inQueue, maxQueued: limits.maxQueued, maxWaitMs: limits.maxWaitMs },
  );
}

export async function withLock<T>(fn: () => Promise<T>, opts?: { unbounded?: boolean }): Promise<T> {
  const s = state();
  const limits = opts?.unbounded ? { ...browserQueueLimits(), maxQueued: Number.MAX_SAFE_INTEGER, maxWaitMs: 2 ** 31 - 1 } : browserQueueLimits();
  const waiting = Math.max(0, s.queued - 1);
  if (s.queued > 0 && waiting >= limits.maxQueued) throw queueFull("queue_full", limits, s.queued);
  const prev = s.tail;
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  s.tail = prev.then(() => mine);
  s.queued++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((r) => {
    timer = setTimeout(() => r("expired"), limits.maxWaitMs);
  });
  const turn = await Promise.race([prev.then(() => "turn" as const), expired]);
  clearTimeout(timer);
  if (turn === "expired") {
    s.queued--;
    void prev.then(release);
    throw queueFull("wait_timeout", limits, s.queued + 1);
  }
  try {
    return await fn();
  } finally {
    s.queued--;
    release();
  }
}

// ── Page adapter over the bridge ─────────────────────────────────────────

export interface PageOptions {
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  timeoutMs?: number;
}

const RULE_RE = /@font-face\{[^}]*\}/g;

/** Raster page of index.ts `rasterizeSvg`: `<style>fonts+layout</style>` + one inline `<svg>` in `<body>`. Null for other HTML. */
export function splitRasterPage(html: string): { svg: string; fontCss: string } | null {
  const open = /<body[^>]*>/i.exec(html);
  const close = html.lastIndexOf("</body>");
  if (!open || close < open.index) return null;
  const svg = html.slice(open.index + open[0].length, close).trim();
  if (!/^<svg[\s>]/i.test(svg)) return null;
  const head = html.slice(0, open.index);
  const fontCss = (head.match(RULE_RE) ?? []).join("");
  return { svg, fontCss };
}

/** Put Studio's own @font-face rules (template faces, rasterFontCss) inside the SVG root so the bridge page sees them. */
export function svgWithFontCss(svg: string, fontCss: string): string {
  if (fontCss === "") return svg;
  const end = svg.indexOf(">");
  if (end < 0 || svg[end - 1] === "/") return svg;
  return `${svg.slice(0, end + 1)}<style data-studio-fonts="">${fontCss}</style>${svg.slice(end + 1)}`;
}

function mmOf(v: string | number | undefined, fallback: number): number {
  if (typeof v === "number") return v;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*mm\s*$/i.exec(v ?? "");
  return m ? parseFloat(m[1]) : fallback;
}

const PX_PER_MM = 96 / 25.4;

/**
 * The subset of the Playwright `Page` API that index.ts calls. Content is held in memory until an
 * op needs it; files for the bridge go to a private 0700 work folder that is removed after the op.
 */
export class BridgePage {
  private html = "";
  private media: "screen" | "print" = "screen";

  constructor(
    private readonly op: string,
    private readonly opts: PageOptions,
    private readonly workdir: string,
  ) {}

  private file(name: string): string {
    return path.join(this.workdir, name);
  }

  async setContent(html: string, _opts?: unknown): Promise<void> {
    this.html = html;
  }

  async emulateMedia(o: { media?: "screen" | "print" | null }): Promise<void> {
    this.media = o.media === "print" ? "print" : "screen";
  }

  /** The bridge settles the page itself (fonts ready + delay); no page clock here. */
  async waitForTimeout(_ms: number): Promise<void> {}

  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  evaluate(expr: string): Promise<unknown>;
  async evaluate(expr: unknown, _arg?: unknown): Promise<unknown> {
    if (typeof expr === "function") {
      // index.ts font-load check (Review 15 F2, returns the faces that did not load): page functions
      // cannot cross the bridge (only allow-listed fixed scripts run), so none is reported. The faces
      // are data: URIs whose sha256 was verified when read (html/base/fonts.ts fontBase64), and the
      // bridge waits for document.fonts.ready before capturing.
      return [];
    }
    if (expr === FONTS_READY_SCRIPT) return 0;
    if (typeof expr === "string" && expr.startsWith(`${MEASURE_SCRIPT}(`) && expr.endsWith(")")) {
      if (this.media === "print") {
        throw new StudioBrowserError("RENDER_FAILED", this.op, "print media emulation is not served by the render bridge");
      }
      const arg = JSON.parse(expr.slice(MEASURE_SCRIPT.length + 1, -1)) as unknown;
      const { width, height } = this.opts.viewport;
      const r = await bridgeCall(this.op, {
        op: "checkPage",
        html: this.html,
        wMm: width / PX_PER_MM,
        hMm: height / PX_PER_MM,
        script: MEASURE_SCRIPT,
        arg,
        viewportWidth: width,
        viewportHeight: height,
      }, this.opts.timeoutMs);
      return r.result;
    }
    throw new StudioBrowserError("RENDER_FAILED", this.op, "page script is not available through the render bridge");
  }

  async screenshot(o: { clip?: { x: number; y: number; width: number; height: number } } & Record<string, unknown>): Promise<Buffer> {
    const page = splitRasterPage(this.html);
    if (!page || !o.clip || o.clip.x !== 0 || o.clip.y !== 0) {
      throw new StudioBrowserError("RENDER_FAILED", this.op, "HTML screenshots are not served by the render bridge (previews open in the Swarm file tabs)");
    }
    const scale = this.opts.deviceScaleFactor ?? 1;
    // Chromium truncates the fractional CSS clip before scaling (index.ts rasterizeSvg comment, 128 mm -> 1509 px).
    const width = Math.max(1, Math.floor(Math.trunc(o.clip.width) * scale));
    const height = Math.max(1, Math.floor(Math.trunc(o.clip.height) * scale));
    const src = this.file("figure.svg");
    const dst = this.file("figure.png");
    writeFileSync(src, svgWithFontCss(page.svg, page.fontCss), { mode: 0o600 });
    rmSync(dst, { force: true });
    await bridgeCall(this.op, { op: "png", src, dst, width, height }, this.opts.timeoutMs);
    return readFileSync(dst);
  }

  async pdf(o: { width?: string | number; height?: string | number; preferCSSPageSize?: boolean } & Record<string, unknown>): Promise<Buffer> {
    const src = this.file("page.html");
    const dst = this.file("page.pdf");
    writeFileSync(src, this.html, { mode: 0o600 });
    rmSync(dst, { force: true });
    await bridgeCall(this.op, {
      op: "pdf",
      src,
      dst,
      widthMm: mmOf(o.width, 210),
      heightMm: mmOf(o.height, 297),
      preferCSSPageSize: o.preferCSSPageSize ?? true,
    }, this.opts.timeoutMs);
    return readFileSync(dst);
  }
}

/** One page image written by the bridge `pagePng` op (row 151b). `png` is an absolute path inside `dstDir`. */
export interface HtmlPageImage {
  n: number;
  png: string;
  width: number;
  height: number;
  sha256: string;
}

/** Result of {@link rasterizeHtmlPages}: what the verification report's `pages[].png` is filled from. */
export interface HtmlPageImages {
  layout: "paged" | "flow";
  pageCount: number;
  pageSizeMm: { wMm: number; hMm: number };
  pageSizeSource: "css" | "fallback";
  dpi: number;
  pages: HtmlPageImage[];
  /** Swarm row 151c (DEFECT-157-1): why the images only approximate the printed pages (flow layout), else null. */
  approximate?: string | null;
}

function withSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

/** realpath of the deepest existing ancestor plus the not-yet-existing remainder; never throws. */
function realpathBestEffort(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : path.join(realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Swarm patch (row 151b, decision C130 GAP-1, output verification spec §11): page images of a stored HTML
 * render through the bridge `pagePng` op (print media emulated, page size from CSS @page, default 150 dpi,
 * at most 12 pages per call, files `<dstDir>/p001.png` ...). `dstDir` must exist; the bridge applies its path
 * allow-list to `src` and every output. Same semaphore and handshake as every other page operation.
 */
export async function rasterizeHtmlPages(o: {
  src: string;
  dstDir: string;
  pages?: number[];
  dpi?: number;
  widthMm?: number;
  heightMm?: number;
}): Promise<HtmlPageImages> {
  const op = "page-png";
  return withLock(async () => {
    const started = Date.now();
    await ensureBrowser();
    const req: BridgeRequest = { op: "pagePng", src: o.src, dstDir: o.dstDir };
    if (o.pages !== undefined) req.pages = [...o.pages];
    if (o.dpi !== undefined) req.dpi = o.dpi;
    if (o.widthMm !== undefined || o.heightMm !== undefined) Object.assign(req, { widthMm: o.widthMm, heightMm: o.heightMm });
    const r = await bridgeCall(op, req);
    const size = (r.pageSizeMm ?? {}) as { wMm?: unknown; hMm?: unknown };
    const pages = (Array.isArray(r.pages) ? r.pages : []).map((p: Record<string, unknown>) => ({
      n: Number(p.n),
      png: String(p.dst),
      width: Number(p.width),
      height: Number(p.height),
      sha256: String(p.sha256),
    }));
    const out: HtmlPageImages = {
      layout: r.layout === "flow" ? "flow" : "paged",
      pageCount: Number(r.pageCount),
      pageSizeMm: { wMm: Number(size.wMm), hMm: Number(size.hMm) },
      pageSizeSource: r.pageSizeSource === "css" ? "css" : "fallback",
      dpi: Number(r.dpi),
      pages,
    };
    // Swarm row 151c: present only when the bridge says its page images approximate the printed pages.
    if (typeof r.approximate === "string" && r.approximate.length > 0) out.approximate = r.approximate.slice(0, 200);
    // Swarm row 143b (C177, F143-2): the bridge replies resolved paths (checkOutputPath realpaths the parent), so
    // compare resolved paths; a part that does not exist yet is kept as is (best effort).
    const prefix = withSep(realpathBestEffort(o.dstDir));
    const sane =
      Number.isInteger(out.pageCount) &&
      out.pageCount >= 1 &&
      pages.every((p) => Number.isInteger(p.n) && p.n >= 1 && p.n <= out.pageCount && realpathBestEffort(p.png).startsWith(prefix) && /^[0-9a-f]{64}$/.test(p.sha256));
    if (!sane) {
      logBrowser("error", `${op}: render bridge reply is malformed`, { op, code: "BROWSER_UNAVAILABLE" });
      throw new StudioBrowserError("RENDER_FAILED", op, "Render bridge page images reply is malformed (see engine/browser log)");
    }
    logBrowser("info", `${op} done (${pages.length}/${out.pageCount} pages, ${out.layout})`, { op, durationMs: Date.now() - started });
    return out;
  });
}

export interface PageSession {
  page: BridgePage;
  /** Network requests blocked during the operation: the bridge blocks all of them and does not count them. */
  blocked(): number;
}

function timeoutAfter(ms: number, op: string): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new StudioEngineError("RENDER_TIMEOUT", `Browser operation '${op}' exceeded ${ms} ms`, { op, timeoutMs: ms }));
    }, ms);
  });
  return { promise, cancel: () => timer !== undefined && clearTimeout(timer) };
}

/** Run one page operation under the semaphore; the work folder is always removed. */
export async function withSandboxedPage<T>(op: string, opts: PageOptions, fn: (s: PageSession) => Promise<T>): Promise<T> {
  return withLock(async () => {
    const timeoutMs = opts.timeoutMs ?? STUDIO_CHROMIUM_TIMEOUT_MS;
    const started = Date.now();
    await ensureBrowser();
    const workdir = mkdtempSync(path.join(os.tmpdir(), "datum-studio-render-"));
    const t = timeoutAfter(timeoutMs, op);
    try {
      const work = fn({ page: new BridgePage(op, opts, workdir), blocked: () => 0 });
      work.catch(() => undefined);
      const result = await Promise.race([work, t.promise]);
      logBrowser("info", `${op} done`, { op, durationMs: Date.now() - started });
      return result;
    } catch (e) {
      if (e instanceof StudioEngineError) {
        logBrowser("error", e.message, { op, durationMs: Date.now() - started, code: e.code });
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      logBrowser("error", `${op} failed: ${msg}`, { op, durationMs: Date.now() - started });
      throw new StudioBrowserError("RENDER_FAILED", op, `Browser operation '${op}' failed (see engine/browser log)`, { cause: e });
    } finally {
      t.cancel();
      rmSync(workdir, { recursive: true, force: true });
    }
  });
}

/** Clean shutdown: wait for the running operation, then drop the handshake. Idempotent. */
export async function shutdownBrowser(): Promise<void> {
  await withLock(
    async () => {
      const s = state();
      if (s.launching) {
        try {
          await s.launching;
        } catch {
          // Handshake failure was already logged.
        }
      }
      const b = s.browser;
      s.browser = null;
      if (b) await b.close();
    },
    { unbounded: true },
  );
}
