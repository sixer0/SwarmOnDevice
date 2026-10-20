// Additive ambient declaration for the row-97 config writer (FIX round b). Interface-merge ONLY on
// the existing "node:fs" module augmentation (env.d.ts): adds lstatSync + Stats.isSymbolicLink so a
// symlinked config target can be refused before any read/write. No module is redeclared; every other
// member stays exactly as env.d.ts declares it. Same additive pattern as types/graft-step.d.ts.

declare module "node:fs" {
  interface Stats {
    isSymbolicLink(): boolean
  }
  export function lstatSync(path: string): Stats
}
