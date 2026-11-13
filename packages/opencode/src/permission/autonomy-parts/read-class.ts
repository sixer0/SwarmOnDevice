// Part of the autonomy table (R-1, 1.2.8): Read looks (`READS`, sed/grep/awk/git reads) and the read-role shell class.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import fs from "node:fs"
import path from "node:path"
import { BypassLists } from "../bypass-lists"
import type { InstanceContext } from "../../project/instance-context"
import { GitGuard } from "../../tool/git-guard"
import { Reach } from "../../tool/reach"
import { Risk } from "../../tool/risk"
import type { CommandKind } from "./types"
import { BRANCH, COMMIT, FILE_OPS, INSTALLS, OUTPUT_TAIL, canRunIn, fileOp, gitAllowed, lockfileUnchanged, matchesCheck, noRepositoryBetween, safePath } from "./routine"
import { SED_ADDR, cdTarget, homeCdWords, lookWords, probe, programInProject } from "./shell-steps"
import { CHECKSUMS, nearLibrary } from "./outside"
// Programs that only look. Each lists what would make it do more: run a program (`find -exec`, `rg --pre`, `rg -z`), write
// (`find -delete`, `find -fprint`, `tree -o`, `tree -R`, `file -C`), wait for good (`tail -f`), read names from a file
// (`wc --files0-from`), or reach past what the shell named (`grep -r`, `rg --hidden`, `rg -u`, `rg -L`). Every other word
// must be a path inside the folder that the read tool would show without asking.
//
// Row 274 adds the programs the inventory of 88,388 recorded agent commands found looking
// (`research/20_shell_command_inventory.md`), each with what would make it write: `sort -o`, `uniq` and `xxd` with a second
// name (their output file), `diff --output`, and `du`/`df` reading only. `maxPaths` caps the names a program takes as input.
// 1.2.8 row 27 (H-U7, N8-392): a program may instead name the only options it takes (`only`: flags, `values`: options that
// take the next word or the rest of their word), and say that its other words are patterns, not paths (`patterns`).
type LookRules = {
  short?: string
  long?: readonly string[]
  exact?: readonly string[]
  maxPaths?: number
  only?: string
  values?: string
  patterns?: boolean
}
export const READS = new Map<string, LookRules>([
  ["ls", {}],
  ["cat", {}],
  ["head", {}],
  ["tail", { short: "fF", long: ["--follow", "--retry"] }],
  ["wc", { long: ["--files0-from"] }],
  ["stat", {}],
  // 1.2.7 row 47a (M1-01): `-z`/`-Z` decompress, which libmagic may hand to an outside program (gzip, xz, zstd …).
  ["file", { short: "CzZ", long: ["--compile", "--uncompress", "--uncompress-noreport"] }],
  ["pwd", {}],
  ["tree", { short: "oR", long: ["--output", "--fromfile"] }],
  // 1.2.7 row 47a (M1-01): `--hostname-bin=<program>` runs that program (ripgrep 13+), as `--pre` and `-z` do.
  ["rg", { short: "uLz.", long: ["--pre", "--pre-glob", "--hostname-bin", "--hidden", "--no-ignore", "--follow", "--search-zip", "--unrestricted"] }],
  ["grep", { short: "rRdD", long: ["--recursive", "--dereference-recursive", "--directories", "--devices"] }],
  ["egrep", { short: "rRdD", long: ["--recursive", "--dereference-recursive", "--directories", "--devices"] }],
  ["find", { exact: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"] }],
  ["sort", { short: "oT", long: ["--output", "--temporary-directory", "--compress-program", "--files0-from"] }],
  ["uniq", { maxPaths: 1 }],
  ["cut", {}],
  ["tr", {}],
  // 1.2.7 row 47a (M1-01): `-l`/`--paginate` pipes the output through `pr`, a program diff starts.
  ["diff", { short: "l", long: ["--output", "--to-file", "--from-file", "--paginate"] }],
  ["cmp", {}],
  ["comm", {}],
  ["paste", {}],
  ["column", {}],
  ["nl", {}],
  ["rev", {}],
  ["fold", {}],
  ["fmt", {}],
  ["od", {}],
  ["xxd", { short: "r", long: ["--revert"], maxPaths: 1 }],
  ["hexdump", {}],
  ["strings", {}],
  ["du", {}],
  ["df", {}],
  ["basename", {}],
  ["dirname", {}],
  ["realpath", {}],
  ["readlink", {}],
  ["which", {}],
  ["shasum", {}],
  ["sha256sum", {}],
  ["sha1sum", {}],
  ["md5", {}],
  ["md5sum", {}],
  ["cksum", {}],
  // Not `jq`: `env` and `$ENV` print the environment, keys and tokens included, into what the agent reads.
  ["test", {}],
  // 1.2.8 row 27 (H-U7, D-H5): `pgrep` lists processes by name and signals none. Only these options: `-l -f -a -i -x -n -o
  // -q` and, with a value, `-u -U -g -G -P -t -d`; its other words are name patterns. `-F` (a pid file), `-L`, `-v`, long
  // options and every other option keep the verdict they had; `pkill` and `kill` are not looks.
  ["pgrep", { only: "lfaixnoq", values: "uUgGPtd", patterns: true }],
])

/** 1.2.8 row 27 (H-U7): whether every option is one `rules.only`/`rules.values` lists, each value present. */
function onlyListed(args: readonly string[], rules: LookRules) {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (!word.startsWith("-")) continue
    if (!/^-[A-Za-z]/.test(word)) return false
    for (let at = 1; at < word.length; at++) {
      const letter = word[at]!
      if (rules.values?.includes(letter)) {
        // The value is the rest of the word (`-u501`) or the next word (`-u 501`).
        if (at + 1 === word.length && args[++index] === undefined) return false
        break
      }
      if (!rules.only?.includes(letter)) return false
    }
  }
  return true
}

/** The words a look names as places: none for a program whose operands are patterns (`READS` `patterns`). */
function namedPaths(words: readonly string[]) {
  const rules = READS.get(words[0]!)
  if (rules?.patterns) return []
  return words.slice(1).filter((word) => !word.startsWith("-"))
}
// Row 274: a short flag may carry its value (`cut -c1-80`, `sort -k1,1`, `head -n+5`) and a long one `=value`
// (`grep --include=*.ts`). A refused long name is matched with its value too, so `sort --output=f` is still a write.
// A space is a value only as `cut -d' '` writes it: one letter, then that one space.
const READ_FLAG = /^-[A-Za-z0-9@][A-Za-z0-9@,.:+-]*$|^-[A-Za-z] $|^--[a-z][a-z0-9-]*(=\S*)?$/

/** Whether no flag makes this program do more than look at what the command names. */
export function onlyLooks(words: readonly string[]) {
  const rules = READS.get(words[0]!)
  if (!rules) return false
  if (rules.only !== undefined) return onlyListed(words.slice(1), rules)
  return words.slice(1).every(
    (word) =>
      !word.startsWith("-") ||
      (READ_FLAG.test(word) &&
        !rules.exact?.includes(word) &&
        !rules.long?.some((name) => word === name || word.startsWith(name + "-") || word.startsWith(name + "=")) &&
        // 1.1.1 F10a (G3-1): these programs take a long option by any shortening of it, so a shortening is that option.
        !Risk.abbreviates(word, rules.long ?? []) &&
        (rules.exact !== undefined || word.startsWith("--") || ![...word.slice(1)].some((flag) => rules.short?.includes(flag)))),
  )
}

/** "read", "outside" when a path it names is beyond the folder, or undefined when it is not only a look. */
export function readKind(words: readonly string[], cwd: string, instance: InstanceContext): "read" | "outside" | undefined {
  if (!onlyLooks(words)) return undefined
  const named = namedPaths(words)
  const cap = READS.get(words[0]!)?.maxPaths
  if (cap !== undefined && named.length > cap) return undefined
  for (const word of named) {
    // A pattern or a count is judged as a path too. It lands inside, or the command is held: never the other way round.
    const file = path.resolve(cwd, word)
    if (!Reach.inside(file, instance)) return "outside"
    if (!Reach.readable(file)) return undefined
  }
  return "read"
}

// `rtk <cmd>` runs `<cmd>` and shortens what it prints, so it is judged as `<cmd>`.
export const unwrapped = (piece: string) => (piece.startsWith("rtk ") ? piece.slice(4) : piece)

/**
 * C97 F1: a look with quoted arguments (`cat "a b.md"`, `find d -name '*.ts'`), as the program will get them. Only a look:
 * each of its words is judged again as a flag or as a path, so a quote changes nothing about what is let through.
 */
function quotedLook(piece: string) {
  const words = Risk.quotedWords(piece)
  return words && (READS.has(words[0]!) || QUOTED_LOOKS.has(words[0]!)) ? words : undefined
}

// Row 274: the other programs `single` judges word by word, whose quoted words (`echo "== a =="`, `awk '{print $1}'`,
// `git log --format='%h %s'`) reach them as they are.
const QUOTED_LOOKS = new Set(["echo", "printf", "sleep", "date", "sed", "awk", "git"])

export function single(piece: string, cwd: string, instance: InstanceContext): CommandKind | undefined {
  piece = unwrapped(piece)
  if (COMMIT.test(piece) || (BRANCH.test(piece) && !piece.includes(".."))) return gitAllowed(cwd, instance) ? "git-local" : undefined
  const words = Risk.plainWords(piece) ?? quotedLook(piece)
  if (!words) return undefined
  if (FILE_OPS.has(words[0]!)) return fileOp(words, cwd, instance) ? "file-op" : undefined
  if (words[0] === "git" && words[1] === "add") {
    const rest = words.slice(2)
    const named = rest.length === 1 && rest[0] === "-A" ? true : rest.length > 0 && rest.every((word) => safePath(word, cwd, instance))
    return named && gitAllowed(cwd, instance) ? "git-local" : undefined
  }
  if ((words[0] === "grep" || words[0] === "egrep") && words.some(recursiveFlag)) return grepTree(words, cwd, instance) ? "read" : undefined
  if (readKind(words, cwd, instance) === "read") return "read"
  if (words[0] === "sed") return sedPrints(words, cwd, instance) ? "read" : undefined
  if (words[0] === "awk") return awkReads(words, cwd, instance) ? "read" : undefined
  if (words[0] === "git") return gitReads(words, cwd, instance) ? "read" : undefined
  if (printsOnly(words)) return "read"
  const lockfiles = INSTALLS.get(piece)
  if (lockfiles) return lockfileUnchanged(lockfiles, cwd, instance) ? "check" : undefined
  return matchesCheck(words, cwd, instance) ? "check" : undefined
}

// Row 273: `sed -n` with one line or one range to print, `$` for the last. No other sed command reaches here: `w` writes,
// `e` runs a program, and `-i`, `-e`, `-f` are flags, which the file list below never takes.
const SED_PRINT = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/

/** `sed -n <range>p <file>...`, printing lines of files the read tool would show without asking. */
function sedPrints(words: readonly string[], cwd: string, instance: InstanceContext) {
  const files = words.slice(3)
  // Row 276: a `/regex/` address too (`sed -n '/^## 8\./,/^## 9\./p'`): it only picks the lines, and `p` prints them.
  const script = words[2] ?? ""
  const printsRange = SED_PRINT.test(script) || new RegExp(String.raw`^${SED_ADDR}(?:,${SED_ADDR})?p$`).test(script)
  if (words[1] !== "-n" || !printsRange || files.length === 0) return false
  return !files.some((word) => word.startsWith("-")) && readKind(["cat", ...files], cwd, instance) === "read"
}

// Row 276: `grep -r` reads every file under what it names, so it is a look only where that tree holds nothing the read
// tool would not show. Either every `--include` names a kind of source or text file, which no secret is, or a bounded walk
// of the tree, skipping what `--exclude-dir` skips, finds no secret, no link and no more than MAX_TREE entries.
const recursiveFlag = (word: string) => /^-[A-Za-z]*r[A-Za-z]*$/.test(word) || word === "--recursive"
const TEXT_KINDS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "md", "mdx", "sql", "py", "go", "rs", "css", "scss", "html", "vue", "svelte", "txt", "rb", "java", "kt", "swift", "c", "h", "cpp", "hpp"])
const MAX_TREE = 5000

