// AC-OBSa (N8-357, 1.2.8 row 43): the vault root resolver in core, the project folder name
// (D-O4, R20-C20) and the drift pin against setup's register constant. Every case uses a
// mkdtemp HOME (OPENCODE_TEST_HOME) or a temp SWARM_VAULT_DIR; the real ~/.swarm/vault is
// never read or written.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { readdirSync, readFileSync, statSync } from "fs"
import os from "os"
import path from "path"
import { Vault } from "@opencode-ai/core/vault"

const repo = path.resolve(import.meta.dir, "../../..")

let home: string
const saved = { home: process.env.OPENCODE_TEST_HOME, vault: process.env.SWARM_VAULT_DIR }

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "obsa-")))
  process.env.OPENCODE_TEST_HOME = home
  delete process.env.SWARM_VAULT_DIR
})

afterEach(async () => {
  if (saved.home === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = saved.home
  if (saved.vault === undefined) delete process.env.SWARM_VAULT_DIR
  else process.env.SWARM_VAULT_DIR = saved.vault
  await fs.rm(home, { recursive: true, force: true })
})

describe("Vault.root", () => {
  test("defaults to <OPENCODE_TEST_HOME>/.swarm/vault", () => {
    expect(Vault.root()).toBe(path.join(home, ".swarm/vault"))
    expect(Vault.mirrorDir()).toBe(path.join(home, ".swarm/vault", "swarm-memory"))
  })

  test("SWARM_VAULT_DIR wins when set and non-empty", () => {
    const dir = path.join(home, "elsewhere")
    process.env.SWARM_VAULT_DIR = dir
    expect(Vault.root()).toBe(dir)
    expect(Vault.mirrorDir()).toBe(path.join(dir, "swarm-memory"))
  })

  test("an empty or blank SWARM_VAULT_DIR falls back to the default", () => {
    process.env.SWARM_VAULT_DIR = ""
    expect(Vault.root()).toBe(path.join(home, ".swarm/vault"))
    process.env.SWARM_VAULT_DIR = "   "
    expect(Vault.root()).toBe(path.join(home, ".swarm/vault"))
  })

  test("constants are the registered values", () => {
    expect(Vault.VAULT_DEFAULT_DIR).toBe(".swarm/vault")
    expect(Vault.VAULT_MIRROR_DIR).toBe("swarm-memory")
  })
})

describe("drift", () => {
  test("VAULT_DEFAULT_DIR equals the relative part of setup's VAULT_ROOT", () => {
    const src = readFileSync(path.join(repo, "packages/setup/src/mcpproxy/register.ts"), "utf8")
    const root = src.match(/export const VAULT_ROOT = "([^"]+)"/)?.[1]
    expect(root).toBe("~/" + Vault.VAULT_DEFAULT_DIR)
    const env = src.match(/VAULT_DIR: "([^"]+)"/)?.[1]
    expect(env).toBe("SWARM_VAULT_DIR")
  })

  test("every vault default literal in desktop main equals VAULT_DEFAULT_DIR", () => {
    // Desktop main keeps its own copy (no core dependency, 01c §2/§7, row 42c). Any
    // `.swarm/vault`-shaped literal there must be this exact value.
    const dir = path.join(repo, "packages/desktop/src/main")
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => statSync(path.join(dir, f)).isFile())
    for (const f of files) {
      const text = readFileSync(path.join(dir, f), "utf8")
      for (const m of text.matchAll(/["'`]~?\/?(\.swarm\/vault[^"'`]*)["'`]/g)) {
        expect(`${f}: ${m[1]}`).toBe(`${f}: ${Vault.VAULT_DEFAULT_DIR}`)
      }
    }
  })
})

describe("vaultProjectFolder", () => {
  test("dir- key: slug of the basename plus 6 chars after the prefix", () => {
    expect(Vault.vaultProjectFolder("/x/Default Project", "dir-3fa9c1d2e4b5a6c7d8e9f0a1")).toBe(
      "default-project-3fa9c1",
    )
  })

  test("git project key: first 6 chars", () => {
    expect(Vault.vaultProjectFolder("/Users/a/repo", "a1b2c3d4e5f6")).toBe("repo-a1b2c3")
  })

  test("a 60-character basename is trimmed to 40", () => {
    const name = "a".repeat(30) + "-" + "b".repeat(29)
    expect(name.length).toBe(60)
    const folder = Vault.vaultProjectFolder("/x/" + name, "dir-0123456789abcdef")
    const slug = folder.slice(0, -"-012345".length)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug).toBe(("a".repeat(30) + "-" + "b".repeat(29)).slice(0, 40))
    expect(folder.endsWith("-012345")).toBe(true)
  })

  test('"!!!" becomes project-<id>', () => {
    expect(Vault.vaultProjectFolder("/x/!!!", "dir-abcdef0123")).toBe("project-abcdef")
  })

  test("slug rules: lowercase, runs collapse, trim, no trailing dash after the cut", () => {
    expect(Vault.vaultProjectFolder("/x/  My__Cool..Project  ", "deadbeef00")).toBe("my-cool-project-deadbe")
    const cut = "a".repeat(39) + "-bbbb"
    expect(Vault.vaultProjectFolder("/x/" + cut, "dir-ffffff")).toBe("a".repeat(39) + "-ffffff")
    expect(Vault.vaultProjectFolder("/", "dir-ffffff")).toBe("project-ffffff")
  })

  test("never yields a path separator or dot segment", () => {
    for (const dir of ["/x/../..", "/x/.hidden", "/x/a\\b", "/x/é ü"]) {
      const folder = Vault.vaultProjectFolder(dir, "dir-123abc")
      expect(folder).toMatch(/^[a-z0-9][a-z0-9-]*-[a-z0-9]{1,6}$/)
    }
  })
})

describe("path checks for the mirror writer", () => {
  test("realRoot: undefined when absent, never creates it", async () => {
    expect(await Vault.realRoot()).toBeUndefined()
    expect(await fs.readdir(home)).toEqual([])
  })

  test("realRoot: undefined when the root is a file", async () => {
    await fs.mkdir(path.join(home, ".swarm"))
    await fs.writeFile(path.join(home, ".swarm/vault"), "x")
    expect(await Vault.realRoot()).toBeUndefined()
  })

  test("realRoot: resolves a symlinked root (the person's choice)", async () => {
    const real = path.join(home, "real-vault")
    await fs.mkdir(real)
    await fs.mkdir(path.join(home, ".swarm"))
    await fs.symlink(real, path.join(home, ".swarm/vault"))
    expect(await Vault.realRoot()).toBe(real)
  })

  test("contains: inside yes; parent, sibling, itself, absolute escape no", () => {
    const p = "/v/swarm-memory"
    expect(Vault.contains(p, "/v/swarm-memory/a/b.md")).toBe(true)
    expect(Vault.contains(p, "/v/swarm-memory/..x/b.md")).toBe(true)
    expect(Vault.contains(p, "/v/swarm-memory")).toBe(false)
    expect(Vault.contains(p, "/v/inbox/a.md")).toBe(false)
    expect(Vault.contains(p, "/v/swarm-memory/../inbox/a.md")).toBe(false)
    expect(Vault.contains(p, "/etc/passwd")).toBe(false)
  })
})
