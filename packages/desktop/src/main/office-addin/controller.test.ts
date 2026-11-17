// Plan rows M7-03 and M7-04: the controller against the in-process bridge runner (TR-5): the fake utility process drives the
// real `runOfficeBridge` adapter with a stub core factory. Electron surfaces (dialog, shell, safeStorage, keychain,
// utilityProcess, clock) are injected doubles; certificates are real (certs.ts), written under $TMPDIR; wef roots are
// temp folders, refusals are injected through WefFs (no real Word/Excel folder, no real keychain).
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { BrowserWindow, MessageBoxOptions } from "electron"
import { DESKTOP_NATIVE_ENGLISH } from "@opencode-ai/app/i18n/desktop-native"
import { OFFICE_MANIFEST_FILE } from "@swarm/office-addin/constants"
import { runOfficeBridge } from "../office-bridge"
import type { BridgeCommand, BridgeFactory, PairRequest, PairRequestSink } from "../office-bridge/protocol"
import {
  BRIDGE_ENV_ALLOW,
  bridgeEnv,
  PAIR_AFTER_INFO_MS,
  createOfficeAddinController,
  defaultCacheRoot,
  errorKey,
  officeCertPaths,
  officeResourcePaths,
  type BridgeChild,
  type ControllerClock,
  type ForkBridge,
  type OfficeAddinControllerDeps,
} from "./controller"
import type { Keychain } from "./keychain"
import { nodeWefFs, type WefFs } from "./wef"

setDefaultTimeout(20_000)

const PASSWORD = "sidecar-secret-password-xyz"
const MANIFEST = "<OfficeApp>swarm test manifest</OfficeApp>\n"
const REQUEST_ID = "AAAAAAAAAAAAAAAAAAAAAA"
const REQUEST_ID_2 = "BBBBBBBBBBBBBBBBBBBBBB"

type Behaviour = "ready" | "PORT_IN_USE" | "hang" | "exit"

type LogEntry = { level: string; source: string; message: string; context?: Record<string, unknown> }

