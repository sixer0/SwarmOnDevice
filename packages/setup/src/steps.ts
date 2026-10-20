// Step self-registration by directory scan (01c §9). There is NO shared registry
// file: the scan of src/steps/*/ IS the registry. This is what lets rows 82-98 each
// add one step directory without ever editing a common file (single-writer discipline,
// driver_rules_e1 rule 2 / 02_structured.md:447).
//
// Contract per step directory:
//   src/steps/<component_id>/step.json   -> the step's OWN small descriptor
//   src/steps/<component_id>/index.ts     -> the step implementation (rows 82+)
// The directory name MUST equal the descriptor id, which MUST be a register PC-CMP-*
// value (class 1), because one id serves the state key, the ~/.swarm/tools/<id> dir,
// and the io.gsp.swarm.component label (01c0:53-55). A mislabelled step is therefore
// impossible without a register change.
//
// Directories whose name begins with `_` or `.` are NOT components: they are authoring
// examples/templates (e.g. `_template`). They are still validated against the descriptor
// schema so the contract is provably exercised, but they never enter the component set.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { COMPONENT_IDS, isComponentId, type ComponentId } from "./constants.ts"
import { stepsRoot } from "./paths.ts"

export interface StepDescriptor {
  id: ComponentId
  order: number
  requires: ComponentId[]
  title?: string
  description?: string
}

export interface StepScan {
  /** Valid, registered component steps (non-underscore dirs with a good descriptor). */
  steps: StepDescriptor[]
  /** Directories skipped because they are templates/examples (`_`/`.` prefix). */
  skippedTemplates: string[]
  /** Template dirs whose step.json parsed AND validated against the descriptor schema. */
  validatedTemplates: string[]
  /** Fail-closed detail for any descriptor that did not validate. */
  errors: string[]
}

function isHiddenName(name: string): boolean {
  return name.startsWith("_") || name.startsWith(".")
}

/** Shape-only validation used for TEMPLATE/example directories (`_`/`.` prefixed). A
 *  template carries a placeholder or illustrative id and does not live in a directory
 *  named after a component, so it is checked for STRUCTURE only (object, string id,
 *  integer order, array requires) — never the register-id or dir-match rules that a
 *  real step must satisfy. This lets the skeleton prove the descriptor schema is
 *  exercised without inventing a fake component. */
export function validateDescriptorShape(raw: unknown, dirName: string): { ok: true } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${dirName}: step.json is not a JSON object` }
  }
  const o = raw as Record<string, unknown>
  if (typeof o.id !== "string") return { ok: false, error: `${dirName}: descriptor.id must be a string` }
  if (typeof o.order !== "number" || !Number.isInteger(o.order)) {
    return { ok: false, error: `${dirName}: descriptor.order must be an integer` }
  }
  if (!Array.isArray(o.requires ?? [])) return { ok: false, error: `${dirName}: descriptor.requires must be an array` }
  return { ok: true }
}

/** Validate a raw parsed descriptor against the schema. `dirName` is the directory it
 *  was found in; the id must match it. Returns the descriptor or an error string. */
export function validateDescriptor(
  raw: unknown,
  dirName: string,
): { ok: true; descriptor: StepDescriptor } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${dirName}: step.json is not a JSON object` }
  }
  const o = raw as Record<string, unknown>

  const id = o.id
  if (typeof id !== "string") return { ok: false, error: `${dirName}: descriptor.id must be a string` }
  if (!isComponentId(id)) {
    return { ok: false, error: `${dirName}: descriptor.id "${id}" is not a register PC-CMP-* component id` }
  }
  if (id !== dirName) {
    return { ok: false, error: `${dirName}: descriptor.id "${id}" does not match the directory name` }
  }

  const order = o.order
  if (typeof order !== "number" || !Number.isInteger(order)) {
    return { ok: false, error: `${dirName}: descriptor.order must be an integer` }
  }

  const requiresRaw = o.requires ?? []
  if (!Array.isArray(requiresRaw)) return { ok: false, error: `${dirName}: descriptor.requires must be an array` }
  for (const r of requiresRaw) {
    if (!isComponentId(r as string)) {
      return {
        ok: false,
        error: `${dirName}: descriptor.requires contains "${String(r)}" which is not a register component id`,
      }
    }
  }

  const descriptor: StepDescriptor = {
    id,
    order,
    requires: requiresRaw as ComponentId[],
    ...(typeof o.title === "string" ? { title: o.title } : {}),
    ...(typeof o.description === "string" ? { description: o.description } : {}),
  }
  return { ok: true, descriptor }
}

