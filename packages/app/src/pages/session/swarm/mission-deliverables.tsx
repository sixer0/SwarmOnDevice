// Deliverables panel (row 132; masterplan/01_specs_mission_control_ui.md §6 items 32-34, §7, §12; report V6:141, :372-376).
// Per mission: format tile, name, "+ formats · TaskRef · Rev", status (Draft / In review / Final) and the U24
// Verified / Unverified badge (C127: any state other than verified shows Unverified), "n/m final" in the head.
// A click selects the linked row/agent in the HQ deck (shared selection, passed in by row 133) and opens the project
// file in the existing file tab (row 112's FilePreviewGate renders Studio outputs, C101/C102), or shows the
// not-in-project state. All mission text is agent-written: text nodes only, never innerHTML (§12).
// 1.2.7 row 26 (U-2; U3, C10): each line found on disk gets a sibling "Reveal in Finder / File Explorer" button
// (desktop reveal-path: showItemInFolder only, never opens or launches). Folder lines (files in 11_deliverables/ that
// no Studio output claims) have no status badge; a .command, .app and every non-document type is reveal only.
// No new panel: one button per line in the existing Deliverables section.
// 1.3.3 row 72 (MC-8 item 5, U16): under a line, the copies in <project>/deliverables/<mission>/ (row 71
// `projectFiles`) as links with two actions: Open (the system's default app, desktop `open-deliverable`, which checks
// the path again) and Preview (PDF or HTML in the existing file tab). Each link names its revision (letter and Studio
// number); the latest is marked, older revisions sit in a closed <details>. `MissionDeliverableLinks` (props only) and
// `MissionDeliverableLinksFor` (app contexts) are the pieces row 73 mounts on the decision card and the row view.
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { fileManagerApp, type FileManagerOS } from "@/utils/file-manager"
import { showToast } from "@/utils/toast"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { For, Show, createMemo } from "solid-js"
import {
  activateDeliverable,
  deliverableLines,
  finalTally,
  latestLinks,
  lineMeta,
  linkActions,
  linkGroups,
  missionDeliverableLinks,
  runDeliverableLink,
  type DeliverableLine,
  type DeliverableLink,
  type DeliverableLinkActions,
} from "./mission-deliverables-model"
import { useSessionLayout } from "../session-layout"
import { registerStudioOutputs } from "../studio-output-registry"
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
  | "session.mission.deliverable.openSystem"
  | "session.mission.deliverable.preview"
  | "session.mission.deliverable.latest"
  | "session.mission.deliverable.olderRevisions"
  | "session.mission.deliverable.revealOnly"
  | "session.header.reveal.finder"
  | "session.header.reveal.fileExplorer"
  | "session.header.reveal.containingFolder"

export type MissionDeliverablesTranslate = (key: MissionDeliverablesKey, params?: Record<string, string | number>) => string

export type MissionDeliverablesProps = {
  mission: MissionVM | null | undefined
  /** shared HQ selection: the selected row id, the same value row 130's MissionHQ and row 131's MissionCommand get */
  selected?: string
  /** the same handler row 133 passes to MissionHQ.onSelectAgent */
  onSelectAgent?: (rowId: string) => void
  /** `(p) => tabs().open(file.tab(p))` (spec §11; session-side-panel.tsx:747) */
  openFile?: (path: string) => void
  /** 1.2.7 row 58e (L-2): show the review/file pane with the opened tab active; absent = the session layout's own */
  openPane?: (path: string) => void
  /** N7-023: `(abs) => void platform.revealPath?.(abs)`; absent = the platform's own revealPath (desktop) or no button */
  revealFile?: (absPath: string) => void
  /** the session directory the deliverables' project paths are relative to; absent = the SDK's directory */
  directory?: string
  /** picks the reveal label (fileManagerApp); absent = the desktop platform's OS */
  os?: FileManagerOS
  /** 1.3.3 row 72: `(abs) => platform.openDeliverable(abs)`; absent = the platform's own (desktop) or no Open */
  openSystem?: (absPath: string) => void
  /** 1.3.3 row 72: the folder the file tab reads; absent = `directory`. Preview needs the project copy inside it. */
  sessionDirectory?: string
}

