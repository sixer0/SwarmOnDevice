// Composer region (FS §9.1 items 3, 3b, 4; FR-22, FR-43b, FR-58, FR-61; design §5): the
// first-run disclosure, the two-option context control with its permanent notice, and the
// prompt field with Send / Stop.
import { For, Show } from "solid-js"
import { OFFICE_CONTEXT_SELECTION, OFFICE_CONTEXT_WHOLE } from "../constants"
import { useI18n, type MessageKey } from "../i18n"
import type { ContextScope } from "../state/prompt"
import { FirstRunNotice } from "./disclosure"
import { StopIcon } from "./icons"

const HELPER_ID = "swarm-office-prompt-helper"

function ContextControl(props: { scope: ContextScope; excel: boolean; onChange: (scope: ContextScope) => void }) {
  const { t } = useI18n()
  const options = (): { scope: ContextScope; key: MessageKey }[] => [
    { scope: OFFICE_CONTEXT_SELECTION, key: "office.context.selection" },
    { scope: OFFICE_CONTEXT_WHOLE, key: props.excel ? "office.context.usedRange" : "office.context.whole" },
  ]
  // One tab stop; arrow keys move between the two options (design §9.1).
  const move = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return
    event.preventDefault()
    const next = props.scope === OFFICE_CONTEXT_SELECTION ? OFFICE_CONTEXT_WHOLE : OFFICE_CONTEXT_SELECTION
    props.onChange(next)
    const group = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
    group?.querySelector<HTMLElement>(`[data-scope="${next}"]`)?.focus()
  }
  return (
    <div class="chip" role="radiogroup" aria-label={t("office.context.label")} data-control="context" onKeyDown={move}>
      <For each={options()}>
        {(option) => (
          <button
            type="button"
            role="radio"
            data-scope={option.scope}
            aria-checked={props.scope === option.scope ? "true" : "false"}
            tabindex={props.scope === option.scope ? 0 : -1}
            onClick={() => props.onChange(option.scope)}
          >
            {t(option.key)}
          </button>
        )}
      </For>
    </div>
  )
}

export function Composer(props: {
  excel: boolean
  acknowledged: boolean
  scope: ContextScope
  draft: string
  busy: boolean
  canSend: boolean
  // FR-25 (M8-06): the typed text alone is over 2 MiB. Send stays disabled; Enter or a click
  // still reaches the controller, which shows office.error.tooLarge and sends nothing.
  tooLarge?: boolean
  onAcknowledge: () => void
  onScope: (scope: ContextScope) => void
  onDraft: (text: string) => void
  onSend: () => void
  onStop: () => void
}) {
  const { t } = useI18n()
  const send = () => {
    if (props.canSend || (props.tooLarge && !props.busy)) props.onSend()
  }
  return (
    <div class="cmp" role="form" data-part="composer">
      <Show when={!props.acknowledged}>
        <FirstRunNotice onAcknowledge={props.onAcknowledge} />
      </Show>
      <ContextControl scope={props.scope} excel={props.excel} onChange={props.onScope} />
      <p class="notice">{t("office.context.notice")}</p>
      <div class="ta">
        <textarea
          rows="2"
          data-control="prompt"
          placeholder={t("office.prompt.placeholder")}
          aria-label={t("office.prompt.placeholder")}
          aria-describedby={props.acknowledged ? undefined : HELPER_ID}
          value={props.draft}
          onInput={(event) => {
            props.onDraft(event.currentTarget.value)
            // 2 lines minimum, grows to 8 lines (172 px), then scrolls inside (design §5.3).
            const field = event.currentTarget
            field.style.height = "auto"
            field.style.height = `${Math.min(field.scrollHeight, 172)}px`
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && props.busy) {
              event.preventDefault()
              props.onStop()
              return
            }
            if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
            event.preventDefault()
            send()
          }}
        />
        <Show
          when={props.busy}
          fallback={
            <button
              class="btn primary send"
              type="button"
              data-control="send"
              aria-disabled={props.canSend ? undefined : "true"}
              onClick={send}
            >
              {t("office.prompt.send")}
            </button>
          }
        >
          <button class="btn neutral send" type="button" data-control="stop" onClick={props.onStop}>
            <StopIcon />
            {t("office.prompt.stop")}
          </button>
        </Show>
      </div>
      <Show when={!props.acknowledged}>
        <p class="helper" id={HELPER_ID}>
          {t("office.prompt.ackFirst")}
        </p>
      </Show>
    </div>
  )
}
