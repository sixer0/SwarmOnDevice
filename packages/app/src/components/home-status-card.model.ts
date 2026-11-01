// Home status card — the pure content model (row 203).
//
// WHY THIS FILE IS SEPARATE FROM THE COMPONENT.
// The whole value of this card is that it reports four independent levels honestly and never collapses them
// into one verdict (masterplan/04_s6_status_spec.md §0, §6 R1/R2). Deciding *what each cell says* is the load-
// bearing, spec-bound logic; laying those decisions out as DOM is not. Keeping the decision here — pure, no
// JSX, no DOM, no i18n runtime — means every honesty rule in the spec's 21-cell degradation matrix (§5) is
// unit-testable in the plain `src` lane, where Solid JSX cannot render (packages/app/tsconfig.json:14 sets
// `"jsx": "preserve"` and the Solid compiler transform lives only in the Vite build; see the same constraint
// recorded at pages/new-session/new-session-view-mark.test.ts:19-23). The `.tsx` component maps the fields
// produced here onto elements; it adds no judgement of its own.
//
// WHAT MAY BE ASSERTED, FROM WHERE (spec §3): each cell draws ONLY from its own level's source and names that
// source. Levels 1-2 come from the `/global/setup` seam (context/setup-status.ts); level 3 comes from an
// optional `GET /mcp` observation the caller supplies; level 4 asserts nothing. A cell may not be derived from
// another level's source (R2), so nothing below reads across levels.

import { resolveInstalled, resolveRegistered, type SetupLevel, type SetupSurfaceId, type SetupRead, type SetupComponentId } from "../context/setup-status"

/** The five members of MCP.Status the running server can return (opencode/src/mcp/index.ts:84-109), plus the
 *  two values this card adds that are NOT server statuses: `unknown` (we could not ask / did not observe) and
 *  `not_applicable` (the surface is not an MCP server at all — a category fact, spec E19). */
export type McpStatusValue =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

/** One directory-scoped `GET /mcp` observation. `servers` absent means the query was never enabled for this
 *  scope, which is NOT the same as "nothing configured" (spec §3.3 empty-map trap, E20). */
export type Level3Input = {
  /** The directory/server this map was read for, shown so a reader knows the scope (spec §3.2). */
  scopeLabel: string
  /** Client-side moment this map arrived. Undefined when the map was never fetched. Never conflated with the
   *  server's `observedAt` (spec §4 rule 1). */
  receivedAt?: number
  /** Keyed by MCP server name. Absent => not observed (E20); a present-but-empty object is genuinely empty. */
  servers?: Record<string, McpStatusValue>
}

/** How a cell reads, structurally. `yes`/`no` are positive claims; `unknown` always names a cause; the last two
 *  are the non-values the spec requires (rtk's category mismatch, level 4's deliberate silence). */
export type CellKind = "yes" | "no" | "unknown" | "not_applicable" | "not_claimed"

/** A single resolved cell. Exactly one of `labelKey` (a translatable value word) or `token` (an R7 monospace
 *  technical datum) carries the primary value; `causeToken`/`detailToken` are always monospace data, never copy. */
export type Cell = {
  kind: CellKind
  /** i18n key for a translatable value word (level-3 statuses, `unknown`, level-4 non-claim). Omitted when the
   *  value is a technical token (level-1 state, level-2 presence) that R7 forbids translating. */
  labelKey?: string
  /** Monospace technical token shown as-is: a PC-ST-* state, a presence word, a status id. Data, not copy (R7). */
  token?: string
  /** Named reason for an `unknown`/`not_applicable`, rendered as a monospace token (spec §2.3: causes are tokens). */
  causeToken?: string
  /** Verbatim detail (a parse error, an MCP error string) shown monospace, never paraphrased (E12/E16). */
  detailToken?: string
  /** The source this cell was computed from, named in the UI (spec §3 "Source (named in the UI)"). */
  sourceToken: string
}

export type LadderRow = {
  surface: SetupSurfaceId
  installed: Cell
  registered: Cell
  visible: Cell
  used: Cell
}

export type SetupRecordRow = { component: SetupComponentId; cell: Cell }

export type StatusCardModel = {
  ladder: LadderRow[]
  /** The seven-component register list, kept as its own clearly-labelled block and NEVER merged into the
   *  ladder rows or counted across them (spec §6 R6). */
  records: SetupRecordRow[]
  /** Freshness for levels 1-2. `observedAt` is the server's read time; `receivedAt` is the client's arrival time.
   *  They answer different questions and are kept as separate fields (spec §4 rule 1, R3). */
  freshness: { observedAt?: string; receivedAt?: number }
  /** Which config directory the level-2 read actually asked about (spec §2 requirement). */
  configDirPath?: string
  /** The state file the level-1 read actually opened (spec §4 stateFile.path). */
  stateFilePath?: string
  /** The MCP scope level 3 was read for, or undefined when level 3 was never observed. */
  level3Scope?: string
}

