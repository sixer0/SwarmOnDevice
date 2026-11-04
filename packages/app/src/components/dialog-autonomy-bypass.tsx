import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { For, onCleanup, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"

// The order the person reads them in; the intro is the dialog's description, the rest follow as paragraphs.
const PARAGRAPHS = [
  "dialog.autonomyBypass.archive",
  "dialog.autonomyBypass.refused",
  "dialog.autonomyBypass.waits",
  "dialog.autonomyBypass.secrets",
  "dialog.autonomyBypass.report",
  "dialog.autonomyBypass.scope",
] as const

/**
 * The Indonesian text marks loanwords (*bypass*, *deploy*, *script*) as `*word*`, as the language rule asks; they are
 * shown in italics, and the asterisks never reach the screen. Text without them is returned as it is.
 */
export function emphasised(text: string): JSX.Element {
  const parts = text.split(/\*([^*\n]+)\*/)
  if (parts.length === 1) return text
  return parts.map((part, index) => (index % 2 === 1 ? <em>{part}</em> : part)) as unknown as JSX.Element
}

/** Asks once per activation, before autonomous mode turns on with the main agent deciding. Turning off never asks. */
export function DialogAutonomyBypass(props: { onAccept: () => void; onGone: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  // Another dialog may replace this one without closing it: that is a no, never a pending question.
  onCleanup(props.onGone)
  return (
    <DialogV2 fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("dialog.autonomyBypass.title")}
          description={emphasised(language.t("dialog.autonomyBypass.intro"))}
        />
      </DialogHeader>
      <DialogBody class="flex max-h-[min(420px,calc(100vh-200px))] flex-col gap-2 overflow-y-auto px-4 pb-1">
        <For each={PARAGRAPHS}>
          {(key) => (
            <p data-autonomy-bypass-paragraph={key} class="text-[13px] text-v2-text-text-base">
              {emphasised(language.t(key))}
            </p>
          )}
        </For>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          data-autonomy-bypass-accept
          variant="contrast"
          onClick={() => {
            props.onAccept()
            dialog.close()
          }}
        >
          {language.t("dialog.autonomyBypass.accept")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}

type Dialog = Pick<ReturnType<typeof useDialog>, "show" | "close">

/** True only when the person agreed. Cancel, Escape, a click outside or any other close is false. */
export function confirmAutonomyBypass(dialog: Dialog): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let accepted = false
    const settle = () => resolve(accepted)
    void Promise.resolve(
      dialog.show(
        () => (
          <DialogAutonomyBypass
            onAccept={() => {
              accepted = true
            }}
            onGone={settle}
          />
        ),
        settle,
      ),
    ).catch(() => resolve(false))
  })
}
