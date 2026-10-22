// Row 245 unit suite — the lane control: lanes.json (PC-PATH-18) read, validated, refused and
// rendered. Run from packages/setup (repo rule: tests never run from the root guard):
//   bun test test/lanes.test.ts
// Collected by the package's declared command `bun test` (see the row-245 implementation record for
// the collection delta — rule E14 exists because packages/ui's suite silently skipped its own test/).
//
// Contract under test: masterplan/06_s6b_lanes_spec.md §2 (storage, modes), §3.1 (ranges), §4 (three
// refusal tokens, refuse-and-write-nothing), §5.1 (consumption points, the CA-conditional trap),
// amended for C-1 by gate 239 fork H (decisions/decisions.md: NUQ_WORKER_COUNT ships at 5, the floor
// of 4 is a validation boundary) and bounded by research/s6b_07_capacity_envelope.md §9.3 item 1
// (shipped ranges [4,5], [4,4], [4,4]). Scratch homes live under $TMPDIR/kilo only. Nothing here
// binds a port, spawns a process, touches the network or addresses ~/.swarm outside a scratch home.

import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { validateLock } from "../src/lockfile.ts"
import { renderAll, applyRenderedFiles } from "../src/composefiles/index.ts"
import { SECRET_INVENTORY } from "../src/composefiles/shared.ts"
import {
  createLanesFileAtSetup,
  LANE_CONTROLS,
  lanesPath,
  readLanes,
  SETUP_LANE_VALUES,
  validateLanesDocument,
  type LaneRefusalToken,
} from "../src/composefiles/lanes.ts"

const lockPath = join(import.meta.dir, "..", "tools.lock.json")
const loaded = validateLock(JSON.parse(readFileSync(lockPath, "utf8")))
if (!loaded.ok) throw new Error(`shipped lock must validate: ${loaded.error}`)
const lock = loaded.lock

// CLI posture (composefiles/index.ts runCli): required slots declared generated without values.
const secrets = { searxng: {}, firecrawl: {} } as Record<string, Record<string, "generated">>
for (const comp of ["searxng", "firecrawl"] as const)
  for (const spec of SECRET_INVENTORY[comp]) if (spec.required) secrets[comp][spec.name] = "generated"

function homeWith(name: string, lanesJson?: string): string {
  const dir = join(process.env.TMPDIR ?? "/tmp", "kilo", `r245-${name}-${process.pid}-${Math.floor(Math.random() * 1e6)}`)
  mkdirSync(join(dir, ".swarm", "setup"), { recursive: true })
  // The real PC-PATH-01 dir is 0700 (measured on this host: drwx------ ~/.swarm/setup). mkdirSync's
  // mode option is masked by the process umask, so the mode is set explicitly afterwards — otherwise
  // every sandbox home would start at 0755 and the mode tests would be measuring the fixture.
  chmodSync(join(dir, ".swarm", "setup"), 0o700)
  if (lanesJson !== undefined) writeFileSync(join(dir, ".swarm", "setup", "lanes.json"), lanesJson)
  return dir
}
const renderAt = (home: string, caBundlePath?: string) =>
  renderAll(lock, { home, secrets, ...(caBundlePath ? { caBundlePath } : {}) })

function artefact(r: ReturnType<typeof renderAt>, rel: string) {
  if (!r.ok) throw new Error(`render refused: ${JSON.stringify(r.errors)}`)
  const f = r.files.find((x) => x.relPath === rel)
  if (!f) throw new Error(`missing artefact ${rel}`)
  return f
}
const fcText = (r: ReturnType<typeof renderAt>) => artefact(r, "firecrawl/compose/firecrawl.yml").content
const sxText = (r: ReturnType<typeof renderAt>) => artefact(r, "searxng/compose/searxng.yml").content
const yamlOf = (text: string) => Bun.YAML.parse(text) as { services: Record<string, { environment?: Record<string, string>; extra_hosts?: string[] }> }

const laneDoc = (lanes: unknown, extra?: Record<string, unknown>) => JSON.stringify({ version: 1, lanes, ...extra })
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
function treeState(root: string): Array<[string, string]> {
  const walk = (dir: string): Array<[string, string]> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return walk(p)
      return [[p.replace(`${root}/`, ""), sha(p)] as [string, string]]
    })
  return walk(root).sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

