import type { GlobalSetup } from "@opencode-ai/sdk/v2/client"
import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

// Hand-written data-access seam between row 201's `GET /global/setup` route and rows 203-205's status card.
// It is NOT generated output: it imports the regenerated typed client (`@opencode-ai/sdk/v2/client`,
// produced by row 201) and wraps it. Nothing here is written into any `packages/sdk/**/gen` path.
//
// Why this file exists at all (masterplan/04_s6_status_spec.md §4 design principle): the route publishes
// observations and the card computes level values from them. The card must never collapse an unanswered
// question into a false answer, so this seam keeps every failure mode a *distinct value* rather than
// letting it fall through to "absent"/"not installed". The spec's degradation matrix (§5) is the source of
// every mapping below; each branch cites the cell it implements.

/** The seven register component ids (PC-CMP-01..07). Restated as literals because `packages/app` must not
 *  import `@swarm/setup` (dependency-direction rule, swarm/AGENTS.md); the route publishes these keys and
 *  the tripwire test in setup-status.test.ts asserts they match what the server returns. */
export const SETUP_COMPONENT_IDS = ["runtime", "node", "graft", "rtk", "obsidian", "searxng", "firecrawl"] as const
export type SetupComponentId = (typeof SETUP_COMPONENT_IDS)[number]

/** The four ladder surfaces (spec §1). graft/swarm-web are MCP entries; rtk/obsidian are skill texts only. */
export type SetupSurfaceId = "graft" | "swarm-web" | "rtk" | "obsidian"

// Skill relPaths come from the five TEXT_TARGETS (spec §4 registration.skills; register
// packages/setup/src/skills/researcher_text.ts:70-76). Only the two skill-only surfaces are keyed here.
const SURFACE_SKILL_PATH: Record<"rtk" | "obsidian", string> = {
  rtk: "skills/rtk/SKILL.md",
  obsidian: "skills/obsidian-inbox/SKILL.md",
}

/** A named reason for an `unknown` cell. Transport causes and record-level causes are kept in one union but
 *  produced by different layers, so the card can tell "we could not ask" from "the record could not answer". */
export type SetupUnknownCause =
  // transport-level (the read itself did not produce a usable payload)
  | "server_unreachable" // E1: fetch failed / no response
  | "not_provided_by_this_server" // E2: route absent on an older server (404 / unparseable body)
  | "http_error" // non-200 that is not a clean not-found (401, 500, ...)
  | "unrecognized_response" // 200 whose body does not match the published shape (version skew)
  // record-level (an ok read, but the record cannot answer this cell)
  | "unreadable" // E5a: stateFile.error starts "cannot read state file"
  | "unparseable" // E5b: stateFile.error names invalid JSON / non-object top level
  | "state_absent" // §2.1 item 1: a component entry carries no `state` key
  | "unrecognized_state" // §4 rule 2: a state string outside PC-ST-* is passed verbatim, not coerced
  | "not_observed" // E20-style: a surface the payload does not enumerate

/** Result of one transport-level read of `/global/setup`. `failed` never carries component data, which is the
 *  mechanical reason a transport failure cannot be rendered as "nothing installed": there is nothing to read. */
export type SetupRead =
  | { kind: "ok"; observed: GlobalSetup; receivedAt: number }
  | { kind: "failed"; cause: SetupUnknownCause; status?: number; message?: string }

/** A single level cell resolved from a read. `true`/`false` are positive claims; `unknown` always names why. */
export type SetupLevel =
  | { value: true }
  | { value: false; detail?: string }
  | { value: "unknown"; cause: SetupUnknownCause; detail?: string }

/** Minimal structural view of the generated client so tests can inject fakes without the full OpencodeClient.
 *  Matches the hey-api result tuple (`data`/`error`/`response`) the real `client.global.setup()` returns when
 *  called with `throwOnError: false`. */
export interface SetupStatusClient {
  global: {
    setup(options?: { throwOnError?: boolean; signal?: AbortSignal }): Promise<{
      data?: unknown
      error?: unknown
      response?: { status: number; ok?: boolean }
    }>
  }
}

