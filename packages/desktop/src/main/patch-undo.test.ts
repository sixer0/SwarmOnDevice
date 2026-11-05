import { afterAll, describe, expect, test } from "bun:test"
import type { MessageBoxOptions } from "electron"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeT } from "./native-translations"
import {
  createPatchFlowGuard,
  patchErrorToken,
  patchMenuEnabled,
  PATCH_OUTPUT_MAX_BYTES,
  type PatchFlowGuard,
  type PatchRunner,
  type PatchRunResult,
} from "./patch-common"
import { createUndoLastUpdate, type UndoLastUpdateDeps, type UndoOutcome } from "./patch-undo"

// Row 61: "Undo Last Update" (row 59), spec 04 section 7 D1-D6, UM-16, UM-17, register 14.4 UM-26 (D52-3).
// Injected dependencies only: no Electron, no real applier.

const RES = "/Apps/Swarm.app/Contents/Resources"
const HOME = "/Users/tester"
const APPLIER = `${RES}/swarm-patch/swarm-patch`
const STATUS = "release=1.1.3\nbundle_version=1.19.3\nprevious_release=1.1.2\ndata_min_release=1.1.0\njournal_phase=idle\n"

type ExecCall = { file: string; args: readonly string[]; options: Parameters<PatchRunner>[2] }
const allExecCalls: ExecCall[] = []

// Results in the shape of the shared runner (patch-common.ts createExecFileRunner, C27 M3).
const ok = (stdout: string): PatchRunResult => ({ code: 0, signal: null, stdout, stderr: "" })
const fail = (code: number, stderr = ""): PatchRunResult => ({ code, signal: null, stdout: "", stderr })
const broken = (failure: "timeout" | "overflow" | "start", startCode?: string): PatchRunResult => ({
  code: null,
  signal: failure === "start" ? null : "SIGTERM",
  stdout: "",
  stderr: "",
  failure,
  ...(startCode ? { startCode } : {}),
})

function harness(opts: {
  status?: PatchRunResult
  responses?: (number | "reject")[]
  handoff?: { ok: true } | { ok: false; code: string } | "reject"
  guard?: PatchFlowGuard
  available?: boolean
  t?: UndoLastUpdateDeps["t"]
  run?: PatchRunner
  resourcesPath?: string
  home?: string
  realpath?: (path: string) => string
} = {}) {
  const execs: ExecCall[] = []
  const dialogs: MessageBoxOptions[] = []
  const handoffs: (readonly string[])[] = []
  const logs: { level: string; message: string; meta?: Record<string, unknown> }[] = []
  const responses = [...(opts.responses ?? [])]
  const t =
    opts.t ?? ((key: string, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key))
  const undo = createUndoLastUpdate({
    window: () => null,
    showMessageBox: async (_win, options) => {
      dialogs.push(options)
      const next = responses.shift() ?? 0
      if (next === "reject") throw new Error("dialog failed")
      return { response: next, checkboxChecked: false }
    },
    handoff: async (argv) => {
      handoffs.push(argv)
      const h = opts.handoff ?? { ok: true }
      if (h === "reject") throw Object.assign(new Error("spawn"), { code: "EPERM" })
      return h
    },
    resourcesPath: () => opts.resourcesPath ?? RES,
    t,
    run:
      opts.run ??
      (async (file, args, options) => {
        const call = { file, args: [...args], options }
        execs.push(call)
        allExecCalls.push(call)
        return opts.status ?? ok(STATUS)
      }),
    homedir: () => opts.home ?? HOME,
    realpath: opts.realpath ?? ((path) => path),
    exists: (path) => (opts.available ?? true) && path === `${opts.resourcesPath ?? RES}/swarm-patch/swarm-patch`,
    guard: opts.guard ?? createPatchFlowGuard(),
    log: {
      info: (message, meta) => logs.push({ level: "info", message, meta }),
      error: (message, meta) => logs.push({ level: "error", message, meta }),
    },
  })
  return { undo, execs, dialogs, handoffs, logs, t }
}

