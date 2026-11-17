// 1.3.3 row 108 (MC-7, register section 9 "Routine kind `skill-script`"): a script Swarm ships inside a built-in skill is
// routine work, as a check is. The command has to be one piece, `<interpreter> -I <root>/scripts/<name> [args]`, where
// <root> is the real folder of a built-in skill as the skill registry resolves it (never a name or a prefix in the text),
// <name> is a script that skill lists, and every argument is one its own table allows: a path inside the project, the
// skill's own read-only source, or free text. Nothing else is the rule's, so all of it keeps the verdict it had.
//
// What is held here, and why:
// - an interpreter not listed (`INTERPRETERS`), no `-I` right after it, or any other option before the script: `-c`, `-m`,
//   `-X`, `-W` and the like run code or change what runs, and without `-I` (row 148, security finding L2) Python takes
//   `PYTHONPATH`, `PYTHONHOME`, the user site and `.pth` files from the environment, code this rule never judged;
// - a script path that is not absolute, not exactly `<root>/scripts/<name>`, or reached through a link (the script itself,
//   or the root, being a link): a copy, the same name elsewhere and a link into the root from elsewhere all fail here;
// - a user skill: only `current()` names roots, and it reads the skill registry (`builtinSkillScriptRoots()`), nothing a user writes;
// - any shell operator, quote with `$`, redirection or second line: `Risk.quotedWords` takes one program with literal
//   words only;
// - an argument that is not one of the script's options, a repeated or abbreviated option (argparse would take `--o` as
//   `--out`), a bare word, or a path that leaves the project, follows a link out, is secret, sensitive, the bundled library
//   or a built-in skill folder;
// - for the knowledge builder, an `--out` folder that is a link, or that already holds one of the builder's five output
//   names as anything but a regular file (row 148, security finding L1: the builder would otherwise write through it; the
//   builder itself refuses the same, and writes by temporary file and rename).
import fs from "node:fs"
import path from "node:path"
import type { InstanceContext } from "../../project/instance-context"
// `skill/index.ts` imports the permission module, so this is a load cycle. It is safe because nothing here touches the
// import before `current()` is called, and no module on the cycle calls `current()` while it loads (row 108 report).
import { builtinSkillScriptRoots } from "../../skill/index"
import { LibraryRoot } from "../../skill/library-root"
import { Reach } from "../../tool/reach"
import { Risk } from "../../tool/risk"
import { nearLibrary } from "./outside"

/** One built-in skill: its real root, the scripts under `<root>/scripts/` the rule covers, and folders they may read. */
export type Skill = { readonly root: string; readonly scripts: readonly string[]; readonly readRoots: readonly string[] }
/** What the registry resolved for this process: the bundled interpreter(s) and the built-in skills with scripts. */
export type Builtin = { readonly pythons: readonly string[]; readonly skills: readonly Skill[] }

export const NONE: Builtin = { pythons: [], skills: [] }

/**
 * The interpreters the rule takes, besides the bundled one(s) `Builtin.pythons` names by exact absolute path: `python3`
 * found on PATH (the gate's `programInProject` still holds one the project itself provides). Each must carry `-I`
 * (row 148, L2) and nothing else; the bundled wrapper adds `-I -B` itself, so a second `-I` changes nothing there. Not `python` (may be another major version), not `bash`/`sh` (no covered script is a shell script), not
 * an absolute path to any other Python.
 */
export const INTERPRETERS: readonly string[] = ["python3"]

const DIAGRAM_SCRIPT = "bingkai_lembar.py"
const KNOWLEDGE_SCRIPT = "build_kl_index.py"

/**
 * Per script, the only options it may get. `in`: a path inside the project that is read. `out`: a path inside the project
 * that is written. `outdir`: an `out` folder that, where it exists, is a real folder whose `KNOWLEDGE_OUTPUTS` names are
 * absent or regular files. `root`: a path inside the project, or exactly one of the skill's `readRoots`. `text`: free
 * text that the script only prints from. `-h`/`--help` alone is always allowed.
 */
type Value = "in" | "out" | "outdir" | "root" | "text"
const OPTIONS: Readonly<Record<string, Readonly<Record<string, Value>>>> = {
  [DIAGRAM_SCRIPT]: { "--svg": "in", "--meta": "in", "--out": "out" },
  [KNOWLEDGE_SCRIPT]: { "--root": "root", "--out": "outdir", "--match": "text" },
}

/** The five files `build_kl_index.py` writes into `--out` (its `OUTPUT_FILES`; register section 9, Index files). */
/** @internal test seam */
export const KNOWLEDGE_OUTPUTS: readonly string[] = [
  "indeks_struktur.json",
  "indeks_pemicu.json",
  "indeks_struktur.md",
  "indeks_pemicu.md",
  "indeks_pemicu_ringkas.md",
]

/** One entry of the skill registry's `builtinSkillScriptRoots()` (row 97): a skill, its scripts folder, its Python. */
export type Entry = { readonly skill: string; readonly scripts: string; readonly python: string }

/** Per built-in skill name, the scripts of its `scripts/` folder the rule covers. Any other skill is not covered. */
const COVERED: Readonly<Record<string, readonly string[]>> = {
  "gsp-diagram-standard": [DIAGRAM_SCRIPT],
  "knowledge-library": [KNOWLEDGE_SCRIPT],
}

/**
 * The built-in skills with a covered script, from the registry's entries (controller C27: ONE list, `builtinSkillScriptRoots()`
 * in `skill/index.ts`, which resolves both bundled folders in the dev and the packaged layout). `library` is the bundled
 * library's root when `LibraryRoot` has one: the knowledge-library builder may read it as `--root`, as it may read the
 * folder its scripts sit in (packaged, the same folder).
 */
