// 1.2.9 row 54 (AC-C06, N9-133; spec 01c section 3.6 and threat model section 4; decisions C7(a), C13; S9-15).
//
// Before a real move, the server checks the person's answer itself: it reads the request through the built-in DATUM
// Studio (`studio_mission_get`) and moves only when the request is answered `by: "user"` with `attested: true` and is
// bound to this move (placement: the mission itself, option join/new, the option's group = basename(to); tidy: option
// approve and a proposal entry {mission, group}). Anything else is refused REHOME_APPROVAL_MISSING "decision"; a read
// it cannot make (no port, not the built-in server, not connected, too slow, unreadable) is "decision unchecked".
// Dry runs and compensating moves are exempt. In 1.2.8 nothing read the answer: any well-formed D-n moved.
//
// Module half: Rehome.make with a fake `decision` port (N9-067), a temp tree under a mkdtemp HOME (os.homedir stubbed);
// XDG is pinned by test/preload.ts. Port half: the real route in a child `bun test` posed as the app's utility process,
// so DatumStudioMcp.current() yields a built-in entry (harness of OT/agent/s02-studio-server-binding.test.ts); its
// launcher runs a synthetic stdio MCP server (syn129) that answers `studio_mission_get` from a table.
// Run targeted: cd packages/opencode && bun test test/project/rel129-c06-decision-check.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Flock } from "@opencode-ai/core/util/flock"
// The server first: its import graph settles the permission modules' load order (as in rel128-proj-68f-first-launch).
import { Server } from "../../src/server/server"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { DatumStudioMcp } from "../../src/mcp/datum-studio"
import { Rehome } from "../../src/project/rehome"
import { disposeAllInstances } from "../fixture/fixture"

const MISSION = "2026-11-14_syn129-c06-placement"
const TIDY = "2026-11-14_syn129-c06-tidy"
const GROUP = "Lumen"
const DECISION: Rehome.Result = { refused: "REHOME_APPROVAL_MISSING", detail: "decision" }
const UNCHECKED: Rehome.Result = { refused: "REHOME_APPROVAL_MISSING", detail: "decision unchecked" }
const PORT_SUITE = "C06 port in an app process"

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")
const marker = (name: string) => JSON.stringify({ version: 1, name, kind: "product", created: 1787000000000 }) + "\n"

let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh129c06-")))
  homeSpy = spyOn(os, "homedir").mockReturnValue(home)
})
afterAll(async () => {
  homeSpy?.mockRestore()
  await fs.rm(home, { recursive: true, force: true })
})

async function tree(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (folder: string) => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(folder, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isDirectory()) {
        out.push(`D ${rel}`)
        await walk(full)
      } else if (entry.isSymbolicLink()) out.push(`L ${rel}`)
      else out.push(`F ${rel} ${sha(await fs.readFile(full))}`)
    }
  }
  await walk(dir)
  return out
}

/** Default Project R with two missions at the root and one marked group; synthetic (syn129). */
async function layout(base: string, missions = [MISSION]) {
  const R = path.join(base, "Documents", "Default Project")
  for (const mission of missions) {
    await fs.mkdir(path.join(R, "docs", mission), { recursive: true })
    await fs.writeFile(path.join(R, "docs", mission, "README.md"), `# syn129 ${mission}\n`)
  }
  await fs.mkdir(path.join(R, GROUP, ".swarm"), { recursive: true })
  await fs.writeFile(path.join(R, GROUP, ".swarm", "group.json"), marker(GROUP))
  return R
}

// ---------------------------------------------------------------------------------------------------------------
// Module half

