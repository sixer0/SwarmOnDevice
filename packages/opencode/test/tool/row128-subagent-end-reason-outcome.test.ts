// 1.3.3 row 128 (MC-2 follow-up of row 8): a subagent turn that ended without work (`finish` = text-tool-call,
// tools-unavailable[:server], empty-step) is reported to its parent as a no-result outcome, never as `completed`.
import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProcessor } from "../../src/session/processor"
import { SessionID } from "../../src/session/schema"
import * as Task from "../../src/tool/task"

// Register N-103.
const PREFIX = "Subagent returned no result:"
const child = SessionID.make("ses_row128child")
const CALL = '<tool_call>{"name":"read","arguments":{"filePath":"a.txt"}}</tool_call>'

function last(finish: string | undefined, text?: string): SessionV1.WithParts {
  return {
    info: { role: "assistant", finish },
    parts: text === undefined ? [] : [{ type: "text", text }],
  } as unknown as SessionV1.WithParts
}

const reasons = [
  { finish: SessionProcessor.turnEndFinish({ reason: "text-tool-call", corrections: 3 }), reason: "text-tool-call", words: "wrote a tool call as text" },
  { finish: SessionProcessor.turnEndFinish({ reason: "empty-step", corrections: 3 }), reason: "empty-step", words: "empty steps" },
  {
    finish: SessionProcessor.turnEndFinish({ reason: "tools-unavailable", server: "datum-studio", corrections: 0 }),
    reason: "tools-unavailable",
    words: 'tools of the server "datum-studio" were not available',
  },
  { finish: "tools-unavailable", reason: "tools-unavailable", words: "tools it needed were not available" },
] as const

describe("row 128: turn-end reasons are a no-result task outcome", () => {
  for (const item of reasons) {
    test(`${item.finish} with text is not completed`, () => {
      const outcome = Task.taskOutcome(child, last(item.finish, CALL))
      expect(outcome.type).toBe("empty")
      if (outcome.type !== "empty") return
      expect(outcome.reason).toBe(item.reason)
      expect(outcome.text.startsWith(`${PREFIX} ${item.reason} (task_id: ${child}): `)).toBe(true)
      expect(outcome.text).toContain(item.words)
      expect(outcome.text).toContain("Do not treat this task as done.")
      expect(outcome.text).toContain(`What the subagent had so far:\n${CALL}`)
    })

    test(`${item.finish} without text is not completed`, () => {
      const outcome = Task.taskOutcome(child, last(item.finish))
      expect(outcome.type).toBe("empty")
      if (outcome.type !== "empty") return
      expect(outcome.reason).toBe(item.reason)
      expect(outcome.text).toContain(item.words)
      expect(outcome.text).toContain("The subagent left no partial result.")
    })
  }

  test("a server name with a colon is kept whole", () => {
    const outcome = Task.taskOutcome(child, last("tools-unavailable:acme:8080", "x"))
    expect(outcome.type).toBe("empty")
    if (outcome.type !== "empty") return
    expect(outcome.text).toContain('tools of the server "acme:8080" were not available')
  })

  test("the values recognised here are the ones the processor stores", () => {
    for (const item of reasons) expect(SessionProcessor.parseTurnEnd(item.finish)?.reason).toBe(item.reason)
  })

  test("every other finish value behaves as before", () => {
    expect(Task.taskOutcome(child, last("stop", "done"))).toEqual({ type: "completed", text: "done" })
    expect(Task.taskOutcome(child, last("end_turn", "done"))).toEqual({ type: "completed", text: "done" })
    expect(Task.taskOutcome(child, last("length", "half"))).toEqual({ type: "completed", text: "half" })
    // Near misses are not end reasons.
    expect(Task.taskOutcome(child, last("tools-unavailable-x", "done"))).toEqual({ type: "completed", text: "done" })
    expect(Task.taskOutcome(child, last("text-tool-calls", "done"))).toEqual({ type: "completed", text: "done" })
    expect(Task.taskOutcome(child, last("stop"))).toMatchObject({ type: "empty", reason: "no-text" })
    expect(Task.taskOutcome(child, last("length"))).toMatchObject({ type: "empty", reason: "length" })
    expect(Task.taskOutcome(child, last("tool-calls", "x"))).toMatchObject({ type: "empty", reason: "tool-calls" })
    expect(Task.taskOutcome(child, last("unknown", "x"))).toMatchObject({ type: "empty", reason: "unfinished" })
    expect(Task.taskOutcome(child, last(undefined, "x"))).toMatchObject({ type: "empty", reason: "unfinished" })
  })
})
