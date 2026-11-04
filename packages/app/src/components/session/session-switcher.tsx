import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { useSessionLayout } from "@/pages/session/session-layout"
import { chooseSession, projectSessions, rootSessionID, type ProjectSessionItem } from "./session-switcher-model"

/**
 * One compact dropdown in the session header listing the root sessions of the current project (worktree +
 * sandboxes). Choosing one opens it in a tab, or focuses its tab when it is already open.
 */
export function SessionSwitcher(props: { variant: "legacy" | "v2"; directories: string[] }) {
  const language = useLanguage()
  const server = useServer()
  const serverSync = useServerSync()
  const sync = useSync()
  const tabs = useTabs()
  const { params } = useSessionLayout()
  const [open, setOpen] = createSignal(false)

  const currentRootID = createMemo(() => {
    const id = params.id
    if (!id) return ""
    return rootSessionID(id, (sessionID) => sync().session.get(sessionID))
  })

  // Warm sidebar stores; `bootstrap: false` so reading them never starts a directory bootstrap.
  const items = createMemo<ProjectSessionItem[]>(() => {
    if (!open()) return []
    const stores = props.directories.map((dir) => serverSync().child(dir, { bootstrap: false })[0])
    return projectSessions(stores, currentRootID(), tabs.store, server.key)
  })

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) return
    for (const dir of props.directories) {
      void Promise.resolve(serverSync().project.loadSessions(dir)).catch((error) => {
        console.debug("[session-switcher] failed to load sessions", { dir, error })
      })
    }
  }

  const choose = (item: ProjectSessionItem) => {
    setOpen(false)
    chooseSession(tabs, server.key, item.session, currentRootID())
  }

  const label = () => language.t("session.header.sessions.label")
  const mark = (item: ProjectSessionItem) =>
    item.current
      ? language.t("session.header.sessions.current")
      : item.open
        ? language.t("session.header.sessions.open")
        : undefined
  const title = (item: ProjectSessionItem) => item.session.title || item.session.id

  return (
    <Show
      when={props.variant === "v2"}
      fallback={
        <DropdownMenu gutter={4} placement="bottom-end" open={open()} onOpenChange={onOpenChange}>
          <Tooltip placement="bottom" value={label()}>
            <DropdownMenu.Trigger
              as={Button}
              variant="ghost"
              class="titlebar-icon w-8 h-6 p-0 box-border shrink-0"
              aria-label={label()}
            >
              <Icon size="small" name="bubble-5" />
            </DropdownMenu.Trigger>
          </Tooltip>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="max-h-96 max-w-80 overflow-y-auto">
              <DropdownMenu.Group>
                <DropdownMenu.GroupLabel class="!px-1 !py-1">{label()}</DropdownMenu.GroupLabel>
                <Show
                  when={items().length > 0}
                  fallback={
                    <div class="px-2 py-1 text-12-regular text-text-weak">
                      {language.t("session.header.sessions.empty")}
                    </div>
                  }
                >
                  <For each={items()}>
                    {(item) => (
                      <DropdownMenu.Item onSelect={() => choose(item)}>
                        <DropdownMenu.ItemLabel class="truncate">{title(item)}</DropdownMenu.ItemLabel>
                        <Show when={mark(item)}>
                          {(text) => <span class="ml-auto pl-2 shrink-0 text-12-regular text-text-weak">{text()}</span>}
                        </Show>
                      </DropdownMenu.Item>
                    )}
                  </For>
                </Show>
              </DropdownMenu.Group>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      }
    >
      <MenuV2 gutter={4} modal={false} placement="bottom-end" open={open()} onOpenChange={onOpenChange}>
        <TooltipV2 class="shrink-0" placement="bottom" value={label()}>
          <MenuV2.Trigger
            as={IconButtonV2}
            type="button"
            variant="ghost-muted"
            size="large"
            class="!w-9 shrink-0"
            aria-label={label()}
            icon={<Icon name="bubble-5" size="small" />}
          />
        </TooltipV2>
        <MenuV2.Portal>
          <MenuV2.Content class="max-h-96 max-w-80 overflow-y-auto">
            <MenuV2.Group>
              <MenuV2.GroupLabel>{label()}</MenuV2.GroupLabel>
              <Show
                when={items().length > 0}
                fallback={<MenuV2.Item disabled>{language.t("session.header.sessions.empty")}</MenuV2.Item>}
              >
                <For each={items()}>
                  {(item) => (
                    <MenuV2.Item badge={mark(item)} onSelect={() => choose(item)}>
                      <span class="truncate">{title(item)}</span>
                    </MenuV2.Item>
                  )}
                </For>
              </Show>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </Show>
  )
}
