// Turns what someone actually types ("which session fixed that login bug?", "what did we decide about the database
// last month") into what the index can answer. Pure: no clock, file or database access, so every rule here is tested.

/** Words that say nothing about the subject. English and Indonesian: the two languages this product's users write in. */
const STOP = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my no not of on " +
    "or our shall should so than that the their them then there these they this those to us was we were what when where which " +
    "while who whom why will with would you your about again any some agent agents session sessions swarm thing things happen happened happening " +
    "ada adalah agar agen akan apa atau bagaimana bagian dalam dan dari dengan di dia ini itu kami kapan karena kenapa ke kita " +
    "mana mengapa nya oleh pada saat saya sebuah sesi siapa sudah tadi tentang terjadi untuk yang"
  ).split(" "),
)

/** Words about what happened rather than what it happened to: they rank a result but never exclude one. */
const FIX = new Set(
  "fix fixed fixes fixing solve solved resolve resolved repair repaired perbaiki memperbaiki diperbaiki perbaikan benerin".split(" "),
)
const DECIDE = new Set(
  "decide decided decides decision decisions chose choose chosen pick picked memutuskan diputuskan keputusan memilih dipilih".split(" "),
)
const GENERIC = new Set(
  "bug bugs error errors issue issues problem problems change changed changes changing masalah galat ubah diubah mengubah perubahan".split(" "),
)

const DAY = 86_400_000
const MONTHS = [
  ["january", "januari", "jan"],
  ["february", "februari", "feb"],
  ["march", "maret", "mar"],
  ["april", "apr"],
  ["may", "mei"],
  ["june", "juni", "jun"],
  ["july", "juli", "jul"],
  ["august", "agustus", "aug", "agu"],
  ["september", "sep", "sept"],
  ["october", "oktober", "oct", "okt"],
  ["november", "nov"],
  ["december", "desember", "dec", "des"],
]

export type Range = { from: number; to: number }

/** One thing to look for. Several tokens must appear next to each other: `session.ts` means "session" then "ts". */
export type Term = { tokens: string[]; prefix: boolean }

export type Parsed = {
  /** The subject. Ranking is by how many of these a session covers. */
  terms: Term[]
  /** Words like "bug" or "fixed": rank higher, never exclude. */
  soft: Term[]
  intent?: "fix" | "decide"
  range?: Range
  /** Set when the query is a file, optionally with a line: `src/auth/login.ts:42`. */
  file?: { path: string; line?: number }
}

export function parse(text: string, now: number): Parsed {
  const file = parseFile(text.trim())
  if (file) return { terms: [termFromText(file.path, false)], soft: [], file }

  const dated = parseRange(text, now)
  const chunks = [...dated.text.matchAll(/"([^"]+)"|(\S+)/g)]
  // While typing, the last word is probably unfinished. A trailing space or closing quote says it is complete.
  const typing = /[^\s"]$/.test(dated.text)
  const words = chunks.map((match, index) => ({
    term: termFromText(match[1] ?? match[2], !match[1] && typing && index === chunks.length - 1),
    quoted: !!match[1],
  }))
  const usable = words.filter((word) => word.term.tokens.length > 0)
  const single = (word: (typeof usable)[number]) => word.term.tokens.length === 1 && !word.quoted
  const stopped = usable.filter((word) => !(single(word) && STOP.has(word.term.tokens[0])))
  const isSoft = (word: (typeof usable)[number]) =>
    single(word) && [FIX, DECIDE, GENERIC].some((set) => set.has(word.term.tokens[0]))
  const hard = stopped.filter((word) => !isSoft(word))
  const soft = stopped.filter(isSoft)
  const intent = soft.some((word) => DECIDE.has(word.term.tokens[0]))
    ? ("decide" as const)
    : soft.some((word) => FIX.has(word.term.tokens[0]))
      ? ("fix" as const)
      : undefined

  if (hard.length > 0) return { terms: hard.map((word) => word.term), soft: soft.map((word) => word.term), intent, range: dated.range }
  if (soft.length > 0) return { terms: soft.map((word) => word.term), soft: [], intent, range: dated.range }
  // "what happened yesterday" has no subject and a date: that is a list. "what is it" has neither, so search it as typed.
  if (dated.range) return { terms: [], soft: [], range: dated.range }
  return { terms: usable.map((word) => word.term), soft: [], range: dated.range }
}

/** FTS5 query text for one term. Quoting is what makes arbitrary pasted text safe: nothing typed can become an operator. */
export function matchTerm(term: Term) {
  return `"${term.tokens.join(" ")}"${term.prefix ? " *" : ""}`
}

export function matchAll(terms: Term[]) {
  return terms.map(matchTerm).join(" AND ")
}

export function matchAny(terms: Term[]) {
  return terms.map(matchTerm).join(" OR ")
}

/** Tokens the way the index's tokenizer sees them: letters and digits of any script, split on everything else. */
export function tokens(text: string) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 24)
}

