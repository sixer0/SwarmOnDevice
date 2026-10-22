// egress-proxy (squid) filtering config — 01e §10.4 policy constants, rendered to
// <toolsRoot>/firecrawl/squid/squid.conf (mode 0644; contents are public policy, no secrets).
//
// The constants are lifted from §10.4 as amended by r75-fix4 [review-107 M2]: deny TWELVE
// destination classes (loopback/RFC1918/link-local/CGNAT/IPv6-local plus this-network
// 0.0.0.0/8, IPv6-unspecified ::/128, NAT64 64:ff9b::/96), ports 80/443 only, STRICT
// deny-before-allow ordering (enforced by lint.ts findSquidOrderingViolations, run by
// renderAll), CONNECT-time answer re-check (rebinding-safe, V3), no cache; audit-shaped
// access log on a bounded tmpfs-backed file so the mount size bounds it (r75-fix8).
// Amended by r11 (row 241, gate 239 option 2): the CONNECT method may now tunnel to BOTH
// 80 and 443 via the dedicated swarm_tunnel_ports ACL — a port-class widening only; the
// twelve-class destination screen, the deny-before-allow ordering and the internal-only
// browser attachment are the three properties §10.4 requires to survive it, unchanged here.
//
// ACL NAMES [R112-1, r112 live VM]: squid PREDEFINES `all, manager, localhost, to_localhost,
// to_linklocal, CONNECT` (image note at /etc/squid/squid.conf:1387); redeclaring a predefined
// name with a different type is a boot FATAL ("already exists with different type" — V0/V1/V3/
// V4/M2 experiments; V6 proved a pure rename parses rc=0 on the pinned digest). Our names are
// therefore namespaced: **to_localnet** (twelve dst classes — UNCHANGED: V6 proves it is not
// predefined, and r92's live audit parses it) and **swarm_hostnames** (dstdomain pair — the
// renamed to_localhost). These identifiers are stated here for r92-fix3's audit hardening (their bake currently
// accepts old+new transitionaly). The predefined to_localhost keeps doing its native
// loopback-dst job for free — we simply no longer fight it.
//
// VERSION NOTE [R112-6]: the pinned immutable digest sha256:6a097f68… now RESOLVES to squid
// 6.13, not the 6.6 r78a recorded (tag-less repo drift). The PIN governs — nothing here changes;
// the stale alias record goes to row 113's evidence list / lock-refresh. Predefined-ACL
// strictness observed on 6.13 is exactly what R112-1 encodes.
//
// MECHANISM NOTE (row 92's review call, addendum E5): the rock's entrypoint is Pebble; the
// rendered compose block takes the command-override form (`squid -N -f` this file). The
// Pebble-registration alternative changes delivery only — the policy below is identical.
// Directive-level live behaviour in the pinned digest is row 112's probe scope.

import { PC_PORTS, type RenderFile } from "./shared.ts"

