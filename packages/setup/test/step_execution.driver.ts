// Seam pass 8 — E2E driver for the wired step-execution path (finding R113-1).
//
// WHAT THIS IS: one scenario per invocation of the COMPILED swarm-setup binary (the shipped
// posture: bun --compile Mach-O + adjacent tools.lock.json), driven against a local mock release
// server in the exact shape row 108 built (test/tamper_matrix.driver.ts): Bun.serve, real TLS,
// throwaway CA under $TMPDIR, loopback on a probed 47xxx pool port, sandbox HOME under $TMPDIR.
// Row 108 drives STEP modules; this driver drives the CLI VERB end-to-end — which is precisely
// the surface no prior gate ever exercised (verification/09_preinstall_security.md §8.1: "row 106's
// gate is --help; rows 108/109/111/112 drive the step modules ... never the CLI verb").
//
// ZERO public network: every fetchable URL of the synthetic lock points at 127.0.0.1. The reviewed
// host names are carried only so validateLock passes unchanged (same discipline as r108).
// Exit convention: 0 = scenario passed, 1 = product outcome mismatched (a REAL red),
// 2 = harness error (a broken proof, never a product outcome) — mirrors tamper_matrix.driver.ts.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { exitCodeFor, OUTCOME, type OutcomeToken } from "../src/outcomes.ts"

// --- args ----------------------------------------------------------------------------------

function arg(name: string): string {
  const i = process.argv.indexOf(name)
  const value = i >= 0 ? process.argv[i + 1] : undefined
  if (!value) bail(`missing ${name}`)
  return value
}
function bail(message: string): never {
  console.log(`HARNESS-ERROR ${message}`)
  process.exit(2)
}

const SCENARIO = arg("--scenario")
const HOME_SANDBOX = arg("--home")
const PORT = Number(arg("--port"))
const CA_DIR = arg("--ca")
const BIN = arg("--bin")
if (!Number.isInteger(PORT) || PORT <= 0) bail(`--port must be a positive integer (probed), got ${arg("--port")}`)
if (!existsSync(BIN)) bail(`compiled binary missing: ${BIN}`)
if (!existsSync(join(CA_DIR, "server.key")) || !existsSync(join(CA_DIR, "chain.pem")))
  bail(`--ca incomplete (need server.key + chain.pem): ${CA_DIR}`)

process.env.HOME = HOME_SANDBOX // paths.ts resolves $HOME per call — the containment switch

// --- fixtures: REAL .tar.gz trees (the shipped step uses /usr/bin/tar + the real health spawn) --

const NODE_VERSION = "v24.22.0"

function buildTarGz(workDir: string, marker: string, payload: Record<string, string>): Uint8Array {
  const stage = join(workDir, `stage-${marker}`)
  // Product-shaped archive: ONE top-level dir (node-vX-darwin-arm64/), exactly what the shipped
  // extractors expect — node/index.ts::systemTarExtract passes --strip-components 1 (its comment
  // names that shape), rtk's locateRtk looks for <dir>/rtk WITHOUT stripping. A flat bin/node tree
  // is NOT a real release asset and correctly fails those steps.
  for (const rel of Object.keys(payload)) {
    const abs = join(stage, rel)
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
    writeFileSync(abs, payload[rel] ?? "", { mode: 0o755 })
  }
  const outPath = join(workDir, `fixture-${marker}.tgz`)
  const tops = [...new Set(Object.keys(payload).map((r) => r.split("/")[0] as string))]
  const r = Bun.spawnSync(["/usr/bin/tar", "-czf", outPath, "-C", stage, ...tops], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) bail(`tar -czf failed exit=${r.exitCode}: ${r.stderr.toString()}`)
  rmSync(stage, { recursive: true, force: true })
  return new Uint8Array(readFileSync(outPath))
}

const FIXTURE_WORK = join(HOME_SANDBOX, ".fixture-build")
mkdirSync(FIXTURE_WORK, { recursive: true, mode: 0o700 })
// One tree satisfying both shapes: bin/node (health stub printing the pin) + a sibling rtk stub,
// under a single top-level dir — so the SAME good bytes drive node's happy path and rtk's
// signature-gate refusal (an ad-hoc shebang stub cannot carry a real code signature; that IS the
// point of PROOF 8, mirroring why r108 had to script its signature seam instead).
const GOOD_TARBALL = buildTarGz(FIXTURE_WORK, "good", {
  "node-v24.22.0-darwin-arm64/bin/node": "#!/bin/sh\necho v24.22.0\n",
  "node-v24.22.0-darwin-arm64/rtk": "#!/bin/sh\necho 'rtk 1.0.1'\n",
})
const WRONG_TARBALL = buildTarGz(FIXTURE_WORK, "wrong", {
  "node-v24.22.0-darwin-arm64/bin/node": "#!/bin/sh\necho v0.0.0-TAMPERED\n",
  "node-v24.22.0-darwin-arm64/rtk": "#!/bin/sh\necho 'tampered'\n",
}) // same shape, different bytes -> the digest gate must refuse BEFORE any extraction
rmSync(FIXTURE_WORK, { recursive: true, force: true })

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const GOOD_SHA = sha256Hex(GOOD_TARBALL)
const WRONG_SHA = sha256Hex(WRONG_TARBALL)
const SIZE = GOOD_TARBALL.byteLength

