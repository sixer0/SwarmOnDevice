// Step self-registration (01c §9). TWO discovery postures behind one entry point:
//
//   SOURCE / DEV / TESTS  -> directory scan of src/steps/*/ (unchanged authority; this is
//     what every unit test and `bun run` sees, so behaviour does not shift between the
//     skeleton and the fix round).
//   COMPILED BINARY       -> the build-time GENERATED static registry (src/steps.gen.ts),
//     because `bun build --compile` does NOT embed directories, so a runtime readdir of
//     stepsRoot() finds nothing in the shipped Mach-O (row-106 blocker H-R106).
//
// The switch is `isCompiledBinary()` (paths.ts): true iff `import.meta.url` points into
// Bun's compiled virtual FS (`$bunfs`) or `import.meta.dir` is absent on disk — verified
// empirically on bun 1.3.14 (see paths.ts). Source runs take the disk branch, so the
// combined test suite is unaffected.
//
// The generated registry is produced by script/gen-steps.ts at build time; it statically
// imports each step module (so the binary EMBEDS the step code) plus its validated
// descriptor, and records a content hash of the whole step set. A parity gate
// (`gen-steps --check`) fails the build if the committed registry drifts from the step
// directories on disk — so adding/altering a step without regenerating is caught.
//
// Contract per step directory (identical to the pre-fix design):
//   src/steps/<component_id>/step.json   -> the step's OWN small descriptor
//   src/steps/<component_id>/index.ts     -> the step implementation (default export)
// Directory name MUST equal descriptor.id, which MUST be a register PC-CMP-* value
// (class 1): one id serves the state key, ~/.swarm/tools/<id>, and the component label.
// `_`/`.`-prefixed dirs are templates/examples, validated for shape but never registered.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { COMPONENT_IDS } from "./constants.ts"
import { isCompiledBinary, stepsRoot } from "./paths.ts"
import { GENERATED_DESCRIPTORS } from "./steps.gen.ts"
import {
  isHiddenName,
  validateDescriptor,
  validateDescriptorShape,
  type StepDescriptor,
  type StepScan,
} from "./step-descriptor.ts"

// Re-export the pure schema/validation surface so existing `import { ... } from "./steps.ts"`
// sites (index.ts, tests, proofs) are unchanged by the split into step-descriptor.ts.
export { isHiddenName, validateDescriptor, validateDescriptorShape }
export type { StepDescriptor, StepScan }

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

/** SOURCE posture: scan the steps directory. Never throws on a bad descriptor — it
 *  records an error so the caller can fail closed rather than run with a half-known set. */
export function discoverStepsFromDisk(root: string = stepsRoot()): StepScan {
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

/** COMPILED posture: build the same StepScan shape from the embedded registry. The
 *  registry holds only valid, registered steps (gen-steps fails closed otherwise), so
 *  there are no template skips and no descriptor errors to report here. */
export function discoverStepsFromRegistry(): StepScan {
  return {
    steps: GENERATED_DESCRIPTORS.map((d) => ({ ...d, requires: [...d.requires] })),
    skippedTemplates: [],
    validatedTemplates: [],
    errors: [],
  }
}

/** Single entry point used by index.ts and tests. Dispatches on the compile marker so
 *  source/dev/test keeps the directory scan (behaviour unchanged) while the shipped
 *  binary reads the embedded registry. */
export function discoverSteps(root: string = stepsRoot()): StepScan {
  return isCompiledBinary() ? discoverStepsFromRegistry() : discoverStepsFromDisk(root)
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
