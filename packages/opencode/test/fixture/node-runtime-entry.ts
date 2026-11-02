// Built for Node and run there by test/runtime/node-sidecar.test.ts, so nothing here may import bun:test or the test fixtures.
// The packaged app's server has no `Bun` global, and a test running under Bun cannot notice a call to it.
import { spawn } from "node:child_process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { InstanceRef } from "../../src/effect/instance-ref"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { MessageID, SessionID } from "../../src/session/schema"
import { GitTool } from "../../src/tool/git"
import { ShellOrphans } from "../../src/tool/shell/orphans"
import { Truncate } from "../../src/tool/truncate"

const input: { repo: string; commands: string[] } = JSON.parse(process.argv[2]!)
const instance = {
  directory: input.repo,
  worktree: input.repo,
  project: { vcs: "git" },
} as InstanceContext

const gitStatus = Effect.gen(function* () {
  const tool = yield* (yield* GitTool).init()
  return yield* tool.execute({ subcommand: "status" } as never, {
    sessionID: SessionID.make("ses_node"),
    messageID: MessageID.make("msg_node"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    trust: { canUndo: true },
    ask: () => Effect.void,
  } as never)
}).pipe(
  Effect.provideService(InstanceRef, instance),
  Effect.provide(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Truncate.node, Agent.node]))),
  Effect.map((result) => ({ out: result.output })),
  Effect.catchCause((cause) => Effect.succeed({ failed: String(cause) })),
  Effect.scoped,
)

// A command the last server left running, the one branch of ending it that waits.
const orphan = async () => {
  const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })
  child.unref()
  const session = `ses_node_${process.pid}`
  ShellOrphans.record(session, child.pid!, { pid: 2 ** 22 - 1, started: "Thu Jan  1 00:00:00 1970" })
  try {
    return { ended: await ShellOrphans.end(session) }
  } catch (error) {
    try {
      process.kill(-child.pid!, "SIGKILL")
    } catch {
      // Already gone.
    }
    return { failed: String(error) }
  }
}

const routine = (command: string) => {
  try {
    return AutonomyTable.routine(command, input.repo, instance) ?? null
  } catch (error) {
    return `threw: ${String(error)}`
  }
}

console.log(
  JSON.stringify({
    hasBun: "Bun" in globalThis,
    routine: Object.fromEntries(input.commands.map((command) => [command, routine(command)])),
    git: await Effect.runPromise(gitStatus),
    orphan: await orphan(),
  }),
)
process.exit(0)
