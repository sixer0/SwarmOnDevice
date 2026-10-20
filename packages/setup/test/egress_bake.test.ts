// Row-92 unit tests — the egress-proxy (squid) config-bake verifier (src/steps/firecrawl/egress_bake.ts).
//
// NO docker daemon, NO network, NO spawn. Artefacts are staged by CONSUMING the row-85 renderer interface
// (renderAll + applyRenderedFiles) into a throwaway HOME, exactly like the row-91 harness — this row never
// re-renders into ~/.swarm and never edits the renderer. Mismatch/tamper cases are built by editing ONLY the
// rendered egress-proxy service block (or the shipped squid.conf text), so every assertion runs against the
// PRODUCTION artefact shape, not a hand-written fake.
//
// Brief-mandated proofs, each a named describe:
//   deny-rule parse-and-assert (each §10.4 range + wiring/ordering + comment-trap)
//   fail-closed on tag-only/null pin  +  image==pin / conf-bind / cmd-target / proxy-route correctness
//   health-gate contract for row 93
//   consent-gated FIRST + dry-run zero filesystem writes
//
// Run TARGETED (row 102 owns the full suite): cd packages/setup && bun test test/egress_bake.test.ts

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// Per-run isolation of the source-posture lock (replaces the shared src/tools.lock.json staging).
import { isolateSourceLock } from "./lockPosture.ts"
import { OUTCOME } from "../src/outcomes.ts"
import { STATES } from "../src/constants.ts"
import { defaultState } from "../src/state.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { createStepKit } from "../src/stepkit.ts"
import { SECRET_INVENTORY, pathsFor, PC_PORTS } from "../src/composefiles/shared.ts"
import { renderAll, applyRenderedFiles } from "../src/composefiles/index.ts"
import { renderSquidConf } from "../src/composefiles/squid_conf.ts"
import { discoverSteps } from "../src/steps.ts"
import { isDeniedAddress } from "../src/mcpproxy/urlpolicy.ts"
import {
  assertNoReservedAclNames,
  auditFileModes,
  auditSquidConf,
  bakeEgressProxy,
  crossEnforcerAgreement,
  egressHealthContract,
  verifyEgressBake,
  REQUIRED_DENY_RANGES,
} from "../src/steps/firecrawl/egress_bake.ts"

/** Models r85-fix5's intended R112-1 fix (the live V6 experiment, 13_live_firecrawl.md:110): rename ONLY the
 *  hostname ACL off the squid-predefined `to_localhost` to a free name; the dst ACL name is irrelevant to the audit
 *  (it keys on ACL TYPE + deny linkage). Used to assert the verifier green against the TARGET artefact while the
 *  render still carries the reserved name — and to prove the lint by re-introducing the reserved name. */
const v6RenameHostnames = (t: string): string => t.replace(/\bto_localhost\b/g, "swarm_hostnames")

// Reference digests supplied by the controller brief (r78a ADDENDUM, re-fetch matched). Fixtures only — shipped
// code never bakes a magic digest literal (it compares the compose against the lock, computed at runtime).
const CLEARED_INDEX = "sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029"
const CLEARED_ARM64 = "sha256:eecf35336788c1ab143566bca99ac58f213e9f17906a9a684346d7b323b6696c"

let releaseLockPosture: (() => void) | undefined
let LOCK: LockFile

beforeAll(() => {
  releaseLockPosture = isolateSourceLock()
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`loadLock failed in test setup: ${loaded.error}`)
  LOCK = loaded.lock
})
afterAll(() => {
  releaseLockPosture?.()
})

function freshHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `swarm-r92-${label}-`))
  process.env.HOME = home
  return home
}

