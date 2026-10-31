// People start a long task and walk away. An agent that stops at a prompt then does nothing until they come back, so a
// run started before lunch can be sitting at minute three. After this long without an answer the agent is released: the
// call does not run, it carries on with whatever else it can, and the request stays open for the user. Going without
// is the safe direction, since nothing runs that a person did not allow.

const FIRST_WAIT = 10 * 60 * 1000
// Once one request went unanswered nobody is there. Waiting the full time again would turn a night into a few prompts.
const NEXT_WAIT = 60 * 1000

/** How long to wait for a person, or undefined to wait for good. SWARM_UNATTENDED_AFTER_MS=0 turns moving on off. */
export function wait(alreadyAway: boolean) {
  const raw = process.env.SWARM_UNATTENDED_AFTER_MS
  const first = raw === undefined || raw === "" ? FIRST_WAIT : Number(raw)
  if (!Number.isFinite(first) || first <= 0) return
  return alreadyAway ? Math.min(first, NEXT_WAIT) : first
}

export * as Unattended from "./unattended"
