import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  clearCache,
  installManifest,
  nearestRealDirectory,
  needsResync,
  nodeWefFs,
  sha256,
  uninstallManifest,
  UNSAFE_PATH,
  WEF_MANIFEST_FILE,
  type WefFs,
} from "./wef"

const MANIFEST = new TextEncoder().encode('<?xml version="1.0"?><OfficeApp>swarm</OfficeApp>\n')

let base = ""
let manifestPath = ""
const locked: string[] = []

const containers = () => ({
  word: join(base, "Containers/com.microsoft.Word/Data/Documents/wef"),
  excel: join(base, "Containers/com.microsoft.Excel/Data/Documents/wef"),
})

// F-M7-6: an Office app that was installed and run once has its container Data/Documents folder.
const installApps = (...roots: string[]) => {
  for (const root of roots) mkdirSync(dirname(root), { recursive: true })
}

const lock = (dir: string) => {
  chmodSync(dir, 0o555)
  locked.push(dir)
}

const refusalError = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code })

const clean = { refused: [], failed: [], rollbackErrors: [], notInstalled: [], reveal: [] }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "swarm-wef-"))
  manifestPath = join(base, "resources/office-addin/manifest", WEF_MANIFEST_FILE)
  mkdirSync(join(base, "resources/office-addin/manifest"), { recursive: true })
  writeFileSync(manifestPath, MANIFEST)
})

afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755)
  rmSync(base, { recursive: true, force: true })
})

