// Register constants for the swarm-web proxy surface (row 94). These class-3/8/9/10 values
// are NOT yet in src/constants.ts (row 81's file, frozen before the 01f rows landed), so this
// module is their single local home inside packages/setup until row 97 promotes them there.
// Every value is copied VERBATIM from masterplan/01c0_preinstall_register.md (REVISED
// r72-fix1..fix3) with its id + source line; nothing here redefines a register value.

/** PC-MCP-02 server name (01c0:242). The composed tool names the permission baseline gates
 *  are `<server>_<tool>` per mcp/catalog.ts sanitize (keeps `-` and `_`, 01f §4.2). */
export const MCP_SERVER_NAME = "swarm-web"

/** PC-PATH-13 vault root (01c0:110) — deliberately outside ~/.swarm/tools/obsidian so app
 *  removal can never sweep user notes. */
export const VAULT_ROOT = "~/.swarm/vault"

/** PC-PATH-12 inbox folder (01c0:109) — the ONLY folder the agent may write inside the vault. */
export const VAULT_INBOX = "~/.swarm/vault/inbox"

/** PC-PATH-14 absolute proxy binary path (01c0:111): inside the setup state root (P-16
 *  whitelist), NOT ~/.swarm/bin (owned by 01a C10). Row 97 stages it from PC-PKG-06. */
export const PROXY_BINARY_PATH = "~/.swarm/setup/bin/swarm-web-proxy"

/** PC-PKG-06 binary name (01c0:267), staged into the CLI archive by row 48, copied by row 97. */
export const PROXY_BINARY_NAME = "swarm-web-proxy"

/** Environment variable NAMES (PC-ENV-*, 01c0:210-215). Values come from the parent process
 *  (the MCP config entry, row 97); nothing here hardcodes a URL, port or secret value. */
export const ENV_NAMES = {
  SEARXNG_URL: "SWARM_SEARXNG_URL", // PC-ENV-01 (01c0:210) — loopback base for SearXNG JSON queries
  FIRECRAWL_URL: "SWARM_FIRECRAWL_URL", // PC-ENV-02 (01c0:211) — Firecrawl auth-proxy base
  FIRECRAWL_TOKEN: "SWARM_FIRECRAWL_TOKEN", // PC-ENV-03 (01c0:212) — bearer; NEVER argv, NEVER logged (P-8)
  AUDIT_LOG: "SWARM_WEB_AUDIT_LOG", // PC-ENV-04 (01c0:213) — defaults to PC-PATH-10 when unset
  VAULT_DIR: "SWARM_VAULT_DIR", // PC-ENV-06 (01c0:215) — = PC-PATH-13; read instead of hardcoded
} as const

/** Per-server MCP startup timeout the proxy's config entry carries (01f §6.1 entry shape;
 *  milliseconds — deliberately NOT derived from any port constant). */
export const MCP_STARTUP_TIMEOUT_MS = 30000
