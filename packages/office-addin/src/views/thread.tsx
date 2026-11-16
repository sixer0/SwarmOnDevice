// Thread (FS §9.1 item 2, FR-40, FR-41, FR-57, FR-59, FR-64; design §4). Plain text only
// (SC-40): every string is a Solid text binding, which becomes a DOM text node; no HTML string is
// ever parsed. The thread is role="log" and NOT aria-live (design §9.3).
//
// Preview slot: Insert and Replace ask the controller to open a preview for that reply; the
// block itself is rendered by the App's `preview` render prop, implemented by M8-06/M8-07.
import { For, Match, Show, Switch, type JSX } from "solid-js"
import { useI18n, type MessageKey } from "../i18n"
import type { Reply } from "../state/stream"
import type { PreviewRequest, ThreadItem, TurnEnd, TurnTag } from "./controller"
import { ProviderLine } from "./disclosure"

export type PreviewSlot = (input: { request: PreviewRequest; close: () => void }) => JSX.Element

const scopeKey = (tag: TurnTag, excel: boolean): MessageKey => {
  if (tag.kind === "none" || tag.scope === "selection") return "office.context.selection"
  return excel ? "office.context.usedRange" : "office.context.whole"
}

function Tag(props: { tag: TurnTag; excel: boolean }) {
  const { t } = useI18n()
  const text = () => {
    const tag = props.tag
    if (tag.kind === "none") return t("office.context.none")
    const scope = t(scopeKey(tag, props.excel))
    if (tag.kind === "chars") return t("office.context.tagChars", { scope, count: tag.count })
    if (tag.kind === "cells")
      return t("office.context.tagCells", { scope, address: tag.address, rows: tag.rows, cols: tag.cols })
    return scope
  }
  return <div class="tag">{text()}</div>
}

const endKey = (end: TurnEnd): MessageKey => (end === "stopped" ? "office.reply.stopped" : "office.reply.interrupted")

type ReplyActions = {
  busy: boolean
  readOnly: boolean
  onPreview: (request: PreviewRequest) => void
  // FR-57 (M8-06): the controller writes the clipboard and owns the 2 s "Copied" label.
  onCopy: (reply: Reply) => Promise<boolean>
  // messageID whose Copy label currently reads "Copied".
  copied?: string
}

function Actions(props: { reply: Reply; actions: ReplyActions }) {
  const { t } = useI18n()
  const copied = () => props.actions.copied === props.reply.messageID
  const empty = () => props.reply.text === ""
  const writeOff = () => props.actions.busy || props.actions.readOnly || empty()
  const why = () => (props.actions.readOnly ? t("office.doc.readOnly") : undefined)
  const open = (action: "insert" | "replace") => () => {
    if (writeOff()) return
    props.actions.onPreview({ messageID: props.reply.messageID, action, text: props.reply.text })
  }
  return (
    <div class="acts">
      <button
        class="btn sm neutral"
        type="button"
        data-control="insert"
        aria-disabled={writeOff() ? "true" : undefined}
        title={why()}
        onClick={open("insert")}
      >
        {t("office.reply.insert")}
      </button>
      <button
        class="btn sm neutral"
        type="button"
        data-control="replace"
        aria-disabled={writeOff() ? "true" : undefined}
        title={why()}
        onClick={open("replace")}
      >
        {t("office.reply.replace")}
      </button>
      <button
        class="btn sm neutral"
        type="button"
        data-control="copy"
        aria-disabled={empty() ? "true" : undefined}
        onClick={() => {
          if (empty()) return
          void props.actions.onCopy(props.reply)
        }}
      >
        {copied() ? t("office.reply.copied") : t("office.reply.copy")}
      </button>
    </div>
  )
}

function ReplyView(props: {
  item: Extract<ThreadItem, { kind: "reply" }>
  motion: boolean
  actions: ReplyActions
  preview?: PreviewRequest
  slot?: PreviewSlot
  onClosePreview: () => void
  detached?: boolean
}) {
  const { t } = useI18n()
  const reply = () => props.item.reply
  const box = { el: undefined as HTMLDivElement | undefined }
  // Closing the preview (Cancel, Esc, or the slot's own close) puts focus back on the button
  // that opened it (design §9.1, FR-61).
  const close = (action: PreviewRequest["action"]) => {
    props.onClosePreview()
    box.el?.querySelector<HTMLElement>(`[data-control="${action}"]`)?.focus()
  }
  return (
    <div ref={(el) => (box.el = el)} class="turn-a" data-part="reply" aria-busy={props.item.streaming ? "true" : undefined}>
      <div class="tx" data-part="reply-text">
        {reply().text}
        <Show when={props.item.streaming}>
          <span class="caret" classList={{ blink: props.motion }} aria-hidden="true" />
        </Show>
      </div>
      <Show when={props.item.end}>
        {(end) => <span class={end() === "stopped" ? "rtag" : "rtag bad"}>{t(endKey(end()))}</span>}
      </Show>
      <Show when={!props.item.streaming && !props.detached}>
        <Actions reply={reply()} actions={props.actions} />
        <Show when={props.preview?.messageID === reply().messageID && props.preview}>
          {(request) => (
            <div
              class="pv-slot"
              data-slot="preview"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                event.preventDefault()
                event.stopPropagation()
                close(request().action)
              }}
            >
              {props.slot?.({ request: request(), close: () => close(request().action) })}
            </div>
          )}
        </Show>
      </Show>
      <Show when={!props.item.streaming}>
        <ProviderLine providerID={reply().providerID} modelID={reply().modelID} />
      </Show>
    </div>
  )
}

export function Thread(props: {
  items: ThreadItem[]
  excel: boolean
  motion: boolean
  actions: ReplyActions
  preview?: PreviewRequest
  slot?: PreviewSlot
  onClosePreview: () => void
  // T16 (FS §8.2): the list stays on screen in `unavailable`, without reply actions.
  detached?: boolean
}) {
  const { t } = useI18n()
  return (
    <div class="th" role="log" aria-label={t("office.thread.label")} data-part="thread">
      <Show when={props.items.length > 0} fallback={<p class="empty">{t("office.thread.empty")}</p>}>
        <For each={props.items}>
          {(item) => (
            <Switch>
              <Match when={item.kind === "user" && item}>
                {(user) => (
                  <div class="turn-u" data-part="user-turn">
                    <Show when={user().tag}>{(tag) => <Tag tag={tag()} excel={props.excel} />}</Show>
                    <div class="tx">{user().text}</div>
                  </div>
                )}
              </Match>
              <Match when={item.kind === "reply" && item}>
                {(reply) => (
                  <ReplyView
                    item={reply()}
                    motion={props.motion}
                    actions={props.actions}
                    preview={props.preview}
                    slot={props.slot}
                    onClosePreview={props.onClosePreview}
                    detached={props.detached}
                  />
                )}
              </Match>
              <Match when={item.kind === "waiting"}>
                <div class="turn-a" data-part="waiting" aria-busy="true">
                  <div class="tx waiting">
                    {t("office.reply.waiting")}
                    <span class="caret" classList={{ blink: props.motion }} aria-hidden="true" />
                  </div>
                </div>
              </Match>
              <Match when={item.kind === "end" && item}>
                {(end) => (
                  <div class="turn-a">
                    <span class={end().end === "stopped" ? "rtag" : "rtag bad"}>{t(endKey(end().end))}</span>
                  </div>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </Show>
    </div>
  )
}
