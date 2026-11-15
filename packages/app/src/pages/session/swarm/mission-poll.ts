// Mission control poll controller (row 129; masterplan/01_specs_mission_control_ui.md §4, §9.2).
// The source is one small adapter over window.api.missions (row 127) so tests drive a fake.
import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import {
  buildMission,
  missionOptions,
  pickSelected,
  type MissionGetWire,
  type MissionListItemWire,
  type MissionOption,
  type MissionVM,
} from "./mission-model"
import { registerStudioOutputs } from "../studio-output-registry"
import { MISSION_DELIVERABLES_DIR } from "./mission-deliverables-model"
import { canonicalPathKey } from "@/utils/path-key"

/**
 * One entry of a folder listing for the deliverables lookup. A bare name is an entry the caller already chose to
 * show (a file or an `.app` bundle); it is never taken for a folder.
 */
type MissionFileEntry = string | { name: string; type: "file" | "directory" }

const isAbsolutePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")

/**
 * 1.2.9 row 56 (AC-C08a, N9-070): the folder the deliverables of a mission are looked up in. The mission's
 * `project.dir` is data an agent writes at create, and listing a folder boots a server instance there (which reads
 * that folder's config), so it is used only when it is the session's folder or a folder the app already has open
 * (the Default Project root or one of its groups). The answer is the app's own spelling of that folder, never the
 * agent's. Otherwise `undefined`: no lookup is made. No project folder (an older host): the session's folder.
 * @internal test seam
 */
export function deliverablesDir(input: {
  projectDir: string | undefined
  session: string
  open: readonly string[]
}): string | undefined {
  const dir = input.projectDir
  if (!dir) return input.session
  if (!isAbsolutePath(dir) || dir.split(/[\\/]/).some((part) => part === "." || part === "..")) return
  const key = canonicalPathKey(dir)
  return [input.session, ...input.open].find((folder) => isAbsolutePath(folder) && canonicalPathKey(folder) === key)
}

/** The names a deliverables list shows: files and macOS `.app` bundles (revealed, never run); no other folder. */
const shownNames = (entries: readonly MissionFileEntry[]) =>
  entries.flatMap((entry) => {
    if (typeof entry === "string") return [entry]
    if (entry.type === "file" || (entry.type === "directory" && /\.app$/i.test(entry.name))) return [entry.name]
    return []
  })

const holdsFolder = (entries: readonly MissionFileEntry[], name: string) =>
  entries.some((entry) => typeof entry !== "string" && entry.type === "directory" && entry.name === name)

export type MissionControlResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

/** The read half of `MissionControlPlatform` (§3.2). Writes are row 131's. */
export type MissionSource = {
  /** Row 183 (L36): sessions = the current session and its run's (subagent) sessions; their linked missions are listed too. */
  list(input: { directory: string; sessions?: string[] }): Promise<MissionControlResult<{ items: MissionListItemWire[] }>>
  get(input: { mission: string }): Promise<MissionControlResult<MissionGetWire>>
}

/** Adapter: the platform's optional `missions` field; absent = mission control absent (web build, older preload). */
export function missionSourceOf(platform: object): MissionSource | undefined {
  const missions = (platform as { missions?: Partial<MissionSource> }).missions
  if (!missions || typeof missions.list !== "function" || typeof missions.get !== "function") return
  return missions as MissionSource
}

/** Row 183: main's limit (desktop mission-client.ts MISSION_LIST_SESSIONS_MAX) and its session id check. */
export const MISSION_SESSIONS_MAX = 50
const SESSION_ID_RE = /^ses_[A-Za-z0-9]{1,64}$/

/**
 * Row 183 (L36): the session ids a mission list takes: the current session first, then the sessions of its run (the
 * Agents view's tree: root and subagents, already in the session store), deduplicated, valid ids only, at most
 * MISSION_SESSIONS_MAX. A plain array: it crosses structured clone in the preload.
 */
