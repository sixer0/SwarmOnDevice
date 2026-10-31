import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

/**
 * Says so when a finished run is a job this project keeps asking for, and offers to keep it. Nothing shows otherwise,
 * and "no" is remembered. The check costs one local query and no tokens, and a failed check just means no line.
 */
export function SessionRepeatDock(props: { sessionID: string }) {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const [hidden, setHidden] = createSignal(false)

  const idle = () => !sync().data.session_working(props.sessionID)
  const [repeat, control] = createResource(
    () => (idle() ? props.sessionID : undefined),
    (sessionID) =>
      sdk()
        .client.savedCommand.repeat({ sessionID })
        .then((response) => response.data?.times ?? 0)
        .catch(() => 0),
  )
  createEffect(() => onCleanup(sdk().event.on("command.updated", () => void control.refetch())))

  const times = () => {
    if (hidden() || !idle() || repeat.loading) return 0
    return Number(repeat.latest ?? 0)
  }
  const open = () =>
    void import("@/components/saved-command").then((module) =>
      dialog.show(() => <module.DialogSavedCommands sessionID={props.sessionID} />),
    )
  const decline = () => {
    setHidden(true)
    void sdk()
      .client.savedCommand.decline({ sessionID: props.sessionID })
      .catch(() => undefined)
  }

  return (
    <Show when={times() > 0}>
      <DockTray
        data-component="session-repeat-dock"
        style={{
          "margin-bottom": "-0.875rem",
          "border-bottom-left-radius": 0,
          "border-bottom-right-radius": 0,
        }}
      >
        <div class="flex flex-wrap items-center gap-2 min-w-0 px-3 pt-2 pb-5">
          <span class="min-w-[min(60%,240px)] flex-1 text-13-regular text-text-base">
            {language.t("savedCommand.repeat", { times: times() })}
          </span>
          <Button size="small" variant="ghost" class="shrink-0" data-repeat-decline onClick={decline}>
            {language.t("savedCommand.repeat.no")}
          </Button>
          <Button size="small" variant="secondary" class="shrink-0" data-repeat-save onClick={open}>
            {language.t("savedCommand.title")}
          </Button>
        </div>
      </DockTray>
    </Show>
  )
}
