// State-machine engine (01c §4). Owns reading and writing ~/.swarm/setup/state.json
// (PC-PATH-02, mode 0600) in the row-73 envelope shape over the register vocabulary
// (keys = PC-CMP-01..07, values = PC-ST-*). Writes are atomic (§6.2), so a kill -9
// mid-transition cannot corrupt the machine: readers open only the committed name and
// never a stray temp file. This file is the single-writer commit point (A-73-3); the
// lock directory guarantees one writer at a time.

import { existsSync, readFileSync } from "node:fs"
import {
  COMPONENT_IDS,
  STATES,
  STATE_SCHEMA_VERSION,
  MODES,
  isComponentId,
  type ComponentId,
  type StateValue,
} from "./constants.ts"
import { atomicWriteJson } from "./atomic.ts"
import { stateFile } from "./paths.ts"

export interface DockerObject {
  kind: string // profile | volume | container | network | image ...
  id: string
  createdBySwarm?: boolean // P-14: remove deletes only objects flagged created
  hasData?: boolean // P-14: ask before deleting a volume that holds data
}

export interface ComponentState {
  state: StateValue // PC-ST-01..08 resting states
  installedBySwarm?: boolean // P-14 installed_by_swarm:true
  version?: string // pin actually installed
  integrity?: string // sha256|digest verified at install
  paths?: string[] // files/dirs created (install manifest)
  dockerObjects?: DockerObject[] // labelled objects created (§7)
  backups?: string[] // hash-named config backups (P-15)
  updatedAt?: string
}

export interface StateFile {
  version: number // state-file schema version (row-73 field)
  lockVersion: string // provenance: matches tools.lock.json .version (§5)
  updatedAt: string // ISO-8601
  components: Record<ComponentId, ComponentState>
}

function nowIso(): string {
  return new Date().toISOString()
}

/** The canonical clean-state envelope: every component `absent` (PC-ST-01). */
export function defaultState(lockVersion: string): StateFile {
  const components = {} as Record<ComponentId, ComponentState>
  for (const id of COMPONENT_IDS) {
    components[id] = { state: STATES.ABSENT }
  }
  return {
    version: STATE_SCHEMA_VERSION,
    lockVersion,
    updatedAt: nowIso(),
    components,
  }
}

/** Normalise a parsed object into a full StateFile, guaranteeing all seven keys and
 *  dropping any component key that is not a register id (fail-closed on drift). */
function normalise(parsed: Record<string, unknown>, fallbackLockVersion: string): StateFile {
  const rawComponents = (parsed.components && typeof parsed.components === "object" ? parsed.components : {}) as Record<
    string,
    unknown
  >
  const components = {} as Record<ComponentId, ComponentState>
  for (const id of COMPONENT_IDS) {
    const entry = rawComponents[id]
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>
      const st = typeof e.state === "string" ? (e.state as StateValue) : STATES.ABSENT
      components[id] = {
        state: st,
        ...(typeof e.installedBySwarm === "boolean" ? { installedBySwarm: e.installedBySwarm } : {}),
        ...(typeof e.version === "string" ? { version: e.version } : {}),
        ...(typeof e.integrity === "string" ? { integrity: e.integrity } : {}),
        ...(Array.isArray(e.paths) ? { paths: e.paths as string[] } : {}),
        ...(Array.isArray(e.dockerObjects) ? { dockerObjects: e.dockerObjects as DockerObject[] } : {}),
        ...(Array.isArray(e.backups) ? { backups: e.backups as string[] } : {}),
        ...(typeof e.updatedAt === "string" ? { updatedAt: e.updatedAt } : {}),
      }
    } else {
      components[id] = { state: STATES.ABSENT }
    }
  }
  return {
    version: typeof parsed.version === "number" ? parsed.version : STATE_SCHEMA_VERSION,
    lockVersion: typeof parsed.lockVersion === "string" ? parsed.lockVersion : fallbackLockVersion,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
    components,
  }
}

/**
 * Read the committed state file. A missing file yields the clean-state default
 * (nothing written). A file whose top level is not a JSON object is treated as
 * absent-and-unusable: callers surface that as a failure rather than trusting it.
 * Stray `*.tmp-*` siblings left by a killed writer are never opened here.
 */
export function readState(lockVersion: string): { ok: true; state: StateFile } | { ok: false; error: string } {
  const path = stateFile()
  if (!existsSync(path)) {
    return { ok: true, state: defaultState(lockVersion) }
  }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return { ok: false, error: `cannot read state file: ${(err as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `state file is not valid JSON: ${(err as Error).message}` }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "state file top level is not an object" }
  }
  return { ok: true, state: normalise(parsed as Record<string, unknown>, lockVersion) }
}

/** Atomically commit the state file (mode 0600, PC-PATH-02). */
export function writeState(state: StateFile): void {
  state.updatedAt = nowIso()
  atomicWriteJson(stateFile(), state, MODES.FILE_0600)
}

/** Convenience: transition one component and commit. Rows 82+ call this per step. */
export function setState(state: StateFile, id: ComponentId, patch: Partial<ComponentState>): void {
  const current = state.components[id] ?? { state: STATES.ABSENT }
  state.components[id] = { ...current, ...patch, updatedAt: nowIso() }
  writeState(state)
}

export { isComponentId }
