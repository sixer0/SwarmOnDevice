import { createEffect, onCleanup } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { reportToolsError } from "./dialog-install-tools.model"
import { toolsOfferGate } from "./setup-tools-offer.model"

/** Opens the tools dialog once, the first time this release starts, while the offer is due (row 230).
 *  Renders nothing. Hidden on web and when the desktop build has no `setupTools` capability. */
export function SetupToolsOffer() {
  const platform = usePlatform()
  const api = platform.platform === "desktop" ? platform.setupTools : undefined
  if (!api) return null

  const dialog = useDialog()
  const serverSDK = useServerSDK()
  let gone = false
  onCleanup(() => {
    gone = true
  })

  // The dialog is loaded only when the offer is due, so it stays out of the startup tree (senior 12).
  const show = async (onClose: () => void) => {
    const { DialogInstallTools } = await import("./dialog-install-tools")
    if (gone) return
    dialog.show(() => <DialogInstallTools api={api} offer />, onClose)
  }

  // Re-runs when the dialog stack changes, so an offer that found another dialog open waits for it to close.
  createEffect(() => {
    if (dialog.active) return
    void toolsOfferGate.offer({
      api,
      busy: () => gone || dialog.active !== undefined,
      show,
      report: reportToolsError((input) => serverSDK().client.app.log(input), "app.tools-offer"),
    })
  })

  return null
}
