import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import {
  SETUP_COMPONENT_IDS,
  SETUP_ENV_ALLOW,
  SETUP_START_IDS,
  SETUP_OUTPUT_MAX_BYTES,
  SETUP_STATE_MAX_BYTES,
  SETUP_STATE_VALUES,
  createSetupRunner,
  installArgs,
  lockSha12,
  parseSetupOutput,
  readHealthySetupComponents,
  readSetupComponentStates,
  resolveSetupHome,
  setupChildEnv,
  setupDir,
  startArgs,
  supportsAppConsentMode,
  supportsStartVerb,
  tickedIds,
} from "./setup-runner"

const LOCK = new TextEncoder().encode('{"version":"fixture"}\n')
const SHA12 = lockSha12(LOCK)
const HELP = "Flags:\n  --non-interactive   MDM mode\n"
const HELP_APP = HELP + "  --consent-mode app  record consent.log mode app\n"

type Call = { binary: string; args: string[]; options: Record<string, unknown> }

function quietLogger() {
  const entries: { level: string; message: string; meta?: Record<string, unknown> }[] = []
  return {
    entries,
    log: (message: string, meta?: Record<string, unknown>) => entries.push({ level: "log", message, meta }),
    error: (message: string, meta?: Record<string, unknown>) => entries.push({ level: "error", message, meta }),
  }
}

// Each spawn answers from the queue: `--help` gets help text, anything else the next scripted reply.
function fakeSpawn(replies: { stdout?: string; stderr?: string; code?: number; error?: Error }[], help = HELP) {
  const calls: Call[] = []
  const spawn = ((binary: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ binary, args, options })
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const reply = args[0] === "--help" ? { stdout: help, code: 0 } : (replies.shift() ?? { code: 0 })
    setTimeout(() => {
      if ("error" in reply && reply.error) return child.emit("error", reply.error)
      if (reply.stdout) child.stdout.write(Buffer.from(reply.stdout))
      if ("stderr" in reply && reply.stderr) child.stderr.write(Buffer.from(reply.stderr))
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => child.emit("close", reply.code ?? 0, null), 5)
    }, 5)
    return child
  }) as unknown as typeof import("node:child_process").spawn
  return { spawn, calls }
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "setup-runner-"))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function runner(spawn: ReturnType<typeof fakeSpawn>, extra: Partial<Parameters<typeof createSetupRunner>[0]> = {}) {
  const logger = quietLogger()
  return {
    logger,
    runner: createSetupRunner({
      dir: "/bundle/swarm-setup",
      logger,
      env: { PATH: "/usr/bin:/bin" },
      accountHome: home,
      getuid: () => 501,
      spawn: spawn.spawn,
      readLock: () => LOCK,
      pollMs: 5,
      ...extra,
    }),
  }
}

function writeState(components: Record<string, unknown>) {
  mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
  writeFileSync(join(home, ".swarm", "setup", "state.json"), JSON.stringify({ version: 1, components }))
}

describe("ticked ids to flags", () => {
  test("a token exists only for each ticked id, in register order", () => {
    const selection = tickedIds(["rtk", "node", "rtk"])
    expect(selection).toEqual({ ok: true, ids: ["node", "rtk"] })
    const args = installArgs(["node", "rtk"], SHA12, false)
    expect(args).toEqual([
      "install",
      "node",
      "rtk",
      "--non-interactive",
      "--terms-token",
      `node=node@${SHA12}`,
      "--terms-token",
      `rtk=rtk@${SHA12}`,
    ])
    const tokens = args.filter((_, i) => args[i - 1] === "--terms-token").map((t) => t.split("=")[0])
    expect(tokens).toEqual(["node", "rtk"])
    for (const id of SETUP_COMPONENT_IDS.filter((id) => id !== "node" && id !== "rtk"))
      expect(args.some((a) => a.includes(id))).toBe(false)
  })

  test("the token hash is sha256 of the lock bytes, first 12 hex", () => {
    const expected = new Bun.CryptoHasher("sha256").update(LOCK).digest("hex").slice(0, 12)
    expect(SHA12).toBe(expected)
    expect(SHA12).toMatch(/^[0-9a-f]{12}$/)
  })

  test("one id outside the register refuses the whole request", () => {
    expect(tickedIds(["node", "all"])).toEqual({ ok: false, unknown: ["all"] })
    expect(tickedIds(["*"])).toEqual({ ok: false, unknown: ["*"] })
  })

  test("app mode is appended only when asked", () => {
    expect(installArgs(["graft"], SHA12, true).slice(-2)).toEqual(["--consent-mode", "app"])
    expect(installArgs(["graft"], SHA12, false)).not.toContain("--consent-mode")
    expect(supportsAppConsentMode(HELP)).toBe(false)
    expect(supportsAppConsentMode(HELP_APP)).toBe(true)
  })
})

