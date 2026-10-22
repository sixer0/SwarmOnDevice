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
// r85-fix6's render-side rule for the same R112b-1 class — imported for the DRIFT PIN below, deliberately NOT used by
// the bake's own audit (see the "(cross-layer pin)" describe for why the two rulebooks stay separate).
import { findDirectiveInlineComments, SQUID_INLINE_COMMENT_DIRECTIVES } from "../src/composefiles/lint.ts"
import { discoverSteps } from "../src/steps.ts"
import { isDeniedAddress } from "../src/mcpproxy/urlpolicy.ts"
// Row 242's drift pin: the RENDER-side pair screen, imported only so the two rulebooks can be pinned against each
// other. The audit itself never calls this (see header item (7) of egress_bake.ts) — an audit that asks the renderer
// whether the renderer was right inherits every hole the renderer later grows.
import { extraHostPairProblem } from "../src/composefiles/dns_pins.ts"
import {
  assertNoReservedAclNames,
  auditBootClass,
  auditExtraHostPins,
  auditFileModes,
  auditSquidConf,
  bakeEgressProxy,
  bakeProofLayers,
  crossEnforcerAgreement,
  egressHealthContract,
  explainLiveLog,
  verifyEgressBake,
  APPROVED_TUNNEL_PORTS,
  LIVE_BOOT_SIGNATURES,
  OPTION_PARSED_PORT_DIRECTIVES,
  REQUIRED_DENY_RANGES,
  REQUIRED_PROXIED_SERVICES,
  // Row 243's probe-noise accounting: pure functions over RECORDED squid log lines. No live sink is touched here;
  // rows 254/255 supply the live reads, this suite proves the delta rule on fixtures.
  auditIdleWindow,
  classifySquidSinkLine,
  READINESS_PROBE_NOISE_TOKEN,
} from "../src/steps/firecrawl/egress_bake.ts"
import type { IdleWindowVerdict } from "../src/steps/firecrawl/egress_bake.ts"

/** Models r85-fix5's intended R112-1 fix (the live V6 experiment, 13_live_firecrawl.md:110): rename ONLY the
 *  hostname ACL off the squid-predefined `to_localhost` to a free name; the dst ACL name is irrelevant to the audit
 *  (it keys on ACL TYPE + deny linkage). Used to assert the verifier green against the TARGET artefact while the
 *  render still carries the reserved name — and to prove the lint by re-introducing the reserved name. */
const v6RenameHostnames = (t: string): string => t.replace(/\bto_localhost\b/g, "swarm_hostnames")

/** Build the EXACT R112b-1 defect shape from whatever the renderer currently emits: hang a trailing comment back on
 *  the option-parsed `http_port` line (`verification/13b_live_firecrawl_rerun.md` §7 R112b-1: that comment alone made
 *  squid 6.13 register no forward-proxy port). Works in both worlds — if the line is already bare (r85-fix6 landed)
 *  the comment is re-attached; if it still carries one, the shipped text already IS the shape and is returned intact. */
