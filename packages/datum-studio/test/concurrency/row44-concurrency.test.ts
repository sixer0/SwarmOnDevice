// Row 44 (Swarm 1.2.0): two clients through ONE Studio host do not corrupt the store (studio spec §10.6, store spec
// §6.8, decisions C58/C73).
//   client S = a streamable-HTTP MCP session with agent `swarm` (the sidecar path);
//   client C = the real row 34 stdio chain `~/.local/bin/datum-studio` -> launcher -> datum-studio-bridge.js with
//              agent `claude` (bundled exactly as row 36 stages it, fixture descriptor as row 34's tests write it).
// Both write at the same time: document creates, chapter submits to their own documents, mission row notes, plus
// deliberate contention on one shared document (same chapter -> exactly one saved + SCOPE_CONFLICT; different chapters
// -> both saved, rebased; foreign mission+docKey -> DOCUMENT_OWNED_BY_OTHER). Afterwards, read straight from the
// SQLite file: every acknowledged write is present (count and content), revision numbers dense per document,
// PRAGMA integrity_check ok, FTS5 integrity-check ok and FTS hits = doc_block rows per marker, zero STORE_BUSY.
// A second host on the same root while the first runs -> STORE_LOCKED (spec §10.6, row 7 note).
// Mutation control: the same run against a host whose write queue is bypassed (host.ts R44_MUTATION) must fail.
//
// Needs local listen and /bin/ps (launcher PID check, lock liveness): run with the agent sandbox off.
// Test-only setting (C73): the host gets STUDIO_RENDER_RATE_LIMIT=1000, because creates (R04) and chapter submits (R12)
// count against the 30/60 s render limiter and this run makes > 30 of them per agent in well under 60 s.
// ROW44_MUTATION=bypass-queue|deferred-nobusy applies the mutation to the MAIN run (then the main test must fail).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const PKG = path.resolve(import.meta.dir, "..", "..")
const DESKTOP = path.resolve(PKG, "..", "desktop")
const BASE = process.env.ROW44_TEST_DIR ?? "/private/tmp/claude-501/row44/tests"
mkdirSync(BASE, { recursive: true })
const FX = realpathSync(mkdtempSync(path.join(BASE, "run-")))
const BUN = realpathSync(process.execPath)
const PROXY = "http://127.0.0.1:9"
const FAKE_SWARM = path.join(FX, "Fake.app", "Contents", "MacOS", "Swarm")
const RES = path.join(FX, "Swarm.app", "Contents", "Resources")
const HOST_SCRIPT = path.join(import.meta.dir, "host.ts")
// Store spec §2.3 item 3: the store test also runs under Electron's Node (the host's runtime). Default: the host runs
// under Electron 42's Node (ELECTRON_RUN_AS_NODE=1, node:sqlite) from a Bun.build bundle, like row 43; `bun` runs
// host.ts from source (bun:sqlite). The clients (HTTP SDK client, wrapper/launcher/bridge) always run on bun.
const HOST_RUNTIME = (process.env.ROW44_HOST_RUNTIME ?? "electron") as "electron" | "bun"
const ELECTRON = process.env.ROW44_ELECTRON ?? path.join(DESKTOP, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
const HOST_BUNDLE = path.join(FX, "bundle", "host.js")
const DOCS = Number(process.env.ROW44_DOCS ?? 10) // documents per client; 4 writes each -> 40 writes per client
const POOL = 3 // chains in flight per client
const ROUNDS = 4 // contention rounds on the shared document
const MISSION_DOCS = "2026-11-07_row44"
const MISSION = "2026-11-07_row44-m"
const realFetch = globalThis.fetch
const quoted: string[] = []
const quote = (label: string, v: unknown) => {
  const line = `${label}: ${JSON.stringify(v)}`
  quoted.push(line)
  console.log(`[row44] ${line}`)
}
const children: ChildProcessWithoutNullStreams[] = []

type S = Record<string, any>
type Agent = "swarm" | "claude"

// ── fixture: Resources with launcher + bundled bridge, a swarm-cli shim, the wrapper ────────────────────────────────
let bridgeJs = ""
beforeAll(async () => {
  mkdirSync(path.dirname(FAKE_SWARM), { recursive: true })
  if (HOST_RUNTIME === "electron") {
    if (ELECTRON.startsWith("/Applications/")) throw new Error("refusing an Electron under /Applications")
    // The fake Swarm binary is a symlink to Electron: `ps -o comm=` then ends in /Contents/MacOS/Swarm (launcher check)
    // and the lock's liveness regex accepts it, while the process really is Electron 42's Node.
    symlinkSync(realpathSync(ELECTRON), FAKE_SWARM)
    // Bundled in a child bun process: Bun.build of this entry inside the test process failed to resolve vendor's
    // extensionless imports after the bridge build (same call works standalone and in row 43's test).
    const script = path.join(FX, "bundle-host.ts")
    writeFileSync(script, `const r = await Bun.build({ entrypoints: [${JSON.stringify(HOST_SCRIPT)}], target: "node", format: "esm", outdir: ${JSON.stringify(path.dirname(HOST_BUNDLE))} })\nif (!r.success) { console.error(r.logs.map(String).join("\\n")); process.exit(1) }\n`)
    const hb = Bun.spawnSync([BUN, script], { cwd: FX, env: { ...process.env } })
    if (hb.exitCode !== 0) throw new Error(`host bundle failed: ${hb.stderr.toString()}`)
    const text = readFileSync(HOST_BUNDLE, "utf8")
    quote("host bundle", { bytes: text.length, nodeSqlite: text.includes('"node:sqlite"'), bunSqlite: text.includes('"bun:sqlite"') })
    expect(text.includes('"node:sqlite"')).toBe(true)
    expect(text.includes('"bun:sqlite"')).toBe(false)
  } else symlinkSync(BUN, FAKE_SWARM)
  mkdirSync(path.join(RES, "datum-studio", "server"), { recursive: true })
  mkdirSync(path.join(RES, "swarm-cli"), { recursive: true })
  const built = await Bun.build({ entrypoints: [path.join(DESKTOP, "scripts", "datum-studio-bridge.ts")], target: "bun" })
  if (!built.success) throw new Error(built.logs.join("\n"))
  bridgeJs = await built.outputs[0].text()
  writeFileSync(path.join(RES, "datum-studio", "server", "datum-studio-bridge.js"), bridgeJs)
  const swarmShim = path.join(RES, "swarm-cli", "swarm")
  writeFileSync(swarmShim, `#!/bin/sh\n[ "$BUN_BE_BUN" = 1 ] || { echo "BUN_BE_BUN missing" >&2; exit 97; }\nexec '${BUN}' "$@"\n`)
  chmodSync(swarmShim, 0o755)
})

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL")
  globalThis.fetch = realFetch
  writeFileSync(path.join(FX, "quoted.txt"), quoted.join("\n") + "\n")
})

