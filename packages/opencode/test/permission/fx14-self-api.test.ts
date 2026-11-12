// 1.2.6 row FX-14 (decision C24; row 117 findings F-1, F-2). Probe forms of verification/02_security.md section 3.2.
// F-2: a `~`, `$HOME` or `${HOME}` spelling of Swarm's own state is judged as the absolute spelling is: X `app_state` in
// both autonomous layers (C8). F-1: a shell or fetch call to the running Swarm server's own host and port is X
// `app_state`; every other loopback port keeps its verdict (C19c). Synthetic values only; no server is contacted here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
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
