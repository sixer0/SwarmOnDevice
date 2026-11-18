// Chat bar (FS FR-56, design §3), `connected` only: one native <select> (current chat first,
// then the recent Office chats of this host, newest first, at most 20) and the New chat icon
// button, disabled while streaming. Named session-bar so M8-06 keeps the `chat*` file names.
import { For } from "solid-js"
import { useI18n } from "../i18n"
import type { SessionSummary } from "../state/session"
import { PlusIcon } from "./icons"

const CURRENT = ""

export function SessionBar(props: {
  title?: string
  current?: string
  recent: SessionSummary[]
  busy: boolean
  onPick: (sessionID: string) => void
  onNew: () => void
}) {
  const { t } = useI18n()
  const others = () => props.recent.filter((session) => session.id !== props.current)
  return (
    <div class="cb" data-part="chat-bar">
      <select
        aria-label={t("office.session.recent")}
        data-control="chat-select"
        disabled={props.busy}
        value={CURRENT}
        onChange={(event) => {
          const value = event.currentTarget.value
          event.currentTarget.value = CURRENT
          if (value !== CURRENT) props.onPick(value)
        }}
      >
        <option value={CURRENT}>{props.title || t("office.session.untitled")}</option>
        <For each={others()}>{(session) => <option value={session.id}>{session.title}</option>}</For>
      </select>
      <button
        class="ib"
        type="button"
        data-control="new-chat"
        aria-label={t("office.session.new")}
        title={t("office.session.new")}
        aria-disabled={props.busy ? "true" : undefined}
        onClick={() => {
          if (!props.busy) props.onNew()
        }}
      >
        <PlusIcon />
      </button>
    </div>
  )
}
