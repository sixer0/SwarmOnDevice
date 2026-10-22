// Lane controls + monitoring read-out — the pure content model (row 248, blueprint 11).
//
// WHY THIS FILE IS SEPARATE FROM THE COMPONENT (same discipline as home-status-card.model.ts, row 203).
// The whole value of this surface is honesty about three numbers: it shows the tuple that exists, never one
// collapsed figure; it never renders the four inert vendor keys as values; it keeps stored distinct from
// observed; and a transport failure can never produce a number. Deciding *what each control says* is the
// load-bearing, spec-bound logic (masterplan/06_s6b_lanes_spec.md §3-§5.4, decisions.md gate-239 forks G/H);
// laying those decisions out as DOM is not. Solid JSX cannot render in the plain `src` unit lane
// (packages/app/tsconfig.json:14 `"jsx": "preserve"`; the compiler transform is Vite-only — the same constraint
// recorded at home-status-card.model.test.ts:6-10), so isolating the decisions here makes every rule
// unit-testable. The `.tsx` maps these fields onto elements one-to-one and adds no judgement of its own.
//
// WHAT MAY BE ASSERTED, FROM WHERE. Everything below is derived ONLY from the `GET/PATCH /global/lanes`
// payload row 247 landed (implementation/s6b_d5_route.md §1, §endpoints; packages/sdk/js/src/v2/gen/types.gen.ts
// GlobalLanes/GlobalLaneRange/GlobalLanesObservedEntry). The card never reads the filesystem, never spawns,
// never polls at health cadence (row 247 §10 item 7 warns each GET execs up to five docker children). It mirrors
// row 247's OWN three-state vocabulary — observed / absent / unobserved(reason) — rather than inventing a second
// one (dispatch item 4).

import type { GlobalLanes, GlobalLanesObservedEntry, GlobalLanesPatchInput, GlobalLanesState } from "@opencode-ai/sdk/v2/client"

/** The three controls this pinned build actually reads (06 §3.1 C-1/C-2/C-3; LANE_CONTROLS in
 *  packages/setup/src/composefiles/lanes.ts, imported by the route as the single validator). Keyed by env name,
 *  which IS the file key (§2.4), so there is no indirection that could drift from the knob it stands for. */
export const LANE_CONTROL_KEYS = ["NUQ_WORKER_COUNT", "MAX_CONCURRENT_PAGES", "GRANIAN_BLOCKING_THREADS"] as const
export type LaneControlKey = (typeof LANE_CONTROL_KEYS)[number]

/** The four Firecrawl keys row 236 proved are INERT in the pinned api image — absent from its own config schema
 *  and from every file under /app (06 §1.1, research/s6b_06_upstream_defaults.md §3). They are documented-not-
 *  effective: rendering any of them as a value would be a UI that lies, the exact failure this session has
 *  enforced since the knob discovery (dispatch item 2). The model filters them out defensively even if a hostile
 *  or stale payload ever surfaced them, and a test proves none appears. */
export const INERT_VENDOR_KEYS = ["NUM_WORKERS_PER_QUEUE", "CRAWL_CONCURRENT_REQUESTS", "MAX_CONCURRENT_JOBS", "BROWSER_POOL_SIZE"] as const

/** Transport causes (the read itself produced no usable payload) and record-level causes, kept in one union so
 *  the card can tell "we could not ask" from "the file could not answer". Mirrors setup-status.ts's posture:
 *  a transport failure NEVER collapses into a value or a `false`. */
export type LaneUnknownCause =
  | "server_unreachable" // fetch failed / no response (E1 class)
  | "not_provided_by_this_server" // 404: an older server has no /global/lanes (E2 class)
  | "http_error" // non-2xx that is not a clean not-found (401 auth, 500, ...)
  | "unrecognized_response" // 200 whose body does not match the published shape (version skew)
  | "file_unreadable" // ok read, but lanes.json could not be opened (route set file.error)
  | "file_invalid" // ok read, but lanes.json failed validation (route omitted `stored`)
  | "not_observed" // a control the payload simply does not enumerate

