import type { SavedCommandDraft } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"

const REFUSED = {
  name: "Use lowercase letters, numbers and dashes.",
  taken: "That name is taken. Pick another.",
  empty: "This run has nothing to save yet.",
  long: "That is too long to save.",
  secret: "That looks like it holds a password or key, so it was not saved.",
} as const

/**
 * The run is written up first and the prompt opens with the result, so all anyone has to do is accept or change the name.
 * The prompt is not opened while waiting: it takes its starting text once, and swapping one prompt for another inside
 * the dialog remounts its parent, which would ask the model again each time.
 */
export function useSaveCommand() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  return (sessionID: string) => {
    toast.show({ variant: "info", message: "Writing this up from the run..." })
    void sdk.client.savedCommand
      .draft({ sessionID }, { throwOnError: true })
      .then((result) => dialog.replace(() => <DialogSaveCommand sessionID={sessionID} draft={result.data} />))
      .catch(() => toast.show({ variant: "error", message: "Could not write this run up. Try again." }))
  }
}

function DialogSaveCommand(props: { sessionID: string; draft: SavedCommandDraft }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [saving, setSaving] = createSignal(false)

  const save = async (value: string) => {
    const name = value.trim()
    setSaving(true)
    const response = await sdk.client.savedCommand
      .save({
        name,
        description: props.draft.description,
        template: props.draft.template,
        sessionID: props.sessionID,
      })
      .catch(() => undefined)
    setSaving(false)
    if (!response?.data) return toast.show({ variant: "error", message: "Could not save that. Try again." })
    if (response.data.refused) return toast.show({ variant: "error", message: REFUSED[response.data.refused] })
    dialog.clear()
    toast.show({ variant: "success", message: `Saved /${name}. Type it any time.` })
  }

  return (
    <DialogPrompt
      title="Save as command"
      value={props.draft.name}
      placeholder="name"
      busy={saving()}
      busyText="Saving..."
      description={() => <text fg={theme.textMuted}>{props.draft.description}</text>}
      onConfirm={(value) => void save(value)}
      onCancel={() => dialog.clear()}
    />
  )
}
