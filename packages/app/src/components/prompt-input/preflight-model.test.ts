import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import {
  appendToPrompt,
  buildItems,
  definitionPattern,
  detectChecks,
  editDistance,
  extractRefs,
  extractTerms,
  lineWindow,
  mentionsChecks,
  pickIdentifier,
  rankWordFiles,
  replaceInPrompt,
  resolveRef,
  similarSessions,
  type PreflightFacts,
} from "./preflight-model"

const facts = (over: Partial<PreflightFacts> = {}): PreflightFacts => ({
  refs: [],
  identifiers: [],
  files: [],
  dirty: [],
  busy: [],
  similar: [],
  checks: [],
  ...over,
})
const text = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]
const ref = (path: string, line?: number) => ({ raw: path, path, line, fromTrace: !!line })

describe("extractRefs", () => {
  test("reads node, python, go, rust and compiler traces", () => {
    const refs = extractRefs(
      [
        "at total (/home/ci/app/src/invoice.ts:42:7)",
        'File "app/models/user.py", line 12, in save',
        "/srv/pkg/server.go:88 +0x1d",
        "  --> src/main.rs:10:5",
        "src/types.ts(3,14): error TS2322",
      ].join("\n"),
      "/repo",
    )
    expect(refs.map((item) => [item.path, item.line])).toEqual([
      ["app/models/user.py", 12],
      ["src/types.ts", 3],
      ["/home/ci/app/src/invoice.ts", 42],
      ["/srv/pkg/server.go", 88],
      ["src/main.rs", 10],
    ])
  })

  test("makes paths relative to the project and drops vendor frames", () => {
    const refs = extractRefs(
      "at a (/repo/src/a.ts:1:1)\nat b (/repo/node_modules/x/b.js:2:2)\nat c (/usr/lib/node/c.js:3:3)\nsee ./src/d.ts",
      "/repo",
    )
    expect(refs.map((item) => item.path)).toEqual(["src/a.ts", "src/d.ts"])
  })

  test("treats macOS /private as the same folder", () => {
    expect(extractRefs("at a (/private/tmp/r/src/a.ts:1:1)", "/tmp/r")[0]?.path).toBe("src/a.ts")
  })

  test("ignores urls, product names and plain prose", () => {
    expect(extractRefs("See https://example.com/x/app.ts and upgrade Node.js, Vue.js and next.js today", "/r")).toEqual([])
    expect(extractRefs("version 1.2.3 of the thing e.g. foo", "/r")).toEqual([])
  })

  test("a line number supersedes a bare mention of the same file", () => {
    const refs = extractRefs("look at src/a.ts\nsrc/a.ts:9:1 blew up", "/r")
    expect(refs).toHaveLength(1)
    expect(refs[0]?.line).toBe(9)
  })

  test("caps how many references one paste can produce", () => {
    const paste = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts:1`).join("\n")
    expect(extractRefs(paste, "/r").length).toBe(8)
  })
})

describe("resolveRef", () => {
  test("exact match wins", () => {
    expect(resolveRef(ref("src/a.ts"), ["lib/a.ts", "src/a.ts"])).toMatchObject({ kind: "found", path: "src/a.ts" })
  })

  test("a path from another machine lands on the longest shared tail", () => {
    const result = resolveRef(ref("/home/ci/app/src/billing/total.ts", 4), ["src/billing/total.ts", "src/total.ts"])
    expect(result).toMatchObject({ kind: "found", path: "src/billing/total.ts" })
  })

  test("a bare common filename stays ambiguous rather than guessing", () => {
    expect(resolveRef(ref("index.ts"), ["a/index.ts", "b/index.ts"]).kind).toBe("ambiguous")
  })

  test("a typo gets one suggestion, a tie gets none", () => {
    expect(resolveRef(ref("src/roundng.ts"), ["src/rounding.ts"])).toMatchObject({ kind: "near", path: "src/rounding.ts" })
    expect(resolveRef(ref("src/ab12.ts"), ["src/ab13.ts", "src/ab14.ts"]).kind).toBe("missing")
    expect(resolveRef(ref("src/gone.ts"), ["src/rounding.ts"]).kind).toBe("missing")
  })

  test("edit distance", () => {
    expect(editDistance("rounding", "roundng")).toBe(1)
    expect(editDistance("abc", "abc")).toBe(0)
    expect(editDistance("", "ab")).toBe(2)
  })
})

describe("extractTerms", () => {
  test("separates code-shaped names from words and skips trace lines", () => {
    const terms = extractTerms(
      "Please fix calculateTotal in the invoice rounding and `round_half_up`\n    at x (/a/b.ts:1:1)\nTypeError: boom",
      [],
    )
    expect(terms.identifiers).toEqual(["round_half_up", "calculateTotal"])
    expect(terms.words).toContain("invoice")
    expect(terms.words).toContain("rounding")
    expect(terms.words).not.toContain("please")
    expect(terms.identifiers).not.toContain("TypeError")
  })

  test("keeps non-English words for the filename search", () => {
    expect(extractTerms("perbaiki pembulatan faktur", []).words).toEqual(["perbaiki", "pembulatan", "faktur"])
  })

  test("does not search for words that are part of a reference", () => {
    const refs = extractRefs("open src/invoice.ts", "/r")
    expect(extractTerms("open src/invoice.ts", refs).words).toEqual(["open"])
  })
})

describe("rankWordFiles", () => {
  test("needs a word in the filename and prefers more of them", () => {
    const ranked = rankWordFiles(
      {
        invoice: ["src/invoice/rounding.ts", "src/invoice/other.ts", "src/invoice.ts"],
        rounding: ["src/invoice/rounding.ts", "src/round.ts", "docs/contest.md"],
      },
      new Set(),
    )
    expect(ranked[0]?.path).toBe("src/invoice/rounding.ts")
    expect(ranked.map((item) => item.path)).not.toContain("src/invoice/other.ts")
    expect(ranked.map((item) => item.path)).not.toContain("docs/contest.md")
  })

  test("drops generated files and what is already claimed, and puts tests after source", () => {
    const ranked = rankWordFiles(
      { invoice: ["dist/invoice.js", "test/invoice.test.ts", "src/invoice.ts", "lib/invoice.py"] },
      new Set(["lib/invoice.py"]),
    )
    expect(ranked.map((item) => item.path)).toEqual(["src/invoice.ts", "test/invoice.test.ts"])
  })
})

describe("identifiers", () => {
  test("a definition beats a use, and no hit at all is said out loud", () => {
    expect(pickIdentifier("foo", [{ path: "a.ts", line: 3 }], [{ path: "b.ts", line: 1 }])).toMatchObject({
      kind: "defined",
      path: "a.ts",
    })
    expect(pickIdentifier("foo", [], [{ path: "b.ts", line: 1 }])).toMatchObject({ kind: "used", path: "b.ts" })
    expect(pickIdentifier("foo", [], [])).toEqual({ kind: "missing", identifier: "foo" })
  })

  test("the definition pattern escapes regex characters", () => {
    expect(definitionPattern("a.b$")).toContain("a\\.b\\$")
    expect(new RegExp(definitionPattern("total")).test("export function total(")).toBe(true)
    expect(new RegExp(definitionPattern("total")).test("return total")).toBe(false)
  })
})

describe("similarSessions", () => {
  const list = [
    { id: "a", title: "Fix rounding in invoice totals", updated: 10 },
    { id: "b", title: "Fix the login page", updated: 20 },
    { id: "c", title: "Invoice rounding audit", updated: 30, parentID: "x" },
    { id: "d", title: "Invoice rounding audit", updated: 30, archived: 5 },
    { id: "e", title: "Invoice", updated: 40 },
  ]
  test("two meaningful shared words and half the title", () => {
    expect(similarSessions("the invoice rounding is off by a cent", list).map((item) => item.id)).toEqual(["a"])
  })
  test("excludes the current session and sessions sharing only generic words", () => {
    expect(similarSessions("invoice rounding totals", list, "a")).toEqual([])
    expect(similarSessions("please fix the thing on the page", list)).toEqual([])
  })
})

describe("detectChecks", () => {
  test("package scripts use the project's package manager", () => {
    const json = JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc", build: "vite build" } })
    expect(detectChecks({ rootFiles: ["package.json", "bun.lock"], packageJson: json })).toEqual([
      "bun run typecheck",
      "bun run test",
    ])
    expect(detectChecks({ rootFiles: ["package.json"], packageJson: json })[0]).toBe("npm run typecheck")
  })
  test("ignores npm's placeholder test script and broken json", () => {
    const placeholder = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
    expect(detectChecks({ rootFiles: [], packageJson: placeholder })).toEqual([])
    expect(detectChecks({ rootFiles: [], packageJson: "{ nope" })).toEqual([])
  })
  test("other ecosystems", () => {
    expect(detectChecks({ rootFiles: ["Cargo.toml"] })).toEqual(["cargo test"])
    expect(detectChecks({ rootFiles: ["go.mod"] })).toEqual(["go test ./..."])
    expect(detectChecks({ rootFiles: ["pyproject.toml"] })).toEqual(["pytest"])
    expect(detectChecks({ rootFiles: ["Makefile"], makefile: "build:\n\tx\ntest: build\n\ty\n" })).toEqual(["make test"])
    expect(detectChecks({ rootFiles: ["Makefile"], makefile: "build:\n" })).toEqual([])
  })
  test("no suggestion once the draft already asks for it", () => {
    expect(mentionsChecks("then run the tests please", ["npm run test"])).toBe(true)
    expect(mentionsChecks("finish with `cargo test`", ["cargo test"])).toBe(true)
    expect(mentionsChecks("fix the login bug", ["npm run test"])).toBe(false)
  })
})

describe("prompt edits keep offsets correct", () => {
  test("replace", () => {
    const parts: Prompt = [
      { type: "text", content: "see a.ts ", start: 0, end: 9 },
      { type: "file", path: "b.ts", content: "@b.ts", start: 9, end: 14 },
      { type: "text", content: " and a.ts", start: 14, end: 23 },
    ]
    const next = replaceInPrompt(parts, "a.ts", "long/a.ts")
    expect(next.map((part) => ("content" in part ? part.content : ""))).toEqual(["see long/a.ts ", "@b.ts", " and a.ts"])
    expect(next.map((part) => ("start" in part ? [part.start, part.end] : []))).toEqual([
      [0, 14],
      [14, 19],
      [19, 28],
    ])
  })

  test("replacement text with dollar signs stays literal", () => {
    expect(replaceInPrompt(text("x"), "x", "$&$&")[0]).toMatchObject({ content: "$&$&", end: 4 })
  })

  test("append goes after a blank line and trims trailing space", () => {
    expect(appendToPrompt(text("fix it \n"), "run tests")[0]).toMatchObject({
      content: "fix it\n\nrun tests",
      end: 17,
    })
  })

  test("line window stays in the file", () => {
    expect(lineWindow(4)).toEqual({ start: 1, end: 19 })
    expect(lineWindow(100)).toEqual({ start: 85, end: 115 })
  })
})

describe("buildItems", () => {
  const base = { text: "", attached: [], dismissed: {}, isolated: false }

  test("one row per file, most specific evidence wins", () => {
    const items = buildItems({
      ...base,
      facts: facts({
        refs: [{ kind: "found", ref: ref("/ci/src/a.ts", 4), path: "src/a.ts" }],
        identifiers: [{ kind: "defined", identifier: "total", path: "src/a.ts", line: 9 }],
        files: [
          { path: "src/a.ts", words: ["a"] },
          { path: "src/b.ts", words: ["b"] },
        ],
      }),
    })
    expect(items.map((item) => [item.kind, "path" in item ? item.path : ""])).toEqual([
      ["trace", "src/a.ts"],
      ["word", "src/b.ts"],
    ])
  })

  test("attached files and dismissed rows do not come back", () => {
    const items = buildItems({
      ...base,
      attached: ["src/a.ts"],
      dismissed: { "word:src/b.ts": true },
      facts: facts({
        refs: [{ kind: "found", ref: ref("src/a.ts"), path: "src/a.ts" }],
        files: [{ path: "src/b.ts", words: ["b"] }],
      }),
    })
    expect(items).toEqual([])
  })

  test("only a written-out path is called missing", () => {
    const items = buildItems({
      ...base,
      facts: facts({
        refs: [
          { kind: "missing", ref: ref("config.json") },
          { kind: "missing", ref: ref("src/gone.ts") },
          { kind: "missing", ref: ref("/other/machine/gone.ts") },
          { kind: "ambiguous", ref: ref("index.ts") },
        ],
      }),
    })
    expect(items.map((item) => item.key)).toEqual(["missing:src/gone.ts"])
  })

  test("overlap with what the draft names is surfaced, and a new worktree clears the risk rows", () => {
    const input = {
      ...base,
      facts: facts({
        refs: [{ kind: "found", ref: ref("src/a.ts"), path: "src/a.ts" } as const],
        dirty: ["src/a.ts", "README.md"],
        busy: [{ id: "s1", title: "Other", files: ["src/a.ts", "src/z.ts"] }],
      }),
    }
    const items = buildItems(input)
    expect(items.find((item) => item.kind === "busy")).toMatchObject({ overlap: ["src/a.ts"] })
    expect(items.find((item) => item.kind === "dirty")).toMatchObject({ count: 2, overlap: ["src/a.ts"] })
    expect(buildItems({ ...input, isolated: true }).map((item) => item.kind)).toEqual(["mention"])
  })

  test("checks row hides once the draft asks for them", () => {
    const row = { ...base, facts: facts({ checks: ["npm run test"] }) }
    expect(buildItems({ ...row, text: "fix it" }).map((item) => item.kind)).toEqual(["checks"])
    expect(buildItems({ ...row, text: "fix it, then run the tests" })).toEqual([])
  })
})
