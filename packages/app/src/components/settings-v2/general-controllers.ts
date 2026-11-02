import { createEffect, createMemo, createResource, createSignal, on, onMount, type Accessor } from "solid-js"
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
import { AUTONOMY_CHANGED } from "@/components/prompt-input/autonomy"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { showToast } from "@/utils/toast"
import { createSoundPreviewController, type ShellOption } from "./general-controller-behavior"

export { createShellOptions, createSoundPreviewController } from "./general-controller-behavior"
export type { ShellOption, ShellSelectOption } from "./general-controller-behavior"

export type AutonomousScope = { sessionID?: string; directory: string; server?: ServerConnection.Key }

export function autonomousToast(
  t: (
    key:
      | "toast.permissions.autonomous.on.title"
      | "toast.permissions.autonomous.off.title"
      | "settings.general.row.autonomous.description",
  ) => string,
  on: boolean,
) {
  if (!on) return { title: t("toast.permissions.autonomous.off.title") }
  return {
    title: t("toast.permissions.autonomous.on.title"),
    description: t("settings.general.row.autonomous.description"),
  }
}

// The server alone holds the mode. This keeps only its last answer, for as long as the view is open.
export function createAutonomousToggle(input: {
  scope: Accessor<AutonomousScope | undefined>
  read: (scope: AutonomousScope) => Promise<boolean>
  write: (scope: AutonomousScope, on: boolean) => Promise<boolean>
  changed: (on: boolean) => void
  failed: () => void
}) {
  const [state, setState] = createStore({ on: false, known: false, unreadable: false, pending: false })
  // An answer to an earlier scope or an older request is not an answer to this one.
  let run = 0

  const refresh = async () => {
    const scope = input.scope()
    if (!scope || state.pending) return
    const current = ++run
    await input.read(scope).then(
      (on) => {
        if (current === run) setState({ on, known: true, unreadable: false })
      },
      () => {
        if (current === run) setState({ known: false, unreadable: true })
      },
    )
  }

  const change = async (next: (scope: AutonomousScope) => Promise<boolean>) => {
    const scope = input.scope()
    if (!scope || state.pending) return
    const current = ++run
    setState("pending", true)
    await next(scope).then(
      (on) => {
        input.changed(on)
        if (current === run) setState({ on, known: true, unreadable: false, pending: false })
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

  const load = () => {
    run++
    setState({ on: false, known: false, unreadable: false, pending: false })
    return refresh()
  }

  const where = createMemo(() => {
    const scope = input.scope()
    return scope && `${scope.sessionID ?? ""}\0${scope.directory}\0${scope.server ?? ""}`
  })
  createEffect(on(where, () => void load()))

  return {
    accepting: () => state.on,
    available: () => !!input.scope(),
    enabled: () => !!input.scope() && state.known && !state.pending,
    description: () => {
      if (!input.scope()) return "settings.general.row.autonomous.disabledReason" as const
      if (state.unreadable) return "common.requestFailed" as const
      return "settings.general.row.autonomous.description" as const
    },
    load,
    refresh,
    set: (checked: boolean) => change((scope) => input.write(scope, checked)),
    // Decides from what the server says now: Settings or the add menu may have changed it since this view last read.
    toggle: () => change((scope) => input.read(scope).then((on) => input.write(scope, !on))),
  }
}

export function createAutonomousModeController(input: {
  sessionID: Accessor<string | undefined>
  directory: Accessor<string | undefined>
  /** A draft names its own server, which need not be the selected one. */
  server?: Accessor<ServerConnection.Key | undefined>
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
  // The server sends no event when the mode changes: this is how the composer learns of it.
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
            .then((result) => result.data!.on)
        : client(scope)
            .mode()
            .then((result) => result.data!.on),
    write: (scope, on) =>
      client(scope)
        .modeUpdate({ on, sessionID: scope.sessionID })
        .then((result) => result.data!.on),
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
}) {
  const [pending, setPending] = createSignal(false)

  return {
    // Unset means on: only an explicit false turns the library off.
    enabled: () => input.value() !== false,
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

export type AutonomousModeController = ReturnType<typeof createAutonomousModeController>
export type ShellSettingsController = ReturnType<typeof createShellSettingsController>
export type KnowledgeLibraryController = ReturnType<typeof createKnowledgeLibraryController>
export type AppearanceSettingsController = ReturnType<typeof createAppearanceSettingsController>
export type SoundSettingsController = ReturnType<typeof createSoundSettingsController>
