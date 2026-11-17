import { describe, expect, test } from "bun:test"
import { OFFICE_BODY_LIMIT_BYTES } from "../constants"
import {
  bodyBytes,
  canSend,
  checkBodySize,
  composePrompt,
  normaliseContext,
  sendBlocker,
  sessionTitle,
  writeText,
} from "./prompt"

describe("prompt composer", () => {
  test("U-PR-01 two parts with the context prefix line for every host and kind", () => {
    const cases = [
      ["Word", "selection"],
      ["Word", "whole"],
      ["Excel", "selection"],
      ["Excel", "whole"],
    ] as const
    cases.forEach((item) => {
      const result = composePrompt({ host: item[0], scope: item[1], context: "ctx line", instruction: "Summarise" })
      expect(result.body.parts).toEqual([
        { type: "text", text: `[Office context: ${item[0]} ${item[1]}]\nctx line` },
        { type: "text", text: "Summarise" },
      ])
      expect(result.tag).toBe(item[1])
    })
  })

  test("U-PR-02 empty context gives exactly one part and the none tag", () => {
    const result = composePrompt({ host: "Word", scope: "selection", context: "", instruction: "Hi" })
    expect(result.body.parts).toEqual([{ type: "text", text: "Hi" }])
    expect(result.tag).toBe("none")
    // A Word context that is only footnote marks normalises to "" as well.
    expect(composePrompt({ host: "Word", scope: "whole", context: "\u0002", instruction: "Hi" }).tag).toBe("none")
  })

  test("U-PR-03 body key set is {parts}; each part is {type, text} only", () => {
    const forbidden = ["tools", "system", "agent", "model", "variant", "noReply", "format", "messageID"]
    const results = [
      composePrompt({ host: "Excel", scope: "whole", context: "A1", instruction: "x" }),
      composePrompt({ host: "Word", scope: "selection", context: "", instruction: "x" }),
    ]
    results.forEach((result) => {
      const body = JSON.parse(JSON.stringify(result.body))
      expect(Object.keys(body)).toEqual(["parts"])
      forbidden.forEach((key) => expect(key in body).toBe(false))
      expect(body.parts.length >= 1 && body.parts.length <= 2).toBe(true)
      body.parts.forEach((part: Record<string, unknown>) => {
        expect(Object.keys(part).toSorted()).toEqual(["text", "type"])
        expect(part.type).toBe("text")
      })
    })
  })

  test("U-PR-04 UTF-8 byte length: exactly 2 MiB is sent, 2 MiB + 1 is refused", () => {
    const fill = (bytes: number) => {
      const overhead = bodyBytes({ parts: [{ type: "text", text: "" }] })
      // Indonesian text and CJK (3 bytes each), padded with ASCII to the exact size.
      const multibyte = "Ringkas dokumen ini 中文字".repeat(1000)
      const used = new TextEncoder().encode(multibyte).byteLength
      return multibyte + "a".repeat(bytes - overhead - used)
    }
    const exact = composePrompt({ host: "Word", scope: "selection", context: "", instruction: fill(OFFICE_BODY_LIMIT_BYTES) })
    expect(bodyBytes(exact.body)).toBe(2 * 1024 * 1024)
    expect(exact.body.parts[0].text.length).toBeLessThan(bodyBytes(exact.body))
    expect(checkBodySize(exact.body)).toBe("ok")
    const over = composePrompt({ host: "Word", scope: "selection", context: "", instruction: fill(OFFICE_BODY_LIMIT_BYTES + 1) })
    expect(bodyBytes(over.body)).toBe(2 * 1024 * 1024 + 1)
    expect(checkBodySize(over.body)).toBe("office.error.tooLarge")
  })

  test("U-PR-05 Send disabled when blank; title is the first line cut to 200", () => {
    expect(canSend("")).toBe(false)
    expect(canSend("   \n\t ")).toBe(false)
    expect(canSend(" a ")).toBe(true)
    expect(sessionTitle("First line\nsecond line")).toBe("First line")
    expect(sessionTitle("Windows line\r\nnext")).toBe("Windows line")
    expect(sessionTitle("x".repeat(199))).toHaveLength(199)
    expect(sessionTitle("x".repeat(200))).toHaveLength(200)
    expect(sessionTitle("x".repeat(201))).toBe("x".repeat(200))
    // A cut never leaves half of a surrogate pair.
    expect(sessionTitle("x".repeat(199) + "😀tail")).toBe("x".repeat(199))
  })

  test("U-PR-06 (write half) the Word write strips trailing line breaks and keeps inner ones", () => {
    expect(writeText("one\ntwo\n\n")).toBe("one\ntwo")
    expect(writeText("one\r\ntwo\r\n")).toBe("one\ntwo")
    expect(writeText("plain")).toBe("plain")
  })

  test("M8-02b leading whitespace-only lines are removed; first line keeps its indentation", () => {
    expect(writeText("\n\nBRAVO LINE TWO.")).toBe("BRAVO LINE TWO.")
    expect(writeText("  \n\tX\n")).toBe("\tX")
    expect(writeText("\r\n \t\r\n\n  indented\n\nnext\n")).toBe("  indented\n\nnext")
    expect(writeText("   only spaces")).toBe("   only spaces")
    expect(writeText("\n\n")).toBe("")
  })

  test("U-PR-07 Word context normalisation (D15); Excel untouched", () => {
    expect(normaliseContext("Word", "Alpha line one.\r")).toBe("Alpha line one.\n")
    expect(normaliseContext("Word", "Charlie line three.\u0002")).toBe("Charlie line three.")
    expect(normaliseContext("Excel", "a\rb\u0002")).toBe("a\rb\u0002")
    const word = composePrompt({ host: "Word", scope: "selection", context: "Alpha line one.\r", instruction: "x" })
    expect(word.body.parts[0].text).toBe("[Office context: Word selection]\nAlpha line one.\n")
  })

  test("ST-30 (unit half) no send before the disclosure is acknowledged", () => {
    const body = composePrompt({ host: "Word", scope: "selection", context: "", instruction: "x" }).body
    expect(sendBlocker({ instruction: "x", acknowledged: false, body })).toBe("disclosure")
    expect(sendBlocker({ instruction: " ", acknowledged: true, body })).toBe("blank")
    expect(sendBlocker({ instruction: "x", acknowledged: true, body })).toBeUndefined()
  })
})
