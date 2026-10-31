import { describe, expect, test } from "bun:test"
import type { GlobalAgentsInstance, Message, Part, Session } from "@opencode-ai/sdk/v2"
import {
  collectAgents,
  describePermission,
  describeQuestion,
  mergeRows,
  nextWaiting,
  summarizeHistory,
  summarize,
  tmuxSegment,
  toLines,
  lineHeight,
  windowLines,
  type FleetAgent,
  type FleetEntry,
  type FleetHistory,
} from "../../src/fleet/model"

const NOW = 1_800_000_000_000

const session = (id: string, over: Partial<Session> = {}) =>
  ({ id, title: `title ${id}`, directory: "/work/a", time: { created: NOW - 1000, updated: NOW - 1000 }, ...over }) as Session

const instance = (over: Partial<GlobalAgentsInstance> = {}): GlobalAgentsInstance => ({
  directory: "/work/a",
  status: {},
  permission: [],
  question: [],
  ...over,
})

const permission = (id: string, sessionID: string, command = "rm -rf build") => ({
  id,
  sessionID,
  permission: "bash",
  patterns: [command],
  metadata: { command },
  always: ["rm *"],
})

const reply: FleetHistory = { lines: ["all done"], updated: NOW - 1000, hasReply: true }

const agent = (sessionID: string, state: FleetAgent["state"], since = NOW): FleetAgent => ({
  sessionID,
  title: sessionID,
  directory: "/work/a",
  state,
  since,
  tail: [],
})

const peer = (pid: number, agents: FleetAgent[], over: Partial<FleetEntry> = {}): FleetEntry => ({
  version: 1,
  pid,
  host: "h",
  directory: "/work/b",
  updated: NOW,
  agents,
  ...over,
})

describe("describing what an agent is blocked on", () => {
  test("a shell request shows the literal command, not a category", () => {
    expect(describePermission(permission("p", "s", "git push --force")).label).toBe("$ git push --force")
  })

  test("an edit request carries its diff so it can be read before approving", () => {
    const pending = describePermission({
      id: "p",
      sessionID: "s",
      permission: "edit",
      patterns: ["src/a.ts"],
      metadata: { filepath: "/work/a/src/a.ts", diff: "Index: a\n--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n" },
      always: [],
    })
    expect(pending.label).toBe("edit /work/a/src/a.ts")
    expect(pending.kind === "permission" && pending.detail).toEqual(["@@ -1 +1 @@", "-old", "+new"])
  })

  test("only one single-choice question can be answered with a number key", () => {
    const question = (over = {}) => ({ question: "Keep it?", header: "Keep", options: [{ label: "Yes", description: "" }], ...over })
    const answerable = (questions: ReturnType<typeof question>[]) => {
      const pending = describeQuestion({ id: "q", sessionID: "s", questions })
      return pending.kind === "question" && pending.answerable
    }
    expect(answerable([question()])).toBe(true)
    expect(answerable([question(), question()])).toBe(false)
    expect(answerable([question({ multiple: true })])).toBe(false)
    expect(answerable([question({ options: [] })])).toBe(false)
  })
})

