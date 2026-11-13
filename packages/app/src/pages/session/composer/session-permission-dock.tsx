import { For, Show, onCleanup, onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { alwaysLabel, offersAlways } from "./permission-always"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { formatUsd, spendLimitDetail } from "@/components/session/session-spend"
import { permissionRisk, permissionWhat, shownPatterns } from "@/pages/home/agent-board-model"

// Row 173 (F146b-4): the dock footer (session-ui) is one nowrap flex row, so in a narrow session pane the buttons kept
// their width and squeezed the "No answer by ..." hint into a one-word column under the Deny button. The footer now holds
// one full-width row that wraps: the hint takes the free width (at least 12rem), the buttons move below it and wrap
// among themselves when the pane is narrower than they are.
const FOOTER_ROW = "flex w-full min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2"
const FOOTER_HINT = "min-w-0 grow basis-48 text-12-regular text-text-weak"
const FOOTER_ACTIONS = "min-w-0 flex-wrap justify-end gap-y-2"

export const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/**
 * 1.2.7 U-5 (C6, D-11, SR7-14): the prompt's body (session-ui `data-slot="permission-body"`) is the one scroll area and
 * the footer buttons stay outside it. This binds, in the calling owner:
 * - `--permission-prompt-max-height` (N7-036) on the dock, measured like `--question-prompt-max-height` in
 *   session-question-dock.tsx, so the dock never grows under the session's sticky header;
 * - `data-permission-body-more` (N7-149) on the body while text is hidden below, which message-part.css draws as a fade,
 *   so a long command whose tail is cut shows it in both scrollbar modes;
 * - the body starts at its top, so the start of the command is what is read first.
 * Returns the ref for DockPrompt.
 */
function bindPermissionBody() {
  let root: HTMLDivElement | undefined
  const body = () => root?.querySelector<HTMLElement>('[data-slot="permission-body"]') ?? undefined

  const cue = () => {
    const el = body()
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.setAttribute("data-permission-body-more", "")
    else el.removeAttribute("data-permission-body-more")
  }

  const measure = () => {
    if (!root) return
    const scroller = document.querySelector(".scroll-view__viewport")
    const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
    const top =
      head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
    const dock = root.closest('[data-component="session-prompt-dock"]')
    if (!top || !(dock instanceof HTMLElement)) {
      root.style.removeProperty("--permission-prompt-max-height")
      return
    }
    const dockBottom = dock.getBoundingClientRect().bottom
    const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
    const max = Math.max(240, Math.floor(dockBottom - top - 8 - below))
    root.style.setProperty("--permission-prompt-max-height", `${max}px`)
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
        cue()
      })
    }
    const el = body()
    if (el) {
      el.scrollTop = 0
      makeEventListener(el, "scroll", cue, { passive: true })
      createResizeObserver([el, ...Array.from(el.children)], update)
    }
    makeEventListener(window, "resize", update)
    createResizeObserver([root?.closest('[data-component="session-prompt-dock"]'), document.querySelector(".scroll-view__viewport")], update)
    cue()
    update()
    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })
  })

  return (el: HTMLDivElement) => (root = el)
}

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const spend = () => spendLimitDetail(props.request)
  const money = (value: number) => formatUsd(value, language.intl())

  // Always says what is asked (row 171): a risk note when the call cannot be undone, else the tool in plain words.
  const toolDescription = () => {
    const risk = permissionRisk(props.request)
    if (risk) return language.t(risk)
    return permissionWhat(props.request, language.t)
  }

  return (
    <Show
      when={spend()}
      fallback={<RegularPermission {...props} toolDescription={toolDescription()} />}
    >
      {(detail) => {
        const ref = bindPermissionBody()
        return (
          <DockPrompt
            kind="permission"
            ref={ref}
            header={
              <div data-slot="permission-row" data-variant="header">
                <span data-slot="permission-icon">
                  <Icon name="warning" size="normal" />
                </span>
                <div data-slot="permission-header-title">{language.t("session.spend.title")}</div>
              </div>
            }
            footer={
              <div class={FOOTER_ROW} data-permission-footer-row>
                <div data-slot="permission-footer-actions" class={FOOTER_ACTIONS}>
                  <Button
                    variant="ghost"
                    size="normal"
                    onClick={() => props.onDecide("reject")}
                    disabled={props.responding}
                  >
                    {language.t("session.spend.stop")}
                  </Button>
                  <Button
                    variant="primary"
                    size="normal"
                    onClick={() => props.onDecide("once")}
                    disabled={props.responding}
                  >
                    {language.t("session.spend.continue", { amount: money(detail().next) })}
                  </Button>
                </div>
              </div>
            }
          >
            <div data-slot="permission-row">
              <span data-slot="permission-spacer" aria-hidden="true" />
              <div data-slot="permission-hint">
                {language.t("session.spend.summary", { spent: money(detail().spent) })}
                <Show when={detail().subagents > 0}>
                  {" "}
                  {language.t("context.spend.subagents")}: {detail().subagents} ({money(detail().subagentCost)})
                </Show>
              </div>
            </div>
          </DockPrompt>
        )
      }}
    </Show>
  )
}

function RegularPermission(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
  toolDescription: string
}) {
  const language = useLanguage()
  const toolDescription = () => props.toolDescription
  const ref = bindPermissionBody()

  return (
    <DockPrompt
      kind="permission"
      ref={ref}
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <div class={FOOTER_ROW} data-permission-footer-row>
          <Show when={props.request.movesOnAt}>
            {(at) => (
              <div class={FOOTER_HINT} data-permission-footer-hint>
                {language.t("session.movesOn.hint", { time: clockTime(at()) })}
              </div>
            )}
          </Show>
          <div data-slot="permission-footer-actions" class={FOOTER_ACTIONS}>
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Show when={offersAlways(props.request)}>
              <Button
                variant="secondary"
                size="normal"
                onClick={() => props.onDecide("always")}
                disabled={props.responding}
              >
                {alwaysLabel(props.request, language.t)}
              </Button>
            </Show>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </div>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      {/* A lone `*` (every MCP tool call) says nothing a person can read, so only real patterns are shown. */}
      <Show when={shownPatterns(props.request.patterns).length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={shownPatterns(props.request.patterns)}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
