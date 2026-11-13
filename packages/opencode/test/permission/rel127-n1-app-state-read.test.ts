// 1.2.7 row 29b (N-1, N7-091; SR OP-2, SR7-01, SR7-07, SR7-20, K7-06). A look at Swarm's own state or settings that the
// OP-2 allowlist takes (names and metadata, and `cat`/`head`/`tail` of a literal name) runs as A `protected_read`, its
// output masked. Everything else that reaches app state by any spelling (after `cd`, relative, `~`, a glob, a content
// search on a folder above it) stays X `app_state`, whose text now names the looks that run. Synthetic values only: the
// state, config and data folders are the test run's (preload), home is a fresh mkdtemp folder, and the real
// `app-server.env` is never read.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { AutonomyTexts } from "../../src/permission/autonomy-texts"
import type { InstanceContext } from "../../src/project/instance-context"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { Instruction } from "../../src/session/instruction"
import { MessageID, SessionID } from "../../src/session/schema"
import { ShellTool, readSteps } from "../../src/tool/shell"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const APP_STATE: Verdict = { class: "X", decidedBy: "gate", category: "app_state" }
const PROTECTED_READ: Verdict = { class: "A", decidedBy: "gate", category: "protected_read" }
// K7-06 (N7-050).
const APP_STATE_TEXT =
  "This call did not run. Autonomous mode never changes Swarm's own state or settings. To look at those files, use the Read tool or an inspection command such as ls, cat or head; reading them is allowed. Write what should change into your final message for the person."

