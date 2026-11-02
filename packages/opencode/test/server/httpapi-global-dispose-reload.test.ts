// Row 229b: POST /global/dispose rereads the global swarm.json.
// swarm-setup writes an MCP entry into the global config while the server is running, and the
// desktop app then sends POST /global/dispose. Before row 229b the global config was cached with
// an infinite TTL and dispose never invalidated it, so the new server only appeared after a restart.
// The entries are disabled so no process is spawned. test/preload.ts pins XDG_CONFIG_HOME to a tmp dir.
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)
const it = testEffect(Layer.mergeAll(testStateLayer, httpApiLayer))

const globalFile = () => path.join(Global.Path.config, "swarm.json")
const SERVER = "row229b-web"
const valid = { mcp: { [SERVER]: { type: "local", command: ["row229b-proxy"], enabled: false } } }
// Schema violation: `command` must be an array of strings.
const invalid = { mcp: { [SERVER]: { type: "local", command: "row229b-proxy", enabled: false } } }

const writeGlobal = (value: unknown) => Effect.promise(() => fs.writeFile(globalFile(), JSON.stringify(value, null, 2)))

const mcp = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(McpPaths.status, directory)
    const text = yield* response.text
    return { status: response.status, body: text }
  })

const dispose = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory("/global/dispose", directory, { method: "POST" })
    expect(response.status).toBe(200)
  })

// Keeps whatever swarm.json the preload left and restores it, so tests do not leak into each other.
const withGlobalFile = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = yield* Effect.promise(() => fs.readFile(globalFile(), "utf8").catch(() => undefined))
    return yield* body.pipe(
      Effect.ensuring(
        Effect.promise(() =>
          before === undefined ? fs.rm(globalFile(), { force: true }) : fs.writeFile(globalFile(), before),
        ),
      ),
    )
  })

describe("POST /global/dispose rereads the global config", () => {
  it.instance("an MCP server written after the first read is listed after one dispose", () =>
    withGlobalFile(
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() => fs.rm(globalFile(), { force: true }))

        const first = yield* mcp(directory)
        expect(first.status).toBe(200)
        expect(Object.keys(JSON.parse(first.body))).not.toContain(SERVER)

        yield* writeGlobal(valid)
        yield* dispose(directory)

        const after = yield* mcp(directory)
        expect(after.status).toBe(200)
        expect(JSON.parse(after.body)).toEqual(expect.objectContaining({ [SERVER]: { status: "disabled" } }))
      }),
    ),
  )

  it.instance("an invalid config after dispose fails closed, as at boot, and a fixed file recovers", () =>
    withGlobalFile(
      Effect.gen(function* () {
        const { directory } = yield* TestInstance

        yield* writeGlobal(valid)
        yield* dispose(directory)
        const loaded = yield* mcp(directory)
        expect(loaded.status).toBe(200)
        expect(Object.keys(JSON.parse(loaded.body))).toContain(SERVER)

        // The file turns invalid while the server runs. The reread is validated like boot: the invalid
        // entry is not listed, the stale cached copy of the valid one is not kept, and the response is
        // the same one boot gives for this file (see the boot baseline below).
        yield* writeGlobal(invalid)
        yield* dispose(directory)
        const broken = yield* mcp(directory)
        expect(broken.status).toBe(200)
        expect(JSON.parse(broken.body)).toEqual({})

        // Fixing the file and disposing again brings the entry back without a restart.
        yield* writeGlobal(valid)
        yield* dispose(directory)
        const fixed = yield* mcp(directory)
        expect(fixed.status).toBe(200)
        expect(Object.keys(JSON.parse(fixed.body))).toContain(SERVER)
      }),
    ),
  )

  // Boot baselines: `init` writes the global file before the instance boots, so the first read is the
  // boot read. The valid control proves that; the invalid case records what boot does with that file.
  it.instance(
    "boot baseline: a valid global file present before boot is listed",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const boot = yield* mcp(directory)
        expect(boot.status).toBe(200)
        expect(Object.keys(JSON.parse(boot.body))).toContain(SERVER)
      }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(globalFile(), { force: true })))),
    { init: () => writeGlobal(valid) },
  )

  it.instance(
    "boot baseline: the same invalid global file present before boot gives an empty list",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const boot = yield* mcp(directory)
        expect(boot.status).toBe(200)
        expect(JSON.parse(boot.body)).toEqual({})
      }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(globalFile(), { force: true })))),
    { init: () => writeGlobal(invalid) },
  )
})
