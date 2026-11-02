// Machine-global observations behind `GET /global/setup` (masterplan/04_s6_status_spec.md §4).
//
// Two files are read here, both owned by packages/setup: the component record at
// ~/.swarm/setup/state.json (PC-PATH-02) and the registration file the setup writes into the
// product's own global config directory (~/.config/swarm/swarm.json plus the five skill texts).
//
// This module deliberately does NOT import @swarm/setup. Row 194 C-207-i (research/s6_04_route_impact.md §5.1)
// keeps the runtime edge `packages/opencode -> packages/setup` from existing, because swarm/AGENTS.md directs
// dependencies from Schema/Core/Protocol toward Server only. The two facts the card needs from the writer —
// "the file was not there" versus "the file could not be read", and the verbatim failure text — are reproduced
// here by mirroring readState()'s branches (packages/setup/src/state.ts:105-126) rather than by importing them.
//
// Payload minimisation is a security rule, not tidiness. The record carries absolute install paths, docker
// object ids, backup paths and digests (packages/setup/src/state.ts:28-37). Publishing those would disclose
// the home directory — therefore the username — plus a map of what could be destroyed, to every process that
// can reach the port; the file's own mode 0600 does not stop a reader that goes through HTTP instead of open()
// (research/s6_04_route_impact.md §2). So this module reads the JSON and returns ONLY the fields below.
// `paths`, `dockerObjects`, `backups`, `lockVersion`, `version` and `integrity` are never copied out.

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import os from "os"
import { InstalledTools } from "@/session/installed-tools"

/** Register vocabulary PC-CMP-01..07. The one opencode copy lives in session/installed-tools.ts, with its drift
 *  test against packages/setup/src/constants.ts (senior review 239 finding 6). All seven keys are always
 *  published so the card renders one row per component even when the record names none of them. */
export const SETUP_COMPONENT_IDS = InstalledTools.COMPONENT_IDS

export type SetupComponentId = InstalledTools.ComponentId

/** The five texts the writer installs (TEXT_TARGETS, packages/setup/src/skills/researcher_text.ts:70-76). */
export const SETUP_SKILL_PATHS = [
  "agent/researcher.md",
  "skills/swarm-research/SKILL.md",
  "skills/graft/SKILL.md",
  "skills/rtk/SKILL.md",
  "skills/obsidian-inbox/SKILL.md",
] as const

export interface StateFileObservation {
  path: string
  /** false only on the existsSync branch, so "never set up" stays distinguishable from "cannot read" (§4). */
  present: boolean
  /** true when the parsed record carried no top-level `updatedAt` string; omitted when nothing was ever parsed.
   *  normalise() fills a missing timestamp with now() (state.ts:94), and this flag is how the card learns that
   *  any age it might infer is fabricated. Absent means "we never got far enough to know". */
  updatedAtAbsent?: boolean
  /** Verbatim read/parse failure, mirroring the three ok:false branches of readState (state.ts:114/:120/:123). */
  error?: string
}

export interface ComponentObservation {
  /** Verbatim PC-ST-* string. Never defaulted: normalise() already coerces a missing state to `absent`
   *  (state.ts:76, :88) and repeating that here would turn "field missing" into a positive claim of absence
   *  (§4 rule 2). A component with no recorded state publishes no `state` key, which the card must render
   *  as unknown, not as absent. */
  state?: string
  installedBySwarm?: boolean
}

export interface ConfigFileObservation {
  path: string
  present: boolean
  parseError?: string
  /** Key presence under `mcp` in the parsed object. Both false when the file is absent or unparseable —
   *  E16 pairs that falsity with the verbatim parseError rather than inventing a third value. */
  entries: { graft: boolean; swarmWeb: boolean }
}

export interface RegistrationObservation {
  /** Names the resolver that produced configDirPath, so a reviewer can check it against Global.Path.config
   *  (packages/core/src/global.ts:13). See observeRegistration() for why that path is passed in. */
  reader: "xdg-config"
  configDirPath: string
  configFile: ConfigFileObservation
  skills: Array<{ relPath: string; present: boolean }>
}