export function renderSquidConf(): RenderFile {
  const content = [
    "# swarm-egress.conf — rendered by the swarm-setup compose-files renderer (row 85)",
    "# Policy constants lifted from masterplan/01e_compose_spec.md §10.4 (P-9, C7-2) as amended",
    "# by r75-fix4 [review-107 M2]; hostname ACL renamed per R112-1 (swarm_hostnames —",
    "# squid predefines all, manager, localhost, to_localhost, to_linklocal, CONNECT).",
    "# Trust boundary: only fc-ctl members can reach this proxy at all (no other network face).",
    // Option-parsed directives below carry their notes on OWN lines (R112b-1 class: an inline
    // comment silently corrupted the http_port value live and `squid -k parse` accepted both
    // forms — lint.ts findDirectiveInlineComments now refuses the shape for this whole class).
    "# PC-PORT-06 squid listen (unpublished; reachable from fc-ctl members only)",
    `http_port ${PC_PORTS.squidContainer}`,
    "acl localnet src 172.16.0.0/12        # compose bridge pools incl. swarm-tools_* and Colima ranges — superset, per-pool enumeration unnecessary (10.4)",
    "acl SSL_ports port 443",
    // Tunnel-port class — gate 239 fork F-239-B ("Perlu": plain-HTTP scraping is a required capability),
    // shape word at 01e §10.4's r11 amendment. This ACL exists ONLY to re-point the single deny Connector
    // line below; SSL_ports stays declared and unchanged so any other reader of it is unaffected
    // (research/s6_12_tunnel_options_costed.md §4 "Invariant that must survive"), SafePorts and its deny
    // stay as-is because that pair governs non-tunnel methods and was never the refusal, and NO new
    // http_access allow line appears: the widening removes one denial for one method class, it grants no
    // route. Public-only stays enforced by the destination denies below, evaluated against squid's own
    // CONNECT-time answer (V3) — the port test and the destination test are independent mechanisms (§1 item 1).
    "acl swarm_tunnel_ports port 80 443",
    "acl SafePorts port 80 443             # allow ports 80/443 only (10.4); custom name — Safe_ports is predefined, we do not touch it",
    "acl Connector method CONNECT",
    // THE DENY CIDRs BELOW AND ABOVE ARE A COPY OF A POLICY THE BAKE ALSO CARRIES — read this before editing either.
    // The twelve classes have one host-side predicate (`mcpproxy/urlpolicy.ts:isDeniedAddress`) and one registry of
    // class representatives (`steps/firecrawl/egress_bake.ts:REQUIRED_DENY_RANGES`); the two ACL lines here are the
    // L4 rendering of the same set and are deliberately NOT derived from either — a renderer that emitted whatever
    // the audit listed would make the audit's own comparison tautological, which is the independence row 242 argued
    // for in the other direction (implementation/s6_r242_audit_lockstep.md §4). The copy is LINKED instead: the
    // renderer-suite pin `test/compose_files.test.ts` ("r267 Q6.3") compares the tokens on these two lines against
    // REQUIRED_DENY_RANGES as SETS IN BOTH DIRECTIONS, so moving one list without the other is a red test rather
    // than a silently divergent L4 rule (row 252 Q6.3 named this line as the fourth home; row 251 §2.9 CAUTION 2
    // owns the widening ruling). Widening therefore needs, in ONE batch: urlpolicy, REQUIRED_DENY_RANGES, these two
    // lines, row 244's removal loop, and the cross-enforcer hook.
    "acl to_localnet dst 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 0.0.0.0/8",
    "acl to_localnet dst ::1/128 fe80::/10 fc00::/7 ::/128 64:ff9b::/96   # TWELVE classes [review-107 M2]: additions are 0.0.0.0/8 (this-network; Linux-routed loopback-like), ::/128 (IPv6 unspecified twin), 64:ff9b::/96 (NAT64 well-known prefix — DNS64 answers can embed a private IPv4, e.g. 64:ff9b::7f00:1 wraps 127.0.0.1; posture is DENY the whole prefix, never unwrap). dst takes IP/CIDR only — evaluates the RESOLVED answer (V3 rebinding closure)",
    "acl swarm_hostnames dstdomain localhost      # R112-1: renamed from the PREDEFINED to_localhost (different-type redeclaration = boot FATAL); V6 proved rename-only parses clean",
    "acl swarm_hostnames dstdomain .local         # H-R93-6 split kept: hostname forms are dstdomain-class; same-name same-type lines are additive",
    "# dns_v4_first DROPPED by r75-fix8: obsolete since squid 5.0.4, absent from the v5-v8 reference, ERROR line every boot on 6.13.",
    "# Family order is not load-bearing here: denies evaluate the RESOLVED answer (V3) and the whole NAT64 prefix is denied unconditionally;",
    "# this guest additionally has no live IPv6 route (r75fix6_topology_ruling.md §7 measurement). No successor directive exists.",
    // pinger_enable is an option-parsed-class directive: its note rides its OWN line (R112b-1 discipline),
    // and the bare directive below carries no inline comment.
    "# pinger_enable off per r75-fix9 (R112c-6 spec half): cap_drop ALL kills the ICMP sockets — two ERROR lines plus one FATAL every boot (13c:152) while the shipped conf declares no ICP/HTCP peers or SNMP at all (zero-match grep, r75f9 round); directive available v4-v7, default on (saved copy 80dbd338…). Removes the condition that produces the line; registering the FATAL vocabulary stays row 92's call.",
    "pinger_enable off",
    "# No caching: every object non-cacheable (the enforceable reading of the 10.4 no-cache directive-class wording).",
    "cache deny all",
    "# Audit twin of PC-PATH-10 lines (ts, method, target-host, verdict, bytes) in a bounded in-container file (r75fix8_squid_sink_ruling.md §3):",
    "# stdio writes each line immediately at request completion (squid access_log reference), the tmpfs mount carries it (compose block),",
    "# and the host-side auditor reads it via `docker exec --user root` — stdio:/dev/stdout FATALed as proxy on the pinned digest (p1 log :19).",
    "access_log stdio:/var/log/squid/access.log",
    "http_access deny !SafePorts",
    // Re-pointed (not reordered, not duplicated) at the tunnel-port class per gate 239 option 2 —
    // this single argument substitution IS the whole widening; see the swarm_tunnel_ports note above.
    "http_access deny Connector !swarm_tunnel_ports",
    "# destination-class denies ABOVE every allow (01e §10.4 ordering, enforced by lint); wiring lines bare",
    "# by design — r92's audit fixtures match them exactly (`^\s*http_access deny <name>\s*$`).",
    "http_access deny to_localnet",
    "http_access deny swarm_hostnames",
    "http_access allow localnet            # admits WHO may ask, never WHERE it goes — must sit below the destination denies (R112/M2 class)",
    "http_access deny all                  # default-deny AFTER the explicit denies (10.4 ordering)",
    "# Redirects are re-proxied and re-checked per hop: each hop is a fresh request through these rules.",
    "",
  ].join("\n")

  return { relPath: "firecrawl/squid/squid.conf", content, mode: 0o644, stack: "firecrawl" }
}
