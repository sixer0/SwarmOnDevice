/**
 * Row 57 (1.2.6, S-02, register N-024): per-figure lock for `studio_figure_revise`.
 *
 * Subagents (planner, document-writer) may now call `studio_figure_revise` (row 56), so two agents can revise
 * the same figure at once and the later write silently undoes the earlier one. The host holds one lock per
 * `{documentId, pid}` while a `figure_revise` call is in flight; a second concurrent call on the same figure is
 * refused `FIGURE_LOCKED` (HTTP 409 semantics, no network call, nothing written). The lock is released when the
 * first call ends, whether it succeeded, returned an error envelope or threw. Different figures (another pid or
 * another document) run concurrently.
 *
 * The registry is process-wide (one per host process): every MCP session gets its own server (mcp-server.ts),
 * and the point of the lock is two sessions racing on one figure.
 *
 * Key: the figure's `pid`. A call that names the figure by `address` instead is keyed `address:<address>` (the
 * host cannot resolve the pid without a Studio call); a pid call and an address call on the same figure are
 * therefore not serialised against each other. Subagent guidance uses `pid`.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

export const FIGURE_LOCKED = "FIGURE_LOCKED"
export const FIGURE_LOCK_TOOL = "studio_figure_revise"

export interface FigureLockHolder {
  /** MCP session that holds the lock. */
  sessionId: string
  agentId: string
  since: number
}

export interface FigureLockKey {
  documentId: string
  /** `pid` value, or the `address` value when the call names the figure by address. */
  figure: string
  by: "pid" | "address"
}

export class FigureLockRegistry {
  private readonly held = new Map<string, FigureLockHolder>()

  private static id(k: FigureLockKey): string {
    return JSON.stringify([k.documentId, k.by, k.figure])
  }

  /** Take the lock; `null` when it is free and now held, else the current holder (nothing changed). */
  tryAcquire(k: FigureLockKey, holder: FigureLockHolder): FigureLockHolder | null {
    const id = FigureLockRegistry.id(k)
    const cur = this.held.get(id)
    if (cur) return cur
    this.held.set(id, holder)
    return null
  }

  release(k: FigureLockKey): void {
    this.held.delete(FigureLockRegistry.id(k))
  }

  /** Number of figures locked right now (tests, diagnostics). */
  size(): number {
    return this.held.size
  }
}

/** The host process's registry, shared by every MCP session server. */
export const FIGURE_LOCKS = new FigureLockRegistry()

/** The lock key of a figure_revise call, or null when the arguments name no figure (the tool refuses those itself). */
export function figureLockKey(args: Record<string, unknown>): FigureLockKey | null {
  const documentId = args.documentId
  if (typeof documentId !== "string" || documentId === "") return null
  if (typeof args.pid === "string" && args.pid !== "") return { documentId, figure: args.pid, by: "pid" }
  if (typeof args.address === "string" && args.address !== "") return { documentId, figure: args.address, by: "address" }
  return null
}

/** The refusal envelope (vendored refusal shape: structured `{ok:false, tool, code, error}`, not a genuine failure). */
export function figureLockedResult(k: FigureLockKey, callId: string): CallToolResult {
  const what = k.by === "pid" ? `pid ${k.figure}` : `address ${k.figure}`
  const message =
    `figur ${what} di dokumen ${k.documentId} sedang direvisi oleh panggilan studio_figure_revise lain yang masih berjalan; ` +
    `tidak ada yang dikirim (0 tulis). Tunggu panggilan itu selesai, baca ulang figurnya, lalu ulangi`
  const error = { code: FIGURE_LOCKED, message, httpStatus: 409, details: { documentId: k.documentId, [k.by]: k.figure }, correlationId: callId }
  return {
    content: [{ type: "text", text: `galat ${FIGURE_LOCKED}: ${message}\ncorrelationId: ${callId}` }],
    structuredContent: { ok: false, tool: FIGURE_LOCK_TOOL, code: FIGURE_LOCKED, error, mcpCallId: callId },
  }
}

/**
 * Run `run` under the figure's lock. A call that names no figure runs unlocked (the tool refuses it).
 * `onRefused` is called once when the lock is held by another call (for logging).
 */
export async function withFigureLock(
  registry: FigureLockRegistry,
  args: Record<string, unknown>,
  holder: FigureLockHolder,
  callId: () => string,
  run: () => Promise<CallToolResult>,
  onRefused?: (k: FigureLockKey, by: FigureLockHolder) => void,
): Promise<CallToolResult> {
  const k = figureLockKey(args)
  if (!k) return run()
  const cur = registry.tryAcquire(k, holder)
  if (cur) {
    onRefused?.(k, cur)
    return figureLockedResult(k, callId())
  }
  try {
    return await run()
  } finally {
    registry.release(k)
  }
}
