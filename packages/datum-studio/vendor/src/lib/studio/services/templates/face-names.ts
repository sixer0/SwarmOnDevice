/**
 * Swarm patch (row 165D, F113-11, CP-19; manual Rev A DT-08 "IBM Plex Sans Condensed"): canonical font family names
 * for every template the store resolves (the MCP write path: studio_document_create -> render).
 *
 * The Manual 000 profile and the presets derived from it (datum-gsp-preset, datum-gsp-rev-a-preset and every
 * doc-type template on them, e.g. datum-nota) name the condensed face "IBM Plex Sans Cond". That short name came from
 * the original's relabelled font files, which Swarm does not ship (U9.7, engine/docx/fonts/relabel.ts). Swarm embeds
 * the standard OFL files whose family is "IBM Plex Sans Condensed", so a document written with the short name carries
 * a family in its runs, fontTable and HTML `@font-face` that no embedded or installed face has.
 *
 * The rewrite is exact: only a string value that is, after trimming, the short name (case-insensitive) becomes the
 * canonical name. Nothing else in the template changes; the input is never mutated.
 */

/** Short family names -> the canonical family (normalised key: lower case, no spaces). */
const CANONICAL_FAMILIES: Readonly<Record<string, string>> = {
  "ibm plex sans cond": "IBM Plex Sans Condensed",
};

/** The canonical family for a face name, or the name unchanged. */
export function canonicalFaceName(name: string): string {
  const key = name.trim().replace(/\s+/g, " ").toLowerCase();
  return CANONICAL_FAMILIES[key] ?? name;
}

/** Deep copy of `value` with every exact short family name replaced; returns the same reference when nothing changed. */
export function canonicalizeFaceNames<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return canonicalFaceName(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const w = walk(v);
      if (w !== v) changed = true;
      return w;
    });
    return changed ? out : value;
  }
  // Resolved slots are a Map (skeleton/repository.ts resolveSlotsForVersion): keys kept, values walked.
  if (value instanceof Map) {
    let changed = false;
    const out = new Map<unknown, unknown>();
    for (const [k, v] of value) {
      const w = walk(v);
      if (w !== v) changed = true;
      out.set(k, w);
    }
    return changed ? out : value;
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value; // class instances (Date, Buffer, ...) are never template data: left as they are
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const w = walk(v);
      if (w !== v) changed = true;
      out[k] = w;
    }
    return changed ? out : value;
  }
  return value;
}
