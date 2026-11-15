// 1.2.10 row 55, AC-P4d (N10-176): a device-only note the person exported (`vaultAllowed`, N10-061) is copied into the
// vault mirror on the next run, through the one exclusion decision `mirrorExclusion` (N10-062, 01d §3.2), while
// `prompt` and `recall` still give it only to an on-device model. Folded findings (01_specs §4): S10-01(P4) an exported
// index entry copies its final report only while the report's sha256 equals the confirmed one (`vaultReportSha256`,
// N10-074), else a link-only report note with N10-075; S10-08(P4) an exported roll-up copies no report. C18 D-9: the
// close nudge (`missionIndexed`, N10-070) links only entries the mirror copies.
// Red at BASE a3e3c4c93a: the 1.2.9 mirror excludes every deviceOnly item, so the exported note is absent after one
// sync, and the close nudge of a device-only, not exported index entry carries `[[...]]` links (F18).
// Every test runs in its own mkdtemp vault and project (SWARM_VAULT_DIR, os.homedir stubbed); fixtures are row 40's
// synthetic stores (rel1210-p4/) and the 1.2.8 synthetic report (rel128-obs-c/report.md). Never the real vault.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Vault } from "@opencode-ai/core/vault"
import type { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { DatumStudioMcp } from "@/mcp/datum-studio"
import { Memory } from "@/memory/memory"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import * as Truncate from "@/tool/truncate"
import { VaultMirror } from "../../src/memory/vault-mirror"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const P4 = path.join(import.meta.dir, "fixtures", "rel1210-p4")
const reportBytes = fs.readFileSync(path.join(import.meta.dir, "fixtures", "rel128-obs-c", "report.md"))
type Item = VaultMirror.SyncInput["items"][number]
type Store = { key: string; folder: string; projectName: string; version: number; enabled: boolean; items: Item[] }
const fixture = (name: string): Store => JSON.parse(fs.readFileSync(path.join(P4, name), "utf8"))
const exported = fixture("exported.json")
const item = (store: Store, id: string) => store.items.find((entry) => entry.id === id)!
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

const QUANDEL = "2026-10-02_quandel-review"
const VESTREL = "2026-10-05_vestrel-audit"
const REPORT = `docs/${QUANDEL}/report/report.md`
const REPORT_WORD = "Kajian tarif: laporan akhir"
const noteFile = (store: Store, id: string) => `notes/${VaultMirror.noteName("note", id, item(store, id).text)}`
const missionFile = (id: string) => `missions/${VaultMirror.noteName("mission", id)}`
const reportFile = (id: string) => `reports/${VaultMirror.noteName("report", id)}`

// ---------------------------------------------------------------------------------------------------------------
// A temp vault, project and home for the whole file; the store-driven runs (prompt backfill, close) land here too.

let parent = ""
let vault = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
const savedEnv = { vault: process.env.SWARM_VAULT_DIR, off: process.env.SWARM_DISABLE_MEMORY }
beforeAll(() => {
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "p4d-")))
  vault = path.join(parent, "vault")
  fs.mkdirSync(vault)
  fs.mkdirSync(path.join(parent, "home"))
  homeSpy = spyOn(os, "homedir").mockReturnValue(path.join(parent, "home"))
  process.env.SWARM_VAULT_DIR = vault
  delete process.env.SWARM_DISABLE_MEMORY
})
afterAll(() => {
  homeSpy?.mockRestore()
  if (savedEnv.vault === undefined) delete process.env.SWARM_VAULT_DIR
  else process.env.SWARM_VAULT_DIR = savedEnv.vault
  if (savedEnv.off !== undefined) process.env.SWARM_DISABLE_MEMORY = savedEnv.off
  fs.rmSync(parent, { recursive: true, force: true })
})

let project = ""
let folderPath = ""
let projectCount = 0
beforeEach(() => {
  project = path.join(parent, `project-${++projectCount}`)
  fs.mkdirSync(path.join(project, path.dirname(REPORT)), { recursive: true })
  fs.writeFileSync(path.join(project, REPORT), reportBytes)
  folderPath = path.join(vault, "swarm-memory", Vault.vaultProjectFolder(project, exported.key))
})

