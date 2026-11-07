/**
 * Swarm PATCH (row 32, studio spec §4, decision D-15 reversed): Studio prints its PDF from its own
 * HTML (`assembleHtml`) through the Swarm render bridge `pdf` op (Electron main, row 24:
 * Page.printToPDF with `preferCSSPageSize`, so the HTML's `@page` rules decide the sheet).
 *
 * The original made PDF only as DOCX -> LibreOffice (D-15/KT-17, render.ts:407 of the clone). Swarm
 * ships no LibreOffice, and Claude's DATUM skill (the control) prints PDF with Chromium as well.
 *
 * Transport: `withSandboxedPage` of engine/browser/runtime.ts (row 108 twin). It handshakes the
 * bridge (`hello`: sandboxed, context-isolated, Node-free, offline render window, else refused),
 * serialises page operations (semaphore 1, bounded queue), applies the per-operation timeout, writes
 * the HTML to a private work folder, sends `{op:"pdf", src:.html, dst:.pdf, widthMm, heightMm,
 * preferCSSPageSize:true}` and removes the folder afterwards.
 *
 * Errors (contract codes, contract/enums.ts): bridge absent or not locked down ->
 * PDF_ENGINE_UNAVAILABLE; RENDER_TIMEOUT / RENDER_QUEUE_FULL kept; every other failure, and a reply
 * that is not a PDF with at least one page -> PDF_CONVERT_FAILED. Messages never carry raw bridge
 * text (runtime.ts keeps that in the engine/browser log).
 */
import { StudioEngineError } from "../../contract/errors";
import { STUDIO_CHROMIUM_TIMEOUT_MS } from "../../contract/env";
import { StudioBrowserError, withSandboxedPage } from "../../engine/browser/runtime";

/** Bridge input cap for a `src` file (desktop/src/main/datum-render/protocol.ts:11, MAX_INPUT_BYTES). */
export const PDF_BRIDGE_MAX_HTML_BYTES = 16 * 1024 * 1024;
/** Fallback sheet when the caller gives none; `@page` of the HTML wins (preferCSSPageSize). */
export const PDF_DEFAULT_PAGE_MM = { widthMm: 210, heightMm: 297 } as const;
const PX_PER_MM = 96 / 25.4;

export interface HtmlPdfOptions {
  /** Job id (log correlation only). */
  jobId: string;
  /** Fallback paper size in mm (template `pageSizeMm`); the HTML `@page` size wins. */
  widthMm?: number;
  heightMm?: number;
  /** Per-operation timeout (default STUDIO_CHROMIUM_TIMEOUT_MS of runtime.ts). */
  timeoutMs?: number;
}

export interface HtmlPdfResult {
  pdf: Uint8Array;
  /** Pages in the printed PDF (`countPdfPages`). */
  pageCount: number;
  durationMs: number;
}

/**
 * Page count of a PDF: the largest `/Type /Pages ... /Count n` (page tree root), else the number of
 * `/Type /Page` objects. Same rule as engine/browser/index.ts `countPdfPages` (not exported there).
 */
