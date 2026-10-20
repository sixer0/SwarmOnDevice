// Additive ambient declarations for the row-84 redacting setup.log writer. This
// file is NEW and deliberately separate from types/env.d.ts (row 81), types/bun-net.d.ts
// (row 82) and types/consent-tty.d.ts (row 83): module augmentation only ADDS members,
// nothing existing is redeclared or changed. Same hermetic-toolchain rationale as those
// files (no @types/node/@types/bun in this checkout; `bun install` is a red line; row 106
// builds against the full catalog). Row 84 touches exactly two builtins that the earlier
// shims did not declare: a log file's SIZE (for the size cap + rotation) and UTF-8 text
// encoding for a durable append.

declare module "node:fs" {
  // Row 84's addition to node:fs Stats: the byte size of a file, used by setuplog.ts to
  // enforce the rotation size cap. Interfaces merge across ambient declarations, so this
  // joins env.d.ts's Stats { isDirectory, isFile, mode } without touching it.
  export interface Stats {
    readonly size: number
  }
}

// Bun exposes TextEncoder globally; it is not in the ES2022 lib this tsconfig selects.
// Only encode() is used (line -> bytes for a single fsync'd append). Mirrors the builtin.
declare class TextEncoder {
  encode(input?: string): Uint8Array
}
