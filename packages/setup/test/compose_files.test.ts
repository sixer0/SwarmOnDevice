// Row 85 unit suite — compose-files renderer + lint. Run from packages/setup:
//   bun test test/compose_files.test.ts
// Not part of tsc --noEmit (tsconfig includes src/**+types/** only; r81-84 precedent).
// The renderer is pure, so every assertion here is byte-deterministic; nothing binds a
// port, nothing touches network, writes go to a throwaway dir under TMPDIR.

import { expect, describe, test } from "bun:test"
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { join } from "node:path"
import { validateLock } from "../src/lockfile.ts"
import { renderAll, applyRenderedFiles, validateRenderedSecrets } from "../src/composefiles/index.ts"
import { CAP_ADD_ALLOWLIST, findDirectiveInlineComments, findHealthcheckToolAbsent, findReservedAclNames, findSecretArgvLeak, findSquidOrderingViolations, findWrapChannelViolations, findWrapModeViolations, HEALTHCHECK_TOOL_ABSENT, lintComposeText, lintOk, PASS_THROUGH_ENV_ONLY_FORBIDDEN, PASS_THROUGH_HARD, RESERVED_ACL_NAMES, SECRET_ARGV_PATTERNS, SQUID_INLINE_COMMENT_DIRECTIVES } from "../src/composefiles/lint.ts"
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

  test("published-port citations name the decision HEADING, never a line offset (seam9 R6 / r85-fix6e)", () => {
    // These citations SHIP: each ports line is a template literal whose text is written verbatim into
    // searxng.yml / firecrawl.yml, which is why seam9 refused to fix them in its comment-only pass and
    // routed them here. Before this round nothing pinned the wording (the sweep's evidence command
    // `rg -n "as amended by the user PORT BLOCK" test/ src/ | grep -v compose.ts` exits 1), so the
    // stale offset `(decisions.md:30)` — an unrelated ruling — sat in shipped bytes unnoticed. A line
    // number rots every time decisions.md grows; the dated entry heading does not, so the heading form
    // is now under test together with the ban on the numbered form.
    const r = renderClean()
    const ANCHOR = "(decisions.md entry 'USER DECISION (PORT BLOCK, 05:33 UTC)')"
    const sites: readonly { readonly rel: string; readonly id: string; readonly portIndex: number }[] = [
      { rel: "searxng/compose/searxng.yml", id: "PC-PORT-01", portIndex: 0 },
      { rel: "firecrawl/compose/firecrawl.yml", id: "PC-PORT-02", portIndex: 1 },
    ]
    for (const s of sites) {
      const published = fileOf(r, s.rel)
        .content.split("\n")
        .filter((l) => /^\s+- "127\./.test(l))
      expect(published.length).toBe(1)
      const line = published[0]
      // the anchor must sit on the same line as the constant it amends, not merely somewhere in the file
      expect(line).toContain(`# ${s.id} as amended by the user PORT BLOCK ${ANCHOR}`)
      expect(line).not.toMatch(/decisions\.md:\d+/)
      // the citation text may never disturb the value: it still equals the register-derived pair
      expect(line).toContain(`"${publishedPortEntries()[s.portIndex]}"`)
    }
    // tree-wide: no rendered artefact cites decisions.md by number anywhere
    for (const f of r.files) expect(f.content).not.toMatch(/decisions\.md:\d+/)
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
    // r75-fix8 inverts the old `dns_v4_first on` pin: the directive is DROPPED (obsolete since
    // squid 5.0.4) and the audit log moved off /dev/stdout to a tmpfs-backed file. On CODE lines
    // (comments stripped, lint.ts's view) neither retired literal may appear and the new sink must.
    const code = q.split("\n").map((l) => l.split("#")[0] ?? "").join("\n")
    expect(code).not.toContain("dns_v4_first")
    expect(code).not.toContain("dev/stdout")
    expect(code).toContain("access_log stdio:/var/log/squid/access.log")
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
      '    restart: "no"\n    logging:\n      driver: json-file\n      options: {max-size: "5m", max-file: "2", compress: "true"}\n    # NO healthcheck — R112b-3',
      '    restart: always\n    logging:\n      driver: json-file\n      options: {max-size: "5m", max-file: "2", compress: "true"}\n    # NO healthcheck — R112b-3',
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

  test("playwright tmpfs: R112-2 SUPERSEDES the FIX2 widening — /root/.cache was the WRONG user's home", () => {
    const code = fcText()
      .split("\n")
      .map((l) => l.split("#")[0] ?? "")
      .join("\n")
    expect(code).not.toContain("- /root/.cache:noexec,nosuid,size=256m") // image runs as node (inspect), not root
    expect(code).toContain("/home/node/.cache") // corrected mount asserted in full by the R112 describe below
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
    expect(code).toContain("acl swarm_hostnames dstdomain localhost")
    expect(code).toContain("acl swarm_hostnames dstdomain .local")
    expect(code).not.toMatch(/acl\s+\S+\s+dst\s+.*\bdomain\b/)
    expect(code).not.toContain("dst localhost domain")
  })

  test("all TWELVE deny classes stay present on the IP-only dst lines and stay wired", () => {
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
      "0.0.0.0/8",
      "::/128",
      "64:ff9b::/96",
    ]
    for (const cidr of ranges) expect(t).toContain(cidr)
    expect(t).toContain("http_access deny to_localnet")
    expect(t).toContain("http_access deny swarm_hostnames")
    // ordering kept: specific denies before default-deny
    expect(t.indexOf("http_access deny swarm_hostnames")).toBeLessThan(t.indexOf("http_access deny all"))
  })
})


