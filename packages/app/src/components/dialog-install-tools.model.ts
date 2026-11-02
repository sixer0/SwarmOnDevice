import type { CommandOption } from "@/context/command"
import type { SetupToolsPlatform, SetupToolsRun, SetupToolsState } from "@/context/platform"
import { SETUP_COMPONENT_IDS, type SetupComponentId } from "@/context/setup-status"

// The tools install dialog (U14 row 229), kept free of Solid so the unit lane can drive it with a fake
// platform. The consent gate stays inside swarm-setup, and the final confirmation is main's native dialog
// (C80 F1): this model only turns the ticked ids into one `install` request per click, which main shows
// for confirmation before anything runs, and reports what swarm-setup printed and wrote, verbatim. Nothing
// here invents a status: a row reads Ready only when state.json says `healthy`, and every other result is
// the step token (and its message) exactly as printed.

/** Register U14 "Perintah Terminal", shown as-is. The one copy: the desktop runner never shows it. */
export const TOOLS_TERMINAL_COMMAND = '"/Applications/Swarm.app/Contents/Resources/swarm-setup/swarm-setup" install'

/** C82 contract (a): main's native confirmation was cancelled, so swarm-setup never ran. Electron wraps the
 *  main-side error ("Error invoking remote method '…': Error: SETUP_TOOLS_REFUSED:cancelled"), so match the code. */
export function isInstallCancelled(cause: unknown) {
  return /\bSETUP_TOOLS_REFUSED:cancelled\b/.test(cause instanceof Error ? cause.message : String(cause))
}

type ToolsLog = (input: { service: string; level: "error"; message: string }) => Promise<unknown>

/** The persistent client log the dialog, the offer and the command share (server app.log, never a person). */
export function reportToolsError(log: ToolsLog, service: string) {
  return (source: string, cause: unknown) => {
    void log({
      service,
      level: "error",
      message: `${source}: ${cause instanceof Error ? cause.message : String(cause)}`,
    }).catch(() => undefined)
  }
}

/** `tools.install` (row 231, senior 19): registered once in an always-mounted scope, so the palette offers it on
 *  every page and every composer offers `/install-tools`. A builtin slash runs onSelect; nothing reaches the model. */
export function installToolsCommand(input: { title: string; category: string; open: () => void }): CommandOption {
  return {
    id: "tools.install",
    title: input.title,
    category: input.category,
    slash: "install-tools",
    onSelect: input.open,
  }
}

export type ToolStep = { token: string; message?: string }

const SKIP_TOKENS = new Set(["SKIPPED", "SKIPPED_WITH_INSTRUCTIONS"])

/** `step <id>: <TOKEN>[ — message]` lines. This is the parser whose result a person sees; desktop's
 *  parseSetupOutput (setup-runner.ts) applies the same rule to the same lines for main's own log. */
export function parseSteps(stdout: string) {
  const steps: Partial<Record<SetupComponentId, ToolStep>> = {}
  for (const line of stdout.split("\n")) {
    const match = /^step (\w+): ([A-Z_]+)(?: — (.*))?$/.exec(line)
    if (!match || !(SETUP_COMPONENT_IDS as readonly string[]).includes(match[1]!)) continue
    steps[match[1] as SetupComponentId] = { token: match[2]!, ...(match[3] ? { message: match[3] } : {}) }
  }
  return steps
}

/** Whether swarm-setup wrote any config: only then is the server asked to re-read it. */
export function wroteConfig(stdout: string) {
  return stdout.split("\n").some((line) => line.startsWith("wire: wrote "))
}

export function resultLine(stdout: string) {
  return stdout.split("\n").find((line) => /^RESULT [A-Z_]+$/.test(line))
}

export type ToolRow =
  | { kind: "none" }
  | { kind: "healthy" }
  | { kind: "progress"; state: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "token"; token: string; state?: string }

/** What one component's row says. Ready needs state.json `healthy`; a step token wins over a stale state. */
export function toolRow(input: {
  id: SetupComponentId
  state?: string
  step?: ToolStep
  running: boolean
  ticked: boolean
}): ToolRow {
  const { state, step } = input
  if (step) {
    if (SKIP_TOKENS.has(step.token)) return { kind: "skipped", reason: step.message ?? step.token }
    if (step.token !== "OK")
      return { kind: "failed", reason: step.message ? `${step.token} — ${step.message}` : step.token }
    if (state === "healthy") return { kind: "healthy" }
    return { kind: "token", token: step.token, ...(state ? { state } : {}) }
  }
  if (state === "healthy") return { kind: "healthy" }
  if (input.running && input.ticked && state) return { kind: "progress", state }
  return { kind: "none" }
}

export const PREVIEW_RETRY_BASE_MS = 3000
export const PREVIEW_RETRY_MAX = 3

