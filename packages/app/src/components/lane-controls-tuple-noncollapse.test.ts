// Row 250 unit lane (blueprint 11) — the card seam of clause C ("the tuple is never collapsed").
// Runs in the plain `src` unit lane declared by packages/app/package.json (`bun run test:unit`, i.e.
// `bun test --conditions=solid --only-failures --preload ./happydom.ts ./src`). No DOM render: Solid
// JSX from this repo cannot render under either declared bun lane (rule E18), so the proof binds the
// pure content model that decides every token the card paints, exactly as row 248's own lane does.
//
// WHY THIS FILE EXISTS BESIDE lane-controls.model.test.ts. That lane (row 248) proves the three
// controls all appear, that the three OBSERVED states are per-control, that bounds are per-control,
// and that no aggregate field exists. It does not prove that each cell reports its OWN STORED number
// or its OWN identity. Two mutants built in scratch against the shipped bytes show the difference
// (both quoted in test/s6b_d5_units.md §5):
//   M1 — every cell reads C-1's stored entry: 28 pass / 0 fail in row 248's lane.
//   M5 — C-2 and C-3 report C-3's stack/service: 28 pass / 0 fail in row 248's lane.
// A card that painted the same stored number on three faces, or SearXNG's service name on Firecrawl's
// control, would ship green today. Those two shapes are what this lane makes red.
//
// WHAT IS DELIBERATELY NOT REPEATED here: the observed-state trio, the bounds-per-control check, the
// no-aggregate-field scan, the inert-key exclusion, the transport-failure anti-collapse posture and
// fork H's offered-value rule are all already load-bearing in row 248's lane; duplicating them would
// pad a count, not a guarantee. Observed values below use readings OUTSIDE our published bounds on
// purpose: an observation is what the container says (/proc/1/environ via row 246's instrument), and
// today's estate genuinely runs MAX_CONCURRENT_PAGES=2, so an out-of-range observation is legitimate
// data at this seam rather than a value the validator ever blessed.

import { describe, expect, test } from "bun:test"
import type { GlobalLanes } from "@opencode-ai/sdk/v2/client"
import { buildLaneControlModel, type LaneControlCell } from "./lane-controls.model"

function rangeTable(): Record<string, { min: number; max: number; setupValue: number; stack: string; service: string; basis: string }> {
  return {
    // The shipped table (LANE_CONTROLS in packages/setup/src/composefiles/lanes.ts:80-116), written out
    // here because the card's contract is the WIRE shape, not the setup module.
    NUQ_WORKER_COUNT: { min: 4, max: 5, setupValue: 5, stack: "firecrawl", service: "api", basis: "row 238 §4.1" },
    MAX_CONCURRENT_PAGES: { min: 4, max: 4, setupValue: 4, stack: "firecrawl", service: "playwright-service", basis: "row 238 §4.2" },
    GRANIAN_BLOCKING_THREADS: { min: 4, max: 4, setupValue: 4, stack: "searxng", service: "searxng", basis: "row 238 §4.3" },
  }
}

function payload(overrides?: Partial<GlobalLanes>): GlobalLanes {
  return {
    observedAt: "2026-10-22T06:00:00.000Z",
    file: { tildePath: "~/.swarm/setup/lanes.json", present: true },
    range: rangeTable() as unknown as GlobalLanes["range"],
    stored: { NUQ_WORKER_COUNT: 5, MAX_CONCURRENT_PAGES: 4, GRANIAN_BLOCKING_THREADS: 4 },
    updatedAt: "2026-10-22T05:59:00.000Z",
    restartRequired: "container-recreate",
    observed: {
      NUQ_WORKER_COUNT: { status: "observed", value: 5 },
      MAX_CONCURRENT_PAGES: { status: "observed", value: 4 },
      GRANIAN_BLOCKING_THREADS: { status: "observed", value: 4 },
    },
    ...overrides,
  }
}

function cell(model: ReturnType<typeof buildLaneControlModel>, key: string): LaneControlCell {
  const found = model.controls.find((c) => c.key === key)
  if (!found) throw new Error(`no cell for ${key}`)
  return found
}

