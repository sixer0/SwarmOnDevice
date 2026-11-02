// Reading a repository with no shell in the way. Fixed subcommands, argv only, literal pathspecs. Git only runs in a repository
// git-guard.ts has read and found plain, so nothing it configures can name a program. The settings below are a second layer.
// Anything else is refused with the reason, so the agent can use the shell and a person gets asked.
import { execFile } from "node:child_process"
import { devNull } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { findProgram } from "../util/find-program"
import DESCRIPTION from "./git.txt"
import { GitGuard } from "./git-guard"
import { Reach } from "./reach"
import { Secrets } from "./secrets"
import * as Tool from "./tool"

// What comes back from git, and what goes on from here. Enough to read, and small enough that nothing after it can stall.
const MAX_FROM_GIT = 1024 * 1024
// Below the general cut for tool results, so the note a reader gets is this one and not a file to go and read.
const MAX_OUTPUT = 48 * 1024
const TIMEOUT_MS = 15_000
const DEFAULT_LOG = 20
const MAX_LOG = 200

export const Parameters = Schema.Struct({
  subcommand: Schema.Literals(["status", "diff", "log", "show", "blame", "branch"]).annotate({
    description: "What to read. branch lists branches and changes nothing.",
  }),
  revision: Schema.optional(Schema.String).annotate({
    description: "A commit, tag or branch such as HEAD~1 or main. diff and log also take a range such as main..HEAD.",
  }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Limit to these files or directories, taken literally. blame needs exactly one file.",
  }),
  staged: Schema.optional(Schema.Boolean).annotate({ description: "diff: what is staged rather than what is not." }),
  stat: Schema.optional(Schema.Boolean).annotate({ description: "diff, log, show: changed files and counts, no patch." }),
  patch: Schema.optional(Schema.Boolean).annotate({ description: "log: include each commit's patch." }),
  limit: Schema.optional(Schema.Number).annotate({ description: `log: how many commits, at most ${MAX_LOG}. Defaults to ${DEFAULT_LOG}.` }),
  fileAtRevision: Schema.optional(Schema.Boolean).annotate({
    description: "show: the content of the one file in paths as it was at revision, instead of the commit.",
  }),
  startLine: Schema.optional(Schema.Number).annotate({ description: "blame: first line." }),
  endLine: Schema.optional(Schema.Number).annotate({ description: "blame: last line." }),
  all: Schema.optional(Schema.Boolean).annotate({ description: "branch: include remote-tracking branches." }),
})
type Params = Schema.Schema.Type<typeof Parameters>

// Every one of these beats a repository's own config, because a -c on the command line is read last.
export const HARDENED_CONFIG = [
  "core.fsmonitor=false",
  `core.hooksPath=${devNull}`,
  "core.sshCommand=",
  "core.gitProxy=",
  "core.pager=cat",
  "core.alternateRefsCommand=",
  `core.attributesFile=${devNull}`,
  `core.excludesFile=${devNull}`,
  "core.askPass=",
  "core.quotePath=true",
  "diff.external=",
  // A diff brings the index up to date when it can, optional locks or not, and this tool writes nothing.
  "diff.autoRefreshIndex=false",
  `diff.orderFile=${devNull}`,
  "diff.ignoreSubmodules=all",
  "diff.submodule=short",
  "status.submoduleSummary=false",
  "submodule.recurse=false",
  "credential.helper=",
  "gpg.program=",
  "gpg.ssh.program=",
  "gpg.openpgp.program=",
  "gpg.x509.program=",
  "gpg.ssh.defaultKeyCommand=",
  "gpg.ssh.revocationFile=",
  "log.showSignature=false",
  "log.mailmap=false",
  "mailmap.file=",
  "mailmap.blob=",
  "blame.ignoreRevsFile=",
  "color.ui=false",
  "column.ui=never",
  "protocol.allow=never",
  "gc.auto=0",
  "maintenance.auto=false",
]

const NO_DRIVERS = ["--no-ext-diff", "--no-textconv"]
// A submodule's own git runs without any -c from here, and its config is whatever that directory says.
const NO_SUBMODULES = ["--ignore-submodules=all", "--submodule=short"]

/** Nothing of the server's environment except where programs live, so no GIT_* or PAGER of anyone's reaches git. */
export function hardenedEnv(instance: InstanceContext) {
  const safePath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && !containsPath(Reach.real(entry) ?? entry, instance))
    .join(path.delimiter)
  return {
    PATH: safePath,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
    HOME: devNull,
    XDG_CONFIG_HOME: devNull,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_ALLOW_PROTOCOL: "",
  }
}

