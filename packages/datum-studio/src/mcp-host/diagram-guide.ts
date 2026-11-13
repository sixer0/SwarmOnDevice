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
 *
 * Swarm 1.2.7 row 37 (N-6/F-6, N7-069): one Norms line names GEOM_T03_CODES and where ENTRY_COLLISION fires
 * (ENTRY_COLLISION_MM). Other lines were shortened to keep the resource under 3000 B (the pin is not moved).
 *
 * Swarm 1.2.8 row 52 (VIS-0b, F-VISIO 01f §8, C12 OP-18-1, register N8-474): the field lines print the fields that
 * existed before 1.2.8 and point to studio://skema/diagram-visio (diagramVisioGuideText), the generated catalogue of the
 * 1.2.8 fields (DIAGRAM_VISIO_FIELDS), shape sets and connector style; both stay under 3000 B (the pins are not moved).
 * diagramGuideFacts() still returns the full schema lists.
 *
 * Swarm 1.2.8 row 58 (AC-VIS10, N8-382): the Visio resource also names P1-event_type and POOL_FLOW_CROSSES, so every
 * agent-written field, token and check id of N8-230..N8-271 plus the pool warning is in one of the two resources.
 */
import { commonV2Schema } from "@/lib/studio/contract/schema/v2/common.schema"
import { DIAGRAM_GUIDE_URI, DIAGRAM_VISIO_FIELDS, DIAGRAM_VISIO_GUIDE_URI } from "@/lib/studio/contract/schema/v2/refusal-hints"
import { CAPTION_GUIDE_MAX_CHARS } from "@/lib/studio/contract/schema/figure-bounds"
import { GRAPH_EDGE_INSET_MM } from "@/lib/studio/engine/diagram/core/sheet"
import { LATTICE_X, LIMITS, SHAPES } from "@/lib/studio/engine/diagram/core/tokens"
import { FLOW_LR_MAX_PARALLEL, flowLrMaxRanks, flowTbMaxPerRank } from "@/lib/studio/engine/diagram/layout-a/flow"
import { FANOUT_SPLIT_MIN } from "@/lib/studio/engine/diagram/build/route"
import { ENTRY_COLLISION_MM } from "@/lib/studio/engine/diagram/fit/lint"
import { GEOM_T03_CODES, PREVIEW_ISSUE_CLASS } from "./local-api/routes/figure-preview-figure"

export { DIAGRAM_GUIDE_URI, DIAGRAM_VISIO_GUIDE_URI }
export const DIAGRAM_GUIDE_NAME = "skema-diagram"
/** Swarm 1.2.8 row 52 (N8-474): MCP resource name of studio://skema/diagram-visio. */
export const DIAGRAM_VISIO_GUIDE_NAME = "skema-diagram-visio"

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
  caption: { text: "Alur data arsip." },
  source: { text: "SUMBER: data proyek." },
  spec: {
    family: "flow",
    // Row 58 (AC-VIS10): without it the preview lists P1-labels_verified (draft) among figure.defects.
    labels_verified: true,
    nodes: [
      { id: "a", label: "Sensor R1-R2", class: {} },
      { id: "b", label: "Gerbang Data A", class: {} },
      { id: "c", label: "Server Pemantauan", class: {} },
    ],
    edges: [
      { from: "a", to: "b", kind: "data", label: "RS-485" },
      { from: "b", to: "c", kind: "data", label: "LAN" },
    ],
  },
} as const

