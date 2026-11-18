// Swarm 1.3.3 row 61 (ST-9 item 2, U20): the rule and the two doors, without a host (no port).
// - rule: `labels_verified: true` in the snapshot to store must already be in the parent revision, unchanged;
// - choke point: insertRevision (store-bridge/documents.ts) calls the guard; it is active in an agent write scope only;
// - router: every handler runs in that scope; a refusal recorded there becomes 422 LABELS_VERIFIED_PERSON_ONLY with the hint;
// - seam of row 62: raiseLabelsVerified refuses inside an agent write scope and is named by no tool surface.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { StoreError } from "../../src/store/index.ts"
import { insertRevision, type RevisionCreate } from "../../src/store-bridge/documents.ts"
import type { StudioTx } from "../../src/store-bridge/db.ts"
import { agentWriteScope, assertNotAgentWrite, checkedSpecsOf, raisedLabelsVerified, refuseAgentRaisedLabelsVerified, runAsAgentWrite } from "../../src/store-bridge/labels-verified.ts"
import { createLocalStudioApi } from "../../src/mcp-host/local-api/router.ts"
import { raiseLabelsVerified } from "../../src/mcp-host/local-api/labels-verified-raise.ts"
import { nextCall } from "../../src/mcp-host/mission/next-call.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
type S = Record<string, any>
const spec = (flag: boolean | undefined, more: S = {}): S => ({ family: "flow", ...(flag === undefined ? {} : { labels_verified: flag }), nodes: [{ id: "a", label: "Mulai" }, { id: "b", label: "Selesai" }], edges: [{ from: "a", to: "b" }], ...more })
const diagram = (id: string, s: S, more: S = {}): S => ({ type: "diagram", id, spec: s, caption: { text: "Alur uji." }, source: { text: "Sumber sintetis." }, ...more })
/** studio.norm/v2 shape: authored tree in `source`; `doc` and `blocks` are composed copies (figure numbers inside). */
const v2 = (blocks: S[]): S => ({
  schema: "studio.norm/v2",
  source: { $schema: "studio.doc/v2", sections: { body: { chapters: [{ key: "1", sections: [{ blocks }] }] } } },
  doc: { chapters: [{ blocks: blocks.map((b, i) => ({ type: "diagram", spec: { ...b.spec, $schema: "studio.diagram/v1", id: `1.${i + 1}` } })) }] },
  blocks: blocks.map((b) => ({ pid: b.id, content: b })),
})
const v1 = (specs: S[]): S => ({ schema: "studio.norm/v1", doc: { chapters: [{ blocks: specs.map((s) => ({ type: "diagram", spec: s })) }] }, blocks: specs.map((s, i) => ({ blockId: `b${i}`, content: { type: "diagram", spec: s } })) })

