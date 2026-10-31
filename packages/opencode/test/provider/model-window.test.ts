import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { ModelWindow } from "@/provider/model-window"

const file = () => path.join(Global.Path.state, "model-window.json")
const model = (limit = { context: 0, output: 0 }, id = "thinker") => ({ id, providerID: "internal", limit })
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  rmSync(file(), { force: true })
  ModelWindow.reset()
})
afterEach(() => ModelWindow.reset())

describe("fromModels", () => {
  test.each([
    ["vLLM", { max_model_len: 32768 }],
    ["LM Studio", { max_context_length: 32768 }],
    ["a gateway", { context_length: 32768 }],
    ["another gateway", { context_window: 32768 }],
    ["LiteLLM", { max_input_tokens: 32768 }],
    ["llama.cpp", { meta: { n_ctx: 32768 } }],
  ])("reads %s", (_, fields) => {
    expect(ModelWindow.fromModels({ data: [{ id: "thinker", ...fields }] }, "thinker")).toBe(32768)
  })

  test("looks only at the model asked about, and ignores what cannot be a window", () => {
    expect(ModelWindow.fromModels({ data: [{ id: "other", max_model_len: 32768 }] }, "thinker")).toBeUndefined()
    expect(ModelWindow.fromModels({ data: [{ id: "thinker", max_model_len: 10 }] }, "thinker")).toBeUndefined()
    expect(ModelWindow.fromModels({ data: [{ id: "thinker" }] }, "thinker")).toBeUndefined()
    expect(ModelWindow.fromModels("nonsense", "thinker")).toBeUndefined()
  })
})

describe("an internal server's real answer", () => {
  // Measured from the server this is built for, with its sibling models. It states both limits and no other field.
  const body = {
    object: "list",
    data: [
      { id: "worker", max_input_tokens: 131072, max_output_tokens: 16384 },
      { id: "worker-fast", max_input_tokens: 65536, max_output_tokens: 8192 },
      { id: "thinker", max_input_tokens: 786432, max_output_tokens: 120000 },
      { id: "auto-efficient", max_input_tokens: 262144, max_output_tokens: 32768 },
    ],
  }

  test("reads the model asked about, not a sibling", () => {
    expect(ModelWindow.fromModels(body, "thinker")).toBe(786432)
    expect(ModelWindow.outputFromModels(body, "thinker")).toBe(120000)
    expect(ModelWindow.fromModels(body, "worker-fast")).toBe(65536)
    expect(ModelWindow.outputFromModels(body, "missing")).toBeUndefined()
    expect(ModelWindow.outputFromModels({ data: [{ id: "thinker", max_model_len: 32768 }] }, "thinker")).toBeUndefined()
  })

  test("discovery gives the configured model both limits, under the name the server knows it by", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(body) })
    try {
      const thinker = {
        ...model(undefined, "own-name"),
        api: { npm: "@ai-sdk/openai-compatible", id: "thinker" },
      }
      ModelWindow.discover({
        id: "internal",
        options: { baseURL: `http://127.0.0.1:${server.port}/v1` },
        models: { "own-name": thinker },
      })
      const end = Date.now() + 2000
      while (Date.now() < end && !ModelWindow.apply(thinker).limit.context) await Bun.sleep(5)
      expect(thinker.limit).toEqual({ context: 786432, output: 120000 })
    } finally {
      server.stop(true)
    }
  })
})

describe("fromError", () => {
  test.each([
    ["This model's maximum context length is 32768 tokens. However, you requested 40000 tokens", 32768],
    ["This model's maximum context length is 128,000 tokens.", 128000],
    ["prompt has 90000 tokens, but the configured context size is 65536 tokens", 65536],
    ["too large for model with 8192 maximum context length", 8192],
    ['{"type":"exceed_context_size_error","n_prompt_tokens":40000,"n_ctx":32768}', 32768],
  ])("%s", (message, expected) => {
    expect(ModelWindow.fromError(message)).toBe(expected)
  })

  test("says nothing when the refusal does not state it", () => {
    expect(ModelWindow.fromError("prompt is too long for this deployment")).toBeUndefined()
    expect(ModelWindow.fromError("you requested 40000 tokens")).toBeUndefined()
  })
})

describe("learned windows", () => {
  test("a refusal gives an undeclared model its window, with room left to answer", () => {
    const thinker = model()
    ModelWindow.learnFromRefusal(thinker, "maximum context length is 32768 tokens")
    expect(thinker.limit).toEqual({ context: 32768, output: 8192 })
  })

  test("with no number stated, the largest prompt the server accepted is the safe assumption", () => {
    const thinker = model()
    ModelWindow.learnFromRefusal(thinker, "prompt is too long", 22461)
    expect(thinker.limit.context).toBe(22461)
  })

  test("a later, smaller refusal replaces what was learned", () => {
    const thinker = model()
    ModelWindow.learnFromRefusal(thinker, "maximum context length is 32768 tokens")
    ModelWindow.learnFromRefusal(thinker, "maximum context length is 16384 tokens")
    expect(thinker.limit.context).toBe(16384)
  })

  test("limits someone declared are never touched", () => {
    const declared = model({ context: 100_000, output: 8000 })
    ModelWindow.learnFromRefusal(declared, "maximum context length is 32768 tokens")
    expect(declared.limit).toEqual({ context: 100_000, output: 8000 })
    expect(ModelWindow.apply(model()).limit.context).toBe(0)
  })

  test("what was learned survives a restart", async () => {
    ModelWindow.learnFromRefusal(model(), "maximum context length is 32768 tokens")
    await settle()
    ModelWindow.reset()
    expect(ModelWindow.apply(model()).limit).toEqual({ context: 32768, output: 8192 })
  })
})

describe("discover", () => {
  const server = (body: unknown, status = 200) => {
    const seen: string[] = []
    const instance = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push(`${new URL(request.url).pathname} ${request.headers.get("authorization")}`)
        return Response.json(body, { status })
      },
    })
    return { instance, seen, baseURL: `http://127.0.0.1:${instance.port}/v1` }
  }
  const provider = (baseURL: string, models = { thinker: model() }) => ({
    id: "internal",
    options: { baseURL, apiKey: "secret" },
    models: Object.fromEntries(
      Object.entries(models).map(([id, item]) => [
        id,
        { ...item, api: { npm: "@ai-sdk/openai-compatible", url: baseURL } },
      ]),
    ),
  })

  test("asks the server once, and applies the answer on the next read", async () => {
    const { instance, seen, baseURL } = server({ data: [{ id: "thinker", max_model_len: 65536 }] })
    const item = provider(baseURL)
    ModelWindow.discover(item)
    ModelWindow.discover(item)
    await Bun.sleep(100)
    ModelWindow.discover(item)
    instance.stop(true)
    expect(seen).toEqual(["/v1/models Bearer secret"])
    expect(ModelWindow.apply(item.models.thinker).limit.context).toBe(65536)
  })

  test("a server that is down costs nothing and leaves the model as it was", async () => {
    const { instance, baseURL } = server({})
    instance.stop(true)
    const item = provider(baseURL)
    const started = Date.now()
    ModelWindow.discover(item)
    expect(Date.now() - started).toBeLessThan(50)
    await Bun.sleep(50)
    expect(ModelWindow.apply(item.models.thinker).limit.context).toBe(0)
  })

  test("a model with declared limits is not asked about", async () => {
    const { instance, seen, baseURL } = server({ data: [] })
    ModelWindow.discover(provider(baseURL, { thinker: model({ context: 1000, output: 100 }) }))
    await Bun.sleep(50)
    instance.stop(true)
    expect(seen).toEqual([])
  })
})
