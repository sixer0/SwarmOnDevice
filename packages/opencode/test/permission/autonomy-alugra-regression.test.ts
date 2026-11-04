// Row 200 (U11): the 29 decisions of the user's alugra run (test/05_alugra_session_evidence.md:52-80), replayed through the
// real gate, the real table and the real tools, with autonomous mode on. Only the decider (it counts its calls) and the
// network (an MCP server is not started: its prompt is sent as `session/tools.ts` sends it) are stand-ins. Every name and
// file here is made up; the shapes are the run's: a session folder that is no repository with repositories below it, three
// subagents in the same folder, patterns relative to `/`, an `ls` with a `workdir`, a `wc` whose command outgrows the audit.
//
// In that run all 29 waited for a person, about 57 minutes in all. The person's question was why a read or a write in the
// project folder needs an approval at all. The hard line here: none of them, and none of the other in-folder reads and
// writes below, is class D.

import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { loopbackServer } from "./loopback-server"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceState } from "../../src/effect/instance-state"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Autonomy } from "../../src/permission/autonomy"
import { Plugin } from "../../src/plugin/index"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { Instruction } from "../../src/session/instruction"
import { LateAnswer } from "../../src/session/late-answer"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import type { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { QuestionTool } from "../../src/tool/question"
import { ReadTool } from "../../src/tool/read"
import { ToolRegistry } from "../../src/tool/registry"
import { ShellTool } from "../../src/tool/shell"
import type * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { SessionApi } from "../../src/server/routes/instance/httpapi/groups/session"
import { sessionHandlers } from "../../src/server/routes/instance/httpapi/handlers/session"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { ServerAuth } from "../../src/server/auth"
import { SessionShare } from "../../src/share/session"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Todo } from "../../src/session/todo"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const counted = { calls: 0 }
// Each test counts its own decider calls: a P call one test makes legitimately must not show up in the next one's count.
beforeEach(() => {
  counted.calls = 0
})
const countingDecider = Layer.succeed(
  Permission.Decider,
  Permission.Decider.of({
    decide: () =>
      Effect.sync(() => {
        counted.calls++
        return { decision: "allow" as const, decidedBy: "agent:test/stub" }
      }),
  }),
)
const gate = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ToolRegistry.node, Agent.node, Permission.node, Session.node, Autonomy.node, Plugin.node, MCP.node, Truncate.node,
      RuntimeFlags.node, EventV2Bridge.node, SessionProjector.node, CrossSpawnSpawner.node, InstanceStore.node, Question.node,
      FSUtil.node, Config.node, LSP.node, Format.node, Instruction.node, Ripgrep.node,
    ]),
    [
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
      [Permission.deciderNode, countingDecider],
    ],
  ),
)

/** What the root would be woken with. Nothing else of a model turn is needed: an approved call runs without one (E1). */
const sent: { sessionID: string; text: string }[] = []
const lateAnswers = LateAnswer.make.pipe(
  Effect.provideService(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      prompt: (input: SessionPrompt.PromptInput) =>
        Effect.sync(() => {
          const part = input.parts[0]
          sent.push({ sessionID: input.sessionID, text: part?.type === "text" ? part.text : "" })
          return {} as never
        }),
    } as unknown as SessionPrompt.Interface),
  ),
)

// Only around the file: removing `mode.json` while the service runs reads as a change from outside, which holds every P.
const cleanState = () => fs.rmSync(path.join(Global.Path.state, "autonomy"), { recursive: true, force: true })

// Beyond the project: a made-up home with the two places the run looked at. Nothing of the real home is read.
let away: string
const agentsDir = () => path.join(away, ".claude/agents")
const awsConfig = () => path.join(away, ".aws/config")
const AWS_MARK = "region = synthetic-1"
beforeAll(() => {
  cleanState()
  away = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alugra-away-")))
  fs.mkdirSync(agentsDir(), { recursive: true })
  fs.writeFileSync(path.join(agentsDir(), "alpha-agent.md"), "# synthetic agent\n")
  fs.mkdirSync(path.dirname(awsConfig()), { recursive: true })
  fs.writeFileSync(awsConfig(), `[default]\n${AWS_MARK}\n`)
})
afterAll(() => {
  cleanState()
  fs.rmSync(away, { recursive: true, force: true })
})

// The session folder as it was: a task folder in a repository of its own below the session folder, a second repository
// inside that, and the files the subagents counted.
const TASK = "alugra/docs/2026-11-02_synthetic_task"
const EARLIER = "alugra/docs/2026-10-30_synthetic_earlier"
const SERVER_FILES = Array.from({ length: 14 }, (_, index) => `alugra/prototype/server/synthetic-module-${index + 1}.ts`)
const layout = (directory: string) =>
  Effect.promise(async () => {
    // The fixture sets core.fsmonitor and commit.gpgsign to keep git quiet, and `GitGuard` refuses a repository that sets
    // either (C94). The user's repositories set neither, so the folder with git is put back to what `git init` writes.
    if (fs.existsSync(path.join(directory, ".git")))
      await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(directory).quiet()
    for (const folder of [`${TASK}/identification`, `${EARLIER}/report`, `${EARLIER}/masterplan`, "alugra/prototype/shared", "alugra/prototype/server", "alugra/prototype/src", "alugra/prototype/tests"])
      fs.mkdirSync(path.join(directory, folder), { recursive: true })
    for (const file of [`${EARLIER}/report/report.md`, `${EARLIER}/masterplan/review_notes.md`, `${TASK}/README.md`, ...SERVER_FILES])
      fs.writeFileSync(path.join(directory, file), "synthetic\n")
    await $`git init -q`.cwd(path.join(directory, "alugra")).quiet()
    await $`git init -q`.cwd(path.join(directory, "alugra/prototype")).quiet()
  })

