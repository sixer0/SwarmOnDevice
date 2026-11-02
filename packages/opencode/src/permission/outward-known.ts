// Where autonomous mode may send work off this machine (U11 rule 3, U13). A destination counts only when the person named
// it in the mission messages and it was already known before the mode came on: a git remote of the project or a repo
// nested in it, pushed with an account `gh` was logged in to, an rclone remote, or a mounted drive. This file takes that
// picture once, matches it against the person's words, and checks a remote again right before it is used, so a remote
// added or changed afterwards never matches.
//
// No secret is read or kept. URLs lose their user part before they are stored, `gh auth status` runs without
// `--show-token` and only the host and login lines are kept, and rclone is asked for remote names only. Running a remote
// is decided elsewhere (the autonomy table); this only says what is known and what was named.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Process } from "@/util/process"

// One command that hangs (a credential helper, a slow network check in `gh`) must not hold the mode up.
const RUN_MS = 5_000
// Nested repos are looked for this deep below the project, and in no more folders than this.
const NESTED_DEPTH = 4
const NESTED_MAX_DIRS = 2_000
const SKIP_DIRS = new Set(["node_modules", ".git", ".swarm", "dist", "build", "target", ".venv", "vendor"])
// A bare word is taken for a host only with one of these endings, so `file.ts` or `a.b` in a message are not hosts.
const TLDS = new Set([
  "com",
  "org",
  "net",
  "io",
  "dev",
  "ai",
  "app",
  "id",
  "co",
  "me",
  "cloud",
  "sh",
  "xyz",
  "info",
  "edu",
  "gov",
])

export type Run = (cmd: string[], cwd?: string) => Promise<{ code: number; text: string } | undefined>

export interface Remote {
  name: string
  /** Push URLs as git resolves them (`insteadOf` applied), without any user part. */
  push: string[]
}

export interface Repo {
  /** Real path of the repository's top folder. */
  dir: string
  remotes: Remote[]
}

export interface Account {
  host: string
  login: string
}

export interface Snapshot {
  at: number
  repos: Repo[]
  /** Active `gh` accounts, one per host. */
  accounts: Account[]
  rclone: string[]
  /** Mounted drives, as absolute paths. */
  drives: string[]
}

export type Destination =
  | { kind: "git"; repo: string; remote: string; url: string; host: string; path: string }
  | { kind: "host"; host: string }
  | { kind: "ssh"; user: string; host: string }
  | { kind: "rclone"; name: string }
  | { kind: "drive"; path: string }

export type Recheck =
  | { ok: true; remote: Remote; account: Account }
  /** `repo`: not a repo of the snapshot. `remote_new`: the remote was not there before. `url_changed`: it now points
   * elsewhere. `no_credential`: no `gh` account for its host then. `account_changed`: another account is active now. */
  | { ok: false; reason: "repo" | "remote_new" | "url_changed" | "no_credential" | "account_changed" }

export const defaultRun: Run = async (cmd, cwd) => {
  try {
    const result = await Process.run(cmd, {
      cwd,
      nothrow: true,
      abort: AbortSignal.timeout(RUN_MS),
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        RCLONE_ASK_PASSWORD: "false",
      },
    })
    return { code: result.code, text: result.stdout.toString() + "\n" + result.stderr.toString() }
  } catch {
    // Not installed, or killed at the time limit: nothing is known from it.
    return undefined
  }
}

/** A URL without its user part, or the scp form unchanged (it cannot carry a password). */
export function stripUser(url: string) {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*@)?(.*)$/i.exec(url.trim())
  if (!match) return url.trim()
  return match[1] + match[3]
}

/** Host and `owner/repo` path of a git URL, lower case, or undefined for a local path. */
export function parse(url: string): { host: string; path: string } | undefined {
  const value = url.trim()
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value)
  if (scp && !/^[a-z]:$/i.test(scp[1] + ":")) return { host: scp[1].toLowerCase(), path: clean(scp[2]) }
  try {
    const parsed = new URL(value)
    if (!parsed.hostname || parsed.protocol === "file:") return
    return { host: parsed.hostname.toLowerCase(), path: clean(decodeURIComponent(parsed.pathname)) }
  } catch {
    return
  }
}

function clean(value: string) {
  return value
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase()
}

function same(a: string, b: string) {
  const x = parse(a)
  const y = parse(b)
  if (x && y) return x.host === y.host && x.path === y.path
  return stripUser(a) === stripUser(b)
}

async function real(dir: string) {
  return fs.realpath(dir).catch(() => path.resolve(dir))
}

async function remotes(dir: string, exec: Run): Promise<Remote[]> {
  const names = await exec(["git", "-C", dir, "remote"])
  if (!names || names.code !== 0) return []
  const result: Remote[] = []
  for (const name of names.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    const urls = await exec(["git", "-C", dir, "remote", "get-url", "--push", "--all", name])
    if (!urls || urls.code !== 0) continue
    result.push({
      name,
      push: urls.text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map(stripUser),
    })
  }
  return result
}

