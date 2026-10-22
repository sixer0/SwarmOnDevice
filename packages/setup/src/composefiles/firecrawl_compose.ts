// compose/firecrawl.yml renderer — 01e §6 (Stack B), key-for-key from the ratified spec.
// Images: tools.lock.json components.firecrawl.* (row 80 + r80b). Limits: §7.2 table.
// Egress design: §6.1 topology + §10.4 filtering proxy. Pass-through rule: §11 (the
// rendered file carries ZERO occurrences of any forbidden name — comments included —
// so row 85's grep stays trivial; policy notes live in this source file instead).
// Two-form services follow the landed default decisions (D-22):
//   redis  U-4 requirepass ON  -> form A (wrap + secret bind)
//   rabbit U-5 credential OFF  -> form B (stock guest/guest confined to fc-data)
//   valkey U-6 (stack A)       -> passwordless
// Cap policy after H-R93-5 live evidence (r93 VM, 07:3x UTC): blanket cap_drop:[ALL] broke every
// image whose entrypoint drops privileges, so five services carry the MINIMAL cap_add set their own
// startup needs (SETUID/SETGID, plus CHOWN where the entrypoint chowns its data paths) — each choice
// cited in-file, each pinned by the lint's per-service allow-list (lint.ts CAP_ADD_ALLOWLIST).
// cap_drop:[ALL] stays UNMODIFIED on searxng/redis/api (proved or expected single-flow starts).
// The browser sandbox exception [RR-2] (SYS_ADMIN, U-9) remains NOT rendered: no live evidence yet;
// playwright's observed failure was a home-dir write, fixed by tmpfs widening, not by a cap.

import {
  CAP_DROP,
  PC_PORTS,
  SECURITY_OPT,
  bindMount,
  commentLines,
  labelBlock,
  lockImage,
  loggingBlock,
  pathsFor,
  publishedPortEntries,
  resolveSecretState,
  ulimitsBlock,
  type NormalizedCtx,
  type RenderError,
  type RenderFile,
} from "./shared.ts"
import { COMPOSE_PROJECT } from "../constants.ts"
import type { LockFile } from "../lockfile.ts"
import type { ExtraHost } from "./dns_pins.ts"
import type { LaneValues } from "./lanes.ts"

