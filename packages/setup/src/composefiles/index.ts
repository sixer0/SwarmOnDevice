// swarm-setup compose-files renderer (row 85) — entry point of the render service.
//
// WHAT THIS IS, AND WHY IT IS NOT A SCANNED STEP (declared honestly):
// The dispatch brief named "directory-scan registration per skeleton". The landed scan
// contract (01c §9 + src/steps.ts validateDescriptor: the id must be a register PC-CMP-*
// component id AND equal the directory name) cannot host a `compose-files` step: registering
// one makes EVERY `install` fail-closed on a descriptor error, and hijacking `searxng`/
// `firecrawl` collides with rows 91/92's future component-step directories. 01c §9 names the
// sanctioned alternative — fetch/verify and the config writer are LIBRARIES/services, not
// scanned steps; row 84 resolved the identical constraint that way. This renderer therefore
// lives at src/composefiles/ as a service with its OWN standalone CLI: running it prints the
// registration status (project, stacks, lock version, artefact counts) — the "status output
// shows it" proof without touching the row-81 core.
//
// Contract summary for rows 91/92/93:
//   renderAll(lock, ctx)      — pure: compose files + settings.yml + nginx template +
//                               bin wraps + squid.conf + searxng.env; refuses on required-
//                               secret absence (§4.9) and on any lint finding incl. F-79-E.
//   applyRenderedFiles(res)   — atomic writes (row-81 atomic.ts) with §4.6/D-04 modes;
//                               returns the paths to record via kit.transition patch.
//   lintComposeText(text, o)  — the §4.9 rule set incl. F-79-E + gate additions.
//   validateRenderedSecrets() — placeholder refusal over owner-resolved values (P-8).
// Secrets are NEVER generated here: the SecretManifest interface (shared.ts) is the declared
// delegation to the generation owners (rows 84/86/91/92); this module renders their binds and
// refuses when a required slot is not declared generated (D-22: never mount what was not created).

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { atomicWriteText } from "../atomic.ts"
import { homeDir, tmpDir } from "../paths.ts"
import { validateLock, type LockFile } from "../lockfile.ts"
import { COMPOSE_PROJECT } from "../constants.ts"
import { OUTCOME, EXIT_OK, exitCodeFor, type OutcomeToken } from "../outcomes.ts"
import {
  RENDERER_NAME,
  SECRET_INVENTORY,
  contextErrors,
  joinAbs,
  normalizeContext,
  pathsFor,
  searxngBaseUrl,
  type NormalizedCtx,
  type RenderContext,
  type RenderError,
  type RenderFile,
} from "./shared.ts"
import { renderSearxngCompose } from "./searxng_compose.ts"
import { renderFirecrawlCompose } from "./firecrawl_compose.ts"
import { renderSearxngSettings } from "./searxng_settings.ts"
import { renderNginxTemplate, type NginxOptions } from "./nginx_template.ts"
import { renderBinScripts } from "./bin_scripts.ts"
import { renderSquidConf } from "./squid_conf.ts"
import { findReservedAclNames, findSecretArgvLeak, findSquidOrderingViolations, findWrapModeViolations, lintComposeText, lintOk, type Finding } from "./lint.ts"

export interface FullRender {
  readonly ok: boolean
  readonly files: RenderFile[]
  readonly findings: Finding[] // lint verdicts over the two rendered compose texts
  readonly errors: RenderError[]
  readonly warnings: string[]
  readonly enginePath: "image-settings" | "fallback-list-of-four"
}

/** Non-secret env file per §5.2: SEARXNG_BASE_URL only; CA line rides the F-79-B flag. */
function renderSearxngEnv(ctx: NormalizedCtx): RenderFile {
  const p = pathsFor(ctx.toolsRoot)
  const lines = [
    "# searxng.env — rendered by the swarm-setup compose-files renderer (row 85), 01e §5.2",
    "# NO secret values here (§4.6): the secret arrives via settings.yml's $SEARXNG_SECRET file substitution.",
    `SEARXNG_BASE_URL=${searxngBaseUrl()}  # PC-ENV-01, re-derived from PC-PORT-01 by the user PORT BLOCK (host 9021)`,
    ...(ctx.caBundlePath ? ["SSL_CERT_FILE=/etc/ssl/certs/swarm-ca.pem"] : []),
    "",
  ]
  return { relPath: "searxng/searxng.env", content: lines.join("\n"), mode: 0o600, stack: "searxng" }
}

