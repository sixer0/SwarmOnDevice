import { describe, expect, test } from "bun:test"
import {
  createExecFileRunner,
  createPatchFlowGuard,
  guardPatchFlow,
  parsePatchStatus,
  patchErrorToken,
  patchPathIsUnder,
  runPatchStatus,
  type PatchRunResult,
  patchApplierPath,
  patchChildEnv,
  patchStateDir,
  PATCH_OUTPUT_MAX_BYTES,
  PATCH_S11_LINE,
  PATCH_S11_MAX_CHARS,
  PATCH_SEMVER,
  PATCH_STATE_ID,
  PATCH_STATUS_TIMEOUT_S,
  PATCH_VERIFY_TIMEOUT_S,
} from "./patch-common"
import { PATCH_EXIT_NAMES } from "./patch-codes"

// Row 61: shared names merged by row 60 (register 14.2 R51-4a/4b/5, sections 2, 4, 6; SP-UPD S-1, M8).

describe("patch-common constants", () => {
  test("register 14.2 values, in seconds and bytes", () => {
    expect(PATCH_VERIFY_TIMEOUT_S).toBe(600)
    expect(PATCH_STATUS_TIMEOUT_S).toBe(30)
    expect(PATCH_OUTPUT_MAX_BYTES).toBe(16384)
    expect(PATCH_S11_MAX_CHARS).toBe(500)
    expect(PATCH_STATE_ID).toBe("id.co.gsp.swarm.patch")
  })

  test("semver per register section 2", () => {
    for (const ok of ["0.0.0", "1.1.2", "999999.0.1"]) expect(PATCH_SEMVER.test(ok)).toBe(true)
    for (const bad of ["01.1.1", "1.1", "1.1.1-rc", "1000000.0.0", " 1.1.1", ""]) expect(PATCH_SEMVER.test(bad)).toBe(false)
  })

  test("S11 line shape", () => {
    expect(PATCH_S11_LINE.test("swarm-patch: E_HASH: payload mismatch")).toBe(true)
    expect(PATCH_S11_LINE.test("swarm-patch: E_hash: x")).toBe(false)
    expect(PATCH_S11_LINE.test("other: E_HASH: x")).toBe(false)
    expect(PATCH_S11_LINE.test("swarm-patch: E_HASH: \x1b[31m")).toBe(false)
  })
})

