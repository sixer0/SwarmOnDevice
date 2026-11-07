// Row 34: ~/.local/bin/datum-studio -> <Res>/datum-studio/datum-studio-launcher -> datum-studio-bridge.js, end to end
// (Studio spec §9.1-§9.5). Fixture HOME, fixture Resources, fixture state home; the real ~/.local/bin, ~/.claude and
// app state are never used. Needs local listen + /bin/ps, so it runs outside the agent sandbox.
// The bridge is bundled exactly as row 36 will (`bun build --target=bun`) and runs on a stand-in for
// <Res>/swarm-cli/swarm that refuses to run without BUN_BE_BUN=1; a second case uses the repo's staged swarm binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { datumStudioLauncherPath, installDatumStudioWrapper } from "../../src/main/cli-install"
import { studioDescriptorPath, writeStudioDescriptor } from "../../src/main/datum-studio-host/descriptor"
import { appServerFilePath, writeAppServerFile } from "../../src/main/app-server-file"

const DESKTOP = join(import.meta.dir, "..", "..")
const MESSAGE =
  "DATUM Studio runs inside the Swarm app. Start Swarm, then reconnect this MCP server (Claude Code: /mcp)."
const STAGED_SWARM = join(DESKTOP, "resources", "swarm-cli", "swarm")
const FX = realpathSync(mkdtempSync(join(tmpdir(), "row34-launcher-")))
const HOME = join(FX, "home")
const STATE = join(FX, "state")
const PROJECT = join(HOME, "project")
const FAKE_SWARM = join(FX, "Fake.app", "Contents", "MacOS", "Swarm")
const BUN = realpathSync(process.execPath)
const PROXY = "http://127.0.0.1:9"
let wrapper = ""
const hosts: ChildProcessWithoutNullStreams[] = []

// <fx>/<name>/Contents/Resources with the launcher, the bundled bridge and a swarm-cli/swarm runtime.
async function resources(name: string, runtime: "shim" | "staged" | "none") {
  const res = join(FX, name, "Contents", "Resources")
  mkdirSync(join(res, "datum-studio", "server"), { recursive: true })
  mkdirSync(join(res, "swarm-cli"), { recursive: true })
  const launcher = datumStudioLauncherPath(res)
  copyFileSync(join(DESKTOP, "scripts", "datum-studio-launcher.sh"), launcher)
  chmodSync(launcher, 0o755)
  const built = await Bun.build({ entrypoints: [join(DESKTOP, "scripts", "datum-studio-bridge.ts")], target: "bun" })
  if (!built.success) throw new Error(built.logs.join("\n"))
  writeFileSync(join(res, "datum-studio", "server", "datum-studio-bridge.js"), await built.outputs[0].text())
  const swarm = join(res, "swarm-cli", "swarm")
  if (runtime === "shim") {
    writeFileSync(swarm, `#!/bin/sh\n[ "$BUN_BE_BUN" = 1 ] || { echo "BUN_BE_BUN missing" >&2; exit 97; }\nexec '${BUN}' "$@"\n`)
    chmodSync(swarm, 0o755)
  }
  if (runtime === "staged") symlinkSync(STAGED_SWARM, swarm)
  return { res, launcher }
}

const env = () => ({
  HOME,
  PATH: "/usr/bin:/bin",
  TMPDIR: join(FX, "tmp"),
  HTTP_PROXY: PROXY,
  HTTPS_PROXY: PROXY,
  ALL_PROXY: PROXY,
  NO_PROXY: "127.0.0.1,localhost",
})

async function startHost(script: string, extra: Record<string, string>) {
  const record = join(FX, `record-${hosts.length}.jsonl`)
  writeFileSync(record, "")
  const child = spawn(FAKE_SWARM, [join(import.meta.dir, script)], {
    cwd: DESKTOP,
    env: { ...env(), FAKE_STATE: STATE, FAKE_RECORD: record, ...extra },
  })
  hosts.push(child)
  let err = ""
  child.stderr.on("data", (c: Buffer) => (err += c.toString()))
  const line = await new Promise<string>((resolve, reject) => {
    let out = ""
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString()
      const at = out.indexOf("\n")
      if (at >= 0) resolve(out.slice(0, at))
    })
    child.on("exit", (code) => reject(new Error(`host exited ${code}: ${err}`)))
  })
  const [, port, token, written] = line.split(" ")
  const records = () =>
    readFileSync(record, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  return { child, port: Number(port), token, written, records }
}

