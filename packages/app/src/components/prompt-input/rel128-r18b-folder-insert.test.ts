import { describe, expect, test } from "bun:test"
import { promptInputV2FolderPart } from "@opencode-ai/session-ui/v2/prompt-input/interaction"
import type { Prompt } from "@/context/prompt"
import { buildRequestParts } from "./build-request-parts"

// 1.2.8 AC-R18b (N8-325, PROBE). The old-layout "Add folder" palette command (prompt-input.tsx `addFolder`) inserts
// `promptInputV2FolderPart(path)` for the picked folder; on send `buildRequestParts` turns it into the request part.
// Contract (1.2.7 C63 D-12a-d, C67): one path reference, a file part with mime application/x-directory and the label
// `@<folder name>`, never an upload; a folder outside the project is sent the same way and the server's
// external_directory permission decides (U-12 stays a USER row). This file drives that pure chain only.

const session = "/repo/app"

function send(picked: string) {
  const part = promptInputV2FolderPart(picked)
  const prompt: Prompt = [{ ...part, start: 0, end: part.content.length }]
  return {
    part,
    result: buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: part.content,
      messageID: "msg_r18b",
      sessionID: "ses_r18b",
      sessionDirectory: session,
    }),
  }
}

describe("AC-R18b picked-folder insert (old layout)", () => {
  test("a folder inside the project gives exactly one directory reference part", () => {
    const { part, result } = send("/repo/app/src/lib/")
    expect(part).toMatchObject({
      type: "file",
      path: "/repo/app/src/lib/",
      content: "@lib",
      mime: "application/x-directory",
      filename: "lib",
    })
    const files = result.requestParts.filter((item) => item.type === "file")
    expect(files).toHaveLength(1)
    const file = files[0]
    if (file?.type !== "file") throw new Error("no file part")
    expect(file.mime).toBe("application/x-directory")
    expect(file.url).toBe("file:///repo/app/src/lib/")
    expect(file.url.startsWith(`file://${session}/`)).toBe(true)
    expect(file.filename).toBe("lib")
    expect(file.source?.type).toBe("file")
    if (file.source?.type === "file") {
      expect(file.source.path).toBe("/repo/app/src/lib/")
      expect(file.source.text.value).toBe("@lib")
    }
    // A reference, not an upload: no data URL and no synthetic text carrying the folder content.
    expect(file.url.startsWith("data:")).toBe(false)
    expect(result.requestParts.filter((item) => item.type === "text" && item.synthetic)).toHaveLength(0)
  })

  test("the project folder itself is one reference to the project root", () => {
    const { result } = send(session)
    const files = result.requestParts.filter((item) => item.type === "file")
    expect(files).toHaveLength(1)
    expect(files[0]?.type === "file" && files[0].url).toBe("file:///repo/app")
  })

  test("a folder outside the project is still one path reference; nothing is read on the client", () => {
    const { result } = send("/elsewhere/notes")
    const files = result.requestParts.filter((item) => item.type === "file")
    expect(files).toHaveLength(1)
    const file = files[0]
    if (file?.type !== "file") throw new Error("no file part")
    expect(file.mime).toBe("application/x-directory")
    expect(file.url).toBe("file:///elsewhere/notes")
    expect(file.url.startsWith(`file://${session}/`)).toBe(false)
    expect(result.requestParts.filter((item) => item.type === "text" && item.synthetic)).toHaveLength(0)
  })
})
