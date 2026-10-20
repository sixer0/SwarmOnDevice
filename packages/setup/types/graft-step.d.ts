// Row-88 additive ambient declarations for the private-Graft step. Same pattern as
// types/node-step.d.ts (row 87), types/bun-net.d.ts (row 82), consent-tty.d.ts (row 83)
// and setup-log.d.ts (row 84): interface merge only ADDS members; nothing existing is
// redeclared or changed. Row 106 compiles against the full @types/bun catalog and these
// shims retire. Hermetic-toolchain rationale: env.d.ts header.
//
// Row 87 declared BunSpawnSyncOptions with stdout/stderr/timeout/cwd but no `env`, because
// its own spawns inherit the parent environment. Graft's npm install and telemetry probe MUST
// pass an explicit child environment (npm_config_cache redirect + DO_NOT_TRACK=1) while leaving
// process.env untouched, so this merge adds ONLY the optional `env` member. The real @types/bun
// surface already carries it; this keeps the hermetic shim honest about what row 88 actually uses.

interface BunSpawnSyncOptions {
  /** Explicit child environment. Never derived from a mutated process.env — callers pass a COPY
   *  built by nodeChildEnv()/buildNpmEnv() so PATH is copied verbatim and no value leaks back. */
  readonly env?: Readonly<Record<string, string>>
}
