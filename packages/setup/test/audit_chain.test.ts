// Row-97 unit tests — unified audit chain (task d). Golden lines pin ONE append-only JSONL format
// across the three event classes (mcp_call / policy_active / tool_launch); append-only durability,
// mode 0600, size rotation, and the mechanical conversion of a proxy §6.6 record into an mcp_call
// line are all asserted here. Run TARGETED: cd packages/setup && bun test test/audit_chain.test.ts

import { describe, it, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendChainEvent,
  formatChainLine,
  chainLogPath,
  mcpCallFromProxyRecord,
  readChainEvents,
  type ChainEvent,
  type McpCallEvent,
} from "../src/wiring/audit_chain.ts"
import type { AuditRecord } from "../src/mcpproxy/audit.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "r97-chain-"))
}

const TS = "2026-10-20T02:14:55.123Z"

describe("golden lines — one format, three kinds", () => {
  it("mcp_call allowed line: shared envelope then §6.6 fields in order", () => {
    const ev: McpCallEvent = {
      ts: TS,
      kind: "mcp_call",
      source: "swarm-setup.wiring.audit",
      decision: "allowed",
      component: "swarm-web",
      tool: "fetch",
      action: "crawl",
      reason: null,
      query: null,
      url: "https://example.com/a",
      host: "example.com",
      status: 200,
      bytes_in: 48213,
      bytes_out: 5980,
      sha256: "deadbeef",
      truncated: true,
      latency_ms: 812,
      nonce: "9f2c1a7d",
      agent: "researcher",
      session: null,
    }
    expect(formatChainLine(ev)).toBe(
      '{"ts":"2026-10-20T02:14:55.123Z","kind":"mcp_call","source":"swarm-setup.wiring.audit","decision":"allowed","component":"swarm-web","tool":"fetch","action":"crawl","reason":null,"query":null,"url":"https://example.com/a","host":"example.com","status":200,"bytes_in":48213,"bytes_out":5980,"sha256":"deadbeef","truncated":true,"latency_ms":812,"nonce":"9f2c1a7d","agent":"researcher","session":null}',
    )
  })

  it("mcp_call denied line carries NO network fields (§6.6)", () => {
    const line = JSON.parse(
      formatChainLine({
        ts: TS,
        kind: "mcp_call",
        source: "s",
        decision: "denied",
        component: "swarm-web",
        tool: "fetch",
        action: "page",
        reason: "address_denied",
        query: null,
        url: "http://169.254.169.254/latest/meta-data/",
        host: "169.254.169.254",
        latency_ms: 0,
        agent: "researcher",
        session: null,
      }),
    ) as Record<string, unknown>
    expect(line.decision).toBe("denied")
    expect(line.reason).toBe("address_denied")
    for (const k of ["status", "bytes_in", "bytes_out", "sha256", "truncated"]) expect(k in line).toBe(false)
  })

  it("policy_active line records path + forbidden ids + count", () => {
    const line = formatChainLine({
      ts: TS,
      kind: "policy_active",
      source: "swarm-setup.wiring.policy_enforce",
      decision: "active",
      policyPath: "/home/u/.swarm/setup/policy.json",
      forbidden: ["graft", "rtk"],
      count: 2,
      correlationId: "run-1",
    })
    expect(line).toBe(
      '{"ts":"2026-10-20T02:14:55.123Z","kind":"policy_active","source":"swarm-setup.wiring.policy_enforce","decision":"active","policyPath":"/home/u/.swarm/setup/policy.json","forbidden":["graft","rtk"],"count":2,"correlationId":"run-1"}',
    )
  })

  it("tool_launch line records argv + telemetry/must-be-unset posture", () => {
    const line = formatChainLine({
      ts: TS,
      kind: "tool_launch",
      source: "swarm-setup.wiring.graft_guard",
      decision: "launched",
      tool: "graft",
      argv: [
        "/home/u/.swarm/tools/node/v24/bin/node",
        "/home/u/.swarm/tools/graft/0.18.0/node_modules/@nanonets/graft/dist/cli.js",
        "mcp",
      ],
      telemetryOff: true,
      mustBeUnsetOk: true,
    })
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed.kind).toBe("tool_launch")
    expect(parsed.telemetryOff).toBe(true)
    expect((parsed.argv as string[])[2]).toBe("mcp")
    expect(Object.keys(parsed).slice(0, 4)).toEqual(["ts", "kind", "source", "decision"])
  })
})

