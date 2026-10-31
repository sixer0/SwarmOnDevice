import { base64Encode } from "@opencode-ai/core/util/encode"
import { batch, createEffect, createMemo, createResource, on, onCleanup, untrack, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { selectionFromLines } from "@/context/file"
import { usePrompt, type Prompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { promptLength } from "./history"
import {
  asCommand,
  buildItems,
  definitionPattern,
  escapeRegex,
  extractRefs,
  extractTerms,
  isAttachItem,
  lineWindow,
  normalizeRefPath,
  pickIdentifier,
  promptText,
  replaceInPrompt,
  resolveRef,
  savedCommandFor,
  similarSessions,
  type IdentifierMatch,
  type PreflightFacts,
  type PreflightItem,
  type ResolvedRef,
} from "./preflight-model"

const MIN_DRAFT_LENGTH = 12
const DEBOUNCE_MS = 350
const PROJECT_REFRESH_MS = 20_000
const BUSY_SESSION_LIMIT = 3
const BUSY_MESSAGE_LIMIT = 30
const RETRY_BASE_MS = 3000
const MAX_RETRIES = 3

export type PreflightWorktree = {
  selected: Accessor<string>
  available: Accessor<boolean>
  isolate: () => void
}

const emptyDraftFacts = () => ({
  refs: [] as ResolvedRef[],
  identifiers: [] as IdentifierMatch[],
})

export function createPreflight(input: {
  active: Accessor<boolean>
  fresh: Accessor<boolean>
  sessionID: Accessor<string | undefined>
  worktree?: PreflightWorktree
}) {
  const prompt = usePrompt()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()

  const [store, setStore] = createStore({
    ...emptyDraftFacts(),
    dirty: [] as string[],
    busy: [] as PreflightFacts["busy"],
    settled: "",
    failed: false,
    retries: 0,
    cooldown: 0,
    dismissed: {} as Record<string, boolean | undefined>,
  })

  const directory = () => sdk().directory
  const text = createMemo(() => promptText(prompt.current()))
  const enabled = createMemo(() => input.active() && text().trim().length >= MIN_DRAFT_LENGTH && !/^\s*\//.test(text()))
  const refs = createMemo(() => (enabled() ? extractRefs(text(), directory()) : []))
  const terms = createMemo(() => (enabled() ? extractTerms(text(), refs()) : { identifiers: [] }))
  // Typing inside a word changes the draft constantly; only a change in what would be searched costs a request.
  const signature = createMemo(() =>
    enabled() ? JSON.stringify([directory(), refs().map((ref) => [ref.path, ref.line]), terms()]) : "",
  )

  const attached = createMemo(() => [
    ...prompt.context.items().map((item) => item.path),
    ...prompt.current().flatMap((part) => (part.type === "file" ? [part.path] : [])),
  ])
  const similar = createMemo(() => {
    if (!input.fresh() || !store.settled) return []
    return similarSessions(
      store.settled,
      sync().data.session.map((session) => ({
        id: session.id,
        title: session.title,
        updated: session.time.updated,
        parentID: session.parentID,
        archived: session.time.archived,
      })),
      input.sessionID(),
    )
  })
  // Best effort like the other project facts: without the list there is simply no row.
  const [savedCommands, savedControl] = createResource(
    () => (input.active() && input.fresh() ? sdk() : undefined),
    (current) =>
      current.client.savedCommand.list().then(
        (response) => response.data ?? [],
        () => [],
      ),
  )
  createEffect(() => onCleanup(sdk().event.on("command.updated", () => void savedControl.refetch())))
  // Costs nothing to compare, so it follows the draft as typed rather than the last search.
  const saved = createMemo(() => (input.fresh() ? savedCommandFor(text(), savedCommands.latest ?? []) : undefined))
  const isolated = () => {
    const selected = input.worktree?.selected()
    return !!selected && selected !== "main" && selected !== directory()
  }
  const items = createMemo<PreflightItem[]>((previous) => {
    const next = enabled()
      ? buildItems({
          attached: attached(),
          dismissed: store.dismissed,
          isolated: isolated(),
          facts: {
            refs: store.refs,
            identifiers: store.identifiers,
            dirty: input.fresh() ? store.dirty : [],
            busy: input.fresh() ? store.busy : [],
            similar: similar(),
            saved: saved(),
          },
        })
      : []
    // Rows are rebuilt on every keystroke. Keeping unchanged objects means the list does not remount under the user,
    // which would also drop keyboard focus out of the panel.
    return next.map((item) => {
      const same = previous.find((old) => old.key === item.key)
      return same && JSON.stringify(same) === JSON.stringify(item) ? same : item
    })
  }, [])

  const findFiles = (query: string, limit: number, signal: AbortSignal) =>
    serverSDK()
      .api.file.find({ location: { directory: directory() }, query, type: "file", limit }, { signal })
      .then((result) => result.data.map((entry) => normalizeRefPath(entry.path, directory())))
  const grep = (pattern: string, signal: AbortSignal) =>
    sdk()
      .client.find.text({ pattern }, { signal })
      .then((result) =>
        (result.data ?? []).map((hit) => ({
          path: normalizeRefPath(hit.path.text, directory()),
          line: hit.line_number,
        })),
      )

  const searchDraft = async (signal: AbortSignal) => {
    const [resolved, identifiers] = await Promise.all([
      Promise.allSettled(
        refs().map((ref) =>
          findFiles(ref.path.split("/").at(-1) ?? ref.path, 30, signal).then((paths) => resolveRef(ref, paths)),
        ),
      ),
      Promise.allSettled(
        terms().identifiers.map(async (identifier) => {
          const definitions = await grep(definitionPattern(identifier), signal)
          const uses = definitions.length > 0 ? [] : await grep(escapeRegex(identifier), signal)
          return pickIdentifier(identifier, definitions, uses)
        }),
      ),
    ])
    const fulfilled = <T,>(results: PromiseSettledResult<T>[]) =>
      results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    const all = [...resolved, ...identifiers]
    return {
      failed: all.length > 0 && all.every((result) => result.status === "rejected"),
      refs: fulfilled(resolved),
      identifiers: fulfilled(identifiers),
    }
  }

  let projectChecked = { directory: "", at: 0 }
  // Facts about the place the agent will run rather than the draft. They are best effort: a folder without git is
  // normal, so a failure here means no row and never an error.
  const refreshProject = async (signal: AbortSignal) => {
    if (!input.fresh()) return
    const dir = directory()
    if (projectChecked.directory === dir && Date.now() - projectChecked.at < PROJECT_REFRESH_MS) return
    projectChecked = { directory: dir, at: Date.now() }

    const client = sdk().client
    const busySessions = sync()
      .data.session.filter((session) => !session.parentID && !session.time.archived)
      .filter((session) => session.id !== input.sessionID() && sync().data.session_working(session.id))
      .slice(0, BUSY_SESSION_LIMIT)
    const [dirty, busy] = await Promise.all([
      serverSDK()
        .api.vcs.status({ location: { directory: dir } }, { signal })
        .then(
          (result) => result.data.map((file) => file.file),
          () => [] as string[],
        ),
      Promise.all(
        // A running session has no summary diff yet. Its patch parts are the record of what each finished step changed.
        busySessions.map((session) =>
          client.session.messages({ sessionID: session.id, limit: BUSY_MESSAGE_LIMIT }, { signal }).then(
            (result) => ({
              id: session.id,
              title: session.title,
              files: [
                ...new Set(
                  (result.data ?? []).flatMap((message) =>
                    message.parts.flatMap((part) =>
                      part.type === "patch" ? part.files.map((file) => normalizeRefPath(file, dir)) : [],
                    ),
                  ),
                ),
              ],
            }),
            () => ({ id: session.id, title: session.title, files: [] as string[] }),
          ),
        ),
      ),
    ])
    if (signal.aborted) return
    batch(() => {
      setStore("dirty", reconcile(dirty))
      setStore("busy", reconcile(busy))
    })
  }

  let controller: AbortController | undefined
  const run = () => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    void Promise.all([searchDraft(current.signal), refreshProject(current.signal)])
      .then(([draft]) => {
        if (current.signal.aborted) return
        batch(() => {
          setStore("settled", text())
          setStore("failed", draft.failed)
          if (draft.failed) return
          setStore("retries", 0)
          setStore("refs", reconcile(draft.refs))
          setStore("identifiers", reconcile(draft.identifiers))
        })
      })
      .catch(() => {
        // searchDraft settles every request itself, so only a thrown refreshProject can land here.
        if (!current.signal.aborted) setStore("failed", true)
      })
  }

  createEffect(
    on(signature, (value) => {
      if (!value) {
        controller?.abort()
        batch(() => {
          setStore({ ...emptyDraftFacts(), settled: "", failed: false, retries: 0 })
          // A cleared draft is a new message, so what was dismissed for the old one can come back.
          if (!untrack(() => text().trim())) setStore("dismissed", reconcile({}))
        })
        return
      }
      const timer = setTimeout(run, DEBOUNCE_MS)
      onCleanup(() => clearTimeout(timer))
    }),
  )
  onCleanup(() => controller?.abort())

  let cooldownTimer: ReturnType<typeof setInterval> | undefined
  onCleanup(() => clearInterval(cooldownTimer))
  const retry = () => {
    if (store.cooldown > 0 || store.retries >= MAX_RETRIES) return
    const seconds = (RETRY_BASE_MS * 2 ** store.retries) / 1000
    setStore({ retries: store.retries + 1, cooldown: seconds })
    clearInterval(cooldownTimer)
    cooldownTimer = setInterval(() => {
      if (store.cooldown <= 1) clearInterval(cooldownTimer)
      setStore("cooldown", (value) => Math.max(0, value - 1))
    }, 1000)
    run()
  }

  const setPrompt = (next: Prompt) => prompt.set(next, promptLength(next))
  const attach = (item: PreflightItem) => {
    if (!isAttachItem(item)) return
    const line = "line" in item ? item.line : undefined
    prompt.context.add({
      type: "file",
      path: item.path,
      selection: line ? selectionFromLines(lineWindow(line)) : undefined,
    })
  }

  // The composer has no chip for a plain file attachment (only for comments), so this is where they are visible at all.
  const attachments = createMemo(() =>
    input.active() ? prompt.context.items().filter((item) => !item.comment?.trim()) : [],
  )

  return {
    items,
    attachments,
    detach: (key: string) => prompt.context.remove(key),
    failed: () => store.failed,
    cooldown: () => store.cooldown,
    retriesLeft: () => store.retries < MAX_RETRIES,
    worktreeAvailable: () => !!input.worktree?.available() && !isolated(),
    retry,
    attach,
    dismiss: (key: string) => setStore("dismissed", key, true),
    isolate: () => input.worktree?.isolate(),
    useCommand: (name: string) => setPrompt(asCommand(prompt.current(), name)),
    fixTypo: (item: Extract<PreflightItem, { kind: "typo" }>) => {
      // The next search would clear this row, but not before focus has moved on from a button about to vanish.
      setStore("dismissed", item.key, true)
      setPrompt(replaceInPrompt(prompt.current(), item.raw, item.line ? `${item.path}:${item.line}` : item.path))
    },
    // Moves the whole draft, attachments included, so nothing typed so far has to be redone in the other session.
    moveDraftTo: (sessionID: string) => {
      const scope = { dir: base64Encode(directory()), id: sessionID }
      const parts = prompt.current()
      const context = prompt.context.items()
      prompt.set(parts, promptLength(parts), scope)
      const target = prompt.capture(scope)
      context.forEach((item) => target.context.add(item))
      prompt.reset()
    },
  }
}

export type PreflightController = ReturnType<typeof createPreflight>
