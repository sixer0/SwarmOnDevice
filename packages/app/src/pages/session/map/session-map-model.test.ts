import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import {
  buildSessionMap,
  failureLine,
  mapRows,
  nextProblem,
  relativePath,
  sinceYouLooked,
  stepReference,
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