describe("row 61 rule: raisedLabelsVerified(next, parent)", () => {
  test("true on a first revision is raised; false and absent are not", () => {
    expect(raisedLabelsVerified(v2([diagram("p1", spec(true))]), null).map((r) => [r.pointer, r.cause, r.blockId])).toEqual([["/source/sections/body/chapters/0/sections/0/blocks/0/spec/labels_verified", "set-by-agent", "p1"]])
    expect(raisedLabelsVerified(v2([diagram("p1", spec(false))]), null)).toEqual([])
    expect(raisedLabelsVerified(v2([diagram("p1", spec(undefined))]), null)).toEqual([])
  })

  test("false -> true on an existing figure is raised", () => {
    expect(raisedLabelsVerified(v2([diagram("p1", spec(true))]), v2([diagram("p1", spec(false))])).map((r) => r.cause)).toEqual(["set-by-agent"])
  })

  test("a stored true is kept when other fields change: caption, width, another block, a figure inserted before", () => {
    const parent = v2([diagram("p1", spec(true))])
    expect(raisedLabelsVerified(v2([diagram("p1", spec(true), { caption: { text: "Judul lain." }, width: "full" })]), parent)).toEqual([])
    expect(raisedLabelsVerified(v2([diagram("p0", spec(false, { direction: "LR" })), diagram("p1", spec(true))]), parent)).toEqual([])
    // only `source` is read on v2: the composed `doc` copy renumbers 1.1 -> 1.2 here and must not count as a change
    expect(checkedSpecsOf(v2([diagram("p0", spec(false)), diagram("p1", spec(true))])).map((s) => s.blockId)).toEqual(["p1"])
  })

  test("a stored true whose spec changed is raised with cause figure-changed-after-check; false with the change passes", () => {
    const parent = v2([diagram("p1", spec(true))])
    const moved = raisedLabelsVerified(v2([diagram("p1", spec(true, { direction: "LR" }))]), parent)
    expect(moved.map((r) => [r.cause, r.blockId])).toEqual([["figure-changed-after-check", "p1"]])
    expect(raisedLabelsVerified(v2([diagram("p1", spec(false, { direction: "LR" }))]), parent)).toEqual([])
  })

  test("a checked spec copied to another document (no such spec in its parent) is raised", () => {
    expect(raisedLabelsVerified(v2([diagram("q9", spec(true))]), v2([diagram("q1", spec(false))]))).toHaveLength(1)
  })

  test("v1 snapshots are read whole; an unchanged v1 true passes, a new one is raised", () => {
    const s = spec(true, { $schema: "studio.diagram/v1", id: "9.1", title: "Uji." })
    expect(raisedLabelsVerified(v1([s]), v1([s]))).toEqual([])
    expect(raisedLabelsVerified(v1([s]), v1([{ ...s, labels_verified: false }])).length).toBeGreaterThan(0)
  })

  test("v1 -> v2 migration edit: presentation keys may go, label keys may not, values may not change", () => {
    const old = spec(true, { $schema: "studio.diagram/v1", id: "9.1", title: "Uji.", width_mm: 166, apparatus: "page", zones: [{ id: "z", label: "Zona" }] })
    const { $schema: _a, id: _b, title: _c, width_mm: _d, apparatus: _e, ...carried } = old
    expect(raisedLabelsVerified(v2([diagram("p1", carried)]), v1([old]))).toEqual([])
    const { zones: _z, ...noZones } = carried
    expect(raisedLabelsVerified(v2([diagram("p1", noZones)]), v1([old]))).toHaveLength(1)
    expect(raisedLabelsVerified(v2([diagram("p1", { ...carried, nodes: [{ id: "a", label: "Lain" }] })]), v1([old]))).toHaveLength(1)
    // the relaxed comparison is for a v1 parent only
    expect(raisedLabelsVerified(v2([diagram("p1", carried)]), v2([diagram("p1", old)]))).toHaveLength(1)
  })
})

/** A tx that answers the parent snapshot read and records the INSERT. */
function fakeTx(parent: unknown | null): { tx: StudioTx; inserts: number } {
  const state = { inserts: 0 }
  const tx = {
    now: 1,
    alive: true,
    run: (sql: string) => {
      if (/^\s*INSERT INTO revision/.test(sql)) state.inserts++
      return { changes: 1 }
    },
    get: (sql: string) => (/SELECT snapshot FROM revision/.test(sql) ? (parent === null ? undefined : { snapshot: JSON.stringify(parent) }) : undefined),
    all: () => [],
  } as unknown as StudioTx
  return {
    tx,
    get inserts() {
      return state.inserts
    },
  }
}
const rev = (snapshot: unknown, parentRevisionNo: number | null): RevisionCreate => ({ documentId: "d1", revisionNo: (parentRevisionNo ?? 0) + 1, parentRevisionNo, templateVersionId: "t", snapshot, snapshotSha256: "s", inputSha256: "i", docRev: "A", changeWhat: "w", changeWhy: "y", changeImpact: "i", createdBy: "agent:swarm" })
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof StoreError ? e.code : `other:${String(e)}`
  }
  return undefined
}

