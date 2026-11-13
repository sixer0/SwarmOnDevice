import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { errorMessage } from "@/pages/layout/helpers"
import { replyHeld } from "@/utils/permission-reply"
import { showToast } from "@/utils/toast"
import type { AutonomyArchive, AutonomyArchiveEntry, AutonomySession } from "@opencode-ai/sdk/v2"
import { getToolInfo } from "@opencode-ai/session-ui/message-part"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { AccordionV2 } from "@opencode-ai/ui/v2/accordion-v2"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { SwarmController } from "../swarm/swarm-controller"
import { OverlapRow, SwarmAgents } from "../swarm/swarm-view"
import type { SwarmModel } from "../swarm/swarm-model"
import type { MissionControlMount } from "../swarm/mission-control"
import { offersAgentsView } from "../swarm/mission-control-layout"
import { shownPatterns } from "@/pages/home/agent-board-model"
import type { SessionMapController } from "./session-map-controller"
import {
  archiveCount,
  archiveEmptyInput,
  archiveShown,
  archiveSize,
  checkpointsOf,
  consentAllowInput,
  consentShown,
  consentTicked,
  decisionGroups,
  desktopNonce,
  formatDuration,
  heldAlways,
  heldCalls,
  historyOf,
  relativePath,
  reuseById,
  sendArchiveEmpty,
  sendCheckpointRevert,
  type ConsentItem,
  type ConsentList,
  type DecisionEntry,
  type DecisionNote,
  type HeldCall,
  type HistoryItem,
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
  irreversible: "session.map.decisions.category.irreversible",
  admin_rights: "session.map.decisions.category.admin_rights",
  outside_write_held: "session.map.decisions.category.outside_write_held",
  outside_write: "session.map.decisions.category.outside_write_held",
  system_service: "session.map.decisions.category.system_service",
  process_not_own: "session.map.decisions.category.process_not_own",
  unreadable_command: "session.map.decisions.category.unreadable_command",
  by_main_agent: "session.map.decisions.category.by_main_agent",
  delete_compound: "session.map.decisions.category.delete_compound",
  credential_change: "session.map.decisions.category.credential_change",
  protected_path: "session.map.decisions.category.protected_path",
  outside_edit: "session.map.decisions.category.outside_write_held",
  script_flagged: "session.map.decisions.category.script_flagged",
  script_unreadable: "session.map.decisions.category.script_flagged",
  archived: "session.map.decisions.category.archived",
  outward_not_in_mission: "session.permission.leavesMachine",
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
  bypass_on: "session.map.decisions.note.bypassOn",
  report: "session.map.decisions.note.report",
} satisfies Record<DecisionNote["note"], string>

// The first line of a decision in plain words: what was asked, what became of it, who decided and why.
const WHAT_LABEL = {
  bash: "session.map.decisions.what.bash",
  edit: "session.map.decisions.what.edit",
  write: "session.map.decisions.what.edit",
  apply_patch: "session.map.decisions.what.edit",
  read: "session.map.decisions.what.read",
  external_directory: "session.map.decisions.what.outside",
  webfetch: "session.map.decisions.what.web",
  websearch: "session.map.decisions.what.web",
} as const
const FILE_PERMISSIONS: readonly string[] = ["edit", "write", "apply_patch", "read"]
const SUBJECT_MAX = 80

const whatOf = (permission: string) =>
  permission in WHAT_LABEL ? WHAT_LABEL[permission as keyof typeof WHAT_LABEL] : "session.map.decisions.what.other"

