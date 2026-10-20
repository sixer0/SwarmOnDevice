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
//   (6) BOOT-CLASS audit (R112b-5, follows R112b-1) — the layer rows 1-3 of this file did not have. Presence,
//       ACL-type and even `squid -k parse` all accept the shipping config (`verification/13b_live_firecrawl_rerun.md`
//       §7 R112b-1/R112b-5), so this audit models what squid's option parser REGISTERS rather than whether the file
//       parses: an inline `#` on an option-parsed port directive is refused (the exact R112b-1 shape, which left
//       squid printing `ERROR: No forward-proxy ports configured.` 177 times before FATAL on the pinned 6.13 digest —
//       $TMPDIR/swarm-setup-r112b-proofs/squid-cache.log), and the rendered config must yield at least one PARSEABLE
//       non-zero forward-proxy port equal to PC-PORT-06. `bakeProofLayers()` states which claims are offline-proven
//       and which stay live-only; `LIVE_BOOT_SIGNATURES` hands row 112 the log lines that name each boot failure class.
//
// HONESTY (offline green != live green): this verifier NEVER boots squid and cannot prove the proxy binds anything.
// It proves the SHAPES that the pinned digest's own live A/B experiment showed to be fatal, plus register equality.
// A green bake means "no offline-detectable boot-class defect", never "the container will serve".
//
// BOUNDARIES: zero port literals (PC_PORTS.squidContainer only, imported); zero @sha256 digest literals in
// src (the cleared reference lives only in the test fixtures, mirroring r91's egress-pin fixtures); no
// process-spawn or raw-network builtin is imported and none is ever called; the verifier WRITES NOTHING EVER
// (verification-only — the configured->healthy move stays bringUp's, rows 91/93), which is what makes
// dry-run zero-writes trivially true. It is consent-gated FIRST through the StepKit before any action (P-13).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { OUTCOME, type OutcomeToken } from "../../outcomes.ts"
import { MODES } from "../../constants.ts"
import type { LockFile } from "../../lockfile.ts"
import type { StepKit } from "../../stepkit.ts"
import { egressProxyPinReady, firecrawlPlan } from "../../stacklib.ts"
import { pathsFor, PC_PORTS } from "../../composefiles/shared.ts"
// r94's host-side url policy (L3 enforcer). PURE module (zero imports of its own), so this adds no runtime
// dependency to the setup binary beyond the deny predicate itself; read-only import — row 92 never edits r94's
// file. `isDeniedAddress` is the exact predicate r94's checkResolvedAddresses feeds the resolved-IP pin through
// (§13 / 01f_tool_wiring_spec.md §6.4), which is what makes it the right handle for the cross-enforcer equality check.
import { isDeniedAddress } from "../../mcpproxy/urlpolicy.ts"

/** §10.4 destinations that MUST be denied — the TWELVE amended classes (01e §10.4 as amended by r75-fix4 per
 *  review-107 MAJOR-2; verification/11_setup_code_review.md:54-62). Canonical CIDR spellings exactly as the r85
 *  renderer emits them; each carries a `probe` IP literal in that class so the cross-enforcer hook can ask the
 *  L3 urlpolicy predicate whether it denies the SAME class squid denies (see crossEnforcerAgreement). The three
 *  added over the original nine are 0.0.0.0/8 (this-network — the class M2 proved escaping via connect(0.0.0.0)
 *  → loopback), ::/128 (IPv6 unspecified, its twin) and 64:ff9b::/96 (NAT64 well-known — DNS64 answers embed a
 *  private IPv4, e.g. 64:ff9b::7f00:1 wraps 127.0.0.1; posture is DENY the whole prefix, never unwrap). These are
 *  policy REQUIREMENTS transcribed from the spec, not invented values. */
export const REQUIRED_DENY_RANGES: readonly { readonly cidr: string; readonly kind: string; readonly probe: string }[] = [
  { cidr: "127.0.0.0/8", kind: "loopback", probe: "127.0.0.1" },
  { cidr: "10.0.0.0/8", kind: "private (RFC1918)", probe: "10.0.0.1" },
  { cidr: "172.16.0.0/12", kind: "private (RFC1918)", probe: "172.16.0.1" },
  { cidr: "192.168.0.0/16", kind: "private (RFC1918)", probe: "192.168.0.1" },
  { cidr: "169.254.0.0/16", kind: "link-local", probe: "169.254.1.1" },
  { cidr: "100.64.0.0/10", kind: "CGNAT", probe: "100.64.0.1" },
  { cidr: "0.0.0.0/8", kind: "this-network", probe: "0.0.0.0" }, // [review-107 M2] new class
  { cidr: "::1/128", kind: "IPv6 loopback", probe: "::1" },
  { cidr: "fe80::/10", kind: "IPv6 link-local", probe: "fe80::1" },
  { cidr: "fc00::/7", kind: "IPv6 unique-local", probe: "fc00::1" },
  { cidr: "::/128", kind: "IPv6 unspecified", probe: "::" }, // [review-107 M2] new class
  { cidr: "64:ff9b::/96", kind: "NAT64 well-known", probe: "64:ff9b::1" }, // [review-107 M2] new class
]

/** The in-container path squid is told to load (r85 bindMount target). One definition site, reused by the
 *  bind-target and `-f`-argument checks so they cannot drift from each other. */
const SQUID_CONF_TARGET = "/etc/squid/swarm-egress.conf"

