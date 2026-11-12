/**
 * Row 178 (gateway_check/16_row177_split_builders_ab.md): the diagram block guide an agent reads before
 * `studio_figure_preview` / a chapter with a `diagram` block, served as the MCP resource DIAGRAM_GUIDE_URI
 * (mcp-server.ts). In the row 177 runs agents were refused 9-26 times per run guessing node, class and edge fields.
 *
 * Every field list and enum is read from the v2 block schema (common/v2 `$defs.DiagramV2` / `DiagramSpecV2`), never
 * typed here, so the guide cannot drift from what Studio validates; the row 178 test checks the enums against the
 * schema and validates and renders the example.
 *
 * Swarm 1.2.6 row 97 (G-01, W-01, W-02, W-14, T-11): the working norms, each stated once against the fixed tool. Every
 * number comes from an engine constant (caption limit, edge inset, fan-out split, ranked-flow capacities). Pinned by
 * test/g01-diagram-guide/row97-diagram-guide.test.ts.
 *
 * Fix row FX-10 (gate 04 F6/F7/F9; C19a, C19b): the figure-gate sentence is the one shared with the five other gate
 * texts; label limits are the engine hints (~20 / ~40, build/autofit.ts and fitlabels.ts); the defect list is read
 * from PREVIEW_ISSUE_CLASS. Pinned by test/fx10/fx10-figure-gate-wording.test.ts.
 */
import { commonV2Schema } from "@/lib/studio/contract/schema/v2/common.schema"
import { DIAGRAM_GUIDE_URI } from "@/lib/studio/contract/schema/v2/refusal-hints"
import { CAPTION_GUIDE_MAX_CHARS } from "@/lib/studio/contract/schema/figure-bounds"
import { GRAPH_EDGE_INSET_MM } from "@/lib/studio/engine/diagram/core/sheet"
import { LATTICE_X } from "@/lib/studio/engine/diagram/core/tokens"
import { FLOW_LR_MAX_PARALLEL, flowLrMaxRanks, flowTbMaxPerRank } from "@/lib/studio/engine/diagram/layout-a/flow"
import { FANOUT_SPLIT_MIN } from "@/lib/studio/engine/diagram/build/route"
import { PREVIEW_ISSUE_CLASS } from "./local-api/routes/figure-preview-figure"

export { DIAGRAM_GUIDE_URI }
export const DIAGRAM_GUIDE_NAME = "skema-diagram"

type S = Record<string, any>
const defs = (commonV2Schema as S).$defs as S

export interface DiagramGuideFacts {
  blockFields: string[]
  blockRequired: string[]
  specFields: string[]
  specRequired: string[]
  nodeFields: string[]
  nodeRequired: string[]
  classFields: string[]
  edgeFields: string[]
  edgeRequired: string[]
  zoneFields: string[]
  zoneRequired: string[]
  families: string[]
  shapes: string[]
  marks: string[]
  edgeKinds: string[]
}

const names = (o: S): string[] => Object.entries(o.properties ?? {}).filter(([, v]) => !((v as S)?.not && Object.keys((v as S).not).length === 0)).map(([k]) => k)

export function diagramGuideFacts(): DiagramGuideFacts {
  const block = defs.DiagramV2 as S
  const spec = defs.DiagramSpecV2 as S
  const node = spec.properties.nodes.items as S
  const edge = spec.properties.edges.items as S
  const zone = spec.properties.zones.items as S
  return {
    blockFields: names(block),
    blockRequired: block.required as string[],
    specFields: names(spec),
    specRequired: spec.required as string[],
    nodeFields: names(node),
    nodeRequired: node.required as string[],
    classFields: names(node.properties.class),
    edgeFields: names(edge),
    edgeRequired: edge.required as string[],
    zoneFields: names(zone),
    zoneRequired: zone.required as string[],
    families: spec.properties.family.enum as string[],
    shapes: node.properties.shape.enum as string[],
    marks: node.properties.mark.enum as string[],
    edgeKinds: edge.properties.kind.enum as string[],
  }
}

