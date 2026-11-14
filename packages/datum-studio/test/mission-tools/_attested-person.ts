// 1.2.9 row 50c (C46, AC-C01 fixture INTENT): the one key-bearing test helper. Since row 50 a `by: "user"` answer or
// decision, and an owner message, is stored only from an attested request: the Mission Control key on every request
// (S9-01), as desktop's mission client sends it. A fixture that models the person starts its host with
// `missionControlKey: PERSON_KEY` and makes those calls through `personCaller`; agents keep their own unattested clients.
// Synthetic key (not a secret): 32 bytes as lower-case hex, distinct from every test token.
export const PERSON_KEY = "6d".repeat(16) + "0123456789abcdef".repeat(2)
export const MISSION_CONTROL_KEY_HEADER = "x-swarm-mission-control-key"

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * A raw MCP caller over the host's streamable HTTP endpoint (one session, opened on the first call), with the key on
 * every request. Returns the tool result's structuredContent. `fetchImpl` is for tests that trap globalThis.fetch.
 */
export function personCaller(o: { url: string; token: string; cwd: string; agent?: string; key?: string; fetchImpl?: typeof fetch }) {
  const doFetch = o.fetchImpl ?? fetch
  let sid: string | undefined
  let id = 0
  const post = async (body: Json): Promise<Json> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${o.token}`,
      "x-studio-agent": o.agent ?? "swarm",
      "x-studio-caller-cwd": encodeURIComponent(o.cwd),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      [MISSION_CONTROL_KEY_HEADER]: o.key ?? PERSON_KEY,
      ...(sid ? { "mcp-session-id": sid } : {}),
    }
    const r = await doFetch(o.url, { method: "POST", headers, body: JSON.stringify(body) })
    if (body.method === "initialize") sid = r.headers.get("mcp-session-id") ?? undefined
    const text = await r.text()
    const data = text.includes("data:")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      : text
    return data ? (JSON.parse(data) as Json) : {}
  }
  return async (name: string, args: Json, meta?: Json): Promise<Json> => {
    if (!sid) {
      await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "row50c-person", version: "0" } } })
      await post({ jsonrpc: "2.0", method: "notifications/initialized" })
    }
    const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } })
    return (r.result?.structuredContent ?? { ok: false, rpc: r.error }) as Json
  }
}
