// Row 247 — `GET /global/lanes` and `PATCH /global/lanes`, the machine-global door onto PC-PATH-18.
//
// Three layers, because three different claims need proving:
//  - the FILE rules (refusal matrix, mode posture, merge semantics, concurrency) run against
//    throwaway directories by calling the module the handler calls, with `home` passed EXPLICITLY
//    everywhere — these layers never needed the environment;
//  - the EFFECTIVE-VALUE leg runs against a scripted DockerRunner, so the argv contract
//    (`--context colima-swarm` pinned, positive-label filters only per E16, exec-not-spawn per
//    E17) and every degradation branch are proven without a daemon;
//  - the SURFACE rules (auth posture on BOTH verbs, published key set, tilde-only paths,
//    token-shaped 400s) run over HTTP against the real RootHttpApi tree, exactly as production
//    assembles it (api.ts RootHttpApi .middleware(Authorization); server.ts provides httpApiAuthLayer).
//
// AMENDED by row 270 (finding F-265-4, verification/s6b_13b_lanes_security_delta.md §6). This header used to
// say "no test here mutates process.env.HOME" and to keep the SURFACE legs safe by sending bodies whose only
// guard was the auth middleware. Row 265 measured what that costs: the anonymous-WRITE and wrong-password
// legs carried a VALID tuple through an app resolving the ambient HOME, so one middleware regression was
// one step away from creating ~/.swarm/setup/lanes.json with a fabricated updatedAt — the second time this
// session's shape-of-dependency fired (E21). Two changes close it doubly:
//  1. SANDBOXED BASE — HOME is pinned at module scope below, verified through the resolver itself (E7), and
//     restored in afterAll so the escape window is this file's own run, not the shared bun process;
//  2. DOUBLY-REFUSED BODIES — the auth-refusal legs now carry a body the closed set refuses on its own
//     ({laneCount: 9} answers LANE_VALUE_NOT_A_LANE before any filesystem call), so a middleware failure
//     writes nothing while the 401 assertion these legs exist for stays byte-identical.
// Valid-write proofs stay where row 247 put them: module level against explicit sandbox homes.
//
// Run targeted: cd packages/opencode && bun test test/server/httpapi-global-lanes.test.ts

import { createHash } from "crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { fileURLToPath } from "url"
import { NodeHttpServer } from "@effect/platform-node"
import { afterAll, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { Permission } from "../../src/permission"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { SessionStatus } from "../../src/session/status"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import {
  LANES_TILDE_PATH,
  applyLanesPatch,
  dockerSpawnEnv,
  lanesFilePath,
  lanesStateObservation,
  observeEffective,
} from "../../src/server/shared/lanes-observation"
import type { DockerRunOutcome, DockerRunner } from "../../src/server/shared/lanes-observation"
// The SAME module the route imports — tests read the bounds off it rather than restating them,
// so a drift between route and register fails here instead of silently passing two copies.
import { LANE_CONTROLS, validateLanesDocument } from "../../../setup/src/composefiles/lanes.ts"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Scratch lives under $TMPDIR/kilo/ only (row rule), and every directory is 0700 so fixtures that
// name absolute paths stay private while they exist.
function kiloRoot() {
  const root = join(tmpdir(), "kilo")
  mkdirSync(root, { recursive: true })
  return root
}

function tempHome(tag: string) {
  const dir = mkdtempSync(join(kiloRoot(), `r247-${tag}-`))
  chmodSync(dir, 0o700)
  return dir
}

function setupDir(home: string) {
  return join(home, ".swarm", "setup")
}

/** A home whose setup dir exists at 0700 (the register posture, matching the real host dir),
 *  optionally carrying a lanes.json written RAW (string) or as an object, at mode 0600. */
function homeWith(opts?: { raw?: string; doc?: unknown; dirMode?: number }) {
  const home = tempHome("home")
  const dir = setupDir(home)
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, opts?.dirMode ?? 0o700) // mkdirSync's mode option is umask-masked — chmod explicitly (row 245 lesson)
  if (opts?.raw !== undefined || opts?.doc !== undefined) {
    const file = join(dir, "lanes.json")
    writeFileSync(file, opts.raw ?? JSON.stringify(opts.doc, null, 2) + "\n", "utf8")
    chmodSync(file, 0o600)
  }
  return home
}