function readDescriptor(dirPath: string, dirName: string): { ok: true; raw: unknown } | { ok: false; error: string } {
  const file = join(dirPath, "step.json")
  if (!existsSync(file)) return { ok: false, error: `${dirName}: missing step.json` }
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    return { ok: false, error: `${dirName}: cannot read step.json (${(err as Error).message})` }
  }
  try {
    return { ok: true, raw: JSON.parse(text) }
  } catch (err) {
    return { ok: false, error: `${dirName}: step.json is not valid JSON (${(err as Error).message})` }
  }
}

/** Scan the steps directory. Never throws on a bad descriptor — it records an error so
 *  the caller can fail closed rather than run with a half-known step set. */
export function discoverSteps(root: string = stepsRoot()): StepScan {
  const scan: StepScan = { steps: [], skippedTemplates: [], validatedTemplates: [], errors: [] }
  if (!existsSync(root)) return scan

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (err) {
    scan.errors.push(`cannot read steps directory ${root}: ${(err as Error).message}`)
    return scan
  }

  for (const name of entries.sort()) {
    const full = join(root, name)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue

    const read = readDescriptor(full, name)
    if (!read.ok) {
      scan.errors.push(read.error)
      continue
    }

    if (isHiddenName(name)) {
      // Template/example: validate its SHAPE to prove the schema is exercised, but do
      // not register it as a component (a template's id is illustrative, not a real one).
      const shape = validateDescriptorShape(read.raw, name)
      if (shape.ok) scan.validatedTemplates.push(name)
      else scan.errors.push(shape.error)
      scan.skippedTemplates.push(name)
      continue
    }

    const validated = validateDescriptor(read.raw, name)
    if (!validated.ok) {
      scan.errors.push(validated.error)
      continue
    }
    scan.steps.push(validated.descriptor)
  }

  return scan
}

/** Topological order by `requires`; ties broken by the numeric `order` field so the
 *  result is deterministic regardless of directory-scan order. A cycle is reported as
 *  an error (fail-closed) rather than producing an unstable install sequence. */
export function orderSteps(
  steps: readonly StepDescriptor[],
): { ok: true; ordered: StepDescriptor[] } | { ok: false; error: string } {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const indegree = new Map<string, number>()
  for (const s of steps) indegree.set(s.id, 0)
  // Only count edges whose target is present in this step set; a prerequisite that is
  // not itself a scanned step (e.g. node before graft lands) is an external dep, no edge.
  for (const s of steps) {
    for (const r of s.requires) {
      if (byId.has(r)) indegree.set(s.id, (indegree.get(s.id) ?? 0) + 1)
    }
  }

  const ready = steps
    .filter((s) => (indegree.get(s.id) ?? 0) === 0)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const ordered: StepDescriptor[] = []
  const remaining = new Set(steps.map((s) => s.id))

  while (ready.length > 0) {
    const next = ready.shift() as StepDescriptor
    ordered.push(next)
    remaining.delete(next.id)
    for (const s of steps) {
      if (!remaining.has(s.id)) continue
      if (s.requires.includes(next.id)) {
        const d = (indegree.get(s.id) ?? 0) - 1
        indegree.set(s.id, d)
        if (d === 0) ready.push(s)
      }
    }
    ready.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }

  if (ordered.length !== steps.length) {
    const stuck = [...remaining].join(", ")
    return { ok: false, error: `dependency cycle among steps: ${stuck}` }
  }
  return { ok: true, ordered }
}

export { COMPONENT_IDS }
