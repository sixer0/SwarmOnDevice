import { useNavigate, useParams } from "@solidjs/router"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { For, Match, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { getRelativeTime } from "@/utils/time"
import { checksInstruction, isAttachItem, type PreflightItem } from "./preflight-model"
import { createPreflight, type PreflightWorktree } from "./preflight-controller"

export type PreflightOptions = {
  fresh: () => boolean
  active: () => boolean
  sessionID: () => string | undefined
  worktree?: PreflightWorktree
  restoreFocus: () => void
}

export function PromptPreflight(props: PreflightOptions) {
  const language = useLanguage()
  const command = useCommand()
  const sdk = useSDK()
  const params = useParams()
  const navigate = useNavigate()
  const preflight = createPreflight({
    active: props.active,
    fresh: props.fresh,
    sessionID: props.sessionID,
    worktree: props.worktree,
  })
  const [view, setView] = persisted(Persist.global("prompt.preflight"), createStore({ collapsed: false }))
  let panel: HTMLDivElement | undefined
  const visible = () =>
    preflight.items().length > 0 || preflight.attachments().length > 0 || preflight.failed() || preflight.loading()

  const buttons = () => Array.from(panel?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])
  const rowButtons = () => Array.from(panel?.querySelectorAll<HTMLButtonElement>("li button:not(:disabled)") ?? [])
  const focusFirst = () => requestAnimationFrame(() => (rowButtons()[0] ?? buttons()[0])?.focus())
  // After a row acts on itself it disappears; keep the keyboard user in the panel until it is empty, then go home.
  const settle = (index: number) =>
    requestAnimationFrame(() => {
      const left = rowButtons()
      if (left.length === 0) return props.restoreFocus()
      left[Math.min(index, left.length - 1)]?.focus()
    })
  const act = (event: MouseEvent, run: () => void) => {
    const index = rowButtons().indexOf(event.currentTarget as HTMLButtonElement)
    const keyboard = document.activeElement === event.currentTarget
    run()
    if (keyboard) settle(index)
  }

  command.register("prompt-preflight", () => [
    {
      id: "prompt.preflight.focus",
      title: language.t("command.prompt.preflight.focus"),
      category: language.t("command.category.session"),
      keybind: "mod+shift+g",
      disabled: !visible(),
      onSelect: () => {
        setView("collapsed", false)
        focusFirst()
      },
    },
  ])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.restoreFocus()
      return
    }
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
    if (!step) return
    const list = buttons()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    if (index === -1) return
    event.preventDefault()
    list[(index + step + list.length) % list.length]?.focus()
  }

  const open = (id: string) =>
    navigate(
      params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(sdk().directory, id),
    )

  return (
    <Show when={visible()}>
      <div
        ref={panel}
        data-component="prompt-preflight"
        role="region"
        aria-label={language.t("prompt.preflight.title")}
        class="pointer-events-auto w-full overflow-hidden rounded-xl border border-v2-border-border-base bg-v2-background-bg-base text-[12px] leading-4 text-v2-text-text-muted"
        onKeyDown={onKeyDown}
      >
        <div class="flex h-8 items-center gap-1.5 pl-3 pr-1">
          <span class="truncate font-[530] text-v2-text-text-base">{language.t("prompt.preflight.title")}</span>
          <Show when={preflight.items().length > 0}>
            <span data-preflight-count class="tabular-nums text-v2-text-text-faint">
              {preflight.items().length}
            </span>
          </Show>
          <Show when={preflight.loading()}>
            <span data-preflight-loading class="flex items-center gap-1 text-v2-text-text-faint" role="status">
              <Spinner class="size-3" />
              <span class="truncate">{language.t("prompt.preflight.checking")}</span>
            </span>
          </Show>
          <span class="flex-1" />
          <KeybindV2
            class="hidden sm:inline-flex"
            variant="ghost"
            keys={command.keybindParts("prompt.preflight.focus")}
          />
          <Show when={preflight.attachable().length > 1 && !view.collapsed}>
            <ButtonV2
              data-preflight-attach-all
              variant="ghost"
              size="small"
              onClick={(event: MouseEvent) => act(event, preflight.attachAll)}
            >
              {language.t("prompt.preflight.attachAll")}
            </ButtonV2>
          </Show>
          <IconButtonV2
            data-preflight-toggle
            variant="ghost-muted"
            size="small"
            icon={<Icon name="chevron-down" class={view.collapsed ? "rotate-180" : undefined} />}
            aria-expanded={!view.collapsed}
            aria-label={language.t(view.collapsed ? "prompt.preflight.expand" : "prompt.preflight.collapse")}
            onClick={() => setView("collapsed", !view.collapsed)}
          />
        </div>
        <Show when={!view.collapsed}>
          <Show when={preflight.failed()}>
            <div data-preflight-failed class="flex flex-wrap items-center gap-2 border-t border-v2-border-border-base px-3 py-1.5">
              <span class="min-w-0 flex-1">{language.t("prompt.preflight.failed")}</span>
              <ButtonV2
                variant="ghost"
                size="small"
                disabled={preflight.cooldown() > 0 || !preflight.retriesLeft()}
                onClick={preflight.retry}
              >
                {preflight.cooldown() > 0
                  ? language.t("prompt.preflight.retryIn", { seconds: preflight.cooldown() })
                  : language.t("prompt.preflight.retry")}
              </ButtonV2>
            </div>
          </Show>
          <Show when={preflight.attachments().length > 0}>
            <div
              data-preflight-attached
              class="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-v2-border-border-base py-1 pl-3 pr-1"
            >
              <span class="text-v2-text-text-faint">{language.t("prompt.preflight.attached")}</span>
              <For each={preflight.attachments()}>
                {(item) => {
                  const label = () =>
                    item.selection ? `${item.path}:${item.selection.startLine}-${item.selection.endLine}` : item.path
                  return (
                    <span class="flex min-w-0 items-center gap-1 rounded-md bg-v2-overlay-simple-overlay-hover pl-1.5">
                      <FileIcon node={{ path: item.path, type: "file" }} class="size-3.5 shrink-0" />
                      <Code>{label()}</Code>
                      <IconButtonV2
                        data-preflight-detach
                        variant="ghost-muted"
                        size="small"
                        icon={<Icon name="xmark-small" />}
                        aria-label={language.t("prompt.preflight.detach", { path: label() })}
                        onClick={() => preflight.detach(item.key)}
                      />
                    </span>
                  )
                }}
              </For>
            </div>
          </Show>
          <ul class="max-h-[min(13rem,22vh)] overflow-y-auto">
            <For each={preflight.items()}>
              {(item) => (
                <li
                  data-preflight-row={item.kind}
                  class="group/row flex min-h-8 flex-wrap items-center gap-x-2 border-t border-v2-border-border-base py-1 pl-3 pr-1"
                >
                  <Show when={isAttachItem(item) ? item.path : undefined}>
                    {(path) => <FileIcon node={{ path: path(), type: "file" }} class="size-3.5 shrink-0" />}
                  </Show>
                  <div class="min-w-[min(60%,240px)] flex-1 break-words">
                    <RowText item={item} />
                  </div>
                  <div class="ml-auto flex shrink-0 items-center gap-0.5">
                    <RowActions
                      item={item}
                      preflight={preflight}
                      act={act}
                      onOpen={open}
                    />
                    <IconButtonV2
                      data-preflight-dismiss
                      variant="ghost-muted"
                      size="small"
                      icon={<Icon name="xmark-small" />}
                      aria-label={language.t("common.dismiss")}
                      onClick={(event) => act(event, () => preflight.dismiss(item.key))}
                    />
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Show>
  )
}

function Code(props: { children: JSX.Element }) {
  return <span class="break-all font-mono text-[11.5px] text-v2-text-text-base">{props.children}</span>
}

function RowText(props: { item: PreflightItem }) {
  const language = useLanguage()
  const reason = (text: string) => <span class="text-v2-text-text-faint">{text}</span>
  return (
    <Switch>
      <Match when={props.item.kind === "trace" && props.item}>
        {(item) => (
          <span class="flex flex-wrap items-baseline gap-x-2">
            <Code>
              {item().path}:{item().line}
            </Code>
            {reason(language.t("prompt.preflight.reason.trace"))}
          </span>
        )}
      </Match>
      <Match when={props.item.kind === "mention" && props.item}>
        {(item) => (
          <span class="flex flex-wrap items-baseline gap-x-2">
            <Code>{item().path}</Code>
            {reason(language.t("prompt.preflight.reason.mention"))}
          </span>
        )}
      </Match>
      <Match when={props.item.kind === "definition" && props.item}>
        {(item) => (
          <span class="flex flex-wrap items-baseline gap-x-2">
            <Code>
              {item().path}:{item().line}
            </Code>
            {reason(language.t("prompt.preflight.reason.definition", { identifier: item().identifier }))}
          </span>
        )}
      </Match>
      <Match when={props.item.kind === "use" && props.item}>
        {(item) => (
          <span class="flex flex-wrap items-baseline gap-x-2">
            <Code>
              {item().path}:{item().line}
            </Code>
            {reason(language.t("prompt.preflight.reason.use", { identifier: item().identifier }))}
          </span>
        )}
      </Match>
      <Match when={props.item.kind === "word" && props.item}>
        {(item) => (
          <span class="flex flex-wrap items-baseline gap-x-2">
            <Code>{item().path}</Code>
            {reason(language.t("prompt.preflight.reason.word", { words: item().words.join(", ") }))}
          </span>
        )}
      </Match>
      <Match when={props.item.kind === "typo" && props.item}>
        {(item) => <Warn>{language.t("prompt.preflight.typo", { written: item().written, path: item().path })}</Warn>}
      </Match>
      <Match when={props.item.kind === "missing-path" && props.item}>
        {(item) => <Warn>{language.t("prompt.preflight.missingPath", { path: item().path })}</Warn>}
      </Match>
      <Match when={props.item.kind === "missing-identifier" && props.item}>
        {(item) => <Warn>{language.t("prompt.preflight.missingIdentifier", { identifier: item().identifier })}</Warn>}
      </Match>
      <Match when={props.item.kind === "busy" && props.item}>
        {(item) => (
          <Warn>
            {item().overlap[0]
              ? language.t("prompt.preflight.busy.overlap", { title: item().title, file: item().overlap[0]! })
              : language.t("prompt.preflight.busy", { title: item().title })}
          </Warn>
        )}
      </Match>
      <Match when={props.item.kind === "dirty" && props.item}>
        {(item) => (
          <Show
            when={item().overlap[0]}
            fallback={<span>{language.t("prompt.preflight.dirty", { count: item().count })}</span>}
          >
            {(file) => <Warn>{language.t("prompt.preflight.dirty.overlap", { file: file() })}</Warn>}
          </Show>
        )}
      </Match>
      <Match when={props.item.kind === "similar" && props.item}>
        {(item) => (
          <span>
            {language.t("prompt.preflight.similar", {
              title: item().title,
              time: getRelativeTime(new Date(item().updated).toISOString(), language.t),
            })}
          </span>
        )}
      </Match>
      <Match when={props.item.kind === "checks" && props.item}>
        {(item) => (
          <span>{language.t("prompt.preflight.checks", { commands: checksInstruction(item().commands) })}</span>
        )}
      </Match>
    </Switch>
  )
}

function Warn(props: { children: JSX.Element }) {
  return (
    <span class="flex items-baseline gap-1.5">
      <span class="relative top-[-1px] size-1.5 shrink-0 self-center rounded-full bg-v2-state-fg-warning" />
      <span class="min-w-0 text-v2-text-text-base">{props.children}</span>
    </span>
  )
}

function RowActions(props: {
  item: PreflightItem
  preflight: ReturnType<typeof createPreflight>
  act: (event: MouseEvent, run: () => void) => void
  onOpen: (id: string) => void
}) {
  const language = useLanguage()
  const action = (label: string, run: () => void, name?: string) => (
    <ButtonV2 data-preflight-action={name} variant="ghost" size="small" onClick={(event: MouseEvent) => props.act(event, run)}>
      {label}
    </ButtonV2>
  )
  return (
    <Switch>
      <Match
        when={
          props.item.kind === "trace" ||
          props.item.kind === "mention" ||
          props.item.kind === "definition" ||
          props.item.kind === "use" ||
          props.item.kind === "word"
        }
      >
        {action(language.t("prompt.preflight.attach"), () => props.preflight.attach(props.item), "attach")}
      </Match>
      <Match when={props.item.kind === "typo" && props.item}>
        {(item) => action(language.t("prompt.preflight.typo.fix"), () => props.preflight.fixTypo(item()), "fix")}
      </Match>
      <Match when={props.item.kind === "busy" && props.item}>
        {(item) => (
          <>
            {action(language.t("prompt.preflight.open"), () => props.onOpen(item().id), "open")}
            <Show when={props.preflight.worktreeAvailable()}>
              {action(language.t("prompt.preflight.isolate"), props.preflight.isolate, "isolate")}
            </Show>
          </>
        )}
      </Match>
      <Match when={props.item.kind === "dirty"}>
        <Show when={props.preflight.worktreeAvailable()}>
          {action(language.t("prompt.preflight.isolate"), props.preflight.isolate, "isolate")}
        </Show>
      </Match>
      <Match when={props.item.kind === "similar" && props.item}>
        {(item) =>
          action(
            language.t("prompt.preflight.similar.continue"),
            () => {
              props.preflight.moveDraftTo(item().id)
              props.onOpen(item().id)
            },
            "continue",
          )
        }
      </Match>
      <Match when={props.item.kind === "checks" && props.item}>
        {(item) => action(language.t("prompt.preflight.checks.add"), () => props.preflight.addChecks(item()), "checks")}
      </Match>
    </Switch>
  )
}
