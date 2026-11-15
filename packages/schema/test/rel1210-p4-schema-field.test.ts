import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ProjectMemory } from "../src/project-memory"

// 1.2.10 row 52 (AC-P4-schema, N10-173): the memory export fields and the three new refusal literals.
const base = { id: "a1b2c3", text: "hook", source: "agent", deviceOnly: true, time: 1 } as const
const descriptionOf = (schema: { readonly ast: { readonly annotations?: Record<string, unknown> } }) =>
  schema.ast.annotations?.description
const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

describe("project memory export fields (1.2.10 row 52)", () => {
  test("decode keeps vaultAllowed: true", () => {
    const out = Schema.decodeUnknownOption(ProjectMemory.Item)({ ...base, vaultAllowed: true })
    expect(Option.isSome(out)).toBe(true)
    if (Option.isSome(out)) expect(out.value.vaultAllowed).toBe(true)
  })

  test("decode keeps vaultReportSha256 beside vaultAllowed", () => {
    const item = Schema.decodeUnknownSync(ProjectMemory.Item)({ ...base, vaultAllowed: true, vaultReportSha256: sha })
    expect(item.vaultAllowed).toBe(true)
    expect(item.vaultReportSha256).toBe(sha)
  })

  test("an item without the fields decodes and encodes with no such key", () => {
    const item = Schema.decodeUnknownSync(ProjectMemory.Item)(base)
    expect(item).toEqual(base)
    expect("vaultAllowed" in item).toBe(false)
    expect("vaultReportSha256" in item).toBe(false)
    const encoded = Schema.encodeSync(ProjectMemory.Item)(item)
    expect(Object.keys(encoded)).not.toContain("vaultAllowed")
    expect(Object.keys(encoded)).not.toContain("vaultReportSha256")
  })

  test("a 1.2.9-shaped store (items with and without the optional fields of 1.2.8) decodes unchanged", () => {
    const items = [
      base,
      { ...base, id: "b", deviceOnly: false, kind: "index", missionId: "m1", rolledInto: "r" },
      { ...base, id: "c", body: "b", untrusted: true, refs: [{ path: "a.ts", line: 2 }] },
    ]
    const info = Schema.decodeUnknownSync(ProjectMemory.Info)({ enabled: true, items })
    expect(info.items).toEqual(items as never)
  })

  test("the deviceOnly annotation is byte-identical", () => {
    expect(descriptionOf(ProjectMemory.Item.fields.deviceOnly)).toBe("Never sent to a model that runs off this device")
  })

  test("the new field annotations state the rule", () => {
    expect(descriptionOf(ProjectMemory.Item.fields.vaultAllowed)).toBe(
      "The person allowed this device-only note into the Obsidian vault mirror. Set only from the Swarm desktop app. Does not change deviceOnly: the note is still never sent to a model off this device.",
    )
    expect(descriptionOf(ProjectMemory.Item.fields.vaultReportSha256)).toBeString()
  })

  test("MemoryRefusal has 13 members including classified, not_device_only and archived", () => {
    const literals = ProjectMemory.Refusal.literals as readonly string[]
    expect(literals).toHaveLength(13)
    for (const key of ["classified", "not_device_only", "archived"]) expect(literals).toContain(key)
    for (const key of ["empty", "long", "secret", "full", "body_long", "too_many_refs", "index_long", "index_body_long", "index_format", "index_full"])
      expect(literals).toContain(key)
    expect(Schema.decodeUnknownOption(ProjectMemory.Refusal)("archived")._tag).toBe("Some")
  })
})
