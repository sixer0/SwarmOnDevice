// N13-342 (1.3.0 row 133, AC-S6c): the swarm-web proxy reports its build id in the MCP
// `initialize` answer instead of the literal "1.0.0". The id comes from the compile-time
// constant SWARM_PROXY_BUILD (N13-372) that packages/desktop/scripts/stage-setup.ts passes as
// `--define SWARM_PROXY_BUILD="<SwarmRelease>+<commit10>"`; a run without the define (dev,
// `bun run`, unit tests) reports "dev".
// Run TARGETED: cd packages/setup && bun test test/rel130-s6-proxy-version.test.ts

import { describe, it, expect, afterAll } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { handleRpc, type ProxyDeps, type RpcResponse } from "../src/mcpproxy/proxy.ts"

const PROXY_SRC = resolve(import.meta.dir, "..", "src", "mcpproxy", "proxy.ts")
// Synthetic build id in the shipped shape: release + "+" + 10 hex of the commit.
const BUILD_ID = "1.3.0+0a1b2c3d4e"
// `initialize` touches no dependency; an empty object keeps the test free of transports.
const NO_DEPS = {} as ProxyDeps

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function initialize(id: number) {
  return { jsonrpc: "2.0" as const, id, method: "initialize", params: { protocolVersion: "2024-11-05" } }
}

function serverVersion(res: RpcResponse | null): unknown {
  const result = (res as { result?: { serverInfo?: { name?: string; version?: unknown } } } | null)?.result
  return result?.serverInfo?.version
}

describe("N13-342 swarm-web proxy initialize version (AC-S6c)", () => {
  it("a run without the build define reports dev, never 1.0.0", async () => {
    const version = serverVersion(await handleRpc(initialize(1), NO_DEPS))
    expect(version).toBe("dev")
    expect(version).not.toBe("1.0.0")
  })

  it("a build with --define SWARM_PROXY_BUILD reports exactly the injected build id", async () => {
    const out = mkdtempSync(join(tmpdir(), "rel130-s6c-"))
    dirs.push(out)
    // Same mechanism as the stage-setup compile: a quoted JSON string literal for the define.
    const built = await Bun.build({
      entrypoints: [PROXY_SRC],
      outdir: out,
      target: "bun",
      define: { SWARM_PROXY_BUILD: JSON.stringify(BUILD_ID) },
    })
    expect(built.success).toBe(true)
    const file = built.outputs[0]!.path
    // The constant is inlined at compile time: no runtime lookup of the name is left.
    expect(readFileSync(file, "utf8")).not.toContain("SWARM_PROXY_BUILD")
    const mod = (await import(pathToFileURL(file).href)) as { handleRpc: typeof handleRpc }
    const version = serverVersion(await mod.handleRpc(initialize(2), NO_DEPS))
    expect(version).toBe(BUILD_ID)
    expect(version).not.toBe("1.0.0")
  })
})
