// Stack bring-up library (row 91) — the compose-project lifecycle mechanics shared by the
// searxng and firecrawl component steps.
//
// WHY A LIBRARY AND NOT A THIRD SCANNED STEP (r84/r85 precedent): 01c §9 restricts scanned
// step directories to the seven PC-CMP component ids, and one id serves the state key, the
// ~/.swarm/tools/<id> dir and the io.gsp.swarm.component label. Stack bring-up covers exactly
// TWO components (searxng PC-CMP-06 + firecrawl PC-CMP-07), so this row ships two step dirs
// (src/steps/searxng/, src/steps/firecrawl/) whose index.ts bodies delegate here; a
// "stack"/"compose-lifecycle" step dir would fail every install closed on a descriptor error,
// exactly the constraint rows 84/85 resolved the same way. The directory scan reads only
// step.json, so nothing inside a step dir beyond the descriptor is registered.
//
// REGISTER WIRING (all values imported, never re-spelled):
//   - `docker --context swarm`   PC-PROF-02 (DOCKER_CONTEXT) — never the user's current context (P-5/B2).
//                                EXCEPTION (H-R93-1/H-R93-2): the pre-bring-up CONTEXT PROBE is
//                                `docker context inspect <name>` with NO --context flag, and <name>
//                                follows the runtime step's RECORDED context (colima names it
//                                colima-<profile>), not this literal — see contextInspectArgs /
//                                resolveDockerContextName. Compose OPERATIONS keep pinning the register
//                                name, which row 86 materializes so both address the same daemon.
//   - `-p swarm-tools`           PC-PROJ-01 (COMPOSE_PROJECT) — two compose FILES, ONE project,
//                                ratified R-1 (01e §3); the CLI flag rides every invocation as
//                                belt-and-braces so a stray cwd cannot fork a third project.
//   - `-f <rendered file>`       per-stack scoping (01e §3): up/down of one stack touches only that
//                                file's objects even inside the shared project.
//   - labels                     PC-LBL-01/02 (LABELS) — the ONLY cleanup selector set (P-14):
//                                remove targets labelled objects exclusively, never by project,
//                                never a prune (the word never enters a built command; asserted
//                                in test/stack_steps.test.ts).
//   - states                     PC-ST-* via kit.transition only (single-writer A-73-3).
//
// PORT RULE (controller broadcast 2026-10-20 05:33, decisions.md PORT BLOCK — the installer's
// published ports are being renumbered; register amendment r72-fix2 -> r75-fix2 -> r85-fix IN
// FLIGHT): this module carries ZERO port literals. Published ports and host-side probe URLs are
// PARSED from the rendered compose artefact at runtime (parsePublishedPorts / healthProbeUrls), so
// a re-render with the amended ports needs no change here. The same rule applies to secret names
// (SECRET_INVENTORY, the 84-contract) and every path (pathsFor).
//
// ENTRYPOINT NOTE baked into the command design (r77b correction): the pinned ubuntu/squid rock's
// entrypoint is entrypoint.sh, NOT Pebble. The egress-proxy lift is CLEARED (controller re-fetch
// matched the confirmed index + linux-arm64 digests, equal to tools.lock.json
// components.firecrawl.egress_proxy_image — asserted by a unit test). Consequence for THIS row:
// bring-up stays entrypoint-agnostic — compose-level up plus a generic health gate. No
// Pebble-specific command, socket or wait logic exists anywhere in this row; whatever command form
// r85 rendered (currently the direct-squid override) is simply what compose starts.
//
// HEALTHCHECK CONTRACT (2026-10-20 ruling, decisions.md :40-47, closing R112b-3's host-side half):
// a service whose container declares NO healthcheck is satisfied by RUNNING **plus** a passing
// host-side readiness probe (the injected ReadinessProbe seam — this module never opens a socket,
// so the real HTTP/TCP prober is the row 93/111/112 driver's job). Up alone is NOT green anymore:
// the old §4.8 "rides on running-status" fallback would wave through exactly the images whose
// absence-of-tooling made the in-stack check blind. Services WITH a declared healthcheck keep the
// unchanged semantics (running + healthy). The gate stays file/label-scoped: it only ever probes
// containers compose ps listed for THIS stack's file. Rationale for probe-over-running: the images
// that ship without a healthcheck tool (no wget/curl in the pinned digests — R112b-3) are exactly
// the ones where "running" carries the least evidence, so the host-side check must add some.
//
// NO DAEMON IN THIS ROW: process execution lives exclusively in the engine-injected DockerRunner.
// This module never imports a process-spawn or raw-network builtin and never spawns; proofs and
// units drive the injected fake docker CLI shim (makeFakeDockerShim). Real spawn wiring is row 93.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { setTimeout as timerSleep } from "node:timers/promises"
import { dirname } from "node:path"
import {
  COMPOSE_PROJECT,
  DOCKER_CONTEXT,
  LABELS,
  MODES,
  PROGRAM_NAME,
  STATES,
  type ComponentId,
  type StateValue,
} from "./constants.ts"
import { OUTCOME, type OutcomeToken } from "./outcomes.ts"
import { secretsDir, setupRoot, toolsDir } from "./paths.ts"
import { SECRET_INVENTORY, pathsFor } from "./composefiles/shared.ts"
import type { LockFile } from "./lockfile.ts"
import type { StepKit } from "./stepkit.ts"
import type { StateFile, DockerObject } from "./state.ts"

// --- docker-runner seam ---------------------------------------------------------------

export interface DockerResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Executes one docker argv (NO program element — the runner supplies the binary). The ONLY way
 *  a stack step reaches a daemon. Injected so this row proves its logic against a fake shim;
 *  the real spawn-backed runner is engine-side (row 93 wiring). */
export type DockerRunner = (args: readonly string[]) => Promise<DockerResult>

/** Engine-side posture (r81 StepContext is frozen; rows 91+ widen it LOCALLY, never editing the
 *  template). The engine injects the spawn-backed runner; without one the steps refuse honestly
 *  instead of touching anything. `readiness` (2026-10-20 healthcheck-contract ruling) is the
 *  host-side prober for services that declare no container healthcheck — see ReadinessProbe. */
export interface StackStepContext {
  readonly docker?: DockerRunner
  readonly readiness?: ReadinessProbe
}

export function refusingRunner(_args: readonly string[]): Promise<DockerResult> {
  return Promise.resolve({
    exitCode: 127,
    stdout: "",
    stderr:
      "no docker runner injected: stack bring-up needs the engine-provided runner (row 93 wiring); this row never spawns a process itself",
  })
}

/** Engine-side guard shared by both stack steps: with no injected runner there is nothing to
 *  talk to, so the step refuses (FAILED) rather than pretend. Returns null when a runner exists. */
export function runnerGuard(ctx: StackStepContext): { token: OutcomeToken; message: string } | null {
  if (ctx.docker) return null
  return {
    token: OUTCOME.FAILED,
    message:
      "stack bring-up needs an engine-injected docker runner (StackStepContext.docker); none provided — refusing without touching docker",
  }
}

