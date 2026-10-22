// Row 244 (blueprint 11) — the independent unit lane for row 243's sink-delta accounting.
//
// WHY THIS LANE EXISTS SEPARATELY: row 243 proved its own delta rule with a three-variant mutation battery over
// its implementation. This file re-states the same contract from the two places that BIND whoever reads the sink
// — masterplan/05_s6b_firecrawl_repair_contract.md §5 trap T-5 ("sink assertions are deltas while R112d-3 stands
// … prove the sink is not blind with a control line") and 01e §10.6's audit-sink warning ("zero lines from a blind
// sink and zero lines from a truly idle estate are byte-identical observations; only the control tells them apart",
// 01e_compose_spec.md:1720-1722) — with fixtures taken from the live record that produced the finding
// (verification/13d_live_firecrawl_attempt4.md §8 R112d-3's eleven `NONE_NONE/000` lines at poll spacing).
// RC-243-2 honoured: §12 carries no duty line for row 243, so the requirement is asserted from T-5 itself rather
// than from an absent table row.
//
// Every fixture here is a RECORDED log line. Nothing boots squid, binds a port or reads a live sink; the live
// read against a polling gate is row 255's cell, and trap T-5 stays open until that runs.
//
// Run from packages/setup:  bun test test/egress_sink_delta_units.test.ts   (also collected by plain `bun test`).

import { describe, it, expect } from "bun:test"
import {
  auditIdleWindow,
  classifySquidSinkLine,
  READINESS_PROBE_NOISE_TOKEN,
} from "../src/steps/firecrawl/egress_bake.ts"

// ------------------------------------------------------------------ fixtures: squid native-format lines
// Shaped from the live sink lines quoted in verification/13d_live_firecrawl_attempt4.md (§4 A5, §5.2, §5.4, §8).

const PROBE = "1761112233.100 0 172.22.0.5 NONE_NONE/000 0 0 error:transaction-end-before-headers TCP_NONE/- - - -"
const PROBE_NO_TOKEN = "1761112233.400 0 172.22.0.5 NONE_NONE/000 0 0 - TCP_NONE/- - - -"
const REAL_GET = "1761112300.100 120 172.22.0.4 TCP_MISS/200 1013 GET http://example.com/ - HIER_DIRECT/104.20.23.154 - -"
const CONTROL_GET = "1761112300.100 120 172.22.0.4 TCP_MISS/200 1013 GET http://r112d-ctrl.example.com/ - HIER_DIRECT/104.20.23.154 - -"
const ABORTED_DOWNLOAD = "1761112400.000 55 172.22.0.4 TCP_ABORTED/000 0 GET http://example.com/big.bin - HIER_DIRECT/104.20.23.154 - -"
const TUNNEL_DENIED = "1761112500.000 3 172.22.0.4 TCP_DENIED/403 3375 CONNECT 127.0.0.1:80 - HIER_NONE/- - -"
const TUNNEL_ALLOWED = "1761112501.000 30 172.22.0.4 TCP_TUNNEL/200 7073 CONNECT example.com:443 - HIER_DIRECT/104.20.23.154 - -"
const CONTROL_MARKER = "r112d-ctrl.example.com"

/** Eleven probes at poll spacing — the exact count R112d-3 measured (`13d` §8). */
const elevenProbes = (): string[] => Array.from({ length: 11 }, (_, i) => `${PROBE}`.replace("1761112233.100", `17611122${33 + i}.100`))

// ================================================================================================
// 1. Classification: the four kinds, and the two precedence rules that decide which kind a line is.
//    Mutant M-g (treat every 000 as gate noise) breaks test 2 below.
// ================================================================================================

