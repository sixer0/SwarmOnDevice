import path from "node:path"
import { afterEach, beforeEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = path.join(import.meta.dir, "../fixture/mcp-env-stdio.ts")

const CREDENTIALS = [
  "OPENCODE_SERVER_PASSWORD",
  "SWARM_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "SWARM_SERVER_USERNAME",
]
const before = new Map<string, string | undefined>()

beforeEach(() => {
  for (const name of [...CREDENTIALS, "opencode_server_password", "MCP_ENV_INHERITED"]) {
    before.set(name, process.env[name])
    process.env[name] = "row94-not-a-real-value"
  }
})

afterEach(() => {
  for (const [name, value] of before) {
    if (value === undefined) delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }
  before.clear()
})

/** What the real child process was started with, as it reports it. The shape of a config entry would prove nothing. */
const namesIn = (server: string, environment?: Record<string, string>) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add(server, { type: "local", command: [process.execPath, fixture], environment })
    const description = (yield* mcp.tools())[`${server}_env_names`]?.def.description
    expect(description).toBeString()
    return JSON.parse(description!) as string[]
  })

it.instance("F4: a local server does not get the server's credentials from this process", () =>
  Effect.gen(function* () {
    const names = yield* namesIn("inherited")
    expect(names.filter((name) => CREDENTIALS.includes(name.toUpperCase()))).toEqual([])
    expect(names).toContain("MCP_ENV_INHERITED")
    expect(names).toContain("PATH")
  }),
)

it.instance("F4: a server's own `environment` cannot put them back, and the rest of it still arrives", () =>
  Effect.gen(function* () {
    const names = yield* namesIn("configured", {
      OPENCODE_SERVER_PASSWORD: "row94-not-a-real-value",
      SWARM_SERVER_PASSWORD: "row94-not-a-real-value",
      swarm_server_username: "row94-not-a-real-value",
      MCP_ENV_CONFIGURED: "1",
    })
    expect(names.filter((name) => CREDENTIALS.includes(name.toUpperCase()))).toEqual([])
    expect(names).toContain("MCP_ENV_CONFIGURED")
  }),
)
