import os from "node:os"

// 1.2.9 row 45a (C61): the home folder is replaced only at a path boundary: followed by the end of the text or by a
// character that cannot continue a path segment. `/Users/xy/z` is a sibling account, not the home `/Users/x`.
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
function replaceRoot(text: string, root: { path: string; label: string }, bounded: boolean) {
  if (!bounded) return text.split(root.path).join(root.label)
  return text.replace(new RegExp(escape(root.path) + "(?![\\w.@+~-])", "g"), () => root.label)
}

/**
 * 1.2.9 row 45 (AC-B06, N9-083): the one log-path scrubber. It replaces the two drifted copies that lived in
 * `memory/vault-mirror.ts` and `server/routes/instance/httpapi/handlers/project.ts`.
 *
 * A text that is going into a log line loses its absolute paths:
 * - R1 every occurrence of a root's `path` becomes its `label`, roots in the given order; the home folder is always
 *   the last root (`~`, S9-07), so an account name is removed whatever character precedes the path. Roots whose
 *   path is empty or `"/"` are ignored.
 * - R2 a single-quoted absolute path becomes `'<path>'`.
 * - R3 a bare absolute path becomes `<path>`, unless the character before it is in `[\w.~-]` (C8) or the text before
 *   it ends with a label from R1 (the `<vault>/notes/a.md` form). Residual: a path glued to `-`, `.`, `~` or a word
 *   character stays, without the account name (RN-15).
 */
export function withoutPaths(text: string, roots: readonly { path: string; label: string }[] = []): string {
  const home = { path: os.homedir(), label: "~" }
  const applied = [...roots, home].filter((root) => root.path.length > 1)
  const labels = applied.map((root) => root.label).filter((label) => label.length > 0)
  return applied
    .reduce((out, root) => replaceRoot(out, root, root === home), text)
    .replace(/'(?:[A-Za-z]:)?[\\/][^']*'/g, "'<path>'")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`,;)]*/g, (match, offset: number, whole: string) => {
      if (offset === 0) return "<path>"
      if (/[\w.~-]/.test(whole[offset - 1]!)) return match
      const before = whole.slice(0, offset)
      return labels.some((label) => before.endsWith(label)) ? match : "<path>"
    })
}
