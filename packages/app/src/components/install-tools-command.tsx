import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { installToolsCommand, reportToolsError } from "./dialog-install-tools.model"

/** `tools.install` in the palette on every page and `/install-tools` in every composer (senior 19), so a person
 *  who chose Not now can come back from Home too. Mounted once in the server-scoped shell, next to the offer.
 *  Renders nothing. Not registered on web or on a desktop build without the `setupTools` capability. */
export function InstallToolsCommand() {
  const platform = usePlatform()
  const api = platform.platform === "desktop" ? platform.setupTools : undefined
  if (!api) return null

  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const report = reportToolsError((input) => serverSDK().client.app.log(input), "app.install-tools-command")

  // Opens the same dialog as the first-run offer.
  const open = async () => {
    try {
      const { DialogInstallTools } = await import("./dialog-install-tools")
      void dialog.show(() => <DialogInstallTools api={api} />)
    } catch (cause) {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
      report("open", cause)
    }
  }

  command.register("install-tools", () => [
    installToolsCommand({
      title: language.t("command.tools.install"),
      category: language.t("command.category.settings"),
      open: () => void open(),
    }),
  ])

  return null
}
