// What a shell command is about to do, as far as its words say. This labels a prompt and nothing more: it is why a prompt
// can say Undo will not help, and why it may leave out "Allow always". A label can only add caution, so nothing here can
// ever skip a prompt or lower a permission, and a wrong or missing answer costs a less informative prompt, never a repo.
//
// It used to go further and let proven reads run unprompted. Three passes found a new disagreement between this parser's
// words and the shell's each time, so safe reads moved to tools with no shell in them: read, glob, grep and git.

import fs from "node:fs"
import path from "node:path"
import { BashArity } from "@/permission/arity"

export type Risk = "irreversible" | "remote"

export type Verdict =
  /** Changes files: this describes what it touches, so the prompt can say when Undo cannot help. */
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

/** What reaches another machine by a program's first argument. Exported for the consented bypass's outward forms (1.1.1 F1b). */
export const REMOTE: readonly (readonly [string, RegExp])[] = [
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
export const long = (arg: string, ...names: string[]) => {
  if (!arg.startsWith("--") || arg.length === 2) return false
  const given = arg.slice(2).split("=")[0]!
  return names.some((name) => name.startsWith(given))
}
const short = (arg: string, letters: string) =>
  /^-[^-]/.test(arg) && [...arg.slice(1)].some((letter) => letters.includes(letter))

/**
 * 1.1.1 F10a (G3-1): whether a long option word names one of `names` (each spelled with its `--`), as GNU `getopt_long`,
 * Python's `argparse` and git's option parser read it: the name itself, or any shortening of it, with or without
 * `=value`. A word that is exactly another of the program's own options (`exact`, bare names) is that option. A shortening
 * several names share counts for each of them, so a check that refuses any one of them refuses it: the reading errs strict.
 */
export function abbreviates(word: string, names: readonly string[], exact: readonly string[] = [], caseless = false) {
  if (!word.startsWith("--") || word.length === 2) return false
  const fold = (text: string) => (caseless ? text.toLowerCase() : text)
  const given = fold(word.slice(2).split("=")[0]!)
  const bare = names.filter((name) => name.startsWith("--")).map((name) => fold(name.slice(2)))
  if (bare.includes(given)) return true
  if (exact.some((name) => fold(name) === given)) return false
  return bare.some((name) => name.startsWith(given))
}

const GIT_TAKES_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"])

/** What git runs once its own options are out of the way, so `git -C . push -f` reads as the push it is. */
export function gitCommand(args: string[]) {
  let index = 0
  while (args[index]?.startsWith("-")) index += GIT_TAKES_VALUE.has(args[index]!) ? 2 : 1
  return args.slice(index)
}

// Nothing here says a git command is safe. Even `git status` runs what a hostile repository or environment says to: `core.fsmonitor`, a
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
  // How the danger is spelled does not change it.
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
  return UNKNOWN
}

// Decided on the bytes, with no parser: only characters no shell gives a meaning, single spaces between words, and no word
// starting with `=`, which zsh would expand. So whatever a parser thinks, this runs one program with these words. Anything
// else, including any control character, a pipe, a redirect, a variable or a quote, is not plain.
const PLAIN_COMMAND = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*(?: [\w./@%+:,-][\w./@%+:,=-]*)*$/

// A rule for these would be a rule for anything: they run or fetch whatever their arguments say, or write where one points.
const NO_ALWAYS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "eval", "exec", "source", "command", "builtin", "env", "xargs", "sudo", "doas", "nohup", "nice", "time", "watch",
  "node", "nodejs", "python", "python2", "python3", "ruby", "perl", "php", "lua", "deno", "npx", "bunx", "pnpx", "uvx", "pipx",
  "curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "ftp", "rsync", "telnet",
  "rm", "rmdir", "mv", "cp", "ln", "dd", "chmod", "chown", "tee", "sed", "awk", "gawk", "find", "sort", "export", "alias", "unset", "set", "trap",
])
const GIT_NO_ALWAYS = new Set(["config", "submodule", "hook", "difftool", "mergetool", "bisect", "rebase", "filter-branch", "update-ref", "replace", "rm", "clean", "grep", "daemon", "archive", "worktree"])