describe("runner", () => {
  test("uid 0 is refused before any spawn", async () => {
    const spawn = fakeSpawn([])
    const { runner: r, logger } = runner(spawn, { getuid: () => 0 })
    expect(await r.install(["node"])).toEqual({ kind: "refused", reason: "root" })
    expect(await r.preview()).toEqual({ kind: "refused", reason: "root" })
    expect(spawn.calls).toHaveLength(0)
    expect(logger.entries.some((e) => e.level === "error" && e.meta?.reason === "root")).toBe(true)
  })

  test("spawns the binary with an argv array, no shell, stdin closed, HOME from the account", async () => {
    const spawn = fakeSpawn([{ stdout: "RESULT OK\n" }])
    const { runner: r } = runner(spawn)
    const result = await r.install(["graft"])
    expect(result.kind).toBe("ran")
    const call = spawn.calls.at(-1)!
    expect(call.binary).toBe("/bundle/swarm-setup/swarm-setup")
    expect(call.args).toEqual(installArgs(["graft"], SHA12, false))
    expect(call.options.shell).toBe(false)
    expect((call.options.stdio as string[])[0]).toBe("ignore")
    expect(call.options.env).toEqual({ PATH: "/usr/bin:/bin", HOME: home })
    expect(spawn.calls.every((c) => c.options.shell === false)).toBe(true)
  })

  test("nothing ticked or an unknown id never spawns install", async () => {
    const spawn = fakeSpawn([])
    const { runner: r } = runner(spawn)
    expect(await r.install([])).toEqual({ kind: "refused", reason: "nothing_selected" })
    expect(await r.install(["node", "evil"])).toEqual({ kind: "refused", reason: "unknown_component", ids: ["evil"] })
    expect(spawn.calls).toHaveLength(0)
  })

  test("an unreadable lock refuses without spawning install", async () => {
    const spawn = fakeSpawn([])
    const { runner: r } = runner(spawn, {
      readLock: () => {
        throw new Error("ENOENT")
      },
    })
    expect(await r.install(["node"])).toMatchObject({ kind: "refused", reason: "lock_unreadable" })
    expect(spawn.calls).toHaveLength(0)
  })

  test("passes --consent-mode app only when the bundled help lists it", async () => {
    const withMode = fakeSpawn([{ stdout: "RESULT OK\n" }], HELP_APP)
    await runner(withMode).runner.install(["node"])
    expect(withMode.calls.at(-1)!.args.slice(-2)).toEqual(["--consent-mode", "app"])

    const without = fakeSpawn([{ stdout: "RESULT OK\n" }], HELP)
    await runner(without).runner.install(["node"])
    expect(without.calls.at(-1)!.args).not.toContain("--consent-mode")
  })

  test("preview is the dry-run screen returned as printed", async () => {
    const screen = "Components (all optional, all unticked by default):\n  [ ] node\nRESULT REFUSED_NO_CONSENT\n"
    const spawn = fakeSpawn([{ stdout: screen, stderr: "swarm-setup: no consent\n", code: 1 }])
    const result = await runner(spawn).runner.preview()
    expect(spawn.calls.map((c) => c.args)).toEqual([["install", "--dry-run"]])
    expect(result).toMatchObject({ kind: "ran", exitCode: 1, stdout: screen, result: "REFUSED_NO_CONSENT" })
    expect(result.kind === "ran" && result.stderr).toBe("swarm-setup: no consent\n")
  })

  test("only one run at a time", async () => {
    const spawn = fakeSpawn([{ stdout: "RESULT OK\n" }])
    const { runner: r } = runner(spawn)
    const first = r.install(["node"])
    expect(r.busy()).toBe(true)
    expect(await r.preview()).toEqual({ kind: "refused", reason: "busy" })
    expect((await first).kind).toBe("ran")
    expect(r.busy()).toBe(false)
  })

  test("a spawn failure is reported, not thrown", async () => {
    const spawn = fakeSpawn([{ error: new Error("spawn ENOENT") }])
    expect(await runner(spawn).runner.preview()).toEqual({
      kind: "refused",
      reason: "spawn_failed",
      message: "spawn ENOENT",
    })
  })

  test("reports step, wire and RESULT lines verbatim and the final states", async () => {
    writeState({ node: { state: "healthy" }, searxng: { state: "healthy" } })
    const stdout = [
      "step node: OK",
      "step searxng: OK",
      "step firecrawl: HEALTH_FAILED — compose health gate timed out",
      "wire: wrote swarm.json:mcp.graft, swarm.json:mcp.swarm-web",
      "RESULT HEALTH_FAILED",
      "",
    ].join("\n")
    const spawn = fakeSpawn([{ stdout, code: 1 }])
    const progress: unknown[] = []
    const result = await runner(spawn).runner.install(["node", "searxng", "firecrawl"], (s) => progress.push(s))
    expect(result).toMatchObject({
      kind: "ran",
      exitCode: 1,
      result: "HEALTH_FAILED",
      wire: ["wire: wrote swarm.json:mcp.graft, swarm.json:mcp.swarm-web"],
      states: { node: "healthy", searxng: "healthy" },
      steps: [
        { id: "node", token: "OK" },
        { id: "searxng", token: "OK" },
        { id: "firecrawl", token: "HEALTH_FAILED", message: "compose health gate timed out" },
      ],
    })
    expect(progress.at(-1)).toEqual({ node: "healthy", searxng: "healthy" })
  })
})

