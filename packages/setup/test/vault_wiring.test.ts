// Row-95 unit tests — the standalone vault-inbox wiring (src/vault/), contract 01f §7.
// Refusal matrix (every T-W7-10 vector gets its NAMED reason), happy-path inbox-only writes
// (whole-HOME tree diff), symlink escapes at BOTH boundaries (candidate-vs-inbox and
// inbox-vs-vault-root), create-only semantics, vault-absent guide posture (zero filesystem
// change), row-98 skill facts, and the equivalence pins against r94's shipped proxy surface
// (confine accept/refuse set + inboxDirFromEnv resolution). Zero network, zero spawns.
// Run TARGETED: cd packages/setup && bun test test/vault_wiring.test.ts

import { describe, it, expect, afterEach } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { resolveVault, vaultStatus, obsidianLaunchGuide } from "../src/vault/wiring.ts"
import {
  validateNoteName,
  canonicalInbox,
  writeInboxNote,
  readInboxNote,
  listInboxNotes,
  vaultSkillFacts,
  VAULT_REFUSAL_REASONS,
  MAX_NOTE_BYTES,
  type VaultRefusal,
} from "../src/vault/writer.ts"
import { confine } from "../src/mcpproxy/proxy.ts" // read-only consumption for the equivalence pin (r94's file is NOT modified)
import { inboxDirFromEnv } from "../src/mcpproxy/resolve.ts"

const FIXED_MS = Date.parse("2026-10-20T07:00:00.000Z")
const STAMP = "2026-10-20T07-00-00.000Z"
const fixedNow = () => new Date(FIXED_MS)

const cleanups: string[] = []
function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "r95-vault-"))
  cleanups.push(dir)
  return dir
}
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true })
})

/** Every path under `root`, relative and sorted — the "writes land ONLY here" instrument. */
function walkTree(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(dir, e)
      out.push(p.slice(root.length + 1))
      try {
        if (statSync(p).isDirectory()) stack.push(p)
      } catch {
        /* unreadable leaf: recorded, not descended */
      }
    }
  }
  return out.sort()
}

/** Throwaway HOME with a vault root already present; returns {home, vault, inbox}. */
function stagedVault(): { home: string; vault: string; inbox: string; env: Record<string, string | undefined> } {
  const home = tmpHome()
  const vault = join(home, ".swarm", "vault")
  mkdirSync(vault, { recursive: true, mode: 0o700 })
  return { home, vault, inbox: join(vault, "inbox"), env: { SWARM_VAULT_DIR: vault } }
}

describe("resolveVault (PC-ENV-06 else PC-PATH-13)", () => {
  it("env override wins and reports source=env", () => {
    const v = resolveVault({ SWARM_VAULT_DIR: "/tmp/r95-override" })
    expect(v.root).toBe("/tmp/r95-override")
    expect(v.inbox).toBe("/tmp/r95-override/inbox")
    expect(v.source).toBe("env")
  })

  it("blank/whitespace override falls back to the register default", () => {
    for (const blank of [undefined, "", "   "]) {
      const v = resolveVault({ SWARM_VAULT_DIR: blank })
      expect(v.source).toBe("default")
    }
  })

  it("default expands ~ against HOME (paths.ts homeDir live-read seam)", () => {
    const home = tmpHome()
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      const v = resolveVault({})
      expect(v.root).toBe(join(home, ".swarm", "vault")) // PC-PATH-13 value, tilde expanded
      expect(v.inbox).toBe(join(home, ".swarm", "vault", "inbox"))
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
    }
  })

  it("equivalence with r94's inboxDirFromEnv across env shapes", () => {
    const s = stagedVault()
    for (const env of [{}, { SWARM_VAULT_DIR: s.vault }, { SWARM_VAULT_DIR: "  " }] as const) {
      expect(resolveVault(env).inbox).toBe(inboxDirFromEnv(env))
    }
  })
})

