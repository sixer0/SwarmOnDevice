// 1.2.7 row 47l (controller C79, refining U10-1): a route of Swarm's own server that runs a command or changes files
// outside the permission system, or acts in the person's UI, is the person's: `POST /session/:id/shell` (shellImpl records
// it as "executed by the user" and checks no permission), every `/tui/*` route, `/vcs/commit`, `/vcs/apply` and
// `/project/git/init`, `/global/upgrade`, `/global/dispose` and `/instance/dispose`, terminal-session writes (`/pty`) and
// attaching to one. An agent's call to them is X `own_api` with OWN_API_TEXT in every layer, root and subagent, by any
// spelling the classifier reads. `prompt_async`, session, mission and Studio routes, the commit draft and the re-run
// check (both run nothing) keep running under the consent. Synthetic values only: no server is contacted, home is a fresh
// mkdtemp folder.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { SelfAddress } from "../../src/server/self-address"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const PORT = 47197
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
  writeFileSync(path.join(dir, "cfg-shell"), `url = "${OWN}/session/ses_1/shell"\nrequest = POST\n`)
  writeFileSync(path.join(dir, "urls-tui"), `${OWN}/tui/submit-prompt\n`)
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
  home = mkdtempSync(path.join(os.tmpdir(), "47lh-"))
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
    expect({ call: label(input), layer, ownApi: verdict.category === "own_api", refused: verdict.class === "X" }).toEqual({
      call: label(input),
      layer,
      ownApi: false,
      refused: false,
    })
}

describe("C79: routes that act as the person are refused, literal forms", () => {
  test("the user's shell: POST /session/:id/shell", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/session/ses_1/shell -d '{"agent":"build","command":"rm -rf src"}'`,
      `curl -s --json '{"command":"ls"}' ${OWN}/session/ses_1/shell`,
      `http POST :${PORT}/session/ses_1/shell command=ls agent=build`,
      `wget -q --post-data='{"command":"ls"}' ${OWN}/session/ses_1/shell`,
    ])
      expectRefused(bash(command))
  })
  test("every /tui route, by any method", () => {
    for (const route of [
      "append-prompt",
      "open-help",
      "open-sessions",
      "open-themes",
      "open-models",
      "submit-prompt",
      "clear-prompt",
      "execute-command",
      "show-toast",
      "publish",
      "select-session",
      "control/response",
    ])
      expectRefused(bash(`curl -s -X POST ${OWN}/tui/${route} -d '{}'`))
    expectRefused(bash(`curl -s ${OWN}/tui/control/next`))
  })
  test("repository writes: /vcs/commit, /vcs/apply, /project/git/init", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/vcs/commit -d '{"files":["a"],"message":"m"}'`,
      `curl -s --data-binary @patch.json ${OWN}/vcs/apply`,
      `curl -s -X POST ${OWN}/project/git/init`,
    ])
      expectRefused(bash(command))
  })
  test("upgrade and dispose", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/global/upgrade -d '{"target":"9.9.9"}'`,
      `curl -s -X POST ${OWN}/global/dispose`,
      `curl -s -X POST ${OWN}/instance/dispose`,
    ])
      expectRefused(bash(command))
  })
  test("terminal sessions: creating, changing, removing one, a connect token, attaching", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/pty -d '{"command":"sh","args":["-c","id"]}'`,
      `curl -s -X PUT ${OWN}/pty/pty_1 -d '{}'`,
      `curl -s -X DELETE ${OWN}/pty/pty_1`,
      `curl -s -X POST ${OWN}/pty/pty_1/connect-token`,
      `curl -s ${OWN}/pty/pty_1/connect`,
    ])
      expectRefused(bash(command))
  })
})

describe("C79: indirect and respelled forms are refused the same way", () => {
  test("a config file, a URL list, a variable, a shell's -c, eval, a chain, a webfetch", () => {
    for (const command of [
      "curl -s -K cfg-shell",
      "wget -q -i urls-tui",
      `P=/tui/execute-command; curl -s -X POST ${OWN}$P -d '{}'`,
      `U=${OWN}; curl -s -X POST "$U/vcs/commit"`,
      `sh -c 'curl -s -X POST ${OWN}/global/upgrade'`,
      `eval "curl -s -X POST ${OWN}/instance/dispose"`,
      `curl -s ${OWN}/session && curl -s -X POST ${OWN}/session/ses_1/shell -d '{}'`,
    ])
      expectRefused(bash(command))
    expectRefused(fetchOf(`${OWN}/tui/control/next`))
  })
  test("dot segments, percent-encoding, case, a prefix, a trailing slash", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/session/../vcs/apply`,
      `curl -s -X POST ${OWN}/%74ui/submit-prompt`,
      `curl -s -X POST ${OWN}/TUI/Execute-Command`,
      `curl -s -X POST ${OWN}//session//ses_1//shell/`,
      `curl -s -X POST ${OWN}/experimental/workspace/w1/global/upgrade`,
    ])
      expectRefused(bash(command))
  })
})

describe("C79: session, mission and Studio routes keep running under the consent", () => {
  test("prompt_async, prompt, messages, the commit draft, the re-run check, vcs reads, the pty list", () => {
    for (const command of [
      `curl -s -X POST ${OWN}/session/ses_1/prompt_async -d '{"parts":[]}'`,
      `curl -s -X POST ${OWN}/session/ses_1/message -d '{"parts":[]}'`,
      `curl -s ${OWN}/session/ses_1/message`,
      `curl -s -X POST ${OWN}/session -d '{}'`,
      `curl -s -X POST ${OWN}/vcs/commit-draft -d '{"files":["a"]}'`,
      `curl -s -X POST ${OWN}/shell/rerunnable -d '{"commands":["ls"]}'`,
      `curl -s ${OWN}/vcs/status`,
      `curl -s ${OWN}/vcs/diff`,
      `curl -s ${OWN}/pty`,
      `curl -s ${OWN}/global/health`,
    ])
      expectRuns(bash(command))
    expectRuns(fetchOf(`${OWN}/session/ses_1/message`))
  })
})
