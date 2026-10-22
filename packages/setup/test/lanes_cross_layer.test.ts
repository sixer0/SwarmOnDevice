// Row 250 unit lane (blueprint 11) — the cross-cutting half of the guarantee set: the lane file has
// TWO doors (the render reads it, the machine-global route writes it) and one schema gate, and my
// clause says the tuple is never collapsed and an out-of-range value refuses without writing. Each
// authoring row could only see its own door: row 245's lane (test/lanes.test.ts) never imports the
// route, row 247's lane (packages/opencode/test/server/httpapi-global-lanes.test.ts) never renders.
// So no committed test feeds the SAME bytes to both and compares their verdicts. That comparison is
// this file. Run from packages/setup:
//   bun test test/lanes_cross_layer.test.ts
// Collected by the package's declared command `bun test` (packages/setup declares no `test` script;
// rule E14). Scratch under $TMPDIR/kilo only; explicit sandbox home on every call (rule E7); no
// port, no process, no docker, no network (rule E10).
//
// THE DISAGREEMENT QUESTION, stated before the code. Row 237 published caps [4,8]/[4,8]/[4,6]
// (masterplan/06_s6b_lanes_spec.md §3.1, restated in §4.1's wire example as `{ min: 4, max: 8 }`);
// row 238 published shipped ceilings [4,5]/[4,4]/[4,4] (research/s6b_07_capacity_envelope.md §4.1-§4.3
// "Published shipped ceiling"), and gate 239 fork H moved C-1's stored value to 5. A value such as
// NUQ_WORKER_COUNT=6 is therefore INSIDE row 237's cap and OUTSIDE row 238's ceiling. What this file
// establishes by running, rather than by reading:
//   (a) there is exactly one table in the shipped code — packages/setup/src/composefiles/lanes.ts:80-116
//       is the only place a lane bound is written (grep over packages/*/src for `max: <digit>` returns
//       those three lines and nothing lane-shaped elsewhere), and BOTH doors import it;
//   (b) consequently neither door can "silently win": for every stale-but-in-cap value the render and
//       the route refuse with the same token naming the same key, and the route additionally refuses to
//       merge anything over such a file;
//   (c) the agreement is not an artefact of refusing everything — the acceptance leg runs the same
//       comparison on the values both doors must accept.

import { describe, expect, test, afterAll } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { validateLock } from "../src/lockfile.ts"
import { renderAll, applyRenderedFiles } from "../src/composefiles/index.ts"
import { SECRET_INVENTORY } from "../src/composefiles/shared.ts"
import {
  LANE_CONTROLS,
  SETUP_LANE_VALUES,
  createLanesFileAtSetup,
  lanesPath,
  validateLanesDocument,
  type LaneKey,
} from "../src/composefiles/lanes.ts"
import {
  applyLanesPatch,
  laneRangeMap,
  lanesStateObservation,
} from "../../opencode/src/server/shared/lanes-observation.ts"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const KILO_ROOT = join(process.env.TMPDIR ?? "/tmp", "kilo")
/** One parent directory for the whole run, removed in afterAll: every home and every rendered
 *  estate lives underneath it, so a green run leaves nothing behind in $TMPDIR/kilo. */
const RUN_ROOT = join(KILO_ROOT, `r250-xc-${process.pid}-${Math.floor(Math.random() * 1e6)}`)

afterAll(() => {
  rmSync(RUN_ROOT, { recursive: true, force: true })
})

function sandboxHome(tag: string): string {
  const home = join(RUN_ROOT, `${tag}-${Math.floor(Math.random() * 1e6)}`)
  if (!home.startsWith(`${RUN_ROOT}/`)) throw new Error(`non-scratch home: ${home}`)
  mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
  chmodSync(join(home, ".swarm"), 0o700)
  chmodSync(join(home, ".swarm", "setup"), 0o700)
  return home
}

const lockPath = join(import.meta.dir, "..", "tools.lock.json")
const loaded = validateLock(JSON.parse(readFileSync(lockPath, "utf8")))
if (!loaded.ok) throw new Error(`shipped lock must validate: ${loaded.error}`)
const lock = loaded.lock