/** ACL names squid PREDEFINES and therefore refuses to have redeclared with a different type — reusing one is a
 *  boot FATAL (`aclParseAclLine: ACL 'to_localhost' already exists with different type` / `FATAL: Bungled`), the
 *  R112-1 crash row 92's presence-based audit was blind to (verification/13_live_firecrawl.md §5 V0/M2). The set is
 *  transcribed from the reservation note the PINNED digest itself ships at /etc/squid/squid.conf:1387 (quoted at
 *  verification/13_live_firecrawl.md:108): "all, manager, localhost, to_localhost, to_linklocal, and CONNECT".
 *  to_ipv6_link_local is added as squid's canonical spelling of the link-local builtin. Deliberately EXCLUDED:
 *  `to_localnet` — the live experiments prove it is NOT predefined (V6 keeps it and parses rc=0; M1 shows its v4/v6
 *  same-type split is fine, :109), so flagging it would false-fail the renderer that correctly leaves it alone; and
 *  `SSL_ports`/`Safe_ports`/`localnet`/`Connector` — the estate redeclares SSL_ports same-type, which squid tolerates
 *  (the crash was at the hostname line, not the port line), so those are out of scope for THIS collision class. */
export const RESERVED_SQUID_ACL_NAMES: readonly string[] = [
  "all",
  "manager",
  "localhost",
  "to_localhost",
  "to_linklocal",
  "to_ipv6_link_local",
  "CONNECT",
]

/** Directives whose ARGUMENTS go through squid's option/port-list parser — the class R112b-1 proved is
 *  boot-critical in a way its GRAMMAR is not. `http_port` is the boot-proven member: on the pinned digest
 *  (`squid 6.13`) the rendered line `http_port <PC-PORT-06>   # PC-PORT-06 (unpublished; …)` booted, printed
 *  `ERROR: No forward-proxy ports configured.` 177 times and FATALed at
 *  `mimeLoadIcon: cannot parse internal URL: http://<host>:0/…` ($TMPDIR/swarm-setup-r112b-proofs/squid-cache.log:24
 *  and its tail); deleting ONLY that trailing comment on an otherwise byte-identical conf made the error disappear
 *  entirely (…/squid-cache-p1.log has zero occurrences) while every OTHER inline comment in the file stayed put —
 *  which is why this refusal list is the port-directive pair and NOT a blanket "no inline comments anywhere" rule
 *  (a blanket rule would refuse directives the live run shows to be tolerated, forcing churn in row 85's render).
 *  `https_port` is included as the SAME parser code path's other member — that equivalence is a labelled
 *  HYPOTHESIS (source-level inference), not a second boot experiment. Row 85 keeps a WIDER render-side list of the same
 *  class in `src/composefiles/lint.ts:SQUID_INLINE_COMMENT_DIRECTIVES` (ftp_port, cache*, access_log, dns_v4_first, …);
 *  this list stays deliberately narrow — it is what a BOOT observation justifies — and the two are pinned against each
 *  other by a test named cross-layer pin in test/egress_bake.test.ts rather than shared, so a renderer edit can never
 *  narrow the audit by itself. */
export const OPTION_PARSED_PORT_DIRECTIVES: readonly string[] = ["http_port", "https_port"]

/** Services whose OWN `PROXY_SERVER` must point at the filter, checked one by one and never by "any line anywhere".
 *  The render legitimately carries more than one proxy line since r85-fix6d (`0134c4a4ba`): `playwright-service` had
 *  it from the start (P-9's enforced route, 01e §6.7), and `api` gained it when the §10.7 F-4 correction was INVOKED
 *  for R112c-5 — attempt 3 measured api carrying no proxy env at all (verification/13c:119-120,232), and the ruling
 *  that fixed it says the register's own conditional (`01c0_preinstall_register.md:242-243`: do not set `PROXY_*`
 *  unless the SSRF-filter proxy IS the configured route) is now satisfied "on both tiers"
 *  (delegation_progress/r75fix9_corepack_ruling.md §4.2, implemented verbatim at firecrawl_compose.ts:178-180 and
 *  :316-317). Checking the whole file with `.some()` instead of this list is what let an UNROUTED playwright bake
 *  green once the second line appeared: measured in fix round 5, blanking playwright's route while api's stays
 *  produces zero findings. COUPLING, stated: a ruling that ever removes one of these routes (or adds a third tier)
 *  must amend this list in the same change; the test named "every service that declares a proxy route here is on
 *  REQUIRED_PROXIED_SERVICES" fails loudly if the render and this list drift apart. */
export const REQUIRED_PROXIED_SERVICES: readonly string[] = ["playwright-service", "api"]

