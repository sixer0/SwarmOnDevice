// Row 207d — `swarm --port/--hostname/--mdns` with no server password must EXIT non-zero with
// the refusal, not hang. Commit c301595b21 (row 207b) closed F-207-1 by making the TUI worker
// refuse to bind without a password, but the refusal answers nothing rather than throwing
// (util/rpc.ts has no error channel; a rejected worker message aborts bun test, exit 133 —
// rule E11) and a worker cannot end its parent, so the parent's `await client.call("server")`
// (tui.ts) hung forever: measured alive past 30 s with zero listeners bound (implementation/
// s6_r207b_worker_guard.md §2.3, verification/s6_r207c_f2071_recheck.md §8 row 2). The fix is a
// pre-flight in cli/cmd/tui.ts mirroring the sibling refusals (cmd/serve.ts:18, cmd/web.ts:42,
// cmd/acp.ts:32): same serverPasswordSet() predicate, same wording shape, exit 1.
//
// Why these tests bite: with the pre-flight removed, the refusal arms never exit — the child is
// killed at the deadline and the test fails with "HUNG" (proven by mutation, see the row's
// artifact). The armed arms prove the pre-flight does not over-refuse: the port really binds and
// answers 401 anonymously (E12: a guard that refuses must bind nothing; a guard that over-refuses
// breaks these). The plain no-flag arm proves the default in-process transport stays untouched.
//
// Env notes: the CLI entry must be spawned with cwd inside packages/opencode — bun's tsconfig
// (jsxImportSource @opentui/solid) is resolved from the cwd, and from an outside cwd the tui
// renderer import dies on "Cannot find module 'react/jsx-dev-runtime'" (measured). HOME/XDG are
// pinned to a scratch sandbox so nothing here can touch the real ~/.swarm (rules E7/E9). Loopback
// bypasses any ambient proxy (rule E6). Ports come from the 55xxx pool with a pre-bind probe (R3);
// 55401+ avoids the 55341-55399 slice worker-guard.test.ts uses. Password canaries are synthetic
// and never echoed (R4).
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

const packageRoot = path.join(import.meta.dir, "../../../") // packages/opencode
const cliEntry = path.join(packageRoot, "src/index.ts")

// Synthetic canary, never a real credential (R4).
const CANARY = "r207d-regression-canary-password"

// The exact sentence the pre-flight prints (via UI.error, which prefixes "Error: "), matching
// the sibling wording shape with "run tui again" — the worker guard's own sentence ends without
// a command name, so asserting this tail discriminates the pre-flight from the worker's stderr.
const REFUSAL_TAIL = "and run tui again."
const REFUSAL_HEAD = "No server password is set; refusing to start an unsecured server."

process.env.no_proxy = ["127.0.0.1", "localhost", "::1", process.env.no_proxy].filter(Boolean).join(",")

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-tui-preflight-"))
afterAll(() => fs.rmSync(sandboxHome, { recursive: true, force: true }))

async function freeProbePort(): Promise<number> {
  for (let port = 55401; port < 55461; port++) {
    try {
      const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("probe") })
      probe.stop(true)
      return port
    } catch {}
  }
  throw new Error("no free 55xxx probe port in 55401-55460")
}

type Arm = { opencode?: string; swarm?: string }

// Full child environment: passwords absent unless the arm sets them (absence by omission, never
// by a null override — rule E11), HOME/XDG pinned to the sandbox (E7/E9), background work off.
function childEnv(arm: Arm): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  delete env.SWARM_SERVER_PASSWORD
  delete env.OPENCODE_SERVER_PASSWORD
  env.HOME = sandboxHome
  env.OPENCODE_TEST_HOME = sandboxHome
  env.XDG_CONFIG_HOME = path.join(sandboxHome, ".config")
  env.XDG_DATA_HOME = path.join(sandboxHome, ".local/share")
  env.XDG_STATE_HOME = path.join(sandboxHome, ".local/state")
  env.XDG_CACHE_HOME = path.join(sandboxHome, ".cache")
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  env.OPENCODE_PURE = "1"
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  env.OPENCODE_DISABLE_AUTOCOMPACT = "1"
  env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  env.OPENCODE_AUTH_CONTENT = "{}"
  env.no_proxy = "127.0.0.1,localhost,::1"
  env.PWD = packageRoot
  if (arm.opencode !== undefined) env.OPENCODE_SERVER_PASSWORD = arm.opencode
  if (arm.swarm !== undefined) env.SWARM_SERVER_PASSWORD = arm.swarm
  return env
}

