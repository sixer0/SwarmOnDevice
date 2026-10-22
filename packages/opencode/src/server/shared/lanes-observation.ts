// Machine-global lane-control surface behind `GET /global/lanes` and `PATCH /global/lanes`
// (masterplan/06_s6b_lanes_spec.md §5.2, blueprint 11 row 247).
//
// ONE FILE, TWO WRITERS, ONE VALIDATOR. The file is ~/.swarm/setup/lanes.json (PC-PATH-18, mode
// 0600 inside the 0700 PC-PATH-01 dir). swarm-setup creates it if absent (row 246); this route
// replaces the tuple after validation (this row). Both writers share ONE schema gate —
// `validateLanesDocument` from packages/setup/src/composefiles/lanes.ts, exported at row 245 for
// exactly this reuse — so fork H's bounds [4,5]/[4,4]/[4,4] have exactly one home. A second range
// table here would be a second thing to drift, which is the same no-second-deny-list reasoning that
// made dns_pins.ts reuse urlpolicy's predicates (lanes.ts:177-180 states the export rationale).
//
// WHY A RELATIVE IMPORT AND NOT A BARE SPECIFIER. `@swarm/setup` has no workspace link under
// node_modules on this tree (measured at row 247 dispatch: `ls node_modules/@swarm` → absent), so
// the bare specifier cannot resolve without a `bun install` that would rewrite the lockfile — a
// single-writer resource outside this row's area. The relative path resolves identically under bun
// and tsgo today. This does create the runtime edge row 194 C-207-i recommended avoiding
// (packages/opencode -> packages/setup); the dispatch overrides that recommendation precisely
// because the validator must not be duplicated, and the import is limited to pure-data/pure-fs
// modules (lanes.ts, atomic.ts, constants.ts, paths.ts) — no renderer, no step engine, no HttpApi
// types. The exception is declared for rows 251/252 to adjudicate.
//
// PAYLOAD MINIMISATION IS A SECURITY RULE (gate 195 posture, inherited from the sibling route).
// Only the TILDE form of the path is ever published (§5.2 "publishes the tilde-form path and never
// the expanded absolute path"), and every string that could have carried an absolute path through an
// error message is sanitised with toTilde() first. Docker stderr is never published at all — only
// fixed reason codes — because daemon error text embeds socket paths under $HOME.
//
// EFFECTIVE VALUES: EXEC, NOT SPAWN (rule E17 + gate 239 fork G). Fork G authorised the status
// surface to SPAWN a short-lived inspection container; row 246 then proved `docker exec` into the
// already-running, label-scoped container reading /proc/1/environ answers the same question with a
// far smaller boundary. This module therefore runs at most two `docker ps` listings (positive-label
// filters only — the daemon on this estate rejects `label!=`, rule E16) plus one `docker exec` per
// carrier, all pinned to --context colima-swarm (the DOCKER_CONTEXT constant; never the user's
// current context, never `default`). It starts nothing. If a spawn ever looks necessary here, the
// answer is to route the question to row 251's boundary review, not to add it.
//
// DEGRADE HONESTLY (§5.2's split claim + the anti-collapse invariant): stored configuration and
// observed-in-container state are separate fields. An unreachable daemon, a stopped stack or a
// container without the key each produce their own named reason or the explicit `absent` status —
// never a value, never `false`, never a default dressed up as knowledge.

