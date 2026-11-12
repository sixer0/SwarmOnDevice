// TH-05 / SEC-18 (1.2.6 row 94): the FLUX adapter (spec 01c 4.6, 11.3, 11.4 case 4 and 12; decisions C5, U19, U21).
// Fake fetch, fake spawn (a recording fake launchctl), temp home. No network, no real launchctl. Red class B at e363918a69.
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  changedWatchedFiles,
  FLUX_COMPONENT_ID,
  FLUX_HEALTH_URL,
  FLUX_LAUNCHD_LABEL,
  fluxKickstartArgv,
  fluxSubmitArgv,
  fluxToolHealthEntry,
  hashWatchedFile,
  LAUNCHCTL_PATH,
  withFluxEntry,
} from "./flux"
import { runProbe } from "./probe"
import { createToolHealth, type ToolHealthDeps } from "./startup"
import { readToolHealthState, toolHealthDir } from "./state"
import { loadUserRegistry, userRegistryPath } from "./user-registry"

const dirs: string[] = []
function tmp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const UID = 501
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** A FLUX work dir with a venv python file and server.py; `python: false` leaves the venv out. */
function workDir(opts: { python?: boolean; server?: string } = {}) {
  const w = tmp("th-flux-w-")
  if (opts.python !== false) {
    mkdirSync(join(w, ".venv", "bin"), { recursive: true })
    writeFileSync(join(w, ".venv", "bin", "python"), "")
  }
  writeFileSync(join(w, "server.py"), opts.server ?? "app = 1\n")
  return w
}

function writeUserFile(home: string, body: unknown) {
  const file = userRegistryPath(home)
  mkdirSync(join(home, ".config", "swarm"), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(body, null, 2))
  chmodSync(file, 0o600)
}

function seedHealthy(home: string, id: string) {
  mkdirSync(toolHealthDir(home), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(toolHealthDir(home), "state.json"),
    JSON.stringify({
      version: 1,
      updatedAt: 1,
      appVersion: "x",
      components: { [id]: { lastStatus: "healthy", reason: "OK", detail: "", lastCheckedAt: 1, lastHealthyAt: 1, source: "user" } },
    }),
  )
}

type Call = { cmd: string; args: string[]; opts: Record<string, unknown> }
/** Recording fake launchctl: exit codes are taken in order (kickstart, then submit). */
function fakeLaunchctl(codes: number[]) {
  const calls: Call[] = []
  const spawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts })
    const code = codes[calls.length - 1] ?? 0
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => undefined
    setTimeout(() => {
      if (code !== 0) child.stderr.emit("data", Buffer.from(`Could not find service "${FLUX_LAUNCHD_LABEL}" in domain\n`))
      child.emit("close", code)
    }, 1)
    return child
  }) as never
  return { calls, spawn }
}

/** FLUX /health fake: down (connection refused) until `up()` is called, then 200 with weights_downloaded. */
function fakeFlux() {
  let alive = false
  const urls: string[] = []
  const inits: RequestInit[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    urls.push(String(url))
    inits.push(init)
    if (!String(url).startsWith(FLUX_HEALTH_URL)) throw new Error("ECONNREFUSED")
    if (!alive) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7863"), { code: "ECONNREFUSED" })
    return new Response(JSON.stringify({ model: "flux3-image-klein", weights_downloaded: true, model_loaded: false }), { status: 200 })
  }) as unknown as typeof fetch
  return { fetch: fetchFn, urls, inits, up: () => void (alive = true) }
}

type LogLine = { level: string; message: string; context?: Record<string, unknown> }
function deps(home: string, over: Partial<ToolHealthDeps> = {}): ToolHealthDeps & { lines: LogLine[] } {
  const lines: LogLine[] = []
  return {
    home,
    platform: "darwin",
    isPackaged: true,
    resourcesPath: join(home, "res"),
    appPath: join(home, "app"),
    log: (level, message, context) => void lines.push({ level, message, context }),
    defer: async () => undefined,
    // The revive budget race (reviveTimeoutMs) gets 500 ms of real time; the 2 s re-probe polls take 1 ms.
    sleep: (ms) => new Promise((r) => setTimeout(r, ms >= 30000 ? 500 : Math.min(ms, 1))),
    watch: () => ({ close: () => undefined, on: () => undefined as never }),
    env: { HOME: home, PATH: "/should/not/pass", SECRET_X: "nope" },
    lines,
    ...over,
  }
}

