import { describe, expect, test } from "bun:test"
import { SessionSearchQuery } from "../../src/session/search/query"

// A Friday in the middle of a month.
const NOW = new Date(2026, 9, 16, 14, 30).getTime()
const words = (terms: SessionSearchQuery.Term[]) => terms.map((term) => term.tokens.join(" "))
const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime()

describe("SessionSearchQuery.parse", () => {
  test("a question keeps its subject and treats what happened as a ranking hint", () => {
    const parsed = SessionSearchQuery.parse("which session fixed that login bug?", NOW)
    expect(words(parsed.terms)).toEqual(["login"])
    expect(words(parsed.soft)).toEqual(["fixed", "bug"])
    expect(parsed.intent).toBe("fix")
  })

  test("a question about a decision is recognised, in either language", () => {
    expect(SessionSearchQuery.parse("what did the agent decide about the database", NOW).intent).toBe("decide")
    const id = SessionSearchQuery.parse("apa keputusan tentang database", NOW)
    expect(id.intent).toBe("decide")
    expect(words(id.terms)).toEqual(["database"])
  })

  test("Indonesian filler words are dropped", () => {
    expect(words(SessionSearchQuery.parse("kenapa kita pakai redis untuk antrian ", NOW).terms)).toEqual([
      "pakai",
      "redis",
      "antrian",
    ])
  })

  test("only soft words left means they are the subject", () => {
    const parsed = SessionSearchQuery.parse("the error ", NOW)
    expect(words(parsed.terms)).toEqual(["error"])
    expect(parsed.soft).toEqual([])
  })

  test("only stop words left searches them as typed rather than nothing", () => {
    expect(words(SessionSearchQuery.parse("what is it ", NOW).terms)).toEqual(["what", "is", "it"])
  })

  test("the last word is a prefix only while it is being typed", () => {
    expect(SessionSearchQuery.parse("refactor logi", NOW).terms.map((term) => term.prefix)).toEqual([false, true])
    expect(SessionSearchQuery.parse("refactor login ", NOW).terms.map((term) => term.prefix)).toEqual([false, false])
    expect(SessionSearchQuery.parse('"refactor login"', NOW).terms[0].prefix).toBe(false)
  })

  test("identifiers and punctuation become adjacent tokens", () => {
    expect(words(SessionSearchQuery.parse("resolve_tenant_slug foo-bar ", NOW).terms)).toEqual([
      "resolve tenant slug",
      "foo bar",
    ])
  })

  test("a quoted phrase stays one term even if it is a stop word", () => {
    expect(words(SessionSearchQuery.parse('"the" cookie ', NOW).terms)).toEqual(["the", "cookie"])
  })

  test("dates are taken out of the words and become a range", () => {
    const parsed = SessionSearchQuery.parse("database last month", NOW)
    expect(words(parsed.terms)).toEqual(["database"])
    expect(parsed.range).toEqual({ from: day(2026, 8, 1), to: day(2026, 9, 1) })
    expect(SessionSearchQuery.parse("x bulan lalu", NOW).range).toEqual(parsed.range)
    expect(SessionSearchQuery.parse("x yesterday", NOW).range).toEqual({ from: day(2026, 9, 15), to: day(2026, 9, 16) })
    expect(SessionSearchQuery.parse("x kemarin", NOW).range).toEqual({ from: day(2026, 9, 15), to: day(2026, 9, 16) })
    expect(SessionSearchQuery.parse("x 3 days ago", NOW).range).toEqual({ from: day(2026, 9, 13), to: day(2026, 9, 14) })
  })

  test("last week runs Monday to Monday", () => {
    expect(SessionSearchQuery.parse("x last week", NOW).range).toEqual({ from: day(2026, 9, 5), to: day(2026, 9, 12) })
    expect(SessionSearchQuery.parse("x minggu lalu", NOW).range).toEqual({ from: day(2026, 9, 5), to: day(2026, 9, 12) })
  })

  test("a named month means its most recent occurrence", () => {
    expect(SessionSearchQuery.parse("x in march", NOW).range).toEqual({ from: day(2026, 2, 1), to: day(2026, 3, 1) })
    expect(SessionSearchQuery.parse("x in november", NOW).range).toEqual({ from: day(2025, 10, 1), to: day(2025, 11, 1) })
  })

  test("a date with no subject is a list", () => {
    const parsed = SessionSearchQuery.parse("what happened yesterday", NOW)
    expect(parsed.range).toBeDefined()
    expect(parsed.terms).toEqual([])
    expect(SessionSearchQuery.parse("yesterday", NOW).terms).toEqual([])
    expect(SessionSearchQuery.parse("apa yang terjadi kemarin", NOW).terms).toEqual([])
  })

  test("recognises a file and a line in the forms people paste", () => {
    expect(SessionSearchQuery.parse("src/auth/login.ts:42", NOW).file).toEqual({ path: "src/auth/login.ts", line: 42 })
    expect(SessionSearchQuery.parse("src/auth/login.ts:42:7", NOW).file).toEqual({ path: "src/auth/login.ts", line: 42 })
    expect(SessionSearchQuery.parse("src/auth/login.ts#L42", NOW).file).toEqual({ path: "src/auth/login.ts", line: 42 })
    expect(SessionSearchQuery.parse("login.ts line 42", NOW).file).toEqual({ path: "login.ts", line: 42 })
    expect(SessionSearchQuery.parse("login.ts baris 42", NOW).file).toEqual({ path: "login.ts", line: 42 })
    expect(SessionSearchQuery.parse("src\\auth\\login.ts", NOW).file).toEqual({ path: "src/auth/login.ts", line: undefined })
  })

  test("words, URLs and versions are not files", () => {
    expect(SessionSearchQuery.parse("login", NOW).file).toBeUndefined()
    expect(SessionSearchQuery.parse("fix src/auth.ts please", NOW).file).toBeUndefined()
    expect(SessionSearchQuery.parse("https://example.com/a.html", NOW).file).toBeUndefined()
    expect(SessionSearchQuery.parse("1.2.3", NOW).file).toBeUndefined()
  })
})

describe("SessionSearchQuery.matchTerm", () => {
  test("nothing typed can become an FTS operator", () => {
    const parsed = SessionSearchQuery.parse('NEAR(a b) AND OR NOT "unbalanced * col:umn ^x', NOW)
    for (const term of parsed.terms) {
      expect(term.tokens.every((token) => /^[\p{L}\p{N}]+$/u.test(token))).toBe(true)
      expect(SessionSearchQuery.matchTerm(term).startsWith('"')).toBe(true)
    }
  })
})
