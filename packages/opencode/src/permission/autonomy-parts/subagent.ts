// Part of the autonomy table (R-1, 1.2.8): Subagent reading: registry adders, script and Makefile bodies, `subagentSendsAnyway`.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import fs from "node:fs"
import path from "node:path"
import { BypassLists } from "../bypass-lists"
import { BypassScreen } from "../bypass-screen"
import { ScriptReader } from "../script-reader"
import type { InstanceContext } from "../../project/instance-context"
import { Reach } from "../../tool/reach"
import { DeletionWords } from "../../tool/deletion"
import type { Input } from "./types"
import { scriptForm, shellReading } from "./shell-steps"
import { commandWords } from "./outward"
/**
 * 1.2.7 U-7 (C7, C21, OP-1, N7-129): the opened categories a subagent's call runs in like the root's under the person's
 * consent (the gate in `index.ts`, which re-exports this one list): no decider call, the root's line with the child's
 * `sessionID`. A positive list, pinned by an equality test (SR7-02); every other opened category still goes to the main
 * agent, where "cannot tell" refuses. `classifySteps` names a decided step before a local one on a compound's line.
 * Row 29c (C41): `check` too, a recognised test or build command (`CHECKS`), which the root's consent already runs.
 */
export const SUBAGENT_RUNS_LIKE_ROOT: ReadonlySet<string> = new Set(["not_routine", "script", "outside_folder", "check"])

/** Row 29d (C46): the package tools whose `add` / `install <name>` fetches a named package from a registry. */
const REGISTRY_ADDERS: ReadonlySet<string> = new Set(["npm", "bun", "pnpm", "yarn"])
const ADD_WORDS: ReadonlySet<string> = new Set(["add", "install", "i", "in", "isntall"])
/** A word that names a local package, not one from a registry: a path or a local protocol. */
const LOCAL_PACKAGE = /^(\.{1,2}(\/|$)|\/|~|file:|link:|workspace:|portal:)/

/** Row 29d (C46): `npm|bun|pnpm|yarn add|install <pkg>`; a lockfile install (`bun install`, `npm ci`) names none. */
function addsRegistryPackage(name: string, args: readonly string[]) {
  if (!REGISTRY_ADDERS.has(name)) return false
  const words = args.filter((word) => !word.startsWith("-"))
  return ADD_WORDS.has(words[0] ?? "") && words.slice(1).some((word) => !LOCAL_PACKAGE.test(word))
}

/**
 * Row 47e (M1-07, C61): the other package tools' named adds, by tool: the sub-command words, the options whose value is
 * no package (skipped), and what a word names that is local. A requirements or lockfile install (`pip install -r`,
 * `uv sync`, `cargo build`, `bundle install`, `composer install`) names none and keeps parity.
 */
