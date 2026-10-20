// Register constants used VERBATIM from masterplan/01c0_preinstall_register.md
// (REVISED r72-fix1) and frozen by reconciliation gate row 79. No value here is
// redefined; each carries its PC-* id and source line so a reader can trace it.
// The command verbs / flags are the class row 72 froze after gate R-3 ratified
// row 73's proposal (01c0 §12, PC-CMD-01..03 / PC-FLAG-01..03).

/** Class 1 — component ids (PC-CMP-01..07, 01c0:63-69). One id serves the state
 *  key, the ~/.swarm/tools/<id> dir name, and the io.gsp.swarm.component label. */
export const COMPONENT_IDS = [
  "runtime", // PC-CMP-01
  "node", // PC-CMP-02
  "graft", // PC-CMP-03
  "rtk", // PC-CMP-04, rtk-oss edition (B3)
  "obsidian", // PC-CMP-05
  "searxng", // PC-CMP-06
  "firecrawl", // PC-CMP-07
] as const

export type ComponentId = (typeof COMPONENT_IDS)[number]

export function isComponentId(value: string): value is ComponentId {
  return (COMPONENT_IDS as readonly string[]).includes(value)
}

/** Class 2 — lifecycle states (PC-ST-01..09, 01c0:79-87). PC-ST-09 is a terminal
 *  outcome token, not a per-component resting state in the normal chain. */
export const STATES = {
  ABSENT: "absent", // PC-ST-01
  DOWNLOADED: "downloaded", // PC-ST-02
  VERIFIED: "verified", // PC-ST-03
  INSTALLED: "installed", // PC-ST-04
  CONFIGURED: "configured", // PC-ST-05
  HEALTHY: "healthy", // PC-ST-06
  FAILED: "failed", // PC-ST-07
  SKIPPED: "skipped", // PC-ST-08
  BLOCKED_BY_NETWORK: "BLOCKED_BY_NETWORK", // PC-ST-09 (outcome token)
} as const

export type StateValue = (typeof STATES)[keyof typeof STATES]

const STATE_SET: ReadonlySet<string> = new Set(Object.values(STATES))

export function isStateValue(value: string): value is StateValue {
  return STATE_SET.has(value)
}

/** Class 3 — paths (PC-PATH-01..16, 01c0:98-113). `~` is expanded by paths.ts. */
export const PATHS = {
  SETUP_ROOT: "~/.swarm/setup", // PC-PATH-01 (0700)
  STATE: "~/.swarm/setup/state.json", // PC-PATH-02 (0600)
  CONSENT_LOG: "~/.swarm/setup/consent.log", // PC-PATH-03 (0600)
  LOCK_DIR: "~/.swarm/setup/lock", // PC-PATH-04 (0700)
  SETUP_LOG: "~/.swarm/setup/setup.log", // PC-PATH-05 (0600)
  TMP: "~/.swarm/tmp", // PC-PATH-06 (0700, never /tmp)
  TOOLS: "~/.swarm/tools", // PC-PATH-07 (0700)
  TOOL_DIR: "~/.swarm/tools/<component_id>", // PC-PATH-08 (0700)
  SECRETS_DIR: "~/.swarm/tools/<component_id>/secrets/", // PC-PATH-09 (dir 0700, files 0600)
  WEB_AUDIT_LOG: "~/.swarm/logs/web-audit.log", // PC-PATH-10 (0600)
  // PC-PATH-11 <setup_dir>/tools.lock.json (0444) is resolved relative to the
  // program directory, not under $HOME — see lockfile.ts.
  POLICY: "~/.swarm/setup/policy.json", // PC-PATH-16 (F-79-A path only; mechanism deferred from v1)
} as const

/** Directory modes mandated by the register (class 3 mode column). */
export const MODES = {
  DIR_0700: 0o700, // PC-PATH-01/04/06/07/08/09 dirs
  FILE_0600: 0o600, // PC-PATH-02/03/05/10 and secret files
  LOCK_SHIPPED_0444: 0o444, // PC-PATH-11 shipped read-only
} as const

/** Class 5 — docker labels (PC-LBL-01..03, 01c0:133-135). Namespace io.gsp.swarm.*
 *  is deliberately NOT the bundle-id root id.co.gsp.swarm (register CF-1). */
export const LABELS = {
  MANAGED_KEY: "io.gsp.swarm.managed", // value "true"
  MANAGED_VALUE: "true",
  COMPONENT_KEY: "io.gsp.swarm.component", // value = component id
  VERSION_KEY: "io.gsp.swarm.version", // value = tools.lock.json .version
} as const

/** Class 6 — compose project name (PC-PROJ-01, 01c0:141). */
export const COMPOSE_PROJECT = "swarm-tools"

/** Class 7 — Colima profile (PC-PROF-01) and docker context (PC-PROF-02).
 *  PC-PROF-01 profile name stays `swarm` (`colima start --profile swarm`).
 *  PC-PROF-02 was carried [H]="swarm" and is now CLOSED by live measurement: colima
 *  0.10.3 names the docker context for `--profile swarm` as `colima-swarm` (convention
 *  `colima-<profile>`), socket `unix://$HOME/.colima/swarm/docker.sock`. Evidence:
 *  implementation/s93_live_vm_smoke.md closure facts (finding H-R93-1); register amended
 *  by delegation_progress/data_analyst_r72.md FIX3 Amendment 1. The register is the single
 *  source of truth; every `--context <DOCKER_CONTEXT>` argv reads this constant.
 *  SEAM (not fixed here — other owners): r86 capture.ts `swarmContextPresent` compares the
 *  context name to COLIMA_PROFILE, and r91 stacklib `contextInspectArgs`/argv + their tests
 *  hardcode the old `swarm` literal; each is aligned by its own row, not duplicated here. */
export const COLIMA_PROFILE = "swarm" // PC-PROF-01 (unchanged)
export const DOCKER_CONTEXT = "colima-swarm" // PC-PROF-02 — corrected r72-fix3 / s93 (was [H] "swarm")

/** Class 10 — package file names (PC-PKG-01/02, 01c0:249-250). */
export const PROGRAM_NAME = "swarm-setup" // PC-PKG-01
export const LOCK_FILE_NAME = "tools.lock.json" // PC-PKG-02

/** Class 12 — command verbs + flags (PC-CMD-01..03, PC-FLAG-01..03, 01c0 §12).
 *  Frozen by row 72 after gate R-3 (10_preinstall_spec_review.md:163). */
export const VERBS = {
  INSTALL: "install", // PC-CMD-01
  STATUS: "status", // PC-CMD-02
  REMOVE: "remove", // PC-CMD-03
} as const

export const FLAGS = {
  NON_INTERACTIVE: "--non-interactive", // PC-FLAG-01
  TERMS_TOKEN: "--terms-token", // PC-FLAG-02  (--terms-token <component>=<value>)
  DRY_RUN: "--dry-run", // PC-FLAG-03
  HELP: "--help",
  REMOVE_ALIAS: "--remove", // PC-CMD-03 alias
} as const

/** State-file schema version (row-73 design field, 01c §4.2). Not a register constant. */
export const STATE_SCHEMA_VERSION = 1