export function diagramGuideText(): string {
  const f = diagramGuideFacts()
  const lx = LATTICE_X
  // Row 52 (VIS-0b): the 1.2.8 contract fields are listed in studio://skema/diagram-visio, not here.
  const added = new Set(Object.values(DIAGRAM_VISIO_FIELDS).flat())
  const req = (all: string[], r: string[]) => all.filter((k) => !added.has(k)).map((k) => (r.includes(k) ? `${k}*` : k)).join(", ")
  const defectCodes = Object.keys(PREVIEW_ISSUE_CLASS).filter((k) => PREVIEW_ISSUE_CLASS[k] === "defect")
  return [
    "# Diagram block fields",
    "",
    "`*` = required; unknown fields: SCHEMA_INVALID.",
    "",
    `- block: ${req(f.blockFields, f.blockRequired)}. spec (new) or artifactId (stored); caption/source = {text}.`,
    `- spec: ${req(f.specFields, f.specRequired)}. family: ${f.families.join(", ")}.`,
    `- node: ${req(f.nodeFields, f.nodeRequired)}. shape: ${f.shapes.join(", ")}. mark: ${f.marks.join(", ")} (needs a key row, DATUM-34).`,
    `- node.class (may be {}; placement, not on node): ${req(f.classFields, [])}.`,
    `- edge: ${req(f.edgeFields, f.edgeRequired)}. kind: ${f.edgeKinds.join(", ")}.`,
    `- zone: ${req(f.zoneFields, f.zoneRequired)} (members = node ids). legend, notes, sources: string arrays.`,
    `- Visio shape sets and connector fields: ${DIAGRAM_VISIO_GUIDE_URI}.`,
    `- direction (flow only): "TB" or "LR"; ranks nodes by the edges, parallel branches side by side. Rank max: TB ${flowTbMaxPerRank(128, lx)} @128 mm, ${flowTbMaxPerRank(166, lx)} @166 mm; LR ${FLOW_LR_MAX_PARALLEL}. LR max ${flowLrMaxRanks(128, lx)} ranks @128 mm, ${flowLrMaxRanks(166, lx)} @166 mm. Without it: list order (per_row), FLOW_SERIALISED if branches serialise.`,
    "",
    "Norms:",
    "- Figure gate: machine gate = the inline preview (the standalone preview is not the gate); a figure is done only after the machine gate AND an eye check of the rendered PNG.",
    `- Defects (figure.defects: any FAIL, GEOM_*, ${defectCodes.join(", ")}) must reach zero; notices are information.`,
    `- Caption: Studio prints the label; the caption never starts with it; at most ${CAPTION_GUIDE_MAX_CHARS} characters.`,
    "- Labels: edge label at most ~20 characters, node label at most ~40; a second detail goes in `sub`.",
    "- One accent per drawing.",
    // Row 35c (1.2.8, H-T06, N8-212): the spec check DATUM-25L enforces it (DATUM-25 counts colours).
    `- Edge kinds max ${LIMITS.max_line_styles}, ${LIMITS.max_line_styles_with_mark} if a node has a mark (DATUM-25L).`,
    `- \`col: 0\` is valid; Studio keeps a ${GRAPH_EDGE_INSET_MM} mm inset from the sheet edge.`,
    `- Fan-out of ${FANOUT_SPLIT_MIN} or more edges is sub-ranked by Studio; over a rank max, split it.`,
    "- Preview a shape before promising it.",
    "- A/B: randomise which side each version is on before a judge sees them.",
    "- After every revision read FIGURE_GRAPH_DELTA; fix any unplanned change.",
    // Row 37 (1.2.7, N-6/F-6, N7-069): the T-03 codes and when ENTRY_COLLISION fires (row 35f: also two glued ends on one slot); shortened for the 3000 B budget.
    `- T-03: ${GEOM_T03_CODES.join(", ")}; ENTRY_COLLISION when glued ends share a slot: move one or let router pick (ends at least ${ENTRY_COLLISION_MM} mm apart).`,
    "",
    "Example:",
    "```json",
    JSON.stringify(DIAGRAM_GUIDE_EXAMPLE),
    "```",
    "",
  ].join("\n")
}

/**
 * Swarm 1.2.8 row 52 (VIS-0b, F-VISIO 01f §8.2, C12 OP-18-1, register N8-474): studio://skema/diagram-visio, the
 * catalogue of the 1.2.8 diagram contract fields. Field names and enums are read from the v2 schema (DIAGRAM_VISIO_FIELDS
 * says which fields are new), notations from SHAPES, limits from LIMITS; only the set names, defaults and rules are text.
 * Pinned < 3000 B by test/diagram-visio/rel128-vis0-contract-defaults.test.ts (N8-369, describe "guide").
 */
const VISIO_SETS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ["basic-flowchart", [["stadium", "start/end"], ["box", "process"], ["diamond", "decision"], ["predefined", "subprocess"], ["document", ""], ["parallelogram", "data"], ["circle", "on-page ref"], ["offpage", "off-page ref"], ["hexagon", "preparation"], ["cylinder", "database"]]],
  ["bpmn-basic", [["event_start", ""], ["event_intermediate", ""], ["event_end", ""], ["task", ""], ["subprocess", "collapsed [+] (not predefined)"], ["gateway_exclusive", ""], ["gateway_parallel", ""], ["gateway_inclusive", ""], ["gateway_complex", ""], ["diamond", "gateway without marker"], ["data_object", ""], ["cylinder", "data store"], ["annotation", "text annotation"]]],
]

