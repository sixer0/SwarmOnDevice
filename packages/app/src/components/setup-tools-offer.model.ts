import type { SetupToolsPlatform } from "@/context/platform"

export type ToolsOfferResult = "unavailable" | "taken" | "busy" | "not-due" | "failed" | "shown"

export type ToolsOfferDeps = {
  /** `platform.setupTools`; undefined on web and on a desktop build without the capability */
  api: SetupToolsPlatform | undefined
  /** True while another dialog is open or the caller is gone: the offer waits rather than replace it */
  busy: () => boolean
  /** Opens the tools dialog (it may load it first); `onClose` runs when it closes for any reason */
  show: (onClose: () => void) => void | Promise<void>
  report: (source: string, cause: unknown) => void
}

/** The first-run offer (row 230): at most one dialog per renderer run, and only while main says the offer is due.
 *  Main owns "once per release" (`offerPending`, row 226) and, since C82 (b), "one window at a time": while
 *  another window shows the offer, main answers `offerPending: false` here and releases the claim when that
 *  offer closes or its window does. So `not-due` is never final for this run: nothing is marked and the next
 *  check (the dialog stack changing, or a remount) asks main again. This gate owns "once per run", so a remount
 *  of the server-scoped shell or a second mount point never opens it again once it was shown. */
export function createToolsOfferGate() {
  let done = false
  let checking = false
  const finish = (result: ToolsOfferResult) => {
    done = true
    checking = false
    return result
  }
  const pause = (result: ToolsOfferResult) => {
    checking = false
    return result
  }

  return {
    async offer(deps: ToolsOfferDeps): Promise<ToolsOfferResult> {
      const api = deps.api
      if (!api) return "unavailable"
      if (done || checking) return "taken"
      if (deps.busy()) return "busy"
      checking = true
      // Read fresh each time: `/install-tools` (row 231) or another window may have changed it while we waited.
      const state = await api.state().catch((cause) => {
        deps.report("offerState", cause)
        return undefined
      })
      // No retry loop this run: an unreadable state leaves the offer due for the next launch.
      if (!state) return finish("failed")
      if (!state.offerPending) return pause("not-due")
      if (deps.busy()) return pause("busy")
      // Closing the offer by any route (Not now, close button, Escape, overlay) declines it. The dialog itself
      // marks on Not now and on install start (C74); marking again on close is idempotent in main.
      const shown = await Promise.resolve(
        deps.show(() => void api.markOffered().catch((cause) => deps.report("markOffered", cause))),
      ).then(
        () => true,
        (cause) => {
          deps.report("offerShow", cause)
          return false
        },
      )
      return finish(shown ? "shown" : "failed")
    },
  }
}

/** The one gate the app uses for this renderer run. */
export const toolsOfferGate = createToolsOfferGate()
