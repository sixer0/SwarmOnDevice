import type { Argv } from "yargs"
import path from "path"
import readline from "readline"
import {
  BYPASS_CONSENT_PARAGRAPHS,
  BYPASS_CONSENT_TEXT,
  BYPASS_CONSENT_VERSION,
} from "@opencode-ai/core/permission/bypass-consent"
import { cmd } from "./cmd"

// 1.2.7 U-10 (decisions U6, C63): autonomous mode from a terminal. The consent lives only in the memory of the server that
// runs the agent (permission/autonomy.ts `setMode`), so this command never writes a file: it asks the live server, the
// app's (app-server.env) or one given with --attach, and nothing else can grant it.
//
// Turning it on is a person's decision (1.1.1 rule), so `on` has no flag, environment value or piped answer that stands in
// for one: stdin and stdout must be a terminal, the bypass-v1 consent text is shown every time, and only a typed `yes`
// sends it. A terminal is not proof of a person: an agent's shell that opens a pseudo terminal passes this check, which
// is why the autonomy table refuses `swarm autonomy` from any agent shell (X own_api, reason person_only). The residual is
// the one trust.ts names: a program the person already allowed to drive a terminal could type it.
export const AutonomyCommand = cmd({
  command: "autonomy <action>",
  describe: "turn autonomous mode on or off in the running Swarm app or server, or show it",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", { type: "string", choices: ["on", "off", "status"] as const, demandOption: true })
      .option("session", { type: "string", describe: "a session ID; the folder's setting when left out" })
      .option("dir", { type: "string", describe: "the folder, the current one by default" })
      .option("attach", {
        type: "string",
        describe: "a running swarm server (password from SWARM_SERVER_PASSWORD); the open app by default",
      })
      .option("language", { type: "string", choices: ["en", "id"] as const, describe: "consent and report language" }),
  handler: async (args) => {
    const language = args.language === "id" || args.language === "en" ? args.language : systemLanguage()
    if (args.action === "on" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      process.stderr.write(
        "swarm autonomy on needs a person at a terminal to type yes, so autonomous mode was not turned on.\n",
      )
      process.exitCode = 1
      return
    }
    const server = await liveServer(args.attach)
    if (!server) {
      process.stderr.write(
        "No running Swarm server was found, so nothing was changed. Open the Swarm app, or start `swarm serve` and pass --attach with its address.\n",
      )
      process.exitCode = 1
      return
    }
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
    const client = createOpencodeClient({
      baseUrl: server.url,
      directory: path.resolve(process.cwd(), args.dir ?? "."),
      headers: server.headers,
    })
    const where = args.session ? `session ${args.session}` : "this folder"

    if (args.action === "status") {
      const state = await call(() =>
        args.session ? client.autonomy.session({ sessionID: args.session }) : client.autonomy.mode(),
      )
      if (!state) return
      process.stdout.write(
        `Autonomous mode for ${where}: ${state.on ? "on" : "off"}\n` +
          `Consent: ${state.bypass ? `given (${BYPASS_CONSENT_VERSION}), until the mode is turned off or Swarm restarts` : "none"}\n`,
      )
      return
    }

    if (args.action === "off") {
      const state = await call(() => client.autonomy.modeUpdate({ on: false, sessionID: args.session }))
      if (!state) return
      process.stdout.write(`Autonomous mode is off for ${where}.\n`)
      return
    }

    const text = BYPASS_CONSENT_TEXT[language]
    process.stdout.write(
      [plain(text.title), "", ...BYPASS_CONSENT_PARAGRAPHS.flatMap((part) => [plain(text[part]), ""])].join("\n"),
    )
    if ((await answer(`Type yes to agree and turn it on for ${where}: `)) !== "yes") {
      process.stdout.write("Not turned on. Nothing was sent.\n")
      process.exitCode = 1
      return
    }
    const state = await call(() =>
      client.autonomy.modeUpdate({
        on: true,
        sessionID: args.session,
        bypassConsent: BYPASS_CONSENT_VERSION,
        reportLanguage: language,
      }),
    )
    if (!state) return
    process.stdout.write(`Autonomous mode is on for ${where}. Turn it off with: swarm autonomy off\n`)
  },
})

type ModeAnswer = { data?: { on: boolean; bypass?: boolean }; error?: unknown }

/** One request; a failure is one line on stderr and a non-zero exit, never the server's raw body. */
async function call(request: () => Promise<ModeAnswer>) {
  const response = await request().catch(() => undefined)
  if (response?.data) return response.data
  process.stderr.write("The Swarm server did not accept the request, so nothing was changed.\n")
  process.exitCode = 1
  return undefined
}

/**
 * The server to ask: --attach with the SWARM_SERVER_* credentials, else the open app's descriptor (app-server.env, written
 * 0600 by the app and removed on quit), only while its process runs and only on this computer, so the password in it is
 * never sent elsewhere.
 */
async function liveServer(attach: string | undefined) {
  const { ServerAuth } = await import("@/server/auth")
  if (attach) return { url: attach, headers: ServerAuth.headers() }
  const state = process.env.SWARM_APP_STATE_HOME || process.env.XDG_STATE_HOME
  if (!state) return undefined
  const text = await Bun.file(path.join(state, "swarm", "app-server.env"))
    .text()
    .catch(() => "")
  const fields = Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.split("="))
      .filter((pair) => pair.length === 2),
  )
  const pid = Number(fields.PID)
  if (!fields.URL || !fields.PASSWORD || !Number.isInteger(pid) || pid <= 0 || !running(pid)) return undefined
  if (!loopback(fields.URL)) return undefined
  return { url: fields.URL, headers: ServerAuth.headers({ password: fields.PASSWORD, username: fields.USERNAME }) }
}

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function loopback(url: string) {
  const host = URL.canParse(url) ? new URL(url).hostname : ""
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]"
}

function systemLanguage() {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ""
  return locale.toLowerCase().startsWith("id") ? ("id" as const) : ("en" as const)
}

/** The Indonesian text marks loanwords as `*word*` for the app's italics; a terminal shows the word alone. */
function plain(text: string) {
  return text.replace(/\*([^*\n]+)\*/g, "$1")
}

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
