// The read-only git tool against a hostile repository. Each vector first proves it is live: plain git run the ordinary way
// fires the marker. Then every subcommand of the tool runs, and the marker must not appear.
import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Truncate } from "@/tool/truncate"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { GitTool, hardenedEnv, withholdSecretDiffs } from "../../src/tool/git"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node])), testInstanceStoreLayer),
)

const plain = (dir: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })

const seed = (dir: string) => {
  plain(dir, "init", "-q", "-b", "main")
  fs.mkdirSync(path.join(dir, "src"))
  fs.writeFileSync(path.join(dir, "src/a.txt"), "one\n")
  fs.writeFileSync(path.join(dir, "README.md"), "# readme\n")
  plain(dir, "add", ".")
  plain(dir, "commit", "-qm", "init")
  fs.writeFileSync(path.join(dir, "src/a.txt"), "one\ntwo\n")
  plain(dir, "add", "src/a.txt")
  plain(dir, "commit", "-qm", "second")
  fs.writeFileSync(path.join(dir, "src/a.txt"), "one\ntwo\nthree\n")
}

// A program that leaves a mark, for whatever config names it. Outside the project, so a listing never shows it.
const evil = (dir: string, name = "marker") => {
  const script = `${dir}-evil-${name}`
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${dir}-${name}"\nexit 0\n`, { mode: 0o755 })
  return script
}
const fired = (dir: string, name = "marker") => fs.existsSync(`${dir}-${name}`)
const clear = (dir: string, name = "marker") => fs.rmSync(`${dir}-${name}`, { force: true })

const calls = [
  { subcommand: "status" },
  { subcommand: "diff" },
  { subcommand: "diff", staged: true },
  { subcommand: "diff", revision: "HEAD~1" },
  { subcommand: "diff", revision: "HEAD~1..HEAD", stat: true },
  { subcommand: "log" },
  { subcommand: "log", patch: true },
  { subcommand: "log", stat: true, limit: 1 },
  { subcommand: "show" },
  { subcommand: "show", revision: "HEAD~1", paths: ["src/a.txt"] },
  { subcommand: "show", revision: "HEAD", paths: ["src/a.txt"], fileAtRevision: true },
  { subcommand: "blame", paths: ["src/a.txt"] },
  { subcommand: "blame", paths: ["src/a.txt"], revision: "HEAD~1", startLine: 1, endLine: 1 },
  { subcommand: "branch" },
  { subcommand: "branch", all: true },
] as const

const invoke = (dir: string, params: object, onAsk: (req: { permission: string; harmless?: boolean }) => void = () => {}) =>
  Effect.gen(function* () {
    const tool = yield* (yield* GitTool).init()
    return yield* tool.execute(params as never, {
      sessionID: SessionID.make("ses_git"),
      messageID: MessageID.make("msg_git"),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      trust: { canUndo: true },
      ask: (req: { permission: string; harmless?: boolean }) => Effect.sync(() => onAsk(req)),
    } as never)
  }).pipe(provideInstance(dir))

const failure = <R>(effect: Effect.Effect<unknown, unknown, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "no failure")),
  )

/** Every call runs and stays clean, or is refused by name when `refused` is given. Returns nothing: it asserts. */
const noneFire = (dir: string, marker = "marker") =>
  Effect.gen(function* () {
    clear(dir, marker)
    for (const params of calls) {
      const exit = yield* invoke(dir, params).pipe(Effect.exit)
      if (Exit.isFailure(exit)) throw new Error(`${JSON.stringify(params)} failed: ${Cause.squash(exit.cause)}`)
      expect([JSON.stringify(params), fired(dir, marker)]).toEqual([JSON.stringify(params), false])
    }
  })