type AddRule = { readonly subs: readonly string[]; readonly values: ReadonlySet<string>; readonly local?: (word: string) => boolean }
const PIP_VALUES: ReadonlySet<string> = new Set([
  "-r", "--requirement", "-c", "--constraint", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "-t", "--target",
  "--prefix", "--root", "--src", "--platform", "--python-version", "--implementation", "--abi", "--progress-bar", "--log",
  "--cache-dir", "--trusted-host", "--proxy", "--retries", "--timeout", "--exists-action", "--upgrade-strategy",
  "--global-option", "--config-settings", "-C", "--report", "-p", "--python",
])
/** A path a pip-family tool installs from (`dist/x.whl`, `./pkg`), not a name from an index; a URL is not local. */
const PIP_LOCAL = (word: string) => LOCAL_PACKAGE.test(word) || (word.includes("/") && !word.includes(":") && !word.includes("@"))
const CARGO_VALUES: ReadonlySet<string> = new Set([
  "--version", "--vers", "--branch", "--tag", "--rev", "--root", "--index", "--registry", "-j", "--jobs", "--target",
  "--features", "-F", "--profile", "--bin", "--example", "--rename", "--package", "-p", "--manifest-path", "--target-dir",
  "--config", "-Z", "--color",
])
const OTHER_ADDERS: Readonly<Record<string, readonly AddRule[]>> = {
  pip: [{ subs: ["install"], values: PIP_VALUES, local: PIP_LOCAL }],
  pip3: [{ subs: ["install"], values: PIP_VALUES, local: PIP_LOCAL }],
  uv: [
    { subs: ["add"], values: new Set(["--group", "--optional", "--extra", "--tag", "--branch", "--rev", "--index", "--default-index", "-p", "--python", "--package", "--script", "--directory", "--project", "--bounds"]) },
    { subs: ["pip", "install"], values: PIP_VALUES, local: PIP_LOCAL },
  ],
  poetry: [{ subs: ["add"], values: new Set(["-G", "--group", "-E", "--extras", "--source", "--python", "--platform", "--markers", "-C", "--directory", "-P", "--project"]) }],
  pdm: [{ subs: ["add"], values: new Set(["-G", "--group", "-p", "--project"]) }],
  pipenv: [{ subs: ["install"], values: new Set(["-r", "--requirements", "--python", "-i", "--index"]), local: PIP_LOCAL }],
  cargo: [
    { subs: ["add"], values: CARGO_VALUES },
    { subs: ["install"], values: CARGO_VALUES },
  ],
  go: [
    { subs: ["get"], values: new Set(["-C", "-modfile", "-tags", "-ldflags", "-gcflags"]) },
    { subs: ["install"], values: new Set(["-C", "-modfile", "-tags", "-ldflags", "-gcflags", "-o", "-p"]) },
  ],
  gem: [{ subs: ["install"], values: new Set(["-v", "--version", "-i", "--install-dir", "-n", "--bindir", "-s", "--source", "--platform", "-P", "--trust-policy", "-g", "--file"]), local: (word) => LOCAL_PACKAGE.test(word) || word.endsWith(".gem") }],
  composer: [{ subs: ["require"], values: new Set(["-d", "--working-dir"]) }],
  bundle: [{ subs: ["add"], values: new Set(["-v", "--version", "-g", "--group", "-s", "--source", "--require", "--path", "--git", "--github", "--branch", "--ref", "--glob"]) }],
}
const PYTHONS = /^python(\d+(\.\d+)?)?$/

/** Row 47e (M1-07): `name args` adds a named package from a registry (pip/uv/poetry/cargo/go/gem/composer and kin). */
function addsOtherRegistryPackage(name: string, args: readonly string[]): boolean {
  // `python3 -m pip install x` is pip's own add.
  if (PYTHONS.test(name) && args[0] === "-m" && (args[1] === "pip" || args[1] === "pip3"))
    return addsOtherRegistryPackage("pip", args.slice(2))
  const rules = Object.hasOwn(OTHER_ADDERS, name) ? OTHER_ADDERS[name]! : []
  return rules.some((rule) => {
    const words: string[] = []
    for (let index = 0; index < args.length; index++) {
      const word = args[index]!
      if (word === "--") continue
      if (word.startsWith("-")) {
        // An editable (`-e <spec>`) is a package spec; a value option's word is not.
        if ((word === "-e" || word === "--editable") && index + 1 < args.length) words.push(args[++index]!)
        else if (!word.includes("=") && rule.values.has(word)) index++
        else if (/^--(git|editable)=/.test(word)) words.push(word.slice(word.indexOf("=") + 1))
        continue
      }
      words.push(word)
    }
    if (!rule.subs.every((sub, at) => words[at] === sub)) return false
    const local = rule.local ?? ((word: string) => LOCAL_PACKAGE.test(word))
    return words.slice(rule.subs.length).some((word) => !local(word))
  })
}

