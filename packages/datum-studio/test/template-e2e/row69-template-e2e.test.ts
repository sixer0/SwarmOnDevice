// Row 69 (test-expert, independent of rows 66-68): the template feature end to end through the real host server.
//
// Spec: masterplan/01_specs_studio_templates.md §2-§6, §9 row 69, U.8, U.9 (decisions C54, C58, C72, C76).
// Path under test: MCP streamable-HTTP session per agent -> startStudioHostServer (row 31) with
// templateHostExtension() (row 68) in `extensions` -> row 66 service -> row 67 guard (installed by the host) -> store.
// Harness and the one stand-in (render-bridge transport): ./harness.ts. The lock-off guard scenario runs in a child
// process (./lock-off.child.ts with ./lock-off.preload.ts) because it needs a scratch copy of form-lock.ts with P6 off.
//
// Deliberately NOT asserted (rows 110e and 119b run in parallel in this package): template file sha256 values, the
// total tool count. Builtin values are read at run time from the store.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { strFromU8, unzipSync } from "fflate"
import { counts, latestNo, PKG, type Harness, type Rec, type Reply, startHarness, versionRow } from "./harness.ts"

setDefaultTimeout(120_000)

const SLUG = "user-e2e-laporan"
const DOC_LABEL = "LAPORAN UJI E2E"
const MISSION = "2026-11-07_row69"
const evidence: Rec = {}

let h: Harness
let claude: Client
let swarm: Client
let claude2: Client
let v1Snapshot = ""
let documentId = ""
let revOnV1 = 0

const call = (c: Client, name: string, args: Rec) => h.call(c, name, args)
const issuesText = (r: Reply) => JSON.stringify((r.error as Rec | undefined)?.details ?? {})
const pinnedOf = (jobId: string): Rec | undefined => {
  const row = h.q<{ engine: string }>("SELECT engine FROM render_job WHERE id = ?", [jobId])[0]
  const eng = JSON.parse(row.engine) as { log?: Array<{ code?: string; context?: Rec }> }
  return (eng.log ?? []).find((e) => e.code === "TEMPLATE_PINNED")?.context
}
const revisionPins = () => h.q<{ revision_no: number; template_version_id: string }>("SELECT revision_no, template_version_id FROM revision WHERE document_id = ? ORDER BY revision_no", [documentId])
const builtinLatest = (slug: string) =>
  h.q<{ id: string; definition: string; definition_sha256: string }>("SELECT v.id, v.definition, v.definition_sha256 FROM template_version v JOIN template t ON t.id = v.template_id WHERE t.slug = ? ORDER BY v.version_no DESC LIMIT 1", [slug])[0]

beforeAll(async () => {
  h = await startHarness("row69-e2e")
  claude = await h.clientOf("claude")
  swarm = await h.clientOf("swarm")
  claude2 = await h.clientOf("claude")
})

afterAll(async () => {
  await h?.close()
  console.log(`row69 evidence ${JSON.stringify(evidence)}`)
})

