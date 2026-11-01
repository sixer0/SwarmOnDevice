import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Layer, Context, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { devNull } from "os"

const cfg = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fsmonitor=false",
  // git passes -c settings down to a child it starts inside a submodule. "dirty" means it starts none, so the submodule's own
  // clean filter or hook never runs, and a submodule whose commit moved still shows.
  "-c",
  "diff.ignoreSubmodules=dirty",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.quotepath=false",
] as const

const out = (result: { text(): string }) => result.text().trim()
const nuls = (text: string) => text.split("\0").filter(Boolean)
const fail = (err: unknown) =>
  ({
    exitCode: 1,
    text: () => "",
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
    truncated: false,
  }) satisfies Result

export type Kind = "added" | "deleted" | "modified"

export type Base = {
  readonly name: string
  readonly ref: string
}

export type Item = {
  readonly file: string
  readonly code: string
  readonly status: Kind
}

export type Stat = {
  readonly file: string
  readonly additions: number
  readonly deletions: number
}

export type Patch = {
  readonly text: string
  readonly truncated: boolean
}

export interface PatchOptions {
  readonly context?: number
  readonly maxOutputBytes?: number
}

export interface Result {
  readonly exitCode: number
  readonly text: () => string
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly truncated: boolean
}

export interface Options {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly maxOutputBytes?: number
  readonly stdin?: ChildProcess.CommandInput
  /**
   * A person asked for this exact action. In a folder nobody has trusted it still happens, with the repository's own programs
   * switched off, where a background read would simply be skipped.
   */
  readonly personAsked?: boolean
}