const PASSED = new Error("past the gate")
type Who = "root" | "sub1" | "sub2" | "sub3"

/**
 * A tool context as `session/tools.ts` builds it: the agent's own rules, the session's Undo, and the real gate. A command
 * is stopped once the gate has let it through, so the replay judges commands without running them; every other tool runs.
 */
const contextFor = (sessionID: SessionID, agentName: string, canUndo: boolean) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const agent = (yield* (yield* Agent.Service).get(agentName))!
    let calls = 0
    return {
      sessionID,
      messageID: MessageID.ascending(),
      get callID() {
        return `call_alugra_${sessionID.slice(-6)}_${++calls}`
      },
      agent: agentName,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      trust: { canUndo },
      ask: ({ planLimited: _planLimited, ...request }: Parameters<Tool.Context["ask"]>[0]) =>
        permission
          .ask({ ...request, sessionID, agent: agentName, canUndo, ruleset: agent.permission })
          .pipe(Effect.orDie, Effect.tap(() => (request.permission === "bash" ? Effect.die(PASSED) : Effect.void))),
    } as unknown as Tool.Context
  })

const attempt = <E, R>(self: Effect.Effect<unknown, E, R>) =>
  self.pipe(
    Effect.timeout("20 seconds"),
    Effect.exit,
    Effect.map((exit) => {
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      return error === undefined || error === PASSED ? "ran" : error instanceof PermissionV1.DeferredError ? "held" : String(error)
    }),
  )

// `graft` as the user's global config has it: a local server, so its tools are U11 rule 5's.
const GRAFT = { server: "graft", transport: "local", origin: "global" }

/** The person's message before the mode came on, so the mission (and the consent scan) is the one the run had. */
const missionMessage = (root: SessionID, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: root,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({ id: PartID.ascending(), messageID: message.id, sessionID: root, type: "text", text })
  })

/** Root with the mode on, three `general` subagents in the same folder, and a context for each, as in the run. */
const family = (canUndo: boolean, mission: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const autonomy = yield* Autonomy.Service
    const root = yield* sessions.create({})
    yield* missionMessage(root.id, mission)
    yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
    yield* autonomy.markMode({ root: root.id, directory: (yield* sessions.get(root.id)).directory })
    const subs = [yield* sessions.create({ parentID: root.id }), yield* sessions.create({ parentID: root.id }), yield* sessions.create({ parentID: root.id })]
    const ctx: Record<Who, Tool.Context> = {
      root: yield* contextFor(root.id, "build", canUndo),
      sub1: yield* contextFor(subs[0]!.id, "general", canUndo),
      sub2: yield* contextFor(subs[1]!.id, "general", canUndo),
      sub3: yield* contextFor(subs[2]!.id, "general", canUndo),
    }
    return { root: root.id, subs: subs.map((item) => item.id), ctx }
  })

const decisions = (root: SessionID) =>
  Effect.gen(function* () {
    const autonomy = yield* Autonomy.Service
    return (yield* autonomy.readAudit(root)).lines.flatMap((line) =>
      line.type === "decision" && line.permission !== "autonomy_consent" ? [line] : [],
    )
  })
type Line = Effect.Success<ReturnType<typeof decisions>>[number]

const RANK = { A: 0, P: 1, B: 2, D: 3, X: 4 } as const
/** The class a call ended in: the strictest of the lines it left. */
const finalClass = (lines: Line[]) =>
  lines.reduce<keyof typeof RANK | "none">((worst, line) => (worst === "none" || RANK[line.class] > RANK[worst] ? line.class : worst), "none")

