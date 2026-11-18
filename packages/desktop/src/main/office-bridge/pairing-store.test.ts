import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPairingStore, hashToken, PAIRING_IDLE_MS, PairingStoreDirUnsafeError, pairingsPath } from "./pairing-store"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const setup = (start = Date.parse("2026-11-16T10:00:00.000Z")) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pairing-store-"))
  roots.push(root)
  const dir = join(root, "office-addin")
  const clock = { at: start }
  const logs: { event: string; fields: Record<string, string | number> }[] = []
  const store = createPairingStore({ dir, now: () => new Date(clock.at), log: (event, fields) => logs.push({ event, fields }) })
  return { root, dir, clock, logs, store }
}

const TOKEN_A = "swo1_" + "A".repeat(43)
const TOKEN_B = "swo1_" + "B".repeat(43)
const TOKEN_C = "swo1_" + "C".repeat(43)

const readStore = (dir: string) => JSON.parse(readFileSync(pairingsPath(dir), "utf8"))

test("U-PS-01: stores sha256 lowercase hex of the full token, never the plaintext", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  const text = readFileSync(pairingsPath(ctx.dir), "utf8")
  const expected = "sha256:" + createHash("sha256").update(TOKEN_A).digest("hex")
  expect(hashToken(TOKEN_A)).toBe(expected)
  expect(text).not.toContain(TOKEN_A)
  expect(text).not.toContain("A".repeat(43))
  expect(readStore(ctx.dir)).toEqual({
    version: 1,
    pairings: [{ host: "Word", hash: expected, createdAt: "2026-11-16T10:00:00.000Z", lastUsedAt: "2026-11-16T10:00:00.000Z" }],
  })
  expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/)
})

test("U-PS-02: one entry per host; re-pairing replaces; Word and Excel coexist", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  await ctx.store.put("Excel", TOKEN_B)
  await ctx.store.put("Word", TOKEN_C)
  const stored = readStore(ctx.dir).pairings
  expect(stored.map((entry: { host: string }) => entry.host).sort()).toEqual(["Excel", "Word"])
  expect(stored.find((entry: { host: string }) => entry.host === "Word").hash).toBe(hashToken(TOKEN_C))
  expect(await ctx.store.verify(TOKEN_A)).toBeUndefined()
  expect(await ctx.store.verify(TOKEN_C)).toBe("Word")
  expect(await ctx.store.verify(TOKEN_B)).toBe("Excel")
})

test("U-PS-03: file 0600, dir 0700, temp then rename, failed write keeps the old file", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  expect(statSync(ctx.dir).mode & 0o777).toBe(0o700)
  expect(statSync(pairingsPath(ctx.dir)).mode & 0o777).toBe(0o600)
  expect(readdirSync(ctx.dir)).toEqual(["pairings.json"])
  const before = readFileSync(pairingsPath(ctx.dir), "utf8")
  // A directory at the temp path makes the temp write fail, standing in for a crash before the rename.
  mkdirSync(`${pairingsPath(ctx.dir)}.${process.pid}.tmp`)
  await expect(ctx.store.put("Excel", TOKEN_B)).rejects.toThrow()
  expect(readFileSync(pairingsPath(ctx.dir), "utf8")).toBe(before)
  rmSync(`${pairingsPath(ctx.dir)}.${process.pid}.tmp`, { recursive: true })
  // The write queue survives the failure.
  await ctx.store.put("Excel", TOKEN_B)
  expect(readStore(ctx.dir).pairings).toHaveLength(2)
})

test("U-PS-03: the source writes temp then rename with mode 0600", async () => {
  const source = await Bun.file(join(import.meta.dir, "pairing-store.ts")).text()
  expect(source).toContain("writeFile(temp, body, { mode: 0o600 })")
  expect(source.indexOf("writeFile(temp")).toBeLessThan(source.indexOf("rename(temp, path)"))
})

test("U-PS-03: a pre-existing 0755 data directory refuses to load (SC-12)", async () => {
  const ctx = setup()
  mkdirSync(ctx.dir, { mode: 0o755 })
  chmodSync(ctx.dir, 0o755)
  const error = await ctx.store.load().catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(PairingStoreDirUnsafeError)
  expect((error as PairingStoreDirUnsafeError).code).toBe("DATA_DIR_UNSAFE")
})

