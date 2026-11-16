// Pane entry (plan M8-05). Renders at once in `loading` (T1), so the T2 timer runs even when
// Office.js never loads; Office.onReady then supplies the host (T3). No URL routing (FR-46).
import "@opencode-ai/ui/v2/styles/colors.css"
import "@opencode-ai/ui/v2/styles/theme.css"
import "./views/pane.css"
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { createOfficeApi } from "./api/client"
import { App } from "./app"
import { excelHost } from "./host/excel"
import { wordHost } from "./host/word"
import { detectLocale } from "./i18n"
import { readToken, type PaneStore } from "./state/storage"
import { copyText } from "./views/chat-clipboard"
import { createPaneController } from "./views/controller"
import { watchScheme, type OfficeThemeLike } from "./views/theme"

const officePresent = () => typeof Office !== "undefined"

// REG §5: every key carries the `${partitionKey}:` prefix when Office defines one.
const store: PaneStore = {
  storage: localStorage,
  get partitionKey() {
    return officePresent() ? (Office.context?.partitionKey ?? undefined) : undefined
  },
}

// FR-57 with the H-UI-3 fallback (views/chat-clipboard.ts).
const clipboard = (text: string) => copyText({ clipboard: navigator.clipboard, document }, text)

const api = createOfficeApi({ token: () => readToken(store) })

const controller = createPaneController({
  api,
  store,
  adapter: (host) => (host === "Excel" ? excelHost() : wordHost()),
  documentUrl: () => (officePresent() ? Office.context.document?.url : undefined),
  officePresent,
  clipboard,
})

const media = (query: string) => (typeof matchMedia === "function" ? matchMedia(query) : undefined)
const motionQuery = media("(prefers-reduced-motion: reduce)")
const [reducedMotion, setReducedMotion] = createSignal(motionQuery?.matches === true)
motionQuery?.addEventListener("change", () => setReducedMotion(motionQuery.matches))

const [locale, setLocale] = createSignal(detectLocale({ navigatorLanguage: navigator.language }))

const officeTheme = (): OfficeThemeLike => (officePresent() ? Office.context?.officeTheme : undefined)
const scheme = {
  dispose: watchScheme({ officeTheme, media: media("(prefers-color-scheme: dark)"), root: document.documentElement }),
}

const root = document.getElementById("root")
if (root) {
  render(() => <App controller={controller} locale={locale()} reducedMotion={reducedMotion} />, root)
  controller.start()

  if (officePresent()) {
    Office.onReady((info) => {
      const next = detectLocale({ displayLanguage: Office.context?.displayLanguage, navigatorLanguage: navigator.language })
      document.documentElement.lang = next
      setLocale(next)
      // Re-resolve now that Office.context.officeTheme exists (FR-62), and follow its changes.
      scheme.dispose()
      scheme.dispose = watchScheme({
        officeTheme,
        media: media("(prefers-color-scheme: dark)"),
        root: document.documentElement,
        subscribeOffice: (listener) => {
          // OfficeThemeChanged is not in every host's event set (H-UI-1); a refusal is ignored.
          try {
            Office.context.document?.addHandlerAsync?.(Office.EventType.OfficeThemeChanged, listener)
          } catch {
            return
          }
        },
      })
      controller.officeReady({
        host: String(info.host ?? ""),
        readOnly: Office.context?.document?.mode === Office.DocumentMode.ReadOnly,
      })
    })
  }
}