interface Env {
  root: string
  home: string
  state: string
  store: string
  projectS: string
  projectC: string
  wrapper: string
}

async function makeEnv(name: string): Promise<Env> {
  const root = path.join(FX, name)
  const home = path.join(root, "h")
  const state = path.join(root, "state")
  const store = path.join(home, ".local", "share", "swarm", "datum-studio")
  const projectS = path.join(home, "project-s")
  const projectC = path.join(home, "project-c")
  for (const d of [home, state, projectS, projectC, path.join(root, "tmp")]) mkdirSync(d, { recursive: true })
  const cli = await import(path.join(DESKTOP, "src", "main", "cli-install.ts"))
  const launcher = cli.datumStudioLauncherPath(RES) as string
  if (!existsSync(launcher)) {
    copyFileSync(path.join(DESKTOP, "scripts", "datum-studio-launcher.sh"), launcher)
    chmodSync(launcher, 0o755)
  }
  const wrapper = (await cli.installDatumStudioWrapper({ launcher, stateHome: state, binDir: path.join(home, ".local", "bin") })) as string
  return { root, home, state, store, projectS, projectC, wrapper }
}

const baseEnv = (e: Env) => ({
  HOME: e.home,
  PATH: "/usr/bin:/bin",
  TMPDIR: path.join(e.root, "tmp"),
  HTTP_PROXY: PROXY,
  HTTPS_PROXY: PROXY,
  ALL_PROXY: PROXY,
  NO_PROXY: "127.0.0.1,localhost",
})

interface Host {
  child: ChildProcessWithoutNullStreams
  line: string
  runtime: S | null
  port: number
  pid: number
  stderr: () => string
  stdout: () => string
  exited: Promise<number | null>
}

/** Start host.ts as the fake Swarm binary; resolves with its first stdout line (READY or ERROR). */
async function startHost(e: Env, mutation = "", yieldInside = false): Promise<Host> {
  const child = spawn(FAKE_SWARM, [HOST_RUNTIME === "electron" ? HOST_BUNDLE : HOST_SCRIPT], {
    cwd: PKG,
    env: {
      ...baseEnv(e),
      ...(HOST_RUNTIME === "electron" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      R44_PKG: PKG,
      R44_STORE: e.store,
      R44_STATE: e.state,
      R44_HOME: e.home,
      R44_RES: RES,
      R44_DESKTOP: DESKTOP,
      STUDIO_RENDER_RATE_LIMIT: "1000",
      ...(mutation ? { R44_MUTATION: mutation } : {}),
      ...(yieldInside ? { R44_YIELD: "1" } : {}),
    },
  })
  children.push(child)
  let out = ""
  let err = ""
  child.stderr.on("data", (c: Buffer) => (err += c.toString()))
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString()
      const at = out.indexOf("\n")
      if (at >= 0) resolve(out.slice(0, at))
    })
    void exited.then((code) => reject(new Error(`host exited ${code} before a line: ${err}`)))
  })
  const [, port, pid] = line.split(" ")
  const runtime = line.startsWith("READY ") ? (JSON.parse(line.split(" ").slice(3).join(" ")) as S) : null
  return { child, line, port: Number(port), pid: Number(pid), runtime, stderr: () => err, stdout: () => out, exited }
}

