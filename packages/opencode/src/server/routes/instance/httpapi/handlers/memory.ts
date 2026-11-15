import fs from "node:fs/promises"
import path from "node:path"
import { Vault } from "@opencode-ai/core/vault"
import { InstanceState } from "@/effect/instance-state"
import { Memory } from "@/memory/memory"
import { VaultMirror } from "@/memory/vault-mirror"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiMemoryPersonOnlyError, MEMORY_PERSON_ONLY, MEMORY_PERSON_ONLY_MESSAGE } from "../groups/memory"

const HUB = "index.md"

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
          return yield* Effect.promise(() => vaultStatus(instance.directory, key))
        }),
      )
      .handle("add", (ctx) => memory.add({ text: ctx.payload.text, source: "user" }))
      .handle("settings", (ctx) => memory.setEnabled(ctx.payload.enabled))
      .handle("update", (ctx) => memory.update(ctx.params.id, ctx.payload))
      .handle("remove", (ctx) => memory.remove(ctx.params.id))
      // 1.2.10 row 54a (contract landing, N10-067): fail closed. Every call is refused 403 before anything is read, with
      // or without the nonce, until row 54 implements the person-only logic. Nothing is read or written here.
      .handle("allowVault", () =>
        Effect.fail(
          new ApiMemoryPersonOnlyError({
            name: "MemoryPersonOnlyError",
            data: { code: MEMORY_PERSON_ONLY, message: MEMORY_PERSON_ONLY_MESSAGE },
          }),
        ),
      )
  }),
)
