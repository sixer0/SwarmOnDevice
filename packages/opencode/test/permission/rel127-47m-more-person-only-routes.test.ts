// 1.2.7 row 47m (controller C80, same principle as row 47l): more routes of Swarm's own server that change files or start
// programs outside the permission system are the person's: experimental worktree create/remove/reset, session revert and
// unrevert, workspace warp and remove, sync steal, MCP add (POST /mcp) and connect. An agent's call to them is X `own_api`
// in every layer, by a literal and by indirect spellings. Their reads (worktree list, MCP status, workspace list/status)
// and the neighbouring routes (workspace create, sync-list) keep running under the consent. OWN_API_UNRESOLVED_TEXT says
// agents may call Swarm's server, like OWN_API_TEXT (INTENT pin). Synthetic values only: no server is contacted.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import * as Texts from "../../src/permission/autonomy-texts"
import type { InstanceContext } from "../../src/project/instance-context"
import { SelfAddress } from "../../src/server/self-address"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const PORT = 47198
const SELF = { hostname: "127.0.0.1", port: PORT }
const OWN = `http://127.0.0.1:${PORT}`
const OWN_API: Verdict = { class: "X", decidedBy: "gate", category: "own_api" }

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []
const savedEnv = { CURL_HOME: process.env.CURL_HOME, WGETRC: process.env.WGETRC }

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  writeFileSync(path.join(dir, "cfg-revert"), `url = "${OWN}/session/ses_1/revert"\nrequest = POST\n`)
  writeFileSync(path.join(dir, "urls-steal"), `${OWN}/sync/steal\n`)
  delete process.env.CURL_HOME
  delete process.env.WGETRC
})
afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv))
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  await fixture[Symbol.asyncDispose]()
})
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "47mh-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  SelfAddress.add(SELF)
})
afterEach(() => {
  SelfAddress.remove(SELF)
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
})

const request = (permission: string, fields: Partial<Input> = {}): Input => ({
  permission,
  patterns: ["*"],
  metadata: {},
  instance,
  cwd: dir,
  canUndo: true,
  folder: "clean",
  ...fields,
})
const bash = (command: string) => request("bash", { patterns: [command], metadata: { command } })
const fetchOf = (url: string) => request("webfetch", { patterns: [url], metadata: { url } })
const layers = (input: Input): [string, Verdict][] => [
  ["base", AutonomyTable.classify(input)],
  ["consent", AutonomyTable.classify({ ...input, bypass: { caller: "root" } })],
  ["consent-subagent", AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })],
]
const label = (input: Input) => String(input.metadata.command ?? input.metadata.url)
const expectRefused = (input: Input) => {
  for (const [layer, verdict] of layers(input))
    expect({ call: label(input), layer, ...verdict }).toEqual({ call: label(input), layer, ...OWN_API })
}
const expectRuns = (input: Input) => {
  for (const [layer, verdict] of layers(input))
    expect({ call: label(input), layer, ownApi: verdict.category === "own_api" }).toEqual({
      call: label(input),
      layer,
      ownApi: false,
    })
}

describe("C80: routes that change files or start programs outside permissions are refused, literal forms", () => {
  test("worktree create, remove, reset", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/experimental/worktree -d '{}'`,
      `curl -s -X DELETE ${OWN}/experimental/worktree -d '{"directory":"x"}'`,
      `curl -s -X POST ${OWN}/experimental/worktree/reset -d '{"directory":"x"}'`,
    ])
      expectRefused(bash(command))
  })
  test("session revert and unrevert", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/session/ses_1/revert -d '{"messageID":"msg_1"}'`,
      `curl -s -X POST ${OWN}/session/ses_1/unrevert`,
    ])
      expectRefused(bash(command))
  })
  test("workspace warp and remove", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/experimental/workspace/warp -d '{"id":null,"sessionID":"ses_1"}'`,
      `curl -s -X DELETE ${OWN}/experimental/workspace/wrk_1`,
    ])
      expectRefused(bash(command))
  })
  test("sync steal", () => expectRefused(bash(`curl -s -X POST ${OWN}/sync/steal -d '{}'`)))
  test("MCP add and connect", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/mcp -d '{"name":"m","config":{"type":"local","command":["sh"]}}'`,
      `curl -s -X POST ${OWN}/mcp/m/connect`,
    ])
      expectRefused(bash(command))
  })
})

describe("C80: indirect and respelled forms are refused the same way", () => {
  test("a config file, a URL list, a variable, a shell's -c, eval, a chain, a webfetch", () => {
    for (const command of [
      "curl -s -K cfg-revert",
      "wget -q --post-data=x -i urls-steal",
      `P=/experimental/worktree/reset; curl -s -X POST ${OWN}$P -d '{}'`,
      `U=${OWN}; curl -s -X POST "$U/mcp/m/connect"`,
      `sh -c 'curl -s -X POST ${OWN}/session/ses_1/revert'`,
      `eval "curl -s -X DELETE ${OWN}/experimental/workspace/wrk_1"`,
      `curl -s ${OWN}/session && curl -s -X POST ${OWN}/mcp -d '{}'`,
    ])
      expectRefused(bash(command))
    expectRefused(request("webfetch", { patterns: [`${OWN}/sync/steal`], metadata: { url: `${OWN}/sync/steal`, method: "POST" } }))
  })
  test("dot segments, percent-encoding, case, a prefix, a trailing slash", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/session/../experimental/worktree`,
      `curl -s -X POST ${OWN}/%73ync/steal`,
      `curl -s -X POST ${OWN}/Session/ses_1/UNREVERT`,
      `curl -s -X POST ${OWN}//experimental//workspace//warp/`,
      `curl -s -X POST ${OWN}/experimental/workspace/w1/mcp`,
    ])
      expectRefused(bash(command))
  })
})

describe("C80: reads and neighbouring routes keep running under the consent", () => {
  test("worktree list, MCP status, workspace list, status and create, sync-list", () => {
    for (const command of [
      `curl -s ${OWN}/experimental/worktree`,
      `curl -s ${OWN}/mcp`,
      `curl -s ${OWN}/experimental/workspace`,
      `curl -s ${OWN}/experimental/workspace/status`,
      `curl -s -X POST ${OWN}/experimental/workspace -d '{}'`,
      `curl -s -X POST ${OWN}/experimental/workspace/sync-list -d '{}'`,
      `curl -s -X POST ${OWN}/session/ses_1/prompt_async -d '{"parts":[]}'`,
    ])
      expectRuns(bash(command))
    expectRuns(fetchOf(`${OWN}/mcp`))
  })
})

describe("C80: OWN_API_UNRESOLVED_TEXT (INTENT)", () => {
  test("says agents may call Swarm's server, and that an unreadable route is refused because it might be person-only", () => {
    expect(Texts.OWN_API_UNRESOLVED_TEXT).toContain("Agents may call Swarm's own server")
    expect(Texts.OWN_API_UNRESOLVED_TEXT).toContain("might be a route that acts as the person")
    expect(Texts.OWN_API_UNRESOLVED_TEXT).not.toContain("never calls Swarm's own server")
  })
})