async function stopHost(h: Host) {
  h.child.kill("SIGTERM")
  const code = await Promise.race([h.exited, Bun.sleep(15_000).then(() => "timeout" as const)])
  if (code === "timeout") h.child.kill("SIGKILL")
  return code
}

function descriptor(e: Env): Record<string, string> {
  const text = readFileSync(path.join(e.state, "swarm", "datum-studio.env"), "utf8")
  return Object.fromEntries(text.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
}

/** Client S: streamable HTTP, agent swarm (token read from the 0600 descriptor, as the bridge does). */
async function clientS(e: Env): Promise<Client> {
  const d = descriptor(e)
  const c = new Client({ name: "row44-swarm", version: "0" })
  const t = new StreamableHTTPClientTransport(new URL(d.URL), {
    fetch: realFetch as never,
    requestInit: { headers: { authorization: `Bearer ${d.TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(e.projectS) } },
  })
  await c.connect(t)
  return c
}

/** Client C: the real wrapper -> launcher -> bridge over stdio, agent claude (the wrapper sets STUDIO_AGENT_ID=claude). */
async function clientC(e: Env): Promise<{ client: Client; stderr: () => string }> {
  const c = new Client({ name: "row44-claude", version: "0" })
  const t = new StdioClientTransport({ command: e.wrapper, args: [], cwd: e.projectC, env: baseEnv(e), stderr: "pipe" })
  let err = ""
  t.stderr?.on("data", (b: Buffer) => (err += b.toString()))
  await c.connect(t)
  return { client: c, stderr: () => err }
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<S> {
  try {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
    const sc = (r.structuredContent ?? {}) as S
    const text = (r.content as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n")
    return { ...sc, _isError: r.isError === true, _text: text }
  } catch (e) {
    return { ok: false, code: "TRANSPORT_ERROR", _text: String(e) }
  }
}
const codeOf = (r: S) => (r.ok === true ? "OK" : String(r.code ?? r.error?.code ?? "NO_CODE"))

function md(title: string, marker: string) {
  return `# ${title}\n\nPenanda ${marker} dicatat oleh uji konkurensi baris empat puluh empat.\n`
}

// ── the workload ────────────────────────────────────────────────────────────────────────────────────────────────────
interface Ack {
  agent: Agent
  kind: "create" | "submit" | "note"
  documentId?: string
  revisionNo?: number
  marker?: string
  row?: string
  note?: string
}
interface Outcome {
  agent: Agent
  tool: string
  label: string
  code: string
  text?: string
}

interface RunResult {
  acks: Ack[]
  outcomes: Outcome[]
  contention: S[]
  shared: string
  privateDoc: string
  ownedDocs: Record<string, { agent: Agent; documentId: string; markers: string[] }>
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items]
  await Promise.all(Array.from({ length: n }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t)
  }))
}

function rowDef(id: string) {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass", review: "gate" }
}

async function runWorkload(e: Env, s: Client, c: Client, onMidRun: (acked: () => number) => Promise<void>): Promise<RunResult> {
  const acks: Ack[] = []
  const outcomes: Outcome[] = []
  const contention: S[] = []
  const ownedDocs: RunResult["ownedDocs"] = {}
  let privateDoc = ""
  const record = (agent: Agent, tool: string, label: string, r: S) => {
    outcomes.push({ agent, tool, label, code: codeOf(r), ...(r.ok === true ? {} : { text: String(r._text ?? "").slice(0, 400) }) })
    return r
  }

  // Setup (sequential, not counted): the mission with one row per (client, doc), and the shared document (swarm).
  const rows = (["s", "c"] as const).flatMap((x) => Array.from({ length: DOCS }, (_, i) => rowDef(`${x === "s" ? 1 : 2}${String(i).padStart(2, "0")}`)))
  const mc = await call(s, "studio_mission_create", {
    mission: { id: MISSION, title: "Row 44 concurrency mission", type: "feature-release", owner: "master-controller", project: { dir: e.projectS }, rows, decisions: [{ id: "U1", by: "user", date: "2026-11-07", text: "approve row 44" }] },
  })
  quote("mission create", { code: codeOf(mc), rows: mc.rows, text: mc.ok === true ? undefined : String(mc._text).slice(0, 300) })
  const ap = await call(s, "studio_mission_approve", { mission: MISSION, decision: "U1" })
  quote("mission approve", { code: codeOf(ap) })
  const sh = await call(s, "studio_document_create", { template: "datum-gsp", mission: MISSION_DOCS, docKey: "shared", title: "Row 44 shared document" })
  const shared = String(sh.documentId ?? "")
  quote("shared create", { code: codeOf(sh), documentId: shared, revisionNo: sh.revisionNo })
  const sh1 = await call(s, "studio_chapter_import_markdown", { documentId: shared, chapterKey: "1", markdown: md("Bab satu", "r44shinit"), submit: true, change: { what: "bab 1", why: "row 44", impact: "awal" } })
  quote("shared chapter 1", { code: codeOf(sh1), revisionNo: sh1.revisionNo, text: sh1.ok === true ? undefined : String(sh1._text).slice(0, 400) })
  const pv = await call(s, "studio_document_create", { template: "datum-gsp", mission: MISSION_DOCS, docKey: "private", title: "Row 44 private document" })
  const pv1 = await call(s, "studio_chapter_import_markdown", { documentId: String(pv.documentId ?? ""), chapterKey: "1", markdown: md("Bab satu", "r44pvinit"), submit: true, change: { what: "bab 1", why: "row 44", impact: "awal" } })
  quote("private create + chapter 1", { create: codeOf(pv), revisionNo: pv1.revisionNo })
  privateDoc = String(pv.documentId ?? "")

  const chain = async (agent: Agent, cl: Client, i: number) => {
    const x = agent === "swarm" ? "s" : "c"
    const docKey = `${x}-${i}`
    const cr = record(agent, "studio_document_create", docKey, await call(cl, "studio_document_create", { template: "datum-gsp", mission: MISSION_DOCS, docKey, title: `Row 44 ${agent} ${i}` }))
    if (cr.ok !== true) return
    const documentId = String(cr.documentId)
    acks.push({ agent, kind: "create", documentId, revisionNo: Number(cr.revisionNo) })
    ownedDocs[documentId] = { agent, documentId, markers: [] }
    for (const ch of ["1", "2"]) {
      const marker = `r44${x}${i}k${ch}`
      const r = record(agent, "studio_chapter_import_markdown", `${docKey}/${ch}`, await call(cl, "studio_chapter_import_markdown", { documentId, chapterKey: ch, markdown: md(`Bab ${ch}`, marker), submit: true, change: { what: `bab ${ch}`, why: "row 44", impact: "isi" } }))
      if (r.ok !== true) continue
      acks.push({ agent, kind: "submit", documentId, revisionNo: Number(r.revisionNo), marker })
      ownedDocs[documentId].markers.push(marker)
    }
    const row = `${x === "s" ? 1 : 2}${String(i).padStart(2, "0")}`
    const note = `catatan ${agent} ${i}`
    const nr = record(agent, "studio_mission_update_row", `${MISSION}/${row}`, await call(cl, "studio_mission_update_row", { mission: MISSION, rows: [{ id: row, note }] }))
    if (nr.ok === true) acks.push({ agent, kind: "note", row, note })
  }

  // Contention on the shared document (runs alongside the two write streams).
  const contend = async () => {
    for (let r = 0; r < ROUNDS; r++) {
      const st = await call(s, "studio_document_status", { documentId: shared })
      const base = Number(st.revisionNo ?? st.currentRevisionNo ?? st.document?.currentRevisionNo)
      // (a) same chapter, same base: exactly one may be saved, never both.
      const [a1, a2] = await Promise.all([
        call(s, "studio_chapter_import_markdown", { documentId: shared, chapterKey: "1", baseRevisionNo: base, markdown: md("Bab satu", `r44shs${r}a`), submit: true, change: { what: "bab 1 swarm", why: "row 44", impact: "konflik" } }),
        call(c, "studio_chapter_import_markdown", { mission: MISSION_DOCS, docKey: "shared", adoptExisting: true, chapterKey: "1", baseRevisionNo: base, markdown: md("Bab satu", `r44shc${r}a`), submit: true, change: { what: "bab 1 claude", why: "row 44", impact: "konflik" } }),
      ])
      contention.push({ round: r, kind: "same-chapter", base, swarm: { code: codeOf(a1), revisionNo: a1.revisionNo }, claude: { code: codeOf(a2), revisionNo: a2.revisionNo, text: a2.ok === true ? undefined : String(a2._text).slice(0, 200) } })
      for (const [agent, res, marker] of [["swarm", a1, `r44shs${r}a`], ["claude", a2, `r44shc${r}a`]] as const) {
        if (res.ok === true) acks.push({ agent, kind: "submit", documentId: shared, revisionNo: Number(res.revisionNo), marker })
      }
      // (b) different chapters, same base: both saved (one rebased), both chapters in the latest revision.
      const st2 = await call(s, "studio_document_status", { documentId: shared })
      const base2 = Number(st2.revisionNo ?? st2.currentRevisionNo ?? st2.document?.currentRevisionNo)
      const [b1, b2] = await Promise.all([
        call(s, "studio_chapter_import_markdown", { documentId: shared, chapterKey: "2", baseRevisionNo: base2, markdown: md("Bab dua", `r44shs${r}d`), submit: true, change: { what: "bab 2 swarm", why: "row 44", impact: "paralel" } }),
        call(c, "studio_chapter_import_markdown", { mission: MISSION_DOCS, docKey: "shared", adoptExisting: true, chapterKey: "3", baseRevisionNo: base2, markdown: md("Bab tiga", `r44shc${r}d`), submit: true, change: { what: "bab 3 claude", why: "row 44", impact: "paralel" } }),
      ])
      contention.push({ round: r, kind: "different-chapters", base: base2, swarm: { code: codeOf(b1), revisionNo: b1.revisionNo, rebased: b1.rebased }, claude: { code: codeOf(b2), revisionNo: b2.revisionNo, rebased: b2.rebased, text: b2.ok === true ? undefined : String(b2._text).slice(0, 200) } })
      for (const [agent, res, marker] of [["swarm", b1, `r44shs${r}d`], ["claude", b2, `r44shc${r}d`]] as const) {
        if (res.ok === true) acks.push({ agent, kind: "submit", documentId: shared, revisionNo: Number(res.revisionNo), marker })
      }
      // (c) ownership (C58): Claude, without adoptExisting, on a Swarm document its session never adopted
      // -> DOCUMENT_OWNED_BY_OTHER, nothing written (checked in the store: `private` keeps 2 revisions).
      const [o1, o2] = await Promise.all([
        call(c, "studio_document_create", { template: "datum-gsp", mission: MISSION_DOCS, docKey: "private", title: "Row 44 private document" }),
        call(c, "studio_chapter_import_markdown", { mission: MISSION_DOCS, docKey: "private", chapterKey: "4", baseRevisionNo: 2, markdown: md("Bab empat", `r44pvc${r}x`), submit: true }),
      ])
      contention.push({ round: r, kind: "ownership", create: codeOf(o1), import: codeOf(o2) })
    }
  }

  const streamS = pool(Array.from({ length: DOCS }, (_, i) => i), POOL, (i) => chain("swarm", s, i))
  const streamC = pool(Array.from({ length: DOCS }, (_, i) => i), POOL, (i) => chain("claude", c, i))
  await Promise.all([streamS, streamC, contend(), Bun.sleep(300).then(() => onMidRun(() => acks.length))])
  return { acks, outcomes, contention, shared, privateDoc, ownedDocs }
}

// ── the checker: reads the SQLite file directly (host stopped) ──────────────────────────────────────────────────────
interface Check {
  violations: string[]
  counts: Record<string, number>
}

function verifyStore(store: string, run: RunResult): Check {
  const v: string[] = []
  const counts: Record<string, number> = {}
  // The host is stopped. Verify a byte copy (main file plus any -wal/-shm) in a scratch folder, never the store itself:
  // a read-only open of a WAL store without its -shm is SQLITE_CANTOPEN, and the FTS5 integrity-check needs a writable
  // handle.
  const scratch = path.join(path.dirname(store), `verify-${Date.now()}`)
  mkdirSync(scratch, { recursive: true })
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = path.join(store, `datum-studio.sqlite${suffix}`)
    if (existsSync(f)) copyFileSync(f, path.join(scratch, `datum-studio.sqlite${suffix}`))
  }
  const db = new Database(path.join(scratch, "datum-studio.sqlite"))
  const w = db
  try {
    // 1. every acknowledged create and submit is present, with its content
    for (const a of run.acks.filter((x) => x.kind === "create")) {
      const d = db.query("SELECT created_by FROM document WHERE id = ?").get(a.documentId!) as { created_by: string } | null
      if (!d) v.push(`create lost: ${a.agent} ${a.documentId}`)
      else if (d.created_by !== `agent:${a.agent}`) v.push(`create owner wrong: ${a.documentId} ${d.created_by}`)
    }
    for (const a of run.acks.filter((x) => x.kind === "submit")) {
      const rev = db.query("SELECT id FROM revision WHERE document_id = ? AND revision_no = ?").get(a.documentId!, a.revisionNo!) as { id: string } | null
      if (!rev) {
        v.push(`submit lost: ${a.agent} ${a.documentId} rev ${a.revisionNo}`)
        continue
      }
      const hit = db.query("SELECT count(*) AS n FROM doc_block WHERE revision_id = ? AND text_plain LIKE ?").get(rev.id, `% ${a.marker} %`) as { n: number }
      if (hit.n < 1) v.push(`submit content missing: ${a.agent} ${a.marker} not in ${a.documentId} rev ${a.revisionNo}`)
    }
    // 2. the latest revision of each own document holds every acknowledged chapter (no silent overwrite)
    for (const d of Object.values(run.ownedDocs)) {
      const cur = db.query("SELECT r.id FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no WHERE d.id = ?").get(d.documentId) as { id: string } | null
      for (const m of d.markers) {
        const n = cur ? (db.query("SELECT count(*) AS n FROM doc_block WHERE revision_id = ? AND text_plain LIKE ?").get(cur.id, `% ${m} %`) as { n: number }).n : 0
        if (n < 1) v.push(`latest revision of ${d.documentId} lost ${m}`)
      }
    }
    // shared document: the latest revision holds the last saved chapter 1 marker and every saved chapter 2/3 marker
    const sharedCur = db.query("SELECT r.id FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no WHERE d.id = ?").get(run.shared) as { id: string } | null
    const sharedText = sharedCur ? (db.query("SELECT group_concat(text_plain, ' ') AS t FROM doc_block WHERE revision_id = ?").get(sharedCur.id) as { t: string }).t : ""
    const ch23 = run.acks.filter((a) => a.documentId === run.shared && a.marker?.endsWith("d"))
    const last2 = ch23.filter((a) => a.marker!.startsWith("r44shs")).sort((p, q) => q.revisionNo! - p.revisionNo!)[0]
    const last3 = ch23.filter((a) => a.marker!.startsWith("r44shc")).sort((p, q) => q.revisionNo! - p.revisionNo!)[0]
    for (const a of [last2, last3]) if (a && !sharedText.includes(a.marker!)) v.push(`shared latest revision lost ${a.marker}`)
    const ch1 = run.acks.filter((a) => a.documentId === run.shared && /^r44sh[sc]\da$/.test(a.marker ?? "")).sort((p, q) => q.revisionNo! - p.revisionNo!)[0]
    if (ch1 && !sharedText.includes(ch1.marker!)) v.push(`shared latest revision lost chapter 1 ${ch1.marker}`)
    const pvRevs = (db.query("SELECT count(*) AS n FROM revision WHERE document_id = ?").get(run.privateDoc) as { n: number }).n
    const pvClaude = (db.query("SELECT count(*) AS n FROM revision WHERE document_id = ? AND created_by <> 'agent:swarm'").get(run.privateDoc) as { n: number }).n
    if (pvRevs !== 2 || pvClaude !== 0) v.push(`private document written by another agent: ${pvRevs} revisions, ${pvClaude} not by swarm`)
    counts.privateRevisions = pvRevs
    // 3. revision numbers dense per document, current = max, parents chained
    const docs = db.query("SELECT id, current_revision_no AS cur FROM document").all() as Array<{ id: string; cur: number }>
    let revisions = 0
    for (const d of docs) {
      const nos = (db.query("SELECT revision_no AS n FROM revision WHERE document_id = ? ORDER BY revision_no").all(d.id) as Array<{ n: number }>).map((r) => r.n)
      revisions += nos.length
      if (nos.length !== d.cur || nos.some((n, i) => n !== i + 1)) v.push(`revisions not dense: ${d.id} cur ${d.cur} has [${nos.join(",")}]`)
    }
    // 4. mission notes: last acknowledged note per row, one row-change event per acknowledged note
    for (const a of run.acks.filter((x) => x.kind === "note")) {
      const r = db.query("SELECT note FROM mission_row WHERE mission_id = ? AND row_id = ?").get(MISSION, a.row!) as { note: string | null } | null
      if (r?.note !== a.note) v.push(`note lost: row ${a.row} has ${JSON.stringify(r?.note)} expected ${JSON.stringify(a.note)}`)
    }
    const events = (db.query("SELECT count(*) AS n FROM mission_event WHERE mission_id = ? AND verb = 'row-change'").get(MISSION) as { n: number }).n
    const notes = run.acks.filter((x) => x.kind === "note").length
    if (events !== notes) v.push(`mission row-change events ${events} != acknowledged notes ${notes}`)
    // 5. integrity
    const integrity = (db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check)
    if (integrity.join(",") !== "ok") v.push(`integrity_check: ${integrity.join(" | ")}`)
    const fk = db.query("PRAGMA foreign_key_check").all()
    if (fk.length > 0) v.push(`foreign_key_check: ${JSON.stringify(fk.slice(0, 5))}`)
    counts.documents = docs.length
    counts.revisions = revisions
    counts.docBlocks = (db.query("SELECT count(*) AS n FROM doc_block").get() as { n: number }).n
    counts.missionRowChangeEvents = events
    try {
      w.exec("INSERT INTO doc_block_fts(doc_block_fts) VALUES('integrity-check')")
      counts.ftsIntegrity = 1
    } catch (e) {
      v.push(`fts integrity-check: ${String(e)}`)
    }
    // FTS hits = doc_block rows per acknowledged marker (all revisions)
    let ftsMarkers = 0
    for (const a of run.acks.filter((x) => x.marker)) {
      const fts = (w.query("SELECT count(*) AS n FROM doc_block_fts WHERE doc_block_fts MATCH ?").get(`"${a.marker}"`) as { n: number }).n
      const like = (w.query("SELECT count(*) AS n FROM doc_block WHERE text_plain LIKE ?").get(`% ${a.marker} %`) as { n: number }).n
      if (fts !== like || fts < 1) v.push(`fts mismatch for ${a.marker}: fts ${fts} doc_block ${like}`)
      else ftsMarkers++
    }
    counts.ftsMarkersConsistent = ftsMarkers
  } finally {
    db.close()
  }
  return { violations: v, counts }
}

function busyCodes(run: RunResult) {
  return run.outcomes.filter((o) => /BUSY|TX_TIMEOUT|database is locked/i.test(`${o.code} ${o.text ?? ""}`))
}

function storeLogBusy(store: string) {
  const dir = path.join(store, "logs")
  if (!existsSync(dir)) return 0
  let n = 0
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else n += readFileSync(p, "utf8").split("\n").filter((l) => /STORE_BUSY|database is locked|STORE_TX_TIMEOUT/.test(l)).length
    }
  }
  walk(dir)
  return n
}

