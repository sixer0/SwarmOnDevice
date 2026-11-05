import { afterAll, describe, expect, test } from "bun:test"
import type { MessageBoxOptions, OpenDialogOptions } from "electron"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DESKTOP_NATIVE_ENGLISH } from "@opencode-ai/app/i18n/desktop-native"
import { nativeT } from "./native-translations"
import {
  createExecFileRunner,
  createPatchFlowGuard,
  patchErrorToken,
  patchMenuEnabled,
  PATCH_OUTPUT_MAX_BYTES,
  type PatchFlowGuard,
  type PatchRunOptions,
  type PatchRunResult,
} from "./patch-common"
import { PATCH_EXIT_NAMES } from "./patch-codes"
import {
  anchorFingerprint,
  checkPatchPath,
  createPatchUpdateFlow,
  nodePatchFs,
  parseVerifyOutput,
  type PatchFs,
  type PatchStats,
  type PatchUpdateKey,
} from "./patch-update-flow"

// Row 61: "Update from File…" (row 56), spec 04 UM-03..UM-16, UM-20 (BN-41 oracle, C21 #3), register 14.4
// UM-24..UM-26. Injected dependencies only: no Electron, no real applier. Only UM-10 runs the real
// /usr/bin/ssh-keygen (a read of public keys) against the bundled anchor and a synthetic key made in $T.

// ---- fixture ------------------------------------------------------------------------------------------------------

const RES = "/Apps/Swarm.app/Contents/Resources"
const HOME = "/Users/tester"
const TARGET = "/Apps/Swarm.app"
const APPLIER = `${RES}/swarm-patch/swarm-patch`
const SIGNERS = `${RES}/swarm-patch/allowed_signers`
const STATE = `${HOME}/Library/Application Support/id.co.gsp.swarm.patch`
const P = `${HOME}/Downloads/swarm-1.1.3.swarmpatch`
const ANCHOR =
  'swarm-patch-gsp namespaces="id.co.gsp.swarm.patch.v1" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAPw1AODJ+ROF5OOH0ryNjHVywneOJo6CK8BNSR/PUbe\n'
const FP = "SHA256:XaEUayyOTyA5mnu2V+1/DUbtub2mFlSiLhinP4hF4Xg"

const VERIFY_OK = "result=verified\nrelease=1.1.3\nfrom_release=1.1.2\nmigration=none\nnew_key=no\n"
const VERIFY_FORWARD = VERIFY_OK.replace("migration=none", "migration=forward")
const STATUS_OK = "release=1.1.2\nbundle_version=1.19.3\nprevious_release=1.1.1\ndata_min_release=1.1.0\njournal_phase=idle\n"

type RunCall = { file: string; args: readonly string[]; options: PatchRunOptions }
// UM-16: every child call made by the flow in this file, across all tests.
const allRunCalls: RunCall[] = []

const ok = (stdout: string): PatchRunResult => ({ code: 0, signal: null, stdout, stderr: "" })
const exit = (code: number, stderr = ""): PatchRunResult => ({ code, signal: null, stdout: "", stderr })

type Entry = { kind: "file" | "dir" | "link"; size?: number; content?: string }

