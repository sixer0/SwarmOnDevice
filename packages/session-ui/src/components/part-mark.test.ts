import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { failedExit, toolMark, notRun } from "./part-mark"

const tool = (state: Record<string, unknown>) => ({ type: "tool", tool: "bash", state }) as unknown as Part

describe("toolMark", () => {
  test("a command that exits non-zero is failed even though the tool completed", () => {
    expect(toolMark(tool({ status: "completed", metadata: { exit: 1 } }))).toBe("failed")
    expect(failedExit({ exit: 2 })).toBe(2)
  })

  test("exit 0 and tools with no exit code are done", () => {
    expect(toolMark(tool({ status: "completed", metadata: { exit: 0 } }))).toBe("done")
    expect(toolMark(tool({ status: "completed", metadata: {} }))).toBe("done")
    expect(failedExit({ exit: 0 })).toBeUndefined()
  })

  test("running, errored, and parts that are not tools", () => {
    expect(toolMark(tool({ status: "pending" }))).toBe("running")
    expect(toolMark(tool({ status: "running" }))).toBe("running")
    expect(toolMark(tool({ status: "error", error: "boom" }))).toBe("failed")
    expect(toolMark({ type: "text", text: "hi" } as unknown as Part)).toBeUndefined()
    expect(toolMark(undefined)).toBeUndefined()
  })
})

const stopped = (metadata?: object) =>
  ({ type: "tool", state: { status: "error", error: "x", input: {}, metadata, time: { start: 1, end: 2 } } }) as unknown as Part

describe("a call the permission gate stopped", () => {
  test("is not a failure", () => {
    expect(toolMark(stopped({ notRun: "away" }))).toBe("done")
    expect(toolMark(stopped({ notRun: "declined" }))).toBe("done")
  })

  test("any other error still is", () => {
    expect(toolMark(stopped())).toBe("failed")
    expect(toolMark(stopped({ notRun: "something else" }))).toBe("failed")
  })

  test("notRun only names the reasons it knows", () => {
    expect(notRun({ notRun: "away" })).toBe("away")
    expect(notRun({ exit: 1 })).toBeUndefined()
    expect(notRun(undefined)).toBeUndefined()
  })
})
