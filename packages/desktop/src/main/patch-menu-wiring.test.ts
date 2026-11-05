import { afterAll, describe, expect, mock, test } from "bun:test"
import type { MenuItemConstructorOptions } from "electron"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

// Row 61: row 60 wiring. menu.ts maps `enabled: "patch"` to PATCH_MENU_ENABLED (14.5-8 / D52-3) and routes the two
// actions through desktop-menu-actions.ts; index.ts shares one handoff and one M8 guard. Electron and ./windows are
// mocked here (no real Electron). index.ts itself cannot be imported in a test (top-level app start), so its wiring is
// checked by reading its source; the shared-guard behaviour is checked by building both flows the way index.ts does.
//
// Row 64b: bun's mock.module is process-wide and is not undone after this file, so mocking "electron" / "./windows"
// here broke later files in the same `bun test` run (onboarding.test.ts lost Electron's `app`). The mocks and every
// electron-dependent import (menu.ts, desktop-menu-actions.ts) now live only in a child `bun test` process
// (SWARM_ROW61_CHILD=1, fixture HOME for UM-26). The parent process installs no module mock.

const CHILD = process.env.SWARM_ROW61_CHILD === "1"

let template: MenuItemConstructorOptions[] = []
async function loadMocked() {
  mock.module("electron", () => ({
    BrowserWindow: { getFocusedWindow: () => null },
    Menu: {
      buildFromTemplate: (t: MenuItemConstructorOptions[]) => {
        template = t
        return { template: t }
      },
      setApplicationMenu: () => {},
    },
  }))
  mock.module("./windows", () => ({
    openExternalURL: () => {},
    createMainWindow: () => {},
    updateTitlebar: () => {},
  }))
  const { createMenu } = await import("./menu")
  const { runDesktopMenuAction } = await import("./desktop-menu-actions")
  return { createMenu, runDesktopMenuAction }
}
const mocked = CHILD ? await loadMocked() : undefined
const createMenu: Awaited<ReturnType<typeof loadMocked>>["createMenu"] = (deps) => mocked!.createMenu(deps)
const runDesktopMenuAction: Awaited<ReturnType<typeof loadMocked>>["runDesktopMenuAction"] = (...args) =>
  mocked!.runDesktopMenuAction(...args)