type Group = "outside" | "look" | "edit" | "mcp" | "question"
/** The 29 rows of the evidence, in its order. `before` is what the run's audit said, `waited` its seconds. */
const EVIDENCE: { no: number; who: Who; tool: string; before: string; waited: number; group: Group }[] = [
  { no: 1, who: "root", tool: "bash ls <home>/.claude/agents", before: "D not_routine", waited: 15, group: "outside" },
  { no: 2, who: "root", tool: "bash ls -la <sesi>/alugra/prototype", before: "D not_routine", waited: 16, group: "look" },
  { no: 3, who: "root", tool: "read <home>/.claude/agents/*", before: "D outside_folder", waited: 15, group: "outside" },
  { no: 4, who: "root", tool: "write identification/01_original.md", before: "D no_undo", waited: 7, group: "edit" },
  { no: 5, who: "root", tool: "write README.md", before: "D no_undo", waited: 6, group: "edit" },
  { no: 6, who: "root", tool: "write identification/01_original.md", before: "D no_undo", waited: 16, group: "edit" },
  { no: 7, who: "root", tool: "write README.md", before: "D no_undo", waited: 7, group: "edit" },
  { no: 8, who: "root", tool: "read <home>/.claude/agents/*", before: "D outside_folder", waited: 2, group: "outside" },
  { no: 9, who: "root", tool: "write status_tasks.md", before: "D no_undo", waited: 10, group: "edit" },
  { no: 10, who: "sub1", tool: "read <home>/.claude/agents/*", before: "D outside_folder", waited: 16, group: "outside" },
  { no: 11, who: "sub1", tool: "bash rtk wc -l report.md review_notes.md", before: "D not_routine", waited: 52, group: "look" },
  { no: 12, who: "sub1", tool: "graft_graft_find_code *", before: "D external_tool", waited: 47, group: "mcp" },
  { no: 13, who: "sub1", tool: "write identification/01_translated.md", before: "D no_undo", waited: 446, group: "edit" },
  { no: 14, who: "root", tool: "write status_tasks.md", before: "D no_undo", waited: 434, group: "edit" },
  { no: 15, who: "root", tool: "question (5 questions)", before: "A asumsi agen (left open)", waited: 0, group: "question" },
  { no: 16, who: "sub1", tool: "read <home>/.claude/agents/*", before: "D outside_folder", waited: 396, group: "outside" },
  { no: 17, who: "sub1", tool: "write identification/01_translated.md", before: "D no_undo", waited: 350, group: "edit" },
  { no: 18, who: "root", tool: "write identification/01_translated.md", before: "D no_undo", waited: 287, group: "edit" },
  { no: 19, who: "root", tool: "read <home>/.claude/agents/*", before: "D outside_folder", waited: 273, group: "outside" },
  { no: 20, who: "sub2", tool: "bash rtk ls -la shared server src", before: "D not_routine", waited: 216, group: "look" },
  { no: 21, who: "sub2", tool: "graft_graft_file_api *", before: "D external_tool", waited: 209, group: "mcp" },
  { no: 22, who: "sub2", tool: "graft_graft_file_api *", before: "D external_tool", waited: 209, group: "mcp" },
  { no: 23, who: "sub2", tool: "bash wc -l <14 server files> (patterns truncated)", before: "D not_routine", waited: 205, group: "look" },
  { no: 24, who: "sub2", tool: "write identification/02_structured.md", before: "D no_undo", waited: 24, group: "edit" },
  { no: 25, who: "root", tool: "write identification/02_structured.md", before: "D no_undo", waited: 16, group: "edit" },
  { no: 26, who: "root", tool: "write status_tasks.md", before: "D no_undo", waited: 12, group: "edit" },
  { no: 27, who: "root", tool: "write status_tasks.md", before: "D no_undo", waited: 108, group: "edit" },
  { no: 28, who: "sub3", tool: "graft_graft_file_api *", before: "D external_tool", waited: 29, group: "mcp" },
  { no: 29, who: "sub3", tool: "bash ls prototype/tests (workdir alugra)", before: "D not_routine", waited: 5, group: "look" },
]

/** What each row must end in under U11 (03_structured_u11.md section 4). */
const EXPECTED: Record<Group, { class: "A"; category?: string }> = {
  outside: { class: "A", category: "outside_read" },
  look: { class: "A" },
  edit: { class: "A" },
  mcp: { class: "A", category: "mcp_tool" },
  question: { class: "A" },
}

const QUESTIONS = Array.from({ length: 5 }, (_, index) => ({
  question: `Synthetic choice ${index + 1}?`,
  header: `Choice ${index + 1}`,
  options: Array.from({ length: [5, 3, 3, 3, 4][index]! }, (_, option) => ({ label: `Option ${option + 1}`, description: "" })),
}))

/** The call each evidence row stands for, as the tool or the server would send it. */
const callOf = (
  no: number,
  ctx: Tool.Context,
  directory: string,
  tools: {
    write: Tool.Def
    read: Tool.Def
    shell: Tool.Def
    question: Tool.Def
  },
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const agents = yield* Agent.Service
    const rules = (yield* agents.get(ctx.agent))!.permission
    const task = (name: string) => path.join(directory, TASK, name)
    const content = `synthetic content of row ${no}\n`
    // What `session/tools.ts:476-481` sends for an MCP tool. The server itself is the network, and is not started.
    const mcp = (name: string) =>
      permission
        .ask({
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          canUndo: ctx.trust?.canUndo ?? false,
          ruleset: rules,
          permission: name,
          patterns: ["*"],
          always: ["*"],
          metadata: { mcp: GRAFT },
          call: { tool: name, args: { query: `synthetic ${no}` } },
        } as PermissionV1.AskInput)
        .pipe(Effect.orDie)
    const write = (name: string) => tools.write.execute({ filePath: task(name), content }, ctx)
    // The write tool will not overwrite what another agent of the family wrote since this one last read it, so an agent
    // reads first. A read of an ordinary file in the folder asks nobody, so the row still leaves one line, the write's.
    const readThenWrite = (name: string) => tools.read.execute({ filePath: task(name) }, ctx).pipe(Effect.andThen(write(name)))
    const look = () => tools.read.execute({ filePath: path.join(agentsDir(), "alpha-agent.md") }, ctx)
    const shell = (command: string, workdir?: string) => tools.shell.execute({ command, ...(workdir && { workdir }) }, ctx)
    const at = (relative: string) => path.join(directory, relative)
    switch (no) {
      case 1:
        return yield* shell(`ls ${agentsDir()}`)
      case 2:
        return yield* shell(`ls -la ${at("alugra/prototype")}`)
      case 4:
      case 6:
        return yield* write("identification/01_original.md")
      case 5:
      case 7:
        return yield* write("README.md")
      case 9:
      case 14:
      case 26:
      case 27:
        return yield* write("status_tasks.md")
      case 11:
        return yield* shell(`rtk wc -l "${at(`${EARLIER}/report/report.md`)}" "${at(`${EARLIER}/masterplan/review_notes.md`)}"`)
      case 12:
        return yield* mcp("graft_graft_find_code")
      case 13:
      case 17:
        return yield* write("identification/01_translated.md")
      case 18:
        return yield* readThenWrite("identification/01_translated.md")
      case 15:
        return yield* tools.question.execute({ questions: QUESTIONS }, ctx)
      case 20:
        return yield* shell(`rtk ls -la ${at("alugra/prototype/shared")} ${at("alugra/prototype/server")} ${at("alugra/prototype/src")}`)
      case 21:
      case 22:
      case 28:
        return yield* mcp("graft_graft_file_api")
      case 23:
        return yield* shell(`wc -l ${SERVER_FILES.map(at).join(" ")}`)
      case 24:
        return yield* write("identification/02_structured.md")
      case 25:
        return yield* readThenWrite("identification/02_structured.md")
      case 29:
        return yield* shell("ls prototype/tests", at("alugra"))
      default:
        // 3, 8, 10, 16, 19: the read tool on a file in the folder beyond the project.
        return yield* look()
    }
  })

