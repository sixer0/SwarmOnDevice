// Row 268 (Q5 of row 252's review) — the generated-surface freshness gate.
//
// WHY THIS FILE EXISTS. The repo's only generated-diff gate is `check:generated` in packages/client,
// which regenerates `src/generated` and `src/generated-effect` from the PROTOCOL surface and diffs
// those two directories. A server route lives nowhere near them: measured at row 201 §7.3, `/global/`
// appears in neither directory, so the command returns 0 whether the route exists or not — which is
// exactly how row 247's new global route passed it unnoticed. Nothing else in the repo ever compared
// the committed `packages/sdk/openapi.json` with what the handlers actually declare (grep for
// `sdk/openapi.json` under packages/opencode/test returned nothing before this file was written), so
// a future row could change a response shape, leave the committed contract stale, and stay green in
// every gate. That is standing debt, not a live defect: the bytes were consistent when this row began
// (row 252 Q5 verified the surface by hand, and this file's first test re-measures it from here on).
//
// WHAT THE GATE COVERS, and what it deliberately does not:
//  - Tier A regenerates through the sanctioned stdout-only path (`bun run ./src/index.ts generate`,
//    row 201's method) and requires BYTE equality with the committed document. Any handler or schema
//    change that is not regenerated lands in that byte comparison, because every contract change
//    passes through the generator. `script/generate.ts` is NOT used: it chains `script/format.ts`,
//    which is `prettier --write .` over the whole tree.
//  - Tier B covers the half Tier A cannot see: a row that regenerates the spec but skips the SDK
//    build. It is a structural claim scoped to the `/global/` surface on purpose — a whole-document
//    "every component appears in types.gen.ts" rule fails today (six components referenced by legacy
//    paths are genuinely absent from the generated types), and a gate that needs an exclusion list is
//    weaker than it looks. Byte-level freshness of `src/v2/gen/**` can only be established by running
//    `./packages/sdk/js/script/build.ts`, which REWRITES tracked files; that belongs in a CI step, not
//    in a unit lane, and wiring it is routed rather than done here (its package script is outside this
//    row's ownership area).
//  - The lane-bound assertion is F-251-4's acceptance test: the published contract must state the
//    bounds the shipped validator enforces, read off the same imported table, so the numbers keep one
//    home.
//
// Every zero here is paired with an arm that fires (rule E4): the control tests below feed the same
// comparators a deliberately desynced copy of the committed surface and require them to say so.
//
// Run targeted: cd packages/opencode && bun test test/server/httpapi-generated-surface.test.ts

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { LANE_CONTROLS } from "../../../setup/src/composefiles/lanes.ts"

const packageDir = fileURLToPath(new URL("../../", import.meta.url))
const committedSpec = fileURLToPath(new URL("../../../sdk/openapi.json", import.meta.url))
const sdkClient = fileURLToPath(new URL("../../../sdk/js/src/v2/gen/sdk.gen.ts", import.meta.url))

type JsonSchema = { readonly type?: string; readonly minimum?: number; readonly maximum?: number }
type Operation = Record<string, unknown>
type Document = {
  paths: Record<string, Record<string, Operation>>
  components?: { schemas?: Record<string, { properties?: Record<string, JsonSchema> }> }
}

const methods = ["get", "post", "put", "delete", "patch"] as const

function parse(text: string): Document {
  return JSON.parse(text) as Document
}

/** The sanctioned generation path: the real command, stdout only, nothing written to the tree. */
async function regenerateSpec(): Promise<string> {
  const proc = Bun.spawn([process.execPath, "run", "./src/index.ts", "generate"], {
    cwd: packageDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  expect(code, `generator exited ${code}: ${stderr.split("\n").slice(0, 5).join(" | ")}`).toBe(0)
  // Anti-vacuity: an empty or truncated stdout must never read as "no drift".
  expect(stdout.startsWith("{")).toBe(true)
  expect(stdout.length).toBeGreaterThan(100_000)
  return stdout
}

/** What differs between the committed document and what the handlers generate now, named for a reader. */
function surfaceDrift(committed: string, regenerated: string): string[] {
  if (committed === regenerated) return []
  const before = parse(committed)
  const after = parse(regenerated)
  const drift: string[] = []
  for (const path of Object.keys(after.paths))
    if (!before.paths[path]) drift.push(`route the handlers expose but the committed document lacks: ${path}`)
  for (const path of Object.keys(before.paths))
    if (!after.paths[path]) drift.push(`route the committed document still advertises: ${path}`)
  const schemasBefore = before.components?.schemas ?? {}
  const schemasAfter = after.components?.schemas ?? {}
  for (const name of Object.keys(schemasAfter))
    if (!schemasBefore[name]) drift.push(`schema the handlers expose but the committed document lacks: ${name}`)
  for (const name of Object.keys(schemasBefore))
    if (!schemasAfter[name]) drift.push(`schema the committed document still advertises: ${name}`)
  for (const name of Object.keys(schemasAfter))
    if (schemasBefore[name] && JSON.stringify(schemasBefore[name]) !== JSON.stringify(schemasAfter[name]))
      drift.push(`schema changed without regeneration: ${name}`)
  for (const path of Object.keys(after.paths))
    if (before.paths[path] && JSON.stringify(before.paths[path]) !== JSON.stringify(after.paths[path]))
      drift.push(`operation body changed without regeneration: ${path}`)
  // Identical names but different bytes — e.g. a description or a bound edited on one side only.
  if (drift.length === 0) drift.push("bytes differ with no path or schema named (formatting or an unnamed field)")
  return drift
}

/** Every `/global/` operation the document advertises must be callable in the committed client. */
function globalRoutesMissingFromSdk(document: Document, clientSource: string): string[] {
  const missing: string[] = []
  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith("/global/")) continue
    for (const method of methods) {
      if (!(method in item)) continue
      if (!clientSource.includes(`url: "${path}"`)) missing.push(`${method.toUpperCase()} ${path}`)
    }
  }
  return missing
}

