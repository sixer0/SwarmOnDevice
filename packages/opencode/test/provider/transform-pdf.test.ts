// Row 203: a model without PDF input (GSP AI declares text and image) gets a PDF's text, not "Cannot read".
import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { simplePdf } from "../fixture/pdf"

const modalities = (input: { image: boolean; pdf: boolean }) => ({ text: true, audio: false, video: false, ...input })

const model = (input: { image: boolean; pdf: boolean }): Provider.Model => ({
  id: ModelV2.ID.make("gsp-worker"),
  providerID: ProviderV2.ID.make("gsp-ai"),
  api: { id: "gsp-worker", url: "https://example.com/v1", npm: "@ai-sdk/openai-compatible" },
  name: "GSP worker",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: modalities(input),
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 0, output: 8_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

const pdf = simplePdf([["Executive summary", "Budget: 1.2 bn"], ["Annex A"]])

const userWith = (data: unknown): ModelMessage[] => [
  {
    role: "user",
    content: [
      { type: "text", text: "Review this" },
      { type: "file", mediaType: "application/pdf", filename: "review.pdf", data } as never,
    ],
  },
]

const parts = (msgs: ModelMessage[]) => msgs[0].content as Array<{ type: string; text?: string }>

describe("ProviderTransform: PDF for a model without PDF input", () => {
  test("a data-URL PDF becomes its extracted text with page markers and a note (image-capable model)", () => {
    const out = ProviderTransform.message(
      userWith(`data:application/pdf;base64,${pdf.toString("base64")}`),
      model({ image: true, pdf: false }),
      {},
    )
    const part = parts(out)[1]
    expect(part.type).toBe("text")
    expect(part.text).not.toContain("Cannot read")
    expect(part.text).toContain(
      '[PDF "review.pdf": this model does not take PDF files, so Swarm extracted the text of its 2 page(s) below.',
    )
    expect(part.text).toContain("No page images were added")
    expect(part.text).toContain("--- Page 1 of 2 ---\nExecutive summary\nBudget: 1.2 bn")
    expect(part.text).toContain("--- Page 2 of 2 ---\nAnnex A")
  })

  test("raw bytes and bare base64 are read too; a text-only model gets no image sentence", () => {
    for (const data of [new Uint8Array(pdf), pdf.toString("base64")]) {
      const part = parts(ProviderTransform.message(userWith(data), model({ image: false, pdf: false }), {}))[1]
      expect(part.text).toContain("--- Page 1 of 2 ---\nExecutive summary")
      expect(part.text).not.toContain("page images")
    }
  })

  test("a model that declares PDF input keeps the native file part", () => {
    const data = `data:application/pdf;base64,${pdf.toString("base64")}`
    const part = parts(ProviderTransform.message(userWith(data), model({ image: true, pdf: true }), {}))[1]
    expect(part.type).toBe("file")
  })

  test("a remote PDF URL it cannot read inline still gets the plain refusal note", () => {
    const part = parts(
      ProviderTransform.message(userWith(new URL("https://example.com/a.pdf")), model({ image: true, pdf: false }), {}),
    )[1]
    expect(part.text).toContain('Cannot read "review.pdf"')
  })
})
