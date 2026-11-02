import { describe, expect, test } from "bun:test"
import type { AutonomyAuditLine, Message, Part } from "@opencode-ai/sdk/v2"
import path from "path"
import {
  buildSessionMap,
  decisionGroups,
  failureLine,
  mapRows,
  nextProblem,
  relativePath,
  sinceYouLooked,
  stepReference,
  heldCall,
} from "./session-map-model"

const user = (id: string, created: number) => ({ id, role: "user", time: { created } }) as unknown as Message
const assistant = (id: string, parentID: string, created: number, error?: unknown) =>
  ({ id, role: "assistant", parentID, time: { created, completed: created + 5 }, error }) as unknown as Message
const text = (id: string, messageID: string, body: string) =>
  ({ id, messageID, type: "text", text: body }) as unknown as Part
const tool = (id: string, messageID: string, name: string, state: Record<string, unknown>) =>
  ({
    id,
    messageID,
    type: "tool",
    tool: name,
    state: { time: { start: Number(id.slice(1)) }, ...state },
  }) as unknown as Part
const done = (input: Record<string, unknown>, output = "", metadata: Record<string, unknown> = {}) => ({
  status: "completed",
  input,
  output,
  metadata,
  title: "",
})

const messages = [
  user("m1", 1),
  assistant("m2", "m1", 2),
  assistant("m3", "m1", 3),
  user("m4", 100),
  assistant("m5", "m4", 101, { name: "APIError", data: { message: "model overloaded" } }),
]
const parts: Record<string, Part[]> = {
  m1: [text("u1", "m1", "Fix the invoice totals")],
  m2: [
    tool("p10", "m2", "read", done({ filePath: "/repo/a.ts" })),
    tool("p11", "m2", "grep", done({ pattern: "invoice" }, "needle-in-output")),
    tool("p12", "m2", "bash", done({ command: "bun test\nmore" }, "ok\nFAIL billing.test.ts\n", { exit: 1 })),
    tool(
      "p13",
      "m2",
      "edit",
      done({ filePath: "/repo/a.ts" }, "", { filediff: { file: "/repo/a.ts", additions: 3, deletions: 1 } }),
    ),
  ],
  m3: [
    tool("p14", "m3", "bash", done({ command: "bun test" }, "pass", { exit: 0 })),
    tool(
      "p15",
      "m3",
      "edit",
      done({ filePath: "/repo/a.ts" }, "", { filediff: { file: "/repo/a.ts", additions: 1, deletions: 1 } }),
    ),
    text("t1", "m3", "All fixed now"),
  ],
  m4: [text("u2", "m4", "Now ship it")],
  m5: [
    tool("p200", "m5", "task", done({ description: "Audit rounding" })),
    tool("p201", "m5", "bash", { status: "running", input: { command: "bun run deploy" } }),
    tool("p202", "m5", "read", { status: "error", input: { filePath: "/gone" }, error: "File not found\nstack" }),
  ],
}
const model = () => buildSessionMap({ messages, parts: (id) => parts[id] ?? [] })

