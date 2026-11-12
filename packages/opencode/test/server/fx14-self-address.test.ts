// 1.2.6 row FX-14 (F-1, decision C24): the port Swarm's own server listens on is known at runtime, so an agent's call to
// it is refused (X app_state) while it listens, and nothing is held once it stopped. Loopback only; no request is sent.
import { afterEach, expect, test } from "bun:test"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { SelfAddress } from "../../src/server/self-address"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("Server.listen records its own address; a curl to it is X app_state until it stops", async () => {
  await using fixture = await tmpdir({ git: true })
  const instance = { directory: fixture.path, worktree: fixture.path, project: { vcs: "git" } } as InstanceContext
  const curl = (port: number): AutonomyTable.Input => {
    const command = `curl -s http://127.0.0.1:${port}/session`
    return { permission: "bash", patterns: [command], metadata: { command }, instance, cwd: fixture.path, canUndo: true, folder: "clean" }
  }
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    expect(SelfAddress.list()).toContainEqual({ hostname: "127.0.0.1", port: listener.port })
    expect(AutonomyTable.classify({ ...curl(listener.port), bypass: { caller: "root" } })).toEqual({
      class: "X",
      decidedBy: "gate",
      category: "app_state",
    })
    expect(AutonomyTable.classify(curl(listener.port + 1)).category).not.toBe("app_state")
  } finally {
    await listener.stop(true)
  }
  expect(SelfAddress.list()).not.toContainEqual({ hostname: "127.0.0.1", port: listener.port })
  expect(AutonomyTable.classify({ ...curl(listener.port), bypass: { caller: "root" } }).category).not.toBe("app_state")
})
