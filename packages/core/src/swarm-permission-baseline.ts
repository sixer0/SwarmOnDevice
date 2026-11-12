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

// S-02 (1.2.6 row 56b, register N-100): the datum-studio tools the planner and
// document-writer subagents may call without a prompt. A subagent cannot answer an
// "ask" (nobody watches its session), so before this list a Studio call from them
// stopped on an unanswerable prompt. Composed tool names are
// sanitize("datum-studio") + "_" + tool (mcp/catalog.ts); the server name is spelled
// out here because this module imports nothing (DATUM_STUDIO_MCP lives in opencode).
// Deliberately absent:
// - studio_mission_answer_decision: the person's answer only; agent.ts merges a final
//   deny on it into every agent (ANSWER_DECISION_TOOL, row 198 / E-37).
// - studio_asset_put: main agent only (decision C7; a subagent references a sha the
//   main agent uploaded).
// - every other write tool (document_create, slot_fill, render, write, edit,
//   report_*, mission writes) keeps the baseline "ask".
// studio_file_verify is kept per C9: its only file effect is the optional downloadDir,
// which vendor mcp/safety.ts resolveAllowedPath confines to STUDIO_MCP_FILE_ROOTS, and
// the host sets that to the one session root (mcp-host/start.ts:147, file-root.ts).
// Binding the list to the built-in datum-studio server only (SEC-13) is row 56's.
export const STUDIO_SUBAGENT_TOOLS = [
  "datum-studio_studio_figure_preview",
  "datum-studio_studio_figure_revise",
  "datum-studio_studio_document_get",
  "datum-studio_studio_document_status",
  "datum-studio_studio_document_structure",
  "datum-studio_studio_search",
  "datum-studio_studio_contracts_query",
  "datum-studio_studio_templates_list",
  "datum-studio_studio_template_get",
  "datum-studio_studio_registry",
  "datum-studio_studio_file_verify",
  "datum-studio_studio_mission_get",
  "datum-studio_studio_mission_list",
] as const satisfies readonly string[]

// Only targeted allows, never a "*": agent.ts merges config agent.<name>.permission
// after the specialist() denies and the baseline "*": "ask", so these keys win by
// findLast while everything else keeps its existing decision.
const studioSubagentPermission = Object.fromEntries(STUDIO_SUBAGENT_TOOLS.map((tool) => [tool, "allow"])) as Record<
  (typeof STUDIO_SUBAGENT_TOOLS)[number],
  "allow"
>

export const AGENT_BASELINE = {
  researcher: RESEARCHER_AGENT,
  planner: { permission: studioSubagentPermission },
  "document-writer": { permission: studioSubagentPermission },
} as const

// experimental.mcp_timeout: 01f §12 proposed shipping it once row 96 verifies the key
// exists in this version. Verified: ConfigV1.Info declares `mcp_timeout:
// Schema.optional(PositiveInt)` inside `experimental` in packages/core/src/v1/config/config.ts:
//   config.ts:199 mcp_timeout
//   config.ts:186 experimental
// and mcp/index.ts reads cfg.experimental?.mcp_timeout globally.
// 1.2.6 CFG-02 (decision U1): 600000, above the 540000 studio_render call limit, so a
// long render is not cut by the MCP request timeout. A server entry with its own
// `timeout` (the installer writes 30000) keeps it; a user's experimental.mcp_timeout
// overrides this baseline through the config merge. A dead swarm-web server then costs
// the bounded per-server timeout of its own entry, not a stalled session (01f §5.2).
export const SWARM_PERMISSION_BASELINE = {
  permission: PERMISSION_BASELINE,
  agent: AGENT_BASELINE,
  experimental: { mcp_timeout: 600000 },
} as const
