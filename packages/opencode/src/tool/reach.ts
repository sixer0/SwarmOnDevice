// Where a path really lands, and whether Undo can bring it back. A name inside the project proves nothing on its own: a
// symlink can carry it anywhere, and the step's snapshot leaves ignored files, large files and nested repositories out.
import fs from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import os, { devNull } from "node:os"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Option } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Vault } from "@opencode-ai/core/vault"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { Risk } from "./risk"
import { Secrets } from "./secrets"
import { SKILL_FOLDER_HELD_TEXT, VAULT_MIRROR_REFUSED_TEXT } from "../permission/autonomy-texts"

const git = promisify(execFile)
// Asking whether Undo can help must not itself run what the repository says to.
const QUIET = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`]
// Matches the size above which a step's snapshot leaves an untracked file out.
const SNAPSHOT_FILE_LIMIT = 2 * 1024 * 1024
const MAX_LINKS = 40

/**
 * The path a write here would really touch, including through a dangling link, which a write would create on the far
 * side of. undefined means it could not be worked out, such as a link loop.
 */
export function real(file: string, depth = 0): string | undefined {
  if (depth > MAX_LINKS) return undefined
  const whole = asked("realpath", file, () => {
    realpathCalls++
    return fs.realpathSync.native(file)
  })
  if (whole) return whole
  const parent = path.dirname(file)
  if (parent === file) return file
  const link = asked("readlink", file, () => fs.readlinkSync(file))
  if (link) return real(path.resolve(parent, link), depth + 1)
  const base = real(parent, depth + 1)
  return base && path.join(base, path.basename(file))
}

/**
 * 1.1.1 F17 (G7-P1): inside a `snapshotScope` the file system is asked each question about a path once; outside one,
 * every time. Only the answers are kept, never how deep `real` was, so what it returns is the same either way.
 */
function asked(question: "realpath" | "readlink" | "lstat", file: string, read: () => string) {
  if (!realMemo) return attempt(read)
  const key = `${question}\0${file}`
  if (realMemo.has(key)) return realMemo.get(key)
  const found = attempt(read)
  realMemo.set(key, found)
  return found
}

function attempt(read: () => string) {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** 1.1.1 F22 (n50): a word with a step back (`..` as a whole name) in it, the one spelling of that test. */
export const upward = (word: string) => /(^|\/)\.\.(\/|$)/.test(word)

/**
 * 1.1.1 F20 (P34, CR9-4): the one answer to "where does this path land". `word`, taken from the folder `base` (any
 * spelling; it is resolved first), is followed as the system resolves it: each link before the next `..`, so `link/..`
 * goes up from where the link leads. `realpath` itself takes `link/..` for the folder the link is in, so a word with a
 * step back is never handed to it whole. 1.1.1 F25 (n61): Bun's file writes do follow the link, so such a path must also
 * never reach a write whole (`fileTarget`). The parent of a real path is real, so a `..` asks nothing (n48). undefined: a
 * link loop. 1.1.1 F22 (G10-P1): the names between two steps back (or before the first, or after the last) hold no `..`,
 * so each such run is resolved with one whole-path `real`, which follows every link in it as a walk name by name would;
 * a word with no `..` is one run, asked once (G9-P1).
 */
export function physical(word: string, base: string): string | undefined {
  const start = word.startsWith("/") ? "/" : real(base)
  if (start === undefined) return undefined
  if (!upward(word)) return real(path.resolve(start, word))
  let at: string | undefined = start
  let run: string[] = []
  const settle = () => {
    if (at !== undefined && run.length > 0) at = real(path.join(at, ...run))
    run = []
  }
  for (const name of word.split("/")) {
    if (name === "" || name === ".") continue
    if (name !== "..") {
      run.push(name)
      continue
    }
    settle()
    if (at === undefined) return undefined
    at = path.dirname(at)
  }
  settle()
  return at
}

/**
 * 1.1.1 F25 (CR11-3): a file tool's path, taken from the project's folder. `written` is the tidied path the tool writes
 * (so no `link/..` is ever handed to the runtime, which would follow the link); `landing` is where the path as given
 * lands once each link before a `..` is followed (`physical`), the place the tool must also be allowed to reach. Without a
 * `..` the two are one. `landing` undefined: a link loop.
 */
export function fileTarget(given: string, directory: string): { written: string; landing: string | undefined } {
  const written = path.resolve(directory, given)
  if (!upward(given)) return { written, landing: written }
  const found = physical(given, directory)
  // 1.1.1 F30 (CR12-7): a landing under the project's real folder is spelled under the folder as given, so a project
  // opened through a link compares it with the root it was opened by, and the real root as well, before anything asks.
  const root = real(directory)
  const landing = found !== undefined && root !== undefined && root !== directory ? respell(found, [[root, directory]]) : found
  return { written, landing: landing === written || found === (real(written) ?? written) ? written : landing }
}

/**
 * 1.1.1 F22 (n51): `file` under one of `pairs`' first folders, spelled under the matching second one (the names below it
 * kept); anything else as it is. The first pair that holds the file wins. A folder of `/` holds nothing here.
 */
export function respell(file: string, pairs: readonly (readonly [string, string])[]) {
  const found = pairs.find(([from]) => within(file, from))
  return found ? path.join(found[1], path.relative(found[0], file)) : file
}

/** 1.1.1 F22 (n51): `file` is `root` or below it; `/` as a root holds nothing (a project without Git has worktree `/`). */
export const within = (file: string, root: string) => root !== "/" && FSUtil.contains(root, file)

/**
 * 1.1.1 F22 (G10-P3): whether `file` itself is a symbolic link (not followed). Inside a `snapshotScope` the file system is
 * asked once per path, as for `real`.
 */
export function isLink(file: string) {
  return (
    asked("lstat", file, () => {
      lstatCalls++
      return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true ? "link" : "other"
    }) === "link"
  )
}

/** 1.1.1 F25 (P40): at most this many entries are looked at below a formatter's folder (`linkBelow`). */
export const LINK_SCAN_CAP = 5000

/**
 * 1.1.1 F25 (P40): whether a folder holds a symbolic link anywhere below it (links are not followed). A formatter that
 * walks the folder itself may follow one out of it. A folder that cannot be read, or more than `cap` entries, answers
 * true, since a link may be there; anything that is not a folder (a file, nothing) answers false. 1.1.1 F26 (P43): the
 * folders `scanSkips` names for `tool` are not entered (the tool never writes there). Inside a `snapshotScope` (one
 * classify) each folder is walked once per tool.
 */
export function linkBelow(folder: string, cap = LINK_SCAN_CAP, tool?: string): boolean {
  const skip = scanSkips(tool)
  if (!realMemo) return walkForLink(folder, cap, skip)
  // Tools that skip only the common folders share one walk of a folder.
  const key = `linkBelow\0${cap}\0${tool !== undefined && Object.hasOwn(SCAN_SKIP, tool) ? tool : ""}\0${folder}`
  if (realMemo.has(key)) return realMemo.get(key) === "link"
  const found = walkForLink(folder, cap, skip)
  realMemo.set(key, found ? "link" : "none")
  return found
}

/**
 * 1.1.1 F26 (P43): folders below the start that the link scan does not enter, by name: the ones every scanned formatter
 * leaves alone (`node_modules`, `.venv`, `venv`, `.git`), and those the named tool skips by default. eslint (flat config)
 * ignores `node_modules` and `.git`; black's default exclude and ruff's default exclude name the Python ones below; `go fmt`
 * with a package pattern skips `vendor`, `testdata` and folders starting with `.` or `_`; `cargo fmt` follows the module
 * tree and never walks `target`. A link entry itself (one named so included) still counts as a link.
 */
const SCAN_SKIP_ALL = ["node_modules", ".venv", "venv", ".git"]
const SCAN_SKIP: Readonly<Record<string, readonly string[]>> = {
  black: [".direnv", ".eggs", ".hg", ".ipynb_checkpoints", ".mypy_cache", ".nox", ".pytest_cache", ".ruff_cache", ".tox", ".svn", ".vscode", "__pypackages__", "_build", "buck-out", "build", "dist"],
  ruff: [".bzr", ".direnv", ".eggs", ".git-rewrite", ".hg", ".ipynb_checkpoints", ".mypy_cache", ".nox", ".pants.d", ".pyenv", ".pytest_cache", ".pytype", ".ruff_cache", ".svn", ".tox", ".vscode", "__pypackages__", "_build", "buck-out", "build", "dist", "site-packages"],
  cargo: ["target"],
  go: ["vendor", "testdata"],
}
function scanSkips(tool: string | undefined): (name: string) => boolean {
  const names = new Set([...SCAN_SKIP_ALL, ...((tool !== undefined && Object.hasOwn(SCAN_SKIP, tool) ? SCAN_SKIP[tool] : undefined) ?? [])])
  if (tool === "go") return (name) => names.has(name) || name.startsWith(".") || name.startsWith("_")
  return (name) => names.has(name)
}

function walkForLink(folder: string, cap: number, skip: (name: string) => boolean): boolean {
  const start = attempt(() => (fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() ? "dir" : "other"))
  if (start === undefined) return true
  if (start !== "dir") return false
  let seen = 0
  const queue = [folder]
  while (queue.length > 0) {
    const dir = queue.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return true
    }
    linkScanCalls += entries.length
    for (const entry of entries) {
      if (++seen > cap || entry.isSymbolicLink()) return true
      if (entry.isDirectory() && !skip(entry.name)) queue.push(path.join(dir, entry.name))
    }
  }
  return false
}

/** The project's folders by their real paths (a worktree of `/`, no repository, stays `/`). */
export function realRoots(instance: InstanceContext) {
  return {
    ...instance,
    directory: real(instance.directory) ?? instance.directory,
    worktree: instance.worktree === "/" ? "/" : (real(instance.worktree) ?? instance.worktree),
  }
}

/** Inside the project once every symlink on the way has been followed. */
export function inside(file: string, instance: InstanceContext) {
  const target = real(file)
  return target !== undefined && containsPath(target, realRoots(instance))
}

/** A symlink named `notes` that points at `.git/config` changes the same thing, so both names are checked. */
export function sensitive(file: string, instance: InstanceContext) {
  const target = real(file)
  if (target === undefined) return true
  return (
    Risk.sensitive(path.relative(instance.worktree, file)) ||
    Risk.sensitive(path.relative(realRoots(instance).worktree, target))
  )
}

/**
 * 1.1.1 F12b (S4-2): for the consent overlay only. What `sensitive` names, and also a tool's configuration that decides
 * where the tool writes or what it runs (`Risk.toolConfig`). Without consent these stay as 1.1.0 judged them.
 */
export function consentSensitive(file: string, instance: InstanceContext) {
  const target = real(file)
  if (target === undefined || sensitive(file, instance)) return true
  return (
    Risk.toolConfig(path.relative(instance.worktree, file)) ||
    Risk.toolConfig(path.relative(realRoots(instance).worktree, target))
  )
}

export function secret(file: string) {
  const target = real(file)
  return target === undefined || Secrets.secretFile(file) || Secrets.secretFile(target)
}

/** Whether the step's snapshot would leave anything under these paths behind, so Undo could not bring it back. */
export async function outsideSnapshot(worktree: string, paths: string[], options?: { untrackedOnly?: boolean }) {
  // 1.1.0 had no timeout here: the edit and shell tools wait on it, and a timeout would only make a 1.1.0 answer stricter.
  const run = async (args: string[]) => {
    gitCalls++
    // 1.1.1 F41 (G17-P2): git in the C locale, as `gitSync` runs it; the answer is read from paths and exit status only.
    return (await git("git", [...QUIET, "-C", worktree, ...args], { maxBuffer: GIT_BUFFER, env: gitEnv() })).stdout
  }
  const ask = async (question: Question): Promise<Answer> => {
    if (question.ask === "sizes")
      return Promise.all(
        question.files.map((file) =>
          stat(path.join(worktree, file)).then(
            (info) => info.size,
            (error: { code?: string }) => (error.code === "ENOENT" ? 0 : Infinity),
          ),
        ),
      )
    return run(gitArgs(question, paths)).then(
      (out) => split(question, out),
      (error: { code?: number }) => {
        if (question.ask === "check-ignore" && error.code === 1) return [] as string[]
        throw error
      },
    )
  }
  try {
    const decision = snapshotDecision(worktree, options?.untrackedOnly === true)
    for (let step = decision.next(); ; ) {
      if (step.done) return step.value
      step = decision.next(await ask(step.value))
    }
  } catch {
    return true
  }
}

/**
 * 1.1.1 F10a (G3-3): `outsideSnapshot`, read synchronously for the permission table, which is pure and sync. 1.1.1 F12b
 * (m31): both run the one decision below, `snapshotDecision`; only how a question is asked differs. (m30) Every git call
 * stops after `SYNC_GIT_TIMEOUT` ms, which throws, and anything that cannot be asked (no Git, an error, a timeout) counts as
 * outside, so the call keeps its 1.1.0 verdict. (Perf P2) Inside `deferSnapshot` the paths are only collected and answered
 * in one batch at the end; inside `snapshotScope` an answer is reused while HEAD and the index stay the same.
 */
export function outsideSnapshotSync(worktree: string, paths: string[]) {
  if (paths.length === 0) return false
  const deferred = pending.at(-1)
  if (deferred) {
    paths.forEach((file) => deferred.add(`${worktree}\0${file}`))
    return false
  }
  const cache = scope && snapshotKey(worktree)
  const known = cache ? scope!.get(cache) : undefined
  if (known && paths.some((file) => known.outside.has(file))) return true
  const open = known ? [...new Set(paths)].filter((file) => !known.inside.has(file)) : [...new Set(paths)]
  if (open.length === 0) return false
  const outside = askSync(worktree, open)
  if (cache) {
    const entry = known ?? { inside: new Set<string>(), outside: new Set<string>() }
    // "Any outside" is all a batch says, so only an all-clear can be kept per path; a single outside path is kept as itself.
    if (!outside) open.forEach((file) => entry.inside.add(file))
    if (outside && open.length === 1) entry.outside.add(open[0]!)
    scope!.set(cache, entry)
  }
  return outside
}

function askSync(worktree: string, paths: string[]) {
  const ask = (question: Question): Answer => {
    if (question.ask === "sizes")
      return question.files.map((file) => {
        try {
          return fs.statSync(path.join(worktree, file), { throwIfNoEntry: false })?.size ?? 0
        } catch {
          return Infinity
        }
      })
    gitCalls++
    try {
      return split(
        question,
        execFileSync("git", [...QUIET, "-C", worktree, ...gitArgs(question, paths)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: GIT_BUFFER,
          // Bun reads PATH as it was at start unless it is passed; Node reads it now. Passing it gives both Node's answer.
          // 1.1.1 F41 (G17-P2): `gitEnv` is that environment with git in the C locale.
          env: gitEnv(),
          timeout: SYNC_GIT_TIMEOUT,
          killSignal: "SIGKILL",
        }),
      )
    } catch (error) {
      // check-ignore exits 1 when nothing is ignored. A timeout has no exit status, so it is not mistaken for that.
      if (question.ask === "check-ignore" && (error as { status?: number | null }).status === 1) return [] as string[]
      throw error
    }
  }
  try {
    const decision = snapshotDecision(worktree, false)
    for (let step = decision.next(); ; ) {
      if (step.done) return step.value
      step = decision.next(ask(step.value))
    }
  } catch {
    return true
  }
}

/**
 * 1.1.1 F12b (Perf P2): answer every `outsideSnapshotSync` asked while `run` runs in one batch afterwards. Inside, each such
 * call says "inside" and only records its paths; `outside` is then whether any recorded path is outside the snapshot, or
 * is a tool's configuration (`consentSensitive`, S4-2). A caller that lets `value` through must also see `outside` false.
 * This is safe whatever `run` does with an answer: every path it was told is inside is checked before the call opens.
 */
// 1.1.1 F14 (G5-P2): `needed` says whether the answer can still matter. When it says no (the call is not going to be
// opened), the batch is skipped and `outside` is false: a caller that lets `value` through only when `needed(value)` holds
// never sees an unchecked "inside".
export function deferSnapshot<T>(run: () => T, needed: (value: T) => boolean = () => true): { value: T; outside: boolean } {
  const asked = new Set<string>()
  pending.push(asked)
  const value = (() => {
    try {
      return run()
    } finally {
      pending.pop()
    }
  })()
  if (asked.size === 0 || !needed(value)) return { value, outside: false }
  const byTree = new Map<string, string[]>()
  for (const entry of asked) {
    const [worktree, file] = entry.split("\0") as [string, string]
    // 1.1.1 F14 (n25): push in place; copying the list per path was quadratic in the targets of one call.
    const files = byTree.get(worktree)
    if (files) files.push(file)
    else byTree.set(worktree, [file])
  }
  const outside = [...byTree].some(
    ([worktree, files]) =>
      files.some((file) => Risk.toolConfig(path.relative(worktree, file))) || outsideSnapshotSync(worktree, files),
  )
  return { value, outside }
}

/**
 * 1.1.1 F12b (Perf P2): one classify. Answers of `outsideSnapshotSync` are kept for as long as `run` runs, keyed by the
 * worktree, the commit HEAD names and the index's change time, so steps and scripts that write the same file ask once.
 * Nested scopes share the outer one.
 */
export function snapshotScope<T>(run: () => T): T {
  if (scope) return run()
  scope = new Map()
  realMemo = new Map()
  classifyAnswers = new Map()
  try {
    return run()
  } finally {
    scope = undefined
    realMemo = undefined
    classifyAnswers = undefined
  }
}

/**
 * 1.1.1 F29 (P44): `work`'s answer for `key`, kept for the rest of the classify when one is running (`snapshotScope`),
 * so two walks of one classify (the allowlist's and the destinations') read a manifest once. Outside a classify, worked
 * out each time.
 */
export function classifyMemo<T>(key: string, work: () => T): T {
  if (!classifyAnswers) return work()
  if (classifyAnswers.has(key)) return classifyAnswers.get(key) as T
  const found = work()
  classifyAnswers.set(key, found)
  return found
}

/**
 * 1.1.1 F40 (CR16-2, V16-1, n90, P56): the one reader of a sync git call whose failure is told apart by its message.
 * git runs in the C locale (`LC_ALL`, `LANG`; `LANGUAGE` dropped), so the message is git's own English text whatever
 * language the computer is set to. `missing`: git is not installed; `outside`: the folder is in no repository; `failed`:
 * anything else (a timeout, a broken index, a bad `GIT_DIR`), which a caller holds on.
 */
export type GitRun = { ok: true; stdout: string } | { ok: false; reason: "missing" | "outside" | "failed" }
export function gitSync(args: readonly string[]): GitRun {
  gitCalls++
  try {
    const stdout = execFileSync("git", [...QUIET, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_BUFFER,
      env: gitEnv(),
      timeout: SYNC_GIT_TIMEOUT,
      killSignal: "SIGKILL",
    })
    return { ok: true, stdout }
  } catch (error) {
    const failed = error as { code?: string; status?: number | null; stderr?: unknown }
    if (failed.code === "ENOENT") return { ok: false, reason: "missing" }
    if (failed.status === 128 && /not a git repository/i.test(String(failed.stderr ?? ""))) return { ok: false, reason: "outside" }
    return { ok: false, reason: "failed" }
  }
}
/** The server's environment with git's messages in English (`gitSync`). */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", LANG: "C" }
  delete env.LANGUAGE
  return env
}

/**
 * 1.1.1 F39 (CR15-2, P54): the links git tracks under `folder` (index mode `120000`), as paths from `folder`, from one
 * `git ls-files -s` asked once per classify (`classifyMemo`). `[]` when git is not installed or `folder` is in no
 * repository; null when git fails otherwise (a caller holds then). 1.1.1 F40 (CR16-1): submodules' tracked links too
 * (`--recurse-submodules`; a publish packs a submodule's files), and git's failure read by `gitSync`.
 */
export function trackedLinks(folder: string): string[] | null {
  return classifyMemo(`trackedLinks\0${folder}`, () => {
    const found = gitSync(["-C", folder, "ls-files", "-s", "-z", "--recurse-submodules", "--", "."])
    if (!found.ok) return found.reason === "failed" ? null : []
    return found.stdout.split("\0").flatMap((line) => /^120000 [0-9a-f]+ \d+\t([\s\S]+)$/.exec(line)?.slice(1) ?? [])
  })
}

/** For tests: how many git processes the snapshot checks have started. */
export const snapshotGitCalls = () => gitCalls
/** For tests (1.1.1 F17, G7-P1): how many times `real` has asked the file system for a path's real path. */
export const realpathLookups = () => realpathCalls
/** For tests (1.1.1 F22, G10-P3): how many times `isLink` has asked the file system. */
export const lstatLookups = () => lstatCalls
/** For tests (1.1.1 F25): how many folder entries `linkBelow` has looked at. */
export const linkScanEntries = () => linkScanCalls

type Question = { ask: "ignored" | "check-ignore" | "untracked" } | { ask: "sizes"; files: string[] }
type Answer = string[] | number[]

/**
 * The three questions, in order: an ignored file or folder that is not rebuilt, an untracked nested repository, an untracked
 * file over the size the snapshot takes. Each `yield` is one question; the answer comes back as its value.
 */
function* snapshotDecision(worktree: string, untrackedOnly: boolean): Generator<Question, boolean, Answer> {
  if (!untrackedOnly) {
    if (((yield { ask: "ignored" }) as string[]).some((file) => !Risk.rebuilt(file))) return true
    // ls-files only lists what exists. A new file in an ignored place is just as far out of Undo's reach.
    const ignored = (yield { ask: "check-ignore" }) as string[]
    if (ignored.some((file) => !Risk.rebuilt(path.relative(worktree, path.resolve(worktree, file))))) return true
  }
  const untracked = (yield { ask: "untracked" }) as string[]
  // Listed with a trailing slash, an untracked directory is a repository of its own. Its history is not in the snapshot.
  if (untracked.some((file) => file.endsWith("/"))) return true
  return ((yield { ask: "sizes", files: untracked }) as number[]).some((size) => size > SNAPSHOT_FILE_LIMIT)
}

function gitArgs(question: Question, paths: string[]) {
  if (question.ask === "check-ignore") return ["check-ignore", "--", ...paths]
  const extra = question.ask === "ignored" ? ["--ignored", "--directory"] : []
  return ["ls-files", "-z", "--others", "--exclude-standard", ...extra, "--", ...paths]
}

const split = (question: Question, out: string) => out.split(question.ask === "check-ignore" ? "\n" : "\0").filter(Boolean)

/** HEAD's commit (or the ref it names) and the index's change time, read from disk; undefined when they cannot be read. */
function snapshotKey(worktree: string) {
  try {
    const dotGit = path.join(worktree, ".git")
    const info = fs.statSync(dotGit)
    const gitDir = info.isDirectory()
      ? dotGit
      : path.resolve(worktree, fs.readFileSync(dotGit, "utf8").replace(/^gitdir:\s*/, "").trim())
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim()
    const ref = head.startsWith("ref: ") ? fs.statSync(path.join(gitDir, head.slice(5)), { throwIfNoEntry: false }) : undefined
    const index = fs.statSync(path.join(gitDir, "index"), { throwIfNoEntry: false })
    return [worktree, head, ref?.mtimeMs ?? "", index?.mtimeMs ?? "", index?.size ?? ""].join("\0")
  } catch {
    return undefined
  }
}

// 1.1.1 F12b (m30): the permission table runs on the server's event loop, so a stuck git must not hold it.
const SYNC_GIT_TIMEOUT = 1500
const GIT_BUFFER = 64 * 1024 * 1024
let gitCalls = 0
let realpathCalls = 0
let lstatCalls = 0
let linkScanCalls = 0
// 1.1.1 F17 (G7-P1): `real`'s answers for as long as a `snapshotScope` runs (one synchronous classify).
let realMemo: Map<string, string | undefined> | undefined
// 1.1.1 F29 (P44): other answers kept for one classify (`classifyMemo`), cleared with the scope.
let classifyAnswers: Map<string, unknown> | undefined
let scope: Map<string, { inside: Set<string>; outside: Set<string> }> | undefined
const pending: Set<string>[] = []

/** Ordinary by both of its names (see `ordinary`), for the permission table. */
export const ordinaryFile = (file: string, instance: InstanceContext) => ordinary(file, instance)

// Directories whose contents can hold a credential under any name. `.git/config` carries remote URLs with their tokens.
const HOLDS_SECRETS = /(^|\/)(\.git|\.envs|\.ssh|\.aws|\.gnupg|\.kube|\.docker)(\/|$)/i

/** Whether what is in this file may reach the model through a read tool with nobody asked. */
export function readable(file: string) {
  const target = real(file)
  return target !== undefined && !secret(file) && !HOLDS_SECRETS.test(file) && !HOLDS_SECRETS.test(target)
}

/** The same judgement for a name in a repository, which may not be on disk any more. */
export const readableName = (name: string) => !Secrets.secretFile(name) && !HOLDS_SECRETS.test(name)

/**
 * The rule an "Allow always" may leave behind for this command, or undefined when there is none to offer and none that
 * could answer it: only one plain command, naming nothing outside the project and no secret, whatever comes after it.
 */
export function alwaysFor(command: string, cwd: string, instance: InstanceContext) {
  const words = Risk.plainWords(command)
  if (!words || !inside(cwd, instance)) return undefined
  const named = words.slice(1).flatMap((word) => word.replace(/^-[A-Za-z]/, "").split(/[=,:@]/)).filter(Boolean)
  const stays = named.every((word) => {
    if (word.startsWith("-")) return true
    const file = path.resolve(cwd, word)
    return !word.startsWith("/") && !word.includes("..") && inside(file, instance) && readable(file)
  })
  return stays ? Risk.scope(command) : undefined
}

/** The names a change reaches, as this worktree spells them: through a link it lands somewhere else in the project. */
export function landsOn(files: string[], instance: InstanceContext) {
  const root = realRoots(instance).worktree
  return [
    ...new Set(
      files.flatMap((file) => {
        const target = real(file)
        return target && containsPath(target, realRoots(instance))
          ? [file, path.join(instance.worktree, path.relative(root, target))]
          : [file]
      }),
    ),
  ]
}

/** Ordinary by both of its names, and not somewhere a global config loads from, even when that is the open project. */
function ordinary(file: string, instance: InstanceContext) {
  const target = real(file)
  const loaded = [Global.Path.config, process.env.OPENCODE_CONFIG_DIR, process.env.SWARM_CONFIG_DIR].filter((dir) => dir !== undefined)
  if (target === undefined || loaded.some((dir) => !path.relative(real(dir) ?? dir, target).startsWith(".."))) return false
  return (
    Risk.ordinaryEdit(path.relative(instance.worktree, file)) &&
    Risk.ordinaryEdit(path.relative(realRoots(instance).worktree, target))
  )
}

/**
 * 1.2.8 row 40e (SK-e, N8-411, SR8-10): the folders `Skill.Service.folders()` (N8-410) last named for an instance, so the
 * autonomy table, which cannot ask a service, judges a shell write against the same list the edit tools do. Keyed by the
 * instance's folder; the newest answer replaces the one before.
 */
const skillFolderMemo = new Map<string, readonly string[]>()

export function rememberSkillFolders(instance: InstanceContext, folders: readonly string[]) {
  skillFolderMemo.set(instance.directory, [...folders])
}

/** For tests: forget every folder list `rememberSkillFolders` kept. */
export function forgetSkillFolders() {
  skillFolderMemo.clear()
}

/**
 * The skill-folder roots that hold without the Skill service (01b §7.1): the config `{skill,skills}` folders, the home and
 * project `.agents/skills`, the project `.swarm/{skill,skills}` and both `skill-drafts` roots. The service's own list
 * (`rememberSkillFolders`) adds every discovered skill folder and `.claude/skills` when claude_compat is on.
 */
function fixedSkillRoots(instance: InstanceContext) {
  const configs = [Global.Path.config, process.env.OPENCODE_CONFIG_DIR, process.env.SWARM_CONFIG_DIR].filter(
    (dir): dir is string => dir !== undefined && dir !== "",
  )
  const bases = [...new Set([instance.directory, instance.worktree])].filter((dir) => path.dirname(dir) !== dir)
  return [
    ...configs.flatMap((dir) => [path.join(dir, "skill"), path.join(dir, "skills")]),
    ...homes().map((home) => path.join(home, ".agents", "skills")),
    path.join(Global.Path.data, "skill-drafts"),
    ...bases.flatMap((base) => [
      path.join(base, ".swarm", "skill"),
      path.join(base, ".swarm", "skills"),
      path.join(base, ".swarm", "skill-drafts"),
      path.join(base, ".agents", "skills"),
    ]),
  ]
}

// The home Swarm names (`Global.Path.home`) and the one the shell expands `~` to; the same folder outside tests.
const homes = () => [...new Set([Global.Path.home, os.homedir()])]

const under = (root: string, file: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/**
 * 1.2.8 row 40e (SK-e, SR8-10): a write here would land in a skill folder: under a root of `fixedSkillRoots` or of the
 * Skill service's list, by the name as given or where it really lands, or on a file named `SKILL.md` (any case). A
 * discovered folder that is a worktree or project root, the home folder or `/` is not a root (a SKILL.md at the project
 * root does not make `src/x.ts` a skill file). A path that cannot be worked out (a link loop) is judged by the name as
 * given only; the rules after this one already hold such a write.
 */
export function skillFolder(file: string, instance: InstanceContext) {
  const given = path.resolve(instance.directory, file)
  const target = real(given) ?? given
  if ([given, target].some((name) => path.basename(name).toLowerCase() === "skill.md")) return true
  const broad = new Set(
    [instance.directory, instance.worktree, ...homes(), "/"].flatMap((dir) => [path.resolve(dir), real(dir) ?? path.resolve(dir)]),
  )
  const roots = [...fixedSkillRoots(instance), ...(skillFolderMemo.get(instance.directory) ?? [])]
    .map((dir) => path.resolve(dir))
    .flatMap((dir) => [dir, real(dir) ?? dir])
    .filter((dir) => !broad.has(dir))
  return roots.some((root) => under(root, given) || under(root, target))
}

/**
 * 1.2.8 row 40e (SK-e, S14-D2): an edit tool's write into a skill folder. It is refused before anything is asked, with
 * autonomous mode on or off and whatever "always" rule a person gave for edits: a skill is saved only from Settings >
 * Skills, where the validator, the memory note and the record run. `editClass` names the class (N8-411).
 */
export class SkillFolderRefused extends Error {
  readonly editClass = "skill_folder" as const
  constructor() {
    super(SKILL_FOLDER_HELD_TEXT)
    this.name = "SkillFolderRefused"
  }
}

/**
 * 1.2.8 row 40f (AC-SEC11, SR8-11, N8-441): the vault mirror folders a write must not reach: `Vault.mirrorDir()` as
 * spelled, and `swarm-memory` under the real vault root (a symlinked root or SWARM_VAULT_DIR resolved first). Without
 * SWARM_VAULT_DIR, also `~/.swarm/vault/swarm-memory` under the home the shell expands `~` to (the same folder outside
 * tests). Independent of the `.swarm` segment rule (`risk.ts`).
 */
function vaultMirrorRoots() {
  const roots = [Vault.mirrorDir()]
  const root = real(Vault.root())
  if (root) roots.push(path.join(root, Vault.VAULT_MIRROR_DIR))
  if (!process.env.SWARM_VAULT_DIR?.trim())
    for (const home of homes()) roots.push(path.join(home, Vault.VAULT_DEFAULT_DIR, Vault.VAULT_MIRROR_DIR))
  return [...new Set(roots.flatMap((dir) => [path.resolve(dir), real(dir) ?? path.resolve(dir)]))]
}

// File names on macOS and Windows ignore case by default, so `Swarm-Memory` is the same folder there.
const foldCase = process.platform === "darwin" || process.platform === "win32"
const fold = (name: string) => (foldCase ? name.toLowerCase() : name)

/**
 * 1.2.8 row 40f (AC-SEC11, SR8-11): a write here would land in the vault mirror folder `<vault>/swarm-memory/**` (or
 * replace that folder itself), by the name as given or where it really lands. The rest of the vault (`inbox/`, the
 * person's own notes) is not covered. The mirror writer (`memory/vault-mirror.ts`) writes with fs directly, not through
 * this check.
 */
