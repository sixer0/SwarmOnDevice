import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Snapshot } from "../../src/snapshot"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// What Undo on a subagent's line would do, as evidence for GATE 8.4. These run the real snapshot service over real files,
// in the order the processor does: track when a step starts, patch when it finishes. The child's revert works, but its
// limits below are why Activity gives a subagent's line no button (AU-38). Only lines of the root session have one.

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node]),
  ),
)

const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))

const turn = Effect.fn("test.turn")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
})

// One assistant step: its changes happen between the two snapshots, and the patch lands on the step's own message.
const step = Effect.fn("test.step")(function* (input: {
  sessionID: SessionID
  parentID: MessageID
  dir: string
  change: Effect.Effect<void, unknown, Session.Service | Snapshot.Service | SessionRevert.Service>
}) {
  const session = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const message = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: input.sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: input.dir, root: input.dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    parentID: input.parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
  const hash = yield* snapshot.track()
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: message.id,
    sessionID: input.sessionID,
    type: "tool",
    tool: "edit",
    callID: `call-${message.id}`,
    state: {
      status: "completed",
      input: {},
      output: "done",
      title: "",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  })
  yield* input.change
  expect(hash).toBeTruthy()
  const patch = yield* snapshot.patch(hash!)
  if (patch.files.length) {
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID: message.id,
      sessionID: input.sessionID,
      type: "patch",
      hash: patch.hash,
      files: patch.files,
    })
  }
  return { message, patch }
})

const family = Effect.fn("test.family")(function* (dir: string) {
  const session = yield* Session.Service
  const root = yield* session.create({})
  const child = yield* session.create({ parentID: root.id })
  const a = path.join(dir, "a.txt")
  const b = path.join(dir, "b.txt")
  yield* write(a, "a0\n")
  yield* write(b, "b0\n")
  return { root, child, a, b, rootTurn: yield* turn(root.id), childTurn: yield* turn(child.id) }
})

