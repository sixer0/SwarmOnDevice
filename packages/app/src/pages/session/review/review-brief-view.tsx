import { useLanguage } from "@/context/language"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DiffChanges } from "@opencode-ai/ui/v2/diff-changes-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { getFilename } from "@opencode-ai/core/util/path"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Persist, persisted } from "@/utils/persist"
import { createStore } from "solid-js/store"
import { formatDuration } from "../map/session-map-model"
import type { ReviewBriefController } from "./review-brief-controller"
import type {
  BriefFile,
  BriefGroupID,
  BriefHeadline,
  BriefTone,
  EvidenceRow,
  FileMark,
  Flag,
  Severity,
} from "./review-brief-model"

const TONE_DOT: Record<BriefTone, string> = {
  critical: "bg-v2-state-fg-danger",
  warning: "bg-v2-state-fg-warning",
  ok: "bg-v2-state-fg-success",
  neutral: "bg-v2-border-border-strong",
}
const SEVERITY_TEXT: Record<Severity, string> = {
  high: "text-v2-state-fg-danger",
  medium: "text-v2-state-fg-warning",
  low: "text-v2-text-text-muted",
}
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-v2-border-border-strong"

function useAgo() {
  const language = useLanguage()
  return (at: number) => {
    const ms = Date.now() - at
    if (ms < 60_000) return language.t("session.review.ago.now")
    return language.t("session.review.ago", { time: formatDuration(ms) })
  }
}

function useHeadline(brief: ReviewBriefController) {
  const language = useLanguage()
  return (headline: BriefHeadline) => {
    switch (headline.key) {
      case "working":
        return language.t("session.review.headline.working")
      case "failed":
        return language.t("session.review.headline.failed", { command: headline.command })
      case "claim":
        return language.t("session.review.headline.claim", { check: brief.kindName(headline.kind) })
      case "stale":
        return language.t("session.review.headline.stale", { count: headline.count })
      case "hidden":
        return language.t("session.review.headline.hidden", { command: headline.command })
      case "unchecked":
        return language.t("session.review.headline.unchecked")
      case "flags":
        return language.t("session.review.headline.flags", { count: headline.count })
      case "clear":
        return language.t("session.review.headline.clear")
      case "elsewhere":
        return language.t("session.review.evidence.elsewhere", { count: headline.count })
      case "history":
        return language.t("session.review.headline.history")
    }
  }
}

// ---- The strip above the panel: can this be trusted, and what can be done about it ------------------------------------