const toolsOf = Effect.gen(function* () {
  return {
    write: yield* (yield* WriteTool).init(),
    read: yield* (yield* ReadTool).init(),
    shell: yield* (yield* ShellTool).init(),
    question: yield* (yield* QuestionTool).init(),
  } as unknown as { write: Tool.Def; read: Tool.Def; shell: Tool.Def; question: Tool.Def }
})

/** Runs one call and returns what it left: its outcome and the decision lines it wrote. */
const replay = <E, R>(root: SessionID, run: Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    const before = (yield* decisions(root)).length
    const result = yield* attempt(run)
    return { result, lines: (yield* decisions(root)).slice(before) }
  })

/** Everything a person would find waiting for this family: held entries, open questions, open audit decisions. */
const waitingFor = (root: SessionID, family: SessionID[]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const question = yield* Question.Service
    const autonomy = yield* Autonomy.Service
    return {
      held: (yield* permission.list()).filter((item) => family.includes(item.sessionID)),
      questions: (yield* question.list()).filter((item) => family.includes(item.sessionID)),
      open: (yield* autonomy.openDecisions()).filter((line) => line.rootID === root),
    }
  })

const FOLDERS = [
  { name: "no git (the user's folder: worktree `/`, nested repositories)", git: false },
  { name: "with git", git: true },
] as const

// Printed so the report can quote what the run measured rather than what the test expects.
const report = (label: string, value: unknown) => console.log(`[row200] ${label}: ${JSON.stringify(value)}`)

describe("alugra: the 29 decisions, replayed through the gate", () => {
  for (const folder of FOLDERS)
    gate.instance(
      `${folder.name}: all 29 end in class A, no decider call, nothing waits, and no in-folder read or write is D`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const canUndo = folder.git
          expect((yield* InstanceState.context).worktree).toBe(folder.git ? test.directory : "/")
          expect(EVIDENCE.map((row) => row.no)).toEqual(Array.from({ length: 29 }, (_, index) => index + 1))
          expect(EVIDENCE.reduce((sum, row) => sum + row.waited, 0)).toBe(3428)

          const { root, subs, ctx } = yield* family(canUndo, "Implement the synthetic revision in the prototype under alugra")
          const tools = yield* toolsOf
          counted.calls = 0
          const rows: { no: number; result: string; lines: Line[] }[] = []
          for (const row of EVIDENCE) {
            const one = yield* replay(root, callOf(row.no, ctx[row.who], test.directory, tools))
            rows.push({ no: row.no, ...one })
          }
          report(
            `${folder.git ? "git" : "nogit"} final`,
            rows.map((row) => [row.no, row.result, finalClass(row.lines), row.lines.map((line) => [line.permission, line.class, line.category, line.decision, line.canUndo])]),
          )

          // Every row is checked and every miss listed, so one failing row does not hide the others.
          const misses = rows.flatMap((row) => {
            const evidence = EVIDENCE[row.no - 1]!
            const expected = EXPECTED[evidence.group]
            const line = row.lines[0]
            const got = {
              result: row.result,
              // Exactly one line per call that left `ask` (E2), the question's skip line included.
              lines: row.lines.length,
              class: finalClass(row.lines),
              category: expected.category ? line?.category : undefined,
              decision: line?.decision,
              ...(evidence.group === "edit" && { canUndo: line?.canUndo }),
              ...(evidence.group === "question" && { reason: line?.reason }),
            }
            const want = {
              result: "ran",
              lines: 1,
              class: expected.class,
              category: expected.category,
              decision: evidence.group === "question" ? "defer" : "allow",
              ...(evidence.group === "edit" && { canUndo }),
              ...(evidence.group === "question" && { reason: "asumsi agen" }),
            }
            return JSON.stringify(got) === JSON.stringify(want) ? [] : [{ no: row.no, got, want }]
          })
          report(`${folder.git ? "git" : "nogit"} misses`, misses)

          // 10 and 16 were the subagent's, and its looks are judged the same as the root's.
          expect(rows.filter((row) => [10, 16].includes(row.no)).map((row) => row.lines[0]!.sessionID)).toEqual([subs[0], subs[0]])
          // 23: the command is longer than the audit keeps, and every path in it was still judged (see the control below).
          expect(rows[22]!.lines[0]!.patternsTruncated).toBe(true)
          // The edits name the file relative to the worktree, which is `/` without git: no leading slash.
          if (!folder.git) expect(rows[3]!.lines[0]!.patterns[0]!.startsWith("/")).toBe(false)
          expect(fs.readFileSync(path.join(test.directory, TASK, "status_tasks.md"), "utf8")).toBe("synthetic content of row 27\n")

          // T2: the three writes that were held with no line at all. Each again of a call already made: one line each.
          const t2: number[] = []
          for (const name of ["identification/01_original.md", "README.md", "status_tasks.md"]) {
            const one = yield* replay(
              root,
              tools.write.execute({ filePath: path.join(test.directory, TASK, name), content: "synthetic again\n" }, ctx.root),
            )
            expect(one.result).toBe("ran")
            t2.push(one.lines.length)
          }
          expect(t2).toEqual([1, 1, 1])

          expect(counted.calls).toBe(0)
          const waiting = yield* waitingFor(root, [root, ...subs])
          report(`${folder.git ? "git" : "nogit"} waiting`, { held: waiting.held.map((item) => [item.permission, item.patterns]), questions: waiting.questions.length, open: waiting.open.length })

          // The person's question, as a hard line: nothing that read or wrote inside the folder reached D.
          const inside = rows.filter((row) => !["outside", "mcp", "question"].includes(EVIDENCE[row.no - 1]!.group))
          expect(inside.length).toBe(18)
          expect(inside.flatMap((row) => row.lines.filter((line) => line.class === "D" || line.class === "X").map((line) => [row.no, line.permission, line.class, line.category]))).toEqual([])
          expect(misses).toEqual([])
          expect([waiting.held.length, waiting.questions.length, waiting.open.length]).toEqual([0, 0, 0])
        }),
      {
        git: folder.git,
        init: layout,
      },
      90_000,
    )
})

