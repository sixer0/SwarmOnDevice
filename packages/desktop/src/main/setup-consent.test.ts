import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow, IpcMainInvokeEvent, MessageBoxOptions, WebContents } from "electron"
import {
  SETUP_COMPONENT_IDS,
  createSetupRunner,
  lockSha12,
  readHealthySetupComponents,
  readSetupComponentStates,
} from "./setup-runner"
import { SETUP_TOOLS_IPC } from "../preload/setup-tools-channels"
import { createInstallConfirm, registerSetupToolsHandlers, type SetupToolsIpcDeps } from "./setup-tools-ipc"

// Row 237: the consent mapping end to end. The real setup-tools handlers drive the real runner, which spawns a stand-in
// swarm-setup (a shell script) in a fixture HOME under $TMPDIR. The stand-in records every argv it is given and checks
// each `--terms-token` against its own copy of tools.lock.json, the way consent.ts does. Nothing here downloads.

const root = mkdtempSync(join(tmpdir(), "setup-consent-"))
const bundle = join(root, "bundle")
const home = join(root, "home")
// The runner must never fall back to this one: the fixture HOME comes from the onboarding test override.
const accountHome = join(root, "account-home")
const callsLog = join(home, ".fake-setup", "calls.log")
const consentLog = join(home, ".swarm", "setup", "consent.log")
const stateFile = join(home, ".swarm", "setup", "state.json")
const slowFlag = join(home, ".fake-setup", "slow")
const LOCK = '{"version":"row237-fixture"}\n'

const FAKE_SETUP = String.raw`#!/bin/sh
dir=$(dirname "$0")
mkdir -p "$HOME/.fake-setup"
{ printf '%s\t' "$@"; printf '\n'; } >> "$HOME/.fake-setup/calls.log"
if [ "$1" = "--help" ]; then
  printf 'Usage: swarm-setup <verb> [flags]\n  --non-interactive   no prompts\n  --consent-mode app  record consent.log mode app\n'
  exit 0
fi
[ "$1" = "install" ] || { echo "RESULT FAILED"; exit 1; }
shift
dry=0; nonint=0; app=0; ids=""; tokens=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --non-interactive) nonint=1 ;;
    --consent-mode) shift; [ "$1" = "app" ] && app=1 ;;
    --terms-token) shift; tokens="$tokens $1" ;;
    --*) echo "unknown flag $1" >&2; echo "RESULT FAILED"; exit 1 ;;
    *) ids="$ids $1" ;;
  esac
  shift
done
if [ $dry = 1 ]; then
  echo "Components (all optional, all unticked by default):"
  for c in runtime node graft rtk obsidian searxng firecrawl; do echo "  [ ] $c"; done
  echo "RESULT REFUSED_NO_CONSENT"
  exit 1
fi
[ $nonint = 1 ] || { echo "RESULT REFUSED_NO_CONSENT"; exit 1; }
sha=$(/usr/bin/shasum -a 256 "$dir/tools.lock.json" | cut -c1-12)
for id in $ids; do
  case "$tokens " in *" $id=$id@$sha "*) ;; *) echo "step $id: REFUSED_NON_INTERACTIVE"; echo "RESULT REFUSED_NON_INTERACTIVE"; exit 1 ;; esac
done
[ -f "$HOME/.fake-setup/slow" ] && sleep 0.3
mode=non-interactive; [ $app = 1 ] && mode=app
mkdir -p "$HOME/.swarm/setup"
json='{"version":1,"components":{'; sep=""
for id in $ids; do
  echo "mode: $mode component: $id token: $id@$sha" >> "$HOME/.swarm/setup/consent.log"
  json="$json$sep\"$id\":{\"state\":\"healthy\"}"; sep=","
  echo "step $id: OK"
done
printf '%s}}' "$json" > "$HOME/.swarm/setup/state.json"
echo "RESULT OK"
`

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

mkdirSync(bundle, { recursive: true })
writeFileSync(join(bundle, "swarm-setup"), FAKE_SETUP)
chmodSync(join(bundle, "swarm-setup"), 0o755)

const handlers = new Map<string, Handler>()
const windows = new Map<object, { isDestroyed: () => boolean; webContents: object }>()
const logger = { entries: [] as string[], log: (m: string) => void logger.entries.push(m), error: (m: string) => void logger.entries.push(m) }
let marked = 0
// The native confirmation: the real createInstallConfirm over a stand-in showMessageBox. 0 = Install, 1 = Cancel.
let answer = 0
const dialogs: MessageBoxOptions[] = []
// One runner per test, built on first use the way ipc.ts builds it, so the app-mode probe is seen in every test.
let runner: ReturnType<typeof createSetupRunner> | undefined