function run(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(
      binary,
      args,
      { cwd, env, encoding: "utf8", maxBuffer: MAX_FROM_GIT, timeout: TIMEOUT_MS, killSignal: "SIGKILL", signal },
      (error, stdout, stderr) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ code: 0, stdout, stderr })
        if (error?.killed) return resolve({ code: 1, stdout, stderr: `stopped after ${TIMEOUT_MS / 1000} seconds` })
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0
        resolve({ code, stdout, stderr: error && !stderr ? error.message : stderr })
      },
    ),
  )
}

// `HEAD`, `main`, `v1.0`, `feature/x`, `abc123`, `HEAD~2`, `HEAD^`, `HEAD@{1}`. No `:`, which names a blob, and no `^{`, `-`
// at the start, `..` or anything else that means more than one commit.
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9_./+-]*(?:@\{\d+\})?(?:[~^]\d*)*$/

function endpoints(revision: string, allowRange: boolean) {
  const range = revision.match(/^(.+?)\.\.\.?(.+)$/)
  if (range && !allowRange) return undefined
  const ends = range ? [range[1]!, range[2]!] : [revision]
  return ends.every((end) => REVISION.test(end) && !end.includes("..")) ? ends : undefined
}

const SHARED_DIFF = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--submodule=short", "--no-color", "--stat"]
const LOG_FORMAT = "--format=%h %s"
const COMMIT_FORMAT = "--format=medium"
const COMMIT = ["--no-show-signature", "--no-mailmap", "--no-notes"]
// Every flag this tool can pass, by subcommand. Parameters already name what can be asked for, so nothing a model sends should
// reach here. This is what holds if that ever stops being true: `git log --output=` writes a file.
const FLAGS: Record<Params["subcommand"], { plain: ReadonlySet<string>; valued: ReadonlySet<string> }> = {
  status: { plain: new Set(["--short", "--branch", "--untracked-files=normal", "--ignore-submodules=all"]), valued: new Set() },
  diff: { plain: new Set([...SHARED_DIFF, "--cached"]), valued: new Set() },
  log: { plain: new Set([...SHARED_DIFF, ...COMMIT, LOG_FORMAT, COMMIT_FORMAT, "-p"]), valued: new Set(["-n"]) },
  show: { plain: new Set([...SHARED_DIFF, ...COMMIT, COMMIT_FORMAT]), valued: new Set() },
  blame: { plain: new Set(["--no-textconv"]), valued: new Set(["-L"]) },
  branch: { plain: new Set(["--list", "--no-color", "--no-column", "-v", "--all"]), valued: new Set() },
}

/** The first argument that is a flag this subcommand has no entry for, up to the `--` that ends flags. */
export function unlistedFlag(subcommand: Params["subcommand"], args: readonly string[]) {
  const allowed = FLAGS[subcommand]
  const end = args.indexOf("--")
  const flags = end < 0 ? args : args.slice(0, end)
  return flags.find((arg, index) => arg.startsWith("-") && !allowed.plain.has(arg) && !allowed.valued.has(arg) && !allowed.valued.has(flags[index - 1] ?? ""))
}

function argv(params: Params, revision: string[], files: string[]) {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? DEFAULT_LOG), 1), MAX_LOG)
  const stat = params.stat ? ["--stat"] : []
  const end = ["--", ...files]
  switch (params.subcommand) {
    case "status":
      return ["status", "--short", "--branch", "--untracked-files=normal", "--ignore-submodules=all", ...end]
    case "diff":
      return ["diff", ...NO_DRIVERS, ...NO_SUBMODULES, "--no-color", ...(params.staged ? ["--cached"] : []), ...stat, ...revision, ...end]
    case "log":
      return [
        "log",
        ...NO_DRIVERS,
        ...NO_SUBMODULES,
        "--no-color",
        ...COMMIT,
        "-n",
        String(limit),
        ...(params.patch ? [COMMIT_FORMAT, "-p"] : params.stat ? [COMMIT_FORMAT, "--stat"] : [LOG_FORMAT]),
        ...revision,
        ...end,
      ]
    case "show":
      if (params.fileAtRevision) return ["show", "--no-textconv", "--no-color", `${revision[0] ?? "HEAD"}:${files[0]}`]
      return ["show", ...NO_DRIVERS, ...NO_SUBMODULES, "--no-color", COMMIT_FORMAT, ...COMMIT, ...stat, ...revision, ...end]
    case "blame": {
      const lines =
        params.startLine !== undefined || params.endLine !== undefined
          ? ["-L", `${Math.max(Math.trunc(params.startLine ?? 1), 1)},${params.endLine !== undefined ? Math.max(Math.trunc(params.endLine), 1) : ""}`]
          : []
      return ["blame", "--no-textconv", ...lines, ...revision, ...end]
    }
    case "branch":
      return ["branch", "--list", "--no-color", "--no-column", "-v", ...(params.all ? ["--all"] : [])]
  }
}

