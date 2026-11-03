import { createEffect, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import type { SetupToolsPlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { SETUP_COMPONENT_IDS, type SetupComponentId } from "@/context/setup-status"
import {
  createToolsController,
  initialToolsSnapshot,
  initialToolsUi,
  PREVIEW_RETRY_MAX,
  reportToolsError,
  resultLine,
  toolRow,
  TOOLS_TERMINAL_COMMAND,
} from "./dialog-install-tools.model"

/** One dialog for the bundled swarm-setup: seven ticks, the dry-run text as printed, progress per component.
 *  Opened by the first-run offer (row 230, `offer`) and `tools.install` (row 231) with `platform.setupTools`.
 *  Install selected asks main, which shows the native confirmation before anything runs (C80 F1). */
export function DialogInstallTools(props: { api: SetupToolsPlatform; offer?: boolean }) {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [ui, setUi] = createStore(initialToolsUi({ offer: props.offer, now: Date.now() }))
  const [state, setState] = createStore(initialToolsSnapshot())

  const controller = createToolsController({
    api: props.api,
    dispose: () => serverSDK().client.global.dispose(),
    report: reportToolsError((input) => serverSDK().client.app.log(input), "app.tools-dialog"),
    onChange: (next) => setState(reconcile(next)),
  })

  onMount(() => void controller.open())
  // The countdown clock only ticks while a failed preview still has a retry to wait for.
  createEffect(() => {
    if (state.preview.kind !== "failed" || state.preview.retries >= PREVIEW_RETRY_MAX) return
    setUi("now", Date.now())
    const ticker = setInterval(() => setUi("now", Date.now()), 1000)
    onCleanup(() => clearInterval(ticker))
  })

  const running = () => state.phase === "running"
  // Read from the store (reactive); the controller's own guard still decides whether a click runs.
  const canInstall = () =>
    !running() && state.preview.kind === "ready" && SETUP_COMPONENT_IDS.some((id) => state.ticked[id])
  const previewRun = () => (state.preview.kind === "ready" ? state.preview.run : undefined)
  const previewFailed = () => (state.preview.kind === "failed" ? state.preview : undefined)
  const retryIn = () => {
    const failed = previewFailed()
    return failed ? Math.max(0, Math.ceil((failed.retryAt - ui.now) / 1000)) : 0
  }
  const retriesLeft = () => (previewFailed()?.retries ?? PREVIEW_RETRY_MAX) < PREVIEW_RETRY_MAX

  const later = () => {
    void controller.later()
    dialog.close()
  }

  const status = (id: SetupComponentId) => {
    const row = toolRow({
      id,
      state: state.states[id],
      step: state.steps[id],
      running: running(),
      ticked: state.ticked[id],
    })
    switch (row.kind) {
      case "healthy":
        return language.t("dialog.tools.healthy")
      case "skipped":
        return language.t("dialog.tools.skipped", { reason: row.reason })
      case "failed":
        return language.t("dialog.tools.failed", { reason: row.reason })
      case "progress":
        return row.state
      case "token":
        return row.state ? `${row.token} (${row.state})` : row.token
      default:
        return ""
    }
  }

  return (
    <Dialog title={language.t("dialog.tools.title")} class="w-full max-w-[560px] mx-auto">
      <div data-tools-dialog class="flex min-h-0 flex-1 flex-col gap-4 p-6 pt-0">
        <p class="shrink-0 text-14-regular text-text-base">{language.t("dialog.tools.body")}</p>

        {/* The action row sits above the list so Install stays in view however long the statuses or result run. */}
        <div data-tools-actions class="flex shrink-0 justify-end gap-2">
          <Show
            when={state.phase === "done"}
            fallback={
              <Button variant="ghost" disabled={running()} onClick={later}>
                {language.t("dialog.tools.later")}
              </Button>
            }
          >
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.close")}
            </Button>
          </Show>
          <Button variant="primary" disabled={!canInstall()} onClick={() => void controller.install()}>
            <Show when={running()}>
              <Spinner class="size-3" />
            </Show>
            {language.t("dialog.tools.install")}
          </Button>
        </div>

        <div data-tools-scroll class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div class="flex flex-col gap-2">
            <For each={SETUP_COMPONENT_IDS}>
              {(id) => (
                <div class="flex items-center justify-between gap-3">
                  <div class="shrink-0">
                    <Checkbox
                      checked={state.ticked[id]}
                      disabled={running()}
                      onChange={(value: boolean) => controller.toggle(id, value)}
                    >
                      {id}
                    </Checkbox>
                  </div>
                  {/* One line per tool: a long reason ends in an ellipsis, the full text is on hover. */}
                  <span class="flex min-w-0 items-center gap-2 text-12-regular text-text-weak">
                    <Show when={running() && state.ticked[id] && !state.steps[id] && state.states[id] !== "healthy"}>
                      <Spinner class="size-3 shrink-0" />
                    </Show>
                    <span data-tools-status class="min-w-0 truncate" title={status(id) || undefined}>
                      {status(id)}
                    </span>
                  </span>
                </div>
              )}
            </For>
          </div>

          <Switch>
            <Match when={state.preview.kind === "loading"}>
              <span class="text-12-regular text-text-weak">{language.t("common.loading")}</span>
            </Match>
            <Match when={previewFailed()}>
              <div class="flex items-center justify-between gap-3">
                <span class="text-12-regular text-text-weak">{language.t("common.requestFailed")}</span>
                <Show when={retriesLeft()}>
                  <Button size="small" disabled={retryIn() > 0} onClick={() => void controller.retryPreview()}>
                    {retryIn() > 0
                      ? language.t("dialog.tools.retryIn", { seconds: retryIn() })
                      : language.t("home.agents.retry")}
                  </Button>
                </Show>
              </div>
            </Match>
            <Match when={previewRun()}>
              {(run) => (
                <div class="flex flex-col gap-2">
                  <button
                    type="button"
                    class="self-start text-12-medium text-text-interactive-base"
                    aria-expanded={ui.showTerms}
                    onClick={() => setUi("showTerms", !ui.showTerms)}
                  >
                    {language.t("dialog.tools.terms")}
                  </button>
                  <Show when={ui.showTerms}>
                    <pre class="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-surface-base p-3 text-11-regular text-text-base">
                      {run().stdout}
                      {run().stderr}
                    </pre>
                  </Show>
                </div>
              )}
            </Match>
          </Switch>

          <Show when={state.run}>
            {(run) => (
              <Show when={run().stderr || resultLine(run().stdout)}>
                <pre class="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface-base p-3 text-11-regular text-text-base">
                  {[resultLine(run().stdout), run().stderr].filter(Boolean).join("\n")}
                </pre>
              </Show>
            )}
          </Show>
          <Show when={state.phase === "failed"}>
            <span class="text-12-regular text-text-weak">{language.t("common.requestFailed")}</span>
          </Show>

          <div class="flex flex-col gap-1">
            <span class="text-12-regular text-text-weak">{language.t("dialog.tools.terminal")}</span>
            <code class="select-all break-all rounded-md bg-surface-base p-2 text-11-regular text-text-base">
              {TOOLS_TERMINAL_COMMAND}
            </code>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
