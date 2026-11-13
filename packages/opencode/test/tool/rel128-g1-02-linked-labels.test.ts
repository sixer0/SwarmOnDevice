import { afterEach, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { MessageID, SessionID } from "../../src/session/schema"
import { Skill } from "../../src/skill"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool, linkedLabels } from "../../src/tool/edit"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// 1.2.8 row 28g (G1-02, C106): linkedLabels through the REAL Permission.ask, at every call site (edit, write,
// apply_patch). The ruleset handed to ask is the agent's own rules plus a person's rules, so no call here waits for an
// answer: every pattern is allowed or denied by a rule. A deny on any pattern refuses the call (S163-01).

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Plugin.node,
      Provider.node,
      Auth.node,
      Config.node,
      Skill.node,
      RuntimeFlags.node,
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Truncate.node,
      Permission.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const role = (name: string) =>
  Agent.Service.use((svc) => svc.get(name)).pipe(
    Effect.map((agent) => {
      if (!agent) throw new Error(`agent ${name} is not registered`)
      return agent
    }),
  )

// The ask the session gives a tool, on `ruleset`; `asked` keeps each edit request's patterns.
const realCtx = (agent: string, ruleset: PermissionV1.Ruleset, asked: string[][]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const sessionID = SessionID.make("ses_rel128-g1-02")
    const ctx: Tool.Context = {
      sessionID,
      messageID: MessageID.make("msg_rel128-g1-02"),
      callID: "",
      agent,
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (request) =>
        Effect.gen(function* () {
          if (request.permission === "edit") asked.push([...request.patterns])
          return yield* permission.ask({ ...request, sessionID, ruleset })
        }) as never,
    }
    return ctx
  })

// The verifier's own rules (Markdown asks, the rest is denied) with a person's allow for Markdown, so a call that is not
// denied runs without a prompt. The extension rule is the verifier's; nothing here loosens it.
const verifierCtx = (asked: string[][], extra: PermissionV1.Ruleset = []) =>
  Effect.gen(function* () {
    const verifier = yield* role("verifier")
    return yield* realCtx(
      "verifier",
      [...verifier.permission, ...Permission.fromConfig({ edit: { "*.md": "allow" } }), ...extra],
      asked,
    )
  })

// build, with a person's rule: everything may be edited except under src/.
const personCtx = (asked: string[][]) =>
  Effect.gen(function* () {
    const build = yield* role("build")
    return yield* realCtx("build", [...build.permission, ...Permission.fromConfig({ edit: { "*": "allow", "src/**": "deny" } })], asked)
  })

const read = (file: string) => fs.readFile(file, "utf8").catch(() => undefined)

const sourceAndMdLink = (dir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, "src"), { recursive: true })
    await fs.writeFile(path.join(dir, "src/a.ts"), "export const a = 1\n")
    await fs.symlink(path.join(dir, "src/a.ts"), path.join(dir, "notes.md"))
  })

it.instance("G1-02: a .md link to src/a.ts is denied for the verifier through the real ask (write, edit, apply_patch)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* sourceAndMdLink(test.directory)
    const asked: string[][] = []
    const ctx = yield* verifierCtx(asked)

    const write = yield* (yield* WriteTool).init()
    const wrote = yield* write.execute({ filePath: "notes.md", content: "overwritten\n" }, ctx).pipe(Effect.exit)
    expect(wrote._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["notes.md", "src/a.ts"])

    const edit = yield* (yield* EditTool).init()
    const edited = yield* edit
      .execute({ filePath: "notes.md", oldString: "export const a = 1", newString: "export const a = 2" }, ctx)
      .pipe(Effect.exit)
    expect(edited._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["notes.md", "src/a.ts"])

    const patch = yield* (yield* ApplyPatchTool).init()
    const patched = yield* patch
      .execute(
        { patchText: "*** Begin Patch\n*** Update File: notes.md\n@@\n-export const a = 1\n+export const a = 3\n*** End Patch" },
        ctx,
      )
      .pipe(Effect.exit)
    expect(patched._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["notes.md", "src/a.ts"])

    expect(yield* Effect.promise(() => read(path.join(test.directory, "src/a.ts")))).toBe("export const a = 1\n")

    // A plain Markdown file still goes through, and its ask names only itself.
    const plain: string[][] = []
    yield* write.execute({ filePath: "docs/report.md", content: "# Report\n" }, yield* verifierCtx(plain))
    expect(plain).toEqual([["docs/report.md"]])
    expect(yield* Effect.promise(() => read(path.join(test.directory, "docs/report.md")))).toBe("# Report\n")
  }),
  { git: true },
)