/** Result of one transport-level read of `/global/lanes`. The `failed` arm carries NO lane data at all — that
 *  absence is the structural reason a transport failure cannot be rendered as a number: there is nothing here to
 *  read a value from (the anti-collapse invariant, proven behaviourally + structurally in the test file). */
export type LaneRead =
  | { kind: "ok"; observed: GlobalLanes; receivedAt: number }
  | { kind: "failed"; cause: LaneUnknownCause; status?: number; message?: string }

/** Minimal structural view of the generated client so tests inject fakes without the full OpencodeClient. Matches
 *  the hey-api result tuple (`data`/`error`/`response`) the real `client.global.lanes.get()/update()` returns when
 *  called with `throwOnError: false`, exactly as setup-status.ts models its own seam. */
export interface LaneStatusClient {
  global: {
    lanes: {
      get(options?: { throwOnError?: boolean; signal?: AbortSignal }): Promise<{
        data?: unknown
        error?: unknown
        response?: { status: number; ok?: boolean }
      }>
      update(
        parameters?: { globalLanesPatchInput?: GlobalLanesPatchInput },
        options?: { throwOnError?: boolean; signal?: AbortSignal },
      ): Promise<{
        data?: unknown
        error?: unknown
        response?: { status: number; ok?: boolean }
      }>
    }
  }
}

/** The three-state observed cell, mirroring GlobalLanesObservedEntry EXACTLY (row 247 §6). Each state renders
 *  differently and honestly: `observed` carries a real reading, `absent` is an OBSERVED absence (carrier up, key
 *  not in its environment), `unobserved` names why we could not look. None of them may collapse to a value or to
 *  `false`. */
export type ObservedCell =
  | { state: "observed"; value: number }
  | { state: "absent" }
  | { state: "unobserved"; reason: string }

/** The stored cell. `present` means the committed file carries this integer; `absent` means either no file, the
 *  key is unset in it, or the file failed validation (route omits `stored`). Absence NEVER renders as a number. */
export type StoredCell = { state: "present"; value: number } | { state: "absent" }

export type LaneControlCell = {
  key: LaneControlKey
  stack: string
  service: string
  /** Validator bounds straight off the shipped table (fork H: NUQ min 4 is a REFUSAL boundary, not a default). */
  min: number
  max: number
  /** What swarm-setup writes create-if-absent (5 for NUQ per fork H; the value the control pre-offers when nothing
   *  is stored yet). Displayed as a monospace token, never translated. */
  setupValue: number
  /** The value the numeric input defaults to: the stored choice if present, else setupValue. For NUQ on a fresh
   *  estate this is 5, NOT the floor 4 (dispatch item 3). */
  offeredValue: number
  /** Every control in this family is recreate-class (06 §3.1/§5.3); stated on the control's own face so no dial
   *  implies "takes effect immediately" over a recreate-backed knob (dispatch item 1). */
  restartClass: "container-recreate"
  stored: StoredCell
  observed: ObservedCell
  /** Where this cell came from: the tilde-form file path on an ok read, or the token `unknown` on a transport
   *  failure (never a fabricated path — the same F-04 lesson the sibling card learned). */
  sourceToken: string
}

export type LaneControlModel = {
  controls: LaneControlCell[]
  restartRequired: "container-recreate"
  freshness: { observedAt?: string; receivedAt?: number }
  /** Tilde-form path only (row 247 §5); the absolute form never reaches the client, so it cannot reach the card. */
  filePath?: string
  filePresent?: boolean
  /** Verbatim file.error (an unreadable/invalid lanes.json), shown monospace like the card's other detail tokens. */
  fileError?: string
  updatedAt?: string
}

/** Build the whole lane model from one read. Pure and synchronous. On a transport failure EVERY control still
 *  appears (so the card never silently drops a knob), but each carries stored=absent and observed=unobserved with
 *  the transport cause as its reason, and NO cell carries a number — the anti-collapse guarantee. */
