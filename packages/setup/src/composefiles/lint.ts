// Compose lint (row 85 / NR-04) — the §4.9 contract one-to-one, plus the four additions
// the row-79 gate routed in (§4.9 "Additions required by row 79"): named-volume ban across
// BOTH stacks, no literal `~` in any source:/env_file:, F-79-E version-label equality
// (label == tools.lock.json:.version — catches pin bumps that move the lock but not the
// compose files), and the CA-bundle mount must be read-only when present (F-79-B).
//
// Line-scanned rather than YAML-parsed on purpose: the renderer owns the layout (two-space
// indents, long-form binds), which makes every rule mechanical and grep-reproducible —
// exactly the form §4.9 promises ("grep count of `- \"127.` = 2 per estate, 1 per file").
// One failing fixture + one passing fixture per rule lives in test/compose_files.test.ts
// (the blueprint row-85 gate sentence: "One failing and one passing fixture per rule").

import { COMPOSE_PROJECT, LABELS } from "../constants.ts"
import { publishedPortEntries } from "./shared.ts"

export type Severity = "error" | "warn"

export interface Finding {
  readonly rule: string
  readonly severity: Severity
  readonly line?: number // 1-based
  readonly message: string
}

/** §11 union list. HARD names: zero occurrences ANYWHERE in the file, comments included
 *  (zero-tolerance makes the grep trivial; the renderer's own comments avoid naming them).
 *  ENV_ONLY_FORBIDDEN arrive via the §4.7 wrap and may not be live env keys (their prose is
 *  permitted — the ratified §6.4 blocks discuss them); ALLOW_LOCAL_WEBHOOKS additionally
 *  must never be truthy (§11 policy note). */
export const PASS_THROUGH_HARD: readonly string[] = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OLLAMA_BASE_URL",
  "SLACK_WEBHOOK_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_TOKEN",
  "SUPABASE_SERVICE_TOKEN",
  "SELF_HOSTED_WEBHOOK_URL",
  "MODEL_NAME",
  "MODEL_EMBEDDING_NAME",
  "AUTUMN_SECRET_KEY",
  "TEST_API_KEY",
  "LOGGING_LEVEL",
  "SEARXNG_ENDPOINT",
  "SEARXNG_ENGINES",
  "SEARXNG_CATEGORIES",
  "NUQ_BACKEND",
  "FDB_CLUSTER_FILE",
]
export const PASS_THROUGH_ENV_ONLY_FORBIDDEN: readonly string[] = ["POSTGRES_PASSWORD", "BULL_AUTH_KEY"]
export const TRUTHY_CHECKED: readonly string[] = ["ALLOW_LOCAL_WEBHOOKS"]

/** Per-service cap_add allow-list, ratified by LIVE-VM evidence (H-R93-4/5, row 93 smoke 2026-10-20):
 *  blanket cap_drop:[ALL] killed every image whose entrypoint drops privileges, so each service may
 *  carry ONLY the listed caps — anything else (incl. SYS_ADMIN / RR-2, still pending U-9 evidence from
 *  row 112) is refused. Services absent from this map may not carry cap_add AT ALL. This supersedes
 *  01e §4.5's "ONLY SYS_ADMIN on playwright-service" sentence, which live testing disproved; the spec
 *  delta is reported for r75-fix3 rather than silently diverging. */
export const CAP_ADD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  valkey: ["SETUID", "SETGID"], // setpriv drop to valkey user (H-R93-4)
  "auth-proxy": ["SETUID", "SETGID", "CHOWN"], // nginx master->worker handoff + entrypoint chown (H-R93-5)
  rabbitmq: ["SETUID", "SETGID", "CHOWN"], // chown /var/lib/rabbitmq + su-exec (H-R93-5)
  "nuq-postgres": ["SETUID", "SETGID", "CHOWN"], // chown PGDATA + switch to postgres (H-R93-5)
  "egress-proxy": ["SETUID", "SETGID"], // initgroups + setuid drop to proxy user (H-R93-5)
}

const BANNED_CODE_SUBSTRINGS: readonly string[] = ["privileged", "network_mode", "docker.sock"]
const BANNED_ANYWHERE: readonly string[] = ["extra_hosts"] // the §4.5 host-gateway door may not even be named

export interface LintOptions {
  /** tools.lock.json .version — F-79-E asserts every label equals this exact string. */
  readonly lockVersion: string
}

interface CodeLine {
  n: number
  raw: string
  code: string // comment-stripped; blank for pure comments
  isComment: boolean
}

