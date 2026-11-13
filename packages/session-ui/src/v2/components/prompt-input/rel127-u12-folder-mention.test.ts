// U-12 (1.2.7 row U12): "Add folder" puts a folder into the prompt as a path reference (a file part with
// mime application/x-directory, no url, no blob), at the cursor, without eating text typed before it.
import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { PromptInputV2PersistedState } from "./types"
import { createPromptInputV2Store } from "./store"
import { promptInputV2FolderPart } from "./interaction"

function draft(content: string, cursor: number) {
  return createPromptInputV2Store(
    createStore<PromptInputV2PersistedState>({
      prompt: [{ type: "text", content, start: 0, end: content.length }],
      cursor,
      context: { items: [] },
    }),
  )
}

describe("U-12 folder mention", () => {
  test("the folder part is a directory reference named after the last path segment", () => {
    expect(promptInputV2FolderPart("/work/project/docs/")).toEqual({
      type: "file",
      path: "/work/project/docs/",
      content: "@docs",
      start: 0,
      end: 0,
      mime: "application/x-directory",
      filename: "docs",
    })
    expect(promptInputV2FolderPart("C:\\work\\src").filename).toBe("src")
  })

  test("goes in at the cursor and keeps an earlier @ in the text", () => {
    const store = draft("mail me@x.com then read", 14)
    store.insertMentionAtCursor(promptInputV2FolderPart("/work/project/docs"))
    expect(store.state.prompt.map((part) => ("content" in part ? part.content : ""))).toEqual([
      "mail me@x.com ",
      "@docs",
      " then read",
    ])
    expect(store.state.prompt[1]).toMatchObject({ type: "file", mime: "application/x-directory", start: 14, end: 19 })
    expect(store.state.cursor).toBe(20)
  })

  test("an empty draft gets the folder and a trailing space", () => {
    const store = draft("", 0)
    store.insertMentionAtCursor(promptInputV2FolderPart("/work/project"))
    expect(store.state.prompt).toEqual([
      expect.objectContaining({ type: "file", path: "/work/project", content: "@project" }),
      { type: "text", content: " ", start: 8, end: 9 },
    ])
  })
})
