import { useLanguage } from "@/context/language"
import { alwaysLabel } from "@/pages/session/composer/permission-always"
import { inlineQuestion, permissionDetail, permissionRisk } from "@/pages/home/agent-board-model"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { createMemo, For, Index, Match, Show, Switch } from "solid-js"
import { formatDuration, relativePath, type MapStep } from "../map/session-map-model"
import type { SwarmController } from "./swarm-controller"
import { coalesceSegments, type SwarmLane, type SwarmModel, type SwarmOverlap, type SwarmSegmentKind } from "./swarm-model"

const LABEL = "text-v2-text-text-muted [font-weight:440]"
const FAINT = "text-v2-text-text-faint [font-weight:440]"

const CELL: Record<SwarmSegmentKind, string> = {
  problem: "bg-v2-state-fg-danger",
  blocked: "bg-v2-state-fg-warning",
  edit: "bg-v2-text-text-base",
  command: "bg-v2-text-text-muted",
  agent: "bg-v2-border-border-base",
  explore: "bg-v2-border-border-strong",
  other: "bg-v2-border-border-strong",
}

function useUsd() {
  const language = useLanguage()
  const usd = createMemo(() => new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }))
  return (value: number) => usd().format(value)
}

function LaneGlyph(props: { lane: SwarmLane }) {
  return (
    <span class="flex size-4 shrink-0 items-center justify-center" data-swarm-status={props.lane.status}>
      <Switch>
        <Match when={props.lane.status === "needs"}>
          <span class="size-2 rounded-full bg-v2-state-fg-warning" />
        </Match>
        <Match when={props.lane.status === "running" || props.lane.status === "retry"}>
          <Spinner class="size-3.5 text-v2-text-text-muted" />
        </Match>
        <Match when={props.lane.status === "waiting"}>
          <span class="size-2.5 rounded-full border border-v2-text-text-muted" />
        </Match>
        <Match when={props.lane.status === "failed"}>
          <span class="text-v2-state-fg-danger">
            <IconV2 name="close" />
          </span>
        </Match>
        <Match when={props.lane.status === "stopped"}>
          <span class="size-2 bg-v2-text-text-faint" />
        </Match>
        <Match when={props.lane.status === "done"}>
          <Icon name="check-small" size="small" class="text-v2-state-fg-success" />
        </Match>
        <Match when={props.lane.status === "unread"}>
          <span class="size-1.5 rounded-full bg-v2-text-text-faint" />
        </Match>
      </Switch>
    </span>
  )
}

function useLaneLine(swarm: SwarmController) {
  const language = useLanguage()
  return (lane: SwarmLane) => {
    if (swarm.view.failed[lane.id]) return language.t("session.swarm.lane.unreadable")
    if (lane.status === "needs") {
      if (lane.permission)
        return language.t("session.swarm.lane.needs", {
          detail: permissionDetail(lane.permission).split("\n")[0] ?? "",
        })
      return lane.question?.questions[0]?.question ?? language.t("notification.question.title")
    }
    if (lane.status === "waiting") return language.t("session.swarm.lane.waiting", { count: lane.waitingOn })
    if (lane.status === "retry") return language.t("session.swarm.lane.retry", { detail: lane.detail ?? "" })
    if (lane.status === "running") {
      const step = lane.current
      if (!step) return language.t("ui.sessionTurn.status.thinking")
      return `${step.tool ?? step.kind}: ${relativePath(step.label, lane.session.directory)}`
    }
    if (lane.status === "failed") return language.t("session.swarm.lane.failed", { detail: lane.detail ?? "" })
    if (lane.status === "stopped") return language.t("session.swarm.lane.stopped")
    if (lane.status === "unread") return language.t("session.swarm.lane.reading")
    return language.t("session.swarm.lane.done", { count: lane.model.steps.length })
  }
}

