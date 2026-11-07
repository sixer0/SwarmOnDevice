/**
 * Bahasa dokumen contoh pratinjau (addendum USER 2026-11-05: templat EN tidak boleh menampilkan contoh berbahasa
 * Indonesia). Dibaca dari DATA templat: parameter `doc.language` (kenop esensial EK-G06). Nilai draf yang sedang
 * disunting menang (lapis terakhir menang), lalu nilai versi templat terresolusi, lalu ID (bawaan registri).
 *
 * Murni: aman diimpor komponen klien.
 */
import type { ParamValue } from "@/lib/studio/contract/types/common";

export type PreviewLanguage = "ID" | "EN";

/** Kunci parameter bahasa dokumen (registri P3-23). */
export const PARAM_DOC_LANGUAGE = "doc.language";

const asLanguage = (v: ParamValue | undefined): PreviewLanguage | undefined => (v === "ID" || v === "EN" ? v : undefined);

/** Bahasa contoh: lapis draf (urut naik prioritas), lalu nilai terresolusi, lalu ID. */
export function previewLanguageOf(
  draftLayers: ReadonlyArray<Readonly<Record<string, ParamValue>> | undefined>,
  resolved: ParamValue | undefined,
): PreviewLanguage {
  for (let i = draftLayers.length - 1; i >= 0; i -= 1) {
    const layer = draftLayers[i];
    if (layer && Object.prototype.hasOwnProperty.call(layer, PARAM_DOC_LANGUAGE)) {
      const v = asLanguage(layer[PARAM_DOC_LANGUAGE]);
      if (v) return v;
    }
  }
  return asLanguage(resolved) ?? "ID";
}
