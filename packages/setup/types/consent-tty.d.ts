// Row-83 additive ambient declarations for the interactive consent reader ONLY.
// Same pattern row 82 established in bun-net.d.ts: interface/module augmentation
// merges with types/env.d.ts (row 81's); nothing existing is redeclared or changed.
// Row 106 compiles against the full @types/bun catalog and these shims retire.

declare module "node:fs" {
  /** Synchronous line-oriented read from fd 0 (a TTY in canonical mode returns
   *  whole lines). Used ONLY by the interactive consent prompt reader. */
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number): number
}

interface SwarmReadStream {
  readonly isTTY?: boolean
}

// Interface merge with env.d.ts's SwarmProcess: adds stdin, changes nothing else.
interface SwarmProcess {
  stdin: SwarmReadStream
}
