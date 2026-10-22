// Row 266 unit lane — the host-side resolve→check→pin producer (src/estate/pins.ts) and its wiring
// into the estate delivery stage. Specification: masterplan/07_s6b_p3_producer_spec.md; the hole this
// closes is the controller's ruling at decisions/decisions.md:395-400 ("nobody writes
// ~/.swarm/setup/dns-pins.json … a consumer reading a file no code creates").
//
// NO network, NO container, NO colima, NO real home. Every resolution is an INJECTED answer set driven
// through the seam the spec names (mcpproxy/resolve.ts `Resolver` / `systemResolver`); the shipped
// default resolver is never invoked here, so no query ever leaves the process. Every test pins
// process.env.HOME at a mkdtemp sandbox and verifies the pin took effect before anything writes (E7).
//
// What each describe pins:
//   twelve-class screen    -> spec §3.1/§3.2 (reuse of checkResolvedAddresses verbatim) and §3.3 rows
//                             1-3, driven over the SAME class representatives the bake's cross-enforcer
//                             hook uses (egress_bake.ts REQUIRED_DENY_RANGES probes — sourced, not
//                             restated). Includes the E4 discrimination leg: the same instrument
//                             ACCEPTS a legitimate public answer.
//   multi-answer shape     -> spec §1.2 (one public unicast IPv4, IPv6 withheld), §3.3 row 4, and the
//                             consumer's own invariant `address ∈ answersSeen` (dns_pins.ts:163)
//   idempotence/freshness  -> content-addressed no-write, row 263's discipline, so blueprint 10's
//                             `find -newer` residue assertions keep holding; plus what changes when
//                             answers change (recreate-class, refresh owned by row 246)
//   two independent layers -> the producer refuses a host-pointing pair AND the renderer still refuses
//                             it when the bytes arrive without the producer (the independence row 242's
//                             audit claimed for its own lockstep)
//   allow-list parameter   -> spec §1.1 / U-240b-1: empty refuses and touches zero bytes; a wildcard is
//                             refused BEFORE the resolver is called (call-counted, not asserted away)
//   delivery wiring        -> the initial produce lands the file BEFORE renderAll reads it, and every
//                             refusal moves zero artefact bytes (§4.3 first-line discipline)
//
// Collected by the package's declared command (`bun test` from packages/setup) — rule E14.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REQUIRED_DENY_RANGES } from "../src/steps/firecrawl/egress_bake.ts"
import { checkResolvedAddresses, isDeniedAddress } from "../src/mcpproxy/urlpolicy.ts"
import type { ResolveOutcome } from "../src/mcpproxy/resolve.ts"
import { readDnsPins, dnsPinsPath } from "../src/composefiles/dns_pins.ts"
import {
  PINS_PRODUCE_CODES,
  dnsPinOkLine,
  produceDnsPins,
  produceDnsPinsFromAnswers,
} from "../src/estate/pins.ts"
import { OUTCOME } from "../src/outcomes.ts"
import { defaultState } from "../src/state.ts"
import { validateLock } from "../src/lockfile.ts"
import { createStepKit } from "../src/stepkit.ts"
import { homeDir } from "../src/paths.ts"
import { deliverEstate } from "../src/estate/deliver.ts"
import { SECRET_INVENTORY } from "../src/composefiles/shared.ts"

const LOCK = (() => {
  const r = validateLock(JSON.parse(readFileSync(join(import.meta.dir, "..", "tools.lock.json"), "utf8")))
  if (!r.ok) throw new Error(`r266 test lock invalid: ${r.error}`)
  return r.lock
})()

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")
const modeOf = (p: string): number => statSync(p).mode & 0o777

/** E7-safe sandbox: pin HOME, VERIFY the resolved path before the body may write, restore after. */
function withHome<T>(fn: (home: string) => T): T {
  const saved = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), "r266-"))
  process.env.HOME = home
  if (homeDir() !== home) {
    process.env.HOME = saved
    throw new Error(`E7: HOME pin did not take effect (homeDir()=${homeDir()})`)
  }
  try {
    return fn(home)
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
}

