// The pane: one view (FS §9.1, FR-43; design §1). Header, then the banner slot, then either the
// state block (every state but `connected`) or the chat: chat bar, thread, composer. One hidden
// polite live region announces "Reply finished", the written target and state changes once.
//
// Region order follows the focus order of design §9.1: the toast (with Dismiss) sits directly
// under the header, before the chat bar.
import { Show, createEffect } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { I18nProvider, useI18n, type Locale } from "./i18n"
import { BannerSlot } from "./views/banner"
import { Composer } from "./views/composer"
import type { PaneController, ThreadItem } from "./views/controller"
import { Header } from "./views/header"
import { previewSlot } from "./views/preview"
import { SessionBar } from "./views/session-bar"
import { StateBlock } from "./views/state-block"
import { Thread, type PreviewSlot } from "./views/thread"

type AppProps = {
  controller: PaneController
  locale: Locale
  // True under `prefers-reduced-motion: reduce`: no blink, pulse or rotation class is applied.
  reducedMotion?: () => boolean
  // Renders the inline preview block under a reply after Insert or Replace. Defaults to the
  // M8-07 preview (views/preview.tsx); a test may pass its own.
  preview?: PreviewSlot
}

function Pane(props: AppProps) {
  const { t } = useI18n()
  const pane = props.controller
  pane.useTranslate(t)
  const motion = () => !props.reducedMotion?.()
  const excel = () => pane.conn().host === "Excel"
  const [items, setItems] = createStore<ThreadItem[]>([])
  createEffect(() => setItems(reconcile(pane.thread(), { key: "key", merge: true })))

  return (
    <div class="pane" data-host={pane.conn().host?.toLowerCase()}>
      <Header state={pane.conn()} motion={motion()} />
      <BannerSlot
        toast={pane.toast()}
        readOnly={pane.conn().name === "connected" && pane.readOnly()}
        expired={pane.conn().name === "unpaired" && pane.conn().notice === "office.connect.expired"}
        onDismiss={pane.dismissToast}
      />
      <Show
        when={pane.conn().name === "connected"}
        fallback={
          <>
            <StateBlock state={pane.conn()} motion={motion()} onRetry={pane.retry} onConnect={pane.connect} />
            {/* T16 (FS §8.2): a lost connection keeps the message list on screen, without actions. */}
            <Show when={pane.conn().name === "unavailable" && items.length > 0}>
              <Thread
                items={items}
                excel={excel()}
                motion={motion()}
                actions={{ busy: true, readOnly: true, onPreview: () => {}, onCopy: async () => false }}
                onClosePreview={pane.closePreview}
                detached
              />
            </Show>
          </>
        }
      >
        <SessionBar
          title={pane.title()}
          current={pane.stream().sessionID}
          recent={pane.recent()}
          busy={pane.busy()}
          onPick={(id) => void pane.pick(id)}
          onNew={pane.newChat}
        />
        <Thread
          items={items}
          excel={excel()}
          motion={motion()}
          actions={{
            // FR-48: Insert and Replace are off while a reply streams or a write runs; Copy is not.
            busy: pane.busy() || pane.writing(),
            readOnly: pane.readOnly(),
            onPreview: pane.openPreview,
            onCopy: pane.copy,
            copied: pane.copied(),
          }}
          preview={pane.preview()}
          slot={props.preview ?? previewSlot(pane)}
          onClosePreview={pane.closePreview}
        />
        <Composer
          excel={excel()}
          acknowledged={pane.acknowledged()}
          scope={pane.scope()}
          draft={pane.draft()}
          busy={pane.busy()}
          canSend={pane.canSend()}
          tooLarge={pane.tooLarge()}
          onAcknowledge={pane.acknowledge}
          onScope={pane.setScope}
          onDraft={pane.setDraft}
          onSend={() => void pane.send()}
          onStop={() => void pane.stop()}
        />
      </Show>
      <div class="sr" aria-live="polite" data-part="live">
        {pane.announcement()}
      </div>
    </div>
  )
}

export function App(props: AppProps) {
  return (
    <I18nProvider locale={props.locale}>
      <Pane {...props} />
    </I18nProvider>
  )
}