/** Row 47e (M1-06): gh's options that take a value before the sub-command (`gh -R owner/repo pr create`). */
const GH_VALUES: ReadonlySet<string> = new Set(["-R", "--repo", "--hostname", "-X", "--method", "-H", "--header", "-f", "--field", "-F", "--raw-field", "--input", "-q", "--jq", "-t", "--template", "--cache"])
/** Row 47e (M1-06): the gh sub-commands that write to GitHub (a pull request, a release, a repository, an issue, a gist). */
const GH_WRITE = /^(pr (create|merge|comment|review|edit|close|reopen|ready|lock|unlock)|release (create|upload|edit|delete|delete-asset)|repo (create|fork|sync|edit|delete|rename|archive|unarchive|deploy-key add|set-default)|issue (create|comment|edit|close|reopen|delete|lock|unlock|transfer|pin|unpin|develop)|gist (create|edit|delete|clone)|label (create|edit|delete|clone)|secret (set|delete|remove)|variable (set|delete)|workflow (run|enable|disable)|run (rerun|cancel|delete)|cache delete|ruleset|project|codespace|ssh-key (add|delete)|gpg-key (add|delete)|org|attestation)\b/
/** Row 47e (M1-06): a gh call that writes: a write sub-command, or `gh api` with a method other than GET or with fields. */
function ghWrites(args: readonly string[]): boolean {
  const words: string[] = []
  let method: string | undefined
  let fields = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    const [flag, inline] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined]
    if (/^-X./.test(word)) method = word.slice(2)
    else if (flag === "-X" || flag === "--method") method = inline ?? args[++index]
    else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(flag) || /^-[fF]./.test(word)) {
      fields = true
      if (inline === undefined && !/^-[fF]./.test(word)) index++
    } else if (word.startsWith("-")) {
      if (inline === undefined && GH_VALUES.has(flag)) index++
    } else words.push(word)
  }
  if (words[0] === "api") return fields || (method !== undefined && method.toUpperCase() !== "GET")
  return GH_WRITE.test(words.join(" "))
}

/** Row 47e (M1-05): how deep a script file or recipe that runs another one is read; past it, the call goes to the decider. */
const MAX_BODY_DEPTH = 3
/** Row 47e (M1-05): the largest script file or Makefile read. Larger is not read in full: the decider. */
const MAX_BODY_BYTES = 64 * 1024
/** A script file's first line that names a shell this reader reads (`#!/bin/sh`, `#!/usr/bin/env bash`). */
const SHELL_SHEBANG = /^#!\s*\S*\/(env\s+(-\S+\s+)*)?(sh|bash|zsh|dash|ksh)(\s|$)/
/** The words that run a file's text in the shell itself. */
const SOURCES: ReadonlySet<string> = new Set(["source", "."])
/** `make`'s options that change nothing about which recipe runs. Any other option is not read: the decider. */
const MAKE_PLAIN = /^(-s|--silent|--quiet|-k|--keep-going|-w|--print-directory|--no-print-directory|-j\d*|--jobs(=\d+)?|-B|--always-make|-r|--no-builtin-rules|-R|--no-builtin-variables)$/
/** Makefile lines this reader does not follow (includes, conditionals, a changed shell or recipe prefix): the decider. */
const MAKE_UNREAD = /^\s*(-?include|sinclude|define|endef|ifeq|ifneq|ifdef|ifndef|else|endif|override|vpath|load)\b|^\s*(SHELL|\.SHELLFLAGS|MAKEFLAGS|MFLAGS|MAKEFILES|\.RECIPEPREFIX|\.ONESHELL|\.DEFAULT|\.SUFFIXES)\b/

/** What a step runs from a file: the texts and the folder they run in, `unreadable`, or undefined for no such step. */
type Body = { readonly texts: readonly string[]; readonly cwd: string } | "unreadable"

/**
 * Row 47e (M1-05): the text of a local script file a step runs (`./deploy.sh`, `scripts/x.sh`, `bash x.sh`, `. ./env.sh`),
 * read as a shell text. `unreadable` when it cannot be read in full: missing, not a regular file, too large, a first line
 * naming another interpreter, or a binary inside the project. A program outside the project that is no script (a system
 * binary named by its path) is no body.
 */
