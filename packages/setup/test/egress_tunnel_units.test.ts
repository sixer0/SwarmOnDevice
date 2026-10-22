// Row 244 (blueprint 11) — the INDEPENDENT unit lane for the repaired render-and-audit pair.
//
// WHAT MAKES THIS A SEPARATE LANE AND NOT A COPY: rows 241/242/243 each assert their own work from their own
// vantage (the renderer's suite, the bake's suite). This file re-derives the same contract lines from the SPEC
// through different instruments — parsed YAML, index arithmetic over the rendered conf, and the whole-estate
// product path — so a change that satisfies one author but not the contract goes red somewhere other than the
// file that made it. Where an assertion deliberately repeats a predecessor's, the comment says so and why
// (independence of a security claim is worth two witnesses).
//
// Contract sources, all read-only for this row:
//   masterplan/01e_compose_spec.md §10.4 as amended by r11 (the tunnel form + the three surviving invariants)
//   masterplan/05_s6b_firecrawl_repair_contract.md §5 traps T-5/T-6
//   decisions/decisions.md gate-239 entry (fork B "Perlu": plain-HTTP tunnelling at two named losses)
//   identification/11_firecrawl_and_lanes_blueprint.md:368 (this row's Verification clause)
// Hand-offs honoured: RC-242-3 keeps the decoy-deny mutant and the `acl SSL_ports port 443` deletion as PERMANENT
// fixtures of this lane (see the describe named for them); RC-243-2's correction is honoured by asserting trap
// T-5's substance from the contract rather than from a §12 duty line that does not exist for row 243.
//
// Posture: no container, no colima, no build, no network, no daemon, no spawn. Artefacts come from the shipped
// renderers; every defect shape is built by editing rendered TEXT in memory, except the one staged-on-disk case
// that exists precisely to prove the disk path too. Scratch lives under $TMPDIR/kilo only. Run from
// packages/setup:  bun test test/egress_tunnel_units.test.ts   (or let `bun test` collect it — see the artifact).

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isolateSourceLock } from "./lockPosture.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { SECRET_INVENTORY, pathsFor, type RenderContext } from "../src/composefiles/shared.ts"
import { renderAll, applyRenderedFiles } from "../src/composefiles/index.ts"
import { renderSquidConf } from "../src/composefiles/squid_conf.ts"
import { findSquidOrderingViolations, lintComposeText, lintOk } from "../src/composefiles/lint.ts"
import { extraHostPairProblem } from "../src/composefiles/dns_pins.ts"
import { isDeniedAddress } from "../src/mcpproxy/urlpolicy.ts"
import {
  assertNoReservedAclNames,
  auditBootClass,
  auditExtraHostPins,
  auditSquidConf,
  bakeProofLayers,
  crossEnforcerAgreement,
  verifyEgressBake,
  APPROVED_TUNNEL_PORTS,
  NON_TUNNEL_PORTS,
  REQUIRED_DENY_RANGES,
  TLS_ONLY_PORTS,
} from "../src/steps/firecrawl/egress_bake.ts"

let releaseLockPosture: () => void
let LOCK: LockFile
const REAL_HOME = process.env.HOME
const scratchDirs: string[] = []

/** E7: pin HOME before anything resolves a user path, and make the pin a scratch dir under $TMPDIR/kilo. */
function scratchHome(label: string): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "kilo", `r244-${label}-`))
  scratchDirs.push(dir)
  return dir
}

beforeAll(() => {
  releaseLockPosture = isolateSourceLock()
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`loadLock failed in row-244 setup: ${loaded.error}`)
  LOCK = loaded.lock
  process.env.HOME = scratchHome("env-home")
})

afterAll(() => {
  releaseLockPosture?.()
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  process.env.HOME = REAL_HOME
})

// ------------------------------------------------------------------ fixtures and instruments (no logic duplicated from src)

const requiredManifest = (): RenderContext["secrets"] => {
  const manifest = { searxng: {} as Record<string, "generated">, firecrawl: {} as Record<string, "generated"> }
  for (const comp of ["searxng", "firecrawl"] as const)
    for (const spec of SECRET_INVENTORY[comp]) if (spec.required) manifest[comp][spec.name] = "generated"
  return manifest
}

