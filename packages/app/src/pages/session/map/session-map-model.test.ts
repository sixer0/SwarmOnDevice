import { describe, expect, test } from "bun:test"
import type { AutonomyAuditLine, Message, Part } from "@opencode-ai/sdk/v2"
import path from "path"
import {
  buildSessionMap,
  decisionGroups,
  historyOf,
  reuseById,
  type DecisionEntry,
  failureLine,
  mapRows,
  nextProblem,
  relativePath,
  sinceYouLooked,
  stepReference,
  heldCall,
  heldCalls,
  heldAlways,
  consentShown,
  consentTicked,
  consentAllowInput,
  archiveShown,
  archiveCount,
  archiveEmptyInput,
  archiveSize,
  type ConsentList,
  type HistoryItem,
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

  test("a held call the server ran after the answer stays answered, as do the ones the same always released", () => {
    // Row 260: the server writes `approved_later`, then `ran` or `failed` once it has run the held call.
    const groups = decisionGroups(
      [
        decision("always", { class: "D", decision: "defer", decidedBy: "gate", category: "secret_file" }),
        decision("released", { class: "D", decision: "defer", decidedBy: "gate", category: "secret_file" }),
        decision("failed", { class: "D", decision: "defer", decidedBy: "gate" }),
        outcome("always", "approved_later", "person"),
        outcome("released", "approved_later", "person"),
        outcome("failed", "approved_later", "person"),
        outcome("always", "ran", "person"),
        outcome("released", "ran", "person"),
        outcome("failed", "failed", "person"),
      ],
      "root",
    )
    expect(groups.waiting).toEqual([])
    expect(groups.limited).toEqual([])
    expect(groups.decided.map((entry) => [entry.id, entry.outcome, entry.by])).toEqual([
      ["failed", "failed", "person"],
      ["released", "ran", "person"],
      ["always", "ran", "person"],
    ])
  })

  test("row 262: one approval after a restart is one Decided row, not one per prompt of the repeat", () => {
    // The audit lines of p18_restart (seq 2-6): the held `.ssh` entry, its approval, the repeat's two grant lines.
    const ssh = { permission: "external_directory", patterns: ["/root_h/home/.ssh/*"] }
    const cat = { permission: "bash", patterns: ["cat ~/.ssh/id_rsa"] }
    const granted = { class: "D", category: "secret_file", decision: "allow", decidedBy: "person", via: "grant" } as const
    const groups = decisionGroups(
      [
        decision("held", {
          ...ssh,
          class: "D",
          category: "secret_file",
          decision: "defer",
          decidedBy: "gate",
          messageID: "msg_3",
          callID: "call_1",
          canUndo: false,
          follows: [cat],
        }),
        decision("push", {
          patterns: ["git push origin main"],
          class: "D",
          category: "outward_not_in_mission",
          decision: "defer",
          decidedBy: "gate",
          messageID: "msg_3",
          callID: "call_2",
        }),
        outcome("held", "approved_later", "person"),
        decision("repeat-dir", { ...ssh, ...granted, messageID: "msg_7", callID: "call_9", canUndo: false }),
        decision("repeat-bash", { ...cat, ...granted, messageID: "msg_7", callID: "call_9" }),
      ],
      "root",
    )
    expect(ids(groups.waiting)).toEqual(["push"])
    expect(groups.decided).toHaveLength(1)
    // The row had no Undo of its own; the repeat's bash step had one, so it is kept, on the repeat's message.
    expect(groups.decided[0]).toMatchObject({ id: "held", by: "person", undo: "button", messageID: "msg_7" })
    expect(groups.limited).toEqual([])
  })

  test("row 262: a row keeps its own Undo, and a folded step a revert took reads as undone", () => {
    const granted = { decision: "allow", decidedBy: "person", via: "grant" } as const
    const held = { class: "D", decision: "defer", decidedBy: "gate" } as const
    const groups = decisionGroups(
      [
        decision("own", { ...held, patterns: ["make"], messageID: "msg_3" }),
        outcome("own", "approved_later", "person"),
        decision("own-ran", { ...granted, patterns: ["make"], messageID: "msg_7" }),
        decision("taken", { ...held, patterns: ["rm x"], canUndo: false, messageID: "msg_3" }),
        outcome("taken", "approved_later", "person"),
        decision("taken-ran", { ...granted, patterns: ["rm x"], messageID: "msg_8" }),
      ],
      "root",
      () => "msg_8",
    )
    const seen = Object.fromEntries(
      groups.decided.map((entry) => [entry.id, [entry.messageID, entry.undo, entry.outcome]]),
    )
    expect(seen).toEqual({
      own: ["msg_3", "button", "approved_later"],
      taken: ["msg_8", undefined, "undone"],
    })
  })

  test("row 262: later calls an always in this session let through are one row per call", () => {
    const session = { decision: "allow", decidedBy: "person", via: "grant" } as const
    const reason = 'a person\'s "always in this session"'
    const groups = decisionGroups(
      [
        decision("always", { class: "D", decision: "defer", decidedBy: "gate", patterns: ["cat a"], callID: "call_1" }),
        outcome("always", "approved_later", "person"),
        decision("always-ran", { ...session, patterns: ["cat a"], callID: "call_2" }),
        decision("next-dir", { ...session, reason, permission: "external_directory", patterns: ["/x/*"], callID: "c3" }),
        decision("next-bash", { ...session, reason, patterns: ["cat /x/b"], callID: "c3" }),
        decision("other", { ...session, reason, patterns: ["cat a"], callID: "c4" }),
        // A grant line with nothing on screen to carry out still shows.
        decision("stray", { ...session, patterns: ["ls -la"], callID: "c5" }),
      ],
      "root",
    )
    expect(ids(groups.decided)).toEqual(["stray", "other", "next-dir", "always"])
    expect(groups.waiting).toEqual([])
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

  test("row 160: an entry that grew shows every call it stands for", () => {
    const one = { tool: "write", args: { filePath: "/p/a" } }
    const two = { tool: "write", args: { filePath: "/p/b" } }
    expect(heldCalls({ call: one }).map((call) => call.args[0]?.value)).toEqual(["/p/a"])
    expect(heldCalls({ call: one, calls: [one, two], version: 2 }).map((call) => call.args[0]?.value)).toEqual([
      "/p/a",
      "/p/b",
    ])
    expect(heldCalls({ calls: [one, "text", null, two] })).toHaveLength(2)
    expect(heldCalls(undefined)).toEqual([])
  })

  test("row 258: an always in this session is offered only for what the server named", () => {
    expect(heldAlways({ sessionAlways: ["git push *"] })).toEqual(["git push *"])
    expect(heldAlways({ sessionAlways: ["a/*", "", 3, null] })).toEqual(["a/*"])
    for (const metadata of [undefined, {}, { sessionAlways: [] }, { sessionAlways: "*" }, { always: ["*"] }])
      expect(heldAlways(metadata)).toEqual([])
  })

  test("row 160: the consent list ticks per pattern and sends only what is ticked and not yet allowed", () => {
    const list: ConsentList = {
      id: "consent_1",
      hash: "h1",
      dropped: 0,
      items: [
        { id: "c1", kind: "secret", pattern: ".env*", files: ["/p/.env"], named: true, checked: true, given: false },
        {
          id: "c2",
          kind: "sensitive",
          pattern: "id_rsa",
          files: ["/p/k/id_rsa"],
          named: false,
          checked: false,
          given: false,
        },
        {
          id: "c3",
          kind: "destination",
          pattern: "api.example.com",
          files: [],
          named: false,
          checked: true,
          given: true,
        },
      ],
    }
    expect(consentShown(list)).toBe(list)
    expect(consentShown(null)).toBeUndefined()
    expect(consentShown({ ...list, items: [] })).toBeUndefined()
    expect(consentShown({ ...list, items: list.items.map((item) => ({ ...item, given: true })) })).toBeUndefined()

    // What the scan ticked starts ticked; what is allowed stays ticked whatever the person does.
    expect([...consentTicked(list, {})]).toEqual(["c1", "c3"])
    expect([...consentTicked(list, { c1: false, c2: true, c3: false })]).toEqual(["c2", "c3"])

    expect(consentAllowInput("root", list, consentTicked(list, {}))).toEqual({
      sessionID: "root",
      hash: "h1",
      ids: ["c1"],
    })
    expect(consentAllowInput("root", list, consentTicked(list, { c2: true }))).toEqual({
      sessionID: "root",
      hash: "h1",
      ids: ["c1", "c2"],
    })
    expect(consentAllowInput("root", list, consentTicked(list, { c1: false }))).toBeUndefined()
    expect(consentAllowInput("root", list, new Set(["c3", "elsewhere"]))).toBeUndefined()
  })

  test("row 162: the archive row shows only while there is something in it, and empties exactly what was listed", () => {
    const entries = [
      { id: "20261102-101500-1", bytes: 1500, count: 2, paths: ["build/a.js", "build/b.js"] },
      { id: "20261102-101700-2", bytes: 500, count: 1, paths: ["notes.txt"] },
    ]
    const archive = { rootID: "root", entries, bytes: 2000, unsafe: false }
    expect(archiveShown(archive)).toBe(archive)
    expect(archiveShown({ ...archive, entries: [], bytes: 0 })).toBeUndefined()
    expect(archiveShown(null)).toBeUndefined()
    expect(archiveShown(undefined)).toBeUndefined()
    expect(archiveCount(archive)).toBe(3)

    // The ids sent are the entries the confirmation listed, in that order, and nothing else.
    expect(archiveEmptyInput("root", entries, false)).toEqual({
      sessionID: "root",
      ids: ["20261102-101500-1", "20261102-101700-2"],
    })
    expect(archiveEmptyInput("root", entries.slice(1), false)).toEqual({
      sessionID: "root",
      ids: ["20261102-101700-2"],
    })
    expect(archiveEmptyInput("root", [], false)).toBeUndefined()

    // A link in place of the archive keeps a row with its mark, and nothing is emptied from it.
    const unsafe = { rootID: "root", entries: [], bytes: 0, unsafe: true }
    expect(archiveShown(unsafe)).toBe(unsafe)
    expect(archiveEmptyInput("root", entries, true)).toBeUndefined()

    expect(archiveSize(0, "en")).toBe("0 byte")
    expect(archiveSize(999, "en")).toBe("999 byte")
    expect(archiveSize(1500, "en")).toBe("1.5 kB")
    expect(archiveSize(2_500_000, "en")).toBe("2.5 MB")
    expect(archiveSize(1_500, "id")).toBe("1,5 kB")
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
    // The consent row sits in the same slice: patterns and file names go in as text.
    expect(row).toContain("export function ConsentRow")
    expect(row).toContain("{item.pattern}")
    expect(row).toContain("{relativePath(file, props.directory)}")
    // So do the archive row and its confirmation: entry ids and archived paths go in as text.
    expect(row).toContain("export function ArchiveRow")
    expect(row).toContain("function DialogEmptyArchive")
    expect(row).toContain("{entry.id}")
    expect(row).toContain("{file}")
    expect(row).not.toMatch(/innerHTML|Markdown|<a\b|href|marked|createLink|data-markdown/)
    expect(source).not.toMatch(/innerHTML|<Markdown/)
  })

  test("1.1.1: History is decided, limited and notes in one log, latest first, the groups unchanged", () => {
    const lines = [
      marker("mode_on"),
      decision("ran", { decidedBy: "person" }),
      outcome("ran", "ran"),
      decision("stopped", { class: "B", decision: "defer", decidedBy: "gate" }),
      marker("bypass_on"),
      decision("main", {
        class: "A",
        category: "by_main_agent",
        bypassed: "outside_folder",
        decidedBy: "agent:main/build",
        via: "main_agent",
      }),
      decision("held", { class: "D", decision: "defer", decidedBy: "gate", category: "outward" }),
      decision("declined", {
        sessionID: "child",
        decision: "reject",
        decidedBy: "agent:main/build",
        via: "for_subagent",
        reason: "not part of the goal",
      }),
      marker("bypass_report"),
    ]
    const groups = decisionGroups(lines, "root")
    const history = historyOf(groups)
    expect(history.map((item) => [item.kind, item.kind === "note" ? item.note.note : item.entry.id])).toEqual([
      ["note", "report"],
      ["limited", "declined"],
      ["decided", "main"],
      ["note", "bypass_on"],
      ["limited", "stopped"],
      ["decided", "ran"],
      ["note", "mode_on"],
    ])
    // Waiting stays out of History, and the groups History reads are the same objects, untouched.
    expect(ids(groups.waiting)).toEqual(["held"])
    expect(ids(groups.decided)).toEqual(["main", "ran"])
    expect(history.flatMap((item) => (item.kind === "decided" ? [item.entry] : []))).toEqual(groups.decided)
    const entry = (id: string) => [...groups.decided, ...groups.limited].find((item) => item.id === id)
    expect(entry("stopped")?.stopped).toBe(true)
    expect(entry("declined")?.stopped).toBeUndefined()
    expect(entry("main")).toMatchObject({ by: "main/build", bypassed: "outside_folder", via: "main_agent" })
    expect(entry("declined")).toMatchObject({ by: "main/build", via: "for_subagent", reason: "not part of the goal" })
  })

  test("1.1.1: the consent and report markers become notes; nothing else new does", () => {
    const groups = decisionGroups([marker("bypass_on"), marker("consent_shown"), marker("bypass_report")], "root")
    expect(groups.notes.map((note) => note.note)).toEqual(["report", "bypass_on"])
    expect(historyOf({ waiting: [], decided: [], limited: [], notes: [] })).toEqual([])
  })

  test("row F16: a refresh hands back the same Waiting entry for an unchanged id, a new one for a changed id", () => {
    const entry = (id: string, pattern = "git push"): DecisionEntry => ({
      id,
      sessionID: "root",
      directory: "/repo",
      at: 1,
      permission: "bash",
      patterns: [pattern],
      patternsTruncated: false,
      follows: [],
    })
    const first = [entry("a"), entry("b")]
    const same = reuseById(first, [entry("a"), entry("b")])
    expect(same[0] === first[0]).toBe(true)
    expect(same[1] === first[1]).toBe(true)
    const next = reuseById(first, [entry("c"), entry("a"), entry("b", "git push -f")])
    expect(next[0]?.id).toBe("c")
    expect(next[1] === first[0]).toBe(true)
    expect(next[2] === first[1]).toBe(false)
    expect(reuseById([], [entry("a")])).toHaveLength(1)
  })

  test("review P6: a refresh hands back the same History item for an unchanged id, a new one for a changed id", () => {
    const entry = (id: string, outcome?: "ran" | "undone"): HistoryItem => ({
      kind: "decided",
      id,
      at: 1,
      entry: {
        id,
        sessionID: "root",
        directory: "/repo",
        at: 1,
        permission: "bash",
        patterns: ["ls"],
        patternsTruncated: false,
        follows: [],
        outcome,
      },
    })
    const first = [entry("a", "ran"), entry("b", "ran")]
    const same = reuseById(first, [entry("a", "ran"), entry("b", "ran")])
    expect(same[0]).toBe(first[0])
    expect(same[1]).toBe(first[1])
    const changed = reuseById(first, [entry("c"), entry("a", "undone"), entry("b", "ran")])
    expect(changed[0]?.id).toBe("c")
    expect(changed[1]).not.toBe(first[0])
    expect(changed[1]).toMatchObject({ entry: { outcome: "undone" } })
    expect(changed[2]).toBe(first[1])
    expect(reuseById([], first)).toBe(first)
  })
})
