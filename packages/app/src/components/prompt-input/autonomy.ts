import { makeEventListener } from "@solid-primitives/event-listener"
import { debounce } from "@solid-primitives/scheduled"
import { createEffect, createMemo, createResource, onCleanup, type Accessor } from "solid-js"
import type { DirectorySDK } from "@/context/sdk"

/** The server sends no event when the mode changes, so whoever changes it away from the composer announces it here. */
export const AUTONOMY_CHANGED = "swarm:autonomy-changed"

// The session read goes through the whole audit file, so a burst of decisions reads it once.
const REFRESH_DELAY = 250

type Where = { client: Pick<DirectorySDK["client"], "autonomy">; sessionID: string | undefined }
type Known = { where: Where; on: boolean; open: number }

/** The composer's view of autonomous mode. The server holds the state; nothing here outlives a read of it. */
export function createPromptAutonomy(input: {
  sdk: Accessor<{ client: Pick<DirectorySDK["client"], "autonomy">; event: Pick<DirectorySDK["event"], "on"> }>
  sessionID: Accessor<string | undefined>
  onChanged: (on: boolean) => void
  onFailed: () => void
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
  })
  makeEventListener(window, AUTONOMY_CHANGED, () => refresh())
  makeEventListener(window, "focus", () => refresh())

  return {
    /** Undefined until the server has answered. */
    on: () => current()?.on,
    waiting: () => current()?.open ?? 0,
    toggle: async () => {
      const known = current()
      if (!known) return
      await known.where.client.autonomy
        .modeUpdate({ on: !known.on, sessionID: known.where.sessionID })
        .then((response) => input.onChanged(response.data?.on ?? !known.on), input.onFailed)
      // Also after a failure: stopping holds in memory even when saving failed, and only the server knows.
      await control.refetch()
    },
  }
}

async function read(where: Where) {
  if (!where.sessionID) {
    const folder = await where.client.autonomy.mode()
    return folder.data && { where, on: folder.data.on, open: 0 }
  }
  const session = await where.client.autonomy.session({ sessionID: where.sessionID })
  return session.data && { where, on: session.data.on, open: session.data.open }
}
