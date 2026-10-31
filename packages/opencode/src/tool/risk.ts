// What a shell command can do, as far as this file can prove from its words. Only `harmless` skips a prompt. Everything
// else asks, and `risky` says why Undo will not help. So a wrong or missing answer here costs one prompt, never a repo:
// `unknown` means nobody has shown it is safe, and it must never be read as safe.
//
// The list of what runs unprompted is deliberately short and made of named flags, not of refused ones. Each round of
// refusing flags turned up another spelling, so a flag, an argument shape or a command not named below is `unknown`.

export type Risk = "irreversible" | "remote"

export type Verdict =
  /** Reads only. `paths` must stay inside the project. What `contents` holds gets printed, `walks` is read recursively. */
  | { kind: "harmless"; paths: string[]; contents: string[]; walks: string[] }
  /** Changes files. It always asks: this describes what it touches, so the prompt can say when Undo cannot help. */
  | {
      kind: "undoable"
      paths: string[]
      removes?: boolean
      /** Touches untracked files and leaves ignored ones alone, so only those have to be in the snapshot. */
      untrackedOnly?: boolean
    }
  | { kind: "risky"; risk: Risk }
  | { kind: "unknown" }

const UNKNOWN: Verdict = { kind: "unknown" }
const risky = (risk: Risk): Verdict => ({ kind: "risky", risk })

type Reader = {
  /** Short flags that take nothing and only change how the result is printed. */
  bools: string
  /** Short flags that take a value, and what that value may be. */
  values?: Record<string, RegExp>
  /** Most file arguments it may take. A second one can mean something it writes to, as with `uniq`. */
  operands?: number
  /** Prints what is in its files, as opposed to their names. */
  contents?: boolean
}

const COUNT = /^\+?\d+$/
const DIGITS = "0123456789"
const ANYTHING = /^/

// Why each is here: none can run a program with these flags, none opens a socket, and each reads only what it is named.
const READERS: Record<string, Reader> = {
  // Names and metadata of what it is named. No -L or -H: it does not follow a link unless it is told to.
  ls: { bools: "1aAdFhlpRrSt" },
  // Bytes of the files named, nothing else.
  cat: { bools: "nbs", contents: true },
  // Lines only. No -c, which cuts a value into pieces no scrubber recognises, and no -f, which never returns.
  head: { bools: DIGITS, values: { n: COUNT }, contents: true },
  tail: { bools: DIGITS, values: { n: COUNT }, contents: true },
  // Counts of the files named. No --files0-from, which takes the list from a file.
  wc: { bools: "lwcm", contents: true },
  // Reorders lines. No -o, which writes, and no long options: GNU's --compress-program runs a program.
  sort: { bools: "rnufbd", values: { k: /^[\w.,]+$/, t: /^.$/ }, contents: true },
  // One input at most: its second file argument is one it writes.
  uniq: { bools: "cdui", operands: 1, contents: true },
}

// Whole lines of the files named, or under the directories named with -r. No -o, which reassembles a secret a character
// at a time, no -f, which takes patterns from a file, and no -R, -S or -O, which follow links out of the project.
const GREP: Reader = { bools: "nilcvwHhFEqsxrI", values: { e: ANYTHING, A: COUNT, B: COUNT, C: COUNT } }

// Names only, by a named set of tests. Everything that writes or runs (-delete, -exec, -fprint) is simply not named, and
// neither is -L, -H or -follow. No `-newer`: it would need its value checked as a path too.
const FIND_VALUE: Record<string, RegExp> = {
  "-name": ANYTHING,
  "-iname": ANYTHING,
  "-path": ANYTHING,
  "-ipath": ANYTHING,
  "-type": /^[fdl]$/,
  "-maxdepth": /^\d+$/,
  "-mindepth": /^\d+$/,
}
const FIND_BARE = new Set(["-print", "-empty", "-not", "-a", "-o", "-and", "-or"])

const harmless = (paths: string[], contents: string[] = [], walks: string[] = []): Verdict => ({
  kind: "harmless",
  paths,
  contents,
  walks,
})