export type BakeCode =
  | "ARTEFACT_MISSING"
  | "PIN_UNUSABLE"
  | "IMAGE_PIN_MISMATCH"
  | "CONF_BIND_MISSING"
  | "CMD_CONF_MISMATCH"
  | "PROXY_ROUTE_UNSET"
  | "DENY_RANGE_MISSING"
  | "URLPOLICY_NOT_DENY"
  | "CROSS_ENFORCER_DIVERGENCE"
  | "DENY_HOSTNAME_MISSING"
  | "DENY_NOT_ENFORCED"
  | "DEFAULT_DENY_MISSING"
  | "DEFAULT_DENY_MISORDERED"
  | "PORT_FILTER_MISSING"
  | "NOCACHE_MISSING"
  | "SQUID_GRAMMAR_INVALID"
  | "SQUID_RESERVED_ACL_NAME"
  | "SQUID_INLINE_COMMENT_ON_DIRECTIVE"
  | "SQUID_PORT_OPTION_UNPARSED"
  | "SQUID_FORWARD_PORT_UNREGISTERED"
  | "SQUID_FORWARD_PORT_MISMATCH"
  | "MODE_SECRETS_DIR"
  | "MODE_SECRET_FILE"
  | "MODE_ENTRYPOINT_WRAP"
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

  // (1d) every SSRF-capable tier must route at the filter UNDER ITS OWN KEY — one refusal per service, never
  // "some PROXY_SERVER line anywhere". Two reasons, both measured in fix round 5: the render legitimately carries
  // more than one such line since r85-fix6d (api + playwright-service, REQUIRED_PROXIED_SERVICES above), so a
  // whole-file `.some()` lets api's line cover for a missing playwright route; and the old pattern `".*"` matched an
  // EMPTY value too, so only the needle appearing somewhere on the line counted — a trailing comment could satisfy
  // it. The quoted value is compared exactly here. Port comes from PC_PORTS, never a literal.
  const routeNeedle = `http://egress-proxy:${PC_PORTS.squidContainer}`
  for (const svc of REQUIRED_PROXIED_SERVICES) {
    const svcBlock = serviceBlock(composeText, svc)
    const declaredValues = lineMatches(svcBlock, /^\s+PROXY_SERVER:/).map(
      (l) => l.match(/^\s+PROXY_SERVER:\s*"([^"]*)"/)?.[1] ?? "(unparseable)",
    )
    if (declaredValues.includes(routeNeedle)) continue
    const state = svcBlock.length === 0 ? "service block absent from the render" : declaredValues.length === 0 ? "key absent" : `value(s) [${declaredValues.map((v) => `"${v}"`).join(", ")}]`
    findings.push({
      code: "PROXY_ROUTE_UNSET",
      item: `${svc}: no PROXY_SERVER set to "${routeNeedle}" — ${state}`,
      hint: "the filter is only real if EVERY SSRF-capable surface is routed through it (P-9; PC-PORT-06 via PC_PORTS.squidContainer, no literal here). Another service's route cannot substitute: an unrouted tier keeps a default gateway and reaches hosts directly (the F-3 leak class 01e §10.7 exists to prevent).",
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
  // (renamed-ACL safe) reserved-name collision: redeclaring a squid-predefined ACL name is a boot FATAL (R112-1).
  findings.push(...assertNoReservedAclNames(confText))
  // (cross-enforcer) L3 urlpolicy ⇄ L4 squid must deny the IDENTICAL set, each a superset of the twelve.
  findings.push(...crossEnforcerAgreement(confText))
  // (R112b-5 BOOT-CLASS) presence/parse-level layers above are all blind to a config that parses but registers no
  // forward-proxy port, so this refusal runs too — R112b-1's shape must fail the bake, not reach the VM.
  findings.push(...auditBootClass(confText))
  // (R112-5) file-mode posture is a DISK fact: only asserted when the artefacts were read from a real tools root
  // (production/row-93 posture). In-memory mismatch tests pass texts directly and skip this by design.
  if (opts.confText === undefined && opts.composeText === undefined && opts.home !== undefined) {
    findings.push(...auditFileModes(root, composeText))
  }

  return { ok: findings.length === 0, findings, imageRef: pin.ref, composePath, confPath }
}

/** Reserved-name collision lint (R112-1). A squid build PREDEFINES certain ACL names; redeclaring one with a
 *  different type FATALs at parse/boot — `to_localhost` did exactly that in the live run. Because reserved-name use
 *  is now itself a failure, the bake refuses any conf that declares an ACL whose name is in RESERVED_SQUID_ACL_NAMES,
 *  independent of the render's chosen custom names (the rename target for `to_localhost` lives with row 85). */
export function assertNoReservedAclNames(confText: string): BakeFinding[] {
  const findings: BakeFinding[] = []
  const seen = new Set<string>()
  for (const c of confText.split("\n").map((line) => line.split("#")[0] ?? "")) {
    const m = c.match(/^acl\s+(\S+)\s+\S+/) // `acl <name> <type> ...`
    const name = m?.[1]
    if (!name || seen.has(name)) continue
    if (RESERVED_SQUID_ACL_NAMES.includes(name)) {
      seen.add(name)
      findings.push({
        code: "SQUID_RESERVED_ACL_NAME",
        item: `acl '${name}' redeclares a squid-predefined name`,
        hint: `R112-1 (13_live_firecrawl.md:108, V0/V6): predefined set is [${RESERVED_SQUID_ACL_NAMES.join(", ")}]; use a non-reserved name (the live fix renamed the hostname ACL away from to_localhost; http_access deny must follow) or squid FATALs at boot`,
      })
    }
  }
  return findings
}

/** Boot-class audit (R112b-5). Where the other layers ask "is the policy present and does the text parse?", this one
 *  asks the next question — "would squid actually REGISTERS a forward-proxy listener from these directive shapes?" —
 *  because the live re-run proved the gap empirically: the shipping config passed `assertNoReservedAclNames`, the
 *  type-based §10.4 audit AND `squid -k parse`, then booted, printed `ERROR: No forward-proxy ports configured.`
 *  177 times and FATALed with an internal URL on port 0 (`$TMPDIR/swarm-setup-r112b-proofs/squid-cache.log:24`, `:204`,
 *  `grep -c` = 177), while a byte-identical conf with ONLY the `http_port` trailing comment deleted produced zero such
 *  errors (`…/squid-cache-p1.log`, `grep -c` = 0). Two offline-detectable faces of that class are refused here:
 *  (1) an inline comment on an option-parsed port directive, and (2) a port directive that yields no parseable
 *  non-zero forward-proxy port, or one that disagrees with PC-PORT-06 (the port PROXY_SERVER points at). This is a
 *  SHAPE model calibrated to that single A/B experiment — it is NOT a squid lexer reimplementation and it does not
 *  boot anything; `bakeProofLayers()` states which part of the claim is offline-proven and which stays live-only. */
export function auditBootClass(confText: string): BakeFinding[] {
  const findings: BakeFinding[] = []
  const lines = confText.split("\n")
  const forwardPorts: number[] = []
  let sawPortDirective = false
  let sawAccelOnly = false
  let commentedPortLines = 0
  let perLineUnregistered = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ""
    const m = raw.match(/^\s*(https?_port)\b(.*)$/) // full-line comments cannot reach here: `#` is not \s
    if (!m) continue
    const rest = m[2] ?? ""
    const where = `line ${i + 1}: ${raw.trim()}`
    sawPortDirective = true

    if (rest.includes("#")) {
      commentedPortLines++
      findings.push({
        code: "SQUID_INLINE_COMMENT_ON_DIRECTIVE",
        item: `${where} — inline comment on an option-parsed directive`,
        hint: "R112b-1 ($TMPDIR/swarm-setup-r112b-proofs/squid-cache.log:24,:204 vs squid-cache-p1.log): on squid 6.13 this shape boots but registers NO forward-proxy port (`ERROR: No forward-proxy ports configured.` → FATAL mimeLoadIcon port :0), and `squid -k parse` accepts it silently. Move the comment to its own line (row 85 owns the render).",
      })
      continue
    }

    const tokens = tokenizeDirectiveArgs(rest)
    const port = tokens.length > 0 ? portSpecValue(tokens[0] ?? "") : null
    if (port === null) {
      perLineUnregistered++
      findings.push({
        code: "SQUID_FORWARD_PORT_UNREGISTERED",
        item: `${where} — ${tokens.length === 0 ? "no port argument" : `port spec "${tokens[0]}" is not a parseable non-zero port`}`,
        hint: "boot-class assertion: squid only serves forward proxy traffic when an http_port/https_port line parses to a listener; the live symptom of getting this wrong is `ERROR: No forward-proxy ports configured.` (squid-cache.log:24). A missing or malformed port means no filtered egress path at all.",
      })
      continue
    }

    const opts = tokens.slice(1)
    const junk = opts.filter((t) => !PORT_OPTION_TOKEN.test(unquote(t)))
    if (junk.length > 0)
      findings.push({
        code: "SQUID_PORT_OPTION_UNPARSED",
        item: `${where} — non-option token(s) [${junk.join(" ")}] after the port spec`,
        hint: "generalisation of the R112b-1 class (HYPOTHESIS, not boot-proven beyond the inline-comment case): everything after an http_port port spec must be a squid port option (`flag` or `key=value`), otherwise the rest of the line is parsed as further port specs/options and the intended listener can vanish. Kept separate from UNREGISTERED so a valid port with a suspect option is not double-reported.",
      })
    if (opts.some((t) => unquote(t).toLowerCase().split("=")[0] === "accel")) sawAccelOnly = true // accel = web accelerator, not a forward-proxy listener
    else forwardPorts.push(port)
  }

  if (forwardPorts.length === 0 && perLineUnregistered === 0) {
    const reason = !sawPortDirective
      ? `no ${OPTION_PARSED_PORT_DIRECTIVES.join("/")} directive in the rendered conf`
      : commentedPortLines > 0
        ? `${commentedPortLines} port line(s) refused above for an inline comment, so no forward-proxy listener was registered`
        : sawAccelOnly
          ? "every declared port is accel-mode (web accelerator), so no forward-proxy listener exists"
          : "no declared port line yielded a forward-proxy listener"
    findings.push({
      code: "SQUID_FORWARD_PORT_UNREGISTERED",
      item: reason,
      hint: "the bake's boot-class stand-in for a real boot: without a parseable non-zero http_port the pinned digest exits 1 after `ERROR: No forward-proxy ports configured.` (squid-cache.log:24) and Playwright's PROXY_SERVER route has nothing to talk to. Only a live bind proves the listener really exists — see bakeProofLayers().liveOnly.",
    })
  } else if (forwardPorts.length > 0 && !forwardPorts.includes(PC_PORTS.squidContainer)) {
    findings.push({
      code: "SQUID_FORWARD_PORT_MISMATCH",
      item: `rendered forward-proxy port(s) [${forwardPorts.join(", ")}] do not include PC-PORT-06 (${PC_PORTS.squidContainer}) that PROXY_SERVER targets`,
      hint: "the conf and the enforced route must name the same port; today only the route side derived from PC_PORTS (PROXY_ROUTE_UNSET), so a conf listening elsewhere would have baked green while every browser fetch failed. Register value imported, never re-spelled.",
    })
  }

  return findings
}

