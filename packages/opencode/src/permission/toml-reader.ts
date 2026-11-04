// Swarm 1.1.1 F33 (P48): a small TOML reader for the manifests and deploy config the consent reads (`Cargo.toml`,
// `pyproject.toml`, `netlify.toml`; other tools' config files are judged by presence since F36). The packaged app's server
// runs on Node, where the Bun global's TOML parser does not exist, so this takes no runtime global. It does not build values: it lists every
// `key = value` with its full dotted path (table header plus key) and the value's text as written. A file it cannot walk
// with certainty gives undefined, and every caller treats that as a setting it cannot rule out (the call is held).

/**
 * One `key = value`: the full path (table segments, then key segments) and the value's text as written. `table` marks a
 * table header (`[a.b]` or `[[a.b]]`), listed with an empty `raw` so that a table with no key in it is seen too (G14-7);
 * 1.1.1 F39 (n85): `array` marks an array-of-tables header (`[[a.b]]`).
 */
export type Entry = {
  readonly path: readonly string[]
  readonly raw: string
  readonly table: boolean
  readonly array: boolean
  /**
   * 1.1.1 F38: the key as written in the file, before any escape is decoded (a table header's name between its
   * brackets, or the key before its `=`), so a caller can judge the spelling itself and not only the decoded path.
   */
  readonly key: string
}

const BARE = /[A-Za-z0-9_-]/

/** Every entry of `text`, in file order, or undefined when any part of it cannot be read with certainty. */
export function entries(text: string): Entry[] | undefined {
  const found: Entry[] = []
  const at = { i: 0 }
  let table: string[] = []
  while (true) {
    skipBlank(text, at)
    if (at.i >= text.length) return found
    if (text[at.i] === "[") {
      const double = text[at.i + 1] === "["
      at.i += double ? 2 : 1
      const keyStart = at.i
      const name = key(text, at)
      if (!name) return undefined
      const written = text.slice(keyStart, at.i).trim()
      skipSpace(text, at)
      const close = double ? "]]" : "]"
      if (!text.startsWith(close, at.i)) return undefined
      at.i += close.length
      if (!lineEnd(text, at)) return undefined
      table = name
      found.push({ path: name, raw: "", table: true, array: double, key: written })
      continue
    }
    const pair = keyValue(text, at)
    if (!pair) return undefined
    found.push({ ...pair, path: [...table, ...pair.path], table: false, array: false })
    if (!lineEnd(text, at)) return undefined
  }
}

/**
 * 1.1.1 F39 (CR15-1): the `key = value` pairs of an inline table (`{ file = "R.md", content-type = "text/markdown" }`),
 * one level deep, or undefined for any other value or one that cannot be read with certainty.
 */
export function table(raw: string): { path: string[]; raw: string; key: string }[] | undefined {
  if (!raw.startsWith("{")) return undefined
  const found: { path: string[]; raw: string; key: string }[] = []
  const at = { i: 1 }
  while (true) {
    skipBlank(raw, at)
    if (raw[at.i] === "}") return at.i === raw.length - 1 ? found : undefined
    const pair = keyValue(raw, at)
    if (!pair) return undefined
    found.push(pair)
    skipBlank(raw, at)
    if (raw[at.i] === ",") at.i++
    else if (raw[at.i] !== "}") return undefined
  }
}

/** One `key = value` at `at`: the key's segments, its text as written, and the value's text. */
function keyValue(source: string, at: { i: number }) {
  const keyStart = at.i
  const name = key(source, at)
  if (!name) return undefined
  const written = source.slice(keyStart, at.i).trim()
  skipSpace(source, at)
  if (source[at.i] !== "=") return undefined
  at.i++
  skipSpace(source, at)
  const start = at.i
  if (!value(source, at)) return undefined
  return { path: name, raw: source.slice(start, at.i), key: written }
}

/** A one-line string value (`"…"` or `'…'`) as TOML reads it; undefined for anything else (a multi-line string too). */
export function string(raw: string): string | undefined {
  if (raw.startsWith('"""') || raw.startsWith("'''")) return undefined
  if (raw.startsWith("'")) return raw.endsWith("'") && raw.length >= 2 ? raw.slice(1, -1) : undefined
  if (!raw.startsWith('"')) return undefined
  try {
    // A basic string's escapes are JSON's, but for `\e` and `\U…`; those fail here and the value is not read.
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "string" ? parsed : undefined
  } catch {
    return undefined
  }
}