describe("refusal matrix — every confinement vector carries its NAMED reason", () => {
  const matrix: ReadonlyArray<readonly [string, VaultRefusal]> = [
    ["", "empty_name"],
    ["a\0b", "nul_byte"],
    ["a\nb", "newline_in_name"],
    ["a\rb", "newline_in_name"],
    ["/etc/passwd", "absolute_path"],
    ["../x", "parent_traversal"],
    ["a/../../etc/passwd", "parent_traversal"], // ".." checked before the separator rule so traversal NAMES itself
    ["..", "parent_traversal"],
    ["a/b", "path_separator"],
    [".env", "dotfile_name"],
  ]
  for (const [name, reason] of matrix) {
    it(`validateNoteName(${JSON.stringify(name)}) -> ${reason}`, () => {
      const res = validateNoteName(name)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe(reason)
    })
  }

  it("legitimate names pass, incl. backslash (POSIX-legal char; parity with confine)", () => {
    for (const name of ["note", "Research Notes!", "a-b_c.md", "back\\slash"])
      expect(validateNoteName(name).ok).toBe(true)
  })

  it("confinement refusals also fire at the operation level (write refuses, nothing lands)", () => {
    const s = stagedVault()
    const before = walkTree(s.home)
    for (const [name] of matrix) {
      const res = writeInboxNote({ name, content: "x" }, { env: s.env, now: fixedNow })
      expect(res.ok).toBe(false)
    }
    expect(walkTree(s.home)).toEqual(before) // zero filesystem delta
  })

  it("read refuses traversal names before touching the filesystem", () => {
    const s = stagedVault()
    for (const [name] of matrix) {
      const res = readInboxNote(name, { env: s.env })
      expect(res.ok).toBe(false)
    }
  })
})

describe("equivalence with r94's confine() — same accept/refuse SET, richer reasons", () => {
  it("every refused vector: confine returns null AND validateNoteName refuses", () => {
    const s = stagedVault()
    mkdirSync(s.inbox, { recursive: true, mode: 0o700 })
    const inboxReal = realpathSync(s.inbox)
    for (const name of ["", "a\0b", "a\nb", "a\rb", "/etc/passwd", "../x", "a/b", "..", ".env"]) {
      expect(confine(inboxReal, name)).toBeNull()
      expect(validateNoteName(name).ok).toBe(false)
    }
  })

  it("every accepted name: confine resolves inside the inbox AND validate passes", () => {
    const s = stagedVault()
    mkdirSync(s.inbox, { recursive: true, mode: 0o700 })
    const inboxReal = realpathSync(s.inbox)
    for (const name of ["note", "Research Notes!", "a-b_c.md"]) {
      const resolved = confine(inboxReal, name)
      expect(resolved !== null).toBe(true)
      expect(validateNoteName(name).ok).toBe(true)
    }
  })
})

describe("canonicalInbox — §7 containment at BOTH boundaries", () => {
  it("creates the inbox 0700 on demand (P-12 Swarm-managed folder) and canonicalises it", () => {
    const s = stagedVault()
    const res = canonicalInbox(resolveVault(s.env))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.dir).toBe(realpathSync(s.inbox))
    expect(statSync(s.inbox).mode & 0o777).toBe(0o700)
  })

  it("a symlink standing AT the inbox path escaping the vault is refused inbox_symlink_escape", () => {
    const s = stagedVault()
    const outside = join(s.home, "elsewhere")
    mkdirSync(outside, { mode: 0o700 })
    symlinkSync(outside, s.inbox) // inbox IS a symlink out of the vault
    const res = canonicalInbox(resolveVault(s.env))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("inbox_symlink_escape")
    expect(existsSync(join(outside, "inbox"))).toBe(false) // never written through
    expect(walkTree(outside)).toEqual([])
  })

  it("an inbox legitimately nested under a symlinked vault ROOT still passes (containment is canonical)", () => {
    const home = tmpHome()
    const realRoot = join(home, "real")
    mkdirSync(realRoot, { mode: 0o700 })
    const linkRoot = join(home, "link")
    symlinkSync(realRoot, linkRoot)
    const res = canonicalInbox({ root: linkRoot, inbox: join(linkRoot, "inbox"), source: "env" })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.dir).toBe(join(realpathSync(realRoot), "inbox"))
  })
})

