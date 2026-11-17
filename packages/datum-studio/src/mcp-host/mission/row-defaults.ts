/**
 * 1.3.3 row 16 (MC-4 item 1, register 1.1): server-side defaults, so a mission is created from id, title, type and a
 * list of step titles. Runs on the tool arguments BEFORE validation, for `studio_mission_create` (mission.owner and
 * mission.rows[]) and for a row added later (`studio_mission_update_row` rows[].add).
 *
 * Rules: only an ABSENT field is filled. Any value the caller sent (null, a wrong type, a model without the reason
 * its tier needs) stays as sent and is judged by the schema. The result names every field that was filled, so the
 * reply can say so. Input that does not have the expected shape is left alone for the schema check.
 */
import type { RowModel, MissionTypeDoc } from "../../store/mission/types.ts"

/**
 * Mission owner: the store's own name for the orchestrating role (decisions `by: controller`, messages
 * `from: controller`). True for any client; a skill name would misname a mission made outside that skill.
 */
export const OWNER_DEFAULT = "controller"
/**
 * Row agent: Swarm's own fallback agent for an unnamed or unknown role (opencode agent/role-alias.ts
 * UNKNOWN_ROLE_AGENT). It claims no specialist, so the mission never says a planner or verifier did a step nobody
 * assigned to one.
 */
export const AGENT_DEFAULT = "general"
/** Row output: says that nothing was named. Not a path, so nothing reads it as a document or a promised file. */
export const OUTPUT_DEFAULT = "no output named for this step"
/** Row verification: points at the rule that still holds (running -> done needs a note with the check and its result). */
export const VERIFICATION_DEFAULT = "the done note names the check that was run and its result"

/** The shipped Swarm tier map (skill mission-control step 2, swarm-workflow agent table). */
export const AGENT_TIERS: Readonly<Record<string, RowModel>> = {
  planner: { tier: "thinker" },
  verifier: { tier: "thinker" },
  coder: { tier: "worker", reason: "Swarm tier map: coder runs on worker" },
  "document-writer": { tier: "worker", reason: "Swarm tier map: document-writer runs on worker" },
  "data-collector": { tier: "worker-fast", reason: "Swarm tier map: data-collector runs on worker-fast" },
  explore: { tier: "worker-fast", reason: "Swarm tier map: explore runs on worker-fast" },
  researcher: { tier: "inherit", reason: "runs on the session model" },
}

/** model for an agent: its tier in the map, else `inherit` (the session's model: no tier is claimed for an unmapped agent). */
export function modelForAgent(agent: unknown): RowModel {
  return { ...((typeof agent === "string" && Object.hasOwn(AGENT_TIERS, agent) ? AGENT_TIERS[agent] : undefined) ?? { tier: "inherit" }) }
}

export interface MissionTypeLookup {
  /** The newest pinned version of a type, or that version. */
  type(id: string, version?: number): MissionTypeDoc | null
  /** The pinned type of an existing mission. */
  typeOfMission(mission: string): MissionTypeDoc | null
}

export interface DefaultsFilled {
  /** Mission fields filled (today: owner). */
  mission: string[]
  /** Per row that got at least one default: its id and the field names, in row field order. */
  rows: Array<{ row: string; fields: string[] }>
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v)

export function fillMissionDefaults(tool: string, args: Rec, lookup: MissionTypeLookup): DefaultsFilled {
  const filled: DefaultsFilled = { mission: [], rows: [] }
  if (tool === "studio_mission_create" && isRec(args.mission)) {
    const m = args.mission
    if (m.owner === undefined) {
      m.owner = OWNER_DEFAULT
      filled.mission.push("owner")
    }
    if (!Array.isArray(m.rows)) return filled
    const type = typeof m.type === "string" ? lookup.type(m.type, typeof m.typeVersion === "number" ? m.typeVersion : undefined) : null
    m.rows.forEach((row, i) => {
      if (isRec(row)) fillRow(row, String(i + 1), type, filled)
    })
  }
  if (tool === "studio_mission_update_row" && Array.isArray(args.rows)) {
    const adds = args.rows.filter((p): p is Rec & { add: Rec } => isRec(p) && isRec(p.add))
    if (adds.length === 0) return filled
    const type = typeof args.mission === "string" ? lookup.typeOfMission(args.mission) : null
    for (const p of adds) fillRow(p.add, typeof p.id === "string" ? p.id : undefined, type, filled)
  }
  return filled
}

