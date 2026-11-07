// Row 120 test helper: reads this task's HAND-WRITTEN blueprint (identification/02_structured.md) and decisions
// (decisions/decisions.md) READ-ONLY and maps them to mission rows and decisions as in mission contract §10.1.
// Every table line is kept with its file line number, so the generated lines can be diffed against it.
import { readFileSync } from "node:fs"

export const BLUEPRINT_HEADER = "| Step | Task Description | Agent_to_Invoke | Expected Output | Depends On | Verification | Phase |"
export const PROFILE_HEADER = "| Step | Ownership Area | Deps (kind) | Size | Model | Shared Resources | Checks | Review |"
export const DECISIONS_HEADER = "| # | Decision | By | Date |"

const LABEL_TO_KIND: Record<string, string> = {
  intake: "intake",
  research: "research",
  masterplan: "spec",
  synthesis: "synthesis",
  reproduce: "reproduce",
  diagnose: "diagnose",
  fix: "fix",
  implementation: "implementation",
  draft: "draft",
  test: "test",
  gateway_check: "gate",
  verification: "review",
  release: "release",
  publish: "publish",
  report: "report",
}
/** §10.1: gates before implementation belong to the research phase. */
const EARLY_GATES = new Set(["14", "18", "19", "21", "81"])
const phaseOf = (kind: string, id: string): string =>
  ({ intake: "identification", spec: "research", research: "research", implementation: "implementation", fix: "implementation", test: "verification", review: "verification", report: "release", release: "release" })[kind] ??
  (kind === "gate" ? (EARLY_GATES.has(id) ? "research" : "verification") : "implementation")

/** Split a table line into cells on unescaped ` | `; `\|` inside a cell is unescaped to `|`. */
export function cells(line: string): string[] {
  return line
    .replace(/^\| /, "")
    .replace(/ \|$/, "")
    .split(/(?<!\\) \| /)
    .map((c) => c.replace(/\\\|/g, "|"))
}

export interface HandLine {
  line: string
  lineNo: number
}
export interface ProfileSource {
  own: string
  deps: string
  size: string
  model: string
  resources: string
  checks: string
  review: string
  /** table = an 8-column profile line; prose8 / prose4 = a "Profile:" addendum line */
  form: "table" | "prose8" | "prose4"
  lineNo: number
}
export interface HandRow {
  id: string
  bp: string[]
  bpLine: HandLine
  profile?: ProfileSource
  profileLine?: HandLine
}

const ROW_ID = /^\| ([1-9][0-9]{0,3}[a-z]?) \|/

export function readBlueprint(file: string): { rows: HandRow[]; headerLines: { bp: number[]; profile: number[] }; rangeLines: HandLine[] } {
  const lines = readFileSync(file, "utf8").split("\n")
  const rows = new Map<string, HandRow>()
  const profiles = new Map<string, { p: ProfileSource; hl?: HandLine }>()
  const headerLines = { bp: [] as number[], profile: [] as number[] }
  const rangeLines: HandLine[] = []
  let mode: "bp" | "pf" | null = null
  lines.forEach((line, i) => {
    const lineNo = i + 1
    if (line === BLUEPRINT_HEADER) {
      mode = "bp"
      headerLines.bp.push(lineNo)
      return
    }
    if (line === PROFILE_HEADER) {
      mode = "pf"
      headerLines.profile.push(lineNo)
      return
    }
    if (!line.startsWith("|")) mode = null
    if (line.startsWith("Profile: ")) {
      for (const p of proseProfiles(line, lineNo)) profiles.set(p.id, { p: p.src })
      return
    }
    if (mode === null) return
    if (/^\| \d+-\d+ \|/.test(line)) rangeLines.push({ line, lineNo })
    const m = ROW_ID.exec(line)
    if (!m) return
    const c = cells(line)
    if (mode === "bp" && c.length === 7) rows.set(m[1]!, { id: m[1]!, bp: c, bpLine: { line, lineNo } })
    if (mode === "pf" && c.length === 8)
      profiles.set(m[1]!, { p: { own: c[1]!, deps: c[2]!, size: c[3]!, model: c[4]!, resources: c[5]!, checks: c[6]!, review: c[7]!, form: "table", lineNo }, hl: { line, lineNo } })
  })
  for (const [id, { p, hl }] of profiles) {
    const r = rows.get(id)
    if (r) {
      r.profile = p
      if (hl) r.profileLine = hl
    }
  }
  return { rows: [...rows.values()], headerLines, rangeLines }
}

/** "Profile:" addendum lines: `id | own | deps | size | model | res | checks | review` or `id own | deps | size | model.` */
function proseProfiles(line: string, lineNo: number): Array<{ id: string; src: ProfileSource }> {
  const out: Array<{ id: string; src: ProfileSource }> = []
  const p8 = /(?:^Profile: |\. )([1-9][0-9]{0,3}[a-z]?) \| ([^|]+?) \| ([^|]+?) \| ([SM-]) \| ([^|]+?) \| ([^|]+?) \| ([^|]+?) \| (gate|none)(?=\.|$)/g
  for (const m of line.matchAll(p8)) out.push({ id: m[1]!, src: { own: m[2]!, deps: m[3]!, size: m[4]!, model: m[5]!, resources: m[6]!, checks: m[7]!, review: m[8]!, form: "prose8", lineNo } })
  if (out.length > 0) return out
  const p4 = /(?:^Profile: |\. )([1-9][0-9]{0,3}[a-z]?) ([^|]+?) \| ([^|]+?) \| ([SM-]) \| ((?:opus|sonnet|inherit)(?: \([^)]*\))?)(?=\.|$)/g
  for (const m of line.matchAll(p4)) out.push({ id: m[1]!, src: { own: m[2]!, deps: m[3]!, size: m[4]!, model: m[5]!, resources: "-", checks: "-", review: "gate", form: "prose4", lineNo } })
  return out
}

