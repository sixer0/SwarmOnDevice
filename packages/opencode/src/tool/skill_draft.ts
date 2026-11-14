// 1.2.8 SK-d2 (AC-SKd2, 01b section 6): agents propose skills as drafts. A draft lands in a `skill-drafts` folder that
// discovery never reads (N8-044), so it is inert until the person approves it in Settings > Skills. The tool takes a
// name, never a path, and checks the draft at write time with the validator the skill routes use (SkillManage, 01b
// section 5.1 steps 1-6 and 8; step 7, a skill that runs commands, is reported as `runsCommands`, not refused: the
// person decides at approval, which re-runs it).
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./skill_draft.txt"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SKILL_DRAFTS_MAX, SKILL_NAME_PATTERN } from "@/skill"
import { SkillManage } from "@/skill/manage"
import { loadTaskChildren, readUntrustedInput } from "./remember"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description:
      "The skill name: lower-case letters, digits and hyphens, at most 64 characters, equal to the frontmatter name",
  }),
  scope: Schema.Literals(["global", "project"]).annotate({
    description: '"project" for this project only, "global" for every project',
  }),
  content: Schema.String.annotate({
    description: "The full SKILL.md text: frontmatter (name, one-line description, optional triggers) and instructions",
  }),
})

/** RA-7: the tool-only refusal when a scope already holds SKILL_DRAFTS_MAX drafts. */
export const SKILL_DRAFTS_FULL = "SKILL_DRAFTS_FULL" as const

type Metadata = {
  name: string
  scope: SkillManage.WriteScope
  refused?: string
  untrusted?: boolean
  runsCommands?: boolean
  replaced?: boolean
}

/** 01b section 5.3 (RA-8): what `draft.json` holds beside the draft's SKILL.md. */
export type DraftRecord = { sessionID?: string; time: number; untrusted: boolean; runsCommands: boolean }

const IGNORE = "*\n"

/** Agent-facing texts for the refusals the validator does not word: the code, the rule and the next step. */
export const REFUSED = {
  [SKILL_DRAFTS_FULL]: `${SKILL_DRAFTS_FULL}: ${SKILL_DRAFTS_MAX} drafts are already waiting in this scope; ask the person to approve or discard some first.`,
  [SkillManage.SKILL_PATH_UNSAFE]: `${SkillManage.SKILL_PATH_UNSAFE}: the drafts folder is a link or leads outside its place, so nothing was written. Tell the person.`,
}

/** The folder whose real path every draft path must stay inside: the data folder, or the project's `.swarm`. */
const scopeBase = (scope: SkillManage.WriteScope, place: SkillManage.Place) =>
  path.dirname(SkillManage.draftsRoot(scope, place))

/**
 * Step 8 and the write: no link from the scope base down to the draft's files, and the real path of each lies inside
 * the scope base (SkillManage.pathSafe, checked again before each file). The cap (RA-9) counts the other drafts of the
 * scope. Returns the refusal code, or whether an earlier draft of this name was replaced.
 */
async function writeDraft(input: {
  scope: SkillManage.WriteScope
  place: SkillManage.Place
  name: string
  content: string
  record: DraftRecord
}): Promise<{ refused: keyof typeof REFUSED } | { replaced: boolean }> {
  const unsafe = { refused: SkillManage.SKILL_PATH_UNSAFE } as const
  const base = scopeBase(input.scope, input.place)
  const root = SkillManage.draftsRoot(input.scope, input.place)
  const folder = path.join(root, input.name)
  const files = [path.join(folder, "SKILL.md"), path.join(folder, SkillManage.DRAFT_FILE)]
  await fs.mkdir(base, { recursive: true })
  for (const file of files) if (!(await SkillManage.pathSafe(base, file))) return unsafe

  const existing = await fs.lstat(folder).catch(() => undefined)
  if (!existing) {
    const others = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    if (others.filter((entry) => entry.isDirectory() && SKILL_NAME_PATTERN.test(entry.name)).length >= SKILL_DRAFTS_MAX)
      return { refused: SKILL_DRAFTS_FULL } as const
  }
  await fs.mkdir(folder, { recursive: true })
  // The project drafts folder keeps its own `.gitignore` of `*`, as the archive does (01b section 5.3).
  if (input.scope === "project")
    await fs.writeFile(path.join(root, ".gitignore"), IGNORE, { flag: "wx" }).catch(() => undefined)
  const texts = [input.content, JSON.stringify(input.record, null, 2) + "\n"]
  for (const [index, file] of files.entries()) {
    if (!(await SkillManage.pathSafe(base, file))) return unsafe
    await SkillManage.writeAtomic(file, texts[index]!)
  }
  return { replaced: !!existing }
}

