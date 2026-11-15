// 1.2.10 row 54, AC-P4f (N10-175; 01d §3.3, §3.10, §4; C10, C18, C31): where a note may go is the person's call.
// `POST /memory/:id/vault` (N10-067) and a `PATCH /memory/:id` that carries `deviceOnly` (N10-068) are taken only with
// the per-launch desktop nonce, strict: a server holding no nonce refuses everyone. "Agent shell" below = a client that
// holds the server password and no nonce, which is exactly what an agent's shell, an MCP server process and any local
// program that reads the password can build. "Nothing changed" = the store file sha256 is equal before and after and no
// `memory.updated` event was published (the mirror runs only after that event).
// Cases T-1..T-14 of 01d §3.3 plus T-10b (S10-06), the refusal order (S10-09: archived, classified, secret, not device
// only), the field-by-field store call (S10-05), the audit lines (S10-11) and the `kept` list (N10-066).
// Red at BASE a3e3c4c93a: the vault route does not exist (404) and `PATCH {deviceOnly:false}` without the nonce is 200.
//
// Fixtures: row 40's synthetic stores (test/memory/fixtures/rel1210-p4, N10-227..N10-233). SWARM_VAULT_DIR is a
// mkdtemp vault and os.homedir is stubbed to a mkdtemp home, so nothing here can reach a real store or vault.
//
// Run targeted: cd packages/opencode && bun test test/server/rel1210-p4f-person-only-route.test.ts

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { Parameters as RememberParameters } from "../../src/tool/remember"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const FIXTURES = path.join(import.meta.dir, "..", "memory", "fixtures", "rel1210-p4")
const SRC = path.join(import.meta.dir, "..", "..", "src")

// Synthetic values only. NONCE has the desktop's form (base64url, 32..128 characters).
const PASSWORD = "p4f-synthetic-password"
const NONCE = "p4f-nonce-0123456789abcdefghijklmnopqrs"
const OTHER = "p4f-other-0123456789abcdefghijklmnopqrs"
const HEADER = DesktopNonce.HEADER
const SECRET_TEXT = "Zorvex staging login note, password: plimbo-0000"

type Item = {
  id: string
  text: string
  deviceOnly: boolean
  vaultAllowed?: boolean
  vaultReportSha256?: string
  rolledInto?: string
  kind?: string
  [key: string]: unknown
}
type Store = { version?: number; enabled?: boolean; items: Item[]; consolidated?: unknown }
type Body = {
  name?: string
  data?: { code?: string; message?: string }
  item?: Item
  refused?: string
  kept?: { id: string; reason: string }[]
}

const fixture = (name: string): Store => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"))
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

// The server the desktop app starts: password set (Authorization middleware), nonce held per test.
const handler = HttpRouter.toWebHandler(
  HttpApiApp.routes.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: PASSWORD }))),
  ),
  { disableLogger: true },
).handler
const authorization = ServerAuth.header({ username: "opencode", password: PASSWORD }) ?? ""

async function call(
  dir: string,
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { authorization, "x-opencode-directory": dir, ...extra }
  if (body !== undefined) headers["content-type"] = "application/json"
  const response = await handler(
    new Request(new URL(url, "http://localhost"), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    HttpApiApp.context,
  )
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) as Body }
}

/** An agent's shell: the password, no nonce (or the value `nonce` when given, e.g. a wrong one). */
const exportCall = (dir: string, id: string, allowed: boolean, nonce?: string) =>
  call(dir, "POST", `/memory/${id}/vault`, { allowed }, nonce === undefined ? {} : { [HEADER]: nonce })
const patchCall = (dir: string, id: string, body: Record<string, unknown>, nonce?: string) =>
  call(dir, "PATCH", `/memory/${id}`, body, nonce === undefined ? {} : { [HEADER]: nonce })

