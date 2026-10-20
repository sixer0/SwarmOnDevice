// Entrypoint wrap scripts — 01e §4.7 contract, rendered beside the compose files under
// <toolsRoot>/firecrawl/compose/bin/. MODES per REVIEW-107 R112-5 (live VM): the pre-fix
// 0644 made the nginx-mounted wrap NON-EXECUTABLE and the official entrypoint SILENTLY
// IGNORES non-executable /docker-entrypoint.d scripts ('Ignoring ... not executable') ->
// SWARM_FIRECRAWL_TOKEN never reached envsubst -> empty-bearer auth BYPASS waiting to
// happen. Shipped posture: 0700 for the entrypoint-executed nginx wrap (owner-execute,
// zero group/world bits), 0600 for wraps invoked explicitly via `/bin/sh <path>`
// (mode-agnostic invocation; readable by owner only). Enforced by lint.ts
// findWrapModeViolations, run by renderAll — no bin artefact may ever carry group/world bits.
// the paths §6.2/§6.4/§6.5 name. Scripts read secrets from /run/secrets INSIDE the
// container: no secret value ever appears in these files, in argv, or in logs (§4.6/§4.7).
//
// REVIEW-107 MAJOR-1 correction (2026-10-20): the pre-fix redis wrap passed the generated
// password as an ARGV element (`--requirepass "$(cat …)"`), which `docker top` /
// /proc/<pid>/cmdline expose. Every wrap now keeps secrets out of exec'd argv by two
// documented mechanisms only: (i) shell-variable assignment + export (visible in the
// process ENVIRON, the sibling-sanctioned pattern the review itself calls "correct"), and
// (ii) for redis specifically, a runtime-generated 0600 config file on the container's
// private tmpfs — "The proper way to configure Redis is by providing a Redis configuration
// file" (redis.io/docs/latest/operate/oss_and_stack/management/config/, which also labels
// command-line config the testing-purpose form; requirepass is a file directive, example
// `requirepass "hello world"` there). The renderer NEVER sees a secret value, so the
// reviewer's alternative ("render a redis.conf containing requirepass") is realized as
// CONTAINER-SIDE generation at boot rather than a host-rendered secret file — same argv
// cleanliness, D-22 preserved.
//
// rabbitmq-start.sh renders ONLY when the U-5 slot flips to generated (D-22: never mount
// a file you did not create); the shipped default is form B (stock guest/guest on fc-data).

import { pathsFor, resolveSecretState, type NormalizedCtx, type RenderFile } from "./shared.ts"

export function renderBinScripts(ctx: NormalizedCtx): RenderFile[] {
  const p = pathsFor(ctx.toolsRoot)
  const files: RenderFile[] = []

  files.push({
    relPath: "firecrawl/compose/bin/fc-env.sh",
    content: [
      "#!/bin/sh",
      "# fc-env.sh — 01e §4.7 wrap for the api service (runs as the image's own user).",
      "BULL_AUTH_KEY=$(cat /run/secrets/bull_auth_key)",
      "POSTGRES_PASSWORD=$(cat /run/secrets/postgres_password)",
      "export BULL_AUTH_KEY POSTGRES_PASSWORD",
      "# REVIEW-107 MINOR-6: REDIS_URL is BUILT here from the SAME generated redis_auth the",
      "# server enforces — the pre-fix compose literal ':pass@' could never authenticate. Hex-only",
      "# alphabet (openssl rand -hex 32, §4.6) needs no URL encoding. Env delivery is the §4.7",
      "# wrap's documented job (same channel as the two credentials above).",
      'REDIS_AUTH="$(cat /run/secrets/redis_auth)"',
      'export REDIS_URL="redis://:${REDIS_AUTH}@redis:6379"',
      'export REDIS_RATE_LIMIT_URL="redis://:${REDIS_AUTH}@redis:6379"',
      "unset REDIS_AUTH",
      'exec "$@"',
      "",
    ].join("\n"),
    mode: 0o600, // R112-5: sh-invoked wrap; owner-read only, zero world bits
    stack: "firecrawl",
  });

  files.push({
    relPath: "firecrawl/compose/bin/redis-start.sh",
    content: [
      "#!/bin/sh",
      "# redis-start.sh — 01e §4.7 (U-4 default: requirepass ON), REVIEW-107 MAJOR-1 corrected:",
      "# the password goes into a 0600 config file on the container-private tmpfs, NEVER into",
      "# exec'd argv (docker top//proc/cmdline exposure was the defect). Config-file loading is",
      "# redis's documented proper mechanism (redis.io management/config); the official image",
      "# entrypoint execs `redis-server <args>` verbatim, so passing the conf path is its own idiom.",
      "umask 077",
      'printf \'bind 0.0.0.0\\nprotected-mode no\\nsave ""\\nrequirepass "%s"\' "$(cat /run/secrets/redis_auth)" > /tmp/swarm-redis.conf',
      "exec redis-server /tmp/swarm-redis.conf",
      "",
    ].join("\n"),
    mode: 0o600, // R112-5: sh-invoked wrap; owner-read only, zero world bits
    stack: "firecrawl",
  })

  files.push({
    relPath: "firecrawl/compose/bin/nuq-postgres-start.sh",
    content: [
      "#!/bin/sh",
      "# nuq-postgres-start.sh — 01e §4.7; official-style entrypoint reads the generated password.",
      'export POSTGRES_PASSWORD="$(cat /run/secrets/postgres_password)"',
      "exec docker-entrypoint.sh postgres",
      "",
    ].join("\n"),
    mode: 0o600, // R112-5: sh-invoked wrap; owner-read only, zero world bits
    stack: "firecrawl",
  })

  files.push({
    relPath: "firecrawl/compose/bin/fc-nginx-env.sh",
    content: [
      "#!/bin/sh",
      "# fc-nginx-env.sh — 01e §4.7/§6.2: emits SWARM_FIRECRAWL_TOKEN into docker-entrypoint.env",
      "# BEFORE the official 20-envsubst-on-templates.sh runs (ordering by filename prefix, U-10).",
      ': "${DockerEntrypointEnv:=/docker-entrypoint.env}"',
      'SWARM_FIRECRAWL_TOKEN="$(cat /run/secrets/proxy_token)"',
      'printf "%s=%s\\n" SWARM_FIRECRAWL_TOKEN "$SWARM_FIRECRAWL_TOKEN" >> "$DockerEntrypointEnv"',
      "export SWARM_FIRECRAWL_TOKEN",
      "",
    ].join("\n"),
    mode: 0o700, // R112-5: executed DIRECTLY from /docker-entrypoint.d/ — must carry owner +x; zero group/world bits
    stack: "firecrawl",
  })

  const rabbitCred = resolveSecretState({ secrets: ctx.secrets }, "firecrawl", "rabbitmq_password") === "generated"
  if (rabbitCred) {
    files.push({
      relPath: "firecrawl/compose/bin/rabbitmq-start.sh",
      content: [
        "#!/bin/sh",
        "# rabbitmq-start.sh — 01e §4.7, renders ONLY with the U-5 slot generated (form A).",
        'export RABBITMQ_DEFAULT_USER=guest RABBITMQ_DEFAULT_PASS="$(cat /run/secrets/rabbitmq_password)"',
        "exec rabbitmq-server",
        "",
      ].join("\n"),
      mode: 0o600, // R112-5: sh-invoked wrap; owner-read only, zero world bits
      stack: "firecrawl",
    })
  }

  return files
}
