// Compose-file renderer — shared contracts and builders (row 85).
//
// This service (NOT a scanned step — see src/composefiles/index.ts header and the row-85
// report for the §9 scan-contract reason) renders the two compose projects of
// masterplan/01e_compose_spec.md from the ratified spec: structure is lifted from 01e,
// every image value comes from tools.lock.json (row 80+r80b), every register constant
// comes from constants.ts (PC-PROJ-01, PC-LBL-01..03, PC-PORT-01/02). Nothing is
// re-hardcoded here that the lock or register already owns.
//
// The renderer is PURE: no network, no process spawn, no writes. Writing is
// applyRenderedFiles() below (atomic.ts, row 81) called by the owner steps; a dry run
// renders to a caller-chosen directory only (PORT RULE note in decisions.md: "dry-run
// renders to temp only"). Byte-stability is a contract: two renders with equal inputs
// produce byte-identical files (no timestamps, deterministic key order), which is what
// lets rows 91/92 diff-lift and row 85's lint stay mechanical.

import { LABELS } from "../constants.ts"
import { homeDir } from "../paths.ts"
import type { LockFile } from "../lockfile.ts"

export const RENDERER_NAME = "compose-files"

/** One secret slot of a component's §4.6 inventory. */
export interface SecretSpec {
  readonly name: string
  readonly required: boolean
  /** Generation command lifted verbatim from 01e §4.6 — the OWNER row executes it
   *  (rows 84/86/91/92 own generation); this renderer never produces a value. */
  readonly genHint: string
}

/** D-22 state of one secret slot. `generated` means the owner row created the file at
 *  secretsDir/<name>; only then may its bind + wrap render. */
export type SecretState = "absent" | "generated"

export interface RenderContext {
  /** Anchor for every `~` register path; absolute paths land in the rendered files
   *  (gate addition A-75-1: no literal `~` in any source:/env_file:). Injectable so a
   *  dry-run/test pins it and byte-stability holds across runs. */
  readonly home?: string
  /** H-11 engine-prune path. "auto" (default) = fallback unless defaultSettings is provided.
   *  "image-settings" requires ctx.defaultSettings — the pinned image's OWN settings.yml,
   *  extracted by whoever holds docker tooling (row 92's):
   *  docker run --rm --entrypoint cat <pinned> /usr/local/searxng/searx/settings.yml
   *  (01e §8.1; read-only, no daemon change, run once at bake). */
  readonly enginePath?: "auto" | "image-settings" | "fallback-list-of-four"
  /** The pinned image's default settings.yml text, when the fetched path was taken. */
  readonly defaultSettings?: string
  /** F-79-B: absolute path of the host CA bundle (constant owned by row 73), set ONLY when
   *  the bundle exists on the host. Drives the conditional read-only mounts (§4.10). */
  readonly caBundlePath?: string
  /** Per-component secret-slot states; undeclared slots resolve to "absent". */
  readonly secrets?: Partial<Record<"searxng" | "firecrawl", Readonly<Record<string, SecretState>>>>
  /** TEST SEAM ONLY (F-79-E fixture): makes labels carry a version OTHER than lock.version
   *  so the lint's refusal path is exercisable. Production code must never pass it. */
  readonly _tamperVersionLabel?: string
}

export interface RenderFile {
  /** Relative path inside the render tree, e.g. "searxng/compose/searxng.yml". */
  readonly relPath: string
  readonly content: string
  /** Unix mode for applyRenderedFiles. */
  readonly mode: number
  /** Which compose stack consumes this file (manifest/report grouping). */
  readonly stack: "searxng" | "firecrawl" | "shared"
}

export interface RenderError {
  readonly code:
    | "SECRET_REQUIRED_MISSING" // §4.9 "unset required secret": refuse to render
    | "SECRET_UNDECLARED" // manifest names something outside the §4.6 inventory
    | "LOCK_FIELD_MISSING" // a pin this render needs is absent/null in the lock
    | "ENGINE_SETTINGS_INVALID" // enginePath=image-settings but no usable text
    | "CONTEXT_INVALID"
  readonly message: string
}

