// Reading a repository with no shell in the way. Fixed subcommands, argv only, literal pathspecs, and nothing the repository
// can configure gets to run: what can be switched off from outside is switched off, and a repository configured with
// something that cannot be is refused, with the reason, so the agent can use the shell and a person gets asked.
import { execFile } from "node:child_process"
import fs from "node:fs"
import { devNull } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath, type InstanceContext } from "../project/instance-context"
import DESCRIPTION from "./git.txt"
import { Reach } from "./reach"
import { Secrets } from "./secrets"
import * as Tool from "./tool"

const MAX_OUTPUT = 4 * 1024 * 1024
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
  `diff.orderFile=${devNull}`,
  "diff.ignoreSubmodules=all",
  "diff.submodule=short",
  "status.submoduleSummary=false",
  "submodule.recurse=false",
  "credential.helper=",
  "gpg.program=",
  "gpg.ssh.program=",
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
      { cwd, env, encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: TIMEOUT_MS, killSignal: "SIGKILL", signal },
      (error, stdout, stderr) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return resolve({ code: 0, stdout: `${stdout}\n[output cut at ${MAX_OUTPUT} bytes. Narrow it with limit, revision or paths.]\n`, stderr })
        if (error?.killed) return resolve({ code: 1, stdout, stderr: `stopped after ${TIMEOUT_MS / 1000} seconds` })
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0
        resolve({ code, stdout, stderr: error && !stderr ? error.message : stderr })
      },
    ),
  )
}

// Allowed in a repository's config because git only runs what the flags above have already turned off, or never runs it for
// these subcommands. These cannot be turned off from outside, or only by accident of the version, so they are refused.
const UNSAFE_CONFIG: [RegExp, string][] = [
  [/^filter\..*\.(clean|smudge|process)$/, "a content filter, which git runs on files it reads"],
  [/^hook\./, "a hook defined in config, which core.hooksPath does not cover"],
  [/^remote\..*\.(promisor|partialclonefilter)$/, "a partial clone, which can fetch from the network while reading"],
  [/^core\.worktree$/, "core.worktree, which moves the working tree somewhere else"],
]
const KNOWN_EXTENSIONS = new Set(["objectformat", "worktreeconfig", "noop", "refstorage", "compatobjectformat"])

// A pointer file in a checkout can be a FIFO, and reading one here would hang the server rather than a child that can be killed.
function pointer(file: string) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false })
  return info?.isFile() && info.size < 4096 ? fs.readFileSync(file, "utf8") : undefined
}

/**
 * The repository's git directory, or why this tool will not read it. Everything it reads has to be in the project, or be
 * the record of a linked worktree that names this project back, which a hostile checkout cannot forge from inside itself.
 */