const secrets = { searxng: {}, firecrawl: {} } as Record<string, Record<string, "generated">>
for (const comp of ["searxng", "firecrawl"] as const)
  for (const spec of SECRET_INVENTORY[comp]) if (spec.required) secrets[comp][spec.name] = "generated"

function renderAt(home: string) {
  return renderAll(lock, { home, secrets })
}

function textOf(r: ReturnType<typeof renderAt>, rel: string): string {
  if (!r.ok) throw new Error(`render refused: ${JSON.stringify(r.errors)}`)
  const file = r.files.find((f) => f.relPath === rel)
  if (!file) throw new Error(`missing artefact ${rel}`)
  return file.content
}
const fcText = (r: ReturnType<typeof renderAt>) => textOf(r, "firecrawl/compose/firecrawl.yml")
const sxText = (r: ReturnType<typeof renderAt>) => textOf(r, "searxng/compose/searxng.yml")
const yamlOf = (text: string) => Bun.YAML.parse(text) as { services: Record<string, { environment?: Record<string, string> }> }

/** The whole tuple with one control replaced — so a refusal can only be about that control. */
function tupleWith(key: LaneKey, value: number): string {
  return JSON.stringify({ version: 1, lanes: { ...SETUP_LANE_VALUES, [key]: value } }, null, 2) + "\n"
}

/** One control named, the other two left absent — so an acceptance claim cannot be confused with a
 *  neighbour's literal (the sparse-by-design rule, 06 §5.1 item 4). */
function singleKey(key: LaneKey, value: number): string {
  return JSON.stringify({ version: 1, lanes: { [key]: value } }, null, 2) + "\n"
}

function boundOf(key: LaneKey) {
  const control = LANE_CONTROLS.find((c) => c.key === key)
  if (!control) throw new Error(`no shipped control named ${key}`)
  return control
}

function seed(home: string, text: string, fileMode = 0o600): string {
  writeFileSync(lanesPath(home), text)
  chmodSync(lanesPath(home), fileMode)
  return text
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function posture(home: string) {
  const file = lanesPath(home)
  return {
    listing: readdirSync(join(home, ".swarm", "setup")).sort().join(","),
    sha: sha(file),
    fileMode: statSync(file).mode & 0o777,
    dirMode: statSync(join(home, ".swarm", "setup")).mode & 0o777,
  }
}

function treeState(root: string): Array<[string, string]> {
  const walk = (dir: string): Array<[string, string]> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walk(path)
      return [[path.replace(`${root}/`, ""), sha(path)] as [string, string]]
    })
  return walk(root).sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

// Row 237 §3.1's documented caps, carried here as DATA so a test can say which table a value sits
// inside. They are documentation figures from masterplan/06_s6b_lanes_spec.md, not a second validator.
const SPEC_CAPS_237: Record<LaneKey, number> = {
  NUQ_WORKER_COUNT: 8,
  MAX_CONCURRENT_PAGES: 8,
  GRANIAN_BLOCKING_THREADS: 6,
}

/** Legal to row 237's caps, stale against row 238's shipped ceilings — the disagreement set. */
const STALE_INSIDE_CAPS: Array<[LaneKey, number]> = [
  ["NUQ_WORKER_COUNT", 6],
  ["NUQ_WORKER_COUNT", 7],
  ["NUQ_WORKER_COUNT", 8],
  ["MAX_CONCURRENT_PAGES", 5],
  ["MAX_CONCURRENT_PAGES", 6],
  ["MAX_CONCURRENT_PAGES", 8],
  ["GRANIAN_BLOCKING_THREADS", 5],
  ["GRANIAN_BLOCKING_THREADS", 6],
]

// ---------------------------------------------------------------------------
// X1 — the disagreement set refuses the same way at both doors
// ---------------------------------------------------------------------------

