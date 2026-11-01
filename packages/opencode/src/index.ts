// Swarm defaults shim. This must stay the FIRST import of the CLI entry: it applies the
// egress-off ??= defaults, the SWARM_* -> OPENCODE_* alias mirror, guard G3 and the
// SWARM=1 child marker to process.env before any transitive import evaluates
// packages/core/src/flag/flag.ts at module load (FR-DEF-01..07, row 36 module contract).
import "@opencode-ai/core/swarm-defaults"
import yargs, { type CommandModule } from "yargs"
import { hideBin } from "yargs/helpers"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"

// Commands load on demand: every process, including each TUI's, used to evaluate the whole CLI before doing anything.
// Order is the order `swarm --help` lists them in.
// ConsoleCommand (./cli/cmd/account) and GithubCommand (./cli/cmd/github) are deliberately not
// imported or registered: FR-CLI-09 keeps `swarm console` and `swarm github` off the command
// surface. The modules stay on disk untouched (disable-not-delete), and account.ts still exports
// its helpers, which test/cli/account.test.ts imports directly.
const commands = {
  acp: async () => (await import("./cli/cmd/acp")).AcpCommand,
  mcp: async () => (await import("./cli/cmd/mcp")).McpCommand,
  $0: async () => (await import("./cli/cmd/tui")).TuiThreadCommand,
  attach: async () => (await import("./cli/cmd/attach")).AttachCommand,
  fleet: async () => (await import("./cli/cmd/fleet")).FleetCommand,
  run: async () => (await import("./cli/cmd/run")).RunCommand,
  generate: async () => (await import("./cli/cmd/generate")).GenerateCommand,
  debug: async () => (await import("./cli/cmd/debug")).DebugCommand,
  providers: async () => (await import("./cli/cmd/providers")).ProvidersCommand,
  agent: async () => (await import("./cli/cmd/agent")).AgentCommand,
  upgrade: async () => (await import("./cli/cmd/upgrade")).UpgradeCommand,
  uninstall: async () => (await import("./cli/cmd/uninstall")).UninstallCommand,
  serve: async () => (await import("./cli/cmd/serve")).ServeCommand,
  web: async () => (await import("./cli/cmd/web")).WebCommand,
  models: async () => (await import("./cli/cmd/models")).ModelsCommand,
  stats: async () => (await import("./cli/cmd/stats")).StatsCommand,
  export: async () => (await import("./cli/cmd/export")).ExportCommand,
  import: async () => (await import("./cli/cmd/import")).ImportCommand,
  pr: async () => (await import("./cli/cmd/pr")).PrCommand,
  session: async () => (await import("./cli/cmd/session")).SessionCommand,
  plugin: async () => (await import("./cli/cmd/plug")).PluginCommand,
  db: async () => (await import("./cli/cmd/db")).DbCommand,
  trust: async () => (await import("./cli/cmd/trust")).TrustCommand,
}
const commandAliases: Record<string, keyof typeof commands | undefined> = { auth: "providers", plug: "plugin" }

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  // Register J02: this test is the parser twin of .scriptName below. It must read "swarm ",
  // otherwise the logo prints before every help screen.
  if (!text.startsWith("swarm ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("swarm")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  // Register C1 / A07 credit line, verbatim from research/03c_licence_notice_plan.md 4.3. It is the
  // only "OpenCode" string allowed in user-visible output (AC1 exception, Q5) and belongs to --help
  // only: FR-CLI-02 keeps --version a bare version token so the build smoke test still parses it.
  .epilogue("Based on OpenCode (MIT). Not affiliated with the OpenCode team.")
  .completion("completion", "generate shell completion script")
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  for (const load of commandsFor(args)) cli.command((await load()) as CommandModule<any, any>)
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}

function commandsFor(input: string[]): (() => Promise<unknown>)[] {
  if (input.some((token) => ["-h", "--help", "--get-yargs-completions", "completion"].includes(token))) {
    return Object.values(commands)
  }
  if (input[0] === "-v" || input[0] === "--version") return []
  const named = (token: string) => {
    const id = commandAliases[token] ?? token
    return Object.hasOwn(commands, id) && id !== "$0" ? commands[id as keyof typeof commands] : undefined
  }
  const rest = input.filter(
    (token, index) =>
      !["--print-logs", "--pure", "--log-level"].includes(token) &&
      !token.startsWith("--log-level=") &&
      input[index - 1] !== "--log-level",
  )
  const command = rest[0] === undefined ? undefined : named(rest[0])
  if (command) return [command]
  // A command word further along may be a flag's value or a misplaced command: let yargs see every command, as before.
  if (rest.some(named)) return Object.values(commands)
  return [commands.$0]
}
