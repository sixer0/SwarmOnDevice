import type { Argv } from "yargs"
import path from "path"
import readline from "readline"
import { ProjectTrust } from "@opencode-ai/core/project/trust"
import { cmd } from "./cmd"

export const TrustCommand = cmd({
  command: "trust [dir]",
  describe: "let a folder load its own plugins, tools, MCP servers and permission rules",
  builder: (yargs: Argv) =>
    yargs
      .positional("dir", { type: "string", describe: "folder to trust, the current one by default" })
      .option("remove", { type: "boolean", describe: "stop trusting the folder" }),
  handler: async (args) => {
    const directory = path.resolve(process.cwd(), args.dir ?? ".")
    if (args.remove) {
      process.stdout.write(`Not trusted: ${ProjectTrust.printable(ProjectTrust.revoke(directory))}\n`)
      return
    }
    // A grant is a person's decision, so there is deliberately no flag that answers for them. A model's bash and a script have
    // no terminal here. This stops the plain route only: the store is a file the user can write, so an approved bash can write it.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("swarm trust needs a person at a terminal to type yes, so nothing was changed.\n")
      process.exitCode = 1
      return
    }
    const status = ProjectTrust.status(directory)
    const lines = [
      `Trust ${status.directory}?`,
      ...(status.items.length
        ? ["It wants to:", ...status.items.map((item) => `  ${item.label}`)]
        : ["It has nothing to load right now."]),
      "Anything it adds later loads without asking.",
    ]
    process.stdout.write(lines.join("\n") + "\n")
    if ((await answer("Type yes to trust it: ")) !== "yes") {
      process.stdout.write("Not trusted. Nothing was changed.\n")
      process.exitCode = 1
      return
    }
    process.stdout.write(`Trusted: ${ProjectTrust.printable(ProjectTrust.trust(directory))}\n`)
  },
})

/** One typed line, or nothing if the terminal closes first. */
function answer(prompt: string) {
  const reader = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<string>((resolve) => {
    reader.once("close", () => resolve(""))
    reader.question(prompt, (line) => {
      resolve(line.trim())
      reader.close()
    })
  })
}
