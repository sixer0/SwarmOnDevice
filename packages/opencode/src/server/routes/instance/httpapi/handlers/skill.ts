import path from "path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import * as InstanceState from "@/effect/instance-state"
import { Memory } from "@/memory/memory"
import { DesktopNonce } from "@/server/desktop-nonce"
import { Skill } from "@/skill"
import { SkillManage, type Place, type WriteScope } from "@/skill/manage"
import { Archive } from "@/tool/archive"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import {
  ApiSkillArchiveError,
  ApiSkillChangedError,
  ApiSkillForbiddenError,
  ApiSkillInvalidError,
  ApiSkillMissingError,
  ApiSkillTooLargeError,
} from "../groups/skill"

type DesktopNonceHeaders = { readonly [DesktopNonce.HEADER]?: string | undefined }

type InvalidCode = (typeof ApiSkillInvalidError.fields.data.fields.code)["Type"]
type ForbiddenCode = (typeof ApiSkillForbiddenError.fields.data.fields.code)["Type"]
type MissingCode = (typeof ApiSkillMissingError.fields.data.fields.code)["Type"]

// 01b section 5.6: the status a refusal code is answered with.
const fail = (code: string, message: string) => {
  switch (code) {
    case SkillManage.SKILL_TOO_LARGE:
      return new ApiSkillTooLargeError({ name: "SkillTooLargeError", data: { code: "SKILL_TOO_LARGE", message } })
    case SkillManage.SKILL_CHANGED:
      return new ApiSkillChangedError({ name: "SkillChangedError", data: { code: "SKILL_CHANGED", message } })
    case SkillManage.SKILL_PERSON_ONLY:
    case SkillManage.SKILL_SHELL_UNTRUSTED:
      return new ApiSkillForbiddenError({ name: "SkillForbiddenError", data: { code: code as ForbiddenCode, message } })
    case SkillManage.SKILL_NOT_FOUND:
    case SkillManage.SKILL_DRAFT_MISSING:
      return new ApiSkillMissingError({ name: "SkillMissingError", data: { code: code as MissingCode, message } })
    default:
      return new ApiSkillInvalidError({ name: "SkillInvalidError", data: { code: code as InvalidCode, message } })
  }
}

const badName = () =>
  new ApiSkillInvalidError({
    name: "SkillInvalidError",
    data: { code: "SKILL_NAME_INVALID", message: "Use lowercase letters, digits and hyphens, at most 64 characters." },
  })
const missing = (code: MissingCode, message: string) =>
  new ApiSkillMissingError({ name: "SkillMissingError", data: { code, message } })

const archiveFailed = (message: string) =>
  new ApiSkillArchiveError({ name: "SkillArchiveError", data: { code: "SKILL_ARCHIVE_FAILED", message } })

// 01b section 5.4 (2): whoever calls, a write is taken only with the nonce the desktop app holds for this launch. The
// server password is in a file an agent's shell can read; the nonce is not. A server holding no nonce (`swarm serve`)
// refuses every skill write (S-5): there the person edits the files by hand. Checked before anything is read.
const personOnly = (headers: DesktopNonceHeaders) =>
  DesktopNonce.matches(headers[DesktopNonce.HEADER])
    ? Effect.void
    : Effect.fail(
        new ApiSkillForbiddenError({
          name: "SkillForbiddenError",
          data: { code: "SKILL_PERSON_ONLY", message: "Skills can be saved only from the Swarm desktop app." },
        }),
      )

const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/")