function storedValue(c: LaneControlCell): number | undefined {
  return c.stored.state === "present" ? c.stored.value : undefined
}

function observedValue(c: LaneControlCell): number | string {
  if (c.observed.state === "observed") return c.observed.value
  return c.observed.state
}

describe("r250 C-card — each cell reports its OWN stored integer (mutant M1)", () => {
  test("three controls in, three own values out: 5 / 4 / 4 land on their own keys", () => {
    const model = buildLaneControlModel({ kind: "ok", observed: payload(), receivedAt: 1_700_000_000_000 })
    // One assertion per control, not one aggregate equality: an aggregate that compares whole maps can
    // pass while two of the three cells are cross-wired, which is precisely the defect under test.
    expect(storedValue(cell(model, "NUQ_WORKER_COUNT"))).toBe(5)
    expect(storedValue(cell(model, "MAX_CONCURRENT_PAGES"))).toBe(4)
    expect(storedValue(cell(model, "GRANIAN_BLOCKING_THREADS"))).toBe(4)
    // The discriminating half: C-1's 5 must not have leaked onto either neighbour's face.
    expect(storedValue(cell(model, "MAX_CONCURRENT_PAGES"))).not.toBe(storedValue(cell(model, "NUQ_WORKER_COUNT")))
    expect(storedValue(cell(model, "GRANIAN_BLOCKING_THREADS"))).not.toBe(storedValue(cell(model, "NUQ_WORKER_COUNT")))
  })

  test("a stored map naming ONE control leaves the other two absent, not filled from the named one", () => {
    const p = payload()
    p.stored = { MAX_CONCURRENT_PAGES: 4 }
    const model = buildLaneControlModel({ kind: "ok", observed: p, receivedAt: 1_700_000_000_000 })
    expect(storedValue(cell(model, "MAX_CONCURRENT_PAGES"))).toBe(4)
    expect(cell(model, "NUQ_WORKER_COUNT").stored.state).toBe("absent")
    expect(cell(model, "GRANIAN_BLOCKING_THREADS").stored.state).toBe("absent")
    // Absence carries no number anywhere on the two untouched faces.
    expect(JSON.stringify(cell(model, "NUQ_WORKER_COUNT").stored)).not.toMatch(/\d/)
    expect(JSON.stringify(cell(model, "GRANIAN_BLOCKING_THREADS").stored)).not.toMatch(/\d/)
  })

  test("the offered value is per control: one stored choice moves its own face only", () => {
    const p = payload()
    p.stored = { GRANIAN_BLOCKING_THREADS: 4 } // only C-3 was ever chosen
    const model = buildLaneControlModel({ kind: "ok", observed: p, receivedAt: 1_700_000_000_000 })
    expect(cell(model, "GRANIAN_BLOCKING_THREADS").offeredValue).toBe(4) // its own stored value
    expect(cell(model, "NUQ_WORKER_COUNT").offeredValue).toBe(5) // still C-1's setup default, not C-3's 4
    expect(cell(model, "MAX_CONCURRENT_PAGES").offeredValue).toBe(4) // its own setupValue, unpolluted
    expect(cell(model, "NUQ_WORKER_COUNT").stored.state).toBe("absent") // C-3's presence did not leak
  })
})

