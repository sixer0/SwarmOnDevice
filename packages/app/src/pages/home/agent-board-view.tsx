import { SessionTabAvatarView } from "@/pages/layout/session-tab-avatar"
import { alwaysLabel, offersAlways } from "@/pages/session/composer/permission-always"
import { useLanguage } from "@/context/language"
import { formatUsd, spendLimitDetail } from "@/components/session/session-spend"
import { displayName, errorMessage } from "@/pages/layout/helpers"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { createEffect, createMemo, For, type JSX, on, Show } from "solid-js"
import { createAgentBoardFocus, createMinuteClock, type AgentBoardController } from "./agent-board-controller"
import { inlineQuestion, permissionDetail, permissionRisk, type AgentBoardNeed } from "./agent-board-model"

const SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"
const ROW = `
  group/agent flex min-w-0 flex-col rounded-[8px] outline-none
  transition-[background-color,box-shadow] duration-[120ms] ease-in-out
  hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover
  focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]
`

// Keyboard contract for a focused row. Single letters only fire while a row has focus and no modifier is held, so
// they never compete with typing or with the app's global shortcuts.
type RowKeys = Partial<Record<string, () => void>>

const rowKeys = new WeakMap<Element, () => RowKeys>()

function Section(props: { name: string; title: string; count: number; children: JSX.Element }) {
  return (
    <Show when={props.count > 0}>
      <div data-agent-section={props.name} class="flex flex-col gap-1">
        <div class="flex h-7 items-center gap-2 pl-3 pr-1">
          <span class={SECTION_LABEL}>{props.title}</span>
          <span class="text-v2-text-text-faint tabular-nums [font-weight:440]">{props.count}</span>
        </div>
        <div class="flex flex-col gap-1" role="list">
          {props.children}
        </div>
      </div>
    </Show>
  )
}

function RowTitle(props: { board: AgentBoardController; root: Session; loading?: boolean }) {
  const project = () => props.board.project(props.root.directory)
  const name = () => displayName(project() ?? { worktree: props.root.directory })
  return (
    <button
      type="button"
      tabIndex={-1}
      class="flex min-h-9 min-w-0 flex-1 cursor-default items-center gap-2 border-0 bg-transparent text-left"
      onClick={() => props.board.open(props.root)}
    >
      <SessionTabAvatarView
        project={project()}
        directory={props.root.directory}
        revealProjectOnHover={false}
        unread={false}
        loading={!!props.loading}
      />
      <span class="min-w-0 truncate text-v2-text-text-base [font-weight:530]">
        {sessionTitle(props.root.title) || props.root.id}
      </span>
      <Show when={props.board.showProjectName()}>
        <span class="shrink-0 truncate text-v2-text-text-muted [font-weight:440]">{name()}</span>
      </Show>
    </button>
  )
}

// The letter shows only on the row that has the keyboard, which is the only place it works.
function KeyButton(props: {
  label: string
  keys: string[]
  variant: "ghost-muted" | "outline" | "contrast" | "neutral"
  disabled: boolean
  class?: string
  onClick: () => void
}) {
  return (
    <ButtonV2
      type="button"
      variant={props.variant}
      disabled={props.disabled}
      class={props.class}
      onClick={props.onClick}
    >
      {props.label}
      <KeybindV2
        keys={props.keys}
        variant="ghost"
        class="ml-1.5 !hidden group-focus/agent:!inline-flex [&_[data-slot=keybind-v2-label]]:text-current [&_[data-slot=keybind-v2-label]]:opacity-70"
      />
    </ButtonV2>
  )
}