export function renderFirecrawlCompose(
  lock: LockFile,
  ctx: NormalizedCtx,
  pins: readonly ExtraHost[],
  lanes: LaneValues,
): { ok: true; file: RenderFile } | { ok: false; errors: RenderError[] } {
  const api = lockImage(lock, "firecrawl", "api_image")
  if (!api.ok) return { ok: false, errors: [api.error] }
  const playwright = lockImage(lock, "firecrawl", "playwright_image")
  if (!playwright.ok) return { ok: false, errors: [playwright.error] }
  const nuq = lockImage(lock, "firecrawl", "nuq_postgres_image")
  if (!nuq.ok) return { ok: false, errors: [nuq.error] }
  const redis = lockImage(lock, "firecrawl", "redis_image")
  if (!redis.ok) return { ok: false, errors: [redis.error] }
  const rabbit = lockImage(lock, "firecrawl", "rabbitmq_image")
  if (!rabbit.ok) return { ok: false, errors: [rabbit.error] }
  const proxy = lockImage(lock, "firecrawl", "proxy_image")
  if (!proxy.ok) return { ok: false, errors: [proxy.error] }
  const squid = lockImage(lock, "firecrawl", "egress_proxy_image")
  if (!squid.ok) return { ok: false, errors: [squid.error] }

  const p = pathsFor(ctx.toolsRoot)
  const version = lock.version
  const ca = ctx.caBundlePath !== undefined
  const redisAuth = resolveSecretState({ secrets: ctx.secrets }, "firecrawl", "redis_auth") === "generated" // U-4 default ON — required slot, contextErrors already refuses if absent
  const rabbitCred = resolveSecretState({ secrets: ctx.secrets }, "firecrawl", "rabbitmq_password") === "generated" // U-5 default OFF -> form B
  // P3 injected answers (gate 239: the chosen shape is P3 with forks C+D settling divergence and
  // freeze; 01e §4.5 amended + §10.2): the pins arrive ALREADY
  // screened by dns_pins.readDnsPins — one dotted FQDN to one canonical public unicast IPv4, every
  // recorded answer re-run through the shipped urlpolicy predicates at read time. Empty means the
  // pins file is ABSENT (the only legal no-pins state, producer spec §3.3) and the render stays
  // byte-identical to the pre-P3 estate: no key, no comment, no empty list. IPv6 is withheld by
  // design (§1.2: the guest has no live IPv6 route); a non-survivor or malformed file refuses the
  // whole render upstream — nothing here may omit an entry silently.
  const extraHostsBlock = (indent: number): string[] =>
    pins.length === 0
      ? []
      : [
          `${" ".repeat(indent)}extra_hosts:  # P3 injected public answers (01e §4.5/§10.2, gate 239); render-screened literals, never the host, never a denied class`,
          ...pins.map((pin) => `${" ".repeat(indent + 2)}- "${pin.hostname}:${pin.address}"`),
        ]

  // Lane controls (row 245; masterplan/06_s6b_lanes_spec.md §5.1). Every value arrives ALREADY
  // VALIDATED: lanes.readLanes ran the closed key set, the integer rule and the published ranges at
  // index.ts and refused the whole render otherwise, so nothing here may re-default, clamp or infer.
  // Each control renders its OWN literal from its OWN key — never one derived number driving two keys,
  // which is the collapse §4.3 forbids — and an unset control renders exactly what row 241 left in
  // the bytes (AC-237-1). The four inert keys below keep their values and their "not read by the
  // pinned build" comments untouched: this row changes live VALUES only, never the claims around them
  // (01e §12's row-245 contract line).
  const workers = lanes.NUQ_WORKER_COUNT // C-1 api queue workers: image default 5, published range [4,5]
  const pages = lanes.MAX_CONCURRENT_PAGES // C-2 playwright pages: vendor 10, our literal 2, published range [4,4]

  const y = [
    "# compose/firecrawl.yml — PC-PKG-04 (rendered by the swarm-setup compose-files renderer, row 85)",
    "# Structure lifted from masterplan/01e_compose_spec.md §6/§7.2/§10.4; digests from tools.lock.json.",
    "# One project swarm-tools with searxng.yml; per-stack ops use -f scoping + the component label (01e §3).",
    `name: ${COMPOSE_PROJECT}`,
    "",
    "# §6.1 five-tier segmentation. fc-edge answers the ONLY publish of this stack;",
    "# fc-ctl/fc-data are internal; fc-web has exactly one internet-capable member (egress-proxy);",
    "# fc-iso is the internal browser segment: containment by the internal flag, not by gateway omission (U-7 measured, r75-fix6).",
    "networks:",
    "  fc-edge:",
    "    driver: bridge",
    "  fc-ctl:",
    "    driver: bridge",
    "    internal: true",
    "  fc-data:",
    "    driver: bridge",
    "    internal: true",
    "  fc-web:",
    "    driver: bridge",
    "  fc-iso:",
    "    driver: bridge",
    "    internal: true  # r75-fix6: all-internal attachments mean no default route; do NOT assert an absent gateway",
    "    ipam:",
    "      config:",
    "        - subnet: 172.30.40.0/24  # chosen outside typical colima/docker pools; overlap is a row-93 bring-up check (docker network ls scan)",
    "",
    "services:",
    "  auth-proxy:",
    `    image: ${proxy.ref}`,
    commentLines(
      "PC-IMG-08 closure: nginx sidecar validating the bearer token via auth_request (§6.2/§6.3); the ONLY published endpoint of this stack",
      4,
    ),
    labelBlock("firecrawl", version, 4, ctx.tamperLabel),
    "    networks: [fc-edge, fc-ctl]",
    "    depends_on:  # R112-3 live evidence: nginx resolves proxy_pass hostnames at CONFIG LOAD — starting before api FATALs host-not-found-in-upstream on default.conf proxy_pass line",
    "      api: {condition: service_started}  # minimal posture per r112; upgrade to service_healthy once api's U-1 healthcheck settles (currently omitted per H-R93-3 family)",
    "    ports:",
    `      - "${publishedPortEntries()[1]}"  # PC-PORT-02 as amended by the user PORT BLOCK (decisions.md entry 'USER DECISION (PORT BLOCK, 05:33 UTC)'): host 9022 (was 3002-host; that number survives ONLY as the api CONTAINER listen PC-PORT-04, never published); proxy container side 8080 (PC-PORT-05) keeps it cap-free`,
    "    volumes:",
    bindMount(p.firecrawlNginxTemplate, "/etc/nginx/templates/default.conf.template", true, 6),
    commentLines(
      "official-image template mechanism: docker-entrypoint.d renders templates into conf.d (U-10; fallback = token baked inline, script mounts omitted)",
      6,
    ),
    bindMount(`${p.firecrawlSecrets}/proxy_token`, "/run/secrets/proxy_token", true, 6),
    // R112b-2 (r112b live VM): .envsh, NOT .sh — the image SOURCES *.envsh in-process so the
    // export reaches 20-envsubst-on-templates.sh; a .sh runs in a subshell and its old append to
    // /docker-entrypoint.env died on read_only. lint.ts findWrapChannelViolations pins this shape.
    bindMount(`${p.firecrawlBin}/fc-nginx-env.envsh`, "/docker-entrypoint.d/05-swarm-env.envsh", true, 6),
    bindMount(p.firecrawlLogs, "/var/log/nginx", false, 6),
    "    read_only: true  # provisional [H] — tmpfs below carry the writes",
    "    tmpfs:",
    "      - /var/cache/nginx:noexec,nosuid,size=32m",
    "      - /var/run:noexec,nosuid,size=8m",
    "      - /etc/nginx/conf.d:noexec,nosuid,size=8m  # H-R93-5: 20-envsubst-on-templates.sh WRITES default.conf here — needs a writable target under read_only root",
    `    ${CAP_DROP}`,
    "    cap_add: [SETUID, SETGID, CHOWN]  # H-R93-5 live evidence: master hands workers to the nginx user (setuid/setgid) and the entrypoint chowns cache dirs; least set, lint allow-listed per service",
    `    ${SECURITY_OPT}`,
    "    cpus: 0.25",
    "    mem_limit: 128m",
    "    memswap_limit: 128m",
    ulimitsBlock(4),
    '    restart: "no"',
    loggingBlock(4),
    "    healthcheck:  # KEPT: busybox wget ships in the alpine base (01e §6.2 rationale); auth-proxy booted no worker yet when r112b ran, so if this ever reports wget-missing the U-1 fallback applies — same one-line drop + HEALTHCHECK_TOOL_ABSENT table entry as R112b-3's api/playwright fix",
    `      test: ["CMD-SHELL", "wget -qO /dev/null http://127.0.0.1:${PC_PORTS.firecrawlPublished.container}/livez || exit 1"]`,
    "      interval: 30s",
    "      timeout: 3s",
    "      retries: 3",
    "",
    "  api:",
    `    image: ${api.ref}`,
    commentLines(
      "one container runs api + extract-worker + worker via its harness (tmp/r78:101); worker ports stay internal, unpublished",
      4,
    ),
    labelBlock("firecrawl", version, 4, ctx.tamperLabel),
    "    networks: [fc-ctl, fc-data]  # NOT fc-edge (only the proxy publishes), NOT fc-web (egress goes through the filter), NOT fc-iso",
    // §10.2: a contained tier learns a public name from rendered data in its own /etc/hosts, never
    // from a network path — api is one of the two services the producer spec names (row 241 hand-off).
    ...extraHostsBlock(4),
    '    entrypoint: ["/bin/sh", "/usr/local/bin/fc-env.sh"]  # §4.7 wrap exports the env-only credentials AND builds REDIS_URL from the generated auth (REVIEW-107 MINOR-6) before exec',
    '    command: ["node", "dist/src/harness.js", "--start-docker"]',
    "    volumes:",
    bindMount(`${p.firecrawlBin}/fc-env.sh`, "/usr/local/bin/fc-env.sh", true, 6),
    bindMount(`${p.firecrawlSecrets}/bull_auth_key`, "/run/secrets/bull_auth_key", true, 6),
    bindMount(`${p.firecrawlSecrets}/postgres_password`, "/run/secrets/postgres_password", true, 6),
    // redis_auth mounted for the wrap's REDIS_URL construction (REVIEW-107 MINOR-6); required slot U-4, so always present
    bindMount(`${p.firecrawlSecrets}/redis_auth`, "/run/secrets/redis_auth", true, 6),
    ...(rabbitCred
      ? [bindMount(`${p.firecrawlSecrets}/rabbitmq_password`, "/run/secrets/rabbitmq_password", true, 6)]
      : []),
    ...(ca ? [bindMount(ctx.caBundlePath ?? "", "/etc/ssl/certs/swarm-ca.pem", true, 6)] : []),
    "    environment:",
    commentLines(
      "literal values only — zero interpolation anywhere in this file (§11). The two wrap-delivered credentials are DELIBERATELY ABSENT from this map so compose env never shadows the wrap exports (§6.4). Log-level keys are not set at all (U-13: which name the image honours is unverified).",
      4,
    ),
    '      HOST: "0.0.0.0"',
    `      PORT: "${PC_PORTS.apiContainer}"  # PC-PORT-04 container listen (unpublished); the old HOST binding moved to 9022 (PORT BLOCK)`,
    '      EXTRACT_WORKER_PORT: "3004"',
    '      WORKER_PORT: "3005"',
    "      NUQ_RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672  # U-5 decision OFF: passwordless on the internal fc-data net; if U-5 flips, the wrap exports a credentialed URL from a file",
    commentLines("REDIS_URL and REDIS_RATE_LIMIT_URL are DELIBERATELY ABSENT from this map (REVIEW-107 MINOR-6): the pre-fix ':pass@' literal could never authenticate against the generated redis_auth. The §4.7 wrap exports both, built from that same secret file — same channel as the other wrap-delivered credentials, so compose env never shadows them (§6.4 rule). Empty-username ioredis form still UNVERIFIED: the documented fallback re-renders the wrap exporting bare redis://redis:6379 and drops requirepass from the redis conf.", 4),
    `      PLAYWRIGHT_MICROSERVICE_URL: http://playwright-service:${PC_PORTS.playwrightContainer}/scrape  # upstream (tmp/r78:19; PC-PORT-07)`,
    '      USE_DB_AUTHENTICATION: "false"  # PC-ENV-V04 vendor default kept: api stays unauthenticated BEHIND the bearer proxy',
    "      POSTGRES_HOST: nuq-postgres",
    '      POSTGRES_PORT: "5432"',
    "      POSTGRES_USER: postgres  # upstream pins user/db names (tmp/r78:21-22; docs: DB must stay 'postgres')",
    "      POSTGRES_DB: postgres",
    "      ENV: local",
    '      HARNESS_STARTUP_TIMEOUT_MS: "60000"',
    // r11 (row 240) deleted the "scaled down from upstream 8 for the §7.2 memory budget" claim that used to
    // trail NUM_WORKERS_PER_QUEUE here: row 236 read the pinned api digest's own files and these four names
    // occur in NO file under /app (config schema api:/app/dist/src/config.js:69,:689; research/s6b_06_upstream_defaults.md
    // §3.1-§3.2), so the "2" is read by nothing and there was never an upstream 8 behind them to scale from.
    // The §6.4 wording rule binds every retained-but-inert key with the "not read by the pinned build"
    // sentence (masterplan/06_s6b_lanes_spec.md §3.5) so nobody re-derives capacity from these values.
    '      NUM_WORKERS_PER_QUEUE: "2"  # not read by the pinned build 2.11.554-production; retained for',
    "      # forward-compatibility pending the vendor keys returning",
    '      CRAWL_CONCURRENT_REQUESTS: "2"  # not read by the pinned build 2.11.554-production; retained for',
    "      # forward-compatibility pending the vendor keys returning",
    '      MAX_CONCURRENT_JOBS: "2"  # not read by the pinned build 2.11.554-production; retained for',
    "      # forward-compatibility pending the vendor keys returning",
    '      BROWSER_POOL_SIZE: "2"  # not read by the pinned build 2.11.554-production; retained for',
    "      # forward-compatibility pending the vendor keys returning",
    // C-1, the first LIVE lane (row 245). Rendered only when lanes.json names it: with the file absent
    // this whole spread is empty and the api env is byte-identical to row 241's final bytes. The
    // comment carries the fork-H arithmetic so a reader of the compose file alone cannot re-derive
    // "raise it to 4" from the floor — 4 is what the validator REFUSES BELOW, 5 is what ships and is
    // already today's effective value (research/s6b_07_capacity_envelope.md §4.1, §6).
    ...(workers === undefined
      ? []
      : [
          `      NUQ_WORKER_COUNT: "${workers}"  # LIVE key: api:/app/dist/src/config.js:341, consumed at harness.js:109/:110/:660 (row 236 §3.3), where the image default is 5. Value from ~/.swarm/setup/lanes.json (PC-PATH-18), validated [4,5] per row 238 §4.1 + gate 239 fork H; the floor 4 is a refusal boundary, not a write — writing 4 would cost a worker against a per-team job ceiling of 5 (concurrency-limit.js:39). Env-class: changing it recreates this container (§3.1 restart class)`,
        ]),
    `      PROXY_SERVER: "http://egress-proxy:${PC_PORTS.squidContainer}"  # r75-fix9 INVOKES the §10.7 F-4 correction (R112c-5: attempt 3 measured api carrying NO proxy env at all, 13c:119-120,232). api reaches the filter over its EXISTING fc-ctl membership; networks MUST stay [fc-ctl, fc-data] — the retired §6.4 comment said 'moves api to fc-web membership', which would install a default route and re-open the R112b-4-class leak on this tier (spec §10.7 F-4 bullet states the amendment). Whether api's HTTP client honours these names is U-12's still-open half; §10.6's attribution rule reads the outcome, attempt 4 measures it.`,
    '      PROXY_USERNAME: ""  # present-but-empty, same shape as playwright (§6.7)',
    '      PROXY_PASSWORD: ""',
    ...(ca
      ? [
          "        NODE_EXTRA_CA_CERTS: /etc/ssl/certs/swarm-ca.pem  # §4.10: TLS through the CONNECT tunnel terminates IN this stack",
        ]
      : []),
    "    depends_on:  # mirrors the upstream graph (tmp/r78:103-112)",
    "      redis: {condition: service_started}",
    "      playwright-service: {condition: service_started}",
    "      rabbitmq: {condition: service_healthy}",
    "      nuq-postgres: {condition: service_healthy}",
    "      egress-proxy: {condition: service_started}",
    "    read_only: true  # provisional [H] U-2 — node images often need /tmp + app cache; fallback drops THIS key only",
    "    tmpfs:",
    "      - /tmp:noexec,nosuid,size=256m",
    "      - /root/.cache:noexec,nosuid,size=64m",
    `    ${CAP_DROP}`,
    `    ${SECURITY_OPT}`,
    "    cpus: 4.0  # ceilings below upstream's 4.0/8G on purpose (§7.2)",
    "    mem_limit: 6g",
    "    memswap_limit: 6g",
    ulimitsBlock(4),
    '    restart: "no"',
    loggingBlock(4),
    "    # NO healthcheck — R112b-3 (r112b live VM): the pinned api digest ships NO wget",
    "    # (/bin/sh: 1: wget: not found, FailingStreak 24) while the service served 200 on",
    "    # /v0/health/readiness — the gate could never go green (13b_live_firecrawl_rerun.md:135).",
    "    # decisions.md 2026-10-20 ruling applies the U-1 precedent: renderer drops it; row 91's",
    "    # host-side gate treats no-healthcheck as satisfied by Up + its own readiness probe.",
    "    # lint.ts HEALTHCHECK_TOOL_ABSENT refuses any future wget-on-api render.",
    "",
    "  redis:",
    `    image: ${redis.ref}`,
    commentLines(
      "data tier publishes nothing, ever (P-6 named list). Form A per U-4 default: requirepass via wrap reading its own secret file",
      4,
    ),
    labelBlock("firecrawl", version, 4, ctx.tamperLabel),
    "    networks: [fc-data]",
    '    entrypoint: ["/bin/sh", "/usr/local/bin/redis-start.sh"]',
    "    command: []  # the script execs redis-server itself with its args (§4.7)",
    "    volumes:",
    bindMount(`${p.firecrawlBin}/redis-start.sh`, "/usr/local/bin/redis-start.sh", true, 6),
    ...(redisAuth ? [bindMount(`${p.firecrawlSecrets}/redis_auth`, "/run/secrets/redis_auth", true, 6)] : []),
    "    read_only: true  # [H] U-2 fallback: drop + tmpfs /data (RDB off anyway)",
    "    tmpfs:",
    "      - /tmp:noexec,nosuid,size=16m  # REVIEW-107 MAJOR-1: the wrap writes its 0600 runtime conf here (container-private), keeping the password out of argv",
    `    ${CAP_DROP}`,
    `    ${SECURITY_OPT}`,
    "    cpus: 0.25",
    "    mem_limit: 256m",
    "    memswap_limit: 256m",
    ulimitsBlock(4),
    '    restart: "no"',
    loggingBlock(4),
    "    healthcheck:",
    '      test: ["CMD-SHELL", "REDISCLI_AUTH=\\"$(cat /run/secrets/redis_auth)\\" redis-cli ping | grep -q PONG"]  # REVIEW-107 MAJOR-1: password via the documented REDISCLI_AUTH env assignment (redis.io/tools/cli: "more safely"), argv stays clean',
    "",
    "  rabbitmq:",
    `    image: ${rabbit.ref}`,
    commentLines(
      "Form B shipped default (U-5 OFF): stock entrypoint, guest/guest confined to the internal fc-data network. NO wrap, NO secret bind — row 84 must never mount a file it did not create (D-22). Form A (wrap + bind + credentialed URL) renders only when the slot flips to generated.",
      4,
    ),
    labelBlock("firecrawl", version, 4, ctx.tamperLabel),
    "    networks: [fc-data]",
    '    command: ["rabbitmq-server"]',
    ...(rabbitCred
      ? [
          '    entrypoint: ["/bin/sh", "/usr/local/bin/rabbitmq-start.sh"]',
          "    volumes:",
          bindMount(`${p.firecrawlBin}/rabbitmq-start.sh`, "/usr/local/bin/rabbitmq-start.sh", true, 6),
          bindMount(`${p.firecrawlSecrets}/rabbitmq_password`, "/run/secrets/rabbitmq_password", true, 6),
        ]
      : []),
    "    read_only: true  # [H] U-2: mnesia lives under /var/lib/rabbitmq — named fallback for THIS service only: drop read_only (keeps the upstream boot dance)",
    `    ${CAP_DROP}`,
    "    cap_add: [SETUID, SETGID, CHOWN]  # H-R93-5 live evidence: entrypoint chowns /var/lib/rabbitmq then su-exec's to the rabbitmq user",
    `    ${SECURITY_OPT}`,
    "    cpus: 0.5",
    "    mem_limit: 512m",
    "    memswap_limit: 512m",
    ulimitsBlock(4),
    '    restart: "no"',
    loggingBlock(4),
    "    healthcheck:  # upstream-proven (tmp/r78:151-156)",
    '      test: ["CMD-SHELL", "runuser -u rabbitmq -- rabbitmq-diagnostics -q check_running"]  # R112-4 live evidence: server boots fully but root cannot read the 0400 rabbitmq-owned .erlang.cookie (eacces rc=78 -> false unhealthy gate-blocked api); same command as -u rabbitmq returned rc=0',
    "",
    "  nuq-postgres:",
    `    image: ${nuq.ref}`,
    commentLines(
      "official-style postgres entrypoint reads the generated password from the wrap (§4.7). NO named volumes anywhere in this stack: crawl data, queues and NuQ tables are EPHEMERAL by design — a privacy feature AND a lint target (§6.5)",
      4,
    ),
    labelBlock("firecrawl", version, 4, ctx.tamperLabel),
    "    networks: [fc-data]",
    '    entrypoint: ["/bin/sh", "/usr/local/bin/nuq-postgres-start.sh"]',
    "    volumes:",
    bindMount(`${p.firecrawlBin}/nuq-postgres-start.sh`, "/usr/local/bin/nuq-postgres-start.sh", true, 6),
    bindMount(`${p.firecrawlSecrets}/postgres_password`, "/run/secrets/postgres_password", true, 6),
    // redis_auth mounted for the wrap's REDIS_URL construction (REVIEW-107 MINOR-6); required slot U-4, so always present
    bindMount(`${p.firecrawlSecrets}/redis_auth`, "/run/secrets/redis_auth", true, 6),
    `    ${CAP_DROP}`,
    "    cap_add: [SETUID, SETGID, CHOWN]  # H-R93-5 live evidence: official postgres entrypoint chowns PGDATA then switches to the postgres user ('failed switching to postgres' under blanket ALL)",
    `    ${SECURITY_OPT}`,
    "    cpus: 0.5",
    "    mem_limit: 1g",
    "    memswap_limit: 1g",
    ulimitsBlock(4),
    '    restart: "no"',
    loggingBlock(4),
    "    healthcheck:  # upstream-proven (tmp/r78:175-179)",
    '      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]',
    "",
    "  playwright-service:",
    `    image: ${playwright.ref}`,
    commentLines(
      "the SSRF-capable surface; all of §10 protects through it. NEVER fc-web, NEVER fc-edge/fc-data (§6.7)",
      4,
    ),
    labelBlock("firecrawl", version, 4, ctx.tamperLabel),
    "    networks: [fc-ctl, fc-iso]",
    // The other of the two contained services the row-241 hand-off names (producer spec §5): the
    // vendor pre-check inside this image consumes exactly these hosts-file answers (§3.0 layer table).
    ...extraHostsBlock(4),
    // Marker §4.1 passes these as separate args; the landed helper takes ONE newline-joined text
    // (shared.ts::commentLines splits on \n), so the verbatim lines are carried that way.
    commentLines(
      `command override per r75-fix9 (R112c-9): the image CMD ["pnpm","start"] first-run resolves
pnpm@11.4.0 via corepack against this container's EMPTY per-boot cache (builder hydrated root's
cache only — upstream Dockerfile 6aeca442…) and under containment that fetch exits 1 (13c:92-93).
Upstream's start script IS \`node dist/api.js\` (package.json cd481a4c…); that argv was live-observed
serving :3000 in attempt 2 (13b:121). dist/ is baked by RUN pnpm run build. Keep in sync with
spec §6.7; changing it WITHOUT a re-pin note is exactly how a vendor update would drift silently.`,
      4,
    ),
    "    command: [\"node\", \"dist/api.js\"]  # r75-fix9: package manager OUT of the boot path",
    "    environment:",
    `      PORT: "${PC_PORTS.playwrightContainer}"  # PC-PORT-07 container listen (tmp/r78:62-63)`,
    `      PROXY_SERVER: "http://egress-proxy:${PC_PORTS.squidContainer}"  # THE enforced egress route (P-9 design made concrete; PC-PORT-06; register authorizes PROXY_* precisely because the filter IS the configured route, 01c0:194-198)`,
    '      PROXY_USERNAME: ""  # present-but-empty pins behaviour; the proxy trusts the fc-ctl network identity instead (§10.4)',
    '      PROXY_PASSWORD: ""',
    '      BLOCK_MEDIA: "true"  # kills img/media/font sub-resource egress — smaller audit surface [H effect name tmp/r78:69]',
    // r11 (row 240) disposed of the phantom binding this line used to claim ("bound to api's
    // CRAWL_CONCURRENT_REQUESTS (§6.4)"): the far end is a key the pinned build never reads
    // (§6.4's r11 correction above; masterplan/06_s6b_lanes_spec.md §3.4 item 1 found the
    // half-virtual coupling). The replacement carries only facts read from bytes, per §6.7.
    // C-2, the crawl lane the user's floor actually raises (row 245). Unset keeps row 241's bytes
    // verbatim, including the "this 2 is a deliberate cut" sentence, which is true only of 2; the
    // configured arm keeps every fact §6.7 required (live key, playwright's own default 10, the
    // Semaphore that enforces it) and replaces ONLY the number-bound clause, which would otherwise
    // state "2" above a different value. Neither arm re-introduces the deleted "upstream 8"
    // generalisation or the phantom CRAWL_CONCURRENT_REQUESTS binding (01e §12's row-245 line).
    ...(pages === undefined
      ? [
          '      MAX_CONCURRENT_PAGES: "2"  # LIVE key owned by the playwright image: its own default is 10',
          "      # (pw:/usr/src/app/api.ts:26-29 with the ?? '10' literal, twin dist/api.js:29, enforced as",
          "      # new Semaphore(MAX_CONCURRENT_PAGES) at :160), so this 2 is a deliberate cut, not an",
          "      # upstream match; the api-side lane controls validate independently of it (§6.7 r11 note).",
        ]
      : [
          `      MAX_CONCURRENT_PAGES: "${pages}"  # LIVE key owned by the playwright image: its own default is 10`,
          "      # (pw:/usr/src/app/api.ts:26-29 with the ?? '10' literal, twin dist/api.js:29, enforced as",
          "      # new Semaphore(MAX_CONCURRENT_PAGES) at :160). Value from ~/.swarm/setup/lanes.json",
          "      # (PC-PATH-18), validated [4,4] per row 238 §4.2 — the one crawl number this estate cut",
          "      # itself (10 -> 2) and the one the user's floor genuinely raises; env-class, so changing it",
          "      # recreates this container. The api-side lane controls validate independently of it (§6.7).",
        ]),
    '      ALLOW_LOCAL_WEBHOOKS: "false"  # the upstream flag that WOULD permit local-target crawls (tmp/r78:68) — pinned off; a truthy occurrence is a lint fail (§11)',
    '      COREPACK_ENABLE_NETWORK: "0"  # r75-fix9 belt: corepack 0.36.0 (node v22.23.3 deps/corepack 6f431b9a…) throws "Network access disabled by the environment" BEFORE any DNS (v0.36.0 httpUtils.ts:10-11, npmRegistryUtils.ts:22-23), killing the forbidden-egress intent line even if some path calls the shim off-boot',
    ...(ca
      ? [
          "      NODE_EXTRA_CA_CERTS: /etc/ssl/certs/swarm-ca.pem  # Node layer only; Chromium store pick-up is the [H] row 112 measures (§4.10)",
        ]
      : []),
    `    ${CAP_DROP}  # upstream already drops ALL (kept); cap_add stays withheld pending U-9 — RR-2 exception renders only on row-112 evidence`,
    `    ${SECURITY_OPT}`,
    "    shm_size: 1g  # chromium IPC crashes the default 64m /dev/shm [H]",
    ulimitsBlock(4, 8192, 16384),
    "    cpus: 2.0  # upstream ceiling kept; memory below upstream's 4G because the browser shares the VM with the 6g api (§7.2 math)",
    "    mem_limit: 3g",
    "    memswap_limit: 3g",
    "    read_only: true  # provisional [H] (U-2): chromium wants /tmp + app cache",
    "    tmpfs:",
    "      - /tmp:noexec,nosuid,size=1g",
    "      - /home/node/.cache:noexec,nosuid,uid=1000,gid=1000,size=256m  # R112-2 live evidence: image runs as user node (docker inspect) and dies ENOENT mkdir /home/node/.cache/node/corepack/v1 — the FIX2 /root/.cache path missed the actual user; tmpfs uid/gid=1000 makes it writable BY that user. RESIDUAL for boot-level re-run: corepack may still want NETWORK (forbidden egress here); r112's own recommendation is vendoring/disabling the package manager (COREPACK_HOME or image change), NOT a bigger tmpfs — recorded, not invented around. caps NOT added: capAdd=null proven live (checklist-1 half-green)",
    '    restart: "no"',
    loggingBlock(4),
    "    # NO healthcheck — R112b-3 (r112b live VM): same wget-absence as api (FailingStreak 9 while",
    "    # the service served 200 {\"status\":\"healthy\"} on :3000; 13b_live_firecrawl_rerun.md:135).",
    "    # U-1 precedent per the 2026-10-20 decisions.md ruling: omit; row 91's host gate owns it.",
    "",
    "  egress-proxy:",
    `    image: ${squid.ref}`,
    commentLines(
      "digest-only reference is deliberate: the repo carries NO immutable tag (all 23 tags float — 02e r78a Finding 3); the pinned build is squid 6.6 on Ubuntu 24.04 despite the README alias table (Finding 2). The rock's entrypoint is Pebble (E5): this render takes the command-override form running squid directly on the rendered §10.4 config; the Pebble-registration alternative is row 92's review call — the policy constants are identical either way.",
      4,
    ),
    labelBlock("firecrawl", version, 4, ctx.tamperLabel),
    "    networks: [fc-web, fc-ctl]  # publishes nothing; sole internet-capable member; clients reach it on fc-ctl only (§10.4 trust boundary)",
    '    entrypoint: ["/bin/sh", "-c"]  # shell presence high-confidence per the rock base; U-13 pattern applies',
    '    command: ["exec /usr/sbin/squid -N -f /etc/squid/swarm-egress.conf"]  # binary path inside the pinned digest UNVERIFIED (addendum Gaps) — row 92 confirms at first bring-up',
    "    volumes:",
    bindMount(p.firecrawlSquidConf, "/etc/squid/swarm-egress.conf", true, 6),
    "    tmpfs:",
    "      - /var/log/squid:noexec,nosuid,size=64m,mode=1777  # r75fix8_squid_sink_ruling.md §3: audit sink for access_log+cache.log; mode=1777 so the post-drop proxy uid (numeric id unknown by design, U-14 class) can create the file; size bounds it into squid's 512m cgroup; tmpfs is emptied at container stop — the idle-window zero-line baseline depends on this",
    `    ${CAP_DROP}`,
    "    cap_add: [SETUID, SETGID]  # H-R93-5 live evidence: squid initgroups+setuid drop to User proxy ('unable to set groups for User proxy' under blanket ALL)",
    `    ${SECURITY_OPT}`,
    "    cpus: 0.5",
    "    mem_limit: 512m",
    "    memswap_limit: 512m",
    ulimitsBlock(4),
    '    restart: "no"',
    loggingBlock(4),
    "",
    "# Excluded from v1 by the spec (§6.6, ratified R-5): the foundationdb pair (arm64 UNKNOWN, named volumes),",
    "# the MCP server image (npm wiring per P-19), and every host-gateway mapping (a ready-made SSRF door).",
    "# The browser service gains user: only if row 112 inspect proves the image defaults to root (U-14) — never blind-set.",
  ].join("\n")

  return {
    ok: true,
    file: {
      relPath: "firecrawl/compose/firecrawl.yml",
      content: y,
      mode: 0o644,
      stack: "firecrawl",
    },
  }
}