function scriptFileBody(word: string, cwd: string, instance: InstanceContext): Body | undefined {
  const file = path.resolve(cwd, word)
  const inside = Reach.inside(file, instance)
  let text: string
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_BODY_BYTES) return inside ? "unreadable" : undefined
    text = fs.readFileSync(file, "utf8")
  } catch {
    return "unreadable"
  }
  const first = text.split("\n", 1)[0] ?? ""
  if (first.startsWith("#!")) return SHELL_SHEBANG.test(first) ? { texts: [text], cwd } : "unreadable"
  if (text.includes("\0")) return inside ? "unreadable" : undefined
  return { texts: [text], cwd }
}

/**
 * Row 47e (M1-05): the recipe lines `make <args>` runs in `cwd`, each a shell text, with the recipes of the targets it
 * depends on. `unreadable` for anything this small reader does not follow: an option it does not know, a variable on the
 * line, no Makefile, a target with no rule of its own, a `$` in a reached rule or recipe, a double-colon rule, includes and
 * conditionals.
 */
function makeBody(args: readonly string[], cwd: string, instance: InstanceContext): Body {
  let dir = cwd
  let named: string | undefined
  const goals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "-C" || word === "--directory") dir = path.resolve(dir, args[++index] ?? "")
    else if (word.startsWith("--directory=")) dir = path.resolve(dir, word.slice(12))
    else if (/^-C./.test(word)) dir = path.resolve(dir, word.slice(2))
    else if (word === "-f" || word === "--file" || word === "--makefile") named = args[++index]
    else if (/^--(file|makefile)=/.test(word)) named = word.slice(word.indexOf("=") + 1)
    else if (word === "-j" && /^\d+$/.test(args[index + 1] ?? "")) index++
    else if (MAKE_PLAIN.test(word)) continue
    else if (word.startsWith("-") || word.includes("=") || word.includes("$")) return "unreadable"
    else goals.push(word)
  }
  if (named?.includes("$") || dir.includes("$")) return "unreadable"
  const file = named !== undefined ? path.resolve(dir, named) : ["GNUmakefile", "makefile", "Makefile"].map((name) => path.join(dir, name)).find((each) => fs.existsSync(each))
  if (file === undefined || !Reach.inside(file, instance)) return "unreadable"
  let text: string
  try {
    if (fs.statSync(file).size > MAX_BODY_BYTES) return "unreadable"
    text = fs.readFileSync(file, "utf8")
  } catch {
    return "unreadable"
  }
  const rules = new Map<string, { prereqs: string[]; recipe: string[]; bad: boolean }>()
  let first: string | undefined
  let current: { prereqs: string[]; recipe: string[]; bad: boolean }[] = []
  let patterns = false
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!.replace(/\r$/, "")
    if (line.startsWith("\t")) {
      if (current.length === 0) return "unreadable"
      // A recipe line, with its `\` continuations: one shell text.
      while (line.endsWith("\\") && index + 1 < lines.length) line = line.slice(0, -1) + lines[++index]!.replace(/^\t/, "")
      for (const rule of current) rule.recipe.push(line.slice(1))
      continue
    }
    while (line.endsWith("\\") && index + 1 < lines.length) line = line.slice(0, -1) + " " + lines[++index]!
    const bare = line.replace(/(^|\s)#.*$/, "").trimEnd()
    if (bare.trim() === "") continue
    if (MAKE_UNREAD.test(bare)) return "unreadable"
    if (/^\s*(export\s+|unexport\s+)?[\w.-]+\s*(\?|:|::|\+|!)?=/.test(bare)) {
      current = []
      continue
    }
    const rule = /^([^:=#\t][^:=#]*?)\s*(::?)(?!=)\s*([^;]*?)\s*(?:;\s*(.*))?$/.exec(bare)
    if (!rule) return "unreadable"
    const targets = rule[1]!.trim().split(/\s+/)
    const prereqs = (rule[3] ?? "").split(/\s+/).filter((word) => word !== "" && word !== "|")
    const bad = rule[2] === "::" || prereqs.some((word) => word.includes("=")) || [...targets, ...prereqs].some((word) => word.includes("$"))
    if (targets.some((target) => target.includes("%"))) patterns = true
    current = targets.map((target) => {
      const known = rules.get(target) ?? { prereqs: [], recipe: [], bad: false }
      // A second recipe for a target replaces the first (GNU make warns): not read.
      if (known.recipe.length > 0 && (rule[4] !== undefined || lines[index + 1]?.startsWith("\t"))) known.bad = true
      known.prereqs.push(...prereqs)
      known.bad ||= bad
      rules.set(target, known)
      return known
    })
    if (rule[4] !== undefined) for (const each of current) each.recipe.push(rule[4])
    first ??= targets.find((target) => !target.startsWith(".") && !target.includes("%"))
  }
  const wanted = goals.length > 0 ? goals : first !== undefined ? [first] : []
  if (wanted.length === 0) return "unreadable"
  const texts: string[] = []
  const seen = new Set<string>()
  const walk = (target: string, depth: number, goal: boolean): boolean => {
    if (seen.has(target)) return true
    seen.add(target)
    const rule = rules.get(target)
    // A goal needs a rule of its own; a prerequisite with none is a file, unless pattern rules may build it.
    if (!rule) return !goal && !patterns
    if (rule.bad || depth > 20) return false
    for (const prereq of rule.prereqs) if (!walk(prereq, depth + 1, false)) return false
    for (const line of rule.recipe) {
      const command = line.replace(/^[\s@+-]+/, "")
      if (command.includes("$")) return false
      if (command.trim() !== "") texts.push(command)
    }
    return true
  }
  for (const goal of wanted) if (!walk(goal, 0, true)) return "unreadable"
  return { texts, cwd: dir }
}

/**
 * Row 47e (M1-05): what a step runs from a file one level down: a local script file (by its path, through `sh|bash|zsh
 * <file>`, or `source`/`.`), or a Makefile recipe (`make`, `gmake`). Undefined for any other step.
 */
function stepBody(argv: readonly string[], cwd: string, instance: InstanceContext): Body | undefined {
  const found = BypassScreen.unwrap(argv)
  if (found.kind !== "program") return undefined
  if (found.name === "make" || found.name === "gmake") return makeBody(found.args, cwd, instance)
  if (SOURCES.has(found.name)) return found.args[0] === undefined ? undefined : scriptFileBody(found.args[0], cwd, instance)
  if (DeletionWords.SHELLS.has(found.name) && BypassScreen.runText(argv) === undefined) {
    // The first word past the shell's options is the file it runs; `-o <name>` takes a value. None: it reads stdin.
    for (let index = 0; index < found.args.length; index++) {
      const word = found.args[index]!
      if (word === "-o" || word === "+o" || word === "-O" || word === "+O") index++
      else if (word === "-s" || word === "--") return undefined
      else if (!/^[-+]/.test(word)) return scriptFileBody(word, cwd, instance)
    }
    return undefined
  }
  if (found.spelled.includes("/")) return scriptFileBody(found.spelled, cwd, instance)
  return undefined
}

/**
 * Row 47e (alias residual of 47a, C70): a step list that defines an alias (`alias x=...`) or a function (`function f`)
 * and names it in a later step. The alias's value is text no step shows, so what `x` runs cannot be told.
 */
function definesAndUses(steps: readonly { argv: readonly string[] }[]): boolean {
  const defined = new Set<string>()
  for (const step of steps) {
    const [program, ...args] = step.argv
    if (program === undefined) continue
    if (step.argv.some((word) => defined.has(word))) return true
    if (program === "alias")
      for (const word of args) if (!word.startsWith("-") && word.includes("=")) defined.add(word.slice(0, word.indexOf("=")))
    if (program === "function" && args[0] !== undefined) defined.add(args[0].replace(/\(\)$/, ""))
  }
  return false
}

/**
 * Row 29d (C46, OP-1): a SUBAGENT's shell call that leaves the parity path although its category is in
 * `SUBAGENT_RUNS_LIKE_ROOT`: one of its steps (texts and project scripts unwrapped, `BypassScreen.deepSteps`) is a form the
 * 1.1.1 rules recognise as leaving the machine (`BypassLists.OUTWARD_FORMS`: a hosted deploy, a publish, an image push), or
 * adds a named registry package. It goes to the main agent, where "cannot tell" refuses. The root is never asked here,
 * and nothing is reclassified: the line's category stays the table's.
 * Row 47e (C61): also a gh write (M1-06), another tool's named add (M1-07), an alias defined and used later in the call
 * (47a residual), and one level further down (M1-05): a local script file a step runs, or a Makefile recipe, read through
 * the same step reader; a file or recipe that cannot be read in full goes to the main agent too. The gate also asks this
 * of a call a P-01a task grant lifted to the root (M1-18): a grant never skips it.
 */
export function subagentSendsAnyway(input: Input): boolean {
  if (input.bypass?.caller !== "subagent") return false
  return sendsAnyway(input, 0)
}

function sendsAnyway(input: Input, depth: number): boolean {
  const deep = BypassScreen.deepSteps(input)
  // A body read one level down must be read in full; the call itself keeps the table's reading.
  if (depth > 0 && (deep.unreadable.length > 0 || deep.steps.length === 0)) return true
  if (definesAndUses(deep.steps)) return true
  return deep.steps.some((step) => {
    const found = BypassScreen.unwrap(step.argv)
    if (found.kind !== "program") return false
    const form = Object.hasOwn(BypassLists.OUTWARD_FORMS, found.name) ? BypassLists.OUTWARD_FORMS[found.name] : undefined
    if (form !== undefined && form(found.args)) return true
    if (addsRegistryPackage(found.name, found.args) || addsOtherRegistryPackage(found.name, found.args)) return true
    if (found.name === "gh" && ghWrites(found.args)) return true
    if (step.code !== undefined) return false
    return step.cwds.some((cwd) => {
      const body = stepBody(step.argv, cwd, input.instance)
      if (body === undefined) return false
      if (body === "unreadable" || depth >= MAX_BODY_DEPTH) return true
      return body.texts.some((text) => bodySends(input, text, body.cwd, depth + 1))
    })
  })
}

/** Row 47e (M1-05): a script file's or recipe line's text, read by the shell's own reader in full, sends anyway. */
function bodySends(input: Input, text: string, cwd: string, depth: number): boolean {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replace(/[\n\t\r]/g, ""))) return true
  const steps = ScriptReader.read(text, cwd)
  const reading = shellReading(steps, input.instance)
  // Not read (an expansion, a function, a reader not ready) or not in full: what runs cannot be told.
  if (!steps || !reading?.complete) return true
  if (reading.steps.length === 0) return false
  return sendsAnyway({ ...input, cwd, patterns: [text], metadata: { command: text, steps } }, depth)
}