/** Firecrawl's egress-proxy (squid) lift is gated on a controller-confirmed digest pin (row 79
 *  §8 cond. 3 + the r78a ADDENDUM). This checks ONLY that the lock carries a digest-pinned value
 *  for components.firecrawl.egress_proxy_image — fail-closed on null/tag-only, mirroring the r85
 *  renderer's lockImage discipline. The exact equality to the cleared index/arm64 digests is
 *  asserted in test/stack_steps.test.ts against the controller-supplied reference, so no magic
 *  digest literal is baked into shipped code (read-from-lock principle, s85 §2). */
export function egressProxyPinReady(lock: LockFile): { ok: true; ref: string } | { ok: false; found: string } {
  const ref = lock.components.firecrawl?.egress_proxy_image
  if (typeof ref !== "string" || ref.trim() === "") return { ok: false, found: String(ref) }
  if (!ref.includes("@sha256:")) return { ok: false, found: `${ref} (no @sha256 digest)` }
  return { ok: true, ref }
}

// --- plan -------------------------------------------------------------------------------

export interface StackPlan {
  readonly component: "searxng" | "firecrawl"
  /** Absolute path of the r85-rendered compose file for THIS stack (pathsFor(...)). */
  readonly composeFile: string
  /** Display title for log lines. */
  readonly title: string
}

export function searxngPlan(home?: string): StackPlan {
  return { component: "searxng", composeFile: pathsFor(toolsRootFor(home)).searxngCompose, title: "SearXNG stack" }
}

export function firecrawlPlan(home?: string): StackPlan {
  return {
    component: "firecrawl",
    composeFile: pathsFor(toolsRootFor(home)).firecrawlCompose,
    title: "Firecrawl stack",
  }
}

/** Collapse duplicate path separators (the only anomaly a stray/double-slash HOME introduces here —
 *  no `..` segments are ever built). Used to keep the bind-source whitelist prefix test honest when
 *  r85's joinAbs leaves a HOME like `/x//y` unnormalized in a rendered source while path.join would
 *  collapse it. Kept local so this row adds nothing to the row-81-owned node:path ambient decls. */
function collapseSlashes(p: string): string {
  return p.replace(/\/{2,}/g, "/")
}

function toolsRootFor(home?: string): string {
  // paths.ts resolves $HOME per call; home override exists so tests/dry-runs pin it. Collapsed so a
  // HOME with a stray trailing/double slash cannot skew the whitelist prefix test downstream.
  return collapseSlashes(home ? `${home}/.swarm/tools` : toolsDir())
}

// --- command builders (pure; every proof of scoping runs over these) ---------------------

// Docker Compose's OWN resource labels (set by compose on every network/container it creates). These
// are external-tool constants, not register PC-* values — cited to the compose CLI/docs, spelled once
// here so no call site re-types them. Used only to scope `network ls` per stack inside the shared
// swarm-tools project (networks carry no io.gsp.swarm.* labels because the rendered compose does not
// set them on networks).
const COMPOSE_NETWORK_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_NETWORK_CONFIG_LABEL = "com.docker.compose.project.config_files";

function composeBase(composeFile: string): string[] {
  // PC-PROF-02 explicit context FIRST; PC-PROJ-01 explicit -p; per-stack -f scoping (01e §3).
  return ["--context", DOCKER_CONTEXT, "compose", "-p", COMPOSE_PROJECT, "-f", composeFile]
}

export function composeUpCmd(composeFile: string): string[] {
  // --pull never: images are content-pinned and pre-pulled by the VM bring-up rows (01e §3);
  // the daemon enforces the digest, a silent drift can never happen at up time.
  return [...composeBase(composeFile), "up", "-d", "--pull", "never"]
}

export function composeDownCmd(composeFile: string): string[] {
  return [...composeBase(composeFile), "down"]
}

export function composePsArgs(composeFile: string): string[] {
  return [...composeBase(composeFile), "ps", "--format", "{{.Name}}={{.State}}={{.Health}}"]
}

/** List THIS stack's networks with the SUPPORTED plain-docker verb `network ls`, scoped by the
 *  compose project + config-file labels. Docker Compose v5.6.0 (pinned: tools.lock.json
 *  components.runtime.docker_compose; 02d §6:40/220) documents NO `compose networks` subcommand —
 *  its subcommand set is attach/build/commit/config/convert/cp/create/down/events/exec/export/
 *  images/kill/logs/ls/pause/port/ps/publish/pull/push/restart/rm/run/scale/start/stats/stop/top/
 *  unpause/up/version/volumes/wait/watch (docs.docker.com/reference/cli/docker/compose/); `ls` lists
 *  PROJECTS, not networks. The old `compose … networks` argv was rejected live as `unknown docker
 *  command: "networks"` (R111-1). Networks carry compose's OWN labels (the rendered compose declares
 *  no io.gsp.swarm.* on them), so per-stack scoping inside the shared swarm-tools project uses
 *  com.docker.compose.project + .project.config_files = this file (compose stamps both on every
 *  network it creates). Name kept as `composeNetworksArgs` for API stability with the r93/r111
 *  drivers that import it; the emitted verb is now plain `docker network ls`. */
export function composeNetworksArgs(composeFile: string): string[] {
  return [
    "--context", DOCKER_CONTEXT, "network", "ls",
    "--filter", `label=${COMPOSE_NETWORK_PROJECT_LABEL}=${COMPOSE_PROJECT}`,
    "--filter", `label=${COMPOSE_NETWORK_CONFIG_LABEL}=${composeFile}`,
    "--format", "{{.Name}}",
  ];
}

/** `docker context inspect <name>` — the pre-bring-up probe that the target context exists.
 *  NO leading `--context` global flag: that flag selects the endpoint for OTHER subcommands, so
 *  prefixed here the CLI parses `--context context` + `inspect <name>` and real docker rejects it
 *  ("unable to resolve docker endpoint: context \"context\": context not found" — H-R93-2, proven on
 *  r93's live VM; the offline fake shim never validated argv so it stayed latent). The name is
 *  resolved from the runtime step's RECORDED context (resolveDockerContextName), not the register
 *  literal, because colima 0.10.3 names the context for `--profile swarm` as `colima-swarm`
 *  (H-R93-1). Default keeps the register constant so external callers and offline runs are unchanged. */
export function contextInspectArgs(contextName: string = DOCKER_CONTEXT): string[] {
  return ["context", "inspect", contextName]
}

/** Resolve the docker context name to PROBE from the runtime step's recorded state rather than
 *  assuming the register literal. colima names the live context `colima-<profile>` (H-R93-1); once
 *  row 86 records it in its dockerObjects (`{kind:"docker-context", id:<live name>}`) this returns
 *  that. With nothing recorded (offline runs, or before row 86's naming fix lands) it falls back to
 *  the register constant DOCKER_CONTEXT — which row 86 guarantees resolves to a real context
 *  (create-or-rename), so the probe never targets a phantom. The compose OPERATIONS keep pinning
 *  the register name via `--context` (PC-PROF-02); only this diagnostic probe follows the recorded
 *  name, so the two agree on any host where row 86 materializes the register context. */