export function ReviewBriefStrip(props: { brief: ReviewBriefController }) {
  const language = useLanguage()
  const headline = useHeadline(props.brief)
  const brief = () => props.brief.brief()
  // The headline already says what matters; the evidence behind it is one click away.
  const [prefs, setPrefs] = persisted(Persist.global("review-brief"), createStore({ evidence: false }))
  const open = () => prefs.evidence && brief().evidence.length > 0
  const allDecided = () => brief().progress.total > 0 && brief().progress.ok === brief().progress.total
  // Only files that are not this run's are left: nothing to count, and committing them is not this panel's business.
  const settled = () => brief().headline.key === "elsewhere"

  return (
    <section
      data-component="review-brief"
      data-history-complete={props.brief.historyComplete() ? "" : undefined}
      class="shrink-0 border-b border-v2-border-border-base bg-v2-background-bg-base"
      aria-label={language.t("session.review.brief.label")}
    >
      <div class="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <button
          type="button"
          class={`flex min-w-0 flex-1 basis-60 items-center gap-2 rounded-md text-start ${FOCUS_RING}`}
          aria-expanded={open()}
          disabled={brief().evidence.length === 0}
          onClick={() => setPrefs("evidence", (value) => !value)}
        >
          <Show
            when={props.brief.running()}
            fallback={<span class={`size-2 shrink-0 rounded-full ${TONE_DOT[brief().tone]}`} />}
          >
            <Spinner class="size-3 shrink-0 text-v2-text-text-muted" />
          </Show>
          <span class="min-w-0 text-13-medium text-v2-text-text-base" data-review-headline={brief().headline.key}>
            {headline(brief().headline)}
          </span>
          <Show when={brief().evidence.length > 0}>
            <span class="shrink-0 text-v2-text-text-faint" classList={{ "rotate-180": open() }}>
              <Icon name="chevron-down" />
            </span>
          </Show>
        </button>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={!settled()}>
            <span class="text-12-regular text-v2-text-text-muted">
              {language.t("session.review.progress", { done: brief().progress.ok, total: brief().progress.total })}
            </span>
          </Show>
          <Show when={brief().sendable}>
            <ButtonV2 size="small" variant="contrast" onClick={props.brief.sendBack}>
              {language.t("session.review.action.sendBack")}
              <Show when={brief().progress.work > 0}>{` (${brief().progress.work})`}</Show>
            </ButtonV2>
          </Show>
          <Show when={props.brief.canLand() && !props.brief.landing() && !settled()}>
            <ButtonV2
              size="small"
              data-review-land
              variant={allDecided() && !brief().sendable ? "contrast" : "outline"}
              onClick={() => props.brief.openLanding()}
            >
              {language.t("session.review.action.land")}
            </ButtonV2>
          </Show>
        </div>
      </div>
      <Show when={props.brief.historyFailed()}>
        <div
          class="flex min-h-7 flex-wrap items-center gap-2 border-t border-v2-border-border-base px-3 py-1 text-12-regular text-v2-text-text-base"
          role="alert"
        >
          <span class="size-1.5 shrink-0 rounded-full bg-v2-state-fg-warning" />
          <span class="min-w-0">{language.t("session.review.history.failed")}</span>
          <button
            type="button"
            class={`shrink-0 rounded text-v2-text-text-muted underline-offset-2 enabled:hover:text-v2-text-text-base enabled:hover:underline disabled:opacity-50 ${FOCUS_RING}`}
            disabled={!props.brief.canRetryHistory()}
            onClick={props.brief.retryHistory}
          >
            {props.brief.historyCooldown() > 0
              ? language.t("session.review.history.retryIn", { seconds: props.brief.historyCooldown() })
              : language.t("session.review.history.retry")}
          </button>
        </div>
      </Show>
      <Show when={open()}>
        <ul class="flex max-h-44 flex-col overflow-y-auto border-t border-v2-border-border-base px-3 py-1">
          <For each={brief().evidence}>{(row) => <EvidenceItem brief={props.brief} row={row} />}</For>
        </ul>
      </Show>
      <Show when={props.brief.landing() && props.brief.canLand()}>
        <ReviewLanding brief={props.brief} />
      </Show>
    </section>
  )
}

// ---- Landing: one message, the files it covers, and the click that commits ----------------------------------------------

