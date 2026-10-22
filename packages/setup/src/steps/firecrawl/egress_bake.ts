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
//       (cap_drop ALL, no-new-privileges, memswap_limit == mem_limit) plus ports-only-80/443, the CONNECT
//       tunnel-port class equal to the approved {80,443} (gate 239 option 2 — see APPROVED_TUNNEL_PORTS), and no-cache.
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
//   (7) THE INJECTED-ANSWER AUDIT (gate 239 fork A / 01e §4.5 as narrowed by row 241, audited by row 242). The lint no
//       longer bans the `extra_hosts` key BY NAME — it screens entries — so an out-of-band or hand-edited compose can
//       now carry a key the render never emits. `auditExtraHostPins` therefore re-screens EVERY entry in the artefact
//       this bake already refuses to bless: a pair that points the contained tier at the host (EXTRA_HOST_AT_HOST: a
//       denied name class, or the `host-gateway` sentinel docker substitutes with the host address), a value inside
//       one of the twelve denied classes (EXTRA_HOST_DENIED_VALUE), or a pair that is not one lowercase dotted FQDN
//       mapped to one canonical public unicast IPv4 literal (EXTRA_HOST_SHAPE_INVALID, the leg that also refuses IPv6,
//       withheld by producer-spec §1.2). It deliberately does NOT call `composefiles/dns_pins.ts`'s screen: an audit
//       that asks the renderer whether the renderer was right inherits every hole the renderer later grows (the same
//       reason the boot-class rule keeps its own narrow list — see the "(cross-layer pin)" describe in the suite). The
//       twelve classes themselves are NOT re-listed here; they are read from r94's shipped urlpolicy predicates, which
//       §10.4's cross-enforcer clause requires both layers to share.
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
// Row 267 (F-251-1): the mode audit covers the two user-editable setup files the estate consumes, and it asks
// THEM where they live rather than re-spelling either path. PC-PATH-18's resolver has one home (lanes.ts:54)
// and PC-PATH-19's another (dns_pins.ts:43) — the single-resolver rule both files state as their reason — so
// an audit that hardcoded `~/.swarm/setup/lanes.json` would be a fourth home of a path and could drift from
// the very writer it exists to double-check. Path resolution is not a policy screen: reusing it breaks none of
// the independence stated in header item (7), which is about RULEBOOKS, not about filenames.
import { lanesPath } from "../../composefiles/lanes.ts"
import { dnsPinsPath } from "../../composefiles/dns_pins.ts"
// r94's host-side url policy (L3 enforcer). PURE module (zero imports of its own), so this adds no runtime
// dependency to the setup binary beyond the deny predicate itself; read-only import — row 92 never edits r94's
// file. `isDeniedAddress` is the exact predicate r94's checkResolvedAddresses feeds the resolved-IP pin through
// (§13 / 01f_tool_wiring_spec.md §6.4), which is what makes it the right handle for the cross-enforcer equality check.
// Row 242 adds the two neighbours of that same predicate — `checkResolvedAddresses` (the name+address screen the P3
// extra_hosts audit asks about each leg) and `isIpLiteral` (the "a name that IS an answer" leg) — because §10.4's
// cross-enforcer clause forbids a second address list: the twelve classes are asked of THIS module everywhere, never
// re-spelled in the audit. Nothing here edits it; its own suite is the contract.
import { checkResolvedAddresses, isDeniedAddress, isIpLiteral } from "../../mcpproxy/urlpolicy.ts"

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

/** The port class a CONNECT tunnel may open — the ONLY ports gate 239 option 2 admitted, transcribed from
 *  01e §10.4's r11 amendment (`acl swarm_tunnel_ports port 80 443`) and its surviving-invariant bullet. These are
 *  policy literals in the same class as REQUIRED_DENY_RANGES (spec-transcribed requirements, not register values —
 *  PC_PORTS carries the estate's own listen ports and is imported for those). The audit compares the SET a rendered
 *  conf negates against this list exactly: narrower than this re-adds the refusal that made plain-HTTP scraping
 *  impossible (R112d-1), wider than this exceeds what the user approved (forks B/F of `decisions/decisions.md:299-305`). */
export const APPROVED_TUNNEL_PORTS: readonly number[] = [80, 443]

/** The two port classes gate 239 option 2 explicitly did NOT touch, kept as their own constants so nobody "shares"
 *  them with the tunnel class by coincidence: `acl SafePorts port 80 443` (+ `http_access deny !SafePorts`) governs
 *  the non-tunnel methods, and `acl SSL_ports port 443` stays declared "so any other reader of `SSL_ports` is
 *  unaffected" (01e §10.4's r11 bullet, quoting research/s6_12_tunnel_options_costed.md §4's invariant). Both are
 *  policy literals like REQUIRED_DENY_RANGES, not register values: PC_PORTS carries the estate's own listen ports. */
export const NON_TUNNEL_PORTS: readonly number[] = [80, 443]
export const TLS_ONLY_PORTS: readonly number[] = [443]

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

/** The service whose attachment gate 239 counted as survivor 3 of 3 — the browser carrier. Named once so the
 *  audit below and its tests cite one spelling rather than each carrying their own literal. */
export const BROWSER_TIER_SERVICE = "playwright-service"

/** The networks the browser carrier may attach to. Transcribed from the render's own instruction
 *  (`firecrawl_compose.ts:350`: "NEVER fc-web, NEVER fc-edge/fc-data (§6.7)") and asserted over parsed YAML by
 *  row 244's lane (`egress_tunnel_units.test.ts`, "(r244 survivor-3)"); this constant moves that claim down to the
 *  delivered bytes. Deliberately a SUBSET test, not an equality: dropping one of the two would be a functional
 *  regression for the vendor pre-check to notice, not a containment leak for this audit to refuse. */
export const BROWSER_TIER_NETWORKS: readonly string[] = ["fc-ctl", "fc-iso"]

/** Every network of this stack that is NOT `internal: true`, with the EXACT set of services allowed on it —
 *  transcribed from the five-tier segmentation the renderer itself states (`firecrawl_compose.ts:99-115`):
 *  fc-edge carries the one published face (auth-proxy), fc-web carries the one internet-capable member
 *  (egress-proxy). Two consequences fall out, both intended: a service not named here may attach nothing but
 *  internal networks, and a non-internal network absent from this map has no approved member at all, so ANY
 *  service attaching it refuses. New public segments therefore fail closed instead of needing list upkeep. */