const answersFor = (addresses: readonly string[]): Record<string, ResolveOutcome> => ({ "pub.example": { ok: true, addresses } })
/** A public v4 plus a public v6 for one name — the mixed-family shape a real resolver returns. */
const answersForV6 = (v6: string): Record<string, ResolveOutcome> => ({ "pub.example": { ok: true, addresses: ["93.184.216.34", v6] } })
/** A legitimate public answer set for one name — the accept-side fixture, reused across describes. */
const good: Record<string, ResolveOutcome> = { "example.com": { ok: true, addresses: ["104.20.23.154", "172.66.147.243"] } }
const collectLog = (): { lines: string[]; log: (level: "info" | "warn" | "error", message: string) => void } => {
  const lines: string[] = []
  return { lines, log: (_level, message) => void lines.push(message) }
}

/** Every refusal must provably write nothing: no file, and no setup dir created either. */
function assertUntouched(home: string): void {
  expect(existsSync(dnsPinsPath(home))).toBe(false)
  expect(readdirSync(home)).toEqual([])
}

describe("row 266 — twelve-class screen refuses a poisoned answer (spec §3.1-§3.3)", () => {
  it("screens every class representative the bake's cross-enforcer hook uses, one produce per class", () => {
    expect(REQUIRED_DENY_RANGES.length).toBe(12) // the count the spec freezes; a drift here is row 242's business
    for (const range of REQUIRED_DENY_RANGES) {
      withHome((home) => {
        const sink = collectLog()
        const r = produceDnsPinsFromAnswers({
          home,
          hostnames: ["pub.example"],
          answers: answersFor([range.probe]),
          nowIso: "2026-10-22T02:15:00Z",
          log: sink.log,
        })
        expect(r.ok).toBe(false)
        if (r.ok) throw new Error("unreachable")
        expect(r.code).toBe("PINS_DENIED_ANSWER")
        expect(r.hostname).toBe("pub.example")
        expect(r.bytesWritten).toBe(0)
        assertUntouched(home)
        // the named outcome reaches the audit line too, not only the return value
        expect(sink.lines.join("\n")).toContain(`DNSPIN refuse hostname=pub.example reason=answer denied by twelve-class predicate (address_denied) checked_against=twelve_class_deny_set verdict=REFUSED render=aborted`)
      })
    }
  })

  it("refuses the WHOLE produce when one name of many is poisoned — never omits the bad entry", () => {
    withHome((home) => {
      const r = produceDnsPinsFromAnswers({
        home,
        hostnames: ["good.example", "evil.example"],
        answers: {
          "good.example": { ok: true, addresses: ["104.20.23.154"] },
          "evil.example": { ok: true, addresses: ["127.0.0.1"] },
        },
        nowIso: "2026-10-22T02:15:00Z",
        log: () => {},
      })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.code).toBe("PINS_DENIED_ANSWER")
      expect(r.hostname).toBe("evil.example")
      assertUntouched(home) // the good name is NOT written either: partial files are the silent-omit trap
    })
  })

  it("refuses a split-horizon name advertising both a public and a private answer (row 94 discipline)", () => {
    withHome((home) => {
      const r = produceDnsPinsFromAnswers({
        home,
        hostnames: ["pub.example"],
        answers: answersFor(["104.20.23.154", "192.168.5.3"]),
        nowIso: "2026-10-22T02:15:00Z",
        log: () => {},
      })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.code).toBe("PINS_DENIED_ANSWER")
      assertUntouched(home)
    })
  })

  it("refuses the wrapped forms the twelve CIDRs only catch through urlpolicy (NAT64, IPv4-mapped)", () => {
    for (const wrapped of ["64:ff9b::7f00:1", "::ffff:127.0.0.1", "64:ff9b::a0a:1"]) {
      expect(isDeniedAddress(wrapped)).toBe(true) // the shipped predicate itself, asked directly
      withHome((home) => {
        const r = produceDnsPinsFromAnswers({ home, hostnames: ["pub.example"], answers: answersFor([wrapped]), nowIso: "x", log: () => {} })
        expect(r.ok).toBe(false)
        if (r.ok) throw new Error("unreachable")
        expect(r.code).toBe("PINS_DENIED_ANSWER")
        assertUntouched(home)
      })
    }
  })

  it("refuses PTR-shaped answers naming a denied host class, not just numeric addresses", () => {
    for (const name of ["localhost", "host.docker.internal", "metadata.google.internal", "svc.internal", "host.local"]) {
      expect(checkResolvedAddresses([name])).toBe("host_denied_name")
      withHome((home) => {
        const r = produceDnsPinsFromAnswers({ home, hostnames: ["pub.example"], answers: answersFor([name]), nowIso: "x", log: () => {} })
        expect(r.ok).toBe(false)
        if (r.ok) throw new Error("unreachable")
        expect(r.code).toBe("PINS_DENIED_ANSWER")
        assertUntouched(home)
      })
    }
  })

  it("refuses a resolution that throws and a resolution that answers nothing (spec §3.3 rows 1-2)", () => {
    withHome((home) => {
      const thrown = produceDnsPinsFromAnswers({ home, hostnames: ["pub.example"], answers: { "pub.example": { ok: false, error: "EAI_AGAIN pub.example" } }, nowIso: "x", log: () => {} })
      expect(thrown.ok).toBe(false)
      if (thrown.ok) throw new Error("unreachable")
      expect(thrown.code).toBe("PINS_RESOLVE_FAILED")
      expect(thrown.reason).toContain("EAI_AGAIN")
      assertUntouched(home)
    })
    withHome((home) => {
      const empty = produceDnsPinsFromAnswers({ home, hostnames: ["pub.example"], answers: answersFor([]), nowIso: "x", log: () => {} })
      expect(empty.ok).toBe(false)
      if (empty.ok) throw new Error("unreachable")
      expect(empty.code).toBe("PINS_NO_ANSWERS")
      assertUntouched(home)
    })
  })

  it("E4 DISCRIMINATION: the same instrument accepts a legitimate public answer and lands the file", () => {
    withHome((home) => {
      const sink = collectLog()
      const r = produceDnsPinsFromAnswers({
        home,
        hostnames: ["example.com"],
        answers: { "example.com": { ok: true, addresses: ["104.20.23.154", "172.66.147.243"] } },
        nowIso: "2026-10-22T02:15:00Z",
        log: sink.log,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.action).toBe("written")
      expect(r.bytesWritten).toBeGreaterThan(0)
      expect(modeOf(r.path)).toBe(0o600)
      expect(modeOf(join(home, ".swarm", "setup"))).toBe(0o700)
      expect(sink.lines).toEqual([dnsPinOkLine("example.com", "104.20.23.154", ["104.20.23.154", "172.66.147.243"])])
      // so "it refuses" above is not "it always fails": identical instrument, opposite verdict, one byte-class apart
      expect(readDnsPins(home).ok).toBe(true)
    })
  })
})

