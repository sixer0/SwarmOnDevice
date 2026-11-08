/**
 * Row 178 (gateway_check/16_row177_split_builders_ab.md): the diagram block guide an agent reads before
 * `studio_figure_preview` / a chapter with a `diagram` block, served as the MCP resource DIAGRAM_GUIDE_URI
 * (mcp-server.ts). In the row 177 runs agents were refused 9-26 times per run guessing node, class and edge fields.
 *
 * Every field list and enum is read from the v2 block schema (common/v2 `$defs.DiagramV2` / `DiagramSpecV2`), never
 * typed here, so the guide cannot drift from what Studio validates; the row 178 test checks the enums against the
 * schema and validates and renders the example.
 */
import { commonV2Schema } from "@/lib/studio/contract/schema/v2/common.schema"
import { DIAGRAM_GUIDE_URI } from "@/lib/studio/contract/schema/v2/refusal-hints"

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
  const req = (all: string[], r: string[]) => all.map((k) => (r.includes(k) ? `${k}*` : k)).join(", ")
  return [
    "# Diagram block (type \"diagram\"): fields studio_figure_preview and chapters accept",
    "",
    "`*` = required. Any other field is refused (SCHEMA_INVALID names the field and the allowed ones). Layout, size, colour and line style are set by the template, not the block.",
    "",
    `- block: ${req(f.blockFields, f.blockRequired)}. Exactly one of spec (new drawing) or artifactId (stored artifact), not both. caption/source = {text} objects; the title is the caption.`,
    `- spec: ${req(f.specFields, f.specRequired)}. family: ${f.families.join(", ")}.`,
    `- node: ${req(f.nodeFields, f.nodeRequired)}. shape: ${f.shapes.join(", ")}. mark: ${f.marks.join(", ")} (a provenance glyph; the render refuses it without a published key row, DATUM-34).`,
    `- node.class (object, may be {}): ${f.classFields.join(", ")}. Placement (tier/lane/col/row) goes here, not on the node.`,
    `- edge: ${req(f.edgeFields, f.edgeRequired)}. kind: ${f.edgeKinds.join(", ")} (kind is the line style; there is no color/style/dash field).`,
    `- zone: ${req(f.zoneFields, f.zoneRequired)} (members = node ids).`,
    "- legend, notes, sources: arrays of strings.",
    "",
    "Minimal valid block:",
    "```json",
    JSON.stringify(DIAGRAM_GUIDE_EXAMPLE),
    "```",
    "",
  ].join("\n")
}
