import { createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { ColorScheme } from "@opencode-ai/ui/theme/context"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import {
  AUTONOMY_CHANGED,
  followModeChanges,
  nextMode,
  notBypassed,
  reportLanguageOf,
  type AutonomousConsent,
  type ModeView,
  type ReportLanguage,
} from "@/components/prompt-input/autonomy"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { showToast } from "@/utils/toast"
import { createSoundPreviewController, type ShellOption } from "./general-controller-behavior"

export { createShellOptions, createSoundPreviewController } from "./general-controller-behavior"
export type { ShellOption, ShellSelectOption } from "./general-controller-behavior"

export type AutonomousScope = { sessionID?: string; directory: string; server?: ServerConnection.Key }
export type { AutonomousConsent } from "@/components/prompt-input/autonomy"

export function autonomousToast(
  t: (
    key:
      | "toast.permissions.autonomous.on.title"
      | "toast.permissions.autonomous.off.title"
      | "toast.permissions.autonomous.scan.title"
      | "settings.general.row.autonomous.scripts"
      | "settings.general.row.autonomous.description",
  ) => string,
  on: boolean,
) {
  if (!on) return { title: t("toast.permissions.autonomous.off.title") }
  // With the Settings row gone (C62), this toast is the only place the mode's label is shown.
  return {
    title: t("toast.permissions.autonomous.on.title"),
    description: [
      t("toast.permissions.autonomous.scan.title"),
      t("settings.general.row.autonomous.scripts"),
      t("settings.general.row.autonomous.description"),
    ].join(" "),
  }
}

// The server alone holds the mode. This keeps only its last answer, for as long as the view is open.
export function createAutonomousToggle(input: {
  scope: Accessor<AutonomousScope | undefined>
  /** A plain boolean is a server that does not say whether approvals are bypassed. */
  read: (scope: AutonomousScope) => Promise<boolean | ModeView>
  write: (scope: AutonomousScope, on: boolean, consent?: AutonomousConsent) => Promise<boolean | ModeView>
  changed: (on: boolean) => void
  failed: () => void
  /** Asked before turning on, never before turning off. Without it a turn-on carries no consent (1.1.0). */
  confirm?: () => Promise<boolean>
  language?: () => ReportLanguage
  /** The server's events for this view's folder: `autonomy.mode.changed` reads the mode again (row 58f). */
  event?: Accessor<Parameters<typeof followModeChanges>[0] | undefined>
}) {
  const [state, setState] = createStore<{ on: boolean; bypass?: boolean; known: boolean; pending: boolean }>({
    on: false,
    known: false,
    pending: false,
  })
  const view = (mode: boolean | ModeView): ModeView => (typeof mode === "boolean" ? { on: mode } : mode)
  // An answer to an earlier scope or an older request is not an answer to this one.
  let run = 0

  const refresh = async () => {
    const scope = input.scope()
    if (!scope || state.pending) return
    const current = ++run
    await input.read(scope).then(
      (mode) => {
        const { on, bypass } = view(mode)
        if (current === run) setState({ on, bypass, known: true })
      },
      () => {
        if (current === run) setState("known", false)
      },
    )
  }

  // Undefined: the person said no, so nothing was sent and nothing is announced.
  const change = async (next: (scope: AutonomousScope) => Promise<boolean | ModeView | undefined>) => {
    const scope = input.scope()
    if (!scope || state.pending) return
    const current = ++run
    setState("pending", true)
    await next(scope).then(
      (answer) => {
        if (answer === undefined) {
          if (current === run) setState("pending", false)
          return
        }
        const mode = view(answer)
        input.changed(mode.on)
        if (current === run) setState({ on: mode.on, bypass: mode.bypass, known: true, pending: false })
      },
      async () => {
        input.failed()
        if (current !== run) return
        setState("pending", false)
        // Stopping holds on the server even when saving it failed, so the old value may be wrong now.
        await refresh()
      },
    )
  }

  const ask = input.confirm && { confirm: input.confirm, language: () => input.language?.() ?? "en" }
  // The same rule as the composer's switch (`nextMode`): one place decides when the person is asked.
  const write = async (scope: AutonomousScope, mode: ModeView, intent: "flip" | "agree" = "flip") => {
    const next = await nextMode(mode, ask, intent)
    return next && input.write(scope, next.on, next.consent)
  }

  const load = () => {
    run++
    setState({ on: false, bypass: undefined, known: false, pending: false })
    return refresh()
  }

  const where = createMemo(() => {
    const scope = input.scope()
    return scope && `${scope.sessionID ?? ""}\0${scope.directory}\0${scope.server ?? ""}`
  })
  createEffect(on(where, () => void load()))
  // A change made elsewhere (the CLI, another window) arrives as an event; the same subscription as the composer's.
  createEffect(() => {
    const event = input.event?.()
    if (event) onCleanup(followModeChanges(event, () => void refresh()))
  })

  return {
    accepting: () => state.on,
    /** On, but approvals wait for the person again: `agree` asks for the consent; `toggle` still turns it off (m19). */
    notBypassed: () => state.known && notBypassed(state),
    enabled: () => !!input.scope() && state.known && !state.pending,
    load,
    refresh,
    // As if pressed from the other side: `set(true)` always asks (also to agree again), `set(false)` never does.
    set: (checked: boolean) => change((scope) => write(scope, { on: !checked })),
    // Decides from what the server says now: Settings or the add menu may have changed it since this view last read.
    toggle: () => change((scope) => input.read(scope).then((mode) => write(scope, view(mode)))),
    // Agree again, only while the server says on but not bypassed; otherwise there is nothing to agree to.
    agree: () =>
      change((scope) =>
        input.read(scope).then((mode) => (notBypassed(view(mode)) ? write(scope, view(mode), "agree") : undefined)),
      ),
  }
}

// The session's answer carries `bypass` only from a server that reports it there (AutonomySession).
const modeOf = (data: { on: boolean; bypass?: boolean }): ModeView => ({ on: data.on, bypass: data.bypass })

export function createAutonomousModeController(input: {
  sessionID: Accessor<string | undefined>
  directory: Accessor<string | undefined>
  /** A draft names its own server, which need not be the selected one. */
  server?: Accessor<ServerConnection.Key | undefined>
  /** The consent dialog; asked before turning on only. */
  confirm?: () => Promise<boolean>
  /** The events of the folder the palette is open in; a mode changed elsewhere reaches the toggle through them. */
  event?: Accessor<Parameters<typeof followModeChanges>[0] | undefined>
}) {
  const language = useLanguage()
  const global = useGlobal()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const connection = (key: ServerConnection.Key) =>
    global.servers.list().find((item) => ServerConnection.key(item) === key)
  const client = (scope: AutonomousScope) => {
    const conn = scope.server && connection(scope.server)
    return (conn ? global.ensureServerCtx(conn).sdk : serverSdk()).createClient({
      directory: scope.directory,
      throwOnError: true,
    }).autonomy
  }
  // A change made here is announced to the composer at once; one made elsewhere reaches both as `autonomy.mode.changed`.
  const announce = () => window.dispatchEvent(new Event(AUTONOMY_CHANGED))

  return createAutonomousToggle({
    scope: () => {
      const sessionID = input.sessionID()
      const directory =
        (sessionID ? serverSync().session.lineage.peek(sessionID)?.session.directory : undefined) ?? input.directory()
      const server = input.server?.()
      // A draft on a server that has gone has no folder this can reach, and the selected server is not that folder.
      if (server && !connection(server)) return undefined
      return directory ? { sessionID, directory, server } : undefined
    },
    read: (scope) =>
      scope.sessionID
        ? client(scope)
            .session({ sessionID: scope.sessionID })
            .then((result) => modeOf(result.data!))
        : client(scope)
            .mode()
            .then((result) => modeOf(result.data!)),
    write: (scope, on, consent) =>
      client(scope)
        .modeUpdate({ on, sessionID: scope.sessionID, ...consent })
        .then((result) => modeOf(result.data!)),
    confirm: input.confirm,
    event: input.event,
    language: () => reportLanguageOf(language.locale()),
    changed: (on) => {
      announce()
      showToast(autonomousToast(language.t, on))
    },
    failed: () => {
      announce()
      showToast({ title: language.t("common.requestFailed") })
    },
  })
}

export function createShellSettingsController() {
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const [shells] = createResource(
    async () => {
      const sdk = serverSdk()
      if ((await sdk.protocol) === "v1") return (await sdk.client.pty.shells()).data ?? []
      return [] as ShellOption[]
    },
    { initialValue: [] as ShellOption[] },
  )
  const current = createMemo(() => serverSync().data.config.shell ?? "")

  return {
    shells: () => shells.latest,
    current,
    select: (value: string) => {
      if (value === current()) return
      void serverSync().updateConfig({ shell: value })
    },
  }
}

export function knowledgeLibraryCommit(input: {
  desktop: boolean
  server: ServerConnection.Any | undefined
  commit: string | undefined
}) {
  if (!input.desktop || !input.server || !ServerConnection.builtin(input.server)) return undefined
  return input.commit?.slice(0, 10) || undefined
}

export function createKnowledgeLibraryToggle(input: {
  value: Accessor<boolean | undefined>
  write: (value: boolean | undefined) => void
  update: (value: boolean) => Promise<unknown>
  failed: () => void
  /** What an unset key means. The library is on unless set false (default true); claude_compat is off unless set true. */
  unset?: boolean
}) {
  const [pending, setPending] = createSignal(false)

  return {
    // Unset means `unset` (on for the library): only an explicit value overrides it.
    enabled: () => input.value() ?? input.unset ?? true,
    pending,
    set: async (checked: boolean) => {
      if (pending()) return
      const before = input.value()
      setPending(true)
      input.write(checked)
      await input
        .update(checked)
        .catch(() => {
          input.write(before)
          input.failed()
        })
        .finally(() => setPending(false))
    },
  }
}

export function createKnowledgeLibraryController() {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const serverSync = useServerSync()

  return {
    commit: createMemo(() =>
      knowledgeLibraryCommit({
        desktop: platform.platform === "desktop",
        server: server.current,
        commit: platform.knowledgeLibraryCommit,
      }),
    ),
    ...createKnowledgeLibraryToggle({
      value: () => serverSync().data.config.knowledge_library,
      write: (value) => serverSync().set("config", "knowledge_library", value),
      update: (value) => serverSync().updateConfig({ knowledge_library: value }),
      failed: () => showToast({ title: language.t("common.requestFailed") }),
    }),
  }
}

/** Spec 191 §2.2 (row 192, L49): the global `claude_compat` switch. Off unless set true; written to the global config
 *  only, which disposes every instance, so it takes effect from the next message without a restart. */
export function createClaudeCompatController() {
  const language = useLanguage()
  const serverSync = useServerSync()

  return createKnowledgeLibraryToggle({
    value: () => serverSync().data.config.claude_compat,
    write: (value) => serverSync().set("config", "claude_compat", value),
    update: (value) => serverSync().updateConfig({ claude_compat: value }),
    failed: () => showToast({ title: language.t("common.requestFailed") }),
    unset: false,
  })
}

export function createAppearanceSettingsController() {
  const settings = useSettings()
  const theme = useTheme()
  const themes = createMemo(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  onMount(() => void theme.loadThemes())

  return {
    scheme: {
      current: theme.colorScheme,
      select: (value: ColorScheme) => theme.setColorScheme(value),
    },
    theme: {
      options: themes,
      current: createMemo(() => themes().find((option) => option.id === theme.themeId())),
      select: (option: { id: string } | null) => option && theme.setTheme(option.id),
    },
    fonts: {
      ui: createMemo(() => ({
        value: sansInput(settings.appearance.uiFont()),
        family: sansFontFamily(settings.appearance.uiFont()),
        placeholder: sansDefault,
      })),
      code: createMemo(() => ({
        value: monoInput(settings.appearance.font()),
        family: monoFontFamily(settings.appearance.font()),
        placeholder: monoDefault,
      })),
      terminal: createMemo(() => ({
        value: terminalInput(settings.appearance.terminalFont()),
        family: terminalFontFamily(settings.appearance.terminalFont()),
        placeholder: terminalDefault,
      })),
      setUI: (value: string) => settings.appearance.setUIFont(value),
      setCode: (value: string) => settings.appearance.setFont(value),
      setTerminal: (value: string) => settings.appearance.setTerminalFont(value),
    },
  }
}

const noneSound = { id: "none", label: "sound.option.none" } as const
export const soundOptions = [noneSound, ...SOUND_OPTIONS]
export type SoundSelectOption = (typeof soundOptions)[number]

export function createSoundSettingsController() {
  const settings = useSettings()
  const preview = createSoundPreviewController(playSoundById)
  const channel = (
    enabled: Accessor<boolean>,
    current: Accessor<string>,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    current: createMemo(() =>
      enabled() ? (soundOptions.find((option) => option.id === current()) ?? noneSound) : noneSound,
    ),
    highlight: (option: SoundSelectOption | undefined) => {
      if (!option) return
      preview.play(option.id === "none" ? undefined : option.id)
    },
    select: (option: SoundSelectOption | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        preview.stop()
        return
      }
      setEnabled(true)
      set(option.id)
      preview.play(option.id)
    },
  })

  return {
    agent: channel(
      settings.sounds.agentEnabled,
      settings.sounds.agent,
      (value) => settings.sounds.setAgentEnabled(value),
      (id) => settings.sounds.setAgent(id),
    ),
    permissions: channel(
      settings.sounds.permissionsEnabled,
      settings.sounds.permissions,
      (value) => settings.sounds.setPermissionsEnabled(value),
      (id) => settings.sounds.setPermissions(id),
    ),
    errors: channel(
      settings.sounds.errorsEnabled,
      settings.sounds.errors,
      (value) => settings.sounds.setErrorsEnabled(value),
      (id) => settings.sounds.setErrors(id),
    ),
  }
}

export type ShellSettingsController = ReturnType<typeof createShellSettingsController>
export type KnowledgeLibraryController = ReturnType<typeof createKnowledgeLibraryController>
export type AppearanceSettingsController = ReturnType<typeof createAppearanceSettingsController>
export type SoundSettingsController = ReturnType<typeof createSoundSettingsController>
