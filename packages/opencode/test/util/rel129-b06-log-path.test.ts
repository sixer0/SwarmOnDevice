// 1.2.9 row 45 (AC-B06, N9-122): one shared log-path scrubber (`src/util/log-path.ts`, N9-083) replaces the two
// drifted copies in `memory/vault-mirror.ts` and `server/routes/instance/httpapi/handlers/project.ts`.
//
// (1) the AT-B06 behaviour table (01b spec), each row an assertion on `withoutPaths`; rows 1-13 run with a home folder
//     that is not a prefix of their inputs, the S9-07 rows with HOME=/Users/x (the home folder is always the last
//     root, label `~`).
// (2) source checks: both callers import the shared helper and no longer carry the bare-path regexp; across src/**
//     that regexp source is in exactly one file, util/log-path.ts.
// Synthetic inputs only (syn129); the home folder is set through OPENCODE_TEST_HOME (Global.Path.home, the one home
// source, 1.2.9 row 67b/67d C79) with os.homedir stubbed to the same value, so the real home is never read.
//
// 1.2.9 row 67b (C79, gate 67 finding 2): the path rules (R2/R3) run BEFORE the home folder is replaced, so a path
// under home becomes `<path>` and no folder name below home reaches a log line; `~` is only applied to what is left
// (a path glued to `[\w.~-]`, RN-15). Row 67d (finding 4): log-path and vault-mirror share one home source and one
// boundary rule (`replaceHome`).

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const SRC = path.join(import.meta.dir, "..", "..", "src")
const BARE = "/(?:[A-Za-z]:)?[\\\\/][^\\s'\"`,;)]*/"
const VAULT = [{ path: "/private/var/v/vault", label: "<vault>" }] as const
const NOT_A_PREFIX = "/home/syn129"

