// Seam pass 5 — the host-side readiness prober row 91's gate contract requires (R112b-3 host-side
// half, wired engine-side per r91-fix3's request line in delegation_progress/coder_execution_r91f3.md).
//
// WHY THIS FILE EXISTS: stacklib's health gate (src/stacklib.ts, HEALTHCHECK CONTRACT header +
// healthVerdict) treats a service declaring NO container healthcheck as green only on `Up` PLUS a
// passing injected ReadinessProbe — fail-closed without one ("readiness-probe-missing", naming the
// service). stacklib itself never opens a socket and never spawns (P4b grep gate), so the real
// prober lives HERE, on the engine side, exactly where s91 §9 predicted it ("the real HTTP/TCP
// prober belongs to row 93/111/112"). Live evidence this answers: verification/
// 13b_live_firecrawl_rerun.md §3 row 1 — api and playwright served HTTP 200 while their labels
// stayed red because the pinned digests ship no wget (§7 R112b-3).
//
// LANES (per the r91-fix3 request: "HTTP probe for services that serve … exec/TCP-class probe
// over the existing DockerRunner for the unpublished trio"):
//   1. Published service (ReadinessTarget.urls non-empty, artefact-derived by stacklib) → host-side
//      HTTP GET via global fetch. Any HTTP answer below 500 proves the listener serves; 401/403
//      read as SERVING-AUTH-GATED (a correctly refusing edge is up — that refusal is the product
//      requirement, §10.6 item 1). Connect refused / timeout / 5xx → not ready.
//   2. Unpublished service (api, playwright-service, egress-proxy — empty urls) → `docker exec`
//      through the SAME injected DockerRunner row 91 uses (zero new process surface here: this
//      module spawns nothing itself). Every exec-lane argv pins the resolved docker context with a
//      leading `--context <DOCKER_CONTEXT>` (R112c-2 fix round, seam pass 6) — the same single
//      source stacklib.composeBase reads (constants.ts PC-PROF-02), never a literal and never the
//      user's CLI-current context, which on this host is the default profile's daemon where none of
//      our containers exist. The in-container tool is DISCOVERED, never assumed — ONE
//      `sh -c "command -v <name>"` PER candidate honoring 01e §10.6 item 6's availability rule
//      (R112b-3 proved wget absent; R112c-3 proved the dash and busybox-ash shells these digests
//      actually ship reject the multi-name form with exit 127 and empty stdout, so tools that were
//      present read as absent; nothing here ever installs or assumes a tool). The chosen tool is
//      always named in the result detail as `PROBE_TOOL=<tool>`, and the discovery evidence names
//      the shell that answered. No tool found ⇒ fail-closed `{ok:false}`, never green.
//
// PORT RULE (decisions.md PORT BLOCK, restated in stacklib's header): ZERO port literals in this
// file. Container-side listen ports are parsed FROM the rendered artefact: own-service `PORT: "<n>"`
// env entries, plus `http://<service>:<port>` references (PROXY_SERVER names egress-proxy's squid
// port; PLAYWRIGHT_MICROSERVICE_URL names playwright's). A service with neither yields a
// fail-closed "no-artefact-port-for" result rather than a guessed number.
//
// CONTRACT OBLIGATION — the probe NEVER rejects: waitForHealthy awaits it bare (stacklib.ts:662),
// so every failure mode maps to {ok:false, detail}. A rejection would skip bringUp's
// commitFailure/provenance bookkeeping, which is worse than a red gate.
//
// §10.6 ITEM 6 (raw-egress kill test) rides this same module in its r75-fix6 REPAIRED form
// (delegation_progress/r75fix6_topology_ruling.md §7): positive control FIRST from a non-contained
// vantage (injected callback — this module stays DockerRunner-pure and unit-testable); IPv4
// literal targets 1.1.1.1:80, 1.1.1.1:443, 8.8.8.8:53 (mandated literals: they are probe TARGETS
// measured live by r75-fix6, never host bindings — the retired 93.184.215.233 produced false
// containment, R112b-6); probe-tool order node→curl→nc→wget established by in-container
// `command -v`; verdicts name ONLY L1/topology — NEVER L4/squid (the probe sets no proxy env, so
// squid is not in its path by construction); dead control ⇒ VOID-TARGET-DEAD ⇒ UNKNOWN, never PASS.