/** Every agent on one clock, in a line thin enough to read past: when it worked, and where something went wrong. */
function ClockStrip(props: { lane: SwarmLane; model: SwarmModel }) {
  const x = () => props.model.axis.x
  const cells = createMemo(() => coalesceSegments(props.lane.segments, x()))
  return (
    <span aria-hidden="true" data-swarm-strip class="relative mt-1 block h-[3px] w-full overflow-hidden rounded-full">
      <span
        class="absolute inset-y-0 bg-v2-border-border-base"
        style={{
          left: `${x()(props.lane.start) * 100}%`,
          width: `${Math.max(0, x()(props.lane.end) - x()(props.lane.start)) * 100}%`,
        }}
      />
      <Index each={cells()}>
        {(cell) => (
          <span
            data-swarm-cell={cell().kind}
            class={`absolute inset-y-0 ${CELL[cell().kind]}`}
            style={{ left: `${cell().left * 100}%`, width: `max(2px, ${(cell().right - cell().left) * 100}%)` }}
          />
        )}
      </Index>
    </span>
  )
}

function StepRow(props: { swarm: SwarmController; lane: SwarmLane; step: MapStep }) {
  return (
    <button
      type="button"
      data-swarm-step={props.step.id}
      class="flex w-full min-w-0 cursor-default flex-col rounded-[6px] border-0 bg-transparent px-1.5 py-0.5 text-left outline-none transition-colors duration-[120ms] hover:bg-v2-overlay-simple-overlay-hover focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
      onClick={() => props.swarm.open(props.lane, props.step)}
    >
      <span class="flex w-full min-w-0 items-baseline gap-1.5">
        <span class={`shrink-0 ${FAINT}`}>{props.step.tool ?? props.step.kind}</span>
        <span
          class="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-base"
          classList={{ "!text-v2-state-fg-danger": !!props.step.problem }}
        >
          {relativePath(props.step.label, props.lane.session.directory)}
        </span>
      </span>
      <Show when={props.step.problem}>
        <span class={`truncate ${LABEL}`}>{props.step.detail ?? props.step.problem}</span>
      </Show>
    </button>
  )
}