describe("installManifest", () => {
  test("U-DT-01: creates missing wef dirs and writes a byte-equal manifest in both", async () => {
    const roots = containers()
    installApps(roots.word, roots.excel)
    const outcome = await installManifest({ manifestPath, roots: [roots.word, roots.excel] })
    expect(outcome).toEqual({ ok: true, done: [roots.word, roots.excel], ...clean })
    expect(readFileSync(join(roots.word, WEF_MANIFEST_FILE))).toEqual(Buffer.from(MANIFEST))
    expect(readFileSync(join(roots.excel, WEF_MANIFEST_FILE))).toEqual(Buffer.from(MANIFEST))
    // The temp file was renamed into place: only the manifest is left.
    expect(readdirSync(roots.word)).toEqual([WEF_MANIFEST_FILE])
  })

  test("F-M7-6: a host without its container Data/Documents is skipped as notInstalled, nothing created", async () => {
    const roots = containers()
    installApps(roots.word)
    const outcome = await installManifest({ manifestPath, roots: [roots.word, roots.excel] })
    expect(outcome).toEqual({ ok: true, done: [roots.word], ...clean, notInstalled: [roots.excel] })
    expect(existsSync(join(base, "Containers/com.microsoft.Excel"))).toBe(false)
  })

  test("overwrites a stale manifest and leaves siblings alone", async () => {
    const root = containers().word
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, WEF_MANIFEST_FILE), "stale")
    writeFileSync(join(root, "other.xml"), "keep")
    const outcome = await installManifest({ manifestPath, roots: [root] })
    expect(outcome.ok).toBe(true)
    expect(readFileSync(join(root, WEF_MANIFEST_FILE))).toEqual(Buffer.from(MANIFEST))
    expect(readFileSync(join(root, "other.xml"), "utf8")).toBe("keep")
  })

  test("read-only Documents (wef missing): mkdir refused, nothing left, refusing path and real-dir reveal", async () => {
    const roots = containers()
    installApps(roots.word, roots.excel)
    const documents = dirname(roots.word)
    lock(documents)
    const outcome = await installManifest({ manifestPath, roots: [roots.word, roots.excel] })
    expect(outcome.ok).toBe(false)
    expect(outcome.refused).toEqual([roots.word])
    // F-M7-2: wef does not exist, so Finder gets its nearest real directory.
    expect(outcome.reveal).toEqual([documents])
    expect(outcome.failed).toEqual([])
    expect(outcome.rollbackErrors).toEqual([])
    expect(existsSync(roots.word)).toBe(false)
    expect(readdirSync(documents)).toEqual([])
    // A root that did not refuse keeps its verified copy: the Finder fallback targets only `refused`.
    expect(outcome.done).toEqual([roots.excel])
    expect(readFileSync(join(roots.excel, WEF_MANIFEST_FILE))).toEqual(Buffer.from(MANIFEST))
  })

  test("read-only wef root: write refused, no partial or temp file, both refusing paths returned", async () => {
    const roots = containers()
    mkdirSync(roots.word, { recursive: true })
    mkdirSync(roots.excel, { recursive: true })
    writeFileSync(join(roots.excel, "other.xml"), "keep")
    lock(roots.word)
    lock(roots.excel)
    const outcome = await installManifest({ manifestPath, roots: [roots.word, roots.excel] })
    expect(outcome).toEqual({
      ok: false,
      done: [],
      ...clean,
      refused: [roots.word, roots.excel],
      reveal: [roots.word, roots.excel],
    })
    expect(readdirSync(roots.word)).toEqual([])
    expect(readdirSync(roots.excel)).toEqual(["other.xml"])
  })

  test("refusal after mkdir succeeded rolls back the created wef folder (injected fs)", async () => {
    const root = containers().word
    installApps(root)
    const fs: WefFs = { ...nodeWefFs, writeFile: async () => Promise.reject(refusalError("EPERM")) }
    const outcome = await installManifest({ manifestPath, roots: [root], fs })
    expect(outcome).toEqual({ ok: false, done: [], ...clean, refused: [root], reveal: [dirname(root)] })
    expect(readdirSync(dirname(root))).toEqual([])
  })

  test("refusal after a partial temp write leaves the previous manifest and no temp file (injected fs)", async () => {
    const root = containers().word
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, WEF_MANIFEST_FILE), "previous")
    const fs: WefFs = {
      ...nodeWefFs,
      writeFile: async (file, data) => {
        await nodeWefFs.writeFile(file, data.slice(0, 5))
        throw refusalError("EACCES")
      },
    }
    const outcome = await installManifest({ manifestPath, roots: [root], fs })
    expect(outcome.refused).toEqual([root])
    expect(outcome.rollbackErrors).toEqual([])
    expect(readdirSync(root)).toEqual([WEF_MANIFEST_FILE])
    expect(readFileSync(join(root, WEF_MANIFEST_FILE), "utf8")).toBe("previous")
  })

  test("SHA-256 mismatch on re-read rolls the root back and reports HASH_MISMATCH", async () => {
    const root = containers().word
    installApps(root)
    const fs: WefFs = { ...nodeWefFs, writeFile: (file, data) => nodeWefFs.writeFile(file, data.slice(1)) }
    const outcome = await installManifest({ manifestPath, roots: [root], fs })
    expect(outcome.ok).toBe(false)
    expect(outcome.refused).toEqual([])
    expect(outcome.failed.map((item) => [item.path, item.code])).toEqual([[root, "HASH_MISMATCH"]])
    expect(existsSync(root)).toBe(false)
    expect(readdirSync(dirname(root))).toEqual([])
  })

  test("F-M7-3: a planted symlink wef folder fails UNSAFE_PATH and nothing reaches the link target", async () => {
    const roots = containers()
    installApps(roots.word)
    const elsewhere = join(base, "elsewhere")
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, roots.word)
    const outcome = await installManifest({ manifestPath, roots: [roots.word] })
    expect(outcome.ok).toBe(false)
    expect(outcome.refused).toEqual([])
    expect(outcome.failed.map((item) => [item.path, item.code])).toEqual([[roots.word, UNSAFE_PATH]])
    expect(readdirSync(elsewhere)).toEqual([])
    expect(lstatSync(roots.word).isSymbolicLink()).toBe(true)
  })

  test("F-M7-3: a planted symlink manifest fails UNSAFE_PATH; the link target keeps its bytes", async () => {
    const root = containers().word
    mkdirSync(root, { recursive: true })
    const victim = join(base, "victim.txt")
    writeFileSync(victim, "user data")
    symlinkSync(victim, join(root, WEF_MANIFEST_FILE))
    const outcome = await installManifest({ manifestPath, roots: [root] })
    expect(outcome.failed.map((item) => [item.path, item.code])).toEqual([[join(root, WEF_MANIFEST_FILE), UNSAFE_PATH]])
    expect(readFileSync(victim, "utf8")).toBe("user data")
    expect(lstatSync(join(root, WEF_MANIFEST_FILE)).isSymbolicLink()).toBe(true)
    expect(readdirSync(root)).toEqual([WEF_MANIFEST_FILE])
  })

  test("F-M7-3: a symlinked Documents folder fails UNSAFE_PATH and nothing is created through it", async () => {
    const root = containers().word
    mkdirSync(dirname(dirname(root)), { recursive: true })
    const elsewhere = join(base, "elsewhere")
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, dirname(root))
    const outcome = await installManifest({ manifestPath, roots: [root] })
    expect(outcome.failed.map((item) => item.code)).toEqual([UNSAFE_PATH])
    expect(readdirSync(elsewhere)).toEqual([])
  })

  test("F-M7-3: the default writeFile refuses to write through a symlink (O_NOFOLLOW)", async () => {
    const victim = join(base, "victim.txt")
    writeFileSync(victim, "user data")
    const link = join(base, "link.xml")
    symlinkSync(victim, link)
    await expect(nodeWefFs.writeFile(link, MANIFEST)).rejects.toMatchObject({ code: "ELOOP" })
    expect(readFileSync(victim, "utf8")).toBe("user data")
  })
})

