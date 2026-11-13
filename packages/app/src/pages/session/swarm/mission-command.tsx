// Decision card + command channel (row 131; masterplan/01_specs_mission_control_ui.md §6 items 20-31, V6:140-147, :362-384).
// All mission text is agent-written: rendered as text nodes only (§12). Logic lives in mission-command-model.ts.
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { createMemo, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  commandHead,
  createCommandController,
  decisionOptions,
  emptyCommandState,
  feedWho,
  isPlacement,
  isTidy,
  tidyLines,
  type MissionWriter,
  type Translate,
} from "./mission-command-model"
import { FEED_VISIBLE_ROWS, type MissionVM } from "./mission-model"

// 1.2.7 U-4 (C6, R-5): about FEED_VISIBLE_ROWS feed entries show, the rest scroll. An entry is two text lines (who,
// text) plus the 0.25rem gap; `lh` is the line height of the list.
const FEED_MAX_HEIGHT = `max-height: calc(${FEED_VISIBLE_ROWS} * (2lh + 0.25rem))`
// 1.2.7 row 58a (F-2): the floor the feed keeps when the panel is too short for everything; below it the panel
// itself scrolls. At most two entries, so a short feed adds no empty space.
const FEED_FLOOR_ROWS = 2
const feedStyle = (entries: number) =>
  `${FEED_MAX_HEIGHT}; min-height: calc(${Math.min(entries, FEED_FLOOR_ROWS)} * (2lh + 0.25rem))`

// 1.2.7 row 58a (F-2, F-3) layout contract. `[data-mission-command]` and `[data-mission-command-card]` are
// `display: contents`, so the decision card, the feed and the rows around them are direct flex items of the side
// panel (`[data-mission-side]`, a column with a definite height in both layouts). Then the panel's own flex sizing
// does the work: the feed is the one shrinkable list (ONE scroll container, max FEED_VISIBLE_ROWS entries, the rest
// of the panel's height when shorter) and the panel only scrolls when the fixed rows alone do not fit. The decision
// card is capped at the panel height (`max-h-full`); inside it the bounded body shrinks first and the actions,
// outside the body (U-5, C6), keep their height and wrap, so they stay inside the panel.

