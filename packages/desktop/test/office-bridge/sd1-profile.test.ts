// Row M6-02: I-BR-20, SD-1 through the bridge and a real sidecar (test strategy §6.12, §7.2; CP-M6 F-M6-1, F-M6-2).
//
// One sidecar, one directory (the bridge workspace), the same fixtures for both sessions:
// - a global instruction file ($XDG_CONFIG_HOME/swarm/AGENTS.md), a project instruction file (<workspace>/AGENTS.md),
// - a user-level skill, a zero-tool MCP server with instructions (a stdio script written into the run dir),
// - a configured `build.prompt` (F-M6-2: an owner's agent prompt; M6-01b drops it for Office sessions).
// The scripted LLM records every provider request. The Office session (created through the bridge, metadata
// `swarm.origin = office-addin`) must carry none of the markers and the one date line; a non-Office control session
// created directly on the sidecar in the same directory must carry them all. A title call of an untitled Office session
// carries none either (U-SD-04 over the wire). Plus the literal pin: the bridge's metadata literals (constants.ts, used
// by upstream.ts) equal the opencode constants (office-profile.ts), by reading source, with no cross-package import.
//
// SWARM_OFFICE_IT=1 and outside the command sandbox (binds ports), under `lock:l2-ports`. Synthetic fixtures only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import { join, resolve } from "node:path"
import {
  OFFICE_HOST_METADATA_KEY,
  OFFICE_ORIGIN_METADATA_KEY,
  OFFICE_ORIGIN_VALUE,
  OFFICE_SESSION_RULESET,
} from "@swarm/office-addin/constants"
import {
  L2_BRIDGE_PORT,
  L2_ENABLED,
  L2_SIDECAR_PORT,
  assertPortsFree,
  bridgeRequest,
  createRunDir,
  createTestTls,
  eventType,
  isIdle,
  openEvents,
  probePort,
  removeRunDir,
  runPassword,
  startBridge,
  startSidecar,
  waitFor,
  type Bridge,
  type ClientRequest,
  type RunDir,
  type Sidecar,
  type TestTls,
} from "./l2-harness"
import { startScriptedLlm, systemText, type RecordedLlmRequest, type ScriptedLlm } from "./l2-scripted-llm"

const GLOBAL_MARK = "SD1-L2-GLOBAL-INSTRUCTION-FIXTURE"
const PROJECT_MARK = "SD1-L2-PROJECT-INSTRUCTION-FIXTURE"
const MCP_MARK = "SD1-L2-ZERO-TOOL-MCP-FIXTURE"
const AGENT_MARK = "SD1-L2-AGENT-PROMPT-FIXTURE"
const SKILL_NAME = "sd1-l2-fixture-skill"
const MCP_NAME = "sd1-l2-zero-tool"

const OFFICE_TEXT = "SD1 L2 office prompt: summarise the selection"
const CONTROL_TEXT = "SD1 L2 control prompt: summarise the selection"
const UNTITLED_TEXT = "SD1 L2 untitled office prompt"

const OPENCODE_PROFILE = resolve(import.meta.dir, "../../../opencode/src/session/office-profile.ts")
const OFFICE_CONSTANTS = resolve(import.meta.dir, "../../../office-addin/src/constants.ts")
const BRIDGE_UPSTREAM = resolve(import.meta.dir, "../../src/main/office-bridge/upstream.ts")

/** A zero-tool MCP server over stdio (newline-delimited JSON-RPC): it only answers initialize with instructions. */
const MCP_SCRIPT = `const MARK = ${JSON.stringify(MCP_MARK)}
let buffer = ""
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const handle = (message) => {
  if (message.id === undefined || message.id === null) return
  if (message.method === "initialize")
    return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: (message.params && message.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "sd1-l2", version: "1.0.0" }, instructions: MARK } })
  if (message.method === "tools/list") return send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } })
  if (message.method === "ping") return send({ jsonrpc: "2.0", id: message.id, result: {} })
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (line !== "") handle(JSON.parse(line))
  }
})
`

let run: RunDir | undefined
let llm: ScriptedLlm | undefined
let sidecar: Sidecar | undefined
let bridge: Bridge | undefined
let tls: TestTls
let password = ""
let token = ""

const call = (request: ClientRequest) => bridgeRequest(tls, request)
const authed = (request: ClientRequest) => call({ ...request, token })
const q = (directory: string) => `directory=${encodeURIComponent(directory)}`

function carries(body: Record<string, unknown>, text: string) {
  return JSON.stringify(body).includes(text)
}

const TITLE_SYSTEM = "title generator"
const isTitleCall = (request: RecordedLlmRequest) => systemText(request.body).includes(TITLE_SYSTEM)