describe("S-1 call", () => {
  test("argv, env keys, timeout in ms (C20), maxBuffer", async () => {
    const h = harness({ responses: [1] })
    await h.undo()
    expect(h.execs).toHaveLength(1)
    expect(h.execs[0]!.file).toBe("/bin/zsh")
    expect(h.execs[0]!.args).toEqual(["-f", APPLIER, "status"])
    expect(h.execs[0]!.options).toEqual({
      env: { HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
      timeoutMs: 30_000,
      maxBuffer: PATCH_OUTPUT_MAX_BYTES,
    })
  })
})

describe("UM-17 eligibility table", () => {
  test("D1 status fails with S11: BN-47 + BN-52 with that line, 0 handoff", async () => {
    const line = "swarm-patch: E_SEAL: Info.plist missing"
    const h = harness({ status: fail(15, `x\n${line}\n`) })
    expect(await h.undo()).toBe("status_failed")
    expect(h.dialogs).toEqual([
      {
        title: "desktop.menu.undoLastUpdate",
        type: "error",
        message: "desktop.patch.undo.blocked.message",
        detail: h.t("desktop.patch.result.failed.detail" as never, { error: line }),
        buttons: ["desktop.patch.cancel"],
      },
    ])
    expect(h.handoffs).toHaveLength(0)
    expect(h.logs.some((l) => l.level === "error")).toBe(true)
  })

  // C27 D-3: the same token function as Update U7 (patch-common.ts patchErrorToken, "status").
  const d1: [string, PatchRunResult, string][] = [
    ["exit code without S11", fail(15, "noise"), "swarm-patch: exit 15"],
    ["exit 21 without S11 (no E_NAME for status)", fail(21, "noise"), "swarm-patch: exit 21"],
    ["timeout", broken("timeout"), "swarm-patch: exit timeout"],
    ["output overflow", broken("overflow"), "swarm-patch: exit overflow"],
    ["spawn failure", broken("start", "ENOENT"), "swarm-patch: exit ENOENT"],
    ["start failure without a code token", broken("start"), "swarm-patch: exit start"],
    ["killed by another signal", { code: null, signal: "SIGKILL", stdout: "", stderr: "" }, "swarm-patch: exit SIGKILL"],
    ["exit 0, unparsable output", ok("release=1.1.3\n"), "swarm-patch: exit 0"],
  ]
  for (const [name, status, error] of d1)
    test(`D1 ${name}: ${error}, 0 handoff`, async () => {
      const h = harness({ status })
      expect(await h.undo()).toBe("status_failed")
      expect(h.dialogs[0]!.detail).toBe(h.t("desktop.patch.result.failed.detail" as never, { error }))
      expect(h.handoffs).toHaveLength(0)
    })

  test("the status token cuts the S11 line to 500 characters", () => {
    const line = "swarm-patch: E_SEAL: " + "y".repeat(800)
    expect(patchErrorToken(fail(15, line), "status")).toBe(line.slice(0, 500))
  })

  for (const phase of ["staged", "old_moved", "new_placed", "rollback_staged", "rollback_moved", "rollback_placed", "invalid"])
    test(`D2 journal_phase=${phase}: BN-47 without detail, 0 handoff`, async () => {
      const h = harness({ status: ok(STATUS.replace("journal_phase=idle", `journal_phase=${phase}`)) })
      expect(await h.undo()).toBe("interrupted")
      expect(h.dialogs).toHaveLength(1)
      expect(h.dialogs[0]!.message).toBe("desktop.patch.undo.blocked.message")
      expect(h.dialogs[0]!.detail).toBeUndefined()
      expect(h.handoffs).toHaveLength(0)
    })

  test("D3 rollback_blocked=forward_migration: BN-47 + BN-48 {previous_release}, 0 handoff", async () => {
    const h = harness({ status: ok(STATUS + "rollback_blocked=forward_migration\n") })
    expect(await h.undo()).toBe("blocked")
    expect(h.dialogs[0]).toMatchObject({
      type: "info",
      message: "desktop.patch.undo.blocked.message",
      detail: h.t("desktop.patch.undo.blocked.detail" as never, { release: "1.1.2" }),
      buttons: ["desktop.patch.cancel"],
    })
    expect(h.handoffs).toHaveLength(0)
  })

  test("D4 previous_release empty: BN-46, 0 handoff", async () => {
    const h = harness({ status: ok(STATUS.replace("previous_release=1.1.2", "previous_release=")) })
    expect(await h.undo()).toBe("none")
    expect(h.dialogs[0]).toMatchObject({ type: "info", message: "desktop.patch.undo.none.message", buttons: ["desktop.patch.cancel"] })
    expect(h.handoffs).toHaveLength(0)
  })

  test("journal_phase=none counts as idle", async () => {
    const h = harness({ status: ok(STATUS.replace("journal_phase=idle", "journal_phase=none")), responses: [1] })
    expect(await h.undo()).toBe("cancelled")
  })

  test("D5 confirm dialog: BN-43/BN-44, [BN-45, BN-34], default/cancel 1", async () => {
    const h = harness({ responses: [1] })
    await h.undo()
    expect(h.dialogs).toEqual([
      {
        title: "desktop.menu.undoLastUpdate",
        type: "question",
        message: h.t("desktop.patch.undo.confirm.message" as never, { release: "1.1.2" }),
        detail: h.t("desktop.patch.undo.confirm.detail" as never, { installed: "1.1.3", release: "1.1.2" }),
        buttons: ["desktop.patch.undo.confirm.undo", "desktop.patch.cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      },
    ])
  })

  test("D5 declined: 0 handoff", async () => {
    const h = harness({ responses: [1] })
    expect(await h.undo()).toBe("cancelled")
    expect(h.handoffs).toHaveLength(0)
  })

  test("D5 dialog rejects: counts as cancel, 0 handoff", async () => {
    const h = harness({ responses: ["reject"] })
    expect(await h.undo()).toBe("cancelled")
    expect(h.handoffs).toHaveLength(0)
  })

  test("D6 accepted: handoff exactly once with the BN-61 rollback argv", async () => {
    const h = harness({ responses: [0] })
    expect(await h.undo()).toBe("handed_off")
    expect(h.handoffs).toEqual([["/bin/zsh", "-f", APPLIER, "rollback"]])
    expect(h.logs.some((l) => l.level === "info")).toBe(true)
  })

  test("handoff {ok:false}: BN-51 + BN-52 spawn: <code>", async () => {
    const h = harness({ responses: [0], handoff: { ok: false, code: "EACCES" } })
    expect(await h.undo()).toBe("handoff_failed")
    expect(h.dialogs[1]).toMatchObject({
      type: "error",
      message: "desktop.patch.result.failed.message",
      detail: h.t("desktop.patch.result.failed.detail" as never, { error: "spawn: EACCES" }),
    })
  })

  test("handoff rejects: spawn: <code>, no crash", async () => {
    const h = harness({ responses: [0], handoff: "reject" })
    expect(await h.undo()).toBe("handoff_failed")
    expect(h.dialogs[1]!.detail).toBe(h.t("desktop.patch.result.failed.detail" as never, { error: "spawn: EPERM" }))
  })

  test("all text comes from nativeT (en): title and Cancel are translated", async () => {
    const h = harness({ responses: [1], t: nativeT })
    await h.undo()
    expect(h.dialogs[0]!.title).toBe("Undo Last Update")
    expect(h.dialogs[0]!.buttons).toEqual(["Undo", "Cancel"])
    expect(h.dialogs[0]!.message).toBe("Return to release 1.1.2?")
  })
})

describe("guard (M8)", () => {
  test("second click while status is pending: 1 status call", async () => {
    let release!: (r: PatchRunResult) => void
    const pending = new Promise<PatchRunResult>((done) => (release = done))
    let calls = 0
    const h = harness({
      responses: [1],
      run: async () => {
        calls += 1
        return pending
      },
    })
    const first = h.undo()
    await Bun.sleep(0)
    expect(await h.undo()).toBe("busy")
    release(ok(STATUS))
    expect(await first).toBe("cancelled")
    expect(calls).toBe(1)
  })

  // C27 D-1: same policy as Update from File… (patch-common.ts guardPatchFlow).
  test("guard kept after a started handoff: next click busy, 1 handoff", async () => {
    const guard = createPatchFlowGuard()
    const h = harness({ guard, responses: [0] })
    expect(await h.undo()).toBe("handed_off")
    expect(await h.undo()).toBe("busy")
    expect(h.execs).toHaveLength(1)
    expect(h.handoffs).toHaveLength(1)
    expect(guard.tryEnter()).toBe(false)
  })

  const releaseCases: [string, Omit<Parameters<typeof harness>[0], "guard">, UndoOutcome][] = [
    ["cancel", { responses: [1] }, "cancelled"],
    ["status failure", { status: fail(15) }, "status_failed"],
    ["handoff {ok:false}", { responses: [0], handoff: { ok: false as const, code: "EACCES" } }, "handoff_failed"],
    ["handoff rejects", { responses: [0], handoff: "reject" as const }, "handoff_failed"],
    ["disabled", { available: false }, "disabled"],
  ]
  for (const [name, opts, outcome] of releaseCases)
    test(`guard released after ${name}`, async () => {
      const guard = createPatchFlowGuard()
      const h = harness({ guard, ...opts })
      expect(await h.undo()).toBe(outcome)
      expect(guard.tryEnter()).toBe(true)
    })

  test("busy shared guard: no dialog, no child, 0 handoff", async () => {
    const guard = createPatchFlowGuard()
    guard.tryEnter()
    const h = harness({ guard })
    expect(await h.undo()).toBe("busy")
    expect(h.execs).toHaveLength(0)
    expect(h.dialogs).toHaveLength(0)
    expect(h.handoffs).toHaveLength(0)
  })
})

// ---- D52-3 / UM-26 --------------------------------------------------------------------------------------------------

const T = realpathSync(mkdtempSync(join(tmpdir(), "swarm-row61-undo-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

describe("UM-26 / D52-3 undo not eligible", () => {
  test("applier missing: disabled, 0 children, 0 dialogs, 0 handoff", async () => {
    const h = harness({ available: false })
    expect(await h.undo()).toBe("disabled")
    expect(h.execs).toHaveLength(0)
    expect(h.dialogs).toHaveLength(0)
    expect(h.handoffs).toHaveLength(0)
  })

  const home = join(T, "home")
  const state = join(home, "Library", "Application Support", "id.co.gsp.swarm.patch")
  const backupRes = join(state, "previous", "Swarm.app", "Contents", "Resources")
  const appRes = join(T, "apps", "Swarm.app", "Contents", "Resources")
  for (const res of [backupRes, appRes]) {
    mkdirSync(join(res, "swarm-patch"), { recursive: true })
    writeFileSync(join(res, "swarm-patch", "swarm-patch"), "exit 99\n")
  }
  const linkRes = join(T, "link-res")
  symlinkSync(backupRes, linkRes)
  const real = { realpath: (p: string) => realpathSync(p), exists: (p: string) => { try { realpathSync(p); return true } catch { return false } } }

  // C27 L1 / N-6: Undo uses the menu's own check (patchMenuEnabled), with the same injected realpath/exists.
  test("patchMenuEnabled over a real fixture, as Undo calls it", () => {
    const check = (resourcesPath: string) =>
      patchMenuEnabled({ resourcesPath, home, realpathSync: real.realpath, existsSync: real.exists })
    expect(check(appRes)).toBe(true)
    expect(check(backupRes)).toBe(false)
    expect(check(linkRes)).toBe(false)
    expect(check(join(T, "missing"))).toBe(false)
  })

  test("state folder spelled in another case (probe P3): disabled, 0 children, 0 dialogs, 0 handoff", async () => {
    const res = "/users/TESTER/Library/Application Support/ID.CO.GSP.SWARM.PATCH/previous/Swarm.app/Contents/Resources"
    const h = harness({ resourcesPath: res, home: HOME })
    expect(await h.undo()).toBe("disabled")
    expect(h.execs).toHaveLength(0)
    expect(h.dialogs).toHaveLength(0)
    expect(h.handoffs).toHaveLength(0)
  })

  test("literal resources path inside the state folder, resolved path outside: disabled, 0 handoff", async () => {
    const res = `${HOME}/Library/Application Support/id.co.gsp.swarm.patch/previous/Swarm.app/Contents/Resources`
    const h = harness({ resourcesPath: res, realpath: (p) => (p === res ? RES : p) })
    expect(await h.undo()).toBe("disabled")
    expect(h.execs).toHaveLength(0)
    expect(h.handoffs).toHaveLength(0)
  })

  test("state-folder run with default realpath/exists: disabled, 0 children, 0 handoff", async () => {
    const execs: unknown[] = []
    const handoffs: unknown[] = []
    const dialogs: unknown[] = []
    const undo = createUndoLastUpdate({
      window: () => null,
      showMessageBox: async (_w, o) => {
        dialogs.push(o)
        return { response: 0, checkboxChecked: false }
      },
      handoff: async (argv) => {
        handoffs.push(argv)
        return { ok: true }
      },
      resourcesPath: () => backupRes,
      homedir: () => home,
      run: async (...args) => {
        execs.push(args)
        return ok(STATUS)
      },
      guard: createPatchFlowGuard(),
    })
    expect(await undo()).toBe("disabled")
    expect(execs).toHaveLength(0)
    expect(dialogs).toHaveLength(0)
    expect(handoffs).toHaveLength(0)
  })
})

describe("UM-16 child calls (undo)", () => {
  test("only status was ever run", () => {
    expect(allExecCalls.length).toBeGreaterThan(10)
    for (const call of allExecCalls) {
      expect(call.file).toBe("/bin/zsh")
      expect(call.args).toEqual(["-f", APPLIER, "status"])
    }
  })
})
