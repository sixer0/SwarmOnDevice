// 1.2.8 row 43f (M2 gate G2-01 Medium, G2-02 Low; C104; SR8-20, 01c section 7.2, AC-R18f): no absolute home path in
// memory notes, vault notes or logs.
//   G2-01: a global-scope skill saved through PUT /skill -> its memory note (text, body, refs) carries `~/...`, never the
//          home folder; the mirrored vault note `skills/<name>.md` neither. The render rewrites the home folder to `~`
//          in any note (a legacy absolute ref under home, or one in a body), and an absolute ref outside home shows its
//          basename only.
//   G2-02: the vault mirror's VAULT_PATH_UNSAFE refusal (the sync log entry and the server's "vault mirror refused a
//          path" line) and the server's "re-home failed" line carry no absolute path.
// Red at the pre-fix HEAD (f7969307ab): the note ref is the absolute SKILL.md location, the References list copies it,
// the refusal logs the absolute folder path and the re-home line logs the fs error with its absolute path. BASE
// e1f9673772 has none of the skill routes, the vault mirror or the re-home route (red by module-missing).
//
// HOME: the global config folder is fixed at import (XDG_CONFIG_HOME from the test preload), so for the end-to-end part
// HOME is the preload's temp folder that holds it (OPENCODE_TEST_HOME and os.homedir both set to it, restored after);
// the render and sync parts use a fresh mkdtemp HOME. The real home, vault and memory stores are never touched.
// Run targeted: cd packages/opencode && bun test test/memory/rel128-g2-path-hygiene.test.ts

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Vault } from "@opencode-ai/core/vault"
// The server first: its import graph settles the permission modules' load order (as in rel128-sk-d-skill-routes).
import { Server } from "../../src/server/server"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { VaultMirror } from "../../src/memory/vault-mirror"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const NONCE = "g2p-nonce-0123456789abcdefghijklmnopqrstu"
const HEADER = "x-swarm-desktop-nonce"
const SKILL = "tarif-check"
const CONTENT = (description: string) => `---\nname: ${SKILL}\ndescription: ${description}\n---\n\nCheck the tariff table.\n`

const app = () => Server.Default().app

