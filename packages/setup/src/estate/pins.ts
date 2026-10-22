// DNS pins producer — the host-side resolve→check→pin stage that writes PC-PATH-19,
// `~/.swarm/setup/dns-pins.json` (row 266; specification = masterplan/07_s6b_p3_producer_spec.md,
// the design row created from gap G-234-1 at masterplan/05_s6b_firecrawl_repair_contract.md:352-358).
//
// WHY THIS FILE EXISTS: gate 239 chose P3 — a contained Firecrawl tier learns a public hostname from
// an injected `extra_hosts` literal rather than from a route to a resolver — and row 241 shipped the
// RENDER half (composefiles/dns_pins.ts reads this file and refuses without it). Nothing wrote the
// file. The controller named that hole and opened this row for it: "nobody writes
// ~/.swarm/setup/dns-pins.json … a renderer reading a file nothing creates … the same class as the
// delivery hole" (decisions/decisions.md:395-400). This is the producer half.
//
// THE CHECK IS THE BOUNDARY (spec §3.1). This module contains NO address logic of its own: every
// answer the host resolver returns is screened by the shipped predicates imported verbatim from
// mcpproxy/urlpolicy.ts — `checkResolvedAddresses` (:139), which calls `isDeniedAddress` (:153) — the
// same predicate the L3 proxy dials through and the same one the bake's cross-enforcer hook feeds the
// twelve class representatives through (steps/firecrawl/egress_bake.ts crossEnforcerAgreement). There
// is deliberately no second deny list here: a producer that re-spelled the ranges is exactly the drift
// that hook exists to catch (spec §6 bullet 2). The one additive leg is the positive unicast SHAPE
// (publicUnicastV4, imported from the render module so producer and consumer cannot disagree about it),
// which the twelve CIDRs do not cover — multicast 224/4 and reserved 240/4 slip past them and the
// vendor's classifier blocks a target on any non-unicast answer (spec §1.2).
//
// OUTPUT SHAPE (spec §1.2/§1.3): one entry per pinned name, one public unicast IPv4 each, IPv6
// withheld because the guest has no live v6 route (composefiles/squid_conf.ts records that measurement);
// `answersSeen` carries EVERY address the resolver returned, which is the machine-readable proof the
// screen ran on the bytes that shipped — and the set the render re-runs the predicate over.
//
// FAILURE POSTURE (spec §3.3): any failure refuses the WHOLE produce and writes NOTHING. Silently
// dropping one name sends it back to EAI_AGAIN → the vendor's false private-IP block — finding R112d-2
// hidden inside a render that looks complete. The one legal no-pins state is the ABSENT file (§3.3
// closing paragraph), which is also what an unpopulated allow-list leaves behind.
//
// THE ALLOW-LIST IS NOT THIS ROW'S TO DECIDE (spec §1.1, U-240b-1). Which hostnames are crawl targets is
// an operator/gate decision, so the set arrives as an explicit parameter; an empty set refuses to
// produce (code PINS_ALLOW_LIST_EMPTY) and touches zero bytes. Populating it stays a human decision the
// controller carries — see implementation/s6_r266_dns_pins_producer.md.
//
// SYNC/ASYNC SPLIT, stated because it is structural and not cosmetic: node exposes no synchronous DNS
// lookup, and the delivery stage this producer wires into (`deliverEstate`, row 263) is synchronous and
// its two callers are off-limits to this row. So the screening core below is pure and synchronous over
// ANSWERS IT IS HANDED, and the asynchronous resolve→check→write pipeline (`produceDnsPins`, driven
// through the resolver seam the spec names — mcpproxy/resolve.ts `systemResolver`) is a separate entry
// that a caller able to await may use. `deliverEstate` therefore produces from pre-resolved answers and
// refuses loudly (PINS_ANSWERS_UNAVAILABLE) if it is handed a non-empty allow-list without them; it can
// never silently skip. Row 246's refresh owns the async driver — see the artifact §"What stays UNKNOWN".

