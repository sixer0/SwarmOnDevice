// Pure step-descriptor schema + validation. Split out of steps.ts so the build-time
// generator (script/gen-steps.ts) can validate descriptors WITHOUT importing steps.ts,
// which statically imports the generated registry (steps.gen.ts) that does not exist yet
// on the very first generation — a bootstrap cycle this split breaks cleanly.
//
// This module imports ONLY register constants; it has no runtime dependency on the
// generated registry or on any step module. steps.ts re-exports everything here so all
// existing `import { ... } from "./steps.ts"` sites keep working unchanged.

import { isComponentId, type ComponentId } from "./constants.ts"

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

export function isHiddenName(name: string): boolean {
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