function englishOf(key: keyof typeof DESKTOP_NATIVE_ENGLISH, params: Record<string, string> = {}) {
  return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{{${name}}}`, value), DESKTOP_NATIVE_ENGLISH[key])
}

function harness(input: {
  dir: string
  behaviour?: Behaviour
  refuse?: string[]
  failRoot?: string
  trust?: boolean
  verify?: boolean[]
  persistFails?: boolean
  disableAnswer?: { response: number; checkboxChecked: boolean }
  clearAnswer?: number
}) {
  const home = join(input.dir, "home")
  const userData = join(input.dir, "userData")
  const resourcesPath = join(input.dir, "Resources")
  const manifestPath = join(resourcesPath, "office-addin", "manifest", OFFICE_MANIFEST_FILE)
  const roots = ["Word", "Excel"].map((app) => join(home, "Library", "Containers", `com.microsoft.${app}`, "Data", "Documents", "wef"))
  const logs: LogEntry[] = []
  const states: string[] = []
  const settings = { value: false }
  const boxes: MessageBoxOptions[] = []
  const shell = { revealed: [] as string[], opened: [] as string[] }
  const keychainCalls: { op: string; arg: string }[] = []
  const verifyAnswers = [...(input.verify ?? [])]
  const forks: { path: string; env: Record<string, string>; serviceName: string; sent: BridgeCommand[]; killed: boolean; child: BridgeChild }[] = []
  const pairSinks: PairRequestSink[] = []
  const timers: { ms: number; fn: () => void }[] = []
  const intervals: { ms: number; tick: () => void }[] = []
  const now = { value: new Date("2026-11-16T00:00:00Z") }
  const cleared = { count: 0 }
  const cacheRoot = join(home, "Library", "Containers", "com.Microsoft.OsfWebHost", "Data")
  const pairBoxes: { options: MessageBoxOptions; resolve: (response: number) => void }[] = []

  const refusal = (path: string) => (input.refuse ?? []).some((root) => path.startsWith(root))
  const eperm = () => Object.assign(new Error("Operation not permitted"), { code: "EPERM" })
  const wefFs: WefFs = {
    ...nodeWefFs,
    mkdir: async (dir) => {
      if (refusal(dir)) throw eperm()
      return nodeWefFs.mkdir(dir)
    },
    writeFile: async (file, data) => {
      if (refusal(file)) throw eperm()
      if (input.failRoot && file.startsWith(input.failRoot)) throw Object.assign(new Error("I/O error"), { code: "EIO" })
      return nodeWefFs.writeFile(file, data)
    },
    unlink: async (file) => {
      if (refusal(file)) throw eperm()
      return nodeWefFs.unlink(file)
    },
  }

  const keychain: Keychain = {
    trust: async (path) => {
      keychainCalls.push({ op: "trust", arg: path })
      return input.trust === false ? { ok: false, code: "CERT_UNTRUSTED" } : { ok: true }
    },
    verify: async (path) => {
      keychainCalls.push({ op: "verify", arg: path })
      return verifyAnswers.length > 0 ? verifyAnswers.shift()! : true
    },
    remove: async (removal) => {
      keychainCalls.push({ op: "remove", arg: removal.sha1 })
      return { trustRemoved: true, deleted: true }
    },
  }

  const clock: ControllerClock = {
    now: () => now.value,
    every: (ms, tick) => {
      const interval = { ms, tick }
      intervals.push(interval)
      return () => intervals.splice(intervals.indexOf(interval), 1)
    },
    after: (ms, fn) => {
      const timer = { ms, fn }
      timers.push(timer)
      return () => timers.splice(timers.indexOf(timer), 1)
    },
  }

  const factory = (behaviour: Behaviour): BridgeFactory => async (config, core) => {
    pairSinks.push(core.pairRequests)
    if (behaviour === "PORT_IN_USE") return { ok: false, code: "PORT_IN_USE" }
    if (behaviour === "hang") return new Promise(() => {})
    core.log?.("info", "office-bridge.server", "listening", { port: config.port })
    return { ok: true, bridge: { port: config.port, updateTls: () => {}, pairingsCleared: () => {
          cleared.count += 1
        }, stop: async () => {} } }
  }

  const fork: ForkBridge = (path, _args, options) => {
    const events = new EventEmitter()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const listeners: ((event: { data: unknown }) => void)[] = []
    const record = {
      path,
      env: options.env,
      serviceName: options.serviceName,
      sent: [] as BridgeCommand[],
      killed: false,
      child: undefined as unknown as BridgeChild,
      crash: (code: number) => events.emit("exit", code),
    }
    const behaviour = input.behaviour ?? "ready"
    const child: BridgeChild = {
      postMessage: (command) => {
        record.sent.push(command)
        if (behaviour === "exit" && command.type === "start") {
          queueMicrotask(() => events.emit("exit", 1))
          return
        }
        queueMicrotask(() => listeners.forEach((listener) => listener({ data: command })))
      },
      on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener),
      kill: () => {
        record.killed = true
        queueMicrotask(() => events.emit("exit", 9))
        return true
      },
      stdout,
      stderr,
    }
    record.child = child
    forks.push(record)
    runOfficeBridge(
      { postMessage: (message) => queueMicrotask(() => events.emit("message", message)), on: (_event, listener) => listeners.push(listener) },
      {
        factory: factory(behaviour),
        log: (level, source, message, context) =>
          (level === "info" ? stdout : stderr).write(JSON.stringify({ level, source, message, context }) + "\n"),
        onStopped: () => queueMicrotask(() => events.emit("exit", 0)),
      },
    )
    return child
  }

  const deps: OfficeAddinControllerDeps = {
    userDataDir: userData,
    resources: { packaged: true, resourcesPath, devPackageDir: join(input.dir, "unused") },
    bridgeEntryPath: "/app/out/main/office-bridge.js",
    port: 47317,
    baseEnv: { HOME: home, PATH: "/usr/bin", OPENCODE_SERVER_PASSWORD: PASSWORD, ANTHROPIC_API_KEY: "sk-test", LANG: "en_US.UTF-8" },
    server: async () => ({ url: "http://127.0.0.1:4096", username: "opencode", password: PASSWORD }),
    settings: {
      enabled: () => settings.value,
      setEnabled: (value) => {
        if (value && input.persistFails) throw new Error("store write failed")
        settings.value = value
      },
    },
    fork,
    dialog: {
      showMessageBox: async (options) => {
        boxes.push(options)
        if (options.checkboxLabel) return input.disableAnswer ?? { response: 0, checkboxChecked: true }
        if (options.message === englishOf("desktop.officeAddin.clearCache.confirm")) return { response: input.clearAnswer ?? 1, checkboxChecked: false }
        return { response: 0, checkboxChecked: false }
      },
    },
    shell: {
      showItemInFolder: (path) => shell.revealed.push(path),
      openPath: async (path) => {
        shell.opened.push(path)
        return ""
      },
    },
    pairDialog: {
      window: () => null,
      focus: () => {},
      showMessageBox: (_win, options) => new Promise((resolve) => pairBoxes.push({ options, resolve: (response) => resolve({ response, checkboxChecked: false }) })),
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`enc:${text}`),
      decryptString: (blob) => {
        const text = blob.toString()
        if (!text.startsWith("enc:")) throw new Error("bad blob")
        return text.slice(4)
      },
    },
    keychain,
    wefRoots: roots,
    cacheRoot,
    wefFs,
    home,
    clock,
    log: (level, source, message, context) => logs.push({ level, source, message, context }),
    onStateChange: (state) => states.push(state),
  }

  const setup = async () => {
    await mkdir(join(resourcesPath, "office-addin", "manifest"), { recursive: true })
    await writeFile(manifestPath, MANIFEST)
    // Both containers' Documents folders exist (their wef folders do not). Since M7-02a (F-M7-6) wef.ts skips a host
    // whose container was never created, so both must exist for the two-root flows.
    for (const app of ["Word", "Excel"]) await mkdir(join(home, "Library", "Containers", `com.microsoft.${app}`, "Data", "Documents"), { recursive: true })
  }

  return {
    deps,
    setup,
    home,
    userData,
    roots,
    manifestPath,
    logs,
    states,
    settings,
    boxes,
    shell,
    keychainCalls,
    forks,
    pairSinks,
    timers,
    intervals,
    now,
    cleared,
    cacheRoot,
    pairBoxes,
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false)
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

function assertNoSecretsLogged(logs: LogEntry[]) {
  const text = JSON.stringify(logs)
  expect(text).not.toContain(PASSWORD)
  expect(text).not.toContain("PRIVATE KEY")
}

let dir = ""
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "office-controller-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("bridgeEnv (SC-34, SD-AC-14)", () => {
  test("keeps only the allow-list; never the sidecar password or an API key", () => {
    const env = bridgeEnv({ HOME: "/h", OPENCODE_SERVER_PASSWORD: PASSWORD, ANTHROPIC_API_KEY: "k", HTTPS_PROXY: "http://p", TZ: "UTC" })
    expect(env).toEqual({ HOME: "/h", TZ: "UTC" })
    expect(BRIDGE_ENV_ALLOW.some((key) => key.startsWith("OPENCODE"))).toBe(false)
  })
})

describe("officeCertPaths", () => {
  test("equals certs.ts certPaths() (no drift; the controller avoids a static pkijs import)", async () => {
    const { certPaths } = await import("./certs")
    expect(officeCertPaths("/U")).toEqual(certPaths("/U"))
  })
})

describe("officeResourcePaths (C33)", () => {
  test("packaged uses process.resourcesPath; dev links office-addin/pane under userData to the built pane", () => {
    const packaged = officeResourcePaths({ packaged: true, resourcesPath: "/R", devPackageDir: "/d" }, "/U")
    expect(packaged.resourcesDir).toBe("/R")
    expect(packaged.manifestPath).toBe(`/R/office-addin/manifest/${OFFICE_MANIFEST_FILE}`)
    expect(packaged.devPaneLink).toBeUndefined()
    const dev = officeResourcePaths({ packaged: false, resourcesPath: "/R", devPackageDir: "/repo/packages/office-addin" }, "/U")
    expect(dev.resourcesDir).toBe("/U/office-addin-dev")
    expect(dev.manifestPath).toBe(`/repo/packages/office-addin/manifest/${OFFICE_MANIFEST_FILE}`)
    expect(dev.devPaneLink).toEqual({ link: "/U/office-addin-dev/office-addin/pane", target: "/repo/packages/office-addin/dist/pane" })
  })
})

describe("enable (SD §5.4)", () => {
  test("success: new CA, trust, verify, fork with minimal env, start, install both roots, persist, notify", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    const result = await controller.enable()

    expect(result).toEqual({ ok: true, install: "installed", refused: [] })
    expect(controller.lifecycle()).toEqual({ state: "running", port: 47317 })
    expect(h.states).toEqual(["starting", "running"])
    expect(h.settings.value).toBe(true)
    expect(h.keychainCalls.map((call) => call.op)).toEqual(["trust", "verify"])
    // SC-21: the CA key is kept only as the safeStorage blob.
    const ca = join(h.userData, "office-addin", "ca")
    expect((await readFile(join(ca, "swarm-office-ca.key.enc"), "utf8")).startsWith("enc:-----BEGIN PRIVATE KEY-----")).toBe(true)
    // Fork: one child, office-bridge service, env without secrets; credentials only in the start message.
    expect(h.forks).toHaveLength(1)
    const fork = h.forks[0]!
    expect(fork.serviceName).toBe("office-bridge")
    expect(fork.env).toEqual({ HOME: h.home, LANG: "en_US.UTF-8" })
    const start = fork.sent[0]!
    expect(start.type).toBe("start")
    if (start.type !== "start") throw new Error("unreachable")
    expect(start.password).toBe(PASSWORD)
    expect(start.port).toBe(47317)
    expect(start.resourcesDir).toBe(join(dir, "Resources"))
    expect(start.cert).toBe(await readFile(join(h.userData, "office-addin", "tls", "localhost.cert.pem"), "utf8"))
    for (const root of h.roots) expect(await readFile(join(root, OFFICE_MANIFEST_FILE), "utf8")).toBe(MANIFEST)
    await settle()
    expect(h.boxes.map((box) => box.message)).toEqual([englishOf("desktop.officeAddin.installed")])
    // Bridge stdout is forwarded to the persistent log.
    expect(h.logs.some((entry) => entry.source === "office-bridge.entry" && entry.message === "ready")).toBe(true)
    assertNoSecretsLogged(h.logs)
    await controller.shutdown()
  })

  test("trust refused: rolls back the new CA (keychain by SHA-1, files, office-addin/), setting stays false", async () => {
    const h = harness({ dir, trust: false })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    const result = await controller.enable()

    expect(result).toEqual({ ok: false, step: "trust", code: "CERT_UNTRUSTED" })
    expect(controller.state()).toBe("off")
    expect(h.states).toEqual(["starting", "off"])
    expect(h.settings.value).toBe(false)
    expect(h.keychainCalls.map((call) => call.op)).toEqual(["trust", "remove"])
    expect(h.keychainCalls[1]!.arg).toMatch(/^[0-9A-F]{40}$/)
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
    expect(h.forks).toHaveLength(0)
    await settle()
    expect(h.boxes.map((box) => box.message)).toEqual([englishOf("desktop.officeAddin.error.certUntrusted")])
  })

  test("verify fails after trust: CERT_UNTRUSTED, trust removed, nothing left", async () => {
    const h = harness({ dir, verify: [false] })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.enable()).toEqual({ ok: false, step: "verify", code: "CERT_UNTRUSTED" })
    expect(h.keychainCalls.map((call) => call.op)).toEqual(["trust", "verify", "remove"])
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
    expect(h.forks).toHaveLength(0)
  })

  test("bridge reports PORT_IN_USE: child stopped, CA rolled back, no wef write, portInUse dialog", async () => {
    const h = harness({ dir, behaviour: "PORT_IN_USE" })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.enable()).toEqual({ ok: false, step: "start", code: "PORT_IN_USE" })
    expect(h.forks[0]!.sent.map((command) => command.type)).toEqual(["start", "stop"])
    expect(h.keychainCalls.map((call) => call.op)).toEqual(["trust", "verify", "remove"])
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
    for (const root of h.roots) expect(await exists(join(root, OFFICE_MANIFEST_FILE))).toBe(false)
    expect(controller.state()).toBe("off")
    await settle()
    expect(h.boxes.map((box) => box.message)).toEqual([englishOf("desktop.officeAddin.error.portInUse")])
  })

  test("bridge exits before ready: BRIDGE_EXITED, rolled back", async () => {
    const h = harness({ dir, behaviour: "exit" })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.enable()).toEqual({ ok: false, step: "start", code: "BRIDGE_EXITED" })
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
    expect(controller.state()).toBe("off")
  })

  test("no ready within 60 s: START_TIMEOUT, child killed after the stop timeout, rolled back", async () => {
    const h = harness({ dir, behaviour: "hang" })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    const pending = controller.enable()
    while (!h.timers.some((timer) => timer.ms === 60_000)) await settle()
    h.timers.find((timer) => timer.ms === 60_000)!.fn()
    // The hung core never stops: the 6 s stop timer kills the child.
    while (!h.timers.some((timer) => timer.ms === 6_000)) await settle()
    h.timers.find((timer) => timer.ms === 6_000)!.fn()
    expect(await pending).toEqual({ ok: false, step: "start", code: "START_TIMEOUT" })
    expect(h.forks[0]!.killed).toBe(true)
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
  })

  test("wef install fails (not a refusal): every step rolls back, including the root that was written", async () => {
    const h = harness({ dir, failRoot: join(dir, "home", "Library", "Containers", "com.microsoft.Excel") })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.enable()).toEqual({ ok: false, step: "install", code: "INSTALL_FAILED" })
    expect(await exists(join(h.roots[0]!, OFFICE_MANIFEST_FILE))).toBe(false)
    expect(h.forks[0]!.sent.map((command) => command.type)).toEqual(["start", "stop"])
    expect(h.keychainCalls.map((call) => call.op)).toEqual(["trust", "verify", "remove"])
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
    expect(h.settings.value).toBe(false)
  })

  test("persist fails: wef copies removed, bridge stopped, CA rolled back", async () => {
    const h = harness({ dir, persistFails: true })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.enable()).toEqual({ ok: false, step: "persist", code: "ENABLE_FAILED" })
    for (const root of h.roots) expect(await exists(join(root, OFFICE_MANIFEST_FILE))).toBe(false)
    expect(h.forks[0]!.sent.map((command) => command.type)).toEqual(["start", "stop"])
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
    expect(controller.state()).toBe("off")
  })

  test("sidecar unavailable: fails before touching certificates", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController({ ...h.deps, server: async () => undefined })
    expect(await controller.enable()).toEqual({ ok: false, step: "server", code: "SERVER_UNAVAILABLE" })
    expect(h.keychainCalls).toEqual([])
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
  })

  test("wef refusal (U11): Finder-guided copy, steps 1-5 kept, setting true, installFailed with the path", async () => {
    const h = harness({ dir, refuse: [join(dir, "home", "Library", "Containers")] })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    const result = await controller.enable()

    expect(result).toEqual({ ok: true, install: "guided", refused: h.roots })
    expect(controller.state()).toBe("running")
    expect(h.settings.value).toBe(true)
    expect(h.keychainCalls.map((call) => call.op)).toEqual(["trust", "verify"])
    expect(await exists(join(h.userData, "office-addin", "ca", "swarm-office-ca.cert.pem"))).toBe(true)
    expect(h.forks[0]!.sent.map((command) => command.type)).toEqual(["start"])
    await settle()
    expect(h.shell.revealed).toEqual([h.manifestPath])
    // Both Documents folders exist, their wef folders do not -> each Documents folder.
    expect(h.shell.opened).toEqual(["Word", "Excel"].map((app) => join(h.home, "Library", "Containers", `com.microsoft.${app}`, "Data", "Documents")))
    expect(h.boxes.map((box) => box.message)).toEqual([englishOf("desktop.officeAddin.error.installFailed", { path: h.roots.join(", ") })])
    await controller.shutdown()
  })
})

describe("disable (SD §5.3, §13.2; C11 OQ-5)", () => {
  test("confirm shows the checkbox checked by default with Cancel as default and cancel", async () => {
    const h = harness({ dir, disableAnswer: { response: 1, checkboxChecked: true } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    expect(await controller.disable()).toEqual({ ok: false, reason: "cancelled" })
    const box = h.boxes.find((item) => item.checkboxLabel)!
    expect(box.message).toBe(englishOf("desktop.officeAddin.disable.confirm"))
    expect(box.checkboxLabel).toBe(englishOf("desktop.officeAddin.disable.removeCertificate"))
    expect(box.checkboxChecked).toBe(true)
    expect(box.buttons).toEqual([englishOf("desktop.officeAddin.disable.confirmButton"), englishOf("desktop.patch.cancel")])
    expect(box.defaultId).toBe(1)
    expect(box.cancelId).toBe(1)
    expect(controller.state()).toBe("running")
    expect(h.settings.value).toBe(true)
    await controller.shutdown()
  })

  test("checked: stop, uninstall, pairings.json, setting false, keychain removal by SHA-1, ca/ and tls/ deleted", async () => {
    const h = harness({ dir, disableAnswer: { response: 0, checkboxChecked: true } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    const dataDir = join(h.userData, "office-addin")
    await writeFile(join(dataDir, "pairings.json"), "{}")
    await mkdir(join(dataDir, "workspace"))

    expect(await controller.disable()).toEqual({ ok: true, removedCertificate: true, uninstallRefused: [] })
    expect(controller.state()).toBe("off")
    expect(h.states).toEqual(["starting", "running", "stopping", "off"])
    expect(h.forks[0]!.sent.map((command) => command.type)).toEqual(["start", "stop"])
    for (const root of h.roots) expect(await exists(join(root, OFFICE_MANIFEST_FILE))).toBe(false)
    expect(await exists(join(dataDir, "pairings.json"))).toBe(false)
    expect(h.settings.value).toBe(false)
    expect(h.keychainCalls.at(-1)!.op).toBe("remove")
    expect(await exists(join(dataDir, "ca"))).toBe(false)
    expect(await exists(join(dataDir, "tls"))).toBe(false)
    expect(await exists(join(dataDir, "workspace"))).toBe(true)
    await settle()
    expect(h.boxes.some((box) => box.message === englishOf("desktop.officeAddin.error.certRemovalFailed"))).toBe(false)
  })

  test("unchecked: CA and key kept; the next Enable reuses them with no trust prompt", async () => {
    const h = harness({ dir, disableAnswer: { response: 0, checkboxChecked: false } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    const caCert = join(h.userData, "office-addin", "ca", "swarm-office-ca.cert.pem")
    const before = await readFile(caCert, "utf8")

    expect(await controller.disable()).toEqual({ ok: true, removedCertificate: false, uninstallRefused: [] })
    expect(h.keychainCalls.some((call) => call.op === "remove")).toBe(false)
    expect(await readFile(caCert, "utf8")).toBe(before)
    expect(h.settings.value).toBe(false)

    h.keychainCalls.length = 0
    expect(await controller.enable()).toEqual({ ok: true, install: "installed", refused: [] })
    expect(h.keychainCalls.map((call) => call.op)).toEqual(["verify"])
    expect(await readFile(caCert, "utf8")).toBe(before)
    await controller.shutdown()
  })

  test("uninstall refused: Finder opens each refusing folder; disable still completes", async () => {
    const h = harness({ dir, disableAnswer: { response: 0, checkboxChecked: false } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    const refusingFs: WefFs = {
      ...h.deps.wefFs!,
      unlink: async () => {
        throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" })
      },
    }
    const refusing = createOfficeAddinController({ ...h.deps, wefFs: refusingFs })
    await controller.shutdown()
    h.settings.value = true
    await refusing.launch()
    const result = await refusing.disable()
    expect(result).toEqual({ ok: true, removedCertificate: false, uninstallRefused: h.roots })
    await settle()
    expect(h.shell.opened).toEqual(h.roots)
    expect(refusing.state()).toBe("off")
    // C49 D6 (M7-04): the uninstall mirror of installFailed, with the refusing folders.
    expect(h.boxes.at(-1)!.message).toBe(englishOf("desktop.officeAddin.error.uninstallFailed", { path: h.roots.join(", ") }))
  })
})

describe("pairing (SD §11.2; CP-M4 I-2)", () => {
  test("pair-request shows the dialog; the clicked code goes back as pair-decision allow", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    const request: PairRequest = { requestId: REQUEST_ID, host: "Word", code: "0427" }
    h.pairSinks.at(-1)!(request)
    while (h.pairBoxes.length === 0) await settle()
    const box = h.pairBoxes[0]!
    box.resolve(box.options.buttons!.indexOf("0427"))
    await controller.idle()
    await settle()
    expect(h.forks[0]!.sent.filter((command) => command.type === "pair-decision")).toEqual([
      { type: "pair-decision", requestId: REQUEST_ID, allow: true },
    ])
    await controller.shutdown()
  })

  test("at most one pair dialog: a request while one is open is denied at once and logged", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    h.pairSinks.at(-1)!({ requestId: REQUEST_ID, host: "Word", code: "0427" })
    while (h.pairBoxes.length === 0) await settle()
    h.pairSinks.at(-1)!({ requestId: REQUEST_ID_2, host: "Excel", code: "1234" })
    await settle()
    expect(h.pairBoxes).toHaveLength(1)
    expect(h.forks[0]!.sent.filter((command) => command.type === "pair-decision")).toEqual([
      { type: "pair-decision", requestId: REQUEST_ID_2, allow: false },
    ])
    expect(h.logs.some((entry) => entry.message.includes("another pair dialog is open"))).toBe(true)

    // Deny on the first; afterwards a new request shows a dialog again.
    const box = h.pairBoxes[0]!
    box.resolve(box.options.buttons!.length - 1)
    await controller.idle()
    h.pairSinks.at(-1)!({ requestId: REQUEST_ID_2, host: "Excel", code: "1234" })
    while (h.pairBoxes.length < 2) await settle()
    expect(h.pairBoxes).toHaveLength(2)
    h.pairBoxes[1]!.resolve(3)
    await controller.idle()
    await controller.shutdown()
  })
})

describe("launch (SD §5.3; C26a)", () => {
  test("setting false: nothing happens", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.launch()).toEqual({ ok: false, reason: "disabled" })
    expect(h.forks).toHaveLength(0)
  })

  test("setting true: starts without a keychain prompt and re-syncs a stale or missing manifest", async () => {
    const h = harness({ dir })
    await h.setup()
    const first = createOfficeAddinController(h.deps)
    await first.enable()
    await first.shutdown()
    await writeFile(join(h.roots[0]!, OFFICE_MANIFEST_FILE), "<old/>")
    await rm(join(h.roots[1]!, OFFICE_MANIFEST_FILE))
    h.keychainCalls.length = 0

    const controller = createOfficeAddinController(h.deps)
    const result = await controller.launch()
    expect(result).toEqual({ ok: true, resynced: h.roots })
    expect(controller.state()).toBe("running")
    expect(h.keychainCalls).toEqual([])
    for (const root of h.roots) expect(await readFile(join(root, OFFICE_MANIFEST_FILE), "utf8")).toBe(MANIFEST)
    await controller.shutdown()
  })

  test("start failure at launch: state failed with the code, setting untouched", async () => {
    const h = harness({ dir })
    await h.setup()
    const first = createOfficeAddinController(h.deps)
    await first.enable()
    await first.shutdown()
    const controller = createOfficeAddinController({ ...h.deps, fork: harness({ dir, behaviour: "PORT_IN_USE" }).deps.fork })
    expect(await controller.launch()).toEqual({ ok: false, code: "PORT_IN_USE" })
    expect(controller.lifecycle()).toEqual({ state: "failed", code: "PORT_IN_USE" })
    expect(h.settings.value).toBe(true)
  })
})

describe("menu handlers (M7-01 names)", () => {
  test("toggle enables from off and asks to disable from running; state getter follows", async () => {
    const h = harness({ dir, disableAnswer: { response: 1, checkboxChecked: true } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    const handlers = controller.menuHandlers()
    expect(handlers.officeAddinState()).toBe("off")
    handlers.officeAddinToggle()
    await controller.idle()
    expect(handlers.officeAddinState()).toBe("running")
    handlers.officeAddinToggle()
    await controller.idle()
    expect(h.boxes.some((box) => box.checkboxLabel)).toBe(true)
    expect(handlers.officeAddinState()).toBe("running")
    await controller.shutdown()
    expect(handlers.officeAddinState()).toBe("off")
  })
})

// ── M7-04 ──

const waitFor = async (condition: () => boolean) => {
  while (!condition()) await settle()
}

describe("crash and start timeout (SD §5.3, SD-RC-4; register §7.6)", () => {
  test("bridge crash while running: failed BRIDGE_EXITED, logged under utility, startFailed dialog, no automatic restart", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    h.forks[0]!.crash(3)
    await settle()
    expect(controller.lifecycle()).toEqual({ state: "failed", code: "BRIDGE_EXITED" })
    expect(h.logs.some((entry) => entry.source === "utility" && entry.context?.code === "BRIDGE_EXITED" && entry.context?.exitCode === 3)).toBe(true)
    expect(h.boxes.at(-1)!.message).toBe(englishOf("desktop.officeAddin.error.startFailed"))
    await settle()
    expect(h.forks).toHaveLength(1)
    // The renewal timer of the dead child is gone; recovery is Disable then Enable.
    expect(h.intervals).toHaveLength(0)
    expect(h.settings.value).toBe(true)
  })

  test("a crash during Disable's stop is not reported (the stop was asked for)", async () => {
    const h = harness({ dir, disableAnswer: { response: 0, checkboxChecked: false } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    const before = h.boxes.length
    await controller.disable()
    expect(h.boxes.slice(before).map((box) => box.message)).toEqual([englishOf("desktop.officeAddin.disable.confirm")])
    expect(h.logs.some((entry) => entry.source === "utility")).toBe(false)
  })

  test("START_TIMEOUT at launch: failed START_TIMEOUT, child stopped then killed, startFailed dialog", async () => {
    const h = harness({ dir })
    await h.setup()
    const first = createOfficeAddinController(h.deps)
    await first.enable()
    await first.shutdown()
    const hung = harness({ dir, behaviour: "hang" })
    const controller = createOfficeAddinController({ ...h.deps, fork: hung.deps.fork, clock: hung.deps.clock })
    const pending = controller.launch()
    await waitFor(() => hung.timers.some((timer) => timer.ms === 60_000))
    hung.timers.find((timer) => timer.ms === 60_000)!.fn()
    await waitFor(() => hung.timers.some((timer) => timer.ms === 6_000))
    hung.timers.find((timer) => timer.ms === 6_000)!.fn()
    expect(await pending).toEqual({ ok: false, code: "START_TIMEOUT" })
    expect(controller.lifecycle()).toEqual({ state: "failed", code: "START_TIMEOUT" })
    expect(hung.forks[0]!.sent.map((command) => command.type)).toEqual(["start", "stop"])
    expect(hung.forks[0]!.killed).toBe(true)
    await settle()
    expect(h.boxes.at(-1)!.message).toBe(englishOf("desktop.officeAddin.error.startFailed"))
  })

  test("errorKey: the final dialog set", () => {
    expect(errorKey("PORT_IN_USE")).toBe("desktop.officeAddin.error.portInUse")
    expect(errorKey("CERT_UNTRUSTED")).toBe("desktop.officeAddin.error.certUntrusted")
    const startFailed = [
      "CERT_MISSING",
      "DATA_DIR_UNSAFE",
      "BRIDGE_EXITED",
      "START_TIMEOUT",
      "INSTALL_FAILED",
      "SERVER_UNAVAILABLE",
      "ENABLE_FAILED",
      "SIDECAR_UNSUPPORTED",
      "UNSAFE_PATH",
    ] as const
    for (const code of startFailed) expect(errorKey(code)).toBe("desktop.officeAddin.error.startFailed")
    expect(errorKey("OFFICE_NOT_INSTALLED")).toBe("desktop.officeAddin.error.notInstalled")
  })

  test("enable PORT_IN_USE and CERT_UNTRUSTED show their own dialogs", async () => {
    const port = harness({ dir, behaviour: "PORT_IN_USE" })
    await port.setup()
    await createOfficeAddinController(port.deps).enable()
    await settle()
    expect(port.boxes.at(-1)!.message).toBe(englishOf("desktop.officeAddin.error.portInUse"))
    await rm(join(dir, "userData"), { recursive: true, force: true })
    const untrusted = harness({ dir, trust: false })
    await createOfficeAddinController(untrusted.deps).enable()
    await settle()
    expect(untrusted.boxes.at(-1)!.message).toBe(englishOf("desktop.officeAddin.error.certUntrusted"))
  })

  test("DATA_DIR_UNSAFE: a symlinked office-addin/ is refused with startFailed and nothing is written through it", async () => {
    const h = harness({ dir })
    await h.setup()
    const target = join(dir, "elsewhere")
    await mkdir(target)
    await mkdir(h.userData, { recursive: true })
    await symlink(target, join(h.userData, "office-addin"), "dir")
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.enable()).toEqual({ ok: false, step: "ca", code: "DATA_DIR_UNSAFE" })
    expect(controller.state()).toBe("off")
    expect(await exists(join(target, "ca"))).toBe(false)
    expect(h.keychainCalls).toEqual([])
    await settle()
    expect(h.boxes.at(-1)!.message).toBe(englishOf("desktop.officeAddin.error.startFailed"))
  })
})

describe("disconnect (SD §11.4, SC-16)", () => {
  test("running: pairings-cleared goes to the bridge, which empties its set", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    controller.menuHandlers().officeAddinDisconnect()
    await controller.idle()
    await settle()
    expect(h.forks[0]!.sent.filter((command) => command.type === "pairings-cleared")).toHaveLength(1)
    expect(h.cleared.count).toBe(1)
    await controller.shutdown()
  })

  test("stopped: main writes the empty store; no data dir: nothing is created", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.disconnect()).toEqual({ cleared: "none" })
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)

    await controller.enable()
    await controller.shutdown()
    const store = join(h.userData, "office-addin", "pairings.json")
    const entry = { host: "Word", hash: `sha256:${"a".repeat(64)}`, createdAt: "2026-11-16T00:00:00.000Z", lastUsedAt: "2026-11-16T00:00:00.000Z" }
    await writeFile(store, JSON.stringify({ version: 1, pairings: [entry] }), { mode: 0o600 })
    expect(await controller.disconnect()).toEqual({ cleared: "file" })
    expect(JSON.parse(await readFile(store, "utf8"))).toEqual({ version: 1, pairings: [] })
    expect(((await stat(store)).mode & 0o777).toString(8)).toBe("600")
    expect(h.forks).toHaveLength(1)
  })
})

describe("clear cache (SD §12.3; U-DT-05)", () => {
  const seedCache = async (h: ReturnType<typeof harness>) => {
    await mkdir(join(h.cacheRoot, "Library", "Caches"), { recursive: true })
    await writeFile(join(h.cacheRoot, "wef.cache"), "cached")
    await writeFile(join(h.cacheRoot, "..", "keep.txt"), "outside")
  }

  test("default cache root is the OsfWebHost Data folder", () => {
    expect(defaultCacheRoot("/Users/x")).toBe("/Users/x/Library/Containers/com.Microsoft.OsfWebHost/Data")
  })

  test("confirm has Cancel as default and cancel; Cancel deletes nothing", async () => {
    const h = harness({ dir, clearAnswer: 1 })
    await h.setup()
    await seedCache(h)
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.clearCache()).toEqual({ ok: false, reason: "cancelled" })
    const box = h.boxes.at(-1)!
    expect(box.message).toBe(englishOf("desktop.officeAddin.clearCache.confirm"))
    expect(box.buttons).toEqual([englishOf("desktop.officeAddin.clearCache.confirmButton"), englishOf("desktop.patch.cancel")])
    expect(box.defaultId).toBe(1)
    expect(box.cancelId).toBe(1)
    expect(await exists(join(h.cacheRoot, "wef.cache"))).toBe(true)
  })

  test("confirm: only the contents of the root go, then pairings are cleared through the bridge", async () => {
    const h = harness({ dir, clearAnswer: 0 })
    await h.setup()
    await seedCache(h)
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    controller.menuHandlers().officeAddinClearCache()
    await controller.idle()
    await settle()
    expect(await exists(h.cacheRoot)).toBe(true)
    expect(await exists(join(h.cacheRoot, "wef.cache"))).toBe(false)
    expect(await exists(join(h.cacheRoot, "Library"))).toBe(false)
    expect(await readFile(join(h.cacheRoot, "..", "keep.txt"), "utf8")).toBe("outside")
    expect(h.forks[0]!.sent.filter((command) => command.type === "pairings-cleared")).toHaveLength(1)
    await controller.shutdown()
  })

  test("refusal: Finder opens the cache folder; pairings are still cleared", async () => {
    const h = harness({ dir, clearAnswer: 0 })
    await h.setup()
    await seedCache(h)
    const refusingFs: WefFs = {
      ...h.deps.wefFs!,
      rm: async () => {
        throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" })
      },
    }
    const controller = createOfficeAddinController({ ...h.deps, wefFs: refusingFs })
    await controller.enable()
    await controller.shutdown()
    const result = await controller.clearCache()
    expect(result.ok && { ...result, refused: [...result.refused].sort() }).toEqual({
      ok: true,
      removed: 0,
      refused: [join(h.cacheRoot, "Library"), join(h.cacheRoot, "wef.cache")].sort(),
      failed: 0,
      pairings: { cleared: "file" },
    })
    expect(h.shell.opened).toEqual([h.cacheRoot])
  })
})

describe("SC-25 wiring (renewal at start, 24 h timer, menu error)", () => {
  test("launch checks the leaf before the fork: a missing leaf is re-issued with no keychain prompt", async () => {
    const h = harness({ dir })
    await h.setup()
    const first = createOfficeAddinController(h.deps)
    await first.enable()
    await first.shutdown()
    const leaf = join(h.userData, "office-addin", "tls", "localhost.cert.pem")
    const before = await readFile(leaf, "utf8")
    await rm(leaf)
    h.keychainCalls.length = 0
    const controller = createOfficeAddinController(h.deps)
    expect((await controller.launch()).ok).toBe(true)
    const after = await readFile(leaf, "utf8")
    expect(after).not.toBe(before)
    const start = h.forks.at(-1)!.sent[0]!
    expect(start.type === "start" && start.cert).toBe(after)
    expect(h.keychainCalls).toEqual([])
    await controller.shutdown()
  })

  test("24 h timer: a due leaf is renewed and sent as tls-update; a failure shows failed + dialog once; recovery returns to running", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    const timer = h.intervals.find((item) => item.ms === 24 * 60 * 60 * 1000)!
    expect(timer).toBeDefined()

    // 380 days later fewer than 30 days remain on the 397-day leaf.
    h.now.value = new Date("2027-12-01T00:00:00Z")
    timer.tick()
    await waitFor(() => h.forks[0]!.sent.some((command) => command.type === "tls-update"))
    expect(controller.state()).toBe("running")

    // The CA certificate disappears: CERT_MISSING, shown in the menu as failed, one dialog.
    const caCert = join(h.userData, "office-addin", "ca", "swarm-office-ca.cert.pem")
    const caPem = await readFile(caCert, "utf8")
    await rm(caCert)
    const boxes = h.boxes.length
    timer.tick()
    await waitFor(() => controller.state() === "failed")
    expect(controller.lifecycle()).toEqual({ state: "failed", code: "CERT_MISSING" })
    await settle()
    timer.tick()
    await settle()
    await settle()
    expect(h.boxes.slice(boxes).map((box) => box.message)).toEqual([englishOf("desktop.officeAddin.error.startFailed")])
    expect(h.forks[0]!.killed).toBe(false)

    await writeFile(caCert, caPem)
    timer.tick()
    await waitFor(() => controller.state() === "running")
    expect(controller.lifecycle()).toEqual({ state: "running", port: 47317 })
    await controller.shutdown()
    expect(h.intervals).toHaveLength(0)
  })
})

describe("CA rotation through ca/previous/ (C49 D4, M3-02a)", () => {
  const corruptKey = (h: ReturnType<typeof harness>) => writeFile(join(h.userData, "office-addin", "ca", "swarm-office-ca.key.enc"), "garbage")
  const sha1Of = async (h: ReturnType<typeof harness>) =>
    JSON.parse(await readFile(join(h.userData, "office-addin", "ca", "fingerprint.json"), "utf8")).sha1 as string

  test("Enable with an unreadable CA key: new CA; the old one is removed by SHA-1 only after commit; backup gone", async () => {
    const h = harness({ dir, disableAnswer: { response: 0, checkboxChecked: false } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    await controller.disable()
    const oldSha1 = await sha1Of(h)
    await corruptKey(h)
    h.keychainCalls.length = 0
    expect(await controller.enable()).toEqual({ ok: true, install: "installed", refused: [] })
    const newSha1 = await sha1Of(h)
    expect(newSha1).not.toBe(oldSha1)
    expect(h.keychainCalls.map((call) => call.op)).toEqual(["trust", "verify", "remove"])
    expect(h.keychainCalls.at(-1)!.arg).toBe(oldSha1)
    expect(await exists(join(h.userData, "office-addin", "ca", "previous"))).toBe(false)
    await controller.shutdown()
  })

  test("the same Enable rolled back: old CA files restored, backup dropped, old CA not removed", async () => {
    const h = harness({ dir, disableAnswer: { response: 0, checkboxChecked: false } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    await controller.disable()
    const oldSha1 = await sha1Of(h)
    const caCert = join(h.userData, "office-addin", "ca", "swarm-office-ca.cert.pem")
    const oldPem = await readFile(caCert, "utf8")
    await corruptKey(h)
    h.keychainCalls.length = 0
    const refusing = createOfficeAddinController({ ...h.deps, keychain: { ...h.deps.keychain!, trust: async () => ({ ok: false, code: "CERT_UNTRUSTED" }) } })
    expect(await refusing.enable()).toEqual({ ok: false, step: "trust", code: "CERT_UNTRUSTED" })
    expect(await readFile(caCert, "utf8")).toBe(oldPem)
    expect(await sha1Of(h)).toBe(oldSha1)
    expect(await exists(join(h.userData, "office-addin", "ca", "previous"))).toBe(false)
    expect(h.keychainCalls.filter((call) => call.op === "remove").map((call) => call.arg)).not.toContain(oldSha1)
  })

  test("Disable finishes a pending removal left by a crashed rotation (both branches)", async () => {
    const h = harness({ dir, disableAnswer: { response: 0, checkboxChecked: false } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    const { writePreviousCa } = await import("./certs")
    const pending = { sha1: "AB".repeat(20), sha256: "CD".repeat(32) }
    await writePreviousCa(officeCertPaths(h.userData), await readFile(join(h.userData, "office-addin", "ca", "swarm-office-ca.cert.pem"), "utf8"), pending)
    h.keychainCalls.length = 0
    await controller.disable()
    expect(h.keychainCalls).toEqual([{ op: "remove", arg: pending.sha1 }])
    expect(await exists(join(h.userData, "office-addin", "ca", "previous"))).toBe(false)
    expect(await exists(join(h.userData, "office-addin", "ca", "swarm-office-ca.cert.pem"))).toBe(true)
  })
})

describe("strings (packages/desktop/AGENTS.md; every dialog string via nativeT)", () => {
  test("controller.ts holds no literal English dialog text", async () => {
    const source = await Bun.file(join(import.meta.dir, "controller.ts")).text()
    const english = Object.entries(DESKTOP_NATIVE_ENGLISH)
      .filter(([key]) => key.startsWith("desktop.officeAddin.") || key.startsWith("desktop.menu.officeAddin") || key === "desktop.patch.cancel")
      .map(([, value]) => value)
    expect(english.length).toBeGreaterThan(10)
    // C65 keys are part of the checked set.
    expect(english).toContain(DESKTOP_NATIVE_ENGLISH["desktop.officeAddin.error.notInstalled"])
    expect(english).toContain(DESKTOP_NATIVE_ENGLISH["desktop.officeAddin.error.certRemovalFailed"])
    // As a string literal in any quote style (short values such as "Cancel" are ordinary words in comments).
    for (const text of english) for (const quote of [`"`, `'`, "`"]) expect(source).not.toContain(`${quote}${text}${quote}`)
    // The long sentences may not appear at all, not even split into a comment or a template.
    for (const text of english.filter((item) => item.length > 40)) expect(source).not.toContain(text.slice(0, 40))
    // No string literal in a message-box text field: message, detail, title, checkboxLabel, buttons.
    expect(source).not.toMatch(/\b(message|detail|title|checkboxLabel)\s*:\s*["'`]/)
    expect(source).not.toMatch(/\bbuttons\s*:\s*\[\s*["'`]/)
    // Every message-box text field goes through t(...). Type positions (`message: BridgeCommand`, `message: unknown`
    // in the BridgeChild signatures) are parameters, not dialog fields.
    const fields = [...source.matchAll(/\b(message|checkboxLabel):\s+(?!\s|BridgeCommand\b|unknown\b)([^,\n]+)/g)].map((match) => match[2]!.trim())
    expect(fields.length).toBeGreaterThan(5)
    for (const field of fields) expect(field.startsWith("t(")).toBe(true)
  })
})

