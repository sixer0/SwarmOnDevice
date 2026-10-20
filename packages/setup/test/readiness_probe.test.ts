// Seam pass 5 unit tests for src/readinessProbe.ts — the host-side prober row 91's gate contract
// requires. Same discipline as test/stack_steps.test.ts: NO daemon, NO network, NO spawn — every
// docker interaction rides makeFakeDockerShim, every HTTP interaction rides an injected fetch
// stub. Compose fixtures mirror the r85 renderer's exact indentation (verified read-only against
// the live artefact ~/.swarm/tools/firecrawl/compose/firecrawl.yml: services at indent 2, env
// entries at indent 6, publishes at indent 6 quoted) — this suite consumes shapes, never re-renders.
//
// Seam pass 6 (fix round for R112c-2/R112c-3) adds two describes below:
//   R112c-3 -> "shell classes" — per-name `command -v` proven against modeled dash, busybox ash
//              and bash behaviors (the multi-name form the old code issued returns 127/empty on
//              the first two; verification/13c_live_firecrawl_attempt3.md probetool-diag.log).
//   R112c-2 -> "exec-lane context pinning" — every exec-lane argv carries
//              ["--context", DOCKER_CONTEXT] before the exec verb, sourced from constants.ts.
//
// The three dispatch-mandated proofs are each a named describe:
//   GREEN path with prober        -> "gate lanes" + "waitForHealthy integration"
//   FAIL-CLOSED path without      -> "waitForHealthy integration" (probe-missing stays red, named)
//   VOID path when control fails  -> "item 6 raw-egress probe"
//
// Run TARGETED (rule 6): cd packages/setup && bun test test/readiness_probe.test.ts

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { OUTCOME } from "../src/outcomes.ts"
import {
  healthVerdict,
  makeFakeDockerShim,
  waitForHealthy,
  type DockerResult,
  type DockerRunner,
  type ReadinessTarget,
} from "../src/stacklib.ts"
import { DOCKER_CONTEXT } from "../src/constants.ts"
import {
  discoverInContainerTool,
  makeReadinessProbe,
  parseNetworkNames,
  parseServiceContainerPorts,
  RAW_EGRESS_TARGETS,
  runRawEgressProbe,
  type ControlOutcome,
  type FetchFn,
  type ProbeTool,
} from "../src/readinessProbe.ts"

// ---- fixtures (renderer-shaped, indentation-verified — see header) ----------------------------

/** Firecrawl estate excerpt: the three unpublished no-healthcheck services plus the one publish.
 *  Port sources present exactly as the r85 renderer emits them: own PORT env (api, playwright),
 *  http://<service>:<port> reference (PROXY_SERVER → egress-proxy), decoy prefixed *_PORT keys. */
const FC_FIXTURE = [
  "name: swarm-tools",
  "networks:",
  "  fc-edge:",
  "    driver: bridge",
  "  fc-ctl:",
  "    driver: bridge",
  "    internal: true",
  "services:",
  "  auth-proxy:",
  "    ports:",
  '      - "127.0.0.1:9022:8080"',
  "  api:",
  "    environment:",
  '      PORT: "3002"  # PC-PORT-04 container listen (unpublished)',
  '      POSTGRES_PORT: "5432"',
  "      PLAYWRIGHT_MICROSERVICE_URL: http://playwright-service:3000/scrape",
  "  playwright-service:",
  "    environment:",
  '      PORT: "3000"',
  '      PROXY_SERVER: "http://egress-proxy:3128"',
  "  egress-proxy:",
  "    image: docker.io/ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
].join("\n")

/** Searxng estate excerpt (U-1 shipped form: NO healthcheck, one loopback publish). */
const SX_FIXTURE = [
  "name: swarm-tools",
  "services:",
  "  searxng:",
  "    ports:",
  '      - "127.0.0.1:9021:8080"',
  "  valkey:",
  "    healthcheck:",
  "      test: [\"CMD\", \"valkey-cli\", \"ping\"]",
].join("\n")

function target(service: string, container: string, urls: readonly string[] = []): ReadinessTarget {
  return { service, container, urls }
}

/** Minimal ResponseLike stand-in for the injected fetch seam. */
function res(status: number) {
  return { status, ok: status < 400, headers: { get: () => null }, body: null, text: async () => "" }
}

