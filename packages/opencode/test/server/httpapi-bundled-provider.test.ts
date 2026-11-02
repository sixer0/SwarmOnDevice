import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)
const it = testEffect(Layer.mergeAll(testStateLayer, httpApiLayer))

const SHIPPED = "shipped-ai"
const FAKE_KEY = "fake-key-for-tests"
const projectOptions = { config: { formatter: false, lsp: false } }
const ProviderList = Schema.Struct({
  all: Schema.Array(Schema.Struct({ id: Schema.String, models: Schema.Record(Schema.String, Schema.Unknown) })),
  connected: Schema.Array(Schema.String),
  default: Schema.Record(Schema.String, Schema.String),
})

const providers = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory("/provider", directory)
    expect(response.status).toBe(200)
    return yield* Schema.decodeUnknownEffect(ProviderList)(yield* response.json)
  })

beforeEach(() => {
  process.env[ModelsDev.BUNDLED_ENV] = JSON.stringify({
    provider: {
      id: SHIPPED,
      name: "Shipped AI",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      api: "http://127.0.0.1:1/v1",
      models: Object.fromEntries(
        ["thinker", "worker", "worker-fast"].map((id) => [
          id,
          {
            id,
            name: id,
            release_date: "",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            limit: { context: 0, output: 0 },
          },
        ]),
      ),
    },
  })
})
afterEach(() => {
  delete process.env[ModelsDev.BUNDLED_ENV]
})

describe("bundled provider over the server", () => {
  it.instance(
    "offered without a key, and the existing connect route takes it to connected on thinker",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const before = yield* providers(directory)
        expect(before.all.map((item) => item.id)).toContain(SHIPPED)
        expect(before.connected).not.toContain(SHIPPED)

        const put = yield* requestInDirectory(`/auth/${SHIPPED}`, directory, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "api", key: FAKE_KEY }),
        })
        expect(put.status).toBe(200)
        const dispose = yield* requestInDirectory("/global/dispose", directory, { method: "POST" })
        expect(dispose.status).toBe(200)

        const after = yield* providers(directory)
        expect(after.connected).toContain(SHIPPED)
        expect(after.default[SHIPPED]).toBe("thinker")
        expect(JSON.stringify(after)).not.toContain(FAKE_KEY)

        yield* requestInDirectory(`/auth/${SHIPPED}`, directory, { method: "DELETE" })
      }),
    projectOptions,
  )
})
