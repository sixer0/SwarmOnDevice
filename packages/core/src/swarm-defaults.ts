import os from "os"
import path from "path"
import { SWARM_PERMISSION_BASELINE } from "./swarm-permission-baseline"

// Swarm defaults shim (WP-01, blueprint row 36). This module has side effects
// only: importing it mutates process.env, and it never opens a network socket and
// never writes to the filesystem. Row 42 wires it as the FIRST import of the CLI
// entry and the Electron main process so the values below are set before
// packages/core/src/flag/flag.ts reads them at module load (flag.ts:21-47). Until
// that wiring lands, nothing in the shipped tree imports this file.

// Baseline config values (FR-DEF-04). These are the lowest-precedence layer: user
// and project config files override them. The merge hook that consumes this object
// lives in packages/opencode/src/config/config.ts and is owned by WP-EGRESS-CFG
// (row 41); this module only publishes the values, it does not install them.
// The permission baseline and researcher agent (row 96, 01f §4.2/§5.1) ride this
// same object on purpose: config.ts seeds loadInstanceState with it, so they merge
// at-or-after the baseline slot exactly as s41 §5 requires — overridable by every
// later source, yet ahead of the built-in agent defaults because agent.ts appends
// the merged config permission block after its own defaults (agent.ts:145-152).
//
// permission/agent/experimental are GETTERS returning fresh deep copies, not shared
// constants. Measured on this tree's remeda: mergeDeep assigns a source sub-object BY
// REFERENCE whenever the target lacks that key (test/permission/baseline.test.ts pins
// it), and config.ts seeds with mergeDeep({}, {...BASELINE_CONFIG}) — so one shared
// literal would let any in-place write on a resolved config corrupt the shipped
// constants for every later instance. The top-level spread at config.ts:318 invokes
// each getter once per load, so every instance owns its copy. Same defensive posture
// as the disabled_providers array copy at that call site. The payload is pure JSON
// data, hence the JSON round-trip clone (no structuredClone availability question).
function cloneBaseline<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export const BASELINE_CONFIG = {
  autoupdate: false,
  share: "disabled",
  disabled_providers: ["opencode", "opencode-go"],
  get permission() {
    return cloneBaseline(SWARM_PERMISSION_BASELINE.permission)
  },
  get agent() {
    return cloneBaseline(SWARM_PERMISSION_BASELINE.agent)
  },
  get experimental() {
    return cloneBaseline(SWARM_PERMISSION_BASELINE.experimental)
  },
}

// Path and credential redirect guard G3 (FR-DEF-06). When one of these variables
// resolves inside an OpenCode location, Swarm drops it so it can never read an
// OpenCode config or data path, even if the value was inherited from a child
// process. The decision is made on the resolved path, not on who set the variable.
const GUARDED_VARS = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_TUI_CONFIG",
  "OPENCODE_DB",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_PLUGIN_META_FILE",
] as const

type Roots = { home: string; tmp: string }

function defaultRoots(): Roots {
  return { home: os.homedir(), tmp: os.tmpdir() }
}

// Expand the tokens a caller is likely to write for a home or temp location. Only
// a leading ~, $HOME/${HOME} or $TMPDIR/${TMPDIR} is expanded; anything else is
// left for resolveLocation to make absolute against the current directory.
function expandToken(value: string, roots: Roots): string {
  if (value === "~") return roots.home
  if (value === "$HOME" || value === "${HOME}") return roots.home
  if (value.startsWith("~/")) return path.join(roots.home, value.slice(2))
  if (value.startsWith("$HOME/")) return path.join(roots.home, value.slice(6))
  if (value.startsWith("${HOME}/")) return path.join(roots.home, value.slice(8))
  if (value.startsWith("$TMPDIR/")) return path.join(roots.tmp, value.slice(8))
  if (value.startsWith("${TMPDIR}/")) return path.join(roots.tmp, value.slice(10))
  return value
}

function resolveLocation(value: string, roots: Roots): string {
  const expanded = expandToken(value, roots)
  if (path.isAbsolute(expanded)) return path.normalize(expanded)
  return path.normalize(path.resolve(expanded))
}

// True when target equals an OpenCode location from register 6.1 or sits under one.
function liesInOpencodeLocation(target: string, roots: Roots): boolean {
  const dirs = [
    path.join(roots.home, ".config", "opencode"),
    path.join(roots.home, ".local", "share", "opencode"),
    path.join(roots.home, ".cache", "opencode"),
    path.join(roots.home, ".local", "state", "opencode"),
    path.join(roots.tmp, "opencode"),
    path.join(roots.home, ".opencode"),
    "/Library/Application Support/opencode",
  ]
  for (const dir of dirs) {
    if (target === dir) return true
    if (target.startsWith(dir + path.sep)) return true
  }
  // Desktop userData: ~/Library/Application Support/ai.opencode.desktop[.beta|.dev].
  // A plain prefix match covers every channel suffix, which is why there is no
  // trailing separator here.
  const desktop = path.join(roots.home, "Library", "Application Support", "ai.opencode.desktop")
  return target.startsWith(desktop)
}

// Apply every shim effect to the given environment object. The operation is
// idempotent: running it twice over the same object leaves it unchanged, which is
// what makes a second import of this module safe. roots is injectable so the unit
// test can assert the G3 containment logic without depending on the machine's real
// home or temp directory.
export function applySwarmDefaults(env: NodeJS.ProcessEnv = process.env, roots: Roots = defaultRoots()): void {
  // Egress-off defaults (FR-DEF-03). ??= keeps any value a user or a managed
  // profile already set, per ND-5 default E1 ("overridable").
  env.OPENCODE_DISABLE_AUTOUPDATE ??= "1"
  env.OPENCODE_DISABLE_MODELS_FETCH ??= "1"
  env.OPENCODE_DISABLE_LSP_DOWNLOAD ??= "1"

  // Alias mirror (FR-DEF-05): every SWARM_<X> is copied to OPENCODE_<X>. It runs
  // after the ??= defaults, so SWARM_* wins when both a SWARM_* and its OPENCODE_*
  // twin are set, while an OPENCODE_* set alone is left untouched (the desktop
  // sidecar sets OPENCODE_SERVER_PASSWORD itself, sidecar.ts:85). The Tier 1 names
  // SWARM_SERVER_PASSWORD and SWARM_SERVER_USERNAME are covered by this same loop.
  for (const key of Object.keys(env)) {
    if (!key.startsWith("SWARM_") || key.length <= "SWARM_".length) continue
    env["OPENCODE_" + key.slice("SWARM_".length)] = env[key]
  }

  // Guard G3 runs last so it also catches an OPENCODE_* value the mirror just
  // copied from a SWARM_* alias that pointed into an OpenCode location.
  for (const name of GUARDED_VARS) {
    const value = env[name]
    if (value === undefined) continue
    if (liesInOpencodeLocation(resolveLocation(value, roots), roots)) delete env[name]
  }

  // Child-process marker (FR-DEF-07): SWARM=1 beside the upstream OPENCODE=1 that
  // the CLI entry sets (index.ts:75-77), so plugins and shell integrations can
  // detect a Swarm-spawned process. Unconditional and therefore idempotent.
  env.SWARM = "1"
}

applySwarmDefaults()