function client(file = wrapper, extra: Record<string, string> = {}, args: string[] = []) {
  const child = spawn(file, args, { cwd: PROJECT, env: { ...env(), ...extra } })
  let stdout = ""
  let stderr = ""
  const waiters = new Map<number, (m: Record<string, unknown>) => void>()
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString()
    for (const line of stdout.split("\n").slice(0, -1)) {
      const m = JSON.parse(line) as Record<string, unknown>
      waiters.get(m.id as number)?.(m)
    }
  })
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()))
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
  return {
    child,
    exited,
    out: () => stdout,
    err: () => stderr,
    send: (m: Record<string, unknown>) => child.stdin.write(JSON.stringify(m) + "\n"),
    request(id: number, method: string, params: Record<string, unknown> = {}) {
      const answer = new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve))
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
      return answer
    },
  }
}

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "row34", version: "0" } }

async function listTools(c: ReturnType<typeof client>) {
  const init = await c.request(1, "initialize", INIT)
  expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("datum-studio")
  c.send({ jsonrpc: "2.0", method: "notifications/initialized" })
  const list = await c.request(2, "tools/list")
  return ((list.result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name)
}

// Codes of the bridge's structured stderr records (the plain message line is skipped).
function codes(stderr: string) {
  return stderr
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l).code as string)
}

function noSecret(token: string, ...texts: string[]) {
  for (const text of texts) expect(text.includes(token)).toBe(false)
}

beforeAll(async () => {
  for (const d of [HOME, STATE, PROJECT, join(FX, "tmp"), join(FX, "Fake.app", "Contents", "MacOS")]) mkdirSync(d, { recursive: true })
  symlinkSync(BUN, FAKE_SWARM)
  const { launcher } = await resources("Swarm.app", "shim")
  wrapper = await installDatumStudioWrapper({ launcher, stateHome: STATE, binDir: join(HOME, ".local", "bin") })
})

afterAll(() => {
  for (const h of hosts) h.kill("SIGKILL")
  if (!process.env.ROW34_KEEP_FIXTURE) rmSync(FX, { recursive: true, force: true })
})

