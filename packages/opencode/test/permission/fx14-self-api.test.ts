// 1.2.6 row FX-14 (decision C24; row 117 findings F-1, F-2). Probe forms of verification/02_security.md section 3.2.
// F-2: a `~`, `$HOME` or `${HOME}` spelling of Swarm's own state is judged as the absolute spelling is: X `app_state` in
// both autonomous layers (C8). F-1: a shell or fetch call to the running Swarm server's own host and port is X
// `app_state`; every other loopback port keeps its verdict (C19c). Synthetic values only; no server is contacted here.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { SelfAddress } from "../../src/server/self-address"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const APP_STATE: Verdict = { class: "X", decidedBy: "gate", category: "app_state" }
const home = Global.Path.home
// The places as `~` spells them in this run (the pinned home; the state folders sit beside it, as `..` shows).
const fromHome = (file: string) => path.relative(home, file)
const toolHealth = () => fromHome(path.join(Global.Path.config, "tool-health.json"))
const serverEnv = () => fromHome(path.join(process.env.XDG_STATE_HOME!, "swarm", "app-server.env"))

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.writeFileSync(path.join(dir, "th.json"), "{}\n")
})
afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
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
const layers = (input: Input): [string, Verdict][] => [
  ["base", AutonomyTable.classify(input)],
  ["consent", AutonomyTable.classify({ ...input, bypass: { caller: "root" } })],
]
const expectAppState = (input: Input) => {
  for (const [layer, verdict] of layers(input)) expect({ layer, ...verdict }).toEqual({ layer, ...APP_STATE })
}
// 1.2.7 row 31 (F-4, CHAR-03 INTENT): the own-API refusal has its own category; the refusal, spellings and controls stay.
const OWN_API: Verdict = { class: "X", decidedBy: "gate", category: "own_api" }
const expectOwnApi = (input: Input) => {
  for (const [layer, verdict] of layers(input)) expect({ layer, ...verdict }).toEqual({ layer, ...OWN_API })
}
const expectNotOwnApi = (input: Input) => {
  for (const [layer, verdict] of layers(input)) expect({ layer, category: verdict.category }).not.toEqual({ layer, category: "own_api" })
}
const expectNotAppState = (input: Input) => {
  for (const [layer, verdict] of layers(input)) expect({ layer, category: verdict.category }).not.toEqual({ layer, category: "app_state" })
}

describe("F-2: home spellings of Swarm's own state are X app_state (C8)", () => {
  test("probe: `cat th.json > ~/…/tool-health.json`", () => expectAppState(bash(`cat th.json > ~/${toolHealth()}`)))
  test("probe: `$HOME/…/tool-health.json`", () => expectAppState(bash(`cat th.json > $HOME/${toolHealth()}`)))
  test("probe: `${HOME}/…/tool-health.json`, quoted", () => expectAppState(bash(`cat th.json > "\${HOME}/${toolHealth()}"`)))
  test("probe: `tee ~/…/tool-health.json`", () => expectAppState(bash(`cat th.json | tee ~/${toolHealth()}`)))
  test("probe (F-1 step 1): `cut … ~/…/app-server.env > pw.txt`", () =>
    expectAppState(bash(`cut -d= -f2 ~/${serverEnv()} > pw.txt`)))
  test("probe: `sed … ~/…/app-server.env > cfg.txt`", () =>
    expectAppState(bash(`sed 's/^PASSWORD=/user = opencode:/;t;d' ~/${serverEnv()} > cfg.txt`)))
  test("control: a home spelling outside Swarm's state keeps its verdict", () => {
    expectNotAppState(bash("ls ~"))
    expectNotAppState(bash("cat ~/notes.txt"))
    expectNotAppState(bash("cat th.json > ~/notes.txt"))
    expectNotAppState(bash("echo $HOMEDIR/x"))
  })
})

describe("F-1: a call to the running Swarm server's own address is X own_api (1.2.7 F-4 INTENT, was app_state)", () => {
  const self = { hostname: "127.0.0.1", port: 4096 }
  beforeAll(() => SelfAddress.add(self))
  afterEach(() => SelfAddress.add(self))
  afterAll(() => SelfAddress.remove(self))

  test("probe: `curl -s -K cfg.txt http://127.0.0.1:4096/session`", () =>
    expectOwnApi(bash("curl -s -K cfg.txt http://127.0.0.1:4096/session")))
  test("probe: `curl -s -u \"opencode:$PASSWORD\" http://127.0.0.1:4096/session`", () =>
    expectOwnApi(bash('curl -s -u "opencode:$PASSWORD" http://127.0.0.1:4096/session')))
  test("other spellings of the same listener", () => {
    for (const command of [
      "curl -s http://localhost:4096/session",
      "curl -s localhost:4096/global/health",
      "curl -s http://[::1]:4096/session",
      "curl -s http://0.0.0.0:4096/session",
      "wget -qO- http://127.0.0.2:4096/",
      "http POST :4096/session",
      "exec 3<>/dev/tcp/127.0.0.1/4096",
      "nc 127.0.0.1 4096",
      "cd /tmp && curl -s 'http://127.0.0.1:4096/permission' | head",
    ])
      expectOwnApi(bash(command))
  })
  test("a webfetch of the listener", () =>
    expectOwnApi(request("webfetch", { patterns: ["http://127.0.0.1:4096/session"], metadata: { url: "http://127.0.0.1:4096/session" } })))
  test("control: other loopback ports keep their verdict (FLUX 7863, SearXNG, a dev server)", () => {
    for (const command of [
      "curl -s http://127.0.0.1:7863/health",
      "curl -s 'http://127.0.0.1:8888/search?q=x'",
      "curl -s http://127.0.0.1:40960/",
      "curl -s http://localhost:14096/",
      "head -c 4096 th.json",
      "ls /4096",
    ])
      expectNotOwnApi(bash(command))
  })
  test("control: once the listener stopped, the same call keeps its verdict", () => {
    SelfAddress.remove(self)
    expectNotOwnApi(bash("curl -s http://127.0.0.1:4096/session"))
  })
})
