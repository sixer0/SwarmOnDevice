// Row 112 of docs/2026-11-06_swarm_1_2_0_datum_installer (studio spec §8.2, decision U12, keep_ui_simple): the
// preview of Studio's PDF and HTML outputs, rendered INSIDE the existing file tab (file-tabs.tsx `content()`), not in a
// new panel or route. Chromium built-ins do the rendering:
// - `.pdf`: Chromium's PDF viewer in an `<iframe>` over a `blob:` URL that is revoked when the tab closes (P1, P7);
// - `.html`: `<iframe sandbox="" srcdoc>` with the §8.2 CSP injected and links, scripts and fetchers stripped (P2, P6);
// - `.docx`: the same-stem `.pdf` (preferred) or `.html` companion, else the §8.2 hint (P4);
// - `.xlsx`, `.pptx`: the known 1.2.0 limit, plus the existing "open in the default app" call (`platform.openPath`).
// Every other file keeps the existing text/media view untouched (P3). The rules live in ./file-preview-policy.ts.
import { createEffect, createMemo, createSignal, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type { FileContent } from "@opencode-ai/sdk/v2"
import { useFile } from "@/context/file"
import type { FileState } from "@/context/file/types"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { showToast } from "@/utils/toast"
import {
  buildHtmlPreviewDocument,
  companionCandidates,
  countPdfPages,
  createPdfObjectUrl,
  fileNameOf,
  htmlTextFromContent,
  isPreviewPathAllowed,
  isStudioOutputPath,
  pdfBytesFromContent,
  PREVIEW_HTML_SANDBOX,
  previewKindFromPath,
} from "./file-preview-policy"
import { registeredStudioOutputs } from "./studio-output-registry"

/** Chromium's PDF viewer over a `blob:` URL; the URL is revoked when the bytes change or the tab unmounts (P7). */
export function PdfPreviewFrame(props: { path: string; bytes: Uint8Array }) {
  const [url, setUrl] = createSignal<string>()
  createEffect(() => {
    const handle = createPdfObjectUrl(props.bytes)
    setUrl(handle.url)
    onCleanup(() => handle.revoke())
  })
  const pages = createMemo(() => countPdfPages(props.bytes))
  return (
    <iframe
      data-slot="file-preview-pdf"
      data-page-count={pages()}
      title={fileNameOf(props.path)}
      src={url()}
      referrerPolicy="no-referrer"
      class="block w-full flex-1 min-h-0 border-0 bg-background-base"
    />
  )
}

/** Static HTML: `sandbox=""` (no scripts, no same-origin, no popups, no forms) and the §8.2 CSP in the srcdoc. */
export function HtmlPreviewFrame(props: { path: string; html: string }) {
  const srcdoc = createMemo(() => buildHtmlPreviewDocument(props.html))
  return (
    <iframe
      data-slot="file-preview-html"
      title={fileNameOf(props.path)}
      sandbox={PREVIEW_HTML_SANDBOX}
      srcdoc={srcdoc()}
      referrerPolicy="no-referrer"
      class="block w-full flex-1 min-h-0 border-0 bg-white"
    />
  )
}

type Companion = { path: string; content: FileContent | undefined }

/** True when `content` holds bytes the preview can render for `path` (a real PDF, or non-empty HTML text). */
export function hasRenderablePreview(path: string, content: FileContent | undefined) {
  const kind = previewKindFromPath(path)
  if (kind === "pdf") return !!pdfBytesFromContent(content)
  if (kind === "html") return !!htmlTextFromContent(content)
  return false
}

/** The frame for a renderable PDF or HTML content; nothing otherwise. */
function PreviewFrame(props: { path: string; content: FileContent | undefined }) {
  const pdf = createMemo(() => (previewKindFromPath(props.path) === "pdf" ? pdfBytesFromContent(props.content) : undefined))
  const html = createMemo(() => (previewKindFromPath(props.path) === "html" ? htmlTextFromContent(props.content) : undefined))
  return (
    <Switch>
      <Match when={pdf()}>{(bytes) => <PdfPreviewFrame path={props.path} bytes={bytes()} />}</Match>
      <Match when={html()}>{(text) => <HtmlPreviewFrame path={props.path} html={text()} />}</Match>
    </Switch>
  )
}

export type FilePreviewBodyProps = {
  path: string
  content: FileContent | undefined
  /** `.docx` only: the first same-stem companion that holds renderable bytes. */
  companion?: Companion
  t: (key: "file.preview.companion" | "file.preview.docxHint" | "file.preview.none" | "common.open", params?: Record<string, string>) => string
  /** `.xlsx`/`.pptx`: hands the file to the OS default app; absent when the app cannot (web, remote server). */
  onOpenExternal?: () => void
  toolbar?: JSX.Element
}

/** Presentational: everything the tab shows for a previewable file. Tested directly in test-browser/file-preview. */
export function FilePreviewBody(props: FilePreviewBodyProps) {
  const kind = () => previewKindFromPath(props.path)
  const note = (text: string) => <div class="px-6 py-4 text-text-weak" data-slot="file-preview-note">{text}</div>
  return (
    <div class="mt-3 relative h-full min-h-0 flex flex-col" data-component="file-preview" data-kind={kind()}>
      {props.toolbar}
      <Switch>
        <Match when={kind() === "pdf" || kind() === "html"}>
          <PreviewFrame path={props.path} content={props.content} />
        </Match>
        <Match when={kind() === "docx"}>
          <Show
            when={
              props.companion && hasRenderablePreview(props.companion.path, props.companion.content)
                ? props.companion
                : undefined
            }
            fallback={note(props.t("file.preview.docxHint"))}
          >
            {(companion) => (
              <>
                <div class="px-3 pb-2 text-12-regular text-text-weak" data-slot="file-preview-companion">
                  {props.t("file.preview.companion", { file: fileNameOf(companion().path) })}
                </div>
                <PreviewFrame path={companion().path} content={companion().content} />
              </>
            )}
          </Show>
        </Match>
        <Match when={kind() === "office"}>
          {note(props.t("file.preview.none"))}
          <Show when={props.onOpenExternal}>
            {(open) => (
              <div class="px-6">
                <Button size="small" variant="secondary" data-slot="file-preview-open" onClick={() => open()()}>
                  {props.t("common.open")}
                </Button>
              </div>
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  )
}

/**
 * The gate `file-tabs.tsx` wraps around its existing tab content. A file without a preview kind, a path that fails
 * the client guard, or a file that has not loaded yet renders `children` (the existing view) unchanged. An `.html`
 * file opens as its source (the existing code view) with a toggle to render it; only a Studio output `.html`
 * (C51 file name, or a DATUM title name registered as a deliverable - row 165E, C192; `isStudioOutputPath`) opens
 * rendered by default (row 112b, C101). Either way the toggle flips it.
 */
export function FilePreviewGate(props: { path: string | undefined; state: FileState | undefined; children: JSX.Element }) {
  const file = useFile()
  const language = useLanguage()
  const platform = usePlatform()
  const sdk = useSDK()
  const server = useServer()
  // Row 112b (C101): an `.html` opens as source (the code view) unless it is a Studio output; the toggle overrides
  // that default for the path it was pressed on.
  const [toggled, setToggled] = createSignal<{ path: string | undefined; source: boolean }>()
  const source = () => {
    const choice = toggled()
    if (choice && choice.path === props.path) return choice.source
    // Row 165E (C192): a DATUM title name renders only when it is a registered Studio output of this directory.
    return !isStudioOutputPath(props.path, registeredStudioOutputs(sdk().directory))
  }
  const setSource = (next: boolean) => setToggled({ path: props.path, source: next })

  const kind = createMemo(() => (isPreviewPathAllowed(props.path) ? previewKindFromPath(props.path) : undefined))
  // PDF and HTML activate only when the loaded bytes are renderable; otherwise the existing view stays (P3).
  const active = createMemo(() => {
    const k = kind()
    if (!k || !props.state?.loaded) return false
    if (k === "html" && source()) return false
    if (k === "pdf" || k === "html") return hasRenderablePreview(props.path!, props.state.content)
    return true
  })

  createEffect(() => {
    if (kind() !== "docx" || !props.state?.loaded) return
    for (const candidate of companionCandidates(props.path!)) void file.load(candidate)
  })
  const companion = createMemo<Companion | undefined>(() => {
    if (kind() !== "docx") return
    for (const candidate of companionCandidates(props.path!)) {
      const content = file.get(candidate)?.content
      if (hasRenderablePreview(candidate, content)) return { path: candidate, content }
    }
  })

  const canOpen = createMemo(() => platform.platform === "desktop" && !!platform.openPath && server.isLocal())
  const openExternal = () => {
    const relative = props.path
    if (!platform.openPath || !isPreviewPathAllowed(relative)) return
    const root = sdk().directory.replace(/[\\/]+$/, "")
    // Same feedback as the session header's "Open in" (components/session/open-in-app.tsx:116), without the raw error.
    void platform
      .openPath(`${root}/${relative}`)
      .catch(() => showToast({ variant: "error", title: language.t("common.requestFailed") }))
  }

  const t = (key: Parameters<FilePreviewBodyProps["t"]>[0], params?: Record<string, string>) =>
    language.t(key, params)

  const toggle = (label: string, next: boolean) => (
    <div class="flex items-center justify-end px-3 pb-2">
      <Button size="small" variant="ghost" data-slot="file-preview-toggle" onClick={() => setSource(next)}>
        {label}
      </Button>
    </div>
  )

  return (
    <Show
      when={active()}
      fallback={
        <Show when={kind() === "html" && props.state?.loaded} fallback={props.children}>
          <div class="relative h-full min-h-0 flex flex-col">
            {toggle(language.t("file.preview.showPreview"), false)}
            <div class="flex-1 min-h-0">{props.children}</div>
          </div>
        </Show>
      }
    >
      <FilePreviewBody
        path={props.path!}
        content={props.state?.content}
        companion={companion()}
        t={t}
        onOpenExternal={canOpen() ? openExternal : undefined}
        toolbar={kind() === "html" ? toggle(language.t("file.preview.showSource"), true) : undefined}
      />
    </Show>
  )
}