/** @internal test seam */
export function fromRoots(entries: readonly Entry[], library?: string): Builtin {
  const skills = entries.flatMap((entry) => {
    const scripts = COVERED[entry.skill]
    if (!scripts || path.basename(entry.scripts) !== "scripts") return []
    const root = path.dirname(entry.scripts)
    const readRoots = entry.skill === "knowledge-library" ? [...new Set([root, ...(library ? [library] : [])])] : []
    return [{ root, scripts, readRoots }]
  })
  return { pythons: [...new Set(entries.map((entry) => entry.python))], skills }
}

/** This process's built-in skills with scripts, read from the registry at call time. */
export function current(): Builtin {
  const library = LibraryRoot.current()
  return fromRoots(builtinSkillScriptRoots(), library.kind === "available" ? library.root : undefined)
}

/** Whether `command`, run in `cwd`, runs a covered built-in skill script with arguments its table allows. */
export function matches(command: string, cwd: string, instance: InstanceContext, builtin: Builtin = current()): boolean {
  if (builtin.skills.length === 0 || command.includes("\n")) return false
  const words = commandWords(command, builtin.pythons)
  if (!words) return false
  // Row 148 (L2): the isolation flag is required, not optional.
  if (words[1] !== "-I") return false
  const start = 2
  const script = words[start]
  if (script === undefined || !path.isAbsolute(script)) return false
  const skill = builtin.skills.find((entry) => scriptOf(entry, script))
  if (!skill) return false
  return argumentsAllowed(path.basename(script), words.slice(start + 1), skill, builtin, cwd, instance)
}

/** The command's words with the interpreter first, or undefined when it is not one listed interpreter with literal words. */
function commandWords(command: string, pythons: readonly string[]) {
  // `Risk.quotedWords` wants a bare program name first; a bundled interpreter is an absolute path with no space in it.
  const bundled = pythons.find((python) => path.isAbsolute(python) && !/\s/.test(python) && command.startsWith(python + " "))
  const words = Risk.quotedWords(bundled ? "python3" + command.slice(bundled.length) : command)
  if (!words || (!bundled && !INTERPRETERS.includes(words[0]!))) return undefined
  return bundled ? [bundled, ...words.slice(1)] : words
}

/** `script` is exactly `<root>/scripts/<name>` for a listed name, a regular file, and no link on the way. */
function scriptOf(skill: Skill, script: string) {
  const name = path.basename(script)
  if (!skill.scripts.includes(name)) return false
  const expected = path.join(skill.root, "scripts", name)
  if (path.normalize(script) !== script || script !== expected) return false
  try {
    if (fs.realpathSync.native(skill.root) !== skill.root) return false
    const entry = fs.lstatSync(expected)
    return entry.isFile() && !entry.isSymbolicLink() && fs.realpathSync.native(expected) === expected
  } catch {
    return false
  }
}

function argumentsAllowed(name: string, args: readonly string[], skill: Skill, builtin: Builtin, cwd: string, instance: InstanceContext) {
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) return true
  const table = OPTIONS[name]
  if (!table) return false
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    const option = /^--[a-z][a-z-]*(?==|$)/.exec(word)?.[0]
    if (!option || !Object.hasOwn(table, option) || seen.has(option)) return false
    seen.add(option)
    const inline = word.length > option.length ? word.slice(option.length + 1) : undefined
    const value = inline ?? args[++index]
    if (value === undefined || !valueAllowed(table[option]!, value, skill, builtin, cwd, instance)) return false
  }
  return true
}

function valueAllowed(kind: Value, value: string, skill: Skill, builtin: Builtin, cwd: string, instance: InstanceContext) {
  // argparse reads a value that starts with `-` as the next option.
  if (value === "" || value.startsWith("-")) return false
  if (kind === "text") return true
  if (kind === "root" && skill.readRoots.some((root) => Reach.real(path.resolve(cwd, value)) === root && path.isAbsolute(value))) return true
  if (!projectPath(value, cwd, instance, builtin)) return false
  return kind !== "outdir" || outputFolderSafe(path.resolve(cwd, value))
}

/** Row 148 (L1): a folder the builder may write its five files into. A folder that does not exist yet is fine. */
function outputFolderSafe(folder: string) {
  const entry = (file: string) => {
    try {
      return fs.lstatSync(file)
    } catch {
      return undefined
    }
  }
  const self = entry(folder)
  if (!self) return true
  if (!self.isDirectory()) return false
  return KNOWLEDGE_OUTPUTS.every((name) => {
    const output = entry(path.join(folder, name))
    return output === undefined || output.isFile()
  })
}

/** A path in the project as the read tool would show it: no `~` or `..`, inside once links are followed, nothing secret. */
function projectPath(word: string, cwd: string, instance: InstanceContext, builtin: Builtin) {
  if (word.startsWith("~") || word.split("/").includes("..")) return false
  const file = path.resolve(cwd, word)
  const base = instance.worktree === "/" ? { ...instance, worktree: instance.directory } : instance
  if (!Reach.inside(file, instance) || Reach.sensitive(file, base) || Reach.secret(file) || nearLibrary([file])) return false
  // A project that holds Swarm's own repository holds the skill folders too: a script must not write into one.
  const real = Reach.real(file) ?? file
  return !builtin.skills.some((skill) => [skill.root, ...skill.readRoots].some((root) => real === root || real.startsWith(root + path.sep)))
}

export * as SkillScript from "./skill-script"
