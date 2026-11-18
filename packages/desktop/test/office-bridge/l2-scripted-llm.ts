// Row M5-04 L2 harness: scripted OpenAI-compatible LLM on 127.0.0.1:55318 (test strategy §7.1 "LLM").
//
// OQ-T3 resolved as the fallback: `packages/opencode/test/lib/llm-server.ts` is built on `@effect/platform-node` and
// Effect HttpRouter layers and lives in opencode's own test tree; importing it from `packages/desktop` would make the
// desktop tests depend on opencode test internals (AGENTS.md dependency direction). This is the ~100-line `Bun.serve`
// script the strategy names instead, in the same wire shape (chat.completion.chunk SSE, then [DONE]).
//
// No network, no real model. Every request body is recorded in memory (it carries the sidecar's system prompt), never
// logged. The reply is set per test through `reply`.

export const L2_LLM_PORT = 55318

export type ScriptedReply = {
  /** Text chunks streamed one by one. */
  chunks: string[]
  /** Delay before each chunk, in ms. */
  delayMs: number
  /** M5-05 (I-BR-11): tool calls streamed after the text, then `finish_reason: "tool_calls"`. */
  toolCalls?: ScriptedToolCall[]
  /** Queued replies only: used for the first request whose JSON body contains this text (skips title calls). */
  match?: string
}

export type ScriptedToolCall = { name: string; arguments: Record<string, unknown> }

export type RecordedLlmRequest = {
  at: number
  body: Record<string, unknown>
}

export type ScriptedLlm = {
  readonly url: string
  readonly requests: RecordedLlmRequest[]
  /** Time the last chunk of any reply was enqueued (ms, `performance.now()`), for no-buffering checks. */
  readonly lastChunkAt: () => number
  reply: ScriptedReply
  /** M5-05: replies used once each, in order, before `reply` (a tool call turn, then a text turn). */
  readonly queue: ScriptedReply[]
  stop(): Promise<void>
}

const DEFAULT_REPLY: ScriptedReply = { chunks: ["Hello", " from", " the", " scripted", " LLM"], delayMs: 50 }

function chunk(delta: Record<string, unknown>, finish?: string) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-l2",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "l2-scripted",
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
    ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
  })}\n\n`
}

export function startScriptedLlm(port = L2_LLM_PORT): ScriptedLlm {
  const requests: RecordedLlmRequest[] = []
  const state = { lastChunkAt: 0 }
  const encoder = new TextEncoder()
  const llm: { reply: ScriptedReply } = { reply: DEFAULT_REPLY }
  const queue: ScriptedReply[] = []

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (request.method !== "POST" || pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      requests.push({ at: performance.now(), body })
      const raw = JSON.stringify(body)
      const index = queue.findIndex((item) => item.match === undefined || raw.includes(item.match))
      const reply = index === -1 ? llm.reply : (queue.splice(index, 1)[0] ?? llm.reply)
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(chunk({ role: "assistant" })))
            for (const piece of reply.chunks) {
              await Bun.sleep(reply.delayMs)
              if (request.signal.aborted) return controller.close()
              controller.enqueue(encoder.encode(chunk({ content: piece })))
              state.lastChunkAt = performance.now()
            }
            const calls = reply.toolCalls ?? []
            calls.forEach((call, index) =>
              controller.enqueue(
                encoder.encode(
                  chunk({
                    tool_calls: [
                      {
                        index,
                        id: `call_l2_${requests.length}_${index}`,
                        type: "function",
                        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                      },
                    ],
                  }),
                ),
              ),
            )
            controller.enqueue(encoder.encode(chunk({}, calls.length > 0 ? "tool_calls" : "stop")))
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      )
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    queue,
    lastChunkAt: () => state.lastChunkAt,
    get reply() {
      return llm.reply
    },
    set reply(value: ScriptedReply) {
      llm.reply = value
    },
    async stop() {
      await server.stop(true)
    },
  }
}

/** The system text of a recorded chat request (all `system` messages joined), for SD-1 checks. */
export function systemText(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages
    .filter((message: unknown) => typeof message === "object" && message !== null && "role" in message && message.role === "system")
    .map((message: { content?: unknown }) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")
}

/** True when any non-system message of a recorded request contains `text`. */
export function mentions(body: Record<string, unknown>, text: string) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.some(
    (message: unknown) =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role !== "system" &&
      JSON.stringify(message).includes(text),
  )
}
