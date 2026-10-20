// Command-surface parsing for the frozen verbs and flags (register class 12:
// PC-CMD-01 install / PC-CMD-02 status / PC-CMD-03 remove (+ --remove alias),
// PC-FLAG-01 --non-interactive / PC-FLAG-02 --terms-token <component>=<value> /
// PC-FLAG-03 --dry-run). The verbs were frozen by row 72 after gate R-3 ratified
// row 73's proposal (01c §3, 01c0 §12). There is deliberately NO update/upgrade verb.

import { VERBS, FLAGS, isComponentId, type ComponentId } from "./constants.ts"

export type Verb = "install" | "status" | "remove" | "help"

export interface ParsedCommand {
  verb: Verb
  /** Explicitly named components (empty = caller decides: install presents all seven). */
  components: ComponentId[]
  nonInteractive: boolean
  dryRun: boolean
  tokens: Partial<Record<ComponentId, string>>
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
    if (t.startsWith("-") && t.length > 1) {
      return { ok: false, error: `unknown flag: ${t}` }
    }

    // Positional token: either the verb or a component id.
    if (verb === undefined && (t === VERBS.INSTALL || t === VERBS.STATUS || t === VERBS.REMOVE)) {
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
    else if (Object.keys(tokens).length > 0 || nonInteractive || dryRun) {
      return { ok: false, error: "missing command verb (install | status | remove)" }
    } else {
      return { ok: false, error: `unknown command${help ? "" : ""}: expected install | status | remove` }
    }
  }

  return { ok: true, cmd: { verb, components, nonInteractive, dryRun, tokens } }
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