export function missionSessionsOf(current: string | undefined, run: readonly string[]): string[] {
  const out: string[] = []
  for (const id of [current, ...run]) {
    if (out.length >= MISSION_SESSIONS_MAX) break
    if (typeof id === "string" && SESSION_ID_RE.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

export type MissionControlState = {
  options: MissionOption[]
  selected: string | undefined
  mission: MissionVM | null
  readFailed: boolean
  /**
   * The first list of this directory has answered (row 136 L1, C145). Until then "no missions" is unknown, not a
   * reason to drop the remembered Agents filter (session.tsx).
   */
  listed: boolean
  /**
   * Row 180: the last list answered HOST_UNAVAILABLE (main's mission-ipc.ts: DATUM Studio is not running). Mission
   * control shows one muted line for it instead of nothing; any answered list clears it.
   */
  unavailable: boolean
  /**
   * 1.2.9 row 56b (AC-C08a residual, C53): the folder the shown mission's deliverables were found in (the folder
   * `deliverablesDir` chose), when it is not the session's own folder, for example the Default Project root seen from a
   * session in one of its groups. Open and Reveal of those lines act on that folder (mission-control.tsx).
   * `undefined` = the session's folder, or no lookup: Open and Reveal work as before.
   */
  deliverablesFolder?: string
}

/**
 * live = Agents view visible (3 s, list + get); background = Agents view open in a hidden window (15 s, list + get;
 * row 173, F146b-1); discover = map open, other filter (15 s, list only); stopped.
 */
export type PollMode = "live" | "background" | "discover" | "stopped"

export const LIVE_MS = 3000
export const SLOW_LIVE_MS = 5000
export const SLOW_TICK_MS = 500
export const DISCOVER_MS = 15000
/** Row 173 (F146b-1): hidden window, Agents view open. Keeps the view current for when the user looks again. */
export const BACKGROUND_MS = 15000
/**
 * Row 173 (F146b-1): a source call that has not answered by now counts as a failed read, so one hung call can never
 * leave `inFlight` set and stop the poll for good. Main's own host timeout is 5 s; this guards the IPC hop itself.
 */
export const READ_TIMEOUT_MS = 20000
export const BACKOFF_MS = [3000, 6000, 12000, 30000]

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

export function emptyMissionState(): MissionControlState {
  return {
    options: [],
    selected: undefined,
    mission: null,
    readFailed: false,
    listed: false,
    unavailable: false,
    deliverablesFolder: undefined,
  }
}

export function createMissionPoller(input: {
  source: MissionSource
  directory: () => string | undefined
  /** Row 183: read per list, never fetched here (the session store already holds the run's sessions) */
  sessions?: () => readonly string[] | undefined
  lang: () => "en" | "id"
  /** the entries of `docs/<mission>` and `docs/<mission>/11_deliverables` (§7.3, 1.2.7 U-2), listed in `directory`
   * (1.2.9 row 56: the folder `deliverablesDir` chose); called once per `get` change, per folder */
  listFiles?: (path: string, directory: string) => Promise<MissionFileEntry[]>
  /** 1.2.9 row 56: the folders the app already has open (project roots and their groups), for `deliverablesDir` */
  openFolders?: () => readonly string[]
  onState: (state: MissionControlState) => void
  timers?: Timers
}) {
  const timers = input.timers ?? realTimers
  let mode: PollMode = "stopped"
  // Read through a function: mode can change while a call is awaited (TS would narrow a direct read).
  const current = () => mode
  let state = emptyMissionState()
  let handle: unknown
  let inFlight = false
  let force = false
  let failures = 0
  let slow = false
  let seen: { directory?: string; key?: string; selected?: string } = {}
  let disposed = false

  const emit = (next: Partial<MissionControlState>) => {
    state = { ...state, ...next }
    input.onState(state)
  }

  const reading = () => mode === "live" || mode === "background"
  /** One source call under READ_TIMEOUT_MS; a rejection or a timeout is `undefined` (a failed read). */
  const within = <T,>(work: () => Promise<T>) =>
    new Promise<T | undefined>((resolve) => {
      const timer = timers.setTimeout(() => resolve(undefined), READ_TIMEOUT_MS)
      const settle = (value: T | undefined) => {
        timers.clearTimeout(timer)
        resolve(value)
      }
      let call: Promise<T>
      try {
        call = work()
      } catch (error) {
        call = Promise.reject(error)
      }
      call.then(settle, () => settle(undefined))
    })

  const fail = () => {
    failures++
    emit({ readFailed: true })
  }

  const delay = () => {
    if (failures > 0) return BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]
    if (mode === "live") return slow ? SLOW_LIVE_MS : LIVE_MS
    if (mode === "background") return BACKGROUND_MS
    return DISCOVER_MS
  }

  const schedule = () => {
    if (handle !== undefined) timers.clearTimeout(handle)
    handle = undefined
    if (disposed || mode === "stopped") return
    handle = timers.setTimeout(() => {
      handle = undefined
      void tick()
    }, delay())
  }

  async function tick() {
    if (disposed || mode === "stopped") return
    if (inFlight) return
    inFlight = true
    const started = timers.now()
    try {
      await read()
    } finally {
      inFlight = false
      if (current() === "live") slow = timers.now() - started > SLOW_TICK_MS
      if (force && current() !== "stopped") {
        force = false
        void tick()
      } else schedule()
    }
  }

  async function read() {
    const directory = input.directory()
    if (!directory) {
      seen = {}
      // No project folder: there can be no mission, so the answer is known.
      emit({ ...emptyMissionState(), listed: true })
      return
    }
    if (directory !== seen.directory) {
      seen = { directory }
      emit(emptyMissionState())
    }
    const sessions = [...(input.sessions?.() ?? [])].slice(0, MISSION_SESSIONS_MAX)
    // 1.2.7 U-1 (U2): the panel lists only missions linked to this window's sessions. No session, no mission.
    if (sessions.length === 0) {
      failures = 0
      seen = { directory }
      emit({ ...emptyMissionState(), listed: true })
      return
    }
    const listed = await within(() => input.source.list({ directory, sessions }))
    if (current() === "stopped" || disposed || directory !== input.directory()) return
    if (!listed || !listed.ok) {
      emit({ unavailable: listed?.code === "HOST_UNAVAILABLE" })
      return fail()
    }
    if (state.unavailable) emit({ unavailable: false })
    const items = listed.data.items
    const selected = pickSelected(items, state.selected)
    const options = missionOptions(items)
    // First answer for this directory: publish the options with it, so `listed` never shows with stale options.
    if (!state.listed) emit({ options, listed: true })
    if (!selected) {
      failures = 0
      seen = { directory }
      emit({ options, selected: undefined, mission: null, readFailed: false })
      return
    }
    if (!reading()) {
      failures = 0
      emit({ options, selected, readFailed: false })
      return
    }
    const item = items.find((it) => it.id === selected)!
    const key = `${item.updatedAt}|${item.activityAt ?? ""}`
    if (key === seen.key && selected === seen.selected && state.mission && !state.readFailed) {
      failures = 0
      emit({ options, selected })
      return
    }
    // Row 136 M2: after every await, a read that no longer matches what the user sees is dropped (no emit). A changed
    // selection set `force` through refresh(), so the next tick reads the new choice at once.
    const chosen = state.selected
    const stale = () => disposed || !reading() || directory !== input.directory() || state.selected !== chosen
    const got = await within(() => input.source.get({ mission: selected }))
    if (stale()) return
    if (!got || !got.ok) {
      emit({ options, selected })
      return fail()
    }
    const listFiles = input.listFiles
    // 1.2.9 row 56 (AC-C08a): the lookups go to the mission's folder under the directory rule; none outside it.
    const lookup = listFiles
      ? deliverablesDir({
          projectDir: got.data.mission.project?.dir,
          session: directory,
          open: input.openFolders?.() ?? [],
        })
      : undefined
    const docs = lookup ? ((await within(() => listFiles!(`docs/${selected}`, lookup))) ?? []) : []
    if (stale()) return
    const present = new Set(shownNames(docs))
    // 1.2.7 U-2 (C10): also docs/<m>/11_deliverables (numbered export, row 28): Studio outputs found there and the
    // folder lines. 1.2.9 row 56: asked for only when the docs/<m> listing holds that folder, so a missing folder is
    // never looked up poll after poll.
    const delivered = new Set<string>()
    if (lookup && holdsFolder(docs, MISSION_DELIVERABLES_DIR)) {
      const found = await within(() => listFiles!(`docs/${selected}/${MISSION_DELIVERABLES_DIR}`, lookup))
      if (stale()) return
      for (const name of shownNames(found ?? [])) delivered.add(name)
    }
    failures = 0
    seen = { directory, key, selected }
    const mission = buildMission(got.data, input.lang(), present, delivered)
    // Row 165E (C192): the deliverables found in the project are the registered Studio outputs the file tab renders.
    // Folder lines (1.2.7 U-2) are never registered: a non-Studio .html opens as code (C101). The paths are relative
    // to the folder they were found in (1.2.9 row 56).
    registerStudioOutputs(
      lookup,
      mission.deliverables.filter((d) => d.origin !== "folder").map((d) => d.projectPath),
    )
    // 1.2.9 row 56b: the lines' folder travels with them, so Open and Reveal never resolve them against the session.
    const deliverablesFolder =
      lookup && canonicalPathKey(lookup) !== canonicalPathKey(directory) ? lookup : undefined
    emit({ options, selected, mission, readFailed: false, deliverablesFolder })
  }

  const refresh = () => {
    seen = { ...seen, key: undefined }
    if (mode === "stopped") return
    if (inFlight) force = true
    else void tick()
  }

  return {
    state: () => state,
    mode: () => mode,
    setMode(next: PollMode) {
      if (next === mode) return
      const was = mode
      mode = next
      if (next === "stopped") {
        if (handle !== undefined) timers.clearTimeout(handle)
        handle = undefined
        return
      }
      // Becoming visible reads at once; dropping from live to discover just waits for its next tick.
      if (was === "stopped" || next === "live") {
        if (inFlight) force = true
        else void tick()
      } else schedule()
    },
    select(id: string) {
      if (id === state.selected) return
      emit({ selected: id, mission: null })
      refresh()
    },
    /** After a write or a selection change: read now (or right after the read in flight). */
    refresh,
    dispose() {
      disposed = true
      mode = "stopped"
      if (handle !== undefined) timers.clearTimeout(handle)
      handle = undefined
    },
  }
}

/** §4.2: which poll runs, from what the user can see. */
export function pollModeOf(view: { docVisible: boolean; watching: boolean; mapOpen: boolean }): PollMode {
  // Row 173 (F146b-1): a hidden window (display off, screen locked, another window on top) no longer freezes the
  // Agents view at its last state; it reads at the slow cadence and at once when the window is visible again.
  // 1.2.7 row 58d (F-6): with the map open but another filter shown, a hidden window still lists (discover: list only,
  // 15 s). After a restart the window can start hidden; without the first list the Agents entry, which needs a known
  // mission (offersAgentsView), was never offered for a one-agent session with missions.
  if (!view.docVisible) return view.watching ? "background" : view.mapOpen ? "discover" : "stopped"
  if (view.watching) return "live"
  if (view.mapOpen) return "discover"
  return "stopped"
}

/** Solid wrapper for session.tsx (row 133): polls only while someone can see the result. */
export function createMissionControl(input: {
  source: MissionSource | undefined
  directory: Accessor<string | undefined>
  /** Row 183: the current session and its run's sessions (missionSessionsOf) */
  sessions?: Accessor<readonly string[] | undefined>
  lang: Accessor<"en" | "id">
  /** the Agents view of the session map is shown */
  watching: Accessor<boolean>
  /** the session map is open (any filter) */
  mapOpen: Accessor<boolean>
  listFiles?: (path: string, directory: string) => Promise<MissionFileEntry[]>
  /** 1.2.9 row 56: the folders the app already has open (deliverablesDir) */
  openFolders?: () => readonly string[]
}) {
  const [state, setState] = createStore<MissionControlState>(emptyMissionState())
  const source = input.source
  if (!source) return { state, available: false, select: (_id: string) => {}, refresh: () => {} }

  const poller = createMissionPoller({
    source,
    directory: input.directory,
    sessions: input.sessions,
    lang: input.lang,
    listFiles: input.listFiles,
    openFolders: input.openFolders,
    onState: (next) => setState(reconcile(next)),
  })

  const docVisible = () => typeof document === "undefined" || document.visibilityState === "visible"
  const apply = () =>
    poller.setMode(pollModeOf({ docVisible: docVisible(), watching: input.watching(), mapOpen: input.mapOpen() }))
  let lastDirectory: string | undefined
  createEffect(() => {
    input.watching()
    input.mapOpen()
    const directory = input.directory()
    apply()
    if (lastDirectory !== undefined && directory !== lastDirectory) poller.refresh()
    lastDirectory = directory
  })
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", apply)
    onCleanup(() => document.removeEventListener("visibilitychange", apply))
  }
  // Row 173: a window that comes back without a visibilitychange (focus / bfcache) re-applies the mode too.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", apply)
    window.addEventListener("pageshow", apply)
    onCleanup(() => {
      window.removeEventListener("focus", apply)
      window.removeEventListener("pageshow", apply)
    })
  }
  onCleanup(() => poller.dispose())

  return {
    state,
    available: true,
    select: (id: string) => poller.select(id),
    refresh: () => poller.refresh(),
  }
}
