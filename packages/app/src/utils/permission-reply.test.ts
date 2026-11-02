import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { heldVersion, replyHeld } from "./permission-reply"
import { createApiForServer, createSdkForServer } from "./server"
import { createCompatibleApi } from "./server-compat"

function setup(protocol: "v1" | "v2") {
  const requests: Request[] = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return new Response(undefined, { status: 204 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createCompatibleApi({
    protocol: Promise.resolve(protocol),
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    directory: "/repo",
  })
  return { api, requests }
}

const request = (metadata: Record<string, unknown>) => ({ id: "per_1", sessionID: "ses_1", metadata })

describe("replyHeld", () => {
  test("row 160b: a merged entry is answered with the list version the person saw", async () => {
    const { api, requests } = setup("v1")
    await replyHeld(api, { request: request({ version: 3, calls: [{}, {}, {}] }), reply: "once" })
    await replyHeld(api, { request: request({ version: 2 }), reply: "always", location: { directory: "/other" } })
    await replyHeld(api, { request: request({ version: 2 }), reply: "reject" })

    expect(new URL(requests[0]!.url).pathname).toBe("/session/ses_1/permissions/per_1")
    expect(await requests[0]!.json()).toEqual({ response: "once", version: 3 })
    expect(new URL(requests[1]!.url).searchParams.get("directory")).toBe("/other")
    expect(await requests[1]!.json()).toEqual({ response: "always", version: 2 })
    expect(await requests[2]!.json()).toEqual({ response: "reject", version: 2 })
  })

  test("row 160b: a single call or a malformed version sends no version (the server reads it as 1)", async () => {
    const { api, requests } = setup("v1")
    for (const metadata of [{}, { version: 0 }, { version: -1 }, { version: 1.5 }, { version: "2" }, { version: null }])
      await replyHeld(api, { request: request(metadata), reply: "once" })

    expect(requests).toHaveLength(6)
    for (const sent of requests) expect(await sent.json()).toEqual({ response: "once" })
  })

  test("row 160b: the current protocol route still gets the same answer", async () => {
    const { api, requests } = setup("v2")
    await replyHeld(api, { request: request({ version: 2 }), reply: "once" })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/permission/per_1/reply")
    expect(await requests[0]!.json()).toMatchObject({ reply: "once" })
  })

  test("row 160c: only a positive whole number is a list version", () => {
    for (const version of [0, -1, 1.5, "2", null]) expect(heldVersion({ version })).toBeUndefined()
    expect(heldVersion(undefined)).toBeUndefined()
    expect(heldVersion({ version: 2 })).toBe(2)
  })

  // Guard: no reply place builds its own payload. Only the helper and the compat adapter call reply directly.
  test("row 160b: every permission reply in the app goes through replyHeld", async () => {
    const root = path.join(import.meta.dir, "..")
    const files = (await readdir(root, { recursive: true }))
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .sort()
    const direct: string[] = []
    const through: string[] = []
    for (const file of files) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/permission\s*\.\s*(reply|respond)\s*\(/.test(text)) direct.push(file)
      if (/\breplyHeld\s*\(/.test(text)) through.push(file)
    }

    expect(direct).toEqual([path.join("utils", "permission-reply.ts"), path.join("utils", "server-compat.ts")])
    expect(through).toEqual(
      expect.arrayContaining([
        path.join("pages", "home", "agent-board-controller.ts"),
        path.join("pages", "session", "composer", "session-composer-state.ts"),
        path.join("pages", "session", "map", "session-map-view.tsx"),
        path.join("pages", "session", "swarm", "swarm-controller.ts"),
      ]),
    )
    const compat = await Bun.file(path.join(root, "utils", "server-compat.ts")).text()
    expect(compat).toContain("version: value.version")
  })
})