// memory.updated events, counted per test (the mirror is scheduled only after one).
let updates = 0
const onEvent = (event: GlobalEvent) => {
  if (event.payload?.type === "memory.updated") updates++
}

const parents: string[] = []
let homeSpy: ReturnType<typeof spyOn> | undefined
const savedEnv = { vault: process.env.SWARM_VAULT_DIR, disable: process.env.SWARM_DISABLE_MEMORY }

beforeEach(() => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "o54-")))
  parents.push(parent)
  fs.mkdirSync(path.join(parent, "vault"))
  fs.mkdirSync(path.join(parent, "home"))
  process.env.SWARM_VAULT_DIR = path.join(parent, "vault")
  delete process.env.SWARM_DISABLE_MEMORY
  homeSpy = spyOn(os, "homedir").mockReturnValue(path.join(parent, "home"))
  DesktopNonce.set(NONCE)
  updates = 0
  GlobalBus.on("event", onEvent)
})

afterEach(async () => {
  GlobalBus.off("event", onEvent)
  DesktopNonce.set(undefined)
  homeSpy?.mockRestore()
  if (savedEnv.vault === undefined) delete process.env.SWARM_VAULT_DIR
  else process.env.SWARM_VAULT_DIR = savedEnv.vault
  if (savedEnv.disable === undefined) delete process.env.SWARM_DISABLE_MEMORY
  else process.env.SWARM_DISABLE_MEMORY = savedEnv.disable
  await disposeAllInstances()
  await resetDatabase()
})

