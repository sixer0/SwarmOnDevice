// Swarm 1.2.9 row 40, AC-B01a (N9-116): both setup inbox writers refuse a note whose name (as
// given or slugified) or content holds a classification word, before anything is written.
// Proxy: tool `vault_inbox` through handleRpc (the callTool pattern of test/mcp_proxy.test.ts).
// Library: writeInboxNote(..., { env }).
// This file deliberately does NOT import src/vault/classified.ts: it carries a literal sample list
// so it loads at BASE and its red there is behavioural (the notes are written), not an import error.
// The four words appear here only as rule subjects (synthetic samples, syn129).
// Run with every XDG_* variable unset: cd packages/setup && bun test test/rel129-b01-inbox-classified.test.ts

import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleRpc, type ProxyDeps, type RpcResponse, type Transport } from "../src/mcpproxy/proxy.ts"
import { writeInboxNote } from "../src/vault/writer.ts"

const FIXED_MS = Date.parse("2026-11-14T07:00:00.000Z")

const refusalText = (word: string) =>
  `BLOCKED_BY_POLICY: classified_content: the note holds the classification word ${word}; nothing was written. For classified work write only the mission id, date, status and links, without the word.`

interface Sample {
  readonly id: string
  readonly name: string
  readonly content: string
  readonly word: string
}

// P1-P7 (proxy) and W1-W7 (writer) use the same seven samples.
const CLASSIFIED: readonly Sample[] = [
  { id: "1", name: "status-note", content: "Status: TERBATAS\nmission m-syn129, 2026-11-14", word: "TERBATAS" },
  { id: "2", name: "memo", content: "Catatan ini Rahasia untuk tim syn129.", word: "RAHASIA" },
  { id: "3", name: "brief", content: "Klasifikasi: SANGAT RAHASIA (syn129)", word: "RAHASIA" },
  { id: "4", name: "confidential-plan", content: "clean syn129 body", word: "CONFIDENTIAL" },
  { id: "5", name: "access", content: "this syn129 material is restricted to the team", word: "RESTRICTED" },
  // S9-03: the word is only visible after slugify ("TERBATAS_plan" -> "terbatas-plan").
  { id: "6", name: "TERBATAS_plan", content: "clean syn129 body", word: "TERBATAS" },
  // S9-03: "RAHASIAX" is not a whole word, but the 40-char slug cap truncates it to "...-rahasia".
  { id: "7", name: `${"a".repeat(32)}-RAHASIAX`, content: "clean syn129 body", word: "RAHASIA" },
]

// N1-N4: negative controls, written exactly once with bytes equal to the content.
const CLEAN: readonly Sample[] = [
  { id: "1", name: "n1-longer-word", content: "terbatasnya waktu syn129", word: "" },
  { id: "2", name: "n2-underscore", content: "RESTRICTED_ACCESS flag in syn129", word: "" },
  { id: "3", name: "n3-prefix", content: "unrestricted syn129 notes", word: "" },
  { id: "4", name: "n4-plain", content: "mission m-syn129, 2026-11-14, status done", word: "" },
]

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true })
})

interface Box {
  readonly home: string
  readonly root: string
  readonly inbox: string
  readonly auditPath: string
  readonly env: Record<string, string | undefined>
}

/** mkdtemp home; vault root and inbox inside it; audit log outside the vault root. */
function box(options: { readonly createInbox: boolean }): Box {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "r129-b01-")))
  cleanups.push(home)
  const root = join(home, "vault")
  const inbox = join(root, "inbox")
  if (options.createInbox) mkdirSync(inbox, { recursive: true, mode: 0o700 })
  return { home, root, inbox, auditPath: join(home, "web-audit.log"), env: { SWARM_VAULT_DIR: root } }
}

const noTransport: Transport = {
  async request() {
    throw new Error("vault_inbox must not open a connection")
  },
}

function deps(b: Box): ProxyDeps {
  return {
    transport: noTransport,
    searxngBase: () => null,
    firecrawlBase: () => null,
    firecrawlToken: () => null,
    inboxDir: () => b.inbox,
    audit: { path: b.auditPath },
    now: () => new Date(FIXED_MS),
    nonce: () => "aabbccdd",
  }
}

function callWrite(b: Box, name: string, content: string): Promise<RpcResponse | null> {
  return handleRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_inbox", arguments: { action: "write", name, content } } },
    deps(b),
  )
}

function result(res: RpcResponse | null): { text: string; isError: boolean } {
  const r = res?.result as { content?: { text?: string }[]; isError?: boolean } | undefined
  return { text: r?.content?.[0]?.text ?? "", isError: r?.isError === true }
}

function auditText(b: Box): string {
  return existsSync(b.auditPath) ? readFileSync(b.auditPath, "utf8") : ""
}

function lastAudit(b: Box): Record<string, unknown> {
  const lines = auditText(b)
    .trim()
    .split("\n")
    .filter((l) => l !== "")
  return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>
}

/** Recursive listing (relative name, kind, size) of a directory; [] when it does not exist. */
function listing(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel)).sort()) {
      const p = join(rel, entry)
      const st = lstatSync(join(dir, p))
      const kind = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"
      out.push(`${kind} ${p} ${kind === "f" ? st.size : 0}`)
      if (st.isDirectory()) walk(p)
    }
  }
  walk("")
  return out
}

/** The serialised audit text holds neither the word (any case) nor a 16-character piece of the content. */
function expectAuditClean(text: string, word: string, content: string) {
  expect(text.toLowerCase().includes(word.toLowerCase())).toBe(false)
  for (let i = 0; i + 16 <= content.length; i++) expect(text.includes(content.slice(i, i + 16))).toBe(false)
}