export interface ImportNote {
  row: string
  note: string
}

/** §10.1 mapping of one hand-written row to a mission row input (status pending; the caller sets statuses). */
export function toMissionRow(r: HandRow, notes: ImportNote[]): Record<string, unknown> & { id: string; deps: string[]; size: "S" | "M" | null } {
  const [, title, agent, output, tableDeps, verification, label] = r.bp as [string, string, string, string, string, string, string]
  const kind = LABEL_TO_KIND[label]
  if (!kind) throw new Error(`row ${r.id}: unknown Phase label ${label}`)
  const rawDeps = tableDeps === "-" ? [] : tableDeps.split(", ")
  // Row 120d: a Depends On token that is not a row id (e.g. U23, a decision id) is not a mission dependency; the schema refuses it.
  const tDeps = rawDeps.filter((d) => /^[1-9][0-9]{0,3}[a-z]?$/.test(d))
  for (const d of rawDeps) if (!tDeps.includes(d)) notes.push({ row: r.id, note: `Depends On token ${d} is not a row id (decision reference), skipped` })
  let deps = tDeps.map((d) => `${d}:B`)
  let size: "S" | "M" | null = null
  let model: { tier: string; reason?: string } = { tier: "inherit" }
  let ownership: { text: string } | undefined
  let resources: string[] = []
  let checks: string | undefined
  let review = "gate"
  const p = r.profile
  if (p) {
    if (/^[1-9][0-9]{0,3}[a-z]?:[BC](, [1-9][0-9]{0,3}[a-z]?:[BC])*$/.test(p.deps)) {
      deps = p.deps.split(", ")
      const ids = deps.map((d) => d.split(":")[0])
      if (ids.join(",") !== rawDeps.join(",")) notes.push({ row: r.id, note: `profile deps ${ids.join(",")} != table deps ${rawDeps.join(",") || "-"} (profile used)` })
    } else if (p.deps !== "-") notes.push({ row: r.id, note: `profile deps not parseable ("${p.deps}"), table deps used as B` })
    size = p.size === "S" || p.size === "M" ? p.size : null
    const mm = /^(opus|sonnet|inherit)(?: \((.+)\))?$/.exec(p.model)
    if (mm) model = { tier: mm[1]!, ...(mm[2] ? { reason: mm[2] } : {}) }
    else notes.push({ row: r.id, note: `model "${p.model}" -> inherit` })
    if (p.own !== "-") ownership = { text: p.own }
    resources = p.resources === "-" ? [] : p.resources.split(/, (?![^()]*\))/)
    if (p.checks !== "-") checks = p.checks
    review = p.review
    if (p.form !== "table") notes.push({ row: r.id, note: `profile from a "Profile:" addendum line (${p.form}, :${p.lineNo})` })
  } else notes.push({ row: r.id, note: "no profile line (the range line covers it); table deps used as B" })
  return {
    id: r.id,
    phase: phaseOf(kind, r.id),
    kind,
    title,
    agent,
    model,
    ...(ownership ? { ownership } : {}),
    deps,
    size,
    status: "pending",
    output,
    verification,
    resources,
    ...(checks ? { checks } : {}),
    review,
  }
}

export interface HandDecision {
  id: string
  by: "user" | "controller"
  date: string
  text: string
  line: HandLine
}

export function readDecisions(file: string): { decisions: HandDecision[]; header: HandLine[] } {
  const lines = readFileSync(file, "utf8").split("\n")
  const decisions: HandDecision[] = []
  const header: HandLine[] = []
  lines.forEach((line, i) => {
    if (i < 4 && line.startsWith("|")) header.push({ line, lineNo: i + 1 })
    if (!/^\| [UC][1-9][0-9]{0,3} \|/.test(line)) return
    const c = cells(line)
    const by = c[c.length - 2]!.toLowerCase()
    if (by !== "user" && by !== "controller") throw new Error(`decision line ${i + 1}: By ${by}`)
    decisions.push({ id: c[0]!, by, date: c[c.length - 1]!, text: c.slice(1, -2).join(" | "), line: { line, lineNo: i + 1 } })
  })
  return { decisions, header }
}

/** The dropped rows 38-41 (02_structured.md:16; row 118 mapping, decision C19). */
export function droppedRow(id: string): Record<string, unknown> {
  return {
    id,
    phase: "implementation",
    kind: "fix",
    title: "Fix Studio toward Claude's v1.7 lint (U8, F18-1)",
    agent: "coder-execution",
    model: { tier: "opus" },
    deps: [],
    size: null,
    status: "dropped",
    output: "-",
    verification: "-",
    note: "Dropped under U16: Studio's engine is the standard (02_structured.md:16)",
    decision: "C19",
  }
}