afterAll(() => {
  for (const dir of parents) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * Replaces the project's store with a fixture store (its store keys only), changed by `edit` when given. The store file
 * is created through the password-only `POST /memory` with a marker note and then found by that marker.
 */
async function seed(dir: string, items: Item[], marker: string) {
  const added = await call(dir, "POST", "/memory", { text: marker })
  expect(added.status).toBe(200)
  const folder = path.join(Global.Path.data, "memory")
  const target = fs
    .readdirSync(folder)
    .map((name) => path.join(folder, name))
    .find((file) => file.endsWith(".json") && fs.readFileSync(file, "utf8").includes(marker))
  if (!target) throw new Error("store not found")
  fs.writeFileSync(target, JSON.stringify({ version: 2, enabled: true, items }, null, 2) + "\n", { mode: 0o600 })
  updates = 0
  return target
}
const items = (...names: string[]) => names.flatMap((name) => fixture(name).items)
const stored = (target: string): Store => JSON.parse(fs.readFileSync(target, "utf8"))
const byId = (target: string, id: string) => stored(target).items.find((item) => item.id === id)!
const fileSha = (target: string) => sha256(fs.readFileSync(target))

/** Runs `act`, then checks nothing changed: store sha256 equal and no memory.updated event. */
async function unchanged<T>(target: string, act: () => Promise<T>) {
  const before = fileSha(target)
  const count = updates
  const result = await act()
  expect(fileSha(target)).toBe(before)
  expect(updates).toBe(count)
  return result
}

function refusedPersonOnly(res: { status: number; json: () => Body }) {
  expect(res.status).toBe(403)
  const body = res.json()
  expect(body.name).toBe("MemoryPersonOnlyError")
  expect(body.data?.code).toBe("MEMORY_PERSON_ONLY")
}

// Audit lines (S10-11): the server's own log file. The file logger writes in batches (1 s window), so a call's lines are
// the audit lines stamped at or after the call started, read once the batch has surely been written.
const LOG = () => path.join(Global.Path.log, "opencode.log")
const now = () => new Date().toISOString()
async function auditLines(since: string, count: number) {
  const read = () =>
    (fs.existsSync(LOG()) ? fs.readFileSync(LOG(), "utf8") : "")
      .split("\n")
      .filter((line) => line.includes('message="memory person-only"'))
      .filter((line) => (/^timestamp=(\S+)/.exec(line)?.[1] ?? "") >= since)
  const deadline = Date.now() + 10_000
  while (read().length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  // One more batch window, so a second line for the same call would be seen too.
  await new Promise((resolve) => setTimeout(resolve, 1_300))
  return read()
}

describe("AC-P4f person-only: an agent's shell cannot export, undo or change scope (T-1..T-5)", () => {
  test("T-1 agent shell: POST /memory/:id/vault {allowed:true} on a clean device-only note is 403, nothing changed", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json"), "anchor-p4f-t1")
    refusedPersonOnly(await unchanged(target, () => exportCall(tmp.path, "p4d-001", true)))
    expect("vaultAllowed" in byId(target, "p4d-001")).toBe(false)
  })

  test("T-2 agent shell: undo {allowed:false} on an exported note is 403 too, nothing changed", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("exported.json"), "anchor-p4f-t2")
    refusedPersonOnly(await unchanged(target, () => exportCall(tmp.path, "p4e-001", false)))
    expect(byId(target, "p4e-001").vaultAllowed).toBe(true)
  })

  test("T-3 a wrong nonce, a short nonce and one with bad characters are 403, nothing changed", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json"), "anchor-p4f-t3")
    for (const nonce of [OTHER, NONCE.slice(0, 20), NONCE.slice(0, -2) + "!?", ""]) {
      refusedPersonOnly(await unchanged(target, () => exportCall(tmp.path, "p4d-001", true, nonce)))
      refusedPersonOnly(await unchanged(target, () => patchCall(tmp.path, "p4d-001", { deviceOnly: false }, nonce)))
    }
  })

  test("T-4 a server holding no nonce (as `swarm serve`) refuses every header value, nothing changed", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json", "exported.json"), "anchor-p4f-t4")
    DesktopNonce.set(undefined)
    for (const nonce of [undefined, NONCE, OTHER, ""]) {
      refusedPersonOnly(await unchanged(target, () => exportCall(tmp.path, "p4d-001", true, nonce)))
      refusedPersonOnly(await unchanged(target, () => exportCall(tmp.path, "p4e-001", false, nonce)))
      refusedPersonOnly(await unchanged(target, () => patchCall(tmp.path, "p4d-001", { deviceOnly: false }, nonce)))
    }
  })

  test("T-5 MCP case: the request an MCP server process makes (password from the env file, no nonce header) is 403", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json", "exported.json"), "anchor-p4f-t5")
    refusedPersonOnly(await unchanged(target, () => exportCall(tmp.path, "p4d-002", true)))
    refusedPersonOnly(await unchanged(target, () => exportCall(tmp.path, "p4e-002", false)))
    refusedPersonOnly(await unchanged(target, () => patchCall(tmp.path, "p4d-002", { deviceOnly: false })))
  })
})

