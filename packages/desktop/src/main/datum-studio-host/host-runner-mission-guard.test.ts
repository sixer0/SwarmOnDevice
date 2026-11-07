// Integration pass I-2 (row 119b, C77, U19): the runner opens the Studio store with the mission guard on.
import { expect, test } from "bun:test"
import { runStudioHost, type ParentPortLike } from "./host-runner"
import type { HostMessage, StudioHostModule } from "./protocol"

test("I-2: openHostStore gets missionGuard: true next to release and logFile", async () => {
  const opened: Array<Parameters<StudioHostModule["openHostStore"]>[1]> = []
  const posted: HostMessage[] = []
  let listener: ((event: { data: unknown }) => void) | undefined
  const port: ParentPortLike = { postMessage: (m) => void posted.push(m), on: (_e, l) => void (listener = l) }
  const store = { close: async () => {} }
  const mod: StudioHostModule = {
    openHostStore: async (_root, opts) => {
      opened.push(opts)
      return store
    },
    closeHostStore: async () => {},
    configureTemplateSource: () => {},
    startStudioHostServer: async () => ({ url: "http://127.0.0.1:1/mcp", close: async () => {} }),
  }
  runStudioHost(port, async () => mod)
  listener!({
    data: {
      type: "start",
      token: "a".repeat(64),
      hostname: "127.0.0.1",
      storeRoot: "/fixture/store",
      storeLogFile: "/fixture/store/logs/datum-studio-store.jsonl",
      templatesDir: "/fixture/Res/datum-studio/templates",
      assetRepoRoot: "/fixture/Res/datum-studio",
      release: "1.2.0",
    },
  })
  await new Promise((r) => setTimeout(r, 10))
  expect(opened).toEqual([{ release: "1.2.0", logFile: "/fixture/store/logs/datum-studio-store.jsonl", missionGuard: true }])
  expect(posted.at(-1)?.type).toBe("ready")
})
