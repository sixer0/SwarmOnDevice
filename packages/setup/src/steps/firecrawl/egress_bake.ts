// egress-proxy (squid) CONFIG-BAKE verifier — row 92, PC-CMP-07 sub-artifact.
//
// WHAT THIS IS AND ITS SHAPE (declared per brief): this is NOT a scanned step and NOT a StepModule.
// `egress-proxy` is not one of the seven PC-CMP component ids (constants.ts COMPONENT_IDS = runtime,
// node, graft, rtk, obsidian, searxng, firecrawl); squid is a SUB-ARTIFACT of the Firecrawl component —
// it lives in tools.lock.json as components.firecrawl.egress_proxy_image (PC-IMG-09) and renders as the
// `egress-proxy` service INSIDE firecrawl/compose/firecrawl.yml with its config at
// firecrawl/squid/squid.conf. A src/steps/egress-proxy/ directory would push a descriptor error into
// discoverSteps (steps.ts validateDescriptor: id must be a register PC-CMP value AND equal the dir name),
// failing EVERY install closed — the identical constraint rows 84 (stepkit), 85 (composefiles) and 91
// (stacklib) resolved as services. So row 92 ships a firecrawl-step EXTENSION file: it sits inside the
// firecrawl step dir (the scan reads only step.json, so nothing here is registered) and wires THROUGH
// src/stacklib.ts + src/composefiles/shared.ts by IMPORT. It edits NONE of row 91's files and none of
// row 85's renderers.
//
// WHAT IT PROVES (offline only — no docker, no process spawn, no network; real pulls are rows 93/112):
//   (1) config correctness — the rendered firecrawl.yml egress-proxy service loads exactly the rendered
//       squid.conf (bind source == the host conf, `-f` target == the bound container path), the pinned
//       image the proxy will run EQUALS the lock pin (no magic digest literal here — equality computed),
//       and Playwright's enforced egress route (PROXY_SERVER -> egress-proxy:squid port) is present.
//   (2) fail-closed on an unusable pin — a null/tag-only egress_proxy_image refuses (via stacklib's
//       egressProxyPinReady, so the rule is not duplicated).
//   (3) SSRF deny-rule assertion — the rendered squid.conf carries EVERY §10.4 private/loopback/link-local/
//       CGNAT/IPv6-local range in a `to_localnet dst` ACL AND those ACLs are WIRED into http_access deny
//       before a trailing default-deny (parse-and-assert over the code portion, not a naive grep).
//   (4) the non-negotiable hardening keys gate §8 cond.2 makes a standing duty of row 92's lift
//       (cap_drop ALL, no-new-privileges, memswap_limit == mem_limit) plus ports-only-80/443 and no-cache.
//   (5) a data-only health-gate CONTRACT for row 93 (entrypoint-agnostic running/healthcheck posture —
//       stock entrypoint.sh + command flags, NOT Pebble per the r77b correction; nothing here assumes a
//       Pebble socket or wait command).
//
// BOUNDARIES: zero port literals (PC_PORTS.squidContainer only, imported); zero @sha256 digest literals in
// src (the cleared reference lives only in the test fixtures, mirroring r91's egress-pin fixtures); no
// process-spawn or raw-network builtin is imported and none is ever called; the verifier WRITES NOTHING EVER
// (verification-only — the configured->healthy move stays bringUp's, rows 91/93), which is what makes
// dry-run zero-writes trivially true. It is consent-gated FIRST through the StepKit before any action (P-13).

import { existsSync, readFileSync } from "node:fs"
import { OUTCOME, type OutcomeToken } from "../../outcomes.ts"
import type { LockFile } from "../../lockfile.ts"
import type { StepKit } from "../../stepkit.ts"
import { egressProxyPinReady, firecrawlPlan } from "../../stacklib.ts"
import { pathsFor, PC_PORTS } from "../../composefiles/shared.ts"

/** §10.4 destinations that MUST be denied (masterplan/01e_compose_spec.md:1027-1030). Canonical CIDR
 *  spellings as the r85 renderer emits them; kept here so the assertion names exactly what it demands
 *  rather than scanning for an arbitrary blob. These are policy REQUIREMENTS, not invented values. */