describe("output parsing", () => {
  test("wire lines are kept verbatim and nothing else is derived from them (senior 5)", () => {
    const stdout = "wire swarm-web: skipped — proxy binary not staged\nwire: wrote swarm.json:mcp.swarm-web\n"
    expect(parseSetupOutput(stdout)).toEqual({
      steps: [],
      wire: ["wire swarm-web: skipped — proxy binary not staged", "wire: wrote swarm.json:mcp.swarm-web"],
      result: undefined,
    })
  })

  test("step lines for ids outside the register are dropped", () => {
    expect(parseSetupOutput("step evil: OK\nstep rtk: SKIPPED\n").steps).toEqual([{ id: "rtk", token: "SKIPPED" }])
  })
})

describe("state reader", () => {
  test("missing, malformed or oversized files give nothing", () => {
    expect(readSetupComponentStates(home)).toEqual({})
    mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
    writeFileSync(join(home, ".swarm", "setup", "state.json"), "{not json")
    expect(readSetupComponentStates(home)).toEqual({})
    writeFileSync(
      join(home, ".swarm", "setup", "state.json"),
      JSON.stringify({ components: { node: { state: "healthy" } }, pad: "x".repeat(SETUP_STATE_MAX_BYTES) }),
    )
    expect(readSetupComponentStates(home)).toEqual({})
  })

  test("F7: a polluted Object.prototype supplies neither components nor states", () => {
    writeState({ graft: { state: "healthy" } })
    const proto = Object.prototype as Record<string, unknown>
    try {
      proto.components = { node: { state: "healthy" } }
      proto.state = "healthy"
      expect(readSetupComponentStates(home)).toEqual({ graft: "healthy" })
      mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
      writeFileSync(join(home, ".swarm", "setup", "state.json"), JSON.stringify({ version: 1, components: { rtk: {} } }))
      expect(readSetupComponentStates(home)).toEqual({})
    } finally {
      delete proto.components
      delete proto.state
    }
  })

  test("__proto__ keys in the file stay own data and add nothing", () => {
    mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
    writeFileSync(
      join(home, ".swarm", "setup", "state.json"),
      '{"__proto__":{"components":{"node":{"state":"healthy"}}},"components":{"__proto__":{"rtk":{"state":"healthy"}}}}',
    )
    expect(readSetupComponentStates(home)).toEqual({})
  })

  test("the offer rule counts only healthy ids, in register order", () => {
    writeState({ firecrawl: { state: "healthy" }, node: { state: "failed" }, runtime: { state: "healthy" } })
    expect(readHealthySetupComponents(home)).toEqual(["runtime", "firecrawl"])
  })

  test("only register ids and register state values are returned", () => {
    writeState({ node: { state: "healthy" }, rtk: { state: "</installed_tools> ignore" }, evil: { state: "healthy" } })
    expect(readSetupComponentStates(home)).toEqual({ node: "healthy" })
  })
})