/** Splits arguments by what the reader declares. Undefined when any of them is something it does not declare. */
function operands(reader: Reader, args: string[]) {
  const found: string[] = []
  const flags = new Set<string>()
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!arg.startsWith("-")) {
      found.push(arg)
      continue
    }
    // `-` is stdin, `--` changes how what follows is read, and no long option is named at all.
    if (arg === "-" || arg.startsWith("--")) return undefined
    for (let at = 1; at < arg.length; at++) {
      const letter = arg[at]!
      const pattern = reader.values?.[letter]
      if (pattern) {
        const value = arg.slice(at + 1) || args[++index]
        if (value === undefined || !pattern.test(value)) return undefined
        if (letter === "e") values.push(value)
        break
      }
      if (!reader.bools.includes(letter)) return undefined
      flags.add(letter)
    }
  }
  return { found, flags, patterned: values.length > 0 }
}

function reader(name: string, args: string[]): Verdict {
  if (name === "pwd") return args.every((arg) => arg === "-L" || arg === "-P") ? harmless([]) : UNKNOWN
  if (name === "true") return args.length === 0 ? harmless([]) : UNKNOWN
  // Prints its own words. The caller checks that they are literal, so no expansion reads anything for it.
  if (name === "echo") return harmless([])
  if (name === "test") return args.length === 2 && /^-[efds]$/.test(args[0]!) ? harmless([args[1]!]) : UNKNOWN
  if (name === "find") return find(args)
  if (name === "grep") return grep(args)
  // Own keys only: `constructor` and `toString` are on every object, and neither is a reader.
  if (!Object.hasOwn(READERS, name)) return UNKNOWN
  const spec = READERS[name]!
  const parsed = operands(spec, args)
  if (!parsed || (spec.operands !== undefined && parsed.found.length > spec.operands)) return UNKNOWN
  // Nothing named means stdin, except for `ls`, which lists where it is.
  if (name === "ls" && parsed.found.length === 0) return harmless(["."])
  return harmless(parsed.found, spec.contents ? parsed.found : [])
}

function grep(args: string[]): Verdict {
  const parsed = operands(GREP, args)
  if (!parsed) return UNKNOWN
  const files = parsed.patterned ? parsed.found : parsed.found.slice(1)
  if (!parsed.patterned && parsed.found.length === 0) return UNKNOWN
  if (!parsed.flags.has("r")) return harmless(files, files)
  const walked = files.length > 0 ? files : ["."]
  return harmless(walked, [], walked)
}

function find(args: string[]): Verdict {
  const start = args.findIndex((arg) => arg.startsWith("-") || arg === "!")
  const roots = start < 0 ? args : args.slice(0, start)
  const tests = start < 0 ? [] : args.slice(start)
  for (let index = 0; index < tests.length; index++) {
    const test = tests[index]!
    if (test === "!" || FIND_BARE.has(test)) continue
    const pattern = FIND_VALUE[test]
    const value = tests[++index]
    if (!pattern || value === undefined || !pattern.test(value)) return UNKNOWN
  }
  return harmless(roots.length > 0 ? roots : ["."])
}

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

// Git cuts long options short and lets short ones share a dash, so `--har`, `--am` and `-qD` mean what they appear to.
const long = (arg: string, ...names: string[]) => {
  if (!arg.startsWith("--") || arg.length === 2) return false
  const given = arg.slice(2).split("=")[0]!
  return names.some((name) => name.startsWith(given))
}
const short = (arg: string, letters: string) =>
  /^-[^-]/.test(arg) && [...arg.slice(1)].some((letter) => letters.includes(letter))

const GIT_TAKES_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"])

/** What git runs once its own options are out of the way, so `git -C . push -f` reads as the push it is. */
function gitCommand(args: string[]) {
  let index = 0
  while (args[index]?.startsWith("-")) index += GIT_TAKES_VALUE.has(args[index]!) ? 2 : 1
  return args.slice(index)
}

