import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { followedByEdit, lock, trimDiff } from "./edit"
import { FileSeen } from "./file-seen"
import { Secrets } from "./secrets"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Reach } from "./reach"
import * as Bom from "@/util/bom"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          // 1.1.1 F25 (CR11-3): the file is written at its tidied path, and judged both there and where the path as given
          // lands (`Reach.fileTarget`): through a link and `..` that is beside the link's target, which asks as any path
          // outside the project does.
          const target = Reach.fileTarget(params.filePath, instance.directory)
          const filepath = target.written
          const label = path.relative(instance.worktree, filepath)
          if (target.landing === undefined) throw new Error(`Cannot resolve ${label}: a link on the way loops`)
          yield* assertExternalDirectoryEffect(followedByEdit(ctx, [label]), filepath)
          if (target.landing !== filepath) yield* assertExternalDirectoryEffect(followedByEdit(ctx, [label]), target.landing)

          const exists = yield* fs.existsSafe(filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          Secrets.assertNoPlaceholder(contentNew, contentOld, label)
          const trust = yield* Reach.editTrust(ctx, instance, [filepath])
          yield* ctx.ask({
            permission: "edit",
            patterns: [label],
            always: trust.risk ? [] : ["*"],
            metadata: {
              filepath,
              diff,
              ...(trust.risk ? { risk: trust.risk } : {}),
            },
            harmless: trust.harmless,
            editClass: trust.editClass,
          })

          // Two agents may be here at once, and an answer to the prompt above may have taken a while.
          const merged = yield* lock(filepath).withPermits(1)(
            Effect.gen(function* () {
              const current = (yield* fs.existsSafe(filepath)) ? (yield* Bom.readFile(fs, filepath)).text : undefined
              const decision = FileSeen.decide({ session: ctx.sessionID, file: filepath, label, current, next: contentNew })
              if ("refused" in decision) throw new Error(Secrets.scrub(decision.refused, instance.worktree))
              yield* fs.writeWithDirs(filepath, Bom.join(decision.text, desiredBom))
              const final = (yield* format.file(filepath)) ? yield* Bom.syncFile(fs, filepath, desiredBom) : decision.text
              FileSeen.wrote(ctx.sessionID, filepath, final)
              return decision.merged
            }),
          )
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          if (merged) output += ` ${FileSeen.MERGED_NOTE}`
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
