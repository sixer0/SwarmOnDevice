// Row 36b (Swarm 1.2.6): SEC-01, SEC-03, SEC-20. Since row 36 every read runs in autonomous mode without asking (U12), so
// what a read prints must keep secret values masked (U16). Every secret here is synthetic and lives in a temporary project,
// the test home (`Global.Path.home`) or the test data folder (`Global.Path.data`); the real home folder is never read.
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { ShellTool } from "../../src/tool/shell"
import { ReadTool } from "../../src/tool/read"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped, disposeAllInstances } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { Instruction } from "../../src/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"

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
  sessionID: SessionID.make("ses_sec36b"),
  messageID: MessageID.make("msg_sec36b"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  trust: { canUndo: true },
  ask: () => Effect.void,
}

// Synthetic values only. None has a shape the fixed SHAPES list knows, so only the row-36b rules can hide them.
const ENV_VALUE = "Zq8vT3mK9pLw2XcR7nBd4FhJ6sYa1GeU" // 32 characters
const AWS_VALUE = "Wk5rN8qT2vLx9ZcB4mHd7JfP3sGa6YeR"
const AUTH_VALUE = "plainopaquekey123456"
const MCP_ACCESS = "opaqueAccessTok987654"
const MCP_REFRESH = "opaqueRefreshTok123987"
const HISTORY_VALUE = "abc123def456"
const GCLOUD_VALUE = "gcloudSecretValue77x"

const home = () => Global.Path.home
const data = () => Global.Path.data

function placeFixtures() {
  mkdirSync(path.join(home(), ".aws"), { recursive: true })
  writeFileSync(path.join(home(), ".aws/credentials"), `[default]\naws_secret_access_key = ${AWS_VALUE}\n`)
  mkdirSync(path.join(home(), ".config/gcloud"), { recursive: true })
  writeFileSync(
    path.join(home(), ".config/gcloud/application_default_credentials.json"),
    `{\n  "client_id": "x.apps",\n  "client_secret": "${GCLOUD_VALUE}",\n  "type": "authorized_user"\n}\n`,
  )
  writeFileSync(
    path.join(home(), ".zsh_history"),
    `: 1699999999:0;ls -la\n: 1699999999:0;export FOO_TOKEN=${HISTORY_VALUE}\nexport FOO_TOKEN=${HISTORY_VALUE}\n`,
  )
  mkdirSync(data(), { recursive: true })
  writeFileSync(path.join(data(), "auth.json"), JSON.stringify({ "gsp-ai-tail": { type: "api", key: AUTH_VALUE } }))
  writeFileSync(
    path.join(data(), "mcp-auth.json"),
    JSON.stringify({ srv: { tokens: { accessToken: MCP_ACCESS, refreshToken: MCP_REFRESH } } }, null, 2),
  )
}

function clearFixtures() {
  for (const file of [".aws", ".config/gcloud", ".zsh_history"]) rmSync(path.join(home(), file), { recursive: true, force: true })
  for (const file of ["auth.json", "mcp-auth.json"]) rmSync(path.join(data(), file), { force: true })
}

const shell = (command: string, prepare?: (dir: string) => void) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    writeFileSync(path.join(dir, ".env"), `API_KEY=${ENV_VALUE}\n`)
    prepare?.(dir)
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
    }).pipe(provideInstance(dir))
    return { ...result, live }
  })

const read = (filePath: string) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    return yield* Effect.gen(function* () {
      const tool = yield* (yield* ReadTool).init()
      return yield* tool.execute({ filePath }, ctx as never)
    }).pipe(provideInstance(dir))
  })

/** Every 4-character piece of the value, forwards and reversed (R-13). */
function pieces(value: string) {
  const out = new Set<string>()
  for (const text of [value, [...value].reverse().join("")])
    for (let i = 0; i + 4 <= text.length; i++) out.add(text.slice(i, i + 4))
  return [...out]
}

function noPiece(text: string, value: string) {
  const leaked = pieces(value).filter((piece) => text.includes(piece))
  expect(leaked).toEqual([])
}

const everything = (result: { output: string; metadata: unknown; live?: string[] }) =>
  [result.output, JSON.stringify(result.metadata), ...(result.live ?? [])].join("\n")