describe("row 69: versions are kept (copy -> update twice -> 3 versions, v1 byte-equal)", () => {
  test("swarm copies datum-gsp: v1 = the source definition byte for byte, created_by agent:swarm", async () => {
    const r = await call(swarm, "studio_template_create", { slug: SLUG, name: "Laporan uji e2e", kind: "DOCUMENT", changeNote: "Salinan datum-gsp (row 69)", from: { slug: "datum-gsp" } })
    expect(r).toMatchObject({ ok: true, versionNo: 1 })
    const v1 = versionRow(h, SLUG, 1)
    const src = builtinLatest("datum-gsp")
    expect(v1.created_by).toBe("agent:swarm")
    expect(v1.base_version_id).toBe(src.id)
    expect(v1.definition_sha256).toBe(src.definition_sha256)
    expect(v1.definition).toBe(src.definition)
    expect(v1.guard_verdict).toBe("pass")
    v1Snapshot = JSON.stringify(v1)
    evidence.copy = { versionId: v1.id, sourcePin: src.id, definitionSha256: v1.definition_sha256, guard: v1.guard_verdict }
  })

  test("swarm writes a document on v1 (studio_write); its revision is pinned to v1", async () => {
    const r = await call(swarm, "studio_write", {
      mission: MISSION,
      docKey: "nota-e2e",
      template: SLUG,
      meta: { title: "Nota uji templat e2e", author: "Agen Uji", number: "UJI-69/2026" },
      sections: [
        { heading: "Latar belakang", blocks: ["Dokumen ini menguji versi templat dari ujung ke ujung."] },
        { heading: "Temuan", blocks: ["Revisi lama tetap pada versi templatnya."] },
      ],
    })
    expect(r.ok).toBe(true)
    documentId = String(r.documentId)
    revOnV1 = Number(h.q<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [documentId])[0].n)
    expect(revisionPins().find((p) => p.revision_no === revOnV1)?.template_version_id).toBe(String(versionRow(h, SLUG, 1).id))
  })

  test("claude saves v2 on swarm's template (changes.advanced runningHead.docLabel): allowed, created_by agent:claude", async () => {
    // Caller identity: spec §0 "Who" names Swarm's agent and Claude as the callers of one host, and C58 lets the
    // non-admin INTERNAL_AGENT create/update/archive user- templates within the lock. Neither states a per-agent
    // owner for templates (the owner rule `adoptExisting` of studio spec §449 is for documents). So a cross-agent
    // update is expected to succeed, and the version row records who made it.
    const r = await call(claude, "studio_template_update", { slug: SLUG, baseVersionNo: 1, changeNote: "Label dokumen kepala halaman", changes: { advanced: { "runningHead.docLabel": DOC_LABEL } } })
    expect(r).toMatchObject({ ok: true, versionNo: 2 })
    const v2 = versionRow(h, SLUG, 2)
    expect(v2.created_by).toBe("agent:claude")
    expect(v2.base_version_id).toBe(versionRow(h, SLUG, 1).id)
    expect((JSON.parse(String(v2.resolved_params)) as Rec)["runningHead.docLabel"]).toBe(DOC_LABEL)
  })

  test("swarm saves v3 (changes.advanced table.header.verticalAlign top)", async () => {
    const r = await call(swarm, "studio_template_update", { slug: SLUG, baseVersionNo: 2, changeNote: "Kepala tabel rata atas", changes: { advanced: { "table.header.verticalAlign": "top" } } })
    expect(r).toMatchObject({ ok: true, versionNo: 3 })
    expect(versionRow(h, SLUG, 3).created_by).toBe("agent:swarm")
    expect(versionRow(h, SLUG, 3).base_version_id).toBe(versionRow(h, SLUG, 2).id)
  })

  test("the version list has exactly 3 versions with their agents; v1 row is byte-equal to its snapshot", async () => {
    const r = await call(claude, "studio_template_check", { slug: SLUG, guard: false })
    expect(r.ok).toBe(true)
    const vs = r.versions as Array<{ versionNo: number; versionId: string; createdBy: string; guardVerdict: string; documentCount: number }>
    expect(vs.map((v) => [v.versionNo, v.createdBy])).toEqual([
      [1, "agent:swarm"],
      [2, "agent:claude"],
      [3, "agent:swarm"],
    ])
    expect(vs.map((v) => v.versionId)).toEqual([1, 2, 3].map((n) => String(versionRow(h, SLUG, n).id)))
    expect(vs.every((v) => v.guardVerdict === "pass" || v.guardVerdict === "warn")).toBe(true)
    expect(vs[0].documentCount).toBe(1)
    expect(JSON.stringify(versionRow(h, SLUG, 1))).toBe(v1Snapshot)
    expect(new Set(vs.map((v) => v.versionId)).size).toBe(3)
    // The store refuses an in-place edit of a stored version (immutable rows, store §3.3).
    const st = (await import("../../src/store-bridge/index.ts")).getStudioStore() as unknown as { transaction<T>(fn: (tx: { run(s: string, p: unknown[]): unknown }) => Promise<T>): Promise<T> }
    const edit = await st.transaction(async (tx) => tx.run("UPDATE template_version SET change_note = 'x' WHERE id = ?", [versionRow(h, SLUG, 1).id])).then(
      () => "updated",
      (e: { code?: string }) => e.code ?? "error",
    )
    expect(edit).toBe("TEMPLATE_VERSION_IMMUTABLE")
    expect(JSON.stringify(versionRow(h, SLUG, 1))).toBe(v1Snapshot)
    evidence.versions = { list: vs.map((v) => [v.versionNo, v.createdBy, v.guardVerdict, v.documentCount]), inPlaceEdit: edit }
  })
})

