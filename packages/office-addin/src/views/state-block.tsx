// State views for every state other than `connected` (FS §8.1, design §7 S1-S7): one centred
// block with an icon, a title, one line of text and at most one button. The single button gets
// focus when the state is entered; in `pairing` (no button) focus goes to the code.
import { Match, Show, Switch, onMount } from "solid-js"
import { useI18n } from "../i18n"
import type { ConnectionState } from "../state/machine"
import { Mark, OffIcon, WarnIcon } from "./icons"

function Steps() {
  const { t } = useI18n()
  return (
    <ol class="steps">
      <li>
        <b>1</b>
        <span>{t("office.connect.step1")}</span>
      </li>
      <li>
        <b>2</b>
        <span>{t("office.connect.step2")}</span>
      </li>
    </ol>
  )
}

function Focused(props: { control: string; label: string; onClick: () => void }) {
  const ref = { el: undefined as HTMLButtonElement | undefined }
  onMount(() => ref.el?.focus())
  return (
    <button ref={(el) => (ref.el = el)} class="btn primary" type="button" data-control={props.control} onClick={props.onClick}>
      {props.label}
    </button>
  )
}

function PairingCode(props: { code: string }) {
  const { t } = useI18n()
  const ref = { el: undefined as HTMLDivElement | undefined }
  onMount(() => ref.el?.focus())
  return (
    <div
      ref={(el) => (ref.el = el)}
      class="code"
      tabindex="-1"
      data-part="pairing-code"
      aria-label={t("office.connect.codeLabel", { digits: [...props.code].join(" ") })}
    >
      {props.code}
    </div>
  )
}

export function StateBlock(props: { state: ConnectionState; motion: boolean; onRetry: () => void; onConnect: () => void }) {
  const { t } = useI18n()
  return (
    <Switch>
      <Match when={props.state.name === "loading" && props.state.officeJsMissing}>
        <div class="sb" role="alert" data-view="office-js-missing">
          <div class="ico warn">
            <WarnIcon />
          </div>
          <p>{t("office.error.officeJsMissing")}</p>
        </div>
      </Match>
      <Match when={props.state.name === "loading"}>
        <div class="sb" role="status" data-view="loading">
          <div class="spin" classList={{ rotate: props.motion }} aria-hidden="true" />
          <p>{t("office.status.loading")}</p>
        </div>
      </Match>
      <Match when={props.state.name === "unsupported-host"}>
        <div class="sb" data-view="unsupported-host">
          <div class="ico">
            <OffIcon />
          </div>
          <h3>{t("office.status.unsupportedHost")}</h3>
        </div>
      </Match>
      <Match when={props.state.name === "unavailable"}>
        <div class="sb" data-view="unavailable">
          <div class="ico bad">
            <WarnIcon />
          </div>
          <h3>{t("office.status.unavailable")}</h3>
          <p>{t("office.status.unavailableHint")}</p>
          <Focused control="retry" label={t("office.status.retry")} onClick={props.onRetry} />
        </div>
      </Match>
      <Match when={props.state.name === "unpaired"}>
        <div class="sb" data-view="unpaired">
          <Show when={!props.state.notice}>
            <div class="ico">
              <Mark class="mark-lg" />
            </div>
          </Show>
          <h3>{t("office.connect.intro")}</h3>
          <Steps />
          <Focused control="connect" label={t("office.connect.button")} onClick={props.onConnect} />
        </div>
      </Match>
      <Match when={props.state.name === "pairing" && props.state.pairing}>
        {(pairing) => (
          <div class="sb" data-view="pairing">
            <h3>{t("office.connect.pending", { code: pairing().code })}</h3>
            <PairingCode code={pairing().code} />
            <p>{t("office.connect.matchHint")}</p>
            <p>{t("office.connect.pendingHint")}</p>
          </div>
        )}
      </Match>
      <Match when={props.state.name === "denied"}>
        <div class="sb" data-view="denied">
          <div class="ico bad">
            <OffIcon />
          </div>
          <h3>{t("office.connect.denied")}</h3>
          <Focused control="connect" label={t("office.connect.button")} onClick={props.onConnect} />
        </div>
      </Match>
    </Switch>
  )
}
