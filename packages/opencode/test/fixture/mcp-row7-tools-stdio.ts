// Row 7 (1.3.3, MC-2 item 1): a stdio MCP server that stands in for the datum-studio bridge across restarts. Each
// start is one "generation" (counted in ROW7_COUNT_FILE). Per generation it can: start late (ROW7_DELAY_GENS, by
// ROW7_DELAY_MS), never answer at all (ROW7_HANG_GENS), answer initialize but never tools/list (ROW7_LIST_HANG_GENS),
// or list zero tools (ROW7_EMPTY_GENS). ROW7_NO_TOOLS=1 is a server that never advertises the tools capability.
// `quit` answers, then exits 3 shortly after, as the bridge does when its host is gone.
import fs from "node:fs"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const countFile = process.env.ROW7_COUNT_FILE
if (!countFile) throw new Error("ROW7_COUNT_FILE is required")
const generation = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) || 0 : 0) + 1
fs.writeFileSync(countFile, String(generation))

const inGens = (name: string) =>
  (process.env[name] ?? "").split(",").filter(Boolean).map(Number).includes(generation)

// The parent closing stdin is the only way a hanging generation ends.
process.stdin.on("end", () => process.exit(0))
process.stdin.on("close", () => process.exit(0))

if (inGens("ROW7_HANG_GENS")) {
  process.stdin.resume()
  await new Promise(() => {})
}

if (inGens("ROW7_DELAY_GENS")) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.ROW7_DELAY_MS ?? "400")))
}

const noTools = process.env.ROW7_NO_TOOLS === "1"
const server = new Server(
  { name: "mcp-row7-tools-stdio", version: "1.0.0" },
  { capabilities: noTools ? {} : { tools: {} } },
)

if (!noTools) {
  server.setRequestHandler(ListToolsRequestSchema, () => {
    if (inGens("ROW7_LIST_HANG_GENS")) return new Promise<never>(() => {})
    if (inGens("ROW7_EMPTY_GENS")) return Promise.resolve({ tools: [] })
    return Promise.resolve({
      tools: [
        { name: "ping", description: "answers with the generation", inputSchema: { type: "object", properties: {} } },
        { name: "quit", description: "answers, then exits", inputSchema: { type: "object", properties: {} } },
      ],
    })
  })

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    if (request.params.name === "quit") {
      setTimeout(() => process.exit(3), 50)
      return Promise.resolve({ content: [{ type: "text", text: `bye ${generation}` }] })
    }
    return Promise.resolve({ content: [{ type: "text", text: `gen ${generation}` }] })
  })
}

await server.connect(new StdioServerTransport())
