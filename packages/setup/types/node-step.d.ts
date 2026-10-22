// Row-87 additive ambient declarations for the private-Node step. Same pattern as
// types/bun-net.d.ts (row 82), types/consent-tty.d.ts (row 83) and types/setup-log.d.ts
// (row 84): interface/module augmentation only ADDS members; nothing existing is
// redeclared or changed. Row 106 compiles against the full @types/bun catalog and these
// shims retire. Hermetic-toolchain rationale: env.d.ts header.
//
// Deliberate omission: NO node:child_process declaration is added here. Row 82's proof
// gate confines that import to verify.ts across all of src/ (fetch.proofs.sh 3c), and
// row 87 honors it rather than widening it — the step spawns through Bun.spawnSync
// (below), always with an argv ARRAY and an absolute-path binary, never a shell.

declare module "node:fs" {
  /** Mode-set by PATH. Callers (grep at row 273b): the node and rtk steps' staged binaries inside
   *  ~/.swarm/tools (P-4 permits chmod inside the P-16 whitelist; an extracted binary must carry its
   *  exec bits), and the 0700/0600 posture repair of ~/.swarm/setup and lanes.json in
   *  composefiles/lanes.ts and estate/pins.ts. atomic.ts no longer uses it (row 273b, see fchmodSync). */
  export function chmodSync(path: string, mode: number): void
  /** Mode-set on an OPEN file descriptor (row 273b, row 265e F1): atomic.ts sets the declared mode on
   *  the temp inode it just created exclusively, so no swap of the temp name can redirect the change. */
  export function fchmodSync(fd: number, mode: number): void
}

// Bun's own sync spawner — mirrors @types/bun for exactly the members row 87 uses.
// Interface merge with bun-net.d.ts's BunNamespace (row 82); nothing existing changes.
// Bun exposes TextDecoder globally (mirror of setup-log.d.ts's TextEncoder decision);
// row 87 needs decode() to normalize piped spawn output that arrives as Uint8Array.
declare class TextDecoder {
  decode(input?: Uint8Array): string
}

interface BunSpawnSyncOptions {
  /** "pipe" captures the stream. NOTE (measured on bun 1.3.14): piped stdout/stderr come
   *  back as Buffer (Uint8Array) REGARDLESS of any encoding option — callers normalize via
   *  asText()/TextDecoder, which is why no encoding flag is declared or trusted here. */
  readonly stdout?: "pipe" | "ignore"
  readonly stderr?: "pipe" | "ignore"
  /** Kill the child past this deadline (extraction + health probes are bounded). */
  readonly timeout?: number
  readonly cwd?: string
}

interface BunSpawnSyncOutput {
  readonly exitCode: number | null
  readonly stdout: string | Uint8Array
  readonly stderr: string | Uint8Array
  /** True when the timeout killed the child (exitCode is then null/nonzero). */
  readonly timedOut?: boolean
}

interface BunNamespace {
  /** Synchronous argv-array spawn. Row 87 uses it ONLY for (a) /usr/bin/tar UNPACKING a
   *  digest-verified tarball (unpacking is not executing the payload) and (b) the health
   *  gate `--version` on the private Node binary — the blueprint's own gate wording
   *  "node --version from the private path equals the pin" (02_structured.md:251).
   *  Never a shell, never a relative path, never PATH lookup. */
  spawnSync(command: readonly string[], options?: BunSpawnSyncOptions): BunSpawnSyncOutput
}
