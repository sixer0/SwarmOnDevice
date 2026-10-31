import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextField } from "@opencode-ai/ui/text-field"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { SavedCommandItem, SavedCommandRefusal } from "@opencode-ai/sdk/v2/client"
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

const MAX_RETRIES = 3

/**
 * Saving a run and looking after what has been saved are one dialog: the form is there when there is a run to save or a
 * command being edited, and the list is folded under it. Nobody sees a file or a format.
 */
export function DialogSavedCommands(props: { sessionID?: string }) {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const client = () => sdk().client.savedCommand

  const [saved, savedControl] = createResource(sdk, (current) =>
    current.client.savedCommand.list(undefined, { throwOnError: true }).then((response) => response.data),
  )
  const [draft, draftControl] = createResource(
    () => props.sessionID,
    (sessionID) =>
      sdk()
        .client.savedCommand.draft({ sessionID }, { throwOnError: true })
        .then((response) => response.data),
  )

  const [name, setName] = createSignal("")
  const [about, setAbout] = createSignal("")
  const [template, setTemplate] = createSignal("")
  const [everywhere, setEverywhere] = createSignal(false)
  const [editing, setEditing] = createSignal<string>()
  const [problem, setProblem] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [listOpen, setListOpen] = createSignal(!props.sessionID)

  createEffect(
    on(
      () => (draft.error ? undefined : draft()),
      (value) => {
        if (!value || editing()) return
        setName(value.name)
        setAbout(value.description)
        setTemplate(value.template)
      },
    ),
  )

  // Without a draft there is nothing to review, so the retry is all that shows.
  const hasForm = () => !!editing() || (!!props.sessionID && !draft.error)
  const drafting = () => !editing() && draft.loading
  const fellBack = () => !editing() && !draft.error && draft()?.source === "prompts"
  const items = () => (saved.error ? [] : (saved.latest ?? []))

  const refused: Record<SavedCommandRefusal, string> = {
    name: language.t("savedCommand.refused.name"),
    taken: language.t("savedCommand.refused.taken"),
    empty: language.t("savedCommand.refused.empty"),
    long: language.t("savedCommand.refused.long"),
    secret: language.t("savedCommand.refused.secret"),
  }

  const save = async (event?: Event) => {
    event?.preventDefault()
    if (busy() || drafting()) return
    setBusy(true)
    setProblem(undefined)
    const response = await client()
      .save({
        name: name().trim(),
        description: about().trim() || undefined,
        template: template(),
        global: everywhere(),
        replaces: editing(),
        sessionID: editing() ? undefined : props.sessionID,
      })
      .catch(() => undefined)
    setBusy(false)
    if (!response?.data || response.error) return setProblem(language.t("savedCommand.saveFailed"))
    if (response.data.refused) return setProblem(refused[response.data.refused])
    const item = response.data.item
    if (!item) return setProblem(language.t("savedCommand.saveFailed"))
    dialog.close()
    showToast({
      variant: "success",
      title: language.t("savedCommand.saved", { name: item.name }),
      actions: editing()
        ? undefined
        : [
            {
              label: language.t("memory.undo"),
              onClick: () => void client().remove({ name: item.name }),
            },
          ],
    })
  }

  const edit = (item: SavedCommandItem) => {
    setEditing(item.name)
    setName(item.name)
    setAbout(item.description ?? "")
    setTemplate(item.template)
    setEverywhere(item.scope === "global")
    setProblem(undefined)
    setListOpen(false)
  }

  const remove = async (item: SavedCommandItem) => {
    const response = await client()
      .remove({ name: item.name })
      .catch(() => undefined)
    if (!response?.data) return setProblem(language.t("savedCommand.saveFailed"))
    await savedControl.refetch()
  }

  const [retries, setRetries] = createSignal(0)
  const [cooldown, setCooldown] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined
  onCleanup(() => clearInterval(timer))
  const retry = () => {
    if (cooldown() > 0 || retries() >= MAX_RETRIES) return
    setCooldown(3 * 2 ** retries())
    setRetries((value) => value + 1)
    if (saved.error) void savedControl.refetch()
    if (draft.error) void draftControl.refetch()
    clearInterval(timer)
    timer = setInterval(() => {
      if (cooldown() <= 1) clearInterval(timer)
      setCooldown((value) => Math.max(0, value - 1))
    }, 1000)
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t(editing() || props.sessionID ? "savedCommand.title" : "savedCommand.mine")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex max-h-[min(640px,calc(100vh-160px))] w-full flex-col gap-3 overflow-y-auto px-4 pt-3 pb-3 sm:w-[600px]">
        <Show when={saved.error || (!editing() && draft.error)}>
          <div data-saved-error class="flex items-center justify-between gap-3 text-[13px] text-v2-text-text-base">
            {language.t("savedCommand.loadFailed")}
            <ButtonV2 variant="neutral" disabled={cooldown() > 0 || retries() >= MAX_RETRIES} onClick={retry}>
              {cooldown() > 0 ? `${language.t("memory.retry")} (${cooldown()}s)` : language.t("memory.retry")}
            </ButtonV2>
          </div>
        </Show>
        <Show when={hasForm()}>
          <Show
            when={!drafting()}
            fallback={
              <div
                data-saved-drafting
                role="status"
                class="flex items-center gap-2 py-8 text-[13px] text-v2-text-text-muted"
              >
                <Spinner class="size-4" />
                {language.t("savedCommand.drafting")}
              </div>
            }
          >
            <form class="flex flex-col gap-3" onSubmit={save}>
              <Show when={fellBack()}>
                <p data-saved-fallback class="text-[13px] leading-5 text-v2-text-text-muted">
                  {language.t("savedCommand.fallback")}
                </p>
              </Show>
              <label class="flex flex-col gap-1 text-[12px] text-v2-text-text-muted">
                {language.t("savedCommand.name")}
                <span class="flex items-center gap-1.5">
                  <span class="font-mono text-[13px] text-v2-text-text-faint">/</span>
                  <TextInputV2
                    data-saved-name
                    class="min-w-0 flex-1 font-mono"
                    value={name()}
                    onInput={(event) => setName(event.currentTarget.value.toLowerCase().replace(/\s+/g, "-"))}
                  />
                </span>
              </label>
              <label class="flex flex-col gap-1 text-[12px] text-v2-text-text-muted">
                {language.t("savedCommand.about")}
                <TextInputV2
                  data-saved-about
                  class="!w-full"
                  value={about()}
                  onInput={(event) => setAbout(event.currentTarget.value)}
                />
              </label>
              <div
                class="flex flex-col gap-1 text-[12px] text-v2-text-text-muted"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save(event)
                }}
              >
                <span id="saved-instructions">{language.t("savedCommand.instructions")}</span>
                <TextField
                  data-saved-template
                  multiline
                  rows={9}
                  aria-labelledby="saved-instructions"
                  value={template()}
                  onChange={setTemplate}
                />
                <span class="text-v2-text-text-faint">{language.t("savedCommand.argumentsHint")}</span>
              </div>
              <Show when={problem()}>
                <div role="alert" data-saved-problem class="text-[13px] text-v2-state-fg-danger">
                  {problem()}
                </div>
              </Show>
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Switch checked={everywhere()} onChange={setEverywhere}>
                    {language.t("savedCommand.everywhere")}
                  </Switch>
                  <Show when={!everywhere()}>
                    <p class="text-[12px] leading-[18px] text-v2-text-text-faint">
                      {language.t("savedCommand.commitHint")}
                    </p>
                  </Show>
                </div>
                <ButtonV2 data-saved-save type="submit" variant="contrast" disabled={busy()}>
                  {language.t("savedCommand.save")}
                </ButtonV2>
              </div>
            </form>
          </Show>
        </Show>
        <Show when={!saved.error}>
          <Show when={hasForm() && items().length > 0}>
            <button
              type="button"
              data-saved-list-toggle
              aria-expanded={listOpen()}
              class="flex items-center gap-1 self-start rounded-[4px] border-0 bg-transparent p-0 text-[12px] text-v2-text-text-faint hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-v2-border-border-focus"
              onClick={() => setListOpen((value) => !value)}
            >
              {language.t("savedCommand.mine")} {items().length}
              <Icon name="chevron-down" class={listOpen() ? "rotate-180" : undefined} />
            </button>
          </Show>
          <Show when={!hasForm() && !saved.loading && items().length === 0}>
            <p data-saved-empty class="py-3 text-[13px] leading-5 text-v2-text-text-faint">
              {language.t("savedCommand.empty")}
            </p>
          </Show>
          <Show when={listOpen() && items().length > 0}>
            <ul class="flex flex-col">
              <For each={items()}>
                {(item) => (
                  <li
                    data-saved-item={item.name}
                    class="group flex items-center gap-2 border-t border-v2-border-border-muted py-2 first:border-t-0"
                  >
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-baseline gap-x-2">
                        <code class="font-mono text-[12.5px] text-v2-text-text-base">/{item.name}</code>
                        <span class="text-[12px] text-v2-text-text-faint">
                          {language.t(item.scope === "global" ? "savedCommand.scope.global" : "savedCommand.scope.project")}
                        </span>
                      </div>
                      <Show when={item.description}>
                        <div class="truncate text-[12px] leading-[18px] text-v2-text-text-muted">{item.description}</div>
                      </Show>
                    </div>
                    <div class="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      <IconButtonV2
                        type="button"
                        data-saved-edit
                        variant="ghost-muted"
                        size="small"
                        aria-label={language.t("common.edit")}
                        title={language.t("common.edit")}
                        icon={<Icon name="edit" />}
                        onClick={() => edit(item)}
                      />
                      <IconButtonV2
                        type="button"
                        data-saved-delete
                        variant="ghost-muted"
                        size="small"
                        aria-label={language.t("common.delete")}
                        title={language.t("common.delete")}
                        icon={<Icon name="close" />}
                        onClick={() => void remove(item)}
                      />
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </DialogBody>
    </Dialog>
  )
}