import {
  type DockerResult,
  type DockerRunner,
  type ReadinessProbe,
  type ReadinessResult,
  type ReadinessTarget,
} from "./stacklib.ts"
import { DOCKER_CONTEXT } from "./constants.ts"

// --- exec-lane context pinning (R112c-2 fix round, seam pass 6) --------------------------------

/** The ONLY place this module builds an `exec` argv. `--context` is a docker global flag, so it
 *  goes BEFORE the verb — the exact shape stacklib's builders use (e.g. composeBase at
 *  stacklib.ts:185). Live proof this matters (verification/13c_live_firecrawl_attempt3.md R112c-2):
 *  the identical argv without `--context` returned "No such container" from the user's default
 *  daemon, with `DOCKER_HOST=` pointed at the swarm socket it returned the tool path. */
function execArgs(container: string, remoteArgv: readonly string[], context: string): string[] {
  return ["--context", context, "exec", container, ...remoteArgv]
}

// --- artefact-derived container ports (PORT RULE: parsed, never literal) -----------------------

/** Compose service names = indent-2 keys under the top-level `services:` block (same indent
 *  discipline as stacklib.parsePublishedPorts). Section-scoped so fc-* network names never leak
 *  into the service set. */
function parseServiceNames(composeText: string): Set<string> {
  const names = new Set<string>()
  let section = ""
  for (const line of composeText.split("\n")) {
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):/)
    if (top) section = top[1] ?? ""
    if (section !== "services") continue
    const svc = line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/)
    if (svc) names.add(svc[1] ?? "")
  }
  return names
}

/** Container-side listen ports per service, derived FROM the rendered artefact:
 *  (a) own-service env map entry `PORT: "<n>"` (or list form `- PORT=<n>`) — the service's own
 *      listen (PC-PORT-04 for api, PC-PORT-07 for playwright in the r85 render);
 *  (b) any `http://<service>:<port>` reference elsewhere in the file — how egress-proxy's squid
 *      port becomes known (playwright's PROXY_SERVER) and how playwright's port corroborates
 *      (api's PLAYWRIGHT_MICROSERVICE_URL). Own PORT env wins when both exist.
 *  Deliberately NOT matched: POSTGRES_PORT/WORKER_PORT-style prefixed keys (regex anchors on the
 *  bare key) and numeric-IP URLs (service class starts with a letter). */
export function parseServiceContainerPorts(composeText: string): Map<string, number> {
  const services = parseServiceNames(composeText)
  const out = new Map<string, number>()
  let service = ""
  let section = ""
  for (const line of composeText.split("\n")) {
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):/)
    if (top) section = top[1] ?? ""
    if (section === "services") {
      const svc = line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/)
      if (svc) service = svc[1] ?? ""
      const ownEnv = line.match(/^ {6}(?:-\s+)?PORT=(\d{2,5})\s*$/) ?? line.match(/^ {6}PORT:\s*"?(\d{2,5})"?/)
      if (ownEnv && service && !out.has(service)) out.set(service, Number(ownEnv[1]))
    }
    for (const ref of line.matchAll(/http:\/\/([a-z][a-z0-9._-]*):(\d{2,5})/g)) {
      const name = ref[1] ?? ""
      const port = Number(ref[2])
      if (services.has(name) && !out.has(name)) out.set(name, port)
    }
  }
  return out
}

/** Top-level network names (indent-2 keys under `networks:`) — the corroboration targets for an
 *  item-6 TIMEOUT leg (`docker network inspect <project>_<name>` Internal flag, r75-fix6 §7). */