describe("row 245 — lanes.json absent renders byte-identical bytes (AC-237-1)", () => {
  const DEFAULT_PAGES_BLOCK = [
    '      MAX_CONCURRENT_PAGES: "2"  # LIVE key owned by the playwright image: its own default is 10',
    "      # (pw:/usr/src/app/api.ts:26-29 with the ?? '10' literal, twin dist/api.js:29, enforced as",
    "      # new Semaphore(MAX_CONCURRENT_PAGES) at :160), so this 2 is a deliberate cut, not an",
    "      # upstream match; the api-side lane controls validate independently of it (§6.7 r11 note).",
  ].join("\n")

  test("no file -> no lane key anywhere, row 241's pages block verbatim, searxng has no environment:", () => {
    const home = homeWith("absent")
    expect(readLanes(home)).toEqual({ ok: true, present: false, lanes: {} })
    const r = renderAt(home)
    const fc = fcText(r)
    const sx = sxText(r)
    expect(fc).not.toContain("NUQ_WORKER_COUNT")
    expect(sx).not.toContain("GRANIAN_BLOCKING_THREADS")
    expect(sx).not.toContain("    environment:")
    expect(fc).toContain(DEFAULT_PAGES_BLOCK)
    // the four inert vendor keys stay exactly as row 241 left them, values included
    for (const inert of ["NUM_WORKERS_PER_QUEUE", "CRAWL_CONCURRENT_REQUESTS", "MAX_CONCURRENT_JOBS", "BROWSER_POOL_SIZE"])
      expect(fc).toContain(`${inert}: "2"`)
  })

  test("the default render is deterministic across two reads of the same absent file", () => {
    const home = homeWith("absent-determinism")
    expect(fcText(renderAt(home))).toBe(fcText(renderAt(home)))
    expect(sxText(renderAt(home))).toBe(sxText(renderAt(home)))
  })

  test("an empty lanes object is legal and renders today's bytes (unset is not defaulted)", () => {
    // Same home, two states: the bytes must not move between "no file" and "file with no controls",
    // which is what makes §5.1 rule 4 (an unset control stays unset) observable rather than argued.
    const home = homeWith("empty-map")
    const absentFc = fcText(renderAt(home))
    const absentSx = sxText(renderAt(home))
    writeFileSync(join(home, ".swarm", "setup", "lanes.json"), laneDoc({}))
    const read = readLanes(home)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.present).toBe(true)
    expect(read.lanes).toEqual({})
    expect(fcText(renderAt(home))).toBe(absentFc)
    expect(sxText(renderAt(home))).toBe(absentSx)
  })
})

