// DNS pins reader + render-time screen (blueprint 11 row 241) — the P3 half of gate 239.
//
// WHAT THIS IS: the render-side consumer of the producer's output file. The producer
// (masterplan/07_s6b_p3_producer_spec.md, the row created from gap G-234-1) resolves a bounded
// allow-list of public hostnames on the host, screens every answer, and writes
// ~/.swarm/setup/dns-pins.json (PC-PATH-19 PROPOSED — registration routed to row 72; the path
// constant lives HERE because constants.ts is row-81 owned, the same reason PC_PORTS lives in
// shared.ts). This module reads that file at render time and either hands the renderer a list of
// public unicast IPv4 literals or refuses the whole render.
//
// WHY THE SCREEN RUNS AGAIN HERE (producer spec §3.3 last table row + §5 rows 245/251): a user
// who edits dns-pins.json directly bypasses the producer's check, so "producer validated" is not
// "estate safe". The render re-runs the SAME shipped predicates over what it is about to emit —
// checkResolvedAddresses over each entry's recorded answersSeen set, isDeniedAddress behind the
// value screen — and refuses on any miss. That re-check is what closes the direct-edit residual
// row 251 adjudicates. Reuse is the invariant (producer spec §3.1): there is deliberately NO
// second deny list in this file; the twelve classes live in mcpproxy/urlpolicy.ts and nowhere else.
//
// FAILURE POSTURE (§3.3): every bad input — malformed file, denied-class answer, non-survivor
// address, duplicate name — ends in refuse-and-write-nothing. Silent omission of one entry would
// send that name back to EAI_AGAIN -> the vendor's false private-IP block (finding R112d-2) hidden
// inside a render that looks complete. The ONE legal "no pins" state is the ABSENT file (§3.3
// closing paragraph): it yields zero entries and a byte-identical-to-today estate.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { checkResolvedAddresses, isDeniedAddress, isIpLiteral } from "../mcpproxy/urlpolicy.ts"

/** One rendered extra_hosts pair: a public name and the single public unicast IPv4 the host resolved for it. */
export interface ExtraHost {
  readonly hostname: string
  readonly address: string
}

export type PinsRead =
  | { readonly ok: true; readonly entries: readonly ExtraHost[]; readonly present: boolean }
  | { readonly ok: false; readonly message: string }

/** PC-PATH-19 (proposed, producer spec §1.4): ~/.swarm/setup/dns-pins.json, mode 0600 in the
 *  0700 setup dir. Resolved from the render context's home anchor — the same resolver semantics
 *  as expandTilde over PATHS.* (paths.ts:17-21), keyed off ctx.home so tests pin it (§1.4's
 *  single-resolver rule: the reader reads where the writer writes). */
export function dnsPinsPath(home: string): string {
  return join(home, ".swarm", "setup", "dns-pins.json")
}

/** The value screen: true when the string is a canonical dotted-quad IPv4 that (a) survives the
 *  SHIPPED twelve-class predicate isDeniedAddress (urlpolicy.ts:153 — reused verbatim, producer
 *  spec §3.1) and (b) sits in the unicast range. (b) is not a second deny list: it is the
 *  positive shape §1.2/§3.3 demand ("refuse to emit an entry whose value is not unicast-ranged")
 *  and the twelve CIDRs do not cover it — multicast 224/4 and reserved 240/4 slip past them, and
 *  the vendor classifier (addresses.some(a => IPAddr.parse(a).range() !== "unicast"),
 *  research/s6_11_playwright_precheck.md §7.3) blocks the whole target on such an answer.
 *  Canonical decimals ONLY (no octal/hex/leading-zero forms): urlpolicy parses those for hostile
 *  URL hosts, but a rendered file carries literals we chose, so anything non-canonical is drift
 *  or tampering, refused. IPv6 is withheld by design (producer spec §1.2: the estate has no live
 *  IPv6 route), so a v6-shaped value fails here too. */