describe("AC-B01a proxy vault_inbox refuses classified notes (P1-P7)", () => {
  for (const s of CLASSIFIED) {
    it(`P${s.id}: refused with classified_content ${s.word}, nothing written, audit url null`, async () => {
      const b = box({ createInbox: true })
      const before = listing(b.root)
      const out = result(await callWrite(b, s.name, s.content))
      expect(out).toEqual({ text: refusalText(s.word), isError: true })
      expect(readdirSync(b.inbox)).toEqual([])
      expect(listing(b.root)).toEqual(before)
      const line = lastAudit(b)
      expect(line).toMatchObject({
        component: "swarm-web",
        tool: "vault_inbox",
        action: "write",
        decision: "denied",
        reason: "classified_content",
        query: null,
        url: null,
        host: null,
      })
      expect(Object.keys(line)).not.toContain("sha256")
      expectAuditClean(auditText(b), s.word, s.content)
    })
  }
})

describe("AC-B01a writeInboxNote refuses classified notes (W1-W7)", () => {
  for (const s of CLASSIFIED) {
    it(`W${s.id}: refused with classified_content, inbox stays empty`, () => {
      const b = box({ createInbox: true })
      const before = listing(b.root)
      const out = writeInboxNote({ name: s.name, content: s.content }, { env: b.env, now: () => new Date(FIXED_MS) })
      expect(out).toEqual({ ok: false, reason: "classified_content" } as never)
      expect(readdirSync(b.inbox)).toEqual([])
      expect(listing(b.root)).toEqual(before)
    })

    it(`W${s.id}: a refusal never creates the inbox folder`, () => {
      const b = box({ createInbox: false })
      const out = writeInboxNote({ name: s.name, content: s.content }, { env: b.env, now: () => new Date(FIXED_MS) })
      expect(out).toEqual({ ok: false, reason: "classified_content" } as never)
      expect(existsSync(b.inbox)).toBe(false)
      expect(existsSync(b.root)).toBe(false)
    })
  }
})

describe("AC-B01a negative controls are written exactly once (N1-N4)", () => {
  for (const s of CLEAN) {
    it(`N${s.id} proxy: written once, bytes equal`, async () => {
      const b = box({ createInbox: true })
      const out = result(await callWrite(b, s.name, s.content))
      expect(out.isError).toBe(false)
      const files = readdirSync(b.inbox)
      expect(files.length).toBe(1)
      expect(readFileSync(join(b.inbox, files[0] as string), "utf8")).toBe(s.content)
    })

    it(`N${s.id} writer: written once, bytes equal`, () => {
      const b = box({ createInbox: true })
      const out = writeInboxNote({ name: s.name, content: s.content }, { env: b.env, now: () => new Date(FIXED_MS) })
      expect(out.ok).toBe(true)
      const files = readdirSync(b.inbox)
      expect(files.length).toBe(1)
      expect(readFileSync(join(b.inbox, files[0] as string), "utf8")).toBe(s.content)
    })
  }
})

describe("AC-B01a order of checks (O1, O2)", () => {
  it("O1: a classified note over 64 KiB is refused as content_too_large on both writers (size first)", async () => {
    const content = `Status: TERBATAS\n${"x".repeat(70 * 1024)}`
    const b = box({ createInbox: true })
    const out = result(await callWrite(b, "big", content))
    expect(out.isError).toBe(true)
    expect(out.text).toStartWith("BLOCKED_BY_POLICY: content exceeds")
    expect(readdirSync(b.inbox)).toEqual([])
    expect(lastAudit(b)).toMatchObject({ tool: "vault_inbox", reason: "content_too_large" })
    expectAuditClean(auditText(b), "TERBATAS", content.slice(0, 64))
    const w = box({ createInbox: true })
    expect(writeInboxNote({ name: "big", content }, { env: w.env })).toEqual({ ok: false, reason: "content_too_large" })
    expect(readdirSync(w.inbox)).toEqual([])
  })

  it("O2: name ../TERBATAS is path_confined on the proxy (audit url null, no word) and classified_content on the writer", async () => {
    const b = box({ createInbox: true })
    const before = listing(b.root)
    const out = result(await callWrite(b, "../TERBATAS", "clean syn129 body"))
    expect(out.isError).toBe(true)
    expect(out.text).toStartWith("BLOCKED_BY_POLICY: name must be a safe basename")
    expect(listing(b.root)).toEqual(before)
    expect(lastAudit(b)).toMatchObject({ tool: "vault_inbox", decision: "denied", reason: "path_confined", url: null })
    expectAuditClean(auditText(b), "TERBATAS", "clean syn129 body")
    const w = box({ createInbox: false })
    expect(writeInboxNote({ name: "../TERBATAS", content: "clean syn129 body" }, { env: w.env })).toEqual({
      ok: false,
      reason: "classified_content",
    } as never)
    expect(existsSync(w.inbox)).toBe(false)
  })
})

describe("AC-B01a proxy and writer agree (E1)", () => {
  it("same accept/refuse verdict on P1-P7 and N1-N4", async () => {
    for (const s of [...CLASSIFIED, ...CLEAN]) {
      const p = box({ createInbox: true })
      const proxyRefused = result(await callWrite(p, s.name, s.content)).isError
      const w = box({ createInbox: true })
      const writerRefused = !writeInboxNote({ name: s.name, content: s.content }, { env: w.env }).ok
      expect({ name: s.name, proxyRefused }).toEqual({ name: s.name, proxyRefused: writerRefused })
      expect(proxyRefused).toBe(s.word !== "")
    }
  })
})