/** 1.2.7 U-7 (C21 b, c): the shells whose `-c` text is read as a command line, and whose script file is screened as one. */
const SHELL_TEXT_PROGRAMS: ReadonlySet<string> = new Set(["sh", "bash", "zsh"])

/** 1.2.7 row 47a (M1-04): the modes of zsh's `emulate`, whose `-c <text>` evaluates the text as `sh -c` does. */
const EMULATE_MODES: ReadonlySet<string> = new Set(["zsh", "sh", "ksh", "csh"])

/**
 * The text of a step that is exactly `sh|bash|zsh -c <text>`, or (row 47a, M1-04) zsh's `emulate [-lLR] <mode> -c <text>`;
 * undefined for any other shape, which then keeps the 1.2.6 path.
 */
function shellTextOf(argv: readonly string[]) {
  if (argv.length === 3 && SHELL_TEXT_PROGRAMS.has(argv[0]!) && argv[1] === "-c") return argv[2]
  if (argv[0] !== "emulate") return undefined
  let index = 1
  while (/^-[lLR]+$/.test(argv[index] ?? "")) index++
  return EMULATE_MODES.has(argv[index] ?? "") && argv[index + 1] === "-c" && argv.length === index + 3 ? argv[index + 2] : undefined
}

/**
 * 1.2.7 U-7 (C21 b): a call that is exactly `sh|bash|zsh -c '<one literal>'` (row 47a, M1-04: or zsh
 * `emulate <mode> -c '<literal>'`, `shellTextOf`) (one command, nothing before or after it, no
 * redirect, no `cd`, no `NAME=value`), as the text the shell will run: the literal read by the shell's own reader
 * (`ScriptReader`, the same tree-sitter `decompose` the shell tool gives `metadata.steps` with). undefined keeps the call
 * as it was (decided `unreadable_command`): the reader is not ready; the literal has an expansion, a substitution, a
 * variable, a glob or anything else the reader does not read in full; a control or format character, or a backslash before
 * a line break, that the reader and the shell might take differently (SR7-20); or it runs a shell text, an `eval` or a
 * launcher's code itself (one level only); or it deletes or replaces a file (`DeletionWords.deletesOrReplacesWide`), which
 * is refused on the 1.2.6 path with its 1.2.6 line. What the shell said about the outer text (archive, checkpoint) is not about the
 * inner one, so it is dropped: an inner deletion or overwrite is judged with nothing saved first.
 */