type Roots = readonly { path: string; label: string }[]
const load = async () => (await import("../../src/util/log-path")).withoutPaths

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})
const home = (value: string, homedir = value) => {
  restore?.()
  const before = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = value
  const spy = spyOn(os, "homedir").mockReturnValue(homedir)
  restore = () => {
    spy.mockRestore()
    if (before === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = before
  }
}

// [#, input, roots, expected] — the AT-B06 table, HEAD column.
const TABLE: [string, string, Roots | undefined, string][] = [
  ["1", "open /Users/x/y.md failed", undefined, "open <path> failed"],
  ["2", "rename a->/Users/x/y", undefined, "rename a-><path>"],
  ["3", "at </Users/x/y>", undefined, "at <<path>"],
  ["4", "at '/Users/x/my file.md'", undefined, "at '<path>'"],
  ["5", "unsafe /private/var/v/vault/notes/a.md", VAULT, "unsafe <vault>/notes/a.md"],
  ["6", "unsafe '/private/var/v/vault/notes/a.md'", VAULT, "unsafe '<vault>/notes/a.md'"],
  ["7", "root /private/var/v/vault", VAULT, "root <vault>"],
  ["8", "keep ./rel/x and ~/x and a/b", undefined, "keep ./rel/x and ~/x and a/b"],
  ["9", "C:\\Users\\x\\y failed", undefined, "<path> failed"],
  [
    "10",
    "EACCES: permission denied, mkdir '/Users/x/Documents/Default Project/g'",
    undefined,
    "EACCES: permission denied, mkdir '<path>'",
  ],
  ["11", "a -/Users/x", undefined, "a -/Users/x"],
  ["12", "", undefined, ""],
  ["13", "x /private/var/v/vault", [{ path: "", label: "<vault>" }], "x <path>"],
]

// S9-07 rows (01_specs AC-B06) and the home-root forms of rows 1, 5 and 11, with HOME=/Users/x.
const HOME_ROWS: [string, string, Roots | undefined, string][] = [
  // 1.2.10 row 67 INTENT (B10-04 (3), C20 D1): a glued path under home keeps no folder name: was "a -~/y", "git -C~/repo".
  ["S9-07a", "a -/Users/x/y", undefined, "a -~/<path>"],
  ["S9-07b", "git -C/Users/x/repo", undefined, "git -C~/<path>"],
  // 67b INTENT (C79): was "open ~/y.md failed" (row 45); a path under home is a path, so `<path>` as in 1.2.8.
  ["1h", "open /Users/x/y.md failed", undefined, "open <path> failed"],
  // 67b (gate 67 finding 2): a folder name under home inside a quoted mkdir never reaches the line.
  [
    "67b-mkdir",
    "EACCES: permission denied, mkdir '/Users/x/Documents/Syn129 Folder/g'",
    undefined,
    "EACCES: permission denied, mkdir '<path>'",
  ],
  ["67b-bare", "open /Users/x/Documents/syn129-folder/a.md failed", undefined, "open <path> failed"],
  ["67b-double", 'open "/Users/x/Documents/syn129-folder/a.md" failed', undefined, 'open "<path>" failed'],
  ["11h", "a -/Users/x", undefined, "a -~"],
  ["5h", "unsafe /Users/x/.swarm/vault/notes/a.md", [{ path: "/Users/x/.swarm/vault", label: "<vault>" }], "unsafe <vault>/notes/a.md"],
  ["9h", "C:\\Users\\x\\y failed", undefined, "<path> failed"],
  // 45a (C61): the home folder is replaced only at a path boundary.
  ["45a-sibling", "a -/Users/xy/z", undefined, "a -/Users/xy/z"],
  ["45a-end", "a -/Users/x", undefined, "a -~"],
  // 1.2.10 row 67 INTENT (B10-04 (3)): was "a -~/z".
  ["45a-slash", "a -/Users/x/z", undefined, "a -~/<path>"],
  // 67b INTENT (C79): was "at '~'" (row 45a); a quoted path is `'<path>'` whatever it holds.
  ["45a-quote", "at '/Users/x'", undefined, "at '<path>'"],
  // 67d (gate 67 finding 4): `.`, `@` and `+` after the home folder continue a segment, so it is not the home folder.
  ["67d-dot", "a -/Users/x.old/z", undefined, "a -/Users/x.old/z"],
  ["67d-at", "a -/Users/x@syn/z", undefined, "a -/Users/x@syn/z"],
  ["67d-plus", "a -/Users/x+syn/z", undefined, "a -/Users/x+syn/z"],
  // 67i (C85 ruling 4): a '.' followed by whitespace or the end of the text ends a sentence, so the home folder before
  // it is replaced; a '.' followed by a letter continues a sibling name (`/Users/x.y`).
  ["67i-end", "a -/Users/x.", undefined, "a -~."],
  ["67i-space", "a -/Users/x. next", undefined, "a -~. next"],
  ["67i-letter", "a -/Users/x.y", undefined, "a -/Users/x.y"],
]
// rows whose input holds a sibling of the home folder, not the home folder itself
const SIBLING = new Set(["45a-sibling", "67d-dot", "67d-at", "67d-plus", "67i-letter"])

describe("AT-B06 behaviour table (home folder not a prefix of the input)", () => {
  for (const [id, input, roots, expected] of TABLE) {
    test(`row ${id}: ${JSON.stringify(input)}`, async () => {
      const withoutPaths = await load()
      home(NOT_A_PREFIX)
      expect(withoutPaths(input, roots)).toBe(expected)
    })
  }
})

describe("S9-07 the home folder is always the last root, label ~ (HOME=/Users/x)", () => {
  for (const [id, input, roots, expected] of HOME_ROWS) {
    test(`row ${id}: ${JSON.stringify(input)}`, async () => {
      const withoutPaths = await load()
      home("/Users/x")
      const out = withoutPaths(input, roots)
      expect(out).toBe(expected)
      // a sibling account (45a, 67d) is not the home folder, so it keeps its own name
      if (SIBLING.has(id)) expect(out).not.toContain("~")
      else expect(out).not.toContain("/Users/x")
      expect(out).not.toMatch(/syn129|Syn129/)
    })
  }

  test("67d: the home folder comes from Global.Path.home (OPENCODE_TEST_HOME), not os.homedir", async () => {
    const withoutPaths = await load()
    home("/Users/x", NOT_A_PREFIX)
    // 1.2.10 row 67 INTENT (B10-04 (3)): was "a -~/y".
    expect(withoutPaths("a -/Users/x/y")).toBe("a -~/<path>")
  })

  test("a Windows home folder is replaced the same way", async () => {
    const withoutPaths = await load()
    home("C:\\Users\\x")
    // 1.2.10 row 67 INTENT (B10-04 (3)): was "a -~\\y".
    expect(withoutPaths("a -C:\\Users\\x\\y")).toBe("a -~\\<path>")
  })

  test("a home folder of '/' or '' is ignored (no split on every character)", async () => {
    const withoutPaths = await load()
    home("/")
    expect(withoutPaths("open /a/b failed")).toBe("open <path> failed")
    home("")
    expect(withoutPaths("open /a/b failed")).toBe("open <path> failed")
  })
})

describe("one implementation: both callers use util/log-path", () => {
  const VAULT_MIRROR = path.join(SRC, "memory", "vault-mirror.ts")
  const PROJECT = path.join(SRC, "server", "routes", "instance", "httpapi", "handlers", "project.ts")
  const IMPORT = /import\s*\{[^}]*\bwithoutPaths\b[^}]*\}\s*from\s*"(?:@|(?:\.\.?\/)+(?:\.\.\/)*)\/?util\/log-path"/

  test("vault-mirror.ts imports withoutPaths and has no local bare-path regexp", async () => {
    const text = await fs.readFile(VAULT_MIRROR, "utf8")
    expect({ imports: IMPORT.test(text), bare: text.includes(BARE), local: /function withoutPaths\b/.test(text) }).toEqual({
      imports: true,
      bare: false,
      local: false,
    })
  })

  test("67d: vault-mirror's home replacer uses the shared replaceHome and Global.Path.home, with no boundary of its own", async () => {
    const text = await fs.readFile(VAULT_MIRROR, "utf8")
    const body = /function withoutHome\b[\s\S]*?\n}\n/.exec(text)?.[0] ?? ""
    expect({
      imports: /import\s*\{[^}]*\breplaceHome\b[^}]*\}\s*from\s*"@\/util\/log-path"/.test(text),
      calls: (body.match(/\breplaceHome\(/g) ?? []).length,
      home: body.includes("Global.Path.home"),
      lookahead: body.includes("(?!"),
    }).toEqual({ imports: true, calls: 2, home: true, lookahead: false })
  })

  test("67d: log-path reads the home folder from Global.Path.home, not os.homedir", async () => {
    const text = await fs.readFile(path.join(SRC, "util", "log-path.ts"), "utf8")
    expect({ global: text.includes("Global.Path.home"), homedir: text.includes("homedir") }).toEqual({
      global: true,
      homedir: false,
    })
  })

  test("67d: replaceHome, raw and Markdown-escaped, keeps a sibling followed by . @ + and replaces the home folder", async () => {
    const { replaceHome } = await import("../../src/util/log-path")
    const { escapeText } = await import("../../src/memory/vault-mirror")
    for (const tail of [".old", "@syn", "+syn", "y", "-syn", "_syn", "~syn"]) {
      const sibling = `/Users/x${tail}/z`
      expect(replaceHome(sibling, "/Users/x", "~")).toBe(sibling)
      expect(replaceHome(escapeText(sibling), escapeText("/Users/x"), escapeText("~"), true)).toBe(escapeText(sibling))
    }
    expect(replaceHome("a /Users/x/z and /Users/x", "/Users/x", "~")).toBe("a ~/z and ~")
    expect(replaceHome(escapeText("a /Users/x/z."), escapeText("/Users/x"), escapeText("~"), true)).toBe(escapeText("a ~/z."))
    expect(replaceHome("a /Users/x/z", "/", "~")).toBe("a /Users/x/z")
  })

  test("67i: replaceHome, raw and Markdown-escaped, treats a '.' before whitespace or the end of the text as a boundary", async () => {
    const { replaceHome } = await import("../../src/util/log-path")
    const { escapeText } = await import("../../src/memory/vault-mirror")
    const cases: [string, string][] = [
      ["in /Users/x.", "in ~."],
      ["in /Users/x. Next", "in ~. Next"],
      ["in /Users/x.\nnext", "in ~.\nnext"],
      ["in /Users/x.y", "in /Users/x.y"],
      ["in /Users/x.y.", "in /Users/x.y."],
    ]
    for (const [input, expected] of cases) {
      expect(replaceHome(input, "/Users/x", "~")).toBe(expected)
      expect(replaceHome(escapeText(input), escapeText("/Users/x"), escapeText("~"), true)).toBe(escapeText(expected))
    }
  })

  test("handlers/project.ts imports withoutPaths and has no local bare-path regexp", async () => {
    const text = await fs.readFile(PROJECT, "utf8")
    expect({ imports: IMPORT.test(text), bare: text.includes(BARE) }).toEqual({ imports: true, bare: false })
  })

  test("the bare-path regexp source is in exactly one file under src/, util/log-path.ts", async () => {
    const found: string[] = []
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
      if ((await fs.readFile(path.join(SRC, file), "utf8")).includes(BARE)) found.push(file.split(path.sep).join("/"))
    }
    expect(found).toEqual(["util/log-path.ts"])
  })
})