describe("collecting one server's agents", () => {
  const collect = (input: Partial<Parameters<typeof collectAgents>[0]>) =>
    collectAgents({ instances: [], sessions: new Map(), history: new Map(), now: NOW, ...input })

  test("a blocked session is waiting even while its status says busy", () => {
    const [row] = collect({
      instances: [instance({ status: { s: { type: "busy" } }, permission: [permission("p", "s")] })],
      sessions: new Map([["s", session("s")]]),
    })
    expect(row.state).toBe("waiting")
    expect(row.pending?.label).toBe("$ rm -rf build")
  })

  test("a request the agent moved on from does not make a working agent read as waiting", () => {
    const moved = { ...permission("p", "s"), movedOnAt: NOW - 1000 }
    const [row] = collect({
      instances: [instance({ status: { s: { type: "busy" } }, permission: [moved] })],
      sessions: new Map([["s", session("s")]]),
    })
    expect(row.state).toBe("running")
    expect(row.pending).toBeUndefined()
  })

  test("once the agent has stopped, a request it moved on from is a decision left waiting", () => {
    const moved = { ...permission("p", "s"), movedOnAt: NOW - 1000 }
    const [row] = collect({
      instances: [instance({ permission: [moved] })],
      sessions: new Map([["s", session("s")]]),
    })
    expect(row.state).toBe("waiting")
    expect(row.pending?.label).toBe("$ rm -rf build")
  })

  test("a request arriving before its session is loaded still shows, in the request's directory", () => {
    const [row] = collect({ instances: [instance({ directory: "/work/z", permission: [permission("p", "s")] })] })
    expect(row.directory).toBe("/work/z")
    expect(row.state).toBe("waiting")
  })

  test("busy subagents roll up to their parent, blocked ones get their own row", () => {
    const rows = collect({
      instances: [
        instance({
          status: { root: { type: "busy" }, c1: { type: "busy" }, c2: { type: "busy" } },
          permission: [permission("p", "c2")],
        }),
      ],
      sessions: new Map([
        ["root", session("root")],
        ["c1", session("c1", { parentID: "root" })],
        ["c2", session("c2", { parentID: "root" })],
      ]),
    })
    expect(rows.map((row) => [row.sessionID, row.state]).toSorted()).toEqual([
      ["c2", "waiting"],
      ["root", "running"],
    ])
  })

  test("a retry names its reason", () => {
    const [row] = collect({
      instances: [instance({ status: { s: { type: "retry", attempt: 2, message: "rate limited", next: NOW } } })],
      sessions: new Map([["s", session("s")]]),
    })
    expect(row.activity).toBe("retrying: rate limited")
  })

  test("a failure survives a restart because it comes from the stored message, and expires", () => {
    const failing: FleetHistory = { lines: [], error: "Provider returned 400", updated: NOW, hasReply: true }
    const rows = (updated: number) =>
      collect({
        sessions: new Map([["s", session("s", { time: { created: 0, updated } })]]),
        history: new Map([["s", failing]]),
      })
    expect(rows(NOW - 1000)[0].state).toBe("failed")
    expect(rows(NOW - 1000)[0].activity).toBe("Provider returned 400")
    expect(rows(NOW - 9 * 60 * 60 * 1000)).toEqual([])
  })

  test("finished sessions list only recent ones that actually replied, capped", () => {
    const sessions = new Map(
      Array.from({ length: 12 }, (_, i) => [`s${i}`, session(`s${i}`, { time: { created: 0, updated: NOW - i * 1000 } })]),
    )
    const history = new Map([...sessions.keys()].map((id) => [id, reply]))
    expect(collect({ sessions, history }).map((row) => row.sessionID)).toEqual(
      Array.from({ length: 5 }, (_, i) => `s${i}`),
    )
    expect(collect({ sessions: new Map([["old", session("old", { time: { created: 0, updated: NOW - 31 * 60 * 1000 } })]]), history: new Map([["old", reply]]) })).toEqual([])
    expect(collect({ sessions: new Map([["new", session("new")]]), history: new Map([["new", { ...reply, hasReply: false }]]) })).toEqual([])
  })

  test("the wait clock starts when the request is first seen and holds across refreshes", () => {
    const firstSeen = new Map<string, number>()
    const instances = [instance({ permission: [permission("p", "s")] })]
    const once = collectAgents({ instances, sessions: new Map(), history: new Map(), firstSeen, now: NOW })
    const later = collectAgents({ instances, sessions: new Map(), history: new Map(), firstSeen, now: NOW + 60_000 })
    expect(once[0].since).toBe(NOW)
    expect(later[0].since).toBe(NOW)
  })
})

describe("reading stored messages", () => {
  const message = (role: "user" | "assistant", parts: unknown[], info: object = {}) => ({
    info: { id: "m", role, time: { created: 1, completed: 2 }, ...info } as Message,
    parts: parts as Part[],
  })
  test("tools and text become one line each, user text is marked, tail is capped", () => {
    const history = summarizeHistory(
      [
        message("user", [{ type: "text", text: "Fix the build\nplease" }]),
        message("assistant", [
          { type: "tool", tool: "bash", state: { status: "completed", input: { command: "bun test" }, title: "t" } },
          { type: "tool", tool: "edit", state: { status: "error", input: { filePath: "src/a.ts" }, error: "no" } },
          { type: "text", text: "\n\nDone with that." },
          { type: "text", text: "hidden", synthetic: true },
        ]),
      ],
      NOW,
    )
    expect(history.lines).toEqual(["> Fix the build", "bash bun test", "✕ edit src/a.ts", "Done with that."])
    expect(history.hasReply).toBe(true)
  })
  test("a git read says what it read once, with no second git", () => {
    const history = summarizeHistory(
      [message("assistant", [{ type: "tool", tool: "git", state: { status: "completed", input: { subcommand: "log", limit: 1 }, title: "git log" } }])],
      NOW,
    )
    expect(history.lines).toEqual(["git log"])
  })
  test("stopping an agent is not a failure", () => {
    const aborted = message("assistant", [], { error: { name: "MessageAbortedError", data: { message: "x" } } })
    const broke = message("assistant", [], { error: { name: "APIError", data: { message: "bad key" } } })
    expect(summarizeHistory([aborted], NOW).error).toBeUndefined()
    expect(summarizeHistory([broke], NOW).error).toBe("bad key")
  })
})

