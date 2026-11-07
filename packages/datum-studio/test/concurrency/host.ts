// Row 44 host process: ONE real Studio host (row 111 runner order: openHostStore -> configureTemplateSource ->
// startStudioHostServer with the default extensions) on a fixture store, announced with row 111's descriptor writer so
// that the real row 34 wrapper/launcher/bridge can reach it. Started as `<fx>/Fake.app/Contents/MacOS/Swarm host.ts`
// (a symlink to bun), so the store lock's PID and the descriptor's PID are a live `*/Contents/MacOS/Swarm` process,
// exactly what the lock liveness check (src/store/lock.ts defaultIsLiveHost) and the launcher's `ps` check accept.
//
// Env (fixture paths only): R44_PKG (packages/datum-studio), R44_STORE, R44_STATE, R44_HOME, R44_RES, R44_DESKTOP.
// R44_MUTATION (test-only, never set in a normal run):
//   bypass-queue    = the host write queue is removed: every store job runs at once on its OWN writer connection
//                     (BEGIN IMMEDIATE, busy_timeout 5000 as in production). Applied to this process's store
//                     INSTANCE only; no product file is edited.
//   deferred-nobusy = as above plus BEGIN DEFERRED and busy_timeout 0 (the variant named in store spec §6.8).
// R44_YIELD=1 (test-only amplifier, works with or without a mutation): every store job waits 5 ms on a timer after its
//   last statement and before COMMIT, i.e. it holds its transaction across an event-loop turn the way a job with real
//   async I/O would. With the queue intact the run must still pass; without it, jobs collide.
// Output on stdout, one line: `READY <port> <pid>` or `ERROR <code> <json details>` (then exit 2).
import { randomBytes } from "node:crypto"
import path from "node:path"

// Runtime neutral (bun from source, or Electron's Node with ELECTRON_RUN_AS_NODE=1 from a Bun.build bundle): no bun API,
// no import.meta.dir; the package path comes in through R44_PKG.
const PKG = process.env.R44_PKG!
const VENDOR = path.join(PKG, "vendor")
const STORE = process.env.R44_STORE!
process.env.STUDIO_WORKSPACE_ROOT = STORE
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

type Mod = typeof import("../../src/mcp-host/index.ts")
const mod: Mod = await import("../../src/mcp-host/index.ts")
const descriptorModule = path.join(process.env.R44_DESKTOP!, "src", "main", "datum-studio-host", "descriptor.ts")

let handle: Awaited<ReturnType<Mod["openHostStore"]>>
try {
  // Same options as the production runner (desktop src/main/datum-studio-host/host-runner.ts:43-49): missionGuard on.
  handle = await mod.openHostStore(STORE, { release: "1.2.0", logFile: path.join(STORE, "logs", "datum-studio-store.jsonl"), missionGuard: true })
} catch (e) {
  const err = e as { code?: string; details?: unknown; message?: string }
  process.stdout.write(`ERROR ${err.code ?? "UNKNOWN"} ${JSON.stringify({ details: err.details ?? null, message: err.message ?? String(e) })}\n`)
  process.exit(2)
}

const mutation = process.env.R44_MUTATION ?? ""
/** Mutation diagnostics: store jobs that began while another job was still open (impossible with the queue). */
const overlaps = { count: 0, maxJobMs: 0, pairs: {} as Record<string, number> }
const yieldInside = process.env.R44_YIELD === "1"
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
if (mutation === "bypass-queue" || mutation === "deferred-nobusy") await bypassWriteQueue(handle, mutation)
else if (yieldInside) {
  // Queue intact: wrap the real transaction() so each job's body ends with an event-loop turn inside the transaction.
  const s = handle as unknown as { transaction<T>(fn: (tx: unknown) => Promise<T>, opts?: unknown): Promise<T> }
  const real = s.transaction.bind(handle)
  s.transaction = <T>(fn: (tx: unknown) => Promise<T>, opts?: unknown) =>
    real(async (tx) => {
      const r = await fn(tx)
      await turn()
      return r
    }, opts)
  process.stderr.write("[row44] YIELD: every job holds its transaction across a 5 ms timer (queue intact)\n")
}