const syncOf = (items: readonly Item[], language: VaultMirror.Language = "en") =>
  VaultMirror.sync({
    key: exported.key,
    directory: project,
    projectRoot: project,
    projectName: exported.projectName,
    language,
    items,
  })

/** Every file below the project folder: relative path -> content. */
function tree(dir: string) {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else out[path.relative(dir, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8")
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}
/** Every file below the whole vault, for word counts. */
const vaultText = () => Object.values(tree(vault)).join("\n")

// ---------------------------------------------------------------------------------------------------------------

describe("AC-P4d: an exported device-only note is copied on the next run", () => {
  test("exported notes and the exported index entry are copied; not exported device-only notes are not (red at BASE)", async () => {
    const result = await syncOf(exported.items)
    expect(result.status).toBe("ok")
    const files = tree(folderPath)
    // Exported device-only notes (p4e-001 user note, p4e-002 agent note with body and refs).
    expect(Object.keys(files)).toContain(noteFile(exported, "p4e-001"))
    expect(files[noteFile(exported, "p4e-001")]).toContain(VaultMirror.escapeText(item(exported, "p4e-001").text))
    expect(files[noteFile(exported, "p4e-002")]).toContain(VaultMirror.escapeText(item(exported, "p4e-002").body!))
    // The exported index entry: its mission note and its report copy, under the existing report rules.
    expect(Object.keys(files)).toContain(missionFile(QUANDEL))
    expect(files[reportFile(QUANDEL)]).toContain(REPORT_WORD)
    expect(files[reportFile(QUANDEL)]).not.toContain("changed since you copied it")
    // The any-model note is copied as before; device-only notes the person did not export are not.
    expect(Object.keys(files)).toContain(noteFile(exported, "p4e-006"))
    expect(Object.keys(files)).not.toContain(noteFile(exported, "p4e-005"))
    expect(Object.keys(files)).not.toContain(missionFile(VESTREL))
    expect(Object.keys(files)).not.toContain(reportFile(VESTREL))
    expect(result.notCopied).toBe(2)
    // A second run on the same store writes nothing.
    const again = await syncOf(exported.items)
    expect(again.written).toEqual([])
    expect(again.deleted).toEqual([])
  })

  test("mirrorExclusion: classified, then secret (both also when exported), then device-only not exported", () => {
    const base = { source: "user", time: 1763400000000 } as const
    const clean = { ...base, id: "p4x-001", text: "Plimbo list stays sorted.", deviceOnly: true } as Item
    const allowed = { ...clean, vaultAllowed: true } as Item
    const classifiedSecret = { ...allowed, text: "Vestrel note RESTRICTED, password: plimbo-0000" } as Item
    expect(VaultMirror.mirrorExclusion(clean)).toBe("device")
    expect(VaultMirror.mirrorExclusion(allowed)).toBeUndefined()
    expect(VaultMirror.mirrorExclusion({ ...clean, deviceOnly: false })).toBeUndefined()
    expect(VaultMirror.mirrorExclusion({ ...allowed, body: "Marked RESTRICTED." } as Item)).toBe("classified")
    expect(VaultMirror.mirrorExclusion(item(fixture("secret-looking.json"), "p4s-001"))).toBe("secret")
    expect(VaultMirror.mirrorExclusion({ ...item(fixture("secret-looking.json"), "p4s-001"), vaultAllowed: true } as Item)).toBe(
      "secret",
    )
    expect(VaultMirror.mirrorExclusion(classifiedSecret)).toBe("classified")
    expect(VaultMirror.mirrorExclusion(item(fixture("classified.json"), "p4c-001"))).toBe("classified")
    expect(
      VaultMirror.mirrorExclusion({
        ...allowed,
        refs: [{ path: "docs/RESTRICTED/nimbard.md" }],
      } as Item),
    ).toBe("classified")
  })
})

describe("AC-P4d S10-01: the report is copied only while it is the one the person confirmed", () => {
  test("a rewritten report becomes a link-only note; its new word never reaches the vault; other files unchanged", async () => {
    expect((await syncOf(exported.items)).status).toBe("ok")
    const before = tree(folderPath)
    expect(before[reportFile(QUANDEL)]).toContain(REPORT_WORD)
    // The report is rewritten after the export with a synthetic word.
    fs.writeFileSync(path.join(project, REPORT), Buffer.concat([reportBytes, Buffer.from("\nGlorvantic addendum.\n")]))
    const result = await syncOf(exported.items)
    expect(result.status).toBe("ok")
    expect(result.written).toEqual([reportFile(QUANDEL)])
    const after = tree(folderPath)
    expect(after[reportFile(QUANDEL)]).toContain(`(changed since you copied it)`)
    expect(after[reportFile(QUANDEL)]).toContain(VaultMirror.escapeText(REPORT))
    expect(after[reportFile(QUANDEL)]).not.toContain(REPORT_WORD)
    expect(vaultText().split("Glorvantic").length - 1).toBe(0)
    for (const [rel, content] of Object.entries(before)) {
      if (rel === reportFile(QUANDEL)) continue
      expect(sha256(after[rel]!)).toBe(sha256(content))
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    // The confirmed bytes back: the copy returns as it was.
    fs.writeFileSync(path.join(project, REPORT), reportBytes)
    await syncOf(exported.items)
    expect(tree(folderPath)[reportFile(QUANDEL)]).toBe(before[reportFile(QUANDEL)]!)
  })

  test("without a stored report hash the report is link-only; the Indonesian label is N10-075", async () => {
    const items = exported.items.map((entry) => {
      if (entry.id !== "p4e-003") return entry
      const { vaultReportSha256: _sha, ...rest } = entry as Item & { vaultReportSha256?: string }
      return rest as Item
    })
    await syncOf(items, "id")
    const report = tree(folderPath)[reportFile(QUANDEL)]!
    expect(report).toContain("(berubah sejak Anda menyalinnya)")
    expect(report).not.toContain(REPORT_WORD)
  })

  test("an any-model index entry keeps the 1.2.9 report rule (copied without any hash)", async () => {
    const items = exported.items.map((entry) => {
      if (entry.id !== "p4e-003") return entry
      const { vaultAllowed: _a, vaultReportSha256: _s, ...rest } = entry as Item & {
        vaultAllowed?: boolean
        vaultReportSha256?: string
      }
      return { ...rest, deviceOnly: false } as Item
    })
    fs.writeFileSync(path.join(project, REPORT), Buffer.concat([reportBytes, Buffer.from("\nPlimbo addendum.\n")]))
    await syncOf(items)
    const report = tree(folderPath)[reportFile(QUANDEL)]!
    expect(report).toContain(REPORT_WORD)
    expect(report).toContain("Plimbo addendum.")
  })
})

describe("AC-P4d S10-08: an exported roll-up copies its note and one mission note per member line, no report", () => {
  test("roll-up export: roll-up note, the member's mission note, nothing under reports/", async () => {
    const rollup = fixture("mixed-rollup.json")
    const items = rollup.items.filter((entry) => entry.id === "p4r-r01" || entry.id === "p4r-m01")
    const result = await syncOf(items)
    expect(result.status).toBe("ok")
    const files = tree(folderPath)
    expect(Object.keys(files)).toContain(noteFile(rollup, "p4r-r01"))
    expect(Object.keys(files)).toContain(missionFile("2026-07-03_vestrel-pass"))
    expect(Object.keys(files).filter((rel) => rel.startsWith("reports/"))).toEqual([])
    expect(files[missionFile("2026-07-03_vestrel-pass")]).not.toContain("**Report**")
    expect(files["index.md"]).not.toContain("## Reports")
    expect(result.notCopied).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The exported note is still never given to an off-device model (Q4-4): prompt and recall read deviceOnly alone.

const providerLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({
    getProvider: (id: string) =>
      Effect.succeed({ options: id === "ollama" ? { baseURL: "http://127.0.0.1:11434/v1" } : {} }),
  } as unknown as Provider.Interface),
)
const cloud = { providerID: "anthropic", api: { url: "https://api.anthropic.com/v1" } } as unknown as Provider.Model
const local = { providerID: "ollama", api: { url: "" } } as unknown as Provider.Model

/** Replaces the current instance's store with these items (found by a marker note only it holds). */
const seed = (items: readonly Item[], marker: string) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    yield* memory.add({ text: marker, source: "user" })
    const dir = path.join(Global.Path.data, "memory")
    const target = yield* Effect.promise(async () => {
      for (const name of await fsp.readdir(dir)) {
        const file = path.join(dir, name)
        if (name.endsWith(".json") && (await fsp.readFile(file, "utf8")).includes(marker)) return file
      }
      throw new Error("store not found")
    })
    yield* Effect.promise(() =>
      fsp.writeFile(target, JSON.stringify({ version: 2, enabled: true, items }, null, 2) + "\n", { mode: 0o600 }),
    )
    return target
  })

const routing = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Memory.node, CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]),
    [
      [Provider.node, providerLayer],
      [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    ],
  ),
)

describe("AC-P4d: off-device prompt and recall still exclude the exported note", () => {
  routing.live("absent from an off-device model's prompt and recall, present for an on-device model", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const memory = yield* Memory.Service
        yield* seed(exported.items, "anchor-p4d-routing")
        const text = item(exported, "p4e-001").text
        expect(yield* memory.prompt(cloud)).not.toContain(text)
        expect(yield* memory.prompt(local)).toContain(text)
        expect((yield* memory.recall({ query: "p4e-001", model: cloud })) ?? "").not.toContain(text)
        expect(yield* memory.recall({ query: "p4e-001", model: local })).toContain(text)
        expect((yield* memory.recall({ query: "plimbo zorvex", model: cloud })) ?? "").not.toContain(text)
        // The any-model note of the same store still reaches the off-device model.
        expect(yield* memory.prompt(cloud)).toContain(item(exported, "p4e-006").text)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------------------------------------------
// C18 D-9 (N10-070): the close nudge links only an index entry the mirror copies. Harness as rel128-obs-c (AC-OBSd).

const SET_STATUS = "datum-studio_studio_mission_set_status"
const INBOX = "swarm-web_vault_inbox"
const NO_LINKS = "next: write the vault note for this mission (skill obsidian-memory)."

type Params = { name: string; arguments?: Record<string, unknown> }
const client = {
  callTool: async (_params: Params) => ({ content: [{ type: "text", text: "ok" }] }),
} as unknown as MCP.McpTool["client"]
const mcpTool = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } })
const studioSource: MCP.Source = { server: DatumStudioMcp.DATUM_STUDIO_MCP, transport: "remote", origin: "global" }
const webSource: MCP.Source = { server: "swarm-web", transport: "local", origin: "global" }

const nudgeLayer = Layer.mergeAll(
  AppNodeBuilder.build(
    LayerNode.group([Memory.node, CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]),
    [
      [Provider.node, providerLayer],
      [InstanceBootstrap.node, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
    ],
  ),
  Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    } satisfies Plugin.Interface),
  ),
  Layer.succeed(
    Permission.Service,
    Permission.Service.of({
      ask: () => Effect.void,
      reply: () => Effect.succeed(undefined),
      grant: () => Effect.void,
      list: () => Effect.succeed([]),
    } satisfies Permission.Interface),
  ),
  Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      tools: () =>
        Effect.succeed({
          [SET_STATUS]: { def: mcpTool("studio_mission_set_status"), client, source: studioSource },
          [INBOX]: { def: mcpTool("vault_inbox"), client, source: webSource },
        }),
      clients: () => Effect.succeed({}),
    } as Partial<MCP.Interface> as MCP.Interface),
  ),
  Layer.succeed(
    Truncate.Service,
    Truncate.Service.of({
      cleanup: () => Effect.void,
      write: () => Effect.succeed("output.txt"),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
    } satisfies Truncate.Interface),
  ),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed([]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () => Effect.succeed([]),
    }),
  ),
)
const nudge = testEffect(nudgeLayer)