import { chmodSync, existsSync, readFileSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { MODES } from "../constants.ts"
import { ensureDir } from "../paths.ts"
import { atomicWriteJson } from "../atomic.ts"
import { checkResolvedAddresses, isIpLiteral, normaliseHost } from "../mcpproxy/urlpolicy.ts"
import { systemResolver, type ResolveOutcome, type Resolver } from "../mcpproxy/resolve.ts"
import { dnsPinsPath, extraHostPairProblem, publicUnicastV4 } from "../composefiles/dns_pins.ts"
import { writeSetupLog } from "../setuplog.ts"

/** Schema version of dns-pins.json, mirroring STATE_SCHEMA_VERSION (constants.ts:118) per spec §1.3. */
export const DNS_PINS_SCHEMA_VERSION = 1 as const

export interface DnsPinEntry {
  readonly hostname: string
  readonly address: string
  readonly answersSeen: readonly string[]
  readonly checkedAt: string
}

export interface DnsPinsDocument {
  readonly version: 1
  readonly generatedAt: string
  readonly pins: readonly DnsPinEntry[]
}

/** Closed refusal-code set (row 263's idiom: membership is pinned by a test, so widening needs a
 *  ruling and not a commit). Each maps to one row of producer spec §3.3's failure table. */
export const PINS_PRODUCE_CODES = [
  "PINS_ALLOW_LIST_EMPTY", // input is empty — refuse to produce, touch nothing (§1.1)
  "PINS_NAME_INVALID", // wildcard / suffix / character-shaped name: never dial it, never render it (§4 no-wildcard)
  "PINS_DUPLICATE_NAME", // one name must carry exactly one address (§4.5 statement 1)
  "PINS_RESOLVE_FAILED", // resolution threw (EAI_AGAIN / ENOTFOUND / timeout) — §3.3 row 1
  "PINS_NO_ANSWERS", // empty answer set is a DNS failure, not a policy (§3.3 row 2)
  "PINS_DENIED_ANSWER", // any answer inside the twelve classes or a denied name/suffix (§3.3 row 3)
  "PINS_NO_PUBLIC_UNICAST_V4", // all public but no renderable IPv4 unicast (§3.3 row 4 + §1.2 IPv6 posture)
  "PINS_CONSUMER_CONTRACT_MISMATCH", // our own output failed the RENDERER's screen — refuse before writing
  "PINS_ANSWERS_UNAVAILABLE", // sync stage got a non-empty list with no answers to screen (see header)
  "PINS_EXISTING_UNREADABLE", // bytes on disk exist but cannot be read — refuse rather than clobber blind
  "PINS_WRITE_FAILED", // commit or read-back failed — the file is unchanged (atomic rename)
] as const
export type PinsProduceCode = (typeof PINS_PRODUCE_CODES)[number]

export type PinsLogFn = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => void

const LOG_SOURCE = "swarm-setup.estate.pins"

/** ---------------------------------------------------------------------------------------------
 * Audit lines (spec §3.4). One greppable line per pinned name on a successful produce, and the
 * mirror line naming the class that tripped on a refusal. They live in setup.log (PC-PATH-05),
 * host-side and PRE-render, so they never pollute squid's access-log sink (row 243's accounting).
 * Built in ONE place and emitted through one call site so the two producers cannot drift apart.
 * --------------------------------------------------------------------------------------------- */
export function dnsPinOkLine(hostname: string, address: string, answersSeen: readonly string[]): string {
  return `DNSPIN ok hostname=${hostname} pinned=${address} answers_seen=${answersSeen.length} checked_against=twelve_class_deny_set verdict=PASS`
}

export function dnsPinRefuseLine(hostname: string, reason: string): string {
  return `DNSPIN refuse hostname=${hostname} reason=${reason} checked_against=twelve_class_deny_set verdict=REFUSED render=aborted`
}

/** ---------------------------------------------------------------------------------------------
 * Name-shape pre-guard. Deliberately LOOSER than the renderer's FQDN rule (dns_pins.ts HOSTNAME_FQDN,
 * which this module does not restate): it rejects only characters that can never appear in a hostname
 * we would ever render, so a wildcard or a URL-shaped input is refused BEFORE the resolver is asked —
 * and drift between this guard and the renderer's rule can only ever cause a later, louder refusal
 * (PINS_CONSUMER_CONTRACT_MISMATCH below), never a wrong accept. The authoritative name rule stays the
 * shared `extraHostPairProblem`, which runs on every candidate pair.
 * --------------------------------------------------------------------------------------------- */
const NEVER_A_HOSTNAME = /[*/:[\]%@?,\s]/
function plausibleHostname(value: string): boolean {
  if (value.length === 0) return false
  if (NEVER_A_HOSTNAME.test(value)) return false
  if (value.startsWith(".") || value.endsWith(".")) return false
  // An IP literal is never a name worth pinning (extra_hosts maps names TO answers). Asked of the
  // shipped predicate rather than a pattern of our own, so this guard adds no address logic either.
  if (isIpLiteral(value)) return false
  return true
}

/** Numeric order over dotted quads — the selection rule must not depend on resolver ordering, or a
 *  round-robin answer rotation would churn the file on an unchanged allow-list (proof 3). */
function v4Less(a: string, b: string): boolean {
  const pa = a.split(".")
  const pb = b.split(".")
  for (let i = 0; i < 4; i++) {
    const na = Number(pa[i] ?? 0)
    const nb = Number(pb[i] ?? 0)
    if (na !== nb) return na < nb
  }
  return false
}

/** Canonical audit set: deduped, lexicographically sorted. Membership is what the render re-checks
 *  (`address ∈ answersSeen`, dns_pins.ts:163), so ordering is free and determinism is not. */
function canonicalAnswers(addresses: readonly string[]): string[] {
  return Array.from(new Set(addresses)).sort()
}

type Screened = { ok: true; address: string; answersSeen: string[] } | { ok: false; code: PinsProduceCode; reason: string }

/** One name, one resolution outcome, one verdict. Every branch is a row of spec §3.3's table. */
function screenOne(hostname: string, outcome: ResolveOutcome | undefined): Screened {
  if (outcome === undefined) return { ok: false, code: "PINS_ANSWERS_UNAVAILABLE", reason: `no resolution supplied for ${hostname}` }
  if (!outcome.ok) return { ok: false, code: "PINS_RESOLVE_FAILED", reason: outcome.error }
  if (outcome.addresses.length === 0) return { ok: false, code: "PINS_NO_ANSWERS", reason: "resolver returned an empty answer set" }

  const answersSeen = canonicalAnswers(outcome.addresses)
  // THE screen: verbatim shipped predicate, over EVERY answer (v4 and v6 alike) exactly as row 94's
  // transport does (resolve.ts:159). ANY denied answer refuses the whole name — split-horizon answers
  // are rebinding behaviour, not something to pick a favourite out of (urlpolicy.ts:133-137).
  const denial = checkResolvedAddresses(answersSeen)
  if (denial !== null) return { ok: false, code: "PINS_DENIED_ANSWER", reason: `answer denied by twelve-class predicate (${denial})` }

  // Survivors only now become candidates for the ONE rendered literal: IPv4, canonical decimal form,
  // unicast-ranged, lowest-address first (order-independent selection, see v4Less).
  let address: string | null = null
  for (const a of answersSeen) {
    if (!publicUnicastV4(a)) continue // excludes IPv6 (withheld by design) and non-canonical forms
    if (address === null || v4Less(a, address)) address = a
  }
  if (address === null)
    return {
      ok: false,
      code: "PINS_NO_PUBLIC_UNICAST_V4",
      reason: `every answer was public but none is a canonical public unicast IPv4 (IPv6 withheld: the guest has no live v6 route, spec §1.2)`,
    }

  // Belt-and-braces against shipping a file the consumer will refuse: ask the RENDERER's own screen
  // about the pair we intend to write. Unreachable given the two checks above; if it ever fires, the
  // two modules have drifted and refusing here is the only honest answer.
  const mismatch = extraHostPairProblem(hostname, address)
  if (mismatch !== null) return { ok: false, code: "PINS_CONSUMER_CONTRACT_MISMATCH", reason: mismatch }

  return { ok: true, address, answersSeen }
}

export type PinsBuild =
  | { readonly ok: true; readonly document: DnsPinsDocument }
  | { readonly ok: false; readonly code: PinsProduceCode; readonly hostname: string; readonly reason: string }

/**
 * The pure screening core: takes the allow-list plus whatever the resolver answered for each RAW
 * name, and returns either a complete validated document or the single refusal that aborted it.
 * No fs, no network, no clock (the timestamp is injected) — which is what lets the unit lane drive
 * every poisoned-answer case through the SAME code the product uses.
 */
export function buildPinsDocument(
  hostnames: readonly string[],
  answers: Readonly<Record<string, ResolveOutcome>>,
  generatedAt: string,
): PinsBuild {
  if (hostnames.length === 0)
    return { ok: false, code: "PINS_ALLOW_LIST_EMPTY", hostname: "-", reason: "no crawl-target hostnames supplied — populating the allow-list is an operator/gate decision (spec §1.1, U-240b-1)" }

  const pins: DnsPinEntry[] = []
  const seen = new Set<string>()
  for (const raw of [...hostnames].sort()) {
    const hostname = normaliseHost(raw) // lowercase, root-dot and zone-id stripped
    if (!plausibleHostname(hostname))
      return { ok: false, code: "PINS_NAME_INVALID", hostname: raw, reason: "not a bare hostname (wildcards, URLs, IP literals and suffix forms are refused before any lookup — spec §4)" }
    if (seen.has(hostname)) return { ok: false, code: "PINS_DUPLICATE_NAME", hostname, reason: "the same name appears twice in the allow-list; one name must carry exactly one address" }
    seen.add(hostname)

    const screened = screenOne(hostname, answers[raw] ?? answers[hostname])
    if (!screened.ok) return { ok: false, code: screened.code, hostname, reason: screened.reason }
    pins.push({ hostname, address: screened.address, answersSeen: screened.answersSeen, checkedAt: generatedAt })
  }
  return { ok: true, document: { version: DNS_PINS_SCHEMA_VERSION, generatedAt, pins } }
}

/** ---------------------------------------------------------------------------------------------
 * Commit (content-addressed no-write). Same discipline as row 263's planArtefacts (deliver.ts:331):
 * compare bytes AND mode first, touch nothing that already matches, so a re-run over unchanged
 * answers leaves every mtime frozen — blueprint 10's residue assertions use `find -newer` and a
 * rewriting producer would fail them. Timestamps are part of the payload, so equality is decided on
 * the SEMANTIC pin set (name, address, answer set), not on the serialized text: an unchanged set keeps
 * the file's original generatedAt instead of churning it with a fresh stamp.
 * --------------------------------------------------------------------------------------------- */
function canonicalPayload(document: DnsPinsDocument): string {
  return document.pins
    .map((p) => `${p.hostname}\u0000${p.address}\u0000${canonicalAnswers(p.answersSeen).join(",")}`)
    .sort()
    .join("\n")
}

function sameSemanticPayload(existing: unknown, candidate: DnsPinsDocument): boolean {
  if (typeof existing !== "object" || existing === null) return false
  const doc = existing as Record<string, unknown>
  if (doc.version !== DNS_PINS_SCHEMA_VERSION) return false
  if (typeof doc.generatedAt !== "string" || doc.generatedAt.length === 0) return false
  if (!Array.isArray(doc.pins)) return false
  return canonicalPayload(doc as unknown as DnsPinsDocument) === canonicalPayload(candidate)
}

export type PinsCommit =
  | {
      readonly ok: true
      readonly action: "written" | "unchanged" | "planned"
      readonly path: string
      readonly bytesWritten: number
      readonly fileMode: number
      /** -1 means the setup directory did not exist yet (only reachable under dryRun, which creates nothing). */
      readonly dirModeBefore: number
      readonly dirModeRepaired: boolean
      /** True when a pins file was already on disk and this run replaces it rather than leaving it —
       *  including the case where what was there did not parse at all. Replacing is correct here
       *  because dns-pins.json is DERIVED data: unlike lanes.json it is not a user-authored choice
       *  (spec §1.4 rejects treating this path as user state), and a corrupt file that the producer
       *  refused to overwrite would wedge the estate with no owner able to repair it. */
      readonly replacedExisting: boolean
    }
  | { readonly ok: false; readonly code: PinsProduceCode; readonly reason: string; readonly bytesWritten: 0 }

export function commitDnsPins(home: string, document: DnsPinsDocument, opts: { dryRun?: boolean } = {}): PinsCommit {
  const path = dnsPinsPath(home) // the consumer's own resolver — writer writes where reader reads (spec §1.4)
  const dir = dirname(path)
  const want = JSON.stringify(document, null, 2) + "\n"

  // Read-only comparison FIRST, so both the unchanged case and the dry-run case leave the tree untouched.
  let existingReadable = false
  let samePayload = false
  if (existsSync(path)) {
    let text: string
    try {
      text = readFileSync(path, "utf8")
      existingReadable = true
    } catch (err) {
      return { ok: false, code: "PINS_EXISTING_UNREADABLE", reason: `${path}: unreadable (${(err as Error).message}) — refusing rather than overwriting bytes we cannot account for`, bytesWritten: 0 }
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null // derived data: a corrupt pins file is replaced by a fresh screened produce
    }
    samePayload = parsed !== null && sameSemanticPayload(parsed, document)
    if (samePayload && (statSync(path).mode & 0o777) === MODES.FILE_0600)
      return { ok: true, action: "unchanged", path, bytesWritten: 0, fileMode: statSync(path).mode & 0o777, dirModeBefore: statSync(dir).mode & 0o777, dirModeRepaired: false, replacedExisting: false }
  }
  if (opts.dryRun)
    return {
      ok: true,
      action: "planned",
      path,
      bytesWritten: 0,
      fileMode: MODES.FILE_0600,
      dirModeBefore: existsSync(dir) ? statSync(dir).mode & 0o777 : -1,
      dirModeRepaired: false,
      replacedExisting: existingReadable && !samePayload,
    }

  ensureDir(dir, MODES.DIR_0700)
  const dirModeBefore = statSync(dir).mode & 0o777
  const dirModeRepaired = dirModeBefore !== MODES.DIR_0700
  // ensureDir applies its mode only when it CREATES (paths.ts:39-46), so a drifted 0755 setup dir would
  // otherwise receive a private-looking 0600 file silently. Inside ~/.swarm this repair is permitted (P-4
  // bars chmod OUTSIDE it); the same argument lanes.ts:280-291 makes for AC-237-6 applies verbatim here.
  if (dirModeRepaired) chmodSync(dir, MODES.DIR_0700)

  try {
    atomicWriteJson(path, document, MODES.FILE_0600) // temp-in-dir + fsync + one rename(2), mode applied at create (atomic.ts:17-32)
  } catch (err) {
    return { ok: false, code: "PINS_WRITE_FAILED", reason: `${path}: ${(err as Error).message}`, bytesWritten: 0 }
  }
  const written = readFileSync(path, "utf8")
  const modeNow = statSync(path).mode & 0o777
  if (written !== want || modeNow !== MODES.FILE_0600)
    return { ok: false, code: "PINS_WRITE_FAILED", reason: `${path}: read-back ${written === want ? `mode ${modeNow.toString(8)} != 600` : "differs from the intended bytes"} after commit`, bytesWritten: 0 }
  // Byte length through the declared Buffer shim only, the same route deliver.ts:116-118 uses.
  return { ok: true, action: "written", path, bytesWritten: Buffer.from(want, "utf8").toString("hex").length / 2, fileMode: modeNow, dirModeBefore, dirModeRepaired, replacedExisting: existingReadable && !samePayload }
}

export type ProduceResult =
  | { readonly ok: true; readonly action: "written" | "unchanged" | "planned"; readonly path: string; readonly document: DnsPinsDocument; readonly bytesWritten: number; readonly fileMode: number; readonly dirModeBefore: number; readonly dirModeRepaired: boolean; readonly replacedExisting: boolean }
  | { readonly ok: false; readonly code: PinsProduceCode; readonly hostname: string; readonly reason: string; readonly path: string; readonly bytesWritten: 0 }

interface ProduceCommon {
  /** Pinned HOME (rule E7): required, never defaulted to the real home from here. */
  readonly home: string
  /** The bounded crawl-target allow-list. Explicit parameter — see the header and spec §1.1. */
  readonly hostnames: readonly string[]
  readonly nowIso?: string
  readonly dryRun?: boolean
  /** Audit-line sink. Defaults to setup.log (PC-PATH-05); deliverEstate passes kit.log so the lines
   *  inherit the redactor and the --dry-run posture. */
  readonly log?: PinsLogFn
}

function emit(log: PinsLogFn | undefined, level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void {
  if (log) log(level, message, context)
  else writeSetupLog({ level, source: LOG_SOURCE, message, ...(context ? { context } : {}) })
}

function finish(commit: PinsCommit, document: DnsPinsDocument, home: string, log: PinsLogFn | undefined): ProduceResult {
  if (!commit.ok) {
    const line = dnsPinRefuseLine("-", commit.reason)
    emit(log, "error", line, { code: commit.code, path: dnsPinsPath(home) })
    return { ok: false, code: commit.code, hostname: "-", reason: commit.reason, path: dnsPinsPath(home), bytesWritten: 0 }
  }
  // Lines land only once the file is committed (or proven already-committed): an "ok" audit line for a
  // produce that then failed to write would assert a screen whose result never shipped.
  for (const pin of document.pins)
    emit(log, "info", dnsPinOkLine(pin.hostname, pin.address, pin.answersSeen), {
      hostname: pin.hostname,
      pinned: pin.address,
      answersSeen: pin.answersSeen.length,
      checkedAgainst: "twelve_class_deny_set",
      verdict: "PASS",
    })
  return { ok: true, action: commit.action, path: commit.path, document, bytesWritten: commit.bytesWritten, fileMode: commit.fileMode, dirModeBefore: commit.dirModeBefore, dirModeRepaired: commit.dirModeRepaired, replacedExisting: commit.replacedExisting }
}

function abort(code: PinsProduceCode, hostname: string, reason: string, home: string, log: PinsLogFn | undefined): ProduceResult {
  // An undecided allow-list is not an incident: the absent file is the legal no-pins state (§3.3), and
  // logging it on every install would churn setup.log for a condition that is simply the shipped default.
  if (code !== "PINS_ALLOW_LIST_EMPTY") emit(log, "error", dnsPinRefuseLine(hostname, reason), { code, hostname, verdict: "REFUSED" })
  return { ok: false, code, hostname, reason, path: dnsPinsPath(home), bytesWritten: 0 }
}

/**
 * Synchronous produce over PRE-RESOLVED answers — the entry `deliverEstate` uses, because the delivery
 * stage cannot await and node has no synchronous lookup. Answers arrive as the same `ResolveOutcome`
 * shape the resolver seam returns, so the screening path exercised here is byte-for-byte the one the
 * async pipeline below runs.
 */
export function produceDnsPinsFromAnswers(opts: ProduceCommon & { readonly answers: Readonly<Record<string, ResolveOutcome>> }): ProduceResult {
  const generatedAt = opts.nowIso ?? new Date().toISOString()
  const build = buildPinsDocument(opts.hostnames, opts.answers, generatedAt)
  if (!build.ok) return abort(build.code, build.hostname, build.reason, opts.home, opts.log)
  return finish(commitDnsPins(opts.home, build.document, { dryRun: opts.dryRun }), build.document, opts.home, opts.log)
}

/**
 * Full resolve→check→pin produce (the refresh-shaped entry; row 246 owns calling it on a re-render).
 * The resolver is the seam the spec names — mcpproxy/resolve.ts `systemResolver()` ({all:true,
 * verbatim:true}, every family, unfiltered, spec §7 A-240b-4) — injectable so units drive poisoned
 * answers deterministically. No network egress happens unless the caller lets the default stand.
 */
export async function produceDnsPins(opts: ProduceCommon & { readonly resolver?: Resolver }): Promise<ProduceResult> {
  const generatedAt = opts.nowIso ?? new Date().toISOString()
  const resolver = opts.resolver ?? systemResolver()
  const names = [...opts.hostnames]
  if (names.length === 0) return abort("PINS_ALLOW_LIST_EMPTY", "-", "no crawl-target hostnames supplied — populating the allow-list is an operator/gate decision (spec §1.1, U-240b-1)", opts.home, opts.log)

  const answers: Record<string, ResolveOutcome> = {}
  for (const raw of names) {
    const hostname = normaliseHost(raw)
    if (!plausibleHostname(hostname)) return abort("PINS_NAME_INVALID", raw, "not a bare hostname (wildcards, URLs, IP literals and suffix forms are refused before any lookup — spec §4)", opts.home, opts.log)
    answers[raw] = await resolver(hostname)
  }
  const build = buildPinsDocument(names, answers, generatedAt)
  if (!build.ok) return abort(build.code, build.hostname, build.reason, opts.home, opts.log)
  return finish(commitDnsPins(opts.home, build.document, { dryRun: opts.dryRun }), build.document, opts.home, opts.log)
}