/** §4.6 secret inventory, transcribed (names + generation commands) not invented.
 *  `required` follows 01e: optional slots carry an explicit default decision. */
export const SECRET_INVENTORY: Record<"searxng" | "firecrawl", readonly SecretSpec[]> = {
  searxng: [
    { name: "secret_key", required: true, genHint: "openssl rand -hex 32" },
    // U-6 default: valkey stays passwordless on se-int (upstream companion, 02e:66).
    { name: "valkey_auth", required: false, genHint: "openssl rand -hex 32" },
  ],
  firecrawl: [
    { name: "proxy_token", required: true, genHint: "openssl rand -base64 32 | tr '+/' '-_' | tr -d '='" },
    { name: "postgres_password", required: true, genHint: "openssl rand -base64 48 | tr -d '\\n='" },
    { name: "bull_auth_key", required: true, genHint: "openssl rand -base64 32" },
    // U-4 default decision: requirepass ON (01e §4.6).
    { name: "redis_auth", required: true, genHint: "openssl rand -hex 32" },
    // U-5 default decision OFF: guest/guest stays confined to fc-data (D-22 form B).
    { name: "rabbitmq_password", required: false, genHint: "openssl rand -base64 32" },
  ],
}

export function resolveSecretState(ctx: RenderContext, component: "searxng" | "firecrawl", name: string): SecretState {
  return ctx.secrets?.[component]?.[name] ?? "absent"
}

/** Context after normalization — what every renderer actually receives. */
export interface NormalizedCtx {
  readonly home: string
  readonly toolsRoot: string
  readonly enginePath: "image-settings" | "fallback-list-of-four"
  readonly caBundlePath?: string
  readonly tamperLabel?: string
  readonly secrets: RenderContext["secrets"]
  readonly defaultSettingsText?: string
  readonly explicitImageRequest: boolean
}

/** Normalized context: anchors resolved, defaults applied. */
export function normalizeContext(ctx: RenderContext): NormalizedCtx {
  const home = ctx.home ?? homeDir()
  const wantsImage = ctx.enginePath === undefined || ctx.enginePath === "auto" || ctx.enginePath === "image-settings"
  // "auto" upgrades to the fetched path ONLY when the image's settings text was supplied;
  // an explicit "image-settings" without usable text is refused downstream (ENGINE_SETTINGS_INVALID)
  // so the choice can never silently degrade into the fallback.
  const hasUsableSettings = typeof ctx.defaultSettings === "string" && parseEngineNames(ctx.defaultSettings).length > 0
  const enginePath = wantsImage && hasUsableSettings ? "image-settings" : "fallback-list-of-four"
  return {
    home,
    toolsRoot: joinAbs(home, ".swarm/tools"),
    enginePath,
    explicitImageRequest: ctx.enginePath === "image-settings",
    secrets: ctx.secrets,
    ...(ctx.caBundlePath ? { caBundlePath: ctx.caBundlePath } : {}),
    ...(ctx._tamperVersionLabel ? { tamperLabel: ctx._tamperVersionLabel } : {}),
    ...(typeof ctx.defaultSettings === "string" ? { defaultSettingsText: ctx.defaultSettings } : {}),
  }
}

/** Shared pre-flight every render performs: required secrets declared generated (D-22 /
 *  §4.9 "unset required secret"), manifest names within the inventory. */
export function contextErrors(ctx: RenderContext): RenderError[] {
  const errors: RenderError[] = []
  for (const component of ["searxng", "firecrawl"] as const) {
    const declared = ctx.secrets?.[component] ?? {}
    const known = new Set(SECRET_INVENTORY[component].map((s) => s.name))
    for (const name of Object.keys(declared)) {
      if (!known.has(name)) {
        errors.push({
          code: "SECRET_UNDECLARED",
          message: `${component}: secret slot "${name}" is not in the 01e §4.6 inventory`,
        })
      }
    }
    for (const spec of SECRET_INVENTORY[component]) {
      if (!spec.required) continue
      if (declared[spec.name] !== "generated") {
        errors.push({
          code: "SECRET_REQUIRED_MISSING",
          message: `${component}: required secret "${spec.name}" is not declared generated — refusing to render (01e §4.9 unset-required-secret; generate via ${spec.genHint})`,
        })
      }
    }
  }
  return errors
}