const r112b1Shape = (t: string): string =>
  t.replace(/^(\s*https?_port[^\n#]*?)\s*$/m, (_all, head: string) => `${head}   # PC-PORT-06 (unpublished; fc-ctl only)`)

/** The corrected shape row 85 owns: identical content, comment moved onto its own line (the fix 13b §7 prescribes:
 *  "put the comment on its own line"). Idempotent when no port directive carries an inline comment. */
const movePortCommentsToOwnLine = (t: string): string =>
  t
    .split("\n")
    .flatMap((line) => {
      const m = line.match(/^(\s*(?:https?_port)\b[^#]*)#\s*(.*)$/)
      return m ? [(m[1] ?? "").trimEnd(), `  # ${m[2] ?? ""}`] : [line]
    })
    .join("\n")

/** Comment-stripped, non-empty code lines — the only part of a squid conf an audit may depend on. Used to compare a
 *  staged artefact with the raw render because the transitional rename rewrite legitimately touches comment text. */
const codeLines = (t: string): string[] =>
  t
    .split("\n")
    .map((l) => (l.split("#")[0] ?? "").trimEnd())
    .filter((l) => l.length > 0)

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

/** Place the two compose stacks + generated configs under the throwaway tools root via the r85 interface, then rewrite
 *  the STAGED squid.conf to the target shape (R112-1 hostname rename + R112b-1 comment off the port directive).
 *  WHY THE REWRITE EXISTS: rows 92's green assertions must not depend on WHEN a sibling render fix lands, so the
 *  disk-reading tests run against the shape a CORRECTED renderer produces — the same transitional staging r92-fix3
 *  used for the hostname rename. It happens in a throwaway HOME before any bake call, so the zero-write assertions
 *  still compare like-for-like, and every defect shape is asserted separately ((reserved ACL name) and (boot class)
 *  below), so nothing about R112-1/R112b-1 is hidden by this. STATUS THIS ROUND: r85-fix5/r85-fix6 both landed while
 *  this suite was being written, so the rewrite is currently a NO-OP — proven by the "(happy)" equality test below. */
function stageArtefacts(home: string): void {
  const requiredManifest = { searxng: {} as Record<string, "generated">, firecrawl: {} as Record<string, "generated"> }
  for (const comp of ["searxng", "firecrawl"] as const) {
    for (const spec of SECRET_INVENTORY[comp]) if (spec.required) requiredManifest[comp][spec.name] = "generated"
  }
  const result = renderAll(LOCK, { home, secrets: requiredManifest })
  if (!result.ok)
    throw new Error(`stageArtefacts refused: ${JSON.stringify(result.errors)} ${JSON.stringify(result.findings)}`)
  applyRenderedFiles(result, `${home}/.swarm/tools`)
  const stagedConf = fcSquidPath(home)
  writeFileSync(stagedConf, movePortCommentsToOwnLine(v6RenameHostnames(readFileSync(stagedConf, "utf8"))))
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

// --- block-scoped editors: change ONLY the named rendered service, keep the file otherwise real ---
/** Transform lines inside ONE indent-2 service block (the same delimiting rule the audit's `serviceBlock` uses), so a
 *  fixture tampers the tier it names instead of "the first match in the file". Fix round 5 needed this: with api also
 *  carrying PROXY_SERVER, a whole-file non-global `.replace` silently tampered api while the test claimed to tamper
 *  Playwright. Pass null from `transform` to drop a line. */
function editServiceBlock(composeText: string, service: string, transform: (line: string) => string | null): string {
  const lines = composeText.split("\n")
  const s = lines.findIndex((l) => new RegExp(`^ {2}${service}:\\s*$`).test(l))
  if (s === -1) throw new Error(`test: no ${service} block found in the rendered compose`)
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

function editFcBody(composeText: string, transform: (line: string) => string | null): string {
  return editServiceBlock(composeText, "egress-proxy", transform)
}

/** PROXY_SERVER lines whose VALUE is exactly the filter route (value parsed out of the quotes, comments ignored). Used
 *  to state how many tiers a fixture still routes, so "one service tampered" is measured, never assumed. */
function routedFilterLines(composeText: string): string[] {
  const needle = `http://egress-proxy:${PC_PORTS.squidContainer}`
  return composeText
    .split("\n")
    .filter((l) => (l.match(/^\s+PROXY_SERVER:\s*"([^"]*)"/)?.[1] ?? "") === needle)
}

/** Which indent-2 services declare a PROXY_SERVER key at all — the input to the drift pin below. */
function servicesDeclaringRoute(composeText: string): string[] {
  const out: string[] = []
  let svc = ""
  for (const l of composeText.split("\n")) {
    const key = l.match(/^ {2}(\S.*):\s*$/)
    if (key) svc = key[1] ?? ""
    if (/^\s+PROXY_SERVER:/.test(l) && svc && !out.includes(svc)) out.push(svc)
  }
  return out
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
    // GREEN against the TARGET artefact: stageArtefacts has already applied r85-fix5's hostname rename AND r85-fix6's
    // comment-off-http_port shape, so this asserts the bake passes a corrected estate deterministically — independent
    // of whether either render fix has landed on the shared tree at run time. Each defect shape is asserted separately
    // ((reserved ACL name) and (boot class) below), so this neither hides R112-1 nor R112b-1, and it does not go red
    // waiting on a sibling.
    const v = verifyEgressBake({
      lock: LOCK,
      home,
      composeText: readFileSync(fcComposePath(home), "utf8"),
      confText: readFileSync(fcSquidPath(home), "utf8"),
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

  it("the transitional rewrite changes NO code line: the raw r85-fix6 render is what the bake just passed", () => {
    // Regression tripwire, not a convenience. r85-fix5 + r85-fix6 both landed while this round was being written
    // (squid_conf.ts now carries the PC-PORT-06 note on its own line), so staging must only ever touch comment text.
    // If this fails, stageArtefacts() is load-bearing again — go check row 85 before trusting the green above, and
    // the RAW-render assertions below are the reason: they are read straight off the renderer, not from staging.
    const home = freshHome("happy-raw")
    stageArtefacts(home)
    expect(codeLines(readFileSync(fcSquidPath(home), "utf8"))).toEqual(codeLines(renderSquidConf().content))
    expect(auditBootClass(renderSquidConf().content)).toEqual([]) // raw render, zero transitional help
    expect(auditBootClass(readFileSync(fcSquidPath(home), "utf8"))).toEqual([])
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
    // Block-scoped from FIX ROUND 5: a whole-file `.replace` works only while the needle is unique in the render, which
    // is exactly the assumption that broke this round's neighbour (`PROXY_SERVER`). Same discipline everywhere now.
    const tampered = editServiceBlock(readFileSync(fcComposePath(home), "utf8"), "egress-proxy", (l) =>
      l.includes(ref) ? l.replace(ref, "docker.io/ubuntu/squid@sha256:" + "0".repeat(64)) : l,
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
    const tampered = editServiceBlock(readFileSync(fcComposePath(home), "utf8"), "egress-proxy", (l) =>
      l.includes(`source: ${confPath}`) ? "        source: /elsewhere/squid.conf" : l,
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

  it("the render carries more than one PROXY_SERVER line, and every proxied service is on the audit's list (drift pin)", () => {
    // FIX ROUND 5's premise, pinned as a test: r85-fix6d (commit 0134c4a4ba) put api beside playwright-service, so any
    // fixture or audit rule that assumes ONE route line in this file is now wrong. If row 85 ever legitimately
    // changes WHICH tiers route, this test is where row 92's REQUIRED_PROXIED_SERVICES must be mirrored — equality
    // both ways on purpose: a service dropping out of the render is as much a drift as one appearing silently.
    const home = freshHome("route-multi")
    stageArtefacts(home)
    const composeText = readFileSync(fcComposePath(home), "utf8")
    expect(servicesDeclaringRoute(composeText).length).toBeGreaterThan(1)
    expect([...servicesDeclaringRoute(composeText)].sort()).toEqual([...REQUIRED_PROXIED_SERVICES].sort())
  })

  it("Playwright routed away from the filter is refused as PROXY_ROUTE_UNSET (api still routed)", () => {
    // Scoping matters since the render gained a second route line: the pre-fix fixture used a NON-GLOBAL replace, so it
    // blanked whichever PROXY_SERVER came first in file order — api's — and left Playwright routed. The audit then had
    // nothing to refuse and this test went red on a perfectly good render (the red r85-fix6e reported). Blank
    // Playwright's OWN key and assert the refusal names it: an intact api route must not be able to cover for a tier
    // that reaches the network directly (01e §10.7 F-3 leak class).
    const home = freshHome("route")
    stageArtefacts(home)
    const composeText = readFileSync(fcComposePath(home), "utf8")
    const tampered = editServiceBlock(composeText, "playwright-service", (l) =>
      /^\s+PROXY_SERVER:\s*"[^"]*"/.test(l) ? '      PROXY_SERVER: ""' : l,
    )
    expect(routedFilterLines(tampered).length).toBe(routedFilterLines(composeText).length - 1) // exactly one tier de-routed
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText: renderSquidConf().content })
    expect(v.ok).toBe(false)
    const hits = v.findings.filter((f) => f.code === "PROXY_ROUTE_UNSET")
    expect(hits.length).toBe(1) // api stays routed -> one refusal only; per-service scoping holds
    expect(hits[0]?.item).toContain("playwright-service")
  })

  it("NEGATIVE CONTROL: api's route removed while Playwright keeps its own is refused too, naming api", () => {
    // Required by the fix-round dispatch as the proof that the audit catches an unset proxy route per service, not
    // merely "no route anywhere": removing api's line (the second one in file order, the one the old fixture hit by
    // accident) must still stop the bake. Playwright's own route is intact here, so a whole-file `.some()` check would
    // pass silently — this is the fixture that would have stayed blind to the R112c-5 class on the api tier.
    const home = freshHome("route-neg")
    stageArtefacts(home)
    const composeText = readFileSync(fcComposePath(home), "utf8")
    const tampered = editServiceBlock(composeText, "api", (l) =>
      /^\s+PROXY_SERVER:\s*"[^"]*"/.test(l) ? '      PROXY_SERVER: ""' : l,
    )
    expect(routedFilterLines(tampered).length).toBe(routedFilterLines(composeText).length - 1)
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText: renderSquidConf().content })
    const hits = v.findings.filter((f) => f.code === "PROXY_ROUTE_UNSET")
    expect(hits.length).toBe(1)
    expect(hits[0]?.item).toContain("api")
    expect(hits[0]?.item).toContain(`"${`http://egress-proxy:${PC_PORTS.squidContainer}`}"`) // the expected value is stated, port from the register
  })

  it("a PROXY_SERVER left empty cannot pass on its needle appearing later in the file", () => {
    // The old guard scanned the WHOLE file for a line with a quoted value plus the needle. With two route lines, that
    // shape is reachable by accident: blank Playwright's value and the needle survives on api's line. Here BOTH tiers
    // are blanked line-by-line while the needle text is appended as a trailing comment, so nothing routes anywhere and
    // the refusal must still fire — the comment must carry no weight.
    const home = freshHome("route-comment")
    stageArtefacts(home)
    const needle = `http://egress-proxy:${PC_PORTS.squidContainer}`
    const composeText = readFileSync(fcComposePath(home), "utf8")
    const cleared = composeText.replace(/ {6}PROXY_SERVER: "[^"]*"/g, `      PROXY_SERVER: ""  # needle kept as comment only: ${needle}`)
    expect(routedFilterLines(cleared).length).toBe(0) // no VALUE equals the needle any more
    const v = verifyEgressBake({ lock: LOCK, home, composeText: cleared, confText: renderSquidConf().content })
    expect(v.findings.filter((f) => f.code === "PROXY_ROUTE_UNSET").length).toBe(REQUIRED_PROXIED_SERVICES.length)
  })

  it("the enforced route is exactly the egress-proxy on the register squid port, on every proxied tier (no literal port in this row)", () => {
    // Proves PROXY_SERVER derives from PC_PORTS.squidContainer; the assertion builds the needle from the register mirror.
    // Positive control for fix round 5's rule: one exact-value line per REQUIRED_PROXIED_SERVICES member, so the audit
    // and the render agree on the COUNT as well as the target.
    const home = freshHome("route-ok")
    stageArtefacts(home)
    const composeText = readFileSync(fcComposePath(home), "utf8")
    expect(composeText.includes(`http://egress-proxy:${PC_PORTS.squidContainer}`)).toBe(true)
    expect(routedFilterLines(composeText)).toHaveLength(REQUIRED_PROXIED_SERVICES.length)
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
describe("(boot class) R112b-1: a conf that PARSES but registers no forward-proxy port is refused offline (R112b-5)", () => {
  // The fixture is built from the renderer's own text, so the negative control is deterministic whether or not
  // r85-fix6 has moved the comment by the time this suite runs. No port literal anywhere: the drifted-port fixtures
  // derive from PC_PORTS.squidContainer (PROOF 4a greps this file for literals).
  const shipped = renderSquidConf().content
  const bad = r112b1Shape(shipped)
  const good = movePortCommentsToOwnLine(bad)

  it("the negative-control fixture really carries the R112b-1 shape (inline # on the port directive)", () => {
    expect(bad.split("\n").some((l) => /^\s*https?_port\b[^#\n]*#/.test(l))).toBe(true)
  })

  it("NEGATIVE CONTROL: auditBootClass fires on both faces of the class", () => {
    const codes = auditBootClass(bad).map((f) => f.code)
    expect(codes).toContain("SQUID_INLINE_COMMENT_ON_DIRECTIVE")
    expect(codes).toContain("SQUID_FORWARD_PORT_UNREGISTERED") // the boot symptom: no listener to register
  })

  it("the three OLDER layers are blind to that same text — the reason this layer had to exist (R112b-5)", () => {
    // Verbatim claim from verification/13b_live_firecrawl_rerun.md §7 R112b-5: presence/parse-level model + reserved-name
    // lint + type-based audit all ACCEPT the shipping config. If any of them ever starts biting here, this test says so.
    expect(auditSquidConf(bad)).toEqual([])
    expect(assertNoReservedAclNames(bad)).toEqual([])
    expect(crossEnforcerAgreement(bad)).toEqual([])
  })

  it("POSITIVE CONTROL: the corrected shape (comment on its own line) clears every boot-class code", () => {
    expect(good.split("\n").some((l) => /^\s*https?_port\b[^#\n]*#/.test(l))).toBe(false)
    expect(auditBootClass(good)).toEqual([])
    expect(auditSquidConf(good)).toEqual([]) // and the corrected shape still satisfies the policy audits
  })

  it("verifyEgressBake refuses the shipping shape end-to-end (fail-closed onto F-3, never a silent pass)", () => {
    const home = freshHome("bootclass")
    stageArtefacts(home)
    const v = verifyEgressBake({
      lock: LOCK,
      home,
      composeText: readFileSync(fcComposePath(home), "utf8"),
      confText: r112b1Shape(readFileSync(fcSquidPath(home), "utf8")),
    })
    expect(v.ok).toBe(false)
    expect(v.findings.map((f) => f.code)).toContain("SQUID_INLINE_COMMENT_ON_DIRECTIVE")
    expect(v.findings.map((f) => f.code)).toContain("SQUID_FORWARD_PORT_UNREGISTERED")
  })

  it("bakeEgressProxy refuses the same shape instead of blessing bring-up (live_smoke's precondition holds)", async () => {
    const home = freshHome("bootclass-kit")
    stageArtefacts(home)
    const kit = createStepKit({
      componentId: "firecrawl",
      lock: LOCK,
      state: readyState(),
      dryRun: false,
      consentGate: () => true,
    })
    const out = await bakeEgressProxy({
      kit,
      home,
      composeText: readFileSync(fcComposePath(home), "utf8"),
      confText: r112b1Shape(readFileSync(fcSquidPath(home), "utf8")),
    })
    expect(out.token).toBe(OUTCOME.FAILED)
    expect(out.message).toContain("F-3")
    expect(out.message).toContain("SQUID_INLINE_COMMENT_ON_DIRECTIVE")
  })

  it("a conf with NO port directive is refused as unregistered", () => {
    const stripped = good.split("\n").filter((l) => !/^\s*https?_port\b/.test(l)).join("\n")
    expect(
      auditBootClass(stripped).some(
        (f) => f.code === "SQUID_FORWARD_PORT_UNREGISTERED" && f.item.includes("no http_port/https_port directive"),
      ),
    ).toBe(true)
  })

  it("http_port 0 — the very value the live FATAL used in its internal URL — is refused as unregistered", () => {
    const zeroed = good.replace(/^(\s*https?_port)\b.*$/m, (_m, d: string) => `${d} 0`)
    expect(auditBootClass(zeroed).some((f) => f.code === "SQUID_FORWARD_PORT_UNREGISTERED")).toBe(true)
  })

  it("a forward-proxy port other than PC-PORT-06 is refused as SQUID_FORWARD_PORT_MISMATCH (conf/route drift)", () => {
    const drifted = good.replace(/^(\s*https?_port)\s*\d+.*$/m, (_m, d: string) => `${d} ${PC_PORTS.squidContainer + 1}`)
    const f = auditBootClass(drifted)
    expect(f.some((x) => x.code === "SQUID_FORWARD_PORT_MISMATCH" && x.item.includes(String(PC_PORTS.squidContainer)))).toBe(true)
    expect(f.some((x) => x.code === "SQUID_FORWARD_PORT_UNREGISTERED")).toBe(false) // a listener exists; it is just the wrong one
  })

  it("legal port options never false-fire; accel-mode does not count as a forward-proxy listener", () => {
    const withSuffix = (suffix: string): string =>
      good.replace(/^(\s*https?_port)\s*\d+.*$/m, (_m, d: string) => `${d} ${PC_PORTS.squidContainer} ${suffix}`)
    expect(auditBootClass(withSuffix("speed=100kbit/s"))).toEqual([])
    expect(auditBootClass(withSuffix('name="edge proxy"'))).toEqual([]) // quoted span stays ONE token
    expect(auditBootClass(withSuffix("accel")).some((f) => f.code === "SQUID_FORWARD_PORT_UNREGISTERED")).toBe(true)
    expect(auditBootClass(withSuffix("!bogus token")).some((f) => f.code === "SQUID_PORT_OPTION_UNPARSED")).toBe(true)
  })

  it("https_port is audited on the same rule (same option-parser family; hypothesis encoded, not hidden)", () => {
    expect(OPTION_PARSED_PORT_DIRECTIVES).toEqual(["http_port", "https_port"])
    expect(auditBootClass(`https_port ${PC_PORTS.squidContainer}\n`)).toEqual([])
    expect(auditBootClass(`https_port ${PC_PORTS.squidContainer}  # note\n`).map((f) => f.code)).toEqual([
      "SQUID_INLINE_COMMENT_ON_DIRECTIVE",
      "SQUID_FORWARD_PORT_UNREGISTERED",
    ])
  })

  it("self-consistency: the check fires on the RAW render exactly when that render carries the shape (r85-fix6 timing-proof)", () => {
    const rawCarriesInline = shipped.split("\n").some((l) => /^\s*https?_port\b[^#\n]*#/.test(l))
    expect(auditBootClass(shipped).some((f) => f.code === "SQUID_INLINE_COMMENT_ON_DIRECTIVE")).toBe(rawCarriesInline)
  })
})

// ================================================================================================
describe("(cross-layer pin) row 92's audit and row 85's render rule refuse the class without sharing one rulebook", () => {
  // r85-fix6 exported lint.ts:SQUID_INLINE_COMMENT_DIRECTIVES + findDirectiveInlineComments and asked this row to
  // import the predicate instead of re-deriving it (board, 2026-10-20). Kept SEPARATE on purpose: a bake that takes
  // its refusal list from the renderer it audits can be weakened by an edit to that renderer ALONE. What replaces the
  // shared constant is a machine-checked relation — row 92's boot-proven subset stays inside row 85's list and both
  // gates reach the same verdict on the same fixture — so drift fails a test here rather than silently narrowing an
  // audit. Their wider list (ftp_port, cache*, access_log, dns_v4_first, …) is a render-rule decision; this row only
  // refuses what the live A/B pair proves about the port directives.
  const shipped = renderSquidConf().content

  it("row 92's boot-critical set is a SUBSET of row 85's rule, which stays deliberately wider", () => {
    for (const d of OPTION_PARSED_PORT_DIRECTIVES) expect(SQUID_INLINE_COMMENT_DIRECTIVES).toContain(d)
    expect(SQUID_INLINE_COMMENT_DIRECTIVES.length).toBeGreaterThan(OPTION_PARSED_PORT_DIRECTIVES.length)
  })

  it("both gates bite on the R112b-1 fixture (independent implementations, same verdict)", () => {
    const bad = r112b1Shape(shipped)
    expect(auditBootClass(bad).some((f) => f.code === "SQUID_INLINE_COMMENT_ON_DIRECTIVE")).toBe(true)
    expect(findDirectiveInlineComments(bad).some((f) => f.rule === "squid-inline-comment")).toBe(true)
  })

  it("both gates clear the corrected shape, and row 85's rule already passes the shipped render", () => {
    const good = movePortCommentsToOwnLine(r112b1Shape(shipped))
    expect(auditBootClass(good)).toEqual([])
    expect(findDirectiveInlineComments(good)).toEqual([])
    expect(findDirectiveInlineComments(shipped)).toEqual([]) // r85-fix6 landed its half: no inline comment left on any listed directive
  })

  it("the wider rule holds over the staged artefact too (an out-of-band edit surfaces here, not in production)", () => {
    const home = freshHome("lint-pin")
    stageArtefacts(home)
    expect(findDirectiveInlineComments(readFileSync(fcSquidPath(home), "utf8"))).toEqual([])
  })
})

// ================================================================================================
describe("(proof layers) offline-proven vs live-only is declared in code, not left to prose", () => {
  const layers = bakeProofLayers()

  it("declares the offline-proven set, a labelled inferred set, and a non-empty live-only set", () => {
    expect(layers.offlineProven.length).toBeGreaterThanOrEqual(4)
    expect(layers.offlineInferred.length).toBeGreaterThanOrEqual(2)
    expect(layers.liveOnly.length).toBeGreaterThanOrEqual(3)
  })

  it("the live-only list names the two things this bake can never prove: the bind and the pull", () => {
    expect(layers.liveOnly.some((l) => /binds/i.test(l) && l.includes("CONNECT"))).toBe(true)
    expect(layers.liveOnly.some((l) => /pull/i.test(l))).toBe(true)
  })

  it("inferred claims are labelled as such, so no reader mistakes the shape model for a parser proof", () => {
    expect(layers.offlineInferred.every((l) => l.length > 20)).toBe(true)
    expect(layers.offlineInferred.some((l) => /HYPOTHESIS|inferred|correlation|model/i.test(l))).toBe(true)
  })

  it("the boot-class rule appears in the offline list and the boot outcome in the live list (no overclaiming)", () => {
    expect(layers.offlineProven.some((l) => l.includes("auditBootClass"))).toBe(true)
    expect(layers.liveOnly.some((l) => l.includes("PC-PORT-06"))).toBe(true)
  })
})

// ================================================================================================
describe("(live log signatures) row 112 attempt 3 inherits a verbatim boot-failure table", () => {
  it("every signature carries its literal line, provenance, owner and the offline rule (if any) that now covers it", () => {
    expect(LIVE_BOOT_SIGNATURES.length).toBeGreaterThanOrEqual(6)
    for (const s of LIVE_BOOT_SIGNATURES) {
      expect(s.signature.length).toBeGreaterThan(8)
      expect(s.provenBy.length).toBeGreaterThan(4)
      expect(s.owner.length).toBeGreaterThan(0)
      expect(s.caughtOfflineBy.length).toBeGreaterThan(0)
    }
  })

  it("explainLiveLog identifies the R112b-1 pair from lines copied out of the verifier's own cache.log", () => {
    const log = [
      "2026-10-20 10:53:40| ERROR: No forward-proxy ports configured.",
      "2026-10-20 10:53:40| FATAL: mimeLoadIcon: cannot parse internal URL: http://a0149312d6ec:0/squid-internal-static/icons/silk/image.png",
    ].join("\n")
    const hits = explainLiveLog(log).map((s) => s.signature)
    expect(hits).toContain("ERROR: No forward-proxy ports configured.")
    expect(hits).toContain("FATAL: mimeLoadIcon: cannot parse internal URL")
  })

  it("the signature for that error points at the codes THIS bake now emits, and those codes fire on the shape", () => {
    const s = LIVE_BOOT_SIGNATURES.find((x) => x.signature.startsWith("ERROR: No forward-proxy"))
    expect(s?.caughtOfflineBy).toContain("SQUID_INLINE_COMMENT_ON_DIRECTIVE")
    expect(auditBootClass(r112b1Shape(shippedRender())).map((f) => f.code)).toContain("SQUID_INLINE_COMMENT_ON_DIRECTIVE")
  })
})

/** Local re-read of the shipped render inside the last describe (module-level const would shadow the fixture above). */
function shippedRender(): string {
  return renderSquidConf().content
}

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
  const wrapCompose = (wrap: string, target = "/docker-entrypoint.d/05-swarm-env.envsh"): string =>
    ["services:", "  auth-proxy:", "    volumes:", "      - type: bind", `        source: ${wrap}`, `        target: ${target}`, ""].join("\n")

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

  it("the rule is extension-agnostic: it bites on r85-fix6's .envsh target and on the historical .sh one", () => {
    // r85-fix6 renamed the token wrap to fc-nginx-env.envsh (SOURCED, so the exec bit is not functionally required
    // any more). This row keeps refusing ANY non-executable file under a /docker-entrypoint.d/ target anyway: row 85's
    // shipped posture is 0700 for entrypoint-mounted wraps (their FIX ROUND 6 proof 7f), so the stricter rule costs
    // nothing today and still catches the R112-5 silent-skip class if a .sh wrap ever returns. If row 85 ever moves
    // the .envsh to 0600, this test is where the conversation happens — see the request line in the progress file.
    const tr = makeRoot()
    const envsh = `${tr}/firecrawl/compose/bin/fc-nginx-env.envsh`
    const legacy = `${tr}/firecrawl/compose/bin/05-swarm-env.sh`
    writeFileSync(envsh, "export SWARM_FIRECRAWL_TOKEN=x\n", { mode: 0o600 })
    writeFileSync(legacy, "#!/bin/sh\n", { mode: 0o600 })
    try {
      const both = wrapCompose(envsh) + wrapCompose(legacy, "/docker-entrypoint.d/05-swarm-env.sh")
      const hits = auditFileModes(tr, both).filter((f) => f.code === "MODE_ENTRYPOINT_WRAP").map((f) => f.item)
      expect(hits.some((i) => i.includes(envsh))).toBe(true)
      expect(hits.some((i) => i.includes(legacy))).toBe(true)
      chmodSync(envsh, 0o700)
      chmodSync(legacy, 0o700)
      expect(auditFileModes(tr, both).some((f) => f.code === "MODE_ENTRYPOINT_WRAP")).toBe(false)
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

// ================================================================================================
// ROW 242 (gate 239 lockstep). Two halves, both required by 01e §10.4's "lockstep duty, named for row 242" and by
// 05 §5 trap T-6: the port guard had to learn the render's new ACL form WITHOUT losing the ability to refuse a
// substituted, deleted, shrunk, widened or reverted class, and the narrowed extra_hosts lint (row 241, fork A) left
// this audit as the last offline stop between "the key is allowed" and "a pin routes the contained tier at the host".
// ================================================================================================

/** One `extra_hosts` pair on a service block, in the shape the artefact carries it. Used by every pair-level case
 *  below so the audit is driven through real text rather than an internal function. */
function pairCompose(hostname: string, value: string): string {
  return ["services:", "  probe-service:", "    image: example@sha256:" + "0".repeat(64), "    extra_hosts:", `      - "${hostname}:${value}"`, ""].join("\n")
}

/** Insert an extra_hosts block into ONE rendered service (the same insertion point row 241 renders at, after the
 *  service's `networks:` line), so an injection test tampers the tier it names and nothing else. */
function injectExtraHosts(composeText: string, service: string, entries: readonly string[]): string {
  return editServiceBlock(composeText, service, (l) =>
    /^ {4}networks:/.test(l)
      ? [l, "    extra_hosts:", ...entries.map((e) => `      - "${e}"`)].join("\n")
      : l,
  )
}

describe("(lockstep row 242) the CONNECT tunnel guard follows the render's ACL name and keeps its bite", () => {
  // The six tests row 241 deliberately left red are the ACCEPT side of this guard. Everything in this describe is the
  // other side, which is the reason the guard exists: §10.4 names the value of this audit as catching "a substituted
  // ACL name", not agreeing with whatever the renderer emitted last week.
  const shipped = renderSquidConf().content
  const portFilter = (conf: string): string[] =>
    auditSquidConf(conf)
      .filter((f) => f.code === "PORT_FILTER_MISSING")
      .map((f) => f.item)

  it("POSITIVE CONTROL: row 241's render clears the guard, and the shape that clears it is the approved one", () => {
    expect(portFilter(shipped)).toEqual([])
    // Asserted independently of the audit's own parse (plain text), so the audit cannot satisfy itself.
    expect(shipped).toContain("acl swarm_tunnel_ports port 80 443")
    expect(shipped).toContain("http_access deny Connector !swarm_tunnel_ports")
    expect(shipped).toContain("acl SSL_ports port 443") // §10.4's invariant that must survive the widening
    expect(shipped.split("\n").filter((l) => /^\s*http_access\s+allow\b/.test(l.split("#")[0] ?? ""))).toHaveLength(1)
    expect(APPROVED_TUNNEL_PORTS).toEqual([80, 443])
  })

  it("E4 DISCRIMINATION: the pre-lockstep bytes are REFUSED, so the instrument tells the two worlds apart", () => {
    const preGate = shipped
      .split("\n")
      .filter((l) => !/^\s*acl\s+swarm_tunnel_ports\s+port\b/.test(l))
      .map((l) => l.replace("http_access deny Connector !swarm_tunnel_ports", "http_access deny Connector !SSL_ports"))
      .join("\n")
    // The OLD matcher accepted these bytes; the NEW matcher accepts only the approved class, so a silent revert of the
    // render cannot pass the bake either. Had the fix been "accept both forms", this assertion would be vacuous.
    expect(portFilter(preGate)).toHaveLength(1)
    expect(portFilter(preGate)[0]).toContain('"SSL_ports"')
    expect(portFilter(preGate)[0]).toContain("not the approved")
  })

  const mutations: readonly { readonly name: string; readonly conf: string; readonly names?: string }[] = [
    { name: "the CONNECT deny line is DELETED", conf: shipped.split("\n").filter((l) => !/^\s*http_access\s+deny\s+Connector\s+!/.test(l)).join("\n"), names: "no `http_access deny" },
    {
      name: "the tunnel ACL declaration is DELETED, leaving a dangling reference",
      conf: shipped.split("\n").filter((l) => !/^\s*acl\s+swarm_tunnel_ports\s+port\b/.test(l)).join("\n"),
      names: "swarm_tunnel_ports",
    },
    {
      name: "the deny argument is SUBSTITUTED to an ACL nothing declares",
      conf: shipped.replace("http_access deny Connector !swarm_tunnel_ports", "http_access deny Connector !swarm_wrong_ports"),
      names: "swarm_wrong_ports",
    },
    { name: "the tunnel class is SHRUNK to 443 (the pre-gate coverage)", conf: shipped.replace("acl swarm_tunnel_ports port 80 443", "acl swarm_tunnel_ports port 443"), names: "[443]" },
    { name: "the tunnel class is WIDENED to 8080", conf: shipped.replace("acl swarm_tunnel_ports port 80 443", "acl swarm_tunnel_ports port 80 443 8080"), names: "8080" },
    { name: "the tunnel class is widened by a second additive same-name line", conf: `${shipped}\nacl swarm_tunnel_ports port 8080\n`, names: "8080" },
    { name: "the tunnel class carries a range token instead of plain ports", conf: shipped.replace("acl swarm_tunnel_ports port 80 443", "acl swarm_tunnel_ports port 80 443 1024-65535"), names: "not a plain-integer port-class ACL" },
    { name: "the tunnel ACL's TYPE is corrupted from port to dst", conf: shipped.replace("acl swarm_tunnel_ports port 80 443", "acl swarm_tunnel_ports dst 80 443"), names: "not a plain-integer port-class ACL" },
    { name: "the method ACL stops declaring CONNECT, so the line is no longer a tunnel rule", conf: shipped.replace("acl Connector method CONNECT", "acl Connector method GET"), names: "no `http_access deny" },
    {
      name: "the tunnel class is negated by a DECOY deny line whose method term is not the CONNECT ACL",
      conf: shipped
        .replace("acl Connector method CONNECT", "acl Connector method CONNECT\nacl NotATunnel method GET")
        .replace("http_access deny Connector !swarm_tunnel_ports", "http_access deny NotATunnel !swarm_tunnel_ports"),
      names: "no `http_access deny",
    },
    { name: "the CONNECT deny line is hidden behind a comment", conf: shipped.replace("http_access deny Connector !swarm_tunnel_ports", "# http_access deny Connector !swarm_tunnel_ports"), names: "no `http_access deny" },
    { name: "the tunnel ACL line is hidden behind a comment", conf: shipped.replace("acl swarm_tunnel_ports port 80 443", "# acl swarm_tunnel_ports port 80 443"), names: "swarm_tunnel_ports" },
    { name: "the non-tunnel guard is dropped (no `deny !SafePorts`)", conf: shipped.split("\n").filter((l) => !/^\s*http_access\s+deny\s+!SafePorts\s*$/.test(l)).join("\n"), names: "!SafePorts" },
    { name: "SafePorts loses both approved ports", conf: shipped.replace("acl SafePorts port 80 443", "acl SafePorts port 8080"), names: "SafePorts carries [8080]" },
    { name: "SafePorts is WIDENED beyond the approved non-tunnel pair", conf: shipped.replace("acl SafePorts port 80 443", "acl SafePorts port 80 443 8080"), names: "SafePorts carries [80, 443, 8080]" },
    {
      // The regression this row nearly shipped with: once row 241 moved the deny reference off SSL_ports, a substring
      // matcher stopped mentioning the class at all, so deleting it would have baked green. It is now resolved through
      // the same port parser as the tunnel class, which keeps §10.4's "stays declared and unchanged" enforceable.
      name: "the SSL_ports declaration is DELETED while its old referencer is gone (the §10.4 surviving invariant)",
      conf: shipped.split("\n").filter((l) => !/^\s*acl\s+SSL_ports\s+port\b/.test(l)).join("\n"),
      names: "SSL_ports",
    },
  ]
  for (const m of mutations) {
    it(`MUTATION: ${m.name} is refused as PORT_FILTER_MISSING`, () => {
      const items = portFilter(m.conf)
      expect(items).toHaveLength(1) // exactly one finding for one guard — not a cascade that could mask it
      if (m.names) expect(items[0]).toContain(m.names) // and it NAMES the leg that failed
    })
  }

  it("it is the CLASS that is audited, not the literal: renaming ACL and reference together stays green", () => {
    const renamed = shipped.replace(/swarm_tunnel_ports/g, "swarm_egress_ports")
    expect(renamed).not.toContain("swarm_tunnel_ports")
    expect(portFilter(renamed)).toEqual([])
    // …while renaming ONLY the reference (the substitution the audit exists to catch) still refuses.
    expect(portFilter(shipped.replace("deny Connector !swarm_tunnel_ports", "deny Connector !swarm_egress_ports")).length).toBe(1)
  })

  it("set semantics, not string equality: reordered, duplicated and same-name-split classes stay green", () => {
    expect(portFilter(shipped.replace("acl swarm_tunnel_ports port 80 443", "acl swarm_tunnel_ports port 443 80"))).toEqual([])
    expect(portFilter(shipped.replace("acl swarm_tunnel_ports port 80 443", "acl swarm_tunnel_ports port 80 443 443"))).toEqual([])
    expect(
      portFilter(shipped.replace("acl swarm_tunnel_ports port 80 443", "acl swarm_tunnel_ports port 80\nacl swarm_tunnel_ports port 443")),
    ).toEqual([])
  })

  it("the twelve deny tokens the audit already verifies are still exactly twelve, both directions", () => {
    // §12's contract line for this row: REQUIRED_DENY_RANGES keeps its twelve entries and urlpolicy does not move —
    // this is a port-class change, and isDeniedAddress compares bytes, never ports. Set equality BOTH ways, so a
    // dropped class and an added class each fail here rather than being averaged into a count.
    expect(REQUIRED_DENY_RANGES.length).toBe(12)
    const tokens = new Set<string>()
    for (const line of shipped.split("\n")) {
      const m = (line.split("#")[0] ?? "").match(/^acl\s+\S+\s+dst\s+(.+)$/)
      if (m?.[1]) for (const t of m[1].trim().split(/\s+/)) tokens.add(t)
    }
    expect([...tokens].sort()).toEqual([...REQUIRED_DENY_RANGES.map((r) => r.cidr)].sort())
    expect(auditSquidConf(shipped)).toEqual([])
    expect(crossEnforcerAgreement(shipped)).toEqual([]) // the identity hook at egress_bake.ts:666-688 still holds
  })

  it("verifyEgressBake is green on the staged artefacts and red on the reverted render end-to-end", () => {
    const home = freshHome("lockstep")
    stageArtefacts(home)
    const composeText = readFileSync(fcComposePath(home), "utf8")
    const confText = readFileSync(fcSquidPath(home), "utf8")
    expect(verifyEgressBake({ lock: LOCK, home, composeText, confText }).ok).toBe(true)
    const reverted = confText
      .split("\n")
      .filter((l) => !/^\s*acl\s+swarm_tunnel_ports\s+port\b/.test(l))
      .map((l) => l.replace("deny Connector !swarm_tunnel_ports", "deny Connector !SSL_ports"))
      .join("\n")
    const v = verifyEgressBake({ lock: LOCK, home, composeText, confText: reverted })
    expect(v.ok).toBe(false)
    expect(v.findings.filter((f) => f.code === "PORT_FILTER_MISSING")).toHaveLength(1)
  })
})

// ================================================================================================
describe("(extra_hosts audit row 242) a pin may carry a public answer, never the host and never a denied class", () => {
  const codesFor = (hostname: string, value: string): string[] => auditExtraHostPins(pairCompose(hostname, value)).map((f) => f.code)

  it("POSITIVE CONTROL: no key at all, a commented key, and public pairs each yield ZERO findings", () => {
    expect(auditExtraHostPins(["services:", "  api:", "    networks: [fc-ctl]", ""].join("\n"))).toEqual([])
    expect(auditExtraHostPins(["services:", "  api:", '    extra_hosts:  # P3 injected public answers; none rendered', ""].join("\n"))).toEqual([])
    expect(auditExtraHostPins(pairCompose("example.com", "104.20.23.154"))).toEqual([])
    expect(auditExtraHostPins(pairCompose("zeta.example.org", "8.8.8.8"))).toEqual([])
    // a flow-form public entry parses and passes too
    expect(auditExtraHostPins(["services:", "  api:", '    extra_hosts: ["example.com:93.184.216.34"]', ""].join("\n"))).toEqual([])
    // and a trailing comment naming a hostile pair satisfies nothing and trips nothing
    expect(auditExtraHostPins(["services:", "  api:", "    extra_hosts:", '      - "example.com:104.20.23.154"  # crawl.example:127.0.0.1', ""].join("\n"))).toEqual([])
  })

  const hostile: readonly { readonly name: string; readonly hostname: string; readonly value: string; readonly code: string }[] = [
    { name: "the §4.5 door in its own spelling", hostname: "host.docker.internal", value: "host-gateway", code: "EXTRA_HOST_AT_HOST" },
    { name: "host-gateway under a public-looking name", hostname: "crawl.example", value: "host-gateway", code: "EXTRA_HOST_AT_HOST" },
    { name: "denied NAME with a PUBLIC value (the name screen survives)", hostname: "host.docker.internal", value: "93.184.216.34", code: "EXTRA_HOST_AT_HOST" },
    { name: "cloud metadata name", hostname: "metadata.google.internal", value: "1.1.1.1", code: "EXTRA_HOST_AT_HOST" },
    { name: ".local suffix name", hostname: "a.local", value: "1.1.1.1", code: "EXTRA_HOST_AT_HOST" },
    { name: "a denied host NAME in the value slot", hostname: "crawl.example", value: "localhost", code: "EXTRA_HOST_AT_HOST" },
    { name: "loopback v4 value", hostname: "crawl.example", value: "127.0.0.1", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "the RC-234-2 nip.io fixture address", hostname: "crawl.example", value: "192.168.5.3", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "RFC1918 10/8 value", hostname: "crawl.example", value: "10.1.2.3", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "link-local / cloud-metadata address", hostname: "crawl.example", value: "169.254.169.254", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "CGNAT value", hostname: "crawl.example", value: "100.64.0.1", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "this-network value", hostname: "crawl.example", value: "0.0.0.1", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "IPv6 loopback value", hostname: "crawl.example", value: "::1", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "IPv6 unspecified value", hostname: "crawl.example", value: "::", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "IPv6 link-local value", hostname: "crawl.example", value: "fe80::1", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "NAT64-wrapped loopback value", hostname: "crawl.example", value: "64:ff9b::7f00:1", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "IPv4-mapped IPv6 loopback value", hostname: "crawl.example", value: "::ffff:127.0.0.1", code: "EXTRA_HOST_DENIED_VALUE" },
    { name: "multicast value (outside the twelve CIDRs, caught by the unicast leg)", hostname: "crawl.example", value: "239.1.2.3", code: "EXTRA_HOST_SHAPE_INVALID" },
    { name: "reserved value 240/4", hostname: "crawl.example", value: "240.0.0.1", code: "EXTRA_HOST_SHAPE_INVALID" },
    { name: "public IPv6 value, withheld by design (producer spec §1.2)", hostname: "crawl.example", value: "2606:4700:dead:beef::1", code: "EXTRA_HOST_SHAPE_INVALID" },
    { name: "leading-zero (octal-parseable) form", hostname: "crawl.example", value: "010.1.2.3", code: "EXTRA_HOST_SHAPE_INVALID" },
    { name: "hex-component form", hostname: "crawl.example", value: "0x6e.0.0.1", code: "EXTRA_HOST_SHAPE_INVALID" },
    { name: "undotted service short-name (docker DNS shadowing)", hostname: "redis", value: "104.20.23.154", code: "EXTRA_HOST_SHAPE_INVALID" },
    { name: "uppercase name", hostname: "CRAWL.EXAMPLE", value: "104.20.23.154", code: "EXTRA_HOST_SHAPE_INVALID" },
    { name: "IP literal in the name slot", hostname: "1.2.3.4", value: "104.20.23.154", code: "EXTRA_HOST_SHAPE_INVALID" },
    { name: "trailing-root-dot name", hostname: "example.com.", value: "104.20.23.154", code: "EXTRA_HOST_SHAPE_INVALID" },
  ]
  for (const h of hostile) {
    it(`HOSTILE: ${h.name} — ${h.hostname}:${h.value} is refused as ${h.code}`, () => {
      expect(codesFor(h.hostname, h.value)).toContain(h.code)
    })
  }

  it("every hostile pair is refused, never merely described: no case above yields an empty finding list", () => {
    for (const h of hostile) expect(auditExtraHostPins(pairCompose(h.hostname, h.value)).length).toBeGreaterThan(0)
  })

  it("flow-form hostility is caught the same way as block form", () => {
    const flow = ["services:", "  api:", '    extra_hosts: ["crawl.example:host-gateway"]', ""].join("\n")
    expect(auditExtraHostPins(flow).map((f) => f.code)).toContain("EXTRA_HOST_AT_HOST")
  })

  it("malformed pairs are refused rather than skipped", () => {
    expect(codesFor("crawl.example", "")).toContain("EXTRA_HOST_SHAPE_INVALID") // "name:" -> empty address
    expect(auditExtraHostPins(["services:", "  api:", "    extra_hosts:", "      - crawl.example", ""].join("\n")).length).toBe(1)
  })

  it("DRIFT PIN: the audit's screens and the renderer's screens agree pair-for-pair in both directions", () => {
    // Two independent implementations over one shared predicate (urlpolicy) — §10.4 forbids a second address list, the
    // cross-layer doctrine forbids the audit inheriting the renderer's rulebook. Exact agreement is what makes the
    // pairing safe: a screen that drifts either way is a red test here, not a quiet hole or a false refusal.
    const pairs: readonly (readonly [string, string])[] = [
      ["example.com", "104.20.23.154"],
      ["zeta.example.org", "8.8.8.8"],
      ["sub.domain.example.co.uk", "172.66.147.243"],
      ["host.docker.internal", "host-gateway"],
      ["host.docker.internal", "93.184.216.34"],
      ["crawl.example", "host-gateway"],
      ["crawl.example", "127.0.0.1"],
      ["crawl.example", "192.168.5.3"],
      ["crawl.example", "169.254.169.254"],
      ["crawl.example", "::1"],
      ["crawl.example", "64:ff9b::7f00:1"],
      ["crawl.example", "239.1.2.3"],
      ["crawl.example", "2606:4700:dead:beef::1"],
      ["crawl.example", "010.1.2.3"],
      ["crawl.example", "0x6e.0.0.1"],
      ["crawl.example", "not-an-address"],
      ["redis", "104.20.23.154"],
      ["CRAWL.EXAMPLE", "104.20.23.154"],
      ["1.2.3.4", "104.20.23.154"],
      ["example.com.", "104.20.23.154"],
      ["metadata.google.internal", "1.1.1.1"],
      ["a.local", "1.1.1.1"],
    ]
    const divergences: string[] = []
    for (const [hostname, value] of pairs) {
      const renderRefuses = extraHostPairProblem(hostname, value) !== null
      const auditRefuses = auditExtraHostPins(pairCompose(hostname, value)).length > 0
      if (auditRefuses !== renderRefuses) divergences.push(`${hostname}:${value} render_refuses=${renderRefuses} audit_refuses=${auditRefuses}`)
    }
    // Empty means two independent screens reach the same verdict on every pair, in both directions: the audit is not
    // merely a copy of the render rule (it would report nothing if the render rule were weakened), and it does not
    // refuse a pair the renderer legitimately emits.
    expect(divergences).toEqual([])
  })

  it("cross-enforcer identity after the move: the value leg and urlpolicy answer identically on both sides", () => {
    for (const rep of REQUIRED_DENY_RANGES) {
      expect(isDeniedAddress(rep.probe)).toBe(true)
      expect(codesFor("pin.example", rep.probe)).toContain("EXTRA_HOST_DENIED_VALUE")
    }
    for (const pub of ["104.20.23.154", "172.66.147.243", "93.184.216.34", "8.8.8.8"]) {
      expect(isDeniedAddress(pub)).toBe(false)
      expect(auditExtraHostPins(pairCompose("pin.example", pub))).toEqual([])
    }
  })

  it("end-to-end: a poisoned pin in the staged compose refuses the whole bake and the refusal names the service", () => {
    const home = freshHome("p3-hostile")
    stageArtefacts(home)
    const composeText = readFileSync(fcComposePath(home), "utf8")
    const confText = readFileSync(fcSquidPath(home), "utf8")
    expect(verifyEgressBake({ lock: LOCK, home, composeText, confText }).ok).toBe(true) // control: the shipped estate
    const tampered = injectExtraHosts(composeText, "api", ["host.docker.internal:host-gateway"])
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText })
    expect(v.ok).toBe(false)
    const hits = v.findings.filter((f) => f.code.startsWith("EXTRA_HOST"))
    expect(hits.length).toBeGreaterThanOrEqual(2) // the name leg AND the host-gateway value leg
    expect(hits.every((f) => f.item.includes("api"))).toBe(true) // block-scoped: it names the tier it refuses
    expect(hits.every((f) => f.code === "EXTRA_HOST_AT_HOST")).toBe(true)
  })

  it("NEGATIVE CONTROL for the same rule: a legal public pin on api leaves the bake green (no false fire)", () => {
    const home = freshHome("p3-clean")
    stageArtefacts(home)
    const composeText = readFileSync(fcComposePath(home), "utf8")
    const tampered = injectExtraHosts(composeText, "api", ["example.com:104.20.23.154", "zeta.example.org:8.8.8.8"])
    const v = verifyEgressBake({ lock: LOCK, home, composeText: tampered, confText: readFileSync(fcSquidPath(home), "utf8") })
    expect(v.findings.filter((f) => f.code.startsWith("EXTRA_HOST"))).toEqual([])
    expect(v.ok).toBe(true)
  })

  it("the audit covers EVERY service that carries the key, not only the two the renderer writes to", () => {
    // Row 241 chose a value-based lint and emits on api + playwright-service by construction; the approval narrowed
    // the rule to ENTRY CONTENTS, so this audit screens whichever tier carries the key rather than inventing a
    // service allow-list the gate did not authorise. A hostile entry on a third tier must still refuse.
    const home = freshHome("p3-third-tier")
    stageArtefacts(home)
    const composeText = readFileSync(fcComposePath(home), "utf8")
    const third = injectExtraHosts(composeText, "redis", ["crawl.example:192.168.5.3"])
    const v = verifyEgressBake({ lock: LOCK, home, composeText: third, confText: readFileSync(fcSquidPath(home), "utf8") })
    expect(v.findings.some((f) => f.code === "EXTRA_HOST_DENIED_VALUE" && f.item.includes("redis"))).toBe(true)
  })
})

// --- row 243 / R112d-3: the readiness-probe lines that pollute the egress audit sink ------------------------------
//
// Every fixture below is a RECORDED squid native access-log line, shaped from the live evidence in
// verification/13d_live_firecrawl_attempt4.md (§4 A5 idle leg, §5.2/§5.4 sink lines, §8 R112d-3's eleven
// `NONE_NONE/000 … error:transaction-end-before-headers` lines). Nothing here boots squid or reads a live sink — the
// delta rule is proved on fixtures, and the live proof is row 255's cell. The three things the row must prove are each
// a named group: (1) IDLE is still concluded while the gate polls, NOT by ignoring the sink; (2) a sink that wrote NO
// lines is a distinct BLIND_SINK outcome; (3) the delta comparison is load-bearing (see the mutation battery in
// implementation/s6b_r112d3_probe_noise.md — these tests are what those mutants break).
describe("(probe-noise accounting row 243) the idle window survives the readiness gate's own polling", () => {
  // Faithful recorded shapes. Timestamps differ per line (squid stamps every connect), so repeated probes are distinct
  // strings; the multiset-delta test below pins the identical-repeat case separately.
  const realGet = "1761119702.123    0 172.22.0.3 TCP_MISS/200 1013 GET http://example.com/ - HIER_DIRECT/172.66.147.243 text/html"
  const deniedConnect = "1761119704.789    0 172.22.0.3 TCP_DENIED/403 3375 CONNECT 127.0.0.1:80 - HIER_NONE/- text/html"
  const tunnel = "1761119703.456    0 172.22.0.2 TCP_TUNNEL/200 7073 CONNECT example.com:443 - HIER_DIRECT/104.20.23.154 -"
  const controlLine = "1761119705.000    0 172.22.0.3 TCP_MISS_ABORTED/503 0 GET http://r112d-ctrl.example.com/ - HIER_NONE/- text/html"
  const CONTROL_MARKER = "r112d-ctrl.example.com"
  const probeNoise = (ms: number): string =>
    `176111970${ms}.${ms}    0 172.22.0.1 NONE_NONE/000 0 - ${READINESS_PROBE_NOISE_TOKEN} - HIER_NONE/- -`
  const elevenProbes = Array.from({ length: 11 }, (_, i) => probeNoise(i))
  const garbage = "this is not a squid access-log line at all"

  // ---- classification itself, the primitive the window decision is built from ----
  it("classifies the gate's self-connect as PROBE_NOISE and a completed request as REAL_EGRESS", () => {
    expect(classifySquidSinkLine(probeNoise(0))).toBe("PROBE_NOISE")
    expect(classifySquidSinkLine(realGet)).toBe("REAL_EGRESS")
    expect(classifySquidSinkLine(deniedConnect)).toBe("REAL_EGRESS")
    expect(classifySquidSinkLine(tunnel)).toBe("REAL_EGRESS")
  })

  it("the control marker wins over physical shape: a deliberate request is the witness, not traffic", () => {
    // Physically the control IS a real request (TCP_MISS_ABORTED/503); without the marker it reads as egress, with it
    // it reads as CONTROL. That precedence is what lets a control prove liveness without breaking idleness.
    expect(classifySquidSinkLine(controlLine)).toBe("REAL_EGRESS")
    expect(classifySquidSinkLine(controlLine, CONTROL_MARKER)).toBe("CONTROL")
  })

  it("an unattributable non-blank line is UNRECOGNIZED, never silently idle", () => {
    expect(classifySquidSinkLine(garbage)).toBe("UNRECOGNIZED")
    expect(classifySquidSinkLine("   ")).toBe("UNRECOGNIZED")
  })

  // ---- PROOF 1: IDLE while the gate actively polls, and NOT by ignoring the sink ----
  it("PROOF 1 — concludes IDLE with eleven probe lines landing, counting them rather than discarding them", () => {
    const v = auditIdleWindow({ before: [realGet], after: [realGet, ...elevenProbes] })
    expect(v.outcome).toBe("IDLE")
    // The fix is NOT "ignore the sink": the eleven probe lines were seen and counted as noise (that count is the very
    // witness that proves the sink is writing), while none of them counted as egress.
    expect(v.probeNoise).toBe(11)
    expect(v.realEgress).toBe(0)
    expect(v.witness).toBe("PROBE_NOISE")
    expect(v.blockingLines).toEqual([])
  })

  // ---- PROOF 2: a sink that wrote nothing is a DISTINCT outcome, never folded into idle ----
  it("PROOF 2 — an entirely empty sink reports BLIND_SINK, its own named result", () => {
    const v = auditIdleWindow({ before: [], after: [] })
    expect(v.outcome).toBe("BLIND_SINK")
    expect(v.witness).toBe("NONE")
    expect(v.added).toBe(0)
  })

  it("PROOF 2b — a stale sink (no new lines, gate stopped) is BLIND_SINK, not the idle a naive filter would fake", () => {
    // A "drop the 000 lines, if nothing remains call it idle" implementation would report IDLE here — indistinguishable
    // from a dead sink. The witness requirement is what refuses it.
    const v = auditIdleWindow({ before: [realGet], after: [realGet] })
    expect(v.outcome).toBe("BLIND_SINK")
    expect(v.witness).toBe("NONE")
  })

  it("E4 DISCRIMINATION — idle-with-poll and blind-sink are distinguishable outcomes, not byte-identical", () => {
    const idleWithPoll = auditIdleWindow({ before: [realGet], after: [realGet, ...elevenProbes] }).outcome
    const blind = auditIdleWindow({ before: [realGet], after: [realGet] }).outcome
    expect(idleWithPoll).toBe("IDLE")
    expect(blind).toBe("BLIND_SINK")
    expect(idleWithPoll).not.toBe(blind)
  })

  // ---- the second witness path: a control line once the gate has stopped polling ----
  it("IDLE via a control line landing after the window, when no probe noise remains", () => {
    const v = auditIdleWindow({
      before: [realGet],
      after: [realGet],
      controlMarker: CONTROL_MARKER,
      controlProbe: [realGet, controlLine],
    })
    expect(v.outcome).toBe("IDLE")
    expect(v.witness).toBe("CONTROL")
    expect(v.realEgress).toBe(0)
  })

  it("a control line inside the window is the witness, not traffic that flips IDLE to BUSY", () => {
    const v = auditIdleWindow({ before: [], after: [controlLine], controlMarker: CONTROL_MARKER })
    expect(v.outcome).toBe("IDLE")
    expect(v.control).toBe(1)
    expect(v.realEgress).toBe(0)
  })

  // ---- the assertion still bites: real egress is never masked by probe noise or by the control ----
  it("reports BUSY when a real request appears in the window, naming the line", () => {
    const v = auditIdleWindow({ before: [], after: [realGet] })
    expect(v.outcome).toBe("BUSY")
    expect(v.realEgress).toBe(1)
    expect(v.blockingLines).toContain(realGet)
  })

  it("probe noise does NOT mask real egress: a tunnel beside the probes still reads BUSY", () => {
    const v = auditIdleWindow({ before: [], after: [probeNoise(0), tunnel] })
    expect(v.outcome).toBe("BUSY")
    expect(v.probeNoise).toBe(1)
    expect(v.realEgress).toBe(1)
    expect(v.blockingLines).toContain(tunnel)
  })

  it("an unrecognised line fails closed to BUSY, never to IDLE", () => {
    const v = auditIdleWindow({ before: [], after: [garbage] })
    expect(v.outcome).toBe("BUSY")
    expect(v.unrecognized).toBe(1)
    expect(v.blockingLines).toContain(garbage)
  })

  // ---- the delta rule is load-bearing (mutant M1 deletes exactly this) ----
  it("DELTA not absolute: a real line already present at the window start does not make the window busy", () => {
    // The scrape that triggered the 120 s window logged realGet BEFORE the window opened. Inside the window only probe
    // noise lands. Counting `after` wholesale (the delete-the-delta mutant) would see realGet and report BUSY; the
    // delta sees only the added probes and correctly reports IDLE.
    const v = auditIdleWindow({ before: [realGet, deniedConnect], after: [realGet, deniedConnect, ...elevenProbes.slice(0, 3)] })
    expect(v.outcome).toBe("IDLE")
    expect(v.realEgress).toBe(0)
    expect(v.added).toBe(3)
  })

  it("multiset delta keeps identical repeats a set difference would collapse", () => {
    const same = probeNoise(7)
    const v = auditIdleWindow({ before: [], after: [same, same, same] })
    expect(v.probeNoise).toBe(3)
    expect(v.added).toBe(3)
  })
})
