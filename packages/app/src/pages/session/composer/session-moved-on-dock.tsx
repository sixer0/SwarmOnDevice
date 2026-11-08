import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { useLanguage } from "@/context/language"
import { permissionDetail } from "@/pages/home/agent-board-model"
import type { MovedOnRequest } from "./session-request-tree"

/** What the agent carried on without while nobody answered. Sits with the composer and blocks nothing. */
export function SessionMovedOnDock(props: {
  items: MovedOnRequest[]
  responding: (id: string) => boolean
  onAllow: (request: Extract<MovedOnRequest, { kind: "permission" }>["request"]) => void
  onAnswer: (id: string) => void
  onLeave: (item: MovedOnRequest) => void
}) {
  const language = useLanguage()
  return (
    <DockTray
      data-component="session-moved-on-dock"
      style={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <div class="px-3 pt-2 pb-7 flex flex-col gap-1 max-h-48 overflow-y-auto no-scrollbar">
        <div class="text-13-medium text-text-strong">{language.t("session.movedOn.title")}</div>
        <For each={props.items}>
          {(item) => (
            <div data-moved-on-row={item.kind} class="flex items-center gap-2 min-w-0 py-1">
              <Show
                when={item.kind === "permission" && item.request}
                keyed
                fallback={
                  <span class="min-w-0 flex-1 truncate text-13-regular text-text-base">
                    {item.kind === "question" ? item.request.questions[0]?.question : ""}
                  </span>
                }
              >
                {(request) => (
                  <code class="min-w-0 flex-1 truncate text-12-regular text-text-base" title={permissionDetail(request, language.t)}>
                    {permissionDetail(request, language.t)}
                  </code>
                )}
              </Show>
              <Button
                size="small"
                variant="ghost"
                class="shrink-0"
                disabled={props.responding(item.request.id)}
                onClick={() => props.onLeave(item)}
              >
                {language.t("session.movedOn.leave")}
              </Button>
              <Button
                size="small"
                variant="secondary"
                class="shrink-0"
                disabled={props.responding(item.request.id)}
                onClick={() => {
                  if (item.kind === "permission") return props.onAllow(item.request)
                  props.onAnswer(item.request.id)
                }}
              >
                {language.t(item.kind === "permission" ? "session.movedOn.allow" : "session.movedOn.answer")}
              </Button>
            </div>
          )}
        </For>
      </div>
    </DockTray>
  )
}
