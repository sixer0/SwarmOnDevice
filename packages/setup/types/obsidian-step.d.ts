// Row-90 additive ambient declarations for the Obsidian guide-and-detect step. Same pattern as
// types/bun-net.d.ts (row 82), types/consent-tty.d.ts (row 83), types/setup-log.d.ts (row 84) and
// types/node-step.d.ts (row 87): module augmentation only ADDS members; nothing existing is
// redeclared or changed. Row 106 compiles against the full @types/bun catalog and these shims retire.
// Hermetic-toolchain rationale: env.d.ts header.
//
// Why rmdirSync: Bun 1.3.14's rmSync WITHOUT `recursive` cannot remove an existing DIRECTORY
// (measured: EFAULT errno -14 even on an empty dir), while a plain recursive rm would be exactly
// the wrong tool beside a possibly-still-mounted volume. rmdirSync is the precise primitive:
// it removes ONLY an empty directory and fails otherwise — which is precisely the safety property
// the mountpoint cleanup needs (a live mount keeps its mountpoint; nothing is ever swept recursively
// under it). Deliberately NO node:child_process declaration here either (r87 precedent, gate 3c).

declare module "node:fs" {
  /** Remove an EMPTY directory only; throws ENOTEMPTY/EBUSY-class errors on anything else.
   *  Used solely on this step's own private mountpoints under ~/.swarm/tmp (P-16 whitelist). */
  export function rmdirSync(path: string): void
}