/** Minimal valid diagram block (validated and rendered by the row 178 test). */
export const DIAGRAM_GUIDE_EXAMPLE = {
  type: "diagram",
  caption: { text: "Arsitektur pemantauan iklim ruang arsip." },
  source: { text: "SUMBER: data proyek. PROVENANS: TERUKUR" },
  spec: {
    family: "layered",
    nodes: [
      { id: "s1", label: "Sensor R1-R2", class: { tier: 0 } },
      { id: "g1", label: "Gerbang Data A", class: { tier: 1 } },
      { id: "srv", label: "Server Pemantauan", class: { tier: 2 } },
    ],
    edges: [
      { from: "s1", to: "g1", kind: "data", label: "RS-485" },
      { from: "g1", to: "srv", kind: "data", label: "Ethernet" },
    ],
  },
} as const

export function diagramGuideText(): string {
  const f = diagramGuideFacts()
  const lx = LATTICE_X
  const req = (all: string[], r: string[]) => all.map((k) => (r.includes(k) ? `${k}*` : k)).join(", ")
  const defectCodes = Object.keys(PREVIEW_ISSUE_CLASS).filter((k) => PREVIEW_ISSUE_CLASS[k] === "defect")
  return [
    "# Diagram block (type \"diagram\"): fields studio_figure_preview and chapters accept",
    "",
    "`*` = required. Any other field is refused (SCHEMA_INVALID names it). Layout, size, colour and line style come from the template.",
    "",
    `- block: ${req(f.blockFields, f.blockRequired)}. Exactly one of spec (new drawing) or artifactId (stored). caption/source = {text} objects; the title is the caption.`,
    `- spec: ${req(f.specFields, f.specRequired)}. family: ${f.families.join(", ")}.`,
    `- node: ${req(f.nodeFields, f.nodeRequired)}. shape: ${f.shapes.join(", ")}. mark: ${f.marks.join(", ")} (provenance glyph; needs a published key row, DATUM-34).`,
    `- node.class (object, may be {}): ${f.classFields.join(", ")}. Placement (tier/lane/col/row) goes here, not on the node.`,
    `- edge: ${req(f.edgeFields, f.edgeRequired)}. kind: ${f.edgeKinds.join(", ")} (kind is the line style; no color/style/dash field).`,
    `- zone: ${req(f.zoneFields, f.zoneRequired)} (members = node ids).`,
    "- legend, notes, sources: arrays of strings.",
    `- direction (flow only): "TB" or "LR"; ranks nodes by the edges, parallel branches side by side. Rank max: TB ${flowTbMaxPerRank(128, lx)} @128 mm, ${flowTbMaxPerRank(166, lx)} @166 mm; LR ${FLOW_LR_MAX_PARALLEL}. LR max ${flowLrMaxRanks(128, lx)} ranks @128 mm, ${flowLrMaxRanks(166, lx)} @166 mm. Without it: list order (per_row), FLOW_SERIALISED if branches serialise.`,
    "",
    "Norms:",
    "- Figure gate: machine gate = the inline preview (the standalone preview is not the gate); a figure is done only after the machine gate AND an eye check of the rendered PNG.",
    `- Defects (figure.defects: any FAIL, GEOM_*, ${defectCodes.join(", ")}) must reach zero; notices are information.`,
    `- Caption: Studio prints the label; the caption never starts with it; at most ${CAPTION_GUIDE_MAX_CHARS} characters.`,
    "- Labels: edge label at most ~20 characters, node label at most ~40; a second detail goes in `sub`.",
    "- One accent per drawing.",
    "- At most 3 edge kinds when any node has a mark (4 without; DATUM-25).",
    `- \`col: 0\` is valid; Studio keeps a ${GRAPH_EDGE_INSET_MM} mm inset from the sheet edge.`,
    `- Fan-out of ${FANOUT_SPLIT_MIN} or more edges is sub-ranked by Studio; over a rank max, split it.`,
    "- Preview a shape before promising it.",
    "- A/B: randomise which side each version is on before a judge sees them.",
    "- After every revision read FIGURE_GRAPH_DELTA; fix any unplanned node/edge change.",
    "",
    "Minimal valid block:",
    "```json",
    JSON.stringify(DIAGRAM_GUIDE_EXAMPLE),
    "```",
    "",
  ].join("\n")
}
