// Row 86 — argv builders + CommandRunner for the runtime step.
//
// WHY A RUNNER INTERFACE: the blueprint gate demands "dry-run prints every command
// without executing" and the unit suite demands an instrumented spawn counter. One
// seam serves both: every external command this step would run is BUILT as an argv
// array here (pure, unit-testable) and EXECUTED only through a CommandRunner. The
// dry-run runner prints and counts NOTHING as executed; the real runner spawns via
// Bun.spawnSync with an argv ARRAY and an absolute binary path — never a shell
// (P-3: no pipe-to-shell; r87 precedent + fetch.proofs.sh 3c keep node:child_process
// confined to verify.ts).
//
// PORT RULE (decisions.md :30 PORT BLOCK): this module publishes no ports and holds
// ZERO port literals. The VM publishes nothing; stack health URLs are row 93's, fed
// by the row-85 rendered artefacts. The runtime health gate below uses `docker info`
// over the context socket — no address, no number.
//
// P-5 CONTEXT PINNING: every docker argv carries `--context <name>` as a leading flag,
// where <name> is the OBSERVED colima-created context, never an assumption. Measured
// live (r93 finding H-R93-1): colima 0.10.3 names the context for profile `swarm`
// `colima-swarm`, while the register literal PC-PROF-02 (DOCKER_CONTEXT="swarm", r81-
// owned constants.ts) does not exist on a real host. The step therefore treats the
// register value as the PREFERRED name and `colima-<profile>` as the measured fallback,
// discovers which one docker actually has after profile create (capture.ts::
// observeDockerContext), records the observed name into state for consumers (row 91
// reads it from state per its parallel fix), and pins every later docker argv to it.
// `docker context use` appears only in the RESTORE-ONLY builder below (proof 7f counts
// exactly one); the user's current context is never switched — isolation is proven by
// before/after `docker context ls` comparison (capture.ts::buildContextEvidence).

import { COLIMA_PROFILE, DOCKER_CONTEXT } from "../../constants.ts"

export interface ExecResult {
  readonly ok: boolean // exit 0 AND the spawn itself started
  readonly exitCode: number // 127 when the binary was absent / spawn failed
  readonly stdout: string
  readonly stderr: string
}

export interface CommandRunner {
  /** Run (or, print-only mode, record) one argv array. Never throws. */
  run(argv: readonly string[]): ExecResult
  /** Spawns actually performed (dry-run stays 0 — the instrumented counter the gate names). */
  readonly executedCount: number
  /** Every argv seen, shell-quoted, in order (dry-run output; also what a real run logs). */
  readonly printed: readonly string[]
}

const SPAWN_TIMEOUT_MS = 300_000 // colima start pulls a multi-hundred-MB guest image on first bring-up

/** Quote one argv token for the human-readable print line (display only — execution
 *  always passes the raw array, never this string, so quoting cannot affect behavior). */
