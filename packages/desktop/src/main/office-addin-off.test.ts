import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OFFICE_ADDIN_ENABLED_KEY, SETTINGS_STORE } from "./store-keys"

// Office add-in plan row M7-05: U-DT-04 (setting defaults to false) and SD-AC-2 (with the setting off nothing listens on
// 46317 and no office-addin/ folder exists). index.ts is read as source (it runs Electron at module load); the
// controller it would load is exercised for real with the setting off.

const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const transpiler = new Bun.Transpiler({ loader: "ts" })

describe("U-DT-04 officeAddinEnabled defaults to false", () => {
  test("the key lives in the opencode.settings store under officeAddinEnabled", () => {
    expect(SETTINGS_STORE).toBe("opencode.settings")
    expect(OFFICE_ADDIN_ENABLED_KEY).toBe("officeAddinEnabled")
  })

  test("index.ts treats anything but a stored true as off, and only the controller writes the key", () => {
    const reads = source.match(/getStore\(\)\.get\(OFFICE_ADDIN_ENABLED_KEY\)[^\n]*/g) ?? []
    expect(reads).toHaveLength(2)
    expect(reads.every((line) => line.startsWith("getStore().get(OFFICE_ADDIN_ENABLED_KEY) === true"))).toBe(true)
    expect(source.match(/getStore\(\)\.set\(OFFICE_ADDIN_ENABLED_KEY, [^)]*\)/g)).toEqual([
      "getStore().set(OFFICE_ADDIN_ENABLED_KEY, value)",
    ])
    expect(source).toContain("setEnabled: (value) => getStore().set(OFFICE_ADDIN_ENABLED_KEY, value),")
  })
})

describe("SD-AC-2 off: no controller import, no fork, no office-addin/ folder", () => {
  test("index.ts has no static import of any office-addin or office-bridge module", () => {
    const office = transpiler
      .scanImports(source)
      .filter((item) => item.path.includes("office-addin") || item.path.includes("office-bridge"))
    expect(office.length).toBeGreaterThan(0)
    expect(office.filter((item) => item.kind !== "dynamic-import")).toEqual([])
    expect(office.map((item) => item.path).sort()).toEqual(["./office-addin/controller", "./office-addin/pair-dialog"])
  })

  test("the controller is loaded only by an auto-start guarded by darwin, v1 and the setting, or by a menu click", () => {
    expect(source.split('import("./office-addin/controller")').length - 1).toBe(1)
    const loadStart = source.indexOf("const loadOfficeAddin = () => {")
    expect(loadStart).toBeGreaterThan(0)
    expect(source.indexOf('import("./office-addin/controller")')).toBeGreaterThan(loadStart)
    // Two callers: the guarded auto-start and the menu action. stopSidecars only awaits a load already started.
    expect(source.split("loadOfficeAddin()").length - 1).toBe(2)
    expect(source).toContain(
      '  if (process.platform === "darwin" && SIDECAR_VERSION !== "v2" && getStore().get(OFFICE_ADDIN_ENABLED_KEY) === true) {\n    void loadOfficeAddin()\n      .then((controller) => controller.launch())',
    )
    expect(source).toContain("void loadOfficeAddin()\n      .then((controller) => controller.menuHandlers()[name]())")
    const stop = source.slice(source.indexOf("const stopSidecars = async () => {"), source.indexOf("const relaunch = () => {"))
    expect(stop).toContain("officeAddin.loading\n        ?.then((controller) => controller.shutdown())")
    expect(stop).not.toContain("loadOfficeAddin")
    expect(stop).toContain("await Promise.all([")
  })

  test("M7-05a (C65): with the v2 sidecar the menu gets no toggle handler, so Enable is greyed out", () => {
    const menu = source.slice(source.indexOf("const rebuildMenu = () =>"), source.indexOf("const ipc = registerIpcHandlers("))
    expect(menu).toContain('officeAddinToggle: SIDECAR_VERSION === "v2" ? undefined : officeAddinAction("officeAddinToggle"),')
    expect(source).toContain('const SIDECAR_VERSION = process.env.OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"')
    const menuSource = readFileSync(join(import.meta.dir, "menu.ts"), "utf8")
    expect(menuSource).toContain("if (!deps.officeAddinToggle) item.enabled = false")
  })

  describe("the controller with the setting off", () => {
    const dirs: string[] = []
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    })

    test("creating it, launching, reading its state and shutting down write nothing and fork nothing", async () => {
      const { createOfficeAddinController } = await import("./office-addin/controller")
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "swarm-m705-off-")))
      dirs.push(dir)
      const userData = join(dir, "userData")
      const forks: string[] = []
      const states: string[] = []
      const boxes: unknown[] = []
      const controller = createOfficeAddinController({
        userDataDir: userData,
        resources: { packaged: true, resourcesPath: join(dir, "Resources"), devPackageDir: join(dir, "office-addin") },
        bridgeEntryPath: join(dir, "office-bridge.js"),
        baseEnv: { HOME: dir },
        server: async () => ({ url: "http://127.0.0.1:4096", username: "opencode", password: "synthetic" }),
        settings: { enabled: () => false, setEnabled: () => {} },
        fork: (modulePath) => {
          forks.push(modulePath)
          throw new Error("fork must not be called while off")
        },
        dialog: {
          showMessageBox: async (options) => {
            boxes.push(options)
            return { response: 1, checkboxChecked: false }
          },
        },
        shell: { showItemInFolder: () => {}, openPath: async () => "" },
        pairDialog: {
          window: () => null,
          showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
          focus: () => {},
        },
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: () => Buffer.from(""),
          decryptString: () => "",
        },
        home: join(dir, "home"),
        wefRoots: [join(dir, "home", "wef")],
        cacheRoot: join(dir, "home", "cache"),
        log: () => {},
        onStateChange: (state) => states.push(state),
      })
      expect(await controller.launch()).toEqual({ ok: false, reason: "disabled" })
      expect(controller.state()).toBe("off")
      expect(controller.menuHandlers().officeAddinState()).toBe("off")
      await controller.shutdown()
      await controller.idle()
      expect(forks).toEqual([])
      expect(states).toEqual([])
      expect(boxes).toEqual([])
      expect(readdirSync(dir)).toEqual([])
    })
  })
})
