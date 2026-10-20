import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { JSX, Show } from "solid-js"

export type DialogGoUpsellProps = {
  title: string
  description: JSX.Element
  link?: string
  // Optional: an absent translation hides the button instead of rendering it blank
  // (fabricated Go upsell keys deleted in s99 §11; row 49 hide pattern).
  actionLabel?: string
  onClose?: (dontShowAgain?: boolean) => void
}

export function DialogUsageExceeded(props: DialogGoUpsellProps) {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()

  const runAction = () => {
    if (props.link) platform.openExternal(props.link)
    props.onClose?.()
    dialog.close()
  }

  const dismiss = () => {
    props.onClose?.(true)
    dialog.close()
  }

  return (
    <Dialog title={props.title} description={props.description} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={dismiss}>
            {language.t("dialog.usageExceeded.dontShowAgain")}
          </Button>
          <Show when={props.actionLabel}>
            {(label) => (
              <Button variant="primary" size="large" onClick={runAction}>
                {label()}
              </Button>
            )}
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