function ReviewLanding(props: { brief: ReviewBriefController }) {
  const language = useLanguage()
  const brief = () => props.brief.brief()
  const words = useFlagWords(props.brief)
  const count = () => props.brief.included().size
  const stayingOut = (file: BriefFile) => {
    if (file.mark === "work") return language.t("session.review.action.needsWork")
    if (file.group === "elsewhere") return language.t("session.review.group.elsewhere")
    return words(file)
  }
  return (
    <form
      data-component="review-landing"
      class="flex flex-col gap-2 border-t border-v2-border-border-base px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        void props.brief.land()
      }}
    >
      <textarea
        ref={(el) => queueMicrotask(() => el.focus({ preventScroll: true }))}
        data-review-land-message
        aria-label={language.t("session.review.land.message")}
        rows={10}
        spellcheck={false}
        class="max-h-72 min-h-24 w-full resize-y rounded-md [field-sizing:content] border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1.5 font-mono text-12-regular text-v2-text-text-base outline-none focus:border-v2-border-border-strong"
        value={props.brief.message()}
        onInput={(event) => props.brief.setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            props.brief.closeLanding()
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void props.brief.land()
          }
        }}
      />
      <Show when={props.brief.landError()}>
        {(error) => (
          <pre
            role="alert"
            data-review-land-error
            class="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-v2-overlay-simple-overlay-hover px-2 py-1.5 font-mono text-11-regular text-v2-state-fg-danger"
          >
            {error()}
          </pre>
        )}
      </Show>
      <Show when={props.brief.landingFiles()}>
        <ul class="flex max-h-40 flex-col overflow-y-auto" data-review-land-files>
          <For each={brief().files}>
            {(file) => (
              <li>
                <label class="flex min-h-6 min-w-0 cursor-pointer items-center gap-2 text-12-regular text-v2-text-text-base">
                  <input
                    type="checkbox"
                    data-review-land-file={file.file}
                    checked={props.brief.included().has(file.file)}
                    onChange={(event) => props.brief.pick(file.file, event.currentTarget.checked)}
                  />
                  <span class="min-w-0 truncate" title={file.file}>
                    {file.file}
                  </span>
                  <Show when={!props.brief.included().has(file.file) && stayingOut(file)}>
                    {(reason) => <span class="shrink-0 text-11-regular text-v2-text-text-muted">{reason()}</span>}
                  </Show>
                </label>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          data-review-land-toggle
          aria-expanded={props.brief.landingFiles()}
          class={`flex items-center gap-0.5 rounded text-12-regular text-v2-text-text-muted hover:text-v2-text-text-base ${FOCUS_RING}`}
          onClick={props.brief.toggleLandingFiles}
        >
          {language.t("session.review.land.files", {
            included: count(),
            total: brief().files.length,
            branch: props.brief.branch(),
          })}
          <Icon name="chevron-down" class={props.brief.landingFiles() ? "rotate-180" : undefined} />
        </button>
        <Show when={props.brief.writing()}>
          <span class="flex items-center gap-1 text-12-regular text-v2-text-text-faint" data-review-land-writing>
            <Spinner class="size-3" />
            {language.t("session.review.land.writing")}
          </span>
        </Show>
        <div class="ms-auto flex items-center gap-2">
          <ButtonV2 size="small" type="button" variant="ghost-muted" onClick={props.brief.closeLanding}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            size="small"
            type="submit"
            variant="contrast"
            data-review-land-commit
            disabled={count() === 0 || !props.brief.message().trim() || props.brief.committing()}
          >
            {language.t("session.review.action.land")}
          </ButtonV2>
        </div>
      </div>
    </form>
  )
}

/** Stays after the last file has left the panel: this is the moment to tell someone. */
export function ReviewLanded(props: { brief: ReviewBriefController }) {
  const language = useLanguage()
  return (
    <Show when={props.brief.landed()}>
      {(landed) => (
        <div
          data-component="review-landed"
          role="status"
          class="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-v2-border-border-base px-3 py-1.5"
        >
          <span class="shrink-0 text-v2-state-fg-success">
            <Icon name="check" />
          </span>
          <span class="min-w-0 flex-1 basis-60 text-13-medium text-v2-text-text-base" data-review-landed>
            {landed().headline}
          </span>
          <ButtonV2 size="small" variant="outline" data-review-landed-copy onClick={() => void props.brief.copyUpdate()}>
            {props.brief.copied() ? language.t("session.review.land.copied") : language.t("session.review.land.copy")}
          </ButtonV2>
          <button
            type="button"
            aria-label={language.t("common.close")}
            class={`flex size-6 shrink-0 items-center justify-center rounded text-v2-text-text-muted hover:text-v2-text-text-base ${FOCUS_RING}`}
            onClick={props.brief.dismissLanded}
          >
            <Icon name="xmark-small" />
          </button>
        </div>
      )}
    </Show>
  )
}