describe("alugra: the in-folder reads and writes beyond the 29", () => {
  for (const folder of FOLDERS)
    gate.instance(
      `${folder.name}: every file tool and every read-only command on ordinary files in the folder is not D`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const { root, subs, ctx } = yield* family(folder.git, "Tidy the synthetic notes in the prototype")
          const reading = yield* (yield* ReadTool).init()
          const writing = yield* (yield* WriteTool).init()
          const editing = yield* (yield* EditTool).init()
          const patching = yield* (yield* ApplyPatchTool).init()
          const globbing = yield* (yield* GlobTool).init()
          const grepping = yield* (yield* GrepTool).init()
          const shell = yield* (yield* ShellTool).init()
          const at = (relative: string) => path.join(test.directory, relative)
          const notes = `${TASK}/notes.md`
          fs.writeFileSync(at(notes), "alpha\nbeta\n")
          fs.writeFileSync(at("alugra/prototype/src/a.ts"), "export const a = 1\n")
          counted.calls = 0

          const fileTools: [string, Effect.Effect<unknown, unknown>][] = [
            ["read tool, nested repository", reading.execute({ filePath: at("alugra/prototype/src/a.ts") }, ctx.sub2)],
            ["read tool, task folder", reading.execute({ filePath: at(notes) }, ctx.root)],
            ["write tool, new file", writing.execute({ filePath: at(`${TASK}/new.md`), content: "new\n" }, ctx.root)],
            ["write tool, subagent", writing.execute({ filePath: at("alugra/prototype/src/b.ts"), content: "export const b = 2\n" }, ctx.sub1)],
            ["edit tool", editing.execute({ filePath: at(notes), oldString: "beta", newString: "gamma" }, ctx.root)],
            ["apply_patch", patching.execute({ patchText: `*** Begin Patch\n*** Add File: ${at(`${TASK}/patched.md`)}\n+patched\n*** End Patch` }, ctx.root)],
            ["glob tool", globbing.execute({ pattern: "**/*.md", path: at(TASK) }, ctx.sub1)],
            ["grep tool", grepping.execute({ pattern: "alpha", path: at(TASK) }, ctx.sub1)],
          ]
          const READS = [
            `cat ${notes}`, `head -n 1 ${notes}`, `tail -n 1 ${notes}`, `wc -l ${notes}`, "ls -la alugra", "rtk ls alugra/prototype",
            `grep -n alpha ${notes}`, `rg alpha ${TASK}`, "find alugra/prototype -name '*.ts'", `cat alugra/prototype/src/a.ts`, "ls ../" + path.basename(test.directory),
            // Row 11's shape, and the parts of it one at a time: quotes, two files, the `rtk` wrapper.
            `rtk wc -l "${notes}" "${TASK}/README.md"`, `wc -l "${notes}"`, `wc -l ${notes} ${TASK}/README.md`, `rtk wc -l ${notes} ${TASK}/README.md`, `cat "${notes}"`, `ls "alugra"`,
            "find alugra/prototype -type f", "find . -name notes.md",
          ]
          const commands: [string, Effect.Effect<unknown, unknown>][] = READS.map((command) => [command, shell.execute({ command }, ctx.root)])

          const results: [string, string, string, string[]][] = []
          for (const [label, run] of [...fileTools, ...commands]) {
            const one = yield* replay(root, run)
            results.push([label, one.result, finalClass(one.lines), one.lines.map((line) => `${line.permission}:${line.class}:${line.category ?? "-"}`)])
          }
          report(`${folder.git ? "git" : "nogit"} sweep`, results)
          const lookCalls = counted.calls

          // Writes through the shell are file operations the decider settles (P), or a deletion moved to the archive (A).
          // They are writes in the folder too, so the same hard line holds them: P is allowed, D is not.
          const SHELL_WRITES = [`mkdir -p ${TASK}/out`, `touch ${TASK}/out/a.md`, `cp ${notes} ${TASK}/copy.md`, `mv ${TASK}/new.md ${TASK}/moved.md`, `rm ${TASK}/patched.md`,
            // The same outside the nested repositories, at the top of the folder.
            "mkdir -p top-out", "touch top-out/a.md", "cp top-out/a.md top-out/b.md", "mv top-out/b.md top-out/c.md"]
          const writes: [string, string, string][] = []
          for (const command of SHELL_WRITES) {
            const one = yield* replay(root, shell.execute({ command }, ctx.root))
            writes.push([command, one.result, one.lines.map((line) => `${line.class}:${line.category ?? "-"}`).join(",")])
          }
          report(`${folder.git ? "git" : "nogit"} shell writes (decider calls ${counted.calls})`, writes)
          // A command never reaches X here, and the gate never waits on a person for a check it could make itself.
          expect(writes.filter((row) => row[2].startsWith("X"))).toEqual([])
          const waiting = yield* waitingFor(root, [root, ...subs])
          report(`${folder.git ? "git" : "nogit"} shell writes waiting`, waiting.held.map((item) => item.patterns))

          // The hard line, after everything is measured: no file tool, no read-only command and no shell file operation on
          // an ordinary file in the folder is D. The looks ran without asking the decider.
          expect(results.filter((row) => row[2] === "D" || row[2] === "X").map((row) => [row[0], row[3]])).toEqual([])
          expect(writes.filter((row) => /(^|,)[DX]:/.test(row[2])).map((row) => [row[0], row[2]])).toEqual([])
          expect(results.filter((row) => row[1] !== "ran").map((row) => [row[0], row[1]])).toEqual([])
          expect(lookCalls).toBe(0)
          expect(fs.readFileSync(at(notes), "utf8")).toBe("alpha\ngamma\n")
        }),
      { git: folder.git, init: layout },
      90_000,
    )

  gate.instance("23: a path past what the audit keeps is still judged, so an outside secret at the end is held", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { root, ctx } = yield* family(false, "Count the synthetic server files")
      const shell = yield* (yield* ShellTool).init()
      const command = `wc -l ${SERVER_FILES.map((file) => path.join(test.directory, file)).join(" ")} ${awsConfig()}`
      expect(command.length).toBeGreaterThan(300)
      const one = yield* replay(root, shell.execute({ command }, ctx.sub2))
      expect(one.result).toBe("held")
      expect(finalClass(one.lines)).toBe("D")
      report("23 control", one.lines.map((line) => [line.class, line.category, line.patternsTruncated]))
    }),
    { init: layout },
  )
})

