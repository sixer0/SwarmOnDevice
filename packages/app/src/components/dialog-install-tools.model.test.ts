import { describe, expect, test } from "bun:test"
import type { SetupToolsPlatform, SetupToolsRun, SetupToolsState } from "@/context/platform"
import { SETUP_COMPONENT_IDS, type SetupComponentId } from "@/context/setup-status"
import {
  PREVIEW_RETRY_MAX,
  createToolsController,
  initialToolsUi,
  installToolsCommand,
  isInstallCancelled,
  parseSteps,
  reportToolsError,
  toolRow,
  wroteConfig,
} from "./dialog-install-tools.model"

// Row 229 proof against a fake platform (row 225's IPC is not there yet). Solid JSX cannot render in this
// lane (see home-status-card.model.test.ts), so the proof binds the model the `.tsx` maps one-to-one.

const PREVIEW: SetupToolsRun = {
  exitCode: 1,
  stdout: "swarm-setup consent screen\n  [ ] runtime ...\nRESULT REFUSED_NO_CONSENT\n",
  stderr: "",
}

// Lines in the exact shape packages/setup/src/index.ts prints (step, wire, RESULT).
const INSTALL_OUT = [
  "step runtime: SKIPPED_WITH_INSTRUCTIONS — Homebrew not found; install it from brew.sh, then rerun",
  "step node: OK",
  "step graft: OK",
  "step rtk: OK",
  "step obsidian: FAILED — download refused: hash mismatch",
  "step searxng: OK",
  "step firecrawl: HEALTH_FAILED",
  "wire firecrawl: skipped — not healthy",
  "wire: wrote swarm.json:mcp.graft, swarm.json:mcp.swarm-web",
  "RESULT FAILED",
].join("\n")

function fakeApi(overrides: Partial<SetupToolsPlatform> = {}) {
  const calls = { preview: 0, install: [] as string[][], state: 0, marked: 0, unsubscribed: 0 }
  let progress: ((s: SetupToolsState) => void) | undefined
  let release: ((run: SetupToolsRun) => void) | undefined
  let components: SetupToolsState["components"] = {}
  const api: SetupToolsPlatform = {
    preview: async () => {
      calls.preview++
      return PREVIEW
    },
    install: (ids) => {
      calls.install.push(ids)
      return new Promise<SetupToolsRun>((resolve) => (release = resolve))
    },
    state: async () => {
      calls.state++
      return { components, offerPending: true }
    },
    onProgress: (cb) => {
      progress = cb
      return () => {
        calls.unsubscribed++
        progress = undefined
      }
    },
    markOffered: async () => {
      calls.marked++
    },
    ...overrides,
  }
  return {
    api,
    calls,
    emit: (s: SetupToolsState["components"]) => progress?.({ components: s, offerPending: false }),
    finish: (run: SetupToolsRun, after: SetupToolsState["components"]) => {
      components = after
      release?.(run)
    },
  }
}

