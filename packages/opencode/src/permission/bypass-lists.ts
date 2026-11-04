// Swarm 1.1.1 F1b (D-F1-3): the lists the consented bypass reads, in one place. `bypass-screen.ts` and
// `autonomy-table.ts` both import them, so neither keeps its own copy and neither has to import the other for a list.
// Pure data: no Effect, no I/O. Shell families and launchers live in `tool/deletion.ts`, which the shell tool also reads.
import path from "node:path"
import type { ScriptScreen } from "./script-screen"
import { DeletionWords } from "../tool/deletion"
import { Risk } from "../tool/risk"

/** The script-screen flags that keep a `script_flagged` call for a person under consent (and in the gate's forgery check). */
export const HARD_SCRIPT_FLAGS: ReadonlySet<ScriptScreen.Flag> = new Set(["network", "delete", "sudo", "outside_path"])

export const SHELLS = DeletionWords.SHELLS
export const ADMIN: ReadonlySet<string> = new Set(["sudo", "doas", "su", "pkexec", "run0"])
export const OUTWARD: ReadonlySet<string> = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "socat", "ssh", "scp", "sftp", "ftp", "lftp", "telnet", "rsync", "rclone",
  "http", "https", "xh", "aria2c", "gh", "glab", "hub", "croc", "wormhole",
  // Mail.
  "mail", "mailx", "sendmail", "mutt", "neomutt", "msmtp", "swaks", "s-nail",
])
/**
 * 1.1.1 F10a (G3-1): git options of a look that write a file, run a program or read beyond the repository, by name. git
 * takes a long option by any unambiguous shortening, so a shortening of one is that option. `--text` is an option of its
 * own and not a shortening of `--textconv`. Read by the 1.1.0 look reader (`autonomy-table.ts`) and the allowlist.
 */
export const GIT_ACT_NAMES: readonly string[] = ["--output", "--ext-diff", "--open-files-in-pager", "--no-index", "--exec", "--textconv"]
export const GIT_ACT_EXACT: readonly string[] = ["text"]
export const GIT_OUTWARD: ReadonlySet<string> = new Set(["push", "fetch", "pull", "clone", "ls-remote", "submodule", "send-email", "request-pull"])
export const SYSTEM_SERVICE: ReadonlySet<string> = new Set(["launchctl", "systemctl", "crontab"])
export const SQL_TOOLS: ReadonlySet<string> = new Set(["psql", "mysql", "sqlite3", "mongosh", "mongo", "cockroach"])
// S1.21 plus `delete from` (the same SQL wipe `tool/risk.ts` labels irreversible; decision R2-D2).
export const SQL_WIPE = /\b(drop\s+(table|database|schema|index|view|collection)|truncate\b|delete\s+from\b)|\.drop(Database|Collection)\(/i
export const MIGRATE_WIPE = /(prisma\s+)?migrate\s+reset|db:(drop|reset)|--force-reset/
export const DISK_WIPE = /^(erase|zero|secureErase|reformat|partitionDisk|eraseDisk|eraseVolume|apfs)/i
export const HOST: ReadonlySet<string> = new Set(["dd", "mkfs", "shred", "wipefs", "shutdown", "reboot", "halt", "dropdb", "dropuser"])
export const FIND_EXEC: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"])
// Words of the shell's own language that run text the screen never sees as words.
export const RUNS_TEXT: ReadonlySet<string> = new Set(["eval", "source", ".", "alias", "function", "trap"])

const positional = (args: readonly string[]) => args.filter((word) => !word.startsWith("-"))
const first = (pattern: RegExp) => (args: readonly string[]) => pattern.test(positional(args).join(" "))

/**
 * M1 (P11): what leaves the machine by a program's subcommand, beside `tool/risk.ts`'s remote list: a package publish, an
 * image push, a hosted deploy, a release or a pull request, an upload. These wait for a person (`outward`).
 */
export const OUTWARD_FORMS: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  npm: first(/^(publish|unpublish|deprecate|dist-tag (add|rm)|owner (add|rm)|access)\b/),
  pnpm: first(/^publish\b/),
  yarn: first(/^(publish|npm publish)\b/),
  bun: first(/^publish\b/),
  cargo: first(/^(publish|yank|owner)\b/),
  gem: first(/^(push|yank|owner)\b/),
  twine: first(/^upload\b/),
  poetry: first(/^publish\b/),
  flit: first(/^publish\b/),
  hatch: first(/^publish\b/),
  uv: first(/^publish\b/),
  docker: (args) => /^(image )?push\b|^(login|logout)\b/.test(positional(args).join(" ")) || args.includes("--push"),
  podman: (args) => /^(image )?push\b|^login\b/.test(positional(args).join(" ")) || args.includes("--push"),
  buildah: first(/^push\b/),
  nerdctl: first(/^(image )?push\b/),
  skopeo: first(/^(copy|sync|delete)\b/),
  crane: first(/^(push|copy|cp|append|mutate|tag|delete)\b/),
  vercel: () => true,
  netlify: first(/^(deploy|sites:create|env:set)\b/),
  firebase: first(/deploy\b/),
  fly: first(/^(deploy|launch|secrets set)\b/),
  flyctl: first(/^(deploy|launch|secrets set)\b/),
  heroku: () => true,
  wrangler: first(/^(deploy|publish|pages deploy|secret put|r2 object put|kv)\b/),
  surge: () => true,
  railway: first(/^(up|deploy)\b/),
  gcloud: first(/\b(deploy|submit|upload|cp|rsync)\b/),
  gsutil: first(/^(cp|rsync|mv)\b/),
  az: first(/\b(deploy|up|upload|upload-batch)\b/),
  aws: first(/^(s3 (cp|sync|mv)|s3api put-object|lambda update-function-code|deploy)\b/),
  mvn: (args) => positional(args).includes("deploy"),
  gradle: first(/\bpublish/),
  dotnet: first(/^nuget push\b/),
  eas: first(/^(submit|update|build)\b/),
  expo: first(/^publish\b/),
}

/**
 * M3 (P10): a write outside the folder through linking, a global install, a global config or a system preference. They wait
 * for a person as a write outside does (`outside_write_held`). `npm install` in the folder is not here.
 */
const GLOBAL = (args: readonly string[]) => args.some((word) => /^(-g|--global|--location=global|--system)$/.test(word))
export const OUTSIDE_WRITE_FORMS: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  npm: (args) => /^(link|ln)\b/.test(positional(args).join(" ")) || (GLOBAL(args) && /^(i|install|add|un|uninstall|rm|remove|update|up|link)\b/.test(positional(args).join(" "))) || (/^config (set|delete|edit|rm)\b/.test(positional(args).join(" ")) && !args.some((word) => word === "--location=project")),
  pnpm: (args) => /^(link|ln)\b/.test(positional(args).join(" ")) || (GLOBAL(args) && /^(add|install|i|remove|rm|update|up)\b/.test(positional(args).join(" "))) || /^config (set|delete)\b/.test(positional(args).join(" ")),
  yarn: (args) => /^(link|global|config set|config delete)\b/.test(positional(args).join(" ")),
  bun: (args) => /^(link|unlink)\b/.test(positional(args).join(" ")) || (GLOBAL(args) && /^(add|a|install|i|remove|rm|update)\b/.test(positional(args).join(" "))),
  deno: (args) => GLOBAL(args) && /^(install|uninstall)\b/.test(positional(args).join(" ")),
  pip: (args) => /^install\b/.test(positional(args).join(" ")) && args.some((word) => /^--(user|target|prefix|root|break-system-packages)(=|$)/.test(word)) || /^config (set|unset|edit)\b/.test(positional(args).join(" ")),
  pip3: (args) => /^install\b/.test(positional(args).join(" ")) && args.some((word) => /^--(user|target|prefix|root|break-system-packages)(=|$)/.test(word)) || /^config (set|unset|edit)\b/.test(positional(args).join(" ")),
  pipx: first(/^(install|uninstall|inject|upgrade|ensurepath)\b/),
  uv: first(/^(tool (install|uninstall|upgrade)|python install)\b/),
  cargo: first(/^(install|uninstall)\b/),
  go: first(/^install\b/),
  gem: first(/^(install|uninstall|update)\b/),
  brew: first(/^(install|reinstall|uninstall|remove|rm|upgrade|link|unlink|tap|untap|services|pin|unpin|cleanup|autoremove)\b/),
  port: first(/^(install|uninstall|upgrade|activate|deactivate)\b/),
  mas: first(/^(install|uninstall|upgrade)\b/),
  rustup: first(/^(default|toolchain|target|component|update|self|set|override)\b/),
  volta: first(/^(install|uninstall|pin)\b/),
  corepack: first(/^(enable|disable|install|prepare)\b/),
  asdf: first(/^(install|uninstall|global|plugin)\b/),
  mise: (args) => GLOBAL(args) || /^(install|uninstall|use -g|plugins? (install|add))\b/.test(positional(args).join(" ")),
  git: (args) => {
    const sub = Risk.gitCommand([...args])
    return sub[0] === "config" && sub.slice(1).some((word) => /^--(global|system)$/.test(word) || /^--file(=|$)|^-f$/.test(word))
  },
  gh: first(/^(config set|alias set|extension install|auth (login|setup-git))\b/),
  gcloud: first(/^(config set|auth)\b/),
  aws: first(/^configure\b/),
  defaults: first(/^(write|delete|import|rename)\b/),
  scutil: (args) => args.includes("--set"),
  networksetup: (args) => args.some((word) => /^-(set|add|remove|create|delete)/.test(word)),
  systemsetup: (args) => args.some((word) => /^-set/.test(word)),
  pmset: (args) => !args.every((word) => word.startsWith("-g")),
  nvram: (args) => args.some((word) => word.includes("=") || word === "-d" || word === "-c"),
  chsh: () => true,
  dscl: (args) => args.some((word) => /^-(create|append|delete|merge|passwd|change)$/.test(word)),
  spctl: (args) => args.some((word) => /^--(add|remove|enable|disable|master-enable|master-disable|global-enable|global-disable)$/.test(word)),
  tccutil: () => true,
  tmutil: first(/^(enable|disable|setdestination|addexclusion|removeexclusion|delete)\b/),
  softwareupdate: (args) => args.some((word) => /^(-i|--install|-a|--all|--schedule)$/.test(word)),
  gsettings: first(/^(set|reset)\b/),
  dconf: first(/^(write|reset|load)\b/),
  "update-alternatives": () => true,
  "xdg-mime": first(/^default\b/),
  duti: () => true,
  mdutil: (args) => args.some((word) => /^-[iEd]/.test(word)),
}

