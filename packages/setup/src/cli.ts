// Command-surface parsing for the frozen verbs and flags (register class 12:
// PC-CMD-01 install / PC-CMD-02 status / PC-CMD-03 remove (+ --remove alias),
// PC-FLAG-01 --non-interactive / PC-FLAG-02 --terms-token <component>=<value> /
// PC-FLAG-03 --dry-run). The verbs were frozen by row 72 after gate R-3 ratified
// row 73's proposal (01c §3, 01c0 §12). There is deliberately NO update/upgrade verb.
//
// Row 199 (session 6) adds a FOURTH verb, `wire`, kept off the critical path by
// masterplan/03_s6_fix_contract.md §4.1. It is recognised HERE and deliberately NOT added to the
// VERBS constant in constants.ts: that object is the verbatim copy of the FROZEN §12 table (its own
// header says "Register constants used VERBATIM … No value here is redefined"), and the frozen rows
// stay untouched even after amendment (§21.1 idiom: "frozen row left in place"). The register
// amendment landed as §21.4 R-3 (2026-10-22, row 246b): wire is PC-CMD-04, apply is PC-CMD-05, both
// as dated rulings outside the frozen table — which is why the two verbs live in the parse surface,
// beside WIRE_VERB/APPLY_VERB below, and not in VERBS.

import { VERBS, FLAGS, isComponentId, type ComponentId } from "./constants.ts"

/** Row 199: re-wire config entries for components already recorded healthy. Not a register constant. */
export const WIRE_VERB = "wire"

/** Row 246 (blueprint 11): re-render and recreate ONE stack from the stored lane tuple plus a fresh
 *  DNS-pin produce. Registered as PC-CMD-05 by the dated ruling at
 *  `01c0_preinstall_register.md` §21.4 (R-3, 2026-10-22); like `wire` it stays in the parse surface
 *  because constants.ts mirrors the frozen §12 table verbatim and the frozen rows were left in
 *  place. It takes exactly one stack name; the refusal for anything else lives in estate/apply.ts,
 *  not here. */
export const APPLY_VERB = "apply"

/** Row 92a (1.2.6, OFF-04, register N-153): start ONE already-installed component that is merely
 *  stopped — `runtime` (the colima VM), `searxng` or `firecrawl` (their existing containers). It is
 *  the start-only twin of `apply`: colima start without sizing flags and `compose start`, never `up`,
 *  `create`, `pull` or `--force-recreate`; no state transition, no tools.lock.json write, no consent
 *  token. The id set and refusals live in estate/start.ts; like wire/apply it stays out of VERBS. */
export const START_VERB = "start"

/** Row 221b (G-U14 Q2): `--consent-mode app` says the desktop app collected the ticks, so consent.log
 *  records `mode: app` instead of `mode: non-interactive`. It is NOT an acceptance channel: it is
 *  valid only on `install --non-interactive` with at least one --terms-token, and the token gate in
 *  consent.ts still decides every grant. It changes the recorded mode only, never the selection. */
export const CONSENT_MODE_FLAG = "--consent-mode"
export const CONSENT_MODE_APP = "app"

export type Verb = "install" | "status" | "remove" | "wire" | "apply" | "start" | "help"

export interface ParsedCommand {
  verb: Verb
  /** Explicitly named components (empty = caller decides: install presents all seven). */
  components: ComponentId[]
  nonInteractive: boolean
  dryRun: boolean
  tokens: Partial<Record<ComponentId, string>>
  /** Row 221b: true only for a validated `--consent-mode app` (see CONSENT_MODE_FLAG). */
  appConsent: boolean
}

export type ParseResult = { ok: true; cmd: ParsedCommand } | { ok: false; error: string }

export function parseArgs(argv: readonly string[]): ParseResult {
  let verb: Verb | undefined
  const components: ComponentId[] = []
  const seen = new Set<ComponentId>()
  const tokens: Partial<Record<ComponentId, string>> = {}
  let nonInteractive = false
  let dryRun = false
  let help = false
  let appConsent = false

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] as string

    if (t === FLAGS.HELP || t === "-h") {
      help = true
      continue
    }
    if (t === FLAGS.NON_INTERACTIVE) {
      nonInteractive = true
      continue
    }
    if (t === FLAGS.DRY_RUN) {
      dryRun = true
      continue
    }
    if (t === FLAGS.REMOVE_ALIAS) {
      if (verb === undefined) verb = VERBS.REMOVE
      continue
    }
    if (t === FLAGS.TERMS_TOKEN) {
      const val = argv[++i]
      const r = absorbToken(val, tokens)
      if (!r.ok) return r
      continue
    }
    if (t.startsWith(FLAGS.TERMS_TOKEN + "=")) {
      const r = absorbToken(t.slice(FLAGS.TERMS_TOKEN.length + 1), tokens)
      if (!r.ok) return r
      continue
    }
    if (t === CONSENT_MODE_FLAG || t.startsWith(CONSENT_MODE_FLAG + "=")) {
      const val = t === CONSENT_MODE_FLAG ? argv[++i] : t.slice(CONSENT_MODE_FLAG.length + 1)
      if (val !== CONSENT_MODE_APP) return { ok: false, error: `${CONSENT_MODE_FLAG} accepts only "${CONSENT_MODE_APP}"` }
      appConsent = true
      continue
    }
    if (t.startsWith("-") && t.length > 1) {
      return { ok: false, error: `unknown flag: ${t}` }
    }

    // Positional token: either the verb or a component id.
    if (
      verb === undefined &&
      (t === VERBS.INSTALL ||
        t === VERBS.STATUS ||
        t === VERBS.REMOVE ||
        t === WIRE_VERB ||
        t === APPLY_VERB ||
        t === START_VERB)
    ) {
      verb = t
      continue
    }
    if (isComponentId(t)) {
      if (!seen.has(t)) {
        seen.add(t)
        components.push(t)
      }
      continue
    }
    return { ok: false, error: `unknown argument: ${t}` }
  }

  if (verb === undefined) {
    // No bare verb: `swarm-setup` with nothing, or an explicit --help, is the usage screen.
    if (argv.length === 0 || help) verb = "help"
    else if (Object.keys(tokens).length > 0 || nonInteractive || dryRun || appConsent) {
      return { ok: false, error: "missing command verb (install | status | remove | wire | apply)" }
    } else {
      return { ok: false, error: `unknown command${help ? "" : ""}: expected install | status | remove | wire | apply` }
    }
  }

  if (appConsent && (verb !== VERBS.INSTALL || !nonInteractive || Object.keys(tokens).length === 0)) {
    return {
      ok: false,
      error: `${CONSENT_MODE_FLAG} ${CONSENT_MODE_APP} is valid only with install ${FLAGS.NON_INTERACTIVE} and ${FLAGS.TERMS_TOKEN}`,
    }
  }

  return { ok: true, cmd: { verb, components, nonInteractive, dryRun, tokens, appConsent } }
}

function absorbToken(
  val: string | undefined,
  tokens: Partial<Record<ComponentId, string>>,
): { ok: true } | { ok: false; error: string } {
  if (val === undefined) return { ok: false, error: "--terms-token requires <component>=<value>" }
  const eq = val.indexOf("=")
  if (eq <= 0) return { ok: false, error: `--terms-token value must be <component>=<value>, got "${val}"` }
  const comp = val.slice(0, eq)
  const value = val.slice(eq + 1)
  if (!isComponentId(comp))
    return { ok: false, error: `--terms-token component "${comp}" is not a register component id` }
  if (value.length === 0) return { ok: false, error: `--terms-token ${comp}= has an empty value` }
  tokens[comp] = value
  return { ok: true }
}
