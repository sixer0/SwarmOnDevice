// Path-limited vault-inbox writer — row 95. Contract = masterplan/01f_tool_wiring_spec.md §7:
// Swarm writes ONLY into the vault's `inbox/` folder, create-only, and reads come back as
// data (the untrusted envelope is applied by the proxy layer, 01f §6.5/§7 "Read semantics").
// This module is the standalone library form of that rule, OUTSIDE mcpproxy/ (r94's area,
// off-limits): the proxy embeds its own confine()/vaultWrite() (mcpproxy/proxy.ts:436-451,
// :399-428) whose accept/refuse SET this library matches exactly — pinned by the equivalence
// describe in test/vault_wiring.test.ts — while adding what the brief demands: every refusal
// carries a NAMED reason from a closed taxonomy (the proxy lumps all confinement refusals
// into one `path_confined` audit reason; s94_mcp_proxy.md §5). Unification of the two
// implementations is proposed to row 106/97 (s95 report §handoffs), never done by editing
// r94's files from here.
//
// NAMED-REFUSAL TAXONOMY (§7 "Path confinement" row, verbatim classes + T-W7-10 vectors):
//   name-shape (pure string, checked in this order):
//     empty_name        — "" is not a note
//     nul_byte          — embedded NUL (§7: reject NUL)
//     newline_in_name   — \n or \r (§7: reject newlines; also log-injection safety)
//     absolute_path     — starts with "/" (§7: reject absolute paths)
//     parent_traversal  — contains ".." anywhere (§7: reject ".."; conservative on "a..b",
//                         matching the proxy's includes("..") so the two never diverge)
//     path_separator    — contains "/" after the checks above (basename-only rule)
//     dotfile_name      — starts with "." (not notes; parity with confine())
//   filesystem:
//     inbox_symlink_escape — canonical inbox not inside canonical vault root (§7: "any
//                         symlink whose target escapes the vault"; the VAULT-level test r94's
//                         inbox-level prefix test does not perform — this row's addition)
//     symlink_escape       — existing candidate resolves outside the canonical inbox
//   operation (not confinement):
//     content_too_large    — > MAX_NOTE_BYTES bound (parity with proxy MAX_WRITE_BYTES, D-r94-5)
//     name_held            — create-only open refused: something already holds the generated
//                            name (incl. a dangling symlink — O_EXCL makes overwrite
//                            structurally impossible, §7 "create-only")
//     too_many_collisions  — suffix budget exhausted (>99 same-timestamp notes)
//     not_found / not_a_note / undecodable — read-side operation outcomes (fail-closed on
//                            invalid UTF-8 via r94's decodeUtf8Strict, §6.3 posture)
// Every refusal returns {ok:false, reason}; the call is REFUSED WHOLE, never clamped (§7).
//
// DISCIPLINE GATES (test/vault.proofs.sh): no network primitive, no process spawn, no
// destructive fs primitive (rm/rename/rmdir/append/truncate-style rewrite) anywhere here —
// the only effects are mkdir(inbox,0700), create-exclusive(file,0600) and reads. No import
// of state.ts/stepkit/consent: vault notes are user data, deliberately NOT state-listed so
// `swarm-setup remove` can never sweep them (header rationale in ./wiring.ts).

import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs"
import { basename, join } from "node:path"
import { MODES } from "../constants.ts"
import { decodeUtf8Strict } from "../mcpproxy/sanitise.ts" // consume r94's fail-closed decoder
import { ENV_NAMES, MCP_SERVER_NAME, VAULT_INBOX, VAULT_ROOT } from "../mcpproxy/register.ts"
import { resolveVault, type VaultPaths } from "./wiring.ts"

/** Note-size bound: parity with the proxy's MAX_WRITE_BYTES (mcpproxy/proxy.ts:77). */
export const MAX_NOTE_BYTES = 64 * 1024

/** Collision-suffix budget: parity with the proxy's loop bound (proxy.ts:409). */
const MAX_COLLISION_SUFFIX = 99

export type ConfinementRefusal =
  | "empty_name"
  | "nul_byte"
  | "newline_in_name"
  | "absolute_path"
  | "parent_traversal"
  | "path_separator"
  | "dotfile_name"
  | "inbox_symlink_escape"
  | "symlink_escape"

export type OperationRefusal =
  | "content_too_large"
  | "name_held"
  | "too_many_collisions"
  | "not_found"
  | "not_a_note"
  | "undecodable"

export type VaultRefusal = ConfinementRefusal | OperationRefusal