function NeedRow(props: { board: AgentBoardController; need: AgentBoardNeed }) {
  const language = useLanguage()
  const busy = () => props.board.pending(props.need.key)
  const need = () => props.need
  return (
    <div
      ref={(element) => {
        rowKeys.set(element, () => {
          const item = need()
          const open = () => props.board.open(item.root)
          if (item.kind === "permission")
            return {
              a: () => props.board.allow(item, "once"),
              ...(spendLimitDetail(item.request) ? {} : { A: () => props.board.allow(item, "always") }),
              d: () => props.board.allow(item, "reject"),
              Enter: open,
            }
          const question = inlineQuestion(item.request)
          return {
            Enter: open,
            ...Object.fromEntries(
              (question?.options ?? [])
                .slice(0, 9)
                .map((option, index) => [String(index + 1), () => props.board.answer(item, option.label)]),
            ),
          }
        })
      }}
      data-agent-row
      data-agent-kind={props.need.kind}
      tabIndex={0}
      role="listitem"
      class={`${ROW} border border-v2-border-border-base px-3 pb-2.5`}
    >
      <Show
        when={props.need.kind === "permission" && props.need}
        keyed
        fallback={
          <>
            <RowTitle board={props.board} root={props.need.root} />
            <MovedOnLine at={props.need.request.movedOnAt} />
            <QuestionBody board={props.board} need={props.need as QuestionNeed} busy={busy()} />
          </>
        }
      >
        {(item) => (
          <>
            <div class="flex min-w-0 items-center gap-1.5">
              <RowTitle board={props.board} root={props.need.root} />
              {/* "Allow always" is a standing decision, so it is offered once the row has someone's attention. */}
              <Show when={offersAlways(item.request)}>
                <KeyButton
                  label={alwaysLabel(item.request, language.t)}
                  keys={["⇧", "A"]}
                  variant="ghost-muted"
                  class="md:!hidden md:group-hover/agent:!inline-flex md:group-focus/agent:!inline-flex md:group-focus-within/agent:!inline-flex"
                  disabled={busy()}
                  onClick={() => props.board.allow(item, "always")}
                />
              </Show>
              <KeyButton
                label={
                  spendLimitDetail(item.request)
                    ? language.t("session.spend.stop")
                    : language.t(item.request.movedOnAt ? "session.movedOn.leave" : "ui.permission.deny")
                }
                keys={["D"]}
                variant="outline"
                disabled={busy()}
                onClick={() => props.board.allow(item, "reject")}
              />
              <KeyButton
                label={(() => {
                  const spend = spendLimitDetail(item.request)
                  if (spend) return language.t("session.spend.continue", { amount: formatUsd(spend.next, language.intl()) })
                  return language.t(item.request.movedOnAt ? "session.movedOn.allow" : "ui.permission.allowOnce")
                })()}
                keys={["A"]}
                variant="contrast"
                disabled={busy()}
                onClick={() => props.board.allow(item, "once")}
              />
            </div>
            <MovedOnLine at={item.request.movedOnAt} />
            <Show when={permissionRisk(item.request)} keyed>
              {(risk) => <div class="pb-1 pl-6 text-v2-state-fg-warning [font-weight:440]">{language.t(risk)}</div>}
            </Show>
            <pre
              data-agent-detail
              class={`
                ml-6 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-[6px] px-2.5 py-1.5
                bg-v2-background-bg-layer-02 font-mono text-[12px] leading-[18px] text-v2-text-text-base select-text
              `}
            >
              {(() => {
                const spend = spendLimitDetail(item.request)
                if (spend) return language.t("session.spend.summary", { spent: formatUsd(spend.spent, language.intl()) })
                return permissionDetail(item.request)
              })()}
            </pre>
          </>
        )}
      </Show>
    </div>
  )
}

/** Says why this row is here although the agent is not stuck on it any more. */
function MovedOnLine(props: { at?: number }) {
  const language = useLanguage()
  const now = createMinuteClock()
  return (
    <Show when={props.at}>
      {(at) => (
        <div data-agent-moved-on class="pb-1 pl-6 text-v2-text-text-muted [font-weight:440]">
          {(now(), language.t("home.agents.movedOn", { time: getRelativeTime(new Date(at()).toISOString(), language.t) }))}
        </div>
      )}
    </Show>
  )
}

