// Swarm 1.2.7 item U-13 (decisions U7, C63 D-13a-d): copying text from MS Word must paste the text,
// not Word's rendered image. Word's clipboard carries text/plain + text/html + image/png; happy-dom builds
// the same ClipboardEvent here. Both composers are covered: v1 (app) and v2 (session-ui).
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createPromptAttachmentsCore } from "@/components/prompt-input/attachments"
import { createPromptState, type ContentPart } from "@/context/prompt"
import { createPromptInputV2Attachments } from "../../session-ui/src/v2/components/prompt-input/attachments"
import type { PromptInputV2Prompt } from "../../session-ui/src/v2/components/prompt-input/types"

const WORD_TEXT = [
  "Section 1. Background of the study",
  "This paragraph was copied from a long Word document and must reach the agent as text.",
  "Section 2. Method",
].join("\r\n")

function png() {
  // A tiny RGB PNG header (colour type 2, no tRNS): no alpha, so the image path never needs a canvas.
  return new File(
    [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0)],
    "image.png",
    { type: "image/png" },
  )
}

function wordClipboard() {
  const data = new DataTransfer()
  data.setData("text/plain", WORD_TEXT)
  data.setData("text/html", "<html><body><p class=MsoNormal><b>Section 1.</b> Background</p></body></html>")
  data.items.add(png())
  return new ClipboardEvent("paste", { clipboardData: data, cancelable: true })
}

function imageOnlyClipboard() {
  const data = new DataTransfer()
  data.items.add(png())
  return new ClipboardEvent("paste", { clipboardData: data, cancelable: true })
}

function v1() {
  const prompt = createPromptState()
  const parts: ContentPart[] = []
  const attachments = createPromptAttachmentsCore({
    capture: prompt.capture,
    editor: () => document.createElement("div"),
    addPart: (part) => {
      parts.push(part)
      return true
    },
    readClipboardImage: async () => null,
  })
  return { attachments, parts, images: () => prompt.current().filter((part) => part.type === "image") }
}

function v2() {
  const [state, setState] = createStore({ prompt: [] as PromptInputV2Prompt })
  const parts: PromptInputV2Prompt[number][] = []
  const attachments = createPromptInputV2Attachments({
    capture: () => ({ current: () => state.prompt, cursor: () => 0, set: (prompt) => setState("prompt", prompt) }),
    editor: () => document.createElement("div"),
    focusEditor: () => undefined,
    addPart: (part) => {
      parts.push(part)
      return true
    },
    setDraggingType: () => undefined,
    directory: () => "/",
    isDialogActive: () => false,
    warn: () => undefined,
    duplicate: () => undefined,
    onError: () => undefined,
    readClipboardImage: async () => null,
  })
  return { attachments, parts, images: () => state.prompt.filter((part) => part.type === "image") }
}

const expected = WORD_TEXT.replace(/\r\n?/g, "\n")

describe("U-13 paste from Word: text wins over the clipboard image", () => {
  test("v1 composer inserts the plain text and attaches no image", async () => {
    await createRoot(async (dispose) => {
      const view = v1()
      await view.attachments.handlePaste(wordClipboard())
      expect(view.images()).toHaveLength(0)
      expect(view.parts.map((part) => (part.type === "text" ? part.content : part.type))).toEqual([expected])
      dispose()
    })
  })

  test("v2 composer inserts the plain text and attaches no image", async () => {
    await createRoot(async (dispose) => {
      const view = v2()
      await view.attachments.handlePaste(wordClipboard())
      expect(view.images()).toHaveLength(0)
      expect(view.parts.map((part) => (part.type === "text" ? part.content : part.type))).toEqual([expected])
      dispose()
    })
  })

  test("v1 composer still attaches an image when the clipboard holds no text", async () => {
    await createRoot(async (dispose) => {
      const view = v1()
      await view.attachments.handlePaste(imageOnlyClipboard())
      expect(view.images()).toHaveLength(1)
      expect(view.parts).toHaveLength(0)
      dispose()
    })
  })

  test("v2 composer still attaches an image when the clipboard holds no text", async () => {
    await createRoot(async (dispose) => {
      const view = v2()
      await view.attachments.handlePaste(imageOnlyClipboard())
      expect(view.images()).toHaveLength(1)
      expect(view.parts).toHaveLength(0)
      dispose()
    })
  })
})