function toCodeLines(text: string): CodeLine[] {
  return text.split("\n").map((raw, i) => {
    const trimmed = raw.trimStart()
    const isComment = trimmed.startsWith("#") || trimmed.length === 0
    let code = raw
    if (!isComment) {
      const cut = raw.indexOf(" #")
      if (cut >= 0) code = raw.slice(0, cut)
    }
    return { n: i + 1, raw, code, isComment }
  })
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

interface PropEntry {
  line: CodeLine
  body: CodeLine[]
}

interface ServiceBlock {
  name: string
  header: CodeLine
  props: Map<string, PropEntry>
}

function walkServices(lines: CodeLine[]): ServiceBlock[] {
  const services: ServiceBlock[] = []
  let inServices = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as CodeLine
    if (/^services:\s*$/.test(l.raw)) {
      inServices = true
      continue
    }
    if (!inServices) continue
    if (!l.isComment && /^[A-Za-z]/.test(l.raw)) {
      inServices = false // next top-level key ends the block
      continue
    }
    const m = !l.isComment ? l.code.match(/^ {2}([A-Za-z][A-Za-z0-9_.-]*):\s*$/) : null
    if (!m) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const c = lines[j] as CodeLine
      if (!c.isComment && c.raw.trim().length > 0 && indentOf(c.raw) <= 2) {
        end = j
        break
      }
    }
    const props = new Map<string, PropEntry>()
    let current: PropEntry | null = null
    for (let j = i + 1; j < end; j++) {
      const c = lines[j] as CodeLine
      const pm = !c.isComment ? c.code.match(/^ {4}([A-Za-z][A-Za-z0-9_.-]*):(.*)$/) : null
      if (pm) {
        current = { line: c, body: [] }
        props.set(pm[1] as string, current)
        continue
      }
      if (current) current.body.push(c)
    }
    services.push({ name: m[1] as string, header: l, props })
    i = end - 1
  }
  return services
}