async function call(dir: string, method: string, url: string, body?: unknown) {
  const response = await app().request(url, {
    method,
    headers: {
      "x-opencode-directory": dir,
      [HEADER]: NONCE,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, json: () => JSON.parse(text) as any, text }
}

/** Every spelling of a folder a note or log could carry: as given, its real path, and Markdown-escaped. */
async function spellings(dir: string) {
  const real = await fs.realpath(dir).catch(() => dir)
  return [...new Set([dir, real, VaultMirror.escapeText(dir), VaultMirror.escapeText(real)])]
}

const carries = (text: string, forms: readonly string[]) => forms.filter((form) => text.includes(form))

/** Lines of the server log file that contain `message` (the file logger batches, so it is polled). */
async function logLines(message: string, want = 1) {
  const file = path.join(Global.Path.log, "opencode.log")
  for (let i = 0; i < 60; i++) {
    const text = await fs.readFile(file, "utf8").catch(() => "")
    const lines = text.split("\n").filter((line) => line.includes(message))
    if (lines.length >= want) return lines
    await Bun.sleep(100)
  }
  return []
}

const ABSOLUTE = /(^|[\s"'=(])(\/|[A-Za-z]:\\)[^\s"']/

// ---------------------------------------------------------------------------------------------------------------
// End to end: PUT /skill (global) -> memory note -> vault mirror; then a refused mirror run's server log line.

describe("G2-01 a global skill's memory note and vault note carry no home path", () => {
  const home = path.dirname(path.dirname(Global.Path.config))
  const vault = path.join(home, Vault.VAULT_DEFAULT_DIR)
  const outside = path.join(home, "g2p-outside")
  const before = {
    home: process.env.OPENCODE_TEST_HOME,
    vault: process.env.SWARM_VAULT_DIR,
    off: process.env.SWARM_DISABLE_MEMORY,
  }
  const runs: { key: string; result: VaultMirror.SyncResult }[] = []
  let restoreHome: (() => void) | undefined
  let stop: (() => void) | undefined

  beforeAll(async () => {
    const spy = spyOn(os, "homedir").mockReturnValue(home)
    restoreHome = () => spy.mockRestore()
    process.env.OPENCODE_TEST_HOME = home
    delete process.env.SWARM_VAULT_DIR
    delete process.env.SWARM_DISABLE_MEMORY
    await fs.mkdir(vault, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    stop = VaultMirror.onRun((key, result) => runs.push({ key, result }))
    DesktopNonce.set(NONCE)
  })
  afterAll(async () => {
    stop?.()
    DesktopNonce.set(undefined)
    restoreHome?.()
    for (const [name, value] of [
      ["OPENCODE_TEST_HOME", before.home],
      ["SWARM_VAULT_DIR", before.vault],
      ["SWARM_DISABLE_MEMORY", before.off],
    ] as const)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    await fs.rm(path.join(Global.Path.config, "skills", SKILL), { recursive: true, force: true })
    await fs.rm(path.join(home, ".swarm"), { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
    await disposeAllInstances()
    await resetDatabase()
  })

  /** The first run after `from` for the store of `dir` (its folder starts with the folder's base name). */
  const runAfter = async (from: number, dir: string, ms = 8000) => {
    const prefix = path.basename(dir).toLowerCase() + "-"
    for (let waited = 0; waited < ms; waited += 100) {
      const mine = runs.slice(from).find((run) => run.result.folder.startsWith(prefix))
      if (mine) return mine
      await Bun.sleep(100)
    }
    return undefined
  }

  test(
    "PUT /skill scope global -> note text/body/refs use ~/, the vault skill note has no home path; a refused run logs no path",
    async () => {
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const location = path.join(Global.Path.config, "skills", SKILL, "SKILL.md")
      expect(location.startsWith(home + path.sep)).toBe(true)
      const forms = await spellings(home)

      const start = runs.length
      const saved = await call(tmp.path, "PUT", "/skill", { scope: "global", name: SKILL, content: CONTENT("Checks tariffs") })
      expect(saved.status).toBe(200)
      expect(saved.json().note).toBe("added")
      expect(existsSync(location)).toBe(true)

      const items = (await call(tmp.path, "GET", "/memory")).json().items as any[]
      const notes = items.filter((item) => typeof item.text === "string" && item.text.startsWith(`Skill ${SKILL} `))
      expect(notes).toHaveLength(1)
      const shown = "~/" + path.relative(home, location).split(path.sep).join("/")
      expect(notes[0].refs).toEqual([{ path: shown }])
      expect(notes[0].body).toContain(`Path: ${shown}`)
      expect(carries(JSON.stringify(notes[0]), forms)).toEqual([])

      // The debounced mirror run (2000 ms) writes skills/<name>.md under the store's folder.
      const run = await runAfter(start, tmp.path)
      expect(run?.result.status).toBe("ok")
      const folder = path.join(vault, Vault.VAULT_MIRROR_DIR, run!.result.folder)
      const skillFile = run!.result.written.find((file) => file.startsWith("skills/"))
      expect(skillFile).toBeDefined()
      for (const file of run!.result.written) {
        const text = await fs.readFile(path.join(folder, file), "utf8")
        expect({ file, hits: carries(text, forms) }).toEqual({ file, hits: [] })
      }
      expect(await fs.readFile(path.join(folder, skillFile!), "utf8")).toContain(VaultMirror.escapeText(shown))

      // G2-02: the store folder swapped for a symlink out of the vault -> the next run refuses (VAULT_PATH_UNSAFE) and
      // the server's warning line names neither the home folder nor any absolute path.
      await fs.rename(folder, path.join(outside, "moved"))
      await fs.symlink(path.join(outside, "moved"), folder)
      const again = runs.length
      const resaved = await call(tmp.path, "PUT", "/skill", {
        scope: "global",
        name: SKILL,
        content: CONTENT("Checks tariffs twice"),
        baseHash: saved.json().hash,
      })
      expect(resaved.status).toBe(200)
      expect((await runAfter(again, tmp.path))?.result.status).toBe("unsafe")
      const lines = await logLines("vault mirror refused a path")
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(carries(line, forms)).toEqual([])
        const pathField = /\bpath=("(?:[^"\\]|\\.)*"|\S+)/.exec(line)?.[1] ?? ""
        const reasonField = /\breason=("(?:[^"\\]|\\.)*"|\S+)/.exec(line)?.[1] ?? ""
        expect({ pathField, absolute: ABSOLUTE.test(" " + pathField) }).toEqual({ pathField, absolute: false })
        expect({ reasonField, absolute: ABSOLUTE.test(" " + reasonField) }).toEqual({ reasonField, absolute: false })
      }
    },
    40000,
  )
})

// ---------------------------------------------------------------------------------------------------------------
// Render and sync with a fresh mkdtemp HOME.

describe("G2-01 render rewrites the home folder; G2-02 the sync's refusal entry has no absolute path", () => {
  let home = ""
  let mkdtempHome = ""
  let restoreHome: (() => void) | undefined
  const before = { home: process.env.OPENCODE_TEST_HOME, vault: process.env.SWARM_VAULT_DIR }

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "g2p-")))
    mkdtempHome = home
    const spy = spyOn(os, "homedir").mockReturnValue(home)
    restoreHome = () => spy.mockRestore()
    process.env.OPENCODE_TEST_HOME = home
  })
  afterAll(async () => {
    restoreHome?.()
    if (before.home === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = before.home
    if (before.vault === undefined) delete process.env.SWARM_VAULT_DIR
    else process.env.SWARM_VAULT_DIR = before.vault
    await fs.rm(home, { recursive: true, force: true })
  })

  const items = (home: string) => [
    {
      id: "a1b2c3",
      text: `Skill ${SKILL} (global): Checks tariffs. Triggers: by name only.`,
      source: "user" as const,
      deviceOnly: false,
      time: 1787000000000,
      body: `Path: ${path.join(home, ".config", "swarm", "skills", SKILL, "SKILL.md")}`,
      // A note saved before row 43f: the absolute location under home.
      refs: [{ path: path.join(home, ".config", "swarm", "skills", SKILL, "SKILL.md") }],
    },
    {
      id: "d4e5f6",
      text: "The tariff table is kept outside the project",
      source: "agent" as const,
      deviceOnly: false,
      time: 1787000001000,
      refs: [{ path: path.join(home, "Documents", "tarif", "table.md"), line: 3 }, { path: "/opt/shared/tarif/rates.md" }],
    },
  ]

  // The render reads no disk. A temp folder name reads as a token to the secret check (the note would be skipped, not
  // rendered), so this case uses the gate probe's home spelling, which only exists as a string here.
  test("no rendered note carries the home folder (raw or escaped); an absolute ref outside home shows its basename", async () => {
    const home = "/Users/someone"
    process.env.OPENCODE_TEST_HOME = home
    const spy = spyOn(os, "homedir").mockReturnValue(home)
    const project = path.join(home, "Documents", "Default Project", "tarif")
    const key = "dir-0123456789abcdef01234567"
    let rendered: ReturnType<typeof VaultMirror.render>
    try {
      rendered = VaultMirror.render({
        key,
        folder: Vault.vaultProjectFolder(project, key),
        projectName: "tarif",
        items: items(home),
        reports: {},
      })
    } finally {
      spy.mockRestore()
      process.env.OPENCODE_TEST_HOME = mkdtempHome
    }
    expect(rendered.notCopied).toBe(0)
    expect(rendered.files.length).toBeGreaterThan(2)
    const forms = [home, VaultMirror.escapeText(home)]
    for (const file of rendered.files) expect({ file: file.path, hits: carries(file.content, forms) }).toEqual({ file: file.path, hits: [] })
    const all = rendered.files.map((file) => file.content).join("\n")
    expect(all).toContain(VaultMirror.escapeText(`~/.config/swarm/skills/${SKILL}/SKILL.md`))
    expect(all).toContain(VaultMirror.escapeText("~/Documents/tarif/table.md:3"))
    expect(all).toContain(`- ${VaultMirror.escapeText("rates.md")}`)
    expect(all).not.toContain(VaultMirror.escapeText("/opt/shared"))
  })

  test("VAULT_PATH_UNSAFE (store folder is a symlink out of the vault): the entry's path is vault-relative, no absolute path", async () => {
    const vault = path.join(home, ".swarm", "vault")
    const outside = path.join(home, "outside")
    await fs.mkdir(path.join(vault, Vault.VAULT_MIRROR_DIR), { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    process.env.SWARM_VAULT_DIR = vault
    const project = path.join(home, "Documents", "Default Project", "tarif")
    const key = "dir-0123456789abcdef01234567"
    const folder = Vault.vaultProjectFolder(project, key)
    await fs.symlink(outside, path.join(vault, Vault.VAULT_MIRROR_DIR, folder))
    const logs: { code: string; path: string; reason: string }[] = []
    const result = await VaultMirror.sync({
      key,
      directory: project,
      projectRoot: project,
      projectName: "tarif",
      items: items(home).slice(1),
      log: (entry) => logs.push(entry),
    })
    expect(result.status).toBe("unsafe")
    const unsafe = logs.filter((entry) => entry.code === "VAULT_PATH_UNSAFE")
    expect(unsafe).toHaveLength(1)
    const forms = await spellings(home)
    expect(carries(JSON.stringify(unsafe[0]), forms)).toEqual([])
    expect(path.isAbsolute(unsafe[0]!.path)).toBe(false)
    expect(ABSOLUTE.test(" " + unsafe[0]!.reason)).toBe(false)
    expect(await fs.readdir(outside)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// G2-02: a failed re-home logs the error code and the message without paths.

describe("G2-02 the re-home failure line carries no absolute path", () => {
  const MISSION = "2026-09-02_lumen-release-checklist"
  const GROUP = "Lumen"
  let home = ""
  let restoreHome: (() => void) | undefined
  const before = { root: process.env.SWARM_DEFAULT_PROJECT_DIR }
  const journals = path.join(Global.Path.data, "rehome")

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "g2r-")))
    const spy = spyOn(os, "homedir").mockReturnValue(home)
    restoreHome = () => spy.mockRestore()
  })
  afterEach(async () => {
    DesktopNonce.set(undefined)
    await fs.rm(journals, { recursive: true, force: true })
    await disposeAllInstances()
    await resetDatabase()
  })
  afterAll(async () => {
    restoreHome?.()
    if (before.root === undefined) delete process.env.SWARM_DEFAULT_PROJECT_DIR
    else process.env.SWARM_DEFAULT_PROJECT_DIR = before.root
    await fs.rm(home, { recursive: true, force: true })
  })

  test("journal folder unwritable (a file in its place) -> 500 and the logged error has code, no path", async () => {
    const R = path.join(home, "Documents", "Default Project")
    await fs.mkdir(path.join(R, "docs", MISSION, "report"), { recursive: true })
    await fs.writeFile(path.join(R, "docs", MISSION, "report", "report.md"), "# Checklist\n")
    await fs.mkdir(path.join(R, GROUP, ".swarm"), { recursive: true })
    await fs.writeFile(
      path.join(R, GROUP, ".swarm", "group.json"),
      JSON.stringify({ version: 1, name: GROUP, kind: "product", created: 1787000000000 }) + "\n",
    )
    await fs.writeFile(path.join(R, "swarm.json"), JSON.stringify({ formatter: false, lsp: false }))
    process.env.SWARM_DEFAULT_PROJECT_DIR = R
    await fs.rm(journals, { recursive: true, force: true })
    await fs.mkdir(path.dirname(journals), { recursive: true })
    await fs.writeFile(journals, "not a folder\n")
    DesktopNonce.set(NONCE)

    const already = (await logLines("re-home failed", 0)).length
    const response = await app().request("/project/rehome", {
      method: "POST",
      headers: { "x-opencode-directory": R, "content-type": "application/json", [HEADER]: NONCE },
      body: JSON.stringify({ missionId: MISSION, from: R, to: path.join(R, GROUP), sessions: [], approvalRef: "D-1" }),
    })
    expect(response.status).toBe(500)
    const lines = (await logLines("re-home failed", already + 1)).slice(already)
    expect(lines.length).toBeGreaterThan(0)
    const forms = [...(await spellings(home)), ...(await spellings(Global.Path.data))]
    for (const line of lines) {
      expect(carries(line, forms)).toEqual([])
      const error = /\berror=("(?:[^"\\]|\\.)*"|\S+)/.exec(line)?.[1] ?? ""
      expect(error).not.toBe("")
      expect({ error, absolute: ABSOLUTE.test(" " + error) }).toEqual({ error, absolute: false })
      expect(line).toMatch(/\bcode=E[A-Z]+/)
    }
  }, 30000)
})