describe("row 245 — configured values land as literals, one control per key (AC-237-2, §4.3)", () => {
  test("valid file renders three quoted literals in three different service blocks", () => {
    const home = homeWith(
      "valid",
      laneDoc({ NUQ_WORKER_COUNT: 5, MAX_CONCURRENT_PAGES: 4, GRANIAN_BLOCKING_THREADS: 4 }, { updatedAt: "2026-10-22T03:00:00Z" }),
    )
    const r = renderAt(home)
    expect(r.findings.length).toBe(0) // the §4.9 lint gate ran over these bytes and found nothing
    const fc = yamlOf(fcText(r))
    const sx = yamlOf(sxText(r))
    expect(fc.services.api.environment?.NUQ_WORKER_COUNT).toBe("5")
    expect(fc.services["playwright-service"].environment?.MAX_CONCURRENT_PAGES).toBe("4")
    expect(sx.services.searxng.environment?.GRANIAN_BLOCKING_THREADS).toBe("4")
    // quoted literals, never interpolation (§11 zero tolerance)
    for (const text of [fcText(r), sxText(r)]) expect(text).not.toContain("${")
    // literal discipline: each lane line is exactly `<int>` in quotes and nothing else can occupy
    // that position, because the validator only ever admits integers (no free-form channel exists).
    const laneLines = [...fcText(r).split("\n"), ...sxText(r).split("\n")].filter((l) =>
      /^ {6}(NUQ_WORKER_COUNT|MAX_CONCURRENT_PAGES|GRANIAN_BLOCKING_THREADS): "/.test(l),
    )
    expect(laneLines.length).toBe(3)
    for (const l of laneLines) expect(l).toMatch(/^ {6}[A-Z_]+: "\d+"  # /)
    // updatedAt round-trips for the card (row 248) without ever becoming a rendered byte
    const read = readLanes(home)
    expect(read.ok && read.updatedAt).toBe("2026-10-22T03:00:00Z")
    expect(fcText(r)).not.toContain("2026-10-22T03:00:00Z")
  })

  test("no layer collapses the tuple: one number never drives another key", () => {
    // C-1 alone at 4 (the floor) must move ONLY the api worker line: pages keeps its own literal and
    // SearXNG keeps its own absence. This is the arithmetic §4.3 forbids being lost.
    const home = homeWith("one-control", laneDoc({ NUQ_WORKER_COUNT: 4 }))
    const r = renderAt(home)
    const fc = yamlOf(fcText(r))
    expect(fc.services.api.environment?.NUQ_WORKER_COUNT).toBe("4")
    expect(fc.services["playwright-service"].environment?.MAX_CONCURRENT_PAGES).toBe("2")
    expect(yamlOf(sxText(r)).services.searxng.environment).toBeUndefined()
    // and the reverse direction: pages alone leaves workers unset and granian unmentioned
    const other = renderAt(homeWith("other-control", laneDoc({ MAX_CONCURRENT_PAGES: 4 })))
    const othFc = yamlOf(fcText(other))
    expect(othFc.services.api.environment?.NUQ_WORKER_COUNT).toBeUndefined()
    expect(othFc.services["playwright-service"].environment?.MAX_CONCURRENT_PAGES).toBe("4")
    // no aggregate lane number is expressed in either artefact
    for (const text of [fcText(other), sxText(other)]) {
      expect(text).not.toMatch(/laneCount|LANE_COUNT|\blanes:/i)
    }
  })

  test("live lane values never rewrite the four inert vendor keys", () => {
    const r = renderAt(homeWith("inert", laneDoc({ NUQ_WORKER_COUNT: 5, MAX_CONCURRENT_PAGES: 4, GRANIAN_BLOCKING_THREADS: 4 })))
    const fc = yamlOf(fcText(r))
    for (const inert of ["NUM_WORKERS_PER_QUEUE", "CRAWL_CONCURRENT_REQUESTS", "MAX_CONCURRENT_JOBS", "BROWSER_POOL_SIZE"])
      expect(fc.services.api.environment?.[inert]).toBe("2")
    expect(fcText(r)).toContain("not read by the pinned build 2.11.554-production")
  })
})

describe("row 245 — SearXNG emits environment: whether or not a CA bundle exists (AC-237-13)", () => {
  const lanesJson = laneDoc({ GRANIAN_BLOCKING_THREADS: 4 })

  test("shape 1: lane configured, NO CA bundle -> header + lane line", () => {
    const sx = sxText(renderAt(homeWith("sx-noca", lanesJson)))
    expect(sx).toContain("    environment:")
    expect(sx).toContain('      GRANIAN_BLOCKING_THREADS: "4"')
    expect(sx).not.toContain("SSL_CERT_FILE")
  })

  test("shape 2: lane configured WITH CA bundle -> one header, both entries, CA fact stays conditional", () => {
    const sx = sxText(renderAt(homeWith("sx-ca", lanesJson), "/Users/tester/ca/swarm-ca.pem"))
    expect(sx.match(/^    environment:$/gm)?.length).toBe(1)
    expect(sx).toContain("      SSL_CERT_FILE: /etc/ssl/certs/swarm-ca.pem")
    expect(sx).toContain('      GRANIAN_BLOCKING_THREADS: "4"')
    expect(sx.indexOf("SSL_CERT_FILE")).toBeLessThan(sx.indexOf("GRANIAN_BLOCKING_THREADS"))
  })

  test("control: CA bundle alone still renders exactly the CA entry (no lane leak)", () => {
    const sx = sxText(renderAt(homeWith("sx-ca-only"), "/Users/tester/ca/swarm-ca.pem"))
    expect(sx.match(/^    environment:$/gm)?.length).toBe(1)
    expect(sx).toContain("      SSL_CERT_FILE: /etc/ssl/certs/swarm-ca.pem")
    expect(sx).not.toContain("GRANIAN")
  })
})

describe("row 245 — validator bounds: fork H plus row 238's published ceilings", () => {
  test("range table is [4,5] / [4,4] / [4,4], inside row 237 §3.1's caps and never above them", () => {
    const bounds = Object.fromEntries(LANE_CONTROLS.map((c) => [c.key, [c.min, c.max]]))
    expect(bounds).toEqual({ NUQ_WORKER_COUNT: [4, 5], MAX_CONCURRENT_PAGES: [4, 4], GRANIAN_BLOCKING_THREADS: [4, 4] })
    const specCaps: Record<string, number> = { NUQ_WORKER_COUNT: 8, MAX_CONCURRENT_PAGES: 8, GRANIAN_BLOCKING_THREADS: 6 }
    for (const control of LANE_CONTROLS) expect(control.max).toBeLessThanOrEqual(specCaps[control.key])
    for (const control of LANE_CONTROLS) expect(control.min).toBe(4) // the user's floor, decisions.md:214-217
  })

  test("fork H: the setup write records 5 for C-1, and 4 stays legal as a boundary", () => {
    expect(SETUP_LANE_VALUES).toEqual({ NUQ_WORKER_COUNT: 5, MAX_CONCURRENT_PAGES: 4, GRANIAN_BLOCKING_THREADS: 4 })
    expect(validateLanesDocument({ version: 1, lanes: SETUP_LANE_VALUES }).ok).toBe(true)
    expect(validateLanesDocument({ version: 1, lanes: { NUQ_WORKER_COUNT: 4 } }).ok).toBe(true)
    expect(validateLanesDocument({ version: 1, lanes: { NUQ_WORKER_COUNT: 6 } })).toMatchObject({
      ok: false,
      token: "LANE_VALUE_OUT_OF_RANGE",
      key: "NUQ_WORKER_COUNT",
    })
  })

  test("boundary legs: every published value accepted, the value above each ceiling refused", () => {
    const accepted: Array<[string, number]> = [["NUQ_WORKER_COUNT", 4], ["NUQ_WORKER_COUNT", 5], ["MAX_CONCURRENT_PAGES", 4], ["GRANIAN_BLOCKING_THREADS", 4]]
    for (const [key, value] of accepted) expect(validateLanesDocument({ version: 1, lanes: { [key]: value } }).ok).toBe(true)
    const refused: Array<[string, number]> = [["MAX_CONCURRENT_PAGES", 5], ["MAX_CONCURRENT_PAGES", 8], ["GRANIAN_BLOCKING_THREADS", 5], ["GRANIAN_BLOCKING_THREADS", 6]]
    for (const [key, value] of refused)
      expect(validateLanesDocument({ version: 1, lanes: { [key]: value } })).toMatchObject({ ok: false, token: "LANE_VALUE_OUT_OF_RANGE", key })
  })
})

describe("row 245 — mode posture of the setup write (AC-237-6)", () => {
  test("a directory found at 0755 is verified, repaired to 0700 and reported — ensureDir would not have", () => {
    const home = homeWith("dir-repair")
    const dir = join(home, ".swarm", "setup")
    chmodSync(dir, 0o755)
    expect(statSync(dir).mode & 0o777).toBe(0o755)
    const report = createLanesFileAtSetup(home)
    expect(report.created).toBe(true)
    expect(report.dirModeBefore).toBe(0o755)
    expect(report.dirModeRepaired).toBe(true)
    expect(report.dirModeAfter).toBe(0o700)
    expect(report.fileMode).toBe(0o600)
    expect(statSync(lanesPath(home)).mode & 0o777).toBe(0o600)
  })

  test("create-if-absent: a second run changes neither the file's bytes nor the directory mode", () => {
    const home = homeWith("second-write")
    const first = createLanesFileAtSetup(home)
    const before = sha(lanesPath(home))
    const second = createLanesFileAtSetup(home)
    expect(second.created).toBe(false)
    expect(second.dirModeRepaired).toBe(false)
    expect(sha(lanesPath(home))).toBe(before)
    expect(first.fileMode).toBe(0o600)
    // and the committed bytes are readable by the same validator the render uses (round-trip)
    const read = readLanes(home)
    expect(read.ok && read.lanes).toEqual(SETUP_LANE_VALUES)
    expect(read.ok && read.updatedAt).toBeUndefined() // setup is not the app: no fabricated age (06 §2.4)
  })

  test("a pre-existing directory at 0700 is left alone and reported unrepaired", () => {
    const home = homeWith("dir-clean")
    const report = createLanesFileAtSetup(home)
    expect(report.dirModeBefore).toBe(0o700)
    expect(report.dirModeRepaired).toBe(false)
  })
})

describe("row 245 — refusal by injection: token named, nothing written, prior bytes intact", () => {
  // Every case runs against a home whose estate has ALREADY been rendered from a valid file, so
  // "writes nothing" is measured rather than argued: the rendered tree and the setup directory are
  // hashed before and after the refused render, and the hostile file itself is left byte-identical.
  const VALID = laneDoc({ NUQ_WORKER_COUNT: 5, MAX_CONCURRENT_PAGES: 4, GRANIAN_BLOCKING_THREADS: 4 })
  const cases: Array<[string, string, LaneRefusalToken, string?]> = [
    // out-of-range ABOVE the published ceilings (row 238 §9.3 item 1's refusing set)
    ["C-1 above published ceiling", laneDoc({ NUQ_WORKER_COUNT: 6 }), "LANE_VALUE_OUT_OF_RANGE", "NUQ_WORKER_COUNT"],
    ["C-2 above single-position ceiling", laneDoc({ MAX_CONCURRENT_PAGES: 5 }), "LANE_VALUE_OUT_OF_RANGE", "MAX_CONCURRENT_PAGES"],
    ["C-3 above single-position ceiling", laneDoc({ GRANIAN_BLOCKING_THREADS: 5 }), "LANE_VALUE_OUT_OF_RANGE", "GRANIAN_BLOCKING_THREADS"],
    // hand-edited private values BELOW the user's floor — 1 is exactly what the user forbade
    ["hand-edited down to one lane", laneDoc({ NUQ_WORKER_COUNT: 1 }), "LANE_VALUE_OUT_OF_RANGE", "NUQ_WORKER_COUNT"],
    ["hand-edited below floor", laneDoc({ MAX_CONCURRENT_PAGES: 2 }), "LANE_VALUE_OUT_OF_RANGE", "MAX_CONCURRENT_PAGES"],
    ["zero threads", laneDoc({ GRANIAN_BLOCKING_THREADS: 0 }), "LANE_VALUE_OUT_OF_RANGE", "GRANIAN_BLOCKING_THREADS"],
    ["negative lanes", laneDoc({ NUQ_WORKER_COUNT: -3 }), "LANE_VALUE_OUT_OF_RANGE", "NUQ_WORKER_COUNT"],
    // non-lane key names, each one named by 06 §4.1 / AC-237-4
    ["inert vendor key K1", laneDoc({ NUM_WORKERS_PER_QUEUE: 4 }), "LANE_VALUE_NOT_A_LANE", "NUM_WORKERS_PER_QUEUE"],
    ["inert vendor key K3", laneDoc({ MAX_CONCURRENT_JOBS: 4 }), "LANE_VALUE_NOT_A_LANE", "MAX_CONCURRENT_JOBS"],
    ["non-existent pool_maxsize", laneDoc({ pool_maxsize: 4 }), "LANE_VALUE_NOT_A_LANE", "pool_maxsize"],
    ["non-existent pool_block", laneDoc({ pool_block: 4 }), "LANE_VALUE_NOT_A_LANE", "pool_block"],
    ["collapsed tuple relabelled", laneDoc({ laneCount: 4 }), "LANE_VALUE_NOT_A_LANE", "laneCount"],
    ["scalar lanes field", JSON.stringify({ version: 1, lanes: 4 }), "LANE_VALUE_MALFORMED", undefined],
    // malformed JSON and malformed shapes
    ["malformed JSON", "{ this is not json", "LANE_VALUE_MALFORMED", undefined],
    ["array top level", "[1,2,3]", "LANE_VALUE_MALFORMED", undefined],
    ["version 2", JSON.stringify({ version: 2, lanes: {} }), "LANE_VALUE_MALFORMED", undefined],
    ["unknown top-level field", JSON.stringify({ version: 1, lanes: {}, extraHosts: [] }), "LANE_VALUE_MALFORMED", undefined],
    ["updatedAt not a string", JSON.stringify({ version: 1, lanes: {}, updatedAt: 0 }), "LANE_VALUE_MALFORMED", "updatedAt"],
    ["string value", laneDoc({ NUQ_WORKER_COUNT: "4" }), "LANE_VALUE_MALFORMED", "NUQ_WORKER_COUNT"],
    ["float value", laneDoc({ NUQ_WORKER_COUNT: 4.5 }), "LANE_VALUE_MALFORMED", "NUQ_WORKER_COUNT"],
    ["boolean value", laneDoc({ MAX_CONCURRENT_PAGES: true }), "LANE_VALUE_MALFORMED", "MAX_CONCURRENT_PAGES"],
    ["null value", laneDoc({ GRANIAN_BLOCKING_THREADS: null }), "LANE_VALUE_MALFORMED", "GRANIAN_BLOCKING_THREADS"],
    ["array value", laneDoc({ NUQ_WORKER_COUNT: [4] }), "LANE_VALUE_MALFORMED", "NUQ_WORKER_COUNT"],
    ["object value", laneDoc({ NUQ_WORKER_COUNT: { value: 4 } }), "LANE_VALUE_MALFORMED", "NUQ_WORKER_COUNT"],
    // negative zero must be written by hand to exist at all: JSON.stringify(-0) emits "0", so the
    // only way a file carries the token `-0` is a direct edit — which is the path §4.1 names.
    ["negative zero (hand-written)", '{"version":1,"lanes":{"GRANIAN_BLOCKING_THREADS":-0}}', "LANE_VALUE_MALFORMED", "GRANIAN_BLOCKING_THREADS"],
  ]

  for (const [name, json, token, key] of cases) {
    test(`refuses ${name} with ${token}, writing nothing`, () => {
      const home = homeWith("refuse", VALID)
      const outDir = join(process.env.TMPDIR ?? "/tmp", "kilo", `r245-out-${process.pid}-${Math.floor(Math.random() * 1e6)}`)
      const good = renderAt(home)
      const written = applyRenderedFiles(good, outDir)
      expect(written.length).toBeGreaterThan(0)
      const treeBefore = treeState(outDir)
      const setupBefore = readdirSync(join(home, ".swarm", "setup")).sort()

      // inject the hostile file over the valid one, exactly as a hand edit would
      writeFileSync(join(home, ".swarm", "setup", "lanes.json"), json)
      const r = renderAt(home)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.errors.length).toBe(1)
      expect(r.errors[0].code).toBe(token)
      expect(r.errors[0].message).toContain("lanes.json refused the render")
      if (key !== undefined) expect(r.errors[0].message).toContain(key)
      // a refusal renders no artefacts at all
      expect(r.files.length).toBe(0)
      expect(treeState(outDir)).toEqual(treeBefore)
      expect(readdirSync(join(home, ".swarm", "setup")).sort()).toEqual(setupBefore)
      // the writer must not repair-over a file it did not create (§2.3 create-if-absent)
      const report = createLanesFileAtSetup(home)
      expect(report.created).toBe(false)
      expect(sha(join(home, ".swarm", "setup", "lanes.json"))).toBe(createHash("sha256").update(json).digest("hex"))
      expect(readdirSync(join(home, ".swarm", "setup")).sort()).toEqual(setupBefore)
      expect(treeState(outDir)).toEqual(treeBefore)
    })
  }

  test("a refused render names ONE token and never echoes a value under an unknown key", () => {
    const hostile = laneDoc({ NUM_WORKERS_PER_QUEUE: "an arbitrary payload that must not be reflected" })
    const read = readLanes(homeWith("no-echo", hostile))
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.token).toBe("LANE_VALUE_NOT_A_LANE")
    expect(read.message).not.toContain("an arbitrary payload")
  })

  test("documented limit: JSON cannot tell 4.0 from 4, so the integer rule binds what parse keeps", () => {
    // Not a gap dressed up as a guarantee: any JSON reader sees the same number, so the route (row
    // 247) shares this blindness. 4.5 and "4" are refused; 4.0 parses to 4 and is accepted AS 4.
    expect(JSON.parse('{"v":4.0}').v).toBe(4)
    expect(validateLanesDocument({ version: 1, lanes: { NUQ_WORKER_COUNT: 4.0 } }).ok).toBe(true)
    expect(validateLanesDocument({ version: 1, lanes: { NUQ_WORKER_COUNT: 4.5 } }).ok).toBe(false)
  })
})

describe("row 245 — path resolution and register identity (PC-PATH-18)", () => {
  test("the file resolves under the context home, never under a second resolver", () => {
    expect(lanesPath("/Users/tester")).toBe("/Users/tester/.swarm/setup/lanes.json")
    // the sibling writers resolve the same way (dns_pins.ts PC-PATH-19, state.json PC-PATH-02)
    expect(existsSync(lanesPath("/Users/tester"))).toBe(false)
  })

  test("readLanes refuses an unreadable path rather than guessing around it", () => {
    const home = homeWith("unreadable")
    mkdirSync(join(home, ".swarm", "setup", "lanes.json"), { recursive: true })
    const read = readLanes(home)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.token).toBe("LANE_VALUE_MALFORMED")
  })
})