export function resolveDockerContextName(state: StateFile): string {
  const objects = state.components.runtime?.dockerObjects ?? []
  for (const o of objects) {
    if (o.kind === "docker-context" || o.kind === "docker_context" || o.kind === "context") return o.id
  }
  return DOCKER_CONTEXT
}

/** Label-scoped listing: managed=true AND component=<id> (PC-LBL-01+02). This is the ONLY
 *  selector remove uses — never project-wide, never a prune (P-14). */
export function labelListArgs(kind: "container" | "network" | "volume" | "image", component: ComponentId): string[] {
  return [
    "--context",
    DOCKER_CONTEXT,
    kind,
    "ls",
    "-a",
    "--filter",
    `label=${LABELS.MANAGED_KEY}=${LABELS.MANAGED_VALUE}`,
    "--filter",
    `label=${LABELS.COMPONENT_KEY}=${component}`,
    "--format",
    "{{.ID}}",
  ]
}

export function containerInspectArgs(id: string): string[] {
  return [
    "--context",
    DOCKER_CONTEXT,
    "inspect",
    "--format",
    "{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
    id,
  ]
}

export function containerRmArgs(id: string): string[] {
  return ["--context", DOCKER_CONTEXT, "rm", id]
}

export function networkRmArgs(id: string): string[] {
  return ["--context", DOCKER_CONTEXT, "network", "rm", id]
}

export function imageRmArgs(id: string): string[] {
  return ["--context", DOCKER_CONTEXT, "rmi", id]
}

/** Volumes are NEVER auto-deleted: this builder produces the printed instruction only
 *  (ask-before-data-volume, P-14). No caller executes it inside swarm-setup. */
export function volumeRmCmd(id: string): string[] {
  return ["--context", DOCKER_CONTEXT, "volume", "rm", id]
}

export function formatCmd(args: readonly string[]): string {
  return ["docker", ...args].join(" ")
}

// --- rendered-artefact parsers (PORT RULE: ports/URLs come FROM the artefact, never literals) --

export interface PublishedPort {
  readonly service: string
  readonly hostIp: string
  readonly hostPort: string
  readonly containerPort: string
}

/** Extract `"<ip>:<host>:<container>"` publishes with their owning service names from compose
 *  text. Indent-based, matching the r85 renderer's shape (services at indent 2, keys at 4). */
export function parsePublishedPorts(composeText: string): PublishedPort[] {
  const out: PublishedPort[] = []
  let service = ""
  for (const line of composeText.split("\n")) {
    const svc = line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/)
    if (svc) service = svc[1] ?? ""
    const pub = line.match(/^ {6}-\s*"([^":]+):(\d+):(\d+)"/)
    if (pub && service) out.push({ service, hostIp: pub[1] ?? "", hostPort: pub[2] ?? "", containerPort: pub[3] ?? "" })
  }
  return out
}

/** Host-side probe URLs derived from the artefact's loopback publishes (P-15 gates: SearXNG JSON
 *  query / Firecrawl readiness — the live HTTP probes themselves are row 93/111/112 work). */
export function healthProbeUrls(composeText: string): string[] {
  return parsePublishedPorts(composeText).map((p) => `http://${p.hostIp}:${p.hostPort}/`)
}

/** Long-form bind sources and env_file entries the compose file references — the fail-fast set
 *  (r85 handoff: bring-up must not let dockerd auto-create root-owned dirs over virtiofs).
 *  Matches the renderer's deterministic shape: `source:` keys and block-sequence `- /abs` env_file
 *  entries, at any indent. A candidate containing `:` is a tmpfs spec (`/path:opts`), NOT a host
 *  bind, so it is excluded — checking one would raise a spurious outside-whitelist gap. */
export function parseBindSources(composeText: string): string[] {
  const out: string[] = []
  for (const line of composeText.split("\n")) {
    const src = line.match(/^\s+source:\s*(\S+)/)
    if (src?.[1]) out.push(src[1])
    const env = line.match(/^\s+-\s*(\/\S+)/) // env_file entry (ports are quoted; tmpfs carries a colon)
    if (env?.[1]) out.push(env[1])
  }
  return [...new Set(out.filter((p) => !p.includes(":")))]
}

// --- preconditions (fail-closed; pure — zero docker, zero writes) ------------------------

export interface PreconditionGap {
  readonly code:
    | "RUNTIME_NOT_HEALTHY"
    | "COMPONENT_SKIPPED"
    | "COMPONENT_NOT_READY"
    | "SECRET_MISSING"
    | "ARTEFACT_MISSING"
    | "BIND_SOURCE_MISSING"
    | "BIND_SOURCE_OUTSIDE_WHITELIST"
  readonly item: string
  readonly hint: string
}

export interface PreconditionReport {
  readonly ok: boolean
  readonly gaps: PreconditionGap[]
  /** Bind sources that may be created as 0700 dirs (writable cache/log mounts under the tools root). */
  readonly creatableDirs: string[]
  readonly composeText?: string
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}

/** Check the state gate, the 84-contract secret inventory, the rendered artefact and every bind
 *  source. Pure: reads only. Lists EVERY gap (fail-closed listing, per brief). */
