// Decision card + command channel logic (row 131; masterplan/01_specs_mission_control_ui.md §2, §5.6, §6 items 20-31).
// Framework-free so tests drive a fake writer; mission-command.tsx renders it.
// The two write paths go through window.api.missions (row 127 bridge) via `missionWriterOf`, the write half of
// the row 129 adapter (`missionSourceOf` in mission-poll.ts is the read half). Every successful store write is
// followed by a refresh and a normal session prompt (§2); the prompt is sent only after the write succeeded (§12).
import { blockingSummary, FEED_SIZE, type MissionDecisionVM, type MissionFeedLine, type MissionVM } from "./mission-model"
import type { MissionControlResult } from "./mission-poll"

/** The write half of `MissionControlPlatform` (§3.2). */
export type MissionWriter = {
  answer(input: {
    mission: string
    request: string
    option: string
  }): Promise<MissionControlResult<{ decision: string; released: string[] }>>
  instruct(input: { mission: string; text: string; row?: string }): Promise<MissionControlResult<{ seq: number }>>
}

/** Adapter: the platform's optional `missions` field; absent (or read-only) = no writes offered. */
export function missionWriterOf(platform: object): MissionWriter | undefined {
  const missions = (platform as { missions?: Partial<MissionWriter> }).missions
  if (!missions || typeof missions.answer !== "function" || typeof missions.instruct !== "function") return
  return missions as MissionWriter
}

/** UI cap (§3.3): below the store's 8000; main checks the same rule again. */
export const INSTRUCTION_MAX = 2000

// C0 and C1 control characters (§3.3). An <input type=text> already drops line breaks; a pasted tab is the usual case.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

export type InstructionCheck = { ok: true; text: string } | { ok: false; reason: "empty" | "tooLong" }

/** Control characters become one space (the owner's own text, nothing is cut), then trim; 1..2000 chars. */
export function checkInstruction(raw: string): InstructionCheck {
  const text = raw.replace(CONTROL, " ").trim()
  if (!text) return { ok: false, reason: "empty" }
  if (text.length > INSTRUCTION_MAX) return { ok: false, reason: "tooLong" }
  return { ok: true, text }
}

export type Translate = (key: string, params?: Record<string, string | number | boolean>) => string

/** Feed "who" label (§5.6): owner = You, controller = Swarm, agent = its name or "Agent"; a row adds " · <row>". */
export function feedWho(line: MissionFeedLine, t: Translate) {
  const party = (side: MissionFeedLine["from"]) =>
    side === "owner"
      ? t("session.mission.you")
      : side === "controller"
        ? t("session.mission.swarm")
        : (line.agent ?? t("session.mission.feed.agent"))
  return `${party(line.from)} → ${party(line.to)}${line.row ? ` · ${line.row}` : ""}`
}

/** Command card head (§6 item 25). */
export function commandHead(model: MissionVM, t: Translate) {
  const { done, total } = model.progress
  return model.held > 0
    ? t("session.mission.command.held", { done, total, held: model.held })
    : t("session.mission.command.onTrack", { done, total })
}

/** Options as shown: label, one-line consequence, the Recommended tag on the recommended option only. */
export function decisionOptions(decision: MissionDecisionVM, t: Translate) {
  return decision.options.map((opt) => ({
    id: opt.id,
    label: opt.label,
    consequence: opt.consequence,
    tag: opt.recommended ? t("session.mission.decision.recommended") : undefined,
  }))
}

const time = (at: string) => {
  const ms = Date.parse(at)
  return Number.isFinite(ms) ? ms : 0
}

/** Store feed + local lines of this mission, by time, newest last, at most FEED_SIZE. */
export function mergeFeed(model: MissionVM, local: MissionFeedLine[]) {
  return [...model.feed, ...local].sort((a, b) => time(a.at) - time(b.at)).slice(-FEED_SIZE)
}

/** "What's blocking?" (§5.6): computed locally, never stored. */
export function whyLine(model: MissionVM, t: Translate, at: string, seq: number): MissionFeedLine {
  const rows = blockingSummary(model)
  return {
    key: `l${seq}`,
    from: "controller",
    to: "owner",
    text: rows.length ? t("session.mission.why.list", { rows: rows.join(", ") }) : t("session.mission.why.none"),
    at,
    local: true,
  }
}

export type MissionCommandState = {
  draft: string
  /** a write (answer or instruction) is in flight */
  busy: boolean
  /** "<mission>/<request>" answered from this view; their options stay disabled */
  answered: string[]
  decisionError: string | null
  inputError: string | null
  localMission: string | undefined
  local: MissionFeedLine[]
}