/**
 * Programs whose words the overlay knows well enough that a risky word after them is an argument, not a program they run.
 * A program not here that is followed by one the risk tables call risky (`mytool git push`) keeps its 1.1.0 verdict.
 */
export const KNOWN_PROGRAMS: ReadonlySet<string> = new Set([
  "git", "bun", "npm", "pnpm", "yarn", "node", "deno", "make", "gmake", "cmake", "ninja", "meson", "cargo", "rustc", "go",
  "gofmt", "python", "python3", "pip", "pip3", "uv", "poetry", "tsc", "tsgo", "eslint", "prettier", "biome", "oxlint", "jest",
  "vitest", "mocha", "pytest", "ruff", "black", "mypy", "pyright", "playwright", "turbo", "nx", "vite", "webpack", "esbuild",
  "rollup", "swc", "docker", "kubectl", "helm", "terraform", "ls", "cat", "head", "tail", "wc", "grep", "rg", "ag", "find",
  "fd", "echo", "printf", "pwd", "cd", "mkdir", "touch", "cp", "mv", "rm", "ln", "sed", "awk", "sort", "uniq", "cut", "tr",
  "diff", "cmp", "patch", "jq", "yq", "date", "sleep", "true", "false", "test", "[", "which", "type", "file", "stat", "du",
  "df", "tree", "chmod", "chown", "tar", "zip", "unzip", "gzip", "gunzip", "xz", "basename", "dirname", "realpath",
  "readlink", "printenv", "uname", "whoami", "id", "hostname", "ps", "kill", "lsof", "less", "more", "tee", "xcodebuild",
  "swift", "swiftc", "pod", "gradle", "gradlew", "mvn", "java", "javac", "kotlinc", "dotnet", "ruby", "gem", "bundle",
  "rake", "php", "composer", "lua", "perl", "open", "code", "shasum", "sha256sum", "md5", "md5sum", "base64", "seq",
  "nproc", "sw_vers", "column", "paste", "join", "comm", "nl", "fold", "fmt", "expand", "od", "xxd", "hexdump", "strings",
])

/** Interpreters, with the options that give them code to run in place of a file. */
export const INLINE_CODE: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"], python2: ["-c"], python3: ["-c"], pypy: ["-c"], pypy3: ["-c"],
  node: ["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--experimental-loader"],
  nodejs: ["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader"],
  bun: ["-e", "--eval", "-p", "--print", "-r", "--preload"],
  deno: [],
  ruby: ["-e", "-r"], perl: ["-e", "-E", "-M", "-m"], php: ["-r", "-B", "-R", "-E", "-F"], lua: ["-e", "-l"], luajit: ["-e", "-l"],
  Rscript: ["-e"], julia: ["-e", "-E", "--eval", "--print"], osascript: ["-e"], "ts-node": ["-e", "--eval", "-p", "--print", "-r", "--require"],
  tsx: ["-e", "--eval", "-p", "--print", "--import"], "vite-node": ["-e"], esno: [],
  awk: ["-f"], gawk: ["-f"], mawk: ["-f"], nawk: ["-f"],
}
/** Their own subcommands: a first word here is no script (`bun test`, `deno task`). `run` is followed by a script or name. */
export const INTERPRETER_SUBS: Readonly<Record<string, ReadonlySet<string>>> = {
  bun: new Set(["test", "build", "install", "i", "add", "a", "remove", "rm", "update", "outdated", "link", "unlink", "pm", "create", "c", "init", "upgrade", "publish", "patch", "audit", "info", "why", "run"]),
  deno: new Set(["test", "task", "fmt", "lint", "check", "compile", "install", "uninstall", "add", "remove", "info", "doc", "bench", "outdated", "upgrade", "init", "run", "serve", "eval", "repl", "jupyter", "coverage", "types", "publish"]),
}
/** Options that only print and run nothing: an interpreter with only these is no code. */
export const PRINTS_ONLY = /^(-v|-V|--version|-h|--help|--test|-VV)$/
/** A word that names a script file by its kind. */
export const SCRIPT_FILE = /\.(sh|bash|zsh|fish|ksh|csh|py|pyw|js|mjs|cjs|ts|mts|cts|tsx|jsx|rb|pl|pm|php|lua|r|R|jl|scpt|applescript|awk)$/

/** Git's own subcommands. Any other word is an alias, which may run any program. */
export const GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "checkout", "cherry", "cherry-pick",
  "clean", "clone", "commit", "config", "count-objects", "describe", "diff", "difftool", "fetch", "format-patch", "fsck",
  "gc", "grep", "help", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mergetool", "mv",
  "notes", "pull", "push", "range-diff", "rebase", "reflog", "remote", "repack", "replace", "reset", "restore", "revert",
  "rev-list", "rev-parse", "rm", "shortlog", "show", "show-branch", "show-ref", "sparse-checkout", "stash", "status",
  "submodule", "switch", "tag", "worktree", "whatchanged", "cat-file", "hash-object", "update-index", "update-ref",
  "symbolic-ref", "for-each-ref", "name-rev", "check-ignore", "check-attr", "var", "verify-commit", "verify-tag",
  "maintenance", "lfs", "filter-branch", "version", "diff-tree", "diff-index", "diff-files", "merge-file", "read-tree",
  "write-tree", "commit-tree", "mktag", "prune", "send-email", "request-pull", "blame", "citool", "gui",
])
/** Git options that configure it inline, so any subcommand may become an alias or run a program (H3). */
export const GIT_INLINE_CONFIG = /^(-c|--config-env|--exec-path)(=|$)|^-c./
/** Environment that changes what git, a shell or an interpreter loads or runs before the program's own words. */
export const LOADS_CODE =
  /^(GIT_CONFIG[A-Z_]*|GIT_EXEC_PATH|GIT_SSH|GIT_SSH_COMMAND|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|GIT_ASKPASS|GIT_EXTERNAL_DIFF|GIT_DIR|GIT_WORK_TREE|GIT_TEMPLATE_DIR|EDITOR|VISUAL|PAGER|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|PERL5OPT|PERL5LIB|RUBYOPT|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME)=/
/** `NODE_OPTIONS` loads code only with these. */
export const NODE_OPTIONS_CODE = /^NODE_OPTIONS=.*(-r\b|--require|--import|--loader|--experimental-loader)/

/** Options that give an SQL tool its statement inline, which the screen reads. Anything else reads a file or stdin (M2). */
export const SQL_INLINE: Readonly<Record<string, readonly string[]>> = {
  psql: ["-c", "--command"],
  mysql: ["-e", "--execute"],
  mongosh: ["--eval"],
  mongo: ["--eval"],
  cockroach: ["-e", "--execute"],
  sqlite3: [],
}
/** Options that make an SQL tool read statements from a file. */
export const SQL_FILE = /^(-f|--file|-i|--init|-init|--source|\.read|\.import)(=|$)|^\.read\b|^source\b/i

/** `tool/risk.ts`'s remote list, read here too so a hosted deploy it names is outward under consent. */
export const RISK_REMOTE = Risk.REMOTE

// ---------------------------------------------------------------------------------------------------------------------
// 1.1.1 F7 (decision P15): the allowlist. Under consent a held shell call is opened only when every step is one of these
// recognised development commands in one of these forms. A program that is not here, a subcommand that is not here, or an
// option here excluded (one that makes the program run another program or code, write outside the folder, force, rewrite
// or delete) keeps the call's 1.1.0 verdict. Each form gets the words after the program and what the screen can look up.
// ---------------------------------------------------------------------------------------------------------------------

/** What a form may ask about the step's folder. Every answer is read from disk by `bypass-screen.ts`. */
export type AllowContext = {
  /**
   * 1.1.1 F10b (P19): the script of that name in the nearest `package.json` at or above the step's folder, inside the
   * project, with its `pre`/`post` hooks, read by the shell's own reader with `extra` appended as the manager appends it,
   * and every step of each (and of every script those call, three deep) one this list accepts with the same checks. A
   * manifest that cannot be read, a missing script, a cycle or anything not understood answers false.
   */
  runs: (name: string, extra: readonly string[]) => boolean
  /** A program of that name in the project's own `node_modules/.bin`, at or above the step's folder. */
  localBin: (name: string) => boolean
  /** The project has its own Python environment (`.venv/pyvenv.cfg` or `venv/pyvenv.cfg`). */
  venv: () => boolean
  /** A word names something that exists, relative to the step's folder. */
  exists: (word: string) => boolean
  /** Another step the allowlist accepts: what `npx`, `bun x`, `uv run`, `poetry run` and `python -m` hand on. */
  step: (argv: readonly string[]) => boolean
  /** 1.1.1 F10a (m20): a word names a folder inside the project once every link on the way is followed. */
  inside: (word: string) => boolean
  /** 1.1.1 F10a (P5 A2d): every target of a `kill` is a process this session's own shell tool started. */
  ownKill: (args: readonly string[]) => boolean
  /**
   * 1.1.1 F12a (V4-1, m32): an install of the project's packages. The lifecycle scripts of the manifest at npm's install
   * root, when P30 lets that install open at all (see `installOpens` in `bypass-screen.ts`), that an install runs
   * (`preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`) each pass what a script
   * run by name must; a manifest that cannot be read answers false. Dependencies' own install scripts are an accepted
   * residual (P15).
   */
  installs: () => boolean
  /**
   * 1.1.1 F40 (P56 usability item 8): `npm version`'s own lifecycle scripts in the nearest manifest (`preversion`,
   * `version`, `postversion`), each passing what a script run by name must. The version bump itself (the manifest, the
   * lock file, its commit and tag) is not counted as a write beside a publish.
   */
  versions: () => boolean
}
export type AllowForm = (args: readonly string[], ctx: AllowContext) => boolean

