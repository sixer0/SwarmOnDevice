// egress-proxy (squid) filtering config — 01e §10.4 policy constants, rendered to
// <toolsRoot>/firecrawl/squid/squid.conf (mode 0644; contents are public policy, no secrets).
//
// The constants are lifted from §10.4: deny loopback/RFC1918/link-local/CGNAT/IPv6-local
// destinations, ports 80/443 only, deny-then-default-deny, CONNECT-time answer re-check
// (rebinding-safe, V3), dns_v4_first, no cache, audit-shaped access log on stdout so the
// json-file logging driver (§4.4) bounds it — the estate's egress audit twin of the
// PC-PATH-10 lines (10.4 bullet 3).
//
// MECHANISM NOTE (row 92's review call, addendum E5): the rock's entrypoint is Pebble; the
// rendered compose block takes the command-override form (`squid -N -f` this file). The
// Pebble-registration alternative changes delivery only — the policy below is identical.
// Directive-level live behaviour (squid 6.6 in the pinned digest) is row 112's probe scope.

import { PC_PORTS, type RenderFile } from "./shared.ts"

export function renderSquidConf(): RenderFile {
  const content = [
    "# swarm-egress.conf — rendered by the swarm-setup compose-files renderer (row 85)",
    "# Policy constants lifted from masterplan/01e_compose_spec.md §10.4 (P-9, C7-2).",
    "# Trust boundary: only fc-ctl members can reach this proxy at all (no other network face).",
    `http_port ${PC_PORTS.squidContainer}               # PC-PORT-06 (unpublished; reachable from fc-ctl members only)`,
    "acl localnet src 172.16.0.0/12        # compose bridge pools incl. swarm-tools_* and Colima ranges — superset, per-pool enumeration unnecessary (10.4)",
    "acl SSL_ports port 443",
    "acl SafePorts port 80 443             # allow ports 80/443 only (10.4)",
    "acl Connector method CONNECT",
    "acl to_localnet dst 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10",
    "acl to_localnet dst ::1/128 fe80::/10 fc00::/7   # dst takes IP/CIDR only — evaluates the RESOLVED answer (V3 rebinding closure)",
    "acl to_localhost dstdomain localhost      # H-R93-6 (r93 live VM): hostname forms MUST be a dstdomain class;",
    "acl to_localhost dstdomain .local         # the pre-fix 'dst localhost domain .local' was invalid grammar -> squid FATAL at boot",
    "dns_v4_first on                       # 10.4 bullet 3",
    "cache deny all                        # no caching: every object non-cacheable (the enforceable reading of the 10.4 no-cache directive-class wording)",
    "access_log stdio:/dev/stdout          # audit twin of PC-PATH-10 lines (ts, method, target-host, verdict, bytes), bounded by the json-file driver (§4.4)",
    "http_access deny !SafePorts",
    "http_access deny Connector !SSL_ports",
    "http_access deny to_localnet",
    "http_access deny to_localhost",
    "http_access allow localnet",
    "http_access deny all                  # default-deny AFTER the explicit denies (10.4 ordering)",
    "# Redirects are re-proxied and re-checked per hop: each hop is a fresh request through these rules.",
    "",
  ].join("\n")

  return { relPath: "firecrawl/squid/squid.conf", content, mode: 0o644, stack: "firecrawl" }
}
