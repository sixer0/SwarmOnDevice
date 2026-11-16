import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

if (process.argv.includes("--hang")) {
  const pidFile = process.env.MCP_LIFECYCLE_PID_FILE
  if (!pidFile) throw new Error("MCP_LIFECYCLE_PID_FILE is required")
  await Bun.write(pidFile, String(process.pid))
  await new Promise(() => {})
}

// Swarm 1.3.2 row 17 (F4): `--stderr <line>` says something on stderr before serving, so a test can assert the parent
// read it. The bridge's own lines (`BRIDGE_START`, `HOST_UNREACHABLE`, `TOKEN_REJECTED`) were the reason for this flag.
const stderrFlag = process.argv.indexOf("--stderr")
if (stderrFlag >= 0) {
  process.stderr.write(`${process.argv[stderrFlag + 1] ?? "MCP_STDERR_LINE"}\n`)
}

// Row 16b (F-N6): `--stderr-many <n>` floods stderr, to prove the per-client line budget and its single marker.
const manyFlag = process.argv.indexOf("--stderr-many")
if (manyFlag >= 0) {
  const count = Number(process.argv[manyFlag + 1] ?? "0")
  for (let index = 0; index < count; index++) process.stderr.write(`BRIDGE_LINE_${index} payload=${"x".repeat(80)}\n`)
}

// Row 16b (F-N1): `--die <line>` is the startup shape the investigation cared about — the child says its reason on
// stderr and exits 3 before `initialize` ever completes, so no client exists to attach anything to.
const dieFlag = process.argv.indexOf("--die")
if (dieFlag >= 0) {
  process.stderr.write(`${process.argv[dieFlag + 1] ?? "BRIDGE_FAILED"}\n`)
  process.exit(3)
}

const server = new Server({ name: "mcp-lifecycle-stdio", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "current_directory",
        description: process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())
