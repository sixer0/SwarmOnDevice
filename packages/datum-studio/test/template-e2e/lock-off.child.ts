// Row 69: the guard is the second line of defence (spec §5.3 G1, U.8 "Op 3, render half"). Run ONLY as
//   bun test --preload ./test/template-e2e/lock-off.preload.ts ./test/template-e2e/lock-off.child.ts
// (row69-template-e2e.test.ts spawns it). The preload serves form-lock.ts with P6 removed, so a Calibri body face
// passes the form lock and reaches the real row 67 guard, which the real host installed at start.
// Expected: the guard renders, Studio lint DATUM-05 fails on the candidate only, GUARD_REJECTED, nothing saved.
//
// Mutation switch (blueprint row 69 check; test-only, no product file changes):
//   ROW69_MUTATION=guard-noop  -> after the host starts, the installed guard is replaced by an always-pass stub
//                                 (configureTemplateGuard). The guard tests below must then FAIL.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { counts, latestNo, type Harness, type Rec, startHarness, versionRow } from "./harness.ts"

setDefaultTimeout(120_000)

const SLUG = "user-e2e-tanpa-kunci"
const evidence: Rec = {}
let h: Harness
let claude: Client
let swarm: Client

beforeAll(async () => {
  h = await startHarness("row69-lockoff")
  if (process.env.ROW69_MUTATION === "guard-noop") {
    h.services.service.configureTemplateGuard(async () => ({ verdict: "pass", report: { mutation: "guard-noop" }, skillSha: "0".repeat(64) }))
    evidence.mutation = "guard-noop"
  }
  claude = await h.clientOf("claude")
  swarm = await h.clientOf("swarm")
})

afterAll(async () => {
  await h?.close()
  console.log(`row69-lock-off evidence ${JSON.stringify(evidence)}`)
})

type Check = { id: string; outcome: string; reason?: string; reference: string; candidate: string; issues?: Array<{ detail: string }> }

describe("row 69 lock off: Calibri reaches the guard, which refuses it", () => {
  test("precondition: this process loaded the scratch form-lock.ts (P6 off); type.face.serif Calibri passes the lock", async () => {
    expect((globalThis as { __row69LockOff?: string }).__row69LockOff).toMatch(/services\/templates\/form-lock\.ts$/)
    const fl = await import("../../vendor/src/lib/studio/services/templates/form-lock")
    const issue = fl.paramLockIssue({ key: "type.face.serif", value: "Calibri", previous: "IBM Plex Serif", kind: "changed" } as never, { tier: "TERBIT", known: true } as never)
    expect(issue).toBeNull()
    const c = await h.call(swarm, "studio_template_create", { slug: SLUG, name: "Tanpa kunci", kind: "DOCUMENT", changeNote: "Salinan datum-gsp", from: { slug: "datum-gsp" } })
    expect(c).toMatchObject({ ok: true, versionNo: 1 })
  })

  test("studio_template_update Calibri -> GUARD_REJECTED with DATUM-05 REGRESSION (reference PASS, candidate FAIL); nothing saved", async () => {
    const n = counts(h)
    const r = await h.call(claude, "studio_template_update", { slug: SLUG, baseVersionNo: 1, changeNote: "Fon Calibri tanpa kunci", changes: { advanced: { "type.face.serif": "Calibri" } } })
    const details = ((r.error as Rec | undefined)?.details ?? {}) as Rec
    const checks = (((details.report as Rec | undefined)?.checks ?? []) as Check[])
    const d05 = checks.find((c) => c.id === "DATUM-05")
    evidence.update = { ok: r.ok, code: r.code ?? null, versionNo: r.versionNo ?? null, studioCode: details.studioCode ?? null, rejects: checks.filter((c) => c.outcome === "reject").map((c) => [c.id, c.reason, c.reference, c.candidate]), d05Issue: d05?.issues?.[0]?.detail ?? null }
    expect(r.ok).toBe(false)
    expect(r.code).toBe("GUARD_REJECTED")
    expect(d05).toMatchObject({ outcome: "reject", reason: "REGRESSION" })
    expect(d05!.issues!.some((i) => i.detail.includes("type.face.serif") && i.detail.includes("Calibri"))).toBe(true)
    expect(counts(h)).toEqual(n)
    expect(latestNo(h, SLUG)).toBe(1)
  })

  test("U.1a (spec :452 'Row 69 mutates P6 off and shows this rule still rejects'): lint-parameter keys stay refused with P6 off", async () => {
    // Keys from the U.1a set (spec :447-448), one per category the hypothesis names; row 66 locks all 36 by P2/P3/P5.
    const keys: Array<[string, unknown]> = [
      ["naming.underscore.allowed", true],
      ["type.body.measureChars", 120],
      ["color.maxValuesPerPage", 12],
      ["chart.minFontPt", 4],
      ["prose.emDash", true],
    ]
    const n = counts(h)
    const out: Array<[string, string | undefined]> = []
    for (const [key, value] of keys) {
      const r = await h.call(claude, "studio_template_update", { slug: SLUG, baseVersionNo: 1, changeNote: `Ubah ${key}`, changes: { advanced: { [key]: value } } })
      out.push([key, r.code])
      expect({ key, ok: r.ok }).toEqual({ key, ok: false })
      expect(["PARAM_CLASS_T_READONLY", "PARAM_SURFACE_FORBIDDEN", "TEMPLATE_FORM_LOCKED", "SCHEMA_INVALID", "GUARD_REJECTED"]).toContain(r.code as string)
    }
    evidence.lintParams = out
    expect(counts(h)).toEqual(n)
    expect(latestNo(h, SLUG)).toBe(1)
  })

  test("studio_template_check of the same definition (saves nothing) -> verdict reject naming DATUM-05", async () => {
    const def = (await h.services.templates.getTemplateV2(SLUG, 1, { includeAdvanced: true })).definition as unknown as Rec & { advanced?: Rec }
    const r = await h.call(swarm, "studio_template_check", { template: { ...def, advanced: { ...(def.advanced ?? {}), "type.face.serif": "Calibri" } }, baseSlug: SLUG, baseVersion: 1 })
    const ids = ((r.checks ?? []) as Check[]).filter((c) => c.outcome === "reject").map((c) => c.id)
    evidence.check = { ok: r.ok, verdict: r.verdict ?? null, code: r.code ?? null, rejects: ids }
    expect(r.ok).toBe(true)
    expect(r.verdict).toBe("reject")
    expect(ids).toContain("DATUM-05")
    expect(r.saved).toBe(false)
    expect(latestNo(h, SLUG)).toBe(1)
    expect(versionRow(h, SLUG, 2)).toBeUndefined()
  })
})