describe("datum-studio wrapper + launcher + bridge", () => {
  test("the wrapper is the only file written under the fixture HOME, and no .claude", () => {
    expect(wrapper).toBe(join(HOME, ".local", "bin", "datum-studio"))
    expect(readdirSync(join(HOME, ".local", "bin"))).toEqual(["datum-studio"])
    expect(statSync(wrapper).mode & 0o777).toBe(0o755)
    expect(existsSync(join(HOME, ".claude"))).toBe(false)
  })

  test("without the host it exits 3 with the start-Swarm message", async () => {
    rmSync(studioDescriptorPath(STATE), { force: true })
    const c = client()
    expect(await c.exited).toBe(3)
    expect(c.err()).toBe(MESSAGE + "\n")
    expect(c.out()).toBe("")
  })

  test("a descriptor whose PID is not a running Swarm counts as no host (exit 3)", async () => {
    await writeStudioDescriptor(studioDescriptorPath(STATE), { url: "http://127.0.0.1:9/mcp", token: "f".repeat(64), pid: process.pid })
    const c = client()
    expect(await c.exited).toBe(3)
    expect(c.err()).toBe(MESSAGE + "\n")
    rmSync(studioDescriptorPath(STATE), { force: true })
  })

  test("with the host it lists the tools over stdio; token only in the Authorization header", async () => {
    const host = await startHost("fake-host.ts", {})
    const c = client()
    expect(await listTools(c)).toEqual(["studio_registry", "studio_templates_list", "studio_document_create"])
    // Wait for the standalone GET stream, then end the session from the client side.
    for (let i = 0; i < 50 && !host.records().some((r) => r.method === "GET"); i++) await Bun.sleep(20)
    c.child.stdin.end()
    expect(await c.exited).toBe(0)
    for (const line of c.out().split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow()
    noSecret(host.token, c.out(), c.err(), readFileSync(wrapper, "utf8"))
    const records = host.records()
    expect(records[0].rpc).toBe("initialize")
    expect(new Set(records.map((r) => r.rpc ?? r.method))).toEqual(
      new Set(["initialize", "notifications/initialized", "tools/list", "GET", "DELETE"]),
    )
    for (const r of records) {
      expect(r.status).toBe(0)
      expect(r.agent).toBe("claude")
      expect(r.cwd).toBe(PROJECT)
      expect(r.proxyHop).toBe(false)
    }
    expect(records.find((r) => r.rpc === "tools/list")!.protocol).toBe("2025-06-18")
    expect(records.some((r) => r.method === "DELETE")).toBe(true)
    // stderr carries only structured records (no message, no token) on a clean run.
    for (const line of c.err().split("\n").filter(Boolean)) expect(JSON.parse(line).source).toBe("datum-studio-bridge")
    host.child.kill("SIGTERM")
  })

  test("a proxy in the caller's environment (no NO_PROXY) is never used for the loopback endpoint", async () => {
    const host = await startHost("fake-host.ts", {})
    const c = client(wrapper, { NO_PROXY: "", no_proxy: "", http_proxy: PROXY })
    expect(await listTools(c)).toContain("studio_registry")
    c.child.stdin.end()
    expect(await c.exited).toBe(0)
    for (const r of host.records()) expect(r.proxyHop).toBe(false)
    host.child.kill("SIGTERM")
  })

  test("Swarm quitting mid-session ends the bridge with exit 3 and the message", async () => {
    const host = await startHost("fake-host.ts", {})
    const c = client()
    await listTools(c)
    for (let i = 0; i < 50 && !host.records().some((r) => r.method === "GET"); i++) await Bun.sleep(20)
    host.child.kill("SIGKILL")
    expect(await c.exited).toBe(3)
    expect(c.err().split("\n")).toContain(MESSAGE)
    noSecret(host.token, c.out(), c.err())
  })

  test("a token the host rejects (Swarm restarted) exits 3; neither token is printed", async () => {
    const host = await startHost("fake-host.ts", { FAKE_MODE: "wrong-token" })
    const c = client()
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT })
    expect(await c.exited).toBe(3)
    expect(c.err().split("\n")).toContain(MESSAGE)
    expect(codes(c.err())).toContain("TOKEN_REJECTED")
    expect(host.records().map((r) => r.status)).toEqual([401])
    noSecret(host.token, c.out(), c.err())
    noSecret(host.written, c.out(), c.err())
    host.child.kill("SIGTERM")
  })

  test("a descriptor others can read is refused before anything is sent", async () => {
    const host = await startHost("fake-host.ts", { FAKE_MODE: "unsafe-mode" })
    const c = client()
    expect(await c.exited).toBe(3)
    expect(c.err().split("\n")).toContain(MESSAGE)
    expect(codes(c.err())).toContain("DESCRIPTOR_UNSAFE")
    expect(host.records()).toEqual([])
    host.child.kill("SIGTERM")
  })

  test("an incomplete bundle (no bridge) exits 4", async () => {
    const { launcher } = await resources("Broken.app", "shim")
    rmSync(join(launcher, "..", "server", "datum-studio-bridge.js"))
    const c = client(launcher)
    expect(await c.exited).toBe(4)
    expect(c.err()).toBe("DATUM Studio is not bundled with this app. Reinstall Swarm.\n")
  })

  test("the real row 31 server behind the wrapper: all host tools listed, token only in the descriptor", async () => {
    const store = join(FX, "store", "datum-studio")
    mkdirSync(join(FX, "store"), { recursive: true })
    const host = await startHost("real-host.ts", {
      REAL_STATE: STATE,
      REAL_STORE: store,
      REAL_HOME: HOME,
      REAL_RES: join(FX, "Swarm.app", "Contents", "Resources"),
    })
    const c = client()
    const names = await listTools(c)
    expect(names.length).toBeGreaterThanOrEqual(18)
    expect(names).toContain("studio_registry")
    expect(names).toContain("studio_document_create")
    c.child.stdin.end()
    expect(await c.exited).toBe(0)
    noSecret(host.token, c.out(), c.err())
    // Every file of the fixture tree except the descriptor is free of the token (store logs included).
    const holders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name)
        if (name.isDirectory()) walk(p)
        else if (name.isFile() && statSync(p).size < 50_000_000 && readFileSync(p).includes(host.token)) holders.push(p)
      }
    }
    walk(FX)
    expect(holders).toEqual([studioDescriptorPath(STATE)])
    console.log(`row34 real host tools (${names.length}): ${names.join(",")}`)
    host.child.kill("SIGTERM")
  }, 60_000)

  // A real MCP SDK stdio client (the kind Claude Code is) against the wrapper. The desktop package has no SDK, so it is
  // loaded from packages/datum-studio when that package is installed.
  const SDK = join(DESKTOP, "..", "datum-studio", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm")
  test.skipIf(!existsSync(SDK))("an MCP SDK stdio client lists the tools through the wrapper", async () => {
    const host = await startHost("fake-host.ts", {})
    const { Client } = await import(join(SDK, "client", "index.js"))
    const { StdioClientTransport } = await import(join(SDK, "client", "stdio.js"))
    const transport = new StdioClientTransport({ command: wrapper, args: [], cwd: PROJECT, env: env(), stderr: "pipe" })
    const sdk = new Client({ name: "row34-sdk", version: "0" })
    await sdk.connect(transport)
    const { tools } = await sdk.listTools()
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["studio_registry", "studio_templates_list", "studio_document_create"])
    expect(sdk.getServerVersion()?.name).toBe("datum-studio")
    await sdk.close()
    expect(host.records()[0].agent).toBe("claude")
    host.child.kill("SIGTERM")
  }, 30_000)

  test.skipIf(!existsSync(STAGED_SWARM))("on the repo's staged swarm-cli/swarm (BUN_BE_BUN=1) it lists the tools", async () => {
    const { launcher } = await resources("Staged.app", "staged")
    const host = await startHost("fake-host.ts", {})
    const c = client(launcher, { XDG_STATE_HOME: STATE, STUDIO_AGENT_ID: "swarm" })
    expect(await listTools(c)).toEqual(["studio_registry", "studio_templates_list", "studio_document_create"])
    c.child.stdin.end()
    expect(await c.exited).toBe(0)
    host.child.kill("SIGTERM")
  }, 30_000)
})