describe("r250 C-card — each cell reports its OWN observation, including out-of-bound readings", () => {
  test("7 / 2 / 1 stay three separate readings on three separate faces", () => {
    const p = payload()
    // Legitimate container data: the estate today renders 2 pages (below our floor of 4) and a
    // hand-edited compose could carry anything. The card mirrors what it is told; it does not clamp.
    p.observed = {
      NUQ_WORKER_COUNT: { status: "observed", value: 7 },
      MAX_CONCURRENT_PAGES: { status: "observed", value: 2 },
      GRANIAN_BLOCKING_THREADS: { status: "observed", value: 1 },
    }
    const model = buildLaneControlModel({ kind: "ok", observed: p, receivedAt: 1_700_000_000_000 })
    expect(observedValue(cell(model, "NUQ_WORKER_COUNT"))).toBe(7)
    expect(observedValue(cell(model, "MAX_CONCURRENT_PAGES"))).toBe(2)
    expect(observedValue(cell(model, "GRANIAN_BLOCKING_THREADS"))).toBe(1)
  })

  test("moving one control's observation moves exactly that cell", () => {
    const before = buildLaneControlModel({ kind: "ok", observed: payload(), receivedAt: 1_700_000_000_000 })
    const p = payload()
    p.observed = { ...p.observed, GRANIAN_BLOCKING_THREADS: { status: "unobserved", reason: "read-failed" } }
    const after = buildLaneControlModel({ kind: "ok", observed: p, receivedAt: 1_700_000_000_000 })
    // Differential probe: the two controls nobody touched are byte-identical across the two builds.
    expect(JSON.stringify(cell(after, "NUQ_WORKER_COUNT"))).toBe(JSON.stringify(cell(before, "NUQ_WORKER_COUNT")))
    expect(JSON.stringify(cell(after, "MAX_CONCURRENT_PAGES"))).toBe(JSON.stringify(cell(before, "MAX_CONCURRENT_PAGES")))
    expect(JSON.stringify(cell(after, "GRANIAN_BLOCKING_THREADS"))).not.toBe(
      JSON.stringify(cell(before, "GRANIAN_BLOCKING_THREADS")),
    )
  })
})

describe("r250 C-card — each cell carries its OWN identity and bounds (mutant M5)", () => {
  test("the key / stack / service / range quadruple is per control, stated in full", () => {
    const model = buildLaneControlModel({ kind: "ok", observed: payload(), receivedAt: 1_700_000_000_000 })
    const nuq = cell(model, "NUQ_WORKER_COUNT")
    expect([nuq.key, nuq.stack, nuq.service, nuq.min, nuq.max, nuq.setupValue]).toEqual([
      "NUQ_WORKER_COUNT",
      "firecrawl",
      "api",
      4,
      5,
      5,
    ])
    const pages = cell(model, "MAX_CONCURRENT_PAGES")
    expect([pages.key, pages.stack, pages.service, pages.min, pages.max, pages.setupValue]).toEqual([
      "MAX_CONCURRENT_PAGES",
      "firecrawl",
      "playwright-service",
      4,
      4,
      4,
    ])
    const threads = cell(model, "GRANIAN_BLOCKING_THREADS")
    expect([threads.key, threads.stack, threads.service, threads.min, threads.max, threads.setupValue]).toEqual([
      "GRANIAN_BLOCKING_THREADS",
      "searxng",
      "searxng",
      4,
      4,
      4,
    ])
    // The two single-position controls share their bounds but never their identity: that distinction is
    // the whole difference between a tuple and a collapsed number, and it is invisible to any check
    // that only asks whether a field is non-empty.
    expect(pages.service).not.toBe(threads.service)
    expect(pages.stack).not.toBe(threads.stack)
  })

  test("a payload that swaps two controls' range entries swaps their faces, not their keys", () => {
    const table = rangeTable()
    const held = table.MAX_CONCURRENT_PAGES
    table.MAX_CONCURRENT_PAGES = table.GRANIAN_BLOCKING_THREADS
    table.GRANIAN_BLOCKING_THREADS = held
    const p = payload({ range: table as unknown as GlobalLanes["range"] })
    const model = buildLaneControlModel({ kind: "ok", observed: p, receivedAt: 1_700_000_000_000 })
    // The card keys its cells off the control names it owns, so a server-side mix-up shows up as a
    // face carrying the other single-position control's service — reported, not silently re-sorted.
    expect(cell(model, "MAX_CONCURRENT_PAGES").service).toBe("searxng")
    expect(cell(model, "GRANIAN_BLOCKING_THREADS").service).toBe("playwright-service")
    expect(cell(model, "MAX_CONCURRENT_PAGES").key).toBe("MAX_CONCURRENT_PAGES")
    expect(cell(model, "GRANIAN_BLOCKING_THREADS").key).toBe("GRANIAN_BLOCKING_THREADS")
  })
})