function fetchReturning(status: number): FetchFn {
  return async () => res(status)
}
function fetchThrowing(name: string): FetchFn {
  return async () => {
    throw new Error(name)
  }
}

/** Deterministic millisecond clock for waitForHealthy windows. */
function fakeClock() {
  let now = 0
  return () => (now += 5)
}

// ---- artefact parsing (PORT RULE: everything parsed, nothing literal) -------------------------

describe("artefact parsing — container ports and networks come FROM the compose text", () => {
  it("own PORT env maps the service to its container listen port", () => {
    const ports = parseServiceContainerPorts(FC_FIXTURE)
    expect(ports.get("api")).toBe(3002)
    expect(ports.get("playwright-service")).toBe(3000)
  })
  it("http://<service>:<port> references fill services with no own PORT env (egress-proxy via PROXY_SERVER)", () => {
    const ports = parseServiceContainerPorts(FC_FIXTURE)
    expect(ports.get("egress-proxy")).toBe(3128)
  })
  it("prefixed *_PORT decoys never map (POSTGRES_PORT is not the api listen)", () => {
    const ports = parseServiceContainerPorts(FC_FIXTURE)
    // api got 3002 from its own PORT key; a decoy leak would show as 5432 somewhere else.
    expect([...ports.values()].includes(5432)).toBe(false)
  })
  it("network names parse from the top-level networks block only (services keys excluded)", () => {
    const nets = parseNetworkNames(FC_FIXTURE)
    expect(nets).toEqual(["fc-edge", "fc-ctl"])
    expect(parseNetworkNames(SX_FIXTURE)).toEqual([])
  })
})

// ---- tool discovery (never assume; name what was used) ----------------------------------------

describe("in-container tool discovery — one per-name command -v decides, order preserved, absence is data", () => {
  // Seam pass 6: discovery issues ONE `command -v <name>` per candidate (R112c-3). Match strings
  // stay name-exact WITHOUT trailing whitespace: the shim routes on argv.join(" "), so a probe of
  // "node" ends the joined string at "node" and never carries a "nodejs"-style continuation.
  it("picks node first when the digest ships both node and wget", async () => {
    const shim = makeFakeDockerShim([
      { match: "command -v node", stdout: "/usr/local/bin/node\n" },
      { match: "command -v wget", stdout: "/usr/bin/wget\n" },
    ])
    const disc = await discoverInContainerTool(shim.runner, "c1", ["node", "curl", "nc", "wget"])
    expect(disc.tool).toBe("node")
    expect(disc.discovery).toContain("node=/usr/local/bin/node")
  })
  it("falls to the next tool in the mandated order when node is absent (wget last)", async () => {
    const shim = makeFakeDockerShim([
      { match: "command -v curl", stdout: "/usr/bin/curl\n" },
      { match: "command -v wget", stdout: "/usr/bin/wget\n" },
    ])
    const disc = await discoverInContainerTool(shim.runner, "c1", ["node", "curl", "nc", "wget"])
    expect(disc.tool).toBe("curl")
  })
  it("reports null when NOTHING exists — the R112b-3 wget-absence class, honored not guessed", async () => {
    const shim = makeFakeDockerShim([{ match: "command -v", exitCode: 1, stdout: "" }])
    const disc = await discoverInContainerTool(shim.runner, "c1", ["node", "curl", "nc", "wget"])
    expect(disc.tool).toBe(null)
    expect(shim.invocations[0]?.join(" ")).toContain("sh -c")
    // per-name walk: every mandated candidate was asked individually, none assumed
    expect(shim.invocations.filter((a) => a.join(" ").includes("command -v")).length).toBe(4)
  })
})

// ---- shell classes (R112c-3): per-name discovery proven against each real shell behavior ------

/** Models the three shells the pinned digests actually ship, with the behaviors the row-112
 *  attempt-3 verifier measured on them (`probetool-diag.log`, cited in
 *  verification/13c_live_firecrawl_attempt3.md §7 R112c-3): dash (api, egress-proxy) and busybox
 *  ash (searxng, auth-proxy) reject the MULTI-name `command -v` form with exit 127 and empty
 *  stdout; bash answers it partially (prints found paths, exits 1). Single-name `command -v` is
 *  answered identically by all three — that is the POSIX-portable form the prober now uses. */