// The four surfaces the ladder runs over (spec §1). graft and swarm-web are MCP entries; rtk and obsidian are
// skill texts only, so their level-3 cell is a category non-value, not a status (E19).
const SURFACES: readonly SetupSurfaceId[] = ["graft", "swarm-web", "rtk", "obsidian"]

// Level 1 is a claim about a *component record*. graft/rtk/obsidian have a same-named component; swarm-web does
// not (its install evidence is searxng health plus a proxy binary the state file cannot see — spec §7.3), so its
// level-1 cell is honestly `unknown / not_observed` rather than borrowed from another component (R2).
const SURFACE_COMPONENT: Partial<Record<SetupSurfaceId, SetupComponentId>> = {
  graft: "graft",
  rtk: "rtk",
  obsidian: "obsidian",
}

// graft and swarm-web are MCP servers; rtk and obsidian are skill texts the writer never registers as MCP
// (config_writer.ts:187-232), so asking the MCP map about them is a category mismatch (E19).
const MCP_SURFACES: ReadonlySet<SetupSurfaceId> = new Set(["graft", "swarm-web"])

// The MCP server key the writer emits for the swarm-web surface is literally "swarm-web" (register.ts:9).
const MCP_KEY: Partial<Record<SetupSurfaceId, string>> = { graft: "graft", "swarm-web": "swarm-web" }

/** Build the whole card model from one setup read plus an optional MCP observation. Pure and synchronous. */
export function buildStatusCardModel(input: {
  read: SetupRead | undefined
  loading: boolean
  mcp?: Level3Input
}): StatusCardModel {
  const { read, loading, mcp } = input
  const freshness = read?.kind === "ok" ? { observedAt: read.observed.observedAt, receivedAt: read.receivedAt } : {}
  const ok = read?.kind === "ok" ? read : undefined

  const ladder: LadderRow[] = SURFACES.map((surface) => ({
    surface,
    installed: installedCell(read, surface),
    registered: registeredCell(read, surface),
    visible: visibleCell(surface, mcp),
    used: usedCell(),
  }))

  const records: SetupRecordRow[] = read
    ? (Object.keys(read.kind === "ok" ? read.observed.components ?? {} : {}) as SetupComponentId[]).map((component) => ({
        component,
        cell: recordCell(read, component),
      }))
    : []

  return {
    ladder,
    records,
    freshness,
    configDirPath: ok?.observed.registration.configDirPath,
    stateFilePath: ok?.observed.stateFile.path,
    level3Scope: mcp?.scopeLabel,
  }
}

function installedCell(read: SetupRead | undefined, surface: SetupSurfaceId): Cell {
  const source = "~/.swarm/setup/state.json"
  // A failed read means nothing was asked successfully, so EVERY surface's level 1 carries the transport cause
  // (E1: "levels 1, 2 and 3: unknown, cause server_unreachable"). This precedes the structural no-component branch
  // below, which only speaks for an ok read where we did get data back.
  if (!read) return { kind: "unknown", causeToken: "not_observed", labelKey: "common.unknown", sourceToken: source }
  if (read.kind === "failed")
    return { kind: "unknown", causeToken: read.cause, labelKey: "common.unknown", detailToken: read.message, sourceToken: source }
  const component = SURFACE_COMPONENT[surface]
  if (!component) {
    // swarm-web on an ok read: no component record carries it; do not borrow searxng's health (R2).
    return { kind: "unknown", causeToken: "not_observed", labelKey: "common.unknown", sourceToken: source }
  }
  return levelToCell(resolveInstalled(read, component), source, "healthy")
}

function registeredCell(read: SetupRead | undefined, surface: SetupSurfaceId): Cell {
  if (!read) return pendingOrUnknown(surface)
  // F-04: level 2 names the directory the SERVER reported (spec §2's publication requirement), never a re-typed
  // literal. A failed read carries no payload at all (context/setup-status.ts:48-51), so it has no path to
  // display and keeps the technical token `unknown`; an ok read always carries a string configDirPath because
  // the seam refuses any 200 body without one (setup-status.ts:236-239). The `|| "unknown"` covers a published
  // empty string, which would otherwise paint a blank source.
  const source = read.kind === "ok" ? read.observed.registration.configDirPath : "unknown"
  return levelToCell(resolveRegistered(read, surface), source || "unknown", "present")
}

function visibleCell(surface: SetupSurfaceId, mcp: Level3Input | undefined): Cell {
  const source = `GET /mcp${mcp ? ` (${mcp.scopeLabel})` : ""}`
  if (!MCP_SURFACES.has(surface)) {
    // rtk / obsidian: absence from an MCP-keyed map is a category fact, never "not visible" (E19, AC-192-6).
    return { kind: "not_applicable", causeToken: "not_an_mcp_server", token: "not_applicable", sourceToken: source }
  }
  const key = MCP_KEY[surface] ?? surface
  if (!mcp || mcp.servers === undefined) {
    // The query was never enabled for this scope. Empty would be indistinguishable from three worlds (§3.3), so
    // the honest value is unknown/not_observed, not "nothing configured" (E20, AC-192-8).
    return { kind: "unknown", causeToken: "not_observed", labelKey: "common.unknown", sourceToken: source }
  }
  const value = mcp.servers[key]
  if (!value) {
    // Config written but the server has no key in the live map (E10). Asked about, not started by this card.
    return { kind: "unknown", causeToken: "not_observed", labelKey: "common.unknown", sourceToken: source }
  }
  return mcpStatusCell(value, source)
}