// A rule for `git log *` is read as a rule for looking at history, so it must not cover what else git log can do: `--output=`
// writes a file, and `git commit --no-verify` skips the checks someone meant to keep. Each subcommand here takes only the flags
// listed, or no rule is offered and an earlier rule does not answer it.
const GIT_RULE_FLAGS: Record<string, ReadonlySet<string>> = {
  status: new Set(["-s", "--short", "-b", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--no-color", "--ignored"]),
  log: new Set(["--oneline", "--graph", "--stat", "--shortstat", "--name-only", "--name-status", "-p", "--patch", "--all", "--decorate", "--no-decorate", "--no-color", "--reverse", "--merges", "--no-merges", "-n"]),
  show: new Set(["--stat", "--shortstat", "--name-only", "--name-status", "--oneline", "-p", "--patch", "-s", "--no-patch", "--no-color"]),
  diff: new Set(["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--cached", "--staged", "--no-color"]),
  blame: new Set(["-w", "-s", "-L"]),
  branch: new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--list", "--show-current", "--no-color"]),
  add: new Set(["-A", "--all", "-u", "--update"]),
  commit: new Set(["-m", "-a", "--all", "--allow-empty"]),
}

/** The words of a command that can only be one program with those words, or undefined. */
export function plainWords(command: string) {
  return PLAIN_COMMAND.test(command) ? command.split(" ") : undefined
}

// `plainWords` with whole-word quotes as well: single quotes taken as written, and double quotes holding no `$`, backquote
// or `!`, so no shell rewrites what is inside. A `\` inside double quotes is let through only before a character the shell
// leaves alone there (grep's `\|`, row 273): before `$`, backquote, `"`, `\`, `!` or a line break it would be rewritten.
// The program's name stays bare, a quote never joins a bare part, and no control, format or line-separator character
// appears anywhere, so the line a person reads is the line that runs.
const QUOTED_WORD =
  String.raw`[\w./@%+:,-][\w./@%+:,=-]*|'[^']*'|"(?:[^"$` + "`" + String.raw`\\!]|\\[^"$` + "`" + String.raw`\\!\n])*"`
const QUOTED_COMMAND = new RegExp(String.raw`^[A-Za-z0-9_][A-Za-z0-9_.+-]*(?: (?:${QUOTED_WORD}))*$`)
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/**
 * The words of one program with literal arguments, quotes removed, or undefined. Only for a caller that judges every word
 * as the program will see it: a quoted word may hold a space, a `*` or a `;`, which reach the program as they are.
 */
export function quotedWords(command: string) {
  if (UNSEEN.test(command) || !QUOTED_COMMAND.test(command)) return undefined
  return [...command.matchAll(new RegExp(QUOTED_WORD, "g"))].map((match) => {
    const word = match[0]
    return word.startsWith("'") || word.startsWith('"') ? word.slice(1, -1) : word
  })
}

/** A plain `cp` or `mv`, as both the shell and the autonomy table read it (C97 F2). */
export type CopyMove = { name: "cp" | "mv"; sources: string[]; dest: string }

// Flags that change nothing about where the files land. `-n`, `-i`, `-t`, `--` and long options are not here, so the
// targets worked out below are always the ones the program writes.
const COPY_MOVE_FLAGS = { cp: /^-[prRfv]+$/, mv: /^-[fv]+$/ }

/** `cp`/`mv` with flags that do not move the target and two or more names, from unquoted words, or undefined. */
export function copyMove(words: readonly string[]): CopyMove | undefined {
  const name = words[0]
  if (name !== "cp" && name !== "mv") return undefined
  const args = words.slice(1)
  if (args.some((word) => word.startsWith("-") && !COPY_MOVE_FLAGS[name].test(word))) return undefined
  const names = args.filter((word) => !word.startsWith("-"))
  if (names.length < 2) return undefined
  return { name, sources: names.slice(0, -1), dest: names.at(-1)! }
}

/**
 * The absolute paths `cp`/`mv` writes, as the program picks them: into a folder that is there under each source's name,
 * otherwise the name given. Undefined when the program would refuse, such as two sources and no folder to put them in.
 */
export function copyTargets(item: CopyMove, cwd: string) {
  const dest = path.resolve(cwd, item.dest)
  const found = look(() => fs.statSync(dest, { throwIfNoEntry: false }))
  if (found === null) return undefined
  if (found?.isDirectory() !== true) return item.sources.length === 1 ? [dest] : undefined
  return item.sources.map((source) => path.join(dest, path.basename(path.resolve(cwd, source))))
}

/**
 * Of these targets, the ones there now that a copy or a move would replace, a link as the link. One that cannot be looked
 * at counts as there, so it is never taken for a new name.
 */
export function replaced(targets: readonly string[]) {
  return targets.filter((file) => look(() => fs.lstatSync(file, { throwIfNoEntry: false })) !== undefined)
}

// `null` when the disk would not say (a file where a folder should be, no access), so a caller can tell that from "not there".
function look(read: () => fs.Stats | undefined) {
  try {
    return read()
  } catch {
    return null
  }
}

/** What an "Allow always" may cover for this command, or undefined when it should not be offered at all. */
export function scope(command: string) {
  const words = plainWords(command)
  if (!words) return undefined
  if (NO_ALWAYS.has(words[0]!)) return undefined
  if (words[0] === "git") {
    const sub = words[1] ?? ""
    // `git -c core.pager=x log` or `git -C elsewhere log` is not the subcommand a rule would name.
    if (sub.startsWith("-") || GIT_NO_ALWAYS.has(sub)) return undefined
    const flags = GIT_RULE_FLAGS[sub]
    if (flags && words.slice(2).some((word) => word.startsWith("-") && !flags.has(word) && !/^-\d+$/.test(word))) return undefined
  }
  return BashArity.scope(words)
}

// Editing these changes what later runs, or what the agent is allowed to do. Undo restoring them afterwards is too late,
// because by then it has run. A person approving `make` is judging make, not the Makefile an agent edited a step earlier,
// so the edit itself asks. Ordinary source is the line: an agent editing code that a test then runs is the job.
const SENSITIVE_DIRECTORIES = new Set([
  // Git and its hooks.
  ".git", ".husky", ".githooks",
  // What the agent reads as rules, tools and plugins.
  ".swarm", ".opencode", ".claude", ".cursor", ".agents",
  // CI.
  ".github", ".gitlab", ".circleci", ".buildkite",
  // Editor tasks and settings, dev containers.
  ".vscode", ".idea", ".zed", ".fleet", ".helix", ".devcontainer",
  // Tool configuration, which can name a program to run.
  ".direnv", ".config", ".ssh", ".aws", ".kube", ".docker", ".gnupg", ".cargo", ".bundle", ".mvn", ".gradle", ".yarn",
])
const SENSITIVE_FILES = new Set([
  // Git.
  ".gitconfig", ".gitattributes", ".gitmodules", ".gitignore",
  // Rules for the agent.
  "swarm.json", "swarm.jsonc", "opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc", "agents.md", "claude.md", "context.md", "gemini.md", ".cursorrules", ".windsurfrules", ".mcp.json",
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

// 1.1.1 F12b (S4-2): configuration a compiler, bundler, test runner, coverage tool, linter or formatter reads to decide
// where it writes or what it runs (`outDir`, `outputs`, a reporter file, a plugin). A run the consent opens then writes
// wherever the file says, outside the project included, so under consent an edit of one stays the person's. Names a tool
// reads that `sensitive` already lists (`pyproject.toml`, `setup.cfg`, `tox.ini`, `cargo.toml`, `.cargo/`, `*.config.js`,
// `.eslintrc*`, `.prettierrc*`, `.babelrc*`) are not repeated. This is not part of `sensitive`, which 1.1.0 verdicts read.
const TOOL_CONFIG_FILES = new Set([
  // TypeScript and JavaScript tools.
  "jsconfig.json", "biome.json", "biome.jsonc", ".swcrc", ".parcelrc", ".nycrc", ".c8rc", ".jshintrc", "tslint.json",
  ".stylelintrc", ".postcssrc", "turbo.json", "nx.json", "project.json", "lerna.json", "rush.json",
  "angular.json", ".angular-cli.json", "nest-cli.json", ".markdownlint.json", ".markdownlint.jsonc", ".markdownlint.yaml", ".markdownlint.yml",
  // Python.
  "ruff.toml", ".ruff.toml", "mypy.ini", ".mypy.ini", ".coveragerc", ".flake8", ".isort.cfg", "pyrightconfig.json", "pylintrc", ".pytest.ini", "pytest.toml", ".pytest.toml",
  // Rust, Go, Swift and others.
  "rustfmt.toml", ".rustfmt.toml", "clippy.toml", ".clippy.toml", "rust-toolchain", "rust-toolchain.toml", "go.work", "go.work.sum",
  ".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json", "package.swift", ".swiftlint.yml", ".swift-format", ".bazelrc",
  // 1.1.1 F39 (G15-1, P54): where a publish or hosted deploy the consent opens sends, and what it uploads. `.npmrc`,
  // `.yarnrc*`, `bunfig.toml`, `.pypirc`, `pip.conf` and `.cargo/` are in `sensitive` already; `.netlify/` below.
  "uv.toml", "poetry.toml", "netlify.toml", "netlify.yml", "netlify.yaml", "netlify.json", "firebase.json", ".firebaserc",
  // 1.1.1 F40 (n88, P56): what `fly deploy` and `vercel` read, for the same reason.
  "fly.toml", "vercel.json",
])
// `tsconfig.json` and every `tsconfig.*.json` an `extends` names (1.1.1 F14: with a `.jsonc` extension too), any `*.config.json|yaml|toml` (`jest.config.json`,
// `babel.config.json`), and the rc files that take a format suffix (`.nycrc.json`, `.stylelintrc.yml`, `.swcrc.json`).
const TOOL_CONFIG_NAME =
  /^tsconfig(\..+)?\.jsonc?$|^jsconfig\..+\.jsonc?$|\.config\.(json|jsonc|json5|ya?ml|toml)$|^\.(nycrc|c8rc|stylelintrc|postcssrc|swcrc|jshintrc|markdownlint|remarkrc|golangci)\./

/** 1.1.1 F12b (S4-2): a tool's configuration, read only by the consent overlay (`Reach.consentSensitive`). */
export function toolConfig(relative: string) {
  const parts = canonical(relative).split("/")
  const name = parts.at(-1)!
  // 1.1.1 F39 (G15-1): netlify's linked-site state (`.netlify/state.json`) and anything else in its folder.
  return TOOL_CONFIG_FILES.has(name) || TOOL_CONFIG_NAME.test(name) || parts.includes(".netlify")
}

// What an edit may touch with nobody asked. This is a list of what is ordinary, because the list above can only name what
// someone thought of, and each gate found another: `tui.json`, `composer.json`, `Vagrantfile`, `.pnp.cjs`. A file not here
// asks, once, and that is the whole cost of being wrong. It is written as what the code and docs of a project look like:
const ORDINARY_SOURCE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro|py|pyi|rb|go|rs|java|kt|scala|swift|c|h|cc|cpp|cxx|hpp|hh|m|mm|cs|fs|php|lua|ex|exs|erl|hs|ml|clj|cljs|dart|zig|r|jl|sql|graphql|gql|proto|css|scss|sass|less|html|htm|md|mdx|txt|rst|adoc)$/
// Data formats double as configuration, so they are ordinary only inside what is plainly a project's own content.
const ORDINARY_DATA = /\.(json|jsonc|yaml|yml|toml|csv|tsv|xml|svg)$/
const CONTENT_DIRECTORIES = new Set(["src", "lib", "app", "test", "tests", "spec", "specs", "__tests__", "fixtures", "testdata", "docs", "locales", "locale", "i18n", "public", "assets", "static", "data"])
// Code other code loads by its path rather than by being called.
const LOADED_BY_PATH = new Set(["node_modules", "bower_components", "vendor", "venv", "site-packages", "dist-packages"])
// Source files whose name makes a tool run them: `vite.config.ts`, `conftest.py`, `Package.swift`, `mix.exs`, `build.rs`.
const CODE_THAT_CONFIGURES =
  /\.(config|conf|setup|rc|workspace)\.[^.]+$|^(conftest|noxfile|fabfile|tasks|sitecustomize|manage|setup|build|gulpfile|gruntfile|dangerfile|webpack|rollup|metro|karma|protractor|package|mix|podfile|appfile|fastfile|gems|gemfile|tsconfig|jsconfig)\.|^(requirements|constraints)[.-]/

/** Whether an edit here is the agent doing the job, as opposed to changing what later runs or what is allowed. */
export function ordinaryEdit(relative: string) {
  if (sensitive(relative)) return false
  const parts = canonical(relative).split("/")
  const name = parts.at(-1)!
  const folders = parts.slice(0, -1)
  if (parts.some((part) => part === ".." || (part.startsWith(".") && part !== "."))) return false
  if (folders.some((part) => LOADED_BY_PATH.has(part)) || CODE_THAT_CONFIGURES.test(name)) return false
  return ORDINARY_SOURCE.test(name) || (ORDINARY_DATA.test(name) && folders.some((part) => CONTENT_DIRECTORIES.has(part)))
}

// Rebuilt by a command, so losing them costs a rebuild. Ignored files with any other name may be the only copy.
const REBUILT = new Set(["node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "coverage", "__pycache__", ".pytest_cache"])

export const rebuilt = (relative: string) => relative.split("/").some((part) => REBUILT.has(part))

export * as Risk from "./risk"