export function checkPreconditions(plan: StackPlan, state: StateFile, home?: string): PreconditionReport {
  const gaps: PreconditionGap[] = []

  const runtimeState = state.components.runtime?.state ?? STATES.ABSENT
  if (runtimeState !== STATES.HEALTHY) {
    gaps.push({
      code: "RUNTIME_NOT_HEALTHY",
      item: `runtime state is "${runtimeState}"`,
      hint: "the container-runtime step (row 86) must reach healthy before any stack comes up (01c §4 lifecycle)",
    })
  }

  // Honour the component's own lifecycle position. Bring-up is the configured->healthy move: it
  // assumes the config artefacts + secrets are already in place (that IS the "configured" stage,
  // owned by the render/secret owners this row consumes). States before that are not ready; a
  // deliberate `skipped` (memory floor decision 12 / deselection) is refused outright — bring-up
  // must never resurrect a skipped component; `healthy` is an idempotent re-run (handled upstream).
  const selfState = state.components[plan.component]?.state ?? STATES.ABSENT
  if (selfState === STATES.SKIPPED) {
    gaps.push({
      code: "COMPONENT_SKIPPED",
      item: `${plan.component} state is "skipped"`,
      hint: "the component was deliberately skipped (memory floor / deselected); bring-up refuses to override that — re-enable it through its owning row first",
    })
  } else if (selfState !== STATES.CONFIGURED && selfState !== STATES.HEALTHY) {
    gaps.push({
      code: "COMPONENT_NOT_READY",
      item: `${plan.component} state is "${selfState}"`,
      hint: "bring-up drives configured->healthy; the config/secrets stage must land the component at configured first (this row consumes rendered artefacts, it does not create them)",
    })
  }

  for (const spec of SECRET_INVENTORY[plan.component]) {
    if (!spec.required) continue // D-22: optional slots render only when generated — absence is a valid state
    const target = home
      ? `${secretsDirFor(home, plan.component)}/${spec.name}`
      : `${secretsDir(plan.component)}/${spec.name}`
    if (!existsSync(target)) {
      gaps.push({
        code: "SECRET_MISSING",
        item: `required secret ${target}`,
        hint: `owner generates it (${spec.genHint}) and declares it in the render manifest (01e §4.6 / D-04)`,
      })
      continue
    }
    if ((fileMode(target) & 0o077) !== 0) {
      gaps.push({
        code: "SECRET_MISSING",
        item: `secret ${target} mode ${fileMode(target).toString(8)} (group/other bits set)`,
        hint: "D-04 requires 0600 in a 0700 dir — fix the mode before bring-up",
      })
    } else if (readFileSync(target, "utf8").trim() === "") {
      gaps.push({
        code: "SECRET_MISSING",
        item: `secret ${target} is empty`,
        hint: "an empty secret is an unset secret (P-8 placeholder class)",
      })
    }
  }

  if (!existsSync(plan.composeFile)) {
    gaps.push({
      code: "ARTEFACT_MISSING",
      item: plan.composeFile,
      hint: "render via the row-85 compose-files renderer (renderAll + applyRenderedFiles) before bring-up; this row consumes the artefact, it never re-renders",
    })
    return { ok: false, gaps, creatableDirs: [] }
  }

  const composeText = readFileSync(plan.composeFile, "utf8")
  // Normalize both sides before the whitelist prefix test: r85's joinAbs leaves a HOME containing
  // a double slash unnormalized in the rendered source, while path.join collapses it — comparing
  // raw strings would then mis-flag an in-whitelist bind as outside it.
  const root = collapseSlashes(toolsRootFor(home))
  const creatableDirs: string[] = []
  for (const raw of parseBindSources(composeText)) {
    const src = collapseSlashes(raw)
    if (existsSync(src)) continue
    if (!src.startsWith(`${root}/`)) {
      gaps.push({
        code: "BIND_SOURCE_OUTSIDE_WHITELIST",
        item: src,
        hint: "bind source outside ~/.swarm/tools — refuse (P-16 whitelist; r85 renders absolute in-whitelist sources only)",
      })
      continue
    }
    // A missing WRITABLE dir (cache/logs) under the owner's own tools tree is created 0700 at
    // bring-up; anything file-like (settings/env/template/bin/squid/secret) must already exist —
    // failing fast beats dockerd auto-creating root-owned dirs over virtiofs (r85 handoff).
    if (isWritableDirSource(src)) creatableDirs.push(src)
    else
      gaps.push({
        code: "BIND_SOURCE_MISSING",
        item: src,
        hint: "generated config/bin/secret file missing — the owning step must create it first (D-22: never mount what was not created)",
      })
  }

  return { ok: gaps.length === 0, gaps, creatableDirs, composeText }
}

function secretsDirFor(home: string, component: ComponentId): string {
  return `${home}/.swarm/tools/${component}/secrets`
}

/** Directories the stacks legitimately create-at-runtime (cache/log mounts): no file extension
 *  and named cache|logs under the component tree. Everything else file-like must pre-exist. */
function isWritableDirSource(src: string): boolean {
  const tail = src.split("/").slice(-2).join("/")
  return !/\.[A-Za-z0-9]+$/.test(src) && (tail.endsWith("cache") || tail.endsWith("logs"))
}

/** Create the whitelisted writable bind dirs (0700, owner-side, idempotent). Never called under
 *  --dry-run (dry-run performs ZERO filesystem writes). */
export function ensureCreatableDirs(creatableDirs: readonly string[]): void {
  for (const dir of creatableDirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: MODES.DIR_0700 })
  }
}

// --- health gate --------------------------------------------------------------------------

export interface ContainerStatus {
  readonly name: string
  readonly running: boolean
  /** undefined = the image declares no healthcheck (gate falls back to running-status). */
  readonly health?: string
}

/** Parse `compose ps --format {{.Name}}={{.State}}={{.Health}}` output. "<none>"/empty health =
 *  no healthcheck declared. */
export function parseComposePs(text: string): ContainerStatus[] {
  const out: ContainerStatus[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/^([^=]+)=(\w+)=?(.*)$/)
    if (!m) continue
    const rawHealth = (m[3] ?? "").trim()
    const health = rawHealth === "" || rawHealth === "<none>" ? undefined : rawHealth
    out.push({ name: m[1] ?? "", running: (m[2] ?? "") === "running", ...(health ? { health } : {}) })
  }
  return out
}

export function parseContainerInspect(output: string): ContainerStatus | null {
  const parts = output.trim().split(/\s+/)
  if (parts.length === 0 || parts[0] === "") return null
  const health = parts[1]
  return { name: "", running: parts[0] === "true", ...(health && health !== "<none>" ? { health } : {}) }
}

// --- host-side readiness probe seam (2026-10-20 healthcheck-contract ruling, R112b-3 half) ------

export interface ReadinessTarget {
  /** Compose service name derived from the container name (serviceFromContainerName). */
  readonly service: string
  /** Exact container name as compose ps reported it — the label/file-scoped identity to probe. */
  readonly container: string
  /** Host-side probe URLs for this service parsed FROM the artefact (parsePublishedPorts); empty
   *  when the service publishes no host port — unpublished services need an exec/TCP-class probe,
   *  which is why the container name rides along (row 93/111/112 owns that implementation). */
  readonly urls: readonly string[]
}

export interface ReadinessResult {
  readonly ok: boolean
  readonly detail: string
}

/** One host-side readiness check for one no-healthcheck container. Injected because this module
 *  never opens a socket and never spawns (P4b grep gate; module header): the real HTTP-or-TCP
 *  prober is engine-side, offline units inject a fake. Per the spec's health matrix (§4.8) the
 *  checks are SearXNG JSON query 200 / Firecrawl readiness endpoint — HTTP where a published
 *  loopback port exists, TCP-class otherwise (the implementer's choice per target). */
export type ReadinessProbe = (target: ReadinessTarget) => Promise<ReadinessResult>

/** Compose names managed containers `<project>-<service>-<ordinal>`; recover the service name to
 *  look up artefact-derived probe URLs. Names outside that shape fall back to themselves (the
 *  probe still receives the exact container identity). */
export function serviceFromContainerName(name: string): string {
  const bare = name.startsWith(`${COMPOSE_PROJECT}-`) ? name.slice(COMPOSE_PROJECT.length + 1) : name
  const ordinal = bare.match(/^(.*)-\d+$/)
  return ordinal?.[1] ? ordinal[1] : bare
}

/** Probe URLs grouped by compose SERVICE (same URL shape healthProbeUrls flattens), so a
 *  no-healthcheck container maps to its own publishes only. Artefact-derived — PORT RULE holds. */
export function serviceProbeUrls(composeText: string): Map<string, string[]> {
  const byService = new Map<string, string[]>()
  for (const p of parsePublishedPorts(composeText)) {
    const urls = byService.get(p.service) ?? []
    urls.push(`http://${p.hostIp}:${p.hostPort}/`)
    byService.set(p.service, urls)
  }
  return byService
}

export interface HealthVerdict {
  readonly healthy: boolean
  readonly detail: string
  readonly unhealthy: string[]
}

