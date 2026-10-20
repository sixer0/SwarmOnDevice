export function hasExistingAppState(entries: Array<{ name: string; isDirectory: () => boolean }>) {
  return entries.some((entry) => {
    if (entry.name === "opencode.settings") return true
    if (entry.name.endsWith(".dat")) return true
    if (/^window-state-.+\.json$/.test(entry.name)) return true
    // App-dir segment of the sidecar's state tree; must match the `app` literal in
    // packages/core/src/global.ts, which names the directory the CLI writes here.
    return entry.isDirectory() && entry.name === "swarm"
  })
}