describe("row 69: a document keeps its template version; re-render on a newer version is explicit", () => {
  test("v2 and v3 did not move the document: its only revision is still on v1", () => {
    expect(revisionPins().map((p) => p.template_version_id)).toEqual(revisionPins().map(() => String(versionRow(h, SLUG, 1).id)))
  })

  test("move to v2 (not latest v3): new revision on v2; old revision still renders on v1, new one on v2", async () => {
    const v1 = String(versionRow(h, SLUG, 1).id)
    const v2 = String(versionRow(h, SLUG, 2).id)
    const st = await call(swarm, "studio_document_structure", { documentId, op: "templateVersion", baseRevisionNo: revOnV1, versionNo: 2, change: { what: "Templat ke versi 2", why: "uji row 69", impact: "revisi baru" } })
    expect(st.ok).toBe(true)
    const pins = revisionPins()
    const newRev = Math.max(...pins.map((p) => p.revision_no))
    expect(newRev).toBe(revOnV1 + 1)
    expect(pins.find((p) => p.revision_no === revOnV1)?.template_version_id).toBe(v1)
    expect(pins.find((p) => p.revision_no === newRev)?.template_version_id).toBe(v2)

    const old = await call(swarm, "studio_render", { documentId, formats: ["docx", "html"], revisionNo: revOnV1 })
    const cur = await call(swarm, "studio_render", { documentId, formats: ["docx", "html"] })
    expect(old.ok).toBe(true)
    expect(cur.ok).toBe(true)
    const oj = old.job as { id: string; status: string }
    const cj = cur.job as { id: string; status: string }
    expect([oj.status, cj.status]).toEqual(["SUCCEEDED", "SUCCEEDED"])
    expect(pinnedOf(oj.id)).toMatchObject({ versionNo: 1, versionId: v1, resolvedVersionId: v1 })
    expect(pinnedOf(cj.id)).toMatchObject({ versionNo: 2, versionId: v2, resolvedVersionId: v2 })
    const htmlOf = (jobId: string) => {
      const f = h.q<{ rel_path: string }>("SELECT rel_path FROM output_file WHERE render_job_id = ? AND format = 'HTML' AND role = 'PRIMARY'", [jobId])[0]
      return readFileSync(path.join(h.store, f.rel_path), "utf8")
    }
    // v2's only change is the running-head label. It reaches the DOCX headers of the v2 render and never the v1 one.
    const headerHits = (jobId: string) => {
      const f = h.q<{ rel_path: string }>("SELECT rel_path FROM output_file WHERE render_job_id = ? AND format = 'DOCX' AND role = 'PRIMARY'", [jobId])[0]
      const parts = unzipSync(new Uint8Array(readFileSync(path.join(h.store, f.rel_path))))
      return Object.entries(parts)
        .filter(([n]) => /^word\/(header|footer)\d*\.xml$/.test(n))
        .filter(([, b]) => strFromU8(b).includes(DOC_LABEL))
        .map(([n]) => n)
        .sort()
    }
    const oldHeaders = headerHits(oj.id)
    const curHeaders = headerHits(cj.id)
    expect(oldHeaders).toEqual([])
    expect(curHeaders.length).toBeGreaterThan(0)
    expect(htmlOf(oj.id).includes(DOC_LABEL)).toBe(false)
    evidence.rerender = { oldRevision: revOnV1, newRevision: newRev, oldPinned: pinnedOf(oj.id), newPinned: pinnedOf(cj.id), docLabelInDocxParts: { v1: oldHeaders, v2: curHeaders }, newHtmlHasDocLabel: htmlOf(cj.id).includes(DOC_LABEL) }
  })

  test("a version that does not exist is refused and adds no revision", async () => {
    const before = revisionPins().length
    const cur = Math.max(...revisionPins().map((p) => p.revision_no))
    const r = await call(swarm, "studio_document_structure", { documentId, op: "templateVersion", baseRevisionNo: cur, versionNo: 99, change: { what: "x", why: "x", impact: "x" } })
    expect(r.ok).toBe(false)
    expect(revisionPins().length).toBe(before)
    evidence.missingVersion = { code: r.code ?? null }
  })
})