function EvidenceItem(props: { brief: ReviewBriefController; row: EvidenceRow }) {
  const language = useLanguage()
  const ago = useAgo()
  const tone = (): BriefTone => {
    const row = props.row
    if (row.type === "claim") return "critical"
    if (row.type === "check") {
      if (row.status === "failed") return "critical"
      if (row.status === "passed") return row.run.partial ? "warning" : "ok"
      if (row.status === "running") return "neutral"
      return "warning"
    }
    if (row.type === "elsewhere") return "neutral"
    return "warning"
  }
  const text = () => {
    const row = props.row
    if (row.type === "check") {
      const check = props.brief.kindName(row.kind)
      const status = row.status
      if (status === "stale")
        return language.t("session.review.evidence.stale", { check, count: row.editedAfter.length })
      if (status === "passed" && row.run.partial) return language.t("session.review.evidence.partial", { check })
      if (status === "failed" && row.run.exit === undefined) return language.t("session.review.headline.failed", { command: row.run.command })
      return language.t(`session.review.evidence.${status}`, { check, exit: row.run.exit ?? "" })
    }
    if (row.type === "none") {
      return language.t("session.review.evidence.none", {
        checks: row.kinds.map((kind) => props.brief.kindName(kind)).join(", "),
      })
    }
    if (row.type === "claim") {
      return language.t(
        row.against === "failed" ? "session.review.evidence.claim.failed" : "session.review.evidence.claim.none",
        {
          quote: row.claim.quote,
        },
      )
    }
    if (row.type === "untested") return language.t("session.review.evidence.untested", { count: row.files.length })
    return language.t("session.review.evidence.elsewhere", { count: row.files.length })
  }
  const run = () => {
    const row = props.row
    if (row.type === "check") return row.run
    if (row.type === "claim") return row.run
    return undefined
  }
  const offerRerun = () => {
    const row = props.row
    return row.type === "check" && row.status !== "passed" && row.status !== "running"
  }
  return (
    <li class="flex min-h-7 flex-wrap items-center gap-x-2 text-12-regular">
      <span class={`size-1.5 shrink-0 rounded-full ${TONE_DOT[tone()]}`} />
      <span class="min-w-0 text-v2-text-text-base" data-review-evidence={props.row.type}>
        {text()}
      </span>
      <Show when={run()}>
        {(item) => (
          <>
            <code
              class="min-w-0 max-w-64 truncate font-mono text-11-regular text-v2-text-text-muted"
              title={item().command}
            >
              {item().command}
            </code>
            <span class="shrink-0 text-v2-text-text-faint">{ago(item().at)}</span>
            <button
              type="button"
              class={`shrink-0 rounded text-v2-text-text-muted underline-offset-2 hover:text-v2-text-text-base hover:underline ${FOCUS_RING}`}
              onClick={() => props.brief.openStep(item().sessionID, item().step)}
            >
              {language.t("session.review.action.show")}
            </button>
            <Show when={offerRerun() && item().command}>
              <button
                type="button"
                class={`shrink-0 rounded text-v2-text-text-muted underline-offset-2 enabled:hover:text-v2-text-text-base enabled:hover:underline disabled:opacity-50 ${FOCUS_RING}`}
                disabled={!props.brief.canRerun(item().command)}
                title={item().command}
                onClick={() => void props.brief.rerun(item().command)}
              >
                {props.brief.rerunning() === item().command
                  ? language.t("session.review.action.rerunning")
                  : language.t("session.review.action.rerun")}
              </button>
            </Show>
          </>
        )}
      </Show>
    </li>
  )
}

// ---- The queue ---------------------------------------------------------------------------------------------------------

function MarkGlyph(props: { mark: FileMark }) {
  return (
    <span class="flex size-3.5 shrink-0 items-center justify-center" data-review-mark={props.mark}>
      <Switch fallback={<span class="size-2 rounded-full border border-v2-border-border-strong" />}>
        <Match when={props.mark === "ok"}>
          <span class="text-v2-state-fg-success">
            <Icon name="check" />
          </span>
        </Match>
        <Match when={props.mark === "work"}>
          <span class="text-v2-state-fg-danger">
            <Icon name="xmark-small" />
          </span>
        </Match>
        <Match when={props.mark === "changed"}>
          <span class="size-2 rounded-full bg-v2-state-fg-warning" />
        </Match>
      </Switch>
    </span>
  )
}

function useFlagWords(brief: ReviewBriefController) {
  const language = useLanguage()
  return (item: BriefFile) => {
    if (item.mark === "changed") return language.t("session.review.mark.changed")
    if (item.flags.length > 0)
      return brief.flagLabel(item.flags[0]) + (item.flags.length > 1 ? ` +${item.flags.length - 1}` : "")
    if (item.trait) return language.t(`session.review.trait.${item.trait}`)
    return undefined
  }
}

