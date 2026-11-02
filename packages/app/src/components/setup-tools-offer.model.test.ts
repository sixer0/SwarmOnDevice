import { describe, expect, test } from "bun:test"
import type { SetupToolsPlatform, SetupToolsState } from "@/context/platform"
import { createToolsController } from "./dialog-install-tools.model"
import { createToolsOfferGate, type ToolsOfferDeps } from "./setup-tools-offer.model"

// Row 230 proof against a fake desktop main. The fake keeps one "offered this release" bit, the way row 226's
// store key does (that logic is proven in desktop/src/main/onboarding.test.ts); a fresh gate is a new app launch.

function fakeMain(input: { offered?: boolean; healthy?: boolean } = {}) {
  const main = { offered: input.offered ?? false, healthy: input.healthy ?? false, stateCalls: 0, marks: 0 }
  const api: SetupToolsPlatform = {
    preview: async () => ({ exitCode: 1, stdout: "RESULT REFUSED_NO_CONSENT\n", stderr: "" }),
    install: async () => ({ exitCode: 0, stdout: "RESULT OK\n", stderr: "" }),
    state: async (): Promise<SetupToolsState> => {
      main.stateCalls++
      return { components: {}, offerPending: !main.offered && !main.healthy }
    },
    onProgress: () => () => undefined,
    markOffered: async () => {
      main.marks++
      main.offered = true
    },
  }
  return { main, api }
}

function fakeDialog() {
  const dialog = { open: false, shows: 0, close: () => undefined as void }
  const show: ToolsOfferDeps["show"] = (onClose) => {
    dialog.shows++
    dialog.open = true
    dialog.close = () => {
      dialog.open = false
      onClose()
    }
  }
  return { dialog, show }
}