// A file by its path in the project; anything else by its first line, cut short. Text only, as the agent wrote it.
const subjectOf = (entry: DecisionEntry) => {
  const first = shownPatterns(entry.patterns)[0]
  if (!first) return
  if (FILE_PERMISSIONS.includes(entry.permission)) return relativePath(first, entry.directory)
  const line = first.split("\n")[0] ?? ""
  return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX)}…` : line
}

const whoOf = (by: string | undefined) => {
  if (by === "person") return "memory.source.user"
  if (by === undefined) return "session.map.decisions.by.rules"
  return by.startsWith("main/") ? "session.map.decisions.by.mainAgent" : "session.map.decisions.by.model"
}

const RETRY_BASE_MS = 3000
const RETRY_LIMIT = 3
const REFRESH_DEBOUNCE_MS = 1000

// Patterns and reasons can come from an attacker. They stay JSX text: no Markdown, no links, nothing that parses them.
export function DecisionRow(props: {
  entry: DecisionEntry
  calls?: readonly HeldCall[]
  busy: boolean
  // Only for an entry the mode held whose call offered an "always" (row 258).
  canAlways?: boolean
  // Where History put it. Waiting is told by `onReply`; without either the entry reads as decided.
  kind?: "decided" | "limited"
  /**
   * Whether Details is shown, held by the list by entry id: the audit is read again about once a second while a run
   * is live, which draws every row anew, and a row's own state would close Details each time. Without it the row
   * holds its own.
   */
  details?: { open: boolean; toggle: () => void }
  onReply?: (reply: "once" | "always" | "reject") => void
  onUndo: () => void
}) {
  const language = useLanguage()
  const [own, setOwn] = createSignal(false)
  const open = () => (props.details ? props.details.open : own())
  const toggle = () => (props.details ? props.details.toggle() : setOwn(!own()))
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
  const subject = () => subjectOf(props.entry)
  const state = () => {
    if (props.onReply) return language.t("session.map.decisions.state.waiting")
    if (props.kind === "limited")
      return language.t(
        props.entry.stopped ? "session.map.decisions.state.stopped" : "session.map.decisions.state.refused",
      )
    const key = outcome()
    return language.t(key ?? "session.map.decisions.state.allowed")
  }
  // The main agent's answer for a subagent carries its own reason; everything else says why by its category.
  const why = () => {
    if (props.entry.via === "for_subagent") return props.entry.reason
    const key = category()
    return key ? language.t(key) : undefined
  }
  return (
    <div data-decision={props.entry.id} class="flex min-w-0 flex-col gap-1 rounded-[6px] px-2 py-1.5 leading-[18px]">
      {/* 1.2.7 U-5 (C6, D-11): the summary and Details scroll in a bounded body; the buttons stay below it. */}
      <div data-map-decision-body class="flex max-h-[min(50vh,320px)] min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain">
        <span data-decision-summary class="min-w-0 break-words text-v2-text-text-base [font-weight:440]">
          <span data-decision-what>
            {language.t(whatOf(props.entry.permission))}
            <Show when={subject()}>
              {(text) => (
                <>
                  {": "}
                  <span class="break-all font-mono text-[12px]">{text()}</span>
                </>
              )}
            </Show>
          </span>
          {" · "}
          <span data-decision-state>{state()}</span>
          {" · "}
          <span data-decision-who>{language.t(whoOf(props.entry.by))}</span>
          <Show when={why()}>
            {(text) => (
              <>
                {" · "}
                <span data-decision-why class="text-v2-text-text-muted">
                  {text()}
                </span>
              </>
            )}
          </Show>
        </span>
        <Show when={open()}>
          <div data-decision-details class="flex min-w-0 flex-col gap-1">
            <span class="text-v2-text-text-faint [font-weight:440]">{props.entry.permission}</span>
            <For each={shownPatterns(props.entry.patterns)}>
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
            <For each={props.entry.follows}>
              {(next) => (
                <span data-decision-follows class="flex min-w-0 flex-col">
                  <span class="text-v2-text-text-faint [font-weight:440]">{next.permission}</span>
                  <For each={shownPatterns(next.patterns)}>
                    {(pattern) => (
                      <span class="min-w-0 whitespace-pre-wrap break-all font-mono text-[12px] text-v2-text-text-base">
                        {pattern}
                      </span>
                    )}
                  </For>
                </span>
              )}
            </For>
            <For each={props.calls}>
              {(call) => (
                <span data-decision-call class="flex min-w-0 flex-col gap-1">
                  <span class="text-v2-text-text-faint [font-weight:440]">{call.tool}</span>
                  <For each={call.args}>
                    {(arg) => (
                      <span class="flex min-w-0 flex-col">
                        <span class="text-v2-text-text-faint [font-weight:440]">{arg.name}</span>
                        <span class="max-h-60 min-w-0 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[12px] text-v2-text-text-base">
                          {arg.value}
                        </span>
                      </span>
                    )}
                  </For>
                </span>
              )}
            </For>
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
          </div>
        </Show>
      </div>
      <span data-map-decision-actions class="mt-0.5 flex shrink-0 flex-wrap gap-1">
        <Show when={props.onReply}>
          {(reply) => (
            <>
              <ButtonV2 size="small" variant="contrast" disabled={props.busy} onClick={() => reply()("once")}>
                {language.t("session.movedOn.allow")}
              </ButtonV2>
              <Show when={props.canAlways}>
                <ButtonV2
                  data-decision-always
                  size="small"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => reply()("always")}
                >
                  {language.t("session.movedOn.alwaysInSession")}
                </ButtonV2>
              </Show>
              <ButtonV2 size="small" variant="ghost" disabled={props.busy} onClick={() => reply()("reject")}>
                {language.t("ui.permission.deny")}
              </ButtonV2>
            </>
          )}
        </Show>
        <Show when={props.entry.undo === "button"}>
          <ButtonV2 data-decision-undo size="small" variant="ghost" disabled={props.busy} onClick={props.onUndo}>
            {language.t("command.session.undo")}
          </ButtonV2>
        </Show>
        <ButtonV2
          data-decision-details-toggle
          size="small"
          variant="ghost-muted"
          aria-expanded={open()}
          onClick={toggle}
        >
          {language.t(open() ? "session.map.decisions.details.hide" : "session.map.decisions.details.show")}
        </ButtonV2>
      </span>
    </div>
  )
}

const CONSENT_KIND_LABEL = {
  secret: "session.review.flag.secret",
  sensitive: "session.review.flag.sensitive-path",
  outside: "settings.permissions.tool.external_directory.description",
  destination: "session.permission.leavesMachine",
} as const satisfies Record<ConsentItem["kind"], string>

// The consent list as one more waiting row: a tick per pattern, the files it covers as text, one button for the ticks.
export function ConsentRow(props: {
  list: ConsentList
  directory: string
  ticked: ReadonlySet<string>
  busy: boolean
  onTick: (id: string, value: boolean) => void
  onAllow: () => void
}) {
  const language = useLanguage()
  return (
    <div data-decision-consent class="flex min-w-0 flex-col gap-1 rounded-[6px] px-2 py-1.5 leading-[18px]">
      <span class="text-v2-text-text-base [font-weight:440]">{language.t("session.autonomy.consent.title")}</span>
      <For each={props.list.items}>
        {(item) => (
          <div data-consent-item={item.id} class="flex min-w-0 flex-col gap-0.5">
            <Checkbox
              checked={props.ticked.has(item.id)}
              disabled={item.given || props.busy}
              onChange={(value: boolean) => props.onTick(item.id, value)}
            >
              <span
                data-consent-pattern
                class="min-w-0 whitespace-pre-wrap break-all font-mono text-[12px] text-v2-text-text-base"
              >
                {item.pattern}
              </span>
            </Checkbox>
            <span class="flex flex-wrap gap-x-2 text-v2-text-text-faint [font-weight:440]">
              <span>{language.t(CONSENT_KIND_LABEL[item.kind])}</span>
              <Show when={item.named}>
                <span>{language.t("session.autonomy.consent.named")}</span>
              </Show>
            </span>
            <For each={item.files}>
              {(file) => (
                <span
                  data-consent-file
                  class="min-w-0 whitespace-pre-wrap break-all font-mono text-[12px] text-v2-text-text-muted"
                >
                  {relativePath(file, props.directory)}
                </span>
              )}
            </For>
          </div>
        )}
      </For>
      <Show when={props.list.dropped > 0}>
        <span class="font-mono text-[12px] text-v2-text-text-faint">…</span>
      </Show>
      <span class="mt-0.5 flex">
        <ButtonV2
          data-consent-allow
          size="small"
          variant="contrast"
          disabled={props.busy || !consentAllowInput("", props.list, props.ticked)}
          onClick={props.onAllow}
        >
          {language.t("session.autonomy.consent.allow")}
        </ButtonV2>
      </span>
    </div>
  )
}

// The archive as one more waiting row: how many paths and how much space, and the one way to delete them for good.
export function ArchiveRow(props: { archive: AutonomyArchive; busy: boolean; onEmpty: () => void }) {
  const language = useLanguage()
  return (
    <div data-decision-archive class="flex min-w-0 flex-col gap-1 rounded-[6px] px-2 py-1.5 leading-[18px]">
      <Show when={props.archive.entries.length > 0}>
        <span class="flex flex-wrap items-baseline gap-x-2">
          <span class="text-v2-text-text-base [font-weight:440]">
            {language.t("session.autonomy.archive.title", { count: archiveCount(props.archive) })}
          </span>
          <span data-archive-size class="text-v2-text-text-faint [font-weight:440]">
            {archiveSize(props.archive.bytes, language.intl())}
          </span>
        </span>
      </Show>
      <Show when={props.archive.unsafe}>
        <span data-archive-unsafe class="text-v2-state-fg-warning [font-weight:440]">
          {language.t("session.autonomy.archive.unsafe")}
        </span>
      </Show>
      <Show when={archiveEmptyInput("", props.archive.entries, props.archive.unsafe)}>
        <span class="mt-0.5 flex">
          <ButtonV2 data-archive-empty size="small" variant="ghost" disabled={props.busy} onClick={props.onEmpty}>
            {language.t("session.autonomy.archive.empty")}
          </ButtonV2>
        </span>
      </Show>
    </div>
  )
}

// Names every entry that goes, with the paths in it as text: what is listed here is exactly what is sent.
function DialogEmptyArchive(props: { entries: readonly AutonomyArchiveEntry[]; onConfirm: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <DialogV2 fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("session.autonomy.archive.empty")}
          description={language.t("session.autonomy.archive.confirm")}
        />
      </DialogHeader>
      <DialogBody class="flex max-h-[min(360px,calc(100vh-200px))] flex-col gap-2 overflow-y-auto px-4 pb-1">
        <For each={props.entries}>
          {(entry) => (
            <div data-archive-entry={entry.id} class="flex min-w-0 flex-col gap-0.5">
              <span class="flex flex-wrap gap-x-2 font-mono text-[12px]">
                <span class="text-v2-text-text-base">{entry.id}</span>
                <span class="text-v2-text-text-faint">{archiveSize(entry.bytes, language.intl())}</span>
              </span>
              <For each={entry.paths}>
                {(file) => (
                  <span
                    data-archive-path
                    class="min-w-0 whitespace-pre-wrap break-all font-mono text-[12px] text-v2-text-text-muted"
                  >
                    {file}
                  </span>
                )}
              </For>
              <Show when={entry.count > entry.paths.length}>
                <span class="font-mono text-[12px] text-v2-text-text-faint">…</span>
              </Show>
            </div>
          )}
        </For>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          data-archive-confirm
          variant="danger"
          onClick={() => {
            dialog.close()
            props.onConfirm()
          }}
        >
          {language.t("session.autonomy.archive.empty")}
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}

// Also the confirmation of a checkpoint's Revert (P-01c), with its own two labels.
function DialogUndoDecision(props: {
  onConfirm: () => void
  labels?: { action: "session.autonomy.checkpoint.revert"; description: "session.autonomy.checkpoint.confirm" }
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const action = () => language.t(props.labels?.action ?? "command.session.undo")
  return (
    <DialogV2 fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={action()}
          description={language.t(props.labels?.description ?? "session.map.decisions.undo.confirm")}
        />
      </DialogHeader>
      <DialogFooter>
        <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          data-decision-confirm
          variant="danger"
          onClick={() => {
            dialog.close()
            props.onConfirm()
          }}
        >
          {action()}
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
    // The generated type misses that the route answers null while there is no mission yet.
    consent: undefined as ConsentList | null | undefined,
    // Ticks the person changed, by item id. What they did not touch starts as the scan ticked it.
    ticks: {} as Record<string, boolean | undefined>,
    archive: undefined as AutonomyArchive | undefined,
    // Until the session's own update arrives, or for a child whose session was never read here.
    reverted: {} as Record<string, string | undefined>,
    // P-01c: what the last Revert of a checkpoint answered, by checkpoint id, until the panel moves to another root.
    revertResult: {} as Record<string, { preRevert: string } | { error: string } | undefined>,
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
  // A list that cannot be read leaves the decisions as they are: nothing on it is allowed until it can be.
  const loadConsent = (id: string) =>
    sdk()
      .client.autonomy.consent({ sessionID: id })
      .then((result) => {
        if (rootID() !== id) return
        const list = result.data?.consent as ConsentList | null | undefined
        if (list?.hash !== store.consent?.hash) setStore("ticks", {})
        setStore("consent", list ?? null)
      })
      .catch((cause) => {
        if (rootID() !== id) return
        setStore("consent", undefined)
        report("consent", cause)
      })
  const load = () => {
    const id = rootID()
    if (!id) return Promise.resolve()
    return Promise.all([
      sdk()
        .client.autonomy.session({ sessionID: id })
        .then((result) => {
          if (rootID() !== id) return
          setStore({ state: result.data, failed: false, attempts: 0 })
        })
        .catch((cause) => {
          if (rootID() !== id) return
          setStore("failed", true)
          report("load", cause)
        }),
      loadConsent(id),
      // An archive that cannot be read shows no row: nothing can be emptied from a list the person did not see.
      sdk()
        .client.autonomy.archive({ sessionID: id })
        .then((result) => {
          if (rootID() !== id) return
          setStore("archive", result.data)
        })
        .catch((cause) => {
          if (rootID() !== id) return
          setStore("archive", undefined)
          report("archive", cause)
        }),
    ]).then(() => undefined)
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
      setStore({
        state: undefined,
        failed: false,
        attempts: 0,
        cooling: false,
        consent: undefined,
        ticks: {},
        archive: undefined,
        revertResult: {},
      })
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
  // The open request as the server last sent it: its calls and the version of that list.
  const held = (entry: DecisionEntry) =>
    sessionData().permission[entry.sessionID]?.find((request) => request.id === entry.id)?.metadata
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
    calls: (entry: DecisionEntry) => heldCalls(held(entry)),
    canAlways: (entry: DecisionEntry) => heldAlways(held(entry)).length > 0,
    // Through the shared helper, which names the list version: an approval of an entry that grew without it is shown again.
    reply: (entry: DecisionEntry, reply: "once" | "always" | "reject") =>
      act(entry.id, "reply", () =>
        replyHeld(sdk().api, {
          request: { id: entry.id, sessionID: entry.sessionID, metadata: held(entry) ?? {} },
          reply,
          location: { directory: entry.directory },
        }),
      ),
    consent: createMemo(() => consentShown(store.consent)),
    ticked: () => {
      const list = store.consent
      return list ? consentTicked(list, store.ticks) : new Set<string>()
    },
    consentBusy: () => !!store.acting.consent,
    tick: (id: string, value: boolean) => setStore("ticks", id, value),
    allowConsent: () => {
      const id = rootID()
      const list = store.consent
      if (!id || !list) return
      const input = consentAllowInput(id, list, consentTicked(list, store.ticks))
      if (!input) return
      act("consent", "consent", () => sdk().client.autonomy.consentAllow(input))
    },
    archive: createMemo(() => archiveShown(store.archive)),
    archiveBusy: () => !!store.acting.archive,
    // The entries the confirmation listed, and no others: the server leaves anything moved in since.
    emptyArchive: (entries: readonly AutonomyArchiveEntry[]) => {
      const id = rootID()
      const input = id ? archiveEmptyInput(id, entries, !!store.archive?.unsafe) : undefined
      if (!input) return
      act("archive", "archive", () =>
        sendArchiveEmpty((body) => sdk().client.autonomy.archiveEmpty(body), desktopNonce, input),
      )
    },
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
    // P-01c: the one way to put a checkpoint back. The nonce is asked for on the click only.
    checkpointBusy: (id: string) => !!store.acting[`checkpoint:${id}`],
    checkpointResult: (id: string) => store.revertResult[id],
    revertCheckpoint: (id: string) => {
      const root = rootID()
      if (!root) return
      setStore("revertResult", id, undefined)
      act(`checkpoint:${id}`, "checkpoint", () =>
        sendCheckpointRevert((body) => sdk().client.autonomy.checkpointRevert(body), desktopNonce, root, id).then(
          (result) => setStore("revertResult", id, { preRevert: result.data?.preRevert ?? "" }),
          (cause) => {
            setStore("revertResult", id, { error: errorMessage(cause, language.t("common.requestFailed")) })
            throw cause
          },
        ),
      )
    },
  }
}

const CHECKPOINTS_SHOWN = 20

// What waits on the person: the consent list, the archive, then the held entries, oldest first.
function DecisionWaiting(props: {
  entries: readonly DecisionEntry[]
  decisions: ReturnType<typeof createDecisions>
  directory: string
  details: (id: string) => { open: boolean; toggle: () => void }
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const consent = () => props.decisions.consent()
  const archive = () => props.decisions.archive()
  const checkpoints = createMemo(() => checkpointsOf(props.decisions.store.state?.lines ?? []))
  // FX-13: the newest 20 by time are listed; the rest are counted on one plain line.
  const shownCheckpoints = createMemo(() => [...checkpoints()].sort((a, b) => b.at - a.at).slice(0, CHECKPOINTS_SHOWN))
  return (
    <section data-decision-group="waiting" class="flex flex-col">
      <Show when={consent()}>
        {(list) => (
          <ConsentRow
            list={list()}
            directory={props.directory}
            ticked={props.decisions.ticked()}
            busy={props.decisions.consentBusy()}
            onTick={props.decisions.tick}
            onAllow={props.decisions.allowConsent}
          />
        )}
      </Show>
      <Show when={archive()}>
        {(shown) => (
          <ArchiveRow
            archive={shown()}
            busy={props.decisions.archiveBusy()}
            onEmpty={() => {
              // A copy, so a refresh while the dialog is open cannot change what it lists or what is sent.
              const entries = shown().entries.map((entry) => ({ ...entry, paths: [...entry.paths] }))
              void dialog.show(() => (
                <DialogEmptyArchive entries={entries} onConfirm={() => props.decisions.emptyArchive(entries)} />
              ))
            }}
          />
        )}
      </Show>
      <Show when={checkpoints().length > 0}>
        <div data-decision-checkpoints class="flex min-w-0 flex-col gap-1 rounded-[6px] px-2 py-1.5 leading-[18px]">
          <span class="text-v2-text-text-base [font-weight:440]">
            {language.t("session.autonomy.checkpoint.title", { count: checkpoints().length })}
          </span>
          <For each={shownCheckpoints()}>
            {(item) => {
              const result = () => props.decisions.checkpointResult(item.id)
              const reverted = () => {
                const value = result()
                return item.reverted || (!!value && "preRevert" in value)
              }
              const failed = () => {
                const value = result()
                return value && "error" in value ? value.error : undefined
              }
              return (
                <div data-checkpoint={item.id} class="flex min-w-0 flex-col gap-0.5">
                  <span class="flex flex-wrap items-center gap-x-2">
                    <span class="min-w-0 break-all font-mono text-[12px] text-v2-text-text-muted">{item.id}</span>
                    <Show
                      when={!reverted()}
                      fallback={
                        <span data-checkpoint-reverted class="text-v2-text-text-faint [font-weight:440]">
                          {language.t("session.review.group.undone")}
                        </span>
                      }
                    >
                      <ButtonV2
                        data-checkpoint-revert
                        size="small"
                        variant="ghost"
                        disabled={props.decisions.checkpointBusy(item.id)}
                        onClick={() =>
                          void dialog.show(() => (
                            <DialogUndoDecision
                              labels={{
                                action: "session.autonomy.checkpoint.revert",
                                description: "session.autonomy.checkpoint.confirm",
                              }}
                              onConfirm={() => props.decisions.revertCheckpoint(item.id)}
                            />
                          ))
                        }
                      >
                        {language.t("session.autonomy.checkpoint.revert")}
                      </ButtonV2>
                    </Show>
                  </span>
                  <Show when={failed()}>
                    {(message) => (
                      <span data-checkpoint-error class="break-words text-v2-state-fg-warning [font-weight:440]">
                        {message()}
                      </span>
                    )}
                  </Show>
                </div>
              )
            }}
          </For>
          <Show when={checkpoints().length > CHECKPOINTS_SHOWN}>
            <span data-checkpoint-more class="text-v2-text-text-faint [font-weight:440]">
              {language.t("common.moreCountSuffix", { count: checkpoints().length - CHECKPOINTS_SHOWN }).trim()}
            </span>
          </Show>
        </div>
      </Show>
      <Show
        when={props.entries.length > 0 || consent() || archive() || checkpoints().length > 0}
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
              calls={props.decisions.calls(entry)}
              busy={props.decisions.replyBusy(entry)}
              canAlways={props.decisions.canAlways(entry)}
              details={props.details(entry.id)}
              onReply={(reply) => props.decisions.reply(entry, reply)}
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

// Everything decided, refused or noted, as one log, latest on top. One line each; the rest behind Details.
function DecisionHistory(props: {
  items: readonly HistoryItem[]
  decisions: ReturnType<typeof createDecisions>
  details: (id: string) => { open: boolean; toggle: () => void }
}) {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <section data-decision-group="history" class="flex flex-col">
      <Show
        when={props.items.length > 0}
        fallback={
          <div class="px-2 py-1 text-v2-text-text-faint [font-weight:440]">
            {language.t("session.map.filter.empty")}
          </div>
        }
      >
        <For each={props.items}>
          {(item) => (
            <Switch>
              <Match when={item.kind === "note" ? item.note : undefined}>
                {(note) => (
                  <div data-decision-note class="px-2 py-1 text-v2-text-text-faint [font-weight:440]">
                    {language.t(NOTE_LABEL[note().note])}
                  </div>
                )}
              </Match>
              <Match when={item.kind !== "note" ? item : undefined}>
                {(row) => (
                  <DecisionRow
                    entry={row().entry}
                    kind={row().kind}
                    details={props.details(row().entry.id)}
                    busy={props.decisions.undoBusy(row().entry)}
                    onUndo={() =>
                      void dialog.show(() => <DialogUndoDecision onConfirm={() => props.decisions.undo(row().entry)} />)
                    }
                  />
                )}
              </Match>
            </Switch>
          )}
        </For>
      </Show>
    </section>
  )
}

// Exported for the render test, which drives it with a stand-in for `createDecisions`.
export function DecisionList(props: { decisions: ReturnType<typeof createDecisions>; directory: string }) {
  const language = useLanguage()
  const store = () => props.decisions.store
  // Reuses the previous item for an unchanged id (review P6), so a refresh draws only new or changed History rows.
  const history = createMemo<HistoryItem[]>((previous) => {
    const groups = props.decisions.groups()
    return groups ? reuseById(previous, historyOf(groups)) : []
  }, [])
  // The same for the Waiting rows: an unchanged entry keeps its row across a refresh.
  const waiting = createMemo<DecisionEntry[]>((previous) => {
    const groups = props.decisions.groups()
    return groups ? reuseById(previous, groups.waiting) : []
  }, [])
  // Outside the rows, by entry id, so a re-read of the audit (new row objects) leaves Details as the person left it.
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
  const details = (id: string) => ({
    get open() {
      return expanded[id] === true
    },
    toggle: () => setExpanded(id, !expanded[id]),
  })
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
          <AccordionV2 multiple collapsible defaultValue={["waiting"]}>
            <AccordionV2.Item value="waiting" data-decision-section="waiting">
              <AccordionV2.Header>
                <AccordionV2.Trigger>
                  <span class="min-w-0 flex-1">{language.t("session.map.decisions.group.waiting")}</span>
                  <span data-decision-count class="text-v2-text-text-faint">
                    {groups().waiting.length}
                  </span>
                </AccordionV2.Trigger>
              </AccordionV2.Header>
              <AccordionV2.Content>
                <DecisionWaiting
                  entries={waiting()}
                  decisions={props.decisions}
                  directory={props.directory}
                  details={details}
                />
              </AccordionV2.Content>
            </AccordionV2.Item>
            <AccordionV2.Item value="history" data-decision-section="history">
              <AccordionV2.Header>
                <AccordionV2.Trigger>
                  <span class="min-w-0 flex-1">{language.t("session.map.decisions.group.history")}</span>
                  <span data-decision-count class="text-v2-text-text-faint">
                    {history().length}
                  </span>
                </AccordionV2.Trigger>
              </AccordionV2.Header>
              <AccordionV2.Content>
                <DecisionHistory items={history()} decisions={props.decisions} details={details} />
              </AccordionV2.Content>
            </AccordionV2.Item>
          </AccordionV2>
        )}
      </Show>
    </div>
  )
}

export function SessionMapPanel(props: {
  map: SessionMapController
  swarm: SwarmController
  /** row 133: mission control inside the Agents view */
  missions?: MissionControlMount
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
  // 1.2.7 U-3: the last swarm model read for this run. The model is only built while a swarm view is on screen, so the
  // "Shared files" entry keeps the count it last saw while the person looks at another view of the strip.
  const swarmSeen = createMemo<{ root?: string; model?: SwarmModel }>(
    (previous) => {
      const root = props.swarm.rootID()
      const model = props.swarm.model()
      if (model) return { root, model }
      return previous.root === root ? previous : { root }
    },
    {},
  )
  const sharedCount = () => swarmSeen().model?.overlaps.length ?? 0
  const filters = createMemo<{ id: MapFilter; label: string; count?: number; tone?: "danger" | "warning" }[]>(() => [
    { id: "all", label: language.t("session.map.filter.all") },
    {
      id: "problems",
      label: language.t("session.map.filter.problems"),
      count: counts().problems,
      tone: "danger",
    },
    { id: "edits", label: language.t("session.map.filter.edits"), count: props.map.model().files.length },
    // 1.2.7 U-3 (C6): files more than one agent changed, a conditional entry like Agents and Decisions.
    ...(sharedCount() > 0
      ? [
          {
            id: "shared" as const,
            label: language.t("session.map.filter.shared"),
            count: sharedCount(),
            tone: "warning" as const,
          },
        ]
      : []),
    // Row 133 (C127): a one-agent session with a mission still reaches mission control.
    ...(offersAgentsView(props.swarm.pulse().agents, props.missions?.control.state.options.length ?? 0)
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
  const showingShared = () => props.map.view.filter === "shared"
  // 1.2.7 U-3: with no shared file left the entry goes away, and the view returns to All.
  createEffect(() => {
    if (showingShared() && sharedCount() === 0) props.map.setFilter("all")
  })
  // Row 133b (C175): the expand toggle in mission control's header widens THIS pane (no new panel). The remembered
  // choice only applies while mission control is on screen; every other view keeps the 372 px pane.
  const missionShown = () => showingAgents() && (props.missions?.control.state.options.length ?? 0) > 0
  const wide = () => props.map.wide() && missionShown()
  const missionMount = createMemo(
    () =>
      props.missions && {
        ...props.missions,
        expand: { wide: props.map.wide, toggle: () => props.map.setWide(!props.map.wide()) },
      },
  )
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
      data-activity-wide={wide() ? "" : undefined}
      class="absolute inset-y-0 right-0 z-[70] flex h-full shrink-0 flex-col gap-2 border-l border-v2-border-border-base bg-v2-background-bg-base pt-2 shadow-[var(--v2-elevation-raised)] @[900px]:static @[900px]:shadow-none"
      classList={{
        "w-[min(372px,100%)] @[900px]:w-[372px]": !wide(),
        // Wide: at most 1100 px and 70 % of the window, and the chat keeps at least 280 px beside the pane.
        "w-[min(1100px,100%)] @[900px]:w-[min(1100px,70vw,calc(100%-280px))]": wide(),
      }}
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
        when={!showingAgents() && !showingDecisions() && !showingShared()}
        fallback={
          showingAgents() ? (
            <SwarmAgents swarm={props.swarm} missions={missionMount()} />
          ) : showingShared() ? (
            <div data-scrollable class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
              <Show when={swarmSeen().model}>
                {(model) => (
                  <Index each={model().overlaps}>
                    {(overlap) => <OverlapRow swarm={props.swarm} overlap={overlap()} model={model()} />}
                  </Index>
                )}
              </Show>
            </div>
          ) : (
            <DecisionList decisions={decisions} directory={props.directory} />
          )
        }
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