/**
 * Environment a step may set before its program: none of these changes what the program loads or runs. 1.1.1 F40 (P56
 * usability item 7): exactly these names, each with a plain value (letters, digits and `._:-/,=`; no `$`, backquote or
 * quote survives the shell's reading of a plain word).
 */
const READ_THROUGH_NAMES: ReadonlySet<string> = new Set([
  "CI", "NODE_ENV", "DEBUG", "FORCE_COLOR", "NO_COLOR", "TZ", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM",
  "RUST_BACKTRACE", "RUST_LOG", "PYTHONUNBUFFERED",
])
/**
 * 1.1.1 F41 (G17-3, n95): the value rule for an assignment of a harmless name, before a program or on its own. Plain
 * characters only. The locale, time-zone and terminal names take a name, never a file: no leading `/`, `~` or `:`, no
 * `..`, and for the locale and terminal names no `/` at all (`TZ=Europe/Berlin` stays a name).
 */
function plainValue(name: string, value: string) {
  if (!/^[A-Za-z0-9._:\/,=-]*$/.test(value)) return false
  if (name === "TZ" || name === "LANG" || name === "TERM" || name.startsWith("LC_")) {
    if (/^[\/~:]/.test(value) || value.includes("..")) return false
    if (name !== "TZ" && value.includes("/")) return false
  }
  return true
}
/**
 * 1.1.1 F41 (CR17-3): the one source of the assignment allowlist. The shell's reader (`tool/shell.ts`) keeps a leading
 * `NAME=value` word only by `names` and `value`, and the consented screen reads such a word through only by `test`.
 */
export const SAFE_ASSIGNMENT = {
  names: READ_THROUGH_NAMES,
  value: plainValue,
  test(word: string) {
    const at = word.indexOf("=")
    return at > 0 && READ_THROUGH_NAMES.has(word.slice(0, at)) && plainValue(word.slice(0, at), word.slice(at + 1))
  },
} as const
/**
 * 1.1.1 F41 (G17-2): names an assignment statement or `export` may set for the rest of a call without changing what any
 * later program loads, reads or sends to. Under consent any other name assigned in the call (the home folder, the search
 * path, `XDG_*`, a loader, config or registry pointer, or a local variable) keeps the call at 1.1.0, because no consented
 * check may then assume the server's own values.
 */
export const HARMLESS_EXPORTS: ReadonlySet<string> = new Set(["LC_ALL", "LANG", "TZ", "NO_COLOR", "FORCE_COLOR", "CI", "COLUMNS", "TERM"])
/** 1.1.1 F41 (G17-2, G17-3): an assignment the call may make for its later steps under consent. */
export const harmlessAssignment = (word: string) => {
  const at = word.indexOf("=")
  return at > 0 && HARMLESS_EXPORTS.has(word.slice(0, at)) && plainValue(word.slice(0, at), word.slice(at + 1))
}
/** Folders a program may be spelled from by its full path (`/usr/bin/make`); anywhere else it is not the recognised one. */
export const SYSTEM_BIN: readonly string[] = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]

const optionName = (word: string) => word.split("=")[0]!
const isOption = (word: string) => word.startsWith("-") && word !== "-"
const shortWord = (word: string) => /^-[^-]/.test(word)
/** The letters of a short-option word up to and including the first one that takes a value (`-am` -> a, m). */
function shortLetters(word: string, valued: string) {
  const letters: string[] = []
  for (const letter of word.slice(1)) {
    letters.push(letter)
    if (valued.includes(letter)) break
  }
  return letters
}
/**
 * No word is one of these options: long by name or by any shortening of it (1.1.1 F10a, G3-1: GNU, git, argparse and npm
 * take a long option shortened; a word that is exactly one of `exact`, another option of the program, is that one), `-x`
 * short by exact word or joined value `-xVALUE`.
 */
const excluding =
  (exact: readonly string[], names: readonly string[]): AllowForm =>
  (args) =>
    !args.some((word) => {
      if (!isOption(word)) return false
      if (names.includes(optionName(word)) || Risk.abbreviates(word, names, exact)) return true
      return shortWord(word) && names.some((name) => /^-[^-]$/.test(name) && word.startsWith(name))
    })
const without = (...names: string[]): AllowForm => excluding([], names)
/** A long option word that names one of these, by name or shortened. */
const longIs = (word: string, names: readonly string[], exact: readonly string[] = []) => Risk.abbreviates(word, names, exact)
/** Every option is one of these (by name; `valued` ones take the next word as their value). */
function onlyOptions(args: readonly string[], allowed: ReadonlySet<string>, valued: ReadonlySet<string> = new Set()) {
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "--") return { ok: true, positional: [...positional, ...args.slice(index + 1)], ended: true }
    if (!isOption(word)) {
      positional.push(word)
      continue
    }
    const name = optionName(word)
    if (valued.has(name)) {
      if (!word.includes("=")) index++
      continue
    }
    if (!allowed.has(name) && !allowed.has(word)) return { ok: false, positional, ended: false }
  }
  return { ok: true, positional, ended: false }
}
/** A package name or spec as a registry reads it; a URL, a `git+`, `file:` or `npm:` alias is none. */
const PACKAGE = /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~<>=*|-]+)?$/

// git -----------------------------------------------------------------------------------------------------------------
const GIT_GLOBAL = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"])
const GIT_SHOW_EXCLUDED = excluding(GIT_ACT_EXACT, ["--ext-diff", "--output", "--textconv", "--open-files-in-pager", "--no-index", "--exec"])
/** A word a remote name or a plain branch: no refspec (`:`, `+`), no URL, no option. */
const PLAIN_REF = /^[A-Za-z0-9][\w./-]*$/
const fetchLike = (args: readonly string[], excluded: AllowForm, ctx: AllowContext) =>
  excluded(args, ctx) && args.filter((word) => !isOption(word)).every((word) => PLAIN_REF.test(word) && !word.includes(".."))

export const GIT_FORMS: Readonly<Record<string, AllowForm>> = {
  status: () => true,
  diff: GIT_SHOW_EXCLUDED,
  log: GIT_SHOW_EXCLUDED,
  show: GIT_SHOW_EXCLUDED,
  blame: () => true,
  // List, create or rename; never delete, force or copy over.
  branch: (args) => {
    const read = onlyOptions(
      args,
      new Set(["-a", "-r", "-v", "-vv", "-l", "--list", "--show-current", "--all", "--remotes", "--verbose", "-m", "--move", "--color", "--no-color", "--merged", "--no-merged", "--contains", "--no-contains", "--sort", "--format", "--points-at"]),
    )
    return read.ok && !read.ended && read.positional.length <= 2
  },
  // A branch by name, or a new one; no force, no discarding, no orphan.
  switch: (args) => {
    const read = onlyOptions(args, new Set(["--detach", "-d", "--no-guess", "--guess", "-t", "--track", "--no-track", "-q", "--quiet"]), new Set(["-c", "--create"]))
    return read.ok && !read.ended && read.positional.length <= 2
  },
  // `checkout <branch>` or `checkout -b <branch> [<start>]`. A word that names a path is the path form, which throws away
  // the changes to that path, so it is not this.
  checkout: (args, ctx) => {
    const read = onlyOptions(args, new Set(["-t", "--track", "--no-track", "--detach", "-q", "--quiet"]), new Set(["-b"]))
    if (!read.ok || read.ended) return false
    const created = args.flatMap((word, index) => (word === "-b" ? [args[index + 1] ?? ""] : []))
    if (created.length > 1 || !created.every((word) => PLAIN_REF.test(word))) return false
    const plain = (word: string) => word === "-" || (PLAIN_REF.test(word) && !ctx.exists(word))
    // `-b <new> [<start>]`, or exactly one branch name.
    const least = created.length === 1 ? 0 : 1
    return read.positional.length >= least && read.positional.length <= 1 && read.positional.every(plain)
  },
  add: (args) =>
    onlyOptions(args, new Set(["-A", "--all", "-u", "--update", "-N", "--intent-to-add", "-v", "--verbose", "-n", "--dry-run", "--ignore-errors", "--renormalize", "--no-all", "--ignore-removal"])).ok,
  // A new commit; never an amend, an editor, or a fixup that rewrites.
  commit: (args) =>
    !args.some((word) => {
      if (!isOption(word)) return false
      if (shortWord(word)) return shortLetters(word, "mFCcSt").some((letter) => "ectp".includes(letter))
      if (longIs(word, ["--amend", "--edit", "--template", "--reedit-message", "--interactive", "--patch"])) return true
      return longIs(word, ["--fixup"]) && /^--[^=]*=(amend|reword):/.test(word)
    }),
  stash: (args) => {
    const sub = args.find((word) => !isOption(word))
    if (sub !== undefined && !["push", "list", "show", "apply", "pop"].includes(sub)) return false
    return !args.some((word) => word === "-p" || longIs(word, ["--patch"]))
  },
  // `--prune` is an option of its own, not a shortening of `--prune-tags`.
  fetch: (args, ctx) => fetchLike(args, excluding(["prune"], ["--upload-pack", "-f", "--force", "--prune-tags", "-P", "--refmap"]), ctx),
  pull: (args, ctx) =>
    fetchLike(args, excluding(["prune"], ["--rebase", "-r", "-f", "--force", "-s", "--strategy", "-X", "--strategy-option", "--upload-pack", "-e", "--edit", "--prune-tags"]), ctx),
  merge: without("-s", "--strategy", "-X", "--strategy-option", "-e", "--edit"),
  // Create or list; never delete, force or edit.
  tag: (args) =>
    !args.some((word) => {
      if (!isOption(word)) return false
      if (shortWord(word)) return shortLetters(word, "mFu").some((letter) => "dfe".includes(letter))
      return longIs(word, ["--delete", "--force", "--edit"])
    }),
  remote: (args) => {
    const rest = args.filter((word) => word !== "-v" && word !== "--verbose")
    return rest.length === 0 || (rest[0] === "show" && rest.slice(1).every((word) => word === "-n" || PLAIN_REF.test(word)))
  },
  "rev-parse": () => true,
  "ls-files": () => true,
  grep: (args) => !args.some((word) => /^-O/.test(word) || longIs(word, ["--open-files-in-pager", "--no-index"])),
  describe: () => true,
  worktree: (args) => args[0] === "list",
}