function deps(api: SetupToolsPlatform | undefined, show: ToolsOfferDeps["show"], extra: Partial<ToolsOfferDeps> = {}) {
  const reports: string[] = []
  return {
    reports,
    deps: { api, show, busy: () => false, report: (source: string) => void reports.push(source), ...extra },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("first-run tools offer (row 230)", () => {
  test("first launch of the release: the dialog opens once", async () => {
    const { main, api } = fakeMain()
    const { dialog, show } = fakeDialog()
    const gate = createToolsOfferGate()
    expect(await gate.offer(deps(api, show).deps)).toBe("shown")
    expect(dialog.shows).toBe(1)
    expect(main.marks).toBe(0)
  })

  test("once per run: remounts and a second mount point do not open it again", async () => {
    const { main, api } = fakeMain()
    const { dialog, show } = fakeDialog()
    const gate = createToolsOfferGate()
    const first = gate.offer(deps(api, show).deps)
    // A second mount point asks while the first state read is still in flight.
    expect(await gate.offer(deps(api, show).deps)).toBe("taken")
    expect(await first).toBe("shown")
    dialog.close()
    expect(await gate.offer(deps(api, show).deps)).toBe("taken")
    expect(dialog.shows).toBe(1)
    expect(main.stateCalls).toBe(1)
  })

  test("Not now marks the release offered, so the next launch does not show it", async () => {
    const { main, api } = fakeMain()
    const { dialog, show } = fakeDialog()
    expect(await createToolsOfferGate().offer(deps(api, show).deps)).toBe("shown")
    // The dialog's Not now button is controller.later() then dialog.close() (dialog-install-tools.tsx).
    const controller = createToolsController({
      api,
      dispose: async () => undefined,
      report: () => undefined,
      onChange: () => undefined,
    })
    await controller.later()
    dialog.close()
    await flush()
    expect(main.offered).toBe(true)
    expect(await createToolsOfferGate().offer(deps(api, show).deps)).toBe("not-due")
    expect(dialog.shows).toBe(1)
  })

  test("closing by Escape, overlay or close button also declines it", async () => {
    const { main, api } = fakeMain()
    const { dialog, show } = fakeDialog()
    expect(await createToolsOfferGate().offer(deps(api, show).deps)).toBe("shown")
    expect(main.offered).toBe(false)
    dialog.close()
    await flush()
    expect(main.marks).toBe(1)
    expect(await createToolsOfferGate().offer(deps(api, show).deps)).toBe("not-due")
  })

  test("all seven healthy: not shown, and nothing is marked", async () => {
    const { main, api } = fakeMain({ healthy: true })
    const { dialog, show } = fakeDialog()
    expect(await createToolsOfferGate().offer(deps(api, show).deps)).toBe("not-due")
    expect(dialog.shows).toBe(0)
    expect(main.marks).toBe(0)
  })

  test("already offered this release: not shown", async () => {
    const { api } = fakeMain({ offered: true })
    const { dialog, show } = fakeDialog()
    expect(await createToolsOfferGate().offer(deps(api, show).deps)).toBe("not-due")
    expect(dialog.shows).toBe(0)
  })

  test("web, or desktop without the capability: not shown and state is never read", async () => {
    const { dialog, show } = fakeDialog()
    expect(await createToolsOfferGate().offer(deps(undefined, show).deps)).toBe("unavailable")
    expect(dialog.shows).toBe(0)
  })

  test("another dialog open: waits, then opens once it closes", async () => {
    const { api } = fakeMain()
    const { dialog, show } = fakeDialog()
    const gate = createToolsOfferGate()
    const other = { open: true }
    const input = deps(api, show, { busy: () => other.open }).deps
    expect(await gate.offer(input)).toBe("busy")
    expect(dialog.shows).toBe(0)
    other.open = false
    expect(await gate.offer(input)).toBe("shown")
    expect(dialog.shows).toBe(1)
  })

  test("a dialog that opened during the state read is not replaced", async () => {
    const { api } = fakeMain()
    const { dialog, show } = fakeDialog()
    const other = { open: false }
    const slow: SetupToolsPlatform = {
      ...api,
      state: async () => {
        other.open = true
        return api.state()
      },
    }
    const gate = createToolsOfferGate()
    expect(await gate.offer(deps(slow, show, { busy: () => other.open }).deps)).toBe("busy")
    expect(dialog.shows).toBe(0)
  })

  test("/install-tools marked the release while the offer waited: not shown", async () => {
    const { main, api } = fakeMain()
    const { dialog, show } = fakeDialog()
    const gate = createToolsOfferGate()
    const other = { open: true }
    const input = deps(api, show, { busy: () => other.open }).deps
    expect(await gate.offer(input)).toBe("busy")
    // Row 231's dialog: an install start marks the release (C74).
    await api.markOffered()
    other.open = false
    expect(await gate.offer(input)).toBe("not-due")
    expect(dialog.shows).toBe(0)
    expect(main.marks).toBe(1)
  })

  test("the offer never starts an install: only a click in the dialog does", async () => {
    const { api } = fakeMain()
    const installs: string[][] = []
    const watched: SetupToolsPlatform = {
      ...api,
      install: async (ids) => {
        installs.push(ids)
        return api.install(ids)
      },
    }
    const { dialog, show } = fakeDialog()
    expect(await createToolsOfferGate().offer(deps(watched, show).deps)).toBe("shown")
    dialog.close()
    await flush()
    expect(installs).toEqual([])
  })

  test("unreadable state: reported, not shown, not retried this run, left due for the next launch", async () => {
    const { main, api } = fakeMain()
    const broken: SetupToolsPlatform = { ...api, state: () => Promise.reject(new Error("ipc down")) }
    const { dialog, show } = fakeDialog()
    const gate = createToolsOfferGate()
    const input = deps(broken, show)
    expect(await gate.offer(input.deps)).toBe("failed")
    expect(await gate.offer(input.deps)).toBe("taken")
    expect(input.reports).toEqual(["offerState"])
    expect(dialog.shows).toBe(0)
    expect(main.offered).toBe(false)
  })

  // C82 (b): main claims the offer for one window and answers `offerPending: false` to the others until that
  // offer closes or its window does. The fake models the claim the way main does, without persisting anything.
  function claimingMain() {
    const main = { offered: false, claimedBy: undefined as string | undefined, marks: 0 }
    const windowApi = (name: string): SetupToolsPlatform => ({
      preview: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
      install: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      state: async () => {
        if (main.offered || (main.claimedBy && main.claimedBy !== name)) return { components: {}, offerPending: false }
        main.claimedBy = name
        return { components: {}, offerPending: true }
      },
      onProgress: () => () => undefined,
      markOffered: async () => {
        main.marks++
        main.offered = true
        main.claimedBy = undefined
      },
    })
    return { main, windowApi }
  }

  test("C82 (b): a second window gets not-due while the first shows the offer, and marks nothing", async () => {
    const { main, windowApi } = claimingMain()
    const a = fakeDialog()
    const b = fakeDialog()
    const gateA = createToolsOfferGate()
    const gateB = createToolsOfferGate()
    expect(await gateA.offer(deps(windowApi("A"), a.show).deps)).toBe("shown")
    expect(await gateB.offer(deps(windowApi("B"), b.show).deps)).toBe("not-due")
    expect(b.dialog.shows).toBe(0)
    expect(main.marks).toBe(0)
    expect(main.offered).toBe(false)
    // A answers (Not now, Escape, close): the release is offered, and B stays not-due on its next check.
    a.dialog.close()
    await flush()
    expect(main.marks).toBe(1)
    expect(await gateB.offer(deps(windowApi("B"), b.show).deps)).toBe("not-due")
    expect(b.dialog.shows).toBe(0)
    expect(main.marks).toBe(1)
  })

  test("C82 (b): not-due is not final for the run, so a released claim lets the other window offer", async () => {
    const { main, windowApi } = claimingMain()
    const a = fakeDialog()
    const b = fakeDialog()
    const gateB = createToolsOfferGate()
    expect(await createToolsOfferGate().offer(deps(windowApi("A"), a.show).deps)).toBe("shown")
    expect(await gateB.offer(deps(windowApi("B"), b.show).deps)).toBe("not-due")
    // Window A closed before anyone answered: main releases the claim and nothing was marked.
    main.claimedBy = undefined
    expect(await gateB.offer(deps(windowApi("B"), b.show).deps)).toBe("shown")
    expect(b.dialog.shows).toBe(1)
    expect(main.marks).toBe(0)
    expect(await gateB.offer(deps(windowApi("B"), b.show).deps)).toBe("taken")
  })

  test("senior 12: the dialog loads lazily; a second check while it loads is taken, a failed load is not marked", async () => {
    const { main, api } = fakeMain()
    let finishLoad: (() => void) | undefined
    let shows = 0
    const gate = createToolsOfferGate()
    const first = gate.offer(
      deps(api, () => new Promise<void>((resolve) => (finishLoad = () => (shows++, resolve())))).deps,
    )
    await flush()
    expect(await gate.offer(deps(api, () => void shows++).deps)).toBe("taken")
    finishLoad?.()
    expect(await first).toBe("shown")
    expect(shows).toBe(1)

    const broken = createToolsOfferGate()
    const input = deps(api, () => Promise.reject(new Error("chunk load failed")))
    expect(await broken.offer(input.deps)).toBe("failed")
    expect(input.reports).toEqual(["offerShow"])
    expect(main.marks).toBe(0)
    expect(main.offered).toBe(false)
  })
})
