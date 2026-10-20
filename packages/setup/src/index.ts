// swarm-setup entry point (register PC-PKG-01). Row 81 skeleton: the command surface,
// the state-machine engine wiring, the fail-closed lock loader, the consent gate FIRST,
// the lock directory, and step self-registration by directory scan. Row 83 wired the
// consent UI onto that gate (consent.ts + consentText.ts + policy.ts): per-component nine-
// field blocks, terms linked never auto-accepted, --terms-token validation, durable consent
// recording BEFORE any fetch is permitted, and the F-79-A policy hook (enforcement half).
// It performs NO network fetch itself (row 82 owns the library; steps own calling it),
// installs NO component behaviour (rows 86-90), and binds no port (PORT RULE).
//
// Order of operations for `install` (01c §11): platform+root gate -> acquire lock ->
// load+validate tools.lock.json -> read fleet policy (F-79-A hook) -> print consolidated host
// list -> render consent blocks unticked (or refuse tokens) -> record grants durably ->
// (only then) step pipeline. Nothing past the recording line runs without a recorded consent.

import { parseArgs, type ParsedCommand } from "./cli.ts"
import { runEntryGates } from "./gates.ts"
import { loadLock } from "./lockfile.ts"
import { readState, defaultState } from "./state.ts"
import { acquireLock, releaseLock } from "./lockdir.ts"
import { printHostList, evaluateConsent, renderConsentScreen } from "./consent.ts"
import { enforcePolicy } from "./wiring/policy_enforce.ts"
import { discoverSteps, orderSteps } from "./steps.ts"
import { COMPONENT_IDS, PROGRAM_NAME, type ComponentId } from "./constants.ts"
import { OUTCOME, EXIT_OK, EXIT_FAIL, exitCodeFor, messageFor, type OutcomeToken } from "./outcomes.ts"

function usageText(lockVersion?: string): string {
  const title = `${PROGRAM_NAME} — consent-first pre-install for optional Swarm tools (macOS arm64, unprivileged)`
  // Row 106: the banner states the ONE version this program can substantiate — the .version
  // field of the tools.lock.json it just loaded (PC-LBL-03 source). The CLI product version
  // (OPENCODE_VERSION define, register V09 / 01b:101) belongs to the swarm binary, not here;
  // printing it without the define plumbing behind it would be a lie, so it is absent by design.
  const lines = [title]
  if (lockVersion) lines.push(`tools lock: ${lockVersion}`)
  return [
    ...lines,
    "",
    "Usage:",
    `  ${PROGRAM_NAME}                        show this help + component states + host list`,
    `  ${PROGRAM_NAME} --help                 same`,
    `  ${PROGRAM_NAME} install [component...] consent-first install (all seven optional, unticked)`,
    `  ${PROGRAM_NAME} status                 report each component's state (read-only JSON)`,
    `  ${PROGRAM_NAME} remove  [component...] remove only what swarm-setup created (alias: --remove)`,
    "",
    "Flags:",
    "  --non-interactive                MDM mode; needs --terms-token for every selected component",
    "  --terms-token <component>=<value>  per-tool acknowledgement unlocking --non-interactive",
    "                                   (value = <component_id>@<lock_sha256_12>, shown on the consent screen)",
    "  --dry-run                        touch nothing; install shows exactly what consent would be asked for, remove lists what would be deleted",
    "",
    `Components: ${COMPONENT_IDS.join(", ")}`,
  ].join("\n")
}

function cmdHelp(): OutcomeToken {
  // Load first so the banner can carry the lock version it actually validated (row 106).
  const lockRes = loadLock()
  console.log(usageText(lockRes.ok ? lockRes.lock.version : undefined))
  // Consolidated host list + current states are best-effort reads (no side effects).
  if (lockRes.ok) {
    console.log("")
    printHostList(lockRes.lock.hosts)
    const st = readState(lockRes.lock.version)
    if (st.ok) {
      console.log("")
      console.log("Component states:")
      for (const id of COMPONENT_IDS) console.log(`  ${id}: ${st.state.components[id].state}`)
    }
  } else {
    console.log(`\n(host list unavailable: ${lockRes.error})`)
  }
  return OUTCOME.OK
}

