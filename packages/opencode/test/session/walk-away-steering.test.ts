// A model that opens with `ls` holds a walked-away run for the whole first wait. The real thinker said why: "The system prompt
// says to use ls tool... but there is no ls tool available." Whether a model obeys is for a real run to show. What this pins is
// that nothing Swarm sends tells it to look for one, and that what it sends names the way that needs nobody.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import SHELL from "../../src/tool/shell/shell.txt"
import READ from "../../src/tool/read.txt"
import { SystemPrompt } from "../../src/session/system"

const directory = path.join(import.meta.dir, "../../src/session/prompt")
const prompts = fs
  .readdirSync(directory)
  .filter((file) => file.endsWith(".txt"))
  .map((file) => [file, fs.readFileSync(path.join(directory, file), "utf8")] as const)

describe("nothing steers a model to a shell listing", () => {
  test("no prompt names an ls tool, or shows the agent running ls", () => {
    for (const [file, text] of prompts) {
      expect([file, /\bls tool\b|runs ls\b|tool_call: ls\b/.test(text)]).toEqual([file, false])
      expect([file, /^assistant: ls$/m.test(text)]).toEqual([file, false])
    }
  })

  test("a model with no prompt of its own, as an internal one is, gets told how to list a directory", () => {
    const [text] = SystemPrompt.provider({ api: { id: "thinker" }, providerID: "gsp-ai-tail" } as never)
    expect(text).toContain("There is no `ls` tool: to list a directory, call read with the directory's path.")
  })

  test("the tools say so themselves", () => {
    expect(SHELL).toContain("never start with `ls`")
    expect(READ).toContain("This is how to list a directory")
  })

  test("a request released for nobody answering names the shell-free tools", () => {
    const message = new PermissionV1.AwayError().message
    for (const tool of ["read for a file or a directory's listing", "glob to find files", "grep to search", "git for the repository's state"])
      expect(message).toContain(tool)
    expect(message).toContain("did not run")
    expect(message).toContain("list what you skipped")
  })
})