function grepTree(words: readonly string[], cwd: string, instance: InstanceContext) {
  const includes: string[] = []
  const skipped: string[] = []
  const named: string[] = []
  const args = words.slice(1)
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    // Context and count flags take the next word as a number; `-e` takes it as the pattern.
    if (/^-[ABCm]$/.test(word) && /^\d+$/.test(args[index + 1] ?? "")) index++
    else if (word === "-e" && args[index + 1] !== undefined) named.unshift(args[++index]!)
    else if (word.startsWith("--include=")) includes.push(word.slice(10))
    else if (word.startsWith("--exclude-dir=")) skipped.push(word.slice(14))
    else if (word.startsWith("--exclude=")) continue
    else if (word === "--recursive") continue
    // Short flags only, none that follows links (`R`), reads patterns from a file (`f`), or changes how folders and
    // devices are read (`d`, `D`).
    else if (word.startsWith("-")) {
      if (!/^-[A-Za-z]+$/.test(word) || /[RfdD]/.test(word.slice(1))) return false
    } else named.push(word)
  }
  const [, ...targets] = named
  const roots = (targets.length > 0 ? targets : ["."]).map((word) => path.resolve(cwd, word))
  if (!roots.every((root) => Reach.inside(root, instance) && Reach.readable(root))) return false
  if (includes.length > 0 && includes.every((glob) => /^\*\.([a-z0-9]+)$/.test(glob) && TEXT_KINDS.has(glob.slice(2)))) return true
  // `.git`, hooks and the like are sensitive, as a plain `cat .git/config` is: a token can sit in a remote's address.
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  let seen = 0
  const clean = (folder: string): boolean => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (++seen > MAX_TREE) return false
      if (entry.isDirectory() && skipped.includes(entry.name)) continue
      const file = path.join(folder, entry.name)
      if (entry.isSymbolicLink() || !Reach.readable(file) || Reach.sensitive(file, base)) return false
      if (entry.isDirectory() && !clean(file)) return false
    }
    return true
  }
  try {
    return roots.every((root) => (fs.statSync(root).isDirectory() ? clean(root) : true))
  } catch {
    return false
  }
}