// One draft write at a time in this process, so two calls cannot both pass the cap.
const lock = Semaphore.makeUnsafe(1)

export const SkillDraftTool = Tool.define<typeof Parameters, Metadata, never>(
  "skill_draft",
  Effect.gen(function* () {
    // Optional so a tool built without sessions (tests) still works: a subagent it cannot read then counts as untrusted.
    const sessions = yield* Effect.serviceOption(Session.Service)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // No permission prompt, as `remember`: a draft is inert (never discovered, never loaded) and only the person
          // turns it into a skill. `"skill_draft": "deny"` hides the tool.
          const base = { name: params.name, scope: params.scope }
          const refuse = (code: string, output: string) => ({
            title: "Draft not saved",
            output,
            metadata: { ...base, refused: code },
          })
          // `trusted: true`: step 7 (commands in an untrusted project) is reported as runsCommands, never refused here.
          const checked = SkillManage.validate({ ...base, content: params.content, trusted: true })
          if (!checked.ok) return refuse(checked.code, `${checked.code}: ${checked.message} Nothing was written.`)

          const instance = yield* InstanceState.context
          // SR8-06: web, MCP or Studio input, outside files, a loopback transcript read, or a subagent that consumed any
          // of these (read through `loadTaskChildren`, depth UNTRUSTED_TASK_DEPTH) mark the draft untrusted.
          const children = yield* loadTaskChildren(ctx.messages, (sessionID) =>
            Option.isSome(sessions)
              ? sessions.value.messages({ sessionID: SessionID.make(sessionID) })
              : Effect.fail(new Error("no sessions")),
          )
          const untrusted = readUntrustedInput(
            ctx.messages,
            { root: SkillManage.projectRoot(instance), directory: instance.directory },
            (sessionID) => children.get(sessionID),
          )
          const runsCommands = checked.runsCommands
          const result = yield* lock.withPermits(1)(
            Effect.tryPromise({
              try: () =>
                writeDraft({
                  scope: params.scope,
                  place: { directory: instance.directory, worktree: instance.worktree },
                  name: params.name,
                  content: params.content,
                  record: { sessionID: ctx.sessionID, time: Date.now(), untrusted, runsCommands },
                }),
              catch: (error) => error,
            }).pipe(
              // Logged with the name and scope only, never the content; the agent gets the path refusal.
              Effect.catch((error) =>
                Effect.logError("skill draft write failed", {
                  name: params.name,
                  scope: params.scope,
                  error: error instanceof Error ? error.message : String(error),
                }).pipe(Effect.as({ refused: SkillManage.SKILL_PATH_UNSAFE } as const)),
              ),
            ),
          )
          if ("refused" in result) return refuse(result.refused, REFUSED[result.refused])
          return {
            title: `Drafted skill ${params.name}`,
            output: `Draft "${params.name}" saved for the person's approval in Settings > Skills (${params.scope}). It is not loaded or offered until the person approves it. Tell the person it is waiting.`,
            metadata: { ...base, untrusted, runsCommands, replaced: result.replaced },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
