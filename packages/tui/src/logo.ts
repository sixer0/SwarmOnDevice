// The SWARM bit-block wordmark, split into `SWA` | `RM` and stitched by the renderer with one
// space. 26 columns since row 241c: W and M each need a centre column or they read V and N
// (docs/2026-10-19_opencode_swarm_rebrand/research/s6_r241b_wordmark_legibility.md §2). Kept in
// lockstep with packages/ui/src/components/logo.tsx by packages/ui/test/wordmark-glyph.test.ts.
export const logo = {
  left: ["████ █   █  ██ ", "█    █   █ █  █", "████ █ █ █ ████", "   █ ██ ██ █  █", "████ ██ ██ █  █"],
  right: ["████ █   █", "█  █ ██ ██", "███  █ █ █", "█ ██ █   █", "█  █ █   █"],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
