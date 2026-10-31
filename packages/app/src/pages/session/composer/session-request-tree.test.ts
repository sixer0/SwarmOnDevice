import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { sessionMovedOnRequests, sessionPermissionRequest } from "./session-request-tree"

const session = (id: string, parentID?: string) => ({ id, parentID }) as Session
const permission = (id: string, sessionID: string, movedOnAt?: number) =>
  ({ id, sessionID, permission: "bash", patterns: [], metadata: {}, always: [], movedOnAt }) as PermissionRequest
const question = (id: string, sessionID: string, movedOnAt?: number) =>
  ({ id, sessionID, questions: [], movedOnAt }) as QuestionRequest

describe("sessionMovedOnRequests", () => {
  const sessions = [session("root"), session("child", "root"), session("other")]

  test("collects skipped requests from subagents, oldest first, and leaves live ones out", () => {
    const items = sessionMovedOnRequests(
      () => sessions,
      { root: [permission("p1", "root", 30), permission("p2", "root")], other: [permission("p3", "other", 1)] },
      { child: [question("q1", "child", 20)] },
      "root",
    )
    expect(items.map((item) => item.request.id)).toEqual(["q1", "p1"])
    expect(items.map((item) => item.kind)).toEqual(["question", "permission"])
  })

  test("does not look at sessions when nothing moved on", () => {
    const untouched = () => {
      throw new Error("read sessions")
    }
    expect(sessionMovedOnRequests(untouched, { root: [permission("p2", "root")] }, {}, "root")).toEqual([])
  })

  test("is empty without a session", () => {
    expect(sessionMovedOnRequests(() => sessions, {}, {}, undefined)).toEqual([])
  })

  test("the prompt position can skip a moved-on request and still find a live one behind it", () => {
    const found = sessionPermissionRequest(
      sessions,
      { root: [permission("p1", "root", 30), permission("p2", "root")] },
      "root",
      (item) => !item.movedOnAt,
    )
    expect(found?.id).toBe("p2")
  })
})