const url = (path: string): string => `https://127.0.0.1:${PORT}${path}`
const REVIEWED_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "api.github.com",
  "ghcr.io",
  "registry-1.docker.io",
  "auth.docker.io",
  "registry.npmjs.org",
  "nodejs.org",
  "formulae.brew.sh",
]

/** Synthetic lock mirroring the shipped pin FIELD NAMES (tarball_sha256 / sha256 / integrity /
 *  dmg_sha256 / runtime sub-pins / null guest_image / digest-pinned images) so validateLock and
 *  each step's own guards behave exactly as they do on the shipped lock. Only node + rtk are ever
 *  fetched; the rest exist to satisfy the loader's completeness rule. In "tamper" mode the node pin
 *  KEEPS the reviewed (good) digest while the route serves different bytes — the exact r108 shape
 *  ("same byte length, different content: SIZE passes, HASH must refuse", tamper_matrix.driver.ts:249).
 *  Pinning the wrong bytes instead would make them the expected value and detect NOTHING; the
 *  mismatch between the consented/reviewed pin and the served artifact IS the attack surface. */
function syntheticLock(): Record<string, unknown> {
  const nodeMode = SCENARIO === "tamper" ? "tampered" : "good"
  return {
    schemaVersion: 1,
    version: "swarm-tools-1.19.3-r1+seam8-mock",
    hosts: [...REVIEWED_HOSTS, "127.0.0.1"],
    components: {
      runtime: {
        install_dir: "~/.swarm/tools/runtime",
        channel: "homebrew",
        colima: { url: url("/runtime/good/colima-v0.10.3.tgz"), version: "v0.10.3", size: SIZE, sha256: GOOD_SHA },
        lima: { url: url("/runtime/good/lima-v2.2.1.tgz"), version: "v2.2.1", size: SIZE, sha256: GOOD_SHA },
        docker_compose: {
          url: url("/runtime/good/docker-compose-v5.6.0.tgz"),
          version: "v5.6.0",
          size: SIZE,
          sha256: GOOD_SHA,
        },
        guest_image: { url: null, version: null, sha256: null },
      },
      node: {
        install_dir: "~/.swarm/tools/node",
        url: url(`/node/${nodeMode}/node-v24.22.0-darwin-arm64.tar.gz`),
        version: NODE_VERSION,
        codename: "Krypton",
        size: SIZE,
        tarball_sha256: GOOD_SHA,
      },
      graft: {
        install_dir: "~/.swarm/tools/graft",
        package: "@nanonets/graft",
        url: url("/graft/good/@nanonets/graft/-/graft-0.18.0.tgz"),
        version: "0.18.0",
        size: SIZE,
        integrity: `sha512-${createHash("sha512").update(GOOD_TARBALL).digest("base64")}`,
      },
      rtk: {
        install_dir: "~/.swarm/tools/rtk",
        edition: "rtk-oss",
        url: url("/rtk/good/rtk-oss-aarch64-apple-darwin.tar.gz"),
        version: "v1.0.1",
        size: SIZE,
        sha256: GOOD_SHA,
      },
      obsidian: {
        install_dir: "~/.swarm/tools/obsidian",
        url: url("/obsidian/good/Obsidian-1.14.4.dmg"),
        version: "v1.14.4",
        size: SIZE,
        dmg_sha256: GOOD_SHA,
        team_id: null,
        codesign_required: true,
      },
      searxng: {
        install_dir: "~/.swarm/tools/searxng",
        image: "ghcr.io/searxng/searxng@sha256:338f261054e8edf2a00000000000000000000000000000000000000000000000",
        valkey_image: "docker.io/valkey/valkey@sha256:eb5a657e070199bef00000000000000000000000000000000000000000000000",
      },
      firecrawl: {
        install_dir: "~/.swarm/tools/firecrawl",
        api_image: "ghcr.io/firecrawl/firecrawl@sha256:6bb90229081b94cd800000000000000000000000000000000000000000000000",
        redis_image: "docker.io/library/redis@sha256:41a10b18bd238fa7800000000000000000000000000000000000000000000000",
        egress_proxy_image: "docker.io/library/ubuntu@sha256:72f683fb2c096997000000000000000000000000000000000000000000000000",
      },
    },
  }
}

