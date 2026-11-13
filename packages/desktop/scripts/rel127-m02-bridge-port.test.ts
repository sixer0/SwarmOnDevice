// Swarm 1.2.7 row 41b, AC-M02 (register N7-113, path K7-23): the DATUM Studio bridge refuses a descriptor whose port is
// invalid (empty, below ENDPOINT_PORT_MIN 1024, above 65535) with DESCRIPTOR_INVALID before it tries to connect, and a
// HOST_UNREACHABLE error names the endpoint port (N7-062), never the token.
// Built from $T/test/probes/desktop/probe9_m02_bridge.test.ts. Inputs are synthetic: a descriptor written in a mkdtemp
// state dir (mode 0600) with a fixed synthetic token. Needs loopback listen (sandbox off).
// Run: cd packages/desktop && bun test ./scripts/rel127-m02-bridge-port.test.ts
import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BRIDGE = join(import.meta.dir, "datum-studio-bridge.ts")
const FX = realpathSync(mkdtempSync(join(tmpdir(), "m02p-")))
afterAll(() => rmSync(FX, { recursive: true, force: true }))
const TOKEN = "f".repeat(64)

type Run = { code: number | null; stderr: string }

function runBridge(url: string): Promise<Run> {
  const state = join(FX, `st-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(state, "swarm"), { recursive: true, mode: 0o700 })
  const file = join(state, "swarm", "datum-studio.env")
  writeFileSync(file, `URL=${url}\nTOKEN=${TOKEN}\nPID=${process.pid}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], {
      cwd: FX,
      env: { PATH: process.env.PATH ?? "", HOME: FX, DATUM_STUDIO_STATE: state, DATUM_STUDIO_CALLER_CWD: FX, STUDIO_AGENT_ID: "rel127" },
    })
    let stderr = ""
    child.stdout.on("data", () => undefined)
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()))
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
    child.stdin.on("error", () => undefined)
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rel127", version: "0" } },
      }) + "\n",
    )
  })
}

const records = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter(Boolean) as Record<string, unknown>[]

/** A loopback port >= 1024 that nothing listens on: listen on port 0, read the port, close. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

describe("M-02 descriptor with an invalid port", () => {
  for (const port of [0, 1, 1023, 65536]) {
    test(`port ${port}: exit 3, DESCRIPTOR_INVALID naming an invalid port, never tried`, async () => {
      const r = await runBridge(`http://127.0.0.1:${port}/mcp`)
      const recs = records(r.stderr)
      const codes = recs.map((x) => String(x.code))
      const fatal = recs.find((x) => x.level === "error")
      expect(r.code).toBe(3)
      expect(fatal?.code).toBe("DESCRIPTOR_INVALID")
      expect(String(fatal?.message)).toBe("the DATUM Studio descriptor names an invalid port")
      expect(codes).not.toContain("HOST_UNREACHABLE")
      expect(codes).not.toContain("BRIDGE_START")
      expect(r.stderr).not.toContain(TOKEN)
    }, 30_000)
  }
})

describe("M-02 HOST_UNREACHABLE names the endpoint", () => {
  test("a free port >= 1024: HOST_UNREACHABLE context carries that port, never the token", async () => {
    const port = await freePort()
    expect(port).toBeGreaterThanOrEqual(1024)
    const r = await runBridge(`http://127.0.0.1:${port}/mcp`)
    const fatal = records(r.stderr).find((x) => x.level === "error")
    expect(r.code).toBe(3)
    expect(fatal?.code).toBe("HOST_UNREACHABLE")
    const context = (fatal?.context ?? {}) as Record<string, unknown>
    expect(context.port).toBe(String(port))
    expect(typeof context.error).toBe("string")
    expect(r.stderr).not.toContain(TOKEN)
  }, 30_000)
})
