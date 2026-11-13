// 1.2.8 row 43c, AC-OBSb (N8-358): the vault mirror writer `VaultMirror.sync` (01c §3.1-§3.2, SR8-12, C7).
// Red at BASE e1f9673772: `src/memory/vault-mirror.ts` does not exist.
//
// Every test runs in its own mkdtemp parent holding the vault, a project and an "outside" folder with a sentinel file.
// SWARM_VAULT_DIR points at that vault and os.homedir is stubbed to a mkdtemp home, so nothing here can reach the real
// ~/.swarm/vault. Inputs are the synthetic store of row 43b (fixtures/rel128-obs-c).
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Vault } from "@opencode-ai/core/vault"
import { VaultMirror } from "../../src/memory/vault-mirror"

const FIXTURES = path.join(import.meta.dir, "fixtures", "rel128-obs-c")
const store = JSON.parse(fs.readFileSync(path.join(FIXTURES, "store.json"), "utf8"))
const REPORT_PATH = "docs/2026-11-13_kajian-tarif/10_report/report.md"
const reportText = fs.readFileSync(path.join(FIXTURES, "report.md"), "utf8")
type Item = VaultMirror.SyncInput["items"][number]
const ITEMS: Item[] = store.items
const SENTINEL = "sentinel: must stay byte-unchanged\n"

const parents: string[] = []
afterAll(() => {
  for (const dir of parents) fs.rmSync(dir, { recursive: true, force: true })
})

let parent = ""
let vault = ""
let outside = ""
let project = ""
let folderPath = ""
const savedEnv = { vault: process.env.SWARM_VAULT_DIR, disable: process.env.SWARM_DISABLE_MEMORY }
let homeSpy: ReturnType<typeof spyOn> | undefined

beforeEach(() => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o43c-")))
  parents.push(parent)
  vault = path.join(parent, "vault")
  outside = path.join(parent, "outside")
  project = path.join(parent, "Default Project")
  fs.mkdirSync(vault)
  fs.mkdirSync(outside)
  fs.mkdirSync(path.join(parent, "home"))
  fs.writeFileSync(path.join(outside, "sentinel.md"), SENTINEL)
  fs.mkdirSync(path.join(project, path.dirname(REPORT_PATH)), { recursive: true })
  fs.writeFileSync(path.join(project, REPORT_PATH), reportText)
  process.env.SWARM_VAULT_DIR = vault
  delete process.env.SWARM_DISABLE_MEMORY
  homeSpy = spyOn(os, "homedir").mockReturnValue(path.join(parent, "home"))
  folderPath = path.join(vault, "swarm-memory", Vault.vaultProjectFolder(project, store.key))
})

afterEach(() => {
  homeSpy?.mockRestore()
  if (savedEnv.vault === undefined) delete process.env.SWARM_VAULT_DIR
  else process.env.SWARM_VAULT_DIR = savedEnv.vault
  if (savedEnv.disable === undefined) delete process.env.SWARM_DISABLE_MEMORY
  else process.env.SWARM_DISABLE_MEMORY = savedEnv.disable
})

