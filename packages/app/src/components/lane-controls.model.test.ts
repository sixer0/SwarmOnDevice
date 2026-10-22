import { describe, expect, test } from "bun:test"
import type { GlobalLanes, GlobalLanesState } from "@opencode-ai/sdk/v2/client"
import {
  buildLaneControlModel,
  buildLanePatchBody,
  classifyLanesCall,
  classifyPatchCall,
  classifyPatchThrow,
  collectLaneLiteralTokens,
  INERT_VENDOR_KEYS,
  LANE_CONTROL_KEYS,
  patchLaneControl,
  type LaneRead,
  type LaneStatusClient,
} from "./lane-controls.model"

// Mechanical proof for row 248. These run in the plain `src` unit lane (`bun test --conditions=solid`) because
// they exercise lane-controls.model.ts — the pure code that decides every token the lane surface paints. Solid JSX
// cannot render here (packages/app/tsconfig.json:14 `"jsx": "preserve"`; the transform is Vite-only — the same
// constraint recorded at home-status-card.model.test.ts:6-10), so the proof binds the content decision rather than
// a DOM tree. The `.tsx` maps these exact fields onto elements one-to-one.

function okRead(payload: GlobalLanes): LaneRead {
  return { kind: "ok", observed: payload, receivedAt: 1_700_000_000_000 }
}
function failedRead(cause: "server_unreachable" | "not_provided_by_this_server" | "http_error"): LaneRead {
  return { kind: "failed", cause }
}

// A complete GET /global/lanes payload matching row 247's published shape (s6b_d5_route.md §1) and the shipped
// range table (LANE_CONTROLS in packages/setup/src/composefiles/lanes.ts: NUQ [4,5]@5, pages [4,4]@4, granian
// [4,4]@4). Mutated per case below.
function lanesPayload(overrides?: Partial<GlobalLanes>): GlobalLanes {
  return {
    observedAt: "2026-10-22T05:00:00.000Z",
    file: { tildePath: "~/.swarm/setup/lanes.json", present: true },
    range: {
      NUQ_WORKER_COUNT: { min: 4, max: 5, setupValue: 5, stack: "firecrawl", service: "api", basis: "row 238 §4.1" },
      MAX_CONCURRENT_PAGES: { min: 4, max: 4, setupValue: 4, stack: "firecrawl", service: "playwright-service", basis: "row 238 §4.2" },
      GRANIAN_BLOCKING_THREADS: { min: 4, max: 4, setupValue: 4, stack: "searxng", service: "searxng", basis: "row 238 §4.3" },
    },
    stored: { NUQ_WORKER_COUNT: 5, MAX_CONCURRENT_PAGES: 4, GRANIAN_BLOCKING_THREADS: 4 },
    updatedAt: "2026-10-22T04:59:00.000Z",
    restartRequired: "container-recreate",
    observed: {
      NUQ_WORKER_COUNT: { status: "observed", value: 5 },
      MAX_CONCURRENT_PAGES: { status: "observed", value: 4 },
      GRANIAN_BLOCKING_THREADS: { status: "observed", value: 4 },
    },
    ...overrides,
  }
}

function control(model: ReturnType<typeof buildLaneControlModel>, key: string) {
  const cell = model.controls.find((c) => c.key === key)
  if (!cell) throw new Error(`no control cell for ${key}`)
  return cell
}