const SESSION = SessionID.make("ses_p4dnudge")
const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}
const toolModel = {
  providerID: ProviderV2.ID.make("test"),
  id: "test-model",
  api: { id: "test-model", url: "https://model.invalid/v1" },
} as unknown as Provider.Model

const resolveTools = Effect.gen(function* () {
  const processor = {
    message: {
      id: MessageID.ascending(),
      sessionID: SESSION,
      role: "assistant",
      parentID: MessageID.ascending(),
      agent: "build",
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: 1 },
    },
    updateToolCall: () => Effect.succeed(undefined),
    completeToolCall: () => Effect.void,
  } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  return yield* SessionTools.resolve({
    agent,
    model: toolModel,
    session: { id: SESSION, directory: "/tmp/p4d", permission: [] } as unknown as Session.Info,
    processor,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as never,
  })
})

type Tools = Record<string, { execute?: (...a: any[]) => any }>
const close = (missionId: string) =>
  Effect.gen(function* () {
    const tools = (yield* resolveTools) as Tools
    return yield* Effect.promise(async () => {
      const out = await tools[SET_STATUS]!.execute!(
        { mission: missionId, to: "done" },
        { toolCallId: "c-p4d", abortSignal: new AbortController().signal, messages: [] },
      )
      return String(out.output)
    })
  })

