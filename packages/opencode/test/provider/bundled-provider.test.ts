import { afterEach, beforeEach, expect } from "bun:test"
import { mkdir, rm, writeFile } from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { isPaid } from "@/session/spend"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const SHIPPED = "shipped-ai"
const id = ProviderV2.ID.make(SHIPPED)
const FAKE_KEY = "fake-key-for-tests"

const model = (name: string) => ({
  id: name,
  name,
  release_date: "",
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  limit: { context: 0, output: 0 },
  modalities: { input: ["text"], output: ["text"] },
})

const payload = (baseURL = "http://127.0.0.1:1/v1") =>
  JSON.stringify({
    provider: {
      id: SHIPPED,
      name: "Shipped AI",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      api: baseURL,
      models: { thinker: model("thinker"), worker: model("worker"), "worker-fast": model("worker-fast") },
    },
  })

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Auth.node, ModelsDev.node])))

const recentFile = () => path.join(Global.Path.state, "model.json")
const removeKey = Effect.gen(function* () {
  const auth = yield* Auth.Service
  yield* auth.remove(SHIPPED).pipe(Effect.ignore)
})
const connect = Effect.gen(function* () {
  const auth = yield* Auth.Service
  yield* auth.set(SHIPPED, new Auth.Api({ type: "api", key: FAKE_KEY }))
})

beforeEach(() => {
  process.env[ModelsDev.BUNDLED_ENV] = payload()
})

afterEach(async () => {
  delete process.env[ModelsDev.BUNDLED_ENV]
  await rm(recentFile(), { force: true })
  await disposeAllInstances()
})

it.instance("without a key the provider is listed for connecting, not connected, and nothing is chosen", () =>
  Effect.gen(function* () {
    yield* removeKey
    const catalog = yield* ModelsDev.Service.use((svc) => svc.get())
    expect(Object.keys(catalog[SHIPPED].models).toSorted()).toEqual(["thinker", "worker", "worker-fast"])
    expect((yield* Provider.use.list())[id]).toBeUndefined()
    const chosen = yield* Provider.use.defaultModel().pipe(Effect.option)
    expect(chosen._tag === "Some" ? String(chosen.value.providerID) : undefined).not.toBe(SHIPPED)
  }),
)

it.instance("a key already stored connects it, with thinker as the default model", () =>
  Effect.gen(function* () {
    yield* connect
    const providers = yield* Provider.use.list()
    const provider = providers[id]
    expect(provider.source).toBe("config")
    expect(provider.key).toBe(FAKE_KEY)
    expect(Object.keys(provider.models).toSorted()).toEqual(["thinker", "worker", "worker-fast"])
    expect(Provider.defaultModelIDs(providers)[id]).toBe("thinker")
    expect(yield* Provider.use.defaultModel()).toEqual({ providerID: id, modelID: ModelV2.ID.make("thinker") })
    yield* removeKey
  }),
)

it.instance("the sort itself puts thinker first, and no small model is picked for session titles", () =>
  Effect.gen(function* () {
    yield* connect
    const providers = yield* Provider.use.list()
    expect(Provider.sort(Object.values(providers[id].models)).map((item) => String(item.id))).toEqual([
      "thinker",
      "worker-fast",
      "worker",
    ])
    // Titles fall back to the session's model (session/prompt.ts) when this is undefined.
    expect(yield* Provider.use.getSmallModel(id)).toBeUndefined()
    yield* removeKey
  }),
)

it.instance("the stored key is what a request carries, to the shipped address", () =>
  Effect.gen(function* () {
    const seen: { authorization: string | null; pathname: string }[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(request) {
            seen.push({ authorization: request.headers.get("authorization"), pathname: new URL(request.url).pathname })
            return Response.json({
              id: "x",
              created: 1,
              model: "thinker",
              choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          },
        }),
      ),
      (item) => Effect.sync(() => item.stop(true)),
    )
    process.env[ModelsDev.BUNDLED_ENV] = payload(`http://127.0.0.1:${server.port}/v1`)
    yield* connect
    const language = yield* Provider.use.getLanguage(yield* Provider.use.getModel(id, ModelV2.ID.make("thinker")))
    yield* Effect.promise(() =>
      language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }] }),
    )
    expect(seen).toEqual([{ authorization: `Bearer ${FAKE_KEY}`, pathname: "/v1/chat/completions" }])
    yield* removeKey
  }),
)

