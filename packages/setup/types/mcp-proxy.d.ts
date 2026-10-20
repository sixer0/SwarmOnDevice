// Row-94 additive ambient declarations for the swarm-web MCP proxy + sanitiser/URL-policy
// library. Same pattern as types/bun-net.d.ts (row 82), consent-tty.d.ts (row 83),
// setup-log.d.ts (row 84), node-step.d.ts (row 87) and graft-step.d.ts (row 88): module
// augmentation / interface merge only ADDS members; nothing existing is redeclared or
// changed. Row 106 compiles against the full @types/bun catalog and these shims retire.
// Hermetic-toolchain rationale: env.d.ts header.

declare module "node:crypto" {
  /** CSPRNG bytes for the envelope nonce (§6.3 newNonce). Row 94's addition; randomUUID
   *  (env.d.ts) stays untouched — the nonce must be short hex, not a full UUID. */
  export function randomBytes(length: number): Uint8Array
}

declare module "node:fs" {
  /** Canonical path resolution for the vault-inbox confinement check (§7: realpath of the
   *  resolved target must carry the canonical inbox dir as a prefix). */
  export function realpathSync(path: string): string
}

// URL members row 94 adds on top of env.d.ts's class (interface + class merge, same
// technique bun-net.d.ts used for href/pathname): port for allow-list host:port matching.
interface URL {
  readonly port: string
}
