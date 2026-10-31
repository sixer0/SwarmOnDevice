import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, Session } from "@opencode-ai/sdk/v2"
import {
  buildAxis,
  buildSwarm,
  coalesceSegments,
  defaultLane,
  laneTitle,
  mergeIntervals,
  sessionTree,
  swarmPulse,
  type SwarmInput,
  type SwarmSegment,
} from "./swarm-model"

const session = (id: string, input: Partial<Session> = {}) =>
  ({
    id,
    title: id,
    directory: "/repo",
    time: { created: 1000, updated: 1000 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...input,
  }) as unknown as Session

const user = (id: string, sessionID: string, created: number) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "general",
    model: { providerID: "p", modelID: "m" },
  }) as unknown as Message

const assistant = (
  id: string,
  sessionID: string,
  parentID: string,
  created: number,
  input: Record<string, unknown> = {},
) =>
  ({
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: { created, completed: created + 100 },
    cost: 0,
    ...input,
  }) as unknown as Message

const textPart = (id: string, text: string) => ({ id, type: "text", text }) as unknown as Part

const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  start: number,
  end: number | undefined,
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    type: "tool",
    tool: name,
    state:
      end === undefined
        ? { status: "running", input, time: { start }, title: "", metadata: {} }
        : { status: "completed", input, time: { start, end }, title: "", output: "", metadata: {}, ...extra },
  }) as unknown as Part

function input(
  info: Session[],
  messages: Record<string, Message[]>,
  parts: Record<string, Part[]>,
  rest: Partial<SwarmInput> = {},
): SwarmInput {
  return {
    rootID: "root",
    info: Object.fromEntries(info.map((item) => [item.id, item])),
    status: {},
    permission: {},
    question: {},
    messages: (id) => messages[id],
    parts: (id) => parts[id] ?? [],
    now: 100_000,
    ...rest,
  }
}

describe("sessionTree", () => {
  test("walks parents before children, oldest sibling first", () => {
    const info = {
      root: session("root"),
      b: session("b", { parentID: "root", time: { created: 2000, updated: 0 } }),
      a: session("a", { parentID: "root", time: { created: 1500, updated: 0 } }),
      n: session("n", { parentID: "b" }),
      other: session("other"),
    }
    expect(sessionTree("root", info)).toEqual([
      { id: "root", depth: 0 },
      { id: "a", depth: 1 },
      { id: "b", depth: 1 },
      { id: "n", depth: 2 },
    ])
  })

  test("survives a cycle and skips archived children", () => {
    const info = {
      root: session("root", { parentID: "c" }),
      c: session("c", { parentID: "root" }),
      old: session("old", { parentID: "root", time: { created: 1, updated: 1, archived: 2 } }),
    }
    expect(sessionTree("root", info).map((item) => item.id)).toEqual(["root", "c"])
  })
})

describe("laneTitle", () => {
  test("drops the suffix the task tool adds", () => {
    expect(laneTitle({ title: "Fix totals (@general subagent)" })).toBe("Fix totals")
    expect(laneTitle({ title: "Fix (@work) totals" })).toBe("Fix (@work) totals")
  })
})

describe("mergeIntervals", () => {
  test("merges within the tolerance", () => {
    expect(
      mergeIntervals(
        [
          [10, 20],
          [0, 5],
          [24, 30],
        ],
        4,
      ),
    ).toEqual([
      [0, 5],
      [10, 30],
    ])
    expect(
      mergeIntervals([
        [0, 5],
        [6, 7],
      ]),
    ).toEqual([
      [0, 5],
      [6, 7],
    ])
  })
})

describe("buildAxis", () => {
  test("is monotonic and spans the unit range", () => {
    const axis = buildAxis([
      [0, 60_000],
      [30_000, 90_000],
    ])
    expect(axis.x(0)).toBe(0)
    expect(axis.x(90_000)).toBeCloseTo(1)
    expect(axis.x(30_000)).toBeLessThan(axis.x(60_000))
  })

  test("a three day gap between turns becomes a sliver, not most of the chart", () => {
    const day = 86_400_000
    const axis = buildAxis([
      [0, 60_000],
      [3 * day, 3 * day + 60_000],
    ])
    const firstEnd = axis.x(60_000)
    const secondStart = axis.x(3 * day)
    expect(secondStart - firstEnd).toBeCloseTo(0.03)
    expect(firstEnd).toBeCloseTo(0.485)
    expect(axis.x(day)).toBe(secondStart)
  })

  test("is safe with nothing and with one instant", () => {
    expect(buildAxis([]).x(5)).toBe(0)
    const axis = buildAxis([[500, 500]])
    expect(axis.x(500)).toBe(0)
    expect(Number.isFinite(axis.x(600))).toBe(true)
  })

})

