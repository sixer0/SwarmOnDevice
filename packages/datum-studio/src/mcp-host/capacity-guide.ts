/**
 * Swarm 1.3.3 row 37 (ST-1 item 5, decision C13): studio://kapasitas/diagram, the capacity of each diagram family per
 * sheet width, as measured by real renders (row 36 data file test/st1-capacity-table/capacity-table.json).
 * The text is rendered from that file by `renderCapacityTable`; `capacity-guide.text.ts` holds the stored result and a
 * test compares the two, so the published table cannot drift from the engine. To refresh after an engine change:
 *   ROW36_WRITE=1 bun test test/st1-capacity-table/row36-capacity-table.test.ts   (data file)
 *   ROW37_WRITE=1 bun test test/st1-capacity-table/row37-capacity-resource.test.ts (stored text)
 * Separate from studio://skema/diagram, which is pinned under 3000 B (C13).
 */
import { CAPACITY_TABLE_TEXT } from "./capacity-guide.text"

export const DIAGRAM_CAPACITY_URI = "studio://kapasitas/diagram"
export const DIAGRAM_CAPACITY_NAME = "kapasitas-diagram"

/** English wording per data row key: what grows, what is held fixed. A key without an entry makes the renderer throw. */
/** @internal test seam */
export const CAPACITY_WORDING: Record<string, [grows: string, fixed: string]> = {
  "layered.perTier": ["nodes per tier", "2 tiers"],
  "layered.tiers": ["tiers", "2 nodes per tier"],
  "layered.zones": ["containers side by side", "2 nodes each"],
  "topology.perTier": ["nodes per tier", "2 tiers"],
  "topology.tiers": ["tiers", "2 nodes per tier"],
  "topology.zones": ["containers side by side", "2 nodes each"],
  "stack.perTier": ["nodes per layer", "2 layers"],
  "stack.tiers": ["layers", "1 node per layer"],
  "flow.chain": ["nodes in one chain", "no direction"],
  "flow.TB.perRank": ["nodes per rank", "direction TB, 2 ranks"],
  "flow.TB.ranks": ["ranks", "direction TB, 1 node per rank"],
  "flow.LR.ranks": ["ranks", "direction LR, 1 node per rank"],
  "flow.LR.perRank": ["nodes per rank", "direction LR, 2 ranks"],
  "swimlane.perLane": ["nodes per lane", "2 lanes"],
  "swimlane.lanes": ["lanes", "2 nodes per lane"],
  "swimlane.oneLane": ["nodes in one lane", "1 lane"],
  "sequence.lifelines": ["lifelines", "4 messages"],
  "sequence.messages": ["messages", "3 lifelines"],
  "sld.branches": ["branches on one bus", "1 bus"],
  "rack.devices": ["devices of 1U", "1 rack, no connector"],
  "rack.devicesUplink": ["devices of 1U", "1 rack, one connector"],
  "graph.cols": ["columns", "1 row"],
  "graph.rows": ["rows", "2 columns"],
  "graph.zones": ["containers side by side", "1 column, 2 rows each"],
}

type Above = { result: string; code?: string; checkId?: string; split?: boolean; defects?: string[] }
type Cell = { width: string; widthMm: number; limit: number; capped: boolean; above?: Above }
type Row = { key: string; family: string; cells: Cell[] }
/** @internal test seam */
export type CapacityData = { capacity: { rows: Row[] } }

function refusal(c: Cell): string {
  const a = c.above
  if (c.capped || !a) return "none up to the scan end"
  if (a.result === "refused") return `${a.checkId}${a.split ? " + split skeleton" : ""}`
  if (a.result === "defect") return `renders with defect ${(a.defects ?? []).join(", ")}`
  return a.result
}

/** The table in Markdown, generated from the row 36 data file; deterministic, no clock, no machine data. */
/** @internal test seam */
export function renderCapacityTable(data: CapacityData): string {
  const lines: string[] = [
    "# Diagram capacity per family and width",
    "",
    "Measured with real renders (preview and document render agree): the limit is the largest size that renders with zero defects.",
    "A figure above it is refused with FIGURE_OVER_CAPACITY (the check id is shown); \"+ split skeleton\" means the refusal carries a ready split into two diagrams.",
    "",
    "| Family | What grows | Held fixed | Limit at 128 mm (text) | Limit at 166 mm (full) | Refusal above the limit (128 / 166) |",
    "|---|---|---|---|---|---|",
  ]
  for (const row of data.capacity.rows) {
    const w = CAPACITY_WORDING[row.key]
    if (!w) throw new Error(`capacity-guide: no wording for row ${row.key}`)
    const at = (width: string) => {
      const c = row.cells.find((x) => x.width === width)
      if (!c) throw new Error(`capacity-guide: row ${row.key} has no ${width} cell`)
      return c
    }
    const t = at("text")
    const f = at("full")
    const lim = (c: Cell) => (c.capped ? `${c.limit} or more` : String(c.limit))
    const rt = refusal(t)
    const rf = refusal(f)
    lines.push(`| ${row.family} | ${w[0]} | ${w[1]} | ${lim(t)} | ${lim(f)} | ${rt === rf ? rt : `${rt} / ${rf}`} |`)
  }
  lines.push(
    "",
    "Reading notes:",
    "- A wider sheet (width full) helps only across the sheet: nodes per tier, per rank, per lane, columns, containers, lifelines. Tiers, layers, rows, messages and rack units (the height) have the same limit at both widths.",
    "- Labelled tiers (tiers[] with labels, layered and topology) take a band at the left and cost one node per tier: 2 at 128 mm (a label of up to 3 letters keeps 3), 3 at 166 mm.",
    "",
  )
  return lines.join("\n")
}

export function capacityGuideText(): string {
  return CAPACITY_TABLE_TEXT
}
