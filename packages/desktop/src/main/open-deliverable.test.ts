// Swarm 1.3.3 row 72 (MC-8 item 5): the `open-deliverable` rule and handler. Synthetic temp folders only; no module
// mocks (open-deliverable.ts imports electron types only).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkedDeliverablePath, openDeliverable, OPEN_DELIVERABLE_EXTENSIONS } from "./open-deliverable"

const T = realpathSync(mkdtempSync(join(tmpdir(), "r133-72-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const home = join(T, "home")
const proj = join(home, "work", "proj")
const other = join(home, "work", "other")
const dir = join(proj, "deliverables", "2026-11-17_m72")
mkdirSync(join(dir, "sub"), { recursive: true })
mkdirSync(join(dir, "Folder.pdf"), { recursive: true })
mkdirSync(join(dir, "Tool.app", "Contents"), { recursive: true })
mkdirSync(join(proj, "docs"), { recursive: true })
mkdirSync(join(other, "deliverables", "m9"), { recursive: true })
mkdirSync(join(home, ".ssh"), { recursive: true })
const PDF = join(dir, "012-GSP-KT-XI-2026 RevD rev256.pdf")
writeFileSync(PDF, "%PDF-1.7\n")
writeFileSync(join(dir, "012-GSP-KT-XI-2026 RevD rev256.docx"), "docx")
writeFileSync(join(dir, "012-GSP-KT-XI-2026 RevD rev256.html"), "<p>x</p>")
writeFileSync(join(dir, "run.command"), "#!/bin/sh\n")
writeFileSync(join(dir, "noext"), "x")
writeFileSync(join(dir, ".hidden.pdf"), "x")
writeFileSync(join(dir, "sub", "deep.pdf"), "x")
writeFileSync(join(proj, "docs", "loose.pdf"), "x")
writeFileSync(join(proj, "deliverables", "flat.pdf"), "x")
writeFileSync(join(other, "deliverables", "m9", "theirs.pdf"), "x")
writeFileSync(join(home, ".ssh", "id_test"), "synthetic")
symlinkSync(join(home, ".ssh", "id_test"), join(dir, "key.pdf"))
symlinkSync(join(proj, "docs", "loose.pdf"), join(dir, "loose-link.pdf"))
symlinkSync(join(dir, "run.command"), join(dir, "script.pdf"))

const deps = { home, platform: "linux" as const }
const check = (path: unknown, roots: string[] = [proj]) => checkedDeliverablePath(path, roots, deps)

describe("row 72 open-deliverable rule", () => {
  test("a document in <listed folder>/deliverables/<mission>/ is accepted, as its realpath", () => {
    expect(check(PDF)).toBe(PDF)
    expect(check(join(dir, "012-GSP-KT-XI-2026 RevD rev256.docx"))).toBe(join(dir, "012-GSP-KT-XI-2026 RevD rev256.docx"))
    expect(check(join(dir, "012-GSP-KT-XI-2026 RevD rev256.html"))).toBe(join(dir, "012-GSP-KT-XI-2026 RevD rev256.html"))
    expect(OPEN_DELIVERABLE_EXTENSIONS).toEqual(["pdf", "html", "docx", "xlsx", "pptx", "md", "txt"])
  })

  test("outside the mission's project folder: refused", () => {
    expect(check(join(other, "deliverables", "m9", "theirs.pdf"))).toBeNull()
    expect(check(PDF, [other])).toBeNull()
    expect(check(PDF, [])).toBeNull()
    // the home folder is not a root of this channel, and a root above home is refused
    expect(check(PDF, [home])).toBeNull()
    expect(check(PDF, [T])).toBeNull()
    expect(check(PDF, ["/"])).toBeNull()
  })

  test("inside the project but not deliverables/<mission>/<name>: refused", () => {
    expect(check(join(proj, "docs", "loose.pdf"))).toBeNull()
    expect(check(join(proj, "deliverables", "flat.pdf"))).toBeNull()
    expect(check(join(dir, "sub", "deep.pdf"))).toBeNull()
    expect(check(join(dir, ".hidden.pdf"))).toBeNull()
  })

  test("nothing that runs, no folder, no missing file", () => {
    expect(check(join(dir, "run.command"))).toBeNull()
    expect(check(join(dir, "Tool.app"))).toBeNull()
    expect(check(join(dir, "noext"))).toBeNull()
    expect(check(join(dir, "Folder.pdf"))).toBeNull()
    expect(check(join(dir, "missing.pdf"))).toBeNull()
  })

  test("symlinks are judged by where they point", () => {
    expect(check(join(dir, "key.pdf"))).toBeNull() // credential place
    expect(check(join(dir, "loose-link.pdf"))).toBeNull() // leaves deliverables/<mission>/
    expect(check(join(dir, "script.pdf"))).toBeNull() // realpath is a .command
  })

  test("input rule: not a string, relative, dot segments, control characters", () => {
    for (const bad of [undefined, null, 7, {}, "", "deliverables/m/x.pdf", `${dir}/../2026-11-17_m72/x.pdf`, `${PDF}\u0000`, `${PDF}\n`])
      expect(check(bad)).toBeNull()
    expect(check(join(dir, "..", "2026-11-17_m72", "012-GSP-KT-XI-2026 RevD rev256.pdf").replace(dir, `${dir}/../2026-11-17_m72`))).toBeNull()
  })
})

describe("row 72 open-deliverable handler", () => {
  const run = async (path: unknown, result: string | Error = "") => {
    const opened: string[] = []
    const logs: Array<[string, string, Record<string, unknown> | undefined]> = []
    const ok = await openDeliverable(path, [proj], {
      ...deps,
      shell: {
        openPath: async (p: string) => {
          opened.push(p)
          if (result instanceof Error) throw result
          return result
        },
      },
      log: (level, message, context) => logs.push([level, message, context]),
    })
    return { ok, opened, logs }
  }

  test("accepted: shell.openPath gets the checked realpath as one argument; one info line without the path", async () => {
    const r = await run(PDF)
    expect(r.ok).toBe(true)
    expect(r.opened).toEqual([PDF])
    expect(r.logs.map((l) => l[0])).toEqual(["info"])
    expect(JSON.stringify(r.logs)).not.toContain("RevD")
  })

  test("refused: nothing is opened, false, one warn line without the path", async () => {
    const r = await run(join(dir, "run.command"))
    expect(r.ok).toBe(false)
    expect(r.opened).toEqual([])
    expect(r.logs.map((l) => l[0])).toEqual(["warn"])
    expect(JSON.stringify(r.logs)).not.toContain("run.command")
  })

  test("openPath reports a reason or throws: false, an error line with the path taken out", async () => {
    for (const result of [`no application for ${PDF}`, new Error(`cannot open ${PDF}`)]) {
      const r = await run(PDF, result)
      expect(r.ok).toBe(false)
      expect(r.logs.map((l) => l[0])).toEqual(["error"])
      expect(JSON.stringify(r.logs)).not.toContain("RevD")
      expect(String(r.logs[0][2]?.message)).toContain("<path>")
    }
  })

  test("ipc.ts registers the channel with the Mission Control folders only and leaves open-path as it was", () => {
    const ipc = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8")
    expect(ipc).toContain('ipcMain.handle("open-deliverable"')
    expect(ipc).toMatch(/openDeliverable\(path, \[\.\.\.\(listedFolders\.get\(event\.sender\) \?\? \[\]\)\]/)
    expect(ipc).toContain('if (!app) return shell.openPath(path)')
    const preload = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8")
    expect(preload).toContain('openDeliverable: (path) => ipcRenderer.invoke("open-deliverable", path)')
  })
})
