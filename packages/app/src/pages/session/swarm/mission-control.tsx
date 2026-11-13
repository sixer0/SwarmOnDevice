// Mission control shell (row 133; masterplan/01_specs_mission_control_ui.md §6 items 1-4, 35-37, §11; C59, U19).
// A section at the top of the existing Agents view, not a new panel: header (type, title, waves, mission selector),
// the HQ stage (row 130) and the side cards - decision + command (row 131), deliverables (row 132).
// Wider than 760 px the cards sit in a sidebar; at or below it they slide up as a bottom sheet with a dock.
// The section is one fixed box capped below a screen (60vh, at most 720 px; row 136 M6) so the existing Agents view stays
// visible under it; the stage and the cards scroll inside it. Mission text is rendered as text only (§12).
import { useLanguage } from "@/context/language"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { dockItems, missionEyebrow, missionLayoutOf, showSelector } from "./mission-control-layout"
import { MissionCommand } from "./mission-command"
import type { MissionWriter } from "./mission-command-model"
import { MissionDeliverables } from "./mission-deliverables"
import { MissionHQ } from "./mission-hq"
import { missionDriftLine, missionStatusLine } from "./mission-model"
import type { createMissionControl } from "./mission-poll"

const STATUS_LINE_KEY = {
  notStarted: "session.mission.line.notStarted",
  approvedNotStarted: "session.mission.line.approvedNotStarted",
  paused: "session.mission.line.paused",
} as const

export type MissionControlHandle = ReturnType<typeof createMissionControl>

/** What session.tsx hands the Agents view (spec §11). */
export type MissionControlMount = {
  control: MissionControlHandle
  /** write half of window.api.missions; absent = read-only (no decision or command card) */
  writer?: MissionWriter
  /** normal prompt to the open session's root, sent after a store write succeeded (§2) */
  prompt: (text: string) => Promise<unknown>
  /** `(p) => tabs().open(file.tab(p))` */
  openFile?: (path: string) => void
  /** 1.2.8 row 46 (01d §4): whether any of these sessions is busy (the placement's join/new wait for idle) */
  sessionBusy?: (sessions: string[]) => boolean
  /**
   * Row 133b (C175): the header toggle that widens the existing Activity pane (session-map-view.tsx) so the radial HQ
   * (stage >= 540 px) and the sidebar (>= 761 px) can show. `wide` is the remembered choice; absent = no toggle.
   */
  expand?: { wide: () => boolean; toggle: () => void }
}

// Row 133b (C175): the widened Activity pane, as session-map-view.tsx sets it in a container of 900 px or more:
// `@[900px]:w-[min(1100px,70vw,calc(100%-280px))]` (the 372 px pane otherwise). The section is 17 px narrower than
// the pane (2 x 8 px margin + 1 px border; row 144 measured 355 in 372). The stage sits beside the 300 px sidebar
// (8 px gap) at 761 px or more, and takes the whole width in sheet mode.
export const WIDE_PANE = { max: 1100, window: 0.7, chat: 280, inset: 17 } as const
export function widePaneWidth(windowWidth: number, containerWidth: number) {
  return Math.min(WIDE_PANE.max, Math.floor(windowWidth * WIDE_PANE.window), containerWidth - WIDE_PANE.chat)
}
export function missionStageWidth(sectionWidth: number) {
  return missionLayoutOf(sectionWidth) === "sidebar" ? sectionWidth - 300 - 8 : sectionWidth
}

const FAINT = "text-v2-text-text-faint [font-weight:440]"
const DOCK_BUTTON =
  "rounded-[6px] bg-v2-background-bg-base px-2 py-1 text-v2-text-text-base [font-weight:500] [box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"