registerSetupToolsHandlers({
  ipcMain: { handle: (name: string, fn: Handler) => void handlers.set(name, fn) },
  windowOf: (sender) => windows.get(sender) ?? null,
  isRendererUrl: (url) => url === "oc://renderer/index.html",
  confirmInstall: createInstallConfirm({
    windowOf: () => ({}) as BrowserWindow,
    showMessageBox: async (_win, options) => (dialogs.push(options), { response: answer, checkboxChecked: false }),
    t: (key, params) => (params ? `${key} ${params.components}` : key),
  }),
  log: (message) => void logger.entries.push(message),
  runner: () =>
    (runner ??= createSetupRunner({
      dir: bundle,
      logger,
      env: { PATH: "/usr/bin:/bin", OPENCODE_TEST_ONBOARDING: "1", OPENCODE_TEST_SETUP_HOME: home },
      accountHome,
      getuid: () => 501,
      pollMs: 5,
    })),
  // Senior 17: the production offer rule (onboarding.ts, unmarked release), not a stand-in.
  isOfferPending: (h) => readHealthySetupComponents(h).length < SETUP_COMPONENT_IDS.length,
  markOffered: () => void marked++,
} as unknown as SetupToolsIpcDeps)

function sender(opts: { subframe?: boolean } = {}) {
  const mainFrame = { url: "oc://renderer/index.html" }
  const sent: unknown[][] = []
  const contents = {
    mainFrame,
    isDestroyed: () => false,
    send: (...args: unknown[]) => void sent.push(args),
  }
  windows.set(contents, { isDestroyed: () => false, webContents: contents })
  const event = { sender: contents as unknown as WebContents, senderFrame: opts.subframe ? { ...mainFrame } : mainFrame }
  return { event: event as unknown as IpcMainInvokeEvent, sent }
}

const call = (name: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
  Promise.resolve().then(() => handlers.get(name)!(event, ...args))

// Every argv the stand-in was started with, in order.
const calls = () =>
  existsSync(callsLog)
    ? readFileSync(callsLog, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("\t").slice(0, -1))
    : []
const installs = () => calls().filter((argv) => argv[0] === "install" && !argv.includes("--dry-run"))
const tokensOf = (argv: string[]) => argv.filter((_, i) => argv[i - 1] === "--terms-token")
const sha12 = () => lockSha12(new Uint8Array(readFileSync(join(bundle, "tools.lock.json"))))

beforeEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(bundle, "tools.lock.json"), LOCK)
  runner = undefined
  marked = 0
  answer = 0
  dialogs.length = 0
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("no click, no install", () => {
  test("opening the offer, reading state, previewing and Not now never start an install", async () => {
    const a = sender()
    for (let i = 0; i < 3; i++) expect(await call(SETUP_TOOLS_IPC.state, a.event)).toEqual({ components: {}, offerPending: true })
    const preview = (await call(SETUP_TOOLS_IPC.preview, a.event)) as { exitCode: number; stdout: string }
    expect(preview.exitCode).toBe(1)
    expect(preview.stdout).toContain("RESULT REFUSED_NO_CONSENT")
    await call(SETUP_TOOLS_IPC.markOffered, a.event)

    expect(calls()).toEqual([["install", "--dry-run"]])
    expect(installs()).toEqual([])
    expect(existsSync(consentLog)).toBe(false)
    expect(existsSync(stateFile)).toBe(false)
    expect(marked).toBe(1)
    expect(existsSync(accountHome)).toBe(false)
  })

  test("the preview carries no consent: no ids, no --non-interactive, no token, no app mode", async () => {
    await call(SETUP_TOOLS_IPC.preview, sender().event, ["node"], "--terms-token")
    const argv = calls().flat()
    for (const flag of ["--non-interactive", "--terms-token", "--consent-mode"]) expect(argv).not.toContain(flag)
    for (const id of SETUP_COMPONENT_IDS) expect(argv).not.toContain(id)
  })

  test("a request from a subframe starts nothing, the preview included", async () => {
    const frame = sender({ subframe: true })
    for (const name of [SETUP_TOOLS_IPC.install, SETUP_TOOLS_IPC.preview])
      await expect(call(name, frame.event, ["node"])).rejects.toThrow("SETUP_TOOLS_INVALID_SENDER")
    expect(calls()).toEqual([])
  })

  test("nothing ticked, or ids carrying flags or tokens, never reach swarm-setup", async () => {
    const a = sender()
    await expect(call(SETUP_TOOLS_IPC.install, a.event, [])).rejects.toThrow("SETUP_TOOLS_REFUSED:nothing_selected")
    for (const ids of [["node", "--terms-token"], [`node=node@${sha12()}`], ["node", "--consent-mode", "app"], ["all"]])
      await expect(call(SETUP_TOOLS_IPC.install, a.event, ids)).rejects.toThrow("SETUP_TOOLS_INVALID_IDS")
    expect(calls()).toEqual([])
    expect(existsSync(consentLog)).toBe(false)
  })
})

