// Whether a repository is plain enough for the git tool to run git in it at all. Listing git's ways of running a program
// failed twice: a submodule's core.fsmonitor, then gpg.x509.program. So this reads the files that decide what git will do,
// as data, with no git and nothing that honours them, and passes only what is known to run nothing. Refusing costs one
// prompt, because the shell can still do it and a person gets asked. Being wrong costs a program run with nobody asked.
import fs from "node:fs"
import path from "node:path"

const MAX_CONFIG = 256 * 1024
const MAX_INDEX = 64 * 1024 * 1024

// Keys git only consults to lay out a repository, or only for fetch, push, pull and commit, which this tool never runs.
// None names a program. `remote.*.url` can hold `ext::sh -c ...`, but that only runs on a transport, and with no fetch here,
// no promisor (not on this list) and GIT_NO_LAZY_FETCH there is no transport. What git init and git clone write is all here.
const PLAIN_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "user.name",
  "user.email",
  "user.signingkey",
  "user.useconfigonly",
  "pull.rebase",
])
// By section and variable: the name in between is free, and git reads no program out of these whatever it is.
// `vscode-merge-base` and `gh-resolved` are not git's: editors and gh write them, and git never looks at them.
const NAMED_KEYS = new Set([
  "remote.url",
  "remote.pushurl",
  "remote.fetch",
  "remote.gh-resolved",
  "branch.remote",
  "branch.merge",
  "branch.rebase",
  "branch.description",
  "branch.vscode-merge-base",
])

// Stricter than git on purpose: what git accepts and this does not is a refusal, and the reverse must never happen. A
// backslash is the only way a value continues on the next line, so with none each line holds at most one key. A key on a
// section's own line, a dotted section and CR are valid to git and not here, so that nothing is read two ways.
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/
const COMMENT = /^[ \t]*(?:[#;].*)?$/
const SECTION = /^[ \t]*\[([A-Za-z0-9-]+)(?:[ \t]+"([^"\\]*)")?\][ \t]*$/
const ENTRY = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=[^\\]*)?$/

/** What is wrong with this config text, or undefined if every key in it is known to run nothing. Bytes are read as latin1. */
export function configProblem(text: string) {
  const state = { section: undefined as string | undefined, named: false }
  for (const line of text.split("\n")) {
    if (CONTROL.test(line)) return "its config has a control character in it"
    if (COMMENT.test(line)) continue
    const section = line.match(SECTION)
    if (section) {
      state.section = section[1]!.toLowerCase()
      state.named = section[2] !== undefined
      continue
    }
    const entry = line.match(ENTRY)
    if (!entry || state.section === undefined) return "its config has a line this tool cannot read for certain"
    const variable = entry[1]!.toLowerCase()
    const allowed = state.named ? NAMED_KEYS.has(`${state.section}.${variable}`) : PLAIN_KEYS.has(`${state.section}.${variable}`)
    // The name inside the quotes is left out: it is the repository's own text, and this message goes to the model.
    if (!allowed) return `its config sets ${state.section}${state.named ? ".*" : ""}.${variable}, which is not on the short list of keys known to run nothing`
  }
  return undefined
}

/** Whether a git index holds a submodule, from its bytes. Anything it does not fully understand is a reason, never a pass. */
export function indexProblem(index: Buffer) {
  const unreadable = "its index could not be read for certain"
  if (index.length < 32 || index.toString("latin1", 0, 4) !== "DIRC") return unreadable
  const version = index.readUInt32BE(4)
  if (version < 2 || version > 4) return unreadable
  const end = index.length - 20
  const state = { at: 12 }
  for (let left = index.readUInt32BE(8); left > 0; left--) {
    const entry = state.at
    if (entry + 62 > end) return unreadable
    const type = index.readUInt32BE(entry + 24) & 0o170000
    if (type === 0o160000) return "it has a submodule, whose own config no setting from here can reach"
    if (type !== 0o100000 && type !== 0o120000) return unreadable
    const extended = (index.readUInt16BE(entry + 60) & 0x4000) !== 0
    if (extended && version === 2) return unreadable
    const name = entry + (extended ? 64 : 62)
    if (version === 4) {
      // Prefix compressed: how much of the last name to keep, as a varint, then the rest of the name. No padding.
      const varint = { at: name }
      while (varint.at < end && index[varint.at]! & 0x80) varint.at++
      const nul = index.indexOf(0, varint.at + 1)
      if (nul < 0 || nul >= end) return unreadable
      state.at = nul + 1
      continue
    }
    const nul = index.indexOf(0, name)
    if (nul < 0 || nul >= end) return unreadable
    // Padded with NULs to a multiple of 8, always at least one.
    state.at = entry + (((nul - entry + 8) & ~7) >>> 0)
  }
  while (state.at < end) {
    if (state.at + 8 > end) return unreadable
    const signature = index.toString("latin1", state.at, state.at + 4)
    // The real entries are in another file (split index), or folded away behind a directory (sparse index).
    if (signature === "link" || signature === "sdir") return "its index keeps entries somewhere this tool does not read"
    state.at += 8 + index.readUInt32BE(state.at + 4)
  }
  return state.at === end ? undefined : unreadable
}

// A pointer file in a checkout can be a FIFO, and reading one here would hang the server rather than a child that can be killed.
function regular(file: string, max: number) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false })
  return info?.isFile() && info.size <= max ? fs.readFileSync(file) : undefined
}
const present = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined

/**
 * The git directory to pass to git, or the plain reason it must not be run in this checkout. Only `.git` as an ordinary
 * directory holding its own config qualifies. A `.git` file or a `commondir` is an indirection, and git reads those by its own
 * rules: trimming one differently once let this vet a harmless config while git obeyed a hostile one beside it. So neither
 * is followed or parsed, whatever it says, and that is every linked worktree and submodule checkout.
 */
export function inspect(worktree: string): { gitDir: string; refused?: undefined } | { refused: string; gitDir?: undefined } {
  const gitDir = path.join(worktree, ".git")
  const info = fs.lstatSync(gitDir, { throwIfNoEntry: false })
  if (!info) return { refused: "there is no .git at the top of this project" }
  if (info.isSymbolicLink()) return { refused: ".git is a symbolic link" }
  if (!info.isDirectory()) return { refused: ".git is a file that points elsewhere, as in a linked worktree or a submodule checkout" }
  if (present(path.join(gitDir, "commondir"))) return { refused: "its commondir says the repository is somewhere else" }
  const leaves = ["config", "objects", "refs", "packed-refs", "HEAD", "index"].map((name) => path.join(gitDir, name))
  if (leaves.some((file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()))
    return { refused: "part of .git is a symbolic link, which can lead outside this project" }
  if (present(path.join(gitDir, "objects/info/alternates")))
    return { refused: "it borrows objects from another repository through objects/info/alternates" }
  if (present(path.join(gitDir, "config.worktree"))) return { refused: "it has a worktree config" }
  if (present(path.join(worktree, ".gitmodules")) || present(path.join(gitDir, "modules")))
    return { refused: "it has submodules, whose own config no setting from here can reach" }
  const config = regular(path.join(gitDir, "config"), MAX_CONFIG)?.toString("latin1")
  if (config === undefined) return { refused: "its config is not a plain file this tool can read" }
  const problem = configProblem(config)
  if (problem) return { refused: problem }
  const indexFile = path.join(gitDir, "index")
  // A repository with nothing staged yet has no index, and so nothing in one.
  if (!present(indexFile)) return { gitDir }
  const index = regular(indexFile, MAX_INDEX)
  if (!index) return { refused: "its index is not a plain file this tool can read" }
  const indexed = indexProblem(index)
  return indexed ? { refused: indexed } : { gitDir }
}

export * as GitGuard from "./git-guard"
