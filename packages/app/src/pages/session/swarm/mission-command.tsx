// Decision card + command channel (row 131; masterplan/01_specs_mission_control_ui.md §6 items 20-31, V6:140-147, :362-384).
// All mission text is agent-written: rendered as text nodes only (§12). Logic lives in mission-command-model.ts.
import { useLanguage } from "@/context/language"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { createMemo, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  commandHead,
  createCommandController,
  decisionOptions,
  emptyCommandState,
  feedWho,
  type MissionWriter,
  type Translate,
} from "./mission-command-model"
import type { MissionVM } from "./mission-model"

export function MissionCommand(props: {
  model: MissionVM
  writer: MissionWriter
  /** row 129 controller `refresh` */
  refresh: () => void
  /** normal prompt to the open session's root (§2) */
  prompt: (text: string) => Promise<unknown>
  /** row id of the selected agent (row 130 selection), for the detail line */
  selected?: string
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
  })

  const options = createMemo(() => (props.model.decision ? decisionOptions(props.model.decision, t) : []))
  const answerLocked = () => {
    state.busy
    state.answered.length
    const decision = props.model.decision
    return !decision || !command.canAnswer(props.model.id, decision.id)
  }
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
    <div data-mission-command class="flex min-w-0 flex-col gap-2">
      <Show
        when={props.model.decision}
        fallback={
          <Show when={props.model.answered}>
            {(answered) => (
              <section data-mission-answered class="flex min-w-0 flex-col gap-1 rounded-[8px] bg-v2-overlay-simple-overlay-hover p-2">
                <div class="flex items-baseline justify-between gap-2">
                  <h2 class="min-w-0 [overflow-wrap:anywhere] text-v2-text-text-base [font-weight:500]">{answered().question}</h2>
                  <span class="shrink-0 text-v2-text-text-faint">{answered().id}</span>
                </div>
                <div class="text-v2-text-text-muted">
                  {t("session.mission.decision.answered", { option: answered().optionLabel })}
                </div>
                <div class="text-v2-text-text-faint">
                  {t("session.mission.decision.recorded", { decision: answered().decision })}
                </div>
              </section>
            )}
          </Show>
        }
      >
        {(decision) => (
          <section
            data-mission-decision
            class="flex min-w-0 flex-col gap-1.5 rounded-[8px] p-2 [box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
          >
            <div class="flex items-baseline justify-between gap-2">
              <h2 data-mission-question class="min-w-0 [overflow-wrap:anywhere] text-v2-text-text-base [font-weight:500]">{decision().question}</h2>
              <span class="shrink-0 text-v2-text-text-faint">{decision().id}</span>
            </div>
            <Show when={decision().context}>
              {(context) => <p data-mission-context class="min-w-0 [overflow-wrap:anywhere] text-v2-text-text-muted">{context()}</p>}
            </Show>
            <For each={options()}>
              {(option) => (
                <button
                  type="button"
                  data-mission-option={option.id}
                  data-recommended={option.tag ? "" : undefined}
                  disabled={answerLocked()}
                  class="flex w-full min-w-0 flex-col items-stretch gap-0.5 rounded-[6px] bg-v2-overlay-simple-overlay-hover px-2 py-1.5 text-left disabled:opacity-60"
                  onClick={() => void command.answer(props.model.id, decision(), option.id)}
                >
                  <span class="flex min-w-0 flex-wrap items-center gap-1.5 [overflow-wrap:anywhere] text-v2-text-text-base [font-weight:500]">
                    {option.label}
                    <Show when={option.tag}>
                      {(tag) => (
                        <span data-mission-recommended class="rounded-[4px] px-1 text-v2-state-fg-success [font-weight:440]">
                          {tag()}
                        </span>
                      )}
                    </Show>
                  </span>
                  <span data-mission-consequence class="min-w-0 [overflow-wrap:anywhere] text-v2-text-text-muted">{option.consequence}</span>
                </button>
              )}
            </For>
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

      <section data-mission-command-card class="flex flex-col gap-1.5">
        <div class="flex items-baseline justify-between gap-2">
          <h2 data-mission-command-head class="text-v2-text-text-base [font-weight:500]">
            {commandHead(props.model, t)}
          </h2>
          <span class="text-v2-text-text-faint">{t("session.mission.command")}</span>
        </div>
        <ul data-mission-feed class="flex flex-col gap-1">
          <For each={feed()}>
            {(line) => (
              <li class="flex min-w-0 flex-col" data-local={line.local ? "" : undefined}>
                <span class="text-v2-text-text-faint">{feedWho(line, t)}</span>
                <span class="break-words text-v2-text-text-base">{line.text}</span>
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