export function renderAll(lock: LockFile, ctx: RenderContext, nginxOpts: NginxOptions = {}): FullRender {
  const preErrors = contextErrors(ctx)
  const nctx = normalizeContext(ctx)
  const refuse = (errors: RenderError[]): FullRender => ({
    ok: false,
    files: [],
    findings: [],
    errors,
    warnings: [],
    enginePath: nctx.enginePath,
  })
  if (preErrors.length > 0) return refuse(preErrors)

  const sx = renderSearxngCompose(lock, nctx)
  if (!sx.ok) return refuse(sx.errors)
  const fc = renderFirecrawlCompose(lock, nctx)
  if (!fc.ok) return refuse(fc.errors)
  const st = renderSearxngSettings(nctx)
  if (!st.ok) return refuse(st.errors)

  const files: RenderFile[] = [
    sx.file,
    fc.file,
    st.file,
    renderNginxTemplate(nginxOpts),
    renderSearxngEnv(nctx),
    renderSquidConf(),
    ...renderBinScripts(nctx),
  ]

  // F-79-E + full §4.9 gate: refuse to hand back anything that fails its own lint.
  // REVIEW-107 MAJOR-1 gate extended: the argv-leak scan covers EVERY rendered artefact
  // (compose + wraps + templates), so a future wrap edit that reintroduces a secret in an
  // exec'd argument cannot ship.
  const findings = [
    ...lintComposeText(sx.file.content, { lockVersion: lock.version }),
    ...lintComposeText(fc.file.content, { lockVersion: lock.version }),
    ...files.flatMap((f) => findSecretArgvLeak(f.content).map((x) => ({ ...x, message: `${f.relPath}: ${x.message}` }))),
    // REVIEW-107 MAJOR-2 (r75-fix4 handoff): the renderer's own squid output must satisfy
    // deny-before-allow for destination classes before it may ship.
    ...findSquidOrderingViolations(files.find((f) => f.relPath === "firecrawl/squid/squid.conf")?.content ?? "").map((x) => ({ ...x, message: `firecrawl/squid/squid.conf: ${x.message}` })),
    // R112-1: no declaration may squat a squid-PREDEFINED ACL name (boot FATAL class, live-proven).
    ...findReservedAclNames(files.find((f) => f.relPath === "firecrawl/squid/squid.conf")?.content ?? "").map((x) => ({ ...x, message: `firecrawl/squid/squid.conf: ${x.message}` })),
    // R112-5: wrap modes — zero group/world bits; entrypoint-executed wrap must be owner-executable.
    ...findWrapModeViolations(files),
  ]
  const ok = lintOk(findings)
  return { ok, files, findings, errors: [], warnings: [...st.warnings], enginePath: nctx.enginePath }
}

/** Write rendered files atomically under root (default ~/.swarm/tools, PC-PATH-07). Returns
 *  the written absolute paths for the caller's install manifest (kit.transition patch {paths}). */
export function applyRenderedFiles(result: FullRender, root?: string): string[] {
  if (!result.ok)
    throw new Error("compose-files renderer: refusing to apply an unclean render (fix lint findings first)")
  const base = root ?? joinAbs(homeDir(), ".swarm/tools")
  const written: string[] = []
  for (const f of result.files) {
    const abs = join(base, f.relPath)
    atomicWriteText(abs, f.content, f.mode)
    written.push(abs)
  }
  return written.sort()
}

/** P-8 placeholder refusal over OWNER-resolved values (generation itself is delegated;
 *  see SECRET_INVENTORY genHint). Call before substituting into settings.yml at apply time. */
export function validateRenderedSecrets(values: Readonly<Record<string, string>>): string[] {
  const problems: string[] = []
  if (values.secret_key !== undefined && (values.secret_key === "ultrasecretkey" || values.secret_key.trim() === "")) {
    problems.push("secret_key equals the upstream placeholder or is empty — refuse (P-8, 03e:185)")
  }
  if (values.postgres_password !== undefined && values.postgres_password === "postgres") {
    problems.push("postgres_password equals the upstream default — refuse (P-8 placeholder class, 01e §4.6)")
  }
  for (const name of ["proxy_token", "bull_auth_key", "redis_auth"] as const) {
    const v = values[name]
    if (v !== undefined && v.trim().length < 32)
      problems.push(`${name} shorter than 32 chars — regenerate with the §4.6 command`)
  }
  return problems
}

export { RENDERER_NAME, SECRET_INVENTORY }
export type { RenderContext, RenderFile, RenderError, Finding, NormalizedCtx }
export { lintComposeText, lintOk }

// --- standalone CLI: the registration/status surface (see header) -------------------

function loadLockFrom(path: string): { ok: true; lock: LockFile } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    return { ok: false, error: `cannot read lock: ${(err as Error).message}` }
  }
  return validateLock(parsed)
}

/** Lock resolution mirrors paths.resolveProgramDir: beside the executable when compiled
 *  (row 106 posture), else the package copy for source runs. */
function defaultLockPath(): string {
  const beside = join(dirname(process.execPath), "tools.lock.json")
  if (existsSync(beside)) return beside
  return join(import.meta.dir, "..", "..", "tools.lock.json")
}

function usage(): string {
  return [
    `${RENDERER_NAME} — swarm-setup compose-file renderer (row 85 service; NOT a scanned step — 01c §9 scan contract)`,
    "",
    "Usage:",
    "  bun run src/composefiles/index.ts status [--lock <path>]                print renderer registration",
    "  bun run src/composefiles/index.ts render [--out <dir>] [--home <dir>]   render the estate (dry-run writes to --out only)",
    "  bun run src/composefiles/index.ts lint   [--lock <path>]                lint the current render in-memory",
    "",
    "Exit codes follow gate D-23: 0 clean, 1 any refusal/finding.",
  ].join("\n")
}