export interface SetupObservation {
  observedAt: string
  stateFile: StateFileObservation
  components: Record<string, ComponentObservation>
  registration: RegistrationObservation
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Mirrors the setup writer's HOME resolution exactly (packages/setup/src/paths.ts:12-15) so level 1 reports
 *  the same file the writer commits. The product's own home getter additionally honours OPENCODE_TEST_HOME
 *  (packages/core/src/global.ts:18-20); using it here would make the route look somewhere the writer never
 *  writes. Only the registration half of the payload follows the server's resolution, per spec §2. */
function homeDir() {
  const home = process.env.HOME
  return home && home.length > 0 ? home : os.homedir()
}

export function setupStateFilePath(): string {
  return InstalledTools.stateFileUnder(homeDir())
}

function emptyComponents(): Record<string, ComponentObservation> {
  const components: Record<string, ComponentObservation> = {}
  for (const id of SETUP_COMPONENT_IDS) components[id] = {}
  return components
}

/** Level 1 source. Branch-for-branch parity with readState (packages/setup/src/state.ts:105-126): a missing
 *  file is reported as absent, every other failure keeps its own verbatim cause, and no failure ever falls
 *  back to the all-`absent` default the setup reader uses internally. */
export function observeStateFile(path: string): { stateFile: StateFileObservation; components: Record<string, ComponentObservation> } {
  if (!existsSync(path)) return { stateFile: { path, present: false }, components: emptyComponents() }

  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return {
      stateFile: { path, present: true, error: `cannot read state file: ${errorMessage(err)}` },
      components: emptyComponents(),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      stateFile: { path, present: true, error: `state file is not valid JSON: ${errorMessage(err)}` },
      components: emptyComponents(),
    }
  }

  if (!isRecord(parsed)) {
    return {
      stateFile: { path, present: true, error: "state file top level is not an object" },
      components: emptyComponents(),
    }
  }

  // Own properties only (security review 238 F7, the same rule as session/installed-tools.ts).
  const raw = Object.hasOwn(parsed, "components") && isRecord(parsed.components) ? parsed.components : {}
  const components: Record<string, ComponentObservation> = {}
  for (const id of SETUP_COMPONENT_IDS) {
    const entry = Object.hasOwn(raw, id) ? raw[id] : undefined
    // A missing or non-object entry carries no observation at all; publishing `absent` for it would be the
    // silent default this route exists to refuse (§5 E5, R9).
    if (!isRecord(entry)) {
      components[id] = {}
      continue
    }
    components[id] = {
      ...(typeof entry.state === "string" ? { state: entry.state } : {}),
      ...(typeof entry.installedBySwarm === "boolean" ? { installedBySwarm: entry.installedBySwarm } : {}),
    }
  }

  return {
    stateFile: { path, present: true, updatedAtAbsent: typeof parsed.updatedAt !== "string" },
    components,
  }
}

/**
 * Level 2 source.
 *
 * `configDirPath` is a parameter rather than something resolved here, on purpose: the caller passes
 * `Global.Path.config`, the same constant the product's own global config load reads
 * (`path.join(Global.Path.config, "swarm.json")` at packages/opencode/src/config/config.ts:253). The setup
 * writer used to resolve `$HOME/.config/swarm` instead (packages/setup/src/paths.ts:12-15), which is a
 * different directory whenever XDG_CONFIG_HOME is set; re-deriving HOME in this route would let it report
 * "registered" about a file the product never opens (spec §2, row 194 C-207-g).
 */
export function observeRegistration(configDirPath: string): RegistrationObservation {
  const path = join(configDirPath, "swarm.json")
  const skills = SETUP_SKILL_PATHS.map((relPath) => ({ relPath, present: existsSync(join(configDirPath, relPath)) }))
  const none = { graft: false, swarmWeb: false }
  const answer = (configFile: ConfigFileObservation): RegistrationObservation => ({
    reader: "xdg-config",
    configDirPath,
    configFile,
    skills,
  })

  if (!existsSync(path)) return answer({ path, present: false, entries: none })

  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return answer({ path, present: true, parseError: `cannot read config file: ${errorMessage(err)}`, entries: none })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return answer({ path, present: true, parseError: `swarm.json is not valid JSON: ${errorMessage(err)}`, entries: none })
  }

  if (!isRecord(parsed)) return answer({ path, present: true, parseError: "swarm.json top level is not an object", entries: none })

  const mcp = Object.hasOwn(parsed, "mcp") && isRecord(parsed.mcp) ? parsed.mcp : {}
  return answer({
    path,
    present: true,
    entries: {
      graft: Object.hasOwn(mcp, InstalledTools.GRAFT_MCP),
      swarmWeb: Object.hasOwn(mcp, InstalledTools.SWARM_WEB_MCP),
    },
  })
}

/** One fresh read per call: no cache, no spawn, no internal request to `/mcp` (§4 rule 3, row 194 §3). */
export function setupObservation(configDirPath: string, statePath = setupStateFilePath()): SetupObservation {
  const state = observeStateFile(statePath)
  return {
    observedAt: new Date().toISOString(), // read time, stamped here; never a file mtime (§4 rule 1)
    stateFile: state.stateFile,
    components: state.components,
    registration: observeRegistration(configDirPath),
  }
}

export * as SetupObservation from "./setup-observation"