describe("coalesceSegments", () => {
  const seg = (id: string, start: number, kind: SwarmSegment["kind"]) =>
    ({ id, kind, start, end: start + 1, running: false, label: id, count: 1 }) as unknown as SwarmSegment

  test("a failure hidden among close steps still colours the cell", () => {
    const cells = coalesceSegments(
      [seg("a", 0, "explore"), seg("b", 1, "problem"), seg("c", 2, "edit")],
      (at) => at / 1000,
    )
    expect(cells).toHaveLength(1)
    expect(cells[0]!.kind).toBe("problem")
    expect(cells[0]!.label).toBe("b")
    expect(cells[0]!.count).toBe(3)
  })

  test("distant steps stay apart, and a thousand steps collapse to a bounded number", () => {
    expect(coalesceSegments([seg("a", 0, "edit"), seg("b", 500, "edit")], (at) => at / 1000)).toHaveLength(2)
    const many = Array.from({ length: 1000 }, (_, index) => seg(String(index), index, "command"))
    expect(coalesceSegments(many, (at) => at / 1000).length).toBeLessThanOrEqual(251)
  })
})

describe("buildSwarm", () => {
  const tree = () => [
    session("root", { title: "Fix rounding", cost: 0.1, time: { created: 1000, updated: 0 } }),
    session("a", {
      parentID: "root",
      title: "Totals (@general subagent)",
      agent: "general",
      cost: 0.3,
      time: { created: 2000, updated: 0 },
    }),
    session("b", {
      parentID: "root",
      title: "Refunds (@general subagent)",
      agent: "general",
      cost: 0.2,
      time: { created: 2100, updated: 0 },
    }),
  ]
  const messages: Record<string, Message[]> = {
    root: [user("u0", "root", 1000), assistant("m0", "root", "u0", 1100, { time: { created: 1100 } })],
    a: [user("u1", "a", 2000), assistant("m1", "a", "u1", 2100)],
    b: [user("u2", "b", 2100), assistant("m2", "b", "u2", 2200)],
  }
  const parts = (): Record<string, Part[]> => ({
    u0: [textPart("t0", "Fix it")],
    u1: [textPart("t1", "Fix totals")],
    u2: [textPart("t2", "Fix refunds")],
    m0: [
      tool("p0", "task", { description: "Totals" }, 1200, undefined),
      tool("p1", "task", { description: "Refunds" }, 1300, undefined),
    ],
    m1: [tool("p2", "write", { filePath: "/repo/src/r.ts", content: "a" }, 3000, 3100)],
    m2: [tool("p3", "write", { filePath: "src/r.ts", content: "b" }, 5000, 5100)],
  })

  test("rolls up cost, keeps the tree order, and labels what each lane is", () => {
    const model = buildSwarm(
      input(tree(), messages, parts(), {
        status: { root: { type: "busy" }, a: { type: "busy" } },
      }),
    )
    expect(model.lanes.map((lane) => [lane.id, lane.depth, lane.title])).toEqual([
      ["root", 0, "Fix rounding"],
      ["a", 1, "Totals"],
      ["b", 1, "Refunds"],
    ])
    expect(model.totals.cost).toBeCloseTo(0.6)
    expect(model.lanes[0]!.status).toBe("waiting")
    expect(model.lanes[0]!.waitingOn).toBe(2)
    expect(model.lanes[1]!.status).toBe("running")
    expect(model.lanes[2]!.status).toBe("done")
    expect(model.lanes[1]!.told).toBe("Fix totals")
    expect(model.totals.active).toBe(2)
  })

  test("agent time does not count a parent's wait on its children", () => {
    const model = buildSwarm(input(tree(), messages, parts(), { status: { root: { type: "busy" } }, now: 10_000 }))
    const root = model.lanes[0]!
    // Root reply 1100..now, waiting on task from 1200 to now: 100ms of its own work.
    expect(root.workMs).toBe(100)
  })

  test("a whole-file write over another agent's change, without reading it, is flagged", () => {
    const model = buildSwarm(input(tree(), messages, parts()))
    expect(model.overlaps).toHaveLength(1)
    const overlap = model.overlaps[0]!
    expect(overlap.path).toBe("src/r.ts")
    expect(overlap.blind).toBe(true)
    expect(overlap.writes.map((write) => [write.laneID, write.blind])).toEqual([
      ["a", false],
      ["b", true],
    ])
  })

  test("reading the file after the other change clears the flag", () => {
    const next = parts()
    next.m2 = [
      tool("r1", "read", { filePath: "/repo/src/r.ts" }, 4000, 4100),
      tool("p3", "write", { filePath: "src/r.ts", content: "b" }, 5000, 5100),
    ]
    expect(buildSwarm(input(tree(), messages, next)).overlaps[0]!.blind).toBe(false)
  })

  test("a read from before the other change does not clear it, and edit is never blind", () => {
    const stale = parts()
    stale.m2 = [
      tool("r1", "read", { filePath: "src/r.ts" }, 2500, 2600),
      tool("p3", "write", { filePath: "src/r.ts", content: "b" }, 5000, 5100),
    ]
    expect(buildSwarm(input(tree(), messages, stale)).overlaps[0]!.blind).toBe(true)
    const edit = parts()
    edit.m2 = [
      tool("p3", "edit", { filePath: "src/r.ts" }, 5000, 5100, { metadata: { filediff: { file: "src/r.ts" } } }),
    ]
    expect(buildSwarm(input(tree(), messages, edit)).overlaps[0]!.blind).toBe(false)
  })

  test("one agent rewriting its own file is not an overlap", () => {
    const next = parts()
    next.m2 = []
    next.m1 = [
      tool("p2", "write", { filePath: "src/r.ts", content: "a" }, 3000, 3100),
      tool("p4", "write", { filePath: "src/r.ts", content: "a" }, 3200, 3300),
    ]
    expect(buildSwarm(input(tree(), messages, next)).overlaps).toEqual([])
  })

  test("a child's own command failures count, and status separates stopped from failed", () => {
    const next = parts()
    next.m1 = [tool("c", "bash", { command: "bun test" }, 3000, 3100, { metadata: { exit: 1 } })]
    const stopped: Record<string, Message[]> = {
      ...messages,
      a: [
        user("u1", "a", 2000),
        assistant("m1", "a", "u1", 2100, { error: { name: "MessageAbortedError", data: {} } }),
      ],
      b: [
        user("u2", "b", 2100),
        assistant("m2", "b", "u2", 2200, { error: { name: "APIError", data: { message: "overloaded" } } }),
      ],
    }
    const model = buildSwarm(input(tree(), stopped, next))
    expect(model.totals.problems).toBeGreaterThan(0)
    expect(model.lanes[1]!.status).toBe("stopped")
    expect(model.lanes[2]!.status).toBe("failed")
    expect(model.lanes[2]!.detail).toBe("overloaded")
    expect(model.totals.failed).toBe(1)
  })

  test("a blocked lane says so, unless the app answers that request itself", () => {
    const request = {
      id: "r",
      sessionID: "a",
      permission: "bash",
      patterns: [],
      metadata: {},
      always: [],
    } as unknown as PermissionRequest
    const shown = buildSwarm(input(tree(), messages, parts(), { permission: { a: [request] } }))
    expect(shown.lanes[1]!.status).toBe("needs")
    expect(shown.totals.needs).toBe(1)
    expect(defaultLane(shown.lanes, "root")).toBe("a")
    const auto = buildSwarm(
      input(tree(), messages, parts(), { permission: { a: [request] }, autoResponds: () => true }),
    )
    expect(auto.lanes[1]!.status).toBe("done")
  })

  test("an unread lane is not called finished", () => {
    const { a: _a, ...rest } = messages
    const model = buildSwarm(input(tree(), rest, parts()))
    expect(model.lanes[1]!.status).toBe("unread")
  })

  test("a tool waiting on a person is drawn as blocked, and a failed task does not paint the parent red", () => {
    const request = {
      id: "r",
      sessionID: "a",
      permission: "bash",
      patterns: [],
      metadata: {},
      always: [],
    } as unknown as PermissionRequest
    const next = parts()
    next.m1 = [tool("c", "bash", { command: "rm -rf old" }, 3000, undefined)]
    next.m0 = [tool("p0", "task", { description: "Totals" }, 1200, 1300, { metadata: { exit: 1 } })]
    const model = buildSwarm(input(tree(), messages, next, { permission: { a: [request] } }))
    expect(model.lanes[1]!.segments[0]!.kind).toBe("blocked")
    expect(model.lanes[0]!.segments[0]!.kind).toBe("agent")
  })

})

describe("swarmPulse", () => {
  test("reads only session state", () => {
    const pulse = swarmPulse({
      rootID: "root",
      info: {
        root: session("root", { cost: 1 }),
        a: session("a", { parentID: "root", cost: 2 }),
        b: session("b", { parentID: "root", cost: 0.5 }),
      },
      permission: { a: [{ id: "r" } as unknown as PermissionRequest] },
      question: {},
    })
    expect(pulse.agents).toBe(3)
    expect(pulse.needs).toBe(1)
  })
})
