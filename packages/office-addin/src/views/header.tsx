// Header (FS §9.1 item 1, FR-55, design §3): mark, title, host badge, status dot with a text
// label. No settings, overflow or disconnect control (AC-12).
import { Show } from "solid-js"
import { useI18n } from "../i18n"
import type { ConnectionState } from "../state/machine"
import { statusOf } from "./controller"
import { Mark } from "./icons"

export function Header(props: { state: ConnectionState; motion: boolean }) {
  const { t } = useI18n()
  const status = () => statusOf(props.state)
  return (
    <header class="hd" role="banner">
      <Mark />
      <span class="hd-title">{t("office.title")}</span>
      <Show when={props.state.host}>{(host) => <span class="badge" data-part="host-badge">{host()}</span>}</Show>
      <span class="sp" />
      <span class="st" aria-live="polite" data-part="status">
        <i
          class={`dot ${status().tone}${status().pulse && props.motion ? " pulse" : ""}`}
          data-tone={status().tone}
          aria-hidden="true"
        />
        <span class="st-label">{status().label ? t(status().label!) : ""}</span>
      </span>
    </header>
  )
}
