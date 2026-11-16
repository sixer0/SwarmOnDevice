// Spike S4: drive the proxy with the same client library as the pane (@opencode-ai/sdk/v2/client)
// from Bun. Run 1 lets the scripted reply finish; run 2 aborts after the first text delta.
// Prints event types, arrival offsets and booleans only (no message text beyond a length).
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

const base = process.env.SWARM_S4_PROXY_URL
if (!base) {
  console.error("SWARM_S4_PROXY_URL is required, for example http://127.0.0.1:47317")
  process.exit(2)
}
const client = createOpencodeClient({ baseUrl: `${base}/swarm`, headers: { "X-Swarm-Office": "1" } })

const run = async (label: string, abortOnFirstDelta: boolean) => {
  const controller = new AbortController()
  const sub = await client.event.subscribe(undefined, { signal: controller.signal, sseMaxRetryAttempts: 1 })
  const created = await client.session.create({ title: `S4 sdk ${label}` })
  if (!created.data) throw new Error(`session.create failed ${created.response?.status}`)
  const sessionID = created.data.id
  const t0 = performance.now()
  const sent = await client.session.promptAsync({ sessionID, parts: [{ type: "text", text: "Reply with the word PONG." }] })
  console.log(`[${label}] prompt_async status=${sent.response?.status}`)
  const deltas: number[] = []
  const text = { value: "" }
  const done = setTimeout(() => controller.abort(), 15_000)
  for await (const event of sub.stream) {
    const mine = "sessionID" in event.properties && event.properties.sessionID === sessionID
    if (!mine) continue
    const at = Math.round(performance.now() - t0)
    if (event.type === "message.part.delta") {
      deltas.push(at)
      text.value += event.properties.field === "text" ? event.properties.delta : ""
      console.log(`[${label}] +${at}ms ${event.type} field=${event.properties.field}`)
      if (abortOnFirstDelta && deltas.length === 1) {
        const aborted = await client.session.abort({ sessionID })
        console.log(`[${label}] +${Math.round(performance.now() - t0)}ms abort status=${aborted.response?.status}`)
      }
      continue
    }
    if (event.type === "message.updated" && event.properties.info.role === "assistant") {
      const info = event.properties.info
      console.log(
        `[${label}] +${at}ms message.updated assistant providerID=${info.providerID} modelID=${info.modelID} completed=${!!info.time.completed} error=${info.error?.name ?? "none"}`,
      )
      continue
    }
    console.log(`[${label}] +${at}ms ${event.type}`)
    if (event.type === "session.idle") break
  }
  clearTimeout(done)
  controller.abort()
  const spread = deltas.length > 1 ? deltas[deltas.length - 1]! - deltas[0]! : 0
  console.log(`[${label}] deltas=${deltas.length} first=+${deltas[0] ?? "none"}ms spread=${spread}ms textLength=${text.value.length}`)
}

await run("complete", false)
await run("abort", true)
process.exit(0)