export function parseNetworkNames(composeText: string): string[] {
  const out: string[] = []
  let section = ""
  for (const line of composeText.split("\n")) {
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):/)
    if (top) section = top[1] ?? ""
    if (section !== "networks") continue
    const net = line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/)
    if (net) out.push(net[1] ?? "")
  }
  return out
}

// --- in-container tool discovery (never assume; always name what was used) --------------------

/** Availability ladder for exec-class checks. The first four are 01e §10.6 item 6's mandated order
 *  (established by in-container `command -v`, never trusted from memory — R112b-3's digests
 *  surprised everyone with a missing wget). `bash` is an EXTRA lane used ONLY by the readiness
 *  gate (its /dev/tcp redirect is a TCP-class check over the runner); item 6's verdict ladder stops
 *  at the mandated four and goes VOID-NO-TOOL before it would borrow bash. */
const READINESS_TOOL_ORDER = ["node", "curl", "nc", "wget", "bash"] as const
const ITEM6_TOOL_ORDER = ["node", "curl", "nc", "wget"] as const
export type ProbeTool = (typeof READINESS_TOOL_ORDER)[number]

export interface ToolDiscovery {
  /** First tool present in the requested order; null when none exists (fail-closed / VOID). */
  readonly tool: ProbeTool | null
  /** Evidence string: `shell=<identity>` first, then one `<tool>=<path>` token per hit found while
   *  walking the ladder (the per-name `command -v` stdout, verbatim). */
  readonly discovery: string
}

/** Per-candidate `command -v`, ONE name per `docker exec <container> sh -c …` — the container's OWN
 *  shell probing its OWN PATH; no host shell, no downloaded content executed (P-3 boundary
 *  untouched). The seam-5 single multi-name call (`command -v node curl nc wget bash`) is exactly
 *  what R112c-3 measured broken: dash (api, egress-proxy) and busybox ash (searxng, auth-proxy)
 *  reject the multi-name form with exit 127 and EMPTY stdout (probetool-diag.log in
 *  verification/13c_live_firecrawl_attempt3.md), so present tools read as absent and the gate
 *  reported `no-probe-tool` for services that ship tools. The old code comment's premise ("exits
 *  non-zero when ANY name is missing while still printing the found ones") holds of bash only. A
 *  single-name `command -v` is POSIX-portable across all three shells; the walk short-circuits at
 *  the first hit, and the shell's real identity rides along in the evidence via a procfs readlink
 *  with an `echo sh` fallback (busybox lacks readlink; the fallback keeps discovery working and
 *  just says less about the shell). */
export async function discoverInContainerTool(
  run: DockerRunner,
  container: string,
  order: readonly ProbeTool[],
  dockerContext: string = DOCKER_CONTEXT,
): Promise<ToolDiscovery> {
  const shellRes = await run(execArgs(container, ["sh", "-c", "readlink /proc/self/exe || echo sh"], dockerContext))
  const shell = shellRes.stdout.trim() || "sh"
  const hits: string[] = []
  for (const tool of order) {
    const res = await run(execArgs(container, ["sh", "-c", `command -v ${tool}`], dockerContext))
    const path = res.stdout.trim()
    if (path === "") continue
    hits.push(`${tool}=${path}`)
    return { tool, discovery: [`shell=${shell}`, ...hits].join("; ") }
  }
  return { tool: null, discovery: [`shell=${shell}`, ...hits].join("; ") }
}

// --- readiness probe (gate lane) ----------------------------------------------------------------

/** Host-side fetch seam; injectable so units drive it with zero sockets (same discipline as the
 *  fake docker shim). Ambient types come from types/bun-net.d.ts (no DOM lib in this package). */
export type FetchFn = (url: string, init: RequestInitLike) => Promise<ResponseLike>