/** The closed taxonomy, enumerable for docs and for row 98's skill facts. */
export const VAULT_REFUSAL_REASONS: readonly VaultRefusal[] = [
  "empty_name",
  "nul_byte",
  "newline_in_name",
  "absolute_path",
  "parent_traversal",
  "path_separator",
  "dotfile_name",
  "inbox_symlink_escape",
  "symlink_escape",
  "content_too_large",
  "name_held",
  "too_many_collisions",
  "not_found",
  "not_a_note",
  "undecodable",
]

export type Refusal = { readonly ok: false; readonly reason: VaultRefusal }
function refuse(reason: VaultRefusal): Refusal {
  return { ok: false, reason }
}

/** Name-shape validation, ordered so each vector maps to exactly one named reason.
 *  Backslash is NOT rejected: on POSIX it is an ordinary filename character and the proxy
 *  accepts it (confine has no such rule); rejecting here would break the pinned equivalence
 *  without §7 warranting it. */
export function validateNoteName(name: string): { readonly ok: true } | Refusal {
  if (name === "") return refuse("empty_name")
  if (name.includes("\0")) return refuse("nul_byte")
  if (name.includes("\n") || name.includes("\r")) return refuse("newline_in_name")
  if (name.startsWith("/")) return refuse("absolute_path")
  if (name.includes("..")) return refuse("parent_traversal")
  if (name.includes("/")) return refuse("path_separator")
  if (name.startsWith(".")) return refuse("dotfile_name")
  return { ok: true }
}

/**
 * Ensure + canonicalise the inbox, fail-closed (§7): create it 0700 when absent (P-12
 * sanctions a NEW Swarm-managed folder; nothing else is ever created), then require the
 * realpath of the inbox to sit inside the realpath of the vault root. A symlink standing AT
 * the inbox path pointing outside the vault fails that test — this is the literal §7 clause
 * "any symlink whose target escapes the vault", applied at the vault boundary rather than
 * only at the inbox boundary (r94's confine tests candidate-inside-inbox; both layers pin
 * equivalence-compatible behavior). Throws only on raw filesystem faults (e.g. the root
 * path exists as a file) — refusals always carry a named reason instead.
 */
export function canonicalInbox(
  vault: VaultPaths = resolveVault(),
): { readonly ok: true; readonly dir: string } | Refusal {
  if (!existsSync(vault.inbox)) mkdirSync(vault.inbox, { recursive: true, mode: MODES.DIR_0700 })
  const inboxReal = tryRealpath(vault.inbox)
  const vaultReal = tryRealpath(vault.root)
  if (inboxReal === null || vaultReal === null) return refuse("inbox_symlink_escape") // fail-closed: cannot canonicalise -> cannot write
  if (inboxReal !== vaultReal && !inboxReal.startsWith(`${vaultReal}/`)) return refuse("inbox_symlink_escape")
  return { ok: true, dir: inboxReal }
}

export interface WriteInput {
  /** Slug source AND shape-checked name (T-W7-10: a traversal-shaped hint is REFUSED with a
   *  named reason, never silently sanitised into a different note). */
  readonly name: string
  readonly content: string
}

export interface WriteSuccess {
  readonly ok: true
  /** Final stored basename `<UTC ts>-<slug>.md[-<n>]` (generated; the caller's name is a hint). */
  readonly name: string
  readonly path: string
  readonly bytes: number
  /** sha256 of the exact stored bytes — lets any consumer cross-check the proxy's audit line
   *  (§6.6 records the resolved name; the digest proves content identity across the two). */
  readonly sha256: string
}

/** Create-only write inside the canonical inbox (§7 "Write semantics"): filename generated
 *  from the UTC timestamp plus the slugified hint, collisions take numeric suffixes, O_EXCL
 *  makes overwrite structurally impossible, and no delete/rename primitive exists in this
 *  module. Fixed `now` seam mirrors r94's deps.now() so units can force collision paths. */
export function writeInboxNote(
  input: WriteInput,
  options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly now?: () => Date } = {},
): WriteSuccess | Refusal {
  const bytes = byteLen(input.content)
  if (bytes > MAX_NOTE_BYTES) return refuse("content_too_large")
  const shape = validateNoteName(input.name)
  if (!shape.ok) return shape
  const inbox = canonicalInbox(resolveVault(options.env))
  if (!inbox.ok) return inbox
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:]/g, "-")
  const slug = slugify(input.name) // mirrors proxy.ts slugify (unification = row 106/97 handoff)
  let target = join(inbox.dir, `${stamp}-${slug}.md`)
  for (let n = 1; existsSync(target) && n <= MAX_COLLISION_SUFFIX; n++)
    target = join(inbox.dir, `${stamp}-${slug}-${n}.md`)
  if (existsSync(target)) return refuse("too_many_collisions")
  let fd: number
  try {
    fd = openSync(target, "wx", MODES.FILE_0600) // "wx": EEXIST on ANY holder of the name, incl. a dangling symlink
  } catch {
    return refuse("name_held")
  }
  try {
    writeSync(fd, new TextEncoder().encode(input.content))
  } finally {
    closeSync(fd)
  }
  return {
    ok: true,
    name: basename(target),
    path: target,
    bytes,
    sha256: createHash("sha256").update(input.content).digest("hex"),
  }
}

