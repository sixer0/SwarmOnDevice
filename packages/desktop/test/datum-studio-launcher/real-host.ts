// Row 34 host fixture over the REAL Studio server of row 31 (packages/datum-studio/src/mcp-host, read-only here),
// started in the runner order of row 111 (openHostStore -> configureTemplateSource -> startStudioHostServer) and
// announced with row 111's descriptor writer. Started through `<fixture>/Fake.app/Contents/MacOS/Swarm` like
// fake-host.ts. Env: REAL_STATE, REAL_STORE, REAL_HOME, REAL_RES (fixture paths only).
import { randomBytes } from "node:crypto"
import path from "node:path"
import { studioDescriptorPath, writeStudioDescriptor } from "../../src/main/datum-studio-host/descriptor"

const PKG = path.resolve(import.meta.dir, "..", "..", "..", "datum-studio")
const VENDOR = path.join(PKG, "vendor")
const store = process.env.REAL_STORE!
process.env.STUDIO_WORKSPACE_ROOT = store
process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
process.env.STUDIO_VENDOR_ROOT = VENDOR
delete process.env.STUDIO_MCP_FILE_ROOTS
delete process.env.INTERNAL_API_SECRET

const mod = await import(path.join(PKG, "src", "mcp-host", "index.ts"))
const token = randomBytes(32).toString("hex")
const handle = await mod.openHostStore(store, { release: "1.2.0", logFile: path.join(store, "..", "store.jsonl") })
mod.configureTemplateSource({ templatesDir: path.join(PKG, "templates"), assetRepoRoot: VENDOR, release: "1.2.0" })
const server = await mod.startStudioHostServer({
  store: handle,
  token,
  hostname: "127.0.0.1",
  port: 0,
  log: () => undefined,
  facts: { home: process.env.REAL_HOME!, resourcesPath: process.env.REAL_RES!, execPath: process.execPath },
})
await writeStudioDescriptor(studioDescriptorPath(process.env.REAL_STATE!), { url: server.url, token, pid: process.pid })
process.stdout.write(`READY ${server.port} ${token} ${token}\n`)

const stop = async () => {
  await server.close()
  mod.configureTemplateSource(null)
  await mod.closeHostStore(handle)
  process.exit(0)
}
process.on("SIGTERM", () => void stop())