/** What each layer of this bake actually establishes — machine-readable honesty about the four-layer blind spot
 *  R112b-1 exposed (presence grep → ACL/type audit → `squid -k parse` → real boot: the first three were all green
 *  on a config that could not serve a single request, `verification/13b_live_firecrawl_rerun.md` §7 R112b-1/R112b-5).
 *  Row 93/112 read this instead of inferring the bake's reach from prose. */
export interface EgressProofLayers {
  /** Deterministic artefact facts this bake proves offline. */
  readonly offlineProven: readonly string[]
  /** Offline rules whose SOUNDNESS rests on one live observation or on source-level inference — labelled, not hidden. */
  readonly offlineInferred: readonly string[]
  /** Claims no offline check can make; only a live boot/pull can close them. */
  readonly liveOnly: readonly string[]
}

export function bakeProofLayers(): EgressProofLayers {
  return {
    offlineProven: [
      "rendered compose image == tools.lock.json egress_proxy_image pin; conf bound at the path the command loads via -f; EVERY service on REQUIRED_PROXIED_SERVICES carries its own PROXY_SERVER equal to egress-proxy:PC-PORT-06 (IMAGE_PIN_MISMATCH / CONF_BIND_MISSING / CMD_CONF_MISMATCH / PROXY_ROUTE_UNSET)",
      "all twelve §10.4 classes appear in a DENIED dst ACL and the dstdomain pair covers localhost + .local, deny-then-default-deny ordering included (auditSquidConf / crossEnforcerAgreement)",
      "no ACL redeclares a squid-predefined name (assertNoReservedAclNames; R112-1 closed live by r85-fix5)",
      "secret dir/file modes and executable /docker-entrypoint.d wraps over a real tools root (auditFileModes; R112-5)",
      "no inline comment sits on an option-parsed port directive, and the port directive parses to a non-zero port equal to PC-PORT-06 (auditBootClass; R112b-1/R112b-5)",
    ],
    offlineInferred: [
      "that an inline comment on http_port is what removed the listener — one live A/B pair (squid-cache.log vs squid-cache-p1.log) establishes the correlation, not a parser reimplementation",
      "that https_port behaves like http_port (same option-parser family; HYPOTHESIS, never booted here)",
      "that accel-mode ports do not count as forward-proxy listeners — model of the predicate squid's own error line is printed from, not verified against the digest in this row",
      "that inline comments on OTHER directives are safe — inferred from the p1 run, which booted past config processing with all of them in place",
    ],
    liveOnly: [
      "squid actually binds PC-PORT-06 and answers a CONNECT (needs `docker exec`/a probe inside the VM; rows 93/112)",
      "whether `access_log stdio:/dev/stdout` is writable by cache_effective_user in the estate container — the verifier's throwaway run FATALed on exactly this (squid-cache-p1.log:19) and the estate never got far enough to show it",
      "`ERROR: Directive 'dns_v4_first' is obsolete.` noise on the pinned 6.13 digest (squid-cache-p1.log:2) — spec-mandated directive vs pinned release, decision for rows 75/85",
      "per-target SSRF refusals for the six §10.6 targets and the idle zero-line/control-line audit pair",
      "the image pull itself, digest resolution and any daemon-side enforcement (`--pull never`) — rows 93/112",
    ],
  }
}

