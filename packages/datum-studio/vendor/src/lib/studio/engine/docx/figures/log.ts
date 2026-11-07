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