const fluxResult = (th: ReturnType<typeof createToolHealth>) => th.lastResults().find((r) => r.id === FLUX_COMPONENT_ID)
const launchctlCalls = (calls: Call[]) => calls.filter((c) => c.cmd === LAUNCHCTL_PATH)

describe("TH-05 FLUX entry (01c 4.6)", () => {
  test("the entry has the 4.6 shape, built from the given work dir and uid only", () => {
    const w = "/opt/flux-work"
    const entry = fluxToolHealthEntry({ workDir: w, uid: UID, serverSha256: "a".repeat(64) })
    expect(entry.probe).toEqual({
      kind: "http",
      url: "http://127.0.0.1:7863/health",
      expectStatus: 200,
      expectJson: { weights_downloaded: true },
      timeoutMs: 3000,
    })
    expect(entry.revive).toEqual({
      argv: ["/bin/launchctl", "kickstart", "gui/501/local.flux3-image-klein"],
      fallbackArgv: [
        "/bin/launchctl", "submit", "-l", "local.flux3-image-klein",
        "-o", `${w}/service.log`, "-e", `${w}/service-error.log`, "--",
        `${w}/.venv/bin/python`, "-m", "uvicorn", "--app-dir", w, "server:app", "--host", "127.0.0.1", "--port", "7863",
      ],
    })
    expect(entry.installedWhen).toEqual({ path: `${w}/.venv/bin/python` })
    expect(entry.reviveTimeoutMs).toBe(30000)
    expect(entry.startup).toBe("probe")
    expect(entry.consent).toBe("auto")
    expect(entry.watch).toEqual([{ path: `${w}/server.py`, sha256: "a".repeat(64) }])
    expect(() => fluxToolHealthEntry({ workDir: "relative/w", uid: UID })).toThrow()
    expect(() => fluxToolHealthEntry({ workDir: w, uid: UID, serverSha256: "xyz" })).toThrow()
  })

  test("the adapter source holds no machine path (C5: FLUX is never shipped)", () => {
    const src = readFileSync(join(import.meta.dir, "flux.ts"), "utf8")
    expect(src).not.toContain("/Users/")
    expect(src).not.toContain("Default Project")
    expect(src).not.toContain("2026-11-10_flux3")
  })

  test("the written user file passes the user-registry loader as a user component, other entries kept", () => {
    const home = tmp("th-flux-h-")
    const w = workDir()
    const graphviz = { label: "Graphviz dot", probe: { kind: "file", path: "/opt/homebrew/bin/dot" }, startup: "probe", consent: "manual" }
    writeUserFile(home, withFluxEntry({ components: { graphviz } }, { workDir: w, uid: UID, serverSha256: sha("app = 1\n") }))
    const loaded = loadUserRegistry({ home })
    expect(loaded.issues).toEqual([])
    const flux = loaded.components.find((c) => c.id === FLUX_COMPONENT_ID)
    expect(flux?.revive).toEqual({ argv: fluxKickstartArgv(UID), fallbackArgv: fluxSubmitArgv(w) })
    expect(flux?.watch?.[0]?.path).toBe(join(w, "server.py"))
    expect(loaded.components.map((c) => c.id).sort()).toEqual(["flux3", "graphviz"])
    expect(() => withFluxEntry([], { workDir: w, uid: UID })).toThrow()
  })
})

