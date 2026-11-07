// Row 165A test kit (wave 165, F56-1 / F113-3..7): the row 143a adapted Rev A material (case 01 / case 05, copied
// fixtures of test/engine-rev-a/row143a) rendered in process to HTML and DOCX with the canonical profile plus the
// built-in datum-kanonik template's `advanced` overrides (templates/datum-kanonik.json, the template the row 143c
// app run used). No store, no browser, no network, no model.
import { readFileSync } from "node:fs"
import path from "node:path"
import type { NormDocSnapshot, ResolvedTemplate } from "../../../vendor/src/lib/studio/contract"

const K = await import("../row143a/_kit")
const R = await import("../../ported/renderers/_kit")
const { scanCanonicalAssets, resolveRepoAssetPath } = await import("../../../vendor/src/lib/studio/services/templates/assets")
const { DATUM_CANONICAL_SLUG, resolveProfileInMemory } = await import("../../../vendor/src/lib/studio/services/templates/profile")
const { assembleDocxDetailed } = await import("../../../vendor/src/lib/studio/engine/docx/assemble")
const { assembleHtml } = await import("../../../vendor/src/lib/studio/engine/html/assemble")

export const PKG = path.resolve(import.meta.dir, "..", "..", "..")
const VENDOR = path.join(PKG, "vendor")
export const KANONIK = JSON.parse(readFileSync(path.join(PKG, "templates", "datum-kanonik.json"), "utf8")) as { advanced: Record<string, unknown> }

export const loadCase = K.loadCase
export const compose = K.compose
export const docXml = K.docXml

let tplCache: ResolvedTemplate | undefined
export async function kanonikTemplate(): Promise<ResolvedTemplate> {
  if (tplCache) return tplCache
  const ca = await scanCanonicalAssets(VENDOR)
  tplCache = resolveProfileInMemory(
    { base: DATUM_CANONICAL_SLUG, slug: DATUM_CANONICAL_SLUG, kind: "DOCUMENT", overrides: { ...KANONIK.advanced } } as never,
    { canonicalAssets: ca, resolveAssetPath: (rel: string) => resolveRepoAssetPath(rel, VENDOR) },
  )
  return tplCache
}

export async function renderHtml(snap: NormDocSnapshot): Promise<string> {
  return assembleHtml(R.makeCtx(snap, await kanonikTemplate()).ctx, { preview: false })
}
export async function renderDocx(snap: NormDocSnapshot): Promise<Uint8Array> {
  return (await assembleDocxDetailed(R.makeCtx(snap, await kanonikTemplate()).ctx)).bytes
}

/** Inner HTML of the first `<section ... data-unit="<kind>">` unit (up to the next unit). */
export function unitHtml(html: string, kind: string): string {
  const at = html.indexOf(`data-unit="${kind}"`)
  if (at < 0) return ""
  const next = html.indexOf('<section class="st-unit', at)
  return html.slice(at, next < 0 ? undefined : next)
}

/** Plain text (tags dropped, the entities used here decoded, whitespace collapsed). */
export function text(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .trim()
}