type MissionDeliverableLinksProps = DeliverableLinkActions & {
  links: readonly DeliverableLink[]
  /** the mission id, for the not-in-project text */
  mission: string
  t: MissionDeliverablesTranslate
  /** only the revision the mission refers to (a compact place); default: older revisions in a closed <details> */
  latestOnly?: boolean
}

const LINK_ACTION =
  "rounded-sm px-1 text-11-regular text-v2-text-text-base underline decoration-v2-border-border-base underline-offset-2 hover:bg-v2-overlay-simple-overlay-hover"

/**
 * 1.3.3 row 72: the project copies of a deliverable as links, grouped by revision. Props only (no context), so it
 * renders in a test and on any existing view. Text nodes only; every path was shaped by `deliverableLinks`.
 */
/** @internal test seam */
export function MissionDeliverableLinks(props: MissionDeliverableLinksProps) {
  const groups = createMemo(() => linkGroups(props.links))
  const current = createMemo(() => groups().filter((group) => group.latest))
  const older = createMemo(() => (props.latestOnly ? [] : groups().filter((group) => !group.latest)))
  const actions = (): DeliverableLinkActions => ({ openSystem: props.openSystem, previewFile: props.previewFile })
  const name = (key: MissionDeliverablesKey, link: DeliverableLink) =>
    [props.t(key), link.format, link.revision].filter(Boolean).join(" ")
  const group = (item: ReturnType<typeof linkGroups>[number]) => {
    const here = () => item.links.filter((link) => link.present)
    const absent = () => item.links.filter((link) => !link.present)
    return (
      <div
        data-deliverable-revision={item.revision}
        data-latest={item.latest ? "true" : "false"}
        class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-11-regular text-v2-text-text-faint"
      >
        <span data-deliverable-revision-label class="tabular-nums text-v2-text-text-muted">
          {item.revision}
        </span>
        <Show when={item.latest}>
          <span data-deliverable-latest class="text-v2-state-fg-success">
            {props.t("session.mission.deliverable.latest")}
          </span>
        </Show>
        <For each={here()}>
          {(link) => (
            <span data-deliverable-link={link.path} data-format={link.format} class="flex items-center gap-0.5">
              <span class="font-mono text-v2-text-text-muted">{link.format}</span>
              <Show when={linkActions(link, actions()).includes("open")}>
                <button
                  type="button"
                  data-deliverable-open
                  aria-label={name("session.mission.deliverable.openSystem", link)}
                  class={LINK_ACTION}
                  onClick={() => runDeliverableLink(link, "open", actions())}
                >
                  {props.t("session.mission.deliverable.openSystem")}
                </button>
              </Show>
              <Show when={linkActions(link, actions()).includes("preview")}>
                <button
                  type="button"
                  data-deliverable-preview
                  aria-label={name("session.mission.deliverable.preview", link)}
                  class={LINK_ACTION}
                  onClick={() => runDeliverableLink(link, "preview", actions())}
                >
                  {props.t("session.mission.deliverable.preview")}
                </button>
              </Show>
            </span>
          )}
        </For>
        <Show when={absent().length > 0}>
          <span data-deliverable-link-absent data-format={absent().map((link) => link.format).join(" ")}>
            <span class="font-mono">{absent().map((link) => link.format).join(" ")}</span>{" "}
            {props.t("session.mission.deliverable.notInProject", { mission: props.mission })}
          </span>
        </Show>
      </div>
    )
  }
  return (
    <Show when={groups().length > 0}>
      <div data-deliverable-links class="flex min-w-0 flex-col gap-0.5">
        <For each={current()}>{group}</For>
        <Show when={older().length > 0}>
          <details data-deliverable-older class="min-w-0">
            <summary class="cursor-pointer text-11-regular text-v2-text-text-faint">
              {props.t("session.mission.deliverable.olderRevisions", { count: older().length })}
            </summary>
            <div class="flex min-w-0 flex-col gap-0.5 pt-0.5">
              <For each={older()}>{group}</For>
            </div>
          </details>
        </Show>
      </div>
    </Show>
  )
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
  const lines = createMemo(() =>
    deliverableLines(props.mission, props.selected, props.directory, props.sessionDirectory ?? props.directory),
  )
  const tally = createMemo(() => finalTally(props.mission))
  const missionId = () => props.mission?.id ?? ""

  const label = (line: DeliverableLine) =>
    line.path ? props.t("session.mission.deliverable.open", { name: line.name }) : line.name
  const revealLabel = () => props.t(fileManagerApp(props.os ?? "unknown").actionLabel)
  // U3: anything that does not open in the file tab (executables, .app, other types) is revealed only.
  const revealTitle = (line: DeliverableLine) =>
    line.path ? revealLabel() : `${revealLabel()}. ${props.t("session.mission.deliverable.revealOnly")}`
  const folder = (line: DeliverableLine) => line.origin === "folder"

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
              <li class="flex min-w-0 flex-col gap-0.5">
                <div class="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  data-mission-deliverable={line.documentId}
                  data-status={line.status}
                  data-verified={line.verified ? "true" : "false"}
                  data-openable={line.path ? "true" : "false"}
                  aria-pressed={line.selected ? "true" : "false"}
                  aria-label={label(line)}
                  title={line.name}
                  data-origin={line.origin}
                  class="grid min-w-0 flex-1 grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-v2-overlay-simple-overlay-hover aria-pressed:bg-v2-overlay-simple-overlay-hover"
                  onClick={() => activateDeliverable(line, { selectRow: props.onSelectAgent, openFile: props.openFile, openPane: props.openPane })}
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
                    <Show when={!folder(line)}>
                      <span data-mission-deliverable-meta class={META}>
                        {lineMeta(line)}
                      </span>
                    </Show>
                    <Show when={!line.path && !folder(line) && line.links.length === 0}>
                      <span data-mission-deliverable-absent class={META}>
                        {props.t("session.mission.deliverable.notInProject", { mission: missionId() })}
                      </span>
                    </Show>
                  </span>
                  <span class="flex flex-col items-end gap-0.5 text-11-regular">
                    <Show when={!folder(line)}>
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
                    </Show>
                  </span>
                </button>
                <Show when={line.revealAbsPath && props.revealFile}>
                  <button
                    type="button"
                    data-deliverable-reveal
                    aria-label={revealLabel()}
                    title={revealTitle(line)}
                    class="flex size-6 shrink-0 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                    onClick={() => {
                      const abs = line.revealAbsPath
                      if (abs) props.revealFile?.(abs)
                    }}
                  >
                    <IconV2 name="folder" size="small" />
                  </button>
                </Show>
                </div>
                <Show when={line.links.length > 0}>
                  <div class="min-w-0 pl-[52px]">
                    <MissionDeliverableLinks
                      links={line.links}
                      mission={missionId()}
                      t={props.t}
                      openSystem={props.openSystem}
                      previewFile={props.openFile ? (path) => {
                        props.openFile?.(path)
                        props.openPane?.(path)
                      } : undefined}
                    />
                  </div>
                </Show>
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
  // 1.2.7 U-2: the reveal handler, OS and session directory come from the app contexts when the mount does not pass
  // them (mission-control.tsx passes openFile only). Outside the providers (render tests) there is no reveal button.
  const platform = optional(usePlatform)
  const sdk = optional(useSDK)
  // A refused path resolves false; the desktop logs it (reveal-path.ts). Nothing here opens or retries.
  // 1.2.7 L-2: opening a document deliverable also shows the review/file pane, as other open-file actions do
  // (session-side-panel activateTab: openReviewPanel + setActive). Outside the providers: no pane action.
  const layout = optional(useSessionLayout)
  const files = optional(useFile)
  const openPane = (path: string) => {
    if (!layout) return
    if (!layout.view().reviewPanel.opened()) layout.view().reviewPanel.open()
    const tab = files?.tab(path)
    if (tab) layout.tabs().setActive(tab)
  }
  const revealFile = (abs: string) => void platform?.revealPath?.(abs).catch(() => false)
  const linkContext = useDeliverableLinkContext()
  // 1.3.3 row 72: a previewed project copy is a listed Studio deliverable, so its HTML opens rendered (C192 registry).
  const openFile = props.openFile
    ? (path: string) => {
        linkContext.register(path)
        props.openFile?.(path)
      }
    : undefined
  return (
    <MissionDeliverablesList
      {...props}
      openFile={openFile}
      openSystem={props.openSystem ?? linkContext.openSystem}
      sessionDirectory={props.sessionDirectory ?? linkContext.sessionDirectory ?? props.directory}
      openPane={props.openPane ?? (layout ? openPane : undefined)}
      revealFile={props.revealFile ?? (platform?.revealPath ? revealFile : undefined)}
      directory={props.directory ?? sdk?.().directory}
      os={props.os ?? platform?.os ?? "unknown"}
      t={(key, params) => language.t(key, params)}
    />
  )
}

