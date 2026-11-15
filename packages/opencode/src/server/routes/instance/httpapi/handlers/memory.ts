import fs from "node:fs/promises"
import path from "node:path"
import { Vault } from "@opencode-ai/core/vault"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "@/memory/memory"
import { VaultMirror } from "@/memory/vault-mirror"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DesktopNonce } from "@/server/desktop-nonce"
import { InstanceHttpApi } from "../api"
import { ApiMemoryPersonOnlyError, MEMORY_PERSON_ONLY, MEMORY_PERSON_ONLY_MESSAGE } from "../groups/memory"

const HUB = "index.md"

type DesktopNonceHeaders = { readonly [DesktopNonce.HEADER]?: string | undefined }
type KeptReason = "device" | "secret" | "classified" | "unsafe"

// The mirror's own id rule (`vault-mirror.ts` ITEM_ID): an id it cannot write as a link label is kept out as "unsafe".
// The audit line logs an id only when it passes the same rule, so a caller-chosen id can never put a path in the log.
const ITEM_ID = /^[0-9A-Za-z_-]{1,64}$/

/**
 * 1.2.10 row 54 (S10-11(P4), 01d §3.3 step 4): one audit line per person-only decision. Only the route, the note id
 * (when it is a store id), the action and whether the desktop nonce matched: never the note text, a path or a header
 * value, so the nonce is never logged.
 */
const audit = (source: "ProjectMemory.allowVault" | "ProjectMemory.update", id: string, action: string, attested: boolean) =>
  (attested ? Effect.logInfo : Effect.logWarning)("memory person-only", {
    source,
    id: ITEM_ID.test(id) ? id : "invalid",
    action,
    attested,
  })

/** N10-001: refused before anything is read, with one audit line that carries no header value. */
const personOnly = (source: "ProjectMemory.allowVault" | "ProjectMemory.update", id: string, action: string) =>
  audit(source, id, action, false).pipe(
    Effect.andThen(
      Effect.fail(
        new ApiMemoryPersonOnlyError({
          name: "MemoryPersonOnlyError",
          data: { code: MEMORY_PERSON_ONLY, message: MEMORY_PERSON_ONLY_MESSAGE },
        }),
      ),
    ),
  )

/**
 * N10-066 (C18 D-7): the live notes that stay out of the vault copy and why, by the mirror's single decision
 * (`VaultMirror.mirrorExclusion`) and then its id rule. Archived index members are shown by their roll-up and left out,
 * as the mirror does. Ids and reasons only, never text.
 */
function keptOf(items: readonly Memory.Item[]) {
  return items.flatMap((item): { id: string; reason: KeptReason }[] => {
    if (item.rolledInto !== undefined && item.kind !== "index_rollup") return []
    const reason = VaultMirror.mirrorExclusion(item) ?? (ITEM_ID.test(item.id) ? undefined : "unsafe")
    return reason ? [{ id: item.id, reason }] : []
  })
}

/**
 * The vault status of one project (N8-114, 01c §6). Reads only: `exists` is true when the hub note is a regular file
 * reached without a symlink below the real vault root, and still owned by this store (VaultMirror.owned).
 */
async function vaultStatus(directory: string, key: string) {
  const folder = Vault.vaultProjectFolder(directory, key)
  const hubPath = path.join(Vault.mirrorDir(), folder, HUB)
  return { folder, hubPath, exists: await hubOwned(folder, key) }
}

async function hubOwned(folder: string, key: string) {
  const rootReal = await Vault.realRoot()
  if (!rootReal) return false
  const hub = path.join(rootReal, Vault.VAULT_MIRROR_DIR, folder, HUB)
  try {
    // realpath equal to the joined path: no symlink in swarm-memory/, the folder or the hub itself.
    if ((await fs.realpath(hub)) !== hub || !Vault.contains(rootReal, hub)) return false
    if (!(await fs.lstat(hub)).isFile()) return false
    return VaultMirror.owned(await fs.readFile(hub, "utf8"), key)
  } catch {
    return false
  }
}

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    return handlers
      .handle("get", () => memory.get())
      .handle("vault", (ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const key = Memory.storeKey(instance.project.id, instance.directory)
          // 01c §4.5 tier 1: the app's language, kept in process for the next mirror run (SR8-16).
          if (ctx.query.language) VaultMirror.rememberLanguage(key, ctx.query.language)
          const status = yield* Effect.promise(() => vaultStatus(instance.directory, key))
          // Omitted when nothing is kept out, so a client that does not read it sees the 1.2.9 answer.
          const kept = keptOf((yield* memory.get()).items)
          return kept.length ? { ...status, kept } : status
        }),
      )
      .handle("add", (ctx) => memory.add({ text: ctx.payload.text, source: "user" }))
      .handle("settings", (ctx) => memory.setEnabled(ctx.payload.enabled))
      // 1.2.10 row 54 (C10, N10-068): whether a note may leave this device is the person's call. A payload that carries
      // `deviceOnly` at all (also its current value, T-10b) needs the desktop nonce and is refused before the store is
      // called. A text-only edit stays password-only as in 1.2.9 (C18 D-4, backlog B10-21); it keeps an export flag
      // only when attested. The store call is built field by field, so no other payload key reaches it (S10-05).
      .handle("update", (ctx) =>
        Effect.gen(function* () {
          const { text, deviceOnly } = ctx.payload
          const attested = DesktopNonce.matches(ctx.headers[DesktopNonce.HEADER])
          const action = deviceOnly === undefined ? "text" : text === undefined ? "scope" : "scope_text"
          if (deviceOnly !== undefined && !attested) return yield* personOnly("ProjectMemory.update", ctx.params.id, action)
          const result = yield* memory.update(ctx.params.id, {
            ...(text === undefined ? {} : { text }),
            ...(deviceOnly === undefined ? {} : { deviceOnly }),
            personAttested: attested,
          })
          if (attested && result.item) yield* audit("ProjectMemory.update", ctx.params.id, action, true)
          return result
        }),
      )
      .handle("remove", (ctx) => memory.remove(ctx.params.id))
      // 1.2.10 row 54 (N10-067, 01d §3.3): the person allows a device-only note into the vault copy, or takes it back.
      // Nonce first, strict (a server holding no nonce refuses everyone), before anything is read. The store then decides
      // inside its lock (archived, classified, secret, not device-only; already allowed = no write) and publishes and
      // schedules the mirror only on a write. The route never waits for the vault.
      .handle("allowVault", (ctx) =>
        Effect.gen(function* () {
          const action = ctx.payload.allowed ? "export" : "undo"
          if (!DesktopNonce.matches(ctx.headers[DesktopNonce.HEADER]))
            return yield* personOnly("ProjectMemory.allowVault", ctx.params.id, action)
          const result = yield* memory.update(ctx.params.id, { vaultAllowed: ctx.payload.allowed, personAttested: true })
          if (result.item) yield* audit("ProjectMemory.allowVault", ctx.params.id, action, true)
          return result
        }),
      )
  }),
)
