// What a shell command can do that Undo cannot take back. Every step snapshots the project, so a change inside it is
// not worth interrupting anyone for, and a prompt on every `ls` teaches people to click yes on the force push.
//
// The list of what runs without asking is an allowlist: anything not recognised here stays `unknown` and keeps its
// normal permission rule. Getting a command wrong in this file therefore costs one prompt, not a lost repo.

export type Risk = "irreversible" | "remote"

export type Verdict =
  /** Reads only. `paths` must stay inside the project. */
  | { kind: "harmless"; paths: string[] }
  /** Changes files that the step's snapshot can restore, if `paths` turn out to be covered by it. */
  | { kind: "undoable"; paths: string[]; removes?: boolean; hooks?: boolean }
  | { kind: "risky"; risk: Risk }
  | { kind: "unknown" }

const UNKNOWN: Verdict = { kind: "unknown" }
const risky = (risk: Risk): Verdict => ({ kind: "risky", risk })

// Reads only with the flags refused in NEVER below. sed, awk, xargs, tee and env are out on purpose: each can write or run.
const READERS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "which", "echo", "printf", "printenv", "grep", "rg", "find", "diff", "sort",
  "uniq", "cut", "stat", "file", "du", "df", "basename", "dirname", "realpath", "tree", "jq", "true", "false", "test",
  "sleep",
])
// Each of these turns a reader into something that writes, or runs another program.
const NEVER: Record<string, RegExp> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-o|--output|--compress-program)/,
  rg: /^--(pre|hostname-bin)/,
  tree: /^-o/,
  file: /^(-C|--compile)$/,
}
const GIT_READERS = new Set([
  "status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "describe", "shortlog", "rev-list",
  "merge-base", "show-ref", "fetch",
])
const GIT_NEVER = /^(--output|--ext-diff|--upload-pack|--exec|--open-files-in-pager|-O|--textconv|--filters)/

const REMOTE: [string, RegExp][] = [
  ["npm", /^publish$/], ["pnpm", /^publish$/], ["yarn", /^publish$/], ["bun", /^publish$/], ["cargo", /^publish$/],
  ["gem", /^push$/], ["twine", /^upload$/], ["docker", /^push$/], ["vercel", /./], ["netlify", /^deploy$/], ["fly", /^deploy$/],
  ["terraform", /^(apply|destroy|import)$/], ["pulumi", /^(up|destroy)$/], ["kubectl", /^(apply|delete|replace|patch|scale|rollout)$/],
  ["helm", /^(install|upgrade|uninstall|rollback)$/], ["aws", /^(s3|ec2|rds|iam|lambda|cloudformation)$/],
]
const GH_REMOTE = /^(pr (merge|close|create)|release|repo (delete|edit|rename|archive)|secret|workflow run|issue (close|delete))/

const SYSTEM = new Set(["dd", "mkfs", "shutdown", "reboot", "halt", "diskutil", "launchctl", "systemctl", "crontab", "killall", "dropdb", "dropuser"])
const SQL_WIPE = /\b(drop\s+(table|database|schema)|truncate\s+|delete\s+from)\b/i
const DATA_TOOLS = new Set(["psql", "mysql", "sqlite3", "mongosh", "mongo", "cockroach"])