export const skillHandlers = HttpApiBuilder.group(InstanceHttpApi, "skill", (handlers) =>
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const memory = yield* Memory.Service

    const place = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      return { directory: ctx.directory, worktree: ctx.worktree } satisfies Place
    })

    /** The saved skill of this name in this scope: discovered and lying under `<scope root>/{skill,skills}/`. */
    const saved = Effect.fnUntraced(function* (scope: WriteScope, name: string, where: Place) {
      const root = SkillManage.scopeRoot(scope, where)
      const found = (yield* skill.all()).find((info) => info.name === name)
      return found && SkillManage.savedIn(found.location, root) ? found : undefined
    })

    // 01b section 9.3: one note per skill. The old one (if any) is replaced, so its text, body and source follow the
    // latest save. Memory off, `SWARM_DISABLE_MEMORY` or a refusal never undoes the skill: the answer says "skipped".
    const note = Effect.fnUntraced(function* (input: {
      name: string
      scope: WriteScope
      location: string
      description: string
      triggers?: Skill.Triggers
      source: "user" | "agent"
      untrusted: boolean
      where: Place
    }) {
      if (process.env.SWARM_DISABLE_MEMORY) return "skipped" as const
      const store = yield* memory.get()
      if (!store.enabled) return "skipped" as const
      const old = store.items.filter((item) =>
        SkillManage.isNoteOf(item, { name: input.name, location: input.location, place: input.where }),
      )
      for (const item of old) yield* memory.remove(item.id)
      const result = yield* memory.add({
        text: SkillManage.noteText(input),
        source: input.source,
        body: SkillManage.noteBody(SkillManage.shownPath(input.location, input.where), input.triggers),
        // G2-01 (row 43f): the ref is stored as the note shows it (project-relative or `~/...`), never the absolute
        // home path; isNoteOf expands `~/` back to the home folder to match.
        refs: [{ path: SkillManage.shownPath(input.location, input.where) }],
        untrusted: input.untrusted,
      })
      if ("refused" in result) return "skipped" as const
      return old.length ? ("updated" as const) : ("added" as const)
    })

    const dropNote = Effect.fnUntraced(function* (name: string, location: string, where: Place) {
      if (process.env.SWARM_DISABLE_MEMORY) return
      const store = yield* memory.get()
      for (const item of store.items)
        if (SkillManage.isNoteOf(item, { name, location, place: where })) yield* memory.remove(item.id)
    })

    /**
     * The write path PUT and approve share: the checks, the target, the hash rule, the atomic write and the approval
     * record (rolled back when the record cannot be written). Returns what the memory note needs.
     */
    const write = Effect.fnUntraced(function* (input: {
      scope: WriteScope
      name: string
      content: string
      baseHash?: string
      action: "save" | "approve"
      draft?: SkillManage.Draft
      /** SR8-08 (N8-415): the person's second confirm for a draft that runs shell commands. */
      acceptCommands?: boolean
      where: Place
    }) {
      const { scope, name, content, where } = input
      const checked = SkillManage.validate({
        scope,
        name,
        content,
        trusted: ProjectTrust.isTrusted(where.directory),
      })
      if (!checked.ok) return yield* fail(checked.code, checked.message)
      if (input.draft?.runsCommands && input.acceptCommands !== true)
        return yield* fail(
          SkillManage.SKILL_SHELL_UNCONFIRMED,
          "Approving a skill that runs shell commands needs the person's explicit confirmation.",
        )
      const root = SkillManage.scopeRoot(scope, where)
      const existing = yield* saved(scope, name, where)
      const target = existing ? existing.location : path.join(root, "skills", name, "SKILL.md")
      // A project without a `.swarm` folder yet gets one; a link already there is caught by the check below.
      const fresh = yield* Effect.promise(() =>
        fs.lstat(root).then(
          () => false,
          () => true,
        ),
      )
      yield* Effect.promise(() => fs.mkdir(root, { recursive: true }).catch(() => undefined))
      if (!(yield* Effect.promise(() => SkillManage.pathSafe(root, target))))
        return yield* fail(SkillManage.SKILL_PATH_UNSAFE, "That location is a link or lies outside the skills folder.")
      const before = yield* Effect.promise(() => fs.readFile(target).catch(() => undefined))
      if (before !== undefined && SkillManage.hashOf(before) !== input.baseHash)
        return yield* fail(SkillManage.SKILL_CHANGED, "The skill changed on disk after it was opened.")
      const unsafe = () =>
        fail(SkillManage.SKILL_PATH_UNSAFE, "That location is a link or lies outside the skills folder.")
      yield* Effect.tryPromise({ try: () => SkillManage.writeAtomic(target, content), catch: unsafe })
      const hash = SkillManage.hashOf(content)
      yield* Effect.tryPromise({
        try: () =>
          SkillManage.recordApproval({
            action: input.action,
            scope,
            name,
            hash,
            path: relative(root, target),
            ...(input.draft?.sessionID ? { draftSessionID: input.draft.sessionID } : {}),
            ...(input.draft ? { untrusted: input.draft.untrusted } : {}),
          }),
        catch: () => new HttpApiError.InternalServerError({}),
      }).pipe(
        Effect.tapError(() =>
          Effect.promise(() =>
            before !== undefined
              ? SkillManage.writeAtomic(target, before.toString("utf8")).catch(() => undefined)
              : fs.rm(path.dirname(target), { recursive: true, force: true }).catch(() => undefined),
          ),
        ),
      )
      // A new `.swarm` folder is not among the config folders this instance loaded; the next request reloads them, so
      // GET /skill lists the skill without a restart.
      if (fresh) yield* markInstanceForDisposal(yield* InstanceState.context)
      return { location: target, hash, checked }
    })

    const source = Effect.fn("SkillHttpApi.source")(function* (ctx: { query: { scope: WriteScope; name: string } }) {
      const where = yield* place()
      const { scope, name } = ctx.query
      if (!Skill.SKILL_NAME_PATTERN.test(name)) return yield* badName()
      const found = yield* saved(scope, name, where)
      const content = found
        ? yield* Effect.promise(() => fs.readFile(found.location, "utf8").catch(() => undefined))
        : undefined
      if (!found || content === undefined) return yield* missing("SKILL_NOT_FOUND", "That skill is no longer there.")
      return { location: found.location, scope, content, hash: SkillManage.hashOf(content) }
    })

    const save = Effect.fn("SkillHttpApi.save")(function* (ctx: {
      headers: DesktopNonceHeaders
      payload: { scope: WriteScope; name: string; content: string; baseHash?: string }
    }) {
      yield* personOnly(ctx.headers)
      const where = yield* place()
      const { scope, name, content, baseHash } = ctx.payload
      const done = yield* write({ scope, name, content, baseHash, action: "save", where })
      // R20-C12: typed by the person, so the note is the person's.
      const result = yield* note({
        name,
        scope,
        location: done.location,
        description: done.checked.description,
        triggers: done.checked.triggers,
        source: "user",
        untrusted: false,
        where,
      })
      return { location: done.location, hash: done.hash, note: result }
    })

    const remove = Effect.fn("SkillHttpApi.delete")(function* (ctx: {
      headers: DesktopNonceHeaders
      query: { scope: WriteScope; name: string }
    }) {
      yield* personOnly(ctx.headers)
      const where = yield* place()
      const { scope, name } = ctx.query
      if (!Skill.SKILL_NAME_PATTERN.test(name)) return yield* badName()
      const found = yield* saved(scope, name, where)
      if (!found) return yield* missing("SKILL_NOT_FOUND", "That skill is no longer there.")
      const root = SkillManage.scopeRoot(scope, where)
      const base = SkillManage.archiveBase(scope, where)
      const folder = path.dirname(found.location)
      // Recorded before the move, so the record never says less than was moved.
      yield* Effect.tryPromise({
        try: () => SkillManage.recordApproval({ action: "delete", scope, name, path: relative(root, found.location) }),
        catch: () => new HttpApiError.InternalServerError({}),
      })
      const moved = yield* Effect.promise(() => Archive.move({ directory: base, paths: [path.relative(base, folder)] }))
      if (!moved.ok || moved.moved.length === 0)
        return yield* archiveFailed("The skill could not be moved to the archive, so nothing was deleted.")
      yield* dropNote(name, found.location, where)
      const baseReal = yield* Effect.promise(() => fs.realpath(base).catch(() => base))
      const rootReal = yield* Effect.promise(() => fs.realpath(root).catch(() => root))
      return { archive: relative(rootReal, path.join(baseReal, Archive.ARCHIVE_DIR, moved.id)) }
    })

    const drafts = Effect.fn("SkillHttpApi.drafts")(function* () {
      const where = yield* place()
      const list = yield* Effect.promise(() => SkillManage.readDrafts(where))
      const all = yield* skill.all()
      return list.map((draft) => {
        const root = SkillManage.scopeRoot(draft.scope, where)
        return {
          ...draft,
          replaces: all.some((info) => info.name === draft.name && SkillManage.savedIn(info.location, root)),
        }
      })
    })

    const draftApprove = Effect.fn("SkillHttpApi.draftApprove")(function* (ctx: {
      params: { name: string }
      headers: DesktopNonceHeaders
      payload: { scope: WriteScope; acceptCommands?: boolean }
    }) {
      yield* personOnly(ctx.headers)
      const where = yield* place()
      const { name } = ctx.params
      const { scope } = ctx.payload
      if (!Skill.SKILL_NAME_PATTERN.test(name)) return yield* badName()
      const draft = yield* Effect.promise(() => SkillManage.readDraft(scope, name, where))
      if (!draft) return yield* missing("SKILL_DRAFT_MISSING", "That draft is no longer there.")
      // The person was shown "replaces" (RA-13): approving overwrites the saved skill of that name.
      const current = yield* saved(scope, name, where)
      const baseHash = current
        ? yield* Effect.promise(() => fs.readFile(current.location).then(SkillManage.hashOf, () => undefined))
        : undefined
      const done = yield* write({
        scope,
        name,
        content: draft.content,
        baseHash,
        action: "approve",
        draft,
        where,
        acceptCommands: ctx.payload.acceptCommands,
      })
      yield* Effect.promise(() => SkillManage.removeDraft(scope, name, where))
      // SR8-09 (R20-C12): an approved draft was written by an agent; its note says so and keeps the draft's flag.
      const result = yield* note({
        name,
        scope,
        location: done.location,
        description: done.checked.description,
        triggers: done.checked.triggers,
        source: "agent",
        untrusted: draft.untrusted,
        where,
      })
      return { location: done.location, hash: done.hash, note: result }
    })

    const draftDiscard = Effect.fn("SkillHttpApi.draftDiscard")(function* (ctx: {
      params: { name: string }
      headers: DesktopNonceHeaders
      query: { scope: WriteScope }
    }) {
      yield* personOnly(ctx.headers)
      const where = yield* place()
      const { name } = ctx.params
      if (!Skill.SKILL_NAME_PATTERN.test(name)) return yield* badName()
      const draft = yield* Effect.promise(() => SkillManage.readDraft(ctx.query.scope, name, where))
      if (!draft) return yield* missing("SKILL_DRAFT_MISSING", "That draft is no longer there.")
      yield* Effect.promise(() => SkillManage.removeDraft(ctx.query.scope, name, where))
      return { removed: true as const }
    })

    return handlers
      .handle("source", source)
      .handle("save", save)
      .handle("delete", remove)
      .handle("drafts", drafts)
      .handle("draftApprove", draftApprove)
      .handle("draftDiscard", draftDiscard)
  }),
)
