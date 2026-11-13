import { makeEventListener } from "@solid-primitives/event-listener"
import { debounce } from "@solid-primitives/scheduled"
import { createEffect, createMemo, createResource, onCleanup, type Accessor } from "solid-js"
import type { AutonomyModeUpdateData } from "@opencode-ai/sdk/v2/client"
import type { DirectorySDK } from "@/context/sdk"

/**
 * Whoever changes the mode in this window away from the composer announces it here, at once. A change from anywhere
 * else (the CLI, another window) arrives as the server's `autonomy.mode.changed` (1.2.7 row 58c).
 */
export const AUTONOMY_CHANGED = "swarm:autonomy-changed"

type ModeBody = NonNullable<AutonomyModeUpdateData["body"]>
export type ReportLanguage = NonNullable<ModeBody["reportLanguage"]>

/** The only consent the server accepts for the main agent to decide during a run (S0.1). */
export const BYPASS_CONSENT = "bypass-v1" satisfies NonNullable<ModeBody["bypassConsent"]>

/** Sent only with a turn-on the person agreed to in the consent dialog. */
export type AutonomousConsent = { bypassConsent: typeof BYPASS_CONSENT; reportLanguage: ReportLanguage }

/** The report's language from the app's: Indonesian for Indonesian, English for everything else. */
export const reportLanguageOf = (locale: string): ReportLanguage => (locale === "id" ? "id" : "en")

export const consentPayload = (language: ReportLanguage): AutonomousConsent => ({
  bypassConsent: BYPASS_CONSENT,
  reportLanguage: language,
})

/** What the server said. `bypass` is left out by a server that does not report it, which reads as bypassed. */
export type ModeView = { on: boolean; bypass?: boolean }

/** On, but approvals wait for the person again (after a server restart, say): the consent has to be given again. */
export const notBypassed = (mode: ModeView) => mode.on && mode.bypass === false

/**
 * What pressing the switch sends, from what the server last said. The switch flips: on turns off and never asks, also
 * while the mode is on but not bypassed (code review m19), so the person can always turn it off from where they are.
 * Turning on, or agreeing again (`agree`, from the not-bypassed hint or the palette's agree-again command), lets the
 * main agent decide every step: that needs the person's yes each time, and a no (or a dialog that could not open)
 * gives undefined, so nothing is sent. Without `confirm` (1.1.0) the switch only flips and carries no consent, and
 * there is nothing to agree to.
 */
export async function nextMode(
  mode: ModeView,
  ask?: { confirm: () => Promise<boolean>; language: () => ReportLanguage },
  intent: "flip" | "agree" = "flip",
): Promise<{ on: boolean; consent?: AutonomousConsent } | undefined> {
  if (!ask) return intent === "flip" ? { on: !mode.on } : undefined
  if (intent === "flip" && mode.on) return { on: false }
  if (!(await ask.confirm().catch(() => false))) return undefined
  return { on: true, consent: consentPayload(ask.language()) }
}

// The session read goes through the whole audit file, so a burst of decisions reads it once.
const REFRESH_DELAY = 250

type Where = { client: Pick<DirectorySDK["client"], "autonomy">; sessionID: string | undefined }
type Known = { where: Where; on: boolean; bypass?: boolean; open: number }

/** The composer's view of autonomous mode. The server holds the state; nothing here outlives a read of it. */
export function createPromptAutonomy(input: {
  sdk: Accessor<{ client: Pick<DirectorySDK["client"], "autonomy">; event: Pick<DirectorySDK["event"], "on"> }>
  sessionID: Accessor<string | undefined>
  onChanged: (on: boolean) => void
  onFailed: () => void
  /** Asked before turning on, never before turning off. False sends nothing. */
  confirm: () => Promise<boolean>
  /** The language of the report the person gets when the mode goes off again. */
  language: () => ReportLanguage
}) {
  const where = createMemo<Where>(() => ({ client: input.sdk().client, sessionID: input.sessionID() }))
  const [state, control] = createResource<Known | undefined, Where>(where, (source, info) =>
    // A failed refresh keeps what was known: a marker that vanishes would say the mode is off.
    read(source).catch(() => (info.refetching ? info.value : undefined)),
  )
  // `latest` still holds the previous session while the next one loads, and suspends before the first answer.
  const current = () => {
    if (state.state !== "ready" && state.state !== "refreshing") return undefined
    const value = state.latest
    return value?.where === where() ? value : undefined
  }

  const refresh = debounce(() => void control.refetch(), REFRESH_DELAY)
  onCleanup(refresh.clear)
  const queueMoved = () => {
    if (where().sessionID && current()?.on) refresh()
  }
  createEffect(() => {
    const event = input.sdk().event
    onCleanup(
      event.on("permission.asked", (asked) => {
        if (asked.properties.deferred) queueMoved()
      }),
    )
    onCleanup(event.on("permission.replied", queueMoved))
    onCleanup(event.on("autonomy.blocked", queueMoved))
    // Any scope, on or off: a folder change can decide this session's mode, and the read says which answer holds.
    onCleanup(event.on("autonomy.mode.changed", () => refresh()))
  })
  makeEventListener(window, AUTONOMY_CHANGED, () => refresh())
  makeEventListener(window, "focus", () => refresh())

  return {
    /** Undefined until the server has answered. */
    on: () => current()?.on,
    /** On, but the consent is gone: the hint asks for it again; the switch still turns the mode off. */
    notBypassed: () => {
      const known = current()
      return !!known && notBypassed(known)
    },
    waiting: () => current()?.open ?? 0,
    /** The switch: on turns off without asking, off asks before turning on. */
    toggle: () => send("flip"),
    /** The not-bypassed hint: asks again and, on a yes, sends on with the consent. Only while not bypassed. */
    agree: async () => {
      if (!current() || !notBypassed(current()!)) return
      await send("agree")
    },
  }

  async function send(intent: "flip" | "agree") {
    const known = current()
    if (!known) return
    if (!(await flipMode(known, input, intent))) return
    // Also after a failure: stopping holds in memory even when saving failed, and only the server knows.
    await control.refetch()
  }
}

/** Sends what pressing the switch means (see `nextMode`). Returns false when the person said no and nothing was sent. */
export async function flipMode(
  known: Pick<Known, "where" | "on" | "bypass">,
  input: {
    confirm: () => Promise<boolean>
    language: () => ReportLanguage
    onChanged: (on: boolean) => void
    onFailed: () => void
  },
  intent: "flip" | "agree" = "flip",
) {
  const next = await nextMode(known, input, intent)
  if (!next) return false
  await known.where.client.autonomy
    .modeUpdate({ on: next.on, sessionID: known.where.sessionID, ...next.consent })
    .then((response) => input.onChanged(response.data?.on ?? next.on), input.onFailed)
  return true
}

// The session's answer carries `bypass` from a server that reports it (AutonomySession); older ones leave it out.
const bypassOf = (data: ModeView) => data.bypass

async function read(where: Where): Promise<Known | undefined> {
  if (!where.sessionID) {
    const folder = await where.client.autonomy.mode()
    return folder.data && { where, on: folder.data.on, bypass: folder.data.bypass, open: 0 }
  }
  const session = await where.client.autonomy.session({ sessionID: where.sessionID })
  return session.data && { where, on: session.data.on, bypass: bypassOf(session.data), open: session.data.open }
}