describe("SEC-01 (R-13): a transformed or partial read of a secret file runs, and its output is withheld", () => {
  const transforms = [
    "rev .env",
    "tr a-z n-za-m < .env",
    "xxd .env",
    "od -c .env",
    "hexdump -C .env",
    "fold -w4 .env",
    "cut -c9-40 .env",
    "head -c 12 .env",
    "strings .env",
    // Not in the 1.2.5 reshaping list: each printed the value, or a piece of it, past the scrubber.
    "dd if=.env bs=1 skip=8 count=12",
    "colrm 20 < .env",
    "uuencode .env x",
    "cat .env | colrm 20",
  ]
  for (const command of transforms) {
    it.live(`.env: ${command}`, () =>
      shell(command).pipe(
        Effect.map((result) => {
          expect(result.output).toContain("[hidden:.env (transformed output of a credential file)]")
          expect(result.output).toContain("the command ran")
          noPiece(everything(result), ENV_VALUE)
        }),
      ),
    )
  }

  it.live("a link with an ordinary name that leads to .env is judged by where it leads", () =>
    shell("rev notes.txt", (dir) => symlinkSync(path.join(dir, ".env"), path.join(dir, "notes.txt"))).pipe(
      Effect.map((result) => {
        expect(result.output).toContain("transformed output of a credential file")
        noPiece(everything(result), ENV_VALUE)
      }),
    ),
  )

  it.live("a glob that names .env is the same as naming it", () =>
    shell("rev .en?").pipe(
      Effect.map((result) => {
        expect(result.output).toContain("transformed output of a credential file")
        noPiece(everything(result), ENV_VALUE)
      }),
    ),
  )

  const awsTransforms = ["rev", "xxd", "od -c", "hexdump -C", "fold -w4", "cut -c9-40", "head -c 12", "strings", "cat", "grep aws"]
  for (const program of awsTransforms) {
    it.live(`~/.aws/credentials (whole secret file, read tool's withheld output): ${program}`, () =>
      Effect.acquireUseRelease(
        Effect.sync(placeFixtures),
        () =>
          shell(`${program} ${path.join(home(), ".aws/credentials")}`).pipe(
            Effect.map((result) => {
              expect(result.output).toContain("[hidden:credentials]")
              expect(result.output).toContain("holds credentials")
              noPiece(everything(result), AWS_VALUE)
            }),
          ),
        () => Effect.sync(clearFixtures),
      ),
    )
  }

  it.live("a verbatim viewer on .env still shows the other lines, with the value masked", () =>
    shell("cat .env", (dir) => writeFileSync(path.join(dir, ".env"), `PORT=3000\nAPI_KEY=${ENV_VALUE}\n`)).pipe(
      Effect.map((result) => {
        expect(result.output).toContain("PORT=3000")
        expect(result.output).toContain("[hidden:")
        expect(result.output).not.toContain("transformed output")
        noPiece(everything(result), ENV_VALUE)
      }),
    ),
  )

  it.live("metadata only programs on a protected place still answer", () =>
    Effect.acquireUseRelease(
      Effect.sync(placeFixtures),
      () =>
        shell(`wc -l ${path.join(home(), ".aws/credentials")}`).pipe(
          Effect.map((result) => {
            expect(result.output).toMatch(/\b2\b/)
            expect(result.output).not.toContain("[hidden:")
          }),
        ),
      () => Effect.sync(clearFixtures),
    ),
  )
})

describe("SEC-03 (R-3..R-5): protected home and app files, history files", () => {
  const cases: [string, () => string, string[]][] = [
    ["auth.json", () => path.join(data(), "auth.json"), [AUTH_VALUE]],
    ["mcp-auth.json", () => path.join(data(), "mcp-auth.json"), [MCP_ACCESS, MCP_REFRESH]],
    ["gcloud credentials", () => path.join(home(), ".config/gcloud/application_default_credentials.json"), [GCLOUD_VALUE]],
    [".zsh_history", () => path.join(home(), ".zsh_history"), [HISTORY_VALUE]],
  ]
  for (const [name, file, values] of cases) {
    it.live(`read tool: ${name} runs and no value reaches output or metadata`, () =>
      Effect.acquireUseRelease(
        Effect.sync(placeFixtures),
        () =>
          read(file()).pipe(
            Effect.map((result) => {
              const all = everything(result)
              for (const value of values) expect(all).not.toContain(value)
              expect(result.output).toContain("[hidden:")
            }),
          ),
        () => Effect.sync(clearFixtures),
      ),
    )
    for (const program of ["cat", "grep -i o", "sort"]) {
      it.live(`shell ${program}: ${name} runs and no value reaches output or metadata`, () =>
        Effect.acquireUseRelease(
          Effect.sync(placeFixtures),
          () =>
            shell(`${program} ${file()}`).pipe(
              Effect.map((result) => {
                const all = everything(result)
                for (const value of values) expect(all).not.toContain(value)
                expect(result.output).toContain("[hidden:")
              }),
            ),
          () => Effect.sync(clearFixtures),
        ),
      )
    }
  }

  it.live("history: the ordinary lines of a history file are still shown", () =>
    Effect.acquireUseRelease(
      Effect.sync(placeFixtures),
      () =>
        read(path.join(home(), ".zsh_history")).pipe(
          Effect.map((result) => {
            expect(result.output).toContain("ls -la")
            expect(result.output).toContain("FOO_TOKEN")
            expect(result.output).not.toContain(HISTORY_VALUE)
          }),
        ),
      () => Effect.sync(clearFixtures),
    ),
  )
})

describe("SEC-20 (R-6): env and printenv output is masked", () => {
  const vars: Record<string, string> = {
    DATUM_RENDER_TOKEN: "rendTok12345678x",
    GSP_AI_API_KEY: "gspProvKey123456",
    // Shorter than the eight characters a process value needs to be learned, so only the assignment rule hides it.
    FOO_TOKEN: "ab12cd3",
  }
  const withVars = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
        Object.assign(process.env, vars)
        return before
      }),
      () => self,
      (before) =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
        }),
    )
  for (const command of ["env", "printenv"]) {
    it.live(`${command}: the provider key, the render token and a short token are all masked`, () =>
      withVars(
        shell(command).pipe(
          Effect.map((result) => {
            const all = everything(result)
            for (const value of Object.values(vars)) expect(all).not.toContain(value)
            expect(result.output).toContain("DATUM_RENDER_TOKEN=")
            expect(result.output).toContain("[hidden:")
          }),
        ),
      ),
    )
  }
  it.live("printenv NAME of a secret-sounding name prints the placeholder, not the value", () =>
    withVars(
      shell("printenv FOO_TOKEN").pipe(
        Effect.map((result) => {
          expect(everything(result)).not.toContain(vars.FOO_TOKEN)
          expect(result.output).toContain("[hidden:FOO_TOKEN]")
        }),
      ),
    ),
  )
})