/** Render the estate against a home, optionally carrying a dns-pins.json (the P3 producer's output shape §1.3).
 *  The seed carries PC-PATH-19's register mode 0600, because that is what the real writer does
 *  (`estate/pins.ts` commits through `atomicWriteJson(path, doc, MODES.FILE_0600)`); a bare `writeFileSync` left it
 *  at 0644, which row 267's widened mode audit then correctly refused on the staged-artefact leg of this lane. The
 *  fixture was the drift, not the audit — recorded here so nobody "fixes" it back. */
function renderEstate(home: string, pinsJson?: string) {
  mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
  if (pinsJson !== undefined) writeFileSync(join(home, ".swarm", "setup", "dns-pins.json"), pinsJson, { mode: 0o600 })
  const r = renderAll(LOCK, { home, secrets: requiredManifest() })
  if (!r.ok) throw new Error(`render refused unexpectedly: ${JSON.stringify(r.errors)} ${JSON.stringify(r.findings)}`)
  return r
}

function artefact(r: ReturnType<typeof renderEstate>, rel: string): string {
  const f = r.files.find((x) => x.relPath === rel)
  if (!f) throw new Error(`missing artefact ${rel}`)
  return f.content
}

const SHIPPED_CONF = (): string => renderSquidConf().content
const SHIPPED_COMPOSE = (): string => artefact(renderEstate(scratchHome("plain")), "firecrawl/compose/firecrawl.yml")

/** Comment-stripped, trimmed squid conf lines — the same view the audit reads, computed here independently. */
function codeLines(conf: string): string[] {
  return conf.split("\n").map((l) => (l.split("#")[0] ?? "").trim())
}

function numberedCode(conf: string): { code: string; n: number }[] {
  return conf.split("\n").map((l, i) => ({ code: (l.split("#")[0] ?? "").trim(), n: i + 1 }))
}

/** Names of ACLs declared with a destination type (dst / dstdomain) — keyed on TYPE, per R112-1. */
function destinationAclNames(conf: string): Set<string> {
  const out = new Set<string>()
  for (const l of codeLines(conf)) {
    const m = l.match(/^acl\s+(\S+)\s+(?:dst|dstdomain)\s+\S/)
    if (m?.[1]) out.add(m[1])
  }
  return out
}

/** Independent re-parse of the deny tokens this lane claims survive: only dst-typed ACLs that are actually
 *  denied contribute, which is what makes a declaration-without-a-deny worth nothing (§10.4). */
function deniedDstTokens(conf: string): Set<string> {
  const denied = new Set(
    codeLines(conf)
      .filter((l) => /^http_access\s+deny\s+\S+$/.test(l))
      .map((l) => (l.match(/^http_access\s+deny\s+(\S+)$/)?.[1] ?? "")),
  )
  const out = new Set<string>()
  for (const l of codeLines(conf)) {
    const m = l.match(/^acl\s+(\S+)\s+dst\s+(.+)$/)
    if (m && denied.has(m[1] ?? "")) for (const token of (m[2] ?? "").split(/\s+/)) if (token !== "") out.add(token)
  }
  return out
}

/** Corrupt the artefact by deleting one destination-class deny line (used by the ordering/instrument self-checks). */
function dropLine(conf: string, pattern: RegExp): string {
  return conf
    .split("\n")
    .filter((l) => !pattern.test(l))
    .join("\n")
}

/** Rebuild the pre-gate bytes: drop the tunnel ACL and re-point the CONNECT deny back at SSL_ports. */
function preGateBytes(conf: string): string {
  return dropLine(conf, /^\s*acl\s+swarm_tunnel_ports\s+port\b/)
    .replace("http_access deny Connector !swarm_tunnel_ports", "http_access deny Connector !SSL_ports")
}

/** Remove one whitespace token from every dst ACL line, leaving the rest of the file byte-identical. */
function removeDstToken(conf: string, token: string): string {
  return conf
    .split("\n")
    .map((l) => {
      if (!/^\s*acl\s+\S+\s+dst\s/.test(l)) return l
      const hash = l.indexOf("#")
      const body = hash === -1 ? l : l.slice(0, hash)
      const tail = hash === -1 ? "" : l.slice(hash)
      const kept = body
        .split(/\s+/)
        .filter((t) => t !== "" && t !== token)
        .join(" ")
      return `${kept}${tail === "" ? "" : `   ${tail}`}`
    })
    .join("\n")
}

