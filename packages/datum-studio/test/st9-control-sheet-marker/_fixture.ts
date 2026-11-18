// Swarm 1.3.3 row 63 (ST-9 item 2): shared fixture of the control sheet marker test and of its baseline.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { readFileSync } from "node:fs"
import path from "node:path"

type J = Record<string, any>
const S = await import("../ported/structure/_kit")
const { composeV2 } = await import("../../vendor/src/lib/studio/services/compose")
const FLOW = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram", "dg_flow.json"), "utf8")) as J
const t = (text: string) => ({ text })

export type Variant = { flags: Array<boolean | undefined>; methodStatement: boolean; language?: "EN" }

const diagram = (flag: boolean | undefined, n: number): J => ({
  type: "diagram",
  caption: t(`Alur uji ${n}.`),
  source: t("Sumber sintetis uji."),
  spec: { family: FLOW.family, ...(flag === undefined ? {} : { labels_verified: flag }), nodes: FLOW.nodes, edges: FLOW.edges, legend: FLOW.legend },
})

/** Composed control sheet front page (`snapshot.doc.front.controlSheet`) of the E1 document with one diagram per flag. */
export function controlSheetOf(v: Variant): J {
  const doc = S.e1()
  if (!v.methodStatement) delete doc.sections.controlSheet.methodStatement
  if (v.language) doc.meta.language = v.language
  doc.sections.content.chapters[0].sections[0].blocks = [{ type: "paragraph", text: "Paragraf sintetis." }, ...v.flags.map(diagram)]
  const slots = S.datumSlots()
  const { template: _t, ...sub } = doc
  const snap = composeV2({ source: S.merge(sub, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams(), assets: {} }).snapshot as J
  return snap.doc.front.controlSheet
}
