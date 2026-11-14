import { Global } from "@opencode-ai/core/global"

/**
 * 1.2.9 row 45 (AC-B06, N9-083): the one log-path scrubber. It replaces the two drifted copies that lived in
 * `memory/vault-mirror.ts` and `server/routes/instance/httpapi/handlers/project.ts`.
 *
 * A text that is going into a log line loses its absolute paths, in this order (spec R1 order amended by C79, row 67b):
 * - R1 every occurrence of a given root's `path` becomes its `label`, roots in the given order. Roots whose path is
 *   empty or `"/"` are ignored.
 * - R2 a single-quoted absolute path becomes `'<path>'`.
 * - R3 a bare absolute path becomes `<path>`, unless the character before it is in `[\w.~-]` (C8) or the text before
 *   it ends with a label from R1 (the `<vault>/notes/a.md` form).
 * - Home LAST: the home folder (`Global.Path.home`) becomes `~` only in what R2/R3 left, i.e. a path glued to
 *   `[\w.~-]` (S9-07 `a -~/y`, `git -C~/repo`). A path under home is therefore `<path>`, so no folder name below the
 *   home folder reaches a log line (1.2.8 behaviour). Residual RN-15: a glued path keeps its folders after `~`.
 */
export function withoutPaths(text: string, roots: readonly { path: string; label: string }[] = []): string {
  const applied = roots.filter((root) => root.path.length > 1)
  const labels = applied.map((root) => root.label).filter((label) => label.length > 0)
  const scrubbed = applied
    .reduce((out, root) => out.split(root.path).join(root.label), text)
    .replace(/'(?:[A-Za-z]:)?[\\/][^']*'/g, "'<path>'")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`,;)]*/g, (match, offset: number, whole: string) => {
      if (offset === 0) return "<path>"
      if (/[\w.~-]/.test(whole[offset - 1]!)) return match
      const before = whole.slice(0, offset)
      return labels.some((label) => before.endsWith(label)) ? match : "<path>"
    })
  return replaceHome(scrubbed, Global.Path.home, "~")
}

/**
 * 1.2.9 rows 45a/67d (C61, C79): the one home-folder replacer, shared by `withoutPaths` and the vault mirror's
 * `withoutHome`. `home` is replaced only at a path boundary: not followed by a character that continues a path
 * segment (`[\w.@+~-]`), so `/Users/xy`, `/Users/x.old` or `/Users/x@b` (a sibling) is not the home `/Users/x`.
 * `escaped` is for Markdown-escaped text (`escapeText`), where that character may carry a backslash in front.
 * A home of `""` or `"/"` is ignored.
 */
export function replaceHome(text: string, home: string, label: string, escaped = false): string {
  if (home.length <= 1) return text
  const tail = escaped ? "(?!\\\\?[\\w.@+~-])" : "(?![\\w.@+~-])"
  return text.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + tail, "g"), () => label)
}
