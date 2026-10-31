import { describe, expect, test } from "bun:test"
import { compareModels, compareProviders, formatPrice, priceLabel, repriceSession, sumTokens } from "./model-price"

const model = (name: string, input?: number, output = 0, onDevice = false) => ({
  name,
  cost: input === undefined ? undefined : { input, output },
  provider: { options: { onDevice } },
})

describe("formatPrice", () => {
  test("keeps small prices readable and drops trailing zeros", () => {
    expect(formatPrice(3)).toBe("$3")
    expect(formatPrice(0.25)).toBe("$0.25")
    expect(formatPrice(0.075)).toBe("$0.075")
    expect(formatPrice(1.25)).toBe("$1.25")
    expect(formatPrice(150)).toBe("$150")
  })
})

describe("priceLabel", () => {
  test("shows input and output", () => expect(priceLabel(model("a", 3, 15))).toBe("$3 / $15"))
  test("says nothing rather than free when the catalog price is zero or missing", () => {
    expect(priceLabel(model("subscription", 0, 0))).toBeUndefined()
    expect(priceLabel(model("unknown"))).toBeUndefined()
  })
})

describe("compareModels", () => {
  test("orders cheapest first, then unpriced by name", () => {
    const sorted = [model("Opus", 5, 25), model("Zed"), model("Haiku", 1, 5), model("Abe", 0, 0), model("Sonnet", 3, 15)]
      .toSorted(compareModels)
      .map((item) => item.name)
    expect(sorted).toEqual(["Haiku", "Sonnet", "Opus", "Abe", "Zed"])
  })
  test("keeps the server's ranking for local models", () => {
    const sorted = [model("z-best", 0, 0, true), model("a-worse", 0, 0, true)].toSorted(compareModels)
    expect(sorted.map((item) => item.name)).toEqual(["z-best", "a-worse"])
  })
})

test("compareProviders puts on-device first", () => {
  const cloud = { options: {} }
  const local = { options: { onDevice: true } }
  expect([cloud, local].toSorted(compareProviders)[0]).toBe(local)
})

describe("session repricing", () => {
  const tokens = sumTokens([
    { input: 1000, output: 500, reasoning: 100, cache: { read: 2000, write: 1000 } },
    { input: 1000, output: 500 },
  ])!

  test("adds up every turn", () => {
    expect(tokens).toEqual({ input: 2000, output: 1000, reasoning: 100, cache: { read: 2000, write: 1000 } })
  })
  test("no usage yet means nothing to reprice", () => {
    expect(sumTokens([])).toBeUndefined()
    expect(sumTokens([{ input: 0, output: 0 }])).toBeUndefined()
  })
  test("prices reasoning as output and uses cache rates", () => {
    expect(repriceSession(tokens, { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })).toBeCloseTo(
      (2000 * 3 + 1100 * 15 + 2000 * 0.3 + 1000 * 3.75) / 1e6,
    )
  })
  test("falls back to the input rate when the catalog has no cache rate", () => {
    expect(repriceSession(tokens, { input: 3, output: 15 })).toBeCloseTo((2000 * 3 + 1100 * 15 + 3000 * 3) / 1e6)
  })
})