test("U-PS-04: verify matches a known token, updates lastUsedAt, rejects unknown; uses timingSafeEqual", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  ctx.clock.at += 60_000
  expect(await ctx.store.verify(TOKEN_A)).toBe("Word")
  expect(readStore(ctx.dir).pairings[0].lastUsedAt).toBe("2026-11-16T10:01:00.000Z")
  expect(readStore(ctx.dir).pairings[0].createdAt).toBe("2026-11-16T10:00:00.000Z")
  expect(await ctx.store.verify(TOKEN_B)).toBeUndefined()
  expect(await ctx.store.verify("")).toBeUndefined()
  const source = await Bun.file(join(import.meta.dir, "pairing-store.ts")).text()
  expect(source).toContain("timingSafeEqual(stored, candidate)")
})

test("U-PS-05: clear empties the store and every earlier token fails", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  await ctx.store.put("Excel", TOKEN_B)
  await ctx.store.clear()
  expect(readStore(ctx.dir)).toEqual({ version: 1, pairings: [] })
  expect(await ctx.store.verify(TOKEN_A)).toBeUndefined()
  expect(await ctx.store.verify(TOKEN_B)).toBeUndefined()
  expect(ctx.logs.some((line) => line.event === "pairings-cleared")).toBe(true)
  const fresh = createPairingStore({ dir: ctx.dir, log: () => undefined })
  await fresh.load()
  expect(fresh.list()).toEqual([])
})

test("reload reads back stored entries", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Excel", TOKEN_B)
  const again = createPairingStore({ dir: ctx.dir, now: () => new Date(ctx.clock.at), log: () => undefined })
  await again.load()
  expect(await again.verify(TOKEN_B)).toBe("Excel")
})

test("revoke removes only the entry holding that token", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  await ctx.store.put("Excel", TOKEN_B)
  expect(await ctx.store.revoke(TOKEN_A)).toBe(true)
  expect(await ctx.store.revoke(TOKEN_C)).toBe(false)
  expect(readStore(ctx.dir).pairings.map((entry: { host: string }) => entry.host)).toEqual(["Excel"])
})

const invalidBodies = [
  ["not json", "{not json"],
  ["unknown version", JSON.stringify({ version: 2, pairings: [] })],
  ["extra top-level key", JSON.stringify({ version: 1, pairings: [], extra: 1 })],
  ["bad host", JSON.stringify({ version: 1, pairings: [{ host: "PowerPoint", hash: hashToken(TOKEN_A), createdAt: "2026-11-16T10:00:00.000Z", lastUsedAt: "2026-11-16T10:00:00.000Z" }] })],
  ["plaintext hash", JSON.stringify({ version: 1, pairings: [{ host: "Word", hash: TOKEN_A, createdAt: "2026-11-16T10:00:00.000Z", lastUsedAt: "2026-11-16T10:00:00.000Z" }] })],
  ["bad date", JSON.stringify({ version: 1, pairings: [{ host: "Word", hash: hashToken(TOKEN_A), createdAt: "yesterday", lastUsedAt: "2026-11-16T10:00:00.000Z" }] })],
  ["duplicate host", JSON.stringify({ version: 1, pairings: [
    { host: "Word", hash: hashToken(TOKEN_A), createdAt: "2026-11-16T10:00:00.000Z", lastUsedAt: "2026-11-16T10:00:00.000Z" },
    { host: "Word", hash: hashToken(TOKEN_B), createdAt: "2026-11-16T10:00:00.000Z", lastUsedAt: "2026-11-16T10:00:00.000Z" },
  ] })],
] as const

invalidBodies.forEach(([name, body]) =>
  test(`U-PS-09: ${name} file is renamed .invalid-<ISO>, logged without contents, treated as empty`, async () => {
    const ctx = setup()
    mkdirSync(ctx.dir, { mode: 0o700 })
    writeFileSync(pairingsPath(ctx.dir), body, { mode: 0o600 })
    await ctx.store.load()
    expect(ctx.store.list()).toEqual([])
    expect(existsSync(pairingsPath(ctx.dir))).toBe(false)
    const renamed = `pairings.json.invalid-2026-11-16T10:00:00.000Z`
    expect(readdirSync(ctx.dir)).toEqual([renamed])
    expect(readFileSync(join(ctx.dir, renamed), "utf8")).toBe(body)
    const line = ctx.logs.find((entry) => entry.event === "pairing-store-invalid")
    expect(line?.fields.renamedTo).toBe(join(ctx.dir, renamed))
    expect(JSON.stringify(ctx.logs)).not.toContain(body)
    expect(await ctx.store.verify(TOKEN_A)).toBeUndefined()
    // Re-pairing afterwards writes a fresh valid store.
    await ctx.store.put("Word", TOKEN_A)
    expect(readStore(ctx.dir).version).toBe(1)
  }),
)

