// Row 120 (spec 113 S1, register R2.1/R2.2): which stage checks prebuild runs, chosen by the build target, not the host.
// SWARM_BUILD_TARGET unset or empty means darwin-arm64, so a macOS build runs exactly the checks it ran before.

export const BUILD_TARGETS = ["darwin-arm64", "linux-x64", "win32-x64"] as const
export type BuildTarget = (typeof BUILD_TARGETS)[number]

export function buildTarget(env: Record<string, string | undefined> = process.env): BuildTarget {
  const raw = env.SWARM_BUILD_TARGET
  if (raw === undefined || raw === "") return "darwin-arm64"
  const hit = BUILD_TARGETS.find((id) => id === raw)
  if (!hit) throw new Error(`SWARM_BUILD_TARGET must be one of ${BUILD_TARGETS.join(", ")} (got ${JSON.stringify(raw)})`)
  return hit
}

export type PrebuildChecks = { setup: boolean; cli: boolean; datum: boolean }

// check-setup-stage covers resources/swarm-setup, a darwin-arm64-only slot that linux and win32 do not ship (R5.11).
export function prebuildChecks(target: BuildTarget): PrebuildChecks {
  return { setup: target === "darwin-arm64", cli: true, datum: true }
}