// Row 34b (C64): Swarm is running but its Studio host has not written datum-studio.env yet (row 33's open item: the
// sidecar starts the built-in entry while the app is still starting). The launcher waits for the descriptor, about
// 15 s at most, only while there is evidence Swarm is alive: the app-server.env PID of the same state directory, or a
// running Swarm among its nearest ancestors. Otherwise it exits 3 at once, as before.
describe("datum-studio launcher: bounded wait for the descriptor (row 34b)", () => {
  const PASSWORD = "p".repeat(40)
  const clean = () => {
    rmSync(studioDescriptorPath(STATE), { force: true })
    rmSync(appServerFilePath(STATE), { force: true })
  }
  const appServer = (pid: number) =>
    writeAppServerFile(appServerFilePath(STATE), { url: "http://127.0.0.1:9", username: "opencode", password: PASSWORD, pid })

  test("descriptor written 1 s after start while the app-server.env Swarm PID is alive: tools listed", async () => {
    clean()
    const host = await startHost("fake-host.ts", { FAKE_DESCRIPTOR_DELAY_MS: "1000" })
    await appServer(host.child.pid!)
    expect(existsSync(studioDescriptorPath(STATE))).toBe(false)
    const started = Date.now()
    const c = client()
    expect(await listTools(c)).toEqual(["studio_registry", "studio_templates_list", "studio_document_create"])
    const waited = Date.now() - started
    c.child.stdin.end()
    expect(await c.exited).toBe(0)
    expect(waited).toBeGreaterThanOrEqual(900)
    expect(waited).toBeLessThan(5_000)
    noSecret(host.token, c.out(), c.err())
    noSecret(PASSWORD, c.out(), c.err())
    console.log(`row34b late descriptor (app-server.env): tools after ${waited} ms`)
    host.child.kill("SIGTERM")
    clean()
  }, 30_000)

  test("started by a running Swarm (sidecar case, no app-server.env yet), descriptor after 1 s: tools listed", async () => {
    clean()
    const host = await startHost("fake-host.ts", { FAKE_DESCRIPTOR_DELAY_MS: "1000" })
    const started = Date.now()
    const c = client(FAKE_SWARM, { UNDER_CMD: wrapper }, [join(import.meta.dir, "under-swarm.ts")])
    expect(await listTools(c)).toEqual(["studio_registry", "studio_templates_list", "studio_document_create"])
    const waited = Date.now() - started
    c.child.stdin.end()
    expect(await c.exited).toBe(0)
    expect(waited).toBeGreaterThanOrEqual(900)
    expect(existsSync(appServerFilePath(STATE))).toBe(false)
    noSecret(host.token, c.out(), c.err())
    console.log(`row34b late descriptor (Swarm parent): tools after ${waited} ms`)
    host.child.kill("SIGTERM")
    clean()
  }, 30_000)

  test("Swarm not running (no descriptor; app-server.env PID not a Swarm): exit 3 within 1 s", async () => {
    clean()
    const plain = client()
    const t0 = Date.now()
    expect(await plain.exited).toBe(3)
    const first = Date.now() - t0
    expect(plain.err()).toBe(MESSAGE + "\n")
    // A stale app-server.env (this test runner's PID is a running process, but not a Swarm app) gives no reason to wait.
    await appServer(process.pid)
    const stale = client()
    const t1 = Date.now()
    expect(await stale.exited).toBe(3)
    const second = Date.now() - t1
    expect(stale.err()).toBe(MESSAGE + "\n")
    noSecret(PASSWORD, stale.out(), stale.err())
    expect(first).toBeLessThan(1_000)
    expect(second).toBeLessThan(1_000)
    console.log(`row34b not running: exit 3 after ${first} ms / ${second} ms (stale app-server.env)`)
    clean()
  })

  test("Swarm quits while the launcher waits: exit 3 at the next poll", async () => {
    clean()
    const host = await startHost("fake-host.ts", { FAKE_MODE: "never-ready" })
    await appServer(host.child.pid!)
    const c = client()
    await Bun.sleep(1_000)
    expect(c.child.exitCode).toBe(null)
    const killed = Date.now()
    host.child.kill("SIGKILL")
    expect(await c.exited).toBe(3)
    const after = Date.now() - killed
    expect(after).toBeLessThan(1_500)
    expect(c.err()).toBe(MESSAGE + "\n")
    console.log(`row34b Swarm quit during wait: exit 3 ${after} ms after the kill`)
    clean()
  }, 30_000)

  test("descriptor never written while Swarm stays alive: exit 3 after the ~15 s bound; no token or password printed", async () => {
    clean()
    const host = await startHost("fake-host.ts", { FAKE_MODE: "never-ready" })
    await appServer(host.child.pid!)
    const started = Date.now()
    const c = client()
    expect(await c.exited).toBe(3)
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(14_000)
    expect(waited).toBeLessThan(16_000)
    expect(c.err()).toBe(MESSAGE + "\n")
    expect(c.out()).toBe("")
    expect(host.records()).toEqual([])
    noSecret(host.token, c.out(), c.err())
    noSecret(PASSWORD, c.out(), c.err())
    console.log(`row34b never ready: exit 3 after ${waited} ms`)
    host.child.kill("SIGTERM")
    clean()
  }, 40_000)
})