it.instance("G1-02: a dangling .md link is judged by where the write would land (src/new.ts, denied)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(test.directory, "src"), { recursive: true })
      await fs.symlink(path.join(test.directory, "src/new.ts"), path.join(test.directory, "draft.md"))
    })
    const asked: string[][] = []
    const ctx = yield* verifierCtx(asked)

    const write = yield* (yield* WriteTool).init()
    const wrote = yield* write.execute({ filePath: "draft.md", content: "export const b = 1\n" }, ctx).pipe(Effect.exit)
    expect(wrote._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["draft.md", "src/new.ts"])

    const edit = yield* (yield* EditTool).init()
    const edited = yield* edit
      .execute({ filePath: "draft.md", oldString: "", newString: "export const b = 2\n" }, ctx)
      .pipe(Effect.exit)
    expect(edited._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["draft.md", "src/new.ts"])

    expect(yield* Effect.promise(() => read(path.join(test.directory, "src/new.ts")))).toBeUndefined()
  }),
  { git: true },
)

it.instance("G1-02: a link loop adds no label, and the write fails on it", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Effect.promise(() => fs.symlink(path.join(test.directory, "loop.md"), path.join(test.directory, "loop.md")))
    expect(linkedLabels(test.directory, [path.join(test.directory, "loop.md")])).toEqual([])
    // Where a loop lands cannot be worked out, so the tools first ask about it as a folder outside the project; a person
    // allows that here so the call reaches the edit ask.
    const asked: string[][] = []
    const ctx = yield* verifierCtx(asked, Permission.fromConfig({ external_directory: { "*": "allow" } }))

    const write = yield* (yield* WriteTool).init()
    const wrote = yield* write.execute({ filePath: "loop.md", content: "x\n" }, ctx).pipe(Effect.exit)
    expect(wrote._tag).toBe("Failure")
    expect(asked).toEqual([["loop.md"]])
    expect((yield* Effect.promise(() => fs.lstat(path.join(test.directory, "loop.md")))).isSymbolicLink()).toBe(true)
  }),
  { git: true },
)

const folderLink = (dir: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, "src"), { recursive: true })
    await fs.writeFile(path.join(dir, "src/x.md"), "one\n")
    await fs.symlink(path.join(dir, "src"), path.join(dir, "docs"))
  })

it.instance("G1-02: through a folder link (docs -> src), a person's deny src/** applies to docs/x.md (write, edit, apply_patch)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* folderLink(test.directory)
    const asked: string[][] = []
    const ctx = yield* personCtx(asked)

    const write = yield* (yield* WriteTool).init()
    const wrote = yield* write.execute({ filePath: "docs/x.md", content: "two\n" }, ctx).pipe(Effect.exit)
    expect(wrote._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["docs/x.md", "src/x.md"])

    const edit = yield* (yield* EditTool).init()
    const edited = yield* edit.execute({ filePath: "docs/x.md", oldString: "one", newString: "three" }, ctx).pipe(Effect.exit)
    expect(edited._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["docs/x.md", "src/x.md"])

    // A new file through the folder link lands under src/ as well.
    const created = yield* edit.execute({ filePath: "docs/new.md", oldString: "", newString: "n\n" }, ctx).pipe(Effect.exit)
    expect(created._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["docs/new.md", "src/new.md"])

    const patch = yield* (yield* ApplyPatchTool).init()
    const patched = yield* patch
      .execute({ patchText: "*** Begin Patch\n*** Update File: docs/x.md\n@@\n-one\n+four\n*** End Patch" }, ctx)
      .pipe(Effect.exit)
    expect(patched._tag).toBe("Failure")
    expect(asked.at(-1)).toEqual(["docs/x.md", "src/x.md"])

    expect(yield* Effect.promise(() => read(path.join(test.directory, "src/x.md")))).toBe("one\n")
    expect(yield* Effect.promise(() => read(path.join(test.directory, "src/new.md")))).toBeUndefined()
  }),
  { git: true },
)

it.instance("G1-02: the folder-link label only adds: a file outside the denied folder still writes, and its ask names itself", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* folderLink(test.directory)
    const asked: string[][] = []
    const ctx = yield* personCtx(asked)
    const write = yield* (yield* WriteTool).init()
    yield* write.execute({ filePath: "notes/plain.md", content: "p\n" }, ctx)
    expect(asked).toEqual([["notes/plain.md"]])
    expect(yield* Effect.promise(() => read(path.join(test.directory, "notes/plain.md")))).toBe("p\n")
  }),
  { git: true },
)

it.instance("G1-02: the verifier's extension rule is unchanged through a folder link (docs -> src: .md asks, .ts denied)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* folderLink(test.directory)
    const asked: string[][] = []
    const ctx = yield* verifierCtx(asked)
    const write = yield* (yield* WriteTool).init()
    yield* write.execute({ filePath: "docs/x.md", content: "five\n" }, ctx)
    expect(asked.at(-1)).toEqual(["docs/x.md", "src/x.md"])
    expect(yield* Effect.promise(() => read(path.join(test.directory, "src/x.md")))).toBe("five\n")
    const ts = yield* write.execute({ filePath: "docs/b.ts", content: "x\n" }, ctx).pipe(Effect.exit)
    expect(ts._tag).toBe("Failure")
    expect(yield* Effect.promise(() => read(path.join(test.directory, "src/b.ts")))).toBeUndefined()
  }),
  { git: true },
)
