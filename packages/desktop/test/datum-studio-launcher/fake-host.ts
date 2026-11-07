// Row 34 host fixture: a stand-in for the Studio endpoint the running app hosts (Studio spec §9.1, row 31 contract
// in packages/datum-studio/src/mcp-host/http-server.ts). It is started through a symlink named
// `<fixture>/Fake.app/Contents/MacOS/Swarm`, so the launcher's PID check (`ps -o comm=`) sees a running Swarm.
// It writes the descriptor with the app's own writer (row 111 descriptor.ts) and records what each request carried,
// except the token, to FAKE_RECORD (JSON lines). FAKE_MODE: ok | wrong-token | unsafe-mode.
import { randomBytes, timingSafeEqual } from "node:crypto"
import { appendFileSync, chmodSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { studioDescriptorPath, writeStudioDescriptor } from "../../src/main/datum-studio-host/descriptor"

const state = process.env.FAKE_STATE!
const recordFile = process.env.FAKE_RECORD!
const mode = process.env.FAKE_MODE ?? "ok"
const token = randomBytes(32).toString("hex")
export const TOOLS = ["studio_registry", "studio_templates_list", "studio_document_create"]
const SESSION = "fixture-session-1"
let port = 0
let negotiated: string | undefined

function record(entry: Record<string, unknown>) {
  appendFileSync(recordFile, JSON.stringify(entry) + "\n")
}

function deny(res: ServerResponse, status: number) {
  res.writeHead(status).end()
}

function authorized(req: IncomingMessage) {
  if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::ffff:127.0.0.1") return 403
  if (req.headers.host !== `127.0.0.1:${port}`) return 403
  if (req.headers.origin !== undefined) return 403
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")
  if (!m || m[1].length !== token.length || !timingSafeEqual(Buffer.from(m[1]), Buffer.from(token))) return 401
  return 0
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

const server = createServer(async (req, res) => {
  const status = authorized(req)
  const entry = {
    method: req.method,
    status,
    hasAuthorization: req.headers.authorization !== undefined,
    agent: req.headers["x-studio-agent"],
    cwd: typeof req.headers["x-studio-caller-cwd"] === "string" ? decodeURIComponent(req.headers["x-studio-caller-cwd"]) : null,
    session: req.headers["mcp-session-id"],
    protocol: req.headers["mcp-protocol-version"],
    proxyHop: req.headers["proxy-connection"] !== undefined || (req.url ?? "").startsWith("http"),
  }
  if (status !== 0) {
    record(entry)
    req.resume()
    return deny(res, status)
  }
  if ((req.url ?? "").split("?")[0] !== "/mcp") return deny(res, 404)
  if (req.method === "DELETE") {
    record(entry)
    return deny(res, 200)
  }
  if (req.method === "GET") {
    record(entry)
    if (req.headers["mcp-session-id"] !== SESSION) return deny(res, 404)
    // The standalone stream stays open until this process ends (that is how the bridge sees Swarm quit).
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    res.write(": open\n\n")
    return
  }
  const message = JSON.parse(await body(req)) as { id?: number; method?: string; params?: Record<string, unknown> }
  record({ ...entry, rpc: message.method })
  if (message.method === "initialize") {
    if (req.headers["x-studio-agent"] === undefined || req.headers["x-studio-caller-cwd"] === undefined) return deny(res, 400)
    negotiated = String(message.params?.protocolVersion)
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": SESSION })
    return res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: { name: "datum-studio", version: "fixture" } },
      }),
    )
  }
  if (req.headers["mcp-session-id"] !== SESSION) return deny(res, 404)
  if (req.headers["mcp-protocol-version"] !== negotiated) return deny(res, 400)
  if (message.id === undefined) return deny(res, 202)
  if (message.method === "tools/list") {
    // Answered as server-sent events, like the SDK server does for requests.
    res.writeHead(200, { "content-type": "text/event-stream" })
    const result = { tools: TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) }
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`)
    return res.end()
  }
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }))
})

// Row 34b: FAKE_DESCRIPTOR_DELAY_MS writes the descriptor that much later (the app still starting its Studio host);
// FAKE_MODE=never-ready never writes it. READY is printed at once in both cases.
const delay = Number(process.env.FAKE_DESCRIPTOR_DELAY_MS ?? 0)

server.listen(0, "127.0.0.1", async () => {
  port = (server.address() as AddressInfo).port
  const descriptor = studioDescriptorPath(state)
  const written = mode === "wrong-token" ? randomBytes(32).toString("hex") : token
  const write = async () => {
    await writeStudioDescriptor(descriptor, { url: `http://127.0.0.1:${port}/mcp`, token: written, pid: process.pid })
    if (mode === "unsafe-mode") chmodSync(descriptor, 0o644)
  }
  if (mode !== "never-ready" && delay === 0) await write()
  if (mode !== "never-ready" && delay > 0) setTimeout(() => void write(), delay)
  // The test reads the token from here to prove it never appears in any output; production never prints it.
  process.stdout.write(`READY ${port} ${token} ${written}\n`)
})
process.on("SIGTERM", () => process.exit(0))
