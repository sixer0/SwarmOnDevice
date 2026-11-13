// 1.2.7 U-1 (AC-U1, decision U2; register N7-082): Mission Control lists only the missions linked to the window's
// sessions. The client calls studio_mission_list with `sessions` and never with `projectDir`, so the store's
// linked-session branch alone answers (mission-store.ts linkedSessions; mission-tools.ts adds projectDir only when sent).
// With no session ids there is no host call at all (defence in depth: a renderer that omits them never sees the whole
// project). SF-5: the panel's client id is the same `swarm` id Swarm's own Studio entry links agent writes under.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMissionControlClient, MISSION_CONTROL_AGENT, type FetchLike } from "./mission-client"

const SCRATCH = join(tmpdir(), "rel127u1")
mkdirSync(SCRATCH, { recursive: true })
const dir = mkdtempSync(join(SCRATCH, "c-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const PROJECT = "/tmp/syn127-project"
const MAIN_SES = "ses_0127a0000001Syn127Main0001"
const CHILD_SES = "ses_0127a0000002Syn127Child002"

function fakeHost() {
  const args: Array<Record<string, unknown>> = []
  const agents: Array<string | null> = []
  let n = 0
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, any>
    const headers = new Headers(init.headers as HeadersInit | undefined)
    agents.push(headers.get("x-studio-agent"))
    if (body.method === "initialize") {
      const msg = { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake" }, capabilities: {} } }
      return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": `s${++n}` } })
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
    args.push({ name: body.params.name, ...body.params.arguments })
    const items = [{ id: "2026-11-13_syn-one" }, { id: "2026-11-13_syn-two" }]
    const msg = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "x" }], structuredContent: { ok: true, tool: body.params.name, items, nextCursor: null } } }
    return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } })
  }
  return { fetch, args, agents }
}

const client = (fetch: FetchLike) =>
  createMissionControlClient({ url: "http://127.0.0.1:47999/mcp", token: "f".repeat(64), callerCwd: join(dir, "mc"), fetch })

describe("1.2.7 U-1: studio_mission_list by session ids only", () => {
  test("sessions are sent and projectDir is absent", async () => {
    const host = fakeHost()
    const r = await client(host.fetch).list({ directory: PROJECT, sessions: [MAIN_SES, CHILD_SES] })
    expect(r.ok).toBe(true)
    expect(host.args).toHaveLength(1)
    expect(host.args[0].name).toBe("studio_mission_list")
    expect(host.args[0].sessions).toEqual([MAIN_SES, CHILD_SES])
    expect("projectDir" in host.args[0]).toBe(false)
  })

  test("no session ids: an empty list and no host call", async () => {
    const host = fakeHost()
    const c = client(host.fetch)
    expect(await c.list({ directory: PROJECT })).toEqual({ ok: true, data: { items: [] } })
    expect(await c.list({ directory: PROJECT, sessions: [] })).toEqual({ ok: true, data: { items: [] } })
    expect(host.args).toHaveLength(0)
  })

  test("SF-5: the panel calls Studio as `swarm`, the id Swarm's built-in Studio entry links agent writes under", async () => {
    const host = fakeHost()
    await client(host.fetch).list({ directory: PROJECT, sessions: [MAIN_SES] })
    expect(MISSION_CONTROL_AGENT).toBe("swarm")
    expect(host.agents.length).toBeGreaterThan(0)
    expect(host.agents.every((a) => a === "swarm")).toBe(true)
    const entry = readFileSync(join(import.meta.dir, "../../../../opencode/src/mcp/datum-studio.ts"), "utf8")
    expect(entry).toMatch(/export const STUDIO_AGENT_ID = "swarm"/)
  })
})
