import { Global } from "@opencode-ai/core/global"

/**
 * 1.2.9 row 45 (AC-B06, N9-083): the one log-path scrubber. It replaces the two drifted copies that lived in
 * `memory/vault-mirror.ts` and `server/routes/instance/httpapi/handlers/project.ts`.
 *
 * A text that is going into a log line loses its absolute paths, in this order (spec R1 order amended by C79, row 67b):
 * - Decode first (1.2.10 row 67, B10-04 (1)): `%2F`/`%2f` becomes `/` and `%5C`/`%5c` becomes `\`; nothing else.
 * - R1 every occurrence of a given root's `path` becomes its `label`, roots in the given order. Roots whose path is
 *   empty or `"/"` are ignored.
 * - `file:` URLs (B10-04 (2), C27/S10-34): `file:` (any case) followed by a separator, up to the R3 end set, becomes
 *   `file:<path>`. No other scheme is touched (`https://…` keeps its debug value and holds no home path).
 * - R2 a single-quoted absolute path becomes `'<path>'`.
 * - R3 a bare absolute path becomes `<path>`, unless the character before it is in `[\w.~-]` (C8) or the text before
 *   it ends with a label from R1 (the `<vault>/notes/a.md` form). In such a glued path (B10-04 (3), S10-35) the first
 *   home folder at a path boundary and everything after it becomes `~`, `~/`, `~/<path>` or `~` + a dot tail
 *   (S9-07 `a -~/<path>`, `git -C~/<path>`, `vscode://file~/<path>`); a glued path without home stays as it is.
 * - Home LAST: the home folder (`Global.Path.home`) becomes `~` in what is left. The home folder is matched case-folded
 *   on darwin and win32 (`replaceHome`). So no folder name below the home folder reaches a log line.
 * Known limit (RN-22): an unquoted path with a space keeps the folder fragment after the space (no account name).
 */
export function withoutPaths(text: string, roots: readonly { path: string; label: string }[] = []): string {
  const applied = roots.filter((root) => root.path.length > 1)
  const labels = applied.map((root) => root.label).filter((label) => label.length > 0)
  const home = Global.Path.home
  const scrubbed = applied
    .reduce((out, root) => out.split(root.path).join(root.label), decodeSeparators(text))
    .replace(/(file:)[\\/][^\s'"`,;)]*/gi, "$1<path>")
    .replace(/'(?:[A-Za-z]:)?[\\/][^']*'/g, "'<path>'")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`,;)]*/g, (match, offset: number, whole: string) => {
      if (offset === 0) return "<path>"
      if (/[\w.~-]/.test(whole[offset - 1]!)) return gluedUnderHome(match, home)
      const before = whole.slice(0, offset)
      return labels.some((label) => before.endsWith(label)) ? match : "<path>"
    })
  return replaceHome(scrubbed, home, "~")
}

/** 1.2.10 row 67 (B10-04 (1), N10-106): only the two encoded separators are decoded, before the path rules. */
function decodeSeparators(text: string): string {
  return text.replace(/%2F/gi, "/").replace(/%5C/gi, "\\")
}

/**
 * 1.2.10 row 67 (B10-04 (3), S10-35): a path glued to the previous character. The first home folder at a path
 * boundary inside it, and everything after it, becomes `~` (nothing after), `~` + the separator (only a separator),
 * `~` + the separator + `<path>` (more after the separator) or `~` + the dot tail (`.` then only `)` `,` `;` `]`).
 * A glued path without the home folder, or with any other remainder, is returned as it is.
 */
function gluedUnderHome(match: string, home: string): string {
  if (home.length <= 1) return match
  const found = homePattern(home, false, "").exec(match)
  if (!found) return match
  const rest = match.slice(found.index + found[0].length)
  const tail =
    rest === "" || /^[\\/]$/.test(rest) || /^\.[\]),;]*$/.test(rest)
      ? rest
      : /^[\\/]/.test(rest)
        ? rest[0] + "<path>"
        : undefined
  return tail === undefined ? match : match.slice(0, found.index) + "~" + tail
}

/** The home folder at a path boundary (see `replaceHome`); `flags` gains `i` on darwin and win32. */
function homePattern(home: string, escaped: boolean, flags: string, platform: string = process.platform): RegExp {
  // A `.` ends the home folder when followed by whitespace, the end of the text, or `)` `,` `;` `]` (row 67, B10-04 (4)).
  const tail = escaped
    ? "(?!\\\\?[\\w@+~-]|\\\\?\\.(?!\\s|$|\\\\?[),;\\]]))"
    : "(?![\\w@+~-]|\\.(?!\\s|$|[),;\\]]))"
  const fold = platform === "darwin" || platform === "win32" ? "i" : ""
  return new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + tail, flags + fold)
}

/**
 * 1.2.9 rows 45a/67d (C61, C79): the one home-folder replacer, shared by `withoutPaths` and the vault mirror's
 * `withoutHome`. `home` is replaced only at a path boundary: not followed by a character that continues a path
 * segment (`[\w.@+~-]`), so `/Users/xy`, `/Users/x.old` or `/Users/x@b` (a sibling) is not the home `/Users/x`.
 * Row 67i (C85): a `.` followed by whitespace or the end of the text ends a sentence, not a segment, so
 * `… in /Users/x.` becomes `… in ~.` while `/Users/x.y` is still left as is. 1.2.10 row 67 (B10-04 (4)): a `.`
 * followed by `)` `,` `;` or `]` ends it too (`in /Users/x.)` -> `in ~.)`).
 * `escaped` is for Markdown-escaped text (`escapeText`), where that character may carry a backslash in front.
 * `platform` (N10-105, B10-04 (5)): on darwin and win32 the home folder is matched case-folded (`/USERS/X` is the
 * home folder there); on any other platform the match is exact (another user's folder on Linux).
 * A home of `""` or `"/"` is ignored.
 */
export function replaceHome(
  text: string,
  home: string,
  label: string,
  escaped = false,
  platform: string = process.platform,
): string {
  if (home.length <= 1) return text
  return text.replace(homePattern(home, escaped, "g", platform), () => label)
}
