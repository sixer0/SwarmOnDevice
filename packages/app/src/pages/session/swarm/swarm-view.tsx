import { useLanguage } from "@/context/language"
import { inlineQuestion, permissionDetail } from "@/pages/home/agent-board-model"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { createEffect, createMemo, For, Index, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { formatDuration, relativePath, type MapStep } from "../map/session-map-model"
import type { SwarmController } from "./swarm-controller"
import {
  coalesceSegments,
  type SwarmLane,
  type SwarmModel,
  type SwarmOverlap,
  type SwarmSegmentKind,
} from "./swarm-model"

const LABEL = "text-v2-text-text-muted [font-weight:440]"
const FAINT = "text-v2-text-text-faint [font-weight:440]"

const CELL: Record<SwarmSegmentKind, { fill: string; height: string }> = {
  problem: { fill: "bg-v2-state-fg-danger", height: "100%" },
  blocked: {
    fill: "bg-v2-state-bg-warning [box-shadow:inset_0_0_0_1px_var(--v2-state-border-warning)]",
    height: "100%",
  },
  edit: { fill: "bg-v2-text-text-base", height: "100%" },
  command: { fill: "bg-v2-text-text-muted", height: "68%" },
  agent: {
    fill: "bg-[repeating-linear-gradient(135deg,var(--v2-border-border-strong)_0_2px,transparent_2px_5px)]",
    height: "100%",
  },
  explore: { fill: "bg-v2-border-border-strong", height: "40%" },
  other: { fill: "bg-v2-border-border-strong", height: "55%" },
}

function useFormats() {
  const language = useLanguage()
  const usd = createMemo(() => new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }))
  const compact = createMemo(
    () => new Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }),
  )
  return { usd: (value: number) => usd().format(value), tokens: (value: number) => compact().format(value) }
}