/** A cache.log/stdout line that names a specific boot failure, with who owns it. Row 112 attempt 3 can grep a
 *  container log through `explainLiveLog` instead of re-deriving these from memory: every entry is a VERBATIM line
 *  already observed on the pinned digest, so a match is an identification, not a guess. Read-only helper — the bake
 *  never sees a live log itself (it spawns nothing); row 93/112's driver feeds it one. */
export interface LiveBootSignature {
  readonly signature: string
  readonly meaning: string
  readonly provenBy: string
  readonly owner: string
  /** Whether row 92's offline bake now refuses the shape that causes it. */
  readonly caughtOfflineBy: string
}

export const LIVE_BOOT_SIGNATURES: readonly LiveBootSignature[] = [
  {
    signature: "ERROR: No forward-proxy ports configured.",
    meaning: "squid started but registered no forward-proxy listener: the egress filter exists only as a file",
    provenBy: "$TMPDIR/swarm-setup-r112b-proofs/squid-cache.log:24 (x177, grep -c)",
    owner: "row 85 (squid_conf render) — R112b-1",
    caughtOfflineBy: "SQUID_INLINE_COMMENT_ON_DIRECTIVE + SQUID_FORWARD_PORT_UNREGISTERED",
  },
  {
    signature: "FATAL: mimeLoadIcon: cannot parse internal URL",
    meaning: "downstream of the same cause: squid builds its internal-static URL from port 0 because no port registered",
    provenBy: "$TMPDIR/swarm-setup-r112b-proofs/squid-cache.log:204",
    owner: "row 85 — R112b-1 (symptom, not a separate defect)",
    caughtOfflineBy: "same pair as above",
  },
  {
    signature: "already exists with different type",
    meaning: "an ACL line redeclares a squid-predefined name under a different type — boot FATAL",
    provenBy: "verification/13_live_firecrawl.md:108 (image reservation note, transcribed into RESERVED_SQUID_ACL_NAMES)",
    owner: "row 85 (render naming) — R112-1, CLOSED live by r85-fix5",
    caughtOfflineBy: "SQUID_RESERVED_ACL_NAME",
  },
  {
    signature: "can't create /docker-entrypoint.env: Read-only file system",
    meaning: "the auth-proxy token hand-off writes to a read-only rootfs, so nginx starts without the token channel",
    provenBy: "verification/13b_live_firecrawl_rerun.md:134 (R112b-2)",
    owner: "row 85 (bin_scripts/nginx_template) — R112b-2",
    caughtOfflineBy: "NOTHING — mode/exec-bit only (MODE_ENTRYPOINT_WRAP) cannot see the write target",
  },
  {
    signature: 'unknown "swarm_firecrawl_token" variable',
    meaning: "envsubst left the braced token in the template, so nginx parses it as its own variable and exits 1",
    provenBy: "verification/13b_live_firecrawl_rerun.md:134 (R112b-2)",
    owner: "row 85 — R112b-2",
    caughtOfflineBy: "NOTHING — nginx-side, outside this bake's artefact surface",
  },
  {
    signature: "wget: not found",
    meaning: "a healthcheck calls a tool the pinned digest does not ship, so the gate can never go green",
    provenBy: "verification/13b_live_firecrawl_rerun.md:135 (R112b-3)",
    owner: "rows 85 (healthchecks) + 91 (gate) — R112b-3",
    caughtOfflineBy: "NOTHING — needs the image's own filesystem; rows 93/112 probe it",
  },
  {
    signature: "Directive 'dns_v4_first' is obsolete.",
    meaning: "the pinned 6.13 digest rejects the §10.4-mandated directive with an ERROR line every boot (non-fatal)",
    provenBy: "$TMPDIR/swarm-setup-r112b-proofs/squid-cache-p1.log:2",
    owner: "rows 75 (spec bullet) + 85 (render) — audit-cleanliness decision, UNKNOWN whether fatal in combination",
    caughtOfflineBy: "deliberately NOT refused: the directive is spec-mandated, so a bake refusal would pre-empt row 75",
  },
  {
    signature: "Cannot open '/dev/stdout' for writing.",
    meaning: "access_log stdio:/dev/stdout is not writable by cache_effective_user (proxy) in the container as run",
    provenBy: "$TMPDIR/swarm-setup-r112b-proofs/squid-cache-p1.log:19",
    owner: "rows 85 (render) + 112 (live verdict) — whether the estate entrypoint avoids this is UNKNOWN until http_port is fixed",
    caughtOfflineBy: "NOTHING — writability inside the container is a live fact, not an artefact fact",
  },
]

