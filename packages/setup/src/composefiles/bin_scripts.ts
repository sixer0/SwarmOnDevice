// Entrypoint wrap scripts — 01e §4.7 contract, rendered beside the compose files under
// <toolsRoot>/firecrawl/compose/bin/ (mode 0644 per §4.7) and bind-mounted read-only at
// the paths §6.2/§6.4/§6.5 name. Scripts read secrets from /run/secrets INSIDE the
// container: no secret value ever appears in these files, in argv, or in logs (§4.6/§4.7).
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
      'exec "$@"',
      "",
    ].join("\n"),
    mode: 0o644,
    stack: "firecrawl",
  })

  files.push({
    relPath: "firecrawl/compose/bin/redis-start.sh",
    content: [
      "#!/bin/sh",
      "# redis-start.sh — 01e §4.7 (U-4 default: requirepass ON).",
      'exec redis-server --bind 0.0.0.0 --requirepass "$(cat /run/secrets/redis_auth)"',
      "",
    ].join("\n"),
    mode: 0o644,
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
    mode: 0o644,
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
    mode: 0o644,
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
      mode: 0o644,
      stack: "firecrawl",
    })
  }

  return files
}