describe("TH-05 regime case 4: FLUX absent degrades with no launchctl call (01c 11.4)", () => {
  test("no tool-health.json: no flux3 component, no launchctl call, no error", async () => {
    const home = tmp("th-flux-h-")
    const l = fakeLaunchctl([0])
    const f = fakeFlux()
    const d = deps(home, { spawn: l.spawn, fetch: f.fetch })
    const th = createToolHealth(d)
    await th.runStartup()
    th.stop()
    expect(fluxResult(th)).toBeUndefined()
    expect(launchctlCalls(l.calls)).toEqual([])
    expect(f.urls.filter((u) => u.startsWith(FLUX_HEALTH_URL))).toEqual([])
    expect(d.lines.filter((x) => x.level === "error")).toEqual([])
  })

  test("entry present but venv python missing: skipped_not_installed, no probe, no launchctl call, no error", async () => {
    const home = tmp("th-flux-h-")
    const w = workDir({ python: false })
    writeUserFile(home, withFluxEntry(undefined, { workDir: w, uid: UID, serverSha256: sha("app = 1\n") }))
    seedHealthy(home, FLUX_COMPONENT_ID)
    const l = fakeLaunchctl([0])
    const f = fakeFlux()
    const d = deps(home, { spawn: l.spawn, fetch: f.fetch })
    const th = createToolHealth(d)
    await th.runStartup()
    th.stop()
    expect(fluxResult(th)?.status).toBe("skipped_not_installed")
    expect(fluxResult(th)?.reason).toBe("NOT_INSTALLED")
    expect(launchctlCalls(l.calls)).toEqual([])
    expect(f.urls.filter((u) => u.startsWith(FLUX_HEALTH_URL))).toEqual([])
    expect(d.lines.filter((x) => x.level === "error")).toEqual([])
    expect(readToolHealthState(home).state.components.flux3?.lastStatus).toBe("skipped_not_installed")
  })
})

describe("TH-05 stub revive: kickstart, then submit (01c 4.6, 3.3)", () => {
  test("kickstart fails (label gone) -> submit runs once -> /health 200 weights_downloaded -> revived", async () => {
    const home = tmp("th-flux-h-")
    const w = workDir()
    writeUserFile(home, withFluxEntry(undefined, { workDir: w, uid: UID, serverSha256: sha("app = 1\n") }))
    seedHealthy(home, FLUX_COMPONENT_ID)
    const f = fakeFlux()
    const l = fakeLaunchctl([113, 0])
    const spawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      const child = (l.spawn as unknown as (...a: unknown[]) => EventEmitter)(cmd, args, opts)
      if (args[0] === "submit") f.up()
      return child
    }) as never
    const d = deps(home, { spawn, fetch: f.fetch })
    const th = createToolHealth(d)
    await th.runStartup()
    th.stop()
    expect(fluxResult(th)?.status).toBe("revived")
    expect(fluxResult(th)?.reason).toBe("REVIVED")
    expect(launchctlCalls(l.calls).map((c) => [c.cmd, ...c.args])).toEqual([fluxKickstartArgv(UID), fluxSubmitArgv(w)])
    for (const c of l.calls) {
      expect(c.opts.shell).toBe(false)
      expect(c.opts.cwd).toBe(home)
      expect((c.opts.env as Record<string, string>).PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin")
      expect((c.opts.env as Record<string, string>).SECRET_X).toBeUndefined()
    }
    // The probe never sets Host itself (FLUX refuses any Host but 127.0.0.1:7863 / localhost:7863).
    for (const init of f.inits) expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/host/i)
    expect(readToolHealthState(home).state.components.flux3?.lastStatus).toBe("revived")
  })

  test("kickstart succeeds (job loaded, process died) -> submit never runs", async () => {
    const home = tmp("th-flux-h-")
    const w = workDir()
    writeUserFile(home, withFluxEntry(undefined, { workDir: w, uid: UID }))
    seedHealthy(home, FLUX_COMPONENT_ID)
    const f = fakeFlux()
    const l = fakeLaunchctl([0])
    const spawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      const child = (l.spawn as unknown as (...a: unknown[]) => EventEmitter)(cmd, args, opts)
      f.up()
      return child
    }) as never
    const th = createToolHealth(deps(home, { spawn, fetch: f.fetch }))
    await th.runStartup()
    th.stop()
    expect(fluxResult(th)?.status).toBe("revived")
    expect(launchctlCalls(l.calls).map((c) => c.args[0])).toEqual(["kickstart"])
  })

  test("both launchctl steps fail -> revive_failed REVIVE_EXIT, nothing else runs", async () => {
    const home = tmp("th-flux-h-")
    const w = workDir()
    writeUserFile(home, withFluxEntry(undefined, { workDir: w, uid: UID }))
    seedHealthy(home, FLUX_COMPONENT_ID)
    const l = fakeLaunchctl([113, 5])
    const th = createToolHealth(deps(home, { spawn: l.spawn, fetch: fakeFlux().fetch }))
    await th.runStartup()
    th.stop()
    expect(fluxResult(th)?.status).toBe("revive_failed")
    expect(fluxResult(th)?.reason).toBe("REVIVE_EXIT")
    expect(launchctlCalls(l.calls).map((c) => c.args[0])).toEqual(["kickstart", "submit"])
  })

  test("FLUX probe reasons: 403 -> HTTP_HOST_REFUSED, weights_downloaded false -> HTTP_BODY_MISMATCH, 503 -> HTTP_STATUS", async () => {
    const probe = fluxToolHealthEntry({ workDir: "/opt/w", uid: UID }).probe
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    expect((await runProbe(probe, { fetch: answer(403, {}) })).reason).toBe("HTTP_HOST_REFUSED")
    expect((await runProbe(probe, { fetch: answer(200, { weights_downloaded: false, model_loaded: false }) })).reason).toBe("HTTP_BODY_MISMATCH")
    expect((await runProbe(probe, { fetch: answer(503, { detail: "weights missing" }) })).reason).toBe("HTTP_STATUS")
    const ok = await runProbe(probe, { fetch: answer(200, { weights_downloaded: true, model_loaded: false }) })
    expect(ok.healthy).toBe(true)
  })
})