export const APPROVED_PUBLIC_NETWORK_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  "fc-edge": ["auth-proxy"],
  "fc-web": ["egress-proxy"],
}

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
  | "EXTRA_HOST_AT_HOST"
  | "EXTRA_HOST_DENIED_VALUE"
  | "EXTRA_HOST_SHAPE_INVALID"
  // Row 267 F-251-8: the internal-only browser attachment (gate 239 survivor 3) had no offline instrument at all —
  // four mutations of it left `lintOk=true` with zero bake findings (verification/s6b_13_lanes_security.md §2.3).
  // These three codes move the claims row 244 made about parsed YAML down to the bytes on disk.
  | "BROWSER_TIER_MISATTACHED"
  | "NETWORK_NOT_INTERNAL"
  | "PUBLIC_NETWORK_MEMBER_DRIFT"
  // Row 270 (F-265-1/F-265-2): the membership and extra-hosts audits now parse the artefact with Bun.YAML — the
  // engine the estate-side instruments resolve with — so a text that engine refuses has no offline reading at
  // all, and an audit that cannot read its subject must say so rather than stay silent. Fail-closed by design:
  // docker-valid/Bun-invalid YAML would false-refuse here, and a gate false-refusing is the safe half of an
  // unresolved parser-equivalence question (verification/s6b_13b_lanes_security_delta.md §9.2).
  | "COMPOSE_YAML_UNPARSEABLE"
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
  // Row 267 F-251-1: PC-PATH-18/19 were invisible to this audit (measured empty against a control that fires
  // MODE_SECRET_FILE), so a widened user-editable file reached container configuration with no offline witness.
  | "MODE_LANES_FILE"
  | "MODE_DNS_PINS_FILE"
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

  // (P3 injected answers, gate 239 fork A / row 242) the narrowed lint screens entries at RENDER time and no longer
  // bans the key by name, so the artefact is where a hostile or out-of-band `extra_hosts` becomes visible. This audit
  // reads the composed text, not dns_pins' screen — see header item (7) for why the two rulebooks stay separate.
  findings.push(...auditExtraHostPins(composeText))
  // (F-251-8, row 267) the internal-only browser attachment, moved from row 244's parsed-YAML assertions down to the
  // delivered bytes. It sits here rather than in lint.ts for the reason row 251 §2.3 gives: bring-up consumes the
  // artefact and never re-renders, so the bake is the only offline instrument that sees what the estate will run.
  findings.push(...auditNetworkMembership(composeText))
  findings.push(...auditSquidConf(confText))
  // (renamed-ACL safe) reserved-name collision: redeclaring a squid-predefined ACL name is a boot FATAL (R112-1).
  findings.push(...assertNoReservedAclNames(confText))
  // (cross-enforcer) L3 urlpolicy ⇄ L4 squid must deny the IDENTICAL set, each a superset of the twelve.
  findings.push(...crossEnforcerAgreement(confText))
  // (R112b-5 BOOT-CLASS) presence/parse-level layers above are all blind to a config that parses but registers no
  // forward-proxy port, so this refusal runs too — R112b-1's shape must fail the bake, not reach the VM.
  findings.push(...auditBootClass(confText))
  // (R112-5) file-mode posture is a DISK fact: only asserted when the artefacts were read from a real tools root
  // (production/row-93 posture). In-memory mismatch tests pass texts directly and skip this by design. Row 267
  // hands the same home to the PC-PATH-18/19 leg, because those two files live beside the estate, not under it.
  if (opts.confText === undefined && opts.composeText === undefined && opts.home !== undefined) {
    findings.push(...auditFileModes(root, composeText, opts.home))
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
      "the CONNECT-method deny negates a port class equal to the approved tunnel set {80, 443}, and the two classes gate 239 did not touch are still declared exactly as §10.4 words them — SafePorts {80, 443} with `deny !SafePorts`, SSL_ports {443} (auditSquidConf port guard; gate 239 option 2 rendered by row 241, audit moved in lockstep by row 242)",
      "every extra_hosts entry present in the artefact aims at a public name and a canonical public unicast IPv4 answer — no host-pointing leg, no twelve-class value (auditExtraHostPins; §4.5 as narrowed by gate 239 fork A)",
      "the segmentation of the firecrawl artefact matches the approved topology: the browser carrier holds only fc-ctl/fc-iso, every other tier sits on an internal network, and fc-edge/fc-web carry exactly their one approved member each (auditNetworkMembership; gate 239 survivor 3, added by row 267 under F-251-8 — the firecrawl compose only, since this bake never reads searxng.yml)",
      "no ACL redeclares a squid-predefined name (assertNoReservedAclNames; R112-1 closed live by r85-fix5)",
      "secret dir/file modes, executable /docker-entrypoint.d wraps, and the 0600 posture of PC-PATH-18 lanes.json / PC-PATH-19 dns-pins.json over a real tools root and home (auditFileModes; R112-5, with the two user-editable paths added by row 267 under F-251-1)",
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
      "TUNNEL-FORM containment after gate 239's widening: that a private target reached as `CONNECT 127.0.0.1:80` still leaves a TCP_DENIED line naming it (§10.6 items 3 and 8 in CONNECT form, incl. the `127.0.0.1.nip.io` / `192.168.5.3.nip.io` fixtures of RC-234-2). The offline audit proves the port CLASS and the twelve dst ACLs; it cannot see squid evaluating its own CONNECT-time answer, and it stays blind to the two dstdomain classes losing their bite inside a tunnel — Loss 2, whose only instrument is row 255's battery ('Why the audit passing is not proof', research/s6_12_tunnel_options_costed.md §4).",
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

/** File-mode posture (R112-5, security-bearing). Three contracts, all real FS facts asserted only over a rendered
 *  tools root: (a) D-04 secret hygiene — the firecrawl secrets dir 0700 and every secret file 0600; (b) R112-5's
 *  silent-auth-bypass class — a host file mounted under a container `/docker-entrypoint.d/` target MUST be
 *  executable, because the official nginx entrypoint IGNORES non-executable `.sh` there (`Ignoring … not
 *  executable`), so a 0644 wrap never runs envsubst and the bearer token silently ships empty. Absent secrets/files
 *  are NOT failed here — secret generation is the owning step's job (D-22); this asserts the SHAPE of what exists.
 *
 *  (c) Row 267 (F-251-1): the two user-editable files that BECOME container configuration — PC-PATH-18 lanes.json
 *  and PC-PATH-19 dns-pins.json. Neither was visible to this audit before (measured: a widened lanes.json produced
 *  zero findings from the same instrument that flags a 0644 secret file), so the estate's own auditor agreed with
 *  whatever the filesystem permitted. Their paths come from the writers' own resolvers, imported above.
 *
 *  WHY THE PREDICATE IS `mode & 0o077` AND NOT `mode !== 0600` here while the secret leg above uses strict
 *  equality: this audit runs on the bring-up path AFTER `createLanesFileAtSetup` has had its turn, and that writer
 *  tightens only what carries a group or other bit (lanes.ts, F-251-1 note). Refusing a NARROWER file (0400 leaks
 *  nothing) would therefore refuse a state no shipped writer will repair — a deadlock with no owner. Secret files
 *  have no such hand-edited posture to respect: their owning step writes them 0600 or does not write them at all,
 *  so strict equality is both safe and correct there. */
export function auditFileModes(toolsRoot: string, composeText: string, setupHome?: string): BakeFinding[] {
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

  // (c) Row 267 F-251-1 — the user-editable path into container configuration. Asserted only when a home was
  // handed in, exactly as the secret leg is asserted only over a real tools root: an in-memory mismatch test has
  // no disk to speak about. Absent files stay absent-and-silent (both are optional by design: no lanes file means
  // the byte-identical default render, no pins file means no extra_hosts), and an existing one must be private.
  if (setupHome !== undefined) {
    const legs: readonly { readonly path: string; readonly code: BakeCode; readonly register: string }[] = [
      { path: lanesPath(setupHome), code: "MODE_LANES_FILE", register: "PC-PATH-18" },
      { path: dnsPinsPath(setupHome), code: "MODE_DNS_PINS_FILE", register: "PC-PATH-19" },
    ]
    for (const leg of legs) {
      if (!existsSync(leg.path)) continue
      const m = statSync(leg.path).mode & 0o777
      if ((m & 0o077) === 0) continue
      findings.push({
        code: leg.code,
        item: `${leg.path} mode ${m.toString(8)} (want ${MODES.FILE_0600.toString(8)}): group or other bits are set on ${leg.register}`,
        hint: `${leg.register} is read straight into container configuration (lane values reach a service environment; pins reach extra_hosts) and its register posture is 0600 inside the 0700 setup dir. The configure-time writer tightens this file (lanes.ts createLanesFileAtSetup); this finding is the second witness for the case it cannot cover — a widening that lands after the last install, or on a path whose writer never ran.`,
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

  // Ports-only-80/443 + CONNECT restricted to the APPROVED tunnel-port class (10.4 bullet 1, as amended by gate 239
  // option 2: `acl swarm_tunnel_ports port 80 443` declared beside an UNTOUCHED `acl SSL_ports port 443`, with the one
  // `http_access deny Connector` line re-pointed at it). Row 242's lockstep duty is to move this guard with that render
  // without relaxing it, so it keys on STRUCTURE exactly like the destination audit above keys on TYPE: the line must be
  // `http_access deny <ACL declaring method CONNECT> !<port-class ACL>` and the negated class's port SET must equal
  // APPROVED_TUNNEL_PORTS. Name-agnostic only in the direction row 241 moved — a substituted ACL name still has to
  // resolve to a real port declaration — and strict everywhere else: the finding names which leg failed. Accepting the
  // pre-gate `!SSL_ports` form as well was considered and REJECTED: an audit that admits both cannot tell whether the
  // approved class was ever rendered, which is the "agrees with whatever the renderer emitted last week" failure the
  // lockstep clause exists to prevent (01e §10.4 "The lockstep duty, named for row 242"; 05 §5 trap T-6).
  const portClasses = portAclClasses(code)
  const tunnelTerm = connectorTunnelTerm(code)
  const tunnelPorts: number[] | null = tunnelTerm === undefined ? null : portClasses.get(tunnelTerm) ?? null
  // The two named classes gate 239 left untouched are resolved through the SAME port parser rather than matched as
  // substrings: `acl SafePorts port 80 443` and `acl SSL_ports port 443` stay exactly as §10.4 words them, and a
  // deleted or widened declaration refuses here even though nothing else in the file mentions them any more. The old
  // guard got that coverage for free — its literal `deny Connector !SSL_ports` mentioned SSL_ports — so when row 241
  // moved the reference to the tunnel class, a substring matcher would have LOSED it silently.
  const safePortsClass: number[] | null = portClasses.get("SafePorts") ?? null
  const sslPortsClass: number[] | null = portClasses.get("SSL_ports") ?? null
  const denyUnsafe = code.some((c) => /^http_access\s+deny\s+!SafePorts\s*$/.test(c))
  // The tunnel leg stays separate from the boolean conjunction so the refusal can say WHY it fired; a guard whose
  // message is a generic "incomplete" cannot be told apart from a guard that was never reached.
  const tunnelProblem =
    tunnelTerm === undefined
      ? "no `http_access deny <CONNECT-method-ACL> !<port-ACL>` line at all"
      : tunnelPorts === null
        ? `the CONNECT deny negates "${tunnelTerm}", which is not a plain-integer port-class ACL declaration`
        : !samePortSet(tunnelPorts, APPROVED_TUNNEL_PORTS)
          ? `the CONNECT deny class "${tunnelTerm}" carries [${tunnelPorts.join(", ")}], not the approved {${APPROVED_TUNNEL_PORTS.join(", ")}}`
          : null
  const unsafePortLegs = [
    safePortsClass === null
      ? "no plain-integer `acl SafePorts port …` declaration"
      : !samePortSet(safePortsClass, NON_TUNNEL_PORTS)
        ? `SafePorts carries [${safePortsClass.join(", ")}], not {${NON_TUNNEL_PORTS.join(", ")}}`
        : null,
    sslPortsClass === null
      ? "no plain-integer `acl SSL_ports port …` declaration (§10.4: SSL_ports stays declared and unchanged)"
      : !samePortSet(sslPortsClass, TLS_ONLY_PORTS)
        ? `SSL_ports carries [${sslPortsClass.join(", ")}], not {${TLS_ONLY_PORTS.join(", ")}}`
        : null,
    denyUnsafe ? null : "no `http_access deny !SafePorts`",
    tunnelProblem,
  ].filter((leg): leg is string => leg !== null)
  if (unsafePortLegs.length > 0) {
    findings.push({
      code: "PORT_FILTER_MISSING",
      item: `ports-80/443-only guard incomplete: ${unsafePortLegs.join("; ")}`,
      hint: "10.4 bullet 1 as amended by gate 239 option 2: `acl SafePorts port 80 443` + `deny !SafePorts` and `acl SSL_ports port 443` stay exactly as they were, and the CONNECT-method deny must negate a port ACL whose set is exactly the approved tunnel class (rendered today as `acl swarm_tunnel_ports port 80 443`, row 241). Renaming or dropping that ACL is refused here, not silently accepted.",
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

/** Audit of the P3 injected answers over the RENDERED compose artefact (gate 239 fork A narrowed 01e §4.5 to "no entry
 *  may point at the host"; audited by this row under §10.4's lockstep duty). WHY THE BAKE CARRIES THIS AT ALL: row 241
 *  replaced a blanket ban on the KEY NAME with a screen over ENTRIES, so a compose text can now legitimately carry
 *  `extra_hosts:` — and, because bring-up consumes the artefact and never re-renders, can also carry entries the
 *  render never produced (an out-of-band edit, a restored file, a harness slip). With the name-ban gone the screens that
 *  remain are the lint at render time and this audit at bake time; this one is the last offline stop before the stack is
 *  brought up, and it is deliberately NOT a call into `composefiles/dns_pins.ts` (header item (7)).
 *
 *  THREE CODES, ONE PER HARM CLASS, each proven by mutation in test/egress_bake.test.ts:
 *   - EXTRA_HOST_AT_HOST — the pair aims the contained tier at the host: the name is in a denied name class
 *     (host.docker.internal / localhost / *.local / *.internal / *.localhost / metadata.google.internal, via the shipped
 *     urlpolicy predicate) or the value is `host-gateway`, the sentinel docker substitutes with the host's gateway
 *     address, or a denied host NAME. This is the exact door §4.5 prohibits, so it is refused whatever the value says.
 *   - EXTRA_HOST_DENIED_VALUE — the value is an address inside one of the twelve §10.4 classes (loopback, RFC1918,
 *     link-local incl. cloud metadata, CGNAT, this-network, the four IPv6 locals, NAT64) — asked of r94's shipped
 *     `isDeniedAddress`, NOT re-listed here, which is what keeps the two enforcers one list instead of two.
 *   - EXTRA_HOST_SHAPE_INVALID — the pair is not "one lowercase dotted FQDN mapped to one canonical public unicast
 *     IPv4 literal": malformed entry, undotted name (docker's embedded DNS answers service short-names, so a pin named
 *     `redis` is a stack-internal redirect), uppercase, an IP literal used as a name, an IPv6 value (withheld by design,
 *     producer spec §1.2), a multicast/reserved answer ≥224 (which the twelve CIDRs do not cover), or a non-canonical
 *     numeric form (leading-zero/octal/hex). Only this third leg restates a positive shape the renderer also checks;
 *     the suite pins the two screens against each other in both directions so a drift is a red test, not a quiet hole. */
export function auditExtraHostPins(composeText: string): BakeFinding[] {
  const findings: BakeFinding[] = []
  const parsed = parseComposeDocument(composeText)
  if (!parsed.ok) {
    findings.push({
      code: "COMPOSE_YAML_UNPARSEABLE",
      item: `extra-hosts audit: ${parsed.message}`,
      hint: "row 270 (F-265-2): this audit reads the artefact through Bun.YAML, the engine the estate-side instruments resolve these bytes with. A text that engine refuses has no offline reading of its entries, and an audit that cannot read its subject refuses rather than staying silent — the fail-closed half of the unresolved dockerd-vs-Bun parse-equivalence question (verification/s6b_13b_lanes_security_delta.md §9.2).",
    })
    return findings
  }
  for (const entry of extraHostEntries(parsed.doc)) {
    const where = `${entry.service === "" ? "(no service block)" : entry.service}: extra_hosts entry "${entry.raw}"`
    // Split at the FIRST colon: the pair is `name:address`, a name never carries a colon, and an IPv6 address carries
    // several — splitting at the last one would hand the screens a truncated name and a one-character value.
    const sep = entry.raw.indexOf(":")
    if (sep <= 0 || sep === entry.raw.length - 1) {
      findings.push({
        code: "EXTRA_HOST_SHAPE_INVALID",
        item: `${where} is not a single "hostname:address" pair`,
        hint: "01e §4.5 statement 1 as amended: one dotted FQDN to one address literal — a pair this file cannot parse is not the shape the gate approved",
      })
      continue
    }
    const hostname = entry.raw.slice(0, sep)
    const value = entry.raw.slice(sep + 1)
    const nameVerdict = checkResolvedAddresses([hostname])
    if (nameVerdict === "host_denied_name")
      findings.push({
        code: "EXTRA_HOST_AT_HOST",
        item: `${where} names a denied host class ("${hostname}") — the contained tier would learn to dial the host`,
        hint: "§4.5 as narrowed by gate 239 fork A still prohibits exactly this: 'no entry may point at the host'. The NAME screen survives the narrowing (urlpolicy DENIED_EXACT/DENIED_SUFFIXES, reused not re-listed).",
      })
    else if (!dottedFqdnShape(hostname) || isIpLiteral(hostname))
      findings.push({
        code: "EXTRA_HOST_SHAPE_INVALID",
        item: `${where} has a name that is not a lowercase dotted FQDN ("${hostname}")`,
        hint: "an undotted short-name shadows docker's own service DNS (producer §5/row 241 containment note), an IP literal in the name slot maps answers to answers, and a name the render could not have emitted is tampering either way",
      })

    if (value.trim().toLowerCase() === "host-gateway")
      findings.push({
        code: "EXTRA_HOST_AT_HOST",
        item: `${where} uses the "host-gateway" sentinel — docker substitutes the HOST address for it`,
        hint: "the §4.5 door in its own spelling: this is how a pin routes fc-ctl/fc-iso traffic at the host without naming it (01e §4.5 prohibited-keys text, preserved by gate 239's narrowing)",
      })
    else {
      const valueVerdict = checkResolvedAddresses([value])
      if (valueVerdict === "host_denied_name")
        findings.push({
          code: "EXTRA_HOST_AT_HOST",
          item: `${where} carries the denied host name "${value}" as its answer`,
          hint: "an /etc/hosts line whose address slot is a name is not an answer, and this one names the host class",
        })
      else if (valueVerdict === "address_denied")
        findings.push({
          code: "EXTRA_HOST_DENIED_VALUE",
          item: `${where} pins a §10.4 denied-class address ("${value}")`,
          hint: "the twelve classes are asked of r94's shipped urlpolicy predicate (isDeniedAddress behind checkResolvedAddresses) — a private/loopback/link-local/CGNAT/NAT64 answer injected here gives the contained tier a route the filter exists to refuse, and it is the class the narrowing must never have admitted",
        })
      else if (!canonicalPublicUnicastV4(value))
        findings.push({
          code: "EXTRA_HOST_SHAPE_INVALID",
          item: `${where} has a value that is not a canonical public unicast IPv4 literal ("${value}")`,
          hint: "§4.5 statement 1 + producer spec §1.2/§3.3: IPv6 is withheld (the guest has no live v6 route), multicast/reserved ≥224 is non-unicast and slips past the twelve CIDRs, and non-canonical numeric forms (leading zero, octal, hex) are drift or tampering, never an answer the producer wrote",
        })
    }
  }
  return findings
}

/** Network-membership audit (row 267, F-251-8 / gate 239 survivor 3). WHY THE BAKE OWNS THIS AND NOT THE LINT:
 *  lint runs over bytes the renderer just produced, so it can only ever re-state what the renderer intended; the
 *  estate consumes the ARTEFACT, and rows 246/263 write those artefacts to disk without any re-render at bring-up
 *  (stacklib.ts:497 "never re-renders"). That gap is exactly why `auditFileModes` and `auditExtraHostPins` exist
 *  (row 251 §2.3's argument, quoted at implementation/s6_r242_audit_lockstep.md §4), and network membership has
 *  the same shape: before this rule the property had one live witness (row 255's item-6 raw-egress kill test) and
 *  no offline one — four mutations of it left `lintOk=true` with zero bake findings while the same instruments bit
 *  on four extra-hosts poisons, which is a coverage statement, not a complaint.
 *
 *  THREE CLAIMS, one per code, each proven by an isolating mutation in test/egress_bake.test.ts:
 *   - BROWSER_TIER_MISATTACHED — the browser carrier attaches anything outside {fc-ctl, fc-iso}. fc-web is the
 *     internet-capable segment, so this is the direct "the browser reaches the world" case RC-244-1 named.
 *   - NETWORK_NOT_INTERNAL — any other service attaches a network that is not declared `internal: true`, including
 *     a network no top-level block declares (docker would create that one non-internal on first use, which is the
 *     quieter half of the same hole).
 *   - PUBLIC_NETWORK_MEMBER_DRIFT — a non-internal network's member set differs from the approved set in either
 *     direction: an added member gains a public face, a removed one silently changes who can route (and would
 *     leave the surviving members' own claims unbacked). */
export function auditNetworkMembership(composeText: string): BakeFinding[] {
  const findings: BakeFinding[] = []
  const parsed = parseComposeDocument(composeText)
  if (!parsed.ok) {
    findings.push({
      code: "COMPOSE_YAML_UNPARSEABLE",
      item: `network-membership audit: ${parsed.message}`,
      hint: "row 270 (F-265-1): survivor 3's offline witness reads the artefact through Bun.YAML after row 265 measured its line parser blind to a flow-style body and a merge-key attachment. A text that engine refuses has no offline reading of its membership; refusing on a parse failure is the fail-closed half of the unresolved dockerd-vs-Bun equivalence question (verification/s6b_13b_lanes_security_delta.md §9.2).",
    })
    return findings
  }
  const topo = parseNetworkTopology(parsed.doc)

  // (i) the browser carrier stays inside its internal segments
  const beyond = topo.attachments
    .filter((a) => a.service === BROWSER_TIER_SERVICE && !BROWSER_TIER_NETWORKS.includes(a.network))
    .map((a) => a.network)
  if (beyond.length > 0)
    findings.push({
      code: "BROWSER_TIER_MISATTACHED",
      item: `${BROWSER_TIER_SERVICE} attaches [${[...new Set(beyond)].join(", ")}] — the browser tier may hold only ${BROWSER_TIER_NETWORKS.join(", ")}`,
      hint: "gate 239 survivor 3 of 3 (01e §6.7/§10.2): the playwright carrier is contained by attaching to internal segments only. fc-web is the internet-capable tier and fc-edge is the published face; membership of either hands the browser a route around egress-proxy, which is the whole F-3 leak class this stack exists to close. Live witness stays row 255's item-6 kill test — offline green is not live green.",
    })

  // (ii) every other attachment must sit on an internal network
  for (const a of topo.attachments) {
    if (APPROVED_PUBLIC_NETWORK_MEMBERS[a.network]?.includes(a.service)) continue
    const internal = topo.defined.get(a.network)
    if (internal === true) continue
    const reason =
      internal === undefined
        ? `"${a.network}" is not declared in the top-level networks: block — docker would create it on demand, non-internal`
        : `"${a.network}" is declared without internal: true`
    findings.push({
      code: "NETWORK_NOT_INTERNAL",
      item: `${a.service} attaches ${reason}`,
      hint: "only the two services named in APPROVED_PUBLIC_NETWORK_MEMBERS may hold a non-internal face (auth-proxy on fc-edge as the published entry, egress-proxy on fc-web as the sole internet-capable member). Every other tier is contained by the internal flag — U-7 measured that all-internal attachments mean no default route, so containment here is a property of the network, not of a gateway the render could forget to omit.",
    })
  }

  // (iii) each public network's member set is exactly the approved one
  for (const [network, approved] of Object.entries(APPROVED_PUBLIC_NETWORK_MEMBERS)) {
    const members = [...new Set(topo.attachments.filter((a) => a.network === network).map((a) => a.service))]
    const missing = approved.filter((s) => !members.includes(s))
    const extra = members.filter((s) => !(approved as readonly string[]).includes(s))
    if (missing.length === 0 && extra.length === 0) continue
    const how =
      extra.length > 0 && missing.length > 0
        ? `carries [${extra.join(", ")}] and lacks [${missing.join(", ")}]`
        : extra.length > 0
          ? `carries an unapproved member [${extra.join(", ")}]`
          : `is missing its approved member [${missing.join(", ")}]`
    findings.push({
      code: "PUBLIC_NETWORK_MEMBER_DRIFT",
      item: `${network} ${how}; the approved set is {${approved.join(", ")}}`,
      hint: "the trust boundary of this stack is stated as two singleton memberships (01e §6.1/§10.4): fc-edge answers the ONLY publish and fc-web has EXACTLY ONE internet-capable member. An added member widens a public face; a removed one means the remaining tiers' containment claims were never backed by the render you are looking at.",
    })
  }

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

// --- port-class parsers (row 242's lockstep move: find the CONNECT guard by STRUCTURE, then judge its SET) ------

/** Every `acl <name> port <tokens...>` declaration resolved to its port numbers, keyed by the ACL name the render
 *  chose. Same-name lines UNION, which is what squid does with same-type redeclarations (the shipped dstdomain pair
 *  relies on the same behaviour). A class carrying any token that is not a plain in-range integer — a range
 *  (`1024-65535`), a service name (`HTTP`), a half-stripped comment fragment — maps to null so the caller REFUSES
 *  rather than guesses at what such a class admits. */
function portAclClasses(code: readonly string[]): Map<string, number[] | null> {
  const out = new Map<string, number[] | null>()
  for (const c of code) {
    const m = c.match(/^acl\s+(\S+)\s+port\s+(.+)$/)
    if (!m?.[1] || !m[2]) continue
    const once = out.get(m[1])
    const merged = once === null ? null : [...(once ?? [])]
    let unparseable = false
    for (const tok of m[2].trim().split(/\s+/)) {
      const v = /^\d+$/.test(tok) ? Number(tok) : Number.NaN
      if (!Number.isInteger(v) || v < 1 || v > 65535) {
        unparseable = true
        break
      }
      merged?.push(v)
    }
    // Once a class is poisoned by ANY line it stays poisoned: an unparseable token must not be dropped in favour of
    // the numbers that did parse, or `port 80 443 1024-65535` would read as the approved {80,443} plus a wildcard.
    if (merged === null || unparseable) out.set(m[1], null)
    else out.set(m[1], merged)
  }
  return out
}

/** The negated term of the CONNECT-method deny line, or undefined when the conf carries no such line. Resolved by
 *  structure: an `http_access deny <a> !<b>` line where <a> is declared as an `acl <a> method ...` listing CONNECT.
 *  This is how the audit follows row 241's substitution WITHOUT learning the replacement name in advance, and it stays
 *  a refusal in the two shapes that matter: no such line at all (tunnels unrestricted by omission), and a line whose
 *  negated name resolves to no port declaration (a substituted or deleted ACL — the exact corruption class §10.4's
 *  lockstep duty names). A bare `http_access deny Connector` is deliberately NOT matched either: denying every tunnel
 *  is not the approved policy, and gate 239 answered fork B that plain-HTTP scraping is a required capability. */
function connectorTunnelTerm(code: readonly string[]): string | undefined {
  const connectAcls = new Set(
    code.flatMap((c) => {
      const m = c.match(/^acl\s+(\S+)\s+method\s+(.+)$/)
      return m?.[1] && (m[2] ?? "").trim().split(/\s+/).includes("CONNECT") ? [m[1]] : []
    }),
  )
  if (connectAcls.size === 0) return undefined
  for (const c of code) {
    const m = c.match(/^http_access\s+deny\s+(\S+)\s+!(\S+)\s*$/)
    if (m?.[1] && m[2] && connectAcls.has(m[1])) return m[2]
  }
  return undefined
}

/** Port-set equality with duplicates collapsed and order ignored — the approved class is a SET, so a reordered or
 *  duplicated line is the same policy while a widened or narrowed one is a different one. */
function samePortSet(a: readonly number[], b: readonly number[]): boolean {
  const xs = [...new Set(a)].sort((p, q) => p - q)
  const ys = [...new Set(b)].sort((p, q) => p - q)
  return xs.length === ys.length && xs.every((v, i) => v === ys[i])
}

// --- compose document parsing shared by the entry-content audits (row 270, F-265-1/F-265-2) ----------------------
//
// WHY AN ENGINE AND NOT A LINE READER: the two audits below used to derive their facts with a line-and-indent
// state machine. Row 265 measured what that costs — a one-line flow-style service body and a mapping-form
// attachment carrying a merge key are both docker-valid YAML the line reader never sees as an attachment at
// all, and in the merge-key case the WHOLE `verifyEgressBake` returned ok=true while `Bun.YAML` handed the
// browser carrier `fc-web` (verification/s6b_13b_lanes_security_delta.md §2); the older extra-hosts audit had
// the identical blind spot for mapping-form entries (§2's twin, pre-existing). Two guards parsing one document
// two ways is how the next bypass is born, so both now parse the artefact with `Bun.YAML` — the engine the
// estate-side instruments resolve these same bytes with — and see every shape that engine can hand onward,
// merge keys already resolved. A parse THROW is reported as COMPOSE_YAML_UNPARSEABLE rather than swallowed:
// an audit that could not read its subject refuses instead of staying silent. A file that parses to nothing
// (empty or comment-only) is NOT a throw — it is a compose with no services and no networks, which the
// membership claims already refuse loudly through the missing approved members.

/** Parse the delivered artefact once, for whichever entry-content audits run over it.
 *  WHY THE ACCESSOR IS TYPED BY HAND: packages/setup declares its own minimal BunNamespace
 *  (types/bun-net.d.ts:142, merged by node-step.d.ts:45) and that declaration has no YAML member — the runtime
 *  does (bun 1.3.14, rule E5; rows 251/265's instruments resolve these very bytes with it), but the declared
 *  compiler only sees the declaration, so a bare `Bun.YAML` here would fail `bun run typecheck`. Widening the
 *  shared d.ts is outside this row's write set (routed as R-270-2); until then this narrow accessor carries
 *  the dependency honestly, and a runtime WITHOUT Bun.YAML fails closed: every artefact reads as unparseable
 *  and bring-up stops, which is the direction a containment gate takes an unavailable instrument. */
const composeYamlParser: { parse(text: string): unknown } | undefined = (Bun as unknown as { YAML?: { parse(text: string): unknown } }).YAML

function parseComposeDocument(composeText: string): { ok: true; doc: Record<string, unknown> } | { ok: false; message: string } {
  if (!composeYamlParser) return { ok: false, message: "Bun.YAML is unavailable in this runtime — the entry-content audits cannot read the artefact and refuse to guess" }
  let raw: unknown
  try {
    raw = composeYamlParser.parse(composeText)
  } catch (err) {
    return { ok: false, message: `Bun.YAML refused the artefact: ${(err as Error).message}` }
  }
  if (raw === null || raw === undefined) return { ok: true, doc: {} } // empty/comment-only: loud absence downstream
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: true, doc: {} } // scalar/array top level has no services to read either way
  return { ok: true, doc: raw as Record<string, unknown> }
}

/** Render any parsed YAML value as the text the pair screens expect. Structured values (a mapping smuggled
 *  into a sequence item, an object where a scalar belongs) stringify to something no pair shape can match —
 *  which is the refusal this audit owes them, not a crash and not a skip. */
function entryValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value) ?? String(value)
}

// --- extra_hosts extraction (the P3 audit: every shape the engine resolves, read per service) ---------------------

interface ExtraHostEntry {
  readonly service: string
  /** The entry as the parsed document carries it — quotes and comments are already gone with the engine's reading. */
  readonly raw: string
}

/** Every `extra_hosts` entry a service carries, in whatever shape the compose schema admits: the block/flow
 *  SEQUENCE of "name:address" strings (the form row 241 renders), the MAPPING form `{name: address}` — the
 *  spelling F-265-2 measured invisible to both offline witnesses while block form fired `EXTRA_HOST_AT_HOST` —
 *  and the single-scalar form. Merge keys need no special case here because the engine resolves them before
 *  this function sees the object: what is visible in the parsed document is what a consumer received. */
function extraHostEntries(doc: Record<string, unknown>): ExtraHostEntry[] {
  const out: ExtraHostEntry[] = []
  const services = doc.services
  if (typeof services !== "object" || services === null || Array.isArray(services)) return out
  for (const [service, body] of Object.entries(services as Record<string, unknown>)) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) continue
    const entries = (body as Record<string, unknown>).extra_hosts
    if (entries === undefined || entries === null) continue
    if (Array.isArray(entries)) {
      for (const item of entries) out.push({ service, raw: entryValue(item) })
      continue
    }
    if (typeof entries === "object") {
      for (const [hostname, value] of Object.entries(entries as Record<string, unknown>))
        out.push({ service, raw: `${hostname}:${entryValue(value)}` })
      continue
    }
    out.push({ service, raw: entryValue(entries) })
  }
  return out
}

// --- network-membership extraction (row 267 / F-251-8, engine-read since row 270 / F-265-1) -----------------------

interface NetworkAttachment {
  readonly service: string
  readonly network: string
}

interface NetworkTopology {
  /** Top-level `networks:` declarations, name → whether the block carries `internal: true`. A network any service
   *  attaches that is ABSENT from this map is treated as non-internal, because that is what docker does with an
   *  undeclared network: it creates one, bridge-typed and routable. */
  readonly defined: Map<string, boolean>
  readonly attachments: readonly NetworkAttachment[]
}

/** Read the segmentation out of the PARSED compose document: which networks are declared and with which
   `internal` flag, and which service attaches which of them. Every shape the engine resolves is visible here —
   the flow and block sequences, the mapping form with per-network options, a one-line flow-style service body,
   and a mapping-form attachment whose membership arrives through a merge key. Those last two are exactly what
   row 265 measured the previous line reader missing (F-265-1, introduced-by-batch: the merge-key spelling
   passed the WHOLE verifyEgressBake with ok=true while Bun.YAML handed the carrier fc-web), and comments need
   no handling because the engine discards them before this function runs. */
function parseNetworkTopology(doc: Record<string, unknown>): NetworkTopology {
  const defined = new Map<string, boolean>()
  const attachments: NetworkAttachment[] = []
  const networks = doc.networks
  if (typeof networks === "object" && networks !== null && !Array.isArray(networks)) {
    for (const [name, body] of Object.entries(networks as Record<string, unknown>))
      defined.set(
        name,
        typeof body === "object" && body !== null && !Array.isArray(body) && internalFlagHolds((body as Record<string, unknown>).internal),
      )
  }
  const services = doc.services
  if (typeof services === "object" && services !== null && !Array.isArray(services)) {
    for (const [service, body] of Object.entries(services as Record<string, unknown>)) {
      if (typeof body !== "object" || body === null || Array.isArray(body)) continue
      const nets = (body as Record<string, unknown>).networks
      if (nets === undefined || nets === null) continue
      if (Array.isArray(nets)) {
        for (const item of nets) attachments.push({ service, network: attachmentName(item) })
        continue
      }
      if (typeof nets === "object") {
        // Mapping form: the KEYS are the memberships — merged or literal, the engine already resolved which is which.
        for (const name of Object.keys(nets as Record<string, unknown>)) attachments.push({ service, network: name })
        continue
      }
      attachments.push({ service, network: attachmentName(nets) })
    }
  }
  return { defined, attachments }
}

/** A sequence item that is not a plain name (a mapping smuggled into `[fc-ctl, {fc-web: null}]`) keeps its JSON
 *  spelling as the attachment name: no top-level block declares such a network, so claim (ii) refuses it. */
function attachmentName(value: unknown): string {
  return typeof value === "string" ? value : entryValue(value)
}

/** The internal flag as both this file's line reader and docker's own YAML 1.1 heritage read it: boolean true,
 *  or the strings true/yes in any case. Anything else — including `false`, absence and structured values — is
 *  non-internal; fail-closed is the direction a containment gate takes its mistakes. */
function internalFlagHolds(value: unknown): boolean {
  if (value === true) return true
  return typeof value === "string" && /^(?:true|yes)$/i.test(value)
}

/** Positive NAME shape: lowercase RFC1123 labels with at least one dot. The dot is containment, not style — docker's
 *  embedded DNS answers service short-names on the all-internal tiers, so an undotted pin redirects a tier inside the
 *  stack (producer spec §5 / row 241's judgement note). Label lengths are capped per RFC 1035 as their own visible
 *  check (≤63 each, ≤253 total) instead of being buried in the pattern. Deliberately NOT imported from
 *  composefiles/dns_pins.ts — see header item (7). */
function dottedFqdnShape(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false
  const labels = host.split(".")
  if (labels.length < 2) return false
  return labels.every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
}

/** Positive VALUE shape: a canonical dotted-quad in the unicast range. This is NOT a second deny list — the twelve
 *  CIDRs are asked of r94's shipped `isDeniedAddress`, the same predicate the cross-enforcer hook uses. What is
 *  restated here are the two things those CIDRs do not cover and producer §3.3 demands anyway: multicast/reserved
 *  answers whose first octet is ≥224 (239.1.2.3 answers FALSE from `isDeniedAddress` yet the vendor classifier blocks
 *  the whole target on it — research/s6_11_playwright_precheck.md §7.3) and non-canonical numeric encodings (leading
 *  zero, octal, hex) that urlpolicy parses for hostile URL hosts but no answer-producer ever writes into a render. */
function canonicalPublicUnicastV4(value: string): boolean {
  const parts = value.split(".")
  if (parts.length !== 4) return false
  if (!parts.every((p) => /^(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(p))) return false
  if (Number(parts[0] ?? "0") >= 224) return false
  return !isDeniedAddress(value)
}

// --- readiness-probe sink accounting (row 243 / R112d-3): the idle-window assertion as a DELTA with a liveness witness --
//
// WHY THIS EXISTS. The readiness gate polls the estate, and its exec-lane check against egress-proxy is a bare TCP
// connect to squid's OWN port that opens and closes without ever sending request headers. squid logs each such connect
// as `NONE_NONE/000 … error:transaction-end-before-headers` — attempt 4 counted eleven of them at the gate's own ~3.2 s
// poll spacing, ending the second the gate went green (verification/13d_live_firecrawl_attempt4.md §8 R112d-3). Those
// lines pollute an "idle window" assertion over squid's access log (§10.6 item 7: "zero outbound connections
// attributable to the estate"): a naive "no new lines appeared" check reads the gate's own traffic as the estate going
// busy, while a naive "ignore the 000 lines and see if anything is left" check cannot tell a genuinely idle estate from
// a sink that stopped writing at all — the byte-identical observation §10.6's audit-sink rule forbids
// (`masterplan/01e_compose_spec.md` :1720-1722: "Zero lines from a blind sink and zero lines from a truly idle estate
// are byte-identical observations; only the control tells them apart"). The reconciliation is that the probe lines are
// BOTH things at once: they must not count as egress, yet their very presence is positive proof the sink is writing. So
// the idle verdict is a DELTA over two full reads, classified three ways, and it may say IDLE only when something
// proves the sink is live — either the gate's own probe-noise lines (still polling) or a deliberate control line
// (polling finished). This is trap T-5 of `masterplan/05_s6b_firecrawl_repair_contract.md` §5 made executable.
//
// PURE over RECORDED log lines: it boots nothing, spawns nothing, opens no socket. Rows 254/255 supply the live reads;
// row 263 wires it into the bring-up assertion. Proving the delta rule on fixtures here is the row's whole test; the
// live proof belongs to row 255 (`verification/s6b_09_containment_after_repair.md`), never to this file.

/** The squid status code meaning "no HTTP response was ever sent" — the readiness self-connect's signature. A real
 *  request always completes with a non-000 status (even the positive control's `TCP_MISS_ABORTED/503`), so 000 is what
 *  separates the gate's own traffic from the estate's. */
const SQUID_NO_RESPONSE_STATUS = "000"

/** The vendor token squid writes when a connection closed before any request headers arrived — the readiness exec-lane
 *  connect's tell (R112d-3). Named once so the classifier and its tests cite one spelling. */
export const READINESS_PROBE_NOISE_TOKEN = "error:transaction-end-before-headers"

/** The `<TAG>/<status>` field of a squid native access-log line. Leftmost match wins, which is the status field by
 *  construction: in the native format the client IP (digits/dots, no letters) precedes it and the hierarchy token
 *  (`HIER_DIRECT/<ip>`) follows it, so the first `[A-Z_]+/\d{3}` on any well-formed line is the reply code. */
const SQUID_STATUS_FIELD = /\b([A-Z][A-Z_]*)\/(\d{3})\b/

export type SquidSinkKind = "PROBE_NOISE" | "REAL_EGRESS" | "CONTROL" | "UNRECOGNIZED"

/** Classify one squid access-log line into the four kinds the idle decision reasons over. Order matters and is the
 *  substance of this row: the control marker wins over physical shape (the control IS a real request, but it is the one
 *  the reader deliberately issued, so it registers as the liveness witness rather than as traffic that breaks idleness);
 *  probe noise wins over real egress (a 000-status self-connect is neither outbound nor a transaction). A non-blank
 *  line that is none of these is UNRECOGNIZED, and `auditIdleWindow` treats it fail-closed — an unattributable line
 *  must never be silently read as "nothing happened". */
export function classifySquidSinkLine(line: string, controlMarker?: string): SquidSinkKind {
  if (line.trim() === "") return "UNRECOGNIZED"
  if (controlMarker !== undefined && controlMarker !== "" && line.includes(controlMarker)) return "CONTROL"
  if (isReadinessProbeNoise(line)) return "PROBE_NOISE"
  if (hasRealRequest(line)) return "REAL_EGRESS"
  return "UNRECOGNIZED"
}

function isReadinessProbeNoise(line: string): boolean {
  const m = line.match(SQUID_STATUS_FIELD)
  if (m?.[2] !== SQUID_NO_RESPONSE_STATUS) return false
  // Tie the noise to the documented readiness signature (tag NONE_NONE or the transaction-end tell), NOT to every 000:
  // a genuine aborted download can also carry 000, and mislabelling it as gate noise would hide real egress.
  return m[1] === "NONE_NONE" || line.includes(READINESS_PROBE_NOISE_TOKEN)
}

function hasRealRequest(line: string): boolean {
  const m = line.match(SQUID_STATUS_FIELD)
  if (m !== null && m[2] !== SQUID_NO_RESPONSE_STATUS) return true
  return /\b(?:GET|POST|HEAD|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH)\b/.test(line)
}

export interface IdleWindowInput {
  /** Full access-log contents read at the START of the idle window. */
  readonly before: readonly string[]
  /** Full access-log contents read at the END of the idle window. */
  readonly after: readonly string[]
  /** Substring identifying the deliberate positive-control request (e.g. `r112d-ctrl.example.com`). Optional: while
   *  the gate is still polling, its probe-noise lines are themselves the liveness witness and no control is required. */
  readonly controlMarker?: string
  /** Optional third read taken immediately AFTER issuing the control request. When supplied, the control line is sought
   *  in `(controlProbe − after)` rather than inside the window, matching attempt 4's A5 recipe where the control landed
   *  just after the idle window closed (`verification/13d_live_firecrawl_attempt4.md` §4 A5). */
  readonly controlProbe?: readonly string[]
}

export type IdleWindowOutcome =
  /** Sink proven live (witness present) AND zero real egress in the window — genuinely nothing went out. */
  | "IDLE"
  /** At least one real-egress or unrecognised line appeared in the window — the estate sent something out. */
  | "BUSY"
  /** Zero real egress AND no liveness witness: an empty delta that cannot be told from a sink that stopped writing.
   *  This is the distinct outcome R112d-3 exists to protect — never reported as IDLE. */
  | "BLIND_SINK"

export interface IdleWindowVerdict {
  readonly outcome: IdleWindowOutcome
  readonly added: number
  readonly probeNoise: number
  readonly realEgress: number
  readonly control: number
  readonly unrecognized: number
  readonly witness: "PROBE_NOISE" | "CONTROL" | "NONE"
  /** The lines that forced BUSY (real egress + unrecognised), quoted so a refusal names its cause. */
  readonly blockingLines: readonly string[]
}

/** Decide an idle window from two full reads of squid's access log, accounting for the readiness gate's own probe
 *  traffic. The verdict is a DELTA (lines added between the reads), never an absolute count, per R112d-3; it is allowed
 *  to conclude IDLE only when a witness (probe noise still landing, or a control line landing) proves the sink writes. */
export function auditIdleWindow(input: IdleWindowInput): IdleWindowVerdict {
  const added = sinkDelta(input.before, input.after)
  let probeNoise = 0
  let realEgress = 0
  let control = 0
  let unrecognized = 0
  const blockingLines: string[] = []
  for (const line of added) {
    const kind = classifySquidSinkLine(line, input.controlMarker)
    if (kind === "PROBE_NOISE") probeNoise++
    else if (kind === "REAL_EGRESS") {
      realEgress++
      blockingLines.push(line)
    } else if (kind === "CONTROL") control++
    else {
      unrecognized++
      blockingLines.push(line)
    }
  }
  const controlLanded = control > 0 || controlProbeLanded(input)
  const witness: IdleWindowVerdict["witness"] = controlLanded ? "CONTROL" : probeNoise > 0 ? "PROBE_NOISE" : "NONE"
  const outcome: IdleWindowOutcome = blockingLines.length > 0 ? "BUSY" : witness === "NONE" ? "BLIND_SINK" : "IDLE"
  return { outcome, added: added.length, probeNoise, realEgress, control, unrecognized, witness, blockingLines }
}

function controlProbeLanded(input: IdleWindowInput): boolean {
  const marker = input.controlMarker
  if (input.controlProbe === undefined || marker === undefined || marker === "") return false
  return sinkDelta(input.after, input.controlProbe).some((l) => l.includes(marker))
}

/** Lines present in `after` more often than in `before`, occurrence-wise, preserving order. A MULTISET difference, not a
 *  set one: the gate writes many near-identical probe lines and a set would collapse repeats the delta must still see. */
function sinkDelta(before: readonly string[], after: readonly string[]): string[] {
  const remaining = new Map<string, number>()
  for (const l of before) remaining.set(l, (remaining.get(l) ?? 0) + 1)
  const added: string[] = []
  for (const l of after) {
    const c = remaining.get(l) ?? 0
    if (c > 0) remaining.set(l, c - 1)
    else added.push(l)
  }
  return added
}
