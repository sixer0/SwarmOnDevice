import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"
import type { AutonomySession } from "@opencode-ai/sdk/v2"
import { getToolInfo } from "@opencode-ai/session-ui/message-part"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { createEffect, createMemo, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { SwarmController } from "../swarm/swarm-controller"
import { SwarmAgents } from "../swarm/swarm-view"
import type { SessionMapController } from "./session-map-controller"
import {
  decisionGroups,
  formatDuration,
  relativePath,
  type DecisionEntry,
  type DecisionNote,
  type MapChapter,
  type MapFile,
  type MapFilter,
  type MapRow,
  type MapStep,
} from "./session-map-model"

// A step this short is not worth a duration; a slow one is often the thing being looked for.
const SLOW_STEP_MS = 5000

const ROW = `
  group/map relative flex w-full min-w-0 cursor-default items-start gap-2 rounded-[6px] border-0 bg-transparent px-2 py-1.5
  text-left outline-none transition-colors duration-[120ms]
  hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover
  focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]
  leading-[18px] [content-visibility:auto] [contain-intrinsic-size:auto_32px]
`

function StepRow(props: {
  rowID: string
  map: SessionMapController
  step: MapStep
  directory: string
  snippet?: string
  selected: boolean
  onAsk: () => void
}) {
  const language = useLanguage()
  const info = createMemo(() =>
    props.step.tool ? getToolInfo(props.step.tool, props.step.input, props.step.metadata) : undefined,
  )
  const path = createMemo(() =>
    props.step.kind === "edit" || props.step.tool === "read"
      ? relativePath(props.step.label, props.directory)
      : undefined,
  )
  const duration = createMemo(() => {
    const end = props.step.end
    if (end === undefined || end - props.step.start < SLOW_STEP_MS) return
    return formatDuration(end - props.step.start)
  })
  const isFresh = () => {
    const since = props.map.since()
    return since !== undefined && props.step.start > since
  }
  return (
    <div class="group/step relative">
      <button
        type="button"
        data-map-row={props.rowID}
        data-map-kind={props.step.kind}
        data-map-problem={props.step.problem ? "" : undefined}
        tabindex={props.selected ? 0 : -1}
        class={ROW}
        classList={{ "!bg-v2-overlay-simple-overlay-hover": props.selected }}
        onClick={() => props.map.openStep(props.step)}
      >
        <span
          class="mt-px flex size-4 shrink-0 items-center justify-center text-v2-text-text-faint"
          classList={{ "!text-v2-state-fg-danger": !!props.step.problem }}
        >
          <Switch fallback={<Icon name={info()?.icon ?? "warning"} size="small" />}>
            <Match when={props.step.running}>
              <Spinner class="size-3.5" />
            </Match>
          </Switch>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex min-w-0 items-baseline gap-2">
            <span
              class="min-w-0 truncate text-v2-text-text-base [font-weight:440]"
              classList={{ "font-mono text-[12px]": props.step.kind === "command" }}
              title={props.step.label}
            >
              {path() ?? props.step.label}
            </span>
            <Show when={props.step.problem && props.step.kind !== "error" ? props.step.problem : undefined}>
              {(problem) => (
                <span class="max-w-[50%] shrink-0 truncate text-v2-state-fg-danger tabular-nums [font-weight:530]">
                  {problem()}
                </span>
              )}
            </Show>
            <Show when={duration()}>
              {(value) => (
                <span class="ml-auto shrink-0 text-v2-text-text-faint tabular-nums [font-weight:440]">{value()}</span>
              )}
            </Show>
            <Show when={isFresh()}>
              <span class="ml-auto size-1.5 shrink-0 self-center rounded-full bg-v2-state-fg-info" />
            </Show>
          </span>
          <Show when={props.step.detail}>
            {(detail) => <span class="truncate text-v2-text-text-muted [font-weight:440]">{detail()}</span>}
          </Show>
          <Show when={props.snippet}>
            {(snippet) => <span class="line-clamp-2 text-v2-text-text-muted [font-weight:440]">{snippet()}</span>}
          </Show>
        </span>
      </button>
      <div class="absolute right-1 top-1 hidden rounded-[6px] bg-v2-background-bg-base group-hover/step:block">
        <IconButtonV2
          type="button"
          tabindex={-1}
          variant="ghost-muted"
          size="small"
          aria-label={language.t("session.map.ask")}
          title={language.t("session.map.ask")}
          onClick={props.onAsk}
          icon={<Icon name="bubble-5" size="small" />}
        />
      </div>
    </div>
  )
}

function ChapterRow(props: {
  map: SessionMapController
  chapter: MapChapter
  open: boolean
  selected: boolean
  canToggle: boolean
  onRewind: () => void
}) {
  const language = useLanguage()
  const duration = createMemo(() =>
    props.chapter.end === undefined ? undefined : formatDuration(props.chapter.end - props.chapter.start),
  )
  const prompt = () => (props.chapter.compaction ? language.t("session.map.compaction") : props.chapter.prompt)
  return (
    <div class="group/chapter relative mt-1 first:mt-0">
      <button
        type="button"
        data-map-row={props.chapter.id}
        data-map-chapter=""
        data-map-current={props.map.visibleTurn() === props.chapter.id ? "" : undefined}
        tabindex={props.selected ? 0 : -1}
        aria-expanded={props.canToggle ? props.open : undefined}
        class={ROW}
        classList={{ "!bg-v2-overlay-simple-overlay-hover": props.selected }}
        onClick={() => props.map.openChapter(props.chapter)}
      >
        <span
          class="absolute inset-y-1.5 left-0 w-0.5 rounded-full"
          classList={{ "bg-v2-text-text-muted": props.map.visibleTurn() === props.chapter.id }}
        />
        <span
          class="mt-px flex size-4 shrink-0 items-center justify-center rounded text-v2-text-text-faint hover:text-v2-text-text-base"
          onClick={(event) => {
            if (!props.canToggle) return
            event.stopPropagation()
            props.map.setExpanded(props.chapter.id, !props.open)
          }}
        >
          <IconV2 name="chevron-down" class={props.open ? "" : "-rotate-90"} />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="line-clamp-2 text-v2-text-text-base [font-weight:530]" title={prompt()}>
            {prompt()}
          </span>
          <Show when={props.chapter.problems > 0 || duration()}>
            <span class="flex items-center gap-x-2.5 text-v2-text-text-faint [font-weight:440]">
              <Show when={props.chapter.problems > 0}>
                <span class="inline-flex items-center gap-0.5 tabular-nums text-v2-state-fg-danger">
                  <Icon name="warning" size="small" class="!size-3.5" />
                  {props.chapter.problems}
                </span>
              </Show>
              <Show when={duration()}>{(value) => <span class="ml-auto tabular-nums">{value()}</span>}</Show>
            </span>
          </Show>
        </span>
      </button>
      <div class="absolute right-1 top-1 hidden rounded-[6px] bg-v2-background-bg-base group-hover/chapter:block">
        <IconButtonV2
          type="button"
          tabindex={-1}
          variant="ghost-muted"
          size="small"
          aria-label={language.t("session.map.rewind")}
          title={language.t("session.map.rewind")}
          onClick={props.onRewind}
          icon={<IconV2 name="outline-reset" />}
        />
      </div>
    </div>
  )
}

function FileRow(props: {
  map: SessionMapController
  file: MapFile
  open: boolean
  selected: boolean
  directory: string
}) {
  return (
    <button
      type="button"
      data-map-row={`file:${props.file.path}`}
      tabindex={props.selected ? 0 : -1}
      aria-expanded={props.open}
      class={ROW}
      classList={{ "!bg-v2-overlay-simple-overlay-hover": props.selected }}
      onClick={() => props.map.setExpanded(`file:${props.file.path}`, !props.open)}
    >
      <span class="mt-px flex size-4 shrink-0 items-center justify-center text-v2-text-text-faint">
        <IconV2 name="chevron-down" class={props.open ? "" : "-rotate-90"} />
      </span>
      <span class="min-w-0 flex-1 truncate text-v2-text-text-base [font-weight:440]" title={props.file.path}>
        {relativePath(props.file.path, props.directory)}
      </span>
      <span class="shrink-0 text-v2-text-text-faint tabular-nums [font-weight:440]">
        <span class="text-v2-state-fg-success">+{props.file.added}</span>{" "}
        <span class="text-v2-state-fg-danger">-{props.file.removed}</span> · {props.file.steps.length}
      </span>
    </button>
  )
}

const CATEGORY_LABEL = {
  outside_folder: "settings.permissions.tool.external_directory.description",
  outward: "session.permission.leavesMachine",
  not_reversible: "session.permission.cannotUndo",
  sensitive_file: "session.review.flag.sensitive-path",
  secret_file: "session.review.flag.secret",
  external_tool: "session.map.decisions.category.not_routine",
  no_undo: "session.permission.cannotUndo",
  not_routine: "session.map.decisions.category.not_routine",
  queue_full: "session.map.decisions.category.queue_full",
  decider_unavailable: "session.map.decisions.category.decider_unavailable",
  folder_not_trusted: "session.map.decisions.category.folder_not_trusted",
  plan_mode: "session.map.decisions.category.plan_mode",
  app_state: "session.map.decisions.category.app_state",
  asks_every_time: "session.map.decisions.category.asks_every_time",
} as const

// These labels already say Undo cannot help, so the row does not say it twice.
const SAYS_NO_UNDO: readonly string[] = ["outward", "not_reversible", "no_undo"]

const OUTCOME_LABEL = {
  ran: "session.map.decisions.outcome.ran",
  failed: "home.agents.failed",
  not_run: "session.map.decisions.outcome.notRun",
  rejected_later: "session.map.decisions.outcome.notRun",
  abandoned: "session.map.decisions.outcome.notRun",
  undone: "session.review.group.undone",
} as const

const NOTE_LABEL = {
  mode_on: "toast.permissions.autonomous.on.title",
  mode_off: "toast.permissions.autonomous.off.title",
  decider_unavailable: "session.map.decisions.category.decider_unavailable",
  queue_full: "session.map.decisions.category.queue_full",
} satisfies Record<DecisionNote["note"], string>

const RETRY_BASE_MS = 3000
const RETRY_LIMIT = 3
const REFRESH_DEBOUNCE_MS = 1000

// Patterns and reasons can come from an attacker. They stay JSX text: no Markdown, no links, nothing that parses them.
export function DecisionRow(props: {
  entry: DecisionEntry
  busy: boolean
  onReply?: (reply: "once" | "reject") => void
  onUndo: () => void
}) {
  const language = useLanguage()
  const category = () => {
    const name = props.entry.category
    return name && name in CATEGORY_LABEL ? CATEGORY_LABEL[name as keyof typeof CATEGORY_LABEL] : undefined
  }
  const outcome = () => {
    const name = props.entry.outcome
    return name && name in OUTCOME_LABEL ? OUTCOME_LABEL[name as keyof typeof OUTCOME_LABEL] : undefined
  }
  const by = () => (props.entry.by === "person" ? language.t("memory.source.user") : props.entry.by)
  const cannotUndo = () => props.entry.undo === "none" && !SAYS_NO_UNDO.includes(props.entry.category ?? "")
  return (
    <div data-decision={props.entry.id} class="flex min-w-0 flex-col gap-1 rounded-[6px] px-2 py-1.5 leading-[18px]">
      <span class="text-v2-text-text-faint [font-weight:440]">{props.entry.permission}</span>
      <For each={props.entry.patterns}>
        {(pattern) => (
          <span
            data-decision-pattern
            class="min-w-0 whitespace-pre-wrap break-all font-mono text-[12px] text-v2-text-text-base"
          >
            {pattern}
          </span>
        )}
      </For>
      <Show when={props.entry.patternsTruncated}>
        <span class="font-mono text-[12px] text-v2-text-text-faint">…</span>
      </Show>
      <Show when={category()}>
        {(key) => <span class="text-v2-text-text-muted [font-weight:440]">{language.t(key())}</span>}
      </Show>
      <Show when={props.entry.reason}>
        {(reason) => (
          <span
            data-decision-reason
            class="min-w-0 whitespace-pre-wrap break-words text-v2-text-text-muted [font-weight:440]"
          >
            {reason()}
          </span>
        )}
      </Show>
      <Show when={by() || outcome()}>
        <span class="flex flex-wrap items-center gap-x-2 text-v2-text-text-faint [font-weight:440]">
          <Show when={by()}>{(value) => <span class="min-w-0 break-all">{value()}</span>}</Show>
          <Show when={outcome()}>{(key) => <span>{language.t(key())}</span>}</Show>
        </span>
      </Show>
      <Show when={cannotUndo()}>
        <span data-decision-no-undo class="text-v2-text-text-faint [font-weight:440]">
          {language.t("session.permission.cannotUndo")}
        </span>
      </Show>
      <Show when={props.onReply}>
        {(reply) => (
          <span class="mt-0.5 flex flex-wrap gap-1">
            <ButtonV2 size="small" variant="contrast" disabled={props.busy} onClick={() => reply()("once")}>
              {language.t("session.movedOn.allow")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" disabled={props.busy} onClick={() => reply()("reject")}>
              {language.t("ui.permission.deny")}
            </ButtonV2>
          </span>
        )}
      </Show>
      <Show when={props.entry.undo === "button"}>
        <span class="mt-0.5 flex">
          <ButtonV2 data-decision-undo size="small" variant="ghost" disabled={props.busy} onClick={props.onUndo}>
            {language.t("command.session.undo")}
          </ButtonV2>
        </span>
      </Show>
    </div>
  )
}

function DialogUndoDecision(props: { onConfirm: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <DialogV2 fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("command.session.undo")}
          description={language.t("session.map.decisions.undo.confirm")}
        />
      </DialogHeader>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="danger"
          onClick={() => {
            dialog.close()
            props.onConfirm()
          }}
        >
          {language.t("command.session.undo")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}

// Read while the panel is open, never per event: the route reads the whole record of the root.
function createDecisions(rootID: () => string | undefined) {
  const language = useLanguage()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const [store, setStore] = createStore({
    state: undefined as AutonomySession | undefined,
    failed: false,
    attempts: 0,
    cooling: false,
    acting: {} as Record<string, boolean | undefined>,
    // Until the session's own update arrives, or for a child whose session was never read here.
    reverted: {} as Record<string, string | undefined>,
  })
  const report = (source: string, cause: unknown) => {
    void sdk()
      .client.app.log({
        service: "app.session-map.decisions",
        level: "error",
        message: `${source}: ${errorMessage(cause, "unknown")}`,
        extra: { rootID: rootID() },
      })
      .catch(() => undefined)
  }
  const load = () => {
    const id = rootID()
    if (!id) return Promise.resolve()
    return sdk()
      .client.autonomy.session({ sessionID: id })
      .then((result) => {
        if (rootID() !== id) return
        setStore({ state: result.data, failed: false, attempts: 0 })
      })
      .catch((cause) => {
        if (rootID() !== id) return
        setStore("failed", true)
        report("load", cause)
      })
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let coolTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    clearTimeout(refreshTimer)
    clearTimeout(coolTimer)
  })
  const refreshSoon = () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS)
  }

  createEffect(
    on(rootID, () => {
      setStore({ state: undefined, failed: false, attempts: 0, cooling: false })
      void load()
    }),
  )
  createEffect(() => {
    const events = sdk().event
    const stops = [
      events.on("permission.asked", refreshSoon),
      events.on("permission.replied", refreshSoon),
      events.on("session.status", refreshSoon),
      events.on("autonomy.blocked", refreshSoon),
    ]
    onCleanup(() => stops.forEach((stop) => stop()))
  })

  const sessionData = () => serverSync().session.data
  const groups = createMemo(() => {
    const state = store.state
    if (!state) return
    return decisionGroups(state.lines, state.rootID, (sessionID) => {
      const info = sessionData().info[sessionID]
      return info ? info.revert?.messageID : store.reverted[sessionID]
    })
  })
  const isBusy = (sessionID?: string) => (sessionData().session_status[sessionID ?? ""]?.type ?? "idle") !== "idle"

  const act = (key: string, source: string, run: () => Promise<unknown>) => {
    if (store.acting[key]) return
    setStore("acting", key, true)
    void run()
      .catch((cause) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(cause, language.t("common.requestFailed")),
        })
        report(source, cause)
      })
      .then(load)
      .finally(() => setStore("acting", key, false))
  }

  return {
    store,
    groups,
    // Worth showing only where the mode has been used, and the file has lines or the mode is on right now.
    shown: () => !!store.state && (store.state.on || store.state.lines.length > 0),
    canRetry: () => !store.cooling && store.attempts < RETRY_LIMIT,
    retry: () => {
      if (store.cooling || store.attempts >= RETRY_LIMIT) return
      const wait = RETRY_BASE_MS * 2 ** store.attempts
      setStore({ cooling: true, attempts: store.attempts + 1 })
      coolTimer = setTimeout(() => setStore("cooling", false), wait)
      void load()
    },
    refresh: () => void load(),
    // A running root can still be writing over what the Undo brings back, so nothing is undone until it stops.
    undoBusy: (entry: DecisionEntry) => !!store.acting[entry.id] || isBusy(rootID()) || isBusy(entry.sessionID),
    replyBusy: (entry: DecisionEntry) => !!store.acting[entry.id],
    reply: (entry: DecisionEntry, reply: "once" | "reject") =>
      act(entry.id, "reply", () =>
        sdk().api.permission.reply({
          sessionID: entry.sessionID,
          requestID: entry.id,
          reply,
          location: { directory: entry.directory },
        }),
      ),
    // Only the root's own lines get here: `decisionGroups` gives a subagent's line no button.
    undo: (entry: DecisionEntry) => {
      const messageID = entry.messageID
      if (!messageID) return
      act(entry.id, "undo", () =>
        sdk()
          .api.session.revert.stage({ sessionID: entry.sessionID, messageID })
          .then(() => setStore("reverted", entry.sessionID, messageID)),
      )
    },
    confirm: () => act("confirm", "confirm", () => sdk().client.autonomy.confirm()),
  }
}

