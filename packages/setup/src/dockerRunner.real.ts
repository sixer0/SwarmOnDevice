// Row 93 — the REAL, spawn-backed DockerRunner: the single place a stack step (row 91) is
// allowed to reach an actual docker daemon.
//
// WHY THIS FILE EXISTS (r91 handoff s91_stack_step.md §9): row 91 proved every compose-lifecycle
// path OFFLINE against an in-process fake (`makeFakeDockerShim`), and deliberately shipped NO
// process-spawn — `runnerGuard` refuses with FAILED whenever no runner is injected. Row 93 is the
// engine-side wiring that supplies that injected runner: `src/stacklib.ts::DockerRunner`, backed by
// a real child process. This is the FIRST row on this host to run real colima/docker at all.
//
// CONTRACT PARITY WITH THE FAKE SHIM (the whole point of the seam): the interface is
// `(args: readonly string[]) => Promise<DockerResult>` where args carry NO program element — the
// runner alone supplies the binary (r91 comment stacklib.ts:65-68). Everything row 91 relies on —
// the leading `--context swarm` (PC-PROF-02), the `-p swarm-tools` project (PC-PROJ-01), the
// label-scoped cleanup selectors, and the ABSENCE of any `prune` verb — is already baked into the
// argv by stacklib's builders; this file NEVER rewrites argv, it only prepends the absolute binary
// and spawns. The unit suite (test/docker_runner_real.test.ts) drives the SAME command sequences
// through `makeFakeDockerShim` and through this runner (with a scripted spawn) and asserts they are
// identical, so "the fake proved the logic" stays true once the real one drops in.
//
// SPAWN DISCIPLINE (inherited verbatim from row 86 commands.ts::spawnRunner + row 87 node/index.ts,
// both measured on bun 1.3.14):
//   - argv ARRAY + ABSOLUTE binary path, never a shell, never PATH lookup (P-3 no pipe-to-shell).
//   - piped stdout/stderr come back as Buffer/Uint8Array REGARDLESS of any encoding option, so both
//     are normalised through TextDecoder (the `asText` r87 note). No `encoding` flag is trusted.
//   - a missing binary / spawn failure surfaces as a resolved DockerResult with exitCode 127, NOT a
//     rejection — row 91's bringUp `await`s this promise and branches on exitCode; it must never see
//     a thrown error mid-lifecycle (that would skip its commitFailure/provenance bookkeeping).
//   - a killed/timed-out child (exitCode null from Bun.spawnSync) maps to a non-zero code too.
//
// PORT RULE (decisions.md entry 'USER DECISION (PORT BLOCK, 05:33 UTC)'): this module holds ZERO port literals and binds nothing.
// The host-side HTTP probes that consume published ports belong to the proof harness and read the
// ports FROM the rendered artefact (stacklib.healthProbeUrls), exactly as row 91 derives them.
//
// NON-INTERFERENCE (PC-PROF-02 + P-5): the runner trusts the injected argv's `--context swarm`
// (structural from stacklib), so it can never accidentally speak to the user's default context; it
// adds no `-c`/`--context` of its own that could shadow that flag.

import type { DockerResult, DockerRunner } from "./stacklib.ts"

/** Canonical arm64 Homebrew install path (same constant class as row 86 SYSTEM_TOOLS.colimaDefault).
 *  Resolved through the caller's brew prefix via the option below; this default is the P-1 signature
 *  target the runtime step also pins. A PATH-resolved `docker` is deliberately NOT used. */
export const DOCKER_BINARY_DEFAULT = "/opt/homebrew/bin/docker"

/** Per-command ceiling. Cold-start `compose up -d --pull never` of the Firecrawl stack (seven
 *  containers) plus its health-gate polls can legitimately run past row 86's 300s colima-start
 *  window on a contended laptop; image PULLS are NOT routed through this runner (they stream from
 *  the proof harness), so no call here needs a multi-minute budget. 600s is the safety margin. */
export const DEFAULT_TIMEOUT_MS = 600_000

/** Normalise piped spawn output — the exact r87/r86 helper. Bun hands back Buffer (Uint8Array) for
 *  both streams on 1.3.14; the global TextDecoder shim is declared in types/node-step.d.ts. */
export function asText(value: string | Uint8Array | undefined): string {
  if (value === undefined) return ""
  return typeof value === "string" ? value : new TextDecoder().decode(value)
}

/** What a spawn returns; mirrors BunSpawnSyncOutput (types/node-step.d.ts) so the production spawn
 *  is assignable and a test can hand back a plain literal without importing Bun. */
export interface SpawnOutput {
  readonly exitCode: number | null
  readonly stdout: string | Uint8Array
  readonly stderr: string | Uint8Array
}

/** Injectable spawn. MAY THROW (missing binary) — makeRealDockerRunner catches and maps it, which is
 *  precisely why the seam exists: the unit tests drive throw/timeout/exit-code paths with NO real
 *  process, mirroring row 86's scriptedRunner discipline (a test seam that can only observe/narrow,
 *  never widen contact or fabricate consent). */
export type SpawnFn = (argv: readonly string[], opts: { readonly timeout: number }) => SpawnOutput

