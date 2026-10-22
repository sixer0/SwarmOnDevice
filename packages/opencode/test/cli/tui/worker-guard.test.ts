// Row 207b — the TUI worker's Server.listen must carry the same serverPasswordSet()
// refusal as its siblings serve.ts:18, web.ts:42 and acp.ts:32. Before this guard,
// worker.ts:56 was the only unguarded call site, and row 207 measured it answering
// GET /global/setup anonymously with 200 both when no password was set under either
// name (arm A) and when OPENCODE_SERVER_PASSWORD="" (arm D, the historical c4
// fail-open shape); arms B/C (password set under either name) answered 401 anon /
// 200 credentialed (verification/s6_06_security_preship.md §2.3). These tests drive
// the real worker over its Rpc port — the same `server` call tui.ts:279 makes — so
// removing the guard fails them loudly: arms A/D would resolve a live URL immediately.
// The guard refuses by answering nothing (util/rpc.ts has no error channel; a rejected
// worker message aborts the whole test process on bun 1.3.14, measured exit 133).
//
// Env note (measured on bun 1.3.14): the Worker `env` option coerces a null override
// into the STRING "null" — a non-empty password! Unsetting therefore happens by
// deleting from this process's env before construction; the worker snapshots env at
// spawn. Passing only string values in the option merges onto the inherited env.
import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

const workerPath = path.join(import.meta.dir, "../../../src/cli/tui/worker.ts")
const cliSourceRoot = path.join(import.meta.dir, "../../../src/cli")

// Synthetic canary, never a real credential (R4). The auth layer's default username
// is "opencode" (src/server/auth.ts:19,40).
const CANARY = "r207b-regression-canary-password"

// Loopback must bypass any ambient proxy: the shipped binary honours http_proxy for
// 127.0.0.1 (driver rule E6 / OBS-186a), and so does fetch here.
process.env.no_proxy = ["127.0.0.1", "localhost", "::1", process.env.no_proxy].filter(Boolean).join(",")

async function freeProbePort(): Promise<number> {
  for (let port = 55341; port < 55400; port++) {
    try {
      const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("probe") })
      probe.stop(true)
      return port
    } catch {}
  }
  throw new Error("no free 55xxx probe port in 55341-55399")
}

// Runs `fn` with both public password names removed from the parent env (restored
// after), so each arm controls the worker's view explicitly via the spawn env.
async function withPasswordsCleared<T>(fn: () => Promise<T>): Promise<T> {
  const savedSwarm = process.env.SWARM_SERVER_PASSWORD
  const savedOpencode = process.env.OPENCODE_SERVER_PASSWORD
  delete process.env.SWARM_SERVER_PASSWORD
  delete process.env.OPENCODE_SERVER_PASSWORD
  try {
    return await fn()
  } finally {
    if (savedSwarm !== undefined) process.env.SWARM_SERVER_PASSWORD = savedSwarm
    if (savedOpencode !== undefined) process.env.OPENCODE_SERVER_PASSWORD = savedOpencode
  }
}

function spawnWorker(env: Record<string, string>): Worker {
  return new Worker(new URL(`file://${workerPath}`).href, { env })
}

// Posts the same rpc.request tui.ts:279 posts and waits up to respondWindowMs for an
// answer. Resolves with the returned url, or undefined when the worker never answers
// (a refusal: util/rpc.ts has no error channel, so a thrown guard never resolves).
function requestServer(worker: Worker, port: number, respondWindowMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(undefined), respondWindowMs)
    worker.onmessage = (evt: MessageEvent) => {
      const parsed = JSON.parse(String(evt.data))
      if (parsed.type === "rpc.result" && parsed.id === 1) done(String(parsed.result.url))
    }
    worker.postMessage(
      JSON.stringify({ type: "rpc.request", method: "server", input: { port, hostname: "127.0.0.1" }, id: 1 }),
    )
  })
}

async function shutdownWorker(worker: Worker): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000)
    worker.onmessage = () => {
      clearTimeout(timer)
      resolve()
    }
    worker.postMessage(JSON.stringify({ type: "rpc.request", method: "shutdown", input: undefined, id: 2 }))
  })
  worker.terminate()
}