// ── M7-04a (CP-M7 F-M7-1, F-M7-2, F-M7-4, F-M7-5) ──

describe("quit during Enable (F-M7-1)", () => {
  const markerOf = (h: ReturnType<typeof harness>) => join(h.userData, "office-addin", "enable-pending.json")

  test("quit while the trust prompt is open: no keychain call after it, marker kept, then the next menu action reconciles", async () => {
    const h = harness({ dir })
    await h.setup()
    const prompt = Promise.withResolvers<{ ok: true }>()
    const ops: string[] = []
    const keychain: Keychain = {
      trust: async () => {
        ops.push("trust")
        return prompt.promise
      },
      verify: async () => {
        ops.push("verify")
        return true
      },
      remove: async (removal) => {
        ops.push(`remove:${removal.sha1}`)
        return { trustRemoved: true, deleted: true }
      },
    }
    const controller = createOfficeAddinController({ ...h.deps, keychain })
    const enabling = controller.enable()
    await waitFor(() => ops.includes("trust"))
    const marker = JSON.parse(await readFile(markerOf(h), "utf8"))
    expect(marker).toMatchObject({ version: 1, rootCreated: true })
    expect(marker.trustSha1).toMatch(/^[0-9A-F]{40}$/)

    // Quit: shutdown waits for the Enable up to the 6 s stop budget, then returns; the app would exit here.
    const quitting = controller.shutdown()
    await waitFor(() => h.timers.some((timer) => timer.ms === 6_000))
    h.timers.find((timer) => timer.ms === 6_000)!.fn()
    await quitting
    expect(controller.state()).toBe("off")

    // The prompt answers later: the Enable stops at its checkpoint without `verify`, a dialog or a rollback call.
    const boxes = h.boxes.length
    prompt.resolve({ ok: true })
    expect(await enabling).toEqual({ ok: false, reason: "aborted" })
    expect(ops).toEqual(["trust"])
    expect(h.boxes.length).toBe(boxes)
    expect(h.forks).toHaveLength(0)
    expect(h.settings.value).toBe(false)
    expect(await exists(markerOf(h))).toBe(true)
    expect(await exists(join(h.userData, "office-addin", "ca", "swarm-office-ca.cert.pem"))).toBe(true)

    // Next launch with the setting off does nothing (no keychain at launch); the next menu action reconciles.
    const next = createOfficeAddinController({ ...h.deps, keychain })
    expect(await next.launch()).toEqual({ ok: false, reason: "disabled" })
    expect(ops).toEqual(["trust"])
    next.menuHandlers().officeAddinDisconnect()
    await next.idle()
    expect(ops).toEqual(["trust", `remove:${marker.trustSha1}`])
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
    expect(h.logs.some((entry) => entry.message === "interrupted Enable found; rolling it back")).toBe(true)
  })

  test("quit after the bridge started: bridge stopped and awaited, wef undone, no keychain call, trust left to reconcile", async () => {
    const h = harness({ dir })
    await h.setup()
    const gate = Promise.withResolvers<void>()
    const held = { reached: false }
    const wefFs: WefFs = {
      ...h.deps.wefFs!,
      mkdir: async (target) => {
        held.reached = true
        await gate.promise
        return h.deps.wefFs!.mkdir(target)
      },
    }
    const controller = createOfficeAddinController({ ...h.deps, wefFs })
    const enabling = controller.enable()
    await waitFor(() => held.reached)
    expect(h.forks).toHaveLength(1)
    const before = h.keychainCalls.length
    const quitting = controller.shutdown()
    await waitFor(() => h.forks[0]!.sent.some((command) => command.type === "stop"))
    gate.resolve()
    await quitting
    expect(await enabling).toEqual({ ok: false, reason: "aborted" })
    expect(h.keychainCalls.length).toBe(before)
    expect(controller.state()).toBe("off")
    expect(h.settings.value).toBe(false)
    expect(h.forks[0]!.killed).toBe(false)
    for (const root of h.roots) expect(await exists(join(root, OFFICE_MANIFEST_FILE))).toBe(false)
    expect(await exists(markerOf(h))).toBe(true)
    expect(h.boxes).toEqual([])

    // Reconcile at the next menu action (Clear cache, cancelled): our trust is removed by SHA-1.
    const marker = JSON.parse(await readFile(markerOf(h), "utf8"))
    const next = createOfficeAddinController(h.deps)
    next.menuHandlers().officeAddinClearCache()
    await next.idle()
    expect(h.keychainCalls.at(-1)).toEqual({ op: "remove", arg: marker.trustSha1 })
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
  })

  test("quit before any trust: rolled back at once without the keychain; no marker left", async () => {
    const h = harness({ dir })
    await h.setup()
    const server = Promise.withResolvers<{ url: string; username: string; password: string }>()
    const controller = createOfficeAddinController({ ...h.deps, server: () => server.promise })
    const enabling = controller.enable()
    await settle()
    const quitting = controller.shutdown()
    server.resolve({ url: "http://127.0.0.1:4096", username: "opencode", password: PASSWORD })
    await quitting
    expect(await enabling).toEqual({ ok: false, reason: "aborted" })
    expect(h.keychainCalls).toEqual([])
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
  })

  test("a stale marker after a committed Enable is dropped at launch with no keychain call", async () => {
    const h = harness({ dir })
    await h.setup()
    const first = createOfficeAddinController(h.deps)
    await first.enable()
    await first.shutdown()
    await writeFile(markerOf(h), JSON.stringify({ version: 1, rootCreated: false, trustSha1: "AB".repeat(20) }))
    h.keychainCalls.length = 0
    const controller = createOfficeAddinController(h.deps)
    expect((await controller.launch()).ok).toBe(true)
    expect(await exists(markerOf(h))).toBe(false)
    expect(h.keychainCalls).toEqual([])
    await controller.shutdown()
  })

  test("a completed Enable leaves no marker; a failed one removes it", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    expect(await exists(markerOf(h))).toBe(false)
    await controller.shutdown()
    await rm(join(dir, "userData"), { recursive: true, force: true })
    const failing = harness({ dir, trust: false })
    await createOfficeAddinController(failing.deps).enable()
    expect(await exists(join(failing.userData, "office-addin"))).toBe(false)
  })
})