/** One full run: host (optionally mutated), both clients, workload, second-host probe mid-run, stop, verify. */
async function scenario(name: string, mutation: string, yieldInside = false) {
  const e = await makeEnv(name)
  const host = await startHost(e, mutation, yieldInside)
  expect(host.line).toMatch(/^READY \d+ \d+ \{/)
  quote(`${name}: host runtime`, host.runtime)
  expect(host.runtime?.missionGuard).toBe(true)
  if (HOST_RUNTIME === "electron") expect(host.runtime).toMatchObject({ electron: "42.3.3", runAsNode: "1", bun: null, driver: "node:sqlite" })
  else expect(host.runtime).toMatchObject({ electron: null, driver: "bun:sqlite" })
  const s = await clientS(e)
  const cc = await clientC(e)
  const lockFile = path.join(e.store, "datum-studio.lock")
  const second: S = {}
  const t0 = Date.now()
  const run = await runWorkload(e, s, cc.client, async (acked) => {
    second.ackedAtStart = acked()
    // A second host on the same root while writes are in flight -> STORE_LOCKED; the live lock is untouched.
    const before = readFileSync(lockFile, "utf8")
    const h2 = await startHost(e)
    second.ackedAtRefusal = acked()
    const code = await h2.exited
    second.line = h2.line
    second.exit = code
    second.lockUnchanged = readFileSync(lockFile, "utf8") === before
    second.lockPid = JSON.parse(before).pid
    second.stale = readdirSync(e.store).filter((f) => f.includes(".stale-"))
  })
  const elapsedMs = Date.now() - t0
  await s.close().catch(() => undefined)
  await cc.client.close().catch(() => undefined)
  const stopCode = await stopHost(host)
  const check = verifyStore(e.store, run)
  const busy = busyCodes(run)
  const logBusy = storeLogBusy(e.store)
  const byAgent = (agent: Agent) => {
    const acks = run.acks.filter((a) => a.agent === agent && a.documentId !== run.shared)
    return { create: acks.filter((a) => a.kind === "create").length, submit: acks.filter((a) => a.kind === "submit").length, note: acks.filter((a) => a.kind === "note").length }
  }
  const failures = run.outcomes.filter((o) => o.code !== "OK")
  return { e, host, second, run, check, busy, logBusy, stopCode, elapsedMs, swarm: byAgent("swarm"), claude: byAgent("claude"), failures, bridgeErr: cc.stderr() }
}

function sameChapterRounds(run: RunResult) {
  return run.contention.filter((c) => c.kind === "same-chapter")
}

/** Every pass criterion of the main test as a list of broken ones (empty = pass); the mutation control needs it non-empty. */
function brokenInvariants(r: Awaited<ReturnType<typeof scenario>>): string[] {
  const out: string[] = []
  const want = { create: DOCS, submit: 2 * DOCS, note: DOCS }
  for (const [agent, got] of [["swarm", r.swarm], ["claude", r.claude]] as const) if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${agent} acknowledged ${JSON.stringify(got)} != ${JSON.stringify(want)}`)
  for (const f of r.failures) out.push(`write failed: ${f.agent} ${f.tool} ${f.label} ${f.code}`)
  for (const b of r.busy) out.push(`busy outcome: ${b.agent} ${b.tool} ${b.code}`)
  if (r.logBusy > 0) out.push(`store/API log lines with STORE_BUSY / database is locked / STORE_TX_TIMEOUT: ${r.logBusy}`)
  for (const c of sameChapterRounds(r.run)) {
    const codes = [c.swarm.code, c.claude.code].sort()
    if (JSON.stringify(codes) !== JSON.stringify(["OK", "SCOPE_CONFLICT"])) out.push(`same-chapter round ${c.round} (base ${c.base}): ${codes.join("+")}`)
  }
  for (const c of r.run.contention.filter((x) => x.kind === "different-chapters")) if (c.swarm.code !== "OK" || c.claude.code !== "OK") out.push(`different-chapters round ${c.round} (base ${c.base}): ${c.swarm.code}+${c.claude.code}`)
  for (const c of r.run.contention.filter((x) => x.kind === "ownership")) if (c.create !== "DOCUMENT_OWNED_BY_OTHER" || c.import !== "DOCUMENT_OWNED_BY_OTHER") out.push(`ownership round ${c.round}: ${c.create}+${c.import}`)
  out.push(...r.check.violations.map((x) => `store: ${x}`))
  return out
}

describe("row 44: two clients through one host", () => {
  test(
    "swarm (HTTP) and claude (stdio bridge) write at the same time: no lost write, dense revisions, integrity ok, zero STORE_BUSY; a second host is STORE_LOCKED",
    async () => {
      const mutation = process.env.ROW44_MUTATION ?? ""
      if (mutation) quote("MAIN RUN MUTATED", mutation)
      const r = await scenario("main", mutation)
      quote("acknowledged writes (own documents)", { swarm: r.swarm, claude: r.claude })
      quote("shared-document contention", r.run.contention)
      quote("non-OK outcomes of the write streams", r.failures.map((f) => `${f.agent} ${f.tool} ${f.label} ${f.code}`))
      quote("STORE_BUSY-like outcomes", r.busy.length)
      quote("store log lines with STORE_BUSY/locked/TX_TIMEOUT", r.logBusy)
      quote("store counts", r.check.counts)
      quote("violations", r.check.violations)
      quote("second host", r.second)
      quote("host stop exit", r.stopCode)
      quote("elapsed ms", r.elapsedMs)
      const broken = brokenInvariants(r)
      quote(`broken invariants (${broken.length})`, broken.slice(0, 20))
      if (r.failures.length > 0) quote("first failure texts", r.failures.slice(0, 3).map((f) => `${f.agent} ${f.tool} ${f.code}: ${String(f.text ?? "").slice(0, 240)}`))
      expect(broken).toEqual([])

      // second host: refused with STORE_LOCKED naming the live host, lock bytes unchanged, nothing renamed stale
      expect(String(r.second.line)).toStartWith("ERROR STORE_LOCKED ")
      expect(JSON.parse(String(r.second.line).replace(/^ERROR STORE_LOCKED /, "")).details.pid).toBe(r.host.pid)
      expect(r.second.exit).toBe(2)
      expect(r.second.lockPid).toBe(r.host.pid)
      expect(r.second.lockUnchanged).toBe(true)
      expect(r.second.stale).toEqual([])

      // every write of the two streams acknowledged (N each), none failed, none busy
      expect(r.failures).toEqual([])
      expect(r.swarm).toEqual({ create: DOCS, submit: 2 * DOCS, note: DOCS })
      expect(r.claude).toEqual({ create: DOCS, submit: 2 * DOCS, note: DOCS })
      expect(r.busy).toEqual([])
      expect(r.logBusy).toBe(0)

      // contention: same chapter -> exactly one saved and the other SCOPE_CONFLICT; different chapters -> both saved;
      // Claude without adoptExisting -> DOCUMENT_OWNED_BY_OTHER
      for (const c of sameChapterRounds(r.run)) {
        const codes = [c.swarm.code, c.claude.code].sort()
        expect(codes).toEqual(["OK", "SCOPE_CONFLICT"])
      }
      for (const c of r.run.contention.filter((x) => x.kind === "different-chapters")) expect([c.swarm.code, c.claude.code]).toEqual(["OK", "OK"])
      for (const c of r.run.contention.filter((x) => x.kind === "ownership")) expect([c.create, c.import]).toEqual(["DOCUMENT_OWNED_BY_OTHER", "DOCUMENT_OWNED_BY_OTHER"])

      // the store: every acknowledged write present, dense revisions, integrity and FTS consistent
      expect(r.check.violations).toEqual([])
      expect(r.check.counts.ftsIntegrity).toBe(1)
      expect(r.stopCode).toBe(0)
    },
    300_000,
  )

  test(
    "queue intact, every store job holds its transaction across a 5 ms event-loop turn: still no lost write and no STORE_BUSY",
    async () => {
      const r = await scenario("yield", "", true)
      expect(r.host.stderr()).toContain("YIELD: every job holds its transaction")
      const broken = brokenInvariants(r)
      quote("yield (queue intact): elapsed ms", r.elapsedMs)
      quote("yield (queue intact): acknowledged", { swarm: r.swarm, claude: r.claude })
      quote(`yield (queue intact): broken invariants (${broken.length})`, broken.slice(0, 20))
      expect(broken).toEqual([])
      expect(String(r.second.line)).toStartWith("ERROR STORE_LOCKED ")
    },
    300_000,
  )

  // Mutation controls: the same run against a host whose write queue is bypassed must break the pass criteria.
  // bypass-queue = production pragmas (BEGIN IMMEDIATE, busy_timeout 5000) without the queue; deferred-nobusy + turn =
  // the store spec §6.8 variant with every job held across an event-loop turn (fast: collisions fail at once).
  // The bypass-queue control takes ~85 s (each collision is a 5 s busy wait that blocks the host's event loop), so it
  // is opt-in (ROW44_SLOW_CONTROL=1); the fast control always runs. ROW44_MUTATION=bypass-queue on the main test is the
  // primary mutation evidence (implementation/23_studio_concurrency_test.md).
  for (const [kind, yieldInside] of [
    ["bypass-queue", false],
    ["deferred-nobusy", true],
  ] as const) {
    test.skipIf(kind === "bypass-queue" && process.env.ROW44_SLOW_CONTROL !== "1")(
      `mutation control: ${kind}${yieldInside ? " + 5 ms turn per job" : ""} breaks the pass criteria`,
      async () => {
        const r = await scenario(`mutation-${kind}${yieldInside ? "-yield" : ""}`, kind, yieldInside)
        const label = `mutation ${kind}${yieldInside ? "+yield" : ""}`
        expect(r.host.stderr()).toContain(`MUTATION ${kind}`)
        const broken = brokenInvariants(r)
        quote(`${label}: elapsed ms`, r.elapsedMs)
        quote(`${label}: acknowledged`, { swarm: r.swarm, claude: r.claude })
        quote(`${label}: broken invariants (${broken.length})`, broken.slice(0, 20))
        quote(`${label}: first failure texts`, r.failures.slice(0, 3).map((f) => `${f.agent} ${f.tool} ${f.code}: ${String(f.text ?? "").slice(0, 240)}`))
        quote(`${label}: host diagnostics`, r.host.stdout().split("\n").find((l) => l.startsWith("STOPPED")) ?? "none")
        expect(broken.length).toBeGreaterThan(0)
      },
      300_000,
    )
  }
})
