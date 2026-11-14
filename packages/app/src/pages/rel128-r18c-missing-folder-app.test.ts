import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as homeController from "./home/home-controller"
import { createFolderMissingNotice, type FolderMissingKey } from "./layout/folder-missing"
import type { DirectoryCheck } from "@/context/platform"

// 1.2.8 row 30b (AC-R18c app half, N8-326). Two app paths still opened a folder without the shared missing-folder
// helper (../pages/layout/folder-missing.ts, 1.2.7 U-8, C95 "paths intentionally left"): Home "Add project"
// (`home-controller.ts` `project.add`) and the legacy layout's `deleteWorkspace`, which ended in
// `layout.projects.open(root)`. Green: both go through the helper and a gone folder gets the existing notice
// (existing `toast.project.folderMissing.*` keys, no new key, no new panel). Synthetic paths; the check is injected.
// Red at e1f9673772: `addCheckedProjectFolders` does not exist, and both call sites open without the helper.

const GONE = "/syn-r18c/gone"
const HERE = "/syn-r18c/here"

function notice(missing: string[] = [GONE]) {
  const keys: Array<{ key: FolderMissingKey; path?: string }> = []
  const checked: string[] = []
  const helper = createFolderMissingNotice({
    check: () => async (path: string): Promise<DirectoryCheck> => {
      checked.push(path)
      return missing.includes(path) ? "missing" : "exists"
    },
    recreate: () => undefined,
    stored: () => false,
    t: (key, params) => {
      keys.push({ key, path: params?.path })
      return key
    },
    choose: () => {},
  })
  return { helper, keys, checked }
}

const add = (homeController as Record<string, unknown>).addCheckedProjectFolders as
  | typeof homeController.addCheckedProjectFolders
  | undefined

function block(file: string, start: string, end: string) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8")
  const from = text.indexOf(start)
  expect(from).toBeGreaterThan(-1)
  const to = text.indexOf(end, from + start.length)
  expect(to).toBeGreaterThan(from)
  return text.slice(from, to)
}

describe("AC-R18c Home add project with a missing folder", () => {
  test("a gone folder is checked, not added, and gets the existing notice; a present one is added", async () => {
    const { helper, keys, checked } = notice()
    const added: string[] = []
    const result = await add!(helper, [GONE, HERE], (directory) => void added.push(directory))
    expect(checked.sort()).toEqual([GONE, HERE].sort())
    expect(added).toEqual([HERE])
    expect(result).toEqual([false, true])
    expect(keys.some((item) => item.key === "toast.project.folderMissing.title")).toBe(true)
    expect(keys).toContainEqual({ key: "toast.project.folderMissing.description", path: GONE })
    expect(keys.some((item) => item.key === "toast.project.folderMissing.restore")).toBe(true)
  })

  test("without a notice (web, legacy Home) every folder is added at once, as before", async () => {
    const added: string[] = []
    const result = await add!(undefined, [GONE, HERE], (directory) => void added.push(directory))
    expect(added).toEqual([GONE, HERE])
    expect(result).toEqual([true, true])
  })

  test("a remote server's folder is not checked and is added at once", async () => {
    const { helper, checked } = notice()
    const added: string[] = []
    await add!(helper, [GONE], (directory) => void added.push(directory), { local: false })
    expect(checked).toEqual([])
    expect(added).toEqual([GONE])
  })

  test("project.add routes every picked folder through the helper", () => {
    const source = block("./home/home-controller.ts", "add: (conn: ServerConnection.Any, directories: string[]) =>", "openNewSession:")
    expect(source).toContain("addCheckedProjectFolders(folderMissing, directories,")
    expect(source).not.toMatch(/directories\.forEach/)
  })
})

describe("AC-R18c legacy deleteWorkspace reopens its root through the helper", () => {
  test("the root goes through openProject (the shared notice), not a bare projects.open", () => {
    const source = block("./layout.tsx", "const deleteWorkspace = async", "const resetWorkspace = async")
    expect(source).toContain("await openProject(root, false)")
    expect(source).not.toContain("layout.projects.open(root)")
    const openProject = block("./layout.tsx", "function openProject(directory: string", "function chooseFolderAtHome")
    expect(openProject).toContain("folderMissing.open(directory,")
  })

  test("the helper does not reopen a gone root and shows the notice with the existing keys only", async () => {
    const { helper, keys } = notice()
    const opened: string[] = []
    expect(await helper.open(GONE, () => void opened.push(GONE))).toBe(false)
    expect(opened).toEqual([])
    const known: FolderMissingKey[] = [
      "toast.project.folderMissing.title",
      "toast.project.folderMissing.description",
      "toast.project.folderMissing.recreateFailed",
      "toast.project.folderMissing.restore",
      "toast.project.folderMissing.recreate",
      "toast.project.folderMissing.choose",
    ]
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((item) => known.includes(item.key))).toBe(true)
  })
})
