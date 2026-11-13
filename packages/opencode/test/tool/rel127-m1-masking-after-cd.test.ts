// 1.2.7 row 47b (M1-02, M1-14; AC-N1, SR7-07, U16): the shell's output masking resolves the files a command reads after
// its `cd` chain, as the permission table does for the same N-1 read. Before this row, `cd <config root> && cat swarm.jsonc`
// printed a 26-character MCP token in clear: the scan resolved `swarm.jsonc` in the call's folder, learned nothing, and
// only shape heuristics ran. Synthetic values only; the config, state and home folders are the test run's (preload) or a
// fresh mkdtemp folder, and `os.homedir` and HOME are pointed at it, so no real file is read or written.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
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
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { Instruction } from "../../src/session/instruction"
import { MessageID, SessionID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import { Secrets } from "../../src/tool/secrets"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Synthetic, 26 characters: shorter than LONG_TOKEN's 32, and no shape the SHAPES list knows. A fresh one per case:
// `Secrets.learn` keeps what it learned for the whole process, so a shared value would be masked because an earlier case
// learned it, not because this case's read was resolved.
const fresh = () => `Q${randomUUID().replaceAll("-", "").slice(0, 24)}z`
const UNSET = "SWARM_M1_47B_UNSET_DIR"

const config = () => Global.Path.config
const state = () => path.join(process.env.XDG_STATE_HOME!, "swarm")
let home: string
let homeConfig: string
let spies: { mockRestore(): void }[] = []
const savedHome = process.env.HOME
const settings = (token: string) => [
  "{",
  "  // synthetic",
  '  "mcp": {',
  '    "srv": {',
  '      "type": "local",',
  '      "command": ["true"],',
  '      "enabled": false,',
  '      "environment": {',
  `        "GITHUB_TOKEN": "${token}"`,
  "      }",
  "    }",
  "  }",
  "}",
  "",
].join("\n")

beforeAll(() => {
  delete process.env[UNSET]
  home = mkdtempSync(path.join(os.tmpdir(), "m1b-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  // The spawned shell expands `~` and `$HOME` from HOME, so it points at the same temporary home.
  process.env.HOME = home
  homeConfig = path.join(home, "m1cfg")
  mkdirSync(homeConfig, { recursive: true })
  mkdirSync(config(), { recursive: true })
  mkdirSync(state(), { recursive: true })
})
afterAll(() => {
  for (const spy of spies) spy.mockRestore()
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
  rmSync(path.join(config(), "swarm.jsonc"), { force: true })
  rmSync(path.join(state(), "app-server.env"), { force: true })
})

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
  sessionID: SessionID.make("ses_rel127m1b"),
  messageID: MessageID.make("msg_rel127m1b"),
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

/** Writes a settings file with a fresh token where it is read from, and returns a check that it shows masked. */
const settingsAt = (folder: string) => {
  const token = fresh()
  writeFileSync(path.join(folder, "swarm.jsonc"), settings(token))
  return (text: string) => {
    expect(text).toContain("[hidden:GITHUB_TOKEN]")
    noPiece(text, token)
  }
}
const configRead = (command: string) => {
  let check = (_: string) => {}
  return shell(command, () => void (check = settingsAt(config()))).pipe(
    Effect.map((text) => {
      check(text)
      return text
    }),
  )
}

describe("M1-02: swarm.jsonc read after the cd chain is masked [hidden:GITHUB_TOKEN]", () => {
  // CHAR at HEAD-before (row 29b masked the absolute form); red at 04067a9d02, which predates 29b.
  it.live("absolute: `cat <config root>/swarm.jsonc`", () =>
    configRead(`cat ${path.join(config(), "swarm.jsonc")}`).pipe(Effect.map((text) => expect(text).toContain('"mcp"'))),
  )
  it.live("`cd <config root> && cat swarm.jsonc`", () =>
    configRead(`cd ${config()} && cat swarm.jsonc`).pipe(Effect.map((text) => expect(text).toContain('"mcp"'))),
  )
  it.live("`cd <config root>; cat ./swarm.jsonc`", () => configRead(`cd ${config()}; cat ./swarm.jsonc`))
  it.live("`(cd <config root> && cat swarm.jsonc)`", () => configRead(`(cd ${config()} && cat swarm.jsonc)`))
  it.live("`cat $XDG_CONFIG_HOME/<app>/swarm.jsonc`", () => {
    const relative = path.relative(process.env.XDG_CONFIG_HOME!, config())
    expect(relative.startsWith("..")).toBe(false)
    return configRead(`cat $XDG_CONFIG_HOME/${relative}/swarm.jsonc`)
  })
  it.live("`cat ${XDG_CONFIG_HOME}/<app>/swarm.jsonc`", () =>
    configRead(`cat \${XDG_CONFIG_HOME}/${path.relative(process.env.XDG_CONFIG_HOME!, config())}/swarm.jsonc`),
  )
  for (const form of ["cd ~/m1cfg && cat swarm.jsonc", "cd $HOME/m1cfg && cat swarm.jsonc", "cat ${HOME}/m1cfg/swarm.jsonc"])
    it.live(`\`${form}\` (temporary home)`, () => {
      let check = (_: string) => {}
      return shell(form, () => void (check = settingsAt(homeConfig))).pipe(Effect.map((text) => check(text)))
    })
  for (const form of ["head -n 40 swarm.jsonc", "tail -n 6 swarm.jsonc", "grep TOKEN swarm.jsonc"])
    it.live(`\`cd <config root> && ${form}\``, () => configRead(`cd ${config()} && ${form}`))
  // CHAR: a count prints no value (it is withheld or a number either way).
  it.live("`cd <config root> && grep -c TOKEN swarm.jsonc` shows no piece of the token", () => {
    let token = ""
    return shell(`cd ${config()} && grep -c TOKEN swarm.jsonc`, () => {
      token = fresh()
      writeFileSync(path.join(config(), "swarm.jsonc"), settings(token))
    }).pipe(Effect.map((text) => noPiece(text, token)))
  })
})

describe("M1-02: a symlink to app-server.env read after cd is masked by where it lands", () => {
  for (const form of ["cd sub && cat notes.txt", "cd sub; head -n 5 ./notes.txt"])
    it.live(`\`${form}\`, notes.txt -> <state>/swarm/app-server.env`, () => {
      const token = fresh()
      return shell(form, (project) => {
        writeFileSync(path.join(state(), "app-server.env"), `SERVER_TOKEN=${token}\n`)
        mkdirSync(path.join(project, "sub"))
        symlinkSync(path.join(state(), "app-server.env"), path.join(project, "sub", "notes.txt"))
      }).pipe(
        Effect.map((text) => {
          expect(text).toContain("[hidden:SERVER_TOKEN]")
          noPiece(text, token)
        }),
      )
    })
})

describe("M1-02 fail closed: a secret-named read whose place cannot be resolved for certain is withheld whole", () => {
  it.live("`cat $UNSET/swarm.jsonc`", () =>
    shell(`cat $${UNSET}/swarm.jsonc`).pipe(Effect.map((text) => expect(text).toContain("[hidden:swarm.jsonc]"))),
  )
  it.live("`cd $UNSET && cat swarm.jsonc`", () =>
    shell(`cd $${UNSET} && cat swarm.jsonc`).pipe(Effect.map((text) => expect(text).toContain("[hidden:swarm.jsonc]"))),
  )
  it.live("`cd - && cat .env`", () => shell("cd - && cat .env").pipe(Effect.map((text) => expect(text).toContain("[hidden:.env]"))))
})

describe("controls: reads that touch no secret show as before", () => {
  it.live("`cd sub && cat plain.txt` prints the file", () =>
    shell("cd sub && cat plain.txt", (project) => {
      mkdirSync(path.join(project, "sub"))
      writeFileSync(path.join(project, "sub", "plain.txt"), "just some notes\n")
    }).pipe(
      Effect.map((text) => {
        expect(text).toContain("just some notes")
        expect(text).not.toContain("[hidden:")
      }),
    ),
  )
  it.live("`cat .env` with no .env anywhere it could be is not withheld (nothing to show)", () =>
    shell("cat .env").pipe(Effect.map((text) => expect(text).not.toContain("[hidden:.env]"))),
  )
})

describe("M1-02 resolver units", () => {
  test("workingFolders follows cd, chdir, pushd and nested relatives", () => {
    const found = Secrets.workingFolders([["cd", "/a"], ["cat", "x"], ["cd", "b"], ["pushd", "../c"]], "/w", ["/h"])
    expect(found.certain).toBe(true)
    expect(found.folders).toEqual(expect.arrayContaining(["/w", "/a", "/w/b", "/a/b", "/c", "/w/c", "/a/c"]))
  })
  test("workingFolders: bare cd is home; cd -, popd and an unset variable are not certain", () => {
    expect(Secrets.workingFolders([["cd"]], "/w", ["/h"]).folders).toContain("/h")
    expect(Secrets.workingFolders([["cd", "-"]], "/w", ["/h"]).certain).toBe(false)
    expect(Secrets.workingFolders([["popd"]], "/w", ["/h"]).certain).toBe(false)
    expect(Secrets.workingFolders([["cd", `$${UNSET}`]], "/w", ["/h"]).certain).toBe(false)
  })
  test("expandSpelling: ~, $HOME, ${HOME} under every home; set variables; ~user is not certain", () => {
    expect(Secrets.expandSpelling("~/x", ["/h1", "/h2"]).names).toEqual(["/h1/x", "/h2/x"])
    expect(Secrets.expandSpelling("$HOME/x", ["/h1"]).names).toEqual(["/h1/x"])
    expect(Secrets.expandSpelling("${HOME}/x", ["/h1"]).names).toEqual(["/h1/x"])
    expect(Secrets.expandSpelling("$XDG_STATE_HOME/y", ["/h"]).names).toEqual([`${process.env.XDG_STATE_HOME}/y`])
    expect(Secrets.expandSpelling("~root/x", ["/h"]).certain).toBe(false)
    expect(Secrets.expandSpelling(`$${UNSET}/x`, ["/h"]).certain).toBe(false)
  })
})
