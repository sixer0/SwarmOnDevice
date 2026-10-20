// Row-94 unit tests — wiring hooks for rows 96/97/98 + the shipped researcher definition.
// THIN invocation contract: entries are composed from the steps' exported resolvers (r88
// graftLaunch/graftChildEnv, r89 rtkBin); NO init subcommand is reachable from this module
// (P-10/P-11), NO config file is written here (P-15 gate belongs to row 97).
// Run TARGETED: cd packages/setup && bun test test/mcp_wiring.test.ts

import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  swarmWebMcpEntry,
  graftMcpEntry,
  rtkToolPath,
  mcpPermissionGates,
  researcherDefinition,
  validateResearcherDefinition,
} from "../src/mcpproxy/wiring.ts"

describe("swarmWebMcpEntry (§6.1 shape)", () => {
  it("absolute PC-PATH-14 command array, enabled, timeout 30000 ms, no secret env", () => {
    const entry = swarmWebMcpEntry()
    expect(entry.type).toBe("local")
    expect(entry.command.length).toBe(1)
    expect(entry.command[0]?.startsWith("/")).toBe(true) // absolute — connectLocal consumes the array
    expect(entry.command[0]?.endsWith("/.swarm/setup/bin/swarm-web-proxy")).toBe(true) // PC-PATH-14 verbatim
    expect(entry.enabled).toBe(true)
    expect(entry.timeout).toBe(30000)
    expect(entry.env === undefined).toBe(true) // SWARM_* inherit from the parent env at spawn; nothing in the file
  })
  it("explicit binaryPath override lands verbatim in command[0]", () => {
    expect(swarmWebMcpEntry("/opt/custom/swarm-web-proxy").command[0]).toBe("/opt/custom/swarm-web-proxy")
  })
})

describe("graftMcpEntry (PC-MCP-01 via r88 resolvers; init unreachable)", () => {
  const okLaunch = () => ({
    ok: true as const,
    nodePath: "/home/u/.swarm/tools/node/24.10.0/bin/node",
    cliPath: "/home/u/.swarm/tools/graft/0.18.0/node_modules/@nanonets/graft/dist/cli.js",
  })

  it("success shape: [privateNode, privateCli, 'mcp'] with DO_NOT_TRACK=1", () => {
    const res = graftMcpEntry({ launch: okLaunch, env: {} })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entry.command).toEqual([okLaunch().nodePath, okLaunch().cliPath, "mcp"])
    expect(res.entry.env).toEqual({ DO_NOT_TRACK: "1" })
    expect(res.entry.command.some((a) => a.includes("init"))).toBe(false) // P-10 structural
    expect(res.entry.command.slice(0, 2).every((a) => a.startsWith("/"))).toBe(true) // binaries absolute, no PATH consult; argv[2] is the subcommand word
  })

  it("resolver failure propagates the reason, never a fallback", () => {
    const res = graftMcpEntry({ launch: () => ({ ok: false, reason: "private graft CLI is not installed" }), env: {} })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toContain("not installed")
  })

  it("must-be-unset env (GRAFT_PROVIDER/GRAFT_API_KEY) refuses the entry outright (01c0:194-198)", () => {
    for (const key of ["GRAFT_PROVIDER", "GRAFT_API_KEY"]) {
      const res = graftMcpEntry({ launch: okLaunch, env: { [key]: "leaked-value" } })
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toContain(key)
    }
  })
})

describe("rtkToolPath (r89 resolver, facts only)", () => {
  it("empty install root reports not-installed with a reason — no spawn, no PATH consult", () => {
    const dir = mkdtempSync(join(tmpdir(), "r94-rtk-"))
    try {
      const res = rtkToolPath({
        lock: { version: "x", components: { rtk: { version: "0.0.1" } } } as never,
        installRoot: dir,
      })
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toContain(join(dir, "0.0.1", "rtk")) // exact private path named
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("mcpPermissionGates (§4.2 tail rules, normative order)", () => {
  it("graft_* then swarm-web_*, both ask — appended AFTER the catch-all by row 96", () => {
    expect(mcpPermissionGates()).toEqual([
      ["graft_*", "ask"],
      ["swarm-web_*", "ask"],
    ])
  })
})

describe("researcher definition (§5.1 as shipped)", () => {
  it("ships the exact deny-all + three proxy grants + explicit task/todowrite denies, valid by T-W7-6 shape", () => {
    expect(researcherDefinition).toEqual({
      agent: {
        researcher: {
          description:
            "Fetches and summarises public web content through the swarm-web proxy only. Use for any question that needs searching or reading a page. Returns a short cited summary; raw pages never reach the caller.",
          mode: "subagent",
          permission: {
            "*": "deny",
            "swarm-web_search": "allow",
            "swarm-web_fetch": "allow",
            "swarm-web_vault_inbox": "allow",
            task: "deny",
            todowrite: "deny",
          },
        },
      },
    })
    expect(validateResearcherDefinition(researcherDefinition)).toEqual([])
  })

  it("key ORDER is pinned: catch-all deny first (findLast would otherwise let a grant shadow it)", () => {
    const keys = Object.keys(researcherDefinition.agent.researcher.permission)
    expect(keys[0]).toBe("*")
  })

  it("the validator itself catches drift", () => {
    const drift = {
      agent: {
        researcher: {
          description: "x",
          mode: "primary",
          permission: { "swarm-web_search": "allow", webfetch: "allow" },
        },
      },
    }
    const findings = validateResearcherDefinition(drift)
    expect(findings.some((f) => f.includes('must START with "*"'))).toBe(true)
    expect(findings.some((f) => f.includes("mode"))).toBe(true)
    expect(findings.some((f) => f.includes("task"))).toBe(true)
    expect(findings.some((f) => f.includes("NOT be re-granted"))).toBe(true)
  })
})
