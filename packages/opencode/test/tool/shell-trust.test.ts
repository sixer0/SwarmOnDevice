// What the shell tool does with real commands in a real git repository, once it is running inside an agent session.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "path"
import { Config } from "@/config/config"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { spawnSync } from "node:child_process"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Plugin.node, Truncate.node, Config.node, Agent.node, RuntimeFlags.node]),
    ),
    testInstanceStoreLayer,
  ),
)

const seed = (dir: string) => {
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir })
  git("init", "-q")
  mkdirSync(path.join(dir, "src"), { recursive: true })
  mkdirSync(path.join(dir, "data"), { recursive: true })
  mkdirSync(path.join(dir, "dist"), { recursive: true })
  writeFileSync(path.join(dir, ".gitignore"), "data/\ndist/\n.env\nhuge.bin\n")
  writeFileSync(path.join(dir, "src/a.ts"), "a\n")
  writeFileSync(path.join(dir, "data/local.db"), "only copy\n")
  writeFileSync(path.join(dir, "dist/out.js"), "built\n")
  writeFileSync(path.join(dir, ".env"), "API_KEY=x\n")
  writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(3 * 1024 * 1024))
  git("add", "src", ".gitignore")
  git("commit", "-qm", "init")
}

const outcome = (command: string, canUndo = true, prepare?: (dir: string) => void) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    seed(dir)
    prepare?.(dir)
    const asked: { patterns: readonly string[]; always: readonly string[]; risk?: unknown }[] = []
    const stop = new Error("stopped at prompt")
    const ctx = {
      sessionID: SessionID.make("ses_trust"),
      messageID: MessageID.make("msg_trust"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      trust: { canUndo },
      ask: (req: { patterns: readonly string[]; always: readonly string[]; metadata: Record<string, unknown>; harmless?: boolean }) => {
        if (req.harmless) return Effect.void
        asked.push({ patterns: req.patterns, always: req.always, risk: req.metadata.risk })
        return Effect.die(stop)
      },
    }
    const exit = yield* Effect.gen(function* () {
      const tool = yield* (yield* ShellTool).init()
      return yield* tool.execute({ command }, ctx as never)
    }).pipe(provideInstance(dir), Effect.exit)
    if (Exit.isFailure(exit) && Cause.squash(exit.cause) !== stop) throw Cause.squash(exit.cause)
    return asked[0]
  })

describe("shell commands inside an agent session", () => {
  const runs = [
    "ls src",
    "git status",
    "cat .env",
    "rm -rf src",
    "rm -rf dist",
    "mkdir -p src/lib && touch src/lib/x.ts",
    "echo hi > src/out.txt",
    "echo hi 2>/dev/null",
    "git add -A && git commit -qm x --allow-empty",
    "git reset --hard",
    "ls | grep a",
  ]
  for (const command of runs) {
    it.live(`runs without a prompt: ${command}`, () =>
      outcome(command).pipe(Effect.map((asked) => expect(asked).toBeUndefined())),
    )
  }

  const lost = [
    "rm data/local.db",
    "rm -rf data",
    "rm .env",
    "rm big.bin",
    "rm -rf .",
    "rm -rf .git",
    "rm -rf ../elsewhere",
    "rm -rf /",
    "echo x > data/local.db",
    "mv src/a.ts .env",
    "git push --force origin main",
    "git reset --hard HEAD~1",
    "ls; git push -f",
    "cd src && git push --force",
  ]
  for (const command of lost) {
    it.live(`asks, and says Undo cannot help: ${command}`, () =>
      outcome(command).pipe(
        Effect.map((asked) => {
          expect(asked?.risk).toBe("irreversible")
          // "Allow always" would approve the next, different, one.
          expect(asked?.always).toEqual([])
        }),
      ),
    )
  }

  it.live("says a plain push leaves the machine", () =>
    outcome("git push origin main").pipe(Effect.map((asked) => expect(asked?.risk).toBe("remote"))),
  )

  const unsure = [
    "PATH=/tmp ls",
    "FOO=1 ls",
    "ls() { rm -rf /; }; ls",
    "cd .. && ls",
    "cd .. && rm -rf x",
    "echo x > .git/hooks/pre-commit",
    "touch swarm.json",
    "echo x > ~/out",
    "echo x > $TARGET",
    "cat ~/.ssh/id_rsa",
    "bash -c 'rm -rf src'",
    "git add . && bun test",
    "rm $(cat list)",
  ]
  for (const command of unsure) {
    it.live(`keeps its normal prompt: ${command}`, () =>
      outcome(command).pipe(
        Effect.map((asked) => {
          expect(asked).toBeDefined()
          expect(asked?.risk).toBeUndefined()
        }),
      ),
    )
  }

  it.live("a commit runs repository hooks, so it asks when there are any", () =>
    outcome("git commit -qm x --allow-empty", true, (dir) =>
      writeFileSync(path.join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
    ).pipe(Effect.map((asked) => expect(asked).toBeDefined())),
  )

  it.live("without snapshots nothing that changes files is taken as undoable", () =>
    Effect.gen(function* () {
      expect(yield* outcome("rm -rf src", false)).toBeDefined()
      expect(yield* outcome("touch x", false)).toBeDefined()
      expect(yield* outcome("ls src", false)).toBeUndefined()
    }),
  )
})
