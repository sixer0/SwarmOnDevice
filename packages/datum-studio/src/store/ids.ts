import { createHash, randomBytes } from "node:crypto"

const B36 = "0123456789abcdefghijklmnopqrstuvwxyz"

/**
 * cuid-shaped id: "c" + 24 lowercase base36 chars (25 chars), so Studio's
 * DOCUMENT_ID_PATTERN `^[a-z0-9]{20,40}$` holds (spec §3.1). Random, from crypto.randomBytes.
 */
export function newId(): string {
  const bytes = randomBytes(24)
  let s = "c"
  for (const b of bytes) s += B36[b % 36]
  return s
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex")
}

/** JSON with object keys sorted (default for sha fields the caller did not pass). */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k])
    return out
  }
  return v
}

/** C52 FINAL_DOC_NUMBER_MAX (clone contract/env.ts:181). */
export const FINAL_DOC_NUMBER_MAX = 80

/**
 * I61 `docNumberSafe`, same steps as vendor `services/render/final-name.ts:30-35`
 * (parity pinned by store.test.ts under bun). Replaces Studio's `docNumberSafeSql` regexp_replace.
 */
export function docNumberSafe(docNumber: string): string {
  const folded = String(docNumber).replace(/[^A-Za-z0-9.-]+/g, "-").replace(/-{2,}/g, "-")
  const trimmed = folded.replace(/^[-.]+/, "").replace(/[-.]+$/, "")
  const cut = trimmed.slice(0, FINAL_DOC_NUMBER_MAX).replace(/[-.]+$/, "")
  return cut === "" ? "DOC" : cut
}