export const REQUIRED_DENY_RANGES: readonly { readonly cidr: string; readonly kind: string }[] = [
  { cidr: "127.0.0.0/8", kind: "loopback" },
  { cidr: "10.0.0.0/8", kind: "private (RFC1918)" },
  { cidr: "172.16.0.0/12", kind: "private (RFC1918)" },
  { cidr: "192.168.0.0/16", kind: "private (RFC1918)" },
  { cidr: "169.254.0.0/16", kind: "link-local" },
  { cidr: "100.64.0.0/10", kind: "CGNAT" },
  { cidr: "::1/128", kind: "IPv6 loopback" },
  { cidr: "fe80::/10", kind: "IPv6 link-local" },
  { cidr: "fc00::/7", kind: "IPv6 unique-local" },
]

/** The in-container path squid is told to load (r85 bindMount target). One definition site, reused by the
 *  bind-target and `-f`-argument checks so they cannot drift from each other. */
const SQUID_CONF_TARGET = "/etc/squid/swarm-egress.conf"

export type BakeCode =
  | "ARTEFACT_MISSING"
  | "PIN_UNUSABLE"
  | "IMAGE_PIN_MISMATCH"
  | "CONF_BIND_MISSING"
  | "CMD_CONF_MISMATCH"
  | "PROXY_ROUTE_UNSET"
  | "DENY_RANGE_MISSING"
  | "DENY_HOSTNAME_MISSING"
  | "DENY_NOT_ENFORCED"
  | "DEFAULT_DENY_MISSING"
  | "DEFAULT_DENY_MISORDERED"
  | "PORT_FILTER_MISSING"
  | "NOCACHE_MISSING"
  | "SQUID_GRAMMAR_INVALID"
  | "HARDENING_CAPS"
  | "HARDENING_NO_NEW_PRIVS"
  | "HARDENING_MEMSWAP"

export interface BakeFinding {
  readonly code: BakeCode
  readonly item: string
  readonly hint: string
}

export interface EgressBakeVerdict {
  readonly ok: boolean
  readonly findings: BakeFinding[]
  /** Pinned ref read from the lock (present when the pin was usable). */
  readonly imageRef?: string
  readonly composePath: string
  readonly confPath: string
}

/** Collapses duplicate path separators so a stray/double-slash HOME cannot skew the artefact-path
 *  comparison (same reason stacklib keeps a private copy; local so row 92 adds nothing to r81-owned decls). */
function collapseSlashes(p: string): string {
  return p.replace(/\/{2,}/g, "/")
}

function toolsRootOf(home?: string): string {
  const raw = home ? `${home}/.swarm/tools` : `${homeDirFromEnv()}/.swarm/tools`
  return collapseSlashes(raw)
}

function homeDirFromEnv(): string {
  const h = process.env.HOME
  return h && h.length > 0 ? h : ""
}

export interface VerifyOptions {
  readonly lock: LockFile
  /** Resolve the rendered artefacts under this HOME (production/row-93 posture). Optional so tests can
   *  drive artefacts from memory instead (composeText/confText) without touching disk. */
  readonly home?: string
  /** In-memory artefacts (test seam + re-render path). When absent the verifier reads the resolved files. */
  readonly composeText?: string
  readonly confText?: string
}

/** Parse-and-assert the RENDERED egress-proxy config against the lock pin and the §10.4 policy. Pure read:
 *  touches nothing on disk beyond reading the two artefacts when their text was not supplied. Lists EVERY
 *  finding (fail-closed listing, mirroring stacklib.checkPreconditions). */