/** Place the two compose stacks + generated configs under the throwaway tools root via the r85 interface. */
function stageArtefacts(home: string): void {
  const requiredManifest = { searxng: {} as Record<string, "generated">, firecrawl: {} as Record<string, "generated"> }
  for (const comp of ["searxng", "firecrawl"] as const) {
    for (const spec of SECRET_INVENTORY[comp]) if (spec.required) requiredManifest[comp][spec.name] = "generated"
  }
  const result = renderAll(LOCK, { home, secrets: requiredManifest })
  if (!result.ok)
    throw new Error(`stageArtefacts refused: ${JSON.stringify(result.errors)} ${JSON.stringify(result.findings)}`)
  applyRenderedFiles(result, `${home}/.swarm/tools`)
}

function fcComposePath(home: string): string {
  return pathsFor(`${home}/.swarm/tools`).firecrawlCompose
}
function fcSquidPath(home: string): string {
  return pathsFor(`${home}/.swarm/tools`).firecrawlSquidConf
}
function readyState(): ReturnType<typeof defaultState> {
  const st = defaultState(LOCK.version)
  st.components.runtime = { state: STATES.HEALTHY }
  st.components.firecrawl = { state: STATES.CONFIGURED }
  return st
}

// --- block-scoped editors: change ONLY the rendered egress-proxy service, keep the file otherwise real ---
function editFcBody(composeText: string, transform: (line: string) => string | null): string {
  const lines = composeText.split("\n")
  const s = lines.findIndex((l) => /^ {2}egress-proxy:\s*$/.test(l))
  if (s === -1) throw new Error("test: no egress-proxy block found in the rendered compose")
  let e = lines.length
  for (let i = s + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i] ?? "")) {
      e = i
      break
    }
  }
  const body = lines
    .slice(s + 1, e)
    .map(transform)
    .filter((l): l is string => l !== null)
  return [...lines.slice(0, s + 1), ...body, ...lines.slice(e)].join("\n")
}

function treeSnapshot(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else out.push(`${abs}|${st.size}|${Math.round(st.mtimeMs)}`)
    }
  }
  walk(root)
  return out
}

// ================================================================================================
describe("(happy) rendered artefacts bake green against the shipped lock", () => {
  it("verifyEgressBake is clean and reports the locked pin as the image ref", () => {
    const home = freshHome("happy")
    stageArtefacts(home)
    // GREEN against the TARGET artefact: feed the r85-fix5-renamed conf (to_localhost -> swarm_hostnames, the live
    // V6 fix) as text so the reserved-name + mode gates reflect the fixed shape deterministically, independent of
    // whether the render has landed the rename yet. The raw shipped render's reserved name is asserted SEPARATELY
    // below (assertNoReservedAclNames), so this row neither hides R112-1 nor goes red waiting on a sibling.
    const v = verifyEgressBake({
      lock: LOCK,
      home,
      composeText: readFileSync(fcComposePath(home), "utf8"),
      confText: v6RenameHostnames(readFileSync(fcSquidPath(home), "utf8")),
    })
    expect(v.ok).toBe(true)
    expect(v.findings).toEqual([])
    expect(v.imageRef).toBe(`docker.io/ubuntu/squid@${CLEARED_INDEX}`)
    expect(v.composePath).toBe(fcComposePath(home))
    expect(v.confPath).toBe(fcSquidPath(home))
  })

  it("the lock arm64 platform digest equals the controller-cleared reference (fixture equality)", () => {
    expect(String(LOCK.components.firecrawl?.egress_proxy_image_arm64_manifest_digest)).toBe(CLEARED_ARM64)
  })
})