/** Hoist the single source allow above every destination-class deny (the ordering failure review-107 M2 proved). */
function hoistAllowAboveDenies(conf: string): string {
  const lines = conf.split("\n")
  const allowIdx = lines.findIndex((l) => /^\s*http_access\s+allow\b/.test((l.split("#")[0] ?? "").trim()))
  if (allowIdx === -1) throw new Error("fixture expects exactly one http_access allow in the shipped conf")
  const allow = lines[allowIdx] ?? ""
  const rest = lines.filter((_, i) => i !== allowIdx)
  const destNames = destinationAclNames(conf)
  const firstDestDeny = rest.findIndex((l) => {
    const m = (l.split("#")[0] ?? "").trim().match(/^http_access\s+deny\s+(\S+)$/)
    return m !== null && destNames.has(m[1] ?? "")
  })
  return [...rest.slice(0, firstDestDeny), allow, ...rest.slice(firstDestDeny)].join("\n")
}

/** Insert an extra_hosts block under one service's `networks:` line — an out-of-band edit the renderer never made. */
function injectExtraHosts(composeText: string, service: string, entries: readonly string[]): string {
  const lines = composeText.split("\n")
  const out: string[] = []
  let inBlock = false
  for (const l of lines) {
    out.push(l)
    if (new RegExp(`^  ${service}:`).test(l)) inBlock = true
    else if (inBlock && /^ {4}networks:/.test(l)) {
      out.push("    extra_hosts:", ...entries.map((e) => `      - "${e}"`))
      inBlock = false
    }
  }
  return out.join("\n")
}

const pinDoc = (pins: unknown[], extra?: Record<string, unknown>): string =>
  JSON.stringify({ version: 1, generatedAt: "2026-10-22T03:00:00Z", pins, ...extra })

const legalPin = {
  hostname: "pub.example.net",
  address: "93.184.216.34",
  answersSeen: ["93.184.216.34", "104.20.23.154"],
  checkedAt: "2026-10-22T03:00:00Z",
}

// ================================================================================================
// 1. The approved form, asserted on the rendered bytes rather than on the audit's opinion of them.
//    Removing any of these lines from `squid_conf.ts` breaks a named test here — that mapping is the
//    mutation battery in test/s6b_d4_units.md §4 (mutants X1, X2, X6, X7).
// ================================================================================================

describe("(r244 render) the approved tunnel form is rendered as a pair and grants no route", () => {
  it("declares the tunnel-port class and re-points the CONNECT deny at it, in one batch", () => {
    const decls = codeLines(SHIPPED_CONF()).filter((l) => /^acl\s+swarm_tunnel_ports\s+port\b/.test(l))
    expect(decls).toEqual(["acl swarm_tunnel_ports port 80 443"]) // 01e §10.4 r11 bullet, verbatim
    const connectorDenies = codeLines(SHIPPED_CONF()).filter((l) => /^http_access\s+deny\s+Connector\s+!/.test(l))
    expect(connectorDenies).toEqual(["http_access deny Connector !swarm_tunnel_ports"])
    // The widening is ONE argument substitution: the pre-gate literal must be gone, not merely joined by a new line.
    expect(codeLines(SHIPPED_CONF()).some((l) => /deny\s+Connector\s+!SSL_ports/.test(l))).toBe(false)
    expect(APPROVED_TUNNEL_PORTS).toEqual([80, 443])
  })

  it("keeps the two port classes gate 239 did not touch exactly as §10.4 words them", () => {
    const code = codeLines(SHIPPED_CONF())
    // Coverage the OLD literal matcher held BY ACCIDENT is asserted here ON PURPOSE: nothing else in the file
    // mentions SSL_ports any more, so a renderer edit that drops it would be invisible to a substring matcher.
    expect(code.filter((l) => l === "acl SSL_ports port 443")).toHaveLength(1)
    expect(code.filter((l) => l.startsWith("acl SafePorts port 80 443"))).toHaveLength(1)
    expect(code.filter((l) => l === "http_access deny !SafePorts")).toHaveLength(1)
    expect(NON_TUNNEL_PORTS).toEqual([80, 443])
    expect(TLS_ONLY_PORTS).toEqual([443])
  })

  it("removes a denial instead of granting a route: exactly one http_access allow exists", () => {
    const allows = codeLines(SHIPPED_CONF()).filter((l) => /^http_access\s+allow\b/.test(l))
    expect(allows).toEqual(["http_access allow localnet"]) // §10.4: the source allow admits WHO, never WHERE
  })

  it("the shipped render clears every offline instrument the pair owns, together", () => {
    const conf = SHIPPED_CONF()
    expect(auditSquidConf(conf)).toEqual([])
    expect(crossEnforcerAgreement(conf)).toEqual([])
    expect(assertNoReservedAclNames(conf)).toEqual([])
    expect(auditBootClass(conf)).toEqual([])
    expect(findSquidOrderingViolations(conf)).toEqual([])
    expect(lintOk(lintComposeText(SHIPPED_COMPOSE(), { lockVersion: LOCK.version }))).toBe(true)
  })

  it("E4 DISCRIMINATION: a silent revert of the approved form is refused, and refused for the tunnel class alone", () => {
    const reverted = preGateBytes(SHIPPED_CONF())
    const findings = auditSquidConf(reverted).filter((f) => f.code === "PORT_FILTER_MISSING")
    expect(findings).toHaveLength(1)
    expect(findings[0]?.item).toContain('"SSL_ports"')
    expect(findings[0]?.item).toContain("not the approved")
    // The revert is otherwise CLEAN — twelve classes still denied, ordering intact — so the refusal below cannot
    // be attributed to any other leg. Had the audit been written to admit both forms, this test would be vacuous.
    expect(auditSquidConf(reverted).filter((f) => f.code !== "PORT_FILTER_MISSING")).toEqual([])
    expect(deniedDstTokens(reverted).size).toBe(12)
  })
})