describe("SEC-18 watched server.py (U21: warn, never block)", () => {
  async function reviveWith(serverNow: string, recorded: string) {
    const home = tmp("th-flux-h-")
    const w = workDir({ server: serverNow })
    writeUserFile(home, withFluxEntry(undefined, { workDir: w, uid: UID, serverSha256: sha(recorded) }))
    seedHealthy(home, FLUX_COMPONENT_ID)
    const f = fakeFlux()
    const l = fakeLaunchctl([0])
    const spawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      const child = (l.spawn as unknown as (...a: unknown[]) => EventEmitter)(cmd, args, opts)
      f.up()
      return child
    }) as never
    const d = deps(home, { spawn, fetch: f.fetch })
    const th = createToolHealth(d)
    await th.runStartup()
    th.stop()
    const warnings = d.lines.filter((x) => x.message.includes("WATCHED_FILE_CHANGED"))
    return { th, l, warnings, w }
  }

  test("a changed server.py hash writes one WATCHED_FILE_CHANGED warning and the revive still runs", async () => {
    const { th, l, warnings, w } = await reviveWith("app = 2  # edited\n", "app = 1\n")
    expect(warnings.length).toBe(1)
    expect(warnings[0]!.level).toBe("warn")
    expect(warnings[0]!.context?.reason).toBe("WATCHED_FILE_CHANGED")
    expect(warnings[0]!.message).toContain(join(w, "server.py"))
    expect(launchctlCalls(l.calls).length).toBe(1)
    expect(fluxResult(th)?.status).toBe("revived")
  })

  test("an unchanged server.py writes no warning", async () => {
    const { warnings, l } = await reviveWith("app = 1\n", "app = 1\n")
    expect(warnings).toEqual([])
    expect(launchctlCalls(l.calls).length).toBe(1)
  })

  test("a missing or symlinked watched file counts as changed; a healthy probe never hashes", () => {
    const w = workDir()
    const file = join(w, "server.py")
    expect(hashWatchedFile(file)).toBe(sha("app = 1\n"))
    expect(changedWatchedFiles([{ path: file, sha256: sha("app = 1\n") }])).toEqual([])
    expect(changedWatchedFiles([{ path: join(w, "gone.py"), sha256: sha("x") }])[0]?.actual).toBe("missing")
    let hashed = 0
    changedWatchedFiles(undefined, () => (hashed++, undefined))
    expect(hashed).toBe(0)
  })
})