/** Match a live container log against LIVE_BOOT_SIGNATURES; returns every signature whose literal appears. */
export function explainLiveLog(logText: string): LiveBootSignature[] {
  return LIVE_BOOT_SIGNATURES.filter((s) => logText.includes(s.signature))
}

/** File-mode posture (R112-5, security-bearing). Two contracts, both real FS facts asserted only over a rendered
 *  tools root: (a) D-04 secret hygiene — the firecrawl secrets dir 0700 and every secret file 0600; (b) R112-5's
 *  silent-auth-bypass class — a host file mounted under a container `/docker-entrypoint.d/` target MUST be
 *  executable, because the official nginx entrypoint IGNORES non-executable `.sh` there (`Ignoring … not
 *  executable`), so a 0644 wrap never runs envsubst and the bearer token silently ships empty. Absent secrets/files
 *  are NOT failed here — secret generation is the owning step's job (D-22); this asserts the SHAPE of what exists. */
export function auditFileModes(toolsRoot: string, composeText: string): BakeFinding[] {
  const findings: BakeFinding[] = []
  const p = pathsFor(toolsRoot)

  if (existsSync(p.firecrawlSecrets)) {
    const dirMode = statSync(p.firecrawlSecrets).mode & 0o777
    if (dirMode !== MODES.DIR_0700)
      findings.push({
        code: "MODE_SECRETS_DIR",
        item: `${p.firecrawlSecrets} mode ${dirMode.toString(8)} (want ${MODES.DIR_0700.toString(8)})`,
        hint: "R112-5 / D-04 (PC-PATH-09): secrets dir must be 0700",
      })
    for (const name of readdirSync(p.firecrawlSecrets)) {
      const f = `${p.firecrawlSecrets}/${name}`
      if (!statSync(f).isFile()) continue
      const m = statSync(f).mode & 0o777
      if (m !== MODES.FILE_0600)
        findings.push({
          code: "MODE_SECRET_FILE",
          item: `${f} mode ${m.toString(8)} (want ${MODES.FILE_0600.toString(8)})`,
          hint: "R112-5 / D-04: secret files 0600 (group/other bits set leak the value)",
        })
    }
  }

  // Every `/docker-entrypoint.d/` bind in the stack must be executable on the host.
  const lines = composeText.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const src = lines[i]?.match(/^\s+source:\s*(\S+)/)?.[1]
    if (!src || src.includes(":")) continue // skip tmpfs-style sources carrying a colon
    // find the paired target within the next couple of lines (r85 bindMount emits source then target)
    let target = ""
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
      const t = lines[j]?.match(/^\s+target:\s*(\S+)/)?.[1]
      if (t) {
        target = t
        break
      }
    }
    if (!target.includes("/docker-entrypoint.d/")) continue
    if (!existsSync(src)) continue // owner has not placed it yet -> other gates cover absence
    const mode = statSync(src).mode & 0o777
    if ((mode & 0o100) === 0)
      findings.push({
        code: "MODE_ENTRYPOINT_WRAP",
        item: `${src} mounted at ${target} is mode ${mode.toString(8)} (not executable)`,
        hint: "R112-5: the nginx official entrypoint silently IGNORES non-executable docker-entrypoint.d scripts -> the token wrap never runs (silent auth bypass); render 0755 (or invoke via sh)",
      })
  }

  return findings
}