function git(args: readonly string[], ctx: AllowContext) {
  let index = 0
  // 1.1.1 F10a (m20): `-C <dir>` may come anywhere among git's own options, and git applies each one after the other, so
  // a word that names a path is read from the folder all of them together name.
  let dir: string | undefined
  while (index < args.length && isOption(args[index]!)) {
    if (args[index] === "-C") {
      const value = args[index + 1]
      if (value === undefined || value === "") return false
      dir = dir === undefined || value.startsWith("/") ? value : `${dir}/${value}`
      index += 2
      continue
    }
    if (!GIT_GLOBAL.has(args[index]!)) return false
    index++
  }
  const sub = args[index]
  const form = sub !== undefined && Object.hasOwn(GIT_FORMS, sub) ? GIT_FORMS[sub] : undefined
  if (dir !== undefined && !ctx.inside(dir)) return false
  const exists = (word: string) => ctx.exists(dir ? `${dir}/${word}` : word)
  return form !== undefined && form(args.slice(index + 1), { ...ctx, exists })
}

// package managers ----------------------------------------------------------------------------------------------------
/** Options that load code before the program, or hand the work to another program or shell, or install elsewhere. */
const JS_CODE = ["-e", "--eval", "-p", "--print", "-r", "--require", "--preload", "--import", "--loader", "--experimental-loader"]
const GLOBAL_INSTALL = [
  "-g", "--global", "--location", "--prefix", "--userconfig", "--globalconfig", "--script-shell", "--node-options", "-c", "--call",
  // 1.1.1 F14 (G4-2 variant): a config file the manager reads instead of the project's (bun's `--config`, its tsconfig
  // override, yarn's rc file).
  "--config", "--tsconfig-override", "--use-yarnrc", "--rc-filename",
]
/** 1.1.1 F14 (G4-2 variant): pnpm and npm take any setting inline as `--config.<key>=<value>`; such a word keeps 1.1.0. */
const INLINE_SETTING = /^--?config\./
const packages = (args: readonly string[]) => args.filter((word) => !isOption(word)).every((word) => PACKAGE.test(word))
/**
 * `run <script> [args]`: a script of the project's manifest whose text (hooks included) the allowlist accepts, with only
 * harmless options before its name. 1.1.1 F10b: the words after the name are appended to its text, as the manager does.
 */
const runScript = (args: readonly string[], ctx: AllowContext, before: ReadonlySet<string>) => {
  const at = args.findIndex((word) => !isOption(word))
  if (at < 0) return false
  if (!args.slice(0, at).every((word) => before.has(optionName(word)))) return false
  return ctx.runs(args[at]!, scriptArgs(args.slice(at + 1)))
}
/** What a manager appends to a script's text: its words, past one `--` that only ends the manager's own options. */
const scriptArgs = (args: readonly string[]) => (args[0] === "--" ? args.slice(1) : args)
/**
 * `exec <bin> [args]`: the project's own program, which must itself be a step this list accepts. 1.1.1 F14 (G5-1): the
 * manager takes its first `--` away (before the program's name, or after it) and hands the program the rest, so the
 * program's words are judged without it: an output option after it is the program's option.
 * 1.1.1 F15 (CR6-2): `npx`, `bunx` and `bun x` (`passesOn`) hand a `--` that comes after the program's name on to the
 * program, where the words past it are files. Those forms open only when the program's words pass read both ways.
 */
const localStep = (args: readonly string[], ctx: AllowContext, passesOn = false) => {
  const rest = args[0] === "--" ? args.slice(1) : withoutFirst(args, "--")
  const bin = rest[0]
  if (bin === undefined || !/^[\w@][\w.@-]*$/.test(bin) || !ctx.localBin(bin) || !ctx.step(rest)) return false
  return !passesOn || rest === args || args[0] === "--" || ctx.step(args)
}
const withoutFirst = (args: readonly string[], word: string) => {
  const at = args.indexOf(word)
  return at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 1)]
}
// 1.1.1 F10b: no `--workspaces`, `-ws`, `--filter`, `-F` or `--recursive`. They run the script of other manifests, which
// the one read here does not show.
const RUN_BEFORE = new Set(["--silent", "-s", "--bun", "--if-present"])
const ELSEWHERE = [
  "-w", "-W", "--workspace", "--workspaces", "--workspace-root", "--include-workspace-root", "--filter", "--filter-prod", "-F", "-r",
  "--recursive", "-C", "--dir", "--cwd", "--prefix", "--ignore-workspace-root-check",
]
/**
 * 1.1.1 F12a (S4-3): the option shorthands of each manager's option reader, from their documented aliases. npm's reader
 * (nopt) takes a shorthand with one dash or two (`-ws`, `--ws`), and splits a single-dash word that is no shorthand into
 * its letters (`-sw` is `-s -w`); pnpm reads the same way. Expanded before the other-folder check, so a spelling of a
 * workspace or folder option is the option it stands for. An unknown letter stays a short option of its own.
 */
const SHORTHANDS: Readonly<Record<"bun" | "npm" | "pnpm" | "yarn", Readonly<Record<string, string>>>> = {
  npm: {
    w: "--workspace", ws: "--workspaces", iwr: "--include-workspace-root", C: "--prefix", g: "--global", c: "--call",
    s: "--silent", silent: "--silent", q: "--quiet", d: "--loglevel", dd: "--loglevel", ddd: "--loglevel", L: "--location",
    l: "--long", p: "--parseable", f: "--force", y: "--yes", h: "--usage", H: "--usage", v: "--version",
  },
  pnpm: {
    r: "--recursive", F: "--filter", C: "--dir", w: "--workspace-root", W: "--ignore-workspace-root-check", s: "--silent",
    g: "--global", P: "--prod", D: "--dev", O: "--optional", h: "--help", v: "--version",
  },
  yarn: { W: "--ignore-workspace-root-check", s: "--silent", h: "--help", v: "--version" },
  bun: { F: "--filter", h: "--help" },
}
/** The option words as the manager reads them, every shorthand expanded (an `=value` stays on the expanded word). */
export function expandManagerOptions(manager: "bun" | "npm" | "pnpm" | "yarn", words: readonly string[]): string[] {
  const map = SHORTHANDS[manager]
  const named = (name: string) => (Object.hasOwn(map, name) ? map[name] : undefined)
  return words.flatMap((word) => {
    if (!isOption(word) || word === "--") return [word]
    const eq = word.indexOf("=")
    const value = eq < 0 ? "" : word.slice(eq)
    const body = (eq < 0 ? word : word.slice(0, eq)).replace(/^--?/, "")
    const whole = named(body)
    if (word.startsWith("--")) return [whole !== undefined && (manager === "npm" || manager === "pnpm") ? whole + value : word]
    if (whole !== undefined) return [whole + value]
    if (body.length <= 1) return [word]
    // A single-dash word of several letters that is no shorthand: each letter, the last one keeping the value.
    const letters = [...body]
    return letters.map((letter, index) => (named(letter) ?? `-${letter}`) + (index === letters.length - 1 ? value : ""))
  })
}
/** 1.1.1 F12a (S4-3): what npm and pnpm may be given before a script's `--`; any other option keeps 1.1.0. */
const SCRIPT_OPTIONS = new Set(["--silent", "--if-present"])
/**
 * 1.1.1 F10b (G3-2): options of a test runner that clean, delete or move its temporary, cache or coverage folders. Each
 * keeps the call at its 1.1.0 verdict; the default run, which keeps them where the tool always keeps them, stays opened.
 * `exact` are the runner's own options that a shortening reader would otherwise take for one of these.
 */
const BUN_TEST_CLEANS = ["--coverage-dir"]
/**
 * 1.1.1 F19 (S8-2): options that start a network listener: the inspector, which gives whoever connects full code
 * execution (any host or port, the default one included). Each keeps the call at its 1.1.0 verdict.
 */
