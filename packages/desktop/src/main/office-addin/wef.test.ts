import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearCache,
  installManifest,
  needsResync,
  nodeWefFs,
  sha256,
  uninstallManifest,
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

const lock = (dir: string) => {
  chmodSync(dir, 0o555)
  locked.push(dir)
}

const refusalError = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code })

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
    const outcome = await installManifest({ manifestPath, roots: [roots.word, roots.excel] })
    expect(outcome).toEqual({ ok: true, done: [roots.word, roots.excel], refused: [], failed: [], rollbackErrors: [] })
    expect(readFileSync(join(roots.word, WEF_MANIFEST_FILE))).toEqual(Buffer.from(MANIFEST))
    expect(readFileSync(join(roots.excel, WEF_MANIFEST_FILE))).toEqual(Buffer.from(MANIFEST))
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

  test("read-only Documents (wef missing): mkdir refused, nothing left, refusing path returned", async () => {
    const roots = containers()
    const documents = join(roots.word, "..")
    mkdirSync(documents, { recursive: true })
    lock(documents)
    const outcome = await installManifest({ manifestPath, roots: [roots.word, roots.excel] })
    expect(outcome.ok).toBe(false)
    expect(outcome.refused).toEqual([roots.word])
    expect(outcome.failed).toEqual([])
    expect(outcome.rollbackErrors).toEqual([])
    expect(existsSync(roots.word)).toBe(false)
    expect(readdirSync(documents)).toEqual([])
    // A root that did not refuse keeps its verified copy: the Finder fallback targets only `refused`.
    expect(outcome.done).toEqual([roots.excel])
    expect(readFileSync(join(roots.excel, WEF_MANIFEST_FILE))).toEqual(Buffer.from(MANIFEST))
  })

  test("read-only wef root: write refused, no partial file, both refusing paths returned", async () => {
    const roots = containers()
    mkdirSync(roots.word, { recursive: true })
    mkdirSync(roots.excel, { recursive: true })
    writeFileSync(join(roots.excel, "other.xml"), "keep")
    lock(roots.word)
    lock(roots.excel)
    const outcome = await installManifest({ manifestPath, roots: [roots.word, roots.excel] })
    expect(outcome).toEqual({ ok: false, done: [], refused: [roots.word, roots.excel], failed: [], rollbackErrors: [] })
    expect(readdirSync(roots.word)).toEqual([])
    expect(readdirSync(roots.excel)).toEqual(["other.xml"])
  })

  test("refusal after mkdir succeeded rolls back the created folders (injected fs)", async () => {
    const root = containers().word
    const dataDir = join(root, "../..")
    mkdirSync(dataDir, { recursive: true })
    const fs: WefFs = { ...nodeWefFs, writeFile: async () => Promise.reject(refusalError("EPERM")) }
    const outcome = await installManifest({ manifestPath, roots: [root], fs })
    expect(outcome).toEqual({ ok: false, done: [], refused: [root], failed: [], rollbackErrors: [] })
    expect(readdirSync(dataDir)).toEqual([])
  })

  test("refusal after a partial write restores the previous manifest byte for byte (injected fs)", async () => {
    const root = containers().word
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, WEF_MANIFEST_FILE), "previous")
    const fs: WefFs = {
      ...nodeWefFs,
      writeFile: async (file, data) => {
        if (new TextDecoder().decode(data) === "previous") return nodeWefFs.writeFile(file, data)
        await nodeWefFs.writeFile(file, data.slice(0, 5))
        throw refusalError("EACCES")
      },
    }
    const outcome = await installManifest({ manifestPath, roots: [root], fs })
    expect(outcome.refused).toEqual([root])
    expect(outcome.rollbackErrors).toEqual([])
    expect(readFileSync(join(root, WEF_MANIFEST_FILE), "utf8")).toBe("previous")
  })

  test("SHA-256 mismatch on re-read rolls the root back and reports HASH_MISMATCH", async () => {
    const root = containers().word
    const fs: WefFs = { ...nodeWefFs, writeFile: (file, data) => nodeWefFs.writeFile(file, data.slice(1)) }
    const outcome = await installManifest({ manifestPath, roots: [root], fs })
    expect(outcome.ok).toBe(false)
    expect(outcome.refused).toEqual([])
    expect(outcome.failed.map((item) => [item.path, item.code])).toEqual([[root, "HASH_MISMATCH"]])
    expect(existsSync(join(base, "Containers"))).toBe(false)
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
    expect(outcome).toEqual({ ok: true, done: [roots.word, roots.excel], refused: [], failed: [], rollbackErrors: [] })
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
    expect(outcome).toEqual({ ok: false, done: [roots.excel], refused: [roots.word], failed: [], rollbackErrors: [] })
    expect(readFileSync(join(roots.word, WEF_MANIFEST_FILE))).toEqual(Buffer.from(MANIFEST))
    expect(existsSync(join(roots.excel, WEF_MANIFEST_FILE))).toBe(false)
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
    expect(outcome).toEqual({ ok: true, done: [], refused: [], failed: [], rollbackErrors: [] })
  })

  test("read-only root: refusing entries are returned", async () => {
    const root = join(base, "Data")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "a.bin"), "x")
    lock(root)
    const outcome = await clearCache({ root })
    expect(outcome.ok).toBe(false)
    expect(outcome.refused).toEqual([join(root, "a.bin")])
    expect(readdirSync(root)).toEqual(["a.bin"])
  })
})

describe("needsResync (C26a)", () => {
  test("missing installed manifest needs a re-sync", async () => {
    expect(await needsResync(MANIFEST, join(containers().word, WEF_MANIFEST_FILE))).toBe(true)
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

  test("unreadable installed copy (EPERM) returns false instead of throwing", async () => {
    const fs: WefFs = { ...nodeWefFs, readFile: async () => Promise.reject(refusalError("EPERM")) }
    expect(await needsResync(MANIFEST, "/nowhere/" + WEF_MANIFEST_FILE, fs)).toBe(false)
  })

  test("sha256 helper is stable", () => {
    expect(sha256(MANIFEST)).toHaveLength(64)
  })
})
