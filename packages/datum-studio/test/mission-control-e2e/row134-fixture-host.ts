// Row 134 fixture generator + host: the REAL Studio host (src/mcp-host, read-only here) in its own bun process, with
// one fixture mission per builtin type (feature-release, research, debug, document) produced through the real mission
// tools over streamable HTTP (MCP SDK client, agent "claude", caller cwd = the fixture project). Nothing is written to
// the store by hand except the output verification records, which go through row 149's store API
// (putOutputVerification), the same call row 154's studio_render wrapper makes (row 154 has not landed; row 155 test
// does the same).
//
// Started by swarm/packages/app/src/pages/session/swarm/mission-control-e2e.render.ts. Env (fixture paths only):
//   R134_WORK      work folder (store, home, project are created under it)
//   R134_MUTATION  optional: "phase-filter" removes the type phase filter of the derived phases IN MEMORY (a Bun
//                  plugin rewrites the loaded source of store/mission/mission-store.ts; the file on disk is untouched)
// Prints one line `READY <json>` with {url, token, project, store, missions, mutation} and stays up until SIGTERM.
// globalThis.fetch is a trap for the host: the host makes no outbound call (no model call). The MCP client of this
// generator gets the real fetch explicitly.
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const WORK = process.env.R134_WORK!
if (!WORK) throw new Error("R134_WORK is required")
const MUTATION = process.env.R134_MUTATION ?? ""
const STORE = path.join(WORK, "data", "datum-studio")
const LOG = path.join(WORK, "data", "store.jsonl")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-134")
for (const d of [HOME, RES, PROJECT, path.dirname(STORE)]) mkdirSync(d, { recursive: true })

process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

// ── Mutation (spec: "one mutation (phase filter removed) fails"): in memory only.
if (MUTATION === "phase-filter") {
  const target = /phases: \[\.\.\.type\.phases\](\s*\.sort\(\(a, b\) => a\.order - b\.order\)\s*\.map\(\(p\) => \{\s*const inPhase)/
  let applied = false
  Bun.plugin({
    name: "row134-mutation-phase-filter",
    setup(build) {
      build.onLoad({ filter: /store\/mission\/mission-store\.ts$/ }, async (args) => {
        const src = await Bun.file(args.path).text()
        if (!target.test(src)) throw new Error("row134 mutation: phase filter site not found in mission-store.ts")
        applied = true
        return { contents: src.replace(target, "phases: [...((globalThis as any).__row134AllPhases ?? type.phases)]$1"), loader: "ts" }
      })
    },
  })
  const { BUILTIN_MISSION_TYPES } = await import(path.join(PKG, "src", "store", "mission", "builtin-types.ts"))
  const seen = new Map<string, Record<string, unknown>>()
  for (const t of BUILTIN_MISSION_TYPES as Array<{ phases: Array<Record<string, unknown> & { id: string }> }>)
    for (const p of t.phases) if (!seen.has(p.id)) seen.set(p.id, { ...p, order: seen.size + 1 })
  ;(globalThis as Record<string, unknown>).__row134AllPhases = [...seen.values()]
  process.on("exit", () => {
    if (!applied) process.stderr.write("MUTATION_NOT_APPLIED\n")
  })
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown) => {
  process.stderr.write(`FETCH_CALLED ${String(input).slice(0, 200)}\n`)
  throw new Error("row134 fixture: the host must not call fetch")
}) as unknown as typeof fetch

type S = Record<string, any>
const mod = await import(path.join(PKG, "src", "mcp-host", "index.ts"))
const RELEASE = "1.2.1"
const TOKEN = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")
const store = await mod.openHostStore(STORE, { release: RELEASE, logFile: LOG, missionGuard: true })
mod.configureTemplateSource({ templatesDir: path.join(PKG, "templates"), assetRepoRoot: VENDOR, release: RELEASE })
const hostLog = (level: string, source: string, message: string, context?: Record<string, unknown>) => {
  if (level === "error") process.stderr.write(`HOST_ERROR ${source} ${message} ${JSON.stringify(context ?? {}).slice(0, 600)}\n`)
}
const server = await mod.startStudioHostServer({
  store,
  token: TOKEN,
  hostname: "127.0.0.1",
  port: 0,
  log: hostLog,
  facts: { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") },
})

const client = new Client({ name: "row134-fixture", version: "0" })
await client.connect(
  new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: realFetch as never,
    requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "claude", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } },
  }),
)

async function call(name: string, args: Record<string, unknown>): Promise<S> {
  const r = await client.callTool({ name, arguments: args })
  const out = (r.structuredContent ?? {}) as S
  if (r.isError || out.ok === false) throw new Error(`fixture: ${name} refused: ${JSON.stringify(out).slice(0, 1200)}`)
  return out
}