/** Cross-enforcer equality hook (01e §10.4 agreement clause; review-107 MAJOR-2 + cross-enforcer verdict). The
 *  estate runs TWO SSRF enforcers over different traffic — L4 squid (VM, resolved answers) and L3 urlpolicy (r94,
 *  host-side proxy fetch). They are complementary, not redundant, so a range present on one side and absent on the
 *  other is exactly the MAJOR-2 class of bug. This pins BOTH layers to the same twelve classes: for each class it
 *  checks the squid ACL token AND feeds a class representative through r94's `isDeniedAddress` (the predicate its
 *  resolve->check->pin transport uses), flagging an L3 gap or a squid/urlpolicy disagreement by name. Equality is
 *  machine-checked here, not aspirational. */
export function crossEnforcerAgreement(confText: string): BakeFinding[] {
  const findings: BakeFinding[] = []
  const squidDenies = destinationDenyTokens(confText) // renamed-ACL safe: keyed on dst TYPE + http_access deny linkage, not the old name
  for (const req of REQUIRED_DENY_RANGES) {
    const squidHas = squidDenies.has(req.cidr)
    const urlHas = isDeniedAddress(req.probe)
    if (!urlHas) {
      findings.push({
        code: "URLPOLICY_NOT_DENY",
        item: `${req.cidr} (${req.kind}) not denied by the L3 urlpolicy host-side pin`,
        hint: "r94 resolved-IP pinning posture (§13 / 01f_tool_wiring_spec.md §6.4): urlpolicy must deny every §10.4 class or the proxy's own host-side fetch leaks it (review-107 M2/M3)",
      })
    }
    if (squidHas !== urlHas) {
      findings.push({
        code: "CROSS_ENFORCER_DIVERGENCE",
        item: `${req.cidr} (${req.kind}): squid(L4)=${squidHas ? "deny" : "allow"} vs urlpolicy(L3)=${urlHas ? "deny" : "allow"} — enforcers must deny identical sets`,
        hint: "01e §10.4 cross-enforcer agreement clause: any range edit moves renderer + bake-verifier + urlpolicy in ONE change (this hook is where drift surfaces)",
      })
    }
  }
  return findings
}

/** Parse-and-assert the squid.conf over the CODE portion only (inline `#` comments stripped so a comment
 *  naming an IP can never satisfy a deny check). Returns every §10.4 violation as a named finding. */