describe("uninstallManifest", () => {
  test("U-DT-02: deletes only the manifest; sibling and its mtime untouched; missing dir is not an error", async () => {
    const roots = containers()
    mkdirSync(roots.word, { recursive: true })
    writeFileSync(join(roots.word, WEF_MANIFEST_FILE), MANIFEST)
    writeFileSync(join(roots.word, "other.xml"), "keep")
    const before = statSync(join(roots.word, "other.xml")).mtimeMs
    const outcome = await uninstallManifest({ roots: [roots.word, roots.excel] })
    expect(outcome).toEqual({ ok: true, done: [roots.word, roots.excel], ...clean })
    expect(readdirSync(roots.word)).toEqual(["other.xml"])
    expect(statSync(join(roots.word, "other.xml")).mtimeMs).toBe(before)
    expect(existsSync(roots.excel)).toBe(false)
  })

  test("read-only wef root: delete refused, manifest intact, refusing path returned", async () => {
    const roots = containers()
    mkdirSync(roots.word, { recursive: true })
    mkdirSync(roots.excel, { recursive: true })
    writeFileSync(join(roots.word, WEF_MANIFEST_FILE), MANIFEST)
    writeFileSync(join(roots.excel, WEF_MANIFEST_FILE), MANIFEST)
    lock(roots.word)
    const outcome = await uninstallManifest({ roots: [roots.word, roots.excel] })
    expect(outcome).toEqual({ ok: false, done: [roots.excel], ...clean, refused: [roots.word], reveal: [roots.word] })
    expect(readFileSync(join(roots.word, WEF_MANIFEST_FILE))).toEqual(Buffer.from(MANIFEST))
    expect(existsSync(join(roots.excel, WEF_MANIFEST_FILE))).toBe(false)
  })

  test("a symlinked wef folder is UNSAFE_PATH: nothing is deleted in the link target", async () => {
    const root = containers().word
    installApps(root)
    const elsewhere = join(base, "elsewhere")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, WEF_MANIFEST_FILE), "theirs")
    symlinkSync(elsewhere, root)
    const outcome = await uninstallManifest({ roots: [root] })
    expect(outcome.failed.map((item) => [item.path, item.code])).toEqual([[root, UNSAFE_PATH]])
    expect(readFileSync(join(elsewhere, WEF_MANIFEST_FILE), "utf8")).toBe("theirs")
  })
})

describe("clearCache", () => {
  test("U-DT-05: deletes only the contents of the given OsfWebHost/Data root", async () => {
    const root = join(base, "Containers/com.microsoft.Word/Data/Library/Caches/OsfWebHost/Data")
    const sibling = join(root, "../Keep")
    mkdirSync(join(root, "nested/deep"), { recursive: true })
    writeFileSync(join(root, "nested/deep/a.bin"), "x")
    writeFileSync(join(root, "b.json"), "{}")
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, "c.txt"), "keep")
    const outcome = await clearCache({ root })
    expect(outcome.ok).toBe(true)
    expect(outcome.done.toSorted()).toEqual([join(root, "b.json"), join(root, "nested")])
    expect(existsSync(root)).toBe(true)
    expect(readdirSync(root)).toEqual([])
    expect(readFileSync(join(sibling, "c.txt"), "utf8")).toBe("keep")
  })

  test("missing root is not an error", async () => {
    const outcome = await clearCache({ root: join(base, "absent") })
    expect(outcome).toEqual({ ok: true, done: [], ...clean })
  })

  test("read-only root: refusing entries are returned; reveal is the real root folder", async () => {
    const root = join(base, "Data")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "a.bin"), "x")
    lock(root)
    const outcome = await clearCache({ root })
    expect(outcome.ok).toBe(false)
    expect(outcome.refused).toEqual([join(root, "a.bin")])
    expect(outcome.reveal).toEqual([root])
    expect(readdirSync(root)).toEqual(["a.bin"])
  })

  test("a symlinked root is UNSAFE_PATH; a symlinked child is removed as a link only", async () => {
    const elsewhere = join(base, "elsewhere")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, "keep.txt"), "keep")
    const linkedRoot = join(base, "LinkedData")
    symlinkSync(elsewhere, linkedRoot)
    const linked = await clearCache({ root: linkedRoot })
    expect(linked.failed.map((item) => item.code)).toEqual([UNSAFE_PATH])
    expect(readdirSync(elsewhere)).toEqual(["keep.txt"])

    const root = join(base, "Data")
    mkdirSync(root)
    symlinkSync(elsewhere, join(root, "child"))
    expect((await clearCache({ root })).ok).toBe(true)
    expect(readdirSync(root)).toEqual([])
    expect(readdirSync(elsewhere)).toEqual(["keep.txt"])
  })
})