function termFromText(text: string, prefix: boolean): Term {
  const found = tokens(text)
  return { tokens: found, prefix: prefix && found.length > 0 && found.at(-1)!.length >= 2 }
}

function parseFile(text: string): Parsed["file"] {
  if (/\s/.test(text.replace(/\s+(?:line|baris)\s+\d+$/i, ""))) return
  const match = text.match(/^(.+?)(?:(?::|#L|\s+(?:line|baris)\s+)(\d+))?(?::\d+)?$/i)
  if (!match) return
  const path = match[1]
  const line = match[2] ? Number(match[2]) : undefined
  // A path needs a separator or a file extension, otherwise every single word would be "a file".
  if (!path.includes("/") && !path.includes("\\") && !/\.[a-z0-9]{1,8}$/i.test(path)) return
  // A URL or a version number is not a file.
  if (/^[a-z]+:\/\//i.test(path) || /^v?\d+(\.\d+)+$/i.test(path)) return
  return { path: path.replace(/\\/g, "/"), line }
}

function parseRange(text: string, now: number): { text: string; range?: Range } {
  const lower = text.toLowerCase()
  const rules: Array<[RegExp, (match: RegExpMatchArray) => Range | undefined]> = [
    [/\b(?:hari ini|today)\b/, () => dayRange(now, 0)],
    [/\b(?:kemarin|yesterday)\b/, () => dayRange(now, 1)],
    [/\b(\d{1,3}) (?:days ago|hari (?:lalu|yang lalu))\b/, (match) => dayRange(now, Number(match[1]))],
    [/\b(?:last week|minggu lalu|pekan lalu)\b/, () => weekRange(now, 1)],
    [/\b(?:this week|minggu ini|pekan ini)\b/, () => weekRange(now, 0)],
    [/\b(?:last month|bulan lalu)\b/, () => monthRange(now, 1)],
    [/\b(?:this month|bulan ini)\b/, () => monthRange(now, 0)],
    [
      new RegExp(`\\b(?:in|bulan) (${MONTHS.flat().join("|")})\\b`),
      (match) => namedMonthRange(now, MONTHS.findIndex((names) => names.includes(match[1]))),
    ],
  ]
  for (const [pattern, range] of rules) {
    const match = lower.match(pattern)
    if (!match || match.index === undefined) continue
    const found = range(match)
    if (!found) continue
    return { text: `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`, range: found }
  }
  return { text }
}

function startOfDay(time: number) {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayRange(now: number, daysAgo: number): Range {
  const date = new Date(startOfDay(now))
  date.setDate(date.getDate() - daysAgo)
  const from = date.getTime()
  date.setDate(date.getDate() + 1)
  return { from, to: date.getTime() }
}

function weekRange(now: number, weeksAgo: number): Range {
  const date = new Date(startOfDay(now))
  // Weeks start on Monday, which is how both ISO and Indonesian calendars count them.
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7) - weeksAgo * 7)
  const from = date.getTime()
  date.setDate(date.getDate() + 7)
  return { from, to: Math.min(date.getTime(), startOfDay(now) + DAY) }
}

function monthRange(now: number, monthsAgo: number): Range {
  const date = new Date(now)
  const from = new Date(date.getFullYear(), date.getMonth() - monthsAgo, 1).getTime()
  const to = new Date(date.getFullYear(), date.getMonth() - monthsAgo + 1, 1).getTime()
  return { from, to: Math.min(to, startOfDay(now) + DAY) }
}

/** A bare month name means its most recent occurrence: in February, "in march" is last March. */
function namedMonthRange(now: number, month: number): Range | undefined {
  if (month < 0) return
  const date = new Date(now)
  const year = month > date.getMonth() ? date.getFullYear() - 1 : date.getFullYear()
  return { from: new Date(year, month, 1).getTime(), to: new Date(year, month + 1, 1).getTime() }
}

export * as SessionSearchQuery from "./query"