/** Gate form (entrypoint-agnostic on purpose — squid runs via entrypoint.sh per r77b, nothing
 *  Pebble-specific is assumed): every container RUNNING; every DECLARED healthcheck HEALTHY; and
 *  every container WITHOUT a declared healthcheck additionally holding a passing host-side
 *  readiness result (2026-10-20 ruling supersedes the old §4.8 rides-on-running fallback — Up
 *  alone is not green for a service the in-stack check cannot see). A missing readiness entry is
 *  fail-closed: no probe wired is stated as such, naming the service. `readiness` is keyed by
 *  container name; pass undefined when every container declares a healthcheck. */
export function healthVerdict(
  containers: readonly ContainerStatus[],
  readiness?: ReadonlyMap<string, ReadinessResult>,
): HealthVerdict {
  if (containers.length === 0) return { healthy: false, detail: "compose ps returned no containers", unhealthy: [] }
  const reason = (c: ContainerStatus): string | null => {
    if (!c.running) return "not-running"
    if (c.health !== undefined) return c.health === "healthy" ? null : c.health
    const probe = readiness?.get(c.name)
    if (probe === undefined) return "no-healthcheck+readiness-probe-missing"
    return probe.ok ? null : `no-healthcheck+readiness-failed(${probe.detail})`
  }
  const unhealthy = containers.filter((c) => reason(c) !== null)
  if (unhealthy.length > 0) {
    const listed = unhealthy.map((c) => `${c.name}:${reason(c)}`).join(", ")
    return {
      healthy: false,
      detail: `waiting on ${unhealthy.length}/${containers.length}: ${listed}`,
      unhealthy: unhealthy.map((c) => c.name),
    }
  }
  const probed = containers.filter((c) => c.health === undefined).length
  const suffix =
    probed === 0
      ? containers.some((c) => c.health !== undefined)
        ? " with declared healthchecks green"
        : " (no in-stack healthchecks declared)"
      : ` with ${probed} container(s) without healthchecks satisfied by host-side readiness probes`
  return { healthy: true, detail: `all ${containers.length} containers running${suffix}`, unhealthy: [] }
}

export interface HealthWait {
  readonly token: OutcomeToken
  readonly verdict: HealthVerdict
  readonly containers: ContainerStatus[]
  readonly attempts: number
  readonly elapsedMs: number
}

/** Wait loop with deadline. sleep/clock are injected so a timeout is testable in milliseconds;
 *  production defaults are real time. Timeout maps to HEALTH_FAILED (frozen D-23 token set —
 *  BLOCKED_BY_NETWORK stays reserved for network-block, see outcomes.ts); a container that is
 *  NOT RUNNING fails fast instead of waiting out the window. Each poll additionally runs the
 *  injected readiness probe once per RUNNING container that declares no healthcheck (2026-10-20
 *  ruling); with no probe wired those containers stay red — fail-closed, named in the verdict.
 *  The timeout/poll budget is unchanged in spirit: probes ride inside the same window, their own
 *  latency bound is the probe implementation's contract (row 93/111/112). */
export async function waitForHealthy(opts: {
  readonly run: DockerRunner
  readonly composeFile: string
  readonly deadlineMs: number
  readonly intervalMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly clock?: () => number
  readonly probe?: ReadinessProbe
  /** Rendered compose text for artefact-derived probe URLs (PORT RULE); "" probes see no urls. */
  readonly composeText?: string
}): Promise<HealthWait> {
  const sleep = opts.sleep ?? ((ms: number) => timerSleep(ms))
  const clock = opts.clock ?? (() => Date.now())
  const intervalMs = opts.intervalMs ?? 2000
  const urlsByService = serviceProbeUrls(opts.composeText ?? "")
  const start = clock()
  let attempts = 0
  let last: HealthVerdict = { healthy: false, detail: "health gate never polled", unhealthy: [] }
  let containers: ContainerStatus[] = []

  for (;;) {
    attempts += 1
    const ps = await opts.run(composePsArgs(opts.composeFile))
    containers = ps.exitCode === 0 ? parseComposePs(ps.stdout) : []
    const readiness = new Map<string, ReadinessResult>()
    for (const c of containers) {
      if (!c.running || c.health !== undefined || !opts.probe) continue
      const service = serviceFromContainerName(c.name)
      readiness.set(
        c.name,
        await opts.probe({ service, container: c.name, urls: urlsByService.get(service) ?? [] }),
      )
    }
    last = healthVerdict(containers, readiness)
    if (last.healthy) return { token: OUTCOME.OK, verdict: last, containers, attempts, elapsedMs: clock() - start }
    const crashed = containers.length > 0 && containers.some((c) => !c.running)
    if (crashed)
      return { token: OUTCOME.HEALTH_FAILED, verdict: last, containers, attempts, elapsedMs: clock() - start }
    if (clock() - start >= opts.deadlineMs)
      return { token: OUTCOME.HEALTH_FAILED, verdict: last, containers, attempts, elapsedMs: clock() - start }
    await sleep(intervalMs)
  }
}

// --- provenance per bring-up ------------------------------------------------------------

export const STACK_PROVENANCE_FILE_NAME = "stack-provenance.jsonl"

export interface StackProvenanceRecord {
  readonly ts: string
  readonly lockVersion: string
  readonly component: ComponentId
  /** GREEN-ONLY verbs are bare. R112b-7 truthfulness ruling: a failed phase must not read as a
   *  plain "up"/"down" — the vocabulary is `up` (ended OK) | `up-failed` (FAILED/HEALTH_FAILED) |
   *  `down` (ended OK) | `down-incomplete` (compose-down failure or deferred volumes). The exact
   *  reason stays in `outcome`; a reader scanning for brought-up stacks can no longer count a
   *  HEALTH_FAILED row as an "up". */
  readonly action: "up" | "up-failed" | "down" | "down-incomplete"
  readonly project: typeof COMPOSE_PROJECT
  readonly context: string // the ACTUAL probed context name (resolveDockerContextName), not necessarily the register literal
  readonly composeFile: string
  readonly outcome: OutcomeToken
  readonly exitCode: number
  readonly attempts: number
  readonly elapsedMs: number
  readonly healthDetail: string
  readonly containers: string[]
  readonly deferredVolumes: string[]
  readonly correlationId?: string
  /** Teardown only: networks this stack lost, measured as a before/after listing delta
   *  (R112b-7: the old post-state count printed 0 while down had removed five).
   *  null = a listing leg failed and the count is honestly unavailable, never a fabricated 0. */
  readonly networksRemoved?: number | null
}

export function stackProvenanceFile(): string {
  return `${setupRoot()}/${STACK_PROVENANCE_FILE_NAME}`
}

/** One JSONL row per bring-up/teardown ATTEMPT SEQUENCE (success or failure), same ledger rules
 *  as provenance.jsonl (dir 0700 / file 0600, single writer under the lock dir). Own file on
 *  purpose: provenance.ts (row-81 owned) fixes a fetch-shaped schema; inventing fields there
 *  would edit a module outside this row. NEVER contains secret values (P-8) — ids, counts, tokens-names only. */
