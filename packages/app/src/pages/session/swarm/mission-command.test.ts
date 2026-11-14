import { describe, expect, test } from "bun:test"
import type { MissionAgentVM, MissionDecisionVM, MissionFeedLine, MissionVM } from "./mission-model"
import {
  checkInstruction,
  commandHead,
  createCommandController,
  decisionOptions,
  feedWho,
  INSTRUCTION_MAX,
  mergeFeed,
  missionWriterOf,
  type MissionCommandState,
  type MissionWriter,
} from "./mission-command-model"

// Fake translator: key plus sorted params, so assertions see exactly which string and values were used.
const t = (key: string, params?: Record<string, string | number | boolean>) =>
  params ? `${key}${JSON.stringify(Object.fromEntries(Object.entries(params).sort()))}` : key

const MISSION = "2026-11-07_kasus-07"

const decision: MissionDecisionVM = {
  id: "D-07",
  question: "Which template?",
  context: "Rev A or Rev B",
  options: [
    { id: "rev-a", label: "Rev A", consequence: "Keeps the manual form", recommended: true },
    { id: "rev-b", label: "Rev B", consequence: "Needs a new review", recommended: false },
  ],
}

const agent = (rowId: string, status: MissionAgentVM["status"], extra: Partial<MissionAgentVM> = {}): MissionAgentVM => ({
  rowId,
  title: `Row ${rowId}`,
  agent: "coder-execution",
  family: "build",
  tool: "code",
  status,
  phase: "implementation",
  wave: 1,
  checkpoint: null,
  heldBy: [],
  ...extra,
})

const line = (key: string, at: string, extra: Partial<MissionFeedLine> = {}): MissionFeedLine => ({
  key,
  from: "agent",
  to: "controller",
  text: key,
  at,
  ...extra,
})