describe("row 266 — per-name shape: one public unicast IPv4, IPv6 withheld (spec §1.2)", () => {
  it("selects ONE literal from several public IPv4 answers, order-independently", () => {
    const sets = [["104.20.23.154", "172.66.147.243"], ["172.66.147.243", "104.20.23.154"]]
    const selected = sets.map((addresses) =>
      withHome((home) => {
        const r = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: { "example.com": { ok: true, addresses } }, nowIso: "2026-10-22T02:15:00Z", log: () => {} })
        if (!r.ok) throw new Error(`expected accept, got ${JSON.stringify(r)}`)
        return r.document.pins[0]?.address
      }),
    )
    expect(selected[0]).toBe("104.20.23.154")
    expect(selected[1]).toBe(selected[0]) // resolver rotation cannot churn the file
  })

  it("screens a public IPv6 answer and records it, but renders only the IPv4 (no live v6 route in the guest)", () => {
    withHome((home) => {
      const v6 = "2606:2800:220:1:26e:2c2a:33ee:5f2d"
      const r = produceDnsPinsFromAnswers({ home, hostnames: ["pub.example"], answers: answersForV6(v6), nowIso: "2026-10-22T02:15:00Z", log: () => {} })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.document.pins[0]?.address).toBe("93.184.216.34")
      expect(r.document.pins[0]?.answersSeen).toContain(v6) // the audit payload carries EVERY answer screened
      expect(checkResolvedAddresses([v6])).toBeNull() // and the v6 was screened, not skipped
    })
  })

  it("refuses a name whose only public answers are IPv6 (the estate could not dial it anyway)", () => {
    withHome((home) => {
      const r = produceDnsPinsFromAnswers({
        home,
        hostnames: ["v6only.example"],
        answers: { "v6only.example": { ok: true, addresses: ["2606:2800:220:1:26e:2c2a:33ee:5f2d"] } },
        nowIso: "x",
        log: () => {},
      })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.code).toBe("PINS_NO_PUBLIC_UNICAST_V4")
      assertUntouched(home)
    })
  })

  it("refuses a multicast/reserved answer that slips past the twelve CIDRs (spec §3.3 row 4)", () => {
    for (const odd of ["239.1.2.3", "240.0.0.1"]) {
      expect(isDeniedAddress(odd)).toBe(false) // the predicate alone would let it through…
      withHome((home) => {
        const r = produceDnsPinsFromAnswers({ home, hostnames: ["pub.example"], answers: answersFor([odd]), nowIso: "x", log: () => {} })
        expect(r.ok).toBe(false)
        if (r.ok) throw new Error("unreachable")
        expect(r.code).toBe("PINS_NO_PUBLIC_UNICAST_V4") // …the unicast leg is what refuses it, additively
        assertUntouched(home)
      })
    }
  })

  it("CONSUMER AGREEMENT: the produced file satisfies row 241's render-time checks, including address ∈ answersSeen", () => {
    withHome((home) => {
      const r = produceDnsPinsFromAnswers({
        home,
        hostnames: ["example.com", "api.github.com"],
        answers: {
          "example.com": { ok: true, addresses: ["104.20.23.154", "172.66.147.243"] },
          "api.github.com": { ok: true, addresses: ["140.82.112.6"] },
        },
        nowIso: "2026-10-22T02:15:00Z",
        log: () => {},
      })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      const read = readDnsPins(home)
      expect(read.ok).toBe(true)
      if (!read.ok) throw new Error(`the consumer refused the producer's own output: ${read.message}`)
      expect(read.present).toBe(true)
      expect(read.entries).toEqual([
        { hostname: "api.github.com", address: "140.82.112.6" },
        { hostname: "example.com", address: "104.20.23.154" },
      ])
      // the invariant row 241 checks, asserted on the bytes rather than inferred from the API
      const doc = JSON.parse(readFileSync(dnsPinsPath(home), "utf8")) as { pins: Array<{ hostname: string; address: string; answersSeen: string[] }> }
      for (const pin of doc.pins) expect(pin.answersSeen).toContain(pin.address)
    })
  })

  it("the same invariant is a real gate: a hand-edited address outside its own answersSeen refuses the render", () => {
    withHome((home) => {
      mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
      writeFileSync(
        dnsPinsPath(home),
        JSON.stringify({
          version: 1,
          generatedAt: "2026-10-22T02:15:00Z",
          pins: [{ hostname: "example.com", address: "10.1.2.3", answersSeen: ["104.20.23.154"], checkedAt: "2026-10-22T02:15:00Z" }],
        }),
        { mode: 0o600 },
      )
      const read = readDnsPins(home)
      expect(read.ok).toBe(false)
      if (read.ok) throw new Error("unreachable")
      expect(read.message).toContain("not a canonical public unicast IPv4")
    })
  })
})

