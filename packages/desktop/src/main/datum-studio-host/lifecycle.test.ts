// Row 111 verification: the host lifecycle against a real separate host process (test/datum-studio-host/child-host.ts,
// real store lock + SQLite through the row 109 store bridge). Fixture HOME/XDG/state under /private/tmp/claude-501/row111/.
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { STUDIO_DESCRIPTOR_FILE, studioDescriptorPath } from "./descriptor"
import { studioStoreRoot, type StudioLayout } from "./layout"
import { startStudioHost, StudioHostError, type ForkHost, type HostChild, type StudioHostStartOptions } from "./lifecycle"
import { STUDIO_RELEASE } from "./protocol"

const SCRATCH = "/private/tmp/claude-501/row111"
mkdirSync(SCRATCH, { recursive: true })
const BASE = mkdtempSync(join(SCRATCH, "lifecycle-"))
const CHILD = join(import.meta.dir, "..", "..", "..", "test", "datum-studio-host", "child-host.ts")
const BUN = process.execPath

type Spawned = { child: ChildProcess; options: Parameters<ForkHost>[2] }
const spawned: Spawned[] = []

afterAll(() => {
  for (const s of spawned) if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill("SIGKILL")
})

/** ForkHost over node child_process + IPC, shaped like Electron's UtilityProcess. `cwdOverride` fakes an M4 break. */
function bunFork(cwdOverride?: string): ForkHost {
  return (modulePath, args, options) => {
    const child = spawn(BUN, [modulePath, ...args], {
      cwd: cwdOverride ?? options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    spawned.push({ child, options })
    const exitWrappers = new Map<(code: number) => void, (code: number | null) => void>()
    const host: HostChild = {
      get pid() {
        return child.pid
      },
      postMessage: (message) => void child.send(message),
      on: (event: "message" | "exit", listener: (value: never) => void) => {
        if (event === "message") return child.on("message", listener as (m: unknown) => void)
        const wrapped = (code: number | null) => (listener as (c: number) => void)(code ?? -1)
        exitWrappers.set(listener as (c: number) => void, wrapped)
        return child.on("exit", wrapped)
      },
      off: (event: "message" | "exit", listener: (value: never) => void) => {
        if (event === "message") return child.off("message", listener as (m: unknown) => void)
        const wrapped = exitWrappers.get(listener as (c: number) => void)
        if (wrapped) child.off("exit", wrapped)
        return child
      },
      kill: () => child.kill(),
      stdout: child.stdout,
      stderr: child.stderr,
    }
    return host
  }
}

function fixture(name: string) {
  const root = mkdtempSync(join(BASE, `${name}-`))
  const home = join(root, "home")
  const res = join(root, "Swarm.app", "Contents", "Resources")
  const studio = join(res, "datum-studio")
  for (const dir of [home, join(studio, "assets"), join(studio, "templates"), join(root, "state")]) mkdirSync(dir, { recursive: true })
  const env = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: join(root, "tmp"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(root, "state"),
    FIXTURE_SECRET: "must-not-reach-the-host",
  }
  mkdirSync(env.TMPDIR, { recursive: true })
  const layout: StudioLayout = {
    root: studio,
    assetsRoot: join(studio, "assets"),
    templatesDir: join(studio, "templates"),
    vendorRoot: studio,
    assetRepoRoot: studio,
    kind: "packaged",
  }
  const logs: { level: string; source: string; message: string; context?: Record<string, unknown> }[] = []
  const options = (over: Partial<StudioHostStartOptions> = {}): StudioHostStartOptions => ({
    fork: bunFork(),
    entryPath: CHILD,
    layout,
    storeRoot: studioStoreRoot(env, home),
    descriptorPath: studioDescriptorPath(env.XDG_STATE_HOME),
    mainPid: process.pid,
    home,
    resourcesPath: res,
    baseEnv: env,
    renderEnv: { DATUM_RENDER_SOCKET: join(root, "tmp", "render.sock"), DATUM_RENDER_TOKEN: "f".repeat(64) },
    log: (level, source, message, context) => logs.push({ level, source, message, context }),
    readyTimeoutMs: 20_000,
    stopTimeoutMs: 5_000,
    ...over,
  })
  return { root, home, res, studio, env, layout, logs, options, storeRoot: studioStoreRoot(env, home), descriptor: studioDescriptorPath(env.XDG_STATE_HOME) }
}

const lockOf = (storeRoot: string) => join(storeRoot, "datum-studio.lock")
const readLock = (storeRoot: string) => JSON.parse(readFileSync(lockOf(storeRoot), "utf8")) as { pid: number; startedAt: number; release: string }
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)
const parseEnvFile = (path: string) =>
  Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  return check()
}