// Synthetic values. None has a shape the fixed SHAPES list knows.
const PASSWORD = "Pq7wZr3kTn9xLm2vBc8dHf4jSy6aGe1u"
const API_KEY = "Qx4Lr8Tn2Wv6Zb9Kc3Mf7Hd1Js5Pg0YaRe2Uo8Nk" // 40 characters
const AUTH_HEADER = "Bearer Hk3Lp9Wq2Zx7Tn4Rv8Mc1Bd6Fs5Jg0Ya"
const MCP_TOKEN = "Mn5Tq8Wr2Zk7Lx4Pv9Hc3Bd6Fj"

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let homeConfig: string
let spies: { mockRestore(): void }[] = []
const savedConfigDir = process.env.SWARM_CONFIG_DIR
const state = () => path.join(process.env.XDG_STATE_HOME!, "swarm")
const config = () => Global.Path.config

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  writeFileSync(path.join(dir, "guess.txt"), "PASSWORD=Pq\n")
  writeFileSync(path.join(dir, "notes.txt"), "notes\n")
  // Hermetic home (row 29d method): both `os.homedir` spellings the source uses, and a Swarm config folder in it.
  home = mkdtempSync(path.join(os.tmpdir(), "n1-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  homeConfig = path.join(home, ".config", "swarm")
  mkdirSync(homeConfig, { recursive: true })
  writeFileSync(path.join(homeConfig, "secret.env"), `PASSWORD=${PASSWORD}\n`)
  process.env.SWARM_CONFIG_DIR = homeConfig
  mkdirSync(state(), { recursive: true })
  writeFileSync(path.join(state(), "app-server.env"), `PASSWORD=${PASSWORD}\n`)
  mkdirSync(config(), { recursive: true })
  writeFileSync(
    path.join(config(), "swarm.jsonc"),
    [
      "{",
      "  // synthetic",
      '  "provider": {',
      '    "tail": {',
      '      "options": {',
      `        "apiKey": "${API_KEY}",`,
      '        "headers": {',
      `          "Authorization": "${AUTH_HEADER}"`,
      "        }",
      "      }",
      "    }",
      "  },",
      '  "mcp": {',
      '    "srv": {',
      '      "type": "local",',
      '      "command": ["true"],',
      '      "enabled": false,',
      '      "environment": {',
      `        "GITHUB_TOKEN": "${MCP_TOKEN}"`,
      "      }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
  )
})
afterAll(async () => {
  for (const spy of spies) spy.mockRestore()
  if (savedConfigDir === undefined) delete process.env.SWARM_CONFIG_DIR
  else process.env.SWARM_CONFIG_DIR = savedConfigDir
  rmSync(home, { recursive: true, force: true })
  rmSync(path.join(state(), "app-server.env"), { force: true })
  rmSync(path.join(config(), "swarm.jsonc"), { force: true })
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
const bash = (command: string) => request("bash", { patterns: [command], metadata: { command, workdir: dir } })
// The folder prompt the shell sends beside the call, as `tool/shell.ts` shapes it.
const folderPrompt = (command: string, folder: string) =>
  request("external_directory", {
    patterns: [path.join(folder, "*")],
    metadata: { command, workdir: dir, directories: [folder], patterns: [path.join(folder, "*")] },
    follows: [{ permission: "bash" }],
  })
const layers = (input: Input): [string, Verdict][] => [
  ["base", AutonomyTable.classify(input)],
  ["consent", AutonomyTable.classify({ ...input, bypass: { caller: "root" } })],
  ["consent, subagent", AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })],
]
const expectVerdict = (input: Input, expected: Verdict) => {
  for (const [layer, verdict] of layers(input)) {
    const { class: kind, decidedBy, category } = verdict
    expect({ layer, class: kind, decidedBy, category } as Record<string, unknown>).toEqual({ layer, ...expected })
  }
}
const expectNotAppState = (input: Input) => {
  for (const [layer, verdict] of layers(input)) expect({ layer, category: verdict.category }).not.toEqual({ layer, category: "app_state" })
}

describe("N1-R1: a look at Swarm's own settings runs as A protected_read", () => {
  test("`ls -lt <config root>`", () => expectVerdict(bash(`ls -lt ${config()}`), PROTECTED_READ))
  test("`ls -lt ~/.config/swarm`", () => expectVerdict(bash("ls -lt ~/.config/swarm"), PROTECTED_READ))
  test("`cat <config root>/swarm.jsonc`", () => expectVerdict(bash(`cat ${path.join(config(), "swarm.jsonc")}`), PROTECTED_READ))
  test("metadata looks: stat, du, wc, file, tree, find, checksum, mdls", () => {
    for (const command of [
      `stat ${config()}`,
      `du -sh ${config()}`,
      `wc -l ${path.join(config(), "swarm.jsonc")}`,
      `file ${path.join(config(), "swarm.jsonc")}`,
      `find ${config()} -name swarm.jsonc`,
      `shasum -a 256 ${path.join(config(), "swarm.jsonc")}`,
      `head -n 3 ${path.join(config(), "swarm.jsonc")}`,
      `tail -n 3 ${path.join(config(), "swarm.jsonc")}`,
      `cd ${config()} && ls -la`,
    ])
      expectVerdict(bash(command), PROTECTED_READ)
  })
})

describe("N1-R2: the shell's folder prompt for the same look passes", () => {
  test("`ls -lt <config root>`", () => expectVerdict(folderPrompt(`ls -lt ${config()}`, config()), PROTECTED_READ))
  test("`ls -lt ~/.config/swarm`", () => expectVerdict(folderPrompt("ls -lt ~/.config/swarm", homeConfig), PROTECTED_READ))
  test("`cat <config root>/swarm.jsonc`", () =>
    expectVerdict(folderPrompt(`cat ${path.join(config(), "swarm.jsonc")}`, config()), PROTECTED_READ))
})

describe("N1-R3: `cat <state>/swarm/app-server.env` is judged a read (its output is masked below)", () => {
  test("A protected_read", () => expectVerdict(bash(`cat ${path.join(state(), "app-server.env")}`), PROTECTED_READ))
})

describe("SR7-01: counting, offset and dump oracles on app state stay X app_state (OP-2 allowlist on resolved operands)", () => {
  const env = () => path.join(state(), "app-server.env")
  const forms = () => [
    `grep -c '^PASSWORD=Pq' ${env()}`,
    `grep -q PASSWORD=P ${env()}`,
    `grep -l PASSWORD ${env()}`,
    `cmp guess.txt ${env()}`,
    `diff guess.txt ${env()}`,
    `cut -c1-12 ${env()}`,
    `cut -c1-12 ${path.join(state(), "*.env")}`,
    // A glob that names no root by its spelling (1.2.6 residual R-1).
    "cut -c1-12 ~/.con*/sw*/secret.env",
    "cat ~/.con*/swarm/secret.env",
    // `cd` into the folder above the state root, then a relative name.
    `cd ${path.dirname(state())} && grep -c PASSWORD=P swarm/app-server.env`,
    `cd ${path.dirname(state())} && cut -c1-12 swarm/app-server.env`,
    "cd ~/.config && grep -c PASSWORD=P swarm/secret.env",
    // INTENT row 47j (U9-6, C76): a content search over a FOLDER that holds app state (`rg PASSWORD ~`, `rg -c PASSWORD
    // ~/.config`, `grep -r PASSWORD <state>`) runs under the consent now; it moved to the describe below. A state file stays.
    "grep PASSWORD ~/.config/swarm/secret.env",
    `xxd ${env()}`,
    `od -c ${env()}`,
    `hexdump -C ${env()}`,
    `strings ${env()}`,
    `head -c 12 ${env()}`,
    `tail -c 12 ${env()}`,
    `sort ${env()}`,
    `tr a-z n-za-m < ${env()}`,
    `rev ${env()}`,
    `cat ${env()} | rev`,
    `cat ${env()} > copy.txt`,
    `cat $XDG_STATE_HOME/swarm/app-server.env`,
  ]
  for (const index of Array.from({ length: 25 }, (_, i) => i))
    test(`oracle form ${index + 1}`, () => {
      const command = forms()[index]!
      expectVerdict(bash(command), APP_STATE)
    })
  test("the X text names the looks that run (K7-06)", () => {
    expect(AutonomyTexts.REFUSED_TEXT.app_state).toBe(APP_STATE_TEXT)
    expect(AutonomyTexts.consentedRefusalText("app_state")).toStartWith(APP_STATE_TEXT)
  })
})

// INTENT row 47j (U9-6, C76; supersedes SR7-01 for these forms as the person ruled): a content search over folders that
// hold app state is X app_state without the consent (autonomous mode on, nothing consented) and is no app_state refusal
// under it, for the root and a subagent; a read role keeps it refused (U4). The shell's own reading is given, as the gate
// gets it. What it prints is masked (below, SR7-07 / U9-6).
describe("U9-6: a content search over folders holding app state runs under the consent", () => {
  const steps = (command: string) => readSteps(command, dir)
  const forms = () => ["rg PASSWORD ~", "rg -c PASSWORD ~/.config", `grep -r PASSWORD ${state()}`, `rg PASSWORD ${home}`]
  for (const index of [0, 1, 2, 3])
    test(`folder search ${index + 1}`, async () => {
      const command = forms()[index]!
      const read = await steps(command)
      expect(read).toBeDefined()
      const input = request("bash", { patterns: [command], metadata: { command, workdir: dir, steps: read } })
      expect({ command, category: AutonomyTable.classify(input).category }).toEqual({ command, category: "app_state" })
      for (const caller of ["root", "subagent"] as const) {
        const verdict = AutonomyTable.classify({ ...input, bypass: { caller } })
        expect({ command, caller, class: verdict.class, category: verdict.category }).not.toEqual({
          command,
          caller,
          class: "X",
          category: "app_state",
        })
        expect({ command, caller, runs: verdict.class === "A" }).toEqual({ command, caller, runs: true })
      }
      const planner = AutonomyTable.classify({ ...input, bypass: { caller: "subagent" }, agent: "planner" })
      expect({ command, category: planner.category }).toEqual({ command, category: "app_state" })
    })
})

describe("writes into app state stay X app_state (CHAR-06)", () => {
  test("redirect, append, tee, and `sh -c`", () => {
    for (const command of [
      `echo x > ${path.join(config(), "tool-health.json")}`,
      "echo x >> ~/.config/swarm/secret.env",
      `cat notes.txt | tee ${path.join(config(), "x.json")}`,
      `cd ${config()} && touch x.json`,
      `cp notes.txt ${config()}/`,
    ])
      expectVerdict(bash(command), APP_STATE)
  })
})

describe("SR7-20: parse differences around an app-state look are never read-only", () => {
  const env = () => path.join(state(), "app-server.env")
  const forms = () => [
    `cat $(echo ${env()})`,
    `cat \`echo ${env()}\``,
    `cat <(cat ${env()})`,
    `cat <<< ${env()}`,
    `cat ${env()} &> out.txt`,
    `cat ${env()}; echo done`,
    `cat ${env()} || echo no`,
    `cat ${env()} &`,
    `X=1 cat ${env()}`,
    `cat ${env()}\r`,
    `cat ${env()}\u0000`,
    `cat ${env()} >| out.txt`,
    `cat ${env()} |& tee out.txt`,
    `! cat ${env()}`,
    `{ cat ${env()}; }`,
    `exec cat ${env()}`,
    `command cat ${env()}`,
    `builtin cat ${env()}`,
    `cat ${env()} \\\n> out.txt`,
    `cat ${env()} # > out.txt`,
    `cat ${env()} 2> out.txt`,
  ]
  for (const index of Array.from({ length: 21 }, (_, i) => i))
    test(`form ${index + 1}`, () => {
      const command = forms()[index]!
      expect(AutonomyTable.isReadOnlyShell(command, dir, instance)).toBe(false)
      expectVerdict(bash(command), APP_STATE)
    })
})

describe("controls: looks that do not reach app state keep their verdicts", () => {
  test("`ls ~`, `find ~ -name x`, `ls ~/.config`, `cat notes.txt` are not app_state", () => {
    for (const command of ["ls ~", "find ~ -name x.txt", "ls -la ~/.config", "cat notes.txt", "grep notes notes.txt", "du -sh ~"])
      expectNotAppState(bash(command))
  })
})

// SR7-07: the shell's own output masking for the newly allowed reads (CHAR-01).
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        Instruction.node,
        LSP.node,
        Ripgrep.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)
afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_rel127n1"),
  messageID: MessageID.make("msg_rel127n1"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  trust: { canUndo: true },
  ask: () => Effect.void,
}

const shell = (command: string, prepare?: (dir: string) => void) =>
  Effect.gen(function* () {
    const project = yield* tmpdirScoped()
    prepare?.(project)
    const live: string[] = []
    const result = yield* Effect.gen(function* () {
      const tool = yield* (yield* ShellTool).init()
      return yield* tool.execute(
        { command },
        {
          ...ctx,
          metadata: (value: { metadata?: { output?: string } }) =>
            Effect.sync(() => void live.push(String(value.metadata?.output ?? ""))),
        } as never,
      )
    }).pipe(provideInstance(project))
    return [result.output, JSON.stringify(result.metadata), ...live].join("\n")
  })

/** No 6-character piece of the value shows anywhere the model or the transcript can read. */
const noPiece = (text: string, value: string) => {
  const leaked: string[] = []
  for (let index = 0; index + 6 <= value.length; index++) if (text.includes(value.slice(index, index + 6))) leaked.push(value.slice(index, index + 6))
  expect(leaked).toEqual([])
}

describe("SR7-07 / N1-R3: what an allowed app-state read prints is masked", () => {
  it.live("`cat <state>/swarm/app-server.env` shows [hidden:PASSWORD]", () =>
    shell(`cat ${path.join(state(), "app-server.env")}`).pipe(
      Effect.map((text) => {
        expect(text).toContain("[hidden:PASSWORD]")
        noPiece(text, PASSWORD)
      }),
    ),
  )
  for (const command of ["cat", "head -n 40"])
    it.live(`\`${command} <config>/swarm.jsonc\`: apiKey, Authorization and the MCP env token are [hidden:…]`, () =>
      shell(`${command} ${path.join(config(), "swarm.jsonc")}`).pipe(
        Effect.map((text) => {
          expect(text).toContain('"provider"')
          expect(text).toContain("[hidden:")
          noPiece(text, API_KEY)
          noPiece(text, AUTH_HEADER.slice("Bearer ".length))
          noPiece(text, MCP_TOKEN)
        }),
      ),
    )
  // Row 47j (U9-6): a content search over a folder holding app state prints the matching lines with their values masked.
  // Each case writes a value of its own that nothing before it read (so no earlier read taught the masker it), into a
  // state file only the search names. The home folder is the test's own, named by its absolute path (the shell's `~`
  // would be the real one); rg skips the hidden `.config` unless told not to.
  const SEARCHED = [
    ["rg --hidden SEARCH_TOKEN <home>", () => homeConfig, "Wd4Kq9Zt2Lm7Rx5Vb8Nc3Hp6"],
    ["grep -r SEARCH_TOKEN <home>/.config", () => homeConfig, "Tz8Mv3Qw6Kd1Lr9Xb4Np7Hc2"],
    ["rg -n SEARCH_TOKEN <state>", state, "Gq2Ws7Ry4Lk9Zm3Xt6Bv8Hn1"],
  ] as const
  for (const [form, where, value] of SEARCHED)
    it.live(`\`${form}\` shows the line with [hidden:SEARCH_TOKEN]`, () => {
      const file = () => path.join(where(), "search.env")
      return Effect.acquireUseRelease(
        Effect.sync(() => writeFileSync(file(), `SEARCH_TOKEN=${value}\n`)),
        () =>
          shell(form.replace("<home>", home).replace("<state>", state())).pipe(
            Effect.map((text) => {
              expect(text).toContain("SEARCH_TOKEN=[hidden:SEARCH_TOKEN]")
              noPiece(text, value)
            }),
          ),
        () => Effect.sync(() => rmSync(file(), { force: true })),
      )
    })
  it.live("a project symlink to app-server.env, read with `cat`, is masked (kind by real path)", () =>
    shell("cat link.txt", (project) => symlinkSync(path.join(state(), "app-server.env"), path.join(project, "link.txt"))).pipe(
      Effect.map((text) => {
        expect(text).toContain("[hidden:PASSWORD]")
        noPiece(text, PASSWORD)
      }),
    ),
  )
  for (const name of ["auth.json", "mcp-auth.json"])
    it.live(`\`cat <data>/${name}\` is withheld whole`, () => {
      const file = path.join(Global.Path.data, name)
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          mkdirSync(Global.Path.data, { recursive: true })
          writeFileSync(file, JSON.stringify({ srv: { type: "api", key: API_KEY, accessToken: MCP_TOKEN } }, null, 2))
        }),
        () =>
          shell(`cat ${file}`).pipe(
            Effect.map((text) => {
              expect(text).toContain(`[hidden:${name}]`)
              noPiece(text, API_KEY)
              noPiece(text, MCP_TOKEN)
            }),
          ),
        () => Effect.sync(() => rmSync(file, { force: true })),
      )
    })
})