describe("(r244 sink classification) four kinds, decided by signature rather than by status code alone", () => {
  it("the readiness probe's own signature classifies as PROBE_NOISE, with or without the transaction-end tell", () => {
    expect(classifySquidSinkLine(PROBE)).toBe("PROBE_NOISE")
    expect(classifySquidSinkLine(PROBE_NO_TOKEN)).toBe("PROBE_NOISE") // the NONE_NONE tag is enough
    expect(READINESS_PROBE_NOISE_TOKEN).toBe("error:transaction-end-before-headers")
  })

  it("a genuine aborted download that also carries 000 is REAL_EGRESS, not gate noise", () => {
    // The mislabelling this guards: if "000" alone meant noise, a real transfer that died mid-flight would be
    // filed under the gate's own traffic and the estate's egress would disappear from the audit.
    expect(ABORTED_DOWNLOAD).toContain("/000")
    expect(classifySquidSinkLine(ABORTED_DOWNLOAD)).toBe("REAL_EGRESS")
  })

  it("the deliberate control wins over physical shape, because it is a request the reader issued on purpose", () => {
    expect(classifySquidSinkLine(CONTROL_GET, CONTROL_MARKER)).toBe("CONTROL")
    // Without the marker the very same line is traffic, which is why the marker is an argument and not a guess.
    expect(classifySquidSinkLine(CONTROL_GET)).toBe("REAL_EGRESS")
  })

  it("blank and unattributable lines are UNRECOGNIZED, never silently dropped", () => {
    expect(classifySquidSinkLine("   ")).toBe("UNRECOGNIZED")
    expect(classifySquidSinkLine("this line is not squid at all")).toBe("UNRECOGNIZED")
  })

  it("both tunnel forms from attempt 4's window classify as traffic, refused or admitted alike", () => {
    // Relevant to gate 239 fork B specifically: after the widening the sink carries CONNECT lines on :80 too,
    // and neither a refusal nor an admitted tunnel may be read as "nothing happened".
    expect(classifySquidSinkLine(TUNNEL_DENIED)).toBe("REAL_EGRESS")
    expect(classifySquidSinkLine(TUNNEL_ALLOWED)).toBe("REAL_EGRESS")
  })
})

// ================================================================================================
// 2. The delta rule proper. Mutants M-e (count the whole end-read) and M-f (set difference instead of
//    multiset) break tests 1 and 2 of this describe.
// ================================================================================================

describe("(r244 idle-window delta rule) the verdict is a delta over two reads, never an absolute count", () => {
  it("PROOF 1 (T-5 first half): IDLE while the gate actively polls, by COUNTING the eleven probes", () => {
    const v = auditIdleWindow({ before: [REAL_GET], after: [REAL_GET, ...elevenProbes()] })
    expect(v.outcome).toBe("IDLE")
    expect(v.probeNoise).toBe(11) // seen and counted, not discarded — the guard against "ignore the 000 lines"
    expect(v.witness).toBe("PROBE_NOISE")
    expect(v.added).toBe(11)
    expect(v.realEgress).toBe(0)
  })

  it("MULTISET not SET: eleven identical probe lines are eleven additions, not one", () => {
    // The gate writes near-identical lines; a set difference collapses them and reports a busy window as nearly
    // empty, which is the same error as counting absolutes wearing different clothes.
    const identical = Array.from({ length: 11 }, () => PROBE)
    const v = auditIdleWindow({ before: [], after: identical })
    expect(v.added).toBe(11)
    expect(v.probeNoise).toBe(11)
    expect(v.outcome).toBe("IDLE")
    // The sharper leg: one probe already sits in the start read, so ten of the eleven are NEW. A set difference
    // answers zero added here, and zero-added with no witness is BLIND_SINK — a live sink read as a dead one.
    const v2 = auditIdleWindow({ before: [PROBE], after: identical })
    expect(v2.added).toBe(10)
    expect(v2.probeNoise).toBe(10)
    expect(v2.outcome).toBe("IDLE")
  })

  it("DELTA not ABSOLUTE: a real line present at the window START does not make the window busy", () => {
    const v = auditIdleWindow({ before: [REAL_GET], after: [REAL_GET, ...elevenProbes()] })
    expect(v.outcome).toBe("IDLE")
    const wholesale = auditIdleWindow({ before: [], after: [REAL_GET, ...elevenProbes()] })
    expect(wholesale.outcome).toBe("BUSY") // the same end-read, un-differenced, reads busy — the two worlds differ
    expect(wholesale.blockingLines).toEqual([REAL_GET])
  })

  it("a real egress line inside the window is BUSY and the refusal names the line", () => {
    const v = auditIdleWindow({ before: [PROBE], after: [PROBE, REAL_GET] })
    expect(v.outcome).toBe("BUSY")
    expect(v.realEgress).toBe(1)
    expect(v.blockingLines).toEqual([REAL_GET])
  })

  it("probe noise does not mask a real line that lands in the same window", () => {
    const v = auditIdleWindow({ before: [], after: [...elevenProbes(), REAL_GET] })
    expect(v.outcome).toBe("BUSY")
    expect(v.probeNoise).toBe(11) // both facts survive together: counted AND refused
    expect(v.realEgress).toBe(1)
  })

  it("an unattributable line fails closed toward BUSY rather than toward idleness", () => {
    const v = auditIdleWindow({ before: [], after: [...elevenProbes(), "garbage line"] })
    expect(v.outcome).toBe("BUSY")
    expect(v.unrecognized).toBe(1)
    expect(v.blockingLines).toEqual(["garbage line"])
  })

  it("E4 DISCRIMINATION: the idle estate and the blind sink are different named outcomes", () => {
    const idle = auditIdleWindow({ before: [REAL_GET], after: [REAL_GET, ...elevenProbes()] })
    const blind = auditIdleWindow({ before: [REAL_GET], after: [REAL_GET] })
    expect(idle.outcome).toBe("IDLE")
    expect(blind.outcome).toBe("BLIND_SINK")
    expect(idle.outcome).not.toBe(blind.outcome)
  })
})

