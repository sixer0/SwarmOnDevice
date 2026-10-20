// Vault wiring for the Obsidian inbox — row 95 (controller re-scope of blueprint ROW 95,
// `identification/02_structured.md:259`, to the REMAINDER of the vault/inbox surface after
// r94 landed the proxy tool itself under its merged 94+95 brief — see implementation/
// s94_mcp_proxy.md §0/§2 and implementation/s95_vault_wiring.md §1 for the coverage split).
// Contract = masterplan/01f_tool_wiring_spec.md §7 ("Obsidian inbox rule").
//
// WHAT THIS MODULE IS: the resolution + posture half of the wiring — where the vault lives
// (PC-ENV-06 override else PC-PATH-13 default), what a caller may conclude about its state
// (read-only status with guidance, NEVER a fabricated vault), how the user gets the vault
// open in Obsidian (r90's staged-app resolver consumed, never launched), and the single
// documented facts object row 98's skill text must cite. The write/list/read primitives
// live in ./writer.ts.
//
// WHAT THIS MODULE IS NOT: no MCP transport (that is mcpproxy/, r94's area — consumed here
// ONLY through its exported register constants), no scanned step directory (01c §9 restricts
// src/steps/ to the seven PC-CMP ids; same service-dir resolution as r94 §1, r84 §1, r85),
// no state.json coupling on purpose: vault notes are USER data and must survive
// `swarm-setup remove`, which sweeps only state-listed paths (s90 decision 3 lineage;
// PC-PATH-13 sits outside ~/.swarm/tools/ precisely so app removal cannot sweep notes —
// 01c0:110). No consent gate either: this is runtime wiring, not an install action; the
// agent-facing write is gated by the L1 `ask` rule (01f §4.2) and the researcher's allow
// (01f §5.1), which rows 96/97 wire from r94's exports.
//
// NO COMMUNITY-PLUGIN SURFACE (§7 row 3, P-12, 01c0:158-160): this module never references
// the Local REST API plugin's port, never installs or pre-seeds a plugin, never writes
// `.obsidian/` configuration. Access is filesystem-only. Proven by test/vault.proofs.sh
// gates G3/G4 (zero matches over this directory for the plugin port/name patterns and for
// any network primitive).

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { expandTilde } from "../paths.ts"
import type { LockFile } from "../lockfile.ts"
import { ENV_NAMES, VAULT_ROOT } from "../mcpproxy/register.ts" // consume r94's constant home; do not fork values
import { stagedAppPath, type StagedAppResult } from "../steps/obsidian/index.ts" // r90 handoff: "consume stagedAppPath() for the app location"

/** Where the vault lives, resolved once per call (no caching: env can change between calls
 *  of a long-lived consumer, and resolution is two string ops). */
export interface VaultPaths {
  /** Absolute (tilde-expanded) vault root = PC-PATH-13, or the PC-ENV-06 override. */
  readonly root: string
  /** Absolute `<root>/inbox` = PC-PATH-12 semantics under an overridden root. */
  readonly inbox: string
  /** Which source won: the SWARM_VAULT_DIR environment value, or the register default. */
  readonly source: "env" | "default"
}

/**
 * Resolve the vault location: `SWARM_VAULT_DIR` (= PC-ENV-06, 01c0:215) when set non-blank,
 * else the register default VAULT_ROOT (= PC-PATH-13 `~/.swarm/vault`, 01c0:110). Mirrors
 * r94's `inboxDirFromEnv` (mcpproxy/resolve.ts:55-58) but exposes the root and the winning
 * source too, because status/guidance consumers need both. Unification into one resolver is
 * proposed to row 106/97 (s95 report §handoffs); until then the two stay behaviourally equal
 * and the unit suite pins that (test/vault_wiring.test.ts "resolveVault").
 * A relative override resolves against the process cwd downstream (realpath); row 97 writes
 * absolute values into the config entry, so the normal posture never sees a relative path.
 */
export function resolveVault(env: Readonly<Record<string, string | undefined>> = process.env): VaultPaths {
  const raw = env[ENV_NAMES.VAULT_DIR]
  const fromEnv = raw !== undefined && raw.trim() !== ""
  const root = expandTilde(fromEnv ? (raw as string).trim() : VAULT_ROOT)
  return { root, inbox: join(root, "inbox"), source: fromEnv ? "env" : "default" }
}

/** Read-only view of vault state for guides, status lines and the absent-vault posture.
 *  Creates NOTHING — the first agent write creates the inbox (01f §7 write target is a
 *  Swarm-managed folder per P-12); fabricating vault content or `.obsidian/` config here
 *  would violate the guide-don't-fabricate posture the brief names. */