describe("work item 4 — the three observed states render distinctly and honestly, per control", () => {
  test("observed carries a real reading, distinct from stored", () => {
    const model = buildLaneControlModel(okRead(lanesPayload()))
    const nuq = control(model, "NUQ_WORKER_COUNT")
    expect(nuq.observed.state).toBe("observed")
    expect(nuq.observed.state === "observed" && nuq.observed.value).toBe(5)
  })

  test("absent is an OBSERVED absence, never a value and never false", () => {
    const p = lanesPayload()
    p.observed = { ...p.observed, MAX_CONCURRENT_PAGES: { status: "absent" } }
    const model = buildLaneControlModel(okRead(p))
    const pages = control(model, "MAX_CONCURRENT_PAGES")
    expect(pages.observed.state).toBe("absent")
    // An absence must not leak a number or a boolean anywhere on this control's observed face.
    expect(JSON.stringify(pages.observed)).not.toMatch(/:\s*(false|null|\d)/)
  })

  test("unobserved names its reason and never collapses to a value", () => {
    const p = lanesPayload()
    p.observed = { ...p.observed, GRANIAN_BLOCKING_THREADS: { status: "unobserved", reason: "docker-missing" } }
    const model = buildLaneControlModel(okRead(p))
    const g = control(model, "GRANIAN_BLOCKING_THREADS")
    expect(g.observed.state).toBe("unobserved")
    expect(g.observed.state === "unobserved" && g.observed.reason).toBe("docker-missing")
  })

  test("all three states coexist across the three controls in one capture", () => {
    const p = lanesPayload()
    p.observed = {
      NUQ_WORKER_COUNT: { status: "observed", value: 5 },
      MAX_CONCURRENT_PAGES: { status: "absent" },
      GRANIAN_BLOCKING_THREADS: { status: "unobserved", reason: "container-absent" },
    }
    const model = buildLaneControlModel(okRead(p))
    expect(control(model, "NUQ_WORKER_COUNT").observed.state).toBe("observed")
    expect(control(model, "MAX_CONCURRENT_PAGES").observed.state).toBe("absent")
    expect(control(model, "GRANIAN_BLOCKING_THREADS").observed.state).toBe("unobserved")
  })

  test("an observed key missing from the map degrades to unobserved/not_observed, not a value", () => {
    const p = lanesPayload()
    delete (p.observed as Record<string, unknown>).NUQ_WORKER_COUNT
    const model = buildLaneControlModel(okRead(p))
    const nuq = control(model, "NUQ_WORKER_COUNT")
    expect(nuq.observed.state).toBe("unobserved")
    expect(nuq.observed.state === "unobserved" && nuq.observed.reason).toBe("not_observed")
  })
})

describe("work item 4 — stored versus observed stay distinct", () => {
  test("stored-without-observation does not look like a live reading", () => {
    const p = lanesPayload()
    p.observed = { ...p.observed, NUQ_WORKER_COUNT: { status: "unobserved", reason: "daemon-unreachable" } }
    const model = buildLaneControlModel(okRead(p))
    const nuq = control(model, "NUQ_WORKER_COUNT")
    expect(nuq.stored.state).toBe("present") // the file says 5
    expect(nuq.stored.state === "present" && nuq.stored.value).toBe(5)
    expect(nuq.observed.state).toBe("unobserved") // but we could not confirm it live
    // They are different fields with different meanings — the card must not merge them.
    expect(nuq.stored.state).not.toBe(nuq.observed.state)
  })

  test("an omitted stored map (invalid file) yields absent, never a fabricated number", () => {
    const p = lanesPayload()
    delete (p as { stored?: unknown }).stored
    p.file = { tildePath: "~/.swarm/setup/lanes.json", present: true, error: "LANE_VALUE_MALFORMED: lanes file is not valid JSON" }
    const model = buildLaneControlModel(okRead(p))
    for (const c of model.controls) expect(c.stored.state).toBe("absent")
    expect(model.fileError).toContain("not valid JSON")
  })
})

describe("work item 3 — fork H: NUQ_WORKER_COUNT shows 5 with bounds [4,5]; the floor is a boundary, not a default", () => {
  test("NUQ bounds are [4,5] and the offered value is 5, never the floor 4", () => {
    const model = buildLaneControlModel(okRead(lanesPayload()))
    const nuq = control(model, "NUQ_WORKER_COUNT")
    expect(nuq.min).toBe(4)
    expect(nuq.max).toBe(5)
    expect(nuq.setupValue).toBe(5)
    expect(nuq.offeredValue).toBe(5)
    // The floor of 4 is a refusal boundary, NOT a value to offer as the default.
    expect(nuq.offeredValue).not.toBe(nuq.min)
  })

  test("with no stored file yet, NUQ still offers 5 (the setup value), not the floor", () => {
    const p = lanesPayload()
    delete (p as { stored?: unknown }).stored
    p.file = { tildePath: "~/.swarm/setup/lanes.json", present: false }
    const model = buildLaneControlModel(okRead(p))
    const nuq = control(model, "NUQ_WORKER_COUNT")
    expect(nuq.stored.state).toBe("absent")
    expect(nuq.offeredValue).toBe(5)
    expect(nuq.min).toBe(4)
  })

  test("an explicit stored 4 is honoured as current (the user chose it) while the floor stays a bound", () => {
    const p = lanesPayload()
    p.stored = { ...p.stored, NUQ_WORKER_COUNT: 4 }
    const model = buildLaneControlModel(okRead(p))
    const nuq = control(model, "NUQ_WORKER_COUNT")
    expect(nuq.offeredValue).toBe(4) // reflects the user's explicit choice
    expect(nuq.min).toBe(4) // still shown as the lower bound
    expect(nuq.max).toBe(5)
  })

  test("the single-position controls [4,4] offer their only legal value", () => {
    const model = buildLaneControlModel(okRead(lanesPayload()))
    for (const key of ["MAX_CONCURRENT_PAGES", "GRANIAN_BLOCKING_THREADS"]) {
      const c = control(model, key)
      expect(c.min).toBe(4)
      expect(c.max).toBe(4)
      expect(c.offeredValue).toBe(4)
    }
  })
})

