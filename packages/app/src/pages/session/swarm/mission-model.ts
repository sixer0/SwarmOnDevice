// Mission control view model (row 129; masterplan/01_specs_mission_control_ui.md §5, §7, §9).
// Pure: mission JSON from the Studio host -> the HQ model the view draws. The view never re-derives.
// All mission text is agent-written; the view renders it as text only (§12).

// ── Wire types (§9.1). Restated from datum-studio/src/store/mission/types.ts; only the fields used here.

export type MissionStatus = "draft" | "approved" | "running" | "paused" | "done" | "cancelled"
export type RowStatus = "pending" | "running" | "needs-review" | "blocked" | "done" | "dropped"
export type Bilingual = { id: string; en: string }
export type StatusCounts = Record<RowStatus, number>

export type MissionListItemWire = {
  id: string
  title: string
  type: string
  status: MissionStatus
  progress: { done: number; total: number }
  openRequests: string[]
  updatedAt: string
  activityAt?: string // G2, row 126
}

export type MissionRowWire = {
  id: string
  phase: string
  title: string
  agent: string
  status: RowStatus
  note?: string
}

export type DecisionRequestWire = {
  id: string
  question: string
  context?: string
  options: Array<{ id: string; label: string; consequence: string }>
  recommended?: string
  blockingRows?: string[]
  status: "open" | "answered" | "withdrawn"
  createdAt: string
  closedAt?: string
  answer?: { option: string; by: "user" | "controller"; decision: string }
}

export type MissionMessageWire = {
  seq: number
  at: string
  from: "controller" | "agent" | "owner"
  to: "controller" | "agent" | "owner"
  kind: "report" | "instruction" | "question"
  text: string
  row?: string
}

export type DeliverableOutputWire = {
  fileId: string
  format: "DOCX" | "PDF" | "HTML" | "SVG" | "PNG"
  role: "PRIMARY" | "FIGURE"
  finalFileName: string
  /** Row 165D (F56-2): the DATUM title name the file is delivered under; absent/null from an older host. */
  fileName?: string | null
  verified: boolean
}

export type DeliverableWire = {
  documentId: string
  title: string
  docKey: string | null
  rowId?: string
  docRev: string
  /** Row 173: the current revision number and the document's last change (host G1 sends both; absent from tests). */
  revisionNo?: number
  updatedAt?: string
  /** Row 136b (C151, M5): computed by the host from the store's one rule; absent (older host) = false. */
  verified?: boolean
  /** Row 136b: spec output verification §7.2 Final, the same rule as the row done gate; absent = false. */
  final?: boolean
  outputs: DeliverableOutputWire[]
}

export type MissionDerivedWire = {
  phases: Array<{ id: string; name: Bilingual; order: number; rows: string[]; counts: StatusCounts }>
  waves: Array<{ wave: number; rows: string[] }>
  progress: { done: number; total: number }
  checkpoints: Record<string, { n: number; m: number }>
}

export type MissionGetWire = {
  mission: { id: string; title: string; type: string; status: MissionStatus; rows: MissionRowWire[] }
  derived: MissionDerivedWire
  requests?: DecisionRequestWire[]
  messages?: MissionMessageWire[]
  deliverables?: DeliverableWire[]
}

// ── View model (§9.2)

export type MissionAgentStatus = "running" | "review" | "issue" | "blocked" | "done" | "waiting"
export type MissionFamily = "plan" | "research" | "build" | "verify" | "ship"
export type MissionTool = "hub" | "code" | "lens" | "chart" | "shield" | "check" | "send" | "chat" | "grid" | "pen" | "flask"
export type DeliverableStatus = "draft" | "review" | "final"
export type DeliverableFormat = "PDF" | "DOCX" | "HTML"

export type MissionOption = { id: string; title: string; type: string; status: MissionStatus; pct: number; openDecisions: number }
export type MissionPhaseVM = {
  id: string
  name: string
  order: number
  family: MissionFamily
  rows: string[]
  done: number
  total: number
  live: boolean
  allDone: boolean
}
export type MissionAgentVM = {
  rowId: string
  title: string
  agent: string
  family: MissionFamily
  tool: MissionTool
  status: MissionAgentStatus
  phase: string
  wave: number | null
  checkpoint: { n: number; m: number } | null
  note?: string
  heldBy: string[]
  deliverableId?: string
}
export type MissionWaveVM = { wave: number; done: number; total: number; tone: "done" | "issue" | "run" }
export type MissionDecisionVM = {
  id: string
  question: string
  context?: string
  options: Array<{ id: string; label: string; consequence: string; recommended: boolean }>
}
export type MissionAnsweredVM = { id: string; question: string; optionLabel: string; decision: string }
export type MissionFeedLine = {
  key: string
  from: "owner" | "controller" | "agent"
  to: "owner" | "controller" | "agent"
  agent?: string
  row?: string
  text: string
  at: string
  local?: true
}
export type MissionDeliverableVM = {
  documentId: string
  title: string
  rowId?: string
  rowTitle?: string
  docRev: string
  formats: DeliverableFormat[]
  status: DeliverableStatus
  verified: boolean
  /** Row 165D: `fileName` = the delivered DATUM title name when the host sent a plain one. */
  files: Array<{ format: DeliverableFormat; finalFileName: string; fileName?: string }>
  projectPath: string | null
}
export type MissionVM = {
  id: string
  title: string
  type: string
  status: MissionStatus
  progress: { done: number; total: number; pct: number }
  held: number
  phases: MissionPhaseVM[]
  layout: "radial" | "lanes"
  agents: Record<string, MissionAgentVM>
  waves: MissionWaveVM[]
  decision: MissionDecisionVM | null
  openDecisions: number
  answered: MissionAnsweredVM | null
  feed: MissionFeedLine[]
  deliverables: MissionDeliverableVM[]
  finalCount: number
}