function cmdStatus(): OutcomeToken {
  const lockRes = loadLock()
  if (!lockRes.ok) {
    console.error(`${PROGRAM_NAME}: ${lockRes.error}`)
    return OUTCOME.REFUSED_LOCK_MALFORMED
  }
  const st = readState(lockRes.lock.version)
  if (!st.ok) {
    console.error(`${PROGRAM_NAME}: ${st.error}`)
    return OUTCOME.FAILED
  }
  // Read-only: print the state envelope as pure JSON on stdout (the schema artifact).
  console.log(JSON.stringify(st.state, null, 2))
  return OUTCOME.OK
}

function resolveSelected(named: readonly ComponentId[]): ComponentId[] {
  return named.length > 0 ? [...named] : [...COMPONENT_IDS]
}

/** F-79-A enforcement (hook only; admin switch DEFERRED): forbidden components never reach the
 *  consent screen — they are dropped here and again inside evaluateConsent (one enforcement point
 *  per layer, same rule). A named-but-forbidden component warns so the operator sees why it vanished. */
function selectable(selected: readonly ComponentId[], forbidden: readonly ComponentId[]): ComponentId[] {
  const set = new Set(forbidden)
  const blocked = selected.filter((id) => set.has(id))
  if (blocked.length > 0)
    console.error(
      `${PROGRAM_NAME}: admin policy forbids ${blocked.join(", ")} — not presented, token or not (F-79-A hook)`,
    )
  return selected.filter((id) => !set.has(id))
}

function cmdInstall(cmd: ParsedCommand): OutcomeToken {
  const lock = acquireLock()
  if (!lock.ok) {
    console.error(`${PROGRAM_NAME}: another swarm-setup is running (holder pid ${lock.holderPid})`)
    return OUTCOME.REFUSED_CONCURRENCY
  }
  try {
    const lockRes = loadLock()
    if (!lockRes.ok) {
      console.error(`${PROGRAM_NAME}: ${lockRes.error}`)
      return OUTCOME.REFUSED_LOCK_MALFORMED
    }

    // F-79-A policy hook — LIVE enforcement since FIX3 (r97 routed): strict schema validation and
    // a policy_active line on the unified audit chain whenever a policy is consulted; fail-closed
    // on every defect including unknown top-level keys. Read BEFORE anything is presented, so a
    // forbidden component never reaches the consent screen. Absent file = inactive, unchanged v1
    // behaviour (the admin switch itself stays DEFERRED per decisions.md).
    const policy = enforcePolicy({ correlationId: `run-${process.pid}` })
    if (!policy.ok) {
      console.error(`${PROGRAM_NAME}: ${policy.error}`)
      return OUTCOME.FAILED
    }
    const forbidden = policy.forbidden

    // Step 4: consolidated host list BEFORE any download (P-18 / P-13).
    printHostList(lockRes.lock.hosts)

    // Step 5 (row 83): per-component consent blocks — nine P-13 fields, live zero-network pins,
    // terms LINKED not auto-accepted, admin token for this lock. --dry-run shows EXACTLY what
    // would be asked, then refuses without consent (row-81 PROOF 3 exit contract preserved:
    // a dry run never consents, never records, never downloads).
    const offered = selectable(resolveSelected(cmd.components), forbidden)
    if (cmd.dryRun) {
      renderConsentScreen(lockRes.lock, offered, { dryRun: true })
      const scan = discoverSteps()
      for (const e of scan.errors) console.error(`${PROGRAM_NAME}: step descriptor error: ${e}`)
      const ordered = orderSteps(scan.steps)
      if (ordered.ok) {
        console.log("dry-run: after consent, steps would run in this order (touching nothing):")
        for (const s of ordered.ordered) console.log(`  - ${s.id}`)
      }
      return OUTCOME.REFUSED_NO_CONSENT
    }

    // Step 6: consent gate. Nothing downloads unless consent is granted AND durably recorded
    // (evaluateConsent records to PC-PATH-03 with fsync BEFORE it can return ok:true).
    const consent = evaluateConsent({
      selected: offered,
      nonInteractive: cmd.nonInteractive,
      tokens: cmd.tokens,
      lock: lockRes.lock,
      forbidden,
    })
    if (!consent.ok) {
      return consent.token // REFUSED_NO_CONSENT / REFUSED_NON_INTERACTIVE — nothing fetched, nothing written
    }

    // --- Past consent: consent is now durable on disk (consent.log). Rows 86-90 add the step
    // modules that consume it; the skeleton itself still installs nothing. ---
    const scan = discoverSteps()
    if (scan.errors.length > 0) {
      for (const e of scan.errors) console.error(`${PROGRAM_NAME}: step descriptor error: ${e}`)
      return OUTCOME.FAILED
    }
    const ordered = orderSteps(scan.steps)
    if (!ordered.ok) {
      console.error(`${PROGRAM_NAME}: ${ordered.error}`)
      return OUTCOME.FAILED
    }
    // Real per-step execution is rows 86-90; the skeleton has no fetch/install behaviour.
    console.error(
      `${PROGRAM_NAME}: consent recorded for ${consent.consented.join(", ")}; step execution is owned by rows 86-90, which install nothing yet`,
    )
    for (const s of ordered.ordered) console.log(`  would run step: ${s.id}`)
    return OUTCOME.FAILED
  } finally {
    releaseLock()
  }
}

