import { makeEventListener } from "@solid-primitives/event-listener"
import { createMemo, createResource, createSignal, Show, type JSX } from "solid-js"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import {
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX,
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN,
  SessionReviewV2,
  SessionReviewV2Sidebar,
} from "@opencode-ai/session-ui/v2/session-review-v2"
import { SessionReviewFilePreviewV2 } from "@opencode-ai/session-ui/v2/session-review-file-preview-v2"
import { DiffChanges } from "@opencode-ai/ui/v2/diff-changes-v2"
import type {
  SessionReviewComment,
  SessionReviewCommentActions,
  SessionReviewCommentDelete,
  SessionReviewCommentUpdate,
  SessionReviewDiffStyle,
  SessionReviewFocus,
  SessionReviewLineComment,
} from "@opencode-ai/session-ui/session-review"
import FileTreeV2 from "@/components/file-tree-v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import {
  filterRenderableDiff,
  filterReviewFiles,
  reviewDiffKinds,
  reviewDiffNeedsLoad,
  type RenderDiff,
} from "@/pages/session/v2/review-diff-kinds"
import type { ReviewPanelV2State } from "@/pages/session/v2/review-panel-v2-state"
import { applyFileListKeyDown, SessionFileListV2 } from "@/pages/session/v2/session-file-list-v2"
import type { ReviewBriefController } from "@/pages/session/review/review-brief-controller"
import {
  ReviewBriefStrip,
  ReviewFileActions,
  ReviewFileBanner,
  ReviewQueue,
} from "@/pages/session/review/review-brief-view"

type ReviewDiff = FileDiffInfo | SnapshotFileDiff | VcsFileDiff

export type ReviewPanelV2Props = {
  title?: JSX.Element
  empty?: JSX.Element
  diffs: () => ReviewDiff[]
  diffsReady: () => boolean
  diffVersion?: number
  loadDiff?: (path: string, version?: number) => Promise<RenderDiff | undefined>
  activeFile?: string
  onSelectFile: (path: string) => void
  diffStyle: SessionReviewDiffStyle
  onDiffStyleChange?: (style: SessionReviewDiffStyle) => void
  state: ReviewPanelV2State
  onLineComment?: (comment: SessionReviewLineComment) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: SessionReviewComment[]
  focusedComment?: SessionReviewFocus | null
  onFocusedCommentChange?: (focus: SessionReviewFocus | null) => void
  brief?: ReviewBriefController
}

