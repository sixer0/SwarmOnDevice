import { describe, expect, test } from "bun:test"
import { LocalEngines } from "@/provider/local-engines"

const GB = 1024 ** 3
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

// An engine answering documented endpoints; every other port on the machine is closed.
function machine(routes: Record<string, (body: Record<string, string>) => Response>): typeof globalThis.fetch {
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const route = routes[String(input)]
    if (!route) throw new Error("connection refused")
    return route(init?.body ? JSON.parse(String(init.body)) : {})
  }
  return Object.assign(fetch, { preconnect: globalThis.fetch.preconnect })
}

const ollama = (models: { name: string; size: number; capabilities?: string[]; context?: number }[]) => ({
  "http://127.0.0.1:11434/api/tags": () => json({ models: models.map((m) => ({ name: m.name, size: m.size, details: { family: "x" } })) }),
  "http://127.0.0.1:11434/api/show": (body: Record<string, string>) => {
    const model = models.find((m) => m.name === body.model)!
    return json({ capabilities: model.capabilities, model_info: { "x.context_length": model.context } })
  },
})

const env = {}
const totalMemory = 32 * GB

describe("detect", () => {
  test("finds nothing on a machine with no engines", async () => {
    expect(await LocalEngines.detect({ env, fetch: machine({}), totalMemory })).toEqual([])
  })

  test("reads Ollama's models and what they can do, leaving out embedding models", async () => {
    const [engine] = await LocalEngines.detect({
      env,
      totalMemory,
      fetch: machine(
        ollama([
          { name: "qwen3:14b", size: 9 * GB, capabilities: ["completion", "tools", "thinking"], context: 40960 },
          { name: "gemma3:4b", size: 3 * GB, capabilities: ["completion", "vision"], context: 8192 },
          { name: "nomic-embed-text", size: GB, capabilities: ["embedding"], context: 2048 },
        ]),
      ),
    })
    expect(engine.id).toBe("ollama")
    expect(engine.baseURL).toBe("http://127.0.0.1:11434/v1")
    expect(engine.models.map((m) => m.id)).toEqual(["qwen3:14b", "gemma3:4b"])
    expect(engine.models[0]).toMatchObject({ tools: true, reasoning: true, context: 40960 })
    expect(engine.models[1]).toMatchObject({ tools: false, vision: true, context: 8192 })
  })

  test("an engine with nothing installed is not offered", async () => {
    expect(await LocalEngines.detect({ env, totalMemory, fetch: machine(ollama([])) })).toEqual([])
  })

  test("reads LM Studio's model list and skips embeddings", async () => {
    const [engine] = await LocalEngines.detect({
      env,
      totalMemory,
      fetch: machine({
        "http://127.0.0.1:1234/api/v0/models": () =>
          json({
            data: [
              { id: "a", type: "llm", state: "not-loaded", max_context_length: 4096, capabilities: [] },
              { id: "b", type: "llm", state: "loaded", max_context_length: 8192, capabilities: ["tool_use"] },
              { id: "c", type: "embeddings", state: "not-loaded" },
            ],
          }),
      }),
    })
    expect(engine.name).toBe("LM Studio")
    expect(engine.models.map((m) => [m.id, m.tools, m.loaded])).toEqual([
      ["b", true, true],
      ["a", false, false],
    ])
  })

  test("falls back to the OpenAI model list on older LM Studio", async () => {
    const [engine] = await LocalEngines.detect({
      env,
      totalMemory,
      fetch: machine({
        "http://127.0.0.1:1234/api/v0/models": () => new Response("", { status: 404 }),
        "http://127.0.0.1:1234/v1/models": () => json({ data: [{ id: "m" }, { id: "text-embedding-x" }] }),
      }),
    })
    expect(engine.models.map((m) => m.id)).toEqual(["m"])
  })

  test("does not mistake an unrelated server on 8080 for llama.cpp", async () => {
    const other = machine({ "http://127.0.0.1:8080/v1/models": () => json({ data: [{ id: "widgets", owned_by: "acme" }] }) })
    expect(await LocalEngines.detect({ env, totalMemory, fetch: other })).toEqual([])
    const llama = machine({ "http://127.0.0.1:8080/v1/models": () => json({ data: [{ id: "m.gguf", owned_by: "llamacpp" }] }) })
    expect((await LocalEngines.detect({ env, totalMemory, fetch: llama }))[0].name).toBe("llama.cpp")
  })

  test("survives a server that answers garbage", async () => {
    const fetch = machine({ "http://127.0.0.1:11434/api/tags": () => new Response("<html>not json</html>") })
    expect(await LocalEngines.detect({ env, totalMemory, fetch })).toEqual([])
  })

  test("a remote OLLAMA_HOST is not on this device and is never probed", async () => {
    const asked: string[] = []
    const fetch = Object.assign(
      async (input: string | URL | Request) => {
        asked.push(String(input))
        throw new Error("refused")
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    await LocalEngines.detect({ env: { OLLAMA_HOST: "gpu-box.example.com:11434" }, totalMemory, fetch })
    expect(asked.some((url) => url.includes("example.com"))).toBe(false)
  })
})

test("loopbackOrigin understands how Ollama is usually configured", () => {
  expect(LocalEngines.loopbackOrigin(undefined, 11434)).toBe("http://127.0.0.1:11434")
  expect(LocalEngines.loopbackOrigin("0.0.0.0", 11434)).toBe("http://127.0.0.1:11434")
  expect(LocalEngines.loopbackOrigin("127.0.0.1:47101", 11434)).toBe("http://127.0.0.1:47101")
  expect(LocalEngines.loopbackOrigin("http://localhost:9000", 11434)).toBe("http://127.0.0.1:9000")
  expect(LocalEngines.loopbackOrigin("10.0.0.5:11434", 11434)).toBeUndefined()
})

describe("rank", () => {
  const model = (id: string, tools: boolean, size?: number, loaded = false) => ({
    id,
    tools,
    size,
    loaded,
    vision: false,
    reasoning: false,
  })

  test("starts with the largest model that can use tools and fits in memory", () => {
    const ranked = LocalEngines.rank(
      [
        model("chat-only", false, 4 * GB),
        model("too-big", true, 240 * GB),
        model("small", true, 2 * GB),
        model("best", true, 9 * GB),
      ],
      totalMemory,
    )
    expect(ranked.map((m) => m.id)).toEqual(["best", "small", "too-big", "chat-only"])
  })

  test("prefers a model that is already loaded", () => {
    expect(LocalEngines.rank([model("a", true), model("b", true, undefined, true)], totalMemory)[0].id).toBe("b")
  })
})