describe("r250 X1 — a value inside row 237's cap but outside row 238's ceiling: one verdict, both doors", () => {
  for (const [key, value] of STALE_INSIDE_CAPS) {
    test(`${key}=${value} is inside the 237 cap yet refuses at the render AND the route with one token`, () => {
      // The premise, checked rather than assumed: this value would have been legal under row 237's
      // own published cap. If this line ever goes red, the tables moved and the premise died with them.
      expect(value).toBeGreaterThan(boundOf(key).max)
      expect(value).toBeLessThanOrEqual(SPEC_CAPS_237[key])

      const home = sandboxHome("disagree")
      seed(home, tupleWith(key, value))

      // Door 1 — the render.
      const r = renderAt(home)
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.errors.length).toBe(1)
      expect(r.errors[0].code).toBe("LANE_VALUE_OUT_OF_RANGE")
      expect(r.errors[0].message).toContain(key)
      expect(r.files.length).toBe(0)

      // Door 2 — the route's read: same token, same key, and `stored` withheld rather than emptied.
      const state = lanesStateObservation(home)
      expect(state.file.error?.startsWith("LANE_VALUE_OUT_OF_RANGE:")).toBe(true)
      expect(state.file.error).toContain(key)
      expect("stored" in state).toBe(false)

      // Door 2b — the route's write refuses to merge ANYTHING over such a file, including a legal
      // edit and including an empty edit, so the stale value cannot survive behind a green response.
      const emptyMerge = applyLanesPatch({}, home)
      expect(emptyMerge.ok).toBe(false)
      if (emptyMerge.ok) throw new Error("unreachable")
      expect(emptyMerge.error.code).toBe("LANE_VALUE_OUT_OF_RANGE")
      const legalMerge = applyLanesPatch({ MAX_CONCURRENT_PAGES: 4 }, home)
      expect(legalMerge.ok).toBe(false)
      if (legalMerge.ok) throw new Error("unreachable")
      expect(legalMerge.error.code).toBe("LANE_VALUE_OUT_OF_RANGE")

      // Nothing was written by any of the four probes above.
      expect(sha(lanesPath(home))).toBe(createHash("sha256").update(tupleWith(key, value)).digest("hex"))
    })
  }

  test("the bounds the route publishes ARE the bounds the render refuses against — one table, digit for digit", () => {
    const published = laneRangeMap()
    for (const control of LANE_CONTROLS) {
      expect(published[control.key]).toEqual({
        min: control.min,
        max: control.max,
        setupValue: control.setupValue,
        stack: control.stack,
        service: control.service,
        basis: control.basis,
      })
    }
    // And the shipped table is row 238's, not row 237's: the ceilings sit at or below the documented
    // caps, which is the direction 237 §8.2 allows ("only downward").
    expect(Object.fromEntries(LANE_CONTROLS.map((c) => [c.key, [c.min, c.max]]))).toEqual({
      NUQ_WORKER_COUNT: [4, 5],
      MAX_CONCURRENT_PAGES: [4, 4],
      GRANIAN_BLOCKING_THREADS: [4, 4],
    })
    for (const control of LANE_CONTROLS) expect(control.max).toBeLessThanOrEqual(SPEC_CAPS_237[control.key])
  })
})

// ---------------------------------------------------------------------------
// X2 — the acceptance leg, so X1 cannot pass by refusing everything
// ---------------------------------------------------------------------------

describe("r250 X2 — the doors agree on acceptance too", () => {
  const ACCEPTED: Array<[LaneKey, number]> = [
    ["NUQ_WORKER_COUNT", 4],
    ["NUQ_WORKER_COUNT", 5],
    ["MAX_CONCURRENT_PAGES", 4],
    ["GRANIAN_BLOCKING_THREADS", 4],
  ]
  for (const [key, value] of ACCEPTED) {
    test(`${key}=${value} renders as its own literal AND is reported as stored by the route`, () => {
      const home = sandboxHome("accept")
      seed(home, singleKey(key, value))
      const r = renderAt(home)
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.findings.length).toBe(0)
      const fc = yamlOf(fcText(r)).services
      const sx = yamlOf(sxText(r)).services
      const rendered =
        key === "NUQ_WORKER_COUNT"
          ? fc.api.environment?.[key]
          : key === "MAX_CONCURRENT_PAGES"
            ? fc["playwright-service"].environment?.[key]
            : sx.searxng.environment?.[key]
      expect(rendered).toBe(String(value)) // its OWN key, in its OWN service block
      const state = lanesStateObservation(home)
      expect(state.stored).toEqual({ [key]: value }) // sparse: the other two stay unset, never defaulted
      expect(state.file.error).toBeUndefined()
    })
  }

  test("the full tuple survives both doors unharmed and unmixed", () => {
    const home = sandboxHome("full-tuple")
    seed(home, tupleWith("NUQ_WORKER_COUNT", 5))
    const r = renderAt(home)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    const fc = yamlOf(fcText(r)).services
    const sx = yamlOf(sxText(r)).services
    expect(fc.api.environment?.NUQ_WORKER_COUNT).toBe("5")
    expect(fc["playwright-service"].environment?.MAX_CONCURRENT_PAGES).toBe("4")
    expect(sx.searxng.environment?.GRANIAN_BLOCKING_THREADS).toBe("4")
    expect(lanesStateObservation(home).stored).toEqual({ ...SETUP_LANE_VALUES })
  })
})

