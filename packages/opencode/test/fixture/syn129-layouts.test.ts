// 1.2.9 row 23a: smoke test for the syn129 layout builders (N9-156..N9-160). Each builder makes its layout in a fresh
// mkdtemp root under a scratch parent; the test checks the shape with lstat/readlink and that cleanup removes it.
// Run targeted: cd packages/opencode && bun test test/fixture/syn129-layouts.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  documentsLinkLayout,
  missingFolderTerminalLayout,
  notFolderLocationLayout,
  trailingSlashLinkLayout,
} from "./syn129-layouts"

let parent = ""
beforeAll(async () => {
  parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "syn129-smoke-")))
})
afterAll(() => fs.rm(parent, { recursive: true, force: true }))

const kind = async (p: string) => {
  const stat = await fs.lstat(p).catch(() => undefined)
  if (!stat) return "absent"
  if (stat.isSymbolicLink()) return "link"
  if (stat.isDirectory()) return "dir"
  return stat.isFile() ? "file" : "other"
}
const inParent = (root: string) => path.dirname(root) === parent && path.basename(root).startsWith("syn129-")

describe("syn129 layouts (row 23a)", () => {
  test("N9-157 missingFolderTerminalLayout: R with a mission, loaded folder X removable, pty cwd inside the mission", async () => {
    const layout = await missingFolderTerminalLayout({ parent, git: true })
    expect(inParent(layout.root)).toBe(true)
    expect(layout.defaultProject).toBe(path.join(layout.root, "Documents", "Default Project"))
    expect(await kind(path.join(layout.missionDir, "report", "report.md"))).toBe("file")
    expect(await kind(path.join(layout.groupDir, ".swarm", "group.json"))).toBe("file")
    expect(await kind(path.join(layout.defaultProject, ".git"))).toBe("dir")
    expect(layout.ptyCwd.startsWith(layout.missionDir + path.sep)).toBe(true)
    expect(await kind(layout.ptyCwd)).toBe("dir")
    expect(layout.loaded.startsWith(layout.defaultProject + path.sep)).toBe(false)
    expect(await kind(layout.loaded)).toBe("dir")
    await layout.removeLoaded()
    expect(await kind(layout.loaded)).toBe("absent")
    await layout.cleanup()
    expect(await kind(layout.root)).toBe("absent")
  })

  test("N9-157 without git: no repository", async () => {
    await using layout = await missingFolderTerminalLayout({ parent })
    expect(await kind(path.join(layout.defaultProject, ".git"))).toBe("absent")
  })

  test("N9-158 notFolderLocationLayout: the location is a regular file; restoreAsFolder writes the marker config", async () => {
    const layout = await notFolderLocationLayout({ parent })
    expect(inParent(layout.root)).toBe(true)
    expect(await kind(layout.location)).toBe("file")
    expect(await fs.stat(layout.childOfFile).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOTDIR")
    await layout.restoreAsFolder()
    expect(await kind(layout.location)).toBe("dir")
    const text = await fs.readFile(path.join(layout.location, "swarm.jsonc"), "utf8")
    expect(JSON.parse(text.split("\n")[1])).toMatchObject(layout.marker)
    await layout[Symbol.asyncDispose]()
    expect(await kind(layout.root)).toBe("absent")
  })

  test("N9-159 documentsLinkLayout: case/Documents links to elsewhere/Documents holding a real Default Project", async () => {
    await using layout = await documentsLinkLayout({ parent })
    expect(inParent(layout.root)).toBe(true)
    expect(await kind(layout.documents)).toBe("link")
    expect(await fs.readlink(layout.documents)).toBe(layout.target)
    expect(await kind(layout.realDefaultProject)).toBe("dir")
    expect(await fs.realpath(layout.defaultProject)).toBe(layout.realDefaultProject)
    expect(await kind(path.join(layout.missionDir!, "report", "report.md"))).toBe("file")
    expect(layout.target.startsWith(layout.elsewhere + path.sep)).toBe(true)
  })

  test("N9-159 variants: no Default Project, dangling link, non-Documents parent", async () => {
    await using empty = await documentsLinkLayout({ parent, defaultProject: false })
    expect(await kind(empty.target)).toBe("dir")
    expect(await kind(empty.realDefaultProject)).toBe("absent")
    expect(empty.missionDir).toBeUndefined()

    await using dangling = await documentsLinkLayout({ parent, dangling: true })
    expect(await kind(dangling.documents)).toBe("link")
    expect(await kind(dangling.target)).toBe("absent")

    await using other = await documentsLinkLayout({ parent, parentName: "Berkas" })
    expect(path.basename(other.documents)).toBe("Berkas")
    expect(await kind(other.documents)).toBe("link")
    expect(await fs.realpath(other.defaultProject)).toBe(other.realDefaultProject)
  })

  test("N9-160 trailingSlashLinkLayout: J1 alias of R, J2 outside alias, J3 link root, each with a trailing separator", async () => {
    await using layout = await trailingSlashLinkLayout({ parent })
    expect(inParent(layout.root)).toBe(true)
    expect(await kind(layout.defaultProject)).toBe("dir")
    expect(await kind(path.join(layout.missionDir, "report", "report.md"))).toBe("file")
    for (const [link, given, target] of [
      [layout.alias, layout.from, layout.defaultProject],
      [layout.outsideAlias, layout.outsideFrom, layout.outside],
      [layout.linkRoot, layout.linkRootEnv, layout.defaultProject],
    ]) {
      expect(await kind(link)).toBe("link")
      expect(await fs.readlink(link)).toBe(target)
      expect(given).toBe(link + path.sep)
      expect(path.resolve(given)).toBe(link)
    }
    expect(path.basename(path.resolve(layout.from))).toBe("Alias")
  })

  test("default parent is os.tmpdir()", async () => {
    await using layout = await notFolderLocationLayout()
    expect(path.dirname(layout.root)).toBe(await fs.realpath(os.tmpdir()))
  })
})
