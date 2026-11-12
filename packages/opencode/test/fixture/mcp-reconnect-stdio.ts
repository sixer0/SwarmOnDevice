// M-02 (1.2.6 row 54c): a stdio MCP server that stands in for the datum-studio bridge. Each start is one
// "generation" (counted in MCP_RECONNECT_COUNT_FILE). In a generation listed in MCP_RECONNECT_DIE_GENS a `ping` call
// makes the process exit 3 before it answers, as the bridge does when its host is gone. `quit` answers, then exits 3
// shortly after (the bridge ending while no call is pending).
import fs from "node:fs"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const countFile = process.env.MCP_RECONNECT_COUNT_FILE
if (!countFile) throw new Error("MCP_RECONNECT_COUNT_FILE is required")
const generation = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) || 0 : 0) + 1
fs.writeFileSync(countFile, String(generation))
const dies = (process.env.MCP_RECONNECT_DIE_GENS ?? "").split(",").filter(Boolean).map(Number).includes(generation)

const server = new Server({ name: "mcp-reconnect-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      { name: "ping", description: "answers with the generation", inputSchema: { type: "object", properties: {} } },
      { name: "quit", description: "answers, then exits", inputSchema: { type: "object", properties: {} } },
    ],
  }),
)

// C19e (1.2.6 row FX-3): optional log of every call this process received, one `<generation>:<tool>` line each, so a
// test can prove a call was (or was not) delivered to a later generation.
const callsFile = process.env.MCP_RECONNECT_CALLS_FILE

server.setRequestHandler(CallToolRequestSchema, (request) => {
  if (callsFile) fs.appendFileSync(callsFile, `${generation}:${request.params.name}\n`)
  if (request.params.name === "quit") {
    setTimeout(() => process.exit(3), 50)
    return Promise.resolve({ content: [{ type: "text", text: `bye ${generation}` }] })
  }
  if (dies) process.exit(3)
  return Promise.resolve({ content: [{ type: "text", text: `gen ${generation}` }] })
})

await server.connect(new StdioServerTransport())