const { nativeT } = await import("./native-translations")
const { createPatchFlowGuard } = await import("./patch-common")
const { createPatchUpdateFlow } = await import("./patch-update-flow")
const { createUndoLastUpdate } = await import("./patch-undo")
const T = realpathSync(mkdtempSync(join(tmpdir(), "swarm-row61-wiring-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

function fixtureRes(root: string, withApplier: boolean) {
  const res = join(root, "Swarm.app", "Contents", "Resources")
  mkdirSync(join(res, "swarm-patch"), { recursive: true })
  if (withApplier) writeFileSync(join(res, "swarm-patch", "swarm-patch"), "exit 99\n")
  return res
}

function buildMenu(resourcesPath: string) {
  const calls: string[] = []
  const deps = {
    trigger: (id: string) => calls.push(`trigger:${id}`),
    checkForUpdates: () => calls.push("checkForUpdates"),
    installCli: () => calls.push("installCli"),
    relaunch: () => calls.push("relaunch"),
    updateFromFile: () => calls.push("updateFromFile"),
    undoLastUpdate: () => calls.push("undoLastUpdate"),
  }
  const previous = process.resourcesPath
  Object.defineProperty(process, "resourcesPath", { value: resourcesPath, configurable: true, writable: true })
  try {
    template = []
    createMenu(deps)
  } finally {
    Object.defineProperty(process, "resourcesPath", { value: previous, configurable: true, writable: true })
  }
  const appMenu = template.find((menu) =>
    (menu.submenu as MenuItemConstructorOptions[] | undefined)?.some((item) => item.label === nativeT("desktop.menu.updateFromFile")),
  )
  const items = (appMenu?.submenu ?? []) as MenuItemConstructorOptions[]
  const find = (key: "desktop.menu.updateFromFile" | "desktop.menu.undoLastUpdate" | "desktop.menu.checkForUpdates") =>
    items.find((item) => item.label === nativeT(key))
  return { items, calls, update: find("desktop.menu.updateFromFile"), undo: find("desktop.menu.undoLastUpdate"), check: find("desktop.menu.checkForUpdates") }
}

const click = (item: MenuItemConstructorOptions | undefined) =>
  (item?.click as unknown as (() => void) | undefined)?.()

// Parent: one child `bun test` runs every case that needs the electron / ./windows mocks (the describes marked
// `.if(CHILD)` below), with HOME set to a fixture home so UM-26 can place the running "app" in its state folder.
test.if(!CHILD)("electron-dependent wiring cases pass in an isolated child bun process (fixture HOME)", () => {
  const home = join(T, "child-home")
  mkdirSync(home, { recursive: true })
  const child = spawnSync(process.execPath, ["test", import.meta.path], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, HOME: home, SWARM_ROW61_CHILD: "1" },
    encoding: "utf8",
    timeout: 60_000,
  })
  const out = `${child.stdout}\n${child.stderr}`
  // darwin: 4 menu.ts cases (UM-01 order, applier absent, clicks, UM-26) + 2 desktop-menu-actions cases.
  const expected = process.platform === "darwin" ? 6 : 2
  expect({ status: child.status, out }).toMatchObject({ status: 0 })
  expect(out).toMatch(new RegExp(`\\b${expected} pass\\b`))
  expect(out).toMatch(/\b0 fail\b/)
})

describe.if(CHILD && process.platform === "darwin")("menu.ts (UM-01 / UM-02)", () => {
  test("order Check for Updates, Update from File…, Undo Last Update; patch items enabled with the applier", () => {
    const m = buildMenu(fixtureRes(join(T, "with"), true))
    const labels = m.items.map((item) => item.label)
    const i = labels.indexOf(nativeT("desktop.menu.checkForUpdates"))
    expect(i).toBeGreaterThanOrEqual(0)
    expect(labels.slice(i, i + 3)).toEqual([nativeT("desktop.menu.checkForUpdates"), "Update from File…", "Undo Last Update"])
    expect(m.update?.enabled).toBe(true)
    expect(m.undo?.enabled).toBe(true)
    // "updater" keeps UPDATER_ENABLED (false for Swarm).
    expect(m.check?.enabled).toBe(false)
  })

  test("applier absent: both patch items disabled", () => {
    const m = buildMenu(fixtureRes(join(T, "without"), false))
    expect(m.update?.enabled).toBe(false)
    expect(m.undo?.enabled).toBe(false)
  })

  test("clicks call only the injected handler, once each", () => {
    const m = buildMenu(fixtureRes(join(T, "clicks"), true))
    click(m.update)
    expect(m.calls).toEqual(["updateFromFile"])
    click(m.undo)
    expect(m.calls).toEqual(["updateFromFile", "undoLastUpdate"])
  })

  // UM-26 through the menu: homedir() is read once at process start, so this case relies on the child bun process
  // having HOME set to a fixture home whose state folder holds the running "app".
  test("child: resources inside <HOME>/…/id.co.gsp.swarm.patch: both items disabled", () => {
    const state = join(homedir(), "Library", "Application Support", "id.co.gsp.swarm.patch", "previous")
    expect(homedir().startsWith(tmpdir()) || homedir().startsWith("/private/")).toBe(true)
    const m = buildMenu(fixtureRes(state, true))
    expect(m.update?.enabled).toBe(false)
    expect(m.undo?.enabled).toBe(false)
  })
})

describe.if(CHILD)("desktop-menu-actions.ts (M7)", () => {
  test("app.updateFromFile / app.undoLastUpdate call only their handler", () => {
    const calls: string[] = []
    const handlers = {
      checkForUpdates: () => calls.push("check"),
      installCli: () => calls.push("cli"),
      relaunch: () => calls.push("relaunch"),
      updateFromFile: () => calls.push("update"),
      undoLastUpdate: () => calls.push("undo"),
    }
    runDesktopMenuAction(null, "app.updateFromFile", handlers)
    runDesktopMenuAction(null, "app.undoLastUpdate", handlers)
    expect(calls).toEqual(["update", "undo"])
  })

  test("missing handler: no throw", () => {
    expect(() => runDesktopMenuAction(null, "app.updateFromFile", {})).not.toThrow()
    expect(() => runDesktopMenuAction(null, "app.undoLastUpdate")).not.toThrow()
  })
})

// The parent runs the cases below (no module mock needed); the child skips them so it runs only the mocked cases.
describe.if(!CHILD)("one shared M8 guard across both flows (index.ts wiring)", () => {
  const RES = "/Apps/Swarm.app/Contents/Resources"
  const STATUS = "release=1.1.2\nbundle_version=1.19.3\nprevious_release=1.1.1\ndata_min_release=1.1.0\njournal_phase=idle\n"
  function build(opts: { updateAnswer?: number; undoStatus?: string } = {}) {
    const guard = createPatchFlowGuard()
    const handoffs: (readonly string[])[] = []
    const handoff = async (argv: readonly string[]) => {
      handoffs.push(argv)
      return { ok: true as const }
    }
    let releaseVerify!: () => void
    const verifyPending = new Promise<void>((done) => (releaseVerify = done))
    const runs: string[] = []
    const update = createPatchUpdateFlow({
      window: () => null,
      showOpenDialog: async () => ({ canceled: false, filePaths: ["/Users/t/x.swarmpatch"] }),
      showMessageBox: async () => ({ response: opts.updateAnswer ?? 1, checkboxChecked: false }),
      t: nativeT,
      resourcesPath: RES,
      home: "/Users/t",
      handoff,
      log: () => {},
      run: async (file, args) => {
        if (file === "/usr/bin/ssh-keygen")
          return { code: 0, signal: null, stdout: `256 SHA256:${"A".repeat(43)} k (ED25519)\n`, stderr: "" }
        runs.push(String(args[2]))
        await verifyPending
        if (opts.updateAnswer === undefined) return { code: 2, signal: null, stdout: "", stderr: "" }
        const stdout =
          args[2] === "verify"
            ? "result=verified\nrelease=1.1.3\nfrom_release=1.1.2\nmigration=none\nnew_key=no\n"
            : STATUS
        return { code: 0, signal: null, stdout, stderr: "" }
      },
      fs: {
        lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 }),
        realpath: async (p) => p,
        readFile: async () => 'p namespaces="n" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAPw1AODJ+ROF5OOH0ryNjHVywneOJo6CK8BNSR/PUbe\n',
        accessWritable: async () => {},
      },
      guard,
      enabled: () => true,
    })
    const execs: string[] = []
    const undo = createUndoLastUpdate({
      window: () => null,
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
      handoff,
      resourcesPath: () => RES,
      homedir: () => "/Users/t",
      realpath: (p) => p,
      exists: () => true,
      run: async (_f, args) => {
        execs.push(String(args[2]))
        return { code: 0, signal: null, stdout: opts.undoStatus ?? "", stderr: "" }
      },
      guard,
    })
    return { update, undo, handoffs, runs, execs, releaseVerify }
  }

  test("Undo clicked while Update's verify runs: busy, 0 children, 0 handoff", async () => {
    const w = build()
    const running = w.update()
    await Bun.sleep(0)
    expect(await w.undo()).toBe("busy")
    expect(w.execs).toHaveLength(0)
    w.releaseVerify()
    expect(await running).toBe("rejected")
    expect(w.runs).toEqual(["verify"])
    expect(w.handoffs).toHaveLength(0)
    // Released after the refusal: Undo runs now (status output empty -> D1, still no handoff).
    expect(await w.undo()).toBe("status_failed")
    expect(w.handoffs).toHaveLength(0)
  })

  // C27 D-1: one policy for both flows. After either flow starts a handoff the app is quitting, so the shared guard
  // stays held and the other item does nothing.
  test("after Undo hands off: Update is busy, no picker run, 1 handoff in total", async () => {
    const w = build({ undoStatus: STATUS })
    w.releaseVerify()
    expect(await w.undo()).toBe("handed_off")
    expect(await w.update()).toBe("busy")
    expect(await w.undo()).toBe("busy")
    expect(w.runs).toHaveLength(0)
    expect(w.handoffs).toHaveLength(1)
  })

  test("after Update hands off: Undo is busy, 0 status calls, 1 handoff in total", async () => {
    const w = build({ updateAnswer: 0 })
    w.releaseVerify()
    expect(await w.update()).toBe("handoff")
    expect(await w.undo()).toBe("busy")
    expect(await w.update()).toBe("busy")
    expect(w.execs).toHaveLength(0)
    expect(w.handoffs).toHaveLength(1)
  })
})

