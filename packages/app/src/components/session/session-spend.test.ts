import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { sessionSpend, spendLimitDetail } from "./session-spend"

const providers = [
  { id: "p", models: { m: { cost: { input: 4, output: 20, cache: { read: 0.2, write: 5 } } } } },
]
const assistant = (cost: number, tokens: { input?: number; output?: number; read?: number; write?: number }) =>
  ({
    role: "assistant",
    providerID: "p",
    modelID: "m",
    cost,
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: 0,
      cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
    },
  }) as unknown as Message

describe("sessionSpend", () => {
  test("nothing billed shows nothing", () => {
    expect(sessionSpend({ messages: [], providers, subagentCost: 0 })).toBeUndefined()
    expect(sessionSpend({ messages: [assistant(0, { input: 900 })], providers, subagentCost: 0 })).toBeUndefined()
  })

  test("splits a step by what it paid for, and adds subagents", () => {
    const spend = sessionSpend({
      messages: [assistant(0.6 + 0.2 + 0.2, { output: 30_000, read: 1_000_000, write: 40_000 })],
      providers,
      subagentCost: 1,
    })!
    expect(spend.total).toBeCloseTo(2)
    const cost = Object.fromEntries(spend.segments.map((item) => [item.key, item.cost]))
    expect(cost.writing).toBeCloseTo(0.6)
    expect(cost.fresh).toBeCloseTo(0.2)
    expect(cost.reread).toBeCloseTo(0.2)
    expect(cost.subagents).toBeCloseTo(1)
    // 1M read at 3.80 under list, minus the 0.04 write premium.
    expect(spend.saved).toBeCloseTo(3.76)
  })

  test("the total follows what was billed when list prices disagree", () => {
    const spend = sessionSpend({ messages: [assistant(2, { input: 250_000 })], providers, subagentCost: 0 })!
    expect(spend.total).toBeCloseTo(2)
  })

  test("a model with no known price still counts through its subagents only", () => {
    const unknown = { ...assistant(1, { input: 10 }), modelID: "other" } as Message
    const spend = sessionSpend({ messages: [unknown], providers, subagentCost: 0.5 })!
    expect(spend.segments.map((item) => item.key)).toEqual(["subagents"])
  })
})

describe("spendLimitDetail", () => {
  test("reads only spend limit requests, tolerating bad metadata", () => {
    expect(spendLimitDetail({ permission: "bash", metadata: {} })).toBeUndefined()
    expect(spendLimitDetail({ permission: "spend_limit", metadata: { spent: 12.5, next: "x" } })).toEqual({
      spent: 12.5,
      next: 0,
      subagents: 0,
      subagentCost: 0,
    })
  })
})