// ================================================================================================
describe("(SSRF) deny-rule parse-and-assert over the rendered squid.conf", () => {
  it("the shipped render passes auditSquidConf with zero findings", () => {
    expect(auditSquidConf(renderSquidConf().content)).toEqual([])
  })

  it("REQUIRED_DENY_RANGES is the TWELVE amended classes, including the three review-107 M2 additions", () => {
    // review-107 MAJOR-2 named the original nine as incomplete; §10.4 was amended to twelve (r75-fix4).
    expect(REQUIRED_DENY_RANGES.length).toBe(12)
    const cidrs = REQUIRED_DENY_RANGES.map((r) => r.cidr)
    for (const added of ["0.0.0.0/8", "::/128", "64:ff9b::/96"]) expect(cidrs).toContain(added)
  })

  it("every §10.4 required range (all twelve) is present in the shipped render", () => {
    const tokens = new Set<string>()
    for (const line of renderSquidConf().content.split("\n")) {
      const m = (line.split("#")[0] ?? "").match(/^acl\s+\S+\s+dst\s+(.+)$/)
      if (m?.[1]) for (const t of m[1].trim().split(/\s+/)) tokens.add(t)
    }
    for (const req of REQUIRED_DENY_RANGES) expect(tokens.has(req.cidr)).toBe(true)
  })

  for (const req of REQUIRED_DENY_RANGES) {
    it(`removing ${req.cidr} (${req.kind}) is refused as DENY_RANGE_MISSING`, () => {
      const broken = renderSquidConf()
        .content.split("\n")
        .map((l) =>
          /\bacl\s+\S+\s+dst\b/.test(l)
            ? l.replace(new RegExp(` ?${req.cidr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, ""), "")
            : l,
        )
        .join("\n")
      const findings = auditSquidConf(broken)
      expect(findings.some((f) => f.code === "DENY_RANGE_MISSING" && f.item.includes(req.cidr))).toBe(true)
    })
  }

  it("drops a comment naming a CIDR cannot satisfy the check (parse over the code portion, not grep)", () => {
    const broken = renderSquidConf()
      .content.split("\n")
      .filter((l) => !/\bacl\s+\S+\s+dst\b/.test(l) || !l.includes("169.254.0.0/16")) // remove the v4 line entirely
      .concat(["# 169.254.0.0/16 mentioned here only as a comment"]) // decoy comment re-introducing the token
      .join("\n")
    const findings = auditSquidConf(broken)
    // The v4 ranges (incl. 169.254 link-local) must now be reported missing even though the token appears in a comment.
    expect(findings.some((f) => f.code === "DENY_RANGE_MISSING" && f.item.includes("169.254.0.0/16"))).toBe(true)
    expect(findings.some((f) => f.code === "DENY_RANGE_MISSING" && f.item.includes("127.0.0.0/8"))).toBe(true)
  })

  it("an ACL that exists but is not wired into http_access deny is refused", () => {
    const broken = renderSquidConf()
      .content.split("\n")
      .filter((l) => !/^\s*http_access deny to_localnet\s*$/.test(l))
      .join("\n")
    expect(auditSquidConf(broken).some((f) => f.code === "DENY_NOT_ENFORCED" && f.item.includes("to_localnet"))).toBe(
      true,
    )
  })

  it("a missing default-deny is refused", () => {
    const broken = renderSquidConf()
      .content.split("\n")
      .filter((l) => !/^\s*http_access deny all/.test(l))
      .join("\n")
    expect(auditSquidConf(broken).some((f) => f.code === "DEFAULT_DENY_MISSING")).toBe(true)
  })

  it("default-deny BEFORE the specific denies is refused as misordered", () => {
    const lines = renderSquidConf().content.split("\n")
    const withoutAll = lines.filter((l) => !/^\s*http_access deny all/.test(l))
    const allLine = lines.find((l) => /^\s*http_access deny all/.test(l)) ?? "http_access deny all"
    const idx = withoutAll.findIndex((l) => /http_access deny to_localnet/.test(l))
    withoutAll.splice(idx, 0, allLine) // put default-deny AHEAD of the localnet deny
    expect(auditSquidConf(withoutAll.join("\n")).some((f) => f.code === "DEFAULT_DENY_MISORDERED")).toBe(true)
  })

  it("a dropped port filter (80 removed from SafePorts) is refused", () => {
    const broken = renderSquidConf().content.replace("acl SafePorts port 80 443", "acl SafePorts port 443")
    expect(auditSquidConf(broken).some((f) => f.code === "PORT_FILTER_MISSING")).toBe(true)
  })

  it("removing the no-cache directive is refused", () => {
    const broken = renderSquidConf()
      .content.split("\n")
      .filter((l) => !/^\s*cache deny all/.test(l))
      .join("\n")
    expect(auditSquidConf(broken).some((f) => f.code === "NOCACHE_MISSING")).toBe(true)
  })

  it("hostname forms (localhost/.local) uncovered is refused", () => {
    const broken = renderSquidConf()
      .content.split("\n")
      .filter((l) => !/^acl\s+\S+\s+dstdomain\b/.test(l)) // drop the dstdomain pair (type-based per R112-1 rename; H-R93-6 form)
      .join("\n")
    expect(auditSquidConf(broken).some((f) => f.code === "DENY_HOSTNAME_MISSING")).toBe(true)
  })

  it("the pre-fix single-line 'dst localhost domain .local' shape is refused as SQUID_GRAMMAR_INVALID (H-R93-6 regression pin)", () => {
    const oldBroken = renderSquidConf()
      .content.split("\n")
      .filter((l) => !/^acl\s+\S+\s+dstdomain\b/.test(l)) // type-based (R112-1)
      .concat(["acl to_localhost dst localhost domain .local"]) // the exact line that FATALed on the live VM
      .join("\n")
    const findings = auditSquidConf(oldBroken)
    expect(findings.some((f) => f.code === "SQUID_GRAMMAR_INVALID")).toBe(true)
    expect(findings.some((f) => f.code === "DENY_HOSTNAME_MISSING")).toBe(true) // and it satisfies nothing
  })
})

// ================================================================================================
describe("(cross-enforcer equality) L3 urlpolicy ⇄ L4 squid deny identical sets, superset of the twelve", () => {
  // r94's host-side predicate + the shipped squid ACL over the SAME twelve-class domain. Both must deny every
  // class, so the hook is green on the shipped artefact and the two enforcers cannot silently drift (review-107 M2).
  it("urlpolicy denies all twelve class representatives", () => {
    for (const req of REQUIRED_DENY_RANGES) expect(isDeniedAddress(req.probe)).toBe(true)
  })

  it("the shipped render passes crossEnforcerAgreement with zero findings (both layers agree on twelve)", () => {
    expect(crossEnforcerAgreement(renderSquidConf().content)).toEqual([])
  })

  it("dropping 0.0.0.0/8 from squid while urlpolicy still denies it is a NAMED divergence (MAJOR-2 fixture)", () => {
    const broken = renderSquidConf()
      .content.split("\n")
      .map((l) => (/\bacl\s+\S+\s+dst\b/.test(l) ? l.replace(" 0.0.0.0/8", "") : l))
      .join("\n")
    const findings = crossEnforcerAgreement(broken)
    // squid now permits 0.0.0.0 but urlpolicy denies the 0.0.0.0 probe -> asymmetric -> flagged by class name.
    expect(
      findings.some(
        (f) => f.code === "CROSS_ENFORCER_DIVERGENCE" && f.item.includes("0.0.0.0/8") && f.item.includes("squid(L4)=allow") && f.item.includes("urlpolicy(L3)=deny"),
      ),
    ).toBe(true)
  })

  it("verifyEgressBake fails closed end-to-end on that divergence fixture", () => {
    const home = freshHome("xfail")
    stageArtefacts(home)
    const broken = readFileSync(fcSquidPath(home), "utf8")
      .split("\n")
      .map((l) => (/\bacl\s+\S+\s+dst\b/.test(l) ? l.replace(" 0.0.0.0/8", "") : l))
      .join("\n")
    const v = verifyEgressBake({ lock: LOCK, home, composeText: readFileSync(fcComposePath(home), "utf8"), confText: broken })
    expect(v.ok).toBe(false)
    expect(v.findings.some((f) => f.code === "CROSS_ENFORCER_DIVERGENCE" && f.item.includes("0.0.0.0/8"))).toBe(true)
    expect(v.findings.some((f) => f.code === "DENY_RANGE_MISSING" && f.item.includes("0.0.0.0/8"))).toBe(true)
  })

  it("dropping NAT64 64:ff9b::/96 from squid is refused as DENY_RANGE_MISSING (a new-class regression)", () => {
    const broken = renderSquidConf()
      .content.split("\n")
      .map((l) => (/\bacl\s+\S+\s+dst\b/.test(l) ? l.replace(" 64:ff9b::/96", "") : l))
      .join("\n")
    expect(auditSquidConf(broken).some((f) => f.code === "DENY_RANGE_MISSING" && f.item.includes("64:ff9b::/96"))).toBe(true)
    expect(crossEnforcerAgreement(broken).some((f) => f.code === "CROSS_ENFORCER_DIVERGENCE" && f.item.includes("64:ff9b::/96"))).toBe(true)
  })
})

// ================================================================================================
describe("(pin) fail-closed on tag-only / null pin — digest-pull readiness", () => {
  it("a tag-only egress_proxy_image is refused as PIN_UNUSABLE before any artefact is needed", () => {
    const bad = {
      ...LOCK,
      components: {
        ...LOCK.components,
        firecrawl: { ...LOCK.components.firecrawl, egress_proxy_image: "docker.io/ubuntu/squid:latest" },
      },
    } as LockFile
    const v = verifyEgressBake({ lock: bad, home: "/nonexistent-r92" })
    expect(v.ok).toBe(false)
    expect(v.findings.length).toBe(1)
    expect(v.findings[0]?.code).toBe("PIN_UNUSABLE")
  })

  it("a null egress_proxy_image is refused as PIN_UNUSABLE", () => {
    const nul = {
      ...LOCK,
      components: { ...LOCK.components, firecrawl: { ...LOCK.components.firecrawl, egress_proxy_image: null } },
    } as LockFile
    expect(verifyEgressBake({ lock: nul, home: "/nonexistent-r92" }).findings[0]?.code).toBe("PIN_UNUSABLE")
  })
})

describe("(config correctness) rendered compose must match the pin and wire the config", () => {
  it("egress-proxy image != lock pin is refused as IMAGE_PIN_MISMATCH", () => {
    const home = freshHome("img")
    stageArtefacts(home)
    const ref = String(LOCK.components.firecrawl?.egress_proxy_image)
    const tampered = readFileSync(fcComposePath(home), "utf8").replace(
      ref,
      "docker.io/ubuntu/squid@sha256:" + "0".repeat(64),
    )
    const v = verifyEgressBake({
      lock: LOCK,
      home,
      composeText: tampered,
      confText: readFileSync(fcSquidPath(home), "utf8"),
    })
    expect(v.findings.some((f) => f.code === "IMAGE_PIN_MISMATCH")).toBe(true)
    expect(v.ok).toBe(false)
  })

  it("conf not bound at the expected target is refused as CONF_BIND_MISSING", () => {
    const home = freshHome("bind")
    stageArtefacts(home)
    const confPath = fcSquidPath(home)
    const tampered = readFileSync(fcComposePath(home), "utf8").replace(
      `source: ${confPath}`,
      "source: /elsewhere/squid.conf",
    )
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText: renderSquidConf().content })
    expect(v.findings.some((f) => f.code === "CONF_BIND_MISSING")).toBe(true)
  })

  it("the squid command not loading the bound conf is refused as CMD_CONF_MISMATCH", () => {
    const home = freshHome("cmd")
    stageArtefacts(home)
    const tampered = readFileSync(fcComposePath(home), "utf8").replace(
      "-f /etc/squid/swarm-egress.conf",
      "-f /etc/squid/other.conf",
    )
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText: renderSquidConf().content })
    expect(v.findings.some((f) => f.code === "CMD_CONF_MISMATCH")).toBe(true)
  })

  it("Playwright routed away from the filter is refused as PROXY_ROUTE_UNSET", () => {
    const home = freshHome("route")
    stageArtefacts(home)
    const tampered = readFileSync(fcComposePath(home), "utf8").replace(/PROXY_SERVER: "[^"]*"/, 'PROXY_SERVER: ""')
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText: renderSquidConf().content })
    expect(v.findings.some((f) => f.code === "PROXY_ROUTE_UNSET")).toBe(true)
  })

  it("the enforced route is exactly the egress-proxy on the register squid port (no literal port in this row)", () => {
    // Proves PROXY_SERVER derives from PC_PORTS.squidContainer; the assertion builds the needle from the register mirror.
    const home = freshHome("route-ok")
    stageArtefacts(home)
    const composeText = readFileSync(fcComposePath(home), "utf8")
    expect(composeText.includes(`http://egress-proxy:${PC_PORTS.squidContainer}`)).toBe(true)
  })
})

describe("(hardening) gate §8 cond.2 non-negotiable keys on the egress-proxy service", () => {
  it("dropped cap_drop: [ALL] is refused", () => {
    const home = freshHome("caps")
    stageArtefacts(home)
    const tampered = editFcBody(readFileSync(fcComposePath(home), "utf8"), (l) => (/^ {4}cap_drop:/.test(l) ? null : l))
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText: renderSquidConf().content })
    expect(v.findings.some((f) => f.code === "HARDENING_CAPS")).toBe(true)
  })

  it("dropped no-new-privileges is refused", () => {
    const home = freshHome("nnp")
    stageArtefacts(home)
    const tampered = editFcBody(readFileSync(fcComposePath(home), "utf8"), (l) =>
      /^ {4}security_opt:/.test(l) ? null : l,
    )
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText: renderSquidConf().content })
    expect(v.findings.some((f) => f.code === "HARDENING_NO_NEW_PRIVS")).toBe(true)
  })

  it("memswap_limit differing from mem_limit is refused", () => {
    const home = freshHome("memswap")
    stageArtefacts(home)
    const tampered = editFcBody(readFileSync(fcComposePath(home), "utf8"), (l) =>
      /^ {4}memswap_limit:/.test(l) ? "    memswap_limit: 8g" : l,
    )
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText: renderSquidConf().content })
    expect(v.findings.some((f) => f.code === "HARDENING_MEMSWAP")).toBe(true)
  })
})