export function buildLaneControlModel(read: LaneRead | undefined): LaneControlModel {
  if (!read) {
    return {
      controls: LANE_CONTROL_KEYS.map((key) => degradedControl(key, "not_observed")),
      restartRequired: "container-recreate",
      freshness: {},
    }
  }
  if (read.kind === "failed") {
    return {
      controls: LANE_CONTROL_KEYS.map((key) => degradedControl(key, read.cause)),
      restartRequired: "container-recreate",
      freshness: {},
    }
  }

  const lanes = read.observed
  const source = lanes.file?.tildePath || "unknown"
  const fileInvalid = typeof lanes.file?.error === "string" && lanes.file.error.length > 0
  const storedMap = lanes.stored

  const controls = LANE_CONTROL_KEYS.map((key) => {
    const range = lanes.range?.[key]
    // A control the payload does not describe cannot be shown with bounds; degrade it honestly rather than guess.
    if (!range || typeof range.min !== "number" || typeof range.max !== "number") {
      return degradedControl(key, "not_observed")
    }
    const storedValue = storedMap?.[key]
    const stored: StoredCell =
      typeof storedValue === "number" ? { state: "present", value: storedValue } : { state: "absent" }
    const offeredValue = typeof storedValue === "number" ? storedValue : range.setupValue
    return {
      key,
      stack: range.stack,
      service: range.service,
      min: range.min,
      max: range.max,
      setupValue: range.setupValue,
      offeredValue,
      restartClass: "container-recreate" as const,
      stored,
      observed: mapObserved(lanes.observed?.[key]),
      sourceToken: source,
    }
  })

  return {
    controls,
    restartRequired: "container-recreate",
    freshness: { observedAt: lanes.observedAt, receivedAt: read.receivedAt },
    filePath: lanes.file?.tildePath,
    filePresent: lanes.file?.present,
    fileError: fileInvalid ? lanes.file?.error : undefined,
    updatedAt: lanes.updatedAt,
  }
}

/** Map the route's observed entry to the card's three-state cell. An absent key in the map is `unobserved` with a
 *  named reason, never a value and never `false` (dispatch item 4). */
function mapObserved(entry: GlobalLanesObservedEntry | undefined): ObservedCell {
  if (!entry || typeof entry !== "object") return { state: "unobserved", reason: "not_observed" }
  if (entry.status === "observed") return { state: "observed", value: entry.value }
  if (entry.status === "absent") return { state: "absent" }
  if (entry.status === "unobserved") return { state: "unobserved", reason: entry.reason }
  // An unrecognised arm (future route version) degrades to unobserved rather than defaulting to a value.
  return { state: "unobserved", reason: "unrecognized_observation" }
}

function degradedControl(key: LaneControlKey, cause: LaneUnknownCause): LaneControlCell {
  // Bounds are unknown on a degraded read, so we publish none (0/0 would be a lie); the control still lists so a
  // knob is never silently hidden. offeredValue stays undefined-by-shape: we carry no number at all here.
  return {
    key,
    stack: "unknown",
    service: "unknown",
    min: NaN,
    max: NaN,
    setupValue: NaN,
    offeredValue: NaN,
    restartClass: "container-recreate",
    stored: { state: "absent" },
    observed: { state: "unobserved", reason: cause },
    sourceToken: "unknown",
  }
}

// ── Read classification (mirrors setup-status.ts; kept pure so the skew case is provable without a network) ──

/** Classify a resolved hey-api GET result tuple into a LaneRead. The failed arm never carries lane data. */
export function classifyLanesCall(result: {
  data?: unknown
  error?: unknown
  response?: { status: number; ok?: boolean }
}): LaneRead {
  const response = result.response
  if (!response) {
    if (result.data !== undefined && isGlobalLanes(result.data)) return { kind: "ok", observed: result.data, receivedAt: Date.now() }
    return { kind: "failed", cause: "server_unreachable", message: describeError(result.error) }
  }
  if (response.status === 404) return { kind: "failed", cause: "not_provided_by_this_server", status: 404 }
  if (response.ok === false || (response.ok === undefined && !isOkStatus(response.status))) {
    return { kind: "failed", cause: "http_error", status: response.status, message: describeError(result.error) }
  }
  if (result.data !== undefined && isGlobalLanes(result.data)) return { kind: "ok", observed: result.data, receivedAt: Date.now() }
  return { kind: "failed", cause: "unrecognized_response", status: response.status }
}