describe("C06 module: Rehome.run reads the decision port before a real move", () => {
  type Read = Rehome.DecisionRead
  let case_ = 0
  let R = ""
  let data = ""
  let calls: { mission: string; ref: string }[] = []

  beforeEach(async () => {
    case_ += 1
    const base = path.join(home, `m${case_}`)
    R = await layout(base, [MISSION, "2026-11-14_syn129-c06-other"])
    data = path.join(base, "data")
    await fs.mkdir(path.join(data, "memory"), { recursive: true, mode: 0o700 })
    calls = []
  })

  const ports = (decision?: Read | ((mission: string, ref: string) => Promise<Read>)): Rehome.Ports => ({
    root: R,
    dataDir: data,
    session: async () => undefined,
    projectId: async () => "global",
    moveSession: async () => {},
    terminals: async () => [],
    ...(decision === undefined
      ? {}
      : {
          decision: async (mission: string, ref: string) => {
            calls.push({ mission, ref })
            return typeof decision === "function" ? decision(mission, ref) : decision
          },
        }),
  })

  const input = (over: Partial<Rehome.Input> = {}): Rehome.Input => ({
    missionId: MISSION,
    from: R,
    to: path.join(R, GROUP),
    sessions: [],
    approvalRef: "D-1",
    approvalMission: MISSION,
    ...over,
  })

  const placement = (over: Record<string, unknown> = {}) =>
    ({
      status: "answered",
      topic: "project-placement",
      option: "join",
      by: "user",
      attested: true,
      group: GROUP,
      proposal: undefined,
      ...over,
    }) as Read
  const tidy = (over: Record<string, unknown> = {}) =>
    ({
      status: "answered",
      topic: "project-tidy",
      option: "approve",
      by: "user",
      attested: true,
      group: undefined,
      proposal: [{ mission: "2026-11-14_syn129-c06-other", group: "Arsip" }, { mission: MISSION, group: GROUP }],
      ...over,
    }) as Read

  const journals = () => fs.readdir(path.join(data, "rehome")).catch(() => [] as string[])

  /** Refused with `expected` while the test itself holds the move lease (so the check ran before the lease); disk equal. */
  async function refusedBeforeLease(ports: Rehome.Ports, call: Rehome.Input, expected: Rehome.Result) {
    const before = { tree: sha((await tree(R)).join("\n")), journals: await journals() }
    const lease = await Flock.acquire("rehome")
    try {
      expect(await Rehome.make(ports).run(call)).toEqual(expected)
    } finally {
      await lease.release()
    }
    expect({ tree: sha((await tree(R)).join("\n")), journals: await journals() }).toEqual(before)
    expect(before.journals).toEqual([])
  }

  const moved = async (result: Rehome.Result) => {
    expect(result).toMatchObject({ moved: { folder: true } })
    expect((await fs.stat(path.join(R, GROUP, "docs", MISSION))).isDirectory()).toBe(true)
    expect(await fs.lstat(path.join(R, "docs", MISSION)).catch(() => undefined)).toBeUndefined()
  }

  test('"decision": the request is open, absent or withdrawn (the port reads all three as open)', async () => {
    await refusedBeforeLease(ports({ status: "open" }), input(), DECISION)
    expect(calls).toEqual([{ mission: MISSION, ref: "D-1" }])
  })

  test('"decision": answered by the controller, or by the person without attestation', async () => {
    await refusedBeforeLease(ports(placement({ by: "controller" })), input(), DECISION)
    await refusedBeforeLease(ports(placement({ attested: false })), input(), DECISION)
    await refusedBeforeLease(ports(tidy({ by: "controller" })), input({ approvalMission: TIDY }), DECISION)
    await refusedBeforeLease(ports(tidy({ attested: false })), input({ approvalMission: TIDY }), DECISION)
  })

  test('"decision" (S9-15): strict types, a value that only looks right is not an answer', async () => {
    for (const over of [
      { by: ["user"] },
      { by: "User" },
      { by: undefined },
      { attested: "true" },
      { attested: 1 },
      { attested: undefined },
      { status: "Answered" },
    ])
      await refusedBeforeLease(ports(placement(over)), input(), DECISION)
  })

  test('"decision": a placement not bound to this move (other mission, option, group)', async () => {
    // The answered placement of another mission does not approve moving this one.
    await refusedBeforeLease(ports(placement()), input({ approvalMission: "2026-11-14_syn129-c06-other" }), DECISION)
    for (const option of ["keep", "approve", "JOIN", ""])
      await refusedBeforeLease(ports(placement({ option })), input(), DECISION)
    await refusedBeforeLease(ports(placement({ group: "Arsip" })), input(), DECISION)
    await refusedBeforeLease(ports(placement({ group: undefined })), input(), DECISION)
    await refusedBeforeLease(ports(placement({ group: "lumen" })), input(), DECISION)
  })

  test('"decision": a tidy list not bound to this move (option, proposal entry)', async () => {
    const call = input({ approvalMission: TIDY })
    await refusedBeforeLease(ports(tidy({ option: "decline" })), call, DECISION)
    await refusedBeforeLease(ports(tidy({ proposal: [{ mission: MISSION, group: "Arsip" }] })), call, DECISION)
    await refusedBeforeLease(ports(tidy({ proposal: [{ mission: "2026-11-14_syn129-c06-other", group: GROUP }] })), call, DECISION)
    await refusedBeforeLease(ports(tidy({ proposal: [{ mission: MISSION, group: null }] })), call, DECISION)
    await refusedBeforeLease(ports(tidy({ proposal: undefined })), call, DECISION)
    await refusedBeforeLease(ports(tidy({ proposal: { mission: MISSION, group: GROUP } })), call, DECISION)
    await refusedBeforeLease(ports(tidy({ proposal: [null, "x"] })), call, DECISION)
  })

  test('"decision": an unknown topic, or none', async () => {
    await refusedBeforeLease(ports(placement({ topic: "other" })), input(), DECISION)
    await refusedBeforeLease(ports(placement({ topic: undefined })), input(), DECISION)
  })

  test('"decision": a call without approvalMission cannot be bound (the port is not asked)', async () => {
    await refusedBeforeLease(ports(placement()), input({ approvalMission: undefined }), DECISION)
    expect(calls).toEqual([])
  })

  test('"decision unchecked": the port could not read, there is no port, or it failed', async () => {
    await refusedBeforeLease(ports({ unchecked: true }), input(), UNCHECKED)
    await refusedBeforeLease(ports(), input(), UNCHECKED)
    await refusedBeforeLease(
      ports(async () => {
        throw new Error("syn129 read failed")
      }),
      input(),
      UNCHECKED,
    )
  })

  test("passes: answered by the person, attested and bound; placement join and new, then a tidy list", async () => {
    await moved(await Rehome.make(ports(placement())).run(input()))
    expect(calls).toEqual([{ mission: MISSION, ref: "D-1" }])

    const other = "2026-11-14_syn129-c06-other"
    const baru = path.join(R, "Baru")
    const result = await Rehome.make(ports(placement({ option: "new", group: "Baru" }))).run(
      input({ missionId: other, approvalMission: other, approvalRef: "D-2", to: baru, groupKind: "theme" }),
    )
    expect(result).toMatchObject({ moved: { folder: true } })
    expect((await fs.stat(path.join(baru, "docs", other))).isDirectory()).toBe(true)
  })

  test("passes: a tidy list holding {mission, group: basename(to)}", async () => {
    await moved(await Rehome.make(ports(tidy())).run(input({ approvalMission: TIDY, approvalRef: "D-3" })))
    expect(calls).toEqual([{ mission: TIDY, ref: "D-3" }])
  })

  test("exempt: a dry run never asks the port and plans as before", async () => {
    const before = sha((await tree(R)).join("\n"))
    expect(await Rehome.make(ports({ status: "open" })).run(input({ dryRun: true }))).toMatchObject({
      planned: { folder: true, createsGroup: false },
    })
    expect(await Rehome.make(ports()).run(input({ dryRun: true, approvalMission: undefined }))).toMatchObject({
      planned: { folder: true },
    })
    expect(calls).toHaveLength(0)
    expect(sha((await tree(R)).join("\n"))).toBe(before)
  })

  test("exempt: a compensating move never asks the port and moves the mission back", async () => {
    const first = await Rehome.make(ports(placement())).run(input())
    if (!("journalId" in first)) throw new Error(JSON.stringify(first))
    calls = []
    const back = await Rehome.make(ports({ status: "open" })).run(
      input({ from: path.join(R, GROUP), to: R, compensates: first.journalId, approvalMission: undefined }),
    )
    expect(back).toMatchObject({ moved: { folder: true } })
    expect(calls).toHaveLength(0)
    expect((await fs.stat(path.join(R, "docs", MISSION))).isDirectory()).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Port half: the real route in a process posed as the app's utility process (the built-in datum-studio present)

const inApp = DatumStudioMcp.current().kind === "available"

const request = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  question: "syn129 where does this mission live?",
  options: [
    { id: "join", label: "Lumen", consequence: "moves into Lumen", group: GROUP },
    { id: "new", label: "Baru", consequence: "a new group", group: "Baru", groupKind: "theme" },
    { id: "keep", label: "Keep", consequence: "stays at the root" },
  ],
  topic: "project-placement",
  status: "answered",
  requestedBy: "controller",
  createdAt: "2026-11-14T00:00:00.000Z",
  answer: { option: "join", by: "user", decision: "U1", via: "swarm-mission-control", attested: true },
  ...over,
})
const ok = (requests: unknown) => ({
  content: [{ type: "text", text: "syn129 mission" }],
  structuredContent: { ok: true, tool: "studio_mission_get", mission: { id: "syn129" }, requests },
})
const answered = (over: Record<string, unknown> = {}) => ok([request("D-1", over)])

/** One synthetic mission per case: the fake server answers per mission id (the port half's table). */
const CASES = {
  bound: answered(),
  open: answered({ status: "open", answer: undefined }),
  withdrawn: answered({ status: "withdrawn", answer: undefined }),
  controller: answered({ answer: { option: "join", by: "controller", decision: "C1" } }),
  unattested: answered({ answer: { option: "join", by: "user", decision: "U1", attested: false } }),
  "attested-string": answered({ answer: { option: "join", by: "user", decision: "U1", attested: "true" } }),
  "attested-missing": answered({ answer: { option: "join", by: "user", decision: "U1" } }),
  "by-array": answered({ answer: { option: "join", by: ["user"], decision: "U1", attested: true } }),
  "option-missing": answered({ answer: { by: "user", decision: "U1", attested: true } }),
  "group-number": answered({ options: [{ id: "join", label: "x", consequence: "x", group: 7 }] }),
  "other-id": ok([request("D-2")]),
  duplicate: ok([request("D-1"), request("D-1", { answer: { option: "keep", by: "user", decision: "U2", attested: true } })]),
  "requests-object": ok({ "D-1": request("D-1") }),
  "request-not-object": ok([request("D-1"), "D-1"]),
  "no-structured": { content: [{ type: "text", text: "answered by user, attested" }] },
  refusal: {
    content: [{ type: "text", text: "unknown mission id" }],
    structuredContent: { ok: false, tool: "studio_mission_get", code: "MISSION_NOT_FOUND" },
    isError: true,
  },
  hang: "hang",
} as const
type CaseName = keyof typeof CASES
const missionOf = (name: CaseName) => `2026-11-14_syn129-c06-${name}`

/** A synthetic stdio MCP server: `studio_mission_get` answers from the table; a `.syn129-studio-down` file in its
 * working directory (the instance folder) makes it exit before the handshake. */
const FAKE_SERVER = `
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
if (fs.existsSync(path.join(process.cwd(), ".syn129-studio-down"))) process.exit(3)
const table = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  if (message.method === "initialize")
    return send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "syn129-fake-studio", version: "0.0.0" } } })
  if (message.method === "tools/list")
    return send({ id: message.id, result: { tools: [{ name: "studio_mission_get", description: "syn129", inputSchema: { type: "object" } }] } })
  if (message.method === "tools/call") {
    const entry = table[message.params?.arguments?.mission] ?? table.__unknown
    if (entry === "hang") return
    return send({ id: message.id, result: entry })
  }
  if (message.method === "ping") return send({ id: message.id, result: {} })
  send({ id: message.id, error: { code: -32601, message: "syn129: not supported" } })
})
`

describe.skipIf(!inApp)(PORT_SUITE, () => {
  const NONCE = "r129c06-nonce-0123456789abcdefghijklmnop"
  const HEADER = "x-swarm-desktop-nonce"
  let base = ""
  let server: { script: string; table: string } = { script: "", table: "" }

  const app = () => Server.Default().app

  beforeAll(async () => {
    base = path.join(home, "app")
    await fs.mkdir(base, { recursive: true })
    const script = path.join(base, "fake-studio.mjs")
    const table = path.join(base, "fake-studio-table.json")
    await fs.writeFile(script, FAKE_SERVER)
    const entries = Object.fromEntries(Object.entries(CASES).map(([name, value]) => [missionOf(name as CaseName), value]))
    await fs.writeFile(table, JSON.stringify(entries))
    server = { script, table }
    // The app's launcher (process.resourcesPath posed by the parent): runs the synthetic server for every instance.
    const launcher = path.join(String(Reflect.get(process, "resourcesPath")), "datum-studio", "datum-studio-launcher")
    await fs.writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "${table}"\n`)
    await fs.chmod(launcher, 0o755)
    DesktopNonce.set(NONCE)
  })
  afterAll(async () => {
    await disposeAllInstances()
    DesktopNonce.set(undefined)
  })

  async function post(R: string, payload: Record<string, unknown>) {
    const response = await app().request("/project/rehome", {
      method: "POST",
      headers: { "x-opencode-directory": R, "content-type": "application/json", [HEADER]: NONCE },
      body: JSON.stringify(payload),
    })
    const text = await response.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, json }
  }

  const body = (R: string, mission: string) => ({
    missionId: mission,
    from: R,
    to: path.join(R, GROUP),
    sessions: [],
    approvalRef: "D-1",
    approvalMission: mission,
  })

  /** The instance's MCP state (built from its loaded config) and the datum-studio entry in effect for `R`. */
  async function warm(R: string) {
    const status = await app().request("/mcp", { headers: { "x-opencode-directory": R } })
    const config = await app().request("/config", { headers: { "x-opencode-directory": R } })
    return {
      status: ((await status.json()) as Record<string, { status: string }>)["datum-studio"]?.status,
      entry: ((await config.json()) as { mcp?: Record<string, { command?: string[] }> }).mcp?.["datum-studio"],
    }
  }

  async function expectRefused(R: string, mission: string, detail: string) {
    process.env.SWARM_DEFAULT_PROJECT_DIR = R
    const before = sha((await tree(path.dirname(R))).join("\n"))
    const result = await post(R, body(R, mission))
    expect(`${mission} ${result.status} ${result.json?.data?.code} ${result.json?.data?.detail}`).toBe(
      `${mission} 409 REHOME_APPROVAL_MISSING ${detail}`,
    )
    expect(sha((await tree(path.dirname(R))).join("\n"))).toBe(before)
  }

  test("the built-in server answers bound + attested: the move completes", async () => {
    const mission = missionOf("bound")
    const R = await layout(path.join(base, "bound"), [mission])
    process.env.SWARM_DEFAULT_PROJECT_DIR = R
    const effective = await warm(R)
    expect(effective.entry?.command?.[0]).toEndWith(path.join("datum-studio", "datum-studio-launcher"))
    expect(effective.status).toBe("connected")
    const result = await post(R, body(R, mission))
    expect(`${result.status} ${JSON.stringify(result.json?.moved)}`).toBe(
      `200 ${JSON.stringify({ folder: true, notes: 0, sessions: 0 })}`,
    )
    expect((await fs.stat(path.join(R, GROUP, "docs", mission))).isDirectory()).toBe(true)
  }, 30_000)

  test("a project config that redefines datum-studio is not trusted: decision unchecked, nothing moved", async () => {
    const mission = missionOf("bound")
    const R = await layout(path.join(base, "redirect"), [mission])
    // The project's own server would say "answered by the person, attested" for this very move.
    await fs.writeFile(
      path.join(R, "swarm.json"),
      JSON.stringify({
        formatter: false,
        lsp: false,
        mcp: { "datum-studio": { type: "local", command: [process.execPath, server.script, server.table] } },
      }),
    )
    const effective = await warm(R)
    // Anti-vacuity: the redefinition is in effect for this instance, and its server is up.
    expect(effective.entry?.command).toEqual([process.execPath, server.script, server.table])
    expect(effective.status).toBe("connected")
    await expectRefused(R, mission, "decision unchecked")
  }, 30_000)

  test("the built-in server is not connected: decision unchecked, nothing moved", async () => {
    const mission = missionOf("bound")
    const R = await layout(path.join(base, "down"), [mission])
    await fs.writeFile(path.join(R, ".syn129-studio-down"), "")
    expect((await warm(R)).status).toBe("failed")
    await expectRefused(R, mission, "decision unchecked")
  }, 30_000)

  test("a server that never answers: decision unchecked within 5000 ms (+1000 ms slack), nothing moved", async () => {
    const mission = missionOf("hang")
    const R = await layout(path.join(base, "hang"), [mission])
    expect((await warm(R)).status).toBe("connected")
    const start = performance.now()
    await expectRefused(R, mission, "decision unchecked")
    const elapsed = performance.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(4500)
    expect(elapsed).toBeLessThan(6000)
  }, 30_000)

  test("S9-15: open, withdrawn, controller, unattested and wrongly typed answers are refused \"decision\"", async () => {
    const names: CaseName[] = [
      "open",
      "withdrawn",
      "controller",
      "unattested",
      "attested-string",
      "attested-missing",
      "by-array",
      "option-missing",
      "group-number",
      "other-id",
      "refusal",
    ]
    const R = await layout(path.join(base, "parse"), names.map(missionOf))
    expect((await warm(R)).status).toBe("connected")
    for (const name of names) await expectRefused(R, missionOf(name), "decision")
  }, 60_000)

  test("S9-15: a duplicate request id, or a result of another shape, is \"decision unchecked\"", async () => {
    const names: CaseName[] = ["duplicate", "requests-object", "request-not-object", "no-structured"]
    const R = await layout(path.join(base, "shape"), names.map(missionOf))
    expect((await warm(R)).status).toBe("connected")
    for (const name of names) await expectRefused(R, missionOf(name), "decision unchecked")
  }, 60_000)
})

describe("C06 port half (child process posed as the app)", () => {
  test.skipIf(inApp)("the app-process suite runs and passes", async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh129c06-app-")))
    try {
      const resources = path.join(base, "Swarm.app", "Contents", "Resources")
      await fs.mkdir(path.join(resources, "datum-studio"), { recursive: true })
      await fs.writeFile(path.join(resources, "app.asar"), "")
      const launcher = path.join(resources, "datum-studio", "datum-studio-launcher")
      // Replaced by the child with the synthetic server's command; executable from the start (DatumStudioMcp checks).
      await fs.writeFile(launcher, "#!/bin/sh\nexit 3\n")
      await fs.chmod(launcher, 0o755)
      const pose = path.join(base, "pose.ts")
      await fs.writeFile(
        pose,
        `Object.defineProperty(process, "type", { value: "utility", configurable: true, writable: true })
         Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(resources)}, configurable: true, writable: true })`,
      )
      const child = Bun.spawnSync(
        [process.execPath, "test", "--preload", pose, "test/project/rel129-c06-decision-check.test.ts", "-t", PORT_SUITE],
        { cwd: path.join(import.meta.dir, "../.."), env: process.env, stdout: "pipe", stderr: "pipe" },
      )
      const output = child.stdout.toString() + child.stderr.toString()
      // The count proves the suite ran there: if the built-in were not found it would skip and exit 0.
      expect({ pass: /\b6 pass\b/.test(output), fail: /\b0 fail\b/.test(output), exit: child.exitCode, output }).toMatchObject({
        pass: true,
        fail: true,
        exit: 0,
      })
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  }, 240_000)
})
