// Row 143a (C177, F143-1) test kit: compose the row 55b adapted Rev A material (copied byte for byte from
// /private/tmp/claude-501/row143/adapted/, sha256 in fixtures/SHA256SUMS; the frozen material is never read here) with
// the vendored v2 compose path (composeV2, DATUM skeleton) and render it in process to HTML and DOCX with the
// canonical profile. Same seams as test/verify-fidelity/row153-fidelity.test.ts: no store, no browser, no network,
// no model.
import { readFileSync } from "node:fs"
import path from "node:path"
import { strFromU8, unzipSync } from "fflate"
import { useStudioEnv } from "../../ported/_env"
import type { NormDocSnapshot, ResolvedTemplate } from "../../../vendor/src/lib/studio/contract"

useStudioEnv()
const K = await import("../../ported/renderers/_kit")
const S = await import("../../ported/structure/_kit")
const { composeV2 } = await import("../../../vendor/src/lib/studio/services/compose")
const { assembleDocxDetailed } = await import("../../../vendor/src/lib/studio/engine/docx/assemble")
const { assembleHtml } = await import("../../../vendor/src/lib/studio/engine/html/assemble")

export const FIXTURES = path.join(import.meta.dir, "fixtures")
export type CaseName = "case01.json" | "case05.json" | "bfix-datum-kanonik-ID.studio.json"

export function loadCase(name: CaseName): Record<string, any> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"))
}

/** Compose a v2 submission as the host does for chapter submits (DATUM slots). */
export function compose(doc: Record<string, any>): NormDocSnapshot {
  const slots = S.datumSlots()
  // The material names the store template (datum-kanonik); the in-memory skeleton is the DATUM one, so the pin is dropped.
  const { template: _t, agentId: _a, ...sub } = doc
  return composeV2({ source: S.merge(sub, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams() }).snapshot as unknown as NormDocSnapshot
}

let tplCache: ResolvedTemplate | undefined
export async function template(): Promise<ResolvedTemplate> {
  tplCache ??= await K.canonicalTemplate()
  return tplCache
}

export async function renderHtml(snap: NormDocSnapshot): Promise<string> {
  return assembleHtml(K.makeCtx(snap, await template()).ctx, { preview: false })
}

export async function renderDocx(snap: NormDocSnapshot): Promise<Uint8Array> {
  return (await assembleDocxDetailed(K.makeCtx(snap, await template()).ctx)).bytes
}

export function docXml(docx: Uint8Array): string {
  return strFromU8(unzipSync(docx)["word/document.xml"])
}

/** Walk a JSON tree and return every object whose `type` is `type`, with its JSON pointer. */
export function blocksOfType(doc: unknown, type: string): Array<{ pointer: string; block: Record<string, any> }> {
  const out: Array<{ pointer: string; block: Record<string, any> }> = []
  const walk = (o: unknown, p: string) => {
    if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${p}/${i}`))
    else if (o && typeof o === "object") {
      const r = o as Record<string, any>
      if (r.type === type) out.push({ pointer: p, block: r })
      for (const [k, v] of Object.entries(r)) walk(v, `${p}/${k}`)
    }
  }
  walk(doc, "")
  return out
}