test("SC-18: an entry idle for more than 90 days is dropped on load; exactly 90 days is kept", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  ctx.clock.at += 60_000
  await ctx.store.put("Excel", TOKEN_B)
  ctx.clock.at += PAIRING_IDLE_MS - 60_000
  const later = createPairingStore({ dir: ctx.dir, now: () => new Date(ctx.clock.at), log: (event, fields) => ctx.logs.push({ event, fields }) })
  await later.load()
  expect(later.list().map((entry) => entry.host).sort()).toEqual(["Excel", "Word"])
  ctx.clock.at += 1
  await later.load()
  expect(later.list().map((entry) => entry.host)).toEqual(["Excel"])
  expect(readStore(ctx.dir).pairings.map((entry: { host: string }) => entry.host)).toEqual(["Excel"])
  expect(ctx.logs.some((line) => line.event === "pairing-expired" && line.fields.host === "Word")).toBe(true)
  expect(await later.verify(TOKEN_A)).toBeUndefined()
})

test("SC-18: verify on a long-running store also refuses an idle entry; use resets the idle clock", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  await ctx.store.put("Excel", TOKEN_B)
  ctx.clock.at += PAIRING_IDLE_MS - 1000
  expect(await ctx.store.verify(TOKEN_B)).toBe("Excel")
  ctx.clock.at += 2000
  expect(await ctx.store.verify(TOKEN_A)).toBeUndefined()
  expect(await ctx.store.verify(TOKEN_B)).toBe("Excel")
  expect(ctx.store.list().map((entry) => entry.host)).toEqual(["Excel"])
})

test("missing file loads empty and creates the dir 0700", async () => {
  const ctx = setup()
  await ctx.store.load()
  expect(ctx.store.list()).toEqual([])
  expect(statSync(ctx.dir).mode & 0o777).toBe(0o700)
  expect(existsSync(pairingsPath(ctx.dir))).toBe(false)
})

test("C35: lookup is read-only (file bytes and mtime unchanged); verify still updates lastUsedAt", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  const before = readFileSync(pairingsPath(ctx.dir), "utf8")
  const mtimeBefore = statSync(pairingsPath(ctx.dir)).mtimeMs
  ctx.clock.at += 60_000
  await Bun.sleep(20)
  expect(ctx.store.lookup(TOKEN_A)).toBe("Word")
  expect(ctx.store.lookup(TOKEN_B)).toBeUndefined()
  expect(ctx.store.lookup("")).toBeUndefined()
  expect(readFileSync(pairingsPath(ctx.dir), "utf8")).toBe(before)
  expect(statSync(pairingsPath(ctx.dir)).mtimeMs).toBe(mtimeBefore)
  expect(ctx.store.list()[0].lastUsedAt).toBe("2026-11-16T10:00:00.000Z")
  expect(await ctx.store.verify(TOKEN_A)).toBe("Word")
  expect(readStore(ctx.dir).pairings[0].lastUsedAt).toBe("2026-11-16T10:01:00.000Z")
  expect(statSync(pairingsPath(ctx.dir)).mtimeMs).toBeGreaterThan(mtimeBefore)
})

test("C35: lookup honours the 90-day idle expiry in memory without writing", async () => {
  const ctx = setup()
  await ctx.store.load()
  await ctx.store.put("Word", TOKEN_A)
  const before = readFileSync(pairingsPath(ctx.dir), "utf8")
  ctx.clock.at += PAIRING_IDLE_MS
  expect(ctx.store.lookup(TOKEN_A)).toBe("Word")
  ctx.clock.at += 1
  expect(ctx.store.lookup(TOKEN_A)).toBeUndefined()
  expect(readFileSync(pairingsPath(ctx.dir), "utf8")).toBe(before)
  expect(ctx.store.list()).toHaveLength(1)
})