describe("AC-P4f the person at the app (correct nonce): export, refusals, undo (T-6..T-9)", () => {
  test("T-6 correct nonce, clean device-only note, allowed:true: 200, vaultAllowed true in the answer and the store", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json"), "anchor-p4f-t6")
    const before = stored(target)
    const res = await exportCall(tmp.path, "p4d-001", true, NONCE)
    expect(res.status).toBe(200)
    expect(res.json().item).toMatchObject({ id: "p4d-001", deviceOnly: true, vaultAllowed: true })
    expect(byId(target, "p4d-001")).toMatchObject({ deviceOnly: true, vaultAllowed: true })
    expect(updates).toBe(1)
    for (const item of before.items.filter((item) => item.id !== "p4d-001"))
      expect(byId(target, item.id)).toEqual(item)
  })

  test("T-7 correct nonce, allowed:true on a classified, a secret-looking, an any-model and an archived note: refused, nothing changed", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(
      tmp.path,
      items("classified.json", "secret-looking.json", "device-only.json"),
      "anchor-p4f-t7",
    )
    const cases: [string, string][] = [
      ["p4c-001", "classified"],
      ["p4s-001", "secret"],
      ["p4d-003", "not_device_only"],
      ["p4d-m01", "archived"],
    ]
    for (const [id, refused] of cases) {
      const res = await unchanged(target, () => exportCall(tmp.path, id, true, NONCE))
      expect([id, res.status, res.json()]).toEqual([id, 200, { refused }])
    }
  })

  test("T-7 order (S10-09): archived, then classified, then secret, then not device-only", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const [classifiedNote] = fixture("classified.json").items
    const [secretNote] = fixture("secret-looking.json").items
    const member = fixture("device-only.json").items.find((item) => item.id === "p4d-m01")!
    const store: Item[] = [
      // any-model + classified -> classified; any-model + secret -> secret
      { ...classifiedNote!, id: "p4o-001", deviceOnly: false },
      { ...secretNote!, id: "p4o-002", deviceOnly: false },
      // classified + secret -> classified
      { ...classifiedNote!, id: "p4o-003", text: `${classifiedNote!.text} ${SECRET_TEXT}` },
      // archived + classified + any-model -> archived
      { ...member, id: "p4o-004", text: `${member.text} RESTRICTED`, deviceOnly: false },
    ]
    const target = await seed(tmp.path, store, "anchor-p4f-order")
    const cases: [string, string][] = [
      ["p4o-001", "classified"],
      ["p4o-002", "secret"],
      ["p4o-003", "classified"],
      ["p4o-004", "archived"],
    ]
    for (const [id, refused] of cases) {
      const res = await unchanged(target, () => exportCall(tmp.path, id, true, NONCE))
      expect([id, res.status, res.json()]).toEqual([id, 200, { refused }])
    }
  })

  test("T-8 correct nonce, allowed:false on an exported note and on one rewritten secret on disk: 200, key gone, still device-only", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const store = items("exported.json").map((item) => (item.id === "p4e-002" ? { ...item, text: SECRET_TEXT } : item))
    const target = await seed(tmp.path, store, "anchor-p4f-t8")
    for (const id of ["p4e-001", "p4e-002"]) {
      const res = await exportCall(tmp.path, id, false, NONCE)
      expect(res.status).toBe(200)
      expect("vaultAllowed" in res.json().item!).toBe(false)
      const after = byId(target, id)
      expect("vaultAllowed" in after).toBe(false)
      expect(after.deviceOnly).toBe(true)
    }
    expect(updates).toBe(2)
  })

  test("T-9 correct nonce, allowed:true twice: the second call is 200 and writes nothing", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json"), "anchor-p4f-t9")
    expect((await exportCall(tmp.path, "p4d-002", true, NONCE)).status).toBe(200)
    const second = await unchanged(target, () => exportCall(tmp.path, "p4d-002", true, NONCE))
    expect(second.status).toBe(200)
    expect(second.json().item).toMatchObject({ id: "p4d-002", vaultAllowed: true })
  })
})