describe("git tool on a hostile repository", () => {
  type Vector = { name: string; plant: (dir: string, script: string) => void; proof: string[] }
  const vectors: Vector[] = [
    { name: "core.fsmonitor", plant: (dir, script) => void plain(dir, "config", "core.fsmonitor", script), proof: ["status"] },
    {
      name: "core.fsmonitor through include.path",
      plant: (dir, script) => {
        fs.writeFileSync(path.join(dir, "inc.cfg"), `[core]\n\tfsmonitor = ${script}\n`)
        plain(dir, "config", "include.path", path.join(dir, "inc.cfg"))
      },
      proof: ["status"],
    },
    {
      name: "core.fsmonitor in a worktree config",
      plant: (dir, script) => {
        plain(dir, "config", "core.repositoryformatversion", "1")
        plain(dir, "config", "extensions.worktreeConfig", "true")
        plain(dir, "config", "--worktree", "core.fsmonitor", script)
      },
      proof: ["status"],
    },
    {
      name: "post-index-change hook",
      plant: (dir, script) => {
        fs.mkdirSync(path.join(dir, ".git/hooks"), { recursive: true })
        fs.copyFileSync(script, path.join(dir, ".git/hooks/post-index-change"))
        fs.chmodSync(path.join(dir, ".git/hooks/post-index-change"), 0o755)
      },
      proof: ["-c", "core.preloadIndex=false", "update-index", "--refresh"],
    },
    {
      name: "core.hooksPath",
      plant: (dir, script) => {
        const hooks = `${dir}-hooks`
        fs.mkdirSync(hooks, { recursive: true })
        fs.copyFileSync(script, path.join(hooks, "post-index-change"))
        fs.chmodSync(path.join(hooks, "post-index-change"), 0o755)
        plain(dir, "config", "core.hooksPath", hooks)
      },
      proof: ["update-index", "--refresh"],
    },
    { name: "diff.external", plant: (dir, script) => void plain(dir, "config", "diff.external", script), proof: ["diff"] },
    {
      name: "a diff driver's command",
      plant: (dir, script) => {
        fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt diff=evil\n")
        plain(dir, "config", "diff.evil.command", script)
      },
      proof: ["diff"],
    },
    {
      name: "a diff driver's textconv",
      plant: (dir, script) => {
        fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt diff=evil\n")
        plain(dir, "config", "diff.evil.textconv", script)
      },
      proof: ["diff"],
    },
    {
      name: "textconv from .git/info/attributes",
      plant: (dir, script) => {
        fs.mkdirSync(path.join(dir, ".git/info"), { recursive: true })
        fs.writeFileSync(path.join(dir, ".git/info/attributes"), "*.txt diff=evil\n")
        plain(dir, "config", "diff.evil.textconv", script)
      },
      proof: ["log", "-p"],
    },
    {
      name: "textconv through core.attributesFile",
      plant: (dir, script) => {
        fs.writeFileSync(`${dir}-attrs`, "*.txt diff=evil\n")
        plain(dir, "config", "core.attributesFile", `${dir}-attrs`)
        plain(dir, "config", "diff.evil.textconv", script)
      },
      proof: ["diff"],
    },
  ]
  for (const vector of vectors) {
    it.live(vector.name, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        const script = evil(dir)
        vector.plant(dir, script)
        // Stale stat, so git has to look at the file again.
        fs.utimesSync(path.join(dir, "src/a.txt"), new Date(), new Date(Date.now() + 5000))
        plain(dir, ...vector.proof)
        expect(fired(dir)).toBe(true)
        fs.utimesSync(path.join(dir, "src/a.txt"), new Date(), new Date(Date.now() + 9000))
        yield* noneFire(dir)
      }),
    )
  }

  const pagers = ["core.pager", "pager.status", "pager.log", "pager.diff", "pager.show", "pager.branch", "pager.blame"]
  for (const key of pagers) {
    it.live(`${key} is not run, though a pager needs a terminal to be`, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        plain(dir, "config", key, evil(dir))
        yield* noneFire(dir)
      }),
    )
  }

  it.live("gpg.program, with log.showSignature on a signed commit", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      seed(dir)
      const script = evil(dir)
      plain(dir, "config", "gpg.program", script)
      plain(dir, "config", "log.showSignature", "true")
      const head = plain(dir, "rev-parse", "HEAD").stdout.trim()
      const parent = plain(dir, "rev-parse", "HEAD~1").stdout.trim()
      const tree = plain(dir, "rev-parse", "HEAD^{tree}").stdout.trim()
      const object = [
        `tree ${tree}`,
        `parent ${parent}`,
        "author t <t@t> 1700000000 +0000",
        "committer t <t@t> 1700000000 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " ",
        " x",
        " -----END PGP SIGNATURE-----",
        "",
        "signed",
        "",
      ].join("\n")
      fs.writeFileSync(`${dir}-commit`, object)
      const signed = plain(dir, "hash-object", "-t", "commit", "-w", `${dir}-commit`).stdout.trim()
      plain(dir, "update-ref", "HEAD", signed, head)
      plain(dir, "log", "-1")
      expect(fired(dir)).toBe(true)
      yield* noneFire(dir)
    }),
  )

  it.live("a submodule's own fsmonitor, which no -c from the parent reaches", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      seed(dir)
      const script = evil(dir)
      const sub = path.join(dir, "sub")
      fs.mkdirSync(sub)
      plain(sub, "init", "-q", "-b", "main")
      fs.writeFileSync(path.join(sub, "s.txt"), "s\n")
      plain(sub, "add", ".")
      plain(sub, "commit", "-qm", "s")
      const id = plain(sub, "rev-parse", "HEAD").stdout.trim()
      plain(dir, "update-index", "--add", "--cacheinfo", `160000,${id},sub`)
      plain(dir, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "with sub")
      plain(dir, "config", "diff.ignoreSubmodules", "none")
      plain(dir, "config", "diff.submodule", "log")
      plain(dir, "config", "status.submoduleSummary", "true")
      plain(sub, "config", "core.fsmonitor", script)
      fs.writeFileSync(path.join(sub, "s.txt"), "changed\n")
      plain(dir, "status")
      expect(fired(dir)).toBe(true)
      clear(dir)
      yield* noneFire(dir)
    }),
  )

  it.live("an alias cannot replace a built-in", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      seed(dir)
      plain(dir, "config", "alias.status", `!${evil(dir)}`)
      plain(dir, "config", "alias.log", `!${evil(dir)}`)
      yield* noneFire(dir)
    }),
  )

  it.live("the server's own environment does not reach it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      seed(dir)
      const script = evil(dir)
      const set = { GIT_EXTERNAL_DIFF: script, GIT_PAGER: script, GIT_SSH_COMMAND: script, GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${script}'`, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: script }
      const before = Object.fromEntries(Object.keys(set).map((key) => [key, process.env[key]]))
      yield* Effect.acquireUseRelease(
        Effect.sync(() => Object.assign(process.env, set)),
        () => noneFire(dir),
        () =>
          Effect.sync(() => {
            for (const [key, value] of Object.entries(before)) {
              if (value === undefined) delete process.env[key]
              else process.env[key] = value
            }
          }),
      )
    }),
  )

  test("only what git needs of the server's environment is passed on, and no PATH entry that is the project's", () => {
    const previous = { PATH: process.env.PATH, GIT_DIR: process.env.GIT_DIR, LD_PRELOAD: process.env.LD_PRELOAD }
    process.env.PATH = ["/proj/bin", ".", "", "/usr/bin", "/proj"].join(path.delimiter)
    process.env.GIT_DIR = "/x"
    process.env.LD_PRELOAD = "/x"
    const env = hardenedEnv({ directory: "/proj", worktree: "/proj" } as never)
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(Object.keys(env)).not.toContain("GIT_DIR")
    expect(Object.keys(env)).not.toContain("LD_PRELOAD")
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1")
    expect(env.GIT_NO_LAZY_FETCH).toBe("1")
    expect(env.GIT_LITERAL_PATHSPECS).toBe("1")
  })

  describe("what cannot be switched off from outside is refused, and says why", () => {
    const refusals: [string, (dir: string, script: string) => void, RegExp][] = [
      ["a clean filter", (dir, script) => {
        fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt filter=evil\n")
        plain(dir, "config", "filter.evil.clean", script)
      }, /filter\.evil\.clean/],
      ["a smudge filter", (dir, script) => void plain(dir, "config", "filter.evil.smudge", script), /filter\.evil\.smudge/],
      ["a long-running filter", (dir, script) => void plain(dir, "config", "filter.evil.process", script), /filter\.evil\.process/],
      ["a filter through include.path", (dir, script) => {
        fs.writeFileSync(`${dir}-inc`, `[filter "evil"]\n\tclean = ${script}\n`)
        plain(dir, "config", "include.path", `${dir}-inc`)
      }, /filter\.evil\.clean/],
      ["a filter in a worktree config", (dir, script) => {
        plain(dir, "config", "core.repositoryformatversion", "1")
        plain(dir, "config", "extensions.worktreeConfig", "true")
        plain(dir, "config", "--worktree", "filter.evil.clean", script)
      }, /filter\.evil\.clean/],
      ["a hook in config", (dir, script) => {
        plain(dir, "config", "hook.evil.event", "post-index-change")
        plain(dir, "config", "hook.evil.command", script)
      }, /hook\.evil/],
      ["a promisor remote", (dir) => {
        plain(dir, "config", "remote.origin.url", "http://127.0.0.1:1/x")
        plain(dir, "config", "remote.origin.promisor", "true")
      }, /promisor/],
      ["a partial clone filter", (dir) => void plain(dir, "config", "remote.origin.partialclonefilter", "blob:none"), /partialclonefilter/],
      ["a partial clone extension", (dir) => {
        plain(dir, "config", "core.repositoryformatversion", "1")
        plain(dir, "config", "extensions.partialClone", "origin")
      }, /extensions\.partialclone/],
      ["core.worktree", (dir) => void plain(dir, "config", "core.worktree", "/etc"), /core\.worktree|no \.git at the top/],
      ["borrowed objects", (dir) => {
        fs.mkdirSync(path.join(dir, ".git/objects/info"), { recursive: true })
        fs.writeFileSync(path.join(dir, ".git/objects/info/alternates"), "/elsewhere/objects\n")
      }, /alternates/],
    ]
    for (const [name, plant, why] of refusals) {
      it.live(name, () =>
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          seed(dir)
          plant(dir, evil(dir))
          for (const params of calls) {
            const message = yield* failure(invoke(dir, params))
            expect(message).toContain("git tool refused")
            expect(message).toMatch(why)
            expect(fired(dir)).toBe(false)
          }
        }),
      )
    }

    it.live("a .git that leads to another repository", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        const other = `${dir}-other`
        fs.mkdirSync(other)
        seed(other)
        fs.rmSync(path.join(dir, ".git"), { recursive: true })
        fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(other, ".git")}\n`)
        expect(yield* failure(invoke(dir, { subcommand: "log" }))).toContain("outside this project")
      }),
    )

    it.live("a commondir that leads to another repository", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        const other = `${dir}-other`
        fs.mkdirSync(other)
        seed(other)
        fs.writeFileSync(path.join(dir, ".git/commondir"), `${path.join(other, ".git")}\n`)
        expect(yield* failure(invoke(dir, { subcommand: "log" }))).toContain("commondir")
      }),
    )

    it.live("objects that are a link out", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        const moved = `${dir}-objects`
        fs.renameSync(path.join(dir, ".git/objects"), moved)
        fs.symlinkSync(moved, path.join(dir, ".git/objects"))
        expect(yield* failure(invoke(dir, { subcommand: "log" }))).toContain("symbolic link")
      }),
    )

    it.live("a real linked worktree is still read", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        const linked = `${dir}-linked`
        plain(dir, "worktree", "add", "-q", "-b", "other", linked)
        const result = yield* invoke(linked, { subcommand: "log" })
        expect(result.output).toContain("second")
        fs.rmSync(linked, { recursive: true, force: true })
      }),
    )
  })

  describe("arguments are named, and nothing else gets through", () => {
    for (const revision of [
      "--output=/tmp/x",
      "-p",
      "--ext-diff",
      "HEAD:.env",
      "HEAD^{tree}",
      "HEAD^{/secret}",
      ":/secret",
      "a;b",
      "$(touch x)",
      "`touch x`",
      "HEAD\nHEAD",
      "HEAD HEAD",
      "..",
      "a..b..c",
      "@{u}",
    ]) {
      it.live(`refuses revision ${JSON.stringify(revision)}`, () =>
        Effect.gen(function* () {
          const dir = yield* tmpdirScoped()
          seed(dir)
          expect(yield* failure(invoke(dir, { subcommand: "log", revision }))).toContain("not a plain commit")
        }),
      )
    }

    it.live("a range is only for diff and log", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        expect(yield* failure(invoke(dir, { subcommand: "show", revision: "HEAD~1..HEAD" }))).toContain("not a plain commit")
        expect(yield* failure(invoke(dir, { subcommand: "blame", revision: "HEAD~1..HEAD", paths: ["src/a.txt"] }))).toContain("not a plain commit")
      }),
    )

    it.live("a blob's id is not a commit, so its content does not come out with no name on it", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        const blob = plain(dir, "rev-parse", "HEAD:src/a.txt").stdout.trim()
        for (const subcommand of ["show", "diff", "log"])
          expect(yield* failure(invoke(dir, { subcommand, revision: blob }))).toContain("not a commit")
      }),
    )

    it.live("paths stay in the project, taken literally", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        const out = `${dir}-out`
        fs.mkdirSync(out)
        fs.writeFileSync(path.join(out, "s.txt"), "OUTSIDE\n")
        fs.symlinkSync(path.join(out, "s.txt"), path.join(dir, "link"))
        fs.symlinkSync(out, path.join(dir, "linkdir"))
        for (const given of ["/etc/hosts", "../x", "link", "linkdir/s.txt", path.join(out, "s.txt")])
          expect(yield* failure(invoke(dir, { subcommand: "diff", paths: [given] }))).toContain("outside this project")
        for (const given of [".git/config", ".GIT/config", ".env", ".ENV", "x/.env", "id_rsa", ".envs/prod"])
          expect(yield* failure(invoke(dir, { subcommand: "blame", paths: [given] }))).toContain("may hold secrets")
        expect(yield* failure(invoke(dir, { subcommand: "diff", paths: ["a\nb"] }))).toContain("control character")
        // A pathspec character is a file name here, so this names nothing rather than everything.
        expect((yield* invoke(dir, { subcommand: "diff", paths: ["*"] })).output).toBe("(no output)")
        expect((yield* invoke(dir, { subcommand: "diff", paths: [":(top)"] })).output).toBe("(no output)")
        expect((yield* invoke(dir, { subcommand: "diff", paths: ["src/a.txt"] })).output).toContain("three")
        fs.mkdirSync(path.join(dir, "-p"))
        expect((yield* invoke(dir, { subcommand: "status", paths: ["-p"] })).output).not.toContain("three")
      }),
    )

    it.live("needs one file for blame and for a file at a revision", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        expect(yield* failure(invoke(dir, { subcommand: "blame" }))).toContain("exactly one file")
        expect(yield* failure(invoke(dir, { subcommand: "show", fileAtRevision: true, revision: "HEAD" }))).toContain("exactly one file")
      }),
    )
  })

  describe("secrets", () => {
    const withSecret = (dir: string) => {
      seed(dir)
      fs.writeFileSync(path.join(dir, ".env"), "API_KEY=abcSECRETvalue123456\n")
      fs.writeFileSync(path.join(dir, "ok.txt"), "plain\n")
      plain(dir, "add", "-f", ".env", "ok.txt")
      plain(dir, "commit", "-qm", "with secret")
      fs.writeFileSync(path.join(dir, ".env"), "API_KEY=abcSECRETvalue654321\n")
      fs.writeFileSync(path.join(dir, "ok.txt"), "plain 2\n")
    }
    it.live("a diff, a log and a show leave out what a secret file holds, and say so", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        withSecret(dir)
        for (const params of [{ subcommand: "diff" }, { subcommand: "log", patch: true }, { subcommand: "show" }]) {
          const result = yield* invoke(dir, params)
          expect(result.output).not.toContain("abcSECRET")
          expect(result.output).toContain("[withheld: the diff of .env")
          expect(result.output).toMatch(/plain/)
        }
        const stat = yield* invoke(dir, { subcommand: "diff", stat: true })
        expect(stat.output).toContain(".env")
        expect(stat.output).not.toContain("abcSECRET")
      }),
    )

    it.live("a renamed one is still one", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        withSecret(dir)
        plain(dir, "checkout", "-q", "--", ".env", "ok.txt")
        plain(dir, "mv", ".env", "notes.md")
        fs.appendFileSync(path.join(dir, "notes.md"), "MORE=1\n")
        plain(dir, "add", "notes.md")
        plain(dir, "commit", "-qm", "moved")
        const result = yield* invoke(dir, { subcommand: "show" })
        expect(result.output).not.toContain("abcSECRET")
        expect(result.output).toContain("[withheld")
      }),
    )

    it.live("the rest goes through the scrubber", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        seed(dir)
        fs.writeFileSync(path.join(dir, "src/a.txt"), "token sk-abcdefghijklmnopqrstuvwx\n")
        const result = yield* invoke(dir, { subcommand: "diff" })
        expect(result.output).not.toContain("sk-abcdefghijklmnopqrstuvwx")
        expect(result.output).toContain("[hidden:")
      }),
    )

    test("a section is withheld by any name it gives the file", () => {
      for (const header of [
        "diff --git a/.env b/.env\nindex 1..2\n--- a/.env\n+++ b/.env\n",
        "diff --git a/x y/.env b/x y/.env\n--- a/x y/.env\n+++ b/x y/.env\n",
        "diff --git a/.env b/notes.md\nsimilarity index 90%\nrename from .env\nrename to notes.md\n--- a/.env\n+++ b/notes.md\n",
        "diff --git a/.git/x b/.git/x\n",
        "diff --git a/config/secrets.yaml b/config/secrets.yaml\n",
        "diff --git a/.ENV b/.ENV\n",
      ])
        expect(withholdSecretDiffs(`${header}@@ -1 +1 @@\n-SECRET\n+SECRET2\n`)).not.toContain("SECRET")
      const fine = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-diff --git a/.env b/.env\n+x\n"
      expect(withholdSecretDiffs(fine)).toBe(fine)
    })
  })

  it.live("asks nothing of a person in an agent run, under its own permission", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      seed(dir)
      const asked: { permission: string; harmless?: boolean }[] = []
      const result = yield* invoke(dir, { subcommand: "status" }, (req) => asked.push(req))
      expect(asked).toEqual([expect.objectContaining({ permission: "git", harmless: true })])
      expect(result.output).toContain("src/a.txt")
    }),
  )

  it.live("changes nothing it reads", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      seed(dir)
      fs.utimesSync(path.join(dir, "src/a.txt"), new Date(), new Date(Date.now() + 5000))
      const index = () => fs.statSync(path.join(dir, ".git/index")).mtimeMs
      const before = index()
      yield* noneFire(dir)
      expect(index()).toBe(before)
    }),
  )

  it.live("says plainly when this is no repository", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
      expect(yield* failure(invoke(dir, { subcommand: "status" }))).toContain("not a git repository")
    }),
  )
})