// Row 274: programs whose arguments name no file. They print, wait or answer, and nothing more.
const PRINTS = new Set(["echo", "printf", "true", "false", ":"])

export function printsOnly(words: readonly string[]) {
  const [name, ...args] = words
  if (PRINTS.has(name!)) return name === "echo" || name === "printf" || args.length === 0
  if (name === "sleep") return args.length > 0 && args.every((word) => /^\d+(\.\d+)?[smhd]?$/.test(word))
  // `date` prints; `-s` and a bare operand set the clock, `-f` reads a file of dates.
  if (name === "date") return args.every((word) => /^\+/.test(word) || /^-[ujR]+$/.test(word) || /^-I\w*$/.test(word) || /^-v[+-]?\d+[ymwdHMS]$/.test(word))
  return false
}

// Row 274: what awk can do besides read and print to the output. `system`, a pipe and `getline` from a command run a
// program; `print > f` and `printf > f` write; `close` and `fflush` act on those. A comparison such as `$3 > 5` outside a
// print is a comparison. Erring on a print that only compares holds it, which is the safe way to be wrong. `ENVIRON`
// reads the environment, keys and tokens included.
const AWK_ACTS = /\b(system|getline|close|fflush|ENVIRON)\b|\||\bprintf?\b[^;{}\n]*>/

