import { describe, expect, test, vi } from "bun:test"
import { createRoot } from "solid-js"
import { ServerConnection } from "@/context/server"
import { createShellOptions, createSoundPreviewController } from "./general-controller-behavior"
import { createKnowledgeLibraryToggle, knowledgeLibraryCommit } from "./general-controllers"

describe("settings v2 controllers", () => {
  test("normalizes shell names and preserves an unavailable configured shell", () => {
    expect(
      createShellOptions({
        shells: [
          { path: "/bin/bash", name: "bash", acceptable: true },
          { path: "/opt/bash", name: "bash", acceptable: false },
          { path: "/bin/zsh", name: "zsh", acceptable: true },
        ],
        current: "fish",
      }),
    ).toEqual([
      { id: "auto", value: "", name: "", terminalOnly: false },
      { id: "/bin/bash", value: "/bin/bash", name: "/bin/bash", terminalOnly: false },
      { id: "/opt/bash", value: "/opt/bash", name: "/opt/bash", terminalOnly: true },
      { id: "/bin/zsh", value: "zsh", name: "zsh", terminalOnly: false },
      { id: "fish", value: "fish", name: "fish", terminalOnly: false },
    ])
  })

  test("debounces previews and stops owned audio on disposal", async () => {
    vi.useFakeTimers()
    try {
      const played: string[] = []
      const stopped: string[] = []
      const owned = createRoot((dispose) => ({
        dispose,
        preview: createSoundPreviewController(async (id) => {
          played.push(id ?? "")
          return () => stopped.push(id ?? "")
        }),
      }))

      owned.preview.play("first")
      vi.advanceTimersByTime(99)
      expect(played).toEqual([])

      owned.preview.play("second")
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      expect(played).toEqual(["second"])

      owned.dispose()
      expect(stopped).toEqual(["second"])
    } finally {
      vi.useRealTimers()
    }
  })

  describe("knowledge library row", () => {
    const commit = "3cd46219fe4c2f6e07cd48da0ab4da8b91c711f0"
    const builtin: ServerConnection.Any = {
      type: "sidecar",
      variant: "base",
      http: { url: "http://127.0.0.1:4096" },
    }
    const local: ServerConnection.Any = { type: "http", http: { url: "http://127.0.0.1:4096" } }
    const wsl: ServerConnection.Any = {
      type: "sidecar",
      variant: "wsl",
      distro: "Ubuntu",
      http: { url: "http://127.0.0.1:4096" },
    }

    test("shows the first ten characters only on desktop, on the built-in server, with a commit", () => {
      expect(knowledgeLibraryCommit({ desktop: true, server: builtin, commit })).toBe("3cd46219fe")
      expect(knowledgeLibraryCommit({ desktop: false, server: builtin, commit })).toBeUndefined()
      expect(knowledgeLibraryCommit({ desktop: true, server: local, commit })).toBeUndefined()
      expect(knowledgeLibraryCommit({ desktop: true, server: wsl, commit })).toBeUndefined()
      expect(knowledgeLibraryCommit({ desktop: true, server: undefined, commit })).toBeUndefined()
      expect(knowledgeLibraryCommit({ desktop: true, server: builtin, commit: undefined })).toBeUndefined()
      expect(knowledgeLibraryCommit({ desktop: true, server: builtin, commit: "" })).toBeUndefined()
    })

    const toggle = (initial: boolean | undefined, update: (value: boolean) => Promise<unknown>) => {
      const state = { value: initial, failed: 0, writes: [] as (boolean | undefined)[] }
      const controller = createRoot(() =>
        createKnowledgeLibraryToggle({
          value: () => state.value,
          write: (value) => {
            state.value = value
            state.writes.push(value)
          },
          update,
          failed: () => state.failed++,
        }),
      )
      return { state, controller }
    }

    test("reads an unset value as on and only false as off", () => {
      const update = () => Promise.resolve()
      expect(toggle(undefined, update).controller.enabled()).toBe(true)
      expect(toggle(true, update).controller.enabled()).toBe(true)
      expect(toggle(false, update).controller.enabled()).toBe(false)
    })

    test("writes before the request settles and keeps the value on success", async () => {
      const sent: boolean[] = []
      const { state, controller } = toggle(undefined, (value) => {
        sent.push(value)
        expect(state.value).toBe(false)
        return Promise.resolve()
      })

      await controller.set(false)

      expect(sent).toEqual([false])
      expect(state.value).toBe(false)
      expect(state.failed).toBe(0)
      expect(controller.pending()).toBe(false)
    })

    test("restores the exact earlier value and reports once on failure", async () => {
      const { state, controller } = toggle(undefined, () => Promise.reject(new Error("offline")))

      await controller.set(false)

      expect(state.writes).toEqual([false, undefined])
      expect(state.value).toBeUndefined()
      expect(state.failed).toBe(1)
      expect(controller.pending()).toBe(false)
    })

    test("ignores a second change while the first request is pending", async () => {
      let settle = () => {}
      const sent: boolean[] = []
      const { state, controller } = toggle(true, (value) => {
        sent.push(value)
        return new Promise<void>((resolve) => (settle = resolve))
      })

      const first = controller.set(false)
      expect(controller.pending()).toBe(true)
      await controller.set(true)
      settle()
      await first

      expect(sent).toEqual([false])
      expect(state.value).toBe(false)
      expect(controller.pending()).toBe(false)
    })

    test("is the fifth and last row of the advanced section", async () => {
      const source = await Bun.file(new URL("./general.tsx", import.meta.url)).text()
      const section = source.slice(
        source.indexOf("const AdvancedSection"),
        source.indexOf("const NotificationsSection"),
      )
      expect(section.match(/<SettingsRowV2\b/g)?.length).toBe(5)
      expect(section.indexOf("settings.general.row.knowledgeLibrary.title")).toBeGreaterThan(
        section.lastIndexOf("<SettingsRowV2"),
      )
    })
  })
})