const POLL_MS = 10_000 // matches the existing health poll cadence (utils/server-health.ts:115)

/** One-shot read. Polling is layered on top by `createSetupStatus`; the primitive stays synchronous to test. */
export async function readSetupStatus(
  client: SetupStatusClient,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<SetupRead> {
  try {
    const result = await client.global.setup({ throwOnError: false, signal })
    return classifySetupCall(result)
  } catch (error) {
    return classifySetupThrow(error)
  }
}

/** Classify a resolved hey-api result tuple. Kept pure so the skew case is provable without a network. */
export function classifySetupCall(result: {
  data?: unknown
  error?: unknown
  response?: { status: number; ok?: boolean }
}): SetupRead {
  const response = result.response
  // No response object means the fetch itself never completed (network failure or abort). E1.
  if (!response) {
    if (result.data !== undefined && isGlobalSetup(result.data)) {
      return { kind: "ok", observed: result.data, receivedAt: Date.now() }
    }
    return { kind: "failed", cause: "server_unreachable", message: describeError(result.error) }
  }
  // A clean not-found is the version-skew signal: an older server has no /global/setup. E2. It must degrade to
  // unknown, never to "nothing installed" — telling a user their tools vanished is the worst failure here.
  if (response.status === 404) return { kind: "failed", cause: "not_provided_by_this_server", status: 404 }
  if (response.ok === false || (response.ok === undefined && !isOkStatus(response.status))) {
    return { kind: "failed", cause: "http_error", status: response.status, message: describeError(result.error) }
  }
  // 2xx: the body must actually match the published shape, or we treat it as skew (E2 "unparseable body").
  if (result.data !== undefined && isGlobalSetup(result.data)) {
    return { kind: "ok", observed: result.data, receivedAt: Date.now() }
  }
  return { kind: "failed", cause: "unrecognized_response", status: response.status }
}

/** Classify a thrown error. The generated client throws on network failure even with throwOnError:false when
 *  a response interceptor rejects (e.g. an older server answering text/html for an unknown path), so a throw
 *  with no visible status degrades to unreachable; the card upgrades it to not-provided once health succeeds. */
export function classifySetupThrow(error: unknown): SetupRead {
  const status = httpStatusFromError(error)
  if (status === 404) return { kind: "failed", cause: "not_provided_by_this_server", status }
  if (status !== undefined && !isOkStatus(status)) {
    return { kind: "failed", cause: "http_error", status, message: describeError(error) }
  }
  return { kind: "failed", cause: "server_unreachable", message: describeError(error) }
}

/** Level 1 for one component (spec §3 level 1, §5 E3/E4/E5/E6/E7/E8). */
export function resolveInstalled(read: SetupRead, id: SetupComponentId): SetupLevel {
  if (read.kind === "failed") return { value: "unknown", cause: read.cause, detail: read.message }
  const stateFile = read.observed.stateFile
  if (typeof stateFile.error === "string" && stateFile.error.length > 0) {
    return { value: "unknown", cause: stateFileErrorCause(stateFile.error), detail: stateFile.error }
  }
  // Missing record is a known negative ("no setup state recorded"), NOT unknown (E3/E4). present===false is
  // set only on the existsSync branch by the route, so it is trustworthy evidence of absence.
  if (stateFile.present === false) return { value: false, detail: "no_state_record" }
  const component = read.observed.components?.[id]
  const state = component?.state
  if (state === undefined) return { value: "unknown", cause: "state_absent" }
  if (state === "healthy") return { value: true }
  if (isKnownState(state)) return { value: false, detail: state }
  // Outside PC-ST-*: pass it through as unknown rather than defaulting to absent (§4 rule 2).
  return { value: "unknown", cause: "unrecognized_state", detail: state }
}

/** Level 2 for one surface (spec §3 level 2, §5 E15/E16/E17/E19). Independent of the state file. */
export function resolveRegistered(read: SetupRead, surface: SetupSurfaceId): SetupLevel {
  if (read.kind === "failed") return { value: "unknown", cause: read.cause, detail: read.message }
  const registration = read.observed.registration
  const configFile = registration?.configFile
  if (!registration || !configFile) return { value: "unknown", cause: "unrecognized_response" }
  // A corrupt config is a known negative WITH the error, never silence (E16).
  if (typeof configFile.parseError === "string" && configFile.parseError.length > 0) {
    return { value: false, detail: configFile.parseError }
  }
  if (surface === "graft") return configFile.entries?.graft ? { value: true } : { value: false }
  if (surface === "swarm-web") return configFile.entries?.swarmWeb ? { value: true } : { value: false }
  const relPath = SURFACE_SKILL_PATH[surface]
  const skill = registration.skills?.find((entry) => entry.relPath === relPath)
  if (!skill) return { value: "unknown", cause: "not_observed", detail: relPath }
  return skill.present ? { value: true } : { value: false }
}

export type SetupStatusState = { read?: SetupRead; loading: boolean; fetchedAt?: number }

/** Thin polling hook over the one-shot reader. Default cadence matches the existing health poll; pass
 *  intervalMs:0 for a strict one-shot. Aborts the in-flight request on cleanup. The card owns WHEN to mount
 *  it (spec §11 leaves mount/poll to row 203); this only supplies fresh, honestly-typed observations. */
export function createSetupStatus(
  getClient: Accessor<SetupStatusClient | undefined>,
  options?: { intervalMs?: number },
) {
  const intervalMs = options?.intervalMs ?? POLL_MS
  const [state, setState] = createStore<SetupStatusState>({ loading: false })
  let controller: AbortController | undefined

  createEffect(() => {
    const client = getClient()
    if (!client) return
    let cancelled = false

    const run = async () => {
      controller?.abort()
      controller = new AbortController()
      setState("loading", true)
      const read = await readSetupStatus(client, controller.signal)
      if (cancelled) return
      setState({ read, loading: false, fetchedAt: Date.now() })
    }

    void run()
    if (intervalMs > 0) {
      const id = setInterval(() => void run(), intervalMs)
      onCleanup(() => clearInterval(id))
    }
    onCleanup(() => {
      cancelled = true
      controller?.abort()
    })
  })

  return state
}

function isOkStatus(status: number) {
  return status >= 200 && status < 300
}

function isKnownState(state: string) {
  return (
    state === "absent" ||
    state === "downloaded" ||
    state === "verified" ||
    state === "installed" ||
    state === "configured" ||
    state === "failed" ||
    state === "skipped" ||
    state === "BLOCKED_BY_NETWORK"
  )
}

function stateFileErrorCause(error: string): SetupUnknownCause {
  if (error.startsWith("cannot read state file")) return "unreadable" // E5a
  return "unparseable" // E5b: invalid JSON / top level not an object
}

// Structural guard for a 200 body. Deliberately shallow: it proves the four required top-level shapes are
// present so a different-version server's body is rejected as skew instead of half-trusted. Deep per-field
// validation is the route's job (it is a typed handler); the seam only refuses to render garbage as data.
function isGlobalSetup(value: unknown): value is GlobalSetup {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.observedAt !== "string") return false
  if (!isRecord(candidate.stateFile)) return false
  if (typeof candidate.stateFile.path !== "string" || typeof candidate.stateFile.present !== "boolean") return false
  if (!isRecord(candidate.components)) return false
  if (!isRecord(candidate.registration)) return false
  const registration = candidate.registration as Record<string, unknown>
  if (typeof registration.configDirPath !== "string") return false
  if (!isRecord(registration.configFile)) return false
  const configFile = registration.configFile as Record<string, unknown>
  if (typeof configFile.present !== "boolean") return false
  if (!isRecord(configFile.entries)) return false
  if (!Array.isArray(registration.skills)) return false
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function httpStatusFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const withResponse = error as { response?: { status?: unknown }; status?: unknown; cause?: unknown }
  if (typeof withResponse.response?.status === "number") return withResponse.response.status
  if (typeof withResponse.status === "number") return withResponse.status
  if (withResponse.cause) return httpStatusFromError(withResponse.cause)
  return undefined
}

function describeError(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return undefined
}
