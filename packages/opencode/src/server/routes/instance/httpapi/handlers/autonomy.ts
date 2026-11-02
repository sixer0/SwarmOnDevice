import fs from "node:fs/promises"
import path from "node:path"
import * as InstanceState from "@/effect/instance-state"
import { Autonomy } from "@/permission/autonomy"
import type { SessionID } from "@/session/schema"
import { ServerAuth } from "@/server/auth"
import { Session } from "@/session/session"
import { Archive } from "@/tool/archive"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import type { ApiNotFoundError } from "../errors"
import { ApiAutonomyConsentError, ApiAutonomyNoPasswordError, ApiAutonomyWriteError } from "../groups/autonomy"
import * as SessionError from "./session-errors"

// A draft has no session yet, and no session is ever stored under this: only the folder can answer.
const NO_SESSION = "" as SessionID

// An entry's name as `Archive.move` makes it. Anything else under the archive was not put there by Swarm, and stays.
const ENTRY = /^\d{8}-\d{6}-\d{1,4}$/
const SHOWN_PATHS = 20
// Counting stops here: past it the person is shown at least this many, as `Archive.size` does for bytes.
const MAX_COUNT = 100_000

type Shown = { id: string; bytes: number; count: number; paths: string[] }

// What is under one entry, links counted as links and never followed. An empty folder is a path of its own.
async function entryOf(archive: string, id: string): Promise<Shown> {
  const shown: Shown = { id, bytes: 0, count: 0, paths: [] }
  const walk = async (rel: string): Promise<void> => {
    if (shown.count >= MAX_COUNT) return
    const stat = await fs.lstat(path.join(archive, id, rel)).catch(() => undefined)
    if (!stat) return
    const names = stat.isDirectory() ? await fs.readdir(path.join(archive, id, rel)).catch(() => [] as string[]) : []
    if (rel && names.length === 0) {
      shown.count++
      if (!stat.isDirectory()) shown.bytes += stat.size
      if (shown.paths.length < SHOWN_PATHS) shown.paths.push(rel.split(path.sep).join(path.posix.sep))
      return
    }
    for (const name of names.toSorted()) await walk(path.join(rel, name))
  }
  await walk("")
  return shown
}

// The archive of a folder as the person sees it. Only a real folder is read: a link in its place is reported, not followed.
async function archiveOf(directory: string) {
  const archive = await Archive.folder(directory)
  if (!archive) {
    const dot = await fs.lstat(path.join(directory, ".swarm")).catch(() => undefined)
    const there = await fs.lstat(path.join(directory, Archive.ARCHIVE_DIR)).catch(() => undefined)
    return {
      archive,
      entries: [] as Shown[],
      unsafe: !!there || (!!dot && (dot.isSymbolicLink() || !dot.isDirectory())),
    }
  }
  const names = await fs.readdir(archive, { withFileTypes: true }).catch(() => [])
  const entries: Shown[] = []
  // `withFileTypes` does not follow links, so an entry that is a link is never read.
  for (const item of names.toSorted((a, b) => a.name.localeCompare(b.name)))
    if (ENTRY.test(item.name) && item.isDirectory()) entries.push(await entryOf(archive, item.name))
  return { archive, entries, unsafe: false }
}

// Deletes the named entries for good, and only under the archive: the archive and each entry are looked at again right
// before it goes, and an entry that does not resolve to itself under the archive is left. Returns how many were left.
async function emptyArchive(directory: string, archive: string, ids: readonly string[]) {
  let left = 0
  for (const id of ids) {
    if ((await Archive.folder(directory)) !== archive) {
      left++
      continue
    }
    const entry = path.join(archive, id)
    const stat = await fs.lstat(entry).catch(() => undefined)
    if (!stat?.isDirectory() || (await fs.realpath(entry).catch(() => undefined)) !== entry) {
      left++
      continue
    }
    // `rm` removes a link inside as the link; what it points to stays.
    await fs.rm(entry, { recursive: true }).catch(() => left++)
  }
  return left
}