// ---------------------------------------------------------------------------
// X3 — mixed payload at every layer that accepts input
// ---------------------------------------------------------------------------

describe("r250 X3 — a mixed payload (two legal, one hostile) refuses wholly at every input layer", () => {
  // Two of the three values are perfectly legal; the middle control carries the hostile one. Naming
  // the hostile key and applying NEITHER legal sibling is the claim, at three separate seams.
  const MIXED = { NUQ_WORKER_COUNT: 4, MAX_CONCURRENT_PAGES: 9, GRANIAN_BLOCKING_THREADS: 4 }
  const PRIOR = JSON.stringify({ version: 1, lanes: { ...SETUP_LANE_VALUES } }, null, 2) + "\n"

  test("validator seam: the refusal names the hostile control and only it", () => {
    const result = validateLanesDocument({ version: 1, lanes: MIXED })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.token).toBe("LANE_VALUE_OUT_OF_RANGE")
    expect(result.key).toBe("MAX_CONCURRENT_PAGES")
  })

  test("render seam: the prior estate is bit-identical, both modes hold, and neither legal value lands", () => {
    const home = sandboxHome("mixed-render")
    seed(home, PRIOR)
    const outDir = join(RUN_ROOT, `mixed-out-${Math.floor(Math.random() * 1e6)}`)
    const written = applyRenderedFiles(renderAt(home), outDir)
    expect(written.length).toBeGreaterThan(0)
    const treeBefore = treeState(outDir)
    const setupBefore = readdirSync(join(home, ".swarm", "setup")).sort()

    seed(home, JSON.stringify({ version: 1, lanes: MIXED }))
    // Capture the posture AFTER the hostile file is in place: the render's obligation is to leave
    // THAT state alone, bytes, modes and listing alike.
    const hostilePosture = posture(home)
    const r = renderAt(home)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.errors[0].code).toBe("LANE_VALUE_OUT_OF_RANGE")
    expect(r.files.length).toBe(0)
    expect(treeState(outDir)).toEqual(treeBefore)
    expect(readdirSync(join(home, ".swarm", "setup")).sort()).toEqual(setupBefore)
    expect(posture(home)).toEqual(hostilePosture)
    // The two legal halves did not sneak through on the back of the refusal: the estate on disk still
    // carries the PRIOR tuple's worker literal (5), not the mixed payload's legal 4.
    const apiEnv = treeState(outDir).find((entry) => entry[0].endsWith("firecrawl.yml"))
    if (!apiEnv) throw new Error("the prior firecrawl artefact vanished")
    const priorBytes = readFileSync(join(outDir, apiEnv[0]), "utf8")
    expect(priorBytes).toContain('      NUQ_WORKER_COUNT: "5"')
    expect(priorBytes).not.toContain('      NUQ_WORKER_COUNT: "4"')
  })

  test("route seam: bytes, both modes and the directory listing are bit-identical after the refusal", () => {
    const home = sandboxHome("mixed-route")
    seed(home, PRIOR)
    const before = posture(home)
    const result = applyLanesPatch(MIXED, home)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("LANE_VALUE_OUT_OF_RANGE")
    expect(result.error.key).toBe("MAX_CONCURRENT_PAGES")
    expect(result.error.value).toBe(9)
    expect(result.error.range).toEqual({ min: 4, max: 4 })
    expect(posture(home)).toEqual(before)
    expect(readdirSync(join(home, ".swarm", "setup")).filter((n) => n.startsWith(".tmp-"))).toEqual([])
    expect(JSON.parse(readFileSync(lanesPath(home), "utf8")).lanes).toEqual({ ...SETUP_LANE_VALUES })
  })

  test("the render door does not even chmod: a refusal against a drifted directory leaves the drift", () => {
    const home = sandboxHome("mixed-render-chmod")
    chmodSync(join(home, ".swarm", "setup"), 0o755)
    seed(home, JSON.stringify({ version: 1, lanes: MIXED }), 0o644)
    const r = renderAt(home)
    expect(r.ok).toBe(false)
    expect(statSync(join(home, ".swarm", "setup")).mode & 0o777).toBe(0o755)
    expect(statSync(lanesPath(home)).mode & 0o777).toBe(0o644)
  })
})

