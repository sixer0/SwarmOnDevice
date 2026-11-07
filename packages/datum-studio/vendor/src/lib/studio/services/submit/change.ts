/**
 * Lingkup perubahan dan `change` otomatis (register 03 §9.5; KC-2 butir a,
 * D-06): kiriman agen tanpa `change` diisi otomatis (`changeAuto = true`).
 *
 * changeScope = scope *( ";" scope )
 * scope       = "create" | "document" | "chapter:" key | "slot:" slotKey | "pid:" pid
 *             | "address:" address | "structure:" op | "meta" | "register:" regKey | "rebase"
 */
import type { ChangeV2 } from "../../contract";

/** Batas panjang teks change otomatis (kolom Text; dijaga agar log tetap ringkas). */
export const AUTO_CHANGE_MAX_CHARS = 2000;

export function chapterScope(key: string): string {
  return `chapter:${key}`;
}

export function slotScope(slotKey: string): string {
  return `slot:${slotKey}`;
}

/** Gabung lingkup (urutan masukan dipertahankan, duplikat dibuang). */
export function joinScopes(scopes: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scopes) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.join(";");
}

/** Lingkup tampilan untuk teks change: "bab 3", "slot controlSheet", ... */
function scopePhrase(primary: string): string {
  if (primary.startsWith("chapter:")) return `bab ${primary.slice("chapter:".length)}`;
  if (primary.startsWith("slot:")) return `slot ${primary.slice("slot:".length)}`;
  if (primary === "create") return "pembuatan dokumen";
  if (primary === "document") return "dokumen";
  return primary;
}

/**
 * `change` efektif: milik pemanggil bila ada, selain itu otomatis
 * `what = "Kiriman {scope} oleh {agentId atau requester}"`, `why = "Kiriman agen (otomatis)"`,
 * `impact = "{changeScope}"` (register §9.5).
 */
export function effectiveChange(
  sent: ChangeV2 | undefined,
  primaryScope: string,
  changeScope: string,
  by: string,
): { change: ChangeV2; changeAuto: boolean } {
  if (sent && sent.what && sent.why && sent.impact) return { change: sent, changeAuto: false };
  const clip = (s: string) => (s.length > AUTO_CHANGE_MAX_CHARS ? s.slice(0, AUTO_CHANGE_MAX_CHARS) : s);
  return {
    change: {
      what: clip(`Kiriman ${scopePhrase(primaryScope)} oleh ${by}`),
      why: "Kiriman agen (otomatis)",
      impact: clip(changeScope),
    },
    changeAuto: true,
  };
}