export function appendStackProvenance(record: StackProvenanceRecord, absPath: string = stackProvenanceFile()): void {
  if (!existsSync(absPath)) mkdirSync(dirname(absPath), { recursive: true, mode: MODES.DIR_0700 })
  appendFileSync(absPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: MODES.FILE_0600 })
}

export function readStackProvenanceRecords(
  absPath: string = stackProvenanceFile(),
): Array<StackProvenanceRecord | null> {
  if (!existsSync(absPath)) return []
  return readFileSync(absPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as StackProvenanceRecord
      } catch {
        return null
      }
    })
}

// --- bring-up orchestration --------------------------------------------------------------

export interface BringUpOptions {
  readonly kit: StepKit
  readonly plan: StackPlan
  readonly run?: DockerRunner
  readonly sleep?: (ms: number) => Promise<void>
  readonly clock?: () => number
  /** Health-gate window. Defaults are generous for cold pulls-free starts (--pull never); live
   *  tuning belongs to row 93's VM runs. */
  readonly healthDeadlineMs?: number
  readonly healthIntervalMs?: number
  /** Host-side prober for services declaring no container healthcheck (2026-10-20 ruling).
   *  Absent = those containers can never satisfy the gate (fail-closed, named per service). */
  readonly readiness?: ReadinessProbe
}

export interface BringUpResult {
  readonly token: OutcomeToken
  readonly message: string
  readonly missing: PreconditionGap[]
  readonly commands: string[]
  readonly healthUrls: string[]
  readonly attempts: number
}

/** install-path: consent -> preconditions -> (dry-run: print exact commands, ZERO exec/writes)
 *  -> context probe -> up -d --pull never -> health gate -> healthy transition + provenance.
 *  A health timeout records FAILED with the unhealthy list — no MCP/config entry is ever written
 *  from here (P-15: entries land only at healthy, owned by row 97). */
export async function bringUp(opts: BringUpOptions): Promise<BringUpResult> {
  const { kit, plan } = opts
  const run = opts.run ?? refusingRunner
  const report = checkPreconditions(plan, kit.state)

  if (!kit.hasConsent()) {
    return {
      token: OUTCOME.REFUSED_NO_CONSENT,
      message: `no recorded consent for ${plan.component}; nothing asked of docker`,
      missing: [],
      commands: [],
      healthUrls: [],
      attempts: 0,
    }
  }
  if (!report.ok) {
    const listing = report.gaps.map((g) => `[${g.code}] ${g.item} — ${g.hint}`).join("\n")
    kit.log("error", `${plan.component}: preconditions failed closed (${report.gaps.length} gap(s))`, {
      context: { gaps: report.gaps.map((g) => `${g.code}: ${g.item}`) },
    })
    return {
      token: OUTCOME.FAILED,
      message: `preconditions not met for ${plan.component}:\n${listing}`,
      missing: report.gaps,
      commands: [],
      healthUrls: [],
      attempts: 0,
    }
  }

  const selfState = kit.stateOf().state
  // Idempotent re-run: an already-healthy stack needs no daemon round-trip at all.
  if (selfState === STATES.HEALTHY) {
    return {
      token: OUTCOME.OK,
      message: `${plan.title} already healthy; nothing to do`,
      missing: [],
      commands: [],
      healthUrls: healthProbeUrls(report.composeText ?? ""),
      attempts: 0,
    }
  }

  const urls = healthProbeUrls(report.composeText ?? "")
  const upCmd = formatCmd(composeUpCmd(plan.composeFile))
  const healthLine = `${formatCmd(composePsArgs(plan.composeFile))}  # repeated until every container running; declared healthchecks green; no-healthcheck services additionally pass their host-side readiness probe`
  // The probe target follows the runtime step's RECORDED context (colima names it colima-<profile>,
  // H-R93-1); compose OPERATIONS below still pin the register name via --context (PC-PROF-02), which
  // row 86 materializes — so both address the same live daemon once row 86 lands.
  const ctxName = resolveDockerContextName(kit.state)
  const ctxProbeCmd = formatCmd(contextInspectArgs(ctxName))

  if (kit.dryRun) {
    // Dry-run prints the EXACT commands and does nothing else: no runner call, no mkdir, no
    // provenance line, no committed state (kit records in-memory markers only).
    const commands = [ctxProbeCmd, upCmd, healthLine]
    for (const c of commands) kit.log("info", `${plan.component} dry-run: ${c}`)
    kit.transition(STATES.HEALTHY)
    return {
      token: OUTCOME.OK,
      message: `dry-run ${plan.component}: would run ${commands.length} command(s); touched nothing`,
      missing: [],
      commands,
      healthUrls: urls,
      attempts: 0,
    }
  }

  kit.log(
    "info",
    `${plan.component}: bring-up starting under project ${COMPOSE_PROJECT} (two files, one project — 01e §3 R-1)`,
  )
  ensureCreatableDirs(report.creatableDirs)

  const startedAt = Date.now()
  const ctxRes = await run(contextInspectArgs(ctxName))
  if (ctxRes.exitCode !== 0) {
    commitFailure(kit)
    kit.log("error", `${plan.component}: docker context "${ctxName}" unavailable`, {
      context: { stderr: ctxRes.stderr.trim().slice(0, 300) },
    })
    recordBringUp(
      opts,
      OUTCOME.FAILED,
      ctxRes.exitCode,
      0,
      Date.now() - startedAt,
      `context probe failed: ${ctxRes.stderr.trim().slice(0, 200)}`,
      [],
      [],
      ctxName,
    )
    return {
      token: OUTCOME.FAILED,
      message: `docker context "${ctxName}" not reachable (runtime step owns profile creation): ${ctxRes.stderr.trim().slice(0, 200)}`,
      missing: [],
      commands: [ctxProbeCmd],
      healthUrls: urls,
      attempts: 1,
    }
  }

  const upRes = await run(composeUpCmd(plan.composeFile))
  if (upRes.exitCode !== 0) {
    commitFailure(kit)
    kit.log("error", `${plan.component}: compose up failed`, { context: { stderr: upRes.stderr.trim().slice(0, 300) } })
    recordBringUp(
      opts,
      OUTCOME.FAILED,
      upRes.exitCode,
      1,
      Date.now() - startedAt,
      `compose up exited ${upRes.exitCode}`,
      [],
      [],
      ctxName,
    )
    return {
      token: OUTCOME.FAILED,
      message: `compose up failed (exit ${upRes.exitCode}): ${upRes.stderr.trim().slice(0, 300)}`,
      missing: [],
      commands: [ctxProbeCmd, upCmd],
      healthUrls: urls,
      attempts: 1,
    }
  }

  const wait = await waitForHealthy({
    run,
    composeFile: plan.composeFile,
    deadlineMs: opts.healthDeadlineMs ?? 120_000,
    intervalMs: opts.healthIntervalMs ?? 2_000,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.readiness ? { probe: opts.readiness } : {}),
    composeText: report.composeText ?? "",
  })

  if (wait.token !== OUTCOME.OK) {
    commitFailure(kit)
    kit.log("error", `${plan.component}: health gate did not go green`, {
      context: { unhealthy: wait.verdict.unhealthy, attempts: wait.attempts, elapsedMs: wait.elapsedMs },
    })
    recordBringUp(
      opts,
      OUTCOME.HEALTH_FAILED,
      1,
      wait.attempts,
      Date.now() - startedAt,
      wait.verdict.detail,
      wait.containers.map((c) => c.name),
      [],
      ctxName,
    )
    // "did not go green", not "timed out": the same token also covers the crash-fast path, and the
    // detail already names WHICH service and WHY (R112b-3 gate-message requirement).
    return {
      token: OUTCOME.HEALTH_FAILED,
      message: `health gate did not go green: ${wait.verdict.detail}`,
      missing: [],
      commands: [upCmd],
      healthUrls: urls,
      attempts: wait.attempts,
    }
  }

  const netRes = await run(composeNetworksArgs(plan.composeFile))
  const dockerObjects: DockerObject[] = [
    ...wait.containers.map((c) => ({ kind: "container", id: c.name, createdBySwarm: true })),
    ...(netRes.exitCode === 0
      ? netRes.stdout
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((n) => ({ kind: "network", id: n, createdBySwarm: true }))
      : []),
  ]
  const moved = kit.transition(STATES.HEALTHY, { dockerObjects, version: kit.lock.version })
  if (!moved.ok) {
    // A refused lifecycle move means the pipeline is out of sync with the state file; report it
    // rather than claiming healthy while the committed state disagrees (single-writer honesty).
    kit.log("error", `${plan.component}: healthy move refused by the engine`, { context: { error: moved.error } })
    return {
      token: OUTCOME.FAILED,
      message: `state engine refused configured->healthy: ${moved.error}`,
      missing: [],
      commands: [upCmd],
      healthUrls: urls,
      attempts: wait.attempts,
    }
  }
  recordBringUp(
    opts,
    OUTCOME.OK,
    0,
    wait.attempts,
    Date.now() - startedAt,
    wait.verdict.detail,
    wait.containers.map((c) => c.name),
    [],
    ctxName,
  )
  kit.log("info", `${plan.component}: healthy — ${wait.verdict.detail}`, {
    context: { healthUrls: urls, containers: dockerObjects.length },
  })
  return {
    token: OUTCOME.OK,
    message: `${plan.title} healthy (${wait.attempts} poll(s), ${wait.elapsedMs} ms)`,
    missing: [],
    commands: [upCmd],
    healthUrls: urls,
    attempts: wait.attempts,
  }
}