function sha(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function fileMode(path: string) {
  return statSync(path).mode & 0o777
}

function snapshot(home: string) {
  const dir = setupDir(home)
  const file = join(dir, "lanes.json")
  return {
    listing: readdirSync(dir).sort().join(","),
    sha: existsSync(file) ? sha(file) : "ABSENT",
    fileMode: existsSync(file) ? fileMode(file) : -1,
    dirMode: statSync(dir).mode & 0o777,
  }
}

const VALID_TUPLE = { NUQ_WORKER_COUNT: 5, MAX_CONCURRENT_PAGES: 4, GRANIAN_BLOCKING_THREADS: 4 }

function lanesFile(home: string) {
  return join(setupDir(home), "lanes.json")
}

function readDoc(home: string) {
  return JSON.parse(readFileSync(lanesFile(home), "utf8")) as Record<string, unknown>
}

async function readAll(proc: { stdout: ReadableStream<Uint8Array> }) {
  const chunks: Uint8Array[] = []
  const reader = proc.stdout.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// ---------------------------------------------------------------------------
// E21/F-265-4 sandboxed base (row 270) — pin HOME BEFORE any surface leg can run, verify through the resolver
// ---------------------------------------------------------------------------

// The in-process app resolves the lane file through paths.ts, which consults process.env.HOME AT CALL TIME.
// Row 265 measured that a committed leg carrying a valid body was therefore one auth regression away from
// writing the REAL ~/.swarm/setup/lanes.json (the incident class this session produced twice). Pinning here
// means even a leg that forgot cannot reach the real home. The pin is verified by READING THE RESOLVER, not
// by intending it (E7), and a failed verification throws at module load — the whole file goes red rather
// than running one test against the user's directory. afterAll restores the ambient value so the escape
// window is this file's own run; bun runs test files sequentially in one process.
const SURFACE_SANDBOX = tempHome("surface-base")
const HOME_BEFORE_PIN = process.env.HOME
process.env.HOME = SURFACE_SANDBOX
if (lanesFilePath() !== join(SURFACE_SANDBOX, ".swarm", "setup", "lanes.json")) {
  process.env.HOME = HOME_BEFORE_PIN
  throw new Error("F-265-4: HOME pin did not take effect through lanesFilePath — refusing to run this suite")
}
afterAll(() => {
  if (HOME_BEFORE_PIN === undefined) delete process.env.HOME
  else process.env.HOME = HOME_BEFORE_PIN
})

/** F-265-4's second layer: a body the closed set refuses on its own terms — `laneCount` is not a lane control,
 *  so pass 1 of the shared validator answers LANE_VALUE_NOT_A_LANE before any filesystem call exists (06 §4.2
 *  order). The auth-refusal legs used to carry VALID_TUPLE, which WRITES if the middleware ever stops firing. */
const DOUBLY_REFUSED_WRITE = { laneCount: 9 }

// ---------------------------------------------------------------------------
// Layer 1 — stored observation (module level, explicit sandbox home)
// ---------------------------------------------------------------------------

describe("GET /global/lanes stored half", () => {
  test("an absent file is present:false with an empty stored map and no error (legal unconfigured state)", () => {
    const home = homeWith()
    try {
      const state = lanesStateObservation(home)
      expect(state.file).toEqual({ tildePath: "~/.swarm/setup/lanes.json", present: false })
      expect(state.stored).toEqual({})
      expect(state.updatedAt).toBeUndefined() // absence is never inferred (§2.4)
      expect(state.restartRequired).toBe("container-recreate")
      expect(state.observedAt).toBeString()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("the tilde path is the published form and the resolver agrees with the writer's own", () => {
    const home = tempHome("resolve")
    try {
      // The route's path must be exactly what the setup writer's resolver produces for the same home
      // (06 §5.1 item 6: one resolver, imported not mirrored).
      expect(lanesFilePath(home)).toBe(join(home, ".swarm", "setup", "lanes.json"))
      expect(LANES_TILDE_PATH).toBe("~/.swarm/setup/lanes.json")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a valid tuple round-trips with updatedAt passthrough and ranges straight off LANE_CONTROLS", () => {
    const home = homeWith({ doc: { version: 1, updatedAt: "2026-10-22T01:31:03Z", lanes: VALID_TUPLE } })
    try {
      const state = lanesStateObservation(home)
      expect(state.file.present).toBe(true)
      expect(state.file.error).toBeUndefined()
      expect(state.stored).toEqual(VALID_TUPLE)
      expect(state.updatedAt).toBe("2026-10-22T01:31:03Z")
      // Single-source-of-truth pin: the published range equals the imported table digit for digit,
      // including fork H's [4,5] / [4,4] / [4,4].
      for (const control of LANE_CONTROLS) {
        expect(state.range[control.key]).toEqual({
          min: control.min,
          max: control.max,
          setupValue: control.setupValue,
          stack: control.stack,
          service: control.service,
          basis: control.basis,
        })
      }
      expect(Object.keys(state.range).sort()).toEqual(LANE_CONTROLS.map((c) => c.key).sort())
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a malformed stored file yields error + NO stored key, never an empty rendering dressed as unconfigured", () => {
    const home = homeWith({ raw: "{ this is not json" })
    try {
      const state = lanesStateObservation(home)
      expect(state.file.present).toBe(true)
      expect(state.file.error?.startsWith("LANE_VALUE_MALFORMED:")).toBe(true)
      // Anti-collapse: `stored` is OMITTED, not `{}` — `{}` would read as legitimately unset controls.
      expect("stored" in state).toBe(false)
      // Tilde-only rule reaches error text too: the resolved home never appears.
      expect(JSON.stringify(state).includes(home)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an out-of-range or non-lane stored file names its token, and a hostile value under a bad key is never echoed", () => {
    const oor = homeWith({ raw: JSON.stringify({ version: 1, lanes: { NUQ_WORKER_COUNT: 9 } }) })
    const nal = homeWith({ raw: JSON.stringify({ version: 1, lanes: { NUM_WORKERS_PER_QUEUE: "SECRET-CANARY-PAYLOAD" } }) })
    try {
      const oorState = lanesStateObservation(oor)
      expect(oorState.file.error?.startsWith("LANE_VALUE_OUT_OF_RANGE:")).toBe(true)
      expect(oorState.file.error).toContain("NUQ_WORKER_COUNT")
      expect("stored" in oorState).toBe(false)

      const nalState = lanesStateObservation(nal)
      expect(nalState.file.error?.startsWith("LANE_VALUE_NOT_A_LANE:")).toBe(true)
      // §4.1's wire shape for this token: no echo of the value the caller did not send.
      expect(JSON.stringify(nalState).includes("SECRET-CANARY-PAYLOAD")).toBe(false)
    } finally {
      rmSync(oor, { recursive: true, force: true })
      rmSync(nal, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Layer 1b — PATCH refusal matrix: token named, nothing written, posture intact
// ---------------------------------------------------------------------------

describe("PATCH /global/lanes refusals", () => {
  type RefusalCase = {
    name: string
    patch: unknown
    token: "LANE_VALUE_OUT_OF_RANGE" | "LANE_VALUE_NOT_A_LANE" | "LANE_VALUE_MALFORMED"
    key?: string
    value?: number
    range?: { min: number; max: number }
  }
  const cases: RefusalCase[] = [
    // fork H bounds refuse on BOTH sides: 6 is above the published ceiling of 5 …
    { name: "above ceiling", patch: { NUQ_WORKER_COUNT: 6 }, token: "LANE_VALUE_OUT_OF_RANGE", key: "NUQ_WORKER_COUNT", value: 6, range: { min: 4, max: 5 } },
    // … and 1 is the value the user forbade (decisions.md:214-217), refused by the same token.
    { name: "below floor", patch: { MAX_CONCURRENT_PAGES: 1 }, token: "LANE_VALUE_OUT_OF_RANGE", key: "MAX_CONCURRENT_PAGES", value: 1, range: { min: 4, max: 4 } },
    { name: "single-position ceiling", patch: { GRANIAN_BLOCKING_THREADS: 5 }, token: "LANE_VALUE_OUT_OF_RANGE", key: "GRANIAN_BLOCKING_THREADS", value: 5, range: { min: 4, max: 4 } },
    // Invented knobs refuse rather than being skipped — the K1-K4 relabelling class.
    { name: "inert knob", patch: { NUM_WORKERS_PER_QUEUE: 2 }, token: "LANE_VALUE_NOT_A_LANE", key: "NUM_WORKERS_PER_QUEUE" },
    { name: "collapse name", patch: { laneCount: 4 }, token: "LANE_VALUE_NOT_A_LANE", key: "laneCount" },
    { name: "envelope word as knob", patch: { version: 2 }, token: "LANE_VALUE_NOT_A_LANE", key: "version" },
    { name: "updatedAt word as knob", patch: { updatedAt: "2026-01-01T00:00:00Z" }, token: "LANE_VALUE_NOT_A_LANE", key: "updatedAt" },
    // Free-form values: the ban that keeps this from becoming an injection surface (§4.3).
    { name: "string value", patch: { GRANIAN_BLOCKING_THREADS: "many" }, token: "LANE_VALUE_MALFORMED", key: "GRANIAN_BLOCKING_THREADS" },
    { name: "float value", patch: { NUQ_WORKER_COUNT: 4.5 }, token: "LANE_VALUE_MALFORMED", key: "NUQ_WORKER_COUNT" },
    { name: "boolean value", patch: { NUQ_WORKER_COUNT: true }, token: "LANE_VALUE_MALFORMED", key: "NUQ_WORKER_COUNT" },
    { name: "null value", patch: { NUQ_WORKER_COUNT: null }, token: "LANE_VALUE_MALFORMED", key: "NUQ_WORKER_COUNT" },
    { name: "array value", patch: { NUQ_WORKER_COUNT: [4] }, token: "LANE_VALUE_MALFORMED", key: "NUQ_WORKER_COUNT" },
    { name: "object value", patch: { NUQ_WORKER_COUNT: { v: 4 } }, token: "LANE_VALUE_MALFORMED", key: "NUQ_WORKER_COUNT" },
    // Interpolation payloads cannot even start: they are not integers.
    { name: "template payload", patch: { NUQ_WORKER_COUNT: "${X}" }, token: "LANE_VALUE_MALFORMED", key: "NUQ_WORKER_COUNT" },
    // Non-object bodies refuse with the closed-struct reason.
    { name: "array body", patch: [1, 2], token: "LANE_VALUE_MALFORMED" },
    { name: "scalar body", patch: 7, token: "LANE_VALUE_MALFORMED" },
    { name: "null body", patch: null, token: "LANE_VALUE_MALFORMED" },
    { name: "string body", patch: "hello", token: "LANE_VALUE_MALFORMED" },
  ]

  for (const testCase of cases) {
    test(`refuses "${testCase.name}" with ${testCase.token} and leaves prior bytes, modes and listing intact`, () => {
      const home = homeWith({ doc: { version: 1, updatedAt: "2026-10-21T00:00:00Z", lanes: VALID_TUPLE } })
      try {
        const before = snapshot(home)
        const result = applyLanesPatch(testCase.patch, home)
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("unreachable")
        expect(result.error.code).toBe(testCase.token)
        if (testCase.key !== undefined) expect(result.error.key).toBe(testCase.key)
        if (testCase.value !== undefined) {
          expect(result.error.value).toBe(testCase.value)
          expect(result.error.range).toEqual(testCase.range)
        }
        expect(result.error.reason).toBeString()
        // Nothing written: bytes, both modes, and the directory listing are bit-identical (§4.2).
        expect(snapshot(home)).toEqual(before)
        // No absolute-path disclosure in the refusal body.
        expect(JSON.stringify(result.error).includes(home)).toBe(false)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }

  test("all-or-nothing: a payload mixing one legal change with one hostile key applies NEITHER", () => {
    const home = homeWith({ doc: { version: 1, lanes: VALID_TUPLE } })
    try {
      const before = snapshot(home)
      const result = applyLanesPatch({ NUQ_WORKER_COUNT: 4, laneCount: 9 }, home)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      // Names are checked before values (lanes.ts pass order): the rename is the more dangerous half.
      expect(result.error.code).toBe("LANE_VALUE_NOT_A_LANE")
      expect(snapshot(home)).toEqual(before) // NUQ still 5 — the legal field did not sneak through
      expect(readDoc(home).lanes).toEqual(VALID_TUPLE)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a stored file already invalid refuses the PATCH too, instead of merging over corruption", () => {
    const home = homeWith({ raw: "{oops" })
    try {
      const before = snapshot(home)
      const result = applyLanesPatch(VALID_TUPLE, home) // even a fully valid patch …
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.error.code).toBe("LANE_VALUE_MALFORMED")
      expect(result.error.reason).toContain("stored lanes file is invalid")
      expect(snapshot(home)).toEqual(before) // … still writes nothing over the user's broken bytes
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("NOT_A_LANE never echoes the submitted value back", () => {
    const home = homeWith({ doc: { version: 1, lanes: VALID_TUPLE } })
    try {
      const result = applyLanesPatch({ pool_maxsize: "CANARY-DO-NOT-ECHO" }, home)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.error.code).toBe("LANE_VALUE_NOT_A_LANE")
      expect(JSON.stringify(result.error).includes("CANARY-DO-NOT-ECHO")).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Layer 1b2 — the prototype-chain carriers row 251 caught slipping past the closed set (F-251-3)
// ---------------------------------------------------------------------------

// Row 251 measured these bodies answering 200 while every own-property name answered 400. The
// mechanism was the merge itself: `candidate["__proto__"] = value` invokes Object.prototype's
// setter and RE-PARENTS the candidate instead of adding a key, so pass 1's own-key sweep
// (lanes.ts:210) found nothing to refuse. Nothing hostile reached the file — but the commit moved
// `updatedAt` from absent to present, fabricating the very age whose absence means "never set from
// the app" (lanes.ts:134-136). Refusing nothing while writing an age is the worst of both halves of
// refuse-not-coerce (06 §4), which is why this class now answers like every other unknown name.
describe("PATCH /global/lanes prototype-chain carriers (F-251-3)", () => {
  // Raw JSON text, never object literals: `{ __proto__: x }` in a literal sets the prototype rather
  // than creating the own property JSON.parse creates, so a literal would test a different thing.
  const carriers = [
    { name: "__proto__ carrying an in-range value", key: "__proto__", raw: '{"__proto__":{"MAX_CONCURRENT_PAGES":4}}' },
    { name: "__proto__ carrying an out-of-range value", key: "__proto__", raw: '{"__proto__":{"NUQ_WORKER_COUNT":999}}' },
    { name: "__proto__ carrying an unrelated payload", key: "__proto__", raw: '{"__proto__":{"totally_unrelated":"x"}}' },
    { name: "__proto__ carrying a nested envelope", key: "__proto__", raw: '{"__proto__":{"lanes":{"MAX_CONCURRENT_PAGES":4}}}' },
    { name: "constructor", key: "constructor", raw: '{"constructor":{"MAX_CONCURRENT_PAGES":4}}' },
    { name: "prototype", key: "prototype", raw: '{"prototype":{"MAX_CONCURRENT_PAGES":4}}' },
  ]

  for (const carrier of carriers) {
    test(`refuses the "${carrier.name}" carrier exactly like an ordinary unknown name`, () => {
      // Seed WITHOUT updatedAt — that absence is the thing the old 200 fabricated.
      const home = homeWith({ doc: { version: 1, lanes: VALID_TUPLE } })
      try {
        const before = snapshot(home)
        const result = applyLanesPatch(JSON.parse(carrier.raw), home)
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("unreachable")
        expect(result.error.code).toBe("LANE_VALUE_NOT_A_LANE")
        expect(result.error.key).toBe(carrier.key)
        // One vocabulary, not a second one: the reason must be the shared validator's own sentence for
        // that name, the same one an ordinary unknown key produces (computed key on purpose — it is
        // the own-property form JSON.parse yields).
        const canonical = validateLanesDocument({ version: 1, lanes: { [carrier.key]: 4 } })
        expect(canonical.ok).toBe(false)
        if (canonical.ok) throw new Error("unreachable")
        expect(result.error.reason).toBe(canonical.message)
        // A refusal has no state at all, so it cannot carry a fabricated updatedAt either.
        expect("state" in result).toBe(false)
        // Nothing written: bytes, both modes and the listing are bit-identical, and the stored
        // document still has no updatedAt.
        expect(snapshot(home)).toEqual(before)
        expect(readDoc(home).updatedAt).toBeUndefined()
        expect(readDoc(home).lanes).toEqual(VALID_TUPLE)
        expect(JSON.stringify(result.error).includes(home)).toBe(false)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }

  test("a refused carrier leaves the merge machinery intact: the next legal PATCH still merges", () => {
    const home = homeWith({ doc: { version: 1, lanes: { NUQ_WORKER_COUNT: 5 } } })
    try {
      expect(applyLanesPatch(JSON.parse('{"__proto__":{"MAX_CONCURRENT_PAGES":4}}'), home).ok).toBe(false)
      const after = applyLanesPatch({ MAX_CONCURRENT_PAGES: 4 }, home)
      expect(after.ok).toBe(true)
      expect(readDoc(home).lanes).toEqual({ NUQ_WORKER_COUNT: 5, MAX_CONCURRENT_PAGES: 4 })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Layer 1c — PATCH success: merge, posture, and the no-second-table pin
// ---------------------------------------------------------------------------

describe("PATCH /global/lanes accepted writes", () => {
  test("partial-field submission merges over the stored tuple and commits whole, with 0600 in a 0700 dir", () => {
    const home = homeWith({ doc: { version: 1, lanes: { NUQ_WORKER_COUNT: 5 } } })
    try {
      const result = applyLanesPatch({ MAX_CONCURRENT_PAGES: 4, GRANIAN_BLOCKING_THREADS: 4 }, home)
      expect(result.ok).toBe(true)
      const doc = readDoc(home)
      expect(doc.version).toBe(1)
      expect(doc.lanes).toEqual(VALID_TUPLE) // merged: stored NUQ kept, both submitted keys landed
      expect(typeof doc.updatedAt).toBe("string")
      expect(Date.parse(doc.updatedAt as string)).not.toBeNaN()
      expect(fileMode(lanesFile(home))).toBe(0o600)
      expect(statSync(setupDir(home)).mode & 0o777).toBe(0o700)
      // The response is the full stored tuple AFTER commit (spec §5.2), read back from disk.
      if (!result.ok) throw new Error("unreachable")
      expect(result.state.stored).toEqual(VALID_TUPLE)
      expect(result.state.updatedAt).toBe(doc.updatedAt as string)
      expect(result.state.file.dirModeRepaired).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("writing into a home whose file does not exist yet creates it at 0600 inside the 0700 dir", () => {
    const home = homeWith()
    try {
      const result = applyLanesPatch(VALID_TUPLE, home)
      expect(result.ok).toBe(true)
      expect(existsSync(lanesFile(home))).toBe(true)
      expect(fileMode(lanesFile(home))).toBe(0o600)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a setup directory found at 0755 is repaired to 0700 and the repair is REPORTED, never silent", () => {
    const home = homeWith({ dirMode: 0o755 })
    try {
      const result = applyLanesPatch({ NUQ_WORKER_COUNT: 4 }, home)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("unreachable")
      expect(result.state.file.dirModeRepaired).toBe(true)
      expect(statSync(setupDir(home)).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an empty object is a legal no-op: same lanes, fresh stamp, posture held", () => {
    const home = homeWith({ doc: { version: 1, updatedAt: "2026-10-21T00:00:00Z", lanes: VALID_TUPLE } })
    try {
      const result = applyLanesPatch({}, home)
      expect(result.ok).toBe(true)
      expect(readDoc(home).lanes).toEqual(VALID_TUPLE)
      expect(readDoc(home).updatedAt).not.toBe("2026-10-21T00:00:00Z")
      expect(fileMode(lanesFile(home))).toBe(0o600)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("committed bytes always parse through the shared validator (the render will accept them)", () => {
    const home = homeWith()
    try {
      expect(applyLanesPatch({ NUQ_WORKER_COUNT: 4 }, home).ok).toBe(true)
      const validated = validateLanesDocument(readDoc(home))
      expect(validated.ok).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Layer 1d — concurrency: two writers never interleave
// ---------------------------------------------------------------------------

describe("PATCH /global/lanes concurrency", () => {
  test("eight concurrent REFUSED patches leave the file byte-identical and add no directory entry", async () => {
    const home = homeWith({ doc: { version: 1, updatedAt: "2026-10-21T00:00:00Z", lanes: VALID_TUPLE } })
    try {
      const before = snapshot(home)
      const attempts = Array.from({ length: 8 }, (_, i) =>
        Promise.resolve(applyLanesPatch(i % 2 === 0 ? { NUQ_WORKER_COUNT: 99 } : { laneCount: i }, home)),
      )
      const results = await Promise.all(attempts)
      for (const result of results) expect(result.ok).toBe(false)
      expect(snapshot(home)).toEqual(before)
      expect(readdirSync(setupDir(home)).filter((name) => name.startsWith(".tmp-"))).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // The real claim is CROSS-PROCESS: two writers racing through separate processes must never
  // interleave into a torn file. In-process calls are serialized by the event loop and prove less,
  // so the race runs as children (`process.execPath` — the real bun, E5) hammering one sandbox
  // file with valid and refused patches at once, while a poller reads the file throughout.
  test("concurrent PROCESS writers commit only whole documents; refused ones touch nothing", async () => {
    const home = homeWith({ doc: { version: 1, lanes: { NUQ_WORKER_COUNT: 5 } } })
    const moduleUrl = new URL("../../src/server/shared/lanes-observation.ts", import.meta.url).href
    const child = (patch: unknown) =>
      `const m = await import(${JSON.stringify(moduleUrl)});` +
      `const r = m.applyLanesPatch(${JSON.stringify(patch)}, ${JSON.stringify(home)});` +
      `process.stdout.write(r.ok ? "OK" : "REFUSED");`
    const poller =
      `let bad = 0, seen = 0;` +
      `for (let i = 0; i < 200; i++) {` +
      `  try { const t = await Bun.file(${JSON.stringify(lanesFile(home))}).text();` +
      `    const d = JSON.parse(t); if (!d || typeof d !== "object" || d.version !== 1) bad++; seen++; }` +
      `  catch (e) { if (String(e).includes("ENOENT")) continue; bad++; }` +
      `  await Bun.sleep(3);` +
      `}` +
      `process.stdout.write("POLLED=" + seen + " TORN=" + bad);`

    const specs: Array<{ code: string; tag: string }> = [
      ...[0, 1, 2].map((i) => ({ tag: `validA${i}`, code: child({ NUQ_WORKER_COUNT: 4 }) })),
      ...[0, 1, 2].map((i) => ({ tag: `validB${i}`, code: child({ MAX_CONCURRENT_PAGES: 4 }) })),
      ...[0, 1].map((i) => ({ tag: `refused${i}`, code: child({ NUQ_WORKER_COUNT: 42 }) })),
      { tag: "poller", code: poller },
    ]
    try {
      const procs = specs.map((spec) =>
        Bun.spawn([process.execPath, "-e", spec.code], { stdout: "pipe", stderr: "pipe" }),
      )
      const outputs = await Promise.all(
        procs.map(async (proc, i) => ({
          tag: specs[i].tag,
          out: new TextDecoder().decode(await readAll(proc)),
          code: await proc.exited,
        })),
      )
      const byTag = Object.fromEntries(outputs.map((o) => [o.tag, o]))
      for (const tag of ["validA0", "validA1", "validA2", "validB0", "validB1", "validB2"]) expect(byTag[tag].out).toBe("OK")
      for (const tag of ["refused0", "refused1"]) expect(byTag[tag].out).toBe("REFUSED")
      // Every observation the poller made during the race was a complete version-1 document.
      expect(byTag.poller.out).toContain("TORN=0")

      // Final state: a whole valid document whose lanes are reachable from the seed by applying
      // only the two legal edits — never a mixture containing refused values.
      const final = readDoc(home)
      const validated = validateLanesDocument(final)
      expect(validated.ok).toBe(true)
      const lanes = final.lanes as Record<string, number>
      expect([4, 5]).toContain(lanes.NUQ_WORKER_COUNT) // last valid writer wins, wholly
      if (lanes.MAX_CONCURRENT_PAGES !== undefined) expect(lanes.MAX_CONCURRENT_PAGES).toBe(4)
      expect(lanes.NUQ_WORKER_COUNT).not.toBe(42) // the refused value never landed
      expect(fileMode(lanesFile(home))).toBe(0o600)
      expect(readdirSync(setupDir(home)).filter((name) => name.startsWith(".tmp-"))).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 30000)
})

// ---------------------------------------------------------------------------
// Layer 2 — effective-value leg: exec into running carriers, argv pinned, honest degradation
// ---------------------------------------------------------------------------

function scriptedRunner(table: (argv: readonly string[]) => DockerRunOutcome) {
  const calls: Array<{ argv: string[]; timeoutMs: number }> = []
  const runner: DockerRunner = async (argv, timeoutMs) => {
    calls.push({ argv: [...argv], timeoutMs })
    return table(argv)
  }
  return { runner, calls }
}

function isPs(argv: readonly string[]) {
  return argv[2] === "ps"
}
function isExec(argv: readonly string[]) {
  return argv[2] === "exec"
}

const run = <A>(effect: Effect.Effect<A, never>) => Effect.runPromise(effect)

describe("effective observation (scripted daemon, no spawn)", () => {
  test("happy path: values come from /proc/1/environ INSIDE already-running carriers", async () => {
    const { runner, calls } = scriptedRunner((argv) => {
      if (isPs(argv)) {
        if (argv.includes("label=io.gsp.swarm.component=firecrawl"))
          return { code: 0, stdout: "swarm-tools-api-1\nswarm-tools-playwright-service-1\n" }
        return { code: 0, stdout: "swarm-tools-searxng-1\n" }
      }
      if (argv.includes("swarm-tools-api-1")) return { code: 0, stdout: "PATH=/usr/bin\nNUQ_WORKER_COUNT=5\nHOME=/root\n" }
      if (argv.includes("swarm-tools-playwright-service-1")) return { code: 0, stdout: "MAX_CONCURRENT_PAGES=4\n" }
      if (argv.includes("swarm-tools-searxng-1")) return { code: 0, stdout: "GRANIAN_MODE=thread\n" } // threads NOT set
      return { code: 1, stdout: "" }
    })
    const observed = await run(observeEffective(runner))
    expect(observed.NUQ_WORKER_COUNT).toEqual({ status: "observed", value: 5 })
    expect(observed.MAX_CONCURRENT_PAGES).toEqual({ status: "observed", value: 4 })
    // The searxng container runs WITHOUT the key: an OBSERVED ABSENCE, never false, never a value.
    expect(observed.GRANIAN_BLOCKING_THREADS).toEqual({ status: "absent" })

    // exec-not-spawn + context pinning, asserted on every argv the leg issued (E17, E10, E16):
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.argv.slice(0, 2)).toEqual(["--context", "colima-swarm"])
      expect(["ps", "exec"]).toContain(call.argv[2])
      for (const banned of ["run", "create", "start", "attach", "cp", "down", "rm", "prune"])
        expect(call.argv).not.toContain(banned)
      // Never the user's current context, never `default`, never bare `colima`.
      const contextValue = call.argv[1]
      expect(contextValue).toBe("colima-swarm")
      expect(call.argv).not.toContain("default")
      expect(call.timeoutMs).toBeGreaterThan(0)
    }
    // Discovery is label-scoped with POSITIVE filters only (E16: `label!=` is rejected by this daemon).
    for (const call of calls.filter((c) => isPs(c.argv))) {
      expect(call.argv.join(" ")).toContain("label=io.gsp.swarm.managed=true")
      expect(call.argv.join(" ")).toContain("label=io.gsp.swarm.component=")
      expect(call.argv.some((a) => a.includes("label!"))).toBe(false)
    }
    // Exec targets are ONLY the expected compose carrier names — request data never reaches argv.
    for (const call of calls.filter((c) => isExec(c.argv)))
      expect(["swarm-tools-api-1", "swarm-tools-playwright-service-1", "swarm-tools-searxng-1"]).toContain(call.argv[3])
    // The instrument is row 246's: read PID 1's environment inside the container.
    for (const call of calls.filter((c) => isExec(c.argv)))
      expect(call.argv.slice(4)).toEqual(["sh", "-c", 'tr "\\0" "\\n" </proc/1/environ'])
  })

  test("a hung or missing daemon degrades every key to its own unobserved reason — never a value, never false", async () => {
    const arms: Array<{ label: string; outcome: DockerRunOutcome; reason: string }> = [
      { label: "docker binary missing", outcome: { failure: "docker-missing" }, reason: "docker-missing" },
      { label: "daemon hung", outcome: { failure: "timeout" }, reason: "timeout" },
      { label: "listing refused", outcome: { code: 1, stdout: "" }, reason: "daemon-unreachable" },
    ]
    for (const arm of arms) {
      const { runner } = scriptedRunner(() => arm.outcome)
      const observed = await run(observeEffective(runner))
      for (const control of LANE_CONTROLS) {
        const entry = observed[control.key]
        expect(entry.status).toBe("unobserved")
        if (entry.status !== "unobserved") throw new Error("unreachable")
        expect(entry.reason).toBe(arm.reason)
      }
      // The anti-collapse invariant, measured on the wire shape itself:
      const text = JSON.stringify(observed)
      expect(text.includes(":false")).toBe(false)
      expect(text.includes(":null")).toBe(false)
    }
  })

  test("a carrier whose environ read is refused reports read-failed, not absent and not zero", async () => {
    const { runner } = scriptedRunner((argv) => {
      if (isPs(argv)) return { code: 0, stdout: argv.some((a) => a.includes("component=firecrawl")) ? "swarm-tools-api-1\n" : "swarm-tools-searxng-1\n" }
      if (argv.includes("swarm-tools-api-1")) return { code: 1, stdout: "" } // Permission denied class (row 246 saw it on three containers)
      return { code: 0, stdout: "GRANIAN_BLOCKING_THREADS=4\n" }
    })
    const observed = await run(observeEffective(runner))
    expect(observed.NUQ_WORKER_COUNT).toEqual({ status: "unobserved", reason: "read-failed" })
    expect(observed.GRANIAN_BLOCKING_THREADS).toEqual({ status: "observed", value: 4 })
    // playwright not listed for firecrawl stack → its own distinct reason:
    expect(observed.MAX_CONCURRENT_PAGES).toEqual({ status: "unobserved", reason: "container-absent" })
  })

  test("a non-integer value inside the container environment is reported as unreadable, never coerced", async () => {
    const { runner } = scriptedRunner((argv) => {
      if (isPs(argv)) return { code: 0, stdout: argv.some((a) => a.includes("component=firecrawl")) ? "swarm-tools-api-1\n" : "" }
      return { code: 0, stdout: "NUQ_WORKER_COUNT=lots\n" }
    })
    const observed = await run(observeEffective(runner))
    expect(observed.NUQ_WORKER_COUNT).toEqual({ status: "unobserved", reason: "non-integer-in-env" })
  })

  test("a runner that throws cannot reject the request: the whole leg answers stored-plus-unobserved", async () => {
    const boom: DockerRunner = async () => {
      throw new Error("spawn exploded")
    }
    const observed = await run(observeEffective(boom))
    for (const control of LANE_CONTROLS) expect(observed[control.key].status).toBe("unobserved")
  })
})

// ---------------------------------------------------------------------------
// Layer 2b — the ENVIRONMENT of a real docker child (finding F-251-9)
// ---------------------------------------------------------------------------

/** Records its own argv and which environment names it can see, then answers like the estate's CLI
 *  would: listings for `ps`, a PID 1 environ dump for `exec`. It is a stand-in for the executable,
 *  never for a daemon — nothing here contacts or starts one (rule E10). */
function stubDockerScript() {
  return [
    "#!/bin/sh",
    'printf "ARGV=%s\\n" "$*" >> "$R268_STUB_LOG"',
    'printf "SAW_HOST=%s SAW_CONTEXT=%s SAW_CONFIG=%s SAW_PATH=%s SAW_HOME=%s\\n" "${DOCKER_HOST+yes}" "${DOCKER_CONTEXT+yes}" "${DOCKER_CONFIG+yes}" "${PATH+yes}" "${HOME+yes}" >> "$R268_STUB_LOG"',
    'case " $* " in',
    '  *" ps "*)',
    '    case "$*" in *component=firecrawl*) printf "swarm-tools-api-1\\nswarm-tools-playwright-service-1\\n" ;; *) printf "swarm-tools-searxng-1\\n" ;; esac',
    "    ;;",
    '  *" exec "*) printf "PATH=/usr/bin\\nNUQ_WORKER_COUNT=5\\nMAX_CONCURRENT_PAGES=4\\nGRANIAN_BLOCKING_THREADS=4\\n" ;;',
    "  *) printf '' ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n")
}

describe("docker spawn environment (F-251-9)", () => {
  test("dockerSpawnEnv drops the three daemon-selection names and keeps PATH, HOME and the rest", () => {
    const out = dockerSpawnEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      DOCKER_HOST: "tcp://1.2.3.4:2375",
      DOCKER_CONTEXT: "default",
      DOCKER_CONFIG: "/elsewhere",
      NOT_SET: undefined,
    })
    expect(Object.keys(out).sort()).toEqual(["HOME", "LANG", "PATH"])
    // Both survivors are load-bearing: PATH is how `docker` is found, HOME is where the pinned
    // context resolves from — a sandboxed HOME sees no daemon at all (rule E15).
    expect(out.PATH).toBe("/usr/bin:/bin")
    expect(out.HOME).toBe("/home/tester")
  })

  // The claim is about a REAL Bun.spawn, so it runs one: a child bun process whose starting
  // environment carries hostile DOCKER_* names calls liveDockerRunner through observeEffective, and
  // the stub reports what its own environment actually held.
  //
  // Injection point matters and was got once: assigning process.env.X inside a `bun -e` script does
  // NOT reach a process that script later spawns on this host (Bun hands children the block captured
  // at start), so an in-child injection reads clean against PRE-fix bytes too — the VOID pairing
  // rule E4 exists to catch. Everything the arms must differ on is therefore set at spawn time.
  test("a spawned docker sees no daemon-selection variable, and the observation leg still completes over the cleared environment", async () => {
    const root = mkdtempSync(join(kiloRoot(), "r268-dockerenv-"))
    chmodSync(root, 0o700)
    const bin = join(root, "bin")
    mkdirSync(bin)
    const log = join(root, "stub.log")
    writeFileSync(log, "", "utf8")
    const stub = join(bin, "docker")
    writeFileSync(stub, stubDockerScript(), "utf8")
    chmodSync(stub, 0o755)
    const moduleUrl = new URL("../../src/server/shared/lanes-observation.ts", import.meta.url).href
    const packageDir = fileURLToPath(new URL("../../", import.meta.url))
    const child =
      `const mod = await import(${JSON.stringify(moduleUrl)});\n` +
      `const { Effect } = await import(Bun.resolveSync("effect", ${JSON.stringify(packageDir)}));\n` +
      `const observed = await Effect.runPromise(mod.observeEffective(mod.liveDockerRunner));\n` +
      `process.stdout.write("PARENT_HAS=" + [process.env.DOCKER_HOST, process.env.DOCKER_CONTEXT, process.env.DOCKER_CONFIG].join("|") + "\\n");\n` +
      `process.stdout.write("OBSERVED=" + JSON.stringify(observed) + "\\n");\n`
    try {
      const proc = Bun.spawn([process.execPath, "-e", child], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: packageDir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          R268_STUB_LOG: log,
          DOCKER_HOST: "tcp://r268-canary-host:2375",
          DOCKER_CONTEXT: "default",
          DOCKER_CONFIG: "/tmp/r268-canary-config",
        },
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const code = await proc.exited
      expect(code, `child failed, stderr: ${stderr}`).toBe(0)

      // Anti-vacuity: the environment really did carry the three names one level up, so the stub's
      // silence below is the filter working rather than an arm that never loaded anything.
      expect(stdout.split("\n")[0]).toBe("PARENT_HAS=tcp://r268-canary-host:2375|default|/tmp/r268-canary-config")

      const lines = readFileSync(log, "utf8").trimEnd().split("\n")
      const argvs = lines.filter((line) => line.startsWith("ARGV="))
      const saws = lines.filter((line) => line.startsWith("SAW_"))
      expect(argvs.length).toBeGreaterThan(0)
      // Fork G's cost bound still holds through the real runner: two listings plus one exec per carrier.
      expect(argvs.length).toBeLessThanOrEqual(5)
      for (const line of saws) expect(line).toBe("SAW_HOST= SAW_CONTEXT= SAW_CONFIG= SAW_PATH=yes SAW_HOME=yes")
      for (const line of argvs) {
        expect(line.startsWith("ARGV=--context colima-swarm ")).toBe(true)
        expect(line).not.toContain("default")
      }

      // The cleared case still WORKS: with nothing but PATH and HOME inherited, the whole leg ran and
      // parsed the stub's environ output into three observed values.
      const observedLine = stdout.split("\n").find((line) => line.startsWith("OBSERVED=")) ?? ""
      const observed = JSON.parse(observedLine.slice("OBSERVED=".length)) as Record<string, { status: string; value?: number }>
      for (const control of LANE_CONTROLS) {
        expect(observed[control.key].status).toBe("observed")
        expect(observed[control.key].value).toBeGreaterThan(0)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
})

// ---------------------------------------------------------------------------
// Layer 3 — the HTTP surface: auth posture inherited, tokens on the wire, tilde only
// ---------------------------------------------------------------------------

const PASSWORD = "r247-probe-password"

function apiLayer(password: Option.Option<string>) {
  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      // Raw HttpApi routes expose an opaque handler context at the request boundary
      // (same workaround httpapi-global-setup.test.ts uses).
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(InstanceStore.Service)({})),
    Layer.provide(Layer.mock(Permission.Service)({})),
    Layer.provide(Layer.mock(Question.Service)({})),
    Layer.provide(Layer.mock(SessionStatus.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(
      Layer.mock(Installation.Service)({
        method: () => Effect.succeed("npm"),
        latest: () => Effect.succeed("9.9.9"),
        upgrade: () => Effect.void,
      }),
    ),
    Layer.provide(ServerAuth.Config.configLayer({ password, username: "opencode" })),
  )
}

function basic(password: string) {
  return ServerAuth.header({ username: "opencode", password }) ?? ""
}

const guardedIt = testEffect(apiLayer(Option.some(PASSWORD)))
const openIt = testEffect(apiLayer(Option.none()))

function patchRequest(body: string, password?: string) {
  const req = HttpClientRequest.patch(GlobalPaths.lanes).pipe(HttpClientRequest.bodyText(body, "application/json"))
  return password ? req.pipe(HttpClientRequest.setHeader("Authorization", basic(password))) : req
}

describe("GET /global/lanes surface", () => {
  guardedIt.live("rejects an anonymous READ with 401 and a Basic challenge", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.lanes).pipe(HttpClient.execute)
      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
    }),
  )

  guardedIt.live("rejects an anonymous WRITE with 401 — the mutation door inherits the same middleware", () =>
    Effect.gen(function* () {
      // F-265-4: body is DOUBLY_REFUSED_WRITE, not VALID_TUPLE. The 401 assertion is byte-identical (auth fires
      // first); what changed is what a middleware regression would leave behind — a closed-set refusal with no
      // filesystem call, instead of a real write to the lane file (row 265 §6 measured that write).
      const response = yield* patchRequest(JSON.stringify(DOUBLY_REFUSED_WRITE)).pipe(HttpClient.execute)
      expect(response.status).toBe(401)
    }),
  )

  guardedIt.live("rejects a wrong password on both verbs", () =>
    Effect.gen(function* () {
      const read = yield* HttpClientRequest.get(GlobalPaths.lanes)
        .pipe(HttpClientRequest.setHeader("Authorization", basic("not-the-password")), HttpClient.execute)
      expect(read.status).toBe(401)
      const write = yield* patchRequest(JSON.stringify(DOUBLY_REFUSED_WRITE), "not-the-password").pipe(HttpClient.execute)
      expect(write.status).toBe(401)
    }),
  )

  guardedIt.live("answers a credentialed read with the minimum contract and no absolute paths", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.lanes)
        .pipe(HttpClientRequest.setHeader("Authorization", basic(PASSWORD)), HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as Record<string, unknown>
      // The contract is closed: these seven names are the whole surface, nothing extra rides along.
      const allowed = new Set(["observedAt", "file", "range", "stored", "updatedAt", "restartRequired", "observed"])
      for (const key of Object.keys(body)) expect(allowed.has(key)).toBe(true)
      for (const key of ["observedAt", "file", "range", "restartRequired", "observed"]) expect(key in body).toBe(true)
      expect(body.file).toEqual(expect.objectContaining({ tildePath: "~/.swarm/setup/lanes.json" }))
      expect(body.restartRequired).toBe("container-recreate")
      expect(Object.keys(body.range as Record<string, unknown>).sort()).toEqual(LANE_CONTROLS.map((c) => c.key).sort())
      // Every observation entry speaks the closed status vocabulary — never a boolean, never null.
      const observed = body.observed as Record<string, { status: string }>
      for (const entry of Object.values(observed)) expect(["observed", "absent", "unobserved"]).toContain(entry.status)
      // Payload posture (gate 195 lineage, §5.2 tilde rule): no resolved home anywhere in the body.
      const text = JSON.stringify(body)
      expect(text.includes(process.env.HOME ?? "/nonexistent-home")).toBe(false)
      expect(text.includes("/Users/")).toBe(false)
    }),
  )

  guardedIt.live("ignores directory and workspace selectors — machine-global, not instance-scoped", () =>
    Effect.gen(function* () {
      const get = (path: string) =>
        HttpClientRequest.get(path).pipe(HttpClientRequest.setHeader("Authorization", basic(PASSWORD)), HttpClient.execute)
      const plain = yield* get(GlobalPaths.lanes)
      const scoped = yield* get(`${GlobalPaths.lanes}?directory=/etc&workspace=whatever`)
      expect(plain.status).toBe(200)
      expect(scoped.status).toBe(200)
      const a = (yield* plain.json) as Record<string, unknown>
      const b = (yield* scoped.json) as Record<string, unknown>
      expect(b.file).toEqual(a.file)
      expect(b.range).toEqual(a.range)
      expect(b.restartRequired).toEqual(a.restartRequired)
    }),
  )

  // The c4-class caveat the sibling route documents: the middleware itself passes anonymous traffic
  // when NO password is configured. Reachable only off the guarded bring-up paths (serve/acp/web all
  // refuse to start unsecured); pinned here so a future listener without a guard shows up red first.
  openIt.live("answers anonymously when no password is configured (inherited caveat, not a new hole)", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.lanes).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
    }),
  )
})

describe("PATCH /global/lanes wire refusals", () => {
  // These run authenticated against the REAL home resolution but every case refuses BEFORE any
  // filesystem call exists (§4.2 order), so the user's ~/.swarm/setup/lanes.json cannot be touched
  // by them even in principle — the write-nothing proof itself is made at module level against
  // sandbox homes and on the live sandbox-HOME listener in the row artifact.
  guardedIt.live("out-of-range answers 400 with the spec token, the offending value and the imported bound", () =>
    Effect.gen(function* () {
      const response = yield* patchRequest(JSON.stringify({ NUQ_WORKER_COUNT: 9 }), PASSWORD).pipe(HttpClient.execute)
      expect(response.status).toBe(400)
      const body = (yield* response.json) as { error: Record<string, unknown> }
      expect(body.error.code).toBe("LANE_VALUE_OUT_OF_RANGE")
      expect(body.error.key).toBe("NUQ_WORKER_COUNT")
      expect(body.error.value).toBe(9)
      expect(body.error.range).toEqual({ min: 4, max: 5 })
    }),
  )

  guardedIt.live("a non-lane key answers 400 WITHOUT echoing the submitted value", () =>
    Effect.gen(function* () {
      const response = yield* patchRequest(JSON.stringify({ NUM_WORKERS_PER_QUEUE: "CANARY" }), PASSWORD).pipe(HttpClient.execute)
      expect(response.status).toBe(400)
      const text = yield* response.text
      const body = JSON.parse(text) as { error: Record<string, unknown> }
      expect(body.error.code).toBe("LANE_VALUE_NOT_A_LANE")
      expect(text.includes("CANARY")).toBe(false)
    }),
  )

  // F-265-4's independence proof (row 270): the body the auth-refusal legs now carry must be refused by the
  // VALIDATOR ITSELF, past the middleware — otherwise "doubly refused" is just "refused once, elsewhere".
  guardedIt.live("the auth legs' DOUBLY_REFUSED_WRITE body also refuses at 400 when auth passes (second layer proven)", () =>
    Effect.gen(function* () {
      const response = yield* patchRequest(JSON.stringify(DOUBLY_REFUSED_WRITE), PASSWORD).pipe(HttpClient.execute)
      expect(response.status).toBe(400)
      const body = (yield* response.json) as { error: { code: string; key: string } }
      expect(body.error.code).toBe("LANE_VALUE_NOT_A_LANE")
      expect(body.error.key).toBe("laneCount")
    }),
  )

  // E21's binding check, visible in the suite rather than only at module load: the route-side resolver points
  // into the pinned sandbox, so even a leg that completed a write could not reach the real home.
  test("the surface base resolves inside the pinned sandbox, not the ambient home (F-265-4)", () => {
    expect(lanesFilePath().startsWith(SURFACE_SANDBOX + "/")).toBe(true)
    if (HOME_BEFORE_PIN !== undefined && HOME_BEFORE_PIN !== SURFACE_SANDBOX)
      expect(lanesFilePath()).not.toBe(join(HOME_BEFORE_PIN, ".swarm", "setup", "lanes.json"))
  })

  guardedIt.live("a free-form value answers 400 LANE_VALUE_MALFORMED", () =>
    Effect.gen(function* () {
      const response = yield* patchRequest(JSON.stringify({ GRANIAN_BLOCKING_THREADS: "lots" }), PASSWORD).pipe(HttpClient.execute)
      expect(response.status).toBe(400)
      const body = (yield* response.json) as { error: { code: string } }
      expect(body.error.code).toBe("LANE_VALUE_MALFORMED")
    }),
  )

  guardedIt.live("malformed JSON bodies answer 400 with the MALFORMED token, not a framework default", () =>
    Effect.gen(function* () {
      // "{not json" and "" fail JSON.parse; "[1,2]", '"scalar"' and "null" parse but are not the
      // closed struct. All five must speak the spec's vocabulary, which a framework-default 400
      // body would not.
      for (const bodyText of ["{not json", "", "[1,2]", '"scalar"', "null"]) {
        const response = yield* patchRequest(bodyText, PASSWORD).pipe(HttpClient.execute)
        expect(response.status).toBe(400)
        const text = yield* response.text
        const parsed = JSON.parse(text) as { error?: { code?: string } }
        expect(parsed.error?.code).toBe("LANE_VALUE_MALFORMED")
      }
    }),
  )

  // F-251-3 over the wire. Row 251's instrument I-E measured these exact bodies answering 200 on a
  // live listener; the closed-set refusal is what the surface owes every name it does not accept,
  // and a 200 here would also mean a response carrying an `updatedAt` the payload never set.
  guardedIt.live("a __proto__ carrier answers 400 with the closed-set token, never a 200 with a fabricated updatedAt", () =>
    Effect.gen(function* () {
      for (const bodyText of [
        '{"__proto__":{"MAX_CONCURRENT_PAGES":4}}',
        '{"__proto__":{"totally_unrelated":"x"}}',
        '{"constructor":{"MAX_CONCURRENT_PAGES":4}}',
      ]) {
        const response = yield* patchRequest(bodyText, PASSWORD).pipe(HttpClient.execute)
        expect(response.status).toBe(400)
        const text = yield* response.text
        const parsed = JSON.parse(text) as { error?: { code?: string; key?: string } }
        expect(parsed.error?.code).toBe("LANE_VALUE_NOT_A_LANE")
        expect(parsed.error?.key).toBeString()
        // The refusal body is `{code, key, reason}`: no state, therefore no age to fabricate.
        expect(text.includes("updatedAt")).toBe(false)
        expect(text.includes(process.env.HOME ?? "/nonexistent-home")).toBe(false)
      }
    }),
  )
})