describe("Finder fallback opens real directories only (F-M7-2, C63 reveal)", () => {
  test("cache refusal under a planted container symlink: Finder opens the nearest real directory, never the link or its target", async () => {
    const h = harness({ dir, clearAnswer: 0 })
    await h.setup()
    // The OsfWebHost container is a symlink to a planted script; TCC refuses the Data folder itself.
    const planted = join(dir, "planted.command")
    await writeFile(planted, "#!/bin/sh\n")
    const container = join(h.home, "Library", "Containers", "com.Microsoft.OsfWebHost")
    await symlink(planted, container)
    const refusingFs: WefFs = {
      ...h.deps.wefFs!,
      lstat: async (target) => {
        if (target === h.cacheRoot) throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" })
        return h.deps.wefFs!.lstat(target)
      },
    }
    const controller = createOfficeAddinController({ ...h.deps, wefFs: refusingFs })
    const result = await controller.clearCache()
    expect(result.ok && result.refused).toEqual([h.cacheRoot])
    expect(h.shell.opened).toEqual([join(h.home, "Library", "Containers")])
    expect(h.shell.opened).not.toContain(container)
    expect(h.shell.opened).not.toContain(planted)
  })
})

describe("Office host not installed (C63, M7-02a F-M7-6)", () => {
  test("one host not installed: Enable continues with the other, logged", async () => {
    const h = harness({ dir })
    await h.setup()
    await rm(join(h.home, "Library", "Containers", "com.microsoft.Excel"), { recursive: true })
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.enable()).toEqual({ ok: true, install: "installed", refused: [] })
    expect(await readFile(join(h.roots[0]!, OFFICE_MANIFEST_FILE), "utf8")).toBe(MANIFEST)
    expect(await exists(h.roots[1]!)).toBe(false)
    expect(h.logs.find((entry) => entry.message === "Office host not installed; skipped")?.context).toEqual({ notInstalled: [h.roots[1]] })
    await controller.shutdown()
  })

  test("neither host installed: rolled back, notInstalled with both container Documents paths (C65)", async () => {
    const h = harness({ dir })
    await h.setup()
    for (const app of ["Word", "Excel"]) await rm(join(h.home, "Library", "Containers", `com.microsoft.${app}`), { recursive: true })
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.enable()).toEqual({ ok: false, step: "install", code: "OFFICE_NOT_INSTALLED" })
    expect(controller.state()).toBe("off")
    expect(h.settings.value).toBe(false)
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
    expect(h.keychainCalls.at(-1)!.op).toBe("remove")
    await settle()
    const documents = ["Word", "Excel"].map((app) => join(h.home, "Library", "Containers", `com.microsoft.${app}`, "Data", "Documents"))
    expect(h.boxes.at(-1)!.message).toBe(englishOf("desktop.officeAddin.error.notInstalled", { path: documents.join(", ") }))
    expect(h.boxes.filter((box) => box.message === englishOf("desktop.officeAddin.error.notInstalled", { path: documents.join(", ") }))).toHaveLength(1)
  })

  test("a symlinked wef folder is UNSAFE_PATH: rolled back with startFailed, nothing written through the link", async () => {
    const h = harness({ dir })
    await h.setup()
    const target = join(dir, "elsewhere")
    await mkdir(target)
    await symlink(target, h.roots[0]!)
    const controller = createOfficeAddinController(h.deps)
    expect(await controller.enable()).toEqual({ ok: false, step: "install", code: "UNSAFE_PATH" })
    expect(await exists(join(target, OFFICE_MANIFEST_FILE))).toBe(false)
    expect(await exists(join(h.roots[1]!, OFFICE_MANIFEST_FILE))).toBe(false)
    await settle()
    expect(h.boxes.at(-1)!.message).toBe(englishOf("desktop.officeAddin.error.startFailed"))
  })
})

