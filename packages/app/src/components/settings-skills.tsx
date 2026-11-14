// 1.2.8 row 42 (AC-SKh, N8-413): the Skills tab of the existing Settings dialog, shared by v1 and v2 (no new panel).
// Lists skills by scope, turns them off and on (global `skills.disabled`), views, edits, creates and archives
// skills, and reviews agent drafts. Every write carries the desktop nonce, asked for on each click and never kept.
// SR8-08: approving a draft that runs shell commands needs a second, explicit confirm before `acceptCommands: true`.
import { Button } from "@opencode-ai/ui/button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/switch"
import { Switch as SwitchV2 } from "@opencode-ai/ui/v2/switch-v2"
import { type Accessor, type Component, type JSX, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs, type DraftTab } from "@/context/tabs"
import { desktopNonce, nonceHeader } from "@/pages/session/map/session-map-model"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./settings-v2/parts/list"
import { SettingsRowV2 } from "./settings-v2/parts/row"

export type SkillScope = "builtin" | "global" | "project" | "other"
export type SkillRow = {
  name: string
  description?: string
  content: string
  disabled?: boolean
  required?: boolean
  scope?: SkillScope
  hash?: string
  triggers?: { keywords: string[]; files: string[]; missionTypes: string[] }
}
export type SkillDraftRow = {
  name: string
  scope: "global" | "project"
  content: string
  untrusted: boolean
  runsCommands: boolean
  replaces: boolean
}

const SCOPES: SkillScope[] = ["builtin", "global", "project", "other"]
const scopeKey = {
  builtin: "settings.skills.scope.builtin",
  global: "settings.skills.scope.global",
  project: "settings.skills.scope.project",
  other: "settings.skills.scope.other",
} as const

// 01b §5.6: route code -> Settings string. Anything else is a plain request failure.
const ERROR_TEXT: Record<string, [string, Record<string, number>?]> = {
  SKILL_NAME_INVALID: ["settings.skills.error.nameInvalid", { max: 64 }],
  SKILL_NAME_RESERVED: ["settings.skills.error.nameReserved"],
  SKILL_FRONTMATTER_INVALID: ["settings.skills.error.frontmatter"],
  SKILL_TRIGGERS_INVALID: ["settings.skills.error.triggers", { max: 10 }],
  SKILL_TOO_LARGE: ["settings.skills.error.tooLarge", { max: 64 }],
  SKILL_PATH_UNSAFE: ["settings.skills.error.unsafe"],
  SKILL_SHELL_UNTRUSTED: ["settings.skills.error.untrusted"],
  SKILL_CHANGED: ["settings.skills.error.changed"],
  SKILL_DRAFT_MISSING: ["settings.skills.error.draftMissing"],
  SKILL_NOT_FOUND: ["settings.skills.error.notFound"],
  SKILL_ARCHIVE_FAILED: ["settings.skills.error.archive"],
  SKILL_PERSON_ONLY: ["settings.skills.error.personOnly"],
  CONFIG_PERSON_ONLY: ["settings.skills.error.personOnly"],
  SKILL_SHELL_UNCONFIRMED: ["settings.skills.error.shellUnconfirmed"],
}

export function skillErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return
  const data = (error as { data?: { code?: unknown } }).data
  return typeof data?.code === "string" ? data.code : undefined
}

// The name a new skill is saved under comes from its own frontmatter (the route checks they match).
export function frontmatterName(content: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  const line = head?.[1].split(/\r?\n/).find((item) => /^name\s*:/.test(item))
  return (line?.replace(/^name\s*:/, "").trim() ?? "").replace(/^["']|["']$/g, "")
}

const NEW_TEMPLATE = "---\nname: \ndescription: \n---\n\n"

// The folder the open session, draft or new-session page works in; undefined on Home.
export function useSettingsDirectory(): Accessor<string | undefined> {
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  return createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft")
      return tabs.store.find((item): item is DraftTab => item.type === "draft" && item.draftID === route.draftID)
        ?.directory
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return undefined
  })
}

type Open = { key: string; mode: "view" | "edit"; content: string; hash?: string; scope?: "global" | "project" }
type Confirm = { kind: "delete" | "commands"; key: string }