/** Classify a thrown GET error. A throw with no visible status degrades to unreachable, never to "unconfigured". */
export function classifyLanesThrow(error: unknown): LaneRead {
  const status = httpStatusFromError(error)
  if (status === 404) return { kind: "failed", cause: "not_provided_by_this_server", status }
  if (status !== undefined && !isOkStatus(status)) return { kind: "failed", cause: "http_error", status, message: describeError(error) }
  return { kind: "failed", cause: "server_unreachable", message: describeError(error) }
}

export async function readLaneStatus(
  client: LaneStatusClient,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<LaneRead> {
  try {
    const result = await client.global.lanes.get({ throwOnError: false, signal })
    const read = classifyLanesCall(result)
    // Stamp arrival time through the injected clock so tests control freshness (matches readSetupStatus's shape).
    return read.kind === "ok" ? { ...read, receivedAt: now() } : read
  } catch (error) {
    return classifyLanesThrow(error)
  }
}

// ── Write path (work item 5) ────────────────────────────────────────────────────────────────────────────────

/** Build a PATCH body carrying exactly one control change. The closed three-key vocabulary is enforced here: an
 *  inert key or a relabelling is refused LOCALLY before any request, so the UI cannot even attempt to write a knob
 *  the build does not read (06 §4.3 "never accept a free-form value"). */
export function buildLanePatchBody(key: string, value: number): { ok: true; body: GlobalLanesPatchInput } | { ok: false; token: "LANE_VALUE_NOT_A_LANE"; key: string } {
  if (!(LANE_CONTROL_KEYS as readonly string[]).includes(key)) return { ok: false, token: "LANE_VALUE_NOT_A_LANE", key }
  return { ok: true, body: { [key]: value } as GlobalLanesPatchInput }
}

export type PatchOutcome =
  /** The route committed the tuple. It returns GlobalLanesState, which has NO observed field — so this outcome
   *  deliberately carries no effective/applied claim, only the new stored map + the recreate requirement. */
  | { kind: "applied"; stored?: Record<string, number>; restartRequired: "container-recreate"; updatedAt?: string }
  /** The route refused. Carries the spec's token verbatim + the offending key/value/range it echoed — NEVER a
   *  clamped substitute (06 §4 "refusal, not coercion"; dispatch item 5). */
  | { kind: "refused"; token: string; key?: string; value?: number; range?: { min: number; max: number }; reason?: string }
  /** Transport/auth failure — the write did not happen and we say so, without pretending otherwise. */
  | { kind: "failed"; cause: LaneUnknownCause; status?: number; message?: string }

/** Classify a resolved PATCH result tuple. 2xx must match the GlobalLanesState shape or it is skew, not success. */
export function classifyPatchCall(result: {
  data?: unknown
  error?: unknown
  response?: { status: number; ok?: boolean }
}): PatchOutcome {
  const response = result.response
  if (!response) {
    if (result.data !== undefined && isGlobalLanesState(result.data)) return appliedFromState(result.data)
    return { kind: "failed", cause: "server_unreachable", message: describeError(result.error) }
  }
  // 400 is the refusal channel: the body is { error: { code, key?, value?, range?, reason? } }.
  if (response.status === 400) return refusedFromBody(result.data, result.error)
  if (response.status === 404) return { kind: "failed", cause: "not_provided_by_this_server", status: 404 }
  if (response.ok === false || (response.ok === undefined && !isOkStatus(response.status))) {
    return { kind: "failed", cause: "http_error", status: response.status, message: describeError(result.error ?? result.data) }
  }
  if (result.data !== undefined && isGlobalLanesState(result.data)) return appliedFromState(result.data)
  return { kind: "failed", cause: "unrecognized_response", status: response.status }
}

export function classifyPatchThrow(error: unknown): PatchOutcome {
  const status = httpStatusFromError(error)
  if (status === 400) return refusedFromBody(error, error)
  if (status === 404) return { kind: "failed", cause: "not_provided_by_this_server", status }
  if (status !== undefined && !isOkStatus(status)) return { kind: "failed", cause: "http_error", status, message: describeError(error) }
  return { kind: "failed", cause: "server_unreachable", message: describeError(error) }
}

/** Send one control change. Returns the classified outcome; the caller renders applied/refused/failed distinctly. */
export async function patchLaneControl(
  client: LaneStatusClient,
  key: string,
  value: number,
  signal?: AbortSignal,
): Promise<PatchOutcome> {
  const built = buildLanePatchBody(key, value)
  if (!built.ok) return { kind: "refused", token: built.token, key: built.key }
  try {
    const result = await client.global.lanes.update({ globalLanesPatchInput: built.body }, { throwOnError: false, signal })
    return classifyPatchCall(result)
  } catch (error) {
    return classifyPatchThrow(error)
  }
}

function appliedFromState(state: GlobalLanesState): PatchOutcome {
  return { kind: "applied", stored: state.stored, restartRequired: state.restartRequired, updatedAt: state.updatedAt }
}

function refusedFromBody(data: unknown, error: unknown): PatchOutcome {
  const body = extractErrorObject(data) ?? extractErrorObject(error)
  if (!body || typeof body.code !== "string") {
    // A 400 we cannot parse as a token body is still a refusal, but we can only report the shape honestly.
    return { kind: "refused", token: "LANE_REFUSAL_UNPARSEABLE" }
  }
  return {
    kind: "refused",
    token: body.code,
    key: typeof body.key === "string" ? body.key : undefined,
    value: typeof body.value === "number" ? body.value : undefined,
    range: isRange(body.range) ? { min: body.range.min, max: body.range.max } : undefined,
    reason: typeof body.reason === "string" ? body.reason : undefined,
  }
}

function extractErrorObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (isRecord(candidate.error)) return candidate.error
  if (typeof candidate.code === "string") return candidate
  return undefined
}