/** `awk [-F x] [-v a=b] '<program>' [a=b] [file...]` whose program only reads and prints, over files the read tool shows. */
function awkReads(words: readonly string[], cwd: string, instance: InstanceContext) {
  const files: string[] = []
  let program: string | undefined
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!
    if (program === undefined && word.startsWith("-")) {
      if (word === "-F" || word === "-v") index++
      else if (!/^-F.+$/.test(word) && !/^-v[A-Za-z_]\w*=/.test(word)) return false
      continue
    }
    if (program === undefined) program = word
    else if (!/^[A-Za-z_]\w*=/.test(word)) files.push(word)
  }
  if (program === undefined || AWK_ACTS.test(program)) return false
  return files.length === 0 || readKind(["cat", ...files], cwd, instance) === "read"
}

// Row 274: git commands that only show the repository. Each is judged in a repository the guard vetted, with nothing
// between it and the folder (`gitAllowed`), so no config there can make git run a program. `-c`, `-C`, `--git-dir`,
// `--work-tree` and `--exec-path` before the command change which repository or program that is; `--output` writes,
// `--ext-diff` and `--open-files-in-pager`/`-O` run a program, `--no-index` reads beyond the repository.
const GIT_READS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file", "rev-list", "for-each-ref", "merge-base",
  "check-ignore", "grep", "blame", "describe", "shortlog", "diff-tree", "name-rev", "count-objects", "reflog",
])
// Commands that also make or change things, and the flags with which they only list. `stash` and `worktree` list only
// after the word `list`.
const GIT_LISTS: Readonly<Record<string, RegExp>> = {
  branch: /^(-a|-r|-v|-vv|--list|--show-current|--all|--remotes|--verbose|--no-color|--contains|--merged|--no-merged)$/,
  tag: /^(-l|--list|-n\d*|--sort=[\w:-]+|--contains|--points-at)$/,
  remote: /^(-v|--verbose)$/,
  stash: /^--oneline$/,
  worktree: /^--porcelain$/,
}
const GIT_ACTS = /^(--output(=.*)?|--ext-diff|--open-files-in-pager(=.*)?|-O.*|--no-index|--exec(=.*)?|--textconv)$/
// 1.1.1 F10a (G3-1): the same options by name, as git also takes them shortened (one list, in `bypass-lists.ts`).
const gitActs = (word: string) => GIT_ACTS.test(word) || Risk.abbreviates(word, BypassLists.GIT_ACT_NAMES, BypassLists.GIT_ACT_EXACT)
// 1.2.7 row 47a (M1-12): options with which a look starts a program the user's own (unvetted, OP-6) git config names:
// `cat-file --filters` runs the smudge and textconv drivers, `--show-signature` and the signature placeholders of a format
// (`%G?`, `%GS`, `%(signature)`) run `gpg.program`. git takes `cat-file`'s long options shortened too.
const GIT_RUNS_NAMES: readonly string[] = ["--filters", "--show-signature"]
const GIT_SIGNATURE_FORMAT = /%G|%\(signature/
const gitRuns = (word: string) => Risk.abbreviates(word, GIT_RUNS_NAMES) || GIT_SIGNATURE_FORMAT.test(word)
// The one word after these flags is a revision, not a name to make.
const GIT_REV_FLAG = /^--(contains|merged|no-merged|points-at)$/

function gitReads(words: readonly string[], cwd: string, instance: InstanceContext) {
  // Row 276: `git -C <folder> <look>` is the same look run in that folder, which must be one a command may run in.
  const moved = words[1] === "-C" && words[2] !== undefined
  const here = moved ? path.resolve(cwd, words[2]!) : cwd
  const [sub, ...args] = words.slice(moved ? 3 : 1)
  if (moved && !canRunIn(here, instance)) return false
  return sub !== undefined && gitLook(sub, args) && (gitAllowed(here, instance) || nestedGitAllowed(here, instance))
}

/**
 * Row 276: a look may also run in a repository nested in the folder (a project opened one level up, as `Research` holds
 * `alugra`), when the guard vets that repository itself and nothing lies between it and where git runs. Only for looks;
 * local git that writes keeps to the project's own repository.
 */
function nestedGitAllowed(cwd: string, instance: InstanceContext) {
  const folder = Reach.real(cwd)
  if (folder === undefined || !Reach.inside(folder, instance)) return false
  let top = folder
  while (!fs.lstatSync(path.join(top, ".git"), { throwIfNoEntry: false })) {
    const parent = path.dirname(top)
    if (parent === top || !Reach.inside(parent, instance)) return false
    top = parent
  }
  return GitGuard.inspect(top).refused === undefined && noRepositoryBetween(folder, top)
}

function gitLook(sub: string, args: readonly string[]) {
  if (args.some(gitActs) || args.some(gitRuns)) return false
  if (GIT_READS.has(sub)) return true
  const flags = GIT_LISTS[sub]
  if (!flags) return false
  if (sub === "stash" || sub === "worktree") return args[0] === "list" && args.slice(1).every((word) => flags.test(word))
  // `git branch x`, `git tag x` and `git remote add` make or change one.
  return args.every((word, index) => flags.test(word) || (!word.startsWith("-") && GIT_REV_FLAG.test(args[index - 1] ?? "")))
}

// Row 273: a piece may drop its own error output, and nothing else: only stderr, only into /dev/null, only at its end.
export const DROP_ERRORS = / 2>\/dev\/null$/

// 1.2.7 U4 + N-1 (K7-05, SR §3.2 "U4 read class" and OP-2): the read and diagnostic shell class. One source for the read
// roles (`planner`, `data-collector`) and for looks at Swarm's own state, so the two cannot drift. It is the 1.2.6 look
// grammar (`protectedLook`, `probe`, `gitReads`) plus the additions below, and nothing else: no second list (SR7-20).

/** N7-115: the programs of the read class. Each still has to pass its own argument rules (`readClassPaths`). */
export const READ_SHELL_COMMANDS: ReadonlySet<string> = new Set([...READS.keys(), "git", "mdls", "pdftotext", "unzip", "graft"])

/**
 * N7-130: the roles whose shell runs only the read class, in every mode. The role check refuses anything else with
 * `ROLE_SHELL_OUTSIDE_READ_TEXT` (N7-054) ahead of a person's "always", a task grant or user config. Defined here, where
 * the permission check can import it, and re-exported from `agent/agent.ts`.
 */
export const READ_SHELL_ROLES: ReadonlySet<string> = new Set(["planner", "data-collector"])
// A run of short flags (`-bc`), which has the letter when any of them is it.
const shortHas = (word: string, letter: string) => /^-[A-Za-z0-9]+$/.test(word) && word.slice(1).includes(letter)

/**
 * SR7-06: what the read class refuses beyond the 1.2.6 rules. `file -f` and a checksum's `-c` read names from a file, which
 * reaches past what the command named. The root's U12 looks keep 1.2.6 (`READS`), so this is checked only here.
 */
function readClassRefuses(words: readonly string[]) {
  const [program, ...args] = words
  if (program === "file") return args.some((word) => shortHas(word, "f") || Risk.abbreviates(word, ["--files-from"]))
  if (CHECKSUMS.has(program!)) return args.some((word) => shortHas(word, "c") || Risk.abbreviates(word, ["--check"]))
  return false
}

/** SR §3.2 `mdls`: `-name`/`-attr`/`-n <attr>`, `-raw`/`-r`, `-nullMarker`/`-m <s>`, `-s`/`-sdb`, and one path or more. Never `-plist`. */
function mdlsPaths(args: readonly string[]) {
  const paths: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (["-name", "-attr", "-n", "-nullMarker", "-m"].includes(word)) {
      if (args[index + 1] === undefined) return undefined
      index++
      continue
    }
    if (["-raw", "-r", "-s", "-sdb"].includes(word)) continue
    if (word.startsWith("-")) return undefined
    paths.push(word)
  }
  return paths.length > 0 ? paths : undefined
}