// A patch section starts at a line git writes at column 0, and every line of content has a prefix, so nothing in a file or
// a commit message can start or hide one. Withholding works on a whole section, by every name it gives the file. Lines end at
// \n and nothing else: a lone \r inside a secret file must not start a section that gets to be judged on its own.
// A section is only kept when every line of its header is known and every name in it is safe.
export function withholdSecretDiffs(output: string) {
  const sections = output.split(/(?<![^\n])(?=diff --)/)
  const withheld = new Set<string>()
  const unread = { count: 0 }
  const kept = sections.filter((section) => {
    if (!section.startsWith("diff --")) return true
    const named = sectionNames(section)
    if (!named) {
      unread.count++
      return false
    }
    const secret = named.find((name) => !Reach.readableName(name))
    if (secret) withheld.add(/[\x00-\x1f\x7f]/.test(secret) ? JSON.stringify(secret) : secret)
    return !secret
  })
  if (withheld.size === 0 && unread.count === 0) return output
  return [
    kept.join(""),
    ...(withheld.size > 0 ? [`\n[withheld: the diff of ${[...withheld].join(", ")}, which holds secrets]\n`] : []),
    ...(unread.count > 0 ? [`\n[withheld: ${unread.count} diff section(s) this tool could not read for certain]\n`] : []),
  ].join("")
}

const HEADER_PLAIN = /^(?:index|mode|old mode|new mode|new file mode|deleted file mode|similarity index|dissimilarity index) /
const HEADER_PATH = /^(---|\+\+\+) (.+)$/
const HEADER_NAME = /^(?:rename from|rename to|copy from|copy to|\* Unmerged path) (.+)$/
const QUOTED = /^"(?:[^"\\]|\\.)*"$/
const C_ESCAPE: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" }