export interface ReadSuccess {
  readonly ok: true
  readonly name: string
  /** Canonical stored path (realpath-resolved, §7 confinement evidence). */
  readonly path: string
  readonly text: string
  readonly bytes: number
}

/** Read one stored note. Confinement runs BEFORE the read: an existing candidate must
 *  realpath inside the canonical inbox (symlink_escape otherwise), mirroring confine()'s
 *  existing-object branch. The raw text comes back UNENVELOPED on purpose — the envelope +
 *  sanitiser are the proxy's read path (§7 "Read semantics"); direct library consumers (tests,
 *  future tooling) get bytes and must treat them as untrusted themselves. */
export function readInboxNote(
  name: string,
  options: { readonly env?: Readonly<Record<string, string | undefined>> } = {},
): ReadSuccess | Refusal {
  const shape = validateNoteName(name)
  if (!shape.ok) return shape
  const inbox = canonicalInbox(resolveVault(options.env))
  if (!inbox.ok) return inbox
  const candidate = join(inbox.dir, name)
  if (!existsSync(candidate)) return refuse("not_found")
  const candReal = tryRealpath(candidate)
  if (candReal === null) return refuse("symlink_escape") // dangling or racing: fail-closed
  if (candReal !== inbox.dir && !candReal.startsWith(`${inbox.dir}/`)) return refuse("symlink_escape")
  if (!statSync(candReal).isFile()) return refuse("not_a_note")
  const bytes = readFileSync(candReal)
  const decoded = decodeUtf8Strict(bytes)
  if (!decoded.ok) return refuse("undecodable")
  return { ok: true, name, path: candReal, text: decoded.text, bytes: bytes.length }
}

/** Basenames of stored notes, sorted, `.md` only (parity with the proxy's list filter). */
export function listInboxNotes(
  options: { readonly env?: Readonly<Record<string, string | undefined>> } = {},
): { readonly ok: true; readonly dir: string; readonly names: readonly string[] } | Refusal {
  const inbox = canonicalInbox(resolveVault(options.env))
  if (!inbox.ok) return inbox
  return {
    ok: true,
    dir: inbox.dir,
    names: readdirSync(inbox.dir)
      .filter((n) => n.endsWith(".md"))
      .sort(),
  }
}

// --- integration point for row 98 (document-writer: "the Obsidian inbox" skill text) ----------

/** The single machine-readable source row 98 cites when writing the inbox skill, and row
 *  113 re-checks against the shipped config. Facts, not prose: every field traces to a
 *  register constant (01c0 lines cited in mcpproxy/register.ts) or to 01f §7/§6.2. The tool
 *  NAME composes from MCP_SERVER_NAME so a rename can never fork the skill text from the
 *  proxy surface. */
export interface VaultSkillFacts {
  readonly toolName: string
  readonly serverName: string
  readonly actions: readonly string[]
  /** Register tilde forms VERBATIM (PC-PATH-12/13) — skills print these, runtime resolves them. */
  readonly writeTarget: string
  readonly vaultRootDefault: string
  readonly envVarName: string
  readonly maxNoteBytes: number
  readonly createOnly: true
  readonly overwriteDeleteRename: "none"
  readonly readsUntrustedEnveloped: true
  readonly communityPluginUsed: false
  readonly refusalReasons: readonly VaultRefusal[]
}

export function vaultSkillFacts(): VaultSkillFacts {
  return {
    toolName: `${MCP_SERVER_NAME}_vault_inbox`,
    serverName: MCP_SERVER_NAME,
    actions: ["write", "list", "read"],
    writeTarget: VAULT_INBOX,
    vaultRootDefault: VAULT_ROOT,
    envVarName: ENV_NAMES.VAULT_DIR,
    maxNoteBytes: MAX_NOTE_BYTES,
    createOnly: true,
    overwriteDeleteRename: "none",
    readsUntrustedEnveloped: true,
    communityPluginUsed: false,
    refusalReasons: VAULT_REFUSAL_REASONS,
  }
}

// --- helpers -----------------------------------------------------------------------------------

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** Byte-for-byte mirror of proxy.ts slugify (r94): lowercase, non-alnum runs to "-", trim,
 *  40-char cap, "note" fallback. Kept local because proxy.ts does not export it and
 *  mcpproxy/ is r94's area; the equivalence unit pins identical output on shared vectors. */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return s === "" ? "note" : s
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length
}
