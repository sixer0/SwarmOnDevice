/**
 * Swarm twin (row 29) of the clone's `scripts/studio/_repo-alias.ts` (studio spec §1.3, prereview L3,
 * packaging spec A.1 line 372).
 *
 * The clone wrapped `Module._resolveFilename` process-wide so `tsx` CLIs could resolve `@/x`, and
 * derived `REPO_ROOT` from `__dirname` or `process.cwd()`. In Swarm the alias is resolved at build
 * time (tsconfig `paths`, electron-vite), so the hook is gone, and nothing is derived from cwd or
 * from the module's own location (that would point into `app.asar`).
 *
 * `REPO_ROOT` is the folder that holds the vendor files read by path at run time
 * (`docs/STUDIO-AGENT-GUIDE.md`, resources.ts): packaged `Res/datum-studio/`, dev
 * `packages/datum-studio/vendor/`. The host sets it as the absolute env `STUDIO_VENDOR_ROOT`.
 * Missing or relative -> {@link REPO_ROOT_UNSET} (`/var/empty`, the empty root-owned macOS folder),
 * so a read finds nothing instead of reading from cwd (fail closed).
 */
import path from "node:path";

export const STUDIO_VENDOR_ROOT_ENV = "STUDIO_VENDOR_ROOT";
/** Fail-closed value when STUDIO_VENDOR_ROOT is missing or relative. */
export const REPO_ROOT_UNSET = "/var/empty";

/** Absolute vendor root from `env`, or {@link REPO_ROOT_UNSET}. Never resolved against cwd. */
export function resolveRepoRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = env[STUDIO_VENDOR_ROOT_ENV]?.trim() ?? "";
  if (raw === "" || raw.includes("\u0000") || !path.isAbsolute(raw)) return REPO_ROOT_UNSET;
  return path.resolve(raw);
}

/** Akar repo = Studio vendor root (read at import; the host sets the env before forking). */
export const REPO_ROOT = resolveRepoRoot();