/** SR §3.2 `pdftotext`: the last word is exactly `-` (stdout), one input path before it, and only the listed flags. */
function pdftotextPaths(args: readonly string[]) {
  if (args.at(-1) !== "-") return undefined
  const rest = args.slice(0, -1)
  const paths: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]!
    const value = rest[index + 1]
    if (word === "-f" || word === "-l") {
      if (value === undefined || !/^\d+$/.test(value)) return undefined
      index++
      continue
    }
    if (word === "-enc") {
      if (value === undefined || !/^[A-Za-z0-9-]+$/.test(value)) return undefined
      index++
      continue
    }
    if (word === "-eol") {
      if (value !== "unix" && value !== "dos" && value !== "mac") return undefined
      index++
      continue
    }
    if (["-layout", "-raw", "-nopgbrk", "-q"].includes(word)) continue
    if (word.startsWith("-")) return undefined
    paths.push(word)
  }
  return paths.length === 1 ? paths : undefined
}

/** SR §3.2 `unzip`: exactly `unzip -l <archive> [member …]`; no combined flag (`-lo`), no `-` archive, no wildcard in it. */
function unzipPaths(args: readonly string[]) {
  const [flag, archive, ...members] = args
  if (flag !== "-l" || archive === undefined || archive.startsWith("-") || /[*?[]/.test(archive)) return undefined
  if (members.some((word) => word.startsWith("-"))) return undefined
  return [archive]
}

/**
 * 1.2.7 row 47a (M1-11): per query sub-command, exactly the options its `--help` lists that only shape the answer (graft
 * 0.x): `flags` take no value, `values` take one word (or `--long=value`) that must match its rule, and `positionals` caps
 * the bare words (`<query>`/`<symbol>`/`<file>` and `[dir]`). Not allowed: `blast --name` (an LLM call), `--pr-author` (a
 * GitHub lookup), `--export-viz`/`--title` (a written page), `-h`, and any option graft adds later.
 */
type GraftRule = { flags: readonly string[]; values: Readonly<Record<string, RegExp>>; positionals: number }
const GRAFT_COUNT = /^\d{1,4}$/
const GRAFT_PREFIX = /^[\w./@-]+$/
const GRAFT_DEPTH = /^(\d{1,3}|all)$/
const GRAFT_QUERIES: Readonly<Record<string, GraftRule>> = {
  ask: {
    flags: ["--source", "--full", "--json", "--no-graph-rank", "--no-refresh"],
    values: { "-n": GRAFT_COUNT, "--limit": GRAFT_COUNT, "--in": GRAFT_PREFIX },
    positionals: 2,
  },
  map: { flags: ["--json", "--no-refresh"], values: { "--max-dirs": GRAFT_COUNT }, positionals: 1 },
  skeleton: { flags: ["--json", "--no-refresh"], values: {}, positionals: 2 },
  callers: {
    flags: ["--json", "--no-refresh"],
    values: { "--direction": /^(in|out)$/, "-d": GRAFT_DEPTH, "--depth": GRAFT_DEPTH, "--in": GRAFT_PREFIX },
    positionals: 2,
  },
  grep: { flags: ["-i", "--ignore-case", "--fixed", "--json", "--no-refresh"], values: { "--in": GRAFT_PREFIX }, positionals: 2 },
  blast: {
    flags: ["--no-owners", "--no-refresh"],
    values: { "--base": /^[\w./^~@{}-]+$/, "-d": GRAFT_DEPTH, "--depth": GRAFT_DEPTH, "--format": /^(text|markdown|mermaid|json)$/ },
    positionals: 1,
  },
}

/**
 * SR §3.2 `graft` (SR7-05 b; 1.2.7 row 47a, M1-11): `graft <query> …` with only the options `GRAFT_QUERIES` allows for
 * that query. No option before the sub-command. `graft --version` is a probe. A query names no file the table has to
 * judge, so it gives no paths. 1.2.7 row 47j (U9-3, C76): with or without `--no-refresh`: a refresh only rebuilds graft's
 * own cache (`graft/`), which the person ruled a Swarm-controlled tool may do; `build`, `init` and every other
 * sub-command stay outside the read class.
 */
function graftPaths(args: readonly string[]) {
  const [sub, ...rest] = args
  const rule = sub !== undefined && Object.hasOwn(GRAFT_QUERIES, sub) ? GRAFT_QUERIES[sub] : undefined
  if (!rule) return undefined
  let positionals = 0
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]!
    if (!word.startsWith("-")) {
      positionals++
      continue
    }
    if (rule.flags.includes(word)) continue
    const [name, inline] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined]
    const value = Object.hasOwn(rule.values, name) ? rule.values[name] : undefined
    if (!value) return undefined
    const given = inline ?? rest[++index]
    if (given === undefined || !value.test(given)) return undefined
  }
  return positionals <= rule.positionals ? ([] as string[]) : undefined
}