/** Top folders of the project's repo and of the repos nested in the project. */
async function repoDirs(dir: string, exec: Run) {
  const found = new Set<string>()
  const top = await exec(["git", "-C", dir, "rev-parse", "--show-toplevel"])
  if (top && top.code === 0 && top.text.trim()) found.add(await real(top.text.split("\n")[0].trim()))
  let seen = 0
  const walk = async (current: string, depth: number) => {
    if (depth > NESTED_DEPTH || seen >= NESTED_MAX_DIRS) return
    seen++
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    // A `.git` folder or file (worktree, submodule) marks a repo; links are not followed.
    if (depth > 0 && entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile())))
      found.add(await real(current))
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      await walk(path.join(current, entry.name), depth + 1)
    }
  }
  await walk(await real(dir), 0)
  return [...found]
}

/** Logged-in `gh` accounts that are active, from `gh auth status` without the token. Only host and login lines are read. */
export function accountsFrom(text: string): Account[] {
  const seen: (Account & { active?: boolean })[] = []
  let current: (Account & { active?: boolean }) | undefined
  for (const line of text.split("\n")) {
    const login = /Logged in to (\S+) (?:account|as) (\S+)/.exec(line)
    if (login) {
      current = { host: login[1].toLowerCase(), login: login[2] }
      seen.push(current)
      continue
    }
    // A failed login starts a block of its own, whose lines say nothing about the one before.
    if (/Failed to log in/.test(line)) current = undefined
    const active = /Active account:\s*(true|false)/.exec(line)
    if (active && current) current.active = active[1] === "true"
  }
  const result: Account[] = []
  for (const host of new Set(seen.map((item) => item.host))) {
    const items = seen.filter((item) => item.host === host)
    // Older `gh` prints one account per host and no active line.
    const pick = items.some((item) => item.active !== undefined) ? items.find((item) => item.active) : items[0]
    if (pick) result.push({ host, login: pick.login })
  }
  return result
}

async function accounts(exec: Run) {
  const status = await exec(["gh", "auth", "status"])
  if (!status) return []
  return accountsFrom(status.text)
}

async function rclone(exec: Run) {
  const list = await exec(["rclone", "listremotes"])
  if (!list || list.code !== 0) return []
  return list.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[\w.@ -]+:$/.test(line))
    .map((line) => line.slice(0, -1))
}

async function drives(home: string, roots?: string[]) {
  const user = os.userInfo().username
  const places = roots ?? [
    "/Volumes",
    path.join(home, "Library", "CloudStorage"),
    path.join("/media", user),
    path.join("/run/media", user),
  ]
  const result: string[] = []
  for (const place of places) {
    const entries = await fs.readdir(place, { withFileTypes: true }).catch(() => [])
    // `/Volumes/Macintosh HD` is a link to `/`: links are not drives.
    for (const entry of entries)
      if (entry.isDirectory() && !entry.name.startsWith(".")) result.push(path.join(place, entry.name))
  }
  return result
}