describe("REVIEW-107 FIX3 — secrets never reach exec'd argv", () => {
  const r = () => renderClean();
  const script = (name: string) => fileOf(r(), `firecrawl/compose/bin/${name}`).content;

  test("redis-start.sh uses the documented config-file mechanism; no --requirepass argv", () => {
    const t = script("redis-start.sh");
    expect(t).toContain('umask 077'); // 0600-effective conf on container tmpfs
    expect(t).toContain("exec redis-server /tmp/swarm-redis.conf"); // argv = conf PATH only
    expect(t).not.toMatch(/--requirepass\s+["']?\$/);
    expect(t).toContain('requirepass "%s"'); // directive lives in the FILE format (redis.io management/config)
  });

  test("redis healthcheck authenticates via REDISCLI_AUTH env assignment, not -a argv", () => {
    const t = fileOf(r(), "firecrawl/compose/firecrawl.yml").content;
    expect(t).toContain('REDISCLI_AUTH=\\"$(cat /run/secrets/redis_auth)\\" redis-cli ping');
    expect(t).not.toMatch(/redis-cli[^\n]*\s-a\s/);
  });

  test("redis service carries the /tmp tmpfs the runtime conf needs under read_only", () => {
    expect(fileOf(r(), "firecrawl/compose/firecrawl.yml").content).toContain("- /tmp:noexec,nosuid,size=16m");
  });

  test("MINOR-6: compose env carries NO REDIS_URL literal; the wrap builds both URLs from the secret", () => {
    const t = fileOf(r(), "firecrawl/compose/firecrawl.yml").content;
    const code = t.split("\n").map((l) => l.split("#")[0] ?? "").join("\n"); // prose may quote the old shape; keys may not carry it
    expect(code).not.toContain("REDIS_URL: redis://");
    expect(code).not.toContain(":pass@");
    const env = script("fc-env.sh");
    expect(env).toContain('export REDIS_URL="redis://:${REDIS_AUTH}@redis:6379"');
    expect(env).toContain('export REDIS_RATE_LIMIT_URL="redis://:${REDIS_AUTH}@redis:6379"');
    expect(env).toContain("unset REDIS_AUTH");
    // api mounts the same generated auth the server enforces (required slot -> always mounted)
    expect(t.split("/run/secrets/redis_auth").length - 1).toBeGreaterThanOrEqual(2); // api bind + redis bind
  });

  test("valkey checked: stock entrypoint, no wrap, no secret argv anywhere in stack A", () => {
    const t = fileOf(r(), "searxng/compose/searxng.yml").content;
    expect(t).not.toContain("--requirepass");
    expect(t).not.toContain("/run/secrets");
    expect(findSecretArgvLeak(t).length).toBe(0);
  });

  test("ARGV-CLEAN GATE: every rendered artefact passes findSecretArgvLeak", () => {
    for (const f of r().files) {
      expect(findSecretArgvLeak(f.content)).toEqual([]);
    }
  });

  test("negative control: the pre-fix requirepass-in-argv line IS caught by the gate", () => {
    const old = 'exec redis-server --bind 0.0.0.0 --requirepass "$(cat /run/secrets/redis_auth)"';
    const hits = findSecretArgvLeak(old);
    expect(hits.length).toBeGreaterThanOrEqual(2); // requirepass-argv AND exec-interpolated-secret
    expect(SECRET_ARGV_PATTERNS.length).toBe(3);
  });
});


describe("REVIEW-107 M2 renderer half (r75-fix4 handoff) — twelve classes + deny-before-allow", () => {
  const q = () => fileOf(renderClean(), "firecrawl/squid/squid.conf").content

  test("the three added classes sit EXACTLY per the amended §10.4 block (plain-dst lines only)", () => {
    const v4 = q().split("\n").find((l) => /^acl to_localnet dst 127\./.test(l)) ?? ""
    const v6 = q().split("\n").find((l) => /^acl to_localnet dst ::1\/128/.test(l)) ?? ""
    expect(v4.split("#")[0]).toContain(" 0.0.0.0/8") // this-network appended to the v4 line
    expect(v6.split("#")[0]).toContain(" ::/128 64:ff9b::/96") // unspecified + NAT64 appended to the v6 line
    expect(v4).not.toContain("::") // no v6 token drifts onto the v4 line
    const toks = (line: string) => line.split("#")[0].trim().split(/\s+/).slice(3) // drop "acl to_localnet dst"
    const tokens = new Set([...toks(v4), ...toks(v6)])
    expect(tokens.size).toBe(12) // twelve unique literals across the two dst lines
  })

  test("dstdomain split unchanged by the amendment", () => {
    expect(q()).toContain("acl swarm_hostnames dstdomain localhost")
    expect(q()).toContain("acl swarm_hostnames dstdomain .local")
  })

  test("rendered output satisfies deny-before-allow (ordering lint clean)", () => {
    expect(findSquidOrderingViolations(q())).toEqual([])
    const idx = (needle: string) => q().split("\n").findIndex((l) => l.trimStart().startsWith(needle))
    expect(idx("http_access deny to_localnet")).toBeLessThan(idx("http_access allow localnet"))
    expect(idx("http_access deny swarm_hostnames")).toBeLessThan(idx("http_access allow localnet"))
    expect(idx("http_access allow localnet")).toBeLessThan(idx("http_access deny all"))
  })

  test("REGRESSION FIXTURE: a reordered render (allow hoisted above the destination denies) is refused", () => {
    const lines = q().split("\n")
    const allowIdx = lines.findIndex((l) => l.trimStart().startsWith("http_access allow localnet"))
    const allowLine = lines[allowIdx] as string
    lines.splice(allowIdx, 1)
    const firstDeny = lines.findIndex((l) => l.trimStart().startsWith("http_access deny to_localnet"))
    lines.splice(firstDeny, 0, allowLine) // hoist the source-allow ABOVE all destination denies
    const reordered = lines.join("\n")
    expect(reordered).not.toBe(q())
    const findings = findSquidOrderingViolations(reordered)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((f) => f.rule === "squid-deny-ordering")).toBe(true)
    expect(findings.some((f) => f.severity === "error")).toBe(true)
  })

  test("renderAll self-lints the ordering rule (a future renderer edit cannot ship an unsorted policy)", () => {
    const r = renderClean()
    expect(r.ok).toBe(true)
    expect(r.findings.some((f) => f.rule === "squid-deny-ordering")).toBe(false)
  })
})

describe("R112 live-boot round (row 112) — reserved names, wrap modes, boot ordering", () => {
  const q = () => fileOf(renderClean(), "firecrawl/squid/squid.conf").content

  test("reserved-ACL-name lint: rendered conf declares NO predefined squid name; a re-declaring fixture refuses", () => {
    expect(findReservedAclNames(q())).toEqual([])
    expect(RESERVED_ACL_NAMES).toContain("to_localhost") // transcribed from the image note /etc/squid/squid.conf:1387
    const squatting = q() + "\nacl to_localhost dstdomain example.invalid\n"
    const hits = findReservedAclNames(squatting)
    expect(hits.length).toBe(1)
    expect(hits[0]?.rule).toBe("reserved-acl-name")
    // to_localnet deliberately NOT flagged (V6/M1 evidence: not predefined; same-type v4/v6 split fine)
    expect(findReservedAclNames(q()).some((f) => f.message.includes("to_localnet"))).toBe(false)
  })

  test("wrap modes (R112-5 + R112b-2): entrypoint-mounted token wrap 0700 sourced .envsh, sh-invoked wraps 0600, zero group/world bits", () => {
    const bins = renderClean().files.filter((f) => f.relPath.includes("/compose/bin/"))
    expect(bins.length).toBeGreaterThanOrEqual(4)
    for (const f of bins) expect(f.mode & 0o077).toBe(0)
    const nginxWrap = bins.find((f) => f.relPath.startsWith("firecrawl/compose/bin/fc-nginx-env"))
    expect(nginxWrap?.relPath).toBe("firecrawl/compose/bin/fc-nginx-env.envsh") // R112b-2: sourced channel
    expect(nginxWrap?.mode).toBe(0o700) // owner-only; zero group/world (R112-5 lineage)
    for (const name of ["fc-env.sh", "redis-start.sh", "nuq-postgres-start.sh"]) {
      expect(bins.find((f) => f.relPath.endsWith(name))?.mode).toBe(0o600)
    }
    expect(findWrapModeViolations(bins)).toEqual([])
    // negative controls: world-readable and non-executable regressions are both refused
    expect(findWrapModeViolations([{ relPath: "firecrawl/compose/bin/fc-env.sh", mode: 0o644 }]).length).toBe(1)
    expect(findWrapModeViolations([{ relPath: "firecrawl/compose/bin/fc-nginx-env.sh", mode: 0o600 }]).length).toBe(1)
  })

  test("R112-3: auth-proxy starts AFTER api (proxy_pass host resolution happens at nginx config load)", () => {
    const t = fileOf(renderClean(), "firecrawl/compose/firecrawl.yml").content
    const authBlock = t.slice(t.indexOf("  auth-proxy:"), t.indexOf("\n  api:"))
    expect(authBlock).toContain("depends_on:")
    expect(authBlock).toContain("api: {condition: service_started}")
  })

  test("R112-4: rabbitmq healthcheck runs as the rabbitmq user (root eacces on the 0400 cookie made it falsely unhealthy)", () => {
    const t = fileOf(renderClean(), "firecrawl/compose/firecrawl.yml").content
    expect(t).toContain("runuser -u rabbitmq -- rabbitmq-diagnostics -q check_running")
    expect(t).not.toContain('["CMD", "rabbitmq-diagnostics"')
  })

  test("R112-2: playwright cache tmpfs sits at the ACTUAL user's home (/home/node/.cache, uid/gid 1000)", () => {
    const t = fileOf(renderClean(), "firecrawl/compose/firecrawl.yml").content
    expect(t).toContain("- /home/node/.cache:noexec,nosuid,uid=1000,gid=1000,size=256m")
    const code = t
      .split("\n")
      .map((l) => l.split("#")[0] ?? "")
      .join("\n")
    expect(code).not.toContain("/root/.cache:noexec,nosuid,size=256m") // wrong-path mount replaced, not duplicated
  })
})

describe("R112b fix-round 6 — inline-comment directive class, .envsh token channel, healthcheck tool absence", () => {
  const r = () => renderClean()
  const q = () => fileOf(r(), "firecrawl/squid/squid.conf").content
  const fcText = () => fileOf(r(), "firecrawl/compose/firecrawl.yml").content
  const sxText = () => fileOf(r(), "searxng/compose/searxng.yml").content
  const opts = { lockVersion: lock.version }

  // ---- R112b-1: option-parsed directives carry NO inline comment (boot-class parse lint cannot see) ----

  test("GOLDEN: rendered http_port is a bare directive; its note sits on its own line above", () => {
    const portLine = q().split("\n").find((l) => l.startsWith("http_port"))
    expect(portLine).toBe(`http_port ${PC_PORTS.squidContainer}`) // value-only line (port stays artefact-derived from PC_PORTS)
    const noteIdx = q().split("\n").findIndex((l) => l.startsWith("# PC-PORT-06 squid listen"))
    const portIdx = q().split("\n").findIndex((l) => l.startsWith("http_port"))
    expect(noteIdx).toBeGreaterThanOrEqual(0)
    expect(noteIdx).toBeLessThan(portIdx) // own-line comment immediately precedes the directive
    expect(findDirectiveInlineComments(q())).toEqual([])
  })

  test("NEGATIVE: the shipped-bad inline-comment form IS refused by the new gate (and ACL lines stay exempt per live evidence)", () => {
    // reconstruction of the exact r112b shipping form (13b_live_firecrawl_rerun.md:133)
    const shippedBad = q().replace(
      `http_port ${PC_PORTS.squidContainer}\n`,
      `http_port ${PC_PORTS.squidContainer}               # PC-PORT-06 (unpublished; reachable from fc-ctl members only)\n`,
    )
    expect(shippedBad).not.toBe(q()) // fixture really mutates
    const hits = findDirectiveInlineComments(shippedBad)
    expect(hits.length).toBe(1)
    expect(hits[0]?.rule).toBe("squid-inline-comment")
    // scope honesty: acl/http_access lines DO carry inline comments in the shipped conf and squid
    // parsed them clean live (V6 + boot-past-ACL-init), so the gate must NOT flag them:
    expect(q()).toContain("acl localnet src 172.16.0.0/12        #")
    expect(findDirectiveInlineComments(q())).toEqual([])
  })

  test("renderAll self-lints the directive rule (clean render carries zero squid-inline-comment findings)", () => {
    const res = r()
    expect(res.ok).toBe(true)
    expect(res.findings.some((f) => f.rule === "squid-inline-comment")).toBe(false)
  })

  // ---- R112b-2: sourced .envsh token channel + fail-closed survival ----

  test("CHANNEL: compose mounts the wrap as /docker-entrypoint.d/05-swarm-env.envsh (sourced, ordered before 20-)", () => {
    const t = fcText()
    expect(t).toContain("target: /docker-entrypoint.d/05-swarm-env.envsh")
    expect(t).not.toContain("/docker-entrypoint.d/05-swarm-env.sh") // subshell form gone, not duplicated
    expect(t.split("/docker-entrypoint.d/05-swarm-env.envsh").length - 1).toBe(1) // single mount site
    // filename ordering is the delivery contract: 05- sorts before the image's 20-envsubst script
    const target = "/docker-entrypoint.d/05-swarm-env.envsh"
    expect(target.split("/").pop()! < "20-envsubst-on-templates.sh").toBe(true)
  })

  test("CHANNEL: the rendered wrap exports the token from the secret file, never execs, never writes the RO rootfs", () => {
    const wrap = fileOf(r(), "firecrawl/compose/bin/fc-nginx-env.envsh").content
    const code = wrap
      .split("\n")
      .map((l) => (l.trimStart().startsWith("#") ? "" : l))
      .join("\n") // executed lines only — the prose NAMES the dead paths it must not use
    expect(code).toContain('SWARM_FIRECRAWL_TOKEN="$(cat /run/secrets/proxy_token)"')
    expect(code).toMatch(/^export SWARM_FIRECRAWL_TOKEN$/m)
    expect(code).toContain('[ -n "$SWARM_FIRECRAWL_TOKEN" ]') // empty-token refusal (see below)
    expect(code).not.toMatch(/^\s*exec\s/m) // sourced code that execs kills the entrypoint itself
    expect(code).not.toContain("/docker-entrypoint.env") // the read-only append that failed live
    expect(findWrapChannelViolations(r().files)).toEqual([])
  })

  test("NEGATIVE fixtures: .sh regression, exec line, env-file write, missing export and missing empty-guard are all refused", () => {
    const good = { relPath: "firecrawl/compose/bin/fc-nginx-env.envsh", content: fileOf(r(), "firecrawl/compose/bin/fc-nginx-env.envsh").content }
    const asSh = [{ ...good, relPath: "firecrawl/compose/bin/fc-nginx-env.sh" }]
    expect(findWrapChannelViolations(asSh).some((f) => f.rule === "wrap-channel")).toBe(true)
    const withExec = [{ ...good, content: `${good.content}\nexec nginx -g "daemon off;"\n` }]
    expect(findWrapChannelViolations(withExec).some((f) => f.message.includes("exec"))).toBe(true)
    const roWrite = [{ ...good, content: good.content.replace("export SWARM_FIRECRAWL_TOKEN", 'printf "%s\\n" "$SWARM_FIRECRAWL_TOKEN" >> /docker-entrypoint.env\nexport SWARM_FIRECRAWL_TOKEN') }]
    expect(findWrapChannelViolations(roWrite).some((f) => f.message.includes("read-only rootfs"))).toBe(true)
    const noExport = [{ ...good, content: good.content.replace("export SWARM_FIRECRAWL_TOKEN", "") }]
    expect(findWrapChannelViolations(noExport).some((f) => f.message.includes("export"))).toBe(true)
    const noGuard = [{ ...good, content: good.content.split("\n").filter((l) => !l.includes('[ -n "$SWARM_FIRECRAWL_TOKEN" ]')).join("\n") }]
    expect(noGuard[0]!.content).not.toBe(good.content)
    expect(findWrapChannelViolations(noGuard).some((f) => f.message.includes("empty-token"))).toBe(true)
  })

  test("TOKEN ARRIVES through the chosen channel: sourced wrap exports, envsubst substitutes into the compare line", () => {
    // Half 1 (wrap): simulate the image mechanism on the host — `set -eu` + `. wrap` is exactly how
    // docker-entrypoint.sh consumes a *.envsh (in-process), so an export that survives the dot-source
    // is the proof the pre-fix .sh subshell could never give. Secret path retargeted to a temp file.
    const dir = join(process.env.TMPDIR ?? "/tmp", `r85f6-chan-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
    mkdirSync(dir, { recursive: true })
    const tok = "synthetic-token-value-0123456789abcdef"
    writeFileSync(join(dir, "proxy_token"), tok)
    const wrapSrc = fileOf(r(), "firecrawl/compose/bin/fc-nginx-env.envsh")
      .content.replaceAll("/run/secrets/proxy_token", join(dir, "proxy_token"))
    const wrapPath = join(dir, "05-swarm-env.envsh")
    writeFileSync(wrapPath, wrapSrc)
    writeFileSync(
      join(dir, "runner.sh"),
      `set -eu\n. '${wrapPath}'\nprintf 'GOT=[%s]' "$SWARM_FIRECRAWL_TOKEN"\n`,
    )
    const ok = spawnSync("/bin/sh", [join(dir, "runner.sh")], { encoding: "utf8" })
    expect(ok.stdout).toContain(`GOT=[${tok}]`) // export persisted through sourcing
    // Half 1b (fail-closed): empty secret -> the sourced guard exits non-zero BEFORE any export, so
    // the entrypoint dies and nginx never starts. This is the posture that replaces run 1's silent
    // empty-bearer bypass; it no longer depends on envsubst's unset-var behaviour (host GNU renders
    // empty, the container was observed leaving the literal + emerg per 13b:134 — either way this
    // guard kills the boot first).
    writeFileSync(join(dir, "proxy_token"), "")
    const dead = spawnSync("/bin/sh", [join(dir, "runner.sh")], { encoding: "utf8" })
    expect(dead.status).not.toBe(0)
    expect(dead.stdout).not.toContain("GOT=")
    // Half 2 (template): with the var in the environment, the image's whitelist-filtered envsubst puts
    // the token INTO the compare line and touches nothing else.
    if (!Bun.which("envsubst")) return // host lacks GNU envsubst -> UNKNOWN here; proofs re-run it where present
    const tpl = fileOf(r(), "firecrawl/nginx/default.conf.template").content
    const out = execFileSync("envsubst", ["${SWARM_FIRECRAWL_TOKEN}"], {
      input: tpl,
      encoding: "utf8",
      env: { ...process.env, SWARM_FIRECRAWL_TOKEN: tok },
    })
    expect(out).toContain(`Bearer ${tok}`) // token reached the rendered nginx config through the channel
    expect(out).not.toContain("${SWARM_FIRECRAWL_TOKEN}")
    expect(out).toContain("$http_authorization") // nginx runtime vars untouched by the whitelist
    expect(out).not.toContain('"Bearer "') // with a real token there is no empty-bearer accept form
  })

  // ---- R112b-3: no healthcheck may invoke a binary the pinned digest lacks ----

  test("RENDER: api and playwright ship NO healthcheck; vendor-independent ones stay; no wget/curl test line anywhere", () => {
    const t = fcText()
    const svcBlocks = (text: string) => {
      const out: Record<string, string[]> = {}
      let name = ""
      for (const l of text.split("\n")) {
        const m = l.match(/^  ([a-z][a-z0-9-]*):$|^  ([a-z][a-z0-9-]*):\s+#/)
        if (m) {
          name = (m[1] ?? m[2]) as string
          out[name] = []
          continue
        }
        if (name) out[name]?.push(l)
      }
      return out
    }
    const blocks = { ...svcBlocks(sxText()), ...svcBlocks(t) }
    const codeKey = (svc: string, key: string) =>
      (blocks[svc] ?? []).some((l) => !l.trimStart().startsWith("#") && l.trimStart().startsWith(key))
    expect(codeKey("api", "healthcheck:")).toBe(false)
    expect(codeKey("playwright-service", "healthcheck:")).toBe(false)
    for (const svc of ["redis", "rabbitmq", "nuq-postgres", "valkey", "auth-proxy"]) {
      expect(codeKey(svc, "healthcheck:")).toBe(true) // kept: tools proven to ship (U-1 table lineage)
    }
    // mechanical proof across BOTH files: every wget/curl TEST line belongs ONLY to a service whose
    // digest ships it (auth-proxy = alpine busybox, kept per 01e §6.2); the table-covered services
    // carry none — this is the render assertion R112b-3 asked for, scoped to per-digest truth.
    for (const text of [t, sxText()]) {
      let svc = ""
      for (const l of text.split("\n")) {
        const sm = l.match(/^  ([a-z][a-z0-9-]*):/)
        if (sm) svc = sm[1] as string
        if (!/^\s+test:\s*\[/.test(l) || l.trimStart().startsWith("#")) continue
        const shell = l.replace(/#.*/, "")
        if (/"wget\b/.test(shell) || /"curl\b/.test(shell)) expect(svc).toBe("auth-proxy")
      }
    }
    expect(findHealthcheckToolAbsent(t)).toEqual([])
    expect(findHealthcheckToolAbsent(sxText())).toEqual([])
  })

  test("NEGATIVE fixtures: the shipped-bad wget-on-api and curl-on-searxng forms are refused by lintComposeText", () => {
    const badApi = fcText().replace(
      "    # NO healthcheck — R112b-3 (r112b live VM): the pinned api digest ships NO wget",
      `    healthcheck:\n      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:${PC_PORTS.apiContainer}/v0/health/readiness || exit 1"]\n    # NO healthcheck — R112b-3 (r112b live VM): the pinned api digest ships NO wget`,
    )
    expect(badApi).not.toBe(fcText())
    const hitsApi = lintComposeText(badApi, opts)
    expect(lintOk(hitsApi)).toBe(false)
    expect(hitsApi.some((f) => f.rule === "healthcheck-tool-absent")).toBe(true)
    const badSx = sxText().replace(
      "    # NO healthcheck — U-1 CLOSED LIVE by row 93 (H-R93-3): the pinned digest ships no curl, so the specced",
      `    healthcheck:\n      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:${PC_PORTS.searxngPublished.container}/healthz || exit 1"]\n    # NO healthcheck — U-1 CLOSED LIVE by row 93 (H-R93-3): the pinned digest ships no curl, so the specced`,
    )
    expect(badSx).not.toBe(sxText())
    expect(lintComposeText(badSx, opts).some((f) => f.rule === "healthcheck-tool-absent")).toBe(true)
    // auth-proxy's busybox wget is NOT banned (alpine ships it): the shipped render stays green
    expect(fcText()).toContain("wget -qO /dev/null")
    expect(lintOk(lintComposeText(fcText(), opts))).toBe(true)
    // the table itself carries exactly the live-proven absences (evidence keys, nothing speculative)
    expect(Object.keys(HEALTHCHECK_TOOL_ABSENT).sort()).toEqual(["api", "playwright-service", "searxng"])
  })
})

describe("R112b-4 topology half — r75-fix6 ruling §5: containment by the internal flag, not gateway omission", () => {
  // Binding contract: delegation_progress/r75fix6_topology_ruling.md §5 (five assertions).
  // Deliberately NO assertion about an absent gateway: moby assigns 172.30.40.1 regardless of
  // whether a gateway key is written, so such an assertion is invalid per the ruling (§4 note + §5).
  const r = renderClean()
  const fcText = () => fileOf(r, "firecrawl/compose/firecrawl.yml").content
  // Standalone slice of the rendered networks: block — from the top-level key to the next one.
  function networksBlock() {
    const lines = fcText().split("\n")
    const start = lines.indexOf("networks:")
    expect(start).toBeGreaterThan(-1)
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((l) => /^[a-z]/.test(l)) // next top-level key: services:
    return rest.slice(0, end === -1 ? rest.length : end).join("\n")
  }

  test("assertion 1: the rendered networks: block parses as YAML", () => {
    const nets = Bun.YAML.parse(networksBlock())
    expect(Object.keys(nets).sort()).toEqual(["fc-ctl", "fc-data", "fc-edge", "fc-iso", "fc-web"])
    // the pinned subnet survives parsing (gateway NOT asserted — see block comment)
    expect(nets["fc-iso"].ipam.config[0].subnet).toBe("172.30.40.0/24")
  })

  test("assertion 2: fc-iso, fc-ctl and fc-data are all internal:true", () => {
    const nets = Bun.YAML.parse(networksBlock())
    expect(nets["fc-iso"].internal).toBe(true) // the flip itself — R112b-4 render half
    expect(nets["fc-ctl"].internal).toBe(true)
    expect(nets["fc-data"].internal).toBe(true)
    // textual negative pin: the disproven-premise spelling cannot silently return
    expect(fcText()).not.toContain("internal: false")
  })

  test("assertion 3: fc-web and fc-edge stay non-internal (the proxy needs one, auth-proxy needs one)", () => {
    const nets = Bun.YAML.parse(networksBlock())
    expect(nets["fc-web"].internal).toBeUndefined()
    expect(nets["fc-edge"].internal).toBeUndefined()
  })

  test("assertion 4: playwright-service attaches ONLY internal tiers [fc-ctl, fc-iso]", () => {
    const doc = Bun.YAML.parse(fcText())
    const pw = doc.services["playwright-service"].networks
    expect(pw).toEqual(["fc-ctl", "fc-iso"])
    // derived containment claim: every attachment is internal -> moby installs no default route
    for (const n of pw) expect(doc.networks[n].internal).toBe(true)
  })

  test("assertion 5: only egress-proxy lists fc-web, and only auth-proxy carries ports:", () => {
    const doc = Bun.YAML.parse(fcText())
    const onFcWeb = Object.entries(doc.services)
      .filter(([, s]) => Array.isArray(s.networks) && s.networks.includes("fc-web"))
      .map(([name]) => name)
    expect(onFcWeb).toEqual(["egress-proxy"])
    const portCarriers = Object.entries(doc.services)
      .filter(([, s]) => s.ports !== undefined)
      .map(([name]) => name)
    expect(portCarriers).toEqual(["auth-proxy"])
  })
})

describe("r75-fix8 squid sink + dns drop — binding gate r75fix8_squid_sink_ruling.md §5.3", () => {
  // The §5 delta was applied verbatim; these are the five assertions that marker names.
  const r = renderClean()
  const q = () => fileOf(r, "firecrawl/squid/squid.conf").content
  const fcText = () => fileOf(r, "firecrawl/compose/firecrawl.yml").content
  // lint.ts's comment-stripping view: a CODE line is everything left of the first '#'.
  const codeOnly = (text: string) => text.split("\n").map((l) => l.split("#")[0] ?? "").join("\n")

  test("assertion 1: exact sink code line present; NEITHER retired literal on any CODE line (comments allowed)", () => {
    const code = codeOnly(q())
    expect(code).toContain("access_log stdio:/var/log/squid/access.log")
    expect(code).not.toContain("dev/stdout") // Change 1's own note NAMES the retired path — code must not carry it
    expect(code).not.toContain("dns_v4_first")
    // prose history survives on a comment line (the WHY-stdout-was-dropped note):
    expect(q()).toContain("stdio:/dev/stdout FATALed as proxy")
  })

  test("assertion 2: egress-proxy gains exactly ONE tmpfs at /var/log/squid carrying size= and mode=1777", () => {
    const doc = Bun.YAML.parse(fcText())
    const eg = doc.services["egress-proxy"]
    expect(Array.isArray(eg.tmpfs)).toBe(true)
    expect(eg.tmpfs.length).toBe(1)
    const entry = eg.tmpfs[0] as string
    const [target, ...optGroups] = entry.split(":")
    expect(target).toBe("/var/log/squid")
    const options = optGroups.join(":").split(",").map((o) => o.trim())
    expect(options.some((o) => o.startsWith("size="))).toBe(true)
    expect(options).toContain("mode=1777")
    expect(options).toEqual(expect.arrayContaining(["noexec", "nosuid"]))
  })

  test("assertion 3: egress-proxy has NO read_only key (regression guard for §5.2's ban; U-2 owns that flip)", () => {
    const doc = Bun.YAML.parse(fcText())
    const eg = doc.services["egress-proxy"]
    // r75fix8_squid_sink_ruling.md §5.2: egress-proxy is the one hardened service WITHOUT read_only today;
    // flipping it blind re-opens the pid-file/helper-dir whack-a-mole. That decision belongs to U-2 with live evidence.
    expect(Object.prototype.hasOwnProperty.call(eg, "read_only")).toBe(false)
  })

  test("assertion 4: findDirectiveInlineComments stays [] over the new render (R112b-1 class survives the edits)", () => {
    expect(findDirectiveInlineComments(q())).toEqual([])
    expect(r.findings.some((f) => f.rule === "squid-inline-comment")).toBe(false)
  })

  test("assertion 5 (self-side): directive list is 11 members, retains both port directives, drops dns_v4_first", () => {
    // Authoritative cross-layer pin lives in row 92's test/egress_bake.test.ts "(cross-layer pin)" describe
    // (verified by reading, not edited here). This guards MY list only: their dynamic strict-longer pin
    // (SQUID_INLINE_COMMENT_DIRECTIVES.length > OPTION_PARSED_PORT_DIRECTIVES.length) re-values 12>2 -> 11>2.
    expect(SQUID_INLINE_COMMENT_DIRECTIVES.length).toBe(11)
    expect(SQUID_INLINE_COMMENT_DIRECTIVES).toContain("http_port")
    expect(SQUID_INLINE_COMMENT_DIRECTIVES).toContain("https_port")
    expect(SQUID_INLINE_COMMENT_DIRECTIVES).not.toContain("dns_v4_first")
  })
})

describe("r75-fix9 corepack disposition + F-4 api proxy — binding gate r75fix9_corepack_ruling.md §4.4", () => {
  // The six assertions the ruling names. Two independent renders back assertion 6 on this side;
  // PROOF 3/12 do the same over CLI artefacts on disk.
  const r = renderClean()
  const r2 = renderClean()
  const fcText = () => fileOf(r, "firecrawl/compose/firecrawl.yml").content
  const doc = Bun.YAML.parse(fcText())
  const pw = doc.services["playwright-service"]
  const api = doc.services.api

  test("assertion 1: playwright-service carries BOTH the command override AND the corepack env key", () => {
    // Ruling §1.1: the env-only variant of option (a) is PROVABLY INSUFFICIENT (README hydration
    // sentence, §3.4), so a render that drops the command line while keeping the env key must
    // fail HERE — both halves are asserted together, single-test, no independent pass.
    expect(pw.command).toEqual(["node", "dist/api.js"]) // string-pin: a vendor re-pin that changes the start script forces a human through this file again (§4.4)
    expect(Object.prototype.hasOwnProperty.call(pw.environment, "COREPACK_ENABLE_NETWORK")).toBe(true)
  })

  test("assertion 2: playwright env COREPACK_ENABLE_NETWORK parses to \"0\" and its raw rendered line carries no ${ interpolation (§11 style)", () => {
    expect(pw.environment.COREPACK_ENABLE_NETWORK).toBe("0")
    const raw = fcText().split("\n").find((l) => l.trimStart().startsWith("COREPACK_ENABLE_NETWORK:"))
    expect(raw).toBeDefined()
    expect(raw).not.toContain("${")
  })

  test("assertion 3: api PROXY_SERVER equals the PC_PORTS-derived URL; port pinned back to the register; PROXY_USERNAME/PASSWORD present-and-empty", () => {
    expect(api.environment.PROXY_SERVER).toBe(`http://egress-proxy:${PC_PORTS.squidContainer}`)
    // the digits inside the rendered value ARE PC_PORTS.squidContainer, so a future literal that
    // drifts from the register trips this equality (driver_rules_s3.md:13-14 rule 1)
    expect(Number(String(api.environment.PROXY_SERVER).split(":").pop())).toBe(PC_PORTS.squidContainer)
    expect(api.environment.PROXY_USERNAME).toBe("")
    expect(api.environment.PROXY_PASSWORD).toBe("")
    // source-side anti-literal pin: every construction site interpolates from PC_PORTS, none bakes the port
    const src = readFileSync(join(import.meta.dir, "..", "src/composefiles/firecrawl_compose.ts"), "utf8")
    const sites = src.split("\n").filter((l) => l.includes('PROXY_SERVER: "http://egress-proxy:'))
    expect(sites.length).toBe(2) // api + playwright
    for (const s of sites) {
      expect(s).toContain("${PC_PORTS.squidContainer}")
      expect(s).not.toMatch(/egress-proxy:3\d{3}/)
    }
  })

  test("assertion 4: api networks stay exactly [fc-ctl, fc-data] and gain no ports: key (anti-fc-web invariant)", () => {
    // Ruling §4.2: the retired §6.4 wording would have moved api to fc-web membership — a
    // non-internal attachment installs a default route and re-opens the R112b-4-class leak.
    expect(api.networks).toEqual(["fc-ctl", "fc-data"])
    expect(api.ports).toBeUndefined()
  })

  test("assertion 5: COREPACK_ENABLE_NETWORK is NOT in PASS_THROUGH_ENV_ONLY_FORBIDDEN (it is our control, not a host pass-through)", () => {
    expect(PASS_THROUGH_ENV_ONLY_FORBIDDEN).not.toContain("COREPACK_ENABLE_NETWORK")
  })

  test("assertion 6: the two changed artefacts are byte-stable across two independent renders", () => {
    // The published-hash discipline (R112c-1): values live in the fix-round record WITH their
    // render context, never as literals here — firecrawl.yml is home-dependent by design.
    expect(fileOf(r2, "firecrawl/compose/firecrawl.yml").content).toBe(fcText())
    expect(fileOf(r2, "firecrawl/squid/squid.conf").content).toBe(fileOf(r, "firecrawl/squid/squid.conf").content)
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
    expect(mode("firecrawl/compose/bin/fc-env.sh")).toBe("600") // R112-5: sh-invoked wrap, zero group/world bits
    expect(mode("firecrawl/squid/squid.conf")).toBe("644")
  })

  test("an unclean render cannot be applied", () => {
    const dirty = renderAll(lock, { home: "/Users/tester" }) // missing required secrets
    expect(() => applyRenderedFiles(dirty, "/tmp/r85-never")).toThrow()
  })
})
