// Deliverables panel (row 132; masterplan/01_specs_mission_control_ui.md §6 items 32-34, §7, §12; report V6:141, :372-376).
// Per mission: format tile, name, "+ formats · TaskRef · Rev", status (Draft / In review / Final) and the U24
// Verified / Unverified badge (C127: any state other than verified shows Unverified), "n/m final" in the head.
// A click selects the linked row/agent in the HQ deck (shared selection, passed in by row 133) and opens the project
// file in the existing file tab (row 112's FilePreviewGate renders Studio outputs, C101/C102), or shows the
// not-in-project state. All mission text is agent-written: text nodes only, never innerHTML (§12).
import { useLanguage } from "@/context/language"
import { For, Show, createMemo } from "solid-js"
import { activateDeliverable, deliverableLines, finalTally, lineMeta, type DeliverableLine } from "./mission-deliverables-model"
import type { DeliverableStatus, MissionVM } from "./mission-model"

export type MissionDeliverablesKey =
  | "session.mission.deliverables"
  | "session.mission.deliverables.final"
  | "session.mission.deliverable.draft"
  | "session.mission.deliverable.review"
  | "session.mission.deliverable.final"
  | "session.mission.deliverable.verified"
  | "session.mission.deliverable.unverified"
  | "session.mission.deliverable.notInProject"
  | "session.mission.deliverable.open"

export type MissionDeliverablesTranslate = (key: MissionDeliverablesKey, params?: Record<string, string | number>) => string

export type MissionDeliverablesProps = {
  mission: MissionVM | null | undefined
  /** shared HQ selection: the selected row id, the same value row 130's MissionHQ and row 131's MissionCommand get */
  selected?: string
  /** the same handler row 133 passes to MissionHQ.onSelectAgent */
  onSelectAgent?: (rowId: string) => void
  /** `(p) => tabs().open(file.tab(p))` (spec §11; session-side-panel.tsx:747) */
  openFile?: (path: string) => void
}

const STATUS_KEY: Record<DeliverableStatus, MissionDeliverablesKey> = {
  draft: "session.mission.deliverable.draft",
  review: "session.mission.deliverable.review",
  final: "session.mission.deliverable.final",
}

const STATUS_TONE: Record<DeliverableStatus, string> = {
  draft: "text-v2-text-text-muted",
  review: "text-v2-state-fg-warning",
  final: "text-v2-state-fg-success",
}

const META = "block truncate text-11-regular text-v2-text-text-faint [font-weight:440]"

/** Props-only body (no context), so it renders in a test without the app providers. */
export function MissionDeliverablesList(props: MissionDeliverablesProps & { t: MissionDeliverablesTranslate }) {
  const lines = createMemo(() => deliverableLines(props.mission, props.selected))
  const tally = createMemo(() => finalTally(props.mission))
  const missionId = () => props.mission?.id ?? ""

  const label = (line: DeliverableLine) =>
    line.path ? props.t("session.mission.deliverable.open", { name: line.name }) : line.name

  return (
    <Show when={lines().length > 0}>
      <section
        data-mission-deliverables
        aria-label={props.t("session.mission.deliverables")}
        class="flex min-w-0 flex-col gap-2 rounded-md border border-v2-border-border-base p-3"
      >
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="text-12-medium text-v2-text-text-base">{props.t("session.mission.deliverables")}</h2>
          <span data-mission-deliverables-count class="text-11-regular text-v2-text-text-faint tabular-nums">
            {props.t("session.mission.deliverables.final", { final: tally().final, total: tally().total })}
          </span>
        </div>
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          <For each={lines()}>
            {(line) => (
              <li>
                <button
                  type="button"
                  data-mission-deliverable={line.documentId}
                  data-status={line.status}
                  data-verified={line.verified ? "true" : "false"}
                  data-openable={line.path ? "true" : "false"}
                  aria-pressed={line.selected ? "true" : "false"}
                  aria-label={label(line)}
                  title={line.name}
                  class="grid w-full min-w-0 grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-v2-overlay-simple-overlay-hover aria-pressed:bg-v2-overlay-simple-overlay-hover"
                  onClick={() => activateDeliverable(line, { selectRow: props.onSelectAgent, openFile: props.openFile })}
                >
                  <span
                    data-mission-deliverable-format
                    class="rounded-sm border border-v2-border-border-base py-1 text-center font-mono text-11-medium text-v2-text-text-base"
                  >
                    {line.tile}
                  </span>
                  <span class="min-w-0">
                    <span data-mission-deliverable-name class="block truncate text-12-regular text-v2-text-text-base">
                      {line.name}
                    </span>
                    <span data-mission-deliverable-meta class={META}>
                      {lineMeta(line)}
                    </span>
                    <Show when={!line.path}>
                      <span data-mission-deliverable-absent class={META}>
                        {props.t("session.mission.deliverable.notInProject", { mission: missionId() })}
                      </span>
                    </Show>
                  </span>
                  <span class="flex flex-col items-end gap-0.5 text-11-regular">
                    <span data-mission-deliverable-status class={STATUS_TONE[line.status]}>
                      {props.t(STATUS_KEY[line.status])}
                    </span>
                    <span
                      data-mission-deliverable-verified
                      class={line.verified ? "text-v2-state-fg-success" : "text-v2-text-text-faint"}
                    >
                      {props.t(
                        line.verified ? "session.mission.deliverable.verified" : "session.mission.deliverable.unverified",
                      )}
                    </span>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}

/** Row 133 mounts this inside the mission section of SwarmAgents. */
export function MissionDeliverables(props: MissionDeliverablesProps) {
  const language = useLanguage()
  return <MissionDeliverablesList {...props} t={(key, params) => language.t(key, params)} />
}