describe("buildSessionMap", () => {
  test("groups replies under the prompt that caused them", () => {
    const chapters = model().chapters
    expect(chapters.map((chapter) => chapter.prompt)).toEqual(["Fix the invoice totals", "Now ship it"])
    expect(chapters[0]!.visibleSteps).toBe(6)
    expect(chapters[0]!.outcome?.text).toBe("All fixed now")
    expect(chapters[0]!.commands).toBe(2)
    expect(chapters[0]!.end).toBe(8)
  })

  test("a non-zero exit is a problem even though the tool completed, and says why", () => {
    const step = model().steps.find((item) => item.id === "p12")!
    expect(step.problem).toBe("exit 1")
    expect(step.detail).toBe("FAIL billing.test.ts")
    expect(step.label).toBe("bun test")
    expect(model().steps.find((item) => item.id === "p14")!.problem).toBeUndefined()
  })

  test("tool errors and turn errors are problems; an aborted turn is not", () => {
    expect(model().problems.map((step) => step.id)).toEqual(["p12", "p202", "error:m5"])
    expect(model().problems[1]!.problem).toBe("File not found")
    const aborted = buildSessionMap({
      messages: [user("m1", 1), assistant("m2", "m1", 2, { name: "MessageAbortedError", data: {} })],
      parts: () => [],
    })
    expect(aborted.problems).toEqual([])
  })

  test("a call stopped at the permission gate never ran, so it is no problem and keeps its command", () => {
    const map = buildSessionMap({
      messages: [user("m1", 1), assistant("m2", "m1", 2)],
      parts: (id) =>
        id === "m2"
          ? [
              tool("p3", "m2", "bash", {
                status: "error",
                input: { command: "bun test" },
                error: "Nobody answered this permission request in time, so this call did not run.",
                metadata: { notRun: "away" },
                time: { start: 3, end: 4 },
              }),
              tool("p5", "m2", "bash", {
                status: "error",
                input: { command: "rm -rf dist" },
                error: "The user rejected permission to use this specific tool call.",
                metadata: { notRun: "declined" },
                time: { start: 5, end: 6 },
              }),
            ]
          : [],
    })
    expect(map.counts.problems).toBe(0)
    const steps = map.chapters[0].steps
    expect(steps.map((step) => step.label)).toEqual(["bun test", "rm -rf dist"])
    expect(steps.every((step) => step.notRun)).toBe(true)
  })

  test("adds up each file across steps", () => {
    const file = model().files[0]!
    expect(file).toMatchObject({ path: "/repo/a.ts", added: 4, removed: 2 })
    expect(file.steps.map((step) => step.id)).toEqual(["p13", "p15"])
  })

  test("leaves out what a revert hid", () => {
    const map = buildSessionMap({ messages, parts: (id) => parts[id] ?? [], revertMessageID: "m4" })
    expect(map.chapters.map((chapter) => chapter.id)).toEqual(["m1"])
  })

  test("reads text through quiet so streaming deltas do not subscribe", () => {
    let quietReads = 0
    buildSessionMap({
      messages,
      parts: (id) => parts[id] ?? [],
      quiet: (read) => {
        quietReads += 1
        return read()
      },
    })
    expect(quietReads).toBeGreaterThan(2)
  })
})

describe("mapRows", () => {
  const open = (expanded: string[]) => (id: string) => expanded.includes(id)

  test("collapsed chapters hide their steps", () => {
    const rows = mapRows({ model: model(), filter: "all", query: "", open: open([]) })
    expect(rows.map((row) => row.id)).toEqual(["m1", "m4"])
  })

  test("runs of reads and searches fold, a failed read stays out in the open", () => {
    const rows = mapRows({ model: model(), filter: "all", query: "", open: open(["m1", "m4"]) })
    expect(rows.map((row) => row.type)).toEqual([
      "chapter",
      "explored",
      "step",
      "step",
      "step",
      "step",
      "chapter",
      "step",
      "step",
      "step",
      "step",
    ])
    expect(rows.some((row) => row.type === "step" && row.step.id === "p202")).toBe(true)
  })

  test("problems filter lists only problems under their prompts", () => {
    const rows = mapRows({ model: model(), filter: "problems", query: "", open: open([]) })
    expect(rows.map((row) => row.id)).toEqual(["m1", "p12", "m4", "p202", "error:m5"])
  })

  test("files filter lists each file, steps when opened", () => {
    expect(mapRows({ model: model(), filter: "edits", query: "", open: open([]) }).map((row) => row.id)).toEqual([
      "file:/repo/a.ts",
    ])
    expect(
      mapRows({ model: model(), filter: "edits", query: "", open: open(["file:/repo/a.ts"]) }).map((row) => row.id),
    ).toEqual(["file:/repo/a.ts", "/repo/a.ts:p13", "/repo/a.ts:p15"])
  })

  test("search reaches tool output, final text and prompts, with a snippet", () => {
    const rows = mapRows({ model: model(), filter: "all", query: "NEEDLE", open: open([]) })
    expect(rows.map((row) => row.id)).toEqual(["m1", "p11"])
    const hit = rows[1]!
    expect(hit.type === "step" && hit.snippet).toContain("needle-in-output")
    expect(mapRows({ model: model(), filter: "all", query: "all fixed", open: open([]) }).map((row) => row.id)).toEqual(
      ["m1", "t1"],
    )
    expect(mapRows({ model: model(), filter: "all", query: "ship it", open: open([]) }).map((row) => row.id)).toEqual([
      "m4",
    ])
  })

  test("search caps results and says so", () => {
    const many = Array.from({ length: 250 }, (_, index) => tool(`p${index}`, "m2", "bash", done({ command: "needle" })))
    const big = buildSessionMap({
      messages: [user("m1", 1), assistant("m2", "m1", 2)],
      parts: (id) => (id === "m2" ? many : []),
    })
    const rows = mapRows({ model: big, filter: "all", query: "needle", open: open([]) })
    expect(rows.filter((row) => row.type === "step")).toHaveLength(200)
    expect(rows.at(-1)).toMatchObject({ type: "truncated", total: 250 })
  })
})