export function publicUnicastV4(value: string): boolean {
  const parts = value.split(".")
  if (parts.length !== 4) return false
  let first = -1
  for (let i = 0; i < 4; i++) {
    const part = parts[i] ?? ""
    if (!/^(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(part)) return false
    if (i === 0) first = Number(part)
  }
  if (first >= 224) return false // multicast (224/4) + reserved (240/4): non-unicast, see above
  return !isDeniedAddress(value) // the shipped predicate does the twelve classes, incl. 0.0.0.0/8
}

/** Lowercase RFC1123 labels with AT LEAST ONE DOT. The dot requirement is containment, not
 *  style: docker's embedded DNS answers container/service names on the all-internal tiers
 *  (U-19 measurement, 01e §10.2), so an undotted pin could shadow a service name and turn the
 *  injected-answer channel into a stack-internal redirect. A dotted FQDN never collides with
 *  the short names the estate dials. */
const HOSTNAME_FQDN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** Name-screen + value-screen for one rendered pair, shared by the pins reader below and the
 *  compose lint (lint.ts) so the two cannot drift: §4.5 statement 2 requires BOTH to coexist
 *  after the narrowing — the name side still refuses host.docker.internal & friends (via the
 *  shipped DENIED_EXACT/DENIED_SUFFIXES through checkResolvedAddresses), the value side refuses
 *  every denied class and every non-unicast/non-canonical form. Returns a human-readable reason
 *  or null when the pair is renderable. */
export function extraHostPairProblem(hostname: string, value: string): string | null {
  if (!HOSTNAME_FQDN.test(hostname))
    return `hostname "${hostname}" is not a lowercase dotted FQDN (undotted names could shadow docker service DNS; uppercase/IP forms refused)`
  if (isIpLiteral(hostname)) return `hostname "${hostname}" is an IP literal — extra_hosts maps names to answers, never names that ARE answers`
  if (checkResolvedAddresses([hostname]) !== null)
    return `hostname "${hostname}" is a denied name class (localhost/host.docker.internal/metadata.google/internal/.local/.localhost — urlpolicy.ts:139)`
  if (!publicUnicastV4(value))
    return `value "${value}" is not a canonical public unicast IPv4 literal (§4.5 amended: no host, no twelve-class address, no IPv6, no multi-address or exotic-form value)`
  return null
}

interface PinEntryRaw {
  readonly hostname?: unknown
  readonly address?: unknown
  readonly answersSeen?: unknown
  readonly checkedAt?: unknown
}

/** Read + validate + screen the pins file. Absent file -> ok with zero entries (the byte-identical
 *  default, §3.3). Everything else that is not a fully surviving entry list refuses the RENDER
 *  (not just the entry — partial renders are the silent-omit trap). */
export function readDnsPins(home: string): PinsRead {
  const path = dnsPinsPath(home)
  if (!existsSync(path)) return { ok: true, entries: [], present: false }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (err) {
    return { ok: false, message: `${path}: unreadable (${(err as Error).message}) — refusing rather than guessing around a file that exists` }
  }
  const parsed = parsePinsJson(text, path)
  if (!parsed.ok) return parsed
  return screenPins(parsed.entries)
}

function parsePinsJson(text: string, path: string): { ok: true; entries: readonly PinEntryRaw[] } | { ok: false; message: string } {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    return { ok: false, message: `${path}: malformed JSON (${(err as Error).message}) — §3.3 refuses a bad file rather than falling back to defaults` }
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return { ok: false, message: `${path}: top level must be an object (shape §1.3)` }
  const record = doc as Record<string, unknown>
  if (record.version !== 1) return { ok: false, message: `${path}: version must be exactly 1 (schema §1.3), got ${JSON.stringify(record.version)}` }
  // generatedAt absence means "never produced" and must never be inferred as fresh (§1.3 rule 3 —
  // the lane reader's normalise() defect is the cautionary precedent); a file claiming pins with
  // no production timestamp is malformed by that rule.
  if (typeof record.generatedAt !== "string" || record.generatedAt.length === 0)
    return { ok: false, message: `${path}: generatedAt missing — the reader must not fabricate an age (§1.3)` }
  if (!Array.isArray(record.pins)) return { ok: false, message: `${path}: pins must be an array (shape §1.3)` }
  // Row 270 / F-265-5: closed top-level set, mirroring the lanes validator's own-key sweep. Without it a
  // carrier-carrying or truncated file — `{"version":1,"generatedAt":"t","pins":[],"__proto__":{…}}` — read
  // ok=true with zero entries: a silently UNPINNED estate reporting a present, screened file (the F-251-7
  // destination reached by a second route). JSON.parse makes `__proto__` an OWN property, so Object.keys
  // sees every name the document actually carries; anything outside the three schema fields refuses.
  for (const key of Object.keys(record)) {
    if (key !== "version" && key !== "generatedAt" && key !== "pins")
      return { ok: false, message: `${path}: unknown top-level field "${key}" — the pins document is a closed set (shape §1.3); a file carrying names the producer never writes is corruption or a carrier, and neither renders` }
  }
  return { ok: true, entries: record.pins as readonly PinEntryRaw[] }
}

function screenPins(raw: readonly PinEntryRaw[]): PinsRead {
  const entries: ExtraHost[] = []
  const seen = new Set<string>()
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null)
      return { ok: false, message: `pins[${i}] is not an object (shape §1.3)` }
    const hostname = entry.hostname
    const address = entry.address
    const answers = entry.answersSeen
    if (typeof hostname !== "string" || typeof address !== "string")
      return { ok: false, message: `pins[${i}]: hostname and address must be strings (shape §1.3)` }
    if (!Array.isArray(answers) || answers.length === 0 || answers.some((a) => typeof a !== "string"))
      return { ok: false, message: `pins[${i}] (${hostname}): answersSeen must be a non-empty string array — it is the audit payload the re-check runs on (§1.3)` }
    if (typeof entry.checkedAt !== "string" || entry.checkedAt.length === 0)
      return { ok: false, message: `pins[${i}] (${hostname}): checkedAt missing — screened-at time is required (§1.3)` }
    const problem = extraHostPairProblem(hostname, address)
    if (problem !== null) return { ok: false, message: `pins[${i}]: ${problem}`}
    // The stored address must be a survivor of ITS OWN recorded answer set: re-run the shipped
    // predicate over every recorded answer (v4 AND v6, verbatim — §3.1/§5-row-245), then require
    // membership. A hand-edited file pairing a good-looking name with an address the producer
    // never saw, or with a recorded set that secretly contains a private answer, dies here.
    const setReason = checkResolvedAddresses(answers)
    if (setReason !== null)
      return { ok: false, message: `pins[${i}] (${hostname}): recorded answersSeen include a denied answer (${setReason}) — split-horizon/rebinding shape, refuse (§3.3)` }
    if (!answers.includes(address))
      return { ok: false, message: `pins[${i}] (${hostname}): address ${address} is not among its own recorded answersSeen — the direct-edit residual closes here (§5 row 245/251)` }
    const key = hostname.toLowerCase()
    if (seen.has(key)) return { ok: false, message: `pins[${i}]: duplicate hostname "${hostname}" — one name must carry exactly one address (§4.5 statement 1: never a multi-address name)` }
    seen.add(key)
    entries.push({ hostname: key, address })
  }
  // Sorted for byte-stability (shared.ts contract): the file's array order is the producer's,
  // the render's must be deterministic regardless.
  entries.sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0))
  return { ok: true, entries, present: true }
}
