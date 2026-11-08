// Row 128: swarm-setup is bundled only in the macOS app; the Linux and Windows packages leave it out
// (spec X1, register R5.11). The renderer therefore offers the `setupTools` capability only on macOS. Without it the
// app renders neither the first-run tools offer nor the `tools.install` command, so nobody on Linux or Windows is
// sent to a binary that is not there. On macOS the capability is passed through unchanged.
export function setupToolsFor<T>(os: "macos" | "windows" | "linux" | undefined, api: T): T | undefined {
  return os === "macos" ? api : undefined
}