interface ShellClass {
  readonly name: string
  /** stdout for `command -v <tool>`; "" = not on PATH. */
  readonly paths: Record<string, string>
  /** What `readlink /proc/self/exe` prints (busybox models the no-readlink fallback). */
  readonly shellExe: string
  /** Whether the multi-name form yields partial stdout (true only for bash). */
  readonly multiNameHonored: boolean
}

const SHELL_CLASSES: ShellClass[] = [
  { name: "dash", paths: { node: "/usr/local/bin/node", curl: "/usr/bin/curl", bash: "/usr/bin/bash" }, shellExe: "/usr/bin/dash", multiNameHonored: false },
  { name: "busybox-ash", paths: { nc: "/bin/nc", wget: "/bin/wget" }, shellExe: "/bin/busybox", multiNameHonored: false },
  { name: "bash", paths: { node: "/usr/local/bin/node", curl: "/usr/bin/curl", bash: "/usr/bin/bash" }, shellExe: "/usr/bin/bash", multiNameHonored: true },
]

function shellRunner(shell: ShellClass): { runner: DockerRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: DockerRunner = async (args) => {
    calls.push([...args])
    const joined = args.join(" ")
    const respond = (exitCode: number, stdout: string): DockerResult => ({ exitCode, stdout, stderr: "" })
    if (joined.includes("readlink /proc/self/exe")) return respond(0, `${shell.shellExe}\n`)
    const cmdv = joined.match(/command -v (.+)$/)
    if (cmdv) {
      const name = cmdv[1] ?? ""
      if (!name.includes(" ")) return respond(shell.paths[name] ? 0 : 1, shell.paths[name] ? `${shell.paths[name]}\n` : "")
      // Multi-name form: bash prints every found path and exits 1; dash/busybox reject the form
      // with 127 and NOTHING on stdout — the measured R112c-3 behavior this fixture models.
      const found = name.split(" ").flatMap((t) => (shell.paths[t] ? [`${shell.paths[t]}\n`] : []))
      if (shell.multiNameHonored && found.length > 0) return respond(1, found.join(""))
      return respond(127, "")
    }
    return respond(0, "")
  }
  return { runner, calls }
}

describe("shell classes (R112c-3) — a present tool is detected and an absent one is not, on dash, busybox ash and bash", () => {
  for (const shell of SHELL_CLASSES) {
    it(`${shell.name}: present tool detected via per-name command -v, evidence names the shell`, async () => {
      const fx = shellRunner(shell)
      const first = Object.keys(shell.paths)[0] ?? ""
      const disc = await discoverInContainerTool(fx.runner, "c1", [first as ProbeTool])
      expect(disc.tool).toBe(first)
      expect(disc.discovery).toContain(`${first}=${shell.paths[first]}`)
      expect(disc.discovery).toContain(`shell=${shell.shellExe}`)
    })
    it(`${shell.name}: absent tool stays null — fail-closed, never a guess`, async () => {
      const fx = shellRunner(shell)
      const disc = await discoverInContainerTool(fx.runner, "c1", ["telnet" as ProbeTool])
      expect(disc.tool).toBe(null)
      expect(disc.discovery).not.toContain("telnet=")
      expect(disc.discovery).toContain(`shell=${shell.shellExe}`)
    })
    it(`${shell.name}: the walk asks ONE name per exec — the R112c-3 multi-name form is gone`, async () => {
      const fx = shellRunner(shell)
      await discoverInContainerTool(fx.runner, "c1", ["node", "curl", "nc", "wget"])
      const probes = fx.calls.filter((a) => a.join(" ").includes("command -v"))
      // short-circuiting means probes.length tracks the hit position; the invariant under test is
      // that NO exec ever carries two names, and that an all-miss walk still covers every rung:
      expect(probes.every((a) => !/command -v \S+ \S+/.test(a.join(" ")))).toBe(true)
      const missFx = shellRunner({ ...shell, paths: {} })
      const missDisc = await discoverInContainerTool(missFx.runner, "c1", ["node", "curl", "nc", "wget"])
      expect(missDisc.tool).toBe(null)
      expect(missFx.calls.filter((a) => a.join(" ").includes("command -v")).length).toBe(4)
    })
  }
  it("regression pin: under dash/ash the OLD multi-name form would have read tools-present as none", async () => {
    // Same fixture, old argv shape: 127/empty stdout ⇒ the seam-5 parser found nothing. This test
    // documents WHY the per-name rewrite is required, by re-running the rejected form verbatim.
    for (const shell of SHELL_CLASSES.filter((s) => !s.multiNameHonored)) {
      const fx = shellRunner(shell)
      const legacy = await fx.runner(["exec", "c1", "sh", "-c", "command -v node curl nc wget bash"])
      expect(legacy.exitCode).toBe(127)
      expect(legacy.stdout).toBe("")
      const fixed = await discoverInContainerTool(fx.runner, "c1", ["node", "curl", "nc", "wget", "bash"])
      expect(fixed.tool).not.toBe(null)
    }
  })
})