function DecisionGroup(props: {
  title: string
  entries: readonly DecisionEntry[]
  decisions: ReturnType<typeof createDecisions>
  waiting?: boolean
}) {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <section data-decision-group class="flex flex-col">
      <h3 class="m-0 px-2 py-1 text-v2-text-text-base [font-weight:530]">{props.title}</h3>
      <Show
        when={props.entries.length > 0}
        fallback={
          <div class="px-2 py-1 text-v2-text-text-faint [font-weight:440]">
            {language.t("session.map.filter.empty")}
          </div>
        }
      >
        <For each={props.entries}>
          {(entry) => (
            <DecisionRow
              entry={entry}
              busy={props.waiting ? props.decisions.replyBusy(entry) : props.decisions.undoBusy(entry)}
              onReply={props.waiting ? (reply) => props.decisions.reply(entry, reply) : undefined}
              onUndo={() =>
                void dialog.show(() => <DialogUndoDecision onConfirm={() => props.decisions.undo(entry)} />)
              }
            />
          )}
        </For>
      </Show>
    </section>
  )
}

function DecisionList(props: { decisions: ReturnType<typeof createDecisions> }) {
  const language = useLanguage()
  const store = () => props.decisions.store
  return (
    <div data-map-decisions data-scrollable class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1.5 pb-1">
      <Show when={store().state?.externalChange.length}>
        <div
          data-decision-external
          class="mx-0.5 flex flex-col gap-1.5 rounded-[6px] bg-v2-state-bg-warning px-2 py-1.5 text-v2-state-fg-warning"
        >
          <span class="[font-weight:440]">{language.t("session.map.decisions.marker.externalChange")}</span>
          <span class="flex">
            <ButtonV2 size="small" variant="ghost" onClick={() => props.decisions.confirm()}>
              {language.t("ui.common.confirm")}
            </ButtonV2>
          </span>
        </div>
      </Show>
      <Show when={store().state && !store().state?.intact}>
        <div data-decision-damaged class="px-2 text-v2-text-text-muted [font-weight:440]">
          {language.t("session.map.history.error")}
        </div>
      </Show>
      <Show when={store().failed}>
        <div data-map-history="error" class="flex items-center gap-2 px-2 text-v2-text-text-muted [font-weight:440]">
          <span class="min-w-0 flex-1">{language.t("session.map.history.error")}</span>
          <ButtonV2 variant="ghost" disabled={!props.decisions.canRetry()} onClick={() => props.decisions.retry()}>
            {language.t("home.agents.retry")}
          </ButtonV2>
        </div>
      </Show>
      <Show when={props.decisions.groups()}>
        {(groups) => (
          <>
            <DecisionGroup
              title={language.t("session.map.decisions.group.waiting")}
              entries={groups().waiting}
              decisions={props.decisions}
              waiting
            />
            <DecisionGroup
              title={language.t("session.map.decisions.group.decided")}
              entries={groups().decided}
              decisions={props.decisions}
            />
            <DecisionGroup
              title={language.t("session.map.decisions.group.limited")}
              entries={groups().limited}
              decisions={props.decisions}
            />
            <For each={groups().notes}>
              {(note) => (
                <div data-decision-note class="px-2 text-v2-text-text-faint [font-weight:440]">
                  {language.t(NOTE_LABEL[note.note])}
                </div>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  )
}

export function SessionMapPanel(props: {
  map: SessionMapController
  swarm: SwarmController
  directory: string
  onAsk: (step: MapStep) => void
  onRewind: (chapter: MapChapter) => void
  onClose: () => void
}) {
  const language = useLanguage()
  let list: HTMLDivElement | undefined
  let searchInput: HTMLInputElement | undefined

  const decisions = createDecisions(() => props.swarm.rootID())
  const counts = () => props.map.model().counts
  const filters = createMemo<{ id: MapFilter; label: string; count?: number; tone?: "danger" | "warning" }[]>(() => [
    { id: "all", label: language.t("session.map.filter.all") },
    {
      id: "problems",
      label: language.t("session.map.filter.problems"),
      count: counts().problems,
      tone: "danger",
    },
    { id: "edits", label: language.t("session.map.filter.edits"), count: props.map.model().files.length },
    ...(props.swarm.pulse().agents > 1
      ? [
          {
            id: "agents" as const,
            label: language.t("session.map.filter.agents"),
            count: props.swarm.pulse().agents,
            tone: props.swarm.pulse().needs > 0 ? ("warning" as const) : undefined,
          },
        ]
      : []),
    ...(decisions.shown()
      ? [
          {
            id: "decisions" as const,
            label: language.t("session.map.filter.decisions"),
            count: decisions.store.state?.open,
            tone: "warning" as const,
          },
        ]
      : []),
  ])
  const showingAgents = () => props.map.view.filter === "agents"
  const showingDecisions = () => props.map.view.filter === "decisions"
  createEffect(
    on(showingDecisions, (showing) => {
      if (showing) decisions.refresh()
    }),
  )
  const rowByID = createMemo(() => new Map(props.map.rows().map((row) => [row.id, row] as const)))
  const rowIDs = createMemo(() => props.map.rows().map((row) => row.id))
  const firstFocusable = () => rowIDs()[0]

  const selectedID = createMemo(() => {
    const id = props.map.view.selected
    if (id && rowByID().has(id)) return id
    const turn = props.map.visibleTurn()
    if (turn && rowByID().has(turn)) return turn
    return firstFocusable()
  })

  const element = (id: string | undefined) =>
    id ? list?.querySelector<HTMLElement>(`[data-map-row="${CSS.escape(id)}"]`) : undefined

  const focusRow = (id: string | undefined) => {
    if (!id) return
    props.map.select(id)
    requestAnimationFrame(() => {
      const target = element(id)
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ block: "nearest" })
    })
  }

  // Opening lands on the turn being read, so arrow keys start from there.
  onMount(() => {
    requestAnimationFrame(() => focusRow(selectedID()))
  })

  // Reading older history can take focus with it. Once the list settles, land on the turn being read.
  createEffect(
    on(
      () => props.map.view.hydrating,
      (hydrating) => {
        if (hydrating) return
        const id = selectedID()
        const active = document.activeElement
        if (!active || active === document.body || !active.isConnected) focusRow(id)
        else element(id)?.scrollIntoView({ block: "nearest" })
      },
      { defer: true },
    ),
  )

  // While nothing is selected the list follows the transcript as it scrolls.
  createEffect(
    on(props.map.visibleTurn, (turn) => {
      if (props.map.view.selected || !turn) return
      element(turn)?.scrollIntoView({ block: "nearest" })
    }),
  )

  // Something outside the list moved the selection (next problem, the run strip).
  createEffect(
    on(
      () => props.map.view.selected,
      (id) => {
        if (id && !list?.contains(document.activeElement)) element(id)?.scrollIntoView({ block: "nearest" })
      },
      { defer: true },
    ),
  )

  const activate = (row: MapRow) => {
    if (row.type === "chapter") return props.map.openChapter(row.chapter)
    if (row.type === "step") return props.map.openStep(row.step)
    if (row.type === "explored") return props.map.openStep(row.steps[0]!)
    if (row.type === "file") return props.map.setExpanded(row.id, !row.open)
  }

  const onListKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const ids = rowIDs()
    const id = selectedID()
    const at = id ? ids.indexOf(id) : -1
    const row = id ? rowByID().get(id) : undefined
    const stop = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (event.key === "ArrowDown" || event.key === "j") {
      stop()
      return focusRow(ids[Math.min(at + 1, ids.length - 1)])
    }
    if (event.key === "ArrowUp" || event.key === "k") {
      stop()
      return focusRow(ids[Math.max(at - 1, 0)])
    }
    if (event.key === "Home") {
      stop()
      return focusRow(ids[0])
    }
    if (event.key === "End") {
      stop()
      return focusRow(ids.at(-1))
    }
    if (event.key === "/") {
      stop()
      searchInput?.focus()
      searchInput?.select()
      return
    }
    if (!row) return
    if (event.key === "Enter" || event.key === " ") {
      stop()
      return activate(row)
    }
    if (event.key === "ArrowRight" && (row.type === "chapter" || row.type === "file") && !row.open) {
      stop()
      return props.map.setExpanded(row.id, true)
    }
    if (event.key === "ArrowLeft" && (row.type === "chapter" || row.type === "file") && row.open) {
      stop()
      return props.map.setExpanded(row.id, false)
    }
    if (event.key === "a" && (row.type === "step" || row.type === "explored")) {
      stop()
      return props.onAsk(row.type === "step" ? row.step : row.steps[0]!)
    }
    if (event.key === "z" && row.type === "chapter") {
      stop()
      return props.onRewind(row.chapter)
    }
  }

  const onPanelKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    if (event.target === searchInput && props.map.view.draft) {
      props.map.search("")
      return
    }
    props.onClose()
  }

  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "Enter") return
    event.preventDefault()
    event.stopPropagation()
    const first = props.map.rows().find((row) => row.type === "step") ?? props.map.rows()[0]
    if (!first) return
    if (event.key === "Enter") activate(first)
    focusRow(first.id)
  }

  const emptyText = () => {
    if (props.map.view.query.trim()) return language.t("session.map.search.empty")
    if (props.map.view.filter !== "all") return language.t("session.map.filter.empty")
    return language.t("session.map.empty")
  }

  const renderRow = (id: string): JSX.Element => {
    const row = () => rowByID().get(id)
    const selected = () => selectedID() === id
    return (
      <Show when={row()} keyed={false}>
        {(value) => (
          <Switch>
            <Match when={value().type === "chapter" && (value() as Extract<MapRow, { type: "chapter" }>)}>
              {(item) => (
                <ChapterRow
                  map={props.map}
                  chapter={item().chapter}
                  open={item().open}
                  selected={selected()}
                  canToggle={props.map.view.filter === "all" && !props.map.view.query.trim()}
                  onRewind={() => props.onRewind(item().chapter)}
                />
              )}
            </Match>
            <Match when={value().type === "step" && (value() as Extract<MapRow, { type: "step" }>)}>
              {(item) => (
                <div class="pl-3">
                  <StepRow
                    rowID={id}
                    map={props.map}
                    step={item().step}
                    snippet={item().snippet}
                    directory={props.directory}
                    selected={selected()}
                    onAsk={() => props.onAsk(item().step)}
                  />
                </div>
              )}
            </Match>
            <Match when={value().type === "explored" && (value() as Extract<MapRow, { type: "explored" }>)}>
              {(item) => (
                <div class="pl-3">
                  <button
                    type="button"
                    data-map-row={id}
                    tabindex={selected() ? 0 : -1}
                    class={ROW}
                    classList={{ "!bg-v2-overlay-simple-overlay-hover": selected() }}
                    onClick={() => props.map.openStep(item().steps[0]!)}
                  >
                    <span class="mt-px flex size-4 shrink-0 items-center justify-center text-v2-text-text-faint">
                      <Icon name="magnifying-glass-menu" size="small" />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-v2-text-text-faint [font-weight:440]">
                      {language.t("session.map.explored", { count: item().steps.length })}
                    </span>
                  </button>
                </div>
              )}
            </Match>
            <Match when={value().type === "file" && (value() as Extract<MapRow, { type: "file" }>)}>
              {(item) => (
                <FileRow
                  map={props.map}
                  file={item().file}
                  open={item().open}
                  selected={selected()}
                  directory={props.directory}
                />
              )}
            </Match>
            <Match when={value().type === "truncated" && (value() as Extract<MapRow, { type: "truncated" }>)}>
              {(item) => (
                <div class="px-2 py-2 text-v2-text-text-faint [font-weight:440]">
                  {language.t("session.map.truncated", { total: item().total })}
                </div>
              )}
            </Match>
          </Switch>
        )}
      </Show>
    )
  }

  return (
    <aside
      id="session-map-panel"
      data-component="session-map"
      aria-label={language.t("session.activity.title")}
      class="absolute inset-y-0 right-0 z-[70] flex h-full w-[min(372px,100%)] shrink-0 flex-col gap-2 border-l border-v2-border-border-base bg-v2-background-bg-base pt-2 shadow-[var(--v2-elevation-raised)] @[900px]:static @[900px]:w-[372px] @[900px]:shadow-none"
      onKeyDown={onPanelKey}
    >
      <div class="flex h-8 shrink-0 items-center gap-2 pl-3 pr-1.5">
        <span class="min-w-0 flex-1 truncate text-v2-text-text-base [font-weight:530]">
          {language.t("session.activity.title")}
        </span>
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="small"
          aria-label={language.t("common.close")}
          onClick={props.onClose}
          icon={<IconV2 name="close" />}
        />
      </div>

      <div class="flex shrink-0 flex-wrap gap-1 px-2" role="group" aria-label={language.t("session.activity.title")}>
        <For each={filters()}>
          {(filter) => (
            <button
              type="button"
              data-map-filter={filter.id}
              aria-pressed={props.map.view.filter === filter.id}
              class="flex h-6 cursor-default items-center gap-1 whitespace-nowrap rounded-[6px] border-0 bg-transparent px-1.5 text-v2-text-text-muted outline-none transition-colors duration-[120ms] [font-weight:440] hover:bg-v2-overlay-simple-overlay-hover focus-visible:[box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)] aria-pressed:bg-v2-overlay-simple-overlay-hover aria-pressed:text-v2-text-text-base"
              onClick={() => props.map.setFilter(filter.id)}
            >
              {filter.label}
              <Show when={filter.count}>
                <span
                  class="tabular-nums text-v2-text-text-faint"
                  classList={{
                    "!text-v2-state-fg-danger": filter.tone === "danger",
                    "!text-v2-state-fg-warning": filter.tone === "warning",
                  }}
                >
                  {filter.count}
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <Show
        when={!showingAgents() && !showingDecisions()}
        fallback={showingAgents() ? <SwarmAgents swarm={props.swarm} /> : <DecisionList decisions={decisions} />}
      >
        <div class="mx-2 flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] bg-v2-overlay-simple-overlay-hover px-2">
          <IconV2 name="magnifying-glass" class="shrink-0 text-v2-text-text-faint" />
          <input
            ref={(el) => {
              searchInput = el
            }}
            data-map-search
            type="text"
            value={props.map.view.draft}
            placeholder={language.t("session.map.search.placeholder")}
            aria-label={language.t("session.map.search.placeholder")}
            class="min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-none [font-weight:440] placeholder:text-v2-text-text-faint"
            onInput={(event) => props.map.search(event.currentTarget.value)}
            onKeyDown={onSearchKey}
          />
        </div>

        <Show when={props.map.fresh()}>
          {(fresh) => (
            <div
              data-map-fresh
              class="mx-2 flex shrink-0 items-center gap-1 rounded-[6px] bg-v2-state-bg-info pl-2 pr-0.5 text-v2-state-fg-info"
            >
              <button
                type="button"
                class="flex min-h-7 min-w-0 flex-1 cursor-default flex-wrap items-center gap-x-2 border-0 bg-transparent text-left text-current outline-none [font-weight:530] focus-visible:underline"
                onClick={() => props.map.openStep(fresh().first)}
              >
                <span>{language.t("session.map.since", { steps: fresh().steps.length })}</span>
                <Show when={fresh().problems > 0}>
                  <span class="text-v2-state-fg-danger">
                    {language.t("session.map.since.problems", { problems: fresh().problems })}
                  </span>
                </Show>
              </button>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                aria-label={language.t("common.dismiss")}
                onClick={() => props.map.dismissFresh()}
                icon={<IconV2 name="close" />}
              />
            </div>
          )}
        </Show>

        <Show when={props.map.view.hydrating}>
          <div
            data-map-history="loading"
            class="mx-3 flex shrink-0 items-center gap-2 text-v2-text-text-faint [font-weight:440]"
          >
            <Spinner class="size-3.5" />
            {language.t("session.map.history.loading")}
          </div>
        </Show>
        <Show when={props.map.view.hydrateError}>
          <div
            data-map-history="error"
            class="mx-3 flex shrink-0 items-center gap-2 text-v2-text-text-muted [font-weight:440]"
          >
            <span class="min-w-0 flex-1">{language.t("session.map.history.error")}</span>
            <ButtonV2 variant="ghost" onClick={() => void props.map.hydrate()}>
              {language.t("home.agents.retry")}
            </ButtonV2>
          </div>
        </Show>

        <div
          ref={(el) => {
            list = el
          }}
          data-map-list
          data-scrollable
          class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1"
          onKeyDown={onListKey}
          onFocusIn={(event) => {
            const id = (event.target as HTMLElement).closest<HTMLElement>("[data-map-row]")?.dataset.mapRow
            if (id) props.map.select(id)
          }}
        >
          <Show
            when={rowIDs().length > 0}
            fallback={<div class="px-2 py-3 text-v2-text-text-faint [font-weight:440]">{emptyText()}</div>}
          >
            <For each={rowIDs()}>{(id) => renderRow(id)}</For>
          </Show>
        </div>
      </Show>
    </aside>
  )
}