export function verifyEgressBake(opts: VerifyOptions): EgressBakeVerdict {
  const root = toolsRootOf(opts.home)
  const composePath = firecrawlPlan(opts.home).composeFile
  const confPath = pathsFor(root).firecrawlSquidConf
  const findings: BakeFinding[] = []

  const pin = egressProxyPinReady(opts.lock)
  if (!pin.ok) {
    // Fail-closed BEFORE any artefact parsing: an unpinned/unusable proxy means there is nothing safe to
    // bake and nothing to verify (null / tag-only -> refuse; row 79 §8 cond.3).
    return {
      ok: false,
      findings: [
        {
          code: "PIN_UNUSABLE",
          item: pin.found,
          hint: "components.firecrawl.egress_proxy_image must carry a controller-confirmed @sha256 digest; until it does the Firecrawl component stays skipped (fallback F-3)",
        },
      ],
      composePath,
      confPath,
    }
  }

  const composeText = opts.composeText ?? readIfPresent(composePath)
  if (composeText === null) {
    return {
      ok: false,
      findings: [
        {
          code: "ARTEFACT_MISSING",
          item: composePath,
          hint: "render + apply the row-85 firecrawl compose before the bake (this row consumes the artefact, never re-renders it into ~/.swarm)",
        },
      ],
      imageRef: pin.ref,
      composePath,
      confPath,
    }
  }
  const confText = opts.confText ?? readIfPresent(confPath)
  if (confText === null) {
    return {
      ok: false,
      findings: [
        {
          code: "ARTEFACT_MISSING",
          item: confPath,
          hint: "the §10.4 squid.conf must be rendered beside the compose before bring-up (D-22: never mount what was not created)",
        },
      ],
      imageRef: pin.ref,
      composePath,
      confPath,
    }
  }

  const block = serviceBlock(composeText, "egress-proxy")
  if (block.length === 0) {
    findings.push({
      code: "CONF_BIND_MISSING",
      item: "egress-proxy service absent",
      hint: "the rendered firecrawl.yml carries no egress-proxy service block — the filter does not exist, so the browser tier would be unfiltered (F-3 territory)",
    })
  }

  // (1) image == pin. The proxy that boots IS the proxy the lock pins; equality computed, no literal here.
  const imageRef = matchValue(block, /^ {4}image:\s*(\S+)/)
  if (block.length > 0 && imageRef !== pin.ref) {
    findings.push({
      code: "IMAGE_PIN_MISMATCH",
      item: `image "${imageRef ?? "(none)"}" != lock pin "${pin.ref}"`,
      hint: "compose must reference the locked digest verbatim (P-9); the daemon enforces it at --pull never (real pull is rows 93/112)",
    })
  }

  // (1b) the rendered conf is bound into the container at the path the command loads.
  const sources = matchAllValues(block, /^ {4}(?: *)source:\s*(\S+)/)
  const targets = matchAllValues(block, /^ {4}(?: *)target:\s*(\S+)/)
  if (!sources.includes(confPath) || !targets.includes(SQUID_CONF_TARGET)) {
    findings.push({
      code: "CONF_BIND_MISSING",
      item: `bind source=${confPath} target=${SQUID_CONF_TARGET} not found in egress-proxy volumes`,
      hint: "egress-proxy must bind the rendered §10.4 squid.conf read-only at /etc/squid/swarm-egress.conf (r85 bindMount)",
    })
  }

  // (1c) the squid command points `-f` at that bound path (config the process actually reads).
  const command = matchValue(block, /^ {4}command:\s*(.+?)\s*#/) ?? matchValue(block, /^ {4}command:\s*(.+)$/)
  // stop the token at the JSON-array quoting so `/path.conf"]` parses to `/path.conf`
  const dashF = command ? matchValue([command], /-f\s+([^\s"\]]+)/) : undefined
  if (dashF !== SQUID_CONF_TARGET) {
    findings.push({
      code: "CMD_CONF_MISMATCH",
      item: `command -f arg "${dashF ?? "(none)"}" != ${SQUID_CONF_TARGET}`,
      hint: "the entrypoint.sh+flags form must load the bound conf (01e §10.4 corrected fact; stock entrypoint, NOT Pebble)",
    })
  }

  // (1d) Playwright's enforced egress route exists (PROXY_SERVER -> egress-proxy:<squid port>); built from PC_PORTS, never a literal port.
  const routeNeedle = `http://egress-proxy:${PC_PORTS.squidContainer}`
  if (!composeText.split("\n").some((l) => /^\s+PROXY_SERVER:\s*".*"/.test(l) && l.includes(routeNeedle))) {
    findings.push({
      code: "PROXY_ROUTE_UNSET",
      item: `no PROXY_SERVER set to "${routeNeedle}"`,
      hint: "the filter is only real if the SSRF-capable surface is routed through it (P-9; PC-PORT-06 via PC_PORTS.squidContainer, no literal here)",
    })
  }

  // (4) non-negotiable hardening keys (gate §8 cond.2, verification/10:285-289).
  if (!lineMatches(block, /^ {4}cap_drop:/).some((l) => l.includes("ALL"))) {
    findings.push({
      code: "HARDENING_CAPS",
      item: "egress-proxy has no cap_drop: [ALL]",
      hint: "§8 cond.2: hardening keys are non-negotiable for the only estate container that speaks to arbitrary hosts",
    })
  }
  if (!lineMatches(block, /^ {4}security_opt:/).some((l) => l.includes("no-new-privileges:true"))) {
    findings.push({
      code: "HARDENING_NO_NEW_PRIVS",
      item: "egress-proxy missing security_opt no-new-privileges:true",
      hint: "§8 cond.2 (01e §4.5 hardening)",
    })
  }
  const memLimit = matchValue(block, /^ {4}mem_limit:\s*(\S+)/)
  const memswap = matchValue(block, /^ {4}memswap_limit:\s*(\S+)/)
  if (block.length > 0 && (!memLimit || memLimit !== memswap)) {
    findings.push({
      code: "HARDENING_MEMSWAP",
      item: `memswap_limit "${memswap ?? "(none)"}" != mem_limit "${memLimit ?? "(none)"}"`,
      hint: "§8 cond.2: memswap_limit == mem_limit (no swap escape on the filtering proxy)",
    })
  }

  findings.push(...auditSquidConf(confText))

  return { ok: findings.length === 0, findings, imageRef: pin.ref, composePath, confPath }
}

/** Parse-and-assert the squid.conf over the CODE portion only (inline `#` comments stripped so a comment
 *  naming an IP can never satisfy a deny check). Returns every §10.4 violation as a named finding. */
export function auditSquidConf(confText: string): BakeFinding[] {
  const findings: BakeFinding[] = []
  const code = confText.split("\n").map((line) => line.split("#")[0] ?? "") // comment-stripped, order preserved

  // Collect every dst token across both to_localnet acl lines (v4 + v6 in the r85 render).
  const denyTokens = new Set<string>()
  for (const c of code) {
    const m = c.match(/^acl\s+to_localnet\s+dst\s+(.+)$/)
    if (m?.[1]) for (const tok of m[1].trim().split(/\s+/)) denyTokens.add(tok)
  }

  for (const req of REQUIRED_DENY_RANGES) {
    if (!denyTokens.has(req.cidr))
      findings.push({
        code: "DENY_RANGE_MISSING",
        item: `${req.cidr} (${req.kind}) not in any acl to_localnet dst`,
        hint: "§10.4 deny-list; a missing private/link-local range leaves an SSRF door open through the egress proxy",
      })
  }

  // Hostname forms (rebinding/`.local`) covered by a dedicated to_localhost ACL.
  // H-R93-6 (r93 live VM): the pre-fix r85 render mixed `dst localhost domain .local` on one line — INVALID
  // squid grammar (`domain` is an ACL-type word, never a dst argument) -> `FATAL: Bungled` at boot, which this
  // audit missed because it asserted token PRESENCE, not grammar. Valid form: `acl to_localhost dstdomain <suffix>`
  // lines (IP answers stay in to_localnet dst). Coverage = both `localhost` and `.local` present as dstdomain args.
  const hostnameTokens = new Set<string>()
  for (const c of code) {
    const m = c.match(/^acl\s+to_localhost\s+dstdomain\s+(\S+)\s*$/)
    if (m?.[1]) hostnameTokens.add(m[1])
  }
  const hostnameCovered = hostnameTokens.has("localhost") && hostnameTokens.has(".local")
  if (!hostnameCovered) {
    findings.push({
      code: "DENY_HOSTNAME_MISSING",
      item: "acl to_localhost dstdomain does not cover `localhost` and `.local`",
      hint: "§10.4 hostname form (CONNECT authority + absolute-URI host); dstdomain class per H-R93-6 — IP answers stay covered by to_localnet dst with CONNECT-time answer re-check (V3)",
    })
  }
  // Grammar guard for the exact H-R93-6 failure class: no `dst` ACL line may carry the word `domain`
  // (the invalid mix), so a regression to the old single-line shape is refused, not just un-satisfied.
  for (const c of code) {
    if (/^acl\s+\S+\s+dst\s+.*\bdomain\b/.test(c)) {
      findings.push({
        code: "SQUID_GRAMMAR_INVALID",
        item: `dst ACL carries 'domain': ${c.trim()}`,
        hint: "H-R93-6: dst takes IP/CIDR only; hostname suffixes need a dstdomain-class ACL or squid FATALs at boot",
      })
    }
  }

  // Enforcement wiring — the ACLs are useless unless http_access denies them.
  function deniesTo(input: string): number {
    return code.findIndex((c) => new RegExp(`^http_access\\s+deny\\s+${input}\\s*$`).test(c))
  }
  const denyLocalnet = deniesTo("to_localnet")
  const denyLocalhost = deniesTo("to_localhost")
  const denyAll = code.findIndex((c) => /^http_access\s+deny\s+all\s*$/.test(c))

  if (denyTokens.size > 0 && denyLocalnet === -1)
    findings.push({
      code: "DENY_NOT_ENFORCED",
      item: "http_access deny to_localnet absent",
      hint: "an unenforced ACL filters nothing (10.4 deny-then-default-deny ordering)",
    })
  if (hostnameTokens.size > 0 && denyLocalhost === -1)
    findings.push({
      code: "DENY_NOT_ENFORCED",
      item: "http_access deny to_localhost absent",
      hint: "hostname-class SSRF is unprotected without it",
    })
  if (denyAll === -1)
    findings.push({
      code: "DEFAULT_DENY_MISSING",
      item: "no trailing http_access deny all",
      hint: "default-deny is the last line; without it anything unmatched is allowed (10.4)",
    })
  else if ((denyLocalnet !== -1 && denyAll < denyLocalnet) || (denyLocalhost !== -1 && denyAll < denyLocalhost)) {
    findings.push({
      code: "DEFAULT_DENY_MISORDERED",
      item: "http_access deny all appears BEFORE the specific denies",
      hint: "ordering matters in squid; default-deny first would shadow the allow of localnet and is also a misconfiguration class (10.4)",
    })
  }

  // Ports-only-80/443 + CONNECT restricted to SSL_ports (10.4).
  const safePorts = code.find((c) => /^acl\s+SafePorts\s+port\b/.test(c)) ?? ""
  const sslPorts = code.find((c) => /^acl\s+SSL_ports\s+port\b/.test(c)) ?? ""
  const denyUnsafe = code.some((c) => /^http_access\s+deny\s+!SafePorts\s*$/.test(c))
  const denyConnectorNonSsl = code.some((c) => /^http_access\s+deny\s+Connector\s+!SSL_ports\s*$/.test(c))
  const has80 = /(^|\s)80(\s|$)/.test(safePorts)
  const has443 = /(^|\s)443(\s|$)/.test(safePorts) || /(^|\s)443(\s|$)/.test(sslPorts)
  if (!(has80 && has443 && denyUnsafe && denyConnectorNonSsl)) {
    findings.push({
      code: "PORT_FILTER_MISSING",
      item: "ports-80/443-only guard incomplete",
      hint: "10.4 bullet 1: allow 80/443 only, deny !SafePorts, deny Connector !SSL_ports",
    })
  }

  // No cache (10.4 bullet 3 + §8 cond.2).
  const noCache = code.some((c) => /^cache\s+deny\s+all\s*$/.test(c)) || code.some((c) => /^cache_mem\s+0\b/.test(c))
  if (!noCache)
    findings.push({
      code: "NOCACHE_MISSING",
      item: "no cache-deny directive",
      hint: "10.4: no caching; every object non-cacheable",
    })

  return findings
}

/** Data-only health-gate contract for row 93. Exposes WHICH service to watch and the entrypoint-agnostic
 *  posture (running + optional declared healthcheck — NO Pebble socket/wait assumption, r77b correction);
 *  row 93 feeds it into the generic waitForHealthy/healthVerdict machinery already in stacklib. */
export interface EgressHealthContract {
  readonly component: "firecrawl"
  readonly service: "egress-proxy"
  readonly composeFile: string
  /** Whether the rendered egress-proxy declares an in-stack docker healthcheck. False => the gate falls
   *  back to running-status (01e §4.8 advisory-in-stack posture). Reported, never assumed. */
  readonly declaresHealthcheck: boolean
  readonly posture: "running+optional-healthcheck"
  readonly note: string
}

export function egressHealthContract(opts: VerifyOptions & { readonly composeText?: string }): EgressHealthContract {
  const composeText = opts.composeText ?? readIfPresent(firecrawlPlan(opts.home).composeFile) ?? ""
  const block = serviceBlock(composeText, "egress-proxy")
  return {
    component: "firecrawl",
    service: "egress-proxy",
    composeFile: firecrawlPlan(opts.home).composeFile,
    declaresHealthcheck: block.some((l) => /^ {4}healthcheck:/.test(l)),
    posture: "running+optional-healthcheck",
    note: "entrypoint-agnostic per the r77b correction (stock entrypoint.sh + command flags, NOT Pebble): the gate watches container-running and, if declared, healthcheck-green — it never encodes a Pebble socket or wait command.",
  }
}

export interface EgressBakeOptions {
  readonly kit: StepKit
  readonly home?: string
  readonly composeText?: string
  readonly confText?: string
}

export interface EgressBakeResult {
  readonly token: OutcomeToken
  readonly message: string
  readonly verdict: EgressBakeVerdict
}

/** Consent-gated install-path wrapper. Refuses REFUSED_NO_CONSENT FIRST (before reading anything
 *  actionable), then verifies the bake read-only. Writes NOTHING on either path — the verifier is pure, so
 *  a dry-run trivially performs zero filesystem writes; the configured->healthy move stays bringUp's (91/93).
 *  A FAILED bake is the honest gate onto fallback F-3 (Firecrawl stays off), never a silent pass. */
export async function bakeEgressProxy(opts: EgressBakeOptions): Promise<EgressBakeResult> {
  const { kit } = opts
  if (!kit.hasConsent()) {
    return {
      token: OUTCOME.REFUSED_NO_CONSENT,
      message: "no recorded consent for firecrawl; egress-proxy bake performed no reads/writes",
      verdict: {
        ok: false,
        findings: [],
        composePath: firecrawlPlan(opts.home).composeFile,
        confPath: pathsFor(toolsRootOf(opts.home)).firecrawlSquidConf,
      },
    }
  }

  const verdict = verifyEgressBake({
    lock: kit.lock,
    ...(opts.home ? { home: opts.home } : {}),
    ...(opts.composeText ? { composeText: opts.composeText } : {}),
    ...(opts.confText ? { confText: opts.confText } : {}),
  })
  const where = kit.dryRun ? "dry-run " : ""

  if (!verdict.ok) {
    kit.log("error", `firecrawl egress-proxy ${where}bake refused closed (${verdict.findings.length} finding(s))`, {
      context: { findings: verdict.findings.map((f) => `${f.code}: ${f.item}`) },
    })
    const listing = verdict.findings.map((f) => `[${f.code}] ${f.item} — ${f.hint}`).join("\n")
    return {
      token: OUTCOME.FAILED,
      message: `egress-proxy config bake failed closed:\n${listing}\nFallback F-3 (Firecrawl ships off / component skipped) is the honest terminus until the pinned squid enforces §10.4.`,
      verdict,
    }
  }

  kit.log(
    "info",
    `firecrawl egress-proxy ${where}bake green — rendered conf matches the pinned digest, deny-list wired, hardening + no-cache present`,
    { context: { imageRef: verdict.imageRef, confPath: verdict.confPath } },
  )
  return {
    token: OUTCOME.OK,
    message: `egress-proxy bake green: rendered squid.conf matches the locked pin (${verdict.imageRef}); SSRF deny-ranges present and wired; real pull/serve verified live by rows 93/112`,
    verdict,
  }
}

// --- tiny pure artefact parsers (comment-stripped where policy correctness depends on it) --------------

function readIfPresent(path: string): string | null {
  if (!existsSync(path)) return null
  return readFileSync(path, "utf8")
}

/** Extract one service's block (lines indented under `  <name>:` up to the next indent-2 key). */
function serviceBlock(composeText: string, service: string): string[] {
  const out: string[] = []
  let inBlock = false
  for (const line of composeText.split("\n")) {
    if (new RegExp(`^ {2}${service}:\\s*$`).test(line)) inBlock = true
    else if (inBlock && /^ {2}\S/.test(line)) break // next service / top-level key at indent 2
    if (inBlock) out.push(line)
  }
  return out
}

function lineMatches(block: readonly string[], re: RegExp): string[] {
  return block.filter((l) => re.test(l))
}

function matchValue(lines: readonly string[], re: RegExp): string | undefined {
  for (const l of lines) {
    const m = l.match(re)
    if (m?.[1]) return m[1]
  }
  return undefined
}

function matchAllValues(lines: readonly string[], re: RegExp): string[] {
  const out: string[] = []
  for (const l of lines) {
    const m = l.match(re)
    if (m?.[1]) out.push(m[1])
  }
  return out
}