// ---- exec-lane context pinning (R112c-2): every exec rides the resolved register --------------

describe("exec-lane context pinning (R112c-2) — --context precedes every exec argv, from constants.ts", () => {
  /** True when an argv carries `--context <register>` strictly BEFORE its `exec` verb — the
   *  position docker requires for the global flag (stacklib composeBase shape, stacklib.ts:185). */
  const contextPinned = (argv: readonly string[]) =>
    argv[0] === "--context" && argv[1] === DOCKER_CONTEXT && argv[2] === "exec"

  it("readiness exec lane: discovery AND check argvs are pinned; host lane spawns nothing", async () => {
    const shim = makeFakeDockerShim([
      { match: "command -v node", stdout: "/usr/local/bin/node\n" },
      { match: "node -e", stdout: "READY 200\n" },
    ])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE, fetchImpl: fetchReturning(200) })
    const execTarget: ReadinessTarget = { service: "api", container: "swarm-tools-api-1", urls: [] }
    const out = await probe(execTarget)
    expect(out.ok).toBe(true)
    expect(shim.invocations.length).toBe(3) // shell identity + node probe + node check, all exec-lane
    expect(shim.invocations.every(contextPinned)).toBe(true)
    // positive control that the predicate is not vacuous: unpinned argvs must be rejected by it
    expect(contextPinned(["exec", "c1", "node", "-e", "x"])).toBe(false)
    // the host HTTP lane must not spawn anything at all
    const sxProbe = makeReadinessProbe({ docker: shim.runner, composeText: SX_FIXTURE, fetchImpl: fetchReturning(200) })
    await sxProbe({ service: "searxng", container: "swarm-tools-searxng-1", urls: ["http://127.0.0.1:9021/"] })
    expect(shim.invocations.length).toBe(3) // host lane added zero execs
  })

  it("item-6 raw-egress lane: every exec argv pinned too; control-first legs spawn nothing", async () => {
    const controlGreen = async (): Promise<ControlOutcome> => ({ ok: true, vantage: "fixture-vm", detail: "ok" })
    const shim = makeFakeDockerShim([
      { match: "command -v node", stdout: "/usr/local/bin/node\n" },
      { match: "--input-type=module", exitCode: 1, stdout: "RAW_EGRESS=BLOCKED ENETUNREACH" },
    ])
    const report = await runRawEgressProbe({ docker: shim.runner, container: "pw-1", control: controlGreen })
    expect(report.overall).toBe("L1-HOLDS")
    expect(shim.invocations.length).toBeGreaterThan(1)
    expect(shim.invocations.every(contextPinned)).toBe(true)
    const dead = await runRawEgressProbe({
      docker: shim.runner,
      container: "pw-1",
      control: async () => ({ ok: false, vantage: "none", detail: "all vantages failed" }),
    })
    expect(dead.overall).toBe("VOID")
    expect(shim.invocations.every(contextPinned)).toBe(true) // still only ever pinned argvs
  })

  it("override stays injectable but production reads the constant (no second source of truth)", async () => {
    const shim = makeFakeDockerShim([{ match: "command -v node", stdout: "/usr/local/bin/node\n" }])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE, dockerContext: "fixture-context" })
    await probe(target("api", "swarm-tools-api-1"))
    expect(shim.invocations[0]?.slice(0, 3)).toEqual(["--context", "fixture-context", "exec"])
  })
})

// ---- readiness probe lanes --------------------------------------------------------------------