export function ReviewQueue(props: {
  brief: ReviewBriefController
  active?: string
  onSelect: (file: string) => void
}) {
  const language = useLanguage()
  const words = useFlagWords(props.brief)
  const brief = () => props.brief.brief()
  // Formatting, lockfiles, generated files and docs are the part nobody has to read to decide. They wait until asked.
  const [skimOpen, setSkimOpen] = createSignal(false)
  return (
    <div class="flex flex-col gap-2 pb-2" data-component="review-queue">
      <For each={brief().groups}>
        {(group) => {
          const open = createMemo(() =>
            group.files.filter((file) => {
              const mark = brief().byFile.get(file)?.mark
              return mark === "none" || mark === "changed"
            }),
          )
          const folded = () => group.id === "skim" && !skimOpen() && !group.files.includes(props.active ?? "")
          return (
            <section aria-label={language.t(`session.review.group.${group.id}`)}>
              <div class="flex h-6 items-center gap-1.5 px-2">
                <Show
                  when={group.id === "skim"}
                  fallback={
                    <span class="min-w-0 truncate text-12-medium text-v2-text-text-muted">
                      {language.t(`session.review.group.${group.id}`)}
                    </span>
                  }
                >
                  <button
                    type="button"
                    data-review-skim
                    aria-expanded={!folded()}
                    class={`flex min-w-0 items-center gap-0.5 rounded text-12-medium text-v2-text-text-muted hover:text-v2-text-text-base ${FOCUS_RING}`}
                    onClick={() => setSkimOpen(folded())}
                  >
                    <span class="min-w-0 truncate">{language.t(`session.review.group.${group.id}`)}</span>
                    <Icon name="chevron-down" class={folded() ? "-rotate-90" : undefined} />
                  </button>
                </Show>
                <span class="text-11-regular text-v2-text-text-faint">{group.files.length}</span>
                <Show when={!folded() && groupOffersAll(group.id) && open().length > 1}>
                  <button
                    type="button"
                    class={`ms-auto rounded text-11-regular text-v2-text-text-muted underline-offset-2 hover:text-v2-text-text-base hover:underline ${FOCUS_RING}`}
                    onClick={() => props.brief.decideGroup(open())}
                  >
                    {language.t("session.review.action.markAll")}
                  </button>
                </Show>
              </div>
              <For each={folded() ? [] : group.files}>
                {(file) => {
                  const item = () => brief().byFile.get(file)
                  return (
                    <Show when={item()}>
                      {(row) => (
                        <button
                          type="button"
                          data-review-file={file}
                          aria-current={props.active === file ? "true" : undefined}
                          class={`flex w-full items-start gap-1.5 px-2 py-1 text-start hover:bg-v2-overlay-simple-overlay-hover aria-[current]:bg-v2-overlay-simple-overlay-hover aria-[current]:[box-shadow:inset_2px_0_0_0_var(--v2-text-text-muted)] ${FOCUS_RING}`}
                          classList={{ "opacity-60": row().mark === "ok" }}
                          onClick={() => props.onSelect(file)}
                        >
                          <span class="mt-[3px]">
                            <MarkGlyph mark={row().mark} />
                          </span>
                          <span class="min-w-0 flex-1">
                            <span class="flex items-center gap-1.5">
                              <span class="min-w-0 truncate text-12-regular text-v2-text-text-base" title={file}>
                                {getFilename(file)}
                              </span>
                              <span class="ms-auto shrink-0">
                                <DiffChanges changes={row()} />
                              </span>
                            </span>
                            <Show when={words(row())}>
                              {(label) => (
                                <span
                                  class={`block truncate text-11-regular ${row().mark === "changed" ? SEVERITY_TEXT.medium : row().flags[0] ? SEVERITY_TEXT[row().flags[0].severity] : "text-v2-text-text-faint"}`}
                                >
                                  {label()}
                                </span>
                              )}
                            </Show>
                          </span>
                        </button>
                      )}
                    </Show>
                  )
                }}
              </For>
            </section>
          )
        }}
      </For>
      <Show when={props.brief.undone().length > 0}>
        <section aria-label={language.t("session.review.group.undone")}>
          <div class="flex h-6 items-center px-2 text-12-medium text-v2-text-text-muted">
            {language.t("session.review.group.undone")}
          </div>
          <For each={props.brief.undone()}>
            {(entry) => (
              <div class="flex items-center gap-1.5 px-2 py-1">
                <span
                  class="min-w-0 flex-1 truncate text-12-regular text-v2-text-text-muted line-through"
                  title={entry.file}
                >
                  {getFilename(entry.file)}
                </span>
                <button
                  type="button"
                  class={`shrink-0 rounded text-11-regular text-v2-text-text-muted underline-offset-2 hover:text-v2-text-text-base hover:underline ${FOCUS_RING}`}
                  onClick={() => void props.brief.restore(entry)}
                >
                  {language.t("session.review.action.restore")}
                </button>
              </div>
            )}
          </For>
        </section>
      </Show>
    </div>
  )
}