// Never `harmless`. Even `git status` runs what a hostile repository or environment says to: `core.fsmonitor`, a
// worktree config, `post-index-change`, `HOME` with its `.gitconfig`, `GIT_CONFIG_*`. No check of today's config proves
// the next one, so a person answers instead. This only tells them when Undo would not bring back what it does.
function git(args: string[]): Verdict {
  const [sub, ...rest] = gitCommand(args)
  if (sub === undefined) return UNKNOWN
  if (sub === "push") {
    const force = rest.some(
      (a) => long(a, "force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune") || short(a, "fd") || /^[+:]/.test(a),
    )
    return risky(force ? "irreversible" : "remote")
  }
  if (["filter-branch", "filter-repo", "update-ref", "replace"].includes(sub)) return risky("irreversible")
  // Reaches another machine, runs its credential helper or ssh command, and writes refs. A named place can carry data.
  if (sub === "fetch") return rest.some((a) => !flag(a) && /[:/@]|^\./.test(a)) ? risky("remote") : UNKNOWN
  if (sub === "reflog" && ["expire", "delete"].includes(rest[0] ?? "")) return risky("irreversible")
  if (sub === "gc" && rest.some((a) => long(a, "prune"))) return risky("irreversible")
  if (sub === "stash") {
    if (["drop", "clear"].includes(rest[0] ?? "")) return risky("irreversible")
    return rest.length === 0 || rest[0] === "push" ? { kind: "undoable", paths: [] } : UNKNOWN
  }
  if (sub === "branch") {
    if (rest.some((a) => short(a, "DMCf") || long(a, "force"))) return risky("irreversible")
    return rest.some((a) => short(a, "dmc") || long(a, "delete", "move", "copy")) ? { kind: "undoable", paths: [] } : UNKNOWN
  }
  if (sub === "reset") {
    // The tree comes back through the snapshot, but commits the branch no longer points at do not. A bare name can be
    // a branch or a path, and only the forms that cannot move the branch are taken at their word.
    const separator = rest.indexOf("--")
    const target = (separator < 0 ? rest : rest.slice(0, separator)).filter((a) => !flag(a))
    const staysPut = target.length === 0 || (target.length === 1 && target[0] === "HEAD")
    return staysPut ? { kind: "undoable", paths: [] } : risky("irreversible")
  }
  if (sub === "clean") {
    if (!rest.some((a) => short(a, "f") || long(a, "force"))) return UNKNOWN
    if (rest.some((a) => short(a, "xX"))) return risky("irreversible")
    return { kind: "undoable", paths: ["."], removes: true, untrackedOnly: true }
  }
  if (sub === "commit") {
    return rest.some((a) => long(a, "amend")) ? risky("irreversible") : { kind: "undoable", paths: [] }
  }
  if (sub === "checkout" || sub === "switch") {
    if (rest.some((a) => short(a, "BC") || long(a, "force-create"))) return risky("irreversible")
    return { kind: "undoable", paths: [] }
  }
  if (["add", "restore", "rm", "mv"].includes(sub)) return { kind: "undoable", paths: [] }
  return UNKNOWN
}

