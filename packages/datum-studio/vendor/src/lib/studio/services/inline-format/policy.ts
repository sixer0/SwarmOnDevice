/**
 * Kebijakan `ingest.inlineFormat` templat (R-38, D-138, D-253): modul DAUN tanpa
 * dependensi layanan (hanya tipe kontrak), dipakai ingest v1 teradaptasi
 * (`ingest/v2.ts`) dan render override dokumen (`render/common.ts`). Render tidak
 * lagi mengimpor modul ingest v2 hanya demi pengurai ini (SR-55b N5, FIX-S2).
 *
 * `effectiveInlinePolicy` (penurunan "allow" untuk pemanggil tidak tepercaya) tetap
 * milik adaptor SR-09 (`services/adapt-v1`).
 */
import type { InlineFormatPolicy, ParamMap } from "../../contract";

/** Kunci parameter templat kebijakan format inline. */
export const INLINE_FORMAT_PARAM_KEY = "ingest.inlineFormat";

/** "reject" | "allow" sesuai parameter templat; nilai lain atau absen = "strip" (bawaan). */
export function inlineFormatPolicyOf(params: ParamMap): InlineFormatPolicy {
  const raw = params[INLINE_FORMAT_PARAM_KEY];
  return raw === "reject" || raw === "allow" ? raw : "strip";
}
