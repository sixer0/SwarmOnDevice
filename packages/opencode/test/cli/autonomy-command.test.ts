import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BYPASS_CONSENT_TEXT } from "@opencode-ai/core/permission/bypass-consent"

// 1.2.7 U-10 (decisions U6, C63): `swarm autonomy on|off|status`. Drives the real command in a child process against a
// stand-in for the app's server, found the way the command finds the app (app-server.env). The TTY cases run it on a real
// pseudo terminal, because what is decided is whether a person is there, and no flag, environment value or piped answer
// may stand in for that.

const cli = path.resolve(import.meta.dir, "../../src/index.ts")
const cleanup: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((step) => step()))
})

type Seen = { method: string; path: string; authorization: string | null; body: Record<string, unknown> | undefined }

/** A stand-in for the app's server: it records every request and answers the mode routes like the real one. */
async function bench(options: { descriptor?: boolean } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swarm-auto-cli-")))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const seen: Seen[] = []
  const state = { on: false, bypass: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "PUT" ? ((await request.json()) as Record<string, unknown>) : undefined
      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
      })
      if (url.pathname !== "/autonomy/mode") return new Response("not found", { status: 404 })
      if (body) {
        state.on = body.on === true
        state.bypass = body.on === true && body.bypassConsent === "bypass-v1"
      }
      return Response.json({ ...state, externalChange: null })
    },
  })
  cleanup.push(() => server.stop(true))
  if (options.descriptor !== false) {
    await fs.mkdir(path.join(root, "state", "swarm"), { recursive: true })
    await Bun.write(
      path.join(root, "state", "swarm", "app-server.env"),
      `URL=http://127.0.0.1:${server.port}\nUSERNAME=swarm\nPASSWORD=synthetic-pass\nPID=${process.pid}\n`,
    )
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: root,
    OPENCODE_TEST_HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    SWARM_APP_STATE_HOME: undefined,
    SWARM_SERVER_PASSWORD: undefined,
    OPENCODE_SERVER_PASSWORD: undefined,
    LANG: "en_US.UTF-8",
    LC_ALL: undefined,
    LC_MESSAGES: undefined,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PURE: "1",
  }
  return { root, env, seen, state }
}

async function piped(args: string[], env: Record<string, string | undefined>, input: string) {
  const child = Bun.spawn(["bun", "run", cli, "autonomy", ...args], {
    env,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

/** Runs the command on a pseudo terminal and types `answer` once it asks. An undefined answer sends end of input. */
async function atTerminal(args: string[], env: Record<string, string | undefined>, answer: string | undefined) {
  const seen = { text: "", answered: false }
  const child = Bun.spawn(["bun", "run", cli, "autonomy", ...args], {
    env,
    terminal: {
      cols: 400,
      rows: 80,
      data(terminal, data) {
        seen.text += new TextDecoder().decode(data)
        if (seen.answered || !seen.text.includes("Type yes")) return
        seen.answered = true
        terminal.write(answer === undefined ? "\x04" : `${answer}\r`)
      },
    },
  })
  const code = await child.exited
  child.terminal?.close()
  return { text: seen.text, code, answered: seen.answered }
}

const puts = (seen: Seen[]) => seen.filter((request) => request.method === "PUT")
const flat = (text: string) => text.replace(/\s+/g, " ")

describe("swarm autonomy on needs a person", () => {
  test("at a terminal, the bypass-v1 consent text and a typed yes turn it on with the consent, once", async () => {
    const { env, seen, root } = await bench()
    const result = await atTerminal(["on", "--dir", root], env, "yes")
    expect(result.answered).toBe(true)
    expect(result.code).toBe(0)
    // The same text the app's consent screen shows, from the one shared source.
    for (const part of ["title", "intro", "refused", "waits", "scope"] as const)
      expect(flat(result.text)).toContain(flat(BYPASS_CONSENT_TEXT.en[part]))
    expect(puts(seen)).toHaveLength(1)
    expect(puts(seen)[0]!.body).toEqual({ on: true, bypassConsent: "bypass-v1", reportLanguage: "en" })
    expect(puts(seen)[0]!.authorization).toBe(`Basic ${Buffer.from("swarm:synthetic-pass").toString("base64")}`)
    expect(result.text).toContain("Autonomous mode is on")
  })

  test("with no terminal it refuses in one line, exits non-zero and sends nothing", async () => {
    const { env, seen } = await bench()
    const result = await piped(["on"], env, "")
    expect(result.code).not.toBe(0)
    expect(result.stderr.trim().split("\n")).toHaveLength(1)
    expect(result.stderr).toContain("terminal")
    expect(seen).toHaveLength(0)
  })

  test("a piped yes is not a person, and no flag answers for one", async () => {
    const { env, seen } = await bench()
    for (const extra of [[], ["--yes"], ["-y"], ["--force"]]) {
      const result = await piped(["on", ...extra], env, "yes\n")
      expect(result.code).not.toBe(0)
    }
    expect(seen).toHaveLength(0)
  })

  for (const [name, answer] of [
    ["no", "no"],
    ["an empty line", ""],
    ["y", "y"],
    ["YES", "YES"],
    ["end of input", undefined],
  ] as const) {
    test(`at a terminal, ${name} turns nothing on and sends nothing`, async () => {
      const { env, seen } = await bench()
      const result = await atTerminal(["on"], env, answer)
      expect(result.answered).toBe(true)
      expect(result.code).not.toBe(0)
      expect(puts(seen)).toHaveLength(0)
    })
  }

  test("with no live server it says so and asks nothing", async () => {
    const { env, seen } = await bench({ descriptor: false })
    const result = await atTerminal(["on"], env, "yes")
    expect(result.answered).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.text).toContain("No running Swarm server")
    expect(seen).toHaveLength(0)
  })

  test("off asks nothing and sends no consent; status prints the mode and the consent", async () => {
    const { env, seen, state } = await bench()
    state.on = true
    state.bypass = true
    const status = await piped(["status"], env, "")
    expect(status.code).toBe(0)
    expect(status.stdout).toContain("on")
    expect(status.stdout).toContain("Consent: given (bypass-v1)")
    const off = await piped(["off"], env, "")
    expect(off.code).toBe(0)
    expect(puts(seen).map((request) => request.body)).toEqual([{ on: false }])
    const after = await piped(["status"], env, "")
    expect(after.stdout).toContain("Consent: none")
  })
})
