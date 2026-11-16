// Provider disclosure (plan M8-07; FS §9.1 item 3b, FR-43b, FR-59; design §4.3, §5.1; C9 SC-50,
// C10, U12 Q3/Q4). Two inline parts, no dialog (FR-43):
//   - FirstRunNotice: a static card above the context control until the user acknowledges it.
//     The acknowledgement is stored per host (`swarm.office.disclosureAck` under the partition
//     prefix, REG §5) by the controller; Send stays disabled until then. The body is static text
//     (the default is the internal GSP-AI); no request is made to learn the provider.
//   - ProviderLine: under each finished reply, the provider and model from `message.updated`.
//     A providerID outside INTERNAL_PROVIDER_IDS gets the warning style (external, may be billed).
import { Show } from "solid-js"
import { INTERNAL_PROVIDER_IDS } from "../constants"
import { useI18n } from "../i18n"

export function isInternalProvider(providerID: string | undefined) {
  return INTERNAL_PROVIDER_IDS.some((id) => id === providerID)
}

export function FirstRunNotice(props: { onAcknowledge: () => void }) {
  const { t } = useI18n()
  return (
    <div class="disc" data-part="disclosure">
      <h4>{t("office.disclosure.title")}</h4>
      <p>{t("office.disclosure.body")}</p>
      <div>
        <button class="btn sm neutral" type="button" data-control="disclosure-ack" onClick={props.onAcknowledge}>
          {t("office.disclosure.ack")}
        </button>
      </div>
    </div>
  )
}

// Nothing is shown until `message.updated` named the provider (design §4.3, "not yet known").
export function ProviderLine(props: { providerID?: string; modelID?: string }) {
  const { t } = useI18n()
  return (
    <Show when={props.providerID}>
      <Show
        when={isInternalProvider(props.providerID)}
        fallback={
          <div class="prov ext" role="note" data-part="provider" data-provider="external">
            {t("office.reply.providerExternal", { provider: props.providerID ?? "", model: props.modelID ?? "" })}
          </div>
        }
      >
        <div class="prov" data-part="provider" data-provider="internal">
          {t("office.reply.providerInternal", { model: props.modelID ?? "" })}
        </div>
      </Show>
    </Show>
  )
}
