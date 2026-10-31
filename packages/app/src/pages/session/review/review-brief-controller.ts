import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { Event } from "@opencode-ai/schema/event"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { useSDK } from "@/context/sdk"
import type { useServerSync } from "@/context/server-sync"
import type { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/pages/layout/helpers"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import type { MapStep } from "../map/session-map-model"
import { sessionTree } from "../swarm/swarm-model"
import type { RenderDiff } from "../v2/review-diff-kinds"
import {
  buildActivity,
  buildBrief,
  changeHash,
  flaggedLines,
  nextOpenFile,
  reversePatch,
  type Brief,
  type BriefFile,
  type CheckKind,
  type Flag,
  type ReviewMark,
  type ReviewVerdict,
} from "./review-brief-model"
import { composeMessage, includedByDefault, teamUpdate } from "./review-landing-model"
import { createLandedWork } from "./landed-work"

const HISTORY_LIMIT = 2000
const HYDRATE_CONCURRENCY = 3
const MAX_MARKED_FILES = 2000
const CONFIRM_MS = 4000
const MAX_HISTORY_RETRIES = 3
const HISTORY_RETRY_SECONDS = 3
// Git's own name for it, kept as written in every language.
const DETACHED = "detached HEAD"

export type UndoneFile = { file: string; patch: string }

export function createReviewBrief(input: {
  sessionID: Accessor<string | undefined>
  enabled: Accessor<boolean>
  // The undo action reverses a patch against the working tree, which only means something for working changes.
  undoable: Accessor<boolean>
  diffs: Accessor<readonly RenderDiff[]>
  activeFile: Accessor<string | undefined>
  selectFile: (file: string) => void
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  serverSync: ReturnType<typeof useServerSync>
  refresh: () => void
  openStep: (sessionID: string, step: MapStep) => void
  draftToComposer: (text: string) => void
}) {
  const language = useLanguage()
  const session = () => input.serverSync().session
  const data = () => session().data
  const directory = () => input.sdk().directory

  const [store, setStore] = persisted(
    Persist.global("review-marks"),
    createStore({ marks: {} as Record<string, Record<string, ReviewMark | undefined> | undefined> }),
  )
  const landedWork = createLandedWork()
  const [view, setView] = createStore({
    read: {} as Record<string, boolean | undefined>,
    readFailed: {} as Record<string, boolean | undefined>,
    discoverFailed: false,
    retries: 0,
    cooldown: 0,
    expanded: undefined as boolean | undefined,
    undone: [] as UndoneFile[],
    pendingUndo: undefined as string | undefined,
    undoing: false,
    rerunning: undefined as string | undefined,
    rerunnable: {} as Record<string, boolean | undefined>,
    landing: false,
    landingFiles: false,
    // A person's tick wins over the default, and a person's words win over the draft, whatever arrives later.
    picked: {} as Record<string, boolean | undefined>,
    edited: undefined as string | undefined,
    written: undefined as { subject?: string; summary?: string } | undefined,
    writing: false,
    committing: false,
    landError: undefined as string | undefined,
    copied: false,
  })
  const [focusLine, setFocusLine] = createSignal<{
    file: string
    line: number
    side: "additions" | "deletions"
    token: number
  }>()
  let token = 0
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(confirmTimer))

  // ---- History: a claim about what never happened needs the whole run, subagents included. -----------------------------

  const rootID = createMemo(() => input.sessionID())
  const treeIDs = createMemo(() => {
    const id = rootID()
    if (!id) return []
    return sessionTree(id, data().info)
      .map((item) => item.id)
      .filter((item) => item === id || !!data().info[item])
  })

  const discovered = new Set<string>()
  const discover = async (sessionID: string): Promise<void> => {
    if ((await input.sdk().protocol) !== "v1") return
    const result = await input.sdk().client.session.children({ sessionID }, { throwOnError: true })
    const children: Session[] = result.data ?? []
    batch(() => children.forEach((child) => session().remember(child)))
    await Promise.all(children.map((child) => discover(child.id)))
  }

  createEffect(() => {
    const id = rootID()
    if (!input.enabled() || !id || discovered.has(id)) return
    discovered.add(id)
    setView("discoverFailed", false)
    void discover(id).catch((error) => {
      console.debug("[review-brief] failed to list subagents", { sessionID: id, error })
      setView("discoverFailed", true)
    })
  })

  const pinned = new Set<string>()
  const queue: string[] = []
  let hydrating = 0
  const readSession = async (id: string) => {
    setView("read", id, false)
    setView("readFailed", id, false)
    try {
      await session().sync(id)
      while (session().history.more(id) && (data().message[id]?.length ?? 0) < HISTORY_LIMIT) {
        const before = data().message[id]?.length ?? 0
        await session().history.loadMore(id)
        if ((data().message[id]?.length ?? 0) <= before) break
      }
      setView("read", id, !session().history.more(id))
    } catch (error) {
      console.debug("[review-brief] failed to read session history", { sessionID: id, error })
      setView("readFailed", id, true)
    }
  }
  const pump = () => {
    while (hydrating < HYDRATE_CONCURRENCY && queue.length > 0) {
      const id = queue.shift()!
      hydrating += 1
      void readSession(id).finally(() => {
        hydrating -= 1
        pump()
      })
    }
  }
  createEffect(() => {
    if (!input.enabled()) return
    treeIDs().forEach((id) => {
      if (pinned.has(id)) return
      pinned.add(id)
      session().pin(id)
      queue.push(id)
    })
    pump()
  })
  const release = () => {
    queue.length = 0
    pinned.forEach((id) => session().unpin(id))
    pinned.clear()
    setView("read", reconcile({}))
    setView("readFailed", reconcile({}))
  }
  onCleanup(release)
  createEffect(on(rootID, release, { defer: true }))
  createEffect(
    on(
      input.enabled,
      (enabled) => {
        if (!enabled) release()
      },
      { defer: true },
    ),
  )

  const historyComplete = createMemo(
    () => !view.discoverFailed && treeIDs().length > 0 && treeIDs().every((id) => view.read[id] === true),
  )
  const historyFailed = createMemo(() => view.discoverFailed || treeIDs().some((id) => view.readFailed[id] === true))

  let cooldownTimer: ReturnType<typeof setInterval> | undefined
  onCleanup(() => clearInterval(cooldownTimer))
  const canRetryHistory = () => view.cooldown === 0 && view.retries < MAX_HISTORY_RETRIES
  const retryHistory = () => {
    if (!canRetryHistory()) return
    const attempt = view.retries
    setView({ retries: attempt + 1, cooldown: HISTORY_RETRY_SECONDS * 2 ** attempt, discoverFailed: false })
    clearInterval(cooldownTimer)
    cooldownTimer = setInterval(() => {
      setView("cooldown", (value) => Math.max(0, value - 1))
      if (view.cooldown === 0) clearInterval(cooldownTimer)
    }, 1000)
    const id = rootID()
    if (id) {
      void discover(id).catch((error) => {
        console.debug("[review-brief] failed to list subagents", { sessionID: id, error })
        setView("discoverFailed", true)
      })
    }
    treeIDs()
      .filter((item) => view.readFailed[item])
      .forEach((item) => queue.push(item))
    pump()
  }

  const running = createMemo(() => treeIDs().some((id) => (data().session_status[id]?.type ?? "idle") !== "idle"))
  const rootBusy = createMemo(() => {
    const id = rootID()
    return !!id && (data().session_status[id]?.type ?? "idle") !== "idle"
  })

  // ---- The brief ----------------------------------------------------------------------------------------------------

  const marks = () => store.marks[directory()] ?? {}

  const brief = createMemo<Brief>(() => {
    const rootInfo = input.sync().project?.worktree
    const roots = [directory(), ...(rootInfo ? [rootInfo] : [])]
    const activity = buildActivity({
      sessions: (input.enabled() ? treeIDs() : []).map((id) => ({
        id,
        messages: data().message[id] ?? [],
        parts: (messageID: string) => data().part[messageID] ?? [],
        revertMessageID: data().info[id]?.revert?.messageID,
      })),
      roots,
      quiet: untrack,
    })
    return buildBrief({
      diffs: input.diffs(),
      activity,
      marks: marks(),
      running: running(),
      complete: historyComplete(),
    })
  })

  const activeBrief = createMemo(() => {
    const file = input.activeFile() ?? brief().order[0]
    return file ? brief().byFile.get(file) : undefined
  })

  // ---- Verdicts ----------------------------------------------------------------------------------------------------

  const setMark = (file: string, mark: ReviewMark | undefined) => {
    const dir = directory()
    setStore("marks", dir, (current) => {
      const next = { ...current }
      if (mark) next[file] = mark
      else delete next[file]
      const keys = Object.keys(next)
      if (keys.length > MAX_MARKED_FILES)
        keys.slice(0, keys.length - MAX_MARKED_FILES).forEach((key) => delete next[key])
      return next
    })
  }

  const decide = (file: string, verdict: ReviewVerdict, advance = true) => {
    const item = brief().byFile.get(file)
    if (!item) return
    const off = item.mark === verdict
    setMark(file, off ? undefined : { hash: item.hash, verdict })
    if (off || !advance) return
    const next = nextOpenFile(brief(), file)
    if (next) input.selectFile(next)
  }

  const decideGroup = (files: readonly string[]) => {
    const current = brief()
    batch(() =>
      files.forEach((file) => {
        const item = current.byFile.get(file)
        if (item) setMark(file, { hash: item.hash, verdict: "ok" })
      }),
    )
  }

  // ---- Jumping between flagged lines ----------------------------------------------------------------------------------

  const jumpLine = (file: string, line: number, side: "additions" | "deletions") => {
    token += 1
    if (input.activeFile() !== file) input.selectFile(file)
    setFocusLine({ file, line, side, token })
  }

  const nextFlag = () => {
    const item = activeBrief()
    if (!item) return false
    const lines = flaggedLines(item)
    if (lines.length === 0) return false
    const current = focusLine()
    const at =
      current?.file === item.file
        ? lines.findIndex((line) => line.line === current.line && line.side === current.side)
        : -1
    const target = lines[(at + 1) % lines.length]
    jumpLine(item.file, target.line, target.side)
    return true
  }

  // ---- Undo ----------------------------------------------------------------------------------------------------------

  const undoPatch = (item: BriefFile) => {
    if (!input.undoable() || item.status === undefined) return
    const diff = input.diffs().find((entry) => entry.file === item.file)
    return diff?.patch ? reversePatch(diff.patch) : undefined
  }

  // `git apply` exits 0 having done nothing for a path outside the current directory, so the only proof is a fresh diff.
  const stillChanged = async (file: string, hash: string | undefined) => {
    const result = await input
      .sdk()
      .api.vcs.diff({ location: { directory: directory() }, mode: "working" })
      .then((value) => value.data)
    const entry = result.find((item) => item.file === file)
    if (!entry) return false
    return hash === undefined || changeHash(entry) === hash
  }

  const undo = async (file: string) => {
    const item = brief().byFile.get(file)
    if (!item || view.undoing) return
    if (rootBusy()) return
    if (view.pendingUndo !== file) {
      setView("pendingUndo", file)
      clearTimeout(confirmTimer)
      confirmTimer = setTimeout(() => setView("pendingUndo", undefined), CONFIRM_MS)
      return
    }
    clearTimeout(confirmTimer)
    setView("pendingUndo", undefined)
    const diff = input.diffs().find((entry) => entry.file === file)
    const reverse = undoPatch(item)
    if (!diff?.patch || !reverse) return
    const forward = diff.patch
    setView("undoing", true)
    try {
      await input.sdk().client.vcs.apply({ patch: reverse }, { throwOnError: true })
      if (await stillChanged(file, item.hash)) throw new Error(language.t("session.review.undo.noEffect"))
      setMark(file, undefined)
      setView("undone", (list) => [...list.filter((entry) => entry.file !== file), { file, patch: forward }])
      const next = nextOpenFile(brief(), file)
      if (next) input.selectFile(next)
      input.refresh()
    } catch (error) {
      console.debug("[review-brief] undo failed", { file, error })
      showToast({
        variant: "error",
        title: language.t("session.review.undo.failed", { file }),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      setView("undoing", false)
    }
  }

  const restore = async (entry: UndoneFile) => {
    try {
      await input.sdk().client.vcs.apply({ patch: entry.patch }, { throwOnError: true })
      setView("undone", (list) => list.filter((item) => item.file !== entry.file))
      input.refresh()
    } catch (error) {
      console.debug("[review-brief] restore failed", { file: entry.file, error })
      showToast({
        variant: "error",
        title: language.t("session.review.restore.failed", { file: entry.file }),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    }
  }

  // ---- Re-running a check ---------------------------------------------------------------------------------------------

  // The server decides, with the same classifier the shell tool uses. Until it has said yes, or if it cannot say, no.
  const askedRerunnable = new Set<string>()
  createEffect(() => {
    const commands = [
      ...new Set(brief().evidence.flatMap((row) => (row.type === "check" ? [row.run.command] : []))),
    ].filter((command) => !askedRerunnable.has(command))
    if (commands.length === 0) return
    commands.forEach((command) => askedRerunnable.add(command))
    void input
      .sdk()
      .client.shell.rerunnable({ commands: commands.slice(0, 100) }, { throwOnError: true })
      .then((result) => {
        batch(() => commands.forEach((command) => setView("rerunnable", command, result.data.rerunnable.includes(command))))
      })
      .catch((error) => {
        commands.forEach((command) => askedRerunnable.delete(command))
        console.debug("[review-brief] could not check commands for a re-run", { error })
      })
  })

  const canRerun = (command: string) => !!view.rerunnable[command] && !rootBusy() && !!rootID() && !view.rerunning

  const rerun = async (command: string) => {
    const id = rootID()
    if (!id || !canRerun(command)) return
    const lastUser = (data().message[id] ?? []).findLast(
      (message: Message): message is Extract<Message, { role: "user" }> => message.role === "user",
    )
    if (!lastUser) return
    setView("rerunning", command)
    try {
      await input.sdk().api.session.shell({
        sessionID: id,
        id: Event.ID.create(),
        command,
        agent: lastUser.agent,
        model: { providerID: lastUser.model.providerID, modelID: lastUser.model.modelID },
      })
    } catch (error) {
      console.debug("[review-brief] re-run failed", { command, error })
      showToast({
        variant: "error",
        title: language.t("session.review.rerun.failed"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      setView("rerunning", undefined)
      input.refresh()
    }
  }

  // ---- The reply: everything the agent is told is written out in the composer, where it can be read and edited. --------

  const kindName = (kind: CheckKind) => language.t(`session.review.check.${kind}`)
  const flagLabel = (flag: Flag) => {
    const label = language.t(`session.review.flag.${flag.kind}`)
    return flag.count > 1 ? `${label} (${flag.count})` : label
  }

  const replyText = () => {
    const current = brief()
    const lines: string[] = []
    const claimed = new Set(
      current.evidence.flatMap((row) => (row.type === "claim" && row.run ? [row.run.command] : [])),
    )
    current.evidence.forEach((row) => {
      if (row.type === "claim" && row.against === "failed" && row.run) {
        lines.push(language.t("session.review.reply.claim", { quote: row.claim.quote, command: row.run.command }))
      } else if (row.type === "claim" && row.against === "none") {
        lines.push(language.t("session.review.evidence.claim.none", { quote: row.claim.quote }))
      } else if (row.type === "check" && row.status === "failed" && !claimed.has(row.run.command)) {
        lines.push(language.t("session.review.reply.failed", { command: row.run.command }))
      } else if (row.type === "check" && row.status === "stale") {
        lines.push(
          language.t("session.review.reply.stale", { command: row.run.command, count: row.editedAfter.length }),
        )
      } else if (row.type === "check" && row.status === "hidden") {
        lines.push(language.t("session.review.reply.hidden", { command: row.run.command }))
      }
    })
    current.files
      .filter((file) => file.mark === "work")
      .forEach((file) => {
        const reasons = file.flags
          .map((flag) => (flag.lines[0] ? `${flagLabel(flag)} L${flag.lines[0].line}` : flagLabel(flag)))
          .join("; ")
        lines.push(reasons ? `${file.file}: ${reasons}` : file.file)
      })
    if (lines.length === 0) return
    return [language.t("session.review.reply.lead"), ...lines.map((line) => `- ${line}`)].join("\n")
  }

  const sendBack = () => {
    const text = replyText()
    if (text) input.draftToComposer(text)
  }

  // ---- Landing: the reviewed files become a commit, and the team gets told. Nothing here runs without a click. -----------

  const canLand = () => input.undoable() && !running() && brief().files.length > 0
  const included = createMemo(() => {
    const picked = view.picked
    return new Set(brief().files.filter((file) => picked[file.file] ?? includedByDefault(file)).map((file) => file.file))
  })
  const lastModel = () =>
    (data().message[rootID() ?? ""] ?? []).findLast(
      (message: Message): message is Extract<Message, { role: "user" }> => message.role === "user",
    )?.model.modelID
  const draft = createMemo(() => {
    if (!view.landing) return ""
    return composeMessage({
      brief: brief(),
      included: included(),
      title: untitled(data().info[rootID() ?? ""]?.title),
      written: view.written,
      checks: {
        passed: (command) => language.t("session.review.land.check.passed", { command }),
        stale: (command, count) => language.t("session.review.land.check.stale", { command, count }),
        failed: (command, exit) => language.t("session.review.land.check.failed", { command, exit }),
        hidden: (command) => language.t("session.review.land.check.hidden", { command }),
        seen: (command) => language.t("session.review.evidence.seen", { check: command }),
        partial: (command) => language.t("session.review.land.check.partial", { command }),
        none: (kinds) =>
          language.t("session.review.land.check.none", { checks: kinds.map((kind) => kindName(kind)).join(", ") }),
      },
      words: {
        asked: language.t("session.review.land.asked"),
        checks: language.t("session.review.land.checks"),
        mixed: language.t("session.review.land.check.mixed"),
        leftOut: (files) => language.t("session.review.land.leftOut", { files }),
        provenance: (reviewed, total) =>
          language.t("session.review.land.provenance", { model: lastModel() ?? "", reviewed, total }),
      },
    })
  })
  const message = () => view.edited ?? draft()

  let draftToken = 0
  const openLanding = () => {
    if (!canLand() || view.landing) return false
    const id = rootID()
    setView({
      landing: true,
      landError: undefined,
      edited: undefined,
      written: undefined,
      picked: {},
      writing: !!id,
      // Nothing is going in by default, so the list is the next thing the person needs.
      landingFiles: brief().files.every((file) => !includedByDefault(file)),
    })
    if (!id) return true
    const token = ++draftToken
    // The record of the run is already a usable message, so the summary arrives if and when it can. It only replaces the
    // draft while the person has not typed, because `message` prefers what they wrote.
    void input
      .sdk()
      .client.vcs.commitDraft({ sessionID: id, files: [...included()] }, { throwOnError: true })
      .then((result) => {
        if (token === draftToken) setView("written", result.data)
      })
      .catch((error) => console.debug("[review-brief] commit draft failed", { error }))
      .finally(() => {
        if (token === draftToken) setView("writing", false)
      })
    return true
  }
  const closeLanding = () => {
    draftToken += 1
    setView({ landing: false, writing: false, landingFiles: false })
  }

  const land = async () => {
    const files = [...included()]
    const text = message().trim()
    if (!canLand() || view.committing || files.length === 0 || !text) return
    setView({ committing: true, landError: undefined })
    try {
      // What was read is what goes in. The panel keeps up as files change, so this only catches the last moment.
      const fresh = await input
        .sdk()
        .api.vcs.diff({ location: { directory: directory() }, mode: "working" })
        .then((value) => value.data)
      const moved = files.filter((file) => {
        const entry = fresh.find((item) => item.file === file)
        return !entry || changeHash(entry) !== brief().byFile.get(file)?.hash
      })
      if (moved.length > 0) {
        input.refresh()
        setView("landError", language.t("session.review.land.moved", { files: moved.join(", ") }))
        return
      }
      const result = await input.sdk().client.vcs.commit({ files, message: text }, { throwOnError: true })
      const done = result.data
      if (!done) throw new Error(language.t("common.requestFailed"))
      const headline = language.t("session.review.land.done", {
        hash: done.short,
        branch: done.branch ?? DETACHED,
      })
      batch(() => {
        done.files.forEach((file) => setMark(file, undefined))
        const id = rootID()
        if (id) landedWork.record(id, { headline, update: teamUpdate({ headline, message: text }), at: Date.now() })
        setView("copied", false)
        closeLanding()
      })
      input.refresh()
    } catch (error) {
      console.debug("[review-brief] commit failed", { error })
      setView("landError", commitError(error, language.t("common.requestFailed")))
    } finally {
      setView("committing", false)
    }
  }

  const copyUpdate = async () => {
    const update = landedWork.get(rootID())?.update
    if (!update) return
    try {
      await navigator.clipboard.writeText(update)
      setView("copied", true)
    } catch (error) {
      console.debug("[review-brief] copy failed", { error })
      showToast({ variant: "error", title: language.t("session.review.land.copyFailed") })
    }
  }

  createEffect(
    on(
      rootID,
      () => {
        closeLanding()
        setView({ copied: false, landError: undefined })
      },
      { defer: true },
    ),
  )

  return {
    brief,
    activeBrief,
    running,
    rootBusy,
    historyComplete,
    historyFailed,
    historyCooldown: () => view.cooldown,
    canRetryHistory,
    retryHistory,
    decide,
    decideGroup,
    jumpLine,
    nextFlag,
    focusLine,
    undo,
    canUndo: (item: BriefFile) => !rootBusy() && !!undoPatch(item),
    undoing: () => view.undoing,
    pendingUndo: () => view.pendingUndo,
    undone: () => view.undone,
    restore,
    rerun,
    canRerun,
    rerunning: () => view.rerunning,
    sendBack,
    canLand,
    branch: () => input.sync().data.vcs?.branch ?? DETACHED,
    landing: () => view.landing,
    openLanding,
    closeLanding,
    message,
    setMessage: (text: string) => setView("edited", text),
    included,
    pick: (file: string, on: boolean) => setView("picked", file, on),
    landingFiles: () => view.landingFiles,
    toggleLandingFiles: () => setView("landingFiles", (value) => !value),
    writing: () => view.writing && view.edited === undefined,
    committing: () => view.committing,
    landError: () => view.landError,
    land,
    landed: () => {
      const work = landedWork.get(rootID())
      return work?.dismissed ? undefined : work
    },
    dismissLanded: () => {
      const id = rootID()
      if (id) landedWork.dismiss(id)
    },
    copied: () => view.copied,
    copyUpdate,
    openStep: input.openStep,
    kindName,
    flagLabel,
    expanded: () => view.expanded,
    setExpanded: (value: boolean) => setView("expanded", value),
  }
}

// A session keeps its placeholder title until one is written, which says nothing about the work.
const untitled = (title: string | undefined) => (title && !/\d{4}-\d{2}-\d{2}T\d{2}:/.test(title) ? title : undefined)

// Git's own words are the useful part of a refused commit: what the hook said, what is wrong with the identity.
function commitError(error: unknown, fallback: string) {
  const data = error && typeof error === "object" && "data" in error ? (error as { data?: { message?: unknown } }).data : undefined
  if (typeof data?.message === "string" && data.message) return data.message
  return errorMessage(error, fallback)
}

export type ReviewBriefController = ReturnType<typeof createReviewBrief>