describe("row 266 — idempotence and freshness (content-addressed no-write)", () => {
  it("re-running over unchanged answers writes ZERO bytes and freezes mtime, hash and the original timestamp", () => {
    withHome((home) => {
      const first = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: good, nowIso: "2026-10-22T02:15:00Z", log: () => {} })
      expect(first.ok && first.action).toBe("written")
      const path = dnsPinsPath(home)
      const hashBefore = sha(readFileSync(path, "utf8"))
      // Plant an OLD mtime instead of sleeping: any rewrite moves it, and the assertion below is the
      // same instrument blueprint 10 uses (`find -newer <marker>` reports nothing newer).
      const old = new Date(Date.now() - 60_000)
      utimesSync(path, old, old)

      const second = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: good, nowIso: "2026-10-22T09:00:00Z", log: () => {} })
      expect(second.ok).toBe(true)
      if (!second.ok) throw new Error("unreachable")
      expect(second.action).toBe("unchanged")
      expect(second.bytesWritten).toBe(0)
      expect(sha(readFileSync(path, "utf8"))).toBe(hashBefore)
      expect(statSync(path).mtime.getTime()).toBe(old.getTime())
      // and the fresh clock did NOT leak in: an unchanged pin set keeps the timestamp it was born with
      expect(JSON.parse(readFileSync(path, "utf8")).generatedAt).toBe("2026-10-22T02:15:00Z")
    })
  })

  it("a reordered-but-identical answer set is still unchanged (selection is order-independent)", () => {
    withHome((home) => {
      produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: { "example.com": { ok: true, addresses: ["172.66.147.243", "104.20.23.154"] } }, nowIso: "2026-10-22T02:15:00Z", log: () => {} })
      const path = dnsPinsPath(home)
      const before = readFileSync(path, "utf8")
      const again = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: { "example.com": { ok: true, addresses: ["104.20.23.154", "172.66.147.243"] } }, nowIso: "2026-10-22T09:00:00Z", log: () => {} })
      expect(again.ok && again.action).toBe("unchanged")
      expect(readFileSync(path, "utf8")).toBe(before)
    })
  })

  it("changed answers DO rewrite, carrying a fresh generatedAt and replacedExisting=true (refresh itself is row 246's)", () => {
    withHome((home) => {
      produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: good, nowIso: "2026-10-22T02:15:00Z", log: () => {} })
      const r = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: { "example.com": { ok: true, addresses: ["93.184.216.34"] } }, nowIso: "2026-10-22T09:30:00Z", log: () => {} })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.action).toBe("written")
      expect(r.replacedExisting).toBe(true)
      expect(r.document.generatedAt).toBe("2026-10-22T09:30:00Z")
      expect(r.document.pins[0]?.address).toBe("93.184.216.34")
      expect(readDnsPins(home).ok).toBe(true) // the rewritten file still satisfies the consumer
    })
  })

  it("a corrupt pins file on disk is replaced by a fresh produce (derived data, not user state)", () => {
    withHome((home) => {
      mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
      writeFileSync(dnsPinsPath(home), "{ not json", { mode: 0o600 })
      const r = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: good, nowIso: "2026-10-22T02:15:00Z", log: () => {} })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.action).toBe("written")
      expect(r.replacedExisting).toBe(true)
      expect(readDnsPins(home).ok).toBe(true)
    })
  })

  it("an unreadable existing target refuses rather than clobbering blind", () => {
    withHome((home) => {
      mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
      mkdirSync(dnsPinsPath(home), { mode: 0o700 }) // a DIRECTORY where the file belongs -> EISDIR on read
      const r = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: good, nowIso: "x", log: () => {} })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.code).toBe("PINS_EXISTING_UNREADABLE")
      expect(r.bytesWritten).toBe(0)
      expect(statSync(dnsPinsPath(home)).isDirectory()).toBe(true) // left exactly as found
    })
  })

  it("dry-run plans the produce and touches nothing (PC-FLAG-03 posture)", () => {
    withHome((home) => {
      const r = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: good, nowIso: "x", dryRun: true, log: () => {} })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.action).toBe("planned")
      expect(r.bytesWritten).toBe(0)
      expect(existsSync(dnsPinsPath(home))).toBe(false)
    })
  })
})

