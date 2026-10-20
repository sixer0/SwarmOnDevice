type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// Desktop updates are off for Swarm (decision 5 / E8): no update server exists and
// the builder config carries no publish feed. The updater menu item stays visible
// but disabled through this flag (menu.ts).
export const UPDATER_ENABLED = false