// C27 M6 (accepted residual): these cases read index.ts as text on purpose. Importing index.ts starts the app
// (`Effect.runFork(main)` at module top level: Electron app, sidecars, windows), so its wiring cannot be exercised in a
// unit test. Behaviour of the wired pieces is covered above and in the flow tests; this block only pins the wiring.
describe.if(!CHILD)("index.ts wiring (source)", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
  test("one guard, passed to both flows", () => {
    expect(src.match(/createPatchFlowGuard\(\)/g)).toHaveLength(1)
    expect(src.match(/guard: patchGuard/g)).toHaveLength(2)
  })
  test("one handoff launcher, adapted once and passed to both flows", () => {
    expect(src.match(/createHandoffLauncher\(/g)).toHaveLength(1)
    expect(src).toContain("const handoff = (applierArgv: readonly string[]) => launchHandoff([...applierArgv])")
    expect(src.match(/^\s+handoff,$/gm)?.length).toBe(2)
  })
  test("no exitForHandoff seam (the launcher quits, C27 L2), logs go to the swarm-patch scope", () => {
    expect(src).not.toContain("exitForHandoff")
    expect(src).toContain('writeLog("swarm-patch", message, extra, level)')
  })
  test("menu handlers run the flows and catch to the logger", () => {
    expect(src).toContain("updateFromFile: () => void updateFromFile().catch(")
    expect(src).toContain("undoLastUpdate: () => void undoLastUpdate().catch(")
  })
  test("result reader wired with the BN-64 file name in userData", () => {
    expect(src).toContain("createPatchResultReader({")
    expect(src).toMatch(/join\([^)]*userData[^)]*HANDOFF_RESULT_FILE_NAME\)|HANDOFF_RESULT_FILE_NAME/)
  })
})