export type ToolsSnapshot = {
  ticked: Record<SetupComponentId, boolean>
  preview:
    | { kind: "loading" }
    | { kind: "ready"; run: SetupToolsRun }
    | { kind: "failed"; retries: number; retryAt: number }
  phase: "idle" | "running" | "done" | "failed"
  states: SetupToolsState["components"]
  steps: Partial<Record<SetupComponentId, ToolStep>>
  run?: SetupToolsRun
  /** True only after a POST /global/dispose that this dialog sent resolved */
  reloaded: boolean
}

/** A fresh dialog: all seven ticked (the U14 decision), nothing read yet. */
export function initialToolsSnapshot(): ToolsSnapshot {
  return {
    ticked: Object.fromEntries(SETUP_COMPONENT_IDS.map((id) => [id, true])) as Record<SetupComponentId, boolean>,
    preview: { kind: "loading" },
    phase: "idle",
    states: {},
    steps: {},
    reloaded: false,
  }
}

/** The dialog's own view state. C80 F6: on the first-run offer the per-tool terms start open, so they are on
 *  screen before Install selected can be pressed; `/install-tools` keeps them one click away. */
export function initialToolsUi(input: { offer?: boolean; now: number }) {
  return { showTerms: input.offer === true, now: input.now }
}

export type ToolsControllerDeps = {
  api: SetupToolsPlatform
  /** POST /global/dispose, so the server re-reads swarm.json */
  dispose: () => Promise<unknown>
  /** Persistent client log (server app.log); never shows raw errors to a person */
  report: (source: string, cause: unknown) => void
  onChange: (snapshot: ToolsSnapshot) => void
  now?: () => number
}

export function createToolsController(deps: ToolsControllerDeps) {
  const now = deps.now ?? Date.now
  let snapshot = initialToolsSnapshot()
  let offered = false
  let previewing = false
  let installing = false

  const set = (patch: Partial<ToolsSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    deps.onChange(snapshot)
  }

  const markOffered = async () => {
    if (offered) return
    offered = true
    await deps.api.markOffered().catch((cause) => deps.report("markOffered", cause))
  }

  const refreshState = async () => {
    const state = await deps.api.state().catch((cause) => {
      deps.report("state", cause)
      return undefined
    })
    if (state) set({ states: state.components })
  }

  const loadPreview = async () => {
    if (previewing || snapshot.preview.kind === "ready") return
    const previous = snapshot.preview
    if (previous.kind === "failed" && (previous.retries >= PREVIEW_RETRY_MAX || now() < previous.retryAt)) return
    previewing = true
    set({ preview: { kind: "loading" } })
    try {
      set({ preview: { kind: "ready", run: await deps.api.preview() } })
    } catch (cause) {
      deps.report("preview", cause)
      const retries = previous.kind === "failed" ? previous.retries + 1 : 0
      set({ preview: { kind: "failed", retries, retryAt: now() + PREVIEW_RETRY_BASE_MS * 2 ** retries } })
    } finally {
      previewing = false
    }
  }

  return {
    get: () => snapshot,
    open: async () => {
      await Promise.all([refreshState(), loadPreview()])
    },
    retryPreview: loadPreview,
    toggle(id: SetupComponentId, value: boolean) {
      if (installing) return
      set({ ticked: { ...snapshot.ticked, [id]: value } })
    },
    canInstall: () =>
      !installing && snapshot.preview.kind === "ready" && SETUP_COMPONENT_IDS.some((id) => snapshot.ticked[id]),
    /** One click, one request: a second call while a request is active (or before the preview) does nothing.
     *  Main asks for the final confirmation; a cancel there returns the dialog to idle with no error (C82 a). */
    async install() {
      if (installing || snapshot.preview.kind !== "ready") return false
      const ids = SETUP_COMPONENT_IDS.filter((id) => snapshot.ticked[id])
      if (ids.length === 0) return false
      installing = true
      set({ phase: "running", steps: {}, run: undefined, reloaded: false })
      void markOffered()
      const stop = deps.api.onProgress((state) => set({ states: state.components }))
      try {
        const run = await deps.api.install(ids)
        set({ run, steps: parseSteps(run.stdout) })
        await refreshState()
        if (wroteConfig(run.stdout)) {
          await deps
            .dispose()
            .then(() => set({ reloaded: true }))
            .catch((cause) => deps.report("dispose", cause))
        }
        set({ phase: "done" })
      } catch (cause) {
        if (isInstallCancelled(cause)) {
          set({ phase: "idle" })
          return false
        }
        deps.report("install", cause)
        set({ phase: "failed" })
      } finally {
        stop()
        installing = false
      }
      return true
    },
    later: markOffered,
  }
}
