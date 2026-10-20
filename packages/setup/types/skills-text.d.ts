// Additive ambient declarations for src/skills/ (row 98) — same pattern rows 82/83/84/87/88/94 used:
// a NEW file per row, never an edit to types/env.d.ts. The monorepo checkout carries no @types/bun,
// and gen_cli.ts reads Bun's `import.meta.main` flag to decide whether it was invoked directly.

interface ImportMeta {
  /** True when this module is the entry point Bun was started with. */
  readonly main: boolean
}