// ================================================================================================
describe("(health contract) exposed for row 93, entrypoint-agnostic (r77b, NOT Pebble)", () => {
  it("names the egress-proxy service under the firecrawl compose with the running/healthcheck posture", () => {
    const home = freshHome("contract")
    stageArtefacts(home)
    const c = egressHealthContract({ lock: LOCK, home })
    expect(c.component).toBe("firecrawl")
    expect(c.service).toBe("egress-proxy")
    expect(c.posture).toBe("running+optional-healthcheck")
    expect(c.composeFile).toBe(fcComposePath(home))
    expect(c.note.toLowerCase()).toContain("not pebble")
  })

  it("reports declaresHealthcheck from the artefact (the r85 egress-proxy declares none -> running-status fallback)", () => {
    const home = freshHome("contract-hc")
    stageArtefacts(home)
    const c = egressHealthContract({ lock: LOCK, home })
    expect(c.declaresHealthcheck).toBe(false) // 01e §4.8: the gate falls back to container-running for no-healthcheck services
  })
})

// ================================================================================================
describe("(consent + dry-run) bakeEgressProxy gate-first, zero writes", () => {
  it("refuses with REFUSED_NO_CONSENT BEFORE verifying (a tampered artefact is not even read)", async () => {
    const home = freshHome("consent")
    stageArtefacts(home)
    const kit = createStepKit({
      componentId: "firecrawl",
      lock: LOCK,
      state: readyState(),
      dryRun: false,
      consentGate: () => false,
    })
    const out = await bakeEgressProxy({ kit, home, composeText: "GARBAGE-NOT-A-COMPOSE", confText: "GARBAGE" })
    expect(out.token).toBe(OUTCOME.REFUSED_NO_CONSENT)
  })

  it("dry-run returns OK on green artefacts and performs ZERO filesystem writes", async () => {
    const home = freshHome("dryrun")
    stageArtefacts(home)
    const before = treeSnapshot(`${home}/.swarm`)
    const kit = createStepKit({
      componentId: "firecrawl",
      lock: LOCK,
      state: readyState(),
      dryRun: true,
      consentGate: () => true,
    })
    const out = await bakeEgressProxy({ kit, home })
    expect(out.token).toBe(OUTCOME.OK)
    expect(out.verdict.ok).toBe(true)
    expect(treeSnapshot(`${home}/.swarm`)).toEqual(before) // nothing written
    expect(kit.dryLogs.length).toBeGreaterThan(0) // logged, not on disk
  })

  it("real path mutates NO artefact, commits NO state, records NO provenance (only stepkit's setup.log sink runs)", async () => {
    const home = freshHome("real-nowrite")
    stageArtefacts(home)
    // The bake must not touch the rendered estate (compose/squid.conf/bin) — snapshot just that tree.
    const beforeTools = treeSnapshot(`${home}/.swarm/tools`)
    const kit = createStepKit({
      componentId: "firecrawl",
      lock: LOCK,
      state: readyState(),
      dryRun: false,
      consentGate: () => true,
    })
    const out = await bakeEgressProxy({ kit, home })
    expect(out.token).toBe(OUTCOME.OK)
    expect(treeSnapshot(`${home}/.swarm/tools`)).toEqual(beforeTools) // verification-only: artefacts untouched
    expect(existsSync(`${home}/.swarm/setup/stack-provenance.jsonl`)).toBe(false) // bake never writes provenance
    expect(existsSync(`${home}/.swarm/setup/state.json`)).toBe(false) // bake never commits state (bringUp owns that move)
    expect(kit.stateOf().state).toBe(STATES.CONFIGURED) // the in-memory view is untouched too
    // The ONLY thing kit.log does on the real path is append one redacted line to the standard setup.log sink.
    expect(existsSync(`${home}/.swarm/setup/setup.log`)).toBe(true)
  })

  it("FAILED bake lists findings and routes to F-3 honestly (never a silent pass)", async () => {
    const home = freshHome("fail")
    stageArtefacts(home)
    const ref = String(LOCK.components.firecrawl?.egress_proxy_image)
    const tampered = readFileSync(fcComposePath(home), "utf8").replace(
      ref,
      "docker.io/ubuntu/squid@sha256:" + "0".repeat(64),
    )
    const kit = createStepKit({
      componentId: "firecrawl",
      lock: LOCK,
      state: readyState(),
      dryRun: false,
      consentGate: () => true,
    })
    const out = await bakeEgressProxy({ kit, home, composeText: tampered, confText: renderSquidConf().content })
    expect(out.token).toBe(OUTCOME.FAILED)
    expect(out.message).toContain("F-3")
    expect(out.verdict.findings.some((f) => f.code === "IMAGE_PIN_MISMATCH")).toBe(true)
  })
})