type RowSpec = { id: string; phase: string; kind: string; title: string; agent: string }
const rowDoc = (r: RowSpec) => ({ ...r, model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${r.id}.md`, verification: "tests pass", review: "gate" })

async function patch(mission: string, rows: Array<Record<string, unknown>>) {
  for (const r of rows) await call("studio_mission_update_row", { mission, rows: [r] })
}
/** Store transitions an agent makes: pending -> running [-> needs-review [-> done]] / running -> blocked (with note). */
async function walk(mission: string, id: string, to: string, extra: Record<string, unknown> = {}) {
  if (to === "pending") return
  if (to === "dropped") return void (await call("studio_mission_update_row", { mission, rows: [{ id, status: "dropped", note: "superseded by row 3" }], decision: "U1" }))
  await patch(mission, [{ id, status: "running" }])
  if (to === "running") return extra.checkpoint ? patch(mission, [{ id, checkpoint: extra.checkpoint }]) : undefined
  if (to === "blocked") return patch(mission, [{ id, status: "blocked", note: String(extra.note ?? "blocked") }])
  await patch(mission, [{ id, status: "needs-review" }])
  if (to === "needs-review") return
  await patch(mission, [{ id, status: "done" }])
}

async function verifyAll(documentId: string) {
  const set = await store.revisionVerification(documentId, "latest")
  for (const o of set.outputs)
    await store.transaction((tx: unknown) =>
      store.putOutputVerification(tx, {
        outputFileId: o.outputId,
        outputSha256: o.sha256,
        state: "verified",
        checksVersion: 1,
        failCount: 0,
        unknownCount: 0,
        report: { state: "verified", checks: [{ check: "LINT", status: "PASS" }, { check: "OVERLAP_CLIP", status: "PASS" }] },
        verifiedBy: "row134-fixture",
      }),
    )
  return set.outputs.map((o: S) => o.outputId as string)
}

/** A Studio document of the mission, rendered to HTML (the host renders HTML itself; PDF needs Electron). */
async function deliverable(mission: string, docKey: string, title: string, verified: boolean) {
  const d = await call("studio_document_create", { template: "datum-nota", mission, docKey, title })
  const documentId = String(d.documentId)
  await call("studio_chapter_import_markdown", { documentId, chapterKey: "1", markdown: `# ${title}\n\nIsi ringkas untuk uji mission control.\n`, submit: true, baseRevisionNo: 1 })
  const rev = (await store.revisionVerification(documentId, "latest")).revisionNo
  await call("studio_render", { documentId, revisionNo: rev, formats: ["html"] })
  const outputs = verified ? await verifyAll(documentId) : (await store.revisionVerification(documentId, "latest")).outputs.map((o: S) => o.outputId)
  return { documentId, docKey, title, verified, outputs }
}

type Fixture = {
  id: string
  type: string
  title: string
  rows: Array<RowSpec & { to: string; note?: string; checkpoint?: { n: number; m: number } }>
  request: { question: string; options: Array<{ id: string; label: string; consequence: string }>; recommended: string; blockingRows: string[] }
  docs: Array<{ docKey: string; title: string; verified: boolean; beforeDone?: boolean }>
  finalStatus?: string
}

const FIXTURES: Fixture[] = [
  {
    id: "2026-11-07_m134-feature",
    type: "feature-release",
    title: "Mission control release",
    rows: [
      { id: "1", phase: "identification", kind: "intake", title: "Translate the request", agent: "request-translator", to: "done" },
      { id: "2", phase: "identification", kind: "spec", title: "Blueprint", agent: "task-architect", to: "done" },
      { id: "3", phase: "research", kind: "research", title: "Explore the repo", agent: "explore", to: "done" },
      { id: "4", phase: "implementation", kind: "implementation", title: "Build the mission bridge", agent: "coder-execution", to: "running", checkpoint: { n: 2, m: 5 } },
      { id: "5", phase: "implementation", kind: "implementation", title: "Render bridge", agent: "coder-execution", to: "blocked", note: "render check failed" },
      { id: "6", phase: "verification", kind: "test", title: "Contract tests", agent: "test-expert", to: "pending" },
      { id: "7", phase: "release", kind: "release", title: "Release prep", agent: "git-specialist", to: "pending" },
    ],
    request: {
      question: "Which reviewer gates the release?",
      options: [
        { id: "A", label: "senior-code-reviewer", consequence: "deeper review, one more day" },
        { id: "B", label: "verifier", consequence: "faster, checks the gates only" },
      ],
      recommended: "A",
      blockingRows: ["6", "7"],
    },
    docs: [
      { docKey: "row-2-blueprint", title: "Blueprint mission control", verified: true, beforeDone: true },
      { docKey: "row-4-design", title: "Bridge design note", verified: false },
    ],
  },
  {
    id: "2026-11-07_m134-research",
    type: "research",
    title: "Vendor landscape study",
    rows: [
      { id: "1", phase: "identification", kind: "intake", title: "Scope the question", agent: "request-translator", to: "done" },
      { id: "2", phase: "research", kind: "research", title: "Collect vendor data", agent: "data-collector", to: "running", checkpoint: { n: 1, m: 3 } },
      { id: "3", phase: "research", kind: "research", title: "Read the sources", agent: "explore", to: "needs-review" },
      { id: "4", phase: "synthesis", kind: "synthesis", title: "Compare vendors", agent: "data-analyst", to: "pending" },
      { id: "5", phase: "report", kind: "report", title: "Write the study", agent: "document-writer", to: "pending" },
    ],
    request: {
      question: "Include vendors outside the region?",
      options: [
        { id: "A", label: "Region only", consequence: "smaller study" },
        { id: "B", label: "Global", consequence: "two more days" },
      ],
      recommended: "A",
      blockingRows: ["4"],
    },
    docs: [
      { docKey: "row-3-sources", title: "Source digest", verified: true },
      { docKey: "row-5-study", title: "Vendor study", verified: false },
    ],
  },
  {
    id: "2026-11-07_m134-debug",
    type: "debug",
    title: "Fix the login loop",
    rows: [
      { id: "1", phase: "reproduce", kind: "reproduce", title: "Reproduce the loop", agent: "explore", to: "done" },
      { id: "2", phase: "diagnose", kind: "diagnose", title: "Find the cause", agent: "data-analyst", to: "done" },
      { id: "3", phase: "fix", kind: "fix", title: "Patch the redirect", agent: "coder-execution", to: "running", checkpoint: { n: 3, m: 4 } },
      { id: "4", phase: "verify", kind: "test", title: "Regression tests", agent: "test-expert", to: "pending" },
      { id: "5", phase: "verify", kind: "review", title: "Old review row", agent: "verifier", to: "dropped" },
    ],
    request: {
      question: "Ship the hotfix before the review?",
      options: [
        { id: "A", label: "Ship now", consequence: "users get the fix today" },
        { id: "B", label: "Wait", consequence: "one more review" },
      ],
      recommended: "B",
      blockingRows: ["4"],
    },
    docs: [
      { docKey: "row-3-fix-note", title: "Fix note", verified: false },
      { docKey: "lampiran", title: "Mission appendix", verified: true },
    ],
  },
  {
    id: "2026-11-07_m134-document",
    type: "document",
    title: "Kajian DATUM",
    rows: [
      { id: "1", phase: "brief", kind: "intake", title: "Brief", agent: "request-translator", to: "done" },
      { id: "2", phase: "draft", kind: "draft", title: "Draft the study", agent: "document-writer", to: "done" },
      { id: "3", phase: "review", kind: "review", title: "Review the draft", agent: "document-reviewer", to: "needs-review" },
      { id: "4", phase: "publish", kind: "publish", title: "Publish", agent: "pm-writer", to: "pending" },
    ],
    request: {
      question: "Print the cover in colour?",
      options: [
        { id: "A", label: "Colour", consequence: "house style" },
        { id: "B", label: "Mono", consequence: "cheaper print" },
      ],
      recommended: "A",
      blockingRows: ["4"],
    },
    docs: [
      { docKey: "row-2-kajian", title: "Kajian final", verified: true, beforeDone: true },
      { docKey: "row-3-review-memo", title: "Review memo", verified: false },
    ],
  },
]

const manifest: S[] = []
const t0 = performance.now()
for (const f of FIXTURES) {
  await call("studio_mission_create", {
    mission: {
      id: f.id,
      title: f.title,
      type: f.type,
      owner: "master-controller",
      project: { dir: PROJECT },
      rows: f.rows.map(({ to: _to, note: _note, checkpoint: _cp, ...r }) => rowDoc(r)),
      decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "go" }],
    },
  })
  await call("studio_mission_approve", { mission: f.id, decision: "U1" })
  await call("studio_mission_set_status", { mission: f.id, to: "running" })
  // Deliverables bound to a row that goes done are rendered and verified first (row 155 gate: done only when verified).
  const docs: S[] = []
  for (const d of f.docs.filter((x) => x.beforeDone)) docs.push(await deliverable(f.id, d.docKey, d.title, d.verified))
  for (const r of f.rows) await walk(f.id, r.id, r.to, { note: r.note, checkpoint: r.checkpoint })
  for (const d of f.docs.filter((x) => !x.beforeDone)) docs.push(await deliverable(f.id, d.docKey, d.title, d.verified))
  const requested = await call("studio_mission_request_decision", { mission: f.id, request: { id: "D-1", ...f.request } })
  await call("studio_mission_update_row", {
    mission: f.id,
    messages: [
      { from: "agent", to: "controller", kind: "report", text: `${f.rows.find((r) => r.to === "running")?.title ?? "work"} started`, row: f.rows.find((r) => r.to === "running")?.id ?? "1" },
      { from: "owner", to: "controller", kind: "instruction", text: "Keep the scope to this release" },
    ],
  })
  if (f.finalStatus) await call("studio_mission_set_status", { mission: f.id, to: f.finalStatus })
  manifest.push({ id: f.id, type: f.type, title: f.title, request: requested.id ?? "D-1", docs })
}
const generatedMs = Math.round(performance.now() - t0)
await client.close()

process.stdout.write(`READY ${JSON.stringify({ url: server.url, token: TOKEN, project: PROJECT, store: STORE, missions: manifest, mutation: MUTATION || null, generatedMs })}\n`)

const stop = async () => {
  await server.close()
  mod.configureTemplateSource(null)
  await mod.closeHostStore(store)
  process.exit(0)
}
process.on("SIGTERM", () => void stop())
process.on("SIGINT", () => void stop())