// ================================================================================================
// 2. Survivor 1 of 3 (decisions/decisions.md gate-239 fork B): the twelve-class deny set.
//    Mutant X3 (drop one class from the renderer) breaks tests in this describe.
// ================================================================================================

describe("(r244 survivor-1) the twelve-class deny set survives the port widening", () => {
  it("the denied dst tokens equal REQUIRED_DENY_RANGES exactly, in both directions", () => {
    const tokens = deniedDstTokens(SHIPPED_CONF())
    const registry = new Set(REQUIRED_DENY_RANGES.map((r) => r.cidr))
    expect(REQUIRED_DENY_RANGES).toHaveLength(12)
    // Equality, not the spec's minimum (a SUPERSET is admissible per §10.4): this lane pins today's bytes so a
    // future range edit must move renderer + bake + urlpolicy in one commit rather than drift silently.
    for (const cidr of registry) expect(tokens.has(cidr)).toBe(true)
    for (const token of tokens) expect(registry.has(token)).toBe(true)
    expect(tokens.size).toBe(12)
  })

  it("every class probe address is refused by the shipped urlpolicy predicate AND named by a deny token", () => {
    // Cross-enforcer identity asked per class, so "the two enforcers agree" is a measurement not a paragraph.
    for (const req of REQUIRED_DENY_RANGES) {
      expect(isDeniedAddress(req.probe)).toBe(true)
      expect(deniedDstTokens(SHIPPED_CONF()).has(req.cidr)).toBe(true)
    }
  })

  it("SELF-CHECK: dropping any single class is caught twice — by this lane's parse and by the bake", () => {
    for (const req of REQUIRED_DENY_RANGES) {
      const corrupt = removeDstToken(SHIPPED_CONF(), req.cidr)
      const missing = auditSquidConf(corrupt).filter((f) => f.code === "DENY_RANGE_MISSING")
      expect(missing.map((f) => f.item)).toEqual([expect.stringContaining(req.cidr)])
      // The instrument proves itself: the parse must lose exactly the token that was removed and keep eleven.
      const tokens = deniedDstTokens(corrupt)
      expect(tokens.has(req.cidr)).toBe(false)
      expect(tokens.size).toBe(11)
    }
  })

  it("a dst ACL that is declared but never denied contributes nothing to coverage", () => {
    const unenforced = SHIPPED_CONF().replace(/^http_access deny to_localnet$/m, "# http_access deny to_localnet")
    expect(deniedDstTokens(unenforced).size).toBe(0)
    expect(auditSquidConf(unenforced).some((f) => f.code === "DENY_NOT_ENFORCED")).toBe(true)
  })
})

// ================================================================================================
// 3. Survivor 2 of 3: deny-before-allow ordering. This describe also records WHICH instrument covers
//    which half of the property (RC-244-1), because the widening made the ordering claim about lines
//    that no longer sit next to each other. Mutant X4 (hoist the allow) breaks the lint assertion.
// ================================================================================================

