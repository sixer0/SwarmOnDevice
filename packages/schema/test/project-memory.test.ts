import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProjectMemory } from "../src/project-memory"

const base = { id: "a1b2c3", text: "hook", source: "agent", deviceOnly: true, time: 1 } as const

describe("project memory schema (1.2.6 P-05)", () => {
  test("a 1.2.5 item decodes unchanged", () => {
    const item = Schema.decodeUnknownSync(ProjectMemory.Item)(base)
    expect(item).toEqual(base)
  })

  test("body, refs and untrusted decode", () => {
    const item = Schema.decodeUnknownSync(ProjectMemory.Item)({
      ...base,
      body: "line one\nline two",
      refs: [{ path: "src/a.ts", line: 3 }, { path: "src/b.ts" }, { symbol: "Memory.add" }, { symbol: "add", path: "src/m.ts" }],
      untrusted: true,
    })
    expect(item.body).toBe("line one\nline two")
    expect(item.refs).toHaveLength(4)
    expect(item.untrusted).toBe(true)
  })

  test("MemoryRef rejects a line below 1 and a non-integer line", () => {
    const decode = Schema.decodeUnknownSync(ProjectMemory.MemoryRef)
    expect(() => decode({ path: "a", line: 0 })).toThrow()
    expect(() => decode({ path: "a", line: 1.5 })).toThrow()
    expect(decode({ path: "a", line: 1 })).toEqual({ path: "a", line: 1 })
  })

  test("limits are not schema rules: an over-long hook, body and 11 refs still decode", () => {
    const item = Schema.decodeUnknownSync(ProjectMemory.Item)({
      ...base,
      text: "x".repeat(2500),
      body: "y".repeat(10001),
      refs: Array.from({ length: 11 }, (_, i) => ({ path: `f${i}` })),
    })
    expect(item.refs).toHaveLength(11)
  })

  test("refusal literals include body_long and too_many_refs and keep full", () => {
    const decode = Schema.decodeUnknownSync(ProjectMemory.Refusal)
    for (const r of ["empty", "long", "secret", "full", "body_long", "too_many_refs"] as const) expect(decode(r)).toBe(r)
  })
})