describe("checked Disable when the keychain removal fails (F-M7-4)", () => {
  test("the CA record moves to ca/previous/ and the next Enable retries the removal by SHA-1", async () => {
    const h = harness({ dir, disableAnswer: { response: 0, checkboxChecked: true } })
    await h.setup()
    const controller = createOfficeAddinController(h.deps)
    await controller.enable()
    const sha1 = JSON.parse(await readFile(join(h.userData, "office-addin", "ca", "fingerprint.json"), "utf8")).sha1
    const failing = createOfficeAddinController({
      ...h.deps,
      keychain: { ...h.deps.keychain!, remove: async () => ({ trustRemoved: false, deleted: false }) },
    })
    await controller.shutdown()
    h.settings.value = true
    await failing.launch()
    expect(await failing.disable()).toEqual({ ok: true, removedCertificate: true, uninstallRefused: [] })
    const ca = join(h.userData, "office-addin", "ca")
    expect(JSON.parse(await readFile(join(ca, "previous", "fingerprint.json"), "utf8")).sha1).toBe(sha1)
    expect(await exists(join(ca, "previous", "swarm-office-ca.cert.pem"))).toBe(true)
    expect(await exists(join(ca, "swarm-office-ca.cert.pem"))).toBe(false)
    expect(await exists(join(ca, "swarm-office-ca.key.enc"))).toBe(false)
    expect(await exists(join(h.userData, "office-addin", "tls"))).toBe(false)
    expect(h.logs.some((entry) => entry.message === "CA kept in ca/previous/ for a retry")).toBe(true)
    // C65: shown once for this Disable.
    await settle()
    const removalFailed = englishOf("desktop.officeAddin.error.certRemovalFailed")
    expect(h.boxes.filter((box) => box.message === removalFailed)).toHaveLength(1)

    h.keychainCalls.length = 0
    const retry = createOfficeAddinController(h.deps)
    await retry.enable()
    expect(h.keychainCalls[0]).toEqual({ op: "remove", arg: sha1 })
    expect(await exists(join(ca, "previous"))).toBe(false)
    await retry.shutdown()
  })
})