/** Record a failure position without asserting a specific prior state: FAILED is reachable from
 *  every working state per the §4.1 chain, so a single guarded transition is enough; if even that
 *  is refused (already failed/absent) we leave the resting state untouched rather than fight it. */
function commitFailure(kit: StepKit): void {
  kit.transition(STATES.FAILED)
}

function recordBringUp(
  opts: BringUpOptions,
  token: OutcomeToken,
  exitCode: number,
  attempts: number,
  elapsedMs: number,
  healthDetail: string,
  containers: readonly string[],
  deferredVolumes: readonly string[],
  contextName: string = DOCKER_CONTEXT,
): void {
  if (opts.kit.dryRun) return // dry-run: ZERO filesystem writes
  appendStackProvenance({
    ts: new Date().toISOString(),
    lockVersion: opts.kit.lock.version,
    component: opts.plan.component,
    // R112b-7: a failed bring-up must not record as a bare "up". OK -> "up"; anything else ->
    // "up-failed" (the precise reason lives in `outcome` below).
    action: token === OUTCOME.OK ? "up" : "up-failed",
    project: COMPOSE_PROJECT,
    context: contextName,
    composeFile: opts.plan.composeFile,
    outcome: token,
    exitCode,
    attempts,
    elapsedMs,
    healthDetail,
    containers: [...containers],
    deferredVolumes: [...deferredVolumes],
  })
}

// --- teardown (label-scoped, ask-before-volumes) ------------------------------------------

export interface LabelSelection {
  readonly containers: string[]
  readonly networks: string[]
  readonly volumes: string[]
  readonly images: string[]
}

/** Route a label-list output into the four object kinds. Objects that do NOT appear in a
 *  label-filtered listing are structurally absent from the selection — a foreign container,
 *  the user's default-profile estate, or the other stack's objects can never enter it. */
export function selectLabelled(shimOutputs: {
  containers: string
  networks: string
  volumes: string
  images: string
}): LabelSelection {
  const ids = (text: string): string[] =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
  return {
    containers: ids(shimOutputs.containers),
    networks: ids(shimOutputs.networks),
    volumes: ids(shimOutputs.volumes),
    images: ids(shimOutputs.images),
  }
}

export interface TearDownOptions {
  readonly kit: StepKit
  readonly plan: StackPlan
  readonly run?: DockerRunner
}

export interface TearDownResult {
  readonly token: OutcomeToken
  readonly message: string
  readonly commands: string[]
  readonly selected: LabelSelection
  readonly deferredVolumes: string[]
  /** Networks this stack lost, measured as a before/after listing delta (R112b-7); null = a
   *  listing leg failed so the count is honestly unavailable (never a silent 0). */
  readonly networksRemoved: number | null
}

/** remove-path: compose down scoped to THIS stack's file, then label-scoped residue sweep.
 *  Only labelled objects are ever targeted (P-14); volumes are listed and PRINTED, never deleted
 *  without a human answer (ask-before-data-volume); no prune verb exists in any built command.
 *
 *  R112b-7 truthfulness: reported counts are BEFORE/AFTER listing deltas — what actually LEFT the
 *  estate — not the post-down residue listing. The old message read the residue (empty by
 *  construction after a successful down) and printed "0 network(s)" while compose down had verifiably
 *  removed five; worse, compose-created networks carry no io.gsp.swarm.* labels at all (FIX ROUND 2
 *  citation), so the label-based network count could never be non-zero. Networks are therefore
 *  enumerated with the compose-labelled `network ls` scoping (composeNetworksArgs), containers and
 *  images with the io.gsp label pair. Any failing listing leg reports "count unavailable" — never a
 *  fabricated zero. A compose-down failure now also writes its ledger row (action "down-incomplete"):
 *  the audit trail must not silently miss failed removals. */
