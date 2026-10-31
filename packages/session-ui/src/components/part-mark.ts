import type { Part } from "@opencode-ai/sdk/v2"

// A shell command that exits non-zero still "completes" as far as the tool is concerned.
export function failedExit(metadata: unknown) {
  const exit = (metadata as { exit?: unknown } | undefined)?.exit
  return typeof exit === "number" && exit !== 0 ? exit : undefined
}

export function toolMark(part: Part | undefined): "running" | "failed" | "done" | undefined {
  if (part?.type !== "tool") return undefined
  const status = part.state.status
  if (status === "pending" || status === "running") return "running"
  if (status === "error") return "failed"
  return failedExit(part.state.metadata) === undefined ? "done" : "failed"
}