const BUN_TEST_LISTENS = ["--inspect", "--inspect-brk", "--inspect-wait"]
const BUN_TEST_EXACT = ["coverage"]

/** `bun`, `npm`, `pnpm` and `yarn`: what each runs, with its subcommand first. */
function packageManager(manager: "bun" | "npm" | "pnpm" | "yarn"): AllowForm {
  return (args, ctx) => {
    if (!without(...GLOBAL_INSTALL)(args, ctx) || !without(...GLOBAL_INSTALL)(expandManagerOptions(manager, args), ctx)) return false
    if (args.some((word) => INLINE_SETTING.test(word))) return false
    const [sub, ...rest] = args
    // 1.1.1 F10b: an option that makes the manager run another folder's or other packages' scripts (before any `--`).
    // 1.1.1 F12a (S4-3): read with every shorthand expanded.
    const own = expandManagerOptions(manager, args.indexOf("--") < 0 ? args : args.slice(0, args.indexOf("--")))
    const scripted = sub !== undefined && (["test", "t", "run", "run-script"].includes(sub) || (sub === "build" && manager !== "bun"))
    if (scripted && !(manager === "bun" && ["test", "t"].includes(sub))) {
      if (!without(...ELSEWHERE)(own, ctx)) return false
      // npm reads its own options anywhere before `--`, and pnpm is held to the same: only a short positive list passes.
      if ((manager === "npm" || manager === "pnpm") && !own.slice(1).every((word) => !isOption(word) || SCRIPT_OPTIONS.has(word))) return false
    }
    // 1.1.1 F12a (V4-1, m32): an install runs the project manifest's lifecycle scripts, which are read as a script is.
    if (sub === undefined) return manager === "yarn" && without(...ELSEWHERE)(own, ctx) && ctx.installs()
    if (["install", "i", "add", "a", "ci"].includes(sub)) {
      // 1.1.1 F14 (G5-2): an install for workspace members, other packages or another folder runs lifecycle scripts of
      // manifests the one read here does not show; it keeps 1.1.0 as a script run does.
      if (!without(...ELSEWHERE)(own, ctx)) return false
      if (manager !== "bun" && sub === "a") return false
      if (manager === "bun" && sub === "ci") return false
      return packages(rest) && ctx.installs()
    }
    // 1.1.1 F10b: `bun test` is bun's own runner, whatever the manifest says; `npm test`, `pnpm test` and `yarn test` run
    // the manifest's `test` script, which is read as `run test` is. `npm build` is no script (npm has no such command).
    if (["test", "t"].includes(sub))
      return manager === "bun" ? excluding(BUN_TEST_EXACT, [...JS_CODE, ...BUN_TEST_CLEANS, ...BUN_TEST_LISTENS])(rest, ctx) : ctx.runs("test", scriptArgs(rest))
    if (sub === "run" || (manager === "npm" && sub === "run-script")) return runScript(rest, ctx, RUN_BEFORE)
    if (sub === "build") {
      if (manager === "bun") return without(...JS_CODE)(rest, ctx)
      return manager !== "npm" && ctx.runs("build", scriptArgs(rest))
    }
    if (sub === "x" && manager === "bun") return bunx(rest, ctx)
    if (sub === "version") return manager === "npm" && npmVersion(rest) && ctx.versions()
    if (sub === "exec" || (sub === "x" && manager === "npm")) return without("--package")(rest, ctx) && localStep(rest, ctx)
    return false
  }
}
/**
 * 1.1.1 F40 (P56 usability item 8): `npm version <bump>`, with one `-m <message>` (or `--message <message>`) and
 * `--no-git-tag-version` at most. The bump is a release word or a plain `x.y.z`; anything else (`from-git`, `--preid`,
 * `--sign-git-tag`, a workspace option) is not this form. 1.1.1 F41 (G17-1): the message is a word that does not start
 * with `-`.
 */
const NPM_BUMP = /^(patch|minor|major|premajor|preminor|prepatch|prerelease|\d+\.\d+\.\d+)$/
function npmVersion(rest: readonly string[]) {
  let bumps = 0
  let message = 0
  let tagless = 0
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]!
    if (word === "--no-git-tag-version") tagless++
    else if (word === "-m" || word === "--message") {
      message++
      // 1.1.1 F41 (G17-1): npm takes a following word that starts with `-` as an option of its own, never as the message.
      const text = rest[++index]
      if (text === undefined || text.startsWith("-")) return false
    } else if (NPM_BUMP.test(word)) bumps++
    else return false
  }
  return bumps === 1 && message <= 1 && tagless <= 1
}
/**
 * 1.1.1 F17 (n34): `npx`, `bunx` and `bun x` are held alike: a package or call option anywhere on the line (the program's
 * own `-p` included, which only keeps more calls at 1.1.0) refuses the form.
 */
const runnerOptions = without("-p", "--package", "-c", "--call")
const npx: AllowForm = (args, ctx) => runnerOptions(args, ctx) && localStep(args.filter((word) => word !== "--no-install" && word !== "--no"), ctx, true)
const bunx: AllowForm = (args, ctx) => runnerOptions(args, ctx) && localStep(args, ctx, true)

const PIP_ELSEWHERE = ["--user", "--target", "-t", "--prefix", "--root", "--break-system-packages", "--system"]
// `pip install --pre` is an option of its own, not a shortening of `--prefix`.
const pipElsewhere = excluding(["pre"], PIP_ELSEWHERE)
const pip: AllowForm = (args, ctx) =>
  args[0] === "install" && ctx.venv() && pipElsewhere(args, ctx) && args.slice(1).every((word) => isOption(word) || !word.includes(":"))
const RUN_OPTIONS = new Set(["--frozen", "--locked", "--no-sync", "--quiet", "-q", "--all-extras", "--dev", "--no-dev", "--offline"])
const RUN_VALUED = new Set(["--extra", "--group", "--package"])
/** `uv run` / `poetry run` hands its words to a program: that program is a step in its own right. */
function runsStep(args: readonly string[], ctx: AllowContext) {
  let index = 0
  while (index < args.length && isOption(args[index]!)) {
    const name = optionName(args[index]!)
    if (RUN_VALUED.has(name)) index += args[index]!.includes("=") ? 1 : 2
    else if (RUN_OPTIONS.has(name)) index++
    else return false
  }
  const rest = args[index] === "--" ? args.slice(index + 1) : args.slice(index)
  return rest.length > 0 && ctx.step(rest)
}
/** 1.1.1 F14 (G4-2 variant): uv's and poetry's options that read another project's or another config file. */
const PY_PROJECT_ELSEWHERE = without("--config-file", "--project", "--directory", "-C", "-P")
const uv: AllowForm = (args, ctx) => {
  if (!PY_PROJECT_ELSEWHERE(args, ctx)) return false
  const [sub, ...rest] = args
  if (sub === "sync") return pipElsewhere(rest, ctx)
  if (sub === "add") return pipElsewhere(rest, ctx) && packages(rest)
  if (sub === "pip") return rest[0] === "install" && pipElsewhere(rest, ctx) && rest.slice(1).every((word) => isOption(word) || !word.includes(":"))
  if (sub === "run") return runsStep(rest, ctx)
  return false
}
const poetry: AllowForm = (args, ctx) => {
  if (!PY_PROJECT_ELSEWHERE(args, ctx)) return false
  const [sub, ...rest] = args
  if (sub === "install") return true
  if (sub === "add") return packages(rest)
  if (sub === "run") return runsStep(rest, ctx)
  return false
}
// `--config` can name a runner or a wrapper, `-Z` turns on what is not stable. 1.1.1 F10b (G3-2): a test run that moves
// the build folder (`--target-dir`, `--artifact-dir`) keeps 1.1.0.
// 1.1.1 F19 (S8-4): a `--` hands the words after it to another reader (the compiler for `clippy`, rustfmt for `fmt`, the
// test binary for `test`), whose output options are not read here; such a call keeps 1.1.0.
const cargo: AllowForm = (args, ctx) =>
  !args.includes("--") &&
  ["build", "b", "test", "t", "check", "c", "fmt", "clippy"].includes(args[0] ?? "") &&
  // 1.1.1 F14 (G4-2 variant): another manifest, or another folder to start from.
  without("--config", "-Z", "--manifest-path", "-C")(args.slice(1), ctx) &&
  (!["test", "t"].includes(args[0]!) || without("--target-dir", "--artifact-dir")(args.slice(1), ctx))
/**
 * Go reads `-flag` and `--flag` the same. `-exec`, `-toolexec` and `-vettool` run another program. 1.1.1 F10b (G3-2): a
 * test run that moves its output, coverage or fuzz cache folder keeps 1.1.0.
 */
const GO_TEST_CLEANS = ["outputdir", "test.outputdir", "test.gocoverdir", "test.fuzzcachedir", "test.testlogfile", "fuzzcache"]
const go: AllowForm = (args) =>
  ["build", "test", "vet", "fmt"].includes(args[0] ?? "") &&
  !args.slice(1).some((word) => {
    if (!isOption(word)) return false
    const name = optionName(word).replace(/^--?/, "")
    // 1.1.1 F14 (G4-2 variant): another module file, or another folder to start from.
    return ["exec", "toolexec", "vettool", "overlay", "modfile", "C"].includes(name) || (args[0] === "test" && GO_TEST_CLEANS.includes(name))
  })
// 1.1.1 F10b (P19): no `make`. A target runs whatever the makefile says, which this list does not read.

