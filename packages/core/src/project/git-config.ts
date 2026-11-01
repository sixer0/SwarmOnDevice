export * as GitConfig from "./git-config"

// Which keys in a repository's own config are known to run nothing. Kept in core because a folder's trust question needs it
// as well as the git tool. It reads text only, with no git and nothing that honours the file.

// Keys git only consults to lay out a repository, or only for fetch, push, pull and commit, which this tool never runs, and
// the hooks path, which is switched off on the command line.
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
  // Lower case, because the check lower-cases first. Husky sets it. The -c in HARDENED_CONFIG overrides it, so the path is never
  // used, and these reads have no cause to fire a hook anyway. Nothing about this one extends to any other core key.
  "core.hookspath",
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

// A flag or a number cannot name a program, so a key set to one needs no question: commit.gpgsign = false, core.autocrlf = input.
const CANNOT_NAME_A_PROGRAM = /^"?(true|false|yes|no|on|off|input|-?\d+[kmg]?)?"?$/i
const VALUE = /=[ \t]*(.*?)[ \t]*(?:[#;].*)?$/

/**
 * For a folder's trust question: the first setting that is off the short list and whose value could name a program, or could
 * bring in more config. git's own list of such settings has beaten a list of bad keys twice, so this is decided by the value.
 */
export function programSetting(text: string) {
  const state = { section: undefined as string | undefined, named: false }
  for (const line of text.split("\n")) {
    if (CONTROL.test(line)) return "a line it cannot read for certain"
    if (COMMENT.test(line)) continue
    const section = line.match(SECTION)
    if (section) {
      state.section = section[1]!.toLowerCase()
      state.named = section[2] !== undefined
      continue
    }
    const entry = line.match(ENTRY)
    if (!entry || state.section === undefined) return "a line it cannot read for certain"
    const variable = entry[1]!.toLowerCase()
    const key = `${state.section}.${variable}`
    if (state.named ? NAMED_KEYS.has(key) || key === "submodule.url" : PLAIN_KEYS.has(key)) continue
    if (!CANNOT_NAME_A_PROGRAM.test(line.match(VALUE)?.[1] ?? "")) return `${state.section}${state.named ? ".*" : ""}.${variable}`
  }
  return undefined
}