describe("(r244 survivor-2) deny-before-allow ordering holds after the substitution", () => {
  it("every destination-class deny sits above the single allow, and the default deny is last", () => {
    const rows = numberedCode(SHIPPED_CONF())
    const destNames = destinationAclNames(SHIPPED_CONF())
    const denyLines = rows.filter((r) => /^http_access\s+deny\s+(\S+)$/.test(r.code) && destNames.has(r.code.split(/\s+/)[2] ?? ""))
    const allowLines = rows.filter((r) => /^http_access\s+allow\b/.test(r.code))
    const defaultDeny = rows.filter((r) => r.code === "http_access deny all")
    expect(denyLines.length).toBeGreaterThanOrEqual(2)
    expect(allowLines).toHaveLength(1)
    expect(defaultDeny).toHaveLength(1)
    for (const d of denyLines) expect(d.n).toBeLessThan((allowLines[0]?.n ?? -1))
    expect((defaultDeny[0]?.n ?? -1)).toBeGreaterThan((allowLines[0]?.n ?? -1))
    // The port/method denies also precede the allow: the widened line moved WITH its neighbours, not past them.
    for (const pattern of [/^http_access\s+deny\s+!SafePorts$/, /^http_access\s+deny\s+Connector\s+!\S+$/])
      expect(rows.find((r) => pattern.test(r.code))!.n).toBeLessThan(allowLines[0]!.n)
    const lastAccessLine = rows.filter((r) => /^http_access\s+(allow|deny)\b/.test(r.code)).at(-1)
    expect(lastAccessLine?.code).toBe("http_access deny all")
  })

  it("hoisting the source allow above the destination denies trips the render-side lint rule", () => {
    const violations = findSquidOrderingViolations(hoistAllowAboveDenies(SHIPPED_CONF()))
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]?.rule).toBe("squid-deny-ordering")
    expect(violations[0]?.message).toContain("deny-before-allow is mandatory")
  })

  it("COVERAGE SPLIT (recorded as a gap, RC-244-1): the hoist is caught by the lint, NOT by the bake", () => {
    // Honest half of the ordering claim: §10.4 assigns the allow-above-deny class to row 85's lint and gives the
    // bake only DEFAULT_DENY_MISSING / DEFAULT_DENY_MISORDERED. Scoped to the ordering codes on purpose, so this
    // says exactly what it means and does not merely echo whatever else the bake happens to find. If a later row
    // adds bake-side coverage for the hoist, THIS assertion goes red so the split is re-stated, not improved
    // quietly.
    const orderingCodes = auditSquidConf(hoistAllowAboveDenies(SHIPPED_CONF())).filter((f) => f.code.startsWith("DEFAULT_DENY"))
    expect(orderingCodes).toEqual([])
  })

  it("deleting the terminal default deny is caught by the bake", () => {
    const corrupt = dropLine(SHIPPED_CONF(), /^\s*http_access\s+deny\s+all\s*/)
    expect(auditSquidConf(corrupt).some((f) => f.code === "DEFAULT_DENY_MISSING")).toBe(true)
  })
})

// ================================================================================================
// 4. Survivor 3 of 3: internal-only browser attachment (§6.7 / §10.2). Asserted on PARSED YAML, i.e.
//    on the data docker will consume, not on a comment. Mutant X5 (attach fc-web to playwright) breaks
//    the first two tests here.
// ================================================================================================