describe("patch-common paths and env", () => {
  test("applier and state paths", () => {
    expect(patchApplierPath("/A/Swarm.app/Contents/Resources")).toBe(
      "/A/Swarm.app/Contents/Resources/swarm-patch/swarm-patch",
    )
    expect(patchStateDir("/Users/x")).toBe("/Users/x/Library/Application Support/id.co.gsp.swarm.patch")
  })

  test("child env has exactly HOME, PATH, LC_ALL (S23)", () => {
    const env = patchChildEnv("/h")
    expect(Object.keys(env).sort()).toEqual(["HOME", "LC_ALL", "PATH"])
    expect(env).toEqual({ HOME: "/h", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" })
  })
})

describe("createPatchFlowGuard (M8)", () => {
  test("second enter fails until leave", () => {
    const guard = createPatchFlowGuard()
    expect(guard.tryEnter()).toBe(true)
    expect(guard.tryEnter()).toBe(false)
    guard.leave()
    expect(guard.tryEnter()).toBe(true)
  })

  test("guards are independent objects", () => {
    const a = createPatchFlowGuard()
    const b = createPatchFlowGuard()
    expect(a.tryEnter()).toBe(true)
    expect(b.tryEnter()).toBe(true)
  })
})

describe("parsePatchStatus (S-1)", () => {
  const base = ["release=1.1.2", "bundle_version=1.19.3", "previous_release=1.1.1", "data_min_release=1.1.0", "journal_phase=idle"]

  test("five lines, trailing LF allowed", () => {
    expect(parsePatchStatus(base.join("\n") + "\n")).toEqual({
      release: "1.1.2",
      bundleVersion: "1.19.3",
      previousRelease: "1.1.1",
      dataMinRelease: "1.1.0",
      journalPhase: "idle",
      rollbackBlocked: false,
    })
    expect(parsePatchStatus(base.join("\n"))?.release).toBe("1.1.2")
  })

  test("sixth line only rollback_blocked=forward_migration", () => {
    expect(parsePatchStatus([...base, "rollback_blocked=forward_migration"].join("\n"))?.rollbackBlocked).toBe(true)
    expect(parsePatchStatus([...base, "rollback_blocked=yes"].join("\n"))).toBeUndefined()
  })

  test("empty previous and data_min releases accepted", () => {
    const lines = [...base]
    lines[2] = "previous_release="
    lines[3] = "data_min_release="
    expect(parsePatchStatus(lines.join("\n"))?.previousRelease).toBe("")
  })

  const bad: [string, string][] = [
    ["4 lines", base.slice(0, 4).join("\n")],
    ["7 lines", [...base, "rollback_blocked=forward_migration", "x=1"].join("\n")],
    ["order swapped", [base[1], base[0], ...base.slice(2)].join("\n")],
    ["bad release", ["release=1.1", ...base.slice(1)].join("\n")],
    ["empty release", ["release=", ...base.slice(1)].join("\n")],
    ["bad previous", [base[0], base[1], "previous_release=x", base[3], base[4]].join("\n")],
    ["unknown phase", [...base.slice(0, 4), "journal_phase=weird"].join("\n")],
    ["non-printable bundle", [base[0], "bundle_version=\x1b", ...base.slice(2)].join("\n")],
    ["CRLF", base.join("\r\n")],
    ["empty", ""],
  ]
  for (const [name, input] of bad) test(`refuses: ${name}`, () => expect(parsePatchStatus(input)).toBeUndefined())

  test("every journal phase of spec 7 parses", () => {
    for (const phase of ["none", "idle", "staged", "old_moved", "new_placed", "rollback_staged", "rollback_moved", "rollback_placed", "invalid"])
      expect(parsePatchStatus([...base.slice(0, 4), `journal_phase=${phase}`].join("\n"))?.journalPhase).toBe(phase)
  })
})

// ---- row 65a (C27): one guard policy, one runner, one error token, one state-folder helper -------------------------

describe("guardPatchFlow (C27 D-1)", () => {
  test("busy while the body runs: the body is not entered twice", async () => {
    const guard = createPatchFlowGuard()
    let entered = 0
    let release!: () => void
    const pending = new Promise<void>((done) => (release = done))
    const run = guardPatchFlow(guard, "handed_off", async () => {
      entered += 1
      await pending
      return "cancelled" as "cancelled" | "handed_off"
    })
    const first = run()
    expect(await run()).toBe("busy")
    release()
    expect(await first).toBe("cancelled")
    expect(entered).toBe(1)
  })

  test("kept after the handed-off outcome, released after any other", async () => {
    const kept = createPatchFlowGuard()
    expect(await guardPatchFlow(kept, "handed_off", async () => "handed_off")()).toBe("handed_off")
    expect(kept.tryEnter()).toBe(false)
    for (const outcome of ["cancelled", "handoff_failed", "rejected", "disabled"]) {
      const guard = createPatchFlowGuard()
      expect(await guardPatchFlow(guard, "handed_off", async () => outcome)()).toBe(outcome)
      expect(guard.tryEnter()).toBe(true)
    }
  })

  test("released when the body throws; the error reaches the caller", async () => {
    const guard = createPatchFlowGuard()
    const run = guardPatchFlow(guard, "handed_off", async (): Promise<string> => {
      throw new Error("boom")
    })
    await expect(run()).rejects.toThrow("boom")
    expect(guard.tryEnter()).toBe(true)
  })
})

describe("patchErrorToken (C27 D-3)", () => {
  const r = (over: Partial<PatchRunResult>): PatchRunResult => ({ code: null, signal: null, stdout: "", stderr: "", ...over })
  const s11 = "swarm-patch: E_DISK: not enough space"

  test("S11 line wins for both subcommands, cut to the limit", () => {
    expect(patchErrorToken(r({ code: 21, stderr: `x\n${s11}\n` }), "status")).toBe(s11)
    expect(patchErrorToken(r({ code: 21, stderr: `x\n${s11}\n` }), "verify")).toBe(s11)
    const long = "swarm-patch: E_HASH: " + "z".repeat(900)
    expect(patchErrorToken(r({ code: 13, stderr: long }), "status")).toHaveLength(PATCH_S11_MAX_CHARS)
  })

  test("status: exit <n>, never an E_NAME", () => {
    expect(patchErrorToken(r({ code: 21 }), "status")).toBe("swarm-patch: exit 21")
    expect(patchErrorToken(r({ code: 0 }), "status")).toBe("swarm-patch: exit 0")
  })

  test("verify: E_NAME for a known non-zero code, else exit <n>", () => {
    expect(patchErrorToken(r({ code: 21 }), "verify")).toBe("swarm-patch: E_DISK")
    expect(patchErrorToken(r({ code: 99 }), "verify")).toBe("swarm-patch: exit 99")
    expect(patchErrorToken(r({ code: 0 }), "verify")).toBe("swarm-patch: exit 0")
  })

  test("timeout, overflow and start failures are distinct in both forms", () => {
    for (const sub of ["status", "verify"] as const) {
      expect(patchErrorToken(r({ signal: "SIGTERM", failure: "timeout" }), sub)).toBe("swarm-patch: exit timeout")
      expect(patchErrorToken(r({ signal: "SIGTERM", failure: "overflow" }), sub)).toBe("swarm-patch: exit overflow")
      expect(patchErrorToken(r({ failure: "start", startCode: "ENOENT" }), sub)).toBe("swarm-patch: exit ENOENT")
      expect(patchErrorToken(r({ failure: "start" }), sub)).toBe("swarm-patch: exit start")
      expect(patchErrorToken(r({ signal: "SIGKILL" }), sub)).toBe("swarm-patch: exit SIGKILL")
      expect(patchErrorToken(r({ signal: "bogus\n" }), sub)).toBe("swarm-patch: exit unknown")
    }
  })

  test("the exit table is register section 7", () => {
    expect(PATCH_EXIT_NAMES[2]).toBe("E_USAGE")
    expect(PATCH_EXIT_NAMES[11]).toBe("E_SIGNATURE")
    expect(PATCH_EXIT_NAMES[31]).toBe("E_RECOVER")
  })
})

describe("createExecFileRunner and runPatchStatus (C27 M3)", () => {
  test("stdin is always closed, empty when no input is given", async () => {
    const ended: string[] = []
    const fake = ((_f: string, _a: string[], _o: unknown, cb: (...a: unknown[]) => void) => {
      queueMicrotask(() => cb(null, "", ""))
      return { stdin: { on: () => {}, end: (input: string) => ended.push(input) } }
    }) as unknown as Parameters<typeof createExecFileRunner>[0]
    const run = createExecFileRunner(fake)
    const options = { env: {}, timeoutMs: 1, maxBuffer: 1 }
    await run("/bin/zsh", [], options)
    await run("/usr/bin/ssh-keygen", [], { ...options, input: "k\n" })
    expect(ended).toEqual(["", "k\n"])
  })

  test("runPatchStatus: argv, env, timeout x 1000, maxBuffer; status token on failure", async () => {
    const seen: unknown[] = []
    const result = await runPatchStatus({
      applier: "/R/swarm-patch/swarm-patch",
      home: "/h",
      run: async (file, args, options) => {
        seen.push({ file, args, options })
        return { code: 21, signal: null, stdout: "", stderr: "" }
      },
    })
    expect(seen).toEqual([
      {
        file: "/bin/zsh",
        args: ["-f", "/R/swarm-patch/swarm-patch", "status"],
        options: { env: patchChildEnv("/h"), timeoutMs: PATCH_STATUS_TIMEOUT_S * 1000, maxBuffer: PATCH_OUTPUT_MAX_BYTES },
      },
    ])
    expect(result).toEqual({ ok: false, error: "swarm-patch: exit 21" })
  })
})

describe("patchPathIsUnder (C27 L1 / N-6)", () => {
  test("equal or below, case-insensitive, trailing slash on the root ignored", () => {
    expect(patchPathIsUnder("/Users/T/a", "/Users/T/a")).toBe(true)
    expect(patchPathIsUnder("/users/t/A/b", "/Users/T/a/")).toBe(true)
    expect(patchPathIsUnder("/Users/T/ab", "/Users/T/a")).toBe(false)
    expect(patchPathIsUnder("/Users/T", "/Users/T/a")).toBe(false)
  })
})
