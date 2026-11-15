import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 1.3.0 row 46 (AC-P1d-drift, N10-165; 01a §2, F6; register note RN-2 moved the owner from 45 to 46).
// The open-in-Obsidian outcome union has four hand copies (N10-023). Each copy is read as source text and its string
// members are compared: all four member sets must be equal and equal the 8 members of N10-023. Read-only; the test
// imports none of the four files.

const packages = join(import.meta.dir, "..", "..", "..")
const read = (path: string) => readFileSync(join(packages, path), "utf8")

const N10_023 = ["opened", "missing", "outside", "no-app", "failed", "registered", "close-obsidian", "not-registered"]

// Each copy: the file, and a pattern whose first group is the union text on that one line.
const COPIES = [
  { copy: 1, file: "desktop/src/main/external-url.ts", line: /^type ObsidianNoteResult = (.+)$/gm },
  {
    copy: 2,
    file: "desktop/src/preload/types.ts",
    line: /^\s*openObsidianNote: \(hubPath: string\) => Promise<(.+)>$/gm,
  },
  { copy: 3, file: "app/src/context/platform.tsx", line: /^\s*openObsidianNote\?\(hubPath: string\): Promise<(.+)>$/gm },
  { copy: 4, file: "app/test-browser/rel128-obs-f-memory-button.render.ts", line: /^type Result = (.+)$/gm },
] as const

function members(copy: (typeof COPIES)[number]) {
  const found = [...read(copy.file).matchAll(copy.line)]
  if (found.length !== 1) throw new Error(`copy ${copy.copy} (${copy.file}): expected one union line, found ${found.length}`)
  const text = found[0][1]
  const parts = text.split("|").map((part) => part.trim())
  // Every part is a plain string literal: a renamed alias or a widened `string` would not be a copy any more.
  for (const part of parts) if (!/^"[a-z-]+"$/.test(part)) throw new Error(`copy ${copy.copy}: not a literal: ${part}`)
  return parts.map((part) => part.slice(1, -1)).sort()
}

describe("ObsidianNoteResult union drift (four copies)", () => {
  for (const copy of COPIES)
    test(`copy ${copy.copy} (${copy.file}) has exactly the 8 members of N10-023`, () => {
      expect(members(copy)).toEqual([...N10_023].sort())
    })

  test("the four member sets are equal", () => {
    const sets = COPIES.map((copy) => JSON.stringify(members(copy)))
    expect(new Set(sets).size).toBe(1)
  })
})
