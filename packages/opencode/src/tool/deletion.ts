// U11 rule 4: how a deletion is read. The shell moves a plain deletion to the archive instead of running it, and the
// autonomy table answers class A `archived` only for one the shell moves, so both read a command's words with this file.
// Each finds the words its own way (the shell from its parse tree, the table from the text), and
// `test/permission/u11-single-source.test.ts` runs one list of commands through both. No permission imports, since the
// shell tool and the permission service both read it.
import path from "node:path"

export const DELETES = new Set(["rm", "rmdir", "unlink"])
/** Words that run the command after them, skipped to find the program. */
export const WRAPPERS = new Set([
  "sudo",
  "doas",
  "command",
  "builtin",
  "exec",
  "env",
  "nice",
  "nohup",
  "time",
  "xargs",
  "timeout",
])
export const RM_FLAGS = new Set(["r", "R", "f", "i", "I", "v", "d"])
export const RM_LONG = new Set(["--recursive", "--force", "--verbose", "--dir", "--interactive"])
export const GIT_RM_FLAGS = new Set(["-r", "-f", "-q", "--force", "--quiet", "--ignore-unmatch"])
// These leave the working copy as it is, so they run.
export const GIT_RM_KEEPS = new Set(["--cached", "-n", "--dry-run"])

/** A deletion the shell can move instead of run: which program, what it may remove, and the paths as written. */
export type Deletion = {
  name: "rm" | "rmdir" | "unlink" | "git rm"
  /** Directories with what is in them (`rm -r`, `git rm -r`). */
  recursive: boolean
  /** Empty directories (`rm -d`, `rmdir`). */
  dirs: boolean
  /** A path that is not there is no error (`rm -f`, `git rm --ignore-unmatch`). */
  force: boolean
  paths: string[]
}

/** 1.1.1 F41 (CR17-2): a command's words from its program on, past any leading `NAME=value` words. */
export function program(words: readonly string[]): readonly string[] {
  let at = 0
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) at++
  return at === 0 ? words : words.slice(at)
}

/**
 * Whether one command's words remove files. `base` turns a word into the program name it stands for; the shell passes its
 * own, which also takes the quotes off.
 */
export function deletes(given: readonly string[], base: (word: string) => string = path.posix.basename) {
  // 1.1.1 F41 (CR17-2): a step may start with `NAME=value` words (the shell's reading keeps them); the program is after them.
  const words = program(given)
  if (base(words[0] ?? "") === "git") {
    // The subcommand is the first word that is not an option, nor the value `-C` or `-c` takes.
    const sub = words
      .slice(1)
      .find((word, index, rest) => !word.startsWith("-") && !/^-[Cc]$/.test(rest[index - 1] ?? ""))
    return sub === "rm" && !words.some((word) => GIT_RM_KEEPS.has(word))
  }
  for (const word of words) {
    if (DELETES.has(base(word))) return true
    if (!WRAPPERS.has(base(word)) && !word.startsWith("-") && !word.includes("=")) return false
  }
  return false
}

/**
 * The flags and paths of a plain deletion, from the words after the program's name. Undefined for a flag this does not
 * know, for no path, and for `unlink` with other than one path: the shell refuses those as `compound`.
 */
export function deletionFlags(name: Deletion["name"], words: readonly string[]): Omit<Deletion, "name"> | undefined {
  const found = { recursive: false, dirs: name === "rmdir", force: false, paths: [] as string[] }
  let ended = false
  for (const word of words) {
    if (ended || !word.startsWith("-") || word === "-") {
      found.paths.push(word)
      continue
    }
    if (word === "--") {
      ended = true
      continue
    }
    if (name === "git rm") {
      if (!GIT_RM_FLAGS.has(word)) return
      if (word === "-r") found.recursive = true
      if (word === "--ignore-unmatch") found.force = true
      continue
    }
    if (name === "rm" && word.startsWith("--")) {
      if (!RM_LONG.has(word)) return
      if (word === "--recursive") found.recursive = true
      if (word === "--force") found.force = true
      if (word === "--dir") found.dirs = true
      continue
    }
    if (name === "rmdir" && (word === "-v" || word === "--verbose")) continue
    if (name !== "rm") return
    for (const letter of word.slice(1)) {
      if (!RM_FLAGS.has(letter)) return
      if (letter === "r" || letter === "R") found.recursive = true
      if (letter === "f") found.force = true
      if (letter === "d") found.dirs = true
    }
  }
  if (found.paths.length === 0 || (name === "unlink" && found.paths.length !== 1)) return
  return found
}

