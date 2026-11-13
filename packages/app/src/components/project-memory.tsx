import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Icon as LegacyIcon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { MemoryItem, MemoryRef, MemoryRefusal, MemoryResult } from "@opencode-ai/sdk/v2/client"
import { ProjectMemory } from "@opencode-ai/schema/project-memory"
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

const MAX_RETRIES = 3

/**
 * The server's note limits, from their one source in the schema (1.2.6 M1 S6): the same constant opencode's
 * Memory.MAX_TEXT, MAX_BODY and MAX_REFS read. The refusal texts take their number from here.
 */
const MEMORY_LIMITS = ProjectMemory.LIMITS
const INDEX_LIMITS = ProjectMemory.INDEX_LIMITS

/**
 * 1.2.8 MEM-g (01e §7): an item as the schema defines it. The generated SDK type gains `kind`, `missionId` and
 * `rolledInto` at the next regeneration; reading them from the schema keeps the view correct before and after.
 */
type Item = MemoryItem & Pick<ProjectMemory.Item, "kind" | "missionId" | "rolledInto">

const isIndex = (item: Item) => item.kind === "index" || item.kind === "index_rollup"

/** `YYYY-Qn roll-up | <n> missions | ...` or `YYYY roll-up part <p> | ...` (N8-010): period and mission count. */
const ROLLUP_LINE = /^(\d{4}(?:-Q[1-4])?) roll-up(?: part \d+)? \| (\d+) missions \|/

/** Newest first by the date the line carries: an entry's own date, a roll-up's period end. Write time breaks ties. */
function indexDate(item: Item) {
  const rollup = item.kind === "index_rollup" ? ROLLUP_LINE.exec(item.text)?.[1] : undefined
  if (!rollup) return item.text.slice(0, 10)
  const quarter = rollup.length > 4 ? Number(rollup.slice(6)) : 4
  return `${rollup.slice(0, 4)}-${String(quarter * 3).padStart(2, "0")}-31`
}

/** The groups the memory view shows: live index entries first, then ordinary notes; archived entries apart. */
function memoryGroups(items: readonly Item[]) {
  const live = items.filter((item) => !item.rolledInto)
  return {
    index: live
      .filter(isIndex)
      .sort((a, b) => indexDate(b).localeCompare(indexDate(a)) || Number(b.time) - Number(a.time)),
    // Today's order (reversed store order); an unknown future kind reads as an ordinary note (01e §2.1).
    notes: live.filter((item) => !isIndex(item)).reverse(),
    archived: items.filter((item) => item.rolledInto),
  }
}

/** A reference as the user reads it: `path:line`, `path`, `symbol` or `symbol (path)`. Never the file's content. */
function memoryRefLabel(ref: MemoryRef) {
  if ("symbol" in ref) return ref.path ? `${ref.symbol} (${ref.path})` : ref.symbol
  return ref.line ? `${ref.path}:${ref.line}` : ref.path
}

function createProjectMemory() {
  const sdk = useSDK()
  const [info, control] = createResource(sdk, (current) =>
    current.client.memory.get(undefined, { throwOnError: true }).then((response) => response.data),
  )
  createEffect(() => onCleanup(sdk().event.on("memory.updated", () => void control.refetch())))
  // Reading a failed resource throws, and a memory that cannot load must not take the page down with it.
  const current = () => (info.error ? undefined : info.latest)
  return { sdk, info, current, refetch: control.refetch }
}

/** Shown where a session begins, once there is something to show: a first session stays as calm as before. */
export function ProjectMemoryLine() {
  const language = useLanguage()
  const dialog = useDialog()
  const memory = createProjectMemory()
  return (
    <Show when={memory.current()?.items.length}>
      {(count) => (
        <button
          type="button"
          data-action="project-memory"
          class="flex h-7 min-w-0 items-center gap-1.5 rounded-[6px] px-2 text-[13px] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-v2-border-border-focus"
          title={language.t("memory.description")}
          onClick={() => dialog.show(() => <DialogProjectMemory />)}
        >
          <LegacyIcon name="brain" size="small" />
          <span classList={{ "line-through": memory.current()?.enabled === false }}>{language.t("memory.title")}</span>
          <span class="tabular-nums">{count()}</span>
        </button>
      )}
    </Show>
  )
}

