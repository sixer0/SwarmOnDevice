import type { Part } from "@opencode-ai/sdk/v2"

// A shell command that exits non-zero still "completes" as far as the tool is concerned.
export function failedExit(metadata: unknown) {
  const exit = (metadata as { exit?: unknown } | undefined)?.exit
  return typeof exit === "number" && exit !== 0 ? exit : undefined
}

/** Why a call stopped at the permission gate never ran. It did not fail, so nothing should report it as a failure. */
export function notRun(metadata: unknown) {
  const reason = (metadata as { notRun?: unknown } | undefined)?.notRun
  return reason === "away" || reason === "declined" || reason === "deferred" ? reason : undefined
}

export function toolMark(part: Part | undefined): "running" | "failed" | "done" | undefined {
  if (part?.type !== "tool") return undefined
  const status = part.state.status
  if (status === "pending" || status === "running") return "running"
  if (status === "error") return notRun(part.state.metadata) ? "done" : "failed"
  return failedExit(part.state.metadata) === undefined ? "done" : "failed"
}