describe("alugra T3 and C84: one entry for the same pattern, one approval, and the calls run again", () => {
  for (const folder of FOLDERS)
    gate.instance(
      `${folder.name}: five reads of a secret beyond the folder, by the root and a subagent, are one entry; approving it runs all five once through the real read tool`,
      () =>
        Effect.gen(function* () {
          sent.length = 0
          const { root, subs, ctx } = yield* family(folder.git, "Look at the synthetic prototype")
          const permission = yield* Permission.Service
          const autonomy = yield* Autonomy.Service
          const reading = yield* (yield* ReadTool).init()
          counted.calls = 0
          const READS: [Who, Record<string, unknown>][] = [
            ["root", { filePath: awsConfig() }],
            ["root", { filePath: awsConfig(), offset: 1 }],
            ["sub1", { filePath: awsConfig(), offset: 2 }],
            ["root", { filePath: awsConfig(), limit: 1 }],
            ["root", { filePath: awsConfig(), offset: 1, limit: 1 }],
          ]
          const held: string[] = []
          for (const [who, args] of READS) held.push(yield* attempt(reading.execute(args as never, ctx[who])))
          expect(held).toEqual(Array(5).fill("held"))
          const before = yield* decisions(root)
          report(`${folder.git ? "git" : "nogit"} T3 lines`, before.map((line) => [line.permission, line.class, line.category, line.via]))
          expect(before.every((line) => line.class === "D")).toBe(true)

          const entries = (yield* permission.list()).filter((item) => [root, ...subs].includes(item.sessionID))
          expect(entries).toHaveLength(1)
          const entry = entries[0]!
          // The entry shows every call, as the tool sent it: the exact calls a person approves are the ones rebuilt below.
          expect(entry.metadata.version).toBe(5)
          expect(entry.metadata.calls).toEqual(READS.map(([, args]) => ({ tool: "read", args })))
          expect((yield* autonomy.openDecisions()).filter((line) => line.rootID === root)).toHaveLength(1)

          // The person approves once, for the list at the version they saw; the server runs each call once (E1). What it
          // leaves waiting is approved again, up to three rounds, to count how many approvals the five reads take.
          const rounds: { approved: number; ran: number; failed: number; waiting: [string, readonly string[], number][] }[] = []
          let next: typeof entry | undefined = entry
          while (next && rounds.length < 3) {
            const outcomesBefore = (yield* autonomy.readAudit(root)).lines.filter((line) => line.type === "outcome").length
            const answered = yield* permission.reply({ requestID: next.id, reply: "once", version: (next.metadata.version as number | undefined) ?? 1 })
            expect(answered).toBeDefined()
            yield* (yield* lateAnswers).permission(answered!)
            const outcomes = (yield* autonomy.readAudit(root)).lines.flatMap((line) => (line.type === "outcome" ? [line.outcome] : [])).slice(outcomesBefore)
            const left = (yield* permission.list()).filter((item) => [root, ...subs].includes(item.sessionID))
            rounds.push({
              approved: rounds.length + 1,
              ran: outcomes.filter((outcome) => outcome === "ran").length,
              failed: outcomes.filter((outcome) => outcome === "failed").length,
              waiting: left.map((item) => [item.permission, item.patterns, ((item.metadata.calls as unknown[] | undefined) ?? []).length]),
            })
            next = rounds.at(-1)!.ran === 5 ? undefined : left[0]
          }
          report(`${folder.git ? "git" : "nogit"} C84 rounds`, rounds)
          report(`${folder.git ? "git" : "nogit"} C84 sent`, sent.map((item) => item.text.slice(0, 400)))
          report(`${folder.git ? "git" : "nogit"} C84 lines after`, (yield* decisions(root)).slice(before.length).map((line) => [line.permission, line.class, line.category, line.decision, line.via]))
          expect(counted.calls).toBe(0)
          // U11 E1 and E3: one approval, five calls run, the output reaches the root, nothing left waiting.
          expect(rounds[0]).toEqual({ approved: 1, ran: 5, failed: 0, waiting: [] })
          expect(sent[0]!.sessionID).toBe(root)
          expect(sent[0]!.text.split("Swarm ran it once for you").length - 1).toBe(5)
          expect(sent[0]!.text).toContain(AWS_MARK)
          const waiting = yield* waitingFor(root, [root, ...subs])
          expect([waiting.held.length, waiting.questions.length, waiting.open.length]).toEqual([0, 0, 0])

          // A sixth call after the click was not on the list the person saw: it does not pass on that approval.
          expect(yield* attempt(reading.execute({ filePath: awsConfig(), offset: 2, limit: 1 } as never, ctx.root))).toBe("held")
        }),
      { git: folder.git, init: layout },
      90_000,
    )

  gate.instance("C84 with the real shell: an approved `cat` of the secret beyond the folder runs once, the identical command", () =>
    Effect.gen(function* () {
      sent.length = 0
      const { root, subs, ctx } = yield* family(false, "Look at the synthetic prototype")
      const permission = yield* Permission.Service
      const autonomy = yield* Autonomy.Service
      const shell = yield* (yield* ShellTool).init()
      const command = `cat ${awsConfig()}`
      // The replay context stops a command past the gate, so it never runs here: only the server's rerun runs it.
      expect(yield* attempt(shell.execute({ command }, ctx.root))).toBe("held")
      const entry = (yield* permission.list()).filter((item) => [root, ...subs].includes(item.sessionID))
      expect(entry).toHaveLength(1)
      const call = entry[0]!.metadata.call as { tool: string; args: Record<string, unknown> }
      expect(call).toEqual({ tool: "bash", args: { command, workdir: (yield* TestInstance).directory } })
      const answered = yield* permission.reply({ requestID: entry[0]!.id, reply: "once" })
      yield* (yield* lateAnswers).permission(answered!)
      const outcomes = (yield* autonomy.readAudit(root)).lines.flatMap((line) => (line.type === "outcome" ? [line] : []))
      report("C84 shell outcomes", outcomes.map((line) => [line.outcome, line.exit, line.by]))
      expect(outcomes.filter((line) => line.outcome === "ran").map((line) => line.exit)).toEqual([0])
      expect(sent).toHaveLength(1)
      expect(sent[0]!.text).toContain("Swarm ran it once for you")
      expect(sent[0]!.text).toContain(AWS_MARK)
      expect(counted.calls).toBe(0)
      expect((yield* permission.list()).filter((item) => [root, ...subs].includes(item.sessionID))).toEqual([])
    }),
    { init: layout },
  )
})

