// Row 38c (P-01c, SEC-06): the checkpoints the Decisions list offers to put back, and the desktop nonce that the
// revert and archive-empty routes want, asked for on each call and sent as `x-swarm-desktop-nonce`.
import { afterEach, describe, expect, test } from "bun:test"
import type { AutonomyAuditLine } from "@opencode-ai/sdk/v2"
import path from "path"
import {
  checkpointsOf,
  desktopNonce,
  DESKTOP_NONCE_HEADER,
  nonceHeader,
  sendArchiveEmpty,
  sendCheckpointRevert,
} from "./session-map-model"

let seq = 0
const outcome = (fields: Record<string, unknown>) =>
  ({ v: 1, seq: ++seq, prev: "", at: 100 + seq, type: "outcome", ...fields }) as AutonomyAuditLine
const checkpointed = (id: string, extra: Record<string, unknown> = {}) =>
  outcome({
    requestID: `req_${id}`,
    outcome: "checkpointed",
    checkpoint: id,
    entries: 3,
    manifestSha256: "f".repeat(64),
    ...extra,
  })

const NONCE = "N".repeat(43)

describe("checkpointsOf", () => {
  test("only checkpointed lines with a manifest sha, first line per id, latest first", () => {
    const items = checkpointsOf([
      outcome({ requestID: "a", outcome: "ran" }),
      checkpointed("ck_1"),
      checkpointed("ck_nosha", { manifestSha256: undefined }),
      outcome({ requestID: "b", outcome: "archived", archive: "x" }),
      checkpointed("ck_2"),
      checkpointed("ck_1", { entries: 99 }),
    ])
    expect(items.map((item) => item.id)).toEqual(["ck_2", "ck_1"])
    expect(items.find((item) => item.id === "ck_1")!.entries).toBe(3)
    expect(items.every((item) => !item.reverted)).toBe(true)
  })

  test("reverted only by the route's own revert_<id> undone line", () => {
    const items = checkpointsOf([
      checkpointed("ck_1"),
      checkpointed("ck_2"),
      outcome({ requestID: "revert_ck_1", outcome: "undone", checkpoint: "ck_1", by: "person" }),
      outcome({ requestID: "other", outcome: "undone", checkpoint: "ck_2" }),
    ])
    expect(items.map((item) => [item.id, item.reverted])).toEqual([
      ["ck_2", false],
      ["ck_1", true],
    ])
  })

  test("no checkpoint lines: nothing to offer", () => {
    expect(checkpointsOf([])).toEqual([])
    expect(checkpointsOf([outcome({ requestID: "a", outcome: "ran" })])).toEqual([])
  })
})

describe("desktop nonce on the person-only routes", () => {
  const global = globalThis as { api?: unknown }
  afterEach(() => {
    delete global.api
  })

  test("the header name is the server's", () => {
    expect(DESKTOP_NONCE_HEADER).toBe("x-swarm-desktop-nonce")
    expect(nonceHeader(NONCE)).toEqual({ "x-swarm-desktop-nonce": NONCE })
    expect(nonceHeader(null)).toEqual({})
    expect(nonceHeader(undefined)).toEqual({})
    expect(nonceHeader("")).toEqual({})
  })

  test("checkpointRevert is called for the root and checkpoint with the nonce asked for at call time", async () => {
    const sent: unknown[] = []
    let asked = 0
    const result = await sendCheckpointRevert(
      async (input) => {
        sent.push(input)
        return { data: { id: "ck_1", preRevert: "ck_pre", restored: ["a.txt"], verified: true } }
      },
      async () => {
        asked++
        return NONCE
      },
      "root",
      "ck_1",
    )
    expect(asked).toBe(1)
    expect(sent).toEqual([{ sessionID: "root", checkpointID: "ck_1", "x-swarm-desktop-nonce": NONCE }])
    expect(result.data.preRevert).toBe("ck_pre")
  })

  test("without a nonce (web build, a server the app did not start) the call goes without the header", async () => {
    const sent: unknown[] = []
    await sendCheckpointRevert(
      async (input) => sent.push(input),
      async () => null,
      "root",
      "ck_1",
    )
    expect(sent).toEqual([{ sessionID: "root", checkpointID: "ck_1" }])
  })

  test("a refusal from the route reaches the caller", async () => {
    const refusal = { data: { message: "Reverting a checkpoint is only taken from the Swarm desktop app" } }
    await expect(
      sendCheckpointRevert(
        async () => {
          throw refusal
        },
        async () => null,
        "root",
        "ck_1",
      ),
    ).rejects.toBe(refusal)
  })

  test("archiveEmpty now sends the same header, with the ids the confirmation listed", async () => {
    const sent: unknown[] = []
    await sendArchiveEmpty(
      async (input) => sent.push(input),
      async () => NONCE,
      { sessionID: "root", ids: ["a1", "a2"] },
    )
    expect(sent).toEqual([{ sessionID: "root", ids: ["a1", "a2"], "x-swarm-desktop-nonce": NONCE }])
  })

  test("desktopNonce reads window.api.desktopNonce each time, and is null without it or when it throws", async () => {
    expect(await desktopNonce()).toBeNull()
    let calls = 0
    global.api = { desktopNonce: async () => (++calls, NONCE) }
    expect(await desktopNonce()).toBe(NONCE)
    expect(await desktopNonce()).toBe(NONCE)
    expect(calls).toBe(2)
    global.api = { desktopNonce: async () => null }
    expect(await desktopNonce()).toBeNull()
    global.api = {
      desktopNonce: () => {
        throw new Error("no bridge")
      },
    }
    expect(await desktopNonce()).toBeNull()
  })

  test("the view sends both person-only routes through these helpers, never the bare client call", async () => {
    const view = await Bun.file(path.join(import.meta.dir, "session-map-view.tsx")).text()
    expect(view).toContain(
      "sendCheckpointRevert((body) => sdk().client.autonomy.checkpointRevert(body), desktopNonce, root, id)",
    )
    expect(view).toContain("sendArchiveEmpty((body) => sdk().client.autonomy.archiveEmpty(body), desktopNonce, input)")
    expect(view).not.toMatch(/client\.autonomy\.archiveEmpty\(input\)/)
    expect(view.match(/client\.autonomy\.(checkpointRevert|archiveEmpty)\(/g)).toHaveLength(2)
    // The nonce is never kept in the store or written to the log.
    expect(view).not.toMatch(/setStore\([^)]*nonce/i)
    expect(view).not.toMatch(/report\([^)]*nonce/i)
  })
})
