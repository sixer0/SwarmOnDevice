import { For, Show } from "solid-js"
import { alwaysLabel, offersAlways } from "./permission-always"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { formatUsd, spendLimitDetail } from "@/components/session/session-spend"
import { permissionRisk, permissionWhat, shownPatterns } from "@/pages/home/agent-board-model"

export const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

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
      {(detail) => (
        <DockPrompt
          kind="permission"
          header={
            <div data-slot="permission-row" data-variant="header">
              <span data-slot="permission-icon">
                <Icon name="warning" size="normal" />
              </span>
              <div data-slot="permission-header-title">{language.t("session.spend.title")}</div>
            </div>
          }
          footer={
            <>
              <div />
              <div data-slot="permission-footer-actions">
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
            </>
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
      )}
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

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div class="min-w-0 text-12-regular text-text-weak">
            <Show when={props.request.movesOnAt}>
              {(at) => language.t("session.movesOn.hint", { time: clockTime(at()) })}
            </Show>
          </div>
          <div data-slot="permission-footer-actions">
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
        </>
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