describe("a click is a person's consent, for what was ticked and nothing else", () => {
  test("two ticked ids: one install, a token each, none for the five left unticked, recorded as mode app", async () => {
    const a = sender()
    const run = (await call(SETUP_TOOLS_IPC.install, a.event, ["rtk", "node"])) as { exitCode: number; stdout: string }
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe("step node: OK\nstep rtk: OK\nRESULT OK\n")

    // The probe first, then exactly one install.
    expect(calls().map((argv) => argv[0])).toEqual(["--help", "install"])
    expect(installs()).toEqual([
      ["install", "node", "rtk", "--non-interactive", "--terms-token", `node=node@${sha12()}`, "--terms-token", `rtk=rtk@${sha12()}`, "--consent-mode", "app"],
    ])
    const unticked = SETUP_COMPONENT_IDS.filter((id) => id !== "node" && id !== "rtk")
    for (const id of unticked) expect(installs()[0]!.some((arg) => arg.includes(id))).toBe(false)

    expect(readFileSync(consentLog, "utf8")).toBe(
      `mode: app component: node token: node@${sha12()}\nmode: app component: rtk token: rtk@${sha12()}\n`,
    )
    expect(readSetupComponentStates(home)).toEqual({ node: "healthy", rtk: "healthy" })
    // Progress names only what was ticked, and only to the window that clicked.
    const progress = a.sent.filter((args) => args[0] === SETUP_TOOLS_IPC.progress).map((args) => args[1])
    expect(progress.at(-1)).toEqual({ components: { node: "healthy", rtk: "healthy" }, offerPending: true })
    for (const states of progress)
      expect(Object.keys((states as { components: object }).components).every((id) => id === "node" || id === "rtk")).toBe(true)
    // Main does not mark the offer on an install; C74 leaves that to the dialog.
    expect(marked).toBe(0)
  })

  test("each id ticked alone gives a token for that id only", async () => {
    const a = sender()
    for (const id of SETUP_COMPONENT_IDS) {
      expect(((await call(SETUP_TOOLS_IPC.install, a.event, [id])) as { exitCode: number }).exitCode).toBe(0)
      const argv = installs().at(-1)!
      expect(tokensOf(argv)).toEqual([`${id}=${id}@${sha12()}`])
      expect(argv.filter((arg) => (SETUP_COMPONENT_IDS as readonly string[]).includes(arg))).toEqual([id])
    }
    expect(installs()).toHaveLength(SETUP_COMPONENT_IDS.length)
    // The help probe runs once per runner, not once per install.
    expect(calls().filter((argv) => argv[0] === "--help")).toHaveLength(1)
  })

  test("all seven ticked: seven tokens, every one accepted by the stand-in's own lock check", async () => {
    await call(SETUP_TOOLS_IPC.install, sender().event, [...SETUP_COMPONENT_IDS].reverse())
    expect(tokensOf(installs()[0]!)).toEqual(SETUP_COMPONENT_IDS.map((id) => `${id}=${id}@${sha12()}`))
    expect(readFileSync(consentLog, "utf8").trim().split("\n")).toHaveLength(7)
    expect(await call(SETUP_TOOLS_IPC.state, sender().event)).toMatchObject({ offerPending: false })
  })

  test("the token follows the bundled lock: a changed lock gives a new token, still accepted", async () => {
    const a = sender()
    await call(SETUP_TOOLS_IPC.install, a.event, ["graft"])
    const before = tokensOf(installs()[0]!)
    writeFileSync(join(bundle, "tools.lock.json"), LOCK.replace("fixture", "fixture-2"))
    expect(((await call(SETUP_TOOLS_IPC.install, a.event, ["graft"])) as { exitCode: number }).exitCode).toBe(0)
    const after = tokensOf(installs()[1]!)
    expect(after).toEqual([`graft=graft@${sha12()}`])
    expect(after).not.toEqual(before)
  })

  test("a double click is one install: the second is refused as busy before any spawn", async () => {
    mkdirSync(join(home, ".fake-setup"), { recursive: true })
    writeFileSync(slowFlag, "")
    const a = sender()
    const first = call(SETUP_TOOLS_IPC.install, a.event, ["node"])
    // Wait until the stand-in is running the install, not just the help probe.
    for (let i = 0; i < 400 && installs().length === 0; i++) await Bun.sleep(5)
    await expect(call(SETUP_TOOLS_IPC.install, a.event, ["node"])).rejects.toThrow("SETUP_TOOLS_REFUSED:busy")
    expect(((await first) as { exitCode: number }).exitCode).toBe(0)
    expect(installs()).toHaveLength(1)
    expect(readFileSync(consentLog, "utf8").trim().split("\n")).toHaveLength(1)
  })
})