type QuestionNeed = Extract<AgentBoardNeed, { kind: "question" }>

function QuestionBody(props: { board: AgentBoardController; need: QuestionNeed; busy: boolean }) {
  const language = useLanguage()
  const inline = createMemo(() => inlineQuestion(props.need.request))
  const first = () => props.need.request.questions[0]
  return (
    <>
      <div class="whitespace-pre-wrap pl-6 text-v2-text-text-base [font-weight:440] select-text">
        {first()?.question ?? language.t("notification.question.title")}
      </div>
      <div class="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        <Show
          when={inline()}
          fallback={
            <KeyButton
              label={language.t("common.open")}
              keys={["↵"]}
              variant="contrast"
              disabled={props.busy}
              onClick={() => props.board.open(props.need.root)}
            />
          }
        >
          {(question) => (
            <For each={question().options.slice(0, 9)}>
              {(option, index) => (
                <KeyButton
                  label={option.label}
                  keys={[String(index() + 1)]}
                  variant="outline"
                  disabled={props.busy}
                  onClick={() => props.board.answer(props.need, option.label)}
                />
              )}
            </For>
          )}
        </Show>
      </div>
    </>
  )
}

/** A running agent is already in the session list below. One that keeps failing and retrying is not fine. */
function RetryingRow(props: {
  board: AgentBoardController
  root: Session
  status: Extract<SessionStatus, { type: "retry" }>
  now: number
}) {
  const language = useLanguage()
  const elapsed = () => {
    props.now
    return getRelativeTime(new Date(props.board.since(props.root)).toISOString(), language.t)
  }
  const line = () =>
    language.t("ui.sessionTurn.retry.attemptLine", { line: props.status.message, attempt: props.status.attempt })
  return (
    <div
      ref={(element) =>
        rowKeys.set(element, () => ({
          x: () => props.board.stop(props.root),
          Enter: () => props.board.open(props.root),
        }))
      }
      data-agent-row
      data-agent-kind="running"
      tabIndex={0}
      role="listitem"
      class={`${ROW} px-3`}
    >
      <div class="flex min-w-0 items-center gap-2">
        <RowTitle board={props.board} root={props.root} loading />
        <span class="min-w-0 max-w-[40%] shrink truncate text-v2-state-fg-warning [font-weight:440]" title={line()}>
          {line()}
        </span>
        <span class="shrink-0 text-v2-text-text-faint tabular-nums [font-weight:440]">{elapsed()}</span>
        <KeyButton
          label={language.t("prompt.action.stop")}
          keys={["X"]}
          variant="ghost-muted"
          disabled={props.board.pending(props.root.id)}
          onClick={() => props.board.stop(props.root)}
        />
      </div>
    </div>
  )
}

function FailedRow(props: { board: AgentBoardController; root: Session; detail: string; time: number; now: number }) {
  const language = useLanguage()
  const when = () => {
    props.now
    return getRelativeTime(new Date(props.time).toISOString(), language.t)
  }
  return (
    <div
      ref={(element) =>
        rowKeys.set(element, () => ({
          d: () => props.board.dismiss(props.root.id),
          Enter: () => props.board.open(props.root),
        }))
      }
      data-agent-row
      data-agent-kind="failed"
      tabIndex={0}
      role="listitem"
      class={`${ROW} px-3`}
    >
      <div class="flex min-w-0 items-center gap-2">
        <RowTitle board={props.board} root={props.root} />
        <span class="shrink-0 text-v2-text-text-faint tabular-nums [font-weight:440]">{when()}</span>
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="small"
          class="shrink-0 md:opacity-0 md:group-hover/agent:opacity-100 md:group-focus/agent:opacity-100 md:focus-visible:opacity-100"
          icon={<IconV2 name="close" />}
          aria-label={language.t("common.dismiss")}
          title={language.t("common.dismiss")}
          onClick={() => props.board.dismiss(props.root.id)}
        />
      </div>
      <div class="truncate pb-2 pl-6 text-v2-state-fg-danger [font-weight:440]" title={props.detail}>
        {props.detail}
      </div>
    </div>
  )
}