describe("row 61 choke point: insertRevision", () => {
  test("in an agent write scope a raised flag is refused before the INSERT and recorded on the scope", async () => {
    const f = fakeTx(null)
    await runAsAgentWrite("swarm", async (scope) => {
      expect(codeOf(() => insertRevision(f.tx, rev(v2([diagram("p1", spec(true))]), null)))).toBe("LABELS_VERIFIED_PERSON_ONLY")
      expect(scope.refusal).toEqual({ field: "labels_verified", pointer: "/source/sections/body/chapters/0/sections/0/blocks/0/spec/labels_verified", cause: "set-by-agent", blockId: "p1", documentId: "d1" })
    })
    expect(f.inserts).toBe(0)
  })

  test("in an agent write scope false, absent and an unchanged stored true reach the INSERT", async () => {
    for (const [snap, parent] of [
      [v2([diagram("p1", spec(false))]), null],
      [v2([diagram("p1", spec(undefined))]), null],
      [v2([diagram("p1", spec(true), { caption: { text: "Baru." } })]), v2([diagram("p1", spec(true))])],
    ] as const) {
      const f = fakeTx(parent)
      await runAsAgentWrite("swarm", async (scope) => {
        // the fake tx has no row to read back: the INSERT ran when the guard let it through
        codeOf(() => insertRevision(f.tx, rev(snap, parent === null ? null : 1)))
        expect(scope.refusal).toBeUndefined()
      })
      expect(f.inserts).toBe(1)
    }
  })

  test("a parent that cannot be read counts as no parent: refused", async () => {
    const f = fakeTx(null)
    await runAsAgentWrite("swarm", async () => {
      expect(codeOf(() => refuseAgentRaisedLabelsVerified(f.tx, { documentId: "d1", parentRevisionNo: 3, snapshot: v2([diagram("p1", spec(true))]) }))).toBe("LABELS_VERIFIED_PERSON_ONLY")
    })
  })

  test("outside an agent write scope the guard is silent (person path, store tooling)", () => {
    const f = fakeTx(null)
    expect(agentWriteScope()).toBeUndefined()
    codeOf(() => insertRevision(f.tx, rev(v2([diagram("p1", spec(true))]), null)))
    expect(f.inserts).toBe(1)
  })
})

describe("row 61 router: the agent door", () => {
  const BASE = "http://127.0.0.1:47061"
  const SECRET = "s".repeat(40)
  const api = (handler: (req: Request) => Promise<Response>) =>
    createLocalStudioApi({ baseUrl: BASE, secret: SECRET, agentId: "swarm", routes: [{ id: "T", pattern: "/t", methods: { POST: (req) => handler(req), GET: (req) => handler(req) } }] })
  const post = async (a: ReturnType<typeof api>) => {
    const r = await a.fetch(`${BASE}/t`, { method: "POST", headers: { "x-internal-secret": SECRET, "content-type": "application/json" }, body: "{}", redirect: "manual" })
    return { status: r.status, body: JSON.parse(await r.text()) as S }
  }

  test("every handler runs inside the agent write scope of the session agent", async () => {
    let seen: string | undefined
    const r = await post(api(async () => ((seen = agentWriteScope()?.agentId), Response.json({ ok: true }))))
    expect(r.status).toBe(200)
    expect(seen).toBe("swarm")
  })

  test("a refusal becomes 422 LABELS_VERIFIED_PERSON_ONLY with the register details and the hint, whatever the handler answered", async () => {
    const guard = () => refuseAgentRaisedLabelsVerified(fakeTx(null).tx, { documentId: "d1", parentRevisionNo: null, snapshot: v2([diagram("p1", spec(true))]) })
    const answers: Array<() => Promise<Response>> = [
      // a route body that maps the unknown StoreError to a generic 500
      async () => {
        try {
          guard()
        } catch {
          return Response.json({ error: "Internal error" }, { status: 500 })
        }
        return Response.json({ ok: true })
      },
      // a route body that lets it escape
      async () => {
        guard()
        return Response.json({ ok: true })
      },
    ]
    for (const h of answers) {
      const r = await post(api(h))
      expect(r.status).toBe(422)
      expect(r.body.code).toBe("LABELS_VERIFIED_PERSON_ONLY")
      expect(r.body.details).toMatchObject({ field: "labels_verified", pointer: "/source/sections/body/chapters/0/sections/0/blocks/0/spec/labels_verified", cause: "set-by-agent" })
      expect(r.body.error).toContain(nextCall("LABELS_VERIFIED_PERSON_ONLY"))
      expect(r.body.error).not.toMatch(/by: ?user|as the person/i)
    }
  })

  test("a request without a refusal is answered unchanged", async () => {
    const r = await post(api(async () => Response.json({ ok: true, n: 1 }, { status: 201 })))
    expect(r).toEqual({ status: 201, body: { ok: true, n: 1 } })
  })
})

