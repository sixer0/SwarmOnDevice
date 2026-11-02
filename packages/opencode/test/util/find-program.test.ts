import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findProgram } from "../../src/util/find-program"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "find-program-")))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const folder = (name: string) => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const program = (dir: string, mode = 0o755) => {
  fs.writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n", { mode })
  return dir
}

const first = program(folder("first"))
const second = program(folder("second"))
const notRunnable = program(folder("not-runnable"), 0o644)
const isFolder = folder("is-folder")
fs.mkdirSync(path.join(isFolder, "tool"))
const link = folder("link")
fs.symlinkSync(path.join(first, "tool"), path.join(link, "tool"))
const dangling = folder("dangling")
fs.symlinkSync(path.join(root, "nothing"), path.join(dangling, "tool"))
const linkedFolder = path.join(root, "linked-folder")
fs.symlinkSync(first, linkedFolder)
const empty = folder("empty")
const missing = path.join(root, "missing")
const join = (...entries: string[]) => entries.join(path.delimiter)

// The case the git tool and the install row turn on is the answer `Bun.which` gives, because that is what they used to ask.
const CASES: [name: string, searchPath: string][] = [
  ["the first of two", join(first, second)],
  ["the first it can run", join(notRunnable, second)],
  ["past a folder of that name", join(isFolder, second)],
  ["past a link to nothing", join(dangling, second)],
  ["past a folder that is not there", join(missing, second)],
  ["past an empty entry", join("", second)],
  ["through a link to a program, by the link's path", link],
  ["through a linked folder, by that path", linkedFolder],
  ["nothing runnable", notRunnable],
  ["nothing at all in the folder", empty],
  ["no folder there", missing],
  ["an empty path", ""],
]

describe("findProgram", () => {
  test.each(CASES)("%s: the same as Bun.which", (_name, searchPath) => {
    expect(findProgram("tool", searchPath) ?? null).toBe(Bun.which("tool", { PATH: searchPath }))
  })

  test("the cases do find something where they should", () => {
    expect(findProgram("tool", join(notRunnable, second))).toBe(path.join(second, "tool"))
    expect(findProgram("tool", link)).toBe(path.join(link, "tool"))
    expect(findProgram("tool", notRunnable)).toBeUndefined()
  })
})
