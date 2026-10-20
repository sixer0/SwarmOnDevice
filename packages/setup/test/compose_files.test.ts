// Row 85 unit suite — compose-files renderer + lint. Run from packages/setup:
//   bun test test/compose_files.test.ts
// Not part of tsc --noEmit (tsconfig includes src/**+types/** only; r81-84 precedent).
// The renderer is pure, so every assertion here is byte-deterministic; nothing binds a
// port, nothing touches network, writes go to a throwaway dir under TMPDIR.

import { expect, describe, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { validateLock } from "../src/lockfile.ts"
import { renderAll, applyRenderedFiles, validateRenderedSecrets } from "../src/composefiles/index.ts"
import { CAP_ADD_ALLOWLIST, lintComposeText, lintOk, PASS_THROUGH_HARD } from "../src/composefiles/lint.ts"
import {
  PC_PORTS,
  parseEngineNames,
  publishedPortEntries,
  SECRET_INVENTORY,
  type RenderContext,
} from "../src/composefiles/shared.ts"
import { renderNginxTemplate } from "../src/composefiles/nginx_template.ts"

const lockPath = join(import.meta.dir, "..", "tools.lock.json")
const parsedLock = JSON.parse(readFileSync(lockPath, "utf8"))
const loaded = validateLock(parsedLock)
if (!loaded.ok) throw new Error(`shipped lock must validate: ${loaded.error}`)
const lock = loaded.lock

function fullManifest(overrides?: {
  rabbitmq?: "generated" | "absent"
  valkey?: "generated" | "absent"
}): RenderContext["secrets"] {
  return {
    searxng: { secret_key: "generated", valkey_auth: overrides?.valkey ?? "absent" },
    firecrawl: {
      proxy_token: "generated",
      postgres_password: "generated",
      bull_auth_key: "generated",
      redis_auth: "generated",
      rabbitmq_password: overrides?.rabbitmq ?? "absent",
    },
  }
}

const baseCtx: RenderContext = { home: "/Users/tester", secrets: fullManifest() }

function renderClean() {
  const r = renderAll(lock, baseCtx)
  if (!r.ok) throw new Error(`clean render expected: ${JSON.stringify([...r.errors, ...r.findings])}`)
  return r
}
function fileOf(r: ReturnType<typeof renderClean>, rel: string) {
  const f = r.files.find((x) => x.relPath === rel)
  if (!f) throw new Error(`missing artefact ${rel}`)
  return f
}

describe("renderAll — contract vs the ratified spec", () => {
  test("renders the full estate clean, engine path = fallback here", () => {
    const r = renderClean()
    expect(r.files.length).toBe(10) // 2 compose + settings + env + nginx template + squid conf + 4 bin wraps
    expect(r.enginePath).toBe("fallback-list-of-four")
    expect(r.findings.length).toBe(0)
    expect(r.files.map((f) => f.relPath)).toContain("searxng/compose/searxng.yml")
    expect(r.files.map((f) => f.relPath)).toContain("firecrawl/compose/firecrawl.yml")
  })

  test("byte-stable: two renders are identical per artefact", () => {
    const a = renderClean()
    const b = renderClean()
    for (const fa of a.files) {
      const fb = fileOf(b, fa.relPath)
      expect(fb.content).toBe(fa.content)
      expect(fb.mode).toBe(fa.mode)
    }
  })

  test("every image line carries an @sha256 digest present in tools.lock.json", () => {
    const r = renderClean()
    const lockDigests = new Set<string>()
    for (const comp of Object.values(lock.components)) {
      for (const v of Object.values(comp)) {
        if (typeof v === "string")
          for (const m of v.matchAll(/@sha256:([0-9a-f]{64})/g)) lockDigests.add(m[1] as string)
      }
    }
    const seen = new Set<string>()
    for (const rel of ["searxng/compose/searxng.yml", "firecrawl/compose/firecrawl.yml"]) {
      for (const line of fileOf(r, rel).content.split("\n")) {
        const m = line.match(/^\s*image:\s*\S+@sha256:([0-9a-f]{64})/)
        if (!m) continue
        seen.add(m[1] as string)
        expect(lockDigests.has(m[1] as string)).toBe(true)
      }
    }
    // all nine pinned images land (2 searxng stack + 7 firecrawl stack)
    expect(seen.size).toBe(9)
  })

  test("published ports: exactly one per file, both 127.0.0.1-prefixed (P-6 / §4.9)", () => {
    const r = renderClean()
    const published = (rel: string) =>
      fileOf(r, rel)
        .content.split("\n")
        .filter((l) => /^\s+- "127\./.test(l))
    expect(published("searxng/compose/searxng.yml").length).toBe(1)
    expect(published("firecrawl/compose/firecrawl.yml").length).toBe(1)
    const all = [...published("searxng/compose/searxng.yml"), ...published("firecrawl/compose/firecrawl.yml")]
    expect(all.length).toBe(2) // grep-count proof: 2 per estate
    for (const l of all) expect(l.includes('"127.0.0.1:')).toBe(true)
    // PORT BLOCK values (register class-7 r72-fix2): exactly the derived pair, nothing else.
    const values = all.map((l) => (l.match(/"([^"]+)"/) ?? [])[1])
    expect(values.sort()).toEqual([...publishedPortEntries()].sort())
    expect(values).toContain(`127.0.0.1:${PC_PORTS.searxngPublished.host}:${PC_PORTS.searxngPublished.container}`)
    expect(values).toContain(`127.0.0.1:${PC_PORTS.firecrawlPublished.host}:${PC_PORTS.firecrawlPublished.container}`)
    // old host numbers are history: 8888 appears nowhere; 3002 survives ONLY container-side.
    const estate =
      fileOf(r, "searxng/compose/searxng.yml").content + fileOf(r, "firecrawl/compose/firecrawl.yml").content
    expect(estate).not.toMatch(/[:"]8888\b/) // never as a binding; the marked history note ("was 8888") is spec-lifted prose
    for (const line of estate.split("\n")) {
      if (!line.includes("3002")) continue
      expect(line).not.toMatch(/-\s*"127\.0\.0\.1:3002:/) // never as a published host binding
    }
    // PC-PORT-08 reservation stays unbound (values built arithmetically, no port literals here)
    for (let p = PC_PORTS.searxngPublished.host + 2; p <= PC_PORTS.searxngPublished.host + 8; p++) {
      expect(estate).not.toContain(`:${p}`)
    }
    // and NO other ports: key exists anywhere
    for (const rel of ["searxng/compose/searxng.yml", "firecrawl/compose/firecrawl.yml"]) {
      expect(
        fileOf(r, rel)
          .content.split("\n")
          .filter((l) => /^\s+ports:/.test(l)).length,
      ).toBe(1)
    }
  })

  test("labels: every service carries the three PC-LBL keys; version equals lock.version (F-79-E green)", () => {
    const r = renderClean()
    const text = fileOf(r, "searxng/compose/searxng.yml").content + fileOf(r, "firecrawl/compose/firecrawl.yml").content
    const versions = [...text.matchAll(/io\.gsp\.swarm\.version: "([^"]+)"/g)].map((m) => m[1])
    expect(versions.length).toBe(9) // 2 + 7 services
    for (const v of versions) expect(v).toBe(lock.version)
    expect(text.split("io.gsp.swarm.managed").length - 1).toBe(9)
    expect(text.split("io.gsp.swarm.component").length - 1).toBe(9)
  })

  test("no literal ~ in any source:/env_file: (A-75-1 gate addition)", () => {
    const r = renderClean()
    const text = fileOf(r, "searxng/compose/searxng.yml").content + fileOf(r, "firecrawl/compose/firecrawl.yml").content
    expect(text).not.toMatch(/source:.*~/)
    expect(text).not.toMatch(/env_file:[\s\S]*?- ~/)
  })

  test("zero occurrences of any §11 hard pass-through name (comments included)", () => {
    const r = renderClean()
    const text = fileOf(r, "searxng/compose/searxng.yml").content + fileOf(r, "firecrawl/compose/firecrawl.yml").content
    for (const name of PASS_THROUGH_HARD) expect(text.includes(name)).toBe(false)
  })

  test("settings.yml: D-07 image_proxy under server:, formats html+json, autocomplete off, four engines enabled", () => {
    const s = fileOf(renderClean(), "searxng/settings.yml").content
    expect(s).toMatch(/server:\n[\s\S]*image_proxy: false/)
    expect(s).toMatch(/formats: \[html, json\]/)
    expect(s).toMatch(/autocomplete: ""/)
    for (const e of ["wikipedia", "wikidata", "brave", "duckduckgo"]) expect(s.includes(`- name: ${e}`)).toBe(true)
    expect(s).toMatch(/categories_as_tabs: \{\}/) // fallback path marks H-11 [H]
    expect(s).toContain("[H]")
  })

  test("nginx template: auth_request form with bearer compare against the placeholder token only", () => {
    const n = fileOf(renderClean(), "firecrawl/nginx/default.conf.template").content
    expect(n).toContain("auth_request /_swarm-authz;")
    expect(n).toContain('if ($http_authorization = "Bearer ${SWARM_FIRECRAWL_TOKEN}")')
    expect(n).toContain("location = /_swarm-authz")
    expect(n).toContain("return 401")
  })

  test("nginx U-15 fallback form renders on request (inline compare, no subrequest)", () => {
    const n = renderNginxTemplate({ nginxAuthInline: true }).content
    expect(n).not.toContain("auth_request")
    expect(n).toContain('if ($http_authorization != "Bearer ${SWARM_FIRECRAWL_TOKEN}") { return 401; }')
  })

  test("squid config: private-range denies precede the allow, default-deny last (10.4 ordering)", () => {
    const q = fileOf(renderClean(), "firecrawl/squid/squid.conf").content
    const idx = (needle: string) => q.indexOf(needle)
    expect(idx("http_access deny to_localnet")).toBeGreaterThan(-1)
    expect(idx("http_access deny to_localnet")).toBeLessThan(idx("http_access allow localnet"))
    expect(idx("http_access allow localnet")).toBeLessThan(idx("http_access deny all"))
    for (const range of [
      "127.0.0.0/8",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
      "100.64.0.0/10",
      "fe80::/10",
      "fc00::/7",
    ]) {
      expect(q.includes(range)).toBe(true)
    }
    expect(q).toContain("dns_v4_first on")
  })

  test("D-22 forms: rabbit ships form B by default; form A renders only when the slot flips", () => {
    const def = fileOf(renderClean(), "firecrawl/compose/firecrawl.yml").content
    expect(def).not.toContain("/run/secrets/rabbitmq_password")
    expect(def).toContain('command: ["rabbitmq-server"]')
    const flipped = renderAll(lock, { home: "/Users/tester", secrets: fullManifest({ rabbitmq: "generated" }) })
    if (!flipped.ok) throw new Error("flip render failed")
    const fc = fileOf(flipped, "firecrawl/compose/firecrawl.yml").content
    expect(fc).toContain("/run/secrets/rabbitmq_password")
    expect(fc).toContain("rabbitmq-start.sh")
    const bins = flipped.files.map((f) => f.relPath)
    expect(bins).toContain("firecrawl/compose/bin/rabbitmq-start.sh")
  })

  test("F-79-B CA conditional: mounts + env appear only with the bundle flag, and stay read-only", () => {
    const off = renderClean()
    const offText =
      fileOf(off, "firecrawl/compose/firecrawl.yml").content + fileOf(off, "searxng/compose/searxng.yml").content
    expect(offText).not.toContain("swarm-ca.pem")
    const on = renderAll(lock, { ...baseCtx, caBundlePath: "/Users/tester/.swarm/setup/ca-bundle.pem" })
    if (!on.ok) throw new Error("CA render failed")
    const text =
      fileOf(on, "firecrawl/compose/firecrawl.yml").content + fileOf(on, "searxng/compose/searxng.yml").content
    expect(text).toContain("NODE_EXTRA_CA_CERTS")
    expect(text).toContain("SSL_CERT_FILE")
    for (const entry of text.split("- type: bind")) {
      if (!entry.includes("swarm-ca.pem")) continue
      expect(entry).toContain("read_only: true")
    }
    expect(on.findings.length).toBe(0) // CA mounts keep the lint green (F-79-B rule satisfied by construction)
  })
})

describe("secret delegation interface (d) — generate nothing, gate everything", () => {
  test("refuses to render when required secrets are not declared generated (§4.9 unset-required)", () => {
    const r = renderAll(lock, { home: "/Users/tester" })
    expect(r.ok).toBe(false)
    const codes = r.errors.filter((e) => e.code === "SECRET_REQUIRED_MISSING").map((e) => e.message)
    expect(codes.length).toBe(5) // secret_key + proxy_token + postgres_password + bull_auth_key + redis_auth
    for (const name of ["secret_key", "proxy_token", "postgres_password", "bull_auth_key", "redis_auth"]) {
      expect(codes.some((m) => m.includes(name))).toBe(true)
    }
  })

  test("manifest naming an unknown slot is refused (inventory is the §4.6 list)", () => {
    const r = renderAll(lock, {
      home: "/Users/tester",
      secrets: {
        searxng: { secret_key: "generated", nope: "generated" } as never,
        firecrawl: fullManifest()?.firecrawl,
      },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.code === "SECRET_UNDECLARED")).toBe(true)
  })

  test("the renderer never emits a secret VALUE — only paths and the $SEARXNG_SECRET indirection", () => {
    const r = renderClean()
    const all = r.files.map((f) => f.content).join("\n")
    expect(all).toContain("$SEARXNG_SECRET")
    expect(all).not.toMatch(/secret_key:\s"(?!\$SEARXNG_SECRET)/) // no literal value under the key
    expect(SECRET_INVENTORY.searxng.length + SECRET_INVENTORY.firecrawl.length).toBe(7)
  })

  test("validateRenderedSecrets refuses the placeholders and short values (P-8)", () => {
    expect(validateRenderedSecrets({ secret_key: "ultrasecretkey" }).length).toBe(1)
    expect(validateRenderedSecrets({ postgres_password: "postgres" }).length).toBe(1)
    expect(validateRenderedSecrets({ proxy_token: "short" }).length).toBe(1)
    expect(validateRenderedSecrets({ secret_key: "a".repeat(64), postgres_password: "x".repeat(40) }).length).toBe(0)
  })
})

describe("engine path (b) — fetched vs fallback, reported honestly", () => {
  const fakeDefaults = [
    "use_default_settings: true",
    "engines:",
    "  - name: google",
    "    engine: google",
    "  - name: bing",
    "  - name: wikipedia",
    "  - name: wikidata",
    "  - name: brave",
    "  - name: duckduckgo",
    "  - name: startpage",
    "search:",
    "  safe_search: 0",
  ].join("\n")

  test("parseEngineNames extracts the block, deduped and sorted", () => {
    expect(parseEngineNames(fakeDefaults)).toEqual([
      "bing",
      "brave",
      "duckduckgo",
      "google",
      "startpage",
      "wikidata",
      "wikipedia",
    ])
  })

  test("with the image's own settings supplied, settings.yml switches to the generated remove list", () => {
    const r = renderAll(lock, { ...baseCtx, enginePath: "image-settings", defaultSettings: fakeDefaults })
    if (!r.ok) throw new Error("image-settings render failed")
    expect(r.enginePath).toBe("image-settings")
    const s = fileOf(r, "searxng/settings.yml").content
    expect(s).toContain("remove:")
    expect(s).toContain("- bing")
    expect(s).toContain("- google")
    expect(s).not.toMatch(/remove:[\s\S]*- wikipedia/) // curated four are never pruned
    expect(s).not.toContain("categories_as_tabs")
    expect(r.warnings.some((w) => w.includes("image-settings"))).toBe(true)
  })

  test("auto path stays fallback when no settings text exists (this machine's case, marked [H])", () => {
    const r = renderClean()
    expect(r.enginePath).toBe("fallback-list-of-four")
    expect(r.warnings.some((w) => w.includes("fallback-list-of-four") && w.includes("row 111"))).toBe(true)
  })

  test("explicit image-settings WITHOUT the text refuses instead of silently degrading", () => {
    const r = renderAll(lock, { ...baseCtx, enginePath: "image-settings" })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.code === "ENGINE_SETTINGS_INVALID")).toBe(true)
  })
})

describe("F-79-E version-label lint (e) — the pin-bump desync gate", () => {
  test("tampered LABEL fixture: label differing from lock.version is refused by lint AND by renderAll", () => {
    const findings = lintComposeText(
      fileOf(renderClean(), "searxng/compose/searxng.yml").content.replace(
        "swarm-tools-1.19.3-r1",
        "swarm-tools-9.9.9-r9",
      ),
      {
        lockVersion: lock.version,
      },
    )
    expect(lintOk(findings)).toBe(false)
    expect(findings.some((f) => f.rule === "version-label")).toBe(true)

    const r = renderAll(lock, { ...baseCtx, _tamperVersionLabel: "swarm-tools-9.9.9-r9" })
    expect(r.ok).toBe(false)
    expect(r.findings.some((f) => f.rule === "version-label")).toBe(true)
  })

  test("tampered LOCK fixture: labels follow the lock (values come from lock, never re-hardcoded) and the stale-version lint refuses", () => {
    const tampered = JSON.parse(JSON.stringify(parsedLock))
    tampered.version = "swarm-tools-2.0.0-r9"
    const loadedTampered = validateLock(tampered)
    if (!loadedTampered.ok) throw new Error(loadedTampered.error)
    const r = renderAll(loadedTampered.lock, baseCtx)
    if (!r.ok) throw new Error("lock-driven render failed")
    const text = fileOf(r, "searxng/compose/searxng.yml").content
    expect(text).toContain('io.gsp.swarm.version: "swarm-tools-2.0.0-r9"') // rendered FROM the lock
    // a lint still asserting the OLD lock version catches the desync — this is the F-79-E protection:
    const stale = lintComposeText(text, { lockVersion: "swarm-tools-1.19.3-r1" })
    expect(lintOk(stale)).toBe(false)
    expect(stale.some((f) => f.rule === "version-label")).toBe(true)
  })
})

describe("lint fixtures — one failing + one passing per §4.9 rule (blueprint row-85 gate)", () => {
  const clean = () => renderClean()
  const sx = () => fileOf(clean(), "searxng/compose/searxng.yml").content
  const fc = () => fileOf(clean(), "firecrawl/compose/firecrawl.yml").content
  const opts = { lockVersion: lock.version }

  test("PASSING fixtures: both rendered files lint clean", () => {
    expect(lintOk(lintComposeText(sx(), opts))).toBe(true)
    expect(lintOk(lintComposeText(fc(), opts))).toBe(true)
  })

  const mutate = (text: string, from: string, to: string) => text.replace(from, to)
  const PUB = publishedPortEntries() // register-derived; no port literals below this line

  const cases: Array<[string, string, string, string]> = [
    ["port-not-loopback", sx(), `      - "${PUB[0]}"`, `      - "${PUB[0]!.replace("127.0.0.1:", "")}"`],
    ["port-not-loopback", fc(), `      - "${PUB[1]}"`, `      - "0.0.0.0:${PUB[1]!.split(":").slice(1).join(":")}"`],
    [
      "port-values",
      fc(),
      `      - "${PUB[1]}"`,
      `      - "127.0.0.1:${PC_PORTS.searxngPublished.host + 2}:${PC_PORTS.searxngPublished.container}"`,
    ],
    [
      "port-count",
      fc(),
      `      - "${PUB[1]}"`,
      `      - "${PUB[1]}"\n      - "127.0.0.1:${PC_PORTS.searxngPublished.host + 8}:${PC_PORTS.searxngPublished.container}"`,
    ],
    [
      "tag-without-digest",
      sx(),
      "    image: ghcr.io/searxng/searxng@sha256:5ed0323b5f5f8701264ef65e239a2bd83cb57098f2b971fa30bf79c06eeae271",
      "    image: ghcr.io/searxng/searxng:latest",
    ],
    ["banned-key", fc(), "    cpus: 4.0", "    privileged: true\n    cpus: 4.0"],
    [
      "banned-key",
      fc(),
      '    networks: [fc-data]\n    entrypoint: ["/bin/sh", "/usr/local/bin/redis-start.sh"]',
      '    network_mode: host\n    networks: [fc-data]\n    entrypoint: ["/bin/sh", "/usr/local/bin/redis-start.sh"]',
    ],
    [
      "banned-key",
      sx(),
      "    volumes:",
      "    volumes:\n      - type: bind\n        source: /var/run/docker.sock\n        target: /var/run/docker.sock",
    ],
    ["banned-key", sx(), "    tmpfs:", "    pid: host\n    tmpfs:"],
    ["banned-key", sx(), "# §5.1 segmentation", "# extra_hosts: anything"],
    [
      "named-volume",
      sx(),
      "    volumes:\n      - type: bind",
      "    volumes:\n      - core-data:/var/cache/searxng\n      - type: bind",
    ],
    ["named-volume", fc(), "networks:\n  fc-edge:", "volumes:\n  fdb-data:\nnetworks:\n  fc-edge:"],
    [
      "tilde-path",
      sx(),
      `        source: /Users/tester/.swarm/tools/searxng/settings.yml`,
      "        source: ~/.swarm/tools/searxng/settings.yml",
    ],
    [
      "version-label",
      sx(),
      'io.gsp.swarm.version: "swarm-tools-1.19.3-r1"',
      'io.gsp.swarm.version: "swarm-tools-0.0.0-r0"',
    ],
    // The logs bind is the one non-ro mount; turning ITS source into the CA bundle must trip F-79-B.
    [
      "ca-mount-ro",
      fc(),
      "        source: /Users/tester/.swarm/tools/firecrawl/logs",
      "        source: /etc/ssl/certs/swarm-ca.pem",
    ],
    ["pass-through", sx(), "# §5.1 segmentation", "# OPENAI_API_KEY passthrough"],
    [
      "pass-through",
      fc(),
      "      POSTGRES_HOST: nuq-postgres",
      "      POSTGRES_PASSWORD: from-env\n      POSTGRES_HOST: nuq-postgres",
    ],
    [
      "allow-local-webhooks",
      fc(),
      '      PROXY_PASSWORD: ""',
      '      PROXY_PASSWORD: ""\n      ALLOW_LOCAL_WEBHOOKS: "true"',
    ],
    ["build-prohibited", sx(), "    networks: [se-edge, se-int]", "    build: ./core\n    networks: [se-edge, se-int]"],
    ["interpolation", sx(), "    cpus: 2.0", "    cpus: ${CPU_COUNT}"],
    [
      "hardening-missing",
      sx(),
      '    cap_drop: [ALL]\n    security_opt: ["no-new-privileges:true"]\n    cpus: 2.0',
      "    cpus: 2.0",
    ],
    ["limits-missing", fc(), "    memswap_limit: 6g", ""],
    [
      "lifecycle",
      fc(),
      '    restart: "no"\n    logging:\n      driver: json-file\n      options: {max-size: "5m", max-file: "2", compress: "true"}\n    healthcheck:  # readiness',
      '    restart: always\n    logging:\n      driver: json-file\n      options: {max-size: "5m", max-file: "2", compress: "true"}\n    healthcheck:  # readiness',
    ],
    ["cap-add", fc(), "    shm_size: 1g", "    cap_add: [SYS_ADMIN]\n    shm_size: 1g"],
  ]

  for (const [rule, text, from, to] of cases) {
    test(`FAILING fixture trips ${rule}`, () => {
      const mutated = mutate(text, from, to)
      expect(mutated).not.toBe(text) // the fixture actually mutated something
      const findings = lintComposeText(mutated, opts)
      expect(lintOk(findings)).toBe(false)
      expect(findings.some((f) => f.rule === rule)).toBe(true)
    })
  }
})

describe("H-R93-4/5 hardening correction — least-privilege caps per live evidence", () => {
  const r = () => renderClean()
  const fcText = () => fileOf(r(), "firecrawl/compose/firecrawl.yml").content
  const sxText = () => fileOf(r(), "searxng/compose/searxng.yml").content

  test("allow-listed services carry EXACTLY their caps; others carry no cap_add at all", () => {
    const blocks = (t: string) => {
      const out: Record<string, string[]> = {}
      let name = ""
      for (const l of t.split("\n")) {
        const m = l.match(/^  ([a-z][a-z0-9-]*):$/)
        if (m) {
          name = m[1] as string
          out[name] = []
          continue
        }
        if (name) out[name]?.push(l)
      }
      return out
    }
    const all = { ...blocks(sxText()), ...blocks(fcText()) }
    for (const [svc, caps] of Object.entries(CAP_ADD_ALLOWLIST)) {
      const body = all[svc]
      expect(body).toBeDefined()
      expect(body.join("\n")).toContain(`cap_add: [${caps.join(", ")}]`) // EXACT set, in order
      expect(body.join("\n")).toContain("cap_drop: [ALL]") // drop stays blanket; add is the narrow exception
    }
    for (const svc of ["searxng", "redis", "api", "playwright-service"]) {
      const code = (all[svc] ?? []).map((l) => l.split("#")[0] ?? "").join("\n") // comments may NAME cap_add; keys may not carry it
      expect(code).not.toContain("cap_add")
    }
  })

  test("auth-proxy gains a writable /etc/nginx/conf.d tmpfs (envsubst target, H-R93-5)", () => {
    expect(fcText()).toContain("- /etc/nginx/conf.d:noexec,nosuid,size=8m")
  })

  test("playwright tmpfs widened to /root/.cache (corepack mkdir); still NO caps", () => {
    expect(fcText()).toContain("- /root/.cache:noexec,nosuid,size=256m")
    expect(fcText()).not.toContain("ms-playwright-hacks:noexec,size=256m") // replaced, not duplicated
  })

  test("searxng ships NO curl healthcheck — U-1 closed live (H-R93-3), host-side gate documented", () => {
    const t = sxText()
    expect(t).not.toContain("curl -fsS")
    expect(t).toContain("NO healthcheck")
    expect(t).toContain("H-R93-3")
  })

  test("FAILING fixtures: SYS_ADMIN anywhere, allowed-cap on unlisted service, out-of-set cap all refused", () => {
    const opts = { lockVersion: lock.version }
    // (a) RR-2 form still withheld on the browser service
    const sysadmin = fcText().replace("    shm_size: 1g", "    cap_add: [SYS_ADMIN]\n    shm_size: 1g")
    expect(lintComposeText(sysadmin, opts).some((f) => f.rule === "cap-add")).toBe(true)
    // (b) a listed cap on a service NOT in the allow-list
    const misplaced = sxText().replace("    cpus: 2.0", "    cap_add: [SETUID]\n    cpus: 2.0")
    expect(lintComposeText(misplaced, opts).some((f) => f.rule === "cap-add")).toBe(true)
    // (c) an out-of-set cap on an allow-listed service
    const extra = fcText().replace(
      "cap_add: [SETUID, SETGID]  # H-R93-5 live evidence: squid",
      "cap_add: [SETUID, SETGID, NET_RAW]  # H-R93-5 live evidence: squid",
    )
    expect(extra).not.toBe(fcText())
    expect(lintComposeText(extra, opts).some((f) => f.rule === "cap-add")).toBe(true)
    // (d) the shipped render itself stays clean under the same rule
    expect(lintOk(lintComposeText(fcText(), opts))).toBe(true)
    expect(lintOk(lintComposeText(sxText(), opts))).toBe(true)
  })
})

describe("H-R93-6 squid ACL grammar — split by type, semantics intact", () => {
  const q = () => fileOf(renderClean(), "firecrawl/squid/squid.conf").content

  test("hostname forms use dstdomain lines; the invalid 'dst ... domain' mix is gone from the code portion", () => {
    const code = q()
      .split("\n")
      .map((l) => l.split("#")[0] ?? "")
      .join("\n") // same discipline as r92's audit
    expect(code).toContain("acl to_localhost dstdomain localhost")
    expect(code).toContain("acl to_localhost dstdomain .local")
    expect(code).not.toMatch(/acl\s+\S+\s+dst\s+.*\bdomain\b/)
    expect(code).not.toContain("dst localhost domain")
  })

  test("all nine deny ranges stay present on the IP-only dst lines and stay wired", () => {
    const t = q()
    const ranges = [
      "127.0.0.0/8",
      "::1/128",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
      "100.64.0.0/10",
      "fe80::/10",
      "fc00::/7",
    ]
    for (const cidr of ranges) expect(t).toContain(cidr)
    expect(t).toContain("http_access deny to_localnet")
    expect(t).toContain("http_access deny to_localhost")
    // ordering kept: specific denies before default-deny
    expect(t.indexOf("http_access deny to_localhost")).toBeLessThan(t.indexOf("http_access deny all"))
  })
})

describe("applyRenderedFiles — atomic placement with register modes", () => {
  test("writes every artefact at its declared mode and returns sorted absolute paths", () => {
    const r = renderClean()
    const root = `${process.env.TMPDIR ?? "/tmp"}/r85-apply-${Date.now()}`
    const written = applyRenderedFiles(r, root)
    expect(written.length).toBe(r.files.length)
    expect(written).toEqual([...written].sort())
    const mode = (rel: string) => (statSync(join(root, rel)).mode & 0o777).toString(8)
    expect(mode("searxng/settings.yml")).toBe("600") // D-04/D-17
    expect(mode("searxng/searxng.env")).toBe("600")
    expect(mode("firecrawl/nginx/default.conf.template")).toBe("600")
    expect(mode("searxng/compose/searxng.yml")).toBe("644")
    expect(mode("firecrawl/compose/bin/fc-env.sh")).toBe("644") // §4.7 script mode
    expect(mode("firecrawl/squid/squid.conf")).toBe("644")
  })

  test("an unclean render cannot be applied", () => {
    const dirty = renderAll(lock, { home: "/Users/tester" }) // missing required secrets
    expect(() => applyRenderedFiles(dirty, "/tmp/r85-never")).toThrow()
  })
})