function fillRow(row: Rec, id: string | undefined, type: MissionTypeDoc | null, filled: DefaultsFilled): void {
  const fields: string[] = []
  const fill = (field: string, value: unknown) => {
    if (row[field] !== undefined || value === undefined) return
    row[field] = value
    fields.push(field)
  }
  fill("id", id)
  const phases = type ? [...type.phases].sort((a, b) => a.order - b.order) : []
  // A sent kind picks the first phase that allows it, so `{kind: "test"}` is not refused KIND_NOT_ALLOWED by a default.
  fill("phase", (phases.find((p) => row.kind === undefined || (p.kinds as readonly unknown[]).includes(row.kind)) ?? phases[0])?.id)
  fill("kind", phases.find((p) => p.id === row.phase)?.kinds[0])
  fill("agent", AGENT_DEFAULT)
  fill("model", modelForAgent(row.agent))
  fill("deps", [])
  fill("size", "S")
  fill("status", "pending")
  fill("output", OUTPUT_DEFAULT)
  fill("verification", VERIFICATION_DEFAULT)
  if (fields.length > 0) filled.rows.push({ row: typeof row.id === "string" ? row.id : (id ?? "?"), fields })
}

const MAX_GROUPS = 6

/** One line for the reply, or undefined when nothing was filled. Rows with the same filled fields are named together. */
export function defaultsSentence(filled: DefaultsFilled): string | undefined {
  if (filled.mission.length === 0 && filled.rows.length === 0) return undefined
  const groups = new Map<string, string[]>()
  for (const r of filled.rows) groups.set(r.fields.join(", "), [...(groups.get(r.fields.join(", ")) ?? []), r.row])
  const shown = [...groups].slice(0, MAX_GROUPS).map(([fields, rows]) => `${rows.length === 1 ? "row" : "rows"} ${rowList(rows)}: ${fields.replace(/\bagent\b/, `agent "${AGENT_DEFAULT}"`)}`)
  const more = [...groups].slice(MAX_GROUPS).reduce((n, [, rows]) => n + rows.length, 0)
  const parts = [...filled.mission.map((f) => (f === "owner" ? `mission owner "${OWNER_DEFAULT}"` : `mission ${f}`)), ...shown, ...(more > 0 ? [`${more} more rows (data.defaulted)`] : [])]
  return `defaults filled (a value you send is never replaced): ${parts.join("; ")}.`
}

/** "1-3, 5, 2a": runs of consecutive plain numbers become a range; at most 8 entries are printed. */
function rowList(rows: string[]): string {
  const out: string[] = []
  let start = 0
  rows.forEach((row, i) => {
    const next = rows[i + 1]
    if (next !== undefined && /^\d+$/.test(row) && /^\d+$/.test(next) && Number(next) === Number(row) + 1) return
    out.push(i === start ? row : i === start + 1 ? `${rows[start]}, ${row}` : `${rows[start]}-${row}`)
    start = i + 1
  })
  return out.length > 8 ? `${out.slice(0, 8).join(", ")} and ${out.length - 8} more` : out.join(", ")
}

/** The tool reply with the defaults named: one more text line and `data.defaulted`; unchanged when nothing was filled. */
export function withDefaultsNamed<T extends { text: string; data: Record<string, unknown> }>(out: T, filled: DefaultsFilled): T {
  const sentence = defaultsSentence(filled)
  return sentence === undefined ? out : { ...out, text: `${out.text}\n${sentence}`, data: { ...out.data, defaulted: filled } }
}
