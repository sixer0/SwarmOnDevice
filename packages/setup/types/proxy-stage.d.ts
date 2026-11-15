// Additive ambient declaration for the 1.3.0 row 132a proxy refresh gate (proxy_stage.ts, folded F3).
// NEW and separate from types/env.d.ts and types/setup-log.d.ts: module augmentation only ADDS a member,
// nothing existing is redeclared. Same hermetic-toolchain rationale as those files (no @types/node here).
// The gate checks that each parent of PC-PATH-14 is owned by the current uid.

declare module "node:fs" {
  export interface Stats {
    readonly uid: number
  }
}
