import { useDirectoryPicker } from "@/components/directory-picker"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"

// U-12 (1.2.7): the composer's "Add folder" picks one folder, starting in the project folder, and hands back its path.
// The folder is referenced, not uploaded; the server reads its listing and asks the usual permission when it lies
// outside the project.
export function usePromptFolderPicker() {
  const directoryPicker = useDirectoryPicker()
  const server = useServer()
  const sdk = useSDK()
  const language = useLanguage()
  return () =>
    new Promise<string | undefined>((resolve) => {
      const conn = server.current
      if (!conn) return resolve(undefined)
      directoryPicker({
        server: conn,
        title: language.t("ui.promptInput.addFolder"),
        multiple: false,
        defaultPath: sdk().directory,
        onSelect: (result) => resolve((Array.isArray(result) ? result[0] : result) || undefined),
      })
    })
}