describe("v2 sidecar (F-M7-5)", () => {
  test("Enable is refused with startFailed and changes nothing; launch is refused", async () => {
    const h = harness({ dir })
    await h.setup()
    const controller = createOfficeAddinController({ ...h.deps, baseEnv: { ...h.deps.baseEnv, OPENCODE_SIDECAR_V2: "1" } })
    expect(await controller.enable()).toEqual({ ok: false, reason: "unsupported" })
    expect(controller.state()).toBe("off")
    expect(h.keychainCalls).toEqual([])
    expect(await exists(join(h.userData, "office-addin"))).toBe(false)
    await settle()
    expect(h.boxes.at(-1)!.message).toBe(englishOf("desktop.officeAddin.error.startFailed"))
    h.settings.value = true
    expect(await controller.launch()).toEqual({ ok: false, reason: "unsupported" })
    expect(h.forks).toHaveLength(0)
  })
})


// ── M7-04c (C91 F-SG2-1): informational dialogs never hold a pair dialog ──

describe("pair dialogs do not wait behind informational dialogs (M7-04c)", () => {
  /** A Swarm window: every box is a sheet that stays open until answered or its signal aborts. */
  const sheets = () => {
    const shown: { options: MessageBoxOptions; resolve: (response: number) => void; aborted: () => boolean }[] = []
    const window = {} as BrowserWindow
    const pairDialog: OfficeAddinControllerDeps["pairDialog"] = {
      window: () => window,
      focus: () => {},
      showMessageBox: (win, options) =>
        new Promise((resolve) => {
          expect(win).toBe(window)
          const answer = (response: number) => resolve({ response, checkboxChecked: false })
          options.signal?.addEventListener("abort", () => answer(options.cancelId ?? 0))
          shown.push({ options, resolve: answer, aborted: () => options.signal?.aborted === true })
        }),
    }
    return { shown, pairDialog }
  }

  test("installFailed open (sheet) + pair-request: the pair dialog shows at once; installFailed comes back after it", async () => {
    const h = harness({ dir, refuse: [join(dir, "home", "Library", "Containers")] })
    await h.setup()
    const s = sheets()
    const controller = createOfficeAddinController({ ...h.deps, pairDialog: s.pairDialog })
    expect((await controller.enable()).ok).toBe(true)
    const installFailed = englishOf("desktop.officeAddin.error.installFailed", {
      path: h.roots.join(", "),
    })
    await waitFor(() => s.shown.length === 1)
    expect(s.shown[0]!.options.message).toBe(installFailed)
    // Not an app-modal box (that one would run synchronously on macOS and hold everything behind it).
    expect(h.boxes.map((box) => box.message)).not.toContain(installFailed)

    // The user is still in Finder; a pane clicks Connect.
    h.pairSinks.at(-1)!({ requestId: REQUEST_ID, host: "Word", code: "0427" })
    // M12 S12-02: the info sheet closes at once, the pair sheet follows after PAIR_AFTER_INFO_MS.
    await waitFor(() => s.shown[0]!.aborted() && h.timers.some((timer) => timer.ms === PAIR_AFTER_INFO_MS))
    expect(s.shown).toHaveLength(1)
    h.timers.find((timer) => timer.ms === PAIR_AFTER_INFO_MS)!.fn()
    await waitFor(() => s.shown.length === 2)
    const pair = s.shown[1]!
    expect(pair.options.buttons).toContain("0427")

    // Nothing informational appears while the pair dialog is open.
    await settle()
    expect(s.shown).toHaveLength(2)
    pair.resolve(pair.options.buttons!.indexOf("0427"))
    await controller.idle()
    await waitFor(() => s.shown.length === 3)
    expect(h.forks[0]!.sent.filter((command) => command.type === "pair-decision")).toEqual([
      { type: "pair-decision", requestId: REQUEST_ID, allow: true },
    ])
    expect(s.shown[2]!.options.message).toBe(installFailed)
    s.shown[2]!.resolve(0)
    await settle()
    expect(s.shown).toHaveLength(3)
    await controller.shutdown()
  })

  test("one pair dialog at a time still holds; an error raised meanwhile waits for the pair dialog", async () => {
    const h = harness({ dir })
    await h.setup()
    const s = sheets()
    const controller = createOfficeAddinController({ ...h.deps, pairDialog: s.pairDialog })
    await controller.enable()
    await waitFor(() => s.shown.length === 1)
    s.shown[0]!.resolve(0)
    await settle()
    h.pairSinks.at(-1)!({ requestId: REQUEST_ID, host: "Word", code: "0427" })
    // No information sheet was open: no pause.
    await waitFor(() => s.shown.length === 2)
    expect(h.timers.some((timer) => timer.ms === PAIR_AFTER_INFO_MS)).toBe(false)
    h.pairSinks.at(-1)!({ requestId: REQUEST_ID_2, host: "Excel", code: "1234" })
    await settle()
    expect(h.forks[0]!.sent.filter((command) => command.type === "pair-decision")).toEqual([
      { type: "pair-decision", requestId: REQUEST_ID_2, allow: false },
    ])
    // The bridge crashes while the pair dialog is open: startFailed waits until the pair dialog closes.
    h.forks[0]!.crash(3)
    await settle()
    expect(s.shown).toHaveLength(2)
    const pair = s.shown[1]!
    pair.resolve(pair.options.buttons!.length - 1)
    await controller.idle()
    await waitFor(() => s.shown.length === 3)
    expect(s.shown[2]!.options.message).toBe(englishOf("desktop.officeAddin.error.startFailed"))
  })
})
