// nginx auth-proxy template renderer — 01e §6.3 (row-84-line render contract, owned here
// by the row-85 renderer; the secret OWNER rows apply it). Output lands at
// <toolsRoot>/firecrawl/nginx/default.conf.template mode 0600, bind-mounted read-only to
// /etc/nginx/templates/default.conf.template (official-image envsubst mechanism, U-10).
//
// The file carries NO secret value: only the ${SWARM_FIRECRAWL_TOKEN} placeholder, which is
// the single variable the official 20-envsubst-on-templates.sh substitutes (whitelist form),
// fed by 05-swarm-env.envsh reading /run/secrets/proxy_token (bin_scripts.ts). R112b-2
// (r112b live VM): that feeder is a SOURCED .envsh — the image runs .sh wraps in a subshell
// and the old append to /docker-entrypoint.env hit the read-only rootfs, so the variable
// arrived absent and nginx exited on `unknown "swarm_firecrawl_token" variable`. Absent-token
// stays fail-closed (that emerg-exit is the mechanism); the channel fix makes the token ARRIVE.
// U-15: auth_request module presence in the pinned digest is unverified; the pre-decided
// fallback (inline compare in the serving location, identical accept/reject) renders with
// {nginxAuthInline: true}. Timing property stated honestly in §6.3: the rewrite-module `if`
// compare is strcmp, not secure_compare — discounted for a 256-bit token over loopback (U-11).

import { PC_PORTS } from "./shared.ts"
import type { RenderFile } from "./shared.ts"

export interface NginxOptions {
  /** U-15 fallback switch: inline-compare form instead of the auth_request subrequest. */
  readonly nginxAuthInline?: boolean
}

export function renderNginxTemplate(opts: NginxOptions = {}): RenderFile {
  const head = [
    "# default.conf.template — rendered by the swarm-setup compose-files renderer (row 85), 01e §6.3",
    "# Mounted read-only at /etc/nginx/templates/default.conf.template; the official image's",
    "# 20-envsubst-on-templates.sh substitutes SWARM_FIRECRAWL_TOKEN (whitelisted) into conf.d.",
    "# This file holds NO secret value until that container-side substitution runs.",
    "server {",
    `  listen ${PC_PORTS.firecrawlPublished.container};                     # §6.2/PC-PORT-05: container side 8080 keeps the proxy cap-free (host binding 9022 is the compose ports mapping, PC-PORT-02)`,
    "  server_tokens off;",
    "  client_max_body_size 2m;         # API payloads are small; scraped content never passes back",
    '  location = /livez { access_log off; return 200 "ok\\n"; }',
    "",
  ]

  const proxyLines = [
    `    proxy_pass http://api:${PC_PORTS.apiContainer};              # fc-ctl service DNS on PC-PORT-04 (container-side); api publishes NOTHING (P-6/P-8)`,
    "    proxy_http_version 1.1;",
    "    proxy_set_header Host $proxy_host;       # never forward the client Host (host-header-trick immune, C7-4 ethos)",
    "    proxy_buffering off;                     # long-poll/crawl responses stream",
    "    proxy_read_timeout 300s; proxy_send_timeout 60s;",
  ]

  const body = opts.nginxAuthInline
    ? [
        "  # U-15 FALLBACK FORM (pre-decided, §6.3 end): behaviourally identical accept/reject, no subrequest.",
        "  location / {",
        '    if ($http_authorization != "Bearer ${SWARM_FIRECRAWL_TOKEN}") { return 401; }',
        ...proxyLines,
        "  }",
      ]
    : [
        "  location / {",
        "    auth_request /_swarm-authz;    # ngx_http_auth_request_module (presence in the pinned digest = U-15;",
        "                                   # bake-check: docker run --rm --entrypoint nginx <pinned> -V;",
        "                                   # pre-decided fallback = the inline-compare form, see renderer)",
        ...proxyLines,
        "  }",
        "",
        "  # auth_request target. Request-scoped variables see the ORIGINAL request's Authorization",
        "  # header, so the comparison needs no header re-forwarding. Any non-2xx from here maps to",
        "  # 401 on the main request (module semantics).",
        "  location = /_swarm-authz {",
        "    internal;",
        "    access_log off;",
        '    if ($http_authorization = "Bearer ${SWARM_FIRECRAWL_TOKEN}") { return 200 ""; }',
        "    return 401;",
        "  }",
      ]

  const tail = [
    "}",
    "",
    "# Access-log policy (§6.3): default combined format to /var/log/nginx (host-mounted, rotation-bound);",
    "# $http_authorization must NEVER appear in any log_format — the token must not reach disk in cleartext.",
    "",
  ]

  return {
    relPath: "firecrawl/nginx/default.conf.template",
    content: [...head, ...body, ...tail].join("\n"),
    mode: 0o600,
    stack: "firecrawl",
  }
}