export async function tearDown(opts: TearDownOptions): Promise<TearDownResult> {
  const { kit, plan } = opts
  const run = opts.run ?? refusingRunner

  const listCmds = (): string[] => [
    formatCmd(composeDownCmd(plan.composeFile)),
    formatCmd(composeNetworksArgs(plan.composeFile)), // network scope for the before/after delta
    ...(["container", "network", "volume", "image"] as const).map((k) => formatCmd(labelListArgs(k, plan.component))),
  ]

  if (kit.dryRun) {
    const commands = listCmds()
    for (const c of commands) kit.log("info", `${plan.component} dry-run remove: ${c}`)
    kit.log(
      "info",
      `${plan.component} dry-run remove: volumes matching the label pair would be LISTED and ASKED about, never deleted (P-14)`,
    )
    kit.transition(STATES.ABSENT)
    return {
      token: OUTCOME.OK,
      message: `dry-run remove ${plan.component}: printed the exact labelled-object scope, deleted nothing`,
      commands,
      selected: { containers: [], networks: [], volumes: [], images: [] },
      deferredVolumes: [],
      networksRemoved: null, // dry-run measured nothing and says so
    }
  }

  // Estate snapshots around the removal legs; removed = names present BEFORE and gone AFTER.
  const snapshot = async () => {
    const [containers, networks, images] = await Promise.all([
      run(labelListArgs("container", plan.component)),
      run(composeNetworksArgs(plan.composeFile)),
      run(labelListArgs("image", plan.component)),
    ])
    return { containers, networks, images }
  }
  const before = await snapshot()

  const down = await run(composeDownCmd(plan.composeFile))
  if (down.exitCode !== 0) {
    kit.log("error", `${plan.component}: compose down failed`, {
      context: { stderr: down.stderr.trim().slice(0, 300) },
    })
    recordTearDown(opts, OUTCOME.FAILED, [], 1, null)
    return {
      token: OUTCOME.FAILED,
      message: `compose down failed (exit ${down.exitCode}): ${down.stderr.trim().slice(0, 300)}`,
      commands: [formatCmd(composeDownCmd(plan.composeFile))],
      selected: { containers: [], networks: [], volumes: [], images: [] },
      deferredVolumes: [],
      networksRemoved: null,
    }
  }

  const [c, n, v, i] = await Promise.all([
    run(labelListArgs("container", plan.component)),
    run(labelListArgs("network", plan.component)),
    run(labelListArgs("volume", plan.component)),
    run(labelListArgs("image", plan.component)),
  ])
  const selected = selectLabelled({ containers: c.stdout, networks: n.stdout, volumes: v.stdout, images: i.stdout })
  const commands: string[] = [formatCmd(composeDownCmd(plan.composeFile)), ...listCmds().slice(1)]

  // Residue removal, still label-only (compose down already took its own file's objects; this
  // catches anything left, e.g. after an interrupted earlier run).
  for (const id of selected.containers) {
    await run(containerRmArgs(id))
    commands.push(formatCmd(containerRmArgs(id)))
  }
  for (const id of selected.networks) {
    await run(networkRmArgs(id))
    commands.push(formatCmd(networkRmArgs(id)))
  }
  for (const id of selected.images) {
    await run(imageRmArgs(id))
    commands.push(formatCmd(imageRmArgs(id)))
  }

  const after = await snapshot()
  const removedCount = (pre: DockerResult, post: DockerResult): number | null =>
    pre.exitCode !== 0 || post.exitCode !== 0
      ? null
      : pre.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "")
          .filter((name) => !post.stdout.split("\n").some((p) => p.trim() === name)).length
  const phrase = (count: number | null, unit: string): string =>
    count === null ? `${unit} count unavailable (listing failed)` : `${count} ${unit}(s) removed`
  const containersRemoved = removedCount(before.containers, after.containers)
  const networksRemoved = removedCount(before.networks, after.networks)
  const imagesRemoved = removedCount(before.images, after.images)
  const removalSummary = `${phrase(containersRemoved, "container")}, ${phrase(networksRemoved, "network")}, ${phrase(imagesRemoved, "image ref")}`

  // Volumes: ALWAYS deferred to a human answer (P-14 ask-before-data-volume). Firecrawl defines no
  // named volumes by spec (01e §6.5) and searxng bind-mounts instead of naming any (§5.2), so a
  // hit here means drift — even more reason to stop and ask rather than delete.
  const volumeInstructions = selected.volumes.map((id) => formatCmd(volumeRmCmd(id)))

  if (selected.volumes.length === 0) {
    kit.transition(STATES.ABSENT, { dockerObjects: [], paths: kit.stateOf().paths ?? [] })
    recordTearDown(opts, OUTCOME.OK, [], commands.length, networksRemoved)
    kit.log("info", `${plan.component}: stack removed; only labelled objects were targeted`)
    return {
      token: OUTCOME.OK,
      message: `${plan.title} removed (label-scoped; ${removalSummary})`,
      commands,
      selected,
      deferredVolumes: [],
      networksRemoved,
    }
  }

  kit.log(
    "warn",
    `${plan.component}: ${selected.volumes.length} labelled volume(s) left in place pending your confirmation (P-14 ask-before-data-volume)`,
    { context: { volumes: selected.volumes } },
  )
  recordTearDown(opts, OUTCOME.SKIPPED_WITH_INSTRUCTIONS, selected.volumes, commands.length, networksRemoved)
  return {
    token: OUTCOME.SKIPPED_WITH_INSTRUCTIONS,
    message: `${plan.title}: ${removalSummary}; volumes hold possible data — confirm removal explicitly, then run:\n${volumeInstructions.join("\n")}`,
    commands: [...commands, ...volumeInstructions],
    selected,
    deferredVolumes: selected.volumes,
    networksRemoved,
  }
}

function recordTearDown(
  opts: TearDownOptions,
  token: OutcomeToken,
  deferredVolumes: readonly string[],
  attempts: number,
  networksRemoved: number | null = null,
): void {
  if (opts.kit.dryRun) return
  appendStackProvenance({
    ts: new Date().toISOString(),
    lockVersion: opts.kit.lock.version,
    component: opts.plan.component,
    // R112b-7: bare "down" is reserved for a completed removal; anything else says so up front.
    action: token === OUTCOME.OK ? "down" : "down-incomplete",
    project: COMPOSE_PROJECT,
    context: DOCKER_CONTEXT,
    composeFile: opts.plan.composeFile,
    outcome: token,
    exitCode: 0,
    attempts,
    elapsedMs: 0,
    healthDetail: "teardown",
    containers: [],
    deferredVolumes: [...deferredVolumes],
    networksRemoved,
  })
}

// --- fake docker CLI shim (TEST/PROOF seam — mirrors stepkit's narrowing discipline) -------

export interface FakeShim {
  readonly runner: DockerRunner
  readonly invocations: string[][]
  /** True when NO invocation happened — the dry-run and fail-closed proofs assert this. */
  zeroExec(): boolean
  /** True when no built command contains the banned cleanup verb (P-14 hard prohibition). */
  neverPrune(): boolean
  formatted(): string[]
}

/** In-process recorder/responder standing in for the docker CLI. Routes ordered substring rules
 *  against the joined argv; unmatched calls fall back to a green default. It cannot reach a
 *  daemon (no spawn anywhere) — the honest fake the brief demands. */
export function makeFakeDockerShim(
  rules: Array<{ match: string; exitCode?: number; stdout?: string; stderr?: string }> = [],
): FakeShim {
  const invocations: string[][] = []
  const runner: DockerRunner = async (args) => {
    invocations.push([...args])
    const joined = args.join(" ")
    for (const r of rules) {
      if (joined.includes(r.match)) {
        return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
  return {
    runner,
    invocations,
    zeroExec(): boolean {
      return invocations.length === 0
    },
    neverPrune(): boolean {
      return !invocations.some((args) => args.some((a) => a.includes("prune")))
    },
    formatted(): string[] {
      return invocations.map((args) => formatCmd(args))
    },
  }
}

export const STACK_PROGRAM = PROGRAM_NAME