describe("row 61 seam for row 62: raiseLabelsVerified", () => {
  test("inside an agent write scope it refuses before reading anything", async () => {
    await runAsAgentWrite("swarm", async () => {
      expect(codeOf(() => assertNotAgentWrite("raiseLabelsVerified"))).toBe("LABELS_VERIFIED_PERSON_ONLY")
      const e = await raiseLabelsVerified({ documentId: "d1", decisionId: "U1" }).then(
        () => null,
        (x: unknown) => x,
      )
      expect(e instanceof StoreError && e.code).toBe("LABELS_VERIFIED_PERSON_ONLY")
    })
  })

  test("a decision id that is not U<n> is refused (register: clearedBy ^U[1-9][0-9]{0,3}$)", async () => {
    for (const id of ["C1", "U0", "u1", "U12345", ""]) {
      const e = await raiseLabelsVerified({ documentId: "d1", decisionId: id }).then(
        () => null,
        (x: unknown) => x,
      )
      expect(e instanceof StoreError && e.code, id).toBe("LABELS_VERIFIED_PERSON_ONLY")
    }
  })

  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : n.endsWith(".ts") ? [path.join(dir, n)] : []))
  const srcFiles = [...files(path.join(PKG, "src")), ...files(path.join(PKG, "vendor", "scripts", "studio"))].filter((f) => !f.endsWith(".test.ts"))
  const users = (name: string) => srcFiles.filter((f) => new RegExp(`\\b${name}\\b`).test(readFileSync(f, "utf8"))).map((f) => path.relative(PKG, f)).sort()

  test("no tool surface names the raise function or the scope opener", () => {
    // tool surfaces: the vendored MCP tools and CLIs, the host tool table, the mission tools and their input schemas
    const surfaces = srcFiles.filter((f) => /vendor\/scripts\/studio\/|src\/mcp-host\/(tool-table|mcp-server|asset-tool)\.ts$|src\/mcp-host\/mission\/(mission-tools|report-tools|schemas|guard-writes)\.ts$/.test(f))
    expect(surfaces.length).toBeGreaterThan(20)
    for (const f of surfaces) expect(readFileSync(f, "utf8"), path.relative(PKG, f)).not.toMatch(/raiseLabelsVerified|runAsAgentWrite|labels-verified/)
    // neither barrel re-exports it: row 62 imports the module by path
    for (const barrel of ["src/store-bridge/index.ts", "src/mcp-host/index.ts"]) expect(readFileSync(path.join(PKG, barrel), "utf8")).not.toMatch(/labels-verified|raiseLabelsVerified/)
  })

  test("the scope has one opener (the router) and the guard one caller (insertRevision)", () => {
    expect(users("runAsAgentWrite")).toEqual(["src/mcp-host/local-api/router.ts", "src/store-bridge/labels-verified.ts"])
    expect(users("refuseAgentRaisedLabelsVerified")).toEqual(["src/store-bridge/documents.ts", "src/store-bridge/labels-verified.ts"])
  })

  test("every revision INSERT of the package goes through insertRevision", () => {
    const all = [...files(path.join(PKG, "src")), ...files(path.join(PKG, "vendor", "src")), ...files(path.join(PKG, "vendor", "scripts"))].filter((f) => !f.endsWith(".test.ts"))
    const inserters = all.filter((f) => /INSERT\s+(OR\s+\w+\s+)?INTO\s+revision\b/i.test(readFileSync(f, "utf8"))).map((f) => path.relative(PKG, f)).sort()
    console.log(`[row61-unit] files with a revision INSERT: ${JSON.stringify(inserters)}`)
    expect(inserters).toEqual(["src/store-bridge/documents.ts"])
    // The store's own typed writers (createDocument / appendRevision -> insertRow "revision") have no caller outside src/store.
    const typed = all.filter((f) => /insertRow\(tx, "revision"/.test(readFileSync(f, "utf8"))).map((f) => path.relative(PKG, f))
    expect(typed).toEqual(["src/store/studio-store.ts"])
    const callers = all.filter((f) => !/src\/store\//.test(f) && /\.(appendRevision|createDocument)\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(PKG, f))
    expect(callers).toEqual([])
  })
})
