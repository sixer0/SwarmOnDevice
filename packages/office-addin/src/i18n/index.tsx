// Pane i18n provider (REG §8.3, FS FR-52). Pure translation and locale detection live in
// translate.ts so they load without JSX.
import { createContext, createMemo, useContext, type ParentProps } from "solid-js"
import { createTranslate, type Locale, type Translate } from "./translate"

export { createTranslate, detectLocale, dictionary } from "./translate"
export type { Locale, MessageKey, Params, Translate } from "./translate"

const I18nContext = createContext<{ t: Translate; locale: Locale }>()

// Reactive on `locale`: the pane renders before Office.onReady (T1/T2) and switches once when
// Office reports its display language.
export function I18nProvider(props: ParentProps<{ locale: Locale }>) {
  const current = createMemo(() => createTranslate(props.locale))
  const value = {
    t: ((key, params) => current()(key, params)) as Translate,
    get locale() {
      return props.locale
    },
  }
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
}

export function useI18n() {
  const value = useContext(I18nContext)
  if (!value) throw new Error("useI18n outside I18nProvider")
  return value
}