// ---------------------------------------------------------------------------
// X4 — fork H's asymmetry, across all four seams in one statement
// ---------------------------------------------------------------------------

describe("r250 X4 — fork H: a stored 4 is accepted everywhere, 4 is never the fresh-install default anywhere", () => {
  test("the floor 4 is accepted as a STORED choice at the validator, the render and the route", () => {
    expect(validateLanesDocument({ version: 1, lanes: { ...SETUP_LANE_VALUES, NUQ_WORKER_COUNT: 4 } }).ok).toBe(true)

    const storedHome = sandboxHome("forkh-stored")
    seed(storedHome, tupleWith("NUQ_WORKER_COUNT", 4))
    const r = renderAt(storedHome)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(yamlOf(fcText(r)).services.api.environment?.NUQ_WORKER_COUNT).toBe("4")
    expect(lanesStateObservation(storedHome).stored).toEqual({ ...SETUP_LANE_VALUES, NUQ_WORKER_COUNT: 4 })

    const patchHome = sandboxHome("forkh-patch")
    seed(patchHome, tupleWith("NUQ_WORKER_COUNT", 5))
    const patched = applyLanesPatch({ NUQ_WORKER_COUNT: 4 }, patchHome)
    expect(patched.ok).toBe(true)
    expect(JSON.parse(readFileSync(lanesPath(patchHome), "utf8")).lanes.NUQ_WORKER_COUNT).toBe(4)
  })

  test("no seam offers 4 to a fresh install: setup writes 5, the route publishes 5, the default render names nothing", () => {
    expect(SETUP_LANE_VALUES.NUQ_WORKER_COUNT).toBe(5)
    expect(laneRangeMap().NUQ_WORKER_COUNT.setupValue).toBe(5)

    const fresh = sandboxHome("forkh-fresh")
    const report = createLanesFileAtSetup(fresh)
    expect(report.created).toBe(true)
    expect(JSON.parse(readFileSync(lanesPath(fresh), "utf8")).lanes.NUQ_WORKER_COUNT).toBe(5)
    expect(lanesStateObservation(fresh).stored?.NUQ_WORKER_COUNT).toBe(5)

    // With no file at all the api block carries NO NUQ_WORKER_COUNT line: the image's own 5 stands,
    // and the number 4 appears nowhere as a substitute for a decision the user never made.
    const bare = sandboxHome("forkh-bare")
    const r = renderAt(bare)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(fcText(r)).not.toContain("NUQ_WORKER_COUNT")
  })

  test("accepting the stored 4 does not soften the floor: 3 refuses at both doors", () => {
    const home = sandboxHome("forkh-floor")
    seed(home, tupleWith("NUQ_WORKER_COUNT", 3))
    const r = renderAt(home)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.errors[0].code).toBe("LANE_VALUE_OUT_OF_RANGE")
    const state = lanesStateObservation(home)
    expect(state.file.error?.startsWith("LANE_VALUE_OUT_OF_RANGE:")).toBe(true)
    expect(applyLanesPatch({ NUQ_WORKER_COUNT: 3 }, sandboxHome("forkh-floor-patch")).ok).toBe(false)
  })
})