function LaneGlyph(props: { lane: SwarmLane }) {
  return (
    <span class="flex size-4 shrink-0 items-center justify-center" data-swarm-status={props.lane.status}>
      <Switch>
        <Match when={props.lane.status === "needs"}>
          <span class="size-2 rounded-full bg-v2-state-fg-warning animate-pulse motion-reduce:animate-none" />
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

function Track(props: { swarm: SwarmController; lane: SwarmLane; model: SwarmModel; spawnRows: number | undefined }) {
  const language = useLanguage()
  const x = () => props.model.axis.x
  const cells = createMemo(() => coalesceSegments(props.lane.segments, x()))
  const path = () => props.swarm.view.path
  return (
    <div data-swarm-track class="relative h-full min-w-0">
      <Index each={props.model.axis.ticks}>
        {(tick) => (
          <span
            aria-hidden="true"
            class="absolute inset-y-0 w-px bg-v2-border-border-base opacity-50"
            style={{ left: `${tick().x * 100}%` }}
          />
        )}
      </Index>
      <Index each={props.model.axis.breaks}>
        {(item) => (
          <span
            aria-hidden="true"
            class="absolute inset-y-0 w-[3%] bg-v2-overlay-simple-overlay-hover"
            style={{ left: `${item().x * 100}%` }}
          />
        )}
      </Index>
      <Show when={props.spawnRows && props.lane.spawnAt !== undefined}>
        <span
          aria-hidden="true"
          data-swarm-spawn
          class="absolute w-px bg-v2-border-border-strong"
          style={{
            left: `${x()(props.lane.spawnAt!) * 100}%`,
            bottom: "50%",
            height: `calc(var(--swarm-row) * ${props.spawnRows})`,
          }}
        />
      </Show>
      <span
        aria-hidden="true"
        class="absolute top-1/2 h-px bg-v2-border-border-strong"
        style={{
          left: `${x()(props.lane.start) * 100}%`,
          width: `${Math.max(0, x()(props.lane.end) - x()(props.lane.start)) * 100}%`,
        }}
      />
      <div class="absolute inset-x-0 inset-y-[8px]">
        <Index each={cells()}>
          {(cellAccessor) => {
            const cell = cellAccessor
            return (
              <button
                type="button"
                tabindex={-1}
                aria-hidden="true"
                data-swarm-cell={cell().kind}
                title={[
                  cell().label,
                  cell().count > 1 ? language.t("session.swarm.cell.more", { count: cell().count }) : undefined,
                  formatDuration(cell().end - cell().start),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                class={`absolute bottom-0 cursor-default border-0 p-0 transition-opacity duration-[120ms] hover:opacity-70 ${CELL[cell().kind].fill}`}
                classList={{
                  "animate-pulse motion-reduce:animate-none": cell().running && cell().kind !== "agent",
                  "opacity-25": !!path() && !cell().paths.includes(path()!),
                  "[box-shadow:0_0_0_2px_var(--v2-state-fg-warning)]": !!path() && cell().paths.includes(path()!),
                }}
                style={{
                  left: `${cell().left * 100}%`,
                  width: `max(2px, ${(cell().right - cell().left) * 100}%)`,
                  height: CELL[cell().kind].height,
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  props.swarm.pickStep(props.lane, cell().step.id)
                }}
              />
            )
          }}
        </Index>
      </div>
      <Show when={props.lane.status === "needs"}>
        <span
          aria-hidden="true"
          class="absolute inset-y-[6px] w-[3px] rounded-[1px] bg-v2-state-fg-warning"
          style={{ left: `calc(${x()(props.lane.end) * 100}% - 3px)` }}
        />
      </Show>
    </div>
  )
}

function LaneRow(props: {
  swarm: SwarmController
  lane: SwarmLane
  model: SwarmModel
  spawnRows: number | undefined
  maxCost: number
}) {
  const formats = useFormats()
  const line = useLaneLine(props.swarm)
  const selected = () => props.swarm.selectedLane()?.id === props.lane.id
  const costShare = () => (props.maxCost > 0 ? props.lane.cost / props.maxCost : 0)
  return (
    <div
      data-swarm-lane={props.lane.id}
      data-swarm-lane-status={props.lane.status}
      role="option"
      aria-selected={selected()}
      tabIndex={selected() ? 0 : -1}
      class="grid h-[var(--swarm-row)] cursor-default grid-cols-[minmax(0,1fr)_64px] grid-rows-[auto_minmax(0,1fr)] items-center gap-x-2 border-b border-v2-border-border-base px-2 outline-none transition-colors duration-[120ms] hover:bg-v2-overlay-simple-overlay-hover focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)] @[760px]:grid-cols-[minmax(200px,27%)_minmax(0,1fr)_64px] @[760px]:grid-rows-1"
      classList={{ "bg-v2-overlay-simple-overlay-hover": selected() }}
      onClick={() => props.swarm.select(props.lane.id)}
      onDblClick={() => props.swarm.open(props.lane)}
    >
      <div class="flex min-w-0 items-center gap-1.5" style={{ "padding-left": `${props.lane.depth * 14}px` }}>
        <LaneGlyph lane={props.lane} />
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-baseline gap-1.5">
            <span class="truncate text-v2-text-text-base [font-weight:530]">{props.lane.title}</span>
            <Show when={props.lane.depth > 0 && props.lane.agent}>
              <span class={`shrink-0 ${FAINT}`}>{props.lane.agent}</span>
            </Show>
          </div>
          <div class="flex min-w-0 items-baseline gap-1.5">
            <span
              class={`truncate ${LABEL}`}
              classList={{
                "!text-v2-state-fg-warning": props.lane.status === "needs",
                "!text-v2-state-fg-danger": props.lane.status === "failed" || !!props.swarm.view.failed[props.lane.id],
              }}
            >
              {line(props.lane)}
            </span>
            <Show when={props.lane.model.counts.problems > 0}>
              <span class="shrink-0 tabular-nums text-v2-state-fg-danger [font-weight:440]">
                {props.lane.model.counts.problems}
              </span>
            </Show>
          </div>
        </div>
      </div>
      <div class="col-span-2 row-start-2 h-full min-w-0 @[760px]:col-span-1 @[760px]:col-start-2 @[760px]:row-start-1">
        <Track swarm={props.swarm} lane={props.lane} model={props.model} spawnRows={props.spawnRows} />
      </div>
      <div
        class="col-start-2 row-start-1 min-w-0 text-right @[760px]:col-start-3"
        title={formats.tokens(props.lane.tokens)}
      >
        <div class="tabular-nums text-v2-text-text-base [font-weight:440]">{formats.usd(props.lane.cost)}</div>
        <div class="ml-auto mt-0.5 h-[3px] w-full overflow-hidden rounded-full bg-v2-overlay-simple-overlay-hover">
          <div class="ml-auto h-full bg-v2-text-text-muted" style={{ width: `${costShare() * 100}%` }} />
        </div>
      </div>
    </div>
  )
}

function Axis(props: { model: SwarmModel }) {
  const language = useLanguage()
  const clock = createMemo(
    () =>
      new Intl.DateTimeFormat(language.intl(), {
        hour: "numeric",
        minute: "2-digit",
        ...(props.model.axis.seconds ? { second: "2-digit" } : {}),
      }),
  )
  return (
    <div
      data-swarm-axis
      aria-hidden="true"
      class="grid h-6 shrink-0 grid-cols-[minmax(0,1fr)] items-end border-b border-v2-border-border-base px-2 @[760px]:grid-cols-[minmax(200px,27%)_minmax(0,1fr)_64px] gap-x-2"
    >
      <span class="hidden @[760px]:block" />
      <div class="relative h-full min-w-0 overflow-hidden">
        <Index each={props.model.axis.ticks}>
          {(tick, index) => (
            <span
              class={`absolute bottom-1 whitespace-nowrap text-[11px] leading-none tabular-nums ${FAINT}`}
              // On a narrow panel only every third label fits; the last ones hang left so they are not cut.
              classList={{ "hidden @[760px]:inline": index % 3 !== 0, "-translate-x-full": tick().x > 0.88 }}
              style={{ left: `${tick().x * 100}%` }}
            >
              {clock().format(tick().at)}
            </span>
          )}
        </Index>
        <Index each={props.model.axis.breaks}>
          {(item) => (
            <span
              class={`absolute bottom-1 whitespace-nowrap text-[11px] leading-none ${FAINT}`}
              style={{ left: `${item().x * 100}%` }}
            >
              {language.t("session.swarm.gap", { duration: formatDuration(item().ms) })}
            </span>
          )}
        </Index>
      </div>
      <span class="hidden @[760px]:block" />
    </div>
  )
}

function StepRow(props: { swarm: SwarmController; lane: SwarmLane; step: MapStep; picked: boolean }) {
  return (
    <button
      type="button"
      data-swarm-step={props.step.id}
      class="flex w-full min-w-0 cursor-default flex-col rounded-[6px] border-0 bg-transparent px-1.5 py-1 text-left outline-none transition-colors duration-[120ms] hover:bg-v2-overlay-simple-overlay-hover focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
      classList={{ "bg-v2-overlay-simple-overlay-hover": props.picked }}
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
        <Show when={props.step.end !== undefined}>
          <span class={`shrink-0 tabular-nums ${FAINT}`}>{formatDuration(props.step.end! - props.step.start)}</span>
        </Show>
      </span>
      <Show when={props.step.problem}>
        <span class={`truncate ${LABEL}`}>{props.step.detail ?? props.step.problem}</span>
      </Show>
    </button>
  )
}

function KeyedButton(props: {
  label: string
  keys: string[]
  variant: "ghost-muted" | "outline" | "contrast" | "neutral"
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <ButtonV2 type="button" variant={props.variant} disabled={props.disabled} onClick={props.onClick}>
      {props.label}
      <KeybindV2
        keys={props.keys}
        variant="ghost"
        class="ml-1.5 max-md:hidden [&_[data-slot=keybind-v2-label]]:text-current [&_[data-slot=keybind-v2-label]]:opacity-70"
      />
    </ButtonV2>
  )
}

function Inspector(props: { swarm: SwarmController; lane: SwarmLane; focusRow: () => void }) {
  const language = useLanguage()
  const formats = useFormats()
  const busy = () => !!props.swarm.view.pending[props.lane.id]
  const question = createMemo(() => (props.lane.question ? inlineQuestion(props.lane.question) : undefined))
  const problems = createMemo(() => props.lane.model.problems.slice(-5).toReversed())
  const latest = createMemo(() =>
    props.lane.model.steps
      .filter((step) => !step.problem)
      .slice(-6)
      .toReversed(),
  )
  const picked = createMemo(() => {
    const id = props.swarm.view.step
    return id ? props.lane.model.steps.find((step) => step.id === id) : undefined
  })
  const later = createMemo((): string[] =>
    props.lane.depth === 0
      ? []
      : props.lane.model.chapters
          .slice(1)
          .map((chapter) => chapter.prompt)
          .filter(Boolean),
  )
  const told = () => (props.lane.depth === 0 ? props.lane.model.chapters.at(-1)?.prompt : props.lane.told)
  const duration = () => (props.lane.workMs >= 1000 ? formatDuration(props.lane.workMs) : undefined)
  return (
    <section
      data-swarm-inspector={props.lane.id}
      aria-label={props.lane.title}
      class="flex min-w-0 flex-1 flex-col gap-2 px-3 py-2"
    >
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <LaneGlyph lane={props.lane} />
        <span class="min-w-0 truncate text-v2-text-text-base [font-weight:530]">{props.lane.title}</span>
        <span class={`shrink-0 tabular-nums ${FAINT}`}>
          {[
            props.lane.agent,
            formats.usd(props.lane.cost),
            language.t("session.swarm.tokens", { count: formats.tokens(props.lane.tokens) }),
            duration(),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <Show when={props.swarm.canTell(props.lane)}>
            <KeyedButton
              label={language.t("session.swarm.stop")}
              keys={["X"]}
              variant="ghost-muted"
              disabled={busy()}
              onClick={() => props.swarm.stop(props.lane)}
            />
          </Show>
          <KeyedButton
            label={language.t("session.swarm.open")}
            keys={["↵"]}
            variant="outline"
            onClick={() => props.swarm.open(props.lane)}
          />
        </div>
      </div>

      <Show when={props.lane.permission} keyed>
        {(request) => (
          <div data-swarm-need="permission" class="rounded-[6px] border border-v2-state-border-warning p-2">
            <pre class="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-[18px] text-v2-text-text-base select-text">
              {permissionDetail(request)}
            </pre>
            <div class="mt-2 flex flex-wrap justify-end gap-1.5">
              <KeyedButton
                label={language.t("ui.permission.deny")}
                keys={["D"]}
                variant="ghost-muted"
                disabled={busy()}
                onClick={() => props.swarm.allow(props.lane, request, "reject")}
              />
              <KeyedButton
                label={language.t("ui.permission.allowAlways")}
                keys={["⇧", "A"]}
                variant="outline"
                disabled={busy()}
                onClick={() => props.swarm.allow(props.lane, request, "always")}
              />
              <KeyedButton
                label={language.t("ui.permission.allowOnce")}
                keys={["A"]}
                variant="contrast"
                disabled={busy()}
                onClick={() => props.swarm.allow(props.lane, request, "once")}
              />
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
                  <KeyedButton
                    label={language.t("common.open")}
                    keys={["↵"]}
                    variant="contrast"
                    onClick={() => props.swarm.open(props.lane)}
                  />
                }
              >
                {(inline) => (
                  <For each={inline().options.slice(0, 9)}>
                    {(option, index) => (
                      <KeyedButton
                        label={option.label}
                        keys={[String(index() + 1)]}
                        variant="outline"
                        disabled={busy()}
                        onClick={() => props.swarm.answer(props.lane, request, option.label)}
                      />
                    )}
                  </For>
                )}
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show
        when={props.swarm.canTell(props.lane)}
        fallback={
          <Show when={props.lane.depth > 0}>
            <div class={FAINT}>{language.t("session.swarm.tell.finished")}</div>
          </Show>
        }
      >
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
            class="h-7 min-w-0 flex-1 rounded-[6px] border-0 bg-v2-overlay-simple-overlay-hover px-2 text-v2-text-text-base outline-none [font-weight:440] placeholder:text-v2-text-text-faint focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
            onInput={(event) => props.swarm.setDraft(props.lane.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              event.preventDefault()
              event.stopPropagation()
              props.focusRow()
            }}
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

      <Show when={told()}>
        <div class="min-w-0">
          <div class={FAINT}>{language.t("session.swarm.told")}</div>
          <div class="line-clamp-3 whitespace-pre-wrap text-v2-text-text-base [font-weight:440] select-text">
            {told()}
          </div>
        </div>
      </Show>
      <For each={later()}>
        {(text) => (
          <div class="min-w-0" data-swarm-later>
            <div class={FAINT}>{language.t("session.swarm.told.later")}</div>
            <div class="line-clamp-2 whitespace-pre-wrap text-v2-text-text-base [font-weight:440] select-text">
              {text}
            </div>
          </div>
        )}
      </For>
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

      <Show when={picked()}>
        {(step) => (
          <div class="min-w-0" data-swarm-picked>
            <StepRow swarm={props.swarm} lane={props.lane} step={step()} picked />
          </div>
        )}
      </Show>
      <Show when={problems().length > 0}>
        <div class="min-w-0">
          <div class={`px-1.5 ${FAINT}`}>{language.t("session.swarm.steps.problems")}</div>
          <Index each={problems()}>
            {(step) => <StepRow swarm={props.swarm} lane={props.lane} step={step()} picked={false} />}
          </Index>
        </div>
      </Show>
      <Show when={latest().length > 0}>
        <div class="min-w-0">
          <div class={`px-1.5 ${FAINT}`}>{language.t("session.swarm.steps.latest")}</div>
          <Index each={latest()}>
            {(step) => <StepRow swarm={props.swarm} lane={props.lane} step={step()} picked={false} />}
          </Index>
        </div>
      </Show>
    </section>
  )
}

function OverlapRow(props: { swarm: SwarmController; overlap: SwarmOverlap; model: SwarmModel }) {
  const language = useLanguage()
  const clock = createMemo(
    () => new Intl.DateTimeFormat(language.intl(), { hour: "numeric", minute: "2-digit", second: "2-digit" }),
  )
  const laneOf = (id: string) => props.model.lanes.find((lane) => lane.id === id)
  const lastWrite = () => props.overlap.writes.at(-1)!
  return (
    <div
      data-swarm-overlap={props.overlap.path}
      data-swarm-overlap-blind={props.overlap.blind ? "true" : undefined}
      class="min-w-0 rounded-[6px] px-1.5 py-1 hover:bg-v2-overlay-simple-overlay-hover"
      onMouseEnter={() => props.swarm.highlight(props.overlap.path)}
      onMouseLeave={() => props.swarm.highlight(undefined)}
      onFocusIn={() => props.swarm.highlight(props.overlap.path)}
      onFocusOut={() => props.swarm.highlight(undefined)}
    >
      <div class="truncate font-mono text-[12px] text-v2-text-text-base">{props.overlap.path}</div>
      <Show when={props.overlap.blind}>
        <div class="text-v2-state-fg-warning [font-weight:440]">{language.t("session.swarm.overlap.blind")}</div>
      </Show>
      <Index each={props.overlap.writes}>
        {(write) => (
          <button
            type="button"
            class="flex w-full min-w-0 cursor-default items-baseline gap-1.5 rounded-[4px] border-0 bg-transparent p-0 text-left outline-none focus-visible:underline"
            onClick={() => props.swarm.select(write().laneID)}
          >
            <span class={`shrink-0 tabular-nums ${FAINT}`}>{clock().format(write().at)}</span>
            <span class="min-w-0 truncate text-v2-text-text-muted [font-weight:440]">
              {laneOf(write().laneID)?.title}
            </span>
            <Show when={write().blind}>
              <span class="size-1.5 shrink-0 self-center rounded-full bg-v2-state-fg-warning" />
            </Show>
          </button>
        )}
      </Index>
      <div class="mt-1">
        <ButtonV2 type="button" variant="ghost-muted" onClick={() => props.swarm.check(props.overlap, lastWrite())}>
          {language.t("session.swarm.overlap.check")}
        </ButtonV2>
      </div>
    </div>
  )
}

function Stat(props: { label: string; value: string | number; tone?: "warning" | "danger"; name: string }) {
  return (
    <div class="flex items-baseline gap-1" data-swarm-stat={props.name}>
      <span
        class="tabular-nums text-v2-text-text-base [font-weight:530]"
        classList={{
          "!text-v2-state-fg-warning": props.tone === "warning",
          "!text-v2-state-fg-danger": props.tone === "danger",
        }}
      >
        {props.value}
      </span>
      <span class={LABEL}>{props.label}</span>
    </div>
  )
}

export function SwarmPanel(props: { swarm: SwarmController }) {
  const language = useLanguage()
  const formats = useFormats()
  let list: HTMLDivElement | undefined
  let panel: HTMLElement | undefined

  const lanes = () => props.swarm.model()?.lanes ?? []
  const totals = () => props.swarm.model()?.totals
  const maxCost = createMemo(() => lanes().reduce((max, lane) => Math.max(max, lane.cost), 0))
  // Rows are keyed by id: the model is rebuilt every second and rebuilding rows would drop keyboard focus.
  const idList = (group: SwarmLane["group"]) => {
    const key = () =>
      lanes()
        .filter((lane) => lane.group === group)
        .map((lane) => lane.id)
        .join("\n")
    return createMemo(() => key().split("\n").filter(Boolean))
  }
  const runLanes = idList("run")
  const alongside = idList("alongside")
  const laneByID = createMemo(() => new Map(lanes().map((lane) => [lane.id, lane])))
  const indexByID = createMemo(() => new Map(lanes().map((lane, index) => [lane.id, index])))
  const spawnRows = (lane: SwarmLane) => {
    if (!lane.parentID) return
    const parent = indexByID().get(lane.parentID)
    const own = indexByID().get(lane.id)
    return parent === undefined || own === undefined ? undefined : own - parent
  }
  const renderLane = (id: string) => (
    <Show when={laneByID().get(id)}>
      {(lane) => (
        <Show when={props.swarm.model()}>
          {(model) => (
            <LaneRow
              swarm={props.swarm}
              lane={lane()}
              model={model()}
              spawnRows={spawnRows(lane())}
              maxCost={maxCost()}
            />
          )}
        </Show>
      )}
    </Show>
  )
  const failedReads = createMemo(() => lanes().filter((lane) => props.swarm.view.failed[lane.id]).length)

  const rowElement = (id: string | undefined) =>
    id ? list?.querySelector<HTMLElement>(`[data-swarm-lane="${CSS.escape(id)}"]`) : undefined
  const focusRow = () => rowElement(props.swarm.selectedLane()?.id)?.focus()

  const move = (delta: number | "first" | "last") => {
    const all = lanes()
    if (all.length === 0) return
    const index = all.findIndex((lane) => lane.id === props.swarm.selectedLane()?.id)
    const next =
      delta === "first" ? 0 : delta === "last" ? all.length - 1 : Math.min(all.length - 1, Math.max(0, index + delta))
    props.swarm.select(all[next]!.id)
    queueMicrotask(() => {
      const row = rowElement(all[next]!.id)
      row?.focus()
      row?.scrollIntoView({ block: "nearest" })
    })
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.swarm.close()
      return
    }
    const target = event.target as HTMLElement
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const lane = props.swarm.selectedLane()
    const run = (action: () => void) => {
      event.preventDefault()
      event.stopPropagation()
      action()
    }
    if (event.key === "ArrowDown" || event.key === "j") return run(() => move(1))
    if (event.key === "ArrowUp" || event.key === "k") return run(() => move(-1))
    if (event.key === "Home") return run(() => move("first"))
    if (event.key === "End") return run(() => move("last"))
    if (!lane) return
    // Buttons keep their own Enter; these keys belong to the lanes.
    if (event.key === "Enter" && target.tagName !== "BUTTON") return run(() => props.swarm.open(lane))
    if (event.key === "t" && props.swarm.canTell(lane))
      return run(() => panel?.querySelector<HTMLInputElement>("[data-swarm-tell]")?.focus())
    if (event.key === "x" && props.swarm.canTell(lane)) return run(() => props.swarm.stop(lane))
    if (lane.permission) {
      const request = lane.permission
      if (event.key === "a") return run(() => props.swarm.allow(lane, request, "once"))
      if (event.key === "A") return run(() => props.swarm.allow(lane, request, "always"))
      if (event.key === "d") return run(() => props.swarm.allow(lane, request, "reject"))
    }
    if (lane.question && /^[1-9]$/.test(event.key)) {
      const request = lane.question
      const option = inlineQuestion(request)?.options[Number(event.key) - 1]
      if (option) return run(() => props.swarm.answer(lane, request, option.label))
    }
  }

  onMount(() => {
    panel?.focus()
    // Answering or stopping removes the button that had focus, which drops it to the body. The keys still belong here.
    const onOrphanKey = (event: KeyboardEvent) => {
      if (event.target === document.body) onKey(event)
    }
    document.addEventListener("keydown", onOrphanKey)
    onCleanup(() => document.removeEventListener("keydown", onOrphanKey))
  })
  // The keyboard lands on a lane as soon as there is one, and follows the selection only from there.
  const hasLanes = createMemo(() => lanes().length > 0)
  createEffect(
    on(hasLanes, (ready) => {
      if (ready) queueMicrotask(focusRow)
    }),
  )
  // A drafted message from a shared file is meant to be read and sent.
  const selectedDraft = createMemo(() => {
    const lane = props.swarm.selectedLane()
    return lane ? props.swarm.view.draft[lane.id] : undefined
  })
  createEffect(
    on(selectedDraft, (draft, previous) => {
      if (draft && !previous)
        queueMicrotask(() => {
          const input = panel?.querySelector<HTMLInputElement>("[data-swarm-tell]")
          if (input && document.activeElement !== input) input.focus()
        })
    }),
  )

  return (
    <section
      ref={(el) => {
        panel = el
      }}
      id="session-swarm-panel"
      data-component="session-swarm"
      aria-label={language.t("session.swarm.title")}
      tabIndex={-1}
      class="absolute inset-0 z-[75] flex min-h-0 flex-col overflow-hidden bg-v2-background-bg-base outline-none [--swarm-row:72px] @[760px]:[--swarm-row:48px]"
      onKeyDown={onKey}
    >
      <header class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-v2-border-border-base py-1.5 pl-3 pr-1.5">
        <span class="text-v2-text-text-base [font-weight:530]">{language.t("session.swarm.title")}</span>
        <Show when={totals()}>
          {(value) => (
            <>
              <Stat name="agents" label={language.t("session.swarm.stat.agents")} value={value().agents} />
              <Show when={value().active > 0}>
                <Stat name="working" label={language.t("session.swarm.stat.working")} value={value().active} />
              </Show>
              <Show when={value().needs > 0}>
                <Stat
                  name="needs"
                  label={language.t("session.swarm.stat.needs")}
                  value={value().needs}
                  tone="warning"
                />
              </Show>
              <Show when={value().failed > 0}>
                <Stat
                  name="failed"
                  label={language.t("session.swarm.stat.failed")}
                  value={value().failed}
                  tone="danger"
                />
              </Show>
              <Show when={value().problems > 0}>
                <Stat
                  name="problems"
                  label={language.t("session.swarm.stat.problems")}
                  value={value().problems}
                  tone="danger"
                />
              </Show>
              <span class="mr-auto" />
              <Stat
                name="elapsed"
                label={language.t("session.swarm.stat.elapsed")}
                value={formatDuration(value().wallMs)}
              />
              <Stat name="work" label={language.t("session.swarm.stat.work")} value={formatDuration(value().workMs)} />
              <Stat name="cost" label={language.t("context.usage.cost")} value={formats.usd(value().cost)} />
            </>
          )}
        </Show>
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="small"
          class="ml-auto"
          aria-label={language.t("common.close")}
          onClick={() => props.swarm.close()}
          icon={<IconV2 name="close" />}
        />
      </header>

      <Show when={props.swarm.view.discoverFailed || failedReads() > 0}>
        <div
          data-swarm-error
          class="mx-2 mt-2 flex shrink-0 items-center gap-2 rounded-[6px] bg-v2-state-bg-danger px-2 py-1 text-v2-state-fg-danger [font-weight:440]"
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
          <div class={`flex items-center gap-2 px-3 py-3 ${FAINT}`}>
            <Spinner class="size-3.5" />
            {language.t("session.swarm.lane.reading")}
          </div>
        }
      >
        {(model) => (
          <>
            <Axis model={model()} />
            <div
              ref={(el) => {
                list = el
              }}
              data-swarm-list
              role="listbox"
              aria-label={language.t("session.swarm.title")}
              class="max-h-[58%] shrink-0 overflow-y-auto"
            >
              <For each={runLanes()}>{renderLane}</For>
              <Show when={alongside().length > 0}>
                <div class={`border-b border-v2-border-border-base px-3 py-1 ${FAINT}`} data-swarm-alongside>
                  {language.t("session.swarm.group.alongside")}
                </div>
                <For each={alongside()}>{renderLane}</For>
              </Show>
            </div>

            <Show when={model().totals.agents <= 1 && alongside().length === 0}>
              <div data-swarm-empty class={`px-3 py-3 ${FAINT}`}>
                {language.t("session.swarm.empty")}
              </div>
            </Show>

            <div data-swarm-detail class="flex min-h-0 flex-1 flex-col overflow-y-auto @[900px]:flex-row">
              <Show when={props.swarm.selectedLane()}>
                {(lane) => <Inspector swarm={props.swarm} lane={lane()} focusRow={focusRow} />}
              </Show>
              <Show when={model().totals.agents > 1 || alongside().length > 0}>
                <aside
                  data-swarm-overlaps
                  class="flex min-w-0 shrink-0 flex-col gap-1 border-t border-v2-border-border-base px-1.5 py-2 @[900px]:w-[320px] @[900px]:border-l @[900px]:border-t-0"
                >
                  <div class={`px-1.5 ${FAINT}`}>{language.t("session.swarm.overlap.title")}</div>
                  <Show
                    when={model().overlaps.length > 0}
                    fallback={<div class={`px-1.5 ${LABEL}`}>{language.t("session.swarm.overlap.none")}</div>}
                  >
                    <Index each={model().overlaps}>
                      {(overlap) => <OverlapRow swarm={props.swarm} overlap={overlap()} model={model()} />}
                    </Index>
                  </Show>
                </aside>
              </Show>
            </div>

            <footer
              class={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-v2-border-border-base bg-v2-background-bg-base px-3 py-1 ${FAINT}`}
            >
              <span class="flex items-center gap-1">
                <span class="h-2.5 w-1.5 bg-v2-text-text-base" />
                {language.t("session.swarm.legend.edit")}
              </span>
              <span class="flex items-center gap-1">
                <span class="h-2 w-1.5 bg-v2-text-text-muted" />
                {language.t("session.swarm.legend.command")}
              </span>
              <span class="flex items-center gap-1">
                <span class="h-1 w-1.5 bg-v2-border-border-strong" />
                {language.t("session.swarm.legend.explore")}
              </span>
              <span class="flex items-center gap-1">
                <span class={`h-2.5 w-3 ${CELL.agent.fill}`} />
                {language.t("session.swarm.legend.agent")}
              </span>
              <span class="flex items-center gap-1">
                <span class={`h-2.5 w-1.5 ${CELL.blocked.fill}`} />
                {language.t("session.swarm.legend.blocked")}
              </span>
              <span class="flex items-center gap-1">
                <span class="h-2.5 w-1.5 bg-v2-state-fg-danger" />
                {language.t("session.swarm.legend.problem")}
              </span>
              <span class="ml-auto truncate max-md:hidden">{language.t("session.swarm.hint")}</span>
            </footer>
          </>
        )}
      </Show>
    </section>
  )
}