export function AgentBoardView(props: { board: AgentBoardController }) {
  const language = useLanguage()
  const now = createMinuteClock()
  let root: HTMLElement | undefined

  const rows = () => [...(root?.querySelectorAll<HTMLElement>("[data-agent-row]") ?? [])]
  const retrying = () =>
    props.board.board.running.flatMap((item) =>
      item.status.type === "retry" ? [{ root: item.root, status: item.status }] : [],
    )
  const total = () => props.board.board.needs.length + retrying().length + props.board.board.failed.length

  // Answering a request removes its row. The next one takes over the keyboard, so a run of approvals is just "a a a".
  let refocusIndex: number | undefined
  createEffect(
    on(total, () => {
      const index = refocusIndex
      refocusIndex = undefined
      if (index === undefined) return
      queueMicrotask(() => {
        // Only when the focused row is what just disappeared; never pull focus from somewhere the user moved to.
        if (document.activeElement && document.activeElement !== document.body) return
        const list = rows()
        list[Math.min(index, list.length - 1)]?.focus()
      })
    }),
  )

  createAgentBoardFocus(total, () => rows()[0])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement
    const row = target.closest<HTMLElement>("[data-agent-row]")
    if (!row) return
    const list = rows()
    const index = list.indexOf(row)
    if (event.key === "ArrowDown" || event.key === "j" || event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault()
      const delta = event.key === "ArrowDown" || event.key === "j" ? 1 : -1
      list[Math.max(0, Math.min(list.length - 1, index + delta))]?.focus()
      return
    }
    // A focused control keeps its own Enter/Space; the row's keys apply only when the row itself has focus.
    if (target !== row) return
    const action =
      rowKeys.get(row)?.()[event.key === "A" || event.key === "Enter" ? event.key : event.key.toLowerCase()]
    if (!action) return
    event.preventDefault()
    refocusIndex = event.key === "Enter" ? undefined : index
    action()
  }

  return (
    <section
      ref={root}
      data-component="home-agent-board"
      aria-label={language.t("home.agents.label")}
      class="flex flex-col gap-3 pr-3 pt-3 empty:hidden"
      onKeyDown={onKeyDown}
    >
      <Section name="needs" title={language.t("home.agents.needsYou")} count={props.board.board.needs.length}>
        <For each={props.board.board.needs}>{(need) => <NeedRow board={props.board} need={need} />}</For>
      </Section>

      <Section name="failed" title={language.t("home.agents.failed")} count={props.board.board.failed.length}>
        <For each={props.board.board.failed}>
          {(item) => (
            <FailedRow
              board={props.board}
              root={item.root}
              detail={errorMessage(item.error, language.t("notification.session.error.fallbackDescription"))}
              time={item.time}
              now={now()}
            />
          )}
        </For>
      </Section>

      <Section name="running" title={language.t("home.agents.running")} count={retrying().length}>
        <For each={retrying()}>
          {(item) => <RetryingRow board={props.board} root={item.root} status={item.status} now={now()} />}
        </For>
      </Section>

      <Show when={props.board.status.failed()}>
        <div data-agent-state="failed" class="flex items-center gap-2 pl-3 text-v2-text-text-muted [font-weight:440]">
          <span class="min-w-0 truncate">{language.t("home.agents.unreachable")}</span>
          <ButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            disabled={props.board.status.retrying()}
            onClick={props.board.status.retry}
          >
            {language.t("home.agents.retry")}
          </ButtonV2>
        </div>
      </Show>
    </section>
  )
}