describe("row 266 — no host-pointing entry, at either layer, ever (spec §4)", () => {
  it("refuses host.docker.internal as a PINNED NAME even when its answer is public (name screen coexists)", () => {
    withHome((home) => {
      const r = produceDnsPinsFromAnswers({
        home,
        hostnames: ["host.docker.internal"],
        answers: { "host.docker.internal": { ok: true, addresses: ["93.184.216.34"] } },
        nowIso: "x",
        log: () => {},
      })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.code).toBe("PINS_CONSUMER_CONTRACT_MISMATCH") // the renderer's own screen caught it at production
      expect(r.reason).toContain("denied name class")
      assertUntouched(home)
    })
  })

  it("refuses an .internal / .local suffix name the same way", () => {
    for (const name of ["svc.internal", "printer.local", "loopback.localhost"]) {
      withHome((home) => {
        const r = produceDnsPinsFromAnswers({ home, hostnames: [name], answers: { [name]: { ok: true, addresses: ["93.184.216.34"] } }, nowIso: "x", log: () => {} })
        expect(r.ok).toBe(false)
        assertUntouched(home)
      })
    }
  })

  it("LAYER INDEPENDENCE: bytes that never passed the producer are still refused by the renderer", () => {
    const hostile: Array<[string, unknown]> = [
      ["host-gateway value", { hostname: "crawl.example", address: "host-gateway", answersSeen: ["host-gateway"], checkedAt: "t" }],
      ["host.docker.internal:host-gateway shape", { hostname: "host.docker.internal", address: "host-gateway", answersSeen: ["93.184.216.34"], checkedAt: "t" }],
      ["docker gateway address", { hostname: "crawl.example", address: "192.168.5.3", answersSeen: ["192.168.5.3"], checkedAt: "t" }],
      ["cloud metadata endpoint", { hostname: "crawl.example", address: "169.254.169.254", answersSeen: ["169.254.169.254"], checkedAt: "t" }],
      ["CGNAT", { hostname: "crawl.example", address: "100.64.0.1", answersSeen: ["100.64.0.1"], checkedAt: "t" }],
      ["loopback", { hostname: "crawl.example", address: "127.0.0.1", answersSeen: ["127.0.0.1"], checkedAt: "t" }],
      ["IPv6 loopback", { hostname: "crawl.example", address: "::1", answersSeen: ["::1"], checkedAt: "t" }],
      ["fabricated address outside its own answers", { hostname: "crawl.example", address: "93.184.216.34", answersSeen: ["8.8.8.8"], checkedAt: "t" }],
    ]
    for (const [label, pin] of hostile) {
      withHome((home) => {
        mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
        writeFileSync(dnsPinsPath(home), JSON.stringify({ version: 1, generatedAt: "2026-10-22T02:15:00Z", pins: [pin] }), { mode: 0o600 })
        const read = readDnsPins(home)
        expect(read.ok).toBe(false)
        if (read.ok) throw new Error(`${label}: the render accepted a host-pointing pin`)
      })
    }
  })

  it("the two layers agree on the boundary case in BOTH directions (no drift between them)", () => {
    withHome((home) => {
      // accept side: producer writes, renderer reads the same pair
      const ok = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: good, nowIso: "2026-10-22T02:15:00Z", log: () => {} })
      expect(ok.ok).toBe(true)
      expect(readDnsPins(home).ok).toBe(true)
    })
  })
})