// compilers, type checkers, linters, formatters, test runners ---------------------------------------------------------
const pytest: AllowForm = (args) =>
  !args.some((word) => {
    if (!isOption(word)) return false
    // 1.1.1 F20 (S9-5): `-d` is the distributed-execution plugin's own short form of `--dist load`.
    if (shortWord(word)) return [...word.slice(1)].some((letter) => "pcod".includes(letter))
    // `--pdb`, `--co` and pytest-cov's own `--cov...` options are options of their own; any other shortening of these
    // counts as the option. 1.1.1 F10b (G3-2): `--basetemp` empties the folder it names, `--cache-clear` and `--cov-reset`
    // clear what was kept, `--cov-report`/`--cov-config` move the report folder, `--rsyncdir` copies folders away. 1.1.1
    // F20 (S9-5): the distributed-execution plugin's (pytest-xdist) options that send the tests to, or run them on, another
    // host or interpreter: execution environments (`--tx`, `--px`), how tests are spread over them (`--dist`, `--distload`)
    // and what is copied there (`--rsyncdir`, `--rsyncignore`). This rests on the plugin's documentation; it is not on disk.
    // A local run spread over worker processes (`-n`) stays open.
    return longIs(
      word,
      [
        "--config-file", "--override-ini", "--pdbcls", "--rootdir", "--confcutdir", "--basetemp", "--cache-clear", "--cov-reset",
        "--cov-report", "--cov-config", "--rsyncdir", "--rsyncignore", "--tx", "--px", "--dist", "--distload",
      ],
      ["pdb", "co", "cov", "cov-append", "cov-branch", "cov-context", "cov-fail-under", "cache-show"],
    )
  })
/**
 * 1.1.1 F10b (G3-2): vitest's `--clearCache`, the coverage folder's clean-before-run and clean-on-rerun, a moved coverage
 * or cache folder, and a provider module (which is code). `--coverage` and `--cache` are vitest's own options, not
 * shortenings of these. Both spellings, as its option reader takes both.
 */
const VITEST_CODE = [
  "-c", "--config", "--globalSetup", "--setupFiles", "--reporter", "--environment", "--pool", "--poolOptions", "--workspace", "--project",
  "--clearCache", "--clear-cache", "--coverage.clean", "--coverage.cleanOnRerun", "--coverage.clean-on-rerun", "--coverage.reportsDirectory",
  "--coverage.reports-directory", "--coverage.customProviderModule", "--coverage.custom-provider-module", "--cache.dir",
  // 1.1.1 F14 (G4-2 variant): another root, where the config is looked for, and how it is loaded.
  "-r", "--root", "--configLoader",
  // 1.1.1 F15: a module that tells vitest which files changed, loaded as code.
  "--experimental.vcsProvider",
  // 1.1.1 F17 (S7-3): options that name a program vitest starts (the typechecker, by name or path) or that add words to
  // the node it starts for its workers (`--require`, `--import` load code). Every spelling folds onto these.
  "--typecheck.checker", "--execArgv",
  // 1.1.1 F19 (S8-2): options that start a network listener: the inspector (any host or port), the API server (its host,
  // port, exec and write settings), the UI, standalone mode and browser mode, each of which serves the API.
  "--inspect", "--inspectBrk", "--api", "--ui", "--standalone", "--browser",
]
// 1.1.1 F17 (S7-3): `--typecheck` alone turns typechecking on with the default checker; it is no shortening.
const VITEST_EXACT = ["coverage", "cache", "typecheck"]
/** 1.1.1 F10b (G3-2): jest's `--clearCache` and a moved cache or coverage folder; `--coverage` and `--cache` are its own. */
const JEST_CODE = [
  "-c", "--config", "--setupFiles", "--setupFilesAfterEnv", "--globalSetup", "--globalTeardown", "--reporters", "--testRunner",
  "--transform", "--testEnvironment", "--env", "--resolver", "--preset", "--watchPlugins", "--testSequencer", "--snapshotResolver",
  "--moduleNameMapper", "--runner", "--filter", "--testResultsProcessor", "--projects",
  "--clearCache", "--clear-cache", "--cacheDirectory", "--cache-directory", "--coverageDirectory", "--coverage-directory",
  // 1.1.1 F14 (G4-2 variant): another root, where the config is looked for.
  "--rootDir", "--roots",
]
const JEST_EXACT = ["watch", "coverage", "cache"]
/** 1.1.1 F12a (S4-4): `--some-name` as camelCase (`--someName`), sub-options included, as vitest's and jest's readers fold it. */
const camel = (word: string) => word.replace(/(?<=[A-Za-z0-9])-([a-z])/g, (_, letter: string) => letter.toUpperCase())
/**
 * 1.1.1 F14 (G4-4): an option name with every way a yargs-style reader folds it taken out: its dashes and underscores
 * dropped and its case ignored, so kebab, camel, snake, all-capitals and mixed spellings of one name compare equal (and
 * keep `--` in front). Coarser than any one reader, which only keeps more calls at 1.1.0.
 */
const loose = (word: string) => "--" + word.replace(/^-+/, "").replace(/[-_]/g, "").toLowerCase()
/**
 * `excluding` for a reader that folds option names (`loose`): each word and name is compared folded, and a name also
 * covers its sub-options (`--poolOptions.threads`).
 */
const camelExcluding =
  (exact: readonly string[], names: readonly string[]): AllowForm =>
  (args, ctx) => {
    const folded = names.map(loose)
    const exactFolded = exact.map((name) => loose(name).slice(2))
    return (
      excluding(exact, names)(args, ctx) &&
      !args.some((word) => {
        if (!word.startsWith("--")) return false
        const name = loose(optionName(word))
        return folded.some((option) => name === option || name.startsWith(option + ".")) || Risk.abbreviates(name, folded, exactFolded)
      })
    )
  }
/** 1.1.1 F10b (G3-2): a `swift test` or an xcodebuild test action that moves the build, cache or result folders. */
const SWIFT_TEST_CLEANS = ["--scratch-path", "--build-path", "--cache-path"]
const XCODE_TEST_CLEANS = ["-derivedDataPath", "-resultBundlePath", "-packageCachePath", "-clonedSourcePackagesDirPath", "-testProductsPath"]
const XCODE_ACTIONS = ["build", "test", "build-for-testing", "test-without-building", "analyze"]
const XCODE_EXCLUDED = ["clean", "archive", "install", "installsrc", "-exportArchive", "-exportNotarizedApp", "-importLocalizations", "-exportLocalizations", "-create-xcframework"]
const GRADLE_TASK = /^(:[\w-]+)*:?(build|test|check|assemble)$/
const GRADLE_OPTIONS = new Set(["--offline", "--info", "-i", "-q", "--quiet", "--stacktrace", "-s", "--no-daemon", "--daemon", "--parallel", "--continue", "--build-cache", "--no-build-cache", "--console", "--warning-mode"])
const MVN_PHASES = ["test", "package", "compile", "verify", "validate"]
const MVN_OPTIONS = new Set(["-q", "--quiet", "-B", "--batch-mode", "-o", "--offline", "-e", "--errors", "-X", "--debug", "-DskipTests", "-Dmaven.test.skip=true", "-am", "--also-make"])
const gradle: AllowForm = (args) => {
  const read = onlyOptions(args, GRADLE_OPTIONS, new Set(["-x", "--exclude-task"]))
  return read.ok && read.positional.length > 0 && read.positional.every((word) => GRADLE_TASK.test(word))
}
const mvn: AllowForm = (args) => {
  const read = onlyOptions(args, MVN_OPTIONS, new Set(["-T", "--threads", "-pl", "--projects"]))
  return read.ok && read.positional.length > 0 && read.positional.every((word) => MVN_PHASES.includes(word))
}
// 1.1.1 F17 (S7-4): xcodebuild documents no `--`, so it is not known to end its options there; a call with one keeps 1.1.0.
const xcodebuild: AllowForm = (args) =>
  !args.includes("--") &&
  args.some((word) => XCODE_ACTIONS.includes(word)) &&
  !args.some((word) => XCODE_EXCLUDED.includes(word) || (!isOption(word) && word.includes("="))) &&
  (!args.some((word) => ["test", "build-for-testing", "test-without-building"].includes(word)) || !args.some((word) => XCODE_TEST_CLEANS.some((name) => optionName(word).replace(/^--/, "-") === name)))
/** `python -m <module>` runs that module as its own program would: a step only when that program is one. */
const pythonModule: AllowForm = (args, ctx) => {
  if (args[0] !== "-m" || args[1] === undefined) return false
  if (args[1] === "pip") return pip(args.slice(2), ctx)
  return ["pytest", "mypy", "black", "ruff"].includes(args[1]) && ctx.step(args.slice(1))
}

// in-folder file utilities ------------------------------------------------------------------------------------------
const lettersIn = (allowed: string, long: readonly string[]): AllowForm => (args) =>
  args.filter(isOption).every((word) => (shortWord(word) ? [...word.slice(1)].every((letter) => allowed.includes(letter)) : long.includes(optionName(word))))
const FIND_ACTIONS = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]
/** `sed -n` whose every script only prints lines by number or match: no `w`, no `e`, no in-place. */
const sedPrints: AllowForm = (args) => {
  if (!args.some((word) => word === "-n" || word === "--quiet" || word === "--silent")) return false
  const scripts: string[] = []
  const rest: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "-n" || word === "--quiet" || word === "--silent" || word === "-E" || word === "-r") continue
    if (word === "-e") {
      scripts.push(args[++index] ?? "")
      continue
    }
    if (isOption(word)) return false
    rest.push(word)
  }
  if (scripts.length === 0 && rest.length > 0) scripts.push(rest.shift()!)
  const ADDRESS = String.raw`(\d+|\$|/[^/\\]*/)`
  const PRINT = new RegExp(String.raw`^(${ADDRESS}(,${ADDRESS})?)?p$`)
  return scripts.length > 0 && scripts.every((script) => script.split(";").every((part) => PRINT.test(part.trim())))
}

