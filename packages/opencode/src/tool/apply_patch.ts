import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Reach } from "./reach"
import { lock, trimDiff } from "./edit"
import { FileSeen } from "./file-seen"
import { Secrets } from "./secrets"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context

      // Each section is worked out from what is on disk now, so a second section for the same file would replace the first.
      const named = (name: string) => FSUtil.resolve(path.resolve(instance.directory, name))
      const sections = hunks.map((hunk) => [
        ...new Set([hunk.path, ...(hunk.type === "update" && hunk.move_path ? [hunk.move_path] : [])].map(named)),
      ])
      const repeated = sections
        .flat()
        .find((name, index, all) => all.indexOf(name) !== index)
      if (repeated) {
        return yield* Effect.fail(
          new Error(
            `apply_patch verification failed: ${path.relative(instance.worktree, repeated)} is named by more than one section. Nothing was written. Put all changes to one file in one section, as several @@ chunks.`,
          ),
        )
      }

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
        /** What was at the destination when the patch was worked out: it may be overwritten, but only as it was then. */
        replaces?: string
      }> = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))
            const replaces = (yield* afs.existsSafe(filePath)) ? (yield* Bom.readFile(afs, filePath)).text : undefined

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
              replaces,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            const source = yield* Bom.readFile(afs, filePath)
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(
                filePath,
                hunk.chunks,
                Bom.join(source.text, source.bom),
              )
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)
            const replaces =
              movePath && (yield* afs.existsSafe(movePath)) ? (yield* Bom.readFile(afs, movePath)).text : undefined

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
              replaces,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const source = yield* Bom.readFile(afs, filePath).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const contentToDelete = source.text
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        ...(change.movePath ? { movePath: change.movePath } : {}),
      }))

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        Secrets.assertNoPlaceholder(
          change.newContent,
          change.oldContent,
          path.relative(instance.worktree, change.filePath),
        )
      }

      // Check permissions if needed. Where a move lands is what it changes, so it is judged and shown as well.
      const touched = fileChanges.flatMap((c) => (c.movePath ? [c.filePath, c.movePath] : [c.filePath]))
      const relativePaths = touched.map((file) => path.relative(instance.worktree, file).replaceAll("\\", "/"))
      const trust = yield* Reach.editTrust(ctx, instance, touched)
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: trust.risk ? [] : ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
          ...(trust.risk ? { risk: trust.risk } : {}),
        },
        harmless: trust.harmless,
      })

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
      const label = (file: string) => path.relative(instance.worktree, file).replaceAll("\\", "/")
      const redo = (file: string) =>
        new Error(`apply_patch: ${label(file)} changed while this patch waited. Nothing was written. Read it again and redo the patch.`)
      const current = (file: string) =>
        Effect.gen(function* () {
          return (yield* afs.existsSafe(file)) ? (yield* Bom.readFile(afs, file)).text : undefined
        })

      // The patch was worked out before the prompt. Whatever landed since then has to survive this, and a patch applies
      // whole or not at all, so everything is checked before the first write.
      const apply = Effect.gen(function* () {
        const planned: Array<{ change: (typeof fileChanges)[number]; text: string }> = []
        for (const change of fileChanges) {
          const now = yield* current(change.filePath)
          if (change.type === "add") {
            if (now !== change.replaces) return yield* Effect.fail(redo(change.filePath))
            planned.push({ change, text: change.newContent })
            continue
          }
          if (now === undefined) return yield* Effect.fail(redo(change.filePath))
          if (change.type === "delete") {
            if (now !== change.oldContent) return yield* Effect.fail(redo(change.filePath))
            planned.push({ change, text: "" })
            continue
          }
          if (change.movePath && (yield* current(change.movePath)) !== change.replaces)
            return yield* Effect.fail(redo(change.movePath))
          const text = now === change.oldContent ? change.newContent : FileSeen.merge(change.oldContent, change.newContent, now)
          if (text === undefined) return yield* Effect.fail(redo(change.filePath))
          planned.push({ change, text })
        }

        const written: string[] = []
        for (const { change, text } of planned) {
          const target = change.movePath ?? change.filePath
          yield* Effect.gen(function* () {
            if (change.type === "delete") {
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              written.push(change.filePath)
              return
            }
            yield* afs.writeWithDirs(target, Bom.join(text, change.bom))
            // Onto itself, or onto its own name in another case, the file just written is the one this would remove.
            if (change.type === "move" && FSUtil.resolve(target) !== FSUtil.resolve(change.filePath)) {
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: target, event: "add" })
            }
            if (change.type === "add") updates.push({ file: target, event: "add" })
            if (change.type === "update") updates.push({ file: target, event: "change" })
            written.push(target)
            // Inside the lock and after the formatter, so that what is remembered is what is on disk.
            const final = (yield* format.file(target)) ? yield* Bom.syncFile(afs, target, change.bom) : text
            FileSeen.wrote(ctx.sessionID, target, final)
          }).pipe(
            Effect.mapError(
              (error) =>
                new Error(
                  `apply_patch: could not finish at ${label(target)}: ${error instanceof Error ? error.message : String(error)}. ${written.length ? `Already written: ${written.map(label).join(", ")}.` : "Nothing was written."} Read them before retrying.`,
                ),
            ),
          )
        }
      })
      // In one order everywhere, so that two patches over the same files cannot each hold what the other waits for.
      // Keyed the way `lock` keys them: a file and a link to it, or a rename that only changes case, are one lock.
      yield* [...new Set(touched.map((file) => FSUtil.resolve(file)))]
        .sort()
        .reduce<Effect.Effect<void, Error>>((inner, file) => lock(file).withPermits(1)(inner), apply)

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        yield* events.publish(FileSystem.Event.Edited, { file: change.movePath ?? change.filePath })
      }

      // Publish file change events
      for (const update of updates) {
        yield* events.publish(Watcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