describe("work item 1 — the tuple is shown, never one number; restart class on each face", () => {
  test("exactly the three real controls appear, each with its own range and recreate class", () => {
    const model = buildLaneControlModel(okRead(lanesPayload()))
    expect(model.controls.map((c) => c.key)).toEqual([...LANE_CONTROL_KEYS])
    for (const c of model.controls) {
      expect(c.restartClass).toBe("container-recreate")
      expect(c.stack).not.toBe("")
      expect(c.service).not.toBe("")
    }
  })

  test("no collapsed single-lane-number field exists on the model (R1 / AC-237-8)", () => {
    const model = buildLaneControlModel(okRead(lanesPayload()))
    for (const key of Object.keys(model)) expect(/laneCount|laneTotal|aggregate|ready|percent|score|verdict/i.test(key)).toBe(false)
    // No painted literal is a merged "N lanes" figure.
    const tokens = collectLaneLiteralTokens(model)
    expect(tokens.some((t) => /\blane(s)?\b.*\d|\d+\s*(lanes|lane)\b/i.test(t))).toBe(false)
  })
})

describe("work item 2 — the four inert vendor keys are NEVER rendered as values", () => {
  test("none of the inert keys appears in the model even when the payload surfaces them", () => {
    const p = lanesPayload()
    // A hostile/stale payload tries to smuggle the inert knobs into every map.
    ;(p.stored as Record<string, number>).NUM_WORKERS_PER_QUEUE = 2
    ;(p.range as Record<string, unknown>).CRAWL_CONCURRENT_REQUESTS = { min: 1, max: 99, setupValue: 2, stack: "firecrawl", service: "api", basis: "inert" }
    ;(p.observed as Record<string, unknown>).MAX_CONCURRENT_JOBS = { status: "observed", value: 2 }
    ;(p.observed as Record<string, unknown>).BROWSER_POOL_SIZE = { status: "observed", value: 2 }
    const model = buildLaneControlModel(okRead(p))
    expect(model.controls.map((c) => c.key).sort()).toEqual([...LANE_CONTROL_KEYS].sort())
    const tokens = collectLaneLiteralTokens(model)
    for (const inert of INERT_VENDOR_KEYS) expect(tokens).not.toContain(inert)
  })
})

describe("anti-collapse — a transport failure cannot produce a value", () => {
  test("every failed-read cause yields all controls absent+unobserved with NO number painted", () => {
    for (const cause of ["server_unreachable", "not_provided_by_this_server", "http_error"] as const) {
      const model = buildLaneControlModel(failedRead(cause))
      expect(model.controls.length).toBe(3) // a knob is never silently dropped
      for (const c of model.controls) {
        expect(c.stored.state).toBe("absent")
        expect(c.observed.state).toBe("unobserved")
        expect(c.observed.state === "unobserved" && c.observed.reason).toBe(cause)
        expect(Number.isNaN(c.offeredValue)).toBe(true)
        expect(Number.isNaN(c.min)).toBe(true)
        expect(c.sourceToken).toBe("unknown")
      }
      // The strongest form: nothing the card would paint from a failed read is a bare integer.
      const tokens = collectLaneLiteralTokens(model)
      expect(tokens.some((t) => /^-?\d+$/.test(t))).toBe(false)
      // And no absence collapses to false/null on the JSON text (row 247 §6's invariant, mirrored).
      expect(JSON.stringify(model)).not.toMatch(/"(value|stored)":(false|null)/)
    }
  })

  test("an undefined read (never fetched) is identical in posture to a transport failure", () => {
    const model = buildLaneControlModel(undefined)
    for (const c of model.controls) {
      expect(c.stored.state).toBe("absent")
      expect(c.observed.state).toBe("unobserved")
    }
    expect(collectLaneLiteralTokens(model).some((t) => /^-?\d+$/.test(t))).toBe(false)
  })
})

describe("read classification mirrors row 247's degradation vocabulary", () => {
  test("a clean 404 is not_provided_by_this_server, never 'unconfigured'", () => {
    const read = classifyLanesCall({ response: { status: 404, ok: false } })
    expect(read.kind === "failed" && read.cause).toBe("not_provided_by_this_server")
  })
  test("a 200 whose body lacks the published shape is skew, not half-trusted", () => {
    const read = classifyLanesCall({ response: { status: 200, ok: true }, data: { unexpected: true } })
    expect(read.kind === "failed" && read.cause).toBe("unrecognized_response")
  })
  test("a well-formed 200 is ok", () => {
    const read = classifyLanesCall({ response: { status: 200, ok: true }, data: lanesPayload() })
    expect(read.kind).toBe("ok")
  })
})