/**
 * 1.1.1 F10a (G3-3): the options of a listed tool that name a file or folder it writes (an output, a report, a log, a
 * cache, a build folder). The shell's own reading sees only redirects, so these are judged here as a redirect is: the
 * place must be one Undo's snapshot covers, or the call keeps its 1.1.0 verdict. `long` options are matched by name, and
 * also shortened for a tool whose parser takes them shortened (`shortens`: argparse, optparse, npm's); `caseless` where the
 * tool ignores case; `single` options are spelled with one dash or two and never shortened (Go's flags, xcodebuild's);
 * `short` letters take the rest of the word or the next one; `dotted` also takes a sub-option (`--name.sub=value`). A
 * list errs long: an option named here that writes nothing only keeps 1.1.0.
 */
type Outputs = {
  long?: readonly string[]
  single?: readonly string[]
  short?: string
  caseless?: boolean
  dotted?: boolean
  shortens?: boolean
  // 1.1.1 F14 (G4-4): names compared as a yargs-style reader folds them (`loose`).
  loose?: boolean
}
const PACKAGE_OUTPUTS = ["--cache", "--cache-dir", "--cache-folder", "--store-dir", "--virtual-store-dir", "--modules-folder", "--modules-dir", "--global-folder", "--lockfile-dir"]
const TSC_OUTPUTS: Outputs = {
  long: ["--outFile", "--outDir", "--out", "--declarationDir", "--tsBuildInfoFile", "--generateTrace", "--generateCpuProfile"],
  caseless: true,
}
export const OUTPUT_OPTIONS: Readonly<Record<string, Outputs>> = {
  go: { single: ["o", "coverprofile", "cpuprofile", "memprofile", "blockprofile", "mutexprofile", "trace", "outputdir", "pkgdir"] },
  bun: { long: ["--outfile", "--outdir", "--metafile", "--coverage-dir", "--reporter-outfile", ...PACKAGE_OUTPUTS] },
  npm: { long: PACKAGE_OUTPUTS, shortens: true },
  pnpm: { long: PACKAGE_OUTPUTS, shortens: true },
  yarn: { long: PACKAGE_OUTPUTS },
  tsc: TSC_OUTPUTS,
  tsgo: TSC_OUTPUTS,
  pytest: { long: ["--junitxml", "--junit-xml", "--resultlog", "--result-log", "--report-log", "--html", "--debug", "--basetemp", "--log-file"], shortens: true },
  ruff: { long: ["--output-file", "--cache-dir"], short: "o" },
  eslint: { long: ["--output-file", "--cache-location"], short: "o" },
  prettier: { long: ["--cache-location", "--log-file"] },
  biome: { long: ["--log-path", "--log-file", "--reporter-file"] },
  mypy: {
    long: [
      "--cache-dir", "--junit-xml", "--html-report", "--txt-report", "--xml-report", "--linecount-report", "--linecoverage-report",
      "--lineprecision-report", "--any-exprs-report", "--cobertura-xml-report", "--xslt-html-report", "--xslt-txt-report",
    ],
    shortens: true,
  },
  // 1.1.1 F15 (S6-4): with the folders and files vitest 4's option list says it writes (attachments, the HTML coverage
  // folder, the module cache, a benchmark's JSON, a test list written as JSON).
  vitest: {
    long: [
      "--outputFile", "--coverage.reportsDirectory", "--cache.dir", "--attachmentsDir", "--coverage.htmlDir",
      "--experimental.fsModuleCachePath", "--outputJson", "--json",
    ],
    dotted: true,
    loose: true,
  },
  jest: { long: ["--outputFile", "--coverageDirectory", "--cacheDirectory"], loose: true },
  cargo: { long: ["--target-dir", "--artifact-dir", "--out-dir", "--lockfile-path"] },
  swift: { long: ["--build-path", "--scratch-path", "--cache-path"] },
  xcodebuild: { single: ["derivedDataPath", "resultBundlePath", "archivePath", "exportPath", "clonedSourcePackagesDirPath", "packageCachePath"] },
  pip: { long: ["--log", "--log-file", "--report", "--cache-dir", "--src"], shortens: true },
  pip3: { long: ["--log", "--log-file", "--report", "--cache-dir", "--src"], shortens: true },
  uv: { long: ["--cache-dir"] },
}

/**
 * 1.1.1 F17 (S7-4): the programs whose option readers end their options at `--` (getopt, argparse, yargs, clap, Go's
 * flag package, swift's argument parser; tsc refuses the word). Only for these are the words past it read as files.
 * xcodebuild is not one: for it every word is read as an option word, and its allow form refuses a `--` anyway.
 */
export const SEPARATOR_ENDS_OPTIONS: ReadonlySet<string> = new Set([
  "go", "bun", "npm", "pnpm", "yarn", "pytest", "ruff", "eslint", "prettier", "biome", "mypy", "black", "vitest", "jest", "cargo",
  "swift", "pip", "pip3", "uv", "tsc", "tsgo",
])
export const endsOptionsAtSeparator = (program: string) => SEPARATOR_ENDS_OPTIONS.has(program)
/**
 * 1.1.1 F19 (n40): the programs of `OUTPUT_OPTIONS` and `CONFIG_OPTIONS` known to read options past a `--`. Every program
 * of those tables is in exactly one of this list and `SEPARATOR_ENDS_OPTIONS` (a test holds it), so a program added there
 * needs a deliberate choice. That yarn and bun stop at `--` rests on their documentation, not on a read of their sources.
 */
export const READS_PAST_SEPARATOR: readonly string[] = ["xcodebuild"]

/**
 * The places a step's own options say it writes, as written (relative to the step's folder). `undefined` when such an
 * option has no value to read, which keeps the call at its 1.1.0 verdict.
 */
export function outputTargets(program: string, args: readonly string[]): string[] | undefined {
  const outputs = Object.hasOwn(OUTPUT_OPTIONS, program) ? OUTPUT_OPTIONS[program]! : undefined
  if (!outputs) return []
  const found: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "--" && endsOptionsAtSeparator(program)) break
    if (!isOption(word) || word === "--") continue
    const joined = word.includes("=") ? word.slice(word.indexOf("=") + 1) : undefined
    const name = optionName(word)
    // 1.1.1 F12a (S4-4): kebab case and camelCase name the same option (vitest's and jest's readers fold one to the other;
    // for another tool a match only keeps 1.1.0).
    // 1.1.1 F14: tsc also takes a long option with one dash (`-outDir`); caseless names are compared with two.
    // (G4-4) a yargs-style reader's names are compared folded as it folds them.
    const fold = (text: string) =>
      outputs.loose ? loose(text) : outputs.caseless ? camel(text.replace(/^-+/, "--")).toLowerCase() : camel(text)
    const long =
      outputs.long !== undefined &&
      (outputs.long.some((option) => fold(option) === fold(name)) ||
        (outputs.shortens === true && Risk.abbreviates(word, outputs.long, [], outputs.caseless)) ||
        (outputs.dotted === true && outputs.long.some((option) => fold(name).startsWith(fold(option) + "."))))
    const single = outputs.single?.some((option) => name === `-${option}` || name === `--${option}`) === true
    // A short output letter anywhere in a word of short options takes the rest of that word, or the next word.
    const at = outputs.short !== undefined && shortWord(word) ? [...word.slice(1)].findIndex((letter) => outputs.short!.includes(letter)) : -1
    const short = at >= 0
    if (!long && !single && !short) continue
    const rest = short ? word.slice(2 + at) : ""
    const value = short ? (rest === "" ? undefined : rest.replace(/^=/, "")) : joined
    if (value !== undefined) {
      found.push(value)
      continue
    }
    const next = args[index + 1]
    if (next === undefined || isOption(next)) {
      // `--debug` alone writes its log under its own name in the step's folder.
      if (program === "pytest" && Risk.abbreviates(word, ["--debug"])) {
        found.push("pytestdebug.log")
        continue
      }
      return undefined
    }
    found.push(next)
    index++
  }
  return found
}

/**
 * 1.1.1 F10b (P19 item 3): the files and folders a formatter or linter rewrites in place, as written (relative to the
 * step's folder), or `PROJECT` for the whole project. Each must be one Undo's snapshot covers, judged as a redirect is, or
 * the call keeps its 1.1.0 verdict. Every word that is no option counts as a path (an option's value too: one that names
 * nothing only passes the check, one that names an ignored file keeps 1.1.0). With no path the tool works on its folder.
 * A run that only checks or prints its changes writes nothing. `undefined`: a target not understood, which keeps 1.1.0.
 */