function cmdRemove(cmd: ParsedCommand): OutcomeToken {
  const lock = acquireLock()
  if (!lock.ok) {
    console.error(`${PROGRAM_NAME}: another swarm-setup is running (holder pid ${lock.holderPid})`)
    return OUTCOME.REFUSED_CONCURRENCY
  }
  try {
    const lockRes = loadLock()
    if (!lockRes.ok) {
      console.error(`${PROGRAM_NAME}: ${lockRes.error}`)
      return OUTCOME.REFUSED_LOCK_MALFORMED
    }
    const st = readState(lockRes.lock.version)
    if (!st.ok) {
      console.error(`${PROGRAM_NAME}: ${st.error}`)
      return OUTCOME.FAILED
    }

    // Collect ONLY objects the setup created (P-14: label + state manifest must agree).
    const targets: string[] = []
    const scope = cmd.components.length > 0 ? cmd.components : COMPONENT_IDS
    for (const id of scope) {
      const c = st.state.components[id]
      if (!c.installedBySwarm) continue
      for (const p of c.paths ?? []) targets.push(`${id}:path ${p}`)
      for (const o of c.dockerObjects ?? [])
        if (o.createdBySwarm) targets.push(`${id}:${o.kind} ${o.id}${o.hasData ? " [DATA]" : ""}`)
    }

    if (cmd.dryRun) {
      console.log(`dry-run remove: would delete ${targets.length} object(s), deleting nothing:`)
      for (const t of targets) console.log(`  - ${t}`)
      return OUTCOME.OK
    }
    if (targets.length === 0) {
      console.log("nothing to remove: swarm-setup created no objects")
      return OUTCOME.OK
    }
    // Actual deletion (label match + ask-before-volume) is owned by rows 90+/97.
    console.log(`remove would target ${targets.length} object(s); deletion behaviour is owned by rows 90+/97`)
    for (const t of targets) console.log(`  - ${t}`)
    return OUTCOME.SKIPPED_WITH_INSTRUCTIONS
  } finally {
    releaseLock()
  }
}

export function main(argv: readonly string[]): void {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    console.error(`${PROGRAM_NAME}: ${parsed.error}`)
    console.log(`RESULT ${OUTCOME.FAILED}`)
    process.exit(EXIT_FAIL)
  }
  const cmd = parsed.cmd

  // Entry gates FIRST for every command (platform P-20, root P-4).
  const gate = runEntryGates()
  if (gate) {
    console.error(`${PROGRAM_NAME}: ${messageFor(gate)}`)
    console.log(`RESULT ${gate}`)
    process.exit(exitCodeFor(gate))
  }

  let token: OutcomeToken
  switch (cmd.verb) {
    case "help":
      token = cmdHelp()
      break
    case "status":
      token = cmdStatus()
      break
    case "install":
      token = cmdInstall(cmd)
      break
    case "remove":
      token = cmdRemove(cmd)
      break
  }

  // A successful `status` printed pure JSON; do not pollute stdout with a RESULT line.
  const suppressResultLine = cmd.verb === "status" && token === OUTCOME.OK
  if (!suppressResultLine) {
    console.log(`RESULT ${token}`)
    if (exitCodeFor(token) !== EXIT_OK) console.error(`${PROGRAM_NAME}: ${messageFor(token)}`)
  }
  process.exit(exitCodeFor(token))
}

main(process.argv.slice(2))
