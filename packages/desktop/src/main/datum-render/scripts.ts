// DATUM render bridge: allow-list of page scripts for checkPage (row 24, prereview M6).
//
// checkPage evaluates a function text inside the render page through CDP Runtime.evaluate. Only
// fixed scripts that ship with the app are accepted, identified by the sha256 of their exact text:
// - Studio's MEASURE_SCRIPT (engine/browser/measure.ts:25) and its other fixed scripts, registered by
//   the host wiring (rows 108 / 111) from the vendored engine;
// - the check-page function of datum_render.py (scripts/datum_render.py, `pg.evaluate("""...""")`),
//   extracted from the bundled byte copy at bridge start, so render.py is never edited.

import { createHash } from "node:crypto"
import { BridgeError } from "./protocol"

export function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export class ScriptAllowList {
  private readonly byHash = new Map<string, string>()

  add(name: string, text: string) {
    if (!text.trim()) throw new Error(`empty script ${name}`)
    this.byHash.set(sha256(text), name)
    return this
  }

  /** Returns the registered name, or throws SCRIPT_NOT_ALLOWED. */
  check(text: string): string {
    const name = this.byHash.get(sha256(text))
    if (!name) throw new BridgeError("SCRIPT_NOT_ALLOWED", "script is not one of the fixed page scripts")
    return name
  }

  get size() {
    return this.byHash.size
  }

  names() {
    return [...this.byHash.values()]
  }
}

/**
 * Extract the check-page function text from datum_render.py source. It is a plain (non-raw)
 * triple-quoted string; any backslash would make the Python value differ from the source text,
 * so such a source is refused rather than guessed.
 */
export function extractRenderPyCheckScript(source: string): string | undefined {
  const m = /pg\.evaluate\("""([\s\S]*?)"""/.exec(source)
  if (!m) return undefined
  if (m[1].includes("\\")) return undefined
  return m[1]
}

/** The expression evaluated for a checkPage request: the fixed function applied to a JSON argument. */
export function checkPageExpression(script: string, arg: unknown) {
  const json = JSON.stringify(arg)
  if (json === undefined) throw new BridgeError("BAD_REQUEST", "arg must be JSON-serialisable")
  return `(${script})(${json})`
}