export function ReviewPanelV2(props: ReviewPanelV2Props) {
  const sdk = useSDK()
  let root: HTMLDivElement | undefined

  const diffs = createMemo(() => props.diffs().filter(filterRenderableDiff))
  const filteredFiles = createMemo(() =>
    filterReviewFiles(
      diffs().map((diff) => diff.file),
      props.state.filter(),
    ),
  )
  const searching = createMemo(() => props.state.filter().trim().length > 0)
  const kinds = createMemo(() => reviewDiffKinds(diffs()))
  // Changes-only trees omit "M" — every row is already a change; A/D stay visible.
  const treeKinds = createMemo(() => new Map([...kinds()].filter(([, kind]) => kind !== "mix")))
  // Next and previous follow the queue, so the arrows walk the files in the order they are worth reading.
  const orderedFiles = createMemo(() => {
    const brief = props.brief
    const files = filteredFiles()
    if (!brief || props.state.sidebarView() !== "queue" || searching()) return files
    const shown = new Set(files)
    return brief.brief().order.filter((file) => shown.has(file))
  })
  const activeDiff = createMemo(() => {
    // A focused comment takes over the preview until the preview applies it and
    // clears the focus; the owner then persists the file as the active selection.
    const focus = props.focusedComment
    if (focus && diffs().some((diff) => diff.file === focus.file)) return focus.file
    const active = props.activeFile
    if (searching()) return active
    const files = orderedFiles()
    if (active && files.includes(active)) return active
    return files[0]
  })
  const sourceActiveItem = createMemo(() => diffs().find((diff) => diff.file === activeDiff()))
  const detailSource = createMemo(() => {
    const diff = sourceActiveItem()
    const load = props.loadDiff
    if (!diff || !load || !reviewDiffNeedsLoad(diff)) return
    return { diff, load, version: props.diffVersion }
  })
  const [loadedDiff] = createResource(detailSource, async ({ diff, load, version }) => {
    const value = await load(diff.file, version)
    if (value?.file !== diff.file) return
    return { source: diff, version, value }
  })

  const activeItem = createMemo(() => {
    const source = sourceActiveItem()
    if (loadedDiff.state !== "ready") return source
    const loaded = loadedDiff()
    if (loaded && loaded.source === source && loaded.version === props.diffVersion) return loaded.value
    return source
  })

  const readFile = async (path: string) =>
    sdk()
      .client.file.read({ path })
      .then((x) => x.data)
      .catch((error) => {
        console.debug("[session-review-v2] failed to read file", { path, error })
        return undefined
      })

  const select = (file: string) => {
    props.onSelectFile(file)
    // WebKit does not focus a clicked button, and the review keys only listen while focus is inside the panel.
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true })
  }

  const handleKey = (event: KeyboardEvent) => {
    const brief = props.brief
    if (!brief || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return
    const file = activeDiff()
    if (!file) return
    const key = event.key.toLowerCase()
    if (key === "v") brief.decide(file, "ok")
    else if (key === "x") brief.decide(file, "work")
    else if (key !== "n" || !brief.nextFlag()) return
    event.preventDefault()
    // Otherwise the page reads the letter as the start of a message and moves focus to the composer.
    event.stopPropagation()
    root?.focus({ preventScroll: true })
  }

  const panel = () => (
    <SessionReviewV2
      title={props.title}
      stats={<DiffChanges changes={diffs()} />}
      empty={props.empty}
      sidebarOpen={props.state.sidebarOpened()}
      sidebar={
        // Always mounted: the sidebar header hosts the changes-mode dropdown,
        // which must stay reachable when the current mode has zero diffs.
        <ReviewPanelV2Sidebar
          title={props.title}
          state={props.state}
          diffsReady={props.diffsReady}
          onSelectFile={select}
          brief={props.brief}
          diffs={diffs}
          filteredFiles={filteredFiles}
          searching={searching}
          kinds={treeKinds}
          activeDiff={activeDiff}
        />
      }
      activeFile={activeDiff()}
      files={orderedFiles()}
      onSelectFile={select}
      diffStyle={props.diffStyle}
      onDiffStyleChange={props.onDiffStyleChange}
      expandMode={props.state.expandMode()}
      onExpandModeChange={props.state.setExpandMode}
      hasDiffs={diffs().length > 0}
      toolbarActions={
        <Show when={props.brief}>{(brief) => <ReviewFileActions brief={brief()} file={activeDiff()} />}</Show>
      }
      preview={
        // Key on the file path, not the diff object identity, so refreshed diff data
        // updates the mounted preview instead of remounting the whole viewer.
        <Show when={activeDiff()} keyed>
          {(file) => (
            <Show when={activeItem()}>
              {(diff) => (
                <SessionReviewFilePreviewV2
                  file={file}
                  diff={diff()}
                  diffStyle={props.diffStyle}
                  expandMode={props.state.expandMode()}
                  readFile={readFile}
                  onLineComment={props.onLineComment}
                  onLineCommentUpdate={props.onLineCommentUpdate}
                  onLineCommentDelete={props.onLineCommentDelete}
                  lineCommentActions={props.lineCommentActions}
                  comments={props.comments}
                  focusedComment={props.focusedComment}
                  onFocusedCommentChange={props.onFocusedCommentChange}
                  banner={<Show when={props.brief}>{(brief) => <ReviewFileBanner brief={brief()} file={file} />}</Show>}
                  focusLine={(() => {
                    const focus = props.brief?.focusLine()
                    return focus?.file === file ? focus : undefined
                  })()}
                />
              )}
            </Show>
          )}
        </Show>
      }
    />
  )

  return (
    <div
      ref={(el) => {
        root = el
        makeEventListener(el, "keydown", handleKey)
      }}
      tabIndex={-1}
      data-component="review-brief-root"
      class="flex h-full min-h-0 flex-col outline-none"
    >
      <Show when={props.brief && diffs().length > 0}>
        <ReviewBriefStrip brief={props.brief!} />
      </Show>
      <div class="min-h-0 flex-1">{panel()}</div>
    </div>
  )
}