/** What an agent or the runtime just learned surfaces once, with the way to take it back. */
export function createProjectMemoryNotices() {
  const sdk = useSDK()
  const language = useLanguage()
  const dialog = useDialog()
  createEffect(() => {
    const current = sdk()
    onCleanup(
      current.event.on("memory.updated", (event: { properties: { added?: MemoryItem } }) => {
        const added = event.properties.added
        if (!added) return
        showToast({
          icon: "brain",
          title: language.t("memory.remembered"),
          description: added.text,
          actions: [
            { label: language.t("memory.seeAll"), onClick: () => dialog.show(() => <DialogProjectMemory />) },
            { label: language.t("memory.undo"), onClick: () => void current.client.memory.remove({ id: added.id }) },
          ],
        })
      }),
    )
  })
}

export function DialogProjectMemory() {
  const language = useLanguage()
  const memory = createProjectMemory()
  const [draft, setDraft] = createSignal("")
  const [problem, setProblem] = createSignal<string>()
  const [retries, setRetries] = createSignal(0)
  const [cooldown, setCooldown] = createSignal(0)

  // Typed against the schema's refusal list, so a refusal without a text here fails the build (01e §7).
  const refused: Record<MemoryRefusal | ProjectMemory.Refusal, string> = {
    empty: "",
    secret: language.t("memory.refused.secret"),
    long: language.t("memory.refused.long", { max: MEMORY_LIMITS.text }),
    full: language.t("memory.refused.full"),
    body_long: language.t("memory.refused.bodyLong", { max: MEMORY_LIMITS.body }),
    too_many_refs: language.t("memory.refused.tooManyRefs", { max: MEMORY_LIMITS.refs }),
    index_long: language.t("memory.refused.indexLong", { max: INDEX_LIMITS.text }),
    index_body_long: language.t("memory.refused.indexBodyLong", { max: INDEX_LIMITS.body }),
    index_format: language.t("memory.refused.indexFormat"),
    index_full: language.t("memory.refused.indexFull"),
  }
  const groups = () => memoryGroups((memory.current()?.items ?? []) as Item[])

  /** Runs a change and reports why it did not take, in place. Returns whether it did. */
  const save = async (change: () => Promise<{ data?: MemoryResult | boolean | unknown }>) => {
    setProblem(undefined)
    const response = await change().catch(() => undefined)
    if (!response?.data && response?.data !== false) {
      setProblem(language.t("memory.saveFailed"))
      return false
    }
    const why = (response.data as MemoryResult).refused
    if (why) {
      setProblem(refused[why])
      return false
    }
    await memory.refetch()
    return true
  }

  const client = () => memory.sdk().client.memory

  const add = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!draft().trim()) return
    if (await save(() => client().add({ text: draft() }))) setDraft("")
  }

  let timer: ReturnType<typeof setInterval> | undefined
  onCleanup(() => clearInterval(timer))
  const retry = () => {
    if (cooldown() > 0 || retries() >= MAX_RETRIES) return
    setCooldown(3 * 2 ** retries())
    setRetries((value) => value + 1)
    void memory.refetch()
    clearInterval(timer)
    timer = setInterval(() => {
      if (cooldown() <= 1) clearInterval(timer)
      setCooldown((value) => Math.max(0, value - 1))
    }, 1000)
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("memory.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex max-h-[min(560px,calc(100vh-160px))] w-full flex-col gap-3 overflow-y-auto px-4 pt-3 pb-3 sm:w-[560px]">
        <Show
          when={!memory.info.error}
          fallback={
            <div data-memory-error class="flex items-center justify-between gap-3 text-[13px] text-v2-text-text-base">
              {language.t("memory.error")}
              <ButtonV2 variant="neutral" disabled={cooldown() > 0 || retries() >= MAX_RETRIES} onClick={retry}>
                {cooldown() > 0 ? `${language.t("memory.retry")} (${cooldown()}s)` : language.t("memory.retry")}
              </ButtonV2>
            </div>
          }
        >
          <p class="text-[13px] leading-5 text-v2-text-text-faint">{language.t("memory.description")}</p>
          <form onSubmit={add}>
            <TextInputV2
              data-memory-add
              class="!w-full"
              autofocus
              value={draft()}
              placeholder={language.t("memory.add")}
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
          </form>
          <Show when={problem()}>
            <div role="alert" data-memory-problem class="text-[13px] text-v2-state-fg-danger">
              {problem()}
            </div>
          </Show>
          <Show
            when={memory.current()?.items.length || memory.info.loading}
            fallback={
              <p data-memory-empty class="py-3 text-[13px] leading-5 text-v2-text-text-faint">
                {language.t("memory.empty")}
              </p>
            }
          >
            {/* 1.2.8 MEM-g: mission index entries are their own group in this same list, first; no new panel. */}
            <Show when={groups().index.length || groups().archived.length}>
              <section data-memory-index class="flex flex-col gap-1">
                <h3 class="text-[12px] font-medium leading-[18px] text-v2-text-text-faint">
                  {language.t("memory.kind.index")}
                </h3>
                <ul class="flex flex-col">
                  <For each={groups().index}>
                    {(item) => (
                      <MemoryRow
                        item={item}
                        members={
                          item.kind === "index_rollup"
                            ? groups().archived.filter((member) => member.rolledInto === item.id)
                            : undefined
                        }
                        onDelete={() => save(() => client().remove({ id: item.id }))}
                        onText={(text) => save(() => client().update({ id: item.id, text }))}
                        onScope={() => save(() => client().update({ id: item.id, deviceOnly: !item.deviceOnly }))}
                      />
                    )}
                  </For>
                </ul>
                <Show when={groups().archived.length}>
                  {(count) => (
                    <p data-memory-index-hidden class="text-[12px] leading-[18px] text-v2-text-text-faint">
                      {language.t("memory.index.hidden", { count: count() })}
                    </p>
                  )}
                </Show>
              </section>
            </Show>
            <ul class="flex flex-col">
              <For each={groups().notes}>
                {(item) => (
                  <MemoryRow
                    item={item}
                    onDelete={() => save(() => client().remove({ id: item.id }))}
                    onText={(text) => save(() => client().update({ id: item.id, text }))}
                    onScope={() => save(() => client().update({ id: item.id, deviceOnly: !item.deviceOnly }))}
                  />
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </DialogBody>
      <Show when={memory.current()}>
        {(info) => (
          <>
            <DividerV2 />
            <div class="flex flex-col gap-2 px-4 py-3">
              <Switch checked={info().enabled} onChange={(enabled) => void save(() => client().settings({ enabled }))}>
                {language.t("memory.enabled")}
              </Switch>
              <p class="text-[12px] leading-[18px] text-v2-text-text-faint">
                {info().enabled ? language.t("memory.privacy") : language.t("memory.off")}
              </p>
            </div>
          </>
        )}
      </Show>
    </Dialog>
  )
}

/** Body and refs are what a model may receive on recall: shown read-only. */
function MemoryDetail(props: { item: Item }) {
  return (
    <>
      <Show when={props.item.body}>
        {(body) => (
          <p data-memory-body class="whitespace-pre-wrap break-words">
            {body()}
          </p>
        )}
      </Show>
      <For each={props.item.refs ?? []}>
        {(ref) => (
          <code data-memory-ref class="break-all font-mono">
            {memoryRefLabel(ref)}
          </code>
        )}
      </For>
    </>
  )
}

function MemoryRow(props: {
  item: Item
  /** A roll-up's archived members (01e §7): listed read-only inside its detail, never editable. */
  members?: Item[]
  onDelete: () => void
  onText: (text: string) => Promise<boolean>
  onScope: () => void
}) {
  const language = useLanguage()
  const [editing, setEditing] = createSignal(false)
  const rollup = () => props.item.kind === "index_rollup"
  const finish = async (text: string) => {
    if (text.trim() === props.item.text) return setEditing(false)
    if (await props.onText(text)) setEditing(false)
  }
  const hook = () => {
    const line = rollup() ? ROLLUP_LINE.exec(props.item.text) : null
    if (line) return language.t("memory.index.rollup", { count: Number(line[2]), period: line[1] })
    return (
      <For each={props.item.text.split("`")}>
        {(piece, index) => (index() % 2 ? <code class="font-mono text-[12px]">{piece}</code> : piece)}
      </For>
    )
  }
  return (
    <li
      data-memory-item={props.item.id}
      data-memory-kind={props.item.kind}
      class="group flex items-start gap-2 border-t border-v2-border-border-muted py-2.5 first:border-t-0"
    >
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <Show
          when={editing() && !rollup()}
          fallback={
            <Show
              when={rollup() || props.item.body || props.item.refs?.length}
              fallback={<div class="break-words text-[13px] leading-5 text-v2-text-text-base">{hook()}</div>}
            >
              <details class="min-w-0 text-[13px] leading-5 text-v2-text-text-base">
                <summary class="cursor-pointer break-words">{hook()}</summary>
                <div class="mt-1 flex flex-col gap-1 text-[12px] leading-[18px] text-v2-text-text-faint">
                  <Show when={props.members?.length} fallback={<MemoryDetail item={props.item} />}>
                    <ul class="flex flex-col gap-1.5">
                      <For each={props.members}>
                        {(member) => (
                          <li data-memory-archived={member.id} class="flex flex-col gap-0.5">
                            <span class="break-words text-v2-text-text-base">{member.text}</span>
                            <MemoryDetail item={member} />
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              </details>
            </Show>
          }
        >
          <TextInputV2
            data-memory-edit
            class="!w-full"
            autofocus
            value={props.item.text}
            onKeyDown={(event) => {
              if (event.key === "Enter") void finish(event.currentTarget.value)
              if (event.key !== "Escape") return
              event.stopPropagation()
              setEditing(false)
            }}
          />
        </Show>
        <div class="flex flex-wrap items-center gap-x-1.5 text-[12px] leading-[18px] text-v2-text-text-faint">
          <Show when={isIndex(props.item)}>
            <span data-memory-kind-label>{language.t("memory.kind.index")}</span>
            <span aria-hidden="true">·</span>
          </Show>
          <span>{language.t(`memory.source.${props.item.source}`)}</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            data-memory-scope
            title={language.t("memory.scope.toggle")}
            class="rounded-[4px] underline-offset-2 hover:text-v2-text-text-base hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-v2-border-border-focus"
            onClick={props.onScope}
          >
            {language.t(props.item.deviceOnly ? "memory.scope.device" : "memory.scope.any")}
          </button>
        </div>
      </div>
      <div class="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        {/* A roll-up's line is written by the store and stays as written (01e §2.3): no edit, delete stays. */}
        <Show when={!rollup()}>
          <IconButtonV2
            type="button"
            data-memory-edit-button
            variant="ghost-muted"
            size="small"
            aria-label={language.t("common.edit")}
            title={language.t("common.edit")}
            icon={<Icon name="edit" />}
            onClick={() => setEditing((value) => !value)}
          />
        </Show>
        <IconButtonV2
          type="button"
          data-memory-delete
          variant="ghost-muted"
          size="small"
          aria-label={language.t("common.delete")}
          title={language.t("common.delete")}
          icon={<Icon name="close" />}
          onClick={props.onDelete}
        />
      </div>
    </li>
  )
}