/** Every name a section's header gives its file, or undefined if any part of that header is not a form git is known to write. */
function sectionNames(section: string) {
  const lines = section.split("\n")
  const end = lines.findIndex((line) => line === "" || /^(?:@@|Binary files |GIT binary patch)/.test(line))
  const header = lines.slice(1, end < 0 ? undefined : end)
  const first = lines[0]!.match(/^diff --(git|cc|combined) (.+)$/)
  if (!first) return undefined
  const named = [
    // Either side can hold a space, so this can cut one name in several. Each piece gets judged, and that only adds to what is held back.
    ...(first[1] === "git" ? first[2]!.split(/ (?=b\/|"b\/)/).map(prefixed) : [unquote(first[2]!)]),
    ...header.map((line) => {
      if (HEADER_PLAIN.test(line)) return null
      const named = line.match(HEADER_NAME)
      if (named) return unquote(named[1]!)
      const path = line.match(HEADER_PATH)
      // Git puts a tab after a name that has a space in it.
      if (path) return path[2] === devNull ? null : prefixed(path[2]!.replace(/\t$/, ""))
      return undefined
    }),
  ].filter((name) => name !== null)
  return named.every((name) => name) ? (named as string[]) : undefined
}

function prefixed(raw: string) {
  return unquote(raw)?.match(/^[ab]\/(.+)$/s)?.[1]
}

// Names with anything odd in them, which includes any byte past ASCII here (core.quotePath), come from git C-quoted.
function unquote(raw: string) {
  if (!raw.includes('"')) return raw
  if (!QUOTED.test(raw)) return undefined
  const bytes = raw.slice(1, -1).replace(/\\([0-7]{3}|.)/gs, (_, code: string) => (code.length === 3 ? String.fromCharCode(parseInt(code, 8)) : (C_ESCAPE[code] ?? code)))
  return Buffer.from(bytes, "latin1").toString("utf8")
}

// A commit message or a file can hold anything. Whoever reads the output should see the text, not what a terminal does with it.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

export const GitTool = Tool.define(
  "git",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          // What this repository is, which only the shell can work with, is an answer and not a failed call. A bad argument is
          // another matter: fix the call.
          const refuseRepository = (why: string) => ({
            title: `git ${params.subcommand} refused`,
            // The line a person sees on the row. The model may never repeat the output, as measured: 0 of 4 ordinary jobs did.
            metadata: { subcommand: params.subcommand, truncated: false, refused: `refused: ${why}. The shell can do it, and asks.` as string | undefined },
            output: `git tool refused: ${why}. Nothing was run. Use the shell (bash) for this repository: it asks a person.`,
          })
          const refuse = (why: string) => Effect.fail(new Error(`git tool refused: ${why}.`))

          if (instance.project.vcs !== "git") return refuseRepository("this project is not a git repository")
          const guarded = GitGuard.inspect(instance.worktree)
          if (guarded.refused !== undefined) return refuseRepository(guarded.refused)
          const env = hardenedEnv(instance)
          const binary = findProgram("git", env.PATH)
          if (!binary) return refuseRepository("no git program outside this project")

          // Reading runs nothing, by everything above. Windows has not been tried, so it keeps asking there.
          yield* ctx.ask({
            permission: "git",
            patterns: [params.subcommand],
            always: ["*"],
            metadata: { subcommand: params.subcommand, revision: params.revision, paths: params.paths },
            harmless: ctx.trust && process.platform !== "win32" ? true : undefined,
          })

          const git = (args: string[]) =>
            Effect.promise(() =>
              run(
                binary,
                [
                  `--git-dir=${guarded.gitDir}`,
                  `--work-tree=${instance.worktree}`,
                  "--no-pager",
                  "--no-optional-locks",
                  ...HARDENED_CONFIG.flatMap((setting) => ["-c", setting]),
                  ...args,
                ],
                instance.worktree,
                env,
                ctx.abort,
              ),
            )

          const files = (params.paths ?? []).map((given) => {
            const full = path.resolve(instance.directory, given)
            const relative = path.relative(instance.worktree, full)
            // Written for what comes after `--`, where nothing is a flag: only what is odd about a path is refused.
            if (/[\x00-\x1f\x7f]/.test(given)) return { refused: `${JSON.stringify(given)} has a control character` }
            if (relative.startsWith("..") || path.isAbsolute(relative) || !Reach.inside(full, instance))
              return { refused: `${given} is outside this project` }
            if (!Reach.readable(full)) return { refused: `${given} may hold secrets, so this tool does not show it. Use the read tool, which asks` }
            return { relative: relative || "." }
          })
          const badPath = files.find((file) => file.refused !== undefined)
          if (badPath?.refused) return yield* refuse(badPath.refused)
          const relative = files.flatMap((file) => (file.relative ? [file.relative] : []))

          const needsOneFile = params.subcommand === "blame" || params.fileAtRevision === true
          if (needsOneFile && relative.length !== 1) return yield* refuse(`${params.subcommand} needs exactly one file in paths`)
          if (params.fileAtRevision && params.subcommand !== "show") return yield* refuse("fileAtRevision is for show")

          const allowsRange = params.subcommand === "diff" || params.subcommand === "log"
          const ends = params.revision === undefined ? [] : endpoints(params.revision, allowsRange)
          if (!ends) return yield* refuse(`${params.revision} is not a plain commit, tag or branch name`)
          // Commits only. A blob's id would show that file's content with no name to judge it by.
          for (const end of ends) {
            const known = yield* git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${end}^{commit}`])
            if (known.code !== 0) return yield* refuse(`${end} is not a commit here`)
          }
          const revision = params.revision === undefined || params.subcommand === "status" || params.subcommand === "branch" ? [] : [params.revision]

          const args = argv(params, revision, relative)
          const unlisted = unlistedFlag(params.subcommand, args.slice(1))
          if (unlisted) return yield* refuse(`${unlisted} is not a flag this tool passes to git ${params.subcommand}`)
          const result = yield* git(args)
          // Scrubbed before the cut, since half a secret at the cut would no longer be recognised afterwards.
          // A file at a revision is that file's own text, already judged by its name above. A line in it is not a section of anything.
          const shown = params.fileAtRevision ? result.stdout : withholdSecretDiffs(result.stdout)
          const full = Secrets.scrub(shown.replace(CONTROL, ""), instance.worktree)
          const cut = full.length > MAX_OUTPUT || result.stdout.length >= MAX_FROM_GIT
          const text = cut
            ? `${full.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT / 1024} KB. There is more. Narrow it with limit, revision or paths.]\n`
            : full
          if (result.code !== 0) {
            return yield* Effect.fail(new Error(Secrets.scrub(`git ${params.subcommand} failed: ${result.stderr.replace(CONTROL, "").trim()}`, instance.worktree)))
          }
          return {
            title: `git ${params.subcommand}`,
            metadata: { subcommand: params.subcommand, truncated: cut, refused: undefined },
            output: text || "(no output)",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