function LaneDetail(props: { swarm: SwarmController; lane: SwarmLane }) {
  const language = useLanguage()
  const busy = () => !!props.swarm.view.pending[props.lane.id]
  const question = createMemo(() => (props.lane.question ? inlineQuestion(props.lane.question) : undefined))
  const problems = createMemo(() => props.lane.model.problems.slice(-3).toReversed())
  const latest = createMemo(() =>
    props.lane.model.steps
      .filter((step) => !step.problem)
      .slice(-3)
      .toReversed(),
  )
  const told = () => (props.lane.depth === 0 ? props.lane.model.chapters.at(-1)?.prompt : props.lane.told)
  return (
    <section
      data-swarm-detail={props.lane.id}
      aria-label={props.lane.title}
      class="flex min-w-0 flex-col gap-2 pb-2 pl-7 pr-2 pt-1"
    >
      <Show when={props.lane.permission} keyed>
        {(request) => (
          <div data-swarm-need="permission" class="rounded-[6px] border border-v2-state-border-warning p-2">
            <Show when={permissionRisk(request)} keyed>
              {(risk) => <div class="pb-1 text-v2-state-fg-warning [font-weight:440]">{language.t(risk)}</div>}
            </Show>
            <pre class="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-[18px] text-v2-text-text-base select-text">
              {permissionDetail(request)}
            </pre>
            <div class="mt-2 flex flex-wrap justify-end gap-1.5">
              <Show when={request.always.length > 0}>
                <ButtonV2
                  type="button"
                  variant="ghost-muted"
                  disabled={busy()}
                  onClick={() => props.swarm.allow(props.lane, request, "always")}
                >
                  {alwaysLabel(request, language.t)}
                </ButtonV2>
              </Show>
              <ButtonV2
                type="button"
                variant="outline"
                disabled={busy()}
                onClick={() => props.swarm.allow(props.lane, request, "reject")}
              >
                {language.t("ui.permission.deny")}
              </ButtonV2>
              <ButtonV2
                type="button"
                variant="contrast"
                disabled={busy()}
                onClick={() => props.swarm.allow(props.lane, request, "once")}
              >
                {language.t("ui.permission.allowOnce")}
              </ButtonV2>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.lane.question} keyed>
        {(request) => (
          <div data-swarm-need="question" class="rounded-[6px] border border-v2-state-border-warning p-2">
            <div class="whitespace-pre-wrap text-v2-text-text-base [font-weight:440] select-text">
              {request.questions[0]?.question}
            </div>
            <div class="mt-2 flex flex-wrap justify-end gap-1.5">
              <Show
                when={question()}
                fallback={
                  <ButtonV2 type="button" variant="contrast" onClick={() => props.swarm.open(props.lane)}>
                    {language.t("common.open")}
                  </ButtonV2>
                }
              >
                {(inline) => (
                  <For each={inline().options.slice(0, 9)}>
                    {(option) => (
                      <ButtonV2
                        type="button"
                        variant="outline"
                        disabled={busy()}
                        onClick={() => props.swarm.answer(props.lane, request, option.label)}
                      >
                        {option.label}
                      </ButtonV2>
                    )}
                  </For>
                )}
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.swarm.canTell(props.lane)}>
        <form
          class="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            props.swarm.tell(props.lane)
          }}
        >
          <input
            data-swarm-tell
            type="text"
            value={props.swarm.view.draft[props.lane.id] ?? ""}
            placeholder={language.t("session.swarm.tell.placeholder")}
            aria-label={language.t("session.swarm.tell.placeholder")}
            class="h-7 min-w-0 flex-1 text-ellipsis rounded-[6px] border-0 bg-v2-overlay-simple-overlay-hover px-2 text-v2-text-text-base outline-none [font-weight:440] placeholder:text-v2-text-text-faint focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
            onInput={(event) => props.swarm.setDraft(props.lane.id, event.currentTarget.value)}
          />
          <ButtonV2
            type="submit"
            variant="contrast"
            disabled={busy() || !props.swarm.view.draft[props.lane.id]?.trim()}
          >
            {language.t("session.swarm.tell.send")}
          </ButtonV2>
        </form>
        <Show when={props.swarm.view.sent === props.lane.id}>
          <div data-swarm-sent class="text-v2-state-fg-success [font-weight:440]">
            {language.t("session.swarm.tell.sent")}
          </div>
        </Show>
      </Show>

      <div class="flex items-center justify-end gap-1.5">
        <Show when={props.swarm.canTell(props.lane)}>
          <ButtonV2
            type="button"
            variant="ghost-muted"
            disabled={busy()}
            onClick={() => props.swarm.stop(props.lane)}
          >
            {language.t("session.swarm.stop")}
          </ButtonV2>
        </Show>
        <ButtonV2 type="button" variant="ghost" onClick={() => props.swarm.open(props.lane)}>
          {language.t("session.swarm.open")}
        </ButtonV2>
      </div>

      <Show when={told()}>
        <div class="min-w-0">
          <div class={FAINT}>{language.t("session.swarm.told")}</div>
          <div class="line-clamp-2 whitespace-pre-wrap text-v2-text-text-base [font-weight:440] select-text">
            {told()}
          </div>
        </div>
      </Show>
      <Show when={props.lane.status === "failed" && props.lane.detail}>
        <div class="whitespace-pre-wrap text-v2-state-fg-danger [font-weight:440] select-text">{props.lane.detail}</div>
      </Show>
      <Show when={!props.swarm.canTell(props.lane) && props.lane.outcome}>
        <div class="min-w-0">
          <div class={FAINT}>{language.t("session.swarm.result")}</div>
          <div class="line-clamp-3 whitespace-pre-wrap text-v2-text-text-base [font-weight:440] select-text">
            {props.lane.outcome}
          </div>
        </div>
      </Show>

      <Show when={problems().length > 0}>
        <div class="-mx-1.5 min-w-0">
          <div class={`px-1.5 ${FAINT}`}>{language.t("session.swarm.steps.problems")}</div>
          <Index each={problems()}>{(step) => <StepRow swarm={props.swarm} lane={props.lane} step={step()} />}</Index>
        </div>
      </Show>
      <Show when={latest().length > 0}>
        <div class="-mx-1.5 min-w-0">
          <div class={`px-1.5 ${FAINT}`}>{language.t("session.swarm.steps.latest")}</div>
          <Index each={latest()}>{(step) => <StepRow swarm={props.swarm} lane={props.lane} step={step()} />}</Index>
        </div>
      </Show>

    </section>
  )
}