/** An array of one-line strings (`["a", 'b']`), or undefined for any other value. 1.1.1 F39 (CR15-1): the file lists. */
export function strings(raw: string): string[] | undefined {
  if (!raw.startsWith("[")) return undefined
  const items: string[] = []
  const at = { i: 1 }
  while (true) {
    skipBlank(raw, at)
    if (raw[at.i] === "]") return at.i === raw.length - 1 ? items : undefined
    const start = at.i
    if (raw[at.i] !== '"' && raw[at.i] !== "'") return undefined
    if (!quoted(raw, at)) return undefined
    const item = string(raw.slice(start, at.i))
    if (item === undefined) return undefined
    items.push(item)
    skipBlank(raw, at)
    if (raw[at.i] === ",") at.i++
    else if (raw[at.i] !== "]") return undefined
  }
}

function skipSpace(source: string, at: { i: number }) {
  while (source[at.i] === " " || source[at.i] === "\t") at.i++
}

/** Spaces, line ends and comment lines. */
function skipBlank(source: string, at: { i: number }) {
  while (at.i < source.length) {
    const char = source[at.i]
    if (char === " " || char === "\t" || char === "\r" || char === "\n") at.i++
    else if (char === "#") while (at.i < source.length && source[at.i] !== "\n") at.i++
    else return
  }
}

/** The rest of the line is blank or a comment; moves past its end. */
function lineEnd(source: string, at: { i: number }) {
  skipSpace(source, at)
  if (source[at.i] === "#") while (at.i < source.length && source[at.i] !== "\n") at.i++
  if (source[at.i] === "\r") at.i++
  if (at.i >= source.length) return true
  if (source[at.i] !== "\n") return false
  at.i++
  return true
}

/** A dotted key (`a.b`, `"a.b".c`, `'x'`), as its segments. */
function key(source: string, at: { i: number }): string[] | undefined {
  const parts: string[] = []
  while (true) {
    skipSpace(source, at)
    const start = at.i
    if (source[at.i] === '"' || source[at.i] === "'") {
      if (source.startsWith(source[at.i]!.repeat(3), at.i)) return undefined
      if (!quoted(source, at)) return undefined
      const part = string(source.slice(start, at.i))
      if (part === undefined) return undefined
      parts.push(part)
    } else {
      while (at.i < source.length && BARE.test(source[at.i]!)) at.i++
      if (at.i === start) return undefined
      parts.push(source.slice(start, at.i))
    }
    skipSpace(source, at)
    if (source[at.i] !== ".") return parts
    at.i++
  }
}

/** Moves past one quoted string (one-line or multi-line, basic or literal); false when it does not close. */
function quoted(source: string, at: { i: number }) {
  const mark = source[at.i]!
  const triple = source.startsWith(mark.repeat(3), at.i)
  const close = triple ? mark.repeat(3) : mark
  at.i += close.length
  while (at.i < source.length) {
    const char = source[at.i]!
    if (mark === '"' && char === "\\") {
      at.i += 2
      continue
    }
    if (!triple && char === "\n") return false
    if (source.startsWith(close, at.i)) {
      at.i += close.length
      // A multi-line string may end in up to two more quote marks of its own.
      if (triple) while (source[at.i] === mark) at.i++
      return true
    }
    at.i++
  }
  return false
}

/** Moves past one value: a string, an array, an inline table, or a plain word (number, boolean, date). */
function value(source: string, at: { i: number }): boolean {
  const char = source[at.i]
  if (char === '"' || char === "'") return quoted(source, at)
  if (char === "[") {
    at.i++
    while (true) {
      skipBlank(source, at)
      if (source[at.i] === "]") {
        at.i++
        return true
      }
      if (!value(source, at)) return false
      skipBlank(source, at)
      if (source[at.i] === ",") at.i++
      else if (source[at.i] !== "]") return false
    }
  }
  if (char === "{") {
    at.i++
    while (true) {
      skipBlank(source, at)
      if (source[at.i] === "}") {
        at.i++
        return true
      }
      if (!key(source, at)) return false
      skipSpace(source, at)
      if (source[at.i] !== "=") return false
      at.i++
      skipSpace(source, at)
      if (!value(source, at)) return false
      skipBlank(source, at)
      if (source[at.i] === ",") at.i++
      else if (source[at.i] !== "}") return false
    }
  }
  const start = at.i
  // A date written with a space before its time is not read (the line then does not end where it should: undefined).
  while (at.i < source.length && /[A-Za-z0-9_.:+-]/.test(source[at.i]!)) at.i++
  return at.i > start
}

export * as TomlReader from "./toml-reader"