/** Default when the field is absent (01f §2.1, §3.1); an explicit default draws exactly like the absent field. */
const VISIO_DEFAULTS: Readonly<Record<string, string>> = {
  lane_orientation: "horizontal",
  jumps: "on",
  event_type: "none",
  style: "zone",
  route: "orthogonal",
  from_side: "auto",
  to_side: "auto",
  arrow_start: "none",
  arrow_end: "by kind: data, accent triangle; others open",
  arrow_start_size: "m",
  arrow_end_size: "m",
  dash: "by kind",
  weight: "normal",
  label_at: "placed by Studio",
}

export function diagramVisioGuideText(): string {
  const spec = defs.DiagramSpecV2 as S
  const node = spec.properties.nodes.items as S
  const objs: Record<keyof typeof DIAGRAM_VISIO_FIELDS, S> = { spec, node, class: node.properties.class, edge: spec.properties.edges.items, zone: spec.properties.zones.items }
  const value = (o: S, k: string): string => {
    const p = o.properties[k] as S
    if (Array.isArray(p.enum)) return (p.enum as string[]).join("|")
    if (p.type === "array") return `[{${Object.keys(p.items.properties).join(",")}}] max ${p.maxItems}`
    if (p.type === "number") return "0<n<1"
    return "id"
  }
  // Neighbouring fields with the same values and default share one entry (from_side, to_side ...).
  const line = (o: keyof typeof DIAGRAM_VISIO_FIELDS, label: string) => {
    const out: Array<{ keys: string[]; v: string }> = []
    for (const k of DIAGRAM_VISIO_FIELDS[o]) {
      const v = `${value(objs[o], k)}${VISIO_DEFAULTS[k] ? ` (${VISIO_DEFAULTS[k]})` : ""}`
      const last = out[out.length - 1]
      if (last && last.v === v) last.keys.push(k)
      else out.push({ keys: [k], v })
    }
    return `- ${label}: ` + out.map((e) => `${e.keys.join(", ")} ${e.v}`).join("; ") + "."
  }
  // Notation groups from SHAPES (one notation per figure, DATUM-35); `notation_set` per shape since row 53a (N8-245).
  const inSets = new Set(VISIO_SETS.flatMap(([, rows]) => rows.map(([t]) => t)))
  const groups = new Map<string, string[]>()
  for (const [shape, t] of Object.entries(SHAPES)) {
    if (!inSets.has(shape)) continue
    const n = (t as { notation_set?: readonly string[]; notation?: string }).notation_set
    const key = n ? (n.length ? n.join(", ") : "universal") : String((t as { notation?: string }).notation)
    groups.set(key, [...(groups.get(key) ?? []), shape])
  }
  return [
    "# Diagram Visio fields (Basic Flowchart, Cross-Functional, BPMN Basic)",
    "",
    `Read with ${DIAGRAM_GUIDE_URI}. Absent field = drawing as before; default in (). Swarm choices, not a Visio file format.`,
    "",
    "Shape sets (shape token = Visio name):",
    ...VISIO_SETS.map(([set, rows]) => `- ${set}: ${rows.map(([t, n]) => (n ? `${t} = ${n}` : t)).join(", ")}.`),
    "- cross-functional: family swimlane; lane = class.lane (order of first use), lane_orientation, phases, pools.",
    `- One notation per figure (DATUM-35): ${[...groups].map(([k, v]) => `${k}: ${v.join(", ")}`).join("; ")}.`,
    "",
    "Fields:",
    line("spec", "spec (swimlane only for lanes, phases, pools)"),
    line("node", "node (event shapes only, P1-event_type)"),
    line("class", "node.class (phase/pool id; all nodes or none, P1-containers)"),
    line("zone", "zone (group = BPMN group)"),
    line("edge", "edge"),
    "",
    "Rules:",
    `- via: lattice points {col,row} from the preview's figure.lattice; families flow without direction, graph, swimlane (P3-via-family); not with curved (P1-edge-style); max ${LIMITS.max_via} (P1-via).`,
    "- A slot needs from_side/to_side; an arrow size needs an arrow type (P1-edge-style).",
    `- Line styles (kind + dash + weight) at most ${LIMITS.max_line_styles}, ${LIMITS.max_line_styles_with_mark} when a node has a mark (DATUM-25L).`,
    "- label_at fixes the label: a collision is a defect, never moved. Curved and diagonal lines get no jumps.",
    "- Event and gateway labels sit below the shape; other labels inside.",
    "- BPMN: sequence flow = kind data; message flow = kind control + arrow_start circle + arrow_end open; association = kind sync + arrow_end none. A sequence flow leaving its pool is a warning (POOL_FLOW_CROSSES).",
    "- Arrays replace whole on studio_figure_revise; a style-only change is no FIGURE_GRAPH_DELTA.",
    "",
  ].join("\n")
}