function lockField(lock: LockFile, component: string, field: string): string | null {
  const value = lock.components[component]?.[field]
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Read an image ref out of the lock and prove it carries @sha256: (P-9 digest pin). */
export function lockImage(
  lock: LockFile,
  component: string,
  field: string,
): { ok: true; ref: string } | { ok: false; error: RenderError } {
  const ref = lockField(lock, component, field)
  if (ref === null) {
    return {
      ok: false,
      error: {
        code: "LOCK_FIELD_MISSING",
        message: `tools.lock.json components.${component}.${field} is missing or null`,
      },
    }
  }
  if (!ref.includes("@sha256:")) {
    return {
      ok: false,
      error: {
        code: "LOCK_FIELD_MISSING",
        message: `lock ref ${component}.${field} carries no @sha256 digest (never render tag-only pins)`,
      },
    }
  }
  return { ok: true, ref }
}

/** Absolute path join that never emits `~` (A-75-1). */
export function joinAbs(base: string, ...parts: string[]): string {
  let out = base
  for (const p of parts) out = out.endsWith("/") ? out + p : `${out}/${p}`
  return out
}

// Render-tree layout (all under one caller-chosen root: ~/.swarm/tools in production,
// a temp dir for dry runs). Compose bind sources are written as these same absolute paths.
export const pathsFor = (toolsRoot: string) => ({
  searxngDir: joinAbs(toolsRoot, "searxng"),
  searxngCompose: joinAbs(toolsRoot, "searxng/compose/searxng.yml"),
  searxngSettings: joinAbs(toolsRoot, "searxng/settings.yml"),
  searxngEnv: joinAbs(toolsRoot, "searxng/searxng.env"),
  searxngSecrets: joinAbs(toolsRoot, "searxng/secrets"),
  searxngCache: joinAbs(toolsRoot, "searxng/cache"),
  firecrawlDir: joinAbs(toolsRoot, "firecrawl"),
  firecrawlCompose: joinAbs(toolsRoot, "firecrawl/compose/firecrawl.yml"),
  firecrawlNginxTemplate: joinAbs(toolsRoot, "firecrawl/nginx/default.conf.template"),
  firecrawlSquidConf: joinAbs(toolsRoot, "firecrawl/squid/squid.conf"),
  firecrawlSecrets: joinAbs(toolsRoot, "firecrawl/secrets"),
  firecrawlLogs: joinAbs(toolsRoot, "firecrawl/logs"),
  firecrawlBin: joinAbs(toolsRoot, "firecrawl/compose/bin"),
})

// --- YAML block builders (the §4 shared conventions, emitted identically everywhere) ---

export function commentLines(text: string, indent: number): string {
  const pad = " ".repeat(indent)
  return text
    .split("\n")
    .map((l) => `${pad}# ${l}`.trimEnd())
    .join("\n")
}

/** §4.1 labels on every service. Version value = lock.version AT RENDER TIME (PC-LBL-03);
 *  no ${} interpolation anywhere (01e §4.1: hard-code the lock value, avoids pass-through lint hits). */
export function labelBlock(
  component: "searxng" | "firecrawl",
  lockVersion: string,
  indent: number,
  tamperLabel?: string,
): string {
  const pad = " ".repeat(indent)
  const lines = [
    `${pad}labels:`,
    `${pad}  ${LABELS.MANAGED_KEY}: "${LABELS.MANAGED_VALUE}"`, // PC-LBL-01 (P-14 literal)
    `${pad}  ${LABELS.COMPONENT_KEY}: "${component}"`, // PC-LBL-02 — the second selector under one project
    `${pad}  ${LABELS.VERSION_KEY}: "${tamperLabel ?? lockVersion}"`, // PC-LBL-03; F-79-E asserts equality vs lock.version
  ]
  return lines.join("\n")
}

/** §4.4 bounded json-file logging. */
export function loggingBlock(indent: number): string {
  const pad = " ".repeat(indent)
  return [
    `${pad}logging:`,
    `${pad}  driver: json-file`,
    `${pad}  options: {max-size: "5m", max-file: "2", compress: "true"}`,
  ].join("\n")
}

/** §4.4 ulimits default (per-service override passed in where a workload needs more). */
export function ulimitsBlock(indent: number, soft = 4096, hard = 8192): string {
  return `${" ".repeat(indent)}ulimits: {nofile: {soft: ${soft}, hard: ${hard}}}`
}

/** Long-form bind mount (§4.6 mount pattern / A-75-1 absolute sources). */
export function bindMount(source: string, target: string, readOnly: boolean, indent: number): string {
  const pad = " ".repeat(indent)
  const lines = [`${pad}- type: bind`, `${pad}  source: ${source}`, `${pad}  target: ${target}`]
  if (readOnly) lines.push(`${pad}  read_only: true`)
  return lines.join("\n")
}

export const SECURITY_OPT = 'security_opt: ["no-new-privileges:true"]' // P-9, all services
export const CAP_DROP = "cap_drop: [ALL]" // P-9, all services; cap_add stays banned by the lint

// --- Register class 7 mirror (PC-PORT-01..08) AS AMENDED by the user PORT BLOCK -------------
// (decisions.md:30, 2026-10-20 05:33 UTC -> register r72-fix2 -> 01e r75-fix2 §4.2). Single
// definition site INSIDE this service: constants.ts is row-81 owned (off-limits to this row)
// and carries no PORTS block yet; tools.lock.json names ports only in underscore annotations,
// which its own field_convention bars consumers from reading. Every rendered port value below
// interpolates from this table — no port literal appears twice, and lint.ts asserts the two
// published values against it (port-values rule), so a future amendment changes ONE place.
// Container-side numbers are upstream facts kept unchanged (PC-PORT-03..07); only the two
// HOST bindings moved: 8888->9021, 3002(host)->9022. PC-PORT-08 (9023-9029) stays unbound here.
export const PC_PORTS = {
  /** PC-PORT-01 SearXNG published: host 9021 (was 8888), container 8080 (PC-PORT-03, 02b:128). */
  searxngPublished: { host: 9021, container: 8080 },
  /** PC-PORT-02 Firecrawl API behind the auth proxy: host 9022 (was 3002-host), proxy container
   *  side 8080 (PC-PORT-05) so it needs ZERO caps. */
  firecrawlPublished: { host: 9022, container: 8080 },
  /** PC-PORT-04 api container listen — unpublished fact; the OLD host binding 3002 is history. */
  apiContainer: 3002,
  /** PC-PORT-06 squid egress-proxy listen (unpublished; reached via PROXY_SERVER). */
  squidContainer: 3128,
  /** PC-PORT-07 playwright-service listen (unpublished). */
  playwrightContainer: 3000,
} as const

/** The exactly-two published compose entries (§4.2 port-block discipline; lint asserts equality). */
export function publishedPortEntries(): string[] {
  return [
    `127.0.0.1:${PC_PORTS.searxngPublished.host}:${PC_PORTS.searxngPublished.container}`,
    `127.0.0.1:${PC_PORTS.firecrawlPublished.host}:${PC_PORTS.firecrawlPublished.container}`,
  ]
}

/** PC-ENV-01 base URL, re-derived from PC-PORT-01 by the PORT BLOCK (01c0 §17). */
export function searxngBaseUrl(): string {
  return `http://127.0.0.1:${PC_PORTS.searxngPublished.host}`
}

/** Engine names inside a SearXNG default settings.yml (two-space list entries). */
export function parseEngineNames(settingsText: string): string[] {
  const lines = settingsText.split("\n")
  let inEngines = false
  const names: string[] = []
  for (const line of lines) {
    if (/^engines:\s*$/.test(line)) {
      inEngines = true
      continue
    }
    if (inEngines && /^[A-Za-z]/.test(line)) break // next top-level key ends the block
    if (!inEngines) continue
    const m = line.match(/^ {2}-\s+name:\s*(\S+)\s*$/)
    if (m?.[1]) names.push(m[1])
  }
  return [...new Set(names)].sort()
}