// Level 4 asserts nothing about any surface (spec §3 level 4, E21, AC-192-1). Its rendered meaning is the
// deliberate non-claim; it is never a grey tick and never borrows `unknown` (inventory §4 anti-inversion).
function usedCell(): Cell {
  return { kind: "not_claimed", labelKey: "setup.status.notClaimed", sourceToken: "provider transcript (not read)" }
}

function mcpStatusCell(value: McpStatusValue, source: string): Cell {
  switch (value.status) {
    case "connected":
      return { kind: "yes", labelKey: "mcp.status.connected", sourceToken: source }
    case "disabled":
      // E9/E11: `disabled` may never carry a cause — three producers land on the same value (R5).
      return { kind: "no", labelKey: "mcp.status.disabled", sourceToken: source }
    case "failed":
      // E12: show the error verbatim as a token, never a paraphrase.
      return { kind: "no", labelKey: "mcp.status.failed", detailToken: value.error, sourceToken: source }
    case "needs_auth":
      return { kind: "unknown", labelKey: "mcp.status.needs_auth", sourceToken: source }
    case "needs_client_registration":
      // E14: this key must resolve in en.ts (row 204 lands it); the error rides as a monospace token.
      return { kind: "unknown", labelKey: "mcp.status.needs_client_registration", detailToken: value.error, sourceToken: source }
  }
}

function recordCell(read: SetupRead, component: SetupComponentId): Cell {
  return levelToCell(resolveInstalled(read, component), "~/.swarm/setup/state.json", "healthy")
}

/** Turn a seam `SetupLevel` into a cell. The seam already owns the unknown-vs-false split (every transport
 *  failure is `unknown`; `false` arises only from an ok read with positive evidence), so this function never
 *  re-derives it — it only chooses token-vs-label presentation and names the source. `trueToken` is the verbatim
 *  datum a positive claim rests on: level 1 `true` means the record read `healthy` (spec §3), level 2 `true` means
 *  the config entry is present. Both are R7 monospace data, not copy. */
function levelToCell(level: SetupLevel, source: string, trueToken: string): Cell {
  if (level.value === true) return { kind: "yes", token: trueToken, sourceToken: source }
  if (level.value === false) {
    // Known negative carrying its own reason token (a PC-ST-* state, `no_state_record`, or a parse error verbatim).
    return { kind: "no", token: level.detail ?? "absent", sourceToken: source }
  }
  // unknown: always names its cause as a monospace token (R4 makes this renderable and non-failing).
  return { kind: "unknown", causeToken: level.cause, labelKey: "common.unknown", detailToken: level.detail, sourceToken: source }
}

function pendingOrUnknown(surface: SetupSurfaceId): Cell {
  // No read yet. `loading` is rendered by the component via common.loading; the model marks the cell unknown so
  // a caller that never sees a read still cannot render a false. Surface is unused today but kept for clarity.
  void surface
  return { kind: "unknown", causeToken: "not_observed", labelKey: "common.unknown", sourceToken: "~/.swarm/setup/state.json" }
}

/** Whether Home should point at the card. The one place a read becomes a yes or no, and it says no more than "go and
 *  look": the card stays four independent levels. Only positive evidence that something broke counts. A machine where
 *  setup never ran (`no_state_record`), a server that could not be asked and a skipped tool are all normal, so a first
 *  launch shows nothing. */
export function setupNeedsAttention(read: SetupRead | undefined) {
  if (read?.kind !== "ok") return false
  if (read.observed.stateFile.error || read.observed.registration.configFile.parseError) return true
  return Object.values(read.observed.components ?? {}).some(
    (component) => component?.state === "failed" || component?.state === "BLOCKED_BY_NETWORK",
  )
}

/** Flatten every literal (non-translated) token the card will paint, for the mechanical no-aggregate and
 *  vocabulary checks. Translated labels are represented by their keys, so a raw English verdict word can never
 *  appear here by accident. */
export function collectLiteralTokens(model: StatusCardModel): string[] {
  const out: string[] = []
  const push = (cell: Cell) => {
    if (cell.token) out.push(cell.token)
    if (cell.causeToken) out.push(cell.causeToken)
    if (cell.detailToken) out.push(cell.detailToken)
    out.push(cell.sourceToken)
  }
  for (const row of model.ladder) [row.installed, row.registered, row.visible, row.used].forEach(push)
  for (const rec of model.records) push(rec.cell)
  if (model.freshness.observedAt) out.push(model.freshness.observedAt)
  return out
}
