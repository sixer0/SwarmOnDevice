import { describe, expect, test } from "bun:test"
import { SessionSearchExtract } from "../../src/session/search/extract"

const tool = (name: string, input: object, extra: object = {}) => ({
  type: "tool",
  tool: name,
  state: { status: "completed", input, output: "OUTPUT TEXT", title: "t", ...extra },
})

describe("SessionSearchExtract.extract", () => {
  test("text belongs to whoever's message it is in", () => {
    expect(SessionSearchExtract.extract({ type: "text", text: "hi" }, "user")?.kind).toBe("prompt")
    expect(SessionSearchExtract.extract({ type: "text", text: "hi" }, "assistant")?.kind).toBe("said")
  })

  test("injected and empty text is not something anyone said", () => {
    expect(SessionSearchExtract.extract({ type: "text", text: "reminder", synthetic: true }, "user")).toBeNull()
    expect(SessionSearchExtract.extract({ type: "text", text: "  " }, "user")).toBeNull()
    expect(SessionSearchExtract.extract({ type: "step-start" }, "assistant")).toBeNull()
  })

  test("a secret written into a prompt or a command does not reach the index", () => {
    const prompt = SessionSearchExtract.extract({ type: "text", text: "use the token TYPEDsecretVALUEeee555 please" }, "user")
    expect(prompt?.text).not.toContain("TYPEDsecretVALUEeee555")
    expect(prompt?.text).toContain("please")
    const shell = SessionSearchExtract.extract(tool("bash", { command: "API_KEY=INPUTsecretVALUEddd444 echo hi" }), "assistant")
    expect(shell?.text).not.toContain("INPUTsecretVALUEddd444")
    expect(shell?.label).not.toContain("INPUTsecretVALUEddd444")
    expect(shell?.text).toContain("echo hi")
    const edit = SessionSearchExtract.extract(tool("write", { filePath: "cfg.txt", content: "password = hunter2hunter2\n" }), "assistant")
    expect(edit?.text).not.toContain("hunter2hunter2")
  })

  test("a tool still running has nothing to index yet", () => {
    expect(SessionSearchExtract.extract(tool("bash", { command: "x" }, { status: "running" }), "assistant")).toBeNull()
  })

  test("reading a file indexes which file, not somebody else's words", () => {
    const doc = SessionSearchExtract.extract(tool("read", { filePath: "src/a.ts" }), "assistant")
    expect(doc?.text).toContain("src/a.ts")
    expect(doc?.text).not.toContain("OUTPUT TEXT")
  })

  test("a command keeps its output, trimmed in the middle", () => {
    const output = "A".repeat(3000) + "MIDDLE" + "B".repeat(3000)
    const doc = SessionSearchExtract.extract(tool("bash", { command: "bun test" }, { output }), "assistant")
    expect(doc?.kind).toBe("tool")
    expect(doc?.label).toBe("bun test")
    expect(doc?.text).toContain("bun test")
    expect(doc?.text).not.toContain("MIDDLE")
    expect(doc?.text.endsWith("B")).toBe(true)
  })

  test("a failed tool keeps its error", () => {
    const doc = SessionSearchExtract.extract(
      tool("bash", { command: "x" }, { status: "error", error: "ENOENT missing" }),
      "assistant",
    )
    expect(doc?.text).toContain("ENOENT missing")
  })

  test("edits index what was written and where", () => {
    expect(SessionSearchExtract.extract(tool("edit", { filePath: "a.ts", oldString: "old", newString: "new" }), "x")).toEqual({
      kind: "edit",
      text: "new",
      label: "a.ts",
    })
    expect(SessionSearchExtract.extract(tool("write", { filePath: "a.ts", content: "all" }), "x")?.text).toBe("all")
    const patch = "*** Begin Patch\n*** Update File: b.ts\n@@\n-gone\n+added\n*** End Patch"
    expect(SessionSearchExtract.extract(tool("apply_patch", { patchText: patch }), "x")).toEqual({
      kind: "edit",
      text: "added",
      label: "b.ts",
    })
  })
})

describe("SessionSearchExtract.editWroteLine", () => {
  const line = "const a = 1"
  test("new in this edit", () => {
    expect(SessionSearchExtract.editWroteLine("edit", { oldString: "x", newString: `  ${line}\nb` }, line)).toBe("introduced")
    expect(SessionSearchExtract.editWroteLine("write", { content: line }, line)).toBe("introduced")
  })
  test("already there, only carried along", () => {
    expect(SessionSearchExtract.editWroteLine("edit", { oldString: line, newString: `${line}\nb` }, line)).toBe("carried")
    const patch = `*** Update File: a\n-${line}\n+${line}\n`
    expect(SessionSearchExtract.editWroteLine("apply_patch", { patchText: patch }, line)).toBe("carried")
  })
  test("a line that only contains the text is a different line", () => {
    expect(SessionSearchExtract.editWroteLine("edit", { oldString: "x", newString: `// ${line} here` }, line)).toBeUndefined()
    expect(SessionSearchExtract.editWroteLine("edit", { oldString: "x", newString: line }, "  ")).toBeUndefined()
  })
})
