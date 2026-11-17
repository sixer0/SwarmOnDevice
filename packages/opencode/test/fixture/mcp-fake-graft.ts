import fs from "node:fs"
import path from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// Stands in for graft 0.18: `build` writes graft/INDEX.md (as a plain build does) in its cwd; `mcp` lists a tool only when that graph
// already existed at start (the real server's behaviour, ECO-1 F-2). FAKE_GRAFT_BUILD=fail makes `build` exit 2.
const manifest = path.join(process.cwd(), "graft", "INDEX.md")
const sub = process.argv[2]

if (sub === "build") {
  if (process.env.FAKE_GRAFT_BUILD === "fail") process.exit(2)
  fs.mkdirSync(path.dirname(manifest), { recursive: true })
  fs.writeFileSync(manifest, `# graft ${process.argv.slice(2).join(" ")}\n`)
  process.exit(0)
}

const hadGraph = fs.existsSync(manifest)
const server = new Server({ name: "fake-graft", version: "0.0.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: hadGraph ? [{ name: "graft_repo_map", description: "map", inputSchema: { type: "object", properties: {} } }] : [],
  }),
)
await server.connect(new StdioServerTransport())