export function countPdfPages(pdf: Uint8Array): number {
  const s = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString("latin1");
  let max = 0;
  for (const m of s.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) {
    max = Math.max(max, Number(m[1] ?? m[2]));
  }
  if (max > 0) return max;
  return (s.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

// ── Wave 165 row 165A (F113-3, F113-6): sheet totals filled after pagination ───────────────────────────────────
const NUMBERED_PASS_OFF = '<style data-studio="pdf-numbered-pass" media="not all">';
const NUMBERED_PASS_ON = '<style data-studio="pdf-numbered-pass" media="all">';
/** engine/html/base/shell.ts SHEET_TOTAL_MARK around the register `counter(pages)`. */
const SHEET_TOTAL_RE = /\/\*st-N\*\/counter\(pages\)\/\*\/st-N\*\//g;
/** engine/html/blocks/classes.ts: the HALAMAN NUMPAGES span of a cover control value reads `--st-pages-total`. */
const PAGES_FIELD_RE = /<td class="st-control-value[^"]*"[^>]*><span class="st-field[^"]*"[^>]*data-field="NUMPAGES"/;

/** Which totals the HTML asks for: `pages` (a HALAMAN field) and `numbered` (register N from Bab 1). */
export function sheetTotalPlan(html: string): { pages: boolean; numbered: boolean } {
  return { pages: PAGES_FIELD_RE.test(html), numbered: html.includes(NUMBERED_PASS_OFF) && html.includes("/*st-N*/counter(pages)/*/st-N*/") };
}

/** The HTML of the final print: register N = `numbered`, HALAMAN = `total` (CSS strings; no markup is added to the body). */
export function withSheetTotals(html: string, total: number, numbered: number): string {
  const out = numbered > 0 ? html.replace(SHEET_TOTAL_RE, `"${numbered}"`) : html;
  const style = `<style data-studio="pdf-sheet-totals">:root{--st-pages-total:"${total}"}</style>\n`;
  const at = out.indexOf("</head>");
  return at < 0 ? out : `${out.slice(0, at)}${style}${out.slice(at)}`;
}

/** Units hidden by the numbered pass (one sheet each in the estimate). */
function numberedPassHiddenUnits(html: string): number {
  const at = html.indexOf(NUMBERED_PASS_OFF);
  if (at < 0) return 0;
  const css = html.slice(at, html.indexOf("</style>", at));
  return (css.match(/\.st-unit\[data-unit-key=/g) ?? []).length;
}

/** Flow units of the document (one sheet each in the estimate). */
function unitCount(html: string): number {
  return Math.max(1, (html.match(/<section class="st-unit\b/g) ?? []).length);
}

function pdfPagesOf(b: Buffer): number {
  const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return Buffer.from(u.subarray(0, 5)).toString("latin1") === "%PDF-" ? countPdfPages(u) : 0;
}

function validMm(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 5000 ? v : fallback;
}

/** Print Studio HTML to PDF through the render bridge `pdf` op. Throws StudioEngineError (see header). */
export async function printHtmlToPdf(html: string, opts: HtmlPdfOptions): Promise<HtmlPdfResult> {
  const t0 = Date.now();
  if (typeof html !== "string" || html.length === 0) {
    throw new StudioEngineError("PDF_CONVERT_FAILED", "pdf print needs a non-empty HTML document", { jobId: opts.jobId });
  }
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > PDF_BRIDGE_MAX_HTML_BYTES) {
    throw new StudioEngineError("PDF_CONVERT_FAILED", `HTML is ${bytes} bytes, above the render bridge input cap of ${PDF_BRIDGE_MAX_HTML_BYTES} bytes`, {
      jobId: opts.jobId,
      bytes,
      maxBytes: PDF_BRIDGE_MAX_HTML_BYTES,
    });
  }
  const widthMm = validMm(opts.widthMm, PDF_DEFAULT_PAGE_MM.widthMm);
  const heightMm = validMm(opts.heightMm, PDF_DEFAULT_PAGE_MM.heightMm);
  const viewport = { width: Math.ceil(widthMm * PX_PER_MM), height: Math.ceil(heightMm * PX_PER_MM) };

  let buf: Buffer;
  try {
    // Wave 165 row 165A: one session for every pass, so the per-operation timeout covers each print (at most 3).
    const plan = sheetTotalPlan(html);
    const timeoutMs = !plan.pages && !plan.numbered ? opts.timeoutMs : (opts.timeoutMs ?? STUDIO_CHROMIUM_TIMEOUT_MS) * 3;
    buf = await withSandboxedPage("printPdf", { viewport, timeoutMs }, async ({ page }) => {
      const print = async (h: string) => {
        await page.setContent(h, { waitUntil: "load" });
        return page.pdf({ width: `${widthMm}mm`, height: `${heightMm}mm`, preferCSSPageSize: true, printBackground: true });
      };
      // Wave 165 row 165A (C188 F113-3/F113-6): sheet totals that only pagination knows, with as few prints as the
      // document allows. N (register "DARI N", ID p.48) = pages of a print with the units before Bab 1 hidden. T (the
      // HALAMAN value = DOCX NUMPAGES) is first estimated (N + one sheet per hidden unit, else one sheet per unit) and
      // checked against the final print's page count: digits in a margin box or a table cell do not move the page
      // breaks, so a wrong estimate costs exactly one reprint. Typical TERBIT document: 2 prints (was 1); a document
      // with neither marker prints once, byte-for-byte as before.
      if (!plan.pages && !plan.numbered) return print(html);
      const numbered = plan.numbered ? pdfPagesOf(await print(html.replace(NUMBERED_PASS_OFF, NUMBERED_PASS_ON))) : 0;
      const guess = plan.numbered ? numbered + numberedPassHiddenUnits(html) : unitCount(html);
      const final = await print(withSheetTotals(html, guess, numbered));
      const total = pdfPagesOf(final);
      if (!plan.pages || total === guess || total < 1) return final;
      return print(withSheetTotals(html, total, numbered));
    });
  } catch (err) {
    if (err instanceof StudioBrowserError && (err.reason === "LAUNCH_FAILED" || err.reason === "SANDBOX_UNAVAILABLE")) {
      throw new StudioEngineError("PDF_ENGINE_UNAVAILABLE", "render bridge unavailable for PDF (is the Swarm app running? see engine/browser log)", {
        jobId: opts.jobId,
        reason: err.reason,
      });
    }
    if (err instanceof StudioEngineError && (err.code === "RENDER_TIMEOUT" || err.code === "RENDER_QUEUE_FULL")) throw err;
    const reason = err instanceof StudioBrowserError ? err.reason : undefined;
    const e = new StudioEngineError("PDF_CONVERT_FAILED", "render bridge could not print the PDF (see engine/browser log)", {
      jobId: opts.jobId,
      ...(reason ? { reason } : {}),
    });
    (e as { cause?: unknown }).cause = err;
    throw e;
  }

  const pdf = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const head = Buffer.from(pdf.subarray(0, 5)).toString("latin1");
  const pageCount = head === "%PDF-" ? countPdfPages(pdf) : 0;
  if (pageCount < 1) {
    throw new StudioEngineError("PDF_CONVERT_FAILED", "render bridge reply is not a PDF with at least one page", { jobId: opts.jobId, bytes: pdf.length });
  }
  return { pdf, pageCount, durationMs: Date.now() - t0 };
}