function stripQuotesAndComment(value: string): string {
  const q = value.match(/"([^"]*)"/)
  if (q) return q[1] as string
  return (value.split(/\s+#/)[0] ?? "").trim()
}

export function lintComposeText(text: string, opts: LintOptions): Finding[] {
  const findings: Finding[] = []
  const lines = toCodeLines(text)
  const push = (rule: string, message: string, line?: number, severity: Severity = "error") =>
    findings.push({ rule, severity, ...(line === undefined ? {} : { line }), message })

  // --- project name (PC-PROJ-01) ---
  const nameLine = lines.find((l) => /^name:/.test(l.raw))
  if (!nameLine) push("project-name", "missing top-level name: (PC-PROJ-01)")
  else if (stripQuotesAndComment(nameLine.code.slice(5)) !== COMPOSE_PROJECT)
    push("project-name", `top-level name must equal ${COMPOSE_PROJECT} (PC-PROJ-01)`, nameLine.n)

  // --- F-79-E: version-label equality (the pin-bump desync gate) ---
  let versionLabels = 0
  for (const l of lines) {
    const m = l.code.match(new RegExp(`${LABELS.VERSION_KEY}:\\s*"?([^"\\s#]+)"?`))
    if (!m) continue
    versionLabels += 1
    if (m[1] !== opts.lockVersion) {
      push(
        "version-label",
        `io.gsp.swarm.version "${m[1]}" != tools.lock.json .version "${opts.lockVersion}" (F-79-E)`,
        l.n,
      )
    }
  }
  if (versionLabels === 0) push("version-label", "no io.gsp.swarm.version label found (PC-LBL-03 missing)")

  // --- §11 pass-through: hard names zero occurrences ANYWHERE (comments included) ---
  for (const name of PASS_THROUGH_HARD) {
    for (const l of lines) {
      if (l.raw.includes(name))
        push("pass-through", `forbidden pass-through name "${name}" occurs in the file (§11 zero-tolerance)`, l.n)
    }
  }
  for (const name of BANNED_ANYWHERE) {
    for (const l of lines) {
      if (l.raw.includes(name)) push("banned-key", `"${name}" may not appear anywhere (§4.5)`, l.n)
    }
  }

  // --- prohibited constructs (non-comment lines) ---
  for (const l of lines) {
    if (l.isComment) continue
    for (const bad of BANNED_CODE_SUBSTRINGS) {
      if (l.code.includes(bad)) push("banned-key", `prohibited construct "${bad}" (§4.5)`, l.n)
    }
    if (/^ {2,}(pid|ipc):/.test(l.code)) push("banned-key", `host namespace key (${l.code.trim()}) §4.5`, l.n)
    if (/^\s*build:/.test(l.code)) push("build-prohibited", "build: keys are prohibited everywhere (§4.3)", l.n)
    if (l.code.includes("${"))
      push(
        "interpolation",
        "compose interpolation ${...} prohibited (§11; labels hard-code the lock value per §4.1)",
        l.n,
      )
    if (/^volumes:\s*$/.test(l.raw))
      push("named-volume", "top-level volumes: section banned across both stacks (gate addition; §6.5)", l.n)
  }

  const services = walkServices(lines)

  // --- ports: loopback prefix + exactly one published entry per file (§4.9 rule 1) +
  //     exact VALUES from the register class-7 mirror (port-block discipline, 01e §4.2 as
  //     amended: the published set is exactly 127.0.0.1:9021:8080 + 127.0.0.1:9022:8080;
  //     PC-PORT-08's 9023-9029 reservation must stay unbound here) ---
  let published = 0
  const allowedPublished = new Set(publishedPortEntries())
  for (const svc of services) {
    for (const l of svc.props.get("ports")?.body ?? []) {
      const m = l.code.match(/^\s{4,}-\s+(.*)$/)
      if (!m) continue
      published += 1
      const value = stripQuotesAndComment(m[1] ?? "")
      if (!value.startsWith("127.0.0.1:"))
        push("port-not-loopback", `${svc.name}: published port "${value}" lacks the 127.0.0.1 prefix (P-6)`, l.n)
      else if (!allowedPublished.has(value))
        push(
          "port-values",
          `${svc.name}: published port "${value}" is not one of the register-published pair (${[...allowedPublished].join(", ")}); PC-PORT-08 reserves 9023-9029 unbound`,
          l.n,
        )
    }
  }
  if (published !== 1)
    push(
      "port-count",
      `expected exactly 1 published port entry in this file (01e §4.9: 1 per file, 2 per estate at values 9021/9022); found ${published}`,
    )

  // --- images digest-pinned (P-9 / §4.9 rule 2) ---
  for (const l of lines) {
    if (l.isComment) continue
    const m = l.code.match(/^\s*image:\s*(\S+)/)
    if (m && !(m[1] as string).includes("@sha256:"))
      push("tag-without-digest", `image ref lacks @sha256 digest: ${m[1]}`, l.n)
  }

  // --- per-service hardening / labels / limits / lifecycle ---
  for (const svc of services) {
    const at = svc.header.n
    const bodyText = [...svc.props.values()].flatMap((p) => [p.line.code, ...p.body.map((l) => l.code)]).join("\n")
    for (const [key, rule, cite] of [
      ["cap_drop", "hardening-missing", "§4.5"],
      ["security_opt", "hardening-missing", "§4.5"],
      ["cpus", "limits-missing", "§7.2"],
      ["mem_limit", "limits-missing", "§7.2"],
      ["memswap_limit", "limits-missing", "§7.2 swap escape closed"],
      ["restart", "lifecycle-missing", "§4.4"],
      ["logging", "lifecycle-missing", "§4.4 bounded disk"],
    ] as const) {
      if (!svc.props.has(key)) push(rule, `${svc.name}: ${key} missing (${cite})`, at)
    }
    const restartLine = svc.props.get("restart")?.line.code ?? ""
    if (restartLine.length > 0 && !/^ {4}restart:\s*"?no"?\s*(#.*)?$/.test(restartLine)) {
      push("lifecycle", `${svc.name}: restart must be "no" (§4.4 decision 12)`, svc.props.get("restart")?.line.n ?? at)
    }
    for (const labelKey of [LABELS.MANAGED_KEY, LABELS.COMPONENT_KEY, LABELS.VERSION_KEY]) {
      if (!bodyText.includes(labelKey)) push("labels", `${svc.name}: missing ${labelKey} (PC-LBL)`, at)
    }
    const capAdd = svc.props.get("cap_add")
    if (capAdd) {
      const caps = (capAdd.line.code.match(/cap_add:\s*\[([^\]]*)\]/)?.[1] ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0) as string[]
      const allowed = CAP_ADD_ALLOWLIST[svc.name]
      if (!allowed)
        push(
          "cap-add",
          `${svc.name}: cap_add not permitted for this service (allow-list = images with live-proven privilege drops; H-R93-5)`,
          capAdd.line.n,
        )
      for (const cap of caps) {
        if (!allowed?.includes(cap))
          push(
            "cap-add",
            `${svc.name}: cap ${cap} outside the per-service allow-list [${(allowed ?? []).join(", ")}] — SYS_ADMIN/RR-2 stays withheld pending U-9 row-112 evidence`,
            capAdd.line.n,
          )
      }
    }
    if (svc.props.has("user"))
      push(
        "user-directive",
        `${svc.name}: user: set blindly — U-14 requires inspect-first`,
        svc.props.get("user")?.line.n ?? at,
      )

    const vols = svc.props.get("volumes")
    if (vols) {
      const entries: CodeLine[][] = []
      let current: CodeLine[] | null = null
      for (const l of vols.body) {
        if (/^\s{4,}-\s/.test(l.code)) {
          current = [l]
          entries.push(current)
        } else if (current) current.push(l)
      }
      for (const entry of entries) {
        const first = entry[0]
        if (first && !/^\s{4,}-\s+type:\s*bind\s*$/.test(first.code)) {
          push(
            "named-volume",
            `${svc.name}: volumes entry is not a long-form bind mount — named volumes banned in both stacks (§6.5 + gate addition)`,
            first?.n,
          )
        }
        const text = entry.map((l) => l.code).join("\n")
        if (text.includes("swarm-ca.pem") && !/read_only:\s*true/.test(text)) {
          push("ca-mount-ro", `${svc.name}: CA-bundle mount must be read_only: true (F-79-B)`, first?.n)
        }
        for (const l of entry) {
          const m = l.code.match(/^\s*source:\s*(.*)$/)
          if (!m) continue
          const value = stripQuotesAndComment(m[1] as string)
          if (value.includes("~")) push("tilde-path", `${svc.name}: bind source carries a literal ~ (A-75-1)`, l.n)
          else if (!value.startsWith("/"))
            push("tilde-path", `${svc.name}: bind source must be absolute: ${value}`, l.n)
        }
      }
    }

    for (const l of svc.props.get("environment")?.body ?? []) {
      const m = l.code.match(/^\s{4,}([A-Za-z_][A-Za-z0-9_]*):(.*)$/)
      if (!m) continue
      const key = m[1] as string
      if (PASS_THROUGH_ENV_ONLY_FORBIDDEN.includes(key)) {
        push("pass-through", `${svc.name}: ${key} must arrive via the §4.7 wrap, never as compose env (§11)`, l.n)
      }
      if (TRUTHY_CHECKED.includes(key) && !/["']?false["']?\s*$/.test((m[2] as string).trim())) {
        push("allow-local-webhooks", `${svc.name}: ALLOW_LOCAL_WEBHOOKS must be "false" (§11 truthy = fail)`, l.n)
      }
    }

    for (const l of svc.props.get("env_file")?.body ?? []) {
      const m = l.code.match(/^\s{4,}-\s+(.*)$/)
      if (!m) continue
      const value = stripQuotesAndComment(m[1] as string)
      if (value.includes("~"))
        push("tilde-path", `${svc.name}: env_file path carries a literal ~ — absolute at write time (A-75-1)`, l.n)
      else if (!value.startsWith("/")) push("tilde-path", `${svc.name}: env_file path must be absolute`, l.n)
    }
  }

  return findings
}

export function lintOk(findings: readonly Finding[]): boolean {
  return !findings.some((f) => f.severity === "error");
}

/** REVIEW-107 MAJOR-1 gate (grep-style, applies to EVERY rendered artefact — compose files AND
 *  bin wraps): a generated secret must never reach an exec'd command line. `docker top` and
 *  /proc/<pid>/cmdline expose argv to any principal on the VM host path; the sanctioned channels
 *  are env assignment/export (the review's own "correct siblings" pattern) and file delivery
 *  (redis's documented config-file mechanism). Three mechanical shapes catch the leak class: */
export const SECRET_ARGV_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: "requirepass-argv", re: /--requirepass\s+["']?\$/ }, // password interpolated as a CLI argument
  { id: "cli-auth-argv", re: /(?:^|\s)-a\s+["']?\$\(/ }, // redis-cli style -a "$(cat ...)"
  { id: "exec-interpolated-secret", re: /\bexec\b[^\n]*\$\(\s*cat\s+\/run\/secrets/ }, // exec line expanding a secret file
];

/** Returns one finding per leaked shape; empty means argv-clean across the given text. */
export function findSecretArgvLeak(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const l of toCodeLines(text)) {
    if (l.isComment) continue; // the gate is about EXECUTED lines; prose may name the shapes (this file does)
    for (const p of SECRET_ARGV_PATTERNS) {
      if (p.re.test(l.code)) findings.push({ rule: `secret-argv:${p.id}`, severity: "error", line: l.n, message: `secret material interpolated into an exec'd argument (${p.id})` });
    }
  }
  return findings;
}

/** REVIEW-107 MAJOR-2 ordering rule, as written into 01e §10.4 by r75-fix4: EVERY destination-class
 *  deny must precede ANY `http_access allow` line. The member-source `allow localnet` admits only WHO
 *  may ask, never WHERE it goes — emitted above the destination denies it would shadow them for
 *  admitted sources, which is exactly the escape M2 proved. Terminal `deny all` ordering stays r92's
 *  DEFAULT_DENY_MISORDERED job. Name-agnostic since R112-1: destination classes are DISCOVERED from
 *  the file's own `acl NAME dst|dstdomain` declarations, so renames (to_* -> swarm_*) can't blind it. */
export function findSquidOrderingViolations(text: string): Finding[] {
  const lines = toCodeLines(text)
  const destClasses = new Set<string>()
  for (const l of lines) {
    if (l.isComment) continue
    const m = l.code.match(/^\s*acl\s+(\S+)\s+(?:dst|dstdomain)\s+\S/)
    if (m?.[1]) destClasses.add(m[1])
  }
  const destDenies = lines.filter((l) => !l.isComment && destClasses.has((l.code.trim().match(/^http_access\s+deny\s+(\S+)/) ?? [])[1] ?? ""))
  const allows = lines.filter((l) => !l.isComment && /^http_access\s+allow\b/.test(l.code.trim()))
  const findings: Finding[] = [];
  for (const a of allows) {
    const below = destDenies.filter((d) => d.n > a.n);
    if (below.length > 0) {
      findings.push({ rule: "squid-deny-ordering", severity: "error", line: a.n, message: `http_access allow at line ${a.n} precedes destination-class deny/denies at ${below.map((d) => d.n).join(", ")} — deny-before-allow is mandatory for destination classes (01e §10.4 [review-107 M2]); an admitted source would bypass them` });
    }
  }
  return findings;
}

/** R112-1 (r112 live VM, squid 6.13 pinned digest): squid PREDEFINES these ACL names — the image
 *  ships the note at /etc/squid/squid.conf:1387 ("ACLs all, manager, localhost, to_localhost,
 *  to_linklocal, and CONNECT are predefined"). Redeclaring one with a different type is a boot
 *  FATAL (`aclParseAclLine: ACL 'X' already exists with different type`) — the exact crash that
 *  killed egress-proxy via our old `to_localhost`. Experiments V0-V6 isolated it to the NAME.
 *  Our declarations must therefore live in the swarm_* namespace. Same-type port ACLs
 *  (SSL_ports/Safe_ports) are NOT listed here: same-type redeclaration parsed clean on the live
 *  digest (V6 kept SSL_ports at rc=0), so only these six compiled-in names are refused. */
export const RESERVED_ACL_NAMES: readonly string[] = ["all", "manager", "localhost", "to_localhost", "to_linklocal", "CONNECT"];

export function findReservedAclNames(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const l of toCodeLines(text)) {
    if (l.isComment) continue;
    const m = l.code.match(/^\s*acl\s+(\S+)\s/);
    if (m && RESERVED_ACL_NAMES.includes(m[1] as string)) {
      findings.push({ rule: "reserved-acl-name", severity: "error", line: l.n, message: `acl '${m[1]}' collides with a squid PREDEFINED name (image note /etc/squid/squid.conf:1387) — different-type redeclaration is a boot FATAL (R112-1); declare under the swarm_* namespace instead` });
    }
  }
  return findings;
}

/** R112-5 (security-bearing): rendered wraps must carry ZERO group/world permission bits, and any
 *  wrap the container ENTRYPOINT EXECUTES directly (mounted under /docker-entrypoint.d/) must be
 *  owner-executable — the official nginx entrypoint silently IGNORES non-executable scripts, which
 *  shipped an empty bearer token (auth bypass posture). Shipped set: 0700 entrypoint-executed,
 *  0600 sh-invoked. Checked on RenderFile.mode so a regression fails at render time, not first boot. */
export function findWrapModeViolations(files: readonly { readonly relPath: string; readonly mode: number }[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    if (!f.relPath.includes("/compose/bin/")) continue;
    if ((f.mode & 0o077) !== 0) {
      findings.push({ rule: "wrap-mode", severity: "error", message: `${f.relPath}: mode 0${f.mode.toString(8)} carries group/world bits — R112-5 mandates 0700/0600 (zero group/world)` });
    }
    if (f.relPath.endsWith("fc-nginx-env.sh") && (f.mode & 0o100) === 0) {
      findings.push({ rule: "wrap-mode", severity: "error", message: `${f.relPath}: not owner-executable — the entrypoint SILENTLY ignores non-executable /docker-entrypoint.d scripts (empty-bearer bypass, R112-5)` });
    }
  }
  return findings;
}
