// F-79-A policy-gate HOOK POINT — enforcement side only (row 83's half per register PC-PATH-16:
// "Path constant only — the mechanism is row 73's, enforcement row 83's, test row 109's, doc row 124's").
//
// Controller ruling (decisions/decisions.md, 2026-10-20): F-79-A is DEFERRED from v1 — the admin
// switch itself does not exist in v1 and no distribution mechanism, managed-location variant, or MDM
// tooling is built here. The path DOES exist in the register (PC-PATH-16, added by row 72 for exactly
// this), so this module implements ONLY the documented hook: if an operator has placed
// ~/.swarm/setup/policy.json naming forbidden component ids, those components never reach the consent
// screen and refuse even with a token (gate finding F-79-A, 10_preinstall_spec_review.md). If the file
// is absent — the v1 default state — nothing is forbidden and behaviour is unchanged.
//
// Fail-closed rule: a policy file that EXISTS but cannot be parsed or names an unknown component id
// refuses the run. A typo in an admin control must never silently become a no-op — that would let a
// broken file disable the control, which is worse than no file at all.

import { existsSync, readFileSync } from "node:fs"
import { isComponentId, PATHS, type ComponentId } from "./constants.ts"
import { expandTilde } from "./paths.ts"

/** PC-PATH-16 resolved through row 81's tilde expansion (paths.ts untouched). */
export const policyFile = (): string => expandTilde(PATHS.POLICY) // ~/.swarm/setup/policy.json

export interface PolicyRead {
  readonly forbidden: readonly ComponentId[]
}

export type PolicyResult = { ok: true; policy: PolicyRead } | { ok: false; error: string }

/** Read + validate the optional fleet policy. Absent file = no restrictions (ok, forbidden: []). */
export function readPolicy(): PolicyResult {
  const path = policyFile()
  if (!existsSync(path)) return { ok: true, policy: { forbidden: [] } }

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
  const forbidden = (parsed as Record<string, unknown>).forbidden
  if (!Array.isArray(forbidden)) {
    return { ok: false, error: `${path} must carry a "forbidden" array of component ids (F-79-A hook shape)` }
  }
  const ids: ComponentId[] = []
  for (const entry of forbidden) {
    if (typeof entry !== "string" || !isComponentId(entry)) {
      // Unknown id in an admin control: fail CLOSED (see header) rather than ignore.
      return {
        ok: false,
        error: `${path} lists "${String(entry)}" which is not a register component id (PC-CMP-01..07) — refusing to treat a broken admin control as absent`,
      }
    }
    ids.push(entry)
  }
  return { ok: true, policy: { forbidden: ids } }
}
