// tools.lock.json loader (01c §5). Parses the reviewed lock shipped next to the
// program (PC-PATH-11 / PC-PKG-02) and validates it STRUCTURALLY, failing CLOSED:
// any malformed or inconsistent lock is refused before the setup would ever act on
// a pin. This is row 81's contract; row 82 consumes the validated object to fetch.
//
// Validation is structural, not value-completeness: PENDING-FACT / null pins are
// legitimate per the lock's own null_rule (row 80), so they are NOT rejected here.
// What IS rejected: bad JSON, wrong schemaVersion, missing/blank version, an empty
// or malformed hosts allow-list, an unknown component id, and any artifact `url`
// whose host is outside the allow-list (P-18). Underscore-prefixed keys are
// annotations (the lock's field_convention) and are ignored by the walk.

import { existsSync, readFileSync } from "node:fs"
import { COMPONENT_IDS, isComponentId } from "./constants.ts"
import { resolveLockFile } from "./paths.ts"

export interface LockFile {
  schemaVersion: number
  version: string
  hosts: string[]
  components: Record<string, Record<string, unknown>>
  raw: Record<string, unknown>
}

export type LoadResult = { ok: true; lock: LockFile } | { ok: false; error: string }

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

function isHostname(s: string): boolean {
  return HOSTNAME_RE.test(s) && !s.includes("/") && !s.includes(":")
}

// Registry-alias normalisation (D-16): comparison is on the RESOLVED registry host,
// never the literal image prefix. docker.io is a two-host exchange (token + blobs).
const REGISTRY_ALIAS: Record<string, string[]> = {
  "docker.io": ["registry-1.docker.io", "auth.docker.io"],
  "ghcr.io": ["ghcr.io"],
}

function imageRefHost(ref: string): string | null {
  // e.g. "ghcr.io/searxng/searxng@sha256:..." or "docker.io/library/redis:alpine@sha256:..."
  const first = ref.split("/")[0]
  if (!first || (!first.includes(".") && !first.includes(":"))) return null // not a host (short name)
  return first.split(":")[0] ?? null
}

function validateHostAllowList(hosts: string[]): string | null {
  if (!Array.isArray(hosts) || hosts.length === 0) return "hosts must be a non-empty array"
  for (const h of hosts) {
    if (typeof h !== "string" || !isHostname(h)) return `hosts entry is not a valid hostname: ${JSON.stringify(h)}`
  }
  return null
}

/** Validate a parsed lock object. Returns an error string, or null when valid. */
export function validateLock(parsed: unknown): { ok: true; lock: LockFile } | { ok: false; error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "lock top level is not a JSON object" }
  }
  const obj = parsed as Record<string, unknown>

  if (obj.schemaVersion !== 1) {
    return { ok: false, error: `unsupported schemaVersion: ${JSON.stringify(obj.schemaVersion)} (expected 1)` }
  }
  if (typeof obj.version !== "string" || obj.version.trim() === "") {
    return { ok: false, error: "missing or blank top-level version (PC-LBL-03 source)" }
  }
  const hostsErr = validateHostAllowList(obj.hosts as string[])
  if (hostsErr) return { ok: false, error: hostsErr }
  const hosts = obj.hosts as string[]
  const hostSet = new Set(hosts)

  if (!obj.components || typeof obj.components !== "object" || Array.isArray(obj.components)) {
    return { ok: false, error: "components must be an object" }
  }
  const components = obj.components as Record<string, Record<string, unknown>>

  // Fail-closed on unknown component ids: the register fixes exactly PC-CMP-01..07.
  for (const key of Object.keys(components)) {
    if (key.startsWith("_")) continue // annotation block (e.g. none here, but be safe)
    if (!isComponentId(key)) {
      return { ok: false, error: `unknown component id "${key}" (not a register PC-CMP-* value)` }
    }
  }
  // Every register component SHOULD be present in the reviewed lock.
  for (const id of COMPONENT_IDS) {
    if (!(id in components)) {
      return { ok: false, error: `lock is missing required component "${id}"` }
    }
  }

  // Allow-list enforcement over each component's downloadable url + image refs.
  for (const id of COMPONENT_IDS) {
    const comp = components[id] ?? {}
    const url = comp.url
    if (typeof url === "string" && url.trim() !== "") {
      let host: string
      try {
        const u = new URL(url)
        if (u.protocol !== "https:") return { ok: false, error: `${id}.url is not HTTPS: ${url}` }
        host = u.hostname
      } catch {
        return { ok: false, error: `${id}.url is not a parseable URL: ${url}` }
      }
      if (!hostSet.has(host)) {
        return { ok: false, error: `${id}.url host "${host}" is outside the hosts allow-list (P-18)` }
      }
    }
    // Image references: resolve the registry prefix through the alias map.
    for (const [field, value] of Object.entries(comp)) {
      if (field.startsWith("_")) continue
      const looksImage = field === "image" || field.endsWith("_image") || field.endsWith("image")
      if (looksImage && typeof value === "string" && value.includes("/")) {
        const rawHost = imageRefHost(value)
        if (rawHost === null) continue
        const resolved = REGISTRY_ALIAS[rawHost] ?? [rawHost]
        if (!resolved.some((h) => hostSet.has(h))) {
          return {
            ok: false,
            error: `${id}.${field} registry host "${rawHost}" resolves outside the allow-list (P-18/D-16)`,
          }
        }
      }
    }
  }

  return { ok: true, lock: { schemaVersion: 1, version: obj.version, hosts, components, raw: obj } }
}

/** Read + validate the shipped lock. Never fetches anything (row 82 owns network). */
export function loadLock(): LoadResult {
  const path = resolveLockFile()
  if (!existsSync(path)) {
    return { ok: false, error: `tools.lock.json not found next to the program at ${path}` }
  }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return { ok: false, error: `cannot read tools.lock.json: ${(err as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `tools.lock.json is not valid JSON: ${(err as Error).message}` }
  }
  return validateLock(parsed)
}