export const SettingsSkills: Component<{ v2?: boolean; directory?: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const directory = props.directory ?? useSettingsDirectory()
  const t = (key: string, params?: Record<string, string | number>) =>
    (language.t as (key: string, params?: Record<string, string | number>) => string)(key, params)

  const client = () => {
    const dir = directory()
    return dir ? serverSdk().createClient({ directory: dir }) : serverSdk().client
  }
  const headers = async () => ({ headers: nonceHeader(await desktopNonce()) })

  const [skills, { refetch: refetchSkills }] = createResource(
    () => directory() ?? "",
    async () => ((await client().app.skills()).data ?? []) as SkillRow[],
  )
  const [drafts, { refetch: refetchDrafts }] = createResource(
    () => directory() ?? "",
    async () => ((await client().skill.drafts()).data ?? []) as SkillDraftRow[],
  )
  const reload = () => {
    void refetchSkills()
    void refetchDrafts()
  }

  const [state, setState] = createStore({
    open: undefined as Open | undefined,
    confirm: undefined as Confirm | undefined,
    error: undefined as string | undefined,
    busy: false,
  })

  const fail = (value: unknown) => {
    const code = skillErrorCode(value)
    const known = code ? ERROR_TEXT[code] : undefined
    setState({ error: known ? t(known[0], known[1]) : t("common.requestFailed") })
  }

  // Runs one write; the route's error (or a thrown one) becomes the inline message.
  const run = async (write: () => Promise<{ error?: unknown; data?: unknown } | undefined>) => {
    if (state.busy) return
    setState({ busy: true, error: undefined })
    try {
      const result = await write()
      if (result?.error) {
        fail(result.error)
        return
      }
      return result ?? {}
    } catch (thrown) {
      fail(thrown)
      return
    } finally {
      setState({ busy: false })
    }
  }

  const saved = (data: unknown) => {
    const note = (data as { note?: string } | undefined)?.note
    showToast({ title: t(note === "skipped" ? "settings.skills.savedNoNote" : "settings.skills.saved") })
  }

  const grouped = createMemo(() => {
    const list = skills() ?? []
    return SCOPES.map((scope) => ({ scope, items: list.filter((item) => (item.scope ?? "other") === scope) })).filter(
      (group) => group.items.length > 0,
    )
  })

  const keyOf = (scope: string, name: string) => `${scope}:${name}`
  const editable = (item: SkillRow) => item.scope === "global" || item.scope === "project"

  // Off/on: the whole `skills.disabled` list is sent (arrays are replaced on merge), read fresh from the server.
  const toggle = (item: SkillRow, on: boolean) =>
    run(async () => {
      const sdk = serverSdk().client
      const current = (await sdk.global.config.get()).data as { skills?: { disabled?: string[] } } | undefined
      const list = new Set(current?.skills?.disabled ?? [])
      if (on) list.delete(item.name)
      else list.add(item.name)
      const result = await sdk.global.config.update(
        { config: { skills: { disabled: [...list] } } as never },
        await headers(),
      )
      if (!result.error) void refetchSkills()
      return result
    })

  const view = async (item: SkillRow) => {
    const key = keyOf(item.scope ?? "other", item.name)
    setState({ confirm: undefined })
    if (state.open?.key === key && state.open?.mode === "view") return setState({ open: undefined })
    if (!editable(item)) return setState({ open: { key, mode: "view", content: item.content } })
    await run(async () => {
      const result = await client().skill.source({ scope: item.scope as "global" | "project", name: item.name })
      if (!result.error) setState({ open: { key, mode: "view", content: result.data?.content ?? "" } })
      return result
    })
  }

  const edit = async (item: SkillRow) => {
    const scope = item.scope as "global" | "project"
    setState({ confirm: undefined })
    await run(async () => {
      const result = await client().skill.source({ scope, name: item.name })
      if (!result.error)
        setState({
          open: {
            key: keyOf(scope, item.name),
            mode: "edit",
            content: result.data?.content ?? "",
            hash: result.data?.hash,
            scope,
          },
        })
      return result
    })
  }

  const save = (name: string) => {
    const current = state.open
    if (!current?.scope) return
    return run(async () => {
      const result = await client().skill.save(
        { scope: current.scope!, name, content: current.content, ...(current.hash ? { baseHash: current.hash } : {}) },
        await headers(),
      )
      if (!result.error) {
        setState({ open: undefined })
        saved(result.data)
        reload()
      }
      return result
    })
  }

  const remove = (item: SkillRow) =>
    run(async () => {
      const result = await client().skill.delete(
        { scope: item.scope as "global" | "project", name: item.name },
        await headers(),
      )
      if (!result.error) {
        setState({ confirm: undefined, open: undefined })
        showToast({ title: t("settings.skills.deleted") })
        reload()
      }
      return result
    })

  // SR8-08: a draft that runs commands is approved only from its second confirm, which alone sets acceptCommands.
  const approve = (draft: SkillDraftRow, confirmed: boolean) => {
    if (draft.runsCommands && !confirmed) {
      setState({ error: undefined, confirm: { kind: "commands", key: keyOf(draft.scope, draft.name) } })
      return
    }
    return run(async () => {
      const result = await client().skill.draftApprove(
        { name: draft.name, scope: draft.scope, ...(draft.runsCommands && confirmed ? { acceptCommands: true } : {}) },
        await headers(),
      )
      if (!result.error) {
        setState({ confirm: undefined })
        saved(result.data)
        reload()
      }
      return result
    })
  }

  const discard = (draft: SkillDraftRow) =>
    run(async () => {
      const result = await client().skill.draftDiscard({ name: draft.name, scope: draft.scope }, await headers())
      if (!result.error) {
        setState({ confirm: undefined })
        void refetchDrafts()
      }
      return result
    })

  const Action = (p: { action: string; onClick: () => unknown; children: JSX.Element; danger?: boolean }) =>
    props.v2 ? (
      <ButtonV2
        type="button"
        size="small"
        variant={p.danger ? "danger" : "ghost"}
        data-action={p.action}
        disabled={state.busy}
        onClick={() => void p.onClick()}
      >
        {p.children}
      </ButtonV2>
    ) : (
      <Button
        type="button"
        size="small"
        variant={p.danger ? "primary" : "ghost"}
        data-action={p.action}
        disabled={state.busy}
        onClick={() => void p.onClick()}
      >
        {p.children}
      </Button>
    )

  const Toggle = (p: { item: SkillRow }) => {
    const props2 = {
      checked: p.item.required || !p.item.disabled,
      disabled: !!p.item.required || state.busy,
      onChange: (checked: boolean) => void toggle(p.item, checked),
      hideLabel: true,
      "data-action": "skill-toggle",
    }
    return props.v2 ? (
      <SwitchV2 {...props2}>{t("settings.skills.enabled")}</SwitchV2>
    ) : (
      <Switch {...props2}>{t("settings.skills.enabled")}</Switch>
    )
  }

  const Badge = (p: { kind: string; children: JSX.Element; title?: string }) => (
    <span
      data-badge={p.kind}
      title={p.title}
      class="inline-flex items-center rounded px-1.5 text-11-medium bg-surface-raised-base text-text-weak"
    >
      {p.children}
    </span>
  )

  // Plain text only: never Markdown or HTML (01b §12 item 4).
  const Plain = (p: { text: string }) => (
    <pre
      data-slot="skill-content"
      class="whitespace-pre-wrap break-words font-mono text-12-regular text-text-base bg-surface-base rounded p-3 max-h-80 overflow-auto"
    >
      {p.text}
    </pre>
  )

  const Editor = (p: { name: () => string; isNew?: boolean }) => (
    <div class="flex flex-col gap-2" data-slot="skill-editor">
      <textarea
        data-slot="skill-textarea"
        class="w-full min-h-48 font-mono text-12-regular rounded p-2 bg-surface-base text-text-strong"
        value={state.open?.content ?? ""}
        spellcheck={false}
        onInput={(event) => {
          const current = state.open
          if (current) setState({ open: { ...current, content: event.currentTarget.value } })
        }}
      />
      <Show when={p.isNew}>
        <div class="flex items-center gap-2 text-12-regular text-text-weak" role="radiogroup">
          <span>{t("settings.skills.saveFor")}</span>
          <For each={["global", "project"] as const}>
            {(scope) => (
              <Show when={scope === "global" || directory()}>
                <label class="flex items-center gap-1">
                  <input
                    type="radio"
                    name="skill-scope"
                    data-scope={scope}
                    checked={state.open?.scope === scope}
                    onChange={() => {
                      const current = state.open
                      if (current) setState({ open: { ...current, scope } })
                    }}
                  />
                  {t(scopeKey[scope])}
                </label>
              </Show>
            )}
          </For>
        </div>
      </Show>
      <div class="flex gap-2">
        <Action action="skill-save" onClick={() => save(p.name())}>
          {t("settings.skills.save")}
        </Action>
        <Action action="skill-cancel" onClick={() => setState({ open: undefined })}>
          {t("common.cancel")}
        </Action>
      </div>
    </div>
  )

  const triggerSummary = (item: SkillRow) => {
    const parts = [
      ["settings.skills.triggers.keywords", item.triggers?.keywords ?? []],
      ["settings.skills.triggers.files", item.triggers?.files ?? []],
      ["settings.skills.triggers.missionTypes", item.triggers?.missionTypes ?? []],
    ] as const
    const used = parts.filter(([, list]) => list.length > 0)
    if (used.length === 0) return t("settings.skills.triggers.none")
    return `${t("settings.skills.triggers")}: ${used.map(([key, list]) => `${t(key)} ${list.join(", ")}`).join(" · ")}`
  }

  const SkillItem = (p: { item: SkillRow }) => {
    const key = () => keyOf(p.item.scope ?? "other", p.item.name)
    const isOpen = () => state.open?.key === key()
    const title = (
      <span class="flex flex-wrap items-center gap-2">
        <span class="text-14-medium text-text-strong">{p.item.name}</span>
        <Show when={p.item.required}>
          <Badge kind="required" title={t("settings.skills.requiredHint")}>
            {t("settings.skills.required")}
          </Badge>
        </Show>
        <Show when={!p.item.required && p.item.disabled}>
          <Badge kind="off">{t("settings.skills.off")}</Badge>
        </Show>
      </span>
    )
    const description = (
      <span class="flex flex-col gap-0.5">
        <span class="truncate">{p.item.description ?? ""}</span>
        <span class="text-12-regular text-text-weak">{triggerSummary(p.item)}</span>
        <Show when={p.item.required}>
          <span class="text-12-regular text-text-weak">{t("settings.skills.requiredHint")}</span>
        </Show>
        <Show when={p.item.scope === "builtin"}>
          <span class="text-12-regular text-text-weak">{t("settings.skills.readOnly")}</span>
        </Show>
        <Show when={p.item.scope === "other"}>
          <span class="text-12-regular text-text-weak">{t("settings.skills.otherReadOnly")}</span>
        </Show>
      </span>
    )
    const controls = (
      <div class="flex flex-wrap items-center gap-1">
        <Action action="skill-view" onClick={() => view(p.item)}>
          {t("settings.skills.view")}
        </Action>
        <Show when={editable(p.item)}>
          <Action action="skill-edit" onClick={() => edit(p.item)}>
            {t("settings.skills.edit")}
          </Action>
          <Action
            action="skill-delete"
            onClick={() => {
              setState({ error: undefined, confirm: { kind: "delete", key: key() } })
            }}
          >
            {t("common.delete")}
          </Action>
        </Show>
        <Toggle item={p.item} />
      </div>
    )
    return (
      <div data-skill={p.item.name} data-scope={p.item.scope ?? "other"} class="flex flex-col gap-2">
        <Show
          when={props.v2}
          fallback={
            <div class="flex flex-wrap items-center justify-between gap-4 py-3">
              <div class="min-w-0 flex flex-col gap-1">
                {title}
                <span class="text-12-regular text-text-base">{description}</span>
              </div>
              {controls}
            </div>
          }
        >
          <SettingsRowV2 title={title} description={description}>
            {controls}
          </SettingsRowV2>
        </Show>
        <Show when={state.confirm?.kind === "delete" && state.confirm?.key === key()}>
          <div role="alertdialog" data-slot="skill-delete-confirm" class="flex flex-wrap items-center gap-2 pb-3">
            <span class="text-12-regular text-text-strong">
              {t("settings.skills.deleteConfirm", { name: p.item.name })}
            </span>
            <Action action="skill-delete-confirm" danger onClick={() => remove(p.item)}>
              {t("common.delete")}
            </Action>
            <Action action="skill-cancel" onClick={() => setState({ confirm: undefined })}>
              {t("common.cancel")}
            </Action>
          </div>
        </Show>
        <Show when={isOpen() && state.open?.mode === "view"}>
          <Plain text={state.open?.content ?? ""} />
        </Show>
        <Show when={isOpen() && state.open?.mode === "edit"}>
          <Editor name={() => p.item.name} />
        </Show>
      </div>
    )
  }

  const DraftItem = (p: { draft: SkillDraftRow }) => {
    const key = () => keyOf(p.draft.scope, p.draft.name)
    const [shown, setShown] = createSignal(false)
    return (
      <div data-draft={p.draft.name} data-scope={p.draft.scope} class="flex flex-col gap-2 py-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0 flex flex-col gap-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="text-14-medium text-text-strong">{p.draft.name}</span>
              <span class="text-12-regular text-text-weak">{t(scopeKey[p.draft.scope])}</span>
            </span>
            <Show when={p.draft.untrusted}>
              <Badge kind="untrusted">{t("settings.skills.drafts.untrusted")}</Badge>
            </Show>
            <Show when={p.draft.runsCommands}>
              <Badge kind="runsCommands">{t("settings.skills.drafts.runsCommands")}</Badge>
            </Show>
            <Show when={p.draft.replaces}>
              <Badge kind="replaces">{t("settings.skills.drafts.replaces")}</Badge>
            </Show>
          </div>
          <div class="flex flex-wrap items-center gap-1">
            <Action action="draft-view" onClick={() => setShown(!shown())}>
              {t("settings.skills.view")}
            </Action>
            <Action action="draft-approve" onClick={() => approve(p.draft, false)}>
              {t("settings.skills.drafts.approve")}
            </Action>
            <Action action="draft-discard" onClick={() => discard(p.draft)}>
              {t("settings.skills.drafts.discard")}
            </Action>
          </div>
        </div>
        <Show when={state.confirm?.kind === "commands" && state.confirm?.key === key()}>
          <div role="alertdialog" data-slot="skill-commands-confirm" class="flex flex-wrap items-center gap-2">
            <span class="text-12-medium text-text-strong">
              {t(
                p.draft.scope === "global"
                  ? "settings.skills.drafts.confirmCommandsGlobal"
                  : "settings.skills.drafts.confirmCommands",
              )}
            </span>
            <Action action="draft-approve-commands" danger onClick={() => approve(p.draft, true)}>
              {t("settings.skills.drafts.approve")}
            </Action>
            <Action action="skill-cancel" onClick={() => setState({ confirm: undefined })}>
              {t("common.cancel")}
            </Action>
          </div>
        </Show>
        <Show when={shown()}>
          <Plain text={p.draft.content} />
        </Show>
      </div>
    )
  }

  const List = (p: { children: JSX.Element }) =>
    props.v2 ? (
      <SettingsListV2>{p.children}</SettingsListV2>
    ) : (
      <div class="bg-surface-base px-4 rounded-lg flex flex-col divide-y divide-border-weak-base">{p.children}</div>
    )

  const startNew = () => {
    setState({
      confirm: undefined,
      error: undefined,
      open: { key: "new", mode: "edit", content: NEW_TEMPLATE, scope: "global" },
    })
  }

  const body = (
    <div class="flex flex-col gap-6" data-component="settings-skills">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <p class="text-12-regular text-text-weak max-w-[560px]">{t("settings.skills.description")}</p>
        <Action action="skill-new" onClick={startNew}>
          {t("settings.skills.new")}
        </Action>
      </div>
      <Show when={state.error}>
        <div role="alert" data-slot="skill-error" class="text-12-medium text-text-on-critical-base">
          {state.error}
        </div>
      </Show>
      <Show when={state.open?.key === "new"}>
        <Editor name={() => frontmatterName(state.open?.content ?? "")} isNew />
      </Show>
      <Show when={(drafts() ?? []).length > 0}>
        <div class="flex flex-col gap-1" data-slot="skill-drafts">
          <h3 class={props.v2 ? "settings-v2-section-title" : "text-14-medium text-text-strong pb-2"}>
            {t("settings.skills.drafts.title")}
          </h3>
          <List>
            <For each={drafts()}>{(draft) => <DraftItem draft={draft} />}</For>
          </List>
        </div>
      </Show>
      <Show
        when={grouped().length > 0}
        fallback={
          <Show when={!skills.loading}>
            <p class="text-12-regular text-text-weak">{t("settings.skills.empty")}</p>
          </Show>
        }
      >
        <For each={grouped()}>
          {(group) => (
            <div class={props.v2 ? "settings-v2-section" : "flex flex-col gap-1"} data-group={group.scope}>
              <h3 class={props.v2 ? "settings-v2-section-title" : "text-14-medium text-text-strong pb-2"}>
                {t(scopeKey[group.scope])}
              </h3>
              <List>
                <For each={group.items}>{(item) => <SkillItem item={item} />}</For>
              </List>
            </div>
          )}
        </For>
      </Show>
    </div>
  )

  return (
    <Show
      when={props.v2}
      fallback={
        <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
          <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
            <h2 class="text-16-medium text-text-strong">{t("settings.skills.title")}</h2>
            {body}
          </div>
        </div>
      }
    >
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{t("settings.skills.title")}</h2>
      </div>
      <div class="settings-v2-tab-body">{body}</div>
    </Show>
  )
}