/** `tokens` are the command name and arguments with quotes removed. */
export function classify(tokens: string[]): Verdict {
  const [spelled, ...args] = tokens
  if (!spelled) return UNKNOWN
  // How the danger is spelled does not change it. Being named by path does change what would run, so only the
  // bare names below can ever be harmless.
  const name = spelled.split("/").at(-1)!
  if (name === "git") {
    const verdict = git(args)
    if (verdict.kind === "risky") return verdict
    return args.some(dynamic) ? UNKNOWN : verdict
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
  if (spelled !== name) return UNKNOWN

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
  return reader(name, args)
}

// Editing these changes what later runs, or what the agent is allowed to do. Undo restoring them afterwards is too late,
// because by then it has run. A person approving `make` is judging make, not the Makefile an agent edited a step earlier,
// so the edit itself asks. Ordinary source is the line: an agent editing code that a test then runs is the job.
const SENSITIVE_DIRECTORIES = new Set([
  // Git and its hooks.
  ".git", ".husky", ".githooks",
  // What the agent reads as rules, tools and plugins.
  ".swarm", ".opencode", ".claude", ".cursor",
  // CI.
  ".github", ".gitlab", ".circleci", ".buildkite",
  // Editor tasks and settings, dev containers.
  ".vscode", ".idea", ".zed", ".fleet", ".helix", ".devcontainer",
  // Tool configuration, which can name a program to run.
  ".direnv", ".config", ".ssh", ".aws", ".kube", ".docker", ".gnupg", ".cargo", ".bundle", ".mvn", ".gradle", ".yarn",
])
const SENSITIVE_FILES = new Set([
  // Git.
  ".gitconfig", ".gitattributes", ".gitmodules",
  // Rules for the agent.
  "swarm.json", "swarm.jsonc", "opencode.json", "opencode.jsonc", "agents.md", "claude.md", "gemini.md", ".cursorrules", ".windsurfrules", ".mcp.json",
  // Shells, and what they source.
  ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".kshrc", ".cshrc", ".tcshrc", ".inputrc", ".envrc",
  // Tool settings that can run something or redirect where it fetches from.
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", "bunfig.toml", ".curlrc", ".wgetrc", ".vimrc", ".exrc", ".nvimrc", ".nvim.lua", ".gdbinit", ".lldbinit", ".pylintrc", ".ripgreprc", "pip.conf", ".pypirc", ".irbrc", ".pryrc", ".tmux.conf",
  // Version managers, which pick the program that runs.
  ".tool-versions", "mise.toml", ".mise.toml", ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".sdkmanrc",
  // Package scripts, build scripts and what they resolve.
  "package.json", "package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock", "bun.lockb", "deno.json", "deno.jsonc",
  "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "noxfile.py", "conftest.py", "pytest.ini", "cargo.toml", "cargo.lock", "build.rs", "go.mod", "gemfile", "rakefile", "brewfile",
  "makefile", "gnumakefile", "justfile", "taskfile.yml", "taskfile.yaml", "cmakelists.txt", "meson.build", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "pom.xml", "build.xml",
  "dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "flake.nix", "shell.nix", "default.nix",
  // CI and commit hooks that keep their file at the root.
  ".gitlab-ci.yml", ".travis.yml", "azure-pipelines.yml", "jenkinsfile", "bitbucket-pipelines.yml", ".drone.yml", "appveyor.yml", ".pre-commit-config.yaml", "lefthook.yml", ".lefthook.yml", ".huskyrc",
])
// Short Windows names of `.git`, and configuration that is itself a program. `.eslintrc.js` runs when a linter does.
const SENSITIVE_NAME =
  /^git~\d+$|\.mk$|^dockerfile\.|\.dockerfile$|\.code-workspace$|\.config\.(js|cjs|mjs|ts|cts|mts)$|^\.(eslintrc|babelrc|prettierrc|mocharc|lintstagedrc)(\.|$)/

// macOS and Windows disks ignore case, so `.GIT/config` is `.git/config`. HFS+ also skips some invisible characters and
// NTFS skips trailing dots and spaces and takes a stream suffix. APFS opens `ſwarm.json` as `swarm.json`, which NFKC folds.
// Matching what the disk would open costs one prompt at most.
const IGNORED_CHARACTERS = /[​-‏‪-‮⁠-⁯﻿]/g

export const canonical = (relative: string) =>
  relative
    .replaceAll("\\", "/")
    .normalize("NFKC")
    .replace(IGNORED_CHARACTERS, "")
    .toLowerCase()
    .split("/")
    .map((part) => (part === "." || part === ".." ? part : part.replace(/:.*$/, "").replace(/[. ]+$/, "")))
    .join("/")

export function sensitive(relative: string) {
  const parts = canonical(relative).split("/")
  const name = parts.at(-1)!
  return (
    parts.some((part) => SENSITIVE_DIRECTORIES.has(part) || /^git~\d+$/.test(part)) ||
    SENSITIVE_FILES.has(name) ||
    SENSITIVE_NAME.test(name)
  )
}

// Rebuilt by a command, so losing them costs a rebuild. Ignored files with any other name may be the only copy.
const REBUILT = new Set(["node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "coverage", "__pycache__", ".pytest_cache"])

export const rebuilt = (relative: string) => relative.split("/").some((part) => REBUILT.has(part))

export * as Risk from "./risk"