export interface VaultStatus {
  readonly paths: VaultPaths
  readonly vaultRootExists: boolean
  readonly inboxExists: boolean
  /** Count of `.md` files currently in the inbox; null when the inbox does not exist yet. */
  readonly noteCount: number | null
  /** Human-readable guidance lines (EN, no emoji). Always safe to print: contains paths,
   *  never secrets. */
  readonly guidance: readonly string[]
}

export function vaultStatus(env: Readonly<Record<string, string | undefined>> = process.env): VaultStatus {
  const paths = resolveVault(env)
  const vaultRootExists = existsSync(paths.root)
  const inboxExists = existsSync(paths.inbox)
  const noteCount = inboxExists ? readdirSync(paths.inbox).filter((n) => n.endsWith(".md")).length : null
  return { paths, vaultRootExists, inboxExists, noteCount, guidance: guidanceFor(paths, inboxExists, noteCount) }
}

function guidanceFor(paths: VaultPaths, inboxExists: boolean, noteCount: number | null): readonly string[] {
  const lines: string[] = []
  if (!inboxExists) {
    lines.push(
      `No vault at ${paths.root} yet. The first swarm-web_vault_inbox write creates the inbox folder ${paths.inbox} (mode 0700) — Swarm creates that folder and nothing else.`,
    )
  } else {
    lines.push(
      `Vault root ${paths.root}; the agent-writable inbox is ${paths.inbox} (${noteCount === null ? "0" : String(noteCount)} note(s) now).`,
    )
  }
  lines.push(
    `To read notes in Obsidian: launch Obsidian and choose "Open folder as vault", pointing it at ${paths.root}. The inbox folder appears in the sidebar.`,
  )
  lines.push(
    `Swarm never installs community plugins, never writes .obsidian/ configuration, and never talks to a local plugin HTTP endpoint; vault access is filesystem-only (01f §7, P-12).`,
  )
  return lines
}

/** Canonical system install location, stat-only. Deliberately NOT steps/obsidian's
 *  detectExistingInstall(): that runs `mdfind` (a process spawn) — fine inside the install
 *  step, wrong for a guidance helper that skills/status may call often. Layer-1 stat covers
 *  the canonical location; the Spotlight miss degrades to "absent", which only ever means
 *  the guide suggests installing, never that it launches anything. */
const SYSTEM_APP_PATH = "/Applications/Obsidian.app"

export interface ObsidianLaunchGuide {
  /** Absolute app path when one is available to the USER to open manually; null = none. */
  readonly appPath: string | null
  /** staged = r90's tamper-aware private copy; system = /Applications copy (stat only);
   *  absent = neither — the guide tells the user how to obtain the app. */
  readonly appSource: "staged" | "system" | "absent"
  readonly vaultRoot: string
  /** Ordered human-readable steps (EN, no emoji). Guidance data, never executed here. */
  readonly steps: readonly string[]
}

/**
 * How the user opens the vault in Obsidian — the integration point r90's handoff asked for
 * ("consume stagedAppPath() for the app location"). Returns PATHS AND TEXT ONLY: this module
 * never launches the app, never touches /Applications, never reads inside any bundle.
 */
export function obsidianLaunchGuide(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly lock?: LockFile
    readonly version?: string
    readonly installRoot?: string
  } = {},
): ObsidianLaunchGuide {
  const vaultRoot = resolveVault(options.env).root
  const staged: StagedAppResult = stagedAppPath({
    ...(options.lock ? { lock: options.lock } : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.installRoot ? { installRoot: options.installRoot } : {}),
  })
  if (staged.ok && staged.path !== undefined) {
    return {
      appPath: staged.path,
      appSource: "staged",
      vaultRoot,
      steps: [
        `Open the staged app: ${staged.path} (drag it to Applications or launch it from here).`,
        `In Obsidian choose "Open folder as vault" and select ${vaultRoot}.`,
      ],
    }
  }
  if (existsSync(SYSTEM_APP_PATH)) {
    return {
      appPath: SYSTEM_APP_PATH,
      appSource: "system",
      vaultRoot,
      steps: [
        `Open Obsidian from ${SYSTEM_APP_PATH}.`,
        `In Obsidian choose "Open folder as vault" and select ${vaultRoot}.`,
      ],
    }
  }
  return {
    appPath: null,
    appSource: "absent",
    vaultRoot,
    steps: [
      "Obsidian is not installed on this machine.",
      "Either run swarm-setup install and consent to the obsidian component (a private copy is staged under ~/.swarm/tools/obsidian/, never auto-launched), or install Obsidian yourself from its official site — PT GSP does not distribute it (L14, 03f §3).",
      `Either way, notes are already plain markdown under ${join(vaultRoot, "inbox")} and will appear once Obsidian opens ${vaultRoot} as a vault.`,
    ],
  }
}