describe("(r244 survivor-3) the browser tier stays attached to internal networks only", () => {
  const doc = () => Bun.YAML.parse(SHIPPED_COMPOSE()) as Record<string, any>

  it("playwright-service attaches fc-ctl and fc-iso, both internal:true, and nothing else", () => {
    const nets: string[] = doc().services["playwright-service"].networks
    expect(nets).toEqual(["fc-ctl", "fc-iso"])
    for (const n of nets) expect(doc().networks[n].internal).toBe(true)
    expect(doc().services["playwright-service"].ports).toBeUndefined() // publishes nothing
  })

  it("fc-web has exactly one member (egress-proxy) and no other tier can reach it", () => {
    const members = Object.entries(doc().services as Record<string, any>)
      .filter(([, svc]) => Array.isArray(svc?.networks) && (svc.networks as string[]).includes("fc-web"))
      .map(([name]) => name)
    expect(members).toEqual(["egress-proxy"])
    expect(doc().networks["fc-web"].internal).toBeUndefined() // the internet-capable segment stays the exception
    for (const tier of ["api", "redis", "rabbitmq", "nuq-postgres"])
      for (const n of doc().services[tier].networks as string[])
        expect(["fc-web", "fc-edge"]).not.toContain(n)
  })

  it("RC-244-1 CLOSED by row 267: the bake refuses an added non-internal attachment (lint still does not)", () => {
    // The exact injection row 244 recorded as unauditable offline (RC-244-1), reproduced byte-for-byte so the
    // closure is measured against the same bytes rather than asserted beside a new fixture. Lint's silence is
    // DELIBERATE and stays pinned here: network membership is not a lint rule, and moving it there would put the
    // check on the render path while the estate consumes the artefact (row 251 §2.3's argument for the bake).
    // One injection violates all three claims at once, so all three codes answer; the per-code isolating mutations
    // (each firing exactly one of them) live in test/egress_bake.test.ts under "r267 F-251-8".
    const webbed = SHIPPED_COMPOSE().replace("    networks: [fc-ctl, fc-iso]", "    networks: [fc-ctl, fc-iso, fc-web]")
    expect(webbed).not.toBe(SHIPPED_COMPOSE())
    expect(lintOk(lintComposeText(webbed, { lockVersion: LOCK.version }))).toBe(true)
    const codes = verifyEgressBake({ lock: LOCK, home: "/Users/r244-gap", composeText: webbed, confText: SHIPPED_CONF() }).findings.map((f) => f.code)
    expect(codes).toContain("BROWSER_TIER_MISATTACHED")
    expect(codes).toContain("NETWORK_NOT_INTERNAL")
    expect(codes).toContain("PUBLIC_NETWORK_MEMBER_DRIFT")
  })
})

// ================================================================================================
// 5. RC-242-3 — the two mutants row 242 found only because a corruption produced NO finding.
//    These are PERMANENT fixtures of this lane: dropping either reopens a hole that a first-pass test
//    set demonstrably had (implementation/s6_r242_audit_lockstep.md §3d and §3e). Do not delete to
//    save lines; they are the reason this file exists alongside row 242's own battery.
// ================================================================================================

describe("(r244 RC-242-3 permanent fixtures) the two corruptions a first-pass test set was blind to", () => {
  it("FIXTURE 1 — a decoy deny line: a method-GET ACL carrying the tunnel class does not manage CONNECT", () => {
    // Row 242 §3d: variant M3 (accept any `deny <x> !<port-class>` regardless of method) survived its first
    // battery with ZERO failures. Under such an audit the tunnel restriction can vanish from the conf while the
    // bake stays green. This fixture is the permanent witness that the method term is load-bearing.
    const decoy = SHIPPED_CONF()
      .replace("acl Connector method CONNECT", "acl Connector method CONNECT\nacl NotATunnel method GET")
      .replace("http_access deny Connector !swarm_tunnel_ports", "http_access deny NotATunnel !swarm_tunnel_ports")
    const findings = auditSquidConf(decoy).filter((f) => f.code === "PORT_FILTER_MISSING")
    expect(findings).toHaveLength(1)
    expect(findings[0]?.item).toContain("CONNECT")
    // And the decoy really is otherwise well-formed: the tunnel class itself is intact, so the refusal is about
    // WHICH method the class governs, not about the ports.
    expect(decoy).toContain("acl swarm_tunnel_ports port 80 443")
    expect(auditSquidConf(decoy).filter((f) => f.code !== "PORT_FILTER_MISSING")).toEqual([])
  })

  it("FIXTURE 2 — deleting `acl SSL_ports port 443` while nothing references it is still refused", () => {
    // Row 242 §3e: the old literal matcher mentioned SSL_ports, so its deletion was covered BY ACCIDENT. Once
    // row 241 moved the reference to the tunnel class, a substring matcher — however carefully re-aimed — would
    // let the deletion pass. §10.4 requires the declaration to survive ("so any other reader of SSL_ports is
    // unaffected"); this fixture is that requirement as a machine check.
    const withoutSsl = dropLine(SHIPPED_CONF(), /^\s*acl\s+SSL_ports\s+port\b/)
    expect(withoutSsl).not.toContain("acl SSL_ports")
    const findings = auditSquidConf(withoutSsl).filter((f) => f.code === "PORT_FILTER_MISSING")
    expect(findings).toHaveLength(1)
    expect(findings[0]?.item).toContain("SSL_ports")
    // Nothing else moved: the file still carries twelve classes and the approved tunnel class.
    expect(deniedDstTokens(withoutSsl).size).toBe(12)
    expect(withoutSsl).toContain("acl swarm_tunnel_ports port 80 443")
  })

  it("BOTH fixtures together leave the shipped artefact green, so they are discriminations not blanket complaints", () => {
    expect(auditSquidConf(SHIPPED_CONF())).toEqual([])
  })
})