function quoteArg(token: string): string {
  if (/^[A-Za-z0-9._/:@,=+-]+$/.test(token)) return token
  return `'${token.replace(/'/g, `'\\''`)}'`
}

export function formatArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ")
}

/** Normalize piped spawn output (bun 1.3.14 hands back Buffer/Uint8Array; the global
 *  TextDecoder shim is declared additively in types/node-step.d.ts, r87). */
function asText(value: string | Uint8Array | undefined): string {
  if (value === undefined) return ""
  return typeof value === "string" ? value : new TextDecoder().decode(value)
}

/** The dry-run runner: records the print line, returns a neutral success WITHOUT any
 *  spawn (executedCount stays 0 forever). Callers must not branch on its stdout — the
 *  step defers all host-dependent decisions to the real path under --dry-run. */
export function printOnlyRunner(): CommandRunner {
  const printed: string[] = []
  return {
    run(argv: readonly string[]): ExecResult {
      printed.push(formatArgv(argv))
      return { ok: true, exitCode: 0, stdout: "", stderr: "" }
    },
    executedCount: 0,
    get printed(): readonly string[] {
      return printed
    },
  }
}

/** The real runner: Bun.spawnSync, argv array, absolute path, bounded timeout.
 *  A missing binary surfaces as exitCode 127 (ok:false), never an exception.
 *  Output normalization via TextDecoder per r87's measured note: piped streams come back
 *  as Buffer/Uint8Array regardless of any encoding option (bun 1.3.14). */
export function spawnRunner(timeoutMs: number = SPAWN_TIMEOUT_MS): CommandRunner {
  const printed: string[] = []
  let executed = 0
  return {
    run(argv: readonly string[]): ExecResult {
      printed.push(formatArgv(argv))
      if (argv.length === 0) return { ok: false, exitCode: 127, stdout: "", stderr: "empty argv" }
      // Bun.spawnSync THROWS on a missing binary (measured, r93 H-R93-7) — the documented
      // contract here is exitCode 127, so the throw is caught and mapped, never propagated.
      try {
        const out = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
        executed += 1
        const code = out.exitCode ?? 127
        return { ok: code === 0, exitCode: code, stdout: asText(out.stdout), stderr: asText(out.stderr) }
      } catch (err) {
        executed += 1
        return { ok: false, exitCode: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) }
      }
    },
    get executedCount(): number {
      return executed
    },
    get printed(): readonly string[] {
      return printed
    },
  }
}

/** A runner scripted from fixtures (the test seam + row 93's mock-docker tool):
 *  matches the first rule whose `match` prefix hits the argv line; default miss = 127.
 *  Counts executions like the real runner so zero-exec proofs stay meaningful. */
export function scriptedRunner(
  script: readonly { readonly match: string; readonly result?: Partial<ExecResult>; readonly stdout?: string }[],
): CommandRunner & { readonly calls: string[] } {
  const calls: string[] = []
  let executed = 0
  return {
    calls,
    run(argv: readonly string[]): ExecResult {
      const line = formatArgv(argv)
      calls.push(line)
      executed += 1
      const hit = script.find((s) => line.startsWith(s.match))
      if (!hit) return { ok: false, exitCode: 127, stdout: "", stderr: `no fixture for: ${line}` }
      const r = hit.result ?? {}
      return {
        ok: r.ok ?? (r.exitCode ?? 0) === 0,
        exitCode: r.exitCode ?? 0,
        stdout: hit.stdout ?? r.stdout ?? "",
        stderr: r.stderr ?? "",
      }
    },
    get executedCount(): number {
      return executed // counts like the real runner: a fixture run proves the FULL command sequence
    },
    get printed(): readonly string[] {
      return calls
    },
  }
}

// --- absolute binary paths ---------------------------------------------------------------
// Homebrew's arm64 prefix is fixed (/opt/homebrew); resolving through the detected brew
// prefix keeps x86/Rosetta installs OUT of reach (02d §5.4: an x86_64 brew on M-series
// breaks startup — preflight refuses that host shape anyway).

export const SYSTEM_TOOLS = {
  sw_vers: "/usr/bin/sw_vers",
  // MEASURED (r93 live, H-R93-7): macOS ships sysctl at /usr/sbin, not /sbin.
  sysctl: "/usr/sbin/sysctl",
  colimaDefault: "/opt/homebrew/bin/colima", // canonical arm64 install (also the P-1 signature-gate target)
} as const

export function brewBin(name: string, brewPrefix: string): string {
  return `${brewPrefix}/bin/${name}`
}

// --- argv builders (pure) ------------------------------------------------------------------

/** Colima start for OUR profile only. The sizing contract is 01e §7.1 (row 75 ratified):
 *  8 CPU / 10 GiB when Firecrawl is consented, 2 CPU / 2 GiB otherwise; disk 60 GiB is
 *  stated explicitly because THIS build's default drifted to 100 (measured 2026-10-20:
 *  `-d, --disk int (default 100)`) while 01e §7.2 reasons on 60. vm-type is ALWAYS vz —
 *  D-12 closed by this row declaring vz the only supported path, so QEMU is never
 *  installed (§capture records the observed scope). Flag spellings are MEASURED against
 *  colima 0.10.3's own help on this host: the canonical long form is `--cpus` (the 01e
 *  contract's `--cpu` appears only in its examples; pflag matches long names exactly),
 *  and `--activate=false` suppresses colima's context-activation side effect — the
 *  PRIMARY P-5 mechanism (the user's current-context marker then never moves at all;
 *  the restore path in index.ts stays as the defensive fallback). No license-acceptance
 *  flag exists or is used (P-5). */
export function colimaStartArgv(colimaPath: string, cpu: number, memoryGiB: number, veryVerbose: boolean): string[] {
  const argv = [
    colimaPath,
    "start",
    "--profile",
    COLIMA_PROFILE,
    "--cpus",
    String(cpu),
    "--memory",
    String(memoryGiB),
    "--disk",
    String(DISK_GIB_CONTRACT),
    "--vm-type",
    "vz",
    "--activate=false",
  ]
  if (veryVerbose) argv.push("--very-verbose")
  return argv
}

/** 01e §7.2's stated disk (the value its memory math reasons on), pinned explicitly. */
export const DISK_GIB_CONTRACT = 60

export function colimaStopArgv(colimaPath: string): string[] {
  return [colimaPath, "stop", "--profile", COLIMA_PROFILE]
}

export function colimaDeleteArgv(colimaPath: string): string[] {
  // --force: non-interactive removal of OUR OWN profile; guarded upstream by the
  // state manifest (installedBySwarm/dockerObjects) + the foreign-container check in index.ts.
  return [colimaPath, "delete", "--profile", COLIMA_PROFILE, "--force"]
}

export function colimaListJsonArgv(colimaPath: string): string[] {
  // MEASURED on colima 0.10.3 (this host, 2026-10-20): the flag is `--json` (`-j`);
  // `--output json` errors "unknown flag". A single profile prints a bare OBJECT,
  // multiple profiles print a JSON array — capture.ts::listColimaProfiles accepts both.
  return [colimaPath, "list", "--json"]
}

/** Every docker call in this step goes through here: the context flag is structural,
 *  so "explicit docker --context <observed>" (PC-PROF-02 + P-5, 01c §12) cannot be
 *  forgotten at a call site. The NAME is passed in — observed after profile create per
 *  the header note; callers must never hardcode a context literal. */
export function dockerArgv(dockerPath: string, contextName: string, ...args: string[]): string[] {
  return [dockerPath, "--context", contextName, ...args]
}

/** Candidate context names for profile `swarm`, preference order, de-duplicated: the
 *  register literal first (PC-PROF-02 — amended r72-fix3 to the MEASURED `colima-swarm`,
 *  so today both entries collapse to one), then the measured convention `colima-<profile>`
 *  kept as defense if a future colima or register drifts again (r93 H-R93-1 lineage).
 *  observeDockerContext picks whichever actually exists. */
export function contextCandidates(): string[] {
  return [...new Set([DOCKER_CONTEXT, `colima-${COLIMA_PROFILE}`])]
}

/** Read-only context listing for the isolation evidence. Space-separated (Go templates
 *  do NOT expand \t inside --format text, so a real tab would print literally); the
 *  Current column renders "*" on the active row and empty elsewhere. */
export function dockerContextLsArgv(dockerPath: string): string[] {
  return [dockerPath, "context", "ls", "--format", "{{.Name}} {{.Current}}"]
}

/** RESTORE-ONLY use of `docker context use` (P-5 end-state): colima's start activates its
 *  own context as a side effect; this step puts back the USER's previous current context.
 *  It is called exclusively with the name read from the BEFORE table, never with our own
 *  profile name — our commands are structurally pinned via dockerArgv and marker-independent. */
export function dockerContextUseArgv(dockerPath: string, name: string): string[] {
  return [dockerPath, "context", "use", name]
}

/** The runtime health gate: daemon reachable over OUR observed context. Socket-based, port-free. */
export function dockerInfoArgv(dockerPath: string, contextName: string): string[] {
  return dockerArgv(dockerPath, contextName, "info", "--format", "{{.ServerVersion}}")
}

/** Containers inside our profile that do NOT carry PC-LBL-01 — foreign objects that make
 *  profile deletion unsafe (someone reused the dedicated VM; P-14 protects their data). */
export function foreignContainersArgv(dockerPath: string, contextName: string): string[] {
  return dockerArgv(
    dockerPath,
    contextName,
    "ps",
    "-a",
    "--filter",
    "label!=io.gsp.swarm.managed=true",
    "--format",
    "{{.ID}}",
  )
}

export function brewListVersionsArgv(brewPath: string, formula: string): string[] {
  return [brewPath, "list", "--formula", "--versions", formula]
}

export function brewInstallArgv(brewPath: string, formula: string): string[] {
  return [brewPath, "install", "--formula", formula]
}

export function brewInfoJsonArgv(brewPath: string, formula: string): string[] {
  return [brewPath, "info", "--json=v2", formula]
}

/** Lima instance backing colima profile `swarm` is named `colima-swarm` (colima's own
 *  naming; carried [H] until row 93's first live start confirms — capture.ts probes both
 *  candidate instance names and records which answered). */
export function limactlInspectArgv(limactlPath: string, instance: string): string[] {
  return [limactlPath, "inspect", instance]
}