describe("writeInboxNote — happy path lands ONLY in the inbox, create-only", () => {
  it("one write: single new file under inbox/, generated name, 0600, sha256 over stored bytes", () => {
    const s = stagedVault()
    mkdirSync(s.inbox, { recursive: true, mode: 0o700 }) // inbox pre-exists here so the ONLY delta can be the note itself (its creation is asserted separately in canonicalInbox)
    const before = walkTree(s.home)
    const res = writeInboxNote({ name: "Research Notes!", content: "finding one" }, { env: s.env, now: fixedNow })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const added = walkTree(s.home).filter((p) => !before.includes(p))
    expect(added.length).toBe(1)
    expect(added[0]!.startsWith(".swarm/vault/inbox/")).toBe(true)
    expect(res.name).toMatch(new RegExp(`^${STAMP.replace(/\./g, "\\.")}-research-notes(-\\d+)?\\.md$`))
    expect(readFileSync(res.path, "utf8")).toBe("finding one")
    expect(statSync(res.path).mode & 0o777).toBe(0o600)
    expect(res.sha256).toBe(createHash("sha256").update("finding one").digest("hex"))
    expect(res.bytes).toBe(11)
  })

  it("collision at the same instant takes a suffix; the first note is untouched (create-only)", () => {
    const s = stagedVault()
    const first = writeInboxNote({ name: "dup", content: "one" }, { env: s.env, now: fixedNow })
    const second = writeInboxNote({ name: "dup", content: "two" }, { env: s.env, now: fixedNow })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.name).not.toBe(first.name)
    expect(second.name).toContain("-1.md")
    expect(readFileSync(first.path, "utf8")).toBe("one") // NO overwrite happened anywhere
  })

  it("exhausted suffix budget refuses too_many_collisions instead of overwriting", () => {
    const s = stagedVault()
    mkdirSync(s.inbox, { recursive: true, mode: 0o700 })
    writeFileSync(join(s.inbox, `${STAMP}-full.md`), "held")
    for (let n = 1; n <= 99; n++) writeFileSync(join(s.inbox, `${STAMP}-full-${n}.md`), "held")
    const res = writeInboxNote({ name: "full", content: "x" }, { env: s.env, now: fixedNow })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("too_many_collisions")
    expect(readFileSync(join(s.inbox, `${STAMP}-full.md`), "utf8")).toBe("held")
  })

  it("a dangling symlink holding the generated name yields name_held, never a write-through", () => {
    const s = stagedVault()
    mkdirSync(s.inbox, { recursive: true, mode: 0o700 })
    const ghost = join(s.home, "ghost-target.md") // deliberately NOT created
    symlinkSync(ghost, join(s.inbox, `${STAMP}-trap.md`))
    const res = writeInboxNote({ name: "trap", content: "x" }, { env: s.env, now: fixedNow })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("name_held")
    expect(existsSync(ghost)).toBe(false) // O_EXCL refused; nothing materialised through the link
  })

  it("oversized content is refused content_too_large with zero filesystem delta", () => {
    const s = stagedVault()
    const before = walkTree(s.home)
    const res = writeInboxNote({ name: "big", content: "a".repeat(MAX_NOTE_BYTES + 1) }, { env: s.env, now: fixedNow })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("content_too_large")
    expect(walkTree(s.home)).toEqual(before)
  })
})

describe("readInboxNote / listInboxNotes", () => {
  it("read returns text + canonical path for a stored note", () => {
    const s = stagedVault()
    const w = writeInboxNote({ name: "alpha", content: "body text" }, { env: s.env, now: fixedNow })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    const r = readInboxNote(w.name, { env: s.env })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe("body text")
    expect(r.path).toBe(realpathSync(w.path))
  })

  it("missing name -> not_found; directory named *.md -> not_a_note", () => {
    const s = stagedVault()
    mkdirSync(s.inbox, { recursive: true, mode: 0o700 })
    const missing = readInboxNote("nope.md", { env: s.env })
    expect(!missing.ok && missing.reason === "not_found").toBe(true)
    mkdirSync(join(s.inbox, "dir.md"))
    const dir = readInboxNote("dir.md", { env: s.env })
    expect(!dir.ok && dir.reason === "not_a_note").toBe(true)
  })

  it("invalid UTF-8 stored bytes fail closed as undecodable (r94 decoder consumed)", () => {
    const s = stagedVault()
    mkdirSync(s.inbox, { recursive: true, mode: 0o700 })
    writeFileSync(join(s.inbox, "bad.md"), new Uint8Array([0xff, 0xfe, 0x00, 0x80]))
    const r = readInboxNote("bad.md", { env: s.env })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("undecodable")
  })

  it("a symlink inside the inbox pointing OUT of the vault is refused symlink_escape; content never leaks", () => {
    const s = stagedVault()
    mkdirSync(s.inbox, { recursive: true, mode: 0o700 })
    const secret = join(s.home, "secret.txt")
    writeFileSync(secret, "TOP-SECRET-MUST-NOT-LEAK")
    symlinkSync(secret, join(s.inbox, "link.md"))
    const r = readInboxNote("link.md", { env: s.env })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("symlink_escape")
    if (!r.ok) expect(JSON.stringify(r)).not.toContain("TOP-SECRET")
  })

  it("a symlink pointing at another note INSIDE the inbox passes (only ESCAPE is forbidden, §7 wording)", () => {
    const s = stagedVault()
    const w = writeInboxNote({ name: "target", content: "shared body" }, { env: s.env, now: fixedNow })
    expect(w.ok).toBe(true)
    if (!w.ok) return
    mkdirSync(s.inbox, { recursive: true })
    symlinkSync(w.path, join(s.inbox, "alias.md"))
    const r = readInboxNote("alias.md", { env: s.env })
    expect(r.ok).toBe(true)
  })

  it("list is sorted, .md-only, and empty-inbox honest", () => {
    const s = stagedVault()
    mkdirSync(s.inbox, { recursive: true, mode: 0o700 })
    writeFileSync(join(s.inbox, "b-two.md"), "b")
    writeFileSync(join(s.inbox, "a-one.md"), "a")
    writeFileSync(join(s.inbox, "notes.txt"), "ignored")
    const l = listInboxNotes({ env: s.env })
    expect(l.ok).toBe(true)
    if (!l.ok) return
    expect(l.names).toEqual(["a-one.md", "b-two.md"])
  })
})