/**
 * 1.2.8 row 27 (H-U4b): a git look (`gitLook`) in a repository outside the project, by `git -C <folder>` or after a
 * leading `cd`. Under consent the other roles run it (an outside look), so a read role runs the same look, on the same
 * conditions as a nested repository's (`nestedGitAllowed`): the guard vets that repository's own `.git`, nothing lies
 * between it and the folder, and the folder is no sensitive or secret place. Gives the folder, so the library check sees it.
 */
function outsideGitLook(words: readonly string[], here: string, instance: InstanceContext): string[] | undefined {
  const moved = words[1] === "-C" && words[2] !== undefined
  const target = moved ? path.resolve(here, words[2]!) : here
  const [sub, ...args] = words.slice(moved ? 3 : 1)
  if (sub === undefined || !gitLook(sub, args)) return undefined
  const folder = Reach.real(target)
  if (folder === undefined || Reach.inside(folder, instance) || Reach.sensitive(folder, instance) || Reach.secret(folder)) return undefined
  if (fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() !== true) return undefined
  let top = folder
  while (!fs.lstatSync(path.join(top, ".git"), { throwIfNoEntry: false })) {
    const parent = path.dirname(top)
    if (parent === top) return undefined
    top = parent
  }
  if (Reach.sensitive(top, instance) || Reach.secret(top)) return undefined
  return GitGuard.inspect(top).refused === undefined && noRepositoryBetween(folder, top) ? [target] : undefined
}