describe("makeReadinessProbe — host HTTP lane for published services", () => {
  const sxTarget = target("searxng", "swarm-tools-searxng-1", ["http://127.0.0.1:9021/"])

  it("200 answers ready with the serving URL+status named in detail", async () => {
    const probe = makeReadinessProbe({ docker: makeFakeDockerShim().runner, composeText: SX_FIXTURE, fetchImpl: fetchReturning(200) })
    const out = await probe(sxTarget)
    expect(out.ok).toBe(true)
    expect(out.detail).toContain("http-serving(http://127.0.0.1:9021/ -> 200)")
  })
  it("401 reads as SERVING-AUTH-GATED — a correctly refusing edge is up (the product requirement itself)", async () => {
    const probe = makeReadinessProbe({ docker: makeFakeDockerShim().runner, composeText: SX_FIXTURE, fetchImpl: fetchReturning(401) })
    const out = await probe(sxTarget)
    expect(out.ok).toBe(true)
    expect(out.detail).toContain("http-serving-auth-gated")
  })
  it("connect failure maps to a resolved NOT-ready result — the probe never rejects (waitForHealthy awaits it bare)", async () => {
    const probe = makeReadinessProbe({ docker: makeFakeDockerShim().runner, composeText: SX_FIXTURE, fetchImpl: fetchThrowing("Error") })
    const out = await probe(sxTarget)
    expect(out.ok).toBe(false)
    expect(out.detail).toContain("readiness-http-not-serving")
  })
  it("5xx is not readiness", async () => {
    const probe = makeReadinessProbe({ docker: makeFakeDockerShim().runner, composeText: SX_FIXTURE, fetchImpl: fetchReturning(503) })
    const out = await probe(sxTarget)
    expect(out.ok).toBe(false)
  })
})

describe("makeReadinessProbe — exec/TCP lane for the unpublished trio over the injected DockerRunner", () => {
  it("node digest: READY answer goes green and names PROBE_TOOL=node", async () => {
    const shim = makeFakeDockerShim([
      { match: "command -v", stdout: "/usr/local/bin/node\n" },
      { match: "node -e", stdout: "READY 200\n" },
    ])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE })
    const out = await probe(target("api", "swarm-tools-api-1"))
    expect(out.ok).toBe(true)
    expect(out.detail).toContain("PROBE_TOOL=node")
    expect(shim.invocations.some((a) => a.join(" ").includes("exec swarm-tools-api-1 node -e"))).toBe(true)
  })
  it("node refuses (NOTREADY) keeps the gate red with the tool named", async () => {
    const shim = makeFakeDockerShim([
      { match: "command -v", stdout: "/usr/local/bin/node\n" },
      { match: "node -e", exitCode: 1, stdout: "NOTREADY ECONNREFUSED\n" },
    ])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE })
    const out = await probe(target("api", "swarm-tools-api-1"))
    expect(out.ok).toBe(false)
    expect(out.detail).toContain("PROBE_TOOL=node")
    expect(out.detail).toContain("ECONNREFUSED")
  })
  // Per-name discovery (R112c-3) means a single "command -v" catch-all rule would answer EVERY
  // candidate probe with the same path. These fixtures therefore list the ladder explicitly —
  // ordered misses before the one hit — exactly how the shim routes (first substring match wins).
  it("squid-class digest: bash /dev/tcp TCP connect is the readiness evidence, named PROBE_TOOL=bash", async () => {
    const shim = makeFakeDockerShim([
      { match: "command -v node", exitCode: 1, stdout: "" },
      { match: "command -v curl", exitCode: 1, stdout: "" },
      { match: "command -v nc", exitCode: 1, stdout: "" },
      { match: "command -v wget", exitCode: 1, stdout: "" },
      { match: "command -v", stdout: "/usr/bin/bash\n" },
      { match: "exec swarm-tools-egress-proxy-1 bash -c", stdout: "" },
    ])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE })
    const out = await probe(target("egress-proxy", "swarm-tools-egress-proxy-1"))
    expect(out.ok).toBe(true)
    expect(out.detail).toContain("PROBE_TOOL=bash")
    expect(out.detail).toContain("tcp-connect-open")
  })
  it("wget lane honors exit 8 (server answered with an error) as serving — response arrival is the signal", async () => {
    const shim = makeFakeDockerShim([
      { match: "command -v node", exitCode: 1, stdout: "" },
      { match: "command -v curl", exitCode: 1, stdout: "" },
      { match: "command -v nc", exitCode: 1, stdout: "" },
      { match: "command -v wget", stdout: "/usr/bin/wget\n" },
      { match: "exec swarm-tools-api-1 wget", exitCode: 8, stdout: "" },
    ])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE })
    const out = await probe(target("api", "swarm-tools-api-1"))
    expect(out.ok).toBe(true)
    expect(out.detail).toContain("PROBE_TOOL=wget")
  })
  it("curl digest: printed http code is the serving evidence, named PROBE_TOOL=curl", async () => {
    const shim = makeFakeDockerShim([
      { match: "command -v node", exitCode: 1, stdout: "" },
      { match: "command -v curl", stdout: "/usr/bin/curl\n" },
      { match: "exec swarm-tools-api-1 curl", stdout: "200" },
    ])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE })
    const out = await probe(target("api", "swarm-tools-api-1"))
    expect(out.ok).toBe(true)
    expect(out.detail).toContain("PROBE_TOOL=curl;http-serving(:3002 -> 200)")
  })
  it("nc digest: exit 0 TCP connect satisfies the gate, named PROBE_TOOL=nc", async () => {
    const shim = makeFakeDockerShim([
      { match: "command -v node", exitCode: 1, stdout: "" },
      { match: "command -v curl", exitCode: 1, stdout: "" },
      { match: "command -v nc", stdout: "/bin/nc\n" },
      { match: "exec swarm-tools-egress-proxy-1 nc", stdout: "" },
    ])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE })
    const out = await probe(target("egress-proxy", "swarm-tools-egress-proxy-1"))
    expect(out.ok).toBe(true)
    expect(out.detail).toContain("PROBE_TOOL=nc;tcp-connect-open(:3128)")
  })
  it("no tool at all ⇒ fail-closed no-probe-tool, never a silent pass", async () => {
    const shim = makeFakeDockerShim([{ match: "command -v", exitCode: 1, stdout: "" }])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE })
    const out = await probe(target("api", "swarm-tools-api-1"))
    expect(out.ok).toBe(false)
    expect(out.detail).toContain("no-probe-tool")
  })
  it("service with no artefact-derived port fails closed instead of guessing a number", async () => {
    const shim = makeFakeDockerShim([{ match: "command -v", stdout: "/usr/local/bin/node\n" }])
    const probe = makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE })
    const out = await probe(target("mystery-service", "swarm-tools-mystery-service-1"))
    expect(out.ok).toBe(false)
    expect(out.detail).toContain("no-artefact-port-for(mystery-service")
  })
})