export const autonomyHandlers = HttpApiBuilder.group(InstanceHttpApi, "autonomy", (handlers) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    const sessions = yield* Session.Service
    // Read once, as the authorization middleware does: the password a server starts with is the one it keeps.
    const password = ServerAuth.required(yield* ServerAuth.Config.pipe(Effect.provide(ServerAuth.Config.layer)))

    const rootOf = (sessionID: SessionID): Effect.Effect<Session.Info, ApiNotFoundError> =>
      SessionError.mapStorageNotFound(sessions.get(sessionID)).pipe(
        Effect.flatMap((session) => (session.parentID ? rootOf(session.parentID) : Effect.succeed(session))),
      )

    const modeAt = Effect.fn("AutonomyHttpApi.modeAt")(function* (where: Autonomy.Where) {
      return { on: yield* autonomy.isOn(where), externalChange: yield* autonomy.externalChange() }
    })

    const folderMode = Effect.fn("AutonomyHttpApi.folderMode")(function* () {
      return yield* modeAt({ root: NO_SESSION, directory: (yield* InstanceState.context).directory })
    })

    const saved = (change: Autonomy.ModeChange) =>
      autonomy
        .setMode(change)
        .pipe(
          Effect.mapError(
            (error) => new ApiAutonomyWriteError({ name: "AutonomyWriteError", data: { message: error.message } }),
          ),
        )

    const modeUpdate = Effect.fn("AutonomyHttpApi.modeUpdate")(function* (ctx: {
      payload: { on: boolean; sessionID?: SessionID }
    }) {
      const instance = yield* InstanceState.context
      if (!ctx.payload.sessionID) {
        yield* saved({ scope: "directory", directory: instance.directory, on: ctx.payload.on })
        return yield* folderMode()
      }
      const root = yield* rootOf(ctx.payload.sessionID)
      const where = { root: root.id, directory: root.directory ?? instance.directory }
      // Also when saving failed: stopping holds in memory all the same, and the record should say so.
      yield* saved({ scope: "session", root: root.id, on: ctx.payload.on }).pipe(
        Effect.ensuring(autonomy.markMode(where)),
      )
      return yield* modeAt(where)
    })

    const confirm = Effect.fn("AutonomyHttpApi.confirm")(function* () {
      yield* autonomy.confirm()
      return yield* folderMode()
    })

    const session = Effect.fn("AutonomyHttpApi.session")(function* (ctx: { params: { sessionID: SessionID } }) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(ctx.params.sessionID)
      const mode = yield* modeAt({ root: root.id, directory: root.directory ?? instance.directory })
      const read = yield* autonomy.readAudit(root.id)
      const open = (yield* autonomy.openDecisions()).filter((line) => line.rootID === root.id).length
      return { rootID: root.id, ...mode, open, ...read }
    })

    const consentOf = (rootID: SessionID, consent: Autonomy.Consent | undefined) => ({
      rootID,
      consent: consent
        ? {
            id: consent.id,
            hash: consent.hash,
            at: consent.at,
            items: consent.items.map((item) => ({
              id: item.id,
              kind: item.kind,
              pattern: item.pattern,
              files: item.files,
              named: item.named,
              checked: item.checked,
              given: consent.given.has(item.id),
            })),
            stopped: consent.stopped,
            dropped: consent.dropped,
          }
        : null,
    })

    const consent = Effect.fn("AutonomyHttpApi.consent")(function* (ctx: { params: { sessionID: SessionID } }) {
      const root = yield* rootOf(ctx.params.sessionID)
      return consentOf(root.id, yield* autonomy.consent(root.id))
    })

    const consentAllow = Effect.fn("AutonomyHttpApi.consentAllow")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { hash: string; ids: readonly string[] }
    }) {
      // The password is what tells a person from an agent here: the shell never gets it, so without one nobody is asked.
      if (!password)
        return yield* new ApiAutonomyNoPasswordError({
          name: "AutonomyNoPasswordError",
          data: { message: "Consent needs a server password" },
        })
      const root = yield* rootOf(ctx.params.sessionID)
      const given = yield* autonomy.allowConsent({ root: root.id, hash: ctx.payload.hash, ids: ctx.payload.ids }).pipe(
        Effect.catchTags({
          AutonomyConsentError: (error) =>
            Effect.fail(
              new ApiAutonomyConsentError({ name: "AutonomyConsentError", data: { message: error.message } }),
            ),
          AutonomyWriteError: (error) =>
            Effect.fail(new ApiAutonomyWriteError({ name: "AutonomyWriteError", data: { message: error.message } })),
        }),
      )
      return consentOf(root.id, given)
    })

    const archiveState = (rootID: SessionID, read: Awaited<ReturnType<typeof archiveOf>>) => ({
      rootID,
      entries: read.entries,
      bytes: read.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      unsafe: read.unsafe,
    })

    const archiveFolder = Effect.fn("AutonomyHttpApi.archiveFolder")(function* (sessionID: SessionID) {
      const instance = yield* InstanceState.context
      const root = yield* rootOf(sessionID)
      return { root, directory: root.directory ?? instance.directory }
    })

    const archive = Effect.fn("AutonomyHttpApi.archive")(function* (ctx: { params: { sessionID: SessionID } }) {
      const { root, directory } = yield* archiveFolder(ctx.params.sessionID)
      return archiveState(root.id, yield* Effect.promise(() => archiveOf(directory)))
    })

    const archiveEmpty = Effect.fn("AutonomyHttpApi.archiveEmpty")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { ids: readonly string[] }
    }) {
      // As with consent: without a password any process on the machine, the agent's shell too, could empty it.
      if (!password)
        return yield* new ApiAutonomyNoPasswordError({
          name: "AutonomyNoPasswordError",
          data: { message: "Emptying the archive needs a server password" },
        })
      const { root, directory } = yield* archiveFolder(ctx.params.sessionID)
      const before = yield* Effect.promise(() => archiveOf(directory))
      // Only what the person was shown: an entry moved in since they looked stays for the next time.
      const picked = before.entries.filter((entry) => ctx.payload.ids.includes(entry.id)).map((entry) => entry.id)
      if (!before.archive || picked.length === 0) return archiveState(root.id, before)
      const failed = (message: string) => new ApiAutonomyWriteError({ name: "AutonomyWriteError", data: { message } })
      // Recorded before anything goes, so the record never says less than was deleted.
      yield* autonomy
        .record(root.id, { type: "marker", directory, marker: "archive_emptied", decidedBy: "person" })
        .pipe(Effect.mapError((error) => failed(error.message)))
      const left = yield* Effect.promise(() => emptyArchive(directory, before.archive!, picked))
      if (left > 0) return yield* failed(`${left} archive entr${left === 1 ? "y" : "ies"} could not be deleted`)
      return archiveState(root.id, yield* Effect.promise(() => archiveOf(directory)))
    })

    return handlers
      .handle("mode", folderMode)
      .handle("modeUpdate", modeUpdate)
      .handle("confirm", confirm)
      .handle("session", session)
      .handle("consent", consent)
      .handle("consentAllow", consentAllow)
      .handle("archive", archive)
      .handle("archiveEmpty", archiveEmpty)
  }),
)