describe("work item 5 — the write path refuses loudly and claims nothing beyond the route", () => {
  test("an out-of-range PATCH surfaces the token + offending value + range, NOT a clamp", () => {
    const outcome = classifyPatchCall({
      response: { status: 400, ok: false },
      data: { error: { code: "LANE_VALUE_OUT_OF_RANGE", key: "NUQ_WORKER_COUNT", value: 6, range: { min: 4, max: 5 } } },
    })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind === "refused") {
      expect(outcome.token).toBe("LANE_VALUE_OUT_OF_RANGE")
      expect(outcome.value).toBe(6) // echoed, not coerced to 5
      expect(outcome.range).toEqual({ min: 4, max: 5 })
    }
  })

  test("a non-lane key refusal echoes the key only, never the value (hostile-payload non-claim)", () => {
    const outcome = classifyPatchCall({
      response: { status: 400, ok: false },
      data: { error: { code: "LANE_VALUE_NOT_A_LANE", key: "NUM_WORKERS_PER_QUEUE" } },
    })
    expect(outcome.kind === "refused" && outcome.token).toBe("LANE_VALUE_NOT_A_LANE")
    expect(outcome.kind === "refused" && outcome.key).toBe("NUM_WORKERS_PER_QUEUE")
    expect(outcome.kind === "refused" && outcome.value).toBeUndefined()
  })

  test("buildLanePatchBody refuses an inert key LOCALLY before any request", () => {
    const built = buildLanePatchBody("NUM_WORKERS_PER_QUEUE", 8)
    expect(built.ok).toBe(false)
  })

  test("patchLaneControl short-circuits an inert key without calling the client", async () => {
    let called = false
    const client = { global: { lanes: { get: async () => ((called = true), {}), update: async () => ((called = true), {}) } } } as unknown as LaneStatusClient
    const outcome = await patchLaneControl(client, "BROWSER_POOL_SIZE", 4)
    expect(outcome.kind).toBe("refused")
    expect(called).toBe(false) // the inert key never reaches the network
  })

  test("a successful PATCH reports applied stored + recreate requirement, and claims NO effective/applied value", () => {
    const state: GlobalLanesState = {
      observedAt: "2026-10-22T05:01:00.000Z",
      file: { tildePath: "~/.swarm/setup/lanes.json", present: true },
      range: lanesPayload().range,
      stored: { NUQ_WORKER_COUNT: 4, MAX_CONCURRENT_PAGES: 4, GRANIAN_BLOCKING_THREADS: 4 },
      restartRequired: "container-recreate",
    }
    const outcome = classifyPatchCall({ response: { status: 200, ok: true }, data: state })
    expect(outcome.kind).toBe("applied")
    if (outcome.kind === "applied") {
      expect(outcome.stored?.NUQ_WORKER_COUNT).toBe(4)
      expect(outcome.restartRequired).toBe("container-recreate")
      // GlobalLanesState has no observed field; the outcome must not invent one.
      expect("observed" in outcome).toBe(false)
      expect("effective" in outcome).toBe(false)
    }
  })

  test("an auth 401 on PATCH is a failure, not a silent success", () => {
    const outcome = classifyPatchCall({ response: { status: 401, ok: false }, error: { message: "Unauthorized" } })
    expect(outcome.kind === "failed" && outcome.cause).toBe("http_error")
  })

  test("a thrown 400 still surfaces the refusal token, not a clamp", () => {
    const err = { response: { status: 400 }, error: { code: "LANE_VALUE_MALFORMED", reason: "expected an integer" } }
    const outcome = classifyPatchThrow(err)
    expect(outcome.kind === "refused" && outcome.token).toBe("LANE_VALUE_MALFORMED")
  })
})

describe("freshness keeps server read time distinct from client arrival (R3)", () => {
  test("observedAt and receivedAt are separate fields", () => {
    const model = buildLaneControlModel(okRead(lanesPayload()))
    expect(model.freshness.observedAt).toBe("2026-10-22T05:00:00.000Z")
    expect(model.freshness.receivedAt).toBe(1_700_000_000_000)
  })
  test("a failed read publishes no freshness rather than inventing one", () => {
    const model = buildLaneControlModel(failedRead("server_unreachable"))
    expect(model.freshness.observedAt).toBeUndefined()
    expect(model.freshness.receivedAt).toBeUndefined()
  })
})