/** What is known right now. Taken once, when the consent list is made, before anything the agent does can change it. */
export async function snapshot(input: {
  dir: string
  home?: string
  run?: Run
  driveRoots?: string[]
}): Promise<Snapshot> {
  const exec = input.run ?? defaultRun
  const dirs = await repoDirs(input.dir, exec)
  const repos: Repo[] = []
  for (const dir of dirs) repos.push({ dir, remotes: await remotes(dir, exec) })
  return {
    at: Date.now(),
    repos,
    accounts: await accounts(exec),
    rclone: await rclone(exec),
    drives: await drives(input.home ?? os.homedir(), input.driveRoots),
  }
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function word(text: string, value: string) {
  return new RegExp(`(?<![\\w./-])${escape(value)}(?![\\w/-])`, "i").test(text)
}

/** Hosts and `user@host` the person wrote: from URLs, and bare names with a common ending. */
export function hostsIn(text: string) {
  const hosts = new Set<string>()
  const ssh: { user: string; host: string }[] = []
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`)]+/gi)) {
    const parsed = parse(match[0])
    if (parsed) hosts.add(parsed.host)
  }
  for (const match of text.matchAll(/(?<![\w.@/-])([\w.-]+)@((?:[a-z0-9-]+\.)*[a-z0-9-]+)(?![\w-])/gi)) {
    // An email address is not a machine to log in to unless the person said so with ssh, scp or rsync.
    if (/\b(ssh|scp|rsync|sftp)\b/i.test(text)) ssh.push({ user: match[1], host: match[2].toLowerCase() })
  }
  for (const match of text.matchAll(/(?<![\w@/.-])((?:[a-z0-9-]+\.)+([a-z]{2,}))(?![\w-])/gi)) {
    if (TLDS.has(match[2].toLowerCase())) hosts.add(match[1].toLowerCase())
  }
  return { hosts: [...hosts], ssh }
}

/** Known destinations the person named, and hosts they named for fetches. Repo text is never passed here, only theirs. */
export function named(snap: Snapshot, text: string): Destination[] {
  const result: Destination[] = []
  for (const repo of snap.repos) {
    for (const remote of repo.remotes) {
      for (const url of remote.push) {
        const parsed = parse(url)
        if (!parsed) continue
        const hit =
          word(text, remote.name) ||
          (parsed.path.includes("/") && word(text, parsed.path)) ||
          new RegExp(escape(`${parsed.host}/${parsed.path}`), "i").test(text) ||
          text.includes(url)
        if (hit) result.push({ kind: "git", repo: repo.dir, remote: remote.name, url, ...parsed })
      }
    }
  }
  // An rclone remote is named as `name:` or right after `rclone`, so a common word such as "nas" alone is not it.
  for (const name of snap.rclone)
    if (text.includes(`${name}:`) || new RegExp(`\\brclone\\s+(?:\\w+\\s+)?${escape(name)}\\b`, "i").test(text))
      result.push({ kind: "rclone", name })
  for (const drive of snap.drives) {
    const base = path.basename(drive)
    // `GoogleDrive-name@example.com` is named as "Google Drive"; a volume by its name.
    const provider = base.split("-")[0]
    const loose = text.toLowerCase().replace(/\s+/g, "")
    if (
      text.includes(drive) ||
      new RegExp(`(?<![\\w./-])${escape(base)}(?![\\w/-])`).test(text) ||
      (provider.length >= 3 && base.includes("-") && loose.includes(provider.toLowerCase()))
    )
      result.push({ kind: "drive", path: drive })
  }
  const { hosts, ssh } = hostsIn(text)
  for (const host of hosts) result.push({ kind: "host", host })
  for (const item of ssh) result.push({ kind: "ssh", ...item })
  return result
}

/** The snapshot's remote a push names, by remote name or by a URL equal to one of its push URLs. A raw URL that is not
 * one of them, or a remote added later, gives undefined. */
export function pushTarget(snap: Snapshot, repoDir: string, target: string) {
  const repo = snap.repos.find((item) => item.dir === repoDir)
  if (!repo) return
  return (
    repo.remotes.find((remote) => remote.name === target) ??
    repo.remotes.find((remote) => remote.push.some((url) => same(url, target)))
  )
}

/** Checks the remote again right before a push: same push URLs as in the snapshot, and the same `gh` account active. */
export async function recheck(
  snap: Snapshot,
  repoDir: string,
  remoteName: string,
  exec: Run = defaultRun,
): Promise<Recheck> {
  const dir = await real(repoDir)
  const repo = snap.repos.find((item) => item.dir === dir)
  if (!repo) return { ok: false, reason: "repo" }
  const known = repo.remotes.find((remote) => remote.name === remoteName)
  if (!known) return { ok: false, reason: "remote_new" }
  const now = (await remotes(dir, exec)).find((remote) => remote.name === remoteName)
  if (!now || now.push.length !== known.push.length || now.push.some((url, i) => !same(url, known.push[i])))
    return { ok: false, reason: "url_changed" }
  const hosts = known.push.map((url) => parse(url)?.host)
  if (hosts.some((host) => !host)) return { ok: false, reason: "no_credential" }
  const then = snap.accounts.filter((account) => hosts.includes(account.host))
  if (then.length === 0 || hosts.some((host) => !then.some((account) => account.host === host)))
    return { ok: false, reason: "no_credential" }
  const current = await accounts(exec)
  for (const account of then)
    if (!current.some((item) => item.host === account.host && item.login === account.login))
      return { ok: false, reason: "account_changed" }
  return { ok: true, remote: known, account: then[0] }
}

function hide(value: string) {
  return value.length <= 1 ? "*" : value[0] + "*".repeat(Math.min(value.length - 1, 4))
}

/** How a destination is shown in the audit: host and repo name stay, account names and emails are hidden. */
export function label(destination: Destination) {
  switch (destination.kind) {
    case "git": {
      const [owner, ...rest] = destination.path.split("/")
      return `${destination.remote} ${destination.host}/${rest.length ? `${hide(owner)}/${rest.join("/")}` : owner}`
    }
    case "host":
      return destination.host
    case "ssh":
      return `${hide(destination.user)}@${destination.host}`
    case "rclone":
      return `rclone ${destination.name}`
    case "drive":
      return path.basename(destination.path).replace(/-[^-]*@.*$/, "-*")
  }
}

/** The `credential_snapshot` marker: what was known, by count and host only. */
export function summary(snap: Snapshot) {
  return {
    repos: snap.repos.length,
    remotes: snap.repos.reduce((sum, repo) => sum + repo.remotes.length, 0),
    hosts: [...new Set(snap.accounts.map((account) => account.host))],
    rclone: snap.rclone.length,
    drives: snap.drives.length,
  }
}

export * as OutwardKnown from "./outward-known"
