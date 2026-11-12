// 1.2.6 FX-5/6 (M1 S6): the note limits (2000 / 10000 / 10) have one source, ProjectMemory.LIMITS in the schema package.
// The server (Memory.MAX_*) reads it, and the app's memory view takes its refusal numbers from it instead of a copy.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ProjectMemory } from "@opencode-ai/schema/project-memory"
import { Memory } from "@/memory/memory"

const APP_VIEW = path.resolve(import.meta.dir, "../../../app/src/components/project-memory.tsx")

describe("M1 S6: memory limits have one source", () => {
  test("the schema exports the limits and the server reads them from there", () => {
    const limits = (ProjectMemory as Record<string, any>).LIMITS
    expect(limits).toEqual({ text: 2000, body: 10000, refs: 10 })
    expect(Memory.MAX_TEXT).toBe(limits.text)
    expect(Memory.MAX_BODY).toBe(limits.body)
    expect(Memory.MAX_REFS).toBe(limits.refs)
  })

  test("the app's memory view reads the same constant and keeps no copy", () => {
    const source = fs.readFileSync(APP_VIEW, "utf8")
    expect(source).toMatch(/import \{[^}]*\bProjectMemory\b[^}]*\} from "@opencode-ai\/schema\/project-memory"/)
    expect(source).toContain("ProjectMemory.LIMITS")
    expect(source).not.toMatch(/\b(2000|10000)\b/)
    expect(source).not.toMatch(/MEMORY_LIMITS\s*=\s*\{/)
  })
})
