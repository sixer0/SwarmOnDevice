/**
 * Pembantu meta ingest v2 (SR-12; register 03_structural_sections_specs.md §7.2).
 *
 * Kelengkapan medan `DocMeta` dari parameter templat memakai SATU sumber:
 * `defaultMeta` layanan compose (SR-08). Modul ini menyediakan masukan yang
 * dibutuhkan sebelum compose: tier efektif (penentu slot aktif kerangka), tanggal
 * terbit revisi 1 (zona Asia/Jakarta), dan seam CLI `resolveMetaDefaults`
 * (pembungkus `defaultMeta`). Murni, tanpa DB.
 */
import type { DocMeta, DocMetaV2, ParamMap, StudioTier } from "../../contract";
import { defaultMeta } from "../compose";
import { jakartaDate } from "../submit/meta";

/** Zona tanggal terbit revisi 1 (§7.2). */
export const ISSUE_DATE_TIME_ZONE = "Asia/Jakarta";

const TIERS: readonly StudioTier[] = ["NOTA", "TERBIT", "SERAH"];

/** Tanggal `YYYY-MM-DD` di zona Asia/Jakarta (SR-55 M7: satu pemilik, `submit/meta`). */
export { jakartaDate } from "../submit/meta";

/** Tier efektif: `meta.tier` atau parameter `doc.defaultTier` (R-49), bawaan TERBIT. */
export function effectiveTier(meta: DocMetaV2 | undefined, params: ParamMap): StudioTier {
  if (meta?.tier && TIERS.includes(meta.tier)) return meta.tier;
  const p = params["doc.defaultTier"];
  return typeof p === "string" && (TIERS as readonly string[]).includes(p) ? (p as StudioTier) : "TERBIT";
}

/** Medan `DocMeta` yang dapat diisi bawaan (§7.2). */
const DEFAULTED_FIELDS = ["rev", "typeCode", "tier", "classification", "language", "author", "issueDate"] as const;

export interface MetaDefaultsContext {
  params: ParamMap;
  /** `agentId` kiriman; bila absen dipakai `requester` sebagai `author`. */
  agentId?: string;
  requester: string;
  /** Tanggal terbit bila `meta.issueDate` absen; bawaan hari ini (Asia/Jakarta). */
  today?: string;
}

/**
 * Seam CLI render v2 (SR-33, `scripts/parity/run/lib/render.ts`): lengkapi
 * `DocMetaV2` menjadi `DocMeta` lewat SATU sumber `defaultMeta` compose (SR-08).
 * `filled` = medan yang diisi dari bawaan. `title` kosong tidak dilempar di sini
 * (pemanggil: 400 `META_REQUIRED_FOR_CREATE`).
 */
export function resolveMetaDefaults(meta: DocMetaV2 | undefined, ctx: MetaDefaultsContext): { meta: DocMeta; filled: string[] } {
  const sent: DocMetaV2 = meta ?? {};
  const author = ctx.agentId && ctx.agentId.trim() !== "" ? ctx.agentId : ctx.requester;
  const out = defaultMeta({ ...sent, title: sent.title ?? "" }, ctx.params, { author, issueDate: ctx.today ?? jakartaDate() });
  const filled = DEFAULTED_FIELDS.filter((k) => sent[k] === undefined || sent[k] === null || sent[k] === "");
  return { meta: out, filled: [...filled] };
}
