import { afterAll, describe, expect, test } from "bun:test"
import { execFile, execFileSync } from "node:child_process"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveObsidianNoteURL } from "./external-url"
import { ensureObsidianVault, makeLsappinfoRunner } from "./obsidian-registry"

// 1.3.1 row H1 (C127, C128, U16). The P1 registry step with the REAL detection call: makeLsappinfoRunner(execFile)
// runs /usr/bin/lsappinfo (the keyed find for md.obsidian, nothing else) exactly as ipc.ts wires it. Everything it
// reads or writes is a temp folder: a fake home whose Obsidian data folder holds a real-shape obsidian.json
// (`{ vaults: { <16 hex>: { path, ts, open } } }`), and a vault that is NOT at ~/.swarm/vault. The real Obsidian data
// folder is never touched. Nothing is launched or stopped: when Obsidian is running on this machine the suite is
// skipped with a message, because the module would (correctly) refuse with obsidian-running.

const LSAPPINFO = "/usr/bin/lsappinfo"
const darwin = process.platform === "darwin"

function obsidianRunning() {
  if (!darwin) return false
  const out = execFileSync(LSAPPINFO, ["find", "bundleid=md.obsidian"], { encoding: "utf8", timeout: 5000 })
  return out.includes("ASN:")
}

const running = obsidianRunning()
if (running) console.warn("rel131-h1: Obsidian is running on this machine; the live lsappinfo test is skipped (nothing was stopped)")

const base = realpathSync.native(mkdtempSync(join(tmpdir(), "rel131-h1-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const home = join(base, "home")
// Three segments under the fake home, like the real data folder (unsafe-root rule N5 takes home = configDir/../../..).
const configDir = join(home, "fake-library", "fake-support", "obsidian-data")
const registryPath = join(configDir, "obsidian.json")
const backupPath = join(configDir, "obsidian.json.swarm-backup")
// A vault the person moved elsewhere (SWARM_VAULT_DIR), not <home>/.swarm/vault.
const vaultRoot = join(home, "Notes", "swarm-vault-elsewhere")
const hubPath = join(vaultRoot, "swarm-memory", "default-project-0a1b2c", "index.md")
mkdirSync(configDir, { recursive: true })
mkdirSync(join(vaultRoot, "swarm-memory", "default-project-0a1b2c"), { recursive: true })
writeFileSync(hubPath, "# Swarm memory (synthetic)\n")
const other = (name: string) => {
  const dir = join(home, "Notes", name)
  mkdirSync(dir, { recursive: true })
  return dir
}
const original = JSON.stringify({
  vaults: {
    "1f2e3d4c5b6a7980": { path: other("journal"), ts: 1_699_999_998_000, open: false },
    "0a9b8c7d6e5f4a3b": { path: other("reading"), ts: 1_699_999_999_000, open: true },
  },
  frame: "hidden",
})
writeFileSync(registryPath, original, { mode: 0o644 })

const input = () => ({
  configDir,
  vaultRoot,
  hubPath,
  appPresent: true,
  runLsappinfo: makeLsappinfoRunner(execFile),
})

describe.skipIf(!darwin || running)("H1 live: real /usr/bin/lsappinfo + temp Obsidian data folder", () => {
  test("the real runner answers exit 0 with whitespace-only stdout while Obsidian is closed", async () => {
    const seen = await makeLsappinfoRunner(execFile)()
    expect(seen.code).toBe(0)
    expect(seen.stdout.trim()).toBe("")
  })

  test("first press -> registered: atomic replace, other entries byte-for-byte, new entry exactly { path, ts }, backup once", async () => {
    const inodeBefore = lstatSync(registryPath).ino
    expect(await ensureObsidianVault(input())).toEqual({ result: "registered" })
    const written = readFileSync(registryPath, "utf8")
    // rename(2) of a tmp file: a new inode at the name, no tmp file left beside it.
    expect(lstatSync(registryPath).ino).not.toBe(inodeBefore)
    expect(readdirSync(configDir).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect(lstatSync(registryPath).mode & 0o777).toBe(0o644)
    const before = JSON.parse(original)
    const after = JSON.parse(written)
    const added = Object.keys(after.vaults).filter((id) => !Object.hasOwn(before.vaults, id))
    expect(added.length).toBe(1)
    expect(added[0]).toMatch(/^[0-9a-f]{16}$/)
    expect(Object.keys(after.vaults[added[0]!])).toEqual(["path", "ts"])
    expect(after.vaults[added[0]!].path).toBe(realpathSync.native(vaultRoot))
    for (const id of Object.keys(before.vaults)) {
      expect(written.includes(JSON.stringify(id) + ":" + JSON.stringify(before.vaults[id]))).toBe(true)
    }
    expect(after.frame).toBe("hidden")
    expect(readFileSync(backupPath, "utf8")).toBe(original)
  })

  test("the obsidian:// URL names the note by path, and Obsidian's vault match (exact or path + '/') picks the new entry", async () => {
    const resolved = await resolveObsidianNoteURL(hubPath, vaultRoot)
    if (!("url" in resolved)) throw new Error("expected a URL")
    const url = new URL(resolved.url)
    expect(url.protocol + url.host).toBe("obsidian:open")
    const notePath = url.searchParams.get("path")!
    const vaults = JSON.parse(readFileSync(registryPath, "utf8")).vaults as Record<string, { path: string }>
    const matches = Object.keys(vaults).filter((id) => notePath === vaults[id]!.path || notePath.startsWith(vaults[id]!.path + "/"))
    expect(matches.length).toBe(1)
    expect(vaults[matches[0]!]!.path).toBe(realpathSync.native(vaultRoot))
  })

  test("second press -> in-vault; the list and the backup are unchanged", async () => {
    const list = readFileSync(registryPath)
    const backup = readFileSync(backupPath)
    expect(await ensureObsidianVault(input())).toEqual({ result: "in-vault" })
    expect(readFileSync(registryPath).equals(list)).toBe(true)
    expect(readFileSync(backupPath).equals(backup)).toBe(true)
  })
})
