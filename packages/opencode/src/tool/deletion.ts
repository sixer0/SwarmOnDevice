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

/**
 * Whether one command's words remove files. `base` turns a word into the program name it stands for; the shell passes its
 * own, which also takes the quotes off.
 */
export function deletes(words: readonly string[], base: (word: string) => string = path.posix.basename) {
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

export * as DeletionWords from "./deletion"