const groupOffersAll = (id: BriefGroupID) => id === "skim" || id === "elsewhere"

// ---- One file: why it changed, what to look at, what to do ------------------------------------------------------------

/** One line: the first thing to look at in this file. Why it changed, every other flag and Undo are one click away. */
export function ReviewFileBanner(props: { brief: ReviewBriefController; file: string }) {
  const language = useLanguage()
  const item = createMemo(() => props.brief.brief().byFile.get(props.file))
  const firstTouch = () => item()?.touches.at(0)
  const lastTouch = () => item()?.touches.at(-1)
  const canUndo = () => {
    const row = item()
    return !!row && (props.brief.canUndo(row) || confirming())
  }
  const confirming = () => props.brief.pendingUndo() === props.file
  const [expanded, setExpanded] = createSignal(false)
  const open = () => expanded() || confirming()
  const shownFlags = () => (open() ? (item()?.flags ?? []) : (item()?.flags.slice(0, 1) ?? []))

  return (
    <Show when={item()}>
      {(row) => (
        <div
          data-component="review-file-banner"
          class="flex shrink-0 flex-col gap-0.5 border-b border-v2-border-border-base px-3 py-1"
        >
          <Show when={open() || row().flags.length === 0}>
            <div class="flex min-h-6 min-w-0 items-center gap-1.5 text-12-regular text-v2-text-text-muted">
              <Show
                when={firstTouch()}
                fallback={
                  <span class="min-w-0 flex-1 truncate text-v2-text-text-faint">
                    {language.t("session.review.why.unknown")}
                  </span>
                }
              >
                {(touch) => (
                  <span class="min-w-0 flex-1 truncate" title={touch().prompt}>
                    <Show when={touch().prompt}>
                      {(prompt) => language.t("session.review.why.prompt", { prompt: oneLine(prompt()) })}
                    </Show>
                  </span>
                )}
              </Show>
              <Show when={open() && row().touches.length > 1}>
                <span class="shrink-0 text-v2-text-text-faint">
                  {language.t("session.review.why.edits", { count: row().touches.length })}
                </span>
              </Show>
              <Show when={lastTouch()?.step}>
                {(step) => (
                  <button
                    type="button"
                    class={`shrink-0 rounded underline-offset-2 hover:text-v2-text-text-base hover:underline ${FOCUS_RING}`}
                    onClick={() => props.brief.openStep(lastTouch()!.sessionID, step())}
                  >
                    {language.t("session.review.action.show")}
                  </button>
                )}
              </Show>
              <Show when={canUndo() && (open() || row().flags.length === 0)}>
                <ButtonV2
                  size="small"
                  data-review-undo
                  variant={confirming() ? "danger" : "ghost-muted"}
                  disabled={props.brief.undoing()}
                  onClick={() => void props.brief.undo(row().file)}
                >
                  {confirming()
                    ? language.t("session.review.action.undoConfirm")
                    : language.t("session.review.action.undo")}
                </ButtonV2>
              </Show>
            </div>
          </Show>
          <Show when={row().flags.length > 0}>
            <div class="flex min-w-0 items-start gap-1">
              <ul class="flex max-h-30 min-w-0 flex-1 flex-col overflow-y-auto">
                <For each={shownFlags()}>{(flag) => <FlagRow brief={props.brief} file={props.file} flag={flag} />}</For>
              </ul>
              <button
                type="button"
                data-review-banner-more
                aria-expanded={open()}
                aria-label={language.t(open() ? "prompt.preflight.collapse" : "prompt.preflight.expand")}
                class={`flex h-6 shrink-0 items-center gap-0.5 rounded text-12-regular tabular-nums text-v2-text-text-faint hover:text-v2-text-text-base ${FOCUS_RING}`}
                onClick={() => setExpanded((value) => !value)}
              >
                <Show when={!open() && row().flags.length > 1}>+{row().flags.length - 1}</Show>
                <Icon name="chevron-down" class={open() ? "rotate-180" : undefined} />
              </button>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}

export function ReviewFileActions(props: { brief: ReviewBriefController; file?: string }) {
  const language = useLanguage()
  const item = createMemo(() => (props.file ? props.brief.brief().byFile.get(props.file) : undefined))
  return (
    <Show when={item()}>
      {(row) => (
        <div
          class="ms-1 flex min-w-0 flex-wrap items-center gap-1 whitespace-nowrap"
          data-component="review-file-actions"
        >
          <ButtonV2
            size="small"
            variant={row().mark === "ok" ? "neutral" : "outline"}
            aria-pressed={row().mark === "ok"}
            onClick={() => props.brief.decide(row().file, "ok")}
          >
            {language.t("session.review.action.ok")}
          </ButtonV2>
          <ButtonV2
            size="small"
            variant={row().mark === "work" ? "danger" : "ghost-muted"}
            aria-pressed={row().mark === "work"}
            onClick={() => props.brief.decide(row().file, "work")}
          >
            {language.t("session.review.action.needsWork")}
          </ButtonV2>
        </div>
      )}
    </Show>
  )
}

function FlagRow(props: { brief: ReviewBriefController; file: string; flag: Flag }) {
  const language = useLanguage()
  const first = () => props.flag.lines[0]
  const [cursor, setCursor] = createSignal(0)
  const go = () => {
    const lines = props.flag.lines
    if (lines.length === 0) return
    const index = cursor() % lines.length
    props.brief.jumpLine(props.file, lines[index].line, lines[index].side)
    setCursor(index + 1)
  }
  return (
    <li class="flex min-h-6 min-w-0 items-center gap-2 text-12-regular">
      <span class={`shrink-0 ${SEVERITY_TEXT[props.flag.severity]}`}>
        {props.brief.flagLabel(props.flag)}
        <Show when={props.flag.detail}>{(detail) => `: ${detail()}`}</Show>
      </span>
      <Show
        when={first()}
        fallback={<span class="min-w-0 truncate text-v2-text-text-faint">{why(language, props.flag)}</span>}
      >
        {(line) => (
          <button
            type="button"
            class={`flex min-w-0 items-center gap-1.5 rounded text-start text-v2-text-text-muted hover:text-v2-text-text-base ${FOCUS_RING}`}
            onClick={go}
            title={language.t("session.review.flag.go")}
          >
            <span class="shrink-0 font-mono text-11-regular text-v2-text-text-faint">{line().line}</span>
            <code class="min-w-0 truncate font-mono text-11-regular">{line().text.trim()}</code>
          </button>
        )}
      </Show>
    </li>
  )
}

// Only flags with no line to point at need a sentence of their own.
const why = (language: ReturnType<typeof useLanguage>, flag: Flag) => {
  switch (flag.kind) {
    case "tests-removed":
      return language.t("session.review.why.testsRemoved")
    case "sensitive-path":
      return language.t("session.review.why.sensitive")
    case "file-deleted":
    case "mostly-deleted":
      return language.t("session.review.why.deleted")
    case "lockfile-alone":
      return language.t("session.review.why.lockfile")
    case "not-assessed":
      return language.t("session.review.why.notAssessed")
    default:
      return undefined
  }
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