function spawnTui(args: string[], arm: Arm) {
  return Bun.spawn(["bun", "run", cliEntry, ...args], {
    cwd: packageRoot,
    env: childEnv(arm),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

// Waits for exit up to deadlineMs; on timeout kills the child and reports "HANG" so the caller
// fails loudly instead of blocking the suite forever.
async function waitExit(child: Bun.Subprocess, deadlineMs: number) {
  const hang = new Promise<"HANG">((resolve) => setTimeout(() => resolve("HANG"), deadlineMs))
  const outcome = await Promise.race([child.exited.then((code) => ({ code })), hang])
  if (outcome === "HANG") {
    child.kill(9)
    await child.exited
    return { hung: true as const, code: -1, stderr: await readStderr(child), stdout: "" }
  }
  return { hung: false as const, code: outcome.code, stderr: await readStderr(child), stdout: "" }
}

function readStderr(child: Bun.Subprocess): Promise<string> {
  // Bun.spawn was called with stderr:"pipe"; narrow for the type checker, not the runtime.
  if (child.stderr instanceof ReadableStream) return new Response(child.stderr).text()
  return Promise.resolve("")
}

// Listener count on a port, via /usr/sbin/lsof (the only lsof on this host — row 207c §2b;
// netstat was measured blind here and carries no weight).
function lsofPortCount(port: number): number {
  const r = Bun.spawnSync(["/usr/sbin/lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"])
  return Math.max(0, r.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length - 1)
}

function lsofPidListenerCount(pid: number): number {
  const r = Bun.spawnSync(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)])
  return Math.max(0, r.stdout.toString().split("\n").filter((line) => line.trim().length > 0).length - 1)
}

async function connectStatus(port: number): Promise<number | "REFUSED"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(1500) })
    await res.text().catch(() => {})
    return res.status
  } catch {
    return "REFUSED"
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("tui pre-flight: unsecured external mode exits instead of hanging", () => {
  // Each arm must exit non-zero with the sibling-shaped refusal, fast, and bind nothing (E12).
  const refusalArms: Array<[string, string[], Arm]> = [
    ["arm A: --port with neither password name set", ["--port"], {}],
    ['arm D: --port with OPENCODE_SERVER_PASSWORD="" (the c4 fail-open shape)', ["--port"], { opencode: "" }],
    ["--hostname with neither password name set", ["--hostname", "127.0.0.1"], {}],
    ["--mdns with neither password name set", ["--mdns"], {}],
  ]
  for (const [name, flagArgs, arm] of refusalArms) {
    test(
      name,
      async () => {
        const port = flagArgs[0] === "--port" ? await freeProbePort() : 0
        const args = port ? [...flagArgs, String(port)] : flagArgs
        const started = Date.now()
        const child = spawnTui(args, arm)
        const result = await waitExit(child, 30_000)
        expect(result.hung).toBe(false) // with the pre-flight removed this child never exits
        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain(REFUSAL_HEAD)
        expect(result.stderr).toContain(REFUSAL_TAIL) // the pre-flight's own print, not the worker's
        expect(Date.now() - started).toBeLessThan(30_000)
        if (port) expect(lsofPortCount(port)).toBe(0)
        expect(lsofPidListenerCount(child.pid)).toBe(0)
        if (port) expect(await connectStatus(port)).toBe("REFUSED")
      },
      60_000,
    )
  }

  // Armed controls: the same command with a password under either public name must proceed —
  // the port really binds and answers 401 anonymously. These fail if the pre-flight over-refuses.
  const armedArms: Array<[string, Arm]> = [
    ["OPENCODE_SERVER_PASSWORD set", { opencode: CANARY }],
    ["only SWARM_SERVER_PASSWORD set", { swarm: CANARY }],
  ]
  for (const [name, arm] of armedArms) {
    test(
      `--port proceeds when ${name}`,
      async () => {
        const port = await freeProbePort()
        const child = spawnTui(["--port", String(port)], arm)
        let bound = false
        const deadline = Date.now() + 45_000
        while (Date.now() < deadline && !bound) {
          const status = await connectStatus(port)
          if (status !== "REFUSED") {
            bound = true
            expect(status).toBe(401) // secured listener, not an anonymous door
          } else {
            const dead = await Promise.race([
              child.exited.then((code) => code),
              new Promise<-1>((resolve) => setTimeout(() => resolve(-1 as const), 400)),
            ])
            if (dead !== -1) {
              const stderr = await readStderr(child)
              throw new Error(`child exited ${dead} before binding; stderr tail: ${stderr.slice(-600)}`)
            }
          }
        }
        expect(bound).toBe(true)
        child.kill("SIGTERM")
        await child.exited
        // Teardown (E12 spirit): the refused/armed socket must not outlive the run.
        const releasedAt = Date.now() + 5_000
        while (lsofPortCount(port) > 0 && Date.now() < releasedAt) await sleep(200)
        expect(lsofPortCount(port)).toBe(0)
      },
      90_000,
    )
  }

  // Default transport stays untouched: bare `swarm` with no password reaches no socket and must
  // not print the refusal (the pre-flight is gated on external). Making the pre-flight
  // unconditional turns this red on the sentence assertion.
  test("plain tui with no flags does not refuse and binds nothing", async () => {
    const child = spawnTui([], {})
    const outcome = await waitExit(child, 15_000) // interactive TUI on non-TTY stdio may stay alive
    expect(outcome.stderr).not.toContain(REFUSAL_HEAD)
    expect(lsofPidListenerCount(child.pid)).toBe(0)
    if (!outcome.hung) {
      // If it did exit on its own (headless renderer limits), it must not have been the refusal.
      expect(outcome.stderr).not.toContain(REFUSAL_TAIL)
    }
    child.kill(9)
    await child.exited
    expect(lsofPidListenerCount(child.pid)).toBe(0)
  }, 60_000)
})
