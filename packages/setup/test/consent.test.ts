// Row-83 unit/integration tests for the consent flow. NO network anywhere: the consent path is
// zero-network by construction (resolveArtifact pre-flight only), and every test here additionally
// instruments globalThis.fetch with a counter so "refused before any network call" is MEASURED,
// not asserted by reading code. HOME is pointed at a throwaway dir per test (paths.ts honors
// $HOME), so consent.log/state paths land in the sandbox and the real user home is untouched.
//
// Run TARGETED (row 102 owns the full suite on this host):
//   bash packages/setup/test/consent.proofs.sh
// or: cd packages/setup && bun test test/consent.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  evaluateConsent,
  renderConsentScreen,
  computeLockSha256,
  expectedTokenValue,
  consentWasGranted,
  recordConsent,
} from "../src/consent.ts"
import { readPolicy } from "../src/policy.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { readState } from "../src/state.ts"
import { COMPONENT_IDS, PATHS, type ComponentId } from "../src/constants.ts"
import { CONSENT_BLOCKS } from "../src/consentText.ts"

// ---- source-run lock posture (same harness trick as row 82: stage src/tools.lock.json) ------
const SHIPPED_LOCK = join(import.meta.dir, "..", "tools.lock.json")
const SRC_LOCK = join(import.meta.dir, "..", "src", "tools.lock.json")
let stagedLock = false

// ---- env hygiene (r95-routed FIX2) -------------------------------------------------------------
// This suite mutates process.env.HOME per test. A combined single-process `bun test` run must
// find the ambient HOME back in place when this file's work is done, so sibling suites are never
// left reading a sandbox this file created. Snapshot at module load; restore in afterAll, which
// bun runs at the end of THIS file's lifecycle.
const ORIGINAL_HOME = process.env.HOME

beforeAll(() => {
  if (!existsSync(SRC_LOCK) && existsSync(SHIPPED_LOCK)) {
    copyFileSync(SHIPPED_LOCK, SRC_LOCK)
    stagedLock = true
  }
})
afterAll(() => {
  if (stagedLock) rmSync(SRC_LOCK, { force: true })
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME
})

// ---- fetch instrumentation ------------------------------------------------------------------
let fetchCalls = 0
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = ((...args: unknown[]) => {
    fetchCalls++
    return (realFetch as (...a: unknown[]) => unknown)(...args) as Promise<Response>
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

// ---- throwaway HOME per test ------------------------------------------------------------------
let home = ""
let lock: LockFile
function consentLogPath(): string {
  return join(home, ".swarm/setup/consent.log")
}
function readConsentLines(): Record<string, string>[] {
  if (!existsSync(consentLogPath())) return []
  return readFileSync(consentLogPath(), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, string>)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "swarm-r83-home-"))
  process.env.HOME = home
  fetchCalls = 0
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`lock must load in the harness: ${loaded.error}`)
  lock = loaded.lock
})

const ALL = COMPONENT_IDS as readonly ComponentId[]

