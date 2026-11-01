import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

// Drives the real command in a child process. The TTY cases run it on a real pseudo terminal, because what is being
// decided is whether a person is there, and no flag or environment value may stand in for that.

const cli = path.resolve(import.meta.dir, "../../src/index.ts")
const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function bench() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "swarm-trust-cli-")))
  cleanup.push(root)
  const folder = path.join(root, "work")
  await fs.mkdir(path.join(folder, ".git"), { recursive: true })
  await Bun.write(
    path.join(folder, "swarm.json"),
    JSON.stringify({ permission: { "*": "allow" }, mcp: { evil: { type: "local", command: ["/bin/false"] } } }),
  )
  const env = {
    ...process.env,
    HOME: root,
    OPENCODE_TEST_HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_PURE: "1",
  }
  const store = path.join(root, "state", "swarm", "trust.json")
  return { folder, env, store }
}

const trustedIn = async (store: string) =>
  Object.keys(
    (await Bun.file(store)
      .json()
      .catch(() => ({ directories: {} }))).directories,
  )

async function piped(args: string[], env: Record<string, string | undefined>, input: string) {
  const child = Bun.spawn(["bun", "run", cli, "trust", ...args], {
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
  const child = Bun.spawn(["bun", "run", cli, "trust", ...args], {
    env,
    terminal: {
      cols: 200,
      rows: 50,
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

describe("swarm trust needs a person", () => {
  test("with no terminal it refuses in one line, exits non-zero and writes nothing", async () => {
    const { folder, env, store } = await bench()
    const result = await piped([folder], env, "")
    expect(result.code).not.toBe(0)
    expect(result.stderr.trim().split("\n")).toHaveLength(1)
    expect(result.stderr).toContain("terminal")
    expect(await Bun.file(store).exists()).toBe(false)
  })

  test("a piped yes is not a person", async () => {
    const { folder, env, store } = await bench()
    const result = await piped([folder], env, "yes\n")
    expect(result.code).not.toBe(0)
    expect(await Bun.file(store).exists()).toBe(false)
  })

  test("at a terminal it says what the folder wants, and only a typed yes grants", async () => {
    const { folder, env, store } = await bench()
    const result = await atTerminal([folder], env, "yes")
    expect(result.answered).toBe(true)
    expect(result.code).toBe(0)
    expect(result.text).toContain("Change which tools run without asking")
    expect(result.text).toContain(`Start MCP server "evil": /bin/false`)
    expect(await trustedIn(store)).toEqual([folder])
  })

  for (const [name, answer] of [
    ["no", "no"],
    ["an empty line", ""],
    ["y", "y"],
    ["YES", "YES"],
    ["end of input", undefined],
  ] as const) {
    test(`at a terminal, ${name} grants nothing and exits non-zero`, async () => {
      const { folder, env, store } = await bench()
      const result = await atTerminal([folder], env, answer)
      expect(result.answered).toBe(true)
      expect(result.code).not.toBe(0)
      expect(await Bun.file(store).exists()).toBe(false)
    })
  }

  test("no flag skips the question", async () => {
    const { folder, env, store } = await bench()
    for (const flag of ["--yes", "-y", "--force"]) {
      const result = await piped([folder, flag], env, "")
      expect(result.code).not.toBe(0)
      expect(await Bun.file(store).exists()).toBe(false)
    }
  })

  test("what it prints from the folder is clean, and a long list is counted", async () => {
    const { folder, env, store } = await bench()
    const servers = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`\x1b[41ms${index}\nSECOND`, { type: "remote", url: "x" }]),
    )
    await Bun.write(path.join(folder, "swarm.json"), JSON.stringify({ mcp: servers }))
    const result = await atTerminal([folder], env, "no")
    expect(result.answered).toBe(true)
    expect(result.text).not.toContain("\x1b[41m")
    expect(result.text).not.toContain("\nSECOND")
    expect(result.text).toContain("and 24 more")
    expect(await Bun.file(store).exists()).toBe(false)
  })

  test("--remove asks nothing, because it only takes trust away", async () => {
    const { folder, env, store } = await bench()
    await atTerminal([folder], env, "yes")
    expect(await trustedIn(store)).toEqual([folder])
    const result = await piped([folder, "--remove"], env, "")
    expect(result.code).toBe(0)
    expect(await trustedIn(store)).toEqual([])
  })
})