describe("AC-P4f PATCH narrowing (C10, N10-068): T-10..T-14", () => {
  test("T-10 agent shell: PATCH {deviceOnly:false} and {deviceOnly:true} are 403 each, nothing changed", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json"), "anchor-p4f-t10")
    refusedPersonOnly(await unchanged(target, () => patchCall(tmp.path, "p4d-001", { deviceOnly: false })))
    refusedPersonOnly(await unchanged(target, () => patchCall(tmp.path, "p4d-003", { deviceOnly: true })))
    expect(byId(target, "p4d-001").deviceOnly).toBe(true)
    expect(byId(target, "p4d-003").deviceOnly).toBe(false)
  })

  test("T-10b agent shell: PATCH {text, deviceOnly} (any value) and {deviceOnly: <current value>} are 403, text unchanged", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json"), "anchor-p4f-t10b")
    const text = byId(target, "p4d-001").text
    for (const deviceOnly of [true, false])
      refusedPersonOnly(
        await unchanged(target, () => patchCall(tmp.path, "p4d-001", { text: "Plimbo grids changed.", deviceOnly })),
      )
    refusedPersonOnly(await unchanged(target, () => patchCall(tmp.path, "p4d-001", { deviceOnly: true })))
    refusedPersonOnly(await unchanged(target, () => patchCall(tmp.path, "p4d-003", { deviceOnly: false })))
    expect(byId(target, "p4d-001").text).toBe(text)
  })

  test("T-11 correct nonce: PATCH {deviceOnly:false} on an exported note is 200, deviceOnly false and the vaultAllowed key gone", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("exported.json"), "anchor-p4f-t11")
    const res = await patchCall(tmp.path, "p4e-001", { deviceOnly: false }, NONCE)
    expect(res.status).toBe(200)
    const after = byId(target, "p4e-001")
    expect(after.deviceOnly).toBe(false)
    expect("vaultAllowed" in after).toBe(false)
    expect(updates).toBe(1)
  })

  test("T-12 agent shell: PATCH {text} on a note that is not exported is 200, as in 1.2.9", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json"), "anchor-p4f-t12")
    const res = await patchCall(tmp.path, "p4d-002", { text: "Vestrel tables use the plimbo column order." })
    expect(res.status).toBe(200)
    expect(byId(target, "p4d-002")).toMatchObject({ text: "Vestrel tables use the plimbo column order.", deviceOnly: true })
  })

  test("T-13 agent shell: PATCH {text} on an exported note is 200, the text changes and the vaultAllowed key is gone", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("exported.json"), "anchor-p4f-t13")
    const res = await patchCall(tmp.path, "p4e-001", { text: "Plimbo reviews start from the vestrel list." })
    expect(res.status).toBe(200)
    const after = byId(target, "p4e-001")
    expect(after.text).toBe("Plimbo reviews start from the vestrel list.")
    expect(after.deviceOnly).toBe(true)
    expect("vaultAllowed" in after).toBe(false)
  })

  test("T-14 an extra vaultAllowed key in a PATCH has no effect, with or without the nonce; the call is built field by field", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const target = await seed(tmp.path, items("device-only.json"), "anchor-p4f-t14")
    const shell = await patchCall(tmp.path, "p4d-001", { text: "Zorvex sheets come from annex plimbo.", vaultAllowed: true })
    expect(shell.status).toBe(200)
    expect("vaultAllowed" in byId(target, "p4d-001")).toBe(false)
    const person = await patchCall(
      tmp.path,
      "p4d-002",
      { text: "Vestrel tables use the zorvex column order.", vaultAllowed: true, personAttested: true },
      NONCE,
    )
    expect(person.status).toBe(200)
    expect("vaultAllowed" in byId(target, "p4d-002")).toBe(false)
    expect("vaultAllowed" in person.json().item!).toBe(false)
    // S10-05 (RN-11): the handler never hands the payload object on to the store.
    const handlers = fs.readFileSync(path.join(SRC, "server/routes/instance/httpapi/handlers/memory.ts"), "utf8")
    expect(handlers).not.toMatch(/\.\.\.ctx\.payload/)
    expect(handlers).not.toMatch(/memory\.update\([^)]*ctx\.payload\s*\)/)
  })

  test("T-14 no agent tool can reach the export: the remember tool and every source outside the memory store, mirror and memory routes name no export field", () => {
    const keys = Object.keys(RememberParameters.fields)
    for (const name of ["vaultAllowed", "personAttested", "allowed", "vault", "export"]) expect(keys).not.toContain(name)
    const allowed = new Set(
      [
        "memory/memory.ts",
        "memory/vault-mirror.ts",
        "server/routes/instance/httpapi/groups/memory.ts",
        "server/routes/instance/httpapi/handlers/memory.ts",
      ].map((file) => path.join(SRC, file)),
    )
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx|txt|md)$/.test(entry.name) && !allowed.has(full)) {
          if (/vaultAllowed|personAttested|allowVault/.test(fs.readFileSync(full, "utf8"))) hits.push(full)
        }
      }
    }
    walk(SRC)
    expect(hits).toEqual([])
  })
})