/** SR7-05 d: `git reflog` only bare or as `show`, `list` or `exists`; `expire` and `delete` change the repository. */
function gitReflogLooks(words: readonly string[]) {
  const moved = words[1] === "-C" && words[2] !== undefined
  const [sub, ...args] = words.slice(moved ? 3 : 1)
  return sub !== "reflog" || args.length === 0 || ["show", "list", "exists"].includes(args[0]!)
}

/** The words one read-class piece names as places, or undefined when the piece is not in the read class. */
function readClassPaths(words: readonly string[], here: string, instance: InstanceContext): string[] | undefined {
  const [program, ...args] = words
  if (program === undefined) return undefined
  if (READS.has(program)) {
    if (!onlyLooks(words) || readClassRefuses(words)) return undefined
    const paths = namedPaths(words)
    const cap = READS.get(program)?.maxPaths
    return cap !== undefined && paths.length > cap ? undefined : paths
  }
  if (program === "git") {
    if (!gitReflogLooks(words)) return undefined
    return gitReads(words, here, instance) ? [] : outsideGitLook(words, here, instance)
  }
  if (program === "mdls") return mdlsPaths(args)
  if (program === "pdftotext") return pdftotextPaths(args)
  if (program === "unzip") return unzipPaths(args)
  if (program === "graft") return graftPaths(args)
  return undefined
}