// ================================================================================================
// 3. The witness requirement — T-5's second half ("prove the sink is not blind with a control line").
//    Mutant M-h (force IDLE) breaks tests 1-4 of this describe.
// ================================================================================================

describe("(r244 witness requirement) IDLE is only admissible when something proves the sink writes", () => {
  it("an entirely empty sink is BLIND_SINK with no witness, never the idle a naive filter would report", () => {
    const v = auditIdleWindow({ before: [], after: [] })
    expect(v.outcome).toBe("BLIND_SINK")
    expect(v.witness).toBe("NONE")
    expect(v.added).toBe(0)
  })

  it("a stale sink — no new lines and the gate stopped polling — is BLIND_SINK, not IDLE", () => {
    // This is the case the forbidden fix ("drop the 000 lines, see if anything remains") gets wrong: an empty
    // remainder from a dead sink is byte-identical to an empty remainder from an idle estate.
    const v = auditIdleWindow({ before: [REAL_GET], after: [REAL_GET] })
    expect(v.outcome).toBe("BLIND_SINK")
    expect(v.probeNoise).toBe(0)
    expect(v.control).toBe(0)
  })

  it("a control landing AFTER the window closes certifies idleness (attempt 4's A5 recipe)", () => {
    const v = auditIdleWindow({
      before: [REAL_GET],
      after: [REAL_GET], // nothing landed inside the window: no probe noise either
      controlMarker: CONTROL_MARKER,
      controlProbe: [REAL_GET, CONTROL_GET],
    })
    expect(v.outcome).toBe("IDLE")
    expect(v.witness).toBe("CONTROL")
  })

  it("a control inside the window is preferred over probe noise as the witness", () => {
    const v = auditIdleWindow({ before: [], after: [...elevenProbes(), CONTROL_GET], controlMarker: CONTROL_MARKER })
    expect(v.outcome).toBe("IDLE")
    expect(v.witness).toBe("CONTROL") // a control is a REAL request that had to appear; noise only proves writing
    expect(v.probeNoise).toBe(11)
  })

  it("BUSY outranks a present witness: a control does not cancel real egress", () => {
    const v = auditIdleWindow({
      before: [],
      after: [...elevenProbes(), CONTROL_GET, REAL_GET],
      controlMarker: CONTROL_MARKER,
    })
    expect(v.outcome).toBe("BUSY")
    expect(v.control).toBe(1)
    expect(v.realEgress).toBe(1)
  })

  it("RC-244-2 (routed to row 255): a tunnel-form REFUSAL inside the window reads BUSY, so containment and idleness cannot be sampled in one window", () => {
    // Measured, not assumed: `CONNECT 127.0.0.1:80` refused at L4 carries TCP_DENIED/403, i.e. a status other
    // than 000, so the classifier files it as traffic. Fail-closed in direction (it refuses to certify idleness),
    // but it means row 255 cannot run the item-3/item-8 tunnel battery and the item-7 idle assertion over the SAME
    // window and expect both to pass. Recorded as a passing assertion so the interaction is visible here rather
    // than discovered live, at 3.2 s per poll, by whoever has the least time left.
    const v = auditIdleWindow({ before: [PROBE], after: [PROBE, TUNNEL_DENIED] })
    expect(v.outcome).toBe("BUSY")
    expect(v.blockingLines).toEqual([TUNNEL_DENIED])
  })
})