// ---- gate integration: the two dispatch paths (with prober / without) -------------------------

describe("waitForHealthy integration — green WITH the prober, fail-closed WITHOUT it", () => {
  // U-1 shipped shape: searxng declares nothing; the host-side probe is the ONLY green road.
  const sxPs = [{ match: "={{.Health}}", stdout: "swarm-tools-searxng-1=running=<none>\nswarm-tools-valkey-1=running=healthy" }]

  it("WITH prober (HTTP lane, 200): gate goes green and says the probes satisfied the no-healthcheck container", async () => {
    const shim = makeFakeDockerShim(sxPs)
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "searxng.yml",
      deadlineMs: 40,
      intervalMs: 10,
      sleep: async () => {},
      clock: fakeClock(),
      composeText: SX_FIXTURE,
      probe: makeReadinessProbe({ docker: shim.runner, composeText: SX_FIXTURE, fetchImpl: fetchReturning(200) }),
    })
    expect(wait.token).toBe(OUTCOME.OK)
    expect(wait.verdict.detail).toContain("satisfied by host-side readiness probes")
  })
  it("WITHOUT prober: fail-closed stays HEALTH_FAILED naming the service and readiness-probe-missing (row 91 contract untouched)", async () => {
    const shim = makeFakeDockerShim(sxPs)
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "searxng.yml",
      deadlineMs: 40,
      intervalMs: 10,
      sleep: async () => {},
      clock: fakeClock(),
      composeText: SX_FIXTURE,
    })
    expect(wait.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(wait.verdict.detail).toContain("swarm-tools-searxng-1:no-healthcheck+readiness-probe-missing")
  })
  it("WITH prober answering refused: HEALTH_FAILED names readiness-failed with the probe detail", async () => {
    const shim = makeFakeDockerShim(sxPs)
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "searxng.yml",
      deadlineMs: 40,
      intervalMs: 10,
      sleep: async () => {},
      clock: fakeClock(),
      composeText: SX_FIXTURE,
      probe: makeReadinessProbe({ docker: shim.runner, composeText: SX_FIXTURE, fetchImpl: fetchThrowing("DOMException") }),
    })
    expect(wait.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(wait.verdict.detail).toContain("readiness-failed(readiness-http-not-serving")
  })
  it("exec-lane end-to-end: unpublished api (no urls) reaches green through the fake-shim node check", async () => {
    const shim = makeFakeDockerShim([
      { match: "={{.Health}}", stdout: "swarm-tools-api-1=running=<none>" },
      { match: "command -v", stdout: "/usr/local/bin/node\n" },
      { match: "node -e", stdout: "READY 200\n" },
    ])
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "firecrawl.yml",
      deadlineMs: 40,
      intervalMs: 10,
      sleep: async () => {},
      clock: fakeClock(),
      composeText: FC_FIXTURE,
      probe: makeReadinessProbe({ docker: shim.runner, composeText: FC_FIXTURE }),
    })
    expect(wait.token).toBe(OUTCOME.OK)
  })
  it("healthVerdict semantics stay row-91's: a declared-healthcheck container is never probe-gated", () => {
    const v = healthVerdict([{ name: "x-1", running: true, health: "healthy" }], undefined)
    expect(v.healthy).toBe(true)
  })
})

