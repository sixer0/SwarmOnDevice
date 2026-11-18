import { Global } from "@opencode-ai/core/global"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

// 1.3.4 (T-12, owner decision U4 of 2026-11-18). The autonomous-mode consent lives in memory only (AU-23), so every new
// process asks the person again (1.3.3 MC-7). That stays true for a crash, a quit and an app opened by hand. For one case
// the person has just acted themselves: they clicked Restart in the menu, or Reopen on the memory offer. Then the consent
// they gave a minute ago is carried over once: the sidecar writes the consented scopes to a 0600 file right before it
// hands its runs over, and the next process reads it once, deletes it at once, and restores consent only for scopes
// that are still on in the mode file and waiting on a re-consent. The file is stale after CARRY_MAX_AGE_MS, and is
// ignored when the process that wrote it is still alive or is this one.

/** @internal test seam */
export const CARRY_MAX_AGE_MS = 120_000
const FILE = "consent-carry.json"
const file = () => path.join(Global.Path.state, "autonomy", FILE)

type Scope = { key: string; language: "en" | "id" }
type Carry = { v: 1; pid: number; at: number; scopes: Scope[] }

const live = new Map<string, Scope["language"]>()

/** The consent map the autonomy service keeps; every set and delete is mirrored here so the sidecar can carry it. */
export class MirroredConsentMap<V extends { readonly language: Scope["language"] }> extends Map<string, V> {
  override set(key: string, value: V) {
    live.set(key, value.language)
    return super.set(key, value)
  }
  override delete(key: string) {
    live.delete(key)
    return super.delete(key)
  }
  override clear() {
    for (const key of this.keys()) live.delete(key)
    super.clear()
  }
}

/** Called by the sidecar right before a hand-over restart. Returns how many consented scopes were written. */
export function write(now = Date.now()): number {
  if (live.size === 0) return 0
  const carry: Carry = { v: 1, pid: process.pid, at: now, scopes: [...live].map(([key, language]) => ({ key, language })) }
  mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 })
  const temporary = `${file()}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(carry), { mode: 0o600 })
  // rename keeps a reader from ever seeing half a file
  renameSync(temporary, file())
  return carry.scopes.length
}

/** Read once at start: the file is removed whatever it holds. Returns the scopes to restore, or none. */
export function take(now = Date.now(), alive: (pid: number) => boolean = isAlive): Scope[] {
  let text: string | undefined
  try {
    text = readFileSync(file(), "utf8")
  } catch {
    return []
  } finally {
    rmSync(file(), { force: true })
  }
  try {
    const carry = JSON.parse(text!) as Partial<Carry>
    if (carry.v !== 1 || typeof carry.at !== "number" || typeof carry.pid !== "number" || !Array.isArray(carry.scopes)) return []
    if (now - carry.at > CARRY_MAX_AGE_MS || carry.at > now + 5_000) return []
    if (carry.pid === process.pid || alive(carry.pid)) return []
    return carry.scopes.filter(
      (s): s is Scope =>
        !!s && typeof s.key === "string" && /^(session|directory):/.test(s.key) && (s.language === "en" || s.language === "id"),
    )
  } catch {
    return []
  }
}

/** @internal test seam */
export function clearForTests() {
  live.clear()
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export * as ConsentCarry from "./consent-carry"