/** The published PATCH bounds against the shipped table — one entry per disagreement. */
function laneBoundDrift(properties: Record<string, JsonSchema> | undefined): string[] {
  if (!properties) return ["GlobalLanesPatchInput declares no properties at all"]
  const drift: string[] = []
  for (const control of LANE_CONTROLS) {
    const field = properties[control.key]
    if (!field) {
      drift.push(`${control.key}: the published contract does not name the control the validator enforces`)
      continue
    }
    if (field.minimum !== control.min || field.maximum !== control.max)
      drift.push(
        `${control.key}: contract says [${String(field.minimum)},${String(field.maximum)}], the shipped validator enforces [${control.min},${control.max}]`,
      )
  }
  for (const name of Object.keys(properties))
    if (!LANE_CONTROLS.some((control) => control.key === name)) drift.push(`${name}: published but not a lane control`)
  return drift
}

describe("generated surface freshness (row 252 Q5)", () => {
  test("the committed OpenAPI document is byte-for-byte what the handlers generate", async () => {
    const fresh = await regenerateSpec()
    expect(surfaceDrift(readFileSync(committedSpec, "utf8"), fresh)).toEqual([])
  }, 120_000)

  test("every /global/ route in the committed document is reachable in the committed SDK client", () => {
    const document = parse(readFileSync(committedSpec, "utf8"))
    const advertised = Object.entries(document.paths).filter(([path]) => path.startsWith("/global/")).length
    // Anti-vacuity: the claim is about a non-empty set — /global/health, /setup, /lanes, /event,
    // /config, /dispose, /upgrade.
    expect(advertised).toBeGreaterThanOrEqual(7)
    expect(globalRoutesMissingFromSdk(document, readFileSync(sdkClient, "utf8"))).toEqual([])
  })

  test("the published lane bounds equal the shipped validator table (F-251-4)", () => {
    const document = parse(readFileSync(committedSpec, "utf8"))
    expect(laneBoundDrift(document.components?.schemas?.GlobalLanesPatchInput?.properties)).toEqual([])
  })

  // --- controls: each instrument above, aimed at a doctored copy of itself (rule E4) -------------

  test("control: the drift report fires when the committed copy lacks a route the handlers expose", () => {
    const committed = readFileSync(committedSpec, "utf8")
    const desynced = JSON.stringify(
      (() => {
        const document = parse(committed)
        const lanes = document.components?.schemas ?? {}
        delete document.paths["/global/lanes"]
        for (const name of Object.keys(lanes)) if (name.startsWith("GlobalLanes")) delete lanes[name]
        return document
      })(),
      null,
      2,
    )
    const drift = surfaceDrift(desynced, committed)
    expect(drift).toContain("route the handlers expose but the committed document lacks: /global/lanes")
    expect(drift.some((line) => line.startsWith("schema the handlers expose but the committed document lacks: GlobalLanes"))).toBe(
      true,
    )
  })

  test("control: the SDK consistency check fires on a route the committed client cannot call", () => {
    const document = parse(readFileSync(committedSpec, "utf8"))
    const withCanary: Document = {
      ...document,
      paths: { ...document.paths, "/global/r268-canary": { get: { operationId: "global.canary" } } },
    }
    expect(globalRoutesMissingFromSdk(withCanary, readFileSync(sdkClient, "utf8"))).toEqual([
      "GET /global/r268-canary",
    ])
  })

  test("control: the bounds check fires on the pre-fix contract that declared bare integers", () => {
    // Exactly the shape committed before row 268 (F-251-4): three integers, no bounds at all.
    const preFix = {
      NUQ_WORKER_COUNT: { type: "integer" },
      MAX_CONCURRENT_PAGES: { type: "integer" },
      GRANIAN_BLOCKING_THREADS: { type: "integer" },
    }
    const drift = laneBoundDrift(preFix)
    expect(drift.length).toBe(3)
    expect(drift[0]).toContain("NUQ_WORKER_COUNT")
    expect(drift[0]).toContain("[undefined,undefined]")
  })
})
