// Rows 112 (SB-2) and 105 (MC-6 item 2): facts that change during a session, kept out of the cached prefix.
//
// A provider's prefix cache serves a request only up to its first byte that differs from an earlier request. The system
// prompt comes first, so a date that rolls over or an MCP server that connects used to rewrite byte ~12 000 of every
// later request (row 111, implementation/111_sb2_request_diff.md). Those facts now travel in one synthetic text part
// on the newest person message, saved with it, so later requests repeat it byte for byte. A fact is written again
// only when it changes, which appends to the conversation instead of rewriting its start. The same part carries the
// turn's context fact line (register section 10), computed once per turn from the numbers the overflow check uses.
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { count, priceTarget, usable } from "./overflow"

export const TAG = "turn_facts"
/** The part metadata key that marks the block and records which facts it stated (`null`: stated as gone). */
export const METADATA_KEY = "turnFacts"

/** The facts that may change during a session, in the order they are written. `undefined`: nothing applies now. */
/** @internal test seam */
export interface Volatile {
  /** `new Date().toDateString()` */
  date: string
  /** routing lines that depend on a connected MCP server (the researcher line, spec 161 F3) */
  routing?: string
  /** `<installed_tools>` block (system.ts installedTools), filtered by the MCP servers connected now */
  tools?: string
  /** `<mcp_instructions>` block (system.ts mcp) */
  mcp?: string
}
export type Key = keyof Volatile
/** @internal test seam */
export type Emitted = Partial<Record<Key, string | null>>

const ORDER: readonly Key[] = ["date", "routing", "tools", "mcp"]

const GONE: Record<Exclude<Key, "date">, string> = {
  routing: "<agent_routing_update>\n- researcher: not available now.\n</agent_routing_update>",
  tools: "<installed_tools>\n  none now\n</installed_tools>",
  mcp: "<mcp_instructions>\n  none now\n</mcp_instructions>",
}

const write = (key: Key, value: string) => {
  if (key === "date") return `Today's date: ${value}`
  if (key === "routing") return `<agent_routing_update>\n${value}\n</agent_routing_update>`
  return value
}

interface ContextFacts {
  used: number
  limit: number
  /** undefined: auto compaction is off, or no threshold applies */
  threshold: number | undefined
}

/** The turn's numbers, from the functions the loop's overflow and price-target checks call with the same inputs. */
export function context(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  /** tokens of the last finished, non-summary step; absent: none yet (the check does not run either) */
  tokens?: SessionV1.Assistant["tokens"]
  outputTokenMax?: number
  /** the loop stopped using the price target for this run (prompt.ts `priceTargetOff`) */
  priceTargetOff?: boolean
}): ContextFacts {
  const used = input.tokens ? count(input.tokens) : 0
  const limit = input.model.limit.context
  if (input.cfg.compaction?.auto === false) return { used, limit, threshold: undefined }
  const window = limit > 0 ? usable(input) : undefined
  const target = input.priceTargetOff ? undefined : priceTarget(input)
  const candidates = [window, target].filter((value): value is number => value !== undefined && value > 0)
  return { used, limit, threshold: candidates.length === 0 ? undefined : Math.min(...candidates) }
}

/** Register section 10: `Context: {{used}} of {{limit}} tokens used; compaction at {{threshold}}.` */
export function contextLine(facts: ContextFacts) {
  return `Context: ${facts.used} of ${facts.limit} tokens used; compaction at ${facts.threshold ?? "off"}.`
}

const emittedOf = (part: SessionV1.Part): Emitted | undefined => {
  if (part.type !== "text" || part.synthetic !== true) return
  const value = part.metadata?.[METADATA_KEY]
  return value && typeof value === "object" ? (value as Emitted) : undefined
}

/** True when this person message already carries its block: one per turn, never a second. */
export function has(message: SessionV1.WithParts) {
  return message.parts.some((part) => emittedOf(part) !== undefined)
}

/** The latest stated value of each fact across the messages the model still sees (after compaction filtering). */
export function seen(messages: readonly SessionV1.WithParts[]): Emitted {
  const out: Emitted = {}
  for (const message of messages) {
    if (message.info.role !== "user") continue
    for (const part of message.parts) Object.assign(out, emittedOf(part) ?? {})
  }
  return out
}

/** The block for this turn: every fact whose value differs from what is in view, then the fact line. */
export function render(input: { seen: Emitted; now: Volatile; line: string }) {
  const emitted: Emitted = {}
  const lines: string[] = []
  for (const key of ORDER) {
    const value = input.now[key]
    const before = input.seen[key]
    if (value === undefined) {
      // Never stated, or already stated as gone: nothing to say. Stated before and gone now: say so.
      if (before === undefined || before === null || key === "date") continue
      emitted[key] = null
      lines.push(GONE[key])
      continue
    }
    if (before === value) continue
    emitted[key] = value
    lines.push(write(key, value))
  }
  return { text: [`<${TAG}>`, ...lines, input.line, `</${TAG}>`].join("\n"), emitted }
}

export * as TurnFacts from "./turn-facts"