const flag = (arg: string) => arg.startsWith("-")
const dynamic = (arg: string) => /[$`]/.test(arg)
const glob = (arg: string) => /[*?[\]{}]/.test(arg)

function git(args: string[]): Verdict {
  const sub = args[0]
  const rest = args.slice(1)
  if (sub === undefined) return UNKNOWN
  if (sub === "push") {
    const force = rest.some((a) => /^(-f|--force.*|--mirror|--delete|-d|--prune)$/.test(a) || /^[+:]/.test(a))
    return risky(force ? "irreversible" : "remote")
  }
  if (["filter-branch", "filter-repo", "update-ref", "replace"].includes(sub)) return risky("irreversible")
  if (sub === "reflog" && ["expire", "delete"].includes(rest[0] ?? "")) return risky("irreversible")
  if (sub === "gc" && rest.some((a) => a.startsWith("--prune"))) return risky("irreversible")
  if (sub === "stash") {
    if (["drop", "clear"].includes(rest[0] ?? "")) return risky("irreversible")
    if (["list", "show"].includes(rest[0] ?? "")) return { kind: "harmless", paths: [] }
    if (rest.length === 0 || rest[0] === "push") return { kind: "undoable", paths: [] }
    return UNKNOWN
  }
  if (sub === "branch") {
    if (rest.some((a) => /^(-D|-M|--delete|--force|-f|-d|-m|--move)$/.test(a)))
      return rest.some((a) => /^(-D|-M|--force|-f)$/.test(a)) ? risky("irreversible") : UNKNOWN
    return { kind: "harmless", paths: [] }
  }
  if (sub === "reset") {
    if (!rest.includes("--hard")) return { kind: "undoable", paths: [] }
    // The tree comes back through the snapshot, but commits the branch no longer points at do not.
    const target = rest.filter((a) => !flag(a))
    return target.length === 0 || (target.length === 1 && target[0] === "HEAD")
      ? { kind: "undoable", paths: [] }
      : risky("irreversible")
  }
  if (sub === "clean") {
    if (rest.some((a) => /^-[a-z]*[xX]/.test(a))) return risky("irreversible")
    return rest.some((a) => /^-[a-z]*f/.test(a) || a === "--force") ? { kind: "undoable", paths: [] } : { kind: "harmless", paths: [] }
  }
  if (rest.some((a) => GIT_NEVER.test(a))) return UNKNOWN
  if (GIT_READERS.has(sub)) return { kind: "harmless", paths: [] }
  if (sub === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "get-url" ? { kind: "harmless", paths: [] } : UNKNOWN
  if (sub === "tag") return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list" ? { kind: "harmless", paths: [] } : UNKNOWN
  if (sub === "config") return rest[0] === "--get" || rest[0] === "--list" || rest[0] === "-l" ? { kind: "harmless", paths: [] } : UNKNOWN
  if (sub === "commit") return { kind: "undoable", paths: [], hooks: true }
  if (["add", "restore", "checkout", "switch", "rm", "mv"].includes(sub)) return { kind: "undoable", paths: [] }
  return UNKNOWN
}

/** `tokens` are the command name and arguments with quotes removed. */
export function classify(tokens: string[]): Verdict {
  const [name, ...args] = tokens
  if (!name) return UNKNOWN
  if (name === "git") {
    // git -c and -C change what the subcommand does and where. They are only worth reasoning about when they push.
    const verdict = git(args)
    if (verdict.kind === "risky") return verdict
    if (args.some(dynamic)) return UNKNOWN
    return verdict
  }
  if (name === "gh") return GH_REMOTE.test(args.join(" ")) ? risky("remote") : UNKNOWN
  if (SYSTEM.has(name) || name.startsWith("mkfs.")) return risky("irreversible")
  if (DATA_TOOLS.has(name) && args.some((a) => SQL_WIPE.test(a))) return risky("irreversible")
  if (name === "redis-cli" && args.some((a) => /^flush(all|db)$/i.test(a))) return risky("irreversible")
  if (name === "docker" && (/^(volume (rm|prune)|system prune|compose down.*-v)/.test(args.join(" ")))) return risky("irreversible")
  if (args.join(" ").match(/(prisma )?migrate reset|db:(drop|reset)|--force-reset/)) return risky("irreversible")
  if (REMOTE.some(([tool, sub]) => tool === name && sub.test(args[0] ?? ""))) return risky("remote")
  if ((name === "chmod" || name === "chown") && args.some((a) => /^-[a-zA-Z]*R/.test(a))) return risky("irreversible")

  if (tokens.some(dynamic)) return UNKNOWN

  if (READERS.has(name)) {
    if (NEVER[name] && args.some((a) => NEVER[name].test(a))) return UNKNOWN
    if (name === "uniq" && args.filter((a) => !flag(a)).length > 1) return UNKNOWN
    if (name === "echo" || name === "printf" || name === "printenv" || name === "sleep") return { kind: "harmless", paths: [] }
    return { kind: "harmless", paths: args.filter((a) => !flag(a)) }
  }
  if (name === "mkdir" || name === "touch") {
    const paths = args.filter((a) => !flag(a))
    return paths.length === 0 || paths.some(glob) ? UNKNOWN : { kind: "undoable", paths }
  }
  if (name === "rm" || name === "mv" || name === "cp") {
    if (args.includes("--no-preserve-root")) return risky("irreversible")
    const paths = args.filter((a) => !flag(a))
    if (paths.length === 0 || paths.some(glob)) return UNKNOWN
    // A copy only risks what it lands on. A move or a remove also takes away what it names.
    return { kind: "undoable", paths: name === "cp" ? paths.slice(-1) : paths, removes: name !== "cp" }
  }
  return UNKNOWN
}

// Editing these changes what later runs, or what the agent is allowed to do. Undo restoring them afterwards is too late.
const SENSITIVE = /(^|\/)(\.git|\.husky|\.swarm|\.opencode)(\/|$)|(^|\/)(swarm|opencode)\.jsonc?$|^\.github\/workflows\/|(^|\/)\.gitattributes$/

export const sensitive = (relative: string) => SENSITIVE.test(relative.replaceAll("\\", "/"))

// Rebuilt by a command, so losing them costs a rebuild. Ignored files with any other name may be the only copy.
const REBUILT = new Set(["node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "coverage", "__pycache__", ".pytest_cache"])

export const rebuilt = (relative: string) => relative.split("/").some((part) => REBUILT.has(part))

export * as Risk from "./risk"