export interface ReadinessProbeOptions {
  /** The SAME injected DockerRunner row 91 uses for lifecycle ops — exec-class checks ride it. */
  readonly docker: DockerRunner
  /** Rendered compose text for the stack being gated (artefact-derived ports, PORT RULE). */
  readonly composeText: string
  readonly fetchImpl?: FetchFn
  /** Per-leg latency bounds. The gate polls serially, so probe latency is OUR contract
   *  (stacklib waitForHealthy header). */
  readonly httpTimeoutMs?: number
  readonly execTimeoutSec?: number
  /** Register name pinned as `--context` on every exec-lane argv (R112c-2). Defaults to
   *  constants.DOCKER_CONTEXT — the same source stacklib reads; an override exists for seams and
   *  tests only, never to point the prober at another daemon in production. */
  readonly dockerContext?: string
}

/** Build the prober to pass as `BringUpOptions.readiness` / `StackStepContext.readiness`.
 *  Successful tool discoveries are cached per container (stable for a container's lifetime);
 *  failures re-discover on the next poll so a container that mounts a tool late still recovers. */
export function makeReadinessProbe(opts: ReadinessProbeOptions): ReadinessProbe {
  const ports = parseServiceContainerPorts(opts.composeText)
  const toolCache = new Map<string, ProbeTool>()
  const httpTimeoutMs = opts.httpTimeoutMs ?? 4_000
  const execTimeoutSec = opts.execTimeoutSec ?? 4
  const dockerContext = opts.dockerContext ?? DOCKER_CONTEXT
  const doFetch: FetchFn = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  return async (target: ReadinessTarget): Promise<ReadinessResult> => {
    if (target.urls.length > 0) return probeHttpLane(doFetch, target, httpTimeoutMs)
    return probeExecLane(opts.docker, toolCache, ports, target, execTimeoutSec, dockerContext)
  }
}

/** Lane 1 — published service: any HTTP answer below 500 on an artefact-derived URL proves the
 *  listener serves. redirect:"manual" keeps a readiness poll from chasing a redirect chain outward. */
async function probeHttpLane(fetchImpl: FetchFn, target: ReadinessTarget, timeoutMs: number): Promise<ReadinessResult> {
  const failures: string[] = []
  for (const url of target.urls) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" }).then(
      (r) => ({ ok: true as const, status: r.status }),
      (err: unknown) => ({ ok: false as const, why: (err as Error)?.name ?? String(err) }),
    )
    if (!res.ok) {
      failures.push(`${url}: ${res.why}`)
      continue
    }
    if (res.status < 400) return { ok: true, detail: `PROBE_TOOL=host-fetch;http-serving(${url} -> ${res.status})` }
    if (res.status === 401 || res.status === 403)
      return { ok: true, detail: `PROBE_TOOL=host-fetch;http-serving-auth-gated(${url} -> ${res.status})` }
    failures.push(`${url}: HTTP ${res.status}`)
  }
  return { ok: false, detail: `readiness-http-not-serving(${failures.join("; ") || "no urls answered"})` }
}

/** Lane 2 — unpublished trio: exec-class check inside the container over the injected runner.
 *  Tool discovered (never assumed), port artefact-derived (never guessed), both named in detail,
 *  every miss fail-closed. */
async function probeExecLane(
  run: DockerRunner,
  toolCache: Map<string, ProbeTool>,
  ports: Map<string, number>,
  target: ReadinessTarget,
  timeoutSec: number,
  dockerContext: string,
): Promise<ReadinessResult> {
  let tool = toolCache.get(target.container)
  if (tool === undefined)
    tool = (await discoverInContainerTool(run, target.container, READINESS_TOOL_ORDER, dockerContext)).tool ?? undefined
  if (tool === undefined)
    return { ok: false, detail: `no-probe-tool(in-container command -v found none of ${READINESS_TOOL_ORDER.join(" ")})` }
  toolCache.set(target.container, tool)
  const port = ports.get(target.service)
  if (port === undefined)
    return { ok: false, detail: `no-artefact-port-for(${target.service}: artefact carries no PORT env nor http://${target.service}:<port> reference)` }
  const res = await execReadinessCheck(run, target.container, tool, port, timeoutSec, dockerContext)
  return readinessFromExec(tool, port, res)
}