function locate(instance: InstanceContext) {
  const dotGit = path.join(instance.worktree, ".git")
  const info = fs.lstatSync(dotGit, { throwIfNoEntry: false })
  if (!info) return { refused: "there is no .git at the top of this project" }
  const target = info.isFile() ? pointer(dotGit)?.match(/^gitdir: (.+?)\s*$/m)?.[1] : dotGit
  if (!target) return { refused: ".git is not a repository" }
  const gitDir = Reach.real(path.resolve(instance.worktree, target))
  if (!gitDir) return { refused: ".git leads nowhere" }
  const inside = Reach.inside(gitDir, instance)
  const backPointer = pointer(path.join(gitDir, "gitdir"))?.trim()
  const linked = path.basename(path.dirname(gitDir)) === "worktrees" && backPointer !== undefined && Reach.real(backPointer) === Reach.real(dotGit)
  if (!inside && !linked) return { refused: ".git points outside this project" }
  const commonFile = path.join(gitDir, "commondir")
  if (fs.existsSync(commonFile) && pointer(commonFile) === undefined) return { refused: "its commondir is not a plain file" }
  const common = fs.existsSync(commonFile) ? Reach.real(path.resolve(gitDir, pointer(commonFile)!.trim())) : gitDir
  if (!common || !(Reach.inside(common, instance) || (linked && common === path.dirname(path.dirname(gitDir)))))
    return { refused: "its commondir points outside this project" }
  const leaves = [...["config", "objects", "refs", "packed-refs"].map((name) => path.join(common, name)), path.join(gitDir, "HEAD"), path.join(gitDir, "index")]
  if (leaves.some((file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()))
    return { refused: "part of .git is a symbolic link, which can lead outside this project" }
  if (fs.existsSync(path.join(common, "objects/info/alternates")))
    return { refused: "it borrows objects from another repository through objects/info/alternates" }
  return { gitDir }
}

/** Why this repository's config cannot be read safely, if it cannot. */
function unsafeKey(names: string[]) {
  for (const name of names) {
    const hit = UNSAFE_CONFIG.find(([pattern]) => pattern.test(name))
    if (hit) return `${name} is ${hit[1]}`
    if (name.startsWith("extensions.") && !KNOWN_EXTENSIONS.has(name.slice("extensions.".length)))
      return `${name} is a repository extension this tool does not know`
  }
  return undefined
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
        "--no-show-signature",
        "--no-mailmap",
        "--no-notes",
        "-n",
        String(limit),
        ...(params.patch ? ["-p"] : params.stat ? ["--stat"] : ["--oneline"]),
        ...revision,
        ...end,
      ]
    case "show":
      if (params.fileAtRevision) return ["show", "--no-textconv", "--no-color", `${revision[0] ?? "HEAD"}:${files[0]}`]
      return ["show", ...NO_DRIVERS, ...NO_SUBMODULES, "--no-color", "--no-show-signature", "--no-mailmap", "--no-notes", ...stat, ...revision, ...end]
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
// a commit message can start or hide one. Withholding works on a whole section, by every name it gives the file.
export function withholdSecretDiffs(output: string) {
  const sections = output.split(/^(?=diff --git )/m)
  const withheld = new Set<string>()
  const kept = sections.filter((section) => {
    if (!section.startsWith("diff --git ")) return true
    const header = section.slice(0, Math.max(section.search(/^(?:@@|Binary files|GIT binary patch)/m), 0) || section.length)
    const named = [
      ...header.split("\n")[0]!.slice("diff --git ".length).split(/ (?=b\/)/),
      ...[...header.matchAll(/^(?:---|\+\+\+|rename from|rename to|copy from|copy to) (.+)$/gm)].map((match) => match[1]!),
    ]
      .map((name) => name.replace(/^"|"$/g, "").replace(/^[ab]\//, ""))
      .filter((name) => name !== devNull)
    const secret = named.find((name) => !Reach.readableName(name))
    if (secret) withheld.add(secret)
    return !secret
  })
  if (withheld.size === 0) return output
  return `${kept.join("")}\n[withheld: the diff of ${[...withheld].join(", ")}, which holds secrets]\n`
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
          const refuse = (why: string) =>
            Effect.fail(new Error(`git tool refused: ${why}. Nothing was run. Use the shell if a person should decide.`))

          // Reading runs nothing, by everything below. Windows has not been tried, so it keeps asking there.
          yield* ctx.ask({
            permission: "git",
            patterns: [params.subcommand],
            always: ["*"],
            metadata: { subcommand: params.subcommand, revision: params.revision, paths: params.paths },
            harmless: ctx.trust && process.platform !== "win32" ? true : undefined,
          })

          if (instance.project.vcs !== "git") return yield* refuse("this project is not a git repository")
          const binary = Bun.which("git", { PATH: hardenedEnv(instance).PATH })
          if (!binary) return yield* refuse("no git program outside this project")
          const located = locate(instance)
          if (located.refused !== undefined) return yield* refuse(located.refused)

          const env = hardenedEnv(instance)
          const git = (args: string[]) =>
            Effect.promise(() =>
              run(
                binary,
                [
                  `--git-dir=${located.gitDir}`,
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

          const config = yield* git(["config", "--list", "--name-only", "--includes", "-z"])
          if (config.code !== 0) return yield* refuse("its config could not be read")
          const unsafe = unsafeKey(config.stdout.split("\0").filter(Boolean))
          if (unsafe) return yield* refuse(`this repository's config sets ${unsafe}`)

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

          const result = yield* git(argv(params, revision, relative))
          const text = withholdSecretDiffs(result.stdout).replace(CONTROL, "")
          if (result.code !== 0) {
            return yield* Effect.fail(new Error(Secrets.scrub(`git ${params.subcommand} failed: ${result.stderr.replace(CONTROL, "").trim()}`, instance.worktree)))
          }
          return {
            title: `git ${params.subcommand}`,
            metadata: { subcommand: params.subcommand },
            output: text || "(no output)",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