// ── Tables (§5.3, §5.4)

const FAMILY_BY_PHASE: Record<string, MissionFamily> = {
  identification: "plan",
  diagnose: "plan",
  brief: "plan",
  research: "research",
  reproduce: "research",
  implementation: "build",
  synthesis: "build",
  fix: "build",
  draft: "build",
  verification: "verify",
  verify: "verify",
  review: "verify",
  release: "ship",
  report: "ship",
  publish: "ship",
}

const LOOK_BY_AGENT: Record<string, [MissionFamily, MissionTool]> = {
  "request-translator": ["plan", "chat"],
  "task-architect": ["plan", "grid"],
  explore: ["research", "lens"],
  "data-collector": ["research", "lens"],
  "data-analyst": ["research", "chart"],
  "coder-execution": ["build", "code"],
  "document-writer": ["build", "pen"],
  "security-review": ["verify", "shield"],
  verifier: ["verify", "check"],
  "test-expert": ["verify", "flask"],
  "document-reviewer": ["verify", "check"],
  "git-specialist": ["ship", "send"],
  "pm-writer": ["ship", "send"],
}

export const FEED_SIZE = 4
export const WAVES_SHOWN = 4
const ROW_KEY = /^row-([1-9][0-9]{0,3}[a-z]?)-(.+)$/
// finalFileName must be a plain file name before it becomes part of a project path (§12).
const PLAIN_NAME = /^[^/\\\u0000-\u001f]+$/
const FORMAT_ORDER: DeliverableFormat[] = ["PDF", "DOCX", "HTML"]
const CLICK_ORDER: DeliverableFormat[] = ["PDF", "HTML", "DOCX"]

export function phaseFamily(id: string, order: number, count: number): MissionFamily {
  const known = FAMILY_BY_PHASE[id]
  if (known) return known
  if (order <= 1) return "plan"
  if (order >= count) return "ship"
  return "build"
}

export function agentLook(agent: string, phaseFamilyOf: MissionFamily): { family: MissionFamily; tool: MissionTool } {
  const look = LOOK_BY_AGENT[agent]
  if (look) return { family: look[0], tool: look[1] }
  return { family: phaseFamilyOf, tool: "hub" }
}

/** §5.1. `held` = open request ids whose blockingRows list this row. Dropped rows are not shown (undefined). */
export function agentStatus(status: RowStatus, held: string[]): MissionAgentStatus | undefined {
  if (status === "running") return "running"
  if (status === "needs-review") return "review"
  if (status === "blocked") return "issue"
  if (status === "done") return "done"
  if (status === "pending") return held.length > 0 ? "blocked" : "waiting"
  return undefined
}

export function rowIdOfKey(docKey: string | null | undefined) {
  if (!docKey) return undefined
  return ROW_KEY.exec(docKey)?.[1]
}

export function pct(done: number, total: number) {
  return total > 0 ? Math.round((done / total) * 100) : 0
}

export function missionOptions(items: MissionListItemWire[]): MissionOption[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    pct: pct(item.progress.done, item.progress.total),
    openDecisions: item.openRequests.length,
  }))
}

/** §4.1: keep the current choice while it is listed; else the first running mission; else the first. */
export function pickSelected(items: Array<{ id: string; status: MissionStatus }>, current: string | undefined) {
  if (current && items.some((item) => item.id === current)) return current
  return (items.find((item) => item.status === "running") ?? items[0])?.id
}