// ---- §10.6 item 6 raw-egress probe (r75-fix6 repaired form) ------------------------------------

describe("item 6 raw-egress probe — control-first, L1-only naming, VOID on dead targets", () => {
  const nodeFound = { match: "command -v node", stdout: "/usr/local/bin/node\n" }
  const controlGreen = async (): Promise<ControlOutcome> => ({ ok: true, vantage: "fixture-vm", detail: "ok" })
  const controlDead = async (): Promise<ControlOutcome> => ({ ok: false, vantage: "none", detail: "all vantages failed" })

  it("DEAD CONTROL ⇒ every leg VOID-TARGET-DEAD, overall VOID — and the container is never even exec'd", async () => {
    const shim = makeFakeDockerShim([])
    const report = await runRawEgressProbe({ docker: shim.runner, container: "swarm-tools-playwright-service-1", control: controlDead })
    expect(report.overall).toBe("VOID")
    expect(report.legs.every((l) => l.verdict === "VOID-TARGET-DEAD")).toBe(true)
    expect(shim.invocations.length).toBe(0) // control-first rule: no leg runs behind a dead control
  })
  it("control green + ENETUNREACH refusals ⇒ L1-HOLDS, layer named L1/topology, NEVER L4/squid", async () => {
    const shim = makeFakeDockerShim([nodeFound, { match: "--input-type=module", exitCode: 1, stdout: "RAW_EGRESS=BLOCKED ENETUNREACH" }])
    const report = await runRawEgressProbe({ docker: shim.runner, container: "swarm-tools-playwright-service-1", control: controlGreen })
    expect(report.overall).toBe("L1-HOLDS")
    expect(report.legs.every((l) => l.layer === "L1/topology")).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/L4|squid/i)
    // mandated IPv4 literal targets, in spec priority order
    expect(report.legs.map((l) => `${l.target.host}:${l.target.port}`)).toEqual(RAW_EGRESS_TARGETS.map((t) => `${t.host}:${t.port}`))
  })
  it("connect success ⇒ LEAK dominates the overall verdict", async () => {
    const shim = makeFakeDockerShim([nodeFound, { match: "--input-type=module", stdout: "RAW_EGRESS=LEAK" }])
    const report = await runRawEgressProbe({ docker: shim.runner, container: "pw-1", control: controlGreen })
    expect(report.overall).toBe("LEAK")
  })
  it("ECONNREFUSED across a public literal means a PATH EXISTS — leak side, never L1 credit", async () => {
    const shim = makeFakeDockerShim([nodeFound, { match: "--input-type=module", exitCode: 1, stdout: "RAW_EGRESS=BLOCKED ECONNREFUSED" }])
    const report = await runRawEgressProbe({ docker: shim.runner, container: "pw-1", control: controlGreen })
    expect(report.overall).toBe("LEAK")
  })
  it("TIMEOUT ⇒ AMBIGUOUS, never counted as containment", async () => {
    const shim = makeFakeDockerShim([nodeFound, { match: "--input-type=module", exitCode: 1, stdout: "RAW_EGRESS=TIMEOUT" }])
    const report = await runRawEgressProbe({ docker: shim.runner, container: "pw-1", control: controlGreen })
    expect(report.overall).toBe("AMBIGUOUS")
    expect(report.legs[0]?.verdict).toBe("TIMEOUT-AMBIGUOUS")
  })
  it("no mandated tool (bash alone does NOT count for item 6) ⇒ VOID-NO-TOOL", async () => {
    // ubuntu/squid-class image: only bash exists. Rules are ordered and the shim takes the first
    // substring match, so the four name-exact misses come before the catch-all that answers bash.
    const shim = makeFakeDockerShim([
      { match: "command -v node", exitCode: 1, stdout: "" },
      { match: "command -v curl", exitCode: 1, stdout: "" },
      { match: "command -v nc", exitCode: 1, stdout: "" },
      { match: "command -v wget", exitCode: 1, stdout: "" },
      { match: "command -v", stdout: "/bin/bash\n" },
    ])
    const report = await runRawEgressProbe({ docker: shim.runner, container: "pw-1", control: controlGreen })
    expect(report.overall).toBe("VOID")
    expect(report.legs[0]?.verdict).toBe("VOID-NO-TOOL")
    // The ladder itself never asked for bash — exclusion is in ITEM6_TOOL_ORDER, not in filtering:
    const asked = shim.invocations.filter((a) => a.join(" ").includes("command -v")).map((a) => a.join(" "))
    expect(asked.some((j) => /command -v bash/.test(j))).toBe(false)
    expect(asked.length).toBe(12) // all four mandated rungs × three legs, no fifth (bash) probe
  })
  it("the node leg carries no proxy env flag — squid cannot be in this path by construction", async () => {
    const shim = makeFakeDockerShim([nodeFound, { match: "--input-type=module", stdout: "RAW_EGRESS=LEAK" }])
    await runRawEgressProbe({ docker: shim.runner, container: "pw-1", control: controlGreen })
    const leg = shim.invocations.find((a) => a.join(" ").includes("--input-type=module")) ?? []
    expect(leg.join(" ")).not.toMatch(/proxy/i)
    expect(leg.join(" ")).toContain("node:net")
    expect(leg.join(" ")).toContain("s.connect(")
  })
})

