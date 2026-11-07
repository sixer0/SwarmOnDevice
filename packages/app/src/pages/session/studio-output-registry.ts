// Row 165E of docs/2026-11-06_swarm_1_2_0_datum_installer (decision C192, security narrowing of row 165D): the
// registered Studio outputs of a project directory. A DATUM-named `.html` opens rendered in the file tab only when its
// path is here (file-preview-policy.ts `isStudioOutputPath`); the name pattern alone never decides.
//
// Who registers: the mission poll (swarm/mission-poll.ts), after `studio_mission_get` answered and the deliverable's
// delivered `fileName` (from the Studio store) was found in docs/<mission>/ - i.e. the deliverable's `projectPath`.
// Keyed by directory, so a path registered in one project never counts in another. Paths are only added, never
// trusted from the file system: an output that is not a listed deliverable stays unregistered (code view, fail closed).
import { createSignal } from "solid-js"

const [registry, setRegistry] = createSignal<ReadonlyMap<string, ReadonlySet<string>>>(new Map())

const EMPTY: ReadonlySet<string> = new Set()

/** Adds deliverable project paths (session-relative, e.g. `docs/<mission>/<DATUM name>`) for `directory`. */
export function registerStudioOutputs(directory: string | undefined, paths: Iterable<string | null | undefined>) {
  if (!directory) return
  const known = registry().get(directory) ?? EMPTY
  const added = [...paths].filter((path): path is string => typeof path === "string" && path.length > 0 && !known.has(path))
  if (added.length === 0) return
  const next = new Map(registry())
  next.set(directory, new Set([...known, ...added]))
  setRegistry(next)
}

/** The registered Studio output paths of `directory` (reactive: a Solid signal read). */
export function registeredStudioOutputs(directory: string | undefined): ReadonlySet<string> {
  if (!directory) return EMPTY
  return registry().get(directory) ?? EMPTY
}

/** Tests only. */
export function resetStudioOutputRegistry() {
  setRegistry(new Map())
}
