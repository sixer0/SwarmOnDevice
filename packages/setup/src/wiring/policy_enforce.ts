// F-79-A policy.json ENFORCEMENT completion (row 97, task c), strictly inside the DEFERRED boundary.
//
// What r83 shipped (src/policy.ts, untouched here): the READ path + the enforcement half — read the
// optional fleet policy BEFORE consent, drop forbidden components so they never reach the screen,
// refuse even with a token, and fail closed on a malformed file or an unknown component id.
//
// What THIS module adds, still within that same deferred scope (decisions/decisions.md 2026-10-20:
// F-79-A stays a documented gap; NO admin switch, NO distribution mechanism, NO managed-location
// variant, NO MDM tooling is built here):
//   1. STRICT schema validation — r83 accepts `{forbidden:[...]}` and IGNORES any other top-level
//      key. An admin control whose extra/typo'd key is silently dropped is worse than no file: a
//      misspelled `forbiden` would read as "no restrictions". So this validator REJECTS unknown
//      top-level keys fail-closed. That rejection POLICY DECISION is the item row 97 owns; it is
//      recorded in implementation/s97_wiring_policy.md and routed to the register owner (the only
//      place new admin fields may be added — 01c0:23-24).
//   2. AUDIT HOOK when the policy is ACTIVE — every run that consults a present-and-valid policy
//      writes one `policy_active` line to the unified audit chain (audit_chain.ts), recording the
//      resolved path and the forbidden component IDS only (never secrets, never note bodies). An
//      absent file (today's v1 default) is inactive and writes nothing.
//
// It does NOT edit policy.ts or index.ts. index.ts still calls r83's lenient readPolicy(); switching
// that one call site to enforcePolicy() is the routed seam (see artifact §seam) so this row never
// races r81/r83's files while other E4 drivers are live.

import { existsSync, readFileSync } from "node:fs"
import { isComponentId, PATHS, type ComponentId } from "../constants.ts"
import { expandTilde } from "../paths.ts"
import { appendChainEvent, type ChainOptions } from "./audit_chain.ts"

/** The ONLY top-level key the F-79-A hook shape defines (r83 header: "forbidden array of component
 *  ids"). Anything else is rejected fail-closed until the register adds it. */
const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["forbidden"])

export interface PolicyEnforceResult {
  readonly ok: true
  readonly forbidden: readonly ComponentId[]
  /** True iff a policy file was PRESENT and validated (whether or not it forbids anything). */
  readonly active: boolean
  /** The audit-chain line written when active; null when the file was absent. */
  readonly auditLine: string | null
}

export type PolicyEnforceOutcome = PolicyEnforceResult | { ok: false; error: string }

export interface PolicyEnforceOptions {
  /** Override the policy path (tests point at a throwaway HOME or file). Default PC-PATH-16. */
  readonly path?: string
  /** Where to append the active-audit line. Default = the unified chain path. */
  readonly chain?: ChainOptions
  /** Per-run trace id carried on the audit line. */
  readonly correlationId?: string
  /** Injectable clock for deterministic audit timestamps. */
  readonly now?: () => string
}

/** Resolve PC-PATH-16 through row 81's tilde expansion (paths.ts untouched). */
export const policyPath = (): string => expandTilde(PATHS.POLICY)

/**
 * Strictly validate + enforce the optional fleet policy and record its activation. Fail-closed on
 * every defect (unreadable, invalid JSON, non-object, unknown top-level key, missing/non-array
 * `forbidden`, or an entry that is not a register component id). Absent file = inactive, no error.
 */
export function enforcePolicy(opts: PolicyEnforceOptions = {}): PolicyEnforceOutcome {
  const path = opts.path ?? policyPath()
  if (!existsSync(path)) {
    return { ok: true, forbidden: [], active: false, auditLine: null }
  }

  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return { ok: false, error: `cannot read ${path}: ${(err as Error).message}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `${path} is not valid JSON: ${(err as Error).message}` }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `${path} top level is not a JSON object` }
  }

  const obj = parsed as Record<string, unknown>
  const unknownKeys = Object.keys(obj).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k))
  if (unknownKeys.length > 0) {
    // Fail-closed: a typo'd or unregistered admin key must never read as "no restriction".
    return {
      ok: false,
      error: `${path} carries unknown top-level key(s) ${unknownKeys.join(", ")}; only "forbidden" is defined for the F-79-A hook — refusing to treat an unrecognised admin control as absent (add it to the register first)`,
    }
  }

  const forbidden = obj.forbidden
  if (!Array.isArray(forbidden)) {
    return { ok: false, error: `${path} must carry a "forbidden" array of component ids (F-79-A hook shape)` }
  }

  const ids: ComponentId[] = []
  for (const entry of forbidden) {
    if (typeof entry !== "string" || !isComponentId(entry)) {
      return {
        ok: false,
        error: `${path} lists "${String(entry)}" which is not a register component id (PC-CMP-01..07) — refusing to treat a broken admin control as absent`,
      }
    }
    ids.push(entry)
  }

  const line = appendChainEvent(
    {
      ts: opts.now?.() ?? new Date().toISOString(),
      kind: "policy_active",
      source: "swarm-setup.wiring.policy_enforce",
      decision: "active",
      policyPath: path,
      forbidden: ids,
      count: ids.length,
      ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
    },
    opts.chain ?? {},
  )

  return { ok: true, forbidden: ids, active: true, auditLine: line }
}
