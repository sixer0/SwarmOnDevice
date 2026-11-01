import { createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

const SHOWN = 6

/**
 * Asks once when a folder has its own code or rules to load. The server holds them back whether or not this renders, so
 * nothing here is a safeguard: a failed check shows nothing and the folder stays as it is, without those items.
 */
export function SessionTrustDock() {
  const language = useLanguage()
  const sdk = useSDK()
  const [responding, setResponding] = createSignal(false)
  const [answered, setAnswered] = createSignal<string>()
  const [status] = createResource(
    () => sdk().directory,
    () =>
      sdk()
        .client.project.trust()
        .then((response) => response.data)
        .catch(() => undefined),
  )
  const items = () => status()?.items ?? []
  const decide = (decision: "trust" | "later") => {
    setResponding(true)
    void sdk()
      .client.project.trustDecide({ decision }, { throwOnError: true })
      .then(() => setAnswered(sdk().directory))
      .catch((err: unknown) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => setResponding(false))
  }

  return (
    <Show when={status()?.state === "ask" && answered() !== sdk().directory}>
      <div data-component="session-trust-dock">
        <DockPrompt
          kind="permission"
          header={
            <div data-slot="permission-row" data-variant="header">
              <span data-slot="permission-icon">
                <Icon name="warning" size="normal" />
              </span>
              <div data-slot="permission-header-title">{language.t("session.trust.question")}</div>
            </div>
          }
          footer={
            <>
              <div class="min-w-0 text-12-regular text-text-weak">{status()?.directory}</div>
              <div data-slot="permission-footer-actions">
                <Button
                  variant="ghost"
                  size="normal"
                  data-trust-later
                  disabled={responding()}
                  onClick={() => decide("later")}
                >
                  {language.t("session.trust.later")}
                </Button>
                <Button
                  variant="primary"
                  size="normal"
                  data-trust-accept
                  disabled={responding()}
                  onClick={() => decide("trust")}
                >
                  {language.t("session.trust.trust")}
                </Button>
              </div>
            </>
          }
        >
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-patterns">
              <For each={items().slice(0, SHOWN)}>
                {(item) => (
                  <code class="text-12-regular text-text-base break-all" title={item.source}>
                    {item.label}
                  </code>
                )}
              </For>
              <Show when={items().length > SHOWN}>
                <span class="text-12-regular text-text-weak">
                  {language.t("common.moreCountSuffix", { count: items().length - SHOWN })}
                </span>
              </Show>
            </div>
          </div>
        </DockPrompt>
      </div>
    </Show>
  )
}