describe("since you looked and problem navigation", () => {
  test("counts what ran after the mark", () => {
    expect(sinceYouLooked(model(), undefined)).toBeUndefined()
    expect(sinceYouLooked(model(), 100_000)).toBeUndefined()
    const fresh = sinceYouLooked(model(), 150)!
    expect(fresh.first.id).toBe("p200")
    expect(fresh.steps.map((step) => step.id)).toEqual(["p200", "p201", "p202"])
    expect(fresh.problems).toBe(1)
  })

  test("walks from the last problem and wraps", () => {
    expect(nextProblem(model(), 1, { stepID: "p12" })?.id).toBe("p202")
    expect(nextProblem(model(), 1, { stepID: "error:m5" })?.id).toBe("p12")
    expect(nextProblem(model(), -1, { stepID: "p12" })?.id).toBe("error:m5")
  })

  test("without a last problem it starts from the turn on screen", () => {
    expect(nextProblem(model(), 1, { turnID: "m4" })?.id).toBe("p202")
    expect(nextProblem(model(), -1, { turnID: "m1" })?.id).toBe("p12")
    expect(nextProblem(model(), 1, {})?.id).toBe("p12")
    expect(nextProblem(buildSessionMap({ messages: [], parts: () => [] }), 1, {})).toBeUndefined()
  })
})

test("failureLine prefers the line that names the failure", () => {
  expect(failureLine("a\nb\nerror: nope\nc")).toBe("error: nope")
  expect(failureLine("a\nb\n")).toBe("b")
  expect(failureLine("")).toBeUndefined()
})

test("stepReference and relativePath", () => {
  const step = model().steps.find((item) => item.id === "p12")!
  expect(stepReference(step)).toBe("bash `bun test` (exit 1)")
  expect(relativePath("/repo/a.ts", "/repo/")).toBe("a.ts")
  expect(relativePath("/other/a.ts", "/repo")).toBe("/other/a.ts")
})