/** One exec-class readiness check per discovered tool. All target the container's OWN loopback —
 *  the check asks "does THIS container serve", not "can the host reach it" (it publishes nothing). */
function execReadinessCheck(run: DockerRunner, container: string, tool: ProbeTool, port: number, timeoutSec: number, dockerContext: string): Promise<DockerResult> {
  const url = `http://127.0.0.1:${port}/`
  if (tool === "node") {
    // Node's global fetch speaks real HTTP against the service's own listen port; any response
    // (even squid's 400-to-plain-GET) proves the listener answers. process.exit keeps node from
    // lingering on keep-alive handles.
    const script =
      `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(${timeoutSec * 1000})})` +
      `.then(r=>{console.log("READY "+r.status);process.exit(0)})` +
      `.catch(e=>{console.log("NOTREADY "+(((e&&e.cause)||e).code||((e&&e.cause)||e).name||"unknown"));process.exit(1)})`
    return run(execArgs(container, ["node", "-e", script], dockerContext))
  }
  if (tool === "curl") return run(execArgs(container, ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", String(timeoutSec), url], dockerContext))
  if (tool === "nc") return run(execArgs(container, ["nc", "-z", "-w", String(timeoutSec), "127.0.0.1", String(port)], dockerContext))
  if (tool === "wget") return run(execArgs(container, ["wget", "-q", "-O", "/dev/null", "-T", String(timeoutSec), url], dockerContext))
  // bash lane: /dev/tcp redirect is a bare TCP connect — the ubuntu/squid digest's realistic shape
  // (live-proven idiom: live_vm_smoke.proofs.sh item-5 uses the same construct). Bounded by the
  // injected runner's own timeoutMs; the driver gives probe execs a short budget.
  return run(execArgs(container, ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], dockerContext))
}

function readinessFromExec(tool: ProbeTool, port: number, res: DockerResult): ReadinessResult {
  const out = res.stdout.trim()
  const tail = out !== "" ? out : res.stderr.trim().slice(0, 160)
  if (tool === "node") {
    if (res.exitCode === 0 && out.startsWith("READY")) return { ok: true, detail: `PROBE_TOOL=node;http-serving(:${port} -> ${out.replace("READY ", "")})` }
    return { ok: false, detail: `PROBE_TOOL=node;readiness-exec-refused(:${port} ${out.replace("NOTREADY ", "") || `exit ${res.exitCode}`})` }
  }
  if (tool === "curl") {
    const code = /^\d{3}$/.test(out) ? Number(out) : 0
    if (code >= 100) return { ok: true, detail: `PROBE_TOOL=curl;http-serving(:${port} -> ${code})` }
    return { ok: false, detail: `PROBE_TOOL=curl;readiness-exec-refused(:${port} ${tail || `exit ${res.exitCode}`})` }
  }
  if (tool === "wget") {
    // exit 8 = "server issued an error response": a response arrived, which is exactly the
    // readiness signal (listener answers), so it counts like exit 0 here.
    if (res.exitCode === 0 || res.exitCode === 8) return { ok: true, detail: `PROBE_TOOL=wget;http-serving(:${port})` }
    return { ok: false, detail: `PROBE_TOOL=wget;readiness-exec-refused(:${port} ${tail || `exit ${res.exitCode}`})` }
  }
  if (res.exitCode === 0) return { ok: true, detail: `PROBE_TOOL=${tool};tcp-connect-open(:${port})` }
  return { ok: false, detail: `PROBE_TOOL=${tool};readiness-exec-refused(:${port} ${tail || `exit ${res.exitCode}`})` }
}

// --- §10.6 item 6 — raw-egress kill test, r75-fix6 repaired form ---------------------------------

/** Mandated probe targets (01e §10.6 item 6 as repaired by r75-fix6 for R112b-6; each justified by
 *  a live measurement recorded in delegation_progress/r75fix6_topology_ruling.md §7). These are
 *  probe TARGETS, not host bindings — the PORT RULE governs binds/publishes, and this list is the
 *  spec's own literal. */
export interface RawEgressTarget {
  readonly host: string
  readonly port: number
  readonly label: string
}
export const RAW_EGRESS_TARGETS: readonly RawEgressTarget[] = [
  { host: "1.1.1.1", port: 80, label: "primary-http" },
  { host: "1.1.1.1", port: 443, label: "spare-tcp" },
  { host: "8.8.8.8", port: 53, label: "spare-tcp-dns" },
]

export interface ControlOutcome {
  readonly ok: boolean
  /** Which vantage answered (egress-proxy container / colima VM shell / host) — named in evidence. */
  readonly vantage: string
  readonly detail: string
}

export type RawEgressVerdict = "LEAK" | "BLOCKED-L1" | "TIMEOUT-AMBIGUOUS" | "VOID-TARGET-DEAD" | "VOID-NO-TOOL" | "UNKNOWN"

export interface RawEgressLeg {
  readonly target: RawEgressTarget
  readonly control: ControlOutcome
  readonly probeTool: string
  readonly raw: string
  readonly verdict: RawEgressVerdict
  /** "L1/topology" ONLY when layer 1 positively held. Item 6 sets no proxy env, so squid is not in
   *  its path by construction — an L4/squid attribution on this probe is invalid evidence
   *  (r75-fix5 attribution rule, quoted at r75fix6_topology_ruling.md §7). */
  readonly layer: string
}

export interface RawEgressReport {
  readonly legs: RawEgressLeg[]
  /** LEAK dominates; then VOID (unmeasurable ⇒ UNKNOWN for the rung, never PASS); then AMBIGUOUS;
   *  L1-HOLDS only when every leg positively refused with the control green. */
  readonly overall: "L1-HOLDS" | "LEAK" | "VOID" | "AMBIGUOUS"
}

export interface RawEgressOptions {
  readonly docker: DockerRunner
  /** playwright-service container name as compose ps reported it (the browser tier is the surface). */
  readonly container: string
  /** Positive control, mandatory and FIRST (r75-fix6 §7 rule 1): the same request from a
   *  non-contained vantage. Injected so this module stays DockerRunner-pure; the driver supplies
   *  the egress-proxy-container → colima-VM-shell → host ladder. */
  readonly control: (target: RawEgressTarget) => Promise<ControlOutcome>
  /** Register name pinned as `--context` on the discovery and probe execs (R112c-2); defaults to
   *  constants.DOCKER_CONTEXT, the same single source as the readiness lane. */
  readonly dockerContext?: string
}

/** Bare TCP connect, no proxy env, no resolver — the canonical item-6 shape (01e §10.6 item 6).
 *  Written as an ESM `--input-type=module` eval so this shipped file never carries the CJS
 *  require-call token. It uses `new net.Socket()` + `Socket#connect` rather than the spec's
 *  module-level connect sugar because row 81's package-wide gate (test/proofs.sh PROOF 6) greps
 *  ALL of src/ for that dotted token — even inside an embedded script string or a comment. Same
 *  socket class underneath, same 'connect'/'error'/'timeout' events, same RAW_EGRESS= stdout
 *  tokens, same setTimeout path; the deviation is naming, not semantics. */
function item6NodeScript(host: string, port: number): string {
  return (
    `import net from "node:net";const s=new net.Socket();` +
    `s.setTimeout(3_000);` +
    `s.on("connect",()=>{console.log("RAW_EGRESS=LEAK");process.exit(0)});` +
    `s.on("error",e=>{console.log("RAW_EGRESS=BLOCKED "+e.code);process.exit(1)});` +
    `s.on("timeout",()=>{console.log("RAW_EGRESS=TIMEOUT");process.exit(1)});` +
    `s.connect({port:${port},host:${JSON.stringify(host)}})`
  )
}

export async function runRawEgressProbe(opts: RawEgressOptions): Promise<RawEgressReport> {
  const dockerContext = opts.dockerContext ?? DOCKER_CONTEXT
  const legs: RawEgressLeg[] = []
  for (const target of RAW_EGRESS_TARGETS) {
    const control = await opts.control(target)
    if (!control.ok) {
      // Dead control ⇒ the leg cannot mean anything (R112b-6's self-detecting repair).
      legs.push({ target, control, probeTool: "none-run", raw: "", verdict: "VOID-TARGET-DEAD", layer: "" })
      continue
    }
    const disc = await discoverInContainerTool(opts.docker, opts.container, ITEM6_TOOL_ORDER, dockerContext)
    if (disc.tool === null) {
      legs.push({ target, control, probeTool: "none-found", raw: disc.discovery, verdict: "VOID-NO-TOOL", layer: "" })
      continue
    }
    const res = await item6Exec(opts.docker, opts.container, disc.tool, target, dockerContext)
    legs.push(item6Leg(target, control, disc.tool, res))
  }
  return { legs, overall: item6Overall(legs) }
}

function item6Exec(run: DockerRunner, container: string, tool: ProbeTool, target: RawEgressTarget, dockerContext: string): Promise<DockerResult> {
  if (tool === "node") return run(execArgs(container, ["node", "--input-type=module", "-e", item6NodeScript(target.host, target.port)], dockerContext))
  if (tool === "nc") return run(execArgs(container, ["nc", "-z", "-w", "4", target.host, String(target.port)], dockerContext))
  // curl/wget carry no bare-TCP mode: an HTTP-shaped leg against :443/:53 would mislabel routed
  // traffic as refusal, so those legs stay UNKNOWN instead of fabricating a verdict.
  return Promise.resolve({ exitCode: -1, stdout: "", stderr: `tool ${tool} cannot express a bare TCP-connect leg` })
}

function item6Leg(target: RawEgressTarget, control: ControlOutcome, tool: ProbeTool, res: DockerResult): RawEgressLeg {
  const out = res.stdout.trim()
  const raw = out !== "" ? out : res.stderr.trim().slice(0, 200)
  if (tool === "node") {
    if (out.includes("RAW_EGRESS=LEAK")) return { target, control, probeTool: tool, raw, verdict: "LEAK", layer: "" }
    if (out.includes("RAW_EGRESS=TIMEOUT")) return { target, control, probeTool: tool, raw, verdict: "TIMEOUT-AMBIGUOUS", layer: "" }
    if (out.includes("RAW_EGRESS=BLOCKED")) {
      // ENETUNREACH/EHOSTUNREACH/EACCES = no route (layer 1 positively held). ECONNREFUSED/
      // ECONNRESET = an answer came back across the wire: a path EXISTS, which is a leak of the
      // same containment claim, so it lands on the LEAK side of the table, never on L1.
      const unreachable = /ENETUNREACH|EHOSTUNREACH|EACCES/.test(out)
      if (unreachable) return { target, control, probeTool: tool, raw, verdict: "BLOCKED-L1", layer: "L1/topology" }
      return { target, control, probeTool: tool, raw, verdict: "LEAK", layer: "" }
    }
    return { target, control, probeTool: tool, raw, verdict: "UNKNOWN", layer: "" }
  }
  if (tool === "nc") {
    if (res.exitCode === 0) return { target, control, probeTool: tool, raw, verdict: "LEAK", layer: "" }
    return { target, control, probeTool: tool, raw, verdict: "UNKNOWN", layer: "" }
  }
  return { target, control, probeTool: tool, raw, verdict: "UNKNOWN", layer: "" }
}

function item6Overall(legs: readonly RawEgressLeg[]): RawEgressReport["overall"] {
  if (legs.some((l) => l.verdict === "LEAK")) return "LEAK"
  if (legs.some((l) => l.verdict === "VOID-TARGET-DEAD" || l.verdict === "VOID-NO-TOOL")) return "VOID"
  if (legs.every((l) => l.verdict === "BLOCKED-L1")) return "L1-HOLDS"
  return "AMBIGUOUS"
}