describe("merging the agents of every Swarm on the machine", () => {
  test("the agent waiting longest comes first and groups keep their order", () => {
    const rows = mergeRows({
      local: [agent("r", "running"), agent("w-new", "waiting", NOW), agent("d", "done")],
      peers: [peer(9, [agent("w-old", "waiting", NOW - 5000), agent("f", "failed")])],
      self: {},
    })
    expect(rows.map((row) => row.sessionID)).toEqual(["w-old", "w-new", "f", "r", "d"])
  })

  test("a pane is offered only when this client's tmux server can reach it", () => {
    const entry = peer(9, [agent("x", "waiting")], { tmux: { socket: "/tmp/tmux/default", pane: "%4" } })
    const where = (tmuxSocket?: string) => mergeRows({ local: [], peers: [entry], self: { tmuxSocket } })[0].where
    expect(where("/tmp/tmux/default")).toEqual({ kind: "peer", pid: 9, pane: "%4", otherTmux: false })
    expect(where("/tmp/tmux/other")).toEqual({ kind: "peer", pid: 9, pane: undefined, otherTmux: true })
    expect(where(undefined)).toEqual({ kind: "peer", pid: 9, pane: undefined, otherTmux: true })
  })

  test("a TUI attached to the same server is not double counted, and local rows win", () => {
    const attached = peer(9, [agent("shared", "running")], { server: "http://box:4096" })
    expect(mergeRows({ local: [], peers: [attached], self: { server: "http://box:4096" } })).toEqual([])
    const rows = mergeRows({ local: [agent("same", "running")], peers: [peer(9, [agent("same", "running")])], self: {} })
    expect(rows.map((row) => row.where.kind)).toEqual(["here"])
  })
})

test("a second pane on the same project cannot hide the pane actually running the agent", () => {
  const rows = mergeRows({
    local: [agent("s", "failed")],
    peers: [peer(9, [agent("s", "waiting")], { tmux: { socket: "/t", pane: "%2" } })],
    self: { tmuxSocket: "/t" },
  })
  expect(rows.map((row) => [row.state, row.where.kind])).toEqual([["waiting", "peer"]])
})

test("a session whose driver died mid-step is reported, not shown as finished", () => {
  const unfinished = summarizeHistory(
    [{ info: { id: "m", role: "assistant", time: { created: 1 } } as Message, parts: [] }],
    NOW,
  )
  const [row] = collectAgents({
    instances: [],
    sessions: new Map([["s", session("s")]]),
    history: new Map([["s", unfinished]]),
    now: NOW,
  })
  expect(row.state).toBe("failed")
  expect(row.activity).toContain("Stopped before finishing")
})

describe("moving through blocked agents", () => {
  const rows = mergeRows({
    local: [agent("a", "waiting", 1), agent("b", "waiting", 2), agent("c", "running")],
    peers: [],
    self: {},
  })
  test("cycles in order and wraps", () => {
    expect(nextWaiting(rows)?.sessionID).toBe("a")
    expect(nextWaiting(rows, "a")?.sessionID).toBe("b")
    expect(nextWaiting(rows, "b")?.sessionID).toBe("a")
    expect(nextWaiting(rows, "c")?.sessionID).toBe("a")
  })
  test("reports nothing when the only blocked agent is the one already on screen", () => {
    const one = rows.filter((row) => row.sessionID === "a")
    expect(nextWaiting(one, "a")).toBeUndefined()
  })
})

describe("drawing in a small pane", () => {
  const rows = mergeRows({
    local: Array.from({ length: 30 }, (_, i) => agent(`s${i}`, i < 2 ? "waiting" : "running", i)),
    peers: [],
    self: {},
  })
  const lines = toLines(rows)
  const heightOf = (slice: typeof lines) => slice.reduce((sum, line) => sum + lineHeight(line), 0)

  test.each([4, 7, 12, 40])("the selection is always visible and the slice fits a height of %i", (height) => {
    rows.forEach((row) => {
      const view = windowLines(lines, row.key, height)
      expect(view.lines.some((line) => line.type === "row" && line.row.key === row.key)).toBe(true)
      expect(heightOf(view.lines)).toBeLessThanOrEqual(height)
    })
  })

  test("nothing selected and nothing to draw are both safe", () => {
    expect(windowLines(lines, undefined, 10).start).toBe(0)
    expect(windowLines([], undefined, 10).lines).toEqual([])
  })
})

test("the tmux status segment is empty when nothing is happening", () => {
  expect(tmuxSegment([])).toBe("")
  expect(tmuxSegment([agent("d", "done")])).toBe("")
  expect(tmuxSegment([agent("w", "waiting"), agent("w2", "waiting"), agent("r", "running")])).toBe(
    "#[fg=red,bold]▲2 need you#[default] ●1",
  )
  expect(summarize([agent("f", "failed")]).failed).toBe(1)
})