mod.configureTemplateSource({ templatesDir: path.join(PKG, "templates"), assetRepoRoot: VENDOR, release: "1.2.0" })
const token = randomBytes(32).toString("hex")
const hostLog: string[] = []
const server = await mod.startStudioHostServer({
  store: handle,
  token,
  hostname: "127.0.0.1",
  port: 0,
  log: (level, source, message, context) => {
    if (level !== "info") hostLog.push(JSON.stringify({ level, source, message, code: context?.code }))
  },
  facts: { home: process.env.R44_HOME!, resourcesPath: process.env.R44_RES!, execPath: process.execPath },
})
const { studioDescriptorPath, writeStudioDescriptor } = await import(descriptorModule)
await writeStudioDescriptor(studioDescriptorPath(process.env.R44_STATE!), { url: server.url, token, pid: process.pid })
// The token is never printed: the HTTP client reads it from the 0600 descriptor, like the bridge does.
const runtime = { missionGuard: (handle as unknown as { missionGuardEnabled?: boolean }).missionGuardEnabled ?? null, node: process.versions.node, electron: process.versions.electron ?? null, bun: (process.versions as Record<string, string>).bun ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, driver: (handle as unknown as { writer?: { driver?: string } }).writer?.driver ?? null }
process.stdout.write(`READY ${server.port} ${process.pid} ${JSON.stringify(runtime)}\n`)

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await server.close()
  mod.configureTemplateSource(null)
  await mod.closeHostStore(handle)
  process.stdout.write(`STOPPED ${JSON.stringify({ hostWarnings: hostLog.length, ...(mutation ? { overlaps } : {}) })}\n`)
  process.exit(0)
}
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()

/**
 * MUTATION (test-only): replace `transaction` on this store instance with a queue-free version. Each job opens its own
 * connection to the same file, so two jobs that overlap in time are two independent writers, which is what the host
 * write queue exists to prevent (store spec §6.3-§6.4).
 */
async function bypassWriteQueue(store: object, kind: string) {
  const { openSqlite } = await import("#sqlite")
  const { mapSqliteError, StoreError } = await import("../../src/store/errors.ts")
  const { newId } = await import("../../src/store/ids.ts")
  const { STORE_DB_FILE } = await import("../../src/store/paths.ts")
  const s = store as unknown as {
    rootDir: string
    txContext: { getStore(): unknown; run<T>(state: unknown, fn: () => T): T }
    makeTx(conn: unknown, state: { id: string; alive: boolean }): unknown
    transaction: unknown
  }
  const file = path.join(s.rootDir, STORE_DB_FILE)
  const open = new Map<string, string>()
  const callSite = (stack: string) =>
    stack
      .split("\n")
      .slice(2)
      .map((l) => l.trim())
      .find((l) => /src\/mcp-host\/local-api\/routes\/|services\//.test(l) && !/_swarm-store|store-bridge/.test(l))
      ?.replace(/^at /, "")
      .replace(/\(.*\/(packages\/datum-studio\/)/, "($1") ?? "unknown"
  const busy = kind === "deferred-nobusy" ? 0 : 5000
  const begin = kind === "deferred-nobusy" ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE"
  s.transaction = async function bypassed<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    if (s.txContext.getStore()) throw new StoreError("STORE_NESTED_TX", "transaction() called inside a transaction; pass the tx instead")
    const conn = openSqlite(file)
    conn.exec(`PRAGMA busy_timeout = ${busy}; PRAGMA foreign_keys = ON;`)
    const state = { id: newId(), alive: false }
    const site = callSite(new Error().stack ?? "")
    if (open.size > 0) {
      overlaps.count++
      const key = `${[...open.values()][0]} <- ${site}`
      overlaps.pairs[key] = (overlaps.pairs[key] ?? 0) + 1
    }
    open.set(state.id, site)
    const t0 = Date.now()
    try {
      conn.exec(begin)
      state.alive = true
      const result = await s.txContext.run(state, () => fn(s.makeTx(conn, state)))
      if (yieldInside) await turn()
      state.alive = false
      conn.exec("COMMIT")
      return result
    } catch (e) {
      state.alive = false
      try {
        conn.exec("ROLLBACK")
      } catch {
        // already rolled back
      }
      throw mapSqliteError(e)
    } finally {
      open.delete(state.id)
      const ms = Date.now() - t0
      if (ms > overlaps.maxJobMs) overlaps.maxJobMs = ms
      conn.close()
    }
  }
  process.stderr.write(`[row44] MUTATION ${kind}: store.transaction replaced on the instance (no queue, own connection per job, ${begin}, busy_timeout ${busy}${yieldInside ? ", 5 ms turn before COMMIT" : ""})\n`)
}