// Status of an anonymous GET /global/setup, or "REFUSED" when nothing is listening.
async function probeAnon(port: number): Promise<number | "REFUSED"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/setup`)
    await response.text()
    return response.status
  } catch {
    return "REFUSED"
  }
}

async function probeWithPassword(port: number): Promise<number> {
  const basic = "Basic " + Buffer.from(`opencode:${CANARY}`).toString("base64")
  const response = await fetch(`http://127.0.0.1:${port}/global/setup`, { headers: { Authorization: basic } })
  await response.text()
  return response.status
}

describe("tui worker unsecured-listener guard (F-207-1)", () => {
  // Arms A and D: the refusal side. The guard must keep the worker from ever binding:
  // no rpc answer within the window AND the requested port stays closed. With the
  // guard removed these resolve a live URL immediately (row 207 measured anon 200),
  // so the first expect fails loudly — not an assertion that passes on broken code.
  const refuseArms: Array<[string, Record<string, string>]> = [
    ["arm A: neither SWARM_SERVER_PASSWORD nor OPENCODE_SERVER_PASSWORD set", {}],
    ['arm D: OPENCODE_SERVER_PASSWORD="" (the c4 fail-open shape)', { OPENCODE_SERVER_PASSWORD: "" }],
  ]
  for (const [name, env] of refuseArms) {
    test(
      name,
      async () => {
        await withPasswordsCleared(async () => {
          const port = await freeProbePort()
          const worker = spawnWorker(env)
          const url = await requestServer(worker, port, 10_000)
          expect(url).toBeUndefined()
          expect(await probeAnon(port)).toBe("REFUSED")
          await shutdownWorker(worker)
        })
      },
      30_000,
    )
  }

  // Arms B and C: the working side, under each public name. C also pins the session-3
  // precedence fix: SWARM_SERVER_PASSWORD alone must satisfy the guard, and the alias
  // mirror (core/src/swarm-defaults.ts) must still hand the credential to the auth
  // layer so the credentialed read succeeds under the opencode username.
  const secureArms: Array<[string, Record<string, string>]> = [
    ["arm B: OPENCODE_SERVER_PASSWORD set", { OPENCODE_SERVER_PASSWORD: CANARY }],
    ["arm C: only SWARM_SERVER_PASSWORD set", { SWARM_SERVER_PASSWORD: CANARY }],
  ]
  for (const [name, env] of secureArms) {
    test(
      name,
      async () => {
        await withPasswordsCleared(async () => {
          const port = await freeProbePort()
          const worker = spawnWorker(env)
          const url = await requestServer(worker, port, 20_000)
          expect(url).toBeDefined()
          expect(new URL(url!).port).toBe(String(port))
          expect(await probeAnon(port)).toBe(401)
          expect(await probeWithPassword(port)).toBe(200)
          await shutdownWorker(worker)
        })
      },
      30_000,
    )
  }

  // Cross-site pin: every Server.listen call site under src/cli must carry the
  // serverPasswordSet() refusal in the same file, and the four known bring-up sites
  // must all still be there. A fifth site acquiring a listener without the guard
  // breaks the per-site expectation; moving or renaming one breaks the named set.
  // Comment lines are stripped first so prose mentions of Server.listen( do not count.
  test("all four guarded listen sites stay guarded (no fifth unguarded site)", () => {
    const stripComments = (source: string) =>
      source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n")
    const sites: string[] = []
    for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: cliSourceRoot })) {
      if (/Server\.listen\(/.test(stripComments(fs.readFileSync(path.join(cliSourceRoot, rel), "utf8")))) sites.push(rel)
    }
    expect(new Set(sites)).toEqual(new Set(["cmd/serve.ts", "cmd/web.ts", "cmd/acp.ts", "tui/worker.ts"]))
    for (const rel of sites) {
      expect(stripComments(fs.readFileSync(path.join(cliSourceRoot, rel), "utf8"))).toContain("serverPasswordSet()")
    }
  })
})
