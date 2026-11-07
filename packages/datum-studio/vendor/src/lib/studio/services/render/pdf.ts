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
    buf = await withSandboxedPage("printPdf", { viewport, timeoutMs: opts.timeoutMs }, async ({ page }) => {
      await page.setContent(html, { waitUntil: "load" });
      return page.pdf({ width: `${widthMm}mm`, height: `${heightMm}mm`, preferCSSPageSize: true, printBackground: true });
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