type ReadPiece = { words: string[]; here: string; paths: string[] }
// No control, format or line-separator character anywhere (`\r`, NUL, a line break, a bidi mark): the line a person reads
// is the line that runs (SR7-20).
const UNSEEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/**
 * The pieces of a read-class command line, or undefined. The shape is SR §3.2's: `[cd <path> && ]<look>[ && <look>]…`, each
 * piece may end with ` 2>/dev/null`, the line may end with ` 2>&1` and ` | tail -N` or ` | head -N`; each piece's words
 * pass `Risk.plainWords` or whole-word quotes, so no other operator, substitution, assignment or redirect survives. A
 * probe (`<installed program> --version`) is the whole command and names nothing.
 */
export function readClass(command: string, cwd: string, instance: InstanceContext): ReadPiece[] | undefined {
  if (!command || UNSEEN_TEXT.test(command)) return undefined
  if (probe(command, cwd, instance)) return []
  let here = cwd
  const pieces: ReadPiece[] = []
  const named: string[] = []
  for (const [index, raw] of command.replace(OUTPUT_TAIL, "").split(" && ").entries()) {
    const words = lookWords(raw.replace(DROP_ERRORS, ""))
    // `cd $HOME` is no plain word list; `homeCdWords` reads only its exact forms (1.2.8 row 27a, G1-01), never a naive split.
    const cdWords = index === 0 ? (words ?? homeCdWords(raw)) : undefined
    const target = cdWords ? cdTarget(cdWords, cwd) : undefined
    if (target !== undefined) {
      here = target
      named.push(here)
      continue
    }
    if (!words || words.length === 0) return undefined
    const paths = readClassPaths(words, here, instance)
    if (!paths) return undefined
    named.push(...paths.map((word) => path.resolve(here, word)))
    pieces.push({ words, here, paths })
  }
  if (pieces.length === 0 || nearLibrary([cwd, ...named])) return undefined
  return programInProject(command, cwd, instance) ? undefined : pieces
}

/**
 * N7-116 (K7-05): whether a shell command line is in the read and diagnostic class (SR §3.2), judged on its text as the
 * shell will run it. Used by the read roles' check and by the app-state allowlist (N-1).
 */
export function isReadOnlyShell(command: string, cwd: string, instance: InstanceContext): boolean {
  return readClass(command, cwd, instance) !== undefined
}

/**
 * U4: whether a read role's call is refused, before any rule, grant or "always" is looked at. Only a shell call (or the
 * shell's folder prompt, which carries its command) by a `READ_SHELL_ROLES` agent is judged; it is refused when its
 * command is not in the read class. The caller answers with `ROLE_SHELL_OUTSIDE_READ_TEXT`.
 */
export function readRoleRefuses(
  input: { agent?: string; permission: string; metadata: Readonly<Record<string, unknown>> },
  instance: InstanceContext,
): boolean {
  if (input.agent === undefined || !READ_SHELL_ROLES.has(input.agent)) return false
  const command = input.metadata.command
  if (input.permission !== "bash" && !(input.permission === "external_directory" && command !== undefined)) return false
  if (typeof command !== "string") return true
  const workdir = input.metadata.workdir
  const cwd = typeof workdir === "string" && path.isAbsolute(workdir) ? workdir : instance.directory
  return !isReadOnlyShell(command, cwd, instance)
}