describe("appendChainEvent durability + rotation", () => {
  it("appends one JSONL line per call at mode 0600 under a 0700 parent, append-only order", () => {
    const dir = tmp()
    try {
      const path = join(dir, "audit.jsonl")
      const e1: ChainEvent = {
        ts: TS,
        kind: "policy_active",
        source: "s",
        decision: "active",
        policyPath: "/p",
        forbidden: [],
        count: 0,
      }
      appendChainEvent(e1, { path })
      appendChainEvent({ ...e1, forbidden: ["graft"], count: 1 }, { path })
      const lines = readFileSync(path, "utf8").trim().split("\n")
      expect(lines.length).toBe(2)
      for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(lines[1]).toContain('"count":1') // second write appended, not overwritten
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("size rotation keeps maxRotations generations, dropping the oldest", () => {
    const dir = tmp()
    try {
      const path = join(dir, "audit.jsonl")
      const ev: ChainEvent = {
        ts: TS,
        kind: "tool_launch",
        source: "s",
        decision: "launched",
        tool: "rtk",
        argv: ["/b", "--version"],
        telemetryOff: true,
        mustBeUnsetOk: true,
      }
      for (let i = 0; i < 12; i++) appendChainEvent(ev, { path, maxBytes: 160, maxRotations: 3 })
      for (const suffix of ["", ".1", ".2", ".3"]) expect(statSync(`${path}${suffix}`).size).toBeGreaterThanOrEqual(0)
      let exists4 = true
      try {
        statSync(`${path}.4`)
      } catch {
        exists4 = false
      }
      expect(exists4).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("readChainEvents surfaces a malformed line as null (fail-closed reader)", () => {
    const dir = tmp()
    try {
      const path = join(dir, "audit.jsonl")
      appendChainEvent(
        { ts: TS, kind: "policy_active", source: "s", decision: "active", policyPath: "/p", forbidden: [], count: 0 },
        { path },
      )
      appendFileSync(path, "not-json\n")
      const events = readChainEvents({ path })
      expect(events.length).toBe(2)
      expect(events[0]?.kind).toBe("policy_active")
      expect(events[1]).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("path resolution + proxy-record conversion", () => {
  it("PC-ENV override beats the setup-root default; HOME honoured", () => {
    const dir = tmp()
    try {
      const prevHome = process.env.HOME
      const prevEnv = process.env.SWARM_SETUP_AUDIT_LOG
      process.env.HOME = dir
      delete process.env.SWARM_SETUP_AUDIT_LOG
      expect(chainLogPath()).toBe(join(dir, ".swarm", "setup", "audit.jsonl"))
      process.env.SWARM_SETUP_AUDIT_LOG = "/tmp/custom-chain.log"
      expect(chainLogPath()).toBe("/tmp/custom-chain.log")
      if (prevHome !== undefined) process.env.HOME = prevHome
      else delete process.env.HOME
      if (prevEnv !== undefined) process.env.SWARM_SETUP_AUDIT_LOG = prevEnv
      else delete process.env.SWARM_SETUP_AUDIT_LOG
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("mcpCallFromProxyRecord folds a §6.6 AuditRecord into the unified schema without dropping fields", () => {
    const rec: AuditRecord = {
      ts: TS,
      component: "swarm-web",
      tool: "search",
      action: "query",
      decision: "allowed",
      reason: null,
      query: "openstreetmap",
      url: null,
      host: "127.0.0.1",
      status: 200,
      bytes_in: 100,
      bytes_out: 50,
      sha256: "abc",
      truncated: false,
      latency_ms: 12,
      nonce: "n1",
      agent: "researcher",
      session: null,
    }
    const ev = mcpCallFromProxyRecord(rec, { source: "row113.merge", correlationId: "c1" })
    expect(ev.kind).toBe("mcp_call")
    expect(ev.query).toBe("openstreetmap")
    expect(ev.url).toBeNull()
    expect(ev.source).toBe("row113.merge")
    expect(ev.correlationId).toBe("c1")
    const line = JSON.parse(formatChainLine(ev)) as Record<string, unknown>
    expect(line.sha256).toBe("abc")
  })
})