function ReviewPanelV2Sidebar(props: {
  title?: JSX.Element
  state: ReviewPanelV2State
  diffsReady: () => boolean
  onSelectFile: (path: string) => void
  brief?: ReviewBriefController
  diffs: () => RenderDiff[]
  filteredFiles: () => string[]
  searching: () => boolean
  kinds: () => ReturnType<typeof reviewDiffKinds>
  activeDiff: () => string | undefined
}) {
  const language = useLanguage()
  const queueShown = () => !!props.brief && props.state.sidebarView() === "queue"
  const [explicitHighlight, setExplicitHighlight] = createSignal<string | undefined>()
  const highlightedPath = createMemo(() => {
    if (!props.searching()) return undefined
    const files = props.filteredFiles()
    if (files.length === 0) return undefined
    const explicit = explicitHighlight()
    if (explicit && files.includes(explicit)) return explicit
    return files[0]
  })

  const onFilterKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (!props.searching()) return
    applyFileListKeyDown(event, props.filteredFiles(), highlightedPath(), {
      onHighlight: setExplicitHighlight,
      onSelect: props.onSelectFile,
    })
  }

  return (
    <SessionReviewV2Sidebar
      open={props.state.sidebarOpened()}
      transition={props.state.sidebarTransition()}
      title={props.title}
      stats={<DiffChanges changes={props.diffs()} />}
      filter={props.state.filter()}
      onFilterChange={props.state.setFilter}
      onFilterKeyDown={onFilterKeyDown}
      width={props.state.sidebarWidth()}
      onWidthChange={props.state.resizeSidebar}
      minWidth={SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN}
      maxWidth={SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX}
    >
      <Show
        when={props.diffsReady()}
        fallback={
          <div class="px-2 py-2 text-12-regular text-text-weak">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        }
      >
        <Show
          when={props.searching()}
          fallback={
            <>
              <Show
                when={queueShown() && props.brief}
                fallback={
                  <FileTreeV2
                    allowed={props.filteredFiles()}
                    kinds={props.kinds()}
                    draggable={false}
                    active={props.activeDiff()}
                    onFileClick={(node) => props.onSelectFile(node.path)}
                  />
                }
              >
                {(brief) => <ReviewQueue brief={brief()} active={props.activeDiff()} onSelect={props.onSelectFile} />}
              </Show>
              <Show when={props.brief && props.diffs().length > 0}>
                <button
                  type="button"
                  data-review-order
                  class="mx-2 mb-2 rounded text-12-regular text-v2-text-text-faint underline-offset-2 hover:text-v2-text-text-base hover:underline focus-visible:outline-2 focus-visible:outline-v2-border-border-strong"
                  onClick={() => props.state.setSidebarView(queueShown() ? "tree" : "queue")}
                >
                  {language.t(queueShown() ? "session.review.sidebar.tree" : "session.review.sidebar.queue")}
                </button>
              </Show>
            </>
          }
        >
          <Show
            when={props.filteredFiles().length > 0}
            fallback={<div class="px-2 py-2 text-12-regular text-text-weak">{language.t("palette.empty")}</div>}
          >
            <SessionFileListV2
              files={props.filteredFiles()}
              kinds={props.kinds()}
              active={props.activeDiff()}
              highlighted={highlightedPath()}
              onFileClick={(path) => {
                setExplicitHighlight(path)
                props.onSelectFile(path)
              }}
            />
          </Show>
        </Show>
      </Show>
    </SessionReviewV2Sidebar>
  )
}
