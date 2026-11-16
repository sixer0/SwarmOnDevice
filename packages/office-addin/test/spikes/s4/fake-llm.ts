// Spike S4 scripted LLM (no network, no real model). An OpenAI-compatible
// /v1/chat/completions endpoint that streams a fixed reply in small chunks with a delay,
// so the pane shows incremental text and Abort has time to act. Same wire shape as
// packages/opencode/test/lib/llm-server.ts (chat.completion.chunk SSE, then [DONE]).
// Requests are counted, never logged (they carry the sidecar's system prompt).
const port = Number(process.env.SWARM_S4_LLM_PORT ?? "55318")
const reply = (process.env.SWARM_S4_LLM_REPLY ?? "PONG").split("")
const delayMs = Number(process.env.SWARM_S4_LLM_DELAY_MS ?? "150")
const counter = { hits: 0 }

const chunk = (delta: Record<string, unknown>, finish?: string) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-s4",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "s4-scripted",
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
    ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: reply.length, total_tokens: 1 + reply.length } } : {}),
  })}\n\n`

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch(req) {
    const pathname = new URL(req.url).pathname
    if (req.method !== "POST" || pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
    counter.hits++
    console.log(`[s4-llm] POST ${pathname} #${counter.hits}`)
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(chunk({ role: "assistant" })))
          for (const piece of reply) {
            await Bun.sleep(delayMs)
            if (req.signal.aborted) return controller.close()
            controller.enqueue(encoder.encode(chunk({ content: piece })))
          }
          controller.enqueue(encoder.encode(chunk({}, "stop")))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
    )
  },
})

console.log(`[s4-llm] scripted LLM on http://127.0.0.1:${server.port}/v1`)