export function MissionCommand(props: {
  model: MissionVM
  writer: MissionWriter
  /** row 129 controller `refresh` */
  refresh: () => void
  /** normal prompt to the open session's root (§2) */
  prompt: (text: string) => Promise<unknown>
  /** row id of the selected agent (row 130 selection), for the detail line */
  selected?: string
  /**
   * 1.2.8 row 46 (01d §4): true while a session linked to the mission is busy; the placement's join/new then wait
   * (N8-453). Absent = not known (the rehome route still refuses an active session).
   */
  sessionBusy?: (sessions: string[]) => boolean
  /** 1.2.8 row 46: the placement success toast (N8-168); default the app toast. 1.2.8 row 46b: tidy done / stopped */
  toast?: (text: string, variant?: "success" | "error") => void
}) {
  const language = useLanguage()
  const t = language.t as Translate
  const [state, setState] = createStore(emptyCommandState())
  const command = createCommandController({
    writer: props.writer,
    refresh: () => props.refresh(),
    prompt: (text) => props.prompt(text),
    t,
    onState: (next) => setState(reconcile(next)),
    toast: (text, variant = "success") => (props.toast ? props.toast(text, variant) : showToast({ title: text, variant })),
  })

  const options = createMemo(() => (props.model.decision ? decisionOptions(props.model.decision, t) : []))
  const placement = () => !!props.model.decision && isPlacement(props.model.decision)
  // 1.2.8 row 46b (01d §5): the tidy list renders in the same card; approve waits like join/new.
  const tidy = () => !!props.model.decision && isTidy(props.model.decision)
  const lines = createMemo(() => (props.model.decision && tidy() ? tidyLines(props.model.decision, t) : []))
  const waitIdle = () => (placement() || tidy()) && !!props.sessionBusy?.(props.model.sessions ?? [])
  // 1.2.8 row 46b (C98): an answered placement whose move did not finish, shown when no request is open.
  const unplaced = () => (props.model.decision ? undefined : props.model.unplaced)
  const answerLocked = () => {
    state.busy
    state.answered.length
    const decision = props.model.decision
    return !decision || !command.canAnswer(props.model.id, decision.id)
  }
  const answerLockedFor = (request: string) => {
    state.busy
    state.answered.length
    return !command.canAnswer(props.model.id, request)
  }
  const waitIdleAny = () => !!props.sessionBusy?.(props.model.sessions ?? [])
  const feed = createMemo(() => {
    state.local.length
    state.localMission
    return command.feed(props.model)
  })
  const agent = () => (props.selected ? props.model.agents[props.selected] : undefined)
  const deliverable = () => {
    const id = agent()?.deliverableId
    return id ? props.model.deliverables.find((item) => item.documentId === id) : undefined
  }
  const canSend = () => {
    state.draft
    state.busy
    return command.canSend()
  }

  return (
    <div data-mission-command class="contents">
      {/* 1.2.7 row 58g (C101): only an open decision has a card. An answered one leaves the side panel; its answer
          is the feed entry "<id>: <option>" (mission-model.ts), so nothing lingers to push the feed out. */}
      <Show
        when={props.model.decision}
      >
        {(decision) => (
          <section
            data-mission-decision
            class="mb-0.5 flex max-h-full min-w-0 shrink-0 flex-col gap-1.5 overflow-y-auto rounded-[8px] p-2 [box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
          >
            {/* 1.2.7 U-5 (C6, D-11): the question and its context scroll in a bounded body; the options stay outside it. */}
            <div data-mission-decision-body class="flex max-h-[min(40vh,240px)] min-h-0 shrink flex-col gap-1.5 overflow-y-auto overscroll-contain">
              <div class="flex items-baseline justify-between gap-2">
                <h2 data-mission-question class="min-w-0 [overflow-wrap:anywhere] text-v2-text-text-base [font-weight:500]">
                  {placement() ? t("session.mission.placement.title") : tidy() ? t("session.mission.tidy.title") : decision().question}
                </h2>
                <span class="shrink-0 text-v2-text-text-faint">{decision().id}</span>
              </div>
              <Show when={decision().context}>
                {(context) => <p data-mission-context class="min-w-0 [overflow-wrap:anywhere] text-v2-text-text-muted">{context()}</p>}
              </Show>
              {/* 1.2.8 row 46b: the tidy description (N8-160) and one line per listed mission (N8-161 / N8-162). */}
              <Show when={tidy()}>
                <p data-mission-tidy-description class="text-v2-text-text-muted">{t("session.mission.tidy.description")}</p>
                <ul data-mission-tidy-list class="flex min-w-0 flex-col gap-0.5">
                  <For each={lines()}>
                    {(line) => (
                      <li data-mission-tidy-line data-stays={line.stays ? "" : undefined} class="flex min-w-0 flex-wrap items-center gap-1.5 [overflow-wrap:anywhere] text-v2-text-text-base">
                        {line.text}
                        <Show when={line.kind}>
                          {(kind) => (
                            <span data-mission-group-kind class="rounded-[4px] px-1 text-v2-text-text-muted [font-weight:440]">
                              {kind()}
                            </span>
                          )}
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
            <div data-mission-decision-actions class="flex min-w-0 shrink-0 flex-wrap gap-1.5">
              <For each={options()}>
                {(option) => (
                  <button
                    type="button"
                    data-mission-option={option.id}
                    data-recommended={option.tag ? "" : undefined}
                    data-mission-moves={option.moves ? "" : undefined}
                    disabled={answerLocked() || (option.moves === true && (waitIdle() || !props.writer.place))}
                    class="flex min-w-0 flex-[1_1_8rem] flex-col items-stretch gap-0.5 rounded-[6px] bg-v2-overlay-simple-overlay-hover px-2 py-1.5 text-left disabled:opacity-60"
                    onClick={() =>
                      void (option.moves
                        ? command.place(props.model.id, decision(), option.id)
                        : command.answer(props.model.id, decision(), option.id))
                    }
                  >
                    <span class="flex min-w-0 flex-wrap items-center gap-1.5 [overflow-wrap:anywhere] text-v2-text-text-base [font-weight:500]">
                      {option.label}
                      <Show when={option.kind}>
                        {(kind) => (
                          <span data-mission-group-kind class="rounded-[4px] px-1 text-v2-text-text-muted [font-weight:440]">
                            {kind()}
                          </span>
                        )}
                      </Show>
                      <Show when={option.tag}>
                        {(tag) => (
                          <span data-mission-recommended class="rounded-[4px] px-1 text-v2-state-fg-success [font-weight:440]">
                            {tag()}
                          </span>
                        )}
                      </Show>
                    </span>
                    <Show when={option.consequence}>
                      <span data-mission-consequence class="min-w-0 [overflow-wrap:anywhere] text-v2-text-text-muted">{option.consequence}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            {/* 1.2.8 row 46 (01d §4): the placement note (N8-155) and, while a linked session works, the wait hint (N8-453). */}
            <Show when={placement()}>
              <p data-mission-placement-note class="text-v2-text-text-muted">{t("session.mission.placement.note")}</p>
            </Show>
            <Show when={waitIdle()}>
              <p data-mission-placement-wait class="text-v2-text-text-faint">{t("session.mission.placement.waitIdle")}</p>
            </Show>
            <Show when={state.moving}>
              {(moving) => (
                <p data-mission-tidy-progress class="text-v2-text-text-muted">
                  {t("session.mission.tidy.progress", { done: moving().done, total: moving().total })}
                </p>
              )}
            </Show>
            <Show when={props.model.openDecisions > 1}>
              <div class="text-v2-text-text-faint">
                {t("session.mission.decision.more", { count: props.model.openDecisions - 1 })}
              </div>
            </Show>
            <Show when={state.decisionError}>
              {(error) => (
                <div role="alert" data-mission-decision-error class="text-v2-state-fg-danger">
                  {error()}
                </div>
              )}
            </Show>
          </section>
        )}
      </Show>

      {/* 1.2.8 row 46b (C98): the same decision card for an answered placement whose move did not finish. */}
      <Show when={unplaced()}>
        {(item) => (
          <section
            data-mission-decision
            data-mission-retry-card
            class="mb-0.5 flex max-h-full min-w-0 shrink-0 flex-col gap-1.5 overflow-y-auto rounded-[8px] p-2 [box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
          >
            <div class="flex items-baseline justify-between gap-2">
              <p data-mission-unplaced class="min-w-0 [overflow-wrap:anywhere] text-v2-text-text-base">
                {t("session.mission.move.error.failed", { reason: t(`session.mission.placement.${item().option}`, { group: item().group }) })}
              </p>
              <span class="shrink-0 text-v2-text-text-faint">{item().id}</span>
            </div>
            <div class="flex min-w-0 shrink-0 flex-wrap gap-1.5">
              <button
                type="button"
                data-mission-retry
                disabled={answerLockedFor(item().id) || waitIdleAny() || !props.writer.place}
                class="flex min-w-0 flex-[1_1_8rem] flex-col items-stretch gap-0.5 rounded-[6px] bg-v2-overlay-simple-overlay-hover px-2 py-1.5 text-left text-v2-text-text-base [font-weight:500] disabled:opacity-60"
                onClick={() => void command.retry(props.model.id, item())}
              >
                {t(`session.mission.placement.${item().option}`, { group: item().group })}
              </button>
            </div>
            <Show when={waitIdleAny()}>
              <p data-mission-placement-wait class="text-v2-text-text-faint">{t("session.mission.placement.waitIdle")}</p>
            </Show>
            <Show when={state.decisionError}>
              {(error) => (
                <div role="alert" data-mission-decision-error class="text-v2-state-fg-danger">
                  {error()}
                </div>
              )}
            </Show>
          </section>
        )}
      </Show>

      <section data-mission-command-card class="contents">
        <div class="flex items-baseline justify-between gap-2">
          <h2 data-mission-command-head class="text-v2-text-text-base [font-weight:500]">
            {commandHead(props.model, t)}
          </h2>
          <span class="text-v2-text-text-faint">{t("session.mission.command")}</span>
        </div>
        <ul
          data-mission-feed
          class="flex min-h-0 shrink flex-col gap-1 overflow-y-auto overscroll-contain"
          style={feedStyle(feed().length)}
        >
          <For each={feed()}>
            {(line) => (
              <li class="flex min-w-0 flex-col" data-local={line.local ? "" : undefined}>
                <span class="text-v2-text-text-faint">{feedWho(line, t)}</span>
                <span class="break-words text-v2-text-text-base">{line.text}</span>
                {/* 1.2.8 row 46 (SR8-05, N8-462): a by-user answer recorded from a session that was not attested. */}
                <Show when={line.unattested}>
                  <span data-mission-unattested class="text-v2-state-fg-warning">{t("session.mission.decision.unattested")}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={agent()}>
          {(item) => (
            <div data-mission-detail class="flex flex-col gap-0.5 rounded-[6px] bg-v2-overlay-simple-overlay-hover p-2">
              <b class="text-v2-text-text-base [font-weight:500]">{item().title}</b>
              <span class="text-v2-text-text-faint">
                {[
                  item().agent,
                  item().wave === null ? undefined : `W${item().wave}`,
                  t(`session.mission.agent.${item().status}`),
                  item().checkpoint ? `${item().checkpoint!.n}/${item().checkpoint!.m}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <Show when={deliverable()}>
                {(doc) => (
                  <span class="text-v2-text-text-faint">
                    {t("session.mission.detail.deliverable", {
                      name: doc().title,
                      formats: doc().formats.join(" + "),
                      status: t(`session.mission.deliverable.${doc().status}`),
                    })}
                  </span>
                )}
              </Show>
            </div>
          )}
        </Show>
        <div class="flex flex-wrap gap-1.5">
          <ButtonV2 type="button" variant="outline" data-mission-why onClick={() => command.why(props.model)}>
            {t("session.mission.chip.why")}
          </ButtonV2>
          <ButtonV2
            type="button"
            variant="outline"
            data-mission-unblock
            disabled={state.busy}
            onClick={() => void command.unblock(props.model.id)}
          >
            {t("session.mission.chip.unblock")}
          </ButtonV2>
        </div>
        <form
          class="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            void command.send(props.model.id)
          }}
        >
          <input
            data-mission-input
            type="text"
            autocomplete="off"
            value={state.draft}
            placeholder={t("session.mission.input.placeholder")}
            aria-label={t("session.mission.input.aria")}
            aria-invalid={state.inputError ? "true" : undefined}
            class="h-7 min-w-0 flex-1 text-ellipsis rounded-[6px] border-0 bg-v2-overlay-simple-overlay-hover px-2 text-v2-text-text-base outline-none [font-weight:440] placeholder:text-v2-text-text-faint focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
            onInput={(event) => command.setDraft(event.currentTarget.value)}
          />
          <ButtonV2 type="submit" variant="contrast" data-mission-send disabled={!canSend()}>
            {t("session.mission.input.send")}
          </ButtonV2>
        </form>
        <Show when={state.inputError}>
          {(error) => (
            <div role="alert" data-mission-input-error class="text-v2-state-fg-danger">
              {error()}
            </div>
          )}
        </Show>
      </section>
    </div>
  )
}
