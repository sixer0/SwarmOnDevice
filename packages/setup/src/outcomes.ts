// Failure-outcome taxonomy (01c §8) and the exit-code convention frozen by gate
// row 79 (D-23, 10_preinstall_spec_review.md:153): keep `0`/`1` only, with the
// specific outcome carried as a machine-readable TOKEN in stdout and in the
// state file — NOT as a distinct numeric code. Row 108 asserts "each case exit
// code AND output", so both the number and the token are part of the contract.
//
//   exit 0 = success-or-skipped
//   exit 1 = every refusal / failure / network-blocked outcome
//
// BLOCKED_BY_NETWORK is distinguished by its token + state value (PC-ST-09),
// never by a second exit code (D-23 rationale: a second code class invites test drift).

export const EXIT_OK = 0
export const EXIT_FAIL = 1

/** Machine-readable outcome tokens. These are row-73 design labels for the §8
 *  outcome rows; they are not register constants and do not collide with the
 *  PC-ST-* state strings (only BLOCKED_BY_NETWORK intentionally equals PC-ST-09). */
export const OUTCOME = {
  OK: "OK",
  SKIPPED: "SKIPPED", // PC-ST-08
  SKIPPED_WITH_INSTRUCTIONS: "SKIPPED_WITH_INSTRUCTIONS", // P-3/P-4
  FAILED: "FAILED", // PC-ST-07
  HEALTH_FAILED: "HEALTH_FAILED", // component -> PC-ST-07, no MCP written
  BLOCKED_BY_NETWORK: "BLOCKED_BY_NETWORK", // PC-ST-09
  REFUSED_ROOT: "REFUSED_ROOT", // P-4
  REFUSED_PLATFORM: "REFUSED_PLATFORM", // P-20
  REFUSED_CONCURRENCY: "REFUSED_CONCURRENCY", // P-15 lock
  REFUSED_NON_INTERACTIVE: "REFUSED_NON_INTERACTIVE", // P-13 missing terms token
  REFUSED_NO_CONSENT: "REFUSED_NO_CONSENT", // consent gate FIRST (P-13 / decision 12)
  // Row 198 (fix contract §3.3): NOTHING was selected, so no consent was ever asked for. Deliberately
  // distinct from the two above — collapsing them would hide which gate fired. Refusal class => exit 1
  // through exitCodeFor's default arm, with no edit to the exit mapping.
  REFUSED_NO_SELECTION: "REFUSED_NO_SELECTION",
  REFUSED_LOCK_MALFORMED: "REFUSED_LOCK_MALFORMED", // fail-closed lock loader (P-1)
  // Row 92a (1.2.6, N-154..N-157): the four refusals of the start-only verb `swarm-setup start`.
  // Refusal class => exit 1 through exitCodeFor's default arm. The desktop reads them off the RESULT line.
  START_NOT_INSTALLED: "START_NOT_INSTALLED", // N-154
  START_UNKNOWN_COMPONENT: "START_UNKNOWN_COMPONENT", // N-155
  START_CONTAINERS_MISSING: "START_CONTAINERS_MISSING", // N-156
  RUNTIME_PROFILE_MISSING: "RUNTIME_PROFILE_MISSING", // N-157
} as const

export type OutcomeToken = (typeof OUTCOME)[keyof typeof OUTCOME]

/** Every refusal/failure/network outcome exits 1; only OK and the skip family exit 0. */
export function exitCodeFor(token: OutcomeToken): number {
  switch (token) {
    case OUTCOME.OK:
    case OUTCOME.SKIPPED:
    case OUTCOME.SKIPPED_WITH_INSTRUCTIONS:
      return EXIT_OK
    default:
      return EXIT_FAIL
  }
}

/** One-line human message per outcome (§8 requires a one-line refusal message). */
export function messageFor(token: OutcomeToken): string {
  switch (token) {
    case OUTCOME.OK:
      return "ok"
    case OUTCOME.SKIPPED:
      return "skipped"
    case OUTCOME.SKIPPED_WITH_INSTRUCTIONS:
      return "skipped: manual step required (see instructions above)"
    case OUTCOME.FAILED:
      return "failed"
    case OUTCOME.HEALTH_FAILED:
      return "health check failed; no MCP/config entries written"
    case OUTCOME.BLOCKED_BY_NETWORK:
      return "BLOCKED_BY_NETWORK: a required host is unreachable (host list printed once, no retry)"
    case OUTCOME.REFUSED_ROOT:
      return "refused: swarm-setup must not run as root"
    case OUTCOME.REFUSED_PLATFORM:
      return "refused: swarm-setup supports macOS arm64 only"
    case OUTCOME.REFUSED_CONCURRENCY:
      return "another swarm-setup is running"
    case OUTCOME.REFUSED_NON_INTERACTIVE:
      return "refused: --non-interactive requires an explicit --terms-token for every selected component"
    case OUTCOME.REFUSED_NO_CONSENT:
      return "refused: no component was consented to; nothing will be downloaded or installed"
    case OUTCOME.REFUSED_NO_SELECTION:
      // Row 198: the candidate ids are printed by the refusing site (they are policy-filtered there);
      // this line names the gate and the fix so a transcript alone is never ambiguous.
      return "refused: --non-interactive named no component; nothing was selected, consented, downloaded or written (name one or more of the candidate ids listed above)"
    case OUTCOME.REFUSED_LOCK_MALFORMED:
      return "refused: tools.lock.json failed validation (fail-closed)"
    case OUTCOME.START_NOT_INSTALLED:
      return "refused: start only starts a component recorded healthy; nothing was run (install it first)"
    case OUTCOME.START_UNKNOWN_COMPONENT:
      return "refused: start accepts only runtime, searxng or firecrawl"
    case OUTCOME.START_CONTAINERS_MISSING:
      return "refused: the stack has no containers to start; start never creates them (repair: swarm-setup apply <stack>)"
    case OUTCOME.RUNTIME_PROFILE_MISSING:
      return "refused: colima profile swarm does not exist; start never creates a VM (repair: swarm-setup install runtime)"
  }
}