function deliverableVM(
  wire: DeliverableWire,
  missionId: string,
  rows: Map<string, MissionRowWire>,
  present: Set<string>,
): MissionDeliverableVM {
  const rowId = wire.rowId ?? rowIdOfKey(wire.docKey)
  const row = rowId ? rows.get(rowId) : undefined
  const primary = wire.outputs.filter(
    (out): out is DeliverableOutputWire & { format: DeliverableFormat } =>
      out.role === "PRIMARY" && (FORMAT_ORDER as string[]).includes(out.format),
  )
  // Newest first per format (row 126): the first output of a format is the current one.
  const byFormat = new Map<DeliverableFormat, DeliverableOutputWire>()
  for (const out of primary) if (!byFormat.has(out.format)) byFormat.set(out.format, out)
  // Row 136b (M5): shown as the host computed them (store rule), never re-derived from the outputs here.
  const verified = wire.verified === true
  const rowStatus = row?.status
  const status: DeliverableStatus =
    wire.final === true && rowStatus === "done" ? "final" : rowStatus === "needs-review" || verified ? "review" : "draft"
  const files = CLICK_ORDER.flatMap((format) => {
    const out = byFormat.get(format)
    if (!out || !PLAIN_NAME.test(out.finalFileName)) return []
    // Row 165D (F56-2): the delivered DATUM title name, when the host sent one that is a plain, safe name.
    const datum = typeof out.fileName === "string" && PLAIN_NAME.test(out.fileName) && out.fileName !== "." && out.fileName !== ".." ? out.fileName : undefined
    return [{ format, finalFileName: out.finalFileName, ...(datum ? { fileName: datum } : {}) }]
  })
  // The file in the project carries the DATUM name (studio_file_verify since row 165D) or, from older downloads, the
  // C51 final name; the DATUM name is preferred.
  const hitName = files
    .map((file) => (file.fileName && present.has(file.fileName) ? file.fileName : present.has(file.finalFileName) ? file.finalFileName : undefined))
    .find((name): name is string => name !== undefined)
  return {
    documentId: wire.documentId,
    title: wire.title,
    rowId: row ? rowId : undefined,
    rowTitle: row?.title,
    docRev: wire.docRev,
    formats: FORMAT_ORDER.filter((format) => byFormat.has(format)),
    status,
    verified,
    files,
    projectPath: hitName ? `docs/${missionId}/${hitName}` : null,
  }
}

/**
 * Row 173 (F146b-2): one deliverable per linked row. A row can hold several Studio documents (a first build the agent
 * abandoned, then a new document under another docKey); the row's deliverable is its verified document, else its newest
 * (updatedAt, then revisionNo, then the host order, which is newest first). Documents without a row link all stay.
 * The host's verified/final values are used as sent (row 136b), never re-derived.
 */
export function rowDeliverables(wires: DeliverableWire[]): DeliverableWire[] {
  const rowOf = (w: DeliverableWire) => w.rowId ?? rowIdOfKey(w.docKey)
  const better = (a: DeliverableWire, b: DeliverableWire) => {
    if ((a.verified === true) !== (b.verified === true)) return a.verified === true
    const at = timeOf(a.updatedAt) - timeOf(b.updatedAt)
    if (at !== 0) return at > 0
    return (a.revisionNo ?? 0) > (b.revisionNo ?? 0)
  }
  const chosen = new Map<string, DeliverableWire>()
  for (const w of wires) {
    const id = rowOf(w)
    if (!id) continue
    const held = chosen.get(id)
    if (!held || better(w, held)) chosen.set(id, w)
  }
  return wires.filter((w) => {
    const id = rowOf(w)
    return !id || chosen.get(id) === w
  })
}

function timeOf(value: string | undefined) {
  const ms = value ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : 0
}