describe("row 69: the form lock refuses a Rev A break before the guard runs", () => {
  test("Calibri via changes, via a full template, and as a role-format face: TEMPLATE_FORM_LOCKED, guard never called, nothing saved", async () => {
    const real = h.services.service.installedTemplateGuard()!
    let guardCalls = 0
    h.services.service.configureTemplateGuard(async (i) => {
      guardCalls++
      return real(i)
    })
    try {
      const n = counts(h)
      const viaChanges = await call(claude, "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "Fon Calibri", changes: { advanced: { "type.face.serif": "Calibri" } } })
      const full = (await h.services.templates.getTemplateV2(SLUG, 3, { includeAdvanced: true })).definition as unknown as Rec & { advanced?: Rec }
      const viaTemplate = await call(swarm, "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "Fon Calibri", template: { ...full, advanced: { ...(full.advanced ?? {}), "type.face.serif": "Calibri" } } })
      const viaRole = await call(claude, "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "Fon Calibri", changes: { roleFormats: { "body.paragraph": { run: { face: "Calibri" } } } } })
      for (const r of [viaChanges, viaTemplate, viaRole]) {
        expect(r.ok).toBe(false)
        expect(r.code).toBe("TEMPLATE_FORM_LOCKED")
        expect(r.isError).toBeUndefined()
      }
      const reason = (r: Reply) => ((r.error as Rec).details as Rec).reason
      expect(reason(viaChanges)).toBe("category:tipografi")
      expect(reason(viaTemplate)).toBe("category:tipografi")
      expect(guardCalls).toBe(0)
      expect(counts(h)).toEqual(n)
      expect(latestNo(h, SLUG)).toBe(3)
      evidence.formLock = { viaChanges: reason(viaChanges), viaTemplate: reason(viaTemplate), viaRole: [viaRole.code, reason(viaRole)], guardCalls }
    } finally {
      h.services.service.configureTemplateGuard(real)
    }
  })

  test("guard at guard level with the form lock off (child process, scratch form-lock.ts with P6 removed): GUARD_REJECTED on DATUM-05", () => {
    const child = path.join(import.meta.dir, "lock-off.child.ts")
    const preload = path.join(import.meta.dir, "lock-off.preload.ts")
    const r = spawnSync(process.execPath, ["test", "--preload", preload, child], { cwd: PKG, env: { ...process.env }, encoding: "utf8", timeout: 110_000 })
    const out = `${r.stdout}\n${r.stderr}`
    const line = out.split("\n").find((l) => l.startsWith("row69-lock-off evidence "))
    evidence.lockOff = { exit: r.status, evidence: line ? JSON.parse(line.slice("row69-lock-off evidence ".length)) : null, tail: r.status === 0 ? undefined : out.split("\n").slice(-40).join("\n") }
    if (r.status !== 0) console.log(out)
    expect(r.status).toBe(0)
    expect(out).toContain(" 0 fail")
  })
})

describe("row 69: malformed input is refused with the stated code, nothing saved, never isError", () => {
  const big = (n: number) => "a".repeat(n)
  type Case = [label: string, tool: string, args: Rec, code: string, contains?: string]
  const cases = (): Case[] => [
    // wrong types
    ["baseVersionNo as string", "studio_template_update", { slug: SLUG, baseVersionNo: "3", changeNote: "x", changes: { advanced: { "chart.sortOrder": "natural" } } }, "SCHEMA_INVALID"],
    ["archived as string", "studio_template_archive", { slug: SLUG, archived: "yes" }, "SCHEMA_INVALID"],
    ["from as string", "studio_template_create", { slug: "user-e2e-salah", name: "x", kind: "DOCUMENT", changeNote: "x", from: "datum-gsp" }, "SCHEMA_INVALID"],
    ["template as string", "studio_template_check", { template: "studio.template/v2" }, "SCHEMA_INVALID"],
    ["changes as array", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: [] }, "SCHEMA_INVALID"],
    ["formats as string", "studio_template_preview", { slug: SLUG, formats: "pdf" }, "SCHEMA_INVALID"],
    ["kind CHART", "studio_template_create", { slug: "user-e2e-salah", name: "x", kind: "CHART", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID"],
    ["empty changes", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: {} }, "SCHEMA_INVALID"],
    ["changeNote empty", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "", changes: { advanced: { "chart.sortOrder": "natural" } } }, "SCHEMA_INVALID"],
    // unknown keys (no caller identity or path is accepted from the arguments)
    ["agentId field", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", agentId: "swarm", changes: { advanced: { "chart.sortOrder": "natural" } } }, "SCHEMA_INVALID", "unknown field agentId"],
    ["createdBy field", "studio_template_create", { slug: "user-e2e-salah", name: "x", kind: "DOCUMENT", changeNote: "x", createdBy: "agent:swarm", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID", "unknown field createdBy"],
    ["path in from", "studio_template_create", { slug: "user-e2e-salah", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp", path: "../../../etc/passwd" } }, "SCHEMA_INVALID", "unknown field path"],
    ["file at top level", "studio_template_preview", { slug: SLUG, file: "/etc/passwd" }, "SCHEMA_INVALID", "unknown field file"],
    ["unknown changes key", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: { assets: { logo: "/tmp/x.png" } } }, "SCHEMA_INVALID"],
    ["unknown param key", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: { advanced: { "no.such.key": 1 } } }, "PARAM_UNKNOWN_KEY"],
    // missing slug / oneOf
    ["update without slug", "studio_template_update", { baseVersionNo: 3, changeNote: "x", changes: { advanced: { "chart.sortOrder": "natural" } } }, "SCHEMA_INVALID"],
    ["create without slug", "studio_template_create", { name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID"],
    ["check with neither", "studio_template_check", {}, "SCHEMA_INVALID"],
    ["update with two bodies", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: { advanced: { "chart.sortOrder": "natural" } }, skeleton: { slots: [{}] } }, "SCHEMA_INVALID"],
    // slugs
    ["slug user--x", "studio_template_create", { slug: "user--x", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID"],
    ["slug user-x-", "studio_template_create", { slug: "user-x-", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID"],
    ["slug without user-", "studio_template_create", { slug: "laporan-saya", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID"],
    ["slug 65 chars", "studio_template_create", { slug: `user-${"a".repeat(60)}`, name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID"],
    ["slug path-like", "studio_template_check", { slug: "../datum-gsp" }, "SCHEMA_INVALID"],
    // absurd versionNo
    ["versionNo 0", "studio_template_update", { slug: SLUG, baseVersionNo: 0, changeNote: "x", changes: { advanced: { "chart.sortOrder": "natural" } } }, "SCHEMA_INVALID"],
    ["versionNo -1", "studio_template_check", { slug: SLUG, version: -1 }, "SCHEMA_INVALID"],
    ["versionNo 1001", "studio_template_check", { slug: SLUG, version: 1001 }, "SCHEMA_INVALID"],
    ["versionNo 1e9", "studio_template_preview", { slug: SLUG, version: 1e9 }, "SCHEMA_INVALID"],
    ["versionNo 1.5", "studio_template_create", { slug: "user-e2e-salah", name: "x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp", version: 1.5 } }, "SCHEMA_INVALID"],
    ["versionNo 2^53", "studio_template_update", { slug: SLUG, baseVersionNo: 2 ** 53, changeNote: "x", changes: { advanced: { "chart.sortOrder": "natural" } } }, "SCHEMA_INVALID"],
    // characters and keys (§6 limits, before the schema)
    ["bidi U+202E in a slot label", "studio_template_check", { template: { $schema: "studio.template/v2", skeleton: { slots: [{ slotKey: "cover", label: "Sampul ‮fdp.exe" }] } } }, "SCHEMA_INVALID", "bidi"],
    ["isolate U+2066 in name", "studio_template_create", { slug: "user-e2e-salah", name: "nama ⁦x", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID"],
    ["C0 BEL in changeNote", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "catatan \u0007", changes: { advanced: { "chart.sortOrder": "natural" } } }, "SCHEMA_INVALID"],
    ["lone surrogate in name", "studio_template_create", { slug: "user-e2e-salah", name: "nama \ud800", kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID", "surrogate"],
    ["NFD in changeNote", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "Café", changes: { advanced: { "chart.sortOrder": "natural" } } }, "SCHEMA_INVALID", "NFC"],
    ["__proto__ key", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: JSON.parse('{"advanced":{"__proto__":{"polluted":true}}}') }, "SCHEMA_INVALID", "__proto__"],
    ["constructor key in template", "studio_template_check", { template: { $schema: "studio.template/v2", constructor: { prototype: { x: 1 } } } }, "SCHEMA_INVALID", "constructor"],
    // very long strings
    ["name 201 chars", "studio_template_create", { slug: "user-e2e-salah", name: big(201), kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID"],
    ["description 2001 chars", "studio_template_create", { slug: "user-e2e-salah", name: "x", description: big(2001), kind: "DOCUMENT", changeNote: "x", from: { slug: "datum-gsp" } }, "SCHEMA_INVALID"],
    ["changeNote 4001 chars", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: big(4001), changes: { advanced: { "chart.sortOrder": "natural" } } }, "SCHEMA_INVALID", "4000"],
    ["param value 4001 chars", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: { advanced: { "runningHead.docLabel": big(4001) } } }, "SCHEMA_INVALID", "4000"],
    ["key 4001 chars", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: { advanced: { [big(4001)]: 1 } } }, "SCHEMA_INVALID"],
    ["array 1001 items", "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: { unset: Array.from({ length: 1001 }, (_, i) => `k${i}`) } }, "SCHEMA_INVALID", "1000"],
  ]

  test("every case: ok:false with its code; no template or version added; the host never calls fetch", async () => {
    const n = counts(h)
    const results: Array<[string, string | undefined, boolean]> = []
    for (const [label, tool, args, code, contains] of cases()) {
      const r = await call(label.length % 2 === 0 ? claude : swarm, tool, args)
      results.push([label, r.code, r.isError === true])
      expect({ label, ok: r.ok, code: r.code, isError: r.isError ?? false }).toEqual({ label, ok: false, code, isError: false })
      if (contains) expect({ label, text: issuesText(r).includes(contains) || String((r.error as Rec).message).includes(contains) }).toEqual({ label, text: true })
    }
    expect(counts(h)).toEqual(n)
    expect(latestNo(h, SLUG)).toBe(3)
    expect(({} as Rec).polluted).toBeUndefined()
    expect(h.fetchCalls()).toBe(0)
    evidence.malformed = { cases: results.length, codes: results.reduce<Rec>((a, [, c]) => ({ ...a, [String(c)]: Number(a[String(c)] ?? 0) + 1 }), {}) }
  })

  test("nesting depth: 12 passes the limit walk, 13 is refused as too deep", async () => {
    const nest = (depth: number): Rec => {
      // args(0) -> template(1) -> skeleton(2) -> x(3) ... the innermost value sits at `depth`.
      let v: unknown = 1
      for (let d = depth; d > 3; d--) v = { x: v }
      return { template: { $schema: "studio.template/v2", skeleton: { x: v } } }
    }
    const at12 = await call(claude, "studio_template_check", nest(12))
    const at13 = await call(claude, "studio_template_check", nest(13))
    expect(at13).toMatchObject({ ok: false, code: "SCHEMA_INVALID" })
    expect(issuesText(at13)).toContain("kedalaman lebih dari 12")
    // depth 12 is not a limit refusal (it may still fail the template schema, which comes after the limits)
    expect(issuesText(at12)).not.toContain("kedalaman")
    evidence.depth = { at12: at12.code ?? at12.verdict, at13: at13.code }
  })

  test("a stored version that does not exist (version 999) is a normal refusal, not isError", async () => {
    const r = await call(claude, "studio_template_check", { slug: SLUG, version: 999 })
    expect(r.ok).toBe(false)
    expect(r.isError).toBeUndefined()
    evidence.version999 = r.code
  })
})

describe("row 69: oversized input", () => {
  // Pads `changes.advanced` (no limit on object width) with 3000-char strings until JSON.stringify(args) is `bytes`.
  const sized = (bytes: number): Rec => {
    const advanced: Rec = {}
    const args: Rec = { slug: SLUG, baseVersionNo: 3, changeNote: "x", changes: { advanced } }
    let i = 0
    while (Buffer.byteLength(JSON.stringify(args)) + 3100 < bytes) advanced[`k${String(i++).padStart(4, "0")}`] = "b".repeat(3000)
    advanced.zfill = ""
    const rest = bytes - Buffer.byteLength(JSON.stringify(args))
    advanced.zfill = "c".repeat(rest)
    expect(Buffer.byteLength(JSON.stringify(args))).toBe(bytes)
    return args
  }

  test("arguments of 1 MiB + 1 byte -> INPUT_TOO_LARGE; exactly 1 MiB passes the byte limit (refused later, not as too large)", async () => {
    const over = await call(swarm, "studio_template_update", sized((1 << 20) + 1))
    const at = await call(swarm, "studio_template_update", sized(1 << 20))
    expect(over).toMatchObject({ ok: false, code: "INPUT_TOO_LARGE" })
    expect(at.ok).toBe(false)
    expect(at.code).not.toBe("INPUT_TOO_LARGE")
    expect(latestNo(h, SLUG)).toBe(3)
    evidence.argsBytes = { over: over.code, exact: at.code }
  })

  test("a template over 512 KiB (canonical) but under 1 MiB -> INPUT_TOO_LARGE", async () => {
    const pad: Rec = {}
    for (let i = 0; i < 200; i++) pad[`k${i}`] = "d".repeat(3000)
    const r = await call(claude, "studio_template_check", { template: { $schema: "studio.template/v2", essentials: pad } })
    expect(r).toMatchObject({ ok: false, code: "INPUT_TOO_LARGE" })
    expect(String((r.error as Rec).message)).toContain(String(512 * 1024))
  })

  test("template JSON over the host's 8 MiB body cap -> HTTP 413 on a live session; nothing saved; the session still works", async () => {
    // Open a session by hand to get its id, then send a tools/call whose body is over 8 MiB.
    const init = await h.raw({ headers: { "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(path.join(h.work, "home", "proyek-claude")) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "row69-raw", version: "0" } } }) })
    expect(init.status).toBe(200)
    const sid = String(init.headers["mcp-session-id"])
    const n = counts(h)
    const essentials: Rec = {}
    for (let i = 0; i < 2900; i++) essentials[`k${i}`] = "e".repeat(3000)
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "studio_template_update", arguments: { slug: SLUG, baseVersionNo: 3, changeNote: "x", template: { $schema: "studio.template/v2", essentials } } } })
    expect(Buffer.byteLength(body)).toBeGreaterThan(8 * 1024 * 1024)
    const r = await h.raw({ headers: { "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" }, body })
    expect(r.status).toBe(413)
    expect(r.body).toBe("")
    expect(counts(h)).toEqual(n)
    const after = await call(claude, "studio_template_check", { slug: SLUG, guard: false })
    expect(after.ok).toBe(true)
    evidence.body413 = { bytes: Buffer.byteLength(body), status: r.status }
  })

  test("a guard report over 64 KiB is never stored: the save is refused and nothing is saved", async () => {
    const real = h.services.service.installedTemplateGuard()!
    h.services.service.configureTemplateGuard(async (i) => {
      const o = await real(i)
      return o.verdict === "pass" || o.verdict === "warn" ? { ...o, report: { ...(o.report as Rec), pad: "r".repeat(70_000) } } : o
    })
    try {
      const n = counts(h)
      const r = await call(claude, "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: "Laporan guard besar", changes: { advanced: { "chart.sortOrder": "natural" } } })
      expect(r.ok).toBe(false)
      expect(counts(h)).toEqual(n)
      expect(latestNo(h, SLUG)).toBe(3)
      evidence.report64k = { code: r.code, isError: r.isError ?? false, message: (r.error as Rec | undefined)?.message ?? null }
    } finally {
      h.services.service.configureTemplateGuard(real)
    }
  })

  test("fitReport shrinks a worst-case guard report (103 checks x 12 issues x 300 chars) to at most 64 KiB", () => {
    const g = h.services.guard
    const side = { status: "FAIL" as const, failCount: 12, reportCount: 0 }
    const checks = Array.from({ length: 103 }, (_, i) => ({ id: `X-${i}`, group: "A", class: "S1" as const, reference: side, candidate: side, outcome: "warn" as const, reason: "REFERENCE_FAILS" as const, issues: Array.from({ length: 12 }, () => ({ status: "FAIL", detail: "z".repeat(300), pointer: "/a/b" })) }))
    const report = { guard: { version: "x", sample: "x" }, op: "update", slug: SLUG, sampleSha256: null, referenceVersionId: "x", reference: { slug: SLUG, versionNo: 3 }, renderTier: "TERBIT", lintTier: "TERBIT", language: "ID", formats: ["DOCX", "HTML"], lintParamPin: "equal", lintParamTier: null, releaseStatus: null, registryCount: 103, classCounts: null, checks, unregistered: [], jobWarnings: Array.from({ length: 20 }, () => ({ side: "candidate", code: "W", message: "w".repeat(300) })), verdict: "warn", durationMs: 1 } as unknown as Parameters<typeof g.fitReport>[0]
    const before = Buffer.byteLength(JSON.stringify(report))
    const fitted = g.fitReport(report)
    const after = Buffer.byteLength(JSON.stringify(fitted))
    expect(before).toBeGreaterThan(g.GUARD_REPORT_MAX_BYTES)
    expect(after).toBeLessThanOrEqual(g.GUARD_REPORT_MAX_BYTES)
    expect(fitted.checks.length).toBe(103)
    evidence.fitReport = { before, after }
  })
})

describe("row 69: concurrent writes never lose an update", () => {
  test("three updates of the same base at once (claude, swarm, claude): exactly one is saved, the others get BASE_CONFLICT", async () => {
    const n = counts(h)
    const calls: Array<[Client, string, Rec]> = [
      [claude, "chart.sortOrder", { "chart.sortOrder": "natural" }],
      [swarm, "controlSheet.subtitle.enabled", { "controlSheet.subtitle.enabled": false }],
      [claude2, "slot.placeholderText", { "slot.placeholderText": "[{label} kosong]" }],
    ]
    const results = await Promise.all(calls.map(([c, what, advanced]) => call(c, "studio_template_update", { slug: SLUG, baseVersionNo: 3, changeNote: `Serentak ${what}`, changes: { advanced } })))
    const winners = results.filter((r) => r.ok === true)
    const losers = results.filter((r) => r.ok !== true)
    expect(winners.length).toBe(1)
    expect(winners[0].versionNo).toBe(4)
    expect(losers.map((r) => r.code)).toEqual(["BASE_CONFLICT", "BASE_CONFLICT"])
    expect(counts(h)).toEqual({ templates: n.templates, versions: n.versions + 1 })
    expect(latestNo(h, SLUG)).toBe(4)
    // The winner's change is in v4; every loser was told so (no ok:true whose change is missing).
    const w = calls[results.indexOf(winners[0])]
    const v4 = versionRow(h, SLUG, 4)
    expect((JSON.parse(String(v4.resolved_params)) as Rec)[w[1]]).toEqual(Object.values(w[2])[0])
    expect(v4.base_version_id).toBe(versionRow(h, SLUG, 3).id)
    for (const l of losers) expect((((l.error as Rec).details as Rec).latestVersionNo ?? 4) as number).toBe(4)
    evidence.concurrentUpdate = { results: results.map((r) => [r.ok, r.code ?? r.versionNo]), winner: w[1], v4CreatedBy: v4.created_by }
  })

  test("a loser that reloads and retries on the new base is saved as the next version (nothing lost)", async () => {
    const r = await call(swarm, "studio_template_update", { slug: SLUG, baseVersionNo: 4, changeNote: "Ulang setelah konflik", changes: { advanced: { "chart.sortOrder": "valueDesc", "table.header.verticalAlign": "bottom" } } })
    expect(r).toMatchObject({ ok: true, versionNo: 5 })
  })

  test("two creates of the same new slug at once: one is saved, the other gets TEMPLATE_SLUG_TAKEN", async () => {
    const args = { slug: "user-e2e-kembar", name: "Kembar", kind: "DOCUMENT", changeNote: "Salinan serentak", from: { slug: "datum-gsp" } }
    const rs = await Promise.all([call(claude, "studio_template_create", args), call(swarm, "studio_template_create", args)])
    expect(rs.filter((r) => r.ok === true).length).toBe(1)
    expect(rs.filter((r) => r.ok !== true).map((r) => r.code)).toEqual(["TEMPLATE_SLUG_TAKEN"])
    expect(Number(h.q<{ n: number }>("SELECT count(*) AS n FROM template WHERE slug = 'user-e2e-kembar'")[0].n)).toBe(1)
    expect(latestNo(h, "user-e2e-kembar")).toBe(1)
    evidence.concurrentCreate = rs.map((r) => [r.ok, r.code ?? r.versionNo])
  })
})

describe("row 69: archive (spec §4, §9 row 69 (3))", () => {
  test("claude archives swarm's template: hidden from the list, its document still renders on its pin, update refused", async () => {
    const a = await call(claude, "studio_template_archive", { slug: SLUG, archived: true })
    expect(a).toMatchObject({ ok: true, slug: SLUG, archived: true })
    const list = await call(swarm, "studio_templates_list", {})
    expect(JSON.stringify(list.templates)).not.toContain(SLUG)
    const old = await call(swarm, "studio_render", { documentId, formats: ["html"], revisionNo: revOnV1 })
    expect(old.ok).toBe(true)
    expect(pinnedOf((old.job as { id: string }).id)).toMatchObject({ versionNo: 1, versionId: String(versionRow(h, SLUG, 1).id) })
    const upd = await call(swarm, "studio_template_update", { slug: SLUG, baseVersionNo: 5, changeNote: "x", changes: { advanced: { "chart.sortOrder": "natural" } } })
    expect(upd.code).toBe("TEMPLATE_ARCHIVED")
    const copy = await call(swarm, "studio_template_create", { slug: "user-e2e-dari-arsip", name: "Dari arsip", kind: "DOCUMENT", changeNote: "Salin templat terarsip", from: { slug: SLUG, version: 2 } })
    expect(copy).toMatchObject({ ok: true, versionNo: 1 })
    expect(versionRow(h, "user-e2e-dari-arsip", 1).definition_sha256).toBe(versionRow(h, SLUG, 2).definition_sha256)
  })

  test("a NEW document on an archived template is refused TEMPLATE_ARCHIVED (spec §4 archive row)", async () => {
    // Spec §4 (masterplan/01_specs_studio_templates.md:160): "studio_template_update and studio_document_create on
    // it are refused (TEMPLATE_ARCHIVED)". studio_write creates documents too, so both entry points are asked.
    const docCount = () => Number(h.q<{ n: number }>("SELECT count(*) AS n FROM document")[0].n)
    const docs = docCount()
    const c = await call(swarm, "studio_document_create", { template: SLUG, mission: MISSION, docKey: "nota-arsip-a", title: "Nota pada templat terarsip A" })
    const w = await call(swarm, "studio_write", { mission: MISSION, docKey: "nota-arsip-b", template: SLUG, meta: { title: "Nota pada templat terarsip B", author: "Agen Uji", number: "UJI-69/2026-B" }, sections: [{ heading: "Isi", blocks: ["Tidak boleh dibuat."] }] })
    evidence.newDocOnArchived = { documentCreate: { ok: c.ok, code: c.code ?? null }, write: { ok: w.ok, code: w.code ?? null }, docsBefore: docs, docsAfter: docCount() }
    expect({ documentCreate: c.code ?? (c.ok ? "ok" : "refused"), write: w.code ?? (w.ok ? "ok" : "refused") }).toEqual({ documentCreate: "TEMPLATE_ARCHIVED", write: "TEMPLATE_ARCHIVED" })
    expect(docCount()).toBe(docs)
  })

  test("unarchive restores it to the list", async () => {
    const u = await call(swarm, "studio_template_archive", { slug: SLUG, archived: false })
    expect(u).toMatchObject({ ok: true, archived: false })
    expect(JSON.stringify((await call(claude, "studio_templates_list", {})).templates)).toContain(SLUG)
  })
})

describe("row 69: static checks (U.6, U.9)", () => {
  test("the dropped lock reason 'unmapped' (U.6) is in no template code path, and no product line uses it as a lock reason", () => {
    const word = ["un", "mapped"].join("")
    const tpl = [path.join(PKG, "vendor", "src", "lib", "studio", "services", "templates"), path.join(PKG, "vendor", "src", "components", "studio"), path.join(PKG, "src", "mcp-host", "templates")]
    const inTemplates = spawnSync("grep", ["-rn", word, ...tpl], { encoding: "utf8" })
    expect(inTemplates.status).toBe(1)
    expect(inTemplates.stdout).toBe("")
    // U.9 asks for the literal over the whole package. Product hits are recorded for the controller; none may be a
    // TEMPLATE_FORM_LOCKED reason (a `reason` field or the lock code on the same line).
    const all = spawnSync("grep", ["-rn", word, path.join(PKG, "src"), path.join(PKG, "vendor", "src"), path.join(PKG, "vendor", "scripts")], { encoding: "utf8" })
    const lines = all.stdout.trim() === "" ? [] : all.stdout.trim().split("\n").map((l) => l.replace(`${PKG}/`, ""))
    evidence.grepUnmapped = { templatePaths: 0, packageProductLines: lines }
    expect(lines.filter((l) => /reason|TEMPLATE_FORM_LOCKED/.test(l))).toEqual([])
  })

  test("no host fetch during the whole suite; the render bridge stand-in saw only hello/checkPage/pdf", () => {
    expect(h.fetchCalls()).toBe(0)
    expect([...new Set(h.bridgeOps)].every((o) => ["hello", "checkPage", "pdf"].includes(o))).toBe(true)
  })
})