// ================================================================================================
describe("(shape) the bake is NOT a registered component — the scan stays closed on egress-proxy", () => {
  it("discoverSteps reports zero errors and registers no egress-proxy step", () => {
    const scan = discoverSteps()
    expect(scan.errors).toEqual([])
    expect(scan.steps.map((s) => s.id)).not.toContain("egress-proxy")
    expect(scan.steps.some((s) => s.id === "firecrawl")).toBe(true)
  })
})

// ================================================================================================
describe("(reserved ACL name) redeclaring a squid-predefined name is itself a failure (R112-1)", () => {
  // Built from a synthetically RENAMED render then reverted, so it does NOT depend on whether r85-fix5 has landed.
  const renamed = v6RenameHostnames(renderSquidConf().content)

  it("the renamed (to_localhost -> swarm_hostnames) conf trips NO reserved-name lint", () => {
    expect(assertNoReservedAclNames(renamed)).toEqual([])
  })

  it("declaring the squid-predefined name to_localhost is refused as SQUID_RESERVED_ACL_NAME", () => {
    const broken = renamed.replace(/\bswarm_hostnames\b/g, "to_localhost") // the exact R112-1 crasher
    const f = assertNoReservedAclNames(broken)
    expect(f.some((x) => x.code === "SQUID_RESERVED_ACL_NAME" && x.item.includes("to_localhost"))).toBe(true)
  })

  it("the cross-enforcer hook is retargeted: it still finds all twelve + hostname coverage on the RENAMED conf", () => {
    expect(crossEnforcerAgreement(renamed)).toEqual([]) // name-agnostic (keys on dst/dstdomain TYPE + deny linkage)
  })

  it("verifyEgressBake fails closed when the conf declares a reserved ACL name", () => {
    const home = freshHome("reserved")
    stageArtefacts(home)
    const broken = v6RenameHostnames(renderSquidConf().content).replace(/\bswarm_hostnames\b/g, "to_localhost")
    const v = verifyEgressBake({
      lock: LOCK,
      home,
      composeText: readFileSync(fcComposePath(home), "utf8"),
      confText: broken,
    })
    expect(v.ok).toBe(false)
    expect(v.findings.some((f) => f.code === "SQUID_RESERVED_ACL_NAME")).toBe(true)
  })
})