// The binary resolves its lock from dirname(process.execPath) (paths.resolveProgramDir, compiled
// posture): write the synthetic lock BESIDE the copied executable — the shipped adjacency posture,
// with fixture-derived pins instead of reviewed ones. computeLockSha256() reads these exact bytes.
const LOCK_PATH = join(dirname(BIN), "tools.lock.json")
writeFileSync(LOCK_PATH, JSON.stringify(syntheticLock(), null, 2), "utf8")
const LOCK_SHA256 = createHash("sha256").update(new Uint8Array(readFileSync(LOCK_PATH))).digest("hex")
/** The admin token for one component under this lock: <id>@<lock_sha256_12> (01d §6.1) — computed
 *  exactly as consent.ts does, over the bytes the binary will load. The CLI flag form is
 *  `--terms-token <component>=<value>` (cli.ts absorbToken), so the pair is joined with '='. */
const tokenFor = (componentId: string): string => `${componentId}=${componentId}@${LOCK_SHA256.slice(0, 12)}`

// --- mock release server (real TLS; routes select WHICH bytes answer) --------------------------

type Route = { readonly path: string; readonly bytes: Uint8Array }
const ROUTES: Record<string, Route> = {
  "/node/good/node-v24.22.0-darwin-arm64.tar.gz": { path: "/node/good/node-v24.22.0-darwin-arm64.tar.gz", bytes: GOOD_TARBALL },
  "/node/tampered/node-v24.22.0-darwin-arm64.tar.gz": {
    path: "/node/tampered/node-v24.22.0-darwin-arm64.tar.gz",
    bytes: WRONG_TARBALL,
  },
  "/rtk/good/rtk-oss-aarch64-apple-darwin.tar.gz": {
    path: "/rtk/good/rtk-oss-aarch64-apple-darwin.tar.gz",
    bytes: GOOD_TARBALL,
  },
}

let hits: string[] = []
const server = Bun.serve({
  port: PORT, // probed pool port from argv — never a literal here (PORT RULE)
  hostname: "127.0.0.1",
  tls: { key: Bun.file(join(CA_DIR, "server.key")), cert: Bun.file(join(CA_DIR, "chain.pem")) },
  fetch(req: Request): Response {
    const path = new URL(req.url).pathname
    hits.push(path)
    const route = ROUTES[path]
    if (!route) return new Response(null, { status: 404 })
    return new Response(route.bytes.slice(), { status: 200 })
  },
})

// --- subprocess harness -----------------------------------------------------------------------

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly token: OutcomeToken | ""
}

/** ASYNC on purpose (seam8 harness lesson): the child fetches from THIS process's mock server, so
 *  a blocking spawnSync would freeze the event loop that serves it — parent waits for child, child
 *  waits for parent, deadlock. Bun.spawn + awaited exited keeps the server live. */
async function runSetup(args: readonly string[], tokens: readonly string[]): Promise<RunResult> {
  const argv = [BIN, ...args]
  for (const t of tokens) argv.push("--terms-token", t)
  const child = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: HOME_SANDBOX,
      NODE_EXTRA_CA_CERTS: join(CA_DIR, "ca.pem"), // trust the throwaway CA for THIS child only
    },
  })
  const watchdog = setTimeout(() => child.kill(9), 180_000)
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const exitCode = await child.exited
  clearTimeout(watchdog)
  const m = /^RESULT (\S+)$/m.exec(out)
  return { exitCode, stdout: out, stderr: err, token: (m?.[1] ?? "") as OutcomeToken | "" }
}

// --- evidence helpers -------------------------------------------------------------------------

let assertions = 0
function expect(label: string, cond: boolean, detail = ""): void {
  assertions += 1
  console.log(`ASSERT ${cond ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`)
  if (!cond) process.exitCode = 1
}

