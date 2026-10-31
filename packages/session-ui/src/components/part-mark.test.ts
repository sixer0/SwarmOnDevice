import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { failedExit, toolMark } from "./part-mark"

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
