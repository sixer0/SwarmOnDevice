// 1.2.9 row 45 (AC-B06, N9-122): one shared log-path scrubber (`src/util/log-path.ts`, N9-083) replaces the two
// drifted copies in `memory/vault-mirror.ts` and `server/routes/instance/httpapi/handlers/project.ts`.
//
// (1) the AT-B06 behaviour table (01b spec), each row an assertion on `withoutPaths`; rows 1-13 run with a home folder
//     that is not a prefix of their inputs, the S9-07 rows with HOME=/Users/x (the home folder is always the last
//     root, label `~`).
// (2) source checks: both callers import the shared helper and no longer carry the bare-path regexp; across src/**
//     that regexp source is in exactly one file, util/log-path.ts.
// Synthetic inputs only (syn129); os.homedir is stubbed, the real home is never read.

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
const home = (value: string) => {
  const spy = spyOn(os, "homedir").mockReturnValue(value)
  restore = () => spy.mockRestore()
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
  ["S9-07a", "a -/Users/x/y", undefined, "a -~/y"],
  ["S9-07b", "git -C/Users/x/repo", undefined, "git -C~/repo"],
  ["1h", "open /Users/x/y.md failed", undefined, "open ~/y.md failed"],
  ["11h", "a -/Users/x", undefined, "a -~"],
  ["5h", "unsafe /Users/x/.swarm/vault/notes/a.md", [{ path: "/Users/x/.swarm/vault", label: "<vault>" }], "unsafe <vault>/notes/a.md"],
  ["9h", "C:\\Users\\x\\y failed", undefined, "<path> failed"],
]

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
      expect(out).not.toContain("/Users/x")
    })
  }

  test("a Windows home folder is replaced the same way", async () => {
    const withoutPaths = await load()
    home("C:\\Users\\x")
    expect(withoutPaths("a -C:\\Users\\x\\y")).toBe("a -~\\y")
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