describe("decisionGroups", () => {
  let seq = 0
  const decision = (requestID: string, fields: Partial<Extract<AutonomyAuditLine, { type: "decision" }>> = {}) =>
    ({
      v: 1,
      seq: ++seq,
      prev: "",
      at: seq,
      type: "decision",
      rootID: "root",
      sessionID: "root",
      requestID,
      messageID: "msg_5",
      agent: "build",
      directory: "/repo",
      permission: "bash",
      patterns: ["ls"],
      patternsTruncated: false,
      class: "P",
      risk: "",
      canUndo: true,
      decidedBy: "agent:test/test-model",
      decision: "allow",
      memo: false,
      follows: [],
      ...fields,
    }) as AutonomyAuditLine
  const outcome = (requestID: string, value: string, by?: string) =>
    ({ v: 1, seq: ++seq, prev: "", at: seq, type: "outcome", requestID, outcome: value, by }) as AutonomyAuditLine
  const marker = (name: string) =>
    ({
      v: 1,
      seq: ++seq,
      prev: "",
      at: seq,
      type: "marker",
      rootID: "root",
      marker: name,
      decidedBy: "gate",
    }) as AutonomyAuditLine
  const ids = (list: readonly { id: string }[]) => list.map((item) => item.id)

  test("a held call waits, and leaves waiting once answered", () => {
    const groups = decisionGroups(
      [
        decision("held-d", { class: "D", decision: "defer", decidedBy: "gate", category: "outward" }),
        decision("held-p", {
          decision: "defer",
          decidedBy: "system:decider_unavailable",
          category: "decider_unavailable",
        }),
        decision("yes", { class: "D", decision: "defer", decidedBy: "gate" }),
        outcome("yes", "approved_later", "person"),
        decision("no", { class: "D", decision: "defer", decidedBy: "gate" }),
        outcome("no", "rejected_later", "person"),
      ],
      "root",
    )
    expect(ids(groups.waiting)).toEqual(["held-d", "held-p"])
    expect(ids(groups.decided)).toEqual(["no", "yes"])
    expect(groups.limited).toEqual([])
    expect(groups.decided.map((entry) => entry.by)).toEqual(["person", "person"])
  })

  test("the waiting list is what the route counts as open", () => {
    const groups = decisionGroups(
      [
        decision("full", { class: "D", decision: "defer", category: "queue_full" }),
        decision("question", { class: "A", decision: "defer", permission: "question", canUndo: false }),
        decision("gone", { class: "D", decision: "defer" }),
        outcome("gone", "abandoned", "system:session_closed"),
        decision("open", { class: "D", decision: "defer" }),
      ],
      "root",
    )
    expect(ids(groups.waiting)).toEqual(["open"])
  })

  test("what the mode or the decider refused is limited, and an agent's yes is decided", () => {
    const groups = decisionGroups(
      [
        decision("x", { class: "X", decision: "reject", decidedBy: "gate", category: "app_state" }),
        decision("refused", { decision: "reject" }),
        decision("full", { class: "D", decision: "defer", category: "queue_full" }),
        decision("loop", { class: "B", decision: "ask", decidedBy: "gate" }),
        decision("gone", { class: "D", decision: "defer" }),
        outcome("gone", "abandoned"),
        decision("agent"),
        decision("question", { class: "A", decision: "defer", permission: "question", reason: "asumsi agen" }),
      ],
      "root",
    )
    expect(ids(groups.limited)).toEqual(["gone", "loop", "full", "refused", "x"])
    expect(ids(groups.decided)).toEqual(["question", "agent"])
    expect(groups.decided[1]?.by).toBe("test/test-model")
  })

  test("Undo is offered only for what ran, with a message and a snapshot, and within reach of one", () => {
    const groups = decisionGroups(
      [
        decision("button"),
        decision("approved", { class: "D", decision: "defer" }),
        outcome("approved", "approved_later", "person"),
        decision("no-message", { messageID: undefined }),
        decision("no-snapshot", { canUndo: false }),
        decision("pushed", { class: "D", decision: "defer", category: "outward" }),
        outcome("pushed", "approved_later", "person"),
        decision("elsewhere", { category: "outside_folder" }),
        decision("refused", { decision: "reject" }),
        decision("rejected", { class: "D", decision: "defer" }),
        outcome("rejected", "rejected_later", "person"),
      ],
      "root",
    )
    const undo = Object.fromEntries(
      [...groups.waiting, ...groups.decided, ...groups.limited].map((entry) => [entry.id, entry.undo]),
    )
    expect(undo).toEqual({
      button: "button",
      approved: "button",
      "no-message": "none",
      "no-snapshot": "none",
      pushed: "none",
      elsewhere: "none",
      refused: undefined,
      rejected: undefined,
    })
  })

  test("a subagent's line says Undo cannot help, however undoable it looks", () => {
    const groups = decisionGroups([decision("child-edit", { sessionID: "child", messageID: "msg_7" })], "root")
    expect(groups.decided[0]).toMatchObject({ sessionID: "child", messageID: "msg_7", undo: "none" })
  })

  test("what a revert took away reads as undone and offers no second Undo", () => {
    const groups = decisionGroups(
      [
        decision("before", { messageID: "msg_3" }),
        decision("from", { messageID: "msg_5" }),
        decision("after", { messageID: "msg_7" }),
        decision("child", { sessionID: "child", messageID: "msg_9" }),
      ],
      "root",
      (sessionID) => (sessionID === "root" ? "msg_5" : undefined),
    )
    const seen = Object.fromEntries(groups.decided.map((entry) => [entry.id, [entry.outcome, entry.undo]]))
    expect(seen).toEqual({
      before: [undefined, "button"],
      from: ["undone", undefined],
      after: ["undone", undefined],
      child: [undefined, "none"],
    })
  })

  test("a line of another root stays out, and an outcome without a decision makes nothing up", () => {
    const groups = decisionGroups([decision("other", { rootID: "elsewhere" }), outcome("nobody", "ran")], "root")
    expect([...groups.waiting, ...groups.decided, ...groups.limited]).toEqual([])
  })

  test("an interrupted decider leaves an outcome with no decision line, and it is passed over", () => {
    const lines = [
      decision("kept"),
      {
        v: 1,
        seq: 2,
        prev: "abc",
        at: 2,
        type: "outcome",
        requestID: "per_interrupted",
        outcome: "not_run",
        by: "system:decider_interrupted",
      },
    ] as AutonomyAuditLine[]
    const groups = decisionGroups(lines, "root")
    expect(ids(groups.decided)).toEqual(["kept"])
    expect(groups.decided[0]?.outcome).toBeUndefined()
    expect([...groups.waiting, ...groups.limited, ...groups.notes]).toEqual([])
  })

  test("mode, decider and queue markers become notes, latest first", () => {
    const groups = decisionGroups(
      [
        marker("mode_on"),
        marker("decider_open"),
        marker("decider_closed"),
        marker("b1"),
        marker("b0"),
        marker("mode_off"),
      ],
      "root",
    )
    expect(groups.notes.map((note) => note.note)).toEqual(["mode_off", "queue_full", "decider_unavailable", "mode_on"])
  })

  test("Markdown and links in a reason or a pattern come through untouched", () => {
    const reason = "[click](https://evil.example) **now** <img src=x onerror=alert(1)>\n# heading"
    const pattern = "curl https://evil.example/[a](b) `tick`"
    const groups = decisionGroups([decision("md", { reason, patterns: [pattern] })], "root")
    expect(groups.decided[0]?.reason).toBe(reason)
    expect(groups.decided[0]?.patterns).toEqual([pattern])
  })

  test("a folder's line names what its answer also covers, and the edit that ran has a line of its own", () => {
    const covers = [{ permission: "edit", patterns: ["../home/.zshrc"] }]
    const groups = decisionGroups(
      [
        decision("folder", {
          permission: "external_directory",
          patterns: ["/home/*"],
          class: "D",
          decision: "defer",
          decidedBy: "gate",
          category: "outside_folder",
          follows: covers,
        }),
        decision("edit", {
          permission: "edit",
          patterns: ["../home/.zshrc"],
          class: "D",
          decision: "allow",
          decidedBy: "person",
          category: "no_undo",
        }),
      ],
      "root",
    )
    expect(groups.waiting[0]?.follows).toEqual(covers)
    expect(groups.decided[0]).toMatchObject({
      id: "edit",
      permission: "edit",
      patterns: ["../home/.zshrc"],
      by: "person",
      undo: "none",
    })
  })

  test("the call of a held request is read as data, whatever shape it arrives in", () => {
    expect(heldCall({ call: { tool: "edit", args: { filePath: "/a", oldString: "x", replaceAll: true } } })).toEqual({
      tool: "edit",
      args: [
        { name: "filePath", value: "/a" },
        { name: "oldString", value: "x" },
        { name: "replaceAll", value: "true" },
      ],
    })
    expect(heldCall({ call: { tool: "mcp_x", args: "plain" } })?.args).toEqual([{ name: "input", value: "plain" }])
    for (const metadata of [undefined, {}, { call: "text" }, { call: null }, { call: { args: {} } }])
      expect(heldCall(metadata)).toBeUndefined()
  })

  test("the decisions view takes no rows from the step list", () => {
    const model = buildSessionMap({ messages, parts: () => [] })
    expect(mapRows({ model, filter: "decisions", query: "", open: () => true })).toEqual([])
    expect(mapRows({ model, filter: "decisions", query: "anything", open: () => true })).toEqual([])
  })

  test("the rows that show a decision have nothing that could parse its text", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "session-map-view.tsx")).text()
    const start = source.indexOf("export function DecisionRow")
    const end = source.indexOf("function DialogUndoDecision")
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const row = source.slice(start, end)
    expect(row).toContain("{pattern}")
    expect(row).toContain("{reason()}")
    expect(row).toContain("{arg.value}")
    expect(row).not.toMatch(/innerHTML|Markdown|<a\b|href|marked|createLink|data-markdown/)
    expect(source).not.toMatch(/innerHTML|<Markdown/)
  })
})