/**
 * 1.3.3 row 72: what the app contexts give a deliverable link. Open goes to the desktop's `open-deliverable` channel
 * (main refuses anything that is not `<a folder this window listed>/deliverables/<mission>/<document>`); a refusal or
 * a failure shows the generic request-failed toast and is logged by the desktop, never retried here. Outside the
 * providers (render tests) and on the web there is no Open.
 */
function useDeliverableLinkContext() {
  const platform = optional(usePlatform)
  const sdk = optional(useSDK)
  const language = optional(useLanguage)
  const failed = () => {
    if (language) showToast({ variant: "error", title: language.t("common.requestFailed") })
  }
  const open = platform?.openDeliverable
  return {
    sessionDirectory: sdk?.().directory,
    openSystem: open
      ? (abs: string) =>
          void open(abs)
            .then((ok) => {
              if (!ok) failed()
            })
            .catch(failed)
      : undefined,
    register: (path: string) => registerStudioOutputs(sdk?.().directory, [path]),
  }
}

type MissionDeliverableLinksForProps = {
  mission: MissionVM | null | undefined
  /** the links of this row's deliverable(s) ... */
  rowId?: string
  /** ... or of one document */
  documentId?: string
  /** `(p) => tabs().open(file.tab(p))`; absent = the session layout's own tabs (no Preview outside the providers) */
  openFile?: (path: string) => void
  /** the mission's project folder when it is not the session's (mission-control `deliverablesFolder`) */
  directory?: string
  latestOnly?: boolean
}

