// RTK integration wrapper (row 97, task a; contract = masterplan/01f_tool_wiring_spec.md §8).
//
// 01f §8 ships RTK as an EXPLICIT, model-visible tool the agent prefixes by choice — NOT a silent
// command-rewriting hook (§8.1's permission blind spot: a rewrite moves the text the permission
// engine sees, and `rtk cat .env` would reach a secret through the `bash` permission while the
// `.env` ask lives on `read`). So this module builds NO rewriting surface. It exposes ARGV BUILDERS
// ONLY against the private binary resolved by r89/r94 (absolute path, never PATH-resolved), plus a
// poka-yoke guard so the forbidden shapes stay structurally unreachable from setup code.
//
// Hard rules honoured here:
//   - absolute binary, no PATH consult (r89 resolver contract; decision 7 posture);
//   - NO `rtk init` (P-11/B3/Q4/G6 — it writes OpenCode's config location);
//   - NO `rtk config recall` — the tracking-retention control is OFF-LIMITS until row 98's product
//     decision (r89 §6 G-5: running it WRITES user config and `disabled` also removes `rtk recall`
//     recovery, which 01f §8 piece 2 documents as a user-visible affordance);
//   - NO `rtk telemetry enable` (lock never_run; upstream default is already off — 02b §2);
//   - NO config file written anywhere by this module (no-init ruling; the store stays the fixed
//     ~/Library/Application Support/rtk/ that P-16/D-08 already whitelist as "created by RTK").
//
// Telemetry posture is RECORDED here (facts only) so rows 98/113 cite one source instead of
// re-deriving it: DO_NOT_TRACK=1 is the child-env knob, telemetry is opt-in and off by default, and
// the retention/recall knobs are deliberately untouched until row 98 decides.

import { rtkToolPath } from "../mcpproxy/wiring.ts"
import type { RtkBinResult } from "../steps/rtk/index.ts"
import type { LockFile } from "../lockfile.ts"

/** First-argument verbs that must NEVER appear in an argv this module builds. `init` and
 *  `telemetry` come from the reviewed lock's never_run array; `config` covers the deferred
 *  `config recall` retention control (OFF-LIMITS until row 98) and any other config mutation. */
const FORBIDDEN_VERBS: ReadonlySet<string> = new Set(["init", "telemetry", "config"])

/** Shell metacharacters: an explicit skill invocation must be a single filtered command, never a
 *  pipeline/redirection that re-opens the §8.1 blind spot or smuggles a second command past the guard. */
const SHELL_METACHARS = /[|;&$<>`]/

/** Path fragments whose contents the `read`/.env ask protects; an rtk filter must not reach them. */
const SECRET_PATH_TOKENS = [".env", ".aws/credentials", ".npmrc", ".netrc", "id_rsa", "id_ed25519"]

export interface RtkArgvCheck {
  readonly ok: boolean
  readonly reason?: string
}

/** The ONE sanctioned setup-side probe argv (mirrors r89 allowedProbeArgv exactly). */
export function rtkProbeArgv(binPath: string): readonly string[] {
  return [binPath, "--version"]
}

/**
 * Guard every argv this wrapper hands to a spawn site. Rejects, fail-closed:
 *   - a relative / PATH-resolvable argv[0] (must be the absolute private binary),
 *   - a forbidden verb family in the subcommand position (init / telemetry / config*),
 *   - any argument carrying a shell metacharacter (pipeline / redirection / command substitution),
 *   - any argument naming a protected secret path token (the `rtk cat .env` bypass from §8.1).
 */
export function assertRtkArgvSafe(argv: readonly string[]): RtkArgvCheck {
  const bin = argv[0]
  if (typeof bin !== "string" || bin === "")
    return { ok: false, reason: "argv[0] (the rtk binary) must be a non-empty string" }
  if (!bin.startsWith("/"))
    return { ok: false, reason: `rtk must be invoked by ABSOLUTE path, got "${bin}" (never PATH-resolved)` }

  const sub = argv[1]
  if (typeof sub === "string" && FORBIDDEN_VERBS.has(sub)) {
    return {
      ok: false,
      reason: `rtk subcommand "${sub}" is forbidden from setup code (P-11/B3; config-recall deferred to row 98)`,
    }
  }

  for (const arg of argv.slice(1)) {
    if (typeof arg !== "string") continue
    if (SHELL_METACHARS.test(arg))
      return {
        ok: false,
        reason: `argument "${arg}" carries a shell metacharacter; Swarm does not build rewriting/pipeline argv (01f §8.1)`,
      }
    const lower = arg.toLowerCase()
    const hit = SECRET_PATH_TOKENS.find((t) => lower.includes(t))
    if (hit)
      return {
        ok: false,
        reason: `argument "${arg}" reaches a protected secret path ("${hit}") through the bash permission (01f §8.1); refused`,
      }
  }
  return { ok: true }
}

/**
 * Build an EXPLICIT skill-invocation argv (row 98's skill text tells the model when to prefix rtk;
 * this is the guarded builder it references). It composes `[bin, ...filterArgv]` ONLY after the
 * safety guard passes — it never rewrites an existing command and never touches the forbidden verbs.
 */
export function buildRtkSkillArgv(
  binPath: string,
  filterArgv: readonly string[],
): { ok: true; argv: readonly string[] } | { ok: false; reason: string } {
  const candidate = [binPath, ...filterArgv]
  const check = assertRtkArgvSafe(candidate)
  if (!check.ok) return { ok: false, reason: check.reason ?? "rejected by the rtk argv guard" }
  return { ok: true, argv: candidate }
}

/** Resolve the private rtk by absolute path via r94's thin hook over r89's tamper-aware resolver.
 *  Facts only — this never spawns and never writes config. */
export function resolveRtk(options: { lock?: LockFile; version?: string; installRoot?: string } = {}): RtkBinResult {
  return rtkToolPath(options)
}

export interface RtkTelemetryPosture {
  readonly childEnvKnob: "DO_NOT_TRACK=1"
  readonly telemetryDefault: "off"
  readonly telemetryEnableForbidden: true
  readonly recallControlDeferredToRow: 98
  readonly initForbidden: true
  readonly configWrittenBySetup: false
  readonly storeLocation: "~/Library/Application Support/rtk/"
  readonly neverRun: readonly string[]
}

/**
 * The recorded telemetry/retention posture (facts, not actions). `neverRun` is read FROM THE LOCK
 * when supplied so the guard's deny list and the shipped artifact stay one source of truth; absent a
 * lock it falls back to the two commands r89 froze. Nothing here enables anything or writes config.
 */
export function rtkTelemetryPosture(lock?: LockFile): RtkTelemetryPosture {
  const neverRun = readNeverRun(lock) ?? ["rtk init", "rtk telemetry enable"]
  return {
    childEnvKnob: "DO_NOT_TRACK=1",
    telemetryDefault: "off",
    telemetryEnableForbidden: true,
    recallControlDeferredToRow: 98,
    initForbidden: true,
    configWrittenBySetup: false,
    storeLocation: "~/Library/Application Support/rtk/",
    neverRun,
  }
}

function readNeverRun(lock?: LockFile): readonly string[] | undefined {
  const pin = lock?.components?.rtk
  const nr = pin && typeof pin === "object" ? (pin as Record<string, unknown>).never_run : undefined
  if (Array.isArray(nr) && nr.every((x) => typeof x === "string")) return nr as readonly string[]
  return undefined
}