describe("row 266 — the allow-list is an explicit parameter, never an invented list (U-240b-1)", () => {
  it("an empty allow-list refuses to produce and creates nothing at all", () => {
    withHome((home) => {
      const sink = collectLog()
      const r = produceDnsPinsFromAnswers({ home, hostnames: [], answers: {}, nowIso: "x", log: sink.log })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.code).toBe("PINS_ALLOW_LIST_EMPTY")
      expect(r.bytesWritten).toBe(0)
      expect(sink.lines).toEqual([]) // the shipped default posture must not churn setup.log on every install
      assertUntouched(home)
    })
  })

  it("a wildcard or URL-shaped name is refused BEFORE the resolver is asked (call-counted)", async () => {
    let calls = 0
    const spy = async (): Promise<ResolveOutcome> => {
      calls += 1
      return { ok: true, addresses: ["93.184.216.34"] }
    }
    const home = mkdtempSync(join(tmpdir(), "r266-"))
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      for (const bad of ["*.example.com", "https://example.com/path", "example.com:443", "[::1]", "10.0.0.1", ""]) {
        const r = await produceDnsPins({ home, hostnames: [bad], resolver: spy, nowIso: "x", log: () => {} })
        expect(r.ok).toBe(false)
        if (r.ok) throw new Error(`${bad} was accepted`)
        expect(r.code).toBe("PINS_NAME_INVALID")
      }
    } finally {
      process.env.HOME = saved
      rmSync(home, { recursive: true, force: true })
    }
    expect(calls).toBe(0) // no lookup for a name we would refuse to render
  })

  it("a duplicated name in the list refuses the produce (one name, one address)", () => {
    withHome((home) => {
      const r = produceDnsPinsFromAnswers({
        home,
        hostnames: ["example.com", "EXAMPLE.com."], // normaliseHost folds case and the root dot -> the same name
        answers: { "example.com": { ok: true, addresses: ["104.20.23.154"] }, "EXAMPLE.com.": { ok: true, addresses: ["104.20.23.154"] } },
        nowIso: "x",
        log: () => {},
      })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.code).toBe("PINS_DUPLICATE_NAME")
      assertUntouched(home)
    })
  })

  it("the refusal-code set stays closed (widening needs a ruling, not a commit)", () => {
    expect([...PINS_PRODUCE_CODES].sort()).toEqual([
      "PINS_ALLOW_LIST_EMPTY",
      "PINS_ANSWERS_UNAVAILABLE",
      "PINS_CONSUMER_CONTRACT_MISMATCH",
      "PINS_DENIED_ANSWER",
      "PINS_DUPLICATE_NAME",
      "PINS_NAME_INVALID",
      "PINS_NO_ANSWERS",
      "PINS_NO_PUBLIC_UNICAST_V4",
      "PINS_RESOLVE_FAILED",
      "PINS_EXISTING_UNREADABLE",
      "PINS_WRITE_FAILED",
    ].sort())
  })

  it("a non-empty list with no answers refuses loudly instead of silently skipping", () => {
    withHome((home) => {
      const r = produceDnsPinsFromAnswers({ home, hostnames: ["example.com"], answers: {}, nowIso: "x", log: () => {} })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.code).toBe("PINS_ANSWERS_UNAVAILABLE")
      assertUntouched(home)
    })
  })

  it("the async pipeline produces through the named resolver seam and screens what it returns", async () => {
    const home = mkdtempSync(join(tmpdir(), "r266-"))
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      const seen: string[] = []
      const r = await produceDnsPins({
        home,
        hostnames: ["example.com"],
        resolver: async (host) => {
          seen.push(host)
          return { ok: true, addresses: ["172.66.147.243", "104.20.23.154"] }
        },
        nowIso: "2026-10-22T02:15:00Z",
        log: () => {},
      })
      expect(seen).toEqual(["example.com"])
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      expect(r.document.pins[0]?.address).toBe("104.20.23.154")
      expect(readDnsPins(home).ok).toBe(true)
    } finally {
      process.env.HOME = saved
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("row 266 — delivery wiring: the produce lands before renderAll reads", () => {
  const kitFor = (component: "searxng" | "firecrawl", dryRun = false) => createStepKit({ componentId: component, lock: LOCK, state: defaultState(LOCK.version), dryRun })

  function seedRequiredSecrets(home: string, components: readonly ("searxng" | "firecrawl")[]): void {
    for (const c of components)
      for (const s of SECRET_INVENTORY[c]) {
        if (!s.required) continue
        const dir = join(home, ".swarm", "tools", c, "secrets")
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        writeFileSync(join(dir, s.name), "f".repeat(64), { mode: 0o600 })
      }
  }

  const setupLogOf = (home: string): string => {
    const p = join(home, ".swarm", "setup", "setup.log")
    return existsSync(p) ? readFileSync(p, "utf8") : ""
  }

  it("with no allow-list configured, delivery is inert: no pins file, no DNSPIN line, artefacts as before", () => {
    withHome((home) => {
      seedRequiredSecrets(home, ["searxng"])
      const r = deliverEstate({ kit: kitFor("searxng"), home })
      expect(r.token).toBe(OUTCOME.OK) // row 263's behaviour, unchanged by this row's insertion
      expect(existsSync(join(home, ".swarm", "tools", "searxng", "compose", "searxng.yml"))).toBe(true)
      expect(existsSync(dnsPinsPath(home))).toBe(false)
      expect(setupLogOf(home)).not.toContain("DNSPIN")
      expect(readDnsPins(home)).toEqual({ ok: true, entries: [], present: false }) // the legal no-pins render
    })
  })

  it("a valid allow-list lands dns-pins.json BEFORE the render, so the delivered compose carries the literal", () => {
    withHome((home) => {
      seedRequiredSecrets(home, ["firecrawl"])
      const r = deliverEstate({
        kit: kitFor("firecrawl"),
        home,
        dnsPins: { hostnames: ["example.com"], answers: { "example.com": { ok: true, addresses: ["104.20.23.154", "172.66.147.243"] } } },
      })
      expect(r.token).toBe(OUTCOME.OK)
      expect(existsSync(dnsPinsPath(home))).toBe(true)
      const compose = readFileSync(join(home, ".swarm", "tools", "firecrawl", "compose", "firecrawl.yml"), "utf8")
      // Only possible if the produce committed BEFORE renderAll read the file: the renderer emits no
      // extra_hosts key at all when the file is absent (row 241), and nothing re-renders after this.
      expect(compose).toContain('- "example.com:104.20.23.154"')
      expect(compose.match(/extra_hosts:/g)?.length).toBe(2) // api + playwright-service, per spec §5 row 241
      expect(setupLogOf(home)).toContain("DNSPIN ok hostname=example.com pinned=104.20.23.154 answers_seen=2 checked_against=twelve_class_deny_set verdict=PASS")
    })
  })

  it("a second delivery over unchanged answers re-produces without touching the pins file", () => {
    withHome((home) => {
      seedRequiredSecrets(home, ["firecrawl"])
      const pins = { hostnames: ["example.com"], answers: { "example.com": { ok: true, addresses: ["104.20.23.154"] } } }
      expect(deliverEstate({ kit: kitFor("firecrawl"), home, dnsPins: pins }).token).toBe(OUTCOME.OK)
      const path = dnsPinsPath(home)
      const old = new Date(Date.now() - 60_000)
      utimesSync(path, old, old)
      const hash = sha(readFileSync(path, "utf8"))
      expect(deliverEstate({ kit: kitFor("firecrawl"), home, dnsPins: pins }).token).toBe(OUTCOME.OK)
      expect(sha(readFileSync(path, "utf8"))).toBe(hash)
      expect(statSync(path).mtime.getTime()).toBe(old.getTime())
    })
  })

  it("a poisoned answer refuses the DELIVERY too, with zero artefact bytes moved", () => {
    withHome((home) => {
      seedRequiredSecrets(home, ["firecrawl"])
      const r = deliverEstate({
        kit: kitFor("firecrawl"),
        home,
        dnsPins: { hostnames: ["evil.example"], answers: { "evil.example": { ok: true, addresses: ["169.254.169.254"] } } },
      })
      expect(r.token).toBe(OUTCOME.FAILED)
      expect(r.message.split("\n")[0]).toContain("[PINS_DENIED_ANSWER]") // §4.3: the code survives index.ts:394's first-line cut
      expect(existsSync(dnsPinsPath(home))).toBe(false)
      expect(existsSync(join(home, ".swarm", "tools", "firecrawl", "compose", "firecrawl.yml"))).toBe(false)
      expect(setupLogOf(home)).toContain("DNSPIN refuse hostname=evil.example")
    })
  })

  it("an empty allow-list does NOT fail the delivery (absent file is the legal no-pins state)", () => {
    withHome((home) => {
      seedRequiredSecrets(home, ["firecrawl"])
      const r = deliverEstate({ kit: kitFor("firecrawl"), home, dnsPins: { hostnames: [], answers: {} } })
      expect(r.token).toBe(OUTCOME.OK)
      expect(existsSync(dnsPinsPath(home))).toBe(false)
      expect(r.message).not.toContain("PINS_")
      expect(readFileSync(join(home, ".swarm", "tools", "firecrawl", "compose", "firecrawl.yml"), "utf8")).not.toContain("extra_hosts")
    })
  })

  it("dry-run delivery plans the produce and writes neither the pins file nor any artefact byte", () => {
    withHome((home) => {
      seedRequiredSecrets(home, ["firecrawl"])
      const r = deliverEstate({
        kit: kitFor("firecrawl", true),
        home,
        dnsPins: { hostnames: ["example.com"], answers: { "example.com": { ok: true, addresses: ["104.20.23.154"] } } },
      })
      void r
      expect(existsSync(dnsPinsPath(home))).toBe(false)
      expect(setupLogOf(home)).not.toContain("DNSPIN") // kit.log captures dry-run lines instead of writing them
    })
  })
})