const PLIMBO = "2026-11-01_plimbo-close"
const plimboEntry = (over: Partial<Item>): Item =>
  ({
    id: "p4n-001",
    kind: "index",
    missionId: PLIMBO,
    text: `2026-11-01 ${PLIMBO} | plimbo close done | triggers: plimbo, zorvex | docs/${PLIMBO}/report/report.md`,
    source: "agent",
    deviceOnly: false,
    time: 1763500000000,
    ...over,
  }) as Item
const linked = (missionId: string) => `ok\n\n${VaultMirror.closeNudge(missionId, true)}`

describe("AC-P4d C18 D-9: missionIndexed counts only an index entry the mirror copies", () => {
  nudge.live(
    "device-only, not exported -> the nudge without links (red at BASE)",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          yield* seed(exported.items, "anchor-p4d-nudge-device")
          expect(yield* close(VESTREL)).toBe(`ok\n\n${NO_LINKS}`)
        }),
      ),
    15000,
  )

  nudge.live(
    "exported device-only entry -> links; any-model entry -> links",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          yield* seed([...exported.items, plimboEntry({})], "anchor-p4d-nudge-links")
          expect(yield* close(QUANDEL)).toBe(linked(QUANDEL))
          expect(linked(QUANDEL)).toContain("; link [[")
          expect(yield* close(PLIMBO)).toBe(linked(PLIMBO))
        }),
      ),
    15000,
  )

  nudge.live(
    "classified entry (any-model, or device-only and exported) -> no links",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          yield* seed([plimboEntry({ body: "Plimbo close, marked RESTRICTED." })], "anchor-p4d-nudge-classified")
          expect(yield* close(PLIMBO)).toBe(`ok\n\n${NO_LINKS}`)
          yield* seed(
            [plimboEntry({ deviceOnly: true, vaultAllowed: true, body: "Plimbo close, marked RESTRICTED." } as Partial<Item>)],
            "anchor-p4d-nudge-classified-exported",
          )
          expect(yield* close(PLIMBO)).toBe(`ok\n\n${NO_LINKS}`)
        }),
      ),
    15000,
  )

  test("nudge strings are byte-identical to 1.2.9", () => {
    expect(VaultMirror.closeNudge(PLIMBO, false)).toBe(NO_LINKS)
    expect(VaultMirror.closeNudge(PLIMBO, true)).toBe(
      `next: write the vault note for this mission (skill obsidian-memory); link [[${VaultMirror.noteName("mission", PLIMBO)!.slice(0, -3)}]] and [[${VaultMirror.noteName("report", PLIMBO)!.slice(0, -3)}]].`,
    )
  })
})
