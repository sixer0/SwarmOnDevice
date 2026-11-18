// Banner slot (design §1 region 3, §7 S5b/S14/S15): at most one toast, plus the persistent
// read-only banner (FR-60) and the expired-request strip of `unpaired` (T13). Errors use
// role="alert" and stay until dismissed; success uses role="status" (design §9.3).
import { Show } from "solid-js"
import { useI18n } from "../i18n"
import type { Toast } from "./controller"
import { LockIcon, WarnIcon } from "./icons"

export function BannerSlot(props: { toast?: Toast; readOnly: boolean; expired: boolean; onDismiss: () => void }) {
  const { t } = useI18n()
  return (
    <Show when={props.toast || props.readOnly || props.expired}>
      <div class="slot">
        <Show when={props.toast}>
          {(toast) => (
            <div
              class="banner"
              classList={{ bad: toast().tone === "error", ok: toast().tone === "success" }}
              role={toast().tone === "error" ? "alert" : "status"}
              data-part="toast"
            >
              <WarnIcon />
              <p>{t(toast().key, toast().params)}</p>
              <button class="x-btn" type="button" data-control="toast-dismiss" onClick={props.onDismiss}>
                {t("office.toast.dismiss")}
              </button>
            </div>
          )}
        </Show>
        <Show when={props.expired}>
          <div class="banner warn" role="status" data-part="expired">
            <WarnIcon />
            <p>{t("office.connect.expired")}</p>
          </div>
        </Show>
        <Show when={props.readOnly}>
          <div class="banner neutral" role="status" data-part="read-only">
            <LockIcon />
            <p>{t("office.doc.readOnly")}</p>
          </div>
        </Show>
      </div>
    </Show>
  )
}
