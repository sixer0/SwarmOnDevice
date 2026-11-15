// Swarm 1.2.10 AC-B1014 (B10-14, spec 01g AT-B1014; register N10-204, N10-010; C27, C30 S10-41).
// The PATH_OUTSIDE_ROOTS refusal names the session folder (the host passes the session folder as the only file
// root, C114) instead of the env var STUDIO_MCP_FILE_ROOTS. F1 (row 78): the text and, per S10-41, the host
// tool_call log line of the refused call carries neither the root nor the refused path (result text only).
// F2 (row 78): after a rehome the refusal names the NEW session folder, not the old one. F3: row 79 (downloadDir).
// Only public entry points (resolveAllowedPath, createHostMcpServer), so the BASE run reaches the assertions.
import { useStudioEnv } from "../_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { loadConfig } from "../../../vendor/scripts/studio/mcp/config"
import { resolveAllowedPath } from "../../../vendor/scripts/studio/mcp/safety"
import { createHostMcpServer } from "../../../src/mcp-host/mcp-server.ts"
import { BASE, memNodeFs, ROOT, SECRET } from "./mcp-harness"

const VENDOR = path.resolve(import.meta.dir, "..", "..", "..", "vendor")
const AGENT = "cod-row78"

/** The thrown refusal (code + message) of one resolveAllowedPath call that must be refused. */
function refusal(raw: string, roots: string[]): { code: string; message: string; calls: unknown[] } {
  const mem = memNodeFs({}, roots)
  try {
    resolveAllowedPath(raw, roots, "write-report", mem.nfs)
  } catch (e) {
    const err = e as { code?: string; message: string }
    return { code: String(err.code), message: err.message, calls: mem.calls }
  }
  throw new Error(`not refused: ${raw}`)
}

describe("AC-B1014 F1: the PATH_OUTSIDE_ROOTS refusal names the session folder", () => {
  test("text: di luar akar + folder sesi ini + the root, never the env var name; no fs call", () => {
    const raw = path.join(ROOT, "..", "di-luar", "x.md")
    const r = refusal(raw, [ROOT])
    expect(r.code).toBe("PATH_OUTSIDE_ROOTS")
    expect(r.message).toContain("di luar akar")
    expect(r.message).toContain("folder sesi ini")
    expect(r.message).toContain(ROOT)
    expect(r.message).not.toContain("STUDIO_MCP_FILE_ROOTS")
    expect(r.message).toBe(
      `path ${path.resolve(raw)} di luar akar yang diizinkan, yaitu folder sesi ini (${ROOT}). Simpan di dalam folder itu; setelah proyek dipindah ke grup, folder sesi ikut pindah.`,
    )
    expect(r.calls).toEqual([])
  })

  test("S10-41: through the host, the refusal is result text only; the tool_call log line has neither the root nor the path", async () => {
    const logs: string[] = []
    const config = loadConfig({ INTERNAL_API_SECRET: SECRET, STUDIO_BASE_URL: BASE, STUDIO_MCP_FILE_ROOTS: ROOT, STUDIO_AGENT_ID: AGENT }, ROOT)
    const server = createHostMcpServer({
      config,
      fetchImpl: async () => Promise.reject(new Error("jaringan tidak boleh dipanggil")),
      session: { sessionId: "sesi-row78", agentId: AGENT, fileRoot: ROOT },
      extensions: [],
      repoRoot: VENDOR,
      log: (l) => logs.push(l),
      nfs: memNodeFs().nfs,
    })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: "uji-row78", version: "0.0.1" })
    await client.connect(ct)
    const refused = path.join(ROOT, "..", "di-luar-sesi", "laporan.md")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structuredContent is free-form
    const r: any = await client.callTool({ name: "studio_report_check", arguments: { path: refused, remote: false } })
    expect(r.structuredContent.error.code).toBe("PATH_OUTSIDE_ROOTS")
    const text = JSON.stringify(r.content)
    expect(text).toContain("folder sesi ini")
    expect(text).toContain(ROOT)
    const lines = logs.filter((l) => JSON.parse(l).event === "tool_call" && JSON.parse(l).tool === "studio_report_check")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).code).toBe("PATH_OUTSIDE_ROOTS")
    for (const l of logs) {
      expect(l).not.toContain(ROOT)
      expect(l).not.toContain(path.resolve(refused))
      expect(l).not.toContain("folder sesi ini")
    }
    await client.close()
  })
})

describe("AC-B1014 F2: a rehomed session (roots [OLD] then [NEW]) names the NEW session folder", () => {
  test("a path in OLD is refused under [NEW]; the named folder is NEW, not OLD", () => {
    const OLD = path.resolve("/sesi-uji-row78/proyek-lama")
    const NEW = path.resolve("/sesi-uji-row78/grup-baru/proyek-lama")
    const inOld = path.join(OLD, "laporan.md")
    expect(resolveAllowedPath(inOld, [OLD], "write-report", memNodeFs({}, [OLD]).nfs)).toBe(inOld)
    const r = refusal(inOld, [NEW])
    expect(r.code).toBe("PATH_OUTSIDE_ROOTS")
    const named = /yaitu folder sesi ini \((.*)\)\. Simpan di dalam folder itu/.exec(r.message)
    expect(named?.[1]).toBe(NEW)
    expect(named?.[1]).not.toContain(OLD + path.sep)
    expect(named?.[1] === OLD).toBe(false)
    expect(r.message).toContain("setelah proyek dipindah ke grup, folder sesi ikut pindah")
  })
})
