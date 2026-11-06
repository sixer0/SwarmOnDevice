import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { spendLimitDetail } from "@/components/session/session-spend"

/**
 * Whether a prompt offers the "always" button. One rule for the session dock, the Home board and the swarm view, so
 * they cannot drift. Every "always" a person gives is remembered for this session only, so the button is offered on
 * every prompt a person answers directly, also when the tool named no rule (`always` empty): the session then remembers
 * that exact prompt. Not offered on a moved-on prompt (it waits behind autonomous mode and is answered with Allow
 * only), on a held one, or on the spend limit, whose prompt keeps only Stop and Continue.
 */
export function offersAlways(request: Pick<PermissionRequest, "permission" | "metadata" | "movedOnAt" | "deferred">) {
  if (request.movedOnAt || request.deferred) return false
  return !spendLimitDetail(request)
}

/**
 * What the "always" button says. The answer reaches this session only, so the button says that. The prompt about a
 * call made over and over keeps its own words: a yes only ends that question and allows no call of the tool.
 */
export function alwaysLabel(
  request: { permission: string },
  t: (key: "session.movedOn.alwaysInSession" | "session.permission.alwaysRepeats") => string,
) {
  if (request.permission === "doom_loop") return t("session.permission.alwaysRepeats")
  return t("session.movedOn.alwaysInSession")
}