function OverlapRow(props: { swarm: SwarmController; overlap: SwarmOverlap; model: SwarmModel }) {
  const language = useLanguage()
  const who = () =>
    [
      ...new Set(
        props.overlap.writes.map((write) => props.model.lanes.find((lane) => lane.id === write.laneID)?.title),
      ),
    ]
      .filter(Boolean)
      .join(", ")
  return (
    <div
      data-swarm-overlap={props.overlap.path}
      data-swarm-overlap-blind={props.overlap.blind ? "true" : undefined}
      class="mx-1.5 min-w-0 rounded-[6px] bg-v2-state-bg-warning py-1 pl-2 pr-1"
      title={who()}
    >
      <div class="flex min-w-0 items-center gap-2">
        <div class="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-base">{props.overlap.path}</div>
        <ButtonV2
          type="button"
          variant="ghost"
          size="small"
          class="shrink-0"
          onClick={() => props.swarm.check(props.overlap, props.overlap.writes.at(-1)!)}
        >
          {language.t("session.swarm.overlap.check")}
        </ButtonV2>
      </div>
      <div class={`pr-1 ${LABEL}`}>
        {props.overlap.blind ? language.t("session.swarm.overlap.blind") : language.t("session.swarm.overlap.title")}
      </div>
    </div>
  )
}