describe("AC-P4f kept list (N10-066) on GET /memory/vault", () => {
  test("kept lists the expected ids and reasons, archived members left out, and contains no note word", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const store = [
      ...items("device-only.json", "classified.json", "secret-looking.json", "exported.json"),
      { id: "p4u 001!", text: "Quandel sheets are sorted by plimbo.", deviceOnly: false, source: "user", time: 1 } as Item,
    ]
    await seed(tmp.path, store, "anchor-p4f-kept")
    const res = await call(tmp.path, "GET", "/memory/vault")
    expect(res.status).toBe(200)
    const kept = res.json().kept ?? []
    const reasons = Object.fromEntries(kept.map((entry) => [entry.id, entry.reason]))
    expect(reasons).toEqual({
      "p4d-001": "device",
      "p4d-002": "device",
      "p4d-r01": "device",
      "p4c-001": "classified",
      "p4c-002": "device",
      "p4s-001": "secret",
      "p4s-002": "device",
      "p4e-004": "device",
      "p4e-005": "device",
      "p4u 001!": "unsafe",
    })
    const words = new Set(
      store.flatMap((item) => item.text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => word !== "kept"),
    )
    const json = JSON.stringify(kept).toLowerCase()
    expect([...words].filter((word) => json.includes(word))).toEqual([])
  })
})

describe("AC-P4f audit lines (S10-11): no note text, no path, no header value", () => {
  test("T-1, T-6, T-8 and T-11 each log one line of the fixed shape; the nonce never appears", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    await seed(tmp.path, items("exported.json"), "anchor-p4f-audit")
    const texts = items("exported.json").map((item) => item.text)
    const shape =
      /^timestamp=\S+ level=(INFO|WARN) run=\S+ message="memory person-only" source=ProjectMemory\.(allowVault|update) id=[0-9A-Za-z_-]+ action=(export|undo|scope|text|scope_text) attested=(true|false)$/
    const cases: [string, () => Promise<unknown>, string][] = [
      // T-1: refused, with a wrong value in the header that must not be logged
      ["T-1", () => exportCall(tmp.path, "p4e-005", true, OTHER), "source=ProjectMemory.allowVault id=p4e-005 action=export attested=false"],
      ["T-6", () => exportCall(tmp.path, "p4e-005", true, NONCE), "source=ProjectMemory.allowVault id=p4e-005 action=export attested=true"],
      ["T-8", () => exportCall(tmp.path, "p4e-001", false, NONCE), "source=ProjectMemory.allowVault id=p4e-001 action=undo attested=true"],
      ["T-11", () => patchCall(tmp.path, "p4e-002", { deviceOnly: false }, NONCE), "source=ProjectMemory.update id=p4e-002 action=scope attested=true"],
    ]
    for (const [name, act, expected] of cases) {
      const since = now()
      await act()
      const lines = await auditLines(since, 1)
      expect([name, lines.length]).toEqual([name, 1])
      const line = lines[0]!
      expect([name, line]).toEqual([name, expect.stringMatching(shape)])
      expect([name, line.includes(expected)]).toEqual([name, true])
      expect(line).not.toContain("/")
      expect(line).not.toContain(NONCE)
      expect(line).not.toContain(OTHER)
      for (const text of texts) expect(line).not.toContain(text)
    }
    // A caller-chosen id that is not a store id is logged as "invalid", so it cannot carry a path into the log.
    const since = now()
    await call(tmp.path, "POST", `/memory/${encodeURIComponent("..%2Fetc")}/vault`, { allowed: true })
    const invalid = await auditLines(since, 1)
    expect(invalid.length).toBe(1)
    expect(invalid[0]).toContain("id=invalid")
    expect(invalid[0]).not.toContain("/")
  }, 60_000)
})
