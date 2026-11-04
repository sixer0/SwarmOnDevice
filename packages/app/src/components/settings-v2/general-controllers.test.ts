import { describe, expect, test, vi } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { ServerConnection } from "@/context/server"
import { dict as en } from "@/i18n/en"
import { dict as id } from "@/i18n/id"
import { createShellOptions, createSoundPreviewController } from "./general-controller-behavior"
import {
  autonomousToast,
  createAutonomousToggle,
  createKnowledgeLibraryToggle,
  knowledgeLibraryCommit,
  type AutonomousScope,
} from "./general-controllers"

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

  describe("autonomous mode", () => {
    const directory = "/work/proj"

    // The same answer the server gives: a session's own value, or else its folder's.
    const server = (input: { sessions?: Record<string, boolean>; folders?: string[]; failWrites?: boolean } = {}) => {
      const sessions = new Map(Object.entries(input.sessions ?? {}))
      const folders = new Set(input.folders ?? [])
      const calls = { reads: [] as AutonomousScope[], writes: [] as [AutonomousScope, boolean][] }
      const current = (scope: AutonomousScope) =>
        (scope.sessionID ? sessions.get(scope.sessionID) : undefined) ?? folders.has(scope.directory)
      return {
        sessions,
        folders,
        calls,
        read: async (scope: AutonomousScope) => {
          calls.reads.push(scope)
          return current(scope)
        },
        write: async (scope: AutonomousScope, on: boolean) => {
          calls.writes.push([scope, on])
          if (input.failWrites) throw new Error("AutonomyWriteError")
          if (scope.sessionID) sessions.set(scope.sessionID, on)
          if (!scope.sessionID && on) folders.add(scope.directory)
          if (!scope.sessionID && !on) folders.delete(scope.directory)
          return current(scope)
        },
      }
    }

    const toggle = (
      scope: () => AutonomousScope | undefined,
      backend: Pick<ReturnType<typeof server>, "read" | "write">,
    ) => {
      const seen = { changed: [] as boolean[], failed: 0 }
      const controller = createRoot(() =>
        createAutonomousToggle({
          scope,
          read: backend.read,
          write: backend.write,
          changed: (on) => seen.changed.push(on),
          failed: () => seen.failed++,
        }),
      )
      void controller.load()
      return { seen, controller }
    }

    const settled = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    test("in a session reads and changes that session on the server", async () => {
      const backend = server({ sessions: { ses_a: true } })
      const { seen, controller } = toggle(() => ({ sessionID: "ses_a", directory }), backend)
      expect(controller.enabled()).toBe(false)
      await settled()

      expect(backend.calls.reads).toEqual([{ sessionID: "ses_a", directory }])
      expect(controller.accepting()).toBe(true)
      expect(controller.enabled()).toBe(true)

      await controller.set(false)

      expect(backend.calls.writes).toEqual([[{ sessionID: "ses_a", directory }, false]])
      expect(backend.sessions.get("ses_a")).toBe(false)
      expect(controller.accepting()).toBe(false)
      expect(seen.changed).toEqual([false])
    })

    test("without a session falls back to the folder, and a new session there inherits it", async () => {
      const backend = server()
      const folder = toggle(() => ({ directory }), backend)
      await settled()
      expect(folder.controller.accepting()).toBe(false)

      await folder.controller.set(true)

      expect(backend.calls.writes).toEqual([[{ directory }, true]])
      expect(backend.folders.has(directory)).toBe(true)
      expect(folder.controller.accepting()).toBe(true)

      const started = toggle(() => ({ sessionID: "ses_new", directory }), backend)
      await settled()
      expect(started.controller.accepting()).toBe(true)
      expect(backend.sessions.has("ses_new")).toBe(false)
    })

    test("without a folder stays off and never reaches the server", async () => {
      const backend = server({ folders: [directory] })
      const { seen, controller } = toggle(() => undefined, backend)
      await settled()

      expect(controller.enabled()).toBe(false)
      expect(controller.accepting()).toBe(false)

      await controller.set(true)
      await controller.toggle()

      expect(backend.calls.reads).toEqual([])
      expect(backend.calls.writes).toEqual([])
      expect(seen).toEqual({ changed: [], failed: 0 })
    })

    test("shows what the server answered, not what was asked for", async () => {
      const backend = server()
      const { controller } = toggle(() => ({ sessionID: "ses_a", directory }), {
        read: backend.read,
        write: async () => false,
      })
      await settled()

      await controller.set(true)

      expect(controller.accepting()).toBe(false)
    })

    test("keeps the value and reports once when the server refuses the change", async () => {
      const backend = server({ sessions: { ses_a: true }, failWrites: true })
      const { seen, controller } = toggle(() => ({ sessionID: "ses_a", directory }), backend)
      await settled()

      await controller.set(false)

      expect(controller.accepting()).toBe(true)
      expect(controller.enabled()).toBe(true)
      expect(seen).toEqual({ changed: [], failed: 1 })
    })

    test("reads again after a refused change, because stopping holds even when saving failed", async () => {
      const backend = server({ sessions: { ses_a: true } })
      const { seen, controller } = toggle(() => ({ sessionID: "ses_a", directory }), {
        read: backend.read,
        write: async (scope, on) => {
          await backend.write(scope, on)
          throw new Error("AutonomyWriteError")
        },
      })
      await settled()
      expect(controller.accepting()).toBe(true)

      await controller.set(false)

      expect(controller.accepting()).toBe(false)
      expect(controller.enabled()).toBe(true)
      expect(seen).toEqual({ changed: [], failed: 1 })
    })

    test("does not claim a state it could not read", async () => {
      const backend = server()
      const { seen, controller } = toggle(() => ({ sessionID: "ses_a", directory }), {
        read: () => Promise.reject(new Error("offline")),
        write: backend.write,
      })
      await settled()

      expect(controller.accepting()).toBe(false)
      expect(controller.enabled()).toBe(false)
      expect(seen.failed).toBe(0)
    })

    test("the shortcut flips what the server holds now, not an older view", async () => {
      const backend = server({ sessions: { ses_a: false } })
      const { controller } = toggle(() => ({ sessionID: "ses_a", directory }), backend)
      await settled()
      expect(controller.accepting()).toBe(false)

      // The add menu turned it on in the meantime.
      backend.sessions.set("ses_a", true)
      await controller.toggle()

      expect(backend.calls.writes).toEqual([[{ sessionID: "ses_a", directory }, false]])
      expect(controller.accepting()).toBe(false)
    })

    test("refresh picks up a change made elsewhere", async () => {
      const backend = server({ sessions: { ses_a: false } })
      const { controller } = toggle(() => ({ sessionID: "ses_a", directory }), backend)
      await settled()

      backend.sessions.set("ses_a", true)
      await controller.refresh()

      expect(controller.accepting()).toBe(true)
    })

    test("ignores a second change while the first is pending", async () => {
      let settle = (_: boolean) => {}
      const sent: boolean[] = []
      const backend = server()
      const { controller } = toggle(() => ({ sessionID: "ses_a", directory }), {
        read: backend.read,
        write: (_, on) => {
          sent.push(on)
          return new Promise<boolean>((resolve) => (settle = resolve))
        },
      })
      await settled()

      const first = controller.set(true)
      expect(controller.enabled()).toBe(false)
      await controller.set(false)
      await controller.toggle()
      settle(true)
      await first

      expect(sent).toEqual([true])
      expect(controller.accepting()).toBe(true)
      expect(controller.enabled()).toBe(true)
    })

    test("drops an answer that belongs to the previous session", async () => {
      const answers = new Map<string, (on: boolean) => void>()
      const [scope, setScope] = createSignal<AutonomousScope>({ sessionID: "ses_a", directory })
      const { controller } = toggle(scope, {
        read: (where) => new Promise<boolean>((resolve) => answers.set(where.sessionID ?? "", resolve)),
        write: async (_, on) => on,
      })
      await settled()

      setScope({ sessionID: "ses_b", directory })
      void controller.load()
      await settled()
      answers.get("ses_a")?.(true)
      await settled()
      expect(controller.accepting()).toBe(false)
      expect(controller.enabled()).toBe(false)

      answers.get("ses_b")?.(false)
      await settled()
      expect(controller.accepting()).toBe(false)
      expect(controller.enabled()).toBe(true)
    })

    test("forgets the previous session's value as soon as the session changes", async () => {
      const backend = server({ sessions: { ses_a: true } })
      const [scope, setScope] = createSignal<AutonomousScope>({ sessionID: "ses_a", directory })
      const { controller } = toggle(scope, {
        read: (where) => (where.sessionID === "ses_a" ? backend.read(where) : new Promise<boolean>(() => {})),
        write: backend.write,
      })
      await settled()
      expect(controller.accepting()).toBe(true)

      setScope({ sessionID: "ses_b", directory })
      void controller.load()
      await settled()

      expect(controller.accepting()).toBe(false)
      expect(controller.enabled()).toBe(false)
    })

    describe("consent before turning on (S1.8b)", () => {
      const consenting = (
        scope: () => AutonomousScope | undefined,
        backend: ReturnType<typeof server>,
        answer: boolean | (() => Promise<boolean>),
        language: "en" | "id" = "id",
      ) => {
        const seen = { changed: [] as boolean[], failed: 0, asked: 0 }
        const sent: unknown[][] = []
        const controller = createRoot(() =>
          createAutonomousToggle({
            scope,
            read: backend.read,
            write: (where, on, consent) => {
              sent.push(consent === undefined ? [where, on] : [where, on, consent])
              return backend.write(where, on)
            },
            changed: (on) => seen.changed.push(on),
            failed: () => seen.failed++,
            confirm: () => {
              seen.asked++
              return typeof answer === "function" ? answer() : Promise.resolve(answer)
            },
            language: () => language,
          }),
        )
        void controller.load()
        return { seen, sent, controller }
      }

      test("a no sends nothing, announces nothing and leaves the switch usable", async () => {
        const backend = server({ sessions: { ses_a: false } })
        const { seen, sent, controller } = consenting(() => ({ sessionID: "ses_a", directory }), backend, false)
        await settled()

        await controller.toggle()

        expect(seen).toEqual({ changed: [], failed: 0, asked: 1 })
        expect(sent).toEqual([])
        expect(backend.calls.writes).toEqual([])
        expect(controller.accepting()).toBe(false)
        expect(controller.enabled()).toBe(true)
      })

      test("a yes turns it on with the consent and the app language", async () => {
        const backend = server({ sessions: { ses_a: false } })
        const { seen, sent, controller } = consenting(() => ({ sessionID: "ses_a", directory }), backend, true)
        await settled()

        await controller.toggle()

        expect(sent).toEqual([
          [{ sessionID: "ses_a", directory }, true, { bypassConsent: "bypass-v1", reportLanguage: "id" }],
        ])
        expect(seen).toEqual({ changed: [true], failed: 0, asked: 1 })
        expect(controller.accepting()).toBe(true)
      })

      test("set(true) asks the same way, and the language defaults to English", async () => {
        const backend = server()
        const { sent, controller } = consenting(() => ({ directory }), backend, true, "en")
        await settled()

        await controller.set(true)

        expect(sent).toEqual([[{ directory }, true, { bypassConsent: "bypass-v1", reportLanguage: "en" }]])
      })

      test("turning off never asks and carries no consent", async () => {
        const backend = server({ sessions: { ses_a: true } })
        const { seen, sent, controller } = consenting(() => ({ sessionID: "ses_a", directory }), backend, true)
        await settled()

        await controller.toggle()
        await controller.set(false)

        expect(seen.asked).toBe(0)
        expect(sent).toEqual([
          [{ sessionID: "ses_a", directory }, false],
          [{ sessionID: "ses_a", directory }, false],
        ])
      })

      test("off then on asks again: the consent is per activation", async () => {
        const backend = server({ sessions: { ses_a: false } })
        const { seen, controller } = consenting(() => ({ sessionID: "ses_a", directory }), backend, true)
        await settled()

        await controller.toggle()
        await controller.toggle()
        await controller.toggle()

        expect(seen.asked).toBe(2)
        expect(seen.changed).toEqual([true, false, true])
      })

      test("while the question is open a second toggle is ignored", async () => {
        let answer = (_: boolean) => {}
        const backend = server({ sessions: { ses_a: false } })
        const { seen, controller } = consenting(
          () => ({ sessionID: "ses_a", directory }),
          backend,
          () => new Promise<boolean>((resolve) => (answer = resolve)),
        )
        await settled()

        const first = controller.toggle()
        await settled()
        expect(controller.enabled()).toBe(false)
        await controller.toggle()
        answer(false)
        await first

        expect(seen.asked).toBe(1)
        expect(backend.calls.writes).toEqual([])
        expect(controller.enabled()).toBe(true)
      })

      test("a dialog that fails to open counts as a no", async () => {
        const backend = server({ sessions: { ses_a: false } })
        const { seen, controller } = consenting(
          () => ({ sessionID: "ses_a", directory }),
          backend,
          () => Promise.reject(new Error("no dialog")),
        )
        await settled()

        await controller.toggle()

        expect(seen).toEqual({ changed: [], failed: 0, asked: 1 })
        expect(backend.calls.writes).toEqual([])
      })

      // Verifier M2: after a server restart the mode reads on while the consent is gone.
      test("on but not bypassed: agree asks again and sends on with the consent", async () => {
        const modes: { on: boolean; bypass: boolean }[] = [{ on: true, bypass: false }]
        const sent: unknown[][] = []
        const seen = { asked: 0, changed: [] as boolean[] }
        const controller = createRoot(() =>
          createAutonomousToggle({
            scope: () => ({ sessionID: "ses_a", directory }),
            read: async () => modes.at(-1)!,
            write: async (where, on, consent) => {
              sent.push(consent === undefined ? [where, on] : [where, on, consent])
              modes.push({ on, bypass: on && consent !== undefined })
              return modes.at(-1)!
            },
            changed: (on) => seen.changed.push(on),
            failed: () => {},
            confirm: async () => (seen.asked++, true),
            language: () => "en",
          }),
        )
        void controller.load()
        await settled()
        expect(controller.accepting()).toBe(true)
        expect(controller.notBypassed()).toBe(true)

        await controller.agree()

        expect(seen.asked).toBe(1)
        expect(sent).toEqual([
          [{ sessionID: "ses_a", directory }, true, { bypassConsent: "bypass-v1", reportLanguage: "en" }],
        ])
        expect(controller.accepting()).toBe(true)
        expect(controller.notBypassed()).toBe(false)
        expect(seen.changed).toEqual([true])

        // Now bypassed: agree has nothing to agree to, and the next toggle turns it off and never asks.
        await controller.agree()
        expect(seen.asked).toBe(1)
        expect(sent.length).toBe(1)
        await controller.toggle()
        expect(seen.asked).toBe(1)
        expect(sent.at(-1)).toEqual([{ sessionID: "ses_a", directory }, false])
      })

      // Code review m19: the person who only wants it off is not sent through the consent dialog.
      test("on but not bypassed: the toggle turns it off without asking", async () => {
        const sent: unknown[][] = []
        let asked = 0
        const controller = createRoot(() =>
          createAutonomousToggle({
            scope: () => ({ sessionID: "ses_a", directory }),
            read: async () => ({ on: true, bypass: false }),
            write: async (where, on, consent) => (sent.push([where, on, consent]), { on, bypass: false }),
            changed: () => {},
            failed: () => {},
            confirm: async () => (asked++, true),
            language: () => "en",
          }),
        )
        void controller.load()
        await settled()

        await controller.toggle()

        expect(asked).toBe(0)
        expect(sent).toEqual([[{ sessionID: "ses_a", directory }, false, undefined]])
        expect(controller.accepting()).toBe(false)
        expect(controller.notBypassed()).toBe(false)
      })

      test("on but not bypassed: a no leaves it on, not bypassed, and sends nothing", async () => {
        const sent: unknown[] = []
        const controller = createRoot(() =>
          createAutonomousToggle({
            scope: () => ({ sessionID: "ses_a", directory }),
            read: async () => ({ on: true, bypass: false }),
            write: async (_where, on) => (sent.push(on), on),
            changed: () => {},
            failed: () => {},
            confirm: async () => false,
          }),
        )
        void controller.load()
        await settled()

        await controller.agree()

        expect(sent).toEqual([])
        expect(controller.accepting()).toBe(true)
        expect(controller.notBypassed()).toBe(true)
      })
    })

    test("toast turning on carries the scan sentence and the whole label, turning off only the title", () => {
      const t = (key: keyof typeof en) => en[key]
      expect(autonomousToast(t, true)).toEqual({
        title: en["toast.permissions.autonomous.on.title"],
        description: [
          en["toast.permissions.autonomous.scan.title"],
          en["settings.general.row.autonomous.scripts"],
          en["settings.general.row.autonomous.description"],
        ].join(" "),
      })
      expect(autonomousToast(t, false)).toEqual({ title: en["toast.permissions.autonomous.off.title"] })
      expect(autonomousToast((key: keyof typeof id) => id[key], true).description).toContain(
        id["toast.permissions.autonomous.scan.title"],
      )
    })

    test("the label states the S-7 sentence in both languages", () => {
      expect(en["settings.general.row.autonomous.description"]).toContain(
        "Tests, builds and commands like git commit (which run the repo's hooks) run with your account. Swarm can't limit what the code inside them does.",
      )
      expect(id["settings.general.row.autonomous.description"]).toContain(
        "Test, build, dan perintah seperti git commit (yang menjalankan hook repo) berjalan dengan akun Anda. Aplikasi tidak dapat membatasi apa yang dilakukan kode di dalamnya.",
      )
    })
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