export function vaultMirror(file: string, instance: InstanceContext) {
  const given = path.resolve(instance.directory, file)
  const target = real(given) ?? given
  return vaultMirrorRoots().some((root) => [given, target].some((name) => under(fold(root), fold(name))))
}

/**
 * 1.2.8 row 40f (AC-SEC11, SR8-11, N8-441): an edit tool's write into the vault mirror folder. Refused before anything is
 * asked, with autonomous mode on or off and whatever "always" rule a person gave: the folder is generated by Swarm from
 * project memory, and the next mirror run would overwrite or delete the change. `editClass` names the class.
 */
export class VaultMirrorRefused extends Error {
  readonly editClass = "vault_mirror" as const
  constructor() {
    super(VAULT_MIRROR_REFUSED_TEXT)
    this.name = "VaultMirrorRefused"
  }
}

/** What to tell the permission layer about an edit to these files. */
export const editTrust = Effect.fn("Reach.editTrust")(function* (
  ctx: { trust?: { canUndo: boolean } },
  instance: InstanceContext,
  files: string[],
) {
  // 1.2.8 row 40e (SK-e): first, so neither a missing Undo nor a place outside the project lets it reach a prompt.
  // Loaded when first asked: the skill module reaches the permission service, which loads the table, which loads this.
  const { Skill } = yield* Effect.promise(() => import("../skill"))
  const skills = Option.getOrUndefined(yield* Effect.serviceOption(Skill.Service))
  if (skills) {
    const folders = yield* skills.folders().pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (folders) rememberSkillFolders(instance, folders)
  }
  if (files.some((file) => skillFolder(file, instance))) throw new SkillFolderRefused()
  // 1.2.8 row 40f (AC-SEC11): the vault mirror folder, refused before Undo, outside or sensitive checks can ask.
  if (files.some((file) => vaultMirror(file, instance))) throw new VaultMirrorRefused()
  if (!ctx.trust?.canUndo) return { harmless: false, editClass: "no_undo" as const }
  if (files.some((file) => !inside(file, instance)))
    return { harmless: false, risk: "irreversible" as const, editClass: "no_undo" as const }
  if (files.some((file) => secret(file))) return { harmless: false, editClass: "secret" as const }
  if (files.some((file) => sensitive(file, instance))) return { harmless: false, editClass: "sensitive" as const }
  if (yield* Effect.promise(() => outsideSnapshot(instance.worktree, landsOn(files, instance))))
    return { harmless: false, risk: "irreversible" as const, editClass: "no_undo" as const }
  const harmless = files.every((file) => ordinary(file, instance))
  return { harmless, editClass: harmless ? ("ordinary" as const) : ("not_ordinary" as const) }
})

export * as Reach from "./reach"