function setup(
  overrides: Partial<SetupToolsPlatform> = {},
  extra: { dispose?: () => Promise<unknown>; now?: () => number } = {},
) {
  const fake = fakeApi(overrides)
  const disposed: number[] = []
  const reports: string[] = []
  const controller = createToolsController({
    api: fake.api,
    dispose: extra.dispose ?? (async () => disposed.push(1)),
    report: (source) => reports.push(source),
    onChange: () => {},
    now: extra.now,
  })
  return { ...fake, controller, disposed, reports }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("row 229: tools install dialog model", () => {
  test("opens with all seven ticked, in COMPONENT_IDS order, and the preview kept verbatim", async () => {
    const { controller, calls } = setup()
    expect(Object.keys(controller.get().ticked)).toEqual([...SETUP_COMPONENT_IDS])
    expect(Object.values(controller.get().ticked)).toEqual([true, true, true, true, true, true, true])
    expect(controller.canInstall()).toBe(false)
    await controller.open()
    const preview = controller.get().preview
    expect(preview.kind === "ready" && preview.run).toBe(PREVIEW)
    expect(calls.preview).toBe(1)
    expect(controller.canInstall()).toBe(true)
  })

  test("one click, one run: a second click while running starts nothing", async () => {
    const t = setup()
    await t.controller.open()
    const first = t.controller.install()
    expect(await t.controller.install()).toBe(false)
    expect(await t.controller.install()).toBe(false)
    expect(t.calls.install.length).toBe(1)
    t.finish({ exitCode: 0, stdout: "RESULT OK\n", stderr: "" }, {})
    expect(await first).toBe(true)
    expect(t.calls.install.length).toBe(1)
  })

  test("no install before the preview has been read, and none with nothing ticked", async () => {
    const t = setup()
    expect(await t.controller.install()).toBe(false)
    await t.controller.open()
    for (const id of SETUP_COMPONENT_IDS) t.controller.toggle(id, false)
    expect(t.controller.canInstall()).toBe(false)
    expect(await t.controller.install()).toBe(false)
    expect(t.calls.install).toEqual([])
  })

  test("only the ticked ids go to install, in order", async () => {
    const t = setup()
    await t.controller.open()
    t.controller.toggle("runtime", false)
    t.controller.toggle("obsidian", false)
    const run = t.controller.install()
    t.controller.toggle("runtime", true) // ignored while running
    t.finish({ exitCode: 0, stdout: "RESULT OK\n", stderr: "" }, {})
    await run
    expect(t.calls.install).toEqual([["node", "graft", "rtk", "searxng", "firecrawl"]])
    expect(t.controller.get().ticked.runtime).toBe(false)
  })

  test("progress per component comes from state.json while running, verbatim", async () => {
    const t = setup()
    await t.controller.open()
    const run = t.controller.install()
    t.emit({ node: "downloaded", graft: "verified" })
    const s = t.controller.get()
    expect(s.phase).toBe("running")
    expect(toolRow({ id: "node", state: s.states.node, running: true, ticked: true })).toEqual({
      kind: "progress",
      state: "downloaded",
    })
    expect(toolRow({ id: "graft", state: s.states.graft, running: true, ticked: true })).toEqual({
      kind: "progress",
      state: "verified",
    })
    expect(toolRow({ id: "rtk", state: s.states.rtk, running: true, ticked: true })).toEqual({ kind: "none" })
    t.finish({ exitCode: 0, stdout: "RESULT OK\n", stderr: "" }, {})
    await run
    expect(t.calls.unsubscribed).toBe(1)
  })

  test("results per component come from the printed tokens; Ready needs state healthy", async () => {
    const t = setup()
    await t.controller.open()
    const run = t.controller.install()
    t.finish(
      { exitCode: 1, stdout: INSTALL_OUT, stderr: "" },
      {
        node: "healthy",
        graft: "healthy",
        rtk: "installed",
        searxng: "healthy",
        firecrawl: "failed",
        obsidian: "failed",
      },
    )
    await run
    const s = t.controller.get()
    const row = (id: SetupComponentId) =>
      toolRow({ id, state: s.states[id], step: s.steps[id], running: false, ticked: true })
    expect(row("runtime")).toEqual({
      kind: "skipped",
      reason: "Homebrew not found; install it from brew.sh, then rerun",
    })
    expect(row("node")).toEqual({ kind: "healthy" })
    expect(row("rtk")).toEqual({ kind: "token", token: "OK", state: "installed" })
    expect(row("obsidian")).toEqual({ kind: "failed", reason: "FAILED — download refused: hash mismatch" })
    expect(row("searxng")).toEqual({ kind: "healthy" })
    expect(row("firecrawl")).toEqual({ kind: "failed", reason: "HEALTH_FAILED" })
    expect(s.phase).toBe("done")
    expect(s.run?.stdout).toBe(INSTALL_OUT)
  })

  test("a step token wins over a stale healthy state", () => {
    expect(
      toolRow({ id: "searxng", state: "healthy", step: { token: "HEALTH_FAILED" }, running: false, ticked: true }),
    ).toEqual({
      kind: "failed",
      reason: "HEALTH_FAILED",
    })
  })

  test("POST /global/dispose is sent once after a run that wrote config, and not otherwise", async () => {
    const t = setup()
    await t.controller.open()
    let run = t.controller.install()
    t.finish({ exitCode: 1, stdout: INSTALL_OUT, stderr: "" }, {})
    await run
    expect(t.disposed.length).toBe(1)
    expect(t.controller.get().reloaded).toBe(true)
    expect(wroteConfig(INSTALL_OUT)).toBe(true)

    run = t.controller.install()
    t.finish({ exitCode: 0, stdout: "wire: no change (already current)\nRESULT OK\n", stderr: "" }, {})
    await run
    expect(t.disposed.length).toBe(1)
    expect(t.controller.get().reloaded).toBe(false)
  })

  test("a failed dispose is logged, not shown as reloaded", async () => {
    const t = setup({}, { dispose: async () => Promise.reject(new Error("down")) })
    await t.controller.open()
    const run = t.controller.install()
    t.finish({ exitCode: 1, stdout: INSTALL_OUT, stderr: "" }, {})
    await run
    expect(t.controller.get().reloaded).toBe(false)
    expect(t.reports).toEqual(["dispose"])
  })

  test("C74: mark-offered on Not now and when an install starts, never on open, at most once", async () => {
    const t = setup()
    await t.controller.open()
    expect(t.calls.marked).toBe(0)
    const run = t.controller.install()
    await flush()
    expect(t.calls.marked).toBe(1)
    t.finish({ exitCode: 0, stdout: "RESULT OK\n", stderr: "" }, {})
    await run
    await t.controller.later()
    expect(t.calls.marked).toBe(1)

    const u = setup()
    await u.controller.open()
    await u.controller.later()
    expect(u.calls.marked).toBe(1)
    expect(u.calls.install).toEqual([])
  })

  test("senior 11: markOffered is a required platform member, called without a guard", async () => {
    const t = setup()
    await t.controller.open()
    await t.controller.later()
    expect(t.calls.marked).toBe(1)
    expect(t.reports).toEqual([])
  })

  test("an install IPC rejection is logged and leaves the dialog usable", async () => {
    const t = setup({ install: async () => Promise.reject(new Error("ipc")) })
    await t.controller.open()
    expect(await t.controller.install()).toBe(true)
    expect(t.controller.get().phase).toBe("failed")
    expect(t.reports).toEqual(["install"])
    expect(t.controller.canInstall()).toBe(true)
  })

  test("preview failure: logged, retry gated 3s -> 6s -> 12s, at most three retries", async () => {
    let clock = 0
    let attempts = 0
    const t = setup(
      {
        preview: async () => {
          attempts++
          throw new Error("ipc")
        },
      },
      { now: () => clock },
    )
    await t.controller.open()
    expect(attempts).toBe(1)
    const waits = [3000, 6000, 12000]
    for (const wait of waits) {
      clock += wait - 1
      await t.controller.retryPreview()
      const before = attempts
      clock += 1
      await t.controller.retryPreview()
      expect(attempts).toBe(before + 1)
    }
    const failed = t.controller.get().preview
    expect(failed.kind === "failed" && failed.retries).toBe(PREVIEW_RETRY_MAX)
    clock += 1_000_000
    await t.controller.retryPreview()
    expect(attempts).toBe(1 + PREVIEW_RETRY_MAX)
    expect(t.controller.canInstall()).toBe(false)
    expect(t.reports.every((r) => r === "preview")).toBe(true)
  })

  test("parseSteps ignores ids outside the seven and lines that are not step lines", () => {
    const steps = parseSteps("step egress-proxy: OK\nstep bogus: OK\nnot a step\nstep node: OK — done\n")
    expect(steps).toEqual({ node: { token: "OK", message: "done" } })
  })

  test("F1 / C82 (a): a cancel in main's native confirmation returns to the dialog with no error", async () => {
    const cancel = new Error("Error invoking remote method 'setup-tools-install': Error: SETUP_TOOLS_REFUSED:cancelled")
    let attempts = 0
    const t = setup({
      install: async () => {
        attempts++
        if (attempts === 1) throw cancel
        return { exitCode: 0, stdout: "RESULT OK\n", stderr: "" }
      },
    })
    await t.controller.open()
    expect(await t.controller.install()).toBe(false)
    const s = t.controller.get()
    expect(s.phase).toBe("idle")
    expect(s.run).toBeUndefined()
    expect(s.steps).toEqual({})
    expect(t.reports).toEqual([])
    expect(t.calls.unsubscribed).toBe(1)
    // Back at the dialog: the ticks are kept and Install selected asks main again.
    expect(Object.values(s.ticked).every(Boolean)).toBe(true)
    expect(t.controller.canInstall()).toBe(true)
    expect(await t.controller.install()).toBe(true)
    expect(attempts).toBe(2)
    expect(t.controller.get().phase).toBe("done")
  })

  test("F1: any other refusal is still a failure and is logged", async () => {
    const t = setup({ install: async () => Promise.reject(new Error("SETUP_TOOLS_REFUSED:busy")) })
    await t.controller.open()
    expect(await t.controller.install()).toBe(true)
    expect(t.controller.get().phase).toBe("failed")
    expect(t.reports).toEqual(["install"])
  })

  test("isInstallCancelled matches only the cancelled code, wrapped by Electron or not", () => {
    expect(isInstallCancelled(new Error("SETUP_TOOLS_REFUSED:cancelled"))).toBe(true)
    expect(
      isInstallCancelled(
        new Error("Error invoking remote method 'setup-tools-install': Error: SETUP_TOOLS_REFUSED:cancelled"),
      ),
    ).toBe(true)
    expect(isInstallCancelled("SETUP_TOOLS_REFUSED:cancelled")).toBe(true)
    expect(isInstallCancelled(new Error("SETUP_TOOLS_REFUSED:cancelled_by_policy"))).toBe(false)
    expect(isInstallCancelled(new Error("SETUP_TOOLS_REFUSED:busy"))).toBe(false)
    expect(isInstallCancelled(new Error("cancelled"))).toBe(false)
    expect(isInstallCancelled(undefined)).toBe(false)
  })

  test("F6: the terms start open on the first-run offer and closed from /install-tools", () => {
    expect(initialToolsUi({ offer: true, now: 5 })).toEqual({ showTerms: true, now: 5 })
    expect(initialToolsUi({ now: 5 }).showTerms).toBe(false)
    expect(initialToolsUi({ offer: false, now: 5 }).showTerms).toBe(false)
  })

  test("senior 2: the dialog uses SETUP_COMPONENT_IDS and keeps no id list of its own", async () => {
    expect(Object.keys(await import("./dialog-install-tools.model"))).not.toContain("TOOL_IDS")
    const steps = parseSteps(SETUP_COMPONENT_IDS.map((id) => `step ${id}: OK`).join("\n"))
    expect(Object.keys(steps)).toEqual([...SETUP_COMPONENT_IDS])
  })

  test("senior 7: one error reporter, with the caller's service and no throw when logging fails", async () => {
    const logged: { service: string; level: string; message: string }[] = []
    reportToolsError(async (input) => void logged.push(input), "app.tools-offer")("state", new Error("ipc down"))
    reportToolsError(async (input) => void logged.push(input), "app.tools-dialog")("preview", "plain")
    expect(logged).toEqual([
      { service: "app.tools-offer", level: "error", message: "state: ipc down" },
      { service: "app.tools-dialog", level: "error", message: "preview: plain" },
    ])
    reportToolsError(() => Promise.reject(new Error("log down")), "app.tools-dialog")("install", "x")
    await flush()
  })

  test("senior 19: tools.install is one palette entry with the install-tools slash, opening the dialog", () => {
    let opened = 0
    const cmd = installToolsCommand({ title: "Install tools", category: "Settings", open: () => opened++ })
    expect(cmd).toMatchObject({
      id: "tools.install",
      title: "Install tools",
      category: "Settings",
      slash: "install-tools",
    })
    // The palette drops disabled and hidden options; the slash list drops disabled ones.
    expect(cmd.disabled).toBeFalsy()
    expect(cmd.hidden).toBeFalsy()
    expect(cmd.keybind).toBeUndefined()
    cmd.onSelect?.("palette")
    cmd.onSelect?.("slash")
    expect(opened).toBe(2)
  })
})