it.instance("the models cost nothing, so the spend limit never holds them", () =>
  Effect.gen(function* () {
    yield* connect
    const models = Object.values((yield* Provider.use.list())[id].models)
    expect(models.map(isPaid)).toEqual([false, false, false])
    yield* removeKey
  }),
)

it.instance(
  "a model set in config beats the default, and a user's own provider is still the one chosen",
  () =>
    Effect.gen(function* () {
      yield* connect
      expect(String((yield* Provider.use.defaultModel()).providerID)).toBe("own-server")
      yield* removeKey
    }),
  {
    config: {
      model: "own-server/own",
      provider: {
        "own-server": {
          name: "Own server",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "own", baseURL: "http://127.0.0.1:2/v1" },
          models: { own: {} },
        },
      },
    },
  },
)

it.instance(
  "a provider in config with no model set stays the default, and the shipped one only adds models",
  () =>
    Effect.gen(function* () {
      yield* connect
      const providers = yield* Provider.use.list()
      expect(String((yield* Provider.use.defaultModel()).providerID)).toBe("own-server")
      // Picker and composer rank `source: "config"` first, so this is what keeps them on the user's provider too.
      expect(providers[id].source).toBe("api")
      expect(Object.keys(providers[id].models)).toContain("thinker")
      yield* removeKey
    }),
  {
    config: {
      provider: {
        "own-server": {
          name: "Own server",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "own", baseURL: "http://127.0.0.1:2/v1" },
          models: { own: {} },
        },
      },
    },
  },
)

it.instance(
  "a user's own block for the same provider wins over the shipped address and gains the new models",
  () =>
    Effect.gen(function* () {
      yield* removeKey
      const provider = (yield* Provider.use.list())[id]
      expect(provider.options.baseURL).toBe("http://127.0.0.1:3/v1")
      expect(provider.name).toBe("Mine")
      expect(Object.keys(provider.models).toSorted()).toEqual(["thinker", "worker", "worker-fast"])
      expect(String((yield* Provider.use.defaultModel()).modelID)).toBe("thinker")
    }),
  {
    config: {
      provider: {
        [SHIPPED]: {
          name: "Mine",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:3/v1" },
          models: { thinker: { name: "thinker" } },
        },
      },
    },
  },
)

it.instance("a model the user already chose beats the default", () =>
  Effect.gen(function* () {
    yield* connect
    yield* Effect.promise(async () => {
      await mkdir(Global.Path.state, { recursive: true })
      await writeFile(recentFile(), JSON.stringify({ recent: [{ providerID: SHIPPED, modelID: "worker" }] }))
    })
    expect(String((yield* Provider.use.defaultModel()).modelID)).toBe("worker")
    yield* removeKey
  }),
)

it.instance(
  "a provider the user disabled stays off even with a key",
  () =>
    Effect.gen(function* () {
      yield* connect
      expect((yield* Provider.use.list())[id]).toBeUndefined()
      yield* removeKey
    }),
  { config: { disabled_providers: [SHIPPED] } },
)

it.instance("outside the desktop app there is no such provider, whatever auth.json holds", () =>
  Effect.gen(function* () {
    delete process.env[ModelsDev.BUNDLED_ENV]
    yield* connect
    expect((yield* ModelsDev.Service.use((svc) => svc.get()))[SHIPPED]).toBeUndefined()
    expect((yield* Provider.use.list())[id]).toBeUndefined()
    yield* removeKey
  }),
)

it.instance("a broken payload leaves the catalog as it was", () =>
  Effect.gen(function* () {
    process.env[ModelsDev.BUNDLED_ENV] = "{not json"
    expect((yield* ModelsDev.Service.use((svc) => svc.get()))[SHIPPED]).toBeUndefined()
    expect(ModelsDev.bundled()).toBeUndefined()
  }),
)
