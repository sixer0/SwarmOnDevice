import { createMemo, createResource, createSignal, onMount, type Accessor } from "solid-js"
import type { ColorScheme } from "@opencode-ai/ui/theme/context"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
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
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { showToast } from "@/utils/toast"
import { createSoundPreviewController, type ShellOption } from "./general-controller-behavior"

export { createShellOptions, createSoundPreviewController } from "./general-controller-behavior"
export type { ShellOption, ShellSelectOption } from "./general-controller-behavior"

export function createPermissionScopeController(sessionID: Accessor<string | undefined>) {
  const permission = usePermission()
  const serverSync = useServerSync()
  const directory = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    return serverSync().session.lineage.peek(id)?.session.directory
  })

  return {
    accepting: createMemo(() => {
      const id = sessionID()
      const dir = directory()
      if (!id || !dir) return false
      return permission.isAutoAccepting(id, dir)
    }),
    enabled: createMemo(() => !!directory()),
    set: (checked: boolean) => {
      const id = sessionID()
      const dir = directory()
      if (!id || !dir) return
      if (checked) return permission.enableAutoAccept(id, dir)
      permission.disableAutoAccept(id, dir)
    },
  }
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

export type PermissionScopeController = ReturnType<typeof createPermissionScopeController>
export type ShellSettingsController = ReturnType<typeof createShellSettingsController>
export type KnowledgeLibraryController = ReturnType<typeof createKnowledgeLibraryController>
export type AppearanceSettingsController = ReturnType<typeof createAppearanceSettingsController>
export type SoundSettingsController = ReturnType<typeof createSoundSettingsController>
