import { describe, expect, test } from "bun:test"
import { modelFooter, sortModelOptions } from "../../../../src/component/dialog-model"

describe("modelFooter", () => {
  const cloud = { id: "anthropic" }
  const local = { id: "ollama", options: { onDevice: true } }

  test("shows input and output prices per million tokens", () => {
    expect(modelFooter(cloud, { cost: { input: 3, output: 15 } })).toBe("$3/$15")
    expect(modelFooter(cloud, { cost: { input: 0.075, output: 0.3 } })).toBe("$0.075/$0.3")
  })
  test("calls only local models free, not a zero price from a cloud provider", () => {
    expect(modelFooter(local, { cost: { input: 0, output: 0 } })).toBe("Free")
    expect(modelFooter(cloud, { cost: { input: 0, output: 0 } })).toBeUndefined()
  })
  test("warns about a model that cannot use tools", () => {
    expect(modelFooter(local, { capabilities: { toolcall: false } })).toBe("Chat only")
  })
})

describe("sortModelOptions", () => {
  test("orders provider-scoped model choices by newest release first", () => {
    const sorted = sortModelOptions(
      [
        { title: "GPT 5.2", releaseDate: "2025-12-11" },
        { title: "GPT 5.4", releaseDate: "2026-03-05" },
        { title: "GPT 5.1", releaseDate: "2025-11-13" },
      ],
      true,
    )

    expect(sorted.map((model) => model.title)).toEqual(["GPT 5.4", "GPT 5.2", "GPT 5.1"])
  })

  test("orders regular model choices free-first and then newest-first", () => {
    const sorted = sortModelOptions(
      [
        { title: "GLM 5", releaseDate: "2025-07-28" },
        { title: "GLM 5.1", releaseDate: "2025-12-09" },
        { title: "GLM 5.2", releaseDate: "2026-02-16" },
        { title: "Free old", releaseDate: "2024-01-01", footer: "Free" },
        { title: "Free new", releaseDate: "2025-01-01", footer: "Free" },
      ],
      false,
    )

    expect(sorted.map((model) => model.title)).toEqual(["Free new", "Free old", "GLM 5.2", "GLM 5.1", "GLM 5"])
  })
})