// 1.1.1 F1b (decision P10 H1/H2, P11): the wide reader. `deletes` and `WRAPPERS` above stay as the shell and U11 rule 4
// read a deletion; what follows is only for the consented bypass, which must see through every common launcher before it
// may open a call. It is wider on purpose: a launcher this does not know is a program to the overlay, which then keeps
// the call's 1.1.0 verdict when a risky program follows it.

/** Every shell family. Each runs a text (`-c`), a script file or what it reads on stdin, none of which is a word here. */
export const SHELLS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "mksh", "pdksh", "oksh", "ash", "yash", "posh", "fish", "csh", "tcsh", "rc", "es",
  "nu", "xonsh", "elvish", "pwsh", "powershell", "busybox", "toybox",
])
/** Programs that remove a file or empty one, other than the `rm` family `deletes` reads. */
export const DELETERS: ReadonlySet<string> = new Set([
  "rm", "rmdir", "unlink", "shred", "truncate", "rimraf", "del", "del-cli", "trash", "trash-put", "trash-rm", "gio", "srm",
  "wipe",
])
/** Programs that put a file where one may already be, so what was there is gone. */
export const REPLACERS: ReadonlySet<string> = new Set(["cp", "mv", "install", "ditto", "rsync", "dd"])

/**
 * How one launcher reads its own words before the program it runs. `values`: options that take the next word. `positional`:
 * leading words that are its own (a duration, a count, a folder), each skipped only while `positionalIf` matches when set.
 * `rest`: "code" when what follows is a shell text (joined), unless one of `programIf` was given. `codeFlags`: an option
 * whose value is a shell text. `unreadable`: an option that splits a text this cannot see. `subs`: a two-word launcher
 * (`npm exec`). `own`: first words with which the launcher runs nothing else (`rtk recall`).
 */
type Spec = {
  values?: readonly string[]
  positional?: number
  positionalIf?: RegExp
  assignments?: boolean
  rest?: "code"
  programIf?: readonly string[]
  codeFlags?: readonly string[]
  codeIf?: readonly string[]
  unreadable?: RegExp
  subs?: Readonly<Record<string, Spec>>
  own?: readonly string[]
  feeds?: boolean
}