export function SwarmAgents(props: { swarm: SwarmController }) {
  const language = useLanguage()
  const usd = useUsd()
  const line = useLaneLine(props.swarm)
  const lanes = () => props.swarm.model()?.lanes ?? []
  const totals = () => props.swarm.model()?.totals
  // Rows are keyed by id: the model is rebuilt every second and rebuilding rows would drop keyboard focus.
  const ids = createMemo(() =>
    lanes()
      .map((lane) => lane.id)
      .join("\n"),
  )
  const laneIDs = createMemo(() => ids().split("\n").filter(Boolean))
  const laneByID = createMemo(() => new Map(lanes().map((lane) => [lane.id, lane])))
  const failedReads = createMemo(() => lanes().filter((lane) => props.swarm.view.failed[lane.id]).length)
  const openID = () => (props.swarm.view.folded ? undefined : props.swarm.selectedLane()?.id)
  let list: HTMLDivElement | undefined

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const target = event.target as HTMLElement
    if (target.tagName === "INPUT" || event.metaKey || event.ctrlKey || event.altKey) return
    const rows = [...(list?.querySelectorAll<HTMLElement>("[data-swarm-lane]") ?? [])]
    const at = rows.indexOf(target)
    if (at < 0) return
    event.preventDefault()
    event.stopPropagation()
    rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus()
  }

  return (
    <div
      data-component="session-swarm"
      class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2"
      data-scrollable
      onKeyDown={onKey}
    >
      <Show when={props.swarm.view.discoverFailed || failedReads() > 0}>
        <div
          data-swarm-error
          class="mx-2 flex shrink-0 items-center gap-2 rounded-[6px] bg-v2-state-bg-danger px-2 py-1 text-v2-state-fg-danger [font-weight:440]"
        >
          <span class="min-w-0 flex-1">{language.t("session.swarm.error")}</span>
          <ButtonV2 variant="ghost" onClick={() => props.swarm.retry()}>
            {language.t("home.agents.retry")}
          </ButtonV2>
        </div>
      </Show>

      <Show
        when={props.swarm.model()}
        fallback={
          <div class={`flex items-center gap-2 px-3 py-2 ${FAINT}`}>
            <Spinner class="size-3.5" />
            {language.t("session.swarm.lane.reading")}
          </div>
        }
      >
        {(model) => (
          <>
            <div data-swarm-summary class={`flex shrink-0 items-baseline gap-x-3 px-3 ${LABEL}`}>
              <Show when={totals()?.active}>
                {(count) => (
                  <span data-swarm-stat="working">
                    {count()} {language.t("session.swarm.stat.working")}
                  </span>
                )}
              </Show>
              <Show when={totals()?.needs}>
                {(count) => (
                  <span data-swarm-stat="needs" class="text-v2-state-fg-warning">
                    {count()} {language.t("session.swarm.stat.needs")}
                  </span>
                )}
              </Show>
              <Show when={(totals()?.cost ?? 0) > 0}>
                <span data-swarm-stat="cost" class="ml-auto tabular-nums">
                  {usd(totals()?.cost ?? 0)}
                </span>
              </Show>
            </div>

            <Index each={model().overlaps}>
              {(overlap) => <OverlapRow swarm={props.swarm} overlap={overlap()} model={model()} />}
            </Index>

            <div
              ref={(el) => {
                list = el
              }}
              data-swarm-list
              class="flex shrink-0 flex-col px-1.5"
            >
              <For each={laneIDs()}>
                {(id) => (
                  <Show when={laneByID().get(id)}>
                    {(lane) => (
                      <div>
                        <button
                          type="button"
                          data-swarm-lane={id}
                          data-swarm-lane-status={lane().status}
                          aria-expanded={openID() === id}
                          class="flex w-full min-w-0 cursor-default items-start gap-1.5 rounded-[6px] border-0 bg-transparent px-1.5 py-1.5 text-left outline-none transition-colors duration-[120ms] hover:bg-v2-overlay-simple-overlay-hover focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
                          classList={{ "bg-v2-overlay-simple-overlay-hover": openID() === id }}
                          style={{ "padding-left": `${6 + lane().depth * 10}px` }}
                          onClick={() => props.swarm.toggle(id)}
                        >
                          <LaneGlyph lane={lane()} />
                          <span class="min-w-0 flex-1">
                            <span class="flex min-w-0 items-baseline gap-1.5">
                              <span class="min-w-0 flex-1 truncate text-v2-text-text-base [font-weight:530]">
                                {lane().title}
                              </span>
                              <Show when={lane().cost > 0}>
                                <span class={`shrink-0 tabular-nums ${FAINT}`}>{usd(lane().cost)}</span>
                              </Show>
                            </span>
                            <span class="flex min-w-0 items-baseline gap-1.5">
                              <span
                                class={`min-w-0 flex-1 truncate ${LABEL}`}
                                classList={{
                                  "!text-v2-state-fg-warning": lane().status === "needs",
                                  "!text-v2-state-fg-danger":
                                    lane().status === "failed" || !!props.swarm.view.failed[id],
                                }}
                              >
                                {line(lane())}
                              </span>
                              <Show when={lane().workMs >= 1000 && lane().status !== "needs"}>
                                <span class={`shrink-0 tabular-nums ${FAINT}`}>{formatDuration(lane().workMs)}</span>
                              </Show>
                            </span>
                            <ClockStrip lane={lane()} model={model()} />
                          </span>
                        </button>
                        <Show when={openID() === id}>
                          <LaneDetail swarm={props.swarm} lane={lane()} />
                        </Show>
                      </div>
                    )}
                  </Show>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
