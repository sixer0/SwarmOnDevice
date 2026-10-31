import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export type LandedWork = { headline: string; update: string; at: number; dismissed?: boolean }

const KEEP = 200

/** What was committed from which session. The commit outlives the panel, so what the app says about it has to as well. */
export function createLandedWork() {
  const [store, setStore] = persisted(
    Persist.global("landed-work"),
    createStore({ sessions: {} as Record<string, LandedWork | undefined> }),
  )
  return {
    get: (sessionID: string | undefined) => (sessionID ? store.sessions[sessionID] : undefined),
    record: (sessionID: string, work: LandedWork) =>
      setStore("sessions", (sessions) =>
        Object.fromEntries(
          [...Object.entries(sessions), [sessionID, work] as const]
            .toSorted((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0))
            .slice(-KEEP),
        ),
      ),
    dismiss: (sessionID: string) => setStore("sessions", sessionID, "dismissed", true),
  }
}
