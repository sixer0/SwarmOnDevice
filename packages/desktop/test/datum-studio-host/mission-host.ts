// Row 127 fixture: the REAL Studio host server (packages/datum-studio/src/mcp-host, read-only here) started in the
// runner order of row 111 (openHostStore with missionGuard -> configureTemplateSource -> startStudioHostServer, default
// extensions = template + mission tools), in its own bun process so env and module caches never leak into other tests.
// Env (fixture paths only): MH_STORE, MH_HOME, MH_RES, MH_RELEASE. Prints `READY <url> <token>` (fixture token).
// globalThis.fetch is a trap: the host makes no outbound call (no model call, no network) - a call is logged as
// FETCH_CALLED on stderr and fails the test that reads it.
import { randomBytes } from "node:crypto"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..", "..", "datum-studio")
const VENDOR = path.join(PKG, "vendor")
const store = process.env.MH_STORE!
const release = process.env.MH_RELEASE!
process.env.STUDIO_WORKSPACE_ROOT = store
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

globalThis.fetch = (async (input: unknown) => {
  process.stderr.write(`FETCH_CALLED ${String(input).slice(0, 200)}\n`)
  throw new Error("mission-host fixture: the host must not call fetch")
}) as unknown as typeof fetch

const mod = await import(path.join(PKG, "src", "mcp-host", "index.ts"))
const token = randomBytes(32).toString("hex")
const handle = await mod.openHostStore(store, { release, logFile: path.join(store, "..", "store.jsonl"), missionGuard: true })
mod.configureTemplateSource({ templatesDir: path.join(PKG, "templates"), assetRepoRoot: VENDOR, release })
const server = await mod.startStudioHostServer({
  store: handle,
  token,
  hostname: "127.0.0.1",
  port: 0,
  log: (level: string, source: string, message: string, context?: Record<string, unknown>) => {
    if (level === "error") process.stderr.write(`HOST_ERROR ${source} ${message} ${JSON.stringify(context ?? {}).slice(0, 600)}\n`)
  },
  facts: { home: process.env.MH_HOME!, resourcesPath: process.env.MH_RES!, execPath: process.execPath },
})
process.stdout.write(`READY ${server.url} ${token}\n`)

const stop = async () => {
  await server.close()
  mod.configureTemplateSource(null)
  await mod.closeHostStore(handle)
  process.exit(0)
}
process.on("SIGTERM", () => void stop())
