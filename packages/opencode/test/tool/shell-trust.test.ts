// What the shell tool does with real commands in a real git repository, once it is running inside an agent session.
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import fs from "node:fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
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

// For the redirect evasions: it must stop at the prompt, and what it would have written must not exist.
const stoppedBefore = (command: string, prepare: (dir: string) => void, written: (dir: string) => boolean) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    seed(dir)
    prepare(dir)
    const asked: unknown[] = []
    const stop = new Error("stopped at prompt")
    const ctx = {
      sessionID: SessionID.make("ses_trust"),
      messageID: MessageID.make("msg_trust"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      trust: { canUndo: true },
      ask: (req: { harmless?: boolean }) => {
        if (req.harmless) return Effect.void
        asked.push(req)
        return Effect.die(stop)
      },
    }
    const exit = yield* Effect.gen(function* () {
      const tool = yield* (yield* ShellTool).init()
      return yield* tool.execute({ command }, ctx as never)
    }).pipe(provideInstance(dir), Effect.exit)
    if (Exit.isFailure(exit) && Cause.squash(exit.cause) !== stop) throw Cause.squash(exit.cause)
    expect(asked.length).toBeGreaterThan(0)
    expect(written(dir)).toBe(false)
  })

const run = (command: string, prepare?: (dir: string) => void) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    seed(dir)
    prepare?.(dir)
    const ctx = {
      sessionID: SessionID.make("ses_trust"),
      messageID: MessageID.make("msg_trust"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      trust: { canUndo: true },
      ask: () => Effect.void,
    }
    return yield* Effect.gen(function* () {
      const tool = yield* (yield* ShellTool).init()
      return yield* tool.execute({ command }, ctx as never)
    }).pipe(provideInstance(dir))
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

  describe("a redirect the parser does not attach to one command", () => {
    const evasions = [
      "{ echo PWNED; } > ../out.txt",
      "(echo PWNED) > ../out.txt",
      "if true; then echo PWNED; fi > ../out.txt",
      "for i in 1; do echo PWNED; done > ../out.txt",
      "while false; do :; done > ../out.txt",
      "echo x | cat > ../out.txt",
      "{ echo gone; } > data/local.db",
      "{ echo x; } >> .git/config",
      "echo x | cat >> .git/config",
      "> .git/config",
      "> ../out.txt echo x",
      "echo x > ../out.txt extra",
      "echo x >> .gi?/config",
      "echo x >> .gi\\t/config",
      'echo x >> ".g"it/config',
      "echo x >> {.git,x}/config",
      "cat <<EOF > ../out.txt\nx\nEOF",
    ]
    for (const command of evasions) {
      it.live(`stops at the prompt: ${command.replaceAll("\n", " ")}`, () =>
        outcome(command).pipe(Effect.map((asked) => expect(asked).toBeDefined())),
      )
    }

    it.live("a group's redirect outside the project never lands", () =>
      stoppedBefore("{ echo PWNED; } > escaped.txt", () => {}, (dir) => existsSync(path.join(dir, "escaped.txt"))),
    )

    it.live("a pipeline writing inside the project needs no prompt: Undo covers it", () =>
      outcome("ls | sort > src/list.txt").pipe(Effect.map((asked) => expect(asked).toBeUndefined())),
    )
  })

  describe("arguments the shell rewrites before the command sees them", () => {
    const rewritten = [
      "cat $F",
      "cat $(echo /etc/hosts)",
      "cat $'/etc/hosts'",
      "cat {/etc/hosts,/dev/null}",
      "cat ..\\/..\\/x",
      "ls ~root",
      "cat < /etc/hosts",
      "grep --file=/etc/hosts src/a.ts",
      "grep -f/etc/hosts src/a.ts",
      "diff --from-file=/etc/hosts src/a.ts",
      "sort --files0-from=list.txt",
      "sort -uo out.txt src/a.ts",
      "sort --out=out.txt src/a.ts",
      "git diff --no-index /etc/hosts /dev/null",
      "git blame --contents /etc/hosts src/a.ts",
      "find -L . -name x",
      "[[ -f /etc/hosts ]]",
      "x=1",
    ]
    for (const command of rewritten) {
      it.live(`keeps its normal prompt: ${command}`, () =>
        outcome(command).pipe(Effect.map((asked) => expect(asked).toBeDefined())),
      )
    }
  })

  describe("on a case-insensitive disk", () => {
    for (const command of [
      "echo x >> .GIT/config",
      "touch .GIT/hooks/post-merge",
      "touch SWARM.JSON",
      "touch .GitHub/workflows/y.yml",
      "touch .HUSKY/pre-commit",
      "touch .SWARM/command/y.md",
      "touch .ENV",
    ]) {
      it.live(`asks: ${command}`, () => outcome(command).pipe(Effect.map((asked) => expect(asked).toBeDefined())))
    }
  })

  describe("through a symlink that leaves the project", () => {
    const linked = (dir: string) => {
      const out = `${dir}-outside`
      mkdirSync(out, { recursive: true })
      writeFileSync(path.join(out, "outside.txt"), "outside\n")
      writeFileSync(path.join(out, "victim.txt"), "victim\n")
      symlinkSync(path.join(out, "outside.txt"), path.join(dir, "linkfile"))
      symlinkSync(out, path.join(dir, "linkdir"))
      symlinkSync(path.join(out, "not-there-yet.txt"), path.join(dir, "dangling"))
      symlinkSync(".git", path.join(dir, "innocent"))
    }
    const commands = [
      "echo PWNED > linkfile",
      "echo PWNED > dangling",
      "cp src/a.ts linkdir/copied.md",
      "rm linkdir/victim.txt",
      "cat linkfile",
      "cat linkdir/outside.txt",
      "echo x >> innocent/config",
    ]
    for (const command of commands) {
      it.live(`asks: ${command}`, () => outcome(command, true, linked).pipe(Effect.map((asked) => expect(asked).toBeDefined())))
    }
  })

  describe("anything that can read or send data off the machine, or run a configured program", () => {
    for (const command of [
      "git fetch",
      "git fetch origin",
      "git fetch http://127.0.0.1:47203/leak/DATA",
      "git fetch . +HEAD~1:refs/heads/other",
      "git commit --allow-empty -F /etc/hosts",
    ]) {
      it.live(`asks: ${command}`, () => outcome(command).pipe(Effect.map((asked) => expect(asked).toBeDefined())))
    }

    it.live("a URL is called out as leaving the machine, and offers no always", () =>
      outcome("git fetch http://127.0.0.1:47203/leak/DATA").pipe(
        Effect.map((asked) => {
          expect(asked?.risk).toBe("remote")
          expect(asked?.always).toEqual([])
        }),
      ),
    )

    const planted = (dir: string) =>
      writeFileSync(
        path.join(dir, ".git/config"),
        readFileSync(path.join(dir, ".git/config"), "utf8") + '[core]\n\tfsmonitor = "touch PWNED; false"\n',
      )
    it.live("git status asks when the repository's own config runs a program", () =>
      outcome("git status", true, planted).pipe(Effect.map((asked) => expect(asked).toBeDefined())),
    )
    it.live("git status stays quiet when it only uses git's built-in monitor", () =>
      outcome("git status", true, (dir) =>
        writeFileSync(
          path.join(dir, ".git/config"),
          readFileSync(path.join(dir, ".git/config"), "utf8") + "[core]\n\tfsmonitor = true\n",
        ),
      ).pipe(Effect.map((asked) => expect(asked).toBeUndefined())),
    )
    it.live("checking out runs post-checkout, so it asks when there is one", () =>
      outcome("git checkout -q -b new", true, (dir) =>
        writeFileSync(path.join(dir, ".git/hooks/post-checkout"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }),
      ).pipe(Effect.map((asked) => expect(asked).toBeDefined())),
    )
  })

  describe("moving history is not what a snapshot restores", () => {
    for (const command of ["git reset --soft HEAD~1", "git reset --keep HEAD~1", "git reset HEAD~1", "git checkout -B main HEAD~1", "git switch -C main HEAD~1"]) {
      it.live(`asks, and says Undo cannot help: ${command}`, () =>
        outcome(command).pipe(Effect.map((asked) => expect(asked?.risk).toBe("irreversible"))),
      )
    }
    it.live("rewriting the last commit asks", () =>
      outcome("git commit --amend -m rewritten").pipe(Effect.map((asked) => expect(asked).toBeDefined())),
    )
    for (const command of ["git reset", "git reset HEAD", "git reset -- src/a.ts", "git reset src/a.ts"]) {
      it.live(`only unstaging needs no prompt: ${command}`, () =>
        outcome(command).pipe(Effect.map((asked) => expect(asked).toBeUndefined())),
      )
    }
  })

  describe("a nested repository holds history no snapshot has", () => {
    const nested = (dir: string) => {
      mkdirSync(path.join(dir, "vendor/nested"), { recursive: true })
      spawnSync("git", ["init", "-q"], { cwd: path.join(dir, "vendor/nested") })
      writeFileSync(path.join(dir, "vendor/nested/only.txt"), "x\n")
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: path.join(dir, "vendor/nested") })
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], { cwd: path.join(dir, "vendor/nested") })
    }
    for (const command of ["rm -rf vendor/nested", "git clean -ffd"]) {
      it.live(`asks, and says Undo cannot help: ${command}`, () =>
        outcome(command, true, nested).pipe(Effect.map((asked) => expect(asked?.risk).toBe("irreversible"))),
      )
    }
    it.live("cleaning without one stays quiet, and ignored files are not its business", () =>
      outcome("git clean -fd", true, (dir) => {
        spawnSync("rm", [path.join(dir, "big.bin")])
      }).pipe(Effect.map((asked) => expect(asked).toBeUndefined())),
    )
  })

  it.live("a finished command leaves no record behind to be ended later", () =>
    Effect.gen(function* () {
      const result = yield* run("echo done")
      expect(result.output).toContain("done")
      expect(result.metadata.exit).toBe(0)
      const left = fs.readdirSync(path.join(Global.Path.state, "shell-running", "ses_trust"))
      expect(left).toEqual([])
    }),
  )

  describe("what a command prints from a secret file", () => {
    const secrets = (dir: string) => {
      writeFileSync(path.join(dir, ".env"), "API_KEY=abcSECRETvalue123456\n")
      writeFileSync(path.join(dir, "credentials"), "[default]\naws_secret_access_key = plainSecretInCredentialsFile\n")
      writeFileSync(path.join(dir, ".netrc"), "machine x login me password netrcSecretValue\n")
      mkdirSync(path.join(dir, "config"), { recursive: true })
      writeFileSync(path.join(dir, "config/secrets.yaml"), "db_password: yamlSecretValue9\n")
      mkdirSync(path.join(dir, "a/b/c"), { recursive: true })
      writeFileSync(path.join(dir, "a/b/c/.env"), "DEEP_TOKEN=deepSecretValueInLevel3\n")
    }
    const hidden: [string, string][] = [
      ["cat .env", "abcSECRETvalue123456"],
      ["cat credentials", "plainSecretInCredentialsFile"],
      ["cat .netrc", "netrcSecretValue"],
      ["cat config/secrets.yaml", "yamlSecretValue9"],
      ["cat a/b/c/.env", "deepSecretValueInLevel3"],
    ]
    for (const [command, value] of hidden) {
      it.live(`hides the value: ${command}`, () =>
        run(command, secrets).pipe(
          Effect.map((result) => {
            expect(result.output).not.toContain(value)
            expect(result.output).toContain("[hidden:")
          }),
        ),
      )
    }
    const reshaping = [
      "grep -o . .env",
      "cut -c9-14 .env",
      "jq -Rrs @base64 .env",
      "cat .env | base64",
      "cat .env | cut -c9-14",
      "cut -c9-14 < .env",
      "head -c 12 .env",
      "python3 -c \"print(open('.env').read()[::-1])\"",
    ]
    for (const command of reshaping) {
      it.live(`withholds what it cannot recognise: ${command}`, () =>
        run(command, secrets).pipe(
          Effect.map((result) => {
            expect(result.output).toContain("output withheld")
            expect(result.output).not.toContain("SECRET")
            expect(result.metadata.output).not.toContain("SECRET")
            expect(result.output).not.toContain("=")
          }),
        ),
      )
    }
    it.live("what is shown and stored while a command runs is hidden too", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        secrets(dir)
        const live: string[] = []
        const ctx = {
          sessionID: SessionID.make("ses_trust"),
          messageID: MessageID.make("msg_trust"),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: (input: { metadata?: { output?: string } }) =>
            Effect.sync(() => {
              live.push(input.metadata?.output ?? "")
            }),
          trust: { canUndo: true },
          ask: () => Effect.void,
        }
        yield* Effect.gen(function* () {
          const tool = yield* (yield* ShellTool).init()
          return yield* tool.execute({ command: "cat .env" }, ctx as never)
        }).pipe(provideInstance(dir))
        expect(live.join("\n")).toContain("[hidden:API_KEY]")
        expect(live.join("\n")).not.toContain("abcSECRETvalue123456")
      }),
    )

    it.live("an ordinary reshape of an ordinary file is left alone", () =>
      run("cut -c1-1 src/a.ts").pipe(Effect.map((result) => expect(result.output).toContain("a"))),
    )
  })

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