describe("C95: a command on a file a person allowed", () => {
  // The forms a mission that needs `.env` most likely sends. Each is judged through the real shell and gate.
  const FORMS = [
    "cat .env",
    "source .env",
    ". .env",
    "head -n 1 .env",
    "grep API_URL .env",
    "wc -l .env",
    "set -a && source .env && set +a",
    "source .env && bun test",
    "cp .env .env.backup",
    "diff .env .env.example",
  ]
  for (const folder of FOLDERS)
    gate.instance(
      `${folder.name}: how many of ${FORMS.length} shell forms on an allowed .env still wait, while the read and write tools do not`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const sessions = yield* Session.Service
          const autonomy = yield* Autonomy.Service
          const root = yield* sessions.create({})
          yield* missionMessage(root.id, "Fix the synthetic settings in .env")
          yield* autonomy.setMode({ scope: "session", root: root.id, on: true })
          yield* autonomy.markMode({ root: root.id, directory: (yield* sessions.get(root.id)).directory })
          const list = (yield* autonomy.consent(root.id))!
          const env = list.items.find((item) => item.pattern === ".env*")!
          expect([env.named, env.checked]).toEqual([true, true])
          yield* autonomy.allowConsent({ root: root.id, hash: list.hash, ids: [env.id] })
          const ctx = yield* contextFor(root.id, "build", folder.git)
          const reading = yield* (yield* ReadTool).init()
          const writing = yield* (yield* WriteTool).init()
          const shell = yield* (yield* ShellTool).init()
          counted.calls = 0

          const tools = [
            yield* replay(root.id, reading.execute({ filePath: path.join(test.directory, ".env") }, ctx)),
            yield* replay(root.id, writing.execute({ filePath: path.join(test.directory, ".env"), content: "API_URL=synthetic-fixed\n" }, ctx)),
          ]
          expect(tools.map((one) => [one.result, finalClass(one.lines), one.lines[0]?.via])).toEqual([
            ["ran", "A", "consent"],
            ["ran", "A", "consent"],
          ])

          const measured: [string, string, string][] = []
          for (const command of FORMS) {
            const one = yield* replay(root.id, shell.execute({ command }, ctx))
            measured.push([command, one.result, one.lines.map((line) => `${line.class}:${line.category ?? "-"}`).join(",")])
          }
          const waits = measured.filter((row) => row[1] === "held").length
          report(`${folder.git ? "git" : "nogit"} C95 ${waits}/${FORMS.length} wait (decider calls ${counted.calls})`, measured)
          // The number is the finding; the line here only keeps it from drifting unnoticed. Update both with the report.
          expect(waits).toBe(C95_WAITS[folder.git ? "git" : "nogit"])
        }),
      {
        git: folder.git,
        init: (directory: string) =>
          Effect.sync(() => {
            fs.writeFileSync(path.join(directory, ".env"), "API_URL=synthetic\n")
            fs.writeFileSync(path.join(directory, ".env.example"), "API_URL=\n")
          }),
      },
      90_000,
    )
})