function fakeFs(input: {
  entries?: Record<string, Entry>
  realpaths?: Record<string, string>
  notWritable?: string[]
}): PatchFs {
  const entries: Record<string, Entry> = {
    [P]: { kind: "file", size: 1000 },
    [SIGNERS]: { kind: "file", size: ANCHOR.length, content: ANCHOR },
    ...input.entries,
  }
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" })
  return {
    lstat: async (path) => {
      const e = entries[path]
      if (!e) throw enoent()
      const stats: PatchStats = {
        isFile: () => e.kind === "file",
        isSymbolicLink: () => e.kind === "link",
        size: e.size ?? (e.content ?? "").length,
      }
      return stats
    },
    realpath: async (path) => {
      if (input.realpaths && path in input.realpaths) return input.realpaths[path]!
      // The state folder does not exist unless a test maps it.
      if (path === STATE) throw enoent()
      return path
    },
    readFile: async (path) => {
      const e = entries[path]
      if (!e || e.content === undefined) throw enoent()
      return e.content
    },
    accessWritable: async (path) => {
      if (input.notWritable?.includes(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" })
    },
  }
}

function harness(opts: {
  file?: string | null
  pickerReject?: boolean
  verify?: PatchRunResult | (() => Promise<PatchRunResult>)
  status?: PatchRunResult
  sshKeygen?: PatchRunResult
  fs?: PatchFs
  responses?: (number | "reject")[]
  handoff?: { ok: true } | { ok: false; code: string } | "reject"
  resourcesPath?: string
  home?: string
  t?: (key: PatchUpdateKey, params?: Record<string, string | number>) => string
  guard?: PatchFlowGuard
  enabled?: () => boolean
} = {}) {
  const runs: RunCall[] = []
  const dialogs: MessageBoxOptions[] = []
  const pickers: OpenDialogOptions[] = []
  const handoffs: (readonly string[])[] = []
  const logs: { level: string; event: string; extra?: Record<string, unknown> }[] = []
  const responses = [...(opts.responses ?? [])]
  const t =
    opts.t ?? ((key: PatchUpdateKey, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key))
  const flow = createPatchUpdateFlow({
    window: () => null,
    showOpenDialog: async (_win, options) => {
      pickers.push(options)
      if (opts.pickerReject) throw new Error("picker failed")
      if (opts.file === null) return { canceled: true, filePaths: [] }
      return { canceled: false, filePaths: [opts.file ?? P] }
    },
    showMessageBox: async (_win, options) => {
      dialogs.push(options)
      const next = responses.shift() ?? 0
      if (next === "reject") throw new Error("dialog failed")
      return { response: next, checkboxChecked: false }
    },
    t,
    resourcesPath: opts.resourcesPath ?? RES,
    home: opts.home ?? HOME,
    handoff: async (argv) => {
      handoffs.push(argv)
      const h = opts.handoff ?? { ok: true }
      if (h === "reject") throw Object.assign(new Error("spawn failed"), { code: "ENOENT" })
      return h
    },
    log: (level, event, extra) => logs.push({ level, event, extra }),
    run: async (file, args, options) => {
      const call = { file, args: [...args], options }
      runs.push(call)
      allRunCalls.push(call)
      if (file === "/usr/bin/ssh-keygen") return opts.sshKeygen ?? ok(`256 ${FP} no comment (ED25519)\n`)
      if (args[2] === "verify") {
        const v = opts.verify ?? ok(VERIFY_OK)
        return typeof v === "function" ? v() : v
      }
      if (args[2] === "status") return opts.status ?? ok(STATUS_OK)
      return exit(99)
    },
    fs: opts.fs ?? fakeFs({}),
    guard: opts.guard ?? createPatchFlowGuard(),
    enabled: opts.enabled ?? (() => true),
  })
  return {
    flow,
    runs,
    dialogs,
    pickers,
    handoffs,
    logs,
    t,
  }
}

const usageDetail = (h: ReturnType<typeof harness>) => h.t("desktop.patch.invalid.detail", { error: "swarm-patch: E_USAGE" })

// ---- U1 / UM-03 -----------------------------------------------------------------------------------------------------

describe("UM-03 picker", () => {
  test("picker options: title/message BN-32, filter BN-33 swarmpatch, openFile", async () => {
    const h = harness({ file: null })
    await h.flow()
    expect(h.pickers).toEqual([
      {
        title: "desktop.patch.picker.title",
        message: "desktop.patch.picker.title",
        properties: ["openFile"],
        filters: [{ name: "desktop.patch.picker.filter", extensions: ["swarmpatch"] }],
      },
    ])
  })

  const cancels: [string, Parameters<typeof harness>[0]][] = [
    ["cancelled", { file: null }],
    ["0 paths (empty string)", { file: "" }],
    ["picker rejects", { pickerReject: true }],
  ]
  for (const [name, opts] of cancels)
    test(`${name}: 0 children, 0 dialogs, 0 handoff`, async () => {
      const h = harness(opts)
      expect(await h.flow()).toBe("cancelled")
      expect(h.runs).toHaveLength(0)
      expect(h.dialogs).toHaveLength(0)
      expect(h.handoffs).toHaveLength(0)
      })
})

// ---- U2 / UM-04, UM-24 ----------------------------------------------------------------------------------------------

describe("UM-04 / UM-24 path refusals", () => {
  const cases: [string, Parameters<typeof harness>[0]][] = [
    ["other extension", { file: `${HOME}/Downloads/x.zip`, fs: fakeFs({ entries: { [`${HOME}/Downloads/x.zip`]: { kind: "file" } } }) }],
    ["symlink", { fs: fakeFs({ entries: { [P]: { kind: "link" } } }) }],
    ["directory", { fs: fakeFs({ entries: { [P]: { kind: "dir" } } }) }],
    ["missing file", { file: `${HOME}/gone.swarmpatch` }],
    ["relative path", { file: "Downloads/x.swarmpatch" }],
    [
      "file inside the target",
      {
        file: `${TARGET}/Contents/x.swarmpatch`,
        fs: fakeFs({ entries: { [`${TARGET}/Contents/x.swarmpatch`]: { kind: "file" } } }),
      },
    ],
    [
      "file inside the target, other case",
      {
        file: "/apps/swarm.APP/x.swarmpatch",
        fs: fakeFs({ entries: { "/apps/swarm.APP/x.swarmpatch": { kind: "file" } } }),
      },
    ],
    ["file inside the state folder", { file: `${STATE}/x.swarmpatch`, fs: fakeFs({ entries: { [`${STATE}/x.swarmpatch`]: { kind: "file" } } }) }],
    ["realpath of file inside the state folder", { fs: fakeFs({ realpaths: { [P]: `${STATE}/previous/x.swarmpatch` } }) }],
    ["realpath of file inside the target", { fs: fakeFs({ realpaths: { [P]: `${TARGET}/Contents/Resources/x.swarmpatch` } }) }],
    [
      "file inside the resolved state folder",
      {
        file: "/private/state/x.swarmpatch",
        fs: fakeFs({ entries: { "/private/state/x.swarmpatch": { kind: "file" } }, realpaths: { [STATE]: "/private/state" } }),
      },
    ],
    ["control byte LF", { file: `${HOME}/a\nb.swarmpatch` }],
    ["control byte ESC", { file: `${HOME}/a\x1bb.swarmpatch` }],
    ["byte 0x7F", { file: `${HOME}/a\x7fb.swarmpatch` }],
    ["target parent not writable", { fs: fakeFs({ notWritable: ["/Apps"] }) }],
    ["target under /Volumes", { resourcesPath: "/Volumes/Disk/Swarm.app/Contents/Resources" }],
    ["target in App Translocation", { resourcesPath: "/private/var/folders/x/T/AppTranslocation/AB12/d/Swarm.app/Contents/Resources" }],
    ["target not a .app", { resourcesPath: "/opt/swarm/Contents/Resources" }],
    ["target unresolvable", { fs: fakeFs({ realpaths: {} }), resourcesPath: "/Apps/Swarm.app/Contents/Resources" }],
  ]
  // "target unresolvable" needs a realpath that rejects for the target only.
  cases[cases.length - 1]![1]!.fs = (() => {
    const base = fakeFs({})
    return { ...base, realpath: async (path: string) => (path === TARGET ? Promise.reject(new Error("ENOENT")) : base.realpath(path)) }
  })()

  for (const [name, opts] of cases)
    test(`${name}: E_USAGE dialog, 0 children, 0 handoff`, async () => {
      const h = harness(opts)
      expect(await h.flow()).toBe("rejected")
      expect(h.runs).toHaveLength(0)
      expect(h.handoffs).toHaveLength(0)
        expect(h.dialogs).toHaveLength(1)
      expect(h.dialogs[0]).toMatchObject({
        type: "error",
        title: "desktop.menu.updateFromFile",
        message: "desktop.patch.invalid.message",
        detail: usageDetail(h),
        buttons: ["desktop.patch.cancel"],
      })
      // No PII: the refused path is never logged.
      expect(JSON.stringify(h.logs)).not.toContain(HOME)
    })

  test("checkPatchPath accepts the normal case and returns the resolved target", async () => {
    expect(await checkPatchPath({ fs: fakeFs({}), path: P, resourcesPath: RES, home: HOME })).toEqual({ ok: true, target: TARGET })
  })
})

// ---- U3-U5 / UM-05, UM-06, C20 --------------------------------------------------------------------------------------

describe("UM-05 verify call", () => {
  test("argv, env keys, timeouts in ms (C20), maxBuffer", async () => {
    const h = harness({ responses: [1] })
    await h.flow()
    const [verify, status, keygen] = h.runs
    expect(verify!.file).toBe("/bin/zsh")
    expect(verify!.args).toEqual(["-f", APPLIER, "verify", P])
    expect(Object.keys(verify!.options.env).sort()).toEqual(["HOME", "LC_ALL", "PATH"])
    expect(verify!.options.env.HOME).toBe(HOME)
    expect(verify!.options.timeoutMs).toBe(600_000)
    expect(verify!.options.maxBuffer).toBe(PATCH_OUTPUT_MAX_BYTES)
    expect(status!.args).toEqual(["-f", APPLIER, "status"])
    expect(status!.options.timeoutMs).toBe(30_000)
    expect(status!.options.maxBuffer).toBe(PATCH_OUTPUT_MAX_BYTES)
    expect(keygen!.file).toBe("/usr/bin/ssh-keygen")
    expect(keygen!.args).toEqual(["-lf", "-"])
    expect(keygen!.options.timeoutMs).toBe(30_000)
    expect(keygen!.options.input).toBe(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAPw1AODJ+ROF5OOH0ryNjHVywneOJo6CK8BNSR/PUbe\n",
    )
    expect(h.runs).toHaveLength(3)
  })

  test("createExecFileRunner passes timeout in ms and maps errors without rejecting", async () => {
    const seen: Record<string, unknown>[] = []
    let reply: [Error | null, string, string] = [null, "out", "err"]
    const fakeExecFile = ((file: string, args: string[], options: Record<string, unknown>, cb: (...a: unknown[]) => void) => {
      seen.push({ file, args, ...options })
      queueMicrotask(() => cb(...reply))
      return { stdin: { on: () => {}, end: (_input: string) => {} } }
    }) as unknown as Parameters<typeof createExecFileRunner>[0]
    const run = createExecFileRunner(fakeExecFile)
    const options = { env: { HOME: "/h", PATH: "/usr/bin", LC_ALL: "C" }, timeoutMs: 600_000, maxBuffer: 16384 }
    expect(await run("/bin/zsh", ["-f", "a", "verify"], options)).toEqual({ code: 0, signal: null, stdout: "out", stderr: "err" })
    expect(seen[0]).toMatchObject({ file: "/bin/zsh", args: ["-f", "a", "verify"], timeout: 600_000, maxBuffer: 16384, env: options.env })

    reply = [Object.assign(new Error("x"), { code: 13 }), "", "swarm-patch: E_HASH: bad"]
    const exited = await run("/bin/zsh", [], options)
    expect(exited).toMatchObject({ code: 13, stderr: "swarm-patch: E_HASH: bad" })
    expect(exited.failure).toBeUndefined()
    reply = [Object.assign(new Error("x"), { killed: true, signal: "SIGTERM" }), "", ""]
    expect(await run("/bin/zsh", [], options)).toMatchObject({ code: null, failure: "timeout" })
    reply = [Object.assign(new Error("x"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), "", ""]
    expect(await run("/bin/zsh", [], options)).toMatchObject({ failure: "overflow" })
    reply = [Object.assign(new Error("x"), { code: "ENOENT" }), "", ""]
    expect(await run("/bin/zsh", [], options)).toMatchObject({ failure: "start", startCode: "ENOENT" })
    reply = [Object.assign(new Error("x"), { code: "weird code!" }), "", ""]
    const odd = await run("/bin/zsh", [], options)
    expect(odd).toMatchObject({ failure: "start" })
    expect(odd.startCode).toBeUndefined()
    // Killed by a signal the runner did not send: not a timeout.
    reply = [Object.assign(new Error("x"), { killed: false, signal: "SIGKILL" }), "", ""]
    const killed = await run("/bin/zsh", [], options)
    expect(killed).toMatchObject({ code: null, signal: "SIGKILL" })
    expect(killed.failure).toBeUndefined()

    const throwing = (() => {
      throw new Error("sync")
    }) as unknown as Parameters<typeof createExecFileRunner>[0]
    expect(await createExecFileRunner(throwing)("/bin/zsh", [], options)).toMatchObject({ failure: "start" })
  })
})

describe("UM-06 verify E_ codes", () => {
  const codes = [2, 10, 11, 12, 13, 14, 15, 21, 22, 23]
  for (const code of codes) {
    const name = PATCH_EXIT_NAMES[code]!
    test(`exit ${code} with S11: dialog shows the S11 line, 0 handoff`, async () => {
      const line = `swarm-patch: ${name}: mock reason ${code}`
      const h = harness({ verify: exit(code, `noise\n${line}\n`) })
      expect(await h.flow()).toBe("rejected")
      expect(h.dialogs).toHaveLength(1)
      expect(h.dialogs[0]).toMatchObject({ message: "desktop.patch.invalid.message", detail: h.t("desktop.patch.invalid.detail", { error: line }) })
      expect(h.handoffs).toHaveLength(0)
      expect(h.runs.map((r) => r.args[2])).toEqual(["verify"])
    })
    test(`exit ${code} without S11: swarm-patch: ${name}, 0 handoff`, async () => {
      const h = harness({ verify: exit(code, "not an s11 line\n") })
      expect(await h.flow()).toBe("rejected")
      expect(h.dialogs[0]!.detail).toBe(h.t("desktop.patch.invalid.detail", { error: `swarm-patch: ${name}` }))
      expect(h.handoffs).toHaveLength(0)
    })
  }

  test("S11 line is cut to 500 characters", () => {
    const line = "swarm-patch: E_HASH: " + "x".repeat(700)
    expect(patchErrorToken(exit(13, line), "verify")).toBe(line.slice(0, 500))
  })

  const odd: [string, PatchRunResult][] = [
    ["timeout", { code: null, signal: "SIGTERM", stdout: "", stderr: "", failure: "timeout" }],
    ["overflow", { code: null, signal: null, stdout: "", stderr: "", failure: "overflow" }],
    ["start failure", { code: null, signal: null, stdout: "", stderr: "", failure: "start" }],
    ["unknown exit 99", exit(99)],
    ["exit 0, unparsable stdout", ok("result=verified\n")],
    ["exit 0, duplicate key", ok(VERIFY_OK + "result=verified\n")],
    ["exit 0, result not verified", ok(VERIFY_OK.replace("result=verified", "result=applied"))],
    ["exit 0, bad semver", ok(VERIFY_OK.replace("release=1.1.3", "release=1.1"))],
    ["exit 0, bad migration", ok(VERIFY_OK.replace("migration=none", "migration=backward"))],
  ]
  // C27 D-3: timeout and overflow are distinct tokens; an unknown code stays `exit <n>`.
  const oddTokens: [string, PatchRunResult, string][] = [
    ["timeout", odd[0]![1], "swarm-patch: exit timeout"],
    ["overflow", odd[1]![1], "swarm-patch: exit overflow"],
    ["start failure", { ...odd[2]![1], startCode: "ENOENT" }, "swarm-patch: exit ENOENT"],
    ["unknown exit 99", exit(99), "swarm-patch: exit 99"],
  ]
  for (const [name, result, error] of oddTokens)
    test(`verify ${name}: ${error}, 0 handoff`, async () => {
      const h = harness({ verify: result })
      expect(await h.flow()).toBe("rejected")
      expect(h.dialogs[0]!.detail).toBe(h.t("desktop.patch.invalid.detail", { error }))
      expect(h.handoffs).toHaveLength(0)
    })

  for (const [name, result] of odd)
    test(`${name}: refused, 0 handoff`, async () => {
      const h = harness({ verify: result })
      expect(await h.flow()).toBe("rejected")
      expect(h.dialogs).toHaveLength(1)
      expect(h.dialogs[0]!.message).toBe("desktop.patch.invalid.message")
      expect(h.handoffs).toHaveLength(0)
    })

  test("parseVerifyOutput ignores other lines", () => {
    expect(parseVerifyOutput("hello\n" + VERIFY_OK + "extra=1\n")).toEqual({
      release: "1.1.3",
      fromRelease: "1.1.2",
      migration: "none",
      newKey: false,
    })
  })
})

// ---- U6 / UM-07 -----------------------------------------------------------------------------------------------------

describe("UM-07 new_key=yes", () => {
  test("warning BN-37/38, one Cancel button, no status, no confirm, 0 handoff", async () => {
    const h = harness({ verify: ok(VERIFY_OK.replace("new_key=no", "new_key=yes")) })
    expect(await h.flow()).toBe("new_key")
    expect(h.dialogs).toEqual([
      {
        type: "warning",
        title: "desktop.menu.updateFromFile",
        message: "desktop.patch.newKey.message",
        detail: "desktop.patch.newKey.detail",
        buttons: ["desktop.patch.cancel"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      },
    ])
    expect(h.runs.map((r) => r.args[2])).toEqual(["verify"])
    expect(h.handoffs).toHaveLength(0)
  })
})

// ---- U7-U9 / UM-08, UM-13 -------------------------------------------------------------------------------------------

describe("UM-08 confirm (migration=none)", () => {
  test("confirm dialog params and buttons", async () => {
    const h = harness({ responses: [1] })
    await h.flow()
    expect(h.dialogs).toEqual([
      {
        type: "question",
        title: "desktop.menu.updateFromFile",
        message: h.t("desktop.patch.confirm.message", { release: "1.1.3" }),
        detail: h.t("desktop.patch.confirm.detail", { installed: "1.1.2", release: "1.1.3", fingerprint: FP }),
        buttons: ["desktop.patch.confirm.update", "desktop.patch.cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      },
    ])
  })

  test("confirm declined (response 1): 0 handoff", async () => {
    const h = harness({ responses: [1] })
    expect(await h.flow()).toBe("declined")
    expect(h.handoffs).toHaveLength(0)
  })

  test("confirm dialog rejects: counts as cancel, 0 handoff", async () => {
    const h = harness({ responses: ["reject"] })
    expect(await h.flow()).toBe("declined")
    expect(h.handoffs).toHaveLength(0)
  })

  test("happy path: handoff exactly once with BN-61 apply argv (the launcher owns the quit path)", async () => {
    const h = harness({ responses: [0] })
    expect(await h.flow()).toBe("handoff")
    expect(h.handoffs).toEqual([["/bin/zsh", "-f", APPLIER, "apply", P]])
    expect(h.dialogs).toHaveLength(1)
    // Log carries release numbers, never the chosen path or the home folder.
    expect(JSON.stringify(h.logs)).not.toContain(HOME)
  })
})

describe("UM-13 status and fingerprint failures", () => {
  test("status release differs from verify from_release: 0 handoff", async () => {
    const h = harness({ status: ok(STATUS_OK.replace("release=1.1.2", "release=1.1.0")) })
    expect(await h.flow()).toBe("rejected")
    expect(h.dialogs[0]).toMatchObject({ message: "desktop.patch.invalid.message", detail: h.t("desktop.patch.invalid.detail", { error: "swarm-patch: exit 0" }) })
    expect(h.handoffs).toHaveLength(0)
  })

  test("status fails with S11: that line, 0 handoff", async () => {
    const line = "swarm-patch: E_SEAL: Info.plist missing"
    const h = harness({ status: exit(15, line + "\n") })
    expect(await h.flow()).toBe("rejected")
    expect(h.dialogs[0]!.detail).toBe(h.t("desktop.patch.invalid.detail", { error: line }))
    expect(h.handoffs).toHaveLength(0)
  })

  // C27 D-3 / spec U7: a status failure without S11 is `swarm-patch: exit <n>`, never an E_NAME (same text as Undo D1).
  const statusTokens: [string, PatchRunResult, string][] = [
    ["exit 21 without S11", exit(21, "noise\n"), "swarm-patch: exit 21"],
    ["timeout", { code: null, signal: "SIGTERM", stdout: "", stderr: "", failure: "timeout" }, "swarm-patch: exit timeout"],
    ["overflow", { code: null, signal: "SIGTERM", stdout: "", stderr: "", failure: "overflow" }, "swarm-patch: exit overflow"],
    ["exit 0, unparsable", ok("release=1.1.2\n"), "swarm-patch: exit 0"],
  ]
  for (const [name, status, error] of statusTokens)
    test(`status ${name}: ${error}, 0 handoff`, async () => {
      const h = harness({ status })
      expect(await h.flow()).toBe("rejected")
      expect(h.dialogs).toHaveLength(1)
      expect(h.dialogs[0]!.detail).toBe(h.t("desktop.patch.invalid.detail", { error }))
      expect(h.handoffs).toHaveLength(0)
    })

  test("status output not understood: 0 handoff", async () => {
    const h = harness({ status: ok("release=1.1.2\n") })
    expect(await h.flow()).toBe("rejected")
    expect(h.handoffs).toHaveLength(0)
  })

  test("ssh-keygen fails: ssh-keygen: exit 1, 0 handoff", async () => {
    const h = harness({ sshKeygen: exit(1) })
    expect(await h.flow()).toBe("rejected")
    expect(h.dialogs[0]!.detail).toBe(h.t("desktop.patch.invalid.detail", { error: "ssh-keygen: exit 1" }))
    expect(h.handoffs).toHaveLength(0)
  })

  test("ssh-keygen prints no fingerprint: 0 handoff", async () => {
    const h = harness({ sshKeygen: ok("garbage\n") })
    expect(await h.flow()).toBe("rejected")
    expect(h.handoffs).toHaveLength(0)
  })
})

// ---- U8 / UM-25 -----------------------------------------------------------------------------------------------------

describe("UM-25 anchor rules", () => {
  const key = ANCHOR.trim()
  const bad: [string, Entry][] = [
    ["two key lines", { kind: "file", content: `${key}\n${key}\n` }],
    ["no key line", { kind: "file", content: "# only a comment\n\n" }],
    ["unknown key type", { kind: "file", content: 'p namespaces="n" ssh-dss AAAAB3NzaC1kc3MAAACBAP\n' }],
    ["oversized anchor", { kind: "file", content: key, size: 4097 }],
    ["anchor is a symlink", { kind: "link", content: key }],
    ["anchor is a directory", { kind: "dir" }],
  ]
  for (const [name, entry] of bad)
    test(`${name}: E_SIGNATURE, ssh-keygen not run, 0 handoff`, async () => {
      const h = harness({ fs: fakeFs({ entries: { [SIGNERS]: entry } }) })
      expect(await h.flow()).toBe("rejected")
      expect(h.dialogs[0]!.detail).toBe(h.t("desktop.patch.invalid.detail", { error: "swarm-patch: E_SIGNATURE" }))
      expect(h.runs.some((r) => r.file === "/usr/bin/ssh-keygen")).toBe(false)
      expect(h.handoffs).toHaveLength(0)
    })

  test("anchor missing: E_SIGNATURE, 0 handoff", async () => {
    const fs = fakeFs({})
    const h = harness({ fs: { ...fs, lstat: (path) => (path === SIGNERS ? Promise.reject(new Error("ENOENT")) : fs.lstat(path)) } })
    expect(await h.flow()).toBe("rejected")
    expect(h.handoffs).toHaveLength(0)
  })

  test("comments and blank lines around one key line are accepted", async () => {
    const h = harness({ fs: fakeFs({ entries: { [SIGNERS]: { kind: "file", content: `# anchor\n\n${key}\n   \n` } } }), responses: [1] })
    expect(await h.flow()).toBe("declined")
    expect(h.runs.find((r) => r.file === "/usr/bin/ssh-keygen")?.options.input).toBe(`${key.split(" ").slice(2).join(" ")}\n`)
  })
})

// ---- U10 / UM-09, UM-20 ---------------------------------------------------------------------------------------------

describe("UM-09 forward migration", () => {
  test("decline first confirm: one dialog, 0 handoff", async () => {
    const h = harness({ verify: ok(VERIFY_FORWARD), responses: [1] })
    expect(await h.flow()).toBe("declined")
    expect(h.dialogs).toHaveLength(1)
    expect(h.handoffs).toHaveLength(0)
  })

  test("accept first, decline migration warning: 0 handoff", async () => {
    const h = harness({ verify: ok(VERIFY_FORWARD), responses: [0, 1] })
    expect(await h.flow()).toBe("declined")
    expect(h.dialogs).toHaveLength(2)
    expect(h.dialogs[1]).toMatchObject({
      type: "warning",
      message: "desktop.patch.confirm.migration",
      buttons: ["desktop.patch.confirm.update", "desktop.patch.cancel"],
      defaultId: 1,
      cancelId: 1,
    })
    expect(h.handoffs).toHaveLength(0)
  })

  test("migration warning dialog rejects: 0 handoff", async () => {
    const h = harness({ verify: ok(VERIFY_FORWARD), responses: [0, "reject"] })
    expect(await h.flow()).toBe("declined")
    expect(h.handoffs).toHaveLength(0)
  })

  test("accept both: handoff once with --accept-forward-migration", async () => {
    const h = harness({ verify: ok(VERIFY_FORWARD), responses: [0, 0] })
    expect(await h.flow()).toBe("handoff")
    expect(h.handoffs).toEqual([["/bin/zsh", "-f", APPLIER, "apply", "--accept-forward-migration", P]])
  })
})

describe("UM-20 BN-41 text (register 14.5-6 oracle, C21 #3)", () => {
  // Register 14.5-6, verbatim.
  const BN41 = "This update upgrades your stored data. After it is installed, Undo Last Update will not be possible."
  test("en catalogue holds the 14.5-6 text", () => {
    expect(DESKTOP_NATIVE_ENGLISH["desktop.patch.confirm.migration"]).toBe(BN41)
  })
  test("the forward-migration warning shows exactly the 14.5-6 text with nativeT", async () => {
    const h = harness({ verify: ok(VERIFY_FORWARD), responses: [0, 1], t: nativeT })
    await h.flow()
    expect(h.dialogs[1]!.message).toBe(BN41)
    expect(h.dialogs[1]!.title).toBe("Update from File…")
  })
})

// ---- U11 / UM-14 ----------------------------------------------------------------------------------------------------

describe("UM-14 handoff failure", () => {
  test("{ok:false}: BN-51 + BN-52 spawn: <code>, guard released (C27 D-1)", async () => {
    const guard = createPatchFlowGuard()
    const h = harness({ guard, responses: [0], handoff: { ok: false, code: "EACCES" } })
    expect(await h.flow()).toBe("handoff_failed")
    expect(h.handoffs).toHaveLength(1)
    expect(guard.tryEnter()).toBe(true)
    expect(h.dialogs[1]).toMatchObject({
      type: "error",
      message: "desktop.patch.result.failed.message",
      detail: h.t("desktop.patch.result.failed.detail", { error: "spawn: EACCES" }),
    })
  })

  test("handoff rejects: same dialog with the error code, guard released (C27 D-1)", async () => {
    const guard = createPatchFlowGuard()
    const h = harness({ guard, responses: [0], handoff: "reject" })
    expect(await h.flow()).toBe("handoff_failed")
    expect(h.dialogs[1]!.detail).toBe(h.t("desktop.patch.result.failed.detail", { error: "spawn: ENOENT" }))
    expect(guard.tryEnter()).toBe(true)
  })

  test("unexpected throw inside the flow: failed dialog, no crash, 0 handoff", async () => {
    const fs = fakeFs({})
    const h = harness({
      fs: {
        ...fs,
        lstat: () => {
          throw Object.assign(new Error("boom"), { code: "EIO" })
        },
      },
    })
    expect(await h.flow()).toBe("failed")
    expect(h.dialogs[0]!.detail).toBe(h.t("desktop.patch.result.failed.detail", { error: "update: EIO" }))
    expect(h.handoffs).toHaveLength(0)
    expect(h.logs.some((l) => l.level === "error")).toBe(true)
  })
})

// ---- M8 / UM-15 -----------------------------------------------------------------------------------------------------

describe("UM-15 guard", () => {
  test("two clicks while verify is pending: 1 verify", async () => {
    let release!: (r: PatchRunResult) => void
    const pending = new Promise<PatchRunResult>((done) => (release = done))
    const h = harness({ verify: () => pending, responses: [1] })
    const first = h.flow()
    await Bun.sleep(0)
    expect(await h.flow()).toBe("busy")
    release(ok(VERIFY_OK))
    expect(await first).toBe("declined")
    expect(h.runs.filter((r) => r.args[2] === "verify")).toHaveLength(1)
  })

  test("guard released after a decline, kept after a started handoff", async () => {
    const guard = createPatchFlowGuard()
    const declined = harness({ guard, responses: [1] })
    expect(await declined.flow()).toBe("declined")
    expect(guard.tryEnter()).toBe(true)
    guard.leave()
    const started = harness({ guard, responses: [0] })
    expect(await started.flow()).toBe("handoff")
    expect(await started.flow()).toBe("busy")
    expect(started.handoffs).toHaveLength(1)
  })

  test("disabled (enabled() false): no picker, 0 children, 0 handoff", async () => {
    const h = harness({ enabled: () => false })
    expect(await h.flow()).toBe("disabled")
    expect(h.pickers).toHaveLength(0)
    expect(h.runs).toHaveLength(0)
    expect(h.handoffs).toHaveLength(0)
  })
})

// ---- D52-3 / UM-26 with a real fixture in $T ------------------------------------------------------------------------

const T = realpathSync(mkdtempSync(join(tmpdir(), "swarm-row61-flow-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

describe("UM-26 / D52-3 patchMenuEnabled and state-folder run", () => {
  const home = join(T, "home")
  const state = join(home, "Library", "Application Support", "id.co.gsp.swarm.patch")
  const appRes = join(T, "apps", "Swarm.app", "Contents", "Resources")
  const backupRes = join(state, "previous", "Swarm.app", "Contents", "Resources")
  const bareRes = join(T, "bare", "Swarm.app", "Contents", "Resources")
  for (const res of [appRes, backupRes]) {
    mkdirSync(join(res, "swarm-patch"), { recursive: true })
    writeFileSync(join(res, "swarm-patch", "swarm-patch"), "exit 99\n")
  }
  mkdirSync(bareRes, { recursive: true })
  const linkRes = join(T, "link-res")
  symlinkSync(backupRes, linkRes)

  test("UM-02 applier present: true; absent: false", () => {
    expect(patchMenuEnabled({ resourcesPath: appRes, home })).toBe(true)
    expect(patchMenuEnabled({ resourcesPath: bareRes, home })).toBe(false)
  })

  test("resources inside the state folder: false", () => {
    expect(patchMenuEnabled({ resourcesPath: backupRes, home })).toBe(false)
  })

  test("resources reached through a symlink into the state folder: false", () => {
    expect(patchMenuEnabled({ resourcesPath: linkRes, home })).toBe(false)
  })

  test("state-folder run of the flow: disabled, no picker, 0 children, 0 handoff", async () => {
    // enabled is NOT injected: the default patchMenuEnabled over the real fixture decides.
    const runs: unknown[] = []
    const handoffs: unknown[] = []
    let pickers = 0
    const flow = createPatchUpdateFlow({
      window: () => null,
      showOpenDialog: async () => {
        pickers += 1
        return { canceled: false, filePaths: [P] }
      },
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
      t: (key) => key,
      resourcesPath: backupRes,
      home,
      handoff: async (argv) => {
        handoffs.push(argv)
        return { ok: true }
      },
      log: () => {},
      run: async (...args) => {
        runs.push(args)
        return exit(99)
      },
      guard: createPatchFlowGuard(),
    })
    expect(await flow()).toBe("disabled")
    expect(pickers).toBe(0)
    expect(runs).toHaveLength(0)
    expect(handoffs).toHaveLength(0)
  })
})

// ---- UM-10 with the real ssh-keygen ---------------------------------------------------------------------------------

describe("UM-10 fingerprint with the real ssh-keygen", () => {
  const home = join(T, "kg-home")
  mkdirSync(home, { recursive: true })
  const run = createExecFileRunner()

  test("bundled anchor gives the register fingerprint", async () => {
    const signers = join(import.meta.dir, "..", "..", "resources", "swarm-patch", "allowed_signers")
    expect(await anchorFingerprint({ fs: nodePatchFs, run, signers, home })).toEqual({ ok: true, fingerprint: FP })
  })

  test("synthetic anchor equals cut -d' ' -f3,4 | ssh-keygen -lf -", async () => {
    const keyFile = join(T, "synthetic")
    const made = spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "row61", "-f", keyFile], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    })
    expect(made.status).toBe(0)
    const pub = readFileSync(`${keyFile}.pub`, "utf8").trim().split(" ")
    const signers = join(T, "allowed_signers")
    writeFileSync(signers, `row61 namespaces="id.co.gsp.swarm.patch.v1" ${pub[0]} ${pub[1]}\n`)
    const fields = readFileSync(signers, "utf8").split(" ").slice(2, 4).join(" ")
    const oracle = spawnSync("/usr/bin/ssh-keygen", ["-lf", "-"], { input: fields, env: { HOME: home, PATH: "/usr/bin:/bin" } })
    const expected = /(SHA256:[A-Za-z0-9+/]{43})/.exec(String(oracle.stdout))?.[1]
    expect(expected).toBeDefined()
    expect(await anchorFingerprint({ fs: nodePatchFs, run, signers, home })).toEqual({ ok: true, fingerprint: expected! })
  })
})

// ---- UM-16 (runs last in this file) ---------------------------------------------------------------------------------

describe("UM-16 child calls", () => {
  test("only verify, status and ssh-keygen were ever run; apply/rollback never", () => {
    expect(allRunCalls.length).toBeGreaterThan(50)
    for (const call of allRunCalls) {
      if (call.file === "/usr/bin/ssh-keygen") {
        expect(call.args).toEqual(["-lf", "-"])
        continue
      }
      expect(call.file).toBe("/bin/zsh")
      expect(call.args[0]).toBe("-f")
      expect(["verify", "status"]).toContain(call.args[2]!)
      expect(call.args.includes("apply") || call.args.includes("rollback")).toBe(false)
    }
  })
})