export interface Interface {
  readonly run: (args: string[], opts: Options) => Effect.Effect<Result>
  readonly branch: (cwd: string) => Effect.Effect<string | undefined>
  readonly prefix: (cwd: string) => Effect.Effect<string>
  readonly defaultBranch: (cwd: string) => Effect.Effect<Base | undefined>
  readonly hasHead: (cwd: string) => Effect.Effect<boolean>
  readonly mergeBase: (cwd: string, base: string, head?: string) => Effect.Effect<string | undefined>
  readonly show: (cwd: string, ref: string, file: string, prefix?: string) => Effect.Effect<string>
  readonly status: (cwd: string) => Effect.Effect<Item[]>
  readonly diff: (cwd: string, ref: string) => Effect.Effect<Item[]>
  readonly stats: (cwd: string, ref: string) => Effect.Effect<Stat[]>
  readonly patch: (cwd: string, ref: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchAll: (cwd: string, ref: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchUntracked: (cwd: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly statUntracked: (cwd: string, file: string) => Effect.Effect<Stat | undefined>
  readonly applyPatch: (cwd: string, patch: string) => Effect.Effect<Result>
}

const kind = (code: string): Kind => {
  if (code === "??") return "added"
  if (code.includes("U")) return "modified"
  if (code.includes("A") && !code.includes("D")) return "added"
  if (code.includes("D") && !code.includes("A")) return "deleted"
  return "modified"
}

const programCommands = new Set(["status", "diff", "show", "add", "stash"])

// What a commit or an apply can start from a repository's own config: its hooks, a filter, a signing program, and an automatic
// gc that fires its own hook. The filters come from configFilters. An editor needs no setting: these actions never open one.
const PROGRAMS_OFF = [
  ["core.hooksPath", devNull],
  ["commit.gpgSign", "false"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
] as const
const FILTER_KEY = /^filter\.(.+)\.[^.]+$/s

/** The filters this repository's own config defines, as git itself reads them, includes and all. The user's global ones stay on. */
const configFilters = (listed: string) => {
  const parts = listed.split("\0").filter(Boolean)
  const names = parts.flatMap((scope, index) => {
    if (index % 2 !== 0 || !["local", "worktree"].includes(scope)) return []
    return FILTER_KEY.exec(parts[index + 1] ?? "")?.[1] ?? []
  })
  return [...new Set(names)]
}

// Through the environment and not -c, because a key and its value stay apart there: a filter may be called `a=b`.
const programsOffEnv = (filters: readonly string[]) => {
  const settings = [
    ...PROGRAMS_OFF,
    ...filters.flatMap((name) => [
      [`filter.${name}.clean`, ""],
      [`filter.${name}.smudge`, ""],
      [`filter.${name}.process`, ""],
      [`filter.${name}.required`, "false"],
    ]),
  ]
  return {
    GIT_CONFIG_COUNT: String(settings.length),
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...Object.fromEntries(
      settings.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Git") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const encoder = new TextEncoder()
    const stdin = (text: string) => Stream.make(encoder.encode(text))

    const run = Effect.fn("Git.run")(
      function* (args: string[], opts: Options) {
        // These hash or render files, and a repository's own config can name the program that does it. Nobody has said
        // that may run in this folder yet, so the reader sees no changes, the same as a clean tree.
        const command = args.find((item) => !item.startsWith("-"))
        if (!opts.personAsked && command && programCommands.has(command) && ProjectTrust.heldGitSetting(opts.cwd))
          return { exitCode: 0, text: () => "", stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false } satisfies Result
        const held = opts.personAsked && !ProjectTrust.isTrusted(opts.cwd)
        const listed = held
          ? yield* appProcess.run(
              ChildProcess.make("git", ["config", "-z", "--show-scope", "--name-only", "--get-regexp", "^filter\\."], {
                cwd: opts.cwd,
                extendEnv: true,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            )
          : undefined
        // 1 means no filters. Anything else means the list cannot be relied on, so the action does not go ahead without it.
        if (listed && listed.exitCode !== 0 && listed.exitCode !== 1)
          return { ...fail(listed.stderr.toString("utf8")), exitCode: listed.exitCode } satisfies Result
        const result = yield* appProcess.run(
          ChildProcess.make("git", [...cfg, ...args], {
            cwd: opts.cwd,
            env: listed ? { ...programsOffEnv(configFilters(listed.stdout.toString("utf8"))), ...opts.env } : opts.env,
            extendEnv: true,
            stdin: opts.stdin ?? "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
          { maxOutputBytes: opts.maxOutputBytes },
        )
        return {
          exitCode: result.exitCode,
          text: () => result.stdout.toString("utf8"),
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.stdoutTruncated || result.stderrTruncated,
        } satisfies Result
      },
      Effect.catch((err) => Effect.succeed(fail(err))),
    )

    const text = Effect.fn("Git.text")(function* (args: string[], opts: Options) {
      return (yield* run(args, opts)).text()
    })

    const lines = Effect.fn("Git.lines")(function* (args: string[], opts: Options) {
      return (yield* text(args, opts))
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    })

    const refs = Effect.fnUntraced(function* (cwd: string) {
      return yield* lines(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd })
    })

    const configured = Effect.fnUntraced(function* (cwd: string, list: string[]) {
      const result = yield* run(["config", "init.defaultBranch"], { cwd })
      const name = out(result)
      if (!name || !list.includes(name)) return
      return { name, ref: name } satisfies Base
    })

    const primary = Effect.fnUntraced(function* (cwd: string) {
      const list = yield* lines(["remote"], { cwd })
      if (list.includes("origin")) return "origin"
      if (list.length === 1) return list[0]
      if (list.includes("upstream")) return "upstream"
      return list[0]
    })

    const branch = Effect.fn("Git.branch")(function* (cwd: string) {
      const result = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const prefix = Effect.fn("Git.prefix")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--show-prefix"], { cwd })
      if (result.exitCode !== 0) return ""
      return out(result)
    })

    const defaultBranch = Effect.fn("Git.defaultBranch")(function* (cwd: string) {
      const remote = yield* primary(cwd)
      if (remote) {
        const head = yield* run(["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd })
        if (head.exitCode === 0) {
          const ref = out(head).replace(/^refs\/remotes\//, "")
          const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
          if (name) return { name, ref } satisfies Base
        }
      }

      const list = yield* refs(cwd)
      const next = yield* configured(cwd, list)
      if (next) return next
      if (list.includes("main")) return { name: "main", ref: "main" } satisfies Base
      if (list.includes("master")) return { name: "master", ref: "master" } satisfies Base
    })

    const hasHead = Effect.fn("Git.hasHead")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--verify", "HEAD"], { cwd })
      return result.exitCode === 0
    })

    const mergeBase = Effect.fn("Git.mergeBase")(function* (cwd: string, base: string, head = "HEAD") {
      const result = yield* run(["merge-base", base, head], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const show = Effect.fn("Git.show")(function* (cwd: string, ref: string, file: string, prefix = "") {
      const target = prefix ? `${prefix}${file}` : file
      const result = yield* run(["show", `${ref}:${target}`], { cwd })
      if (result.exitCode !== 0) return ""
      if (result.stdout.includes(0)) return ""
      return result.text()
    })

    const status = Effect.fn("Git.status")(function* (cwd: string) {
      return nuls(
        yield* text(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
          cwd,
        }),
      ).flatMap((item) => {
        const file = item.slice(3)
        if (!file) return []
        const code = item.slice(0, 2)
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const diff = Effect.fn("Git.diff")(function* (cwd: string, ref: string) {
      const list = nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, "--", "."], { cwd }),
      )
      return list.flatMap((code, idx) => {
        if (idx % 2 !== 0) return []
        const file = list[idx + 1]
        if (!code || !file) return []
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const stats = Effect.fn("Git.stats")(function* (cwd: string, ref: string) {
      return nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, "--", "."], { cwd }),
      ).flatMap((item) => {
        const a = item.indexOf("\t")
        const b = item.indexOf("\t", a + 1)
        if (a === -1 || b === -1) return []
        const file = item.slice(b + 1)
        if (!file) return []
        const adds = item.slice(0, a)
        const dels = item.slice(a + 1, b)
        const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10)
        const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10)
        return [
          {
            file,
            additions: Number.isFinite(additions) ? additions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
          } satisfies Stat,
        ]
      })
    })

    const patch = Effect.fn("Git.patch")(function* (cwd: string, ref: string, file: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", file],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchAll = Effect.fn("Git.patchAll")(function* (cwd: string, ref: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", "."],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchUntracked = Effect.fn("Git.patchUntracked")(function* (
      cwd: string,
      file: string,
      options?: PatchOptions,
    ) {
      const result = yield* run(
        [
          "diff",
          "--no-index",
          "--patch",
          "--no-ext-diff",
          "--no-renames",
          `--unified=${options?.context ?? 3}`,
          "--",
          "/dev/null",
          file,
        ],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const statUntracked = Effect.fn("Git.statUntracked")(function* (cwd: string, file: string) {
      const result = yield* run(["diff", "--no-index", "--numstat", "--", "/dev/null", file], {
        cwd,
        maxOutputBytes: 4096,
      })

      if (result.truncated) return
      const text = result.text()

      const parts = text.split("\t")
      if (parts.length < 2) return

      const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0] || "0", 10)
      const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1] || "0", 10)
      return {
        file,
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
      } satisfies Stat
    })

    const applyPatch = Effect.fn("Git.applyPatch")(function* (cwd: string, patch: string) {
      return yield* run(["apply", "-"], { cwd, stdin: stdin(patch), personAsked: true })
    })

    return Service.of({
      run,
      branch,
      prefix,
      defaultBranch,
      hasHead,
      mergeBase,
      show,
      status,
      diff,
      stats,
      patch,
      patchAll,
      patchUntracked,
      statUntracked,
      applyPatch,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [AppProcess.node] })

export * as Git from "."
