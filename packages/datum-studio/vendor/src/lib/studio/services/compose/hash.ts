/**
 * Sha lingkup (KD-13) dan pembuang id pid (SR-08, I45 `scopeSha256`, `stripIds`).
 *
 * Hanya medan `id` milik PEMEGANG pid yang dibuang: bab, section, dan blok isi
 * (elemen larik `chapters`, `sections`, `blocks`, `intro`). Medan `id` lain
 * adalah isi dan tetap ikut hash: `PartV2.id` ("P1"), entri register sumber
 * (`entries[].id`), simpul chart/diagram (`nodes[].id`).
 */
import { CONTENT_BLOCK_TYPES } from "../../contract";
import { sha256Hex, stableStringify } from "../ingest/util";

export { sha256Hex, stableStringify };

const BLOCK_TYPES: ReadonlySet<string> = new Set<string>(CONTENT_BLOCK_TYPES);
/** Larik yang elemennya pemegang pid. */
const HOLDER_ARRAYS: ReadonlySet<string> = new Set(["chapters", "sections", "blocks", "intro"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Pemegang pid berdiri sendiri: bab (`key` + `sections`), section (`title` + `blocks`), blok isi. */
function looksLikeHolder(v: Record<string, unknown>): boolean {
  if (typeof v.key === "string" && Array.isArray(v.sections)) return true;
  if (Array.isArray(v.blocks) && "title" in v) return true;
  return typeof v.type === "string" && BLOCK_TYPES.has(v.type);
}

function strip(node: unknown, holder: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => strip(n, false));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (holder && k === "id") continue;
    if (HOLDER_ARRAYS.has(k) && Array.isArray(v)) out[k] = v.map((e) => strip(e, isRecord(e)));
    else out[k] = strip(v, false);
  }
  return out;
}

/** Salinan tanpa `id` pemegang pid (bab, section, blok) di mana pun di dalam `x`. */
export function stripIds<T>(x: T): T {
  return strip(x, isRecord(x) && looksLikeHolder(x)) as T;
}

/** `sha256Hex(stableStringify(stripIds(x)))`; `undefined`/null = sha "null". */
export function scopeSha256(x: unknown): string {
  return sha256Hex(stableStringify(x === undefined ? null : stripIds(x)));
}
