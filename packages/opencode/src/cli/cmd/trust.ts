import type { Argv } from "yargs"
import path from "path"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { cmd } from "./cmd"
import { UI } from "../ui"

export const TrustCommand = cmd({
  command: "trust [dir]",
  describe: "let a folder load its own plugins, tools, MCP servers and permission rules",
  builder: (yargs: Argv) =>
    yargs
      .positional("dir", { type: "string", describe: "folder to trust, the current one by default" })
      .option("remove", { type: "boolean", describe: "stop trusting the folder" }),
  handler: (args) => {
    const directory = path.resolve(process.cwd(), args.dir ?? ".")
    if (args.remove) {
      UI.println(`Not trusted: ${ProjectTrust.revoke(directory)}`)
      return
    }
    const items = ProjectTrust.scan(directory)
    UI.println(`Trusted: ${ProjectTrust.trust(directory)}`)
    for (const item of items) UI.println(`  ${item.label}`)
  },
})