// C27 M6: UM-09, UM-21 and UM-16 are defined in spec 04 as literal greps over the module sources, so they read text.
describe.if(!CHILD)("static checks over the menu-layer modules", () => {
  const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8")
  const modules = ["patch-update-flow.ts", "patch-undo.ts", "swarm-patch-result.ts", "patch-common.ts"]

  // UM-09 / UM-21 are defined as literal greps (spec 04:273, :285). Each has one literal hit that is not behaviour:
  // swarm-patch-handoff.ts:150 names the option in a comment, swarm-patch-result.ts:160 holds an i18n KEY that is
  // translated through t() when shown. Requests filed to rows 57 and 58 (file_requests.md, row 61). The strict greps
  // are test.failing until those one-line fixes land (then flip them to test); the code-only checks must pass now.
  const codeLines = (name: string) =>
    read(name)
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))

  test("UM-09 (code): --accept-new-key never occurs outside comments (rows 56, 57, 59, 60)", () => {
    for (const name of [...modules, "swarm-patch-handoff.ts"])
      expect({ name, hits: codeLines(name).filter((l) => l.includes("--accept-new-key")) }).toEqual({ name, hits: [] })
  })

  test("UM-09 (strict grep -c = 0): blocked by the comment at swarm-patch-handoff.ts:150 (request row 61 -> row 57)", () => {
    for (const name of [...modules, "swarm-patch-handoff.ts"]) expect(read(name).split("--accept-new-key").length - 1).toBe(0)
  })

  const literalText = /(message|detail|title|name): *['"`]/
  const keyLiteral = /(message|detail|title|name): *"desktop\.[A-Za-z.]+"/

  test("UM-21 (code): no literal display text; only i18n keys that t() translates", () => {
    for (const name of modules) {
      const hits = codeLines(name).filter((line) => literalText.test(line) && !keyLiteral.test(line))
      expect({ name, hits }).toEqual({ name, hits: [] })
    }
  })

  test("UM-21 (strict grep = 0): blocked by the key literal at swarm-patch-result.ts:160 (request row 61 -> row 58)", () => {
    for (const name of modules) expect(read(name).split("\n").filter((line) => literalText.test(line))).toEqual([])
  })

  test("UM-16: \"apply\"/\"rollback\" literals only in BN-61 handoff argv lines", () => {
    for (const name of ["patch-update-flow.ts", "patch-undo.ts"]) {
      const lines = read(name)
        .split("\n")
        .filter((line) => /"(apply|rollback)"/.test(line))
      for (const line of lines) expect(line).toMatch(/\["\/bin\/zsh", "-f", (paths\.)?applier, "(apply|rollback)"/)
    }
  })
})