// ================================================================================================
describe("(file modes) R112-5 secret hygiene (0700/0600) + executable docker-entrypoint.d wrap", () => {
  const makeRoot = (): string => {
    const tr = mkdtempSync(join(tmpdir(), "swarm-r92-modes-"))
    const secDir = `${tr}/firecrawl/secrets`
    mkdirSync(secDir, { recursive: true, mode: 0o700 })
    writeFileSync(`${secDir}/proxy_token`, "x".repeat(40), { mode: 0o600 })
    mkdirSync(`${tr}/firecrawl/compose/bin`, { recursive: true, mode: 0o700 })
    return tr
  }
  const wrapCompose = (wrap: string): string =>
    ["services:", "  auth-proxy:", "    volumes:", "      - type: bind", `        source: ${wrap}`, "        target: /docker-entrypoint.d/05-swarm-env.sh", ""].join("\n")

  it("a well-ordered root has NO mode findings", () => {
    const tr = makeRoot()
    const wrap = `${tr}/firecrawl/compose/bin/05-swarm-env.sh`
    writeFileSync(wrap, "#!/bin/sh\n", { mode: 0o755 })
    try {
      expect(auditFileModes(tr, wrapCompose(wrap))).toEqual([])
    } finally {
      rmSync(tr, { recursive: true, force: true })
    }
  })

  it("a non-executable docker-entrypoint.d wrap is refused (the silent nginx auth-bypass, R112-5)", () => {
    const tr = makeRoot()
    const wrap = `${tr}/firecrawl/compose/bin/05-swarm-env.sh`
    writeFileSync(wrap, "#!/bin/sh\n", { mode: 0o644 }) // nginx ignores non-executable -> token never substituted
    try {
      expect(auditFileModes(tr, wrapCompose(wrap)).some((f) => f.code === "MODE_ENTRYPOINT_WRAP" && f.item.includes(wrap))).toBe(true)
      chmodSync(wrap, 0o755)
      expect(auditFileModes(tr, wrapCompose(wrap)).some((f) => f.code === "MODE_ENTRYPOINT_WRAP")).toBe(false)
    } finally {
      rmSync(tr, { recursive: true, force: true })
    }
  })

  it("a secrets dir that is not 0700 / a secret file that is not 0600 is refused (D-04)", () => {
    const tr = makeRoot()
    const secDir = `${tr}/firecrawl/secrets`
    const secFile = `${secDir}/proxy_token`
    chmodSync(secDir, 0o777)
    chmodSync(secFile, 0o644)
    try {
      const f = auditFileModes(tr, "")
      expect(f.some((x) => x.code === "MODE_SECRETS_DIR" && x.item.includes(secDir))).toBe(true)
      expect(f.some((x) => x.code === "MODE_SECRET_FILE" && x.item.includes(secFile))).toBe(true)
    } finally {
      rmSync(tr, { recursive: true, force: true })
    }
  })
})