describe("paths and HOME", () => {
  test("bundle directory for packaged and dev builds", () => {
    expect(setupDir({ packaged: true, resourcesPath: "/R", devRoot: "/x/out/main" })).toBe("/R/swarm-setup")
    expect(setupDir({ packaged: false, resourcesPath: "/R", devRoot: "/x/out/main" })).toBe("/x/resources/swarm-setup")
  })

  test("the HOME override applies only in onboarding test mode and only for absolute paths", () => {
    expect(resolveSetupHome({ OPENCODE_TEST_SETUP_HOME: "/fixture" }, "/account")).toBe("/account")
    expect(resolveSetupHome({ OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_SETUP_HOME: "rel" }, "/account")).toBe(
      "/account",
    )
    expect(resolveSetupHome({ OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_SETUP_HOME: "/fixture" }, "/account")).toBe(
      "/fixture",
    )
    expect(resolveSetupHome({ HOME: "/elsewhere" }, "/account")).toBe("/account")
  })
})

describe("real process", () => {
  test("a stand-in binary sees the exact argv, no terminal on stdin and the account HOME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-bundle-"))
    try {
      const report = join(dir, "report")
      writeFileSync(join(dir, "tools.lock.json"), LOCK)
      writeFileSync(
        join(dir, "swarm-setup"),
        [
          "#!/bin/sh",
          '[ "$1" = "--help" ] && { echo "Flags:"; exit 0; }',
          `{ for a in "$@"; do printf '%s\\n' "$a"; done; if [ -t 0 ]; then echo tty; else echo notty; fi; printf 'HOME=%s\\n' "$HOME"; if read line; then echo stdin-data; else echo stdin-eof; fi; } > "${report}"`,
          'echo "step node: OK"',
          'echo "RESULT OK"',
        ].join("\n"),
      )
      chmodSync(join(dir, "swarm-setup"), 0o755)
      const logger = quietLogger()
      const r = createSetupRunner({ dir, logger, env: { PATH: "/usr/bin:/bin" }, accountHome: home, getuid: () => 501 })
      const result = await r.install(["node"])
      expect(result).toMatchObject({ kind: "ran", exitCode: 0, result: "OK", steps: [{ id: "node", token: "OK" }] })
      const lines = readFileSync(report, "utf8").trim().split("\n")
      expect(lines).toEqual([...installArgs(["node"], SHA12, false), "notty", `HOME=${home}`, "stdin-eof"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("F4: child env allowlist", () => {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/elsewhere",
    USER: "person",
    LANG: "id_ID.UTF-8",
    LC_ALL: "C",
    LC_CTYPE: "UTF-8",
    TMPDIR: "/tmp/x/",
    HTTP_PROXY: "http://proxy.invalid:1",
    https_proxy: "http://proxy.invalid:2",
    NO_PROXY: "localhost",
    NODE_OPTIONS: "--require /tmp/evil.js",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    ELECTRON_RUN_AS_NODE: "1",
    OPENCODE_SERVER_PASSWORD: "never",
    OPENCODE_TEST_SETUP_HOME: "/fixture",
    SWARM_FIRECRAWL_TOKEN: "never",
  }

  test("keeps only the allowlist and LC_*, and HOME is the setup HOME", () => {
    expect(setupChildEnv(env, "/account")).toEqual({
      PATH: "/usr/bin:/bin",
      USER: "person",
      LANG: "id_ID.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TMPDIR: "/tmp/x/",
      HTTP_PROXY: "http://proxy.invalid:1",
      https_proxy: "http://proxy.invalid:2",
      NO_PROXY: "localhost",
      HOME: "/account",
    })
  })

  test("the two test variables pass only in onboarding test mode", () => {
    const out = setupChildEnv({ ...env, OPENCODE_TEST_ONBOARDING: "1" }, "/fixture")
    expect(out.OPENCODE_TEST_ONBOARDING).toBe("1")
    expect(out.OPENCODE_TEST_SETUP_HOME).toBe("/fixture")
    expect(out.NODE_OPTIONS).toBeUndefined()
    expect(setupChildEnv({ ...env, OPENCODE_TEST_ONBOARDING: "0" }, "/a").OPENCODE_TEST_SETUP_HOME).toBeUndefined()
  })

  test("the allowlist is the one F4 names, plus the lowercase proxy names curl reads", () => {
    expect([...SETUP_ENV_ALLOW].sort()).toEqual(
      ["PATH", "USER", "LANG", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"].sort(),
    )
  })

  test("the runner spawns with the filtered env", async () => {
    const spawn = fakeSpawn([{ stdout: "RESULT OK\n" }])
    await runner(spawn, { env }).runner.install(["node"])
    for (const call of spawn.calls) expect(call.options.env).toEqual(setupChildEnv(env, home))
  })
})

describe("senior 16: a run still going at quit", () => {
  test("dispose logs the running child's PID and argv, and does not kill it", async () => {
    const spawn = fakeSpawn([{ stdout: "RESULT OK\n" }])
    const { runner: r, logger } = runner(spawn)
    const run = r.preview()
    r.dispose()
    const entry = logger.entries.find((e) => e.message === "swarm-setup still running at quit, left to finish")
    expect(entry?.meta).toMatchObject({ args: ["install", "--dry-run"] })
    expect((await run).kind).toBe("ran")
  })

  test("dispose with nothing running logs nothing", async () => {
    const spawn = fakeSpawn([{ stdout: "RESULT OK\n" }])
    const { runner: r, logger } = runner(spawn)
    await r.preview()
    const before = logger.entries.length
    r.dispose()
    expect(logger.entries.length).toBe(before)
  })

  test("a cut output is logged as truncated", async () => {
    const spawn = fakeSpawn([{ stdout: "x".repeat(SETUP_OUTPUT_MAX_BYTES + 10) }])
    const { runner: r, logger } = runner(spawn)
    const run = await r.preview()
    expect(run).toMatchObject({ kind: "ran", truncated: true })
    expect(logger.entries.find((e) => e.message === "swarm-setup finished")?.meta).toMatchObject({ truncated: true })
  })
})

describe("register drift against packages/setup/src/constants.ts (senior 1)", () => {
  test("component ids: same ids, same order", async () => {
    const setup = await import("../../../setup/src/constants")
    expect([...SETUP_COMPONENT_IDS]).toEqual([...setup.COMPONENT_IDS])
  })

  test("state values: same set as STATES", async () => {
    const setup = await import("../../../setup/src/constants")
    expect([...SETUP_STATE_VALUES].sort()).toEqual(Object.values(setup.STATES).sort())
  })

  test("desktop main keeps one copy: onboarding.ts restates no ids, state size or reader", async () => {
    const onboarding = await Bun.file(new URL("./onboarding.ts", import.meta.url)).text()
    expect(onboarding).toContain('from "./setup-runner"')
    for (const id of SETUP_COMPONENT_IDS) expect(onboarding).not.toContain(`"${id}"`)
    for (const copy of ["262144", "state.json\"", "JSON.parse", "openSync"]) expect(onboarding).not.toContain(copy)
  })
})

describe("senior 5: main's log parser and the dialog's parser read the same lines the same way", () => {
  test("one fixture through both", async () => {
    const app = await import("../../../app/src/components/dialog-install-tools.model")
    const stdout = [
      "Components:",
      "step node: OK",
      "step rtk: SKIPPED_WITH_INSTRUCTIONS — install Xcode command line tools",
      "step evil: OK",
      "step firecrawl: HEALTH_FAILED — compose health gate timed out",
      "step graft: ok",
      "wire: wrote swarm.json:mcp.graft",
      "RESULT HEALTH_FAILED",
      "",
    ].join("\n")
    const main = parseSetupOutput(stdout)
    const dialog = app.parseSteps(stdout)
    expect(Object.fromEntries(main.steps.map((step) => [step.id, { token: step.token, ...(step.message ? { message: step.message } : {}) }]))).toEqual(
      dialog,
    )
    expect(app.resultLine(stdout)).toBe(`RESULT ${main.result}`)
  })
})

// 1.2.6 row 92b (TH-03, 01c 4.7 / 11.5): the start-only revive verb on the shared runner. Red class B at e363918a69.
describe("row 92b: start(id) runs only `swarm-setup start <id>`", () => {
  const HELP_START = HELP + "Usage:\n  swarm-setup start <runtime|searxng|firecrawl>  start an installed, stopped component\n"

  test("argv is exactly [start, id] after one --help, for each startable id; RESULT is parsed", async () => {
    expect([...SETUP_START_IDS]).toEqual(["runtime", "searxng", "firecrawl"])
    for (const id of SETUP_START_IDS) {
      const spawn = fakeSpawn([{ stdout: "RESULT OK\n" }], HELP_START)
      const result = await runner(spawn).runner.start(id)
      expect(spawn.calls.map((c) => c.args)).toEqual([["--help"], ["start", id]])
      expect(spawn.calls.every((c) => c.binary === "/bundle/swarm-setup/swarm-setup")).toBe(true)
      expect(spawn.calls[1]!.options).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "pipe"], cwd: home })
      expect(result).toMatchObject({ kind: "ran", exitCode: 0, args: ["start", id], result: "OK" })
      expect(startArgs(id)).toEqual(["start", id])
    }
  })

  test("a refusal token is returned as the RESULT, with the exit code", async () => {
    const spawn = fakeSpawn([{ stdout: "RESULT START_CONTAINERS_MISSING\n", code: 3 }], HELP_START)
    expect(await runner(spawn).runner.start("searxng")).toMatchObject({ kind: "ran", exitCode: 3, result: "START_CONTAINERS_MISSING" })
  })

  test("an older binary without the start verb is refused no_start_verb and sees no other verb", async () => {
    const spawn = fakeSpawn([{ stdout: "RESULT OK\n" }], HELP_APP)
    expect(await runner(spawn).runner.start("runtime")).toEqual({ kind: "refused", reason: "no_start_verb" })
    expect(spawn.calls.map((c) => c.args)).toEqual([["--help"]])
  })

  test("a failing --help refuses no_start_verb and runs nothing else", async () => {
    // --help exits 2 (the help reply is replaced by a scripted failure); a start must not follow.
    const failed = fakeSpawn([{ code: 2 }])
    const calls: string[][] = []
    const spawn = ((binary: string, args: string[], options: Record<string, unknown>) => {
      calls.push(args)
      return failed.spawn(binary, args[0] === "--help" ? ["help-fails"] : args, options as never)
    }) as unknown as typeof failed.spawn
    expect(await runner({ spawn, calls: [] }).runner.start("firecrawl")).toEqual({ kind: "refused", reason: "no_start_verb" })
    expect(calls).toEqual([["--help"]])
  })

  test("an id outside the start set is refused without any spawn", async () => {
    for (const id of ["node", "graft", "render-bridge", "install", "searxng --force-recreate"]) {
      const spawn = fakeSpawn([], HELP_START)
      const result = await runner(spawn).runner.start(id as (typeof SETUP_START_IDS)[number])
      expect(result).toEqual({ kind: "refused", reason: "unknown_component", ids: [id] })
      expect(spawn.calls).toEqual([])
    }
  })

  test("start shares the one-run lock: busy during an install, and an install is busy during a start", async () => {
    const spawn = fakeSpawn([{ stdout: "RESULT OK\n" }, { stdout: "RESULT OK\n" }], HELP_START)
    const { runner: r } = runner(spawn)
    const install = r.install(["node"])
    expect(await r.start("searxng")).toEqual({ kind: "refused", reason: "busy" })
    await install
    const start = r.start("searxng")
    expect(r.busy()).toBe(true)
    expect(await r.install(["node"])).toEqual({ kind: "refused", reason: "busy" })
    expect((await start).kind).toBe("ran")
    expect(spawn.calls.filter((c) => c.args[0] === "start").map((c) => c.args)).toEqual([["start", "searxng"]])
  })

  test("uid 0 is refused before any spawn", async () => {
    const spawn = fakeSpawn([], HELP_START)
    expect(await runner(spawn, { getuid: () => 0 }).runner.start("runtime")).toEqual({ kind: "refused", reason: "root" })
    expect(spawn.calls).toEqual([])
  })

  test("the usage text is read once per runner (install and start share it)", async () => {
    const spawn = fakeSpawn([{ stdout: "RESULT OK\n" }, { stdout: "RESULT OK\n" }, { stdout: "RESULT OK\n" }], HELP_START)
    const { runner: r } = runner(spawn)
    await r.install(["node"])
    await r.start("runtime")
    await r.start("searxng")
    expect(spawn.calls.filter((c) => c.args[0] === "--help")).toHaveLength(1)
  })

  test("drift: the id set and the usage line match packages/setup", async () => {
    const start = await import("../../../setup/src/estate/start")
    expect([...SETUP_START_IDS]).toEqual([...start.STARTABLE_COMPONENTS])
    const setup = await import("../../../setup/src/index")
    expect(supportsStartVerb(setup.usageText())).toBe(true)
    expect(supportsStartVerb(setup.usageText("fixture"))).toBe(true)
    expect(supportsStartVerb(HELP_APP)).toBe(false)
  })

  test("real process: a stand-in binary sees exactly `start <id>` with no terminal on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-bundle-start-"))
    try {
      const report = join(dir, "report")
      writeFileSync(
        join(dir, "swarm-setup"),
        [
          "#!/bin/sh",
          '[ "$1" = "--help" ] && { echo "Usage:"; echo "  swarm-setup start <runtime|searxng|firecrawl>  start"; exit 0; }',
          `{ for a in "$@"; do printf '%s\\n' "$a"; done; if [ -t 0 ]; then echo tty; else echo notty; fi; } > "${report}"`,
          'echo "RESULT RUNTIME_PROFILE_MISSING"',
          "exit 1",
        ].join("\n"),
      )
      chmodSync(join(dir, "swarm-setup"), 0o755)
      const r = createSetupRunner({ dir, logger: quietLogger(), env: { PATH: "/usr/bin:/bin" }, accountHome: home, getuid: () => 501 })
      const result = await r.start("runtime")
      expect(result).toMatchObject({ kind: "ran", exitCode: 1, result: "RUNTIME_PROFILE_MISSING" })
      expect(readFileSync(report, "utf8").trim().split("\n")).toEqual(["start", "runtime", "notty"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