/** §5-§7: the whole HQ model for one `studio_mission_get` answer. `present` = file names found in docs/<mission>/. */
export function buildMission(get: MissionGetWire, lang: "en" | "id", present: Set<string> = new Set()): MissionVM {
  const { mission, derived } = get
  const requests = get.requests ?? []
  const open = requests.filter((req) => req.status === "open")
  const rows = new Map(mission.rows.map((row) => [row.id, row]))
  const shown = mission.rows.filter((row) => row.status !== "dropped")

  const waveOf = new Map<string, number>()
  for (const wave of derived.waves) for (const id of wave.rows) waveOf.set(id, wave.wave)

  const phaseDefs = [...derived.phases].sort((a, b) => a.order - b.order)
  const phaseFamilyById = new Map(phaseDefs.map((p, i) => [p.id, phaseFamily(p.id, i + 1, phaseDefs.length)]))

  const deliverables = rowDeliverables(get.deliverables ?? []).map((d) => deliverableVM(d, mission.id, rows, present))

  const agents: Record<string, MissionAgentVM> = {}
  for (const row of shown) {
    const heldBy = open.filter((req) => req.blockingRows?.includes(row.id)).map((req) => req.id)
    const status = agentStatus(row.status, heldBy)
    if (!status) continue
    const look = agentLook(row.agent, phaseFamilyById.get(row.phase) ?? "build")
    const checkpoint = derived.checkpoints[row.id]
    agents[row.id] = {
      rowId: row.id,
      title: row.title,
      agent: row.agent,
      family: look.family,
      tool: look.tool,
      status,
      phase: row.phase,
      wave: waveOf.get(row.id) ?? null,
      checkpoint: checkpoint ? { n: checkpoint.n, m: checkpoint.m } : null,
      note: row.note,
      heldBy: status === "blocked" ? heldBy : [],
      deliverableId: deliverables.find((d) => d.rowId === row.id)?.documentId,
    }
  }

  const phases: MissionPhaseVM[] = phaseDefs.map((p) => {
    const ids = shown.filter((row) => row.phase === p.id).map((row) => row.id)
    const done = ids.filter((id) => agents[id]?.status === "done").length
    return {
      id: p.id,
      name: (lang === "id" ? p.name.id : p.name.en) || p.name.en || p.id,
      order: p.order,
      family: phaseFamilyById.get(p.id) ?? "build",
      rows: ids,
      done,
      total: ids.length,
      live: ids.some((id) => ["running", "review", "issue"].includes(agents[id]?.status ?? "")),
      allDone: ids.length > 0 && done === ids.length,
    }
  })

  const waveVMs: MissionWaveVM[] = derived.waves
    .map((wave) => {
      const ids = wave.rows.filter((id) => agents[id])
      const done = ids.filter((id) => agents[id].status === "done").length
      const tone: MissionWaveVM["tone"] =
        ids.length > 0 && done === ids.length ? "done" : ids.some((id) => agents[id].status === "issue") ? "issue" : "run"
      return { wave: wave.wave, done, total: ids.length, tone }
    })
    .filter((wave) => wave.total > 0)
    .sort((a, b) => a.wave - b.wave)
  const firstOpen = waveVMs.findIndex((wave) => wave.done < wave.total)
  const start = firstOpen >= 0 ? firstOpen : Math.max(0, waveVMs.length - WAVES_SHOWN)
  const waves = waveVMs.slice(start, start + WAVES_SHOWN)

  const oldestOpen = [...open].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt))[0]
  const decision: MissionDecisionVM | null = oldestOpen
    ? {
        id: oldestOpen.id,
        question: oldestOpen.question,
        context: oldestOpen.context,
        options: oldestOpen.options.map((opt) => ({
          id: opt.id,
          label: opt.label,
          consequence: opt.consequence,
          recommended: opt.id === oldestOpen.recommended,
        })),
      }
    : null

  const answeredReqs = requests
    .filter((req) => req.status === "answered" && req.answer)
    .sort((a, b) => timeOf(a.closedAt) - timeOf(b.closedAt))
  const labelOf = (req: DecisionRequestWire) =>
    req.options.find((opt) => opt.id === req.answer?.option)?.label ?? req.answer?.option ?? ""
  const latest = answeredReqs.at(-1)
  const answered: MissionAnsweredVM | null = latest
    ? { id: latest.id, question: latest.question, optionLabel: labelOf(latest), decision: latest.answer!.decision }
    : null

  const feed: MissionFeedLine[] = [
    ...(get.messages ?? []).map((msg) => ({
      key: `m${msg.seq}`,
      from: msg.from,
      to: msg.to,
      agent: msg.from === "agent" && msg.row ? rows.get(msg.row)?.agent : undefined,
      row: msg.row,
      text: msg.text,
      at: msg.at,
    })),
    ...answeredReqs.map((req) => ({
      key: `a${req.id}`,
      from: "owner" as const,
      to: "controller" as const,
      text: `${req.id}: ${labelOf(req)}`,
      at: req.closedAt ?? req.createdAt,
    })),
  ]
    .sort((a, b) => timeOf(a.at) - timeOf(b.at))
    .slice(-FEED_SIZE)

  const held = Object.values(agents).filter((a) => a.status === "issue" || a.status === "blocked").length
  const { done, total } = derived.progress

  return {
    id: mission.id,
    title: mission.title,
    type: mission.type,
    status: mission.status,
    progress: { done, total, pct: pct(done, total) },
    held,
    phases,
    layout: phases.length === 4 || phases.length === 5 ? "radial" : "lanes",
    agents,
    waves,
    decision,
    openDecisions: open.length,
    answered,
    feed,
    deliverables,
    finalCount: deliverables.filter((d) => d.status === "final").length,
  }
}

/** §5.6 "What's blocking?": issue rows with their note, blocked rows with the requests holding them. Empty = nothing held. */
export function blockingSummary(model: MissionVM): string[] {
  return Object.values(model.agents).flatMap((a) => {
    if (a.status === "issue") return [a.note ? `${a.rowId} ${a.title} (${a.note})` : `${a.rowId} ${a.title}`]
    if (a.status === "blocked") return [`${a.rowId} ${a.title} (${a.heldBy.join(", ")})`]
    return []
  })
}
