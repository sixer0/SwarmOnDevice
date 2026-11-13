// 1.2.8 row 44c (AC-PROJd, AC-PROJe; 01d_spec_projects.md §2.2 and §6.5): the app follows a mission folder that
// the re-home primitive moved from the Default Project root into a group (sub-project). The server publishes
// `project.rehomed` (N8-131) on the global bus, so every window runs this once per event:
//   1. the group folder becomes its own entry in the project list (`projects.open(to)`, which dedups);
//   2. each moved session's persisted client state (Persist.session(from, id) keys, including the draft-store
//      `prompt` key, C39 OP20-8) is copied to Persist.session(to, id) and the old key removed only after the copy;
//      a key already present at `to` is kept (another window copied it first), so the step is idempotent;
//   3. an open route `/<dir>/session/<id>` of a moved session is replaced by the `to` directory (history replace).
// Workspace-level state of `from` stays: the root did not move. No new panel or view (keep the UI simple).
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Platform } from "@/context/platform"
import { decode64 } from "@/utils/base64"
import { canonicalPathKey } from "@/utils/path-key"
import { movePersisted, Persist } from "@/utils/persist"
import type { ServerScope } from "@/utils/server-scope"

export type ProjectRehomed = {
  missionId: string
  from: string
  to: string
  sessions: string[]
  journalId: string
}

// The per-session keys the app persists (prompt-state.ts, comments.tsx, file/view-cache.ts, layout.tsx).
export const REHOMED_SESSION_KEYS = ["prompt", "comments", "file-view", "terminal"] as const

export function projectRehomedPayload(event: { type: string; properties?: unknown }): ProjectRehomed | undefined {
  if (event.type !== "project.rehomed") return
  const value = event.properties
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (typeof input.from !== "string" || !input.from) return
  if (typeof input.to !== "string" || !input.to) return
  if (!Array.isArray(input.sessions)) return
  const sessions = input.sessions.filter((id): id is string => typeof id === "string" && id.length > 0)
  return {
    missionId: typeof input.missionId === "string" ? input.missionId : "",
    from: input.from,
    to: input.to,
    sessions,
    journalId: typeof input.journalId === "string" ? input.journalId : "",
  }
}

// The replacement path for an open `/<base64 dir>/session/<id>` route of a moved session, or undefined.
export function rehomedSessionPath(pathname: string, payload: ProjectRehomed): string | undefined {
  const parts = pathname.split("/")
  if (parts.length < 4 || parts[0] !== "" || parts[2] !== "session") return
  const dir = decode64(parts[1])
  const id = parts[3]
  if (!dir || !id || !payload.sessions.includes(id)) return
  if (canonicalPathKey(dir) !== canonicalPathKey(payload.from)) return
  return ["", base64Encode(payload.to), ...parts.slice(2)].join("/")
}

// Copies every per-session key of the moved sessions from `from` to `to`; returns how many keys moved and how
// many failed (a failed key keeps its old value: nothing is removed before its copy succeeded).
export async function moveRehomedSessionState(input: {
  payload: ProjectRehomed
  scope: ServerScope
  platform?: Platform
}): Promise<{ moved: number; failed: number }> {
  let moved = 0
  let failed = 0
  for (const session of input.payload.sessions) {
    for (const key of REHOMED_SESSION_KEYS) {
      const from = Persist.serverSession(input.scope, input.payload.from, session, key)
      const to = Persist.serverSession(input.scope, input.payload.to, session, key)
      const targets = key === "prompt" ? [Persist.prompt(from), Persist.prompt(to)] : [from, to]
      try {
        if (await movePersisted(targets[0], targets[1], input.platform)) moved++
      } catch {
        failed++
      }
    }
  }
  return { moved, failed }
}

export type RehomedListener = (payload: ProjectRehomed) => void

// The whole client step for one event. `projects.open` dedups and the key move skips existing keys, so a second
// window (or a replayed event) changes nothing.
export async function applyProjectRehomed(input: {
  event: { type: string; properties?: unknown }
  scope: ServerScope
  platform?: Platform
  projects: { open(directory: string): void }
  listeners?: Iterable<RehomedListener>
}) {
  const payload = projectRehomedPayload(input.event)
  if (!payload) return
  input.projects.open(payload.to)
  const result = await moveRehomedSessionState({ payload, scope: input.scope, platform: input.platform })
  for (const listener of input.listeners ?? []) listener(payload)
  return { payload, ...result }
}