/**
 * 1.3.3 row 73's mount: the deliverable links of a row or a document on an existing view (decision card, row view),
 * from the same model and with the same two actions as the Deliverables list. Renders nothing without a project copy.
 */
export function MissionDeliverableLinksFor(props: MissionDeliverableLinksForProps) {
  const language = useLanguage()
  const context = useDeliverableLinkContext()
  const layout = optional(useSessionLayout)
  const files = optional(useFile)
  const links = createMemo(() =>
    missionDeliverableLinks(
      props.mission,
      { rowId: props.rowId, documentId: props.documentId },
      props.directory ?? context.sessionDirectory,
      context.sessionDirectory ?? props.directory,
    ),
  )
  const openTab = (path: string) => {
    if (props.openFile) return props.openFile(path)
    const tab = files?.tab(path)
    if (tab) void layout?.tabs().open(tab)
  }
  const previewFile = (path: string) => {
    context.register(path)
    openTab(path)
    if (!layout) return
    if (!layout.view().reviewPanel.opened()) layout.view().reviewPanel.open()
    const tab = files?.tab(path)
    if (tab) layout.tabs().setActive(tab)
  }
  return (
    <MissionDeliverableLinks
      links={props.latestOnly ? latestLinks(links()) : links()}
      mission={props.mission?.id ?? ""}
      t={(key, params) => language.t(key, params)}
      openSystem={context.openSystem}
      previewFile={props.openFile || (layout && files) ? previewFile : undefined}
      latestOnly={props.latestOnly}
    />
  )
}

function optional<T>(use: () => T): T | undefined {
  try {
    return use()
  } catch {
    return undefined
  }
}