function stateJson(): Record<string, any> {
  const p = join(HOME_SANDBOX, ".swarm/setup/state.json")
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return { __corrupt: true }
  }
}
function componentState(id: string): string {
  return stateJson()?.components?.[id]?.state ?? "<no-entry>"
}
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}
function consentLines(): Array<Record<string, unknown>> {
  const p = join(HOME_SANDBOX, ".swarm/setup/consent.log")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

// --- scenarios ---------------------------------------------------------------------------------

const TOPO_ORDER = ["runtime", "node", "graft", "rtk", "obsidian", "searxng", "firecrawl"]

async function scenarioDryRun(): Promise<void> {
  // (a) dry run lists the components in topological order and touches nothing (r81-fix2's proof,
  // re-held AFTER the wiring — the dispatch must not have leaked into the dry branch).
  const res = await runSetup(["install", "--dry-run"], [])
  expect("dry-run exit 1", res.exitCode === 1, `got ${res.exitCode}`)
  expect("dry-run RESULT REFUSED_NO_CONSENT", res.token === OUTCOME.REFUSED_NO_CONSENT, `got ${res.token}`)
  const listed = TOPO_ORDER.filter((id) => new RegExp(`^  - ${id}$`, "m").test(res.stdout))
  expect("dry-run lists all seven", listed.length === 7, `listed ${listed.length}: ${listed.join(",")}`)
  expect("dry-run order is topological", JSON.stringify(listed) === JSON.stringify(TOPO_ORDER), listed.join(","))
  expect("dry-run wrote no state.json", !existsSync(join(HOME_SANDBOX, ".swarm/setup/state.json")))
  expect("dry-run opened zero sockets", hits.length === 0, JSON.stringify(hits))
  expect("dry-run carries no placeholder line", !res.stdout.includes("would run step:"))
}

async function scenarioInstallOk(): Promise<void> {
  // (b) THE headline: a NON-dry consented run installs node END-TO-END through the shipped
  // pipeline — real fetch over TLS, real digest gate, real /usr/bin/tar extraction, real
  // private-binary health spawn — and the state file records the outcome.
  const res = await runSetup(["install", "node", "--non-interactive"], [tokenFor("node")])
  console.log(`STDOUT_TAIL=${res.stdout.split("\n").slice(-6).join(" | ")}`)
  console.log(`STDERR_TAIL=${res.stderr.split("\n").slice(-3).join(" | ")}`)
  expect("install exit 0", res.exitCode === 0, `got ${res.exitCode}`)
  expect("RESULT OK", res.token === OUTCOME.OK, `got ${res.token}`)
  expect("step line reports node OK", /^step node: OK/m.test(res.stdout), res.stdout.split("\n").filter((l) => l.startsWith("step ")).join(" | "))
  expect("state.json records node healthy", componentState("node") === "healthy", componentState("node"))
  const entry = stateJson()?.components?.node ?? {}
  expect("outcome record: installedBySwarm true", entry.installedBySwarm === true)
  expect(`outcome record: version ${NODE_VERSION}`, entry.version === NODE_VERSION, String(entry.version))
  expect("outcome record: integrity sha256:<64hex>", /^sha256:[0-9a-f]{64}$/.test(String(entry.integrity)), String(entry.integrity))
  expect("outcome record: paths manifest non-empty", Array.isArray(entry.paths) && entry.paths.length >= 3, JSON.stringify(entry.paths))
  const bin = join(HOME_SANDBOX, ".swarm/tools/node", NODE_VERSION, "bin", "node")
  expect("private node binary exists", existsSync(bin))
  if (existsSync(bin)) {
    const v = Bun.spawnSync([bin, "--version"], { stdout: "pipe", timeout: 15_000 })
    expect("private node --version prints the pin", v.stdout.toString().trim() === NODE_VERSION, v.stdout.toString().trim())
  }
  const lines = consentLines()
  expect("consent.log has exactly one node line", lines.filter((l) => l.component === "node").length === 1)
  const rec = lines.find((l) => l.component === "node") ?? {}
  for (const field of ["time", "user", "component", "version", "hash", "licence", "terms_url", "terms_revision", "mode", "token"]) {
    expect(`consent record carries ${field} (01d §6.5)`, typeof rec[field] === "string" && (rec[field] as string).length > 0)
  }
  expect("consent token matches this lock", rec.token === `node@${LOCK_SHA256.slice(0, 12)}`, `${String(rec.token)} vs node@${LOCK_SHA256.slice(0, 12)}`)
  expect("server saw the node route", hits.some((h) => h.startsWith("/node/good/")), JSON.stringify(hits))
  expect("zero non-route hits", hits.every((h) => h in ROUTES), JSON.stringify(hits))
}

async function scenarioTamper(): Promise<void> {
  // (c1) the failure path fails HONESTLY at the digest gate: exit 1, RESULT FAILED, the state
  // names PC-ST-07, and nothing is promoted.
  const res = await runSetup(["install", "node", "--non-interactive"], [tokenFor("node")])
  expect("tamper exit 1", res.exitCode === 1, `got ${res.exitCode}`)
  expect("tamper RESULT FAILED", res.token === OUTCOME.FAILED, `got ${res.token}`)
  expect("tamper step line names FAILED", /^step node: FAILED/m.test(res.stdout))
  expect("state records failed (PC-ST-07)", componentState("node") === "failed", componentState("node"))
  const toolFiles = filesUnder(join(HOME_SANDBOX, ".swarm/tools/node")).filter((f) => !f.endsWith(".swarm-node.json"))
  expect("no committed bin/node after refusal", !existsSync(join(HOME_SANDBOX, ".swarm/tools/node", NODE_VERSION, "bin", "node")))
  expect("no extracted version dir", !existsSync(join(HOME_SANDBOX, ".swarm/tools/node", NODE_VERSION)))
  console.log(`TOOL_FILES_AFTER=${JSON.stringify(toolFiles.map((f) => f.replace(HOME_SANDBOX, "~")))}`)
}

async function scenarioSigRefusal(): Promise<void> {
  // (c2) a step that PASSES its digest gate but REFUSES at its own signature gate still fails
  // the run honestly — proves the engine propagates step-internal refusals, not just fetch errors.
  const res = await runSetup(["install", "rtk", "--non-interactive"], [tokenFor("rtk")])
  expect("sig-refusal exit 1", res.exitCode === 1, `got ${res.exitCode}`)
  expect("sig-refusal RESULT FAILED", res.token === OUTCOME.FAILED, `got ${res.token}`)
  expect("message carries the signature refusal", res.stdout.includes("signature verification refused"), res.stdout.split("\n").filter((l) => l.startsWith("step ")).join(" | "))
  expect("state records failed", componentState("rtk") === "failed", componentState("rtk"))
  expect("no committed rtk version dir", !existsSync(join(HOME_SANDBOX, ".swarm/tools/rtk", "v1.0.1")))
}

async function scenarioMixed(): Promise<void> {
  // (c3) 01c §8 P-15 in the CLI lane: a failed optional component does not block a later install,
  // and each run reports its own truth. Run A: rtk alone -> FAILED. Run B (SAME home): node -> OK,
  // with rtk's failed entry preserved untouched.
  const a = await runSetup(["install", "rtk", "--non-interactive"], [tokenFor("rtk")])
  expect("run A (rtk) exit 1 FAILED", a.exitCode === 1 && a.token === OUTCOME.FAILED, `${a.exitCode}/${a.token}`)
  const b = await runSetup(["install", "node", "--non-interactive"], [tokenFor("node")])
  expect("run B (node) still installs: exit 0 OK", b.exitCode === 0 && b.token === OUTCOME.OK, `${b.exitCode}/${b.token}`)
  expect("run B did not clobber rtk's honest red", componentState("rtk") === "failed", componentState("rtk"))
  expect("run B recorded node healthy", componentState("node") === "healthy", componentState("node"))
}

async function scenarioNoConsent(): Promise<void> {
  // Consent-first stays first: an unconsented scripted run must refuse BEFORE any step executes —
  // zero server hits is the machine-checkable form (the pre-fix code could not even reach here).
  const res = await runSetup(["install", "node", "--non-interactive"], ["node=wrongtoken000"])
  expect("bad token exit 1", res.exitCode === 1, `got ${res.exitCode}`)
  expect("RESULT REFUSED_NON_INTERACTIVE", res.token === OUTCOME.REFUSED_NON_INTERACTIVE, `got ${res.token}`)
  expect("zero server hits without consent", hits.length === 0, JSON.stringify(hits))
  expect("no state.json written by a refused run", !existsSync(join(HOME_SANDBOX, ".swarm/setup/state.json")))
}

async function main(): Promise<void> {
  console.log(`SCENARIO ${SCENARIO}  home=${HOME_SANDBOX}  port=${PORT}`)
  if (SCENARIO === "dry-run") await scenarioDryRun()
  else if (SCENARIO === "install-ok") await scenarioInstallOk()
  else if (SCENARIO === "tamper") await scenarioTamper()
  else if (SCENARIO === "sig-refusal") await scenarioSigRefusal()
  else if (SCENARIO === "mixed") await scenarioMixed()
  else if (SCENARIO === "no-consent") await scenarioNoConsent()
  else bail(`unknown scenario ${SCENARIO}`)

  server.stop(true)
  console.log(`ASSERTIONS=${assertions}`)
  console.log(`HITS=${JSON.stringify(hits)}`)
  const exit = process.exitCode === 1 ? 1 : 0
  console.log(`EXITCODE=${exit}`)
  process.exit(exit)
}

main().catch((err) => {
  console.log(`HARNESS-ERROR ${(err as Error).stack ?? String(err)}`)
  process.exit(2)
})
