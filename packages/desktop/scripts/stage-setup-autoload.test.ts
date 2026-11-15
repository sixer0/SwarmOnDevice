import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROXY_BINARY_NAME } from "../../setup/src/mcpproxy/register"
import { compileArgs, SETUP_DIR } from "./stage-setup"

// C115 (N135-1, N135-2; 1.3.0 row 135a): the staged swarm-web-proxy is compiled with exactly stage-setup's arguments,
// then started (as opencode does) with a working folder that holds a bunfig.toml whose preload writes a marker file and
// a .env that points SWARM_VAULT_DIR elsewhere. Neither may take effect. Synthetic fixtures only; temp folders only.

let root = ""
let binary = ""

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "stage-autoload-"))
  binary = join(root, "bundle", PROXY_BINARY_NAME)
  mkdirSync(join(root, "bundle"))
  const built = spawnSync(
    process.execPath,
    compileArgs("src/mcpproxy/main.ts", binary, ["--define", `SWARM_PROXY_BUILD=${JSON.stringify("0.0.0+0000000000")}`]),
    { cwd: SETUP_DIR, encoding: "utf8" },
  )
  if (built.status !== 0) throw new Error(`compile exit ${built.status}: ${built.stderr.slice(0, 400)}`)
}, 180_000)

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test("the compiled proxy ignores a bunfig.toml preload and a .env in its working folder", async () => {
  const home = join(root, "home")
  const cwd = join(root, "project")
  const marker = join(root, "preload-ran.txt")
  const planted = join(root, "planted-vault")
  const inbox = join(home, ".swarm", "vault", "inbox")
  mkdirSync(home)
  mkdirSync(cwd)
  writeFileSync(join(cwd, "p.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "preload ran\\n")\n`)
  writeFileSync(join(cwd, "bunfig.toml"), `preload = ["./p.js"]\n`)
  writeFileSync(join(cwd, ".env"), `SWARM_VAULT_DIR=${planted}\n`)

  const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: root, SWARM_WEB_AUDIT_LOG: join(root, "audit.log") }
  const child = spawn(binary, [], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => (out += d))
  child.stderr.on("data", () => {})
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t135a", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "vault_inbox", arguments: { action: "write", name: "autoload-probe", content: "synthetic note m-syn135a" }, _meta: { agent: "t135a", session: "ses_t135a" } },
    },
  ]
  for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n")
  child.stdin.end()
  await new Promise((resolve) => child.on("close", resolve))

  const answers = new Map<number, any>()
  for (const line of out.split("\n").filter(Boolean)) {
    const message = JSON.parse(line)
    if (typeof message.id === "number") answers.set(message.id, message)
  }
  // The proxy started and answered initialize.
  expect(answers.get(1)?.result?.serverInfo?.name).toBe("swarm-web")
  // bunfig.toml: the preload never ran.
  expect(existsSync(marker)).toBe(false)
  // .env: the note did not go to the planted vault; with SWARM_VAULT_DIR unset it lands in the default vault.
  expect(answers.get(2)?.result?.isError).not.toBe(true)
  expect(existsSync(planted)).toBe(false)
  const text = String(answers.get(2)?.result?.content?.[0]?.text ?? "")
  expect(text).not.toContain(planted)
  expect(text).toContain("autoload-probe")
  expect(existsSync(inbox) ? readdirSync(inbox).length : 0).toBe(1)
}, 60_000)

test("both stage-setup compiles turn every runtime autoload off", () => {
  const args = compileArgs("src/index.ts", "/x/out")
  for (const flag of ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json"])
    expect(args).toContain(flag)
  expect(args.some((arg) => /^--compile-autoload-/.test(arg))).toBe(false)
})