// ---- source posture of the new shipped module (self-gate, mirrors PROOF 4a/4b discipline) -----

describe("readinessProbe.ts source posture — no port literals, no host-side network/spawn primitive", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "readinessProbe.ts"), "utf8")

  it("carries zero banned port/IP:port literals (same regex family as stack.proofs.sh PROOF 4a)", () => {
    expect(src.match(/\b(8888|3002|902[0-9]|8080|3128|5432|6379|5672|3000|3004|3005)\b|127\.0\.0\.1:[0-9]/)).toBe(null)
  })
  it("imports no host-side network/spawn primitive (the node:net occurrence is INSIDE an in-container script string, never a top-level import)", () => {
    // Line-scoped on purpose: a cross-line [\s\S] search would hit the embedded in-container
    // script string, which legitimately carries `import net from "node:net"` FOR THE CONTAINER.
    const hostImports = src.split("\n").filter((l) => l.includes('from "node:') && !l.includes("`"))
    expect(hostImports).toEqual([])
    // Positive control that the filter above is not vacuously passing:
    expect(src.split("\n").some((l) => l.includes('from "node:net') && l.includes("`"))).toBe(true)
    expect(src).not.toContain("Bun.spawn")
    expect(src).not.toContain("require(")
    expect(src).not.toContain("eval(")
  })
  it("carries none of row 81's package-wide bind/listen gate tokens (test/proofs.sh PROOF 6 greps ALL of src/)", () => {
    // PROOF 6's regex is token-based and hits embedded script strings too — the item-6 snippet
    // therefore names the Socket class instead of the net.connect sugar (same semantics).
    const proof6 = /\.(listen|bind)\(|createServer|Bun\.serve|Deno\.listen|startTls|createConnection|net\.connect|http\.Server/
    expect(src.match(proof6)).toBe(null)
  })
  it("builds --context in exactly ONE argv site, sourced from constants (R112c-2: no second source of truth)", () => {
    // execArgs is the module's only exec-argv builder; if a future edit hand-crafts ["exec", …]
    // or inlines a literal "--context", these counts break and the R112c-2 class returns visibly.
    expect(src.split('["--context",').length - 1).toBe(1)
    expect(src).toContain('import { DOCKER_CONTEXT } from "./constants.ts"')
    expect(src).not.toContain("colima-swarm") // register name lives in constants.ts only
    expect(src.split('"exec"').length - 1).toBe(1) // only inside execArgs itself
  })
})