describe("(a) interactive default-off: no input selects nothing", () => {
  it("blank answers (just Enter) consent to NOTHING and write no consent file", () => {
    const r = evaluateConsent({ selected: [...ALL], nonInteractive: false, tokens: {}, lock, ask: () => "" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.token).toBe("REFUSED_NO_CONSENT")
    expect(existsSync(consentLogPath())).toBe(false)
  })

  it("EOF (null answers) consent to NOTHING", () => {
    const r = evaluateConsent({ selected: [...ALL], nonInteractive: false, tokens: {}, lock, ask: () => null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.token).toBe("REFUSED_NO_CONSENT")
    expect(existsSync(consentLogPath())).toBe(false)
  })

  it("garbage answers ('maybe', 'YEs?', 'ok') are NOT affirmative — only y/yes grants", () => {
    const answers = ["maybe", "ok", "true", "1"]
    let i = 0
    const r = evaluateConsent({
      selected: [...ALL],
      nonInteractive: false,
      tokens: {},
      lock,
      ask: () => answers[i++ % answers.length] ?? "",
    })
    expect(r.ok).toBe(false)
    expect(existsSync(consentLogPath())).toBe(false)
  })

  it("explicit 'y' for exactly one component grants exactly that one (opt-in, per-component)", () => {
    const r = evaluateConsent({
      selected: [...ALL],
      nonInteractive: false,
      tokens: {},
      lock,
      ask: (p) => (p.includes("node?") || p.includes("Install node") ? "y" : ""),
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.consented).toEqual(["node"])
    const lines = readConsentLines()
    expect(lines.length).toBe(1)
    expect(lines[0]?.component).toBe("node")
    expect(lines[0]?.mode).toBe("interactive")
  })

  it("'YES' (case/space variants) grants; the ledger marks the component granted", () => {
    const r = evaluateConsent({ selected: ["rtk"], nonInteractive: false, tokens: {}, lock, ask: () => "  YES " })
    expect(r.ok).toBe(true)
    expect(consentWasGranted("rtk")).toBe(true)
  })
})

describe("(b) non-interactive token rule <component_id>@<lock_sha256_12>", () => {
  const full = () => computeLockSha256()

  it("missing token refuses with REFUSED_NON_INTERACTIVE and lists what is missing", () => {
    const r = evaluateConsent({ selected: ["node", "graft"], nonInteractive: true, tokens: {}, lock })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.token).toBe("REFUSED_NON_INTERACTIVE")
    expect(existsSync(consentLogPath())).toBe(false)
  })

  it("MISMATCHED token value refuses REFUSED_NON_INTERACTIVE-style (exit-1 class), writes nothing", () => {
    const r = evaluateConsent({ selected: ["node"], nonInteractive: true, tokens: { node: "node@000000000000" }, lock })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.token).toBe("REFUSED_NON_INTERACTIVE")
    expect(existsSync(consentLogPath())).toBe(false)
  })

  it("a token minted for another component id does not cross over", () => {
    const r = evaluateConsent({
      selected: ["node"],
      nonInteractive: true,
      tokens: { node: `graft@${full().slice(0, 12)}` },
      lock,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.token).toBe("REFUSED_NON_INTERACTIVE")
  })

  it("the CORRECT token grants and records mode=non-interactive with the token as evidence", () => {
    const tok = expectedTokenValue("node", full())
    expect(tok).toBe(`node@${full().slice(0, 12)}`)
    const r = evaluateConsent({ selected: ["node"], nonInteractive: true, tokens: { node: tok }, lock })
    expect(r.ok).toBe(true)
    const lines = readConsentLines()
    expect(lines.length).toBe(1)
    expect(lines[0]?.mode).toBe("non-interactive")
    expect(lines[0]?.token).toBe(tok) // §6.4: the token is public evidence, logged as such
  })

  it("tokens for UNSELECTED components are ignored with a warning and never recorded (§6.2 rule 2)", () => {
    const tok = expectedTokenValue("graft", full())
    const r = evaluateConsent({
      selected: ["node"],
      nonInteractive: true,
      tokens: { node: expectedTokenValue("node", full()), graft: tok },
      lock,
    })
    expect(r.ok).toBe(true)
    const lines = readConsentLines()
    expect(lines.map((l) => l.component)).toEqual(["node"]) // graft acceptance NOT recorded (§6.4)
  })

  it("computeLockSha256 equals an independent sha256 over the shipped lock bytes", () => {
    const direct = createHash("sha256")
      .update(new Uint8Array(readFileSync(SHIPPED_LOCK)))
      .digest("hex")
    expect(computeLockSha256()).toBe(direct)
    expect(computeLockSha256()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("(c) consent file: written ONLY on grant, PC-PATH-03 schema + modes, state engine compatible", () => {
  it("grant writes consent.log at PC-PATH-03 with mode 0600 and the five P-13 fields first", () => {
    recordConsent({ component: "node", mode: "interactive", lock })
    expect(existsSync(consentLogPath())).toBe(true)
    const mode = statSync(consentLogPath()).mode & 0o777
    expect(mode).toBe(0o600)
    const line = readConsentLines()[0] as Record<string, string>
    for (const field of ["time", "user", "component", "version", "hash"]) expect(field in line).toBe(true)
    expect(line.component).toBe("node")
    expect(line.version).toBe("v24.22.0") // single-pin component: artifact values of record (§6.5)
    expect(line.hash).toBe("6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5")
    expect(line.hash_scope).toBe("artifact")
    expect(line.user).toContain(":") // name:uid per §6.5
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it("multi-artifact components record the reviewed LOCK as version/hash of record (scope=lock)", () => {
    recordConsent({ component: "runtime", mode: "interactive", lock })
    const line = readConsentLines()[0] as Record<string, string>
    expect(line.version).toBe(lock.version)
    expect(line.hash).toBe(computeLockSha256())
    expect(line.hash_scope).toBe("lock")
  })

  it("§6.5 proposal fields ride alongside: licence, terms_url, terms_revision, mode", () => {
    recordConsent({ component: "obsidian", mode: "interactive", lock })
    const line = readConsentLines()[0] as Record<string, string>
    expect(line.licence).toBe("LicenseRef-Obsidian")
    expect(line.terms_url).toBe("https://obsidian.md/terms")
    expect(line.terms_revision).toContain("2025-02-20")
    // FOSS component carries the n/a form instead:
    recordConsent({ component: "node", mode: "interactive", lock })
    const nodeLine = readConsentLines()[1] as Record<string, string>
    expect(nodeLine.terms_url).toBe("n/a (FOSS licence)")
  })

  it("recorded lines stay pure ASCII (Indonesian texts live on the SCREEN, not the log)", () => {
    recordConsent({ component: "searxng", mode: "interactive", lock })
    recordConsent({ component: "firecrawl", mode: "interactive", lock })
    const raw = readFileSync(consentLogPath(), "utf8")
    // eslint-disable-next-line no-control-regex
    expect(/[^\x20-\x7e\n]/.test(raw)).toBe(false)
  })

  it("refusals leave NOTHING on disk: no consent.log, no state.json (row 83 gate #1)", () => {
    const r = evaluateConsent({ selected: ["searxng"], nonInteractive: true, tokens: {}, lock })
    expect(r.ok).toBe(false)
    expect(existsSync(join(home, ".swarm"))).toBe(false)
  })

  it("state engine reads cleanly alongside a written consent file (PC-PATH-02/03 coexist)", () => {
    recordConsent({ component: "graft", mode: "interactive", lock })
    const st = readState(lock.version)
    expect(st.ok).toBe(true)
    if (st.ok) expect(st.state.components.graft.state).toBe("absent") // consent alone moves no state
    expect(existsSync(join(home, ".swarm/setup/state.json"))).toBe(false) // consent never writes state
  })

  it("append keeps history: two grants produce two lines (one record per component, C-4)", () => {
    recordConsent({ component: "node", mode: "interactive", lock })
    recordConsent({ component: "rtk", mode: "interactive", lock })
    expect(readConsentLines().length).toBe(2)
  })
})

describe("(d) fetch-ordering gate: refused runs perform ZERO network calls (instrumented)", () => {
  it("non-interactive refusal: fetch counter 0 across the whole decision", () => {
    const r = evaluateConsent({ selected: [...ALL], nonInteractive: true, tokens: {}, lock })
    expect(r.ok).toBe(false)
    expect(fetchCalls).toBe(0)
  })

  it("interactive no-consent refusal: fetch counter 0", () => {
    const r = evaluateConsent({ selected: [...ALL], nonInteractive: false, tokens: {}, lock, ask: () => "" })
    expect(r.ok).toBe(false)
    expect(fetchCalls).toBe(0)
  })

  it("even a GRANT performs zero fetches itself (resolveArtifact is the zero-network pre-flight)", () => {
    const r = evaluateConsent({
      selected: ["node"],
      nonInteractive: true,
      tokens: { node: expectedTokenValue("node", computeLockSha256()) },
      lock,
    })
    expect(r.ok).toBe(true)
    expect(fetchCalls).toBe(0)
    // ...and the durable record predates any possible downstream step call: it is on disk
    // the instant evaluateConsent returns (fsync inside recordConsent).
    expect(existsSync(consentLogPath())).toBe(true)
  })

  it("screen rendering touches no network either", () => {
    const logs: string[] = []
    const real = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(" "))
    try {
      renderConsentScreen(lock, [...ALL], { dryRun: true })
    } finally {
      console.log = real
    }
    expect(fetchCalls).toBe(0)
    expect(logs.length).toBeGreaterThan(50)
  })
})

describe("consent screen content (01d fidelity, decision 12, C-2/C-3)", () => {
  function screen(ids: readonly ComponentId[]): string {
    const logs: string[] = []
    const real = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(" "))
    try {
      renderConsentScreen(lock, ids, { dryRun: false })
    } finally {
      console.log = real
    }
    return logs.join("\n")
  }

  it("prints all nine P-13 field labels per block", () => {
    const s = screen(["node"])
    for (const label of [
      "Purpose:",
      "Source URL:",
      "Version:",
      "Hash:",
      "Licence:",
      "Size:",
      "Egress statement:",
      "Paths written:",
      "Uninstall path:",
    ]) {
      expect(s.includes(label)).toBe(true)
    }
  })

  it("decision-12 language: optional + unticked by default on every block", () => {
    const s = screen(["searxng"])
    expect(s.includes("unticked by default")).toBe(true)
    expect(s.includes("[ ] searxng")).toBe(true)
  })

  it("SearXNG block carries the search-text disclosure in ENGLISH AND INDONESIAN (decision 12)", () => {
    const s = screen(["searxng"])
    expect(s.includes("Search text leaves this machine.")).toBe(true)
    expect(
      s.includes("Teks pencarian yang Anda ketik dikirim ke mesin pencari pihak ketiga di luar komputer ini."),
    ).toBe(true)
  })

  it("Firecrawl block carries the crawl disclosure in ENGLISH AND INDONESIAN", () => {
    const s = screen(["firecrawl"])
    expect(s.includes("Crawled URLs and the content of the pages fetched leave this machine")).toBe(true)
    expect(
      s.includes(
        "Permintaan crawl dan isi halaman yang diambil dikirim ke dan dari situs target di luar komputer ini.",
      ),
    ).toBe(true)
  })

  it("Obsidian terms are LINKED with the third-party sentence, never auto-accepted (C-2, §6.3)", () => {
    const s = screen(["obsidian"])
    expect(s.includes("https://obsidian.md/terms")).toBe(true)
    expect(s.includes("LINKED, never auto-accepted")).toBe(true)
    expect(s.includes("PT GSP does not accept them for you")).toBe(true)
  })

  it("live pins print exact url/version/hash/size from the lock (zero-network pre-flight, row 82 handoff)", () => {
    const s = screen(["node"])
    expect(s.includes("https://nodejs.org/dist/v24.22.0/node-v24.22.0-darwin-arm64.tar.gz")).toBe(true)
    expect(s.includes("v24.22.0")).toBe(true)
    expect(s.includes("6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5")).toBe(true)
    expect(s.includes("53,049,576 bytes")).toBe(true)
  })

  it("guest image states NO_URL_PINNED instead of hiding the gap (D-13/F-5)", () => {
    const s = screen(["runtime"])
    expect(s.includes("NO_URL_PINNED")).toBe(true)
  })

  it("stack images show digests and the dockerd-pull split (D-16b)", () => {
    const s = screen(["searxng"])
    expect(s.includes("ghcr.io/searxng/searxng@sha256:5ed0323b")).toBe(true)
    expect(s.includes("pulled by dockerd INSIDE the swarm VM")).toBe(true)
  })

  it("every offered component shows its admin token for THIS lock (§6.1: shown, never asked in advance)", () => {
    const s = screen(["rtk"])
    expect(s.includes(`Admin token for --non-interactive (rtk): rtk@${computeLockSha256().slice(0, 12)}`)).toBe(true)
  })

  it("eight blocks exist across seven ids (01d §2 map: runtime carries 4.1 AND 4.2)", () => {
    const total = ALL.reduce((n, id) => n + CONSENT_BLOCKS[id].length, 0)
    expect(total).toBe(8)
    expect(CONSENT_BLOCKS.runtime.map((b) => b.block)).toEqual(["4.1", "4.2"])
  })
})

describe("F-79-A policy hook (enforcement half; admin switch DEFERRED — decisions/decisions.md)", () => {
  const policyPath = () => join(home, PATHS.POLICY.slice(2)) // ~/.swarm/setup/policy.json under throwaway HOME

  it("absent policy file = no restrictions (v1 default: the switch does not exist)", () => {
    const p = readPolicy()
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.policy.forbidden).toEqual([])
  })

  it("forbidden components refuse EVEN WITH a valid token and never reach the screen", () => {
    mkdirSync(join(home, ".swarm/setup"), { recursive: true, mode: 0o700 })
    writeFileSync(policyPath(), JSON.stringify({ forbidden: ["searxng"] }), { mode: 0o600 })
    const p = readPolicy()
    expect(p.ok).toBe(true)
    if (!p.ok) return

    const tok = expectedTokenValue("searxng", computeLockSha256())
    const r = evaluateConsent({
      selected: ["searxng"],
      nonInteractive: true,
      tokens: { searxng: tok },
      lock,
      forbidden: p.policy.forbidden,
    })
    expect(r.ok).toBe(false) // refused despite a perfect token
    if (!r.ok) expect(r.token).toBe("REFUSED_NO_CONSENT")
    expect(existsSync(consentLogPath())).toBe(false)

    const logs: string[] = []
    const real = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(" "))
    try {
      renderConsentScreen(lock, ["node"], { dryRun: false }) // caller filters offered list; searxng absent
    } finally {
      console.log = real
    }
    expect(logs.join("\n").includes("searxng")).toBe(false)
  })

  it("partial forbid: allowed components still grant normally alongside", () => {
    mkdirSync(join(home, ".swarm/setup"), { recursive: true, mode: 0o700 })
    writeFileSync(policyPath(), JSON.stringify({ forbidden: ["firecrawl"] }), { mode: 0o600 })
    const p = readPolicy()
    if (!p.ok) throw new Error("policy should read")
    const r = evaluateConsent({
      selected: ["node", "firecrawl"],
      nonInteractive: true,
      tokens: {
        node: expectedTokenValue("node", computeLockSha256()),
        firecrawl: expectedTokenValue("firecrawl", computeLockSha256()),
      },
      lock,
      forbidden: p.policy.forbidden,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.consented).toEqual(["node"])
  })

  it("MALFORMED policy (unknown id inside) fails CLOSED — an admin control typo is never a silent no-op", () => {
    mkdirSync(join(home, ".swarm/setup"), { recursive: true, mode: 0o700 })
    writeFileSync(policyPath(), JSON.stringify({ forbidden: ["searxngg"] }), { mode: 0o600 })
    const p = readPolicy()
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.error).toContain("not a register component id")
  })

  it("unparseable policy fails closed too", () => {
    mkdirSync(join(home, ".swarm/setup"), { recursive: true, mode: 0o700 })
    writeFileSync(policyPath(), "{not json", { mode: 0o600 })
    expect(readPolicy().ok).toBe(false)
  })
})
