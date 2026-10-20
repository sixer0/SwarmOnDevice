// compose/searxng.yml renderer — 01e §5 (Stack A), structure lifted key-for-key.
// Values: images from tools.lock.json (components.searxng.image / .valkey_image),
// ports/labels/project from constants.ts (PC-PORT-01, PC-LBL-*, PC-PROJ-01).
// Named volumes are banned across BOTH stacks (row-79 gate addition; §5.2 already bind-mounts).

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
  ulimitsBlock,
  type NormalizedCtx,
  type RenderError,
  type RenderFile,
} from "./shared.ts"
import { COMPOSE_PROJECT } from "../constants.ts"
import type { LockFile } from "../lockfile.ts"

export function renderSearxngCompose(
  lock: LockFile,
  ctx: NormalizedCtx,
): { ok: true; file: RenderFile } | { ok: false; errors: RenderError[] } {
  const image = lockImage(lock, "searxng", "image")
  if (!image.ok) return { ok: false, errors: [image.error] }
  const valkey = lockImage(lock, "searxng", "valkey_image")
  if (!valkey.ok) return { ok: false, errors: [valkey.error] }

  const p = pathsFor(ctx.toolsRoot)
  const ca = ctx.caBundlePath !== undefined // F-79-B presence flag drives the conditional block
  const version = lock.version

  const y = [
    "# compose/searxng.yml — PC-PKG-03 (rendered by the swarm-setup compose-files renderer, row 85)",
    "# Structure lifted from masterplan/01e_compose_spec.md §5 + §4; digests from tools.lock.json;",
    "# no value below is hand-picked. Run under project swarm-tools with an explicit -p (01e §3).",
    `name: ${COMPOSE_PROJECT}`,
    "",
    "# §5.1 segmentation: edge tier carries the single publish; the app/data tier has no route out.",
    "networks:",
    "  se-edge:",
    "    driver: bridge",
    "  se-int:",
    "    driver: bridge",
    "    internal: true",
    "",
    "services:",
    "  searxng:",
    `    image: ${image.ref}`,
    commentLines(
      "upstream names this service core (02e:65); renamed for label clarity — nothing references the old name in our estate",
      4,
    ),
    labelBlock("searxng", version, 4, ctx.tamperLabel),
    "    networks: [se-edge, se-int]",
    "    ports:",
    `      - "${publishedPortEntries()[0]}"  # PC-PORT-01 as amended by the user PORT BLOCK (decisions.md:30): host 9021 (was 8888, history only), container 8080 unchanged (PC-PORT-03 / 02b:128) — P-6 form`,
    "    env_file:",
    `      - ${p.searxngEnv}  # generated beside this tree; carries SEARXNG_BASE_URL only — no secret values (§4.6)`,
    ...(ca
      ? [
          "    environment:",
          "      SSL_CERT_FILE: /etc/ssl/certs/swarm-ca.pem  # §4.10 CA-bundle conditional (bundle present on host)",
        ]
      : []),
    "    volumes:",
    bindMount(p.searxngSettings, "/etc/searxng/settings.yml", true, 6),
    bindMount(p.searxngCache, "/var/cache/searxng", false, 6),
    ...(ca ? [bindMount(ctx.caBundlePath ?? "", "/etc/ssl/certs/swarm-ca.pem", true, 6)] : []),
    "    read_only: true  # provisional [H] U-2 — row 111 live check decides; fallback = drop THIS key, keep tmpfs",
    "    tmpfs:",
    "      - /tmp:noexec,nosuid,size=64m",
    `    ${CAP_DROP}`,
    `    ${SECURITY_OPT}`,
    "    cpus: 2.0",
    "    mem_limit: 512m",
    "    memswap_limit: 512m  # no swap escape (§7.2)",
    ulimitsBlock(4),
    '    restart: "no"  # stacks run ONLY while swarm-setup starts them (decision 12; §4.4)',
    loggingBlock(4),
    "    # NO healthcheck — U-1 CLOSED LIVE by row 93 (H-R93-3): the pinned digest ships no curl, so the specced",
    "    # CMD-SHELL check could never pass and the service never reached docker-healthy. Pre-decided §4.8/U-1 fallback",
    `    # applies: omit it; row 93's host-side JSON query against 127.0.0.1:${PC_PORTS.searxngPublished.host} is the authoritative gate (P-15).`,
    "",
    "  valkey:",
    `    image: ${valkey.ref}`,
    commentLines(
      "limiter companion; the limiter stays off (§8.2) so this is capacity insurance, passwordless on the private net (U-6 default, upstream companion 02e:66)",
      4,
    ),
    labelBlock("searxng", version, 4, ctx.tamperLabel),
    "    networks: [se-int]  # no edge membership, publishes nothing (P-6)",
    '    command: ["valkey-server", "--save", ""]  # stateless: no persistence, keeps read_only trivially satisfiable (U-2)',
    "    read_only: true  # provisional [H], same live-decision as above",
    `    ${CAP_DROP}`,
    "    cap_add: [SETUID, SETGID]  # H-R93-4 live evidence: stock entrypoint setpriv-drops to the valkey user ('setresuid failed' under blanket ALL); limiter stays off so this is capacity insurance only",
    `    ${SECURITY_OPT}`,
    "    cpus: 0.25",
    "    mem_limit: 128m",
    "    memswap_limit: 128m",
    ulimitsBlock(4),
    '    restart: "no"',
    loggingBlock(4),
    "    healthcheck:  # native cli ships in the alpine image; still provisional-low-confidence U-1",
    '      test: ["CMD", "valkey-cli", "ping"]',
    "      interval: 30s",
    "      timeout: 3s",
    "      retries: 3",
    "      start_period: 10s",
    "",
  ].join("\n")

  return {
    ok: true,
    file: {
      relPath: "searxng/compose/searxng.yml",
      content: y,
      mode: 0o644, // no secrets in compose files (§4.6); contents are public structure
      stack: "searxng",
    },
  }
}