import { chmodSync, existsSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { Effect } from "effect"
import { atomicWriteJson } from "../../../../setup/src/atomic.ts"
import { COMPOSE_PROJECT, DOCKER_CONTEXT, LABELS, MODES } from "../../../../setup/src/constants.ts"
import { homeDir } from "../../../../setup/src/paths.ts"
import { LANE_CONTROLS, lanesPath, validateLanesDocument } from "../../../../setup/src/composefiles/lanes.ts"
import type { LaneRefusalToken } from "../../../../setup/src/composefiles/lanes.ts"

/** Display form published by this surface (§5.2: tilde only, never expanded). */
export const LANES_TILDE_PATH = "~/.swarm/setup/lanes.json"

export type LaneObservation =
  | { readonly status: "observed"; readonly value: number }
  /** The carrier container is running and its PID 1 environment was readable, but the control is
   *  not set in it. This is an OBSERVED ABSENCE — legal per 06 §5.1 rule 4 (unset controls render
   *  as today) and distinct from "could not look". */
  | { readonly status: "absent" }
  /** Could not obtain the value. `reason` is a closed vocabulary of fixed codes; it is never a
   *  verbatim daemon message, because those carry $HOME-bearing socket paths (payload minimisation). */
  | { readonly status: "unobserved"; readonly reason: string }

export interface LanesFileObservation {
  tildePath: string
  present: boolean
  /** Verbatim read/parse/validation cause, tilde-sanitised. Present means `stored` is withheld —
   *  an unreadable tuple must never fall back to an empty or partial rendering (anti-collapse). */
  error?: string
  /** True when this request's write found the setup directory at a mode other than 0700 and
   *  repaired it (06 §2.2's verify-not-assume rule; reported, never silent). */
  dirModeRepaired?: boolean
}

export interface LaneRangeEntry {
  min: number
  max: number
  setupValue: number
  // Literal unions mirror LaneControl's own field types (lanes.ts:72-73) so the response schema
  // can require them without widening to string.
  stack: "firecrawl" | "searxng"
  service: "api" | "playwright-service" | "searxng"
  basis: string
}

export interface LanesStatePayload {
  observedAt: string
  file: LanesFileObservation
  /** Per-control bounds straight off the imported LANE_CONTROLS, so the card hard-codes nothing
   *  (R-245-4) and a stale client cannot offer a value this server would refuse (§5.2). */
  range: Record<string, LaneRangeEntry>
  /** Sparse by design: an absent key means "unset", never filled with a default (§5.1 rule 4).
   *  OMITTED entirely (not `{}`) when the stored file failed validation — `{}` there would read
   *  as "legitimately unconfigured" and collapse an error into a state. */
  stored?: Record<string, number>
  /** Only when the file carried it; absence means "never set from the app" and is never inferred (§2.4). */
  updatedAt?: string
  /** Every control in this family is recreate-class (06 §3.1/§5.3): applying a change needs the
   *  stack's apply owner (row 246's command), so the route says so instead of implying live effect. */
  restartRequired: "container-recreate"
}

export type LanesPatchError = {
  code: LaneRefusalToken
  key?: string
  value?: number
  range?: { min: number; max: number }
  reason?: string
}

export type LanesPatchResult =
  | { readonly ok: true; readonly state: LanesStatePayload }
  | { readonly ok: false; readonly error: LanesPatchError }

export function lanesFilePath(home: string = homeDir()): string {
  // The writer's own resolver (paths.ts homeDir + lanes.ts lanesPath), imported rather than mirrored,
  // so "the reader reads where the writer writes" (06 §5.1 item 6) holds by construction.
  return lanesPath(home)
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Replace every occurrence of the resolved home with `~` before a string may go on the wire. */
function toTilde(text: string, home: string) {
  return text.split(home).join("~")
}

export function laneRangeMap(): Record<string, LaneRangeEntry> {
  const out: Record<string, LaneRangeEntry> = {}
  for (const control of LANE_CONTROLS)
    out[control.key] = {
      min: control.min,
      max: control.max,
      setupValue: control.setupValue,
      stack: control.stack,
      service: control.service,
      basis: control.basis,
    }
  return out
}

type StoredRead =
  | { readonly valid: true; readonly present: boolean; readonly lanes: Record<string, number>; readonly updatedAt?: string }
  | { readonly valid: false; readonly present: boolean; readonly token: LaneRefusalToken; readonly message: string }

/** Read + validate the stored file through the SHARED validator. Branches mirror readLanes
 *  (lanes.ts:157-175) but publish tilde paths and keep the parsed document for the PATCH merge. */
function readStoredLanes(home: string): StoredRead {
  const path = lanesFilePath(home)
  if (!existsSync(path)) return { valid: true, present: false, lanes: {} }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return { valid: false, present: true, token: "LANE_VALUE_MALFORMED", message: toTilde(`cannot read lanes file: ${errorMessage(err)}`, home) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { valid: false, present: true, token: "LANE_VALUE_MALFORMED", message: toTilde(`lanes file is not valid JSON: ${errorMessage(err)}`, home) }
  }
  const validated = validateLanesDocument(parsed)
  if (!validated.ok) return { valid: false, present: true, token: validated.token, message: toTilde(validated.message, home) }
  const lanes: Record<string, number> = {}
  for (const [key, value] of Object.entries(validated.document.lanes)) lanes[key] = value as number
  return { valid: true, present: true, lanes, ...(typeof validated.document.updatedAt === "string" ? { updatedAt: validated.document.updatedAt } : {}) }
}

/** The GET payload (stored half). One fresh read per call: no cache across requests, matching the
 *  sibling setup route. */
export function lanesStateObservation(home: string = homeDir()): LanesStatePayload {
  const read = readStoredLanes(home)
  const base: LanesStatePayload = {
    observedAt: new Date().toISOString(), // read time stamped here, never a file mtime (§4 rule 1 lineage)
    file: { tildePath: LANES_TILDE_PATH, present: read.present },
    range: laneRangeMap(),
    restartRequired: "container-recreate",
  }
  if (!read.valid) return { ...base, file: { ...base.file, error: `${read.token}: ${read.message}` } }
  return {
    ...base,
    stored: read.lanes,
    ...(typeof read.updatedAt === "string" ? { updatedAt: read.updatedAt } : {}),
  }
}

function patchError(read: StoredRead & { valid: false }): { ok: false; error: LanesPatchError }
function patchError(token: LaneRefusalToken, extra?: Omit<LanesPatchError, "code">): { ok: false; error: LanesPatchError }
function patchError(
  tokenOrRead: LaneRefusalToken | (StoredRead & { valid: false }),
  extra?: Omit<LanesPatchError, "code">,
): { ok: false; error: LanesPatchError } {
  if (typeof tokenOrRead === "string") return { ok: false, error: { code: tokenOrRead, ...extra } }
  return { ok: false, error: { code: tokenOrRead.token, reason: tokenOrRead.message } }
}

/**
 * PATCH semantics (06 §5.2): all-or-nothing merge.
 *
 * 1. The submitted fields merge over the stored map to form a CANDIDATE whole document.
 * 2. The candidate is validated WHOLE through the shared validator before any write call exists —
 *    §4.2's "no open, no temp file, no ensureParent until every key and value has passed".
 * 3. A refusal writes nothing and returns the spec's token body; the merged candidate's offending
 *    integer and the imported bound travel with OUT_OF_RANGE, and NOT_A_LANE never echoes a value.
 * 4. Success commits via the shipped atomicWriteJson idiom (temp-in-same-dir + fsync + rename), so
 *    two writers cannot interleave bytes, the committed inode always carries 0600, and the
 *    directory's own mode is untouched by the rename (06 §2.2).
 */
export function applyLanesPatch(patch: unknown, home: string = homeDir()): LanesPatchResult {
  const current = readStoredLanes(home)
  // A stored file that fails validation refuses the PATCH too: merging over corruption would
  // silently discard what the user hand-edited, and guessing which half they meant is coercion.
  if (!current.valid) return patchError({ ...current, message: `stored lanes file is invalid — ${current.message}` })

  if (!isPlainObject(patch))
    return patchError("LANE_VALUE_MALFORMED", { reason: "request body must be a JSON object of lane control names to integers (06 §5.2 closed struct)" })

  const candidate: Record<string, unknown> = { ...current.lanes }
  for (const [key, value] of Object.entries(patch)) candidate[key] = value

  const doc = { version: 1, updatedAt: new Date().toISOString(), lanes: candidate }
  const validated = validateLanesDocument(doc)
  if (!validated.ok) {
    const extra: Omit<LanesPatchError, "code"> = {}
    if (validated.key !== undefined) extra.key = validated.key
    if (validated.token === "LANE_VALUE_OUT_OF_RANGE" && validated.key) {
      const control = LANE_CONTROLS.find((c) => c.key === validated.key)
      const value = candidate[validated.key]
      if (control && typeof value === "number") {
        extra.value = value
        extra.range = { min: control.min, max: control.max }
      }
    }
    // validateLanesDocument messages name keys and values, never paths (checked at row 247), so
    // they pass to the wire verbatim apart from the blanket tilde guard.
    extra.reason = toTilde(validated.message, home)
    return patchError(validated.token, extra)
  }

  const path = lanesFilePath(home)
  const dir = join(home, ".swarm", "setup")
  // Verify-and-repair the directory mode (06 §2.2): ensureDir only applies modes on create
  // (paths.ts:42-46), so a drifted existing directory must be caught here, not assumed.
  let dirModeRepaired = false
  if (existsSync(dir)) {
    // Verify-and-repair the directory mode (06 §2.2): ensureDir only applies modes on create
    // (paths.ts:42-46), so a drifted existing directory must be caught here, not assumed.
    const dirMode = statSync(dir).mode & 0o777
    if (dirMode !== MODES.DIR_0700) {
      chmodSync(dir, MODES.DIR_0700)
      dirModeRepaired = true
    }
  }
  atomicWriteJson(path, doc, MODES.FILE_0600)

  const state = lanesStateObservation(home)
  return { ok: true, state: { ...state, file: { ...state.file, dirModeRepaired } } }
}

// --- effective-value observation: exec into running carriers, never spawn ----------------------

export interface DockerRunOk {
  readonly code: number
  readonly stdout: string
}
export interface DockerRunFailure {
  readonly failure: "docker-missing" | "timeout" | "spawn-failed"
}
export type DockerRunOutcome = DockerRunOk | DockerRunFailure
/** Injectable so the argv contract and every degradation branch are testable without a daemon. */
export type DockerRunner = (argv: readonly string[], timeoutMs: number) => Promise<DockerRunOutcome>

const PROBE_TIMEOUT_MS = 2000

/** Production runner. Bun's `timeout` option kills the child, so a hung daemon degrades to
 *  `timeout` instead of hanging the request (the dead-`default`-VM class of failure, E10's reason).
 *  stderr is DROPPED, never forwarded: daemon messages embed $HOME-bearing paths. */
export const liveDockerRunner: DockerRunner = async (argv, timeoutMs) => {
  try {
    const proc = Bun.spawn(["docker", ...argv], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
    })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    // exitCode 0 with a killed-by-timeout process surfaces via timedOut on Bun; treat nonzero-after-timeout as timeout when flagged.
    if ((proc as { timedOut?: boolean }).timedOut === true) return { failure: "timeout" }
    return { code, stdout }
  } catch (err) {
    // Bun reports a missing executable with its own phrasing (measured live at row 247: an env -i
    // serve listener answered "spawn-failed" until the matcher widened past bare "ENOENT").
    const message = errorMessage(err)
    if (/ENOENT|no such file|not found/i.test(message)) return { failure: "docker-missing" }
    return { failure: "spawn-failed" }
  }
}

function managedPsArgs(component: string): string[] {
  // Positive-label filters only: `label!=` is rejected outright by this estate's daemon (rule E16,
  // finding F-246-6), and the context is pinned by constant, never inherited from the user's current context.
  return [
    "--context",
    DOCKER_CONTEXT,
    "ps",
    "--filter",
    `label=${LABELS.MANAGED_KEY}=${LABELS.MANAGED_VALUE}`,
    "--filter",
    `label=${LABELS.COMPONENT_KEY}=${component}`,
    "--format",
    "{{.Names}}",
  ]
}

function carrierEnvArgs(container: string): string[] {
  // Row 246's instrument: read PID 1's environment INSIDE the already-running container. No spawn.
  return ["--context", DOCKER_CONTEXT, "exec", container, "sh", "-c", 'tr "\\0" "\\n" </proc/1/environ']
}

function unobservedAll(reason: string): Record<string, LaneObservation> {
  const out: Record<string, LaneObservation> = {}
  for (const control of LANE_CONTROLS) out[control.key] = { status: "unobserved", reason }
  return out
}

function parseEnvironKeys(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=")
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

/**
 * Observe the stored controls inside the RUNNING carriers (fork G's question answered with row
 * 246's instrument). Discovery is label-scoped (`io.gsp.swarm.managed=true` plus the component
 * label) and the exec target must ALSO be the expected compose name of that stack's carrier —
 * double scoping, so a hostile caller has no path from this endpoint to any other container:
 * the payload carries no docker arguments at all (closed three-key vocabulary), and container
 * names are derived from imported constants, never from request data.
 */
export function observeEffective(runner: DockerRunner = liveDockerRunner): Effect.Effect<Record<string, LaneObservation>, never> {
  const observe = Effect.fnUntraced(function* () {
    const stacks = [...new Set(LANE_CONTROLS.map((c) => c.stack))] as ("firecrawl" | "searxng")[]
    // Discovery outcome is kept per stack so a failed listing is never re-labelled as "container
    // absent": those are different claims — one says the probe could not look, the other says it
    // looked and the carrier was not running. Collapsing them would render an absence as a value.
    const discovery: Record<string, { readonly okNames: string[] } | { readonly failed: string }> = {}
    for (const stack of stacks) {
      const listed = yield* Effect.promise(() => runner(managedPsArgs(stack), PROBE_TIMEOUT_MS))
      if (!("code" in listed)) {
        discovery[stack] = { failed: listed.failure }
        yield* Effect.logWarning("lanes observation: container listing failed", { stack, failure: listed.failure })
        continue
      }
      if (listed.code !== 0) {
        discovery[stack] = { failed: "daemon-unreachable" }
        yield* Effect.logWarning("lanes observation: container listing refused", { stack, code: listed.code })
        continue
      }
      discovery[stack] = { okNames: listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0) }
    }

    const out: Record<string, LaneObservation> = {}
    for (const control of LANE_CONTROLS) {
      const expected = `${COMPOSE_PROJECT}-${control.service}-1`
      const found = discovery[control.stack]
      if (!found) {
        out[control.key] = { status: "unobserved", reason: "probe-failed" }
        continue
      }
      if ("failed" in found) {
        out[control.key] = { status: "unobserved", reason: found.failed }
        continue
      }
      if (!found.okNames.includes(expected)) {
        // Absence from the label-scoped RUNNING list is its own honest state: never a value, never false.
        out[control.key] = { status: "unobserved", reason: "container-absent" }
        continue
      }
      const read = yield* Effect.promise(() => runner(carrierEnvArgs(expected), PROBE_TIMEOUT_MS))
      if (!("code" in read)) {
        out[control.key] = { status: "unobserved", reason: read.failure }
        continue
      }
      if (read.code !== 0) {
        // e.g. Permission denied on /proc/1/environ (three of seven containers reported that to row 246).
        out[control.key] = { status: "unobserved", reason: "read-failed" }
        continue
      }
      const raw = parseEnvironKeys(read.stdout)[control.key]
      if (raw === undefined) {
        out[control.key] = { status: "absent" }
        continue
      }
      if (!/^-?\d+$/.test(raw.trim())) {
        out[control.key] = { status: "unobserved", reason: "non-integer-in-env" }
        continue
      }
      out[control.key] = { status: "observed", value: Number.parseInt(raw.trim(), 10) }
    }
    return out
  })
  // Nothing inside may reject the request: any unexpected defect degrades the whole leg to
  // stored-plus-unobserved, which is the posture the endpoint promises even when probing breaks.
  return observe().pipe(Effect.catchDefect(() => Effect.succeed(unobservedAll("probe-failed"))))
}

export * as LanesObservation from "./lanes-observation"