function statusReport(lock: LockFile): OutcomeToken {
  console.log(`renderer: ${RENDERER_NAME} (row 85 service tree src/composefiles/)`)
  console.log(`registration: NOT a scanned step — 01c §9 restricts scanned directories to PC-CMP ids;`)
  console.log(`              this is a library/service like fetch (r82) and stepkit (r84), called by rows 91/92/93`)
  console.log(`project: ${COMPOSE_PROJECT} (PC-PROJ-01; two files, one project — 01e §3 ratified R-1)`)
  console.log(`lock version: ${lock.version} (PC-LBL-03 source; F-79-E asserts label equality)`)
  console.log(
    `stacks: searxng (${SECRET_INVENTORY.searxng.length} secret slots), firecrawl (${SECRET_INVENTORY.firecrawl.length} slots)`,
  )
  console.log(
    `artifacts: compose/searxng.yml, compose/firecrawl.yml, settings.yml, nginx/default.conf.template, searxng.env, squid/squid.conf, compose/bin/*`,
  )
  console.log(
    `engine path: auto — generated merge-prune list when the pinned image's settings.yml is supplied (row 92's docker tooling); else curated-four fallback [H] closed live by row 111`,
  )
  console.log(
    `lint rules: F-79-E version-label equality + §4.9 set + gate additions (named-volume ban both stacks, no literal ~, CA mount :ro)`,
  )
  console.log(`RESULT ${OUTCOME.OK}`)
  return OUTCOME.OK
}

function runCli(argv: readonly string[]): void {
  const verb = argv[0] ?? "status"
  if (verb === "--help" || verb === "help") {
    console.log(usage())
    process.exit(EXIT_OK)
  }
  const flagValue = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const lockPath = flagValue("--lock") ?? defaultLockPath()
  const loaded = loadLockFrom(lockPath)
  if (!loaded.ok) {
    console.error(`${RENDERER_NAME}: ${loaded.error}`)
    console.log(`RESULT ${OUTCOME.REFUSED_LOCK_MALFORMED}`)
    process.exit(exitCodeFor(OUTCOME.REFUSED_LOCK_MALFORMED))
  }
  const lock = loaded.lock

  if (verb === "status") {
    process.exit(exitCodeFor(statusReport(lock)))
  }

  if (verb === "render" || verb === "lint") {
    // CLI posture: every REQUIRED slot declared generated WITHOUT values (the renderer never
    // sees values), optionals absent. Real installs pass the owner's manifest programmatically.
    const secrets: Record<"searxng" | "firecrawl", Record<string, "generated">> = { searxng: {}, firecrawl: {} }
    for (const comp of ["searxng", "firecrawl"] as const) {
      for (const spec of SECRET_INVENTORY[comp]) if (spec.required) secrets[comp][spec.name] = "generated"
    }
    const home = flagValue("--home")
    const ctx: RenderContext = { secrets, ...(home ? { home } : {}) }
    const result = renderAll(lock, ctx)
    for (const w of result.warnings) console.error(`${RENDERER_NAME}: note — ${w}`)
    if (!result.ok) {
      for (const e of result.errors) console.error(`${RENDERER_NAME}: refuse [${e.code}] ${e.message}`)
      for (const f of result.findings)
        if (f.severity === "error") console.error(`${RENDERER_NAME}: lint [${f.rule}] ${f.line ?? "-"}: ${f.message}`)
      console.log(`RESULT ${OUTCOME.FAILED}`)
      process.exit(exitCodeFor(OUTCOME.FAILED))
    }
    if (verb === "lint") {
      console.log(
        `lint clean: ${result.files.length} artifacts, lock version ${lock.version}, engine-path ${result.enginePath}`,
      )
      console.log(`RESULT ${OUTCOME.OK}`)
      process.exit(EXIT_OK)
    }
    const outDir = flagValue("--out") ?? join(tmpDir(), "compose-render")
    const written = applyRenderedFiles(result, outDir)
    console.log(
      `rendered ${written.length} artifacts under ${outDir} (dry-run posture: temp only, nothing else touched):`,
    )
    for (const w of written) console.log(`  - ${w}`)
    console.log(`RESULT ${OUTCOME.OK}`)
    process.exit(EXIT_OK)
  }

  console.error(`${RENDERER_NAME}: unknown verb ${verb}\n${usage()}`)
  console.log(`RESULT ${OUTCOME.FAILED}`)
  process.exit(exitCodeFor(OUTCOME.FAILED))
}

// Run-as-main guard, calibrated against the probed Bun argv shapes (r81 precedent: args start
// at index 2 in BOTH postures): direct source run has argv[1]=.../composefiles/index.ts; the
// compiled binary has argv[1]=/$bunfs/root/<name>. Test/demo imports have a different argv[1]
// and therefore get the library without the CLI executing.
const entry = process.argv[1] ?? ""
if (entry.startsWith("/$bunfs/") || entry.endsWith("composefiles/index.ts")) {
  runCli(process.argv.slice(2))
}