const PACKAGE_RUNNER: Spec = { values: ["-p", "--package", "--cache", "--registry", "--userconfig", "--prefix"], codeFlags: ["-c", "--call"] }
const SUDO: Spec = { values: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--prompt", "--host", "--role", "--type", "--other-user", "--close-from"] }

/** Launchers: environment setters, priority, timeout, keep-awake, buffering and profiling wrappers, `rtk`, repeat and watch
 * runners, argument feeders, and the package runners that start a package's program. */
export const LAUNCHERS: Readonly<Record<string, Spec>> = {
  sudo: SUDO,
  doas: { values: ["-u", "-C"] },
  command: {},
  builtin: {},
  exec: { values: ["-a"] },
  nohup: {},
  setsid: {},
  time: { values: ["-f", "--format", "-o", "--output"] },
  env: { values: ["-u", "--unset", "-C", "--chdir"], assignments: true, unreadable: /^(-S|--split-string|-[^-]*S)/ },
  "cross-env": { assignments: true },
  "cross-env-shell": { assignments: true, rest: "code" },
  "env-cmd": { values: ["-f", "--file", "-e", "--environments", "-r", "--rc-file"] },
  dotenv: { values: ["-e", "-v", "-c", "-p"], positional: 1, positionalIf: /^run$/ },
  nice: { values: ["-n", "--adjustment"] },
  ionice: { values: ["-c", "--class", "-n", "--classdata", "-p", "-P", "-u", "--pid", "--pgid", "--uid"] },
  chrt: { positional: 1, positionalIf: /^\d+$/ },
  taskset: { positional: 1, positionalIf: /^(0x)?[0-9a-fA-F,-]+$/ },
  taskpolicy: { values: ["-c", "-d", "-g", "-t", "-l"] },
  cpulimit: { values: ["-l", "--limit", "-p", "--pid", "-e", "--exe"] },
  timeout: { values: ["-s", "--signal", "-k", "--kill-after"], positional: 1, positionalIf: /^\d+(\.\d+)?[smhd]?$/ },
  gtimeout: { values: ["-s", "--signal", "-k", "--kill-after"], positional: 1, positionalIf: /^\d+(\.\d+)?[smhd]?$/ },
  caffeinate: { values: ["-t", "-w"] },
  "systemd-inhibit": { values: ["--what", "--who", "--why", "--mode"] },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  unbuffer: {},
  perf: { positional: 1, positionalIf: /^(stat|record|trace|top|sched|mem|lock|kvm|c2c)$/, values: ["-e", "--event", "-o", "--output", "-p", "--pid", "-r", "--repeat", "-C", "--cpu", "-G", "-x", "-I", "-F", "-c"] },
  valgrind: {},
  strace: { values: ["-o", "-e", "-p", "-s", "-u", "-E", "-P", "-a", "-b", "-X", "-I"] },
  ltrace: { values: ["-o", "-e", "-p", "-s", "-u", "-n", "-a", "-A", "-D", "-l", "-L"] },
  dtruss: { values: ["-p", "-n", "-t"] },
  xcrun: { values: ["--sdk", "--toolchain"] },
  rtk: { own: ["recall", "hook", "gain", "init", "discover", "config", "help"] },
  repeat: { positional: 1, positionalIf: /^\d+$/ },
  watch: { values: ["-n", "--interval", "-q", "--equexit"], rest: "code", programIf: ["-x", "--exec"] },
  entr: { codeIf: ["-s"] },
  watchexec: { values: ["-e", "--exts", "-w", "--watch", "-i", "--ignore", "-f", "--filter", "-s", "--shell", "-d", "--delay", "--debounce", "--signal", "--stop-signal", "--stop-timeout", "--on-busy-update", "-E", "--env", "--workdir", "--project-origin"], rest: "code" },
  hyperfine: { values: ["-w", "--warmup", "-r", "--runs", "-m", "--min-runs", "-M", "--max-runs", "-n", "--command-name", "--export-json", "--export-markdown", "--export-csv", "-S", "--shell", "-u", "--time-unit"], codeFlags: ["-p", "--prepare", "-c", "--cleanup", "-s", "--setup", "--conclude"], rest: "code" },
  xargs: { values: ["-I", "-i", "-n", "-P", "-L", "-l", "-d", "-E", "-e", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"], feeds: true },
  parallel: { values: ["-j", "--jobs", "-S", "--sshlogin", "-a", "--arg-file", "--delay", "--timeout", "--joblog"], rest: "code", feeds: true },
  npx: PACKAGE_RUNNER,
  bunx: PACKAGE_RUNNER,
  pnpx: PACKAGE_RUNNER,
  uvx: { values: ["--from", "--with", "--with-requirements", "--python", "-p", "--index"] },
  npm: { subs: { exec: PACKAGE_RUNNER, x: PACKAGE_RUNNER } },
  pnpm: { subs: { exec: { values: ["--filter", "-F", "-C", "--dir"] }, dlx: PACKAGE_RUNNER } },
  yarn: { subs: { dlx: PACKAGE_RUNNER, exec: {} } },
  bun: { subs: { x: PACKAGE_RUNNER, exec: { rest: "code" } } },
  uv: { subs: { run: { values: ["--with", "--with-requirements", "--python", "-p", "--project", "--directory", "--package", "--extra", "--group", "--env-file", "--index"] } } },
  pipx: { subs: { run: { values: ["--spec", "--python", "--pip-args"] } } },
  poetry: { subs: { run: {} } },
  pdm: { subs: { run: { values: ["-p", "--project"] } } },
  hatch: { subs: { run: {} } },
  conda: { subs: { run: { values: ["-n", "--name", "-p", "--prefix", "--cwd"] } } },
  mamba: { subs: { run: { values: ["-n", "--name", "-p", "--prefix", "--cwd"] } } },
  micromamba: { subs: { run: { values: ["-n", "--name", "-p", "--prefix", "--cwd"] } } },
  direnv: { subs: { exec: { positional: 1 } } },
  dotenvx: { subs: { run: { values: ["-f", "--env-file", "-e", "--env"] } } },
  op: { subs: { run: { values: ["--env-file"] } } },
  mise: { subs: { exec: {}, x: {} } },
  asdf: { subs: { exec: {} } },
  "nix-shell": { codeFlags: ["--run", "--command"] },
  su: { codeFlags: ["-c", "--command"], values: ["-s", "--shell", "-g", "--group"] },
  // 1.2.7 row 47a (M1-04): zsh, the default shell, runs a text or the next command through these builtins too.
  // `noglob`, `nocorrect` and `-` are precommand modifiers. `emulate [-lLR] <mode> [flags] -c <text>` evaluates the text
  // (`-o name` takes a value; a `+o`/`+x` set or a run of flags holding `c` cannot be read word by word). `trap <text>
  // <signal>…` runs the text (on exit at the latest); the joined rest is read as the text, the signal names as its words.
  noglob: {},
  nocorrect: {},
  "-": {},
  emulate: {
    values: ["-o"],
    positional: 1,
    positionalIf: /^(zsh|sh|ksh|csh)$/,
    codeFlags: ["-c"],
    unreadable: /^(\+|-[A-Za-z]*c[A-Za-z]+$|-[A-Za-z]+c$)/,
  },
  trap: { rest: "code" },
}

/** What a step runs once its launchers are out of the way. */
export type Launched =
  | { kind: "none"; launchers: string[]; assignments: string[] }
  | { kind: "unreadable"; launchers: string[]; assignments: string[] }
  /** A launcher runs a shell text: watch, hyperfine, parallel, `npx -c`, `bun exec`, `su -c`. */
  | { kind: "code"; code: string; launchers: string[]; assignments: string[] }
  | { kind: "program"; name: string; spelled: string; args: string[]; launchers: string[]; assignments: string[]; fed: boolean }

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The program `argv` runs once `VAR=value` words and every launcher of `LAUNCHERS` are skipped, with their options. */
export function launched(argv: readonly string[], base: (word: string) => string = path.posix.basename): Launched {
  const launchers: string[] = []
  const assignments: string[] = []
  let fed = false
  let index = 0
  const code = (text: string | undefined): Launched =>
    text === undefined ? { kind: "unreadable", launchers, assignments } : { kind: "code", code: text, launchers, assignments }
  while (index < argv.length) {
    const word = argv[index]!
    if (ASSIGNMENT.test(word)) {
      assignments.push(word)
      index++
      continue
    }
    const name = base(word)
    let spec = Object.hasOwn(LAUNCHERS, name) ? LAUNCHERS[name] : undefined
    if (!spec) break
    if (spec.subs) {
      const sub = argv[index + 1]
      const inner = sub !== undefined && Object.hasOwn(spec.subs, sub) ? spec.subs[sub] : undefined
      if (!inner) break
      launchers.push(`${name} ${sub}`)
      index += 2
      spec = inner
    } else {
      if (spec.own?.includes(argv[index + 1] ?? "")) break
      launchers.push(name)
      index++
    }
    if (spec.feeds) fed = true
    const current = spec
    let program = false
    let shell = false
    let ended = false
    // Its options; undefined when they settle the step (an unreadable split, a text in an option's value).
    const options = (): Launched | undefined => {
      while (!ended && index < argv.length) {
        const next = argv[index]!
        if (current.assignments && ASSIGNMENT.test(next)) {
          assignments.push(next)
          index++
          continue
        }
        if (current.unreadable?.test(next)) return { kind: "unreadable", launchers, assignments }
        const option = next.split("=")[0]!
        if (current.codeFlags?.includes(option)) return code(next.includes("=") ? next.slice(option.length + 1) : argv[index + 1])
        if (current.programIf?.includes(option)) program = true
        if (current.codeIf?.includes(option)) shell = true
        if (next === "--") {
          index++
          ended = true
          break
        }
        if (!next.startsWith("-") || next === "-") break
        index += current.values?.includes(option) && !next.includes("=") ? 2 : 1
      }
      return undefined
    }
    const before = options()
    if (before) return before
    // A launcher's own words (`timeout 5`, `perf stat`), then any options after them (`perf stat -e x`).
    let skipped = 0
    while (!ended && skipped < (current.positional ?? 0) && index < argv.length) {
      if (current.positionalIf && !current.positionalIf.test(argv[index]!)) break
      index++
      skipped++
    }
    if (skipped > 0) {
      const after = options()
      if (after) return after
    }
    if ((current.rest === "code" && !program) || shell) return code(argv.slice(index).join(" "))
  }
  const spelled = argv[index]
  if (spelled === undefined) return { kind: "none", launchers, assignments }
  return { kind: "program", name: base(spelled), spelled, args: argv.slice(index + 1), launchers, assignments, fed }
}

/** The text a shell runs with `-c` (`bash -lc 'x'`, `fish --command=x`), or undefined when it runs a file or stdin. */
export function shellText(name: string, args: readonly string[]): string | undefined {
  for (const [index, word] of args.entries()) {
    if (word === "--") return undefined
    if (/^--?(command|Command|c)=/.test(word)) return word.slice(word.indexOf("=") + 1)
    if (word === "--command" || word === "-Command" || word === "-command") return args[index + 1] ?? ""
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word) && !(name === "pwsh" || name === "powershell")) {
      // The text is the first word after the options, whatever other letters joined the `c`.
      return args.slice(index + 1).find((next) => !next.startsWith("-")) ?? ""
    }
    if (!word.startsWith("-")) return undefined
  }
  return undefined
}

/**
 * The wide check the consented bypass uses: true when `argv` removes, empties or replaces a file, through any launcher,
 * shell text, `find -exec` or feeder, and true when it cannot tell (a launcher text it cannot see, a shell running a file
 * or stdin). `split` is how a text becomes commands; the caller passes the one its own reader uses.
 */
export function deletesOrReplacesWide(
  argv: readonly string[],
  split: (text: string) => string[][],
  base: (word: string) => string = path.posix.basename,
  depth = 0,
): boolean {
  if (depth > 4) return true
  if (deletes(argv, base)) return true
  const found = launched(argv, base)
  if (found.kind === "none") return false
  if (found.kind === "unreadable") return true
  const inText = (text: string) => split(text).some((words) => deletesOrReplacesWide(words, split, base, depth + 1))
  if (found.kind === "code") return inText(found.code)
  const { name, args } = found
  if (deletes([found.spelled, ...args], base)) return true
  if (DELETERS.has(name) || REPLACERS.has(name)) return true
  if (name === "ln") return args.some((word) => /^-[A-Za-z]*f/.test(word) || word === "--force")
  if (SHELLS.has(name)) {
    const text = shellText(name, args)
    return text === undefined ? true : inText(text)
  }
  if (name === "git") {
    const sub = args.find((word, index) => !word.startsWith("-") && !/^-[Cc]$/.test(args[index - 1] ?? ""))
    if (sub === "clean") return true
  }
  if (name === "find") {
    if (args.includes("-delete")) return true
    return args.some((word, index) => {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(word)) return false
      const end = args.findIndex((next, at) => at > index && (next === ";" || next === "+"))
      return deletesOrReplacesWide(args.slice(index + 1, end < 0 ? undefined : end), split, base, depth + 1)
    })
  }
  return false
}

export * as DeletionWords from "./deletion"