describe("Undo on a subagent's decision", () => {
  it.live(
    "reverting the child at its own message brings the child's edit back, and leaves the root alone",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const f = yield* family(dir)
          const edit = yield* step({
            sessionID: f.child.id,
            parentID: f.childTurn.id,
            dir,
            change: write(f.a, "a1\n"),
          })
          expect(edit.patch.files.length).toBe(1)

          const after = yield* revert.revert({ sessionID: f.child.id, messageID: edit.message.id })

          expect(yield* read(f.a)).toBe("a0\n")
          expect(after.revert).toBeDefined()
          expect((yield* session.get(f.root.id)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "later steps of the same child are undone too, and undoing a later one keeps the earlier",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const revert = yield* SessionRevert.Service
          const f = yield* family(dir)
          const first = yield* step({
            sessionID: f.child.id,
            parentID: f.childTurn.id,
            dir,
            change: write(f.a, "a1\n"),
          })
          const secondTurn = yield* turn(f.child.id)
          const second = yield* step({
            sessionID: f.child.id,
            parentID: secondTurn.id,
            dir,
            change: write(f.b, "b1\n"),
          })

          yield* revert.revert({ sessionID: f.child.id, messageID: second.message.id })
          expect(yield* read(f.a)).toBe("a1\n")
          expect(yield* read(f.b)).toBe("b0\n")

          yield* revert.unrevert({ sessionID: f.child.id })
          expect(yield* read(f.b)).toBe("b1\n")

          yield* revert.revert({ sessionID: f.child.id, messageID: first.message.id })
          expect(yield* read(f.a)).toBe("a0\n")
          expect(yield* read(f.b)).toBe("b0\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "bring back restores the child's edit",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const revert = yield* SessionRevert.Service
          const f = yield* family(dir)
          const edit = yield* step({
            sessionID: f.child.id,
            parentID: f.childTurn.id,
            dir,
            change: write(f.a, "a1\n"),
          })

          yield* revert.revert({ sessionID: f.child.id, messageID: edit.message.id })
          const restored = yield* revert.unrevert({ sessionID: f.child.id })

          expect(yield* read(f.a)).toBe("a1\n")
          expect(restored.revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "the root's id with the child's message does nothing at all",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const revert = yield* SessionRevert.Service
          const f = yield* family(dir)
          const edit = yield* step({
            sessionID: f.child.id,
            parentID: f.childTurn.id,
            dir,
            change: write(f.a, "a1\n"),
          })

          const after = yield* revert.revert({ sessionID: f.root.id, messageID: edit.message.id })

          expect(yield* read(f.a)).toBe("a1\n")
          expect(after.revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "the hypothesis of GATE 8.4: a root step around the task has the child's change in its patch",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const revert = yield* SessionRevert.Service
          const f = yield* family(dir)
          const around = yield* step({
            sessionID: f.root.id,
            parentID: f.rootTurn.id,
            dir,
            change: step({ sessionID: f.child.id, parentID: f.childTurn.id, dir, change: write(f.a, "a1\n") }).pipe(
              Effect.asVoid,
            ),
          })
          expect(around.patch.files.map((file) => path.basename(file))).toContain("a.txt")

          yield* revert.revert({ sessionID: f.root.id, messageID: around.message.id })

          expect(yield* read(f.a)).toBe("a0\n")
        }),
      { git: true },
    ),
  )

  // Limits the dialog's sentence cannot state. They are locked here so that a change to them gets read.
  it.live(
    "limit: the root's later step on another file stays, since the child's revert reads only the child",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const revert = yield* SessionRevert.Service
          const f = yield* family(dir)
          const edit = yield* step({
            sessionID: f.child.id,
            parentID: f.childTurn.id,
            dir,
            change: write(f.a, "a1\n"),
          })
          yield* step({ sessionID: f.root.id, parentID: f.rootTurn.id, dir, change: write(f.b, "b1\n") })

          yield* revert.revert({ sessionID: f.child.id, messageID: edit.message.id })

          expect(yield* read(f.a)).toBe("a0\n")
          expect(yield* read(f.b)).toBe("b1\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "limit: the root's later step on the same file is overwritten",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const revert = yield* SessionRevert.Service
          const f = yield* family(dir)
          const edit = yield* step({
            sessionID: f.child.id,
            parentID: f.childTurn.id,
            dir,
            change: write(f.a, "a1\n"),
          })
          yield* step({ sessionID: f.root.id, parentID: f.rootTurn.id, dir, change: write(f.a, "a2\n") })

          yield* revert.revert({ sessionID: f.child.id, messageID: edit.message.id })

          expect(yield* read(f.a)).toBe("a0\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "limit: an earlier step of the same turn keeps its file, though the whole turn is marked as reverted",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const revert = yield* SessionRevert.Service
          const f = yield* family(dir)
          yield* step({ sessionID: f.child.id, parentID: f.childTurn.id, dir, change: write(f.a, "a1\n") })
          const later = yield* step({
            sessionID: f.child.id,
            parentID: f.childTurn.id,
            dir,
            change: write(f.b, "b1\n"),
          })

          const after = yield* revert.revert({ sessionID: f.child.id, messageID: later.message.id })

          expect(yield* read(f.b)).toBe("b0\n")
          expect(yield* read(f.a)).toBe("a1\n")
          expect(after.revert?.messageID).toBe(f.childTurn.id)
        }),
      { git: true },
    ),
  )

  it.live(
    "a message that is gone leaves the files alone, so a stale button cannot hurt",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const revert = yield* SessionRevert.Service
          const f = yield* family(dir)
          yield* step({ sessionID: f.child.id, parentID: f.childTurn.id, dir, change: write(f.a, "a1\n") })

          const after = yield* revert.revert({ sessionID: f.child.id, messageID: MessageID.ascending() })

          expect(yield* read(f.a)).toBe("a1\n")
          expect(after.revert).toBeUndefined()
        }),
      { git: true },
    ),
  )
})
