// Per-run isolation of the source-posture tools.lock.json (row 100 fix round 13).
//
// The problem this replaces: every lock-staging suite used to copy `tools.lock.json` into
// `packages/setup/src/tools.lock.json`, one fixed path shared by the whole package. Two suites running
// at the same time then raced — the second saw the file present, skipped staging, and the first's
// `afterAll` deleted it underneath the still-running sibling (`ENOENT`, reproduced as 2 reds in 8 runs
// of `consent.test.ts` by row seam4, recorded in
// `docs/2026-10-19_opencode_swarm_rebrand/delegation_progress/coder_execution_seam4.md` §5). The same
// shared path is what let a crashed run leave the stale copy behind that row 106b had to clean up.
//
// Why a copy in `src/` was needed at all: `resolveProgramDir()` (src/paths.ts:74-81) uses
// `dirname(process.execPath)` when a lock sits beside the executable and otherwise falls back to
// `import.meta.dir`, which under `bun test` is `src/`. `src/composefiles/index.ts:177-181` mirrors the
// same rule. Neither reads an environment variable, and source files are outside this row's scope, so
// the harness has to move the executable pointer instead.
//
// What this does instead: build a private program directory per suite run — a `mkdtemp` holding a copy
// of the shipped lock plus a symlink to the real bun binary named like it — and point
// `process.execPath` at that symlink for the duration of the file. `resolveProgramDir()` now finds the
// lock beside "the executable" and returns the private directory, so each concurrent suite reads its
// own byte-identical copy and nothing is ever written inside `packages/setup`. The symlink keeps
// `process.execPath` a working interpreter for anything that spawns it, and the returned release
// function restores the original value and deletes the directory.

import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

const SHIPPED_LOCK = join(import.meta.dir, "..", "tools.lock.json")

/** Point this process at a private program directory holding the shipped lock. Returns the release. */
export function isolateSourceLock(): () => void {
  const realExecPath = process.execPath
  const dir = mkdtempSync(join(tmpdir(), "swarm-setup-prog-"))
  copyFileSync(SHIPPED_LOCK, join(dir, "tools.lock.json"))
  const programExec = join(dir, basename(realExecPath))
  symlinkSync(realExecPath, programExec)
  Object.defineProperty(process, "execPath", { value: programExec, configurable: true })

  return () => {
    Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true })
    rmSync(dir, { recursive: true, force: true })
  }
}
