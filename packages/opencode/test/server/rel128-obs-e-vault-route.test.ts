// 1.2.8 row 43e, AC-OBSe (N8-360; N8-114; 01c §6; SR8-16): `GET /memory/vault` returns `{ folder, hubPath, exists }`
// for the current project. `exists` is false before a mirror run and true after one; the GET itself writes nothing;
// `language` takes only en|id (400 otherwise) and is remembered for the next run; the route is on the own-API read
// list. Red at BASE e1f9673772: the route does not exist (404).
//
// SWARM_VAULT_DIR points at a mkdtemp vault and os.homedir is stubbed to a mkdtemp home, so nothing here can reach the
// real ~/.swarm/vault. The store items are the synthetic fixture of row 43b (test/memory/fixtures/rel128-obs-c).
//
// Run targeted: cd packages/opencode && bun test test/server/rel128-obs-e-vault-route.test.ts

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Vault } from "@opencode-ai/core/vault"
import { Server } from "../../src/server/server"
import { Memory } from "../../src/memory/memory"
import { VaultMirror } from "../../src/memory/vault-mirror"
import { OWN_API_READ_ROUTES } from "../../src/permission/autonomy-parts/own-api"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const FIXTURES = path.join(import.meta.dir, "..", "memory", "fixtures", "rel128-obs-c")
const store = JSON.parse(fs.readFileSync(path.join(FIXTURES, "store.json"), "utf8"))
type Item = VaultMirror.SyncInput["items"][number]
const ITEMS: Item[] = store.items

const app = () => Server.Default().app

async function vault(dir: string, query = "") {
  const response = await app().request(`/memory/vault${query}`, { headers: { "x-opencode-directory": dir } })
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> }
}

/** Every entry below `dir` (relative path -> content, "<dir>" for folders), to show the GET wrote nothing. */
function tree(dir: string) {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isDirectory()) {
        out[rel] = "<dir>"
        walk(full)
      } else out[rel] = entry.isSymbolicLink() ? `-> ${fs.readlinkSync(full)}` : fs.readFileSync(full, "utf8")
    }
  }
  walk(dir)
  return out
}

const parents: string[] = []
afterAll(() => {
  for (const dir of parents) fs.rmSync(dir, { recursive: true, force: true })
})

let vaultDir = ""
const savedEnv = { vault: process.env.SWARM_VAULT_DIR, disable: process.env.SWARM_DISABLE_MEMORY }
let homeSpy: ReturnType<typeof spyOn> | undefined

beforeEach(() => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o43e-")))
  parents.push(parent)
  vaultDir = path.join(parent, "vault")
  fs.mkdirSync(vaultDir)
  fs.mkdirSync(path.join(parent, "home"))
  process.env.SWARM_VAULT_DIR = vaultDir
  delete process.env.SWARM_DISABLE_MEMORY
  homeSpy = spyOn(os, "homedir").mockReturnValue(path.join(parent, "home"))
})

afterEach(async () => {
  homeSpy?.mockRestore()
  if (savedEnv.vault === undefined) delete process.env.SWARM_VAULT_DIR
  else process.env.SWARM_VAULT_DIR = savedEnv.vault
  if (savedEnv.disable === undefined) delete process.env.SWARM_DISABLE_MEMORY
  else process.env.SWARM_DISABLE_MEMORY = savedEnv.disable
  await disposeAllInstances()
  await resetDatabase()
})

describe("AC-OBSe GET /memory/vault", () => {
  test("before a run: folder and hubPath of this project, exists false; the GET creates no file", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const key = Memory.storeKey("global", tmp.path)
    const folder = Vault.vaultProjectFolder(tmp.path, key)
    const before = { vault: tree(vaultDir), project: tree(tmp.path) }

    const res = await vault(tmp.path)
    expect([res.status, res.text]).toEqual([200, res.text])
    expect(res.json()).toEqual({
      folder,
      hubPath: path.join(vaultDir, "swarm-memory", folder, "index.md"),
      exists: false,
    })
    expect({ vault: tree(vaultDir), project: tree(tmp.path) }).toEqual(before)
  })

  test("after a mirror run: exists true; a second GET still writes nothing", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const key = Memory.storeKey("global", tmp.path)
    const run = await VaultMirror.sync({ key, directory: tmp.path, projectRoot: tmp.path, items: ITEMS })
    expect(run.status).toBe("ok")
    const before = tree(vaultDir)

    const res = await vault(tmp.path)
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({
      folder: run.folder,
      hubPath: path.join(vaultDir, "swarm-memory", run.folder, "index.md"),
      exists: true,
    })
    expect(tree(vaultDir)).toEqual(before)
  })

  test("a hub the person edited, or one that is a symlink, is not reported as existing", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const key = Memory.storeKey("global", tmp.path)
    const run = await VaultMirror.sync({ key, directory: tmp.path, projectRoot: tmp.path, items: ITEMS })
    const hub = path.join(vaultDir, "swarm-memory", run.folder, "index.md")
    fs.appendFileSync(hub, "\nmy own line\n")
    expect((await vault(tmp.path)).json().exists).toBe(false)

    const elsewhere = path.join(path.dirname(vaultDir), "elsewhere.md")
    fs.renameSync(hub, elsewhere)
    fs.symlinkSync(elsewhere, hub)
    expect((await vault(tmp.path)).json().exists).toBe(false)
  })

  test("no vault root: exists false and the root is not created", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    fs.rmSync(vaultDir, { recursive: true })
    const res = await vault(tmp.path)
    expect([res.status, res.json().exists]).toEqual([200, false])
    expect(fs.existsSync(vaultDir)).toBe(false)
  })

  test("language=fr is refused with 400; language=en is remembered for the next run and writes nothing", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const key = Memory.storeKey("global", tmp.path)
    expect((await vault(tmp.path, "?language=fr")).status).toBe(400)
    expect(VaultMirror.rememberedLanguage(key)).toBeUndefined()

    const before = tree(vaultDir)
    expect((await vault(tmp.path, "?language=en")).status).toBe(200)
    expect(VaultMirror.rememberedLanguage(key)).toBe("en")
    expect(tree(vaultDir)).toEqual(before)

    // The next run renders English labels with it (L1 en heading).
    const run = await VaultMirror.sync({
      key,
      directory: tmp.path,
      projectRoot: tmp.path,
      projectName: "Synthetic",
      items: ITEMS,
      language: VaultMirror.rememberedLanguage(key),
    })
    const hub = fs.readFileSync(path.join(vaultDir, "swarm-memory", run.folder, "index.md"), "utf8")
    expect(hub).toContain("# Synthetic: Swarm memory")
    expect(hub).toContain('swarm-lang: "en"')
  })

  test("the route is on the own-API read list and its description names the label re-render (SR8-16)", async () => {
    expect(OWN_API_READ_ROUTES.some((entry) => entry.route === "/memory/vault")).toBe(true)
    const spec = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, "..", "..", "..", "sdk", "openapi.json"), "utf8"),
    ) as { paths: Record<string, Record<string, { operationId?: string; description?: string }>> }
    const get = spec.paths["/memory/vault"]?.get
    expect(get?.operationId).toBe("memory.vault")
    expect(get?.description ?? "").toContain("re-renders the generated labels once")
  })
})