describe("vault-absent posture — guide, don't fabricate", () => {
  it("status on a fresh HOME reports absence, guides opening the vault, and CHANGES NOTHING", () => {
    const home = tmpHome()
    const before = walkTree(home)
    const st = vaultStatus({ SWARM_VAULT_DIR: join(home, ".swarm", "vault") })
    expect(st.vaultRootExists).toBe(false)
    expect(st.inboxExists).toBe(false)
    expect(st.noteCount).toBeNull()
    const text = st.guidance.join("\n")
    expect(text).toContain("Open folder as vault")
    expect(text).toContain("creates the inbox folder") // creation is deferred to the first write, stated honestly
    expect(text).toContain("filesystem-only")
    expect(walkTree(home)).toEqual(before) // read-only: zero writes, zero fabricated .obsidian config
    expect(existsSync(join(home, ".swarm", "vault", ".obsidian"))).toBe(false)
  })

  it("status counts notes without touching them", () => {
    const s = stagedVault()
    writeInboxNote({ name: "one", content: "1" }, { env: s.env, now: fixedNow })
    const before = walkTree(s.home)
    const st = vaultStatus(s.env)
    expect(st.vaultRootExists).toBe(true)
    expect(st.inboxExists).toBe(true)
    expect(st.noteCount).toBe(1)
    expect(walkTree(s.home)).toEqual(before)
  })

  it("launch guide with neither staged nor system app says ABSENT and routes to swarm-setup install", () => {
    const s = stagedVault()
    const g = obsidianLaunchGuide({ env: s.env, version: "v0.0.0-test", installRoot: join(s.home, "empty-tools") })
    // Host fact pinned by s90 §4 (/Applications/Obsidian.app ABSENT on this machine); if a user
    // installs Obsidian mid-run the branch flips honestly to "system" — assert the invariant either way.
    expect(["system", "absent"]).toContain(g.appSource)
    expect(g.vaultRoot).toBe(s.vault)
    expect(g.steps.length >= 2).toBe(true)
    if (g.appSource === "absent") expect(g.steps.join("\n")).toContain("swarm-setup install")
    expect(g.appPath === null || g.appPath.length > 0).toBe(true)
  })
})

describe("vaultSkillFacts — the source row 98 cites", () => {
  it("composes the gated tool name and carries the register values verbatim", () => {
    const f = vaultSkillFacts()
    expect(f.toolName).toBe("swarm-web_vault_inbox") // matches researcher.json's grant + mcpPermissionGates composition
    expect(f.writeTarget).toBe("~/.swarm/vault/inbox") // PC-PATH-12 verbatim (01c0:109)
    expect(f.vaultRootDefault).toBe("~/.swarm/vault") // PC-PATH-13 verbatim (01c0:110)
    expect(f.envVarName).toBe("SWARM_VAULT_DIR") // PC-ENV-06 (01c0:215)
    expect(f.actions).toEqual(["write", "list", "read"])
    expect(f.createOnly).toBe(true)
    expect(f.communityPluginUsed).toBe(false)
    expect(f.readsUntrustedEnveloped).toBe(true)
    expect(f.maxNoteBytes).toBe(MAX_NOTE_BYTES)
    expect(f.refusalReasons).toBe(VAULT_REFUSAL_REASONS)
    expect(VAULT_REFUSAL_REASONS.length).toBe(15)
  })
})