export function MissionControl(props: MissionControlMount & { width?: number }) {
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number>) => language.t(key as never, params)
  const state = props.control.state
  const [measured, setMeasured] = createSignal(0)
  const layout = () => missionLayoutOf(props.width ?? measured())
  const sheetMode = () => layout() === "sheet"
  const [sheet, setSheet] = createSignal(false)
  const [row, setRow] = createSignal<string>()
  let deliverables: HTMLDivElement | undefined

  // A row selection belongs to one mission; a selection of a row that left the mission is dropped.
  createEffect(on(() => state.selected, () => setRow(undefined), { defer: true }))
  createEffect(() => {
    const id = row()
    if (id && state.mission && !state.mission.agents[id]) setRow(undefined)
  })
  createEffect(on(sheetMode, (narrow) => !narrow && setSheet(false), { defer: true }))

  const shown = () => props.control.available && state.options.length > 0
  // Row 180: with the bridge present but no mission, a compact card says so (no HQ) instead of hiding the section; the
  // running poll swaps in the full view when the first mission is listed. Studio not running (list answered
  // HOST_UNAVAILABLE) is one muted line. Without the bridge (web build) nothing shows, as before.
  const unavailable = () => props.control.available && state.options.length === 0 && state.unavailable
  const empty = () => props.control.available && state.options.length === 0 && state.listed && !state.unavailable

  const observe = (el: HTMLElement) => {
    if (props.width !== undefined || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => setMeasured(entries[0]?.contentRect.width ?? 0))
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  }

  const selectAgent = (id: string) => {
    setRow(id)
    if (sheetMode()) setSheet(true)
  }
  // V6:387 a click on the stage (not on an agent or the beacon) puts the sheet away.
  const onStageClick = (event: MouseEvent) => {
    if (!sheetMode()) return
    const target = event.target as Element | null
    if (target?.closest?.(".hq-agent,.hq-beacon")) return
    setSheet(false)
  }
  const showFiles = () => {
    setSheet(true)
    deliverables?.scrollIntoView?.({ block: "nearest" })
  }

  return (
    <Switch>
      <Match when={unavailable()}>
        <p data-mission-unavailable role="status" class={`mx-2 shrink-0 text-12-regular ${FAINT}`}>
          {t("session.mission.unavailable")}
        </p>
      </Match>
      <Match when={empty()}>
        <section
          data-mission-empty
          aria-label={t("session.mission.title")}
          class="mx-2 flex shrink-0 flex-col gap-0.5 rounded-[8px] px-2 py-1.5 [box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
        >
          <h2 data-mission-title class="truncate text-v2-text-text-base [font-weight:530]">
            {t("session.mission.title")}
          </h2>
          <p data-mission-empty-line class="text-v2-text-text-base [font-weight:440]">
            {t("session.mission.empty")}
          </p>
          <p data-mission-empty-hint class={`text-12-regular ${FAINT}`}>
            {t("session.mission.emptyHint")}
          </p>
          <p data-mission-empty-session class={`text-12-regular ${FAINT}`}>
            {t("session.mission.emptySession")}
          </p>
        </section>
      </Match>
      <Match when={shown()}>
        <section
          ref={observe}
          data-mission-control
          data-mission-layout={layout()}
          data-mission-sheet={sheetMode() ? (sheet() ? "open" : "closed") : undefined}
          aria-label={t("session.mission.title")}
          class="relative mx-2 flex h-[60vh] max-h-[720px] min-h-[320px] shrink-0 flex-col gap-2 overflow-hidden"
        >
          <header class="flex shrink-0 items-start gap-2">
            <div class="min-w-0 flex-1">
              <Show when={state.mission}>
                {(mission) => (
                  <>
                    <div data-mission-eyebrow class={`truncate text-11-regular uppercase ${FAINT}`}>
                      {missionEyebrow(mission(), t)}
                    </div>
                    <h2 data-mission-title class="truncate text-v2-text-text-base [font-weight:530]">
                      {mission().title}
                    </h2>
                  </>
                )}
              </Show>
            </div>
            <Show when={!sheetMode() && (state.mission?.waves.length ?? 0) > 0}>
              <div data-mission-waves class={`flex shrink-0 items-baseline gap-2 tabular-nums ${FAINT}`}>
                <For each={state.mission?.waves ?? []}>
                  {(wave) => (
                    <span
                      data-mission-wave={wave.wave}
                      classList={{
                        "text-v2-state-fg-success": wave.tone === "done",
                        "text-v2-state-fg-warning": wave.tone === "issue",
                      }}
                    >
                      W{wave.wave} {wave.done}/{wave.total}
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <Show when={showSelector(state.options)}>
              <select
                data-mission-select
                aria-label={t("session.mission.select")}
                class="max-w-[45%] shrink-0 truncate rounded-[6px] bg-v2-background-bg-base px-1.5 py-1 text-v2-text-text-base [box-shadow:inset_0_0_0_1px_var(--v2-border-border-strong)]"
                onChange={(event) => props.control.select(event.currentTarget.value)}
              >
                <For each={state.options}>
                  {(option) => (
                    <option value={option.id} selected={option.id === state.selected}>
                      {option.title}
                    </option>
                  )}
                </For>
              </select>
            </Show>
            <Show when={props.expand}>
              {(expand) => (
                <IconButtonV2
                  type="button"
                  variant="ghost-muted"
                  size="small"
                  data-mission-expand={expand().wide() ? "wide" : "narrow"}
                  aria-pressed={expand().wide()}
                  aria-label={t(expand().wide() ? "session.mission.collapse" : "session.mission.expand")}
                  title={t(expand().wide() ? "session.mission.collapse" : "session.mission.expand")}
                  onClick={() => expand().toggle()}
                  icon={<IconV2 name={expand().wide() ? "collapse" : "expand"} class="rotate-90" />}
                />
              )}
            </Show>
          </header>

          <Show when={state.readFailed}>
            <div data-mission-read-failed role="status" class="shrink-0 text-v2-state-fg-warning [font-weight:440]">
              {t("session.mission.readFailed")}
            </div>
          </Show>

          {/* Row 190 (L48): one compact line, not a panel, when the selected mission is not moving. */}
          <Show when={state.mission && missionStatusLine(state.mission)}>
            {(line) => (
              <p data-mission-status-line={line()} role="status" class={`shrink-0 text-12-regular ${FAINT}`}>
                {t(STATUS_LINE_KEY[line()])}
              </p>
            )}
          </Show>

          {/* Row 88 (1.2.6 MC-09): one drift line, not a panel, when steps were added after approval. Dropped rows only
              ride along as a data attribute (no wording of their own). */}
          <Show when={state.mission && missionDriftLine(state.mission)}>
            {(drift) => (
              <p
                data-mission-drift-line={drift().count}
                data-mission-drift-dropped={drift().dropped > 0 ? drift().dropped : undefined}
                role="status"
                class={`shrink-0 text-12-regular ${FAINT}`}
              >
                {t("session.mission.line.drift", { count: drift().count })}
              </p>
            )}
          </Show>

          {/* Row 197 (S194-03): the agent approved its own mission in autonomous mode; the person should see that. */}
          <Show when={state.mission?.selfApproved}>
            <p data-mission-self-approved role="status" class="shrink-0 text-12-regular text-v2-state-fg-warning">
              {t("session.mission.approval.autonomous")}
            </p>
          </Show>

          <Show when={state.mission}>
            {(mission) => (
              <div
                data-mission-main
                class={
                  sheetMode()
                    ? "relative min-h-0 flex-1 overflow-hidden"
                    : "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] gap-2 overflow-hidden"
                }
              >
                <div data-mission-stage class="h-full min-h-0 overflow-y-auto" onClick={onStageClick}>
                  <MissionHQ
                    mission={mission()}
                    width={props.width === undefined ? undefined : missionStageWidth(props.width)}
                    selected={row()}
                    onSelectAgent={selectAgent}
                    onOpenDecision={() => setSheet(true)}
                  />
                </div>

                <Show when={sheetMode()}>
                  <div data-mission-dock class="absolute right-2 bottom-2 z-[4] flex gap-1.5">
                    <Show when={dockItems(mission()).decisions > 0}>
                      <button
                        type="button"
                        data-mission-dock-item="decisions"
                        class={DOCK_BUTTON}
                        onClick={() => setSheet(true)}
                      >
                        {t("session.mission.dock.decisions", { count: dockItems(mission()).decisions })}
                      </button>
                    </Show>
                    <Show when={dockItems(mission()).files}>
                      {(files) => (
                        <button type="button" data-mission-dock-item="files" class={DOCK_BUTTON} onClick={showFiles}>
                          {t("session.mission.dock.files", { final: files().final, total: files().total })}
                        </button>
                      )}
                    </Show>
                    <button
                      type="button"
                      data-mission-dock-item="command"
                      aria-expanded={sheet()}
                      class={DOCK_BUTTON}
                      onClick={() => setSheet((open) => !open)}
                    >
                      {t("session.mission.command")}
                    </button>
                  </div>
                </Show>

                {/* 1.2.7 row 58a (F-2, F-3): the panel has a definite height in both layouts (sheet: h-[72%] of the main
                    area, was max-h; sidebar: the grid row) so the feed and the decision card size against it; see the
                    layout contract in mission-command.tsx. gap-1.5 is the command card's own spacing (its wrappers are
                    display: contents); mt-1.5 keeps the 12 px before the deliverables. */}
                <aside
                  data-mission-side
                  inert={sheetMode() && !sheet() ? true : undefined}
                  class={
                    sheetMode()
                      ? "absolute inset-x-0 bottom-0 z-[5] flex h-[72%] flex-col gap-1.5 overflow-y-auto rounded-t-[14px] bg-v2-background-bg-base p-2 transition-transform duration-[250ms] [box-shadow:0_-12px_30px_rgba(0,0,0,.35)] motion-reduce:transition-none"
                      : "flex min-h-0 flex-col gap-1.5 overflow-y-auto"
                  }
                  classList={{ "translate-y-[105%]": sheetMode() && !sheet() }}
                >
                  <Show when={props.writer}>
                    {(writer) => (
                      <MissionCommand
                        model={mission()}
                        writer={writer()}
                        refresh={() => props.control.refresh()}
                        prompt={props.prompt}
                        selected={row()}
                        sessionBusy={props.sessionBusy}
                      />
                    )}
                  </Show>
                  <div
                    class="mt-1.5 shrink-0"
                    ref={(el) => {
                      deliverables = el
                    }}
                  >
                    <MissionDeliverables
                      mission={mission()}
                      selected={row()}
                      onSelectAgent={selectAgent}
                      openFile={props.openFile}
                    />
                  </div>
                </aside>
              </div>
            )}
          </Show>
        </section>
      </Match>
    </Switch>
  )
}