export function emptyCommandState(): MissionCommandState {
  return {
    draft: "",
    busy: false,
    answered: [],
    decisionError: null,
    inputError: null,
    localMission: undefined,
    local: [],
  }
}

const reasonOf = (result: { code: string; message: string }) => result.message || result.code
const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : String(error))

export function createCommandController(input: {
  writer: MissionWriter
  /** force a read now (row 129 `refresh`) */
  refresh: () => void
  /** a normal prompt to the open session's root (§2); rejects on failure */
  prompt: (text: string) => Promise<unknown>
  t: Translate
  onState: (state: MissionCommandState) => void
  now?: () => string
}) {
  const now = input.now ?? (() => new Date().toISOString())
  let state = emptyCommandState()
  let seq = 0
  const emit = (patch: Partial<MissionCommandState>) => {
    state = { ...state, ...patch }
    input.onState(state)
  }
  const keyOf = (mission: string, request: string) => `${mission}/${request}`

  /** Local lines and errors belong to one mission (§2: gone on the next mission switch). */
  const forMission = (mission: string) => {
    if (state.localMission === mission) return
    emit({ localMission: mission, local: [], decisionError: null, inputError: null })
  }

  const canAnswer = (mission: string, request: string) => !state.busy && !state.answered.includes(keyOf(mission, request))

  async function answer(mission: string, decision: MissionDecisionVM, optionId: string) {
    forMission(mission)
    const option = decision.options.find((opt) => opt.id === optionId)
    if (!option || !canAnswer(mission, decision.id)) return false
    const key = keyOf(mission, decision.id)
    emit({ busy: true, answered: [...state.answered, key], decisionError: null })
    const result = await input.writer
      .answer({ mission, request: decision.id, option: option.id })
      .catch((error): MissionControlResult<never> => ({ ok: false, code: "FAILED", message: errorText(error) }))
    if (!result.ok) {
      // Not recorded: the owner may choose again.
      emit({
        busy: false,
        answered: state.answered.filter((item) => item !== key),
        decisionError: input.t("session.mission.decision.failed", { reason: reasonOf(result) }),
      })
      return false
    }
    emit({ busy: false })
    input.refresh()
    const text = input.t("session.mission.prompt.answer", {
      request: decision.id,
      // Row 135 L1: ids only. The label is agent-written text; the agent reads the answer with studio_mission_get.
      option: option.id,
      decision: result.data.decision,
      mission,
    })
    // The store record stays when the prompt fails; the write is not retried (§2).
    await input
      .prompt(text)
      .catch((error) => emit({ decisionError: input.t("session.mission.input.failed", { reason: errorText(error) }) }))
    return true
  }

  async function instruct(mission: string, raw: string, fromDraft: boolean) {
    forMission(mission)
    if (state.busy) return false
    const check = checkInstruction(raw)
    if (!check.ok) {
      if (check.reason === "tooLong") emit({ inputError: input.t("session.mission.input.tooLong", { max: INSTRUCTION_MAX }) })
      return false
    }
    emit({ busy: true, inputError: null })
    const result = await input.writer
      .instruct({ mission, text: check.text })
      .catch((error): MissionControlResult<never> => ({ ok: false, code: "FAILED", message: errorText(error) }))
    if (!result.ok) {
      emit({ busy: false, inputError: input.t("session.mission.input.failed", { reason: reasonOf(result) }) })
      return false
    }
    emit(fromDraft ? { busy: false, draft: "" } : { busy: false })
    input.refresh()
    await input
      .prompt(input.t("session.mission.prompt.instruction", { mission, text: check.text }))
      .catch((error) => emit({ inputError: input.t("session.mission.input.failed", { reason: errorText(error) }) }))
    return true
  }

  return {
    get state() {
      return state
    },
    canAnswer,
    answer,
    setDraft(text: string) {
      const check = checkInstruction(text)
      const tooLong = !check.ok && check.reason === "tooLong"
      emit({ draft: text, inputError: tooLong ? input.t("session.mission.input.tooLong", { max: INSTRUCTION_MAX }) : null })
    },
    /** Send the input box text. */
    send: (mission: string) => instruct(mission, state.draft, true),
    /** "Prioritise unblock" chip: write 2 with the preset text. */
    unblock: (mission: string) => instruct(mission, input.t("session.mission.unblock.text"), false),
    /** "What's blocking?" chip: a local feed line, no call. */
    why(model: MissionVM) {
      forMission(model.id)
      emit({ local: [...state.local, whyLine(model, input.t, now(), ++seq)] })
    },
    feed: (model: MissionVM) => mergeFeed(model, state.localMission === model.id ? state.local : []),
    canSend: () => !state.busy && checkInstruction(state.draft).ok,
  }
}

export type CommandController = ReturnType<typeof createCommandController>
