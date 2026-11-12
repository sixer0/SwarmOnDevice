// SEC-08 (1.2.6 row 34a): before a request to the bundled provider, the route to its host is checked for a Tailscale
// interface (cached 60 s). Unverified: the request still goes out and exactly one PROVIDER_ROUTE_UNVERIFIED warning
// appears per 60 s. The route probe is stubbed; no real route command runs and no real provider is contacted.
import { afterEach, beforeEach, expect } from "bun:test"
import { createServer, type Server } from "node:http"
import { rm } from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Auth } from "@/auth"
import { GlobalBus } from "@/bus/global"
import { Provider } from "@/provider/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const SHIPPED = "shipped-ai"
const CODE = "PROVIDER_ROUTE_UNVERIFIED"

// Loaded dynamically so that at the 1.2.5 base (no module yet) the behaviour assertions fail instead of the import.
const loadRoute = () =>
  import("@/provider/route-check").then((m) => m.ProviderRoute).catch(() => undefined)

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

const payload = (baseURL: string) =>
  JSON.stringify({
    provider: {
      id: SHIPPED,
      name: "Shipped AI",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      api: baseURL,
      models: { worker: model("worker") },
    },
  })

function completionServer() {
  return new Promise<{ server: Server; url: string; hits: () => number }>((resolve) => {
    let hits = 0
    const server = createServer((req, res) => {
      // Only chat requests count; the model-window probe may also ask for the model list.
      if (req.url?.endsWith("/chat/completions")) hits++
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 0,
          model: "worker",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") throw new Error("no port")
      resolve({ server, url: `http://127.0.0.1:${addr.port}/v1`, hits: () => hits })
    })
  })
}

// Warnings as the existing notice surface receives them: the toast event on the global bus.
const watchWarnings = () => {
  const seen: string[] = []
  const listener = (event: { payload?: { type?: string; properties?: { message?: string } } }) => {
    const text = event.payload?.properties?.message ?? ""
    if (event.payload?.type === "tui.toast.show" && text.includes(CODE)) seen.push(text)
  }
  GlobalBus.on("event", listener)
  return { seen, stop: () => GlobalBus.off("event", listener) }
}

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Auth.node, ModelsDev.node])))

let server: Awaited<ReturnType<typeof completionServer>>

beforeEach(async () => {
  server = await completionServer()
  process.env[ModelsDev.BUNDLED_ENV] = payload(server.url)
})

afterEach(async () => {
  server.server.close()
  delete process.env[ModelsDev.BUNDLED_ENV]
  ;(await loadRoute())?.reset()
  await rm(path.join(Global.Path.state, "model.json"), { force: true })
  await disposeAllInstances()
})

const sendThree = (clock?: { t: number }) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* auth.set(SHIPPED, new Auth.Api({ type: "api", key: "fake-key-for-tests" }))
    const provider = yield* Provider.Service
    const info = yield* provider.getModel(ProviderV2.ID.make(SHIPPED), ModelV2.ID.make("worker"))
    const language = yield* provider.getLanguage(info)
    const route = yield* Effect.promise(loadRoute)
    for (let i = 0; i < 3; i++) {
      yield* Effect.promise(() =>
        language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
      )
      yield* Effect.promise(async () => {
        await route?.settled()
        await new Promise((r) => setTimeout(r, 20))
      })
      if (clock) clock.t += 10_000
    }
  })

it.instance("SEC-08 stubbed en0 route: every request is sent and exactly one warning appears within 60 s", () =>
  Effect.gen(function* () {
    const route = yield* Effect.promise(loadRoute)
    const probed: string[] = []
    const clock = { t: 1_000_000 }
    route?.setProbe(async (host) => (probed.push(host), "en0"))
    route?.setClock(() => clock.t)
    const warnings = watchWarnings()
    try {
      yield* sendThree(clock)
    } finally {
      warnings.stop()
    }
    expect(server.hits()).toBe(3)
    expect(warnings.seen.length).toBe(1)
    expect(warnings.seen[0]).toContain("Connect Tailscale")
    expect(probed).toEqual(["127.0.0.1"])
  }),
)

it.instance("SEC-08 stubbed Tailscale utun route: requests are sent and no warning appears", () =>
  Effect.gen(function* () {
    const route = yield* Effect.promise(loadRoute)
    const probed: string[] = []
    route?.setProbe(async (host) => (probed.push(host), "utun4"))
    const warnings = watchWarnings()
    try {
      yield* sendThree()
    } finally {
      warnings.stop()
    }
    expect(server.hits()).toBe(3)
    expect(warnings.seen.length).toBe(0)
    expect(probed).toEqual(["127.0.0.1"])
  }),
)

it.live("SEC-08 the check never holds a request back and warns again only after 60 s", () =>
  Effect.promise(async () => {
    const route = await loadRoute()
    expect(route).toBeDefined()
    if (!route) return
    let t = 0
    let release: (iface: string) => void = () => {}
    route.setProbe(() => new Promise<string>((r) => (release = r)))
    route.setClock(() => t)
    const warned: string[] = []
    route.setSink((w) => warned.push(w.code))
    let sent = 0
    const fetchFn = route.guard(async (_input: string) => (sent++, new Response("ok")))
    // The probe has not answered: the request still completes at once.
    await fetchFn("http://100.102.23.27:11400/v1/chat/completions")
    expect(sent).toBe(1)
    release("en0")
    await route.settled()
    expect(warned).toEqual([CODE])
    t += 59_000
    await fetchFn("http://100.102.23.27:11400/v1/chat/completions")
    expect(warned).toEqual([CODE])
    route.setProbe(async () => "en0")
    t += 2_000
    await fetchFn("http://100.102.23.27:11400/v1/chat/completions")
    await route.settled()
    expect(warned).toEqual([CODE, CODE])
    // HTTPS needs no check; a probe that fails counts as unverified but never throws into the request.
    route.reset()
    route.setSink((w) => warned.push(w.code))
    route.setProbe(async () => {
      throw new Error("route missing")
    })
    await route.guard(async (_input: string) => (sent++, new Response("ok")))("https://example.invalid/v1")
    await route.settled()
    expect(warned.length).toBe(2)
    expect(sent).toBe(4)
  }),
)
