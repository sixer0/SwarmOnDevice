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

export type MissionControlResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

/** The read half of `MissionControlPlatform` (§3.2). Writes are row 131's. */
export type MissionSource = {
  list(input: { directory: string }): Promise<MissionControlResult<{ items: MissionListItemWire[] }>>
  get(input: { mission: string }): Promise<MissionControlResult<MissionGetWire>>
}

/** Adapter: the platform's optional `missions` field; absent = mission control absent (web build, older preload). */
export function missionSourceOf(platform: object): MissionSource | undefined {
  const missions = (platform as { missions?: Partial<MissionSource> }).missions
  if (!missions || typeof missions.list !== "function" || typeof missions.get !== "function") return
  return missions as MissionSource
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
}

/** live = Agents view visible (3 s, list + get); discover = map open, other filter (15 s, list only); stopped. */
export type PollMode = "live" | "discover" | "stopped"

export const LIVE_MS = 3000
export const SLOW_LIVE_MS = 5000
export const SLOW_TICK_MS = 500
export const DISCOVER_MS = 15000
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
  return { options: [], selected: undefined, mission: null, readFailed: false, listed: false }
}

export function createMissionPoller(input: {
  source: MissionSource
  directory: () => string | undefined
  lang: () => "en" | "id"
  /** names of the files in `docs/<mission>` of the session (§7.3); called once per `get` change */
  listFiles?: (path: string) => Promise<string[]>
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

  const fail = () => {
    failures++
    emit({ readFailed: true })
  }

  const delay = () => {
    if (failures > 0) return BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]
    if (mode === "live") return slow ? SLOW_LIVE_MS : LIVE_MS
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
    const listed = await input.source.list({ directory }).catch(() => undefined)
    if (current() === "stopped" || disposed || directory !== input.directory()) return
    if (!listed || !listed.ok) return fail()
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
    if (mode !== "live") {
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
    const stale = () => disposed || current() !== "live" || directory !== input.directory() || state.selected !== chosen
    const got = await input.source.get({ mission: selected }).catch(() => undefined)
    if (stale()) return
    if (!got || !got.ok) {
      emit({ options, selected })
      return fail()
    }
    const present = input.listFiles
      ? new Set(await input.listFiles(`docs/${selected}`).catch(() => [] as string[]))
      : new Set<string>()
    if (stale()) return
    failures = 0
    seen = { directory, key, selected }
    emit({ options, selected, mission: buildMission(got.data, input.lang(), present), readFailed: false })
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
  if (!view.docVisible) return "stopped"
  if (view.watching) return "live"
  if (view.mapOpen) return "discover"
  return "stopped"
}

/** Solid wrapper for session.tsx (row 133): polls only while someone can see the result. */
export function createMissionControl(input: {
  source: MissionSource | undefined
  directory: Accessor<string | undefined>
  lang: Accessor<"en" | "id">
  /** the Agents view of the session map is shown */
  watching: Accessor<boolean>
  /** the session map is open (any filter) */
  mapOpen: Accessor<boolean>
  listFiles?: (path: string) => Promise<string[]>
}) {
  const [state, setState] = createStore<MissionControlState>(emptyMissionState())
  const source = input.source
  if (!source) return { state, available: false, select: (_id: string) => {}, refresh: () => {} }

  const poller = createMissionPoller({
    source,
    directory: input.directory,
    lang: input.lang,
    listFiles: input.listFiles,
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
  onCleanup(() => poller.dispose())

  return {
    state,
    available: true,
    select: (id: string) => poller.select(id),
    refresh: () => poller.refresh(),
  }
}