// Measured by this row (C95): every one of the ten forms waited, in both folders. After C97 F4 (row 248) `cat`, `head`,
// `grep` and `wc` of the allowed file are A `consented`. What still waits, and why:
// - `source .env` and `. .env`: with Git they are P `script` (screened, the decider answers); without Git they are
//   D `no_undo`, as every script is where nothing can be undone.
// - `set -a && source .env && set +a` and `source .env && bun test`: more than one command; D `secret_file`.
// - `cp .env .env.backup`: writes a copy of the secret; D `secret_file` (C97 F4 covers looks only).
// - `diff .env .env.example`: `diff` is not one of the looks C97 F4 names; D `secret_file`.
const C95_WAITS = { nogit: 6, git: 4 }

// C87 (row 122c): the older session route does not hand a rejection to `late.rejected`. Row 122c showed one held entry
// clears. Here it is the alugra shape: one entry standing for five calls of the root and a subagent, rejected through
// `/session/{id}/permissions/{rid}`, from the root's view and from the subagent's. Nothing may be left waiting.
const served = testEffect(
  Layer.mergeAll(
    workspaceLayerWithRuntimeFlags({}),
    loopbackServer,
    NodeServices.layer,
    AppNodeBuilder.build(
      LayerNode.group([
        ToolRegistry.node, Agent.node, Permission.node, Session.node, Autonomy.node, Plugin.node, MCP.node, Truncate.node,
        RuntimeFlags.node, EventV2Bridge.node, SessionProjector.node, CrossSpawnSpawner.node, InstanceStore.node, Question.node,
        FSUtil.node, Config.node, LSP.node, Format.node, Instruction.node, Ripgrep.node,
      ]),
      [
        [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
        [Permission.deciderNode, countingDecider],
      ],
    ),
  ),
)
const routeSent: string[] = []
const serveSession = HttpApiBuilder.layer(SessionApi).pipe(
  Layer.provide(sessionHandlers as never),
  Layer.provide([
    authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer)),
    workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    instanceContextLayer,
    schemaErrorLayer,
    Layer.succeed(
      SessionPrompt.Service,
      SessionPrompt.Service.of({
        prompt: (input: SessionPrompt.PromptInput) =>
          Effect.sync(() => {
            const part = input.parts[0]
            routeSent.push(part?.type === "text" ? part.text : "")
            return {} as never
          }),
      } as unknown as SessionPrompt.Interface),
    ),
    // The session group asks for these when it is built; the answer route uses none of them.
    ...[SessionShare.Service, SessionRevert.Service, SessionCompaction.Service, SessionRunState.Service, SessionStatus.Service, Todo.Service, SessionSummary.Service, Agent.Service].map((tag) =>
      Layer.succeed(tag as never, {} as never),
    ),
  ] as never),
  HttpRouter.serve,
  Layer.build,
) as unknown as Effect.Effect<unknown>

describe("C87: a rejection through the session route", () => {
  for (const view of ["root", "sub1"] as const)
    served.instance(
      `from the ${view === "root" ? "root" : "subagent"}'s session: the alugra entry of five calls is cleared, and nothing waits or wakes`,
      () =>
        Effect.gen(function* () {
          routeSent.length = 0
          const test = yield* TestInstance
          yield* serveSession
          const { root, subs, ctx } = yield* family(false, "Look at the synthetic prototype")
          const permission = yield* Permission.Service
          const autonomy = yield* Autonomy.Service
          const reading = yield* (yield* ReadTool).init()
          const who: Who[] = ["root", "root", "sub1", "root", "root"]
          const results: string[] = []
          for (const [index, one] of who.entries())
            results.push(yield* attempt(reading.execute({ filePath: awsConfig(), offset: index + 1 } as never, ctx[one])))
          expect(results).toEqual(Array(5).fill("held"))
          const entries = (yield* permission.list()).filter((item) => [root, ...subs].includes(item.sessionID))
          expect(entries).toHaveLength(1)
          expect(entries[0]!.metadata.version).toBe(5)
          const sessionID = view === "root" ? root : subs[0]!
          const request = yield* HttpClientRequest.post(`/session/${sessionID}/permissions/${entries[0]!.id}`).pipe(
            HttpClientRequest.setHeader("x-opencode-directory", test.directory),
            HttpClientRequest.bodyJson({ response: "reject" }),
          )
          const status = (yield* HttpClient.execute(request)).status
          // Long enough for a forked late answer to have been sent, were one coming.
          yield* Effect.sleep("200 millis")
          const waiting = yield* waitingFor(root, [root, ...subs])
          const outcomes = (yield* autonomy.readAudit(root)).lines.flatMap((line) => (line.type === "outcome" ? [[line.outcome, line.by]] : []))
          report(`C87 ${view}`, { status, held: waiting.held.length, open: waiting.open.length, outcomes, woke: routeSent.length })
          expect(status).toBe(200)
          expect([waiting.held.length, waiting.questions.length, waiting.open.length]).toEqual([0, 0, 0])
          expect(outcomes).toEqual([["rejected_later", "person"]])
          expect(routeSent).toEqual([])
          expect(counted.calls).toBe(0)
          // And the rejection allows nothing: the same read again is held anew.
          expect(yield* attempt(reading.execute({ filePath: awsConfig(), offset: 1 } as never, ctx.root))).toBe("held")
        }),
      { init: layout },
      60_000,
    )
})