/** Everything SD-1 strips (mirrors `office-profile.test.ts` `stripped`, plus the agent prompt of M6-01b). */
function stripped(workspace: string) {
  const user = os.userInfo().username
  return [
    GLOBAL_MARK,
    PROJECT_MARK,
    MCP_MARK,
    AGENT_MARK,
    SKILL_NAME,
    "<agent_routing>",
    "<auto_workflow>",
    "<gsp_workflow>",
    "<mcp_instructions>",
    "<available_skills>",
    "<suggested_skills>",
    "<swarm_rules>",
    "<env>",
    "Working directory:",
    "Platform:",
    workspace,
    run!.home,
    run!.root,
    os.homedir(),
    ...(user.length >= 3 ? [user] : []),
  ]
}

async function pair() {
  const requested = await call({ method: "POST", path: "/pair/request", body: { host: "Word" } })
  expect(requested.status).toBe(202)
  const { requestId } = requested.json() as { requestId: string }
  const approved = await waitFor(
    async () => {
      const body = (await call({ path: `/pair/status?requestId=${requestId}` })).json() as { state: string; token?: string }
      return body.state === "approved" ? body : undefined
    },
    10_000,
    "pair approved",
  )
  return approved.token ?? ""
}

describe.skipIf(!L2_ENABLED)("SD-1 I-BR-20 through the bridge and a real sidecar (SWARM_OFFICE_IT=1)", () => {
  beforeAll(async () => {
    await assertPortsFree()
    run = await createRunDir()
    password = runPassword()
    tls = await createTestTls(run)
    // User-level fixtures, before the sidecar reads them.
    const config = join(run.home, ".config", "swarm")
    await mkdir(join(config, "skills", SKILL_NAME), { recursive: true })
    await writeFile(join(config, "AGENTS.md"), `# Global\n\n${GLOBAL_MARK}\n`)
    await writeFile(
      join(config, "skills", SKILL_NAME, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: Synthetic SD-1 L2 skill.\n---\n\n# Synthetic\n`,
    )
    const mcpScript = join(run.root, "sd1-mcp.mjs")
    await writeFile(mcpScript, MCP_SCRIPT)

    llm = startScriptedLlm()
    llm.reply = { chunks: ["SD1 ", "reply"], delayMs: 10 }
    // The bridge creates the workspace; it must exist (with its AGENTS.md) before the sidecar first opens it.
    bridge = await startBridge({ run, tls, password })
    await writeFile(join(bridge.workspace, "AGENTS.md"), `# Project\n\n${PROJECT_MARK}\n`)
    sidecar = await startSidecar({
      run,
      password,
      llmUrl: llm.url,
      config: {
        agent: { build: { prompt: `${AGENT_MARK}\nYou are the configured build agent.` } },
        mcp: { [MCP_NAME]: { type: "local", command: [process.execPath, mcpScript], enabled: true } },
      },
      // Project instruction files load only without OPENCODE_DISABLE_PROJECT_CONFIG.
      env: { OPENCODE_DISABLE_PROJECT_CONFIG: undefined },
    })
    token = await pair()
  }, 150_000)

  afterAll(async () => {
    await bridge?.stop().catch(() => {})
    await sidecar?.stop().catch(() => {})
    await llm?.stop().catch(() => {})
    await removeRunDir(run)
    for (const host of ["127.0.0.1", "::1"]) expect(await probePort(host, L2_BRIDGE_PORT)).toBe("ECONNREFUSED")
    expect(await probePort("127.0.0.1", L2_SIDECAR_PORT)).toBe("ECONNREFUSED")
  }, 60_000)

  test("literal pin: the bridge's metadata literals equal the opencode SD-1 constants (source read, no import)", async () => {
    const profile = await readFile(OPENCODE_PROFILE, "utf8")
    expect(profile).toContain(`export const OFFICE_ORIGIN_METADATA_KEY = "${OFFICE_ORIGIN_METADATA_KEY}"`)
    expect(profile).toContain(`export const OFFICE_ORIGIN_VALUE = "${OFFICE_ORIGIN_VALUE}"`)
    const constants = await readFile(OFFICE_CONSTANTS, "utf8")
    expect(constants).toContain(`export const OFFICE_ORIGIN_METADATA_KEY = "swarm.origin"`)
    expect(constants).toContain(`export const OFFICE_ORIGIN_VALUE = "office-addin"`)
    // The bridge builds P2 metadata from those constants, not from its own literals.
    const upstream = await readFile(BRIDGE_UPSTREAM, "utf8")
    expect(upstream).toContain("[OFFICE_ORIGIN_METADATA_KEY]: OFFICE_ORIGIN_VALUE")
    expect(upstream).toMatch(/import \{[^}]*OFFICE_ORIGIN_VALUE[^}]*\} from "@swarm\/office-addin\/constants"/)
    expect(upstream).not.toContain('"office-addin"')
  })

  test("I-BR-20 the Office session's provider request has none of the markers and the date line; the control has them all", async () => {
    const workspace = bridge!.workspace
    // The MCP fixture must be connected before either prompt, or the control could lack it for the wrong reason.
    await waitFor(
      async () => {
        const response = await sidecar!.call(`/mcp?${q(workspace)}`)
        const status = (await response.json().catch(() => ({}))) as Record<string, { status?: string }>
        return status[MCP_NAME]?.status === "connected" ? true : undefined
      },
      60_000,
      "zero-tool MCP connected",
    )

    const created = await authed({ method: "POST", path: "/swarm/session", body: { title: "SD1 office", host: "Word" } })
    expect(created.status).toBe(200)
    const office = (created.json() as { id: string }).id
    const stored = (await (await sidecar!.call(`/session/${office}?${q(workspace)}`)).json()) as Record<string, unknown>
    expect(stored.metadata).toEqual({ [OFFICE_ORIGIN_METADATA_KEY]: OFFICE_ORIGIN_VALUE, [OFFICE_HOST_METADATA_KEY]: "Word" })
    expect(stored.permission).toEqual(OFFICE_SESSION_RULESET)
    expect(stored.directory).toBe(workspace)

    const stream = await openEvents(tls, { token })
    expect(stream.status).toBe(200)
    await stream.waitFor((frame) => eventType(frame) === "server.connected", 10_000, "server.connected")
    const prompt = await authed({
      method: "POST",
      path: `/swarm/session/${office}/prompt_async`,
      body: { parts: [{ type: "text", text: OFFICE_TEXT }] },
    })
    expect(prompt.status).toBe(204)
    await stream.waitFor(isIdle(office), 30_000, "office idle")
    stream.close()

    // Control: same sidecar, same directory, no Office metadata.
    const control = await sidecar!.call(`/session?${q(workspace)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "SD1 control" }),
    })
    expect(control.status).toBe(200)
    const controlID = ((await control.json()) as { id: string }).id
    const prompted = await sidecar!.call(`/session/${controlID}/prompt_async?${q(workspace)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: CONTROL_TEXT }] }),
    })
    expect(prompted.status).toBe(204)
    const controlRequest = await waitFor(
      () => llm!.requests.find((request) => !isTitleCall(request) && carries(request.body, CONTROL_TEXT)),
      30_000,
      "control provider request",
    )

    const officeRequests = llm!.requests.filter((request) => carries(request.body, OFFICE_TEXT))
    expect(officeRequests.length).toBeGreaterThanOrEqual(1)
    const officeMain = officeRequests.find((request) => !isTitleCall(request))!
    const officeSystem = systemText(officeMain.body)
    expect(officeSystem).toContain(`Today's date: ${new Date().toDateString()}`)
    expect(officeSystem.split("Today's date:").length - 1).toBe(1)
    // Absent from the whole request (system, messages and tool descriptions), not only the system text.
    for (const request of officeRequests) {
      const whole = JSON.stringify(request.body)
      const present = stripped(workspace).filter((marker) => whole.includes(marker))
      expect({ request: isTitleCall(request) ? "title" : "main", present }).toEqual({ request: isTitleCall(request) ? "title" : "main", present: [] })
    }

    const controlSystem = systemText(controlRequest.body)
    const expected = [
      GLOBAL_MARK,
      PROJECT_MARK,
      MCP_MARK,
      AGENT_MARK,
      SKILL_NAME,
      "<agent_routing>",
      "<auto_workflow>",
      "<gsp_workflow>",
      "<mcp_instructions>",
      "<available_skills>",
      "<env>",
      workspace,
    ]
    expect(expected.filter((marker) => !controlSystem.includes(marker))).toEqual([])
    await sidecar!.call(`/session/${controlID}/abort?${q(workspace)}`, { method: "POST" })
  }, 120_000)

  test("I-BR-20 an untitled Office session's title call carries none of the markers (U-SD-04 over the wire)", async () => {
    const workspace = bridge!.workspace
    const created = await authed({ method: "POST", path: "/swarm/session", body: { host: "Excel" } })
    expect(created.status).toBe(200)
    const office = (created.json() as { id: string }).id
    const stream = await openEvents(tls, { token })
    await stream.waitFor((frame) => eventType(frame) === "server.connected", 10_000, "server.connected")
    const prompt = await authed({
      method: "POST",
      path: `/swarm/session/${office}/prompt_async`,
      body: { parts: [{ type: "text", text: UNTITLED_TEXT }] },
    })
    expect(prompt.status).toBe(204)
    await stream.waitFor(isIdle(office), 30_000, "untitled office idle")
    stream.close()
    const title = await waitFor(
      () => llm!.requests.find((request) => isTitleCall(request) && carries(request.body, UNTITLED_TEXT)),
      15_000,
      "title call of the untitled Office session",
    )
    const whole = JSON.stringify(title.body)
    expect(stripped(workspace).filter((marker) => whole.includes(marker))).toEqual([])
    expect(whole).not.toContain("Today's date:")
    for (const request of llm!.requests.filter((item) => carries(item.body, UNTITLED_TEXT))) {
      const body = JSON.stringify(request.body)
      expect(stripped(workspace).filter((marker) => body.includes(marker))).toEqual([])
    }
  }, 60_000)
})