describe("nearestRealDirectory (F-M7-2)", () => {
  test("skips missing paths, files and symlinks to directories", async () => {
    const real = join(base, "real")
    mkdirSync(real)
    writeFileSync(join(real, "file.txt"), "x")
    symlinkSync(base, join(real, "link"))
    expect(await nearestRealDirectory(join(real, "missing/deeper"))).toBe(real)
    expect(await nearestRealDirectory(join(real, "file.txt"))).toBe(real)
    expect(await nearestRealDirectory(join(real, "link"))).toBe(real)
    expect(await nearestRealDirectory(real)).toBe(real)
  })
})

describe("needsResync (C26a)", () => {
  test("missing installed manifest needs a re-sync when the app is installed", async () => {
    const root = containers().word
    installApps(root)
    expect(await needsResync(MANIFEST, join(root, WEF_MANIFEST_FILE))).toBe(true)
  })

  test("F-M7-6: no container Data/Documents -> no re-sync (nothing to create)", async () => {
    expect(await needsResync(MANIFEST, join(containers().excel, WEF_MANIFEST_FILE))).toBe(false)
  })

  test("identical bytes do not; different bytes do", async () => {
    const root = containers().word
    mkdirSync(root, { recursive: true })
    const installed = join(root, WEF_MANIFEST_FILE)
    writeFileSync(installed, MANIFEST)
    expect(await needsResync(MANIFEST, installed)).toBe(false)
    writeFileSync(installed, "older version")
    expect(await needsResync(MANIFEST, installed)).toBe(true)
  })

  test("F-M7-3: a symlink manifest is never read through; it answers true so install reports UNSAFE_PATH", async () => {
    const root = containers().word
    mkdirSync(root, { recursive: true })
    const victim = join(base, "victim.xml")
    writeFileSync(victim, MANIFEST)
    symlinkSync(victim, join(root, WEF_MANIFEST_FILE))
    const reads: string[] = []
    const fs: WefFs = {
      ...nodeWefFs,
      readFile: (file) => {
        reads.push(file)
        return nodeWefFs.readFile(file)
      },
    }
    expect(await needsResync(MANIFEST, join(root, WEF_MANIFEST_FILE), fs)).toBe(true)
    expect(reads).toEqual([])
    const outcome = await installManifest({ manifestPath, roots: [root] })
    expect(outcome.failed.map((item) => item.code)).toEqual([UNSAFE_PATH])
    expect(readFileSync(victim)).toEqual(Buffer.from(MANIFEST))
  })

  test("F-M7-3: a symlinked wef folder answers true without reading through it", async () => {
    const root = containers().word
    installApps(root)
    const elsewhere = join(base, "elsewhere")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, WEF_MANIFEST_FILE), MANIFEST)
    symlinkSync(elsewhere, root)
    expect(await needsResync(MANIFEST, join(root, WEF_MANIFEST_FILE))).toBe(true)
  })

  test("unreadable installed copy (EPERM) returns false instead of throwing", async () => {
    const root = containers().word
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, WEF_MANIFEST_FILE), MANIFEST)
    const fs: WefFs = { ...nodeWefFs, readFile: async () => Promise.reject(refusalError("EPERM")) }
    expect(await needsResync(MANIFEST, join(root, WEF_MANIFEST_FILE), fs)).toBe(false)
  })

  test("sha256 helper is stable", () => {
    expect(sha256(MANIFEST)).toHaveLength(64)
  })
})