describe("F1: only Install in main's native confirmation starts swarm-setup", () => {
  test("Cancel: SETUP_TOOLS_REFUSED:cancelled, and the stand-in is never started, not even for the help probe", async () => {
    answer = 1
    await expect(call(SETUP_TOOLS_IPC.install, sender().event, ["node", "rtk"])).rejects.toThrow(
      "SETUP_TOOLS_REFUSED:cancelled",
    )
    expect(calls()).toEqual([])
    expect(existsSync(consentLog)).toBe(false)
    expect(existsSync(stateFile)).toBe(false)
    expect(dialogs.map((options) => options.detail)).toEqual(["desktop.setupTools.confirm.detail node\nrtk"])
  })

  test("a renderer call alone is not consent: an answer other than Install spawns nothing", async () => {
    for (const response of [1, -1, 7]) {
      answer = response
      await expect(call(SETUP_TOOLS_IPC.install, sender().event, [...SETUP_COMPONENT_IDS])).rejects.toThrow(
        "SETUP_TOOLS_REFUSED:cancelled",
      )
    }
    expect(calls()).toEqual([])
    expect(dialogs).toHaveLength(3)
    // The dialog named all seven, in register order.
    expect(dialogs[0]!.detail).toBe(`desktop.setupTools.confirm.detail ${SETUP_COMPONENT_IDS.join("\n")}`)
  })

  test("Cancel, then Install: exactly one install, for what the second dialog listed", async () => {
    answer = 1
    await expect(call(SETUP_TOOLS_IPC.install, sender().event, ["graft"])).rejects.toThrow("SETUP_TOOLS_REFUSED:cancelled")
    answer = 0
    expect(((await call(SETUP_TOOLS_IPC.install, sender().event, ["graft"])) as { exitCode: number }).exitCode).toBe(0)
    expect(installs()).toHaveLength(1)
    expect(tokensOf(installs()[0]!)).toEqual([`graft=graft@${sha12()}`])
    expect(dialogs).toHaveLength(2)
  })
})

describe("F4: the child env is an allowlist", () => {
  test("the stand-in sees PATH, HOME and the test variables, never the rest of main's env", async () => {
    const envDump = join(home, ".fake-setup", "env")
    // A stand-in for this test only: it records its env and exits.
    writeFileSync(join(bundle, "swarm-setup"), `#!/bin/sh\nmkdir -p "$HOME/.fake-setup"\n/usr/bin/env > "$HOME/.fake-setup/env"\necho "RESULT OK"\n`)
    try {
      const envRunner = createSetupRunner({
        dir: bundle,
        logger,
        env: {
          PATH: "/usr/bin:/bin",
          OPENCODE_TEST_ONBOARDING: "1",
          OPENCODE_TEST_SETUP_HOME: home,
          NODE_OPTIONS: "--require /tmp/evil.js",
          DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
          ELECTRON_RUN_AS_NODE: "1",
          LC_ALL: "C",
          HTTPS_PROXY: "http://proxy.invalid:3128",
        },
        accountHome,
        getuid: () => 501,
      })
      await envRunner.preview()
      const names = readFileSync(envDump, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => line.slice(0, line.indexOf("=")))
        .filter((name) => name !== "PWD" && name !== "SHLVL" && name !== "_")
        .sort()
      expect(names).toEqual(["HOME", "HTTPS_PROXY", "LC_ALL", "OPENCODE_TEST_ONBOARDING", "OPENCODE_TEST_SETUP_HOME", "PATH"])
    } finally {
      writeFileSync(join(bundle, "swarm-setup"), FAKE_SETUP)
    }
  })
})