export const PROJECT = "\0project"
export function inPlaceTargets(program: string, args: readonly string[]): string[] | undefined {
  // 1.1.1 F14 (G5-1): past a `--` every word is a path, one that starts with a dash included.
  const end = args.indexOf("--")
  const words = end < 0 ? args.filter((word) => !isOption(word)) : [...args.slice(0, end).filter((word) => !isOption(word)), ...args.slice(end + 1)]
  const or = (paths: readonly string[]) => (paths.length > 0 ? [...paths] : ["."])
  // Options are read before the `--` only: past it a word that looks like `--check` is a file the tool writes. 1.1.1 F19
  // (n40): for a tool not known to end its options there, an option past it that makes the tool write counts as well; one
  // that turns the write off is still read before it only, which only judges more targets.
  // n45: every program below that reads `turnsOn` is in `SEPARATOR_ENDS_OPTIONS` today, so `turnsOn` is `options` for all
  // of them; the other branch is the fail-safe default for a program added later without a separator entry.
  const options = end < 0 ? args : args.slice(0, end)
  const turnsOn = end < 0 || endsOptionsAtSeparator(program) ? options : args
  const has = (...names: string[]) => options.some((word) => names.includes(optionName(word)))
  const hasOn = (...names: string[]) => turnsOn.some((word) => names.includes(optionName(word)))
  // 1.1.1 F12a (S4-5): an option that makes the tool write is also seen inside a word of combined short options (`-lw`),
  // as the tool's reader splits it. Only for the options that write: one that turns the write off is read exactly.
  const writes = (...names: string[]) =>
    hasOn(...names) ||
    turnsOn.some((word) => shortWord(word) && !word.includes("=") && names.some((name) => /^-[^-]$/.test(name) && word.slice(1).includes(name[1]!)))
  // 1.1.1 F12a (m25): what `touch` and `mkdir` create or change is a target too, so a link to outside is judged.
  if (program === "touch" || program === "mkdir") return [...words]
  if (program === "prettier") return writes("--write", "-w") ? or(words) : []
  if (program === "eslint") return hasOn("--fix") ? or(words) : []
  if (program === "black") return has("--check", "--diff", "-c", "--code") ? [] : or(words)
  if (program === "ruff") {
    // `ruff check` may fix by its config (`fix = true`), so it is judged as a fix unless it says it does not.
    // With no subcommand ruff is `ruff check` (its older form, paths first).
    const sub = words[0]
    if (sub !== undefined && ["rule", "config", "linter", "version", "help", "analyze", "server"].includes(sub)) return []
    if (sub === "format") return has("--check", "--diff") ? [] : or(words.slice(1))
    if (has("--diff", "--no-fix")) return []
    return or(sub === "check" ? words.slice(1) : words)
  }
  if (program === "biome") {
    const sub = words[0]
    if (!hasOn("--write", "--apply", "--apply-unsafe", "--fix", "--unsafe")) return []
    return or(words.slice(sub !== undefined && ["check", "format", "lint", "migrate"].includes(sub) ? 1 : 0))
  }
  if (program === "go") {
    if (words[0] !== "fmt" || has("-n")) return []
    // Packages, as `go fmt` takes them: a folder in the module (`./x`, `./x/...`, `.`); an import path is not read here.
    const packages = words.slice(1).map((word) => (word === "./..." ? "." : word.replace(/\/\.\.\.$/, "")))
    return packages.every((word) => word === "." || word.startsWith("./")) ? or(packages) : undefined
  }
  if (program === "cargo") {
    // `cargo fmt` formats the whole package or workspace, whose root may sit above the step's folder.
    if (words[0] !== "fmt" || has("--check")) return []
    return [PROJECT]
  }
  return []
}

/**
 * 1.1.1 F14 (G4-2 variant): options that select the configuration or project file a compiler, linter, type checker or
 * test runner reads, or give configuration inline. Such a file or text can say where the tool writes, which the checks of
 * its own options do not see, so the call keeps its 1.1.0 verdict. The one exception is a value that names the tool's
 * own default config file (`defaults`, by its last part) when that name is a tool configuration whose edits are already
 * held (`Risk.toolConfig`). 1.1.1 F15 (S6-1, S6-2): and only when `isConfigFile` says the value is an existing regular
 * file that lands inside the project once links are followed (for tsc's `.`, its `tsconfig.json`); a value that reads as
 * inline settings never qualifies. `names` are compared without their dashes (tsc takes `-p`, `--p`, `-project`),
 * caseless where the tool is; `shortens`: an argparse reader that takes a long name shortened. Options the allowlist
 * itself already refuses (eslint's `-c`, prettier's `--config`, biome's `--config-path`) are not listed again (n26).
 */
type ConfigOptions = { names: readonly string[]; defaults?: readonly string[]; caseless?: boolean; shortens?: boolean }
export const CONFIG_OPTIONS: Readonly<Record<string, ConfigOptions>> = {
  tsc: { names: ["p", "project", "b", "build"], defaults: ["tsconfig.json", "."], caseless: true },
  tsgo: { names: ["p", "project", "b", "build"], defaults: ["tsconfig.json", "."], caseless: true },
  ruff: { names: ["config"], defaults: ["ruff.toml", ".ruff.toml"] },
  mypy: { names: ["config-file"], defaults: ["mypy.ini", ".mypy.ini"], shortens: true },
  black: { names: ["config"] },
  eslint: { names: ["rule", "parser-options", "env", "global"] },
  swift: { names: ["package-path", "toolset", "destination"] },
  xcodebuild: { names: ["project", "workspace", "xcconfig"] },
}
/** 1.1.1 F15 (S6-1): text that reads as settings rather than a file name (`key = value`, a comment, quotes, lines). */
const INLINE_CONFIG = /[=#"'\n\r]/
/**
 * Whether a step's own options select a config or project file, or give config inline (see `CONFIG_OPTIONS`). Options
 * are read up to a `--` only (n30): past it the words are the tool's files. 1.1.1 F17 (S7-4): only for a tool known to
 * end its options there (`endsOptionsAtSeparator`); for any other every word is read.
 */
export function selectsConfig(program: string, args: readonly string[], isConfigFile: (file: string) => boolean): boolean {
  const options = Object.hasOwn(CONFIG_OPTIONS, program) ? CONFIG_OPTIONS[program]! : undefined
  if (!options) return false
  const fold = (text: string) => (options.caseless ? text.toLowerCase() : text)
  const names = options.names.map(fold)
  // tsc reads options from a response file (`@args.txt`), which this cannot see.
  if ((program === "tsc" || program === "tsgo") && args.some((word) => word.startsWith("@"))) return true
  const words = args.indexOf("--") < 0 || !endsOptionsAtSeparator(program) ? args : args.slice(0, args.indexOf("--"))
  const named = (value: string | undefined) =>
    value !== undefined &&
    !value.startsWith("-") &&
    !INLINE_CONFIG.test(value) &&
    (options.defaults ?? []).includes(value === "." ? "." : path.posix.basename(value)) &&
    (value === "." || Risk.toolConfig(value)) &&
    isConfigFile(value === "." ? "tsconfig.json" : value)
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    if (!isOption(word)) continue
    const bare = fold(optionName(word).replace(/^-+/, ""))
    const hit =
      names.includes(bare) ||
      (options.shortens === true && word.startsWith("--") && bare.length > 0 && names.some((name) => name.startsWith(bare)))
    if (!hit) continue
    // tsc's build mode takes its projects as the words that follow: each must be the default one.
    if ((program === "tsc" || program === "tsgo") && (bare === "b" || bare === "build")) {
      const projects = words.slice(index + 1).filter((next) => !isOption(next))
      if (!projects.every((next) => named(next)) || words.some((next) => fold(next.replace(/^-+/, "")) === "clean")) return true
      continue
    }
    const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words[index + 1]
    if (!named(value)) return true
    if (!word.includes("=")) index++
  }
  return false
}

/**
 * The allowlist itself: program -> the forms of it that open under consent. Read with `Object.hasOwn`, so `constructor`
 * or `__proto__` name nothing. Kept-for-person and refused categories are settled before this is read.
 */
export const ALLOWLIST: Readonly<Record<string, AllowForm>> = {
  git,
  bun: packageManager("bun"),
  npm: packageManager("npm"),
  pnpm: packageManager("pnpm"),
  yarn: packageManager("yarn"),
  npx,
  bunx,
  pip,
  pip3: pip,
  uv,
  poetry,
  cargo,
  go,
  python: pythonModule,
  python3: pythonModule,
  tsc: () => true,
  tsgo: () => true,
  // `--rule` is an option of its own, not a shortening of `--rulesdir`.
  eslint: excluding(["rule"], ["-c", "--config", "--rulesdir", "--plugin", "--resolve-plugins-relative-to", "--parser", "-f", "--format", "--inspect-config"]),
  prettier: without("--plugin", "--plugin-search-dir", "--config"),
  biome: without("--config-path"),
  // 1.1.1 F10b (G3-2): `ruff clean` deletes every cache folder under the step's folder.
  ruff: (args) => args.find((word) => !isOption(word)) !== "clean",
  black: () => true,
  mypy: without("--python-executable"),
  pytest,
  // 1.1.1 F12a (S4-4): both readers fold kebab case to camelCase.
  vitest: camelExcluding(VITEST_EXACT, VITEST_CODE),
  // `--watch` is an option of its own, not a shortening of `--watchPlugins`.
  jest: camelExcluding(JEST_EXACT, JEST_CODE),
  swift: (args, ctx) => args[0] === "build" || (args[0] === "test" && without(...SWIFT_TEST_CLEANS)(args.slice(1), ctx)),
  xcodebuild,
  gradle,
  mvn,
  mkdir: lettersIn("pv", ["--parents", "--verbose"]),
  // 1.1.1 F10a (m21): no `cp` or `mv`. The wide deletion reader holds every one of them as a replace, so an entry here could
  // never open one, and would open every overwrite the day that reader changed.
  // 1.1.1 F10a (P5 A2d): stopping a process this session's own shell tool started, and nothing else.
  kill: (args, ctx) => ctx.ownKill(args),
  touch: lettersIn("acm", []),
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  sort: (args) => !args.some((word) => (shortWord(word) && shortLetters(word, "otTkS").includes("o")) || longIs(word, ["--output", "--compress-program", "--temporary-directory", "--files0-from"])),
  find: (args) => !args.some((word) => FIND_ACTIONS.includes(word)),
  grep: () => true,
  rg: without("--pre", "-z", "--search-zip"),
  sed: sedPrints,
  jq: () => true,
}

export * as BypassLists from "./bypass-lists"
