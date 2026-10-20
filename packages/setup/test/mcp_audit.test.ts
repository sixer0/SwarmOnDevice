// Row-94 unit tests — audit log line format + durability (T-W7-4 counterpart here is format &
// mode & rotation; the one-line-per-CALL count test lives in mcp_proxy.test.ts). Golden line
// pins §6.6's exact field set and order; denied lines carry NO network fields; secrets cannot
// appear because the record type has no slot for them (structural P-8).
// Run TARGETED: cd packages/setup && bun test test/mcp_audit.test.ts

import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendAudit, formatAuditLine, auditLogPath, type AuditRecord } from "../src/mcpproxy/audit.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "r94-audit-"))
}

const allowed: AuditRecord = {
  ts: "2026-10-20T02:14:55.123Z",
  component: "swarm-web",
  tool: "fetch",
  action: "crawl",
  decision: "allowed",
  reason: null,
  query: null,
  url: "https://example.com/a",
  host: "example.com",
  status: 200,
  bytes_in: 48213,
  bytes_out: 5980,
  sha256: "<hex of the exact safe body sent to the model>",
  truncated: true,
  latency_ms: 812,
  nonce: "9f2c1a7d",
  agent: "researcher",
  session: null,
}

describe("§6.6 golden line format", () => {
  it("serialises the spec example with exact keys and order", () => {
    expect(formatAuditLine(allowed)).toBe(
      '{"ts":"2026-10-20T02:14:55.123Z","component":"swarm-web","tool":"fetch","action":"crawl","decision":"allowed","reason":null,"query":null,"url":"https://example.com/a","host":"example.com","status":200,"bytes_in":48213,"bytes_out":5980,"sha256":"<hex of the exact safe body sent to the model>","truncated":true,"latency_ms":812,"nonce":"9f2c1a7d","agent":"researcher","session":null}',
    )
  })

  it("denied line has decision/reason/attempted url and NO network fields", () => {
    const line = JSON.parse(
      formatAuditLine({
        ts: allowed.ts,
        component: "swarm-web",
        tool: "fetch",
        action: "page",
        decision: "denied",
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

  it("search line populates query and keeps url null (§6.6)", () => {
    const line = JSON.parse(
      formatAuditLine({
        ...allowed,
        tool: "search",
        action: "query",
        query: "openstreetmap",
        url: null,
        host: "127.0.0.1",
      }),
    ) as Record<string, unknown>
    expect(line.query).toBe("openstreetmap")
    expect(line.url).toBeNull()
  })
})

describe("appendAudit durability + rotation", () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it("appends one JSONL line per call at mode 0600 under a 0700 parent", () => {
    dir = tmp()
    const path = join(dir, "web-audit.log")
    appendAudit(allowed, { path })
    appendAudit({ ...allowed, decision: "denied", reason: "address_denied" }, { path })
    const lines = readFileSync(path, "utf8").trim().split("\n")
    expect(lines.length).toBe(2)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(lines[1]).toContain('"decision":"denied"') // append-only order preserved
  })

  it("size rotation keeps maxRotations generations (5 MiB / five per §6.6 defaults overridden small here)", () => {
    dir = tmp()
    const path = join(dir, "web-audit.log")
    for (let i = 0; i < 12; i++) appendAudit(allowed, { path, maxBytes: 200, maxRotations: 3 })
    expect(exists(path)).toBe(true)
    expect(exists(`${path}.1`)).toBe(true)
    expect(exists(`${path}.2`)).toBe(true)
    expect(exists(`${path}.3`)).toBe(true)
    expect(exists(`${path}.4`)).toBe(false) // oldest generation dropped
    function exists(p: string): boolean {
      try {
        return statSync(p).size >= 0
      } catch {
        return false
      }
    }
  })

  it("path resolution: PC-ENV-04 override beats PC-PATH-10; HOME honoured", () => {
    const home = tmp()
    dir = home
    const prevHome = process.env.HOME
    const prevEnv = process.env.SWARM_WEB_AUDIT_LOG
    process.env.HOME = home
    delete process.env.SWARM_WEB_AUDIT_LOG
    expect(auditLogPath()).toBe(join(home, ".swarm", "logs", "web-audit.log")) // PC-PATH-10 under $HOME
    process.env.SWARM_WEB_AUDIT_LOG = "/tmp/custom-audit.log"
    expect(auditLogPath()).toBe("/tmp/custom-audit.log")
    if (prevHome !== undefined) process.env.HOME = prevHome
    if (prevEnv !== undefined) process.env.SWARM_WEB_AUDIT_LOG = prevEnv
    else delete process.env.SWARM_WEB_AUDIT_LOG
  })
})
