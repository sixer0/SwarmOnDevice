/**
 * FTS5 query translator (spec §5.3). Raw user text never reaches `MATCH`:
 * every term is a quoted FTS5 string (so AND, OR, NOT, NEAR, *, :, ^, (, ) in user text are literal),
 * websearch-style operators are mapped:
 *   "a b"   -> phrase "a b"
 *   w       -> "w"
 *   or / OR between terms -> OR
 *   -w / -"a b" -> NOT "w"   (inside its OR-group)
 *   anything else -> implicit AND
 * Embedded `"` is doubled. Control characters (incl. NUL) become spaces. Terms with no letter or
 * digit are dropped (unicode61 would yield no token). An OR-group with only negated terms is
 * dropped: FTS5 has no unary NOT, and Postgres' "all documents without w" has no FTS5 form; the
 * documented outcome is fewer hits, never an error. No terms left -> null (caller returns hits: []).
 */
export interface FtsTerm {
  text: string
  negated: boolean
}

const HAS_TOKEN = /[\p{L}\p{N}]/u
// Control characters, built with RegExp so the source file holds no raw control bytes.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]", "g")

/** Split websearch-style text into OR-groups of terms. Pure. */
export function parseWebsearch(raw: string): FtsTerm[][] {
  const s = raw.replace(CONTROL, " ")
  const groups: FtsTerm[][] = [[]]
  let i = 0
  let pendingOr = false
  while (i < s.length) {
    const ch = s[i]!
    if (/\s/.test(ch)) {
      i++
      continue
    }
    let negated = false
    if (ch === "-" && i + 1 < s.length && !/\s/.test(s[i + 1]!)) {
      negated = true
      i++
    }
    let text: string
    let quoted = false
    if (s[i] === '"') {
      quoted = true
      const end = s.indexOf('"', i + 1)
      text = end === -1 ? s.slice(i + 1) : s.slice(i + 1, end)
      i = end === -1 ? s.length : end + 1
    } else {
      let j = i
      while (j < s.length && !/\s/.test(s[j]!) && s[j] !== '"') j++
      text = s.slice(i, j)
      i = j
    }
    if (!quoted && !negated && text.toLowerCase() === "or") {
      // `or` between two terms; leading/trailing/doubled `or` is ignored (as websearch_to_tsquery)
      if (groups[groups.length - 1]!.length > 0) pendingOr = true
      continue
    }
    if (!HAS_TOKEN.test(text)) continue
    if (pendingOr) {
      groups.push([])
      pendingOr = false
    }
    groups[groups.length - 1]!.push({ text, negated })
  }
  return groups.filter((g) => g.length > 0)
}

function quote(t: string): string {
  return `"${t.replace(/"/g, '""')}"`
}

/** Translate raw text to an FTS5 MATCH string, or null when nothing searchable is left. */
export function translateFtsQuery(raw: string): string | null {
  const parts: string[] = []
  for (const g of parseWebsearch(raw)) {
    const pos = g.filter((t) => !t.negated).map((t) => quote(t.text))
    const neg = g.filter((t) => t.negated).map((t) => quote(t.text))
    if (pos.length === 0) continue
    let expr = pos.length === 1 ? pos[0]! : `(${pos.join(" AND ")})`
    for (const n of neg) expr = `${expr} NOT ${n}`
    parts.push(neg.length > 0 ? `(${expr})` : expr)
  }
  if (parts.length === 0) return null
  return parts.join(" OR ")
}
