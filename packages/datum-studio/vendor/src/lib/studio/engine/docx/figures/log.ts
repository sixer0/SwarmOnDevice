/**
 * Jalur galat modul figur DOCX (S19). Setiap kegagalan ditulis lebih dulu ke
 * `ctx.log` (sink log render yang dipersistenkan layanan render S51 ke
 * StudioRenderJob/log berkas), baru kemudian dilempar sebagai
 * `StudioEngineError` berkode kontrak. Peringatan (mis. dpi efektif rendah)
 * hanya dicatat, tidak menghentikan render; lint S44/S45 yang memutuskan.
 */
import type { RenderContext, StudioErrorCode } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";

export const FIGURES_MODULE = "engine/docx/figures";

export function failRender(
  ctx: Pick<RenderContext, "log" | "fixedDate">,
  code: StudioErrorCode,
  message: string,
  address?: string,
  details?: unknown,
): never {
  const msg = `${FIGURES_MODULE}: ${message}`;
  ctx.log({ level: "error", message: msg, code, address: address ?? undefined, at: ctx.fixedDate });
  throw new StudioEngineError(code, msg, details);
}

export function warnRender(
  ctx: Pick<RenderContext, "log" | "fixedDate">,
  code: StudioErrorCode | string,
  message: string,
  address?: string,
): void {
  ctx.log({ level: "warn", message: `${FIGURES_MODULE}: ${message}`, code, address: address ?? undefined, at: ctx.fixedDate });
}

/**
 * Swarm 1.2.6 (row 68, T-15, register N-036): penanda figur yang gagal disiapkan (`prepareFigureStore`). Satu figur
 * yang gagal tidak lagi menggagalkan perakitan DOCX: entri FigureStore berpenanda ini (tanpa svg/png) dirender
 * sebagai placeholder yang terlihat (`figure.ts`), dan verifikasi yang sudah ada (FIGURE_PLACEHOLDER pada HTML
 * sejob, PLACEHOLDER_IN_OUTPUT pada DOCX) membuat keluaran itu UNVERIFIED.
 */
export const FIGURE_PREPARE_FAILED = "FIGURE_PREPARE_FAILED" as const;

export interface FigurePrepareFailure {
  code: typeof FIGURE_PREPARE_FAILED;
  message: string;
  /** Kode galat asal (StudioEngineError.code) bila ada. */
  causeCode?: string;
}

/** Penanda kegagalan pada entri FigureStore (kontrak `FigureStore.get` tidak memuat medan ini; dibaca struktural). */
export function figurePrepareFailureOf(entry: unknown): FigurePrepareFailure | undefined {
  const f = entry && typeof entry === "object" ? (entry as { failed?: unknown }).failed : undefined;
  if (!f || typeof f !== "object") return undefined;
  const r = f as { code?: unknown; message?: unknown };
  return r.code === FIGURE_PREPARE_FAILED && typeof r.message === "string" ? (f as FigurePrepareFailure) : undefined;
}