export function shellTextCall(input: Input): Input | undefined {
  if (input.permission !== "bash") return undefined
  const command = input.metadata.command
  if (typeof command !== "string") return undefined
  const outer = ScriptReader.read(command, input.cwd)
  if (!outer || outer.steps.length !== 1 || outer.writes.length > 0 || outer.upward || outer.chdirs || outer.assigned)
    return undefined
  const step = outer.steps[0]!
  if (step.code !== undefined || step.cwds.length !== 1 || step.cwds[0] !== input.cwd) return undefined
  const text = shellTextOf(step.argv)
  if (text === undefined || text.trim() === "") return undefined
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replace(/[\n\t]/g, "")) || text.includes("\\\n")) return undefined
  const steps = ScriptReader.read(text, input.cwd)
  const reading = shellReading(steps, input.instance)
  if (!steps || !reading?.complete || reading.steps.length === 0) return undefined
  if (reading.steps.some((each) => BypassScreen.runText(each.argv) !== undefined)) return undefined
  // A deletion or a replacement in the text keeps the 1.2.6 path (refused, archive first), its line included (CHAR-05).
  if (reading.steps.some((each) => DeletionWords.deletesOrReplacesWide(each.argv, commandWords))) return undefined
  return {
    ...input,
    patterns: [text],
    metadata: { ...input.metadata, command: text, steps, archive: undefined, archiveTargets: undefined, checkpointTargets: undefined },
    whole: input.whole ?? command,
  }
}

/**
 * 1.2.7 U-7 (C21 c): `sh|bash|zsh <file> [args]` the table judged P `script` (`scriptForm`: screened, hashed by the shell)
 * runs that file as `./<file>` does, so the wide reader's "a shell with a script file cannot be read" is no deletion: the
 * script screen's `delete` flag is what refuses a script that deletes (`noWait` rule 3).
 */
export function shellRunsScreenedScript(input: Input, category: string | undefined) {
  if (category !== "script" || input.permission !== "bash" || typeof input.metadata.command !== "string") return false
  const form = scriptForm(input.metadata.command)
  return form?.file !== undefined && form.program !== undefined && SHELL_TEXT_PROGRAMS.has(form.program)
}
