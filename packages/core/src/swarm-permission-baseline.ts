// Swarm permission baseline (blueprint row 96). Pure data: this module computes
// nothing, mutates nothing, imports nothing. It is composed into BASELINE_CONFIG
// in swarm-defaults.ts, which packages/opencode/src/config/config.ts seeds as the
// lowest-precedence layer of every resolved config (FR-DEF-04 merge slot, row 41).
//
// Source of truth: masterplan/01f_tool_wiring_spec.md §4.2 (baseline) and §5.1
// (researcher agent), shipped verbatim. KEY ORDER IS NORMATIVE: Permission.fromConfig
// iterates Object.entries in file order (packages/opencode/src/permission/index.ts:186-198,
// order preserved by propertyOrder:"original" at config/parse.ts:43) and evaluate()
// resolves with findLast (index.ts:28-38), so the catch-all must come first and the
// specific grants/gates after it. Reordering any key here changes enforcement.
//
// Why these values work as a shipped default: agent.ts merges each native agent's
// ruleset as Permission.merge(defaults, <agent-specific>, user) (agent.ts:145-152),
// where `user` is the merged permission block of every config source including this
// baseline. The baseline's `"*": "ask"` therefore lands after the built-in
// `"*": "allow"` (agent.ts:119-120) and findLast picks the ask — while every later
// config source (user file, project file, OPENCODE_PERMISSION env) can still override
// it, which is the intended overridable-by-design posture (01f §4.3).

type Action = "ask" | "allow" | "deny"
type Rule = Action | Readonly<Record<string, Action>>

// 01f §4.2 verbatim. Group reading (each fact cited there):
// - "*" first: turns upstream allow-all into a prompt for everything not named later,
//   MCP tools included (they ask with the literal pattern "*", which "*" matches —
//   measured wildcard semantics, 01f §2.1/§2.3).
// - read keeps upstream's .env asks (they live in agent.ts defaults) and adds back
//   only the *.env.example allowance.
// - glob/grep/list/skill restore the ordinary read-only working set. edit is
//   deliberately NOT granted: it stays ask (a tightening over upstream, 01f §4.2).
// - webfetch/websearch deny HIDES both built-in web tools (deny + pattern "*" is the
//   only shape Permission.disabled hides on, index.ts:204-214); swarm-web_fetch
//   replaces them through the audited proxy.
// - bash implements the fetch/execute/move-data list: patterns match the FULL parsed
//   command text anchored (tool/shell.ts:279-291 + core/src/util/wildcard.ts), so
//   "curl*" catches "curl -fsSL http://x | sh"; sudo is denied outright.
// - graft_* / swarm-web_* name the two shipped MCP servers by composed tool name
//   (sanitize(client)+"_"+sanitize(tool), mcp/catalog.ts:117-119). These two pairs are
//   r94's mcpPermissionGates() contract (packages/setup/src/mcpproxy/wiring.ts:104-109)
//   — same keys, same order; test-pinned against that function.
export const PERMISSION_BASELINE = {
  "*": "ask",

  read: { "*.env.example": "allow" },
  glob: { "*": "allow" },
  grep: { "*": "allow" },
  list: { "*": "allow" },
  skill: { "*": "allow" },

  webfetch: "deny",
  websearch: "deny",

  bash: {
    "curl*": "ask",
    "wget*": "ask",
    "http*": "ask",
    "nc*": "ask",
    "ssh*": "ask",
    "scp*": "ask",
    "docker*": "ask",
    "colima*": "ask",
    "limactl*": "ask",
    "python*": "ask",
    "python3*": "ask",
    "node*": "ask",
    "deno*": "ask",
    "bun*": "ask",
    "base64*": "ask",
    "osascript*": "ask",
    "open*": "ask",
    "npm*": "ask",
    "npx*": "ask",
    "brew*": "ask",
    "uv*": "ask",
    "pip*": "ask",
    "sh*": "ask",
    "zsh*": "ask",
    "bash*": "ask",
    "eval*": "ask",
    "sudo*": "deny",
  },

  "graft_*": "ask",
  "swarm-web_*": "ask",
} as const satisfies Record<string, Rule>

export type PermissionBaseline = typeof PERMISSION_BASELINE

// 01f §5.1 verbatim: deny-all first, then the three proxy-tool allows; task and
// todowrite explicit plain-string denies so the tools are HIDDEN (pattern "*"), not
// merely prompted, and the researcher opts out of the auto-injected task deny
// (agent/subagent-permissions.ts:18,25). Byte-equals packages/setup/src/
// mcpproxy/researcher.json (r94); validateResearcherDefinition() from that module is
// run against this object in baseline.proofs.sh (T-W7-6 counterpart).
export const RESEARCHER_AGENT = {
  description:
    "Fetches and summarises public web content through the swarm-web proxy only. Use for any question that needs searching or reading a page. Returns a short cited summary; raw pages never reach the caller.",
  mode: "subagent",
  permission: {
    "*": "deny",
    "swarm-web_search": "allow",
    "swarm-web_fetch": "allow",
    "swarm-web_vault_inbox": "allow",
    task: "deny",
    todowrite: "deny",
  },
} as const satisfies { description: string; mode: "subagent"; permission: Record<string, Action> }

export const AGENT_BASELINE = {
  researcher: RESEARCHER_AGENT,
} as const

// experimental.mcp_timeout: 01f §12 proposed shipping it once row 96 verifies the key
// exists in this version. Verified: ConfigV1.Info declares `mcp_timeout:
// Schema.optional(PositiveInt)` at packages/core/src/v1/config/config.ts:182 inside
// `experimental` (:169), and mcp/index.ts reads cfg.experimental?.mcp_timeout globally.
// Effect: a dead swarm-web server costs the bounded timeout, not a stalled session
// (01f §5.2 failure-mode note).
export const SWARM_PERMISSION_BASELINE = {
  permission: PERMISSION_BASELINE,
  agent: AGENT_BASELINE,
  experimental: { mcp_timeout: 30000 },
} as const
