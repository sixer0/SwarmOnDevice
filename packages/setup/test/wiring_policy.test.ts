// Row-97 unit tests — policy enforcement (task c), graft launch guard (task b), rtk argv wrapper
// (task a). All drive the shipped modules directly against throwaway files/objects; no HOME mutation,
// no spawn, no network. Run TARGETED: cd packages/setup && bun test test/wiring_policy.test.ts

import { describe, it, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enforcePolicy, policyPath } from "../src/wiring/policy_enforce.ts"
import {
  assertGraftChildEnv,
  assertGraftArgvSanctioned,
  graftLaunchGuard,
  GRAFT_MUST_BE_UNSET,
} from "../src/wiring/graft_guard.ts"
import {
  rtkProbeArgv,
  assertRtkArgvSafe,
  buildRtkSkillArgv,
  rtkTelemetryPosture,
} from "../src/wiring/rtk_invocation.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "r97-policy-"))
}

describe("enforcePolicy — strict schema, fail-closed", () => {
  it("absent file is inactive, no error, no audit line", () => {
    const dir = tmp()
    try {
      const res = enforcePolicy({ path: join(dir, "policy.json"), chain: { path: join(dir, "audit.jsonl") } })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.active).toBe(false)
      expect(res.forbidden).toEqual([])
      expect(res.auditLine).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("valid forbidden list activates the policy and writes one audit line", () => {
    const dir = tmp()
    try {
      const p = join(dir, "policy.json")
      const chain = join(dir, "audit.jsonl")
      writeFileSync(p, JSON.stringify({ forbidden: ["graft", "rtk"] }))
      const res = enforcePolicy({
        path: p,
        chain: { path: chain },
        correlationId: "run-9",
        now: () => "2026-10-20T00:00:00.000Z",
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.active).toBe(true)
      expect(res.forbidden).toEqual(["graft", "rtk"])
      const line = JSON.parse(res.auditLine ?? "") as Record<string, unknown>
      expect(line.kind).toBe("policy_active")
      expect(line.decision).toBe("active")
      expect(line.forbidden).toEqual(["graft", "rtk"])
      expect(line.count).toBe(2)
      expect(line.correlationId).toBe("run-9")
      expect(readFileSync(chain, "utf8").trim().split("\n").length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("an empty forbidden array still counts as active (the control was consulted)", () => {
    const dir = tmp()
    try {
      const p = join(dir, "policy.json")
      const chain = join(dir, "audit.jsonl")
      writeFileSync(p, JSON.stringify({ forbidden: [] }))
      const res = enforcePolicy({ path: p, chain: { path: chain } })
      expect(res.ok && res.active).toBe(true)
      if (!res.ok) return
      expect(res.forbidden).toEqual([])
      expect(res.auditLine).toContain('"count":0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("REJECTS an unknown top-level key fail-closed (the row-97 decision)", () => {
    const dir = tmp()
    try {
      const p = join(dir, "policy.json")
      writeFileSync(p, JSON.stringify({ forbidden: ["graft"], allowAll: true }))
      const res = enforcePolicy({ path: p, chain: { path: join(dir, "audit.jsonl") } })
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.error).toContain("allowAll")
      expect(res.error).toContain("unknown top-level key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a typo'd 'forbiden' key is rejected, never read as 'no restriction'", () => {
    const dir = tmp()
    try {
      const p = join(dir, "policy.json")
      writeFileSync(p, JSON.stringify({ forbiden: ["graft"] }))
      const res = enforcePolicy({ path: p, chain: { path: join(dir, "audit.jsonl") } })
      expect(res.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("malformed JSON / non-object / missing-or-non-array forbidden / unknown id all fail closed", () => {
    const dir = tmp()
    try {
      const chain = { path: join(dir, "audit.jsonl") }
      const cases: Array<[string, string]> = [
        ["{not json", "not valid JSON"],
        ['["graft"]', "not a JSON object"],
        ['{"forbidden":"graft"}', 'must carry a "forbidden" array'],
        ['{"forbidden":["notacomponent"]}', "not a register component id"],
      ]
      for (const [body, needle] of cases) {
        const p = join(dir, `p-${needle.replace(/\W/g, "").slice(0, 8)}.json`)
        writeFileSync(p, body)
        const res = enforcePolicy({ path: p, chain })
        expect(res.ok).toBe(false)
        if (res.ok) continue
        expect(res.error).toContain(needle)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("policyPath resolves PC-PATH-16 under $HOME", () => {
    const dir = tmp()
    try {
      const prev = process.env.HOME
      process.env.HOME = dir
      expect(policyPath()).toBe(join(dir, ".swarm", "setup", "policy.json"))
      if (prev !== undefined) process.env.HOME = prev
      else delete process.env.HOME
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("graft launch guard (task b)", () => {
  it("assertGraftChildEnv requires DO_NOT_TRACK=1 and no must-be-unset secret", () => {
    expect(assertGraftChildEnv({ DO_NOT_TRACK: "1" }).ok).toBe(true)
    expect(assertGraftChildEnv({}).ok).toBe(false) // missing knob
    expect(assertGraftChildEnv({ DO_NOT_TRACK: "0" }).ok).toBe(false) // wrong value
    for (const key of GRAFT_MUST_BE_UNSET) {
      const res = assertGraftChildEnv({ DO_NOT_TRACK: "1", [key]: "leak" })
      expect(res.ok).toBe(false)
      expect(res.violations.some((v) => v.includes(key))).toBe(true)
    }
  })

  it("assertGraftArgvSanctioned accepts only [absNode, absCli, 'mcp']", () => {
    expect(assertGraftArgvSanctioned(["/n", "/c", "mcp"]).ok).toBe(true)
    expect(assertGraftArgvSanctioned(["n", "/c", "mcp"]).ok).toBe(false) // relative node
    expect(assertGraftArgvSanctioned(["/n", "/c", "build"]).ok).toBe(false) // wrong subcommand
    expect(assertGraftArgvSanctioned(["/n", "/c", "mcp", "--deep"]).ok).toBe(false) // deep mode
    expect(assertGraftArgvSanctioned(["/n", "/c"]).ok).toBe(false) // missing subcommand
  })

  it("graftLaunchGuard passes a clean entry and records one tool_launch line", () => {
    const dir = tmp()
    try {
      const chain = join(dir, "audit.jsonl")
      const launch = () => ({
        ok: true as const,
        nodePath: "/home/u/.swarm/tools/node/v24/bin/node",
        cliPath: "/home/u/.swarm/tools/graft/0.18.0/node_modules/@nanonets/graft/dist/cli.js",
      })
      const res = graftLaunchGuard({ launch, env: {}, chain: { path: chain }, now: () => "2026-10-20T00:00:00.000Z" })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.entry.command[2]).toBe("mcp")
      expect(res.entry.env?.DO_NOT_TRACK).toBe("1")
      expect(res.auditLine).toContain('"kind":"tool_launch"')
      expect(res.auditLine).toContain('"telemetryOff":true')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("graftLaunchGuard refuses when a must-be-unset secret is present (never hands back an entry)", () => {
    const dir = tmp()
    try {
      const launch = () => ({ ok: true as const, nodePath: "/n", cliPath: "/c" })
      const res = graftLaunchGuard({
        launch,
        env: { GRAFT_API_KEY: "secret" },
        chain: { path: join(dir, "audit.jsonl") },
      })
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toContain("GRAFT_API_KEY")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("rtk argv wrapper (task a)", () => {
  it("probe argv is exactly [bin, --version]", () => {
    expect(rtkProbeArgv("/abs/rtk")).toEqual(["/abs/rtk", "--version"])
  })

  it("guard rejects relative binary, forbidden verbs, metacharacters, and .env paths", () => {
    expect(assertRtkArgvSafe(["/abs/rtk", "--version"]).ok).toBe(true)
    expect(assertRtkArgvSafe(["rtk", "--version"]).ok).toBe(false) // PATH-resolvable
    for (const v of ["init", "telemetry", "config"]) expect(assertRtkArgvSafe(["/abs/rtk", v]).ok).toBe(false)
    expect(assertRtkArgvSafe(["/abs/rtk", "grep", "x | sh"]).ok).toBe(false) // pipeline
    expect(assertRtkArgvSafe(["/abs/rtk", "read", ".env"]).ok).toBe(false) // secret path
    expect(assertRtkArgvSafe(["/abs/rtk", "read", "/etc/app/.env"]).ok).toBe(false) // secret path deep
  })

  it("buildRtkSkillArgv composes only a guarded argv", () => {
    const ok = buildRtkSkillArgv("/abs/rtk", ["grep", "TODO"])
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.argv).toEqual(["/abs/rtk", "grep", "TODO"])
    expect(buildRtkSkillArgv("/abs/rtk", ["config", "recall", "disabled"]).ok).toBe(false)
    expect(buildRtkSkillArgv("/abs/rtk", ["init", "--opencode"]).ok).toBe(false)
  })

  it("telemetry posture records off-by-default + deferred recall + lock never_run", () => {
    const p = rtkTelemetryPosture()
    expect(p.telemetryDefault).toBe("off")
    expect(p.recallControlDeferredToRow).toBe(98)
    expect(p.configWrittenBySetup).toBe(false)
    expect(p.neverRun).toContain("rtk init")
    const withLock = rtkTelemetryPosture({
      version: "x",
      components: { rtk: { version: "v1", never_run: ["rtk init", "rtk telemetry enable"] } },
    } as never)
    expect(withLock.neverRun).toEqual(["rtk init", "rtk telemetry enable"])
  })
})