function isRange(value: unknown): value is { min: number; max: number } {
  return isRecord(value) && typeof value.min === "number" && typeof value.max === "number"
}

// ── Structural guards (shallow, like isGlobalSetup): refuse a different-version body as skew, never half-trust ──

function isGlobalLanes(value: unknown): value is GlobalLanes {
  if (!isRecord(value)) return false
  if (typeof value.observedAt !== "string") return false
  if (!isRecord(value.file)) return false
  if (typeof value.file.tildePath !== "string" || typeof value.file.present !== "boolean") return false
  if (!isRecord(value.range)) return false
  if (!isRecord(value.observed)) return false
  if (value.restartRequired !== "container-recreate") return false
  if (value.stored !== undefined && !isRecord(value.stored)) return false
  return true
}

function isGlobalLanesState(value: unknown): value is GlobalLanesState {
  if (!isRecord(value)) return false
  if (typeof value.observedAt !== "string") return false
  if (!isRecord(value.file)) return false
  if (typeof value.file.tildePath !== "string") return false
  if (!isRecord(value.range)) return false
  if (value.restartRequired !== "container-recreate") return false
  if (value.stored !== undefined && !isRecord(value.stored)) return false
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOkStatus(status: number) {
  return status >= 200 && status < 300
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

/** Flatten every literal (non-translated) token the lane surface will paint, for the mechanical no-value /
 *  no-collapse / inert-exclusion checks. Numbers are stringified so a test can scan the whole painted set. */
export function collectLaneLiteralTokens(model: LaneControlModel): string[] {
  const out: string[] = []
  for (const c of model.controls) {
    out.push(c.key, c.stack, c.service, c.restartClass)
    if (!Number.isNaN(c.min)) out.push(`[${c.min},${c.max}]`)
    if (!Number.isNaN(c.setupValue)) out.push(String(c.setupValue))
    if (c.stored.state === "present") out.push(String(c.stored.value))
    else out.push("absent")
    if (c.observed.state === "observed") out.push("observed", String(c.observed.value))
    else if (c.observed.state === "absent") out.push("absent")
    else out.push("unobserved", c.observed.reason)
    out.push(c.sourceToken)
  }
  if (model.filePath) out.push(model.filePath)
  if (model.fileError) out.push(model.fileError)
  if (model.freshness.observedAt) out.push(model.freshness.observedAt)
  return out
}