/** Every entry below `dir` (relative path -> file content, or "<dir>" / "-> target" for folders and links). */
function tree(dir: string) {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(full)}`
      else if (entry.isDirectory()) {
        out[rel] = "<dir>"
        walk(full)
      } else out[rel] = fs.readFileSync(full, "utf8")
    }
  }
  walk(dir)
  return out
}

/** A wrapped fs/promises that counts the calls that change the disk. */
function countingIO() {
  const calls = { open: 0, rename: 0, unlink: 0, mkdir: 0 }
  const io: VaultMirror.SyncIO = {
    ...fsp,
    open: ((...args: Parameters<typeof fsp.open>) => {
      calls.open++
      return fsp.open(...args)
    }) as typeof fsp.open,
    rename: ((...args: Parameters<typeof fsp.rename>) => {
      calls.rename++
      return fsp.rename(...args)
    }) as typeof fsp.rename,
    unlink: ((...args: Parameters<typeof fsp.unlink>) => {
      calls.unlink++
      return fsp.unlink(...args)
    }) as typeof fsp.unlink,
    mkdir: ((...args: Parameters<typeof fsp.mkdir>) => {
      calls.mkdir++
      return fsp.mkdir(...args)
    }) as typeof fsp.mkdir,
  }
  return { io, calls }
}

const input = (over: Partial<VaultMirror.SyncInput> = {}): VaultMirror.SyncInput => ({
  key: store.key,
  directory: project,
  projectRoot: project,
  projectName: store.projectName,
  items: ITEMS,
  ...over,
})

const rendered = (items: readonly Item[] = ITEMS) =>
  VaultMirror.render({
    key: store.key,
    folder: Vault.vaultProjectFolder(project, store.key),
    projectName: store.projectName,
    items,
    reports: { [REPORT_PATH]: { status: "ok", text: reportText } },
  })

const plainNote = (id: string) => rendered().files.find((f) => f.path.startsWith("notes/") && f.path.endsWith(`-${id}.md`))!
const retitle = (id: string, text: string) => ITEMS.map((item) => (item.id === id ? { ...item, text } : item))

describe("AC-OBSb OBS-b-1 never outside the vault", () => {
  test("a run writes exactly the rendered set under <vault>/swarm-memory/<folder>/ and nothing else on disk", async () => {
    const before = tree(parent)
    const result = await VaultMirror.sync(input())
    expect(result.status).toBe("ok")
    const after = tree(parent)
    const added = Object.keys(after).filter((rel) => !(rel in before))
    const prefix = path.relative(parent, folderPath)
    for (const rel of added) expect(rel === "vault/swarm-memory" || rel.startsWith(prefix)).toBe(true)
    for (const [rel, content] of Object.entries(before)) expect(after[rel]).toBe(content)
    const files = Object.fromEntries(rendered().files.map((f) => [f.path, f.content]))
    const written = Object.fromEntries(
      Object.entries(tree(folderPath)).filter(([, content]) => content !== "<dir>"),
    )
    expect(written).toEqual(files)
    expect(result.written.toSorted()).toEqual(Object.keys(files).toSorted())
  })

  test("vault root absent: nothing is created anywhere (listing of the temp parent unchanged)", async () => {
    process.env.SWARM_VAULT_DIR = path.join(parent, "no-vault")
    const before = tree(parent)
    const result = await VaultMirror.sync(input())
    expect(result.status).toBe("absent")
    expect(tree(parent)).toEqual(before)
  })

  const symlinkCases: [string, () => void][] = [
    ["swarm-memory", () => fs.symlinkSync(outside, path.join(vault, "swarm-memory"))],
    [
      "<folder>",
      () => {
        fs.mkdirSync(path.join(vault, "swarm-memory"))
        fs.symlinkSync(outside, folderPath)
      },
    ],
    [
      "notes/",
      () => {
        fs.mkdirSync(folderPath, { recursive: true })
        fs.symlinkSync(outside, path.join(folderPath, "notes"))
      },
    ],
  ]
  for (const [where, plant] of symlinkCases) {
    test(`symlink at ${where} refuses the run VAULT_PATH_UNSAFE; sentinel and outside unchanged; nothing written`, async () => {
      plant()
      const outsideBefore = tree(outside)
      const vaultBefore = tree(vault)
      const logs: VaultMirror.SyncCode[] = []
      const { io, calls } = countingIO()
      const result = await VaultMirror.sync(input({ io, log: (e) => logs.push(e.code) }))
      expect(result.status).toBe("unsafe")
      expect(logs).toContain("VAULT_PATH_UNSAFE")
      expect(calls).toEqual({ open: 0, rename: 0, unlink: 0, mkdir: 0 })
      expect(tree(outside)).toEqual(outsideBefore)
      expect(tree(vault)).toEqual(vaultBefore)
      expect(fs.readFileSync(path.join(outside, "sentinel.md"), "utf8")).toBe(SENTINEL)
    })
  }

  test("symlink at a target file refuses the whole run; the sentinel it points at is byte-unchanged", async () => {
    await VaultMirror.sync(input())
    const target = path.join(folderPath, plainNote("a1b2c3").path)
    fs.rmSync(target)
    fs.symlinkSync(path.join(outside, "sentinel.md"), target)
    const { io, calls } = countingIO()
    const result = await VaultMirror.sync(input({ io, items: retitle("b2c3d4", "Changed so a write is due") }))
    expect(result.status).toBe("unsafe")
    expect(calls.open + calls.rename + calls.unlink).toBe(0)
    expect(fs.readFileSync(path.join(outside, "sentinel.md"), "utf8")).toBe(SENTINEL)
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true)
  })

  test("memory id ../../a and mission id ../x are skipped and counted; no file outside the folder", async () => {
    const bad: Item[] = [
      { id: "../../a", source: "agent", deviceOnly: false, time: 1763000000000, text: "escape attempt" },
      {
        id: "abcdef",
        kind: "index",
        missionId: "../x",
        source: "agent",
        deviceOnly: false,
        time: 1763000000000,
        text: "../x | escape | triggers: x | docs/x.md",
      } as Item,
    ]
    const before = tree(parent)
    const result = await VaultMirror.sync(input({ items: [...ITEMS, ...bad] }))
    expect(result.status).toBe("ok")
    expect(result.notCopied).toBeGreaterThanOrEqual(2)
    for (const rel of result.written) expect(VaultMirror.VAULT_NOTE_NAME_PATTERN.test(path.basename(rel)) || rel === "index.md").toBe(true)
    const prefix = path.relative(parent, folderPath)
    for (const rel of Object.keys(tree(parent)).filter((r) => !(r in before)))
      expect(rel === "vault/swarm-memory" || rel.startsWith(prefix)).toBe(true)
    expect(fs.existsSync(path.join(vault, "a.md"))).toBe(false)
  })
})

describe("AC-OBSb SR8-12 a component swapped between check and write never leads outside", () => {
  /** Swap `notes/` for a symlink to the outside folder at one stage of the first write into notes/. */
  const swapAt = (stage: VaultMirror.SyncStage, mode: "link-outside" | "move-outside") => {
    let done = false
    return async (at: VaultMirror.SyncStage, target: string) => {
      if (done || at !== stage || path.basename(path.dirname(target)) !== "notes") return
      done = true
      const notes = path.join(folderPath, "notes")
      if (mode === "link-outside") {
        fs.renameSync(notes, path.join(folderPath, "notes-old"))
        fs.symlinkSync(outside, notes)
      } else {
        fs.renameSync(notes, path.join(outside, "moved"))
        fs.symlinkSync(path.join(outside, "moved"), notes)
      }
    }
  }

  // Which guard stops each swap: the real-path check of the temp file, the re-lstat before the rename, the failed
  // rename (temp file moved away with the old folder), the real-path check after the rename.
  const cases: [VaultMirror.SyncStage, "link-outside" | "move-outside", RegExp][] = [
    ["temp", "link-outside", /landed outside/],
    ["written", "link-outside", /changed since the check/],
    ["rename", "link-outside", /ENOENT/],
    ["rename", "move-outside", /landed outside/],
  ]
  for (const [stage, mode, guard] of cases) {
    test(`swap at stage "${stage}" (${mode}): run stops VAULT_PATH_UNSAFE and nothing written escapes`, async () => {
      await VaultMirror.sync(input())
      const outsideBefore = tree(outside)
      const changed = "Tabel tarif dibaca dari lampiran C sekarang"
      const newName = VaultMirror.noteName("note", "a1b2c3", changed)!
      const logs: string[] = []
      const result = await VaultMirror.sync(
        input({ items: retitle("a1b2c3", changed), hook: swapAt(stage, mode), log: (e) => logs.push(`${e.code} ${e.reason}`) }),
      )
      expect(result.status).toBe("unsafe")
      expect(logs.filter((l) => l.startsWith("VAULT_PATH_UNSAFE")).length).toBe(1)
      expect(logs.find((l) => l.startsWith("VAULT_PATH_UNSAFE"))).toMatch(guard)
      expect(fs.readFileSync(path.join(outside, "sentinel.md"), "utf8")).toBe(SENTINEL)
      const after = tree(outside)
      if (mode === "link-outside") expect(after).toEqual(outsideBefore)
      else {
        // The attacker moved the real notes/ outside; the run's own new file must not be there.
        expect(Object.keys(after).some((rel) => rel.endsWith(newName))).toBe(false)
        expect(Object.keys(after).some((rel) => rel.includes(".swarm-") && rel.endsWith(".tmp"))).toBe(false)
        expect(after["sentinel.md"]).toBe(SENTINEL)
      }
      expect(result.written.some((rel) => rel.endsWith(newName))).toBe(false)
    })
  }
})

describe("AC-OBSb OBS-b-2 only Swarm-owned files", () => {
  test("unmarked, other-key and hand-edited notes stay byte-identical over two runs and after the item is removed", async () => {
    const a = plainNote("a1b2c3")
    const b = plainNote("b2c3d4")
    const c = plainNote("c3d4e5")
    fs.mkdirSync(path.join(folderPath, "notes"), { recursive: true })
    fs.writeFileSync(path.join(folderPath, a.path), "# My own note\n\nno marker here\n")
    fs.writeFileSync(path.join(folderPath, b.path), b.content.replace(`swarm-key: "${store.key}"`, 'swarm-key: "other-store"'))
    await VaultMirror.sync(input())
    fs.writeFileSync(path.join(folderPath, c.path), fs.readFileSync(path.join(folderPath, c.path), "utf8") + "\nmy edit\n")
    const seeded = () => [a, b, c].map((f) => fs.readFileSync(path.join(folderPath, f.path), "utf8"))
    const snapshot = seeded()

    const logs: string[] = []
    const second = await VaultMirror.sync(input({ log: (e) => logs.push(`${e.code} ${e.path}`) }))
    expect(second.foreign.toSorted()).toEqual([a.path, b.path, c.path].toSorted())
    expect(logs.filter((l) => l.startsWith("VAULT_NOTE_FOREIGN")).length).toBe(3)
    await VaultMirror.sync(input())
    expect(seeded()).toEqual(snapshot)

    const removed = ITEMS.filter((item) => !["a1b2c3", "b2c3d4", "c3d4e5"].includes(item.id))
    const third = await VaultMirror.sync(input({ items: removed }))
    expect(third.deleted).toEqual([])
    expect(seeded()).toEqual(snapshot)
  })

  test("a foreign index.md: the folder is the person's, no file written in it", async () => {
    fs.mkdirSync(folderPath, { recursive: true })
    fs.writeFileSync(path.join(folderPath, "index.md"), "# My hub\n")
    const result = await VaultMirror.sync(input())
    expect(result.status).toBe("foreign-hub")
    expect(tree(folderPath)).toEqual({ "index.md": "# My hub\n" })
  })

  test("owned: marker, key and body hash must all match", () => {
    const hub = rendered().files.find((f) => f.path === "index.md")!
    expect(VaultMirror.owned(hub.content, store.key)).toBe(true)
    expect(VaultMirror.owned(hub.content, "other")).toBe(false)
    expect(VaultMirror.owned(hub.content + "x", store.key)).toBe(false)
    expect(VaultMirror.owned(hub.content.replace("swarm-mirror: true", "swarm-mirror: false"), store.key)).toBe(false)
    expect(VaultMirror.owned("no frontmatter", store.key)).toBe(false)
  })
})

describe("AC-OBSb OBS-b-3 idempotent rewrite", () => {
  test("second run on the same store: 0 writes, 0 deletes, mtimes equal", async () => {
    await VaultMirror.sync(input())
    const files = rendered().files.map((f) => path.join(folderPath, f.path))
    const mtimes = files.map((f) => fs.statSync(f).mtimeMs)
    const { io, calls } = countingIO()
    const result = await VaultMirror.sync(input({ io }))
    expect(result.status).toBe("ok")
    expect(result.written).toEqual([])
    expect(result.deleted).toEqual([])
    expect(calls).toEqual({ open: 0, rename: 0, unlink: 0, mkdir: 0 })
    expect(files.map((f) => fs.statSync(f).mtimeMs)).toEqual(mtimes)
  })

  test("removing one item deletes exactly its owned note", async () => {
    await VaultMirror.sync(input())
    const gone = plainNote("c3d4e5")
    const result = await VaultMirror.sync(input({ items: ITEMS.filter((item) => item.id !== "c3d4e5") }))
    expect(result.deleted).toEqual([gone.path])
    expect(fs.existsSync(path.join(folderPath, gone.path))).toBe(false)
  })

  test("C7: a title change deletes the old owned file, writes the new name, and no owned note links the old name", async () => {
    await VaultMirror.sync(input())
    const old = plainNote("a1b2c3")
    const items = retitle("a1b2c3", "Lampiran C kini jadi sumber tarif")
    const fresh = VaultMirror.noteName("note", "a1b2c3", "Lampiran C kini jadi sumber tarif")!
    const result = await VaultMirror.sync(input({ items }))
    expect(result.deleted).toEqual([old.path])
    expect(result.written).toContain(`notes/${fresh}`)
    const oldStem = path.basename(old.path, ".md")
    for (const [rel, content] of Object.entries(tree(folderPath))) {
      if (content === "<dir>") continue
      expect(content.includes(oldStem)).toBe(false)
      expect(rel).not.toBe(old.path)
    }
    expect(tree(folderPath)["index.md"]).toContain(path.basename(fresh, ".md"))
  })

  test("modes: files 0600, folders 0700", async () => {
    await VaultMirror.sync(input())
    for (const dir of [path.join(vault, "swarm-memory"), folderPath, path.join(folderPath, "notes")])
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    for (const f of rendered().files) expect(fs.statSync(path.join(folderPath, f.path)).mode & 0o777).toBe(0o600)
  })

  test("a temp file left by an interrupted run is removed; other dot-files stay", async () => {
    await VaultMirror.sync(input())
    const stale = path.join(folderPath, "notes", ".x-a1b2c3.md.swarm-123-abcdef01.tmp")
    const other = path.join(folderPath, "notes", ".mine.tmp")
    fs.writeFileSync(stale, "half")
    fs.writeFileSync(other, "keep")
    const result = await VaultMirror.sync(input())
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.readFileSync(other, "utf8")).toBe("keep")
    expect(result.deleted).toEqual([])
  })

  test("memory turned off (enabled false or SWARM_DISABLE_MEMORY): the mirror does not run", async () => {
    expect((await VaultMirror.sync(input({ enabled: false }))).status).toBe("disabled")
    process.env.SWARM_DISABLE_MEMORY = "1"
    expect((await VaultMirror.sync(input())).status).toBe("disabled")
    expect(fs.existsSync(path.join(vault, "swarm-memory"))).toBe(false)
  })
})