// ================================================================================================
// 6. P3 injected answers through the public surface: the render screens, the lint screens, and the bake
//    is the last offline stop. Mutants M-d (audit vacuous) and M-h (lint screen removed) break these.
// ================================================================================================

describe("(r244 P3 injected answers) render, lint and bake agree without sharing a rulebook", () => {
  it("a legal pins file renders entries on api and playwright-service only, and the estate clears the bake", () => {
    const home = scratchHome("p3-legal")
    const r = renderEstate(home, pinDoc([legalPin]))
    const text = artefact(r, "firecrawl/compose/firecrawl.yml")
    const doc = Bun.YAML.parse(text) as Record<string, any>
    expect(doc.services.api.extra_hosts).toEqual(["pub.example.net:93.184.216.34"])
    expect(doc.services["playwright-service"].extra_hosts).toEqual(["pub.example.net:93.184.216.34"])
    for (const svc of ["redis", "rabbitmq", "nuq-postgres", "egress-proxy"]) expect(doc.services[svc].extra_hosts).toBeUndefined()
    expect(text).not.toContain("${") // §11 literal discipline: no interpolation on any rendered line
    expect(auditExtraHostPins(text)).toEqual([])
    expect(lintOk(lintComposeText(text, { lockVersion: LOCK.version }))).toBe(true)
  })

  it("PRODUCT PATH: the staged artefacts on disk — not just in-memory text — pass the whole bake", () => {
    const home = scratchHome("p3-disk")
    const r = renderEstate(home, pinDoc([legalPin]))
    applyRenderedFiles(r, join(home, ".swarm", "tools"))
    const v = verifyEgressBake({ lock: LOCK, home }) // no texts supplied: the verifier reads the files itself
    expect(v.findings.map((f) => `${f.code}: ${f.item}`)).toEqual([])
    expect(v.ok).toBe(true)
    expect(readFileSync(pathsFor(join(home, ".swarm", "tools")).firecrawlSquidConf, "utf8")).toContain(
      "acl swarm_tunnel_ports port 80 443",
    )
  })

  it("a poisoned pins file refuses the render before any artefact exists (§3.3 never omit silently)", () => {
    const home = scratchHome("p3-poison")
    mkdirSync(join(home, ".swarm", "setup"), { recursive: true })
    writeFileSync(
      join(home, ".swarm", "setup", "dns-pins.json"),
      pinDoc([{ ...legalPin, address: "192.168.5.3", answersSeen: ["192.168.5.3"] }]), // RC-234-2 fixture address
    )
    const r = renderAll(LOCK, { home, secrets: requiredManifest() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("DNS_PINS_INVALID")
  })

  it("out-of-band edits to the artefact are refused with one code per harm class", () => {
    const base = SHIPPED_COMPOSE()
    const cases: Array<[string, string, string]> = [
      ["host.docker.internal:host-gateway", "EXTRA_HOST_AT_HOST", "api"],
      ["crawl.example:192.168.5.3", "EXTRA_HOST_DENIED_VALUE", "playwright-service"],
      ["redis:93.184.216.34", "EXTRA_HOST_SHAPE_INVALID", "redis"],
      ["pin.example:100.64.0.1", "EXTRA_HOST_DENIED_VALUE", "rabbitmq"],
      ["pin.example:169.254.169.254", "EXTRA_HOST_DENIED_VALUE", "nuq-postgres"],
    ]
    for (const [pair, code, service] of cases) {
      const tampered = injectExtraHosts(base, service, [pair])
      expect(tampered).not.toBe(base) // the fixture really edited the named tier
      const findings = auditExtraHostPins(tampered)
      expect(findings.map((f) => f.code)).toContain(code)
      expect(findings.every((f) => f.item.includes(service))).toBe(true) // block-scoped: it names the tier
    }
  })

  it("the narrowed lint still refuses the §4.5 door and still passes the approved entry", () => {
    const door = injectExtraHosts(SHIPPED_COMPOSE(), "api", ["host.docker.internal:host-gateway"])
    const doorFindings = lintComposeText(door, { lockVersion: LOCK.version }).filter((f) => f.rule === "extra-hosts")
    expect(doorFindings.length).toBeGreaterThan(0)
    expect(lintOk(lintComposeText(door, { lockVersion: LOCK.version }))).toBe(false)
    const legal = injectExtraHosts(SHIPPED_COMPOSE(), "api", ["pub.example.net:93.184.216.34"])
    expect(lintComposeText(legal, { lockVersion: LOCK.version }).filter((f) => f.rule === "extra-hosts")).toEqual([])
  })

  it("DRIFT PIN: the renderer's screen and the bake's screen agree on every pair, in both directions", () => {
    // Row 242 deliberately did NOT import the renderer's screen into the audit; the price of independence is a
    // pin. This table is this lane's own (different boundary cases from row 242's 22-pair pin): the assertion is
    // "renderer says renderable ⟺ bake says clean", so neither enforcer can grow a hole alone.
    const pairs: Array<[string, string]> = [
      ["pub.example.net", "93.184.216.34"], // legal
      ["pin.example", "104.20.23.154"], // legal
      ["host.docker.internal", "93.184.216.34"], // denied NAME, public value
      ["svc.local", "93.184.216.34"], // denied suffix
      ["redis", "93.184.216.34"], // undotted
      ["93.184.216.34", "93.184.216.34"], // IP literal as name
      ["PUB.EXAMPLE.NET", "93.184.216.34"], // uppercase
      ["pin.example", "host-gateway"], // the sentinel
      ["pin.example", "127.0.0.1"], // loopback answer
      ["pin.example", "239.1.2.3"], // multicast: past the twelve CIDRs, caught by the unicast leg
      ["pin.example", "240.0.0.1"], // reserved
      ["pin.example", "010.1.2.3"], // leading zero
      ["pin.example", "0x6e.0.0.1"], // hex form
      ["pin.example", "2606:4700:dead:beef::1"], // withheld public IPv6
      ["pin.example", "0.0.0.1"], // this-network
      ["pin.example", "64:ff9b::7f00:1"], // NAT64 embedding 127.0.0.1
    ]
    for (const [hostname, value] of pairs) {
      const renderable = extraHostPairProblem(hostname, value) === null
      const bakeCodes = auditExtraHostPins(injectExtraHosts(SHIPPED_COMPOSE(), "api", [`${hostname}:${value}`])).map((f) => f.code)
      // One assertion, both directions: "the renderer would emit this pair" and "the bake calls this pair clean"
      // are the same proposition here, so any divergence in either direction is a red test naming its pair.
      expect(`${hostname}:${value} renderable=${renderable} bakeClean=${bakeCodes.length === 0}`).toBe(
        `${hostname}:${value} renderable=${renderable} bakeClean=${renderable}`,
      )
    }
  })
})

// ================================================================================================
// 7. The proof-layer boundary: what the bake CLAIMS to prove offline must not silently grow to include
//    what only row 255's live battery can see (Loss 2 in particular). Cheap to assert, and it is the
//    machine-readable form of "the survivors still survive" for the parts no offline check can reach.
// ================================================================================================

describe("(r244 proof-layer boundary) the bake states its own reach, and this lane checks the statement", () => {
  it("the tunnel class is claimed offline, the tunnel-form refusal is left to the live battery", () => {
    const layers = bakeProofLayers()
    expect(layers.offlineProven.some((l) => /tunnel/i.test(l) && /80,\s*443/.test(l))).toBe(true)
    expect(layers.liveOnly.some((l) => /CONNECT 127\.0\.0\.1:80/.test(l))).toBe(true)
    expect(layers.liveOnly.some((l) => /nip\.io/.test(l))).toBe(true) // RC-234-2's re-run duty, named not assumed
  })

  it("Loss 2 is recorded as invisible to the audit, so a green bake is never read as containment", () => {
    const layers = bakeProofLayers()
    const lossTwo = layers.liveOnly.find((l) => /dstdomain/.test(l))
    expect(lossTwo ?? "").toContain("row 255")
    // And the audit really is presence-only for the hostname classes: deleting one refuses, weakening its
    // applicability inside a tunnel cannot be seen offline.
    expect(auditSquidConf(dropLine(SHIPPED_CONF(), /^\s*acl\s+swarm_hostnames\s+dstdomain\s+\.local\b/)).some((f) => f.code === "DENY_HOSTNAME_MISSING")).toBe(true)
  })

  it("the extra_hosts screen is claimed offline too, since gate 239 fork A made the key legal to render", () => {
    expect(bakeProofLayers().offlineProven.some((l) => /extra_hosts/.test(l))).toBe(true)
  })
})