function model(extra: Partial<MissionVM> = {}): MissionVM {
  return {
    id: MISSION,
    title: "Kasus 07",
    type: "document",
    status: "running",
    progress: { done: 3, total: 8, pct: 38 },
    held: 0,
    phases: [],
    layout: "lanes",
    agents: { "4": agent("4", "running") },
    waves: [],
    decision,
    openDecisions: 1,
    feed: [],
    deliverables: [],
    finalCount: 0,
    selfApproved: false,
    ...extra,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(writer: Partial<MissionWriter> = {}, prompt: (text: string) => Promise<unknown> = async () => {}) {
  const calls = { answer: [] as unknown[], instruct: [] as unknown[], prompt: [] as string[], refresh: 0, order: [] as string[] }
  const states: MissionCommandState[] = []
  const full: MissionWriter = {
    answer: async (input) => {
      calls.answer.push(input)
      calls.order.push("answer")
      return { ok: true, data: { decision: "U12", released: ["4"] } }
    },
    instruct: async (input) => {
      calls.instruct.push(input)
      calls.order.push("instruct")
      return { ok: true, data: { seq: 9 } }
    },
    ...writer,
  }
  const command = createCommandController({
    writer: full,
    refresh: () => {
      calls.refresh++
      calls.order.push("refresh")
    },
    prompt: (text) => {
      calls.prompt.push(text)
      calls.order.push("prompt")
      return prompt(text)
    },
    t,
    onState: (state) => states.push(state),
    now: () => "2026-11-07T12:00:00.000Z",
  })
  return { command, calls, states }
}

describe("missionWriterOf", () => {
  test("absent or partial platform field gives no writer", () => {
    expect(missionWriterOf({})).toBeUndefined()
    expect(missionWriterOf({ missions: { list() {}, get() {} } })).toBeUndefined()
    const missions = { answer: async () => ({}), instruct: async () => ({}) }
    expect(missionWriterOf({ missions }) as unknown).toBe(missions)
  })
})

describe("checkInstruction", () => {
  test("empty and whitespace-only are refused", () => {
    expect(checkInstruction("")).toEqual({ ok: false, reason: "empty" })
    expect(checkInstruction("   \t ")).toEqual({ ok: false, reason: "empty" })
  })
  test("trimmed, control characters become a space", () => {
    expect(checkInstruction("  focus on row 4  ")).toEqual({ ok: true, text: "focus on row 4" })
    expect(checkInstruction("a\tb\u0085c\u0000")).toEqual({ ok: true, text: "a b c" })
  })
  test("length limit is on the trimmed text", () => {
    expect(checkInstruction("x".repeat(INSTRUCTION_MAX))).toEqual({ ok: true, text: "x".repeat(INSTRUCTION_MAX) })
    expect(checkInstruction(`  ${"x".repeat(INSTRUCTION_MAX)}  `).ok).toBe(true)
    expect(checkInstruction("x".repeat(INSTRUCTION_MAX + 1))).toEqual({ ok: false, reason: "tooLong" })
    expect(INSTRUCTION_MAX).toBe(2000)
  })
})

describe("view helpers", () => {
  test("Recommended tag only on the recommended option, with consequence", () => {
    const options = decisionOptions(decision, t)
    expect(options).toEqual([
      { id: "rev-a", label: "Rev A", consequence: "Keeps the manual form", tag: "session.mission.decision.recommended" },
      { id: "rev-b", label: "Rev B", consequence: "Needs a new review", tag: undefined },
    ])
  })
  test("command head: on track or held", () => {
    expect(commandHead(model(), t)).toBe('session.mission.command.onTrack{"done":3,"total":8}')
    expect(commandHead(model({ held: 2 }), t)).toBe('session.mission.command.held{"done":3,"held":2,"total":8}')
  })
  test("feed who labels", () => {
    expect(feedWho(line("a", "x", { from: "owner", to: "controller" }), t)).toBe("session.mission.you → session.mission.swarm")
    expect(feedWho(line("b", "x", { agent: "verifier", row: "12" }), t)).toBe("verifier → session.mission.swarm · 12")
    expect(feedWho(line("c", "x", { from: "controller", to: "agent" }), t)).toBe("session.mission.swarm → session.mission.feed.agent")
  })
  // INTENT 1.2.7 U-4 (C6): newest first, up to FEED_SIZE 50 (was newest last, at most 4).
  test("feed order: by time, newest first, local lines merged", () => {
    const m = model({
      feed: [line("m3", "2026-11-07T11:30:00Z"), line("m2", "2026-11-07T11:00:00Z"), line("m1", "2026-11-07T10:00:00Z")],
    })
    const local = [line("l1", "2026-11-07T10:30:00Z", { local: true }), line("l2", "2026-11-07T12:00:00Z", { local: true })]
    expect(mergeFeed(m, local).map((item) => item.key)).toEqual(["l2", "m3", "m2", "l1", "m1"])
    expect(mergeFeed(m, []).map((item) => item.key)).toEqual(["m3", "m2", "m1"])
  })
})

describe("answer", () => {
  test("calls the adapter once with the mission, request and option ids, then refresh, then prompt", async () => {
    const { command, calls } = harness()
    const m = model()
    const first = command.answer(m.id, decision, "rev-b")
    // a second click while the first is in flight, and after it, is ignored
    const second = command.answer(m.id, decision, "rev-a")
    expect(await first).toBe(true)
    expect(await second).toBe(false)
    expect(await command.answer(m.id, decision, "rev-a")).toBe(false)
    expect(calls.answer).toEqual([{ mission: MISSION, request: "D-07", option: "rev-b" }])
    expect(calls.order).toEqual(["answer", "refresh", "prompt"])
    expect(calls.prompt).toEqual([
      `session.mission.prompt.answer{"decision":"U12","mission":"${MISSION}","option":"rev-b","request":"D-07"}`,
    ])
    // Row 135 L1: ids only; the agent-written label never reaches the user-role prompt.
    expect(calls.prompt.join("\n")).not.toContain("Rev B")
    expect(command.canAnswer(m.id, "D-07")).toBe(false)
    expect(command.canAnswer(m.id, "D-08")).toBe(true)
  })

  test("unknown option id: no call", async () => {
    const { command, calls } = harness()
    expect(await command.answer(MISSION, decision, "nope")).toBe(false)
    expect(calls.answer).toEqual([])
  })

  test("refused write: error shown, no prompt, options enabled again", async () => {
    const { command, calls } = harness({
      answer: async () => ({ ok: false, code: "DECISION_REQUEST_CLOSED", message: "request D-07 is closed" }),
    })
    expect(await command.answer(MISSION, decision, "rev-a")).toBe(false)
    expect(command.state.decisionError).toBe('session.mission.decision.failed{"reason":"request D-07 is closed"}')
    expect(calls.prompt).toEqual([])
    expect(calls.refresh).toBe(0)
    expect(command.canAnswer(MISSION, "D-07")).toBe(true)
  })

  test("thrown bridge error is shown with the code fallback", async () => {
    const { command } = harness({ answer: async () => ({ ok: false, code: "TIMEOUT", message: "" }) })
    await command.answer(MISSION, decision, "rev-a")
    expect(command.state.decisionError).toBe('session.mission.decision.failed{"reason":"TIMEOUT"}')
    const rejecting = harness({ answer: () => Promise.reject(new Error("ipc gone")) })
    await rejecting.command.answer(MISSION, decision, "rev-a")
    expect(rejecting.command.state.decisionError).toBe('session.mission.decision.failed{"reason":"ipc gone"}')
  })

  test("prompt failure keeps the answer, shows input.failed, no second write", async () => {
    const { command, calls } = harness({}, () => Promise.reject(new Error("session busy")))
    expect(await command.answer(MISSION, decision, "rev-a")).toBe(true)
    await flush()
    expect(calls.answer.length).toBe(1)
    expect(command.state.decisionError).toBe('session.mission.input.failed{"reason":"session busy"}')
    expect(command.canAnswer(MISSION, "D-07")).toBe(false)
  })
})

describe("instruction", () => {
  test("trimmed text goes to instruct, draft cleared, then refresh and prompt", async () => {
    const { command, calls } = harness()
    command.setDraft("   focus on the RAB   ")
    expect(command.canSend()).toBe(true)
    expect(await command.send(MISSION)).toBe(true)
    expect(calls.instruct).toEqual([{ mission: MISSION, text: "focus on the RAB" }])
    expect(calls.order).toEqual(["instruct", "refresh", "prompt"])
    expect(calls.prompt).toEqual([`session.mission.prompt.instruction{"mission":"${MISSION}","text":"focus on the RAB"}`])
    expect(command.state.draft).toBe("")
  })

  test("empty instruction: send disabled and no call", async () => {
    const { command, calls } = harness()
    command.setDraft("    ")
    expect(command.canSend()).toBe(false)
    expect(await command.send(MISSION)).toBe(false)
    expect(calls.instruct).toEqual([])
    expect(command.state.inputError).toBeNull()
  })

  test("over the limit: tooLong message while typing, no call", async () => {
    const { command, calls } = harness()
    command.setDraft("x".repeat(INSTRUCTION_MAX + 1))
    expect(command.state.inputError).toBe('session.mission.input.tooLong{"max":2000}')
    expect(command.canSend()).toBe(false)
    expect(await command.send(MISSION)).toBe(false)
    expect(calls.instruct).toEqual([])
    command.setDraft("x".repeat(INSTRUCTION_MAX))
    expect(command.state.inputError).toBeNull()
    expect(command.canSend()).toBe(true)
  })

  test("refused write keeps the draft and shows the reason", async () => {
    const { command, calls } = harness({ instruct: async () => ({ ok: false, code: "BAD_ARGUMENT", message: "text" }) })
    command.setDraft("hello")
    expect(await command.send(MISSION)).toBe(false)
    expect(command.state.draft).toBe("hello")
    expect(command.state.inputError).toBe('session.mission.input.failed{"reason":"text"}')
    expect(calls.prompt).toEqual([])
  })

  test("Prioritise unblock chip sends the preset text and keeps the draft", async () => {
    const { command, calls } = harness()
    command.setDraft("my draft")
    expect(await command.unblock(MISSION)).toBe(true)
    expect(calls.instruct).toEqual([{ mission: MISSION, text: "session.mission.unblock.text" }])
    expect(command.state.draft).toBe("my draft")
  })
})

describe("What's blocking?", () => {
  test("local line, no call; list or none; dropped on mission switch", () => {
    const { command, calls } = harness()
    const held = model({
      held: 2,
      agents: {
        "4": agent("4", "issue", { note: "lint failed" }),
        "5": agent("5", "blocked", { heldBy: ["D-07"] }),
        "6": agent("6", "running"),
      },
    })
    command.why(held)
    const feed = command.feed(held)
    expect(feed.length).toBe(1)
    expect(feed[0]).toMatchObject({ from: "controller", to: "owner", local: true })
    expect(feed[0].text).toBe('session.mission.why.list{"rows":"4 Row 4 (lint failed), 5 Row 5 (D-07)"}')
    expect(calls.instruct).toEqual([])
    expect(calls.answer).toEqual([])

    const other = model({ id: "2026-11-07_other", agents: {} })
    expect(command.feed(other)).toEqual([])
    command.why(other)
    expect(command.feed(other)[0].text).toBe("session.mission.why.none")
    expect(command.feed(held)).toEqual([])
  })
})