/** Environment names stripped from every docker child this runner spawns (row 270, F-265-3). Same class as
 *  F-251-9, which row 268 closed on the OBSERVATION door in packages/opencode (`shared/lanes-observation.ts`
 *  carries the twin list); this is the MUTATING door — `compose up/down/exec` against the estate — where a
 *  mis-aimed spawn changes state instead of only reading it. The context is already pinned in argv
 *  (`--context colima-swarm`, structural from stacklib and never rewritten here), so an inherited
 *  DOCKER_HOST would be a SECOND, ambient way to choose which daemon answers, and DOCKER_CONTEXT /
 *  DOCKER_CONFIG are the same lever one layer up. Local copy rather than an import: dependency direction —
 *  packages/setup must not import from packages/opencode. Residual by design on both doors: DOCKER_CERT_PATH,
 *  DOCKER_TLS_VERIFY, DOCKER_API_VERSION and DOCKER_MACHINE_NAME remain inherited — TLS and version knobs,
 *  not endpoint selectors — so this list is deliberately NOT "all docker variables".
 *  ONE HOME on the setup side (row 272): the runtime step's door (`steps/runtime/commands.ts::spawnRunner`,
 *  colima + docker info/ps/context ls/context use) consumes `dockerSpawnEnv` from here, so both setup doors
 *  strip the same names and their children resolve the same docker config dir. Do not copy this list. */
export const DOCKER_ENV_DENY = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"] as const

/** A copy of `env` with the daemon-selection names removed. Everything else passes through, PATH and HOME
 *  included, and both are load-bearing: PATH is how docker finds its own helpers, and HOME is where the
 *  pinned context resolves from (~/.docker — rule E15's split: a process with a SANDBOXED HOME sees no
 *  daemon at all, so the daemon-facing leg keeps the real HOME while file-facing legs pin their own). */
export function dockerSpawnEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || (DOCKER_ENV_DENY as readonly string[]).includes(key)) continue
    out[key] = value
  }
  return out
}

/** The production spawn: Bun.spawnSync, argv array, absolute binary, bounded timeout, both streams
 *  piped. Nothing above this knows about processes. The environment is the explicit stripped copy above,
 *  so no daemon-selection variable is inherited into the mutating door (F-265-3). */
export const realSpawn: SpawnFn = (argv, opts) => {
  const out = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: opts.timeout, env: dockerSpawnEnv() })
  return { exitCode: out.exitCode ?? null, stdout: out.stdout, stderr: out.stderr }
}

export interface RealRunnerOptions {
  /** Absolute path to the docker CLI (never a bare name). Default: brew arm64 prefix. */
  readonly dockerBinary?: string
  /** Per-command ceiling in ms. */
  readonly timeoutMs?: number
  /** TEST SEAM ONLY: replaces the process spawn (scripted fixtures). Cannot touch anything else. */
  readonly spawn?: SpawnFn
  /** Short label recorded alongside each invocation for provenance/debug (does not affect argv). */
  readonly correlationId?: string
}

export interface RealDockerRunner {
  /** The function row 91 injects as `StackStepContext.docker`. */
  readonly runner: DockerRunner
  /** Docker-subcommand args WITHOUT the binary — parity with `makeFakeDockerShim().invocations` so a
   *  drop-in test can compare the two runners' command surfaces element for element. */
  readonly invocations: string[][]
  /** Full spawned argv arrays INCLUDING the absolute binary — the evidence for "absolute path, no
   *  shell": every entry starts with `dockerBinary`, never with `sh`/`bash`/`-c`. */
  readonly spawnedArgv: string[][]
  /** Spawns actually performed (a dry-run never calls the runner, so this stays 0 there — parity
   *  with row 86's instrumented executedCount). */
  executedCount(): number
  /** `formatCmd`-style display lines (docker-subcommand args), matching stacklib.formatCmd output so
   *  the live log reads identically whether the fake or the real runner backed it. */
  formatted(): string[]
  /** True when NO invocation happened — the dry-run/fail-closed parity assertion. */
  zeroExec(): boolean
  /** True when no built command carries the banned cleanup verb (P-14), same guarantee the shim makes. */
  neverPrune(): boolean
  readonly correlationId?: string
}

/** Build the spawn-backed runner. Returned object records every call so the live smoke can print
 *  the exact argv it ran and prove context/project/label scoping survived into the real process. */
export function makeRealDockerRunner(options: RealRunnerOptions = {}): RealDockerRunner {
  const dockerBinary = options.dockerBinary ?? DOCKER_BINARY_DEFAULT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const spawn = options.spawn ?? realSpawn
  const invocations: string[][] = []
  const spawnedArgv: string[][] = []
  let executed = 0

  const runner: DockerRunner = async (args) => {
    // Prepend ONLY the binary; the caller's argv already carries every scoping flag. Copy first so
    // a caller-held readonly array cannot be mutated out from under row 91's later checks.
    const argv = [dockerBinary, ...args]
    invocations.push([...args])
    spawnedArgv.push([...argv])
    try {
      const out = spawn(argv, { timeout: timeoutMs })
      executed += 1
      // exitCode null = the child was killed past the deadline (Bun.spawnSync timedOut posture); map
      // to non-zero so row 91's health/wait gate treats a hang as a failed poll, not success.
      const exitCode = out.exitCode ?? 127
      return { exitCode, stdout: asText(out.stdout), stderr: asText(out.stderr) }
    } catch (err) {
      // A missing binary or spawn refusal must resolve, never reject — see header contract bullet.
      executed += 1
      return { exitCode: 127, stdout: "", stderr: `docker spawn failed for ${argv[0]}: ${(err as Error).message}` }
    }
  }

  return {
    runner,
    invocations,
    spawnedArgv,
    executedCount: () => executed,
    formatted: () => invocations.map((args) => ["docker", ...args].join(" ")),
    zeroExec: () => invocations.length === 0,
    neverPrune: () => !invocations.some((args) => args.some((a) => a.includes("prune"))),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
  }
}
