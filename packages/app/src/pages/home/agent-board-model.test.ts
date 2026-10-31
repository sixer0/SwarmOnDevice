import { describe, expect, test } from "bun:test"
import type { Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import {
  agentSnapshotSessions,
  agentSnapshotBaseline,
  agentSnapshotWrites,
  buildAgentBoard,
  inlineQuestion,
  permissionDetail,
  type AgentBoardInput,
} from "./agent-board-model"

const session = (id: string, extra: Partial<Session> = {}) =>
  ({ id, title: id, directory: "/work/a", time: { created: 1, updated: 1 }, ...extra }) as Session
const permission = (id: string, sessionID: string, extra: Partial<PermissionRequest> = {}) =>
  ({ id, sessionID, permission: "bash", patterns: ["ls"], metadata: {}, always: [], ...extra }) as PermissionRequest
const question = (id: string, sessionID: string, extra: Partial<QuestionRequest> = {}) =>
  ({
    id,
    sessionID,
    questions: [{ question: "Go?", header: "Go", options: [{ label: "Yes", description: "" }] }],
    ...extra,
  }) as QuestionRequest

const input = (extra: Partial<AgentBoardInput>): AgentBoardInput => ({
  info: {},
  permission: {},
  question: {},
  status: {},
  recent: [],
  unseen: () => [],
  autoResponds: () => false,
  inScope: () => true,
  ...extra,
})

describe("buildAgentBoard", () => {
  test("orders requests longest-waiting first across kinds and sessions", () => {
    const board = buildAgentBoard(
      input({
        info: { s1: session("s1"), s2: session("s2") },
        permission: { s1: [permission("per_3", "s1")], s2: [permission("per_1", "s2")] },
        question: { s1: [question("per_2", "s1")] },
      }),
    )
    expect(board.needs.map((need) => need.key)).toEqual(["per_1", "per_2", "per_3"])
  })

  test("rolls a subagent's request up to its root and keeps the reply target on the child", () => {
    const board = buildAgentBoard(
      input({
        info: { root: session("root"), child: session("child", { parentID: "root" }) },
        permission: { child: [permission("per_1", "child")] },
      }),
    )
    expect(board.needs[0]?.root.id).toBe("root")
    expect(board.needs[0]?.session.id).toBe("child")
  })

  test("asks for sessions it cannot place instead of dropping the request silently", () => {
    const board = buildAgentBoard(
      input({
        info: { child: session("child", { parentID: "root" }) },
        permission: { child: [permission("per_1", "child")], other: [permission("per_2", "other")] },
      }),
    )
    expect(board.needs).toEqual([])
    expect(board.missing.toSorted()).toEqual(["other", "root"])
  })

  test("a request the session auto-accepts is not shown", () => {
    const board = buildAgentBoard(
      input({
        info: { s1: session("s1") },
        permission: { s1: [permission("per_1", "s1")] },
        autoResponds: () => true,
      }),
    )
    expect(board.needs).toEqual([])
  })

  test("a session blocked on the user is not also listed as running", () => {
    const board = buildAgentBoard(
      input({
        info: {
          blocked: session("blocked"),
          child: session("child", { parentID: "blocked" }),
          busy: session("busy"),
          done: session("done"),
        },
        permission: { child: [permission("per_1", "child")] },
        status: {
          blocked: { type: "busy" },
          busy: { type: "busy" },
          done: { type: "idle" },
        },
      }),
    )
    expect(board.running.map((item) => item.key)).toEqual(["busy"])
  })

  test("several active subagents collapse into one running row showing the root's own status", () => {
    const retry = { type: "retry", attempt: 2, message: "rate limited", next: 1 } satisfies SessionStatus
    const board = buildAgentBoard(
      input({
        info: {
          root: session("root"),
          c1: session("c1", { parentID: "root" }),
          c2: session("c2", { parentID: "root" }),
        },
        status: { c1: { type: "busy" }, root: retry, c2: { type: "busy" } },
      }),
    )
    expect(board.running).toEqual([{ key: "root", root: expect.objectContaining({ id: "root" }), status: retry }])
  })

  test("lists unread failures, skipping active sessions", () => {
    const recent = ["failed", "older", "busy", "read"].map((id) => session(id))
    const board = buildAgentBoard(
      input({
        info: Object.fromEntries(recent.map((item) => [item.id, item])),
        status: { busy: { type: "busy" } },
        recent,
        unseen: (id) =>
          ({
            failed: [
              { type: "turn-complete" as const, time: 1 },
              { type: "error" as const, time: 2, error: { name: "x" } },
            ],
            older: [{ type: "turn-complete" as const, time: 3 }],
            busy: [{ type: "turn-complete" as const, time: 5 }],
          })[id] ?? [],
      }),
    )
    expect(board.failed.map((item) => item.key)).toEqual(["failed"])
    expect(board.failed[0]?.error).toEqual({ name: "x" })
  })

  test("a session the user stopped themselves is not reported as failed", () => {
    const stopped = session("stopped")
    const board = buildAgentBoard(
      input({
        info: { stopped },
        recent: [stopped],
        unseen: () => [{ type: "error", time: 1, error: { name: "MessageAbortedError", data: {} } }],
      }),
    )
    expect(board.failed).toEqual([])
  })

  test("project scope filters every section", () => {
    const here = session("here")
    const there = session("there", { directory: "/work/b" })
    const board = buildAgentBoard(
      input({
        info: { here, there },
        permission: { there: [permission("per_1", "there")] },
        question: { there: [question("que_1", "there")] },
        status: { there: { type: "busy" }, here: { type: "busy" } },
        recent: [there],
        unseen: () => [{ type: "turn-complete", time: 1 }],
        inScope: (directory) => directory === "/work/a",
      }),
    )
    expect(board.needs).toEqual([])
    expect(board.running.map((item) => item.key)).toEqual(["here"])
  })
})

describe("row details", () => {
  test("a permission shows its literal command, falling back to what it touches", () => {
    expect(permissionDetail(permission("p", "s", { metadata: { command: "rm -rf build" } }))).toBe("rm -rf build")
    expect(permissionDetail(permission("p", "s", { patterns: ["a.ts", "b.ts"] }))).toBe("a.ts\nb.ts")
  })

  test("only one single-select question with options can be answered inline", () => {
    expect(inlineQuestion(question("q", "s"))?.question).toBe("Go?")
    const base = question("q", "s").questions[0]!
    expect(inlineQuestion(question("q", "s", { questions: [base, base] }))).toBeUndefined()
    expect(inlineQuestion(question("q", "s", { questions: [{ ...base, multiple: true }] }))).toBeUndefined()
    expect(inlineQuestion(question("q", "s", { questions: [{ ...base, options: [] }] }))).toBeUndefined()
  })

})

describe("agentSnapshotWrites", () => {
  const store = {
    info: {
      kept: session("kept"),
      stale: session("stale"),
      remote: session("remote", { directory: "/remote/x" }),
    } as AgentBoardInput["info"],
    permission: {
      stale: [permission("per_old", "stale")],
      remote: [permission("per_remote", "remote")],
    },
    question: { stale: [question("que_old", "stale")] },
    session_status: { stale: { type: "busy" }, remote: { type: "busy" } } as Record<string, SessionStatus>,
  }

  const snapshot = {
    instances: [
      {
        directory: "/work/a",
        status: { kept: { type: "busy" as const } },
        permission: [permission("per_2", "kept"), permission("per_1", "kept")],
        question: [question("que_1", "new")],
      },
    ],
  }

  test("seeds pending work and clears what the reporting directory no longer lists", () => {
    const writes = agentSnapshotWrites(store, snapshot)
    const permissions = Object.fromEntries(writes.permission.map(([id, list]) => [id, list.map((item) => item.id)]))
    expect(permissions).toEqual({ stale: [], kept: ["per_1", "per_2"] })
    expect(Object.fromEntries(writes.question.map(([id, list]) => [id, list.map((item) => item.id)]))).toEqual({
      stale: [],
      new: ["que_1"],
    })
    expect(Object.fromEntries(writes.status)).toEqual({ kept: { type: "busy" } })
    expect(writes.clearStatus).toEqual(["stale"])
  })

  test("leaves sessions alone when no reporting instance covers their directory", () => {
    const writes = agentSnapshotWrites(store, snapshot)
    expect(writes.permission.some(([id]) => id === "remote")).toBe(false)
    expect(writes.clearStatus).not.toContain("remote")
  })

  describe("an answer older than what happened while it was on the way", () => {
    const listed = (id: string, sessionID = "kept") => ({
      instances: [
        {
          directory: "/work/a",
          status: {},
          permission: [permission(id, sessionID)],
          question: [],
        },
      ],
    })
    const base = {
      info: { kept: session("kept") } as AgentBoardInput["info"],
      question: {},
    }

    test("does not bring back a request answered in the meantime", () => {
      const before = { ...base, permission: { kept: [permission("per_1", "kept")] }, session_status: {} }
      const baseline = agentSnapshotBaseline(before)
      const now = { ...base, permission: { kept: [] }, session_status: {} }
      const writes = agentSnapshotWrites(now, listed("per_1"), baseline)
      expect(writes.permission).toEqual([["kept", []]])
    })

    test("keeps a request that arrived in the meantime and still shows a new one", () => {
      const baseline = agentSnapshotBaseline({ ...base, permission: {}, session_status: {} })
      const now = { ...base, permission: { kept: [permission("per_2", "kept")] }, session_status: {} }
      const writes = agentSnapshotWrites(now, listed("per_1"), baseline)
      expect(writes.permission[0]![1].map((item) => item.id)).toEqual(["per_1", "per_2"])
    })

    test("does not clear or overwrite a status that changed in the meantime", () => {
      const quiet = { ...base, permission: {}, question: {} }
      const baseline = agentSnapshotBaseline({ ...quiet, session_status: {} })
      const now = { ...quiet, session_status: { kept: { type: "busy" } } as Record<string, SessionStatus> }
      const empty = { instances: [{ directory: "/work/a", status: {}, permission: [], question: [] }] }
      expect(agentSnapshotWrites(now, empty, baseline).clearStatus).toEqual([])
      const idle = { instances: [{ ...empty.instances[0]!, status: { kept: { type: "idle" as const } } }] }
      expect(agentSnapshotWrites(now, idle, baseline).status).toEqual([])
    })

    test("still clears a status nothing has touched", () => {
      const quiet = { ...base, permission: {}, question: {} }
      const held = { ...quiet, session_status: { kept: { type: "busy" } } as Record<string, SessionStatus> }
      const empty = { instances: [{ directory: "/work/a", status: {}, permission: [], question: [] }] }
      expect(agentSnapshotWrites(held, empty, agentSnapshotBaseline(held)).clearStatus).toEqual(["kept"])
    })
  })

  test("names every session the snapshot refers to, once", () => {
    expect(agentSnapshotSessions(snapshot).toSorted()).toEqual(["kept", "new"])
  })
})