describe("datum-studio-host lifecycle (row 111)", () => {
  test("starts the host in Res/datum-studio with the bridge and studio env, writes a 0600 descriptor, removes it and the lock on stop", async () => {
    const fx = fixture("start")
    const host = await startStudioHost(fx.options())
    const run = spawned.at(-1)!

    // M4: fork cwd and the real process cwd are Res/datum-studio/.
    expect(run.options.cwd).toBe(fx.studio)
    expect(realpathSync(run.options.cwd)).toBe(realpathSync(fx.studio))
    // Env: render bridge + STUDIO_* in; the shell secret and the endpoint token out.
    expect(run.options.env.DATUM_RENDER_SOCKET).toBe(join(fx.root, "tmp", "render.sock"))
    expect(run.options.env.DATUM_RENDER_TOKEN).toBe("f".repeat(64))
    expect(run.options.env.STUDIO_ASSETS_ROOT).toBe(fx.layout.assetsRoot)
    expect(run.options.env.STUDIO_WORKSPACE_ROOT).toBe(fx.storeRoot)
    expect(run.options.env.STUDIO_VENDOR_ROOT).toBe(fx.studio)
    expect(run.options.env.FIXTURE_SECRET).toBeUndefined()
    expect(run.options.serviceName).toBe("datum-studio-host")

    const serverLog = fx.logs.find((l) => l.source === "fixture.server")!
    expect(serverLog.context).toMatchObject({ tokenHexLength: 64, hostname: "127.0.0.1" })
    expect((serverLog.context as { env: Record<string, unknown> }).env).toEqual({
      DATUM_RENDER_SOCKET: join(fx.root, "tmp", "render.sock"),
      DATUM_RENDER_TOKEN_SET: true,
      STUDIO_ASSETS_ROOT: fx.layout.assetsRoot,
      STUDIO_WORKSPACE_ROOT: fx.storeRoot,
      STUDIO_VENDOR_ROOT: fx.studio,
      FIXTURE_SECRET: null,
    })
    expect(fx.logs.find((l) => l.source === "fixture.templates")?.context).toEqual({
      templatesDir: fx.layout.templatesDir,
      assetRepoRoot: fx.studio,
      release: STUDIO_RELEASE,
    })

    // Descriptor: <stateHome>/swarm/datum-studio.env, 0600, URL/TOKEN/PID (main PID), token never in env or logs.
    expect(fx.descriptor).toBe(join(fx.env.XDG_STATE_HOME, "swarm", STUDIO_DESCRIPTOR_FILE))
    expect(mode(fx.descriptor)).toBe("600")
    const desc = parseEnvFile(fx.descriptor)
    expect(Object.keys(desc)).toEqual(["URL", "TOKEN", "PID"])
    expect(desc.URL).toBe(host.url)
    expect(desc.TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(desc.PID).toBe(String(process.pid))
    expect(Object.values(run.options.env)).not.toContain(desc.TOKEN)
    expect(JSON.stringify(fx.logs)).not.toContain(desc.TOKEN)

    // Store lock held by the host process; the store exists.
    expect(host.hostPid).toBe(run.child.pid!)
    expect(readLock(fx.storeRoot)).toMatchObject({ pid: host.hostPid, release: STUDIO_RELEASE })
    expect(mode(lockOf(fx.storeRoot))).toBe("600")
    expect(existsSync(join(fx.storeRoot, "datum-studio.sqlite"))).toBe(true)

    await host.stop()
    expect(existsSync(fx.descriptor)).toBe(false)
    expect(existsSync(lockOf(fx.storeRoot))).toBe(false)
    expect(await waitFor(() => !isRunning(host.hostPid))).toBe(true)
    expect(host.running).toBe(false)
  }, 30_000)

  test("a second host on the same store refuses with STORE_LOCKED and leaves the first host's lock and descriptor", async () => {
    const fx = fixture("second")
    const first = await startStudioHost(fx.options())
    const descBefore = readFileSync(fx.descriptor, "utf8")
    const lockBefore = readFileSync(lockOf(fx.storeRoot), "utf8")

    const error = await startStudioHost(fx.options()).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(StudioHostError)
    expect((error as StudioHostError).code).toBe("STORE_LOCKED")
    expect((error as StudioHostError).details).toMatchObject({ pid: first.hostPid })
    const second = spawned.at(-1)!.child
    expect(await waitFor(() => second.exitCode !== null || second.signalCode !== null)).toBe(true)

    expect(readFileSync(fx.descriptor, "utf8")).toBe(descBefore)
    expect(readFileSync(lockOf(fx.storeRoot), "utf8")).toBe(lockBefore)
    expect(readdirSync(fx.storeRoot).filter((f) => f.includes(".stale-"))).toEqual([])
    await first.stop()
    expect(existsSync(lockOf(fx.storeRoot))).toBe(false)
  }, 30_000)

  test("a stale lock (dead PID) is moved aside, never deleted, and the host starts", async () => {
    const fx = fixture("stale")
    const dead = spawnSync(BUN, ["-e", "0"], { env: { PATH: process.env.PATH ?? "" } })
    expect(dead.pid).toBeGreaterThan(0)
    expect(isRunning(dead.pid!)).toBe(false)
    mkdirSync(fx.storeRoot, { recursive: true, mode: 0o700 })
    const staleBytes = JSON.stringify({ pid: dead.pid, startedAt: 1, release: "1.2.0" })
    writeFileSync(lockOf(fx.storeRoot), staleBytes, { mode: 0o600 })

    const host = await startStudioHost(fx.options())
    const moved = readdirSync(fx.storeRoot).filter((f) => f.startsWith("datum-studio.lock.stale-"))
    expect(moved.length).toBe(1)
    expect(readFileSync(join(fx.storeRoot, moved[0]!), "utf8")).toBe(staleBytes)
    expect(readLock(fx.storeRoot).pid).toBe(host.hostPid)

    await host.stop()
    expect(existsSync(lockOf(fx.storeRoot))).toBe(false)
    expect(readFileSync(join(fx.storeRoot, moved[0]!), "utf8")).toBe(staleBytes)
  }, 30_000)

  test("a host killed after ready: descriptor removed at once; its lock is stale and moved aside by the next start", async () => {
    const fx = fixture("crash")
    let unexpected: number | undefined
    const host = await startStudioHost(fx.options({ onUnexpectedExit: (code) => (unexpected = code) }))
    const run = spawned.at(-1)!.child
    run.kill("SIGKILL")
    expect(await waitFor(() => !existsSync(fx.descriptor))).toBe(true)
    expect(unexpected).toBe(-1)
    expect(fx.logs.some((l) => l.level === "error" && l.message === "datum-studio-host exited unexpectedly")).toBe(true)
    expect(readLock(fx.storeRoot).pid).toBe(host.hostPid)

    const next = await startStudioHost(fx.options())
    expect(readdirSync(fx.storeRoot).filter((f) => f.startsWith("datum-studio.lock.stale-")).length).toBe(1)
    expect(readLock(fx.storeRoot).pid).toBe(next.hostPid)
    await next.stop()
  }, 30_000)

  test("M4: a host whose real cwd is not Res/datum-studio is stopped and no descriptor is written", async () => {
    const fx = fixture("cwd")
    const error = await startStudioHost(fx.options({ fork: bunFork(fx.home) })).then(
      () => null,
      (e: unknown) => e,
    )
    expect((error as StudioHostError).code).toBe("HOST_CWD_MISMATCH")
    expect(existsSync(fx.descriptor)).toBe(false)
    const child = spawned.at(-1)!.child
    expect(await waitFor(() => child.exitCode !== null || child.signalCode !== null)).toBe(true)
    expect(existsSync(lockOf(fx.storeRoot))).toBe(false)
  }, 30_000)

  test("refused store roots and a missing layout never fork", async () => {
    const fx = fixture("refuse")
    let forks = 0
    const counting: ForkHost = (...args) => {
      forks++
      return bunFork()(...args)
    }
    const cases: [Partial<StudioHostStartOptions>, string][] = [
      [{ storeRoot: fx.home }, "STUDIO_ROOT_FORBIDDEN"],
      [{ storeRoot: "/" }, "STUDIO_ROOT_FORBIDDEN"],
      [{ storeRoot: "relative/store" }, "STUDIO_ROOT_FORBIDDEN"],
      [{ storeRoot: join(fx.res, "store") }, "STUDIO_ROOT_FORBIDDEN"],
      [{ storeRoot: join(fx.root, "Swarm.app", "Contents", "store") }, "STUDIO_ROOT_FORBIDDEN"],
      [{ storeRoot: join(fx.studio, "store") }, "STUDIO_ROOT_FORBIDDEN"],
      [{ layout: { ...fx.layout, templatesDir: join(fx.studio, "missing") } }, "LAYOUT_MISSING"],
    ]
    for (const [over, code] of cases) {
      const error = await startStudioHost(fx.options({ fork: counting, ...over })).then(
        () => null,
        (e: unknown) => e,
      )
      expect([over, (error as { code?: string })?.code]).toEqual([over, code])
    }
    expect(forks).toBe(0)
  })

  test("an abort during start stops the child without waiting for the ready timeout", async () => {
    const fx = fixture("abort")
    const posted: unknown[] = []
    const exitListeners = new Set<(code: number) => void>()
    const silent: ForkHost = () => ({
      pid: 4242,
      postMessage: (m) => {
        posted.push(m)
        if ((m as { type: string }).type === "stop") setTimeout(() => [...exitListeners].forEach((l) => l(0)), 10)
      },
      on: (event: string, listener: (value: never) => void) => {
        if (event === "exit") exitListeners.add(listener as (code: number) => void)
        return undefined
      },
      off: (event: string, listener: (value: never) => void) => {
        if (event === "exit") exitListeners.delete(listener as (code: number) => void)
        return undefined
      },
      kill: () => true,
    })
    const abort = new AbortController()
    const started = Date.now()
    const pending = startStudioHost(fx.options({ fork: silent, signal: abort.signal, readyTimeoutMs: 60_000 })).then(
      () => null,
      (e: unknown) => e,
    )
    setTimeout(() => abort.abort(), 50)
    const error = await pending
    expect((error as StudioHostError).code).toBe("HOST_START_ABORTED")
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(posted.map((m) => (m as { type: string }).type)).toEqual(["start", "stop"])
    expect(existsSync(fx.descriptor)).toBe(false)
  })
})