export function auditSquidConf(confText: string): BakeFinding[] {
  const findings: BakeFinding[] = []
  const code = confText.split("\n").map((line) => line.split("#")[0] ?? "") // comment-stripped, order preserved

  // Deny tokens are collected NAME-AGNOSTICALLY from every dst-typed ACL that is actually denied via
  // http_access deny — so the audit follows row 85's rename away from the reserved `to_localhost`/`to_localnet`
  // (R112-1) without hardcoding the new name, and an unenforced dst ACL contributes nothing.
  const denyTokens = destinationDenyTokens(confText)
  const denied = deniedAclNames(code)
  const dstDeclNames = aclNamesByType(code, "dst")
  const dstdomainDeclNames = aclNamesByType(code, "dstdomain")
  const dstEnforced = dstDeclNames.some((n) => denied.has(n))
  const dstdomainEnforced = dstdomainDeclNames.some((n) => denied.has(n))

  for (const req of REQUIRED_DENY_RANGES) {
    if (!denyTokens.has(req.cidr))
      findings.push({
        code: "DENY_RANGE_MISSING",
        item: `${req.cidr} (${req.kind}) not present in a denied dst ACL`,
        hint: "§10.4 deny-list; a missing private/link-local/NAT64 range leaves an SSRF door open through the egress proxy",
      })
  }

  // Hostname forms (rebinding/`.local`) covered by a DENIED dstdomain ACL — matched by TYPE, not the reserved name
  // (H-R93-6 + R112-1: the render must not name the ACL `to_localhost`; the coverage class is what matters here).
  const hostnameTokens = dstdomainDeniedTokens(confText)
  const hostnameCovered = hostnameTokens.has("localhost") && hostnameTokens.has(".local")
  if (!hostnameCovered) {
    findings.push({
      code: "DENY_HOSTNAME_MISSING",
      item: "no denied dstdomain ACL covers both `localhost` and `.local`",
      hint: "§10.4 hostname form (CONNECT authority + absolute-URI host); dstdomain class per H-R93-6/R112-1 — declare it under a NON-reserved name and http_access deny it",
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
  if (dstDeclNames.length > 0 && !dstEnforced)
    findings.push({
      code: "DENY_NOT_ENFORCED",
      item: `destination ACL(s) [${dstDeclNames.join(", ")}] declared but no http_access deny references them`,
      hint: "an unenforced dst ACL filters nothing (10.4 deny-then-default-deny ordering)",
    })
  if (dstdomainDeclNames.length > 0 && !dstdomainEnforced)
    findings.push({
      code: "DENY_NOT_ENFORCED",
      item: `hostname ACL(s) [${dstdomainDeclNames.join(", ")}] declared but no http_access deny references them`,
      hint: "hostname-class SSRF is unprotected without it",
    })

  const denyAll = code.findIndex((c) => /^http_access\s+deny\s+all\s*$/.test(c))
  const destDenyNames = new Set([...dstDeclNames, ...dstdomainDeclNames])
  const firstDestDeny = code.findIndex((c) => /^http_access\s+deny\s+(\S+)/.test(c) && destDenyNames.has(c.match(/^http_access\s+deny\s+(\S+)/)?.[1] ?? ""))
  if (denyAll === -1)
    findings.push({
      code: "DEFAULT_DENY_MISSING",
      item: "no trailing http_access deny all",
      hint: "default-deny is the last line; without it anything unmatched is allowed (10.4)",
    })
  else if (firstDestDeny !== -1 && denyAll < firstDestDeny) {
    findings.push({
      code: "DEFAULT_DENY_MISORDERED",
      item: "http_access deny all appears BEFORE the destination-class denies",
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
    `firecrawl egress-proxy ${where}bake green — rendered conf matches the pinned digest, deny-list wired, hardening + no-cache present, boot-class directive shapes refused-clean`,
    { context: { imageRef: verdict.imageRef, confPath: verdict.confPath } },
  )
  return {
    token: OUTCOME.OK,
    message: `egress-proxy bake green: rendered squid.conf matches the locked pin (${verdict.imageRef}); SSRF deny-ranges present and wired; boot-class audit clean (no inline comment on http_port, a non-zero forward-proxy port equal to PC-PORT-06). OFFLINE GREEN IS NOT LIVE GREEN: nothing here proves squid binds that port or serves a CONNECT — pull, bind and per-target refusals stay rows 93/112 (see bakeProofLayers().liveOnly).`,
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

// --- boot-class parsers (shape of a directive line, NOT squid's lexer) ---------------------------------------

/** Split the argument remainder of a directive line into squid-shaped tokens: whitespace-separated runs where a
 *  double-quoted span is part of the SAME token (`name="edge proxy"` is one option to squid; splitting it at the
 *  space would invent a false SQUID_PORT_OPTION_UNPARSED on a legal config). */
function tokenizeDirectiveArgs(rest: string): string[] {
  return rest.match(/(?:[^\s"]|"[^"]*")+/g) ?? []
}

function unquote(token: string): string {
  return token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token
}

/** The port a squid port spec would register, or null when it registers none. Covers `PORT`, `ADDR:PORT` and
 *  `[V6ADDR]:PORT`. Zero and out-of-range are "no listener" on purpose: R112b-1's FATAL built its internal URL
 *  from port 0 (`squid-cache.log:204`), which is exactly the value this assertion must refuse. */
function portSpecValue(spec: string): number | null {
  const closingBracket = spec.lastIndexOf("]")
  const portPart =
    closingBracket >= 0
      ? spec.slice(closingBracket + 1).replace(/^:/, "")
      : spec.includes(":")
        ? spec.slice(spec.lastIndexOf(":") + 1)
        : spec
  if (!/^\d+$/.test(portPart)) return null
  const port = Number(portPart)
  return port > 0 && port <= 65535 ? port : null
}

/** A squid port option is a bare flag or a `key=value` / `key,value` pair, where the value may itself be a quoted
 *  span (`tproxy`, `speed=100kbit/s`, `name="edge proxy"`). Deliberately permissive — only shapes that cannot be
 *  options at all are refused (e.g. the `(unpublished;` fragment a half-stripped comment leaves behind), so a
 *  legitimate future option never fails this bake. */
const PORT_OPTION_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*([=,](?:"[^"]*"|\S)+)?$/

// --- renamed-ACL-safe ACL helpers (key on ACL TYPE + http_access deny linkage, never the custom name) ------

/** Comment-stripped code lines (a comment naming an IP or name must never satisfy an assertion). */
function strippedCode(confText: string): string[] {
  return confText.split("\n").map((line) => line.split("#")[0] ?? "")
}

/** Names positively referenced by `http_access deny <name>` (negated forms like `deny !SafePorts` are excluded —
 *  they reference a class as a condition, they are not the enforcement of a destination ACL). */
function deniedAclNames(code: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const c of code) {
    const m = c.match(/^http_access\s+deny\s+([A-Za-z_][\w.]*)/)
    if (m?.[1]) out.add(m[1])
  }
  return out
}

/** Names of every `acl <name> <type> ...` declaration of a given type (`dst`, `dstdomain`, …). */
function aclNamesByType(code: readonly string[], type: string): string[] {
  const re = new RegExp(`^acl\\s+(\\S+)\\s+${type}\\s+\\S`)
  return [...new Set(code.map((c) => c.match(re)?.[1]).filter((n): n is string => !!n))]
}

/** Union of CIDR tokens from dst-typed ACLs that are actually DENIED — the renamed-ACL-safe deny set. */
function destinationDenyTokens(confText: string): Set<string> {
  const code = strippedCode(confText)
  const denied = deniedAclNames(code)
  const out = new Set<string>()
  for (const c of code) {
    const m = c.match(/^acl\s+(\S+)\s+dst\s+(.+)$/)
    if (m?.[1] && m[2] && denied.has(m[1])) for (const tok of m[2].trim().split(/\s+/)) out.add(tok)
  }
  return out
}

/** Union of suffix tokens from dstdomain ACLs that are actually DENIED — the renamed hostname class. */
function dstdomainDeniedTokens(confText: string): Set<string> {
  const code = strippedCode(confText)
  const denied = deniedAclNames(code)
  const out = new Set<string>()
  for (const c of code) {
    const m = c.match(/^acl\s+(\S+)\s+dstdomain\s+(.+)$/)
    if (m?.[1] && m[2] && denied.has(m[1])) for (const tok of m[2].trim().split(/\s+/)) out.add(tok)
  }
  return out
}
