/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import { directory } from "../../../fixture/tui-sdk"

const sessionID = "ses_attached"
const spend: PermissionRequest = {
  id: "per_spend",
  sessionID,
  permission: "spend_limit",
  patterns: ["$12.04 of $10.00"],
  metadata: { spent: 12.04, limit: 10 },
  always: [],
}
const asked: QuestionRequest = {
  id: "que_open",
  sessionID,
  questions: [{ question: "Which database?", header: "DB", options: [{ label: "SQLite", description: "" }] }],
}
const event = (payload: GlobalEvent["payload"]): GlobalEvent => ({ directory, project: "proj_test", payload })

test("a client attaching to a run sees what is already waiting, including the spend question", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, sync } = await mount((url) => {
    if (url.pathname === "/permission") return json([spend])
    if (url.pathname === "/question") return json([asked])
  }, tmp.path)
  try {
    await wait(() => (sync.data.permission[sessionID]?.length ?? 0) === 1)
    expect(sync.data.permission[sessionID][0].permission).toBe("spend_limit")
    await wait(() => (sync.data.question[sessionID]?.length ?? 0) === 1)
    expect(sync.data.question[sessionID][0].id).toBe("que_open")
  } finally {
    app.renderer.destroy()
  }
})

test("a request answered while the read is in flight does not come back", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let hold = false
  let reached = false
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const { app, emit, sync } = await mount(async (url) => {
    if (url.pathname === `/session/${sessionID}`)
      return json({ id: sessionID, title: "x", directory, version: "1", time: { created: 1, updated: 1 } })
    if (url.pathname.startsWith(`/session/${sessionID}/`)) return json([])
    if (url.pathname !== "/permission" || !hold) return undefined
    reached = true
    await held
    return json([spend])
  }, tmp.path)
  try {
    hold = true
    const opening = sync.session.sync(sessionID)
    await wait(() => reached)
    emit(event({ id: "evt_replied", type: "permission.replied", properties: { sessionID, requestID: spend.id, reply: "reject" } }))
    release()
    await opening
    expect(sync.data.permission[sessionID]?.length ?? 0).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("auto mode leaves the spend limit and a repeating call for a person, and still approves the rest", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const replied: string[] = []
  const { app, emit, sync } = await mount(
    (url) => {
      const match = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname)
      if (!match) return undefined
      replied.push(match[1])
      return json(true)
    },
    tmp.path,
    { auto: true },
  )
  try {
    const request = (id: string, permission: string) =>
      event({
        id: `evt_${id}`,
        type: "permission.asked",
        properties: { ...spend, id, permission },
      })
    emit(request("per_a_spend", "spend_limit"))
    emit(request("per_b_loop", "doom_loop"))
    emit(request("per_c_bash", "bash"))
    await wait(() => replied.length === 1)
    expect(replied).toEqual(["per_c_bash"])
    expect(sync.data.permission[sessionID].map((item) => item.id)).toEqual(["per_a_spend", "per_b_loop"])
  } finally {
    app.renderer.destroy()
  }
})
